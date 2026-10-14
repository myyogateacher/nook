import { describe, expect, test } from "bun:test";
import "./support/harness";
import { upgradeSpec, type ChartBlock, type ReportBlock } from "../shared/reports";
import {
  BULLET_BANDS, DIVERGING, EMPHASIS_MUTED, inkOn, METER, ordinalRamp, REPORT_INK, REPORT_SERIES, SEQUENTIAL_BLUE, SEQUENTIAL_DARK_LIMIT, sequentialRamp, STATUS, waterfallColors
} from "../shared/reportTheme";
import { boxStats, findCycle, histogramBins, quantileSorted } from "../shared/reportStats";
import { buildChartOption, chartTheme, optionJson, type ChartData } from "../src/reports/chartOption";
import { facetColumns, meterModel, niceCeil } from "../src/reports/chartKinds";
import { contrast } from "./support/paletteCheck";

const { checkDesign, checkSpecShape, checkColumns, SPEC_JSON_SCHEMA } = await import("../server/reports/specValidate");
const { systemPrompt } = await import("../server/reports/generate");
const { PATCH_JSON_SCHEMA } = await import("../server/reports/patch");

/**
 * Chart kinds, round 2 (docs/plan/REPORT_THEME.md § Chart kinds, round 2; D462–D468): each kind's
 * option builder (theme tokens only, named formatters only, escaped text), its design rules and
 * auto-fixes, the deterministic statistics, funnel order, sankey cycles, the combo's one unit, and the
 * small-multiple layout.
 */

type Rows = ChartData & { rows: unknown[][] };
const q = (key: string) => ({ key, sql: "SELECT 1", purpose: "p" });
const spec = (blocks: unknown[]) => ({ version: 1, specVersion: 2, queries: [...new Set(blocks.map((block) => (block as { queryKey: string }).queryKey))].map(q), blocks });
const chart = (overrides: Record<string, unknown>) => ({ id: "c", type: "chart", title: "Chart", queryKey: "q", format: "number", ...overrides });
const col = (name: string, type: string) => ({ name, type });

function design(raw: unknown, results: Record<string, Rows>, changedBlockIds?: string[]) {
  const shape = checkSpecShape(raw);
  if (!shape.ok) throw new Error(shape.errors.join("\n"));
  const map = new Map(Object.entries(results));
  const columns = checkColumns(shape.spec, map);
  if (columns.length) throw new Error(columns.join("\n"));
  return checkDesign(shape.spec, map, { changedBlockIds });
}
const errorsOf = (raw: unknown, results: Record<string, Rows>) => design(raw, results).errors;
const fixesOf = (raw: unknown, results: Record<string, Rows>) => (design(raw, results).spec.blocks[0]?.autoFixes ?? []).map((fix) => fix.rule);
const shapeErrors = (raw: unknown) => { const shape = checkSpecShape(raw); return shape.ok ? [] : shape.errors; };
/** The block as checkSpecShape fills it (a gauge's and histogram's x is their y). */
const blockOf = (raw: Record<string, unknown>) => { const shape = checkSpecShape(spec([raw])); if (!shape.ok) throw new Error(shape.errors.join("\n")); return shape.spec.blocks[0] as ChartBlock; };

// ------------------------------------------------------------------------------------------ fixtures

const cohorts: Rows = {
  columns: [col("cohort", "String"), col("period", "UInt8"), col("retention", "Float64")],
  rows: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].flatMap((cohort, c) => Array.from({ length: 6 - c }, (_, p) => [cohort, p, p === 0 ? 1 : Math.round((0.62 - p * 0.07 + c * 0.01) * 1000) / 1000]))
};
const daily: Rows = { columns: [col("day", "Date"), col("signups", "UInt64")], rows: Array.from({ length: 90 }, (_, at) => [new Date(Date.UTC(2026, 6, 1 + at)).toISOString().slice(0, 10), String(20 + ((at * 7) % 13))]) };
const steps: Rows = { columns: [col("stage", "String"), col("users", "UInt64")], rows: [["Visit", "12000"], ["Sign up", "4200"], ["Activate", "2600"], ["Pay", "900"]] };
const single: Rows = { columns: [col("attained", "Float64"), col("goal", "Float64")], rows: [[78_000, 100_000]] };
const regions: Rows = { columns: [col("region", "String"), col("product", "String"), col("revenue", "Float64")], rows: Array.from({ length: 10 }, (_, r) => ["A", "B"].map((product, p) => [`R${r}`, `${product}${r}`, 1000 - r * 60 + p * 40])).flat() };
const flows: Rows = { columns: [col("src", "String"), col("dst", "String"), col("n", "UInt64")], rows: [["Landing", "Pricing", "500"], ["Landing", "Docs", "300"], ["Pricing", "Signup", "200"], ["Docs", "Signup", "90"], ["Pricing", "Exit", "300"]] };
const durations: Rows = { columns: [col("plan", "String"), col("ms", "Float64")], rows: ["free", "pro", "team"].flatMap((plan, p) => Array.from({ length: 20 }, (_, at) => [plan, 100 + p * 50 + ((at * 37) % 90) + (at === 19 ? 900 : 0)])) };
const amounts: Rows = { columns: [col("amount", "Float64")], rows: Array.from({ length: 200 }, (_, at) => [((at * 7919) % 1000) / 10]) };
const bridge: Rows = { columns: [col("step", "String"), col("delta", "Float64")], rows: [["Q2 revenue", 1000], ["New customers", 240], ["Expansion", 90], ["Churn", -180], ["Price change", -40]] };
const months: Rows = { columns: [col("month", "Date"), col("revenue", "Float64"), col("cost", "Float64")], rows: Array.from({ length: 6 }, (_, at) => [`2026-0${at + 1}-01`, 1000 + at * 120, 700 + at * 60]) };
const teams: Rows = { columns: [col("team", "String"), col("actual", "Float64"), col("goal", "Float64"), col("poor", "Float64"), col("fair", "Float64"), col("good", "Float64")], rows: [["North", 82, 90, 50, 75, 100], ["South", 95, 90, 50, 75, 100], ["East", 60, 80, 40, 70, 100]] };
const byDayGroup = (groups: number): Rows => ({ columns: [col("day", "Date"), col("who", "String"), col("orders", "Float64")], rows: ["2026-10-01", "2026-10-02", "2026-10-03"].flatMap((day, d) => Array.from({ length: groups }, (_, g) => [day, `G${g}`, 10 + g + d])) });

