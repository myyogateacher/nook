import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { logger } from "../log";
import { REPORT_LIMITS, type QueryOutcome, type ReportQuery, type ReportResult, type ReportSpec, type ResultColumn, type RunTrigger } from "../../shared/reports";
import {
  bindValues, boundRecord, canonicalValues, declaredPlaceholders, defaultValues, isDefaultSet, PARAM_LIMITS, resolveValues, todayUtc, valueLabel,
  type BoundParam, type ParamOptions, type ParamSetInfo, type ParamValues, type ReportParameter
} from "../../shared/reportParams";
import type { QueryResultView, ReportResultsView } from "../../shared/reportsView";
import { readableReport, type ReportRow } from "./access";
import { queryIdFor } from "./clickhouse";
import { usableDatasource, type DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import {
  BUSY_WAIT_MS, capRows, HEARTBEAT_MS, LEASE_MS, paramsJson, parseParams, pool, REFRESH_CONCURRENCY, reportResults, runQueryId, takeRunLock
} from "./refresh";
import { killQuery, runGuarded } from "./runner";
import { parseSpec } from "./service";
import { classify, GuardError } from "./sqlGuard";

/**
 * Interactive report parameters (spec v3, D489, docs/plan/REPORT_THEME.md § Parameters).
 *
 * - **Binding.** Queries read parameters only as typed ClickHouse placeholders (`{period_from:Date}`);
 *   runner.ts checks each placeholder against the declared parameters and sends the values as
 *   `param_<name>` (shared/reportParams.ts encodes them), so a value is never SQL text.
 * - **The default set** is what Refresh all, schedules, generation, and version previews run; its
 *   results stay in `report_results`.
 * - **Other sets** (a reader changed the date range or a filter): the values are checked against their
 *   parameters (and a select's against its options), bound on today's date, and keyed by the sha256 of
 *   the canonical bound values. Their results live in `report_param_results`, one per query per set,
 *   shared by everyone who can read the report. A result is fresh while its SQL is the saved SQL and it
 *   is newer than the report's last default run; a run fills the missing ones.
 * - **Runs.** Read access is enough (D489): a run takes the report's one-run lock (409 RUN_IN_PROGRESS
 *   while another runs; the client retries), runs under the caller's query slots and the data source's
 *   limits, and is rate-limited per person (PARAM_RUNS.perMinute). Its run row is removed when it ends
 *   (the Runs history stays the owner's refreshes); the audit log keeps `reports.params.run`.
 * - **Pruning.** The PARAM_RUNS.setsKept most recently used sets per report are kept, none unused for
 *   PARAM_RUNS.setDays days.
 */

const plog = logger("reports");

export const PARAM_RUNS = {
  /** Runs (cache misses) one person may start per minute, across reports. */
  perMinute: 20,
  setsKept: 20,
  setDays: 7,
  /** A select's options are re-read after this long (and after every default refresh). */
  optionsMaxAgeMs: 6 * 60 * 60_000
} as const;

// ------------------------------------------------------------------------------- spec checks

/**
 * Spec shape checks for parameters (checkSpecShape): unique ids, defaults of their type, min ≤ max,
 * every placeholder a query writes declared with its exact type, and every parameter used.
 */
export function parameterErrors(params: readonly ReportParameter[], queries: ReadonlyArray<Pick<ReportQuery, "key" | "sql">>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const param of params) {
    if (ids.has(param.id)) errors.push(`parameters: the id ${param.id} is used twice`);
    ids.add(param.id);
    const resolved = resolveValues([param], { [param.id]: param.default });
    if (resolved.problems.length) errors.push(`parameter ${param.id}: default ${resolved.problems[0]!.slice(param.id.length + 2)}`);
    if (param.type === "number" && param.min !== undefined && param.max !== undefined && param.min > param.max) errors.push(`parameter ${param.id}: min is more than max`);
  }
  const declared = declaredPlaceholders(params);
  const used = new Set<string>();
  for (const query of queries) {
    let placeholders: Array<{ name: string; type: string }>;
    try {
      placeholders = classify(query.sql, { params: true }).placeholders;
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
      // The guard says so when the query runs; only placeholder problems are reported here.
      if (/query parameter/i.test(error.message)) errors.push(`query ${query.key}: ${error.message}`);
      continue;
    }
    for (const placeholder of placeholders) {
      const known = declared.get(placeholder.name);
      if (!known) errors.push(`query ${query.key}: {${placeholder.name}:${placeholder.type}} is not a declared parameter (declare it in parameters; a date range ${"`id`"} gives {id_from:Date} and {id_to:Date})`);
      else if (known.type !== placeholder.type) errors.push(`query ${query.key}: {${placeholder.name}:${placeholder.type}} must be written {${placeholder.name}:${known.type}} (the type of parameter ${known.param})`);
      else used.add(known.param);
    }
  }
  for (const param of params) if (!used.has(param.id)) errors.push(`parameter ${param.id}: no query reads it; use ${param.type === "date_range" ? `{${param.id}_from:Date} and {${param.id}_to:Date}` : `{${param.id}:${param.chType}}`} in a query's WHERE, or remove it`);
  return errors;
}

