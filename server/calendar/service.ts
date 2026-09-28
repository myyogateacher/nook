import { purgeAfterFrom } from "../bin";
import { audit, db, now } from "../db";
import {
  calendarRole,
  readableCalendar,
  readableCalendarPredicate,
  readableEvent,
  type CalendarColor,
  type CalendarRole,
  type CalendarRow,
  type CalendarVisibility,
  type EventRow,
  type ShareRole
} from "./access";
import { canLinkTarget, MAX_LINKS_PER_EVENT, resolveLink, type LinkTargetType, type ResolvedLink } from "./links";
import { rescheduleEventReminders } from "./reminders";
import { canWriteContent } from "../team/userRole";
import {
  addDays,
  expandSeries,
  isOccurrenceDate,
  isValidTimeZone,
  MAX_INSTANCES,
  normalizeExdates,
  nextOccurrenceBound,
  normalizeRule,
  rangeFor,
  RecurrenceError,
  seriesBounds,
  utcToZoned,
  validateTiming,
  type EventTiming,
  type ExpansionBudget,
  type ExpansionRange,
  type RecurrenceRule,
  type SeriesInput
} from "./recurrence";
import { mailShared, shareMembers } from "../mail/triggers";

export const MAX_CALENDARS_PER_OWNER = 20;
export const MAX_EVENTS_PER_CALENDAR = 20_000;
export const MAX_SHARE_RECIPIENTS = 100;
export const DEFAULT_CALENDAR_NAME = "Personal";
/** Event creations per user per minute (T66). */
export const EVENT_CREATES_PER_MINUTE = 60;
/** Per-request work budget for the range API (T66): rows expanded and recurrence steps taken. */
export const MAX_ROWS_EXAMINED = 5000;
export const MAX_EXPANSION_STEPS = 50_000;
const NEXT_OCCURRENCE_BATCH = 500;

export class CalendarError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429, message: string, public code?: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }

  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...this.extra };
  }
}

const calendarNotFound = () => new CalendarError(404, "Calendar not found");
const eventNotFound = () => new CalendarError(404, "Event not found");
const ownerOnly = () => new CalendarError(403, "Only the calendar's owner can do that", "OWNER_ONLY");
const readOnly = () => new CalendarError(403, "This calendar is shared with you read-only", "READ_ONLY");
const invalid = (message: string) => new CalendarError(400, message);

/** Recurrence and timing errors become 400s with their message. */
function checked<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RecurrenceError) throw invalid(error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Calendars

export type CalendarSummary = {
  id: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  role: CalendarRole;
  name: string;
  color: CalendarColor;
  visibility: CalendarVisibility;
  share_role: ShareRole;
  created_at: string;
  updated_at: string;
};

const summarySelect = `SELECT k.id, k.owner_id, u.display_name AS owner_name, CASE WHEN k.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
  k.name, k.color, k.visibility, k.share_role, k.created_at, k.updated_at FROM calendars k JOIN users u ON u.id = k.owner_id`;

const withRole = (row: Omit<CalendarSummary, "role">, userId: string): CalendarSummary => ({ ...row, role: calendarRole(row, userId) });

function calendarSummary(calendarId: string, userId: string) {
  const row = db.query(`${summarySelect} WHERE k.id = $calendarId AND ${readableCalendarPredicate}`).get({ calendarId, userId }) as Omit<CalendarSummary, "role"> | null;
  return row ? withRole(row, userId) : null;
}

/**
 * The caller's calendars (owned first) and the ones shared with them. D62: a
 * user who has never had a calendar gets "Personal" on first use.
 */
export function listCalendars(userId: string) {
  // Read-only team roles cannot add events, so they are not given an empty Personal calendar.
  if (canWriteContent(userId)) ensurePersonalCalendar(userId);
  const rows = db.query(`${summarySelect} WHERE ${readableCalendarPredicate} ORDER BY is_owner DESC, k.name COLLATE NOCASE, k.id`)
    .all({ userId }) as Array<Omit<CalendarSummary, "role">>;
  return { calendars: rows.map((row) => withRole(row, userId)) };
}

export function ensurePersonalCalendar(userId: string) {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM calendars WHERE owner_id = ? LIMIT 1").get(userId)) return;
    insertCalendar(userId, DEFAULT_CALENDAR_NAME, "blue");
  })();
}

