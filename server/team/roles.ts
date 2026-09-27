/**
 * Platform roles (docs/plan/research/2026-09-26-team-module.md §2, D71–D75). Pure: no database
 * access, so tests and the client mirror (src/team/teamRoles.ts) can share the vocabulary.
 *
 * A role is a ceiling on what per-item sharing already grants; it never grants content access by
 * itself. Only admins manage the team, and admins never bypass item ACLs (D73).
 */
import { IMPLIED_READ_SCOPE, MCP_SCOPES, type McpScope } from "../mcpScopes";

export const ROLES = ["admin", "member", "viewer", "guest"] as const;
export type Role = typeof ROLES[number];

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

/**
 * Roles an admin can assign: all four since Wave 15 enforces viewer and guest (the write gate, the
 * guest audience exclusion, and the MCP scope filter).
 */
export const SELECTABLE_ROLES: readonly Role[] = ROLES;

export type Capability =
  /** Anything that creates or changes owned or shared content. */
  | "content.write"
  | "sharing.write"
  | "files.upload"
  | "feeds.create"
  | "mcp.key.create"
  /** See the Team list (names and roles). */
  | "team.read"
  /** Change roles, block and unblock, sign others out, read the activity log and account metadata. */
  | "team.manage";

const CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: ["content.write", "sharing.write", "files.upload", "feeds.create", "mcp.key.create", "team.read", "team.manage"],
  member: ["content.write", "sharing.write", "files.upload", "feeds.create", "mcp.key.create", "team.read"],
  // Read-only roles (Wave 15): the write gate, the MCP scope filter, and the services enforce this.
  viewer: ["mcp.key.create", "team.read"],
  guest: []
};

/** Coarse, role-only capability check. Item-level checks stay in each module's access.ts. */
export const can = (role: Role, capability: Capability) => CAPABILITIES[role].includes(capability);

/** MCP scopes only admins may hold (D79: read only, no emails). */
export const ADMIN_ONLY_SCOPES: readonly McpScope[] = ["team:read"];

/** Read scopes: every scope that is not a write scope (none of them is implied by another). */
export const MCP_READ_SCOPES: readonly McpScope[] = MCP_SCOPES.filter((scope) => IMPLIED_READ_SCOPE[scope] === undefined);

/**
 * The MCP scopes a key of a user with `role` may use (§5.2.4, §7). Effective scopes are the stored
 * scopes intersected with these, computed on every request and tool call, so a demoted holder's key
 * loses what the new role cannot use on its next call (T81): admins everything, members everything
 * but the admin-only scopes, viewers read scopes only, guests nothing (O6).
 */
export function mcpScopesForRole(role: Role): McpScope[] {
  switch (role) {
    case "admin": return [...MCP_SCOPES];
    case "member": return MCP_SCOPES.filter((scope) => !ADMIN_ONLY_SCOPES.includes(scope));
    case "viewer": return MCP_READ_SCOPES.filter((scope) => !ADMIN_ONLY_SCOPES.includes(scope));
    case "guest": return [];
  }
}

/** Stored scopes narrowed to what the holder's current role allows. */
export function effectiveMcpScopes(stored: readonly McpScope[], role: Role): McpScope[] {
  const allowed = mcpScopesForRole(role);
  return stored.filter((scope) => allowed.includes(scope));
}

/**
 * True when the user `userExpression` names may be part of an `all_users` audience (D72, T84: every
 * role except guest). A primary-key lookup; SQLite evaluates the uncorrelated form once per
 * statement. An unknown user yields NULL, which never matches (fail closed).
 */
export const audienceAllUsersFor = (userExpression: string) =>
  `((SELECT u_aud.role FROM users u_aud WHERE u_aud.id = ${userExpression}) <> 'guest')`;

/**
 * The fragment every `x.visibility = 'all_users'` in server SQL must be ANDed with, for the caller
 * bound as `$userId` (§5.3). tests/guestAudience.test.ts fails on any bare `all_users` comparison.
 */
export const AUDIENCE_ALL_USERS = audienceAllUsersFor("$userId");
