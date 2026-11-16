import { db } from "../db";
import { workKindAdapter } from "../links/adapters";
import { notify, type NotifyModule } from "../notify";
import { MENTION_NOTIFY_MAX, newMentionIds } from "../../shared/itemActivity";
import { WORK_KIND_LABELS, WORK_KIND_MODULE, type WorkKind } from "../../shared/workRefs";

/**
 * @mention notifications (docs/plan/MENTIONS.md §5, D1325–D1327, T662), shared by item comments
 * (server/activity/comments.ts) and cards (comments and descriptions, server/tasks/*). Call inside
 * the write's transaction:
 *
 * - only ids `text` mentions that `before` did not (an edit notifies new mentions only);
 * - never the author; only people who can read the item now (the work kind adapter's level);
 * - at most MENTION_NOTIFY_MAX people per write, in the order the text names them;
 * - one unread row per person and item (`dedupeKey mention:<kind>:<id>`).
 *
 * The title holds the author's name and the item's kind word only, never the text (T505, T662).
 * Returns the people notified (the caller may record them, e.g. the card's `mentioned` history).
 */

/** The app a kind's notification belongs to: a workspace module, or a core app (D1325). */
const CORE_KIND_MODULE: Partial<Record<WorkKind, NotifyModule>> = { card: "tasks", board: "tasks", sprint: "tasks", note: "notes" };

export function mentionNotifyModule(kind: WorkKind): NotifyModule | null {
  return WORK_KIND_MODULE[kind] ?? CORE_KIND_MODULE[kind] ?? null;
}

/** Of `userIds`, the people (active, never integrations) who can read the item, in order. */
export function mentionReaders(kind: WorkKind, itemId: string, userIds: readonly string[]): string[] {
  const adapter = workKindAdapter(kind);
  if (!adapter || !userIds.length) return [];
  const people = new Set((db.query(`SELECT id FROM users WHERE kind = 'person' AND disabled_at IS NULL AND id IN (${userIds.map(() => "?").join(",")})`)
    .all(...userIds) as Array<{ id: string }>).map((row) => row.id));
  return userIds.filter((userId) => people.has(userId) && adapter.level(itemId, { userId }) !== "none");
}

export function notifyMentions(input: { kind: WorkKind; itemId: string; authorId: string; text: string; before?: string | null; where?: string }): string[] {
  const module = mentionNotifyModule(input.kind);
  const adapter = workKindAdapter(input.kind);
  if (!module || !adapter) return [];
  const fresh = newMentionIds(input.before, input.text).filter((userId) => userId !== input.authorId);
  const mentioned = mentionReaders(input.kind, input.itemId, fresh).slice(0, MENTION_NOTIFY_MAX);
  if (!mentioned.length) return [];
  const author = (db.query("SELECT display_name FROM users WHERE id = ?").get(input.authorId) as { display_name: string } | null)?.display_name ?? "Someone";
  // Each mentioned reader can open the item, so its href and kind word are theirs to see.
  const summary = adapter.resolve([input.itemId], { userId: mentioned[0]! }).get(input.itemId);
  notify({
    userIds: mentioned, module, topic: "core.mention", actor: input.authorId,
    title: `${author} mentioned you ${input.where ?? `on a ${WORK_KIND_LABELS[input.kind].toLowerCase()}`}`,
    href: summary?.href ?? "/notifications", item: { kind: input.kind, id: input.itemId }, dedupeKey: `mention:${input.kind}:${input.itemId}`
  });
  return mentioned;
}
