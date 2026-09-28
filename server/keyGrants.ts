/**
 * Nook key grants (docs/plan/research/2026-09-28-access-management-api-keys.md §C.2, §C.10,
 * D262–D265). Pure: no database access, so the client mirror (src/keys/keyGrants.ts) and the tests
 * share one vocabulary.
 *
 * A grant is `{module, permission, resource?}`. Permissions map one-to-one onto MCP scopes
 * (`scopeFor`), so tool registration keeps working on scopes: a key's scopes are a compatibility
 * view derived from its grants. A NULL resource is "all" (every resource in the module, including
 * future ones). A grant naming resources covers only those resources and, in Wave 31, only the
 * tools that declare which resource they touch (D281); everything else is hidden from it.
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

export type Grant = { module: GrantModule; permission: KeyPermission; resourceKind: ResourceKind | null; resourceId: string | null };

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
  "inbox:write": { module: "inbox", permission: "write" }
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
 * Which resource kinds a module's grants may name in Wave 31 (D281). Tasks, collections, and
 * calendar take their container; every other module is "all" only until Wave 34.
 */
export const SELECTOR_KINDS: Partial<Record<GrantModule, ResourceKind>> = { tasks: "board", collections: "collection", calendar: "calendar" };

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
 * What a key holds for one scope: `"all"`, a set of resource ids of one kind, or null (nothing).
 * A write grant on board A gives read on board A too.
 */
export type ScopeReach = "all" | { kind: ResourceKind; ids: ReadonlySet<string> } | null;

export function scopeReach(grants: readonly Grant[], scope: McpScope): ScopeReach {
  const needed = SCOPE_GRANTS[scope];
  let ids: Set<string> | null = null;
  let kind: ResourceKind | null = null;
  for (const grant of grants) {
    if (grant.module !== needed.module || !permissionImplies(grant.permission, needed.permission)) continue;
    if (grant.resourceKind === null) return "all";
    if (kind && grant.resourceKind !== kind) continue;
    kind = grant.resourceKind;
    ids ??= new Set();
    ids.add(grant.resourceId!);
  }
  return kind && ids ? { kind, ids } : null;
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
export const grantKey = (grant: Grant) => `${grant.module}:${grant.permission}:${grant.resourceKind ?? "*"}:${grant.resourceId ?? "*"}`;

/** Removes exact duplicate grants, keeping the first of each. */
export function dedupeGrants(grants: readonly Grant[]): Grant[] {
  const unique = new Map<string, Grant>();
  for (const grant of grants) unique.set(grantKey(grant), grant);
  return [...unique.values()];
}
