/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
/* eslint-disable no-lone-blocks */

// TODO: test multiple distribution EANs

type Rgb = [number, number, number];

function last<T>(container: T[]): T {
    return container[container.length - 1];
}

function assert(condition: boolean, ...loggingArgs: unknown[]): asserts condition {
    if (!condition) {
        const errorMsg = `Assert failed: ${loggingArgs.toString()}`;
        console.error("Assert failed", ...loggingArgs);
        debugger;
        alert(errorMsg);
        throw new Error(errorMsg);
    }
}

const warningDom = document.getElementById("warnings") as HTMLDivElement;
const fileDom = document.getElementById("uploadCsv") as HTMLInputElement;
const filterDom = document.getElementById("filterSlider") as HTMLInputElement;

interface Settings {
    displayUnit: "kWh" | "kW";
    hideEans: boolean;
    filterValue: number;
}

const gSettings: Settings = {
    displayUnit: "kWh",
    hideEans: false,
    filterValue: 0,
};

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

function printKWh(input: number, alwaysKwh = false): string {
    if (gSettings.displayUnit === "kW" && !alwaysKwh) {
        return `${(input * 4).toFixed(2)}&nbsp;kW`;
    } else {
        return `${input.toFixed(2)}&nbsp;kWh`;
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
    if (gSettings.hideEans) {
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

    distributions: Measurement[];
    consumers: Measurement[];

    errors: string[]
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

    constructor(filename: string, intervals: Interval[]) {
        this.filename = filename;
        this.intervals = intervals;
        this.dateFrom = intervals[0].start;
        this.dateTo = last(intervals).start;
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
    const missedSharingDueToAllocationTimeSlots = new Map<number, number>();
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
        const date = getDate(explodedLine);

        const distributed: Measurement[] = [];
        const consumed: Measurement[] = [];

        const errors = [] as string[];

        for (const ean of distributorEans) {
            let before = parseKwh(explodedLine[ean.csvIndex]);
            let after = parseKwh(explodedLine[ean.csvIndex + 1]);
            if (after > before) {
                const error = `Distribution EAN ${ean.name} is distributing ${after - before} kWh more AFTER subtracting sharing. The report will clip sharing to 0.`;
                logWarning(error, date);
                errors.push(error);
                after = before;
            }
            if (before < 0 || after < 0) {
                const error = `Distribution EAN ${ean.name} is consuming ${before / after} kWh power. The report will clip negative values to 0.`;
                logWarning(error, date);
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
                logWarning(error, date);
                errors.push(error);
                after = before;
            }
            if (before < 0 || after < 0) {
                const error = `Consumer EAN ${ean.name} is distributing ${before / after} kWh power. The report will clip negative values to 0.`;
                logWarning(error, date);
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
        const sumDistributorsAfter = distributed.reduce((acc, val) => acc + val.after, 0);
        if (sumDistributorsAfter > 0) {
            let sumConsumersAfter = consumed.reduce((acc, val) => acc + val.after, 0);
            const missedScale = Math.min(1.0, sumDistributorsAfter / sumConsumersAfter);
            assert(missedScale > 0 && missedScale <= 1, missedScale);
            sumConsumersAfter = Math.min(sumConsumersAfter, sumDistributorsAfter);

            // There are plenty of intervals where distribution before and after are both 0.01 and no sharing
            // is performed...:
            if (sumConsumersAfter > 0.0 && sumDistributorsAfter > 0.0) {
                missedSharingDueToAllocationTimeSlots.set(date.getTime(), sumConsumersAfter);
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
            logWarning(error, date);
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
            start: date,
            sumSharing: distributed.reduce((acc, val) => acc + (val.before - val.after), 0),
            distributions: distributed,
            consumers: consumed,
            errors,
        });
    }

    const result = new Csv(filename, intervals);

    result.distributionEans = distributorEans;
    result.consumerEans = consumerEans;

    result.sharedTotal = distributorEans.reduce(
        (acc, val) => acc + val.originalBalance - val.adjustedBalance,
        0,
    );
    result.missedTotal = consumerEans.reduce((acc, val) => acc + val.missedDueToAllocation, 0);
    return result;
}

function colorizeRange(query: string, rgb: Rgb): void {
    const collection = document.querySelectorAll(query);
    // console.log(query);
    // console.log(collection);
    // let minimum = Infinity;
    let minimum = 0; // It works better with filtering if minimum is always 0
    let maximum = 0;
    for (const i of collection) {
        const value = parseFloat((i as HTMLElement).innerText);
        maximum = Math.max(maximum, value);
        minimum = Math.min(minimum, value);
    }
    // console.log(minimum, maximum);
    assert(!isNaN(maximum), `There is a NaN when colorizing query${query}`);
    // console.log("Colorizing with maximum", maximum);
    for (const i of collection) {
        const htmlElement = i as HTMLElement;
        const alpha = (parseFloat(htmlElement.innerText) - minimum) / Math.max(0.00001, maximum - minimum);
        // console.log(htmlElement);
        assert(!isNaN(alpha), "There is NaN somewhere in data", alpha);
        const cssString = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
        // console.log(cssString);
        htmlElement.style.backgroundColor = cssString;
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
        th.innerText = printEan(ean.name);
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

function displayCsv(csv: Csv): void {
    const startTime = performance.now();
    assert(gSettings.filterValue >= 0 && gSettings.filterValue <= 1);
    const GREEN = [14, 177, 14] as Rgb;
    const RED = [255, 35, 35] as Rgb;
    const GRAY = [150, 150, 150] as Rgb;

    {
        // Input data
        document.getElementById("filename")!.innerText = csv.filename;
        document.getElementById("intervalFrom")!.innerText = printDate(csv.dateFrom);
        document.getElementById("intervalTo")!.innerText = printDate(csv.dateTo);
    }

    {
        // Summary
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
                cell.innerHTML = printFn(ean);
                cell.classList.add("distribution");
            }
            row.insertCell().classList.add("split");
            for (const ean of csv.consumerEans) {
                const cell = row.insertCell();
                cell.innerHTML = printFn(ean);
                cell.classList.add("consumer");
            }
            tbody.appendChild(row);
            colorizeRange(`table#csv tr.${id} td.consumer`, backgroundColor);
            colorizeRange(`table#csv tr.${id} td.distribution`, backgroundColor);
        };

        makeRow("Original [kWh]:", GRAY, (ean) => printKWh(ean.originalBalance, true));
        makeRow("Adjusted [kWh]:", GRAY, (ean) => printKWh(ean.adjustedBalance, true));
        makeRow("Shared [kWh]:", GREEN, (ean) => printKWh(ean.originalBalance - ean.adjustedBalance, true));
        makeRow("Missed [kWh]:", RED, (ean) => printKWh(ean.missedDueToAllocation, true));
    }

    let minSharingDistributor = Infinity;
    let maxSharingDistributor = 0;
    let minSharingConsumer = Infinity;
    let maxSharingConsumer = 0;
    for (const interval of csv.intervals) {
        for (const i of interval.distributions) {
            const sharing = i.before - i.after;
            maxSharingDistributor = Math.max(maxSharingDistributor, sharing);
            minSharingDistributor = Math.min(minSharingDistributor, sharing);
        }
        for (const i of interval.consumers) {
            const sharing = i.before - i.after;
            maxSharingConsumer = Math.max(maxSharingConsumer, sharing);
            minSharingConsumer = Math.min(minSharingConsumer, sharing);
        }
    }

    const maxSharingInterval = csv.intervals.reduce((acc, val) => Math.max(acc, val.sumSharing), 0);
    const minSharingInterval = csv.intervals.reduce((acc, val) => Math.min(acc, val.sumSharing), Infinity);
    const intervalTable = document.getElementById("intervals");
    const intervalBody = intervalTable!.querySelector("tbody")!;
    intervalBody.innerHTML = "";
    // Intervals
    setupHeader(document.getElementById("intervals") as HTMLTableElement, csv, false);

    let lastDisplayed: null | Interval = null;

    for (let intervalIndex = 0; intervalIndex < csv.intervals.length; ++intervalIndex) {
        const interval = csv.intervals[intervalIndex];

        if (
            intervalIndex !== csv.intervals.length - 1 &&
            interval.start.getDate() !== csv.intervals[intervalIndex + 1].start.getDate()
        ) {
            // Last interval of the day
            if (!lastDisplayed || interval.start.getDate() !== lastDisplayed.start.getDate()) {
                const separator = document.createElement("tr");
                separator.classList.add("daySeparator");
                const th = document.createElement("th");
                th.innerHTML = printOnlyDate(interval.start);
                const td2 = document.createElement("td");
                td2.colSpan = csv.distributionEans.length + csv.consumerEans.length + 1;
                td2.innerHTML = "All Filtered out";
                separator.appendChild(th);
                separator.appendChild(td2);
                intervalBody.appendChild(separator);
            }
        }

        if (interval.sumSharing < maxSharingInterval * gSettings.filterValue) {
            continue;
        }
        lastDisplayed = interval;
        const tr = document.createElement("tr");

        // Optimization: do not use colorizeRange()
        const getBackground = (value: number, minimum: number, maximum: number): string => {
            const alpha = (value - minimum) / Math.max(0.00001, maximum - minimum);
            return `rgba(${GREEN[0]}, ${GREEN[1]}, ${GREEN[2]}, ${alpha})`;
        };

        if (1) {
            // Speed optimization
            tr.innerHTML = `<th>${printDate(interval.start)} - ${String(interval.start.getHours()).padStart(2, "0")}:${String(interval.start.getMinutes() + 14).padStart(2, "0")}</th>
                            ${interval.distributions.map((i) => `<td class='distribution' style="background-color:${getBackground(i.before - i.after, minSharingDistributor, maxSharingDistributor)}">${printKWh(i.before - i.after)}</td>`).join("")}
                            <td class='split'></td>
                            ${interval.consumers.map((i) => `<td class='consumer' style="background-color:${getBackground(i.before - i.after, minSharingConsumer, maxSharingConsumer)}">${printKWh(i.before - i.after)}</td>`).join("")}`;
        } else {
            const th = document.createElement("th");
            tr.appendChild(th);
            th.innerHTML = `${printDate(interval.start)} - ${String(interval.start.getHours()).padStart(2, "0")}:${String(interval.start.getMinutes() + 14).padStart(2, "0")}`;

            for (const i of interval.distributions) {
                const cell = tr.insertCell();
                cell.innerHTML = printKWh(i.before - i.after);
                cell.classList.add("distribution");
            }
            tr.insertCell().classList.add("split");
            for (const i of interval.consumers) {
                const cell = tr.insertCell();
                cell.innerHTML = printKWh(i.before - i.after);
                cell.classList.add("consumer");
            }
        }
        if (interval.errors.length > 0) {
            tr.classList.add("error");
            tr.title = interval.errors.join("\n"); 
        }
        intervalBody.appendChild(tr);
    }
    document.getElementById("minFilter")!.innerHTML = printKWh(minSharingInterval);
    document.getElementById("maxFilter")!.innerHTML = printKWh(maxSharingInterval);

    (document.getElementById("thresholdFilter") as HTMLInputElement).innerHTML = printKWh(
        maxSharingInterval * gSettings.filterValue,
    );

    // console.log("Colorizing table#intervals td.consumer");
    colorizeRange("table#intervals td.consumer", GREEN);
    // console.log("Colorizing table#intervals td.distribution");
    colorizeRange("table#intervals td.distribution", GREEN);

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
document.getElementById("hideEans")!.addEventListener("change", () => {
    gSettings.hideEans = (document.getElementById("hideEans") as HTMLInputElement).checked;
    refreshView();
});
document.querySelectorAll('input[name="unit"]').forEach((button) => {
    button.addEventListener("change", (e) => {
        gSettings.displayUnit = (e.target as HTMLInputElement).value as "kWh" | "kW";
        refreshView();
    });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function mock(): void {
    // Testing data
    gCsv = parseCsv(
        `Datum;Cas od;Cas do;IN-859182400000000001-D;OUT-859182400000000001-D;IN-859182400000000002-O;OUT-859182400000000002-O;IN-859182400000000003-O;OUT-859182400000000003-O;IN-859182400000000004-O;OUT-859182400000000004-O;IN-859182400000000005-O;OUT-859182400000000005-O;IN-859182400000000006-O;OUT-859182400000000006-O;IN-859182400000000007-O;OUT-859182400000000007-O
05.02.2025;11:00;11:15;0,03;0,03;-0,74;-0,74;-0,1;-0,1;-0,53;-0,53;0,0;0,0;0,0;0,0;-0,18;-0,18;
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

mock();
