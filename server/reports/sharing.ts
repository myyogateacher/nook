import { audit, db, now } from "../db";
import type { ReportShare, ReportSharing, SharingInput } from "../../shared/reportsEdit";
import { isReportOwner, ownedReport } from "./access";
import { ReportError } from "./errors";

/**
 * View-only sharing of a report (plan wave 48, D455; phase 2: any of its owners, D482), the collections pattern: the owner picks an
 * audience (`private`, `selected` people and groups, or `all_users`) and, for `selected`, a level per
 * person or group: `view` (the report and its results, the inspect sheet) or `comment` (also
 * instructions to the edit agent, which only the owner may apply). Guests and integrations are never
 * picked (guests have no Reports module; integrations reach only what keys give them). Saving replaces
 * the list. Purging the report or the group removes the rows (foreign keys).
 */

export const SHARES_PER_REPORT = 100;

export function getSharing(reportId: string, userId: string): ReportSharing {
  const report = ownedReport(reportId, userId);
  const users = db.query("SELECT m.user_id AS id, u.display_name AS name, m.level FROM report_members m JOIN users u ON u.id = m.user_id WHERE m.report_id = ? ORDER BY u.display_name")
    .all(reportId) as Array<{ id: string; name: string; level: ReportShare["level"] }>;
  const groups = db.query("SELECT g.group_id AS id, ug.name, g.level FROM report_group_shares g JOIN user_groups ug ON ug.id = g.group_id WHERE g.report_id = ? ORDER BY ug.name")
    .all(reportId) as Array<{ id: string; name: string; level: ReportShare["level"] }>;
  return { visibility: report.visibility, shares: [...groups.map((row) => ({ kind: "group" as const, ...row })), ...users.map((row) => ({ kind: "user" as const, ...row }))] };
}

export function setSharing(userId: string, reportId: string, input: SharingInput, via: { keyId?: string } = {}): ReportSharing {
  ownedReport(reportId, userId);
  if (input.shares.length > SHARES_PER_REPORT) throw new ReportError(400, "INVALID", `Share with at most ${SHARES_PER_REPORT} people and groups`);
  const seen = new Set<string>();
  for (const share of input.shares) {
    const key = `${share.kind}:${share.id}`;
    if (seen.has(key)) throw new ReportError(400, "INVALID", "A person or group is listed twice");
    seen.add(key);
    if (share.kind === "user") {
      if (share.id === userId) throw new ReportError(400, "INVALID", "You own this report");
      if (isReportOwner(reportId, share.id)) throw new ReportError(400, "INVALID", "That person already owns this report");
      const person = db.query("SELECT role, kind FROM users WHERE id = ? AND disabled_at IS NULL").get(share.id) as { role: string; kind: string } | null;
      if (!person || person.role === "guest" || person.kind !== "person") throw new ReportError(400, "INVALID", "Reports can be shared only with people on the team (not guests or integrations)");
    } else if (!db.query("SELECT 1 FROM user_groups WHERE id = ?").get(share.id)) throw new ReportError(400, "INVALID", "That group no longer exists");
  }
  const at = now();
  db.transaction(() => {
    db.query("UPDATE reports SET visibility = ?, updated_at = ? WHERE id = ?").run(input.visibility, at, reportId);
    db.query("DELETE FROM report_members WHERE report_id = ?").run(reportId);
    db.query("DELETE FROM report_group_shares WHERE report_id = ?").run(reportId);
    for (const share of input.shares) {
      if (share.kind === "user") db.query("INSERT INTO report_members (report_id, user_id, level, added_by, created_at) VALUES (?, ?, ?, ?, ?)").run(reportId, share.id, share.level, userId, at);
      else db.query("INSERT INTO report_group_shares (report_id, group_id, level, added_by, created_at) VALUES (?, ?, ?, ?, ?)").run(reportId, share.id, share.level, userId, at);
    }
  })();
  audit(userId, null, "reports.report.share", { reportId, visibility: input.visibility, users: input.shares.filter((share) => share.kind === "user").length, groups: input.shares.filter((share) => share.kind === "group").length, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  return getSharing(reportId, userId);
}
