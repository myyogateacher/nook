import { describe, expect, test } from "bun:test";
import {
  blockSpan, chartHeight, CHART_HEIGHTS, DELTA_TEXT, ECHARTS_THEME_NAME, EMPHASIS_MUTED, LAYOUT, layoutColumns, MARKS, REPORT_INK, REPORT_SERIES, reportCssVariables,
  reportEchartsTheme, SEQUENTIAL_BLUE, STATUS, TYPE
} from "../shared/reportTheme";
import { reportLayout, upgradeSpec, type ChartBlock, type KpiBlock, type ReportSpecV1 } from "../shared/reports";
import { buildChartOption, chartTheme, compactValue, endLabelFit, formatValue, labelWidth, optionJson } from "../src/reports/chartOption";
import { kpiValue, sparklinePath } from "../src/reports/KpiTile";
import { checkPalette, contrast } from "./support/paletteCheck";

/**
 * Wave 48b, the report theme "Ledger" (docs/plan/REPORT_THEME.md): the tokens, the palette checks of
 * the data-viz validator re-run on them, the layout grid, the v1 → v2 spec upgrade, and the chart
 * options the theme's marks produce (sorting, folding, legend, emphasis, labels, formatters).
 */

describe("theme tokens", () => {
  test("the tokens are the approved spec (snapshot)", () => {
    expect({ ink: REPORT_INK, series: REPORT_SERIES, sequential: SEQUENTIAL_BLUE, status: STATUS, delta: DELTA_TEXT, emphasis: EMPHASIS_MUTED, type: TYPE, layout: LAYOUT, marks: MARKS, heights: CHART_HEIGHTS }).toMatchSnapshot();
    // The fixed amber-first order, never cycled.
    expect(REPORT_SERIES.dark).toEqual(["#c98500", "#3987e5", "#199e70", "#d95926", "#9085e9", "#d55181", "#008300", "#e66767"]);
    expect(REPORT_SERIES.light).toEqual(["#eda100", "#2a78d6", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4", "#008300", "#e34948"]);
    expect(REPORT_INK.dark.surface).toBe("#111113");
    expect(REPORT_INK.light.surface).toBe("#fcfcfb");
    expect(SEQUENTIAL_BLUE.length).toBe(13);
  });

  test("CSS variables and the one ECharts theme are generated from the same tokens", () => {
    for (const mode of ["dark", "light"] as const) {
      const vars = reportCssVariables(mode);
      expect(vars["--rt-surface"]).toBe(REPORT_INK[mode].surface);
      expect(vars["--rt-ink"]).toBe(REPORT_INK[mode].ink);
      expect(vars["--rt-series-1"]).toBe(REPORT_SERIES[mode][0]!);
      expect(vars["--rt-series-8"]).toBe(REPORT_SERIES[mode][7]!);
      expect(vars["--rt-delta-good"]).toBe(DELTA_TEXT[mode].good);
      const theme = reportEchartsTheme(mode);
      expect(theme.color).toEqual([...REPORT_SERIES[mode]]);
      expect((theme.valueAxis as { splitLine: { lineStyle: { color: string } } }).splitLine.lineStyle.color).toBe(REPORT_INK[mode].grid);
      expect((theme.categoryAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
      expect((theme.bar as { barMaxWidth: number }).barMaxWidth).toBe(24);
    }
    expect(ECHARTS_THEME_NAME).toBe("nook-ledger");
  });
});

describe("palette checks (validate_palette.js, ported)", () => {
  test("dark passes every check against #111113 (adjacent CVD ≥ 8, normal vision ≥ 15)", () => {
    const report = checkPalette(REPORT_SERIES.dark, "dark", "#111113");
    expect(report.offBand).toEqual([]);
    expect(report.lowChroma).toEqual([]);
    expect(report.worstCvd).toBeGreaterThanOrEqual(8);
    expect(report.worstCvd).toBeCloseTo(8.6, 1);
    expect(report.worstNormal).toBeGreaterThanOrEqual(15);
    expect(report.worstNormal).toBeCloseTo(19.7, 1);
    expect(report.lowContrast).toEqual([]);
  });

  test("light passes against #fcfcfb with the two documented warnings", () => {
    const report = checkPalette(REPORT_SERIES.light, "light", "#fcfcfb");
    expect(report.offBand).toEqual([]);
    expect(report.lowChroma).toEqual([]);
    // Slots 7↔8 sit in the 6–8 floor band: legal with a legend and direct labels (mandatory at 7–8 series).
    expect(report.worstCvd).toBeGreaterThanOrEqual(6);
    expect(report.worstCvd).toBeCloseTo(7.2, 1);
    expect(report.worstNormal).toBeGreaterThanOrEqual(15);
    // Amber, aqua, and magenta are below 3:1: the relief rule (the table view is always in Inspect → Data).
    expect(report.lowContrast).toEqual(["#eda100", "#1baf7a", "#e87ba4"]);
  });

  test("the first three slots pass every pair in both modes (scatter is capped at three)", () => {
    for (const [mode, surface] of [["dark", "#111113"], ["light", "#fcfcfb"]] as const) {
      const report = checkPalette(REPORT_SERIES[mode].slice(0, 3), mode, surface, "all");
      expect(report.worstCvd).toBeGreaterThanOrEqual(8);
      expect(report.worstNormal).toBeGreaterThanOrEqual(15);
    }
  });

  test("delta text reaches 4.5:1 on its surface", () => {
    for (const mode of ["dark", "light"] as const) {
      expect(contrast(DELTA_TEXT[mode].good, REPORT_INK[mode].surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(DELTA_TEXT[mode].bad, REPORT_INK[mode].surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(REPORT_INK[mode].inkSecondary, REPORT_INK[mode].surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("layout", () => {
  test("12 / 6 / 1 columns at ≥1024, 768–1023, and below 768 px", () => {
    expect([layoutColumns(1440), layoutColumns(1024), layoutColumns(1023), layoutColumns(768), layoutColumns(767), layoutColumns(390)]).toEqual([12, 12, 6, 6, 1, 1]);
    expect([blockSpan("full", 12), blockSpan("half", 12), blockSpan("third", 12)]).toEqual([12, 6, 4]);
    expect([blockSpan("full", 6), blockSpan("half", 6), blockSpan("third", 6)]).toEqual([6, 3, 3]);
    expect([blockSpan("full", 1), blockSpan("half", 1), blockSpan("third", 1)]).toEqual([1, 1, 1]);
  });

  test("the CSS grid follows the same breakpoints and spans", async () => {
    const css = await Bun.file(new URL("../src/reports/reportView.css", import.meta.url)).text();
    expect(css).toContain("@container report-view (min-width: 768px)");
    expect(css).toContain("@container report-view (min-width: 1024px)");
    expect(css).toContain(".report-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); }");
    expect(css).toContain(".report-grid > .report-w-third { grid-column: span 4; }");
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(var(--rt-kpi-min), 1fr))");
    // Review polish: the page uses up to 1280 px, prose stays at a readable measure, KPI titles wrap to two lines.
    expect(css).toContain(".reports-body.report-body { width: min(1280px, 100%); }");
    expect(css).toContain(".report-narrative { color: var(--rt-ink-2); max-width: 70ch; }");
    expect(css).toContain("-webkit-line-clamp: 2");
    expect(css).toContain("@container report-kpi (max-width: 240px) { .report-kpi-vs { flex-basis: 100%; } }");
  });

  test("chart heights are fixed by kind; horizontal bars grow 28 px per category from 160", () => {
    expect([chartHeight("line"), chartHeight("area"), chartHeight("pie"), chartHeight("scatter"), chartHeight("bar", 30)]).toEqual([220, 220, 220, 260, 220]);
    expect([chartHeight("horizontal_bar", 2), chartHeight("horizontal_bar", 16)]).toEqual([160, 16 * 28 + 24]);
  });

  test("page order: narrative, the KPI strip, an untitled section, then the declared sections", () => {
    const layout = reportLayout({
      sections: [{ id: "b", title: "B" }, { id: "a", title: "A", summary: "Why" }, { id: "empty", title: "Empty" }],
      blocks: [
        { id: "intro", type: "markdown", markdown: "Hi" },
        { id: "k1", type: "kpi", queryKey: "q", column: "c" },
        { id: "c1", type: "chart", queryKey: "q", kind: "line", x: "d", y: ["v"], section: "a" },
        { id: "k2", type: "kpi", queryKey: "q", column: "c" },
        { id: "t1", type: "table", queryKey: "q" },
        { id: "c2", type: "chart", queryKey: "q", kind: "bar", x: "d", y: ["v"], section: "b" },
        { id: "note", type: "markdown", markdown: "later", section: "nope" }
      ]
    });
    expect(layout.narrative.map((block) => block.id)).toEqual(["intro"]);
    expect(layout.strip.map((block) => block.id)).toEqual(["k1", "k2"]);
    expect(layout.sections.map((section) => [section.id, section.blocks.map((block) => block.id)])).toEqual([[null, ["t1", "note"]], ["b", ["c2"]], ["a", ["c1"]]]);
  });
});

describe("spec v1 → v2 upgrade", () => {
  const v1: ReportSpecV1 = {
    version: 1,
    queries: [{ key: "q", sql: "SELECT 1", purpose: "", createdBy: "agent" }],
    blocks: [
      { id: "m", type: "markdown", markdown: "Hello", provenance: { runId: null, version: 2 } },
      { id: "k", type: "kpi", queryKey: "q", column: "v", compareColumn: "p", format: "currency" },
      { id: "l", type: "chart", queryKey: "q", kind: "line", x: "d", y: ["v"], format: "integer" },
      { id: "h", type: "chart", queryKey: "q", kind: "horizontal_bar", x: "d", y: ["v"] },
      { id: "p", type: "chart", queryKey: "q", kind: "pie", x: "d", y: ["v"] },
      { id: "s", type: "chart", queryKey: "q", kind: "scatter", x: "d", y: ["v"] },
      { id: "t", type: "table", queryKey: "q", formats: { v: "bytes" } }
    ]
  };

  test("adds specVersion, no sections, and the intent and width each kind implies; keeps everything else", () => {
    const v2 = upgradeSpec(v1);
    expect(v2.specVersion).toBe(3);
    expect(v2.parameters).toEqual([]);
    expect(v2.version).toBe(1);
    expect(v2.sections).toEqual([]);
    expect(v2.queries).toEqual(v1.queries);
    expect(v2.blocks.map((block) => [block.id, block.intent ?? null, block.width])).toEqual([
      ["m", null, "full"], ["k", "headline", "full"], ["l", "trend", "half"], ["h", "rank", "half"], ["p", "share", "half"], ["s", "relationship", "half"], ["t", "detail", "full"]
    ]);
    const kpi = v2.blocks[1] as KpiBlock;
    expect(kpi.compareTo).toEqual({ column: "p" });
    expect(kpi.compareColumn).toBeUndefined();
    expect(kpi.format).toBe("currency");
    expect((v2.blocks[2] as ChartBlock).format).toBe("integer");
    expect(v2.blocks[0]!.provenance).toEqual({ runId: null, version: 2 });
    // Pure: the input is untouched; upgrading twice changes nothing.
    expect((v1.blocks[1] as KpiBlock).compareColumn).toBe("p");
    expect(upgradeSpec(v2)).toEqual(v2);
  });

  test("anything unreadable is the empty spec", () => {
    for (const raw of [null, 3, "x", { version: 2, blocks: [], queries: [] }, { version: 1, blocks: {} }]) expect(upgradeSpec(raw).blocks).toEqual([]);
  });

  test("a v1 KPI renders the same value and change as before (compareColumn read as compareTo)", () => {
    const result = { columns: [{ name: "v", type: "Float64" }, { name: "p", type: "Float64" }], rows: [[1234.5, 1000]] };
    const before = kpiValue(v1.blocks[1] as KpiBlock, result);
    const after = kpiValue(upgradeSpec(v1).blocks[1] as KpiBlock, result);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ text: "1,234.50", change: { text: "+23.4%", tone: "good" } });
  });
});

const dark = chartTheme("dark");
const light = chartTheme("light");
const nominal = { columns: [{ name: "country", type: "LowCardinality(String)" }, { name: "orders", type: "UInt64" }], rows: [["DE", "5"], ["US", "40"], ["IN", "12"], ["GB", "30"]] };
const bar = (overrides: Partial<ChartBlock> = {}): ChartBlock => ({ id: "b", type: "chart", title: "Orders", queryKey: "q", kind: "bar", x: "country", y: ["orders"], format: "number", ...overrides });

describe("chart options from the theme", () => {
  test("bars: sorted descending unless x is ordinal or time; at most 24 px, rounded data end, 2 px surface gap", () => {
    const built = buildChartOption(bar(), nominal, dark);
    expect((built.option!.xAxis as { data: string[] }).data).toEqual(["US", "GB", "IN", "DE"]);
    expect(built.autoFixes.map((fix) => fix.rule)).toEqual(["sort"]);
    const series = (built.option!.series as Array<{ barMaxWidth: number; itemStyle: { borderRadius: number[]; borderColor: string; borderWidth: number } }>)[0]!;
    expect(series.barMaxWidth).toBe(24);
    expect(series.itemStyle).toMatchObject({ borderRadius: [4, 4, 0, 0], borderColor: dark.ink.surface, borderWidth: 1 });
    const horizontal = buildChartOption(bar({ kind: "horizontal_bar" }), nominal, dark);
    expect((horizontal.option!.series as Array<{ itemStyle: { borderRadius: number[] } }>)[0]!.itemStyle.borderRadius).toEqual([0, 4, 4, 0]);
    expect(horizontal.height).toBe(160);
    // Time on x: kept in order.
    const days = { columns: [{ name: "day", type: "Date" }, { name: "orders", type: "UInt64" }], rows: [["2026-10-01", "5"], ["2026-10-02", "40"]] };
    expect((buildChartOption(bar({ x: "day" }), days, dark).option!.xAxis as { data: string[] }).data).toEqual(["2026-10-01", "2026-10-02"]);
    // A distribution's bins stay ordered too.
    expect((buildChartOption(bar({ intent: "distribution" }), nominal, dark).option!.xAxis as { data: string[] }).data).toEqual(["DE", "US", "IN", "GB"]);
  });

  test("more than 20 bar categories keep the top 15 and Other", () => {
    const rows = Array.from({ length: 24 }, (_, index) => [`C${index}`, String(index + 1)]);
    const built = buildChartOption(bar(), { columns: nominal.columns, rows }, dark);
    const categories = (built.option!.xAxis as { data: string[] }).data;
    expect(categories.length).toBe(16);
    expect(categories[0]).toBe("C23");
    expect(categories.at(-1)).toBe("Other");
    expect((built.option!.series as Array<{ data: Array<{ value: number }> }>)[0]!.data.at(-1)).toMatchObject({ value: 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 });
    expect(built.foldedCategories).toBe(9);
    expect(built.autoFixes.map((fix) => fix.rule)).toEqual(["sort", "fold_categories"]);
  });

  test("the legend rule: none for one series, a legend for two or more", () => {
    expect((buildChartOption(bar(), nominal, dark).option!.legend as { show: boolean }).show).toBe(false);
    const two = { columns: [{ name: "day", type: "Date" }, { name: "web", type: "Float64" }, { name: "app", type: "Float64" }], rows: [["2026-10-01", 5, 6], ["2026-10-02", 7, 8]] };
    const line = buildChartOption({ ...bar(), kind: "line", intent: "trend", x: "day", y: ["web", "app"] }, two, dark);
    expect((line.option!.legend as { show: boolean }).show).toBe(true);
    // Lines: 2 px, round joins, a crosshair tooltip, an end dot with a surface ring, direct end labels in ink.
    const series = line.option!.series as Array<{ lineStyle: { width: number; join: string }; endLabel: { show: boolean; color: string }; data: Array<unknown> }>;
    expect(series[0]!.lineStyle).toMatchObject({ width: 2, join: "round" });
    expect(series[0]!.endLabel).toMatchObject({ show: true, color: dark.ink.inkSecondary });
    expect(series[0]!.data.at(-1)).toMatchObject({ symbol: "circle", symbolSize: 8, itemStyle: { borderColor: dark.ink.surface, borderWidth: 2 } });
    expect(line.option!.tooltip).toMatchObject({ trigger: "axis", triggerOn: "mousemove|click", axisPointer: { type: "line" } });
    expect(buildChartOption(bar(), nominal, dark).option!.tooltip).toMatchObject({ trigger: "item", triggerOn: "mousemove|click" });
    // Area at 10 %; horizontal grid only.
    const area = buildChartOption({ ...bar(), kind: "area", intent: "trend", x: "day", y: ["web"] }, two, dark);
    expect((area.option!.series as Array<{ areaStyle: { opacity: number } }>)[0]!.areaStyle.opacity).toBe(0.1);
    expect((area.option!.yAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(true);
    expect((area.option!.xAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
  });

  test("a line's maximum on its first point labels rightwards, clear of the y-axis labels; elsewhere it stays centred", () => {
    const rows = (values: number[]) => ({ columns: [{ name: "day", type: "Date" }, { name: "requests", type: "UInt64" }], rows: values.map((value, at) => [`2026-09-${String(at + 1).padStart(2, "0")}`, value]) });
    const label = (values: number[], at: number) => {
      const series = buildChartOption({ ...bar(), kind: "line", intent: "trend", x: "day", y: ["requests"] }, rows(values), dark).option!.series as Array<{ data: Array<{ label?: { align?: string; position?: string } }> }>;
      return series[0]!.data[at]!.label;
    };
    expect(label([705, 700, 560, 564], 0)).toMatchObject({ show: true, position: "top", align: "left" });
    expect(label([500, 705, 560, 564], 1)).toMatchObject({ show: true, position: "top" });
    expect(label([500, 705, 560, 564], 1)!.align).toBeUndefined();
  });

  test("D492: a line's end label fits its gutter (no unit at phone width); a late maximum reads leftwards; thinning never drops the dots", () => {
    const rows = (values: number[]) => ({ columns: [{ name: "day", type: "Date" }, { name: "requests", type: "UInt64" }], rows: values.map((value, at) => [`2026-09-${String(at + 1).padStart(2, "0")}`, value]) });
    const build = (values: number[], width?: number) => buildChartOption({ ...bar(), kind: "line", intent: "trend", x: "day", y: ["requests"], unit: "requests" }, rows(values), dark, { width }).option!;
    const format = (option: Record<string, unknown>, value: number) => ((option.series as Array<{ endLabel: { formatter: (params: { value: number }) => string } }>)[0]!.endLabel.formatter)({ value });
    const wide = build([705, 700, 560, 564], 560);
    const gutter = (wide.grid as { right: number }).right;
    // "564 requests" at the 10 px label size, plus the dot, its ring, and the gap: wider than the old fixed 56.
    expect(format(wide, 564)).toBe("564 requests");
    expect(gutter).toBeGreaterThanOrEqual(Math.ceil(labelWidth("564 requests")) + 16);
    expect(gutter).toBeLessThan(120);
    const phone = build([705, 700, 560, 564], 330);
    expect(format(phone, 564)).toBe("564");
    expect((phone.grid as { right: number }).right).toBeLessThan(48);
    expect(endLabelFit([null], undefined, "requests", 330)).toEqual({ gutter: 16, short: false });
    const series = (option: Record<string, unknown>) => (option.series as Array<{ showAllSymbol?: boolean; data: Array<{ label?: { align?: string } }> }>)[0]!;
    expect(series(phone).showAllSymbol).toBe(true);
    // The maximum on the second-to-last of 30 points reads leftwards, inside the plot; its label also drops the unit on a phone.
    const late = Array.from({ length: 30 }, (_, at) => (at === 28 ? 900 : 500));
    expect(series(build(late, 330)).data[28]!.label).toMatchObject({ show: true, position: "top", align: "right" });
    expect(series(build(late, 330)).data[28]!.label).toHaveProperty("formatter");
  });

  test("emphasis: the named series (or one category) in slot 1, every other in the muted grey", () => {
    const two = { columns: [{ name: "day", type: "Date" }, { name: "web", type: "Float64" }, { name: "app", type: "Float64" }], rows: [["2026-10-01", 5, 6]] };
    const series = buildChartOption({ ...bar(), kind: "line", x: "day", y: ["web", "app"], emphasis: "app" }, two, light).option!;
    expect(series.color).toEqual([light.emphasisMuted, light.series[0]]);
    const category = buildChartOption(bar({ emphasis: "IN" }), nominal, dark).option!;
    expect(category.color).toEqual([dark.emphasisMuted]);
    const data = (category.series as Array<{ data: Array<unknown> }>)[0]!.data;
    expect(data.find((item) => typeof item === "object" && item !== null && (item as { itemStyle?: { color: string } }).itemStyle?.color === dark.series[0])).toMatchObject({ value: 12 });
  });

  test("no formatter string from the spec: named local functions only; texture fills only under forced colours", () => {
    const sneaky = { ...bar(), formatter: "{b}<img src=x>", color: "#ff0000", style: { width: "900px" } } as unknown as ChartBlock;
    const option = buildChartOption(sneaky, nominal, dark).option!;
    const json = optionJson(option);
    expect(json).not.toContain("{b}");
    expect(json).not.toContain("#ff0000");
    expect(json).not.toContain("900px");
    const formatters = [...json.matchAll(/"ƒ ([^"]+)"/g)].map((match) => match[1]);
    expect(formatters.length).toBeGreaterThan(0);
    expect(formatters.every((name) => /^(axis|tooltip|label):/.test(name!))).toBe(true);
    // Every string formatter value in the option is one of ours (functions), never a template string.
    const strings: string[] = [];
    JSON.stringify(option, (key, value: unknown) => { if (key === "formatter" && typeof value === "string") strings.push(value); return value; });
    expect(strings).toEqual([]);
    expect(option.aria).toBeUndefined();
    expect(buildChartOption(bar(), nominal, chartTheme("dark", { forcedColors: true })).option!.aria).toMatchObject({ enabled: true, decal: { show: true } });
  });
});

describe("number formats and compaction", () => {
  test("compaction: 1,284 / 12.9K / $4.2M; currency by ISO code; percent; duration; units", () => {
    expect(compactValue(1284, "number")).toBe("1,284");
    expect(compactValue(12_900, "number")).toBe("12.9K");
    expect(compactValue(4_200_000, "currency:USD")).toBe("$4.2M");
    expect(compactValue(950, "currency:EUR")).toBe("€950");
    expect(compactValue(12.5, "currency:USD")).toBe("$12.50");
    expect(compactValue(0, "currency:USD")).toBe("$0");
    expect(compactValue(0.256, "percent")).toBe("26%");
    expect(compactValue(12_000, "number", "orders")).toBe("12K orders");
    expect(formatValue(4_200_000, "currency:USD")).toBe("$4,200,000.00");
    expect(formatValue(3725, "duration")).toBe("1h 2m");
    expect(formatValue(1234, "number", "users")).toBe("1,234 users");
    expect(formatValue(0.5, "percent", "ignored")).toBe("50%");
  });

  test("KPI deltas: up is good unless upIsGood is false; the full value stays in the title", () => {
    const block: KpiBlock = { id: "k", type: "kpi", queryKey: "q", column: "v", format: "currency:USD", compareTo: { column: "p" } };
    const result = { columns: [{ name: "v", type: "Float64" }, { name: "p", type: "Float64" }], rows: [[48_210.5, 44_120]] };
    expect(kpiValue(block, result)).toMatchObject({ text: "$48.2K", full: "$48,210.50", change: { direction: "up", tone: "good" } });
    expect(kpiValue({ ...block, upIsGood: false }, result).change).toMatchObject({ direction: "up", tone: "bad" });
    // A comparison in another query, and a sparkline.
    const other = { columns: [{ name: "prev", type: "Float64" }], rows: [[50_000]] };
    const series = { columns: [{ name: "d", type: "Date" }, { name: "y", type: "Float64" }], rows: [["a", 1], ["b", 3], ["c", 2]] };
    const lookup = (key: string) => key === "prev" ? other : key === "trend" ? series : null;
    expect(kpiValue({ ...block, compareTo: { queryKey: "prev", column: "prev" } }, result, lookup).change).toMatchObject({ direction: "down", tone: "bad" });
    expect(sparklinePath({ ...block, sparkline: { queryKey: "trend", x: "d", y: "y" } }, lookup)).toBe("M0.00 22.00 L50.00 2.00 L100.00 12.00");
    expect(sparklinePath(block, lookup)).toBeNull();
  });
});
