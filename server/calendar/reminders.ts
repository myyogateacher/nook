import { audit, db } from "../db";
import { calendarAudiencePredicate, readableEvent, type EventRow } from "./access";
import { isValidTimeZone, nextOccurrence, parseLocal, zonedToUtc, type RecurrenceRule, type SeriesInput } from "./recurrence";

/**
 * Reminders, the dispatcher, and in-app notifications (WAVES_10-12.md §4.1–4.3, D64, T66, T67).
 *
 * A reminder is private to whoever set it. It is either event-relative (`offsetMinutes` before
 * each occurrence starts; negative means after, so 09:00 on an all-day event is -540) or
 * standalone (`title` at a local `fireAt` in `tz`). `next_fire_at` holds the next due instant.
 *
 * The dispatcher runs every 30 s on an unref'd timer, one tick at a time. Each due reminder is
 * claimed, re-checked, turned into a durable `notifications` row, and advanced, all in one
 * transaction. Push delivery (Stage C) hooks in after the commit through `onNotification`.
 */

export const MAX_REMINDERS_PER_EVENT = 10;
export const MAX_STANDALONE_REMINDERS = 500;
export const MIN_OFFSET_MINUTES = -1440;
export const MAX_OFFSET_MINUTES = 40_320;
export const DISPATCH_INTERVAL_MS = 30_000;
export const DISPATCH_BATCH = 200;
export const HOURLY_NOTIFICATION_LIMIT = 60;
/** Reminders missed while the server was down fire once when less late than this; later ones are skipped. */
export const MAX_LATENESS_MS = 24 * 3_600_000;
/** A notification is marked late when it fired this much after its due time. */
export const LATE_AFTER_MS = 2 * 60_000;
export const NOTIFICATION_RETENTION_MS = 30 * 86_400_000;
export const MAX_NOTIFICATIONS_PAGE = 50;
export const MAX_READ_IDS = 100;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ReminderError extends Error {
  constructor(public status: 400 | 404 | 409, message: string, public code?: string) {
    super(message);
  }

  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}) };
  }
}

export type ReminderRow = {
  id: string;
  user_id: string;
  event_id: string | null;
  offset_minutes: number | null;
  title: string | null;
  tz: string;
  next_fire_at: string | null;
  claimed_at: string | null;
  last_fired_at: string | null;
  created_via_key_id: string | null;
  created_at: string;
};

export type ReminderSummary = {
  id: string;
  eventId: string | null;
  offsetMinutes: number | null;
  title: string | null;
  tz: string;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  createdAt: string;
};

const summary = (row: ReminderRow): ReminderSummary => ({
  id: row.id,
  eventId: row.event_id,
  offsetMinutes: row.offset_minutes,
  title: row.title,
  tz: row.tz,
  nextFireAt: row.next_fire_at,
  lastFiredAt: row.last_fired_at,
  createdAt: row.created_at
});

type SeriesRow = Pick<EventRow, "all_day" | "start_date" | "end_date" | "start_local" | "tz" | "duration_minutes" | "rrule_json" | "exdates_json">;

function seriesOf(row: SeriesRow): SeriesInput {
  const base = row.all_day === 1
    ? { allDay: true as const, startDate: row.start_date!, endDate: row.end_date! }
    : { allDay: false as const, startLocal: row.start_local!, tz: row.tz!, durationMinutes: row.duration_minutes! };
  return { ...base, rule: row.rrule_json ? JSON.parse(row.rrule_json) as RecurrenceRule : null, exdates: JSON.parse(row.exdates_json) as string[] };
}

/**
 * The next fire instant of an event reminder: the first occurrence whose fire time
 * (start − offset) is at or after `notBeforeMs` and that starts after `afterStartMs` (so an
 * occurrence never fires twice). Null when the series has no such occurrence.
 */
export function nextEventFire(event: SeriesRow, offsetMinutes: number, tz: string, notBeforeMs: number, afterStartMs = -Infinity) {
  const offsetMs = offsetMinutes * MINUTE_MS;
  const occurrence = nextOccurrence(seriesOf(event), Math.max(notBeforeMs + offsetMs, afterStartMs + 1), tz);
  return occurrence ? { fireMs: occurrence.startMs - offsetMs, occurrenceStartMs: occurrence.startMs } : null;
}

