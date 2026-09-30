import { db } from "../db";
import { recordAccessEvent } from "../access/events";
import { notifyAccess } from "../access/notices";
import { VaultError, type VaultKeyActor } from "./access";
import { KeyLimitError } from "./limits";
import { recordVaultEvent, type SecretSummary, type VaultSummary } from "./service";

/**
 * What the key surfaces of the vault share (Wave 27): REST `/api/v1/vault/*` (server/vault/rest.ts)
 * and the vault MCP tools (server/vault/mcpTools.ts). Both call the same service functions as the
 * session API with a key actor; this file shapes their answers the same way and records the
 * per-key limit alert.
 */

/** A vault as a key sees it: the environments it can reach (with its level) and the secret count. Never a value. */
export function presentVault(summary: VaultSummary) {
  return {
    id: summary.id, name: summary.name, description: summary.description, secretCount: summary.secretCount, updatedAt: summary.updatedAt,
    environments: summary.environments.map((env) => ({ id: env.id, slug: env.slug, name: env.name, protected: env.protected, level: env.level }))
  };
}

/** A secret's metadata: names, type, tags, and per-environment status and version. Never a value. */
export function presentSecret(secret: SecretSummary) {
  return {
    id: secret.id, name: secret.name, type: secret.type, tags: secret.tags, hasComment: secret.hasComment, revision: secret.revision,
    createdAt: secret.createdAt, updatedAt: secret.updatedAt, updatedBy: secret.updatedBy, values: secret.values
  };
}

/** The details of a vault refusal a key may see: versions, environment ids, and the wait; nothing else. */
export function safeDetails(error: VaultError): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const field of ["currentVersion", "envId", "changed", "retryAfterSeconds", "currentRevision"]) if (field in error.details) kept[field] = error.details[field];
  return kept;
}

const lastAlert = new Map<string, number>();
const ALERT_EVERY_MS = 10 * 60_000;
const NOTICE_EVERY_MS = 24 * 60 * 60_000;

/**
 * A vault key ran into one of its own vault limits (T183, T191, V-O6): `key.vault.limited` in the
 * access log (the key's history and Team → Access activity), `key.limited` in the vault's Activity
 * when the call named a vault, at most once per key per 10 minutes; and a bell notice to the key's
 * creator at most once a day per key. Never the value, the secret, or the address.
 */
export function noteKeyLimited(actor: VaultKeyActor, error: KeyLimitError, vaultId: string | null, nowMs = Date.now()) {
  if (nowMs - (lastAlert.get(actor.keyId) ?? 0) < ALERT_EVERY_MS) return;
  if (lastAlert.size > 5000) lastAlert.clear();
  lastAlert.set(actor.keyId, nowMs);
  const at = new Date(nowMs).toISOString();
  recordAccessEvent({ actorId: null, via: actor.via === "api" ? "rest" : "mcp", action: "key.vault.limited", targetUserId: actor.userId, keyId: actor.keyId, meta: { bucket: error.bucket, surface: actor.via === "api" ? "rest" : "mcp" } }, at);
  if (vaultId && db.query("SELECT 1 FROM vaults WHERE id = ?").get(vaultId)) recordVaultEvent(vaultId, actor, "key.limited");
  const since = new Date(nowMs - NOTICE_EVERY_MS).toISOString();
  if (!db.query("SELECT 1 FROM access_notices WHERE key_id = ? AND kind = 'key_vault_limited' AND created_at >= ?").get(actor.keyId, since)) {
    notifyAccess({ userId: actor.userId, kind: "key_vault_limited", actorId: null, keyId: actor.keyId }, at);
  }
}

/** Test hook: forget the alert throttle. */
export function resetKeyAlertsForTests() {
  lastAlert.clear();
}
