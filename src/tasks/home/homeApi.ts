import { api } from "../../api";
import { levelAtLeast, type ItemLevel } from "../../access/accessLevels";
import type { TaskState } from "../../../shared/taskQuery";
import type { LaneBoard, LaneMode, QueryLane } from "../../../shared/taskLanes";
import type { SwimlaneMode } from "../../../shared/swimlanes";
import type { BoardColumn, BoardVisibility, CardAssignee, TagColor } from "../tasksApi";
import type { HomeGroup, HomeLayout, HomeSort } from "./homeUrl";

// docs/plan/API_CONTRACTS.md § Cross-board card query, § Saved views, § Column state (17C).

export type QueriedCard = {
  id: string;
  board_id: string;
  board_name: string;
  column_id: string;
  column_name: string;
  column_state: TaskState;
  is_done: 0 | 1;
  /** The key, such as MYT-12 (lane KEYS, D710); older servers omit it. */
  key?: string | null;
  /** Archived (D605, D610): still listed, marked; older servers omit it. */
  archived_at?: string | null;
  position: number;
  title: string;
  description_excerpt: string;
  revision: number;
  created_by: string | null;
  creator_name: string | null;
  due_on: string | null;
  due_time: string | null;
  due_tz: string | null;
  due_at: string | null;
  /** The optional start (D720); older servers omit it. */
  start_on?: string | null;
  start_time?: string | null;
  start_tz?: string | null;
  start_at?: string | null;
  assignees: CardAssignee[];
  tags: Array<{ id: string; name: string; color: TagColor | string }>;
  flags: string[];
  /** urgent, high, medium, low, or null (D1310); absent from an older server. */
  priority?: string | null;
  created_at: string;
  updated_at: string;
  /** The caller's level on the card's board (Wave 32): below edit the card offers no Move. Older servers omit it. */
  board_level?: ItemLevel;
  /** Hierarchy and sprints (17A, 17B): the level, the parent, and the card's sprint (inherited below the work level). */
  level?: number;
  parent_card_id?: string | null;
  sprint_id?: string | null;
  sprint_name?: string | null;
};

/**
 * Whether the results may offer "Move to…" on this card: a writing Team role and at least Can edit on
 * its board, as the server returns it (commenters and viewers get READ_ONLY on a move).
 */
export const canChangeCard = (card: Pick<QueriedCard, "board_level">, roleReadOnly: boolean) => !roleReadOnly && levelAtLeast(card.board_level, "edit");

/** What the query's ids mean to this viewer (T116): a board, column, or tag they cannot read is `restricted`, with no name. */
export type QueryRefs = {
  boards: Array<{ id: string; name: string } | { id: string; restricted: true }>;
  columns: Array<{ id: string; name: string; board_id: string } | { id: string; restricted: true }>;
  tags: Array<{ id: string; name: string; color: string; board_id: string } | { id: string; restricted: true }>;
  users: Array<{ id: string; display_name: string } | { id: string; unknown: true }>;
};

/**
 * Lane VIEWS (D643): with `lanes`, the first page also carries the lanes of the whole match, each with
 * its board columns (WIP limit, live card count), and the true count per lane.
 */
export type QueryLanes = { lanes: LaneMode; lanesFallback?: true; columns: QueryLane[]; laneCounts: Record<string, number>; /** Lane VIEWS2 (D651, D654); older servers omit it. */ laneBoards?: LaneBoard[] };

export type QueryPage = { query: string; cards: QueriedCard[]; nextCursor: string | null; total?: number; refs?: QueryRefs } & Partial<QueryLanes>;

export type QueryRequest = { q: string; sort: HomeSort; group: "none" | "board" | "state" | "due"; cursor?: string; limit?: number; tz: string; lanes?: LaneMode };

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** `POST /api/tasks/query`: a read sent as POST (30 per 10 s per user). */
export const queryTaskCards = (body: QueryRequest, signal?: AbortSignal) =>
  api<QueryPage>("/tasks/query", { ...json("POST", body), ...(signal ? { signal } : {}) });

/** `timeline` is a board layout (D760): the cross-board view page shows such a view as the list. */
export type ViewDisplay = { layout: HomeLayout | "timeline"; group: HomeGroup; sort: HomeSort; lanes?: LaneMode; /** A board view's swimlanes (D655); null clears them. */ swimlanes?: SwimlaneMode | null };

