import { z } from "zod";
import { db, now } from "../db";
import { BLOCK_ID, CHART_KINDS, QUERY_KEY, REPORT_LIMITS, VALUE_FORMATS, type QueryOutcome, type ReportBlock, type ReportSpec } from "../../shared/reports";
import { queryIdFor } from "./clickhouse";
import type { DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import { runGuarded } from "./runner";
import { parseSpec } from "./service";

/**
 * Checking a spec the generation agent submits (plan wave 46, D425), before anything is saved:
 *
 * 1. The shape (zod over shared/reports.ts's vocabulary and limits): at most 12 queries and 20
 *    blocks, keys and ids in their patterns and unique.
 * 2. Every block's `queryKey` names one of the spec's queries.
 * 3. Every query passes the guard as a SELECT and runs on the report's data source (D411, D412).
 * 4. Every column a block names is in its query's result, and a chart's `y` columns are numeric.
 *
 * Errors come back as short lines the model can act on (generate.ts gives it two more tries). An
 * accepted spec is saved with its queries and their first results in one transaction, every block
 * stamped with its provenance (the run, the spec version, the doc snapshot), and the report becomes
 * `ready`.
 */

const column = z.string().min(1).max(200);
const format = z.enum(VALUE_FORMATS);
const base = { id: z.string().regex(BLOCK_ID, "must match [a-z0-9][a-z0-9_-]{0,39}"), title: z.string().max(REPORT_LIMITS.blockTitle).optional() };
const queryKey = z.string().regex(QUERY_KEY, "must match [a-z][a-z0-9_]{0,39}");

const blockSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("markdown"), markdown: z.string().min(1).max(REPORT_LIMITS.markdown) }),
  z.object({ ...base, type: z.literal("kpi"), queryKey, column, format: format.optional(), compareColumn: column.optional(), label: z.string().max(REPORT_LIMITS.blockTitle).optional() }),
  z.object({ ...base, type: z.literal("chart"), queryKey, kind: z.enum(CHART_KINDS), x: column, y: z.array(column).min(1).max(REPORT_LIMITS.chartSeries), series: column.optional(), format: format.optional() }),
  z.object({ ...base, type: z.literal("table"), queryKey, columns: z.array(column).max(REPORT_LIMITS.tableColumns).optional(), formats: z.record(z.string(), format).optional() })
]);
const querySchema = z.object({ key: queryKey, sql: z.string().trim().min(1).max(REPORT_LIMITS.sqlChars), purpose: z.string().max(REPORT_LIMITS.purpose).default("") });
export const specSchema = z.object({
  version: z.literal(1).default(1),
  blocks: z.array(blockSchema).min(1).max(REPORT_LIMITS.blocks),
  queries: z.array(querySchema).max(REPORT_LIMITS.queries)
});

const formatList = [...VALUE_FORMATS];
const columnProp = { type: "string", maxLength: 200 };
const blockBase = { id: { type: "string", pattern: BLOCK_ID.source }, title: { type: "string", maxLength: REPORT_LIMITS.blockTitle } };

/** submit_report's parameters: the ReportSpec of shared/reports.ts as JSON Schema (the model fills it). */
export const SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["blocks", "queries"],
  properties: {
    version: { type: "integer", enum: [1] },
    queries: {
      type: "array", maxItems: REPORT_LIMITS.queries,
      items: { type: "object", required: ["key", "sql", "purpose"], properties: { key: { type: "string", pattern: QUERY_KEY.source }, sql: { type: "string", maxLength: REPORT_LIMITS.sqlChars }, purpose: { type: "string", maxLength: REPORT_LIMITS.purpose } } }
    },
    blocks: {
      type: "array", minItems: 1, maxItems: REPORT_LIMITS.blocks,
      items: {
        anyOf: [
          { type: "object", required: ["id", "type", "markdown"], properties: { ...blockBase, type: { const: "markdown" }, markdown: { type: "string", maxLength: REPORT_LIMITS.markdown } } },
          { type: "object", required: ["id", "type", "queryKey", "column"], properties: { ...blockBase, type: { const: "kpi" }, queryKey: { type: "string" }, column: columnProp, format: { enum: formatList }, compareColumn: columnProp, label: { type: "string" } } },
          { type: "object", required: ["id", "type", "queryKey", "kind", "x", "y"], properties: { ...blockBase, type: { const: "chart" }, queryKey: { type: "string" }, kind: { enum: [...CHART_KINDS] }, x: columnProp, y: { type: "array", minItems: 1, maxItems: REPORT_LIMITS.chartSeries, items: columnProp }, series: columnProp, format: { enum: formatList } } },
          { type: "object", required: ["id", "type", "queryKey"], properties: { ...blockBase, type: { const: "table" }, queryKey: { type: "string" }, columns: { type: "array", maxItems: REPORT_LIMITS.tableColumns, items: columnProp }, formats: { type: "object", additionalProperties: { enum: formatList } } } }
        ]
      }
    }
  }
};

