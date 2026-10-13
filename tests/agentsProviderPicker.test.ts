import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { api } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { completionsWith, runMarker, settleAgentRunsAfterEach } from "./support/agentRuns";

const { createApiKey } = await import("../server/apiKeys");
const { deleteProvider } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { setAgentsKeyForTests } = await import("../server/agents/status");
const { config } = await import("../server/config");

/**
 * The agent editor's provider picker: `GET /api/agents/providers` (names and known models for anyone
 * who may create agents, never addresses or keys), `providerId` on create and update, `providerName`
 * on reads at every level, and runs (chat and REST) that reach the agent's own provider, not the default.
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();
const first = startFakeProvider(0, { models: ["alpha-large", "alpha-small", "text-embedding-3-small"] });
const second = startFakeProvider(0, { models: ["beta-1"] });
let admin: Session;
let member: Session;
let viewer: Session;
let guest: Session;
let manager: Session;
let defaultId: string;
let otherId: string;
let before: { defaultProviderId: string | null; flagged: string | null };

const KEY_A = "sk-picker-secret-aaaa-0001";
const KEY_B = "sk-picker-secret-bbbb-0002";

beforeAll(async () => {
  admin = await createUser("Picker admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Picker member");
  manager = await createUser("Picker manager");
  viewer = await createUser("Picker viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
  guest = await createUser("Picker guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  before = { defaultProviderId: readAgentSettings().defaultProviderId, flagged: (db.query("SELECT id FROM agent_providers WHERE is_default = 1").get() as { id: string } | null)?.id ?? null };
  const a = await api(admin, "POST", "/agents/admin/providers", { name: "Alpha (picker)", baseUrl: first.baseUrl, apiKey: KEY_A, defaultModel: "alpha-large", isDefault: true });
  expect(a.status).toBe(201);
  defaultId = a.body.provider.id;
  const b = await api(admin, "POST", "/agents/admin/providers", { name: "Beta (picker)", baseUrl: second.baseUrl, apiKey: KEY_B, defaultModel: "beta-1" });
  expect(b.status).toBe(201);
  otherId = b.body.provider.id;
  const settings = readAgentSettings();
  writeAgentSettings(admin.userId, { defaultProviderId: defaultId }, settings.revision);
});

afterAll(() => {
  for (const id of [otherId, defaultId]) if (id) deleteProvider(admin.userId, id);
  const settings = readAgentSettings();
  writeAgentSettings(admin.userId, { defaultProviderId: before.defaultProviderId }, settings.revision);
  if (before.flagged) {
    db.query("UPDATE agent_providers SET is_default = 0").run();
    db.query("UPDATE agent_providers SET is_default = 1 WHERE id = ?").run(before.flagged);
  }
  first.stop();
  second.stop();
});

describe("GET /api/agents/providers", () => {
  test("lists names, the default, and default models to a member; never addresses, keys, or hints", async () => {
    const listed = await api(member, "GET", "/agents/providers");
    expect(listed.status).toBe(200);
    const mine = listed.body.providers.filter((provider: { id: string }) => provider.id === defaultId || provider.id === otherId);
    expect(mine).toEqual([
      { id: defaultId, name: "Alpha (picker)", isDefault: true, defaultModel: "alpha-large", models: null },
      { id: otherId, name: "Beta (picker)", isDefault: false, defaultModel: "beta-1", models: null }
    ]);
    expect(listed.body.providers[0].id).toBe(defaultId);
    const text = JSON.stringify(listed.body);
    for (const secret of [KEY_A, KEY_B, "0001", "0002", first.baseUrl, second.baseUrl, "127.0.0.1", "baseUrl", "hint", "hasSecret"]) expect(text).not.toContain(secret);
  });

  test("models come from the admin's Test (chat models only); still no URL", async () => {
    expect((await api(admin, "POST", `/agents/admin/providers/${defaultId}/test`, {})).body.test.models.ok).toBe(true);
    const listed = await api(member, "GET", "/agents/providers");
    expect(listed.body.providers.find((provider: { id: string }) => provider.id === defaultId).models).toEqual(["alpha-large", "alpha-small"]);
    expect(JSON.stringify(listed.body)).not.toContain(first.baseUrl);
  });

  test("gates: a viewer (may chat, not create) 403, a guest 404, the module off 503", async () => {
    expect(await api(viewer, "GET", "/agents/providers")).toMatchObject({ status: 403, body: { code: "ROLE_REFUSED" } });
    expect((await api(guest, "GET", "/agents/providers")).status).toBe(404);
    const key = config.agents.key;
    try {
      setAgentsKeyForTests(null);
      expect(await api(member, "GET", "/agents/providers")).toMatchObject({ status: 503, body: { code: "AGENTS_DISABLED" } });
    } finally {
      setAgentsKeyForTests(key);
    }
    expect((await api(member, "GET", "/agents/providers")).status).toBe(200);
  });
});

describe("providerId on agents", () => {
  test("create and update take a provider id or null; an unknown id is 400; reads carry providerName", async () => {
    const created = await api(member, "POST", "/agents", { name: "On beta", providerId: otherId });
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ providerId: otherId, providerName: "Beta (picker)", effectiveModel: "beta-1" });
    const agentId = created.body.agent.id as string;
    expect(await api(member, "POST", "/agents", { name: "Nowhere", providerId: crypto.randomUUID() })).toMatchObject({ status: 400, body: { code: "INVALID", field: "providerId" } });
    expect((await api(member, "POST", "/agents", { name: "Bad", providerId: "not-a-uuid" })).status).toBe(400);
    const back = await api(member, "PATCH", `/agents/${agentId}`, { providerId: null, expectedRevision: created.body.agent.revision });
    expect(back.body.agent).toMatchObject({ providerId: null, providerName: null, effectiveModel: "alpha-large" });
    expect(await api(member, "PATCH", `/agents/${agentId}`, { providerId: crypto.randomUUID(), expectedRevision: back.body.agent.revision })).toMatchObject({ status: 400, body: { field: "providerId" } });
    const again = await api(member, "PATCH", `/agents/${agentId}`, { providerId: otherId, model: "beta-1", expectedRevision: back.body.agent.revision });
    expect(again.body.agent).toMatchObject({ providerId: otherId, providerName: "Beta (picker)", model: "beta-1" });
    const listed = await api(member, "GET", "/agents");
    expect(listed.body.agents.find((agent: { id: string }) => agent.id === agentId)).toMatchObject({ providerId: otherId, providerName: "Beta (picker)" });
  });

  test("a manager changes the provider; a viewer of the agent reads its name, never a URL", async () => {
    const created = await api(member, "POST", "/agents", { name: "Shared picker", providerId: otherId });
    const agentId = created.body.agent.id as string;
    const current = await api(member, "GET", `/agents/${agentId}/access`);
    const shared = await request(`/agents/${agentId}/access`, { method: "PUT", headers: { "If-Match": current.body.etag }, body: JSON.stringify({ audience: "selected", people: [{ id: manager.userId, level: "manage" }, { id: viewer.userId, level: "view" }], groups: [] }) }, member);
    expect(shared.status).toBe(200);
    const seen = await api(viewer, "GET", `/agents/${agentId}`);
    expect(seen.body.agent).toMatchObject({ yourLevel: "view", providerId: otherId, providerName: "Beta (picker)" });
    expect(JSON.stringify(seen.body)).not.toContain(second.baseUrl);
    expect((await api(viewer, "PATCH", `/agents/${agentId}`, { providerId: null, expectedRevision: created.body.agent.revision })).status).toBe(403);
    const changed = await api(manager, "PATCH", `/agents/${agentId}`, { providerId: defaultId, expectedRevision: created.body.agent.revision });
    expect(changed.status).toBe(200);
    expect(changed.body.agent).toMatchObject({ providerId: defaultId, providerName: "Alpha (picker)" });
  });
});

describe("runs use the agent's provider", () => {
  async function chatOnce(agentId: string, marker: string) {
    const chat = await api(member, "POST", "/chats", { agentId });
    expect(chat.status).toBe(201);
    const started = await api(member, "POST", `/chats/${chat.body.chat.id}/messages`, { content: `echo:${marker}` });
    expect(started.status).toBe(201);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const row = db.query("SELECT status FROM agent_runs WHERE id = ?").get(started.body.runId) as { status: string } | null;
      if (row && !["queued", "running"].includes(row.status)) return row.status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("run did not finish");
  }

  test("a chat on the non-default provider reaches its port, with its key and default model; Default reaches the default", async () => {
    const created = await api(member, "POST", "/agents", { name: "Runs on beta", providerId: otherId });
    const agentId = created.body.agent.id as string;
    const marker = runMarker();
    expect(await chatOnce(agentId, marker)).toBe("ok");
    const onSecond = completionsWith(second.calls, marker);
    expect(onSecond.length).toBe(1);
    expect(onSecond[0]!.headers.authorization).toBe(`Bearer ${KEY_B}`);
    expect(onSecond[0]!.body).toMatchObject({ model: "beta-1" });
    expect(completionsWith(first.calls, marker)).toEqual([]);

    const back = await api(member, "PATCH", `/agents/${agentId}`, { providerId: null, expectedRevision: created.body.agent.revision });
    expect(back.status).toBe(200);
    const again = runMarker();
    expect(await chatOnce(agentId, again)).toBe("ok");
    expect(completionsWith(first.calls, again).length).toBe(1);
    expect(completionsWith(first.calls, again)[0]!.body).toMatchObject({ model: "alpha-large" });
    expect(completionsWith(second.calls, again)).toEqual([]);
  });

  test("a REST run uses the agent's provider; GET /api/v1/agents names it", async () => {
    const created = await api(member, "POST", "/agents", { name: "REST on beta", providerId: otherId });
    const agentId = created.body.agent.id as string;
    const key = createApiKey(member.userId, { name: "Picker runner", surfaces: "rest", grants: [{ module: "agents", permission: "run", resourceKind: "agent", resourceId: agentId }], expiresInDays: 1 });
    const headers = { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" };
    const listed = await (await fetch(`${origin}/api/v1/agents`, { headers })).json() as { agents: Array<{ id: string; providerName: string | null }> };
    expect(listed.agents.find((agent) => agent.id === agentId)?.providerName).toBe("Beta (picker)");
    const marker = runMarker();
    const response = await fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers, body: JSON.stringify({ input: `echo:${marker}` }) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
    expect(completionsWith(second.calls, marker).length).toBe(1);
    expect(completionsWith(first.calls, marker)).toEqual([]);
  });

  test("a deleted provider leaves its agents on the default, with no provider name", async () => {
    const extra = await api(admin, "POST", "/agents/admin/providers", { name: "Gamma (picker)", baseUrl: second.baseUrl, defaultModel: "beta-1" });
    expect(extra.status).toBe(201);
    const created = await api(member, "POST", "/agents", { name: "Orphan", providerId: extra.body.provider.id });
    expect((await api(admin, "DELETE", `/agents/admin/providers/${extra.body.provider.id}`, {})).status).toBe(200);
    const read = await api(member, "GET", `/agents/${created.body.agent.id}`);
    expect(read.body.agent).toMatchObject({ providerId: null, providerName: null });
    const marker = runMarker();
    expect(await chatOnce(created.body.agent.id, marker)).toBe("ok");
    expect(completionsWith(first.calls, marker).length).toBe(1);
  });
});
