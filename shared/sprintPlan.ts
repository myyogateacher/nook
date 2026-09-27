/**
 * Sprint naming and dates (research 2026-09-26-task-hierarchy-workflows.md D124, D131, §7.5).
 * Pure and dependency-free, shared by the server (completing a sprint into a new one, the Scrum
 * template's first sprint) and the client (the New sprint form and the close dialog), so both
 * suggest the same name and dates.
 */

/** A sprint's state as the API reports it; the database stores `completed` as `closed` (migration 019). */
export const SPRINT_STATES = ["planned", "active", "completed"] as const;
export type SprintState = typeof SPRINT_STATES[number];

export const SPRINT_NAME_MAX = 60;
export const SPRINT_GOAL_MAX = 500;
/** The default sprint length in days, start and end included (two weeks). */
export const SPRINT_DEFAULT_DAYS = 14;

/** `date` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD. */
export function addSprintDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function sprintDaysBetween(from: string, to: string) {
  const at = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/**
 * "Sprint 12" → "Sprint 13"; a name without a trailing number gets " 2". Names in `taken` (the
 * board's other sprints, ignoring case) are skipped, so completing Sprint 1 while Sprint 2 is
 * planned suggests Sprint 3. Stays within 60 characters.
 */
export function nextSprintName(name: string | null | undefined, taken: Iterable<string> = []) {
  const base = (name ?? "").trim() || "Sprint 0";
  const used = new Set([...taken].map((item) => item.trim().toLowerCase()));
  const match = /^(.*?)(\d+)$/.exec(base);
  const prefix = match ? match[1]! : `${base} `;
  let number = match ? Number(match[2]) + 1 : 2;
  const fit = (text: string) => text.length > SPRINT_NAME_MAX ? text.slice(text.length - SPRINT_NAME_MAX) : text;
  // At most one more than the number of taken names is ever needed.
  for (let guard = 0; guard <= used.size && used.has(fit(`${prefix}${number}`).toLowerCase()); guard += 1) number += 1;
  return fit(`${prefix}${number}`);
}

/**
 * The dates of the sprint after one: it starts the day after `endOn` and lasts as long (start and
 * end included). Without an end date it starts on `today` and lasts two weeks.
 */
export function nextSprintDates(previous: { start_on: string | null; end_on: string | null } | null, today: string): { startOn: string; endOn: string } {
  if (previous?.end_on) {
    const length = previous.start_on ? Math.max(0, sprintDaysBetween(previous.start_on, previous.end_on)) : SPRINT_DEFAULT_DAYS - 1;
    const startOn = addSprintDays(previous.end_on, 1);
    return { startOn, endOn: addSprintDays(startOn, length) };
  }
  return { startOn: today, endOn: addSprintDays(today, SPRINT_DEFAULT_DAYS - 1) };
}

/**
 * The dates of a new sprint made while completing `sprint` today (QA 0.9.0): as long as it, but
 * from today, never chained after an end date that has not come yet (completed early) or has passed
 * (completed late). Completed on its last day, the new one starts tomorrow.
 */
export function sprintDatesAfterCompleting(sprint: { start_on: string | null; end_on: string | null }, today: string): { startOn: string; endOn: string } {
  const length = sprint.start_on && sprint.end_on ? Math.max(0, sprintDaysBetween(sprint.start_on, sprint.end_on)) : SPRINT_DEFAULT_DAYS - 1;
  const startOn = sprint.end_on === today ? addSprintDays(today, 1) : today;
  return { startOn, endOn: addSprintDays(startOn, length) };
}

// ---------------------------------------------------------------------------
// A board's sprint defaults (Board settings → Sprint defaults), stored in `boards.structure_json`
// as `sprintDefaults` (validated by boardStructure.ts). They set what the New sprint form and the
// close dialog's "new sprint" suggest: the length, the start day, and the name. A board without
// them keeps the older rule (as long as the latest sprint, named after it).

/** Where a new sprint starts: the day after the previous one ends, a weekday on or after that, or today. */
export const SPRINT_START_RULES = ["next", "today", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type SprintStartRule = typeof SPRINT_START_RULES[number];
/** The longest default sprint, in days. */
export const SPRINT_DAYS_MAX = 60;
/** A name pattern's longest length; `{n}` becomes the sprint's number. */
export const SPRINT_PATTERN_MAX = 40;
export const SPRINT_NUMBER = "{n}";

export type SprintDefaults = {
  /** Length in days, start and end included (1–60). */
  days: number;
  start: SprintStartRule;
  /** "Sprint {n}": `{n}` counts up from the board's highest. Absent: follow the latest sprint's name. */
  name?: string;
};

/** The Scrum template's defaults: two weeks, from the day after the previous sprint, "Sprint {n}". */
export const SCRUM_SPRINT_DEFAULTS: SprintDefaults = { days: SPRINT_DEFAULT_DAYS, start: "next", name: "Sprint {n}" };

const WEEKDAYS: Partial<Record<SprintStartRule, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** The end date of a sprint starting `startOn` that lasts `days` (start and end included). */
export const sprintEndFor = (startOn: string, days: number) => addSprintDays(startOn, Math.max(1, Math.round(days)) - 1);

/** The first `rule` weekday on or after `from`; `from` itself for `next` and `today`. */
export function onOrAfterWeekday(from: string, rule: SprintStartRule) {
  const weekday = WEEKDAYS[rule];
  if (weekday === undefined) return from;
  const [year, month, day] = from.split("-").map(Number);
  const current = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return addSprintDays(from, (weekday - current + 7) % 7);
}

/** Whether `pattern` is a usable name pattern: 1–40 characters, trimmed, with exactly one `{n}`. */
export const validSprintPattern = (pattern: string) =>
  pattern.trim() === pattern && pattern.length > 0 && pattern.length <= SPRINT_PATTERN_MAX && pattern.split(SPRINT_NUMBER).length === 2;

/**
 * The next name from a pattern: "Sprint {n}" after Sprint 1 and Sprint 3 is "Sprint 4"; the first
 * is "Sprint 1". Names in `taken` (ignoring case) are skipped.
 */
export function sprintNameFromPattern(pattern: string, taken: Iterable<string> = []) {
  const [prefix = "", suffix = ""] = pattern.split(SPRINT_NUMBER);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escape(prefix)}(\\d+)${escape(suffix)}$`, "i");
  const names = [...taken];
  const used = new Set(names.map((item) => item.trim().toLowerCase()));
  let number = names.reduce((highest, name) => Math.max(highest, Number(match.exec(name.trim())?.[1] ?? 0)), 0) + 1;
  const make = (value: number) => `${prefix}${value}${suffix}`.trim().slice(0, SPRINT_NAME_MAX);
  for (let guard = 0; guard <= used.size && used.has(make(number).toLowerCase()); guard += 1) number += 1;
  return make(number);
}

type PlanSprint = { name: string; start_on: string | null; end_on: string | null; state: SprintState; position: number; created_at: string };

/**
 * What the New sprint form starts with (§7.5): the name, start, end, and length after the board's
 * open sprints. Only an open sprint that has not ended is followed; otherwise it starts from today
 * (QA 0.9.0). With `defaults`, the length, start rule, and name pattern come from them.
 */
export function newSprintPlan(sprints: readonly PlanSprint[], today: string, defaults?: SprintDefaults | null) {
  const latest = sprints.filter((sprint) => sprint.state !== "completed").sort((a, b) => (b.end_on ?? "").localeCompare(a.end_on ?? "") || b.position - a.position)[0] ?? null;
  const byName = [...sprints].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  const names = sprints.map((sprint) => sprint.name);
  const name = defaults?.name ? sprintNameFromPattern(defaults.name, names) : nextSprintName(byName?.name ?? null, names);
  const previous = latest && latest.end_on && latest.end_on >= today ? latest : null;
  if (!defaults) {
    const dates = nextSprintDates(previous, today);
    return { name, ...dates, days: sprintDaysBetween(dates.startOn, dates.endOn) + 1 };
  }
  const anchor = defaults.start === "today" || !previous?.end_on ? today : addSprintDays(previous.end_on, 1);
  const startOn = onOrAfterWeekday(anchor, defaults.start);
  return { name, startOn, endOn: sprintEndFor(startOn, defaults.days), days: defaults.days };
}

/**
 * The close dialog's (and `complete_sprint`'s) new sprint: from today (tomorrow when completed on
 * its last day), moved to the start weekday when one is set; as long as the board's default, or as
 * the sprint being completed; named by the pattern, or after that sprint.
 */
export function carryOverPlan(sprint: { name: string; start_on: string | null; end_on: string | null }, today: string, taken: Iterable<string> = [], defaults?: SprintDefaults | null) {
  const dates = sprintDatesAfterCompleting(sprint, today);
  const name = defaults?.name ? sprintNameFromPattern(defaults.name, taken) : nextSprintName(sprint.name, taken);
  if (!defaults) return { name, ...dates };
  const startOn = onOrAfterWeekday(dates.startOn, defaults.start);
  return { name, startOn, endOn: sprintEndFor(startOn, defaults.days) };
}
