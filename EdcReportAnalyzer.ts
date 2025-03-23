/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import * as Chart from "chart.js/auto";

// TODO: test multiple distribution EANs

type Rgb = [number, number, number];

const GREEN = [14, 177, 14] as Rgb;
const RED = [255, 35, 35] as Rgb;
const GRAY = [150, 150, 150] as Rgb;

function last<T>(container: T[]): T {
    return container[container.length - 1];
}

function assert(condition: boolean, ...loggingArgs: unknown[]): asserts condition {
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

type GroupingOptions = "15m" | "1h" | "1d" | "1m";
type DisplayUnit = "kWh" | "kW";

class Settings {
    displayUnit: DisplayUnit = "kWh";
    anonymizeEans = false;
    filterValue = 0;
    grouping: GroupingOptions = "1d";

    hiddenEans = new Set<string>();

    useFiltering(): boolean {
        return this.grouping === "15m" || this.grouping === "1h";
    }
}

const gSettings = new Settings();

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

interface PrintKWhOptions {
    alwaysKwh?: boolean; // Default false
    nbsp?: boolean; // Default false
}
function printKWh(input: number, options?: PrintKWhOptions): string {
    const alwaysKWh = options?.alwaysKwh ?? false;
    const nsbsp = (options?.nbsp ?? false) ? "&nbsp;" : " ";
    if (gSettings.displayUnit === "kW" && !alwaysKWh) {
        return `${(input * 4).toFixed(2)}${nsbsp}kW`;
    } else {
        return `${input.toFixed(2)}${nsbsp}kWh`;
    }
}

function getDate(explodedLine: string[]): Date {
    assert(explodedLine.length > 3, `Cannot extract date - whole line is: "${explodedLine.join(";")}"`);
    const [day, month, year] = explodedLine[0].split(".");
    const [hour, minute] = explodedLine[1].split(":");
    return new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
    );
}

function printEan(input: string): string {
    assert(input.length === 18);
    // input = input.replace("859182400", "…"); // Does not look good...
    if (gSettings.anonymizeEans) {
        input = `859182400xxxxxxx${input.substring(16)}`;
        assert(input.length === 18);
    }
    return input;
}

interface Measurement {
    before: number;
    after: number;
}

interface Interval {
    start: Date;

    sumSharing: number;
    sumMissed: number;

    distributions: Measurement[];
    consumers: Measurement[];

    errors: string[];
}

function accumulateTo(to: Interval, from: Interval): void {
    assert(
        to.distributions.length === from.distributions.length &&
            to.consumers.length === from.consumers.length,
    );
    to.sumSharing += from.sumSharing;
    to.sumMissed += from.sumMissed;
    for (let i = 0; i < to.distributions.length; ++i) {
        to.distributions[i].before += from.distributions[i].before;
        to.distributions[i].after += from.distributions[i].after;
    }
    for (let i = 0; i < to.consumers.length; ++i) {
        to.consumers[i].before += from.consumers[i].before;
        to.consumers[i].after += from.consumers[i].after;
    }
    to.errors.push(...from.errors);
}

class Csv {
    distributionEans: Ean[] = [];
    consumerEans: Ean[] = [];

    filename: string;
    dateFrom: Date;
    dateTo: Date;

    sharedTotal = 0;
    missedTotal = 0;

    intervals: Interval[] = [];

    constructor(filename: string, intervals: Interval[], distributionEans: Ean[], consumerEans: Ean[]) {
        this.filename = filename;
        this.intervals = intervals;
        this.dateFrom = intervals[0].start;
        this.dateTo = structuredClone(last(intervals).start);
        this.dateTo.setMinutes(this.dateTo.getMinutes() + 15);
        this.distributionEans = distributionEans;
        this.consumerEans = consumerEans;

        this.sharedTotal = distributionEans.reduce((acc, val) => acc + val.shared(), 0);
        this.missedTotal = consumerEans.reduce((acc, val) => acc + val.missedDueToAllocation, 0);

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

    getGroupedIntervals(grouping: GroupingOptions): Interval[] {
        if (grouping === "15m") {
            return this.intervals;
        }
        const result: Interval[] = [];
        for (let i = 0; i < this.intervals.length; ++i) {
            let mergeToLast = false;
            if (i > 0) {
                const dateLast = this.intervals[i - 1].start;
                const dateThis = this.intervals[i].start;
                switch (grouping) {
                    case "1h":
                        mergeToLast = dateThis.getHours() === dateLast.getHours();
                        break;
                    case "1d":
                        mergeToLast = dateThis.getDate() === dateLast.getDate();
                        break;
                    case "1m":
                        mergeToLast = dateThis.getMonth() === dateLast.getMonth();
                        break;
                    default:
                        throw new Error();
                }
            }
            if (mergeToLast) {
                accumulateTo(last(result), this.intervals[i]);
            } else {
                result.push(structuredClone(this.intervals[i]));
            }
        }
        console.log("Merging intervals", this.intervals.length, "=>", result.length);
        return result;
    }
}

class Ean {
    name: string;
    csvIndex: number;
    originalBalance = 0;
    adjustedBalance = 0;
    maximumOriginal = 0;
    missedDueToAllocation = 0;
    constructor(name: string, csvIndex: number) {
        this.name = name;
        this.csvIndex = csvIndex;
    }

