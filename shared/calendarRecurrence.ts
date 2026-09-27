/**
 * Pure recurrence and zoned-time helpers (docs/plan/WAVES_10-12.md §4.1, D63), shared by the server
 * and the client (server/calendar/recurrence.ts re-exports them).
 * No database or clock access, so every rule is unit tested directly.
 *
 * Timed events store a local wall time, an IANA zone, and a duration; every
 * occurrence keeps the same wall time in that zone, so they stay correct
 * across DST. All-day events store a start date and an exclusive end date and
 * float with the viewer. Dates are `yyyy-mm-dd`, local times `yyyy-mm-ddTHH:MM`.
 */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type RecurrenceRule = { freq: Freq; interval: number; byDay?: Weekday[]; until?: string; count?: number };

export const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const MAX_INTERVAL = 99;
export const MAX_COUNT = 730;
export const MAX_EXDATES = 200;
/** Occurrences returned per request, across every event (T66). */
export const MAX_INSTANCES = 1000;
/** Longest range a request may expand (T66). */
export const MAX_RANGE_DAYS = 100;
/** Longest all-day event. Timed events are capped by duration_minutes ≤ 10080 (7 days). */
export const MAX_ALL_DAY_DAYS = 366;
export const MAX_DURATION_MINUTES = 10_080;
/** Repeating events start between these years (T66). */
export const MIN_RECURRING_YEAR = 1970;
export const MAX_RECURRING_YEAR = 2100;
/** A repeat with a number of times spans at most this many days (about 10 years). */
export const MAX_COUNT_SPAN_DAYS = 3653;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Safety net for rules that rarely produce a date (Feb 29 every few years). */
const MAX_STEPS = 50_000;

export class RecurrenceError extends Error {}

// ---------------------------------------------------------------------------
// Civil dates as day numbers (days since 1970-01-01), independent of any zone.

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export type CivilDate = { year: number; month: number; day: number };

