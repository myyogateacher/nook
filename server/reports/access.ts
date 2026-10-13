import { db } from "../db";
import type { Role } from "../team/roles";
import { reportNotFound } from "./errors";

/**
 * Who reaches a report (plan wave 45, D418). Wave 45 reports are private to their owner: the owner
 * reads and writes a live report; everyone else, and every binned report, is the same 404 (T168
 * parity). Wave 48 adds view-only sharing through `visibility` (the collections pattern), here.
 * Guests have no Reports module at all (the routes answer 404 for them, like Chat, AC-O2).
 */

export type ReportRow = {
  id: string; owner_id: string; title: string; datasource_id: string | null; doc_server_id: string | null; doc_tool: string | null; doc_ref: string | null;
  doc_hash: string | null; spec_json: string; status: "draft" | "ready" | "stale" | "error"; last_run_at: string | null; last_error: string | null;
  visibility: "private" | "selected" | "all_users"; revision: number; created_at: string; updated_at: string; deleted_at: string | null;
  deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

/** SQL: the report `alias` is readable by `$userId` (wave 45: the owner's, live). */
export const readableReportSql = (alias = "r") => `(${alias}.owner_id = $userId AND ${alias}.deleted_at IS NULL)`;

export function readableReport(id: string, userId: string): ReportRow {
  const row = db.query(`SELECT * FROM reports r WHERE r.id = $id AND ${readableReportSql("r")}`).get({ id, userId }) as ReportRow | null;
  if (!row) throw reportNotFound();
  return row;
}

/** The owner's live report, for changes (wave 45 has only owners). */
export const ownedReport = readableReport;

/** Whether this role has the Reports module (every role but guest). */
export const roleHasReports = (role: Role | string | undefined) => role !== undefined && role !== "guest";
