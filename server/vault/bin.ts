import { registerBinProvider, SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { atLeast, levelIgnoringBin, roleCap, type VaultLevel } from "./access";
import { recordVaultEvent } from "./service";
import { VAULT_BOUNDS } from "../../shared/vault";

/**
 * Vaults, environments, and secrets in the Bin (vault plan §6.5, D225, T196), registered with
 * server/bin.ts as providers.
 *
 * - Listed with their plaintext names (D222) to the vault's owners, and to whoever binned an
 *   environment or secret while they still hold write there (their own row or a group; Wave 26).
 *   Other members of a shared vault never see its Bin rows, and nobody sees a binned vault's name
 *   but its owners. A binned vault hides its binned
 *   environments and secrets: restoring the vault brings them back as they were.
 * - Restore: owners always; the deleter while they still hold write. A name or short name another
 *   live item took meanwhile is 409 `NAME_TAKEN`; a binned parent is `PARENT_IN_BIN`.
 * - Purge: owners only. Tombstone (`purge_started_at`), then delete the rows in one transaction:
 *   cascades remove values, versions, and access rows, and a vault's purge also deletes its
 *   `vault_keys`, which crypto-shreds anything a backup still holds. No API key or MCP tool can
 *   purge (Wave 27 adds `restore_vault_item` only).
 */

const lock = (vaultId: string) => `vault:${vaultId}`;
const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;

const isOwner = (vaultId: string, userId: string) => roleCap(userId) === "admin"
  && Boolean(db.query("SELECT 1 FROM vault_members WHERE vault_id = ? AND user_id = ? AND role = 'owner'").get(vaultId, userId));

/** The caller's level on one environment of a live vault (own row or groups), ignoring whether the environment itself is binned. */
const rawLevel = (vaultId: string, envId: string, userId: string): VaultLevel => levelIgnoringBin(vaultId, envId, userId);

/** Whether a deleter still writes on every live environment where the secret has a value (D216). */
function writesSecret(vaultId: string, secretId: string, userId: string) {
  const envs = (db.query(`SELECT e.id FROM vault_values v JOIN vault_environments e ON e.id = v.env_id AND e.deleted_at IS NULL WHERE v.secret_id = ?`).all(secretId) as Array<{ id: string }>).map((row) => row.id);
  if (envs.length === 0) {
    const all = db.query("SELECT id FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL").all(vaultId) as Array<{ id: string }>;
    return all.some((env) => atLeast(rawLevel(vaultId, env.id, userId), "write"));
  }
  return envs.every((envId) => atLeast(rawLevel(vaultId, envId, userId), "write"));
}

type BinnedVault = { id: string; name: string; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null };
type BinnedEnv = { id: string; vault_id: string; vault_name: string; slug: string; name: string; deleted_by: string | null; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null; vault_deleted_at: string | null };
type BinnedSecret = { id: string; vault_id: string; vault_name: string; name: string; deleted_by: string | null; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null; vault_deleted_at: string | null };

// ---------------------------------------------------------------------------------------------
// Purges (one transaction each; nothing lives outside SQLite)

function purgeVaultNow(vaultId: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE vaults SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id: vaultId, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    const keys = (db.query("SELECT COUNT(*) AS count FROM vault_keys WHERE vault_id = ?").get(vaultId) as { count: number }).count;
    // Cascades remove keys (crypto-shred), environments, secrets, values, versions, members, access, and events.
    db.query("DELETE FROM vault_keys WHERE vault_id = ?").run(vaultId);
    db.query("DELETE FROM vaults WHERE id = ?").run(vaultId);
    audit(options.actorId, null, "vault.purge", { vaultId, reason: options.reason, keys });
    return "purged";
  })();
}

function purgeEnvNow(envId: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const row = db.query("SELECT vault_id FROM vault_environments WHERE id = ?").get(envId) as { vault_id: string } | null;
    if (!row) return "not_found";
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE vault_environments SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id: envId, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM vault_environments WHERE id = ?").run(envId);
    recordVaultEvent(row.vault_id, options.actorId, "env.purge", { envId }, options.actorId ? "session" : "sweeper");
    return "purged";
  })();
}

function purgeSecretNow(secretId: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const row = db.query("SELECT vault_id FROM vault_secrets WHERE id = ?").get(secretId) as { vault_id: string } | null;
    if (!row) return "not_found";
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE vault_secrets SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id: secretId, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM vault_secrets WHERE id = ?").run(secretId);
    recordVaultEvent(row.vault_id, options.actorId, "secret.purge", { secretId }, options.actorId ? "session" : "sweeper");
    return "purged";
  })();
}

