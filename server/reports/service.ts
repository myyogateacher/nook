import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { EMPTY_SPEC, REPORT_LIMITS, REPORT_PAGE_SIZE, upgradeSpec, type QueryOutcome, type ReportDetail, type ReportListFilter, type ReportListPage, type ReportSpec, type ReportSummary } from "../../shared/reports";
import { ownedReport, ownsReportSql, readableReport, readableReportSql, reportLevelSql, type ReportRow } from "./access";
import { usableDatasource, type DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { liveFolder } from "./folderAccess";
import { adHocQueryId, killQuery, runGuarded } from "./runner";
import { classify, GuardError } from "./sqlGuard";
import { placeholderValue, type BoundParam } from "../../shared/reportParams";
import { logger } from "../log";
import { INSTRUCTION_LIMITS } from "../../shared/reportsEdit";
import { renameNote } from "../../shared/reportVersions";
import { backfillVersion } from "./versionBackfill";
import { nextVersion } from "./versionNumbers";

const slog = logger("reports");

/**
 * Reports (plan wave 45): list, create a draft (a title and a data source), rename, change the data
 * source, move to the Bin, and the guarded manual SQL console. Generation (wave 46), the viewer,
 * refresh and schedules (wave 47), and instructions (wave 48) build on these rows.
 */

export const REPORTS_PER_USER = 500;

type SummaryRow = ReportRow & { owner_name: string; datasource_name: string | null; folder_id: string | null; schedule_cadence: string | null; favorite: number; is_owner: number; level: "owner" | "comment" | "view"; owner_count: number };

/** A stored spec, upgraded to v2 on read (wave 48b, `upgradeSpec`); anything unreadable is the empty spec. */
export function parseSpec(json: string): ReportSpec {
  try {
    return upgradeSpec(JSON.parse(json));
  } catch {
    return EMPTY_SPEC;
  }
}

function summaryOf(row: SummaryRow, userId: string): ReportSummary {
  return {
    id: row.id, title: row.title, datasourceId: row.datasource_id, datasourceName: row.datasource_name, status: row.status, isOwner: row.is_owner === 1,
    ownerName: row.owner_name, blockCount: parseSpec(row.spec_json).blocks.length, lastRunAt: row.last_run_at, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
    // Phase 2 (D483): folders are the workspace's, so every reader sees where a report is filed.
    folderId: row.folder_id ?? null, scheduleCadence: row.schedule_cadence ?? null,
    ownerId: row.owner_id, favorite: row.favorite === 1, level: row.level, ownerCount: row.owner_count
  };
}

/** A live schedule that runs on its own (not `manual`): the list's badge and the Scheduled filter. */
const SCHEDULED_SQL = "(SELECT s.cadence FROM report_schedules s WHERE s.report_id = r.id AND s.enabled = 1 AND s.cadence <> 'manual')";
/** The caller ($userId) starred the report `r` (061). */
export const FAVORITE_SQL = "EXISTS (SELECT 1 FROM report_favorites f WHERE f.user_id = $userId AND f.report_id = r.id)";

const SUMMARY_SELECT = `SELECT r.*, u.display_name AS owner_name, d.name AS datasource_name, ${SCHEDULED_SQL} AS schedule_cadence, ${FAVORITE_SQL} AS favorite,
    ${ownsReportSql("r")} AS is_owner, ${reportLevelSql("r")} AS level, (SELECT COUNT(*) FROM report_owners oc WHERE oc.report_id = r.id) AS owner_count
  FROM reports r JOIN users u ON u.id = r.owner_id LEFT JOIN report_datasources d ON d.id = r.datasource_id`;

export type ReportListOptions = ReportListFilter & { ids?: readonly string[] | null; limit?: number; cursor?: string | null };

/** The opaque cursor of the row after which the next page starts: its `(updated_at, id)`. */
export function encodeCursor(row: { updatedAt: string; id: string }) {
  return Buffer.from(JSON.stringify([row.updatedAt, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" && value[0].length <= 40 && value[1].length <= 64) return { at: value[0], id: value[1] };
  } catch { /* refused below */ }
  throw new ReportError(400, "INVALID", "That list position is not valid; load the list again");
}

/**
 * The SQL of the Reports list (report organization phase 1): the readable set (`readableReportSql`,
 * so a favorite, a filter, or a cursor never reaches a report the caller cannot open, T393) narrowed by
 * each filter in use. Only the clauses in use are written, so SQLite picks the index that fits
 * (reports_owner, reports_status, reports_live_recent, the favorites' primary key).
 */
export function reportListSql(options: ReportListOptions) {
  const where = [readableReportSql("r")];
  const params: Record<string, string | number | null> = {};
  const q = options.q?.trim().toLowerCase().slice(0, 200) ?? "";
  if (q) { where.push("instr(lower(r.title), $q) > 0"); params.q = q; }
  if (options.ids) { where.push("r.id IN (SELECT value FROM json_each($ids))"); params.ids = JSON.stringify(options.ids); }
  // Phase 2 (D482): a person's reports are every report they are one of the owners of.
  if (options.ownerId) { where.push(ownsReportSql("r", "$ownerId")); params.ownerId = options.ownerId; }
  if (options.statuses?.length) { where.push("r.status IN (SELECT value FROM json_each($statuses))"); params.statuses = JSON.stringify(options.statuses); }
  if (options.datasourceId) { where.push("r.datasource_id = $datasourceId"); params.datasourceId = options.datasourceId; }
  if (options.scheduled !== undefined) where.push(`${SCHEDULED_SQL} IS ${options.scheduled ? "NOT NULL" : "NULL"}`);
  if (options.favorites) where.push(FAVORITE_SQL);
  if (options.shared) where.push(`NOT ${ownsReportSql("r")}`);
  // Phase 2 (D483): the shared tree; a folder lists the readable reports filed in it (T391).
  if (options.folderId === "unfiled") where.push("r.folder_id IS NULL");
  else if (options.folderId && options.subtree) {
    where.push(`r.folder_id IN (WITH RECURSIVE sub(id, depth) AS (
      SELECT f.id, 1 FROM report_folders f WHERE f.id = $folderId AND f.deleted_at IS NULL
      UNION SELECT f.id, sub.depth + 1 FROM report_folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at IS NULL AND sub.depth < 8) SELECT id FROM sub)`);
    params.folderId = options.folderId;
  } else if (options.folderId) { where.push("r.folder_id = $folderId"); params.folderId = options.folderId; }
  if (options.cursor) {
    const { at, id } = decodeCursor(options.cursor);
    where.push("(r.updated_at < $cursorAt OR (r.updated_at = $cursorAt AND r.id > $cursorId))");
    params.cursorAt = at;
    params.cursorId = id;
  }
  return { sql: `${SUMMARY_SELECT} WHERE ${where.join("\n  AND ")} ORDER BY r.updated_at DESC, r.id LIMIT $limit`, params };
}

/** One page of the reports a person can open, newest change first, with the filters in use (keyset paged). */
export function listReportsPage(userId: string, options: ReportListOptions = {}): ReportListPage {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? REPORT_PAGE_SIZE)), REPORT_PAGE_SIZE);
  const { sql, params } = reportListSql(options);
  const rows = db.query(sql).all({ ...params, userId, limit: limit + 1 }) as SummaryRow[];
  const more = rows.length > limit;
  const reports = rows.slice(0, limit).map((row) => summaryOf(row, userId));
  return { reports, nextCursor: more ? encodeCursor(reports[reports.length - 1]!) : null };
}

