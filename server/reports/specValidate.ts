import { z } from "zod";
import { db, now } from "../db";
import {
  BLOCK_ID, BLOCK_INTENTS, COMPARE_LABEL_MAX, BLOCK_WIDTHS, blockKeys, CHART_KINDS, defaultIntent, defaultWidth, FACETABLE_KINDS, isNumericType, isTimeType, KINDS_WITH_X2, KINDS_WITHOUT_X, ordinalColumn, ordinalX,
  QUERY_KEY, REPORT_LIMITS, reportLayout, SECTION_LIMITS, SPEC_FORMAT, STACK_MODES, STACKABLE_KINDS, UNIT, VALUE_FORMATS,
  type AutoFix, type BlockIntent, type ChartBlock, type ChartKind, type QueryOutcome, type ReportBlock, type ReportSpec, type ResultColumn
} from "../../shared/reports";
import { MAX_FACETS, MAX_HEATMAP_SIDE, MAX_SCATTER_SERIES, MAX_SERIES } from "../../shared/reportTheme";
import { findCycle, histogramBins } from "../../shared/reportStats";
import { queryIdFor } from "./clickhouse";
import type { DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import { runGuarded } from "./runner";
import { sanityChecks, type SanityContext, type SanityResult } from "./sanity";
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
const provenance = z.object({ runId: z.string().max(64).nullable(), instructionId: z.string().max(64).nullish(), version: z.number().int().min(0).max(1_000_000), docSnapshotId: z.string().max(64).nullish(), model: z.string().max(200).nullish() }).strict();
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
    ...base, type: z.literal("chart"), queryKey, kind: z.enum(CHART_KINDS), x: column.optional(), y: z.array(column).min(1).max(REPORT_LIMITS.chartSeries), series: column.optional(),
    format: format.optional(), unit: unit.optional(), emphasis: z.string().min(1).max(200).optional(), upIsGood: z.boolean().optional(), compareTo: columnRef.optional(),
    // Round 2 (D462): checkSpecShape refuses each on the kinds it does not belong to.
    x2: column.optional(), midpoint: z.number().finite().optional(), cohort: z.boolean().optional(), target: column.optional(), max: z.number().finite().positive().optional(),
    ranges: z.array(column).min(1).max(3).optional(), start: z.boolean().optional(), total: z.boolean().optional(), yUnits: z.array(unit).length(2).optional(),
    stack: z.enum(STACK_MODES).optional(), facet: column.optional()
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
      type: "object", additionalProperties: false, required: ["id", "type", "title", "intent", "queryKey", "kind", "y"],
      properties: {
        ...blockBase, type: { const: "chart" }, queryKey: { type: "string" }, kind: { enum: [...CHART_KINDS] },
        x: { ...columnProp, description: "The category, stage, step, date, or source column; every kind but gauge and histogram" },
        y: { type: "array", minItems: 1, maxItems: REPORT_LIMITS.chartSeries, items: columnProp, description: "Numeric measures; one for heatmap, calendar, funnel, gauge, treemap, sankey, histogram, waterfall, bullet; boxplot 1 (raw values) or 5 (min, q1, median, q3, max); combo 2 (bar, line)" },
        series: columnProp, format: formatProp, unit: unitProp,
        emphasis: { type: "string", maxLength: 200, description: "A series name or (one series) a category value to highlight" }, upIsGood: { type: "boolean" }, compareTo: refProp,
        x2: { ...columnProp, description: "heatmap: the row column (cohorts); sankey: the target node; treemap: the second level" },
        midpoint: { type: "number", description: "heatmap: centre of a diverging scale when values fall on both sides (usually 0)" },
        cohort: { type: "boolean", description: "heatmap: rows are cohorts, columns are periods since start" },
        target: { ...columnProp, description: "gauge, bullet: the target column" },
        max: { type: "number", exclusiveMinimum: 0, description: "gauge: the scale maximum when there is no target" },
        ranges: { type: "array", minItems: 1, maxItems: 3, items: columnProp, description: "bullet: columns of ascending band limits (poor, fair, good)" },
        start: { type: "boolean", description: "waterfall: the first row is the starting total" },
        total: { type: "boolean", description: "waterfall: add an ending total bar" },
        yUnits: { type: "array", minItems: 2, maxItems: 2, items: unitProp, description: "combo: the unit of each measure; they must be the same" },
        stack: { enum: [...STACK_MODES], description: "area, bar: normal = stacked, percent = 100% stacked shares" },
        facet: { ...columnProp, description: "line, bar, area: one small chart per value (at most 12), shared y scale" }
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
  | { ok: true; spec: ReportSpec; results: Map<string, QueryOutcome>; sanity?: SanityResult }
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
    if (block.type === "chart") errors.push(...kindFieldErrors(block as Omit<ChartBlock, "x"> & { x?: string }));
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
      // A gauge reads one value and a histogram bins one column: their x is that column (D462).
      if (filled.type === "chart" && !filled.x) return { ...filled, x: filled.y[0]! };
      if (filled.type === "kpi" && filled.compareColumn && !filled.compareTo) {
        const { compareColumn, ...rest } = filled;
        return { ...rest, compareTo: { column: compareColumn } };
      }
      return filled;
    })
  };
  return { ok: true, spec };
}

