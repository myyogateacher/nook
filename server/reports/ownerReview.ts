import { audit, db } from "../db";
import type { OwnerReview, OwnerReviewOwner, OwnerReviewReport, OwnerReviewScope } from "../../shared/reportsEdit";
import { readableReportSql } from "./access";
import { ReportError } from "./errors";

/**
 * Settings → Report owners (D500, admins only): the reports an admin may need to recover, so they can add
 * an owner in the app (POST /api/reports/:id/owners, audited) instead of only over REST or MCP.
 *
 * - `unmanaged`: live reports with no owner who can act (a member or an admin who is not blocked). Blocking
 *   an owner or making them a guest hands such reports to an admin already (D482), so these are reports from
 *   before 062, a demotion to viewer, a demotion with no admin left, or owners whose accounts are gone.
 * - `unopenable`: live reports the admin cannot open at all, managed or not, to find one to take over.
 *
 * Each row is the report's title, folder, owners (with their state), and last change: what owner
 * management already shows an admin, plus the title to find it by. Never the doc, the queries, the
 * results, or the sharing (T399). A list that shows reports the admin cannot open is audited
 * `reports.owner.review`. Binned reports are not listed: their owners are managed in the Bin's restore.
 */

export const OWNER_REVIEW_LIMIT = 200;

/** SQL: the report `r` has an owner who can act (as `activeOwners` in owners.ts). */
const ACTIVE_OWNER_SQL = `EXISTS (SELECT 1 FROM report_owners o_rv JOIN users u_rv ON u_rv.id = o_rv.user_id
  WHERE o_rv.report_id = r.id AND u_rv.disabled_at IS NULL AND u_rv.role IN ('admin', 'member'))`;

type Row = { id: string; title: string; updated_at: string; folder_id: string | null; folder_name: string | null; can_open: number; managed: number };

const stateOf = (row: { disabled_at: string | null; role: string }): OwnerReviewOwner["state"] =>
  row.disabled_at !== null ? "blocked" : row.role === "guest" ? "guest" : row.role === "viewer" ? "viewer" : "active";

export function ownerReview(actor: { id: string; role: string }, options: { scope?: OwnerReviewScope; q?: string; ids?: readonly string[] | null; via?: { keyId?: string } } = {}): OwnerReview {
  if (actor.role !== "admin") throw new ReportError(403, "ADMIN_ONLY", "Only admins review report owners");
  const scope = options.scope ?? "unmanaged";
  const where = ["r.deleted_at IS NULL", scope === "unmanaged" ? `NOT ${ACTIVE_OWNER_SQL}` : `NOT ${readableReportSql("r")}`];
  const params: Record<string, string | number> = { userId: actor.id };
  const q = options.q?.trim().toLowerCase().slice(0, 200) ?? "";
  if (q) { where.push("instr(lower(r.title), $q) > 0"); params.q = q; }
  if (options.ids) { where.push("r.id IN (SELECT value FROM json_each($ids))"); params.ids = JSON.stringify(options.ids); }
  const clause = where.join(" AND ");
  const total = (db.query(`SELECT COUNT(*) AS n FROM reports r WHERE ${clause}`).get(params) as { n: number }).n;
  const rows = db.query(`SELECT r.id, r.title, r.updated_at, r.folder_id, f.name AS folder_name, ${readableReportSql("r")} AS can_open, ${ACTIVE_OWNER_SQL} AS managed
    FROM reports r LEFT JOIN report_folders f ON f.id = r.folder_id AND f.deleted_at IS NULL
    WHERE ${clause} ORDER BY r.updated_at DESC, r.id LIMIT ${OWNER_REVIEW_LIMIT}`).all(params) as Row[];
  const owners = new Map<string, OwnerReviewOwner[]>();
  if (rows.length) {
    const ownerRows = db.query(`SELECT o.report_id, u.id, u.display_name AS name, u.disabled_at, u.role FROM report_owners o JOIN users u ON u.id = o.user_id
      WHERE o.report_id IN (SELECT value FROM json_each(?)) ORDER BY o.created_at, u.display_name COLLATE NOCASE, u.id`)
      .all(JSON.stringify(rows.map((row) => row.id))) as Array<{ report_id: string; id: string; name: string; disabled_at: string | null; role: string }>;
    for (const row of ownerRows) owners.set(row.report_id, [...owners.get(row.report_id) ?? [], { id: row.id, name: row.name, state: stateOf(row) }]);
  }
  const reports = rows.map((row): OwnerReviewReport => ({
    id: row.id, title: row.title, folder: row.folder_id && row.folder_name !== null ? { id: row.folder_id, name: row.folder_name } : null,
    owners: owners.get(row.id) ?? [], updatedAt: row.updated_at, canOpen: row.can_open === 1, managed: row.managed === 1
  }));
  const unopenable = reports.filter((report) => !report.canOpen).length;
  if (unopenable) audit(actor.id, null, "reports.owner.review", { scope, shown: reports.length, unopenable, ...(q ? { query: true } : {}), ...(options.via?.keyId ? { via: "mcp", keyId: options.via.keyId } : {}) });
  return { scope, reports, total, limit: OWNER_REVIEW_LIMIT };
}
