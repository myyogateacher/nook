import { db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import {
  atLeast, envLevel, requireEnvGrant, requireEnvLevel, requireOwner, requireUnlocked, requireVault, readableVaultIds, roleCap, vaultAccess, vaultGrant,
  VaultError, vaultNotFound, viaOf, visibleEnvironments, type EnvRow, type VaultAccess, type VaultActor, type VaultLevel, type VaultVia
} from "./access";
import { insertVaultKey, openSecretComment, openValue, sealSecretComment, sealValue, VaultIntegrityError } from "./crypto";
import { chargeActor } from "./limits";
import { DEFAULT_ENVIRONMENTS, parseLoginValue, VAULT_BOUNDS, type CellStatus, type SecretType } from "../../shared/vault";

/**
 * The Vault service (vault plan §6, §7; Wave 25 "Vault A"): vaults, environments, secrets, values,
 * and their history, for a session actor. Every operation starts at `access.ts` and only reaches
 * `crypto.ts` with the grant it returns. Nothing returned or recorded here carries a value except
 * the reads that exist to return one (audited as `value.read`), and `vault_events` holds ids and
 * counts only (T188).
 *
 * Wave 26 adds members and groups (server/vault/members.ts), the protected-environment window
 * (enforced where access.ts mints grants), import and export (transfer.ts), DEK rotation
 * (rotation.ts), the Activity view (events.ts), and the per-person byte quota (`enforceQuota`).
 * Wave 27 lets `nkv_` vault keys call the same functions (REST `/api/v1/vault/*` and the vault MCP
 * tools): the actor is then the key, whose levels access.ts computes, whose reads and writes charge
 * the key's own buckets, and whose events carry its id and surface (`via: api | mcp`).
 */

export type EnvironmentSummary = { id: string; slug: string; name: string; position: number; protected: boolean; level: VaultLevel };
export type VaultSummary = {
  id: string; name: string; description: string; role: "owner" | "member"; revision: number;
  createdAt: string; updatedAt: string; secretCount: number; environments: EnvironmentSummary[];
  /** Who created it (the person its bytes count against), for "Shared with me". */
  ownerName: string | null;
  /** How the caller reaches it: their own row, or only through groups. */
  via: "direct" | "group";
  /** Until when this session may open protected environments (D226), or null. */
  reauthUntil: string | null;
};
export type ValueCell = { status: CellStatus; version: number | null; updatedAt: string | null; updatedBy: string | null };
export type SecretSummary = {
  id: string; name: string; type: SecretType; tags: string[]; hasComment: boolean; revision: number;
  createdAt: string; updatedAt: string; updatedBy: string | null; values: Record<string, ValueCell>;
};

type SecretRow = {
  id: string; vault_id: string; name: string; type: SecretType; comment_ct: string | null; comment_generation: number | null; tags: string;
  revision: number; created_at: string; updated_at: string; updated_by: string | null;
};
type ValueRow = { secret_id: string; env_id: string; value_ct: string; comment_ct: string | null; generation: number; version: number; updated_by: string | null; updated_at: string };

// ---------------------------------------------------------------------------------------------
// Events (ids and counts only, never values or names)

/**
 * One `vault_events` row. `actor` is a person's id (or null), or a VaultActor: a key's events carry
 * its id and surface (`via: api | mcp`) with its creator as the person (Wave 27).
 */
const keyLabel = db.query("SELECT name, key_prefix FROM mcp_api_keys WHERE id = ?");

export function recordVaultEvent(vaultId: string, actor: string | null | VaultActor, event: string, detail: { secretId?: string | null; envId?: string | null; count?: number | null; targetId?: string | null; level?: string | null } = {}, via: VaultVia = "session") {
  const actorId = actor === null || typeof actor === "string" ? actor : actor.userId;
  const keyId = actor !== null && typeof actor === "object" && actor.kind === "key" ? actor.keyId : null;
  const recordedVia = actor !== null && typeof actor === "object" ? viaOf(actor) : via;
  // The key's name and prefix as they are now (review L5): a later rename never re-labels this event.
  const key = keyId ? keyLabel.get(keyId) as { name: string; key_prefix: string } | null : null;
  db.query("INSERT INTO vault_events (id, vault_id, actor_id, key_id, key_name, key_prefix, via, event, secret_id, env_id, count, target_id, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), vaultId, actorId, keyId, key?.name ?? null, key?.key_prefix ?? null, recordedVia, event, detail.secretId ?? null, detail.envId ?? null, detail.count ?? null, detail.targetId ?? null, detail.level ?? null, now());
}

/** The key acting, for the `*_via_key` columns, or null for a person. */
const viaKey = (actor: VaultActor) => actor.kind === "key" ? actor.keyId : null;

/**
 * `vault_events` retention (T195, review L5), run by the hourly sweeper: rows older than 90 days
 * go. Newer rows stay append-only: 031's delete trigger refuses deleting them, so no count cap can
 * evict a recent row (a reader flooding the log cannot push their own earlier reads out). The rate
 * limits bound the growth meanwhile, and the per-person byte quota (`enforceQuota`, Wave 26) bounds
 * the values. A purged vault's rows go with it (ON DELETE CASCADE).
 */
export const VAULT_EVENT_RETENTION_DAYS = 90;

export function sweepVaultEvents(nowMs = Date.now()): number {
  // Never past the trigger's own clock: a cutoff after its "now - 90 days" would hit APPEND_ONLY.
  const cutoff = new Date(Math.min(nowMs, Date.now()) - VAULT_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  return db.query("DELETE FROM vault_events WHERE created_at < ?").run(cutoff).changes;
}

/**
 * A ciphertext that does not open under its own ids (T189): audited, then a 500 `VAULT_INTEGRITY`
 * that names nothing. Never a silent value.
 */
export function integrity<T>(vaultId: string, actorId: string | VaultActor, detail: { secretId?: string; envId?: string }, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof VaultIntegrityError)) throw error;
    recordVaultEvent(vaultId, actorId, "integrity.fail", detail);
    throw new VaultError(500, "VAULT_INTEGRITY", "This vault item failed its integrity check. Nothing was shown.");
  }
}