function ownReminder(reminderId: string, userId: string) {
  return db.query("SELECT * FROM reminders WHERE id = ? AND user_id = ?").get(reminderId, userId) as ReminderRow | null;
}

export function listReminders(userId: string, eventId: string | null) {
  const rows = db.query(`SELECT * FROM reminders WHERE user_id = $userId AND ($eventId IS NULL OR event_id = $eventId)
      AND (event_id IS NOT NULL OR next_fire_at IS NOT NULL) ORDER BY next_fire_at IS NULL, next_fire_at, created_at LIMIT 600`)
    .all({ userId, eventId }) as ReminderRow[];
  return { reminders: rows.map(summary) };
}

export type ReminderInput = { eventId: string; offsetMinutes: number; tz: string } | { title: string; fireAt: string; tz: string };

/** Creates a reminder for `userId` only. The event must be readable by them (viewers may set reminders). */
export function createReminder(userId: string, input: ReminderInput, options: { nowMs?: number; keyId?: string | null } = {}) {
  const nowMs = options.nowMs ?? Date.now();
  if (!isValidTimeZone(input.tz)) throw new ReminderError(400, "Unknown time zone");
  const id = crypto.randomUUID();
  const createdAt = iso(nowMs);
  if ("eventId" in input) {
    const found = readableEvent(input.eventId, userId);
    if (!found) throw new ReminderError(404, "Event not found");
    const next = nextEventFire(found.event, input.offsetMinutes, input.tz, nowMs);
    if (!next) throw new ReminderError(400, "This event has no upcoming time for that reminder");
    db.transaction(() => {
      const existing = db.query("SELECT offset_minutes FROM reminders WHERE user_id = ? AND event_id = ?").all(userId, input.eventId) as Array<{ offset_minutes: number }>;
      if (existing.some((row) => row.offset_minutes === input.offsetMinutes)) throw new ReminderError(409, "You already have this reminder", "REMINDER_EXISTS");
      if (existing.length >= MAX_REMINDERS_PER_EVENT) throw new ReminderError(409, `An event can have at most ${MAX_REMINDERS_PER_EVENT} of your reminders`, "LIMIT_REACHED");
      db.query(`INSERT INTO reminders (id, user_id, event_id, offset_minutes, title, tz, next_fire_at, created_via_key_id, created_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(id, userId, input.eventId, input.offsetMinutes, input.tz, iso(next.fireMs), options.keyId ?? null, createdAt);
      audit(userId, null, "reminder.create", { reminderId: id, eventId: input.eventId });
    })();
  } else {
    if (!parseLocal(input.fireAt)) throw new ReminderError(400, "Enter a real date and time");
    const fireMs = zonedToUtc(input.fireAt, input.tz);
    if (fireMs <= nowMs) throw new ReminderError(400, "Choose a time in the future");
    db.transaction(() => {
      const pending = (db.query("SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND event_id IS NULL AND next_fire_at IS NOT NULL").get(userId) as { count: number }).count;
      if (pending >= MAX_STANDALONE_REMINDERS) throw new ReminderError(409, `You can have at most ${MAX_STANDALONE_REMINDERS} upcoming reminders`, "LIMIT_REACHED");
      db.query(`INSERT INTO reminders (id, user_id, event_id, offset_minutes, title, tz, next_fire_at, created_via_key_id, created_at)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`).run(id, userId, input.title, input.tz, iso(fireMs), options.keyId ?? null, createdAt);
      audit(userId, null, "reminder.create", { reminderId: id });
    })();
  }
  return { reminder: summary(ownReminder(id, userId)!) };
}

export function deleteReminder(userId: string, reminderId: string) {
  const result = db.query("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(reminderId, userId);
  if (result.changes !== 1) throw new ReminderError(404, "Reminder not found");
  audit(userId, null, "reminder.delete", { reminderId });
  return { ok: true as const };
}

/**
 * Recomputes `next_fire_at` for every reminder on an event, after its timing changed, it was
 * restored from the Bin, or it got a skipped date. Reminders whose event has no upcoming time
 * become dormant (NULL) and wake up if a later change gives them one.
 */
export function rescheduleEventReminders(eventId: string, nowMs = Date.now()) {
  const event = db.query("SELECT * FROM events WHERE id = ? AND deleted_at IS NULL").get(eventId) as EventRow | null;
  const reminders = db.query("SELECT id, offset_minutes, tz FROM reminders WHERE event_id = ?").all(eventId) as Array<{ id: string; offset_minutes: number; tz: string }>;
  const update = db.query("UPDATE reminders SET next_fire_at = ?, claimed_at = NULL WHERE id = ?");
  for (const reminder of reminders) {
    const next = event ? nextEventFire(event, reminder.offset_minutes, reminder.tz, nowMs) : null;
    update.run(next ? iso(next.fireMs) : null, reminder.id);
  }
}

/** After a calendar comes back from the Bin, its events' reminders are rescheduled. */
export function rescheduleCalendarReminders(calendarId: string, nowMs = Date.now()) {
  const events = db.query("SELECT DISTINCT r.event_id AS id FROM reminders r JOIN events e ON e.id = r.event_id WHERE e.calendar_id = ?").all(calendarId) as Array<{ id: string }>;
  for (const { id } of events) rescheduleEventReminders(id, nowMs);
}

// ---------------------------------------------------------------------------
// Dispatcher

export type DispatchCounts = { notified: number; skipped: number; limited: number; removed: number; dormant: number };
export type NotificationCreated = { id: string; userId: string };

const listeners: Array<(created: NotificationCreated[]) => void> = [];
/** Extension point for Web Push (Stage C): called after each tick's transactions commit. */
export function onNotification(listener: (created: NotificationCreated[]) => void) {
  listeners.push(listener);
  return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
}

/**
 * Hands notifications created outside the dispatcher (agent inbox proposals, D159) to the same
 * listeners, so push delivery stays in one place.
 */
export function emitNotifications(created: NotificationCreated[]) {
  if (!created.length) return;
  for (const listener of listeners) {
    try {
      listener(created);
    } catch (error) {
      console.error("Notification listener failed", error instanceof Error ? error.name : "Unknown error");
    }
  }
}

type DueRow = ReminderRow & { event_live: number | null; calendar_id: string | null };

let dispatching = false;
/**
 * L1: users over the hourly limit, and when their oldest counted notification leaves the window.
 * Their due reminders keep `next_fire_at` and are left out of the due query until then (in
 * memory: after a restart they are simply retried on the first tick).
 */
const deferredUntil = new Map<string, number>();

/** Test hook. */
export function resetReminderDeferrals() {
  deferredUntil.clear();
}

/**
 * One dispatcher tick at `nowMs` (tests pass a fake clock). Single-flight: a tick that starts
 * while another runs returns null. At most DISPATCH_BATCH reminders are handled per tick.
 */
export function runDispatch(options: { nowMs?: number } = {}): DispatchCounts | null {
  if (dispatching) return null;
  dispatching = true;
  const counts: DispatchCounts = { notified: 0, skipped: 0, limited: 0, removed: 0, dormant: 0 };
  const created: NotificationCreated[] = [];
  const limitedByUser = new Map<string, number>();
  try {
    const nowMs = options.nowMs ?? Date.now();
    const now = iso(nowMs);
    for (const [userId, retryMs] of deferredUntil) if (retryMs <= nowMs) deferredUntil.delete(userId);
    const due = db.query(`SELECT r.*, CASE WHEN e.id IS NULL THEN NULL WHEN e.deleted_at IS NULL THEN 1 ELSE 0 END AS event_live, e.calendar_id
        FROM reminders r LEFT JOIN events e ON e.id = r.event_id
        WHERE r.next_fire_at IS NOT NULL AND r.claimed_at IS NULL AND r.next_fire_at <= ?
          AND r.user_id NOT IN (SELECT value FROM json_each(?))
          -- Blocked accounts (T80): their reminders stay due and resume after an unblock.
          AND r.user_id NOT IN (SELECT id FROM users WHERE disabled_at IS NOT NULL) ORDER BY r.next_fire_at LIMIT ?`)
      .all(now, JSON.stringify([...deferredUntil.keys()]), DISPATCH_BATCH) as DueRow[];
    for (const row of due) {
      if (deferredUntil.has(row.user_id)) {
        // Deferred earlier in this tick: leave it due for a later one.
        counts.limited += 1;
        limitedByUser.set(row.user_id, (limitedByUser.get(row.user_id) ?? 0) + 1);
        continue;
      }
      db.transaction(() => {
        const claimed = db.query("UPDATE reminders SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND next_fire_at = ?").run(now, row.id, row.next_fire_at);
        if (claimed.changes !== 1) return;
        const fireMs = Date.parse(row.next_fire_at!);
        const late = nowMs - fireMs;
        let occurrenceStart: string | null = null;
        let next: string | null = null;
        if (row.event_id !== null) {
          // T67: access is re-checked at fire time; losing it deletes the reminder. The audience is
          // checked apart from the Bin state, so a binned calendar or event only pauses reminders.
          const calendar = db.query(`SELECT k.deleted_at FROM calendars k WHERE k.id = $calendarId AND ${calendarAudiencePredicate}`)
            .get({ calendarId: row.calendar_id, userId: row.user_id }) as { deleted_at: string | null } | null;
          if (!calendar) {
            db.query("DELETE FROM reminders WHERE id = ?").run(row.id);
            audit(row.user_id, null, "reminder.removed_access_lost", { reminderId: row.id, eventId: row.event_id });
            counts.removed += 1;
            return;
          }
          if (row.event_live !== 1 || calendar.deleted_at !== null) {
            // A binned event (or calendar) keeps its reminders dormant until it is restored.
            db.query("UPDATE reminders SET next_fire_at = NULL, claimed_at = NULL WHERE id = ?").run(row.id);
            counts.dormant += 1;
            return;
          }
          const event = db.query("SELECT * FROM events WHERE id = ?").get(row.event_id) as EventRow;
          const occurrenceStartMs = fireMs + row.offset_minutes! * MINUTE_MS;
          occurrenceStart = iso(occurrenceStartMs);
          const following = nextEventFire(event, row.offset_minutes!, row.tz, nowMs + 1, occurrenceStartMs);
          next = following ? iso(following.fireMs) : null;
        }
        if (late > MAX_LATENESS_MS) {
          counts.skipped += 1;
        } else {
          const window = db.query("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM notifications WHERE user_id = ? AND created_at > ?")
            .get(row.user_id, iso(nowMs - HOUR_MS)) as { count: number; oldest: string | null };
          if (window.count >= HOURLY_NOTIFICATION_LIMIT) {
            // L1: defer rather than drop. The claim is released and next_fire_at kept, so the
            // reminder fires once the window has room (unless it is by then too late).
            db.query("UPDATE reminders SET claimed_at = NULL WHERE id = ?").run(row.id);
            deferredUntil.set(row.user_id, Math.max(nowMs + 1, Date.parse(window.oldest!) + HOUR_MS));
            counts.limited += 1;
            limitedByUser.set(row.user_id, (limitedByUser.get(row.user_id) ?? 0) + 1);
            return;
          } else {
            const id = crypto.randomUUID();
            db.query("INSERT INTO notifications (id, user_id, reminder_id, event_id, occurrence_start, late, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .run(id, row.user_id, row.id, row.event_id, occurrenceStart, late > LATE_AFTER_MS ? 1 : 0, now);
            created.push({ id, userId: row.user_id });
            counts.notified += 1;
          }
        }
        db.query("UPDATE reminders SET next_fire_at = ?, claimed_at = NULL, last_fired_at = ? WHERE id = ?").run(next, now, row.id);
      })();
    }
  } finally {
    dispatching = false;
  }
  for (const [userId, deferred] of limitedByUser) audit(userId, null, "reminder.rate_limited", { deferred, limit: HOURLY_NOTIFICATION_LIMIT });
  if (created.length) for (const listener of listeners) {
    try {
      listener(created);
    } catch (error) {
      console.error("Notification listener failed", error instanceof Error ? error.name : "Unknown error");
    }
  }
  if (counts.notified || counts.skipped || counts.limited || counts.removed) {
    console.info(`Reminders: ${counts.notified} notified, ${counts.skipped} skipped as too late, ${counts.limited} deferred by the hourly limit, ${counts.removed} removed after access loss`);
  }
  return counts;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the 30 s dispatcher. Claims left by a crash mid-tick are released first. */
export function startDispatcher() {
  if (timer) return;
  db.query("UPDATE reminders SET claimed_at = NULL WHERE claimed_at IS NOT NULL").run();
  timer = setInterval(() => {
    try {
      runDispatch();
    } catch (error) {
      console.error("Reminder dispatch failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, DISPATCH_INTERVAL_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Notifications

export type NotificationItem = { id: string; title: string; href: string; late: boolean; read: boolean; createdAt: string; occurrenceStart: string | null };

/** Same-origin paths built from ids only (T68). */
export function notificationHref(eventId: string | null) {
  return eventId && idPattern.test(eventId) ? `/calendar/event/${eventId}` : "/notifications";
}

type NotificationRow = {
  id: string; event_id: string | null; reminder_title: string | null; late: number; read_at: string | null; created_at: string; occurrence_start: string | null;
  kind: "reminder" | "proposals"; proposal_count: number | null; key_name: string | null; routine_name: string | null;
};

/**
 * A proposals notification (agent inbox D159, T135): "Key “laptop” suggested 2 changes". Only the
 * user's own key name and a count, never agent text; it opens the Inbox.
 */
export function proposalNotificationTitle(keyName: string | null, count: number, routineName: string | null = null) {
  const changes = `${count} change${count === 1 ? "" : "s"}`;
  // A routine run (Wave 22): the user's own routine name, never the run summary.
  if (routineName) return `${routineName} suggested ${changes}`;
  return keyName ? `Key “${keyName}” suggested ${changes}` : `An agent suggested ${changes}`;
}

/**
 * The caller's notifications, newest first. Titles are resolved now, for the caller (T67). One
 * dispatch tick stamps several rows with the same `created_at`; rowid (insertion order) breaks the
 * tie, not the random id.
 */
export function listNotifications(userId: string, options: { unread: boolean; limit: number }) {
  const rows = db.query(`SELECT n.id, n.event_id, r.title AS reminder_title, n.late, n.read_at, n.created_at, n.occurrence_start,
             n.kind, n.proposal_count, k.name AS key_name, ro.name AS routine_name
      FROM notifications n LEFT JOIN reminders r ON r.id = n.reminder_id LEFT JOIN mcp_api_keys k ON k.id = n.proposal_key_id
      LEFT JOIN routine_runs rr ON rr.id = n.run_id LEFT JOIN routines ro ON ro.id = rr.routine_id
      WHERE n.user_id = $userId AND ($unread = 0 OR n.read_at IS NULL) ORDER BY n.created_at DESC, n.rowid DESC LIMIT $limit`)
    .all({ userId, unread: options.unread ? 1 : 0, limit: options.limit }) as NotificationRow[];
  const items = rows.map((row): NotificationItem => {
    if (row.kind === "proposals") {
      return { id: row.id, title: proposalNotificationTitle(row.key_name, row.proposal_count ?? 1, row.routine_name), href: "/inbox", late: false, read: row.read_at !== null, createdAt: row.created_at, occurrenceStart: null };
    }
    const event = row.event_id ? readableEvent(row.event_id, userId) : null;
    const title = event ? event.event.title : row.event_id ? "An event you can no longer open" : row.reminder_title ?? "Reminder";
    return { id: row.id, title, href: notificationHref(event ? row.event_id : null), late: row.late === 1, read: row.read_at !== null, createdAt: row.created_at, occurrenceStart: row.occurrence_start };
  });
  const unreadCount = (db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId) as { count: number }).count;
  return { items, unreadCount };
}

export function markNotificationsRead(userId: string, target: { ids: string[] } | { all: true }, nowMs = Date.now()) {
  const now = iso(nowMs);
  const result = "all" in target
    ? db.query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, userId)
    : db.query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))").run(now, userId, JSON.stringify(target.ids));
  return { ok: true as const, updated: result.changes };
}

/** Sweeper step: notifications older than 30 days, and fired standalone reminders past the same age. */
export function sweepNotifications(nowMs = Date.now()) {
  const cutoff = iso(nowMs - NOTIFICATION_RETENTION_MS);
  const notifications = db.query("DELETE FROM notifications WHERE created_at < ?").run(cutoff).changes;
  const reminders = db.query("DELETE FROM reminders WHERE event_id IS NULL AND next_fire_at IS NULL AND last_fired_at < ?").run(cutoff).changes;
  return { notifications, reminders };
}
