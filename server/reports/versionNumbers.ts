import { db } from "../db";
import type { ReportSpec } from "../../shared/reports";

/**
 * Version numbers (plan wave 48, D452), on their own so generation's save (specValidate.ts) and the
 * version writes (versions.ts) share them without an import cycle.
 */

export const maxProvenanceVersion = (spec: ReportSpec) => Math.max(0, ...spec.blocks.map((block) => block.provenance?.version ?? 0));

/** The next version number: past every version row and every block's stamped version. */
export function nextVersion(reportId: string, current: ReportSpec): number {
  const row = db.query("SELECT max(version) AS version FROM report_versions WHERE report_id = ?").get(reportId) as { version: number | null };
  return Math.max(row.version ?? 0, maxProvenanceVersion(current)) + 1;
}
