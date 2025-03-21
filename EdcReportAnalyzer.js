/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
/* eslint-disable no-lone-blocks */
function last(container) {
    return container[container.length - 1];
}
function assert(condition, ...loggingArgs) {
    if (!condition) {
        const errorMsg = `Assert failed: ${loggingArgs.toString()}`;
        console.error("Assert failed", ...loggingArgs);
        debugger;
        alert(errorMsg);
        throw new Error(errorMsg);
    }
}
const warningDom = document.getElementById("warnings");
const fileDom = document.getElementById("uploadCsv");
const filterDom = document.getElementById("filterSlider");
const gSettings = {
    displayUnit: "kWh",
    hideEans: false,
    filterValue: 0,
};
function logWarning(warning, date) {
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
function parseKwh(input) {
    if (input.length === 0) {
        return 0.0;
    }
    const adj = input.replace(",", ".");
    const result = parseFloat(adj);
    assert(!isNaN(result));
    return result;
}
function printKWh(input, alwaysKwh = false) {
    if (gSettings.displayUnit === "kW" && !alwaysKwh) {
        return `${(input * 4).toFixed(2)}&nbsp;kW`;
    }
    else {
        return `${input.toFixed(2)}&nbsp;kWh`;
    }
}
function getDate(explodedLine) {
    assert(explodedLine.length > 3, `Cannot extract date - whole line is: "${explodedLine.join(";")}"`);
    const [day, month, year] = explodedLine[0].split(".");
    const [hour, minute] = explodedLine[1].split(":");
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), parseInt(hour, 10), parseInt(minute, 10));
}
function printEan(input) {
    assert(input.length === 18);
    // input = input.replace("859182400", "…"); // Does not look good...
    if (gSettings.hideEans) {
        input = `859182400xxxxxxx${input.substring(16)}`;
        assert(input.length === 18);
    }
    return input;
}
class Csv {
    distributionEans = [];
    consumerEans = [];
    filename;
    dateFrom;
    dateTo;
    sharedTotal = 0;
    missedTotal = 0;
    intervals = [];
    constructor(filename, intervals) {
        this.filename = filename;
        this.intervals = intervals;
        this.dateFrom = intervals[0].start;
        this.dateTo = last(intervals).start;
    }
}
class Ean {
    name;
    csvIndex;
    originalBalance = 0;
    adjustedBalance = 0;
    maximumOriginal = 0;
    missedDueToAllocation = 0;
    constructor(name, csvIndex) {
        this.name = name;
        this.csvIndex = csvIndex;
    }
}
// eslint-disable-next-line complexity
function parseCsv(csv, filename) {
    csv = csv.replaceAll("\r\n", "\n");
    const lines = csv.split("\n");
    assert(lines.length > 0, "CSV file is empty");
    const header = lines[0].split(";");
    assert(header.length > 3, `CSV file has invalid header - less than 3 elements. Is there an extra empty line? The entire line is "${lines[0]}"`);
    assert(header[0] === "Datum" && header[1] === "Cas od" && header[2] === "Cas do");
    assert(header.length % 2 === 1);
    const distributorEans = [];
    const consumerEans = [];
    for (let i = 3; i < header.length; i += 2) {
        const before = header[i].trim();
        const after = header[i + 1].trim();
        assert(before.substring(2) === after.substring(3), "Mismatched IN- and OUT-", before, after);
        const isDistribution = before.endsWith("-D");
        const eanNumber = before.substring(3, before.length - 2);
        if (isDistribution) {
            distributorEans.push(new Ean(eanNumber, i));
        }
        else {
            assert(before.endsWith("-O"), before);
            consumerEans.push(new Ean(eanNumber, i));
        }
        assert(before.startsWith("IN-") && after.startsWith("OUT-"), before, after);
    }
    // Maps from time to missing sharing for that time slot
    const missedSharingDueToAllocationTimeSlots = new Map();
    const intervals = [];
    for (let i = 1; i < lines.length; ++i) {
        if (lines[i].trim().length === 0) {
            continue;
        }
        const explodedLine = lines[i].split(";");
        const expectedLength = 3 + (consumerEans.length + distributorEans.length) * 2;
        // In some reports there is an empty field at the end of the line
        assert(explodedLine.length === expectedLength ||
            (explodedLine.length === expectedLength + 1 && last(explodedLine) === ""), `Wrong number of items: ${explodedLine.length}, expected: ${expectedLength}, line number: ${i}. Last item on line is "${last(explodedLine)}"`);
        const date = getDate(explodedLine);
        const distributed = [];
        const consumed = [];
        const errors = [];
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
                assert(fixDistributors <= 1 && fixDistributors >= 0 && !isNaN(fixDistributors), sumSharedConsumed, sumSharedDistributed);
                for (const j of distributed) {
                    j.after *= fixDistributors;
                }
            }
            else {
                const fixConsumers = sumSharedDistributed / sumSharedConsumed;
                console.log("Fixing consumers", fixConsumers);
                assert(fixConsumers <= 1 && fixConsumers >= 0 && !isNaN(fixConsumers), sumSharedDistributed, sumSharedConsumed);
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
    result.sharedTotal = distributorEans.reduce((acc, val) => acc + val.originalBalance - val.adjustedBalance, 0);
    result.missedTotal = consumerEans.reduce((acc, val) => acc + val.missedDueToAllocation, 0);
    return result;
}
function colorizeRange(query, rgb) {
    const collection = document.querySelectorAll(query);
    // console.log(query);
    // console.log(collection);
    // let minimum = Infinity;
    let minimum = 0; // It works better with filtering if minimum is always 0
    let maximum = 0;
    for (const i of collection) {
        const value = parseFloat(i.innerText);
        maximum = Math.max(maximum, value);
        minimum = Math.min(minimum, value);
    }
    // console.log(minimum, maximum);
    assert(!isNaN(maximum), `There is a NaN when colorizing query${query}`);
    // console.log("Colorizing with maximum", maximum);
    for (const i of collection) {
        const htmlElement = i;
        const alpha = (parseFloat(htmlElement.innerText) - minimum) / Math.max(0.00001, maximum - minimum);
        // console.log(htmlElement);
        assert(!isNaN(alpha), "There is NaN somewhere in data", alpha);
        const cssString = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
        // console.log(cssString);
        htmlElement.style.backgroundColor = cssString;
    }
}
function recallEanAlias(ean) {
    return localStorage.getItem(`EAN_alias_${ean.name}`) ?? "";
}
function saveEanAlias(ean, alias) {
    localStorage.setItem(`EAN_alias_${ean.name}`, alias);
}
function setupHeader(table, csv, editableNames) {
    table.querySelector("th.distributionHeader").colSpan =
        csv.distributionEans.length;
    table.querySelector("th.consumerHeader").colSpan = csv.consumerEans.length;
    const theader = table.querySelector("tr.csvHeaderRow");
    assert(theader !== null);
    theader.innerHTML = "<th>EAN</th>";
    const createCell = (domClass, ean) => {
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
        }
        else {
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
function printOnlyDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function printDate(date) {
    return `${printOnlyDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function displayCsv(csv) {
    const startTime = performance.now();
    assert(gSettings.filterValue >= 0 && gSettings.filterValue <= 1);
    const GREEN = [14, 177, 14];
    const RED = [255, 35, 35];
    const GRAY = [150, 150, 150];
    {
        // Input data
        document.getElementById("filename").innerText = csv.filename;
        document.getElementById("intervalFrom").innerText = printDate(csv.dateFrom);
        document.getElementById("intervalTo").innerText = printDate(csv.dateTo);
    }
    {
        // Summary
        setupHeader(document.getElementById("csv"), csv, true);
        const tbody = document.getElementById("csvBody");
        assert(tbody !== null);
        tbody.innerHTML = "";
        let rowId = 0;
        const makeRow = (header, backgroundColor, printFn) => {
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
    const intervalBody = intervalTable.querySelector("tbody");
    intervalBody.innerHTML = "";
    // Intervals
    setupHeader(document.getElementById("intervals"), csv, false);
    let lastDisplayed = null;
    for (let intervalIndex = 0; intervalIndex < csv.intervals.length; ++intervalIndex) {
        const interval = csv.intervals[intervalIndex];
        if (intervalIndex !== csv.intervals.length - 1 &&
            interval.start.getDate() !== csv.intervals[intervalIndex + 1].start.getDate()) {
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
        const getBackground = (value, minimum, maximum) => {
            const alpha = (value - minimum) / Math.max(0.00001, maximum - minimum);
            return `rgba(${GREEN[0]}, ${GREEN[1]}, ${GREEN[2]}, ${alpha})`;
        };
        if (1) {
            // Speed optimization
            tr.innerHTML = `<th>${printDate(interval.start)} - ${String(interval.start.getHours()).padStart(2, "0")}:${String(interval.start.getMinutes() + 14).padStart(2, "0")}</th>
                            ${interval.distributions.map((i) => `<td class='distribution' style="background-color:${getBackground(i.before - i.after, minSharingDistributor, maxSharingDistributor)}">${printKWh(i.before - i.after)}</td>`).join("")}
                            <td class='split'></td>
                            ${interval.consumers.map((i) => `<td class='consumer' style="background-color:${getBackground(i.before - i.after, minSharingConsumer, maxSharingConsumer)}">${printKWh(i.before - i.after)}</td>`).join("")}`;
        }
        else {
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
    document.getElementById("minFilter").innerHTML = printKWh(minSharingInterval);
    document.getElementById("maxFilter").innerHTML = printKWh(maxSharingInterval);
    document.getElementById("thresholdFilter").innerHTML = printKWh(maxSharingInterval * gSettings.filterValue);
    // console.log("Colorizing table#intervals td.consumer");
    colorizeRange("table#intervals td.consumer", GREEN);
    // console.log("Colorizing table#intervals td.distribution");
    colorizeRange("table#intervals td.distribution", GREEN);
    console.log("displayCsv took", performance.now() - startTime, "ms");
}
let gCsv = null;
function refreshView() {
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
            gCsv = parseCsv(reader.result, fileDom.files[0].name);
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
document.getElementById("hideEans").addEventListener("change", () => {
    gSettings.hideEans = document.getElementById("hideEans").checked;
    refreshView();
});
document.querySelectorAll('input[name="unit"]').forEach((button) => {
    button.addEventListener("change", (e) => {
        gSettings.displayUnit = e.target.value;
        refreshView();
    });
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function mock() {
    // Testing data
    gCsv = parseCsv(`Datum;Cas od;Cas do;IN-859182400000000001-D;OUT-859182400000000001-D;IN-859182400000000002-O;OUT-859182400000000002-O;IN-859182400000000003-O;OUT-859182400000000003-O;IN-859182400000000004-O;OUT-859182400000000004-O;IN-859182400000000005-O;OUT-859182400000000005-O;IN-859182400000000006-O;OUT-859182400000000006-O;IN-859182400000000007-O;OUT-859182400000000007-O
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
`, "TESTING DUMMY");
    refreshView();
}
mock();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRWRjUmVwb3J0QW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFZGNSZXBvcnRBbmFseXplci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSx5RUFBeUU7QUFDekUsZ0VBQWdFO0FBQ2hFLG1DQUFtQztBQU1uQyxTQUFTLElBQUksQ0FBSSxTQUFjO0lBQzNCLE9BQU8sU0FBUyxDQUFDLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsTUFBTSxDQUFDLFNBQWtCLEVBQUUsR0FBRyxXQUFzQjtJQUN6RCxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDYixNQUFNLFFBQVEsR0FBRyxrQkFBa0IsV0FBVyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUM7UUFDNUQsT0FBTyxDQUFDLEtBQUssQ0FBQyxlQUFlLEVBQUUsR0FBRyxXQUFXLENBQUMsQ0FBQztRQUMvQyxRQUFRLENBQUM7UUFDVCxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM5QixDQUFDO0FBQ0wsQ0FBQztBQUVELE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsVUFBVSxDQUFtQixDQUFDO0FBQ3pFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsV0FBVyxDQUFxQixDQUFDO0FBQ3pFLE1BQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsY0FBYyxDQUFxQixDQUFDO0FBUTlFLE1BQU0sU0FBUyxHQUFhO0lBQ3hCLFdBQVcsRUFBRSxLQUFLO0lBQ2xCLFFBQVEsRUFBRSxLQUFLO0lBQ2YsV0FBVyxFQUFFLENBQUM7Q0FDakIsQ0FBQztBQUVGLFNBQVMsVUFBVSxDQUFDLE9BQWUsRUFBRSxJQUFVO0lBQzNDLFVBQVUsQ0FBQyxLQUFLLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztJQUNuQyxJQUFJLFVB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QztBQUNILFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFO0lBQy9ELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRTtRQUNwQyxTQUFTLENBQUMsV0FBVyxHQUFJLENBQUMsQ0FBQyxNQUEyQixDQUFDLEtBQXFCLENBQUM7UUFDN0UsV0FBVyxFQUFFLENBQUM7SUFDbEIsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQztBQUVILDZEQUE2RDtBQUM3RCxNQUFNLFVBQVUsSUFBSTtJQUNoQixlQUFlO0lBQ2YsSUFBSSxHQUFHLFFBQVEsQ0FDWDs7Ozs7Ozs7Ozs7OztDQWFQLEVBQ08sZUFBZSxDQUNsQixDQUFDO0lBQ0YsV0FBVyxFQUFFLENBQUM7QUFDbEIsQ0FBQztBQUVELElBQUksRUFBRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vbi1udWxsYWJsZS10eXBlLWFzc2VydGlvbi1zdHlsZSAqL1xyXG4vKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdW5zYWZlLXR5cGUtYXNzZXJ0aW9uICovXHJcbi8qIGVzbGludC1kaXNhYmxlIG5vLWxvbmUtYmxvY2tzICovXHJcblxyXG4vLyBUT0RPOiB0ZXN0IG11bHRpcGxlIGRpc3RyaWJ1dGlvbiBFQU5zXHJcblxyXG50eXBlIFJnYiA9IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcclxuXHJcbmZ1bmN0aW9uIGxhc3Q8VD4oY29udGFpbmVyOiBUW10pOiBUIHtcclxuICAgIHJldHVybiBjb250YWluZXJbY29udGFpbmVyLmxlbmd0aCAtIDFdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnQoY29uZGl0aW9uOiBib29sZWFuLCAuLi5sb2dnaW5nQXJnczogdW5rbm93bltdKTogYXNzZXJ0cyBjb25kaXRpb24ge1xyXG4gICAgaWYgKCFjb25kaXRpb24pIHtcclxuICAgICAgICBjb25zdCBlcnJvck1zZyA9IGBBc3NlcnQgZmFpbGVkOiAke2xvZ2dpbmdBcmdzLnRvU3RyaW5nKCl9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKFwiQXNzZXJ0IGZhaWxlZFwiLCAuLi5sb2dnaW5nQXJncyk7XHJcbiAgICAgICAgZGVidWdnZXI7XHJcbiAgICAgICAgYWxlcnQoZXJyb3JNc2cpO1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1zZyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmNvbnN0IHdhcm5pbmdEb20gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIndhcm5pbmdzXCIpIGFzIEhUTUxEaXZFbGVtZW50O1xyXG5jb25zdCBmaWxlRG9tID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ1cGxvYWRDc3ZcIikgYXMgSFRNTElucHV0RWxlbWVudDtcclxuY29uc3QgZmlsdGVyRG9tID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJmaWx0ZXJTbGlkZXJcIikgYXMgSFRNTElucHV0RWxlbWVudDtcclxuXHJcbmludGVyZmFjZSBTZXR0aW5ncyB7XHJcbiAgICBkaXNwbGF5VW5pdDogXCJrV2hcIiB8IFwia1dcIjtcclxuICAgIGhpZGVFYW5zOiBib29sZWFuO1xyXG4gICAgZmlsdGVyVmFsdWU6IG51bWJlcjtcclxufVxyXG5cclxuY29uc3QgZ1NldHRpbmdzOiBTZXR0aW5ncyA9IHtcclxuICAgIGRpc3BsYXlVbml0OiBcImtXaFwiLFxyXG4gICAgaGlkZUVhbnM6IGZhbHNlLFxyXG4gICAgZmlsdGVyVmFsdWU6IDAsXHJcbn07XHJcblxyXG5mdW5jdGlvbiBsb2dXYXJuaW5nKHdhcm5pbmc6IHN0cmluZywgZGF0ZTogRGF0ZSk6IHZvaWQge1xyXG4gICAgd2FybmluZ0RvbS5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xyXG4gICAgaWYgKHdhcm5pbmdEb20uY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgY29uc3QgZG9tID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xyXG4gICAgICAgIGRvbS5pbm5lclRleHQgPSBgSW5wdXQgZGF0YSBpcyBpbmNvbnNpc3RlbnQhIE9ubHkgXCJtb250aGx5IHJlcG9ydFwiIGlzIGd1YXJhbnRlZWQgdG8gYmUgY29ycmVjdCwgcHJlZmVyIHVzaW5nIHRoYXQuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICBUaGUgc2NyaXB0IHdpbGwgYXR0ZW1wdCB0byBmaXggc29tZSBlcnJvcnMsIGJ1dCB0aGUgcmVzdWx0IGlzIHN0aWxsIG9ubHkgYXBwcm94aW1hdGUuIEFsc28gbm90IGFsbCBlcnJvcnMgY2FuIGJlIGNhdWdodC5gO1xyXG4gICAgICAgIHdhcm5pbmdEb20uYXBwZW5kQ2hpbGQoZG9tKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGRvbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcclxuICAgIGRvbS5pbm5lclRleHQgPSBgWyR7cHJpbnREYXRlKGRhdGUpfV0gJHt3YXJuaW5nfWA7XHJcbiAgICB3YXJuaW5nRG9tLmFwcGVuZENoaWxkKGRvbSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhcnNlS3doKGlucHV0OiBzdHJpbmcpOiBudW1iZXIge1xyXG4gICAgaWYgKGlucHV0Lmxlbmd0aCA9PT0gMCkge1xyXG4gICAgICAgIHJldHVybiAwLjA7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhZGogPSBpbnB1dC5yZXBsYWNlKFwiLFwiLCBcIi5cIik7XHJcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZUZsb2F0KGFkaik7XHJcbiAgICBhc3NlcnQoIWlzTmFOKHJlc3VsdCkpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJpbnRLV2goaW5wdXQ6IG51bWJlciwgYWx3YXlzS3doID0gZmFsc2UpOiBzdHJpbmcge1xyXG4gICAgaWYgKGdTZXR0aW5ncy5kaXNwbGF5VW5pdCA9PT0gXCJrV1wiICYmICFhbHdheXNLd2gpIHtcclxuICAgICAgICByZXR1cm4gYCR7KGlucHV0ICogNCkudG9GaXhlZCgyKX0mbmJzcDtrV2A7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIHJldHVybiBgJHtpbnB1dC50b0ZpeGVkKDIpfSZuYnNwO2tXaGA7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdldERhdGUoZXhwbG9kZWRMaW5lOiBzdHJpbmdbXSk6IERhdGUge1xyXG4gICAgYXNzZXJ0KGV4cGxvZGVkTGluZS5sZW5ndGggPiAzLCBgQ2Fubm90IGV4dHJhY3QgZGF0ZSAtIHdob2xlIGxpbmUgaXM6IFwiJHtleHBsb2RlZExpbmUuam9pbihcIjtcIil9XCJgKTtcclxuICAgIGNvbnN0IFtkYXksIG1vbnRoLCB5ZWFyXSA9IGV4cGxvZGVkTGluZVswXS5zcGxpdChcIi5cIik7XHJcbiAgICBjb25zdCBbaG91ciwgbWludXRlXSA9IGV4cGxvZGVkTGluZVsxXS5zcGxpdChcIjpcIik7XHJcbiAgICByZXR1cm4gbmV3IERhdGUoXHJcbiAgICAgICAgcGFyc2VJbnQoeWVhciwgMTApLFxyXG4gICAgICAgIHBhcnNlSW50KG1vbnRoLCAxMCkgLSAxLFxyXG4gICAgICAgIHBhcnNlSW50KGRheSwgMTApLFxyXG4gICAgICAgIHBhcnNlSW50KGhvdXIsIDEwKSxcclxuICAgICAgICBwYXJzZUludChtaW51dGUsIDEwKSxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByaW50RWFuKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgYXNzZXJ0KGlucHV0Lmxlbmd0aCA9PT0gMTgpO1xyXG4gICAgLy8gaW5wdXQgPSBpbnB1dC5yZXBsYWNlKFwiODU5MTgyNDAwXCIsIFwi4oCmXCIpOyAvLyBEb2VzIG5vdCBsb29rIGdvb2QuLi5cclxuICAgIGlmIChnU2V0dGluZ3MuaGlkZUVhbnMpIHtcclxuICAgICAgICBpbnB1dCA9IGA4NTkxODI0MDB4eHh4eHh4JHtpbnB1dC5zdWJzdHJpbmcoMTYpfWA7XHJcbiAgICAgICAgYXNzZXJ0KGlucHV0Lmxlbmd0aCA9PT0gMTgpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGlucHV0O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgTWVhc3VyZW1lbnQge1xyXG4gICAgYmVmb3JlOiBudW1iZXI7XHJcbiAgICBhZnRlcjogbnVtYmVyO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgSW50ZXJ2YWwge1xyXG4gICAgc3RhcnQ6IERhdGU7XHJcblxyXG4gICAgc3VtU2hhcmluZzogbnVtYmVyO1xyXG5cclxuICAgIGRpc3RyaWJ1dGlvbnM6IE1lYXN1cmVtZW50W107XHJcbiAgICBjb25zdW1lcnM6IE1lYXN1cmVtZW50W107XHJcblxyXG4gICAgZXJyb3JzOiBzdHJpbmdbXVxyXG59XHJcblxyXG5jbGFzcyBDc3Yge1xyXG4gICAgZGlzdHJpYnV0aW9uRWFuczogRWFuW10gPSBbXTtcclxuICAgIGNvbnN1bWVyRWFuczogRWFuW10gPSBbXTtcclxuXHJcbiAgICBmaWxlbmFtZTogc3RyaW5nO1xyXG4gICAgZGF0ZUZyb206IERhdGU7XHJcbiAgICBkYXRlVG86IERhdGU7XHJcblxyXG4gICAgc2hhcmVkVG90YWwgPSAwO1xyXG4gICAgbWlzc2VkVG90YWwgPSAwO1xyXG5cclxuICAgIGludGVydmFsczogSW50ZXJ2YWxbXSA9IFtdO1xyXG5cclxuICAgIGNvbnN0cnVjdG9yKGZpbGVuYW1lOiBzdHJpbmcsIGludGVydmFsczogSW50ZXJ2YWxbXSkge1xyXG4gICAgICAgIHRoaXMuZmlsZW5hbWUgPSBmaWxlbmFtZTtcclxuICAgICAgICB0aGlzLmludGVydmFscyA9IGludGVydmFscztcclxuICAgICAgICB0aGlzLmRhdGVGcm9tID0gaW50ZXJ2YWxzWzBdLnN0YXJ0O1xyXG4gICAgICAgIHRoaXMuZGF0ZVRvID0gbGFzdChpbnRlcnZhbHMpLnN0YXJ0O1xyXG4gICAgfVxyXG59XHJcblxyXG5jbGFzcyBFYW4ge1xyXG4gICAgbmFtZTogc3RyaW5nO1xyXG4gICAgY3N2SW5kZXg6IG51bWJlcjtcclxuICAgIG9yaWdpbmFsQmFsYW5jZSA9IDA7XHJcbiAgICBhZGp1c3RlZEJhbGFuY2UgPSAwO1xyXG4gICAgbWF4aW11bU9yaWdpbmFsID0gMDtcclxuICAgIG1pc3NlZER1ZVRvQWxsb2NhdGlvbiA9IDA7XHJcbiAgICBjb25zdHJ1Y3RvcihuYW1lOiBzdHJpbmcsIGNzdkluZGV4OiBudW1iZXIpIHtcclxuICAgICAgICB0aGlzLm5hbWUgPSBuYW1lO1xyXG4gICAgICAgIHRoaXMuY3N2SW5kZXggPSBjc3ZJbmRleDtcclxuICAgIH1cclxufVxyXG5cclxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGNvbXBsZXhpdHlcclxuZnVuY3Rpb24gcGFyc2VDc3YoY3N2OiBzdHJpbmcsIGZpbGVuYW1lOiBzdHJpbmcpOiBDc3Yge1xyXG4gICAgY3N2ID0gY3N2LnJlcGxhY2VBbGwoXCJcXHJcXG5cIiwgXCJcXG5cIik7XHJcbiAgICBjb25zdCBsaW5lcyA9IGNzdi5zcGxpdChcIlxcblwiKTtcclxuICAgIGFzc2VydChsaW5lcy5sZW5ndGggPiAwLCBcIkNTViBmaWxlIGlzIGVtcHR5XCIpO1xyXG4gICAgY29uc3QgaGVhZGVyID0gbGluZXNbMF0uc3BsaXQoXCI7XCIpO1xyXG4gICAgYXNzZXJ0KFxyXG4gICAgICAgIGhlYWRlci5sZW5ndGggPiAzLFxyXG4gICAgICAgIGBDU1YgZmlsZSBoYXMgaW52YWxpZCBoZWFkZXIgLSBsZXNzIHRoYW4gMyBlbGVtZW50cy4gSXMgdGhlcmUgYW4gZXh0cmEgZW1wdHkgbGluZT8gVGhlIGVudGlyZSBsaW5lIGlzIFwiJHtsaW5lc1swXX1cImAsXHJcbiAgICApO1xyXG4gICAgYXNzZXJ0KGhlYWRlclswXSA9PT0gXCJEYXR1bVwiICYmIGhlYWRlclsxXSA9PT0gXCJDYXMgb2RcIiAmJiBoZWFkZXJbMl0gPT09IFwiQ2FzIGRvXCIpO1xyXG4gICAgYXNzZXJ0KGhlYWRlci5sZW5ndGggJSAyID09PSAxKTtcclxuXHJcbiAgICBjb25zdCBkaXN0cmlidXRvckVhbnM6IEVhbltdID0gW107XHJcbiAgICBjb25zdCBjb25zdW1lckVhbnM6IEVhbltdID0gW107XHJcblxyXG4gICAgZm9yIChsZXQgaSA9IDM7IGkgPCBoZWFkZXIubGVuZ3RoOyBpICs9IDIpIHtcclxuICAgICAgICBjb25zdCBiZWZvcmUgPSBoZWFkZXJbaV0udHJpbSgpO1xyXG4gICAgICAgIGNvbnN0IGFmdGVyID0gaGVhZGVyW2kgKyAxXS50cmltKCk7XHJcbiAgICAgICAgYXNzZXJ0KGJlZm9yZS5zdWJzdHJpbmcoMikgPT09IGFmdGVyLnN1YnN0cmluZygzKSwgXCJNaXNtYXRjaGVkIElOLSBhbmQgT1VULVwiLCBiZWZvcmUsIGFmdGVyKTtcclxuXHJcbiAgICAgICAgY29uc3QgaXNEaXN0cmlidXRpb24gPSBiZWZvcmUuZW5kc1dpdGgoXCItRFwiKTtcclxuICAgICAgICBjb25zdCBlYW5OdW1iZXIgPSBiZWZvcmUuc3Vic3RyaW5nKDMsIGJlZm9yZS5sZW5ndGggLSAyKTtcclxuICAgICAgICBpZiAoaXNEaXN0cmlidXRpb24pIHtcclxuICAgICAgICAgICAgZGlzdHJpYnV0b3JFYW5zLnB1c2gobmV3IEVhbihlYW5OdW1iZXIsIGkpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBhc3NlcnQoYmVmb3JlLmVuZHNXaXRoKFwiLU9cIiksIGJlZm9yZSk7XHJcbiAgICAgICAgICAgIGNvbnN1bWVyRWFucy5wdXNoKG5ldyBFYW4oZWFuTnVtYmVyLCBpKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFzc2VydChiZWZvcmUuc3RhcnRzV2l0aChcIklOLVwiKSAmJiBhZnRlci5zdGFydHNXaXRoKFwiT1VULVwiKSwgYmVmb3JlLCBhZnRlcik7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gTWFwcyBmcm9tIHRpbWUgdG8gbWlzc2luZyBzaGFyaW5nIGZvciB0aGF0IHRpbWUgc2xvdFxyXG4gICAgY29uc3QgbWlzc2VkU2hhcmluZ0R1ZVRvQWxsb2NhdGlvblRpbWVTbG90cyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXI+KCk7XHJcbiAgICBjb25zdCBpbnRlcnZhbHMgPSBbXSBhcyBJbnRlcnZhbFtdO1xyXG5cclxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbGluZXMubGVuZ3RoOyArK2kpIHtcclxuICAgICAgICBpZiAobGluZXNbaV0udHJpbSgpLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZXhwbG9kZWRMaW5lID0gbGluZXNbaV0uc3BsaXQoXCI7XCIpO1xyXG5cclxuICAgICAgICBjb25zdCBleHBlY3RlZExlbmd0aCA9IDMgKyAoY29uc3VtZXJFYW5zLmxlbmd0aCArIGRpc3RyaWJ1dG9yRWFucy5sZW5ndGgpICogMjtcclxuICAgICAgICAvLyBJbiBzb21lIHJlcG9ydHMgdGhlcmUgaXMgYW4gZW1wdHkgZmllbGQgYXQgdGhlIGVuZCBvZiB0aGUgbGluZVxyXG4gICAgICAgIGFzc2VydChcclxuICAgICAgICAgICAgZXhwbG9kZWRMaW5lLmxlbmd0aCA9PT0gZXhwZWN0ZWRMZW5ndGggfHxcclxuICAgICAgICAgICAgICAgIChleHBsb2RlZExpbmUubGVuZ3RoID09PSBleHBlY3RlZExlbmd0aCArIDEgJiYgbGFzdChleHBsb2RlZExpbmUpID09PSBcIlwiKSxcclxuICAgICAgICAgICAgYFdyb25nIG51bWJlciBvZiBpdGVtczogJHtleHBsb2RlZExpbmUubGVuZ3RofSwgZXhwZWN0ZWQ6ICR7ZXhwZWN0ZWRMZW5ndGh9LCBsaW5lIG51bWJlcjogJHtpfS4gTGFzdCBpdGVtIG9uIGxpbmUgaXMgXCIke2xhc3QoZXhwbG9kZWRMaW5lKX1cImAsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBkYXRlID0gZ2V0RGF0ZShleHBsb2RlZExpbmUpO1xyXG5cclxuICAgICAgICBjb25zdCBkaXN0cmlidXRlZDogTWVhc3VyZW1lbnRbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IGNvbnN1bWVkOiBNZWFzdXJlbWVudFtdID0gW107XHJcblxyXG4gICAgICAgIGNvbnN0IGVycm9ycyA9IFtdIGFzIHN0cmluZ1tdO1xyXG5cclxuICAgICAgICBmb3IgKGNvbnN0IGVhbiBvZiBkaXN0cmlidXRvckVhbnMpIHtcclxuICAgICAgICAgICAgbGV0IGJlZm9yZSA9IHBhcnNlS3doKGV4cGxvZGVkTGluZVtlYW4uY3N2SW5kZXhdKTtcclxuICAgICAgICAgICAgbGV0IGFmdGVyID0gcGFyc2VLd2goZXhwbG9kZWRMaW5lW2Vhbi5jc3ZJbmRleCArIDFdKTtcclxuICAgICAgICAgICAgaWYgKGFmdGVyID4gYmVmb3JlKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBlcnJvciA9IGBEaXN0cmlidXRpb24gRUFOICR7ZWFuLm5hbWV9IGlzIGRpc3RyaWJ1dGluZyAke2FmdGVyIC0gYmVmb3JlfSBrV2ggbW9yZSBBRlRFUiBzdWJ0cmFjdGluZyBzaGFyaW5nLiBUaGUgcmVwb3J0IHdpbGwgY2xpcCBzaGFyaW5nIHRvIDAuYDtcclxuICAgICAgICAgICAgICAgIGxvZ1dhcm5pbmcoZXJyb3IsIGRhdGUpO1xyXG4gICAgICAgICAgICAgICAgZXJyb3JzLnB1c2goZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgYWZ0ZXIgPSBiZWZvcmU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGJlZm9yZSA8IDAgfHwgYWZ0ZXIgPCAwKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBlcnJvciA9IGBEaXN0cmlidXRpb24gRUFOICR7ZWFuLm5hbWV9IGlzIGNvbnN1bWluZyAke2JlZm9yZSAvIGFmdGVyfSBrV2ggcG93ZXIuIFRoZSByZXBvcnQgd2lsbCBjbGlwIG5lZ2F0aXZlIHZhbHVlcyB0byAwLmA7XHJcbiAgICAgICAgICAgICAgICBsb2dXYXJuaW5nKGVycm9yLCBkYXRlKTtcclxuICAgICAgICAgICAgICAgIGVycm9ycy5wdXNoKGVycm9yKTtcclxuICAgICAgICAgICAgICAgIGJlZm9yZSA9IE1hdGgubWF4KDAsIGJlZm9yZSk7XHJcbiAgICAgICAgICAgICAgICBhZnRlciA9IE1hdGgubWF4KDAsIGFmdGVyKTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgZWFuLm9yaWdpbmFsQmFsYW5jZSArPSBiZWZvcmU7XHJcbiAgICAgICAgICAgIGVhbi5hZGp1c3RlZEJhbGFuY2UgKz0gYWZ0ZXI7XHJcbiAgICAgICAgICAgIGVhbi5tYXhpbXVtT3JpZ2luYWwgPSBNYXRoLm1heChlYW4ubWF4aW11bU9yaWdpbmFsLCBiZWZvcmUpO1xyXG4gICAgICAgICAgICBkaXN0cmlidXRlZC5wdXNoKHsgYmVmb3JlLCBhZnRlciB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBlYW4gb2YgY29uc3VtZXJFYW5zKSB7XHJcbiAgICAgICAgICAgIGxldCBiZWZvcmUgPSAtcGFyc2VLd2goZXhwbG9kZWRMaW5lW2Vhbi5jc3ZJbmRleF0pO1xyXG4gICAgICAgICAgICBsZXQgYWZ0ZXIgPSAtcGFyc2VLd2goZXhwbG9kZWRMaW5lW2Vhbi5jc3ZJbmRleCArIDFdKTtcclxuICAgICAgICAgICAgaWYgKGFmdGVyID4gYmVmb3JlKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBlcnJvciA9IGBDb25zdW1lciBFQU4gJHtlYW4ubmFtZX0gaXMgY29uc3VtaW5nICR7YWZ0ZXIgLSBiZWZvcmV9IGtXaCBtb3JlIEFGVEVSIHN1YnRyYWN0aW5nIHNoYXJpbmcuIFRoZSByZXBvcnQgd2lsbCBjbGlwIHNoYXJpbmcgdG8gMC5gO1xyXG4gICAgICAgICAgICAgICAgbG9nV2FybmluZyhlcnJvciwgZGF0ZSk7XHJcbiAgICAgICAgICAgICAgICBlcnJvcnMucHVzaChlcnJvcik7XHJcbiAgICAgICAgICAgICAgICBhZnRlciA9IGJlZm9yZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoYmVmb3JlIDwgMCB8fCBhZnRlciA8IDApIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGVycm9yID0gYENvbnN1bWVyIEVBTiAke2Vhbi5uYW1lfSBpcyBkaXN0cmlidXRpbmcgJHtiZWZvcmUgLyBhZnRlcn0ga1doIHBvd2VyLiBUaGUgcmVwb3J0IHdpbGwgY2xpcCBuZWdhdGl2ZSB2YWx1ZXMgdG8gMC5gO1xyXG4gICAgICAgICAgICAgICAgbG9nV2FybmluZyhlcnJvciwgZGF0ZSk7XHJcbiAgICAgICAgICAgICAgICBlcnJvcnMucHVzaChlcnJvcik7XHJcbiAgICAgICAgICAgICAgICBiZWZvcmUgPSBNYXRoLm1heCgwLCBiZWZvcmUpO1xyXG4gICAgICAgICAgICAgICAgYWZ0ZXIgPSBNYXRoLm1heCgwLCBhZnRlcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWFuLm9yaWdpbmFsQmFsYW5jZSArPSBiZWZvcmU7XHJcbiAgICAgICAgICAgIGVhbi5hZGp1c3RlZEJhbGFuY2UgKz0gYWZ0ZXI7XHJcbiAgICAgICAgICAgIGVhbi5tYXhpbXVtT3JpZ2luYWwgPSBNYXRoLm1heChlYW4ubWF4aW11bU9yaWdpbmFsLCBiZWZvcmUpO1xyXG4gICAgICAgICAgICBjb25zdW1lZC5wdXNoKHsgYmVmb3JlLCBhZnRlciB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIElmIHRoZXJlIGlzIHN0aWxsIHNvbWUgcG93ZXIgbGVmdCBhZnRlciBzaGFyaW5nLCB3ZSBjaGVjayB0aGF0IGFsbCBjb25zdW1lcnMgaGF2ZSAwIGFkanVzdGVkIHBvd2VyLlxyXG4gICAgICAgIC8vIElmIHRoZXJlIHdhcyBzb21lIGNvbnN1bWVyIGxlZnQgd2l0aCBub24temVybyBwb3dlciwgaXQgbWVhbnMgdGhlcmUgd2FzIGVuZXJneSB0aGF0IGNvdWxkIGhhdmUgYmVlblxyXG4gICAgICAgIC8vIHNoYXJlZCwgYnV0IHdhc24ndCBkdWUgdG8gYmFkIGFsbG9jYXRpb24uXHJcbiAgICAgICAgY29uc3Qgc3VtRGlzdHJpYnV0b3JzQWZ0ZXIgPSBkaXN0cmlidXRlZC5yZWR1Y2UoKGFjYywgdmFsKSA9PiBhY2MgKyB2YWwuYWZ0ZXIsIDApO1xyXG4gICAgICAgIGlmIChzdW1EaXN0cmlidXRvcnNBZnRlciA+IDApIHtcclxuICAgICAgICAgICAgbGV0IHN1bUNvbnN1bWVyc0FmdGVyID0gY29uc3VtZWQucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgdmFsLmFmdGVyLCAwKTtcclxuICAgICAgICAgICAgY29uc3QgbWlzc2VkU2NhbGUgPSBNYXRoLm1pbigxLjAsIHN1bURpc3RyaWJ1dG9yc0FmdGVyIC8gc3VtQ29uc3VtZXJzQWZ0ZXIpO1xyXG4gICAgICAgICAgICBhc3NlcnQobWlzc2VkU2NhbGUgPiAwICYmIG1pc3NlZFNjYWxlIDw9IDEsIG1pc3NlZFNjYWxlKTtcclxuICAgICAgICAgICAgc3VtQ29uc3VtZXJzQWZ0ZXIgPSBNYXRoLm1pbihzdW1Db25zdW1lcnNBZnRlciwgc3VtRGlzdHJpYnV0b3JzQWZ0ZXIpO1xyXG5cclxuICAgICAgICAgICAgLy8gVGhlcmUgYXJlIHBsZW50eSBvZiBpbnRlcnZhbHMgd2hlcmUgZGlzdHJpYnV0aW9uIGJlZm9yZSBhbmQgYWZ0ZXIgYXJlIGJvdGggMC4wMSBhbmQgbm8gc2hhcmluZ1xyXG4gICAgICAgICAgICAvLyBpcyBwZXJmb3JtZWQuLi46XHJcbiAgICAgICAgICAgIGlmIChzdW1Db25zdW1lcnNBZnRlciA+IDAuMCAmJiBzdW1EaXN0cmlidXRvcnNBZnRlciA+IDAuMCkge1xyXG4gICAgICAgICAgICAgICAgbWlzc2VkU2hhcmluZ0R1ZVRvQWxsb2NhdGlvblRpbWVTbG90cy5zZXQoZGF0ZS5nZXRUaW1lKCksIHN1bUNvbnN1bWVyc0FmdGVyKTtcclxuICAgICAgICAgICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgY29uc3VtZXJFYW5zLmxlbmd0aDsgKytqKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3VtZXJFYW5zW2pdLm1pc3NlZER1ZVRvQWxsb2NhdGlvbiArPSBjb25zdW1lZFtqXS5hZnRlciAqIG1pc3NlZFNjYWxlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHN1bVNoYXJlZERpc3RyaWJ1dGVkID0gZGlzdHJpYnV0ZWQucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgKHZhbC5iZWZvcmUgLSB2YWwuYWZ0ZXIpLCAwKTtcclxuICAgICAgICBhc3NlcnQoc3VtU2hhcmVkRGlzdHJpYnV0ZWQgPj0gMCwgc3VtU2hhcmVkRGlzdHJpYnV0ZWQsIFwiTGluZVwiLCBpKTtcclxuICAgICAgICBjb25zdCBzdW1TaGFyZWRDb25zdW1lZCA9IGNvbnN1bWVkLnJlZHVjZSgoYWNjLCB2YWwpID0+IGFjYyArICh2YWwuYmVmb3JlIC0gdmFsLmFmdGVyKSwgMCk7XHJcbiAgICAgICAgYXNzZXJ0KHN1bVNoYXJlZENvbnN1bWVkID49IDAsIHN1bVNoYXJlZENvbnN1bWVkLCBcIkxpbmVcIiwgaSk7XHJcbiAgICAgICAgaWYgKE1hdGguYWJzKHN1bVNoYXJlZERpc3RyaWJ1dGVkIC0gc3VtU2hhcmVkQ29uc3VtZWQpID4gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVycm9yID0gYEVuZXJneSBzaGFyZWQgZnJvbSBkaXN0cmlidXRvcnMgZG9lcyBub3QgbWF0Y2ggZW5lcmd5IHNoYXJlZCB0byBjb25zdW1lcnMhXFxuRGlzdHJpYnV0ZWQ6ICR7c3VtU2hhcmVkRGlzdHJpYnV0ZWR9XFxuQ29uc3VtZWQ6ICR7c3VtU2hhcmVkQ29uc3VtZWR9LlxyXG5UaGUgcmVwb3J0IHdpbGwgY29uc2lkZXIgdGhlIG1pc21hdGNoIG5vdCBzaGFyZWQuYDtcclxuICAgICAgICAgICAgbG9nV2FybmluZyhlcnJvciwgZGF0ZSk7XHJcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGVycm9yKTtcclxuICAgICAgICAgICAgaWYgKHN1bVNoYXJlZERpc3RyaWJ1dGVkID4gc3VtU2hhcmVkQ29uc3VtZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpeERpc3RyaWJ1dG9ycyA9IHN1bVNoYXJlZENvbnN1bWVkIC8gc3VtU2hhcmVkRGlzdHJpYnV0ZWQ7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhcIkZpeGluZyBkaXN0cmlidXRvcnNcIiwgZml4RGlzdHJpYnV0b3JzKTtcclxuICAgICAgICAgICAgICAgIGFzc2VydChcclxuICAgICAgICAgICAgICAgICAgICBmaXhEaXN0cmlidXRvcnMgPD0gMSAmJiBmaXhEaXN0cmlidXRvcnMgPj0gMCAmJiAhaXNOYU4oZml4RGlzdHJpYnV0b3JzKSxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWRDb25zdW1lZCxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWREaXN0cmlidXRlZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGogb2YgZGlzdHJpYnV0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBqLmFmdGVyICo9IGZpeERpc3RyaWJ1dG9ycztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpeENvbnN1bWVycyA9IHN1bVNoYXJlZERpc3RyaWJ1dGVkIC8gc3VtU2hhcmVkQ29uc3VtZWQ7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhcIkZpeGluZyBjb25zdW1lcnNcIiwgZml4Q29uc3VtZXJzKTtcclxuICAgICAgICAgICAgICAgIGFzc2VydChcclxuICAgICAgICAgICAgICAgICAgICBmaXhDb25zdW1lcnMgPD0gMSAmJiBmaXhDb25zdW1lcnMgPj0gMCAmJiAhaXNOYU4oZml4Q29uc3VtZXJzKSxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWREaXN0cmlidXRlZCxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWRDb25zdW1lZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGogb2YgY29uc3VtZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBqLmFmdGVyICo9IGZpeENvbnN1bWVycztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaW50ZXJ2YWxzLnB1c2goe1xyXG4gICAgICAgICAgICBzdGFydDogZGF0ZSxcclxuICAgICAgICAgICAgc3VtU2hhcmluZzogZGlzdHJpYnV0ZWQucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgKHZhbC5iZWZvcmUgLSB2YWwuYWZ0ZXIpLCAwKSxcclxuICAgICAgICAgICAgZGlzdHJpYnV0aW9uczogZGlzdHJpYnV0ZWQsXHJcbiAgICAgICAgICAgIGNvbnN1bWVyczogY29uc3VtZWQsXHJcbiAgICAgICAgICAgIGVycm9ycyxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgQ3N2KGZpbGVuYW1lLCBpbnRlcnZhbHMpO1xyXG5cclxuICAgIHJlc3VsdC5kaXN0cmlidXRpb25FYW5zID0gZGlzdHJpYnV0b3JFYW5zO1xyXG4gICAgcmVzdWx0LmNvbnN1bWVyRWFucyA9IGNvbnN1bWVyRWFucztcclxuXHJcbiAgICByZXN1bHQuc2hhcmVkVG90YWwgPSBkaXN0cmlidXRvckVhbnMucmVkdWNlKFxyXG4gICAgICAgIChhY2MsIHZhbCkgPT4gYWNjICsgdmFsLm9yaWdpbmFsQmFsYW5jZSAtIHZhbC5hZGp1c3RlZEJhbGFuY2UsXHJcbiAgICAgICAgMCxcclxuICAgICk7XHJcbiAgICByZXN1bHQubWlzc2VkVG90YWwgPSBjb25zdW1lckVhbnMucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgdmFsLm1pc3NlZER1ZVRvQWxsb2NhdGlvbiwgMCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2xvcml6ZVJhbmdlKHF1ZXJ5OiBzdHJpbmcsIHJnYjogUmdiKTogdm9pZCB7XHJcbiAgICBjb25zdCBjb2xsZWN0aW9uID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChxdWVyeSk7XHJcbiAgICAvLyBjb25zb2xlLmxvZyhxdWVyeSk7XHJcbiAgICAvLyBjb25zb2xlLmxvZyhjb2xsZWN0aW9uKTtcclxuICAgIC8vIGxldCBtaW5pbXVtID0gSW5maW5pdHk7XHJcbiAgICBsZXQgbWluaW11bSA9IDA7IC8vIEl0IHdvcmtzIGJldHRlciB3aXRoIGZpbHRlcmluZyBpZiBtaW5pbXVtIGlzIGFsd2F5cyAwXHJcbiAgICBsZXQgbWF4aW11bSA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IGkgb2YgY29sbGVjdGlvbikge1xyXG4gICAgICAgIGNvbnN0IHZhbHVlID0gcGFyc2VGbG9hdCgoaSBhcyBIVE1MRWxlbWVudCkuaW5uZXJUZXh0KTtcclxuICAgICAgICBtYXhpbXVtID0gTWF0aC5tYXgobWF4aW11bSwgdmFsdWUpO1xyXG4gICAgICAgIG1pbmltdW0gPSBNYXRoLm1pbihtaW5pbXVtLCB2YWx1ZSk7XHJcbiAgICB9XHJcbiAgICAvLyBjb25zb2xlLmxvZyhtaW5pbXVtLCBtYXhpbXVtKTtcclxuICAgIGFzc2VydCghaXNOYU4obWF4aW11bSksIGBUaGVyZSBpcyBhIE5hTiB3aGVuIGNvbG9yaXppbmcgcXVlcnkke3F1ZXJ5fWApO1xyXG4gICAgLy8gY29uc29sZS5sb2coXCJDb2xvcml6aW5nIHdpdGggbWF4aW11bVwiLCBtYXhpbXVtKTtcclxuICAgIGZvciAoY29uc3QgaSBvZiBjb2xsZWN0aW9uKSB7XHJcbiAgICAgICAgY29uc3QgaHRtbEVsZW1lbnQgPSBpIGFzIEhUTUxFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGFscGhhID0gKHBhcnNlRmxvYXQoaHRtbEVsZW1lbnQuaW5uZXJUZXh0KSAtIG1pbmltdW0pIC8gTWF0aC5tYXgoMC4wMDAwMSwgbWF4aW11bSAtIG1pbmltdW0pO1xyXG4gICAgICAgIC8vIGNvbnNvbGUubG9nKGh0bWxFbGVtZW50KTtcclxuICAgICAgICBhc3NlcnQoIWlzTmFOKGFscGhhKSwgXCJUaGVyZSBpcyBOYU4gc29tZXdoZXJlIGluIGRhdGFcIiwgYWxwaGEpO1xyXG4gICAgICAgIGNvbnN0IGNzc1N0cmluZyA9IGByZ2JhKCR7cmdiWzBdfSwgJHtyZ2JbMV19LCAke3JnYlsyXX0sICR7YWxwaGF9KWA7XHJcbiAgICAgICAgLy8gY29uc29sZS5sb2coY3NzU3RyaW5nKTtcclxuICAgICAgICBodG1sRWxlbWVudC5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBjc3NTdHJpbmc7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlY2FsbEVhbkFsaWFzKGVhbjogRWFuKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShgRUFOX2FsaWFzXyR7ZWFuLm5hbWV9YCkgPz8gXCJcIjtcclxufVxyXG5mdW5jdGlvbiBzYXZlRWFuQWxpYXMoZWFuOiBFYW4sIGFsaWFzOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGBFQU5fYWxpYXNfJHtlYW4ubmFtZX1gLCBhbGlhcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldHVwSGVhZGVyKHRhYmxlOiBIVE1MVGFibGVFbGVtZW50LCBjc3Y6IENzdiwgZWRpdGFibGVOYW1lczogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgKHRhYmxlLnF1ZXJ5U2VsZWN0b3IoXCJ0aC5kaXN0cmlidXRpb25IZWFkZXJcIikgYXMgSFRNTFRhYmxlQ2VsbEVsZW1lbnQpLmNvbFNwYW4gPVxyXG4gICAgICAgIGNzdi5kaXN0cmlidXRpb25FYW5zLmxlbmd0aDtcclxuICAgICh0YWJsZS5xdWVyeVNlbGVjdG9yKFwidGguY29uc3VtZXJIZWFkZXJcIikgYXMgSFRNTFRhYmxlQ2VsbEVsZW1lbnQpLmNvbFNwYW4gPSBjc3YuY29uc3VtZXJFYW5zLmxlbmd0aDtcclxuXHJcbiAgICBjb25zdCB0aGVhZGVyID0gdGFibGUucXVlcnlTZWxlY3RvcihcInRyLmNzdkhlYWRlclJvd1wiKSBhcyBIVE1MVGFibGVSb3dFbGVtZW50O1xyXG4gICAgYXNzZXJ0KHRoZWFkZXIgIT09IG51bGwpO1xyXG4gICAgdGhlYWRlci5pbm5lckhUTUwgPSBcIjx0aD5FQU48L3RoPlwiO1xyXG5cclxuICAgIGNvbnN0IGNyZWF0ZUNlbGwgPSAoZG9tQ2xhc3M6IHN0cmluZywgZWFuOiBFYW4pOiB2b2lkID0+IHtcclxuICAgICAgICBjb25zdCB0aCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ0aFwiKTtcclxuICAgICAgICB0aC5jbGFzc0xpc3QuYWRkKGRvbUNsYXNzKTtcclxuICAgICAgICB0aC5pbm5lclRleHQgPSBwcmludEVhbihlYW4ubmFtZSk7XHJcbiAgICAgICAgaWYgKGVkaXRhYmxlTmFtZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW5wdXRcIik7XHJcbiAgICAgICAgICAgIGlucHV0LnR5cGUgPSBcInRleHRcIjtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZWNhbGxFYW5BbGlhcyhlYW4pO1xyXG4gICAgICAgICAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcclxuICAgICAgICAgICAgICAgIHNhdmVFYW5BbGlhcyhlYW4sIGlucHV0LnZhbHVlKTtcclxuICAgICAgICAgICAgICAgIHJlZnJlc2hWaWV3KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB0aC5hcHBlbmRDaGlsZChpbnB1dCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgcmVjYWxsZWQgPSByZWNhbGxFYW5BbGlhcyhlYW4pO1xyXG4gICAgICAgICAgICBpZiAocmVjYWxsZWQubGVuZ3RoID4gMCkge1xyXG4gICAgICAgICAgICAgICAgdGguaW5uZXJIVE1MICs9IGA8YnI+KCR7cmVjYWxsZWR9KWA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgdGhlYWRlci5hcHBlbmRDaGlsZCh0aCk7XHJcbiAgICB9O1xyXG5cclxuICAgIGZvciAoY29uc3QgZWFuIG9mIGNzdi5kaXN0cmlidXRpb25FYW5zKSB7XHJcbiAgICAgICAgY3JlYXRlQ2VsbChcImRpc3RyaWJ1dGlvblwiLCBlYW4pO1xyXG4gICAgfVxyXG4gICAgdGhlYWRlci5pbnNlcnRDZWxsKCkuY2xhc3NMaXN0LmFkZChcInNwbGl0XCIpO1xyXG4gICAgZm9yIChjb25zdCBlYW4gb2YgY3N2LmNvbnN1bWVyRWFucykge1xyXG4gICAgICAgIGNyZWF0ZUNlbGwoXCJjb25zdW1lclwiLCBlYW4pO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBwcmludE9ubHlEYXRlKGRhdGU6IERhdGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGAke2RhdGUuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZGF0ZS5nZXRNb250aCgpICsgMSkucGFkU3RhcnQoMiwgXCIwXCIpfS0ke1N0cmluZyhkYXRlLmdldERhdGUoKSkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XHJcbn1cclxuZnVuY3Rpb24gcHJpbnREYXRlKGRhdGU6IERhdGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGAke3ByaW50T25seURhdGUoZGF0ZSl9ICR7U3RyaW5nKGRhdGUuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgXCIwXCIpfToke1N0cmluZyhkYXRlLmdldE1pbnV0ZXMoKSkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRpc3BsYXlDc3YoY3N2OiBDc3YpOiB2b2lkIHtcclxuICAgIGNvbnN0IHN0YXJ0VGltZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xyXG4gICAgYXNzZXJ0KGdTZXR0aW5ncy5maWx0ZXJWYWx1ZSA+PSAwICYmIGdTZXR0aW5ncy5maWx0ZXJWYWx1ZSA8PSAxKTtcclxuICAgIGNvbnN0IEdSRUVOID0gWzE0LCAxNzcsIDE0XSBhcyBSZ2I7XHJcbiAgICBjb25zdCBSRUQgPSBbMjU1LCAzNSwgMzVdIGFzIFJnYjtcclxuICAgIGNvbnN0IEdSQVkgPSBbMTUwLCAxNTAsIDE1MF0gYXMgUmdiO1xyXG5cclxuICAgIHtcclxuICAgICAgICAvLyBJbnB1dCBkYXRhXHJcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJmaWxlbmFtZVwiKSEuaW5uZXJUZXh0ID0gY3N2LmZpbGVuYW1lO1xyXG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiaW50ZXJ2YWxGcm9tXCIpIS5pbm5lclRleHQgPSBwcmludERhdGUoY3N2LmRhdGVGcm9tKTtcclxuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImludGVydmFsVG9cIikhLmlubmVyVGV4dCA9IHByaW50RGF0ZShjc3YuZGF0ZVRvKTtcclxuICAgIH1cclxuXHJcbiAgICB7XHJcbiAgICAgICAgLy8gU3VtbWFyeVxyXG4gICAgICAgIHNldHVwSGVhZGVyKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY3N2XCIpIGFzIEhUTUxUYWJsZUVsZW1lbnQsIGNzdiwgdHJ1ZSk7XHJcbiAgICAgICAgY29uc3QgdGJvZHkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNzdkJvZHlcIik7XHJcbiAgICAgICAgYXNzZXJ0KHRib2R5ICE9PSBudWxsKTtcclxuICAgICAgICB0Ym9keS5pbm5lckhUTUwgPSBcIlwiO1xyXG5cclxuICAgICAgICBsZXQgcm93SWQgPSAwO1xyXG4gICAgICAgIGNvbnN0IG1ha2VSb3cgPSAoaGVhZGVyOiBzdHJpbmcsIGJhY2tncm91bmRDb2xvcjogUmdiLCBwcmludEZuOiAoZWFuOiBFYW4pID0+IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwidHJcIik7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gYHJvdyR7cm93SWQrK31gO1xyXG4gICAgICAgICAgICByb3cuY2xhc3NMaXN0LmFkZChpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHRoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRoXCIpO1xyXG4gICAgICAgICAgICByb3cuYXBwZW5kQ2hpbGQodGgpO1xyXG4gICAgICAgICAgICB0aC5pbm5lckhUTUwgPSBoZWFkZXI7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZWFuIG9mIGNzdi5kaXN0cmlidXRpb25FYW5zKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjZWxsID0gcm93Lmluc2VydENlbGwoKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuaW5uZXJIVE1MID0gcHJpbnRGbihlYW4pO1xyXG4gICAgICAgICAgICAgICAgY2VsbC5jbGFzc0xpc3QuYWRkKFwiZGlzdHJpYnV0aW9uXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJvdy5pbnNlcnRDZWxsKCkuY2xhc3NMaXN0LmFkZChcInNwbGl0XCIpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGVhbiBvZiBjc3YuY29uc3VtZXJFYW5zKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjZWxsID0gcm93Lmluc2VydENlbGwoKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuaW5uZXJIVE1MID0gcHJpbnRGbihlYW4pO1xyXG4gICAgICAgICAgICAgICAgY2VsbC5jbGFzc0xpc3QuYWRkKFwiY29uc3VtZXJcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdGJvZHkuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgICAgICAgICAgY29sb3JpemVSYW5nZShgdGFibGUjY3N2IHRyLiR7aWR9IHRkLmNvbnN1bWVyYCwgYmFja2dyb3VuZENvbG9yKTtcclxuICAgICAgICAgICAgY29sb3JpemVSYW5nZShgdGFibGUjY3N2IHRyLiR7aWR9IHRkLmRpc3RyaWJ1dGlvbmAsIGJhY2tncm91bmRDb2xvcik7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgbWFrZVJvdyhcIk9yaWdpbmFsIFtrV2hdOlwiLCBHUkFZLCAoZWFuKSA9PiBwcmludEtXaChlYW4ub3JpZ2luYWxCYWxhbmNlLCB0cnVlKSk7XHJcbiAgICAgICAgbWFrZVJvdyhcIkFkanVzdGVkIFtrV2hdOlwiLCBHUkFZLCAoZWFuKSA9PiBwcmludEtXaChlYW4uYWRqdXN0ZWRCYWxhbmNlLCB0cnVlKSk7XHJcbiAgICAgICAgbWFrZVJvdyhcIlNoYXJlZCBba1doXTpcIiwgR1JFRU4sIChlYW4pID0+IHByaW50S1doKGVhbi5vcmlnaW5hbEJhbGFuY2UgLSBlYW4uYWRqdXN0ZWRCYWxhbmNlLCB0cnVlKSk7XHJcbiAgICAgICAgbWFrZVJvdyhcIk1pc3NlZCBba1doXTpcIiwgUkVELCAoZWFuKSA9PiBwcmludEtXaChlYW4ubWlzc2VkRHVlVG9BbGxvY2F0aW9uLCB0cnVlKSk7XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IG1pblNoYXJpbmdEaXN0cmlidXRvciA9IEluZmluaXR5O1xyXG4gICAgbGV0IG1heFNoYXJpbmdEaXN0cmlidXRvciA9IDA7XHJcbiAgICBsZXQgbWluU2hhcmluZ0NvbnN1bWVyID0gSW5maW5pdHk7XHJcbiAgICBsZXQgbWF4U2hhcmluZ0NvbnN1bWVyID0gMDtcclxuICAgIGZvciAoY29uc3QgaW50ZXJ2YWwgb2YgY3N2LmludGVydmFscykge1xyXG4gICAgICAgIGZvciAoY29uc3QgaSBvZiBpbnRlcnZhbC5kaXN0cmlidXRpb25zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNoYXJpbmcgPSBpLmJlZm9yZSAtIGkuYWZ0ZXI7XHJcbiAgICAgICAgICAgIG1heFNoYXJpbmdEaXN0cmlidXRvciA9IE1hdGgubWF4KG1heFNoYXJpbmdEaXN0cmlidXRvciwgc2hhcmluZyk7XHJcbiAgICAgICAgICAgIG1pblNoYXJpbmdEaXN0cmlidXRvciA9IE1hdGgubWluKG1pblNoYXJpbmdEaXN0cmlidXRvciwgc2hhcmluZyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgaSBvZiBpbnRlcnZhbC5jb25zdW1lcnMpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2hhcmluZyA9IGkuYmVmb3JlIC0gaS5hZnRlcjtcclxuICAgICAgICAgICAgbWF4U2hhcmluZ0NvbnN1bWVyID0gTWF0aC5tYXgobWF4U2hhcmluZ0NvbnN1bWVyLCBzaGFyaW5nKTtcclxuICAgICAgICAgICAgbWluU2hhcmluZ0NvbnN1bWVyID0gTWF0aC5taW4obWluU2hhcmluZ0NvbnN1bWVyLCBzaGFyaW5nKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbWF4U2hhcmluZ0ludGVydmFsID0gY3N2LmludGVydmFscy5yZWR1Y2UoKGFjYywgdmFsKSA9PiBNYXRoLm1heChhY2MsIHZhbC5zdW1TaGFyaW5nKSwgMCk7XHJcbiAgICBjb25zdCBtaW5TaGFyaW5nSW50ZXJ2YWwgPSBjc3YuaW50ZXJ2YWxzLnJlZHVjZSgoYWNjLCB2YWwpID0+IE1hdGgubWluKGFjYywgdmFsLnN1bVNoYXJpbmcpLCBJbmZpbml0eSk7XHJcbiAgICBjb25zdCBpbnRlcnZhbFRhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJpbnRlcnZhbHNcIik7XHJcbiAgICBjb25zdCBpbnRlcnZhbEJvZHkgPSBpbnRlcnZhbFRhYmxlIS5xdWVyeVNlbGVjdG9yKFwidGJvZHlcIikhO1xyXG4gICAgaW50ZXJ2YWxCb2R5LmlubmVySFRNTCA9IFwiXCI7XHJcbiAgICAvLyBJbnRlcnZhbHNcclxuICAgIHNldHVwSGVhZGVyKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiaW50ZXJ2YWxzXCIpIGFzIEhUTUxUYWJsZUVsZW1lbnQsIGNzdiwgZmFsc2UpO1xyXG5cclxuICAgIGxldCBsYXN0RGlzcGxheWVkOiBudWxsIHwgSW50ZXJ2YWwgPSBudWxsO1xyXG5cclxuICAgIGZvciAobGV0IGludGVydmFsSW5kZXggPSAwOyBpbnRlcnZhbEluZGV4IDwgY3N2LmludGVydmFscy5sZW5ndGg7ICsraW50ZXJ2YWxJbmRleCkge1xyXG4gICAgICAgIGNvbnN0IGludGVydmFsID0gY3N2LmludGVydmFsc1tpbnRlcnZhbEluZGV4XTtcclxuXHJcbiAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICBpbnRlcnZhbEluZGV4ICE9PSBjc3YuaW50ZXJ2YWxzLmxlbmd0aCAtIDEgJiZcclxuICAgICAgICAgICAgaW50ZXJ2YWwuc3RhcnQuZ2V0RGF0ZSgpICE9PSBjc3YuaW50ZXJ2YWxzW2ludGVydmFsSW5kZXggKyAxXS5zdGFydC5nZXREYXRlKClcclxuICAgICAgICApIHtcclxuICAgICAgICAgICAgLy8gTGFzdCBpbnRlcnZhbCBvZiB0aGUgZGF5XHJcbiAgICAgICAgICAgIGlmICghbGFzdERpc3BsYXllZCB8fCBpbnRlcnZhbC5zdGFydC5nZXREYXRlKCkgIT09IGxhc3REaXNwbGF5ZWQuc3RhcnQuZ2V0RGF0ZSgpKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzZXBhcmF0b3IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwidHJcIik7XHJcbiAgICAgICAgICAgICAgICBzZXBhcmF0b3IuY2xhc3NMaXN0LmFkZChcImRheVNlcGFyYXRvclwiKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRoXCIpO1xyXG4gICAgICAgICAgICAgICAgdGguaW5uZXJIVE1MID0gcHJpbnRPbmx5RGF0ZShpbnRlcnZhbC5zdGFydCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0ZDIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwidGRcIik7XHJcbiAgICAgICAgICAgICAgICB0ZDIuY29sU3BhbiA9IGNzdi5kaXN0cmlidXRpb25FYW5zLmxlbmd0aCArIGNzdi5jb25zdW1lckVhbnMubGVuZ3RoICsgMTtcclxuICAgICAgICAgICAgICAgIHRkMi5pbm5lckhUTUwgPSBcIkFsbCBGaWx0ZXJlZCBvdXRcIjtcclxuICAgICAgICAgICAgICAgIHNlcGFyYXRvci5hcHBlbmRDaGlsZCh0aCk7XHJcbiAgICAgICAgICAgICAgICBzZXBhcmF0b3IuYXBwZW5kQ2hpbGQodGQyKTtcclxuICAgICAgICAgICAgICAgIGludGVydmFsQm9keS5hcHBlbmRDaGlsZChzZXBhcmF0b3IpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoaW50ZXJ2YWwuc3VtU2hhcmluZyA8IG1heFNoYXJpbmdJbnRlcnZhbCAqIGdTZXR0aW5ncy5maWx0ZXJWYWx1ZSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGFzdERpc3BsYXllZCA9IGludGVydmFsO1xyXG4gICAgICAgIGNvbnN0IHRyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRyXCIpO1xyXG5cclxuICAgICAgICAvLyBPcHRpbWl6YXRpb246IGRvIG5vdCB1c2UgY29sb3JpemVSYW5nZSgpXHJcbiAgICAgICAgY29uc3QgZ2V0QmFja2dyb3VuZCA9ICh2YWx1ZTogbnVtYmVyLCBtaW5pbXVtOiBudW1iZXIsIG1heGltdW06IG51bWJlcik6IHN0cmluZyA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFscGhhID0gKHZhbHVlIC0gbWluaW11bSkgLyBNYXRoLm1heCgwLjAwMDAxLCBtYXhpbXVtIC0gbWluaW11bSk7XHJcbiAgICAgICAgICAgIHJldHVybiBgcmdiYSgke0dSRUVOWzBdfSwgJHtHUkVFTlsxXX0sICR7R1JFRU5bMl19LCAke2FscGhhfSlgO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIGlmICgxKSB7XHJcbiAgICAgICAgICAgIC8vIFNwZWVkIG9wdGltaXphdGlvblxyXG4gICAgICAgICAgICB0ci5pbm5lckhUTUwgPSBgPHRoPiR7cHJpbnREYXRlKGludGVydmFsLnN0YXJ0KX0gLSAke1N0cmluZyhpbnRlcnZhbC5zdGFydC5nZXRIb3VycygpKS5wYWRTdGFydCgyLCBcIjBcIil9OiR7U3RyaW5nKGludGVydmFsLnN0YXJ0LmdldE1pbnV0ZXMoKSArIDE0KS5wYWRTdGFydCgyLCBcIjBcIil9PC90aD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICR7aW50ZXJ2YWwuZGlzdHJpYnV0aW9ucy5tYXAoKGkpID0+IGA8dGQgY2xhc3M9J2Rpc3RyaWJ1dGlvbicgc3R5bGU9XCJiYWNrZ3JvdW5kLWNvbG9yOiR7Z2V0QmFja2dyb3VuZChpLmJlZm9yZSAtIGkuYWZ0ZXIsIG1pblNoYXJpbmdEaXN0cmlidXRvciwgbWF4U2hhcmluZ0Rpc3RyaWJ1dG9yKX1cIj4ke3ByaW50S1doKGkuYmVmb3JlIC0gaS5hZnRlcil9PC90ZD5gKS5qb2luKFwiXCIpfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzPSdzcGxpdCc+PC90ZD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICR7aW50ZXJ2YWwuY29uc3VtZXJzLm1hcCgoaSkgPT4gYDx0ZCBjbGFzcz0nY29uc3VtZXInIHN0eWxlPVwiYmFja2dyb3VuZC1jb2xvcjoke2dldEJhY2tncm91bmQoaS5iZWZvcmUgLSBpLmFmdGVyLCBtaW5TaGFyaW5nQ29uc3VtZXIsIG1heFNoYXJpbmdDb25zdW1lcil9XCI+JHtwcmludEtXaChpLmJlZm9yZSAtIGkuYWZ0ZXIpfTwvdGQ+YCkuam9pbihcIlwiKX1gO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHRoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRoXCIpO1xyXG4gICAgICAgICAgICB0ci5hcHBlbmRDaGlsZCh0aCk7XHJcbiAgICAgICAgICAgIHRoLmlubmVySFRNTCA9IGAke3ByaW50RGF0ZShpbnRlcnZhbC5zdGFydCl9IC0gJHtTdHJpbmcoaW50ZXJ2YWwuc3RhcnQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgXCIwXCIpfToke1N0cmluZyhpbnRlcnZhbC5zdGFydC5nZXRNaW51dGVzKCkgKyAxNCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XHJcblxyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGkgb2YgaW50ZXJ2YWwuZGlzdHJpYnV0aW9ucykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2VsbCA9IHRyLmluc2VydENlbGwoKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuaW5uZXJIVE1MID0gcHJpbnRLV2goaS5iZWZvcmUgLSBpLmFmdGVyKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuY2xhc3NMaXN0LmFkZChcImRpc3RyaWJ1dGlvblwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB0ci5pbnNlcnRDZWxsKCkuY2xhc3NMaXN0LmFkZChcInNwbGl0XCIpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGkgb2YgaW50ZXJ2YWwuY29uc3VtZXJzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjZWxsID0gdHIuaW5zZXJ0Q2VsbCgpO1xyXG4gICAgICAgICAgICAgICAgY2VsbC5pbm5lckhUTUwgPSBwcmludEtXaChpLmJlZm9yZSAtIGkuYWZ0ZXIpO1xyXG4gICAgICAgICAgICAgICAgY2VsbC5jbGFzc0xpc3QuYWRkKFwiY29uc3VtZXJcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGludGVydmFsLmVycm9ycy5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgICAgIHRyLmNsYXNzTGlzdC5hZGQoXCJlcnJvclwiKTtcclxuICAgICAgICAgICAgdHIudGl0bGUgPSBpbnRlcnZhbC5lcnJvcnMuam9pbihcIlxcblwiKTsgXHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVydmFsQm9keS5hcHBlbmRDaGlsZCh0cik7XHJcbiAgICB9XHJcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1pbkZpbHRlclwiKSEuaW5uZXJIVE1MID0gcHJpbnRLV2gobWluU2hhcmluZ0ludGVydmFsKTtcclxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWF4RmlsdGVyXCIpIS5pbm5lckhUTUwgPSBwcmludEtXaChtYXhTaGFyaW5nSW50ZXJ2YWwpO1xyXG5cclxuICAgIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRocmVzaG9sZEZpbHRlclwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5pbm5lckhUTUwgPSBwcmludEtXaChcclxuICAgICAgICBtYXhTaGFyaW5nSW50ZXJ2YWwgKiBnU2V0dGluZ3MuZmlsdGVyVmFsdWUsXHJcbiAgICApO1xyXG5cclxuICAgIC8vIGNvbnNvbGUubG9nKFwiQ29sb3JpemluZyB0YWJsZSNpbnRlcnZhbHMgdGQuY29uc3VtZXJcIik7XHJcbiAgICBjb2xvcml6ZVJhbmdlKFwidGFibGUjaW50ZXJ2YWxzIHRkLmNvbnN1bWVyXCIsIEdSRUVOKTtcclxuICAgIC8vIGNvbnNvbGUubG9nKFwiQ29sb3JpemluZyB0YWJsZSNpbnRlcnZhbHMgdGQuZGlzdHJpYnV0aW9uXCIpO1xyXG4gICAgY29sb3JpemVSYW5nZShcInRhYmxlI2ludGVydmFscyB0ZC5kaXN0cmlidXRpb25cIiwgR1JFRU4pO1xyXG5cclxuICAgIGNvbnNvbGUubG9nKFwiZGlzcGxheUNzdiB0b29rXCIsIHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnRUaW1lLCBcIm1zXCIpO1xyXG59XHJcblxyXG5sZXQgZ0NzdjogQ3N2IHwgbnVsbCA9IG51bGw7XHJcblxyXG5mdW5jdGlvbiByZWZyZXNoVmlldygpOiB2b2lkIHtcclxuICAgIGlmIChnQ3N2KSB7XHJcbiAgICAgICAgZGlzcGxheUNzdihnQ3N2KTtcclxuICAgIH1cclxufVxyXG5cclxuZmlsZURvbS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcclxuICAgIGlmIChmaWxlRG9tLmZpbGVzPy5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICB3YXJuaW5nRG9tLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcclxuICAgICAgICB3YXJuaW5nRG9tLmlubmVySFRNTCA9IFwiXCI7XHJcbiAgICAgICAgZmlsdGVyRG9tLnZhbHVlID0gXCI5OVwiO1xyXG4gICAgICAgIGZpbHRlckRvbS5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcclxuICAgICAgICByZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRlbmRcIiwgKCkgPT4ge1xyXG4gICAgICAgICAgICBnQ3N2ID0gcGFyc2VDc3YocmVhZGVyLnJlc3VsdCBhcyBzdHJpbmcsIGZpbGVEb20uZmlsZXMhWzBdLm5hbWUpO1xyXG4gICAgICAgICAgICByZWZyZXNoVmlldygpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlYWRlci5yZWFkQXNUZXh0KGZpbGVEb20uZmlsZXNbMF0pOyAvLyBSZWFkIGZpbGUgYXMgdGV4dFxyXG4gICAgfVxyXG59KTtcclxuZmlsdGVyRG9tLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XHJcbiAgICAvLyBjb25zb2xlLmxvZyhcImZpbHRlckRvbSBJTlBVVFwiKTtcclxuICAgIGdTZXR0aW5ncy5maWx0ZXJWYWx1ZSA9IDEgLSBwYXJzZUludChmaWx0ZXJEb20udmFsdWUsIDEwKSAvIDEwMDtcclxuICAgIHJlZnJlc2hWaWV3KCk7XHJcbn0pO1xyXG5kb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImhpZGVFYW5zXCIpIS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcclxuICAgIGdTZXR0aW5ncy5oaWRlRWFucyA9IChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImhpZGVFYW5zXCIpIGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQ7XHJcbiAgICByZWZyZXNoVmlldygpO1xyXG59KTtcclxuZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW5wdXRbbmFtZT1cInVuaXRcIl0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsIChlKSA9PiB7XHJcbiAgICAgICAgZ1NldHRpbmdzLmRpc3BsYXlVbml0ID0gKGUudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlIGFzIFwia1doXCIgfCBcImtXXCI7XHJcbiAgICAgICAgcmVmcmVzaFZpZXcoKTtcclxuICAgIH0pO1xyXG59KTtcclxuXHJcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdW51c2VkLXZhcnNcclxuZXhwb3J0IGZ1bmN0aW9uIG1vY2soKTogdm9pZCB7XHJcbiAgICAvLyBUZXN0aW5nIGRhdGFcclxuICAgIGdDc3YgPSBwYXJzZUNzdihcclxuICAgICAgICBgRGF0dW07Q2FzIG9kO0NhcyBkbztJTi04NTkxODI0MDAwMDAwMDAwMDEtRDtPVVQtODU5MTgyNDAwMDAwMDAwMDAxLUQ7SU4tODU5MTgyNDAwMDAwMDAwMDAyLU87T1VULTg1OTE4MjQwMDAwMDAwMDAwMi1PO0lOLTg1OTE4MjQwMDAwMDAwMDAwMy1PO09VVC04NTkxODI0MDAwMDAwMDAwMDMtTztJTi04NTkxODI0MDAwMDAwMDAwMDQtTztPVVQtODU5MTgyNDAwMDAwMDAwMDA0LU87SU4tODU5MTgyNDAwMDAwMDAwMDA1LU87T1VULTg1OTE4MjQwMDAwMDAwMDAwNS1PO0lOLTg1OTE4MjQwMDAwMDAwMDAwNi1PO09VVC04NTkxODI0MDAwMDAwMDAwMDYtTztJTi04NTkxODI0MDAwMDAwMDAwMDctTztPVVQtODU5MTgyNDAwMDAwMDAwMDA3LU9cclxuMDUuMDIuMjAyNTsxMTowMDsxMToxNTswLDAzOzAsMDM7LTAsNzQ7LTAsNzQ7LTAsMTstMCwxOy0wLDUzOy0wLDUzOzAsMDswLDA7MCwwOzAsMDstMCwxODstMCwxODtcclxuMDUuMDIuMjAyNTsxMToxNTsxMTozMDswLDgzOzAsMTQ7LTAsNzQ7LTAsNTY7LTAsMDk7MCwwOy0wLDQ4Oy0wLDE7MCwwOzAsMDstMCwwMTswLDA7LTAsMDM7MCwwO1xyXG4wNS4wMi4yMDI1OzExOjMwOzExOjQ1OzEsMjswLDE1Oy0wLDY3Oy0wLDQxOy0wLDI7MCwwOy0wLDU2Oy0wLDAzOzAsMDswLDA7LTAsMDI7MCwwOy0wLDA0OzAsMDtcclxuMDUuMDIuMjAyNTsxMTo0NTsxMjowMDsxLDE0OzAsMjQ7LTAsMDc7MCwwOy0wLDI1OzAsMDstMCw2OTstMCwxNTswLDA7MCwwOy0wLDAxOzAsMDstMCwwMzswLDA7XHJcbjA1LjAyLjIwMjU7MTI6MDA7MTI6MTU7MSwxODswLDE1Oy0wLDM1Oy0wLDEyOy0wLDI0OzAsMDstMCw4MzstMCwzMzswLDA7MCwwOy0wLDAyOzAsMDstMCwwNDswLDA7XHJcbjA1LjAyLjIwMjU7MTI6MTU7MTI6MzA7MCw5MTswLDIyOy0wLDI0Oy0wLDA0Oy0wLDI3OzAsMDstMCwxODswLDA7MCwwOzAsMDswLDA7MCwwOy0wLDA0OzAsMDtcclxuMDUuMDIuMjAyNTsxMjozMDsxMjo0NTswLDgzOzAsMTU7LTAsMzk7LTAsMjQ7LTAsMjk7MCwwOy0wLDExOzAsMDswLDA7MCwwOy0wLDAxOzAsMDstMCwxMjswLDA7XHJcbjA1LjAyLjIwMjU7MTI6NDU7MTM6MDA7MSwwNTswLDAzOy0xLDEzOy0wLDk2Oy0wLDU2Oy0wLDI7LTAsMTE7MCwwOzAsMDswLDA7LTAsMDI7MCwwOy0wLDQ4Oy0wLDEyO1xyXG4wNS4wMi4yMDI1OzEzOjAwOzEzOjE1OzEsMDI7MCwwNDstMCwyNDstMCwwNzstMCw2MzstMCwyODstMCwxMjswLDA7MCwwOzAsMDswLDA7MCwwOy0wLDM0OzAsMDtcclxuMDUuMDIuMjAyNTsxMzoxNTsxMzozMDsxLDA7MCwzMzstMCwyNjstMCwwMTstMCwxMTswLDA7LTAsMTE7MCwwOzAsMDswLDA7LTAsMDI7MCwwOy0wLDE4OzAsMDtcclxuMDUuMDIuMjAyNTsxMzozMDsxMzo0NTswLDkzOzAsMjk7LTAsMjE7MCwwOy0wLDEyOzAsMDstMCwxMTswLDA7MCwwOzAsMDstMCwwMjswLDA7LTAsMTg7MCwwO1xyXG4wNS4wMi4yMDI1OzEzOjQ1OzE0OjAwOzAsODY7MCw0NTstMCwxMTswLDA7LTAsMDk7MCwwOy0wLDExOzAsMDswLDA7MCwwOy0wLDAxOzAsMDstMCwwOTswLDA7XHJcbmAsXHJcbiAgICAgICAgXCJURVNUSU5HIERVTU1ZXCIsXHJcbiAgICApO1xyXG4gICAgcmVmcmVzaFZpZXcoKTtcclxufVxyXG5cclxubW9jaygpO1xyXG4iXX0=