import { anchorsOf, keyReach, reachCovers, type ItemKind } from "./keyResources";
import type { McpScope } from "./mcpScopes";
import type { McpKeyContext } from "./mcpToolKit";

/**
 * Whether a key may see a FOREIGN item a tool presents (access plan T203): a relation's other card,
 * an event link's target, a collection note field's note. runTool checks the items a call names;
 * everything a handler shows about other items goes through here.
 *
 * A key may read a target when it holds the target module's read permission (a write implies it)
 * and, for a key whose grant names chosen items, the target lies inside one of them (a card's
 * board, a row's collection, an event's calendar, a note's folder or the note itself). The
 * owner's own access is checked separately by each module's resolver; a target that fails either
 * check is presented in the module's existing restricted shape, so "the key may not" and "the
 * owner cannot" look the same.
 *
 * A context with `person` set is a signed-in person approving a proposal (inbox): the key's reach
 * does not apply to them.
 */
export type ForeignTargetType = "note" | "card" | "collection_row" | "event";

const TARGET: Record<ForeignTargetType, { scope: McpScope; kind: ItemKind }> = {
  note: { scope: "notes:read", kind: "note" },
  card: { scope: "tasks:read", kind: "card" },
  collection_row: { scope: "collections:read", kind: "row" },
  event: { scope: "calendar:read", kind: "event" }
};

export function keyMayRead(key: McpKeyContext, target: { type: ForeignTargetType; id: string }): boolean {
  if (key.person) return true;
  const { scope, kind } = TARGET[target.type];
  const reach = keyReach(key, scope);
  if (reach === null) return false;
  if (reach === "all") return true;
  return reachCovers(reach, anchorsOf(kind, target.id));
}

/** A reader bound to one key, for presenters that take a predicate. */
export const foreignReader = (key: McpKeyContext) => (type: ForeignTargetType, id: string) => keyMayRead(key, { type, id });
export type ForeignReader = ReturnType<typeof foreignReader>;