/** The first page of the reports a person can open (at most REPORT_PAGE_SIZE), for callers that need no cursor. */
export function listReports(userId: string, options: ReportListOptions = {}): ReportSummary[] {
  return listReportsPage(userId, options).reports;
}

/**
 * Report organization phase 1 (D486): stars a report for the caller, who must be able to open it (else
 * the same 404 as a missing one). A favorite is never a grant: lists read it through readableReportSql.
 */
export function setFavorite(userId: string, id: string, favorite: boolean, via: { keyId?: string } = {}): { favorite: boolean } {
  const meta = { id, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) };
  if (favorite) {
    readableReport(id, userId);
    const added = db.query("INSERT OR IGNORE INTO report_favorites (user_id, report_id, created_at) VALUES (?, ?, ?)").run(userId, id, now()).changes > 0;
    if (added) audit(userId, null, "reports.report.star", meta);
    return { favorite: true };
  }
  // Unstarring needs no access: it only removes the caller's own row, and says nothing about the report.
  const removed = db.query("DELETE FROM report_favorites WHERE user_id = ? AND report_id = ?").run(userId, id).changes > 0;
  if (removed) audit(userId, null, "reports.report.unstar", meta);
  return { favorite: false };
}

export function reportDetail(id: string, userId: string): ReportDetail {
  readableReport(id, userId);
  const row = db.query(`${SUMMARY_SELECT} WHERE r.id = $id`).get({ id, userId }) as SummaryRow;
  return {
    ...summaryOf(row, userId),
    spec: parseSpec(row.spec_json),
    // Wave 48 (D456): the doc a report came from is the owner's; readers of a shared report never see its link.
    doc: row.is_owner === 1 && (row.doc_ref || row.doc_server_id) ? { serverId: row.doc_source === "nook" ? "nook" : row.doc_server_id, tool: row.doc_tool, ref: row.doc_ref, hash: row.doc_hash } : null,
    lastError: row.last_error,
    canManageOwners: row.is_owner === 1 || (db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | null)?.role === "admin"
  };
}

