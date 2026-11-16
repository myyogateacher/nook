import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { NO_FILTER, type SqlFilter } from "../keyResources";
import { withResourceLock } from "../storage";
import { boardLevel, boardLevels, readableBoard, readableBoardPredicate, readableCard, readableColumn, type BoardRow, type BoardVisibility, type ColumnRow, type ColumnState } from "./access";
import { atLeast, type ItemLevel } from "../access/levels";
import { assigneesForBoard, assigneesForCard, MAX_ASSIGNEES, newAssignees, replaceAssignees, type CardAssignee } from "./assignees";
import { planInsert, type Positioned } from "./boardOrder";
import { dueAt, resolveDue, resolveStart, startAfterDue, startAt, type DueFields, type DueInput, type StartFields, type StartInput } from "./dueTime";
import { linkableCardDocument, linkAttachments, needsLinkConfirm } from "./attachments";
import { insertRelation } from "./cardRelations";
import { descriptionExcerpt } from "./excerpt";
import type { RelationType } from "./relations";
import { boardStructure, liveChildCount, parentRow, rollupFor, rollupsForBoard, type Rollup } from "./hierarchy";
import { aLevel, HIERARCHY_LIMITS, levelInUseMessage, parentRequired, parentRequiredMessage, parseStructure, TEMPLATES, type BoardStructure, type BoardTemplateId } from "../../shared/boardStructure";
import { boardSprints, EFFECTIVE_SPRINT_SQL, sprintOfBoard } from "./sprintData";
import { SPRINT_DEFAULT_DAYS, sprintEndFor } from "../../shared/sprintPlan";
import { flagsForBoard, flagsForCard, listBoardTags, replaceCardFlags, replaceCardTags, requireCardTags, tagIdsForBoard, tagIdsForCard, type CardFlag } from "./tags";
import { audienceAllUsersFor } from "../team/roles";
import { dateInZone, validTimeZone } from "../today/registry";
import { mailShared, shareMembers } from "../mail/triggers";
import { GUEST_SHARE_DISABLED, legacyGuestShareBlocked, legacyShareLevels, writeDirectShares } from "../access/shares";
import { groupGrantExists } from "../access/groups";
import { foldText, LEGACY_URGENT_FLAG, type TaskPriority } from "../../shared/taskQuery";
import { boardCodeMessage, normalizeBoardCode } from "../../shared/boardKeys";
import { boardCodeTaken, freeBoardCode, keyOfCard, writeBoardCode } from "./keys";
import { visibleEstimateSql } from "./estimateSql";
import { activityValue, cardActivitySnapshot, recordCardActivity, recordCardChange, recordCardItems, recordCardMentions, recordSnapshotChanges } from "./activity";
import { checkEstimate, estimateSettingsOf, type EstimateKind, type EstimateScale, type EstimateSettings } from "../../shared/estimates";

/**
 * Task Boards services (WAVES_7-9.md §3). Routes are thin adapters over these
 * functions so Wave 8 MCP tools can reuse them. Every failure is a TaskError.
 *
 * Authorization (D38, D39, D272): readers of a board (owner, members, groups, everyone on an
 * all_users board) hold a level. `edit` works with cards (every member before Wave 32, D38),
 * `comment` only comments and reacts, `view` only reads (403 READ_ONLY). The owner and managers
 * (D273) rename the board and change its structure, columns, WIP limits, tags, and sprints (403
 * MANAGER_REQUIRED for everyone else); only the owner deletes it and changes its audience through
 * the older sharing route (403 OWNER_ONLY). Non-readers get 404.
 */
export class TaskError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly code?: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...this.extra };
  }
}

/**
 * `liveCardsPerBoard` counts live cards that are not archived (D632: archived cards leave the cap);
 * `cardsPerBoard` is the backstop on every live card, archived ones included (D633).
 */
export const LIMITS = { boardsPerOwner: 50, columnsPerBoard: 20, liveCardsPerBoard: 1000, cardsPerBoard: 10000, commentsPerCard: 500, attachmentsPerCard: 50, attachmentsPerComment: 10 } as const;
/** Archived cards the board payload sends at most, newest archived first (D634); more come by page. */
export const ARCHIVED_PAGE = 200;

export const boardFullMessage = `A board can have up to ${LIMITS.liveCardsPerBoard} cards, not counting archived ones; archive or bin a card to make room`;
export const boardStoreFullMessage = `A board can keep up to ${LIMITS.cardsPerBoard} cards, archived ones included; bin archived cards to make room`;

/** The board's live cards: all of them, and those not archived (the ones the cap counts, D632). */
export function boardCardCounts(boardId: string) {
  return db.query("SELECT COUNT(*) AS total, COUNT(*) - COUNT(archived_at) AS active FROM cards WHERE board_id = ? AND deleted_at IS NULL").get(boardId) as { total: number; active: number };
}

/**
 * 409 LIMIT_REACHED unless the board has room for `active` more cards that are not archived and
 * `total` more live cards (D632, D633). Unarchiving adds an active card but no live one.
 */
export function requireBoardRoom(boardId: string, add: { active: number; total: number }) {
  const counts = boardCardCounts(boardId);
  if (add.active > 0 && counts.active + add.active > LIMITS.liveCardsPerBoard) throw limitReached(boardFullMessage);
  if (add.total > 0 && counts.total + add.total > LIMITS.cardsPerBoard) throw limitReached(boardStoreFullMessage);
}

const boardNotFound = () => new TaskError(404, "Board not found");
const columnNotFound = () => new TaskError(404, "Column not found");
export const ownerOnly = () => new TaskError(403, "Only the board owner can do this", "OWNER_ONLY");
export const limitReached = (message: string) => new TaskError(409, message, "LIMIT_REACHED");
export const readOnlyBoard = () => new TaskError(403, "You can view this board but not change it", "READ_ONLY");
const cannotComment = () => new TaskError(403, "You can view this board but not comment on it", "READ_ONLY");
export const managerRequired = () => new TaskError(403, "Only the board owner or a manager can do this", "MANAGER_REQUIRED");

/** Serializes every change to one board: ordering, column changes, sharing, and deletion. */
export const withBoardLock = <T>(boardId: string, operation: () => T | Promise<T>) =>
  withResourceLock(`board:${boardId}`, async () => operation());

export type BoardSummary = {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  visibility: BoardVisibility;
  /** The `all_users` audience level (D272). */
  share_role: BoardRow["share_role"];
  /** The caller's level on the board (§D.3): owner, manage, edit, comment, or view. */
  level: ItemLevel;
  card_count: number;
  /** Live cards the auto-archive sweep archived (D605); they are part of `card_count`. */
  archived_count: number;
  /** Cards in a done column this many days are archived (D604); null when it is off. */
  auto_archive_days: number | null;
  /** Level names, work level, and sprints (migration 019, D122). */
  structure: BoardStructure;
  /** The board's short code (migration 079, D710): cards' keys are `<code>-<number>`. */
  code: string | null;
  /** What card estimates mean on this board (migration 082, D750): none (off), points, or hours. */
  estimate_kind: EstimateKind;
  /** The points scale (D751): fibonacci or free; kept but unused for hours and none. */
  estimate_scale: EstimateScale;
  created_at: string;
  updated_at: string;
};

export type ColumnSummary = Pick<ColumnRow, "id" | "board_id" | "name" | "position" | "is_done" | "state" | "wip_limit" | "created_at" | "updated_at">;

const boardSummarySelect = `
  SELECT b.id, b.name, b.owner_id, u.display_name AS owner_name,
         CASE WHEN b.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
         b.visibility, b.share_role,
         (SELECT COUNT(*) FROM cards k WHERE k.board_id = b.id AND k.deleted_at IS NULL) AS card_count,
         (SELECT COUNT(*) FROM cards k WHERE k.board_id = b.id AND k.deleted_at IS NULL AND k.archived_at IS NOT NULL) AS archived_count,
         b.auto_archive_days, b.structure_json, b.code, b.estimate_kind, b.estimate_scale, b.created_at, b.updated_at
  FROM boards b JOIN users u ON u.id = b.owner_id
`;

type BoardSummaryRow = Omit<BoardSummary, "structure" | "level"> & { structure_json: string };
const withStructure = ({ structure_json, ...row }: BoardSummaryRow, userId: string, level?: ItemLevel): BoardSummary => ({
  ...row, level: level ?? boardLevel({ ...row, deleted_at: null }, userId), structure: parseStructure(structure_json)
});

export function boardSummary(boardId: string, userId: string) {
  const row = db.query(`${boardSummarySelect} WHERE b.id = $boardId AND ${readableBoardPredicate}`).get({ boardId, userId }) as BoardSummaryRow | null;
  return row ? withStructure(row, userId) : null;
}

/** `keyScope` (Wave 34): an API key limited to chosen boards, over `b.id`, applied before the LIMIT. */
export function listBoards(userId: string, keyScope: SqlFilter = NO_FILTER) {
  const rows = db.query(`${boardSummarySelect} WHERE ${readableBoardPredicate} AND ${keyScope.sql} ORDER BY is_owner DESC, b.name COLLATE NOCASE, b.id LIMIT 500`)
    .all({ ...keyScope.params, userId }) as BoardSummaryRow[];
  // The page's levels in three queries, not three per board (C10).
  const levels = boardLevels(rows, userId);
  return rows.map((row) => withStructure(row, userId, levels.get(row.id)));
}

