// Pure Calendar routing and date helpers. No DOM access, so they are unit tested directly.
import { isRouteMonth, type Route } from "./router";

export type CalendarRoute = Extract<Route, { app: "calendar" }>;
export type CalendarView = CalendarRoute["view"];

export const agendaRoute = (): CalendarRoute => ({ app: "calendar", view: "agenda", month: null, eventId: null });
export const monthRoute = (month: string | null): CalendarRoute => ({ app: "calendar", view: "month", month, eventId: null });
export const eventRoute = (eventId: string): CalendarRoute => ({ app: "calendar", view: "agenda", month: null, eventId });

/** The agenda shows this many days from today (§4.4). */
export const AGENDA_DAYS = 60;

const pad = (value: number) => String(value).padStart(2, "0");

/** A browser Date's local calendar date, `yyyy-mm-dd`. */
export function localDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar arithmetic on `yyyy-mm-dd` strings, independent of the browser's zone. */
export function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function daysBetween(from: string, to: string) {
  const toUtc = (value: string) => {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export const monthOf = (date: string) => date.slice(0, 7);

/** The month `delta` months from `month` (`yyyy-mm`). */
export function shiftMonth(month: string, delta: number) {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const total = year * 12 + (index - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** The month a month route shows: its own when valid, otherwise the month of `today`. */
export function resolveMonth(month: string | null, today: string) {
  return month && isRouteMonth(month) ? month : monthOf(today);
}

/** A week's first day: 0 Sunday, 1 Monday, 6 Saturday (Settings → Workspace → Week starts on, §B.16). */
export type WeekStart = 0 | 1 | 6;

/**
 * The 42 dates (six weeks from the viewer's week start, D1383; Monday by default) of a month grid.
 * Six rows always, so the grid never jumps in height between months, and the range stays well under
 * the API's 100-day limit.
 */
export function monthGridDays(month: string, weekStart: WeekStart = 1) {
  const first = `${month}-01`;
  const [year, index] = month.split("-").map(Number) as [number, number];
  const weekday = (new Date(Date.UTC(year, index - 1, 1)).getUTCDay() - weekStart + 7) % 7;
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, offset) => addDays(start, offset));
}

const SUNDAY_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** The grid's column headings from the week start (D1383). */
export const weekdayLabelsFrom = (weekStart: WeekStart = 1) => Array.from({ length: 7 }, (_, index) => SUNDAY_FIRST[(weekStart + index) % 7]!);
/** Monday-first headings (the default week start). */
export const weekdayLabels = weekdayLabelsFrom(1);

/**
 * The view one level up, used when in-app Back has no history entry of this visit to step back to
 * (a deep link): event → agenda; agenda and month → Home (null).
 */
export function parentCalendarRoute(route: CalendarRoute): CalendarRoute | null {
  return route.eventId ? agendaRoute() : null;
}

/**
 * In-app Back: step back through entries this visit pushed (the `mynotes.depth` counter), so it
 * matches the browser's Back; otherwise replace the entry with the parent view, or go Home.
 * It never leaves Nook.
 */
export function calendarBackAction(route: CalendarRoute, depth: number): { kind: "history" } | { kind: "replace"; route: CalendarRoute } | { kind: "home" } {
  if (depth > 0) return { kind: "history" };
  const parent = parentCalendarRoute(route);
  return parent ? { kind: "replace", route: parent } : { kind: "home" };
}

/** The route Home's Calendar card opens: the agenda on phones (§4.4), the current month on desktops. */
export function calendarHomeRoute(mobile: boolean, today: string): CalendarRoute {
  return mobile ? agendaRoute() : monthRoute(monthOf(today));
}
