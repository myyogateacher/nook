// The board's presentation state in the URL query (WAVE_13_TASK_CARD_UX.md D112, §4.6, T102).
// Pure: no DOM access. Filters are the one task grammar of shared/taskQuery.ts, carried as a
// canonical `q=` by its URL codec (`decodeFilterParams` / `encodeFilterParams`, which still read
// the older per-key parameters). This module only adds the presentation keys the grammar leaves
// to its callers: `view`, `group`, `sort`, `cal`, `month`, `sprint` (17B), `swim` (lane VIEWS2), and
// `zoom` (the timeline's scale, D762).
//
// Decoding never throws: unknown keys and invalid values are dropped (the grammar decodes
// leniently, within its limits). Encoding is canonical (fixed key order, defaults left out,
// canonical filter text), so `sameRoute` is stable and a shared link reads the same everywhere.
import { decodeFilterParams, encodeFilterParams, FILTER_PARAM_KEYS, type TaskQuery } from "../../shared/taskQuery";
import { isSwimlaneMode, type SwimlaneMode } from "../../shared/swimlanes";

export const BOARD_VIEWS = ["board", "table", "list", "calendar", "timeline"] as const;
export type BoardViewId = typeof BOARD_VIEWS[number];

/**
 * Grouping dimensions of the list view (§4.5). The hierarchy wave adds `parent` and `sprint`
 * here and in `GROUP_DIMENSIONS` (src/tasks/boardQuery.ts); nothing else changes.
 */
export const BOARD_GROUPS = ["column", "assignee", "tag", "priority", "flag", "parent", "due"] as const;
export type BoardGroupId = typeof BOARD_GROUPS[number];

/** Sortable table columns (§4.5); `estimate` shows only on boards with estimates on (lane ESTIMATES, D754). */
export const BOARD_SORT_FIELDS = ["title", "column", "assignees", "due", "priority", "tags", "flags", "created", "updated", "estimate"] as const;
export type BoardSortField = typeof BOARD_SORT_FIELDS[number];
export type BoardSort = { field: BoardSortField; direction: "asc" | "desc" };

export type CalendarLayout = "month" | "agenda";

/** The timeline's zoom (D762); `month` is the default and is left out of the URL. */
export const TIMELINE_ZOOMS = ["week", "month", "quarter"] as const;
export type TimelineZoom = typeof TIMELINE_ZOOMS[number];

export type BoardQuery = {
  view: BoardViewId;
  /** The list view's grouping; null means the default (by column). */
  group: BoardGroupId | null;
  /** Null keeps the board order. */
  sort: BoardSort | null;
  cal: CalendarLayout;
  /** `YYYY-MM` for the calendar view; null means the current month. */
  month: string | null;
  /** The filter bar's terms, board-scoped (`column:` is valid without `board:`). */
  filter: TaskQuery;
  /**
   * The sprint the board shows (17B, §7.3): `backlog`, `all`, or a sprint id; null (or absent) is the
   * current sprint: the active one, else the backlog. Only boards with sprints on read it.
   */
  sprint?: string | null;
  /**
   * Lane VIEWS2 (D655): the board layout's swimlanes, rows by `assignee` or `parent`, or `none`. Null (or
   * absent) is the default: none on the board, the saved view's own in a board view.
   */
  swim?: SwimlaneMode | "none" | null;
  /** The timeline's zoom (D762); null (or absent) is `month`. */
  zoom?: TimelineZoom | null;
};

const emptyFilter = (): TaskQuery => ({ terms: [] });
export const DEFAULT_BOARD_QUERY: BoardQuery = Object.freeze({ view: "board", group: null, sort: null, cal: "month", month: null, sprint: null, swim: null, zoom: null, filter: Object.freeze({ terms: Object.freeze([]) }) }) as unknown as BoardQuery;

/** The same rule as `isRouteMonth` in src/router.ts (kept here so the codec has no import cycle). */
const monthPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;
export function isBoardMonth(value: string) {
  const match = monthPattern.exec(value);
  return match !== null && Number(match[1]) >= 1900 && Number(match[1]) <= 2200;
}

const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | null =>
  value !== null && value !== undefined && (list as readonly string[]).includes(value) ? value as T : null;

const sprintIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A `?sprint=` value (17B): `backlog`, `all`, or a sprint id (lower-cased); `current`, anything else, or nothing is null. */
export function parseBoardSprint(value: string | null | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "backlog" || lower === "all") return lower;
  return sprintIdPattern.test(lower) ? lower : null;
}

