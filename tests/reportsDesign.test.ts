import { describe, expect, test } from "bun:test";
import "./support/harness";
import { ordinalX, upgradeSpec, type ReportBlock, type ReportSpec } from "../shared/reports";
import { buildChartOption, chartTheme } from "../src/reports/chartOption";
import { kpiValue } from "../src/reports/KpiTile";

const { checkDesign, checkSpecShape, checkColumns, SPEC_JSON_SCHEMA, DESIGN_LIMITS } = await import("../server/reports/specValidate");
const { systemPrompt } = await import("../server/reports/generate");

/**
 * Wave 48b design rules and spec v2's schema (docs/plan/REPORT_THEME.md § Design rules, D431, D432):
 * the schema refuses colours, sizes, CSS, and formatter strings; each of rules 1–10 refuses with a
 * reason the model can act on; rules 3 and 5, sorting, and compaction are fixed by Nook and recorded.
 */

type Rows = { columns: Array<{ name: string; type: string }>; rows: unknown[][] };
const q = (key: string) => ({ key, sql: "SELECT 1", purpose: "p" });
const spec = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, specVersion: 2, queries: [...new Set(blocks.flatMap((block) => (block as { queryKey?: string }).queryKey ? [(block as { queryKey: string }).queryKey] : []))].map(q), blocks, ...extra });
const chart = (overrides: Record<string, unknown> = {}) => ({ id: "c", type: "chart", title: "Chart", intent: "compare", queryKey: "q", kind: "bar", x: "country", y: ["orders"], format: "number", ...overrides });

const days = (n: number, columns = ["web"]): Rows => ({
  columns: [{ name: "day", type: "Date" }, ...columns.map((name) => ({ name, type: "Float64" }))],
  rows: Array.from({ length: n }, (_, index) => [`2026-10-${String(index + 1).padStart(2, "0")}`, ...columns.map((_, at) => 100 + index + at)])
});
const countries = (n: number, value = (index: number) => index + 1): Rows => ({
  columns: [{ name: "country", type: "LowCardinality(String)" }, { name: "orders", type: "UInt64" }],
  rows: Array.from({ length: n }, (_, index) => [`C${index}`, String(value(index))])
});

function design(raw: unknown, results: Record<string, Rows>) {
  const shape = checkSpecShape(raw);
  if (!shape.ok) throw new Error(shape.errors.join("\n"));
  const map = new Map(Object.entries(results));
  const columns = checkColumns(shape.spec, map);
  if (columns.length) throw new Error(columns.join("\n"));
  return checkDesign(shape.spec, map);
}
const errorsOf = (raw: unknown, results: Record<string, Rows>) => design(raw, results).errors;
const fixesOf = (raw: unknown, results: Record<string, Rows>, id = "c") => (design(raw, results).spec.blocks.find((block: ReportBlock) => block.id === id)?.autoFixes ?? []).map((fix) => fix.rule);

