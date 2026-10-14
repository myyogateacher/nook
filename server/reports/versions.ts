import { audit, db, now } from "../db";
import type { ReportSpec, ResultColumn } from "../../shared/reports";
import { INSTRUCTION_LIMITS, type VersionSource } from "../../shared/reportsEdit";
import { diffSpecVersions, parseRenameNote, type VersionDiff, type VersionHistoryItem, type VersionSnapshot } from "../../shared/reportVersions";
import type { QueryResultView } from "../../shared/reportsView";
import { logger, shortId } from "../log";
import { ownedReport, readableReport } from "./access";
import { ReportError } from "./errors";
import { capRows, resultView, runningRun, runResults, startPreview, startRefresh, abandonExpiredReportRuns } from "./refresh";
import { parseSpec } from "./service";
import { usableDatasource } from "./datasources";
import { assertRunnableNow } from "./specCheck";
import { backfillVersion } from "./versionBackfill";
import { nextVersion } from "./versionNumbers";

/**
 * Spec versions (plan wave 48, D452): every spec a report has had is a `report_versions` row, numbered
 * per report. Apply, restore, and manual edits write their row here, in the same transaction that
 * changes `reports.spec_json`; a generation's is written by persistGenerated in its own save
 * (review M2). Specs saved before wave 48 are recorded by the idempotent backfill (versionBackfill.ts:
 * at boot, and inside each write). Restoring a version re-checks it against the data source as it is
 * now, makes a new version with that spec (nothing is rewritten), and re-runs every restored query.
 * At most 100 versions are kept per report.
 */

/** A query result to save with a spec (a validated run's outcome, or a proposal's stored copy). */
export type SavedOutcome = {
  columns: ResultColumn[]; rows: unknown[][]; truncated: boolean; sentSql: string | null; chQueryId: string | null;
  rowsRead: number | null; bytesRead: number | null; ms: number | null;
};

type VersionRow = { report_id: string; version: number; spec_json: string; source: VersionSource; instruction_id: string | null; restored_from: number | null; run_id: string | null; note: string | null; created_by: string | null; created_at: string; author: string | null };

const slog = logger("reports");

export { maxProvenanceVersion, nextVersion } from "./versionNumbers";

export function pruneVersions(reportId: string) {
  db.query(`DELETE FROM report_versions WHERE report_id = ? AND version NOT IN (
    SELECT version FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT ?)`).run(reportId, reportId, INSTRUCTION_LIMITS.versions);
}

