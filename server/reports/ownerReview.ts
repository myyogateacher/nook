import { audit, db } from "../db";
import type { OwnerReview, OwnerReviewOwner, OwnerReviewReport, OwnerReviewScope } from "../../shared/reportsEdit";
import { readableReportSql } from "./access";
import { ReportError } from "./errors";
import { ownerStateOf } from "./owners";
import { decodeCursor, encodeCursor } from "./service";

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
 * results, or the sharing (T399). A page that shows reports the admin cannot open is audited
 * `reports.owner.review`. Binned reports are not listed: their owners are managed in the Bin's restore.
 *
 * D505: pages of 200 by cursor on `(updated_at, id)`, as the Reports list.
 */

export const OWNER_REVIEW_LIMIT = 200;

/** SQL: the report `r` has an owner who can act (as `activeOwners` in owners.ts). */
const ACTIVE_OWNER_SQL = `EXISTS (SELECT 1 FROM report_owners o_rv JOIN users u_rv ON u_rv.id = o_rv.user_id
  WHERE o_rv.report_id = r.id AND u_rv.disabled_at IS NULL AND u_rv.role IN ('admin', 'member'))`;

/**
 * D506: where a report nobody can manage can be. A report with owners and none who can act has an owner
 * who cannot (blocked, a guest, a viewer): found from those people (report_owners_user), a small set
 * however many reports there are. A report with no owner rows at all is only left by data written around
 * the app (062's trigger keeps the primary owner a row, a removal hands it on first, and a person's
 * reports go with their account), so the walk over every report that finds those runs only when the
 * owner rows cover fewer reports than exist (two counts over an index each).
 */
const INACTIVE_OWNED_SQL = `SELECT o_c.report_id FROM users u_c JOIN report_owners o_c ON o_c.user_id = u_c.id WHERE NOT (u_c.disabled_at IS NULL AND u_c.role IN ('admin', 'member'))`;
const OWNERLESS_SQL = `SELECT r_c.id FROM reports r_c WHERE r_c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM report_owners o_z WHERE o_z.report_id = r_c.id)`;
const someOwnerless = (handle: typeof db) => (handle.query("SELECT (SELECT COUNT(*) FROM reports) > (SELECT COUNT(DISTINCT report_id) FROM report_owners) AS gap").get() as { gap: number }).gap === 1;

type Row = { id: string; title: string; updated_at: string; folder_id: string | null; folder_name: string | null; can_open: number; managed: number };

export type OwnerReviewOptions = { scope?: OwnerReviewScope; q?: string; ids?: readonly string[] | null; cursor?: string | null; limit?: number; via?: { keyId?: string } };

/**
 * One page of a list, newest change first (D505). `total` is counted on the first page only: a page
 * after a cursor answers null and the caller keeps the first page's count. `handle` is for tests over
 * their own database. No admin check and no audit here (ownerReview has both).
 */
export function ownerReviewPage(actor: { id: string }, options: OwnerReviewOptions = {}, handle = db): OwnerReview {
  const scope = options.scope ?? "unmanaged";
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? OWNER_REVIEW_LIMIT)), OWNER_REVIEW_LIMIT);
  const where = ["r.deleted_at IS NULL"];
  const params: Record<string, string | number> = { userId: actor.id };
  if (scope === "unmanaged") {
    // The unmanaged set is read once (each candidate checked once), then counted and paged from that set.
    const unmanaged = handle.query(`SELECT r.id FROM reports r WHERE r.deleted_at IS NULL
      AND r.id IN (${INACTIVE_OWNED_SQL}${someOwnerless(handle) ? ` UNION ALL ${OWNERLESS_SQL}` : ""}) AND NOT ${ACTIVE_OWNER_SQL}`).values().map((row) => row[0] as string);
    where.push("r.id IN (SELECT value FROM json_each($unmanaged))");
    params.unmanaged = JSON.stringify(unmanaged);
  } else where.push(`NOT ${readableReportSql("r")}`);
  const q = options.q?.trim().toLowerCase().slice(0, 200) ?? "";
  if (q) { where.push("instr(lower(r.title), $q) > 0"); params.q = q; }
  if (options.ids) { where.push("r.id IN (SELECT value FROM json_each($ids))"); params.ids = JSON.stringify(options.ids); }
  const total = options.cursor ? null : (handle.query(`SELECT COUNT(*) AS n FROM reports r WHERE ${where.join(" AND ")}`).get(params) as { n: number }).n;
  if (options.cursor) {
    const { at, id } = decodeCursor(options.cursor);
    where.push("(r.updated_at < $cursorAt OR (r.updated_at = $cursorAt AND r.id > $cursorId))");
    params.cursorAt = at;
    params.cursorId = id;
  }
  const rows = handle.query(`SELECT r.id, r.title, r.updated_at, r.folder_id, f.name AS folder_name, ${readableReportSql("r")} AS can_open, ${ACTIVE_OWNER_SQL} AS managed
    FROM reports r LEFT JOIN report_folders f ON f.id = r.folder_id AND f.deleted_at IS NULL
    WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC, r.id LIMIT ${limit + 1}`).all(params) as Row[];
  const shown = rows.slice(0, limit);
  const owners = new Map<string, OwnerReviewOwner[]>();
  if (shown.length) {
    const ownerRows = handle.query(`SELECT o.report_id, u.id, u.display_name AS name, u.disabled_at, u.role FROM report_owners o JOIN users u ON u.id = o.user_id
      WHERE o.report_id IN (SELECT value FROM json_each(?)) ORDER BY o.created_at, u.display_name COLLATE NOCASE, u.id`)
      .all(JSON.stringify(shown.map((row) => row.id))) as Array<{ report_id: string; id: string; name: string; disabled_at: string | null; role: string }>;
    for (const row of ownerRows) owners.set(row.report_id, [...owners.get(row.report_id) ?? [], { id: row.id, name: row.name, state: ownerStateOf(row) }]);
  }
  const reports = shown.map((row): OwnerReviewReport => ({
    id: row.id, title: row.title, folder: row.folder_id && row.folder_name !== null ? { id: row.folder_id, name: row.folder_name } : null,
    owners: owners.get(row.id) ?? [], updatedAt: row.updated_at, canOpen: row.can_open === 1, managed: row.managed === 1
  }));
  return { scope, reports, total, limit, nextCursor: rows.length > limit ? encodeCursor(reports[reports.length - 1]!) : null };
}

/** A page of a list for an admin (403 for anyone else); a page showing reports they cannot open is audited `reports.owner.review`. */
export function ownerReview(actor: { id: string; role: string }, options: OwnerReviewOptions = {}): OwnerReview {
  if (actor.role !== "admin") throw new ReportError(403, "ADMIN_ONLY", "Only admins review report owners");
  const page = ownerReviewPage(actor, options);
  const unopenable = page.reports.filter((report) => !report.canOpen).length;
  if (unopenable) {
    audit(actor.id, null, "reports.owner.review", {
      scope: page.scope, shown: page.reports.length, unopenable, ...(options.q?.trim() ? { query: true } : {}), ...(options.cursor ? { more: true } : {}),
      ...(options.via?.keyId ? { via: "mcp", keyId: options.via.keyId } : {})
    });
  }
  return page;
}
