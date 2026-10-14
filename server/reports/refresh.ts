import { audit, db, now } from "../db";
import { REPORT_LIMITS, type ReportQuery, type ReportResult, type ReportRun, type ReportSpec, type ResultColumn, type RunTrigger } from "../../shared/reports";
import type { QueryResultView, ReportResultsView } from "../../shared/reportsView";
import { ownedReport, readableReport, type ReportRow } from "./access";
import { queryIdFor } from "./clickhouse";
import { datasourceRow, usableDatasource, type DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import { killQuery, runGuarded } from "./runner";
import { parseSpec } from "./service";
import { currentLogContext, logger, shortId, withLogContext } from "../log";

const slog = logger("reports");

/**
 * Refresh (plan wave 47): re-run a report's saved queries without the AI. Every query goes
 * through the guard and runner again (EXPLAIN QUERY TREE, the allowlist, the per-query settings), two
 * at a time, and each outcome is a `report_results` row of the run with the SQL as saved, the wrapped
 * SQL as sent, ClickHouse's rows read and query id, timings, and any error.
 *
 * - One run at a time per report: the 050 partial unique index on `report_runs(report_id) WHERE
 *   status = 'running'` is the lock; a second start answers 409 RUN_IN_PROGRESS. Refreshes, wave 46
 *   generation runs, and wave 48 edits all take it. A per-block refresh is a refresh run limited to one
 *   query (`query_keys_json`), under the same lock.
 * - Outcomes: every query succeeded → `succeeded`; some → `partial` (a failed query's block keeps its
 *   last good result, shown stale); none → `failed`.
 * - Leases: a running run holds `lease_until` (60 s), renewed every 20 s while this process works on
 *   it. A run whose lease ran out (the server stopped, or its heartbeat failed) is `abandoned` at boot,
 *   by the scheduler tick, and lazily before a new start; abandoning sends a best-effort KILL QUERY for
 *   the run's query ids, and a run that finds its lease taken stops and kills its own queries.
 * - The last 20 runs per report are kept; older ones go, except a run holding a query's last good
 *   result or named by a block's provenance.
 */

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const REFRESH_CONCURRENCY = 2;
/** How long a query waits for the person's query slots (runner.ts: two per person) before it fails BUSY. */
export const BUSY_WAIT_MS = 120_000;

export type RunRow = {
  id: string; report_id: string; kind: "generate" | "refresh" | "edit"; trigger: RunTrigger; agent_run_id: string | null;
  status: ReportRun["status"]; query_keys_json: string | null; doc_snapshot_id: string | null; lease_until: string | null;
  error: string | null; created_by: string | null; started_at: string; finished_at: string | null;
};

type ResultRow = {
  id: string; run_id: string; report_id: string; query_key: string; sql: string; sent_sql: string | null; columns_json: string; rows_json: string;
  row_count: number; truncated: number; rows_read: number | null; bytes_read: number | null; ch_query_id: string | null; ms: number | null;
  error: string | null; error_code: string | null; created_at: string;
};

function parseKeys(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

export const runView = (row: RunRow): ReportRun => ({
  id: row.id, reportId: row.report_id, kind: row.kind, trigger: row.trigger, status: row.status, agentRunId: row.agent_run_id,
  docSnapshotId: row.doc_snapshot_id, queryKeys: parseKeys(row.query_keys_json), startedAt: row.started_at, finishedAt: row.finished_at, error: row.error
});

function parseJsonArray<T>(json: string): T[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export const resultView = (row: ResultRow): ReportResult => ({
  runId: row.run_id, queryKey: row.query_key, sql: row.sql, sentSql: row.sent_sql, columns: parseJsonArray<ResultColumn>(row.columns_json),
  rows: parseJsonArray<unknown[]>(row.rows_json), rowCount: row.row_count, truncated: row.truncated === 1, rowsRead: row.rows_read, bytesRead: row.bytes_read,
  chQueryId: row.ch_query_id, ms: row.ms, error: row.error, errorCode: row.error_code, createdAt: row.created_at
});

/** The query id a run's query carries: `nook-<run>-<key>` (the inspect panel shows it; KILL QUERY names it). */
export const runQueryId = (runId: string, key: string) => queryIdFor(runId.replace(/-/g, "").slice(0, 16), key);

export const runRow = (id: string) => db.query("SELECT * FROM report_runs WHERE id = ?").get(id) as RunRow | null;
export const runningRun = (reportId: string) => db.query("SELECT * FROM report_runs WHERE report_id = ? AND status = 'running'").get(reportId) as RunRow | null;

// ----------------------------------------------------------------------------------- results view

const LATEST_GOOD = () => db.query("SELECT * FROM report_results WHERE report_id = ? AND query_key = ? AND error IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1");
const LATEST_ANY = () => db.query("SELECT * FROM report_results WHERE report_id = ? AND query_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");

/**
 * What each saved query shows now: its last good result, and its newest attempt when that failed. A
 * last good result whose SQL is no longer the saved SQL is stale too (the query changed since).
 */
export function queryResults(reportId: string, spec: ReportSpec): QueryResultView[] {
  return spec.queries.map((query) => {
    const good = LATEST_GOOD().get(reportId, query.key) as ResultRow | null;
    const latest = LATEST_ANY().get(reportId, query.key) as ResultRow | null;
    const failed = latest && latest.error !== null ? resultView(latest) : null;
    const result = good ? resultView(good) : null;
    return { queryKey: query.key, result, failed, stale: Boolean(result && (failed || result.sql !== query.sql)) };
  });
}

export function reportResults(reportId: string, userId: string): ReportResultsView {
  const report = readableReport(reportId, userId);
  abandonExpiredReportRuns(Date.now(), reportId);
  const running = runningRun(reportId);
  return { results: queryResults(reportId, parseSpec(report.spec_json)), running: running ? runView(running) : null };
}

// ------------------------------------------------------------------------------- abandoned runs

/** Best-effort KILL QUERY for every query id a run may have in flight (and their tree checks). */
async function killRunQueries(datasourceId: string | null, runId: string, keys: readonly string[]) {
  if (!datasourceId || !keys.length) return;
  let row: DatasourceRow;
  try { row = datasourceRow(datasourceId); } catch { return; }
  await Promise.all(keys.map((key) => killQuery(row, runQueryId(runId, key))));
}

const abandonHooks = new Set<(runId: string, kind: RunRow["kind"]) => void>();
/** Other run kinds (generation) stop their in-process copy when the sweep abandons their run. */
export function onRunAbandoned(hook: (runId: string, kind: RunRow["kind"]) => void) {
  abandonHooks.add(hook);
  return () => { abandonHooks.delete(hook); };
}

/** A running row without a lease (a run kind that never set one) is abandoned this long after it started. */
export const NO_LEASE_GRACE_MS = 15 * 60_000;

/**
 * Runs whose lease ran out become `abandoned` (every scheduler tick, and lazily before a report's
 * results are read or a run starts), as do running rows that never had a lease once they are
 * NO_LEASE_GRACE_MS old. `all` (boot only: the server is one process, so nothing it ran before
 * survives a restart) abandons every running row. Their queries get a best-effort KILL QUERY.
 */
export function abandonExpiredReportRuns(nowMs = Date.now(), reportId?: string, options: { all?: boolean } = {}): number {
  const at = new Date(nowMs).toISOString();
  const graceStart = new Date(nowMs - NO_LEASE_GRACE_MS).toISOString();
  const expired = db.query(`SELECT r.*, p.datasource_id, p.spec_json FROM report_runs r JOIN reports p ON p.id = r.report_id
    WHERE r.status = 'running' AND ($all = 1 OR (r.lease_until IS NOT NULL AND r.lease_until <= $at) OR (r.lease_until IS NULL AND r.started_at <= $graceStart))
      AND ($reportId IS NULL OR r.report_id = $reportId)`)
    .all({ at, graceStart, all: options.all ? 1 : 0, reportId: reportId ?? null }) as Array<RunRow & { datasource_id: string | null; spec_json: string }>;
  let count = 0;
  for (const run of expired) {
    const reason = options.all ? "The server restarted before the run finished" : "The run stopped before it finished; its lease ran out";
    const changed = db.query("UPDATE report_runs SET status = 'abandoned', finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(at, reason, run.id).changes;
    if (!changed) continue;
    count += 1;
    // The process holding it (if any) stops at its next heartbeat; this one aborts its own copy now.
    active.get(run.id)?.controller.abort();
    for (const hook of abandonHooks) { try { hook(run.id, run.kind); } catch { /* best effort */ } }
    const keys = parseKeys(run.query_keys_json) ?? parseSpec(run.spec_json).queries.map((query) => query.key);
    void killRunQueries(run.datasource_id, run.id, keys);
    audit(run.created_by, null, "reports.run.abandoned", { reportId: run.report_id, runId: run.id, kind: run.kind });
  }
  return count;
}

// ------------------------------------------------------------------------------------- running

type ActiveRun = { controller: AbortController; datasource: DatasourceRow; inFlight: Set<string> };
const active = new Map<string, ActiveRun>();

/** Test hook: runs this process is working on. */
export const activeRefreshes = () => active.size;

const isRunLock = (error: unknown) => error instanceof Error && /UNIQUE constraint failed: (report_runs\.report_id|index 'report_runs_one_running')/.test(error.message);

/** Takes the report's one-run lock: a `running` row, or 409 RUN_IN_PROGRESS naming the run that holds it. */
export function takeRunLock(input: { reportId: string; kind: RunRow["kind"]; trigger: RunTrigger; userId: string | null; queryKeys: string[] | null; nowMs?: number }): RunRow {
  const nowMs = input.nowMs ?? Date.now();
  abandonExpiredReportRuns(nowMs, input.reportId);
  const id = crypto.randomUUID();
  try {
    db.query(`INSERT INTO report_runs (id, report_id, kind, trigger, status, query_keys_json, lease_until, created_by, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(id, input.reportId, input.kind, input.trigger, input.queryKeys ? JSON.stringify(input.queryKeys) : null, new Date(nowMs + LEASE_MS).toISOString(), input.userId, new Date(nowMs).toISOString());
  } catch (error) {
    if (!isRunLock(error)) throw error;
    const holder = runningRun(input.reportId);
    throw new ReportError(409, "RUN_IN_PROGRESS", "This report is already running; wait for it to finish", holder ? { runId: holder.id } : {});
  }
  return runRow(id)!;
}

/** Stored rows: at most REPORT_LIMITS.storedRows and storedResultBytes of JSON; anything past is `truncated`. */
export function capRows(rows: unknown[][]): { json: string; kept: number; cut: boolean } {
  const limited = rows.slice(0, REPORT_LIMITS.storedRows);
  let json = JSON.stringify(limited);
  if (json.length <= REPORT_LIMITS.storedResultBytes) return { json, kept: limited.length, cut: limited.length < rows.length };
  let size = 2;
  let kept = 0;
  for (const row of limited) {
    const next = JSON.stringify(row).length + (kept ? 1 : 0);
    if (size + next > REPORT_LIMITS.storedResultBytes) break;
    size += next;
    kept += 1;
  }
  json = JSON.stringify(limited.slice(0, kept));
  return { json, kept, cut: true };
}

const INSERT_RESULT = () => db.query(`INSERT INTO report_results (id, run_id, report_id, query_key, sql, sent_sql, columns_json, rows_json, row_count, truncated,
  rows_read, bytes_read, ch_query_id, ms, error, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Runs one saved query and stores its result row; true when it succeeded. */
async function runQuery(run: RunRow, report: ReportRow, query: ReportQuery, userId: string, state: ActiveRun): Promise<boolean> {
  const queryId = runQueryId(run.id, query.key);
  const maxRows = Math.min(state.datasource.max_rows, REPORT_LIMITS.storedRows);
  const started = Date.now();
  state.inFlight.add(queryId);
  try {
    let outcome;
    for (;;) {
      try {
        outcome = await runGuarded(state.datasource, query.sql, { classes: ["select"], maxRows, queryId, userId, signal: state.controller.signal });
        break;
      } catch (error) {
        // The person's two query slots are busy (their console, another report): wait for one.
        if (error instanceof ReportError && error.code === "BUSY" && !state.controller.signal.aborted && Date.now() - started < BUSY_WAIT_MS) {
          await sleep(250, state.controller.signal);
          continue;
        }
        throw error;
      }
    }
    const capped = capRows(outcome.rows);
    INSERT_RESULT().run(crypto.randomUUID(), run.id, report.id, query.key, query.sql, outcome.sentSql, JSON.stringify(outcome.columns).slice(0, 200_000), capped.json, capped.kept,
      outcome.truncated || capped.cut ? 1 : 0, outcome.rowsRead, outcome.bytesRead, outcome.chQueryId.slice(0, 128), outcome.ms, null, null, now());
    return true;
  } catch (error) {
    let code = "CLICKHOUSE";
    let message = "The query failed";
    if (state.controller.signal.aborted) {
      code = "CANCELLED";
      message = "The run stopped before this query finished";
    } else {
      try {
        const known = asReportError(error);
        code = known.code === "GUARD" && typeof known.details.guard === "string" ? `GUARD:${known.details.guard}` : known.code;
        message = known.message;
      } catch {
        message = error instanceof Error ? `The query failed (${error.name})` : message;
      }
    }
    try {
      INSERT_RESULT().run(crypto.randomUUID(), run.id, report.id, query.key, query.sql, null, "[]", "[]", 0, 0, null, null, queryId, Date.now() - started, message.slice(0, 2000), code.slice(0, 40), now());
    } catch { /* the run was purged meanwhile */ }
    return false;
  } finally {
    state.inFlight.delete(queryId);
  }
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/** The report's status from what its queries show: every one good → ready, some → stale, none → error. */
function settleReportStatus(reportId: string, spec: ReportSpec, finishedAt: string, error: string | null) {
  const views = queryResults(reportId, spec);
  if (!views.length) return;
  const good = views.filter((view) => view.result && !view.stale).length;
  const status = good === views.length ? "ready" : views.some((view) => view.result) ? "stale" : "error";
  db.query("UPDATE reports SET status = ?, last_run_at = ?, last_error = ? WHERE id = ?").run(status, finishedAt, error?.slice(0, 1000) ?? null, reportId);
}

/** Keeps the last REPORT_LIMITS.runsKept runs, plus runs holding a query's last good result or named by a block's provenance. */
export function pruneRuns(reportId: string, spec: ReportSpec) {
  const pinned = new Set<string>();
  for (const block of spec.blocks) if (block.provenance?.runId) pinned.add(block.provenance.runId);
  const good = db.query(`SELECT run_id FROM report_results rr WHERE report_id = $reportId AND error IS NULL AND created_at = (
    SELECT max(created_at) FROM report_results WHERE report_id = $reportId AND query_key = rr.query_key AND error IS NULL)`).all({ reportId }) as Array<{ run_id: string }>;
  for (const row of good) pinned.add(row.run_id);
  // And each query's newest result of any kind: pruning a newer failure would clear its block's stale badge.
  const newest = db.query(`SELECT run_id FROM report_results rr WHERE report_id = $reportId AND created_at = (
    SELECT max(created_at) FROM report_results WHERE report_id = $reportId AND query_key = rr.query_key)`).all({ reportId }) as Array<{ run_id: string }>;
  for (const row of newest) pinned.add(row.run_id);
  const old = db.query("SELECT id FROM report_runs WHERE report_id = ? AND status <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?")
    .all(reportId, REPORT_LIMITS.runsKept) as Array<{ id: string }>;
  const remove = old.map((row) => row.id).filter((id) => !pinned.has(id));
  for (const id of remove) db.query("DELETE FROM report_runs WHERE id = ?").run(id);
  return remove.length;
}

async function execute(run: RunRow, report: ReportRow, spec: ReportSpec, queries: ReportQuery[], userId: string, state: ActiveRun): Promise<ReportRun> {
  const heartbeat = setInterval(() => {
    const renewed = db.query("UPDATE report_runs SET lease_until = ? WHERE id = ? AND status = 'running'").run(new Date(Date.now() + LEASE_MS).toISOString(), run.id).changes;
    if (!renewed && !state.controller.signal.aborted) state.controller.abort();
  }, HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  const onAbort = () => {
    // The lease was lost (or the run was abandoned): stop what ClickHouse is still doing for it.
    for (const queryId of state.inFlight) void killQuery(state.datasource, queryId);
  };
  state.controller.signal.addEventListener("abort", onAbort, { once: true });
  let succeeded = 0;
  try {
    await pool(queries, REFRESH_CONCURRENCY, async (query) => {
      if (state.controller.signal.aborted) return;
      if (await runQuery(run, report, query, userId, state)) succeeded += 1;
    });
  } finally {
    clearInterval(heartbeat);
    active.delete(run.id);
  }
  const failed = queries.length - succeeded;
  const status = failed === 0 ? "succeeded" : succeeded === 0 ? "failed" : "partial";
  const error = failed === 0 ? null : `${failed} of ${queries.length} ${queries.length === 1 ? "query" : "queries"} failed`;
  const finishedAt = now();
  const changed = db.query("UPDATE report_runs SET status = ?, finished_at = ?, error = ?, lease_until = NULL WHERE id = ? AND status = 'running'").run(status, finishedAt, error, run.id).changes;
  if (changed) {
    settleReportStatus(report.id, spec, finishedAt, error);
    audit(userId, null, "reports.refresh.finish", { reportId: report.id, runId: run.id, trigger: run.trigger, status, queries: queries.length, failed });
  }
  try { pruneRuns(report.id, spec); } catch { /* retention is best effort */ }
  return runView(runRow(run.id) ?? { ...run, status: "abandoned" });
}

export type RefreshStart = { run: ReportRun; done: Promise<ReportRun> };

/**
 * Starts a refresh of every saved query, or of one (`queryKey`: a block's "Re-run this query"). The
 * caller must own the report (the scheduler passes the owner, checked again at run time). Answers at
 * once with the running run; `done` settles when it finishes (it never rejects).
 */
export function startRefresh(userId: string, reportId: string, options: { trigger: RunTrigger; queryKey?: string | null; nowMs?: number }): RefreshStart {
  // Owner only (wave 48 sharing, D455): readers of a shared report see its results, never start runs.
  const report = ownedReport(reportId, userId);
  const datasource = usableDatasource(report.datasource_id);
  // A run in progress answers first: a report's first generation holds the lock before it has queries.
  abandonExpiredReportRuns(options.nowMs ?? Date.now(), reportId);
  const holder = runningRun(reportId);
  if (holder) throw new ReportError(409, "RUN_IN_PROGRESS", "This report is already running; wait for it to finish", { runId: holder.id });
  const spec = parseSpec(report.spec_json);
  if (!spec.queries.length) throw new ReportError(409, "INVALID", "This report has no saved queries to refresh yet");
  const queries = options.queryKey ? spec.queries.filter((query) => query.key === options.queryKey) : spec.queries;
  if (!queries.length) throw new ReportError(404, "NOT_FOUND", "This report has no query with that key");
  const run = takeRunLock({ reportId, kind: "refresh", trigger: options.trigger, userId, queryKeys: options.queryKey ? [options.queryKey] : null, nowMs: options.nowMs });
  audit(userId, null, "reports.refresh.start", { reportId, runId: run.id, trigger: options.trigger, queryKey: options.queryKey ?? null });
  const state: ActiveRun = { controller: new AbortController(), datasource, inFlight: new Set() };
  active.set(run.id, state);
  const done = withLogContext({ ...currentLogContext(), run: shortId(run.id), report: shortId(reportId) }, () => execute(run, report, spec, queries, userId, state)).catch((error: unknown) => {
    slog.error("Report refresh failed", error);
    db.query("UPDATE report_runs SET status = 'failed', finished_at = ?, error = 'The refresh stopped on an internal error', lease_until = NULL WHERE id = ? AND status = 'running'").run(now(), run.id);
    active.delete(run.id);
    return runView(runRow(run.id) ?? run);
  });
  return { run: runView(run), done };
}

/** A run of a report the person can read (the Runs list, the refresh poll, Provenance). */
export function reportRun(reportId: string, runId: string, userId: string): ReportRun {
  readableReport(reportId, userId);
  abandonExpiredReportRuns(Date.now(), reportId);
  const row = db.query("SELECT * FROM report_runs WHERE id = ? AND report_id = ?").get(runId, reportId) as RunRow | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Run not found");
  return runView(row);
}

export function listRuns(reportId: string, userId: string): ReportRun[] {
  readableReport(reportId, userId);
  abandonExpiredReportRuns(Date.now(), reportId);
  return (db.query("SELECT * FROM report_runs WHERE report_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(reportId, REPORT_LIMITS.runsKept) as RunRow[]).map(runView);
}

/** Boot: every run left `running` by the stopped server is abandoned, lease or not (and its queries killed). */
export function abandonRunsAtBoot(nowMs = Date.now()) {
  try {
    const count = abandonExpiredReportRuns(nowMs, undefined, { all: true });
    if (count) slog.info(`Report runs: ${count} abandoned at boot`);
    return count;
  } catch (error) {
    slog.error("Report run boot check failed", error);
    return 0;
  }
}
