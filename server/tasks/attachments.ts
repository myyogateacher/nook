import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { ATTACHMENTS_FOLDER_KIND, binIfOrphanedAttachment } from "../attachments/service";
import { sourceAccessChangedHook } from "../knowledge/hooks";
import { LIMITS, limitReached, requireCardAt, requireReadableCard, TaskError, withBoardLock } from "./service";

/**
 * Card attachments (WAVES_7-9.md D42/D43 as revised by the director's §7 review). An attachment is
 * a document the caller uploaded and linked to a card, optionally through one of the caller's own
 * comments on it. Board readers can read it through readableDocument* while the link, the card, the
 * board, and their membership last. When a document loses its last link (unlink, comment delete,
 * card or board purge), it moves to the uploader's Bin so it clears in 30 days instead of counting
 * against quota forever.
 *
 * Uploads everywhere U2 (plan D390, D395, D396; operator decision Q2 relaxing D179): new uploads
 * arrive with `?attachTo=card` as ordinary Files documents in the caller's Attachments folder and link
 * like the older hidden `task_attachment` uploads (still accepted). Any other Files item the caller
 * owns links only with `confirmed: true` (409 CONFIRM_REQUIRED otherwise), because the board's
 * readers will be able to open it. Links stay in `card_attachments` (the registry's `card` host,
 * D43). When the last link goes, a task attachment or an Attachments-folder document moves to its
 * owner's Bin; a Files item linked from elsewhere is never binned by link changes. A linked document
 * in its owner's Bin is listed as `removed` ("File removed", D409) until it is restored.
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
  /**
   * 1 when the document is in its owner's Bin (D409, T351): name, type, and size are blanked and the
   * client shows "File removed" until it is restored.
   */
  removed: 0 | 1;
};

