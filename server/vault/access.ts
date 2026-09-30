import { db } from "../db";

/**
 * The single access predicate of the Vault (vault plan §6.1, D213–D216, T181). Every vault read and
 * write asks here first, and only this module can mint the `VaultGrant` that `crypto.ts` needs to
 * decrypt or encrypt anything: a route that forgets the check cannot reach plaintext.
 *
 * Levels per environment: none < read < write < admin. Owners hold admin on every environment
 * (D214). A member's level comes from `vault_env_access` (Wave 26 writes those rows). The Team role
 * caps it: admins and members have no cap, viewers read at most, guests reach nothing (V-O3).
 * Admins get no implicit access (D73). A vault, environment, or secret that is missing, binned,
 * being purged, or not readable is the same 404; a level too low on an environment the caller can
 * already see is 403 `VAULT_LEVEL`.
 *
 * Actors: Wave 25 has sessions only. Wave 27 adds `nkv_` keys, whose level is the key grant ∩ the
 * creator's live level ∩ the role cap (D218), computed here as well.
 */

export type VaultLevel = "none" | "read" | "write" | "admin";
export type VaultRole = "owner" | "member";
export type VaultActor = { kind: "session"; userId: string };
export type VaultVia = "session" | "api" | "mcp" | "sweeper" | "cli";

export const LEVEL_RANK: Record<VaultLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
export const atLeast = (level: VaultLevel, min: VaultLevel) => LEVEL_RANK[level] >= LEVEL_RANK[min];
const minLevel = (a: VaultLevel, b: VaultLevel): VaultLevel => LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;

export class VaultError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 500 | 503, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "VaultError";
  }
}

export const vaultNotFound = () => new VaultError(404, "NOT_FOUND", "Not found");
const levelTooLow = () => new VaultError(403, "VAULT_LEVEL", "Your access to this environment does not allow this");

export type VaultRow = {
  id: string; owner_id: string; name: string; description: string; current_generation: number; revision: number;
  created_at: string; updated_at: string;
};
export type EnvRow = { id: string; vault_id: string; slug: string; name: string; position: number; protected: 0 | 1; created_at: string };

/**
 * The caller's view of one live vault: its row, their role, and their level on each live
 * environment. Only `vaultAccess` makes one (a WeakSet brand, like the grant's): the grant minters
 * refuse a hand-made or copied object, so no code can skip the check and still reach plaintext.
 */
export type VaultAccess = {
  actor: VaultActor;
  vault: VaultRow;
  role: VaultRole;
  /** Every live environment, in vault order (the caller may see fewer: `visibleEnvironments`). */
  environments: EnvRow[];
  levels: ReadonlyMap<string, VaultLevel>;
};

/**
 * What `crypto.ts` asks for before it opens or seals anything. Frozen, and only valid when minted
 * here (a WeakSet brand, not a type): a hand-made object with the same fields is refused.
 */
export type VaultGrant = Readonly<{
  vaultId: string;
  /** The environment the grant covers, or null for vault-wide material (the secret's comment). */
  envId: string | null;
  level: VaultLevel;
  actorId: string | null;
  via: VaultVia;
}>;
const minted = new WeakSet<object>();
function mint(grant: VaultGrant): VaultGrant {
  const frozen = Object.freeze({ ...grant });
  minted.add(frozen);
  return frozen;
}
export function isVaultGrant(value: unknown): value is VaultGrant {
  return typeof value === "object" && value !== null && minted.has(value);
}

const checked = new WeakSet<object>();
function requireChecked(access: VaultAccess) {
  // A programming error behind the routes: fail closed, loudly, without any data.
  if (typeof access !== "object" || access === null || !checked.has(access)) throw new Error("Vault access refused");
}

/** The Team role cap (§6.1): viewers read at most; guests, blocked, and unknown accounts reach nothing. */
export function roleCap(userId: string): VaultLevel {
  const user = db.query("SELECT role, disabled_at FROM users WHERE id = ?").get(userId) as { role: string; disabled_at: string | null } | null;
  if (!user || user.disabled_at !== null) return "none";
  if (user.role === "guest") return "none";
  if (user.role === "viewer") return "read";
  return "admin";
}

const liveVaultSql = "SELECT id, owner_id, name, description, current_generation, revision, created_at, updated_at FROM vaults WHERE id = ? AND deleted_at IS NULL AND purge_started_at IS NULL";
const liveEnvsSql = "SELECT id, vault_id, slug, name, position, protected, created_at FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL AND purge_started_at IS NULL ORDER BY position, created_at, id";

