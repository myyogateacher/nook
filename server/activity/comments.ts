import { audit, db, now } from "../db";
import { avatarUrlFor } from "../avatars";
import { canWriteContent } from "../team/userRole";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { workKindAdapter } from "../links/adapters";
import { notifyMentions } from "./mentions";
import { captureUndo } from "../undo";
import { recordItemActivity } from "./service";
import { ITEM_COMMENT_MAX, registerActivityKinds, type ItemComment } from "../../shared/itemActivity";
import type { WorkKind } from "../../shared/workRefs";

/**
 * Item comments (docs/plan/WORKSPACE_MODULES.md §B.5, D805): comments on any workspace item, one level
 * of replies, @mentions that notify (only people who can read the item), reactions through the
 * `reactions` table (`target_kind = 'item_comment'`), files through `attachment_links`
 * (`host_kind = 'item_comment'`). Who may do what follows the item's level from its work kind adapter:
 * readers list, `comment` and up write, the author edits their own, the author or a manager deletes
 * (with an Undo ticket). Missing, unreadable, and unknown kinds are the same NOT_FOUND (T501).
 */

registerActivityKinds("core", { commented: { shape: "event", coalesce: false } });

export class CommentError extends Error {
  constructor(readonly status: 400 | 403 | 404, readonly code: string, message: string) {
    super(message);
  }
}

const notFound = () => new CommentError(404, "NOT_FOUND", "Not found");

function levelOn(kind: string, itemId: string, userId: string): { level: ItemLevel; kind: WorkKind } {
  const adapter = workKindAdapter(kind);
  if (!adapter) throw notFound();
  const level = adapter.level(itemId, { userId });
  if (level === "none") throw notFound();
  return { level, kind: adapter.kind };
}

type Row = { id: string; item_kind: WorkKind; item_id: string; parent_id: string | null; author_id: string | null; author_name: string | null; avatar_id: string | null; body_md: string; created_at: string; updated_at: string; deleted_at: string | null };

const toComment = (row: Row, viewerId: string, level: ItemLevel): ItemComment => ({
  id: row.id, itemKind: row.item_kind, itemId: row.item_id, parentId: row.parent_id, authorId: row.author_id, authorName: row.author_name ?? "Former member",
  authorAvatarUrl: row.author_id ? avatarUrlFor(row.author_id, row.avatar_id) : null, body: row.deleted_at ? "" : row.body_md, deleted: row.deleted_at !== null,
  createdAt: row.created_at, updatedAt: row.updated_at, canEdit: row.deleted_at === null && (row.author_id === viewerId || LEVEL_RANK[level] >= LEVEL_RANK.manage)
});

const select = `SELECT c.*, u.display_name AS author_name, u.avatar_id FROM item_comments c LEFT JOIN users u ON u.id = c.author_id`;

/** Every comment on the item, oldest first (replies after their parent), for a reader. */
export function listComments(kind: string, itemId: string, viewerId: string): ItemComment[] {
  const { level } = levelOn(kind, itemId, viewerId);
  const rows = db.query(`${select} WHERE c.item_kind = ? AND c.item_id = ? ORDER BY c.created_at, c.id LIMIT 1000`).all(kind, itemId) as Row[];
  // A deleted comment shows only while it still has live replies ("Comment deleted").
  const hasReplies = new Set(rows.filter((row) => row.parent_id && row.deleted_at === null).map((row) => row.parent_id!));
  return rows.filter((row) => row.deleted_at === null || hasReplies.has(row.id)).map((row) => toComment(row, viewerId, level));
}

function checkBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) throw new CommentError(400, "INVALID", "Write a comment");
  if (body.length > ITEM_COMMENT_MAX) throw new CommentError(400, "INVALID", `A comment is at most ${ITEM_COMMENT_MAX} characters`);
  return body.trim();
}

