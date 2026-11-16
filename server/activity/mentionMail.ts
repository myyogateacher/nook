import { db } from "../db";
import { workKindAdapter } from "../links/adapters";
import { registerMailTemplate } from "../mail/registry";
import { enqueueMail, WINDOW_MS } from "../mail/outbox";
import { isMuted } from "../mail/mutes";
import { layout, context } from "../mail/layout";
import { defineTemplate } from "../mail/templates/types";
import { activityFooter, actorsPhrase, itemTitle, personName } from "../mail/templates/common";
import { appLink } from "../mail/links";
import { WORK_KIND_LABELS, isWorkKind, type WorkKind } from "../../shared/workRefs";

/**
 * "You were mentioned" email (docs/plan/MENTIONS.md §5, D1328, T662): the `mentions` category, on by
 * default, grouped per recipient for 10 minutes (the activity window), held through quiet hours, and
 * checked against the person's email preferences when it is sent (the dispatcher's `prefsAllow`).
 *
 * The payload holds ids only: `{ mentions: [{ kind, id, actorId, where }] }`. At send time each item
 * is read again as the recipient through its work kind adapter: anything they can no longer open is
 * left out (its title, author, and kind word with it), and a mail with nothing left is skipped
 * (`access_lost`). A card on a board they muted is left out too. No mention text is ever mailed.
 */

export const MENTION_MAIL_TEMPLATE = "core.mention";
const MAX_ITEMS = 20;

type MentionRef = { kind: WorkKind; id: string; actorId: string; where: string };
export type MentionMailData = { mentions: Array<{ actor: string; where: string; title: string; kindLabel: string; href: string }>; total: number };

const refsOf = (value: unknown): MentionRef[] => (Array.isArray(value) ? value : []).filter((item): item is MentionRef =>
  !!item && typeof item === "object" && isWorkKind((item as MentionRef).kind) && typeof (item as MentionRef).id === "string" && typeof (item as MentionRef).actorId === "string" && typeof (item as MentionRef).where === "string");

/** Merges a queued mail's mentions with a new one: one row per item and author, newest last, at most 20. */
export function mergeMentionPayload(queued: Record<string, unknown>, incoming: Record<string, unknown>) {
  const seen = new Map<string, MentionRef>();
  for (const ref of [...refsOf(queued.mentions), ...refsOf(incoming.mentions)]) {
    const key = `${ref.kind}:${ref.id}:${ref.actorId}`;
    seen.delete(key);
    seen.set(key, ref);
  }
  return { mentions: [...seen.values()].slice(-MAX_ITEMS) };
}

export const mentionTemplate = defineTemplate<MentionMailData>({
  name: MENTION_MAIL_TEMPLATE,
  class: "activity",
  category: "mentions",
  render(data, ctx) {
    const first = data.mentions[0]!;
    const one = data.total === 1;
    const subject = one ? `${personName(first.actor)} mentioned you ${first.where}` : `${data.total} new mentions of you`;
    return layout({
      instanceName: ctx.instanceName,
      subject,
      preheader: one ? `${first.kindLabel}: ${itemTitle(first.title)}` : `By ${actorsPhrase(data.mentions.map((mention) => mention.actor))}.`,
      eyebrow: "Mentions",
      title: one ? `${personName(first.actor)} mentioned you` : `${data.total} new mentions of you`,
      lead: one ? `${personName(first.actor)} mentioned you ${first.where}.` : "People mentioned you in places you can open.",
      blocks: [context(data.mentions.slice(0, 10).map((mention) => ({ title: itemTitle(mention.title), meta: `${personName(mention.actor)} mentioned you ${mention.where}`, href: mention.href })),
        { more: Math.max(0, data.total - 10), moreLabel: data.total > 10 ? `and ${data.total - 10} more` : undefined })],
      action: { label: one ? `Open the ${first.kindLabel.toLowerCase()}` : "Open your mentions", href: one ? first.href : appLink("/notifications") },
      footer: activityFooter("mentions", "You got this because someone typed @ and your name somewhere you can open.", ctx)
    });
  },
  fixture: () => ({
    mentions: [
      { actor: "Priya Shah", where: "on a card", title: "Fix login redirect", kindLabel: "Card", href: "https://nook.example/tasks/LAU-12" },
      { actor: "Sam Lee", where: "in a note", title: "Launch plan", kindLabel: "Note", href: "https://nook.example/notes/launch-plan-0a1b2c3d4e" }
    ],
    total: 2
  })
});

registerMailTemplate(MENTION_MAIL_TEMPLATE, {
  ...mentionTemplate,
  resolve: (payload, recipient) => {
    const mentions: MentionMailData["mentions"] = [];
    for (const ref of refsOf(payload.mentions)) {
      const adapter = workKindAdapter(ref.kind);
      if (!adapter || adapter.level(ref.id, { userId: recipient.id }) === "none") continue;
      if (ref.kind === "card") {
        const boardId = (db.query("SELECT board_id FROM cards WHERE id = ?").get(ref.id) as { board_id: string } | null)?.board_id;
        if (boardId && isMuted(recipient.id, "board", boardId)) continue;
      }
      const summary = adapter.resolve([ref.id], { userId: recipient.id }).get(ref.id);
      if (!summary) continue;
      const actor = (db.query("SELECT display_name FROM users WHERE id = ?").get(ref.actorId) as { display_name: string } | null)?.display_name ?? "Someone";
      mentions.push({ actor, where: ref.where, title: summary.title, kindLabel: WORK_KIND_LABELS[ref.kind], href: appLink(summary.href) });
    }
    return mentions.length ? { data: { mentions: mentions.reverse(), total: mentions.length } } : { skip: "access_lost" };
  }
});

/** Queues (or merges into) each notified person's mention mail. Call inside the write's transaction. */
export function mailMentions(userIds: readonly string[], ref: MentionRef, nowMs?: number) {
  for (const userId of userIds) {
    enqueueMail({
      userId, template: MENTION_MAIL_TEMPLATE as never, payload: { mentions: [ref] },
      coalesceKey: `core.mention:${userId}`, windowMs: WINDOW_MS.activity, nowMs,
      merge: (queued, incoming) => mergeMentionPayload(queued as Record<string, unknown>, incoming as Record<string, unknown>)
    });
  }
}
