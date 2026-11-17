// Board timeline view placement (docs/plan/TASK_VIEWS.md §Timeline, D760–D769). Pure: no DOM.
//
// - A card's bar runs from its start day through its due day, both inclusive, on the days the viewer
//   sees them (a timed start or due sits on its viewer-local date, as on the board calendar, D724).
// - Due only: a one-day milestone on the due day. Start only: an open bar from the start day that
//   fades out to the right. Neither: no bar (the row offers "+" to schedule it).
// - Moves are day deltas applied to the card's civil `start_on` / `due_on`, so a timed card keeps its
//   wall time and zone (the server keeps `startTime` / `dueTime` when only the date changes), and a
//   handle can never put the start after the due day (START_AFTER_DUE, D721): it clamps.
import { addDays, daysBetween } from "../calendarRoute";
import { displayedDay, displayedStartDay } from "./calendarPlacement";

export const TIMELINE_SCALES = ["week", "month", "quarter"] as const;
export type TimelineScale = typeof TIMELINE_SCALES[number];
export const isTimelineScale = (value: unknown): value is TimelineScale => typeof value === "string" && (TIMELINE_SCALES as readonly string[]).includes(value);

/** Pixels per day at each zoom (D762): Week reads days, Month a few weeks, Quarter a season in weeks. */
export const DAY_WIDTH: Record<TimelineScale, number> = { week: 64, month: 34, quarter: 13 };
/** Narrower days on a phone (D769), so a 390 px screen still shows a week or more at Month. */
export const PHONE_DAY_WIDTH: Record<TimelineScale, number> = { week: 44, month: 24, quarter: 9 };
export const dayWidthFor = (scale: TimelineScale, phone: boolean) => (phone ? PHONE_DAY_WIDTH : DAY_WIDTH)[scale];
export const SCALE_LABELS: Record<TimelineScale, string> = { week: "Week", month: "Month", quarter: "Quarter" };

/** Days rendered either side of today on first paint, and how many more each time the scroll nears an edge. */
export const RANGE_PAD: Record<TimelineScale, { before: number; after: number; step: number }> = {
  week: { before: 28, after: 56, step: 42 },
  month: { before: 42, after: 105, step: 84 },
  quarter: { before: 98, after: 280, step: 182 }
};
/** The range never grows past this many days (about six years), so the grid stays bounded. */
export const MAX_RANGE_DAYS = 2200;

export type TimelineRange = { from: string; days: number };

type DateCard = {
  due_on: string | null; due_time?: string | null; due_tz?: string | null; due_at?: string | null;
  start_on?: string | null; start_time?: string | null; start_tz?: string | null; start_at?: string | null;
};

export type BarKind = "range" | "milestone" | "open";
/** A card's bar in viewer-local days; `end` is null for an open (start-only) bar. */
export type TimelineBar = { kind: BarKind; start: string; end: string | null };

/** The bar a card draws (D761), or null without dates. A stored start after the due day draws from the due day. */
export function barOf(card: DateCard, viewerZone: string): TimelineBar | null {
  const due = displayedDay({ id: "", ...card }, viewerZone);
  const start = displayedStartDay(card, viewerZone);
  if (due && start) return { kind: "range", start: start <= due ? start : due, end: due };
  if (due) return { kind: "milestone", start: due, end: due };
  if (start) return { kind: "open", start, end: null };
  return null;
}

/** How many days an open bar shows before it fades out. */
export const OPEN_BAR_DAYS = 5;

/** The range first shown at a zoom: a little before today, more after. */
export function initialRange(today: string, scale: TimelineScale, weekStart: 0 | 1 | 6 = 1): TimelineRange {
  const pad = RANGE_PAD[scale];
  // Start on the viewer's week start (D1383; Monday by default) so week lines and labels sit on the grid's own weeks.
  const from = weekStartOn(addDays(today, -pad.before), weekStart);
  return { from, days: daysBetween(from, addDays(today, pad.after)) + 1 };
}

/** The Monday on or before a day. */
export function mondayOf(day: string) {
  return weekStartOn(day, 1);
}

/** The week's first day (0 Sunday, 1 Monday, 6 Saturday) on or before a day (D1383). */
export function weekStartOn(day: string, weekStart: 0 | 1 | 6) {
  return addDays(day, -((weekdayOf(day) - weekStart + 7) % 7));
}

