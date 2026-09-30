import { audit, db, now } from "../db";
import { requireEnvGrant, requireVault, VaultError, type VaultActor } from "./access";
import { openValue } from "./crypto";
import { chargeVault } from "./limits";
import {
  checkValueForType, enforceQuota, integrity, recordVaultEvent, storedValue, writeValueLocked
} from "./service";
import { hasControlChars, VAULT_BOUNDS, type SecretType } from "../../shared/vault";
import { serializeCsv, serializeDotenv, serializeJson, type ExportEntry, type TransferFormat } from "../../shared/vaultTransfer";

/**
 * Import and export of one environment (vault plan §6.4, D226, T186, T188, T195; Wave 26).
 *
 * Import: the client parses the file (shared/vaultTransfer.ts) and sends at most 500 entries; the
 * server re-validates each one. `dryRun` answers what would happen per name (create, set, update,
 * same, skip, invalid) without writing; the preview compares with the current values, so it is a
 * read (charged and recorded as `import.preview` with a count). The import writes in one
 * transaction under the byte quota, records `import` with counts, and skips or overwrites changed
 * values by `mode`. It needs write on the environment, and the re-authentication window when the
 * environment is protected (the grant says so).
 *
 * Export: `.env`, JSON, or CSV of every live secret with a value in that environment, decrypted on
 * the server and sent as an attachment (`no-store`, CSP `sandbox`, `nosniff`). It needs read on the
 * environment (and the window when protected), counts 10 an hour, and is audited: `export` in
 * `vault_events` and `vault.export` in the audit log, with counts and never names or values.
 */

export type ImportMode = "skip" | "overwrite";
export type ImportStatus = "create" | "set" | "update" | "same" | "skip" | "invalid";
type Entry = { name: string; value: string; comment?: string | null };

type SecretLite = { id: string; name: string; type: SecretType };

const lineOk = (name: string) => name.trim() === name && name.length >= 1 && name.length <= VAULT_BOUNDS.secretName && !hasControlChars(name);
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** Why an entry cannot be imported, or null. Never quotes the value (T188). */
function entryProblem(entry: Entry, secret: SecretLite | undefined): string | null {
  if (!lineOk(entry.name)) return "The name must be one line of 1 to 128 characters without leading or trailing spaces";
  if (entry.value.includes("\u0000") || (entry.comment ?? "").includes("\u0000")) return "NUL characters are not allowed";
  if (bytes(entry.value) > VAULT_BOUNDS.valueBytes) return "The value is larger than 64 KiB";
  if (entry.comment && bytes(entry.comment) > VAULT_BOUNDS.commentBytes) return "The comment is larger than 2 KiB";
  if (secret) {
    try {
      checkValueForType(secret.type, entry.value);
    } catch {
      return "A login needs its username, password, and URL as JSON";
    }
  }
  return null;
}

