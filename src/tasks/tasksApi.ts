import { api, ApiError, getCsrfToken } from "../api";
import { uploadErrorMessage } from "../files/filesApi";
import { TASK_FLAGS, type TaskFlag } from "../../shared/taskQuery";
import type { BoardStructure, BoardTemplateId } from "../../shared/boardStructure";
import type { ReactionAggregate, ReactionKey } from "../../shared/reactions";
import type { ItemLevel } from "../access/accessLevels";

export type BoardVisibility = "private" | "selected" | "all_users";

/** docs/plan/API_CONTRACTS.md § Tasks. */
export type BoardSummary = {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  visibility: BoardVisibility;
  /** The `all_users` audience level (Wave 32, D272); older servers omit it (edit). */
  share_role?: "view" | "comment" | "edit";
  /** The caller's level on the board (Wave 32, §D.3); older servers omit it (every member edits, D38). */
  level?: ItemLevel;
  card_count: number;
  /** Level names, work level, and sprints (migration 019); older servers omit it (Flat). */
  structure?: BoardStructure;
  created_at: string;
  updated_at: string;
};

/**
 * `is_done` (migration 011): cards in done columns are left out of Today and the due chip.
 * `wip_limit` (migration 015, D108): at most this many cards, or null for no limit; only the owner sets it.
 */
export type BoardColumn = { id: string; board_id: string; name: string; position: number; is_done: 0 | 1; wip_limit?: number | null; created_at: string; updated_at: string };

/** An assignee (D102). `can_read` 0: they lost access to the board ("Former member"); they can only be removed. */
export type CardAssignee = { id: string; display_name: string; can_read: 0 | 1; /** Wave 35 (D299): the same-origin picture, when the payload has it. */ avatar_url?: string | null };

/** The Collections option palette (D109); `gray` is the default. */
export const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type TagColor = typeof TAG_COLORS[number];
/** A board's tag (D109). `card_count`: live cards carrying it. */
export type BoardTag = { id: string; board_id: string; name: string; color: TagColor; card_count: number };
/** The fixed flag set, in display order (D110). */
export const CARD_FLAGS = TASK_FLAGS;
export type CardFlag = TaskFlag;

export type CardSummary = {
  id: string;
  board_id: string;
  column_id: string;
  position: number;
  title: string;
  has_description: 0 | 1;
  revision: number;
  created_by: string | null;
  creator_name: string | null;
  /** YYYY-MM-DD or null; the civil date in `due_tz` when the card has a time. */
  due_on: string | null;
  /** "HH:MM" in `due_tz`, or null (D100). */
  due_time?: string | null;
  due_tz?: string | null;
  /** The UTC instant when `due_time` is set. */
  due_at?: string | null;
  /** In assignment order, at most 20 (D102). The board payload sends ids; `getBoard` fills these in. */
  assignees?: CardAssignee[];
  /** Plain text of the description, at most 160 characters, '' without one (D111). */
  description_excerpt?: string;
  /** Tags of this board in tagging order, at most 10; resolve against the board's `tags` (D109). */
  tag_ids?: string[];
  /** In the fixed order of `CARD_FLAGS` (D110). */
  flags?: CardFlag[];
  comment_count: number;
  attachment_count: number;
  /** Relations this viewer sees (restricted rows count, hidden binned ones do not), and readable open `depends_on` cards (13D). */
  relation_count?: number;
  open_blockers?: number;
  /** The parent on the same board, one level up (migration 019, D121); older servers omit it. */
  parent_card_id?: string | null;
  /** 0 (top) to 2; names come from the board's structure. */
  level?: number;
  /** Live direct children, and those in a done column (D134). */
  child_count?: number;
  done_child_count?: number;
  /** The sprint (17B): stored on work-level cards, the parent's below them, null in the backlog. */
  sprint_id?: string | null;
  created_at: string;
  updated_at: string;
};

/** `tags` (Wave 13) are by name. */
/** `sprints` (17B): open sprints plus the latest completed ones; older servers omit it. */
export type BoardDetail = { board: BoardSummary; columns: BoardColumn[]; cards: CardSummary[]; tags?: BoardTag[]; sprints?: SprintSummary[] };