const INSERT_RESULT = () => db.query(`INSERT INTO report_results (id, run_id, report_id, query_key, sql, sent_sql, columns_json, rows_json, row_count, truncated,
  rows_read, bytes_read, ch_query_id, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export type Commit = {
  reportId: string;
  userId: string;
  spec: ReportSpec;
  source: Exclude<VersionSource, "initial" | "generate">;
  /** The revision the change was made against; another one answers 409 REVISION_CONFLICT. */
  expectedRevision?: number;
  instructionId?: string | null;
  restoredFrom?: number | null;
  /** Blocks whose provenance is stamped with the new version (added or changed ones). */
  stamp?: ReadonlySet<string>;
  /** The run the change came from (provenance and the results' run). */
  runId?: string | null;
  docSnapshotId?: string | null;
  /** Results to save for the run (added or changed queries). */
  results?: ReadonlyMap<string, SavedOutcome>;
  note?: string | null;
};

/**
 * Saves a new spec as a new version in one transaction: the current spec recorded first if no version
 * holds it, then the touched blocks' provenance, the report's queries (replaced), the given results under
 * the run, and the spec itself (revision + 1). The report must be live and not mid-run.
 */
export function commitSpec(input: Commit): { version: number; spec: ReportSpec; revision: number } {
  return db.transaction(() => {
    const report = db.query("SELECT spec_json, revision, status FROM reports WHERE id = ? AND deleted_at IS NULL").get(input.reportId) as { spec_json: string; revision: number; status: string } | null;
    if (!report) throw new ReportError(404, "NOT_FOUND", "Report not found");
    if (input.expectedRevision !== undefined && report.revision !== input.expectedRevision) throw new ReportError(409, "REVISION_CONFLICT", "This report changed since; reload it", { revision: report.revision });
    backfillVersion(input.reportId);
    const version = nextVersion(input.reportId, parseSpec(report.spec_json));
    const at = now();
    // E6: a block an agent run wrote carries the model that ran it (the fallback when it took over).
    const model = input.runId ? (db.query("SELECT a.model FROM report_runs r JOIN agent_runs a ON a.id = r.agent_run_id WHERE r.id = ?").get(input.runId) as { model: string } | null)?.model ?? null : null;
    const provenance = { runId: input.runId ?? null, instructionId: input.instructionId ?? null, version, docSnapshotId: input.docSnapshotId ?? null, ...(model ? { model } : {}) };
    const spec: ReportSpec = {
      ...input.spec,
      version: 1,
      specVersion: 2,
      sections: input.spec.sections ?? [],
      blocks: input.spec.blocks.map((block) => input.stamp?.has(block.id) ? { ...block, provenance } : block)
    };
    const specJson = JSON.stringify(spec);
    if (specJson.length > 524_288) throw new ReportError(413, "TOO_LARGE", "The spec is larger than 512 KiB");

    // The results first: a query keeps the columns of its newest result.
    if (input.results?.size) {
      if (!input.runId) throw new Error("results need a run");
      for (const [key, outcome] of input.results) {
        const query = spec.queries.find((item) => item.key === key);
        if (!query) continue;
        const rows = capRows(outcome.rows);
        db.query("DELETE FROM report_results WHERE run_id = ? AND query_key = ?").run(input.runId, key);
        INSERT_RESULT().run(crypto.randomUUID(), input.runId, input.reportId, key, query.sql, outcome.sentSql, JSON.stringify(outcome.columns).slice(0, 200_000), rows.json, rows.kept,
          outcome.truncated || rows.cut ? 1 : 0, outcome.rowsRead, outcome.bytesRead, outcome.chQueryId?.slice(0, 128) ?? null, outcome.ms, at);
      }
    }
    const columnsOf = new Map((db.query("SELECT key, columns_json FROM report_queries WHERE report_id = ?").all(input.reportId) as Array<{ key: string; columns_json: string }>).map((row) => [row.key, row.columns_json]));
    db.query("DELETE FROM report_queries WHERE report_id = ?").run(input.reportId);
    const insertQuery = db.query("INSERT INTO report_queries (id, report_id, key, sql, purpose, columns_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const query of spec.queries) {
      const fresh = input.results?.get(query.key);
      insertQuery.run(crypto.randomUUID(), input.reportId, query.key, query.sql, query.purpose, fresh ? JSON.stringify(fresh.columns) : columnsOf.get(query.key) ?? "[]", query.createdBy, at, at);
    }
    db.query(`INSERT INTO report_versions (report_id, version, spec_json, source, instruction_id, restored_from, run_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.reportId, version, specJson, input.source, input.instructionId ?? null, input.restoredFrom ?? null, input.runId ?? null, input.note?.slice(0, 300) ?? null, input.userId, at);
    const status = report.status === "draft" || report.status === "error" ? (spec.blocks.length ? "ready" : report.status) : report.status;
    db.query("UPDATE reports SET spec_json = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(specJson, status, at, input.reportId);
    pruneVersions(input.reportId);
    return { version, spec, revision: report.revision + 1 };
  })();
}

type HistoryRow = VersionRow & { instruction_text: string | null; instruction_author: string | null; asked_by: string | null; auto_applied: number | null; model: string | null };
type StoredResult = Parameters<typeof resultView>[0];

