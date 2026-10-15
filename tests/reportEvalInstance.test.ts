import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceDirOf, instanceProvider, instanceSecretsKey, readDotEnv } from "../evals/reports/instanceProvider";
import { evalCompat } from "../scripts/reportEval";

function instance(settings: Record<string, unknown>, providers: Array<{ id: string; name: string; base_url: string; default_model: string; is_default?: number; created_at: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "nook-eval-instance-"));
  const db = new Database(join(dir, "mynotes.sqlite"), { create: true });
  db.run("CREATE TABLE agent_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)");
  db.run("CREATE TABLE agent_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, default_model TEXT, api_key_ct TEXT, compat_json TEXT, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT)");
  for (const [key, value] of Object.entries(settings)) db.query("INSERT INTO agent_settings (key, value_json) VALUES (?, ?)").run(key, JSON.stringify(value));
  for (const row of providers) db.query("INSERT INTO agent_providers (id, name, base_url, default_model, api_key_ct, compat_json, is_default, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)").run(row.id, row.name, row.base_url, row.default_model, "v1:x:y:z", row.is_default ?? 0, row.created_at);
  db.close();
  return dir;
}

const openai = { id: "p-openai", name: "openai", base_url: "https://api.openai.com/v1", default_model: "gpt-6-luna", created_at: "2026-10-01" };
const zai = { id: "p-zai", name: "z.ai", base_url: "https://api.z.ai/api/paas/v4", default_model: "glm-5.3", created_at: "2026-10-02" };

describe("report eval falls back to an instance's model provider", () => {
  test("the default provider and its default model", () => {
    const found = instanceProvider(instance({}, [{ ...openai, is_default: 1 }, zai]))!;
    expect([found.providerName, found.model, found.source]).toEqual(["openai", "gpt-6-luna", "default"]);
  });

  test("the default_provider_id setting wins over is_default", () => {
    const found = instanceProvider(instance({ default_provider_id: "p-zai" }, [{ ...openai, is_default: 1 }, zai]))!;
    expect([found.providerName, found.model]).toEqual(["z.ai", "glm-5.3"]);
  });

  test("the report generation model setting wins, as report generation resolves it", () => {
    expect(instanceProvider(instance({ report_provider_id: "p-zai", report_model: "glm-5.3-air" }, [{ ...openai, is_default: 1 }, zai]))!)
      .toMatchObject({ providerName: "z.ai", model: "glm-5.3-air", source: "setting" });
    // A model without a provider names a model of the default provider.
    expect(instanceProvider(instance({ report_model: "gpt-6" }, [{ ...openai, is_default: 1 }]))!).toMatchObject({ providerName: "openai", model: "gpt-6", source: "setting" });
  });

  test("no database or no provider: null (the scripted provider runs)", () => {
    expect(instanceProvider(mkdtempSync(join(tmpdir(), "nook-eval-empty-")))).toBeNull();
    expect(instanceProvider(instance({}, []))).toBeNull();
  });

  test("the directory and key come from the flag, the environment, or the repository's .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "nook-eval-env-"));
    const key = Buffer.alloc(32, 3).toString("base64");
    writeFileSync(join(dir, ".env"), `MYNOTES_DATA_DIR="/srv/a"\nAGENT_SECRETS_KEY=${key}\nOTHER=1\n`);
    const dotEnv = readDotEnv(join(dir, ".env"), ["MYNOTES_DATA_DIR", "AGENT_SECRETS_KEY"]);
    expect(dotEnv).toEqual({ MYNOTES_DATA_DIR: "/srv/a", AGENT_SECRETS_KEY: key });
    expect(instanceDirOf("/srv/flag", { MYNOTES_DATA_DIR: "/srv/env" }, dotEnv)).toBe("/srv/flag");
    expect(instanceDirOf(undefined, { REPORT_EVAL_INSTANCE_DIR: "/srv/eval", MYNOTES_DATA_DIR: "/srv/env" }, dotEnv)).toBe("/srv/eval");
    expect(instanceDirOf(undefined, {}, dotEnv)).toBe("/srv/a");
    expect(instanceSecretsKey({}, dotEnv)?.length).toBe(32);
    expect(instanceSecretsKey({}, {})).toBeNull();
    expect(() => instanceSecretsKey({ AGENT_SECRETS_KEY: "short" }, {})).toThrow();
  });

  test("evalCompat: OpenAI gets max_completion_tokens and the full tool_choice; other hosts auto and max_tokens", () => {
    const defaults = { tokenParam: "max_completion_tokens" as const, streamUsage: true, supportsTools: true, contextTokens: 128_000 };
    expect(evalCompat(defaults, "https://api.openai.com/v1")).toEqual(defaults);
    expect(evalCompat(defaults, "https://api.z.ai/api/paas/v4")).toMatchObject({ tokenParam: "max_tokens", namedToolChoice: false, requiredToolChoice: false });
    expect(evalCompat(defaults, "https://api.z.ai/api/paas/v4", "full", "max_completion_tokens")).toEqual(defaults);
  });
});
