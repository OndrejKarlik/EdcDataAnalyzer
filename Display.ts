/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { gSettings, refreshView, assert } from "./EdcReportAnalyzer.js";
// eslint-disable-next-line no-duplicate-imports
import type { Csv, Interval, Ean, Measurement } from "./EdcReportAnalyzer.js";
import * as Chart from "chart.js/auto";

type Rgb = [number, number, number];

const GREEN = [14, 177, 14] as Rgb;
const RED = [255, 35, 35] as Rgb;
const GRAY = [150, 150, 150] as Rgb;

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

export function printOnlyDate(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
export function printDate(date: Date): string {
    return `${printOnlyDate(date)} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
function printGroupedDate(date: Date, useNbsp = true): string {
    const nbsp = useNbsp ? "&nbsp;" : " ";
    switch (gSettings.grouping) {
        case "15m":
            return `${printDate(date)}${nbsp}-${nbsp}${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes() + 14).padStart(2, "0")}`;
        case "1h":
            return `${printOnlyDate(date)} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
        case "1d":
            return printOnlyDate(date);
        case "1m":
            return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
        default:
            throw Error();
    }
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
export interface PrintKWhOptions {
    alwaysKwh?: boolean; // Default false
    nbsp?: boolean; // Default false
}
export function printKWh(input: number, options?: PrintKWhOptions): string {
    const alwaysKWh = options?.alwaysKwh ?? false;
    const nsbsp = (options?.nbsp ?? false) ? "&nbsp;" : " ";
    if (gSettings.displayUnit === "kW" && !alwaysKWh) {
        return `${(input * 4).toFixed(2)}${nsbsp}kW`;
    } else {
        return `${input.toFixed(2)}${nsbsp}kWh`;
    }
}

function displayInputData(csv: Csv): void {
    document.getElementById("filename")!.innerText = csv.filename;
    document.getElementById("intervalFrom")!.innerText = printDate(csv.dateFrom);
    document.getElementById("intervalTo")!.innerText = printDate(csv.dateTo);
    document.getElementById("intervalLength")!.innerText = `${csv.getNumDays()} days`;
    document.getElementById("intervalFilteredLength")!.innerText =
        `${gSettings.maxDayFilter - gSettings.minDayFilter + 1} days`;
}

