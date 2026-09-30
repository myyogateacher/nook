import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";
import { db, now } from "../db";
import { atLeast, isVaultGrant, VaultError, type VaultGrant } from "./access";

/**
 * The Vault's only encryption and decryption (vault plan §3.3, D211, D213, T181, T189, T190).
 *
 * - Key hierarchy: VAULT_ENCRYPTION_KEY (the KEK) wraps one random 256-bit data key (DEK) per vault
 *   and generation, stored in `vault_keys.wrapped_dek`. Values and comments are sealed with the DEK.
 * - Every envelope is AES-256-GCM with a random 96-bit nonce, stored as `v1:<nonce>:<tag>:<ct>`
 *   (base64url; the `server/totp.ts` format) and bound by its AAD to exactly where it belongs:
 *     DEK            nook:vault-dek:v1:<vaultId>:<generation>
 *     value          nook:vault-value:v1:<vaultId>:<secretId>:<envId>:<version>
 *     value comment  nook:vault-value-comment:v1:<vaultId>:<secretId>:<envId>:<version>
 *     secret comment nook:vault-secret-comment:v1:<vaultId>:<secretId>
 *   A ciphertext moved to another vault, secret, environment, version, or field fails to open, and
 *   that failure is `VAULT_INTEGRITY` (500), never a value.
 * - Opening or sealing needs a `VaultGrant` minted by `access.ts` after its check (D213). DEKs are
 *   unwrapped per call and never cached.
 *
 * Nothing here logs, and no error carries key material, plaintext, or ciphertext (T188).
 * tests/vaultGuard.test.ts fails if any other server file uses the cipher functions.
 */

const FORMAT = "v1";
/** Plaintext bounds (D227): a value at most 64 KiB, a comment at most 2 KiB, both as UTF-8 bytes. */
export const VALUE_MAX_BYTES = 64 * 1024;
export const COMMENT_MAX_BYTES = 2 * 1024;

export const AAD = {
  dek: (vaultId: string, generation: number) => `nook:vault-dek:v1:${vaultId}:${generation}`,
  value: (vaultId: string, secretId: string, envId: string, version: number) => `nook:vault-value:v1:${vaultId}:${secretId}:${envId}:${version}`,
  valueComment: (vaultId: string, secretId: string, envId: string, version: number) => `nook:vault-value-comment:v1:${vaultId}:${secretId}:${envId}:${version}`,
  secretComment: (vaultId: string, secretId: string) => `nook:vault-secret-comment:v1:${vaultId}:${secretId}`
} as const;

export class VaultIntegrityError extends Error {
  constructor() {
    super("Stored vault data failed its integrity check");
    this.name = "VaultIntegrityError";
  }
}

/**
 * Low-level envelope sealing. Exported for the crypto test vectors and the key CLI only; the
 * service never calls it (it has no grant check).
 */
export function sealEnvelope(key: Buffer, plaintext: Buffer, aad: string, nonce: Buffer = randomBytes(12)): string {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("Invalid vault key or nonce length");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${FORMAT}:${nonce.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Low-level opening; any malformed envelope, wrong key, or AAD mismatch is a `VaultIntegrityError`. */
export function openEnvelope(key: Buffer, envelope: string, aad: string): Buffer {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT || !parts.slice(1).every((part) => B64URL.test(part))) throw new VaultIntegrityError();
  const nonce = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new VaultIntegrityError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]);
  } catch {
    throw new VaultIntegrityError();
  }
}

/** The configured KEK; 503 VAULT_DISABLED without one. */
export function kek(): Buffer {
  const key = config.vault.key;
  if (!key) throw new VaultError(503, "VAULT_DISABLED", "The vault is not configured on this server");
  return key;
}

export const wrapDek = (key: Buffer, vaultId: string, generation: number, dek: Buffer) => sealEnvelope(key, dek, AAD.dek(vaultId, generation));
export function unwrapDek(key: Buffer, vaultId: string, generation: number, wrapped: string): Buffer {
  const dek = openEnvelope(key, wrapped, AAD.dek(vaultId, generation));
  if (dek.length !== 32) throw new VaultIntegrityError();
  return dek;
}

/** A fresh wrapped DEK for a new vault or generation (the caller inserts it in its transaction). */
export function newWrappedDek(vaultId: string, generation: number): string {
  const dek = randomBytes(32);
  try {
    return wrapDek(kek(), vaultId, generation, dek);
  } finally {
    dek.fill(0);
  }
}

function dekFor(vaultId: string, generation: number): Buffer {
  const row = db.query("SELECT wrapped_dek FROM vault_keys WHERE vault_id = ? AND generation = ?").get(vaultId, generation) as { wrapped_dek: string } | null;
  if (!row) throw new VaultIntegrityError();
  return unwrapDek(kek(), vaultId, generation, row.wrapped_dek);
}

