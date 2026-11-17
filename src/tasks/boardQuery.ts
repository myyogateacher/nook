// One pipeline for every board view (WAVE_13_TASK_CARD_UX.md §4.5, D113): filter the loaded board
// with the one task grammar (shared/taskQuery.ts), sort, then group for the list view. Pure, no
// DOM access.
//
// Grouping and the filter bar run through two registries, GROUP_DIMENSIONS and FILTER_FIELDS. The
// hierarchy wave (migration 019) adds `parent` and `sprint` entries to both (and to BOARD_GROUPS
// in boardUrl.ts); the router, the filter bar, and the views need no rework.
import type { ReactNode } from "react";
import { priorityIconFor, priorityLabel } from "./priority";
import { cardFilterFromQuery, foldText, LEGACY_URGENT_FLAG, matchesQuery, priorityRank, queryCards, sortCards, TASK_FLAGS, TASK_PRIORITIES, validateQuery, type CardSortKey, type FilterKey, type FilterTerm, type MemoryQueryContext, type QueryCard, type TaskFlag, type TaskQuery, type TaskState } from "../../shared/taskQuery";
import { byPosition } from "./boardOrder";
import type { BoardGroupId, BoardQuery, BoardSort } from "./boardUrl";
import { cardAssignees } from "./taskActions";
import type { BoardColumn, BoardDetail, BoardTag, CardAssignee, CardSummary, SprintSummary } from "./tasksApi";
import { effectiveSprints, sprintPointers, sprintStateLabel } from "./sprintModel";
import { FLAT_STRUCTURE, levelName, type BoardStructure } from "../../shared/boardStructure";
import { rollupMap } from "./hierarchyModel";
import { estimateSettingsOf, type EstimateSettings } from "../../shared/estimates";

export type { BoardTag } from "./tasksApi";

/**
 * The card fields the views read. 13C and 13D added `description_excerpt`, `tag_ids`, `flags`,
 * `relation_count`, and `open_blockers` to the board payload; they are optional here so an older
 * payload still renders.
 */
export type BoardCardInput = CardSummary & Partial<{ description_excerpt: string; tag_ids: string[]; flags: string[]; relation_count: number; open_blockers: number }>;
export type BoardCard = CardSummary & QueryCard & { assignees: CardAssignee[]; tag_ids: string[]; flags: string[]; relation_count?: number; open_blockers?: number };
/** `structure` (17A): the board's levels; Flat for an older payload. `sprints` (17B): open and recent sprints. */
export type BoardData = { columns: BoardColumn[]; cards: BoardCard[]; tags: BoardTag[]; structure?: BoardStructure; sprints?: SprintSummary[]; /** Lane ESTIMATES (D754): off when unknown. */ estimates?: EstimateSettings };

/** The viewer: `today` is their local date, `now` their clock, `timeZone` their zone (for timed cards). */
export type BoardContext = { userId: string; today: string; now: number; timeZone: string };

/**
 * Fills the optional payload fields, so every view reads one shape. Roll-ups (17A) are recounted
 * from the loaded cards, so `has:subtasks` and the chips follow local moves at once.
 */
export function boardData(detail: Pick<BoardDetail, "columns" | "cards"> & { tags?: BoardTag[]; board?: Pick<BoardDetail["board"], "structure" | "estimate_kind" | "estimate_scale">; sprints?: SprintSummary[] }): BoardData {
  const rollups = rollupMap(detail.cards, detail.columns);
  const structure = detail.board?.structure ?? FLAT_STRUCTURE;
  return {
    columns: [...detail.columns].sort(byPosition),
    tags: detail.tags ?? [],
    structure,
    sprints: detail.sprints ?? [],
    estimates: estimateSettingsOf(detail.board),
    // Subtasks take their parent's sprint from the loaded cards (17B, D124), so they follow a local change at once.
    cards: (effectiveSprints(detail.cards, structure.workLevel) as BoardCardInput[]).map((card) => ({
      ...card,
      description_excerpt: card.description_excerpt ?? "",
      tag_ids: card.tag_ids ?? [],
      flags: card.flags ?? [],
      priority: card.priority ?? null,
      assignees: cardAssignees(card) as CardAssignee[],
      child_count: rollups.get(card.id)?.total ?? 0,
      done_child_count: rollups.get(card.id)?.done ?? 0
    }))
  };
}

