import { db } from "../db";
import { readableReportSql } from "./access";

/**
 * Report search (plan wave 45, D418): titles only, substring and case-insensitive, over the reports
 * the caller can open (wave 45: their own live ones). Report contents (SQL, results, the doc) are
 * never searched: they are warehouse data, not the person's writing.
 */
export function searchReports(userId: string, q: string, limit: number): { results: Array<{ id: string; title: string; updatedAt: string }>; truncated: boolean } {
  const query = q.trim().toLowerCase().slice(0, 200);
  if (!query) return { results: [], truncated: false };
  const rows = db.query(`SELECT r.id, r.title, r.updated_at FROM reports r WHERE ${readableReportSql("r")} AND instr(lower(r.title), $q) > 0
    ORDER BY (lower(r.title) = $q) DESC, (instr(lower(r.title), $q) = 1) DESC, r.updated_at DESC LIMIT $limit`).all({ userId, q: query, limit: limit + 1 }) as Array<{ id: string; title: string; updated_at: string }>;
  return { results: rows.slice(0, limit).map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at })), truncated: rows.length > limit };
}
