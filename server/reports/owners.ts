import { audit, db, now } from "../db";
import { logger } from "../log";
import type { ReportOwner, ReportOwners, ReportOwnerState } from "../../shared/reportsEdit";
import { isReportOwner } from "./access";
import { ReportError, reportNotFound } from "./errors";

const slog = logger("reports");

/**
 * Report owners (report organization phase 2, migration 062, D482). A report has one or more owners in
 * `report_owners`, each with every owner right (change, share, file in a folder, the doc, the Bin).
 * `reports.owner_id` is the primary owner: always one of the owners, the person scheduled refreshes and
 * the edit agent run as; it moves to another owner when its holder stops being one or is blocked.
 *
 * - Any owner, or any admin (even one who cannot read the report, so an orphan is always recoverable),
 *   adds or removes owners. Anyone else gets the report's 404 (T168 parity).
 * - An owner is a person on the team in a writing role (a member or an admin): never a guest, a viewer,
 *   an integration, or a blocked account.
 * - The last owner is never removed (T390). Every change is audited with who did it (T389).
 * - Blocking an owner, or making them a guest, hands every report where nobody else could act as owner
 *   to an admin (`handOverReportsOf`), audited. They stay listed as an owner, so an unblock restores them.
 */

type Via = { keyId?: string };
type Actor = { id: string; role: string };
const viaMeta = (via: Via) => via.keyId ? { via: "mcp", keyId: via.keyId } : {};

/** The report (live) whose owners `actor` may manage: an owner, or an admin. */
function manageable(reportId: string, actor: Actor): { id: string; owner_id: string; title: string } {
  const row = db.query("SELECT id, owner_id, title FROM reports WHERE id = ? AND deleted_at IS NULL").get(reportId) as { id: string; owner_id: string; title: string } | null;
  if (!row || (actor.role !== "admin" && !isReportOwner(reportId, actor.id))) throw reportNotFound();
  return row;
}

/**
 * An owner's state (D503), the same in the Share sheet's Owners list and Settings → Report owners:
 * `active` only for a member or an admin who is not blocked (who can act as an owner, as `activeOwners`).
 */
export const ownerStateOf = (row: { disabled_at: string | null; role: string }): ReportOwnerState =>
  row.disabled_at !== null ? "blocked" : row.role === "guest" ? "guest" : row.role === "viewer" ? "viewer" : "active";

export function canManageOwners(reportId: string, actor: Actor): boolean {
  try {
    manageable(reportId, actor);
    return true;
  } catch {
    return false;
  }
}

/**
 * `withTitle` (D508, `GET /api/reports/:id/owners` only): the report's title, so the Owners sheet that
 * Forward reopens in Settings → Report owners names a report past the list's first page. Only for whoever
 * may manage the owners (an owner, or an admin who may not read the report but sees its title in the
 * owner review anyway, D500/T399); nothing else of the report. MCP answers are unchanged.
 */
export function listOwners(reportId: string, actor: Actor, { withTitle = false } = {}): ReportOwners {
  const report = manageable(reportId, actor);
  const rows = db.query(`SELECT o.user_id AS id, u.display_name AS name, u.disabled_at, u.role, o.created_at, a.display_name AS added_by
    FROM report_owners o JOIN users u ON u.id = o.user_id LEFT JOIN users a ON a.id = o.added_by WHERE o.report_id = ? ORDER BY o.created_at, u.display_name COLLATE NOCASE, o.user_id`)
    .all(reportId) as Array<{ id: string; name: string; disabled_at: string | null; role: string; created_at: string; added_by: string | null }>;
  return {
    owners: rows.map((row): ReportOwner => ({ id: row.id, name: row.name, primary: row.id === report.owner_id, active: row.disabled_at === null && row.role !== "guest", state: ownerStateOf(row), addedBy: row.added_by, addedAt: row.created_at })),
    canManage: true,
    ...(withTitle ? { title: report.title } : {})
  };
}

/** The owners who can act (not blocked, not a guest), oldest first. */
function activeOwners(reportId: string, except: string | null = null): string[] {
  return (db.query(`SELECT o.user_id FROM report_owners o JOIN users u ON u.id = o.user_id
    WHERE o.report_id = ? AND u.disabled_at IS NULL AND u.role IN ('admin', 'member') AND o.user_id IS NOT ? ORDER BY o.created_at, o.user_id`).all(reportId, except) as Array<{ user_id: string }>).map((row) => row.user_id);
}