function currentGeneration(vaultId: string): number {
  const row = db.query("SELECT current_generation FROM vaults WHERE id = ?").get(vaultId) as { current_generation: number } | null;
  if (!row) throw new VaultIntegrityError();
  return row.current_generation;
}

function checkGrant(grant: VaultGrant, envId: string | null, min: "read" | "write") {
  // A forged or reused-shape object, a grant for another environment, or a level below `min` is a
  // programming error behind the access check: fail closed, loudly, without any data.
  if (!isVaultGrant(grant) || grant.envId !== envId || !atLeast(grant.level, min)) throw new Error("Vault grant refused");
}

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

export type SealedValue = { valueCt: string; commentCt: string | null; generation: number };

/** Seals one value (and its optional comment) for `(secretId, envId, version)` in the grant's vault. */
export function sealValue(grant: VaultGrant, target: { secretId: string; envId: string; version: number }, value: string, comment: string | null): SealedValue {
  checkGrant(grant, target.envId, "write");
  if (utf8Bytes(value) > VALUE_MAX_BYTES || (comment !== null && utf8Bytes(comment) > COMMENT_MAX_BYTES)) throw new VaultError(413, "TOO_LARGE", "The value or comment is too large");
  const generation = currentGeneration(grant.vaultId);
  const dek = dekFor(grant.vaultId, generation);
  try {
    return {
      valueCt: sealEnvelope(dek, Buffer.from(value, "utf8"), AAD.value(grant.vaultId, target.secretId, target.envId, target.version)),
      commentCt: comment === null || comment === "" ? null : sealEnvelope(dek, Buffer.from(comment, "utf8"), AAD.valueComment(grant.vaultId, target.secretId, target.envId, target.version)),
      generation
    };
  } finally {
    dek.fill(0);
  }
}

export type StoredValue = { secretId: string; envId: string; version: number; generation: number; valueCt: string; commentCt: string | null };

/** Opens one stored value and its comment. The row's ids come from the query; the vault from the grant. */
export function openValue(grant: VaultGrant, row: StoredValue): { value: string; comment: string | null } {
  checkGrant(grant, row.envId, "read");
  const dek = dekFor(grant.vaultId, row.generation);
  try {
    const value = openEnvelope(dek, row.valueCt, AAD.value(grant.vaultId, row.secretId, row.envId, row.version)).toString("utf8");
    const comment = row.commentCt === null ? null : openEnvelope(dek, row.commentCt, AAD.valueComment(grant.vaultId, row.secretId, row.envId, row.version)).toString("utf8");
    return { value, comment };
  } finally {
    dek.fill(0);
  }
}

/** Seals a secret's own comment (vault-wide material). An empty comment is stored as NULL. */
export function sealSecretComment(grant: VaultGrant, secretId: string, comment: string | null): { commentCt: string | null; generation: number | null } {
  checkGrant(grant, null, "write");
  if (comment === null || comment === "") return { commentCt: null, generation: null };
  if (utf8Bytes(comment) > COMMENT_MAX_BYTES) throw new VaultError(413, "TOO_LARGE", "The comment is too large");
  const generation = currentGeneration(grant.vaultId);
  const dek = dekFor(grant.vaultId, generation);
  try {
    return { commentCt: sealEnvelope(dek, Buffer.from(comment, "utf8"), AAD.secretComment(grant.vaultId, secretId)), generation };
  } finally {
    dek.fill(0);
  }
}