const KINDS: Array<{ kind: string; block: Record<string, unknown>; data: Rows }> = [
  { kind: "heatmap", block: { kind: "heatmap", intent: "matrix", x: "period", x2: "cohort", y: ["retention"], cohort: true, format: "percent" }, data: cohorts },
  { kind: "calendar", block: { kind: "calendar", intent: "trend", x: "day", y: ["signups"], unit: "signups" }, data: daily },
  { kind: "funnel", block: { kind: "funnel", intent: "conversion", x: "stage", y: ["users"], unit: "users" }, data: steps },
  { kind: "gauge", block: { kind: "gauge", intent: "attainment", y: ["attained"], target: "goal", format: "currency:USD" }, data: single },
  { kind: "treemap", block: { kind: "treemap", intent: "share", x: "region", x2: "product", y: ["revenue"], format: "currency:USD" }, data: regions },
  { kind: "sankey", block: { kind: "sankey", intent: "flow", x: "src", x2: "dst", y: ["n"], unit: "visits" }, data: flows },
  { kind: "boxplot", block: { kind: "boxplot", intent: "distribution", x: "plan", y: ["ms"], unit: "ms" }, data: durations },
  { kind: "histogram", block: { kind: "histogram", intent: "distribution", y: ["amount"], format: "currency:USD" }, data: amounts },
  { kind: "waterfall", block: { kind: "waterfall", intent: "delta", x: "step", y: ["delta"], start: true, total: true, format: "currency:USD" }, data: bridge },
  { kind: "combo", block: { kind: "combo", intent: "trend", x: "month", y: ["revenue", "cost"], yUnits: ["USD", "USD"], format: "currency:USD" }, data: months },
  { kind: "bullet", block: { kind: "bullet", intent: "attainment", x: "team", y: ["actual"], target: "goal", ranges: ["poor", "fair", "good"], unit: "points" }, data: teams }
];

// ---------------------------------------------------------------------------------------- helpers

const THEME_COLORS = new Set<string>([
  ...(["dark", "light"] as const).flatMap((mode) => [
    ...Object.values(REPORT_INK[mode]), ...REPORT_SERIES[mode], ...DIVERGING[mode].low, DIVERGING[mode].mid, ...DIVERGING[mode].high, EMPHASIS_MUTED[mode],
    METER[mode].fill, METER[mode].track, ...BULLET_BANDS[mode]
  ]),
  ...SEQUENTIAL_BLUE, ...Object.values(STATUS), "#ffffff", "#000000"
].map((color) => color.toLowerCase()));

