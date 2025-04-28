/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { printKWh, printDate, printOnlyDate, displayCsv } from "./Display.js";
import { mock } from "./Mock.js";
import * as NoUiSlider from "nouislider";
import "nouislider/dist/nouislider.css";

// TODO: test multiple distribution EANs

export function last<T>(container: T[]): T {
    return container[container.length - 1];
}

export function sum(container: number[]): number {
    return container.reduce((acc, val) => acc + val, 0);
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

export type GroupingOptions = "15m" | "1h" | "1d" | "1m";
type DisplayUnit = "kWh" | "kW";
export type ProduceConsume = "produce" | "consume";

class Settings {
    displayUnit: DisplayUnit = "kWh";
    anonymizeEans = false;
    filterValue = 0;
    grouping: GroupingOptions = "1d";
    groupGraph = true;
    graphExtra: ProduceConsume = "produce";

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
        dom.innerText = `Vstupní data jsou nekonzistentní! Pouze "měsíční" hodnoty jsou zaručeně správné.
                         Skript se pokusí opravit některé větší chyby, ale výsledek může být stále chybný.`;
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
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
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

export function accumulateInterval(to: Interval, from: Interval): void {
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

export interface OptimizedAllocation {
    weights: number[];
    sharing: number[];
}
export interface SharingSimulationResult {
    sharingTotal: number;
    sharingPerEan: number[];
    sharingPerRoundPerEan: number[][]; // array[iterations][eans]
}
type OptimizationAlgorithm = "gradientDescend" | "random";

function gaussianRandom(mean = 0, stdev = 1): number {
    const u = 1 - Math.random(); // Converting [0,1) to (0,1]
    const v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    // Transform to the desired mean and standard deviation:
    return z * stdev + mean;
}
export class Csv {
    distributionEans: Ean[] = [];
    consumerEans: Ean[] = [];

    filename: string;
    dateFrom: Date;
    dateTo: Date;

    intervals: Interval[] = [];

    // Used for optimizing sharing
    // readonly #flatConsumed: Uint32Array;

    constructor(filename: string, intervals: Interval[], distributionEans: Ean[], consumerEans: Ean[]) {
        this.filename = filename;
        this.intervals = intervals;
        this.dateFrom = intervals[0].start;
        this.dateTo = structuredClone(last(intervals).start);
        this.dateTo.setMinutes(this.dateTo.getMinutes() + 14);
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

        // this.#flatConsumed = new Uint32Array(this.intervals.length * this.consumerEans.length);
        // for (let i = 0; i < this.intervals.length; ++i) {
        //    for (let j = 0; j < this.consumerEans.length; ++j) {
        //        this.#flatConsumed[i * this.consumerEans.length + j] = Math.round(
        //            this.intervals[i].consumers[j].before * 100,
        //        );
        //    }
        // }
    }

    getGroupedIntervals(grouping: GroupingOptions): Interval[] {
        const [dateFrom, dateTo] = this.#getDayFilterDates();
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
        const utc1 = Date.UTC(this.dateTo.getFullYear(), this.dateTo.getMonth(), this.dateTo.getDate());
        const utc2 = Date.UTC(this.dateFrom.getFullYear(), this.dateFrom.getMonth(), this.dateFrom.getDate());
        console.log(utc1 - utc2);
        return (utc1 - utc2) / (1000 * 3600 * 24) + 1;
    }

    // TODO: filtering of time intervals?
    simulateSharing(allocations: number[], iterations: number): SharingSimulationResult {
        // const startTime = Date.now();
        assert(sum(allocations) <= 100, "Allocations are over 100", allocations, sum(allocations));
        assert(this.distributionEans.length === 1);

        // We will run everything in integers multiplier by 100 to get fixed point 2 decimal places exact arithmetic

        const resultDetailed = [] as number[][];
        for (let i = 0; i < iterations; ++i) {
            resultDetailed.push(Array<number>(allocations.length).fill(0));
        }

        for (const interval of this.intervals) {
            // To fixed point. Note that the rounding is necessary even here. 0.07*100 = 7.000000000000001
            let toShare = Math.round(interval.distributions[0].before * 100);
            const consumed: number[] = interval.consumers.map((c) => Math.round(c.before * 100));

            for (let iteration = 0; iteration < iterations; ++iteration) {
                const energyThisRound = toShare;
                for (let i = 0; i < consumed.length; ++i) {
                    // Allocations are in %, so we need to divide by 100. The EDC manual explicitly says they truncate down here
                    const shared = Math.min(
                        consumed[i],
                        Math.trunc(energyThisRound * (allocations[i] / 100)),
                    );
                    consumed[i] -= shared;
                    toShare -= shared;
                    resultDetailed[iteration][i] += shared;
                    assert(shared >= 0);
                    assert(toShare >= 0);
                    assert(consumed[i] >= 0);
                }
            }
        }
        // Go back from fixed point to floats
        const resultEan = Array<number>(allocations.length).fill(0);
        let sharingTotal = 0;
        for (let i = 0; i < iterations; ++i) {
            for (let j = 0; j < allocations.length; ++j) {
                resultDetailed[i][j] /= 100;
                resultEan[j] += resultDetailed[i][j];
                sharingTotal += resultDetailed[i][j];
            }
        }
        // console.log("simulateSharing TOTAL took ", Date.now() - startTime, " ms");
        return { sharingTotal, sharingPerEan: resultEan, sharingPerRoundPerEan: resultDetailed };
    }

    // Fast version computing only final sharing
    simulateSharingFast(allocations: number[], iterations: number): number {
        // const startTime = Date.now();
        assert(sum(allocations) <= 100, "Allocations are over 100", allocations, sum(allocations));
        assert(this.distributionEans.length === 1);

        const allocationsFraction = allocations.map((i) => i / 100);
        // const allocationsFraction = new Uint32Array(allocations.length);
        // for (let i = 0; i < allocations.length; ++i) {
        //    allocationsFraction[i] = allocations[i] / 100;
        // }

        // We will run everything in integers multiplier by 100 to get fixed point 2 decimal places exact arithmetic

        // const flatConsumed = new Uint32Array(this.#flatConsumed);

        let sharingTotal = 0;
        for (const interval of this.intervals) {
            // To fixed point. Note that the rounding is necessary even here. 0.07*100 = 7.000000000000001
            let toShare = Math.round(interval.distributions[0].before * 100);

            const consumed = interval.consumers.map((c) => Math.round(c.before * 100));

            for (let iteration = 0; iteration < iterations; ++iteration) {
                const energyThisRound = toShare;
                for (let i = 0; i < consumed.length; ++i) {
                    // Allocations are in %, so we need to divide by 100. The EDC manual explicitly says they truncate down here
                    const shared = Math.min(
                        consumed[i],
                        Math.trunc(energyThisRound * allocationsFraction[i]),
                    );
                    consumed[i] -= shared;
                    toShare -= shared;
                    sharingTotal += shared;
                    // console.log(shared);
                }
            }
        }
        return sharingTotal / 100;
    }

    // progressCallback is called at the end with final value
    optimizeAllocation(
        sharingRounds: number,
        algorithm: OptimizationAlgorithm,
        maxFails: number,
        restarts: number,
        progressCallback: (resultSoFar: OptimizedAllocation, iteration: number) => void,
    ): void {
        const startTime = Date.now();
        let result = this.#optimizeAllocationIteration(sharingRounds, algorithm, maxFails);

        let progress = 0;
        const iterate = (): void => {
            ++progress;
            const newResult = this.#optimizeAllocationIteration(sharingRounds, algorithm, maxFails);
            console.log(`Restart ${progress} Achieved sharing ${sum(result.sharing)}`);
            if (sum(newResult.sharing) > sum(result.sharing)) {
                result = newResult;
            }
            progressCallback(result, progress);
            if (progress < restarts) {
                setTimeout(iterate, 0);
            } else {
                console.log("optimizeAllocation TOTAL took ", Date.now() - startTime, " ms");
            }
        };
        setTimeout(iterate, 0);
    }

    getFilteredCsv(): string {
        const timeStart = new Date().getTime();
        let result = "Datum;Cas od;Cas do;";
        let hasConsumer = false;
        for (const ean of this.consumerEans) {
            if (!gSettings.hiddenEans.has(ean.name)) {
                result += `IN-${ean.name}-O;OUT-${ean.name}-O;`;
                hasConsumer = true;
            }
        }
        assert(hasConsumer, "Pro export CSV musí být zobrazen aspoň jeden odběratelský EAN");
        result += "IN-859182400000000000-D;OUT-859182400000000000-D\n"; // Virtual EANs that will be the inverse of consumption

        const [dateFrom, dateTo] = this.#getDayFilterDates();
        const printNumberCzech = (x: number): string => x.toFixed(2).replaceAll(".", ",");
        for (const interval of this.intervals) {
            if (interval.start < dateFrom || interval.start > dateTo) {
                console.log("filtering", interval.start, dateFrom, dateTo);
                continue;
            }
            result += `${String(interval.start.getDate()).padStart(2, "0")}.${String(interval.start.getMonth() + 1).padStart(2, "0")}.${interval.start.getFullYear()};`;
            const intervalEnd = structuredClone(interval.start);
            intervalEnd.setMinutes(intervalEnd.getMinutes() + 15);
            for (const time of [interval.start, intervalEnd]) {
                result += `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")};`;
            }
            let sumShared = 0;
            for (let i = 0; i < this.consumerEans.length; ++i) {
                if (!gSettings.hiddenEans.has(this.consumerEans[i].name)) {
                    result += `${printNumberCzech(-interval.consumers[i].before)};`;
                    result += `${printNumberCzech(-interval.consumers[i].after)};`;
                    sumShared += interval.consumers[i].before - interval.consumers[i].after;
                }
            }
            result += `${printNumberCzech(sumShared)};0;\n`;
        }
        console.log("getFilteredCsv took", new Date().getTime() - timeStart, "ms");
        return result;
    }

    #getDayFilterDates(): [Date, Date] {
        const dateFrom = structuredClone(this.dateFrom);
        dateFrom.setDate(dateFrom.getDate() + gSettings.minDayFilter);
        const dateTo = structuredClone(this.dateFrom);
        dateTo.setDate(dateTo.getDate() + gSettings.maxDayFilter + 1);
        dateTo.setMinutes(dateTo.getMinutes() - 1);
        return [dateFrom, dateTo];
    }

    #optimizeAllocationIteration(
        sharingRounds: number,
        algorithm: OptimizationAlgorithm,
        maxFails: number,
    ): OptimizedAllocation {
        const clampTo2 = (num: number): number => Math.trunc(num * 100) / 100;

        const timeStart = Date.now();
        let weights = Array<number>(this.consumerEans.length);
        for (let i = 0; i < weights.length; ++i) {
            weights[i] = Math.random() * 100;
        }
        const sumInitial = sum(weights);
        for (let i = 0; i < weights.length; ++i) {
            weights[i] /= sumInitial / 99.99;
        }
        // console.log("initial random weights", weights);
        const bumpConsumer = (index: number, amount: number): number[] => {
            const result = structuredClone(weights);
            const eligibleUp = Math.min(amount, 100 - result[index]);
            let eligibleDown = 0;
            const desiredDownIndividual = eligibleUp / (result.length - 1);
            for (let i = 0; i < result.length; ++i) {
                if (i !== index) {
                    eligibleDown += Math.min(desiredDownIndividual, result[i]);
                }
            }
            const change = Math.min(eligibleUp, eligibleDown);
            assert(change > 0);
            result[index] = clampTo2(result[index] + change);
            for (let i = 0; i < result.length; ++i) {
                if (i !== index) {
                    result[i] = Math.max(0, clampTo2(result[i] - desiredDownIndividual));
                }
            }
            // Finally, add the unallocated amount to the consumer which we are bumping:
            result[index] = clampTo2(result[index] + 99.99 - sum(result));
            return result;
        };

        let bestSharing = this.simulateSharingFast(weights, sharingRounds);
        let failedInRow = 0;
        let iterations = 0;
        let bestWeights = structuredClone(weights);
        while (failedInRow < maxFails) {
            ++iterations;

            let thisTotal = 0;
            if (algorithm === "gradientDescend") {
                const STEP = 1;
                const differences = [] as number[];
                for (let i = 0; i < this.consumerEans.length; ++i) {
                    const result = this.simulateSharingFast(bumpConsumer(i, STEP), sharingRounds);
                    differences.push(result - bestSharing);
                }
                // console.log(differences);
                let max = 0;
                for (let i = 1; i < differences.length; i++) {
                    if (differences[i] > differences[max]) {
                        max = i;
                    }
                }
                thisTotal = this.simulateSharingFast(weights, sharingRounds);
            } else {
                const randomIndex = Math.trunc(Math.random() * this.consumerEans.length);
                const randomAmount = Math.abs(gaussianRandom(0, 5));
                // console.log("random amount", randomAmount);
                const proposedWeights = bumpConsumer(randomIndex, randomAmount);
                const proposedResult = this.simulateSharingFast(proposedWeights, sharingRounds);
                if (proposedResult > bestSharing) {
                    weights = proposedWeights;
                    // console.log(proposedWeights);
                    thisTotal = proposedResult;
                }
            }

            if (thisTotal <= bestSharing) {
                ++failedInRow;
            } else {
                // console.log(thisTotal);
                bestSharing = thisTotal;
                bestWeights = structuredClone(weights);
                failedInRow = 0;
            }
        }
        const final = this.simulateSharing(bestWeights, sharingRounds);
        assert(
            Math.abs(final.sharingTotal - this.simulateSharingFast(bestWeights, sharingRounds)) < 0.01,
            final.sharingTotal,
            this.simulateSharingFast(bestWeights, sharingRounds),
        );
        console.log(
            `Optimize Weights iteration took ${iterations} iterations and ${Date.now() - timeStart} ms. Sharing achieved: ${final.sharingTotal}`,
        );
        // console.log(`Sum weights ${bestWeights.reduce((w, a) => w + a, 0)}`);
        assert(bestWeights.reduce((w, a) => w + a, 0) <= 100);
        return { weights: bestWeights, sharing: final.sharingPerEan };
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
    assert(
        header.length % 2 === 1,
        `Wrong number of CSV header fields - must be 3 + 2* number of EANs. Got ${header.length}`,
    );

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

        if (intervals.length > 0) {
            const lastStart = last(intervals).start;
            const minutesThis = dateStart.getHours() * 60 + dateStart.getMinutes();
            const minutesLast = lastStart.getHours() * 60 + lastStart.getMinutes();
            switch (minutesThis - minutesLast) {
                case -1425: // Day break
                case 15: // 15 minutes - regular
                    break;
                case 75: // 1:15 - missing 1 hour (4 entries) due to DST adjustment
                    assert(dateStart.getHours() === 3);
                    console.log("DST!!!!!!!!!!!!!!!!!!!!!!!!!!", dateStart);
                    break;
                case -45: // -0:45 - missing 1 hour due to DST adjustment
                    assert(dateStart.getHours() === 2);
                    console.log("DST!!!!!!!!!!!!!!!!!!!!!!!!!!", dateStart);
                    break;
                default:
                    assert(false);
            }
        }

        const distributed: Measurement[] = [];
        const consumed: Measurement[] = [];

        const errors = [] as string[];

        const parsePair = (cellBefore: string, cellAfter: string, ean: Ean): [number, number] => {
            const before = parseKwh(cellBefore);
            // In "Aktuální hodnoty", the after value could be missing while before value is present. Let's assume no sharing in that case
            if (cellAfter === "" && cellBefore !== "") {
                const error = `Pro EAN ${ean.name} chybí hodnota pro ponížená data. Sdílení pro tento časový úsek bude nastaveno na 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                return [before, before];
            } else {
                // When EAN is added in the middle of the report time frame, both before and after are missing. We will return zeroes
                return [before, parseKwh(cellAfter)];
            }
        };

        for (const ean of distributorEans) {
            let [before, after] = parsePair(explodedLine[ean.csvIndex], explodedLine[ean.csvIndex + 1], ean);
            if (after > before) {
                const error = `Výroba zdroje ${ean.name} je po započítání sdílení VYŠŠÍ o ${after - before} kWh. Sdílení pro tento časový úsek bude nastaveno na 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                after = before;
            }
            if (before < 0 || after < 0) {
                const error = `Výrobní zdroj ${ean.name} odebírá energii ze sítě (${before / after} kWh). Odběr/výroba pro tento časový úsek bude nastavena na 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                before = Math.max(0, before);
                after = Math.max(0, after);
            }
            distributed.push({ before, after, missed: 0 });
        }
        for (const ean of consumerEans) {
            let [before, after] = parsePair(explodedLine[ean.csvIndex], explodedLine[ean.csvIndex + 1], ean);
            before *= -1;
            after *= -1;
            if (after > before) {
                const error = `Odběrovému EAN ${ean.name} se po započítání sdílení ZVÝŠILA spotřeba o ${after - before} kWh. Sdílení pro tento časový úsek bude nastaveno na 0.`;
                logWarning(error, dateStart);
                errors.push(error);
                after = before;
            }
            if (before < 0 || after < 0) {
                const error = `Odběrový EAN ${ean.name} dodává energii do sítě (${before / after} kWh). Odběr/výroba pro tento časový úsek bude nastavena na 0.`;
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
            const error = `Energie nasdílená od výrobních zdrojů (${printKWh(sumShared)}) neodpovídá energii nasdílené do oběratelských míst (${printKWh(sumSharedConsumers)})!. V reportu se použije nižší z hodnot.`;
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

                // Different attempt to fix it:
                // Coefficient is sum of missed consumption / sum of consumed
                // const coefficient = (sumSharedConsumers - sumShared) / sumConsumersBefore;
                // console.log("Fixing consumers", coefficient);
                // assert(coefficient > 0, sumShared, sumSharedConsumers);
                // for (const j of consumed) {
                //    j.after += j.before * coefficient;
                // }
            }
        }

        // If there is still some power left after sharing, we check that all consumers have 0 adjusted power.
        // If there was some consumer left with non-zero power, it means there was energy that could have been
        // shared, but wasn't due to bad allocation.
        let sumMissed = 0;

        const anyOverThreshold = (measurements: Measurement[]): boolean => {
            for (const measurement of measurements) {
                // There are plenty of intervals where distribution before and after are both 0.01 and no sharing is performed...:
                if (measurement.after > 0) {
                    return true;
                }
            }
            return false;
        };
        if (anyOverThreshold(distributed) && anyOverThreshold(consumed)) {
            sumMissed = Math.min(sumConsumersAfter, sumDistributorsAfter);
            for (const c of consumed) {
                c.missed = (c.after / sumConsumersAfter) * sumMissed;
                assert(!isNaN(c.missed));
            }
            for (const p of distributed) {
                p.missed += (p.after / sumDistributorsAfter) * sumMissed;
                assert(!isNaN(p.missed));
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
    gSettings.minDayFilter = Math.round(values[0]); // Sometimes we receive x+epsilon values...
    gSettings.maxDayFilter = Math.round(values[1]);
    refreshView();
});

export function updateCsv(value: string, name: string): void {
    gCsv = parseCsv(value, name);
    const format = {
        to: (i: number): string => {
            const date = structuredClone(gCsv!.dateFrom);
            date.setDate(date.getDate() + i);
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
document.querySelectorAll('input[name="graphNonShared"]').forEach((button) => {
    button.addEventListener("change", (e) => {
        gSettings.graphExtra = (e.target as HTMLInputElement).value as ProduceConsume;
        refreshView();
    });
});
document.getElementById("download")!.addEventListener("click", () => {
    if (gCsv) {
        const content = gCsv.getFilteredCsv();
        const filename = `filtered_${gCsv.filename}`;
        const blob = new Blob([content], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename; // This tells the browser to download instead of navigating
        document.body.appendChild(a); // Needed for Firefox
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
});

const groupGraph = document.getElementById("groupGraph") as HTMLInputElement;
groupGraph.addEventListener("change", () => {
    gSettings.groupGraph = (document.getElementById("groupGraph") as HTMLInputElement).checked;
    refreshView();
});

if (0) {
    mock();
}
