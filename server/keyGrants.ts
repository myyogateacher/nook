/**
 * Nook key grants (docs/plan/research/2026-09-28-access-management-api-keys.md §C.2, §C.10,
 * D262–D265). Pure: no database access, so the client mirror (src/keys/keyGrants.ts) and the tests
 * share one vocabulary.
 *
 * A grant is `{module, permission, resource?}`. Permissions map one-to-one onto MCP scopes
 * (`scopeFor`), so tool registration keeps working on scopes: a key's scopes are a compatibility
 * view derived from its grants. A NULL resource is "all" (every resource in the module, including
 * future ones). A grant naming resources covers only those resources and what sits directly in
 * them; every MCP tool declares what it touches (D281, Wave 34) and runTool enforces it.
 */
import { MCP_SCOPES, normalizeScopes, type McpScope } from "./mcpScopes";

export const GRANT_MODULES = ["notes", "files", "tasks", "today", "calendar", "collections", "team", "inbox", "bin", "whiteboards", "vault"] as const;
export type GrantModule = typeof GRANT_MODULES[number];

export const KEY_PERMISSIONS = ["read", "comment", "write", "draft", "publish", "create"] as const;
export type KeyPermission = typeof KEY_PERMISSIONS[number];

export const RESOURCE_KINDS = ["folder", "note", "document", "board", "task_view", "collection", "calendar", "routine", "whiteboard", "vault"] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];

export type KeyKind = "general" | "vault";
export type KeySurfaces = "mcp" | "rest" | "both";
export const KEY_SURFACES: readonly KeySurfaces[] = ["mcp", "rest", "both"];

/**
 * One grant row. `envId` is for vault grants only (Wave 27, D264): one environment of the vault the
 * grant names, or null/absent for every environment of it (protected ones excepted, see
 * server/vault/access.ts).
 */
export type Grant = {
  module: GrantModule; permission: KeyPermission; resourceKind: ResourceKind | null; resourceId: string | null; envId?: string | null;
  /** Vault grants naming an environment (Wave 27 fixes, L2): it was protected when the grant was made on a key allowed protected environments. */
  protectedAtGrant?: boolean;
};

/** The permissions a vault key's grants may hold (Wave 27): read, and write (which implies read). */
export const VAULT_KEY_PERMISSIONS = ["read", "write"] as const;

/** Every MCP scope and the grant it is (D262). Wave 19 scopes included; later modules add a row. */
export const SCOPE_GRANTS: Record<McpScope, { module: GrantModule; permission: KeyPermission }> = {
  "notes:read": { module: "notes", permission: "read" },
  "notes:write-draft": { module: "notes", permission: "draft" },
  "notes:publish": { module: "notes", permission: "publish" },
  "files:read": { module: "files", permission: "read" },
  "files:write": { module: "files", permission: "write" },
  "tasks:read": { module: "tasks", permission: "read" },
  "tasks:write": { module: "tasks", permission: "write" },
  "today:read": { module: "today", permission: "read" },
  "calendar:read": { module: "calendar", permission: "read" },
  "calendar:write": { module: "calendar", permission: "write" },
  "collections:read": { module: "collections", permission: "read" },
  "collections:write": { module: "collections", permission: "write" },
  "bin:write": { module: "bin", permission: "write" },
  "team:read": { module: "team", permission: "read" },
  "inbox:read": { module: "inbox", permission: "read" },
  "inbox:write": { module: "inbox", permission: "write" },
  "whiteboards:read": { module: "whiteboards", permission: "read" },
  "whiteboards:write": { module: "whiteboards", permission: "write" }
};

export const scopeToGrant = (scope: McpScope) => SCOPE_GRANTS[scope];

/** The MCP scope a `{module, permission}` pair is, or null when no tool uses it yet. */
export function scopeFor(module: GrantModule, permission: KeyPermission): McpScope | null {
  for (const scope of MCP_SCOPES) {
    const grant = SCOPE_GRANTS[scope];
    if (grant.module === module && grant.permission === permission) return scope;
  }
  return null;
}

/** The permissions a key may hold per module in Wave 31: exactly those that have MCP tools. */
export function permissionsForModule(module: GrantModule): KeyPermission[] {
  return KEY_PERMISSIONS.filter((permission) => scopeFor(module, permission) !== null);
}

/** The modules a general key may hold grants in (vault grants need a vault key, D264). */
export const GENERAL_KEY_MODULES: readonly GrantModule[] = GRANT_MODULES.filter((module) => module !== "vault" && permissionsForModule(module).length > 0);

/**
 * Which resource kinds a module's grants may name (D281, Wave 34). A grant on a container covers
 * the items directly inside it (a card's board, a row's collection, an event's calendar, a note's
 * or file's immediate folder; folders never cascade, D271). The first kind is the module's main
 * one: a grant input that sends bare `resourceIds` names items of that kind. Task views are read
 * only (a saved query, never a write target); Today, Team, and the Bin cover every item.
 */
export const SELECTOR_KINDS: Partial<Record<GrantModule, readonly ResourceKind[]>> = {
  notes: ["folder", "note"],
  files: ["folder", "document"],
  tasks: ["board", "task_view"],
  collections: ["collection"],
  calendar: ["calendar"],
  inbox: ["routine"],
  whiteboards: ["whiteboard"]
};