    shared(): number {
        return this.originalBalance - this.adjustedBalance;
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

            ean.originalBalance += before;
            ean.adjustedBalance += after;
            ean.maximumOriginal = Math.max(ean.maximumOriginal, before);
            distributed.push({ before, after });
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
            ean.originalBalance += before;
            ean.adjustedBalance += after;
            ean.maximumOriginal = Math.max(ean.maximumOriginal, before);
            consumed.push({ before, after });
        }

        // If there is still some power left after sharing, we check that all consumers have 0 adjusted power.
        // If there was some consumer left with non-zero power, it means there was energy that could have been
        // shared, but wasn't due to bad allocation.
        let sumMissed = 0;
        const sumDistributorsAfter = distributed.reduce((acc, val) => acc + val.after, 0);
        if (sumDistributorsAfter > 0) {
            let sumConsumersAfter = consumed.reduce((acc, val) => acc + val.after, 0);
            const missedScale = Math.min(1.0, sumDistributorsAfter / sumConsumersAfter);
            assert(missedScale > 0 && missedScale <= 1, missedScale);
            sumConsumersAfter = Math.min(sumConsumersAfter, sumDistributorsAfter);

            // There are plenty of intervals where distribution before and after are both 0.01 and no sharing
            // is performed...:
            if (sumConsumersAfter > 0.0 && sumDistributorsAfter > 0.0) {
                sumMissed = sumConsumersAfter;
                for (let j = 0; j < consumerEans.length; ++j) {
                    consumerEans[j].missedDueToAllocation += consumed[j].after * missedScale;
                }
            }
        }
        const sumSharedDistributed = distributed.reduce((acc, val) => acc + (val.before - val.after), 0);
        assert(sumSharedDistributed >= 0, sumSharedDistributed, "Line", i);
        const sumSharedConsumed = consumed.reduce((acc, val) => acc + (val.before - val.after), 0);
        assert(sumSharedConsumed >= 0, sumSharedConsumed, "Line", i);
        if (Math.abs(sumSharedDistributed - sumSharedConsumed) > 0.0001) {
            const error = `Energy shared from distributors does not match energy shared to consumers!\nDistributed: ${sumSharedDistributed}\nConsumed: ${sumSharedConsumed}.
The report will consider the mismatch not shared.`;
            logWarning(error, dateStart);
            errors.push(error);
            if (sumSharedDistributed > sumSharedConsumed) {
                const fixDistributors = sumSharedConsumed / sumSharedDistributed;
                console.log("Fixing distributors", fixDistributors);
                assert(
                    fixDistributors <= 1 && fixDistributors >= 0 && !isNaN(fixDistributors),
                    sumSharedConsumed,
                    sumSharedDistributed,
                );
                for (const j of distributed) {
                    j.after *= fixDistributors;
                }
            } else {
                const fixConsumers = sumSharedDistributed / sumSharedConsumed;
                console.log("Fixing consumers", fixConsumers);
                assert(
                    fixConsumers <= 1 && fixConsumers >= 0 && !isNaN(fixConsumers),
                    sumSharedDistributed,
                    sumSharedConsumed,
                );
                for (const j of consumed) {
                    j.after *= fixConsumers;
                }
            }
        }

        intervals.push({
            start: dateStart,
            sumSharing: distributed.reduce((acc, val) => acc + (val.before - val.after), 0),
            sumMissed,
            distributions: distributed,
            consumers: consumed,
            errors,
        });
    }

    return new Csv(filename, intervals, distributorEans, consumerEans);
}

