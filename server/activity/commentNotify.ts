import { db } from "../db";
import { workKindAdapter } from "../links/adapters";
import { anchorsOf, type ItemKind } from "../keyResources";
import { containerRow, isContainerKind } from "../access/workspaceItems";
import { notify } from "../notify";
import { registerMailTemplate } from "../mail/registry";
import { enqueueMail, WINDOW_MS } from "../mail/outbox";
import { layout, context } from "../mail/layout";
import { defineTemplate } from "../mail/templates/types";
import { activityFooter, actorsPhrase, itemTitle, personName } from "../mail/templates/common";
import { appLink } from "../mail/links";
import { mentionNotifyModule, mentionReaders } from "./mentions";
import { WORK_KIND_LABELS, isWorkKind, type WorkKind } from "../../shared/workRefs";

/**
 * Item comment notifications (docs/plan/WORKSPACE_MODULES.md §B.5, D1360–D1362, T691): a new comment
 * on a workspace item tells the item's followers, and a reply tells the comment it answers' author.
 *
 * - Followers per kind (`commentFollowers`): the people the item is about or belongs to: its owner,
 *   assignees, and contributors (a goal's owner and contributors, a deal's owner, a booking's host and
 *   co-hosts, a townhall question's asker, a standup answer's author, a response's respondent, a time
 *   entry's person), plus the owner of the container it sits in. The same set the Tasks card comment
 *   mail uses for cards (its creator and assignees, D38).
 * - Never the commenter; only people who can read the item now (the adapter's level, T662's rule).
 * - One notification per person per comment: anyone the comment @mentions hears about it once, as a
 *   mention (server/activity/mentions.ts), and is left out here.
 * - The bell row (topic `core.comment`, one unread row per person and item, and one more for replies to
 *   them, so a later comment never hides a reply) names the commenter and the
 *   item's kind word only, never the text (T505). Email is the `comments` category ("Comments on your
 *   cards and items", on by default), grouped per person for 10 minutes, read again as the recipient at
 *   send time: an item they can no longer open, or a comment since deleted, is left out (`access_lost`).
 */

export const COMMENT_TOPIC = "core.comment";
export const COMMENT_MAIL_TEMPLATE = "core.comment";
const MAX_FOLLOWERS = 50;
const MAX_ITEMS = 20;

const ids = (sql: string, ...params: string[]) => {
  try {
    return (db.query(sql).all(...params) as Array<{ id: string | null }>).flatMap((row) => row.id ? [row.id] : []);
  } catch {
    // A module whose table is not there (a test build) has no followers.
    return [];
  }
};

/** Who follows one item of each kind, beyond its container's owner. */
const KIND_FOLLOWERS: Partial<Record<WorkKind, (id: string) => string[]>> = {
  goal: (id) => ids("SELECT owner_id AS id FROM goals WHERE id = ? UNION SELECT user_id FROM goal_contributors WHERE goal_id = ?", id, id),
  key_result: (id) => ids(`SELECT owner_id AS id FROM key_results WHERE id = ?1
    UNION SELECT g.owner_id FROM key_results k JOIN goals g ON g.id = k.goal_id WHERE k.id = ?1
    UNION SELECT c.user_id FROM key_results k JOIN goal_contributors c ON c.goal_id = k.goal_id WHERE k.id = ?1`, id),
  deal: (id) => ids("SELECT owner_id AS id FROM deals WHERE id = ?1 UNION SELECT created_by FROM deals WHERE id = ?1", id),
  contact: (id) => ids("SELECT owner_id AS id FROM contacts WHERE id = ?", id),
  company: (id) => ids("SELECT owner_id AS id FROM companies WHERE id = ?", id),
  booking: (id) => ids("SELECT host_id AS id FROM bookings WHERE id = ?1 UNION SELECT user_id FROM booking_cohosts WHERE booking_id = ?1", id),
  response: (id) => ids("SELECT respondent_user_id AS id FROM responses WHERE id = ?", id),
  // A round's id is the round or one answer (a response); an answer's author follows it.
  checkin_round: (id) => ids("SELECT respondent_user_id AS id FROM responses WHERE id = ?", id),
  townhall_question: (id) => ids("SELECT author_id AS id FROM townhall_questions WHERE id = ?", id),
  time_entry: (id) => ids("SELECT user_id AS id FROM time_entries WHERE id = ?", id)
};