describe("spec v2's schema refuses look-and-feel fields", () => {
  test("colours, pixel sizes, CSS, and formatter strings are not spec fields", () => {
    for (const extra of [{ color: "#ff0000" }, { colors: ["#ff0000"] }, { height: 400 }, { style: "font-size: 30px" }, { css: "x" }, { formatter: "{b}: {c}" }, { option: { series: [] } }, { width: "640px" }]) {
      const result = checkSpecShape(spec([chart(extra)]));
      expect({ extra, ok: result.ok }).toEqual({ extra, ok: false });
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/not part of the spec|Invalid option|expected one of/i);
    }
    const unknown = checkSpecShape(spec([chart({ color: "#ff0000" })]));
    expect(unknown.ok ? "" : unknown.errors[0]).toContain("colours, sizes, CSS, and number formatting are Nook's");
    // A spec-level theme or palette is refused too.
    expect(checkSpecShape(spec([chart()], { theme: { color: ["#000"] } })).ok).toBe(false);
    expect(checkSpecShape(spec([chart()], { sections: [{ id: "s", title: "S", background: "#000" }] })).ok).toBe(false);
  });

  test("formats are an enum (no format strings); units are short words", () => {
    for (const format of ["number", "percent", "duration", "currency:USD", "currency:EUR"]) expect(checkSpecShape(spec([chart({ format })])).ok).toBe(true);
    for (const format of ["0,0.00", "{value} $", "currency:usd", "currency:DOLLAR", "%.2f", "$#,##0"]) expect({ format, ok: checkSpecShape(spec([chart({ format })])).ok }).toEqual({ format, ok: false });
    for (const unit of ["orders", "ms", "%", "users/day"]) expect(checkSpecShape(spec([chart({ unit })])).ok).toBe(true);
    for (const unit of ["12px", "<b>x</b>", "font-size:12px", "x".repeat(30), "color: red;"]) expect({ unit, ok: checkSpecShape(spec([chart({ unit })])).ok }).toEqual({ unit, ok: false });
  });

  test("submit_report's JSON Schema offers intents and layout slots and closes every object", () => {
    const json = JSON.stringify(SPEC_JSON_SCHEMA);
    expect(json).toContain("\"intent\"");
    expect(json).toContain("\"trend\"");
    expect(json).toContain("\"third\"");
    expect(json).toContain("\"sections\"");
    expect(json).toContain("currency:");
    expect(json).not.toMatch(/"color"|"formatter"|"style"/);
    const blocks = ((SPEC_JSON_SCHEMA.properties as Record<string, { items: { anyOf: Array<{ additionalProperties: boolean }> } }>).blocks).items.anyOf;
    expect(blocks.every((block) => block.additionalProperties === false)).toBe(true);
    expect(SPEC_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  test("references: sections, comparison and sparkline queries must exist; Nook's own fields are recomputed", () => {
    const bad = checkSpecShape(spec([chart({ section: "nope" }), { id: "k", type: "kpi", title: "K", queryKey: "q", column: "orders", format: "number", sparkline: { queryKey: "missing", x: "a", y: "b" } }]));
    expect(bad.ok ? [] : bad.errors).toEqual(["block c: section nope is not one of the spec's sections", "block k: queryKey missing is not one of the spec's queries"]);
    const fixed = checkSpecShape(spec([chart({ autoFixes: [{ rule: "sort", detail: "made up" }] })]));
    expect(fixed.ok && fixed.spec.blocks[0]!.autoFixes).toBeUndefined();
    // Defaults: the width a block leaves out.
    expect(fixed.ok && fixed.spec.blocks[0]!.width).toBe("half");
  });

  test("the generation prompt teaches intents, layout, units, and number formats", () => {
    const prompt = systemPrompt({ database: "analytics", timeout_s: 20, max_rows: 10_000, allowlist_json: "[\"analytics\"]", id: "x" } as never, { title: "Doc", markdown: "# Metrics" }).text;
    for (const word of ["intent", "trend", "rank", "share", "width: full, half, or third", "section", "currency:<ISO 4217 code>", "unit", "emphasis", "upIsGood", "hero", "sparkline", "Never send colours, pixel sizes, CSS"]) expect({ word, found: prompt.includes(word) }).toEqual({ word, found: true });
  });
});

describe("design rules", () => {
  test("rule 1: a trend needs a time x", () => {
    expect(errorsOf(spec([chart({ intent: "trend", kind: "line" })]), { q: countries(5) }).join()).toContain("rule 1: intent trend needs x to be a Date or DateTime column");
    expect(errorsOf(spec([chart({ intent: "trend", kind: "line", x: "day", y: ["web"] })]), { q: days(5) })).toEqual([]);
  });

  test("rule 2: a share is a stacked bar or a pie of at most 5 slices", () => {
    expect(errorsOf(spec([chart({ intent: "share", kind: "line" })]), { q: countries(4) }).join()).toContain("rule 2: intent share is drawn as a stacked_bar");
    expect(errorsOf(spec([chart({ intent: "share", kind: "pie" })]), { q: countries(8) }).join()).toContain("a pie may have at most 5 slices");
    expect(errorsOf(spec([chart({ intent: "compare", kind: "pie" })]), { q: countries(3) }).join()).toContain("a pie shows a share of a whole");
    expect(errorsOf(spec([chart({ intent: "share", kind: "pie" })]), { q: countries(4) })).toEqual([]);
  });

  test("rule 3 (auto): more than 8 series fold to the top 7 + Other on bars and areas; a line becomes small multiples (round 2)", () => {
    const rows = ["2026-10-01", "2026-10-02"].flatMap((day) => Array.from({ length: 10 }, (_, index) => [day, `S${index}`, 10 - index]));
    const results = { q: { columns: [{ name: "day", type: "Date" }, { name: "who", type: "String" }, { name: "web", type: "Float64" }], rows } };
    const area = spec([chart({ intent: "trend", kind: "area", x: "day", y: ["web"], series: "who" })]);
    expect(errorsOf(area, results)).toEqual([]);
    expect(design(area, results).spec.blocks[0]!.autoFixes!).toEqual([{ rule: "fold_series", detail: "3 of 10 series folded into \"Other\" (top 7 kept)" }]);
    const line = spec([chart({ intent: "trend", kind: "line", x: "day", y: ["web"], series: "who" })]);
    expect(errorsOf(line, results)).toEqual([]);
    expect(design(line, results).spec.blocks[0]!.autoFixes!).toEqual([{ rule: "facet", detail: "10 series drawn as small multiples (one panel each, shared y scale)" }]);
  });

  test("rule 4 (auto, round 2): a scatter over 3 series of a series column becomes small multiples", () => {
    const rows = Array.from({ length: 12 }, (_, index) => [index, index * 2, `S${index % 4}`]);
    const results = { q: { columns: [{ name: "a", type: "Float64" }, { name: "b", type: "Float64" }, { name: "who", type: "String" }], rows } };
    const raw = spec([chart({ intent: "relationship", kind: "scatter", x: "a", y: ["b"], series: "who" })]);
    expect(errorsOf(raw, results)).toEqual([]);
    expect(fixesOf(raw, results)).toEqual(["facet"]);
  });

  test("rule 5 (auto): more than 20 bar categories fold to the top 15 + Other; bars are sorted", () => {
    expect(fixesOf(spec([chart()]), { q: countries(24) })).toEqual(["sort", "fold_categories"]);
    expect(design(spec([chart()]), { q: countries(24) }).spec.blocks[0]!.autoFixes![1]!.detail).toBe("9 of 24 categories folded into \"Other\" (top 15 kept)");
    // Already descending: nothing to sort. Time x: never sorted or folded.
    expect(fixesOf(spec([chart()]), { q: countries(5, (index) => 50 - index) })).toEqual([]);
    expect(fixesOf(spec([chart({ x: "day", y: ["web"], intent: "trend" })]), { q: days(25) })).toEqual([]);
  });

  test("rule 6: a single value is a KPI", () => {
    expect(errorsOf(spec([chart()]), { q: countries(1) }).join()).toContain("rule 6: the result is a single value; make it a kpi block");
  });

  test("rule 7: measures of very different scale go in separate charts", () => {
    const results = { q: { columns: [{ name: "day", type: "Date" }, { name: "revenue", type: "Float64" }, { name: "orders", type: "UInt64" }], rows: [["2026-10-01", 250_000, 120], ["2026-10-02", 260_000, 130]] } };
    expect(errorsOf(spec([chart({ intent: "trend", kind: "line", x: "day", y: ["revenue", "orders"] })]), results).join()).toContain("rule 7: revenue and orders differ in scale");
    const close = { q: { ...results.q, rows: [["2026-10-01", 250, 120]] } };
    expect(errorsOf(spec([chart({ intent: "trend", kind: "line", x: "day", y: ["revenue", "orders"] })]), { q: { ...close.q, rows: [...close.q.rows, ["2026-10-02", 260, 130]] } })).toEqual([]);
    expect(DESIGN_LIMITS.scaleRatio).toBe(20);
  });

  test("rule 8: a title, and a format or unit on every numeric measure", () => {
    const errors = errorsOf(spec([chart({ title: undefined, format: undefined })]), { q: countries(3) }).join("\n");
    expect(errors).toContain("rule 8: give the block a title");
    expect(errors).toContain("rule 8: the measure orders needs a format");
    expect(errorsOf(spec([chart({ format: undefined, unit: "orders" })]), { q: countries(3) })).toEqual([]);
    expect(errorsOf(spec([{ id: "k", type: "kpi", title: "Orders", queryKey: "q", column: "orders" }]), { q: countries(1) }).join()).toContain("rule 8: the measure orders needs a format");
  });

  test("rule 9: one hero, at most 6 KPIs in the strip", () => {
    const kpi = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "kpi", title: id, queryKey: "q", column: "orders", format: "number", ...extra });
    expect(errorsOf(spec([kpi("a", { hero: true }), kpi("b", { hero: true })]), { q: countries(1) }).join()).toContain("rule 9: at most 1 hero figure");
    const seven = Array.from({ length: 7 }, (_, index) => kpi(`k${index}`));
    expect(errorsOf(spec(seven), { q: countries(1) }).join()).toContain("rule 9: at most 6 KPIs in the strip");
    // KPIs inside a section are not in the strip.
    expect(errorsOf(spec([...seven.slice(0, 6), kpi("k6", { section: "s" })], { sections: [{ id: "s", title: "More" }] }), { q: countries(1) })).toEqual([]);
    // More than 20 blocks is refused by the shape.
    expect(checkSpecShape(spec(Array.from({ length: 21 }, (_, index) => chart({ id: `c${index}` })))).ok).toBe(false);
  });

  test("rule 10: no pie with negative values, no chart over an empty result", () => {
    expect(errorsOf(spec([chart({ intent: "share", kind: "pie" })]), { q: countries(3, (index) => index - 1) }).join()).toContain("rule 10: a pie cannot show negative values");
    expect(errorsOf(spec([chart()]), { q: countries(0) }).join()).toContain("rule 10: the query returned no rows");
  });

  test("compaction (auto) is recorded; emphasis must name a series or category", () => {
    expect(fixesOf(spec([chart()]), { q: countries(3, (index) => 20_000 * (3 - index)) })).toEqual(["compact"]);
    expect(fixesOf(spec([{ id: "k", type: "kpi", title: "K", queryKey: "q", column: "orders", format: "number" }]), { q: countries(1, () => 125_000) }, "k")).toEqual(["compact"]);
    expect(errorsOf(spec([chart({ emphasis: "C1" })]), { q: countries(3) })).toEqual([]);
    expect(errorsOf(spec([chart({ emphasis: "Mars" })]), { q: countries(3) }).join()).toContain("emphasis Mars is not a series or category");
  });

  test("the check is pure: the input spec is not changed", () => {
    const shape = checkSpecShape(spec([chart()]));
    if (!shape.ok) throw new Error("shape");
    const before = JSON.stringify(shape.spec);
    const out = checkDesign(shape.spec as ReportSpec, new Map([["q", countries(24)]]));
    expect(JSON.stringify(shape.spec)).toBe(before);
    expect(out.spec.blocks[0]!.autoFixes?.length).toBe(2);
  });

  test("rule 2 counts the slices with a positive value", () => {
    const rows = countries(9, (index) => index < 7 ? index + 1 : 0);
    expect(errorsOf(spec([chart({ intent: "share", kind: "pie" })]), { q: rows }).join()).toContain("(this has 7 with a positive value)");
  });
});