/** A sprint (17B, D124). Counts are live work-level cards planned in it, and those in a done column. */
export type SprintSummary = {
  id: string; board_id: string; name: string; goal: string; start_on: string | null; end_on: string | null;
  state: "planned" | "active" | "completed"; is_active: boolean; position: number; completed_at: string | null;
  card_count: number; done_count: number; created_at: string; updated_at: string;
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const listBoards = () => api<{ boards: BoardSummary[] }>("/tasks/boards");
/** `tz` (the browser's zone) dates a template's first sprint from the viewer's today, not UTC's. */
export const createBoard = (name: string, template?: BoardTemplateId, tz?: string) =>
  api<{ board: BoardSummary; columns: BoardColumn[] }>("/tasks/boards", json("POST", { name, ...(template ? { template } : {}), ...(tz ? { tz } : {}) }));
/** Owner only (D122): 409 `LEVEL_IN_USE` or `SPRINTS_IN_USE` when the change would hide cards. */
export const updateBoardStructure = (boardId: string, structure: BoardStructure) =>
  api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", { structure }));
/**
 * The board payload on the wire (D113 trim, v0.9.0): cards carry `assignee_ids` and no `board_id`,
 * and one board-level `users` map names every assignee once.
 */
export type BoardPayloadCard = Omit<CardSummary, "board_id" | "assignees"> & { assignee_ids: string[] };
export type BoardPayload = Omit<BoardDetail, "cards"> & { cards: BoardPayloadCard[]; users: Record<string, { display_name: string; can_read: 0 | 1; avatar_url?: string | null }> };

/** Rebuilds the in-memory card shape (`board_id`, `assignees[]`) from the trimmed payload. */
export function hydrateBoard(payload: BoardPayload): BoardDetail {
  const { users, cards, ...rest } = payload;
  return {
    ...rest,
    cards: cards.map(({ assignee_ids, ...card }) => ({
      ...card,
      board_id: payload.board.id,
      assignees: assignee_ids.map((id) => ({ id, display_name: users[id]?.display_name ?? "Former member", can_read: users[id]?.can_read ?? 0, ...(users[id]?.avatar_url ? { avatar_url: users[id]!.avatar_url } : {}) }))
    }))
  };
}

export const getBoard = (boardId: string) => api<BoardPayload>(`/tasks/boards/${boardId}`).then(hydrateBoard);
export const renameBoard = (boardId: string, name: string) => api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", { name }));
export type BoardReader = { id: string; displayName: string };
/**
 * Everyone who can open the board, for the assignee picker: up to 200 without `q`, or a
 * case-insensitive name match (1–64 characters) of at most `limit` (default 20). Display names only.
 */
export function getBoardReaders(boardId: string, options: { q?: string; limit?: number; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q.slice(0, 64));
  if (options.q && options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return api<{ users: BoardReader[]; truncated?: boolean }>(`/tasks/boards/${boardId}/readers${query ? `?${query}` : ""}`, options.signal ? { signal: options.signal } : {});
}

export const createColumn = (boardId: string, name: string, afterColumnId?: string | null) =>
  api<{ column: BoardColumn; columns: BoardColumn[] }>(`/tasks/boards/${boardId}/columns`, json("POST", afterColumnId === undefined ? { name } : { name, afterColumnId }));
export const updateColumn = (columnId: string, change: { name?: string; afterColumnId?: string | null; isDone?: boolean; wipLimit?: number | null }) =>
  api<{ column: BoardColumn; columns: BoardColumn[] }>(`/tasks/columns/${columnId}`, json("PATCH", change));
export const deleteColumn = (columnId: string) => api<{ ok: true; columns: BoardColumn[] }>(`/tasks/columns/${columnId}`, json("DELETE", {}));

/**
 * One call creates the whole card (the composer, §4.3): fields, relations seen from the new card,
 * and the caller's own unlinked attachment uploads, in one transaction. Any refusal writes nothing.
 */
export type CardCreate = {
  columnId: string;
  title: string;
  description?: string;
  dueOn?: string | null;
  dueTime?: string | null;
  dueTz?: string | null;
  assigneeIds?: string[];
  tagIds?: string[];
  flags?: string[];
  relations?: Array<{ targetCardId: string; type: RelationType }>;
  attachmentIds?: string[];
  /** A card one level up on this board (D121); the level then defaults to the parent's plus one. */
  parentId?: string | null;
  level?: number;
  /** A planned or active sprint of this board (17B); work-level cards only. */
  sprintId?: string | null;
};
export const createCard = (boardId: string, body: CardCreate) =>
  api<{ card: CardDetail; renormalized?: boolean }>(`/tasks/boards/${boardId}/cards`, json("POST", body));
export const moveCard = (cardId: string, columnId: string, afterCardId: string | null) =>
  api<{ card: CardSummary; renormalized?: boolean; positions?: Array<{ id: string; position: number }> }>(`/tasks/cards/${cardId}/move`, json("POST", { columnId, afterCardId }));

export const taskErrorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { code?: unknown }).code
  : undefined;
export const taskErrorMessage = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

/** A child as `GET /cards/:k` lists it (live, by column position then card position, at most 100). */
export type ChildCard = { id: string; title: string; level: number; column_id: string; column_name: string; is_done: 0 | 1; position: number; due_on: string | null; child_count: number; done_child_count: number };
export type CardDetail = CardSummary & {
  description: string;
  /** `GET /cards/:k` only (17A): the parent, the breadcrumb (root first), and the children, all on this board. */
  parent?: { id: string; title: string; level: number } | null;
  ancestors?: Array<{ id: string; title: string; level: number }>;
  children?: ChildCard[];
};
export type CardComment = {
  id: string;
  card_id: string;
  author_id: string | null;
  author_name: string | null;
  is_author: 0 | 1;
  body: string;
  created_at: string;
  edited_at: string | null;
  /** Aggregated reactions as this viewer sees them (Wave 20, D186). */
  reactions?: ReactionAggregate[];
};
export type CardView = { card: CardDetail; comments: CardComment[]; hasMoreComments: boolean; attachments: CardAttachment[]; relations?: CardRelation[] };

/** A relation as seen from the card in the path (D104, API_CONTRACTS.md § Relations). */
export type RelationType = "relates_to" | "depends_on" | "needed_by" | "duplicates" | "duplicated_by";
export type RelatedCard = { id: string; board_id: string; board_name: string; title: string; column_name: string | null; is_done: 0 | 1; due_on: string | null };
/** A card the viewer cannot read shows only as restricted: no id, title, or board (D105, T90). */
export type CardRelation =
  | { id: string; type: RelationType; restricted: false; created_at: string; creator_name: string | null; card: RelatedCard }
  | { id: string; type: RelationType; restricted: true; created_at: string };
export type CardSearchResult = { id: string; board_id: string; board_name: string; title: string; column_name: string | null; is_done: 0 | 1 };

export const getCard = (cardId: string) => api<CardView>(`/tasks/cards/${cardId}`);
/**
 * A card edit. `dueTime` comes with `dueTz` (the setter's browser zone, D101); `dueTime: null` clears
 * the time, and `dueOn: null` clears both. `assigneeIds` replaces the whole set (`[]` clears it).
 */
export type CardChange = {
  title?: string; description?: string; dueOn?: string | null; dueTime?: string | null; dueTz?: string; assigneeIds?: string[]; tagIds?: string[]; flags?: CardFlag[];
  /** Reparent (D128): a card one level up on this board, or null to detach. */
  parentId?: string | null;
  /** Change level (D128): refused with 409 `HAS_CHILDREN` while the card has live children. */
  level?: number;
  /** Plan the card in a sprint, or null for the backlog (17B); work-level cards only. */
  sprintId?: string | null;
};
export const updateCard = (cardId: string, change: CardChange & { revision: number }) =>
  api<{ card: CardDetail }>(`/tasks/cards/${cardId}`, json("PATCH", change));
/** Any reader creates a tag; 409 `TAG_EXISTS` carries the existing one (D109). */
export const createTag = (boardId: string, name: string, color?: TagColor) =>
  api<{ tag: BoardTag }>(`/tasks/boards/${boardId}/tags`, json("POST", color ? { name, color } : { name }));
/** Owner only: rename or recolour. */
export const updateTag = (tagId: string, change: { name?: string; color?: TagColor }) => api<{ tag: BoardTag }>(`/tasks/tags/${tagId}`, json("PATCH", change));
/** Owner only: deletes the tag and unlinks it from every card, with no Bin. */
export const deleteTag = (tagId: string) => api<{ ok: true; removedFrom: number }>(`/tasks/tags/${tagId}`, json("DELETE", {}));
export const listComments = (cardId: string, before: string) =>
  api<{ comments: CardComment[]; hasMore: boolean }>(`/tasks/cards/${cardId}/comments?before=${encodeURIComponent(before)}`);
export const createComment = (cardId: string, body: string) => api<{ comment: CardComment }>(`/tasks/cards/${cardId}/comments`, json("POST", { body }));
export const updateComment = (commentId: string, body: string) => api<{ comment: CardComment }>(`/tasks/comments/${commentId}`, json("PATCH", { body }));
/** Idempotent set-state (D184): `on` sends PUT, off sends DELETE. The body is empty, so the JSON type is set explicitly. */
export const setCommentReaction = (commentId: string, emoji: ReactionKey, on: boolean) =>
  api<{ reactions: ReactionAggregate[] }>(`/tasks/comments/${commentId}/reactions/${emoji}`, { method: on ? "PUT" : "DELETE", headers: { "Content-Type": "application/json" } });
export const deleteComment = (commentId: string) => api<{ ok: true }>(`/tasks/comments/${commentId}`, json("DELETE", {}));

export type CardAttachment = {
  document_id: string;
  card_id: string;
  comment_id: string | null;
  linked_by: string | null;
  linker_name: string | null;
  name: string;
  mime_type: string;
  preview_kind: string;
  size_bytes: number;
  created_at: string;
};

export type UploadedAttachment = { id: string; name: string; mime_type: string; preview_kind: string; size_bytes: number };

/** Uploads a file as a task attachment (no folder, never in Files). It is readable to the board only once linked. */
export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const body = new FormData();
  body.append("file", file, file.name || "attachment");
  const headers = new Headers({ "Idempotency-Key": crypto.randomUUID() });
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch("/api/files?purpose=task_attachment", { method: "POST", body, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({})) as { document?: UploadedAttachment };
  if (!response.ok || !payload.document) throw new Error(uploadErrorMessage(response.status, payload));
  return payload.document;
}

export const linkAttachment = (cardId: string, documentId: string, commentId?: string) =>
  api<{ attachment: CardAttachment }>(`/tasks/cards/${cardId}/attachments`, json("POST", commentId ? { documentId, commentId } : { documentId }));
export const unlinkAttachment = (cardId: string, documentId: string) =>
  api<{ ok: true; movedToBin: boolean }>(`/tasks/cards/${cardId}/attachments/${documentId}`, json("DELETE", {}));
export const createCommentWithFiles = (cardId: string, body: string, attachmentIds: string[]) =>
  api<{ comment: CardComment }>(`/tasks/cards/${cardId}/comments`, json("POST", attachmentIds.length ? { body, attachmentIds } : { body }));

/** Titles of live cards on boards the caller can read (D106): `boardId` sorts first, `excludeCardId` drops the card itself. */
export function searchCards(q: string, options: { boardId?: string; excludeCardId?: string; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ q: q.trim().slice(0, 100) });
  if (options.boardId) params.set("boardId", options.boardId);
  if (options.excludeCardId) params.set("excludeCardId", options.excludeCardId);
  return api<{ results: CardSearchResult[]; truncated: boolean }>(`/tasks/cards/search?${params.toString()}`, options.signal ? { signal: options.signal } : {});
}
export const createRelation = (cardId: string, type: RelationType, targetCardId: string) =>
  api<{ relation: CardRelation }>(`/tasks/cards/${cardId}/relations`, json("POST", { type, cardId: targetCardId }));