/** Round 2's per-kind fields (D462): each field only on its kinds, the measures each kind reads, and the columns it needs. */
const NEW_KINDS: readonly ChartKind[] = ["heatmap", "calendar", "funnel", "gauge", "treemap", "sankey", "boxplot", "histogram", "waterfall", "combo", "bullet"];
const FIELD_KINDS: Record<string, readonly ChartKind[]> = {
  midpoint: ["heatmap"], cohort: ["heatmap"], target: ["gauge", "bullet"], max: ["gauge"], ranges: ["bullet"], start: ["waterfall"], total: ["waterfall"], yUnits: ["combo"],
  x2: KINDS_WITH_X2, stack: STACKABLE_KINDS, facet: FACETABLE_KINDS
};
function kindFieldErrors(block: Omit<ChartBlock, "x"> & { x?: string }): string[] {
  const errors: string[] = [];
  const say = (text: string) => errors.push(`block ${block.id}: ${text}`);
  const record = block as unknown as Record<string, unknown>;
  for (const [field, kinds] of Object.entries(FIELD_KINDS)) if (record[field] !== undefined && !kinds.includes(block.kind)) say(`${field} is only for ${kinds.join(", ")}, not ${block.kind}`);
  if (NEW_KINDS.includes(block.kind)) {
    for (const field of ["series", "compareTo", "emphasis"] as const) if (block[field] !== undefined) say(`${field} is not used by ${block.kind}; remove it`);
  }
  if (!block.x && !KINDS_WITHOUT_X.includes(block.kind)) say(`a ${block.kind} needs x`);
  if ((block.kind === "heatmap" || block.kind === "sankey") && !block.x2) say(block.kind === "heatmap" ? "a heatmap needs x2, the row column (x is the column dimension, y the value)" : "a sankey needs x2, the target node column (x is the source, y the flow)");
  const measures = block.kind === "combo" ? [2] : block.kind === "boxplot" ? [1, 5] : NEW_KINDS.includes(block.kind) ? [1] : null;
  if (measures && !measures.includes(block.y.length)) say(block.kind === "boxplot" ? "a boxplot takes y = [raw values] or y = [min, q1, median, q3, max]" : block.kind === "combo" ? "a combo takes y = [bar measure, line measure]" : `a ${block.kind} takes exactly one y measure`);
  if (block.kind === "combo" && !block.yUnits) say("a combo needs yUnits, the unit of each measure (they must match: one axis only)");
  if (block.kind === "gauge" && !block.target && block.max === undefined) say("a gauge needs a target column or a max");
  if (block.kind === "bullet" && !block.target) say("a bullet needs a target column");
  if (block.facet && block.series) say("a faceted chart splits by facet; drop series (each panel draws the y columns)");
  return errors;
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
      if (block.x2) need(block.x2, "x2");
      if (block.facet) need(block.facet, "facet");
      for (const [name, what] of [...(block.target ? [[block.target, "target"]] : []), ...(block.ranges ?? []).map((name) => [name, "ranges column"])] as Array<[string, string]>) {
        need(name, what);
        if (types.has(name)) numeric(name, what);
      }
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
  compactFrom: 10_000,
  // Round 2 (D465).
  /** Rule 12: heatmap columns and rows. */
  heatmapSide: MAX_HEATMAP_SIDE,
  /** Rule 13: a calendar spans at most this many days (2 years). */
  calendarDays: 731,
  /** Rule 14: funnel stages. */
  funnelStages: { min: 2, max: 8 },
  /** Rule 16 (auto): treemap top-level groups beyond this fold into "Other" (top 7 kept). */
  treemapGroups: 8,
  /** Rule 17: sankey nodes and links. */
  sankeyNodes: 30,
  sankeyLinks: 60,
  /** Rule 18: box plot categories. */
  boxCategories: 20,
  /** Rule 19: values a histogram needs. */
  histogramValues: 5,
  /** Rule 20: waterfall steps. */
  waterfallSteps: { min: 2, max: 25 },
  /** Rule 22: bullet categories. */
  bulletCategories: 15,
  /** Small multiples (auto): panels beyond this fold into "Other". */
  facets: MAX_FACETS
} as const;

