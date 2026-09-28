import { reactionGlyph, type ReactionAggregate, type ReactionKey } from "../../shared/reactions";

// Pure reaction-chip logic (WAVES_18-20_SMALL.md §3.5), unit-tested in tests/reactionsUi.test.tsx.

/** The optimistic state after the caller toggles `emoji`, and whether the toggle adds (PUT) or removes (DELETE). */
export function toggleAggregate(list: readonly ReactionAggregate[], emoji: ReactionKey): { next: ReactionAggregate[]; on: boolean } {
  const current = list.find((item) => item.emoji === emoji);
  if (!current) return { next: [...list, { emoji, count: 1, reacted: true, names: [], more: 0 }], on: true };
  if (current.reacted) {
    const next = current.count <= 1
      ? list.filter((item) => item.emoji !== emoji)
      : list.map((item) => item.emoji === emoji ? { ...item, count: item.count - 1, reacted: false } : item);
    return { next, on: false };
  }
  return { next: list.map((item) => item.emoji === emoji ? { ...item, count: item.count + 1, reacted: true } : item), on: true };
}

/**
 * `list` with only `emoji`'s entry set to `entry` (removed when undefined), keeping the others as they
 * are. A server answer or a rollback touches just its own emoji, so answers that arrive out of order
 * for different emoji never undo each other.
 */
export function replaceAggregate(list: readonly ReactionAggregate[], emoji: ReactionKey, entry: ReactionAggregate | undefined, index = -1): ReactionAggregate[] {
  const at = list.findIndex((item) => item.emoji === emoji);
  if (at >= 0) return entry ? list.map((item, position) => position === at ? entry : item) : list.filter((_, position) => position !== at);
  if (!entry) return [...list];
  const next = [...list];
  next.splice(index >= 0 && index <= next.length ? index : next.length, 0, entry);
  return next;
}

/** "Asha, Ben, and you"; the other names first, then "N others", then "you". */
export function reactionPeople(item: ReactionAggregate) {
  const people = [...item.names];
  if (item.more > 0) people.push(`${item.more} ${item.more === 1 ? "other" : "others"}`);
  if (item.reacted) people.push("you");
  if (people.length <= 1) return people[0] ?? "";
  if (people.length === 2) return `${people[0]} and ${people[1]}`;
  return `${people.slice(0, -1).join(", ")}, and ${people[people.length - 1]}`;
}

/** The chip's accessible name, e.g. "👍 3: Asha, Ben, and you. Press to remove yours." */
export function reactionChipLabel(item: ReactionAggregate, readOnly: boolean) {
  const base = `${reactionGlyph(item.emoji)} ${item.count}: ${reactionPeople(item)}.`;
  if (readOnly) return base;
  return `${base} ${item.reacted ? "Press to remove yours." : "Press to add yours."}`;
}
