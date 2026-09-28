import { db } from "../db";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { groupGrantExists } from "../access/groups";
import { audienceLevel, roleWord, shareRoleToLevel, type ItemLevel } from "../access/levels";
import { canWriteContent } from "../team/userRole";

export type CalendarVisibility = "private" | "selected" | "all_users";
export type ShareRole = "viewer" | "editor";
export type CalendarRole = "owner" | ShareRole;
export type CalendarColor = "blue" | "green" | "amber" | "red" | "violet" | "slate";

export type CalendarRow = {
  id: string;
  owner_id: string;
  name: string;
  color: CalendarColor;
  visibility: CalendarVisibility;
  share_role: ShareRole;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

export type EventRow = {
  id: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string;
  all_day: 0 | 1;
  start_date: string | null;
  end_date: string | null;
  start_local: string | null;
  tz: string | null;
  duration_minutes: number | null;
  start_utc: string;
  series_end_utc: string | null;
  rrule_json: string | null;
  exdates_json: string;
  prev_json: string | null;
  revision: number;
  prev_revision: number | null;
  updated_via_key_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

/**
 * Whether `$userId` may read live calendar `k` (WAVES_7-9.md §3.2 style,
 * WAVES_10-12.md §4.2): the owner, everyone for `all_users`, or a member row
 * for `selected`. Binned calendars never match. Events are always joined to
 * their calendar through this predicate (T61).
 */
export const calendarAudiencePredicate = `(k.owner_id = $userId OR (k.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (k.visibility = 'selected' AND (EXISTS (SELECT 1 FROM calendar_members m WHERE m.calendar_id = k.id AND m.user_id = $userId)
    OR ${groupGrantExists("calendar", "k.id")})))`;
export const readableCalendarPredicate = `(k.deleted_at IS NULL AND ${calendarAudiencePredicate})`;

/**
 * Who may write events on `k`, whatever its Bin state (D54, D272): the owner; everyone on an
 * `all_users` calendar whose audience role is `editor`; or, for `selected`, a member or group at
 * `edit` or `manage`. The Team role cap is applied in TS (requireEditable*), as before.
 */
const calendarEditAudience = `(k.owner_id = $userId OR (k.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS} AND k.share_role = 'editor')
  OR (k.visibility = 'selected' AND (EXISTS (SELECT 1 FROM calendar_members em WHERE em.calendar_id = k.id AND em.user_id = $userId AND em.level IN ('edit','manage'))
    OR ${groupGrantExists("calendar", "k.id", "$userId", ["edit", "manage"])})))`;

/** Readers who may write events. */
export const editableCalendarPredicate = `(${readableCalendarPredicate} AND ${calendarEditAudience})`;

/** The same audience and level as editableCalendarPredicate, whatever the calendar's Bin state (Bin restore only). */
export const calendarWriterPredicate = `(${calendarAudiencePredicate} AND ${calendarEditAudience})`;

export function readableCalendar(calendarId: string, userId: string) {
  return db.query(`SELECT k.* FROM calendars k WHERE k.id = $calendarId AND ${readableCalendarPredicate}`).get({ calendarId, userId }) as CalendarRow | null;
}

export function editableCalendar(calendarId: string, userId: string) {
  return db.query(`SELECT k.* FROM calendars k WHERE k.id = $calendarId AND ${editableCalendarPredicate}`).get({ calendarId, userId }) as CalendarRow | null;
}

type LevelSource = Pick<CalendarRow, "id" | "owner_id" | "share_role" | "visibility"> & { deleted_at?: string | null };

/** The caller's level on the calendar (§D.3, D272), capped by the Team role; `none` when binned. */
export function calendarLevel(calendar: LevelSource, userId: string): ItemLevel {
  if (calendar.deleted_at) return "none";
  return audienceLevel({ kind: "calendar", id: calendar.id, ownerId: calendar.owner_id, visibility: calendar.visibility, audienceLevel: shareRoleToLevel(calendar.share_role), memberTable: "calendar_members", memberColumn: "calendar_id" }, userId);
}

/** The role word kept for API compatibility next to `level`: owner, editor (edit or manage), or viewer. */
export function calendarRole(calendar: LevelSource, userId: string): CalendarRole {
  const word = roleWord(calendarLevel(calendar, userId));
  return word === "owner" || canWriteContent(userId) ? word : "viewer";
}

/** A live event on a calendar the caller can read, with that calendar. */
export function readableEvent(eventId: string, userId: string) {
  const event = db.query(`SELECT e.* FROM events e JOIN calendars k ON k.id = e.calendar_id WHERE e.id = $eventId AND e.deleted_at IS NULL AND ${readableCalendarPredicate}`)
    .get({ eventId, userId }) as EventRow | null;
  if (!event) return null;
  return { event, calendar: readableCalendar(event.calendar_id, userId)! };
}
