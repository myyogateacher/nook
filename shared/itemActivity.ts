/**
 * Item activity and comments for the workspace modules (§B.5, D805): `item_activity` generalizes card
 * activity (D740–D746) to any item kind; cards keep `card_activity`. The payload shapes, the snapshot
 * labels, and the 2-minute coalescing are the same as shared/cardActivity.ts.
 *
 * ## Adding kinds (the extension point)
 *
 * A module registers its kinds once, from a file both the server and the client load
 * (`shared/<module>Activity.ts`):
 *
 *     export const GOAL_ACTIVITY = registerActivityKinds("goals", {
 *       created: { shape: "change", coalesce: false },
 *       title: { shape: "change", coalesce: true },
 *       checked_in: { shape: "event", coalesce: false }
 *     });
 *
 * The server records them with `recordItemActivity` / `recordItemChange` (server/activity/service.ts)
 * inside the write's transaction; the client draws them with renderers typed by the same object.
 * Generic kinds every item has (`linked`, `unlinked`, `commented`, `binned`, `restored`) are built in.
 */
import type { ActivityShape, ActivityValue, ActivityVia } from "./cardActivity";
import type { WorkKind } from "./workRefs";

export type { ActivityShape, ActivityValue, ActivityVia } from "./cardActivity";
export { ACTIVITY_COALESCE_MS, ACTIVITY_LABEL_MAX, ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, sameActivityValue } from "./cardActivity";

export type ActivityKindDef = { shape: ActivityShape; coalesce: boolean };

/** Kinds every item kind may record. `linked`/`unlinked` carry the other item in `item` (§B.4.3). */
export const GENERIC_ACTIVITY_KINDS = {
  created: { shape: "change", coalesce: false },
  linked: { shape: "item", coalesce: false },
  unlinked: { shape: "item", coalesce: false },
  binned: { shape: "event", coalesce: false },
  restored: { shape: "event", coalesce: false }
} as const satisfies Record<string, ActivityKindDef>;

const registry = new Map<string, { module: string; def: ActivityKindDef }>(
  Object.entries(GENERIC_ACTIVITY_KINDS).map(([kind, def]) => [kind, { module: "core", def }])
);

/**
 * Registers a module's activity kinds. Kind names are global (`item_activity.kind` is free text):
 * a module prefixes nothing, but two modules may not register the same name with different shapes.
 */
export function registerActivityKinds<K extends Record<string, ActivityKindDef>>(module: string, kinds: K): K {
  for (const [kind, def] of Object.entries(kinds)) {
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(kind)) throw new Error(`Invalid activity kind: ${kind}`);
    const existing = registry.get(kind);
    if (existing && (existing.def.shape !== def.shape || existing.def.coalesce !== def.coalesce)) throw new Error(`Activity kind ${kind} is already registered by ${existing.module} with another shape`);
    if (!existing) registry.set(kind, { module, def });
  }
  return kinds;
}

export const activityKindDef = (kind: string): ActivityKindDef | null => registry.get(kind)?.def ?? null;
export const registeredActivityKinds = () => [...registry.keys()];

export type ItemActivityPayload = {
  from?: ActivityValue | null;
  to?: ActivityValue | null;
  item?: ActivityValue & { kind?: WorkKind };
  count?: number;
  /** A small, module-defined detail (≤ 2 KiB as JSON): ids and labels only, never answer text or contact details (T505). */
  extra?: Record<string, string | number | boolean | null>;
};

/** One entry as GET /api/items/:kind/:id/activity returns it. */
export type ItemActivityEntry = {
  id: string;
  itemKind: WorkKind;
  itemId: string;
  kind: string;
  actorId: string | null;
  actorName: string;
  actorIsIntegration?: boolean;
  via: ActivityVia | "public" | null;
  payload: ItemActivityPayload;
  createdAt: string;
};

export const ITEM_COMMENT_MAX = 20_000;

/**
 * A mention in a comment's Markdown: `@[Ana Silva](user:<uuid>)`. The client inserts it from the
 * people picker and renders it as a chip; the server notifies each mentioned person who can read the
 * item (and no one else).
 */
export const MENTION_PATTERN = /@\[([^\]\n]{1,120})\]\(user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;
export const mentionMarkdown = (name: string, userId: string) => `@[${name.replace(/[[\]\n]/g, "")}](user:${userId})`;
export function mentionedUserIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(MENTION_PATTERN)].map((match) => match[2]!.toLowerCase()))];
}

/** At most this many people are notified by one write (docs/plan/MENTIONS.md D1327). */
export const MENTION_NOTIFY_MAX = 20;

/** Ids mentioned in `after` that `before` did not mention, in order (D1326: an edit notifies only new mentions). */
export function newMentionIds(before: string | null | undefined, after: string): string[] {
  const had = new Set(before ? mentionedUserIds(before) : []);
  return mentionedUserIds(after).filter((id) => !had.has(id));
}

export type MentionPart = { type: "text"; text: string } | { type: "mention"; name: string; userId: string };

/** Splits plain text into text runs and mentions, for chips (D1329). Pure. */
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ type: "text", text: text.slice(last, index) });
    parts.push({ type: "mention", name: match[1]!, userId: match[2]!.toLowerCase() });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** One person as GET /api/people/mentionable returns them (D1323). */
export type MentionCandidate = { id: string; displayName: string; avatarUrl: string | null; canRead: boolean };
export const MENTIONABLE_LIMIT_DEFAULT = 8;
export const MENTIONABLE_LIMIT_MAX = 20;
export const MENTION_QUERY_MAX = 40;

/** One comment as GET /api/items/:kind/:id/comments returns it. Replies sit one level under a top-level comment. */
export type ItemComment = {
  id: string;
  itemKind: WorkKind;
  itemId: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string;
  authorAvatarUrl?: string | null;
  /** Markdown; empty for a deleted comment that still has replies ("Comment deleted"). */
  body: string;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  /** Whether the viewer may edit or delete it (the author, or a manager of the item). */
  canEdit: boolean;
};