function colorizeRange(query: string, rgb: Rgb): void {
    const collection = document.querySelectorAll(query);
    // console.log(query);
    // console.log(collection);
    // let minimum = Infinity;
    let minimum = 0; // It works better with filtering if minimum is always 0
    let maximum = 0;
    for (const i of collection) {
        const valueStr = (i as HTMLElement).innerText;
        if (valueStr.length > 0) {
            const value = parseFloat(valueStr);
            maximum = Math.max(maximum, value);
            minimum = Math.min(minimum, value);
        }
    }
    // console.log(minimum, maximum);
    assert(!isNaN(maximum), `There is a NaN when colorizing query${query}`);
    // console.log("Colorizing with maximum", maximum);
    for (const i of collection) {
        const htmlElement = i as HTMLElement;
        if (htmlElement.innerText.length > 0) {
            const alpha =
                (parseFloat(htmlElement.innerText) - minimum) / Math.max(0.00001, maximum - minimum);
            // console.log(htmlElement);
            assert(!isNaN(alpha), "There is NaN somewhere in data", alpha);
            const cssString = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
            // console.log(cssString);
            htmlElement.style.backgroundColor = cssString;
        }
    }
}

function recallEanAlias(ean: Ean): string {
    return localStorage.getItem(`EAN_alias_${ean.name}`) ?? "";
}
function saveEanAlias(ean: Ean, alias: string): void {
    localStorage.setItem(`EAN_alias_${ean.name}`, alias);
}

function setupHeader(table: HTMLTableElement, csv: Csv, editableNames: boolean): void {
    (table.querySelector("th.distributionHeader") as HTMLTableCellElement).colSpan =
        csv.distributionEans.length;
    (table.querySelector("th.consumerHeader") as HTMLTableCellElement).colSpan = csv.consumerEans.length;

    const theader = table.querySelector("tr.csvHeaderRow") as HTMLTableRowElement;
    assert(theader !== null);
    theader.innerHTML = "<th>EAN</th>";

    const createCell = (domClass: string, ean: Ean): void => {
        const th = document.createElement("th");
        th.classList.add(domClass);
        const close = document.createElement("input");
        close.type = "checkbox";
        close.checked = !gSettings.hiddenEans.has(ean.name);
        close.addEventListener("click", () => {
            if (close.checked) {
                gSettings.hiddenEans.delete(ean.name);
            } else {
                gSettings.hiddenEans.add(ean.name);
            }
            refreshView();
        });
        th.appendChild(close);
        if (!gSettings.hiddenEans.has(ean.name)) {
            th.appendChild(document.createTextNode(printEan(ean.name)));
            if (editableNames) {
                const input = document.createElement("input");
                input.type = "text";
                input.value = recallEanAlias(ean);
                input.addEventListener("change", () => {
                    saveEanAlias(ean, input.value);
                    refreshView();
                });
                th.appendChild(input);
            } else {
                const recalled = recallEanAlias(ean);
                if (recalled.length > 0) {
                    th.innerHTML += `<br>(${recalled})`;
                }
            }
        }
        theader.appendChild(th);
    };

    for (const ean of csv.distributionEans) {
        createCell("distribution", ean);
    }
    theader.insertCell().classList.add("split");
    for (const ean of csv.consumerEans) {
        createCell("consumer", ean);
    }
}

function printOnlyDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function printDate(date: Date): string {
    return `${printOnlyDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function printGroupedDate(date: Date, useNbsp = true): string {
    const nbsp = useNbsp ? "&nbsp;" : " ";
    switch (gSettings.grouping) {
        case "15m":
            return `${printDate(date)}${nbsp}-${nbsp}${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes() + 14).padStart(2, "0")}`;
        case "1h":
            return `${printOnlyDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
        case "1d":
            return printOnlyDate(date);
        case "1m":
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        default:
            throw Error();
    }
}

function displayInputData(csv: Csv): void {
    document.getElementById("filename")!.innerText = csv.filename;
    document.getElementById("intervalFrom")!.innerText = printDate(csv.dateFrom);
    document.getElementById("intervalTo")!.innerText = printDate(csv.dateTo);
    const timeDiff = Math.abs(csv.dateTo.getTime() - csv.dateFrom.getTime());
    const dayDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
    document.getElementById("intervalLength")!.innerText = `${dayDiff} days`;
}

