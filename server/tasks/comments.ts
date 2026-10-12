import { audit, db, now } from "../db";
import { readableBoardPredicate } from "./access";
import { binUnlinkedAttachments, commentAttachmentIds, linkAttachments, notifyBinnedFiles } from "./attachments";
import { LIMITS, limitReached, requireBoardAt, requireCardAt, TaskError, withBoardLock } from "./service";
import { withReactions } from "../reactions/service";
import { mailComment } from "../mail/triggers";
import type { ReactionAggregate } from "../../shared/reactions";
import { FILES_ONLY_MARK, generatedCommentBody, isGeneratedCommentBody } from "../../shared/commentFiles";

/**
 * Card comments (WAVES_7-9.md §3.3, D38). Any reader comments; only the author edits; the author
 * or the board owner deletes. The author is always the session user (T44). Comments are removed
 * outright (they are not binned); attachments linked through a deleted comment are unlinked.
 */
export const COMMENT_PAGE_SIZE = 50;
export const COMMENT_MAX_BYTES = 16_384;

export type CardComment = {
  id: string;
  card_id: string;
  author_id: string | null;
  author_name: string | null;
  /** 1 when the author is an integration (Wave 36, D287): the comment came through its key. */
  author_is_integration: 0 | 1;
  is_author: 0 | 1;
  body: string;
  created_at: string;
  edited_at: string | null;
  /** Aggregated reactions as the caller sees them (migration 022, D186). */
  reactions: ReactionAggregate[];
};

type CommentRow = { id: string; card_id: string; author_id: string | null; body: string; created_at: string; edited_at: string | null; board_id: string; owner_id: string };

const commentSelect = `
  SELECT m.id, m.card_id, m.author_id, u.display_name AS author_name, CASE WHEN u.kind = 'service' THEN 1 ELSE 0 END AS author_is_integration,
         CASE WHEN m.author_id = $userId THEN 1 ELSE 0 END AS is_author,
         m.body, m.created_at, m.edited_at
  FROM card_comments m LEFT JOIN users u ON u.id = m.author_id
`;

const commentNotFound = () => new TaskError(404, "Comment not found");

/**
 * A page of a card's comments in chronological order: the newest `limit`, or the `limit` before
 * the comment `before`. `hasMore` says older comments exist. Comments posted in the same millisecond
 * share `created_at`; rowid (insertion order) breaks the tie in the order and the keyset, never the
 * random id.
 */
export function listComments(userId: string, cardId: string, options: { before?: string; limit?: number } = {}) {
  const limit = options.limit ?? COMMENT_PAGE_SIZE;
  type Cursor = { created_at: string; seq: number };
  const cursor = options.before
    ? db.query("SELECT created_at, rowid AS seq FROM card_comments WHERE id = ? AND card_id = ?").get(options.before, cardId) as Cursor | null
    : null;
  if (options.before && !cursor) throw commentNotFound();
  const rows = db.query(`${commentSelect} WHERE m.card_id = $cardId
      AND ($cursorAt IS NULL OR m.created_at < $cursorAt OR (m.created_at = $cursorAt AND m.rowid < $cursorSeq))
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT $limit`)
    .all({ userId, cardId, cursorAt: cursor?.created_at ?? null, cursorSeq: cursor?.seq ?? null, limit: limit + 1 }) as Array<Omit<CardComment, "reactions">>;
  // One aggregate query for the whole page (D186).
  return { comments: withReactions("card_comment", userId, rows.slice(0, limit).reverse()), hasMore: rows.length > limit };
}

function commentById(userId: string, commentId: string): CardComment | null {
  const row = db.query(`${commentSelect} WHERE m.id = $commentId`).get({ userId, commentId }) as Omit<CardComment, "reactions"> | null;
  return row ? withReactions("card_comment", userId, [row])[0]! : null;
}

/** A comment on a live card of a board the caller can read, with the board's id and owner. */
function readableComment(commentId: string, userId: string) {
  return db.query(`SELECT m.id, m.card_id, m.author_id, m.body, m.created_at, m.edited_at, k.board_id, b.owner_id
    FROM card_comments m JOIN cards k ON k.id = m.card_id AND k.deleted_at IS NULL JOIN boards b ON b.id = k.board_id
    WHERE m.id = $commentId AND ${readableBoardPredicate}`).get({ commentId, userId }) as CommentRow | null;
}

export type CommentInput = {
  /** The text; blank is allowed only when the comment has files (D397). */
  body?: string;
  /** The caller's own files to attach through the comment (≤ 10 per comment). */
  attachmentIds?: string[];
  /** The caller confirmed that the board's readers will be able to open a Files item (D396, Q2). */
  confirmed?: boolean;
};

const blank = (body: string | undefined) => body === undefined || body.trim().length === 0;
const noText = () => new TaskError(400, "Write a comment or attach a file", "INVALID");

/** Names of the live files linked through a comment, in linking order (for a generated body). */
function commentFileNames(commentId: string) {
  return (db.query(`SELECT d.name FROM card_attachments ca JOIN documents d ON d.id = ca.document_id AND d.deleted_at IS NULL
    WHERE ca.comment_id = ? ORDER BY ca.created_at, ca.rowid`).all(commentId) as Array<{ name: string }>).map((row) => row.name);
}

/**
 * Links files through a comment and audits each link; a files-only comment whose files were all
 * on the card already would be empty, so that is refused (the caller's transaction rolls back).
 */
