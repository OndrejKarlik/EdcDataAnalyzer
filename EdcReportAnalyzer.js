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
function logWarning(warning) {
    warningDom.style.display = "block";
    if (warningDom.children.length === 0) {
        const dom = document.createElement("li");
        dom.innerText = `Input data is inconsistent! Only "monthly report" is guaranteed to be correct, prefer using that.
                         The script will attempt to fix some errors, but the result is still only approximate. Also not all errors can be caught.`;
        warningDom.appendChild(dom);
    }
    const dom = document.createElement("li");
    dom.innerText = warning;
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
        for (const ean of distributorEans) {
            let before = parseKwh(explodedLine[ean.csvIndex]);
            let after = parseKwh(explodedLine[ean.csvIndex + 1]);
            if (after > before) {
                logWarning(`Distribution EAN ${ean.name} is distributing ${after - before} kWh more AFTER subtracting sharing on ${printDate(date)}.
                    The report will clip sharing to 0.`);
                after = before;
            }
            if (before < 0 || after < 0) {
                logWarning(`Distribution EAN ${ean.name} is consuming ${before / after} kWh power on ${printDate(date)}. The report will clip negative values to 0.`);
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
                logWarning(`Consumer EAN ${ean.name} is consuming ${after - before} kWh more AFTER subtracting sharing on ${printDate(date)}.
                    The report will clip sharing to 0.`);
                after = before;
            }
            if (before < 0 || after < 0) {
                logWarning(`Consumer EAN ${ean.name} is distributing ${before / after} kWh power on ${printDate(date)}. The report will clip negative values to 0.`);
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
            logWarning(`Energy shared from distributors does not match energy shared to consumers on ${printDate(date)}! \nDistributed: ${sumSharedDistributed}\n Consumed: ${sumSharedConsumed}.
                The report will consider the mismatch not shared.`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRWRjUmVwb3J0QW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFZGNSZXBvcnRBbmFseXplci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSx5RUFBeUU7QUFDekUsZ0VBQWdFO0FBQ2hFLG1DQUFtQztBQU1uQyxTQUFTLElBQUksQ0FBSSxTQUFjO0lBQzNCLE9BQU8sU0FBUyxDQUFDLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsTUFBTSxDQUFDLFNBQWtCLEVBQUUsR0FBRyxXQUFzQjtJQUN6RCxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDYixNQUFNLFFBQVEsR0FBRyxrQkFBa0IsV0FBVyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUM7UUFDNUQsT0FBTyxDQUFDLEtBQUssQ0FBQyxlQUFlLEVBQUUsR0FBRyxXQUFXLENBQUMsQ0FBQztRQUMvQyxRQUFRLENBQUM7UUFDVCxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM5QixDQUFDO0FBQ0wsQ0FBQztBQUVELE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsVUFBVSxDQUFtQixDQUFDO0FBQ3pFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsV0FBVyxDQUFxQixDQUFDO0FBQ3pFLE1BQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsY0FBYyxDQUFxQixDQUFDO0FBUTlFLE1BQU0sU0FBUyxHQUFhO0lBQ3hCLFdBQVcsRUFBRSxLQUFLO0lBQ2xCLFFBQVEsRUFBRSxLQUFLO0lBQ2YsV0FBVyxFQUFFLENBQUM7Q0FDakIsQ0FBQztBQUVGLFNBQVMsVUFBVSxDQUFDLE9BQWU7SUFDL0IsVUFBVSxDQUFDLEtBQUssQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO0lBQ25DLElBQUksVUFBVSxDQUFDLFFB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RUFBRSxHQUFHLEVBQUU7SUFDckMsa0NBQWtDO0lBQ2xDLFNBQVMsQ0FBQyxXQUFXLEdBQUcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQztJQUNoRSxXQUFXLEVBQUUsQ0FBQztBQUNsQixDQUFDLENBQUMsQ0FBQztBQUNILFFBQVEsQ0FBQyxjQUFjLENBQUMsVUFBVSxDQUFFLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRTtJQUNqRSxTQUFTLENBQUMsUUFBUSxHQUFJLFFBQVEsQ0FBQyxjQUFjLENBQUMsVUFBVSxDQUFzQixDQUFDLE9BQU8sQ0FBQztJQUN2RixXQUFXLEVBQUUsQ0FBQztBQUNsQixDQUFDLENBQUMsQ0FBQztBQUNILFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFO0lBQy9ELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRTtRQUNwQyxTQUFTLENBQUMsV0FBVyxHQUFJLENBQUMsQ0FBQyxNQUEyQixDQUFDLEtBQXFCLENBQUM7UUFDN0UsV0FBVyxFQUFFLENBQUM7SUFDbEIsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQztBQUVILDZEQUE2RDtBQUM3RCxNQUFNLFVBQVUsSUFBSTtJQUNoQixlQUFlO0lBQ2YsSUFBSSxHQUFHLFFBQVEsQ0FDWDs7Ozs7Ozs7Ozs7OztDQWFQLEVBQ08sZUFBZSxDQUNsQixDQUFDO0lBQ0YsV0FBVyxFQUFFLENBQUM7QUFDbEIsQ0FBQztBQUVELElBQUksRUFBRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vbi1udWxsYWJsZS10eXBlLWFzc2VydGlvbi1zdHlsZSAqL1xyXG4vKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdW5zYWZlLXR5cGUtYXNzZXJ0aW9uICovXHJcbi8qIGVzbGludC1kaXNhYmxlIG5vLWxvbmUtYmxvY2tzICovXHJcblxyXG4vLyBUT0RPOiB0ZXN0IG11bHRpcGxlIGRpc3RyaWJ1dGlvbiBFQU5zXHJcblxyXG50eXBlIFJnYiA9IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcclxuXHJcbmZ1bmN0aW9uIGxhc3Q8VD4oY29udGFpbmVyOiBUW10pOiBUIHtcclxuICAgIHJldHVybiBjb250YWluZXJbY29udGFpbmVyLmxlbmd0aCAtIDFdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnQoY29uZGl0aW9uOiBib29sZWFuLCAuLi5sb2dnaW5nQXJnczogdW5rbm93bltdKTogYXNzZXJ0cyBjb25kaXRpb24ge1xyXG4gICAgaWYgKCFjb25kaXRpb24pIHtcclxuICAgICAgICBjb25zdCBlcnJvck1zZyA9IGBBc3NlcnQgZmFpbGVkOiAke2xvZ2dpbmdBcmdzLnRvU3RyaW5nKCl9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKFwiQXNzZXJ0IGZhaWxlZFwiLCAuLi5sb2dnaW5nQXJncyk7XHJcbiAgICAgICAgZGVidWdnZXI7XHJcbiAgICAgICAgYWxlcnQoZXJyb3JNc2cpO1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1zZyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmNvbnN0IHdhcm5pbmdEb20gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIndhcm5pbmdzXCIpIGFzIEhUTUxEaXZFbGVtZW50O1xyXG5jb25zdCBmaWxlRG9tID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ1cGxvYWRDc3ZcIikgYXMgSFRNTElucHV0RWxlbWVudDtcclxuY29uc3QgZmlsdGVyRG9tID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJmaWx0ZXJTbGlkZXJcIikgYXMgSFRNTElucHV0RWxlbWVudDtcclxuXHJcbmludGVyZmFjZSBTZXR0aW5ncyB7XHJcbiAgICBkaXNwbGF5VW5pdDogXCJrV2hcIiB8IFwia1dcIjtcclxuICAgIGhpZGVFYW5zOiBib29sZWFuO1xyXG4gICAgZmlsdGVyVmFsdWU6IG51bWJlcjtcclxufVxyXG5cclxuY29uc3QgZ1NldHRpbmdzOiBTZXR0aW5ncyA9IHtcclxuICAgIGRpc3BsYXlVbml0OiBcImtXaFwiLFxyXG4gICAgaGlkZUVhbnM6IGZhbHNlLFxyXG4gICAgZmlsdGVyVmFsdWU6IDAsXHJcbn07XHJcblxyXG5mdW5jdGlvbiBsb2dXYXJuaW5nKHdhcm5pbmc6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgd2FybmluZ0RvbS5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xyXG4gICAgaWYgKHdhcm5pbmdEb20uY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgY29uc3QgZG9tID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xyXG4gICAgICAgIGRvbS5pbm5lclRleHQgPSBgSW5wdXQgZGF0YSBpcyBpbmNvbnNpc3RlbnQhIE9ubHkgXCJtb250aGx5IHJlcG9ydFwiIGlzIGd1YXJhbnRlZWQgdG8gYmUgY29ycmVjdCwgcHJlZmVyIHVzaW5nIHRoYXQuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICBUaGUgc2NyaXB0IHdpbGwgYXR0ZW1wdCB0byBmaXggc29tZSBlcnJvcnMsIGJ1dCB0aGUgcmVzdWx0IGlzIHN0aWxsIG9ubHkgYXBwcm94aW1hdGUuIEFsc28gbm90IGFsbCBlcnJvcnMgY2FuIGJlIGNhdWdodC5gO1xyXG4gICAgICAgIHdhcm5pbmdEb20uYXBwZW5kQ2hpbGQoZG9tKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGRvbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcclxuICAgIGRvbS5pbm5lclRleHQgPSB3YXJuaW5nO1xyXG4gICAgd2FybmluZ0RvbS5hcHBlbmRDaGlsZChkb20pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwYXJzZUt3aChpbnB1dDogc3RyaW5nKTogbnVtYmVyIHtcclxuICAgIGlmIChpbnB1dC5sZW5ndGggPT09IDApIHtcclxuICAgICAgICByZXR1cm4gMC4wO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWRqID0gaW5wdXQucmVwbGFjZShcIixcIiwgXCIuXCIpO1xyXG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VGbG9hdChhZGopO1xyXG4gICAgYXNzZXJ0KCFpc05hTihyZXN1bHQpKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByaW50S1doKGlucHV0OiBudW1iZXIsIGFsd2F5c0t3aCA9IGZhbHNlKTogc3RyaW5nIHtcclxuICAgIGlmIChnU2V0dGluZ3MuZGlzcGxheVVuaXQgPT09IFwia1dcIiAmJiAhYWx3YXlzS3doKSB7XHJcbiAgICAgICAgcmV0dXJuIGAkeyhpbnB1dCAqIDQpLnRvRml4ZWQoMil9Jm5ic3A7a1dgO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICByZXR1cm4gYCR7aW5wdXQudG9GaXhlZCgyKX0mbmJzcDtrV2hgO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBnZXREYXRlKGV4cGxvZGVkTGluZTogc3RyaW5nW10pOiBEYXRlIHtcclxuICAgIGFzc2VydChleHBsb2RlZExpbmUubGVuZ3RoID4gMywgYENhbm5vdCBleHRyYWN0IGRhdGUgLSB3aG9sZSBsaW5lIGlzOiBcIiR7ZXhwbG9kZWRMaW5lLmpvaW4oXCI7XCIpfVwiYCk7XHJcbiAgICBjb25zdCBbZGF5LCBtb250aCwgeWVhcl0gPSBleHBsb2RlZExpbmVbMF0uc3BsaXQoXCIuXCIpO1xyXG4gICAgY29uc3QgW2hvdXIsIG1pbnV0ZV0gPSBleHBsb2RlZExpbmVbMV0uc3BsaXQoXCI6XCIpO1xyXG4gICAgcmV0dXJuIG5ldyBEYXRlKFxyXG4gICAgICAgIHBhcnNlSW50KHllYXIsIDEwKSxcclxuICAgICAgICBwYXJzZUludChtb250aCwgMTApIC0gMSxcclxuICAgICAgICBwYXJzZUludChkYXksIDEwKSxcclxuICAgICAgICBwYXJzZUludChob3VyLCAxMCksXHJcbiAgICAgICAgcGFyc2VJbnQobWludXRlLCAxMCksXHJcbiAgICApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmludEVhbihpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGFzc2VydChpbnB1dC5sZW5ndGggPT09IDE4KTtcclxuICAgIC8vIGlucHV0ID0gaW5wdXQucmVwbGFjZShcIjg1OTE4MjQwMFwiLCBcIuKAplwiKTsgLy8gRG9lcyBub3QgbG9vayBnb29kLi4uXHJcbiAgICBpZiAoZ1NldHRpbmdzLmhpZGVFYW5zKSB7XHJcbiAgICAgICAgaW5wdXQgPSBgODU5MTgyNDAweHh4eHh4eCR7aW5wdXQuc3Vic3RyaW5nKDE2KX1gO1xyXG4gICAgICAgIGFzc2VydChpbnB1dC5sZW5ndGggPT09IDE4KTtcclxuICAgIH1cclxuICAgIHJldHVybiBpbnB1dDtcclxufVxyXG5cclxuaW50ZXJmYWNlIE1lYXN1cmVtZW50IHtcclxuICAgIGJlZm9yZTogbnVtYmVyO1xyXG4gICAgYWZ0ZXI6IG51bWJlcjtcclxufVxyXG5cclxuaW50ZXJmYWNlIEludGVydmFsIHtcclxuICAgIHN0YXJ0OiBEYXRlO1xyXG5cclxuICAgIHN1bVNoYXJpbmc6IG51bWJlcjtcclxuXHJcbiAgICBkaXN0cmlidXRpb25zOiBNZWFzdXJlbWVudFtdO1xyXG4gICAgY29uc3VtZXJzOiBNZWFzdXJlbWVudFtdO1xyXG59XHJcblxyXG5jbGFzcyBDc3Yge1xyXG4gICAgZGlzdHJpYnV0aW9uRWFuczogRWFuW10gPSBbXTtcclxuICAgIGNvbnN1bWVyRWFuczogRWFuW10gPSBbXTtcclxuXHJcbiAgICBmaWxlbmFtZTogc3RyaW5nO1xyXG4gICAgZGF0ZUZyb206IERhdGU7XHJcbiAgICBkYXRlVG86IERhdGU7XHJcblxyXG4gICAgc2hhcmVkVG90YWwgPSAwO1xyXG4gICAgbWlzc2VkVG90YWwgPSAwO1xyXG5cclxuICAgIGludGVydmFsczogSW50ZXJ2YWxbXSA9IFtdO1xyXG5cclxuICAgIGNvbnN0cnVjdG9yKGZpbGVuYW1lOiBzdHJpbmcsIGludGVydmFsczogSW50ZXJ2YWxbXSkge1xyXG4gICAgICAgIHRoaXMuZmlsZW5hbWUgPSBmaWxlbmFtZTtcclxuICAgICAgICB0aGlzLmludGVydmFscyA9IGludGVydmFscztcclxuICAgICAgICB0aGlzLmRhdGVGcm9tID0gaW50ZXJ2YWxzWzBdLnN0YXJ0O1xyXG4gICAgICAgIHRoaXMuZGF0ZVRvID0gbGFzdChpbnRlcnZhbHMpLnN0YXJ0O1xyXG4gICAgfVxyXG59XHJcblxyXG5jbGFzcyBFYW4ge1xyXG4gICAgbmFtZTogc3RyaW5nO1xyXG4gICAgY3N2SW5kZXg6IG51bWJlcjtcclxuICAgIG9yaWdpbmFsQmFsYW5jZSA9IDA7XHJcbiAgICBhZGp1c3RlZEJhbGFuY2UgPSAwO1xyXG4gICAgbWF4aW11bU9yaWdpbmFsID0gMDtcclxuICAgIG1pc3NlZER1ZVRvQWxsb2NhdGlvbiA9IDA7XHJcbiAgICBjb25zdHJ1Y3RvcihuYW1lOiBzdHJpbmcsIGNzdkluZGV4OiBudW1iZXIpIHtcclxuICAgICAgICB0aGlzLm5hbWUgPSBuYW1lO1xyXG4gICAgICAgIHRoaXMuY3N2SW5kZXggPSBjc3ZJbmRleDtcclxuICAgIH1cclxufVxyXG5cclxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGNvbXBsZXhpdHlcclxuZnVuY3Rpb24gcGFyc2VDc3YoY3N2OiBzdHJpbmcsIGZpbGVuYW1lOiBzdHJpbmcpOiBDc3Yge1xyXG4gICAgY3N2ID0gY3N2LnJlcGxhY2VBbGwoXCJcXHJcXG5cIiwgXCJcXG5cIik7XHJcbiAgICBjb25zdCBsaW5lcyA9IGNzdi5zcGxpdChcIlxcblwiKTtcclxuICAgIGFzc2VydChsaW5lcy5sZW5ndGggPiAwLCBcIkNTViBmaWxlIGlzIGVtcHR5XCIpO1xyXG4gICAgY29uc3QgaGVhZGVyID0gbGluZXNbMF0uc3BsaXQoXCI7XCIpO1xyXG4gICAgYXNzZXJ0KFxyXG4gICAgICAgIGhlYWRlci5sZW5ndGggPiAzLFxyXG4gICAgICAgIGBDU1YgZmlsZSBoYXMgaW52YWxpZCBoZWFkZXIgLSBsZXNzIHRoYW4gMyBlbGVtZW50cy4gSXMgdGhlcmUgYW4gZXh0cmEgZW1wdHkgbGluZT8gVGhlIGVudGlyZSBsaW5lIGlzIFwiJHtsaW5lc1swXX1cImAsXHJcbiAgICApO1xyXG4gICAgYXNzZXJ0KGhlYWRlclswXSA9PT0gXCJEYXR1bVwiICYmIGhlYWRlclsxXSA9PT0gXCJDYXMgb2RcIiAmJiBoZWFkZXJbMl0gPT09IFwiQ2FzIGRvXCIpO1xyXG4gICAgYXNzZXJ0KGhlYWRlci5sZW5ndGggJSAyID09PSAxKTtcclxuXHJcbiAgICBjb25zdCBkaXN0cmlidXRvckVhbnM6IEVhbltdID0gW107XHJcbiAgICBjb25zdCBjb25zdW1lckVhbnM6IEVhbltdID0gW107XHJcblxyXG4gICAgZm9yIChsZXQgaSA9IDM7IGkgPCBoZWFkZXIubGVuZ3RoOyBpICs9IDIpIHtcclxuICAgICAgICBjb25zdCBiZWZvcmUgPSBoZWFkZXJbaV0udHJpbSgpO1xyXG4gICAgICAgIGNvbnN0IGFmdGVyID0gaGVhZGVyW2kgKyAxXS50cmltKCk7XHJcbiAgICAgICAgYXNzZXJ0KGJlZm9yZS5zdWJzdHJpbmcoMikgPT09IGFmdGVyLnN1YnN0cmluZygzKSwgXCJNaXNtYXRjaGVkIElOLSBhbmQgT1VULVwiLCBiZWZvcmUsIGFmdGVyKTtcclxuXHJcbiAgICAgICAgY29uc3QgaXNEaXN0cmlidXRpb24gPSBiZWZvcmUuZW5kc1dpdGgoXCItRFwiKTtcclxuICAgICAgICBjb25zdCBlYW5OdW1iZXIgPSBiZWZvcmUuc3Vic3RyaW5nKDMsIGJlZm9yZS5sZW5ndGggLSAyKTtcclxuICAgICAgICBpZiAoaXNEaXN0cmlidXRpb24pIHtcclxuICAgICAgICAgICAgZGlzdHJpYnV0b3JFYW5zLnB1c2gobmV3IEVhbihlYW5OdW1iZXIsIGkpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBhc3NlcnQoYmVmb3JlLmVuZHNXaXRoKFwiLU9cIiksIGJlZm9yZSk7XHJcbiAgICAgICAgICAgIGNvbnN1bWVyRWFucy5wdXNoKG5ldyBFYW4oZWFuTnVtYmVyLCBpKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFzc2VydChiZWZvcmUuc3RhcnRzV2l0aChcIklOLVwiKSAmJiBhZnRlci5zdGFydHNXaXRoKFwiT1VULVwiKSwgYmVmb3JlLCBhZnRlcik7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gTWFwcyBmcm9tIHRpbWUgdG8gbWlzc2luZyBzaGFyaW5nIGZvciB0aGF0IHRpbWUgc2xvdFxyXG4gICAgY29uc3QgbWlzc2VkU2hhcmluZ0R1ZVRvQWxsb2NhdGlvblRpbWVTbG90cyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXI+KCk7XHJcbiAgICBjb25zdCBpbnRlcnZhbHMgPSBbXSBhcyBJbnRlcnZhbFtdO1xyXG5cclxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbGluZXMubGVuZ3RoOyArK2kpIHtcclxuICAgICAgICBpZiAobGluZXNbaV0udHJpbSgpLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZXhwbG9kZWRMaW5lID0gbGluZXNbaV0uc3BsaXQoXCI7XCIpO1xyXG5cclxuICAgICAgICBjb25zdCBleHBlY3RlZExlbmd0aCA9IDMgKyAoY29uc3VtZXJFYW5zLmxlbmd0aCArIGRpc3RyaWJ1dG9yRWFucy5sZW5ndGgpICogMjtcclxuICAgICAgICAvLyBJbiBzb21lIHJlcG9ydHMgdGhlcmUgaXMgYW4gZW1wdHkgZmllbGQgYXQgdGhlIGVuZCBvZiB0aGUgbGluZVxyXG4gICAgICAgIGFzc2VydChcclxuICAgICAgICAgICAgZXhwbG9kZWRMaW5lLmxlbmd0aCA9PT0gZXhwZWN0ZWRMZW5ndGggfHxcclxuICAgICAgICAgICAgICAgIChleHBsb2RlZExpbmUubGVuZ3RoID09PSBleHBlY3RlZExlbmd0aCArIDEgJiYgbGFzdChleHBsb2RlZExpbmUpID09PSBcIlwiKSxcclxuICAgICAgICAgICAgYFdyb25nIG51bWJlciBvZiBpdGVtczogJHtleHBsb2RlZExpbmUubGVuZ3RofSwgZXhwZWN0ZWQ6ICR7ZXhwZWN0ZWRMZW5ndGh9LCBsaW5lIG51bWJlcjogJHtpfS4gTGFzdCBpdGVtIG9uIGxpbmUgaXMgXCIke2xhc3QoZXhwbG9kZWRMaW5lKX1cImAsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBkYXRlID0gZ2V0RGF0ZShleHBsb2RlZExpbmUpO1xyXG5cclxuICAgICAgICBjb25zdCBkaXN0cmlidXRlZDogTWVhc3VyZW1lbnRbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IGNvbnN1bWVkOiBNZWFzdXJlbWVudFtdID0gW107XHJcblxyXG4gICAgICAgIGZvciAoY29uc3QgZWFuIG9mIGRpc3RyaWJ1dG9yRWFucykge1xyXG4gICAgICAgICAgICBsZXQgYmVmb3JlID0gcGFyc2VLd2goZXhwbG9kZWRMaW5lW2Vhbi5jc3ZJbmRleF0pO1xyXG4gICAgICAgICAgICBsZXQgYWZ0ZXIgPSBwYXJzZUt3aChleHBsb2RlZExpbmVbZWFuLmNzdkluZGV4ICsgMV0pO1xyXG4gICAgICAgICAgICBpZiAoYWZ0ZXIgPiBiZWZvcmUpIHtcclxuICAgICAgICAgICAgICAgIGxvZ1dhcm5pbmcoXHJcbiAgICAgICAgICAgICAgICAgICAgYERpc3RyaWJ1dGlvbiBFQU4gJHtlYW4ubmFtZX0gaXMgZGlzdHJpYnV0aW5nICR7YWZ0ZXIgLSBiZWZvcmV9IGtXaCBtb3JlIEFGVEVSIHN1YnRyYWN0aW5nIHNoYXJpbmcgb24gJHtwcmludERhdGUoZGF0ZSl9LlxyXG4gICAgICAgICAgICAgICAgICAgIFRoZSByZXBvcnQgd2lsbCBjbGlwIHNoYXJpbmcgdG8gMC5gLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGFmdGVyID0gYmVmb3JlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChiZWZvcmUgPCAwIHx8IGFmdGVyIDwgMCkge1xyXG4gICAgICAgICAgICAgICAgbG9nV2FybmluZyhcclxuICAgICAgICAgICAgICAgICAgICBgRGlzdHJpYnV0aW9uIEVBTiAke2Vhbi5uYW1lfSBpcyBjb25zdW1pbmcgJHtiZWZvcmUgLyBhZnRlcn0ga1doIHBvd2VyIG9uICR7cHJpbnREYXRlKGRhdGUpfS4gVGhlIHJlcG9ydCB3aWxsIGNsaXAgbmVnYXRpdmUgdmFsdWVzIHRvIDAuYCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBiZWZvcmUgPSBNYXRoLm1heCgwLCBiZWZvcmUpO1xyXG4gICAgICAgICAgICAgICAgYWZ0ZXIgPSBNYXRoLm1heCgwLCBhZnRlcik7XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGVhbi5vcmlnaW5hbEJhbGFuY2UgKz0gYmVmb3JlO1xyXG4gICAgICAgICAgICBlYW4uYWRqdXN0ZWRCYWxhbmNlICs9IGFmdGVyO1xyXG4gICAgICAgICAgICBlYW4ubWF4aW11bU9yaWdpbmFsID0gTWF0aC5tYXgoZWFuLm1heGltdW1PcmlnaW5hbCwgYmVmb3JlKTtcclxuICAgICAgICAgICAgZGlzdHJpYnV0ZWQucHVzaCh7IGJlZm9yZSwgYWZ0ZXIgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgZWFuIG9mIGNvbnN1bWVyRWFucykge1xyXG4gICAgICAgICAgICBsZXQgYmVmb3JlID0gLXBhcnNlS3doKGV4cGxvZGVkTGluZVtlYW4uY3N2SW5kZXhdKTtcclxuICAgICAgICAgICAgbGV0IGFmdGVyID0gLXBhcnNlS3doKGV4cGxvZGVkTGluZVtlYW4uY3N2SW5kZXggKyAxXSk7XHJcbiAgICAgICAgICAgIGlmIChhZnRlciA+IGJlZm9yZSkge1xyXG4gICAgICAgICAgICAgICAgbG9nV2FybmluZyhcclxuICAgICAgICAgICAgICAgICAgICBgQ29uc3VtZXIgRUFOICR7ZWFuLm5hbWV9IGlzIGNvbnN1bWluZyAke2FmdGVyIC0gYmVmb3JlfSBrV2ggbW9yZSBBRlRFUiBzdWJ0cmFjdGluZyBzaGFyaW5nIG9uICR7cHJpbnREYXRlKGRhdGUpfS5cclxuICAgICAgICAgICAgICAgICAgICBUaGUgcmVwb3J0IHdpbGwgY2xpcCBzaGFyaW5nIHRvIDAuYCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBhZnRlciA9IGJlZm9yZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoYmVmb3JlIDwgMCB8fCBhZnRlciA8IDApIHtcclxuICAgICAgICAgICAgICAgIGxvZ1dhcm5pbmcoXHJcbiAgICAgICAgICAgICAgICAgICAgYENvbnN1bWVyIEVBTiAke2Vhbi5uYW1lfSBpcyBkaXN0cmlidXRpbmcgJHtiZWZvcmUgLyBhZnRlcn0ga1doIHBvd2VyIG9uICR7cHJpbnREYXRlKGRhdGUpfS4gVGhlIHJlcG9ydCB3aWxsIGNsaXAgbmVnYXRpdmUgdmFsdWVzIHRvIDAuYCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBiZWZvcmUgPSBNYXRoLm1heCgwLCBiZWZvcmUpO1xyXG4gICAgICAgICAgICAgICAgYWZ0ZXIgPSBNYXRoLm1heCgwLCBhZnRlcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWFuLm9yaWdpbmFsQmFsYW5jZSArPSBiZWZvcmU7XHJcbiAgICAgICAgICAgIGVhbi5hZGp1c3RlZEJhbGFuY2UgKz0gYWZ0ZXI7XHJcbiAgICAgICAgICAgIGVhbi5tYXhpbXVtT3JpZ2luYWwgPSBNYXRoLm1heChlYW4ubWF4aW11bU9yaWdpbmFsLCBiZWZvcmUpO1xyXG4gICAgICAgICAgICBjb25zdW1lZC5wdXNoKHsgYmVmb3JlLCBhZnRlciB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIElmIHRoZXJlIGlzIHN0aWxsIHNvbWUgcG93ZXIgbGVmdCBhZnRlciBzaGFyaW5nLCB3ZSBjaGVjayB0aGF0IGFsbCBjb25zdW1lcnMgaGF2ZSAwIGFkanVzdGVkIHBvd2VyLlxyXG4gICAgICAgIC8vIElmIHRoZXJlIHdhcyBzb21lIGNvbnN1bWVyIGxlZnQgd2l0aCBub24temVybyBwb3dlciwgaXQgbWVhbnMgdGhlcmUgd2FzIGVuZXJneSB0aGF0IGNvdWxkIGhhdmUgYmVlblxyXG4gICAgICAgIC8vIHNoYXJlZCwgYnV0IHdhc24ndCBkdWUgdG8gYmFkIGFsbG9jYXRpb24uXHJcbiAgICAgICAgY29uc3Qgc3VtRGlzdHJpYnV0b3JzQWZ0ZXIgPSBkaXN0cmlidXRlZC5yZWR1Y2UoKGFjYywgdmFsKSA9PiBhY2MgKyB2YWwuYWZ0ZXIsIDApO1xyXG4gICAgICAgIGlmIChzdW1EaXN0cmlidXRvcnNBZnRlciA+IDApIHtcclxuICAgICAgICAgICAgbGV0IHN1bUNvbnN1bWVyc0FmdGVyID0gY29uc3VtZWQucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgdmFsLmFmdGVyLCAwKTtcclxuICAgICAgICAgICAgY29uc3QgbWlzc2VkU2NhbGUgPSBNYXRoLm1pbigxLjAsIHN1bURpc3RyaWJ1dG9yc0FmdGVyIC8gc3VtQ29uc3VtZXJzQWZ0ZXIpO1xyXG4gICAgICAgICAgICBhc3NlcnQobWlzc2VkU2NhbGUgPiAwICYmIG1pc3NlZFNjYWxlIDw9IDEsIG1pc3NlZFNjYWxlKTtcclxuICAgICAgICAgICAgc3VtQ29uc3VtZXJzQWZ0ZXIgPSBNYXRoLm1pbihzdW1Db25zdW1lcnNBZnRlciwgc3VtRGlzdHJpYnV0b3JzQWZ0ZXIpO1xyXG5cclxuICAgICAgICAgICAgLy8gVGhlcmUgYXJlIHBsZW50eSBvZiBpbnRlcnZhbHMgd2hlcmUgZGlzdHJpYnV0aW9uIGJlZm9yZSBhbmQgYWZ0ZXIgYXJlIGJvdGggMC4wMSBhbmQgbm8gc2hhcmluZ1xyXG4gICAgICAgICAgICAvLyBpcyBwZXJmb3JtZWQuLi46XHJcbiAgICAgICAgICAgIGlmIChzdW1Db25zdW1lcnNBZnRlciA+IDAuMCAmJiBzdW1EaXN0cmlidXRvcnNBZnRlciA+IDAuMCkge1xyXG4gICAgICAgICAgICAgICAgbWlzc2VkU2hhcmluZ0R1ZVRvQWxsb2NhdGlvblRpbWVTbG90cy5zZXQoZGF0ZS5nZXRUaW1lKCksIHN1bUNvbnN1bWVyc0FmdGVyKTtcclxuICAgICAgICAgICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgY29uc3VtZXJFYW5zLmxlbmd0aDsgKytqKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3VtZXJFYW5zW2pdLm1pc3NlZER1ZVRvQWxsb2NhdGlvbiArPSBjb25zdW1lZFtqXS5hZnRlciAqIG1pc3NlZFNjYWxlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHN1bVNoYXJlZERpc3RyaWJ1dGVkID0gZGlzdHJpYnV0ZWQucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgKHZhbC5iZWZvcmUgLSB2YWwuYWZ0ZXIpLCAwKTtcclxuICAgICAgICBhc3NlcnQoc3VtU2hhcmVkRGlzdHJpYnV0ZWQgPj0gMCwgc3VtU2hhcmVkRGlzdHJpYnV0ZWQsIFwiTGluZVwiLCBpKTtcclxuICAgICAgICBjb25zdCBzdW1TaGFyZWRDb25zdW1lZCA9IGNvbnN1bWVkLnJlZHVjZSgoYWNjLCB2YWwpID0+IGFjYyArICh2YWwuYmVmb3JlIC0gdmFsLmFmdGVyKSwgMCk7XHJcbiAgICAgICAgYXNzZXJ0KHN1bVNoYXJlZENvbnN1bWVkID49IDAsIHN1bVNoYXJlZENvbnN1bWVkLCBcIkxpbmVcIiwgaSk7XHJcbiAgICAgICAgaWYgKE1hdGguYWJzKHN1bVNoYXJlZERpc3RyaWJ1dGVkIC0gc3VtU2hhcmVkQ29uc3VtZWQpID4gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgIGxvZ1dhcm5pbmcoXHJcbiAgICAgICAgICAgICAgICBgRW5lcmd5IHNoYXJlZCBmcm9tIGRpc3RyaWJ1dG9ycyBkb2VzIG5vdCBtYXRjaCBlbmVyZ3kgc2hhcmVkIHRvIGNvbnN1bWVycyBvbiAke3ByaW50RGF0ZShkYXRlKX0hIFxcbkRpc3RyaWJ1dGVkOiAke3N1bVNoYXJlZERpc3RyaWJ1dGVkfVxcbiBDb25zdW1lZDogJHtzdW1TaGFyZWRDb25zdW1lZH0uXHJcbiAgICAgICAgICAgICAgICBUaGUgcmVwb3J0IHdpbGwgY29uc2lkZXIgdGhlIG1pc21hdGNoIG5vdCBzaGFyZWQuYCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKHN1bVNoYXJlZERpc3RyaWJ1dGVkID4gc3VtU2hhcmVkQ29uc3VtZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpeERpc3RyaWJ1dG9ycyA9IHN1bVNoYXJlZENvbnN1bWVkIC8gc3VtU2hhcmVkRGlzdHJpYnV0ZWQ7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhcIkZpeGluZyBkaXN0cmlidXRvcnNcIiwgZml4RGlzdHJpYnV0b3JzKTtcclxuICAgICAgICAgICAgICAgIGFzc2VydChcclxuICAgICAgICAgICAgICAgICAgICBmaXhEaXN0cmlidXRvcnMgPD0gMSAmJiBmaXhEaXN0cmlidXRvcnMgPj0gMCAmJiAhaXNOYU4oZml4RGlzdHJpYnV0b3JzKSxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWRDb25zdW1lZCxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWREaXN0cmlidXRlZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGogb2YgZGlzdHJpYnV0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBqLmFmdGVyICo9IGZpeERpc3RyaWJ1dG9ycztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpeENvbnN1bWVycyA9IHN1bVNoYXJlZERpc3RyaWJ1dGVkIC8gc3VtU2hhcmVkQ29uc3VtZWQ7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhcIkZpeGluZyBjb25zdW1lcnNcIiwgZml4Q29uc3VtZXJzKTtcclxuICAgICAgICAgICAgICAgIGFzc2VydChcclxuICAgICAgICAgICAgICAgICAgICBmaXhDb25zdW1lcnMgPD0gMSAmJiBmaXhDb25zdW1lcnMgPj0gMCAmJiAhaXNOYU4oZml4Q29uc3VtZXJzKSxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWREaXN0cmlidXRlZCxcclxuICAgICAgICAgICAgICAgICAgICBzdW1TaGFyZWRDb25zdW1lZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGogb2YgY29uc3VtZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBqLmFmdGVyICo9IGZpeENvbnN1bWVycztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaW50ZXJ2YWxzLnB1c2goe1xyXG4gICAgICAgICAgICBzdGFydDogZGF0ZSxcclxuICAgICAgICAgICAgc3VtU2hhcmluZzogZGlzdHJpYnV0ZWQucmVkdWNlKChhY2MsIHZhbCkgPT4gYWNjICsgKHZhbC5iZWZvcmUgLSB2YWwuYWZ0ZXIpLCAwKSxcclxuICAgICAgICAgICAgZGlzdHJpYnV0aW9uczogZGlzdHJpYnV0ZWQsXHJcbiAgICAgICAgICAgIGNvbnN1bWVyczogY29uc3VtZWQsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IENzdihmaWxlbmFtZSwgaW50ZXJ2YWxzKTtcclxuXHJcbiAgICByZXN1bHQuZGlzdHJpYnV0aW9uRWFucyA9IGRpc3RyaWJ1dG9yRWFucztcclxuICAgIHJlc3VsdC5jb25zdW1lckVhbnMgPSBjb25zdW1lckVhbnM7XHJcblxyXG4gICAgcmVzdWx0LnNoYXJlZFRvdGFsID0gZGlzdHJpYnV0b3JFYW5zLnJlZHVjZShcclxuICAgICAgICAoYWNjLCB2YWwpID0+IGFjYyArIHZhbC5vcmlnaW5hbEJhbGFuY2UgLSB2YWwuYWRqdXN0ZWRCYWxhbmNlLFxyXG4gICAgICAgIDAsXHJcbiAgICApO1xyXG4gICAgcmVzdWx0Lm1pc3NlZFRvdGFsID0gY29uc3VtZXJFYW5zLnJlZHVjZSgoYWNjLCB2YWwpID0+IGFjYyArIHZhbC5taXNzZWREdWVUb0FsbG9jYXRpb24sIDApO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sb3JpemVSYW5nZShxdWVyeTogc3RyaW5nLCByZ2I6IFJnYik6IHZvaWQge1xyXG4gICAgY29uc3QgY29sbGVjdGlvbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwocXVlcnkpO1xyXG4gICAgLy8gY29uc29sZS5sb2cocXVlcnkpO1xyXG4gICAgLy8gY29uc29sZS5sb2coY29sbGVjdGlvbik7XHJcbiAgICAvLyBsZXQgbWluaW11bSA9IEluZmluaXR5O1xyXG4gICAgbGV0IG1pbmltdW0gPSAwOyAvLyBJdCB3b3JrcyBiZXR0ZXIgd2l0aCBmaWx0ZXJpbmcgaWYgbWluaW11bSBpcyBhbHdheXMgMFxyXG4gICAgbGV0IG1heGltdW0gPSAwO1xyXG4gICAgZm9yIChjb25zdCBpIG9mIGNvbGxlY3Rpb24pIHtcclxuICAgICAgICBjb25zdCB2YWx1ZSA9IHBhcnNlRmxvYXQoKGkgYXMgSFRNTEVsZW1lbnQpLmlubmVyVGV4dCk7XHJcbiAgICAgICAgbWF4aW11bSA9IE1hdGgubWF4KG1heGltdW0sIHZhbHVlKTtcclxuICAgICAgICBtaW5pbXVtID0gTWF0aC5taW4obWluaW11bSwgdmFsdWUpO1xyXG4gICAgfVxyXG4gICAgLy8gY29uc29sZS5sb2cobWluaW11bSwgbWF4aW11bSk7XHJcbiAgICBhc3NlcnQoIWlzTmFOKG1heGltdW0pLCBgVGhlcmUgaXMgYSBOYU4gd2hlbiBjb2xvcml6aW5nIHF1ZXJ5JHtxdWVyeX1gKTtcclxuICAgIC8vIGNvbnNvbGUubG9nKFwiQ29sb3JpemluZyB3aXRoIG1heGltdW1cIiwgbWF4aW11bSk7XHJcbiAgICBmb3IgKGNvbnN0IGkgb2YgY29sbGVjdGlvbikge1xyXG4gICAgICAgIGNvbnN0IGh0bWxFbGVtZW50ID0gaSBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICBjb25zdCBhbHBoYSA9IChwYXJzZUZsb2F0KGh0bWxFbGVtZW50LmlubmVyVGV4dCkgLSBtaW5pbXVtKSAvIE1hdGgubWF4KDAuMDAwMDEsIG1heGltdW0gLSBtaW5pbXVtKTtcclxuICAgICAgICAvLyBjb25zb2xlLmxvZyhodG1sRWxlbWVudCk7XHJcbiAgICAgICAgYXNzZXJ0KCFpc05hTihhbHBoYSksIFwiVGhlcmUgaXMgTmFOIHNvbWV3aGVyZSBpbiBkYXRhXCIsIGFscGhhKTtcclxuICAgICAgICBjb25zdCBjc3NTdHJpbmcgPSBgcmdiYSgke3JnYlswXX0sICR7cmdiWzFdfSwgJHtyZ2JbMl19LCAke2FscGhhfSlgO1xyXG4gICAgICAgIC8vIGNvbnNvbGUubG9nKGNzc1N0cmluZyk7XHJcbiAgICAgICAgaHRtbEVsZW1lbnQuc3R5bGUuYmFja2dyb3VuZENvbG9yID0gY3NzU3RyaW5nO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZWNhbGxFYW5BbGlhcyhlYW46IEVhbik6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYEVBTl9hbGlhc18ke2Vhbi5uYW1lfWApID8/IFwiXCI7XHJcbn1cclxuZnVuY3Rpb24gc2F2ZUVhbkFsaWFzKGVhbjogRWFuLCBhbGlhczogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgRUFOX2FsaWFzXyR7ZWFuLm5hbWV9YCwgYWxpYXMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXR1cEhlYWRlcih0YWJsZTogSFRNTFRhYmxlRWxlbWVudCwgY3N2OiBDc3YsIGVkaXRhYmxlTmFtZXM6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgICh0YWJsZS5xdWVyeVNlbGVjdG9yKFwidGguZGlzdHJpYnV0aW9uSGVhZGVyXCIpIGFzIEhUTUxUYWJsZUNlbGxFbGVtZW50KS5jb2xTcGFuID1cclxuICAgICAgICBjc3YuZGlzdHJpYnV0aW9uRWFucy5sZW5ndGg7XHJcbiAgICAodGFibGUucXVlcnlTZWxlY3RvcihcInRoLmNvbnN1bWVySGVhZGVyXCIpIGFzIEhUTUxUYWJsZUNlbGxFbGVtZW50KS5jb2xTcGFuID0gY3N2LmNvbnN1bWVyRWFucy5sZW5ndGg7XHJcblxyXG4gICAgY29uc3QgdGhlYWRlciA9IHRhYmxlLnF1ZXJ5U2VsZWN0b3IoXCJ0ci5jc3ZIZWFkZXJSb3dcIikgYXMgSFRNTFRhYmxlUm93RWxlbWVudDtcclxuICAgIGFzc2VydCh0aGVhZGVyICE9PSBudWxsKTtcclxuICAgIHRoZWFkZXIuaW5uZXJIVE1MID0gXCI8dGg+RUFOPC90aD5cIjtcclxuXHJcbiAgICBjb25zdCBjcmVhdGVDZWxsID0gKGRvbUNsYXNzOiBzdHJpbmcsIGVhbjogRWFuKTogdm9pZCA9PiB7XHJcbiAgICAgICAgY29uc3QgdGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwidGhcIik7XHJcbiAgICAgICAgdGguY2xhc3NMaXN0LmFkZChkb21DbGFzcyk7XHJcbiAgICAgICAgdGguaW5uZXJUZXh0ID0gcHJpbnRFYW4oZWFuLm5hbWUpO1xyXG4gICAgICAgIGlmIChlZGl0YWJsZU5hbWVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xyXG4gICAgICAgICAgICBpbnB1dC50eXBlID0gXCJ0ZXh0XCI7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVjYWxsRWFuQWxpYXMoZWFuKTtcclxuICAgICAgICAgICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBzYXZlRWFuQWxpYXMoZWFuLCBpbnB1dC52YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICByZWZyZXNoVmlldygpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgdGguYXBwZW5kQ2hpbGQoaW5wdXQpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2FsbGVkID0gcmVjYWxsRWFuQWxpYXMoZWFuKTtcclxuICAgICAgICAgICAgaWYgKHJlY2FsbGVkLmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgICAgICAgIHRoLmlubmVySFRNTCArPSBgPGJyPigke3JlY2FsbGVkfSlgO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRoZWFkZXIuYXBwZW5kQ2hpbGQodGgpO1xyXG4gICAgfTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IGVhbiBvZiBjc3YuZGlzdHJpYnV0aW9uRWFucykge1xyXG4gICAgICAgIGNyZWF0ZUNlbGwoXCJkaXN0cmlidXRpb25cIiwgZWFuKTtcclxuICAgIH1cclxuICAgIHRoZWFkZXIuaW5zZXJ0Q2VsbCgpLmNsYXNzTGlzdC5hZGQoXCJzcGxpdFwiKTtcclxuICAgIGZvciAoY29uc3QgZWFuIG9mIGNzdi5jb25zdW1lckVhbnMpIHtcclxuICAgICAgICBjcmVhdGVDZWxsKFwiY29uc3VtZXJcIiwgZWFuKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcHJpbnRPbmx5RGF0ZShkYXRlOiBEYXRlKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBgJHtkYXRlLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGRhdGUuZ2V0TW9udGgoKSArIDEpLnBhZFN0YXJ0KDIsIFwiMFwiKX0tJHtTdHJpbmcoZGF0ZS5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xyXG59XHJcbmZ1bmN0aW9uIHByaW50RGF0ZShkYXRlOiBEYXRlKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBgJHtwcmludE9ubHlEYXRlKGRhdGUpfSAke1N0cmluZyhkYXRlLmdldEhvdXJzKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtTdHJpbmcoZGF0ZS5nZXRNaW51dGVzKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkaXNwbGF5Q3N2KGNzdjogQ3N2KTogdm9pZCB7XHJcbiAgICBjb25zdCBzdGFydFRpbWUgPSBwZXJmb3JtYW5jZS5ub3coKTtcclxuICAgIGFzc2VydChnU2V0dGluZ3MuZmlsdGVyVmFsdWUgPj0gMCAmJiBnU2V0dGluZ3MuZmlsdGVyVmFsdWUgPD0gMSk7XHJcbiAgICBjb25zdCBHUkVFTiA9IFsxNCwgMTc3LCAxNF0gYXMgUmdiO1xyXG4gICAgY29uc3QgUkVEID0gWzI1NSwgMzUsIDM1XSBhcyBSZ2I7XHJcbiAgICBjb25zdCBHUkFZID0gWzE1MCwgMTUwLCAxNTBdIGFzIFJnYjtcclxuXHJcbiAgICB7XHJcbiAgICAgICAgLy8gSW5wdXQgZGF0YVxyXG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiZmlsZW5hbWVcIikhLmlubmVyVGV4dCA9IGNzdi5maWxlbmFtZTtcclxuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImludGVydmFsRnJvbVwiKSEuaW5uZXJUZXh0ID0gcHJpbnREYXRlKGNzdi5kYXRlRnJvbSk7XHJcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJpbnRlcnZhbFRvXCIpIS5pbm5lclRleHQgPSBwcmludERhdGUoY3N2LmRhdGVUbyk7XHJcbiAgICB9XHJcblxyXG4gICAge1xyXG4gICAgICAgIC8vIFN1bW1hcnlcclxuICAgICAgICBzZXR1cEhlYWRlcihkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNzdlwiKSBhcyBIVE1MVGFibGVFbGVtZW50LCBjc3YsIHRydWUpO1xyXG4gICAgICAgIGNvbnN0IHRib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjc3ZCb2R5XCIpO1xyXG4gICAgICAgIGFzc2VydCh0Ym9keSAhPT0gbnVsbCk7XHJcbiAgICAgICAgdGJvZHkuaW5uZXJIVE1MID0gXCJcIjtcclxuXHJcbiAgICAgICAgbGV0IHJvd0lkID0gMDtcclxuICAgICAgICBjb25zdCBtYWtlUm93ID0gKGhlYWRlcjogc3RyaW5nLCBiYWNrZ3JvdW5kQ29sb3I6IFJnYiwgcHJpbnRGbjogKGVhbjogRWFuKSA9PiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRyXCIpO1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IGByb3cke3Jvd0lkKyt9YDtcclxuICAgICAgICAgICAgcm93LmNsYXNzTGlzdC5hZGQoaWQpO1xyXG4gICAgICAgICAgICBjb25zdCB0aCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ0aFwiKTtcclxuICAgICAgICAgICAgcm93LmFwcGVuZENoaWxkKHRoKTtcclxuICAgICAgICAgICAgdGguaW5uZXJIVE1MID0gaGVhZGVyO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGVhbiBvZiBjc3YuZGlzdHJpYnV0aW9uRWFucykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2VsbCA9IHJvdy5pbnNlcnRDZWxsKCk7XHJcbiAgICAgICAgICAgICAgICBjZWxsLmlubmVySFRNTCA9IHByaW50Rm4oZWFuKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuY2xhc3NMaXN0LmFkZChcImRpc3RyaWJ1dGlvblwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByb3cuaW5zZXJ0Q2VsbCgpLmNsYXNzTGlzdC5hZGQoXCJzcGxpdFwiKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBlYW4gb2YgY3N2LmNvbnN1bWVyRWFucykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2VsbCA9IHJvdy5pbnNlcnRDZWxsKCk7XHJcbiAgICAgICAgICAgICAgICBjZWxsLmlubmVySFRNTCA9IHByaW50Rm4oZWFuKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuY2xhc3NMaXN0LmFkZChcImNvbnN1bWVyXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRib2R5LmFwcGVuZENoaWxkKHJvdyk7XHJcbiAgICAgICAgICAgIGNvbG9yaXplUmFuZ2UoYHRhYmxlI2NzdiB0ci4ke2lkfSB0ZC5jb25zdW1lcmAsIGJhY2tncm91bmRDb2xvcik7XHJcbiAgICAgICAgICAgIGNvbG9yaXplUmFuZ2UoYHRhYmxlI2NzdiB0ci4ke2lkfSB0ZC5kaXN0cmlidXRpb25gLCBiYWNrZ3JvdW5kQ29sb3IpO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIG1ha2VSb3coXCJPcmlnaW5hbCBba1doXTpcIiwgR1JBWSwgKGVhbikgPT4gcHJpbnRLV2goZWFuLm9yaWdpbmFsQmFsYW5jZSwgdHJ1ZSkpO1xyXG4gICAgICAgIG1ha2VSb3coXCJBZGp1c3RlZCBba1doXTpcIiwgR1JBWSwgKGVhbikgPT4gcHJpbnRLV2goZWFuLmFkanVzdGVkQmFsYW5jZSwgdHJ1ZSkpO1xyXG4gICAgICAgIG1ha2VSb3coXCJTaGFyZWQgW2tXaF06XCIsIEdSRUVOLCAoZWFuKSA9PiBwcmludEtXaChlYW4ub3JpZ2luYWxCYWxhbmNlIC0gZWFuLmFkanVzdGVkQmFsYW5jZSwgdHJ1ZSkpO1xyXG4gICAgICAgIG1ha2VSb3coXCJNaXNzZWQgW2tXaF06XCIsIFJFRCwgKGVhbikgPT4gcHJpbnRLV2goZWFuLm1pc3NlZER1ZVRvQWxsb2NhdGlvbiwgdHJ1ZSkpO1xyXG4gICAgfVxyXG5cclxuICAgIGxldCBtaW5TaGFyaW5nRGlzdHJpYnV0b3IgPSBJbmZpbml0eTtcclxuICAgIGxldCBtYXhTaGFyaW5nRGlzdHJpYnV0b3IgPSAwO1xyXG4gICAgbGV0IG1pblNoYXJpbmdDb25zdW1lciA9IEluZmluaXR5O1xyXG4gICAgbGV0IG1heFNoYXJpbmdDb25zdW1lciA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IGludGVydmFsIG9mIGNzdi5pbnRlcnZhbHMpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGkgb2YgaW50ZXJ2YWwuZGlzdHJpYnV0aW9ucykge1xyXG4gICAgICAgICAgICBjb25zdCBzaGFyaW5nID0gaS5iZWZvcmUgLSBpLmFmdGVyO1xyXG4gICAgICAgICAgICBtYXhTaGFyaW5nRGlzdHJpYnV0b3IgPSBNYXRoLm1heChtYXhTaGFyaW5nRGlzdHJpYnV0b3IsIHNoYXJpbmcpO1xyXG4gICAgICAgICAgICBtaW5TaGFyaW5nRGlzdHJpYnV0b3IgPSBNYXRoLm1pbihtaW5TaGFyaW5nRGlzdHJpYnV0b3IsIHNoYXJpbmcpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGkgb2YgaW50ZXJ2YWwuY29uc3VtZXJzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNoYXJpbmcgPSBpLmJlZm9yZSAtIGkuYWZ0ZXI7XHJcbiAgICAgICAgICAgIG1heFNoYXJpbmdDb25zdW1lciA9IE1hdGgubWF4KG1heFNoYXJpbmdDb25zdW1lciwgc2hhcmluZyk7XHJcbiAgICAgICAgICAgIG1pblNoYXJpbmdDb25zdW1lciA9IE1hdGgubWluKG1pblNoYXJpbmdDb25zdW1lciwgc2hhcmluZyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1heFNoYXJpbmdJbnRlcnZhbCA9IGNzdi5pbnRlcnZhbHMucmVkdWNlKChhY2MsIHZhbCkgPT4gTWF0aC5tYXgoYWNjLCB2YWwuc3VtU2hhcmluZyksIDApO1xyXG4gICAgY29uc3QgbWluU2hhcmluZ0ludGVydmFsID0gY3N2LmludGVydmFscy5yZWR1Y2UoKGFjYywgdmFsKSA9PiBNYXRoLm1pbihhY2MsIHZhbC5zdW1TaGFyaW5nKSwgSW5maW5pdHkpO1xyXG4gICAgY29uc3QgaW50ZXJ2YWxUYWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiaW50ZXJ2YWxzXCIpO1xyXG4gICAgY29uc3QgaW50ZXJ2YWxCb2R5ID0gaW50ZXJ2YWxUYWJsZSEucXVlcnlTZWxlY3RvcihcInRib2R5XCIpITtcclxuICAgIGludGVydmFsQm9keS5pbm5lckhUTUwgPSBcIlwiO1xyXG4gICAgLy8gSW50ZXJ2YWxzXHJcbiAgICBzZXR1cEhlYWRlcihkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImludGVydmFsc1wiKSBhcyBIVE1MVGFibGVFbGVtZW50LCBjc3YsIGZhbHNlKTtcclxuXHJcbiAgICBsZXQgbGFzdERpc3BsYXllZDogbnVsbCB8IEludGVydmFsID0gbnVsbDtcclxuXHJcbiAgICBmb3IgKGxldCBpbnRlcnZhbEluZGV4ID0gMDsgaW50ZXJ2YWxJbmRleCA8IGNzdi5pbnRlcnZhbHMubGVuZ3RoOyArK2ludGVydmFsSW5kZXgpIHtcclxuICAgICAgICBjb25zdCBpbnRlcnZhbCA9IGNzdi5pbnRlcnZhbHNbaW50ZXJ2YWxJbmRleF07XHJcblxyXG4gICAgICAgIGlmIChcclxuICAgICAgICAgICAgaW50ZXJ2YWxJbmRleCAhPT0gY3N2LmludGVydmFscy5sZW5ndGggLSAxICYmXHJcbiAgICAgICAgICAgIGludGVydmFsLnN0YXJ0LmdldERhdGUoKSAhPT0gY3N2LmludGVydmFsc1tpbnRlcnZhbEluZGV4ICsgMV0uc3RhcnQuZ2V0RGF0ZSgpXHJcbiAgICAgICAgKSB7XHJcbiAgICAgICAgICAgIC8vIExhc3QgaW50ZXJ2YWwgb2YgdGhlIGRheVxyXG4gICAgICAgICAgICBpZiAoIWxhc3REaXNwbGF5ZWQgfHwgaW50ZXJ2YWwuc3RhcnQuZ2V0RGF0ZSgpICE9PSBsYXN0RGlzcGxheWVkLnN0YXJ0LmdldERhdGUoKSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc2VwYXJhdG9yID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRyXCIpO1xyXG4gICAgICAgICAgICAgICAgc2VwYXJhdG9yLmNsYXNzTGlzdC5hZGQoXCJkYXlTZXBhcmF0b3JcIik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0aCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ0aFwiKTtcclxuICAgICAgICAgICAgICAgIHRoLmlubmVySFRNTCA9IHByaW50T25seURhdGUoaW50ZXJ2YWwuc3RhcnQpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdGQyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInRkXCIpO1xyXG4gICAgICAgICAgICAgICAgdGQyLmNvbFNwYW4gPSBjc3YuZGlzdHJpYnV0aW9uRWFucy5sZW5ndGggKyBjc3YuY29uc3VtZXJFYW5zLmxlbmd0aCArIDE7XHJcbiAgICAgICAgICAgICAgICB0ZDIuaW5uZXJIVE1MID0gXCJBbGwgRmlsdGVyZWQgb3V0XCI7XHJcbiAgICAgICAgICAgICAgICBzZXBhcmF0b3IuYXBwZW5kQ2hpbGQodGgpO1xyXG4gICAgICAgICAgICAgICAgc2VwYXJhdG9yLmFwcGVuZENoaWxkKHRkMik7XHJcbiAgICAgICAgICAgICAgICBpbnRlcnZhbEJvZHkuYXBwZW5kQ2hpbGQoc2VwYXJhdG9yKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGludGVydmFsLnN1bVNoYXJpbmcgPCBtYXhTaGFyaW5nSW50ZXJ2YWwgKiBnU2V0dGluZ3MuZmlsdGVyVmFsdWUpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxhc3REaXNwbGF5ZWQgPSBpbnRlcnZhbDtcclxuICAgICAgICBjb25zdCB0ciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ0clwiKTtcclxuXHJcbiAgICAgICAgLy8gT3B0aW1pemF0aW9uOiBkbyBub3QgdXNlIGNvbG9yaXplUmFuZ2UoKVxyXG4gICAgICAgIGNvbnN0IGdldEJhY2tncm91bmQgPSAodmFsdWU6IG51bWJlciwgbWluaW11bTogbnVtYmVyLCBtYXhpbXVtOiBudW1iZXIpOiBzdHJpbmcgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBhbHBoYSA9ICh2YWx1ZSAtIG1pbmltdW0pIC8gTWF0aC5tYXgoMC4wMDAwMSwgbWF4aW11bSAtIG1pbmltdW0pO1xyXG4gICAgICAgICAgICByZXR1cm4gYHJnYmEoJHtHUkVFTlswXX0sICR7R1JFRU5bMV19LCAke0dSRUVOWzJdfSwgJHthbHBoYX0pYDtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBpZiAoMSkge1xyXG4gICAgICAgICAgICAvLyBTcGVlZCBvcHRpbWl6YXRpb25cclxuICAgICAgICAgICAgdHIuaW5uZXJIVE1MID0gYDx0aD4ke3ByaW50RGF0ZShpbnRlcnZhbC5zdGFydCl9IC0gJHtTdHJpbmcoaW50ZXJ2YWwuc3RhcnQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgXCIwXCIpfToke1N0cmluZyhpbnRlcnZhbC5zdGFydC5nZXRNaW51dGVzKCkgKyAxNCkucGFkU3RhcnQoMiwgXCIwXCIpfTwvdGg+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAke2ludGVydmFsLmRpc3RyaWJ1dGlvbnMubWFwKChpKSA9PiBgPHRkIGNsYXNzPSdkaXN0cmlidXRpb24nIHN0eWxlPVwiYmFja2dyb3VuZC1jb2xvcjoke2dldEJhY2tncm91bmQoaS5iZWZvcmUgLSBpLmFmdGVyLCBtaW5TaGFyaW5nRGlzdHJpYnV0b3IsIG1heFNoYXJpbmdEaXN0cmlidXRvcil9XCI+JHtwcmludEtXaChpLmJlZm9yZSAtIGkuYWZ0ZXIpfTwvdGQ+YCkuam9pbihcIlwiKX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDx0ZCBjbGFzcz0nc3BsaXQnPjwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAke2ludGVydmFsLmNvbnN1bWVycy5tYXAoKGkpID0+IGA8dGQgY2xhc3M9J2NvbnN1bWVyJyBzdHlsZT1cImJhY2tncm91bmQtY29sb3I6JHtnZXRCYWNrZ3JvdW5kKGkuYmVmb3JlIC0gaS5hZnRlciwgbWluU2hhcmluZ0NvbnN1bWVyLCBtYXhTaGFyaW5nQ29uc3VtZXIpfVwiPiR7cHJpbnRLV2goaS5iZWZvcmUgLSBpLmFmdGVyKX08L3RkPmApLmpvaW4oXCJcIil9YDtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCB0aCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ0aFwiKTtcclxuICAgICAgICAgICAgdHIuYXBwZW5kQ2hpbGQodGgpO1xyXG4gICAgICAgICAgICB0aC5pbm5lckhUTUwgPSBgJHtwcmludERhdGUoaW50ZXJ2YWwuc3RhcnQpfSAtICR7U3RyaW5nKGludGVydmFsLnN0YXJ0LmdldEhvdXJzKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtTdHJpbmcoaW50ZXJ2YWwuc3RhcnQuZ2V0TWludXRlcygpICsgMTQpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xyXG5cclxuICAgICAgICAgICAgZm9yIChjb25zdCBpIG9mIGludGVydmFsLmRpc3RyaWJ1dGlvbnMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNlbGwgPSB0ci5pbnNlcnRDZWxsKCk7XHJcbiAgICAgICAgICAgICAgICBjZWxsLmlubmVySFRNTCA9IHByaW50S1doKGkuYmVmb3JlIC0gaS5hZnRlcik7XHJcbiAgICAgICAgICAgICAgICBjZWxsLmNsYXNzTGlzdC5hZGQoXCJkaXN0cmlidXRpb25cIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdHIuaW5zZXJ0Q2VsbCgpLmNsYXNzTGlzdC5hZGQoXCJzcGxpdFwiKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBpIG9mIGludGVydmFsLmNvbnN1bWVycykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2VsbCA9IHRyLmluc2VydENlbGwoKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuaW5uZXJIVE1MID0gcHJpbnRLV2goaS5iZWZvcmUgLSBpLmFmdGVyKTtcclxuICAgICAgICAgICAgICAgIGNlbGwuY2xhc3NMaXN0LmFkZChcImNvbnN1bWVyXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVydmFsQm9keS5hcHBlbmRDaGlsZCh0cik7XHJcbiAgICB9XHJcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1pbkZpbHRlclwiKSEuaW5uZXJIVE1MID0gcHJpbnRLV2gobWluU2hhcmluZ0ludGVydmFsKTtcclxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWF4RmlsdGVyXCIpIS5pbm5lckhUTUwgPSBwcmludEtXaChtYXhTaGFyaW5nSW50ZXJ2YWwpO1xyXG5cclxuICAgIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRocmVzaG9sZEZpbHRlclwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5pbm5lckhUTUwgPSBwcmludEtXaChcclxuICAgICAgICBtYXhTaGFyaW5nSW50ZXJ2YWwgKiBnU2V0dGluZ3MuZmlsdGVyVmFsdWUsXHJcbiAgICApO1xyXG5cclxuICAgIC8vIGNvbnNvbGUubG9nKFwiQ29sb3JpemluZyB0YWJsZSNpbnRlcnZhbHMgdGQuY29uc3VtZXJcIik7XHJcbiAgICBjb2xvcml6ZVJhbmdlKFwidGFibGUjaW50ZXJ2YWxzIHRkLmNvbnN1bWVyXCIsIEdSRUVOKTtcclxuICAgIC8vIGNvbnNvbGUubG9nKFwiQ29sb3JpemluZyB0YWJsZSNpbnRlcnZhbHMgdGQuZGlzdHJpYnV0aW9uXCIpO1xyXG4gICAgY29sb3JpemVSYW5nZShcInRhYmxlI2ludGVydmFscyB0ZC5kaXN0cmlidXRpb25cIiwgR1JFRU4pO1xyXG5cclxuICAgIGNvbnNvbGUubG9nKFwiZGlzcGxheUNzdiB0b29rXCIsIHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnRUaW1lLCBcIm1zXCIpO1xyXG59XHJcblxyXG5sZXQgZ0NzdjogQ3N2IHwgbnVsbCA9IG51bGw7XHJcblxyXG5mdW5jdGlvbiByZWZyZXNoVmlldygpOiB2b2lkIHtcclxuICAgIGlmIChnQ3N2KSB7XHJcbiAgICAgICAgZGlzcGxheUNzdihnQ3N2KTtcclxuICAgIH1cclxufVxyXG5cclxuZmlsZURvbS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcclxuICAgIGlmIChmaWxlRG9tLmZpbGVzPy5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICB3YXJuaW5nRG9tLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcclxuICAgICAgICB3YXJuaW5nRG9tLmlubmVySFRNTCA9IFwiXCI7XHJcbiAgICAgICAgZmlsdGVyRG9tLnZhbHVlID0gXCI5OVwiO1xyXG4gICAgICAgIGZpbHRlckRvbS5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcclxuICAgICAgICByZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRlbmRcIiwgKCkgPT4ge1xyXG4gICAgICAgICAgICBnQ3N2ID0gcGFyc2VDc3YocmVhZGVyLnJlc3VsdCBhcyBzdHJpbmcsIGZpbGVEb20uZmlsZXMhWzBdLm5hbWUpO1xyXG4gICAgICAgICAgICByZWZyZXNoVmlldygpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlYWRlci5yZWFkQXNUZXh0KGZpbGVEb20uZmlsZXNbMF0pOyAvLyBSZWFkIGZpbGUgYXMgdGV4dFxyXG4gICAgfVxyXG59KTtcclxuZmlsdGVyRG9tLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XHJcbiAgICAvLyBjb25zb2xlLmxvZyhcImZpbHRlckRvbSBJTlBVVFwiKTtcclxuICAgIGdTZXR0aW5ncy5maWx0ZXJWYWx1ZSA9IDEgLSBwYXJzZUludChmaWx0ZXJEb20udmFsdWUsIDEwKSAvIDEwMDtcclxuICAgIHJlZnJlc2hWaWV3KCk7XHJcbn0pO1xyXG5kb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImhpZGVFYW5zXCIpIS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcclxuICAgIGdTZXR0aW5ncy5oaWRlRWFucyA9IChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImhpZGVFYW5zXCIpIGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQ7XHJcbiAgICByZWZyZXNoVmlldygpO1xyXG59KTtcclxuZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW5wdXRbbmFtZT1cInVuaXRcIl0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsIChlKSA9PiB7XHJcbiAgICAgICAgZ1NldHRpbmdzLmRpc3BsYXlVbml0ID0gKGUudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlIGFzIFwia1doXCIgfCBcImtXXCI7XHJcbiAgICAgICAgcmVmcmVzaFZpZXcoKTtcclxuICAgIH0pO1xyXG59KTtcclxuXHJcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdW51c2VkLXZhcnNcclxuZXhwb3J0IGZ1bmN0aW9uIG1vY2soKTogdm9pZCB7XHJcbiAgICAvLyBUZXN0aW5nIGRhdGFcclxuICAgIGdDc3YgPSBwYXJzZUNzdihcclxuICAgICAgICBgRGF0dW07Q2FzIG9kO0NhcyBkbztJTi04NTkxODI0MDAwMDAwMDAwMDEtRDtPVVQtODU5MTgyNDAwMDAwMDAwMDAxLUQ7SU4tODU5MTgyNDAwMDAwMDAwMDAyLU87T1VULTg1OTE4MjQwMDAwMDAwMDAwMi1PO0lOLTg1OTE4MjQwMDAwMDAwMDAwMy1PO09VVC04NTkxODI0MDAwMDAwMDAwMDMtTztJTi04NTkxODI0MDAwMDAwMDAwMDQtTztPVVQtODU5MTgyNDAwMDAwMDAwMDA0LU87SU4tODU5MTgyNDAwMDAwMDAwMDA1LU87T1VULTg1OTE4MjQwMDAwMDAwMDAwNS1PO0lOLTg1OTE4MjQwMDAwMDAwMDAwNi1PO09VVC04NTkxODI0MDAwMDAwMDAwMDYtTztJTi04NTkxODI0MDAwMDAwMDAwMDctTztPVVQtODU5MTgyNDAwMDAwMDAwMDA3LU9cclxuMDUuMDIuMjAyNTsxMTowMDsxMToxNTswLDAzOzAsMDM7LTAsNzQ7LTAsNzQ7LTAsMTstMCwxOy0wLDUzOy0wLDUzOzAsMDswLDA7MCwwOzAsMDstMCwxODstMCwxODtcclxuMDUuMDIuMjAyNTsxMToxNTsxMTozMDswLDgzOzAsMTQ7LTAsNzQ7LTAsNTY7LTAsMDk7MCwwOy0wLDQ4Oy0wLDE7MCwwOzAsMDstMCwwMTswLDA7LTAsMDM7MCwwO1xyXG4wNS4wMi4yMDI1OzExOjMwOzExOjQ1OzEsMjswLDE1Oy0wLDY3Oy0wLDQxOy0wLDI7MCwwOy0wLDU2Oy0wLDAzOzAsMDswLDA7LTAsMDI7MCwwOy0wLDA0OzAsMDtcclxuMDUuMDIuMjAyNTsxMTo0NTsxMjowMDsxLDE0OzAsMjQ7LTAsMDc7MCwwOy0wLDI1OzAsMDstMCw2OTstMCwxNTswLDA7MCwwOy0wLDAxOzAsMDstMCwwMzswLDA7XHJcbjA1LjAyLjIwMjU7MTI6MDA7MTI6MTU7MSwxODswLDE1Oy0wLDM1Oy0wLDEyOy0wLDI0OzAsMDstMCw4MzstMCwzMzswLDA7MCwwOy0wLDAyOzAsMDstMCwwNDswLDA7XHJcbjA1LjAyLjIwMjU7MTI6MTU7MTI6MzA7MCw5MTswLDIyOy0wLDI0Oy0wLDA0Oy0wLDI3OzAsMDstMCwxODswLDA7MCwwOzAsMDswLDA7MCwwOy0wLDA0OzAsMDtcclxuMDUuMDIuMjAyNTsxMjozMDsxMjo0NTswLDgzOzAsMTU7LTAsMzk7LTAsMjQ7LTAsMjk7MCwwOy0wLDExOzAsMDswLDA7MCwwOy0wLDAxOzAsMDstMCwxMjswLDA7XHJcbjA1LjAyLjIwMjU7MTI6NDU7MTM6MDA7MSwwNTswLDAzOy0xLDEzOy0wLDk2Oy0wLDU2Oy0wLDI7LTAsMTE7MCwwOzAsMDswLDA7LTAsMDI7MCwwOy0wLDQ4Oy0wLDEyO1xyXG4wNS4wMi4yMDI1OzEzOjAwOzEzOjE1OzEsMDI7MCwwNDstMCwyNDstMCwwNzstMCw2MzstMCwyODstMCwxMjswLDA7MCwwOzAsMDswLDA7MCwwOy0wLDM0OzAsMDtcclxuMDUuMDIuMjAyNTsxMzoxNTsxMzozMDsxLDA7MCwzMzstMCwyNjstMCwwMTstMCwxMTswLDA7LTAsMTE7MCwwOzAsMDswLDA7LTAsMDI7MCwwOy0wLDE4OzAsMDtcclxuMDUuMDIuMjAyNTsxMzozMDsxMzo0NTswLDkzOzAsMjk7LTAsMjE7MCwwOy0wLDEyOzAsMDstMCwxMTswLDA7MCwwOzAsMDstMCwwMjswLDA7LTAsMTg7MCwwO1xyXG4wNS4wMi4yMDI1OzEzOjQ1OzE0OjAwOzAsODY7MCw0NTstMCwxMTswLDA7LTAsMDk7MCwwOy0wLDExOzAsMDswLDA7MCwwOy0wLDAxOzAsMDstMCwwOTswLDA7XHJcbmAsXHJcbiAgICAgICAgXCJURVNUSU5HIERVTU1ZXCIsXHJcbiAgICApO1xyXG4gICAgcmVmcmVzaFZpZXcoKTtcclxufVxyXG5cclxubW9jaygpO1xyXG4iXX0=