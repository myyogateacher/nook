/**
 * Vault key grants as Settings → API keys builds and shows them (Wave 27, vault plan §7, §10;
 * access plan D264). Pure, so the rules are unit-tested with the server's (tests/vaultKeysClient).
 *
 * A row is one vault, one environment or "every environment", and read or write. The builder offers
 * only vaults and environments the creator can reach at the chosen level; a protected environment
 * is offered only by name, and only with "Allow protected environments" on (the server keeps that
 * flag only when a grant names a protected environment). "Every environment" never covers a
 * protected one.
 */

export type VaultChoiceEnv = { id: string; slug: string; name: string; protected: boolean; level: "none" | "read" | "write" | "admin" };
export type VaultChoice = { id: string; name: string; environments: VaultChoiceEnv[] };

export const ALL_ENVS = "all";
export type VaultGrantRow = { key: string; vaultId: string; envId: string; permission: "read" | "write" };
export type VaultGrantPayload = { module: "vault"; permission: "read" | "write"; vaultId: string; envId: string | null };
export type VaultGrantView = {
  module: "vault"; permission: "read" | "write" | string;
  resource: { kind: "vault"; id: string; name: string | null } | null;
  env?: { id: string; name: string | null; protected: boolean } | null;
  active: boolean; inactiveReason: string | null;
};

export const MAX_VAULT_GRANTS = 50;

const RANK = { none: 0, read: 1, write: 2, admin: 3 } as const;
const reaches = (env: VaultChoiceEnv, permission: "read" | "write") => RANK[env.level] >= RANK[permission];

/** Vaults the creator can put in a key: any with an environment they read. */
export const grantableVaults = (vaults: readonly VaultChoice[]) => vaults.filter((vault) => vault.environments.some((env) => reaches(env, "read")));

/**
 * The environment options of a row: "Every environment" (the unprotected ones, now and later), then
 * each environment the creator reads. A protected one says so and is off until the key allows
 * protected environments.
 */
export function envChoices(vault: VaultChoice | undefined, protectedAccess: boolean) {
  if (!vault) return [];
  const unprotected = vault.environments.filter((env) => !env.protected && reaches(env, "read"));
  return [
    { value: ALL_ENVS, label: "Every environment", description: unprotected.length ? "Every unprotected environment you can read, now and later" : "Every environment you can read here is protected: pick one by name", disabled: !unprotected.length },
    ...vault.environments.filter((env) => reaches(env, "read")).map((env) => ({
      value: env.id, label: env.name,
      description: env.protected ? (protectedAccess ? "Protected: reachable because this key allows protected environments" : "Protected: turn on “Allow protected environments” first") : undefined,
      disabled: env.protected && !protectedAccess
    }))
  ];
}

/** The permission options of a row: write only where the creator writes (and never for a viewer). */
export function permissionChoicesFor(vault: VaultChoice | undefined, envId: string, role: string | undefined) {
  const envs = !vault ? [] : envId === ALL_ENVS ? vault.environments.filter((env) => !env.protected) : vault.environments.filter((env) => env.id === envId);
  const canWrite = role !== "viewer" && envs.some((env) => reaches(env, "write"));
  return [
    { value: "read" as const, label: "Read values", description: "List secrets and read values", disabled: false },
    { value: "write" as const, label: "Read and write values", description: canWrite ? "Also set values and create secrets (never delete)" : role === "viewer" ? "Your team role reads only" : "You cannot write there yourself", disabled: !canWrite }
  ];
}

/** Whether any row names a protected environment (the only case the protected flag is kept). */
export function namesProtected(rows: readonly VaultGrantRow[], vaults: readonly VaultChoice[]) {
  return rows.some((row) => row.envId !== ALL_ENVS && vaults.find((vault) => vault.id === row.vaultId)?.environments.find((env) => env.id === row.envId)?.protected);
}

/** The request's grants, or the error to show next to Create. */
export function vaultRowsToGrants(rows: readonly VaultGrantRow[]): { grants: VaultGrantPayload[]; error: string | null } {
  if (!rows.length) return { grants: [], error: "Add at least one vault." };
  if (rows.length > MAX_VAULT_GRANTS) return { grants: [], error: `A key can hold at most ${MAX_VAULT_GRANTS} grants.` };
  const seen = new Set<string>();
  const grants: VaultGrantPayload[] = [];
  for (const row of rows) {
    if (!row.vaultId) return { grants: [], error: "Choose a vault for every row." };
    const id = `${row.vaultId}:${row.envId}:${row.permission}`;
    if (seen.has(id)) return { grants: [], error: "The same vault, environment, and access are listed twice." };
    seen.add(id);
    grants.push({ module: "vault", permission: row.permission, vaultId: row.vaultId, envId: row.envId === ALL_ENVS ? null : row.envId });
  }
  return { grants, error: null };
}

