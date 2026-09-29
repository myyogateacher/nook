import { api } from "../../api";
import type { TaskState } from "../../../shared/taskQuery";
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
  assignees: CardAssignee[];
  tags: Array<{ id: string; name: string; color: TagColor | string }>;
  flags: string[];
  created_at: string;
  updated_at: string;
};

/** What the query's ids mean to this viewer (T116): a board, column, or tag they cannot read is `restricted`, with no name. */
export type QueryRefs = {
  boards: Array<{ id: string; name: string } | { id: string; restricted: true }>;
  columns: Array<{ id: string; name: string; board_id: string } | { id: string; restricted: true }>;
  tags: Array<{ id: string; name: string; color: string; board_id: string } | { id: string; restricted: true }>;
  users: Array<{ id: string; display_name: string } | { id: string; unknown: true }>;
};

export type QueryPage = { query: string; cards: QueriedCard[]; nextCursor: string | null; total?: number; refs?: QueryRefs };

export type QueryRequest = { q: string; sort: HomeSort; group: "none" | "board" | "state" | "due"; cursor?: string; limit?: number; tz: string };

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** `POST /api/tasks/query`: a read sent as POST (30 per 10 s per user). */
export const queryTaskCards = (body: QueryRequest, signal?: AbortSignal) =>
  api<QueryPage>("/tasks/query", { ...json("POST", body), ...(signal ? { signal } : {}) });

export type ViewDisplay = { layout: HomeLayout; group: HomeGroup; sort: HomeSort };

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
export function viewCards(viewId: string, options: { cursor?: string; limit?: number; tz: string }, signal?: AbortSignal) {
  const params = new URLSearchParams({ tz: options.tz });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  return api<QueryPage & { view: TaskView }>(`/tasks/views/${viewId}/cards?${params.toString()}`, signal ? { signal } : {});
}

/** A column with its state (migration 020); older payloads derive it from `is_done`. */
export type StatefulColumn = BoardColumn & { state?: TaskState };
export const columnState = (column: StatefulColumn): TaskState => column.state ?? (column.is_done === 1 ? "done" : "doing");

/** Owner only: the column's state, with `is_done` kept equal to `state = "done"` by the server (T121). */
export const updateColumnState = (columnId: string, state: TaskState) =>
  api<{ column: StatefulColumn; columns: StatefulColumn[] }>(`/tasks/columns/${columnId}`, json("PATCH", { state }));