export function listColumns(boardId: string) {
  return db.query("SELECT id, board_id, name, position, is_done, state, wip_limit, created_at, updated_at FROM board_columns WHERE board_id = ? ORDER BY position, id")
    .all(boardId) as ColumnSummary[];
}

/**
 * A card as shown on the board: no description (up to 64 KiB each), only
 * whether one exists and a short plain-text excerpt, plus comment and
 * attachment counts.
 */
export type CardSummary = {
  id: string;
  board_id: string;
  column_id: string;
  position: number;
  title: string;
  has_description: 0 | 1;
  /** Plain text of the description, at most 160 characters (D111); '' without one. */
  description_excerpt: string;
  revision: number;
  created_by: string | null;
  creator_name: string | null;
  /** 1 when an integration created the card through its key (Wave 36, D287). */
  creator_is_integration: 0 | 1;
  /** Calendar date YYYY-MM-DD (migration 011); the civil date in `due_tz` when a time is set. */
  due_on: string | null;
  /** Optional wall time `HH:MM` in `due_tz` (D100); both NULL or both set. */
  due_time: string | null;
  /** The IANA zone the setter's browser sent (D101). */
  due_tz: string | null;
  /** The computed UTC instant when `due_time` is set, else null. */
  due_at: string | null;
  /** The optional start (D720, migration 080), shaped like the due fields: a civil date, an optional `HH:MM` in `start_tz`. */
  start_on: string | null;
  start_time: string | null;
  start_tz: string | null;
  /** The computed UTC instant when `start_time` is set, else null. */
  start_at: string | null;
  /** Every assignee, in assignment order, at most 20 (D102). */
  assignees: CardAssignee[];
  /** Deprecated (D103): the first assignee's id, kept for one release. */
  assignee_id: string | null;
  /** Deprecated (D103): the first assignee's display name. */
  assignee_name: string | null;
  /** Tag ids of this board, at most 10, in tagging order; resolve against the board's `tags` (D109). */
  tag_ids: string[];
  /** Flags from the fixed set, in its order (D110); Urgent is a priority now (D1310). */
  flags: CardFlag[];
  /** urgent, high, medium, or low; null without one (migration 123, D1310). */
  priority: TaskPriority | null;
  comment_count: number;
  attachment_count: number;
  /** The parent card on the same board, one level up, or null (migration 019, D121). */
  parent_card_id: string | null;
  /** 0 (top) to 2; names come from the board's structure (D122). */
  level: number;
  /** Live direct children, and those in a done column (D125, D134). */
  child_count: number;
  done_child_count: number;
  /**
   * The card's sprint (17B, D124): stored on work-level cards, inherited from the parent below the
   * work level, null above it and in the backlog.
   */
  sprint_id: string | null;
  /** When the card last came into a done column, or null outside one (D603). */
  done_at: string | null;
  /** When the auto-archive sweep archived it, or null (D605). Archived cards are live, not binned. */
  archived_at: string | null;
  /** Its number on its board (migration 079, D713); the key is the board's code, a hyphen, and this. */
  number: number | null;
  /** Points or hours as the board's `estimate_kind` says (migration 082, D750); null without one and on a board with estimates off (D752). */
  estimate: number | null;
  created_at: string;
  updated_at: string;
};


const cardSelect = (extraColumns = "") => `
  SELECT k.id, k.board_id, k.column_id, k.position, k.title,
         CASE WHEN k.description <> '' THEN 1 ELSE 0 END AS has_description,
         k.description_excerpt, k.revision, k.created_by, cu.display_name AS creator_name, CASE WHEN cu.kind = 'service' THEN 1 ELSE 0 END AS creator_is_integration,
         k.due_on, k.due_time, k.due_tz, k.start_on, k.start_time, k.start_tz, k.priority,
         (SELECT COUNT(*) FROM card_comments cc WHERE cc.card_id = k.id) AS comment_count,
         (SELECT COUNT(*) FROM card_attachments ca WHERE ca.card_id = k.id) AS attachment_count,
         k.parent_card_id, k.level, ${EFFECTIVE_SPRINT_SQL} AS sprint_id,
         k.done_at, k.archived_at, k.number, ${visibleEstimateSql("eb.estimate_kind")} AS estimate, k.created_at, k.updated_at${extraColumns}
  FROM cards k JOIN boards eb ON eb.id = k.board_id LEFT JOIN users cu ON cu.id = k.created_by
`;
const cardSummarySelect = cardSelect();
const cardDetailSelect = cardSelect(", k.description");

/** A selected card row before its computed and grouped fields (due instant, assignees) are attached. */
type SelectedCard = Omit<CardSummary, "due_at" | "start_at" | "assignees" | "assignee_id" | "assignee_name" | "tag_ids" | "flags" | "child_count" | "done_child_count">;
type GroupedFields = { assignees: CardAssignee[]; tagIds: string[]; flags: CardFlag[]; rollup: Rollup };

/** Adds the computed and grouped fields; the deprecated `assignee_id`/`assignee_name` are the first assignee (D103). */
function withCardFields<T extends SelectedCard>(card: T, { assignees, tagIds, flags, rollup }: GroupedFields, instant: typeof dueAt = dueAt) {
  const first = assignees[0];
  return { ...card, due_at: instant(card), start_at: card.start_time ? startAt(card) : null, assignees, assignee_id: first?.id ?? null, assignee_name: first?.display_name ?? null, tag_ids: tagIds, flags, ...rollup };
}
const NO_CHILDREN: Rollup = { child_count: 0, done_child_count: 0 };

/** The due fields after a change, or 400 with the rule that failed (D100). */
function requireDue(current: Parameters<typeof resolveDue>[0], input: DueInput) {
  const resolved = resolveDue(current, input);
  if ("error" in resolved) throw new TaskError(400, resolved.error);
  return resolved;
}

/** The start fields after a change, or 400 with the rule that failed (D720, the due rules). */
function requireStart(current: StartFields, input: StartInput) {
  const resolved = resolveStart(current, input);
  if ("error" in resolved) throw new TaskError(400, resolved.error);
  return resolved;
}

/** 400 START_AFTER_DUE when the card's start, as it will be saved, comes after its due date (D721). */
function requireStartNotAfterDue(start: StartFields, due: DueFields) {
  if (startAfterDue(start, due)) throw new TaskError(400, "The start must be on or before the due date", "START_AFTER_DUE");
}

/**
 * Which archived cards a board read includes (D634): none, all, or at most `limit` of them, newest
 * archived first, from before the `before` cursor (an archived card's `archived_at` and id).
 */
export type ArchivedSelection = { limit: number; before?: ArchivedCursor | null };
export type ArchivedCursor = { archivedAt: string; id: string };

/** `archived_at|id` of the last card of a page; the next page starts after it (D634). */
export const encodeArchivedCursor = (card: { archived_at: string | null; id: string }) => `${card.archived_at}|${card.id}`;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function decodeArchivedCursor(value: string): ArchivedCursor | null {
  const match = CURSOR.exec(value);
  return match ? { archivedAt: match[1]!, id: match[2]!.toLowerCase() } : null;
}

/** The archived cards of a page, as SQL over `k` (newest archived first, D634). */
function archivedPageSql(boardId: string, page: ArchivedSelection) {
  const before = page.before ? " AND (a.archived_at < $beforeAt OR (a.archived_at = $beforeAt AND a.id < $beforeId))" : "";
  return {
    sql: `k.id IN (SELECT a.id FROM cards a WHERE a.board_id = $boardId AND a.deleted_at IS NULL AND a.archived_at IS NOT NULL${before}
      ORDER BY a.archived_at DESC, a.id DESC LIMIT $archivedLimit)`,
    params: { boardId, archivedLimit: page.limit, ...(page.before ? { beforeAt: page.before.archivedAt, beforeId: page.before.id } : {}) }
  };
}

/**
 * The board's live cards in order. `includeArchived`: true (the default) lists archived cards too,
 * false leaves them out (D605), and `{ limit, before }` lists one page of them (D634).
 * `archivedOnly` lists only that page.
 */
export function listCards(boardId: string, options: { includeArchived?: boolean | ArchivedSelection; archivedOnly?: boolean } = {}): CardSummary[] {
  const include = options.includeArchived ?? true;
  const page = typeof include === "object" ? archivedPageSql(boardId, include) : null;
  const archived = options.archivedOnly
    ? page ? ` AND ${page.sql}` : " AND k.archived_at IS NOT NULL"
    : include === false ? " AND k.archived_at IS NULL" : page ? ` AND (k.archived_at IS NULL OR ${page.sql})` : "";
  const cards = db.query(`${cardSummarySelect} WHERE k.board_id = $boardId AND k.deleted_at IS NULL${archived} ORDER BY k.position, k.id`)
    .all({ ...(page?.params ?? {}), boardId }) as SelectedCard[];
  // One grouped query per concern over the board's live cards, never a per-card subquery (§3.1).
  const assignees = assigneesForBoard(boardId);
  const tags = tagIdsForBoard(boardId);
  const flags = flagsForBoard(boardId);
  const rollups = rollupsForBoard(boardId);
  // Cards often share a due date, time, and zone; each instant costs a few Intl calls (measured in 13C, D113).
  const instants = new Map<string, string | null>();
  const instant = (card: Parameters<typeof dueAt>[0]) => {
    if (!card.due_time) return null;
    const key = `${card.due_on}T${card.due_time} ${card.due_tz}`;
    if (!instants.has(key)) instants.set(key, dueAt(card));
    return instants.get(key)!;
  };
  return cards.map((card) => withCardFields(card, { assignees: assignees.get(card.id) ?? [], tagIds: tags.get(card.id) ?? [], flags: flags.get(card.id) ?? [], rollup: rollups.get(card.id) ?? NO_CHILDREN }, instant));
}

