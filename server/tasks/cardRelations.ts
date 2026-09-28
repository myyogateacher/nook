import { audit, db, now } from "../db";
import { relationTypeFor, storedRelation, type RelationKind, type RelationType, type StoredRelation } from "./relations";
import { getBoard, limitReached, requireCardAt, requireReadableCard, TaskError, withBoardLock } from "./service";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { groupGrantExists } from "../access/groups";

/**
 * Typed card relations (WAVE_13_TASK_CARD_UX.md D104–D107, §3.2, T90, T91).
 *
 * Relations are edges, not fields (D107): they have their own endpoints and never change either
 * card's `revision` or `updated_at`. Creating one needs read access to both cards; unknown,
 * binned, and unreadable targets all get the same 404, and RELATION_EXISTS is only evaluated once
 * both cards are known to be readable. Each relation resolves per viewer on read (D105):
 *
 * - the other card is readable: `{ restricted: false, card: {…} }`
 * - the viewer is not in the other board's audience: `{ restricted: true }` with no card id,
 *   title, board, or creator, whether or not that card or board is binned (binning is never
 *   disclosed)
 * - the viewer is in the audience but the card or its board is in the Bin: hidden until restored
 *
 * Rows are never removed by binning, so a restore brings them back; a purge cascades
 * (ON DELETE CASCADE, migration 015).
 */

export const MAX_RELATIONS_PER_CARD = 50;

export type CardRelation =
  | {
      id: string; type: RelationType; restricted: false; created_at: string; creator_name: string | null;
      card: { id: string; board_id: string; board_name: string; title: string; column_name: string | null; is_done: 0 | 1; due_on: string | null };
    }
  | { id: string; type: RelationType; restricted: true; created_at: string };

/** The other board's audience for `$userId`, ignoring whether it is binned (alias `ob`). */
const otherAudience = `(ob.owner_id = $userId OR (ob.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (ob.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = ob.id AND m.user_id = $userId)
    OR ${groupGrantExists("board", "ob.id")})))`;

type RelationRow = {
  id: string; source_card_id: string; target_card_id: string; kind: RelationKind; created_at: string; creator_name: string | null;
  other_id: string; other_deleted_at: string | null; title: string; due_on: string | null;
  board_id: string; board_name: string; board_deleted_at: string | null; column_name: string | null; is_done: 0 | 1 | null;
  in_audience: 0 | 1;
};

const relationSelect = `
  SELECT r.id, r.source_card_id, r.target_card_id, r.kind, r.created_at, u.display_name AS creator_name,
         o.id AS other_id, o.deleted_at AS other_deleted_at, o.title, o.due_on,
         ob.id AS board_id, ob.name AS board_name, ob.deleted_at AS board_deleted_at,
         oc.name AS column_name, oc.is_done,
         CASE WHEN ${otherAudience} THEN 1 ELSE 0 END AS in_audience
  FROM card_relations r
  JOIN cards o ON o.id = CASE WHEN r.source_card_id = $cardId THEN r.target_card_id ELSE r.source_card_id END
  JOIN boards ob ON ob.id = o.board_id
  LEFT JOIN board_columns oc ON oc.id = o.column_id
  LEFT JOIN users u ON u.id = r.created_by
`;

const stored = (row: Pick<RelationRow, "source_card_id" | "target_card_id" | "kind">): StoredRelation =>
  ({ source: row.source_card_id, target: row.target_card_id, kind: row.kind });

/** One row as `cardId`'s viewer sees it, or null when it is hidden (a readable card in the Bin). */
function resolveRow(row: RelationRow, cardId: string): CardRelation | null {
  const type = relationTypeFor(stored(row), cardId);
  if (!row.in_audience) return { id: row.id, type, restricted: true, created_at: row.created_at };
  if (row.other_deleted_at || row.board_deleted_at) return null;
  return {
    id: row.id, type, restricted: false, created_at: row.created_at, creator_name: row.creator_name,
    card: { id: row.other_id, board_id: row.board_id, board_name: row.board_name, title: row.title, column_name: row.column_name, is_done: row.is_done ? 1 : 0, due_on: row.due_on }
  };
}

