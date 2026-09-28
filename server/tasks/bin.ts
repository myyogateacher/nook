import { audit, db, now } from "../db";
import { binUnlinkedAttachments, cardAttachmentIds } from "./attachments";
import { planInsert } from "./boardOrder";
import { applyRenumber, LIMITS, liveCardsIn, withBoardLock } from "./service";
import { liveChildCount } from "./hierarchy";
import { HIERARCHY_LIMITS } from "../../shared/boardStructure";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { groupGrantExists } from "../access/groups";
import { atLeast } from "../access/levels";
import { boardLevel, type BoardRow } from "./access";

/**
 * Cards and boards in the shared Bin (WAVES_7-9.md D41 and §3.3). Deleting only sets the Bin
 * columns (service.ts). Here:
 *
 * - Listing: a binned board for its owner; a binned card for the board owner and for the member
 *   who deleted it, while that member can still open the board.
 * - Restore: compare-and-swap under the board lock, by the board owner or the card's deleter. A
 *   card whose column was deleted returns to the first column, at the bottom; Undo may ask for its
 *   old column and neighbour, honoured while both are still there. A card on a binned
 *   board is refused with BOARD_IN_BIN.
 * - Purge: board owner only (and the sweeper). Cards and boards have no bytes, so the tombstone and
 *   the delete share one transaction. Attachments that lose their last link move to their
 *   uploader's Bin (director review §7).
 * - Subtrees (research 2026-09-26 D129, D130, T114): binning a card bins its live descendants,
 *   tagged `bin_root_id = <root>`. Only roots are Bin items (listed with `descendant_count`);
 *   restoring the root restores exactly its group, and purging it purges the group. A descendant
 *   binned on its own first is its own root and keeps its entry. A root restored while its parent
 *   is binned (or gone), or under a parent that already has 100 children, comes back detached.
 */
export type TaskBinType = "card" | "board";
export const isTaskBinType = (type: string): type is TaskBinType => type === "card" || type === "board";

export type TaskBinRow = {
  type: TaskBinType;
  id: string;
  title: string;
  board_id: string;
  board_name: string;
  deleted_at: string;
  purge_after: string;
  purging: boolean;
  can_purge: boolean;
  /** Cards: how many descendants were binned with it and come back with it (D129); 0 for boards. */
  descendant_count: number;
};

type CardBinRow = {
  id: string; board_id: string; column_id: string | null; title: string; deleted_at: string | null; deleted_by: string | null; purge_started_at: string | null;
  parent_card_id: string | null; bin_root_id: string | null; level: number;
};
type BoardBinRow = { id: string; owner_id: string; name: string; visibility: string; deleted_at: string | null; purge_started_at: string | null };

/** The board's audience ignoring whether it is binned: owner, all_users, or a member row. */
const boardAudience = `(b.owner_id = $userId OR (b.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (b.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $userId)
    OR ${groupGrantExists("board", "b.id")})))`;

/**
 * `dueBy` lists only items not being purged whose `purge_after` is at or before it, soonest
 * first (Today's `binSoon`); otherwise newest deletion first.
 */
export function listTaskBin(userId: string, type: TaskBinType | null, limit: number, options: { dueBy?: string } = {}): TaskBinRow[] {
  const rows: Array<Omit<TaskBinRow, "purging" | "can_purge" | "descendant_count"> & { purging: number; can_purge: number; descendant_count?: number }> = [];
  const due = (alias: string) => options.dueBy === undefined ? "" : ` AND ${alias}.purge_started_at IS NULL AND ${alias}.purge_after <= $dueBy`;
  const order = (alias: string) => options.dueBy === undefined ? `${alias}.deleted_at DESC, ${alias}.id` : `${alias}.purge_after, ${alias}.id`;
  const params = { userId, limit, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) };
  if (type !== "board") {
    rows.push(...db.query(`SELECT 'card' AS type, k.id, k.title, b.id AS board_id, b.name AS board_name, k.deleted_at, k.purge_after,
        k.purge_started_at IS NOT NULL AS purging, CASE WHEN b.owner_id = $userId THEN 1 ELSE 0 END AS can_purge,
        (SELECT COUNT(*) FROM cards d WHERE d.bin_root_id = k.id AND d.deleted_at IS NOT NULL) AS descendant_count
      FROM cards k JOIN boards b ON b.id = k.board_id
      WHERE k.deleted_at IS NOT NULL AND k.bin_root_id IS NULL
        AND (b.owner_id = $userId OR (k.deleted_by = $userId AND b.deleted_at IS NULL AND ${boardAudience}))${due("k")}
      ORDER BY ${order("k")} LIMIT $limit`).all(params) as typeof rows);
  }
  if (type !== "card") {
    rows.push(...db.query(`SELECT 'board' AS type, b.id, b.name AS title, b.id AS board_id, b.name AS board_name, b.deleted_at, b.purge_after,
        b.purge_started_at IS NOT NULL AS purging, 1 AS can_purge
      FROM boards b WHERE b.owner_id = $userId AND b.deleted_at IS NOT NULL${due("b")}
      ORDER BY ${order("b")} LIMIT $limit`).all(params) as typeof rows);
  }
  return rows.map((row) => ({ ...row, purging: row.purging === 1, can_purge: row.can_purge === 1, descendant_count: row.descendant_count ?? 0 }));
}

