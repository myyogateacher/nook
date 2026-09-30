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
