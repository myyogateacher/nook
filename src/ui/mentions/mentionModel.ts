import { MENTION_QUERY_MAX, mentionMarkdown, type MentionCandidate } from "../../../shared/itemActivity";

/**
 * The @mention picker's pure parts (docs/plan/MENTIONS.md §3, D1321, D1322), shared by the textarea
 * picker (MentionTextarea) and the rich editor's (src/editor/mention.ts): where the "@query" at the
 * caret starts, what inserting a person does to the text, and how the keyboard moves through rows
 * (people who cannot read the item are shown but never selected).
 */

export type MentionTrigger = { start: number; query: string };

/** Characters that may come right before the "@" (or the text's start). */
const BEFORE = /[\s(]/;

/**
 * The "@query" ending at `caret`, or null. The "@" opens at the start of the text or after whitespace
 * or "("; the query has no newline or "@", is at most 40 characters, and never starts with "[" (that is
 * a mention already written out). Spaces are allowed ("Ana Si"): the picker closes on a space with no
 * matches instead (`closesOnSpace`).
 */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const limit = Math.max(0, caret - MENTION_QUERY_MAX - 1);
  for (let index = caret - 1; index >= limit; index -= 1) {
    const char = text[index]!;
    if (char === "\n") return null;
    if (char !== "@") continue;
    if (index > 0 && !BEFORE.test(text[index - 1]!)) return null;
    const query = text.slice(index + 1, caret);
    if (query.startsWith("[") || query.startsWith(" ") || query.includes("@")) return null;
    return { start: index, query };
  }
  return null;
}

/** A query that ends in a space and matched nobody closes the picker ("email me @ 5", "@ana and"). */
export const closesOnSpace = (query: string, matches: number) => matches === 0 && /\s$/.test(query);

/** The text with the "@query" replaced by the person's mention and a space, and where the caret goes. */
export function insertMention(text: string, trigger: MentionTrigger, caret: number, person: Pick<MentionCandidate, "id" | "displayName">) {
  const mention = `${mentionMarkdown(person.displayName, person.id)} `;
  const after = text.slice(caret);
  // A space already after the caret is not doubled.
  const insert = after.startsWith(" ") ? mention.trimEnd() : mention;
  return { text: `${text.slice(0, trigger.start)}${insert}${after}`, caret: trigger.start + insert.length + (after.startsWith(" ") ? 1 : 0) };
}

/** The first row that can be picked, or -1. */
export const firstSelectable = (people: readonly Pick<MentionCandidate, "canRead">[]) => people.findIndex((person) => person.canRead);

/** The next pickable row from `current` in `direction`, wrapping; -1 when there is none. */
export function moveSelection(people: readonly Pick<MentionCandidate, "canRead">[], current: number, direction: 1 | -1) {
  const count = people.length;
  if (!count) return -1;
  for (let step = 1; step <= count; step += 1) {
    const index = (((current < 0 ? (direction === 1 ? -1 : 0) : current) + direction * step) % count + count) % count;
    if (people[index]!.canRead) return index;
  }
  return -1;
}

/** What a key does while the picker is open: move, pick, close, or nothing (the field handles it). */
export function mentionKeyAction(key: string, modifiers: { shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean } = {}): "down" | "up" | "pick" | "close" | null {
  if (modifiers.meta || modifiers.ctrl || modifiers.alt) return null;
  if (key === "ArrowDown") return "down";
  if (key === "ArrowUp") return "up";
  if (key === "Enter" || (key === "Tab" && !modifiers.shift)) return "pick";
  if (key === "Escape") return "close";
  return null;
}

/** The muted line under a person who cannot read the item (D1324). */
export const cannotReadLabel = (noun: string) => `Can't see this ${noun}`;
