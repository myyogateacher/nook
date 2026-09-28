import { cleanLine } from "../html";
import { context, layout, note, type ContextRow } from "../layout";
import { appLink, paths } from "../links";
import { formatDay, formatInstant, plural } from "../format";
import { activityFooter, actorsPhrase, itemTitle, LIST_MAX, personName } from "./common";
import { defineTemplate } from "./types";

// --- Assigned to you (#16) ------------------------------------------------------------------

export type AssignedCard = { boardId: string; cardId: string; title: string; boardName: string; dueOn: string | null; column: string | null };

export const assignedTemplate = defineTemplate<{ actors: string[]; cards: AssignedCard[] }>({
  name: "tasks.assigned",
  class: "activity",
  category: "assignments",
  render(data, ctx) {
    const who = actorsPhrase(data.actors);
    const cards = data.cards;
    const single = cards.length === 1 ? cards[0]! : null;
    const boards = new Set(cards.map((card) => card.boardId));
    const oneBoard = boards.size === 1 ? itemTitle(cards[0]!.boardName) : null;
    const rows: ContextRow[] = cards.slice(0, LIST_MAX).map((card) => ({
      title: itemTitle(card.title),
      meta: [card.dueOn ? `Due ${formatDay(card.dueOn)}` : null, card.column ? `Column ${itemTitle(card.column, "")}` : null, oneBoard ? null : `On ${itemTitle(card.boardName)}`].filter(Boolean).join(" · ") || undefined,
      href: single ? undefined : appLink(paths.card(card.boardId, card.cardId))
    }));
    const subject = single ? `${who} assigned you ‘${itemTitle(single.title)}’` : `${who} assigned you ${plural(cards.length, "card")}${oneBoard ? ` on ${oneBoard}` : ""}`;
    return layout({
      instanceName: ctx.instanceName,
      subject,
      preheader: single ? `On the board ${itemTitle(single.boardName)}.` : `${plural(cards.length, "card")} in Tasks.`,
      eyebrow: "Tasks · Assigned",
      title: single ? `${who} assigned you a card` : `${who} assigned you ${plural(cards.length, "card")}`,
      lead: oneBoard ? `On the board ${oneBoard}.` : `On ${plural(boards.size, "board")}.`,
      blocks: [context(rows, { more: cards.length - rows.length })],
      action: single ? { label: "Open card", href: appLink(paths.card(single.boardId, single.cardId)) } : { label: "Open My work", href: appLink(paths.myWork()) },
      footer: activityFooter("assignments", "You got this because someone assigned you a card in Nook.", ctx)
    });
  },
  fixture: () => ({
    actors: ["Priya Shah"],
    cards: [{ boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111", cardId: "6a1d6b7f-2c3e-4d4f-9a5b-222222222222", title: "Fix login redirect", boardName: "Launch", dueOn: "2026-10-02", column: "In progress" }]
  })
});

// --- New comments on your card (#17) --------------------------------------------------------

export type CommentExcerpt = { author: string; excerpt: string };

export const commentTemplate = defineTemplate<{ boardId: string; cardId: string; cardTitle: string; boardName: string; comments: CommentExcerpt[]; total: number }>({
  name: "tasks.comment",
  class: "activity",
  category: "comments",
  render(data, ctx) {
    const title = itemTitle(data.cardTitle);
    const authors = actorsPhrase(data.comments.map((comment) => comment.author));
    const shown = data.comments.slice(0, 3);
    const subject = data.total === 1 ? `${authors} commented on ‘${title}’` : `${plural(data.total, "new comment")} on ‘${title}’`;
    return layout({
      instanceName: ctx.instanceName,
      subject,
      preheader: `On the board ${itemTitle(data.boardName)}.`,
      eyebrow: "Tasks · Comments",
      title: data.total === 1 ? `${authors} commented on your card` : `${plural(data.total, "new comment")} on your card`,
      lead: `${title}, on the board ${itemTitle(data.boardName)}.`,
      blocks: [context(shown.map((comment) => ({ title: personName(comment.author), quote: cleanLine(comment.excerpt, 280) })), { more: data.total - shown.length, moreLabel: data.total > shown.length ? `and ${plural(data.total - shown.length, "more comment")}` : undefined })],
      action: { label: "Open card", href: appLink(paths.card(data.boardId, data.cardId)) },
      footer: activityFooter("comments", "You got this because you are assigned to this card or created it.", ctx)
    });
  },
  fixture: () => ({
    boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111",
    cardId: "6a1d6b7f-2c3e-4d4f-9a5b-222222222222",
    cardTitle: "Fix login redirect",
    boardName: "Launch",
    comments: [{ author: "Sam Lee", excerpt: "The redirect loses the query string after sign in. I pushed a fix for review." }, { author: "Priya Shah", excerpt: "Looks good, merging after lunch." }],
    total: 2
  })
});

// --- Shared with you (#25), one template for every module -------------------------------------

export type SharedKind = "note" | "folder" | "file" | "board" | "calendar" | "collection" | "view";
export type SharedItem = { kind: SharedKind; id: string; title: string; access: "read" | "edit" | null };

const KIND_LABELS: Record<SharedKind, string> = { note: "Note", folder: "Notes folder", file: "File", board: "Board", calendar: "Calendar", collection: "Collection", view: "Task view" };

export function sharedItemPath(item: Pick<SharedItem, "kind" | "id">) {
  switch (item.kind) {
    case "note": return paths.note(item.id);
    case "folder": return paths.noteFolder(item.id);
    case "file": return paths.file(item.id);
    case "board": return paths.board(item.id);
    case "calendar": return paths.calendar();
    case "collection": return paths.collection(item.id);
    case "view": return paths.taskView(item.id);
  }
}

/** Many items: the Notes or Files "Shared with me" list when they are all of that kind, else Today. */
function aggregatePath(items: readonly SharedItem[]) {
  if (items.every((item) => item.kind === "note" || item.kind === "folder")) return paths.notesShared();
  if (items.every((item) => item.kind === "file")) return paths.filesShared();
  return paths.home();
}

export const sharedTemplate = defineTemplate<{ actors: string[]; items: SharedItem[] }>({
  name: "sharing.shared",
  class: "activity",
  category: "sharing",
  render(data, ctx) {
    const who = actorsPhrase(data.actors);
    const single = data.items.length === 1 ? data.items[0]! : null;
    const rows = data.items.slice(0, LIST_MAX).map((item) => ({
      title: itemTitle(item.title),
      meta: [KIND_LABELS[item.kind], item.access === "edit" ? "You can edit" : item.access === "read" ? "You can view" : null].filter(Boolean).join(" · "),
      href: single ? undefined : appLink(sharedItemPath(item))
    }));
    return layout({
      instanceName: ctx.instanceName,
      subject: single ? `${who} shared ‘${itemTitle(single.title)}’ with you` : `${who} shared ${plural(data.items.length, "item")} with you`,
      preheader: single ? `${KIND_LABELS[single.kind]} in Nook.` : `${plural(data.items.length, "item")} in Nook.`,
      eyebrow: "Sharing · Shared with you",
      title: single ? `${who} shared a ${KIND_LABELS[single.kind].toLowerCase()} with you` : `${who} shared ${plural(data.items.length, "item")} with you`,
      blocks: [context(rows, { more: data.items.length - rows.length })],
      action: single ? { label: `Open ${KIND_LABELS[single.kind].toLowerCase()}`, href: appLink(sharedItemPath(single)) } : { label: "Open Nook", href: appLink(aggregatePath(data.items)) },
      footer: activityFooter("sharing", "You got this because someone shared something with you by name in Nook.", ctx)
    });
  },
  fixture: () => ({
    actors: ["Priya Shah"],
    items: [
      { kind: "note", id: "7b2e7c80-3d4f-4e5a-8b6c-333333333333", title: "Launch checklist", access: "read" },
      { kind: "board", id: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111", title: "Launch", access: null },
      { kind: "calendar", id: "8c3f8d91-4e5a-4f6b-9c7d-444444444444", title: "Team calendar", access: "edit" }
    ]
  })
});

// --- Proposals awaiting you (#27): key names and counts only, never agent text (T233) --------

export const proposalsTemplate = defineTemplate<{ keys: Array<{ name: string; count: number }>; total: number; oldestExpiresAt: string | null }>({
  name: "inbox.proposals",
  class: "activity",
  category: "proposals",
  render(data, ctx) {
    const single = data.keys.length === 1 ? data.keys[0]! : null;
    const keyName = (name: string) => `Key “${cleanLine(name, 60, "unnamed")}”`;
    const subject = single ? `${keyName(single.name)} suggested ${plural(single.count, "change")}` : `${plural(data.total, "proposal")} awaiting your review`;
    return layout({
      instanceName: ctx.instanceName,
      subject,
      preheader: "Review them in your Inbox. Nothing changes until you approve.",
      eyebrow: "Inbox · Proposals",
      title: `${plural(data.total, "proposal")} awaiting you`,
      lead: "Your MCP keys suggested changes. Nothing changes until you approve them in the Inbox.",
      blocks: [context(data.keys.slice(0, LIST_MAX).map((key) => ({ title: keyName(key.name), meta: `${plural(key.count, "pending change")}` })), { more: data.keys.length - Math.min(data.keys.length, LIST_MAX), moreLabel: data.keys.length > LIST_MAX ? `and ${plural(data.keys.length - LIST_MAX, "more key")}` : undefined }),
        ...(data.oldestExpiresAt ? [note(`The oldest expires ${formatInstant(data.oldestExpiresAt, ctx.tz)}.`)] : [])],
      action: { label: "Review in Inbox", href: appLink(paths.inbox()) },
      footer: activityFooter("proposals", "You got this because MCP keys you own suggested changes that wait for you.", ctx)
    });
  },
  fixture: () => ({ keys: [{ name: "laptop", count: 3 }, { name: "ci-bot", count: 1 }], total: 4, oldestExpiresAt: "2026-10-01T09:00:00.000Z" })
});
