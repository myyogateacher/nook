// Sprints on the board (research 2026-09-26 §7.3, §7.5, §9.4 D): which sprint the board shows, its
// progress, and the words for it. Pure, no DOM access, so it is unit tested.
import type { FilterTerm, TaskState } from "../../shared/taskQuery";
import type { BoardStructure } from "../../shared/boardStructure";
import { carryOverPlan, newSprintPlan, sprintDaysBetween, type SprintDefaults, type SprintStartRule } from "../../shared/sprintPlan";
import type { BoardColumn, CardSummary, SprintSummary } from "./tasksApi";

/** What the switcher shows: one sprint, the backlog (no sprint), or every card. */
export type SprintSelection = { kind: "sprint"; sprint: SprintSummary } | { kind: "backlog" } | { kind: "all" };

/** The switcher's value for a selection: the sprint id, `backlog`, or `all`. */
export const selectionValue = (selection: SprintSelection) => selection.kind === "sprint" ? selection.sprint.id : selection.kind;

/** The server's order: the active sprint, planned ones by position, then completed ones newest first. */
export function orderSprints(sprints: readonly SprintSummary[]): SprintSummary[] {
  const rank = (sprint: SprintSummary) => sprint.state === "active" ? 0 : sprint.state === "planned" ? 1 : 2;
  return [...sprints].sort((a, b) => rank(a) - rank(b)
    || (a.state === "completed" ? (b.completed_at ?? "").localeCompare(a.completed_at ?? "") : a.position - b.position)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Replaces or adds one sprint, keeping the order. */
export const withSprint = (sprints: readonly SprintSummary[], sprint: SprintSummary) =>
  orderSprints([...sprints.filter((item) => item.id !== sprint.id), sprint]);

/** The board's active sprint, or null. */
export const activeSprint = (sprints: readonly SprintSummary[]) => sprints.find((sprint) => sprint.state === "active") ?? null;

/** Planned sprints in board order (the server lists them by position). */
export const plannedSprints = (sprints: readonly SprintSummary[]) => sprints.filter((sprint) => sprint.state === "planned");

/** The sprints a card can be planned in: the active one first, then planned ones. */
export const openSprints = (sprints: readonly SprintSummary[]) => sprints.filter((sprint) => sprint.state !== "completed");

/**
 * The board's selection for a `?sprint=` value (§7.3): null (or `current`) is the active sprint, or
 * the backlog when none is active; an unknown id falls back to that default. Null on a board
 * without sprints.
 */
export function resolveSprintSelection(value: string | null | undefined, sprints: readonly SprintSummary[], structure: BoardStructure): SprintSelection | null {
  if (!structure.sprints) return null;
  if (value === "all") return { kind: "all" };
  if (value === "backlog") return { kind: "backlog" };
  const chosen = value ? sprints.find((sprint) => sprint.id === value) : undefined;
  if (chosen) return { kind: "sprint", sprint: chosen };
  const active = activeSprint(sprints);
  return active ? { kind: "sprint", sprint: active } : { kind: "backlog" };
}

/** The URL value that selects `value`: null for the default (the current sprint), so the URL stays short. */
export function sprintQueryValue(value: string, sprints: readonly SprintSummary[]): string | null {
  const active = activeSprint(sprints);
  if (active ? value === active.id : value === "backlog") return null;
  return value;
}

/** The grammar term a selection adds to the board's filter (§8): `sprint:<id>` or `sprint:none`; none for all. */
export function selectionTerm(selection: SprintSelection | null): FilterTerm | null {
  if (!selection || selection.kind === "all") return null;
  return { key: "sprint", negate: false, values: [selection.kind === "sprint" ? selection.sprint.id : "none"] };
}

/**
 * The filter bar's sprint filter against the header switcher (QA 0.9.0): when both are set and
 * name different sprints, the board shows nothing, so say why: "Showing Sprint 2 cards within
 * Sprint 1 — clear one". Null when they agree or either is unset.
 */
export function sprintFilterConflict(terms: readonly FilterTerm[], selection: SprintSelection | null, sprints: readonly SprintSummary[]) {
  if (!selection || selection.kind === "all") return null;
  const term = terms.find((item) => item.key === "sprint" && !item.negate);
  if (!term || !term.values.length) return null;
  const pointers = sprintPointers(sprints);
  const resolve = (value: string) => value === "current" ? pointers.current : value === "next" ? pointers.next : value;
  const selected = selection.kind === "sprint" ? selection.sprint.id : "none";
  if (term.values.some((value) => resolve(value) === selected)) return null;
  const name = (value: string) => value === "none" ? "backlog" : sprints.find((sprint) => sprint.id === resolve(value))?.name
    ?? (value === "current" ? "current sprint" : value === "next" ? "next sprint" : "older sprint");
  return `Showing ${term.values.map(name).join(" or ")} cards within ${selection.kind === "sprint" ? selection.sprint.name : "the backlog"} — clear one`;
}

/** `sprint:current` and `sprint:next` for the in-memory matcher. */
export function sprintPointers(sprints: readonly SprintSummary[]) {
  return { current: activeSprint(sprints)?.id ?? null, next: plannedSprints(sprints)[0]?.id ?? null };
}

type SprintCard = Pick<CardSummary, "id" | "parent_card_id" | "level" | "sprint_id">;

/**
 * Each card's sprint as the server derives it (D124): its own on the work level, its work-level
 * ancestor's below it, and none above it or without such an ancestor. Recomputed from the loaded
 * cards so a subtask follows its parent at once after a local change.
 */
export function effectiveSprints<T extends SprintCard>(cards: readonly T[], workLevel: number): T[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const sprintOf = (card: T): string | null => {
    const level = card.level ?? 0;
    if (level === workLevel) return card.sprint_id ?? null;
    if (level < workLevel) return null;
    let current: T | undefined = card;
    // Depth is at most 2 (D121), so this takes at most two steps.
    for (let step = 0; step < 2 && current && (current.level ?? 0) > workLevel; step += 1) current = current.parent_card_id ? byId.get(current.parent_card_id) : undefined;
    return current && (current.level ?? 0) === workLevel ? current.sprint_id ?? null : null;
  };
  return cards.map((card) => {
    const sprint = sprintOf(card);
    return (card.sprint_id ?? null) === sprint ? card : { ...card, sprint_id: sprint };
  });
}

export type SprintProgress = { total: number; done: number; doing: number; todo: number };

/** A column's state: `state` (migration 020) or, on an older payload, done or doing. */
const columnState = (column: BoardColumn): TaskState => (column as BoardColumn & { state?: TaskState }).state ?? (column.is_done === 1 ? "done" : "doing");

/**
 * The progress strip's counts (§7.3, D134): the work-level cards of a sprint (or of the backlog, for
 * null), by their column's state. Subtasks are not counted, and there are no points (Q4).
 */
export function sprintProgress(cards: ReadonlyArray<SprintCard & Pick<CardSummary, "column_id">>, columns: readonly BoardColumn[], sprintId: string | null, workLevel: number): SprintProgress {
  const states = new Map(columns.map((column) => [column.id, columnState(column)]));
  const progress: SprintProgress = { total: 0, done: 0, doing: 0, todo: 0 };
  for (const card of cards) {
    if ((card.level ?? 0) !== workLevel || (card.sprint_id ?? null) !== sprintId) continue;
    progress.total += 1;
    progress[states.get(card.column_id) ?? "doing"] += 1;
  }
  return progress;
}

/** The sprints with `card_count` and `done_count` from the loaded cards, so they follow local changes at once. */
export function withLocalCounts(sprints: readonly SprintSummary[], cards: ReadonlyArray<SprintCard & Pick<CardSummary, "column_id">>, columns: readonly BoardColumn[], workLevel: number) {
  return sprints.map((sprint) => {
    const progress = sprintProgress(cards, columns, sprint.id, workLevel);
    return progress.total === sprint.card_count && progress.done === sprint.done_count ? sprint : { ...sprint, card_count: progress.total, done_count: progress.done };
  });
}

const monthDay = (date: string) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
};

/** "Sep 22 – Oct 3", "From Sep 22", "Until Oct 3", or "" without dates. */
export function sprintDateRange(sprint: Pick<SprintSummary, "start_on" | "end_on">) {
  if (sprint.start_on && sprint.end_on) return `${monthDay(sprint.start_on)} – ${monthDay(sprint.end_on)}`;
  if (sprint.start_on) return `From ${monthDay(sprint.start_on)}`;
  if (sprint.end_on) return `Until ${monthDay(sprint.end_on)}`;
  return "";
}

const days = (count: number) => count === 1 ? "1 day" : `${count} days`;

/** "4 days left", "Ends today", "Ended 2 days ago", "Starts in 3 days", or "" (by the viewer's local date). */
export function sprintTiming(sprint: Pick<SprintSummary, "state" | "start_on" | "end_on">, today: string) {
  if (sprint.state === "completed") return "Completed";
  if (sprint.state === "planned" && sprint.start_on && sprint.start_on > today) return `Starts in ${days(sprintDaysBetween(today, sprint.start_on))}`;
  if (!sprint.end_on) return sprint.state === "active" ? "Active" : "";
  const left = sprintDaysBetween(today, sprint.end_on);
  if (left > 0) return `${days(left)} left`;
  if (left === 0) return "Ends today";
  return `Ended ${days(-left)} ago`;
}

/** The state in words, for option descriptions: "Active", "Planned", "Completed". */
export const sprintStateLabel = (sprint: Pick<SprintSummary, "state">) => sprint.state === "active" ? "Active" : sprint.state === "planned" ? "Planned" : "Completed";

/** "8 of 14 done", "14 tasks", "No tasks yet". */
export function progressLabel(progress: SprintProgress, plural: string) {
  if (!progress.total) return `No ${plural.toLowerCase()} yet`;
  return `${progress.done} of ${progress.total} done`;
}

/**
 * What the New sprint form starts with: the next name and dates after the latest open sprint
 * (§7.5), by the board's sprint defaults when it has them (length, start rule, name pattern).
 */
export function newSprintDefaults(sprints: readonly SprintSummary[], today: string, defaults?: SprintDefaults | null) {
  const { name, startOn, endOn } = newSprintPlan(sprints, today, defaults);
  return { name, startOn, endOn };
}

/** The close dialog's "New sprint" choice: named (skipping the board's other names) and dated after the sprint being completed, as the server does. */
export function carryOverSprint(sprint: Pick<SprintSummary, "name" | "start_on" | "end_on">, today: string, taken: readonly string[] = [], defaults?: SprintDefaults | null) {
  return carryOverPlan(sprint, today, taken, defaults);
}

/** The Duration choices (New sprint, Sprint defaults): 1–4 weeks or Custom. */
export const DURATION_WEEKS = [7, 14, 21, 28] as const;
export const CUSTOM_DURATION = "custom";
export const durationOptions = () => [
  ...DURATION_WEEKS.map((days) => ({ value: String(days), label: days === 7 ? "1 week" : `${days / 7} weeks` })),
  { value: CUSTOM_DURATION, label: "Custom" }
];
/** The Duration select's value for a length in days: a week count, or Custom. */
export const durationValue = (days: number) => (DURATION_WEEKS as readonly number[]).includes(days) ? String(days) : CUSTOM_DURATION;
/** "2 weeks", "10 days", "1 day". */
export const durationLabel = (days: number) => days % 7 === 0 ? (days === 7 ? "1 week" : `${days / 7} weeks`) : days === 1 ? "1 day" : `${days} days`;
/** A sprint's length in days (start and end included), or null without both dates or backwards. */
export const sprintLength = (startOn: string, endOn: string) => startOn && endOn && startOn <= endOn ? sprintDaysBetween(startOn, endOn) + 1 : null;

/** Sprint defaults' Start on choices. */
export const START_RULE_OPTIONS: Array<{ value: SprintStartRule; label: string; description?: string }> = [
  { value: "next", label: "The day after the previous sprint", description: "Today when none is open" },
  { value: "today", label: "Today" },
  ...(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((value, index) => ({
    value, label: `A ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index]}`, description: "On or after the day after the previous sprint"
  }))
];