/**
 * The sets validation runs every query with (D489): the defaults, and one other set (another date
 * preset; a select's first other option; a multi-select's first option, or All when it has a default),
 * when the parameters allow one.
 */
export function paramSetsToCheck(params: readonly ReportParameter[], options: ReadonlyMap<string, readonly string[]>, today = todayUtc()): { defaults: BoundParam[]; other: { bound: BoundParam[]; label: string } | null } {
  const defaults = defaultValues(params);
  const other: ParamValues = { ...defaults };
  for (const param of params) {
    if (param.type === "date_range") other[param.id] = { preset: param.default.preset === "7d" ? "30d" : "7d" };
    else if (param.type === "select") {
      const choice = options.get(param.id)?.find((option) => option !== param.default);
      if (choice !== undefined) other[param.id] = choice;
    } else if (param.type === "multi_select") {
      const first = options.get(param.id)?.[0];
      other[param.id] = param.default.length ? [] : first !== undefined ? [first] : [];
    }
  }
  const differs = !isDefaultSet(params, other);
  return {
    defaults: bindValues(params, defaults, today),
    other: differs ? { bound: bindValues(params, other, today), label: params.map((param) => `${param.id}=${valueLabel(param, other[param.id]!)}`).join(", ").slice(0, 200) } : null
  };
}

// ----------------------------------------------------------------------------------- options

/** Runs a select's options query through the guard (a SELECT, no placeholders): its first column, at most 200 distinct values. */
export async function runOptionsQuery(row: DatasourceRow, sql: string, context: { userId: string; queryId: string; signal?: AbortSignal }): Promise<{ options: string[]; truncated: boolean }> {
  const outcome = await runGuarded(row, sql, { classes: ["select"], maxRows: PARAM_LIMITS.options, queryId: context.queryId, userId: context.userId, signal: context.signal });
  if (!outcome.columns.length) throw new ReportError(400, "INVALID", "An options query must select at least one column");
  const seen = new Set<string>();
  for (const line of outcome.rows) {
    const value = line[0];
    if (value === null || value === undefined) continue;
    const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, PARAM_LIMITS.optionChars);
    seen.add(typeof value === "number" || typeof value === "bigint" ? String(value) : text.replace(/^"(.*)"$/, "$1"));
  }
  return { options: [...seen].slice(0, PARAM_LIMITS.options), truncated: outcome.truncated };
}

type OptionsRow = { sql: string; values_json: string; truncated: number; error: string | null; created_at: string };

const optionsView = (paramId: string, row: OptionsRow | null): ParamOptions => {
  let options: string[] = [];
  try { options = row ? (JSON.parse(row.values_json) as unknown[]).filter((item): item is string => typeof item === "string") : []; } catch { options = []; }
  return { paramId, options, truncated: row?.truncated === 1, error: row?.error ?? null, at: row?.created_at ?? null };
};

