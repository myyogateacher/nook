import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { LIMITS, limitReached, requireCardAt, TaskError, withBoardLock } from "./service";

/**
 * Card attachments (WAVES_7-9.md D42/D43 as revised by the director's §7 review). An attachment is
 * a document the caller uploaded with `?purpose=task_attachment` (folder_id NULL, never in Files)
 * and linked to a card, optionally through one of the caller's own comments on it. Board readers
 * can read it through readableDocument* while the link, the card, the board, and their membership
 * last. When a document loses its last link (unlink, comment delete, card or board purge), it moves
 * to the uploader's Bin so it clears in 30 days instead of counting against quota forever.
 */
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

const attachmentSelect = `
  SELECT ca.document_id, ca.card_id, ca.comment_id, ca.linked_by, u.display_name AS linker_name,
         d.name, d.mime_type, d.preview_kind, d.size_bytes, ca.created_at
  FROM card_attachments ca JOIN documents d ON d.id = ca.document_id AND d.deleted_at IS NULL
  LEFT JOIN users u ON u.id = ca.linked_by
`;

const attachmentNotFound = () => new TaskError(404, "Attachment not found");

/** A card's attachments, oldest first; links made in the same millisecond keep insertion order (rowid). */
export function listAttachments(cardId: string) {
  return db.query(`${attachmentSelect} WHERE ca.card_id = ? ORDER BY ca.created_at, ca.rowid`).all(cardId) as CardAttachment[];
}

function attachment(cardId: string, documentId: string) {
  return db.query(`${attachmentSelect} WHERE ca.card_id = ? AND ca.document_id = ?`).get(cardId, documentId) as CardAttachment | null;
}

/**
 * Links documents inside the caller's transaction (T41): each must be a live task attachment the
 * caller owns; a comment must be the caller's own comment on this card. Caps: 50 per card, 10 per
 * comment. Returns the ids that were newly linked.
 */
export function linkAttachments(input: { userId: string; cardId: string; documentIds: string[]; commentId: string | null }) {
  const ids = [...new Set(input.documentIds)];
  if (input.commentId) {
    const own = db.query("SELECT 1 FROM card_comments WHERE id = ? AND card_id = ? AND author_id = ?").get(input.commentId, input.cardId, input.userId);
    if (!own) throw new TaskError(404, "Comment not found");
  }
  const owned = db.query("SELECT 1 FROM documents WHERE id = ? AND owner_id = ? AND purpose = 'task_attachment' AND deleted_at IS NULL");
  for (const documentId of ids) if (!owned.get(documentId, input.userId)) throw new TaskError(404, "File not found");
  const existing = db.query("SELECT 1 FROM card_attachments WHERE card_id = ? AND document_id = ?");
  const fresh = ids.filter((documentId) => !existing.get(input.cardId, documentId));
  const onCard = (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE card_id = ?").get(input.cardId) as { count: number }).count;
  if (onCard + fresh.length > LIMITS.attachmentsPerCard) throw limitReached(`A card can have up to ${LIMITS.attachmentsPerCard} attachments`);
  if (input.commentId) {
    const onComment = (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE comment_id = ?").get(input.commentId) as { count: number }).count;
    if (onComment + fresh.length > LIMITS.attachmentsPerComment) throw limitReached(`A comment can have up to ${LIMITS.attachmentsPerComment} attachments`);
  }
  const insert = db.query("INSERT INTO card_attachments (card_id, document_id, comment_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)");
  const timestamp = now();
  for (const documentId of fresh) insert.run(input.cardId, documentId, input.commentId, input.userId, timestamp);
  return fresh;
}

/**
 * Moves documents that no card links any more to their uploader's Bin (director review §7). Call
 * inside the transaction that removed the links. `deleted_by` is the actor.
 */
export function binUnlinkedAttachments(documentIds: Iterable<string>, actorId: string | null) {
  const stillLinked = db.query("SELECT 1 FROM card_attachments WHERE document_id = ?");
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  const bin = db.query(`UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ?
    WHERE id = ? AND purpose = 'task_attachment' AND deleted_at IS NULL`);
  let binned = 0;
  for (const documentId of new Set(documentIds)) {
    if (stillLinked.get(documentId)) continue;
    if (bin.run(deletedAt.toISOString(), actorId, purgeAfter, documentId).changes) {
      binned += 1;
      audit(actorId, null, "document.delete", { documentId, reason: "attachment_unlinked" });
    }
  }
  return binned;
}

export async function attachToCard(userId: string, cardId: string, input: { documentId: string; commentId?: string | null }) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    requireCardAt(cardId, userId, "edit");
    const already = attachment(cardId, input.documentId);
    if (already) {
      // Linking again is idempotent, but only for the document's owner (never a probe for others).
      if (!db.query("SELECT 1 FROM documents WHERE id = ? AND owner_id = ?").get(input.documentId, userId)) throw new TaskError(404, "File not found");
      return { status: 200 as const, attachment: already };
    }
    db.transaction(() => {
      linkAttachments({ userId, cardId, documentIds: [input.documentId], commentId: input.commentId ?? null });
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
      audit(userId, null, "task.attachment_link", { boardId: board.id, cardId, documentId: input.documentId, ...(input.commentId ? { commentId: input.commentId } : {}) });
    })();
    return { status: 201 as const, attachment: attachment(cardId, input.documentId)! };
  });
}