/** A key's vault grants as builder rows (Edit and Rotate start from these). */
export function vaultGrantsToRows(grants: readonly VaultGrantView[]): VaultGrantRow[] {
  return grants.filter((grant) => grant.module === "vault" && grant.resource).map((grant, index) => ({
    key: `vault-${index}-${grant.resource!.id}`, vaultId: grant.resource!.id, envId: grant.env?.id ?? ALL_ENVS, permission: grant.permission === "write" ? "write" : "read"
  }));
}

/**
 * Whether editing a key from `ceiling` to `rows` only narrows it (D278), as the server decides:
 * each row covered by a held one on the same vault, with the same or a lower permission, and the
 * same environment (or one environment for every one, on a key without protected access).
 */
export function vaultRowsNarrow(ceiling: readonly VaultGrantRow[], rows: readonly VaultGrantRow[], protectedAccess: boolean) {
  return rows.every((row) => ceiling.some((held) => held.vaultId === row.vaultId
    && (held.permission === row.permission || (held.permission === "write" && row.permission === "read"))
    && (held.envId === row.envId || (held.envId === ALL_ENVS && !protectedAccess))));
}

/** One line under the builder: what the key reaches, and what no vault key ever does. */
export function vaultGrantSummary(rows: readonly VaultGrantRow[], vaults: readonly VaultChoice[]) {
  if (!rows.length) return "This key reaches no vault yet. Add a vault.";
  const parts = rows.map((row) => {
    const vault = vaults.find((item) => item.id === row.vaultId);
    const env = row.envId === ALL_ENVS ? "every environment" : vault?.environments.find((item) => item.id === row.envId)?.name ?? "an environment";
    return `${vault?.name ?? "A vault"}: ${row.permission === "write" ? "read and write" : "read"} in ${env}`;
  });
  return `${parts.join("; ")}. Never deletes, never changes access or members, and never manages keys.`;
}

const INACTIVE = { role: "your team role cannot use it", "no-access": "no current access" } as Record<string, string>;

/** The chips of a vault key row: "Payments · Production: read" (names only for the key's owner). */
export function vaultGrantChips(grants: readonly VaultGrantView[]) {
  return grants.filter((grant) => grant.module === "vault").map((grant, index) => {
    const vault = grant.resource?.name ?? "A vault";
    const env = grant.env ? `${grant.env.name ?? "one environment"}${grant.env.protected ? " (protected)" : ""}` : "every environment";
    const access = grant.permission === "write" ? "read and write" : "read";
    const reason = !grant.active && grant.inactiveReason ? ` (${INACTIVE[grant.inactiveReason] ?? "not active"})` : "";
    return { id: `vault-${index}`, label: `Vault · ${vault} · ${env}: ${access}${reason}`, active: grant.active };
  });
}

/**
 * Team → Keys (admins, D73): a vault key as counts only, never a vault's or environment's name:
 * "Vault · 2 vaults · write in 1".
 */
export function vaultGrantCountChips(grants: readonly VaultGrantView[]) {
  const vaultGrants = grants.filter((grant) => grant.module === "vault");
  if (!vaultGrants.length) return [];
  const vaults = new Set(vaultGrants.map((grant) => grant.resource?.id ?? "?"));
  const writes = new Set(vaultGrants.filter((grant) => grant.permission === "write").map((grant) => grant.resource?.id ?? "?"));
  const active = vaultGrants.some((grant) => grant.active);
  const label = `Vault · ${vaults.size} ${vaults.size === 1 ? "vault" : "vaults"}${writes.size ? ` · write in ${writes.size}` : " · read only"}${active ? "" : " (no current access)"}`;
  return [{ id: "vault-count", label, active }];
}

/** The flags as the key row says them. */
export function vaultFlagChips(flags: { allowMcpValueReads: boolean; protectedAccess: boolean } | null | undefined) {
  if (!flags) return [];
  return [
    flags.allowMcpValueReads ? "Values over MCP" : "No values over MCP",
    ...(flags.protectedAccess ? ["Protected environments"] : [])
  ];
}

/** A vault key event of the key's own history (the key's Recent activity), never a value or a secret's name. */
export function vaultKeyEventLine(event: { event: string; via: string; vault: { name: string } | null; environment: { name: string } | null }) {
  const where = [event.vault?.name ?? "a vault", event.environment?.name].filter(Boolean).join(" · ");
  const surface = event.via === "api" ? " over REST" : event.via === "mcp" ? " over MCP" : "";
  const what: Record<string, string> = {
    "value.read": "Read a value", "value.write": "Wrote a value", "secret.create": "Created a secret", "comment.read": "Read a comment",
    "version.read": "Read an old version", "key.limited": "Hit its rate limit", "apikey.create": "Given access", "apikey.rotate": "Rotated with access"
  };
  return `${what[event.event] ?? event.event}${surface} · ${where}`;
}