export type TaskRestoreOutcome =
  | {
      status: "restored" | "already_restored"; boardId: string; boardName: string; columnId: string | null; columnName: string | null;
      /** Cards restored with it (its Bin group, D129). */
      descendantCount?: number;
      /** Its parent is in the Bin or gone, so it came back without one (D130). */
      detached?: boolean;
    }
  | { status: "purging" | "not_found" | "board_in_bin" | "limit" };

const boardOfCard = (cardId: string) => (db.query("SELECT board_id FROM cards WHERE id = ?").get(cardId) as { board_id: string } | null)?.board_id ?? null;

function cardAccess(cardId: string, userId: string) {
  return db.query(`SELECT k.id, k.board_id, k.column_id, k.title, k.deleted_at, k.deleted_by, k.purge_started_at, k.parent_card_id, k.bin_root_id, k.level,
      b.owner_id, b.name AS board_name, b.deleted_at AS board_deleted_at
    FROM cards k JOIN boards b ON b.id = k.board_id
    WHERE k.id = $cardId AND (b.owner_id = $userId OR ((k.deleted_by = $userId OR k.deleted_at IS NULL) AND ${boardAudience}))`).get({ cardId, userId }) as
    (CardBinRow & { owner_id: string; board_name: string; board_deleted_at: string | null }) | null;
}

function columnName(columnId: string | null) {
  return columnId ? (db.query("SELECT name FROM board_columns WHERE id = ?").get(columnId) as { name: string } | null)?.name ?? null : null;
}

/** Where a restored card should go: its old column and neighbour, as the Undo toast remembers them. */
export type CardRestorePlace = { columnId?: string; afterCardId?: string | null };

