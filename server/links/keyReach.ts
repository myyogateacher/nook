import type { McpKeyContext } from "../mcpToolKit";
import { anchorsOf, keyReach, reachCovers } from "../keyResources";
import { workKindAdapter } from "./adapters";
import type { WorkRef } from "../../shared/workRefs";

/**
 * Whether a key reaches an item of any kind: its module's read scope over the item's anchors (T203).
 * Links and link history show nothing of an item a key over chosen items cannot reach (list_links,
 * get_item_activity, get_card_activity; D1390).
 */
export function keyReachesRef(key: McpKeyContext) {
  return (ref: WorkRef) => {
    const adapter = workKindAdapter(ref.kind);
    if (!adapter) return false;
    const reach = keyReach(key, adapter.scopes.read);
    return reachCovers(reach, adapter.itemKind ? anchorsOf(adapter.itemKind, ref.id) : reach === "all" ? [] : null);
  };
}