/** Rule 11: the intents each round-2 kind serves, and the kinds each new intent is drawn with (D462). */
export const KIND_INTENTS: Partial<Record<ChartKind, readonly BlockIntent[]>> = {
  heatmap: ["matrix"], calendar: ["trend"], funnel: ["conversion"], gauge: ["attainment"], bullet: ["attainment"], treemap: ["share"],
  sankey: ["flow"], boxplot: ["distribution"], histogram: ["distribution"], waterfall: ["delta"], combo: ["compare", "trend"]
};
export const INTENT_KINDS: Partial<Record<BlockIntent, readonly ChartKind[]>> = { matrix: ["heatmap"], conversion: ["funnel"], attainment: ["gauge", "bullet"], flow: ["sankey"] };

const BAR_KINDS = new Set(["bar", "stacked_bar", "horizontal_bar", "combo"]);
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
    // Rule 6: one value is a KPI, not a chart (a gauge is the one chart of one value).
    if (kind !== "gauge" && result.rows.length === 1 && block.y.length === 1 && !block.series) say(6, `the result is a single value; make it a kpi block${kind === "funnel" || kind === "bullet" ? "" : " (or a gauge against a target)"}`);
    // Rule 11: the round-2 kinds and intents go together.
    const kindIntents = KIND_INTENTS[kind];
    if (kindIntents && intent && !kindIntents.includes(intent)) say(11, `a ${kind} is for intent ${kindIntents.join(" or ")}, not ${intent}`);
    const intentKinds = intent ? INTENT_KINDS[intent] : undefined;
    if (intentKinds && !intentKinds.includes(kind)) say(11, `intent ${intent} is drawn as a ${intentKinds.join(" or ")}, not a ${kind}`);
    fixes.push(...roundTwoRules(block, result, say));
    // Rule 1: a trend runs over time.
    if (intent === "trend" && !isTimeType(typeOf(result.columns, block.x))) say(1, `intent trend needs x to be a Date or DateTime column, but ${block.x} is ${typeOf(result.columns, block.x) || "unknown"}; use intent compare, or select a date`);
    // Rule 2: a share is a stacked bar, or a pie of at most 5 slices that make the whole.
    if (intent === "share" && kind !== "stacked_bar" && kind !== "pie" && kind !== "treemap" && !block.stack) say(2, `intent share is drawn as a stacked_bar, a bar or area with stack percent, a treemap, or a pie of at most ${DESIGN_LIMITS.pieSlices} slices; ${kind} is not`);
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
    // Rules 3 and 4 (auto, D466): too many series on a line (over 8) or a scatter (over 3) become small
    // multiples, one panel per series on a shared scale; v1 blocks keep wave 47's fold.
    const autoFacet = !block.legacy && block.series !== undefined && ((kind === "scatter" && names.length > DESIGN_LIMITS.scatterSeries) || (kind === "line" && names.length > DESIGN_LIMITS.series));
    if (kind === "scatter" && names.length > DESIGN_LIMITS.scatterSeries && !autoFacet) say(4, `a scatter may show at most ${DESIGN_LIMITS.scatterSeries} series (this has ${names.length}); split it by a series column so Nook draws small multiples, or fold the rest into Other in SQL`);
    if (autoFacet) fixes.push({ rule: "facet", detail: `${names.length} series drawn as small multiples (one panel each, shared y scale)` });
    const panels = autoFacet ? names.length : block.facet ? new Set(result.rows.map((row) => label(row[result.columns.findIndex((item) => item.name === block.facet)]))).size : 0;
    if (panels > DESIGN_LIMITS.facets) fixes.push({ rule: "fold_panels", detail: `${panels - (DESIGN_LIMITS.facets - 1)} of ${panels} panels folded into "Other" (top ${DESIGN_LIMITS.facets - 1} kept)` });
    if (block.facet && panels < 2) say(23, `facet ${block.facet} has ${panels} value; small multiples need at least 2 (drop facet)`);
    // Rule 3 (auto): more than 8 series fold into the top 7 + Other.
    if (!autoFacet && kind !== "scatter" && kind !== "pie" && names.length > DESIGN_LIMITS.series) fixes.push({ rule: "fold_series", detail: `${names.length - (DESIGN_LIMITS.series - 1)} of ${names.length} series folded into "Other" (top ${DESIGN_LIMITS.series - 1} kept)` });
    // Rule 7: no dual axes; measures of very different scale go in separate charts (a box plot's five numbers are one measure).
    const measures = [...block.y, ...(block.compareTo && !block.compareTo.queryKey ? [block.compareTo.column] : [])];
    if (measures.length >= 2 && !block.series && kind !== "boxplot") {
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

const columnIndex = (result: Rows, name: string | undefined) => name === undefined ? -1 : result.columns.findIndex((item) => item.name === name);
const distinct = (result: Rows, index: number) => [...new Set(result.rows.map((row) => label(row[index])))];

/**
 * Rules 12–22 (chart kinds round 2, D465): one function per kind's limits; refusals go through `say`
 * (only for checked blocks), the auto-fixes (treemap groups, histogram bins, box plot quartiles) are returned.
 */
function roundTwoRules(block: ChartBlock, result: Rows, say: (rule: number, text: string) => void): AutoFix[] {
  const fixes: AutoFix[] = [];
  const xi = columnIndex(result, block.x);
  const yi = columnIndex(result, block.y[0]);
  const values = result.rows.map((row) => numberOf(row[yi]));
  const show = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);
  switch (block.kind) {
    case "heatmap": {
      const x2i = columnIndex(result, block.x2);
      const columns = distinct(result, xi);
      const rows = distinct(result, x2i);
      if (columns.length > DESIGN_LIMITS.heatmapSide || rows.length > DESIGN_LIMITS.heatmapSide) say(12, `the heatmap would be ${columns.length} columns × ${rows.length} rows; at most ${DESIGN_LIMITS.heatmapSide}×${DESIGN_LIMITS.heatmapSide}: aggregate to coarser periods (toStartOfWeek, toStartOfMonth) or keep the first ${DESIGN_LIMITS.heatmapSide} cohorts in SQL`);
      for (const [name, index] of [[block.x, xi], [block.x2!, x2i]] as Array<[string, number]>) {
        if (index >= 0 && !ordinalColumn(result.columns[index]!.type, result.rows.map((row) => row[index]))) say(12, `heatmap axes must be ordered (dates, numbers, periods, weekdays, or numbered steps such as Week 3); ${name} is not, so use a bar chart or a table`);
      }
      break;
    }
    case "calendar": {
      if (!isTimeType(typeOf(result.columns, block.x))) { say(13, `a calendar needs x to be a Date or DateTime column, but ${block.x} is ${typeOf(result.columns, block.x) || "unknown"}`); break; }
      const times = result.rows.map((row) => Date.parse(String(row[xi]).slice(0, 10))).filter((time) => Number.isFinite(time));
      const days = times.length ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;
      if (days > DESIGN_LIMITS.calendarDays) say(13, `a calendar shows at most 2 years; these dates span ${Math.round(days)} days: filter the dates in SQL or use a line chart by week`);
      break;
    }
    case "funnel": {
      const stages = result.rows.length;
      if (stages < DESIGN_LIMITS.funnelStages.min || stages > DESIGN_LIMITS.funnelStages.max) say(14, `a funnel has ${DESIGN_LIMITS.funnelStages.min}–${DESIGN_LIMITS.funnelStages.max} stages, one row each (this has ${stages}); merge steps in SQL or use a bar chart`);
      for (let at = 1; at < values.length; at += 1) {
        if (values[at] !== null && values[at - 1] !== null && values[at]! > values[at - 1]!) {
          say(14, `funnel values must not increase from one stage to the next (${label(result.rows[at]![xi])} ${show(values[at]!)} > ${label(result.rows[at - 1]![xi])} ${show(values[at - 1]!)}); order the rows by stage in SQL (stages are never re-sorted), or use a bar chart if the steps are not a funnel`);
          break;
        }
      }
      break;
    }
    case "gauge": {
      if (result.rows.length !== 1) say(15, `a gauge shows one value from a one-row result (this has ${result.rows.length} rows); aggregate in SQL`);
      const target = block.target ? numberOf(result.rows[0]?.[columnIndex(result, block.target)]) : block.max ?? null;
      if (target !== null && target <= 0) say(15, `the gauge's ${block.target ? "target" : "max"} must be above 0`);
      break;
    }
    case "treemap": {
      if (values.some((value) => value !== null && value < 0)) say(16, "a treemap shows positive parts of a whole; filter out negative values in SQL or use a bar chart");
      const groups = distinct(result, xi).length;
      if (groups > DESIGN_LIMITS.treemapGroups) fixes.push({ rule: "fold_groups", detail: `${groups - (DESIGN_LIMITS.treemapGroups - 1)} of ${groups} top-level groups folded into "Other" (top ${DESIGN_LIMITS.treemapGroups - 1} kept)` });
      break;
    }
    case "sankey": {
      const x2i = columnIndex(result, block.x2);
      const links = new Map<string, readonly [string, string]>();
      for (const row of result.rows) links.set(JSON.stringify([label(row[xi]), label(row[x2i])]), [label(row[xi]), label(row[x2i])]);
      const nodes = new Set([...links.values()].flat());
      if (nodes.size > DESIGN_LIMITS.sankeyNodes || links.size > DESIGN_LIMITS.sankeyLinks) say(17, `a sankey shows at most ${DESIGN_LIMITS.sankeyNodes} nodes and ${DESIGN_LIMITS.sankeyLinks} links (this has ${nodes.size} and ${links.size}); group small sources and targets as Other in SQL`);
      const cycle = findCycle([...links.values()]);
      if (cycle) say(17, `the flows form a cycle (${cycle.slice(0, 6).map((node) => node.slice(0, 30)).join(" → ")}); a sankey cannot draw one: make each step's nodes distinct (prefix them with the step) or use a table`);
      if (values.some((value) => value !== null && value < 0)) say(17, "sankey flows must not be negative");
      break;
    }
    case "boxplot": {
      const categories = distinct(result, xi).length;
      if (categories > DESIGN_LIMITS.boxCategories) say(18, `a box plot shows at most ${DESIGN_LIMITS.boxCategories} categories (this has ${categories}); keep the largest in SQL`);
      if (block.y.length === 5) {
        const indexes = block.y.map((name) => columnIndex(result, name));
        const bad = result.rows.find((row) => {
          const five = indexes.map((index) => numberOf(row[index]));
          return five.some((value, at) => value !== null && at > 0 && five[at - 1] !== null && value < five[at - 1]!);
        });
        if (bad) say(18, `a precomputed box needs min ≤ q1 ≤ median ≤ q3 ≤ max in each row (${label(bad[xi])} is not); check the column order: ${block.y.join(", ")}`);
      } else fixes.push({ rule: "quartiles", detail: `Quartiles computed by Nook from ${values.filter((value) => value !== null).length} values (linear interpolation; whiskers at 1.5 IQR)` });
      break;
    }
    case "histogram": {
      const numbers = values.filter((value): value is number => value !== null);
      if (numbers.length < DESIGN_LIMITS.histogramValues) say(19, `a histogram needs at least ${DESIGN_LIMITS.histogramValues} values (this has ${numbers.length}); select the raw values, not an aggregate`);
      const bins = histogramBins(numbers);
      if (bins) fixes.push({ rule: "bin", detail: `${bins.counts.length} bins of width ${show(bins.width)} (${bins.rule === "sturges" ? "Sturges; the IQR is 0" : "Freedman–Diaconis"}, clamped to 5–50)` });
      break;
    }
    case "waterfall": {
      const steps = result.rows.length;
      if (steps < DESIGN_LIMITS.waterfallSteps.min || steps > DESIGN_LIMITS.waterfallSteps.max) say(20, `a waterfall has ${DESIGN_LIMITS.waterfallSteps.min}–${DESIGN_LIMITS.waterfallSteps.max} steps (this has ${steps}); group small steps as Other in SQL`);
      break;
    }
    case "combo": {
      const [left, right] = (block.yUnits ?? []).map((unit) => unit.trim().toLowerCase());
      if (left !== undefined && right !== undefined && left !== right) say(21, `the bar (${block.yUnits![0]}) and the line (${block.yUnits![1]}) have different units; a combo shares one axis and there is never a second one, so split them into two charts`);
      break;
    }
    case "bullet": {
      const categories = distinct(result, xi).length;
      if (categories > DESIGN_LIMITS.bulletCategories) say(22, `a bullet chart shows at most ${DESIGN_LIMITS.bulletCategories} categories (this has ${categories}); keep the largest in SQL`);
      const indexes = (block.ranges ?? []).map((name) => columnIndex(result, name));
      const bad = result.rows.find((row) => {
        const limits = indexes.map((index) => numberOf(row[index]));
        return limits.some((value, at) => value !== null && at > 0 && limits[at - 1] !== null && value < limits[at - 1]!);
      });
      if (bad) say(22, `bullet ranges must ascend (poor ≤ fair ≤ good) in each row (${label(bad[xi])} does not)`);
      break;
    }
    default:
      break;
  }
  // A 100 % stack shows positive parts of each category.
  if (block.stack === "percent" && result.rows.some((row) => block.y.some((name) => (numberOf(row[columnIndex(result, name)]) ?? 0) < 0))) say(2, "a percent stack shows positive parts of a whole; it cannot show negative values");
  return fixes;
}

