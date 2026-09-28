import { cleanLine, html, join } from "../html";
import { context, FONT, COLORS, layout, type Block, type ContextRow } from "../layout";
import { appLink, paths } from "../links";
import { formatDay, formatInstant, plural } from "../format";
import { itemTitle, LIST_MAX, personName } from "./common";
import { sharedItemPath, type SharedItem } from "./activity";
import { defineTemplate } from "./types";

/**
 * The daily or weekly digest (#28, D241, D248): "Your day in Nook". Sections reuse what Today shows
 * and hide when empty: your cards overdue and due soon, upcoming events, proposals awaiting you
 * (key names and counts only, T233), and what was shared with you since the last digest. Every row
 * links to its item; the button opens Today. It is never sent empty, and it is computed at send
 * time with access re-checked (T226).
 */

export type DigestCard = { boardId: string; cardId: string; title: string; boardName: string; dueOn: string; dueAt: string | null; overdue: boolean };
export type DigestEvent = { eventId: string; title: string; allDay: boolean; start: string; date: string };
export type DigestShared = SharedItem & { actor: string | null };

export type DigestMail = {
  period: "daily" | "weekly";
  /** The recipient's local date the digest is for. */
  date: string;
  cards: DigestCard[];
  cardsTotal: number;
  events: DigestEvent[];
  eventsMore: boolean;
  proposals: { keys: Array<{ name: string; count: number }>; total: number } | null;
  shared: DigestShared[];
  sharedTotal: number;
};

/** A section: a small eyebrow, then its rows in a context block. */
function section(label: string, rows: readonly ContextRow[], more: number, moreLabel?: string): Block[] {
  if (!rows.length) return [];
  const heading = html`<p class="nk-eyebrow" style="margin:8px 0 6px;font-family:${FONT};font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.goldText};">${label}</p>`;
  const block = context(rows, { more, moreLabel });
  return [{ html: join([heading, block.html]), text: `${label.toUpperCase()}\n${block.text}` }];
}

const SHARED_KIND_LABELS: Record<string, string> = { note: "Note", folder: "Notes folder", file: "File", board: "Board", calendar: "Calendar", collection: "Collection", view: "Task view" };

/** Counts for the subject: "2 overdue, 3 events". */
export function digestSummary(data: Pick<DigestMail, "cards" | "cardsTotal" | "events" | "proposals" | "sharedTotal" | "eventsMore">) {
  const overdue = data.cards.filter((card) => card.overdue).length;
  const dueSoon = data.cardsTotal - overdue;
  const parts = [
    overdue ? `${overdue} overdue` : null,
    dueSoon ? `${dueSoon} due soon` : null,
    data.events.length ? plural(data.events.length, "event") + (data.eventsMore ? "+" : "") : null,
    data.proposals?.total ? plural(data.proposals.total, "proposal") : null,
    data.sharedTotal ? `${data.sharedTotal} shared` : null
  ].filter(Boolean);
  return parts.join(", ");
}

export const digestTemplate = defineTemplate<DigestMail>({
  name: "digest.summary",
  class: "digest",
  render(data, ctx) {
    const weekly = data.period === "weekly";
    const day = formatDay(data.date);
    const summary = digestSummary(data);
    const cardRows: ContextRow[] = data.cards.slice(0, LIST_MAX).map((card) => ({
      title: itemTitle(card.title),
      meta: [card.overdue ? "Overdue" : null, `Due ${card.dueAt ? formatInstant(card.dueAt, ctx.tz) : formatDay(card.dueOn)}`, `On ${itemTitle(card.boardName)}`].filter(Boolean).join(" · "),
      href: appLink(paths.card(card.boardId, card.cardId))
    }));
    const eventRows: ContextRow[] = data.events.slice(0, LIST_MAX).map((event) => ({
      title: itemTitle(event.title, "Untitled event"),
      meta: event.allDay ? `${formatDay(event.date)} (all day)` : formatInstant(event.start, ctx.tz),
      href: appLink(paths.event(event.eventId))
    }));
    const proposalRows: ContextRow[] = (data.proposals?.keys ?? []).slice(0, LIST_MAX).map((key) => ({
      title: `Key “${cleanLine(key.name, 60, "unnamed")}”`,
      meta: plural(key.count, "pending change"),
      href: appLink(paths.inbox())
    }));
    const sharedRows: ContextRow[] = data.shared.slice(0, LIST_MAX).map((item) => ({
      title: itemTitle(item.title),
      meta: [SHARED_KIND_LABELS[item.kind] ?? "Item", item.actor ? `from ${personName(item.actor)}` : null].filter(Boolean).join(" · "),
      href: appLink(sharedItemPath(item))
    }));
    const blocks = [
      ...section("Your cards: overdue and due soon", cardRows, data.cardsTotal - cardRows.length, data.cardsTotal > cardRows.length ? `and ${plural(data.cardsTotal - cardRows.length, "more card")} in My work` : undefined),
      ...section(weekly ? "Events this week" : "Upcoming events", eventRows, data.events.length - eventRows.length + (data.eventsMore ? 1 : 0), data.events.length > eventRows.length || data.eventsMore ? "and more in Calendar" : undefined),
      ...section("Proposals awaiting you", proposalRows, (data.proposals?.keys.length ?? 0) - proposalRows.length),
      ...section(weekly ? "Shared with you this week" : "Shared with you", sharedRows, data.sharedTotal - sharedRows.length)
    ];
    return layout({
      instanceName: ctx.instanceName,
      subject: `${weekly ? "Your week" : "Your day"} in Nook: ${summary}`,
      preheader: summary,
      eyebrow: weekly ? "Weekly digest" : "Daily digest",
      title: weekly ? `Your week in Nook · from ${day}` : `Your day in Nook · ${day}`,
      blocks,
      action: { label: "Open Today", href: appLink(paths.home()) },
      footer: {
        reason: `You got this because you turned on the ${weekly ? "weekly" : "daily"} digest in Nook.`,
        unsubscribe: ctx.unsubscribeHref ? { href: ctx.unsubscribeHref, label: "Turn off the digest" } : undefined,
        settingsHref: appLink(paths.settings("notifications"))
      }
    });
  },
  fixture: () => ({
    period: "daily",
    date: "2026-09-29",
    cards: [
      { boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111", cardId: "6a1d6b7f-2c3e-4d4f-9a5b-222222222222", title: "Fix login redirect", boardName: "Launch", dueOn: "2026-09-28", dueAt: null, overdue: true },
      { boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111", cardId: "6a1d6b7f-2c3e-4d4f-9a5b-333333333333", title: "Write release notes", boardName: "Launch", dueOn: "2026-09-29", dueAt: "2026-09-29T15:00:00.000Z", overdue: false }
    ],
    cardsTotal: 2,
    events: [{ eventId: "9d4a9e02-5f6b-4a7c-8d8e-555555555555", title: "Design review", allDay: false, start: "2026-09-29T09:30:00.000Z", date: "2026-09-29" }],
    eventsMore: false,
    proposals: { keys: [{ name: "laptop", count: 2 }], total: 2 },
    shared: [{ kind: "note", id: "7b2e7c80-3d4f-4e5a-8b6c-333333333333", title: "Launch checklist", access: "read", actor: "Priya Shah" }],
    sharedTotal: 1
  })
});
