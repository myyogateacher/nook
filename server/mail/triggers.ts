import { db } from "../db";
import { isMuted } from "./mutes";
import { logShare } from "./digest";
import { enqueueMail, mergeIds, PROPOSALS_MIN_GAP_MS, WINDOW_MS, type Payload } from "./outbox";
import type { SharedKind } from "./templates/activity";
import type { AccountEvent, PasswordEvent, TwoFactorEvent } from "./templates/security";

/**
 * The hooks modules call to send mail (docs/plan/research/2026-09-28-outbound-email.md §A.2 v1 set).
 * Each is synchronous and meant to run inside the action's own transaction, stores ids only, never
 * mails the actor about their own action (security mail aside), and never throws: a mail problem
 * must not fail the action, so errors are logged by class and swallowed.
 */

function safely(label: string, run: () => void) {
  try {
    run();
  } catch (error) {
    console.error(`Mail enqueue failed: purpose=${label} error=${error instanceof Error ? error.name : "Unknown"}`);
  }
}

const unique = (values: readonly string[]) => [...new Set(values)];
const boardOf = (cardId: string) => (db.query("SELECT board_id FROM cards WHERE id = ?").get(cardId) as { board_id: string } | null)?.board_id ?? null;

/** #16: users newly added to a card's assignees by someone else. Coalesced 10 min per recipient. */
export function mailAssigned(actorId: string, cardId: string, addedUserIds: readonly string[]) {
  const boardId = boardOf(cardId);
  for (const userId of unique(addedUserIds)) {
    if (userId === actorId || (boardId && isMuted(userId, "board", boardId))) continue;
    safely("tasks.assigned", () => enqueueMail({
      userId, template: "tasks.assigned", payload: { cardIds: [cardId], actorIds: [actorId] },
      coalesceKey: `tasks.assigned:${userId}`, windowMs: WINDOW_MS.activity,
      merge: (queued, incoming) => ({ cardIds: mergeIds(queued.cardIds, incoming.cardIds), actorIds: mergeIds(queued.actorIds, incoming.actorIds, 10) })
    }));
  }
}

/** #17: a comment on a card; its assignees and creator hear about it, never the author. 10 min per (recipient, card). */
export function mailComment(authorId: string, cardId: string, commentId: string) {
  const card = db.query("SELECT created_by, board_id FROM cards WHERE id = ?").get(cardId) as { created_by: string | null; board_id: string } | null;
  if (!card) return;
  const assignees = (db.query("SELECT user_id FROM card_assignees WHERE card_id = ?").all(cardId) as Array<{ user_id: string }>).map((row) => row.user_id);
  for (const userId of unique([...assignees, ...(card.created_by ? [card.created_by] : [])])) {
    if (userId === authorId || isMuted(userId, "board", card.board_id)) continue;
    safely("tasks.comment", () => enqueueMail({
      userId, template: "tasks.comment", payload: { cardId, commentIds: [commentId] },
      coalesceKey: `tasks.comment:${userId}:${cardId}`, windowMs: WINDOW_MS.activity,
      merge: (queued, incoming) => ({ cardId: queued.cardId, commentIds: mergeIds(queued.commentIds, incoming.commentIds) })
    }));
  }
}

type SharedRef = { kind: SharedKind; id: string };
const mergeItems = (queued: unknown, incoming: unknown) => {
  const list = [...(Array.isArray(queued) ? queued : []), ...(Array.isArray(incoming) ? incoming : [])] as SharedRef[];
  const seen = new Map<string, SharedRef>();
  for (const item of list) seen.set(`${item.kind}:${item.id}`, { kind: item.kind, id: item.id });
  return [...seen.values()].slice(-50);
};

/**
 * #25: people added by name to an item's share list (never `all_users`, D239). Pass the explicit
 * recipients before and after the change; only the newly added ones hear about it.
 */
export function mailShared(actorId: string, kind: SharedKind, itemId: string, before: readonly string[], after: readonly string[]) {
  const had = new Set(before);
  for (const userId of unique(after)) {
    if (userId === actorId || had.has(userId)) continue;
    // The digest's "Shared with you" reads this log (ids only), whatever the sharing switch says.
    safely("digest.share_log", () => logShare(userId, kind, itemId, actorId));
    safely("sharing.shared", () => enqueueMail({
      userId, template: "sharing.shared", payload: { items: [{ kind, id: itemId }], actorIds: [actorId] },
      coalesceKey: `sharing.shared:${userId}`, windowMs: WINDOW_MS.activity,
      merge: (queued: Payload, incoming: Payload) => ({ items: mergeItems(queued.items, incoming.items), actorIds: mergeIds(queued.actorIds, incoming.actorIds, 10) })
    }));
  }
}