/**
 * The relations of a card the caller has already been authorized to read, newest first. At most
 * 50 rows exist per card (both ends are capped), so nothing is cut off. Two relations made in the
 * same millisecond share `created_at`; rowid (insertion order) breaks the tie, not the random id.
 */
export function listRelations(userId: string, cardId: string): CardRelation[] {
  const rows = db.query(`${relationSelect} WHERE r.source_card_id = $cardId OR r.target_card_id = $cardId
    ORDER BY r.created_at DESC, r.rowid DESC LIMIT ${MAX_RELATIONS_PER_CARD}`).all({ cardId, userId }) as RelationRow[];
  return rows.map((row) => resolveRow(row, cardId)).filter((relation): relation is CardRelation => relation !== null);
}

function relationFor(userId: string, cardId: string, relationId: string) {
  const row = db.query(`${relationSelect} WHERE r.id = $relationId AND (r.source_card_id = $cardId OR r.target_card_id = $cardId)`)
    .get({ cardId, userId, relationId }) as RelationRow | null;
  return row;
}

const relationCount = (cardId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM card_relations WHERE source_card_id = ?1 OR target_card_id = ?1").get(cardId) as { count: number }).count;

const pairRelationId = (a: string, b: string) =>
  (db.query("SELECT id FROM card_relations WHERE min(source_card_id, target_card_id) = min(?1, ?2) AND max(source_card_id, target_card_id) = max(?1, ?2)")
    .get(a, b) as { id: string } | null)?.id ?? null;

const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/**
 * Inserts one relation from `cardId` toward `otherCardId`, inside the caller's transaction and
 * under `cardId`'s board lock. The caller has checked that `cardId` is readable; this checks the
 * other card (404 like a missing id), then the pair (409 RELATION_EXISTS with the existing relation
 * seen from `cardId`), then the cap on both ends (409 LIMIT_REACHED). bun:sqlite transactions are
 * synchronous, so the checks and the insert cannot interleave with another request; the unique
 * pair index is the backstop.
 */
export function insertRelation(userId: string, cardId: string, otherCardId: string, type: RelationType) {
  if (cardId === otherCardId) throw new TaskError(400, "A card cannot relate to itself");
  const other = requireReadableCard(otherCardId, userId);
  const existing = pairRelationId(cardId, otherCardId);
  if (existing) {
    throw new TaskError(409, "These cards are already related", "RELATION_EXISTS", { relation: resolveRow(relationFor(userId, cardId, existing)!, cardId) });
  }
  for (const end of [cardId, otherCardId]) {
    if (relationCount(end) >= MAX_RELATIONS_PER_CARD) throw limitReached(`A card can have up to ${MAX_RELATIONS_PER_CARD} relations`);
  }
  const row = storedRelation(type, cardId, otherCardId);
  const id = crypto.randomUUID();
  try {
    db.query("INSERT INTO card_relations (id, source_card_id, target_card_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, row.source, row.target, row.kind, userId, now());
  } catch (error) {
    if (isUniqueViolation(error)) throw new TaskError(409, "These cards are already related", "RELATION_EXISTS");
    throw error;
  }
  return { id, kind: row.kind, otherBoardId: other.board.id };
}

/** POST /cards/:k/relations: 201 `{ relation }`, seen from `k`. Never changes either card's revision. */
export async function createRelation(userId: string, cardId: string, input: { type: RelationType; cardId: string }) {
  const { board } = requireCardAt(cardId, userId, "edit");
  if (input.cardId === cardId) throw new TaskError(400, "A card cannot relate to itself");
  return withBoardLock(board.id, () => {
    requireCardAt(cardId, userId, "edit");
    const created = db.transaction(() => {
      const inserted = insertRelation(userId, cardId, input.cardId, input.type);
      audit(userId, null, "task.relation_create", { boardId: board.id, cardId, relationId: inserted.id, kind: inserted.kind });
      return inserted;
    })();
    return { relation: resolveRow(relationFor(userId, cardId, created.id)!, cardId)! };
  });
}

/**
 * DELETE /cards/:k/relations/:r: any reader of `k`, when `k` is one end of `r` (404 otherwise, T91).
 * A restricted relation may be removed too: it is metadata on the caller's own card.
 */
export async function deleteRelation(userId: string, cardId: string, relationId: string) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    requireCardAt(cardId, userId, "edit");
    const row = db.query("SELECT id, kind FROM card_relations WHERE id = ?1 AND (source_card_id = ?2 OR target_card_id = ?2)").get(relationId, cardId) as
      { id: string; kind: RelationKind } | null;
    if (!row) throw new TaskError(404, "Relation not found");
    db.transaction(() => {
      db.query("DELETE FROM card_relations WHERE id = ?").run(relationId);
      audit(userId, null, "task.relation_delete", { boardId: board.id, cardId, relationId, kind: row.kind });
    })();
    return { ok: true as const };
  });
}