function displaySummary(csv: Csv): void {
    setupHeader(document.getElementById("csv") as HTMLTableElement, csv, true);
    const tbody = document.getElementById("csvBody");
    assert(tbody !== null);
    tbody.innerHTML = "";

    let rowId = 0;
    const makeRow = (header: string, backgroundColor: Rgb, printFn: (ean: Ean) => string): void => {
        const row = document.createElement("tr");
        const id = `row${rowId++}`;
        row.classList.add(id);
        const th = document.createElement("th");
        row.appendChild(th);
        th.innerHTML = header;
        for (const ean of csv.distributionEans) {
            const cell = row.insertCell();
            cell.classList.add("distribution");
            if (!gSettings.hiddenEans.has(ean.name)) {
                cell.innerHTML = printFn(ean);
            }
        }
        row.insertCell().classList.add("split");
        for (const ean of csv.consumerEans) {
            const cell = row.insertCell();
            cell.classList.add("consumer");
            if (!gSettings.hiddenEans.has(ean.name)) {
                cell.innerHTML = printFn(ean);
            }
        }
        tbody.appendChild(row);
        colorizeRange(`table#csv tr.${id} td.consumer`, backgroundColor);
        colorizeRange(`table#csv tr.${id} td.distribution`, backgroundColor);
    };

    const printOptions = { alwaysKwh: true, nbsp: true };
    makeRow("Original (without&nbsp;sharing) [kWh]:", GRAY, (ean) =>
        printKWh(ean.originalBalance, printOptions),
    );
    makeRow("Adjusted (with&nbsp;sharing) [kWh]:", GRAY, (ean) =>
        printKWh(ean.adjustedBalance, printOptions),
    );
    makeRow("Shared [kWh]:", GREEN, (ean) => printKWh(ean.shared(), printOptions));
    makeRow("Missed [kWh]:", RED, (ean) => printKWh(ean.missedDueToAllocation, printOptions));

    const graphRow = document.createElement("tr");
    const graphTh = document.createElement("th");
    graphTh.innerHTML = "Graphs:";
    graphRow.appendChild(graphTh);

    const makeChart = (cell: HTMLElement, ean: Ean): void => {
        if (!gSettings.hiddenEans.has(ean.name) && ean.originalBalance > 0) {
            const canvasHolder = document.createElement("div");
            canvasHolder.classList.add("canvasHolder");
            const canvas = document.createElement("canvas");
            canvasHolder.appendChild(canvas);
            cell.appendChild(canvasHolder);
            const getPercent = (x: number): number => Math.round((x / ean.originalBalance) * 100);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const graph = new Chart.Chart(canvas, {
                type: "pie",
                data: {
                    labels: ["Shared", "Missed", "Rest"],
                    datasets: [
                        {
                            label: "%",
                            data: [
                                getPercent(ean.shared()),
                                getPercent(ean.missedDueToAllocation),
                                getPercent(ean.adjustedBalance - ean.missedDueToAllocation),
                            ],
                            backgroundColor: ["green", "red", "gray"],
                            borderWidth: 0.5,
                        },
                    ],
                },
                options: {
                    plugins: {
                        legend: {
                            display: false,
                        },
                        tooltip: {
                            callbacks: {
                                label(tooltipItem): string {
                                    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                                    return `${tooltipItem.raw} %`; // Show % in tooltip
                                },
                            },
                        },
                    },
                },
            });
        }
    };
    for (const ean of csv.distributionEans) {
        const cell = graphRow.insertCell();
        cell.classList.add("distribution");
        makeChart(cell, ean);
    }
    graphRow.insertCell().classList.add("split");
    for (const ean of csv.consumerEans) {
        const cell = graphRow.insertCell();
        cell.classList.add("consumer");
        makeChart(cell, ean);
    }
    tbody.appendChild(graphRow);
}