/** Unlinks (the linker or the board owner). A document no card links any more moves to its uploader's Bin. */
export async function detachFromCard(userId: string, cardId: string, documentId: string) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    const { board: current } = requireCardAt(cardId, userId, "edit");
    const link = db.query("SELECT linked_by FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, documentId) as { linked_by: string | null } | null;
    if (!link) throw attachmentNotFound();
    if (link.linked_by !== userId && current.owner_id !== userId) throw new TaskError(403, "Only the person who attached this file or the board owner can remove it", "LINKER_ONLY");
    let binned = 0;
    db.transaction(() => {
      db.query("DELETE FROM card_attachments WHERE card_id = ? AND document_id = ?").run(cardId, documentId);
      binned = binUnlinkedAttachments([documentId], userId);
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
      audit(userId, null, "task.attachment_unlink", { boardId: current.id, cardId, documentId });
    })();
    return { ok: true as const, movedToBin: binned > 0 };
  });
}

/** Documents linked through a comment, for binning after the comment (and its links) are deleted. */
export function commentAttachmentIds(commentId: string) {
  return (db.query("SELECT document_id FROM card_attachments WHERE comment_id = ?").all(commentId) as Array<{ document_id: string }>).map((row) => row.document_id);
}

/** Documents linked to any card of a board, or to one card, for binning after a purge. */
export function cardAttachmentIds(where: { cardId: string } | { boardId: string }) {
  const rows = "cardId" in where
    ? db.query("SELECT document_id FROM card_attachments WHERE card_id = ?").all(where.cardId)
    : db.query("SELECT ca.document_id FROM card_attachments ca JOIN cards c ON c.id = ca.card_id WHERE c.board_id = ?").all(where.boardId);
  return (rows as Array<{ document_id: string }>).map((row) => row.document_id);
}

export const UNLINKED_ATTACHMENT_GRACE_MS = 86_400_000;
export const UNLINKED_ATTACHMENT_BATCH = 100;

/**
 * Sweeper step: task attachments that were uploaded but never linked (a failed link, a cap, a
 * dropped connection, files picked for a comment that was never posted) would stay live, hidden,
 * and counted in the quota forever. After 24 hours they move to their uploader's Bin, 100 per run.
 * `deleted_by` stays NULL: no user removed them.
 */
export function sweepUnlinkedAttachments(options: { nowMs?: number } = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - UNLINKED_ATTACHMENT_GRACE_MS).toISOString();
  const rows = db.query(`SELECT d.id FROM documents d
    WHERE d.purpose = 'task_attachment' AND d.deleted_at IS NULL AND d.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM card_attachments ca WHERE ca.document_id = d.id)
    ORDER BY d.created_at LIMIT ?`).all(cutoff, UNLINKED_ATTACHMENT_BATCH) as Array<{ id: string }>;
  if (!rows.length) return 0;
  const deletedAt = new Date(nowMs);
  const purgeAfter = purgeAfterFrom(deletedAt);
  const bin = db.query(`UPDATE documents SET deleted_at = ?, deleted_by = NULL, purge_after = ?
    WHERE id = ? AND purpose = 'task_attachment' AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM card_attachments ca WHERE ca.document_id = documents.id)`);
  let binned = 0;
  db.transaction(() => {
    for (const { id } of rows) {
      if (bin.run(deletedAt.toISOString(), purgeAfter, id).changes) {
        binned += 1;
        audit(null, null, "document.delete", { documentId: id, reason: "attachment_never_linked" });
      }
    }
  })();
  return binned;
}