export async function restoreTaskItem(type: TaskBinType, id: string, userId: string, place: CardRestorePlace = {}): Promise<TaskRestoreOutcome> {
  const boardId = type === "board" ? id : boardOfCard(id);
  if (!boardId) return { status: "not_found" };
  return withBoardLock(boardId, (): TaskRestoreOutcome => {
    if (type === "board") {
      const board = db.query("SELECT id, owner_id, name, visibility, deleted_at, purge_started_at FROM boards WHERE id = ? AND owner_id = ?").get(id, userId) as BoardBinRow | null;
      if (!board) return { status: "not_found" };
      if (board.purge_started_at) return { status: "purging" };
      if (!board.deleted_at) return { status: "already_restored", boardId: id, boardName: board.name, columnId: null, columnName: null };
      const live = (db.query("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
      if (live >= LIMITS.boardsPerOwner) return { status: "limit" };
      return db.transaction((): TaskRestoreOutcome => {
        const restored = db.query("UPDATE boards SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL")
          .run(now(), id);
        if (restored.changes !== 1) return { status: "purging" };
        audit(userId, null, "task.board_restore", { boardId: id });
        return { status: "restored", boardId: id, boardName: board.name, columnId: null, columnName: null };
      })();
    }
    const card = cardAccess(id, userId);
    // A card binned with its root is not a Bin item of its own: it comes back with the root (D129).
    if (!card || (card.deleted_at && card.bin_root_id)) return { status: "not_found" };
    if (card.purge_started_at) return { status: "purging" };
    if (!card.deleted_at) return { status: "already_restored", boardId: card.board_id, boardName: card.board_name, columnId: card.column_id, columnName: columnName(card.column_id) };
    if (card.board_deleted_at) return { status: "board_in_bin" };
    // A deleter whose level dropped below edit since (D272) can no longer put cards back.
    const liveBoard = db.query("SELECT * FROM boards WHERE id = ?").get(card.board_id) as BoardRow;
    if (!atLeast(boardLevel(liveBoard, userId), "edit")) return { status: "not_found" };
    const members = db.query(`SELECT k.id, k.column_id FROM cards k LEFT JOIN board_columns col ON col.id = k.column_id
      WHERE k.bin_root_id = ? AND k.deleted_at IS NOT NULL ORDER BY col.position, k.position, k.id`).all(id) as Array<{ id: string; column_id: string | null }>;
    const live = (db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND deleted_at IS NULL").get(card.board_id) as { count: number }).count;
    if (live + 1 + members.length > LIMITS.liveCardsPerBoard) return { status: "limit" };
    // Restore never fails for a missing parent: it comes back detached (D130).
    const parentLive = card.parent_card_id
      ? Boolean(db.query("SELECT 1 FROM cards WHERE id = ? AND board_id = ? AND deleted_at IS NULL").get(card.parent_card_id, card.board_id))
      : false;
    // Detached (D130) when the parent is binned, when it was purged (the FK already set the parent to
    // NULL, so a child-level card has none), or when the live parent already has the most children
    // (D135): it keeps its level with no parent, which the 019 triggers allow, rather than failing.
    const detached = card.parent_card_id === null
      ? card.level > 0
      : !parentLive || liveChildCount(card.parent_card_id) >= HIERARCHY_LIMITS.childrenPerCard;
    // The requested column when it is on this board, else its own column if it still exists, else
    // the first one. After the requested neighbour when it is still live there, else at the bottom.
    const boardColumn = (columnId: string | null | undefined) => (columnId ? db.query("SELECT id, name FROM board_columns WHERE id = ? AND board_id = ?").get(columnId, card.board_id) : null) as { id: string; name: string } | null;
    const requested = boardColumn(place.columnId);
    const column = requested ?? boardColumn(card.column_id)
      ?? db.query("SELECT id, name FROM board_columns WHERE board_id = ? ORDER BY position, id LIMIT 1").get(card.board_id) as { id: string; name: string } | null;
    if (!column) return { status: "not_found" };
    const siblings = liveCardsIn(column.id);
    const anchor = requested && place.afterCardId !== undefined && place.afterCardId !== id ? place.afterCardId : undefined;
    const plan = planInsert(siblings, anchor) ?? planInsert(siblings, undefined)!;
    return db.transaction((): TaskRestoreOutcome => {
      applyRenumber("cards", plan.renumbered);
      const timestamp = now();
      const restored = db.query(`UPDATE cards SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, column_id = ?, position = ?, updated_at = ?,
          parent_card_id = CASE WHEN ? THEN NULL ELSE parent_card_id END
        WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`).run(column.id, plan.position, timestamp, detached ? 1 : 0, id);
      if (restored.changes !== 1) return { status: "purging" };
      // The group comes back in its old columns (or the first one), at the bottom, in its old order.
      const firstColumn = db.query("SELECT id FROM board_columns WHERE board_id = ? ORDER BY position, id LIMIT 1").get(card.board_id) as { id: string };
      const restoreMember = db.query(`UPDATE cards SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, bin_root_id = NULL, column_id = ?, position = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NOT NULL`);
      for (const member of members) {
        const target = boardColumn(member.column_id)?.id ?? firstColumn.id;
        const place = planInsert(liveCardsIn(target), undefined)!;
        applyRenumber("cards", place.renumbered);
        restoreMember.run(target, place.position, timestamp, member.id);
      }
      audit(userId, null, "task.card_restore", { boardId: card.board_id, cardId: id, columnId: column.id, ...(members.length ? { descendantCount: members.length } : {}), ...(detached ? { detached: true } : {}) });
      return {
        status: "restored", boardId: card.board_id, boardName: card.board_name, columnId: column.id, columnName: column.name,
        ...(members.length ? { descendantCount: members.length } : {}), ...(detached ? { detached: true } : {})
      };
    })();
  });
}

export type TaskPurgeReason = "user" | "retention";

/**
 * Deletes a binned card or board and everything under it. Call under the board lock. `dueBy`
 * re-checks retention for the sweeper (an item restored and binned again since its snapshot
 * survives). Returns false when there was nothing to purge.
 */
export function purgeTaskLocked(type: TaskBinType, id: string, options: { actorId: string | null; reason: TaskPurgeReason; dueBy?: string }) {
  const table = type === "card" ? "cards" : "boards";
  const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
  return db.transaction(() => {
    const marked = db.query(`UPDATE ${table} SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return false;
    const boardId = type === "board" ? id : boardOfCard(id)!;
    // A card's Bin group goes with it (D129): its descendants first, then the root.
    const members = type === "card"
      ? (db.query("SELECT id FROM cards WHERE bin_root_id = ? AND deleted_at IS NOT NULL ORDER BY level DESC, id").all(id) as Array<{ id: string }>).map((row) => row.id)
      : [];
    const documentIds = type === "card"
      ? [...new Set([id, ...members].flatMap((cardId) => cardAttachmentIds({ cardId })))]
      : cardAttachmentIds({ boardId: id });
    const removeMember = db.query("DELETE FROM cards WHERE id = ? AND deleted_at IS NOT NULL");
    // Deepest first, so no delete detaches a card that is about to go too.
    for (const memberId of members) removeMember.run(memberId);
    db.query(`DELETE FROM ${table} WHERE id = ? AND purge_started_at IS NOT NULL`).run(id);
    binUnlinkedAttachments(documentIds, options.actorId);
    audit(options.actorId, null, `task.${type}_purge`, type === "card"
      ? { boardId, cardId: id, reason: options.reason, ...(members.length ? { descendantCount: members.length } : {}) }
      : { boardId, reason: options.reason });
    return true;
  })();
}

export type TaskPurgeOutcome = "purged" | "not_found" | "live" | "owner_only";

/** Delete forever: the board owner only. The card's deleter sees the row but gets OWNER_ONLY. */
export async function purgeTaskItem(type: TaskBinType, id: string, userId: string): Promise<TaskPurgeOutcome> {
  const boardId = type === "board" ? id : boardOfCard(id);
  if (!boardId) return "not_found";
  return withBoardLock(boardId, (): TaskPurgeOutcome => {
    if (type === "board") {
      const board = db.query("SELECT deleted_at FROM boards WHERE id = ? AND owner_id = ?").get(id, userId) as { deleted_at: string | null } | null;
      if (!board) return "not_found";
      if (!board.deleted_at) return "live";
    } else {
      const card = cardAccess(id, userId);
      if (!card || (card.deleted_at && card.bin_root_id)) return "not_found";
      if (!card.deleted_at) return "live";
      if (card.owner_id !== userId) return "owner_only";
    }
    return purgeTaskLocked(type, id, { actorId: userId, reason: "user" }) ? "purged" : "not_found";
  });
}

/** Empty Bin: the caller's binned boards and the binned cards on boards they own. */
export async function emptyTaskBin(ownerId: string) {
  let purged = 0;
  const cards = db.query("SELECT k.id, k.board_id FROM cards k JOIN boards b ON b.id = k.board_id WHERE b.owner_id = ? AND k.deleted_at IS NOT NULL AND k.bin_root_id IS NULL").all(ownerId) as Array<{ id: string; board_id: string }>;
  for (const card of cards) {
    if (await withBoardLock(card.board_id, () => purgeTaskLocked("card", card.id, { actorId: ownerId, reason: "user" }))) purged += 1;
  }
  const boards = db.query("SELECT id FROM boards WHERE owner_id = ? AND deleted_at IS NOT NULL").all(ownerId) as Array<{ id: string }>;
  for (const board of boards) {
    if (await withBoardLock(board.id, () => purgeTaskLocked("board", board.id, { actorId: ownerId, reason: "user" }))) purged += 1;
  }
  return purged;
}

/** Sweeper step for cards and boards whose 30 days have passed (bounded per run, like notes and documents). */
export async function sweepTaskBin(cutoff: string, batchSize: number) {
  let purged = 0;
  // Roots only: a group member is purged with its root (D129).
  const cards = db.query("SELECT id, board_id FROM cards WHERE deleted_at IS NOT NULL AND bin_root_id IS NULL AND (purge_started_at IS NOT NULL OR purge_after <= ?) ORDER BY purge_after LIMIT ?").all(cutoff, batchSize) as Array<{ id: string; board_id: string }>;
  for (const card of cards) {
    if (await withBoardLock(card.board_id, () => purgeTaskLocked("card", card.id, { actorId: null, reason: "retention", dueBy: cutoff }))) purged += 1;
  }
  const boards = db.query("SELECT id FROM boards WHERE deleted_at IS NOT NULL AND (purge_started_at IS NOT NULL OR purge_after <= ?) ORDER BY purge_after LIMIT ?").all(cutoff, batchSize) as Array<{ id: string }>;
  for (const board of boards) {
    if (await withBoardLock(board.id, () => purgeTaskLocked("board", board.id, { actorId: null, reason: "retention", dueBy: cutoff }))) purged += 1;
  }
  return purged;
}
