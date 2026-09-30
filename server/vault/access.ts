import { db } from "../db";

/**
 * The single access predicate of the Vault (vault plan §6.1, D213–D216, D226, T181). Every vault read
 * and write asks here first, and only this module can mint the `VaultGrant` that `crypto.ts` needs to
 * decrypt or encrypt anything: a route that forgets the check cannot reach plaintext.
 *
 * Levels per environment: none < read < write < admin. Owners hold admin on every environment
 * (D214). A member's level is the highest of their own row in `vault_env_access` and the groups they
 * are in (`group_grants` with `resource_kind = 'vault'` and one row per environment; view → read,
 * edit → write, manage → admin). Someone reached only through a group is a member. The Team role
 * caps it: admins and members have no cap, viewers read at most, and guests, blocked accounts, and
 * integrations reach nothing (V-O3; integrations are never vault members, Wave 26). Admins get no
 * implicit access (D73). A vault, environment, or secret that is missing, binned, being purged, or
 * not readable is the same 404; a level too low on an environment the caller can already see is 403
 * `VAULT_LEVEL`.
 *
 * Protected environments (D226, V-O2): a grant for one of them is minted only while the session's
 * re-authentication window is open (password plus TOTP, 15 minutes, `sessions.vault_reauth_at`);
 * otherwise 403 `REAUTH_REQUIRED`. Every read or write of such an environment's values, its import
 * and export, and deleting a secret that holds a value there, goes through a grant, so the window is
 * enforced in one place. Metadata (names, versions list, statuses) needs no window.
 *
 * Actors: sessions only until Wave 27 adds `nkv_` keys, whose level is the key grant ∩ the
 * creator's live level ∩ the role cap (D218), computed here as well.
 */

export type VaultLevel = "none" | "read" | "write" | "admin";
export type VaultRole = "owner" | "member";
export type VaultActor = { kind: "session"; userId: string; sessionId?: string | null };
export type VaultVia = "session" | "api" | "mcp" | "sweeper" | "cli";

export const LEVEL_RANK: Record<VaultLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
export const atLeast = (level: VaultLevel, min: VaultLevel) => LEVEL_RANK[level] >= LEVEL_RANK[min];
export const minLevel = (a: VaultLevel, b: VaultLevel): VaultLevel => LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
export const maxLevel = (a: VaultLevel, b: VaultLevel): VaultLevel => LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;

/** Group grants reuse the item ladder (025): view → read, edit → write, manage → admin (comment reads). */
export const GROUP_TO_VAULT: Record<string, VaultLevel> = { view: "read", comment: "read", edit: "write", manage: "admin" };
export const VAULT_TO_GROUP: Record<Exclude<VaultLevel, "none">, "view" | "edit" | "manage"> = { read: "view", write: "edit", admin: "manage" };

/** How long a re-authentication opens protected environments for that session (D226, V-O2). */
export const REAUTH_WINDOW_MS = 15 * 60_000;

export class VaultError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 412 | 413 | 428 | 429 | 500 | 503, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "VaultError";
  }
}

export const vaultNotFound = () => new VaultError(404, "NOT_FOUND", "Not found");
const levelTooLow = () => new VaultError(403, "VAULT_LEVEL", "Your access to this environment does not allow this");
export const reauthRequired = (envIds: string[]) => new VaultError(403, "REAUTH_REQUIRED", "This environment is protected. Confirm it's you to continue.", { envIds });

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
  /** Whether the caller has their own member row (false: reached through groups only). */
  direct: boolean;
  /** Every live environment, in vault order (the caller may see fewer: `visibleEnvironments`). */
  environments: EnvRow[];
  levels: ReadonlyMap<string, VaultLevel>;
  /** Until when this session may open protected environments, or null (D226). */
  reauthUntil: string | null;
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

/**
 * The Team role cap (§6.1): viewers read at most; guests, blocked and unknown accounts, and
 * integrations (`kind = 'service'`, never vault members) reach nothing.
 */
