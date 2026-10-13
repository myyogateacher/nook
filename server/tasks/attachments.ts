import { audit, db, now } from "../db";
import { ATTACHMENTS_FOLDER_KIND, binIfOrphanedAttachment, relinkableDocument, restoreForRelink, type RemovalRecord } from "../attachments/service";
import { linkChanged, recordRemovedLink } from "../attachments/undoTickets";
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
 * Uploads everywhere U2 (plan D390, D395, D396; operator decision Q2 relaxing D179): uploads arrive
 * with `?attachTo=card` as ordinary Files documents in the caller's Attachments folder. Any other
 * Files item the caller owns links only with `confirmed: true` (409 CONFIRM_REQUIRED otherwise),
 * because the board's readers will be able to open it. Links stay in `card_attachments` (the
 * registry's `card` host, D43). When the last link goes, an Attachments-folder document moves to its
 * owner's Bin; a Files item linked from elsewhere is never binned by link changes. A linked document
 * in its owner's Bin is listed as `removed` ("File removed", D409) until it is restored.
 *
 * U8: the hidden `task_attachment` uploads of v0.34.0 and earlier became Attachments-folder documents
 * in migration 047, so there is one kind of attachment and one lifecycle (the never-linked sweep is
 * server/attachments/sweep.ts).
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

type LinkableDocument = { id: string; name: string; system_kind: string | null };

/**
 * A document `userId` may link to a card (T41, T341): their own, live Files document that is not a
 * whiteboard. Anything else is null (the same 404 as a missing id, so nobody probes other people's files).
 */
export function linkableCardDocument(documentId: string, userId: string) {
  return db.query(`SELECT d.id, d.name, f.system_kind FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
    WHERE d.id = ? AND d.owner_id = ? AND d.deleted_at IS NULL AND d.purge_started_at IS NULL
      AND d.purpose = 'file' AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)`)
    .get(documentId.toLowerCase(), userId) as LinkableDocument | null;
}

/** A Files item outside the Attachments folder: linking it shares it with the board, so it needs a confirm (D396). */
export const needsLinkConfirm = (document: Pick<LinkableDocument, "system_kind">) => document.system_kind !== ATTACHMENTS_FOLDER_KIND;

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
  for (const document of fresh) {
    insert.run(input.cardId, document.id, input.commentId, input.userId, timestamp);
    linkChanged("card", input.cardId, document.id);
  }
  return fresh.map((document) => document.id);
}

/**
 * Moves documents that no card links any more to their uploader's Bin (director review §7). Call
 * inside the transaction that removed the links. They follow D395 (binIfOrphanedAttachment): only
 * those in the Attachments folder, and only when nothing anywhere links them. Their ids are pushed to
 * `binnedFiles`, so the caller can tell knowledge bases after the commit (notifyBinnedFiles).
 */
export function binUnlinkedAttachments(documentIds: Iterable<string>, actorId: string | null, binnedFiles?: string[]) {
  let binned = 0;
  for (const documentId of new Set(documentIds)) {
    if (binIfOrphanedAttachment(documentId, actorId, { notify: false })) {
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
    const link = db.query("SELECT linked_by, comment_id, created_at FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, documentId) as { linked_by: string | null; comment_id: string | null; created_at: string } | null;
    if (!link) throw attachmentNotFound();
    if (!asOwner && link.linked_by !== userId && current.owner_id !== userId) throw new TaskError(403, "Only the person who attached this file or the board owner can remove it", "LINKER_ONLY");
    let binned = 0;
    const binnedFiles: string[] = [];
    db.transaction(() => {
      db.query("DELETE FROM card_attachments WHERE card_id = ? AND document_id = ?").run(cardId, documentId);
      linkChanged("card", cardId, documentId);
      binned = binUnlinkedAttachments([documentId], userId, binnedFiles);
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
      audit(userId, null, "task.attachment_unlink", { boardId: current.id, cardId, documentId });
      // The Undo record commits with the removal (undoTickets.ts).
      recordRemovedLink(userId, "card", cardId, documentId, { partId: link.comment_id, position: 0, linkedBy: link.linked_by, createdAt: link.created_at, binned: binned > 0 });
    })();
    notifyBinnedFiles(binnedFiles);
    return { ok: true as const, movedToBin: binned > 0 };
  });
}

/**
 * The Undo of a removal from a card (POST /api/attachments/relink, U2): an editor of the board puts the
 * file back as it was, through the comment it came with while that comment still exists (409
 * COMMENT_GONE otherwise), at its old place in the list (its link time). The document rule is the
 * attachment service's (relinkableDocument); an Attachments-folder file the removal binned comes out
 * of its owner's Bin when the undoer is that owner. Already linked: nothing changes.
 *
 * Without a removal record the client's `partId` is held to the ordinary link rule (linkAttachments):
 * it must be the caller's own comment on this card, or it is the same 404 (v0.36.0 review L1).
 * `removal` reads the server's record inside the board lock (undoTickets.ts).
 */
export async function relinkToCard(userId: string, cardId: string, documentId: string, removal: () => RemovalRecord | null, partId: string | null) {
  const { board } = requireCardAt(cardId, userId, "edit");
  const id = documentId.toLowerCase();
  const restoredFiles: string[] = [];
  const outcome = await withBoardLock(board.id, () => {
    const { board: current } = requireCardAt(cardId, userId, "edit");
    if (db.query("SELECT 1 FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, id)) return { relinked: false, restored: false };
    const removed = removal();
    const commentId = removed ? removed.partId : partId;
    if (!removed && commentId && !db.query("SELECT 1 FROM card_comments WHERE id = ? AND card_id = ? AND author_id = ?").get(commentId, cardId, userId)) {
      throw new TaskError(404, "Comment not found");
    }
    return db.transaction(() => {
      const document = relinkableDocument(id, userId, removed);
      if (commentId && !db.query("SELECT 1 FROM card_comments WHERE id = ? AND card_id = ?").get(commentId, cardId)) {
        throw new TaskError(409, "The comment this file came with was deleted", "COMMENT_GONE");
      }
      const onCard = (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE card_id = ?").get(cardId) as { count: number }).count;
      if (onCard >= LIMITS.attachmentsPerCard) throw limitReached(`A card can have up to ${LIMITS.attachmentsPerCard} attachments`);
      if (commentId) {
        const onComment = (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE comment_id = ?").get(commentId) as { count: number }).count;
        if (onComment >= LIMITS.attachmentsPerComment) throw limitReached(`A comment can have up to ${LIMITS.attachmentsPerComment} attachments`);
      }
      const restored = document.restore && restoreForRelink(document.id, userId);
      if (document.restore && !restored) throw new TaskError(409, "This file is being deleted from the Bin", "PURGING");
      if (restored) restoredFiles.push(document.id);
      db.query("INSERT INTO card_attachments (card_id, document_id, comment_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(cardId, document.id, commentId, removed?.linkedBy ?? userId, removed?.createdAt ?? now());
      linkChanged("card", cardId, document.id);
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
      audit(userId, null, "task.attachment_relink", { boardId: current.id, cardId, documentId: document.id, ...(commentId ? { commentId } : {}), ...(restored ? { restored: true } : {}) });
      return { relinked: true, restored };
    })();
  });
  notifyBinnedFiles(restoredFiles);
  return outcome;
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