export const deleteRelation = (cardId: string, relationId: string) =>
  api<{ ok: true }>(`/tasks/cards/${cardId}/relations/${relationId}`, json("DELETE", {}));

/** Its live descendants go to the Bin with it (D129); `descendantCount` says how many. */
export const deleteCard = (cardId: string) => api<{ ok: true; purgeAfter: string; descendantCount?: number }>(`/tasks/cards/${cardId}`, json("DELETE", {}));
export const deleteBoard = (boardId: string) => api<{ ok: true; purgeAfter: string }>(`/tasks/boards/${boardId}`, json("DELETE", {}));
/** `place` (cards only) asks for the old column and neighbour; the server falls back to the bottom. */
export const restoreTaskItem = (type: "card" | "board", id: string, place: { columnId?: string; afterCardId?: string | null } = {}) =>
  api<{ ok: true; alreadyRestored?: true; boardId: string; boardName: string; columnId: string | null; columnName: string | null; descendantCount?: number; detached?: true }>(`/bin/${type}/${id}/restore`, json("POST", place));

// Sprints (17B, API_CONTRACTS.md § Sprints). Everyone who can open the board lists them; only the owner changes them.
export type SprintFields = { name?: string; goal?: string; startOn?: string | null; endOn?: string | null };
export const listSprints = (boardId: string, options: { state?: SprintSummary["state"]; cursor?: string } = {}) => {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.toString();
  return api<{ sprints: SprintSummary[]; nextCursor: string | null }>(`/tasks/boards/${boardId}/sprints${query ? `?${query}` : ""}`);
};
export const createSprint = (boardId: string, fields: SprintFields & { name: string }) =>
  api<{ sprint: SprintSummary }>(`/tasks/boards/${boardId}/sprints`, json("POST", fields));
/** `state: "active"` starts a planned sprint (409 `SPRINT_ACTIVE` while another is active). */
export const updateSprint = (sprintId: string, change: SprintFields & { afterSprintId?: string | null; state?: "active" }) =>
  api<{ sprint: SprintSummary }>(`/tasks/sprints/${sprintId}`, json("PATCH", change));
export const deleteSprint = (sprintId: string) => api<{ ok: true }>(`/tasks/sprints/${sprintId}`, json("DELETE", {}));
/** Where the unfinished cards go when a sprint completes: the next planned sprint, the backlog, a new sprint, or a planned sprint's id. */
export type SprintCarryTo = "next" | "backlog" | "new" | string;
export const completeSprint = (sprintId: string, carryTo: SprintCarryTo, next: SprintFields = {}) =>
  api<{ sprint: SprintSummary; carried: number; doneCount: number; target: SprintSummary | null; created: boolean }>(`/tasks/sprints/${sprintId}/complete`, json("POST", { carryTo, ...next }));