/** A new draft; `titleSource` says where the title came from (typed by default; generation passes doc or default). */
export function createReport(userId: string, input: { title: string; datasourceId: string; titleSource?: "default" | "doc" | "ai" | "user"; folderId?: string | null }, via: { keyId?: string } = {}): ReportDetail {
  usableDatasource(input.datasourceId);
  // Lane I: "New report" in a folder files it there (phase 2: any live folder of the shared tree, else 404).
  if (input.folderId) liveFolder(input.folderId);
  const live = (db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
  if (live >= REPORTS_PER_USER) throw new ReportError(409, "LIMIT_REACHED", `You can have up to ${REPORTS_PER_USER} reports`);
  const id = crypto.randomUUID();
  const at = now();
  db.query("INSERT INTO reports (id, owner_id, title, title_source, datasource_id, spec_json, created_at, updated_at, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.title, input.titleSource ?? "user", input.datasourceId, JSON.stringify(EMPTY_SPEC), at, at, input.folderId ?? null);
  audit(userId, null, "reports.report.create", { id, ...(input.folderId ? { folderId: input.folderId } : {}), ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  return reportDetail(id, userId);
}

export function updateReport(userId: string, id: string, patch: { title?: string; datasourceId?: string; expectedRevision: number }): ReportDetail {
  const row = ownedReport(id, userId);
  if (row.revision !== patch.expectedRevision) throw new ReportError(409, "REVISION_CONFLICT", "This report changed; reload it", { revision: row.revision });
  if (patch.datasourceId !== undefined && patch.datasourceId !== row.datasource_id) {
    // Review L3: a run in progress reads the data source; it cannot change under it.
    // (Inline, as versions.ts refuseWhileRunning: importing it here would close an import cycle.)
    const holder = db.query("SELECT id FROM report_runs WHERE report_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until > ?)").get(id, now()) as { id: string } | null;
    if (holder) throw new ReportError(409, "RUN_IN_PROGRESS", "This report is running; wait for it to finish", { runId: holder.id });
    usableDatasource(patch.datasourceId);
  }
  // A title the person typed (a rename) is theirs: generation never replaces it (title_source 'user').
  const renamed = patch.title !== undefined && patch.title !== row.title;
  db.transaction(() => {
    db.query(`UPDATE reports SET title = ?, datasource_id = ?, revision = revision + 1, updated_at = ?${renamed ? ", title_source = 'user'" : ""} WHERE id = ? AND revision = ?`)
      .run(patch.title ?? row.title, patch.datasourceId ?? row.datasource_id, now(), id, row.revision);
    if (renamed) recordRename(id, userId, row, patch.title!);
  })();
  audit(userId, null, "reports.report.update", { id, fields: Object.keys(patch).filter((field) => field !== "expectedRevision") });
  return reportDetail(id, userId);
}

/**
 * Lane J: a rename is a version (`manual`, the spec unchanged, the note `Renamed from “A” to “B”`), so
 * Versions shows who renamed the report and when. A report without blocks has no versions yet: none.
 */
function recordRename(id: string, userId: string, row: ReportRow, title: string) {
  const spec = parseSpec(row.spec_json);
  if (!spec.blocks.length) return;
  backfillVersion(id);
  const version = nextVersion(id, spec);
  db.query("INSERT INTO report_versions (report_id, version, spec_json, source, note, created_by, created_at) VALUES (?, ?, ?, 'manual', ?, ?, ?)")
    .run(id, version, row.spec_json, renameNote(row.title, title), userId, now());
  db.query(`DELETE FROM report_versions WHERE report_id = ? AND version NOT IN (
    SELECT version FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT ?)`).run(id, id, INSTRUCTION_LIMITS.versions);
}

const binnedHooks = new Set<(reportId: string) => void>();
/** Wave 48 (review L4): work on a report stops when it is binned (instructions.ts registers the edit and generation stops). */
export function onReportBinned(hook: (reportId: string) => void) {
  binnedHooks.add(hook);
  return () => { binnedHooks.delete(hook); };
}

/** Moves a report to the Bin for 30 days (server/reports/bin.ts restores and purges it). */
export function binReport(userId: string, id: string) {
  ownedReport(id, userId);
  const at = new Date();
  db.query("UPDATE reports SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(at.toISOString(), userId, purgeAfterFrom(at), at.toISOString(), id);
  audit(userId, null, "reports.report.bin", { id });
  for (const hook of binnedHooks) { try { hook(id); } catch (error) { slog.error("Reports: a Bin hook failed", error); } }
  return { ok: true as const, purgeAfter: purgeAfterFrom(at) };
}

/** The data source a report uses, for its console and schema browser (409 when it has none or it is off). */
export function reportDatasource(id: string, userId: string): DatasourceRow {
  // The console and the Schema browser run queries: the owner's (wave 48, D455).
  const report = ownedReport(id, userId);
  return usableDatasource(report.datasource_id);
}

/**
 * The manual SQL console (plan wave 45): one guarded statement, select or metadata class, at most the
 * data source's max_rows or 1,000 rows shown. Audited with the query id and the statement's SHA-256,
 * never its text (literals in it may be sensitive; ClickHouse's query log has it).
 */
const consoleRuns = new Map<string, { queryId: string; controller: AbortController; row: DatasourceRow }>();
const consoleKey = (userId: string, reportId: string) => `${userId}:${reportId}`;

/**
 * D490: the values for a console statement's `{name:Type}` placeholders, checked against each one's type
 * and encoded as report parameters are (shared/reportParams.ts placeholderValue). Every placeholder needs
 * a value; one name written with two types, or a value that does not fit, is refused (400 INVALID).
 * A statement the guard refuses binds nothing here: runGuarded then refuses it with the guard's error.
 */
export function consoleBindings(sql: string, given: Readonly<Record<string, string>>): BoundParam[] {
  let placeholders: Array<{ name: string; type: string }>;
  try { placeholders = classify(sql, { params: true }).placeholders; } catch (error) { if (error instanceof GuardError) return []; throw error; }
  const types = new Map<string, string>();
  for (const placeholder of placeholders) {
    const known = types.get(placeholder.name);
    if (known && known !== placeholder.type) throw new ReportError(400, "INVALID", `{${placeholder.name}} is written with two types (${known} and ${placeholder.type}); use one`, { param: placeholder.name });
    types.set(placeholder.name, placeholder.type);
  }
  const bound: BoundParam[] = [];
  for (const [name, type] of types) {
    const raw = Object.hasOwn(given, name) ? given[name] : undefined;
    if (raw === undefined) throw new ReportError(400, "INVALID", `Enter a value for {${name}:${type}}`, { param: name });
    const value = placeholderValue(type, raw);
    if ("problem" in value) throw new ReportError(400, "INVALID", `{${name}:${type}} ${value.problem}`, { param: name });
    bound.push({ name, type, value: value.value });
  }
  return bound;
}

export async function runConsole(userId: string, reportId: string, sql: string, signal?: AbortSignal, given?: Readonly<Record<string, string>>): Promise<QueryOutcome> {
  const row = reportDatasource(reportId, userId);
  // D490: with values, the statement may hold typed placeholders, bound as param_<name> on the reports' guarded path.
  const params = given ? consoleBindings(sql, given) : undefined;
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
    const result = await runGuarded(row, sql, { classes: ["select", "metadata"], maxRows, queryId, userId, signal: controller.signal, ...(params ? { params } : {}) });
    audit(userId, null, "reports.console.run", { reportId, datasourceId: row.id, class: result.class, queryId, sha256, rows: result.rows.length, ...(params?.length ? { params: params.map((item) => item.name) } : {}) });
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
  ownedReport(reportId, userId);
  const running = consoleRuns.get(consoleKey(userId, reportId));
  if (!running) return { cancelled: false, queryId: null };
  running.controller.abort();
  await killQuery(running.row, running.queryId);
  return { cancelled: true, queryId: running.queryId };
}

