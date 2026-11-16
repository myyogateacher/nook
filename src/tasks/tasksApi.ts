import { nameBoard, nameCard } from "../routeNames";
import { api, ApiError } from "../api";
import { uploadForHost } from "../ui/attachments";
import { TASK_FLAGS, type TaskFlag, type TaskPriority } from "../../shared/taskQuery";
import type { BoardStructure, BoardTemplateId } from "../../shared/boardStructure";
import type { ReactionAggregate, ReactionKey } from "../../shared/reactions";
import { cardKey } from "../../shared/boardKeys";
import type { ItemLevel } from "../access/accessLevels";
import type { EstimateKind, EstimateScale } from "../../shared/estimates";

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
  /** Live cards auto-archived (D605), part of `card_count`; older servers omit it. */
  archived_count?: number;
  /** Cards in a done column this many days are archived (D604); null when off; older servers omit it. */
  auto_archive_days?: number | null;
  /** Level names, work level, and sprints (migration 019); older servers omit it (Flat). */
  structure?: BoardStructure;
  /** The board's short code (lane KEYS, D710): cards' keys are `<code>-<number>`; older servers omit it. */
  code?: string | null;
  /** Lane ESTIMATES (D750, D751): what card estimates mean here, and the points scale; older servers omit them (off). */
  estimate_kind?: EstimateKind;
  estimate_scale?: EstimateScale;
  created_at: string;
  updated_at: string;
};

/**
 * `is_done` (migration 011): cards in done columns are left out of Today and the due chip.
 * `wip_limit` (migration 015, D108): at most this many cards, or null for no limit; only the owner sets it.
 */
export type BoardColumn = { id: string; board_id: string; name: string; position: number; is_done: 0 | 1; wip_limit?: number | null; created_at: string; updated_at: string };

/** An assignee (D102). `can_read` 0: they lost access to the board ("Former member"); they can only be removed. */
export type CardAssignee = { id: string; display_name: string; can_read: 0 | 1; /** Wave 35 (D299): the same-origin picture, when the payload has it. */ avatar_url?: string | null; /** Wave 36 (D287): an integration. */ is_integration?: boolean };

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
  /** Wave 36 (D287): 1 when an integration created the card through its key. */
  creator_is_integration?: 0 | 1;
  /** YYYY-MM-DD or null; the civil date in `due_tz` when the card has a time. */
  due_on: string | null;
  /** "HH:MM" in `due_tz`, or null (D100). */
  due_time?: string | null;
  due_tz?: string | null;
  /** The UTC instant when `due_time` is set. */
  due_at?: string | null;
  /** The optional start (D720), shaped like the due fields; older servers omit it. */
  start_on?: string | null;
  start_time?: string | null;
  start_tz?: string | null;
  start_at?: string | null;
  /** In assignment order, at most 20 (D102). The board payload sends ids; `getBoard` fills these in. */
  assignees?: CardAssignee[];
  /** Plain text of the description, at most 160 characters, '' without one (D111). */
  description_excerpt?: string;
  /** Tags of this board in tagging order, at most 10; resolve against the board's `tags` (D109). */
  tag_ids?: string[];
  /** In the fixed order of `CARD_FLAGS` (D110). */
  flags?: CardFlag[];
  /** urgent, high, medium, low, or null without one (D1310); absent in an older payload. */
  priority?: TaskPriority | null;
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
  /** When the card came into a done column (D603), or null. */
  done_at?: string | null;
  /** When the auto-archive sweep archived it (D605), or null. The board lists archived cards only when the viewer shows them. */
  archived_at?: string | null;
  /** Its number on its board (D713); with the board's code it makes the key. Older servers omit it. */
  number?: number | null;
  /** The key, such as MYT-12 (D710): `GET /cards/:k` and query results send it; on a board, build it from `board.code`. */
  key?: string | null;
  /** Lane ESTIMATES (D750, D752): points or hours as the board says; null without one or while the board has estimates off. */
  estimate?: number | null;
  created_at: string;
  updated_at: string;
};

