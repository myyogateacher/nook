import { db } from "../db";
import { readableCalendarPredicate, readableEvent, type EventRow } from "../calendar/access";
import { utcToZoned } from "../calendar/recurrence";
import { nextEventFire } from "../calendar/reminders";
import { isMuted } from "./mutes";
import { enqueueMail, mergeIds, WINDOW_MS, type Payload } from "./outbox";
import type { Recipient, Resolution } from "./resolve";
import { REMINDER_LATE_MS, type OccurrenceTime } from "./templates/calendar";

/**
 * Calendar mail (docs/plan/research/2026-09-28-outbound-email.md §A.2 #22, #24):
 *
 * - Reminders by email: the reminders dispatcher calls `mailReminder` inside the transaction that
 *   writes the bell notification. The outbox row holds ids and instants only; the title, place, and
 *   calendar are read at send time, with access re-checked (T67, T226). Class `reminders`: quiet
 *   hours never hold it (D242).
 * - Event changed or cancelled: a change of time or place, or a move to the Bin, by someone else,
 *   for an occurrence in the next 7 days, mails the calendar's readers who set a reminder on that
 *   event (D238). Coalesced 10 minutes per (recipient, event); the first "before" is kept, so a
 *   change undone within the window sends nothing. A muted calendar sends nothing (D249).
 */

const DAY = 86_400_000;
export const EVENT_CHANGE_HORIZON_MS = 7 * DAY;

function safely(label: string, run: () => void) {
  try {
    run();
  } catch (error) {
    console.error(`Mail enqueue failed: purpose=${label} error=${error instanceof Error ? error.name : "Unknown"}`);
  }
}

export type ReminderFire = { reminderId: string; eventId: string | null; occurrenceStart: string | null; fireAt: string; lateMs: number };

/** #22: one reminder fired with an email channel. Never coalesced: each reminder is its own mail. */
export function mailReminder(userId: string, fire: ReminderFire) {
  safely("calendar.reminder", () => enqueueMail({ userId, template: "calendar.reminder", payload: { ...fire } }));
}

/** The next occurrence of an event from `nowMs`, as mail shows it (all-day events by their date). */
export function nextOccurrenceTime(event: EventRow, nowMs: number): (OccurrenceTime & { startMs: number }) | null {
  // Offset 0 in UTC: the occurrence start itself; an all-day start is that date's midnight in UTC.
  const next = nextEventFire(event, 0, "UTC", nowMs);
  if (!next) return null;
  const start = new Date(next.occurrenceStartMs).toISOString();
  return event.all_day === 1 ? { allDay: true, start: start.slice(0, 10), startMs: next.occurrenceStartMs } : { allDay: false, start, startMs: next.occurrenceStartMs };
}

type Snapshot = { time: OccurrenceTime | null; location: string };
const snapshot = (event: EventRow, nowMs: number): Snapshot => {
  const time = nextOccurrenceTime(event, nowMs);
  return { time: time ? { allDay: time.allDay, start: time.start } : null, location: event.location };
};
const sameSnapshot = (a: Snapshot, b: Snapshot) => a.location === b.location && a.time?.start === b.time?.start && a.time?.allDay === b.time?.allDay;

/**
 * #24: call after an event's change is written (inside the same transaction), with the row as it
 * was before. `after` is null for a move to the Bin.
 */