/** A `field:asc|desc` sort, or null. */
export function parseBoardSort(value: string | null | undefined): BoardSort | null {
  const match = value ? /^([a-z]+):(asc|desc)$/.exec(value) : null;
  const field = oneOf(BOARD_SORT_FIELDS, match?.[1]);
  return field && match ? { field, direction: match[2] as "asc" | "desc" } : null;
}

/** A search string (with or without its leading `?`) as a board query. Oversized input reads as the default. */
export function parseBoardSearch(search: string): BoardQuery {
  if (!search || search.length > 4096) return { ...DEFAULT_BOARD_QUERY, filter: emptyFilter() };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return { ...DEFAULT_BOARD_QUERY, filter: emptyFilter() };
  }
  const month = params.get("month");
  return {
    view: oneOf(BOARD_VIEWS, params.get("view")) ?? "board",
    group: oneOf(BOARD_GROUPS, params.get("group")),
    sort: parseBoardSort(params.get("sort")),
    cal: oneOf(["month", "agenda"] as const, params.get("cal")) ?? "month",
    month: month && isBoardMonth(month) ? month : null,
    sprint: parseBoardSprint(params.get("sprint")),
    swim: isSwimlaneMode(params.get("swim")) || params.get("swim") === "none" ? params.get("swim") as SwimlaneMode | "none" : null,
    zoom: oneOf(TIMELINE_ZOOMS, params.get("zoom")) === "month" ? null : oneOf(TIMELINE_ZOOMS, params.get("zoom")),
    filter: decodeFilterParams(params, { boardScoped: true })
  };
}

/** The canonical search string of a query: "" for the default, otherwise "?view=…&…". */
export function formatBoardSearch(query: BoardQuery): string {
  const params = new URLSearchParams();
  if (query.view !== "board" && oneOf(BOARD_VIEWS, query.view)) params.set("view", query.view);
  if (query.group && oneOf(BOARD_GROUPS, query.group)) params.set("group", query.group);
  if (query.sort && oneOf(BOARD_SORT_FIELDS, query.sort.field) && (query.sort.direction === "asc" || query.sort.direction === "desc")) params.set("sort", `${query.sort.field}:${query.sort.direction}`);
  if (query.cal === "agenda") params.set("cal", "agenda");
  if (query.month && isBoardMonth(query.month)) params.set("month", query.month);
  const sprint = parseBoardSprint(query.sprint);
  if (sprint) params.set("sprint", sprint);
  if (isSwimlaneMode(query.swim) || query.swim === "none") params.set("swim", query.swim);
  if (query.zoom && query.zoom !== "month" && oneOf(TIMELINE_ZOOMS, query.zoom)) params.set("zoom", query.zoom);
  encodeFilterParams(query.filter, params);
  // `:` and `,` are legal in a query; keeping them readable makes shared links easier to read
  // ("sort=due:asc&q=assignee:me+priority:high,urgent").
  const text = params.toString().replace(/%3A/gi, ":").replace(/%2C/gi, ",");
  return text ? `?${text}` : "";
}


/** Whether a search string carries a filter at all (`q`, even empty, or an older per-key one): a saved view's unsaved change (D636). */
export function hasFilterParam(search: string) {
  if (!search || search.length > 4096) return false;
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return FILTER_PARAM_KEYS.some((key) => params.has(key));
  } catch {
    return false;
  }
}

/**
 * A saved view's search on its board (D636): the board's presentation keys, and the filter only when
 * it is an unsaved change, written as `q=` even when empty (an emptied filter is still a change).
 */
export function formatBoardViewSearch(query: BoardQuery | undefined, unsaved: boolean) {
  const base = formatBoardSearch({ ...(query ?? DEFAULT_BOARD_QUERY), filter: unsaved && query ? query.filter : emptyFilter() });
  if (!unsaved || /(^\?|&)q=/.test(base)) return base;
  return `${base}${base ? "&" : "?"}q=`;
}

/** Whether a query is the default one (no query string at all). */
export const isDefaultBoardQuery = (query: BoardQuery) => formatBoardSearch(query) === "";

/** Whether a query filters any cards (the filter bar's Clear, and the "matching" copy). */
export const hasBoardFilter = (query: BoardQuery) => query.filter.terms.length > 0;

/** A copy of `query` with changes, keeping every other key. */
export function withBoardQuery(query: BoardQuery, change: Partial<BoardQuery>): BoardQuery {
  return { ...query, ...change, filter: change.filter ?? query.filter };
}
