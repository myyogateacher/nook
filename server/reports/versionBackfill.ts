import { db } from "../db";
import { parseSpec } from "./service";
import { maxProvenanceVersion } from "./versionNumbers";

/**
 * The idempotent version backfill (wave 48 review M2): a report whose current spec no version row
 * holds (generated before wave 48 recorded generations) gets one, numbered from its blocks' stamp.
 * Runs at boot for every report, and inside each spec write for that report; a no-op otherwise.
 * Every new spec is recorded by its own writer (persistGenerated, commitSpec).
 */
export function backfillVersion(reportId: string) {
  const report = db.query("SELECT spec_json, owner_id, updated_at FROM reports WHERE id = ?").get(reportId) as { spec_json: string; owner_id: string; updated_at: string } | null;
  if (!report) return false;
  const spec = parseSpec(report.spec_json);
  if (!spec.blocks.length) return false;
  const latest = db.query("SELECT version, spec_json FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT 1").get(reportId) as { version: number; spec_json: string } | null;
  if (latest?.spec_json === report.spec_json) return false;
  const version = Math.max((latest?.version ?? 0) + 1, maxProvenanceVersion(spec), 1);
  const run = db.query("SELECT id FROM report_runs WHERE report_id = ? AND kind = 'generate' AND status = 'succeeded' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(reportId) as { id: string } | null;
  db.query("INSERT INTO report_versions (report_id, version, spec_json, source, run_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(reportId, version, report.spec_json, latest || run ? "generate" : "initial", run?.id ?? null, report.owner_id, report.updated_at);
  return true;
}

/** Boot: every live report's spec is a version. Returns how many were recorded. */
export function backfillVersions(): number {
  const ids = db.query("SELECT id FROM reports WHERE deleted_at IS NULL AND json_array_length(spec_json, '$.blocks') > 0").all() as Array<{ id: string }>;
  let count = 0;
  for (const { id } of ids) if (db.transaction(() => backfillVersion(id))()) count += 1;
  return count;
}
