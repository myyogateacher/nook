import { createHash } from "node:crypto";
import { config, parseAgentSecretsKey } from "./config";
import { audit } from "./db";
import { serverHeartbeatAge } from "./serverHeartbeat";
import { rotateSecretsKey, verifySecrets } from "./agents/secrets";

/**
 * Host CLI for the Chat module's key (agent chat plan §4.2, D354, review M3). Run it on the host with
 * the same environment (DATA_DIR and the key variables) as the server. It prints counts and key
 * fingerprints (the first 8 hex digits of the key's SHA-256) only, never keys or provider names.
 *
 *   bun server/agent-admin.ts verify-key
 *     Checks that AGENT_SECRETS_KEY (or AGENT_SECRETS_KEY_FILE) opens every stored provider secret
 *     and prints the key's fingerprint. Exit 0 when all open, 1 when any does not, 2 on a usage error.
 *
 *   bun server/agent-admin.ts rotate-key [--key-saved]
 *     Re-seals every stored provider secret from the current key to a new one, in one transaction.
 *     The new key comes from AGENT_SECRETS_KEY_NEW_FILE, a file the operator generated first (so the
 *     key that now opens every secret is known to be kept somewhere); AGENT_SECRETS_KEY_NEW (inline)
 *     is accepted only with `--key-saved`. Refused while a server is using DATA_DIR (its heartbeat,
 *     `server/serverHeartbeat.ts`, as `vault-admin.ts rotate-kek`): a running server would keep
 *     sealing new keys with the old one. See docs/OPERATIONS.md, Agent chat.
 */

const usage = "Usage: bun server/agent-admin.ts verify-key | rotate-key [--key-saved]";
const [command, ...flags] = process.argv.slice(2);

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const fingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

if (command !== "verify-key" && command !== "rotate-key") fail(usage, 2);
if (flags.some((flag) => command !== "rotate-key" || flag !== "--key-saved")) fail(usage, 2);
const current = config.agents.key;
if (!current) fail("AGENT_SECRETS_KEY (or AGENT_SECRETS_KEY_FILE) is not set.", 2);

if (command === "verify-key") {
  const result = verifySecrets(current);
  console.log(`Key fingerprint: ${fingerprint(current)}`);
  if (result.failed > 0) fail(`The key does not open ${result.failed} of ${result.total} stored provider secrets. The Chat module stays off with this key; restore the key the providers were saved with, or remove and re-enter their API keys in Settings → AI.`);
  console.log(`The key opens all ${result.total} stored provider ${result.total === 1 ? "secret" : "secrets"}.`);
  process.exit(0);
}

let parsed: ReturnType<typeof parseAgentSecretsKey>;
try {
  parsed = parseAgentSecretsKey({ AGENT_SECRETS_KEY: process.env.AGENT_SECRETS_KEY_NEW, AGENT_SECRETS_KEY_FILE: process.env.AGENT_SECRETS_KEY_NEW_FILE }, config.totpEncryptionKey, config.vault.key, config.dataDir);
} catch (error) {
  fail((error instanceof Error ? error.message : "The new key is not valid").replaceAll("AGENT_SECRETS_KEY", "AGENT_SECRETS_KEY_NEW"), 2);
}
const next = parsed.key;
if (!next) fail("Generate the new key into a file outside DATA_DIR first (umask 077; openssl rand -base64 32 > <file>) and set AGENT_SECRETS_KEY_NEW_FILE to its absolute path. See docs/OPERATIONS.md, Agent chat.", 2);
if (parsed.source === "env" && !flags.includes("--key-saved")) {
  fail([
    "Refusing to rotate with a key given inline in AGENT_SECRETS_KEY_NEW: nothing shows that a copy of it was kept, and after the",
    "rotation it is the only key that opens the provider secrets. Put it in a file outside DATA_DIR and set AGENT_SECRETS_KEY_NEW_FILE,",
    "or, if you have saved this exact key somewhere safe, run again with --key-saved."
  ].join("\n"), 2);
}
if (next.equals(current)) fail("The new key is the same as the current one.", 2);

// Never while a server is using this DATA_DIR. `docker compose stop` can leave a fresh heartbeat for
// a few seconds, so wait until it is stale before refusing.
for (let waited = 0; serverHeartbeatAge() !== null; waited += 1) {
  if (waited === 0) console.log("A Nook server heartbeat in DATA_DIR is recent; waiting up to 20 seconds for it to stop...");
  if (waited >= 20) fail("A Nook server is still using this DATA_DIR (its heartbeat file keeps changing). Stop it, then run this again. Nothing was changed.");
  Bun.sleepSync(1000);
}

console.log(`Current key fingerprint: ${fingerprint(current)}`);
console.log(`New key fingerprint:     ${fingerprint(next)}`);
const before = verifySecrets(current);
if (before.failed > 0) fail(`The current key does not open ${before.failed} of ${before.total} stored provider secrets; nothing was changed.`);
const rotated = rotateSecretsKey(current, next);
const after = verifySecrets(next);
if (after.failed > 0) fail(`After re-sealing, the new key does not open ${after.failed} secrets. Restore from the backup taken before this run.`);
audit(null, null, "agents.key_rotated", { providers: rotated.providers, servers: rotated.servers, datasources: rotated.datasources });
const kept = parsed.source === "file" ? "the file named by AGENT_SECRETS_KEY_NEW_FILE" : "the copy you saved (you ran with --key-saved)";
console.log([
  `Re-sealed ${rotated.providers} provider ${rotated.providers === 1 ? "secret" : "secrets"}${rotated.servers ? `, ${rotated.servers} tool-server ${rotated.servers === 1 ? "secret" : "secrets"}` : ""}${rotated.datasources ? `, ${rotated.datasources} report data source ${rotated.datasources === 1 ? "password" : "passwords"}` : ""}. From now on only the new key (fingerprint ${fingerprint(next)}) opens them; it is in ${kept}.`,
  "Next steps:",
  "  1. Replace the configured key with the new one: set AGENT_SECRETS_KEY in .env to the new key's contents, or point",
  "     AGENT_SECRETS_KEY_FILE at the new key file. Do not start the server with the old key: the Chat module stays off.",
  "  2. Start the server.",
  `  3. Run verify-key. It must print "Key fingerprint: ${fingerprint(next)}" and open every stored provider secret.`,
  `  4. Keep the old key (fingerprint ${fingerprint(current)}) until every backup taken before this rotation has rotated out:`,
  "     those archives still need it."
].join("\n"));
process.exit(0);