function insertCalendar(userId: string, name: string, color: CalendarColor) {
  const id = crypto.randomUUID();
  const timestamp = now();
  db.query("INSERT INTO calendars (id, owner_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, name, color, timestamp, timestamp);
  audit(userId, null, "calendar.create", { calendarId: id });
  return id;
}

const liveCalendarCount = (ownerId: string) => (db.query("SELECT COUNT(*) AS count FROM calendars WHERE owner_id = ? AND deleted_at IS NULL").get(ownerId) as { count: number }).count;

export function createCalendar(userId: string, input: { name: string; color: CalendarColor }) {
  const id = db.transaction(() => {
    if (liveCalendarCount(userId) >= MAX_CALENDARS_PER_OWNER) throw new CalendarError(409, `You can have at most ${MAX_CALENDARS_PER_OWNER} calendars`, "LIMIT_REACHED");
    return insertCalendar(userId, input.name, input.color);
  })();
  return { calendar: calendarSummary(id, userId)! };
}

/** A readable calendar the caller owns; 404 for strangers, 403 OWNER_ONLY for everyone else shared with. */
function ownedCalendar(calendarId: string, userId: string) {
  const calendar = readableCalendar(calendarId, userId);
  if (!calendar) throw calendarNotFound();
  if (calendar.owner_id !== userId) throw ownerOnly();
  return calendar;
}

export function patchCalendar(userId: string, calendarId: string, input: { name?: string; color?: CalendarColor }) {
  ownedCalendar(calendarId, userId);
  db.query("UPDATE calendars SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
    .run(input.name ?? null, input.color ?? null, now(), calendarId, userId);
  audit(userId, null, "calendar.update", { calendarId });
  return { calendar: calendarSummary(calendarId, userId)! };
}

/** Moves the calendar to the Bin (owner only). Its events stay with it and are hidden while it is binned. */
export function deleteCalendar(userId: string, calendarId: string) {
  ownedCalendar(calendarId, userId);
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  const result = db.query("UPDATE calendars SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
    .run(deletedAt.toISOString(), userId, purgeAfter, calendarId, userId);
  if (result.changes !== 1) throw calendarNotFound();
  audit(userId, null, "calendar.delete", { calendarId });
  return { ok: true as const, purgeAfter };
}

export function getCalendarSharing(userId: string, calendarId: string) {
  const calendar = ownedCalendar(calendarId, userId);
  const users = db.query("SELECT u.id, u.display_name FROM calendar_members m JOIN users u ON u.id = m.user_id WHERE m.calendar_id = ? ORDER BY u.display_name")
    .all(calendarId) as Array<{ id: string; display_name: string }>;
  return { visibility: calendar.visibility, shareRole: calendar.share_role, users };
}

/** Replaces the audience (D54): who can see the calendar and whether they may edit events. Same rules as folder sharing. */
export function putCalendarSharing(userId: string, calendarId: string, input: { visibility: CalendarVisibility; shareRole: ShareRole; userIds: string[] }) {
  ownedCalendar(calendarId, userId);
  if (input.userIds.includes(userId)) throw invalid("The owner cannot be added as a recipient");
  const uniqueIds = [...new Set(input.userIds)];
  if (uniqueIds.length > MAX_SHARE_RECIPIENTS) throw invalid(`Share with at most ${MAX_SHARE_RECIPIENTS} people`);
  if (input.visibility === "selected" && uniqueIds.length === 0) throw invalid("Select at least one user");
  if (input.visibility === "selected") {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const valid = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
    if (valid.length !== uniqueIds.length) throw invalid("One or more users were not found");
  }
  db.transaction(() => {
    const before = shareMembers("calendar_members", "calendar_id", calendarId);
    db.query("DELETE FROM calendar_members WHERE calendar_id = ?").run(calendarId);
    if (input.visibility === "selected") {
      const insert = db.query("INSERT INTO calendar_members (calendar_id, user_id, created_at) VALUES (?, ?, ?)");
      for (const recipientId of uniqueIds) insert.run(calendarId, recipientId, now());
      // "Shared with you" mail (outbound email #23/#25).
      mailShared(userId, "calendar", calendarId, before, uniqueIds);
    }
    const updated = db.query("UPDATE calendars SET visibility = ?, share_role = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
      .run(input.visibility, input.shareRole, now(), calendarId, userId);
    if (updated.changes !== 1) throw calendarNotFound();
  })();
  audit(userId, null, "calendar.sharing_changed", { calendarId, visibility: input.visibility, shareRole: input.shareRole, recipientCount: input.visibility === "selected" ? uniqueIds.length : 0 });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Events

export type EventInput = {
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  startLocal?: string;
  tz?: string;
  durationMinutes?: number;
  repeat?: RecurrenceRule | null;
};
export type EventPatch = Partial<EventInput> & { revision: number };

/** The columns one-step undo restores (D61). */
const SNAPSHOT_COLUMNS = ["title", "description", "location", "all_day", "start_date", "end_date", "start_local", "tz", "duration_minutes", "start_utc", "series_end_utc", "rrule_json", "exdates_json"] as const;
type Snapshot = Pick<EventRow, typeof SNAPSHOT_COLUMNS[number]>;

const snapshotOf = (event: EventRow): Snapshot => Object.fromEntries(SNAPSHOT_COLUMNS.map((column) => [column, event[column]])) as Snapshot;

export type EventDetail = {
  id: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  start_local: string | null;
  tz: string | null;
  duration_minutes: number | null;
  repeat: RecurrenceRule | null;
  exdates: string[];
  revision: number;
  canUndo: boolean;
  changedByKey: boolean;
  /** The MCP key that made the last change, while the key exists. */
  changedByKeyName: string | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
};

const parseRule = (json: string | null) => json === null ? null : JSON.parse(json) as RecurrenceRule;
const parseExdates = (json: string) => JSON.parse(json) as string[];
const userName = (id: string | null) => id === null ? null : (db.query("SELECT display_name FROM users WHERE id = ?").get(id) as { display_name: string } | null)?.display_name ?? null;

const keyName = (id: string | null) => id === null ? null : (db.query("SELECT name FROM mcp_api_keys WHERE id = ?").get(id) as { name: string } | null)?.name ?? null;

export function eventDetail(event: EventRow): EventDetail {
  return {
    id: event.id,
    calendar_id: event.calendar_id,
    title: event.title,
    description: event.description,
    location: event.location,
    all_day: event.all_day === 1,
    start_date: event.start_date,
    end_date: event.end_date,
    start_local: event.start_local,
    tz: event.tz,
    duration_minutes: event.duration_minutes,
    repeat: parseRule(event.rrule_json),
    exdates: parseExdates(event.exdates_json),
    revision: event.revision,
    canUndo: event.prev_json !== null,
    changedByKey: event.updated_via_key_id !== null,
    changedByKeyName: keyName(event.updated_via_key_id),
    created_by_name: userName(event.created_by),
    updated_by_name: userName(event.updated_by),
    created_at: event.created_at,
    updated_at: event.updated_at
  };
}

const seriesOf = (row: Pick<EventRow, "all_day" | "start_date" | "end_date" | "start_local" | "tz" | "duration_minutes" | "rrule_json" | "exdates_json">): SeriesInput => {
  const base = row.all_day === 1
    ? { allDay: true as const, startDate: row.start_date!, endDate: row.end_date! }
    : { allDay: false as const, startLocal: row.start_local!, tz: row.tz!, durationMinutes: row.duration_minutes! };
  return { ...base, rule: parseRule(row.rrule_json), exdates: parseExdates(row.exdates_json) };
};

/** Builds and validates the stored timing columns from a (merged) input. */
function timingColumns(input: EventInput, exdates: string[]) {
  const timing: EventTiming = input.allDay
    ? { allDay: true, startDate: input.startDate ?? "", endDate: input.endDate ?? "" }
    : { allDay: false, startLocal: input.startLocal ?? "", tz: input.tz ?? "", durationMinutes: input.durationMinutes ?? 0 };
  return checked(() => {
    validateTiming(timing);
    const rule = input.repeat ? normalizeRule(input.repeat, timing) : null;
    const normalizedExdates = rule ? normalizeExdates(exdates) : [];
    const bounds = seriesBounds({ ...timing, rule, exdates: normalizedExdates });
    return {
      all_day: timing.allDay ? 1 as const : 0 as const,
      start_date: timing.allDay ? timing.startDate : null,
      end_date: timing.allDay ? timing.endDate : null,
      start_local: timing.allDay ? null : timing.startLocal,
      tz: timing.allDay ? null : timing.tz,
      duration_minutes: timing.allDay ? null : timing.durationMinutes,
      start_utc: bounds.startUtc,
      series_end_utc: bounds.seriesEndUtc,
      rrule_json: rule ? JSON.stringify(rule) : null,
      exdates_json: JSON.stringify(normalizedExdates)
    };
  });
}

/** A readable calendar the caller may write events on: 404 for strangers, 403 READ_ONLY for viewers. */
function writableCalendar(calendarId: string, userId: string) {
  const calendar = readableCalendar(calendarId, userId);
  if (!calendar) throw calendarNotFound();
  // Defence in depth for MCP (§5.4): a read-only team role never writes, even as the owner.
  if (calendarRole(calendar, userId) === "viewer" || !canWriteContent(userId)) throw readOnly();
  return calendar;
}

function writableEvent(eventId: string, userId: string) {
  const found = readableEvent(eventId, userId);
  if (!found) throw eventNotFound();
  if (calendarRole(found.calendar, userId) === "viewer" || !canWriteContent(userId)) throw readOnly();
  return found;
}

const eventById = (eventId: string) => db.query("SELECT * FROM events WHERE id = ?").get(eventId) as EventRow;

/** Writes the range-index bound of migration 014 for one event, from `nowMs`. */
function refreshNextOccurrence(event: EventRow, nowMs = Date.now()) {
  let bound: string | null;
  try {
    bound = nextOccurrenceBound(seriesOf(event), nowMs);
  } catch {
    // Unreadable timing: the first start is always a safe lower bound.
    bound = event.start_utc;
  }
  db.query("UPDATE events SET next_occurrence_utc = ?, next_occurrence_from = ?, next_occurrence_revision = ? WHERE id = ?")
    .run(bound, new Date(nowMs).toISOString(), event.revision, event.id);
}

/**
 * Boot: fills the range-index bound for events that have none (rows from before migration 014, or
 * written by a path that does not refresh it), in batches, yielding between them.
 */
export async function reconcileEventNextOccurrences(nowMs = Date.now()) {
  let updated = 0;
  for (;;) {
    const rows = db.query("SELECT * FROM events WHERE next_occurrence_from IS NULL OR next_occurrence_revision IS NOT revision LIMIT ?").all(NEXT_OCCURRENCE_BATCH) as EventRow[];
    if (!rows.length) return updated;
    db.transaction(() => { for (const row of rows) refreshNextOccurrence(row, nowMs); })();
    updated += rows.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const createWindows = new Map<string, { count: number; resetAt: number }>();

/** Fixed one-minute window per user; a refused creation costs nothing. */
function chargeEventCreate(userId: string, nowMs: number) {
  if (createWindows.size > 5000) for (const [key, window] of createWindows) if (window.resetAt <= nowMs) createWindows.delete(key);
  let window = createWindows.get(userId);
  if (!window || window.resetAt <= nowMs) {
    window = { count: 0, resetAt: nowMs + 60_000 };
    createWindows.set(userId, window);
  }
  if (window.count >= EVENT_CREATES_PER_MINUTE) {
    throw new CalendarError(429, "Too many new events. Try again in a minute.", "RATE_LIMITED", { retryAfter: Math.ceil((window.resetAt - nowMs) / 1000) });
  }
  window.count += 1;
}

/** Test hook. */
export function resetEventCreateLimit() {
  createWindows.clear();
}

function eventResponse(event: EventRow, calendar: CalendarRow, userId: string) {
  const links = db.query("SELECT target_type, target_id FROM event_links WHERE event_id = ? ORDER BY rowid")
    .all(event.id) as Array<{ target_type: LinkTargetType; target_id: string }>;
  return {
    event: eventDetail(event),
    calendar: calendarSummary(calendar.id, userId)!,
    role: calendarRole(calendar, userId),
    links: links.map((link) => resolveLink(link.target_type, link.target_id, userId))
  };
}

/** Who made a write: `keyId` marks it as made through that MCP key (T73's "Changed by key"). */
export type WriteOptions = { keyId?: string | null };

export function createEvent(userId: string, calendarId: string, input: EventInput, options: WriteOptions = {}, nowMs = Date.now()) {
  writableCalendar(calendarId, userId);
  const columns = timingColumns(input, []);
  chargeEventCreate(userId, nowMs);
  const id = crypto.randomUUID();
  const timestamp = now();
  db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM events WHERE calendar_id = ? AND deleted_at IS NULL").get(calendarId) as { count: number }).count;
    if (count >= MAX_EVENTS_PER_CALENDAR) throw new CalendarError(409, `A calendar holds at most ${MAX_EVENTS_PER_CALENDAR} events`, "LIMIT_REACHED");
    db.query(`INSERT INTO events (id, calendar_id, title, description, location, all_day, start_date, end_date, start_local, tz, duration_minutes,
        start_utc, series_end_utc, rrule_json, exdates_json, updated_via_key_id, created_by, updated_by, created_at, updated_at)
      VALUES ($id, $calendarId, $title, $description, $location, $all_day, $start_date, $end_date, $start_local, $tz, $duration_minutes,
        $start_utc, $series_end_utc, $rrule_json, $exdates_json, $keyId, $userId, $userId, $timestamp, $timestamp)`)
      .run({ id, calendarId, title: input.title, description: input.description ?? "", location: input.location ?? "", ...columns, keyId: options.keyId ?? null, userId, timestamp });
    refreshNextOccurrence(eventById(id), nowMs);
    audit(userId, null, "event.create", { eventId: id, calendarId });
  })();
  const found = readableEvent(id, userId)!;
  return eventResponse(found.event, found.calendar, userId);
}

export function getEvent(userId: string, eventId: string) {
  const found = readableEvent(eventId, userId);
  if (!found) throw eventNotFound();
  return eventResponse(found.event, found.calendar, userId);
}

const changed = (event: EventRow) => new CalendarError(409, "This event was changed by someone else", "EVENT_CHANGED", { event: eventDetail(event), revision: event.revision });

/**
 * Applies new column values with a compare-and-swap on `revision`, keeping
 * the previous values for one-step undo (D61). Returns the updated row.
 */
function applyChange(event: EventRow, userId: string, baseRevision: number, values: Partial<Snapshot>, eventType: string, metadata: Record<string, unknown> = {}, keyId: string | null = null) {
  const next = { ...snapshotOf(event), ...values };
  const timestamp = now();
  const result = db.query(`UPDATE events SET title = $title, description = $description, location = $location, all_day = $all_day,
      start_date = $start_date, end_date = $end_date, start_local = $start_local, tz = $tz, duration_minutes = $duration_minutes,
      start_utc = $start_utc, series_end_utc = $series_end_utc, rrule_json = $rrule_json, exdates_json = $exdates_json,
      prev_json = $prev, prev_revision = revision, revision = revision + 1, updated_by = $userId, updated_via_key_id = $keyId, updated_at = $timestamp
    WHERE id = $id AND revision = $revision AND deleted_at IS NULL`)
    .run({ ...next, prev: JSON.stringify(snapshotOf(event)), userId, keyId, timestamp, id: event.id, revision: baseRevision });
  if (result.changes !== 1) throw changed(eventById(event.id));
  refreshNextOccurrence(eventById(event.id));
  audit(userId, null, eventType, { eventId: event.id, ...metadata });
  return eventById(event.id);
}

export function patchEvent(userId: string, eventId: string, patch: EventPatch, options: WriteOptions = {}) {
  const { event, calendar } = writableEvent(eventId, userId);
  if (event.revision !== patch.revision) throw changed(event);
  const current = eventDetail(event);
  const timingKeys = ["allDay", "startDate", "endDate", "startLocal", "tz", "durationMinutes", "repeat"] as const;
  let values: Partial<Snapshot> = {};
  if (timingKeys.some((key) => patch[key] !== undefined)) {
    const allDay = patch.allDay ?? current.all_day;
    const merged: EventInput = allDay
      ? { title: "", allDay, startDate: patch.startDate ?? current.start_date ?? undefined, endDate: patch.endDate ?? current.end_date ?? undefined }
      : { title: "", allDay, startLocal: patch.startLocal ?? current.start_local ?? undefined, tz: patch.tz ?? current.tz ?? undefined, durationMinutes: patch.durationMinutes ?? current.duration_minutes ?? undefined };
    merged.repeat = patch.repeat === undefined ? current.repeat : patch.repeat;
    values = timingColumns(merged, current.exdates);
  }
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.location !== undefined) values.location = patch.location;
  const updated = db.transaction(() => applyChange(event, userId, patch.revision, values, "event.update", {}, options.keyId ?? null))();
  rescheduleEventReminders(eventId);
  return eventResponse(updated, calendar, userId);
}

/** One-step undo of the last change, from anyone with write access (D61). Undo is itself not undoable. */
export function undoEvent(userId: string, eventId: string, revision: number) {
  const { event, calendar } = writableEvent(eventId, userId);
  if (event.revision !== revision) throw changed(event);
  if (event.prev_json === null) throw new CalendarError(409, "There is nothing to undo", "NOTHING_TO_UNDO");
  const previous = JSON.parse(event.prev_json) as Snapshot;
  const timestamp = now();
  const result = db.query(`UPDATE events SET title = $title, description = $description, location = $location, all_day = $all_day,
      start_date = $start_date, end_date = $end_date, start_local = $start_local, tz = $tz, duration_minutes = $duration_minutes,
      start_utc = $start_utc, series_end_utc = $series_end_utc, rrule_json = $rrule_json, exdates_json = $exdates_json,
      prev_json = NULL, prev_revision = NULL, revision = revision + 1, updated_by = $userId, updated_via_key_id = NULL, updated_at = $timestamp
    WHERE id = $id AND revision = $revision AND deleted_at IS NULL AND prev_json IS NOT NULL`)
    .run({ ...previous, userId, timestamp, id: eventId, revision });
  if (result.changes !== 1) throw changed(eventById(eventId));
  refreshNextOccurrence(eventById(eventId));
  audit(userId, null, "event.undo", { eventId });
  rescheduleEventReminders(eventId);
  return eventResponse(eventById(eventId), calendar, userId);
}

/** Skips one occurrence of a repeating event. `date` is the occurrence's local start date. */
export function addExdate(userId: string, eventId: string, date: string, revision?: number) {
  const { event, calendar } = writableEvent(eventId, userId);
  if (revision !== undefined && event.revision !== revision) throw changed(event);
  const series = seriesOf(event);
  if (!series.rule) throw invalid("Only repeating events can skip a date");
  if (!isOccurrenceDate(series, date)) throw invalid("That date is not an occurrence of this event");
  const exdates = parseExdates(event.exdates_json);
  if (exdates.includes(date)) return eventResponse(event, calendar, userId);
  const normalized = checked(() => normalizeExdates([...exdates, date]));
  const updated = db.transaction(() => applyChange(event, userId, event.revision, { exdates_json: JSON.stringify(normalized) }, "event.exdate"))();
  rescheduleEventReminders(eventId);
  return eventResponse(updated, calendar, userId);
}

/** Moves the event to the Bin (anyone with write access). Listed there for the calendar owner and the deleter (D68). */
export function deleteEvent(userId: string, eventId: string) {
  writableEvent(eventId, userId);
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  const result = db.query("UPDATE events SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL")
    .run(deletedAt.toISOString(), userId, purgeAfter, eventId);
  if (result.changes !== 1) throw eventNotFound();
  audit(userId, null, "event.delete", { eventId });
  return { ok: true as const, purgeAfter };
}

export function addEventLink(userId: string, eventId: string, targetType: LinkTargetType, targetId: string) {
  writableEvent(eventId, userId);
  // The linker must be able to read the target; an unreadable one is indistinguishable from a missing one.
  if (!canLinkTarget(targetType, targetId, userId)) throw new CalendarError(404, "Link target not found");
  return db.transaction(() => {
    if (db.query("SELECT 1 FROM event_links WHERE event_id = ? AND target_type = ? AND target_id = ?").get(eventId, targetType, targetId)) {
      return { status: 200 as const, link: resolveLink(targetType, targetId, userId) };
    }
    const count = (db.query("SELECT COUNT(*) AS count FROM event_links WHERE event_id = ?").get(eventId) as { count: number }).count;
    if (count >= MAX_LINKS_PER_EVENT) throw new CalendarError(409, `An event can have at most ${MAX_LINKS_PER_EVENT} links`, "LIMIT_REACHED");
    db.query("INSERT INTO event_links (event_id, target_type, target_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)").run(eventId, targetType, targetId, userId, now());
    audit(userId, null, "event.link", { eventId, targetType, targetId });
    return { status: 201 as const, link: resolveLink(targetType, targetId, userId) };
  })();
}

export function removeEventLink(userId: string, eventId: string, targetType: LinkTargetType, targetId: string) {
  writableEvent(eventId, userId);
  const result = db.query("DELETE FROM event_links WHERE event_id = ? AND target_type = ? AND target_id = ?").run(eventId, targetType, targetId);
  if (result.changes !== 1) throw new CalendarError(404, "Link not found");
  audit(userId, null, "event.unlink", { eventId, targetType, targetId });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Range listing

export type OccurrenceItem = {
  eventId: string;
  calendarId: string;
  title: string;
  location: string;
  color: CalendarColor;
  allDay: boolean;
  /** Local start date of the occurrence (the date an exdate names). */
  date: string;
  /** UTC ISO instants for timed events; dates (end exclusive) for all-day events. */
  start: string;
  end: string;
  recurring: boolean;
};

const DAY_MS = 86_400_000;

/**
 * Occurrences of live events on readable calendars (optionally only
 * `calendarIds`) overlapping the range, expanded server-side, sorted by start,
 * at most MAX_INSTANCES in total (T66). Calendar ids the caller cannot read
 * are ignored. Rows whose stored next-occurrence bound (migration 014) lies
 * past the range are skipped unexpanded; the rest are expanded within a work
 * budget of MAX_ROWS_EXAMINED rows and MAX_EXPANSION_STEPS recurrence steps,
 * and `truncated` is true when the budget ran out.
 */
export function listOccurrences(userId: string, range: ExpansionRange, calendarIds: string[] | null) {
  // All-day rows are stored as UTC midnight; a day of slack covers every viewer zone.
  const lower = new Date(range.startMs - 2 * DAY_MS).toISOString();
  const upper = new Date(range.endMs + 2 * DAY_MS).toISOString();
  const filter = calendarIds === null ? "" : `AND k.id IN (SELECT value FROM json_each($calendarIds))`;
  const rows = db.query(`SELECT e.*, k.color AS calendar_color FROM events e JOIN calendars k ON k.id = e.calendar_id
      WHERE e.deleted_at IS NULL AND ${readableCalendarPredicate} ${filter}
        AND e.start_utc < $upper AND (e.series_end_utc IS NULL OR e.series_end_utc > $lower)
        AND (e.next_occurrence_from IS NULL OR e.next_occurrence_revision IS NOT e.revision OR e.next_occurrence_from > $lower OR e.next_occurrence_utc < $upper)
      ORDER BY e.start_utc, e.id LIMIT $rowLimit`)
    .all({ userId, upper, lower, rowLimit: MAX_ROWS_EXAMINED + 1, ...(calendarIds === null ? {} : { calendarIds: JSON.stringify(calendarIds) }) }) as Array<EventRow & { calendar_color: CalendarColor }>;
  const items: Array<OccurrenceItem & { sortKey: string }> = [];
  let truncated = rows.length > MAX_ROWS_EXAMINED;
  const budget: ExpansionBudget = { steps: MAX_EXPANSION_STEPS };
  const byStart = (left: { sortKey: string; eventId: string }, right: { sortKey: string; eventId: string }) =>
    left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
  // L3: when the cap hits, keep the soonest occurrences across every series, not the first series'.
  // The buffer is trimmed back to MAX_INSTANCES whenever it doubles, so it stays bounded.
  const keepSoonest = () => {
    items.sort(byStart);
    if (items.length > MAX_INSTANCES) {
      items.length = MAX_INSTANCES;
      truncated = true;
    }
  };
  for (const row of rows.slice(0, MAX_ROWS_EXAMINED)) {
    const { occurrences, truncated: cut } = expandSeries(seriesOf(row), range, MAX_INSTANCES, budget);
    for (const occurrence of occurrences) {
      const start = occurrence.allDay ? occurrence.startDate : new Date(occurrence.startMs).toISOString();
      const end = occurrence.allDay ? occurrence.endDate : new Date(occurrence.endMs).toISOString();
      items.push({
        eventId: row.id, calendarId: row.calendar_id, title: row.title, location: row.location, color: row.calendar_color,
        allDay: occurrence.allDay, date: occurrence.date, start, end, recurring: row.rrule_json !== null,
        // All-day items sort before timed items of the same day.
        sortKey: occurrence.allDay ? `${occurrence.startDate}T00:00:00.000Z!0` : `${start}!1`
      });
    }
    if (cut) truncated = true;
    if (budget.steps < 0) break;
    if (items.length >= 2 * MAX_INSTANCES) keepSoonest();
  }
  keepSoonest();
  return { occurrences: items.map(({ sortKey: _sortKey, ...item }) => item), truncated };
}

export const UPCOMING_LIMIT = 10;

/**
 * The provider for Today's `upcoming` section (D51, D52; wired in Wave 10): occurrences on
 * readable calendars from now through the next `days` local days in `tz`, not yet ended, at most
 * 10 with `more` when there are others. Uses the same predicate and expansion as the range API.
 */
export function listUpcoming(userId: string, tz: string, days = 7, nowMs = Date.now()) {
  if (!isValidTimeZone(tz)) throw invalid("Unknown time zone");
  const span = Math.min(100, Math.max(1, Math.floor(days)));
  const today = checked(() => utcToZoned(nowMs, tz).slice(0, 10));
  const range = checked(() => rangeFor(today, addDays(today, span), tz));
  const live = listOccurrences(userId, range, null).occurrences
    .filter((item) => item.allDay ? item.end > today : Date.parse(item.end) > nowMs);
  return { items: live.slice(0, UPCOMING_LIMIT), more: live.length > UPCOMING_LIMIT };
}
