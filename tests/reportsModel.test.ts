import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startScriptedProvider, type Script } from "../scripts/fakeReportProvider";

const { reportModelFor, resolveReportModel } = await import("../server/reports/model");
const { generateDeps } = await import("../server/reports/generate");
const { parseCompat } = await import("../server/agents/providers");

/**
 * Wave 48b, the report generation model (D435) and "Test tool calling" (D436): one resolver for every
 * report agent run (the report's override, the admin's setting, chat's default), owner-only overrides,
 * chat untouched; the probe against the scripted provider in its normal mode and in modes that reject
 * `tool_choice: "required"` or a named choice, its answer stored in the provider's compat flags.
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const fake = startFakeClickhouse(0);
const normal = startScriptedProvider(0);
const noRequired = startScriptedProvider(0, undefined, { rejectRequired: true });
const noNamed = startScriptedProvider(0, undefined, { rejectNamed: true });
const neither = startScriptedProvider(0, undefined, { rejectRequired: true, rejectNamed: true });
const probeScript: Script = (context) => context.tools.includes("nook_probe") ? { toolCalls: [{ name: "nook_probe", arguments: { ok: true } }] } : { content: "ok" };
for (const provider of [normal, noRequired, noNamed, neither]) provider.setScript(probeScript);

let admin: Session;
let owner: Session;
let other: Session;
const providers: Record<string, string> = {};
let reportId = "";
let originalSettings: Json;

async function addProvider(name: string, baseUrl: string, model: string) {
  const created = await send(admin, "POST", "/agents/admin/providers", { name: `${name} ${crypto.randomUUID().slice(0, 6)}`, baseUrl, apiKey: "sk-test-not-real", defaultModel: model });
  expect(created.status).toBe(201);
  return created.body.provider.id as string;
}

beforeAll(async () => {
  admin = await createUser("Model admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Model owner");
  other = await createUser("Model other");
  originalSettings = (await send(admin, "GET", "/agents/admin/settings")).body.settings;
  providers.normal = await addProvider("Scripted", normal.baseUrl, "chat-model");
  providers.noRequired = await addProvider("No required", noRequired.baseUrl, "glm-5.3");
  providers.noNamed = await addProvider("No named", noNamed.baseUrl, "named-less");
  providers.neither = await addProvider("Neither", neither.baseUrl, "auto-only");
  const datasource = await send(admin, "POST", "/reports/admin/datasources", { name: `Model DS ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", password: "pw", database: "analytics", allowlist: ["analytics"] });
  expect(datasource.status).toBe(201);
  const report = await send(owner, "POST", "/reports", { title: "Model test", datasourceId: datasource.body.datasource.id });
  expect(report.status).toBe(201);
  reportId = report.body.report.id;
});
afterAll(() => {
  // Straight to the database: the people may already be retired, and later files must find the instance as it was.
  db.query("DELETE FROM agent_settings WHERE key IN ('report_provider_id', 'report_model')").run();
  if (originalSettings?.defaultProviderId) db.query("UPDATE agent_settings SET value_json = ? WHERE key = 'default_provider_id'").run(JSON.stringify(originalSettings.defaultProviderId));
  else db.query("DELETE FROM agent_settings WHERE key = 'default_provider_id'").run();
  for (const id of Object.values(providers)) db.query("DELETE FROM agent_providers WHERE id = ?").run(id);
  for (const provider of [normal, noRequired, noNamed, neither]) provider.stop();
  fake.stop();
});

async function setSettings(patch: Json) {
  const current = (await send(admin, "GET", "/agents/admin/settings")).body.settings;
  const saved = await send(admin, "PUT", "/agents/admin/settings", { ...patch, expectedRevision: current.revision });
  expect(saved.status).toBe(200);
  return saved.body.settings;
}

describe("the report generation model", () => {
  test("resolves the report's override, then the admin setting, then chat's default; chat keeps its own", async () => {
    await setSettings({ defaultProviderId: providers.normal, reportProviderId: null, reportModel: null });
    expect(resolveReportModel(reportId)).toMatchObject({ source: "default", providerId: providers.normal, model: "chat-model" });
    expect(reportModelFor(reportId)).toMatchObject({ id: providers.normal, model: "chat-model" });

    // The admin setting: Z.ai's GLM-5.3 (here the scripted provider that lacks `required`).
    const settings = await setSettings({ reportProviderId: providers.noRequired, reportModel: "glm-5.3" });
    expect(settings).toMatchObject({ reportProviderId: providers.noRequired, reportModel: "glm-5.3", defaultProviderId: providers.normal });
    expect(resolveReportModel(reportId)).toMatchObject({ source: "setting", providerId: providers.noRequired, model: "glm-5.3" });
    expect(reportModelFor(null)).toMatchObject({ id: providers.noRequired, model: "glm-5.3", apiKey: "sk-test-not-real" });
    // Generation resolves through the same function.
    expect(generateDeps.connection(reportId)).toMatchObject({ id: providers.noRequired, model: "glm-5.3" });

    // The owner's override, read by the owner; another person cannot see or change it.
    const view = await send(owner, "GET", `/reports/${reportId}/model`);
    expect(view.body.model).toMatchObject({ override: null, canEdit: true, effective: { source: "setting", model: "glm-5.3" } });
    expect(view.body.model.providers.some((provider: Json) => provider.id === providers.noNamed && !("baseUrl" in provider) && !("hint" in provider))).toBe(true);
    expect((await send(other, "GET", `/reports/${reportId}/model`)).status).toBe(404);
    expect((await send(other, "PUT", `/reports/${reportId}/model`, { override: { providerId: providers.noNamed, model: null } })).status).toBe(404);
    const set = await send(owner, "PUT", `/reports/${reportId}/model`, { override: { providerId: providers.noNamed, model: null } });
    expect(set.status).toBe(200);
    expect(set.body.model.effective).toMatchObject({ source: "report", providerId: providers.noNamed, model: "named-less" });
    expect(reportModelFor(reportId)).toMatchObject({ id: providers.noNamed, model: "named-less" });
    // Other reports still use the setting.
    expect(reportModelFor(null)).toMatchObject({ id: providers.noRequired });

    // A model alone names a model of the next level's provider.
    await send(owner, "PUT", `/reports/${reportId}/model`, { override: { providerId: null, model: "glm-5.3-air" } });
    expect(resolveReportModel(reportId)).toMatchObject({ source: "report", providerId: providers.noRequired, model: "glm-5.3-air" });

    // Refusals: a provider that does not exist, a model that is not one line, extra fields.
    expect((await send(owner, "PUT", `/reports/${reportId}/model`, { override: { providerId: crypto.randomUUID(), model: null } })).status).toBe(400);
    expect((await send(owner, "PUT", `/reports/${reportId}/model`, { override: { providerId: null, model: "a\nb" } })).status).toBe(400);
    expect((await send(owner, "PUT", `/reports/${reportId}/model`, { override: null, color: "#fff" })).status).toBe(400);

    // A removed provider reads as no override; clearing goes back to the setting.
    await send(owner, "PUT", `/reports/${reportId}/model`, { override: { providerId: providers.noNamed, model: null } });
    db.query("UPDATE reports SET model_provider_id = ? WHERE id = ?").run(crypto.randomUUID(), reportId);
    expect(resolveReportModel(reportId).source).toBe("setting");
    expect((await send(owner, "PUT", `/reports/${reportId}/model`, { override: null })).body.model.override).toBeNull();
    expect(db.query("SELECT event_type FROM audit_log WHERE event_type = 'reports.model.set' AND actor_id = ? LIMIT 1").get(owner.userId)).toEqual({ event_type: "reports.model.set" });

    // Settings refuse a provider that does not exist.
    const current = (await send(admin, "GET", "/agents/admin/settings")).body.settings;
    expect((await send(admin, "PUT", "/agents/admin/settings", { reportProviderId: crypto.randomUUID(), expectedRevision: current.revision })).status).toBe(404);
    expect((await send(owner, "PUT", "/agents/admin/settings", { reportProviderId: null, expectedRevision: current.revision })).status).toBe(404);
  });
});

describe("Test tool calling", () => {
  const compatOf = (id: string) => parseCompat((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(id) as { compat_json: string }).compat_json);

  test("a provider that takes both keeps both; the probe sends each choice as asked, with a decoy tool", async () => {
    normal.calls.length = 0;
    const probed = await send(admin, "POST", `/agents/admin/providers/${providers.normal}/test-tools`);
    expect(probed.status).toBe(200);
    expect(probed.body.probe).toMatchObject({ required: { ok: true }, named: { ok: true }, compat: { requiredToolChoice: true, namedToolChoice: true }, model: "chat-model" });
    expect(normal.calls.map((body) => body.tool_choice)).toEqual(["required", { type: "function", function: { name: "nook_probe" } }]);
    expect(normal.calls[0]!.tools!.map((tool) => tool.function.name)).toEqual(["nook_probe", "nook_other"]);
    expect(compatOf(providers.normal)).not.toHaveProperty("requiredToolChoice");
    expect(compatOf(providers.normal)).not.toHaveProperty("namedToolChoice");
    expect(probed.body.provider.compat).toMatchObject({ supportsTools: true });
  });

  test("400s for required or a named choice are stored as false, never retried with auto", async () => {
    noRequired.calls.length = 0;
    const required = await send(admin, "POST", `/agents/admin/providers/${providers.noRequired}/test-tools`);
    expect(required.body.probe).toMatchObject({ required: { ok: false, status: 400 }, named: { ok: true }, compat: { requiredToolChoice: false, namedToolChoice: true } });
    expect(noRequired.calls.map((body) => body.tool_choice)).toEqual(["required", { type: "function", function: { name: "nook_probe" } }]);
    expect(compatOf(providers.noRequired)).toMatchObject({ requiredToolChoice: false });
    expect(compatOf(providers.noRequired)).not.toHaveProperty("namedToolChoice");

    const named = await send(admin, "POST", `/agents/admin/providers/${providers.noNamed}/test-tools`);
    expect(named.body.probe.compat).toEqual({ requiredToolChoice: true, namedToolChoice: false });
    expect(compatOf(providers.noNamed)).toMatchObject({ namedToolChoice: false });

    const both = await send(admin, "POST", `/agents/admin/providers/${providers.neither}/test-tools`);
    expect(both.body.probe.compat).toEqual({ requiredToolChoice: false, namedToolChoice: false });
    expect(both.body.provider.compat).toMatchObject({ requiredToolChoice: false, namedToolChoice: false });
    // A later probe that succeeds clears a stored false; the key never appears in the answer.
    expect(JSON.stringify(both.body)).not.toContain("sk-test-not-real");
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'agents.provider.probe_tools' AND actor_id = ?").get(admin.userId)).toMatchObject({ n: 4 });
  });

  test("a provider that answers without calling the tool is not trusted with the choice", async () => {
    normal.setScript(() => ({ content: "I would rather not." }));
    try {
      const probed = await send(admin, "POST", `/agents/admin/providers/${providers.normal}/test-tools`);
      expect(probed.body.probe).toMatchObject({ required: { ok: false, error: "The provider answered without calling the tool" }, compat: { requiredToolChoice: false, namedToolChoice: false } });
    } finally {
      normal.setScript(probeScript);
    }
    await send(admin, "POST", `/agents/admin/providers/${providers.normal}/test-tools`);
    expect(compatOf(providers.normal)).not.toHaveProperty("requiredToolChoice");
  });

  test("admins only (others get 404, like every admin route)", async () => {
    expect((await send(owner, "POST", `/agents/admin/providers/${providers.normal}/test-tools`)).status).toBe(404);
  });
});

describe("migration 053 (report_model)", () => {
  test("agent_settings gains the two keys with its rows kept; reports gains model_provider_id and model; re-running changes nothing", async () => {
    const { Database } = await import("bun:sqlite");
    const { runMigrations, registeredMigrationIds } = await import("../server/migrations");
    const { addReportSettingKeys, reportModelMigration } = await import("../server/migrations/053_report_model");
    expect(reportModelMigration).toMatchObject({ id: 53, name: "report_model" });
    expect(registeredMigrationIds.indexOf(53)).toBe(registeredMigrationIds.indexOf(51) + 1);
    // The 039 shape with a stored row.
    const old = new Database(":memory:", { strict: true });
    old.exec(`CREATE TABLE agent_settings (key TEXT PRIMARY KEY CHECK (key IN ('enabled','default_provider_id','kbs_per_user')), value_json TEXT NOT NULL CHECK (json_valid(value_json)), revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT NOT NULL) STRICT`);
    old.query("INSERT INTO agent_settings (key, value_json, revision, updated_at) VALUES ('kbs_per_user', '7', 3, 'now')").run();
    expect(() => old.query("INSERT INTO agent_settings (key, value_json, updated_at) VALUES ('report_model', '\"m\"', 'now')").run()).toThrow();
    addReportSettingKeys(old);
    expect(old.query("SELECT key, value_json, revision FROM agent_settings").all()).toEqual([{ key: "kbs_per_user", value_json: "7", revision: 3 }]);
    old.query("INSERT INTO agent_settings (key, value_json, updated_at) VALUES ('report_model', '\"m\"', 'now')").run();
    expect(() => old.query("INSERT INTO agent_settings (key, value_json, updated_at) VALUES ('report_colour', '1', 'now')").run()).toThrow();
    const sql = () => (old.query("SELECT sql FROM sqlite_master WHERE name = 'agent_settings'").get() as { sql: string }).sql;
    const before = sql();
    addReportSettingKeys(old);
    expect(sql()).toBe(before);
    expect(before).toContain("STRICT");
    // A fresh database: every migration, then the new columns and keys.
    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON");
    runMigrations(fresh);
    const columns = (fresh.query("PRAGMA table_info(reports)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("model_provider_id");
    expect(columns).toContain("model");
    fresh.query("INSERT INTO agent_settings (key, value_json, updated_at) VALUES ('report_provider_id', 'null', 'now')").run();
  });
});
