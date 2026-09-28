/**
 * MCP key scopes (docs/plan/WAVES_7-9.md D36, WAVES_10-12.md D70). Pure: no
 * database access, so the client can share the vocabulary and tests can run
 * it in isolation.
 *
 * Scopes come in `<module>:read` / `<module>:write…` pairs. A write scope
 * implies its read scope. Scopes are fixed when a key is created.
 */
export const MCP_SCOPES = [
  "notes:read", "notes:write-draft", "files:read", "tasks:read", "tasks:write", "today:read",
  "calendar:read", "calendar:write", "collections:read", "collections:write",
  // Admin-only (server/team/roles.ts ADMIN_ONLY_SCOPES); there is no team write scope (D79).
  "team:read",
  // Agent inbox (Wave 21, D151): suggest changes for the key owner to approve; never applies anything.
  "inbox:read", "inbox:write"
] as const;
export type McpScope = typeof MCP_SCOPES[number];

export const DEFAULT_MCP_SCOPES: readonly McpScope[] = ["notes:read"];

/** Each write scope and the read scope it implies. Later modules add their pair here (D70). */
export const IMPLIED_READ_SCOPE: Partial<Record<McpScope, McpScope>> = {
  "notes:write-draft": "notes:read",
  "tasks:write": "tasks:read",
  "calendar:write": "calendar:read",
  "collections:write": "collections:read",
  "inbox:write": "inbox:read"
};

export const isMcpScope = (value: unknown): value is McpScope => typeof value === "string" && (MCP_SCOPES as readonly string[]).includes(value);

/** Adds implied read scopes, removes duplicates, and returns the scopes in canonical order. */
export function normalizeScopes(scopes: readonly McpScope[]): McpScope[] {
  const set = new Set<McpScope>(scopes);
  for (const scope of scopes) {
    const implied = IMPLIED_READ_SCOPE[scope];
    if (implied) set.add(implied);
  }
  return MCP_SCOPES.filter((scope) => set.has(scope));
}

/**
 * Reads the stored JSON column. Unknown values are dropped (a newer build may
 * have written them); anything unreadable grants the pre-scope default. Never
 * grants more than what is stored plus implied reads.
 */
export function parseStoredScopes(json: string | null | undefined): McpScope[] {
  if (!json) return [...DEFAULT_MCP_SCOPES];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [...DEFAULT_MCP_SCOPES];
    return normalizeScopes(value.filter(isMcpScope));
  } catch {
    return [...DEFAULT_MCP_SCOPES];
  }
}

/** Whether a key holding `held` may use something that needs `needed`. Write implies read. */
export function hasScope(held: readonly McpScope[], needed: McpScope) {
  if (held.includes(needed)) return true;
  return held.some((scope) => IMPLIED_READ_SCOPE[scope] === needed);
}

/** Whether `held` satisfies any one of `anyOf`. */
export const hasAnyScope = (held: readonly McpScope[], anyOf: readonly McpScope[]) => anyOf.some((scope) => hasScope(held, scope));
