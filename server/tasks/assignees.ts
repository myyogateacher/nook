import { db } from "../db";
import { audienceAllUsersFor } from "../team/roles";
import { mailAssigned } from "../mail/triggers";
import { groupGrantExists } from "../access/groups";

/**
 * Card assignees (WAVE_13_TASK_CARD_UX.md D102, D103; migration 015).
 *
 * Assignees live in `card_assignees`, in assignment order (`created_at`, then
 * insertion order). `cards.assignee_id` is a legacy mirror of the first
 * assignee, kept for a rollback to v0.7.x and rewritten in the same
 * transaction as every change here. Responses derive `assignee_id` and
 * `assignee_name` from the list, never from the mirror.
 *
 * Each assignee carries `can_read`: 0 once they lost access to the board
 * (unshared or disabled), shown as "Former member" (T93). Losing access never
 * removes the assignment; any reader can remove it.
 */

export const MAX_ASSIGNEES = 20;

export type CardAssignee = { id: string; display_name: string; can_read: 0 | 1 };

/** Whether `u` can read live board `b` right now: enabled, and the owner, a member, or on an all_users board. */
const assigneeCanRead = `CASE WHEN u.disabled_at IS NULL AND (b.owner_id = u.id OR (b.visibility = 'all_users' AND ${audienceAllUsersFor("u.id")})
    OR (b.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = u.id)
      OR ${groupGrantExists("board", "b.id", "u.id")})))
  THEN 1 ELSE 0 END`;

const assigneeColumns = `ca.card_id, u.id, u.display_name, ${assigneeCanRead} AS can_read`;
const assigneeJoins = `FROM card_assignees ca JOIN cards k ON k.id = ca.card_id JOIN boards b ON b.id = k.board_id JOIN users u ON u.id = ca.user_id`;
const assigneeOrder = "ORDER BY ca.card_id, ca.created_at, ca.rowid";

type AssigneeRow = CardAssignee & { card_id: string };

function group(rows: AssigneeRow[]) {
  const byCard = new Map<string, CardAssignee[]>();
  for (const { card_id, ...assignee } of rows) {
    const list = byCard.get(card_id) ?? [];
    list.push(assignee);
    byCard.set(card_id, list);
  }
  return byCard;
}

/** Assignees of every live card on a board, in one grouped query (no per-card subquery, §3.1). */
export function assigneesForBoard(boardId: string) {
  return group(db.query(`SELECT ${assigneeColumns} ${assigneeJoins} WHERE k.board_id = ? AND k.deleted_at IS NULL ${assigneeOrder}`).all(boardId) as AssigneeRow[]);
}

/** Assignees of the given cards (a query page, at most 100), in one grouped query bound as a JSON array. */
export function assigneesForCards(cardIds: readonly string[]) {
  if (!cardIds.length) return new Map<string, CardAssignee[]>();
  return group(db.query(`SELECT ${assigneeColumns} ${assigneeJoins} WHERE ca.card_id IN (SELECT value FROM json_each(?)) ${assigneeOrder}`)
    .all(JSON.stringify(cardIds)) as AssigneeRow[]);
}

export function assigneesForCard(cardId: string) {
  return group(db.query(`SELECT ${assigneeColumns} ${assigneeJoins} WHERE ca.card_id = ? ${assigneeOrder}`).all(cardId) as AssigneeRow[]).get(cardId) ?? [];
}

/** Current assignee ids of a card, in assignment order. */
export function assigneeIds(cardId: string) {
  return (db.query("SELECT user_id FROM card_assignees WHERE card_id = ? ORDER BY created_at, rowid").all(cardId) as Array<{ user_id: string }>).map((row) => row.user_id);
}

/**
 * Replaces a card's assignees with `userIds` (already deduplicated and
 * validated), keeping the rows of users who stay so their order holds, and
 * rewrites the legacy mirror. Call inside the card's write transaction.
 */
export function replaceAssignees(cardId: string, userIds: readonly string[], actorId: string, timestamp: string) {
  const current = assigneeIds(cardId);
  const wanted = new Set(userIds);
  const removed = current.filter((id) => !wanted.has(id));
  const added = userIds.filter((id) => !current.includes(id));
  const remove = db.query("DELETE FROM card_assignees WHERE card_id = ? AND user_id = ?");
  for (const id of removed) remove.run(cardId, id);
  const insert = db.query("INSERT INTO card_assignees (card_id, user_id, assigned_by, created_at) VALUES (?, ?, ?, ?)");
  for (const id of added) insert.run(cardId, id, actorId, timestamp);
  db.query("UPDATE cards SET assignee_id = (SELECT user_id FROM card_assignees WHERE card_id = $cardId ORDER BY created_at, rowid LIMIT 1) WHERE id = $cardId")
    .run({ cardId });
  // "Assigned to you" mail, in the card's transaction (outbound email #16); never for self-assigning.
  if (added.length) mailAssigned(actorId, cardId, added);
  return { added, removed };
}

/** Users who could newly be assigned: ids from `userIds` that are not already on the card. */
export function newAssignees(cardId: string | null, userIds: readonly string[]) {
  const current = cardId ? new Set(assigneeIds(cardId)) : new Set<string>();
  return userIds.filter((id) => !current.has(id));
}
