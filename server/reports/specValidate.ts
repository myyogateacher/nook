import { z } from "zod";
import { db, now } from "../db";
import {
  BLOCK_ID, BLOCK_INTENTS, COMPARE_LABEL_MAX, BLOCK_WIDTHS, blockKeys, CHART_KINDS, defaultIntent, defaultWidth, isNumericType, isTimeType, ordinalX, QUERY_KEY, REPORT_LIMITS, reportLayout, SECTION_LIMITS,
  SPEC_FORMAT, UNIT, VALUE_FORMATS, type AutoFix, type ChartBlock, type QueryOutcome, type ReportBlock, type ReportSpec, type ResultColumn
} from "../../shared/reports";
import { MAX_SCATTER_SERIES, MAX_SERIES } from "../../shared/reportTheme";
import { queryIdFor } from "./clickhouse";
import type { DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import { runGuarded } from "./runner";
import { parseSpec } from "./service";
import { backfillVersion } from "./versionBackfill";
import { nextVersion } from "./versionNumbers";

/**
 * Checking a spec the generation agent (or wave 48's edit agent) submits, before anything is saved
 * (plan wave 46, D427; wave 48b design rules, D432):
 *
 * 1. The shape (zod over shared/reports.ts's v2 vocabulary and limits): at most 12 queries, 20 blocks,
 *    10 sections; keys and ids in their patterns and unique. Objects are strict: a spec cannot carry
 *    colours, pixel sizes, CSS, or formatter strings (any field the vocabulary does not name is
 *    refused); formats are an enum, units a short word.
 * 2. Every `queryKey` (and a KPI's comparison and sparkline query) names one of the spec's queries,
 *    and every `section` one of its sections.
 * 3. Every query passes the guard as a SELECT and runs on the report's data source (D411, D412).
 * 4. Every column a block names is in its query's result, and measures are numeric.
 * 5. The design rules (docs/plan/REPORT_THEME.md § Design rules, `checkDesign`): violations come back
 *    like SQL errors; rules 3 and 5 (fold to top 7 / top 15 + "Other"), sorting, and compaction are
 *    applied by Nook instead and recorded on the block (`autoFixes`, the Mapping tab).
 *
 * Errors come back as short lines the model can act on (generate.ts gives it two more tries). An
 * accepted spec is saved with its queries and their first results in one transaction, every block
 * stamped with its provenance (the run, the spec version, the doc snapshot), and the report becomes
 * `ready`.
 */

const column = z.string().min(1).max(200);
const NOT_A_FORMAT = "must be one of number, percent, duration, or currency:<ISO 4217 code> such as currency:USD";
/** v2 formats, and v1's words so a stored spec read back still validates. */
const format = z.string().refine((value) => SPEC_FORMAT.test(value) || (VALUE_FORMATS as readonly string[]).includes(value), NOT_A_FORMAT);
const unit = z.string().trim().regex(UNIT, "must be a short unit word such as orders, users, ms, or % (no CSS or sizes)");
const queryKey = z.string().regex(QUERY_KEY, "must match [a-z][a-z0-9_]{0,39}");
const sectionId = z.string().regex(BLOCK_ID, "must match [a-z0-9][a-z0-9_-]{0,39}");
const columnRef = z.object({ queryKey: queryKey.optional(), column }).strict();
const provenance = z.object({ runId: z.string().max(64).nullable(), instructionId: z.string().max(64).nullish(), version: z.number().int().min(0).max(1_000_000), docSnapshotId: z.string().max(64).nullish() }).strict();
const base = {
  id: z.string().regex(BLOCK_ID, "must match [a-z0-9][a-z0-9_-]{0,39}"),
  title: z.string().max(REPORT_LIMITS.blockTitle).optional(),
  intent: z.enum(BLOCK_INTENTS).optional(),
  width: z.enum(BLOCK_WIDTHS).optional(),
  section: sectionId.optional(),
  // Nook's own fields: provenance is re-stamped on save and auto-fixes recomputed, whatever is sent.
  provenance: provenance.optional(),
  autoFixes: z.array(z.object({ rule: z.string().max(40), detail: z.string().max(300) }).strict()).max(10).optional(),
  // The v1 upgrade's marker: kept only on blocks an edit leaves unchanged (checkDesign drops it otherwise).
  legacy: z.boolean().optional()
};
/** KPI comparison text: one plain line, no markup. */
const compareLabel = z.string().trim().min(1).max(COMPARE_LABEL_MAX).refine((value) => !/[<>{}\u0000-\u001f\u007f]/.test(value), "must be plain text on one line (no markup)");

// Strict (wave 48 review H1): a field the vocabulary does not name (html, style, a formatter, a note)
// is refused, never stripped and never saved.
const blockSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("markdown"), markdown: z.string().min(1).max(REPORT_LIMITS.markdown) }).strict(),
  z.object({
    ...base, type: z.literal("kpi"), queryKey, column, format: format.optional(), unit: unit.optional(), label: z.string().max(REPORT_LIMITS.blockTitle).optional(),
    compareColumn: column.optional(), compareTo: columnRef.optional(), compareLabel: compareLabel.optional(), upIsGood: z.boolean().optional(), hero: z.boolean().optional(),
    sparkline: z.object({ queryKey, x: column, y: column }).strict().optional()
  }).strict(),
  z.object({
    ...base, type: z.literal("chart"), queryKey, kind: z.enum(CHART_KINDS), x: column, y: z.array(column).min(1).max(REPORT_LIMITS.chartSeries), series: column.optional(),
    format: format.optional(), unit: unit.optional(), emphasis: z.string().min(1).max(200).optional(), upIsGood: z.boolean().optional(), compareTo: columnRef.optional()
  }).strict(),
  z.object({ ...base, type: z.literal("table"), queryKey, columns: z.array(column).max(REPORT_LIMITS.tableColumns).optional(), formats: z.record(z.string(), format).optional() }).strict()
]);
const querySchema = z.object({ key: queryKey, sql: z.string().trim().min(1).max(REPORT_LIMITS.sqlChars), purpose: z.string().max(REPORT_LIMITS.purpose).default(""), createdBy: z.enum(["agent", "user"]).optional() }).strict();
const sectionSchema = z.object({ id: sectionId, title: z.string().trim().min(1).max(SECTION_LIMITS.title), summary: z.string().max(SECTION_LIMITS.summary).optional() }).strict();
export const specSchema = z.object({
  version: z.literal(1).default(1),
  specVersion: z.literal(2).optional(),
  sections: z.array(sectionSchema).max(SECTION_LIMITS.sections).default([]),
  blocks: z.array(blockSchema).min(1).max(REPORT_LIMITS.blocks),
  queries: z.array(querySchema).max(REPORT_LIMITS.queries)
}).strict();

