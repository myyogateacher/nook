import { addDays, dateToDay, utcToZoned, zonedToUtc } from "./calendarRecurrence";

/**
 * Routine schedules (docs/plan/research/2026-09-28-agent-inbox-routines.md D153): a hint, not a
 * timer. Nook never wakes anything up; it only says when a routine is next due. Five cadences,
 * no cron parser: `manual` (never due, can still be started), `hourly` at minute MM of every hour,
 * and `daily`, `weekdays` (Monday to Friday), or `weekly` (one weekday) at HH:MM, all as wall-clock
 * times in the routine's zone. A wall time a DST jump skips moves forward by the gap; one that
 * repeats uses the earlier instant (the calendar's zonedToUtc rules). Pure, shared by server and client.
 */

export const CADENCES = ["manual", "hourly", "daily", "weekdays", "weekly"] as const;
export type Cadence = typeof CADENCES[number];

/** `weekday` uses JavaScript's numbering: 0 is Sunday, 6 is Saturday (the 021 CHECK). */
export type RoutineSchedule = { cadence: Cadence; atTime: string | null; weekday: number | null; tz: string };

export const isCadence = (value: unknown): value is Cadence => typeof value === "string" && (CADENCES as readonly string[]).includes(value);
export const isAtTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Checks the fields a cadence needs; returns a user-facing message, or null when valid. */
export function scheduleProblem(schedule: RoutineSchedule): string | null {
  if (!isCadence(schedule.cadence)) return "Choose how often the routine runs";
  if (schedule.cadence === "manual") return null;
  if (!isAtTime(schedule.atTime)) return schedule.cadence === "hourly" ? "Choose the minute past each hour" : "Choose a time of day (HH:MM)";
  if (schedule.cadence === "weekly" && (schedule.weekday === null || !Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6)) return "Choose a day of the week";
  return null;
}

const weekdayOf = (date: string) => new Date(dateToDay(date) * 86_400_000).getUTCDay();

function dayMatches(schedule: RoutineSchedule, date: string) {
  if (schedule.cadence === "daily" || schedule.cadence === "hourly") return true;
  const weekday = weekdayOf(date);
  if (schedule.cadence === "weekdays") return weekday >= 1 && weekday <= 5;
  return weekday === schedule.weekday;
}

/** Every slot instant (UTC ms) on local dates within `spanDays` of the local date at `aroundMs`, sorted. */
function slotsAround(schedule: RoutineSchedule, aroundMs: number, spanDays: number): number[] {
  const today = utcToZoned(aroundMs, schedule.tz).slice(0, 10);
  const minute = schedule.atTime!.slice(3, 5);
  const slots = new Set<number>();
  for (let offset = -spanDays; offset <= spanDays; offset += 1) {
    const date = addDays(today, offset);
    if (!dayMatches(schedule, date)) continue;
    if (schedule.cadence === "hourly") {
      for (let hour = 0; hour < 24; hour += 1) slots.add(zonedToUtc(`${date}T${String(hour).padStart(2, "0")}:${minute}`, schedule.tz));
    } else {
      slots.add(zonedToUtc(`${date}T${schedule.atTime}`, schedule.tz));
    }
  }
  return [...slots].sort((left, right) => left - right);
}

const span = (schedule: RoutineSchedule) => schedule.cadence === "hourly" ? 1 : 8;

/** The earliest slot strictly after `afterMs`, or null for a manual routine. */
export function nextSlotAfter(schedule: RoutineSchedule, afterMs: number): number | null {
  if (schedule.cadence === "manual" || scheduleProblem(schedule)) return null;
  return slotsAround(schedule, afterMs, span(schedule)).find((slot) => slot > afterMs) ?? null;
}

/** The latest slot at or before `atMs` (the current period's slot), or null for a manual routine. */
export function latestSlotAtOrBefore(schedule: RoutineSchedule, atMs: number): number | null {
  if (schedule.cadence === "manual" || scheduleProblem(schedule)) return null;
  const slots = slotsAround(schedule, atMs, span(schedule)).filter((slot) => slot <= atMs);
  return slots.length ? slots[slots.length - 1]! : null;
}

/**
 * `next_due_at` for a routine that was just created, rescheduled, or resumed: the current
 * period's slot, so the first run can happen straight away ("due since 08:00"), and never more
 * than one slot back, so missed slots do not pile up.
 */
export function initialDueAt(schedule: RoutineSchedule, nowMs: number): string | null {
  const slot = latestSlotAtOrBefore(schedule, nowMs) ?? nextSlotAfter(schedule, nowMs);
  return slot === null ? null : new Date(slot).toISOString();
}

/**
 * `next_due_at` after a finished run (D154): the first slot after the run's slot, measured from
 * the slot rather than from "now" so a late run does not drift, and after "now" as well, so a run
 * that covered several missed slots leaves the routine due once, not once per missed slot.
 */
export function dueAfterRun(schedule: RoutineSchedule, slotMs: number, nowMs: number): string | null {
  const slot = nextSlotAfter(schedule, Math.max(slotMs, nowMs));
  return slot === null ? null : new Date(slot).toISOString();
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayName = (weekday: number) => WEEKDAY_NAMES[weekday] ?? "";

/** "Daily at 08:00", "Weekdays at 09:30", "Mondays at 08:00", "Hourly at :15", "Manual only". */
export function cadenceText(schedule: Pick<RoutineSchedule, "cadence" | "atTime" | "weekday">) {
  if (schedule.cadence === "manual") return "Manual only";
  if (schedule.cadence === "hourly") return `Hourly at :${schedule.atTime?.slice(3, 5) ?? "00"}`;
  if (schedule.cadence === "daily") return `Daily at ${schedule.atTime ?? ""}`;
  if (schedule.cadence === "weekdays") return `Weekdays at ${schedule.atTime ?? ""}`;
  return `${weekdayName(schedule.weekday ?? 1)}s at ${schedule.atTime ?? ""}`;
}