export function importEntries(actor: VaultActor, vaultId: string, envId: string, input: { entries: Entry[]; mode: ImportMode; dryRun: boolean }) {
  const access = requireVault(actor, vaultId);
  const grant = requireEnvGrant(access, envId, "write");
  if (input.entries.length > VAULT_BOUNDS.importEntries) throw new VaultError(400, "INVALID", `An import has at most ${VAULT_BOUNDS.importEntries} entries`);
  const secrets = db.query("SELECT id, name, type FROM vault_secrets WHERE vault_id = ? AND deleted_at IS NULL AND purge_started_at IS NULL").all(vaultId) as SecretLite[];
  const byName = new Map(secrets.map((secret) => [secret.name.toLowerCase(), secret]));
  const seen = new Set<string>();
  // Plan each entry. Comparing with the current value opens it, so it counts as a read.
  let compared = 0;
  const plan = input.entries.map((entry) => {
    const key = entry.name.toLowerCase();
    const secret = byName.get(key);
    if (seen.has(key)) return { entry, secret, status: "invalid" as ImportStatus, reason: "This name appears more than once" };
    seen.add(key);
    const problem = entryProblem(entry, secret);
    if (problem) return { entry, secret, status: "invalid" as ImportStatus, reason: problem };
    if (!secret) return { entry, secret, status: "create" as ImportStatus, reason: null };
    const row = storedValue(secret.id, envId);
    if (!row) return { entry, secret, status: "set" as ImportStatus, reason: null };
    compared += 1;
    const current = integrity(vaultId, actor.userId, { secretId: secret.id, envId }, () => openValue(grant, { secretId: secret.id, envId, version: row.version, generation: row.generation, valueCt: row.value_ct, commentCt: row.comment_ct }));
    const same = current.value === entry.value && (entry.comment === undefined || (current.comment ?? "") === (entry.comment ?? ""));
    if (same) return { entry, secret, status: "same" as ImportStatus, reason: null };
    return { entry, secret, status: input.mode === "overwrite" ? "update" as ImportStatus : "skip" as ImportStatus, reason: input.mode === "overwrite" ? null : "Already set to another value (choose Overwrite to replace it)" };
  });
  const creating = plan.filter((item) => item.status === "create").length;
  const stored = (db.query("SELECT COUNT(*) AS count FROM vault_secrets WHERE vault_id = ?").get(vaultId) as { count: number }).count;
  if (stored + creating > VAULT_BOUNDS.secretsPerVault) throw new VaultError(409, "LIMIT_REACHED", `A vault holds at most ${VAULT_BOUNDS.secretsPerVault} secrets, counting those in the Bin`);
  const counts = { create: 0, set: 0, update: 0, same: 0, skip: 0, invalid: 0 };
  for (const item of plan) counts[item.status] += 1;
  const preview = { mode: input.mode, counts, entries: plan.map((item) => ({ name: item.entry.name, status: item.status, reason: item.reason })) };
  if (compared > 0) chargeVault("read", actor.userId, compared);
  if (input.dryRun) {
    recordVaultEvent(vaultId, actor.userId, "import.preview", { envId, count: input.entries.length });
    return { ...preview, dryRun: true };
  }
  const writes = plan.filter((item) => item.status === "create" || item.status === "set" || item.status === "update");
  chargeVault("write", actor.userId, Math.max(1, writes.length));
  db.transaction(() => enforceQuota(vaultId, () => {
    const timestamp = now();
    for (const item of writes) {
      let secretId = item.secret?.id;
      if (!secretId) {
        secretId = crypto.randomUUID();
        db.query(`INSERT INTO vault_secrets (id, vault_id, name, type, comment_ct, comment_generation, tags, revision, created_by, created_at, updated_by, updated_at)
          VALUES (?, ?, ?, 'value', NULL, NULL, '[]', 1, ?, ?, ?, ?)`).run(secretId, vaultId, item.entry.name, actor.userId, timestamp, actor.userId, timestamp);
      }
      const current = storedValue(secretId, envId);
      const lastVersion = current ? current.version : (db.query("SELECT MAX(version) AS version FROM vault_value_versions WHERE secret_id = ? AND env_id = ?").get(secretId, envId) as { version: number | null }).version ?? 0;
      // An existing value keeps its comment unless the file brought one (JSON and CSV can; .env cannot).
      const keepComment = item.entry.comment === undefined && current?.comment_ct ? integrity(vaultId, actor.userId, { secretId, envId }, () => openValue(grant, { secretId: secretId!, envId, version: current.version, generation: current.generation, valueCt: current.value_ct, commentCt: current.comment_ct }).comment) : null;
      writeValueLocked(access, grant, secretId, envId, item.entry.value, item.entry.comment ?? keepComment ?? null, lastVersion);
    }
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(timestamp, vaultId);
    recordVaultEvent(vaultId, actor.userId, "import", { envId, count: writes.length });
    audit(actor.userId, null, "vault.import", { vaultId, envId, created: counts.create, set: counts.set, updated: counts.update, same: counts.same, skipped: counts.skip, invalid: counts.invalid });
  }))();
  return { ...preview, dryRun: false };
}

// ---------------------------------------------------------------------------------------------
// Export

const CONTENT_TYPES: Record<TransferFormat, string> = { dotenv: "text/plain; charset=utf-8", json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8" };
const EXTENSIONS: Record<TransferFormat, string> = { dotenv: "env", json: "json", csv: "csv" };

/** An ASCII file name from the vault's name and the environment's short name. */
function fileName(vaultName: string, slug: string, format: TransferFormat) {
  const base = vaultName.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "vault";
  return `${base}-${slug}.${EXTENSIONS[format]}`;
}

export function exportEnvironment(actor: VaultActor, vaultId: string, envId: string, format: TransferFormat, comments: boolean) {
  const access = requireVault(actor, vaultId);
  const grant = requireEnvGrant(access, envId, "read");
  const env = access.environments.find((item) => item.id === envId)!;
  const rows = db.query(`SELECT s.id, s.name, s.type, v.value_ct, v.comment_ct, v.generation, v.version FROM vault_secrets s JOIN vault_values v ON v.secret_id = s.id AND v.env_id = ?
    WHERE s.vault_id = ? AND s.deleted_at IS NULL AND s.purge_started_at IS NULL ORDER BY s.name COLLATE NOCASE, s.id`).all(envId, vaultId) as Array<{ id: string; name: string; type: SecretType; value_ct: string; comment_ct: string | null; generation: number; version: number }>;
  chargeVault("export", actor.userId);
  chargeVault("read", actor.userId, Math.max(1, rows.length));
  const entries: ExportEntry[] = rows.map((row) => {
    const opened = integrity(vaultId, actor.userId, { secretId: row.id, envId }, () => openValue(grant, { secretId: row.id, envId, version: row.version, generation: row.generation, valueCt: row.value_ct, commentCt: row.comment_ct }));
    return { name: row.name, value: opened.value, comment: opened.comment, type: row.type };
  });
  let body: string;
  let skipped: string[] = [];
  if (format === "dotenv") {
    const result = serializeDotenv(entries, { comments, header: `${access.vault.name} · ${env.name} (${env.slug}). Plaintext secrets: keep this file private and delete it when done.` });
    body = result.text;
    skipped = result.skipped;
  } else if (format === "json") body = serializeJson(entries, { comments, vault: access.vault.name, environment: env.slug });
  else body = serializeCsv(entries, { comments });
  recordVaultEvent(vaultId, actor.userId, "export", { envId, count: entries.length - skipped.length });
  audit(actor.userId, null, "vault.export", { vaultId, envId, format, count: entries.length - skipped.length, skipped: skipped.length, comments });
  return { body, contentType: CONTENT_TYPES[format], fileName: fileName(access.vault.name, env.slug, format), count: entries.length - skipped.length, skipped: skipped.length };
}