/** The item's followers (unfiltered: callers keep readers only), in a stable order. */
export function commentFollowers(kind: WorkKind, id: string): string[] {
  const people = new Set(KIND_FOLLOWERS[kind]?.(id) ?? []);
  let anchors: ReturnType<typeof anchorsOf> = null;
  try { anchors = anchorsOf(kind as ItemKind, id); } catch { anchors = null; }
  for (const anchor of anchors ?? []) {
    if (!isContainerKind(anchor.kind)) continue;
    const row = containerRow(anchor.kind, anchor.id);
    if (row && row.deleted_at === null) people.add(row.owner_id);
  }
  return [...people].slice(0, MAX_FOLLOWERS);
}

type CommentRef = { kind: WorkKind; id: string; commentId: string; actorId: string; reply: boolean };

/**
 * Tells the followers (and, on a reply, the parent comment's author) about a new comment. Call inside
 * the comment's transaction, after notifyMentions; `mentioned` are the people it notified.
 */
export function notifyComment(input: { kind: WorkKind; itemId: string; commentId: string; authorId: string; parentAuthorId?: string | null; mentioned: readonly string[] }): string[] {
  const module = mentionNotifyModule(input.kind);
  const adapter = workKindAdapter(input.kind);
  if (!module || !adapter) return [];
  const skip = new Set([input.authorId, ...input.mentioned]);
  const parent = input.parentAuthorId && !skip.has(input.parentAuthorId) ? mentionReaders(input.kind, input.itemId, [input.parentAuthorId]) : [];
  const followers = mentionReaders(input.kind, input.itemId, commentFollowers(input.kind, input.itemId).filter((userId) => !skip.has(userId) && !parent.includes(userId)));
  if (!parent.length && !followers.length) return [];
  const author = (db.query("SELECT display_name FROM users WHERE id = ?").get(input.authorId) as { display_name: string } | null)?.display_name ?? "Someone";
  const noun = WORK_KIND_LABELS[input.kind].toLowerCase();
  const article = /^[aeiou]/.test(noun) ? "an" : "a";
  const notified: string[] = [];
  const send = (userIds: string[], title: string, reply: boolean) => {
    if (!userIds.length) return;
    // Every recipient can read the item, so its href is theirs to open.
    const summary = adapter.resolve([input.itemId], { userId: userIds[0]! }).get(input.itemId);
    const result = notify({
      userIds, module, topic: COMMENT_TOPIC, actor: input.authorId, title,
      href: summary?.href ?? "/notifications", item: { kind: input.kind, id: input.itemId }, dedupeKey: `${reply ? "comment-reply" : "comment"}:${input.kind}:${input.itemId}`
    });
    mailComments(result.notified, { kind: input.kind, id: input.itemId, commentId: input.commentId, actorId: input.authorId, reply });
    notified.push(...result.notified);
  };
  send(parent, `${author} replied to your comment on ${article} ${noun}`, true);
  send(followers, `${author} commented on ${article} ${noun}`, false);
  return notified;
}

// ---------------------------------------------------------------- the email

export type CommentMailData = { comments: Array<{ actor: string; title: string; kindLabel: string; href: string; reply: boolean }>; total: number };

const refsOf = (value: unknown): CommentRef[] => (Array.isArray(value) ? value : []).filter((item): item is CommentRef =>
  !!item && typeof item === "object" && isWorkKind((item as CommentRef).kind) && typeof (item as CommentRef).id === "string"
  && typeof (item as CommentRef).commentId === "string" && typeof (item as CommentRef).actorId === "string");

/** Merges a queued mail's comments with a new one: one row per comment, newest last, at most 20. */
export function mergeCommentPayload(queued: Record<string, unknown>, incoming: Record<string, unknown>) {
  const seen = new Map<string, CommentRef>();
  for (const ref of [...refsOf(queued.comments), ...refsOf(incoming.comments)]) {
    seen.delete(ref.commentId);
    seen.set(ref.commentId, { kind: ref.kind, id: ref.id, commentId: ref.commentId, actorId: ref.actorId, reply: ref.reply === true });
  }
  return { comments: [...seen.values()].slice(-MAX_ITEMS) };
}