/**
 * The board, its columns, cards, tags, and sprints. Cards include auto-archived ones unless
 * `includeArchived` is false (the app's board passes the viewer's choice, D606; MCP lists them all).
 */
export function getBoard(userId: string, boardId: string, options: Parameters<typeof listCards>[1] = {}) {
  requireReadableBoard(boardId, userId);
  // Open sprints and the latest completed ones (17B, §6.1); empty on a board that never had sprints.
  return { board: boardSummary(boardId, userId)!, columns: listColumns(boardId), cards: listCards(boardId, options), tags: listBoardTags(boardId), sprints: boardSprints(boardId) };
}

/** The board if the caller can read it, else 404. */
export function requireReadableBoard(boardId: string, userId: string) {
  const board = readableBoard(boardId, userId);
  if (!board) throw boardNotFound();
  return board;
}

/**
 * The board if the caller holds at least `needed` on it (D272): 404 for non-readers, 403
 * READ_ONLY (edit, comment) or MANAGER_REQUIRED (manage) for readers below it.
 */
export function requireBoardAt(boardId: string, userId: string, needed: "comment" | "edit" | "manage") {
  const board = requireReadableBoard(boardId, userId);
  requireLevel(board, userId, needed);
  return board;
}

function requireLevel(board: BoardRow, userId: string, needed: "comment" | "edit" | "manage") {
  if (atLeast(boardLevel(board, userId), needed)) return;
  throw needed === "manage" ? managerRequired() : needed === "comment" ? cannotComment() : readOnlyBoard();
}

/** A live card on a board where the caller holds at least `needed`; 404 for non-readers. */
export function requireCardAt(cardId: string, userId: string, needed: "comment" | "edit") {
  const found = requireReadableCard(cardId, userId);
  requireLevel(found.board, userId, needed);
  return found;
}

/** The board if the caller owns it; 404 for non-readers, 403 OWNER_ONLY for other readers. */
export function requireOwnedBoard(boardId: string, userId: string) {
  const board = requireReadableBoard(boardId, userId);
  if (board.owner_id !== userId) throw ownerOnly();
  return board;
}