/** 0 = Sunday … 6 = Saturday, for a `YYYY-MM-DD` civil day. */
export function weekdayOf(day: string) {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

export const isWeekend = (day: string) => weekdayOf(day) % 6 === 0;

export const lastDay = (range: TimelineRange) => addDays(range.from, range.days - 1);

/**
 * The range grown toward an edge (D763): `side` "before" prepends `step` days (the caller keeps the
 * same day under the viewport by adding `added * dayWidth` to scrollLeft), "after" appends. Never
 * past `MAX_RANGE_DAYS`; `added` is 0 when it is full.
 */
export function extendRange(range: TimelineRange, side: "before" | "after", step: number): { range: TimelineRange; added: number } {
  const room = Math.max(0, MAX_RANGE_DAYS - range.days);
  const added = Math.min(step, room);
  if (!added) return { range, added: 0 };
  return side === "before"
    ? { range: { from: addDays(range.from, -added), days: range.days + added }, added }
    : { range: { from: range.from, days: range.days + added }, added };
}

/** The range grown (if needed) so it holds `day` with `margin` days to spare either side. */
export function rangeHolding(range: TimelineRange, day: string, margin: number, weekStart: 0 | 1 | 6 = 1): { range: TimelineRange; added: number } {
  const index = daysBetween(range.from, day);
  if (index - margin < 0) {
    const need = weekStartOn(addDays(day, -margin), weekStart);
    const added = Math.min(daysBetween(need, range.from), Math.max(0, MAX_RANGE_DAYS - range.days));
    return added > 0 ? { range: { from: addDays(range.from, -added), days: range.days + added }, added } : { range, added: 0 };
  }
  if (index + margin >= range.days) {
    const days = Math.min(index + margin + 1, MAX_RANGE_DAYS);
    return { range: { from: range.from, days: Math.max(days, range.days) }, added: 0 };
  }
  return { range, added: 0 };
}

export type BarGeometry = { left: number; width: number; clippedStart: boolean; clippedEnd: boolean };

/**
 * Where a bar sits in the grid, in pixels from the range's first day. Bars reaching outside the range
 * are clipped to it (flagged so their rounded end is squared off); null when entirely outside.
 */
export function barGeometry(bar: TimelineBar, range: TimelineRange, dayWidth: number): BarGeometry | null {
  const first = daysBetween(range.from, bar.start);
  const last = bar.end ? daysBetween(range.from, bar.end) : first + OPEN_BAR_DAYS - 1;
  if (last < 0 || first > range.days - 1) return null;
  const from = Math.max(0, first);
  const to = Math.min(range.days - 1, last);
  return { left: from * dayWidth, width: (to - from + 1) * dayWidth, clippedStart: first < 0, clippedEnd: last > range.days - 1 };
}

/** Which side of the visible days a bar lies on (D766), or null when any of it shows. */
export function offscreenSide(bar: TimelineBar, visibleFrom: string, visibleTo: string): "before" | "after" | null {
  const end = bar.end ?? addDays(bar.start, OPEN_BAR_DAYS - 1);
  if (end < visibleFrom) return "before";
  if (bar.start > visibleTo) return "after";
  return null;
}

/** "3 days", "1 day", "From Nov 12" (open), or "" (no dates). */
export function durationLabel(bar: TimelineBar | null) {
  if (!bar) return "";
  if (!bar.end) return "Open";
  const days = daysBetween(bar.start, bar.end) + 1;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Whole days a pointer moved, snapped to the nearest day. */
export const pixelsToDays = (dx: number, dayWidth: number) => {
  const days = Math.round(dx / dayWidth);
  return days === 0 ? 0 : days;
};

/** The day under an x offset (pixels from the range's first day). */
export const dayAtOffset = (range: TimelineRange, x: number, dayWidth: number) =>
  addDays(range.from, Math.max(0, Math.min(range.days - 1, Math.floor(x / dayWidth))));

export type DragMode = "move" | "start" | "end";
/** The PATCH a drag or key makes; fields left out stay as saved. */
export type DateChange = { startOn?: string | null; dueOn?: string | null };

/**
 * The days a drag of `delta` days actually moves, after clamping (D764): the start handle stops on the
 * due day and the end handle on the start day, so a handle can never make START_AFTER_DUE. A move
 * shifts the whole bar and never clamps.
 */
export function clampDelta(bar: TimelineBar, mode: DragMode, delta: number) {
  if (mode === "move" || !bar.end) return delta;
  const length = daysBetween(bar.start, bar.end);
  if (mode === "start") return Math.min(delta, length);
  return Math.max(delta, -length);
}

/**
 * The change a drag of `delta` days makes (D764), or null when nothing changes. Shown days move by
 * the delta; the stored civil dates move by the same number of days, so times and zones stay.
 *
 * - `move`: both dates shift (a milestone its due, an open bar its start).
 * - `start`: the start moves, clamped to the due day; a milestone gains a start that many days before.
 * - `end`: the due moves, clamped to the start day; an open bar gains a due date where its end lands.
 */
export function dragChange(card: DateCard, bar: TimelineBar, mode: DragMode, delta: number): DateChange | null {
  const days = clampDelta(bar, mode, delta);
  if (mode === "move") {
    if (!days) return null;
    const change: DateChange = {};
    if (card.start_on) change.startOn = addDays(card.start_on, days);
    if (card.due_on) change.dueOn = addDays(card.due_on, days);
    return change;
  }
  if (mode === "start") {
    if (bar.kind === "milestone") {
      // A start before the due day (dragging right of the due day keeps it a milestone).
      return days < 0 && card.due_on ? { startOn: addDays(card.due_on, days) } : null;
    }
    return days && card.start_on ? { startOn: addDays(card.start_on, days) } : null;
  }
  if (bar.kind === "open") {
    // The open bar's end lands `OPEN_BAR_DAYS - 1 + days` after its start: that day becomes the due date.
    const span = Math.max(0, OPEN_BAR_DAYS - 1 + days);
    return card.start_on ? { dueOn: addDays(card.start_on, span) } : null;
  }
  return days && card.due_on ? { dueOn: addDays(card.due_on, days) } : null;
}

/** The bar a change would draw (for the drag preview and the optimistic update), from the shown bar. */
export function previewBar(bar: TimelineBar, mode: DragMode, delta: number): TimelineBar {
  const days = clampDelta(bar, mode, delta);
  if (mode === "move") return { kind: bar.kind, start: addDays(bar.start, days), end: bar.end ? addDays(bar.end, days) : null };
  if (mode === "start") {
    if (bar.kind === "milestone") return days < 0 ? { kind: "range", start: addDays(bar.start, days), end: bar.end } : bar;
    return { ...bar, start: addDays(bar.start, days) };
  }
  if (bar.kind === "open") return { kind: "range", start: bar.start, end: addDays(bar.start, Math.max(0, OPEN_BAR_DAYS - 1 + days)) };
  return { ...bar, end: addDays(bar.end!, days) };
}

/** The dates a drag across empty days of an unscheduled row sets (D765): earliest day first. */
export function createChange(fromDay: string, toDay: string): DateChange {
  const [startOn, dueOn] = fromDay <= toDay ? [fromDay, toDay] : [toDay, fromDay];
  return { startOn, dueOn };
}

/**
 * Alt+←/→ shift the bar a day; Alt+Shift+←/→ move its end (the due day, clamped to the start; an open bar
 * gains a due date) (D767). Null for any other key.
 */
export function keyboardDrag(key: string, shift: boolean): { mode: DragMode; delta: number } | null {
  const delta = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (!delta) return null;
  return { mode: shift ? "end" : "move", delta };
}

const monthNames = (locale?: string) => Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month, 1))));
const MONTHS = monthNames("en");
const longMonth = (day: string) => new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));