describe("review H1: an edit of an old report is checked on the blocks it changes", () => {
  // A v1 spec as wave 45–47 stored it: an untitled KPI with no format, a chart over an empty result, and
  // a line over a String x (upgraded to intent trend), none of which pass the design rules.
  const v1 = {
    version: 1,
    queries: [q("kpis"), q("empty"), q("months"), q("bars")],
    blocks: [
      { id: "k", type: "kpi", queryKey: "kpis", column: "orders" },
      { id: "e", type: "chart", title: "Nothing yet", queryKey: "empty", kind: "bar", x: "country", y: ["orders"], format: "integer" },
      { id: "m", type: "chart", title: "By month", queryKey: "months", kind: "line", x: "label", y: ["orders"], format: "integer" },
      { id: "b", type: "chart", title: "Unsorted on purpose", queryKey: "bars", kind: "bar", x: "country", y: ["orders"], format: "integer" }
    ]
  };
  const results = {
    kpis: countries(1),
    empty: countries(0),
    months: { columns: [{ name: "label", type: "String" }, { name: "orders", type: "UInt64" }], rows: [["first", "3"], ["second", "4"]] },
    bars: countries(4),
    fresh: countries(3)
  };
  const upgradedWith = (extra: unknown[]) => {
    const upgraded = upgradeSpec(v1);
    return { ...upgraded, queries: [...upgraded.queries, q("fresh")], blocks: [...upgraded.blocks, ...extra] };
  };

  test("upgraded blocks are marked legacy; an edit that adds a block passes, and the old blocks keep their marker", () => {
    expect(upgradeSpec(v1).blocks.every((block) => block.legacy === true)).toBe(true);
    const raw = upgradedWith([chart({ id: "new", queryKey: "fresh" })]);
    const edit = design(raw, results);
    expect(edit.errors.length).toBeGreaterThan(0);
    const shape = checkSpecShape(raw);
    if (!shape.ok) throw new Error(shape.errors.join());
    const checked = checkDesign(shape.spec, new Map(Object.entries(results)), { changedBlockIds: ["new"] });
    expect(checked.errors).toEqual([]);
    expect(checked.spec.blocks.filter((block) => block.legacy).map((block) => block.id)).toEqual(["k", "e", "m", "b"]);
    // Auto-fixes still cover every block: the new one is sorted; a legacy bar keeps its rows' order.
    expect(checked.spec.blocks.find((block) => block.id === "new")!.autoFixes?.map((fix) => fix.rule)).toEqual(["sort"]);
    expect(checked.spec.blocks.find((block) => block.id === "b")!.autoFixes).toBeUndefined();
  });

  test("a changed old block is checked and loses its marker; rule 9 counts every block", () => {
    const raw = upgradedWith([chart({ id: "new", queryKey: "fresh" })]);
    const shape = checkSpecShape(raw);
    if (!shape.ok) throw new Error("shape");
    const map = new Map(Object.entries(results));
    const changed = checkDesign(shape.spec, map, { changedBlockIds: ["m"] });
    expect(changed.errors.join()).toContain("block m: rule 1: intent trend needs x to be a Date");
    expect(changed.spec.blocks.find((block) => block.id === "m")!.legacy).toBeUndefined();
    const heroes = checkSpecShape({ ...raw, blocks: [...raw.blocks, { id: "h1", type: "kpi", title: "A", queryKey: "fresh", column: "orders", format: "number", hero: true }, { id: "h2", type: "kpi", title: "B", queryKey: "fresh", column: "orders", format: "number", hero: true }] });
    if (!heroes.ok) throw new Error("shape");
    expect(checkDesign(heroes.spec, map, { changedBlockIds: ["new"] }).errors.join()).toContain("rule 9: at most 1 hero");
  });

  test("a full generation (no changedBlockIds) checks every block, and a model cannot claim legacy", () => {
    const raw = { ...spec([chart({ legacy: true, title: undefined })]) };
    const shape = checkSpecShape(raw);
    if (!shape.ok) throw new Error("shape");
    const out = checkDesign(shape.spec, new Map([["q", countries(3)]]));
    expect(out.errors.join()).toContain("rule 8: give the block a title");
    expect(out.spec.blocks[0]!.legacy).toBeUndefined();
  });
});