/** Whether a ClickHouse type is a number (Nullable and LowCardinality unwrapped). */
export function isNumericType(type: string): boolean {
  let value = type.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const inner = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(value);
    if (!inner) break;
    value = inner[1]!.trim();
  }
  return /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?(?:\(.*\))?)$/.test(value);
}

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

/** Steps 1 and 2: the shape and the references, no ClickHouse. */
export function checkSpecShape(raw: unknown): { ok: true; spec: ReportSpec } | { ok: false; errors: string[] } {
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, MAX_ERRORS).map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`) };
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const query of parsed.data.queries) {
    if (keys.has(query.key)) errors.push(`queries: the key ${query.key} is used twice`);
    keys.add(query.key);
  }
  const ids = new Set<string>();
  for (const block of parsed.data.blocks) {
    if (ids.has(block.id)) errors.push(`blocks: the id ${block.id} is used twice`);
    ids.add(block.id);
    if (block.type !== "markdown" && !keys.has(block.queryKey)) errors.push(`block ${block.id}: queryKey ${block.queryKey} is not one of the spec's queries`);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  const spec: ReportSpec = {
    version: 1,
    queries: parsed.data.queries.map((query) => ({ key: query.key, sql: query.sql, purpose: query.purpose, createdBy: "agent" })),
    blocks: parsed.data.blocks as ReportBlock[]
  };
  return { ok: true, spec };
}

/** Step 4: the columns each block names, against its query's result. */
export function checkColumns(spec: ReportSpec, results: ReadonlyMap<string, QueryOutcome>): string[] {
  const errors: string[] = [];
  for (const block of spec.blocks) {
    if (block.type === "markdown") continue;
    const result = results.get(block.queryKey);
    if (!result) continue;
    const types = new Map(result.columns.map((item) => [item.name, item.type]));
    const known = [...types.keys()].slice(0, 30).join(", ");
    const need = (name: string, what: string) => {
      if (!types.has(name)) errors.push(`block ${block.id}: ${what} ${name} is not a column of ${block.queryKey} (columns: ${known})`);
    };
    if (block.type === "kpi") {
      need(block.column, "column");
      if (block.compareColumn) need(block.compareColumn, "compareColumn");
    } else if (block.type === "chart") {
      need(block.x, "x");
      if (block.series) need(block.series, "series");
      for (const name of block.y) {
        need(name, "y");
        const type = types.get(name);
        if (type !== undefined && !isNumericType(type)) errors.push(`block ${block.id}: y column ${name} is ${type}, not a number; cast it in the SQL (toFloat64, toInt64) or choose another column`);
      }
    } else {
      for (const name of block.columns ?? []) need(name, "column");
      for (const name of Object.keys(block.formats ?? {})) need(name, "formats column");
    }
  }
  return errors.slice(0, MAX_ERRORS);
}

/** The whole check: shape, references, each query run through the guard (selects only), and columns. */
export async function validateSpec(row: DatasourceRow, raw: unknown, context: { userId: string; runId: string; signal?: AbortSignal }): Promise<SpecCheck> {
  const shape = checkSpecShape(raw);
  if (!shape.ok) return shape;
  const spec = shape.spec;
  const used = new Set(spec.blocks.flatMap((block) => block.type === "markdown" ? [] : [block.queryKey]));
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
  return { ok: true, spec, results };
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
    const version = nextSpecVersion(current.spec_json);
    const provenance = { runId: input.runId, version, docSnapshotId: input.docSnapshotId };
    const spec: ReportSpec = { version: 1, queries: input.spec.queries, blocks: input.spec.blocks.map((block) => ({ ...block, provenance })) };
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
    const saved = db.query(`UPDATE reports SET spec_json = ?, status = 'ready', doc_hash = COALESCE(?, doc_hash), last_run_at = ?, last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(specJson, input.docHash, at, at, input.reportId);
    if (saved.changes !== 1) throw new PersistRefused("REPORT_GONE");
    return spec;
  })();
}