const VERSION_SELECT = `SELECT v.*, u.display_name AS author, i.text AS instruction_text, i.author_id AS instruction_author, ia.display_name AS asked_by, i.auto_applied, ar.model
  FROM report_versions v
  LEFT JOIN users u ON u.id = v.created_by
  LEFT JOIN report_instructions i ON i.id = v.instruction_id
  LEFT JOIN users ia ON ia.id = i.author_id
  LEFT JOIN report_runs rr ON rr.id = v.run_id
  LEFT JOIN agent_runs ar ON ar.id = rr.agent_run_id`;

const sizeLine = (spec: ReportSpec) => spec.blocks.length
  ? `${spec.blocks.length} ${spec.blocks.length === 1 ? "block" : "blocks"}, ${spec.queries.length} ${spec.queries.length === 1 ? "query" : "queries"}`
  : "Empty";

/**
 * One row as the caller may see it (lane J, D459). The owner sees everything. Anyone else (a commenter
 * or a viewer) sees who, when, and the source only: no note (the agent's summary may quote the doc), no
 * instruction text but their own, no run or model (runs are the owner's), and no change summary.
 */
function historyItem(row: HistoryRow, spec: ReportSpec, context: { currentJson: string; latest: number; owner: boolean; userId: string; regenerated: boolean; changeSummary: string | null }): VersionHistoryItem {
  const { owner } = context;
  const mine = row.instruction_author !== null && row.instruction_author === context.userId;
  // Only a rename's note is ours (Nook wrote it, never the agent): its new title is everyone's.
  const rename = row.source === "manual" ? parseRenameNote(row.note) : null;
  return {
    version: row.version, source: row.source, instructionId: row.instruction_id, restoredFrom: row.restored_from,
    // Review L5: the note is the edit agent's summary, which may quote the doc: the owner's only.
    note: owner ? row.note : null, createdByName: row.author,
    createdAt: row.created_at, blocks: spec.blocks.length, queries: spec.queries.length, current: row.version === context.latest && row.spec_json === context.currentJson,
    regenerated: context.regenerated,
    askedByName: row.instruction_id ? row.asked_by : null,
    autoApplied: row.auto_applied === 1,
    instructionText: owner || mine ? row.instruction_text : null,
    runId: owner ? row.run_id : null,
    model: owner ? row.model : null,
    changeSummary: owner ? (rename ? `Title “${rename.before}” → “${rename.after}”` : context.changeSummary) : null,
    renamedTo: rename?.after ?? null
  };
}

/** A `generate` version after any earlier one with blocks (or after pruned ones) is a regeneration. */
const isRegenerated = (source: VersionSource, version: number, earlierWithBlocks: boolean, earlierKept: boolean) =>
  source === "generate" && (earlierWithBlocks || (!earlierKept && version > 1));

/** The report's versions, newest first (anyone who can read the report; redacted for all but the owner). */
export function listVersions(reportId: string, userId: string): VersionHistoryItem[] {
  const report = readableReport(reportId, userId);
  const owner = report.owner_id === userId;
  const rows = db.query(`${VERSION_SELECT} WHERE v.report_id = ? ORDER BY v.version ASC`).all(reportId) as HistoryRow[];
  const latest = rows.at(-1)?.version ?? 0;
  let previous: { version: number; spec: ReportSpec } | null = null;
  let withBlocks = false;
  const items: VersionHistoryItem[] = [];
  for (const row of rows) {
    const spec = parseSpec(row.spec_json);
    const changeSummary = !owner ? null : previous ? diffSpecVersions(previous.spec, spec, { from: previous.version, to: row.version, withText: false }).summary : sizeLine(spec);
    items.push(historyItem(row, spec, { currentJson: report.spec_json, latest, owner, userId, regenerated: isRegenerated(row.source, row.version, withBlocks, previous !== null), changeSummary }));
    previous = { version: row.version, spec };
    withBlocks ||= spec.blocks.length > 0;
  }
  return items.reverse();
}