/**
 * A select's options for a reader (GET …/parameters/:paramId/options): the cached list while its SQL
 * is the saved one, it is newer than the last default run, and younger than optionsMaxAgeMs; else the
 * options query runs again (the caller's query slots; a failure is cached as its error).
 */
export async function reportParamOptions(reportId: string, userId: string, paramId: string, report = readableReport(reportId, userId)): Promise<ParamOptions> {
  const spec = parseSpec(report.spec_json);
  const param = spec.parameters.find((item) => item.id === paramId);
  if (!param || (param.type !== "select" && param.type !== "multi_select")) throw new ReportError(404, "NOT_FOUND", "This report has no select parameter with that id");
  const cached = db.query("SELECT sql, values_json, truncated, error, created_at FROM report_param_options WHERE report_id = ? AND param_id = ?").get(reportId, paramId) as OptionsRow | null;
  const fresh = cached && cached.sql === param.optionsQuery && (!report.last_run_at || cached.created_at >= report.last_run_at) && Date.now() - Date.parse(cached.created_at) < PARAM_RUNS.optionsMaxAgeMs;
  if (fresh) return optionsView(paramId, cached);
  const datasource = usableDatasource(report.datasource_id);
  let values: string[] = [];
  let truncated = false;
  let error: string | null = null;
  try {
    const read = await runOptionsQuery(datasource, param.optionsQuery, { userId, queryId: queryIdFor("opt", reportId.replace(/-/g, "").slice(0, 12), paramId) });
    values = read.options;
    truncated = read.truncated;
  } catch (failure) {
    try { error = asReportError(failure).message.slice(0, 1000); } catch { error = "The options query failed"; }
    // A busy person keeps the last list rather than caching the refusal.
    if (failure instanceof ReportError && failure.code === "BUSY") throw failure;
  }
  const at = now();
  db.query(`INSERT INTO report_param_options (report_id, param_id, sql, values_json, truncated, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (report_id, param_id) DO UPDATE SET sql = excluded.sql, values_json = excluded.values_json, truncated = excluded.truncated, error = excluded.error, created_at = excluded.created_at`)
    .run(reportId, paramId, param.optionsQuery, JSON.stringify(values), truncated ? 1 : 0, error, at);
  return optionsView(paramId, { sql: param.optionsQuery, values_json: JSON.stringify(values), truncated: truncated ? 1 : 0, error, created_at: at });
}

/** Refuses a select value that is not one of its options (when they could be read): no set is cached for values nobody can pick. */
async function assertOptionValues(report: ReportRow, spec: ReportSpec, values: ParamValues, userId: string) {
  for (const param of spec.parameters) {
    if (param.type !== "select" && param.type !== "multi_select") continue;
    const value = values[param.id];
    const picked = param.type === "select" ? (value === param.default ? [] : [value as string]) : (value as string[]).filter((item) => !param.default.includes(item));
    if (!picked.length) continue;
    const options = await reportParamOptions(report.id, userId, param.id, report);
    if (options.error) continue;
    const known = new Set(options.options);
    const unknown = picked.find((item) => !known.has(item));
    if (unknown !== undefined) throw new ReportError(400, "INVALID", `${unknown.slice(0, 60)} is not one of the choices for ${param.label}`, { paramId: param.id });
  }
}

// ----------------------------------------------------------------------------------- sets

/** The cache key of a set: the sha256 of its canonical bound values. */
export const setHashOf = (bound: readonly BoundParam[]) => createHash("sha256").update(JSON.stringify([...bound].sort((a, b) => a.name.localeCompare(b.name)).map((item) => [item.name, item.type, item.value]))).digest("hex");

export type ResolvedSet = { values: ParamValues; bound: BoundParam[]; hash: string; isDefault: boolean };

/** Values given by a reader (the URL, MCP) for this spec: refused (400) when one does not fit its parameter. */
export function resolveSet(spec: ReportSpec, given: Record<string, unknown> | null | undefined, today = todayUtc()): ResolvedSet {
  const { values, problems } = resolveValues(spec.parameters, given);
  if (problems.length) throw new ReportError(400, "INVALID", `Parameter values refused: ${problems.slice(0, 3).join("; ")}`, { problems: problems.slice(0, 10) });
  const bound = bindValues(spec.parameters, values, today);
  return { values, bound, hash: setHashOf(bound), isDefault: isDefaultSet(spec.parameters, values) };
}