/** Creates a board from a template (D136; default Simple kanban): its columns and states, its structure, and any tags. Never cards. */
export function createBoard(userId: string, name: string, templateId: BoardTemplateId = "kanban", tz?: string, requestedCode?: string) {
  const template = TEMPLATES[templateId];
  return db.transaction(() => {
    const owned = (db.query("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
    if (owned >= LIMITS.boardsPerOwner) throw limitReached(`You can have up to ${LIMITS.boardsPerOwner} boards`);
    // A code asked for must be free (409 CODE_TAKEN); without one the name suggests a free code (D711).
    const code = requestedCode === undefined ? freeBoardCode(name) : requireFreeCode(requestedCode, null);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query("INSERT INTO boards (id, owner_id, name, structure_json, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, name, JSON.stringify(template.structure), code, timestamp, timestamp);
    const insertColumn = db.query("INSERT INTO board_columns (id, board_id, name, position, is_done, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    // A done column is a done column (D53), as the 011 backfill does for existing boards; states follow D141.
    template.columns.forEach((column, index) => {
      insertColumn.run(crypto.randomUUID(), id, column.name, (index + 1) * 1024, column.state === "done" ? 1 : 0, column.state, timestamp, timestamp);
    });
    const insertTag = db.query("INSERT INTO board_tags (id, board_id, name, color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const tag of template.tags ?? []) insertTag.run(crypto.randomUUID(), id, tag.name, tag.color, userId, timestamp, timestamp);
    // The Scrum template starts with a planned first sprint of two weeks from today (§7.4): the
    // creator's today in their zone when the client sends one (QA 0.9.0), else UTC's.
    if (template.firstSprint) {
      const zone = tz ? validTimeZone(tz) : null;
      const startOn = zone ? dateInZone(new Date(timestamp), zone) : timestamp.slice(0, 10);
      db.query("INSERT INTO board_sprints (id, board_id, name, start_on, end_on, state, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'planned', 1024, ?, ?, ?)")
        .run(crypto.randomUUID(), id, template.firstSprint, startOn, sprintEndFor(startOn, template.structure.sprintDefaults?.days ?? SPRINT_DEFAULT_DAYS), userId, timestamp, timestamp);
    }
    audit(userId, null, "task.board_create", { boardId: id, ...(templateId !== "kanban" ? { template: templateId } : {}) });
    return { board: boardSummary(id, userId)!, columns: listColumns(id) };
  })();
}

/**
 * The code as stored, or 400 CODE_INVALID for a malformed one and 409 CODE_TAKEN for one another
 * board has or had (D712, D714). Codes are workspace-wide, so CODE_TAKEN says a code is in use
 * without naming the board (T461).
 */
function requireFreeCode(value: string, boardId: string | null) {
  const code = normalizeBoardCode(value);
  if (!code) throw new TaskError(400, boardCodeMessage, "CODE_INVALID");
  if (boardCodeTaken(code, boardId)) {
    throw new TaskError(409, `The code ${code} is already used by another board`, "CODE_TAKEN", { suggestion: freeBoardCode(code, boardId) });
  }
  return code;
}

export function renameBoard(userId: string, boardId: string, name: string) {
  return updateBoard(userId, boardId, { name });
}

/**
 * Replaces the board's structure (owner only, D122, T120). Refused while it would hide cards:
 * 409 LEVEL_IN_USE when a card (live or in the Bin, which would restore at a missing level) sits
 * at a level being removed, and 409 SPRINTS_IN_USE when turning sprints off with open sprints or
 * moving the work level while cards are in an open sprint (17B; completed sprints never block).
 */
export function setBoardStructure(userId: string, boardId: string, structure: BoardStructure) {
  return updateBoard(userId, boardId, { structure });
}

/** Throws the 409 that refuses `structure` on this board, if any (see setBoardStructure). */
function checkStructureChange(boardId: string, structure: BoardStructure) {
  const current = boardStructure(boardId);
  // Per removed level (QA 0.9.0): "8 cards are Stories and 6 are Subtasks", not one level's name with the total.
  const removedLevels = db.query("SELECT level, COUNT(*) AS count, SUM(deleted_at IS NOT NULL) AS binned FROM cards WHERE board_id = ? AND level >= ? GROUP BY level ORDER BY level")
    .all(boardId, structure.levels.length) as Array<{ level: number; count: number; binned: number | null }>;
  if (removedLevels.length) {
    const cardCount = removedLevels.reduce((sum, row) => sum + row.count, 0);
    const binned = removedLevels.reduce((sum, row) => sum + (row.binned ?? 0), 0);
    const levels = removedLevels.map((row) => ({ level: row.level, name: current.levels[row.level]?.name ?? "Card", plural: current.levels[row.level]?.plural ?? "Cards", cardCount: row.count }));
    throw new TaskError(409, levelInUseMessage(levels, binned), "LEVEL_IN_USE", {
      level: removedLevels[0]!.level, cardCount, binnedCount: binned,
      levels: levels.map(({ level, name, cardCount: count }) => ({ level, name, cardCount: count }))
    });
  }
  if (!structure.sprints && current.sprints) {
    const open = (db.query("SELECT COUNT(*) AS count FROM board_sprints WHERE board_id = ? AND state IN ('planned', 'active')").get(boardId) as { count: number }).count;
    if (open) throw new TaskError(409, "Complete or delete the open sprints before turning sprints off", "SPRINTS_IN_USE", { sprintCount: open });
  }
  if (structure.workLevel !== current.workLevel) {
    // Only sprints still open count: cards in completed sprints keep their sprint as history and
    // must not block the change (with sprints off there is no way to take them out).
    const assigned = (db.query(`SELECT COUNT(*) AS count FROM cards k JOIN board_sprints s ON s.id = k.sprint_id
      WHERE k.board_id = ? AND s.state <> 'closed'`).get(boardId) as { count: number }).count;
    if (assigned) throw new TaskError(409, "Take the cards out of their sprints before changing where new cards are created", "SPRINTS_IN_USE", { cardCount: assigned });
  }
}

/**
 * `PATCH /boards/:b` (owner only): a new name, a new structure, or both. Both are checked first and
 * then written in one transaction under the board lock, so a refused structure never leaves the
 * name changed and a failed write leaves neither.
 */
export function updateBoard(userId: string, boardId: string, input: { name?: string; structure?: BoardStructure; keepSprintDefaults?: boolean; autoArchiveDays?: number | null; code?: string; estimates?: Partial<EstimateSettings> }) {
  return withBoardLock(boardId, () => {
    requireBoardAt(boardId, userId, "manage");
    // The code changes every card's key, so only the owner changes it (D712); old keys keep working (D714).
    if (input.code !== undefined) requireOwnedBoard(boardId, userId);
    const code = input.code === undefined ? undefined : requireFreeCode(input.code, boardId);
    const { name } = input;
    // A structure sent without `sprintDefaults` keeps the stored ones; `null` clears them.
    const kept = input.structure && input.keepSprintDefaults ? boardStructure(boardId).sprintDefaults : undefined;
    const structure = input.structure && kept ? { ...input.structure, sprintDefaults: kept } : input.structure;
    if (structure) checkStructureChange(boardId, structure);
    db.transaction(() => {
      const timestamp = now();
      if (structure) {
        db.query("UPDATE boards SET structure_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(JSON.stringify(structure), timestamp, boardId);
        audit(userId, null, "task.board_structure", { boardId, levels: structure.levels.length, workLevel: structure.workLevel, sprints: structure.sprints });
      }
      if (name !== undefined) {
        db.query("UPDATE boards SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(name, timestamp, boardId);
        audit(userId, null, "task.board_rename", { boardId });
      }
      if (input.autoArchiveDays !== undefined) {
        // Only later sweeps read it: cards already archived stay archived (D604).
        db.query("UPDATE boards SET auto_archive_days = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(input.autoArchiveDays, timestamp, boardId);
        audit(userId, null, "task.board_auto_archive", { boardId, days: input.autoArchiveDays });
      }
      if (code !== undefined) {
        const before = (db.query("SELECT code FROM boards WHERE id = ?").get(boardId) as { code: string | null }).code;
        if (writeBoardCode(boardId, code, timestamp)) audit(userId, null, "task.board_code", { boardId, code, previous: before });
      }
      if (input.estimates) writeEstimateSettings(userId, boardId, input.estimates, timestamp);
    })();
    return { board: boardSummary(boardId, userId)! };
  });
}

/** The board's estimate settings (D750, D751); `none` for a missing board. */
export function boardEstimateSettings(boardId: string): EstimateSettings {
  return estimateSettingsOf(db.query("SELECT estimate_kind, estimate_scale FROM boards WHERE id = ?").get(boardId) as { estimate_kind: string; estimate_scale: string } | null);
}

/**
 * Board settings → Estimates (D752): a new kind and/or scale. Stored card values are never
 * rewritten: off hides them, on shows them again, and points ↔ hours keeps the numbers (the
 * settings say they are not converted). Audited `task.board_estimates` with before and after, and
 * how many live cards hold a value, so a change that reinterprets them is traceable.
 */
function writeEstimateSettings(userId: string, boardId: string, change: Partial<EstimateSettings>, timestamp: string) {
  const before = boardEstimateSettings(boardId);
  const after = { kind: change.kind ?? before.kind, scale: change.scale ?? before.scale };
  if (after.kind === before.kind && after.scale === before.scale) return;
  db.query("UPDATE boards SET estimate_kind = ?, estimate_scale = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(after.kind, after.scale, timestamp, boardId);
  const estimated = (db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND deleted_at IS NULL AND estimate IS NOT NULL").get(boardId) as { count: number }).count;
  audit(userId, null, "task.board_estimates", { boardId, kind: after.kind, scale: after.scale, kindBefore: before.kind, scaleBefore: before.scale, estimatedCards: estimated });
}

/** The estimate a write stores (D753), or 400 ESTIMATES_OFF / ESTIMATE_INVALID. */
function requireEstimate(boardId: string, value: number | null) {
  const checked = checkEstimate(boardEstimateSettings(boardId), value);
  if (!checked.ok) throw new TaskError(400, checked.error, checked.code);
  return checked.value;
}

/**
 * Moves a board to the Bin (owner only). Stage A sets the Bin columns only;
 * restore, purge, and the Bin listing arrive with Task Boards stage D.
 */
export function deleteBoard(userId: string, boardId: string) {
  return withBoardLock(boardId, () => {
    requireOwnedBoard(boardId, userId);
    const deletedAt = new Date();
    const purgeAfter = purgeAfterFrom(deletedAt);
    db.transaction(() => {
      db.query("UPDATE boards SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL")
        .run(deletedAt.toISOString(), userId, purgeAfter, boardId);
      audit(userId, null, "task.board_delete", { boardId });
    })();
    return { ok: true as const, purgeAfter };
  });
}

export function getSharing(userId: string, boardId: string) {
  const board = requireOwnedBoard(boardId, userId);
  const users = db.query("SELECT u.id, u.display_name FROM board_members m JOIN users u ON u.id = m.user_id WHERE m.board_id = ? ORDER BY u.display_name")
    .all(boardId) as Array<{ id: string; display_name: string }>;
  return { visibility: board.visibility, users };
}

/** Replaces the audience, like folder sharing: members are kept only for `selected`. */
export async function putSharing(userId: string, boardId: string, visibility: BoardVisibility, userIds: string[]) {
  requireOwnedBoard(boardId, userId);
  if (userIds.includes(userId)) throw new TaskError(400, "The owner cannot be added as a recipient");
  const uniqueIds = [...new Set(userIds)];
  if (visibility === "selected" && uniqueIds.length === 0) throw new TaskError(400, "Select at least one user");
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const validUsers = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
    if (validUsers.length !== uniqueIds.length) throw new TaskError(400, "One or more users were not found");
  }
  if (visibility === "selected" && legacyGuestShareBlocked("board", boardId, legacyShareLevels("board", boardId, uniqueIds, "edit"))) throw new TaskError(400, GUEST_SHARE_DISABLED.error, GUEST_SHARE_DISABLED.code);
  return withBoardLock(boardId, () => {
    requireOwnedBoard(boardId, userId);
    db.transaction(() => {
      const before = shareMembers("board_members", "board_id", boardId);
      // People already shared with keep their level; new ones edit cards (D38, D272). Groups are left as they are.
      writeDirectShares("board", boardId, visibility === "selected" ? legacyShareLevels("board", boardId, uniqueIds, "edit") : []);
      if (visibility === "selected") {
        // "Shared with you" mail (outbound email #25).
        mailShared(userId, "board", boardId, before, uniqueIds);
      }
      db.query("UPDATE boards SET visibility = ?, updated_at = ? WHERE id = ?").run(visibility, now(), boardId);
      audit(userId, null, "task.board_sharing_changed", { boardId, visibility, recipientCount: visibility === "selected" ? uniqueIds.length : 0 });
    })();
    return { ok: true as const };
  });
}

export function applyRenumber(table: "board_columns" | "cards" | "task_views" | "board_sprints", renumbered: Positioned[] | null) {
  if (!renumbered) return false;
  const statement = db.query(`UPDATE ${table} SET position = ? WHERE id = ?`);
  for (const item of renumbered) statement.run(item.position, item.id);
  return true;
}

export function createColumn(userId: string, boardId: string, input: { name: string; afterColumnId?: string | null }) {
  return withBoardLock(boardId, () => {
    requireBoardAt(boardId, userId, "manage");
    const columns = listColumns(boardId);
    if (columns.length >= LIMITS.columnsPerBoard) throw limitReached(`A board can have up to ${LIMITS.columnsPerBoard} columns`);
    const plan = planInsert(columns, input.afterColumnId);
    if (!plan) throw columnNotFound();
    const id = crypto.randomUUID();
    db.transaction(() => {
      applyRenumber("board_columns", plan.renumbered);
      const timestamp = now();
      // A new column is a doing column (not done), whatever its place; the owner changes it (D141).
      db.query("INSERT INTO board_columns (id, board_id, name, position, is_done, state, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'doing', ?, ?)")
        .run(id, boardId, input.name, plan.position, timestamp, timestamp);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, boardId);
      audit(userId, null, "task.column_create", { boardId, columnId: id });
    })();
    return { column: listColumns(boardId).find((column) => column.id === id)!, columns: listColumns(boardId) };
  });
}

/** Resolves a column path id to its board and checks the owner or a manager (404 / 403 MANAGER_REQUIRED). */
function requireOwnedColumn(columnId: string, userId: string) {
  const found = readableColumn(columnId, userId);
  if (!found) throw columnNotFound();
  requireLevel(found.board, userId, "manage");
  return found;
}

/**
 * The state and done flag a column patch writes together (D141, T121), or null
 * when it changes neither. `state` wins and sets `is_done`; `isDone` alone sets
 * done, or, when turned off, todo for the board's first column and doing
 * otherwise (the 020 backfill rule). Conflicting values are 400.
 */
function nextColumnState(column: ColumnRow, siblings: ColumnSummary[], input: { isDone?: boolean; state?: ColumnState }): ColumnState | null {
  if (input.state !== undefined) {
    if (input.isDone !== undefined && input.isDone !== (input.state === "done")) throw new TaskError(400, "isDone and state disagree");
    return input.state;
  }
  if (input.isDone === undefined) return null;
  if (input.isDone) return "done";
  if (column.state !== "done") return column.state;
  const first = siblings.length === 0 || siblings.every((other) => other.position > column.position);
  return first ? "todo" : "doing";
}

export async function patchColumn(userId: string, columnId: string, input: { name?: string; afterColumnId?: string | null; isDone?: boolean; state?: ColumnState; wipLimit?: number | null }) {
  const { board } = requireOwnedColumn(columnId, userId);
  return withBoardLock(board.id, () => {
    const { column } = requireOwnedColumn(columnId, userId);
    const siblings = listColumns(board.id).filter((column) => column.id !== columnId);
    let plan = null as ReturnType<typeof planInsert>;
    if (input.afterColumnId !== undefined) {
      if (input.afterColumnId === columnId) throw new TaskError(400, "A column cannot be placed after itself");
      plan = planInsert(siblings, input.afterColumnId);
      if (!plan) throw columnNotFound();
    }
    const state = nextColumnState(column, siblings, input);
    db.transaction(() => {
      const timestamp = now();
      if (input.name !== undefined) {
        db.query("UPDATE board_columns SET name = ?, updated_at = ? WHERE id = ?").run(input.name, timestamp, columnId);
        audit(userId, null, "task.column_rename", { boardId: board.id, columnId });
      }
      if (state !== null) {
        // One statement writes both, so `is_done = (state = 'done')` always holds (T121).
        db.query("UPDATE board_columns SET state = ?, is_done = ?, updated_at = ? WHERE id = ?").run(state, state === "done" ? 1 : 0, timestamp, columnId);
        // Its cards' done clocks (D603): they start now in a column that became done, and stop in one
        // that no longer is. Archived cards stay archived (D610: an archive may be by hand).
        if (state === "done" && column.state !== "done") {
          db.query("UPDATE cards SET done_at = ? WHERE column_id = ? AND deleted_at IS NULL AND done_at IS NULL").run(timestamp, columnId);
        } else if (state !== "done" && column.state === "done") {
          db.query("UPDATE cards SET done_at = NULL WHERE column_id = ? AND deleted_at IS NULL").run(columnId);
        }
        if (input.isDone !== undefined) audit(userId, null, "task.column_done", { boardId: board.id, columnId, isDone: state === "done" });
        if (input.state !== undefined) audit(userId, null, "task.column_state", { boardId: board.id, columnId, state });
      }
      if (input.wipLimit !== undefined) {
        // A limit may be set below the current count; it only blocks cards coming in (D108).
        db.query("UPDATE board_columns SET wip_limit = ?, updated_at = ? WHERE id = ?").run(input.wipLimit, timestamp, columnId);
        audit(userId, null, "task.column_wip", { boardId: board.id, columnId, wipLimit: input.wipLimit });
      }
      if (plan) {
        applyRenumber("board_columns", plan.renumbered);
        db.query("UPDATE board_columns SET position = ?, updated_at = ? WHERE id = ?").run(plan.position, timestamp, columnId);
        audit(userId, null, "task.column_move", { boardId: board.id, columnId });
      }
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
    })();
    const columns = listColumns(board.id);
    return { column: columns.find((column) => column.id === columnId)!, columns, ...(plan?.renumbered ? { renormalized: true } : {}) };
  });
}

/**
 * Deletes an empty column (owner only). Binned cards that sat in it keep
 * `column_id = NULL` and restore to the first column (stage D).
 */
export async function deleteColumn(userId: string, columnId: string) {
  const { board } = requireOwnedColumn(columnId, userId);
  return withBoardLock(board.id, () => {
    requireOwnedColumn(columnId, userId);
    const { count: liveCards, archived } = db.query("SELECT COUNT(*) AS count, COUNT(archived_at) AS archived FROM cards WHERE column_id = ? AND deleted_at IS NULL").get(columnId) as { count: number; archived: number };
    if (liveCards > 0) {
      // Archived cards are hidden from the board but still live (D605): say where they are.
      const message = archived === liveCards
        ? `This column has ${archived === 1 ? "1 archived card" : `${archived} archived cards`}. Show archived cards in Board settings to move or delete them.`
        : "Move or delete the cards in this column first";
      throw new TaskError(409, message, "COLUMN_NOT_EMPTY", { cardCount: liveCards, archivedCount: archived });
    }
    const columnCount = (db.query("SELECT COUNT(*) AS count FROM board_columns WHERE board_id = ?").get(board.id) as { count: number }).count;
    if (columnCount <= 1) throw new TaskError(409, "A board needs at least one column", "LAST_COLUMN");
    db.transaction(() => {
      db.query("DELETE FROM board_columns WHERE id = ?").run(columnId);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(now(), board.id);
      audit(userId, null, "task.column_delete", { boardId: board.id, columnId });
    })();
    return { ok: true as const, columns: listColumns(board.id) };
  });
}

// ---------------------------------------------------------------------------
// Cards (readers). Every change runs under the board lock.

/** `key` (D710): the card's key on its board now, such as MYT-12. */
export type CardDetail = CardSummary & { description: string; key: string | null };

export const cardNotFound = () => new TaskError(404, "Card not found");

export function cardDetail(cardId: string): CardDetail | null {
  const card = db.query(`${cardDetailSelect} WHERE k.id = ? AND k.deleted_at IS NULL`).get(cardId) as (SelectedCard & { description: string }) | null;
  return card ? { ...withCardFields(card, { assignees: assigneesForCard(cardId), tagIds: tagIdsForCard(cardId), flags: flagsForCard(cardId), rollup: rollupFor(cardId) }), key: keyOfCard(cardId) } : null;
}

export function liveCardsIn(columnId: string) {
  return db.query("SELECT id, position FROM cards WHERE column_id = ? AND deleted_at IS NULL ORDER BY position, id").all(columnId) as Positioned[];
}

/** 409 STALE_POSITION: the anchor is not a live card in the target column. Carries the column's current order. */
function stalePosition(columnId: string) {
  return new TaskError(409, "The board changed. Reload to see the current order.", "STALE_POSITION", {
    columnId,
    order: liveCardsIn(columnId).map((card) => card.id)
  });
}

/** A column of this board (path and body ids are joined to their board, T39). */
export function requireBoardColumn(boardId: string, columnId: string) {
  const column = db.query("SELECT id, wip_limit, state FROM board_columns WHERE id = ? AND board_id = ?").get(columnId, boardId) as { id: string; wip_limit: number | null; state: ColumnState } | null;
  if (!column) throw columnNotFound();
  return column;
}

/**
 * 409 COLUMN_FULL when a card would come into a column at or over its WIP
 * limit (D108, T96). Called under the board lock for creates and for moves
 * from another column only: moving within a column, moving out, and Bin
 * restore are always allowed. Every live card in the column counts, except archived ones (hidden
 * from the board, D605).
 */
export function requireColumnRoom(column: { id: string; wip_limit: number | null }) {
  if (column.wip_limit === null) return;
  const cardCount = (db.query("SELECT COUNT(*) AS count FROM cards WHERE column_id = ? AND deleted_at IS NULL AND archived_at IS NULL").get(column.id) as { count: number }).count;
  if (cardCount >= column.wip_limit) {
    throw new TaskError(409, `This column is full (limit ${column.wip_limit})`, "COLUMN_FULL", { columnId: column.id, wipLimit: column.wip_limit, cardCount });
  }
}

export function requireReadableCard(cardId: string, userId: string) {
  const found = readableCard(cardId, userId);
  if (!found) throw cardNotFound();
  return found;
}

/** A flag a write may send: the fixed set, or the deprecated `urgent` (D1312). */
export type WriteFlag = CardFlag | typeof LEGACY_URGENT_FLAG;

/**
 * The flags and priority a write means (D1312). The deprecated Urgent flag is the Urgent priority:
 * `flags: ["urgent", "blocked"]` stores Blocked and sets the priority to Urgent, unless the same
 * write names a `priority`, which wins. Sending flags without `urgent` never clears a priority, since
 * a client that predates priorities never sees Urgent among the flags it reads back.
 */
function legacyFlagWrite(input: { flags?: readonly WriteFlag[]; priority?: TaskPriority | null }) {
  const legacyUrgent = input.flags?.includes(LEGACY_URGENT_FLAG) ?? false;
  return {
    flags: input.flags?.filter((flag): flag is CardFlag => flag !== LEGACY_URGENT_FLAG),
    priority: input.priority !== undefined ? input.priority : legacyUrgent ? "urgent" as const : undefined
  };
}

export type CardCreateInput = {
  columnId: string; title: string; description?: string; dueOn?: string | null; afterCardId?: string | null;
  dueTime?: string | null; dueTz?: string | null;
  /** The optional start (D720), with the due date's rules; on or before the due date (D721). */
  startOn?: string | null; startTime?: string | null; startTz?: string | null;
  assigneeIds?: string[];
  /** Tags of this board (D109), at most 10 after deduplication. */
  tagIds?: string[];
  /** Unique flags from the fixed set (D110); the deprecated `urgent` sets the Urgent priority (D1312). */
  flags?: WriteFlag[];
  /** urgent, high, medium, low, or null for none (D1310). */
  priority?: TaskPriority | null;
  /** Relations from the new card toward readable cards, as POST /cards/:k/relations creates them (D104–D107). */
  relations?: Array<{ targetCardId: string; type: RelationType }>;
  /**
   * The caller's own uploads that no card links yet (task attachments, or Attachments-folder files),
   * and their own Files items when `attachmentsConfirmed` (U2, D396).
   */
  attachmentIds?: string[];
  attachmentsConfirmed?: boolean;
  /** A live card of this board one level up (D121); the level then defaults to the parent's plus one. */
  parentId?: string | null;
  /** 0–2 and below the board's level count; defaults to the parent's level plus one, else the work level (D122). */
  level?: number;
  /**
   * A planned or active sprint of this board (17B, D124); only on a work-level card of a board with
   * sprints on. null files the card in the backlog. Omitted, a work-level card joins the board's
   * active sprint when there is one (Friction 3: routines and MCP clients rarely pass it).
   */
  sprintId?: string | null;
  /** Points or hours as the board's estimate kind says (D750, D753); null or omitted for none. */
  estimate?: number | null;
};

/**
 * The sprint a card will store (17B, D124, D132): null, or a planned or active sprint of this board
 * for a work-level card on a board with sprints on. Below the work level a card inherits its
 * parent's sprint, so it stores none: 400 SPRINT_LEVEL. A sprint of another board is 404 like a
 * missing one; a completed sprint is 409 SPRINT_COMPLETED.
 */
function resolveSprint(boardId: string, structure: BoardStructure, level: number, sprintId: string | null) {
  if (sprintId === null) return null;
  if (!structure.sprints) throw new TaskError(400, "Turn sprints on in Board settings first", "SPRINTS_OFF");
  if (level !== structure.workLevel) {
    const work = structure.levels[structure.workLevel]?.plural ?? "Cards";
    throw new TaskError(400, `Only ${work.toLowerCase()} are planned in sprints; the others follow their parent`, "SPRINT_LEVEL");
  }
  const sprint = sprintOfBoard(sprintId.toLowerCase(), boardId);
  if (!sprint) throw new TaskError(404, "Sprint not found");
  if (sprint.state === "closed") throw new TaskError(409, "This sprint is completed", "SPRINT_COMPLETED", { sprintId: sprint.id });
  return sprint.id;
}

/** The sprint an omitted `sprintId` means (Friction 3): the active sprint, for a work-level card on a board with sprints on. */
function defaultSprint(boardId: string, structure: BoardStructure, level: number) {
  if (!structure.sprints || level !== structure.workLevel) return null;
  return (db.query("SELECT id FROM board_sprints WHERE board_id = ? AND state = 'active'").get(boardId) as { id: string } | null)?.id ?? null;
}

/**
 * Every invalid parent gets the same 400 PARENT_INVALID, whether it is unknown, on another board,
 * binned, the card itself, or at the wrong level, so a parent id is never an existence oracle (T113).
 */
const parentInvalid = () => new TaskError(400, "Choose a card one level up on this board as the parent", "PARENT_INVALID");
const levelInvalid = (structure: BoardStructure) =>
  new TaskError(400, `This board has ${structure.levels.length === 1 ? "one level" : `${structure.levels.length} levels`}`, "LEVEL_INVALID");

/** 409 LIMIT_REACHED when the parent already has the most direct children (D135, T111). */
function requireChildRoom(parentId: string) {
  if (liveChildCount(parentId) >= HIERARCHY_LIMITS.childrenPerCard) {
    throw limitReached(`A card can have up to ${HIERARCHY_LIMITS.childrenPerCard} subtasks`);
  }
}

/**
 * The parent and level a card will have on `boardId` (D121, §6.3). Checked under the board lock
 * with one lookup by id and board: the parent is live, one level up, and the card itself is below
 * the board's level count. Because levels strictly increase downward, no ancestor walk is needed.
 */
function resolvePlacement(boardId: string, input: { parentId: string | null; level: number | undefined; cardId?: string }) {
  const structure = boardStructure(boardId);
  if (input.parentId !== null) {
    const parent = input.parentId === input.cardId ? null : parentRow(input.parentId, boardId);
    const level = input.level ?? (parent ? parent.level + 1 : 0);
    if (!parent || parent.deleted_at !== null || parent.level !== level - 1 || level >= structure.levels.length) throw parentInvalid();
    return { structure, parentId: parent.id, level };
  }
  const level = input.level ?? structure.workLevel;
  if (level >= structure.levels.length) throw levelInvalid(structure);
  // A subtask needs its parent (operator QA 0.9.1); only a Bin restore brings one back detached (D130).
  if (parentRequired(structure, level)) {
    throw new TaskError(400, `${parentRequiredMessage(structure, level)}, or make it ${aLevel(structure, structure.workLevel)}`, "PARENT_REQUIRED", { level });
  }
  return { structure, parentId: null, level };
}

/**
 * Creates a card. `afterCardId`: omitted = bottom of the column, null = top, an id = after that card.
 * Assignees, tags, flags, relations, and attachments are written in the same transaction, after
 * the WIP check, so any refusal writes nothing.
 */
export function createCard(userId: string, boardId: string, input: CardCreateInput) {
  return withBoardLock(boardId, () => {
    requireBoardAt(boardId, userId, "edit");
    const column = requireBoardColumn(boardId, input.columnId);
    requireColumnRoom(column);
    const assignees = input.assigneeIds === undefined ? undefined : uniqueAssignees(input.assigneeIds);
    for (const assigneeId of assignees ?? []) requireAssignableUser(boardId, assigneeId);
    const tagIds = input.tagIds === undefined ? undefined : requireCardTags(boardId, input.tagIds);
    const due = requireDue({ due_on: null, due_time: null, due_tz: null }, input).value;
    const start = requireStart({ start_on: null, start_time: null, start_tz: null }, input).value;
    requireStartNotAfterDue(start, due);
    requireBoardRoom(boardId, { active: 1, total: 1 });
    const attachmentIds = input.attachmentIds === undefined ? [] : [...new Set(input.attachmentIds.map((documentId) => documentId.toLowerCase()))];
    const placement = resolvePlacement(boardId, { parentId: input.parentId ? input.parentId.toLowerCase() : null, level: input.level });
    if (placement.parentId) requireChildRoom(placement.parentId);
    const sprintId = input.sprintId === undefined
      ? defaultSprint(boardId, placement.structure, placement.level)
      : resolveSprint(boardId, placement.structure, placement.level, input.sprintId);
    const estimate = input.estimate === undefined ? null : requireEstimate(boardId, input.estimate);
    const { flags, priority } = legacyFlagWrite(input);
    const plan = planInsert(liveCardsIn(input.columnId), input.afterCardId);
    if (!plan) throw stalePosition(input.columnId);
    const id = crypto.randomUUID();
    db.transaction(() => {
      applyRenumber("cards", plan.renumbered);
      const timestamp = now();
      const description = input.description ?? "";
      db.query(`INSERT INTO cards (id, board_id, column_id, position, title, description, description_excerpt, due_on, due_time, due_tz, start_on, start_time, start_tz, parent_card_id, level, sprint_id, done_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, boardId, input.columnId, plan.position, input.title, description, descriptionExcerpt(description), due.due_on, due.due_time, due.due_tz,
          start.start_on, start.start_time, start.start_tz,
          placement.parentId, placement.level, sprintId, column.state === "done" ? timestamp : null, userId, timestamp, timestamp);
      // Its own statement, so the insert above stays as it was for the parallel lanes (D753).
      if (estimate !== null) db.query("UPDATE cards SET estimate = ? WHERE id = ?").run(estimate, id);
      if (priority) db.query("UPDATE cards SET priority = ? WHERE id = ?").run(priority, id);
      if (assignees?.length) replaceAssignees(id, assignees, userId, timestamp);
      if (tagIds?.length) replaceCardTags(id, tagIds, timestamp);
      if (flags?.length) replaceCardFlags(id, flags, timestamp);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, boardId);
      // Card history (lane ACTIVITY): "created this card in <column>"; the fields it starts with are part of it.
      recordCardActivity({ cardId: id, boardId, actorId: userId, kind: "created", payload: { from: null, to: activityValue.column(input.columnId) }, at: timestamp });
      if (description) recordCardMentions({ cardId: id, boardId, authorId: userId, text: description, before: null, where: "description", at: timestamp });
      audit(userId, null, "task.card_create", {
        boardId, cardId: id,
        ...(assignees?.length ? { assigneesAdded: assignees.length } : {}),
        ...(tagIds?.length ? { tagsAdded: tagIds.length } : {}),
        ...(flags?.length ? { flags } : {}),
        ...(priority ? { priority } : {}),
        ...(placement.parentId ? { parentId: placement.parentId } : {}),
        ...(placement.level !== 0 ? { level: placement.level } : {}),
        ...(sprintId ? { sprintId } : {}),
        ...(estimate !== null ? { estimate } : {})
      });
      // Same checks as POST /cards/:k/relations: the target must be readable (404 like a missing id), one per pair, 50 per card.
      for (const relation of input.relations ?? []) {
        const inserted = insertRelation(userId, id, relation.targetCardId.toLowerCase(), relation.type);
        audit(userId, null, "task.relation_create", { boardId, cardId: id, relationId: inserted.id, kind: inserted.kind });
      }
      if (attachmentIds.length) {
        // Only the uploader's own files (404 like a missing id otherwise). Fresh uploads (task
        // attachments, Attachments-folder files) must not be on a card yet; a Files item picked
        // From Files may be anywhere, and needs the confirm (D396).
        const linked = db.query("SELECT 1 FROM card_attachments WHERE document_id = ?");
        for (const documentId of attachmentIds) {
          const document = linkableCardDocument(documentId, userId);
          if (!document) throw new TaskError(404, "File not found");
          if (!needsLinkConfirm(document) && linked.get(documentId)) throw new TaskError(409, "This file is already attached to a card", "ATTACHMENT_LINKED", { documentId });
        }
        linkAttachments({ userId, cardId: id, documentIds: attachmentIds, commentId: null, confirmed: input.attachmentsConfirmed });
        for (const documentId of attachmentIds) audit(userId, null, "task.attachment_link", { boardId, cardId: id, documentId });
      }
    })();
    return { card: cardDetail(id)!, ...(plan.renumbered ? { renormalized: true } : {}) };
  });
}

/** The card alone; routes add its comments page and attachments (server/tasks/comments.ts, attachments.ts). */
export function getCard(userId: string, cardId: string) {
  const found = requireReadableCard(cardId, userId);
  return { card: cardDetail(cardId)!, board: found.board };
}

export type CardPatchInput = {
  title?: string; description?: string; dueOn?: string | null;
  /** `HH:MM` with `dueTz`, or null to clear the time (D100). */
  dueTime?: string | null;
  dueTz?: string | null;
  /** The start (D720): `startOn` null clears it and its time; `startTime` comes with `startTz`, null clears the time. */
  startOn?: string | null;
  startTime?: string | null;
  startTz?: string | null;
  /** Legacy (D103): `id` means `[id]`, `null` means `[]`. Not together with `assigneeIds`. */
  assigneeId?: string | null;
  /** Replaces the whole set; `[]` clears it. */
  assigneeIds?: string[];
  /** Replaces the whole tag set with tags of the card's board; `[]` clears it (D109). */
  tagIds?: string[];
  /** Replaces the whole flag set; `[]` clears it (D110). The deprecated `urgent` sets the Urgent priority (D1312). */
  flags?: WriteFlag[];
  /** Sets the priority, or null to clear it (D1310). */
  priority?: TaskPriority | null;
  /** Reparent (D128): a live card of this board one level up, or null to detach. The level stays unless `level` is sent. */
  parentId?: string | null;
  /** "Change level" (D128): refused with 409 HAS_CHILDREN while the card has live children. */
  level?: number;
  /** Plan the card in a sprint of its board, or null for the backlog (17B); work-level cards only. */
  sprintId?: string | null;
  /** Points or hours (D753); null clears it, also on a board with estimates off. */
  estimate?: number | null;
  revision: number;
};

export const READERS_UNFILTERED_LIMIT = 200;
export const READERS_DEFAULT_LIMIT = 20;

/**
 * Users who can read the board, for the assignee picker: the owner plus the
 * members (`selected`), or every enabled user (`all_users`), display names
 * only (T92). Without `q`, at most 200 by name, as before. With `q`, a
 * case-insensitive `instr` match on the display name (no LIKE wildcards),
 * at most `limit`. `truncated` says more matched.
 */
export function listBoardReaders(userId: string, boardId: string, options: { q?: string; limit?: number } = {}) {
  const board = requireReadableBoard(boardId, userId);
  const q = options.q ?? "";
  const limit = q ? options.limit ?? READERS_DEFAULT_LIMIT : READERS_UNFILTERED_LIMIT;
  const match = "($q = '' OR instr(lower(u.display_name), lower($q)) > 0)";
  const rows = (board.visibility === "all_users"
    ? db.query(`SELECT u.id, u.display_name FROM users u WHERE u.disabled_at IS NULL AND (u.id = $ownerId OR ${audienceAllUsersFor("u.id")}) AND ${match} ORDER BY u.display_name, u.id LIMIT $limit`).all({ ownerId: board.owner_id, q, limit: limit + 1 })
    : db.query(`SELECT u.id, u.display_name FROM users u WHERE u.disabled_at IS NULL AND (u.id = $ownerId
        OR ($visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = $boardId AND m.user_id = u.id)
          OR ${groupGrantExists("board", "$boardId", "u.id")})))
        AND ${match} ORDER BY u.display_name, u.id LIMIT $limit`).all({ ownerId: board.owner_id, visibility: board.visibility, boardId, q, limit: limit + 1 })
  ) as Array<{ id: string; display_name: string }>;
  return {
    users: rows.slice(0, limit).map((row) => ({ id: row.id, displayName: row.display_name })),
    truncated: rows.length > limit
  };
}

/** Deduplicated ids, in the order given; 400 above the cap. */
function uniqueAssignees(ids: readonly string[]) {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length > MAX_ASSIGNEES) throw new TaskError(400, `A card can have up to ${MAX_ASSIGNEES} assignees`);
  return unique;
}

/** The requested assignee set of a patch, or undefined when it leaves assignees alone (D103). */
function requestedAssignees(input: Pick<CardPatchInput, "assigneeId" | "assigneeIds">) {
  if (input.assigneeId !== undefined && input.assigneeIds !== undefined) {
    throw new TaskError(400, "Send assigneeIds or the legacy assigneeId, not both");
  }
  if (input.assigneeIds !== undefined) return uniqueAssignees(input.assigneeIds);
  if (input.assigneeId !== undefined) return input.assigneeId ? [input.assigneeId.toLowerCase()] : [];
  return undefined;
}

/** 400 ASSIGNEE_NOT_MEMBER unless the user is enabled and can read the board (D53). */
function requireAssignableUser(boardId: string, assigneeId: string) {
  const enabled = db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(assigneeId);
  if (!enabled || !readableBoard(boardId, assigneeId)) {
    throw new TaskError(400, "The assignee must be able to open this board", "ASSIGNEE_NOT_MEMBER");
  }
}

/**
 * Edits title, description, due date, assignees, tags, and/or flags with a compare-and-swap
 * on `revision` (409 CARD_CHANGED carries the current card). Every field
 * changes in one transaction and `revision` goes up by exactly 1 (D107).
 * `dueOn` accepts null to clear; `assigneeIds` replaces the whole set, and the
 * legacy `assigneeId` is 409 ASSIGNEES_MULTIPLE on a card with several. Only
 * users being added must be able to read the board, so a former member can
 * stay until someone removes them (T93).
 */
export async function patchCard(userId: string, cardId: string, input: CardPatchInput) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    const { card } = requireCardAt(cardId, userId, "edit");
    if (card.revision !== input.revision) {
      throw new TaskError(409, "Someone else changed this card", "CARD_CHANGED", { card: cardDetail(cardId)! });
    }
    const assignees = requestedAssignees(input);
    if (input.assigneeId !== undefined) {
      // The legacy single field would silently drop the other assignees: refuse it once there are several.
      const current = assigneesForCard(cardId);
      if (current.length > 1) {
        throw new TaskError(409, "This card has several assignees. Send assigneeIds to change them.", "ASSIGNEES_MULTIPLE", { assignees: current });
      }
    }
    for (const assigneeId of assignees ? newAssignees(cardId, assignees) : []) requireAssignableUser(board.id, assigneeId);
    const tagIds = input.tagIds === undefined ? undefined : requireCardTags(board.id, input.tagIds);
    const setDue = input.dueOn !== undefined || input.dueTime !== undefined || input.dueTz !== undefined;
    const due = setDue ? requireDue(card, input) : null;
    const setStart = input.startOn !== undefined || input.startTime !== undefined || input.startTz !== undefined;
    const start = setStart ? requireStart(card, input) : null;
    // Checked whenever either side changes, against the other side as saved (D721).
    if (setDue || setStart) requireStartNotAfterDue(start?.value ?? card, due?.value ?? card);
    const current = db.query("SELECT parent_card_id, level, sprint_id FROM cards WHERE id = ?").get(cardId) as { parent_card_id: string | null; level: number; sprint_id: string | null };
    const hierarchyChange = input.parentId !== undefined || input.level !== undefined;
    // A card with children keeps its level, whatever else the change says (D128).
    if (input.level !== undefined && input.level !== current.level) {
      const children = liveChildCount(cardId);
      if (children > 0) {
        throw new TaskError(409, `Move its ${children === 1 ? "child" : `${children} children`} to another card first`, "HAS_CHILDREN", { childCount: children });
      }
    }
    const placement = hierarchyChange
      ? resolvePlacement(board.id, {
        parentId: input.parentId === undefined ? current.parent_card_id : input.parentId === null ? null : input.parentId.toLowerCase(),
        level: input.level ?? current.level,
        cardId
      })
      : null;
    const reparented = placement !== null && placement.parentId !== current.parent_card_id;
    const releveled = placement !== null && placement.level !== current.level;
    if (releveled) {
      const children = liveChildCount(cardId);
      if (children > 0) {
        throw new TaskError(409, `Move its ${children === 1 ? "child" : `${children} children`} to another card first`, "HAS_CHILDREN", { childCount: children });
      }
    }
    if (reparented && placement.parentId) requireChildRoom(placement.parentId);
    // The stored sprint (17B): set when asked (work level only), and cleared when the card leaves the work level.
    const structure = placement?.structure ?? boardStructure(board.id);
    const finalLevel = placement?.level ?? current.level;
    const sprint = input.sprintId !== undefined
      ? { set: true, id: resolveSprint(board.id, structure, finalLevel, input.sprintId) }
      : releveled && current.sprint_id && finalLevel !== structure.workLevel ? { set: true, id: null } : { set: false, id: null };
    const sprintChanged = sprint.set && sprint.id !== current.sprint_id;
    const estimate = input.estimate === undefined ? undefined : requireEstimate(board.id, input.estimate);
    const { flags, priority } = legacyFlagWrite(input);
    db.transaction(() => {
      const timestamp = now();
      const before = cardActivitySnapshot(cardId)!;
      if (releveled) {
        // Children binned on their own keep their Bin entry and come back detached (D130).
        db.query("UPDATE cards SET parent_card_id = NULL WHERE parent_card_id = ? AND deleted_at IS NOT NULL").run(cardId);
      }
      const updated = db.query(`UPDATE cards SET title = COALESCE($title, title), description = COALESCE($description, description),
          description_excerpt = COALESCE($excerpt, description_excerpt),
          due_on = CASE WHEN $setDue THEN $dueOn ELSE due_on END,
          due_time = CASE WHEN $setDue THEN $dueTime ELSE due_time END,
          due_tz = CASE WHEN $setDue THEN $dueTz ELSE due_tz END,
          start_on = CASE WHEN $setStart THEN $startOn ELSE start_on END,
          start_time = CASE WHEN $setStart THEN $startTime ELSE start_time END,
          start_tz = CASE WHEN $setStart THEN $startTz ELSE start_tz END,
          parent_card_id = CASE WHEN $setPlacement THEN $parentId ELSE parent_card_id END,
          level = CASE WHEN $setPlacement THEN $level ELSE level END,
          sprint_id = CASE WHEN $setSprint THEN $sprintId ELSE sprint_id END,
          estimate = CASE WHEN $setEstimate THEN $estimate ELSE estimate END,
          priority = CASE WHEN $setPriority THEN $priority ELSE priority END,
          revision = revision + 1, updated_at = $timestamp
        WHERE id = $cardId AND revision = $revision AND deleted_at IS NULL`).run({
        title: input.title ?? null,
        description: input.description ?? null,
        // Every description write refreshes the excerpt (D111).
        excerpt: input.description === undefined ? null : descriptionExcerpt(input.description),
        setDue: due ? 1 : 0,
        dueOn: due?.value.due_on ?? null,
        dueTime: due?.value.due_time ?? null,
        dueTz: due?.value.due_tz ?? null,
        setStart: start ? 1 : 0,
        startOn: start?.value.start_on ?? null,
        startTime: start?.value.start_time ?? null,
        startTz: start?.value.start_tz ?? null,
        setPlacement: placement ? 1 : 0,
        parentId: placement?.parentId ?? null,
        level: placement?.level ?? 0,
        setSprint: sprint.set ? 1 : 0,
        sprintId: sprint.id,
        setEstimate: estimate === undefined ? 0 : 1,
        estimate: estimate ?? null,
        setPriority: priority === undefined ? 0 : 1,
        priority: priority ?? null,
        timestamp,
        cardId,
        revision: input.revision
      });
      if (updated.changes !== 1) throw new Error("Concurrent card update detected");
      const changed = assignees ? replaceAssignees(cardId, assignees, userId, timestamp) : null;
      const tagsChanged = tagIds ? replaceCardTags(cardId, tagIds, timestamp) : null;
      const flagsChanged = flags ? replaceCardFlags(cardId, flags, timestamp) : null;
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
      // Card history (lane ACTIVITY): every field this patch changed, in the same transaction.
      recordSnapshotChanges(cardId, userId, before, cardActivitySnapshot(cardId)!, timestamp);
      if (input.description !== undefined && input.description !== card.description) {
        recordCardActivity({ cardId, boardId: board.id, actorId: userId, kind: "description", at: timestamp });
        // @mentions the save adds (docs/plan/MENTIONS.md D1326, D1334): compared with the stored description.
        recordCardMentions({ cardId, boardId: board.id, authorId: userId, text: input.description, before: card.description, where: "description", at: timestamp });
      }
      if (changed) recordCardItems(cardId, board.id, userId, { added: "assignee_added", removed: "assignee_removed" }, changed, activityValue.user, timestamp);
      if (tagsChanged) recordCardItems(cardId, board.id, userId, { added: "tag_added", removed: "tag_removed" }, tagsChanged, activityValue.tag, timestamp);
      if (flagsChanged) recordCardItems(cardId, board.id, userId, { added: "flag_set", removed: "flag_cleared" }, flagsChanged, activityValue.flag, timestamp);
      audit(userId, null, "task.card_update", {
        boardId: board.id, cardId,
        ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
        ...(due?.timeChange ? { dueTime: due.timeChange } : {}),
        ...(input.startOn !== undefined ? { startOn: input.startOn } : {}),
        ...(start?.timeChange ? { startTime: start.timeChange } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(changed ? { assigneesAdded: changed.added.length, assigneesRemoved: changed.removed.length } : {}),
        ...(tagsChanged ? { tagsAdded: tagsChanged.added.length, tagsRemoved: tagsChanged.removed.length } : {}),
        ...(flags ? { flags } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(sprintChanged ? { sprintId: sprint.id } : {}),
        ...(estimate !== undefined ? { estimate } : {})
      });
      if (reparented) audit(userId, null, "task.card_reparent", { boardId: board.id, cardId, parentId: placement.parentId });
      if (releveled) audit(userId, null, "task.card_level", { boardId: board.id, cardId, level: placement.level });
    })();
    return { card: cardDetail(cardId)! };
  });
}

/**
 * Moves a card within its board (cross-board moves are out of scope).
 * `afterCardId` null puts the card at the top and omitted at the bottom; otherwise it must be another
 * live card in the target column, or the response is 409 STALE_POSITION with
 * the column's current order. Moves do not change `revision`.
 */
export async function moveCard(userId: string, cardId: string, input: { columnId: string; afterCardId?: string | null }) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    const { card } = requireCardAt(cardId, userId, "edit");
    const column = requireBoardColumn(board.id, input.columnId);
    if (card.column_id !== column.id) requireColumnRoom(column);
    // Another column unarchives the card (D605), so it needs room under the cap again (D632).
    if (card.column_id !== column.id && card.archived_at) requireBoardRoom(board.id, { active: 1, total: 0 });
    if (input.afterCardId === cardId) throw stalePosition(input.columnId);
    const siblings = liveCardsIn(input.columnId).filter((card) => card.id !== cardId);
    const plan = planInsert(siblings, input.afterCardId);
    if (!plan) throw stalePosition(input.columnId);
    db.transaction(() => {
      applyRenumber("cards", plan.renumbered);
      const timestamp = now();
      if (card.column_id === input.columnId) {
        db.query("UPDATE cards SET position = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(plan.position, timestamp, cardId);
      } else {
        // Another column (D603, D605): the done clock keeps running between two done columns, starts
        // on coming into one, and stops on leaving; any archive is undone (the card is back in view).
        const fromDone = (db.query("SELECT state FROM board_columns WHERE id = ?").get(card.column_id) as { state: ColumnState } | null)?.state === "done";
        db.query(`UPDATE cards SET column_id = $columnId, position = $position, updated_at = $timestamp, archived_at = NULL,
            done_at = CASE WHEN NOT $toDone THEN NULL WHEN $fromDone AND done_at IS NOT NULL THEN done_at ELSE $timestamp END
          WHERE id = $cardId AND deleted_at IS NULL`).run({ columnId: input.columnId, position: plan.position, timestamp, cardId, toDone: column.state === "done" ? 1 : 0, fromDone: fromDone ? 1 : 0 });
        recordCardChange(cardId, board.id, userId, "column", activityValue.column(card.column_id), activityValue.column(column.id), timestamp);
      }
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
      audit(userId, null, "task.card_move", { boardId: board.id, cardId, columnId: input.columnId });
    })();
    return {
      card: cardDetail(cardId)!,
      ...(plan.renumbered ? { renormalized: true, positions: liveCardsIn(input.columnId) } : {})
    };
  });
}

/**
 * The column a lane drop or MCP `move_card { state | columnName }` means on the card's own board
 * (lane VIEWS, D641, D642, D645): the first column of that state, or the first whose name folds to
 * the same text (case and accents), by position. Edit level, as the move itself; a board without
 * one is 400 `NO_SUCH_COLUMN`.
 */
export function columnForMove(userId: string, cardId: string, target: { state?: ColumnState; columnName?: string }) {
  const { board } = requireCardAt(cardId, userId, "edit");
  const columns = listColumns(board.id);
  const name = target.columnName === undefined ? null : foldText(target.columnName.trim());
  const found = target.state ? columns.find((column) => column.state === target.state) : columns.find((column) => foldText(column.name.trim()) === name);
  if (!found) {
    throw new TaskError(400, target.state ? `This card's board has no column in the ${target.state} state` : "This card's board has no column with that name", "NO_SUCH_COLUMN");
  }
  return found.id;
}

/**
 * Moves a card to the Bin (any reader, D41). Stage A sets the Bin columns
 * only; the card keeps its column so a later restore can put it back.
 */
export async function deleteCard(userId: string, cardId: string) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    requireCardAt(cardId, userId, "edit");
    const deletedAt = new Date();
    const purgeAfter = purgeAfterFrom(deletedAt);
    const descendantCount = db.transaction(() => {
      db.query("UPDATE cards SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL")
        .run(deletedAt.toISOString(), userId, purgeAfter, cardId);
      // Its live children and grandchildren go with it, tagged with the root, so the Bin lists one
      // item and one restore brings the tree back (D129). Depth is at most 2, so no recursion.
      const descendants = db.query(`UPDATE cards SET deleted_at = $deletedAt, deleted_by = $userId, purge_after = $purgeAfter, bin_root_id = $cardId
        WHERE deleted_at IS NULL AND board_id = $boardId AND (parent_card_id = $cardId
          OR parent_card_id IN (SELECT c.id FROM cards c WHERE c.parent_card_id = $cardId AND c.bin_root_id = $cardId))`);
      // Children first (they then carry the root), then their children.
      let count = descendants.run({ deletedAt: deletedAt.toISOString(), userId, purgeAfter, cardId, boardId: board.id }).changes;
      count += descendants.run({ deletedAt: deletedAt.toISOString(), userId, purgeAfter, cardId, boardId: board.id }).changes;
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(deletedAt.toISOString(), board.id);
      recordCardActivity({ cardId, boardId: board.id, actorId: userId, kind: "binned", payload: count ? { count } : {}, at: deletedAt.toISOString() });
      audit(userId, null, "task.card_delete", { boardId: board.id, cardId, ...(count ? { descendantCount: count } : {}) });
      return count;
    })();
    return { ok: true as const, purgeAfter, descendantCount };
  });
}
