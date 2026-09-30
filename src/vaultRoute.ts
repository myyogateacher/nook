import type { Route } from "./router";

export type VaultRoute = Extract<Route, { app: "vault" }>;

/** A Vault route: the list, one vault (optionally one environment), one secret, or a vault's Access or Activity page. */
export function vaultRoute(vaultId: string | null = null, options: { envId?: string | null; secretId?: string | null; page?: "access" | "activity" | null } = {}): VaultRoute {
  return { app: "vault", vaultId, envId: vaultId ? options.envId ?? null : null, secretId: vaultId ? options.secretId ?? null : null, page: vaultId ? options.page ?? null : null };
}

/**
 * In-app Back (the ‹ in the vault and secret headers, and the list's Home): step back through
 * entries this visit pushed (the `mynotes.depth` counter), so it matches the browser's Back; from a
 * deep link replace the page with its parent (secret, Access, or Activity → its vault; vault → the list); from the list
 * go Home. It never leaves Nook.
 */
export function vaultBackAction(route: VaultRoute, depth: number): { kind: "history" } | { kind: "replace"; route: VaultRoute } | { kind: "home" } {
  if (!route.vaultId) return { kind: "home" };
  if (depth > 0) return { kind: "history" };
  return { kind: "replace", route: route.secretId || route.page ? vaultRoute(route.vaultId) : vaultRoute() };
}
