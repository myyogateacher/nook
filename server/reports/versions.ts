import { audit, db, now } from "../db";
import type { ReportSpec, ResultColumn } from "../../shared/reports";
import { INSTRUCTION_LIMITS, type ReportVersion, type VersionSource } from "../../shared/reportsEdit";
import { ownedReport, readableReport } from "./access";
import { ReportError } from "./errors";
import { capRows, runningRun, startRefresh, abandonExpiredReportRuns } from "./refresh";
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
    const provenance = { runId: input.runId ?? null, instructionId: input.instructionId ?? null, version, docSnapshotId: input.docSnapshotId ?? null };
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

function versionView(row: VersionRow, currentJson: string, latest: number): ReportVersion {
  const spec = parseSpec(row.spec_json);
  return {
    version: row.version, source: row.source, instructionId: row.instruction_id, restoredFrom: row.restored_from, note: row.note, createdByName: row.author,
    createdAt: row.created_at, blocks: spec.blocks.length, queries: spec.queries.length, current: row.version === latest && row.spec_json === currentJson
  };
}

const VERSION_SELECT = "SELECT v.*, u.display_name AS author FROM report_versions v LEFT JOIN users u ON u.id = v.created_by";

/** The report's versions, newest first (anyone who can read the report). */
export function listVersions(reportId: string, userId: string): ReportVersion[] {
  const report = readableReport(reportId, userId);
  const rows = db.query(`${VERSION_SELECT} WHERE v.report_id = ? ORDER BY v.version DESC`).all(reportId) as VersionRow[];
  const latest = rows[0]?.version ?? 0;
  return rows.map((row) => versionView(row, report.spec_json, latest));
}

/** One version with its spec, for a preview. */
export function getVersion(reportId: string, version: number, userId: string): { version: ReportVersion; spec: ReportSpec } {
  const report = readableReport(reportId, userId);
  const row = db.query(`${VERSION_SELECT} WHERE v.report_id = ? AND v.version = ?`).get(reportId, version) as VersionRow | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Version not found");
  const latest = (db.query("SELECT max(version) AS version FROM report_versions WHERE report_id = ?").get(reportId) as { version: number }).version;
  return { version: versionView(row, report.spec_json, latest), spec: parseSpec(row.spec_json) };
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
  return { version: saved.version, refreshRunId };
}
