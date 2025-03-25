/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { printKWh, printDate, printOnlyDate, displayCsv } from "./Display.js";
import * as NoUiSlider from "nouislider";
import "nouislider/dist/nouislider.css";

// TODO: test multiple distribution EANs

function last<T>(container: T[]): T {
    return container[container.length - 1];
}

export function assert(condition: boolean, ...loggingArgs: unknown[]): asserts condition {
    if (!condition) {
        const errorMsg = `Assert failed: ${loggingArgs.toString()}`;
        console.error("Assert failed", ...loggingArgs);
        // eslint-disable-next-line no-debugger
        debugger;
        alert(errorMsg);
        throw new Error(errorMsg);
    }
}

const warningDom = document.getElementById("warnings") as HTMLDivElement;
const fileDom = document.getElementById("uploadCsv") as HTMLInputElement;
const filterDom = document.getElementById("filterSlider") as HTMLInputElement;
const rangeDom = document.getElementById("range") as HTMLElement;

type GroupingOptions = "15m" | "1h" | "1d" | "1m";
type DisplayUnit = "kWh" | "kW";

class Settings {
    displayUnit: DisplayUnit = "kWh";
    anonymizeEans = false;
    filterValue = 0;
    grouping: GroupingOptions = "1d";
    groupGraph = true;

    hiddenEans = new Set<string>();

    minDayFilter = 0;
    maxDayFilter = 0;

    useFiltering(): boolean {
        return this.grouping === "15m" || this.grouping === "1h";
    }
}

export const gSettings = new Settings();

function logWarning(warning: string, date: Date): void {
    warningDom.style.display = "block";
    if (warningDom.children.length === 0) {
        const dom = document.createElement("li");
        dom.innerText = `Input data is inconsistent! Only "monthly report" is guaranteed to be correct, prefer using that.
                         The script will attempt to fix some errors, but the result is still only approximate. Also not all errors can be caught.`;
        warningDom.appendChild(dom);
    }
    const dom = document.createElement("li");
    dom.innerText = `[${printDate(date)}] ${warning}`;
    warningDom.appendChild(dom);
}

function parseKwh(input: string): number {
    if (input.length === 0) {
        return 0.0;
    }
    const adj = input.replace(",", ".");
    const result = parseFloat(adj);
    assert(!isNaN(result));
    return result;
}

function getDate(explodedLine: string[]): Date {
    assert(explodedLine.length > 3, `Cannot extract date - whole line is: "${explodedLine.join(";")}"`);
    const [day, month, year] = explodedLine[0].split(".");
    const [hour, minute] = explodedLine[1].split(":");
    return new Date(
        Date.UTC(
            parseInt(year, 10),
            parseInt(month, 10) - 1,
            parseInt(day, 10),
            parseInt(hour, 10),
            parseInt(minute, 10),
        ),
    );
}

export interface Measurement {
    before: number;
    after: number;
    missed: number;
}

function accumulateMeasurement(to: Measurement, from: Measurement): void {
    to.before += from.before;
    to.after += from.after;
    to.missed += from.missed;
}

export interface Interval {
    start: Date;

    sumSharing: number;
    sumMissed: number;
    sumProduction: number;

    distributions: Measurement[];
    consumers: Measurement[];

    errors: string[];
}

function accumulateInterval(to: Interval, from: Interval): void {
    assert(
        to.distributions.length === from.distributions.length &&
            to.consumers.length === from.consumers.length,
    );
    to.sumSharing += from.sumSharing;
    to.sumMissed += from.sumMissed;
    to.sumProduction += from.sumProduction;

    for (let i = 0; i < to.distributions.length; ++i) {
        accumulateMeasurement(to.distributions[i], from.distributions[i]);
    }
    for (let i = 0; i < to.consumers.length; ++i) {
        accumulateMeasurement(to.consumers[i], from.consumers[i]);
    }
    to.errors.push(...from.errors);
}

export class Csv {
    distributionEans: Ean[] = [];
    consumerEans: Ean[] = [];