// ----------------------------------------------------------------------------- submit_report's schema

const columnProp = { type: "string", maxLength: 200 };
const formatProp = { type: "string", pattern: SPEC_FORMAT.source, description: "number | percent (a ratio: 0.25 shows 25%) | duration (seconds) | currency:<ISO 4217>, e.g. currency:USD" };
const unitProp = { type: "string", maxLength: 24, pattern: UNIT.source, description: "A unit word after the value: orders, users, ms" };
const refProp = { type: "object", additionalProperties: false, required: ["column"], properties: { queryKey: { type: "string", pattern: QUERY_KEY.source }, column: columnProp } };
const blockBase = {
  id: { type: "string", pattern: BLOCK_ID.source },
  title: { type: "string", maxLength: REPORT_LIMITS.blockTitle },
  intent: { enum: [...BLOCK_INTENTS] },
  width: { enum: [...BLOCK_WIDTHS], description: "full = whole row, half, third" },
  section: { type: "string", pattern: BLOCK_ID.source, description: "The id of one of the spec's sections" }
};

/** One v2 block as JSON Schema (submit_report's blocks, submit_patch's add_block). */
export const BLOCK_JSON_SCHEMA: Record<string, unknown> = {
  anyOf: [
    { type: "object", additionalProperties: false, required: ["id", "type", "markdown"], properties: { ...blockBase, type: { const: "markdown" }, markdown: { type: "string", maxLength: REPORT_LIMITS.markdown } } },
    {
      type: "object", additionalProperties: false, required: ["id", "type", "title", "intent", "queryKey", "column"],
      properties: {
        ...blockBase, type: { const: "kpi" }, queryKey: { type: "string" }, column: columnProp, format: formatProp, unit: unitProp, label: { type: "string", maxLength: REPORT_LIMITS.blockTitle },
        compareTo: refProp, compareLabel: { type: "string", maxLength: COMPARE_LABEL_MAX, description: "What the delta compares against, plain text: vs prior 2 weeks, vs last year" }, upIsGood: { type: "boolean" }, hero: { type: "boolean", description: "At most one KPI per report" },
        sparkline: { type: "object", additionalProperties: false, required: ["queryKey", "x", "y"], properties: { queryKey: { type: "string" }, x: columnProp, y: columnProp } }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["id", "type", "title", "intent", "queryKey", "kind", "x", "y"],
      properties: {
        ...blockBase, type: { const: "chart" }, queryKey: { type: "string" }, kind: { enum: [...CHART_KINDS] }, x: columnProp,
        y: { type: "array", minItems: 1, maxItems: REPORT_LIMITS.chartSeries, items: columnProp }, series: columnProp, format: formatProp, unit: unitProp,
        emphasis: { type: "string", maxLength: 200, description: "A series name or (one series) a category value to highlight" }, upIsGood: { type: "boolean" }, compareTo: refProp
      }
    },
    { type: "object", additionalProperties: false, required: ["id", "type", "title", "queryKey"], properties: { ...blockBase, type: { const: "table" }, queryKey: { type: "string" }, columns: { type: "array", maxItems: REPORT_LIMITS.tableColumns, items: columnProp }, formats: { type: "object", additionalProperties: formatProp } } }
  ]
};

/** One section as JSON Schema. */
export const SECTION_JSON_SCHEMA: Record<string, unknown> = { type: "object", additionalProperties: false, required: ["id", "title"], properties: { id: { type: "string", pattern: BLOCK_ID.source }, title: { type: "string", maxLength: SECTION_LIMITS.title }, summary: { type: "string", maxLength: SECTION_LIMITS.summary } } };

/** submit_report's parameters: spec v2 of shared/reports.ts as JSON Schema (the model fills it; no colours, sizes, CSS, or formatters). */
export const SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["blocks", "queries"],
  properties: {
    version: { type: "integer", enum: [1] },
    specVersion: { type: "integer", enum: [2] },
    sections: { type: "array", maxItems: SECTION_LIMITS.sections, items: SECTION_JSON_SCHEMA },
    queries: {
      type: "array", maxItems: REPORT_LIMITS.queries,
      items: { type: "object", additionalProperties: false, required: ["key", "sql", "purpose"], properties: { key: { type: "string", pattern: QUERY_KEY.source }, sql: { type: "string", maxLength: REPORT_LIMITS.sqlChars }, purpose: { type: "string", maxLength: REPORT_LIMITS.purpose } } }
    },
    blocks: { type: "array", minItems: 1, maxItems: REPORT_LIMITS.blocks, items: BLOCK_JSON_SCHEMA }
  }
};

