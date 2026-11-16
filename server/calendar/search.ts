import { db } from "../db";
import { readableCalendarPredicate } from "./access";

/**
 * Event search for the ⌘K palette and the link picker (docs/plan/SEARCH_EVERYWHERE.md, D1341). Not
 * full-text: a case-insensitive `instr` on titles (so `%` and `_` are literal), over live events on
 * live calendars the caller can read: the agenda's own predicate (T61), applied before LIMIT. A series
 * is one hit. Only the title, the calendar's name, and when it first starts are returned.
 */
export type EventSearchHit = {
  kind: "event";
  id: string;
  title: string;
  href: string;
  calendarId: string;
  calendarName: string;
  allDay: boolean;
  /** YYYY-MM-DD for an all-day event, else the first start as an ISO instant. */
  start: string;
  recurring: boolean;
  updatedAt: string;
};

export function searchEvents(userId: string, q: string, limit: number): { results: EventSearchHit[]; truncated: boolean } {
  const query = q.trim().toLowerCase().slice(0, 200);
  if (!query) return { results: [], truncated: false };
  const rows = db.query(`SELECT e.id, e.title, e.calendar_id, k.name AS calendar_name, e.all_day, e.start_date, e.start_utc, e.rrule_json, e.updated_at
    FROM events e JOIN calendars k ON k.id = e.calendar_id
    WHERE e.deleted_at IS NULL AND ${readableCalendarPredicate} AND instr(lower(e.title), $q) > 0
    ORDER BY (lower(e.title) = $q) DESC, (instr(lower(e.title), $q) = 1) DESC, e.updated_at DESC, e.id
    LIMIT $limit`).all({ userId, q: query, limit: limit + 1 }) as Array<{ id: string; title: string; calendar_id: string; calendar_name: string; all_day: number; start_date: string | null; start_utc: string; rrule_json: string | null; updated_at: string }>;
  const results = rows.slice(0, limit).map((row): EventSearchHit => ({
    kind: "event", id: row.id, title: row.title || "Untitled event", href: `/calendar/event/${row.id}`, calendarId: row.calendar_id, calendarName: row.calendar_name,
    allDay: row.all_day === 1, start: row.all_day === 1 && row.start_date ? row.start_date : row.start_utc, recurring: row.rrule_json !== null, updatedAt: row.updated_at
  }));
  return { results, truncated: rows.length > limit };
}
