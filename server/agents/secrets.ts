import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";
import { db } from "../db";

/**
 * Provider API keys and tool-server credentials at rest (plan §4.2, D354, T309): AES-256-GCM under
 * AGENT_SECRETS_KEY, in the `server/totp.ts` envelope format `v1:<nonce>:<tag>:<ct>` (base64url),
 * with the AAD `nook:agent-secret:v1:<provider|server>:<rowId>`, so a ciphertext moved to another
 * row fails to open. Plaintext lives in memory for one request only. The API is write-only: after
 * a save the browser sees `{hasSecret, hint}` and never the value. Nothing here logs, and no error
 * carries key material, plaintext, or ciphertext.
 *
 * This module has its own key, like totp.ts and access/handles.ts, which is why tests/vaultGuard
 * lists it among the modules allowed to call the cipher functions.
 */

const FORMAT = "v1";
const B64URL = /^[A-Za-z0-9_-]*$/;
// `datasource` (analytics reports, Wave 45, D415): a report data source's ClickHouse password.
export type SecretOwner = "provider" | "server" | "datasource";

export const aadFor = (owner: SecretOwner, rowId: string) => `nook:agent-secret:v1:${owner}:${rowId}`;

export class AgentSecretError extends Error {
  constructor() {
    super("A stored agent secret failed its integrity check");
    this.name = "AgentSecretError";
  }
}

function keyOrThrow(): Buffer {
  const key = config.agents.key;
  if (!key) throw new AgentSecretError();
  return key;
}

export function sealSecret(owner: SecretOwner, rowId: string, plaintext: string, key: Buffer = keyOrThrow()): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aadFor(owner, rowId), "utf8"));
  const bytes = Buffer.from(plaintext, "utf8");
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  bytes.fill(0);
  return `${FORMAT}:${nonce.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function openSecret(owner: SecretOwner, rowId: string, envelope: string, key: Buffer = keyOrThrow()): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT || !parts.slice(1).every((part) => B64URL.test(part))) throw new AgentSecretError();
  const nonce = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new AgentSecretError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aadFor(owner, rowId), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AgentSecretError();
  }
}

/**
 * The mask shown after a save (plan §4.2): the first three and last four characters, `sk-…a1B2`,
 * only for secrets of at least 16 characters (review L8: seven of a short key's characters would
 * be most of it); shorter ones show `…`.
 */
/** The hint a read returns (Wave 41 QA L5): null without a secret or when it was too short to hint at (the UI says "Saved"). */
export const shownHint = (ciphertext: string | null, hint: string | null) => ciphertext && hint && hint !== "…" ? hint : null;

export function secretHint(plaintext: string) {
  const text = plaintext.trim();
  if (text.length < 16) return "…";
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

/**
 * Re-seals every stored secret (provider API keys, and tool-server credentials once AC-B stores
 * them) from `oldKey` to `newKey` in one `BEGIN IMMEDIATE` transaction (`server/agent-admin.ts
 * rotate-key`, review M3). Each new envelope is opened once before it is written. Plaintext lives
 * only inside the loop. Counts only.
 */
export function rotateSecretsKey(oldKey: Buffer, newKey: Buffer): { providers: number; servers: number; datasources: number } {
  return db.transaction(() => {
    const providers = db.query("SELECT id, api_key_ct FROM agent_providers WHERE api_key_ct IS NOT NULL").all() as Array<{ id: string; api_key_ct: string }>;
    for (const row of providers) {
      const resealed = sealSecret("provider", row.id, openSecret("provider", row.id, row.api_key_ct, oldKey), newKey);
      openSecret("provider", row.id, resealed, newKey);
      db.query("UPDATE agent_providers SET api_key_ct = ? WHERE id = ?").run(resealed, row.id);
    }
    const servers = db.query("SELECT id, secret_ct FROM agent_tool_servers WHERE secret_ct IS NOT NULL").all() as Array<{ id: string; secret_ct: string }>;
    for (const row of servers) {
      const resealed = sealSecret("server", row.id, openSecret("server", row.id, row.secret_ct, oldKey), newKey);
      openSecret("server", row.id, resealed, newKey);
      db.query("UPDATE agent_tool_servers SET secret_ct = ? WHERE id = ?").run(resealed, row.id);
    }
    // Analytics reports (Wave 45): data source passwords, under the same key.
    const datasources = db.query("SELECT id, password_ct FROM report_datasources WHERE password_ct IS NOT NULL").all() as Array<{ id: string; password_ct: string }>;
    for (const row of datasources) {
      const resealed = sealSecret("datasource", row.id, openSecret("datasource", row.id, row.password_ct, oldKey), newKey);
      openSecret("datasource", row.id, resealed, newKey);
      db.query("UPDATE report_datasources SET password_ct = ? WHERE id = ?").run(resealed, row.id);
    }
    return { providers: providers.length, servers: servers.length, datasources: datasources.length };
  }).immediate();
}

/** Startup check: whether every stored provider and tool-server secret opens under `key`. Counts only. */
export function verifySecrets(key: Buffer): { total: number; failed: number } {
  const rows = [
    ...(db.query("SELECT id, api_key_ct AS ct FROM agent_providers WHERE api_key_ct IS NOT NULL").all() as Array<{ id: string; ct: string }>).map((row) => ({ owner: "provider" as const, ...row })),
    ...(db.query("SELECT id, secret_ct AS ct FROM agent_tool_servers WHERE secret_ct IS NOT NULL").all() as Array<{ id: string; ct: string }>).map((row) => ({ owner: "server" as const, ...row })),
    ...(db.query("SELECT id, password_ct AS ct FROM report_datasources WHERE password_ct IS NOT NULL").all() as Array<{ id: string; ct: string }>).map((row) => ({ owner: "datasource" as const, ...row }))
  ];
  let failed = 0;
  for (const row of rows) {
    try {
      openSecret(row.owner, row.id, row.ct, key);
    } catch {
      failed += 1;
    }
  }
  return { total: rows.length, failed };
}