function versionRow(reportId: string, version: number): HistoryRow {
  const row = db.query(`${VERSION_SELECT} WHERE v.report_id = ? AND v.version = ?`).get(reportId, version) as HistoryRow | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Version not found");
  return row;
}

const RESULT_AT = () => db.query(`SELECT * FROM report_results WHERE report_id = $reportId AND query_key = $key AND sql = $sql AND error IS NULL
  AND ($until IS NULL OR created_at < $until) ORDER BY created_at DESC, rowid DESC LIMIT 1`);

/**
 * One version for the read-only view: the owner's only (an older spec holds older SQL and text). Its
 * results are the stored ones of exactly its SQL, the newest from while it was current (or before); a
 * query with none shows "not stored". Nothing is run.
 */
export function getVersion(reportId: string, version: number, userId: string): VersionSnapshot {
  const report = ownedReport(reportId, userId);
  const row = versionRow(reportId, version);
  const spec = parseSpec(row.spec_json);
  const next = db.query("SELECT created_at FROM report_versions WHERE report_id = ? AND version > ? ORDER BY version LIMIT 1").get(reportId, version) as { created_at: string } | null;
  const latest = (db.query("SELECT max(version) AS version FROM report_versions WHERE report_id = ?").get(reportId) as { version: number }).version;
  const earlier = db.query("SELECT version, spec_json FROM report_versions WHERE report_id = ? AND version < ? ORDER BY version DESC").all(reportId, version) as Array<{ version: number; spec_json: string }>;
  const before = earlier[0] ? parseSpec(earlier[0].spec_json) : null;
  const changeSummary = before ? diffSpecVersions(before, spec, { from: earlier[0]!.version, to: version, withText: false }).summary : sizeLine(spec);
  const regenerated = isRegenerated(row.source, version, earlier.some((item) => parseSpec(item.spec_json).blocks.length > 0), earlier.length > 0);
  const results: QueryResultView[] = spec.queries.map((query) => {
    const stored = RESULT_AT().get({ reportId, key: query.key, sql: query.sql, until: next?.created_at ?? null }) as StoredResult | null;
    return { queryKey: query.key, result: stored ? resultView(stored) : null, failed: null, stale: false };
  });
  slog.info("Report version read", { report: shortId(reportId), version, stored: results.filter((item) => item.result).length, queries: results.length });
  return { version: historyItem(row, spec, { currentJson: report.spec_json, latest, owner: true, userId, regenerated, changeSummary }), spec, results };
}

/** What changed from version `from` to `to`: the owner's only, computed here and capped (DIFF_LIMITS). */
export function versionDiff(reportId: string, from: number, to: number, userId: string): VersionDiff {
  ownedReport(reportId, userId);
  const started = performance.now();
  const before = parseSpec(versionRow(reportId, from).spec_json);
  const after = parseSpec(versionRow(reportId, to).spec_json);
  const diff = diffSpecVersions(before, after, { from, to });
  // Renames between the two (either way round): the title the older one had, and the newer one's.
  const [low, high] = from < to ? [from, to] : [to, from];
  const renames = (db.query("SELECT note FROM report_versions WHERE report_id = ? AND version > ? AND version <= ? AND source = 'manual' ORDER BY version").all(reportId, low, high) as Array<{ note: string | null }>)
    .map((row) => parseRenameNote(row.note)).filter((item): item is { before: string; after: string } => item !== null);
  if (renames.length) {
    const oldest = renames[0]!.before;
    const newest = renames.at(-1)!.after;
    if (oldest !== newest) {
      diff.title = from < to ? { field: "title", before: oldest, after: newest } : { field: "title", before: newest, after: oldest };
      diff.summary = diff.summary === "No changes" ? "report title changed" : `report title changed, ${diff.summary}`;
    }
  }
  slog.info("Report version diff", { report: shortId(reportId), from, to, blocks: diff.blocks.length, queries: diff.queries.length, truncated: diff.truncated, ms: Math.round(performance.now() - started) });
  return diff;
}