export function addOwner(actor: Actor, reportId: string, userId: string, via: Via = {}): ReportOwners {
  return db.transaction(() => {
    manageable(reportId, actor);
    const person = db.query("SELECT role, kind, disabled_at FROM users WHERE id = ?").get(userId) as { role: string; kind: string; disabled_at: string | null } | null;
    if (!person || person.kind !== "person" || person.disabled_at !== null || (person.role !== "admin" && person.role !== "member")) {
      throw new ReportError(400, "INVALID", "An owner must be a member or an admin on the team (not a viewer, a guest, or an integration)");
    }
    const added = db.query("INSERT OR IGNORE INTO report_owners (report_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)").run(reportId, userId, actor.id, now()).changes > 0;
    if (added) {
      // An owner needs no share: their own row would only confuse the Share sheet.
      db.query("DELETE FROM report_members WHERE report_id = ? AND user_id = ?").run(reportId, userId);
      audit(actor.id, null, "reports.owner.add", { reportId, userId, ...(isReportOwner(reportId, actor.id) ? {} : { asAdmin: true }), ...viaMeta(via) });
    }
    return listOwners(reportId, actor);
  })();
}

export function removeOwner(actor: Actor, reportId: string, userId: string, via: Via = {}): ReportOwners {
  return db.transaction(() => {
    const report = manageable(reportId, actor);
    if (!isReportOwner(reportId, userId)) throw new ReportError(404, "NOT_FOUND", "That person is not an owner of this report");
    const count = (db.query("SELECT COUNT(*) AS count FROM report_owners WHERE report_id = ?").get(reportId) as { count: number }).count;
    if (count <= 1) throw new ReportError(409, "LAST_OWNER", "A report always keeps at least one owner: add another owner first");
    if (report.owner_id === userId) {
      const next = activeOwners(reportId, userId)[0]
        ?? (db.query("SELECT user_id FROM report_owners WHERE report_id = ? AND user_id <> ? ORDER BY created_at, user_id LIMIT 1").get(reportId, userId) as { user_id: string }).user_id;
      db.query("UPDATE reports SET owner_id = ? WHERE id = ?").run(next, reportId);
    }
    db.query("DELETE FROM report_owners WHERE report_id = ? AND user_id = ?").run(reportId, userId);
    audit(actor.id, null, "reports.owner.remove", { reportId, userId, ...(userId === actor.id ? { self: true } : {}), ...(isReportOwner(reportId, actor.id) || userId === actor.id ? {} : { asAdmin: true }), ...viaMeta(via) });
    // The caller who removed themselves keeps nothing to manage (an admin still does).
    if (userId === actor.id && actor.role !== "admin") return { owners: [], canManage: false };
    return listOwners(reportId, actor);
  })();
}

/**
 * The person can no longer act as an owner (blocked, or made a guest). Inside the caller's transaction:
 * for every report they own (live or in the Bin), the primary owner moves to an owner who can act; when
 * nobody can, an admin becomes an owner (the one acting, else the oldest active admin), audited
 * `reports.owner.handover`. Returns how many reports were handed to an admin.
 */
export function handOverReportsOf(userId: string, actorId: string | null): number {
  const reports = db.query("SELECT r.id, r.owner_id FROM report_owners o JOIN reports r ON r.id = o.report_id WHERE o.user_id = ?").all(userId) as Array<{ id: string; owner_id: string }>;
  if (!reports.length) return 0;
  const actorIsAdmin = actorId !== null && Boolean(db.query("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND disabled_at IS NULL").get(actorId));
  const admin = actorIsAdmin ? actorId : (db.query("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL AND kind = 'person' AND id <> ? ORDER BY created_at, id LIMIT 1").get(userId) as { id: string } | null)?.id ?? null;
  let handed = 0;
  for (const report of reports) {
    let next = activeOwners(report.id, userId)[0] ?? null;
    if (!next && admin) {
      db.query("INSERT OR IGNORE INTO report_owners (report_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)").run(report.id, admin, actorId, now());
      audit(actorId, null, "reports.owner.handover", { reportId: report.id, from: userId, to: admin });
      next = admin;
      handed += 1;
    }
    if (next && report.owner_id === userId) db.query("UPDATE reports SET owner_id = ? WHERE id = ?").run(next, report.id);
  }
  if (handed) slog.info("Reports handed to an admin", { from: userId, reports: handed });
  return handed;
}