export function openSecretComment(grant: VaultGrant, row: { secretId: string; commentCt: string | null; generation: number | null }): string | null {
  checkGrant(grant, null, "read");
  if (row.commentCt === null || row.generation === null) return null;
  const dek = dekFor(grant.vaultId, row.generation);
  try {
    return openEnvelope(dek, row.commentCt, AAD.secretComment(grant.vaultId, row.secretId)).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/**
 * Host checks (T199, `vault-admin.ts verify-key`, the boot check): whether `key` opens every stored
 * DEK. Returns counts only.
 */
export function verifyKeys(key: Buffer, options: { liveOnly?: boolean } = {}): { vaults: number; keys: number; failed: number } {
  const filter = options.liveOnly ? "WHERE k.vault_id IN (SELECT id FROM vaults WHERE deleted_at IS NULL) AND k.generation = (SELECT current_generation FROM vaults v WHERE v.id = k.vault_id)" : "";
  const rows = db.query(`SELECT k.vault_id, k.generation, k.wrapped_dek FROM vault_keys k ${filter}`).all() as Array<{ vault_id: string; generation: number; wrapped_dek: string }>;
  let failed = 0;
  for (const row of rows) {
    try {
      unwrapDek(key, row.vault_id, row.generation, row.wrapped_dek).fill(0);
    } catch {
      failed += 1;
    }
  }
  return { vaults: new Set(rows.map((row) => row.vault_id)).size, keys: rows.length, failed };
}

/**
 * KEK rotation (`vault-admin.ts rotate-kek`): re-wraps every DEK from `oldKey` to `newKey` in one
 * transaction. Values are not touched (seconds, not a re-encryption). Any DEK the old key cannot
 * open aborts the whole run with nothing changed. The rows are read inside a `BEGIN IMMEDIATE`
 * transaction, so no other connection can add or change a data key between the read and the
 * re-wrap (review L3); the CLI also refuses to run while a server heartbeat is fresh, because a
 * running server keeps wrapping new data keys with the old key until it restarts.
 */
export function rotateKek(oldKey: Buffer, newKey: Buffer): { keys: number } {
  return db.transaction(() => {
    const rows = db.query("SELECT vault_id, generation, wrapped_dek FROM vault_keys").all() as Array<{ vault_id: string; generation: number; wrapped_dek: string }>;
    for (const row of rows) {
      const dek = unwrapDek(oldKey, row.vault_id, row.generation, row.wrapped_dek);
      try {
        const rewrapped = wrapDek(newKey, row.vault_id, row.generation, dek);
        unwrapDek(newKey, row.vault_id, row.generation, rewrapped).fill(0);
        db.query("UPDATE vault_keys SET wrapped_dek = ? WHERE vault_id = ? AND generation = ?").run(rewrapped, row.vault_id, row.generation);
      } finally {
        dek.fill(0);
      }
    }
    return { keys: rows.length };
  }).immediate();
}

/** Records when a DEK was created (the service's vault creation uses this with `newWrappedDek`). */
export function insertVaultKey(vaultId: string, generation: number) {
  db.query("INSERT INTO vault_keys (vault_id, generation, wrapped_dek, created_at) VALUES (?, ?, ?, ?)").run(vaultId, generation, newWrappedDek(vaultId, generation), now());
}

// ---------------------------------------------------------------------------------------------
// DEK rotation (vault plan §3.3, §6.6; Wave 26). The service decides who may rotate (owners); the
// work that touches plaintext stays here, where plaintext never leaves the function that opened it.

/**
 * Starts a new data-key generation: a fresh DEK wrapped by the KEK, and the vault's current
 * generation moves to it, so every write from now on uses it. Older rows keep their generation until
 * `reencryptBatch` moves them. Call inside the caller's transaction. Returns the new generation.
 */
export function startGeneration(vaultId: string): number {
  const next = currentGeneration(vaultId) + 1;
  insertVaultKey(vaultId, next);
  db.query("UPDATE vaults SET current_generation = ? WHERE id = ?").run(next, vaultId);
  return next;
}

type RotRow = { secret_id: string; env_id: string; version: number; generation: number; value_ct: string | null; comment_ct: string | null };

/**
 * Re-encrypts at most `limit` rows of one vault that are still under an older generation: current
 * values, history (a cleared version only takes the new generation number), and secret comments.
 * Each row is opened under its own ids and generation and sealed again under the current one with
 * the same AAD, then written with a compare-and-swap on its old ciphertext, in one transaction. Rows
 * that fail to open are left alone and counted (`failed`): never guessed, never dropped. Returns how
 * many rows moved and whether any remain.
 */
export function reencryptBatch(vaultId: string, limit: number): { moved: number; failed: number; remaining: boolean } {
  return db.transaction(() => {
    const target = currentGeneration(vaultId);
    const keys = new Map<number, Buffer>();
    const keyFor = (generation: number) => {
      let key = keys.get(generation);
      if (!key) {
        key = dekFor(vaultId, generation);
        keys.set(generation, key);
      }
      return key;
    };
    let moved = 0;
    let failed = 0;
    try {
      const values = db.query(`SELECT v.secret_id, v.env_id, v.version, v.generation, v.value_ct, v.comment_ct FROM vault_values v JOIN vault_secrets s ON s.id = v.secret_id
        WHERE s.vault_id = ? AND v.generation < ? LIMIT ?`).all(vaultId, target, limit) as RotRow[];
      const reseal = (row: RotRow) => {
        const from = keyFor(row.generation);
        const to = keyFor(target);
        const valueCt = row.value_ct === null ? null
          : sealEnvelope(to, openEnvelope(from, row.value_ct, AAD.value(vaultId, row.secret_id, row.env_id, row.version)), AAD.value(vaultId, row.secret_id, row.env_id, row.version));
        const commentCt = row.comment_ct === null ? null
          : sealEnvelope(to, openEnvelope(from, row.comment_ct, AAD.valueComment(vaultId, row.secret_id, row.env_id, row.version)), AAD.valueComment(vaultId, row.secret_id, row.env_id, row.version));
        return { valueCt, commentCt };
      };
      for (const row of values) {
        try {
          const next = reseal(row);
          moved += db.query("UPDATE vault_values SET value_ct = ?, comment_ct = ?, generation = ? WHERE secret_id = ? AND env_id = ? AND version = ? AND generation = ?")
            .run(next.valueCt, next.commentCt, target, row.secret_id, row.env_id, row.version, row.generation).changes > 0 ? 1 : 0;
        } catch (error) {
          if (!(error instanceof VaultIntegrityError)) throw error;
          failed += 1;
        }
      }
      const room = limit - values.length;
      const versions = room <= 0 ? [] : db.query(`SELECT h.secret_id, h.env_id, h.version, h.generation, h.value_ct, h.comment_ct FROM vault_value_versions h JOIN vault_secrets s ON s.id = h.secret_id
        WHERE s.vault_id = ? AND h.generation < ? LIMIT ?`).all(vaultId, target, room) as RotRow[];
      for (const row of versions) {
        try {
          const next = reseal(row);
          moved += db.query("UPDATE vault_value_versions SET value_ct = ?, comment_ct = ?, generation = ? WHERE secret_id = ? AND env_id = ? AND version = ? AND generation = ?")
            .run(next.valueCt, next.commentCt, target, row.secret_id, row.env_id, row.version, row.generation).changes > 0 ? 1 : 0;
        } catch (error) {
          if (!(error instanceof VaultIntegrityError)) throw error;
          failed += 1;
        }
      }
      const left = room - versions.length;
      const comments = left <= 0 ? [] : db.query("SELECT id, comment_ct, comment_generation FROM vault_secrets WHERE vault_id = ? AND comment_generation < ? LIMIT ?")
        .all(vaultId, target, left) as Array<{ id: string; comment_ct: string; comment_generation: number }>;
      for (const row of comments) {
        try {
          const aad = AAD.secretComment(vaultId, row.id);
          const commentCt = sealEnvelope(keyFor(target), openEnvelope(keyFor(row.comment_generation), row.comment_ct, aad), aad);
          moved += db.query("UPDATE vault_secrets SET comment_ct = ?, comment_generation = ? WHERE id = ? AND comment_generation = ? AND comment_ct = ?")
            .run(commentCt, target, row.id, row.comment_generation, row.comment_ct).changes > 0 ? 1 : 0;
        } catch (error) {
          if (!(error instanceof VaultIntegrityError)) throw error;
          failed += 1;
        }
      }
      return { moved, failed, remaining: pendingRows(vaultId, target) > failed };
    } finally {
      for (const key of keys.values()) key.fill(0);
    }
  })();
}

/** Rows of a vault still under a generation older than `target`. */
export function pendingRows(vaultId: string, target: number): number {
  const count = (sql: string) => (db.query(sql).get(vaultId, target) as { count: number }).count;
  return count("SELECT COUNT(*) AS count FROM vault_values v JOIN vault_secrets s ON s.id = v.secret_id WHERE s.vault_id = ? AND v.generation < ?")
    + count("SELECT COUNT(*) AS count FROM vault_value_versions h JOIN vault_secrets s ON s.id = h.secret_id WHERE s.vault_id = ? AND h.generation < ?")
    + count("SELECT COUNT(*) AS count FROM vault_secrets WHERE vault_id = ? AND comment_generation < ?");
}

/**
 * Retires every older generation nothing references any more: its wrapped DEK row is deleted, so
 * ciphertext of that generation (in an old backup, say) cannot be opened with this database's keys.
 * Returns the generations retired.
 */
export function retireGenerations(vaultId: string): number[] {
  return db.transaction(() => {
    const target = currentGeneration(vaultId);
    const old = (db.query("SELECT generation FROM vault_keys WHERE vault_id = ? AND generation < ? ORDER BY generation").all(vaultId, target) as Array<{ generation: number }>).map((row) => row.generation);
    const referenced = (generation: number) => Boolean(
      db.query("SELECT 1 FROM vault_values v JOIN vault_secrets s ON s.id = v.secret_id WHERE s.vault_id = ? AND v.generation = ? LIMIT 1").get(vaultId, generation)
      || db.query("SELECT 1 FROM vault_value_versions h JOIN vault_secrets s ON s.id = h.secret_id WHERE s.vault_id = ? AND h.generation = ? LIMIT 1").get(vaultId, generation)
      || db.query("SELECT 1 FROM vault_secrets WHERE vault_id = ? AND comment_generation = ? LIMIT 1").get(vaultId, generation));
    const retired = old.filter((generation) => !referenced(generation));
    for (const generation of retired) db.query("DELETE FROM vault_keys WHERE vault_id = ? AND generation = ?").run(vaultId, generation);
    return retired;
  })();
}