/** Every colour string in an option, and every formatter (which must be a named function, never a string). */
function audit(option: unknown) {
  const colors: string[] = [];
  const formatters: unknown[] = [];
  const walk = (value: unknown, key: string) => {
    if (key === "formatter") formatters.push(value);
    if (typeof value === "string" && /^(#|rgb)/i.test(value)) colors.push(value.toLowerCase());
    if (Array.isArray(value)) value.forEach((item) => walk(item, ""));
    else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) walk(item, name);
  };
  walk(option, "");
  return { colors, formatters };
}
const themeColor = (color: string) => THEME_COLORS.has(color) || THEME_COLORS.has(color.slice(0, 7));

// ------------------------------------------------------------------------------------------ the builders

describe("round-2 option builders", () => {
  for (const { kind, block, data } of KINDS) {
    test(`${kind}: builds from the block and rows, in theme tokens and named formatters, in both modes`, () => {
      expect(errorsOf(spec([chart(block)]), { q: data })).toEqual([]);
      for (const mode of ["dark", "light"] as const) {
        const built = buildChartOption(blockOf(chart(block)), data, chartTheme(mode), { width: 640 });
        expect({ kind, problems: built.problems }).toEqual({ kind, problems: [] });
        expect(built.option).not.toBeNull();
        const { colors, formatters } = audit(built.option);
        expect({ kind, offTheme: colors.filter((color) => !themeColor(color)) }).toEqual({ kind, offTheme: [] });
        for (const formatter of formatters) {
          expect(typeof formatter).toBe("function");
          expect(typeof (formatter as { formatterName?: unknown }).formatterName).toBe("string");
        }
        expect(optionJson(built.option)).not.toContain("function");
        expect(built.height).toBeGreaterThan(0);
      }
    });
  }

  test("no formatter string can come from the spec: the schema refuses one on every kind", () => {
    for (const { block } of KINDS) {
      for (const extra of [{ formatter: "{b}: {c}" }, { color: "#ff0000" }, { label: { show: true } }, { itemStyle: {} }, { visualMap: {} }]) {
        expect({ kind: block.kind, extra, ok: checkSpecShape(spec([chart({ ...block, ...extra })])).ok }).toEqual({ kind: block.kind, extra, ok: false });
      }
    }
  });

  test("tooltip text from the rows is escaped", () => {
    const evil: Rows = { columns: steps.columns, rows: [["<img src=x onerror=alert(1)>", "10"], ["b", "5"]] };
    const built = buildChartOption(blockOf(chart(KINDS[2]!.block)), evil, chartTheme("dark"));
    const formatter = (built.option!.tooltip as { formatter: (params: unknown) => string }).formatter;
    const html = formatter({ dataIndex: 0, name: "<img src=x onerror=alert(1)>", value: 10 });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("heatmap: sequential steps, cohort order kept, percent cell labels with contrast-picked ink, a scale, and a sideways scroll on a narrow tile", () => {
    const block = blockOf(chart(KINDS[0]!.block));
    const built = buildChartOption(block, cohorts, chartTheme("light"), { width: 640 });
    const series = (built.option!.series as Array<Record<string, unknown>>)[0]!;
    expect((built.option!.yAxis as { data: string[] }).data).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
    expect((built.option!.visualMap as { pieces: Array<{ color: string }> }).pieces.map((piece) => piece.color)).toEqual(sequentialRamp("light", 7));
    expect((series.label as { formatter: (params: unknown) => string }).formatter({ value: [0, 0, 0.5] })).toBe("50%");
    for (const point of series.data as Array<{ value: number[]; label: { color: string } }>) expect(point.label.color).toBe(inkOn(sequentialRamp("light", 7)[point.value[3]!]!));
    expect(built.scale!.length).toBe(7);
    expect(built.minWidth).toBeUndefined();
    const wide: Rows = { columns: cohorts.columns, rows: Array.from({ length: 30 }, (_, p) => ["2026-01", p, 0.5]) };
    expect(buildChartOption(block, wide, chartTheme("dark"), { width: 358 }).minWidth).toBeGreaterThan(358);
  });

  test("heatmap: a midpoint with values on both sides is diverging; without one it stays sequential", () => {
    const signed: Rows = { columns: [col("week", "UInt8"), col("team", "String"), col("change", "Float64")], rows: [[1, "A", -5], [2, "A", 3], [1, "B", 8], [2, "B", -1]] };
    const raw = chart({ kind: "heatmap", intent: "matrix", x: "week", x2: "team", y: ["change"], midpoint: 0 });
    expect(errorsOf(spec([{ ...raw, x2: "team" }]), { q: { ...signed, rows: signed.rows } })).toEqual(["block c: rule 12: heatmap axes must be ordered (dates, numbers, periods, weekdays, or numbered steps such as Week 3); team is not, so use a bar chart or a table"]);
    const pieces = (option: Record<string, unknown>) => (option.visualMap as { pieces: Array<{ color: string }> }).pieces.map((piece) => piece.color);
    const diverging = buildChartOption(blockOf(raw), signed, chartTheme("dark"));
    expect(pieces(diverging.option!)).toEqual([...DIVERGING.dark.low, DIVERGING.dark.mid, ...DIVERGING.dark.high]);
    const { midpoint: _drop, ...plain } = raw;
    expect(pieces(buildChartOption(blockOf(plain), signed, chartTheme("dark")).option!)).toEqual(sequentialRamp("dark", 7));
  });

  test("funnel: stages keep the rows' order (never re-sorted), with conversion from the previous stage in labels and tooltip", () => {
    const shuffled: Rows = { columns: steps.columns, rows: [["Visit", "100"], ["Pay", "80"], ["Activate", "40"]] };
    const built = buildChartOption(blockOf(chart(KINDS[2]!.block)), shuffled, chartTheme("dark"));
    const series = (built.option!.series as Array<Record<string, unknown>>)[0]!;
    expect(series.sort).toBe("none");
    expect((series.data as Array<{ name: string }>).map((item) => item.name)).toEqual(["Visit", "Pay", "Activate"]);
    const label = (series.label as { formatter: (params: unknown) => string }).formatter({ dataIndex: 1, name: "Pay", value: 80 });
    expect(label).toContain("80%");
    const tooltip = (built.option!.tooltip as { formatter: (params: unknown) => string }).formatter({ dataIndex: 2, name: "Activate", value: 40 });
    expect(tooltip).toContain("From the previous stage: <b>50%</b>");
    expect(tooltip).toContain("Of the first stage: <b>40%</b>");
    expect((series.data as Array<{ itemStyle: { color: string } }>).map((item) => item.itemStyle.color)).toEqual(ordinalRamp("dark", 3));
  });

  test("gauge: a meter with a same-ramp track, the target tick, and a status that always has an icon and a label", () => {
    const block = blockOf(chart(KINDS[3]!.block));
    const built = buildChartOption(block, single, chartTheme("dark"));
    expect(built.view).toBe("meter");
    const model = built.option as unknown as ReturnType<typeof meterModel> & { status: { label: string; icon: string } };
    expect(model).toMatchObject({ type: "meter", value: 78_000, target: 100_000, track: METER.dark.track, caption: "78% of target $100K" });
    expect(model.status).toMatchObject({ tone: "critical", icon: "cross", label: "Below target" });
    const near = meterModel(block, { columns: single.columns, rows: [[85_000, 100_000]] }, chartTheme("light"));
    expect(typeof near !== "string" && near.status).toMatchObject({ tone: "warning", icon: "alert", label: "Near target" });
    const hit = meterModel(block, { columns: single.columns, rows: [[120_000, 100_000]] }, chartTheme("light"));
    expect(typeof hit !== "string" && [hit.fill, hit.status?.label]).toEqual([METER.light.fill, "On target"]);
    // Without a target: no status at all, the ramp fill against max.
    const maxOnly = meterModel(blockOf(chart({ kind: "gauge", intent: "attainment", y: ["attained"], max: 200_000, format: "number" })), single, chartTheme("dark"));
    expect(typeof maxOnly !== "string" && [maxOnly.status, maxOnly.fill, maxOnly.ratio]).toEqual([null, METER.dark.fill, 0.39]);
  });

  test("treemap: categorical hues on the top level only (children wear their parent's), more than 8 groups fold into Other", () => {
    const built = buildChartOption(blockOf(chart(KINDS[4]!.block)), regions, chartTheme("dark"));
    const data = (built.option!.series as Array<{ data: Array<{ name: string; itemStyle: { color: string }; children?: Array<{ itemStyle: { color: string } }> }> }>)[0]!.data;
    expect(data.map((node) => node.name)).toEqual(["R0", "R1", "R2", "R3", "R4", "R5", "R6", "Other"]);
    expect(data.slice(0, 7).map((node) => node.itemStyle.color)).toEqual(REPORT_SERIES.dark.slice(0, 7));
    expect(data[7]!.itemStyle.color).toBe(EMPHASIS_MUTED.dark);
    for (const node of data) for (const child of node.children ?? []) expect(child.itemStyle.color).toBe(node.itemStyle.color);
    expect(built.autoFixes.map((fix) => fix.rule)).toEqual(["fold_groups"]);
  });

  test("boxplot: quartiles computed deterministically, outliers as dots; precomputed five numbers drawn as given", () => {
    const built = buildChartOption(blockOf(chart(KINDS[6]!.block)), durations, chartTheme("dark"));
    const [box, outliers] = built.option!.series as Array<{ data: unknown[] }>;
    const free = durations.rows.filter((row) => row[0] === "free").map((row) => row[1] as number);
    const stats = boxStats(free)!;
    expect(box!.data[0]).toEqual([stats.low, stats.q1, stats.median, stats.q3, stats.high]);
    expect(outliers!.data).toContainEqual(["free", 100 + ((19 * 37) % 90) + 900]);
    expect(built.autoFixes[0]!.rule).toBe("quartiles");
    const five: Rows = { columns: [col("plan", "String"), col("lo", "Float64"), col("a", "Float64"), col("m", "Float64"), col("b", "Float64"), col("hi", "Float64")], rows: [["free", 1, 2, 3, 4, 5]] };
    const pre = buildChartOption(blockOf(chart({ kind: "boxplot", intent: "distribution", x: "plan", y: ["lo", "a", "m", "b", "hi"], unit: "ms" })), five, chartTheme("dark"));
    expect((pre.option!.series as Array<{ data: unknown[] }>)[0]!.data).toEqual([[1, 2, 3, 4, 5]]);
  });

  test("histogram: Freedman–Diaconis bins, counts that add up, the same option whatever the row order", () => {
    const block = blockOf(chart(KINDS[7]!.block));
    const one = buildChartOption(block, amounts, chartTheme("dark"));
    const counts = (one.option!.series as Array<{ data: number[] }>)[0]!.data;
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(200);
    expect(counts.length).toBe(histogramBins(amounts.rows.map((row) => row[0] as number))!.counts.length);
    const reversed = buildChartOption(block, { columns: amounts.columns, rows: [...amounts.rows].reverse() }, chartTheme("dark"));
    expect(optionJson(reversed.option)).toBe(optionJson(one.option));
  });

  test("waterfall: rises and falls on the diverging poles, totals neutral, steps in row order, signed labels", () => {
    const built = buildChartOption(blockOf(chart(KINDS[8]!.block)), bridge, chartTheme("dark"));
    const [base, bars] = built.option!.series as Array<{ data: Array<number | { value: number; itemStyle: { color: string } }>; label?: { formatter: (params: unknown) => string } }>;
    const colors = waterfallColors("dark");
    expect((built.option!.xAxis as { data: string[] }).data).toEqual(["Q2 revenue", "New customers", "Expansion", "Churn", "Price change", "Total"]);
    expect(bars!.data.map((item) => (item as { itemStyle: { color: string } }).itemStyle.color)).toEqual([colors.total, colors.up, colors.up, colors.down, colors.down, colors.total]);
    expect(base!.data).toEqual([0, 1000, 1240, 1150, 1110, 0]);
    expect(bars!.data.map((item) => (item as { value: number }).value)).toEqual([1000, 240, 90, 180, 40, 1110]);
    expect(bars!.label!.formatter({ dataIndex: 3 })).toBe("−$180");
    for (const color of Object.values(STATUS)) expect([colors.up, colors.down, colors.total]).not.toContain(color);
  });

  test("combo: one bar and one line on one value axis", () => {
    const built = buildChartOption(blockOf(chart(KINDS[9]!.block)), months, chartTheme("dark"));
    expect(Array.isArray(built.option!.yAxis)).toBe(false);
    expect((built.option!.series as Array<{ type: string }>).map((item) => item.type)).toEqual(["bar", "line"]);
  });

  test("bullet: neutral bands, the measure in slot 1, the target as an ink tick, one value axis", () => {
    const built = buildChartOption(blockOf(chart(KINDS[10]!.block)), teams, chartTheme("light"));
    const series = built.option!.series as Array<{ type: string; itemStyle?: { color?: string }; data: unknown[] }>;
    expect(series.slice(0, 3).map((item) => item.itemStyle!.color)).toEqual([...BULLET_BANDS.light]);
    expect(series[1]!.data).toEqual([25, 25, 30]);
    expect(series[3]!.itemStyle!.color).toBe(REPORT_SERIES.light[0]);
    expect(series[4]).toMatchObject({ type: "scatter", itemStyle: { color: REPORT_INK.light.ink } });
    expect(Array.isArray(built.option!.xAxis)).toBe(false);
  });

  test("stack: a stacked area, and a 100 % stacked bar whose parts are shares of each category", () => {
    const data: Rows = { columns: [col("day", "Date"), col("web", "Float64"), col("app", "Float64")], rows: [["2026-10-01", 30, 10], ["2026-10-02", 20, 20]] };
    const area = buildChartOption(blockOf(chart({ kind: "area", intent: "share", x: "day", y: ["web", "app"], stack: "normal" })), data, chartTheme("dark"));
    expect((area.option!.series as Array<{ stack?: string }>).every((item) => item.stack === "total")).toBe(true);
    const percent = buildChartOption(blockOf(chart({ kind: "bar", intent: "share", x: "day", y: ["web", "app"], stack: "percent" })), data, chartTheme("dark"));
    const series = percent.option!.series as Array<{ stack?: string; data: unknown[] }>;
    expect(series.map((item) => item.stack)).toEqual(["total", "total"]);
    expect(series[0]!.data).toEqual([0.75, 0.5]);
    expect(percent.option!.yAxis).toMatchObject({ min: 0, max: 1 });
    expect(errorsOf(spec([chart({ kind: "bar", intent: "share", x: "day", y: ["web", "app"], stack: "percent" })]), { q: data })).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------- small multiples

describe("small multiples (facet)", () => {
  test("panels in a grid that follows the tile's width, every panel on one y scale", () => {
    expect([facetColumns(358, 6), facetColumns(600, 6), facetColumns(1000, 6), facetColumns(1000, 2)]).toEqual([2, 3, 4, 2]);
    const block = blockOf(chart({ kind: "line", intent: "trend", x: "day", y: ["orders"], facet: "who" }));
    for (const [width, columns] of [[358, 2], [700, 3], [1100, 4]] as const) {
      const built = buildChartOption(block, byDayGroup(6), chartTheme("dark"), { width });
      const grids = built.option!.grid as Array<{ left: string; top: number }>;
      expect(grids.length).toBe(6);
      expect(new Set(grids.map((grid) => grid.left)).size).toBe(columns);
      expect(new Set(grids.map((grid) => grid.top)).size).toBe(Math.ceil(6 / columns));
      const axes = built.option!.yAxis as Array<{ min: number; max: number }>;
      expect(new Set(axes.map((axis) => `${axis.min}:${axis.max}`)).size).toBe(1);
      expect(axes[0]).toMatchObject({ min: 0, max: niceCeil(17) });
      expect((built.option!.title as Array<{ text: string }>).map((title) => title.text)).toEqual(["G0", "G1", "G2", "G3", "G4", "G5"]);
    }
  });

  test("more than 12 panels: the top 11 and Other", () => {
    const built = buildChartOption(blockOf(chart({ kind: "bar", intent: "compare", x: "day", y: ["orders"], facet: "who" })), byDayGroup(15), chartTheme("dark"), { width: 1100 });
    const titles = (built.option!.title as Array<{ text: string }>).map((title) => title.text);
    expect(titles.length).toBe(12);
    expect(titles[11]).toBe("Other");
    expect(built.autoFixes.map((fix) => fix.rule)).toEqual(["fold_panels"]);
    expect(fixesOf(spec([chart({ kind: "bar", intent: "compare", x: "day", y: ["orders"], facet: "who" })]), { q: byDayGroup(15) })).toContain("fold_panels");
  });

  test("the auto-fix for too many series: a line over 8 series and a scatter over 3 draw as panels; a v1 line keeps its fold", () => {
    const line = blockOf(chart({ kind: "line", intent: "trend", x: "day", y: ["orders"], series: "who" }));
    const built = buildChartOption(line, byDayGroup(10), chartTheme("dark"), { width: 700 });
    expect((built.option!.grid as unknown[]).length).toBe(10);
    expect(built.autoFixes[0]!.rule).toBe("facet");
    expect((buildChartOption(line, byDayGroup(5), chartTheme("dark")).option!.series as unknown[]).length).toBe(5);
    const legacy = upgradeSpec({ version: 1, queries: [q("q")], blocks: [{ id: "c", type: "chart", queryKey: "q", kind: "line", x: "day", y: ["orders"], series: "who" }] }).blocks[0] as ChartBlock;
    const folded = buildChartOption(legacy, byDayGroup(10), chartTheme("dark"));
    expect(folded.option!.grid).not.toBeInstanceOf(Array);
    expect(folded.autoFixes[0]!.rule).toBe("fold_series");
    const scatter: Rows = { columns: [col("a", "Float64"), col("b", "Float64"), col("who", "String")], rows: Array.from({ length: 16 }, (_, at) => [at, at * 2, `S${at % 4}`]) };
    const panels = buildChartOption(blockOf(chart({ kind: "scatter", intent: "relationship", x: "a", y: ["b"], series: "who" })), scatter, chartTheme("dark"));
    expect((panels.option!.grid as unknown[]).length).toBe(4);
  });

  test("facet belongs to line, bar, and area, and not with series", () => {
    expect(shapeErrors(spec([chart({ kind: "pie", intent: "share", x: "day", y: ["orders"], facet: "who" })])).join()).toContain("facet is only for line, bar, area");
    expect(shapeErrors(spec([chart({ kind: "line", intent: "trend", x: "day", y: ["orders"], facet: "who", series: "who" })])).join()).toContain("drop series");
    expect(errorsOf(spec([chart({ kind: "line", intent: "trend", x: "day", y: ["orders"], facet: "who" })]), { q: byDayGroup(1) }).join()).toContain("rule 23");
  });
});

// ------------------------------------------------------------------------------------------ the rules

describe("round-2 design rules", () => {
  test("rule 11: each kind serves its intent, and each new intent its kinds", () => {
    expect(errorsOf(spec([chart({ ...KINDS[2]!.block, intent: "compare" })]), { q: steps }).join()).toContain("rule 11: a funnel is for intent conversion, not compare");
    expect(errorsOf(spec([chart({ kind: "bar", intent: "conversion", x: "stage", y: ["users"] })]), { q: steps }).join()).toContain("rule 11: intent conversion is drawn as a funnel, not a bar");
    // An intent left out is the kind's own.
    const { intent: _drop, ...noIntent } = KINDS[5]!.block;
    expect(errorsOf(spec([chart(noIntent)]), { q: flows })).toEqual([]);
  });

  test("fields belong to their kinds; each kind takes its measures", () => {
    expect(shapeErrors(spec([chart({ kind: "bar", intent: "compare", x: "stage", y: ["users"], target: "users" })])).join()).toContain("target is only for gauge, bullet");
    expect(shapeErrors(spec([chart({ kind: "heatmap", intent: "matrix", x: "period", y: ["retention"] })])).join()).toContain("needs x2");
    expect(shapeErrors(spec([chart({ kind: "funnel", intent: "conversion", x: "stage", y: ["users", "users"] })])).join()).toContain("exactly one y");
    expect(shapeErrors(spec([chart({ kind: "boxplot", intent: "distribution", x: "plan", y: ["ms", "ms"] })])).join()).toContain("min, q1, median, q3, max");
    expect(shapeErrors(spec([chart({ kind: "gauge", intent: "attainment", y: ["attained"] })])).join()).toContain("target column or a max");
    expect(shapeErrors(spec([chart({ kind: "combo", intent: "trend", x: "month", y: ["revenue", "cost"] })])).join()).toContain("needs yUnits");
    expect(shapeErrors(spec([chart({ kind: "funnel", intent: "conversion", x: "stage", y: ["users"], emphasis: "Pay" })])).join()).toContain("emphasis is not used by funnel");
    expect(shapeErrors(spec([chart({ kind: "funnel", intent: "conversion", y: ["users"] })])).join()).toContain("a funnel needs x");
    expect(blockOf(chart(KINDS[7]!.block)).x).toBe("amount");
  });

  test("rule 12: a heatmap is at most 40 × 40 cells of ordered axes", () => {
    const big: Rows = { columns: cohorts.columns, rows: Array.from({ length: 41 }, (_, p) => ["2026-01", p, 0.5]) };
    expect(errorsOf(spec([chart(KINDS[0]!.block)]), { q: big }).join()).toContain("rule 12: the heatmap would be 41 columns × 1 rows; at most 40×40");
    const weekdays: Rows = { columns: [col("weekday", "String"), col("hour", "UInt8"), col("n", "UInt64")], rows: ["Mon", "Tue", "Wed"].flatMap((day) => [0, 1].map((hour) => [day, hour, "3"])) };
    expect(errorsOf(spec([chart({ kind: "heatmap", intent: "matrix", x: "hour", x2: "weekday", y: ["n"], unit: "orders" })]), { q: weekdays })).toEqual([]);
  });

  test("rule 13: a calendar runs over dates, at most 2 years", () => {
    const long: Rows = { columns: daily.columns, rows: [["2023-01-01", "1"], ["2026-01-01", "2"]] };
    expect(errorsOf(spec([chart(KINDS[1]!.block)]), { q: long }).join()).toContain("rule 13: a calendar shows at most 2 years");
    expect(errorsOf(spec([chart({ ...KINDS[1]!.block, x: "signups", y: ["signups"] })]), { q: daily }).join()).toContain("rule 13: a calendar needs x to be a Date");
  });

  test("rule 14: a funnel has 2–8 stages and never increases (refused with a hint)", () => {
    const rising: Rows = { columns: steps.columns, rows: [["Visit", "100"], ["Sign up", "120"]] };
    expect(errorsOf(spec([chart(KINDS[2]!.block)]), { q: rising }).join()).toContain("rule 14: funnel values must not increase from one stage to the next (Sign up 120 > Visit 100); order the rows by stage");
    const many: Rows = { columns: steps.columns, rows: Array.from({ length: 9 }, (_, at) => [`S${at}`, String(100 - at)]) };
    expect(errorsOf(spec([chart(KINDS[2]!.block)]), { q: many }).join()).toContain("rule 14: a funnel has 2–8 stages");
  });

  test("rule 15: a gauge reads one value from a one-row result", () => {
    const two: Rows = { columns: single.columns, rows: [[1, 2], [3, 4]] };
    expect(errorsOf(spec([chart(KINDS[3]!.block)]), { q: two }).join()).toContain("rule 15: a gauge shows one value from a one-row result");
    // Rule 6 does not send a gauge to a KPI.
    expect(errorsOf(spec([chart(KINDS[3]!.block)]), { q: single })).toEqual([]);
  });

  test("rule 16: a treemap shows positive values; the ninth group on folds (auto)", () => {
    const negative: Rows = { columns: regions.columns, rows: [["R0", "a", 5], ["R1", "b", -3]] };
    expect(errorsOf(spec([chart(KINDS[4]!.block)]), { q: negative }).join()).toContain("rule 16");
    expect(fixesOf(spec([chart(KINDS[4]!.block)]), { q: regions })).toContain("fold_groups");
  });

  test("rule 17: a sankey is at most 30 nodes and 60 links, and a cycle is refused", () => {
    const cyclic: Rows = { columns: flows.columns, rows: [...flows.rows, ["Signup", "Landing", "10"]] };
    expect(errorsOf(spec([chart(KINDS[5]!.block)]), { q: cyclic }).join()).toContain("rule 17: the flows form a cycle (Signup → Landing → Pricing → Signup)");
    expect(buildChartOption(blockOf(chart(KINDS[5]!.block)), cyclic, chartTheme("dark")).problems.join()).toContain("cycle");
    const big: Rows = { columns: flows.columns, rows: Array.from({ length: 31 }, (_, at) => [`A${at}`, `B${at}`, "1"]) };
    expect(errorsOf(spec([chart(KINDS[5]!.block)]), { q: big }).join()).toContain("rule 17: a sankey shows at most 30 nodes and 60 links (this has 62 and 31)");
  });

  test("rule 18: box plots: at most 20 categories; precomputed numbers in order; raw values get quartiles (auto)", () => {
    expect(fixesOf(spec([chart(KINDS[6]!.block)]), { q: durations })).toEqual(["quartiles"]);
    const five: Rows = { columns: [col("plan", "String"), col("lo", "Float64"), col("a", "Float64"), col("m", "Float64"), col("b", "Float64"), col("hi", "Float64")], rows: [["free", 1, 4, 3, 2, 5]] };
    expect(errorsOf(spec([chart({ kind: "boxplot", intent: "distribution", x: "plan", y: ["lo", "a", "m", "b", "hi"], unit: "ms" })]), { q: five }).join()).toContain("rule 18: a precomputed box needs min ≤ q1 ≤ median ≤ q3 ≤ max");
    // Five numbers of one box are one measure: rule 7's scale check does not apply.
    const wide: Rows = { columns: five.columns, rows: [["free", 1, 2, 3, 4, 500], ["pro", 1, 2, 3, 4, 6]] };
    expect(errorsOf(spec([chart({ kind: "boxplot", intent: "distribution", x: "plan", y: ["lo", "a", "m", "b", "hi"], unit: "ms" })]), { q: wide })).toEqual([]);
  });

  test("rule 19: a histogram needs 5 values; its bins are recorded (auto)", () => {
    expect(errorsOf(spec([chart(KINDS[7]!.block)]), { q: { columns: amounts.columns, rows: amounts.rows.slice(0, 3) } }).join()).toContain("rule 19");
    const fix = design(spec([chart(KINDS[7]!.block)]), { q: amounts }).spec.blocks[0]!.autoFixes!.find((item) => item.rule === "bin")!;
    expect(fix.detail).toMatch(/^\d+ bins of width .* \(Freedman–Diaconis, clamped to 5–50\)$/);
  });

  test("rule 20: a waterfall has 2–25 steps", () => {
    expect(errorsOf(spec([chart(KINDS[8]!.block)]), { q: { columns: bridge.columns, rows: Array.from({ length: 26 }, (_, at) => [`s${at}`, 1]) } }).join()).toContain("rule 20");
  });

  test("rule 21: a combo refuses two units (never a second axis)", () => {
    const errors = errorsOf(spec([chart({ ...KINDS[9]!.block, yUnits: ["USD", "orders"] })]), { q: months });
    expect(errors.join()).toContain("rule 21: the bar (USD) and the line (orders) have different units; a combo shares one axis and there is never a second one, so split them into two charts");
    // Rule 7 still applies to measures of very different scale.
    const scaled: Rows = { columns: months.columns, rows: months.rows.map((row) => [row[0], (row[1] as number) * 100, row[2]]) };
    expect(errorsOf(spec([chart(KINDS[9]!.block)]), { q: scaled }).join()).toContain("rule 7");
  });

  test("rule 22: bullet ranges ascend", () => {
    const bad: Rows = { columns: teams.columns, rows: [["North", 82, 90, 80, 75, 100]] };
    expect(errorsOf(spec([chart(KINDS[10]!.block)]), { q: bad }).join()).toContain("rule 22: bullet ranges must ascend");
  });

  test("an edit is checked on the blocks it changes only (changedBlockIds)", () => {
    const rising: Rows = { columns: steps.columns, rows: [["Visit", "100"], ["Sign up", "120"]] };
    const raw = spec([chart(KINDS[2]!.block)]);
    expect(design(raw, { q: rising }, ["other"]).errors).toEqual([]);
    expect(design(raw, { q: rising }, ["c"]).errors.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------- stats and theme

describe("deterministic statistics", () => {
  test("quartiles interpolate linearly (numpy's default)", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect([0.25, 0.5, 0.75].map((p) => quantileSorted(sorted, p))).toEqual([3.25, 5.5, 7.75]);
    expect(boxStats([10, 1, 5, 3, 100])).toEqual({ min: 1, q1: 3, median: 5, q3: 10, max: 100, low: 1, high: 10, outliers: [100], n: 5 });
    expect(boxStats([3, 1, 2, 5, 4])).toEqual(boxStats([1, 2, 3, 4, 5]));
    expect(boxStats([])).toBeNull();
  });

  test("Freedman–Diaconis bins, clamped to 5–50, Sturges when the IQR is 0", () => {
    const uniform = Array.from({ length: 1000 }, (_, at) => at);
    const bins = histogramBins(uniform)!;
    expect(bins.rule).toBe("freedman-diaconis");
    expect(bins.counts.length).toBe(Math.ceil(999 / (2 * (quantileSorted(uniform, 0.75) - quantileSorted(uniform, 0.25)) * Math.cbrt(1 / 1000))));
    expect(bins.counts.reduce((sum, n) => sum + n, 0)).toBe(1000);
    expect(histogramBins([1, 2, 3])!.counts.length).toBe(5);
    // A long tail asks for thousands of bins: clamped to 50.
    expect(histogramBins([...Array.from({ length: 1000 }, (_, at) => at / 1000), 1_000_000])!.counts.length).toBe(50);
    const flat = histogramBins([0, 0, 0, 0, 0, 0, 0, 0, 1])!;
    expect(flat.rule).toBe("sturges");
    expect(histogramBins([7, 7, 7])!.counts).toEqual([0, 0, 3, 0, 0]);
    expect(histogramBins([5, 1, 4, 2, 3, 9, 8])).toEqual(histogramBins([1, 2, 3, 4, 5, 8, 9]));
  });

  test("cycles: found, deterministically; none in a DAG", () => {
    expect(findCycle([["a", "b"], ["b", "c"], ["c", "a"]])).toEqual(["a", "b", "c", "a"]);
    expect(findCycle([["a", "a"]])).toEqual(["a", "a"]);
    expect(findCycle([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]])).toBeNull();
  });
});

describe("round-2 theme tokens", () => {
  const surface = { dark: REPORT_INK.dark.surface, light: REPORT_INK.light.surface };
  test("the sequential ramp recedes toward the surface at its low end in both modes", () => {
    expect(sequentialRamp("light", 13)).toEqual([...SEQUENTIAL_BLUE]);
    expect(sequentialRamp("dark", 13)).toEqual([...SEQUENTIAL_BLUE].reverse());
    for (const mode of ["dark", "light"] as const) {
      const ramp = sequentialRamp(mode, 7);
      expect(contrast(ramp[0]!, surface[mode])).toBeLessThan(contrast(ramp[6]!, surface[mode]));
    }
  });

  test("the ordinal ramp (funnel stages) clears 2:1 on its surface: from step 250 on light, to step 600 on dark", () => {
    for (const mode of ["dark", "light"] as const) for (const n of [2, 5, 8]) for (const color of ordinalRamp(mode, n)) expect(contrast(color, surface[mode])).toBeGreaterThanOrEqual(2);
    expect(ordinalRamp("dark", 8)).not.toContain(SEQUENTIAL_BLUE[SEQUENTIAL_DARK_LIMIT + 1]);
    expect(ordinalRamp("light", 8)).not.toContain(SEQUENTIAL_BLUE[2]);
  });

  test("text on a coloured fill clears 4.5:1 on every ramp step and categorical hue", () => {
    for (const fill of [...SEQUENTIAL_BLUE, ...REPORT_SERIES.dark, ...REPORT_SERIES.light, ...DIVERGING.dark.high, DIVERGING.dark.mid, DIVERGING.light.mid]) {
      expect({ fill, ok: contrast(inkOn(fill), fill) >= 4.5 }).toEqual({ fill, ok: true });
    }
  });

  test("the meter's fill stands out from its track; bullet bands step away from the surface; waterfall poles are not status colours", () => {
    for (const mode of ["dark", "light"] as const) {
      expect(contrast(METER[mode].fill, METER[mode].track)).toBeGreaterThanOrEqual(1.8);
      const bands = BULLET_BANDS[mode].map((band) => contrast(band, surface[mode]));
      expect(bands).toEqual([...bands].sort((left, right) => right - left));
      expect(bands[bands.length - 1]!).toBeGreaterThan(1.05);
      const colors = waterfallColors(mode);
      expect(Object.values(STATUS)).not.toContain(colors.up);
      expect(Object.values(STATUS)).not.toContain(colors.down);
      expect(contrast(colors.total, surface[mode])).toBeGreaterThanOrEqual(3);
    }
  });
});

// ------------------------------------------------------------------------------------- schema, prompt

describe("schemas and prompts teach the round-2 kinds", () => {
  test("submit_report and submit_patch offer every kind and its fields, and stay closed", () => {
    for (const schema of [SPEC_JSON_SCHEMA, PATCH_JSON_SCHEMA]) {
      const json = JSON.stringify(schema);
      for (const word of ["heatmap", "calendar", "funnel", "gauge", "treemap", "sankey", "boxplot", "histogram", "waterfall", "combo", "bullet", "\"x2\"", "\"midpoint\"", "\"cohort\"", "\"target\"", "\"ranges\"", "\"yUnits\"", "\"stack\"", "\"facet\"", "\"percent\""]) expect({ word, found: json.includes(word) }).toEqual({ word, found: true });
      expect(json).not.toMatch(/"color"|"formatter"|"style"/);
    }
  });

  test("the generation prompt routes questions to kinds and states their limits", () => {
    const prompt = systemPrompt({ database: "analytics", timeout_s: 20, max_rows: 10_000, allowlist_json: "[\"analytics\"]", id: "x" } as never, { title: "Doc", markdown: "# Metrics" }).text;
    for (const phrase of ["cohort retention → heatmap", "conversion steps → funnel", "target attainment → gauge", "composition over time → area with stack percent", "flow between states → sankey", "distribution → histogram", "contribution to change → waterfall", "40×40", "no cycles", "different units are refused", "at most 12 panels"]) {
      expect({ phrase, found: prompt.includes(phrase) }).toEqual({ phrase, found: true });
    }
  });

  test("old specs still render unchanged: a v1 spec of every old kind builds the same option shape", () => {
    const blocks = (["line", "area", "bar", "stacked_bar", "horizontal_bar", "pie", "scatter"] as const).map((kind, at) => ({ id: `b${at}`, type: "chart", queryKey: "q", kind, x: "day", y: ["orders"] }));
    const upgraded = upgradeSpec({ version: 1, queries: [q("q")], blocks }).blocks as ReportBlock[];
    const data = byDayGroup(1);
    for (const block of upgraded as ChartBlock[]) {
      const built = buildChartOption(block, data, chartTheme("dark"));
      expect({ kind: block.kind, problems: built.problems, view: built.view, grid: Array.isArray(built.option!.grid) }).toEqual({ kind: block.kind, problems: [], view: undefined, grid: false });
    }
  });
});

describe("the meter and the colour scale render as HTML", () => {
  test("the meter shows its value, the status icon and label together, and a target tick; the scale lists low and high", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MeterView, ScaleLegend } = await import("../src/reports/ReportView");
    const model = meterModel(blockOf(chart(KINDS[3]!.block)), single, chartTheme("dark"));
    if (typeof model === "string") throw new Error(model);
    const html = renderToStaticMarkup(<MeterView model={model} label="Attained" />);
    expect(html).toContain("$78K");
    expect(html).toContain("Below target");
    expect(html).toMatch(/report-meter-status[^>]*><svg/);
    expect(html).toContain("report-meter-target");
    const scale = renderToStaticMarkup(<ScaleLegend steps={[{ color: "#cde2fb", label: "0–5", from: "0", to: "5" }, { color: "#0d366b", label: "5–10", from: "5", to: "10" }]} />);
    expect(scale).toContain("Colour scale from 0 to 10");
  });
});

describe("the showcase-2 QA script", () => {
  test("its report uses every round-2 kind, passes the design rules over the fake answers, and every chart builds; its first submit is refused by rules 11 and 21", async () => {
    const { showcase2Spec, showcase2Answer, SHOWCASE2_QUERIES } = await import("../scripts/fakeReportProvider");
    const results = Object.fromEntries(Object.entries(SHOWCASE2_QUERIES).map(([key, sql]) => {
      const answer = showcase2Answer(sql);
      expect({ key, answered: answer !== null }).toEqual({ key, answered: true });
      return [key, { columns: answer!.meta, rows: answer!.data }];
    }));
    const good = design(showcase2Spec(), results as Record<string, Rows>);
    expect(good.errors).toEqual([]);
    const charts = good.spec.blocks.filter((block): block is ChartBlock => block.type === "chart");
    for (const kind of ["heatmap", "calendar", "funnel", "gauge", "treemap", "sankey", "boxplot", "histogram", "waterfall", "combo", "bullet"]) expect(charts.map((block) => block.kind)).toContain(kind);
    expect(charts.some((block) => block.facet)).toBe(true);
    expect(charts.filter((block) => block.stack === "percent").map((block) => block.kind).sort()).toEqual(["area", "bar"]);
    for (const block of charts) {
      const built = buildChartOption(block, results[block.queryKey] as Rows, chartTheme("dark"), { width: 358 });
      expect({ id: block.id, problems: built.problems }).toEqual({ id: block.id, problems: [] });
    }
    const bad = design(showcase2Spec({ bad: true }), results as Record<string, Rows>).errors.join("\n");
    expect(bad).toContain("rule 11");
    expect(bad).toContain("rule 21");
  });
});