/**
 * The whole check: shape, references, each query run through the guard (selects only), columns, and
 * the design rules. A spec that passes comes back with its auto-fixes recorded.
 */
export async function validateSpec(row: DatasourceRow, raw: unknown, context: { userId: string; runId: string; signal?: AbortSignal; /** E2: run the result sanity checks (generation). */ sanity?: Pick<SanityContext, "metricOf"> & { /** E6: queries an edit changed (their blocks are checked too). */ changedQueryKeys?: Iterable<string> } } & DesignOptions): Promise<SpecCheck> {
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
      const hint = typeof known.details.hint === "string" ? ` Hint: ${known.details.hint.slice(0, 600)}` : "";
      errors.push(`query ${query.key}: ${known.code}${guard}: ${known.message.slice(0, 300)}${hint}`);
    }
  }
  errors.push(...checkColumns(spec, results));
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  const design = checkDesign(spec, results, { changedBlockIds: context.changedBlockIds });
  if (design.errors.length) return { ok: false, errors: design.errors };
  // E2: the results look right? Hints only (the caller decides whether they refuse the submit).
  // E6: an edit (changedBlockIds) checks the blocks it touched and the queries they or it changed.
  let scope: SanityContext["scope"] = null;
  if (context.sanity && context.changedBlockIds) {
    const queries = new Set(context.sanity.changedQueryKeys ?? []);
    const blocks = new Set(context.changedBlockIds);
    for (const block of design.spec.blocks) if (blockKeys(block).some((key) => queries.has(key))) blocks.add(block.id);
    for (const block of design.spec.blocks) if (blocks.has(block.id)) for (const key of blockKeys(block)) queries.add(key);
    scope = { blocks, queries };
  }
  const sanity = context.sanity ? await sanityChecks(row, design.spec, results, { userId: context.userId, runId: context.runId, signal: context.signal, metricOf: context.sanity.metricOf, scope }) : undefined;
  return { ok: true, spec: design.spec, results, ...(sanity ? { sanity } : {}) };
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
export function persistGenerated(input: { reportId: string; runId: string; docSnapshotId: string | null; docHash: string | null; spec: ReportSpec; results: ReadonlyMap<string, QueryOutcome>; /** E5: the model that wrote it. */ model?: string | null }): ReportSpec {
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
    const provenance = { runId: input.runId, version, docSnapshotId: input.docSnapshotId, ...(input.model ? { model: input.model.slice(0, 200) } : {}) };
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