function displayIntervals(csv: Csv): void {
    const groupedIntervals = csv.getGroupedIntervals(gSettings.grouping);

    const maxSharingInterval = groupedIntervals.reduce((acc, val) => Math.max(acc, val.sumSharing), 0);
    const minSharingInterval = groupedIntervals.reduce((acc, val) => Math.min(acc, val.sumSharing), Infinity);
    const intervalTable = document.getElementById("intervals");
    const intervalBody = intervalTable!.querySelector("tbody")!;
    intervalBody.innerHTML = "";
    // Intervals
    setupHeader(document.getElementById("intervals") as HTMLTableElement, csv, false);

    for (let intervalIndex = 0; intervalIndex < groupedIntervals.length; ++intervalIndex) {
        const interval = groupedIntervals[intervalIndex];

        const useFiltering = gSettings.useFiltering();
        if (
            useFiltering &&
            (intervalIndex === 0 ||
                groupedIntervals[intervalIndex - 1].start.getDate() !== interval.start.getDate())
        ) {
            const separator = document.createElement("tr");
            separator.classList.add("daySeparator");
            const th = document.createElement("th");
            th.innerHTML = `↓ ${printOnlyDate(interval.start)} ↓`;
            th.colSpan = csv.distributionEans.length + csv.consumerEans.length + 2;
            separator.appendChild(th);
            intervalBody.appendChild(separator);
        }

        if (useFiltering && interval.sumSharing < maxSharingInterval * gSettings.filterValue) {
            continue;
        }
        const tr = document.createElement("tr");

        const th = document.createElement("th");
        tr.appendChild(th);
        th.innerHTML = printGroupedDate(interval.start);

        const sumDistributedBefore = interval.distributions.reduce((prev, i) => prev + i.before, 0);
        // const sumDistributedAfter = interval.distributions.reduce((prev, i) => prev + i.after, 0);
        const sumConsumedBefore = interval.consumers.reduce((prev, i) => prev + i.before, 0);
        const sumConsumedAfter = interval.consumers.reduce((prev, i) => prev + i.after, 0);
        if (interval.errors.length > 0) {
            th.classList.add("error");
            th.title = interval.errors.join("\n");
            // } else if (interval.sumMissed > 0) {
            //   th.classList.add("missed");
            //   th.title = `Missed ${printKWh(interval.sumMissed)} due to sub-optimal allocation keys.`;
        } else if (sumConsumedAfter > 0.05 * sumConsumedBefore) {
            th.classList.add("insufficient");
            th.title = "Distribution EANs did not produce enough power to share.\n";
            th.title += `Consumed before sharing: ${printKWh(sumConsumedBefore)}\n`;
            th.title += `Consumed after sharing: ${printKWh(sumConsumedAfter)}\n`;
            th.title += `Produced: ${printKWh(sumDistributedBefore)} (might not have been entirely shared due to timing and allocation issues)`;
        } else {
            th.title += `Consumed before sharing: ${printKWh(sumConsumedBefore)}\n`;
            th.title += `Consumed after sharing: ${printKWh(sumConsumedAfter)}\n`;
            th.title += `Produced: ${printKWh(sumDistributedBefore)} (might not have been entirely shared due to timing and allocation issues)`;
            th.classList.add("sufficient");
        }

        for (let i = 0; i < interval.distributions.length; ++i) {
            const cell = tr.insertCell();
            if (!gSettings.hiddenEans.has(csv.distributionEans[i].name)) {
                cell.innerHTML = printKWh(
                    interval.distributions[i].before - interval.distributions[i].after,
                    { nbsp: true },
                );
            }
            cell.classList.add("distribution");
        }
        tr.insertCell().classList.add("split");
        for (let i = 0; i < interval.consumers.length; ++i) {
            const cell = tr.insertCell();
            if (!gSettings.hiddenEans.has(csv.consumerEans[i].name)) {
                cell.innerHTML = printKWh(interval.consumers[i].before - interval.consumers[i].after, {
                    nbsp: true,
                });
            }
            cell.classList.add("consumer");
        }

        intervalBody.appendChild(tr);
    }
    document.getElementById("minFilter")!.innerHTML = printKWh(minSharingInterval, { nbsp: true });
    document.getElementById("maxFilter")!.innerHTML = printKWh(maxSharingInterval, { nbsp: true });

    (document.getElementById("thresholdFilter") as HTMLInputElement).innerHTML = printKWh(
        maxSharingInterval * gSettings.filterValue,
        { nbsp: true },
    );

    colorizeRange("table#intervals td.consumer", GREEN);
    colorizeRange("table#intervals td.distribution", GREEN);

    // Graph
    const holder = document.getElementById("intervalsGraph")!;
    holder.innerHTML = "";
    const canvas = document.createElement("canvas");
    holder.appendChild(canvas);

    const labels = groupedIntervals.map((i: Interval) => printGroupedDate(i.start, false));
    const shared = groupedIntervals.map((i: Interval) => i.sumSharing);
    const missed = groupedIntervals.map((i: Interval) => i.sumMissed);
    // console.log(labels);
    // console.log(shared);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const chart = new Chart.Chart(canvas, {
        type: "bar",
        data: {
            labels,
            datasets: [
                { label: "Shared", data: shared, backgroundColor: "green" },
                { label: "Missed", data: missed, backgroundColor: "red" },
            ],
        },
        options: {
            scales: {
                y: {
                    beginAtZero: true,
                    stacked: true,
                },
                x: {
                    stacked: true,
                },
            },
            plugins: {},
        },
    });
}

