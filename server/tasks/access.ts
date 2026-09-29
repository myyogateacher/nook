import { db } from "../db";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { groupGrantExists } from "../access/groups";
import { audienceLevel, type ItemLevel, type Level } from "../access/levels";
import { audienceLevels } from "../access/batchLevels";

export type BoardVisibility = "private" | "selected" | "all_users";

export type BoardRow = {
  id: string;
  owner_id: string;
  name: string;
  visibility: BoardVisibility;
  /** The `all_users` audience level (migration 025, D272); `edit` keeps D38 for existing boards. */
  share_role: "view" | "comment" | "edit";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

/**
 * Whether `$userId` may read live board `b` (WAVES_7-9.md §3.2): the owner,
 * everyone for `all_users`, or a member row for `selected`. Readers are
 * members in the D38 sense: they may create, edit, move, and bin cards.
 * Binned boards never match.
 */
export const readableBoardPredicate = `(
  b.deleted_at IS NULL AND (b.owner_id = $userId OR (b.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
    OR (b.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $userId)
      OR ${groupGrantExists("board", "b.id")})))
)`;

/**
 * Readers who may change cards (D272): the owner, a member or group at `edit` or `manage`, or
 * everyone on an `all_users` board whose audience level is `edit`. The Team role cap is applied in
 * TS (boardLevel); the write gate refuses viewers and guests before any of this runs.
 */
export const editableBoardPredicate = `(
  b.deleted_at IS NULL AND (b.owner_id = $userId OR (b.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS} AND b.share_role = 'edit')
    OR (b.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $userId AND m.level IN ('edit','manage'))
      OR ${groupGrantExists("board", "b.id", "$userId", ["edit", "manage"])})))
)`;

/**
 * The caller's live level on a board (§D.3, §C.9): owner, or the best of their member row, their
 * groups, and the `all_users` level, capped by the Team role. `none` for a binned board.
 */
export function boardLevel(board: Pick<BoardRow, "id" | "owner_id" | "visibility" | "share_role" | "deleted_at">, userId: string): ItemLevel {
  if (board.deleted_at) return "none";
  return audienceLevel({ kind: "board", id: board.id, ownerId: board.owner_id, visibility: board.visibility, audienceLevel: board.share_role as Level, memberTable: "board_members", memberColumn: "board_id" }, userId);
}

/** boardLevel for a page of live boards in a constant number of queries (C10); same results, by id. */
export function boardLevels(boards: ReadonlyArray<Pick<BoardRow, "id" | "owner_id" | "visibility" | "share_role">>, userId: string) {
  return audienceLevels(boards.map((board) => ({ kind: "board" as const, id: board.id, ownerId: board.owner_id, visibility: board.visibility, audienceLevel: board.share_role as Level, memberTable: "board_members", memberColumn: "board_id" })), userId);
}

export function readableBoard(boardId: string, userId: string) {
  return db.query(`SELECT b.* FROM boards b WHERE b.id = $boardId AND ${readableBoardPredicate}`).get({ boardId, userId }) as BoardRow | null;
}

export type ColumnState = "todo" | "doing" | "done";

/** `state` is the normalized workflow state (migration 020, D141); the service keeps `is_done = (state = 'done')`. */
export type ColumnRow = { id: string; board_id: string; name: string; position: number; is_done: 0 | 1; state: ColumnState; wip_limit: number | null; created_at: string; updated_at: string };

/** A column joined to a board the caller can read (path ids are always joined to their board, T39). */
export function readableColumn(columnId: string, userId: string) {
  const column = db.query(`SELECT c.* FROM board_columns c JOIN boards b ON b.id = c.board_id WHERE c.id = $columnId AND ${readableBoardPredicate}`)
    .get({ columnId, userId }) as ColumnRow | null;
  if (!column) return null;
  return { column, board: readableBoard(column.board_id, userId)! };
}

export type CardRow = {
  id: string;
  board_id: string;
  column_id: string | null;
  position: number;
  title: string;
  description: string;
  revision: number;
  created_by: string | null;
  due_on: string | null;
  /** Migration 015 (D100). */
  due_time: string | null;
  due_tz: string | null;
  /** Legacy mirror of the first assignee (D102); read `card_assignees` instead. */
  assignee_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

/** A live card on a board the caller can read. */
export function readableCard(cardId: string, userId: string) {
  const card = db.query(`SELECT k.* FROM cards k JOIN boards b ON b.id = k.board_id WHERE k.id = $cardId AND k.deleted_at IS NULL AND ${readableBoardPredicate}`)
    .get({ cardId, userId }) as CardRow | null;
  if (!card) return null;
  return { card, board: readableBoard(card.board_id, userId)! };
}
