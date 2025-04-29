/* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { last, gSettings, refreshView, assert, sum, accumulateInterval } from "./EdcReportAnalyzer.js";
// eslint-disable-next-line no-duplicate-imports
import type {
    GroupingOptions,
    Csv,
    Interval,
    Ean,
    Measurement,
    OptimizedAllocation,
} from "./EdcReportAnalyzer.js";
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
    collection.forEach((i) => {
        const valueStr = (i as HTMLElement).innerText;
        if (valueStr.length > 0) {
            const value = parseFloat(valueStr);
            maximum = Math.max(maximum, value);
            minimum = Math.min(minimum, value);
        }
    });
    // console.log(minimum, maximum);
    assert(!isNaN(maximum), `There is a NaN when colorizing query${query}`);
    // console.log("Colorizing with maximum", maximum);
    collection.forEach((i) => {
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
    });
}

function recallEanAlias(ean: Ean): string {
    return localStorage.getItem(`EAN_alias_${ean.name}`) ?? "";
}
function saveEanAlias(ean: Ean, alias: string): void {
    localStorage.setItem(`EAN_alias_${ean.name}`, alias);
}

type HeaderFeature = "closeButton" | "editableName";
function createEanHeader(
    element: HTMLElement,
    ean: Ean,
    features: HeaderFeature[] = ["closeButton", "editableName"],
): void {
    const hideable = features.includes("closeButton");
    if (hideable) {
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
        element.appendChild(close);
    }

    if (!hideable || !gSettings.hiddenEans.has(ean.name)) {
        element.appendChild(document.createTextNode(printEan(ean.name)));
        if (features.includes("editableName")) {
            const input = document.createElement("input");
            input.type = "text";
            input.value = recallEanAlias(ean);
            input.addEventListener("change", () => {
                saveEanAlias(ean, input.value);
                refreshView();
            });
            element.appendChild(input);
        } else {
            const recalled = recallEanAlias(ean);
            if (recalled.length > 0) {
                element.innerHTML += `<br>(${recalled})`;
            }
        }
    }
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
        const headerFeatures = ["closeButton"] as HeaderFeature[];
        if (editableNames) {
            headerFeatures.push("editableName");
        }
        createEanHeader(th, ean, headerFeatures);
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
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function printDate(date: Date): string {
    return `${printOnlyDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function printGroupedDate(date: Date, grouping: GroupingOptions, useNbsp = true): string {
    const nbsp = useNbsp ? "&nbsp;" : " ";
    switch (grouping) {
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
    assert(!isNaN(input), "NaN in printKWh!");
    const alwaysKWh = options?.alwaysKwh ?? false;
    const nsbsp = (options?.nbsp ?? false) ? "&nbsp;" : " ";
    if (
        gSettings.displayUnit === "kW" &&
        !alwaysKWh &&
        (gSettings.grouping === "15m" || gSettings.grouping === "1h")
    ) {
        const multiplier = gSettings.grouping === "15m" ? 4 : 1;
        return `${(input * multiplier).toFixed(2)}${nsbsp}kW`;
    } else {
        return `${input.toFixed(2)}${nsbsp}kWh`;
    }
}

function displayInputData(csv: Csv): void {
    document.getElementById("filename")!.innerText = csv.filename;
    document.getElementById("intervalFrom")!.innerText = printDate(csv.dateFrom);
    document.getElementById("intervalTo")!.innerText = printDate(csv.dateTo);
    document.getElementById("intervalLength")!.innerText = `${csv.getNumDays()} dnů`;
    console.log(gSettings.maxDayFilter, gSettings.minDayFilter);
    document.getElementById("intervalFilteredLength")!.innerText =
        `${gSettings.maxDayFilter - gSettings.minDayFilter + 1} dnů`;
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
    makeRow("Naměřená data (před&nbsp;sdílením) [kWh]:", GRAY, (eanStats: EanStats) =>
        printKWh(eanStats.originalBalance, printOptions),
    );
    makeRow("Ponížená data (po&nbsp;sdílení) [kWh]:", GRAY, (eanStats: EanStats) =>
        printKWh(eanStats.adjustedBalance, printOptions),
    );
    makeRow("Sdílení [kWh]:", GREEN, (eanStats: EanStats) => printKWh(eanStats.shared(), printOptions));
    makeRow("Ušlá příležitost [kWh]:", RED, (eanStats: EanStats) =>
        printKWh(eanStats.missedDueToAllocation, printOptions),
    );

    const graphRow = document.createElement("tr");
    const graphTh = document.createElement("th");
    graphTh.innerHTML = "Grafy:";
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
                    labels: [
                        "Sdíleno",
                        "Ušlá příležitost\n(prodáno/nakoupeno)",
                        "Zbytek\n(prodáno/nakoupeno)",
                    ],
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
                                label(tooltipItem: Chart.TooltipItem<"pie">): string {
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
        const graphCell = graphRow.insertCell();
        graphCell.classList.add("distribution");
        makeChart(graphCell, csv.distributionEans[i], distributionStats[i]);
    }
    graphRow.insertCell().classList.add("split");
    for (let i = 0; i < csv.consumerEans.length; ++i) {
        const graphCell = graphRow.insertCell();
        graphCell.classList.add("consumer");
        makeChart(graphCell, csv.consumerEans[i], consumerStats[i]);
    }
    tbody.appendChild(graphRow);
}

function displayComputation(csv: Csv): void {
    const recallEanAllocation = (ean: Ean): number =>
        parseFloat(localStorage.getItem(`EAN_allocation_${ean.name}`) ?? "1");
    const saveEanAllocation = (ean: Ean, allocation: number): void => {
        localStorage.setItem(`EAN_allocation_${ean.name}`, allocation.toString());
    };
    const recallEanCost = (ean: Ean): number =>
        parseFloat(localStorage.getItem(`EAN_cost_${ean.name}`) ?? "2");
    const saveEanCost = (ean: Ean, cost: number): void => {
        localStorage.setItem(`EAN_cost_${ean.name}`, cost.toString());
    };

    const table = document.getElementById("computation") as HTMLTableElement;
    assert(table !== null);

    {
        // Header
        const header = table.querySelector("thead > tr") as HTMLTableRowElement;
        header.innerHTML = "";
        const first = document.createElement("th");
        first.classList.add("consumer");
        header.appendChild(first);
        for (const i of csv.consumerEans) {
            const cell = document.createElement("th");
            cell.classList.add("consumer");
            createEanHeader(cell, i, []);
            header.appendChild(cell);
        }
        const lastHeader = document.createElement("th");
        lastHeader.innerHTML = "Sum";
        header.appendChild(lastHeader);
    }

    const body = table.querySelector("tbody")!;
    body.innerHTML = "";

    const allocationInputs = [] as HTMLInputElement[];
    const updateTotalSum = (): void => {
        const res = allocationInputs.reduce((p, i) => p + parseFloat(i.value), 0);
        document.getElementById("sumInputAllocations")!.innerHTML = `${res.toFixed(2)}&nbsp;%`;
    };
    {
        // Inputs
        const row = document.createElement("tr");
        const rowHeader = document.createElement("th");
        rowHeader.innerHTML = "Alokace odběratelům:";
        row.appendChild(rowHeader);

        for (const ean of csv.consumerEans) {
            const td = row.insertCell();
            const input = document.createElement("input");
            input.type = "number";
            input.min = "0";
            input.max = "100";
            input.step = "0.01";
            input.value = recallEanAllocation(ean).toString();
            input.addEventListener("change", () => {
                saveEanAllocation(ean, parseFloat(input.value));
                updateTotalSum();
            });
            td.appendChild(input);
            allocationInputs.push(input);
            td.insertAdjacentText("beforeend", " %");
            row.appendChild(td);
        }

        const lastInput = document.createElement("td");
        const sumInputAllocations = document.createElement("span");
        sumInputAllocations.id = "sumInputAllocations";
        lastInput.appendChild(sumInputAllocations);
        row.appendChild(lastInput);
        body.append(row);
    }

    const costsInput = [] as HTMLInputElement[];
    const getCostsInput = (): number[] => costsInput.map((i) => parseFloat(i.value));
    {
        // Costs of electricity
        const row = document.createElement("tr");
        const rowHeader = document.createElement("th");
        rowHeader.innerHTML = "Cena za kWh:";
        row.appendChild(rowHeader);

        for (const ean of csv.consumerEans) {
            const td = row.insertCell();
            const input = document.createElement("input");
            input.type = "number";
            input.min = "0";
            input.max = "100";
            input.step = "0.1";
            input.value = recallEanCost(ean).toString();
            input.addEventListener("change", () => {
                saveEanCost(ean, parseFloat(input.value));
            });
            td.appendChild(input);
            costsInput.push(input);
            td.insertAdjacentText("beforeend", " Kč");
            row.appendChild(td);
        }
        row.appendChild(document.createElement("td"));
        body.append(row);
    }

    let totalShareable = 0;
    let totalShared = 0;
    const sumShared = Array<number>(csv.consumerEans.length).fill(0);
    for (const interval of csv.intervals) {
        for (const distribution of interval.distributions) {
            totalShareable += distribution.before - distribution.after + distribution.missed;
            totalShared += distribution.before - distribution.after;
        }
        for (let i = 0; i < interval.consumers.length; ++i) {
            sumShared[i] += interval.consumers[i].before - interval.consumers[i].after;
        }
    }

    const makeComparison = (
        currentKwh: number,
        referenceKwh: number,
        currentCzk: number,
        referenceCzk: number,
    ): string => {
        const comparison = (display: string, difference: number): string => {
            if (difference > 0.001) {
                return `<span style="color: green">${display} <strong>více</strong></span>`;
            } else if (difference < -0.001) {
                return `<span style="color: red">${display} <strong>méně</strong></span>`;
            } else {
                return `<span>${display}</span>`;
            }
        };
        const kWh = printKWh(Math.abs(currentKwh - referenceKwh), { nbsp: true });
        const czk = `${Math.abs(currentCzk - referenceCzk).toFixed(2)}&nbspKč`;
        return `Oproti skutečnosti:<br>
            ${comparison(kWh, currentKwh - referenceKwh)}<br>
            ${comparison(czk, currentCzk - referenceCzk)}`;
    };

    const roundsDom = document.getElementById("rounds") as HTMLInputElement;
    {
        // Computed sharing
        const row = document.createElement("tr");
        row.classList.add("compute");
        const rowHeader = document.createElement("th");
        rowHeader.title = "Zadejte váhy pro které simulace spočítá sdílení";
        row.appendChild(rowHeader);
        const simulateButton = document.createElement("input");
        simulateButton.type = "button";
        simulateButton.value = "Simulovat sdílení";
        rowHeader.appendChild(simulateButton);

        const allocationSharingOutputs = [] as HTMLElement[];
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const ean of csv.consumerEans) {
            allocationSharingOutputs.push(row.insertCell());
        }
        const lastCell = row.insertCell();

        simulateButton.addEventListener("click", () => {
            if (csv.distributionEans.length > 1) {
                alert("Bohužel, tato funkce zatím nefunguje pro víc než 1 výrobní zdroj.");
                return;
            }
            const allocationPercentages = allocationInputs.map((i) => parseFloat(i.value));
            if (allocationPercentages.some((i) => isNaN(i))) {
                alert("Prosím zadejte alokaci pro všechny EANy.");
                return;
            }
            const sumAllocations = sum(allocationPercentages);
            if (sumAllocations > 100) {
                alert(`Součet alokací je přes 100% (aktuálně ${sumAllocations}%)`);
                return;
            }
            console.log(allocationPercentages);
            const costsPerKwh = getCostsInput();
            const referenceProfit = sumShared.map((value, index) => sumShared[index] * costsPerKwh[index]);
            const results = csv.simulateSharing(
                allocationPercentages,
                costsPerKwh,
                parseInt(roundsDom.value, 10),
            );
            for (let i = 0; i < allocationSharingOutputs.length; ++i) {
                allocationSharingOutputs[i].innerHTML =
                    `Simulované sdílení: ${printKWh(results.sharingPerEan[i], { nbsp: true })} (${results.profitPerEan[i].toFixed(2)}&nbsp;Kč).<br>`;
                allocationSharingOutputs[i].innerHTML += makeComparison(
                    results.sharingPerEan[i],
                    sumShared[i],
                    results.profitPerEan[i],
                    referenceProfit[i],
                );

                allocationSharingOutputs[i].title = "Sdílení v každém kole opakování:\n";
                for (let round = 0; round < results.sharingPerRoundPerEan.length; ++round) {
                    allocationSharingOutputs[i].title +=
                        `${round + 1}: ${printKWh(results.sharingPerRoundPerEan[round][i])} (${((100 * results.sharingPerRoundPerEan[round][i]) / Math.max(0.0000001, results.sharingPerEan[i])).toFixed(2)} %)\n`;
                }
            }
            const sharingTotal = sum(results.sharingPerEan);
            let sumText = `Simulované sdílení: ${printKWh(sharingTotal, { nbsp: true })} (${sum(results.profitPerEan).toFixed(2)}&nbsp;Kč)<br>`;
            sumText += `Ušlá příležitost: ${printKWh(totalShareable - sharingTotal, { nbsp: true })}.<br>`;
            sumText += makeComparison(
                sharingTotal,
                totalShared,
                sum(results.profitPerEan),
                sum(referenceProfit),
            );

            lastCell.title = `Sdílení v každém kole opakování:\n`;
            for (let round = 0; round < results.sharingPerRoundPerEan.length; ++round) {
                lastCell.title += `${round + 1}: ${printKWh(sum(results.sharingPerRoundPerEan[round]))}\n`;
            }
            lastCell.innerHTML = sumText;
        });

        body.appendChild(row);
    }

    {
        // Optimize
        const row = document.createElement("tr");
        row.classList.add("optimize");
        const rowHeader = document.createElement("th");
        rowHeader.title = "Algoritmus najde optimální alokační klíč";
        const simulateButton = document.createElement("input");
        simulateButton.type = "button";
        simulateButton.value = "Najít optimální alokace";
        const progressDom = document.createElement("div");
        rowHeader.appendChild(simulateButton);
        rowHeader.appendChild(progressDom);
        row.appendChild(rowHeader);

        const cells = [] as HTMLElement[];
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const ean of csv.consumerEans) {
            const cell = row.insertCell();
            cells.push(cell);
        }
        const lastCell = row.insertCell();

        simulateButton.addEventListener("click", () => {
            const numIterations = parseInt(
                (document.getElementById("restarts") as HTMLInputElement).value,
                10,
            );

            const costsPerKwh = getCostsInput();
            const referenceProfit = sumShared.map((value, index) => sumShared[index] * costsPerKwh[index]);
            csv.optimizeAllocation(
                parseInt(roundsDom.value, 10),
                costsPerKwh,
                (document.getElementById("stochastic") as HTMLInputElement).checked
                    ? "random"
                    : "gradientDescend",
                parseInt((document.getElementById("maxFails") as HTMLInputElement).value, 10),
                numIterations,
                (optimized: OptimizedAllocation, progress: number) => {
                    for (let i = 0; i < cells.length; ++i) {
                        cells[i].innerHTML = `Optimální alokace: ${optimized.weights[i]}&nbsp;%<br>`;
                        cells[i].innerHTML +=
                            ` dosáhne sdílení: ${printKWh(optimized.sharing[i], { nbsp: true })}<br>`;
                        cells[i].innerHTML += makeComparison(
                            optimized.sharing[i],
                            sumShared[i],
                            optimized.profit[i],
                            referenceProfit[i],
                        );
                    }
                    const sumOptimized = sum(optimized.sharing);
                    lastCell.innerHTML = `Celkové sdílení: ${printKWh(sumOptimized, { nbsp: true })}<br>`;
                    lastCell.innerHTML += makeComparison(
                        sumOptimized,
                        totalShared,
                        sum(optimized.profit),
                        sum(referenceProfit),
                    );

                    if (progress < numIterations) {
                        progressDom.innerHTML = `Výpočet... ${progress} / ${numIterations}`;
                    } else {
                        progressDom.innerHTML = "HOTOVO!";
                    }
                },
            );
        });

        body.appendChild(row);
    }
    updateTotalSum();
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
        th.innerHTML = printGroupedDate(interval.start, gSettings.grouping);

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
            th.title = "Výrobní zdroje nevyprodukovaly dostatek energie k pokrytí celé spotřeby.\n";
        } else {
            th.classList.add("sufficient");
        }
        th.title += `Celková spotřeba (před sdílením): ${printKWh(sumConsumedBefore)}\n`;
        th.title += `Nakoupeno ze sítě (po sdílení): ${printKWh(sumConsumedAfter)}\n`;
        th.title += `Celková výroba: ${printKWh(interval.sumProduction)} (část mohla zůstat nenasdílená kvůli alokačním klíčům)\n`;
        th.title += `Výroba prodaná do sítě: ${printKWh(interval.sumProduction - interval.sumSharing)}`;

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

function isDifferentDay(a: Date, b: Date): boolean {
    return (
        a.getDate() !== b.getDate() || a.getMonth() !== b.getMonth() || a.getFullYear() !== b.getFullYear()
    );
}

function displayBarGraph(
    holder: HTMLElement,
    csv: Csv,
    groupedIntervals: Interval[],
    grouping: GroupingOptions,
): void {
    holder.innerHTML = "";
    const canvas = document.createElement("canvas");
    holder.appendChild(canvas);

    const datasets: { label: string; data: number[]; backgroundColor: string }[] = [];

    if (gSettings.groupGraph) {
        datasets.push({
            label: "Sdílení",
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
                label: `Sdílení do: ${label}`,
                data: groupedIntervals.map((x: Interval) => x.consumers[i].before - x.consumers[i].after),
                backgroundColor: graphColors[i % graphColors.length],
            });
        }
    }

    if (gSettings.graphExtra === "produce") {
        const sold = groupedIntervals.map((i: Interval) => {
            const res = i.sumProduction - i.sumMissed - i.sumSharing;
            assert(
                res > -0.0000001,
                "We need to clamp due to numerical imprecision, but the value outside of the tolerance",
                res,
            );
            return Math.max(0, res);
        });
        const missed = groupedIntervals.map((i: Interval) => i.sumMissed);
        datasets.push(
            { label: "Prodáno do sítě (ušlá příležitost)", data: missed, backgroundColor: "red" },
            { label: "Prodáno do sítě (odběratelé nepotřebovali více)", data: sold, backgroundColor: "gray" },
        );
    } else {
        datasets.push({
            label: "Nakoupeno ze sítě",
            data: groupedIntervals.map((i: Interval) => i.consumers.reduce((prev, x) => prev + x.after, 0)),
            backgroundColor: "lightgray",
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const chart = new Chart.Chart(canvas, {
        type: "bar",
        data: {
            labels: groupedIntervals.map((i: Interval) => {
                let result = printGroupedDate(i.start, grouping, false);
                if (!isDifferentDay(last(groupedIntervals).start, groupedIntervals[0].start)) {
                    result = result.substring(11); // Remove date from the label if graph only shows 1 day
                }
                return result;
            }),
            datasets,
        },
        options: {
            animation: false, // So the graph immediately updates when sliding range selector
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
                        label(tooltipItem: Chart.TooltipItem<"bar">): string {
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

    const groupedIntervals = csv.getGroupedIntervals(gSettings.grouping);

    displayInputData(csv);
    displaySummary(csv, groupedIntervals);
    displayComputation(csv);
    displayIntervals(csv, groupedIntervals);
    displayBarGraph(document.getElementById("intervalsGraph")!, csv, groupedIntervals, gSettings.grouping);

    const grouping = gSettings.grouping === "15m" ? "15m" : "1h";
    let daySummed = csv.getGroupedIntervals(grouping);
    const split = daySummed.findIndex((value) => isDifferentDay(value.start, daySummed[0].start));
    if (split >= 0) {
        const toAccumulate = daySummed.slice(split);
        daySummed = daySummed.slice(0, split);
        for (const i of toAccumulate) {
            const target = daySummed.find(
                (value) =>
                    value.start.getHours() === i.start.getHours() &&
                    value.start.getMinutes() === i.start.getMinutes(),
            );
            if (target === undefined) {
                assert(i.start.getHours() === 2); // Daylight savings
            } else {
                accumulateInterval(target, i);
            }
        }
        const divFactor = gSettings.maxDayFilter - gSettings.minDayFilter + 1;
        const divideMeasurement = (measurement: Measurement): void => {
            measurement.before /= divFactor;
            measurement.after /= divFactor;
            measurement.missed /= divFactor;
        };
        for (const interval of daySummed) {
            interval.sumSharing /= divFactor;
            interval.sumMissed /= divFactor;
            interval.sumProduction /= divFactor;
            interval.consumers.forEach(divideMeasurement);
            interval.distributions.forEach(divideMeasurement);
        }
    }
    displayBarGraph(document.getElementById("dailyAverageGraph")!, csv, daySummed, grouping);

    console.log("displayCsv took", performance.now() - startTime, "ms");
}
