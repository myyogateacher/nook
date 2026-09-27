// Pure Calendar display and form helpers. Browser-zone aware through Intl only, so they are unit
// tested by passing a zone explicitly.
import { addDays, daysBetween } from "../calendarRoute";
import type { DueTask, EventDetail, EventInput, Occurrence, RepeatRule, Weekday } from "./calendarApi";

export const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const weekdayNames: Record<Weekday, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
export const CALENDAR_COLORS = ["blue", "green", "amber", "red", "violet", "slate"] as const;

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string) {
  let formatter = partsFormatter.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    partsFormatter.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall date and time of an instant in `timeZone`. */
export function zonedParts(instant: string | number, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Local dates an occurrence covers in the viewer's zone (end exclusive), clamped to [from, to). */
export function occurrenceDays(occurrence: Occurrence, timeZone: string, from: string, to: string) {
  const first = occurrence.allDay ? occurrence.start : zonedParts(occurrence.start, timeZone).date;
  // A timed event ending exactly at midnight does not touch the next day.
  const last = occurrence.allDay ? addDays(occurrence.end, -1) : zonedParts(new Date(occurrence.end).getTime() - 1, timeZone).date;
  const days: string[] = [];
  const start = first < from ? from : first;
  for (let day = start; day <= last && day < to && days.length < 400; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Occurrences by local day for [from, to). Each occurrence is listed on every day it covers. */
export function groupByDay(occurrences: Occurrence[], timeZone: string, from: string, to: string) {
  const days = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    for (const day of occurrenceDays(occurrence, timeZone, from, to)) {
      const list = days.get(day) ?? [];
      list.push(occurrence);
      days.set(day, list);
    }
  }
  return days;
}

/** Agenda rows: each occurrence once, on its first day in range, days in order. */
export function agendaDays(occurrences: Occurrence[], timeZone: string, from: string, to: string) {
  const days = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const first = occurrenceDays(occurrence, timeZone, from, to)[0];
    if (!first) continue;
    const list = days.get(first) ?? [];
    list.push(occurrence);
    days.set(first, list);
  }
  return [...days.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function occurrenceTimeLabel(occurrence: Occurrence, timeZone: string, day: string) {
  if (occurrence.allDay) return "All day";
  const start = zonedParts(occurrence.start, timeZone);
  const end = zonedParts(occurrence.end, timeZone);
  if (start.date !== day) return end.date === day ? `Until ${end.time}` : "All day";
  return end.date === day ? `${start.time}–${end.time}` : `${start.time}→`;
}

export function dayHeading(day: string, today: string) {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC", ...(year !== Number(today.slice(0, 4)) ? { year: "numeric" } : {}) })
    .format(new Date(Date.UTC(year, month - 1, date)));
}

/** "Sun, Sep 27" (with the year when it is not today's): the day in "New event on …". */
export function eventDayLabel(day: string, today: string) {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC", ...(year !== Number(today.slice(0, 4)) ? { year: "numeric" } : {}) })
    .format(new Date(Date.UTC(year, month - 1, date)));
}

export function monthHeading(month: string) {
  const [year, index] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, index - 1, 1)));
}

export function shortDate(day: string) {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, date)));
}

const plural = (count: number, one: string, many: string) => count === 1 ? one : `${count} ${many}`;

/** "Every week on Mon, Wed until Jun 1, 2026", "Every 2 days, 5 times", "Monthly on day 31". */
export function repeatSummary(rule: RepeatRule | null, startDate: string) {
  if (!rule) return "Does not repeat";
  const every = {
    daily: plural(rule.interval, "Every day", "days"),
    weekly: plural(rule.interval, "Every week", "weeks"),
    monthly: plural(rule.interval, "Every month", "months"),
    yearly: plural(rule.interval, "Every year", "years")
  }[rule.freq];
  let text = rule.interval === 1 ? every : `Every ${every}`;
  if (rule.freq === "weekly" && rule.byDay?.length) text += ` on ${rule.byDay.map((day) => weekdayNames[day]).join(", ")}`;
  if (rule.freq === "monthly") text += ` on day ${Number(startDate.slice(8, 10))}`;
  if (rule.until) text += ` until ${shortDate(rule.until)}`;
  if (rule.count) text += `, ${plural(rule.count, "once", "times")}`;
  return text;
}

/** When an event happens, in its own terms (the zone is named when it differs from the viewer's). */
export function eventWhen(event: EventDetail, viewerZone: string) {
  if (event.all_day && event.start_date && event.end_date) {
    const last = addDays(event.end_date, -1);
    return last === event.start_date ? `${shortDate(event.start_date)} · All day` : `${shortDate(event.start_date)} – ${shortDate(last)} · All day`;
  }
  const start = event.start_local ?? "";
  const minutes = event.duration_minutes ?? 0;
  const end = addMinutesLocal(start, minutes);
  const zone = event.tz && event.tz !== viewerZone ? ` (${event.tz})` : "";
  const sameDay = end.slice(0, 10) === start.slice(0, 10);
  return `${shortDate(start.slice(0, 10))} · ${start.slice(11)}–${sameDay ? end.slice(11) : `${shortDate(end.slice(0, 10))} ${end.slice(11)}`}${zone}`;
}