/** Whether a ClickHouse type is a number (re-exported from shared/reports.ts). */
export { isNumericType };

export type SpecCheck =
  | { ok: true; spec: ReportSpec; results: Map<string, QueryOutcome> }
  | { ok: false; errors: string[] };

const MAX_ERRORS = 20;

/** Any failure of a query as a ReportError (an unexpected one becomes a generic CLICKHOUSE error, never its text). */
export function reportErrorOf(error: unknown): ReportError {
  try {
    return asReportError(error);
  } catch {
    return new ReportError(502, "CLICKHOUSE", "The query could not be run");
  }
}

/** A zod issue as a line the model can act on: an unknown field says that Nook owns the look. */
function issueText(issue: z.core.$ZodIssue): string {
  const where = issue.path.join(".") || "spec";
  if (issue.code === "unrecognized_keys") {
    const keys = (issue as { keys?: string[] }).keys ?? [];
    return `${where}: ${keys.map((key) => `"${key.slice(0, 40)}"`).join(", ")} ${keys.length === 1 ? "is" : "are"} not part of the spec; colours, sizes, CSS, and number formatting are Nook's, so choose an intent, a width, a format, and a unit instead`;
  }
  return `${where}: ${issue.message}`;
}

/** Steps 1 and 2: the shape and the references, no ClickHouse. The spec comes back as v2 with defaults filled in. */
export function checkSpecShape(raw: unknown): { ok: true; spec: ReportSpec } | { ok: false; errors: string[] } {
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, MAX_ERRORS).map(issueText) };
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const query of parsed.data.queries) {
    if (keys.has(query.key)) errors.push(`queries: the key ${query.key} is used twice`);
    keys.add(query.key);
  }
  const sections = new Set<string>();
  for (const section of parsed.data.sections) {
    if (sections.has(section.id)) errors.push(`sections: the id ${section.id} is used twice`);
    sections.add(section.id);
  }
  const ids = new Set<string>();
  for (const raw of parsed.data.blocks) {
    const block = raw as ReportBlock;
    if (ids.has(block.id)) errors.push(`blocks: the id ${block.id} is used twice`);
    ids.add(block.id);
    for (const key of blockKeys(block)) if (!keys.has(key)) errors.push(`block ${block.id}: queryKey ${key} is not one of the spec's queries`);
    if (block.section !== undefined && !sections.has(block.section)) errors.push(`block ${block.id}: section ${block.section} is not one of the spec's sections`);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  const spec: ReportSpec = {
    version: 1,
    specVersion: 2,
    sections: parsed.data.sections.map((section) => ({ id: section.id, title: section.title, ...(section.summary ? { summary: section.summary } : {}) })),
    queries: parsed.data.queries.map((query) => ({ key: query.key, sql: query.sql, purpose: query.purpose, createdBy: query.createdBy ?? "agent" })),
    blocks: parsed.data.blocks.map((raw) => {
      const { autoFixes: _ignored, ...block } = raw as ReportBlock;
      const intent = block.intent ?? defaultIntent(block as ReportBlock);
      const filled = { ...block, ...(intent ? { intent } : {}), width: block.width ?? defaultWidth(block as ReportBlock) } as ReportBlock;
      if (filled.type === "kpi" && filled.compareColumn && !filled.compareTo) {
        const { compareColumn, ...rest } = filled;
        return { ...rest, compareTo: { column: compareColumn } };
      }
      return filled;
    })
  };
  return { ok: true, spec };
}