export function addComment(input: { kind: string; itemId: string; authorId: string; body: string; parentId?: string | null }): ItemComment {
  const { level, kind } = levelOn(input.kind, input.itemId, input.authorId);
  if (LEVEL_RANK[level] < LEVEL_RANK.comment || !canWriteContent(input.authorId)) throw new CommentError(403, "READ_ONLY", "You can read this but not comment on it");
  const body = checkBody(input.body);
  return db.transaction(() => {
    if (input.parentId) {
      const parent = db.query("SELECT id, parent_id FROM item_comments WHERE id = ? AND item_kind = ? AND item_id = ? AND deleted_at IS NULL").get(input.parentId, kind, input.itemId) as { id: string; parent_id: string | null } | null;
      if (!parent) throw notFound();
      // One level of threading: a reply to a reply joins its thread.
      input = { ...input, parentId: parent.parent_id ?? parent.id };
    }
    const id = Bun.randomUUIDv7();
    const timestamp = now();
    db.query("INSERT INTO item_comments (id, item_kind, item_id, parent_id, author_id, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, kind, input.itemId, input.parentId ?? null, input.authorId, body, timestamp, timestamp);
    recordItemActivity({ itemKind: kind, itemId: input.itemId, actorId: input.authorId, kind: "commented", payload: { item: { id, label: "Comment" } } });
    audit(input.authorId, null, "item.comment_added", { kind, itemId: input.itemId, commentId: id });
    notifyMentions({ kind, itemId: input.itemId, authorId: input.authorId, text: body });
    const row = db.query(`${select} WHERE c.id = ?`).get(id) as Row;
    return toComment(row, input.authorId, level);
  })();
}

export function editComment(input: { kind: string; itemId: string; commentId: string; userId: string; body: string }): ItemComment {
  const { level, kind } = levelOn(input.kind, input.itemId, input.userId);
  const body = checkBody(input.body);
  return db.transaction(() => {
    const row = db.query(`${select} WHERE c.id = ? AND c.item_kind = ? AND c.item_id = ? AND c.deleted_at IS NULL`).get(input.commentId, kind, input.itemId) as Row | null;
    if (!row) throw notFound();
    if (row.author_id !== input.userId || !canWriteContent(input.userId)) throw new CommentError(403, "NOT_AUTHOR", "Only the author can edit a comment");
    db.query("UPDATE item_comments SET body_md = ?, updated_at = ? WHERE id = ?").run(body, now(), row.id);
    audit(input.userId, null, "item.comment_edited", { kind, itemId: input.itemId, commentId: row.id });
    notifyMentions({ kind, itemId: input.itemId, authorId: input.userId, text: body, before: row.body_md });
    return toComment(db.query(`${select} WHERE c.id = ?`).get(row.id) as Row, input.userId, level);
  })();
}

/** Deletes a comment at once with an Undo ticket (D813); a comment with replies keeps its place as "Comment deleted". */
export function deleteComment(input: { kind: string; itemId: string; commentId: string; userId: string }): { undoTicket: string } {
  const { level, kind } = levelOn(input.kind, input.itemId, input.userId);
  return db.transaction(() => {
    const row = db.query("SELECT id, author_id FROM item_comments WHERE id = ? AND item_kind = ? AND item_id = ? AND deleted_at IS NULL").get(input.commentId, kind, input.itemId) as { id: string; author_id: string | null } | null;
    if (!row) throw notFound();
    if ((row.author_id !== input.userId && LEVEL_RANK[level] < LEVEL_RANK.manage) || !canWriteContent(input.userId)) throw new CommentError(403, "NOT_AUTHOR", "Only the author or a manager can delete a comment");
    const replies = (db.query("SELECT COUNT(*) AS count FROM item_comments WHERE parent_id = ? AND deleted_at IS NULL").get(row.id) as { count: number }).count;
    const undoTicket = captureUndo({ actorId: input.userId, kind: "item_comment", label: "Comment", rows: [{ table: "item_comments", where: { id: row.id }, restore: replies ? "update" : "insert" }] });
    if (replies) db.query("UPDATE item_comments SET deleted_at = ?, body_md = '' WHERE id = ?").run(now(), row.id);
    else db.query("DELETE FROM item_comments WHERE id = ?").run(row.id);
    audit(input.userId, null, "item.comment_deleted", { kind, itemId: input.itemId, commentId: row.id });
    return { undoTicket };
  })();
}