/** `tags` (Wave 13) are by name. */
/** `sprints` (17B): open sprints plus the latest completed ones; older servers omit it. */
/** `view` (D602, D606): the viewer's own collapsed columns and whether they show archived cards; older servers omit it. */
export type BoardView = {
  collapsedColumnIds: string[];
  showArchived: boolean;
  /** Lane VIEWS2 (D659): "Show all levels on the board", per person; null until chosen (older servers omit it). */
  showAllLevels?: boolean | null;
  /** Lane VIEWS2 (D656): the swimlanes this person collapsed. */
  collapsedRows?: string[];
};
/**
 * `archivedPage` (D634): sent when the viewer shows archived cards. The board carries at most 200 of
 * them, newest archived first; `next` fetches the following page (null when none are left).
 */
export type ArchivedPage = { next: string | null };
export type BoardDetail = { board: BoardSummary; columns: BoardColumn[]; cards: CardSummary[]; tags?: BoardTag[]; sprints?: SprintSummary[]; view?: BoardView; archivedPage?: ArchivedPage };

/** A sprint (17B, D124). Counts are live work-level cards planned in it, and those in a done column. */
export type SprintSummary = {
  id: string; board_id: string; name: string; goal: string; start_on: string | null; end_on: string | null;
  state: "planned" | "active" | "completed"; is_active: boolean; position: number; completed_at: string | null;
  card_count: number; done_count: number; created_at: string; updated_at: string;
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const listBoards = () => api<{ boards: BoardSummary[] }>("/tasks/boards").then((result) => {
  for (const board of result?.boards ?? []) nameBoard(board.id, board.code);
  return result;
});

/** Friendly URLs (D781): the router learns a board's code and its cards' keys whenever they load. */
export function nameBoardCards(boardId: string, code: string | null | undefined, cards: ReadonlyArray<{ id: string; number?: number | null }>) {
  nameBoard(boardId, code);
  if (!Array.isArray(cards)) return;
  for (const card of cards) if (card) nameCard(card.id, cardKey(code, card.number), boardId);
}
/**
 * `tz` (the browser's zone) dates a template's first sprint from the viewer's today, not UTC's.
 * `code` (D711): the board's short code; omitted, the server picks a free one from the name.
 */
export const createBoard = (name: string, template?: BoardTemplateId, tz?: string, code?: string) =>
  api<{ board: BoardSummary; columns: BoardColumn[] }>("/tasks/boards", json("POST", { name, ...(template ? { template } : {}), ...(tz ? { tz } : {}), ...(code ? { code } : {}) }));
/** A free code for a board name (D711). */
export const suggestBoardCode = (name: string, signal?: AbortSignal) =>
  api<{ code: string }>(`/tasks/board-codes/suggest?name=${encodeURIComponent(name.slice(0, 120))}`, signal ? { signal } : {});
/** Owner only (D712): 400 `CODE_INVALID`, 409 `CODE_TAKEN` (with a free `suggestion`). Old keys keep working (D714). */
export const setBoardCode = (boardId: string, code: string) => api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", { code }));
/** A card key (MYT-12; an old one too) to the card, when the caller can read it (D713); 404 otherwise. */
export const lookupCardKey = (key: string) =>
  api<{ cardId: string; boardId: string; key: string | null; moved: boolean }>(`/tasks/keys/${encodeURIComponent(key)}`);
/**
 * Moves a card to another board (D716): Can edit on both; the bottom of `columnId`, or of the board's
 * first column that is not done. Tags without a namesake there are dropped (`droppedTags`).
 */
export const moveCardToBoard = (cardId: string, boardId: string, columnId?: string | null) =>
  api<{ card: CardDetail; fromBoardId: string; previousKey: string | null; droppedTags: string[]; parentDetached?: true }>(`/tasks/cards/${cardId}/move-board`, json("POST", { boardId, ...(columnId ? { columnId } : {}) }));
/** Owner only (D122): 409 `LEVEL_IN_USE` or `SPRINTS_IN_USE` when the change would hide cards. */
export const updateBoardStructure = (boardId: string, structure: BoardStructure) =>
  api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", { structure }));
/**
 * The board payload on the wire (D113 trim, v0.9.0): cards carry `assignee_ids` and no `board_id`,
 * and one board-level `users` map names every assignee once.
 */
export type BoardPayloadCard = Omit<CardSummary, "board_id" | "assignees"> & { assignee_ids: string[] };
export type BoardPayload = Omit<BoardDetail, "cards"> & { cards: BoardPayloadCard[]; users: Record<string, { display_name: string; can_read: 0 | 1; avatar_url?: string | null; is_integration?: boolean }> };

/**
 * Rebuilds the in-memory card shape (`board_id`, `assignees[]`) from the trimmed payload, and each
 * card's `key` from the board's code and its number (D710; the payload sends only the number).
 */
export function hydrateBoard(payload: BoardPayload): BoardDetail {
  const { users, cards, ...rest } = payload;
  nameBoardCards(payload.board.id, payload.board.code, cards);
  return {
    ...rest,
    cards: cards.map(({ assignee_ids, ...card }) => ({
      ...card,
      ...(cardKey(payload.board.code, card.number) ? { key: cardKey(payload.board.code, card.number) } : {}),
      board_id: payload.board.id,
      assignees: assignee_ids.map((id) => ({ id, display_name: users[id]?.display_name ?? "Former member", can_read: users[id]?.can_read ?? 0, avatar_url: users[id]?.avatar_url ?? null, ...(users[id]?.is_integration ? { is_integration: true } : {}) }))
    }))
  };
}

export const getBoard = (boardId: string) => api<BoardPayload>(`/tasks/boards/${boardId}`).then(hydrateBoard);
/** A board's columns in board order, without its cards (Move to another board, D716). */
export const getBoardColumns = (boardId: string) => api<{ columns: BoardColumn[] }>(`/tasks/boards/${boardId}/columns`).then((result) => result.columns);
/** The next page of archived cards (D634), hydrated like the board's. */
export async function getArchivedCards(boardId: string, before: string, code?: string | null) {
  const page = await api<Pick<BoardPayload, "cards" | "users"> & { archivedPage: ArchivedPage }>(`/tasks/boards/${boardId}/archived?before=${encodeURIComponent(before)}`);
  const { cards } = hydrateBoard({ board: { id: boardId, code } as BoardSummary, columns: [], cards: page.cards, users: page.users });
  return { cards, archivedPage: page.archivedPage };
}
export const renameBoard = (boardId: string, name: string) => api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", { name }));
/** Owner or manager (D604): 1–365 days, or null to turn auto-archive off. */
export const setAutoArchiveDays = (boardId: string, autoArchiveDays: number | null) => api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", { autoArchiveDays }));
/** Owner or manager (lane ESTIMATES, D750–D752): what card estimates mean on the board; stored values are kept. */
export const setBoardEstimates = (boardId: string, change: { estimateKind?: EstimateKind; estimateScale?: EstimateScale }) =>
  api<{ board: BoardSummary }>(`/tasks/boards/${boardId}`, json("PATCH", change));
/** Any reader (D602, D606): replaces the fields sent of the caller's own view of the board. */
export const saveBoardView = (boardId: string, change: Partial<BoardView>) => api<{ view: BoardView }>(`/tasks/boards/${boardId}/view`, json("PUT", change));
/** Archives a card by hand (D610), in any column: hidden from the board, never deleted. */
export const archiveCard = (cardId: string) => api<{ card: CardDetail }>(`/tasks/cards/${cardId}/archive`, json("POST", {}));
/** Puts an archived card back on the board (D605); its done clock starts again. */
export const unarchiveCard = (cardId: string) => api<{ card: CardDetail }>(`/tasks/cards/${cardId}/unarchive`, json("POST", {}));
export type BoardReader = { id: string; displayName: string; /** Q7: the same-origin picture (web payload). */ avatarUrl?: string | null; /** Wave 36: an integration (web payload). */ isIntegration?: boolean };
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
  /** D1310: urgent, high, medium, or low; left out for none. */
  priority?: TaskPriority | null;
  flags?: string[];
  relations?: Array<{ targetCardId: string; type: RelationType }>;
  attachmentIds?: string[];
  /** The person confirmed that the board's readers will open the Files items in attachmentIds (D396). */
  attachmentsConfirmed?: boolean;
  /** A card one level up on this board (D121); the level then defaults to the parent's plus one. */
  parentId?: string | null;
  level?: number;
  /** A planned or active sprint of this board (17B); work-level cards only. */
  sprintId?: string | null;
  /** Points or hours (D753); 400 `ESTIMATES_OFF` while the board has estimates off. */
  estimate?: number | null;
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
  /** Wave 35 (QA U4): the author's picture in web payloads; absent from MCP and older servers. */
  author_avatar_url?: string | null;
  /** Wave 36 (D287): 1 when an integration wrote it through its key. */
  author_is_integration?: 0 | 1;
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
/** `is_archived` (D607): an archived card is still found, marked; older servers omit it. */
export type CardSearchResult = { id: string; board_id: string; board_name: string; title: string; column_name: string | null; is_done: 0 | 1; is_archived?: 0 | 1; /** D710: MYT-12; older servers omit it. */ key?: string | null };

export const getCard = (cardId: string) => api<CardView>(`/tasks/cards/${cardId}`).then((view) => {
  if (view?.card?.key) nameCard(view.card.id, view.card.key, view.card.board_id);
  return view;
});
/**
 * A card edit. `dueTime` comes with `dueTz` (the setter's browser zone, D101); `dueTime: null` clears
 * the time, and `dueOn: null` clears both. `assigneeIds` replaces the whole set (`[]` clears it).
 */
export type CardChange = {
  title?: string; description?: string; dueOn?: string | null; dueTime?: string | null; dueTz?: string; assigneeIds?: string[]; tagIds?: string[]; flags?: CardFlag[];
  /** The priority (D1310), or null to clear it. */
  priority?: TaskPriority | null;
  /** The start (D720), as the due fields: `startTime` with `startTz`; on or before the due date (400 `START_AFTER_DUE`). */
  startOn?: string | null; startTime?: string | null; startTz?: string;
  /** Reparent (D128): a card one level up on this board, or null to detach. */
  parentId?: string | null;
  /** Change level (D128): refused with 409 `HAS_CHILDREN` while the card has live children. */
  level?: number;
  /** Plan the card in a sprint, or null for the backlog (17B); work-level cards only. */
  sprintId?: string | null;
  /** Points or hours, or null to clear (D753); 400 `ESTIMATE_INVALID` off the board's scale or range. */
  estimate?: number | null;
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
/**
 * The author's edit: new text, files to add (≤ 10 per comment, uploads everywhere U2), or both. A
 * blank body is kept only while the comment has files (the server stores the generated body, D397).
 */
export type CommentChange = { body?: string; attachmentIds?: string[]; confirmed?: boolean };
export const updateComment = (commentId: string, change: CommentChange) => api<{ comment: CardComment }>(`/tasks/comments/${commentId}`, json("PATCH", change));
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
  /** 1 when the file is in its owner's Bin: the name is blank and the card shows "File removed" (D409). Older servers omit it. */
  removed?: 0 | 1;
};

/**
 * A file staged to attach (the composer, a comment). `fromFiles` marks a pick from the person's own
 * Files (D396): it is never discarded with the draft, and it needs the confirm the picker asked for.
 */
export type UploadedAttachment = { id: string; name: string; mime_type: string; preview_kind: string; size_bytes: number; fromFiles?: boolean; confirmed?: boolean };

export type UploadOptions = { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal };

/**
 * Uploads a file to attach to a card (uploads everywhere U2, D390): the attach kit's upload, so it lands
 * in the uploader's Files › Attachments folder with JPEG location removed (Q9). It is readable to the
 * board only once linked; an upload never linked moves to the Bin after a day.
 */
export async function uploadAttachment(file: File, options: UploadOptions = {}): Promise<UploadedAttachment> {
  const { document } = await uploadForHost(file, "card", options);
  return { id: document.id, name: document.name, mime_type: document.mime_type, preview_kind: document.preview_kind, size_bytes: document.size_bytes };
}

/** `confirmed`: a Files item outside the Attachments folder, after the From Files confirm (409 CONFIRM_REQUIRED otherwise). */
export const linkAttachment = (cardId: string, documentId: string, options: { commentId?: string; confirmed?: boolean } = {}) =>
  api<{ attachment: CardAttachment }>(`/tasks/cards/${cardId}/attachments`, json("POST", { documentId, ...(options.commentId ? { commentId: options.commentId } : {}), ...(options.confirmed ? { confirmed: true } : {}) }));
export const unlinkAttachment = (cardId: string, documentId: string) =>
  api<{ ok: true; movedToBin: boolean }>(`/tasks/cards/${cardId}/attachments/${documentId}`, json("DELETE", {}));
/** A blank body with files posts a files-only comment (D397). */
export const createCommentWithFiles = (cardId: string, body: string, attachmentIds: string[], options: { confirmed?: boolean } = {}) =>
  api<{ comment: CardComment }>(`/tasks/cards/${cardId}/comments`, json("POST", attachmentIds.length ? { body, attachmentIds, ...(options.confirmed ? { confirmed: true } : {}) } : { body }));

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
