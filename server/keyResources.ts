import { db } from "./db";
import { scopeReach, grantsForScopes, selectionHas, unionReach, type ResourceKind, type ScopeReach } from "./keyGrants";
import { hasScope, type McpScope } from "./mcpScopes";
import type { McpKeyContext } from "./mcpToolKit";

/**
 * Where an item sits, for chosen-item keys (access plan D281, §C.10, T203; Wave 34).
 *
 * A tool declares which argument names which kind of item (server/mcpToolKit.ts `ToolAccess`).
 * Before its handler runs, runTool resolves each named item to its **anchors**: the item itself
 * and its container (a card's board, a note's or file's immediate folder, a run's routine). A
 * key limited to chosen items reaches the item when one anchor is among them. Missing items and
 * items outside the grant look the same (NOT_FOUND, T205).
 *
 * List tools cannot be checked item by item, so their handlers narrow their SQL with
 * `keyFilter`, before any LIMIT or page cut, so counts and pages only ever hold granted items.
 */

export type ItemKind =
  | "note" | "folder" | "document" | "whiteboard"
  | "board" | "card" | "column" | "sprint" | "task_view"
  | "collection" | "row"
  | "calendar" | "event"
  | "routine" | "run"
  // Wave 27: a vault (its tools run only for `nkv_` vault keys; server/vault/mcpTools.ts).
  | "vault";

export type Anchor = { kind: ResourceKind; id: string };

type Lookup = { sql: string; anchors: (row: Record<string, string | null>) => Array<Anchor | null> };

const direct = (kind: ResourceKind) => (id: string): Anchor[] => [{ kind, id }];

const LOOKUPS: Record<ItemKind, Lookup | ((id: string) => Anchor[])> = {
  note: { sql: "SELECT id, folder_id FROM notes WHERE id = ?", anchors: (row) => [{ kind: "note", id: row.id! }, row.folder_id ? { kind: "folder", id: row.folder_id } : null] },
  folder: { sql: "SELECT id FROM folders WHERE id = ?", anchors: (row) => [{ kind: "folder", id: row.id! }] },
  // A whiteboard is a Files document too: Files grants reach it through its id or folder, whiteboard grants through its id.
  document: {
    sql: "SELECT d.id, d.folder_id, w.document_id AS whiteboard FROM documents d LEFT JOIN whiteboards w ON w.document_id = d.id WHERE d.id = ?",
    anchors: (row) => [{ kind: "document", id: row.id! }, row.folder_id ? { kind: "folder", id: row.folder_id } : null, row.whiteboard ? { kind: "whiteboard", id: row.whiteboard } : null]
  },
  whiteboard: { sql: "SELECT document_id AS id FROM whiteboards WHERE document_id = ?", anchors: (row) => [{ kind: "whiteboard", id: row.id! }] },
  board: direct("board"),
  card: { sql: "SELECT board_id FROM cards WHERE id = ?", anchors: (row) => [{ kind: "board", id: row.board_id! }] },
  column: { sql: "SELECT board_id FROM board_columns WHERE id = ?", anchors: (row) => [{ kind: "board", id: row.board_id! }] },
  sprint: { sql: "SELECT board_id FROM board_sprints WHERE id = ?", anchors: (row) => [{ kind: "board", id: row.board_id! }] },
  task_view: direct("task_view"),
  collection: direct("collection"),
  row: { sql: "SELECT collection_id FROM collection_rows WHERE id = ?", anchors: (row) => [{ kind: "collection", id: row.collection_id! }] },
  calendar: direct("calendar"),
  event: { sql: "SELECT calendar_id FROM events WHERE id = ?", anchors: (row) => [{ kind: "calendar", id: row.calendar_id! }] },
  routine: direct("routine"),
  vault: direct("vault"),
  run: { sql: "SELECT routine_id FROM routine_runs WHERE id = ?", anchors: (row) => [{ kind: "routine", id: row.routine_id! }] }
};

/** The kinds an item of `kind` can be anchored on (static: for hiding tools a key can never use). */
export const ANCHOR_KINDS: Record<ItemKind, readonly ResourceKind[]> = {
  note: ["note", "folder"], folder: ["folder"], document: ["document", "folder", "whiteboard"], whiteboard: ["whiteboard"],
  board: ["board"], card: ["board"], column: ["board"], sprint: ["board"], task_view: ["task_view"],
  collection: ["collection"], row: ["collection"], calendar: ["calendar"], event: ["calendar"], routine: ["routine"], run: ["routine"],
  vault: ["vault"]
};