// ---------------------------------------------------------------------------------------------
// The byte quota (review L5, Wave 26): the ciphertext bytes of every vault a person created
// (`vaults.owner_id`, binned vaults included), kept per vault by 037's triggers.

/** Stored bytes per person, across the vaults they created (ciphertext: values, history, comments). */
export const DEFAULT_VAULT_QUOTA_BYTES = 64 * 1024 * 1024;
let quotaBytes = DEFAULT_VAULT_QUOTA_BYTES;
/** Test hook. */
export function setVaultQuotaForTests(bytes: number | null) {
  quotaBytes = bytes ?? DEFAULT_VAULT_QUOTA_BYTES;
}
export const vaultQuotaBytes = () => quotaBytes;

const ownerOfVault = (vaultId: string) => (db.query("SELECT owner_id FROM vaults WHERE id = ?").get(vaultId) as { owner_id: string } | null)?.owner_id ?? null;
export const storedBytesOf = (ownerId: string) => (db.query("SELECT ifnull(sum(stored_bytes), 0) AS bytes FROM vaults WHERE owner_id = ?").get(ownerId) as { bytes: number }).bytes;

/**
 * Runs `write` in the caller's transaction and refuses it (413 `QUOTA_EXCEEDED`, rolled back) when it
 * grew the vault creator's stored bytes past the quota. A write that shrinks or keeps the total (a
 * clear, a value that trims history) always passes, so a person over quota can clean up.
 */