export function roleCap(userId: string): VaultLevel {
  const user = db.query("SELECT role, kind, disabled_at FROM users WHERE id = ?").get(userId) as { role: string; kind: string; disabled_at: string | null } | null;
  if (!user || user.disabled_at !== null || user.kind !== "person") return "none";
  if (user.role === "guest") return "none";
  if (user.role === "viewer") return "read";
  return "admin";
}

const liveVaultSql = "SELECT id, owner_id, name, description, current_generation, revision, created_at, updated_at FROM vaults WHERE id = ? AND deleted_at IS NULL AND purge_started_at IS NULL";
const liveEnvsSql = "SELECT id, vault_id, slug, name, position, protected, created_at FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL AND purge_started_at IS NULL ORDER BY position, created_at, id";

/** The highest group level per environment `userId` holds on a vault (uncapped). */
export function groupEnvLevels(vaultId: string, userId: string): Map<string, VaultLevel> {
  const rows = db.query(`SELECT gg.env_id, gg.level FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id
    WHERE gg.resource_kind = 'vault' AND gg.resource_id = ? AND gm.user_id = ? AND gg.env_id IS NOT NULL`).all(vaultId, userId) as Array<{ env_id: string; level: string }>;
  const levels = new Map<string, VaultLevel>();
  for (const row of rows) levels.set(row.env_id, maxLevel(levels.get(row.env_id) ?? "none", GROUP_TO_VAULT[row.level] ?? "none"));
  return levels;
}

/**
 * The caller's uncapped levels on a vault's environments (owner → admin everywhere; else the best of
 * their own row and their groups), and their role; null when they reach it neither way.
 */
function rawLevels(vaultId: string, userId: string, envIds: readonly string[]): { role: VaultRole; direct: boolean; levels: Map<string, VaultLevel> } | null {
  const member = db.query("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?").get(vaultId, userId) as { role: VaultRole } | null;
  const levels = new Map<string, VaultLevel>();
  if (member?.role === "owner") {
    for (const envId of envIds) levels.set(envId, "admin");
    return { role: "owner", direct: true, levels };
  }
  const groups = groupEnvLevels(vaultId, userId);
  if (!member && groups.size === 0) return null;
  const own = member ? new Map((db.query("SELECT env_id, level FROM vault_env_access WHERE vault_id = ? AND user_id = ?").all(vaultId, userId) as Array<{ env_id: string; level: VaultLevel }>).map((row) => [row.env_id, row.level])) : new Map<string, VaultLevel>();
  for (const envId of envIds) levels.set(envId, maxLevel(own.get(envId) ?? "none", groups.get(envId) ?? "none"));
  return { role: "member", direct: Boolean(member), levels };
}

/**
 * The caller's level on one environment of a live vault, whether or not the environment itself is
 * binned (the Bin's restore rules, §6.5), capped by the role.
 */
export function levelIgnoringBin(vaultId: string, envId: string, userId: string): VaultLevel {
  const cap = roleCap(userId);
  if (cap === "none") return "none";
  const raw = rawLevels(vaultId, userId, [envId]);
  return raw ? minLevel(raw.levels.get(envId) ?? "none", cap) : "none";
}

/** Until when the session may open protected environments (D226), or null. */
export function reauthUntil(actor: VaultActor, nowMs = Date.now()): string | null {
  if (!actor.sessionId) return null;
  const row = db.query("SELECT vault_reauth_at FROM sessions WHERE id = ? AND user_id = ?").get(actor.sessionId, actor.userId) as { vault_reauth_at: string | null } | null;
  if (!row?.vault_reauth_at) return null;
  const until = Date.parse(row.vault_reauth_at) + REAUTH_WINDOW_MS;
  return Number.isFinite(until) && until > nowMs ? new Date(until).toISOString() : null;
}