/** The anchors of one item, or null when it does not exist. Ids compare in lower case. */
export function anchorsOf(kind: ItemKind, id: string): Anchor[] | null {
  const lookup = LOOKUPS[kind];
  const lower = id.toLowerCase();
  if (typeof lookup === "function") return lookup(lower);
  const row = db.query(lookup.sql).get(lower) as Record<string, string | null> | null;
  return row ? lookup.anchors(row).filter((anchor): anchor is Anchor => anchor !== null) : null;
}

/** Whether `reach` covers an item with these anchors. */
export function reachCovers(reach: ScopeReach, anchors: readonly Anchor[] | null) {
  if (reach === null || anchors === null) return false;
  if (reach === "all") return true;
  return anchors.some((anchor) => selectionHas(reach, anchor.kind, anchor.id));
}

/** Whether `reach` could ever cover an item of `kind` (it names a kind the item anchors on). */
export function reachCanCover(reach: ScopeReach, kind: ItemKind) {
  if (reach === null) return false;
  if (reach === "all") return true;
  return ANCHOR_KINDS[kind].some((anchorKind) => (reach.kinds.get(anchorKind)?.size ?? 0) > 0);
}

/**
 * What the key reaches for a scope now: from its effective grants, or its scopes over every item
 * when the context carries none (tests). A signed-in person approving a proposal is not limited.
 */
export function keyReach(key: McpKeyContext, scope: McpScope): ScopeReach {
  if (key.person) return "all";
  if (!key.grants) return hasScope(key.scopes, scope) ? "all" : null;
  return scopeReach(key.grants, scope);
}

/** The union of the reaches of several scopes (a tool allowed by any one of them). */
export const keyReachAny = (key: McpKeyContext, scopes: readonly McpScope[]) => scopes.reduce<ScopeReach>((reach, scope) => unionReach(reach, keyReach(key, scope)), null);

/** A contexts' grants, or "all" grants for its scopes, for callers that need the list. */
export const grantsOfKey = (key: McpKeyContext) => key.grants ?? grantsForScopes(key.scopes);

// ------------------------------------------------------------------ SQL filters for list tools

/** An SQL condition plus its named parameters (merge them into the statement's own). */
export type SqlFilter = { sql: string; params: Record<string, string> };

export const NO_FILTER: SqlFilter = { sql: "1", params: {} };
export const NOTHING: SqlFilter = { sql: "0", params: {} };

let filterCounter = 0;

/**
 * The condition that keeps only rows the reach covers. `columns` maps each kind a row can be
 * anchored on to its SQL column (for notes: `{ note: "n.id", folder: "n.folder_id" }`). "all" is
 * `1`; nothing (or only kinds the row cannot anchor on) is `0`. Parameters are JSON arrays read
 * with json_each, so a long selection is one bound value per kind.
 */
export function reachFilter(reach: ScopeReach, columns: Partial<Record<ResourceKind, string>>): SqlFilter {
  if (reach === "all") return NO_FILTER;
  if (reach === null) return NOTHING;
  const terms: string[] = [];
  const params: Record<string, string> = {};
  for (const [kind, column] of Object.entries(columns) as Array<[ResourceKind, string]>) {
    const ids = reach.kinds.get(kind);
    if (!ids?.size) continue;
    const name = `keyReach${(filterCounter = (filterCounter + 1) % 1_000_000)}`;
    params[name] = JSON.stringify([...ids]);
    terms.push(`${column} IN (SELECT value FROM json_each($${name}))`);
  }
  return terms.length ? { sql: `(${terms.join(" OR ")})`, params } : NOTHING;
}

/** `reachFilter` for a key and scope (a session, or a key over every item, gets `1`). */
export const keyFilter = (key: McpKeyContext | null | undefined, scope: McpScope, columns: Partial<Record<ResourceKind, string>>) =>
  key ? reachFilter(keyReach(key, scope), columns) : NO_FILTER;

/** The ids a key may list of one container kind, or null when it reaches every one (no narrowing needed). */
export function keyContainerIds(key: McpKeyContext, scope: McpScope, kind: ResourceKind): string[] | null {
  const reach = keyReach(key, scope);
  if (reach === "all") return null;
  if (reach === null) return [];
  return [...(reach.kinds.get(kind) ?? [])];
}
