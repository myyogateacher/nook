import { resolveContainer, type ToolResourceArg } from "./apiKeys";
import { scopeReach } from "./keyGrants";
import { hasScope, type McpScope } from "./mcpScopes";
import type { McpKeyContext } from "./mcpToolKit";

/**
 * Whether a key may see a FOREIGN item a tool presents (access plan T203): a relation's other card,
 * an event link's target, a collection note field's note. runTool checks only the one resource a
 * call names; everything a handler shows about other items goes through here.
 *
 * A key may read a target when it holds the target module's read permission (a write implies it)
 * and, for a key whose grant names chosen items, the target lies inside one of them (a card's
 * board, a row's collection, an event's calendar). The owner's own access is checked separately
 * by each module's resolver; a target that fails either check is presented in the module's
 * existing restricted shape, so "the key may not" and "the owner cannot" look the same.
 *
 * A context with `person` set is a signed-in person approving a proposal (inbox): the key's reach
 * does not apply to them.
 */
export type ForeignTargetType = "note" | "card" | "collection_row" | "event";

const TARGET_SCOPE: Record<ForeignTargetType, McpScope> = {
  note: "notes:read",
  card: "tasks:read",
  collection_row: "collections:read",
  event: "calendar:read"
};

/** The container lookup for kinds whose grants may name chosen containers (D281); notes are "all" only. */
const TARGET_CONTAINER: Partial<Record<ForeignTargetType, ToolResourceArg>> = { card: "card", collection_row: "row", event: "event" };

export function keyMayRead(key: McpKeyContext, target: { type: ForeignTargetType; id: string }): boolean {
  if (key.person) return true;
  const scope = TARGET_SCOPE[target.type];
  // A context loaded without grants holds its scopes over every item.
  if (!key.grants) return hasScope(key.scopes, scope);
  const reach = scopeReach(key.grants, scope);
  if (reach === null) return false;
  if (reach === "all") return true;
  const arg = TARGET_CONTAINER[target.type];
  if (!arg) return false;
  const container = resolveContainer(arg, target.id);
  return container !== null && container.kind === reach.kind && reach.ids.has(container.id);
}

/** A reader bound to one key, for presenters that take a predicate. */
export const foreignReader = (key: McpKeyContext) => (type: ForeignTargetType, id: string) => keyMayRead(key, { type, id });
export type ForeignReader = ReturnType<typeof foreignReader>;