    filename: string;
    dateFrom: Date;
    dateTo: Date;

    intervals: Interval[] = [];

    constructor(filename: string, intervals: Interval[], distributionEans: Ean[], consumerEans: Ean[]) {
        this.filename = filename;
        this.intervals = intervals;
        this.dateFrom = intervals[0].start;
        this.dateTo = structuredClone(last(intervals).start);
        this.dateTo.setMinutes(this.dateTo.getUTCMinutes() + 14);
        this.distributionEans = distributionEans;
        this.consumerEans = consumerEans;

        // Sort columns
        const newDistributionEans = [] as Ean[];
        const newConsumerEans = [] as Ean[];

        const findSmallestEan = (eans: Ean[]): number => {
            let result = 0;
            for (let i = 1; i < eans.length; ++i) {
                if (eans[i].name < eans[result].name) {
                    result = i;
                }
            }
            if (result !== 0) {
                console.log("Swapping EANs: ", eans[result].name, eans[0].name);
            }
            return result;
        };
        while (this.distributionEans.length > 0) {
            const index = findSmallestEan(this.distributionEans);
            newDistributionEans.push(this.distributionEans[index]);
            for (const i of intervals) {
                i.distributions.push(i.distributions[index]);
                i.distributions.splice(index, 1);
            }
            this.distributionEans.splice(index, 1);
        }
        while (this.consumerEans.length > 0) {
            const index = findSmallestEan(this.consumerEans);
            newConsumerEans.push(this.consumerEans[index]);
            for (const i of intervals) {
                i.consumers.push(i.consumers[index]);
                i.consumers.splice(index, 1);
            }
            this.consumerEans.splice(index, 1);
        }
        this.distributionEans = newDistributionEans;
        this.consumerEans = newConsumerEans;
    }

    getGroupedIntervals(grouping: GroupingOptions, dateFrom: Date, dateTo: Date): Interval[] {
        const timer = performance.now();
        const result: Interval[] = [];
        for (let i = 0; i < this.intervals.length; ++i) {
            if (this.intervals[i].start < dateFrom || this.intervals[i].start > dateTo) {
                continue;
            }
            let mergeToLast = false;
            if (result.length > 0) {
                const dateLast = this.intervals[i - 1].start;
                const dateThis = this.intervals[i].start;
                switch (grouping) {
                    case "15m":
                        mergeToLast = false;
                        break;
                    case "1h":
                        mergeToLast = dateThis.getUTCHours() === dateLast.getUTCHours();
                        break;
                    case "1d":
                        mergeToLast = dateThis.getUTCDate() === dateLast.getUTCDate();
                        break;
                    case "1m":
                        mergeToLast = dateThis.getUTCMonth() === dateLast.getUTCMonth();
                        break;
                    default:
                        throw new Error();
                }
            }
            if (mergeToLast) {
                accumulateInterval(last(result), this.intervals[i]);
            } else {
                result.push(structuredClone(this.intervals[i]));
            }
        }
        console.log(
            "Merging intervals",
            this.intervals.length,
            "=>",
            result.length,
            "elapsed",
            performance.now() - timer,
            "ms",
        );
        return result;
    }

    // return number of days in the data
    getNumDays(): number {
        const timeDiff = this.dateTo.getTime() - this.dateFrom.getTime();
        return Math.ceil(timeDiff / (1000 * 3600 * 24));
    }
}

export class Ean {
    name: string;
    csvIndex: number;
    constructor(name: string, csvIndex: number) {
        this.name = name;
        this.csvIndex = csvIndex;
    }
}