const line = (item: CommentMailData["comments"][number]) => `${personName(item.actor)} ${item.reply ? "replied to your comment on" : "commented on"} this ${item.kindLabel.toLowerCase()}`;

export const commentTemplate = defineTemplate<CommentMailData>({
  name: COMMENT_MAIL_TEMPLATE,
  class: "activity",
  category: "comments",
  render(data, ctx) {
    const first = data.comments[0]!;
    const one = data.total === 1;
    const subject = one ? `${personName(first.actor)} ${first.reply ? "replied to you" : "commented"} on ‘${itemTitle(first.title)}’` : `${data.total} new comments on your items`;
    return layout({
      instanceName: ctx.instanceName,
      subject,
      preheader: one ? `${first.kindLabel}: ${itemTitle(first.title)}` : `By ${actorsPhrase(data.comments.map((item) => item.actor))}.`,
      eyebrow: "Comments",
      title: one ? (first.reply ? `${personName(first.actor)} replied to your comment` : `New comment from ${personName(first.actor)}`) : `${data.total} new comments`,
      lead: one ? `${line(first)}. Open it to read and reply.` : "People commented on items you own, are assigned to, or contribute to.",
      blocks: [context(data.comments.slice(0, 10).map((item) => ({ title: itemTitle(item.title), meta: line(item), href: item.href })),
        { more: Math.max(0, data.total - 10), moreLabel: data.total > 10 ? `and ${data.total - 10} more` : undefined })],
      action: { label: one ? `Open the ${first.kindLabel.toLowerCase()}` : "Open your notifications", href: one ? first.href : appLink("/notifications") },
      footer: activityFooter("comments", "You got this because someone commented on an item you own, are assigned to, or contribute to, or replied to your comment.", ctx)
    });
  },
  fixture: () => ({
    comments: [
      { actor: "Priya Shah", title: "Grow MRR to 50k", kindLabel: "Goal", href: "https://nook.example/goals/grow-mrr-0a1b2c3d4e", reply: false },
      { actor: "Sam Lee", title: "Acme renewal", kindLabel: "Deal", href: "https://nook.example/contacts/deals/acme-renewal-1b2c3d4e5f", reply: true }
    ],
    total: 2
  })
});

registerMailTemplate(COMMENT_MAIL_TEMPLATE, {
  ...commentTemplate,
  resolve: (payload, recipient) => {
    const comments: CommentMailData["comments"] = [];
    for (const ref of refsOf(payload.comments)) {
      const adapter = workKindAdapter(ref.kind);
      if (!adapter || adapter.level(ref.id, { userId: recipient.id }) === "none") continue;
      // A comment deleted since is left out (and a hidden one never was mailed: ids only).
      if (!db.query("SELECT 1 FROM item_comments WHERE id = ? AND item_kind = ? AND item_id = ? AND deleted_at IS NULL").get(ref.commentId, ref.kind, ref.id)) continue;
      const summary = adapter.resolve([ref.id], { userId: recipient.id }).get(ref.id);
      if (!summary) continue;
      const actor = (db.query("SELECT display_name FROM users WHERE id = ?").get(ref.actorId) as { display_name: string } | null)?.display_name ?? "Someone";
      comments.push({ actor, title: summary.title, kindLabel: WORK_KIND_LABELS[ref.kind], href: appLink(summary.href), reply: ref.reply === true });
    }
    return comments.length ? { data: { comments: comments.reverse(), total: comments.length } } : { skip: "access_lost" };
  }
});

/** Queues (or merges into) each notified person's comment mail. Call inside the write's transaction. */
export function mailComments(userIds: readonly string[], ref: CommentRef, nowMs?: number) {
  for (const userId of userIds) {
    enqueueMail({
      userId, template: COMMENT_MAIL_TEMPLATE as never, payload: { comments: [ref] },
      coalesceKey: `core.comment:${userId}`, windowMs: WINDOW_MS.activity, nowMs,
      merge: (queued, incoming) => mergeCommentPayload(queued as Record<string, unknown>, incoming as Record<string, unknown>)
    });
  }
}
