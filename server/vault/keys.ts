import { z } from "zod";
import { db } from "../db";
import type { Grant, KeyPermission } from "../keyGrants";
import {
  atLeast, envLevel, keyEnvLevel, LEVEL_RANK, minLevel, requireVault, roleCap, vaultAccess, visibleEnvironments,
  type VaultKeyActor, type VaultKeyGrant, type VaultLevel
} from "./access";

/**
 * Vault keys (Wave 27 "Vault C"; vault plan §7, D217–D221; access plan D264, D278, T217): the
 * `nkv_` kind of Nook key. They live in the same table, inventory, and lifecycle as general keys
 * (server/apiKeys.ts); this file holds what is vault-specific:
 *
 * - The grant input `{module: "vault", permission: read|write, vaultId, envId?}` and its checks at
 *   creation: every grant within the creator's CURRENT access at ≥ its level (a vault the creator
 *   cannot read is the same 404 `RESOURCE_NOT_FOUND` as a missing one, T205; a vault they read at a
 *   lower level is 403 `GRANT_EXCEEDS_ACCESS`). A grant naming a protected environment needs the
 *   key's `protectedAccess` flag (400 `PROTECTED_ACCESS_REQUIRED`); the flag is stored only when a
 *   grant names a protected environment, and each such grant records that its environment was
 *   protected when it was made (`protected_at_grant`, review L2). Only those grants reach a protected
 *   environment, so marking another environment protected later cuts every key off it, even a
 *   flagged key that named it while it was unprotected.
 * - The effective grants a call uses: the stored ones capped by the creator's role (viewers read,
 *   guests nothing). The vault's own predicate (access.ts) then intersects them with the creator's
 *   live level on every call (D218).
 * - Narrowing (D278): dropping grants, write → read, one environment instead of every one (only on a
 *   key without `protectedAccess`, since an explicit grant is what reaches a protected environment),
 *   and turning either flag off.
 * - "Keys with access" for a vault's Access page.
 */

export const MAX_VAULT_KEY_GRANTS = 50;

const id = z.string().uuid().transform((value) => value.toLowerCase());
export const vaultGrantInput = z.object({
  module: z.literal("vault"),
  permission: z.enum(["read", "write"]),
  vaultId: id,
  /** One environment of the vault, or omitted/null for every environment (protected ones excepted). */
  envId: id.nullish()
}).strict();
export type VaultGrantInput = z.infer<typeof vaultGrantInput>;