// eslint-disable-next-line complexity
function parseCsv(csv: string, filename: string): Csv {
    csv = csv.replaceAll("\r\n", "\n");
    const lines = csv.split("\n");
    assert(lines.length > 0, "CSV file is empty");
    const header = lines[0].split(";");
    assert(
        header.length > 3,
        `CSV file has invalid header - less than 3 elements. Is there an extra empty line? The entire line is "${lines[0]}"`,
    );
    assert(header[0] === "Datum" && header[1] === "Cas od" && header[2] === "Cas do");
    assert(header.length % 2 === 1);

    const distributorEans: Ean[] = [];
    const consumerEans: Ean[] = [];

    for (let i = 3; i < header.length; i += 2) {
        const before = header[i].trim();
        const after = header[i + 1].trim();
        assert(before.substring(2) === after.substring(3), "Mismatched IN- and OUT-", before, after);

        const isDistribution = before.endsWith("-D");
        const eanNumber = before.substring(3, before.length - 2);
        if (isDistribution) {
            distributorEans.push(new Ean(eanNumber, i));
        } else {
            assert(before.endsWith("-O"), before);
            consumerEans.push(new Ean(eanNumber, i));
        }
        assert(before.startsWith("IN-") && after.startsWith("OUT-"), before, after);
    }

    // Maps from time to missing sharing for that time slot
    const intervals = [] as Interval[];

    for (let i = 1; i < lines.length; ++i) {
        if (lines[i].trim().length === 0) {
            continue;
        }
        const explodedLine = lines[i].split(";");

        const expectedLength = 3 + (consumerEans.length + distributorEans.length) * 2;
        // In some reports there is an empty field at the end of the line
        assert(
            explodedLine.length === expectedLength ||
                (explodedLine.length === expectedLength + 1 && last(explodedLine) === ""),
            `Wrong number of items: ${explodedLine.length}, expected: ${expectedLength}, line number: ${i}. Last item on line is "${last(explodedLine)}"`,
        );
        const dateStart = getDate(explodedLine);

        const distributed: Measurement[] = [];
        const consumed: Measurement[] = [];

        const errors = [] as string[];

        for (const ean of distributorEans) {
            let before = parseKwh(explodedLine[ean.csvIndex]);
            let after = parseKwh(explodedLine[ean.csvIndex + 1]);
            if (after > before) {
                const error = `Distribution EAN ${ean.name} is distributing ${after - before} kWh more AFTER subtracting sharing. The report will clip sharing to 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                after = before;
            }
            if (before < 0 || after < 0) {
                const error = `Distribution EAN ${ean.name} is consuming ${before / after} kWh power. The report will clip negative values to 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                before = Math.max(0, before);
                after = Math.max(0, after);
            }
            distributed.push({ before, after, missed: 0 });
        }
        for (const ean of consumerEans) {
            let before = -parseKwh(explodedLine[ean.csvIndex]);
            let after = -parseKwh(explodedLine[ean.csvIndex + 1]);
            if (after > before) {
                const error = `Consumer EAN ${ean.name} is consuming ${after - before} kWh more AFTER subtracting sharing. The report will clip sharing to 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                after = before;
            }
            if (before < 0 || after < 0) {
                const error = `Consumer EAN ${ean.name} is distributing ${before / after} kWh power. The report will clip negative values to 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                before = Math.max(0, before);
                after = Math.max(0, after);
            }
            consumed.push({ before, after, missed: 0 });
        }

        const sumDistributorsAfter = distributed.reduce((acc, val) => acc + val.after, 0);
        const sumDistributorsBefore = distributed.reduce((acc, val) => acc + val.before, 0);
        const sumConsumersAfter = consumed.reduce((acc, val) => acc + val.after, 0);
        const sumConsumersBefore = consumed.reduce((acc, val) => acc + val.before, 0);
        const sumShared = sumDistributorsBefore - sumDistributorsAfter;
        assert(sumShared >= 0, sumShared, "Line", i);

        if (Math.abs(sumShared - (sumConsumersBefore - sumConsumersAfter)) > 0.0001) {
            const sumSharedConsumers = sumConsumersBefore - sumConsumersAfter;
            const error = `Energy shared from distributors (${printKWh(sumShared)}) does not match energy shared to consumers (${printKWh(sumSharedConsumers)})!. The report will consider the mismatch not shared.`;
            logWarning(error, dateStart);
            errors.push(error);
            if (sumShared > sumSharedConsumers) {
                const fixDistributors = sumSharedConsumers / sumShared;
                console.log("Fixing distributors", fixDistributors);
                assert(
                    fixDistributors <= 1 && fixDistributors >= 0 && !isNaN(fixDistributors),
                    sumSharedConsumers,
                    sumShared,
                );
                for (const j of distributed) {
                    j.after *= fixDistributors;
                }
            } else {
                const fixConsumers = sumShared / sumSharedConsumers;
                console.log("Fixing consumers", fixConsumers);
                assert(
                    fixConsumers <= 1 && fixConsumers >= 0 && !isNaN(fixConsumers),
                    sumShared,
                    sumSharedConsumers,
                );
                for (const j of consumed) {
                    j.after *= fixConsumers;
                }
            }
        }

        // If there is still some power left after sharing, we check that all consumers have 0 adjusted power.
        // If there was some consumer left with non-zero power, it means there was energy that could have been
        // shared, but wasn't due to bad allocation.
        let sumMissed = 0;

        const anyOverThreshold = (measurements: Measurement[]): boolean => {
            for (const measurement of measurements) {
                // There are plenty of intervals where distribution before and after are both 0.01 and no sharing is performed...:
                if (measurement.after > 0.01) {
                    return true;
                }
            }
            return false;
        };
        if (anyOverThreshold(distributed) && anyOverThreshold(consumed)) {
            sumMissed = Math.min(sumConsumersAfter, sumDistributorsAfter);
            for (const c of consumed) {
                c.missed = (c.after / sumConsumersAfter) * sumMissed;
            }
            for (const p of distributed) {
                p.missed += (p.after / sumDistributorsAfter) * sumMissed;
            }
        }

        intervals.push({
            start: dateStart,
            sumSharing: sumShared,
            sumMissed,
            sumProduction: sumDistributorsBefore,
            distributions: distributed,
            consumers: consumed,
            errors,
        });
    }

    return new Csv(filename, intervals, distributorEans, consumerEans);
}

