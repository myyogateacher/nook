import { useEffect, useState } from "react";
import { Bell, Check, Plus, X } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { nextOccurrence, type SeriesInput } from "../../shared/calendarRecurrence";
import type { EventDetail } from "./calendarApi";

export type ReminderSummary = { id: string; eventId: string | null; offsetMinutes: number | null; title: string | null; tz: string; nextFireAt: string | null; lastFiredAt: string | null; createdAt: string };

export const listEventReminders = (eventId: string) => api<{ reminders: ReminderSummary[] }>(`/reminders?eventId=${encodeURIComponent(eventId)}`);
export const addEventReminder = (eventId: string, offsetMinutes: number, tz: string) =>
  api<{ reminder: ReminderSummary }>("/reminders", { method: "POST", body: JSON.stringify({ eventId, offsetMinutes, tz }) });
export const removeReminder = (id: string) => api<{ ok: true }>(`/reminders/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });

/** Choices offered in the picker. All-day events start at local midnight, so "9:00 on the day" is -540. */
export const TIMED_OFFSETS = [0, 5, 10, 15, 30, 60, 120, 1440, 10_080];
export const ALL_DAY_OFFSETS = [-540, 900, 2340, 9540];

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** How a reminder reads: "15 minutes before", "At the start", "9:00 the day before". */
export function reminderLabel(offsetMinutes: number, allDay: boolean) {
  if (allDay) {
    // Fire time relative to the day's midnight, as a wall time on some day.
    const minutesIntoDay = ((-offsetMinutes % 1440) + 1440) % 1440;
    const daysBefore = Math.ceil(offsetMinutes / 1440);
    const time = `${Math.floor(minutesIntoDay / 60)}:${String(minutesIntoDay % 60).padStart(2, "0")}`;
    if (daysBefore <= 0) return `${time} on the day`;
    if (daysBefore === 1) return `${time} the day before`;
    if (daysBefore === 7) return `${time} a week before`;
    return `${time}, ${plural(daysBefore, "day")} before`;
  }
  if (offsetMinutes === 0) return "At the start";
  const after = offsetMinutes < 0;
  const minutes = Math.abs(offsetMinutes);
  const amount = minutes % 10_080 === 0 ? plural(minutes / 10_080, "week")
    : minutes % 1440 === 0 ? plural(minutes / 1440, "day")
    : minutes % 60 === 0 ? plural(minutes / 60, "hour")
    : plural(minutes, "minute");
  return `${amount} ${after ? "after the start" : "before"}`;
}

type EventRemindersProps = { eventId: string; allDay: boolean; reloadKey: number; onAdd: (existing: number[]) => void; onRemove: (reminder: ReminderSummary) => void };

/** The event page's "My reminders": private to the viewer, whatever their role on the calendar. */
export function EventReminders({ eventId, allDay, reloadKey, onAdd, onRemove }: EventRemindersProps) {
  const [reminders, setReminders] = useState<ReminderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    listEventReminders(eventId).then((result) => { if (active) setReminders(result.reminders); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load your reminders"); });
    return () => { active = false; };
  }, [eventId, reloadKey]);

  const existing = (reminders ?? []).map((reminder) => reminder.offsetMinutes ?? 0);
  return <section className="calendar-event-section" aria-labelledby="calendar-reminders-title">
    <h2 id="calendar-reminders-title"><Bell />My reminders</h2>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
    {reminders && !reminders.length && <p className="calendar-note">Only you see your reminders. They appear under the bell when they are due.</p>}
    {reminders && reminders.length > 0 && <ul className="calendar-links">
      {reminders.map((reminder) => {
        const label = reminderLabel(reminder.offsetMinutes ?? 0, allDay);
        return <li key={reminder.id}>
          <span className="calendar-link"><Bell aria-hidden="true" /><span><strong>{label}</strong><small>{reminder.nextFireAt ? `Next ${new Date(reminder.nextFireAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "No upcoming time"}</small></span></span>
          <button className="icon-button" onClick={() => onRemove(reminder)} aria-label={`Remove reminder ${label}`}><X /></button>
        </li>;
      })}
    </ul>}
    {reminders && reminders.length < 10 && <button className="secondary-button calendar-link-add" onClick={() => onAdd(existing)}><Plus />Add reminder</button>}
  </section>;
}

