import { createHash } from "node:crypto";
import { config, parseVaultKey } from "./config";
import { audit, db } from "./db";
import { serverHeartbeatAge } from "./serverHeartbeat";
import { rotateKek, verifyKeys } from "./vault/crypto";
import { recordVaultEvent } from "./vault/service";

/**
 * Host CLI for the Vault's key (vault plan §3.3, §8, T199). Run it on the host, with the same
 * environment (DATA_DIR and the key variables) as the server. It prints counts and key fingerprints
 * (the first 8 hex digits of the key's SHA-256) only, never keys, names, or values.
 *
 *   bun server/vault-admin.ts verify-key
 *     Checks that VAULT_ENCRYPTION_KEY (or VAULT_ENCRYPTION_KEY_FILE) opens every stored vault data
 *     key, binned vaults included, and prints the key's fingerprint. Exit 0 when all open, 1 when any
 *     does not, 2 on a usage error.
 *
 *   bun server/vault-admin.ts rotate-kek [--key-saved]
 *     Re-wraps every data key from the current key (VAULT_ENCRYPTION_KEY or _FILE) to a new one, in
 *     one transaction; values are not touched. The new key comes from VAULT_ENCRYPTION_KEY_NEW_FILE,
 *     a file the operator generated first, so the key that now opens every vault is known to be kept
 *     somewhere (review H1). VAULT_ENCRYPTION_KEY_NEW (inline) is accepted only with `--key-saved`,
 *     the operator's statement that they saved that key. Refused while a server is using DATA_DIR
 *     (its heartbeat, `server/serverHeartbeat.ts`): a running server would keep wrapping new data
 *     keys with the old key. Prints the next steps; see docs/OPERATIONS.md, Vault.
 */

const usage = "Usage: bun server/vault-admin.ts verify-key | rotate-kek [--key-saved]";
const [command, ...flags] = process.argv.slice(2);

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const fingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

if (command !== "verify-key" && command !== "rotate-kek") fail(usage, 2);
if (flags.some((flag) => command !== "rotate-kek" || flag !== "--key-saved")) fail(usage, 2);
const current = config.vault.key;
if (!current) fail("VAULT_ENCRYPTION_KEY (or VAULT_ENCRYPTION_KEY_FILE) is not set.", 2);

if (command === "verify-key") {
  const result = verifyKeys(current);
  console.log(`Key fingerprint: ${fingerprint(current)}`);
  if (result.failed > 0) fail(`The key does not open ${result.failed} of ${result.keys} vault data keys (${result.vaults} vaults). The vault module stays off with this key.`);
  console.log(`The key opens all ${result.keys} vault data keys (${result.vaults} ${result.vaults === 1 ? "vault" : "vaults"}).`);
  process.exit(0);
}

let parsed: ReturnType<typeof parseVaultKey>;
try {
  parsed = parseVaultKey({ VAULT_ENCRYPTION_KEY: process.env.VAULT_ENCRYPTION_KEY_NEW, VAULT_ENCRYPTION_KEY_FILE: process.env.VAULT_ENCRYPTION_KEY_NEW_FILE }, config.totpEncryptionKey, config.dataDir);
} catch (error) {
  fail((error instanceof Error ? error.message : "The new key is not valid").replaceAll("VAULT_ENCRYPTION_KEY", "VAULT_ENCRYPTION_KEY_NEW"), 2);
}
const next = parsed.key;
if (!next) fail("Generate the new key into a file outside DATA_DIR first (umask 077; openssl rand -base64 32 > <file>) and set VAULT_ENCRYPTION_KEY_NEW_FILE to its absolute path. See docs/OPERATIONS.md, Vault.", 2);
if (parsed.source === "env" && !flags.includes("--key-saved")) {
  fail([
    "Refusing to rotate with a key given inline in VAULT_ENCRYPTION_KEY_NEW: nothing shows that a copy of it was kept, and after the",
    "rotation it is the only key that opens the vaults. Put it in a file outside DATA_DIR and set VAULT_ENCRYPTION_KEY_NEW_FILE,",
    "or, if you have saved this exact key somewhere safe, run again with --key-saved."
  ].join("\n"), 2);
}
if (next.equals(current)) fail("The new key is the same as the current one.", 2);

// L3: never while a server is using this DATA_DIR. `docker compose stop` can leave a fresh heartbeat
// for a few seconds, so wait until it is stale before refusing.
for (let waited = 0; serverHeartbeatAge() !== null; waited += 1) {
  if (waited === 0) console.log("A Nook server heartbeat in DATA_DIR is recent; waiting up to 20 seconds for it to stop...");
  if (waited >= 20) fail("A Nook server is still using this DATA_DIR (its heartbeat file keeps changing). Stop it, then run this again. Nothing was changed.");
  Bun.sleepSync(1000);
}

console.log(`Current key fingerprint: ${fingerprint(current)}`);
console.log(`New key fingerprint:     ${fingerprint(next)}`);
const before = verifyKeys(current);
if (before.failed > 0) fail(`The current key does not open ${before.failed} of ${before.keys} vault data keys; nothing was changed.`);
const rotated = rotateKek(current, next);
const after = verifyKeys(next);
if (after.failed > 0) fail(`After re-wrapping, the new key does not open ${after.failed} keys. Restore from the backup taken before this run.`);
for (const { id } of db.query("SELECT id FROM vaults").all() as Array<{ id: string }>) recordVaultEvent(id, null, "kek.rotate", {}, "cli");
audit(null, null, "vault.kek_rotated", { keys: rotated.keys });
const kept = parsed.source === "file" ? "the file named by VAULT_ENCRYPTION_KEY_NEW_FILE" : "the copy you saved (you ran with --key-saved)";
console.log([
  `Re-wrapped ${rotated.keys} vault data keys. From now on only the new key (fingerprint ${fingerprint(next)}) opens the vaults; it is in ${kept}.`,
  "Next steps:",
  "  1. Replace the configured key with the new one: set VAULT_ENCRYPTION_KEY in .env to the new key's contents, or point",
  "     VAULT_ENCRYPTION_KEY_FILE at the new key file. Do not start the server with the old key: the vault module stays off.",
  "  2. Start the server.",
  `  3. Run verify-key. It must print "Key fingerprint: ${fingerprint(next)}" and open every vault data key.`,
  `  4. Keep the old key (fingerprint ${fingerprint(current)}) until every backup taken before this rotation has rotated out:`,
  "     those archives still need it."
].join("\n"));
process.exit(0);