type Rows = Pick<QueryOutcome, "columns" | "rows">;

/** Step 4: the columns each block names, against its query's result. */
export function checkColumns(spec: Pick<ReportSpec, "blocks">, results: ReadonlyMap<string, Rows>): string[] {
  const errors: string[] = [];
  for (const block of spec.blocks) {
    if (block.type === "markdown") continue;
    const result = results.get(block.queryKey);
    if (!result) continue;
    const types = new Map(result.columns.map((item) => [item.name, item.type]));
    const known = (rows: Rows) => rows.columns.slice(0, 30).map((item) => item.name).join(", ");
    const need = (name: string, what: string, source: Rows = result, key = block.queryKey) => {
      if (!source.columns.some((item) => item.name === name)) errors.push(`block ${block.id}: ${what} ${name} is not a column of ${key} (columns: ${known(source)})`);
    };
    const numeric = (name: string, what: string, source: Rows = result) => {
      const type = source.columns.find((item) => item.name === name)?.type;
      if (type !== undefined && !isNumericType(type)) errors.push(`block ${block.id}: ${what} ${name} is ${type}, not a number; cast it in the SQL (toFloat64, toInt64) or choose another column`);
    };
    if (block.type === "kpi") {
      need(block.column, "column");
      const compare = block.compareTo ?? (block.compareColumn ? { column: block.compareColumn } : null);
      if (compare) {
        const source = compare.queryKey ? results.get(compare.queryKey) : result;
        if (source) { need(compare.column, "compareTo column", source, compare.queryKey ?? block.queryKey); numeric(compare.column, "compareTo column", source); }
      }
      if (block.sparkline) {
        const source = results.get(block.sparkline.queryKey);
        if (source) { need(block.sparkline.x, "sparkline x", source, block.sparkline.queryKey); need(block.sparkline.y, "sparkline y", source, block.sparkline.queryKey); numeric(block.sparkline.y, "sparkline y", source); }
      }
    } else if (block.type === "chart") {
      need(block.x, "x");
      if (block.series) need(block.series, "series");
      if (block.compareTo) {
        if (block.compareTo.queryKey && block.compareTo.queryKey !== block.queryKey) errors.push(`block ${block.id}: a chart's compareTo must be a column of its own query ${block.queryKey}`);
        else { need(block.compareTo.column, "compareTo column"); numeric(block.compareTo.column, "compareTo column"); }
      }
      for (const name of block.y) {
        need(name, "y");
        if (types.has(name)) numeric(name, "y column");
      }
    } else {
      for (const name of block.columns ?? []) need(name, "column");
      for (const name of Object.keys(block.formats ?? {})) need(name, "formats column");
    }
  }
  return errors.slice(0, MAX_ERRORS);
}

// ------------------------------------------------------------------------------- the design rules