function isRealDate(year: number, month: number, day: number) {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A real calendar date between 1900 and 2200, or null (T71: no rollover such as 2026-02-30). */
export function parseDate(value: string): CivilDate | null {
  const match = datePattern.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return isRealDate(year, month, day) ? { year, month, day } : null;
}

export function isValidDate(value: string) {
  return parseDate(value) !== null;
}

/** A real local date and time `yyyy-mm-ddTHH:MM`, or null. */
export function parseLocal(value: string): (CivilDate & { hour: number; minute: number }) | null {
  const match = localPattern.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (!isRealDate(year, month, day) || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

export const dayNumber = (date: CivilDate) => Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);

export function fromDayNumber(days: number): CivilDate {
  const date = new Date(days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");
export const formatDate = (date: CivilDate) => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
export const dayToDate = (days: number) => formatDate(fromDayNumber(days));
export const dateToDay = (value: string) => {
  const date = parseDate(value);
  if (!date) throw new RecurrenceError("Invalid date");
  return dayNumber(date);
};
/** Monday = 0 … Sunday = 6. */
export const weekdayIndex = (days: number) => (new Date(days * DAY_MS).getUTCDay() + 6) % 7;
export const addDays = (value: string, days: number) => dayToDate(dateToDay(value) + days);

// ---------------------------------------------------------------------------
// Zones

const formatters = new Map<string, Intl.DateTimeFormat>();
let knownZones: Set<string> | null = null;

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * T71: a zone is accepted only when `Intl` lists it, or when `Intl` accepts it
 * and it has the shape of an IANA name (browsers may report legacy aliases
 * such as Asia/Calcutta that `supportedValuesOf` omits).
 */
export function isValidTimeZone(value: string) {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(value)) return false;
  knownZones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  if (knownZones.has(value)) return true;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at instant `utcMs`, in milliseconds (positive east of Greenwich). */
export function zoneOffsetMs(utcMs: number, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant of a wall time in `timeZone`, found by probing `Intl`
 * offsets a day either side. In a DST gap the time shifts forward by the gap
 * (02:30 on a spring-forward night becomes 03:30); in an overlap the earlier
 * instant wins.
 */
export function zonedToUtc(local: string, timeZone: string): number {
  const parsed = parseLocal(local);
  if (!parsed) throw new RecurrenceError("Invalid local time");
  const wall = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute);
  const before = zoneOffsetMs(wall - DAY_MS, timeZone);
  const after = zoneOffsetMs(wall + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((utc) => wall - zoneOffsetMs(utc, timeZone) === utc)
    .sort((left, right) => left - right);
  if (candidates.length) return candidates[0]!;
  // Gap: no offset maps back to this wall time. Use the offset in force before the jump.
  return wall - before;
}

/** The wall time `yyyy-mm-ddTHH:MM` of instant `utcMs` in `timeZone`. */
export function utcToZoned(utcMs: number, timeZone: string) {
  const shifted = new Date(utcMs + zoneOffsetMs(utcMs, timeZone));
  return `${formatDate({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() })}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// Events and rules

export type TimedTiming = { allDay: false; startLocal: string; tz: string; durationMinutes: number };
export type AllDayTiming = { allDay: true; startDate: string; endDate: string };
export type EventTiming = TimedTiming | AllDayTiming;
export type SeriesInput = EventTiming & { rule: RecurrenceRule | null; exdates?: string[] };

const startDateOf = (timing: EventTiming) => timing.allDay ? timing.startDate : timing.startLocal.slice(0, 10);

/** Throws RecurrenceError with a user-facing message when the timing is not valid. */
export function validateTiming(timing: EventTiming) {
  if (timing.allDay) {
    if (!isValidDate(timing.startDate) || !isValidDate(timing.endDate)) throw new RecurrenceError("Enter real dates");
    const span = dateToDay(timing.endDate) - dateToDay(timing.startDate);
    if (span < 1) throw new RecurrenceError("An all-day event ends after the day it starts");
    if (span > MAX_ALL_DAY_DAYS) throw new RecurrenceError(`An all-day event can last at most ${MAX_ALL_DAY_DAYS} days`);
    return;
  }
  if (!parseLocal(timing.startLocal)) throw new RecurrenceError("Enter a real start date and time");
  if (!isValidTimeZone(timing.tz)) throw new RecurrenceError("Unknown time zone");
  if (!Number.isInteger(timing.durationMinutes) || timing.durationMinutes < 1 || timing.durationMinutes > MAX_DURATION_MINUTES) {
    throw new RecurrenceError("An event lasts between 1 minute and 7 days");
  }
}

/** Normalises and checks a rule against the event's start. Returns the rule as stored. */
export function normalizeRule(rule: RecurrenceRule, timing: EventTiming): RecurrenceRule {
  const freqs: Freq[] = ["daily", "weekly", "monthly", "yearly"];
  if (!freqs.includes(rule.freq)) throw new RecurrenceError("Unknown repeat frequency");
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL) throw new RecurrenceError(`Repeat every 1 to ${MAX_INTERVAL} periods`);
  if (rule.until !== undefined && rule.count !== undefined) throw new RecurrenceError("Choose an end date or a number of times, not both");
  const startYear = Number(startDateOf(timing).slice(0, 4));
  if (startYear < MIN_RECURRING_YEAR || startYear > MAX_RECURRING_YEAR) throw new RecurrenceError(`A repeating event starts between ${MIN_RECURRING_YEAR} and ${MAX_RECURRING_YEAR}`);
  const normalized: RecurrenceRule = { freq: rule.freq, interval: rule.interval };
  if (rule.byDay !== undefined) {
    if (rule.freq !== "weekly") throw new RecurrenceError("Weekdays apply to weekly repeats only");
    const days = [...new Set(rule.byDay)];
    if (!days.length || days.some((day) => !WEEKDAYS.includes(day))) throw new RecurrenceError("Choose at least one weekday");
    normalized.byDay = WEEKDAYS.filter((day) => days.includes(day));
    // The first occurrence is the event's own start, so its weekday must be one of them.
    if (!days.includes(WEEKDAYS[weekdayIndex(dateToDay(startDateOf(timing)))]!)) throw new RecurrenceError("The start date must fall on one of the chosen weekdays");
  }
  if (rule.until !== undefined) {
    if (!isValidDate(rule.until)) throw new RecurrenceError("Enter a real end date");
    if (rule.until < startDateOf(timing)) throw new RecurrenceError("The repeat ends before the event starts");
    normalized.until = rule.until;
  }
  if (rule.count !== undefined) {
    if (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_COUNT) throw new RecurrenceError(`Repeat 1 to ${MAX_COUNT} times`);
    normalized.count = rule.count;
    const periodDays = { daily: 1, weekly: 7, monthly: 30.44, yearly: 365.25 }[rule.freq];
    const periods = Math.ceil(rule.count / (normalized.byDay?.length ?? 1));
    if ((periods - 1) * rule.interval * periodDays > MAX_COUNT_SPAN_DAYS) {
      throw new RecurrenceError("A repeat with a number of times can span at most 10 years. Choose an end date or no end instead.");
    }
  }
  return normalized;
}

/** Sorted, unique, real dates; at most MAX_EXDATES. */
export function normalizeExdates(exdates: string[]) {
  const unique = [...new Set(exdates)].sort();
  if (unique.length > MAX_EXDATES) throw new RecurrenceError(`At most ${MAX_EXDATES} skipped dates`);
  if (unique.some((date) => !isValidDate(date))) throw new RecurrenceError("Enter real dates");
  return unique;
}

/**
 * Local start dates of the series, in order, as day numbers. Counting starts
 * at DTSTART; `fromDay` lets an endless or `until` series skip whole periods
 * that end before it (a `count` series always counts from the start).
 * Monthly repeats use DTSTART's day of the month and skip months without it;
 * yearly repeats skip years without the date (Feb 29).
 */
function* seriesDays(startDay: number, rule: RecurrenceRule | null, fromDay = -Infinity): Generator<number> {
  if (!rule) {
    yield startDay;
    return;
  }
  const untilDay = rule.until ? dateToDay(rule.until) : Infinity;
  const skip = rule.count === undefined && Number.isFinite(fromDay) && fromDay > startDay;
  const start = fromDayNumber(startDay);
  let emitted = 0;
  const emit = function* (day: number) {
    if (day > untilDay) return false;
    emitted += 1;
    yield day;
    return rule.count === undefined || emitted < rule.count;
  };
  let period = 0;
  if (rule.freq === "daily") {
    if (skip) period = Math.max(0, Math.floor((fromDay - startDay) / rule.interval) - 1);
    for (let steps = 0; steps < MAX_STEPS; steps += 1, period += 1) {
      const day = startDay + period * rule.interval;
      if (!(yield* emit(day))) return;
    }
    return;
  }
  if (rule.freq === "weekly") {
    const weekStart = startDay - weekdayIndex(startDay);
    const offsets = (rule.byDay ?? [WEEKDAYS[weekdayIndex(startDay)]!]).map((day) => WEEKDAYS.indexOf(day)).sort((a, b) => a - b);
    if (skip) period = Math.max(0, Math.floor((fromDay - weekStart) / (7 * rule.interval)) - 1);
    for (let steps = 0; steps < MAX_STEPS; steps += 1, period += 1) {
      const base = weekStart + period * rule.interval * 7;
      if (base > untilDay) return;
      for (const offset of offsets) {
        const day = base + offset;
        if (day < startDay) continue;
        if (!(yield* emit(day))) return;
      }
    }
    return;
  }
  const monthly = rule.freq === "monthly";
  const step = monthly ? rule.interval : rule.interval * 12;
  if (skip) {
    const from = fromDayNumber(fromDay);
    const monthsAhead = (from.year - start.year) * 12 + (from.month - start.month);
    period = Math.max(0, Math.floor(monthsAhead / step) - 1);
  }
  for (let steps = 0; steps < MAX_STEPS; steps += 1, period += 1) {
    const monthIndex = start.year * 12 + (start.month - 1) + period * step;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    if (year > 2200) return;
    if (start.day > daysInMonth(year, month)) {
      if (dayNumber({ year, month, day: 1 }) > untilDay) return;
      continue;
    }
    if (!(yield* emit(dayNumber({ year, month, day: start.day })))) return;
  }
}

export type Occurrence =
  | { allDay: false; date: string; startMs: number; endMs: number }
  | { allDay: true; date: string; startDate: string; endDate: string };

export type ExpansionRange = { fromDate: string; toDate: string; startMs: number; endMs: number };

/** A request range: whole local days `fromDate` (inclusive) to `toDate` (exclusive) in the viewer's zone. */
export function rangeFor(fromDate: string, toDate: string, viewerTz: string): ExpansionRange {
  if (!isValidDate(fromDate) || !isValidDate(toDate)) throw new RecurrenceError("Enter real dates");
  if (!isValidTimeZone(viewerTz)) throw new RecurrenceError("Unknown time zone");
  const days = dateToDay(toDate) - dateToDay(fromDate);
  if (days < 1) throw new RecurrenceError("The range ends after it starts");
  if (days > MAX_RANGE_DAYS) throw new RecurrenceError(`A range spans at most ${MAX_RANGE_DAYS} days`);
  return { fromDate, toDate, startMs: zonedToUtc(`${fromDate}T00:00`, viewerTz), endMs: zonedToUtc(`${toDate}T00:00`, viewerTz) };
}

/** A shared per-request allowance of recurrence steps (T66); expansion stops when it runs out. */
export type ExpansionBudget = { steps: number };

/**
 * Occurrences of one series that overlap `range`, in order, skipping exdates,
 * and at most `limit` of them. `truncated` is true when more existed, or when
 * `budget` ran out before the series was fully expanded.
 */
export function expandSeries(series: SeriesInput, range: ExpansionRange, limit = MAX_INSTANCES, budget?: ExpansionBudget): { occurrences: Occurrence[]; truncated: boolean } {
  const occurrences: Occurrence[] = [];
  if (limit <= 0) return { occurrences, truncated: true };
  const exdates = new Set(series.exdates ?? []);
  const startDay = dateToDay(startDateOf(series));
  const spanDays = series.allDay ? dateToDay(series.endDate) - startDay : Math.ceil(series.durationMinutes / 1440);
  const fromDay = dateToDay(range.fromDate);
  const toDay = dateToDay(range.toDate);
  // Two days of slack cover any zone difference between the event and the viewer.
  const firstUseful = fromDay - spanDays - 2;
  const time = series.allDay ? "" : series.startLocal.slice(10);
  for (const day of seriesDays(startDay, series.rule, firstUseful)) {
    if (day > toDay + 2) break;
    if (budget && --budget.steps < 0) return { occurrences, truncated: true };
    if (day < firstUseful) continue;
    const date = dayToDate(day);
    if (exdates.has(date)) continue;
    let occurrence: Occurrence;
    if (series.allDay) {
      const endDate = dayToDate(day + spanDays);
      if (!(date < range.toDate && endDate > range.fromDate)) continue;
      occurrence = { allDay: true, date, startDate: date, endDate };
    } else {
      const startMs = zonedToUtc(`${date}${time}`, series.tz);
      const endMs = startMs + series.durationMinutes * MINUTE_MS;
      if (!(startMs < range.endMs && endMs > range.startMs)) continue;
      occurrence = { allDay: false, date, startMs, endMs };
    }
    if (occurrences.length >= limit) return { occurrences, truncated: true };
    occurrences.push(occurrence);
  }
  return { occurrences, truncated: false };
}

/**
 * Stored bounds used by the range index: `startUtc` is the first start, and
 * `seriesEndUtc` the latest end (null for an endless series). All-day dates
 * are stored as UTC midnight; queries add a day of slack for the viewer's zone.
 * An `until` series stores an upper bound (the end of its last possible day).
 */
export function seriesBounds(series: SeriesInput): { startUtc: string; seriesEndUtc: string | null } {
  const iso = (ms: number) => new Date(ms).toISOString();
  const startDay = dateToDay(startDateOf(series));
  const startMs = series.allDay ? startDay * DAY_MS : zonedToUtc(series.startLocal, series.tz);
  const endOfDay = (day: number) => series.allDay
    ? (day + dateToDay(series.endDate) - startDay) * DAY_MS
    : zonedToUtc(`${dayToDate(day)}${series.startLocal.slice(10)}`, series.tz) + series.durationMinutes * MINUTE_MS;
  const rule = series.rule;
  if (!rule) return { startUtc: iso(startMs), seriesEndUtc: iso(endOfDay(startDay)) };
  if (rule.count !== undefined) {
    let last = startDay;
    for (const day of seriesDays(startDay, rule)) last = day;
    return { startUtc: iso(startMs), seriesEndUtc: iso(endOfDay(last)) };
  }
  if (rule.until !== undefined) return { startUtc: iso(startMs), seriesEndUtc: iso(endOfDay(dateToDay(rule.until))) };
  return { startUtc: iso(startMs), seriesEndUtc: null };
}

/**
 * The first occurrence of the series that starts at or after `afterMs`, skipping exdates, or null
 * when the series has ended. Timed occurrences start at their wall time in the event's zone;
 * all-day occurrences start at local midnight in `allDayTz` (the zone of whoever is asking, since
 * all-day events float). Used to schedule reminders.
 */
export function nextOccurrence(series: SeriesInput, afterMs: number, allDayTz: string): { date: string; startMs: number } | null {
  const exdates = new Set(series.exdates ?? []);
  const startDay = dateToDay(startDateOf(series));
  const time = series.allDay ? "T00:00" : series.startLocal.slice(10);
  const zone = series.allDay ? allDayTz : series.tz;
  // Two days of slack cover any zone offset between the instant and the local date.
  const fromDay = Math.floor(afterMs / DAY_MS) - 2;
  for (const day of seriesDays(startDay, series.rule, fromDay)) {
    if (day < fromDay) continue;
    const date = dayToDate(day);
    if (exdates.has(date)) continue;
    const startMs = zonedToUtc(`${date}${time}`, zone);
    if (startMs >= afterMs) return { date, startMs };
  }
  return null;
}

/**
 * `next_occurrence_utc` for the range index (migration 014): a lower bound on the start of every
 * occurrence that ends after `fromMs`, or null when there is none. All-day occurrences sit at UTC
 * midnight, like `start_utc`; range queries add slack for the viewer's zone.
 */
export function nextOccurrenceBound(series: SeriesInput, fromMs: number): string | null {
  const spanMs = series.allDay ? (dateToDay(series.endDate) - dateToDay(series.startDate)) * DAY_MS : series.durationMinutes * MINUTE_MS;
  const next = nextOccurrence(series, fromMs - spanMs - DAY_MS, "UTC");
  return next ? new Date(next.startMs).toISOString() : null;
}

/** Whether `date` is the local start date of an occurrence of the series (exdates ignored). */
export function isOccurrenceDate(series: SeriesInput, date: string) {
  if (!isValidDate(date)) return false;
  const target = dateToDay(date);
  const startDay = dateToDay(startDateOf(series));
  if (target < startDay) return false;
  for (const day of seriesDays(startDay, series.rule, target - 1)) {
    if (day === target) return true;
    if (day > target) return false;
  }
  return false;
}