async function sweepTable(table: "vaults" | "vault_environments" | "vault_secrets", purge: (id: string, options: { reason: PurgeReason; actorId: null; dueBy: string }) => PurgeOutcome, lockOf: (id: string) => string, cutoff: string): Promise<BinSweepCounts> {
  const resumed = db.query(`SELECT id FROM ${table} WHERE purge_started_at IS NOT NULL LIMIT ?`).all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
  const due = db.query(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?`).all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
    for (const { id } of items) {
      const outcome = await withResourceLock(lockOf(id), async () => purge(id, { reason, actorId: null, dueBy: cutoff }));
      if (outcome === "purged") counts.purged += 1;
    }
  }
  return counts;
}

const vaultOf = (table: "vault_environments" | "vault_secrets", id: string) => (db.query(`SELECT vault_id FROM ${table} WHERE id = ?`).get(id) as { vault_id: string } | null)?.vault_id ?? id;
const add = (a: BinSweepCounts, b: BinSweepCounts) => ({ purged: a.purged + b.purged, pending: a.pending + b.pending });

// ---------------------------------------------------------------------------------------------
// vault

registerBinProvider("vault", {
  list(userId) {
    if (roleCap(userId) !== "admin") return [];
    const rows = db.query(`SELECT v.id, v.name, v.deleted_at, v.purge_after, v.purge_started_at FROM vaults v
      JOIN vault_members m ON m.vault_id = v.id AND m.user_id = ? AND m.role = 'owner'
      WHERE v.deleted_at IS NOT NULL ORDER BY v.deleted_at DESC, v.id LIMIT 500`).all(userId) as BinnedVault[];
    return rows.map((row): BinItem => ({
      type: "vault", id: row.id, title: row.name, folder_id: null, folder_name: "Vault", deleted_at: row.deleted_at!, purge_after: row.purge_after!,
      purging: row.purge_started_at !== null, ...providedDefaults, can_purge: true
    }));
  },

  restore(id, userId) {
    return withResourceLock(lock(id), async (): Promise<RestoreOutcome> => {
      const row = db.query("SELECT id, name, deleted_at, purge_after, purge_started_at FROM vaults WHERE id = ?").get(id) as BinnedVault | null;
      if (!row || !isOwner(id, userId)) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: id, folderName: row.name };
      const owned = (db.query("SELECT COUNT(*) AS count FROM vaults WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
      if (owned >= VAULT_BOUNDS.ownedVaults) return { status: "limit_reached", message: `You can own up to ${VAULT_BOUNDS.ownedVaults} vaults` };
      return db.transaction((): RestoreOutcome => {
        const restored = db.query("UPDATE vaults SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL").run(now(), id);
        if (restored.changes !== 1) return { status: "purging" };
        recordVaultEvent(id, userId, "vault.restore");
        return { status: "restored", folderId: id, folderName: row.name, visibility: "private" };
      })();
    });
  },

  purge(id, userId) {
    return withResourceLock(lock(id), async () => {
      const row = db.query("SELECT deleted_at FROM vaults WHERE id = ?").get(id) as { deleted_at: string | null } | null;
      if (!row || !isOwner(id, userId)) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeVaultNow(id, { reason: "user", actorId: userId });
    });
  },

  sweep: (cutoff) => sweepTable("vaults", purgeVaultNow, lock, cutoff),

  async empty(userId) {
    let counts: BinSweepCounts = { purged: 0, pending: 0 };
    const ids = db.query(`SELECT v.id FROM vaults v JOIN vault_members m ON m.vault_id = v.id AND m.user_id = ? AND m.role = 'owner' WHERE v.deleted_at IS NOT NULL`).all(userId) as Array<{ id: string }>;
    for (const { id } of ids) {
      if (!isOwner(id, userId)) continue;
      const outcome = await withResourceLock(lock(id), async () => purgeVaultNow(id, { reason: "user", actorId: userId }));
      counts = add(counts, { purged: outcome === "purged" ? 1 : 0, pending: 0 });
    }
    return counts;
  }
});

// ---------------------------------------------------------------------------------------------
// vault_environment

const binnedEnvSelect = `SELECT e.id, e.vault_id, v.name AS vault_name, e.slug, e.name, e.deleted_by, e.deleted_at, e.purge_after, e.purge_started_at, v.deleted_at AS vault_deleted_at
  FROM vault_environments e JOIN vaults v ON v.id = e.vault_id`;
const envVisible = (row: BinnedEnv, userId: string) => isOwner(row.vault_id, userId) || (row.deleted_by === userId && atLeast(rawLevel(row.vault_id, row.id, userId), "write"));

registerBinProvider("vault_environment", {
  list(userId) {
    const rows = db.query(`${binnedEnvSelect} WHERE (e.deleted_by = $userId OR EXISTS (SELECT 1 FROM vault_members m WHERE m.vault_id = e.vault_id AND m.user_id = $userId AND m.role = 'owner'))
      AND e.deleted_at IS NOT NULL AND v.deleted_at IS NULL AND v.purge_started_at IS NULL ORDER BY e.deleted_at DESC, e.id LIMIT 500`).all({ userId }) as BinnedEnv[];
    return rows.filter((row) => envVisible(row, userId)).map((row): BinItem => ({
      type: "vault_environment", id: row.id, title: row.name, folder_id: row.vault_id, folder_name: row.vault_name,
      deleted_at: row.deleted_at!, purge_after: row.purge_after!, purging: row.purge_started_at !== null, ...providedDefaults, can_purge: isOwner(row.vault_id, userId)
    }));
  },

  async restore(id, userId) {
    const initial = db.query(`${binnedEnvSelect} WHERE e.id = ?`).get(id) as BinnedEnv | null;
    if (!initial || !envVisible(initial, userId)) return { status: "not_found" };
    return withResourceLock(lock(initial.vault_id), async (): Promise<RestoreOutcome> => {
      const row = db.query(`${binnedEnvSelect} WHERE e.id = ?`).get(id) as BinnedEnv | null;
      if (!row || !envVisible(row, userId)) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.vault_deleted_at !== null) return { status: "parent_in_bin", message: "Restore its vault from the Bin first" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: row.vault_id, folderName: row.vault_name };
      const live = db.query("SELECT slug FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL").all(row.vault_id) as Array<{ slug: string }>;
      if (live.length >= VAULT_BOUNDS.environments) return { status: "limit_reached", message: `A vault has at most ${VAULT_BOUNDS.environments} environments` };
      if (live.some((env) => env.slug === row.slug)) return { status: "name_taken", message: `Another environment in ${row.vault_name} already uses the short name ${row.slug}` };
      return db.transaction((): RestoreOutcome => {
        const position = (db.query("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL").get(row.vault_id) as { next: number }).next;
        const restored = db.query("UPDATE vault_environments SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, position = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL").run(position, id);
        if (restored.changes !== 1) return { status: "purging" };
        db.query("UPDATE vaults SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), row.vault_id);
        recordVaultEvent(row.vault_id, userId, "env.restore", { envId: id });
        return { status: "restored", folderId: row.vault_id, folderName: row.vault_name, visibility: "private" };
      })();
    });
  },

  purge(id, userId) {
    const vaultId = vaultOf("vault_environments", id);
    return withResourceLock(lock(vaultId), async () => {
      const row = db.query("SELECT vault_id, deleted_at FROM vault_environments WHERE id = ?").get(id) as { vault_id: string; deleted_at: string | null } | null;
      if (!row || !isOwner(row.vault_id, userId)) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeEnvNow(id, { reason: "user", actorId: userId });
    });
  },

  sweep: (cutoff) => sweepTable("vault_environments", purgeEnvNow, (id) => lock(vaultOf("vault_environments", id)), cutoff),

  async empty(userId) {
    let counts: BinSweepCounts = { purged: 0, pending: 0 };
    const rows = db.query(`SELECT e.id, e.vault_id FROM vault_environments e JOIN vault_members m ON m.vault_id = e.vault_id AND m.user_id = ? AND m.role = 'owner'
      JOIN vaults v ON v.id = e.vault_id WHERE e.deleted_at IS NOT NULL AND v.deleted_at IS NULL`).all(userId) as Array<{ id: string; vault_id: string }>;
    for (const row of rows) {
      if (!isOwner(row.vault_id, userId)) continue;
      const outcome = await withResourceLock(lock(row.vault_id), async () => purgeEnvNow(row.id, { reason: "user", actorId: userId }));
      counts = add(counts, { purged: outcome === "purged" ? 1 : 0, pending: 0 });
    }
    return counts;
  }
});

// ---------------------------------------------------------------------------------------------
// vault_secret

const binnedSecretSelect = `SELECT s.id, s.vault_id, v.name AS vault_name, s.name, s.deleted_by, s.deleted_at, s.purge_after, s.purge_started_at, v.deleted_at AS vault_deleted_at
  FROM vault_secrets s JOIN vaults v ON v.id = s.vault_id`;
const secretVisible = (row: BinnedSecret, userId: string) => isOwner(row.vault_id, userId) || (row.deleted_by === userId && writesSecret(row.vault_id, row.id, userId));

registerBinProvider("vault_secret", {
  list(userId) {
    const rows = db.query(`${binnedSecretSelect} WHERE (s.deleted_by = $userId OR EXISTS (SELECT 1 FROM vault_members m WHERE m.vault_id = s.vault_id AND m.user_id = $userId AND m.role = 'owner'))
      AND s.deleted_at IS NOT NULL AND v.deleted_at IS NULL AND v.purge_started_at IS NULL ORDER BY s.deleted_at DESC, s.id LIMIT 500`).all({ userId }) as BinnedSecret[];
    return rows.filter((row) => secretVisible(row, userId)).map((row): BinItem => ({
      type: "vault_secret", id: row.id, title: row.name, folder_id: row.vault_id, folder_name: row.vault_name,
      deleted_at: row.deleted_at!, purge_after: row.purge_after!, purging: row.purge_started_at !== null, ...providedDefaults, can_purge: isOwner(row.vault_id, userId)
    }));
  },

  async restore(id, userId) {
    const initial = db.query(`${binnedSecretSelect} WHERE s.id = ?`).get(id) as BinnedSecret | null;
    if (!initial || !secretVisible(initial, userId)) return { status: "not_found" };
    return withResourceLock(lock(initial.vault_id), async (): Promise<RestoreOutcome> => {
      const row = db.query(`${binnedSecretSelect} WHERE s.id = ?`).get(id) as BinnedSecret | null;
      if (!row || !secretVisible(row, userId)) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.vault_deleted_at !== null) return { status: "parent_in_bin", message: "Restore its vault from the Bin first" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: row.vault_id, folderName: row.vault_name };
      const live = (db.query("SELECT COUNT(*) AS count FROM vault_secrets WHERE vault_id = ? AND deleted_at IS NULL").get(row.vault_id) as { count: number }).count;
      if (live >= VAULT_BOUNDS.secretsPerVault) return { status: "limit_reached", message: `A vault holds at most ${VAULT_BOUNDS.secretsPerVault} secrets` };
      if (db.query("SELECT 1 FROM vault_secrets WHERE vault_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL").get(row.vault_id, row.name)) {
        return { status: "name_taken", message: `Another secret in ${row.vault_name} is already called ${row.name}` };
      }
      return db.transaction((): RestoreOutcome => {
        const restored = db.query("UPDATE vault_secrets SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL").run(now(), id);
        if (restored.changes !== 1) return { status: "purging" };
        recordVaultEvent(row.vault_id, userId, "secret.restore", { secretId: id });
        return { status: "restored", folderId: row.vault_id, folderName: row.vault_name, visibility: "private" };
      })();
    });
  },

  purge(id, userId) {
    const vaultId = vaultOf("vault_secrets", id);
    return withResourceLock(lock(vaultId), async () => {
      const row = db.query("SELECT vault_id, deleted_at FROM vault_secrets WHERE id = ?").get(id) as { vault_id: string; deleted_at: string | null } | null;
      if (!row || !isOwner(row.vault_id, userId)) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeSecretNow(id, { reason: "user", actorId: userId });
    });
  },

  sweep: (cutoff) => sweepTable("vault_secrets", purgeSecretNow, (id) => lock(vaultOf("vault_secrets", id)), cutoff),

  async empty(userId) {
    let counts: BinSweepCounts = { purged: 0, pending: 0 };
    const rows = db.query(`SELECT s.id, s.vault_id FROM vault_secrets s JOIN vault_members m ON m.vault_id = s.vault_id AND m.user_id = ? AND m.role = 'owner'
      JOIN vaults v ON v.id = s.vault_id WHERE s.deleted_at IS NOT NULL AND v.deleted_at IS NULL`).all(userId) as Array<{ id: string; vault_id: string }>;
    for (const row of rows) {
      if (!isOwner(row.vault_id, userId)) continue;
      const outcome = await withResourceLock(lock(row.vault_id), async () => purgeSecretNow(row.id, { reason: "user", actorId: userId }));
      counts = add(counts, { purged: outcome === "purged" ? 1 : 0, pending: 0 });
    }
    return counts;
  }
});
