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
        alert(errorMsg);
        throw new Error(errorMsg);
    }
}

const warningDom = document.getElementById("warnings") as HTMLDivElement;

let gDisplayUnit = "kWh";

function logWarning(warning: string): void {
    warningDom.style.display = "block";
    const dom = document.createElement("li");
    dom.innerText = warning;
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
    if (gDisplayUnit === "kW" && !alwaysKwh) {
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

function printEan(input: string, hide: boolean): string {
    assert(input.length === 18);
    // input = input.replace("859182400", "…"); // Does not look good...
    if (hide) {
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
    const lines = csv.split("\n");
    assert(lines.length > 0, "CSV file is empty");
    const header = lines[0].split(";");
    assert(header.length > 3, "CSV file has invalid header");
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
            `Wrong number of items: ${explodedLine.length}, expected: ${expectedLength}, line number: ${i}`,
        );
        const date = getDate(explodedLine);

        const distributed: Measurement[] = [];
        const consumed: Measurement[] = [];

        for (const ean of distributorEans) {
            const before = parseKwh(explodedLine[ean.csvIndex]);
            const after = parseKwh(explodedLine[ean.csvIndex + 1]);
            if (before < 0 || after < 0) {
                logWarning(
                    `Input data is inconsistent! Only "monthly report" is guaranteed to be correct, prefer using that.
                    Distribution EAN ${ean.name} is consuming ${before}/${after} kWh power on ${printDate(date)}`,
                );
            }

            ean.originalBalance += before;
            ean.adjustedBalance += after;
            ean.maximumOriginal = Math.max(ean.maximumOriginal, before);
            distributed.push({ before, after });
        }
        for (const ean of consumerEans) {
            const before = -parseKwh(explodedLine[ean.csvIndex]);
            const after = -parseKwh(explodedLine[ean.csvIndex + 1]);
            if (before < 0 || after < 0) {
                logWarning(
                    `Input data is inconsistent! Only "monthly report" is guaranteed to be correct, prefer using that.
                    Consumer EAN ${ean.name} is distributing ${before}/${after} kWh power on ${printDate(date)}`,
                );
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
        const sumSharedProduced = distributed.reduce((acc, val) => acc + (val.before - val.after), 0);
        const sumSharedConsumed = consumed.reduce((acc, val) => acc + (val.before - val.after), 0);
        if (Math.abs(sumSharedProduced - sumSharedConsumed) > 0.0001) {
            logWarning(
                `Input data is inconsistent! Only "monthly report" is guaranteed to be correct, prefer using that.
                Energy shared from producers does not match energy shared to consumers on ${printDate(date)}! \nProduced: ${sumSharedProduced}\n Consumed: ${sumSharedConsumed}`,
            );
        }

        intervals.push({
            start: date,
            sumSharing: distributed.reduce((acc, val) => acc + (val.before - val.after), 0),
            distributions: distributed,
            consumers: consumed,
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
    assert(!isNaN(maximum));
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

function setupHeader(table: HTMLTableElement, csv: Csv, hideEans: boolean): void {
    (table.querySelector("th.distributionHeader") as HTMLTableCellElement).colSpan =
        csv.distributionEans.length;
    (table.querySelector("th.consumerHeader") as HTMLTableCellElement).colSpan = csv.consumerEans.length;

    const theader = table.querySelector("tr.csvHeaderRow") as HTMLTableRowElement;
    assert(theader !== null);
    theader.innerHTML = "<th>EAN</th>";
    for (const ean of csv.distributionEans) {
        const th = document.createElement("th");
        th.classList.add("distribution");
        th.innerText = printEan(ean.name, hideEans);
        theader.appendChild(th);
    }
    theader.insertCell().classList.add("split");
    for (const ean of csv.consumerEans) {
        const th = document.createElement("th");
        th.classList.add("consumer");
        th.innerText = printEan(ean.name, hideEans);
        theader.appendChild(th);
    }
}

function printOnlyDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function printDate(date: Date): string {
    return `${printOnlyDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const thresholdFilter = document.getElementById("thresholdFilter") as HTMLInputElement;

function displayCsv(csv: Csv, filterValue: number, hideEans: boolean): void {
    const startTime = performance.now();
    console.log("DisplayCsv filterValue", filterValue);
    assert(filterValue >= 0 && filterValue <= 1);
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
        setupHeader(document.getElementById("csv") as HTMLTableElement, csv, hideEans);
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
    setupHeader(document.getElementById("intervals") as HTMLTableElement, csv, hideEans);

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

        if (interval.sumSharing < maxSharingInterval * filterValue) {
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
        intervalBody.appendChild(tr);
    }
    document.getElementById("minFilter")!.innerHTML = printKWh(minSharingInterval);
    document.getElementById("maxFilter")!.innerHTML = printKWh(maxSharingInterval);

    thresholdFilter.innerHTML = printKWh(maxSharingInterval * filterValue);

    // console.log("Colorizing table#intervals td.consumer");
    colorizeRange("table#intervals td.consumer", GREEN);
    // console.log("Colorizing table#intervals td.distribution");
    colorizeRange("table#intervals td.distribution", GREEN);

    console.log("displayCsv took", performance.now() - startTime, "ms");
}

let gCsv: Csv | null = null;

const fileInput = document.getElementById("uploadCsv") as HTMLInputElement;
const filterSlider = document.getElementById("filterSlider") as HTMLInputElement;

function refreshView(): void {
    if (gCsv) {
        displayCsv(gCsv, getFilterValue(), getHideEans());
    }
}

function getFilterValue(): number {
    return 1 - parseInt(filterSlider.value, 10) / 100;
}
function getHideEans(): boolean {
    return (document.getElementById("hideEans") as HTMLInputElement).checked;
}
fileInput.addEventListener("change", () => {
    if (fileInput.files?.length === 1) {
        warningDom.style.display = "none";
        warningDom.innerHTML = "";
        thresholdFilter.value = "0";
        const reader = new FileReader();
        reader.addEventListener("loadend", () => {
            gCsv = parseCsv(reader.result as string, fileInput.files![0].name);
            refreshView();
        });
        reader.readAsText(fileInput.files[0]); // Read file as text
    }
});
filterSlider.addEventListener("input", () => {
    refreshView();
});
document.getElementById("hideEans")!.addEventListener("change", () => {
    refreshView();
});
document.querySelectorAll('input[name="unit"]').forEach((button) => {
    button.addEventListener("change", (e) => {
        gDisplayUnit = (e.target as HTMLInputElement).value;
        refreshView();
    });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function mock(): void {
    // Testing data
    gCsv = parseCsv(
        `Datum;Cas od;Cas do;IN-859182400000000001-D;OUT-859182400000000001-D;IN-859182400000000002-O;OUT-859182400000000002-O;IN-859182400000000003-O;OUT-859182400000000003-O;IN-859182400000000004-O;OUT-859182400000000004-O;IN-859182400000000005-O;OUT-859182400000000005-O;IN-859182400000000006-O;OUT-859182400000000006-O;IN-859182400000000007-O;OUT-859182400000000007-O
01.02.2025;00:00;00:15;0,0;0,0;-0,35;-0,35;-0,07;-0,07;-0,54;-0,54;-0,52;-0,52;-0,02;-0,02;-0,03;-0,03;
01.02.2025;00:15;00:30;0,0;0,0;-0,59;-0,59;-0,14;-0,14;-0,89;-0,89;-0,54;-0,54;-0,01;-0,01;-0,05;-0,05;
01.02.2025;00:30;00:45;0,0;0,0;-0,47;-0,47;-0,36;-0,36;-0,72;-0,72;-0,54;-0,54;0,0;0,0;-0,03;-0,03;
01.02.2025;00:45;01:00;0,0;0,0;-0,03;-0,03;-0,37;-0,37;-0,62;-0,62;-0,52;-0,52;-0,02;-0,02;-0,04;-0,04;
01.02.2025;01:00;01:15;0,0;0,0;0,0;0,0;-0,38;-0,38;-0,55;-0,55;-0,55;-0,55;-0,01;-0,01;-0,31;-0,31;
01.02.2025;01:15;01:30;0,0;0,0;-0,01;-0,01;-0,35;-0,35;-0,58;-0,58;-0,53;-0,53;-0,02;-0,02;-0,1;-0,1;
01.02.2025;01:30;01:45;0,0;0,0;-0,29;-0,29;-0,8;-0,8;-0,66;-0,66;-0,33;-0,33;-0,01;-0,01;-0,04;-0,04;
01.02.2025;01:45;02:00;0,0;0,0;-0,34;-0,34;-0,31;-0,31;-0,82;-0,82;-0,14;-0,14;-0,01;-0,01;-0,06;-0,06;
01.02.2025;02:00;02:15;0,0;0,0;-0,2;-0,2;-0,07;-0,07;-0,16;-0,16;-0,15;-0,15;-0,02;-0,02;-0,06;-0,06;
01.02.2025;02:15;02:30;0,0;0,0;-0,42;-0,42;-0,08;-0,08;-0,11;-0,11;-0,5;-0,5;-0,01;-0,01;-0,03;-0,03;
01.02.2025;02:30;02:45;0,0;0,0;-0,23;-0,23;-0,07;-0,07;-0,11;-0,11;-0,49;-0,49;-0,01;-0,01;-0,05;-0,05;
01.02.2025;02:45;03:00;0,0;0,0;0,0;0,0;-0,32;-0,32;-0,12;-0,12;-0,55;-0,55;-0,02;-0,02;-0,03;-0,03;
01.02.2025;03:00;03:15;0,0;0,0;-0,1;-0,1;-0,38;-0,38;-0,11;-0,11;-0,52;-0,52;0,0;0,0;-0,04;-0,04;
01.02.2025;03:15;03:30;0,0;0,0;-0,34;-0,34;-0,39;-0,39;-0,43;-0,43;-0,51;-0,51;-0,02;-0,02;-0,03;-0,03;
01.02.2025;03:30;03:45;0,0;0,0;-0,15;-0,15;-0,32;-0,32;-0,51;-0,51;-0,51;-0,51;-0,01;-0,01;-0,04;-0,04;
01.02.2025;03:45;04:00;0,0;0,0;-0,03;-0,03;-0,4;-0,4;-0,48;-0,48;-0,5;-0,5;-0,01;-0,01;-0,04;-0,04;
01.02.2025;04:00;04:15;0,0;0,0;-0,45;-0,45;-0,14;-0,14;-0,72;-0,72;-0,52;-0,52;-0,02;-0,02;-0,07;-0,07;
01.02.2025;04:15;04:30;0,0;0,0;-0,19;-0,19;-0,07;-0,07;-0,87;-0,87;-0,49;-0,49;0,0;0,0;-0,59;-0,59;
01.02.2025;04:30;04:45;0,0;0,0;-0,21;-0,21;-0,11;-0,11;-0,62;-0,62;-0,51;-0,51;-0,02;-0,02;-0,48;-0,48;
01.02.2025;04:45;05:00;0,0;0,0;-0,34;-0,34;-0,37;-0,37;-0,61;-0,61;-0,52;-0,52;-0,01;-0,01;-0,05;-0,05;
01.02.2025;05:00;05:15;0,0;0,0;-0,35;-0,35;-0,38;-0,38;-0,61;-0,61;-0,51;-0,51;-0,01;-0,01;-0,04;-0,04;
01.02.2025;05:15;05:30;0,0;0,0;-0,02;-0,02;-0,39;-0,39;-0,62;-0,62;-0,51;-0,51;-0,39;-0,39;-0,05;-0,05;
01.02.2025;05:30;05:45;0,0;0,0;-0,18;-0,18;-0,32;-0,32;-0,84;-0,84;-0,19;-0,19;-0,08;-0,08;-0,04;-0,04;
01.02.2025;05:45;06:00;0,0;0,0;-0,44;-0,44;-0,74;-0,74;-0,24;-0,24;-0,14;-0,14;-0,01;-0,01;-0,05;-0,05;
01.02.2025;06:00;06:15;0,0;0,0;-0,15;-0,15;-0,47;-0,47;-0,12;-0,12;-0,14;-0,14;-0,01;-0,01;-0,03;-0,03;
01.02.2025;06:15;06:30;0,0;0,0;-0,33;-0,33;-0,07;-0,07;-0,13;-0,13;-0,7;-0,7;-0,01;-0,01;-0,59;-0,59;
01.02.2025;06:30;06:45;0,0;0,0;-0,34;-0,34;-0,07;-0,07;-0,12;-0,12;-1,3;-1,3;-0,02;-0,02;-1,49;-1,49;
`,
        "TESTING DUMMY",
    );
    refreshView();
}

// mock();