type ParamResultRow = {
  id: string; report_id: string; set_hash: string; query_key: string; sql: string; sent_sql: string | null; params_json: string | null; columns_json: string; rows_json: string;
  row_count: number; truncated: number; rows_read: number | null; bytes_read: number | null; ch_query_id: string | null; ms: number | null; error: string | null; error_code: string | null; created_at: string;
};

function parseArray<T>(json: string): T[] {
  try { const value: unknown = JSON.parse(json); return Array.isArray(value) ? value as T[] : []; } catch { return []; }
}

const paramResultView = (row: ParamResultRow): ReportResult => ({
  runId: "", queryKey: row.query_key, sql: row.sql, sentSql: row.sent_sql, columns: parseArray<ResultColumn>(row.columns_json), rows: parseArray<unknown[]>(row.rows_json),
  rowCount: row.row_count, truncated: row.truncated === 1, rowsRead: row.rows_read, bytesRead: row.bytes_read, chQueryId: row.ch_query_id, ms: row.ms,
  error: row.error, errorCode: row.error_code, createdAt: row.created_at, params: parseParams(row.params_json)
});

/** The queries a set's results come from: those a block reads (an unused query never runs for a set). */
const setQueries = (spec: ReportSpec) => {
  const used = new Set(spec.blocks.flatMap((block) => block.type === "markdown" ? [] : [block.queryKey, ...(block.type === "kpi" ? [block.compareTo?.queryKey, block.sparkline?.queryKey] : [])]).filter((key): key is string => Boolean(key)));
  return spec.queries.filter((query) => used.has(query.key));
};

/** A set's cached results, and the keys whose result is missing or no longer fresh. */
function setResults(report: ReportRow, spec: ReportSpec, hash: string): { results: QueryResultView[]; missing: string[] } {
  const rows = new Map((db.query("SELECT * FROM report_param_results WHERE report_id = ? AND set_hash = ?").all(report.id, hash) as ParamResultRow[]).map((row) => [row.query_key, row]));
  const missing: string[] = [];
  const results = spec.queries.map((query): QueryResultView => {
    const row = rows.get(query.key);
    const fresh = Boolean(row && row.sql === query.sql && (!report.last_run_at || row.created_at >= report.last_run_at));
    if (!fresh && setQueries(spec).some((item) => item.key === query.key)) missing.push(query.key);
    if (!row || row.sql !== query.sql) return { queryKey: query.key, result: null, failed: null, stale: false };
    const view = paramResultView(row);
    return row.error === null ? { queryKey: query.key, result: view, failed: null, stale: !fresh } : { queryKey: query.key, result: null, failed: view, stale: false };
  });
  return { results, missing };
}

export type ParamResultsView = ReportResultsView & { set: ParamSetInfo };

/**
 * GET …/results with parameter values: the default set's stored results (as today), or a non-default
 * set's cached results with the keys a run would fill (`set.missing`). Nothing runs here.
 */
export function paramResults(reportId: string, userId: string, given: Record<string, unknown> | null | undefined): ParamResultsView {
  const report = readableReport(reportId, userId);
  const spec = parseSpec(report.spec_json);
  const set = resolveSet(spec, given);
  const base = reportResults(reportId, userId);
  const info = (missing: string[]): ParamSetInfo => ({ isDefault: set.isDefault, values: set.values, bound: boundRecord(set.bound), missing });
  if (set.isDefault) return { ...base, set: info([]) };
  const cached = setResults(report, spec, set.hash);
  if (cached.results.some((item) => item.result || item.failed)) db.query("UPDATE report_param_sets SET last_used_at = ? WHERE report_id = ? AND set_hash = ?").run(now(), reportId, set.hash);
  return { results: cached.results, running: base.running, set: info(cached.missing) };
}