function displayCsv(csv: Csv): void {
    const startTime = performance.now();
    assert(gSettings.filterValue >= 0 && gSettings.filterValue <= 1);

    displayInputData(csv);
    displaySummary(csv);
    displayIntervals(csv);

    console.log("displayCsv took", performance.now() - startTime, "ms");
}

let gCsv: Csv | null = null;

function refreshView(): void {
    if (gCsv) {
        displayCsv(gCsv);
    }
}

fileDom.addEventListener("change", () => {
    if (fileDom.files?.length === 1) {
        warningDom.style.display = "none";
        warningDom.innerHTML = "";
        filterDom.value = "99";
        filterDom.dispatchEvent(new Event("input", { bubbles: true }));
        const reader = new FileReader();
        reader.addEventListener("loadend", () => {
            gCsv = parseCsv(reader.result as string, fileDom.files![0].name);
            refreshView();
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

export function mock(): void {
    // Testing data
    gCsv = parseCsv(
        `Datum;Cas od;Cas do;IN-859182400020000001-D;OUT-859182400020000001-D;IN-859182400000000002-O;OUT-859182400000000002-O;IN-859182400000000013-O;OUT-859182400000000013-O;IN-859182400000000004-O;OUT-859182400000000004-O;IN-859182400000000005-O;OUT-859182400000000005-O;IN-859182400000000006-O;OUT-859182400000000006-O;IN-859182400000000007-O;OUT-859182400000000007-O
05.02.2025;11:00;11:15;10,03;0,03;-0,74;-0,74;-10,1;-0,1;-0,53;-0,53;0,0;0,0;0,0;0,0;-0,18;-0,18;
05.02.2025;11:15;11:30;0,83;0,14;-0,74;-0,56;-0,09;0,0;-0,48;-0,1;0,0;0,0;-0,01;0,0;-0,03;0,0;
05.02.2025;11:30;11:45;1,2;0,15;-0,67;-0,41;-0,2;0,0;-0,56;-0,03;0,0;0,0;-0,02;0,0;-0,04;0,0;
05.02.2025;11:45;12:00;1,14;0,24;-0,07;0,0;-0,25;0,0;-0,69;-0,15;0,0;0,0;-0,01;0,0;-0,03;0,0;
05.02.2025;12:00;12:15;1,18;0,15;-0,35;-0,12;-0,24;0,0;-0,83;-0,33;0,0;0,0;-0,02;0,0;-0,04;0,0;
05.02.2025;12:15;12:30;0,91;0,22;-0,24;-0,04;-0,27;0,0;-0,18;0,0;0,0;0,0;0,0;0,0;-0,04;0,0;
05.02.2025;12:30;12:45;0,83;0,15;-0,39;-0,24;-0,29;0,0;-0,11;0,0;0,0;0,0;-0,01;0,0;-0,12;0,0;
05.02.2025;12:45;13:00;1,05;0,03;-1,13;-0,96;-0,56;-0,2;-0,11;0,0;0,0;0,0;-0,02;0,0;-0,48;-0,12;
05.02.2025;13:00;13:15;1,02;0,04;-0,24;-0,07;-0,63;-0,28;-0,12;0,0;0,0;0,0;0,0;0,0;-0,34;0,0;
05.02.2025;13:15;13:30;1,0;0,33;-0,26;-0,01;-0,11;0,0;-0,11;0,0;0,0;0,0;-0,02;0,0;-0,18;0,0;
05.02.2025;13:30;13:45;0,93;0,29;-0,21;0,0;-0,12;0,0;-0,11;0,0;0,0;0,0;-0,02;0,0;-0,18;0,0;
05.02.2025;13:45;14:00;0,86;0,45;-0,11;0,0;-0,09;0,0;-0,11;0,0;0,0;0,0;-0,01;0,0;-0,09;0,0;
`,
        "TESTING DUMMY",
    );
    refreshView();
}

if (0) {
    mock();
}
