import { db } from "../db";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { groupGrantExists } from "../access/groups";

export type BoardVisibility = "private" | "selected" | "all_users";

export type BoardRow = {
  id: string;
  owner_id: string;
  name: string;
  visibility: BoardVisibility;
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