describe("review M3: period labels are ordinal", () => {
  test("YYYY-MM, YYYY-MM-DD, YYYY-Www, quarters, and month names keep their order; other strings sort", () => {
    const strings = (values: string[]) => ({ columns: [{ name: "x", type: "String" }, { name: "orders", type: "UInt64" }], rows: values.map((value, index) => [value, String(index % 2 ? 50 : 5)]) });
    for (const values of [["2026-01", "2026-02", "2026-03"], ["2026-10-01", "2026-10-02"], ["2026-W40", "2026-W41"], ["Q1", "Q2", "Q3"], ["2026-Q1", "2026-Q2"], ["Jan", "Feb", "Mar"], ["September 2026", "October 2026"]]) {
      const data = strings(values);
      expect({ values, ordinal: ordinalX({ x: "x" }, data.columns, data.rows) }).toEqual({ values, ordinal: true });
      expect((buildChartOption({ ...chart({ x: "x" }), id: "c" } as never, data, chartTheme("dark")).option!.xAxis as { data: string[] }).data).toEqual(values);
    }
    const names = strings(["DE", "US", "IN"]);
    expect(ordinalX({ x: "x" }, names.columns, names.rows)).toBe(false);
    expect(ordinalX({ x: "x", legacy: true }, names.columns, names.rows)).toBe(true);
    expect(fixesOf(spec([chart({ x: "x" })]), { q: strings(["2026-01", "2026-02", "2026-03"]) as Rows })).toEqual([]);
  });
});

