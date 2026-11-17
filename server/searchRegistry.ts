import type { Role } from "./team/roles";
import type { ModuleSearchResult } from "../shared/workspaceSearch";
import type { WorkspaceModuleId } from "../shared/workspaceModules";

/**
 * Search scopes registered by the workspace modules (docs/plan/WORKSPACE_MODULES.md §B.12): each
 * module searches its own FTS index with its own access predicate in the query, before LIMIT, and
 * returns titles and snippets only of items the caller can read. `GET /api/search?scope=<scope>`
 * runs one; `scope=all` runs every scope the caller has and merges the top results per scope.
 */
export type SearchScopeDef = {
  /** The `scope=` word, e.g. `forms`, `contacts`. */
  scope: string;
  /** The header in the All results ("Forms"). */
  label: string;
  module: WorkspaceModuleId;
  search: (input: { userId: string; role: Role; q: string; limit: number }) => { results: ModuleSearchResult[]; truncated: boolean } | Promise<{ results: ModuleSearchResult[]; truncated: boolean }>;
  /** Roles that have the module (default: every role but guest). */
  roles?: readonly Role[];
};

const scopes = new Map<string, SearchScopeDef>();
export const BUILTIN_SEARCH_SCOPES = ["notes", "collections", "whiteboards", "reports", "files", "cards", "events", "chats"] as const;

export function registerSearchScope(def: SearchScopeDef) {
  if (!/^[a-z][a-z_]{1,23}$/.test(def.scope) || (BUILTIN_SEARCH_SCOPES as readonly string[]).includes(def.scope) || def.scope === "all") throw new Error(`Invalid search scope ${def.scope}`);
  if (scopes.has(def.scope)) throw new Error(`Search scope ${def.scope} is already registered`);
  scopes.set(def.scope, def);
  return () => { if (scopes.get(def.scope) === def) scopes.delete(def.scope); };
}

export const searchScope = (scope: string) => scopes.get(scope) ?? null;
export const registeredSearchScopes = () => [...scopes.values()];
export const scopeAllowed = (def: SearchScopeDef, role: Role) => (def.roles ?? ["admin", "member", "viewer"]).includes(role);