export type TaskView = {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  visibility: BoardVisibility;
  query: string;
  display: ViewDisplay;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
  /** The one board the view is on, when the viewer can read it (D635): the app opens it as that board. Older servers omit it. */
  board_id?: string | null;
};

export type ViewLists = { mine: TaskView[]; shared: TaskView[]; everyone: TaskView[]; truncated: boolean };

export const listViews = () => api<ViewLists>("/tasks/views");
export const getView = (viewId: string) => api<{ view: TaskView }>(`/tasks/views/${viewId}`);
export const createView = (body: { name: string; query: string; display: ViewDisplay }) => api<{ view: TaskView }>("/tasks/views", json("POST", body));
export const updateView = (viewId: string, change: { name?: string; query?: string; display?: ViewDisplay; revision: number }) =>
  api<{ view: TaskView }>(`/tasks/views/${viewId}`, json("PATCH", change));
export const deleteView = (viewId: string) => api<{ ok: true }>(`/tasks/views/${viewId}`, json("DELETE", {}));
export const duplicateView = (viewId: string) => api<{ view: TaskView }>(`/tasks/views/${viewId}/duplicate`, json("POST", {}));
export const saveViewSharing = (viewId: string, visibility: BoardVisibility, userIds: string[]) =>
  api<{ ok: true }>(`/tasks/views/${viewId}/sharing`, json("PUT", { visibility, userIds: visibility === "selected" ? userIds : [] }));

/** `GET /api/tasks/views/:v/cards`: the stored query run as the viewer, with the view's sort and server group. */
export function viewCards(viewId: string, options: { cursor?: string; limit?: number; tz: string; lanes?: LaneMode }, signal?: AbortSignal) {
  const params = new URLSearchParams({ tz: options.tz });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.lanes) params.set("lanes", options.lanes);
  return api<QueryPage & { view: TaskView }>(`/tasks/views/${viewId}/cards?${params.toString()}`, signal ? { signal } : {});
}

/** A column with its state (migration 020); older payloads derive it from `is_done`. */
export type StatefulColumn = BoardColumn & { state?: TaskState };
export const columnState = (column: StatefulColumn): TaskState => column.state ?? (column.is_done === 1 ? "done" : "doing");

/** Owner only: the column's state, with `is_done` kept equal to `state = "done"` by the server (T121). */
export const updateColumnState = (columnId: string, state: TaskState) =>
  api<{ column: StatefulColumn; columns: StatefulColumn[] }>(`/tasks/columns/${columnId}`, json("PATCH", { state }));

/**
 * One person's prefs for a saved view, or `my` for My work (D644): collapsed lanes, and for a board
 * view (lane VIEWS2, D657) whether it keeps its own collapsed columns and rows, and those.
 */
export type ViewPrefs = { collapsedLanes: string[]; ownCollapse?: boolean; collapsedColumnIds?: string[]; collapsedRows?: string[] };
export const getViewLanePrefs = (viewKey: string) => api<ViewPrefs>(`/tasks/views/${viewKey}/prefs`);
/** `q`: My work's filter, so lanes that are gone are trimmed (D653). */
export const saveViewLanePrefs = (viewKey: string, collapsedLanes: string[], q?: string) =>
  api<ViewPrefs>(`/tasks/views/${viewKey}/prefs`, json("PUT", { collapsedLanes, ...(q !== undefined ? { q } : {}) }));
export const saveViewPrefs = (viewKey: string, change: Omit<Partial<ViewPrefs>, "collapsedLanes">) => api<ViewPrefs>(`/tasks/views/${viewKey}/prefs`, json("PUT", change));

/** The views on a board (D658): the pinned ones (for everyone who can open it) first, then the viewer's own. */
export type BoardViews = { pinned: TaskView[]; views: TaskView[]; canPin: boolean };
export const listBoardViews = (boardId: string) => api<BoardViews>(`/tasks/boards/${boardId}/views`);
export const pinBoardView = (boardId: string, viewId: string) => api<BoardViews>(`/tasks/boards/${boardId}/pins/${viewId}`, json("PUT", {}));
export const unpinBoardView = (boardId: string, viewId: string) => api<BoardViews>(`/tasks/boards/${boardId}/pins/${viewId}`, json("DELETE", {}));
/** Lane VIEWS2 (D667): reorder pinned views; `null` puts the view first. */
export const movePinnedView = (boardId: string, viewId: string, afterViewId: string | null) => api<BoardViews>(`/tasks/boards/${boardId}/pins/${viewId}`, json("PATCH", { afterViewId }));