/**
 * Permissions that only create something new and act on no existing item (review Q7): chosen items
 * would give them nothing to do (create_whiteboard is hidden from chosen-item keys), so they take none.
 */
export const CREATE_ONLY: ReadonlySet<string> = new Set(["whiteboards:write"]);

/** Kinds that can only be named with the read permission (a saved view is never written through a key). */
export const READ_ONLY_KINDS: readonly ResourceKind[] = ["task_view"];

/** What a permission implies (write ⇒ read, draft ⇒ read, publish ⇒ read, comment ⇒ read). */
export function permissionImplies(held: KeyPermission, needed: KeyPermission) {
  if (held === needed) return true;
  return needed === "read" && ["write", "comment", "draft", "publish", "create"].includes(held);
}

/** The scopes a set of grants amounts to, with implied reads (the compatibility view, D262). */
export function grantsToScopes(grants: readonly Pick<Grant, "module" | "permission">[]): McpScope[] {
  const scopes: McpScope[] = [];
  for (const grant of grants) {
    const scope = scopeFor(grant.module, grant.permission);
    if (scope) scopes.push(scope);
  }
  return normalizeScopes(scopes);
}

/** "all" grants for scopes, as the alias `/api/mcp/keys` and the 025 backfill create them. */
export const grantsForScopes = (scopes: readonly McpScope[]): Grant[] =>
  normalizeScopes(scopes).map((scope) => ({ ...SCOPE_GRANTS[scope], resourceKind: null, resourceId: null }));

/**
 * What a key holds for one scope: `"all"`, chosen items (ids per kind, possibly of several kinds:
 * notes in a folder and single notes), or null (nothing). A write grant on board A gives read on
 * board A too.
 */
export type Selection = { kinds: ReadonlyMap<ResourceKind, ReadonlySet<string>> };
export type ScopeReach = "all" | Selection | null;

export function scopeReach(grants: readonly Grant[], scope: McpScope): ScopeReach {
  const needed = SCOPE_GRANTS[scope];
  let kinds: Map<ResourceKind, Set<string>> | null = null;
  for (const grant of grants) {
    if (grant.module !== needed.module || !permissionImplies(grant.permission, needed.permission)) continue;
    if (grant.resourceKind === null) return "all";
    kinds ??= new Map();
    const ids = kinds.get(grant.resourceKind) ?? new Set<string>();
    ids.add(grant.resourceId!);
    kinds.set(grant.resourceKind, ids);
  }
  return kinds ? { kinds } : null;
}

/** Whether a selection names `kind`/`id`. */
export const selectionHas = (selection: Selection, kind: ResourceKind, id: string) => selection.kinds.get(kind)?.has(id) ?? false;

/** The ids of one kind in a reach; empty for "all" and null, which callers handle first. */
export const selectionIds = (reach: ScopeReach, kind: ResourceKind): string[] => reach && reach !== "all" ? [...(reach.kinds.get(kind) ?? [])] : [];

/** Items narrowed to chosen ids (null: every item), for whole lists that have no LIMIT to cut. */
export const onlyChosen = <T extends { id: string }>(items: readonly T[], ids: readonly string[] | null): T[] =>
  ids === null ? [...items] : items.filter((item) => ids.includes(item.id));

/** The union of two reaches (a tool that any one of several scopes allows). */
export function unionReach(a: ScopeReach, b: ScopeReach): ScopeReach {
  if (a === "all" || b === "all") return "all";
  if (!a) return b;
  if (!b) return a;
  const kinds = new Map<ResourceKind, Set<string>>();
  for (const source of [a, b]) for (const [kind, ids] of source.kinds) kinds.set(kind, new Set([...(kinds.get(kind) ?? []), ...ids]));
  return { kinds };
}

/** Whether `grant` covers `needed` on a resource (or on its container). */
export function covers(grant: Grant, needed: { module: GrantModule; permission: KeyPermission; resource?: { kind: ResourceKind; id: string } }) {
  if (grant.module !== needed.module || !permissionImplies(grant.permission, needed.permission)) return false;
  if (grant.resourceKind === null) return true;
  return Boolean(needed.resource && needed.resource.kind === grant.resourceKind && needed.resource.id === grant.resourceId);
}

/**
 * Whether `next` only narrows `current` (D278): every next grant must be covered by a current one
 * (same module, an implied-or-equal permission, and the same or a narrower resource).
 */
export function isNarrowing(current: readonly Grant[], next: readonly Grant[]) {
  return next.every((grant) => current.some((held) => held.module === grant.module && permissionImplies(held.permission, grant.permission)
    && (held.resourceKind === null || (held.resourceKind === grant.resourceKind && held.resourceId === grant.resourceId))));
}

/** A stable identity for one grant row, for de-duplicating. */
export const grantKey = (grant: Grant) => `${grant.module}:${grant.permission}:${grant.resourceKind ?? "*"}:${grant.resourceId ?? "*"}:${grant.envId ?? "*"}`;

/** Removes exact duplicate grants, keeping the first of each. */
export function dedupeGrants(grants: readonly Grant[]): Grant[] {
  const unique = new Map<string, Grant>();
  for (const grant of grants) unique.set(grantKey(grant), grant);
  return [...unique.values()];
}