/**
 * "Run with today's data" (the owner, lane J): the version's queries once, through the guarded runner,
 * after the same check as a restore (on, its shape, today's allowlist; 409 STALE_VERSION). A run in Runs;
 * the report itself is unchanged. Answers when the run ends, with the version's results from it.
 */
export async function previewVersion(userId: string, reportId: string, version: number, via: { keyId?: string } = {}): Promise<{ runId: string; status: string; results: QueryResultView[] }> {
  const report = ownedReport(reportId, userId);
  const row = db.query("SELECT spec_json FROM report_versions WHERE report_id = ? AND version = ?").get(reportId, version) as { spec_json: string } | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Version not found");
  const spec = parseSpec(row.spec_json);
  assertRunnableNow(usableDatasource(report.datasource_id), spec, "STALE_VERSION");
  const started = startPreview(userId, reportId, version, spec);
  slog.info("Report version preview", { report: shortId(reportId), version, queries: spec.queries.length, ...(via.keyId ? { via: "mcp" } : {}) });
  const run = await started.done;
  const stored = runResults(run.id);
  const results: QueryResultView[] = spec.queries.map((query) => {
    const result = stored.get(started.keys.get(query.key)!) ?? null;
    const shown = result ? { ...result, queryKey: query.key } : null;
    return { queryKey: query.key, result: shown && !shown.error ? shown : null, failed: shown?.error ? shown : null, stale: false };
  });
  return { runId: run.id, status: run.status, results };
}

/** The kept version before `version` (a version's diff is against it by default); null for the first. */
export function previousVersion(reportId: string, version: number): number | null {
  return (db.query("SELECT max(version) AS version FROM report_versions WHERE report_id = ? AND version < ?").get(reportId, version) as { version: number | null }).version;
}

/** Refuses while a run holds the report (a refresh, a generation, an edit): a spec change waits for it. */
export function refuseWhileRunning(reportId: string) {
  abandonExpiredReportRuns(Date.now(), reportId);
  const holder = runningRun(reportId);
  if (holder) throw new ReportError(409, "RUN_IN_PROGRESS", "This report is running; wait for it to finish", { runId: holder.id });
}

/**
 * Restore (the owner): the version is checked against the data source as it is now (review H2: on,
 * its shape, every query a SELECT on the current allowlist; 409 `STALE_VERSION` otherwise), becomes a
 * new version (`restore`, naming the one it came from), and every restored query runs again at once:
 * old rows are never taken as the restored version's results.
 */
export function restoreVersion(userId: string, reportId: string, version: number, via: { keyId?: string } = {}): { version: number; refreshRunId: string | null } {
  const report = ownedReport(reportId, userId);
  refuseWhileRunning(reportId);
  const row = db.query("SELECT spec_json FROM report_versions WHERE report_id = ? AND version = ?").get(reportId, version) as { spec_json: string } | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Version not found");
  const spec = parseSpec(row.spec_json);
  if (!spec.blocks.length) throw new ReportError(400, "INVALID", "That version has no blocks");
  const datasource = usableDatasource(report.datasource_id);
  assertRunnableNow(datasource, spec, "STALE_VERSION");
  const saved = commitSpec({ reportId, userId, spec, source: "restore", restoredFrom: version });
  audit(userId, null, "reports.version.restore", { reportId, from: version, version: saved.version, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  let refreshRunId: string | null = null;
  if (saved.spec.queries.length) {
    try { refreshRunId = startRefresh(userId, reportId, { trigger: via.keyId ? "mcp" : "user" }).run.id; } catch { /* the owner can refresh by hand */ }
  }
  slog.info("Report version restored", { report: shortId(reportId), from: version, version: saved.version, refresh: Boolean(refreshRunId) });
  return { version: saved.version, refreshRunId };
}