/**
 * #25 for vaults (Wave 26): people newly given access to a vault by name. The mail names the vault
 * only (D223), never a secret or a value. Vault shares stay out of the digest's share log (its kinds
 * are fixed by 028), so the mail and the bell are the two channels.
 */
export function mailVaultShared(actorId: string, vaultId: string, userIds: readonly string[]) {
  for (const userId of unique(userIds)) {
    if (userId === actorId) continue;
    safely("sharing.shared", () => enqueueMail({
      userId, template: "sharing.shared", payload: { items: [{ kind: "vault", id: vaultId }], actorIds: [actorId] },
      coalesceKey: `sharing.shared:${userId}`, windowMs: WINDOW_MS.activity,
      merge: (queued: Payload, incoming: Payload) => ({ items: mergeItems(queued.items, incoming.items), actorIds: mergeIds(queued.actorIds, incoming.actorIds, 10) })
    }));
  }
}

/** The explicit share list of an item, read before a sharing change replaces it. */
export function shareMembers(table: "note_shares" | "folder_shares" | "document_shares" | "board_members" | "calendar_members" | "collection_members" | "task_view_members", column: string, itemId: string) {
  return (db.query(`SELECT user_id FROM ${table} WHERE ${column} = ?`).all(itemId) as Array<{ user_id: string }>).map((row) => row.user_id);
}

/**
 * #27: new pending proposals for a key owner. One mail per 60 min window, at most one per 3 hours
 * (D240); the counts are read at send time, so a mail whose proposals were all handled is skipped.
 */
export function mailProposalsAwaiting(ownerId: string) {
  safely("inbox.proposals", () => {
    const last = db.query("SELECT MAX(sent_at) AS at FROM mail_outbox WHERE user_id = ? AND template = 'inbox.proposals' AND status = 'sent'").get(ownerId) as { at: string | null };
    enqueueMail({
      userId: ownerId, template: "inbox.proposals", payload: {},
      coalesceKey: `inbox.proposals:${ownerId}`, windowMs: WINDOW_MS.proposals,
      notBeforeMs: last.at ? Date.parse(last.at) + PROPOSALS_MIN_GAP_MS : 0,
      merge: (queued) => queued
    });
  });
}

// --- Security (#2–#8): always on, sent at once --------------------------------------------------

/** #5: a new MCP key on the account. */
export function mailApiKeyCreated(userId: string, keyId: string) {
  safely("security.api_key_created", () => enqueueMail({ userId, template: "security.api_key_created", payload: { keyId } }));
}

/** #2: a role change, coalesced 10 min; the first old role is kept, so a toggle back sends nothing. */
export function mailRoleChanged(targetId: string, fromRole: string, actorId: string | null) {
  safely("security.role_changed", () => enqueueMail({
    userId: targetId, template: "security.role_changed", payload: { fromRole, actorId },
    coalesceKey: `security.role_changed:${targetId}`, windowMs: WINDOW_MS.roleChange,
    merge: (queued, incoming) => ({ fromRole: queued.fromRole, actorId: incoming.actorId })
  }));
}

/** #6/#7: two-factor on, off, reset, or recovery codes regenerated or used. */
export function mailTwoFactor(userId: string, event: TwoFactorEvent, remaining: number | null = null) {
  safely("security.two_factor", () => enqueueMail({ userId, template: "security.two_factor", payload: { event, at: new Date().toISOString(), remaining } }));
}

/** #3/#4/#8: blocked, unblocked, or signed out everywhere by an admin. The admin's reason is never sent. */
export function mailAccountEvent(userId: string, event: AccountEvent, actorId: string | null, counts: Record<string, number> | null = null) {
  safely("security.account", () => enqueueMail({ userId, template: "security.account", payload: { event, actorId, at: new Date().toISOString(), ...(counts ? { counts } : {}) } }));
}

/** #12: the password was changed in Settings or reset from a mailed link (Wave 30). */
export function mailPasswordChanged(userId: string, event: PasswordEvent) {
  safely("security.password_changed", () => enqueueMail({ userId, template: "security.password_changed", payload: { event, at: new Date().toISOString() } }));
}
