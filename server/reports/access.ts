import { db } from "../db";
import { AUDIENCE_ALL_USERS, type Role } from "../team/roles";
import type { ReportLevel, ShareLevel } from "../../shared/reportsEdit";
import { ReportError, reportNotFound } from "./errors";

/**
 * Who reaches a report (plan wave 45, D418; wave 48 sharing, D455). The owner reads and changes a live
 * report. Wave 48 adds view-only sharing with the collections pattern: `visibility = 'selected'` lets
 * the people and groups in `report_members` / `report_group_shares` read it, at `view` or `comment`
 * (comment adds instructions to the edit agent); `all_users` lets every person read it (never guests or
 * integrations, AUDIENCE_ALL_USERS). A Team viewer is capped at `view`. Everything that changes the
 * report, runs a query, or reads the doc stays the owner's (`ownedReport`): refresh, schedule,
 * regenerate, stop, Check doc, Apply and Reject, restore, manual edits, the console, sharing, the Bin.
 * Missing, binned, and forbidden are the same 404 (T168 parity). Guests have no Reports module.
 */

export type ReportRow = {
  id: string; owner_id: string; title: string; datasource_id: string | null; doc_server_id: string | null; doc_tool: string | null; doc_ref: string | null; doc_arg?: string | null;
  doc_hash: string | null; spec_json: string; status: "draft" | "ready" | "stale" | "error"; last_run_at: string | null; last_error: string | null;
  visibility: "private" | "selected" | "all_users"; revision: number; created_at: string; updated_at: string; deleted_at: string | null;
  deleted_by: string | null; purge_after: string | null; purge_started_at: string | null; auto_apply?: number;
};

/** SQL: the report `alias` is readable by `$userId` (the owner, a member or group under `selected`, or everyone under `all_users`). */
export const readableReportSql = (alias = "r") => `(${alias}.deleted_at IS NULL AND (${alias}.owner_id = $userId
  OR (${alias}.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (${alias}.visibility = 'selected' AND (SELECT u_rep.role <> 'guest' FROM users u_rep WHERE u_rep.id = $userId AND u_rep.disabled_at IS NULL) = 1 AND (
    EXISTS (SELECT 1 FROM report_members rm WHERE rm.report_id = ${alias}.id AND rm.user_id = $userId)
    OR EXISTS (SELECT 1 FROM report_group_shares rg JOIN group_members gm ON gm.group_id = rg.group_id WHERE rg.report_id = ${alias}.id AND gm.user_id = $userId)))))`;

export function readableReport(id: string, userId: string): ReportRow {
  const row = db.query(`SELECT * FROM reports r WHERE r.id = $id AND ${readableReportSql("r")}`).get({ id, userId }) as ReportRow | null;
  if (!row) throw reportNotFound();
  return row;
}

/** The owner's live report, for every change (D455): anyone else, a reader included, gets the same 404. */
export function ownedReport(id: string, userId: string): ReportRow {
  const row = db.query("SELECT * FROM reports WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(id, userId) as ReportRow | null;
  if (!row) throw reportNotFound();
  return row;
}

const RANK: Record<ReportLevel | "none", number> = { none: 0, view: 1, comment: 2, owner: 3 };

/** The caller's level on a report they can read (readableReport first): owner, comment, or view. */
export function reportLevel(row: Pick<ReportRow, "id" | "owner_id" | "visibility">, userId: string): ReportLevel {
  if (row.owner_id === userId) return "owner";
  const user = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: Role } | null;
  let best: ReportLevel | "none" = row.visibility === "all_users" ? "view" : "none";
  if (row.visibility === "selected") {
    const levels = [
      ...(db.query("SELECT level FROM report_members WHERE report_id = ? AND user_id = ?").all(row.id, userId) as Array<{ level: ShareLevel }>),
      ...(db.query("SELECT rg.level FROM report_group_shares rg JOIN group_members gm ON gm.group_id = rg.group_id WHERE rg.report_id = ? AND gm.user_id = ?").all(row.id, userId) as Array<{ level: ShareLevel }>)
    ];
    for (const { level } of levels) if (RANK[level] > RANK[best]) best = level;
  }
  // A Team viewer reads at most (D266: a role is a ceiling, never a grant).
  if (best === "comment" && user?.role !== "admin" && user?.role !== "member") best = "view";
  return best === "none" ? "view" : best;
}

/** A report the caller may comment on (instructions): the owner, or `comment` level. */
export function commentableReport(id: string, userId: string): { row: ReportRow; level: ReportLevel } {
  const row = readableReport(id, userId);
  const level = reportLevel(row, userId);
  if (RANK[level] < RANK.comment) throw new ReportError(403, "ROLE_READ_ONLY", "This report is shared with you to view; ask its owner for the comment level");
  return { row, level };
}

/** Whether this role has the Reports module (every role but guest). */
export const roleHasReports = (role: Role | string | undefined) => role !== undefined && role !== "guest";