function displaySummary(csv: Csv, groupedIntervals: Interval[]): void {
    setupHeader(document.getElementById("csv") as HTMLTableElement, csv, true);
    const tbody = document.getElementById("csvBody");
    assert(tbody !== null);
    tbody.innerHTML = "";

    class EanStats {
        originalBalance = 0;
        adjustedBalance = 0;
        missedDueToAllocation = 0;
        shared(): number {
            return this.originalBalance - this.adjustedBalance;
        }
    }
    const distributionStats = Array<EanStats>(csv.distributionEans.length);
    for (let i = 0; i < distributionStats.length; ++i) {
        distributionStats[i] = new EanStats();
    }
    const consumerStats = Array<EanStats>(csv.consumerEans.length);
    for (let i = 0; i < consumerStats.length; ++i) {
        consumerStats[i] = new EanStats();
    }
    const accumulate = (to: EanStats, from: Measurement): void => {
        to.originalBalance += from.before;
        to.adjustedBalance += from.after;
        to.missedDueToAllocation += from.missed;
    };
    for (const interval of groupedIntervals) {
        for (let i = 0; i < interval.distributions.length; ++i) {
            accumulate(distributionStats[i], interval.distributions[i]);
        }
        for (let i = 0; i < interval.consumers.length; ++i) {
            accumulate(consumerStats[i], interval.consumers[i]);
        }
    }

    let rowId = 0;
    const makeRow = (header: string, backgroundColor: Rgb, printFn: (eanStats: EanStats) => string): void => {
        const row = document.createElement("tr");
        const id = `row${rowId++}`;
        row.classList.add(id);
        const th = document.createElement("th");
        row.appendChild(th);
        th.innerHTML = header;
        for (let i = 0; i < csv.distributionEans.length; ++i) {
            const cell = row.insertCell();
            cell.classList.add("distribution");
            if (!gSettings.hiddenEans.has(csv.distributionEans[i].name)) {
                cell.innerHTML = printFn(distributionStats[i]);
            }
        }
        row.insertCell().classList.add("split");
        for (let i = 0; i < csv.consumerEans.length; ++i) {
            const cell = row.insertCell();
            cell.classList.add("consumer");
            if (!gSettings.hiddenEans.has(csv.consumerEans[i].name)) {
                cell.innerHTML = printFn(consumerStats[i]);
            }
        }
        tbody.appendChild(row);
        colorizeRange(`table#csv tr.${id} td.consumer`, backgroundColor);
        colorizeRange(`table#csv tr.${id} td.distribution`, backgroundColor);
    };

    const printOptions = { alwaysKwh: true, nbsp: true };
    makeRow("Original (without&nbsp;sharing) [kWh]:", GRAY, (eanStats: EanStats) =>
        printKWh(eanStats.originalBalance, printOptions),
    );
    makeRow("Adjusted (with&nbsp;sharing) [kWh]:", GRAY, (eanStats: EanStats) =>
        printKWh(eanStats.adjustedBalance, printOptions),
    );
    makeRow("Shared [kWh]:", GREEN, (eanStats: EanStats) => printKWh(eanStats.shared(), printOptions));
    makeRow("Missed [kWh]:", RED, (eanStats: EanStats) =>
        printKWh(eanStats.missedDueToAllocation, printOptions),
    );

    const graphRow = document.createElement("tr");
    const graphTh = document.createElement("th");
    graphTh.innerHTML = "Graphs:";
    graphRow.appendChild(graphTh);

    const makeChart = (cell: HTMLElement, ean: Ean, eanStats: EanStats): void => {
        if (!gSettings.hiddenEans.has(ean.name) && eanStats.originalBalance > 0) {
            const canvasHolder = document.createElement("div");
            canvasHolder.classList.add("canvasHolder");
            const canvas = document.createElement("canvas");
            canvasHolder.appendChild(canvas);
            cell.appendChild(canvasHolder);
            const getPercent = (x: number): number => Math.round((x / eanStats.originalBalance) * 100);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const graph = new Chart.Chart(canvas, {
                type: "pie",
                data: {
                    labels: ["Shared", "Missed", "Rest"],
                    datasets: [
                        {
                            label: "%",
                            data: [
                                getPercent(eanStats.shared()),
                                getPercent(eanStats.missedDueToAllocation),
                                getPercent(eanStats.adjustedBalance - eanStats.missedDueToAllocation),
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
    for (let i = 0; i < csv.distributionEans.length; ++i) {
        const cell = graphRow.insertCell();
        cell.classList.add("distribution");
        makeChart(cell, csv.distributionEans[i], distributionStats[i]);
    }
    graphRow.insertCell().classList.add("split");
    for (let i = 0; i < csv.consumerEans.length; ++i) {
        const cell = graphRow.insertCell();
        cell.classList.add("consumer");
        makeChart(cell, csv.consumerEans[i], consumerStats[i]);
    }
    tbody.appendChild(graphRow);
}

function displayIntervals(csv: Csv, groupedIntervals: Interval[]): void {
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
                groupedIntervals[intervalIndex - 1].start.getUTCDate() !== interval.start.getUTCDate())
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
        } else {
            th.classList.add("sufficient");
        }
        th.title += `Consumed before sharing: ${printKWh(sumConsumedBefore)}\n`;
        th.title += `Consumed after sharing: ${printKWh(sumConsumedAfter)}\n`;
        th.title += `Production total: ${printKWh(interval.sumProduction)} (might not have been entirely shared due to timing and allocation issues)\n`;
        th.title += `Production sold to grid: ${printKWh(interval.sumProduction - interval.sumSharing)}`;

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
}

function displayBarGraph(csv: Csv, groupedIntervals: Interval[]): void {
    const holder = document.getElementById("intervalsGraph")!;
    holder.innerHTML = "";
    const canvas = document.createElement("canvas");
    holder.appendChild(canvas);

    const missed = groupedIntervals.map((i: Interval) => i.sumMissed);
    const sold = groupedIntervals.map((i: Interval) => {
        const res = i.sumProduction - i.sumMissed - i.sumSharing;
        assert(
            res > -0.0000001,
            "We need to clamp due to numerical imprecision, but the value outside of the tolerance",
            res,
        );
        return Math.max(0, res);
    });

    const datasets: { label: string; data: number[]; backgroundColor: string }[] = [];

    if (gSettings.groupGraph) {
        datasets.push({
            label: "Shared",
            data: groupedIntervals.map((i: Interval) => i.sumSharing),
            backgroundColor: "green",
        });
    } else {
        // Chatgpt: Here’s an improved distinct set of vibrant green shades, covering a range from yellowish-greens to bluish-greens:
        const graphColors = [
            "#00A86B", // Jade Green (Balanced)
            "#4CBB17", // Leaf Green (Bright Natural)
            "#ADFF2F", // Green-Yellow (Lime Zest)
            "#228B22", // Forest Green (Deep & Earthy)
            "#76B947", // Grass Green (Warm & Fresh)
            "#2E8B57", // Sea Green (Cool & Bluish)
            "#0BDA51", // Malachite Green (Jewel-Toned)
            "#39FF14", // Neon Green (Electric)
            "#A7C957", // Olive Yellow-Green (Muted but Strong)
            "#008080", // Teal Green (Blue-Tinted)
        ];
        for (let i = 0; i < csv.consumerEans.length; ++i) {
            let label = printEan(csv.consumerEans[i].name);
            const recalled = recallEanAlias(csv.consumerEans[i]);
            if (recalled.length > 0) {
                label = recalled;
            }
            datasets.push({
                label: `Shared to ${label}`,
                data: groupedIntervals.map((x: Interval) => x.consumers[i].before - x.consumers[i].after),
                backgroundColor: graphColors[i % graphColors.length],
            });
        }
    }

    if (gSettings.graphExtra === "produce") {
        datasets.push(
            { label: "Sold to grid (missed sharing)", data: missed, backgroundColor: "red" },
            { label: "Sold to grid (no demand for sharing)", data: sold, backgroundColor: "gray" },
        );
    } else {
        datasets.push({
            label: "Purchased from grid",
            data: groupedIntervals.map((i: Interval) => i.consumers.reduce((prev, x) => prev + x.after, 0)),
            backgroundColor: "lightgray",
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const chart = new Chart.Chart(canvas, {
        type: "bar",
        data: {
            labels: groupedIntervals.map((i: Interval) => printGroupedDate(i.start, false)),
            datasets,
        },
        options: {
            scales: {
                y: {
                    beginAtZero: true,
                    stacked: true,
                    title: {
                        display: true,
                        text: "kWh",
                    },
                },
                x: {
                    stacked: true,
                },
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label(tooltipItem): string {
                            return `${tooltipItem.dataset.label}: ${(tooltipItem.raw as number).toFixed(2)} kWh`;
                        },
                    },
                },
            },
        },
    });
}

export function displayCsv(csv: Csv): void {
    const startTime = performance.now();
    assert(gSettings.filterValue >= 0 && gSettings.filterValue <= 1);

    const dateFrom = structuredClone(csv.dateFrom);
    dateFrom.setUTCDate(dateFrom.getUTCDate() + gSettings.minDayFilter);
    const dateTo = structuredClone(csv.dateFrom);
    dateTo.setUTCDate(dateTo.getUTCDate() + gSettings.maxDayFilter + 1);
    dateTo.setUTCMinutes(dateTo.getUTCMinutes() - 1);
    const groupedIntervals = csv.getGroupedIntervals(gSettings.grouping, dateFrom, dateTo);

    displayInputData(csv);
    displaySummary(csv, groupedIntervals);
    displayIntervals(csv, groupedIntervals);
    displayBarGraph(csv, groupedIntervals);

    console.log("displayCsv took", performance.now() - startTime, "ms");
}