/** The board's structure (Flat when unknown). */
export const structureOfData = (board: BoardData) => board.structure ?? FLAT_STRUCTURE;
const hasLevelsData = (board: BoardData) => structureOfData(board).levels.length > 1;
/** A card's parent title on this board, or null. */
export const parentTitleOf = (card: Pick<CardSummary, "parent_card_id">, board: BoardData) =>
  card.parent_card_id ? board.cards.find((item) => item.id === card.parent_card_id)?.title ?? null : null;

export const FLAG_LABELS: Record<TaskFlag, string> = { blocked: "Blocked", needs_review: "Needs review", on_hold: "On hold" };
export const DUE_GROUP_LABELS: Record<string, string> = { overdue: "Overdue", today: "Today", week: "Next 7 days", later: "Later", none: "No date" };
export const UNKNOWN_TAG = "Unknown tag";
export const UNKNOWN_PERSON = "Unknown person";

const byName = (a: string, b: string) => foldText(a).localeCompare(foldText(b));

/** Every assignee name the board's cards carry, by id. */
function peopleOf(board: BoardData) {
  const people = new Map<string, string>();
  for (const card of board.cards) for (const person of card.assignees) if (!people.has(person.id)) people.set(person.id, person.display_name);
  return people;
}

export function personLabel(id: string, board: BoardData, context: Pick<BoardContext, "userId">) {
  if (id === "none") return "No assignee";
  if (id === "me") return "Me";
  if (id === context.userId) return `${peopleOf(board).get(id) ?? "You"} (you)`;
  return peopleOf(board).get(id) ?? UNKNOWN_PERSON;
}

/** A tag id (or a tag name from a typed query) as its board name. */
export function tagLabel(value: string, board: BoardData) {
  if (value === "none") return "No tag";
  const tag = board.tags.find((item) => item.id === value) ?? board.tags.find((item) => item.name.toLowerCase() === value.toLowerCase());
  return tag?.name ?? UNKNOWN_TAG;
}

/** A `flag:` value in words; the legacy `urgent` (a link from before priorities, D1313) reads as the priority it means. */
export const flagLabel = (value: string) => value === "none" ? "No flag" : value === LEGACY_URGENT_FLAG ? "Urgent priority" : FLAG_LABELS[value as TaskFlag] ?? value;

/** The context `matchesQuery` needs for this board and viewer. */
export function memoryContext(board: BoardData, context: BoardContext): MemoryQueryContext {
  const columnStates: Record<string, TaskState> = {};
  for (const column of board.columns) {
    // `state` arrived with migration 020 (17C); an older payload derives it from `is_done`.
    const state = (column as BoardColumn & { state?: TaskState }).state;
    columnStates[column.id] = state ?? (column.is_done === 1 ? "done" : "doing");
  }
  return { userId: context.userId, today: context.today, now: context.now, tags: board.tags, columnStates, workLevel: structureOfData(board).workLevel, sprints: sprintPointers(board.sprints ?? []) };
}

export type DueGroup = "overdue" | "today" | "week" | "later" | "none";

/** The one due group of a card (the list's buckets), consistent with the `due:` filter windows. */
export function dueGroupOf(card: BoardCard, board: BoardData, context: BoardContext): DueGroup {
  if (!card.due_on) return "none";
  const memory = memoryContext(board, context);
  const inWindow = (value: string) => matchesQuery(card, { terms: [{ key: "due", negate: false, values: [value] }] }, memory);
  if (inWindow("overdue")) return "overdue";
  if (card.due_on === context.today) return "today";
  return inWindow("week") ? "week" : "later";
}

export type GroupDimension = {
  label: string;
  /** The groups a card belongs to; a card with two assignees or tags is in each of them. */
  keysFor: (card: BoardCard, board: BoardData, context: BoardContext) => string[];
  labelFor: (key: string, board: BoardData, context: BoardContext) => string;
  /** Group order; `always` lists groups shown even when empty (the board's columns). */
  order: (keys: string[], board: BoardData, context: BoardContext) => string[];
  always?: (board: BoardData) => string[];
};

const noneLast = (compare: (a: string, b: string) => number) => (a: string, b: string) => a === "none" ? 1 : b === "none" ? -1 : compare(a, b);