/** "Nov 12" (a short day label). */
export function shortDay(day: string) {
  const [, month, date] = day.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1]} ${date}`;
}

/** "Nov 12 → Nov 15 · 4 days", "Nov 12 · due", "From Nov 12" for the drag tooltip and labels. */
export function barLabel(bar: TimelineBar) {
  if (!bar.end) return `From ${shortDay(bar.start)}`;
  if (bar.kind === "milestone") return `Due ${shortDay(bar.end)}`;
  return `${shortDay(bar.start)} → ${shortDay(bar.end)} · ${durationLabel(bar)}`;
}

export type HeaderSpan = { key: string; label: string; start: number; days: number };
export type HeaderTick = { key: string; label: string; sub?: string; start: number; days: number; weekend?: boolean; today?: boolean };

/**
 * The two header rows for days `[firstIndex, lastIndex]` of the range (D762): months on top, and
 * below them days with weekday initials (Week, Month) or weeks from the viewer's week start (Quarter; D1383, Monday by default).
 * Only the asked-for window is built, so a long range costs no more than the screen.
 */
export function headerRows(range: TimelineRange, scale: TimelineScale, today: string, firstIndex: number, lastIndex: number, weekStart: 0 | 1 | 6 = 1): { top: HeaderSpan[]; bottom: HeaderTick[] } {
  const first = Math.max(0, firstIndex);
  const last = Math.min(range.days - 1, lastIndex);
  const top: HeaderSpan[] = [];
  const bottom: HeaderTick[] = [];
  if (last < first) return { top, bottom };
  // Months over the window, each spanning its days within the range.
  let index = first;
  while (index <= last) {
    const day = addDays(range.from, index);
    const monthStart = `${day.slice(0, 7)}-01`;
    const startIndex = Math.max(0, daysBetween(range.from, monthStart));
    const nextMonth = addDays(monthStart, 32).slice(0, 7);
    const endIndex = Math.min(range.days - 1, daysBetween(range.from, `${nextMonth}-01`) - 1);
    top.push({ key: monthStart, label: scale === "week" ? longMonth(monthStart) : `${MONTHS[Number(monthStart.slice(5, 7)) - 1]} ${monthStart.slice(0, 4)}`, start: startIndex, days: endIndex - startIndex + 1 });
    index = endIndex + 1;
  }
  if (scale === "quarter") {
    // Weeks stay on the week start's grid even when the range does not begin on one (D1383: the
    // range was made before the viewer's preference loaded): the first column is then a part week.
    let week = daysBetween(range.from, weekStartOn(addDays(range.from, first), weekStart));
    while (week <= last) {
      const start = Math.max(0, week);
      const day = addDays(range.from, start);
      const end = Math.min(range.days - 1, week + 6);
      const todayIndex = daysBetween(range.from, today);
      bottom.push({ key: day, label: String(Number(day.slice(8, 10))), sub: MONTHS[Number(day.slice(5, 7)) - 1], start, days: end - start + 1, today: todayIndex >= start && todayIndex <= end });
      week += 7;
    }
    return { top, bottom };
  }
  for (let at = first; at <= last; at += 1) {
    const day = addDays(range.from, at);
    bottom.push({ key: day, label: String(Number(day.slice(8, 10))), sub: "SMTWTFS"[weekdayOf(day)]!, start: at, days: 1, weekend: isWeekend(day), today: day === today });
  }
  return { top, bottom };
}

/** The title shown in the toolbar for the visible days: "November 2026", "Nov – Dec 2026", "Dec 2026 – Jan 2027". */
export function visibleTitle(from: string, to: string) {
  const [fy, fm] = [from.slice(0, 4), Number(from.slice(5, 7))];
  const [ty, tm] = [to.slice(0, 4), Number(to.slice(5, 7))];
  if (fy === ty && fm === tm) return longMonth(from);
  if (fy === ty) return `${MONTHS[fm - 1]} – ${MONTHS[tm - 1]} ${ty}`;
  return `${MONTHS[fm - 1]} ${fy} – ${MONTHS[tm - 1]} ${ty}`;
}

export type TimelineRow<C> =
  | { kind: "group"; key: string; label: string; count: number; collapsed: boolean }
  | { kind: "card"; key: string; card: C; group: string | null };

/** The rows the timeline lists (D768): group headers (when grouped) with their cards, collapsed groups without. */
export function timelineRows<C extends { id: string }>(cards: readonly C[], groups: ReadonlyArray<{ key: string; label: string; items: ReadonlyArray<{ card: C }> }> | null, collapsed: ReadonlySet<string>): TimelineRow<C>[] {
  if (!groups) return cards.map((card) => ({ kind: "card", key: card.id, card, group: null }));
  const rows: TimelineRow<C>[] = [];
  for (const group of groups) {
    const folded = collapsed.has(group.key);
    rows.push({ kind: "group", key: `group:${group.key}`, label: group.label, count: group.items.length, collapsed: folded });
    if (!folded) for (const { card } of group.items) rows.push({ kind: "card", key: `${group.key}:${card.id}`, card, group: group.key });
  }
  return rows;
}

/** The rows to render for a scroll position (virtualized, D769): `[first, last]` with `overscan` rows either side. */
export function rowWindow(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan = 6) {
  if (count <= 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { first, last };
}

/** A zoom step for Ctrl/⌘+wheel and pinch: -1 zooms in (wider days), +1 out. */
export function zoomStep(scale: TimelineScale, step: -1 | 1): TimelineScale {
  const index = TIMELINE_SCALES.indexOf(scale) + step;
  return TIMELINE_SCALES[Math.max(0, Math.min(TIMELINE_SCALES.length - 1, index))]!;
}