/** The caller's access to a live vault, or null when it is missing, binned, or not readable to them. */
export function vaultAccess(actor: VaultActor, vaultId: string): VaultAccess | null {
  const cap = roleCap(actor.userId);
  if (cap === "none") return null;
  const vault = db.query(liveVaultSql).get(vaultId) as VaultRow | null;
  if (!vault) return null;
  const environments = db.query(liveEnvsSql).all(vaultId) as EnvRow[];
  const raw = rawLevels(vaultId, actor.userId, environments.map((env) => env.id));
  if (!raw) return null;
  const levels = new Map<string, VaultLevel>();
  for (const env of environments) levels.set(env.id, minLevel(raw.levels.get(env.id) ?? "none", cap));
  const readable = raw.role === "owner" || [...levels.values()].some((level) => atLeast(level, "read"));
  if (!readable) return null;
  const access: VaultAccess = Object.freeze({
    actor: Object.freeze({ ...actor }), vault: Object.freeze(vault), role: raw.role, direct: raw.direct,
    environments: Object.freeze(environments.map((env) => Object.freeze(env))) as EnvRow[], levels, reauthUntil: reauthUntil(actor)
  });
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
 * The level check without a grant, for metadata (names, the versions list, renaming): 404 when the
 * caller cannot see the environment, 403 `VAULT_LEVEL` when their level is lower than `min`.
 */
export function requireEnvLevel(access: VaultAccess, envId: string, min: Exclude<VaultLevel, "none">): EnvRow {
  requireChecked(access);
  const env = requireVisibleEnv(access, envId);
  if (!atLeast(envLevel(access, envId), min)) throw levelTooLow();
  return env;
}

/** Whether this session's re-authentication window is open (protected environments, D226). */
export const unlocked = (access: VaultAccess) => access.reauthUntil !== null;

/** 403 `REAUTH_REQUIRED` naming every protected environment among `envIds` while the window is closed. */
export function requireUnlocked(access: VaultAccess, envIds: readonly string[]) {
  requireChecked(access);
  if (unlocked(access)) return;
  const locked = access.environments.filter((env) => env.protected === 1 && envIds.includes(env.id)).map((env) => env.id);
  if (locked.length > 0) throw reauthRequired(locked);
}

/**
 * The grant for one environment at `min` or above: 404 when the caller cannot see it, 403
 * `VAULT_LEVEL` when they can but their level is lower, and 403 `REAUTH_REQUIRED` when it is
 * protected and the session's window is closed (D226).
 */
export function requireEnvGrant(access: VaultAccess, envId: string, min: Exclude<VaultLevel, "none">, via: VaultVia = "session"): VaultGrant {
  requireEnvLevel(access, envId, min);
  requireUnlocked(access, [envId]);
  return mint({ vaultId: access.vault.id, envId, level: envLevel(access, envId), actorId: access.actor.userId, via });
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

/** Owner-only operations (D215): environments, order, members, the vault itself, rotation, and its Bin purges. */
export function requireOwner(access: VaultAccess) {
  if (access.role !== "owner" || roleCap(access.actor.userId) !== "admin") throw levelTooLow();
}

/** Ids of the live vaults `actor` can read, for the list: through their own row or a group. */
export function readableVaultIds(actor: VaultActor): string[] {
  if (roleCap(actor.userId) === "none") return [];
  const ids = db.query(`SELECT v.id FROM vaults v
    WHERE v.deleted_at IS NULL AND v.purge_started_at IS NULL AND (
      EXISTS (SELECT 1 FROM vault_members m WHERE m.vault_id = v.id AND m.user_id = $userId)
      OR EXISTS (SELECT 1 FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id
        WHERE gg.resource_kind = 'vault' AND gg.resource_id = v.id AND gm.user_id = $userId))
    ORDER BY v.name COLLATE NOCASE, v.id`).all({ userId: actor.userId }) as Array<{ id: string }>;
  return ids.map((row) => row.id).filter((id) => vaultAccess(actor, id) !== null);
}

/** The vault's name for a bell line or an email, only while the recipient can read it (D223, D269). */
export function vaultTitleFor(recipientId: string, vaultId: string): string | null {
  return vaultAccess({ kind: "session", userId: recipientId }, vaultId)?.vault.name ?? null;
}

/** The best level the recipient holds on any environment of a vault ("You can view" or "You can edit"). */
export function vaultBestLevel(recipientId: string, vaultId: string): VaultLevel {
  const access = vaultAccess({ kind: "session", userId: recipientId }, vaultId);
  if (!access) return "none";
  let best: VaultLevel = access.role === "owner" ? "admin" : "none";
  for (const level of access.levels.values()) best = maxLevel(best, level);
  return best;
}