export const GROUP_DIMENSIONS: Record<BoardGroupId, GroupDimension> = {
  column: {
    label: "Column",
    keysFor: (card) => [card.column_id],
    labelFor: (key, board) => board.columns.find((column) => column.id === key)?.name ?? "Column",
    order: (keys, board) => {
      const index = new Map(board.columns.map((column, at) => [column.id, at]));
      return [...keys].sort((a, b) => (index.get(a) ?? Infinity) - (index.get(b) ?? Infinity));
    },
    always: (board) => board.columns.map((column) => column.id)
  },
  assignee: {
    label: "Assignee",
    keysFor: (card) => card.assignees.length ? card.assignees.map((person) => person.id) : ["none"],
    labelFor: (key, board, context) => personLabel(key, board, context),
    order: (keys, board, context) => [...keys].sort(noneLast((a, b) => byName(personLabel(a, board, context), personLabel(b, board, context))))
  },
  tag: {
    label: "Tag",
    keysFor: (card) => card.tag_ids.length ? card.tag_ids : ["none"],
    labelFor: (key, board) => tagLabel(key, board),
    order: (keys, board) => [...keys].sort(noneLast((a, b) => byName(tagLabel(a, board), tagLabel(b, board))))
  },
  priority: {
    // D1316: Urgent, High, Medium, Low, then No priority.
    label: "Priority",
    keysFor: (card) => [card.priority ?? "none"],
    labelFor: (key) => priorityLabel(key),
    order: (keys) => [...keys].sort((a, b) => priorityRank(a === "none" ? null : a) - priorityRank(b === "none" ? null : b))
  },
  flag: {
    label: "Flag",
    keysFor: (card) => card.flags.length ? card.flags : ["none"],
    labelFor: (key) => flagLabel(key),
    order: (keys) => [...keys].sort(noneLast((a, b) => TASK_FLAGS.indexOf(a as TaskFlag) - TASK_FLAGS.indexOf(b as TaskFlag)))
  },
  parent: {
    label: "Parent",
    keysFor: (card) => [card.parent_card_id ?? "none"],
    labelFor: (key, board) => key === "none" ? "No parent" : parentTitleOf({ parent_card_id: key }, board) ?? "Parent in the Bin",
    // Parents in board order (their column, then position), cards without one last.
    order: (keys, board) => {
      const rank = new Map(sortCards(board.cards, board.columns).map((card, index) => [card.id, index]));
      return [...keys].sort(noneLast((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)));
    }
  },
  due: {
    label: "Due date",
    keysFor: (card, board, context) => [dueGroupOf(card, board, context)],
    labelFor: (key) => DUE_GROUP_LABELS[key] ?? key,
    order: (keys) => {
      const order: DueGroup[] = ["overdue", "today", "week", "later", "none"];
      return [...keys].sort((a, b) => order.indexOf(a as DueGroup) - order.indexOf(b as DueGroup));
    }
  }
};

/** `icon`: a value's own icon in the list (a priority's flame or bars, D1315). */
export type FilterOption = { value: string; label: string; swatch?: string; icon?: ReactNode };

/**
 * A field of the filter bar: one grammar key, edited as one positive term whose values OR
 * together (terms AND, §4.6). `match` is only for a field the grammar does not have yet (a
 * hierarchy stub), applied after the grammar.
 */
export type FilterField = {
  label: string;
  key: FilterKey | string;
  optionsFor: (board: BoardData, context: BoardContext) => FilterOption[];
  labelFor: (value: string, board: BoardData, context: BoardContext) => string;
  match?: (card: BoardCard, values: readonly string[], board: BoardData) => boolean;
  /** Whether the bar offers the field on this board (hierarchy fields need levels). */
  available?: (board: BoardData) => boolean;
};

const shortDate = (date: string) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
};