/** The limits the design rules use (docs/plan/REPORT_THEME.md § Design rules, D432). */
export const DESIGN_LIMITS = {
  /** Rule 2: a pie only up to this many slices. */
  pieSlices: 5,
  /** Rule 3 (auto): series beyond this fold into "Other" (top 7 kept). */
  series: MAX_SERIES,
  /** Rule 4: scatter series. */
  scatterSeries: MAX_SCATTER_SERIES,
  /** Rule 5 (auto): bar categories beyond this fold to the top 15 + "Other". */
  barCategories: 20,
  keptBarCategories: 15,
  /** Rule 7: two measures whose largest values differ by this factor or more cannot share an axis. */
  scaleRatio: 20,
  /** Rule 9. */
  heroes: 1,
  stripKpis: 6,
  blocks: REPORT_LIMITS.blocks,
  /** Compaction (auto): values this large show as 12.9K / $4.2M. */
  compactFrom: 10_000
} as const;

const BAR_KINDS = new Set(["bar", "stacked_bar", "horizontal_bar"]);
const typeOf = (columns: readonly ResultColumn[], name: string) => columns.find((item) => item.name === name)?.type ?? "";
const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) return Number(value);
  return null;
};
const label = (value: unknown) => value === null || value === undefined ? "NULL" : typeof value === "string" ? value : JSON.stringify(value);

/** The series a chart would draw: its y columns, or the distinct values of its series column. */
function seriesNames(block: ChartBlock, result: Rows): string[] {
  const si = result.columns.findIndex((item) => item.name === block.series);
  if (!block.series || si < 0) return block.y;
  return [...new Set(result.rows.map((row) => label(row[si])))];
}

/** Category totals in the result's order (the bar sort and fold), summing every y and series. */
function categoryTotals(block: ChartBlock, result: Rows): Array<{ name: string; total: number }> {
  const xi = result.columns.findIndex((item) => item.name === block.x);
  const yis = block.y.map((name) => result.columns.findIndex((item) => item.name === name)).filter((index) => index >= 0);
  const totals = new Map<string, number>();
  for (const row of result.rows) {
    const name = label(row[xi]);
    totals.set(name, (totals.get(name) ?? 0) + yis.reduce((sum, yi) => sum + (numberOf(row[yi]) ?? 0), 0));
  }
  return [...totals.entries()].map(([name, total]) => ({ name, total }));
}

/** Options of the design check: an edit names the blocks it adds or changes (wave 48's edit agent). */
export type DesignOptions = { changedBlockIds?: Iterable<string> | null };

/**
 * Step 5: the design rules over the spec and its results (pure). Violations are errors for the model;
 * the auto-fixes (fold series to the top 7 + Other, fold bar categories to the top 15 + Other, sort bars
 * descending, compact large numbers) are recorded on each block's `autoFixes` in the returned spec.
 *
 * Review H1: with `changedBlockIds` (an edit), the per-block rules (1, 2, 4, 6, 7, 8, 10, emphasis)
 * apply only to the blocks it names, so an edit never fails on an old block it did not touch; those
 * keep their `legacy` marker. Rule 9's totals and the auto-fixes cover every block. Without it (a full
 * generation) every rule applies to every block and no block stays `legacy`.
 */