describe("KPI compareLabel", () => {
  test("plain text, capped, in the JSON Schema; markup refused; the tile never shows a column name", () => {
    const kpi = (compareLabel: unknown) => spec([{ id: "k", type: "kpi", title: "K", queryKey: "q", column: "orders", format: "number", compareTo: { column: "orders" }, compareLabel }]);
    expect(checkSpecShape(kpi("vs prior 2 weeks")).ok).toBe(true);
    for (const bad of ["<b>vs</b>", "x".repeat(61), "vs\nlast", "{{x}}"]) expect({ bad, ok: checkSpecShape(kpi(bad)).ok }).toEqual({ bad, ok: false });
    expect(JSON.stringify(SPEC_JSON_SCHEMA)).toContain("\"compareLabel\"");
    const result = { columns: [{ name: "v", type: "Float64" }, { name: "revenue_prev", type: "Float64" }], rows: [[110, 100]] };
    const block = { id: "k", type: "kpi", queryKey: "q", column: "v", format: "number", compareTo: { column: "revenue_prev" } } as const;
    expect(kpiValue(block, result).change!.against).toBe("vs previous period");
    expect(kpiValue({ ...block, compareLabel: "vs prior 2 weeks" }, result).change!.against).toBe("vs prior 2 weeks");
    // A v1 KPI (compareColumn) does not show its column name either.
    expect(kpiValue({ id: "k", type: "kpi", queryKey: "q", column: "v", compareColumn: "revenue_prev" }, result).change!.against).toBe("vs previous period");
  });
});
