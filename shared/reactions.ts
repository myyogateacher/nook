// The curated reaction set (WAVES_18-20_SMALL.md D183), shared by the server and the client. Rows store
// the stable key; the glyph is looked up here, so a glyph can change with no data migration and
// nothing outside this table is ever accepted or rendered (T153).

export const REACTIONS = [
  { key: "thumbs_up", glyph: "👍", label: "Thumbs up" },
  { key: "thumbs_down", glyph: "👎", label: "Thumbs down" },
  { key: "heart", glyph: "❤️", label: "Heart" },
  { key: "laugh", glyph: "😂", label: "Laugh" },
  { key: "tada", glyph: "🎉", label: "Party" },
  { key: "eyes", glyph: "👀", label: "Eyes" },
  { key: "rocket", glyph: "🚀", label: "Rocket" },
  { key: "check", glyph: "✅", label: "Check" },
  { key: "fire", glyph: "🔥", label: "Fire" },
  { key: "thinking", glyph: "🤔", label: "Thinking" },
  { key: "pray", glyph: "🙏", label: "Thanks" },
  { key: "sad", glyph: "😢", label: "Sad" }
] as const;

export type ReactionKey = (typeof REACTIONS)[number]["key"];

export const REACTION_KEYS: readonly ReactionKey[] = REACTIONS.map((reaction) => reaction.key);

const byKey = new Map<string, (typeof REACTIONS)[number]>(REACTIONS.map((reaction) => [reaction.key, reaction]));

export function isReactionKey(value: unknown): value is ReactionKey {
  return typeof value === "string" && byKey.has(value);
}

export function reactionGlyph(key: ReactionKey) {
  return byKey.get(key)!.glyph;
}

export function reactionLabel(key: ReactionKey) {
  return byKey.get(key)!.label;
}

/** At most this many names per aggregate; `more` counts the rest (D186). */
export const REACTION_NAMES_MAX = 10;

/**
 * One emoji's reactions on one target, as the caller sees them. `names` are the other people who
 * reacted (never the caller: `reacted` says that), oldest first, at most 10; `more` counts the other
 * people beyond those. So `count = names.length + more + (reacted ? 1 : 0)`.
 */
export type ReactionAggregate = { emoji: ReactionKey; count: number; reacted: boolean; names: string[]; more: number };