export class VaultKeyError extends Error {
  constructor(readonly status: 400 | 403 | 404, readonly code: string, message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

const notFound = () => new VaultKeyError(404, "RESOURCE_NOT_FOUND", "One of the chosen vaults or environments was not found");

/** The creator's own view of a vault (as a session), or null when they cannot read it. */
const creatorAccess = (userId: string, vaultId: string) => vaultAccess({ kind: "session", userId }, vaultId);

/**
 * Validates vault grants for a new key (or a rotation that changes them) against the creator's
 * current access. Returns the grants as rows and whether `protectedAccess` is worth storing.
 */
export function validateVaultGrants(userId: string, inputs: readonly VaultGrantInput[], protectedAccess: boolean): { grants: Grant[]; protectedAccess: boolean } {
  const cap = roleCap(userId);
  if (cap === "none") throw new VaultKeyError(403, "SCOPE_NOT_ALLOWED", "Your account cannot create vault keys");
  if (inputs.length === 0) throw new VaultKeyError(400, "INVALID_GRANT", "A vault key needs at least one vault");
  const seen = new Map<string, Grant>();
  let namesProtected = false;
  for (const input of inputs) {
    if (input.permission === "write" && !atLeast(cap, "write")) throw new VaultKeyError(403, "SCOPE_NOT_ALLOWED", "Your team role can only create read-only vault keys");
    const access = creatorAccess(userId, input.vaultId);
    if (!access) throw notFound();
    const needed: VaultLevel = input.permission;
    let protectedNow = false;
    if (input.envId) {
      const env = visibleEnvironments(access).find((item) => item.id === input.envId);
      if (!env || !atLeast(envLevel(access, env.id), "read")) throw notFound();
      if (!atLeast(envLevel(access, env.id), needed)) throw new VaultKeyError(403, "GRANT_EXCEEDS_ACCESS", "A key cannot have more access than you have to that environment");
      if (env.protected === 1) {
        if (!protectedAccess) throw new VaultKeyError(400, "PROTECTED_ACCESS_REQUIRED", "A grant on a protected environment needs “Allow protected environments” on the key");
        namesProtected = true;
        protectedNow = true;
      }
    } else {
      // "Every environment" covers the unprotected ones only: at least one must be within reach.
      const reachable = access.environments.filter((env) => env.protected === 0 && atLeast(envLevel(access, env.id), needed));
      if (reachable.length === 0) {
        const readable = access.environments.some((env) => env.protected === 0 && atLeast(envLevel(access, env.id), "read"));
        if (!readable) throw new VaultKeyError(400, "INVALID_GRANT", "Every environment of this vault you can reach is protected: name the environment instead");
        throw new VaultKeyError(403, "GRANT_EXCEEDS_ACCESS", "A key cannot have more access than you have to that vault");
      }
    }
    const grant: Grant = { module: "vault", permission: input.permission, resourceKind: "vault", resourceId: input.vaultId, envId: input.envId ?? null, protectedAtGrant: protectedNow };
    seen.set(`${grant.permission}:${grant.resourceId}:${grant.envId ?? "*"}`, grant);
  }
  const grants = [...seen.values()];
  if (grants.length > MAX_VAULT_KEY_GRANTS) throw new VaultKeyError(400, "INVALID_GRANT", `A key can hold at most ${MAX_VAULT_KEY_GRANTS} grants`);
  return { grants, protectedAccess: protectedAccess && namesProtected };
}

/** Stored vault grants capped by the creator's role (T81): viewers' writes read, guests and blocked hold nothing. */
export function vaultEffectiveGrants(userId: string, grants: readonly Grant[]): Grant[] {
  const cap = roleCap(userId);
  if (cap === "none") return [];
  return grants.filter((grant) => grant.module === "vault" && grant.resourceKind === "vault" && grant.resourceId !== null)
    .map((grant) => grant.permission === "write" && !atLeast(cap, "write") ? { ...grant, permission: "read" as KeyPermission } : grant);
}

/** The VaultActor for one call from a vault key's effective grants and flags. */
export function vaultKeyActor(key: { keyId: string; userId: string; name: string; grants: readonly Grant[]; vault: { mcpValueReads: boolean; protectedAccess: boolean } | null }, via: "api" | "mcp"): VaultKeyActor {
  const grants: VaultKeyGrant[] = key.grants.filter((grant) => grant.module === "vault" && grant.resourceId !== null && (grant.permission === "read" || grant.permission === "write"))
    .map((grant) => ({ vaultId: grant.resourceId!, envId: grant.envId ?? null, permission: grant.permission as "read" | "write", protectedAtGrant: grant.protectedAtGrant === true }));
  return {
    kind: "key", userId: key.userId, keyId: key.keyId, keyName: key.name, via, grants,
    protectedAccess: key.vault?.protectedAccess ?? false, mcpValueReads: key.vault?.mcpValueReads ?? false
  };
}

/**
 * Why a stored vault grant grants nothing now, or null: `role` when the creator's role holds no vault
 * access, `no-access` when the creator no longer reaches that vault or environment at the level.
 */
export function vaultGrantInactive(userId: string, grant: Grant, protectedAccess: boolean): "role" | "no-access" | null {
  const cap = roleCap(userId);
  if (cap === "none") return "role";
  if (!grant.resourceId) return "no-access";
  const access = creatorAccess(userId, grant.resourceId);
  if (!access) return "no-access";
  const actor: VaultKeyActor = { kind: "key", userId, keyId: "", keyName: "", via: "api", grants: [{ vaultId: grant.resourceId, envId: grant.envId ?? null, permission: grant.permission === "write" ? "write" : "read", protectedAtGrant: grant.protectedAtGrant === true }], protectedAccess, mcpValueReads: false };
  const reaches = access.environments.some((env) => atLeast(minLevel(envLevel(access, env.id), keyEnvLevel(actor, grant.resourceId!, env)), "read"));
  return reaches ? null : "no-access";
}

/** The vault's and environment's names for the key's owner (only while they can read them), for the key list. */
export function vaultGrantNames(userId: string, grant: Grant): { vaultName: string | null; envName: string | null; envProtected: boolean } {
  const access = grant.resourceId ? creatorAccess(userId, grant.resourceId) : null;
  if (!access) return { vaultName: null, envName: null, envProtected: false };
  const env = grant.envId ? visibleEnvironments(access).find((item) => item.id === grant.envId) : null;
  return { vaultName: access.vault.name, envName: env?.name ?? null, envProtected: env?.protected === 1 };
}

/** Whether `envId` is an environment of `vaultId`, live or in the Bin (narrowing's check, review L1). */
export function environmentOfVault(vaultId: string, envId: string) {
  return Boolean(db.query("SELECT 1 FROM vault_environments WHERE id = ? AND vault_id = ?").get(envId, vaultId));
}

/**
 * Whether `next` only narrows `current` (D278) for a vault key: each next grant is covered by a held
 * one on the same vault with an equal or higher permission, and the same environment; a held grant
 * over every environment covers one environment only on a key without `protectedAccess` (on such a
 * key an explicit grant could reach a protected environment the "every" grant never did).
 */
export function isVaultNarrowing(current: readonly Grant[], next: readonly Grant[], protectedAccess: boolean) {
  return next.every((grant) => current.some((held) => held.module === "vault" && grant.module === "vault" && held.resourceId === grant.resourceId
    && (held.permission === grant.permission || (held.permission === "write" && grant.permission === "read"))
    && ((held.envId ?? null) === (grant.envId ?? null) || ((held.envId ?? null) === null && !protectedAccess))));
}

// ------------------------------------------------------------------ keys with access to a vault

type KeyRow = { id: string; name: string; key_prefix: string; user_id: string; display_name: string; expires_at: string | null; last_used_at: string | null; vault_protected_access: number };

/**
 * The live vault keys that reach `vaultId` right now (not revoked, expired, past a rotation grace,
 * or held by a blocked creator), each with its effective level per environment (grant ∩ creator's
 * live level ∩ role cap). Vault owners see each key (name, prefix, creator, levels); anyone else
 * who can read the vault sees the count and their own keys only (D73: a Team admin who is not a
 * vault member gets the vault's 404 first).
 */
export function keysWithAccess(viewerId: string, vaultId: string) {
  const viewer = requireVault({ kind: "session", userId: viewerId }, vaultId);
  const owner = viewer.role === "owner";
  const at = new Date().toISOString();
  const rows = db.query(`SELECT DISTINCT k.id, k.name, k.key_prefix, k.user_id, u.display_name, k.expires_at, k.last_used_at, k.vault_protected_access
    FROM mcp_api_keys k JOIN users u ON u.id = k.user_id JOIN api_key_grants g ON g.key_id = k.id
    WHERE k.kind = 'vault' AND g.module = 'vault' AND g.resource_kind = 'vault' AND g.resource_id = ?
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?) AND (k.revoke_after IS NULL OR k.revoke_after > ?) AND u.disabled_at IS NULL
    ORDER BY u.display_name COLLATE NOCASE, k.created_at`).all(vaultId, at, at) as KeyRow[];
  const keys = rows.flatMap((row) => {
    const grants = vaultEffectiveGrants(row.user_id, db.query("SELECT module, permission, resource_kind, resource_id, env_id, protected_at_grant FROM api_key_grants WHERE key_id = ? AND module = 'vault'")
      .all(row.id).map((raw) => {
        const item = raw as { permission: KeyPermission; resource_id: string; env_id: string | null; protected_at_grant: number };
        return { module: "vault" as const, permission: item.permission, resourceKind: "vault" as const, resourceId: item.resource_id, envId: item.env_id, protectedAtGrant: item.protected_at_grant === 1 };
      }));
    const actor = vaultKeyActor({ keyId: row.id, userId: row.user_id, name: row.name, grants, vault: { mcpValueReads: false, protectedAccess: row.vault_protected_access === 1 } }, "api");
    const access = vaultAccess(actor, vaultId);
    if (!access) return [];
    const levels: Record<string, VaultLevel> = {};
    for (const env of access.environments) {
      const level = envLevel(access, env.id);
      if (LEVEL_RANK[level] > 0) levels[env.id] = level;
    }
    return [{ row, levels }];
  });
  const visibleEnvs = new Set(visibleEnvironments(viewer).map((env) => env.id));
  const listed = owner ? keys : keys.filter((key) => key.row.user_id === viewerId);
  return {
    count: keys.length,
    scope: owner ? "vault" as const : "own" as const,
    keys: listed.map(({ row, levels }) => ({
      id: row.id, name: row.name, prefix: row.key_prefix, owner: { id: row.user_id, displayName: row.display_name, isYou: row.user_id === viewerId },
      expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
      levels: Object.fromEntries(Object.entries(levels).filter(([envId]) => visibleEnvs.has(envId)))
    })),
    maxGrants: MAX_VAULT_KEY_GRANTS
  };
}

// ------------------------------------------------------------------ key events in vault Activity

/**
 * Records, in each vault a key's grants name, that the key was created (or rotated) with access to
 * it: `apikey.create` / `apikey.rotate`, the creator as the person, the key's id, `via: session`.
 */
export function recordKeyGrantEvents(keyId: string, userId: string, grants: readonly Grant[], event: "apikey.create" | "apikey.rotate") {
  const vaults = new Map<string, number>();
  for (const grant of grants) if (grant.module === "vault" && grant.resourceId) vaults.set(grant.resourceId, (vaults.get(grant.resourceId) ?? 0) + 1);
  const at = new Date().toISOString();
  const key = db.query("SELECT name, key_prefix FROM mcp_api_keys WHERE id = ?").get(keyId) as { name: string; key_prefix: string } | null;
  const insert = db.query("INSERT INTO vault_events (id, vault_id, actor_id, key_id, key_name, key_prefix, via, event, count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'session', ?, ?, ?)");
  for (const [vaultId, count] of vaults) {
    if (!db.query("SELECT 1 FROM vaults WHERE id = ?").get(vaultId)) continue;
    insert.run(crypto.randomUUID(), vaultId, userId, keyId, key?.name ?? null, key?.key_prefix ?? null, event, count, at);
  }
}

/**
 * The key's own recent vault activity for its owner (the key's "Recent activity"): what it did, in
 * which vault and environment (names only while the owner can read them), and when. Never a value
 * or a secret's name.
 */
export function vaultKeyEvents(ownerId: string, keyId: string, limit = 30) {
  const rows = db.query(`SELECT e.id, e.vault_id, e.event, e.via, e.env_id, e.count, e.created_at FROM vault_events e
    WHERE e.key_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(keyId, limit) as Array<{ id: string; vault_id: string; event: string; via: string; env_id: string | null; count: number | null; created_at: string }>;
  const names = new Map<string, { vault: string; envs: Map<string, string> } | null>();
  const namesOf = (vaultId: string) => {
    if (!names.has(vaultId)) {
      const access = creatorAccess(ownerId, vaultId);
      names.set(vaultId, access ? { vault: access.vault.name, envs: new Map(visibleEnvironments(access).map((env) => [env.id, env.name])) } : null);
    }
    return names.get(vaultId)!;
  };
  return rows.map((row) => {
    const known = namesOf(row.vault_id);
    return {
      id: row.id, event: row.event, via: row.via, count: row.count, createdAt: row.created_at,
      vault: known ? { id: row.vault_id, name: known.vault } : null,
      environment: row.env_id && known?.envs.has(row.env_id) ? { id: row.env_id, name: known.envs.get(row.env_id)! } : null
    };
  });
}
