import type { Route } from "./router";
import { isDefaultBoardQuery, type BoardQuery } from "./tasks/boardUrl";
import type { TasksHome } from "./tasks/home/homeUrl";

export type TasksRoute = Extract<Route, { app: "tasks" }>;

/**
 * A Tasks route. `full` opens the card as a page (13D); `query` (the board's view and filters,
 * D112) is kept only with a board and when it is not the default.
 */
export function tasksRoute(boardId: string | null = null, cardId: string | null = null, full = false, query?: BoardQuery | null): TasksRoute {
  const card = boardId ? cardId : null;
  const route: TasksRoute = card && full ? { app: "tasks", boardId, cardId: card, full: true } : { app: "tasks", boardId, cardId: card };
  return boardId && query && !isDefaultBoardQuery(query) ? { ...route, query } : route;
}

/** The board's Sprints sheet (/tasks/:b/sprints), keeping the board's view and filters under it. */
export function boardSprintsRoute(boardId: string, query?: BoardQuery | null): TasksRoute {
  return { ...tasksRoute(boardId, null, false, query), sprints: true };
}

/** A Tasks home segment (17C): My work, the views list, or one view, with its query. */
export function tasksHomeRoute(home: TasksHome): TasksRoute {
  return { app: "tasks", boardId: null, cardId: null, home };
}

/**
 * The view one level up, used when in-app Back has no history entry of this visit to step back
 * to (a deep link): full page → card dialog → board (each in the same view) → board list → Home (null).
 * On the home: a view → the views list → the board list (/tasks); My work → the board list.
 */
export function parentTasksRoute(route: TasksRoute): TasksRoute | null {
  if (!route.boardId && route.home) return route.home.section === "view" ? tasksHomeRoute({ section: "views" }) : tasksRoute();
  if (route.cardId && route.full) return tasksRoute(route.boardId, route.cardId, false, route.query);
  if (route.cardId || (route.boardId && route.sprints)) return tasksRoute(route.boardId, null, false, route.query);
  if (route.boardId) return tasksRoute();
  return null;
}

/**
 * In-app Back: step back through entries this visit pushed (the `mynotes.depth` counter), so it
 * matches the browser's Back; otherwise replace the entry with the parent view, or go Home from
 * the board list. It never leaves Nook.
 */
export function tasksBackAction(route: TasksRoute, depth: number): { kind: "history" } | { kind: "replace"; route: TasksRoute } | { kind: "home" } {
  if (depth > 0) return { kind: "history" };
  const parent = parentTasksRoute(route);
  return parent ? { kind: "replace", route: parent } : { kind: "home" };
}

// The entry that Expand pushes from the card dialog carries this hint (§4.7), so Collapse and Close
// on the full page know the dialog, and the board before it, are the entries just below.
const fromDialogKey = "mynotes.tasks.fromDialog";

export function withFromDialogHint(state: unknown) {
  const base = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return { ...base, [fromDialogKey]: true };
}

export function hasFromDialogHint(state: unknown) {
  return Boolean(state && typeof state === "object" && (state as Record<string, unknown>)[fromDialogKey] === true);
}

/**
 * Collapse and Close on the full page (§4.7). With the hint, step back through the entries Expand
 * came from: Collapse returns to the dialog (one back) and Close to the entry before it (two back).
 * Otherwise (a deep link, a reload of an older entry, a page opened from a relation link) replace
 * the entry, so neither ever leaves Nook.
 */
export function fullPageAction(action: "collapse" | "close", route: TasksRoute, state: unknown, depth: number): { kind: "history"; delta: number } | { kind: "replace"; route: TasksRoute } {
  const hint = hasFromDialogHint(state);
  if (action === "collapse") return hint && depth > 0 ? { kind: "history", delta: -1 } : { kind: "replace", route: tasksRoute(route.boardId, route.cardId, false, route.query) };
  return hint && depth >= 2 ? { kind: "history", delta: -2 } : { kind: "replace", route: tasksRoute(route.boardId, null, false, route.query) };
}

/**
 * The URL of each history entry one Tasks visit (one mount, in one document) wrote or landed on,
 * by `mynotes.depth`. An entry it never saw may be another app's page or an entry of an earlier
 * document (before a reload or a full navigation), where history.back() would leave Tasks, or
 * reload, and drop its state (the Undo toast). A write drops what it knew above the new entry,
 * since a push discards the forward entries.
 */
export type TasksEntryLog = { note: (depth: number, url: string, wrote: boolean) => void; urlAt: (depth: number) => string | undefined };

export function createTasksEntryLog(): TasksEntryLog {
  const urls = new Map<number, string>();
  return {
    note(depth, url, wrote) {
      if (wrote) for (const known of [...urls.keys()]) if (known > depth) urls.delete(known);
      urls.set(depth, url);
    },
    urlAt: (depth) => urls.get(depth)
  };
}

/**
 * Closing the card dialog (or binning the card): step back when the entry below is one this visit
 * saw (the board or the list the card was opened from), for Back parity; otherwise replace the
 * entry with the card's board, which never leaves Tasks and keeps its Undo toast.
 */
export function cardCloseAction(route: TasksRoute, depth: number, log: Pick<TasksEntryLog, "urlAt">): { kind: "history" } | { kind: "replace"; route: TasksRoute } {
  return depth > 0 && log.urlAt(depth - 1) !== undefined ? { kind: "history" } : { kind: "replace", route: tasksRoute(route.boardId, null, false, route.query) };
}

/**
 * After a view's Save the URL drops its unsaved query. When the entry just below already shows
 * that URL (the view as it was opened, before a filter edit pushed an entry), replacing would leave
 * two identical entries and a Back that changes nothing: step back onto it instead (review L6a).
 */
export function savedViewStep(depth: number, savedUrl: string, log: Pick<TasksEntryLog, "urlAt">): "back" | "replace" {
  return depth > 0 && log.urlAt(depth - 1) === savedUrl ? "back" : "replace";
}