/** A canonical `due:` value in words: "overdue", "before Oct 1, 2026", "no date". */
export function dueValueLabel(value: string) {
  if (value.startsWith("<")) return `before ${shortDate(value.slice(1))}`;
  if (value.startsWith(">")) return `after ${shortDate(value.slice(1))}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `on ${shortDate(value)}`;
  return ({ overdue: "overdue", today: "today", week: "in the next 7 days", "next-week": "in the 7 days after", none: "no date" } as Record<string, string>)[value] ?? value;
}

/** A `sprint:` value in words (17B): the sprint's name, "the backlog", "the current sprint", "the next sprint". */
export function sprintValueLabel(value: string, board: BoardData) {
  if (value === "none") return "the backlog";
  if (value === "current") return "the current sprint";
  if (value === "next") return "the next sprint";
  return (board.sprints ?? []).find((sprint) => sprint.id === value)?.name ?? "an older sprint";
}

export const HAS_LABELS: Record<string, string> = { relation: "has relations", blocked: "is blocked", subtasks: "has subtasks" };
const STATE_LABELS: Record<string, string> = { todo: "to do", doing: "in progress", done: "done" };

export const FILTER_FIELDS: Record<string, FilterField> = {
  assignee: {
    label: "Assignee",
    key: "assignee",
    optionsFor: (board, context) => [
      { value: "me", label: "Me" },
      ...[...peopleOf(board).entries()].filter(([id]) => id !== context.userId).map(([id, name]) => ({ value: id, label: name })).sort((a, b) => byName(a.label, b.label)),
      { value: "none", label: "No assignee" }
    ],
    labelFor: (value, board, context) => personLabel(value, board, context)
  },
  tag: {
    label: "Tag",
    key: "tag",
    optionsFor: (board) => [...[...board.tags].sort((a, b) => byName(a.name, b.name)).map((tag) => ({ value: tag.id, label: tag.name, swatch: tag.color })), { value: "none", label: "No tag" }],
    labelFor: (value, board) => tagLabel(value, board)
  },
  priority: {
    // D1315: several priorities OR together, as every other field's values do.
    label: "Priority",
    key: "priority",
    optionsFor: () => [...TASK_PRIORITIES.map((priority) => ({ value: priority, label: priorityLabel(priority), icon: priorityIconFor(priority) })), { value: "none", label: "No priority", icon: priorityIconFor("none") }],
    labelFor: (value) => priorityLabel(value)
  },
  flag: {
    label: "Flag",
    key: "flag",
    optionsFor: () => [...TASK_FLAGS.map((flag) => ({ value: flag, label: FLAG_LABELS[flag] })), { value: "none", label: "No flag" }],
    labelFor: (value) => flagLabel(value)
  },
  due: {
    label: "Due",
    key: "due",
    optionsFor: () => [
      { value: "overdue", label: "Overdue" }, { value: "today", label: "Today" }, { value: "week", label: "Next 7 days" },
      { value: "next-week", label: "The 7 days after" }, { value: "none", label: "No date" }
    ],
    labelFor: (value) => dueValueLabel(value)
  },
  start: {
    // D722: the card's start, with the due field's windows and dates (no Overdue).
    label: "Start",
    key: "start",
    optionsFor: () => [
      { value: "today", label: "Today" }, { value: "week", label: "Next 7 days" },
      { value: "next-week", label: "The 7 days after" }, { value: "none", label: "No start date" }
    ],
    labelFor: (value) => dueValueLabel(value)
  },
  column: {
    label: "Column",
    key: "column",
    optionsFor: (board) => board.columns.map((column) => ({ value: column.id, label: column.name })),
    labelFor: (value, board) => board.columns.find((column) => column.id === value)?.name ?? "Unknown column"
  },
  has: {
    label: "Relations",
    key: "has",
    optionsFor: (board) => [{ value: "relation", label: "Has relations" }, { value: "blocked", label: "Is blocked" },
      ...(hasLevelsData(board) ? [{ value: "subtasks", label: "Has subtasks" }] : [])],
    labelFor: (value) => HAS_LABELS[value] ?? value
  },
  level: {
    label: "Level",
    key: "level",
    available: hasLevelsData,
    optionsFor: (board) => [{ value: "work", label: `Work level (${levelName(structureOfData(board), structureOfData(board).workLevel)})` },
      ...structureOfData(board).levels.map((level, index) => ({ value: String(index), label: level.name }))],
    labelFor: (value, board) => value === "work" ? "work level" : levelName(structureOfData(board), Number(value))
  },
  sprint: {
    // 17B: the board's switcher picks one sprint; this field filters by several (or the backlog) within that view.
    label: "Sprint",
    key: "sprint",
    available: (board) => structureOfData(board).sprints,
    optionsFor: (board) => [
      ...(board.sprints ?? []).map((sprint) => ({ value: sprint.id, label: `${sprint.name} (${sprintStateLabel(sprint).toLowerCase()})` })),
      { value: "none", label: "Backlog (no sprint)" }
    ],
    labelFor: (value, board) => sprintValueLabel(value, board)
  },
  parent: {
    label: "Parent",
    key: "parent",
    available: hasLevelsData,
    optionsFor: (board) => [{ value: "none", label: "No parent" },
      ...board.cards.filter((card) => (card.level ?? 0) < structureOfData(board).levels.length - 1)
        .map((card) => ({ value: card.id, label: card.title })).sort((a, b) => byName(a.label, b.label))],
    labelFor: (value, board) => value === "none" ? "no parent" : parentTitleOf({ parent_card_id: value }, board) ?? "a card in the Bin"
  }
};

/** A term value in words, for chips; also for keys the bar does not offer but a shared URL may carry. */
export function termValueLabel(key: string, value: string, board: BoardData, context: BoardContext) {
  const field = FILTER_FIELDS[key];
  if (field) return field.labelFor(value, board, context);
  if (key === "state") return STATE_LABELS[value] ?? value;
  if (key === "creator") return personLabel(value, board, context);
  if (key === "board") return "this board";
  return value;
}

/** The label of a term's field, for chips ("Assignee", "Text", "State"). */
export function termFieldLabel(key: string) {
  return FILTER_FIELDS[key]?.label ?? ({ text: "Text", state: "State", creator: "Created by", board: "Board" } as Record<string, string>)[key] ?? key;
}

/** The values of the positive term for `key` (the one the bar edits), or []. */
export function termValues(query: TaskQuery, key: string): string[] {
  return query.terms.find((term) => term.key === key && !term.negate)?.values ?? [];
}

/** Re-validates a hand-built query with the grammar's own rules (board-scoped, lenient), so it stays canonical. */
function canonical(terms: FilterTerm[]): TaskQuery {
  const parsed = validateQuery({ terms }, { boardScoped: true, lenient: true });
  return parsed.ok ? parsed.query : { terms: [] };
}

/** Replaces the positive term for `key` with `values` (or removes it when empty), keeping every other term. */
export function withTermValues(query: TaskQuery, key: FilterKey, values: readonly string[]): TaskQuery {
  const others = query.terms.filter((term) => term.key !== key || term.negate);
  return canonical(values.length ? [...others, { key, negate: false, values: [...values] }] : others);
}

/** Removes one term (a chip's ×). */
export function withoutTerm(query: TaskQuery, index: number): TaskQuery {
  return canonical(query.terms.filter((_, at) => at !== index));
}

/** The positive text term (the filter box), or "". */
export const textTerm = (query: TaskQuery) => termValues(query, "text")[0] ?? "";

/** Sets or clears the positive text term (1–100 characters). */
export const withText = (query: TaskQuery, text: string) => withTermValues(query, "text", text.trim() ? [text.trim().slice(0, 100)] : []);

/**
 * The board's cards a query keeps, in board order. A query the structured filter models runs
 * through `queryCards` (the 13C pipeline, with its SQL parity test); any other (negation, relative
 * due windows, `has:`, tag names, `state:`) runs through the grammar's in-memory matcher.
 */
export function filterBoardCards(board: BoardData, query: TaskQuery, context: BoardContext): BoardCard[] {
  const structured = cardFilterFromQuery(query);
  if (structured) return queryCards(board.cards, board.columns, structured, { userId: context.userId });
  const memory = memoryContext(board, context);
  return sortCards(board.cards.filter((card) => matchesQuery(card, query, memory)), board.columns);
}

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Sorts by a table column. `title`, `due`, `created`, and `updated` are the shared sort; the rest tie-break on board order. */
export function sortBoardCards(cards: readonly BoardCard[], board: BoardData, sort: BoardSort | null): BoardCard[] {
  if (!sort) return sortCards(cards, board.columns);
  const shared: Partial<Record<BoardSort["field"], CardSortKey>> = { title: "title", due: "due", created: "created", updated: "updated", column: "board", priority: "priority" };
  const key = shared[sort.field];
  if (key) return sortCards(cards, board.columns, { key, direction: sort.direction });
  const inBoardOrder = sortCards(cards, board.columns);
  const rank = new Map(inBoardOrder.map((card, index) => [card.id, index]));
  const sign = sort.direction === "desc" ? -1 : 1;
  if (sort.field === "estimate") {
    // By number (D754); cards without an estimate sort last both ways, like an empty due date.
    return [...inBoardOrder].sort((a, b) => {
      const left = a.estimate ?? null;
      const right = b.estimate ?? null;
      if (left === right) return rank.get(a.id)! - rank.get(b.id)!;
      if (left === null) return 1;
      if (right === null) return -1;
      return sign * (left - right) || rank.get(a.id)! - rank.get(b.id)!;
    });
  }
  // The first value of a multi-valued field; empty cards sort last both ways.
  const first = (card: BoardCard): string | null => {
    if (sort.field === "assignees") return card.assignees[0] ? foldText(card.assignees[0].display_name) : null;
    if (sort.field === "tags") return card.tag_ids[0] ? foldText(tagLabel(card.tag_ids[0], board)) : null;
    const flags = card.flags.map((flag) => TASK_FLAGS.indexOf(flag as TaskFlag)).filter((index) => index >= 0).sort();
    return flags.length ? String(flags[0]) : null;
  };
  return [...inBoardOrder].sort((a, b) => {
    const left = first(a);
    const right = first(b);
    if (left === right) return rank.get(a.id)! - rank.get(b.id)!;
    if (left === null) return 1;
    if (right === null) return -1;
    return sign * compareText(left, right) || rank.get(a.id)! - rank.get(b.id)!;
  });
}

/** `childCount`: direct children; `descendantCount`: every card under it (children and theirs). */
export type TreeRow = { card: BoardCard; depth: number; childCount: number; descendantCount: number };

/**
 * The table's tree (research 2026-09-26 §8): each card followed by its children, in the order the
 * rows came (board order when unsorted), indented by depth. A card whose parent is filtered out or
 * binned is a root. `collapsed` hides a card's descendants.
 */
export function treeRows(cards: readonly BoardCard[], collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const ids = new Set(cards.map((card) => card.id));
  const children = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!card.parent_card_id || !ids.has(card.parent_card_id)) continue;
    children.set(card.parent_card_id, [...(children.get(card.parent_card_id) ?? []), card]);
  }
  const rows: TreeRow[] = [];
  const visit = (card: BoardCard, depth: number) => {
    const kids = children.get(card.id) ?? [];
    const below = (id: string): number => (children.get(id) ?? []).reduce((sum, kid) => sum + 1 + below(kid.id), 0);
    rows.push({ card, depth, childCount: kids.length, descendantCount: below(card.id) });
    // Depth is at most 2 (D121), so this never recurses further than that.
    if (!collapsed.has(card.id) && depth < 2) for (const kid of kids) visit(kid, depth + 1);
  };
  for (const card of cards) if (!card.parent_card_id || !ids.has(card.parent_card_id)) visit(card, 0);
  return rows;
}

export type BoardGroup = {
  key: string;
  label: string;
  /** Each card, with the labels of the other groups it also appears in ("also in …"). */
  items: Array<{ card: BoardCard; also: string[] }>;
};

export type BoardQueryResult = { cards: BoardCard[]; groups: BoardGroup[] | null };

export type BoardRegistries = { groups: Record<string, GroupDimension>; filters: Record<string, FilterField> };
export const BOARD_REGISTRIES: BoardRegistries = { groups: GROUP_DIMENSIONS, filters: FILTER_FIELDS };

/**
 * The cards a view shows, in order, and for the list view their groups. Filters run first (the
 * grammar, then any registry field with its own `match` over `extra`), then the sort, then
 * grouping (`query.group`, by column by default).
 */
export function applyBoardQuery(board: BoardData, query: Pick<BoardQuery, "view" | "group" | "sort" | "filter"> & { extra?: Record<string, readonly string[]> }, context: BoardContext, registries: BoardRegistries = BOARD_REGISTRIES): BoardQueryResult {
  let cards = filterBoardCards(board, query.filter, context);
  for (const [id, values] of Object.entries(query.extra ?? {})) {
    const field = registries.filters[id];
    if (field?.match && values.length) cards = cards.filter((card) => field.match!(card, values, board));
  }
  const sorted = sortBoardCards(cards, board, query.sort);
  if (query.view !== "list") return { cards: sorted, groups: null };
  const dimension = registries.groups[query.group ?? "column"] ?? registries.groups.column!;
  const members = new Map<string, BoardCard[]>();
  for (const key of dimension.always?.(board) ?? []) members.set(key, []);
  const keysOf = new Map<string, string[]>();
  for (const card of sorted) {
    const keys = [...new Set(dimension.keysFor(card, board, context))];
    keysOf.set(card.id, keys);
    for (const key of keys) {
      const list = members.get(key) ?? [];
      list.push(card);
      members.set(key, list);
    }
  }
  const labels = new Map([...members.keys()].map((key) => [key, dimension.labelFor(key, board, context)]));
  const groups = dimension.order([...members.keys()], board, context).map((key) => ({
    key,
    label: labels.get(key)!,
    items: members.get(key)!.map((card) => ({ card, also: keysOf.get(card.id)!.filter((other) => other !== key).map((other) => labels.get(other)!) }))
  }));
  return { cards: sorted, groups };
}
