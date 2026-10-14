import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startScriptedProvider, type Script } from "../scripts/fakeReportProvider";

const { parseCompat, connectionFor } = await import("../server/agents/providers");
const { completeStreaming } = await import("../server/agents/loop");

/**
 * Provider compat `reasoningEffort` (2026-10-14): some newer OpenAI models refuse function tools at
 * their default reasoning in Chat Completions. omit (the default) sends nothing; Test tool calling
 * detects the refusal and saves none (then minimal, then low); a live request retries once with none
 * and the provider learns it; the provider form sets and clears it (admins only, an enum).
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const normal = startScriptedProvider(0);
const effortNone = startScriptedProvider(0, undefined, { toolsNeedEffort: ["none", "minimal"] });
const effortMinimal = startScriptedProvider(0, undefined, { toolsNeedEffort: ["minimal"] });
const effortLive = startScriptedProvider(0, undefined, { toolsNeedEffort: ["none"] });
const all = [normal, effortNone, effortMinimal, effortLive];
const probeScript: Script = (context) => context.tools.includes("nook_probe") ? { toolCalls: [{ name: "nook_probe", arguments: { ok: true } }] } : { content: "ok" };
for (const provider of all) provider.setScript(probeScript);

let admin: Session;
let member: Session;
const providers: Record<string, string> = {};
const compatOf = (id: string) => parseCompat((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(id) as { compat_json: string }).compat_json);
const effortsSent = (provider: typeof normal) => provider.calls.map((body) => (body as Json).reasoning_effort ?? null);

beforeAll(async () => {
  admin = await createUser("Effort admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Effort member");
  for (const [key, provider] of Object.entries({ normal, effortNone, effortMinimal, effortLive })) {
    const created = await send(admin, "POST", "/agents/admin/providers", { name: `${key} ${crypto.randomUUID().slice(0, 6)}`, baseUrl: provider.baseUrl, apiKey: "sk-test-not-real", defaultModel: "gpt-reasoner" });
    expect(created.status).toBe(201);
    providers[key] = created.body.provider.id;
  }
});
afterAll(() => {
  for (const id of Object.values(providers)) db.query("DELETE FROM agent_providers WHERE id = ?").run(id);
  for (const provider of all) provider.stop();
});

describe("reasoning effort", () => {
  test("omit (the default) sends no reasoning_effort field", async () => {
    normal.calls.length = 0;
    await send(admin, "POST", `/agents/admin/providers/${providers.normal}/test-tools`);
    expect(normal.calls.length).toBe(2);
    for (const body of normal.calls) expect(body).not.toHaveProperty("reasoning_effort");
    expect(compatOf(providers.normal!)).not.toHaveProperty("reasoningEffort");
  });

  test("Test tool calling detects the refusal, retries with none, saves it, and says so", async () => {
    const probed = await send(admin, "POST", `/agents/admin/providers/${providers.effortNone}/test-tools`);
    expect(probed.body.probe).toMatchObject({ required: { ok: true }, named: { ok: true }, compat: { reasoningEffort: "none" }, reasoning: { effort: "none", note: "This model refuses tools with its default reasoning; Nook now sends reasoning_effort=none." } });
    expect(effortsSent(effortNone)).toEqual([null, "none", "none"]);
    expect(compatOf(providers.effortNone!).reasoningEffort).toBe("none");
    expect(probed.body.provider.compat.reasoningEffort).toBe("none");
  });

  test("when none is refused too, minimal is tried next", async () => {
    const probed = await send(admin, "POST", `/agents/admin/providers/${providers.effortMinimal}/test-tools`);
    expect(probed.body.probe.reasoning.effort).toBe("minimal");
    expect(effortsSent(effortMinimal)).toEqual([null, "none", "minimal", "minimal"]);
    expect(compatOf(providers.effortMinimal!).reasoningEffort).toBe("minimal");
  });

  test("runtime fallback: a live request with tools retries once with none, and the provider learns it (audited)", async () => {
    const tool = { name: "nook_probe", description: "Probe", parameters: { type: "object", properties: { ok: { type: "boolean" } } } };
    const reply = await completeStreaming(connectionFor(providers.effortLive!, null), { messages: [{ role: "user", content: "go" }], tools: [tool] }, new AbortController().signal, () => undefined);
    expect(reply.toolCalls.map((call) => call.name)).toEqual(["nook_probe"]);
    expect(effortsSent(effortLive)).toEqual([null, "none"]);
    expect(compatOf(providers.effortLive!).reasoningEffort).toBe("none");
    expect(db.query("SELECT event_type FROM audit_log WHERE event_type = 'agents.provider.compat_learned' AND metadata_json LIKE ? LIMIT 1").get(`%${providers.effortLive}%`)).toEqual({ event_type: "agents.provider.compat_learned" });
    // The next request sends it at once.
    effortLive.calls.length = 0;
    await completeStreaming(connectionFor(providers.effortLive!, null), { messages: [{ role: "user", content: "go" }], tools: [tool] }, new AbortController().signal, () => undefined);
    expect(effortsSent(effortLive)).toEqual(["none"]);
  });

  test("the provider form round-trip: an admin sets an effort, omit clears it, other words and other roles are refused", async () => {
    const read = async () => (await send(admin, "GET", "/agents/admin/providers")).body.providers.find((item: Json) => item.id === providers.normal);
    let current = await read();
    const set = await send(admin, "PATCH", `/agents/admin/providers/${providers.normal}`, { compat: { reasoningEffort: "low" }, expectedRevision: current.revision });
    expect(set.status).toBe(200);
    expect(set.body.provider.compat.reasoningEffort).toBe("low");
    normal.calls.length = 0;
    await send(admin, "POST", `/agents/admin/providers/${providers.normal}/test-tools`);
    expect(effortsSent(normal)).toEqual(["low", "low"]);
    current = await read();
    const cleared = await send(admin, "PATCH", `/agents/admin/providers/${providers.normal}`, { compat: { reasoningEffort: "omit" }, expectedRevision: current.revision });
    expect(cleared.body.provider.compat).not.toHaveProperty("reasoningEffort");
    current = await read();
    expect((await send(admin, "PATCH", `/agents/admin/providers/${providers.normal}`, { compat: { reasoningEffort: "extreme" }, expectedRevision: current.revision })).status).toBe(400);
    expect((await send(member, "PATCH", `/agents/admin/providers/${providers.normal}`, { compat: { reasoningEffort: "none" }, expectedRevision: current.revision })).status).toBe(404);
  });

  test("the form offers Don't send and the five efforts", async () => {
    const { REASONING_EFFORT_OPTIONS } = await import("../src/chat/AiSettings");
    expect(REASONING_EFFORT_OPTIONS.map((option) => option.value)).toEqual(["omit", "none", "minimal", "low", "medium", "high"]);
  });
});
