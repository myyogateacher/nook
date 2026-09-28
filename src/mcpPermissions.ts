/**
 * MCP key permissions as the Settings dialog shows them. Mirrors
 * server/mcpScopes.ts (tests/mcpPermissions.test.ts keeps them in step).
 * Pure, so the checkbox rules are unit-tested.
 */
export type McpScope = "notes:read" | "notes:write-draft" | "files:read" | "tasks:read" | "tasks:write" | "today:read"
  | "calendar:read" | "calendar:write" | "collections:read" | "collections:write" | "team:read"
  | "inbox:read" | "inbox:write";

export type McpPermission = { scope: McpScope; label: string; help: string; implies?: McpScope };

export const MCP_PERMISSIONS: readonly McpPermission[] = [
  { scope: "notes:read", label: "Read notes", help: "Published notes you can open, note search, and folders." },
  { scope: "notes:write-draft", label: "Write drafts", help: "Create notes and edit drafts of your own notes; never publishes.", implies: "notes:read" },
  { scope: "files:read", label: "Read files", help: "File details and the text of text files up to 1 MiB." },
  { scope: "tasks:read", label: "Read tasks", help: "Read boards and cards" },
  { scope: "tasks:write", label: "Write tasks", help: "Create, move, and comment on cards: never deletes", implies: "tasks:read" },
  { scope: "today:read", label: "Read Today", help: "The Today summary, limited to the other read permissions this key has" },
  { scope: "calendar:read", label: "Read calendar", help: "Calendars, events, and their links you can open" },
  { scope: "calendar:write", label: "Write calendar", help: "Create and change events, and set your own reminders: never deletes", implies: "calendar:read" },
  { scope: "collections:read", label: "Read collections", help: "Collections you can open, their fields, and their rows; attachments as names only" },
  { scope: "collections:write", label: "Write collections", help: "Add and change rows where you can edit: never deletes, and never changes fields or sharing", implies: "collections:read" },
  { scope: "team:read", label: "Read team", help: "Names, roles, and status of accounts; never emails. Admins only, and it stops working if you stop being an admin" },
  { scope: "inbox:read", label: "Read inbox", help: "See your routines and this key's own proposals" },
  { scope: "inbox:write", label: "Suggest changes", help: "Suggest changes for you to approve in the Inbox. Never applies anything; each suggestion also needs that module's read permission", implies: "inbox:read" }
];

/** The permissions offered when creating a key: every scope that has tools. */
export const OFFERED_MCP_PERMISSIONS = MCP_PERMISSIONS;

/** Scopes only admins may hold (mirrors server/team/roles.ts ADMIN_ONLY_SCOPES). */
export const ADMIN_ONLY_MCP_SCOPES: readonly McpScope[] = ["team:read"];

/** Scopes only members and admins may hold (mirrors server/team/roles.ts MEMBER_ONLY_SCOPES). */
export const MEMBER_ONLY_MCP_SCOPES: readonly McpScope[] = ["inbox:read", "inbox:write"];

/**
 * The permissions Settings offers to someone with `role` (mirrors server mcpScopesForRole): admins
 * everything, members all but team:read, viewers read permissions only, guests none (no key UI).
 */
export function offeredMcpPermissions(role: string | undefined) {
  if (role === "guest") return [];
  const forRole = role === "admin" ? OFFERED_MCP_PERMISSIONS : OFFERED_MCP_PERMISSIONS.filter((permission) => !ADMIN_ONLY_MCP_SCOPES.includes(permission.scope));
  return role === "viewer" ? forRole.filter((permission) => !isWriteScope(permission.scope) && !MEMBER_ONLY_MCP_SCOPES.includes(permission.scope)) : forRole;
}

/** Write scopes are the ones that imply a read scope. */
export const isWriteScope = (scope: McpScope) => MCP_PERMISSIONS.some((permission) => permission.scope === scope && permission.implies !== undefined);

/** Whether Settings shows the key form at all (guests cannot hold keys, O6). */
export const canCreateMcpKeys = (role: string | undefined) => role !== "guest";

export const DEFAULT_KEY_SCOPES: readonly McpScope[] = ["notes:read"];

const order = MCP_PERMISSIONS.map((permission) => permission.scope);
const sorted = (scopes: Iterable<McpScope>) => order.filter((scope) => new Set(scopes).has(scope));

/** Read scopes that a checked write scope holds on (shown checked and disabled). */
export function lockedScopes(selected: readonly McpScope[]): McpScope[] {
  return sorted(MCP_PERMISSIONS.filter((permission) => permission.implies && selected.includes(permission.scope)).map((permission) => permission.implies!));
}

/** Applies one checkbox change: checking a write scope also checks its read scope, and a locked read scope stays checked. */
export function toggleScope(selected: readonly McpScope[], scope: McpScope, checked: boolean): McpScope[] {
  const next = new Set(selected);
  if (checked) {
    next.add(scope);
    const implied = MCP_PERMISSIONS.find((permission) => permission.scope === scope)?.implies;
    if (implied) next.add(implied);
  } else if (!lockedScopes(selected).includes(scope)) {
    next.delete(scope);
  }
  return sorted(next);
}

/** Short chip label for a stored scope; unknown scopes show as stored. */
export function scopeLabel(scope: string) {
  return MCP_PERMISSIONS.find((permission) => permission.scope === scope)?.label ?? scope;
}

export type ScopeChip = { scope: string; label: string; active: boolean };

/**
 * The chips of a listed key: every stored scope, marked inactive when the key cannot use it under
 * the owner's current role (a demoted admin's `team:read`). Without `effectiveScopes` (an older
 * server) every stored scope counts as active.
 */
export function keyScopeChips(scopes: readonly string[], effectiveScopes?: readonly string[]): ScopeChip[] {
  return scopes.map((scope) => {
    const active = !effectiveScopes || effectiveScopes.includes(scope);
    const suffix = active ? "" : (ADMIN_ONLY_MCP_SCOPES as readonly string[]).includes(scope) ? " (admins only, inactive)" : " (inactive)";
    return { scope, label: `${scopeLabel(scope)}${suffix}`, active };
  });
}