// ----------------------------------------------------------------------------------- runs

const recent = new Map<string, number[]>();

/** Per person: PARAM_RUNS.perMinute runs a minute (429 BUSY past it). */
function rateLimit(userId: string, nowMs = Date.now()) {
  const kept = (recent.get(userId) ?? []).filter((at) => nowMs - at < 60_000);
  if (kept.length >= PARAM_RUNS.perMinute) {
    recent.set(userId, kept);
    throw new ReportError(429, "BUSY", "Too many filter changes in a minute; wait a moment and try again");
  }
  kept.push(nowMs);
  recent.set(userId, kept);
}

/** Test hook: forget the per-person run counts. */
export const resetParamRateLimit = () => recent.clear();

const UPSERT_RESULT = () => db.query(`INSERT INTO report_param_results (id, report_id, set_hash, query_key, sql, sent_sql, params_json, columns_json, rows_json, row_count, truncated,
  rows_read, bytes_read, ch_query_id, ms, error, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (report_id, set_hash, query_key) DO UPDATE SET id = excluded.id, sql = excluded.sql, sent_sql = excluded.sent_sql, params_json = excluded.params_json,
  columns_json = excluded.columns_json, rows_json = excluded.rows_json, row_count = excluded.row_count, truncated = excluded.truncated, rows_read = excluded.rows_read,
  bytes_read = excluded.bytes_read, ch_query_id = excluded.ch_query_id, ms = excluded.ms, error = excluded.error, error_code = excluded.error_code, created_at = excluded.created_at`);

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function runOne(datasource: DatasourceRow, report: ReportRow, query: ReportQuery, set: ResolvedSet, runId: string, userId: string, controller: AbortController, inFlight: Set<string>): Promise<boolean> {
  const queryId = runQueryId(runId, query.key);
  const started = Date.now();
  inFlight.add(queryId);
  try {
    let outcome: QueryOutcome;
    for (;;) {
      try {
        outcome = await runGuarded(datasource, query.sql, { classes: ["select"], maxRows: Math.min(datasource.max_rows, REPORT_LIMITS.storedRows), queryId, userId, signal: controller.signal, params: set.bound });
        break;
      } catch (error) {
        if (error instanceof ReportError && error.code === "BUSY" && !controller.signal.aborted && Date.now() - started < BUSY_WAIT_MS) { await sleep(250, controller.signal); continue; }
        throw error;
      }
    }
    const capped = capRows(outcome.rows);
    UPSERT_RESULT().run(crypto.randomUUID(), report.id, set.hash, query.key, query.sql, outcome.sentSql, paramsJson(outcome.params), JSON.stringify(outcome.columns).slice(0, 200_000), capped.json, capped.kept,
      outcome.truncated || capped.cut ? 1 : 0, outcome.rowsRead, outcome.bytesRead, outcome.chQueryId.slice(0, 128), outcome.ms, null, null, now());
    return true;
  } catch (error) {
    let code = "CLICKHOUSE";
    let message = "The query failed";
    if (controller.signal.aborted) { code = "CANCELLED"; message = "The run stopped before this query finished"; }
    else {
      try {
        const known = asReportError(error);
        code = known.code === "GUARD" && typeof known.details.guard === "string" ? `GUARD:${known.details.guard}` : known.code;
        message = known.message;
      } catch { message = error instanceof Error ? `The query failed (${error.name})` : message; }
    }
    try {
      UPSERT_RESULT().run(crypto.randomUUID(), report.id, set.hash, query.key, query.sql, null, paramsJson(boundRecord(set.bound)), "[]", "[]", 0, 0, null, null, queryId, Date.now() - started, message.slice(0, 2000), code.slice(0, 40), now());
    } catch { /* the set was pruned meanwhile */ }
    return false;
  } finally {
    inFlight.delete(queryId);
  }
}