let gCsv: Csv | null = null;

export function refreshView(): void {
    if (gCsv) {
        displayCsv(gCsv);
    }
}

const range = NoUiSlider.create(rangeDom, {
    start: [0, 0],
    connect: true,
    behaviour: "drag-tap",
    step: 1,
    tooltips: true,
    range: {
        min: 0,
        max: 0,
    },
});
range.disable();
range.on("update", () => {
    const values = range.get(true) as number[];
    console.log("range update", values);
    gSettings.minDayFilter = values[0];
    gSettings.maxDayFilter = values[1];
    refreshView();
});

function updateCsv(value: string, name: string): void {
    gCsv = parseCsv(value, name);
    const format = {
        to: (i: number): string => {
            const date = structuredClone(gCsv!.dateFrom);
            date.setDate(date.getUTCDate() + i);
            return printOnlyDate(date);
        },
        from: (s: string): number => parseInt(s, 10),
    };
    range.enable();
    range.updateOptions(
        {
            start: [0, gCsv.getNumDays() - 1],
            range: { min: 0, max: gCsv.getNumDays() - 1 },
            pips: {
                mode: NoUiSlider.PipsMode.Count,
                values: 31, // So that for each full month all days are displayed
                density: 1000, // No steps inbetween pips
                stepped: true,
                format,
            },
            format,
        },
        false,
    );
    refreshView();
}