export function checkDesign(spec: ReportSpec, results: ReadonlyMap<string, Rows>, options: DesignOptions = {}): { errors: string[]; spec: ReportSpec } {
  const errors: string[] = [];
  const changed = options.changedBlockIds ? new Set(options.changedBlockIds) : null;
  const blocks = spec.blocks.map((original): ReportBlock => {
    const checked = changed === null || changed.has(original.id);
    const { legacy: _legacy, ...fresh } = original;
    const block = (checked ? fresh : original) as ReportBlock;
    if (block.type === "markdown") return block;
    const fixes: AutoFix[] = [];
    const result = results.get(block.queryKey);
    const say = (rule: number, text: string) => { if (checked) errors.push(`block ${block.id}: rule ${rule}: ${text}`); };
    // Rule 8: a title, and a unit or format on every numeric measure.
    if (!block.title?.trim()) say(8, "give the block a title");
    if (block.type === "kpi" && result && isNumericType(typeOf(result.columns, block.column)) && !block.format && !block.unit) say(8, `the measure ${block.column} needs a format (number, percent, duration, currency:<ISO>) or a unit`);
    if (block.type !== "chart") {
      if (block.type === "kpi" && result) {
        const value = result.rows[0]?.[result.columns.findIndex((item) => item.name === block.column)];
        if (typeof value === "number" || typeof value === "string") {
          const number = numberOf(value);
          if (number !== null && Math.abs(number) >= DESIGN_LIMITS.compactFrom) fixes.push({ rule: "compact", detail: "The value is compacted (12.9K, $4.2M); the full value is in its tooltip" });
        }
      }
      return fixes.length ? { ...block, autoFixes: fixes } : block;
    }
    if (block.y.some((name) => result && isNumericType(typeOf(result.columns, name))) && !block.format && !block.unit) say(8, `the measure ${block.y.join(", ")} needs a format (number, percent, duration, currency:<ISO>) or a unit`);
    if (!result) return block;
    const kind = block.kind;
    const intent = block.intent ?? defaultIntent(block);
    // Rule 10: no chart over an empty result.
    if (result.rows.length === 0) { say(10, "the query returned no rows; a chart needs data (filter less, or use a table or markdown note)"); return block; }
    const positive = categoryTotals(block, result).filter((item) => item.total > 0).length;
    // Rule 6: one value is a KPI, not a chart.
    if (result.rows.length === 1 && block.y.length === 1 && !block.series) say(6, "the result is a single value; make it a kpi block");
    // Rule 1: a trend runs over time.
    if (intent === "trend" && !isTimeType(typeOf(result.columns, block.x))) say(1, `intent trend needs x to be a Date or DateTime column, but ${block.x} is ${typeOf(result.columns, block.x) || "unknown"}; use intent compare, or select a date`);
    // Rule 2: a share is a stacked bar, or a pie of at most 5 slices that make the whole.
    if (intent === "share" && kind !== "stacked_bar" && kind !== "pie") say(2, `intent share is drawn as a stacked_bar (or a pie of at most ${DESIGN_LIMITS.pieSlices} slices); ${kind} is not`);
    if (kind === "pie" && intent !== "share") say(2, "a pie shows a share of a whole; set intent share or use a bar");
    const totals = categoryTotals(block, result);
    if (kind === "pie") {
      // Rule 10: no negative slices.
      const yi = result.columns.findIndex((item) => item.name === block.y[0]);
      if (result.rows.some((row) => (numberOf(row[yi]) ?? 0) < 0)) say(10, "a pie cannot show negative values; use a bar");
      if (positive > DESIGN_LIMITS.pieSlices) say(2, `a pie may have at most ${DESIGN_LIMITS.pieSlices} slices (this has ${positive} with a positive value); use a stacked_bar, or group the rest as Other in SQL`);
      if (block.y.length > 1 || block.series) say(2, "a pie shows one measure over one category column");
    }
    const names = seriesNames(block, result);
    // Rule 4: scatter is capped at 3 series.
    if (kind === "scatter" && names.length > DESIGN_LIMITS.scatterSeries) say(4, `a scatter may show at most ${DESIGN_LIMITS.scatterSeries} series (this has ${names.length}); facet it into separate charts or fold the rest into Other in SQL`);
    // Rule 3 (auto): more than 8 series fold into the top 7 + Other.
    if (kind !== "scatter" && kind !== "pie" && names.length > DESIGN_LIMITS.series) fixes.push({ rule: "fold_series", detail: `${names.length - (DESIGN_LIMITS.series - 1)} of ${names.length} series folded into "Other" (top ${DESIGN_LIMITS.series - 1} kept)` });
    // Rule 7: no dual axes; measures of very different scale go in separate charts.
    const measures = [...block.y, ...(block.compareTo && !block.compareTo.queryKey ? [block.compareTo.column] : [])];
    if (measures.length >= 2 && !block.series) {
      const peaks = measures.map((name) => {
        const yi = result.columns.findIndex((item) => item.name === name);
        return Math.max(0, ...result.rows.map((row) => Math.abs(numberOf(row[yi]) ?? 0)));
      }).filter((peak) => peak > 0);
      if (peaks.length >= 2 && Math.max(...peaks) / Math.min(...peaks) >= DESIGN_LIMITS.scaleRatio) say(7, `${measures.join(" and ")} differ in scale by ${Math.round(Math.max(...peaks) / Math.min(...peaks))}×; split them into two charts (there is no second axis)`);
    }
    if (BAR_KINDS.has(kind) && !ordinalX(block, result.columns, result.rows) && totals.length > 1) {
      // Sorting (auto): bars descending unless x is ordinal or time.
      if (totals.some((item, at) => at > 0 && item.total > totals[at - 1]!.total)) fixes.push({ rule: "sort", detail: "Bars sorted descending by value" });
      // Rule 5 (auto): more than 20 categories keep the top 15 + Other.
      if (totals.length > DESIGN_LIMITS.barCategories) fixes.push({ rule: "fold_categories", detail: `${totals.length - DESIGN_LIMITS.keptBarCategories} of ${totals.length} categories folded into "Other" (top ${DESIGN_LIMITS.keptBarCategories} kept)` });
    }
    // Compaction (auto).
    const peak = Math.max(0, ...block.y.map((name) => {
      const yi = result.columns.findIndex((item) => item.name === name);
      return Math.max(0, ...result.rows.map((row) => Math.abs(numberOf(row[yi]) ?? 0)));
    }));
    if (peak >= DESIGN_LIMITS.compactFrom) fixes.push({ rule: "compact", detail: "Axis and labels compacted (12.9K, $4.2M); tooltips show full values" });
    // Emphasis must name something the chart draws.
    if (checked && block.emphasis !== undefined && !names.includes(block.emphasis) && !(names.length === 1 && totals.some((item) => item.name === block.emphasis))) {
      errors.push(`block ${block.id}: emphasis ${block.emphasis.slice(0, 60)} is not a series or category of the chart (series: ${names.slice(0, 10).join(", ")})`);
    }
    return fixes.length ? { ...block, autoFixes: fixes } : block;
  });
  // Rule 9: one hero, at most 6 KPIs in the strip, at most 20 blocks.
  const heroes = spec.blocks.filter((block) => block.type === "kpi" && block.hero).length;
  if (heroes > DESIGN_LIMITS.heroes) errors.push(`spec: rule 9: at most ${DESIGN_LIMITS.heroes} hero figure per report (there are ${heroes})`);
  const strip = reportLayout(spec).strip.length;
  if (strip > DESIGN_LIMITS.stripKpis) errors.push(`spec: rule 9: at most ${DESIGN_LIMITS.stripKpis} KPIs in the strip (there are ${strip}); move the rest into a section or drop them`);
  if (spec.blocks.length > DESIGN_LIMITS.blocks) errors.push(`spec: rule 9: at most ${DESIGN_LIMITS.blocks} blocks`);
  return { errors: errors.slice(0, MAX_ERRORS), spec: { ...spec, blocks } };
}