/** Keeps the PARAM_RUNS.setsKept most recently used sets of a report and drops those unused for PARAM_RUNS.setDays (their results go too). */
export function pruneParamSets(reportId?: string, nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - PARAM_RUNS.setDays * 86_400_000).toISOString();
  let removed = db.query("DELETE FROM report_param_sets WHERE last_used_at < $cutoff AND ($reportId IS NULL OR report_id = $reportId)").run({ cutoff, reportId: reportId ?? null }).changes;
  const reports = reportId ? [{ report_id: reportId }] : db.query("SELECT report_id FROM report_param_sets GROUP BY report_id HAVING count(*) > ?").all(PARAM_RUNS.setsKept) as Array<{ report_id: string }>;
  for (const { report_id } of reports) {
    removed += db.query(`DELETE FROM report_param_sets WHERE report_id = $reportId AND set_hash NOT IN (
      SELECT set_hash FROM report_param_sets WHERE report_id = $reportId ORDER BY last_used_at DESC, set_hash LIMIT $kept)`).run({ reportId: report_id, kept: PARAM_RUNS.setsKept }).changes;
  }
  return removed;
}

/**
 * Runs a report with a reader's parameter values (POST …/param-runs, MCP): the set's missing queries
 * (or every one with `force`), under the report's run lock, and answers with the set's results. The
 * default set never runs here (it is Refresh all's, the owner's).
 */
export async function runParamSet(userId: string, reportId: string, given: Record<string, unknown> | null | undefined, options: { trigger: RunTrigger; force?: boolean }): Promise<ParamResultsView> {
  const report = readableReport(reportId, userId);
  const spec = parseSpec(report.spec_json);
  const set = resolveSet(spec, given);
  if (set.isDefault) return paramResults(reportId, userId, given);
  await assertOptionValues(report, spec, set.values, userId);
  const cached = setResults(report, spec, set.hash);
  const keys = options.force ? setQueries(spec).map((query) => query.key) : cached.missing;
  if (!keys.length) return paramResults(reportId, userId, given);
  const datasource = usableDatasource(report.datasource_id);
  rateLimit(userId);
  const run = takeRunLock({ reportId, kind: "refresh", trigger: options.trigger, userId, queryKeys: [`~p:${set.hash.slice(0, 12)}`, ...keys] });
  const at = now();
  db.query(`INSERT INTO report_param_sets (report_id, set_hash, values_json, bound_json, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (report_id, set_hash) DO UPDATE SET last_used_at = excluded.last_used_at`).run(reportId, set.hash, canonicalValues(spec.parameters, set.values), JSON.stringify(boundRecord(set.bound)), at, at);
  const controller = new AbortController();
  const inFlight = new Set<string>();
  const heartbeat = setInterval(() => {
    const renewed = db.query("UPDATE report_runs SET lease_until = ? WHERE id = ? AND status = 'running'").run(new Date(Date.now() + LEASE_MS).toISOString(), run.id).changes;
    if (!renewed && !controller.signal.aborted) controller.abort();
  }, HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  controller.signal.addEventListener("abort", () => { for (const queryId of inFlight) void killQuery(datasource, queryId); }, { once: true });
  const queries = spec.queries.filter((query) => keys.includes(query.key));
  let succeeded = 0;
  try {
    await pool(queries, REFRESH_CONCURRENCY, async (query) => {
      if (controller.signal.aborted) return;
      if (await runOne(datasource, report, query, set, run.id, userId, controller, inFlight)) succeeded += 1;
    });
  } finally {
    clearInterval(heartbeat);
    // The lock is released by removing the run: a reader's filter change is not a refresh in Runs.
    db.query("DELETE FROM report_runs WHERE id = ?").run(run.id);
  }
  audit(userId, null, "reports.params.run", { reportId, setHash: set.hash.slice(0, 16), trigger: options.trigger, queries: queries.length, failed: queries.length - succeeded });
  if (plog.enabled("debug")) plog.debug("Parameter set run", { report: reportId.slice(0, 8), set: set.hash.slice(0, 8), queries: queries.length, failed: queries.length - succeeded });
  try { pruneParamSets(reportId); } catch { /* retention is best effort */ }
  return paramResults(reportId, userId, given);
}