fileDom.addEventListener("change", () => {
    if (fileDom.files?.length === 1) {
        warningDom.style.display = "none";
        warningDom.innerHTML = "";
        filterDom.value = "99";
        filterDom.dispatchEvent(new Event("input", { bubbles: true }));
        const reader = new FileReader();
        reader.addEventListener("loadend", () => {
            updateCsv(reader.result as string, fileDom.files![0].name);
        });
        reader.readAsText(fileDom.files[0]); // Read file as text
    }
});
filterDom.addEventListener("input", () => {
    // console.log("filterDom INPUT");
    gSettings.filterValue = 1 - parseInt(filterDom.value, 10) / 100;
    refreshView();
});
document.getElementById("anonymizeEans")!.addEventListener("change", () => {
    gSettings.anonymizeEans = (document.getElementById("anonymizeEans") as HTMLInputElement).checked;
    refreshView();
});
document.querySelectorAll('input[name="unit"]').forEach((button) => {
    button.addEventListener("change", (e) => {
        gSettings.displayUnit = (e.target as HTMLInputElement).value as DisplayUnit;
        refreshView();
    });
});
document.querySelectorAll('input[name="group"]').forEach((button) => {
    button.addEventListener("change", (e) => {
        gSettings.grouping = (e.target as HTMLInputElement).value as GroupingOptions;
        document.getElementById("minFilterParent")!.style.display = gSettings.useFiltering()
            ? "block"
            : "none";
        refreshView();
    });
});

const groupGraph = document.getElementById("groupGraph") as HTMLInputElement;
groupGraph.addEventListener("change", () => {
    gSettings.groupGraph = (document.getElementById("groupGraph") as HTMLInputElement).checked;
    refreshView();
});

export function mock(): void {
    // Testing data
    updateCsv(
        `Datum;Cas od;Cas do;IN-859182400020000001-D;OUT-859182400020000001-D;IN-859182400000000002-O;OUT-859182400000000002-O;IN-859182400000000013-O;OUT-859182400000000013-O;IN-859182400000000004-O;OUT-859182400000000004-O;IN-859182400000000005-O;OUT-859182400000000005-O;IN-859182400000000006-O;OUT-859182400000000006-O;IN-859182400000000007-O;OUT-859182400000000007-O
05.02.2025;11:00;11:15;10,03;0,03;-0,74;-0,74;-10,1;-0,1;-0,53;-0,53;0,0;0,0;0,0;0,0;-0,18;-0,18;
05.02.2025;11:15;11:30;0,83;0,14;-0,74;-0,56;-0,09;0,0;-0,48;-0,1;0,0;0,0;-0,01;0,0;-0,03;0,0;
05.02.2025;11:30;11:45;1,2;0,15;-0,67;-0,41;-0,2;0,0;-0,56;-0,03;0,0;0,0;-0,02;0,0;-0,04;0,0;
05.02.2025;11:45;12:00;1,14;0,24;-0,07;0,0;-0,25;0,0;-0,69;-0,15;0,0;0,0;-0,01;0,0;-0,03;0,0;
05.02.2025;12:00;12:15;1,18;0,15;-0,35;-0,12;-0,24;0,0;-0,83;-0,33;0,0;0,0;-0,02;0,0;-0,04;0,0;
05.02.2025;12:15;12:30;0,91;0,22;-0,24;-0,04;-0,27;0,0;-0,18;0,0;0,0;0,0;0,0;0,0;-0,04;0,0;
05.02.2025;12:30;12:45;0,83;0,15;-0,39;-0,24;-0,29;0,0;-0,11;0,0;0,0;0,0;-0,01;0,0;-0,12;0,0;
05.02.2025;12:45;13:00;1,05;0,03;-1,13;-0,96;-0,56;-0,2;-0,11;0,0;0,0;0,0;-0,02;0,0;-0,48;-0,12;
06.02.2025;13:00;13:15;1,02;0,04;-0,24;-0,07;-0,63;-0,28;-0,12;0,0;0,0;0,0;0,0;0,0;-0,34;0,0;
07.02.2025;13:15;13:30;1,0;0,33;-0,26;-0,01;-0,11;0,0;-0,11;0,0;0,0;0,0;-0,02;0,0;-0,18;0,0;
08.02.2025;13:30;13:45;0,93;0,29;-0,21;0,0;-0,12;0,0;-0,11;0,0;0,0;0,0;-0,02;0,0;-0,18;0,0;
09.02.2025;13:45;14:00;0,86;0,45;-0,11;0,0;-0,09;0,0;-0,11;0,0;0,0;0,0;-0,01;0,0;-0,09;0,0;
`,
        "TESTING DUMMY",
    );
}

if (0) {
    mock();
}