/** Wall-clock arithmetic on `yyyy-mm-ddTHH:MM`, ignoring zones. */
export function addMinutesLocal(local: string, minutes: number) {
  const [date, time] = local.split("T") as [string, string];
  const [hours, mins] = time.split(":").map(Number) as [number, number];
  const total = hours * 60 + mins + minutes;
  const dayShift = Math.floor(total / 1440);
  const rest = ((total % 1440) + 1440) % 1440;
  return `${addDays(date, dayShift)}T${String(Math.floor(rest / 60)).padStart(2, "0")}:${String(rest % 60).padStart(2, "0")}`;
}

export function minutesBetweenLocal(start: string, end: string) {
  const days = daysBetween(start.slice(0, 10), end.slice(0, 10));
  const toMinutes = (value: string) => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
  return days * 1440 + toMinutes(end) - toMinutes(start);
}

// ---------------------------------------------------------------------------
// The create/edit form

export type EventForm = {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  tz: string;
  location: string;
  description: string;
  repeat: RepeatRule | null;
};

/** A new event on `day`: the next whole hour today, or 09:00 on another day, one hour long. */
export function newEventForm(day: string, today: string, now: Date, tz: string): EventForm {
  const hour = day === today ? Math.min(23, now.getHours() + 1) : 9;
  const start = `${day}T${String(hour).padStart(2, "0")}:00`;
  const end = addMinutesLocal(start, 60);
  return { title: "", allDay: false, startDate: day, startTime: start.slice(11), endDate: end.slice(0, 10), endTime: end.slice(11), tz, location: "", description: "", repeat: null };
}

export function formFromEvent(event: EventDetail, tz: string): EventForm {
  if (event.all_day) {
    const start = event.start_date!;
    return { title: event.title, allDay: true, startDate: start, startTime: "09:00", endDate: addDays(event.end_date!, -1), endTime: "10:00", tz, location: event.location, description: event.description, repeat: event.repeat };
  }
  const start = event.start_local!;
  const end = addMinutesLocal(start, event.duration_minutes!);
  return { title: event.title, allDay: false, startDate: start.slice(0, 10), startTime: start.slice(11), endDate: end.slice(0, 10), endTime: end.slice(11), tz: event.tz!, location: event.location, description: event.description, repeat: event.repeat };
}

export function sameForm(left: EventForm, right: EventForm) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The API body for a form, or a user-facing error. All-day end dates are inclusive in the form and exclusive on the server. */
export function formToInput(form: EventForm): { input: EventInput } | { error: string } {
  const title = form.title.trim();
  if (!title) return { error: "Give the event a title" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(form.endDate)) return { error: "Choose the dates" };
  const base = { title, location: form.location.trim(), description: form.description, repeat: form.repeat };
  if (form.allDay) {
    if (form.endDate < form.startDate) return { error: "The event ends before it starts" };
    return { input: { ...base, allDay: true, startDate: form.startDate, endDate: addDays(form.endDate, 1) } };
  }
  if (!/^\d{2}:\d{2}$/.test(form.startTime) || !/^\d{2}:\d{2}$/.test(form.endTime)) return { error: "Choose the times" };
  const start = `${form.startDate}T${form.startTime}`;
  const duration = minutesBetweenLocal(start, `${form.endDate}T${form.endTime}`);
  if (duration < 1) return { error: "The event ends before it starts" };
  if (duration > 10_080) return { error: "An event can last at most 7 days" };
  return { input: { ...base, allDay: false, startLocal: start, tz: form.tz, durationMinutes: duration } };
}

/** Weekday code of a `yyyy-mm-dd` date. */
export function weekdayOf(date: string): Weekday {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7]!;
}

/**
 * Due cards by the viewer's day: the server's `date` (a timed card's local day, which can differ
 * from its `dueOn` in another zone), or `dueOn` from an older server.
 */
export function tasksByDay(tasks: DueTask[]) {
  const days = new Map<string, DueTask[]>();
  for (const task of tasks) {
    const day = task.date ?? task.dueOn;
    const list = days.get(day) ?? [];
    list.push(task);
    days.set(day, list);
  }
  return days;
}

/** The overlay row's time: the viewer's local time of a timed card, or "Due" for a date-only one. */
export const taskTimeLabel = (task: DueTask, timeZone: string) => task.dueAt ? zonedParts(task.dueAt, timeZone).time : "Due";