export function mailEventChanged(actorId: string, before: EventRow, after: EventRow | null, nowMs = Date.now()) {
  safely("calendar.event_changed", () => {
    const was = snapshot(before, nowMs);
    const now = after ? snapshot(after, nowMs) : null;
    if (now && sameSnapshot(was, now)) return;
    const soon = (time: OccurrenceTime | null) => {
      if (!time) return false;
      const startMs = time.allDay ? Date.parse(`${time.start}T00:00:00.000Z`) : Date.parse(time.start);
      return startMs - nowMs <= EVENT_CHANGE_HORIZON_MS;
    };
    if (!soon(was.time) && !(now && soon(now.time))) return;
    const recipients = (db.query("SELECT DISTINCT user_id FROM reminders WHERE event_id = ? AND user_id <> ?").all(before.id, actorId) as Array<{ user_id: string }>).map((row) => row.user_id);
    for (const userId of recipients) {
      if (isMuted(userId, "calendar", before.calendar_id)) continue;
      if (!db.query(`SELECT 1 FROM calendars k WHERE k.id = $calendarId AND ${readableCalendarPredicate}`).get({ calendarId: before.calendar_id, userId })) continue;
      enqueueMail({
        userId, template: "calendar.event_changed",
        payload: { eventId: before.id, before: was, actorIds: [actorId] },
        coalesceKey: `calendar.event_changed:${userId}:${before.id}`, windowMs: WINDOW_MS.activity,
        merge: (queued: Payload, incoming: Payload) => ({ eventId: queued.eventId, before: queued.before, actorIds: mergeIds(queued.actorIds, incoming.actorIds, 10) })
      });
    }
  });
}

const names = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string")
  .map((id) => (db.query("SELECT display_name FROM users WHERE id = ?").get(id) as { display_name: string } | null)?.display_name ?? null)
  .filter((name): name is string => name !== null);

export function resolveReminder(payload: Record<string, unknown>, recipient: Recipient, nowMs: number): Resolution {
  const reminderId = typeof payload.reminderId === "string" ? payload.reminderId : "";
  const reminder = db.query("SELECT title, tz, event_id FROM reminders WHERE id = ? AND user_id = ?").get(reminderId, recipient.id) as { title: string | null; tz: string; event_id: string | null } | null;
  // Removed by its owner since it fired: they no longer want it.
  if (!reminder) return { skip: "empty" };
  const fireAt = typeof payload.fireAt === "string" ? payload.fireAt : new Date(nowMs).toISOString();
  const late = Number(payload.lateMs ?? 0) > REMINDER_LATE_MS || nowMs - Date.parse(fireAt) > REMINDER_LATE_MS;
  if (reminder.event_id === null) {
    return { data: { kind: "standalone", title: reminder.title ?? "Reminder", eventId: null, time: { allDay: false, start: fireAt }, location: null, calendarName: null, tz: reminder.tz, late } };
  }
  const found = readableEvent(reminder.event_id, recipient.id);
  if (!found) return { skip: "access_lost" };
  const occurrence = typeof payload.occurrenceStart === "string" ? payload.occurrenceStart : null;
  const time: OccurrenceTime | null = occurrence
    ? found.event.all_day === 1 ? { allDay: true, start: utcToZoned(Date.parse(occurrence), reminder.tz).slice(0, 10) } : { allDay: false, start: occurrence }
    : null;
  return {
    data: {
      kind: "event", title: found.event.title, eventId: found.event.id, time, location: found.event.location || null,
      calendarName: found.calendar.name, tz: reminder.tz, late
    }
  };
}

export function resolveEventChanged(payload: Record<string, unknown>, recipient: Recipient, nowMs: number): Resolution {
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  if (!db.query("SELECT 1 FROM reminders WHERE event_id = ? AND user_id = ?").get(eventId, recipient.id)) return { skip: "empty" };
  // The audience is checked apart from the Bin state: a cancelled (binned) event is still theirs to hear about.
  const row = db.query(`SELECT e.*, k.name AS calendar_name FROM events e JOIN calendars k ON k.id = e.calendar_id
      WHERE e.id = $eventId AND ${readableCalendarPredicate}`).get({ eventId, userId: recipient.id }) as (EventRow & { deleted_at: string | null; calendar_name: string }) | null;
  if (!row) return { skip: "access_lost" };
  if (isMuted(recipient.id, "calendar", row.calendar_id)) return { skip: "muted" };
  const before = (payload.before ?? { time: null, location: "" }) as Snapshot;
  const cancelled = row.deleted_at !== null;
  const after = cancelled ? null : snapshot(row, nowMs);
  // Changed back within the window: nothing to say.
  if (after && sameSnapshot(before, after)) return { skip: "empty" };
  return { data: { eventId: row.id, title: row.title, calendarName: row.calendar_name, change: cancelled ? "cancelled" : "changed", actors: names(payload.actorIds), before, after } };
}