/** A binned document keeps its link but shows no name, type, or size (the U0 `removed` rule). */
const attachmentSelect = `
  SELECT ca.document_id, ca.card_id, ca.comment_id, ca.linked_by, u.display_name AS linker_name,
         CASE WHEN d.deleted_at IS NULL THEN d.name ELSE '' END AS name,
         CASE WHEN d.deleted_at IS NULL THEN d.mime_type ELSE '' END AS mime_type,
         CASE WHEN d.deleted_at IS NULL THEN d.preview_kind ELSE 'none' END AS preview_kind,
         CASE WHEN d.deleted_at IS NULL THEN d.size_bytes ELSE 0 END AS size_bytes,
         ca.created_at, CASE WHEN d.deleted_at IS NULL THEN 0 ELSE 1 END AS removed
  FROM card_attachments ca JOIN documents d ON d.id = ca.document_id AND d.purge_started_at IS NULL
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

type LinkableDocument = { id: string; name: string; purpose: string; system_kind: string | null };

/**
 * A document `userId` may link to a card (T41, T341): their own, live, and either a legacy task
 * attachment or a Files document that is not a whiteboard. Anything else is null (the same 404 as a
 * missing id, so nobody probes other people's files).
 */
export function linkableCardDocument(documentId: string, userId: string) {
  return db.query(`SELECT d.id, d.name, d.purpose, f.system_kind FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
    WHERE d.id = ? AND d.owner_id = ? AND d.deleted_at IS NULL AND d.purge_started_at IS NULL
      AND (d.purpose = 'task_attachment' OR (d.purpose = 'file' AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)))`)
    .get(documentId.toLowerCase(), userId) as LinkableDocument | null;
}

/** A Files item outside the Attachments folder: linking it shares it with the board, so it needs a confirm (D396). */
export const needsLinkConfirm = (document: Pick<LinkableDocument, "purpose" | "system_kind">) =>
  document.purpose === "file" && document.system_kind !== ATTACHMENTS_FOLDER_KIND;

export const confirmRequired = (name: string) =>
  new TaskError(409, `People who can open this card will be able to open ${name}`, "CONFIRM_REQUIRED", { documentName: name });

/**
 * Links documents inside the caller's transaction (T41, T341): each must be the caller's own live
 * task attachment or Files document (linkableCardDocument); a Files item outside the Attachments
 * folder needs `confirmed` (D396). A comment must be the caller's own comment on this card. Caps: 50
 * per card, 10 per comment. Returns the ids that were newly linked.
 */
export function linkAttachments(input: { userId: string; cardId: string; documentIds: string[]; commentId: string | null; confirmed?: boolean }) {
  const ids = [...new Set(input.documentIds.map((documentId) => documentId.toLowerCase()))];
  if (input.commentId) {
    const own = db.query("SELECT 1 FROM card_comments WHERE id = ? AND card_id = ? AND author_id = ?").get(input.commentId, input.cardId, input.userId);
    if (!own) throw new TaskError(404, "Comment not found");
  }
  const documents = ids.map((documentId) => {
    const document = linkableCardDocument(documentId, input.userId);
    if (!document) throw new TaskError(404, "File not found");
    return document;
  });
  const existing = db.query("SELECT 1 FROM card_attachments WHERE card_id = ? AND document_id = ?");
  const fresh = documents.filter((document) => !existing.get(input.cardId, document.id));
  const unconfirmed = input.confirmed === true ? undefined : fresh.find(needsLinkConfirm);
  if (unconfirmed) throw confirmRequired(unconfirmed.name);
  const onCard = (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE card_id = ?").get(input.cardId) as { count: number }).count;
  if (onCard + fresh.length > LIMITS.attachmentsPerCard) throw limitReached(`A card can have up to ${LIMITS.attachmentsPerCard} attachments`);
  if (input.commentId) {
    const onComment = (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE comment_id = ?").get(input.commentId) as { count: number }).count;
    if (onComment + fresh.length > LIMITS.attachmentsPerComment) throw limitReached(`A comment can have up to ${LIMITS.attachmentsPerComment} attachments`);
  }
  const insert = db.query("INSERT INTO card_attachments (card_id, document_id, comment_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)");
  const timestamp = now();
  for (const document of fresh) insert.run(input.cardId, document.id, input.commentId, input.userId, timestamp);
  return fresh.map((document) => document.id);
}

/**
 * Moves documents that no card links any more to their uploader's Bin (director review §7). Call
 * inside the transaction that removed the links. Legacy task attachments go when no card links them
 * (`deleted_by` is the actor); Files documents follow D395 (binIfOrphanedAttachment): only those in
 * the Attachments folder, and only when nothing anywhere links them. Their ids are pushed to
 * `binnedFiles`, so the caller can tell knowledge bases after the commit (notifyBinnedFiles).
 */
export function binUnlinkedAttachments(documentIds: Iterable<string>, actorId: string | null, binnedFiles?: string[]) {
  const stillLinked = db.query("SELECT 1 FROM card_attachments WHERE document_id = ?");
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  // Eligibility is a SELECT, never the UPDATE's `.changes`: after a cascading DELETE in the same
  // transaction (a card or comment purge), Bun can report that DELETE's count for an UPDATE that
  // matched nothing, which would audit a "document.delete" that never happened (found in U3).
  const eligible = db.query("SELECT 1 FROM documents WHERE id = ? AND purpose = 'task_attachment' AND deleted_at IS NULL");
  const bin = db.query(`UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ?
    WHERE id = ? AND purpose = 'task_attachment' AND deleted_at IS NULL`);
  let binned = 0;
  for (const documentId of new Set(documentIds)) {
    if (stillLinked.get(documentId)) continue;
    if (eligible.get(documentId)) {
      bin.run(deletedAt.toISOString(), actorId, purgeAfter, documentId);
      binned += 1;
      audit(actorId, null, "document.delete", { documentId, reason: "attachment_unlinked" });
    } else if (binIfOrphanedAttachment(documentId, actorId, { notify: false })) {
      binned += 1;
      binnedFiles?.push(documentId);
    }
  }
  return binned;
}

/** After the commit: Files documents that moved to the Bin leave every knowledge base (Wave 44 M1). */
export function notifyBinnedFiles(documentIds: readonly string[]) {
  if (documentIds.length) sourceAccessChangedHook({ kind: "document", ids: [...documentIds] });
}

export async function attachToCard(userId: string, cardId: string, input: { documentId: string; commentId?: string | null; confirmed?: boolean }) {
  const { board } = requireCardAt(cardId, userId, "edit");
  const documentId = input.documentId.toLowerCase();
  return withBoardLock(board.id, () => {
    requireCardAt(cardId, userId, "edit");
    const already = attachment(cardId, documentId);
    if (already) {
      // Linking again is idempotent, but only for the document's owner (never a probe for others).
      if (!db.query("SELECT 1 FROM documents WHERE id = ? AND owner_id = ?").get(documentId, userId)) throw new TaskError(404, "File not found");
      return { status: 200 as const, attachment: already };
    }
    db.transaction(() => {
      const document = linkableCardDocument(documentId, userId);
      linkAttachments({ userId, cardId, documentIds: [documentId], commentId: input.commentId ?? null, confirmed: input.confirmed });
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
      audit(userId, null, "task.attachment_link", {
        boardId: board.id, cardId, documentId,
        ...(input.commentId ? { commentId: input.commentId } : {}),
        ...(document && needsLinkConfirm(document) ? { fromFiles: true } : {})
      });
    })();
    return { status: 201 as const, attachment: attachment(cardId, documentId)! };
  });
}

/** Whether `userId` owns the document (they may always withdraw it, U0 review M1). */
const ownsDocument = (documentId: string, userId: string) => Boolean(db.query("SELECT 1 FROM documents WHERE id = ? AND owner_id = ? AND purge_started_at IS NULL").get(documentId, userId));

/**
 * Unlinks (the linker or the board owner, at `edit`). The file's owner may always withdraw their own
 * file from a card they can still open, whatever their level (U0 review M1; one they can no longer
 * open goes through DELETE /api/attachments/card/…). A document no card links any more moves to its
 * uploader's Bin.
 */
export async function detachFromCard(userId: string, cardId: string, documentId: string) {
  const asOwner = ownsDocument(documentId, userId);
  const access = () => asOwner ? requireReadableCard(cardId, userId) : requireCardAt(cardId, userId, "edit");
  const { board } = access();
  return withBoardLock(board.id, () => {
    const { board: current } = access();
    const link = db.query("SELECT linked_by FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, documentId) as { linked_by: string | null } | null;
    if (!link) throw attachmentNotFound();
    if (!asOwner && link.linked_by !== userId && current.owner_id !== userId) throw new TaskError(403, "Only the person who attached this file or the board owner can remove it", "LINKER_ONLY");
    let binned = 0;
    const binnedFiles: string[] = [];
    db.transaction(() => {
      db.query("DELETE FROM card_attachments WHERE card_id = ? AND document_id = ?").run(cardId, documentId);
      binned = binUnlinkedAttachments([documentId], userId, binnedFiles);
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
      audit(userId, null, "task.attachment_unlink", { boardId: current.id, cardId, documentId });
    })();
    notifyBinnedFiles(binnedFiles);
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
 * `deleted_by` stays NULL: no user removed them. (Attachments-folder uploads are swept by
 * server/attachments/sweep.ts.)
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
