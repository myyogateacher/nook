import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The eval's fallback model (2026-10-16): when REPORT_EVAL_BASE_URL is not set, use the model a
 * Nook instance already has in Settings → AI → Model providers, resolved as report generation does
 * (`server/reports/model.ts`): the "Report generation model" setting, else the default provider and
 * its default model. The instance database is opened read-only and nothing is written to it; the API
 * key is opened in memory with that instance's AGENT_SECRETS_KEY and never written anywhere.
 *
 * The instance directory: --provider-from, else REPORT_EVAL_INSTANCE_DIR, else MYNOTES_DATA_DIR (from
 * the environment or the repository's .env, as `docker compose` reads it). The key: AGENT_SECRETS_KEY
 * or AGENT_SECRETS_KEY_FILE, from the environment or that .env.
 */

export type InstanceProvider = { providerId: string; providerName: string; baseUrl: string; model: string; apiKeyCt: string | null; compatJson: string | null; dataDir: string; source: "setting" | "default" };

/** KEY=value lines of the repository's .env (only the names asked for; quotes stripped). */
export function readDotEnv(path: string, names: string[]): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !names.includes(match[1]!)) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2").trim();
    if (value) out[match[1]!] = value;
  }
  return out;
}

export function instanceDirOf(flag: string | undefined, env: Record<string, string | undefined>, dotEnv: Record<string, string>): string | null {
  const dir = flag ?? env.REPORT_EVAL_INSTANCE_DIR ?? env.MYNOTES_DATA_DIR ?? dotEnv.MYNOTES_DATA_DIR ?? null;
  return dir ? resolve(dir) : null;
}

/** The instance's report model, or null when the directory has no database or no provider. */
export function instanceProvider(dataDir: string): InstanceProvider | null {
  const path = join(dataDir, "mynotes.sqlite");
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const settings = new Map((db.query("SELECT key, value_json FROM agent_settings").all() as Array<{ key: string; value_json: string }>)
      .map((row) => { try { return [row.key, JSON.parse(row.value_json)] as const; } catch { return [row.key, null] as const; } }));
    const text = (key: string) => typeof settings.get(key) === "string" && (settings.get(key) as string).trim() ? (settings.get(key) as string).trim() : null;
    type Row = { id: string; name: string; base_url: string; default_model: string; api_key_ct: string | null; compat_json: string | null };
    const byId = (id: string | null) => id ? db.query("SELECT id, name, base_url, default_model, api_key_ct, compat_json FROM agent_providers WHERE id = ?").get(id) as Row | null : null;
    const reportRow = byId(text("report_provider_id"));
    const reportModel = text("report_model");
    const fallback = byId(text("default_provider_id"))
      ?? db.query("SELECT id, name, base_url, default_model, api_key_ct, compat_json FROM agent_providers WHERE is_default = 1").get() as Row | null
      ?? db.query("SELECT id, name, base_url, default_model, api_key_ct, compat_json FROM agent_providers ORDER BY created_at LIMIT 1").get() as Row | null;
    const row = reportRow ?? fallback;
    if (!row) return null;
    return {
      providerId: row.id, providerName: row.name, baseUrl: row.base_url, model: reportModel ?? row.default_model,
      apiKeyCt: row.api_key_ct, compatJson: row.compat_json, dataDir, source: reportRow || reportModel ? "setting" : "default"
    };
  } finally {
    db.close();
  }
}

/** The instance's AGENT_SECRETS_KEY as bytes, or null when none is set. */
export function instanceSecretsKey(env: Record<string, string | undefined>, dotEnv: Record<string, string>): Buffer | null {
  const file = env.AGENT_SECRETS_KEY_FILE ?? dotEnv.AGENT_SECRETS_KEY_FILE;
  const raw = (env.AGENT_SECRETS_KEY ?? dotEnv.AGENT_SECRETS_KEY ?? (file ? readFileSync(file, "utf8") : "")).trim();
  if (!raw) return null;
  const key = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, "base64") : null;
  if (!key || key.length !== 32) throw new Error("AGENT_SECRETS_KEY must be a base64-encoded 32-byte key");
  return key;
}