/**
 * The whole check: shape, references, each query run through the guard (selects only), columns, and
 * the design rules. A spec that passes comes back with its auto-fixes recorded.
 */
export async function validateSpec(row: DatasourceRow, raw: unknown, context: { userId: string; runId: string; signal?: AbortSignal } & DesignOptions): Promise<SpecCheck> {
  const shape = checkSpecShape(raw);
  if (!shape.ok) return shape;
  const spec = shape.spec;
  const used = new Set(spec.blocks.flatMap(blockKeys));
  const results = new Map<string, QueryOutcome>();
  const errors: string[] = [];
  const maxRows = Math.min(row.max_rows, REPORT_LIMITS.storedRows);
  for (const query of spec.queries) {
    if (!used.has(query.key)) {
      errors.push(`query ${query.key}: no block uses it; remove it or add a block`);
      continue;
    }
    try {
      results.set(query.key, await runGuarded(row, query.sql, { classes: ["select"], maxRows, queryId: queryIdFor("gen", context.runId.replace(/-/g, "").slice(0, 12), query.key), userId: context.userId, signal: context.signal }));
    } catch (error) {
      if (context.signal?.aborted) throw error;
      const known = reportErrorOf(error);
      const guard = typeof known.details.guard === "string" ? ` ${known.details.guard}` : "";
      errors.push(`query ${query.key}: ${known.code}${guard}: ${known.message.slice(0, 300)}`);
    }
  }
  errors.push(...checkColumns(spec, results));
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  const design = checkDesign(spec, results, { changedBlockIds: context.changedBlockIds });
  if (design.errors.length) return { ok: false, errors: design.errors };
  return { ok: true, spec: design.spec, results };
}

/** A result's rows as stored: at most `storedRows` rows and 2 MiB of JSON (halved until they fit). */
export function storedRows(rows: unknown[][]): { json: string; count: number; cut: boolean } {
  let kept = rows.slice(0, REPORT_LIMITS.storedRows);
  let json = JSON.stringify(kept);
  while (json.length > REPORT_LIMITS.storedResultBytes && kept.length > 0) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    json = JSON.stringify(kept);
  }
  return { json, count: kept.length, cut: kept.length < rows.length };
}

