import { CARD_FLAGS, type BoardDetail, type BoardTag, type CardDetail, type CardFlag, type CardSummary } from "./tasksApi";

/** Tags and flags on cards (WAVE_13_TASK_CARD_UX.md D109, D110, §4.3). Pure, no DOM. */

export const MAX_TAGS_PER_CARD = 10;
export const TAG_NAME_MAX = 40;

export const FLAG_LABELS: Record<CardFlag, string> = { blocked: "Blocked", needs_review: "Needs review", on_hold: "On hold" };
/** Flag words for history entries, including the Urgent flag from before it became a priority (D1310). */
export const HISTORY_FLAG_LABELS: Record<string, string> = { urgent: "Urgent", ...FLAG_LABELS };

/** The card's tags in tagging order, resolved against the board's; ids the board no longer has are skipped. */
export function cardTags(tagIds: readonly string[] | undefined, tags: readonly BoardTag[]) {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  return (tagIds ?? []).flatMap((id) => byId.get(id) ?? []);
}

/** Toggles a flag and keeps the fixed order (D110). */
export function toggleFlag(flags: readonly CardFlag[], flag: CardFlag): CardFlag[] {
  const on = flags.includes(flag);
  return CARD_FLAGS.filter((item) => item === flag ? !on : flags.includes(item));
}

/** The first `max` items and how many more there are ("+N"). */
export function visibleItems<T>(items: readonly T[], max: number) {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** Tags sorted by name ignoring case, as the board payload orders them. */
export function sortTags(tags: readonly BoardTag[]) {
  return [...tags].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id));
}

/** Adds or replaces one tag, keeping the name order. */
export function upsertTag(tags: readonly BoardTag[], tag: BoardTag) {
  return sortTags([...tags.filter((item) => item.id !== tag.id), tag]);
}

/** What the pickers changed about the board's tags. */
export type TagChange = { kind: "saved"; tag: BoardTag } | { kind: "deleted"; tagId: string };

/** Applies a tag change to the board: a deleted tag also leaves every card (the server unlinked it). */
export function applyTagChange(detail: BoardDetail, change: TagChange): BoardDetail {
  const tags = detail.tags ?? [];
  if (change.kind === "saved") return { ...detail, tags: upsertTag(tags, change.tag) };
  return {
    ...detail,
    tags: tags.filter((tag) => tag.id !== change.tagId),
    cards: detail.cards.map((card) => card.tag_ids?.includes(change.tagId) ? { ...card, tag_ids: card.tag_ids.filter((id) => id !== change.tagId) } : card)
  };
}

/** Moves each tag's `card_count` by the difference between a card's old and new tags. */
export function recountTags(tags: readonly BoardTag[], before: readonly string[], after: readonly string[]) {
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  if (!added.length && !removed.length) return tags as BoardTag[];
  return tags.map((tag) => added.includes(tag.id)
    ? { ...tag, card_count: tag.card_count + 1 }
    : removed.includes(tag.id) ? { ...tag, card_count: Math.max(0, tag.card_count - 1) } : tag);
}

/** The lane card after the card dialog saved: every field it shows, but the board keeps the column. */
export function mergeCardDetail(item: CardSummary, card: CardDetail): CardSummary {
  return {
    ...item,
    title: card.title,
    revision: card.revision,
    has_description: card.description.trim() ? 1 : 0,
    description_excerpt: card.description_excerpt ?? item.description_excerpt,
    comment_count: card.comment_count,
    attachment_count: card.attachment_count,
    due_on: card.due_on,
    due_time: card.due_time,
    due_tz: card.due_tz,
    due_at: card.due_at,
    start_on: card.start_on,
    start_time: card.start_time,
    start_tz: card.start_tz,
    start_at: card.start_at,
    assignees: card.assignees,
    tag_ids: card.tag_ids ?? item.tag_ids,
    flags: card.flags ?? item.flags,
    priority: card.priority !== undefined ? card.priority : item.priority,
    column_id: item.column_id,
    // Hierarchy (17A): a reparent or level change saves through the same dialog.
    parent_card_id: card.parent_card_id !== undefined ? card.parent_card_id : item.parent_card_id,
    level: card.level ?? item.level,
    // Sprints (17B): the dialog's Sprint field, and a level change that clears it.
    sprint_id: card.sprint_id !== undefined ? card.sprint_id : item.sprint_id,
    // Auto-archive (D605): restoring from the dialog clears it.
    archived_at: card.archived_at !== undefined ? card.archived_at : item.archived_at,
    done_at: card.done_at !== undefined ? card.done_at : item.done_at,
    // Lane ESTIMATES (D754): the dialog's Estimate field.
    estimate: card.estimate !== undefined ? card.estimate : item.estimate,
    updated_at: card.updated_at
  };
}

/** Applies a saved card to the board: its lane card and the tag counts. */
export function applyCardDetail(detail: BoardDetail, card: CardDetail): BoardDetail {
  const item = detail.cards.find((candidate) => candidate.id === card.id);
  if (!item) return detail;
  const next = mergeCardDetail(item, card);
  return {
    ...detail,
    cards: detail.cards.map((candidate) => candidate.id === card.id ? next : candidate),
    ...(detail.tags ? { tags: recountTags(detail.tags, item.tag_ids ?? [], next.tag_ids ?? []) } : {})
  };
}

/** "Removes it from 3 cards." for the delete confirm. */
export function deleteTagMessage(tag: Pick<BoardTag, "name" | "card_count">) {
  const where = tag.card_count === 0 ? "No card uses it." : tag.card_count === 1 ? "It is removed from 1 card." : `It is removed from ${tag.card_count} cards.`;
  return `Delete “${tag.name}” for everyone on this board? ${where} This cannot be undone.`;
}