/** The caller's access to a live vault, or null when it is missing, binned, or not readable to them. */
export function vaultAccess(actor: VaultActor, vaultId: string): VaultAccess | null {
  const cap = roleCap(actor.userId);
  if (cap === "none") return null;
  const vault = db.query(liveVaultSql).get(vaultId) as VaultRow | null;
  if (!vault) return null;
  const member = db.query("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?").get(vaultId, actor.userId) as { role: VaultRole } | null;
  if (!member) return null;
  const environments = db.query(liveEnvsSql).all(vaultId) as EnvRow[];
  const levels = new Map<string, VaultLevel>();
  if (member.role === "owner") {
    for (const env of environments) levels.set(env.id, minLevel("admin", cap));
  } else {
    const rows = db.query("SELECT env_id, level FROM vault_env_access WHERE vault_id = ? AND user_id = ?").all(vaultId, actor.userId) as Array<{ env_id: string; level: VaultLevel }>;
    const granted = new Map(rows.map((row) => [row.env_id, row.level]));
    for (const env of environments) levels.set(env.id, minLevel(granted.get(env.id) ?? "none", cap));
  }
  const readable = member.role === "owner" || [...levels.values()].some((level) => atLeast(level, "read"));
  if (!readable) return null;
  const access: VaultAccess = Object.freeze({ actor: Object.freeze({ ...actor }), vault: Object.freeze(vault), role: member.role, environments: Object.freeze(environments.map((env) => Object.freeze(env))) as EnvRow[], levels });
  checked.add(access);
  return access;
}

/** `vaultAccess` or the 404 every missing and forbidden vault gets. */
export function requireVault(actor: VaultActor, vaultId: string): VaultAccess {
  const access = vaultAccess(actor, vaultId);
  if (!access) throw vaultNotFound();
  return access;
}

export const envLevel = (access: VaultAccess, envId: string): VaultLevel => access.levels.get(envId) ?? "none";

/**
 * The environments the caller sees: every one for owners (a `none` column shows as locked), and for
 * members only those they can read (§6.2).
 */
export function visibleEnvironments(access: VaultAccess) {
  return access.role === "owner" ? access.environments : access.environments.filter((env) => atLeast(envLevel(access, env.id), "read"));
}

/** A live environment of this vault the caller can see, or the 404. */
export function requireVisibleEnv(access: VaultAccess, envId: string): EnvRow {
  const env = visibleEnvironments(access).find((item) => item.id === envId);
  if (!env) throw vaultNotFound();
  return env;
}

/**
 * The grant for one environment at `min` or above: 404 when the caller cannot see it, 403
 * `VAULT_LEVEL` when they can but their level is lower.
 */
export function requireEnvGrant(access: VaultAccess, envId: string, min: Exclude<VaultLevel, "none">, via: VaultVia = "session"): VaultGrant {
  requireChecked(access);
  requireVisibleEnv(access, envId);
  const level = envLevel(access, envId);
  if (!atLeast(level, min)) throw levelTooLow();
  return mint({ vaultId: access.vault.id, envId, level, actorId: access.actor.userId, via });
}

/**
 * The vault-wide grant for material that belongs to the vault rather than one environment (a
 * secret's comment): read for anyone who can read the vault; write for owners and for anyone who
 * can write on at least one environment. The D216 rules for editing a secret live in the service.
 */
export function vaultGrant(access: VaultAccess, min: "read" | "write", via: VaultVia = "session"): VaultGrant {
  requireChecked(access);
  let best: VaultLevel = access.role === "owner" ? minLevel("admin", roleCap(access.actor.userId)) : "none";
  for (const level of access.levels.values()) if (LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  if (!atLeast(best, min)) throw levelTooLow();
  return mint({ vaultId: access.vault.id, envId: null, level: best, actorId: access.actor.userId, via });
}

/** Owner-only operations (D215): environments, order, the vault itself, and its Bin purges. */
export function requireOwner(access: VaultAccess) {
  if (access.role !== "owner" || roleCap(access.actor.userId) !== "admin") throw levelTooLow();
}

/** Ids of the live vaults `actor` can read, for the list. */
export function readableVaultIds(actor: VaultActor): string[] {
  if (roleCap(actor.userId) === "none") return [];
  const ids = db.query(`SELECT v.id FROM vault_members m JOIN vaults v ON v.id = m.vault_id
    WHERE m.user_id = ? AND v.deleted_at IS NULL AND v.purge_started_at IS NULL ORDER BY v.name COLLATE NOCASE, v.id`).all(actor.userId) as Array<{ id: string }>;
  return ids.map((row) => row.id).filter((id) => vaultAccess(actor, id) !== null);
}