/** Why an accepted spec was not saved (review L1); the transaction rolled back. */
export class PersistRefused extends Error {
  constructor(readonly reason: "REPORT_GONE" | "RUN_NOT_RUNNING") {
    super(reason === "REPORT_GONE" ? "The report was moved to the Bin or deleted during generation" : "The run is no longer running (it was stopped or reclaimed)");
    this.name = "PersistRefused";
  }
}

/** The spec version a new generation stamps: one more than any block's provenance in the current spec. */
export function nextSpecVersion(currentSpecJson: string): number {
  return Math.max(0, ...parseSpec(currentSpecJson).blocks.map((block) => block.provenance?.version ?? 0)) + 1;
}

/**
 * Saves an accepted spec in one transaction: the report's queries (replaced), the run's results, the
 * spec with each block's provenance, the doc hash it came from, status `ready`, and the run `succeeded`.
 */
export function persistGenerated(input: { reportId: string; runId: string; docSnapshotId: string | null; docHash: string | null; spec: ReportSpec; results: ReadonlyMap<string, QueryOutcome> }): ReportSpec {
  return db.transaction(() => {
    // Review L1: a binned or purged report, or a run that is no longer running (abandoned, reclaimed by
    // wave 47's lease sweep), saves nothing: the transaction rolls back.
    const current = db.query("SELECT spec_json FROM reports WHERE id = ? AND deleted_at IS NULL").get(input.reportId) as { spec_json: string } | null;
    if (!current) throw new PersistRefused("REPORT_GONE");
    if (!db.query("SELECT 1 FROM report_runs WHERE id = ? AND report_id = ? AND status = 'running'").get(input.runId, input.reportId)) throw new PersistRefused("RUN_NOT_RUNNING");
    // Wave 48 (review M2): the version comes from report_versions, and the generated spec is recorded
    // as a `generate` version in this same transaction, so versions and block provenance agree. A spec
    // saved before wave 48 is recorded first (the idempotent backfill), so regenerating never loses it.
    backfillVersion(input.reportId);
    const version = nextVersion(input.reportId, parseSpec(current.spec_json));
    const provenance = { runId: input.runId, version, docSnapshotId: input.docSnapshotId };
    const spec: ReportSpec = { version: 1, specVersion: 2, sections: input.spec.sections, queries: input.spec.queries, blocks: input.spec.blocks.map((block) => ({ ...block, provenance })) };
    const specJson = JSON.stringify(spec);
    if (specJson.length > 524_288) throw new Error("SPEC_TOO_LARGE");
    const at = now();
    db.query("DELETE FROM report_queries WHERE report_id = ?").run(input.reportId);
    const insertQuery = db.query("INSERT INTO report_queries (id, report_id, key, sql, purpose, columns_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?)");
    const insertResult = db.query(`INSERT INTO report_results (id, run_id, report_id, query_key, sql, sent_sql, columns_json, rows_json, row_count, truncated, rows_read, bytes_read, ch_query_id, ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const query of spec.queries) {
      const result = input.results.get(query.key);
      insertQuery.run(crypto.randomUUID(), input.reportId, query.key, query.sql, query.purpose, JSON.stringify(result?.columns ?? []), at, at);
      if (!result) continue;
      const rows = storedRows(result.rows);
      insertResult.run(crypto.randomUUID(), input.runId, input.reportId, query.key, query.sql, result.sentSql, JSON.stringify(result.columns), rows.json, rows.count,
        result.truncated || rows.cut ? 1 : 0, result.rowsRead, result.bytesRead, result.chQueryId.slice(0, 128), result.ms, at);
    }
    const ran = db.query("UPDATE report_runs SET status = 'succeeded', finished_at = ?, lease_until = NULL, error = NULL WHERE id = ? AND status = 'running'").run(at, input.runId);
    if (ran.changes !== 1) throw new PersistRefused("RUN_NOT_RUNNING");
    db.query("INSERT INTO report_versions (report_id, version, spec_json, source, run_id, created_by, created_at) VALUES (?, ?, ?, 'generate', ?, (SELECT owner_id FROM reports WHERE id = ?), ?)")
      .run(input.reportId, version, specJson, input.runId, input.reportId, at);
    const saved = db.query(`UPDATE reports SET spec_json = ?, status = 'ready', doc_hash = COALESCE(?, doc_hash), last_run_at = ?, last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(specJson, input.docHash, at, at, input.reportId);
    if (saved.changes !== 1) throw new PersistRefused("REPORT_GONE");
    return spec;
  })();
}