function linkCommentFiles(userId: string, boardId: string, cardId: string, commentId: string, input: CommentInput) {
  if (!input.attachmentIds?.length) return [];
  const linked = linkAttachments({ userId, cardId, documentIds: input.attachmentIds, commentId, confirmed: input.confirmed });
  for (const documentId of linked) audit(userId, null, "task.attachment_link", { boardId, cardId, documentId, commentId });
  return linked;
}

/**
 * Posts a comment. With files and no text (D397, Q12) the stored body is generated from the files
 * (`📎 name` or `📎 N files`, shared/commentFiles.ts), which the app shows as the files alone.
 */
export async function createComment(userId: string, cardId: string, input: CommentInput) {
  const filesOnly = blank(input.body);
  if (filesOnly && !input.attachmentIds?.length) throw noText();
  const { board } = requireCardAt(cardId, userId, "comment");
  return withBoardLock(board.id, () => {
    requireCardAt(cardId, userId, "comment");
    const count = (db.query("SELECT COUNT(*) AS count FROM card_comments WHERE card_id = ?").get(cardId) as { count: number }).count;
    if (count >= LIMITS.commentsPerCard) throw limitReached(`A card can have up to ${LIMITS.commentsPerCard} comments`);
    const id = crypto.randomUUID();
    db.transaction(() => {
      const timestamp = now();
      // The CHECK needs a body before the links exist; a files-only one is replaced once they do.
      db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)").run(id, cardId, userId, filesOnly ? FILES_ONLY_MARK : input.body!, timestamp);
      // Files attached with the comment are linked to the card through it (their owner only).
      const linked = linkCommentFiles(userId, board.id, cardId, id, input);
      if (filesOnly) {
        if (!linked.length) throw new TaskError(409, "These files are already attached to this card", "ATTACHMENT_LINKED");
        db.query("UPDATE card_comments SET body = ? WHERE id = ?").run(generatedCommentBody(commentFileNames(id)), id);
      }
      db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(timestamp, cardId);
      audit(userId, null, "task.comment_create", { boardId: board.id, cardId, commentId: id, ...(linked.length ? { files: linked.length } : {}), ...(filesOnly ? { filesOnly: true } : {}) });
      // "New comment on your card" mail for its assignees and creator (outbound email #17).
      mailComment(userId, cardId, id);
    })();
    return { comment: commentById(userId, id)! };
  });
}

/**
 * The author edits the text and may add files (≤ 10 per comment, U2). A blank body is allowed while
 * the comment has files: it becomes the generated body. A generated body is regenerated when files
 * are added, so `📎 a.png` plus one more reads `📎 2 files`.
 */
export async function updateComment(userId: string, commentId: string, input: CommentInput) {
  const found = readableComment(commentId, userId);
  if (!found) throw commentNotFound();
  return withBoardLock(found.board_id, () => {
    const current = readableComment(commentId, userId);
    if (!current) throw commentNotFound();
    if (current.author_id !== userId) throw new TaskError(403, "Only the author can edit this comment", "AUTHOR_ONLY");
    // An author whose level dropped below comment keeps reading, not writing (D272).
    requireBoardAt(current.board_id, userId, "comment");
    db.transaction(() => {
      const before = commentFileNames(commentId);
      const wasGenerated = isGeneratedCommentBody(current.body, { count: before.length, names: before });
      const linked = linkCommentFiles(userId, current.board_id, current.card_id, commentId, input);
      const names = linked.length ? commentFileNames(commentId) : before;
      let body = input.body === undefined ? current.body : input.body;
      if (blank(body) || (input.body === undefined && wasGenerated && linked.length)) {
        if (!names.length) throw noText();
        body = generatedCommentBody(names);
      }
      if (body !== current.body || linked.length) db.query("UPDATE card_comments SET body = ?, edited_at = ? WHERE id = ?").run(body, now(), commentId);
      if (linked.length) db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), current.card_id);
      audit(userId, null, "task.comment_update", { boardId: current.board_id, cardId: current.card_id, commentId, ...(linked.length ? { filesAdded: linked.length } : {}) });
    })();
    return { comment: commentById(userId, commentId)! };
  });
}

export async function deleteComment(userId: string, commentId: string) {
  const found = readableComment(commentId, userId);
  if (!found) throw commentNotFound();
  return withBoardLock(found.board_id, () => {
    const current = readableComment(commentId, userId);
    if (!current) throw commentNotFound();
    if (current.author_id !== userId && current.owner_id !== userId) throw new TaskError(403, "Only the author or the board owner can delete this comment", "AUTHOR_ONLY");
    if (current.owner_id !== userId) requireBoardAt(current.board_id, userId, "comment");
    const binnedFiles: string[] = [];
    db.transaction(() => {
      // Links made through the comment go with it; files no card links any more move to the Bin
      // (task attachments and Attachments-folder files; a Files item linked from elsewhere stays, D395).
      const documentIds = commentAttachmentIds(commentId);
      db.query("DELETE FROM card_comments WHERE id = ?").run(commentId);
      binUnlinkedAttachments(documentIds, userId, binnedFiles);
      audit(userId, null, "task.comment_delete", { boardId: current.board_id, cardId: current.card_id, commentId });
    })();
    notifyBinnedFiles(binnedFiles);
    return { ok: true as const };
  });
}