export function enforceQuota<T>(vaultId: string, actorId: string, write: () => T): T {
  const ownerId = ownerOfVault(vaultId);
  const before = ownerId ? storedBytesOf(ownerId) : 0;
  const result = write();
  if (ownerId) {
    const after = storedBytesOf(ownerId);
    if (after > before && after > quotaBytes) {
      // The total covers every vault the billing owner created: only they hear the figure (review L3).
      const detail = actorId === ownerId ? { quotaBytes, storedBytes: before } : { quotaBytes };
      throw new VaultError(413, "QUOTA_EXCEEDED", "This would pass the vault storage quota of the vault's creator. Clear old values or delete secrets (and empty them from the Bin) first.", detail);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Vaults

export const displayName = (userId: string | null) => userId === null ? null : (db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | null)?.display_name ?? null;

function environmentSummaries(access: VaultAccess): EnvironmentSummary[] {
  return visibleEnvironments(access).map((env) => ({ id: env.id, slug: env.slug, name: env.name, position: env.position, protected: env.protected === 1, level: envLevel(access, env.id) }));
}

export function summarize(access: VaultAccess): VaultSummary {
  const secretCount = (db.query("SELECT COUNT(*) AS count FROM vault_secrets WHERE vault_id = ? AND deleted_at IS NULL").get(access.vault.id) as { count: number }).count;
  const { vault } = access;
  return {
    id: vault.id, name: vault.name, description: vault.description, role: access.role, revision: vault.revision,
    createdAt: vault.created_at, updatedAt: vault.updated_at, secretCount, environments: environmentSummaries(access),
    ownerName: displayName(vault.owner_id), via: access.direct ? "direct" : "group", reauthUntil: access.reauthUntil
  };
}

export function listVaults(actor: VaultActor): VaultSummary[] {
  return readableVaultIds(actor).flatMap((id) => {
    const access = vaultAccess(actor, id);
    return access ? [summarize(access)] : [];
  });
}

export const getVault = (actor: VaultActor, vaultId: string) => summarize(requireVault(actor, vaultId));

type NewEnvironment = { slug: string; name: string; protected?: boolean };

/** Anyone whose role writes content may create a vault (§7); they become its only owner. */
export function createVault(actor: VaultActor, input: { name: string; description?: string; environments?: NewEnvironment[] }): VaultSummary {
  if (roleCap(actor.userId) !== "admin") throw vaultNotFound();
  const environments = input.environments ?? DEFAULT_ENVIRONMENTS;
  if (environments.length < 1 || environments.length > VAULT_BOUNDS.environments) throw new VaultError(400, "INVALID", `A vault has 1 to ${VAULT_BOUNDS.environments} environments`);
  if (new Set(environments.map((env) => env.slug)).size !== environments.length) throw new VaultError(409, "SLUG_TAKEN", "Two environments have the same short name");
  // T195 (review L5): vaults in the Bin count too, so binning and recreating cannot grow storage past the bound.
  const owned = (db.query("SELECT COUNT(*) AS count FROM vaults WHERE owner_id = ?").get(actor.userId) as { count: number }).count;
  if (owned >= VAULT_BOUNDS.ownedVaults) throw new VaultError(409, "LIMIT_REACHED", `You can own up to ${VAULT_BOUNDS.ownedVaults} vaults, counting those in the Bin`);
  chargeActor(actor, "write");
  const id = crypto.randomUUID();
  const timestamp = now();
  db.transaction(() => {
    db.query("INSERT INTO vaults (id, owner_id, name, description, current_generation, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)")
      .run(id, actor.userId, input.name, input.description ?? "", timestamp, timestamp);
    insertVaultKey(id, 1);
    db.query("INSERT INTO vault_members (vault_id, user_id, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)").run(id, actor.userId, actor.userId, timestamp);
    environments.forEach((env, index) => {
      db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, protected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), id, env.slug, env.name, index, env.protected ? 1 : 0, timestamp);
    });
    recordVaultEvent(id, actor, "vault.create", { count: environments.length });
  })();
  return getVault(actor, id);
}

const revisionChanged = (current: number) => new VaultError(409, "REVISION_CHANGED", "This changed since you opened it. Reload and try again.", { currentRevision: current });

export function updateVault(actor: VaultActor, vaultId: string, input: { name?: string; description?: string; expectedRevision: number }): VaultSummary {
  const access = requireVault(actor, vaultId);
  requireOwner(access);
  chargeActor(actor, "write");
  db.transaction(() => {
    const result = db.query(`UPDATE vaults SET name = COALESCE(?, name), description = COALESCE(?, description), revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`).run(input.name ?? null, input.description ?? null, now(), vaultId, input.expectedRevision);
    if (result.changes !== 1) throw revisionChanged(access.vault.revision);
    recordVaultEvent(vaultId, actor, "vault.update");
  })();
  return getVault(actor, vaultId);
}

/** Owner only, session only (D219, V-O4): to the Bin for 30 days (D225). */
export function deleteVault(actor: VaultActor, vaultId: string) {
  const access = requireVault(actor, vaultId);
  requireOwner(access);
  chargeActor(actor, "write");
  const deletedAt = new Date();
  db.transaction(() => {
    db.query("UPDATE vaults SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL").run(deletedAt.toISOString(), actor.userId, purgeAfterFrom(deletedAt), vaultId);
    recordVaultEvent(vaultId, actor, "vault.delete");
  })();
  return { ok: true, binned: true };
}

// ---------------------------------------------------------------------------------------------
// Environments (D215: creating, ordering, and the protected flag are owner-only; renaming and
// deleting need admin on that environment)

export function createEnvironment(actor: VaultActor, vaultId: string, input: NewEnvironment): EnvironmentSummary {
  const access = requireVault(actor, vaultId);
  requireOwner(access);
  if (access.environments.length >= VAULT_BOUNDS.environments) throw new VaultError(409, "LIMIT_REACHED", `A vault has at most ${VAULT_BOUNDS.environments} environments`);
  if (access.environments.some((env) => env.slug === input.slug)) throw new VaultError(409, "SLUG_TAKEN", "Another environment already has this short name");
  chargeActor(actor, "write");
  const id = crypto.randomUUID();
  const position = Math.max(-1, ...access.environments.map((env) => env.position)) + 1;
  db.transaction(() => {
    db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, protected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, vaultId, input.slug, input.name, position, input.protected ? 1 : 0, now());
    db.query("UPDATE vaults SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), vaultId);
    recordVaultEvent(vaultId, actor, "env.create", { envId: id });
  })();
  const created = requireVault(actor, vaultId);
  return environmentSummaries(created).find((env) => env.id === id)!;
}

export function updateEnvironment(actor: VaultActor, vaultId: string, envId: string, input: { name?: string; protected?: boolean }): EnvironmentSummary {
  const access = requireVault(actor, vaultId);
  const env = requireEnvLevel(access, envId, "admin");
  if (input.protected !== undefined) requireOwner(access);
  // Lifting protection is what the window protects: it needs the window itself (D226).
  if (input.protected === false && env.protected === 1) requireUnlocked(access, [envId]);
  chargeActor(actor, "write");
  db.transaction(() => {
    db.query("UPDATE vault_environments SET name = COALESCE(?, name), protected = COALESCE(?, protected) WHERE id = ? AND vault_id = ? AND deleted_at IS NULL")
      .run(input.name ?? null, input.protected === undefined ? null : input.protected ? 1 : 0, envId, vaultId);
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(now(), vaultId);
    const changedProtection = input.protected !== undefined && (input.protected ? 1 : 0) !== env.protected;
    recordVaultEvent(vaultId, actor, changedProtection ? (input.protected ? "env.protect" : "env.unprotect") : "env.update", { envId });
  })();
  return environmentSummaries(requireVault(actor, vaultId)).find((env) => env.id === envId)!;
}

export function reorderEnvironments(actor: VaultActor, vaultId: string, ids: string[], expectedRevision: number): VaultSummary {
  const access = requireVault(actor, vaultId);
  requireOwner(access);
  const live = access.environments.map((env) => env.id);
  if (ids.length !== live.length || new Set(ids).size !== ids.length || !ids.every((id) => live.includes(id))) {
    throw new VaultError(400, "INVALID", "Send every environment of this vault exactly once");
  }
  chargeActor(actor, "write");
  db.transaction(() => {
    const bumped = db.query("UPDATE vaults SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now(), vaultId, expectedRevision);
    if (bumped.changes !== 1) throw revisionChanged(access.vault.revision);
    ids.forEach((id, index) => db.query("UPDATE vault_environments SET position = ? WHERE id = ? AND vault_id = ?").run(index, id, vaultId));
    recordVaultEvent(vaultId, actor, "env.reorder", { count: ids.length });
  })();
  return getVault(actor, vaultId);
}

/** To the Bin with its values (§6.3). The last live environment stays: a vault needs one. */
export function deleteEnvironment(actor: VaultActor, vaultId: string, envId: string) {
  const access = requireVault(actor, vaultId);
  requireEnvGrant(access, envId, "admin");
  if (access.environments.length <= 1) throw new VaultError(409, "LAST_ENVIRONMENT", "A vault keeps at least one environment");
  chargeActor(actor, "write");
  const deletedAt = new Date();
  db.transaction(() => {
    db.query("UPDATE vault_environments SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND vault_id = ? AND deleted_at IS NULL")
      .run(deletedAt.toISOString(), actor.userId, purgeAfterFrom(deletedAt), envId, vaultId);
    db.query("UPDATE vaults SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), vaultId);
    recordVaultEvent(vaultId, actor, "env.delete", { envId });
  })();
  return { ok: true, binned: true };
}

// ---------------------------------------------------------------------------------------------
// Secrets

const secretColumns = "id, vault_id, name, type, comment_ct, comment_generation, tags, revision, created_at, updated_at, updated_by";

export function liveSecret(access: VaultAccess, secretId: string): SecretRow {
  const row = db.query(`SELECT ${secretColumns} FROM vault_secrets WHERE id = ? AND vault_id = ? AND deleted_at IS NULL AND purge_started_at IS NULL`).get(secretId, access.vault.id) as SecretRow | null;
  if (!row) throw vaultNotFound();
  return row;
}

export const parseTags = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
};

function cellsFor(access: VaultAccess, secretIds: string[]): Map<string, Record<string, ValueCell>> {
  const envs = visibleEnvironments(access);
  const rows = secretIds.length === 0 ? [] : db.query(`SELECT v.secret_id, v.env_id, v.version, v.updated_at, u.display_name AS updated_by_name
    FROM vault_values v LEFT JOIN users u ON u.id = v.updated_by WHERE v.secret_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(secretIds)) as Array<{ secret_id: string; env_id: string; version: number; updated_at: string; updated_by_name: string | null }>;
  const byKey = new Map(rows.map((row) => [`${row.secret_id}:${row.env_id}`, row]));
  const cleared = secretIds.length === 0 ? [] : db.query(`SELECT secret_id, env_id, MAX(version) AS version FROM vault_value_versions WHERE secret_id IN (SELECT value FROM json_each(?)) GROUP BY secret_id, env_id`)
    .all(JSON.stringify(secretIds)) as Array<{ secret_id: string; env_id: string; version: number }>;
  const lastVersion = new Map(cleared.map((row) => [`${row.secret_id}:${row.env_id}`, row.version]));
  const result = new Map<string, Record<string, ValueCell>>();
  for (const secretId of secretIds) {
    const cells: Record<string, ValueCell> = {};
    for (const env of envs) {
      const key = `${secretId}:${env.id}`;
      if (!atLeast(envLevel(access, env.id), "read")) {
        cells[env.id] = { status: "no-access", version: null, updatedAt: null, updatedBy: null };
        continue;
      }
      const row = byKey.get(key);
      cells[env.id] = row
        ? { status: "set", version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by_name }
        : { status: "empty", version: lastVersion.get(key) ?? 0, updatedAt: null, updatedBy: null };
    }
    result.set(secretId, cells);
  }
  return result;
}

function toSummary(row: SecretRow, cells: Record<string, ValueCell>): SecretSummary {
  return {
    id: row.id, name: row.name, type: row.type, tags: parseTags(row.tags), hasComment: row.comment_ct !== null, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: displayName(row.updated_by), values: cells
  };
}

type SecretCursor = { name: string; id: string };
const encodeCursor = (cursor: SecretCursor) => Buffer.from(JSON.stringify([cursor.name, cursor.id])).toString("base64url");
function decodeCursor(value: string | null | undefined): SecretCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string" && parsed[0].length <= 128 && parsed[1].length <= 40) return { name: parsed[0], id: parsed[1] };
  } catch {
    // fall through
  }
  throw new VaultError(400, "INVALID_CURSOR", "cursor is not valid");
}

/** Names, types, tags, and per-environment status in pages of 200 (keyset by name); never values (§6.2). */
export function listSecrets(actor: VaultActor, vaultId: string, options: { q?: string; tag?: string; cursor?: string | null } = {}) {
  const access = requireVault(actor, vaultId);
  const cursor = decodeCursor(options.cursor);
  const q = options.q?.trim().toLowerCase() ?? "";
  const rows = db.query(`SELECT ${secretColumns} FROM vault_secrets
    WHERE vault_id = $vaultId AND deleted_at IS NULL AND purge_started_at IS NULL
      ${q ? "AND (instr(lower(name), $q) > 0 OR instr(lower(tags), $q) > 0)" : ""}
      ${options.tag ? "AND EXISTS (SELECT 1 FROM json_each(tags) t WHERE t.value = $tag)" : ""}
      ${cursor ? "AND (name > $cursorName COLLATE NOCASE OR (name = $cursorName COLLATE NOCASE AND id > $cursorId))" : ""}
    ORDER BY name COLLATE NOCASE, id LIMIT $limit`).all({
    vaultId, limit: VAULT_BOUNDS.secretsPage + 1,
    ...(q ? { q } : {}), ...(options.tag ? { tag: options.tag } : {}),
    ...(cursor ? { cursorName: cursor.name, cursorId: cursor.id } : {})
  }) as SecretRow[];
  const page = rows.slice(0, VAULT_BOUNDS.secretsPage);
  const cells = cellsFor(access, page.map((row) => row.id));
  const last = rows.length > VAULT_BOUNDS.secretsPage ? page[page.length - 1] : undefined;
  return {
    vault: summarize(access),
    secrets: page.map((row) => toSummary(row, cells.get(row.id)!)),
    nextCursor: last ? encodeCursor({ name: last.name, id: last.id }) : null
  };
}

/**
 * The secret with its decrypted comment and per-environment status (no values). Opening a comment
 * is a read like a value's (review L4): it counts against the read limit and is audited
 * `comment.read`. A secret without a comment decrypts nothing, so it costs nothing and is not
 * recorded. Create and update answer with `writtenSecret`: they return the comment the caller just
 * wrote, which is not a read.
 */
export function getSecret(actor: VaultActor, vaultId: string, secretId: string, options: { charged?: boolean } = {}) {
  const access = requireVault(actor, vaultId);
  const row = liveSecret(access, secretId);
  if (row.comment_ct === null) return secretDetail(access, row);
  vaultGrant(access, "read");
  // `charged`: the caller already charged this read (the MCP value read that returns the comment
  // with the value, review L3); the opening is still audited.
  if (!options.charged) chargeActor(actor, "read");
  const detail = secretDetail(access, row);
  recordVaultEvent(vaultId, actor, "comment.read", { secretId, count: 1 });
  return detail;
}

function secretDetail(access: VaultAccess, row: SecretRow) {
  const grant = vaultGrant(access, "read");
  const comment = integrity(access.vault.id, access.actor, { secretId: row.id }, () => openSecretComment(grant, { secretId: row.id, commentCt: row.comment_ct, generation: row.comment_generation }));
  return { vault: summarize(access), secret: { ...toSummary(row, cellsFor(access, [row.id]).get(row.id)!), comment } };
}

/**
 * The secret's metadata only: name, type, tags, whether it has a comment, and per-environment status.
 * Nothing is decrypted, so nothing is charged or recorded (the vault MCP tools without value reads).
 */
export function secretMetadata(actor: VaultActor, vaultId: string, secretId: string) {
  const access = requireVault(actor, vaultId);
  const row = liveSecret(access, secretId);
  return { vault: summarize(access), secret: toSummary(row, cellsFor(access, [row.id]).get(row.id)!) };
}

/** After a create or an update: the secret as the caller just wrote it (no read charge, no event). */
function writtenSecret(actor: VaultActor, vaultId: string, secretId: string) {
  const access = requireVault(actor, vaultId);
  return secretDetail(access, liveSecret(access, secretId));
}

/**
 * D216: renaming, re-typing, the comment, the tags, and deleting need write on every live
 * environment where the secret has a value; with no value anywhere, write on one environment.
 */
function requireWriteEverywhere(access: VaultAccess, secretId: string) {
  const withValues = (db.query("SELECT env_id FROM vault_values WHERE secret_id = ?").all(secretId) as Array<{ env_id: string }>)
    .map((row) => row.env_id).filter((envId) => access.environments.some((env) => env.id === envId));
  const writable = (envId: string) => atLeast(envLevel(access, envId), "write");
  const allowed = withValues.length > 0 ? withValues.every(writable) : access.environments.some((env) => writable(env.id));
  if (!allowed) throw new VaultError(403, "VAULT_LEVEL", "You need write access on every environment where this secret has a value");
}

export function nameTaken(vaultId: string, name: string, exceptId: string | null) {
  return Boolean(db.query("SELECT 1 FROM vault_secrets WHERE vault_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?").get(vaultId, name, exceptId));
}
const nameTakenError = () => new VaultError(409, "NAME_TAKEN", "Another secret in this vault has this name");

/** Checks a value against its secret's type (D228): a login is its three fields as JSON. */
export function checkValueForType(type: SecretType, value: string) {
  if (type === "login" && !parseLoginValue(value)) throw new VaultError(400, "INVALID_VALUE", "A login value has a username, a password, and a URL");
}

export type NewValue = { value: string; comment?: string | null };

export function createSecret(actor: VaultActor, vaultId: string, input: { name: string; type: SecretType; comment?: string | null; tags?: string[]; values?: Record<string, NewValue> }) {
  const access = requireVault(actor, vaultId);
  // Anyone who can write on at least one environment may create a secret (D216).
  const secretGrant = vaultGrant(access, "write");
  const valueEntries = Object.entries(input.values ?? {});
  const valueGrants = valueEntries.map(([envId]) => requireEnvGrant(access, envId, "write"));
  for (const [, entry] of valueEntries) checkValueForType(input.type, entry.value);
  // T195 (review L5): secrets in the Bin count too.
  const stored = (db.query("SELECT COUNT(*) AS count FROM vault_secrets WHERE vault_id = ?").get(vaultId) as { count: number }).count;
  if (stored >= VAULT_BOUNDS.secretsPerVault) throw new VaultError(409, "LIMIT_REACHED", `A vault holds at most ${VAULT_BOUNDS.secretsPerVault} secrets, counting those in the Bin`);
  if (nameTaken(vaultId, input.name, null)) throw nameTakenError();
  chargeActor(actor, "write", 1 + valueEntries.length);
  const id = crypto.randomUUID();
  const timestamp = now();
  db.transaction(() => enforceQuota(vaultId, actor.userId, () => {
    const comment = sealSecretComment(secretGrant, id, input.comment ?? null);
    db.query(`INSERT INTO vault_secrets (id, vault_id, name, type, comment_ct, comment_generation, tags, revision, created_by, created_via_key, created_at, updated_by, updated_via_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(id, vaultId, input.name, input.type, comment.commentCt, comment.generation, JSON.stringify(input.tags ?? []), actor.userId, viaKey(actor), timestamp, actor.userId, viaKey(actor), timestamp);
    valueEntries.forEach(([envId, entry], index) => writeValueLocked(access, valueGrants[index]!, id, envId, entry.value, entry.comment ?? null, 0));
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(timestamp, vaultId);
    recordVaultEvent(vaultId, actor, "secret.create", { secretId: id, count: valueEntries.length });
  }))();
  return writtenSecret(actor, vaultId, id);
}

export function updateSecret(actor: VaultActor, vaultId: string, secretId: string, input: { name?: string; type?: SecretType; comment?: string | null; tags?: string[]; expectedRevision: number }) {
  const access = requireVault(actor, vaultId);
  const row = liveSecret(access, secretId);
  requireWriteEverywhere(access, secretId);
  if (row.revision !== input.expectedRevision) throw revisionChanged(row.revision);
  if (input.name !== undefined && input.name !== row.name && nameTaken(vaultId, input.name, secretId)) throw nameTakenError();
  if (input.type !== undefined && input.type !== row.type && db.query("SELECT 1 FROM vault_value_versions WHERE secret_id = ? LIMIT 1").get(secretId)) {
    throw new VaultError(409, "TYPE_HAS_VALUES", "The type can change only while the secret has no values or history");
  }
  chargeActor(actor, "write");
  const grant = vaultGrant(access, "write");
  db.transaction(() => enforceQuota(vaultId, actor.userId, () => {
    const comment = input.comment === undefined ? null : sealSecretComment(grant, secretId, input.comment);
    const result = db.query(`UPDATE vault_secrets SET name = COALESCE(?, name), type = COALESCE(?, type),
        comment_ct = CASE WHEN ? THEN ? ELSE comment_ct END, comment_generation = CASE WHEN ? THEN ? ELSE comment_generation END,
        tags = COALESCE(?, tags), revision = revision + 1, updated_by = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`).run(
      input.name ?? null, input.type ?? null,
      comment ? 1 : 0, comment?.commentCt ?? null, comment ? 1 : 0, comment?.generation ?? null,
      input.tags ? JSON.stringify(input.tags) : null, actor.userId, now(), secretId, input.expectedRevision
    );
    // `changes` also counts 037's byte trigger on `vaults`: zero means the revision moved.
    if (result.changes === 0) throw revisionChanged(row.revision);
    recordVaultEvent(vaultId, actor, "secret.update", { secretId });
  }))();
  return writtenSecret(actor, vaultId, secretId);
}

export function deleteSecret(actor: VaultActor, vaultId: string, secretId: string) {
  const access = requireVault(actor, vaultId);
  liveSecret(access, secretId);
  requireWriteEverywhere(access, secretId);
  // Deleting takes its values along: a protected environment's value needs the window (D226).
  requireUnlocked(access, (db.query("SELECT env_id FROM vault_values WHERE secret_id = ?").all(secretId) as Array<{ env_id: string }>).map((row) => row.env_id));
  chargeActor(actor, "write");
  const deletedAt = new Date();
  db.transaction(() => {
    db.query("UPDATE vault_secrets SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL").run(deletedAt.toISOString(), actor.userId, purgeAfterFrom(deletedAt), secretId);
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(now(), vaultId);
    recordVaultEvent(vaultId, actor, "secret.delete", { secretId });
  })();
  return { ok: true, binned: true };
}

// ---------------------------------------------------------------------------------------------
// Values and history

export function currentVersion(secretId: string, envId: string): { version: number; set: boolean } {
  const live = db.query("SELECT version FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secretId, envId) as { version: number } | null;
  if (live) return { version: live.version, set: true };
  const last = db.query("SELECT MAX(version) AS version FROM vault_value_versions WHERE secret_id = ? AND env_id = ?").get(secretId, envId) as { version: number | null };
  return { version: last.version ?? 0, set: false };
}

/**
 * 409 VALUE_CHANGED names every environment whose version moved (QA Q1, Q2): `changed` lists each
 * `{ envId, currentVersion }`; `envId` and `currentVersion` repeat the first one.
 */
type ChangedValue = { envId: string; currentVersion: number };
const valuesChanged = (changed: ChangedValue[]) => new VaultError(409, "VALUE_CHANGED", "This value changed since you opened it. Reload it, then edit again.", {
  currentVersion: changed[0]!.currentVersion, envId: changed[0]!.envId, changed
});
const valueChanged = (envId: string, current: number) => valuesChanged([{ envId, currentVersion: current }]);

/**
 * One value write inside the caller's transaction: CAS on `expectedVersion` (0 = not set yet),
 * seal as the next version, keep it in history, and trim history to the last 20 (D224).
 */
export function writeValueLocked(access: VaultAccess, grant: ReturnType<typeof requireEnvGrant>, secretId: string, envId: string, value: string, comment: string | null, expectedVersion: number) {
  const current = currentVersion(secretId, envId);
  if (current.version !== expectedVersion) throw valueChanged(envId, current.version);
  const version = current.version + 1;
  const sealed = sealValue(grant, { secretId, envId, version }, value, comment);
  const timestamp = now();
  const userId = access.actor.userId;
  const keyId = viaKey(access.actor);
  db.query(`INSERT INTO vault_values (secret_id, env_id, value_ct, comment_ct, generation, version, updated_by, updated_via_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(secret_id, env_id) DO UPDATE SET value_ct = excluded.value_ct, comment_ct = excluded.comment_ct, generation = excluded.generation,
      version = excluded.version, updated_by = excluded.updated_by, updated_via_key = excluded.updated_via_key, updated_at = excluded.updated_at`)
    .run(secretId, envId, sealed.valueCt, sealed.commentCt, sealed.generation, version, userId, keyId, timestamp);
  db.query("INSERT INTO vault_value_versions (secret_id, env_id, version, value_ct, comment_ct, cleared, generation, created_by, created_via_key, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)")
    .run(secretId, envId, version, sealed.valueCt, sealed.commentCt, sealed.generation, userId, keyId, timestamp);
  trimVersions(secretId, envId, version);
  return version;
}

export const trimVersions = (secretId: string, envId: string, newest: number) =>
  db.query("DELETE FROM vault_value_versions WHERE secret_id = ? AND env_id = ? AND version <= ?").run(secretId, envId, newest - VAULT_BOUNDS.versionsKept);

export type ValueResult = { secretId: string; envId: string; version: number; updatedAt: string; updatedBy: string | null };

function valueResult(secretId: string, envId: string): ValueResult {
  const row = db.query("SELECT v.version, v.updated_at, u.display_name FROM vault_values v LEFT JOIN users u ON u.id = v.updated_by WHERE v.secret_id = ? AND v.env_id = ?").get(secretId, envId) as { version: number; updated_at: string; display_name: string | null };
  return { secretId, envId, version: row.version, updatedAt: row.updated_at, updatedBy: row.display_name };
}

export function setValue(actor: VaultActor, vaultId: string, secretId: string, envId: string, input: { value: string; comment?: string | null; expectedVersion: number }): ValueResult {
  const access = requireVault(actor, vaultId);
  const secret = liveSecret(access, secretId);
  const grant = requireEnvGrant(access, envId, "write");
  checkValueForType(secret.type, input.value);
  chargeActor(actor, "write");
  db.transaction(() => enforceQuota(vaultId, actor.userId, () => {
    const version = writeValueLocked(access, grant, secretId, envId, input.value, input.comment ?? null, input.expectedVersion);
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(now(), vaultId);
    recordVaultEvent(vaultId, actor, "value.write", { secretId, envId, count: version });
  }))();
  return valueResult(secretId, envId);
}

/**
 * "Apply to other environments" (§6.2, Doppler): at most 20 values in one request, every one
 * checked (level, type, CAS) before anything is written, all in one transaction.
 */
export function setValues(actor: VaultActor, vaultId: string, secretId: string, entries: Array<{ envId: string; value: string; comment?: string | null; expectedVersion: number }>): ValueResult[] {
  const access = requireVault(actor, vaultId);
  const secret = liveSecret(access, secretId);
  if (new Set(entries.map((entry) => entry.envId)).size !== entries.length) throw new VaultError(400, "INVALID", "Each environment may appear once");
  const grants = entries.map((entry) => requireEnvGrant(access, entry.envId, "write"));
  for (const entry of entries) checkValueForType(secret.type, entry.value);
  chargeActor(actor, "write", entries.length);
  db.transaction(() => enforceQuota(vaultId, actor.userId, () => {
    // Every environment's version is checked before anything is written, and the refusal names all
    // that moved, so "Load the latest" can refresh each of them at once (QA Q2).
    const changed = entries.flatMap((entry) => {
      const current = currentVersion(secretId, entry.envId).version;
      return current === entry.expectedVersion ? [] : [{ envId: entry.envId, currentVersion: current }];
    });
    if (changed.length > 0) throw valuesChanged(changed);
    entries.forEach((entry, index) => {
      writeValueLocked(access, grants[index]!, secretId, entry.envId, entry.value, entry.comment ?? null, entry.expectedVersion);
      recordVaultEvent(vaultId, actor, "value.write", { secretId, envId: entry.envId });
    });
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(now(), vaultId);
  }))();
  return entries.map((entry) => valueResult(secretId, entry.envId));
}

/** Clearing is a version too (D224): history keeps the earlier values. */
export function clearValue(actor: VaultActor, vaultId: string, secretId: string, envId: string, expectedVersion: number) {
  const access = requireVault(actor, vaultId);
  liveSecret(access, secretId);
  const grant = requireEnvGrant(access, envId, "write");
  chargeActor(actor, "write");
  const version = db.transaction(() => {
    const current = currentVersion(secretId, envId);
    if (!current.set) throw new VaultError(404, "VALUE_NOT_SET", "This environment has no value to clear");
    if (current.version !== expectedVersion) throw valueChanged(envId, current.version);
    const next = current.version + 1;
    db.query("DELETE FROM vault_values WHERE secret_id = ? AND env_id = ?").run(secretId, envId);
    db.query("INSERT INTO vault_value_versions (secret_id, env_id, version, value_ct, comment_ct, cleared, generation, created_by, created_at) VALUES (?, ?, ?, NULL, NULL, 1, ?, ?, ?)")
      .run(secretId, envId, next, access.vault.current_generation, grant.actorId, now());
    trimVersions(secretId, envId, next);
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(now(), vaultId);
    recordVaultEvent(vaultId, actor, "value.clear", { secretId, envId });
    return next;
  })();
  return { ok: true, version };
}

export function storedValue(secretId: string, envId: string): ValueRow | null {
  return db.query("SELECT secret_id, env_id, value_ct, comment_ct, generation, version, updated_by, updated_at FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secretId, envId) as ValueRow | null;
}

export type RevealedValue = ValueResult & { value: string; comment: string | null };

/**
 * Reads one value (§7 Read value): read level on its environment; audited `value.read`; rate-limited.
 * `mcpValue` (a vault key's MCP value read, T191) also charges the key's hourly MCP value bucket.
 */
export function readValue(actor: VaultActor, vaultId: string, secretId: string, envId: string, options: { mcpValue?: boolean } = {}): RevealedValue {
  const access = requireVault(actor, vaultId);
  liveSecret(access, secretId);
  const grant = requireEnvGrant(access, envId, "read");
  const row = storedValue(secretId, envId);
  if (!row) throw new VaultError(404, "VALUE_NOT_SET", "This environment has no value");
  chargeActor(actor, "read", 1, { mcpValue: options.mcpValue });
  const opened = integrity(vaultId, actor, { secretId, envId }, () => openValue(grant, { secretId, envId, version: row.version, generation: row.generation, valueCt: row.value_ct, commentCt: row.comment_ct }));
  recordVaultEvent(vaultId, actor, "value.read", { secretId, envId, count: 1 });
  return { ...valueResult(secretId, envId), ...opened };
}

/**
 * Reveals up to 100 cells at once (§7 Reveal batch). Each cell is checked on its own; a cell the
 * caller cannot read, or that has no value, comes back as `status: "unavailable"` without saying
 * which. One audit row with the count of values opened.
 */
export function revealCells(actor: VaultActor, vaultId: string, cells: Array<{ secretId: string; envId: string }>) {
  const access = requireVault(actor, vaultId);
  // A protected environment in the batch needs the window (D226): the whole batch is refused with
  // the environments named, rather than those cells quietly coming back unavailable.
  requireUnlocked(access, [...new Set(cells.map((cell) => cell.envId))].filter((envId) => atLeast(envLevel(access, envId), "read")));
  chargeActor(actor, "read", Math.max(1, cells.length));
  const results = cells.map((cell) => {
    try {
      liveSecret(access, cell.secretId);
      const grant = requireEnvGrant(access, cell.envId, "read");
      const row = storedValue(cell.secretId, cell.envId);
      if (!row) return { ...cell, status: "unavailable" as const };
      const opened = integrity(vaultId, actor, cell, () => openValue(grant, { ...cell, version: row.version, generation: row.generation, valueCt: row.value_ct, commentCt: row.comment_ct }));
      return { ...cell, status: "ok" as const, version: row.version, ...opened };
    } catch (error) {
      if (error instanceof VaultError && error.status !== 500) return { ...cell, status: "unavailable" as const };
      throw error;
    }
  });
  const opened = results.filter((result) => result.status === "ok").length;
  if (opened > 0) recordVaultEvent(vaultId, actor, "value.read", { count: opened });
  return { cells: results };
}

export function listVersions(actor: VaultActor, vaultId: string, secretId: string, envId: string) {
  const access = requireVault(actor, vaultId);
  liveSecret(access, secretId);
  requireEnvLevel(access, envId, "read");
  const rows = db.query(`SELECT h.version, h.cleared, h.created_at, u.display_name FROM vault_value_versions h LEFT JOIN users u ON u.id = h.created_by
    WHERE h.secret_id = ? AND h.env_id = ? ORDER BY h.version DESC`).all(secretId, envId) as Array<{ version: number; cleared: number; created_at: string; display_name: string | null }>;
  return {
    current: currentVersion(secretId, envId),
    versions: rows.map((row) => ({ version: row.version, cleared: row.cleared === 1, createdAt: row.created_at, createdBy: row.display_name }))
  };
}

function storedVersion(secretId: string, envId: string, version: number) {
  const row = db.query("SELECT version, value_ct, comment_ct, cleared, generation, created_at FROM vault_value_versions WHERE secret_id = ? AND env_id = ? AND version = ?")
    .get(secretId, envId, version) as { version: number; value_ct: string | null; comment_ct: string | null; cleared: number; generation: number; created_at: string } | null;
  if (!row) throw vaultNotFound();
  return row;
}

/** One version, decrypted and audited (`version.read`). A cleared version has no value. */
export function readVersion(actor: VaultActor, vaultId: string, secretId: string, envId: string, version: number) {
  const access = requireVault(actor, vaultId);
  liveSecret(access, secretId);
  const grant = requireEnvGrant(access, envId, "read");
  const row = storedVersion(secretId, envId, version);
  if (row.cleared === 1 || row.value_ct === null) return { version, cleared: true, value: null, comment: null, createdAt: row.created_at };
  chargeActor(actor, "read");
  const opened = integrity(vaultId, actor, { secretId, envId }, () => openValue(grant, { secretId, envId, version, generation: row.generation, valueCt: row.value_ct!, commentCt: row.comment_ct }));
  recordVaultEvent(vaultId, actor, "version.read", { secretId, envId, count: version });
  return { version, cleared: false, ...opened, createdAt: row.created_at };
}

/** Restoring writes the old value as a new version (D224), through the same CAS. */
export function restoreVersion(actor: VaultActor, vaultId: string, secretId: string, envId: string, version: number, expectedVersion: number): ValueResult {
  const access = requireVault(actor, vaultId);
  const secret = liveSecret(access, secretId);
  const grant = requireEnvGrant(access, envId, "write");
  const row = storedVersion(secretId, envId, version);
  if (row.cleared === 1 || row.value_ct === null) throw new VaultError(409, "VERSION_CLEARED", "That version cleared the value; there is nothing to restore");
  chargeActor(actor, "write");
  const opened = integrity(vaultId, actor, { secretId, envId }, () => openValue(grant, { secretId, envId, version, generation: row.generation, valueCt: row.value_ct!, commentCt: row.comment_ct }));
  checkValueForType(secret.type, opened.value);
  db.transaction(() => enforceQuota(vaultId, actor.userId, () => {
    writeValueLocked(access, grant, secretId, envId, opened.value, opened.comment, expectedVersion);
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(now(), vaultId);
    recordVaultEvent(vaultId, actor, "value.restore", { secretId, envId, count: version });
  }))();
  return valueResult(secretId, envId);
}

/** For tests and the Bin: the live environment row (or null). */
export const liveEnvironment = (vaultId: string, envId: string) =>
  db.query("SELECT id, vault_id, slug, name, position, protected, created_at FROM vault_environments WHERE id = ? AND vault_id = ? AND deleted_at IS NULL").get(envId, vaultId) as EnvRow | null;

