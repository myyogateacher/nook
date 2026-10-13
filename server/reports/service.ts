import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { EMPTY_SPEC, REPORT_LIMITS, type QueryOutcome, type ReportDetail, type ReportSpec, type ReportSummary } from "../../shared/reports";
import { readableReport, readableReportSql, type ReportRow } from "./access";
import { usableDatasource, type DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { adHocQueryId, killQuery, runGuarded } from "./runner";

/**
 * Reports (plan wave 45): list, create a draft (a title and a data source), rename, change the data
 * source, move to the Bin, and the guarded manual SQL console. Generation (wave 46), the viewer,
 * refresh and schedules (wave 47), and instructions (wave 48) build on these rows.
 */

export const REPORTS_PER_USER = 500;

type SummaryRow = ReportRow & { owner_name: string; datasource_name: string | null };

export function parseSpec(json: string): ReportSpec {
  try {
    const value = JSON.parse(json) as ReportSpec;
    return value && value.version === 1 && Array.isArray(value.blocks) && Array.isArray(value.queries) ? value : EMPTY_SPEC;
  } catch {
    return EMPTY_SPEC;
  }
}

function summaryOf(row: SummaryRow, userId: string): ReportSummary {
  return {
    id: row.id, title: row.title, datasourceId: row.datasource_id, datasourceName: row.datasource_name, status: row.status, isOwner: row.owner_id === userId,
    ownerName: row.owner_name, blockCount: parseSpec(row.spec_json).blocks.length, lastRunAt: row.last_run_at, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision
  };
}

const SUMMARY_SELECT = `SELECT r.*, u.display_name AS owner_name, d.name AS datasource_name FROM reports r JOIN users u ON u.id = r.owner_id LEFT JOIN report_datasources d ON d.id = r.datasource_id`;

/** The reports a person can open, newest change first; `q` filters by title (title-only search). */
export function listReports(userId: string, options: { q?: string; ids?: readonly string[] | null; limit?: number } = {}): ReportSummary[] {
  const q = options.q?.trim().toLowerCase().slice(0, 200) ?? "";
  const limit = Math.min(Math.max(1, options.limit ?? REPORTS_PER_USER), REPORTS_PER_USER);
  const rows = db.query(`${SUMMARY_SELECT} WHERE ${readableReportSql("r")} AND ($q = '' OR instr(lower(r.title), $q) > 0)
    AND ($ids IS NULL OR r.id IN (SELECT value FROM json_each($ids))) ORDER BY r.updated_at DESC, r.id LIMIT $limit`)
    .all({ userId, q, ids: options.ids ? JSON.stringify(options.ids) : null, limit }) as SummaryRow[];
  return rows.map((row) => summaryOf(row, userId));
}

export function reportDetail(id: string, userId: string): ReportDetail {
  readableReport(id, userId);
  const row = db.query(`${SUMMARY_SELECT} WHERE r.id = ?`).get(id) as SummaryRow;
  return {
    ...summaryOf(row, userId),
    spec: parseSpec(row.spec_json),
    doc: row.doc_ref || row.doc_server_id ? { serverId: row.doc_server_id, tool: row.doc_tool, ref: row.doc_ref, hash: row.doc_hash } : null,
    lastError: row.last_error
  };
}

export function createReport(userId: string, input: { title: string; datasourceId: string }, via: { keyId?: string } = {}): ReportDetail {
  usableDatasource(input.datasourceId);
  const live = (db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
  if (live >= REPORTS_PER_USER) throw new ReportError(409, "LIMIT_REACHED", `You can have up to ${REPORTS_PER_USER} reports`);
  const id = crypto.randomUUID();
  const at = now();
  db.query("INSERT INTO reports (id, owner_id, title, datasource_id, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.title, input.datasourceId, JSON.stringify(EMPTY_SPEC), at, at);
  audit(userId, null, "reports.report.create", { id, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  return reportDetail(id, userId);
}

export function updateReport(userId: string, id: string, patch: { title?: string; datasourceId?: string; expectedRevision: number }): ReportDetail {
  const row = readableReport(id, userId);
  if (row.revision !== patch.expectedRevision) throw new ReportError(409, "REVISION_CONFLICT", "This report changed; reload it", { revision: row.revision });
  if (patch.datasourceId !== undefined && patch.datasourceId !== row.datasource_id) usableDatasource(patch.datasourceId);
  db.query("UPDATE reports SET title = ?, datasource_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
    .run(patch.title ?? row.title, patch.datasourceId ?? row.datasource_id, now(), id, row.revision);
  audit(userId, null, "reports.report.update", { id, fields: Object.keys(patch).filter((field) => field !== "expectedRevision") });
  return reportDetail(id, userId);
}

/** Moves a report to the Bin for 30 days (server/reports/bin.ts restores and purges it). */
export function binReport(userId: string, id: string) {
  readableReport(id, userId);
  const at = new Date();
  db.query("UPDATE reports SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(at.toISOString(), userId, purgeAfterFrom(at), at.toISOString(), id);
  audit(userId, null, "reports.report.bin", { id });
  return { ok: true as const, purgeAfter: purgeAfterFrom(at) };
}

/** The data source a report uses, for its console and schema browser (409 when it has none or it is off). */
export function reportDatasource(id: string, userId: string): DatasourceRow {
  const report = readableReport(id, userId);
  return usableDatasource(report.datasource_id);
}

/**
 * The manual SQL console (plan wave 45): one guarded statement, select or metadata class, at most the
 * data source's max_rows or 1,000 rows shown. Audited with the query id and the statement's SHA-256,
 * never its text (literals in it may be sensitive; ClickHouse's query log has it).
 */
const consoleRuns = new Map<string, { queryId: string; controller: AbortController; row: DatasourceRow }>();
const consoleKey = (userId: string, reportId: string) => `${userId}:${reportId}`;

export async function runConsole(userId: string, reportId: string, sql: string, signal?: AbortSignal): Promise<QueryOutcome> {
  const row = reportDatasource(reportId, userId);
  const maxRows = Math.min(row.max_rows, REPORT_LIMITS.consoleRows);
  const queryId = adHocQueryId("console");
  const sha256 = createHash("sha256").update(sql).digest("hex");
  // The request's own abort (the browser went away) and Cancel both stop it.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const key = consoleKey(userId, reportId);
  consoleRuns.set(key, { queryId, controller, row });
  try {
    const result = await runGuarded(row, sql, { classes: ["select", "metadata"], maxRows, queryId, userId, signal: controller.signal });
    audit(userId, null, "reports.console.run", { reportId, datasourceId: row.id, class: result.class, queryId, sha256, rows: result.rows.length });
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      audit(userId, null, "reports.console.cancel", { reportId, datasourceId: row.id, queryId, sha256 });
      throw new ReportError(409, "CANCELLED", "The query was cancelled");
    }
    audit(userId, null, "reports.console.refused", { reportId, datasourceId: row.id, queryId, sha256, error: error instanceof Error ? error.name : "Error" });
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (consoleRuns.get(key)?.queryId === queryId) consoleRuns.delete(key);
  }
}

/** Cancel: aborts this person's running console query on the report and sends a best-effort KILL QUERY. */
export async function cancelConsole(userId: string, reportId: string): Promise<{ cancelled: boolean; queryId: string | null }> {
  readableReport(reportId, userId);
  const running = consoleRuns.get(consoleKey(userId, reportId));
  if (!running) return { cancelled: false, queryId: null };
  running.controller.abort();
  await killQuery(running.row, running.queryId);
  return { cancelled: true, queryId: running.queryId };
}