/** The event's timing as the recurrence helpers read it (the server's `seriesOf`), or null when incomplete. */
export function eventSeries(event: Pick<EventDetail, "all_day" | "start_date" | "end_date" | "start_local" | "tz" | "duration_minutes" | "repeat" | "exdates">): SeriesInput | null {
  const rule = event.repeat ?? null;
  if (event.all_day) return event.start_date && event.end_date ? { allDay: true, startDate: event.start_date, endDate: event.end_date, rule, exdates: event.exdates } : null;
  return event.start_local && event.tz && event.duration_minutes !== null ? { allDay: false, startLocal: event.start_local, tz: event.tz, durationMinutes: event.duration_minutes, rule, exdates: event.exdates } : null;
}

/**
 * When a reminder `offsetMinutes` before the start would next fire (the server's `nextEventFire`):
 * at the first occurrence whose fire time is still ahead, so a weekly event's 5-minute reminder
 * moves to next week once this week's has passed. Null when no occurrence has it ahead.
 */
export function nextReminderFire(series: SeriesInput, offsetMinutes: number, tz: string, nowMs: number) {
  const offsetMs = offsetMinutes * 60_000;
  const occurrence = nextOccurrence(series, nowMs + offsetMs, tz);
  return occurrence ? occurrence.startMs - offsetMs : null;
}

/** The server's refusal when an event has no upcoming time for a reminder (reminders.ts). */
const NO_UPCOMING_TIME = "This event has no upcoming time for that reminder";
export const PASSED_MESSAGE = "That reminder time has already passed.";
export const EVENT_OVER_MESSAGE = "This event has already happened, so there is nothing to remind you about.";
export const SERIES_OVER_MESSAGE = "This series has ended.";

type ReminderPickerProps = {
  allDay: boolean; existing: number[]; onPick: (offsetMinutes: number) => Promise<void>; onClose: () => void;
  /** The event, so options whose time has passed are disabled (QA 0.9.2); without it every option is offered. */
  event?: Parameters<typeof eventSeries>[0] | null;
  /** The viewer's zone (all-day events start at their midnight) and the clock, for tests. */
  timeZone?: string;
  nowMs?: number;
};

/**
 * The reminder picker sheet. Pushes no history entry; Back closes it (D69). Each option is checked
 * against the event's next occurrence: one whose time has passed is disabled with "Already
 * passed", and an event with no upcoming occurrence shows a notice and Close instead of the list
 * (QA 0.9.2). The server's check stays the source of truth; its refusal reads the same way.
 */
export function ReminderPicker({ allDay, existing, onPick, onClose, event = null, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, nowMs }: ReminderPickerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<number[]>([]);
  const options = allDay ? ALL_DAY_OFFSETS : TIMED_OFFSETS;
  const now = nowMs ?? Date.now();
  const series = event ? eventSeries(event) : null;
  const over = series ? nextOccurrence(series, now, timeZone) === null : false;
  const passed = (offset: number) => refused.includes(offset) || (series ? nextReminderFire(series, offset, timeZone, now) === null : false);

  async function pick(offset: number) {
    setBusy(true);
    setError(null);
    try {
      await onPick(offset);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not add the reminder";
      if (message === NO_UPCOMING_TIME) {
        setRefused((current) => [...current, offset]);
        setError(PASSED_MESSAGE);
      } else setError(message);
      setBusy(false);
    }
  }

  if (over) return <ModalDialog title="Remind me" eyebrow="Event" onClose={onClose} variant="sheet" className="calendar-reminder-dialog">
    <p className="file-dialog-copy calendar-reminder-over" role="status">{series?.rule ? SERIES_OVER_MESSAGE : EVENT_OVER_MESSAGE}</p>
    <footer className="file-dialog-actions">
      <button type="button" className="primary-button" autoFocus onClick={onClose}>Close</button>
    </footer>
  </ModalDialog>;

  const available = (offset: number) => !existing.includes(offset) && !passed(offset);
  return <ModalDialog title="Remind me" eyebrow="Event" onClose={onClose} variant="sheet" busy={busy} className="calendar-reminder-dialog">
    <div className="move-list" role="list" aria-label="When">
      {options.map((offset) => {
        const taken = existing.includes(offset);
        const gone = !taken && passed(offset);
        return <button key={offset} role="listitem" className={`move-option${gone ? " calendar-reminder-passed" : ""}`} disabled={taken || gone || busy}
          autoFocus={offset === options.find(available)} onClick={() => { void pick(offset); }}>
          <Bell aria-hidden="true" />
          <span>{reminderLabel(offset, allDay)}{taken ? <small>Already set</small> : gone ? <small>Already passed</small> : null}</span>
          {taken && <Check aria-hidden="true" />}
        </button>;
      })}
    </div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
  </ModalDialog>;
}
