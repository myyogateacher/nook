import { config, parseVaultKey } from "./config";
import { audit, db } from "./db";
import { rotateKek, verifyKeys } from "./vault/crypto";
import { recordVaultEvent } from "./vault/service";

/**
 * Host CLI for the Vault's key (vault plan §3.3, §8, T199). Run it on the host, with the same
 * environment (DATA_DIR and the key variables) as the server. It prints counts only, never keys,
 * names, or values.
 *
 *   bun server/vault-admin.ts verify-key
 *     Checks that VAULT_ENCRYPTION_KEY (or VAULT_ENCRYPTION_KEY_FILE) opens every stored vault data
 *     key, binned vaults included. Exit 0 when all open, 1 when any does not, 2 on a usage error.
 *
 *   bun server/vault-admin.ts rotate-kek
 *     Re-wraps every data key from the current key (VAULT_ENCRYPTION_KEY or _FILE) to a new one
 *     (VAULT_ENCRYPTION_KEY_NEW or VAULT_ENCRYPTION_KEY_NEW_FILE), in one transaction; values are not
 *     touched. Stop the server first, run this, put the new key in place of the old one, and start
 *     the server again. The old key opens nothing afterwards: keep it until the new one is verified.
 */

const usage = "Usage: bun server/vault-admin.ts verify-key | rotate-kek";
const command = process.argv[2];

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const current = config.vault.key;
if (command !== "verify-key" && command !== "rotate-kek") fail(usage, 2);
if (!current) fail("VAULT_ENCRYPTION_KEY (or VAULT_ENCRYPTION_KEY_FILE) is not set.", 2);

if (command === "verify-key") {
  const result = verifyKeys(current);
  if (result.failed > 0) fail(`The key does not open ${result.failed} of ${result.keys} vault data keys (${result.vaults} vaults). The vault module stays off with this key.`);
  console.log(`The key opens all ${result.keys} vault data keys (${result.vaults} ${result.vaults === 1 ? "vault" : "vaults"}).`);
  process.exit(0);
}

let next: Buffer | null;
try {
  next = parseVaultKey({ VAULT_ENCRYPTION_KEY: process.env.VAULT_ENCRYPTION_KEY_NEW, VAULT_ENCRYPTION_KEY_FILE: process.env.VAULT_ENCRYPTION_KEY_NEW_FILE }, config.totpEncryptionKey).key;
} catch (error) {
  fail((error instanceof Error ? error.message : "The new key is not valid").replaceAll("VAULT_ENCRYPTION_KEY", "VAULT_ENCRYPTION_KEY_NEW"), 2);
}
if (!next) fail("Set VAULT_ENCRYPTION_KEY_NEW (or VAULT_ENCRYPTION_KEY_NEW_FILE) to the new key: openssl rand -base64 32", 2);
if (next.equals(current)) fail("The new key is the same as the current one.", 2);

const before = verifyKeys(current);
if (before.failed > 0) fail(`The current key does not open ${before.failed} of ${before.keys} vault data keys; nothing was changed.`);
const rotated = rotateKek(current, next);
const after = verifyKeys(next);
if (after.failed > 0) fail(`After re-wrapping, the new key does not open ${after.failed} keys. Restore from the backup taken before this run.`);
for (const { id } of db.query("SELECT id FROM vaults").all() as Array<{ id: string }>) recordVaultEvent(id, null, "kek.rotate", {}, "cli");
audit(null, null, "vault.kek_rotated", { keys: rotated.keys });
console.log(`Re-wrapped ${rotated.keys} vault data keys. Now replace VAULT_ENCRYPTION_KEY with the new key and start the server; then run verify-key.`);
process.exit(0);