export type RelationCounts = { relation_count: number; open_blockers: number };

/**
 * Per-card counts for the board payload in one grouped query (§3.1), as this viewer sees them:
 * `relation_count` counts every visible relation (restricted rows count, hidden binned ones do
 * not); `open_blockers` counts readable, live `depends_on` cards not in a done column (T90).
 */
export function relationCountsForBoard(boardId: string, userId: string) {
  const rows = db.query(`
    WITH ends AS (
      SELECT r.source_card_id AS card_id, r.target_card_id AS other_id, r.kind, 0 AS is_target FROM card_relations r
        JOIN cards k ON k.id = r.source_card_id WHERE k.board_id = $boardId AND k.deleted_at IS NULL
      UNION ALL
      SELECT r.target_card_id, r.source_card_id, r.kind, 1 FROM card_relations r
        JOIN cards k ON k.id = r.target_card_id WHERE k.board_id = $boardId AND k.deleted_at IS NULL
    ), resolved AS (
      SELECT e.card_id, e.kind, e.is_target, o.deleted_at IS NULL AND ob.deleted_at IS NULL AS live, oc.is_done,
             CASE WHEN ${otherAudience} THEN 1 ELSE 0 END AS in_audience
      FROM ends e JOIN cards o ON o.id = e.other_id JOIN boards ob ON ob.id = o.board_id
      LEFT JOIN board_columns oc ON oc.id = o.column_id
    )
    SELECT card_id,
           SUM(CASE WHEN in_audience = 0 OR live THEN 1 ELSE 0 END) AS relation_count,
           SUM(CASE WHEN kind = 'blocks' AND is_target = 1 AND in_audience = 1 AND live AND COALESCE(is_done, 0) = 0 THEN 1 ELSE 0 END) AS open_blockers
    FROM resolved GROUP BY card_id`).all({ boardId, userId }) as Array<RelationCounts & { card_id: string }>;
  return new Map(rows.map((row) => [row.card_id, { relation_count: row.relation_count, open_blockers: row.open_blockers }]));
}

/** `GET /boards/:b` (and MCP `list_cards`): the board with each card's relation counts for this viewer. */
export function getBoardWithRelationCounts(userId: string, boardId: string) {
  const detail = getBoard(userId, boardId);
  const counts = relationCountsForBoard(boardId, userId);
  return { ...detail, cards: detail.cards.map((card) => ({ ...card, ...(counts.get(card.id) ?? { relation_count: 0, open_blockers: 0 }) })) };
}

/** One entry of the board payload's `users` map: every assignee on the board, once (D113 trim). */
export type BoardPayloadUser = { display_name: string; can_read: 0 | 1 };

/**
 * `GET /api/tasks/boards/:b` (D113 trim, v0.9.0): each card lists `assignee_ids` and the board
 * carries one `users` map `{ id: { display_name, can_read } }`; the per-card `board_id` and the
 * deprecated `assignee_id`/`assignee_name` (Q2) are gone. `GET /cards/:k` and MCP keep the full
 * `assignees[]` objects. `can_read` is per board, so one entry serves every card.
 */
export function boardPayload(userId: string, boardId: string) {
  const detail = getBoardWithRelationCounts(userId, boardId);
  const users: Record<string, BoardPayloadUser> = {};
  const cards = detail.cards.map(({ board_id: _board, assignees, assignee_id: _id, assignee_name: _name, ...card }) => {
    for (const assignee of assignees) users[assignee.id] ??= { display_name: assignee.display_name, can_read: assignee.can_read };
    return { ...card, assignee_ids: assignees.map((assignee) => assignee.id) };
  });
  return { ...detail, cards, users };
}
