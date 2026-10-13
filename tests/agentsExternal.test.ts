import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, type Session } from "./support/harness";
import { api } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { completionsWith, runMarker, settleAgentRunsAfterEach } from "./support/agentRuns";
import { withinOneWindow } from "./support/clock";

const { createApiKey, narrowApiKey, revokeOwnKey, validateGrants, KeyError } = await import("../server/apiKeys");
const { readPolicies } = await import("../server/team/policies");
const { invokeMcpToolForTests, mcpToolSpecs, loadLiveKey, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { deleteProvider } = await import("../server/agents/providers");
const { deleteServer } = await import("../server/agents/toolServers");
const { resetToolServersForTests } = await import("../server/agents/toolServers");
const { resetAgentRateLimitsForTests, chargeKeyRun, KEY_RUN_LIMITS } = await import("../server/agents/limits");
const { sweepAgentAudit } = await import("../server/agents/audit");
const { withinAgentRun } = await import("../server/agents/depth");
const { offeredSpecs } = await import("../server/agents/nookBridge");
const { markInterruptedRuns } = await import("../server/agents/runs");
const { writeAgentSettings, readAgentSettings } = await import("../server/agents/settings");
type Grant = import("../server/keyGrants").Grant;

/**
 * External runs and the Audit log (Wave 42 "AC-C", agent chat plan §7, §15 item 10, D364–D366,
 * T310, T314, T317–T319): `/api/v1/agents/*` over a Bearer key with an `agents:run` grant, MCP
 * `run_agent`, the grant rules on key create, narrow, and rotate, the effective right per step,
 * auto-only tools, the per-key limits that refuse before the provider is called, API runs that never
 * create chats, the append-only Audit log with its readers (owner in full, admins metadata), export,
 * retention, the depth guard, and a canary for provider and tool-server secrets.
 *
 * Every test gets its own owner and agents, ends only once its runs have ended
 * (`settleAgentRunsAfterEach`), and finds its provider calls by a marker in its input, so a run of an
 * earlier test cannot land in a later test's counts under load (the Docker `verify` stage).
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();
const fake = startFakeProvider(0);
const mcp = startFakeMcpServer(0, { bearer: "srv-canary-w42-0001" });
const PROVIDER_CANARY = "sk-canary-w42-provider-0000000001";
let admin: Session;
let owner: Session;
let other: Session;
let viewer: Session;
let providerId: string;
let serverId: string;
let agentId: string;
let secondAgentId: string;
let othersAgentId: string;

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const agentGrant = (id: string): Grant => ({ module: "agents", permission: "run", resourceKind: "agent", resourceId: id });
const runKey = (session: Session, grants: Grant[], surfaces: "mcp" | "rest" | "both" = "rest", name = "Runner") => createApiKey(session.userId, { name, surfaces, grants, expiresInDays: 30 });

async function rest(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] ??= "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${origin}/api/v1${path}`, init);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

type SseEvent = { seq: number; type: string; data: Record<string, any> };
async function streamRun(token: string, agent: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/v1/agents/${agent}/runs`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim() || frame.startsWith(":")) continue;
    const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
    events.push({ seq: Number(lines.id), type: lines.event!, data: JSON.parse(lines.data!) });
  }
  return events;
}

type CompletionBody = { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> };
const completionBodies = (marker: string) => completionsWith(fake.calls, marker).map((call) => call.body as CompletionBody);
const chatCount = (userId: string) => (db.query("SELECT COUNT(*) AS count FROM chats WHERE owner_id = ?").get(userId) as { count: number }).count;
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A fresh owner with the Runner and Second agents, per test: no test shares slots, budgets, or runs with another. */
async function freshOwner() {
  owner = await createUser("W42 owner");
  const agent = await api(owner, "POST", "/agents", {
    name: "Runner", systemPrompt: "SECRET-PROMPT-W42 Answer briefly.", providerId, maxSteps: 4,
    tools: [{ source: "server", serverId, toolName: "echo", policy: null }, { source: "server", serverId, toolName: "slow", policy: null }, { source: "server", serverId, toolName: "write_thing", policy: null }, { source: "server", serverId, toolName: "fetch_page", policy: "confirm" }, { source: "nook", toolName: "list_notes" }]
  });
  expect(agent.status).toBe(201);
  agentId = agent.body.agent.id;
  const second = await api(owner, "POST", "/agents", { name: "Second", providerId });
  expect(second.status).toBe(201);
  secondAgentId = second.body.agent.id;
}

beforeAll(async () => {
  admin = await createUser("W42 admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  other = await createUser("W42 other");
  viewer = await createUser("W42 viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (external)", baseUrl: fake.baseUrl, apiKey: PROVIDER_CANARY, defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  const server = await api(admin, "POST", "/agents/admin/servers", { name: "W42 tools", slug: "wfortytwo", url: mcp.url, authKind: "bearer", secret: "srv-canary-w42-0001", availability: "all", timeoutMs: 5000 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect((await api(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
  othersAgentId = (await api(other, "POST", "/agents", { name: "Not yours", providerId })).body.agent.id;
});
beforeEach(async () => {
  resetMcpLimits();
  resetAgentRateLimitsForTests();
  await freshOwner();
});
afterAll(async () => {
  deleteServer(admin.userId, serverId);
  deleteProvider(admin.userId, providerId);
  await resetToolServersForTests();
  fake.stop();
  mcp.stop();
});

describe("grants (D364, D278): agents:run on all agents or chosen ones", () => {
  test("create accepts the creator's own agents, refuses others' (404) and chosen items on agents:read; viewers cannot hold run", async () => {
    const policies = readPolicies();
    expect(validateGrants(owner.userId, "member", [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: agentId }] }], policies)).toEqual([agentGrant(agentId)]);
    expect(validateGrants(owner.userId, "member", [{ module: "agents", permission: "run" }], policies)).toEqual([all("agents", "run")]);
    const refused = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return error instanceof KeyError ? [error.status, error.code] : String(error); } };
    expect(refused(() => validateGrants(owner.userId, "member", [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: othersAgentId }] }], policies))).toEqual([404, "RESOURCE_NOT_FOUND"]);
    expect(refused(() => validateGrants(owner.userId, "member", [{ module: "agents", permission: "read", resources: [{ kind: "agent", id: agentId }] }], policies))).toEqual([400, "INVALID_GRANT"]);
    expect(refused(() => validateGrants(viewer.userId, "viewer", [{ module: "agents", permission: "run" }], policies))).toEqual([403, "SCOPE_NOT_ALLOWED"]);
    // Over HTTP, re-authenticated as every key create.
    const ok = await api(owner, "POST", "/keys", { name: "CI runner", surfaces: "rest", password: owner.password, grants: [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: agentId }] }] });
    expect(ok.status).toBe(201);
    expect(ok.body.key.grants).toEqual([expect.objectContaining({ module: "agents", permission: "run", resource: { kind: "agent", id: agentId, name: "Runner" }, active: true })]);
    const theirs = await api(owner, "POST", "/keys", { name: "Theirs", surfaces: "rest", password: owner.password, grants: [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: othersAgentId }] }] });
    expect(theirs).toMatchObject({ status: 404, body: { code: "RESOURCE_NOT_FOUND" } });
    // Narrowing all → one agent is allowed; widening one → all is not (D278). Rotation validates like creation.
    const wide = runKey(owner, [all("agents", "run")]);
    expect(narrowApiKey(owner.userId, wide.id, { grants: [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: secondAgentId }] }] }).changed).toContain("grants");
    expect(db.query("SELECT resource_kind, resource_id FROM api_key_grants WHERE key_id = ?").all(wide.id)).toEqual([{ resource_kind: "agent", resource_id: secondAgentId }]);
    expect(refused(() => narrowApiKey(owner.userId, wide.id, { grants: [{ module: "agents", permission: "run" }] }))).toEqual([400, "WIDENING_NOT_ALLOWED"]);
    const rotated = await api(owner, "POST", `/keys/${ok.body.key.id}/rotate`, { password: owner.password, graceHours: 0, grants: [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: othersAgentId }] }] });
    expect(rotated.status).toBe(404);
    // A key on an agent that later goes to the Bin lists the grant as inactive.
    const binned = (await api(owner, "POST", "/agents", { name: "Short-lived", providerId })).body.agent.id as string;
    const onBinned = runKey(owner, [agentGrant(binned)]);
    expect((await api(owner, "DELETE", `/agents/${binned}`, {})).status).toBe(200);
    const listed = (await api(owner, "GET", "/keys")).body.keys.find((key: { id: string }) => key.id === onBinned.id);
    expect(listed.grants[0]).toMatchObject({ active: false, inactiveReason: "no-access" });
  });

  test("MCP: agents:run shows run_agent and list_agents (narrowed to the grant); run_agent declares its access and never reaches agents' Nook tools", () => {
    const one = runKey(owner, [agentGrant(secondAgentId)], "mcp");
    const live = loadLiveKey(one.id)!;
    expect(mcpToolSpecs.filter((spec) => toolVisible(spec, live)).map((spec) => spec.name).sort()).toEqual(["list_agents", "run_agent"]);
    const runAgent = mcpToolSpecs.find((spec) => spec.name === "run_agent")!;
    expect(runAgent.access).toEqual({ mode: "items", items: [{ arg: "agentId", kind: "agent" }] });
    expect(offeredSpecs().some((spec) => spec.name === "run_agent")).toBe(false);
  });
});

describe("REST /api/v1/agents (§7.2, D280 rules)", () => {
  test("lists only the agents the grant covers, never the prompt; the D280 transport rules hold", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const list = await rest(key.token, "GET", "/agents");
    expect(list.status).toBe(200);
    expect(list.body.agents.map((agent: { id: string }) => agent.id)).toEqual([agentId]);
    expect(list.body.agents[0]).toMatchObject({ name: "Runner", maxSteps: 4 });
    // Only tools that run on their own: echo and slow (auto); write_thing (confirm) and fetch_page (agent: confirm) never.
    expect(list.body.agents[0].tools.sort()).toEqual(["wfortytwo/echo", "wfortytwo/slow"]);
    expect(list.text).not.toContain("SECRET-PROMPT-W42");
    expect(list.headers.get("cache-control")).toContain("no-store");
    expect(list.headers.get("access-control-allow-origin")).toBeNull();
    // A key with all agents sees both; a key without the grant sees none and gets 404 on a run.
    const wide = runKey(owner, [all("agents", "run")]);
    expect((await rest(wide.token, "GET", "/agents")).body.agents.map((agent: { name: string }) => agent.name)).toEqual(["Runner", "Second"]);
    const noGrant = runKey(owner, [all("notes", "read")]);
    expect((await rest(noGrant.token, "GET", "/agents")).body.agents).toEqual([]);
    expect(await rest(noGrant.token, "POST", `/agents/${agentId}/runs`, { input: "echo:hi" })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    // Outside the grant, someone else's, and malformed are the same 404.
    expect((await rest(key.token, "POST", `/agents/${secondAgentId}/runs`, { input: "echo:hi" })).status).toBe(404);
    expect((await rest(wide.token, "POST", `/agents/${othersAgentId}/runs`, { input: "echo:hi" })).status).toBe(404);
    expect((await rest(key.token, "POST", "/agents/not-an-id/runs", { input: "echo:hi" })).status).toBe(404);
    // Bearer only; never a cookie; never a key in the URL; JSON only; methods; vault keys; an MCP-only key.
    expect((await rest(null, "GET", "/agents")).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/agents`, { headers: { Cookie: owner.cookie } })).status).toBe(401);
    expect(await rest(null, "GET", `/agents?token=${key.token}`)).toMatchObject({ status: 400, body: { code: "KEY_IN_URL" } });
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, "input=hi", { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, "{nope")).status).toBe(400);
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "a", messages: [{ role: "user", content: "b" }] })).body.code).toBe("INVALID");
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, { messages: [{ role: "assistant", content: "b" }] })).body.code).toBe("INVALID");
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "x".repeat(33 * 1024) })).body.code).toBe("INVALID");
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "hi", extra: 1 })).body.code).toBe("INVALID");
    expect((await rest(key.token, "DELETE", "/agents")).status).toBe(405);
    expect((await rest(key.token, "GET", `/agents/${agentId}/runs`)).status).toBe(405);
    expect((await rest(key.token, "GET", `/agents/${agentId}`)).status).toBe(404);
    expect((await rest(key.token, "GET", "/agents", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    const mcpOnly = runKey(owner, [agentGrant(agentId)], "mcp");
    expect((await rest(mcpOnly.token, "GET", "/agents")).status).toBe(403);
  });

  test("a plain run answers 200 with output, steps, toolCalls, usage, and timings; no chat is created; the run is audited", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const chatsBefore = chatCount(owner.userId);
    const marker = runMarker();
    const hello = `Hello from CI ${marker}.`;
    const result = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `echo:${hello}`, label: "nightly" });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.body).toMatchObject({ agentId, status: "ok", output: hello, steps: 1, toolCalls: [], error: null, label: "nightly", usage: { promptTokens: expect.any(Number), completionTokens: expect.any(Number), estimated: false } });
    expect(result.body.timings).toEqual({ queuedMs: expect.any(Number), firstTokenMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(chatCount(owner.userId)).toBe(chatsBefore);
    const run = db.query("SELECT via, chat_id, key_id, user_id, status, label, client_address FROM agent_runs WHERE id = ?").get(result.body.runId) as Record<string, unknown>;
    expect(run).toMatchObject({ via: "api", chat_id: null, key_id: key.id, user_id: owner.userId, status: "ok", label: "nightly" });
    expect(db.query("SELECT input_text, output_text FROM agent_audit_entries WHERE run_id = ?").get(result.body.runId)).toEqual({ input_text: `echo:${hello}`, output_text: hello });
    expect(db.query("SELECT kind, text FROM agent_audit_steps WHERE run_id = ? ORDER BY seq").all(result.body.runId)).toEqual([{ kind: "model", text: hello }]);
    // Tokens are charged to the key's own usage row; the provider saw the preamble, the prompt, and the input.
    expect(db.query("SELECT runs FROM agent_usage_daily WHERE key_id = ? AND agent_id = ?").get(key.id, agentId)).toEqual({ runs: 1 });
    expect(completionBodies(marker)).toHaveLength(1);
    expect(completionBodies(marker)[0]!.messages[0]!.content).toContain("SECRET-PROMPT-W42");
    // Stateless multi-turn: the turns go to the model as given.
    const multiMarker = runMarker();
    const multi = await rest(key.token, "POST", `/agents/${agentId}/runs`, { messages: [{ role: "user", content: `first ${multiMarker}` }, { role: "assistant", content: "ok" }, { role: "user", content: "echo:second" }] });
    expect(multi.body.output).toBe("second");
    expect(completionBodies(multiMarker)).toHaveLength(1);
    expect(completionBodies(multiMarker)[0]!.messages.slice(1).map((turn) => [turn.role, turn.content])).toEqual([["user", `first ${multiMarker}`], ["assistant", "ok"], ["user", "echo:second"]]);
  });

  test("a streaming run answers SSE: run, deltas, usage, and done with the same result shape", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const events = await streamRun(key.token, agentId, { input: "echo:Streamed words here." });
    expect(events[0]).toMatchObject({ type: "run", data: { agentId } });
    expect(events.filter((event) => event.type === "delta").map((event) => event.data.text).join("")).toBe("Streamed words here.");
    expect(events.some((event) => event.type === "usage")).toBe(true);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", data: { status: "ok", output: "Streamed words here.", steps: 1, error: null } });
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.type.startsWith("confirmation"))).toBe(false);
  });

  test("GET and cancel answer the starting key only; another key of the same owner gets 404", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const otherKey = runKey(owner, [agentGrant(agentId)]);
    const done = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "echo:Readback." });
    const read = await rest(key.token, "GET", `/agents/${agentId}/runs/${done.body.runId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ runId: done.body.runId, status: "ok", output: "Readback.", steps: 1, toolCalls: [] });
    expect((await rest(otherKey.token, "GET", `/agents/${agentId}/runs/${done.body.runId}`)).status).toBe(404);
    expect((await rest(otherKey.token, "POST", `/agents/${agentId}/runs/${done.body.runId}/cancel`)).status).toBe(404);
    expect((await rest(key.token, "GET", `/agents/${secondAgentId}/runs/${done.body.runId}`)).status).toBe(404);
    // Cancelling a live run (a slow stream) by its key; the call answers at once and the run ends cancelled.
    const pending = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:150:one two three four five six seven eight" });
    await waitFor(() => db.query("SELECT 1 FROM agent_runs WHERE key_id = ? AND status = 'running'").get(key.id) !== null);
    const live = db.query("SELECT id FROM agent_runs WHERE key_id = ? AND status = 'running'").get(key.id) as { id: string };
    expect((await rest(otherKey.token, "POST", `/agents/${agentId}/runs/${live.id}/cancel`, {})).status).toBe(404);
    const midway = await rest(key.token, "GET", `/agents/${agentId}/runs/${live.id}`);
    expect(midway.body.status).toBe("running");
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs/${live.id}/cancel`, {})).body).toEqual({ status: "cancelled" });
    expect((await pending).body.status).toBe("cancelled");
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs/${live.id}/cancel`)).body).toEqual({ status: "cancelled" });
  });
});

describe("tools over the API (§2, §5.4, D352): auto only", () => {
  test("only auto tools are offered; a confirm tool can never be called; results are audited in full", async () => {
    const key = runKey(owner, [agentGrant(agentId), all("notes", "read")]);
    const marker = runMarker();
    const ran = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `tool:wfortytwo__echo:{"text":"ping ${marker}"}` });
    expect(ran.body).toMatchObject({ status: "ok", steps: 2, toolCalls: [{ name: "echo", server: "wfortytwo", ok: true }] });
    // The run's first model call is the one the tools were offered to; the second answers the tool's result.
    expect(completionBodies(marker)).toHaveLength(2);
    const offered = completionBodies(marker)[0]! as { tools: Array<{ function: { name: string } }> };
    // The calling key is the Nook key (D359): its notes:read gives list_notes; nothing that asks first is offered.
    expect(offered.tools.map((tool) => tool.function.name).sort()).toEqual(["nook__list_notes", "wfortytwo__echo", "wfortytwo__slow"]);
    const steps = db.query("SELECT seq, kind, tool_name, args_json, result_text, ok FROM agent_audit_steps WHERE run_id = ? ORDER BY seq").all(ran.body.runId) as Array<Record<string, any>>;
    expect(steps.map((step) => [step.kind, step.tool_name])).toEqual([["model", null], ["tool", "echo"], ["model", null]]);
    expect(steps[1]).toMatchObject({ args_json: `{"text":"ping ${marker}"}`, ok: 1 });
    expect(steps[1]!.result_text).toContain("ping");
    // The model asking for a confirm tool anyway gets "unknown tool": it was never offered, so it never runs.
    const writesBefore = mcp.calls.filter((call) => call.method === "tools/call" && (call.params as { name?: string })?.name === "write_thing").length;
    const confirm = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "tool:wfortytwo__write_thing:{\"what\":\"x\"}" });
    expect(confirm.body.toolCalls).toEqual([{ name: "wfortytwo__write_thing", server: "?", ok: false, durationMs: expect.any(Number) }]);
    expect(mcp.calls.filter((call) => call.method === "tools/call" && (call.params as { name?: string })?.name === "write_thing").length).toBe(writesBefore);
    const fetchPage = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "tool:wfortytwo__fetch_page:{\"url\":\"https://x.example\"}" });
    expect(fetchPage.body.toolCalls[0]).toMatchObject({ ok: false });
    // An agent calling run_agent (it is never a Nook tool) gets "unknown tool" too.
    const recursion = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "tool:nook__run_agent:{}" });
    expect(recursion.body.toolCalls[0]).toMatchObject({ name: "nook__run_agent", ok: false });
  });

  test("a key revoked or narrowed mid-run ends the run KEY_INACTIVE at its next step", async () => {
    for (const change of ["revoke", "narrow"] as const) {
      const key = runKey(owner, [all("agents", "run")]);
      // Only this run's tool call counts (the first pass's call is already in the log).
      const before = mcp.calls.length;
      const pending = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "tool:wfortytwo__slow:{\"ms\":600}" });
      await waitFor(() => mcp.calls.slice(before).some((call) => call.method === "tools/call" && (call.params as { name?: string })?.name === "slow" && db.query("SELECT 1 FROM agent_runs WHERE key_id = ? AND status = 'running'").get(key.id) !== null));
      if (change === "revoke") revokeOwnKey(owner.userId, key.id);
      else narrowApiKey(owner.userId, key.id, { grants: [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: secondAgentId }] }] });
      const result = (await pending).body;
      expect(result).toMatchObject({ status: "error", error: { code: "KEY_INACTIVE" } });
      expect(result.steps).toBe(1);
      expect(db.query("SELECT status, error_code FROM agent_runs WHERE id = ?").get(result.runId)).toEqual({ status: "error", error_code: "KEY_INACTIVE" });
      if (change === "revoke") expect((await rest(key.token, "GET", "/agents")).status).toBe(401);
    }
  });
});

describe("limits (§2.2, §7.2, T314): refused before the provider is called", () => {
  test("2 concurrent runs per key, then 429 AGENT_BUSY with Retry-After", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const first = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:120:a b c d e f g h" });
    const second = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:120:a b c d e f g h" });
    await waitFor(() => (db.query("SELECT COUNT(*) AS count FROM agent_runs WHERE key_id = ? AND status = 'running'").get(key.id) as { count: number }).count === 2);
    // A run is marked running before its provider call goes out, so count only the refused run's own calls.
    const marker = runMarker();
    const third = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `echo:third ${marker}` });
    expect(third).toMatchObject({ status: 429, body: { code: "AGENT_BUSY" } });
    expect(third.headers.get("retry-after")).toBe("5");
    expect(completionsWith(fake.calls, marker)).toHaveLength(0);
    expect((await Promise.all([first, second])).map((answer) => answer.body.status)).toEqual(["ok", "ok"]);
  });

  test("20 runs a minute and 500 a day per key (persistent), the key's token budget, and the owner's budget", async () => {
    // The windows themselves, on a fixed clock: the 21st run in a minute and the 501st in a day are refused.
    const unitKey = `unit-${runMarker()}`;
    const at = Date.UTC(2030, 0, 15, 12, 0, 30);
    for (let index = 0; index < KEY_RUN_LIMITS.minute.limit; index += 1) expect(chargeKeyRun(unitKey, at)).toBe(0);
    expect(chargeKeyRun(unitKey, at)).toBe(30);
    expect(chargeKeyRun(unitKey, at + KEY_RUN_LIMITS.minute.windowMs * 2)).toBe(0);
    db.query("UPDATE agent_rate_limits SET count = ? WHERE bucket = ?").run(KEY_RUN_LIMITS.day.limit, `run_day:${unitKey}`);
    expect(chargeKeyRun(unitKey, at + KEY_RUN_LIMITS.minute.windowMs * 4)).toBeGreaterThan(0);
    expect(chargeKeyRun(unitKey, at + KEY_RUN_LIMITS.day.windowMs)).toBe(0);
    resetAgentRateLimitsForTests();
    // Over HTTP, inside one window each (a seeded row never sees its window roll over under it).
    const marker = runMarker();
    const key = runKey(owner, [agentGrant(agentId)]);
    await withinOneWindow(KEY_RUN_LIMITS.minute.windowMs, async () => {
      const minute = Math.floor(Date.now() / KEY_RUN_LIMITS.minute.windowMs) * KEY_RUN_LIMITS.minute.windowMs;
      db.query("INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 20, 0)").run(`run_minute:${key.id}`, minute);
      const limited = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `echo:limited ${marker}` });
      expect(limited).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    });
    resetAgentRateLimitsForTests();
    await withinOneWindow(KEY_RUN_LIMITS.day.windowMs, async () => {
      const day = Math.floor(Date.now() / KEY_RUN_LIMITS.day.windowMs) * KEY_RUN_LIMITS.day.windowMs;
      db.query("INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 500, 0)").run(`run_day:${key.id}`, day);
      expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `echo:limited ${marker}` })).body.code).toBe("RATE_LIMITED");
    });
    resetAgentRateLimitsForTests();
    // The key's daily token budget (200k by default) and the owner's (500k) refuse before the provider too.
    const fresh = runKey(owner, [agentGrant(agentId)]);
    await withinOneWindow(KEY_RUN_LIMITS.day.windowMs, async () => {
      const today = new Date().toISOString().slice(0, 10);
      db.query("INSERT INTO agent_usage_daily (day, user_id, key_id, agent_id, runs, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, 0, 200000, 0)").run(today, owner.userId, key.id, agentId);
      expect(await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `echo:budget ${marker}` })).toMatchObject({ status: 429, body: { code: "BUDGET_EXCEEDED" } });
      db.query("INSERT INTO agent_usage_daily (day, user_id, key_id, agent_id, runs, prompt_tokens, completion_tokens) VALUES (?, ?, '', ?, 0, 400000, 0)").run(today, owner.userId, agentId);
      expect(await rest(fresh.token, "POST", `/agents/${agentId}/runs`, { input: `echo:budget ${marker}` })).toMatchObject({ status: 429, body: { code: "BUDGET_EXCEEDED" } });
      db.query("DELETE FROM agent_usage_daily WHERE user_id = ? AND day = ?").run(owner.userId, today);
    });
    expect(completionsWith(fake.calls, marker)).toHaveLength(0);
    // A refused run left no Audit log row.
    expect((db.query("SELECT COUNT(*) AS count FROM agent_runs WHERE key_id IN (?, ?)").get(key.id, fresh.id) as { count: number }).count).toBe(0);
  }, 60_000);
});

describe("MCP run_agent (§7.2, T318)", () => {
  test("runs non-streaming and audits as via mcp; refused inside any agent run (the depth guard)", async () => {
    const key = runKey(owner, [agentGrant(agentId)], "mcp");
    const result = await invokeMcpToolForTests("run_agent", { agentId, input: "echo:Over MCP." }, key.id);
    expect(result.isError).not.toBe(true);
    const value = JSON.parse(result.content[0]!.text);
    expect(value).toMatchObject({ status: "ok", output: "Over MCP.", steps: 1 });
    expect(db.query("SELECT via, chat_id FROM agent_runs WHERE id = ?").get(value.runId)).toEqual({ via: "mcp", chat_id: null });
    const nested = await withinAgentRun({ runId: "outer", via: "chat" }, () => invokeMcpToolForTests("run_agent", { agentId, input: "echo:nested" }, key.id));
    expect(nested.isError).toBe(true);
    expect(JSON.parse(nested.content[0]!.text).code).toBe("AGENT_RECURSION");
    // Outside the grant is NOT_FOUND, the same as missing.
    expect(JSON.parse((await invokeMcpToolForTests("run_agent", { agentId: secondAgentId, input: "echo:x" }, key.id)).content[0]!.text).code).toBe("NOT_FOUND");
    // The same tool over REST (POST /api/v1/tools/run_agent) is an API run on the REST surface.
    const restKey = runKey(owner, [agentGrant(agentId)], "rest");
    const viaRest = await rest(restKey.token, "POST", "/tools/run_agent", { agentId, input: "echo:Tool route." });
    expect(viaRest.body).toMatchObject({ status: "ok", output: "Tool route." });
    expect(db.query("SELECT via FROM agent_runs WHERE id = ?").get(viaRest.body.runId)).toEqual({ via: "api" });
    // A chat agent cannot pick run_agent as a Nook tool.
    expect((await api(owner, "PATCH", `/agents/${secondAgentId}`, { tools: [{ source: "nook", toolName: "run_agent" }], expectedRevision: 1 })).status).toBe(400);
  });
});

describe("the Audit log (§7.3, D365, D366, T317)", () => {
  test("the key's owner reads everything; an admin reads metadata only; anyone else gets 404", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const ran = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "tool:wfortytwo__echo:{\"text\":\"PRIVATE-ARG-W42\"}", label: "private label" });
    const runId = ran.body.runId as string;
    const mine = await api(owner, "GET", `/agents/audit/${runId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.run).toMatchObject({ id: runId, via: "api", full: true, label: "private label", input: expect.stringContaining("PRIVATE-ARG-W42"), toolNames: ["echo"], key: { id: key.id, name: "Runner" } });
    expect(mine.body.run.timeline.map((step: { kind: string; tool: string | null; server: string | null }) => [step.kind, step.tool, step.server])).toEqual([["model", null, null], ["tool", "echo", "wfortytwo"], ["model", null, null]]);
    expect(mine.body.run.timeline[1].args).toContain("PRIVATE-ARG-W42");
    const adminView = await api(admin, "GET", `/agents/audit/${runId}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.run).toMatchObject({ id: runId, full: false, input: null, output: null, label: null, clientAddress: null, toolNames: ["echo"], owner: { id: owner.userId, displayName: "W42 owner" }, key: { name: "Runner" } });
    for (const step of adminView.body.run.timeline) expect([step.text, step.args, step.result]).toEqual([null, null, null]);
    expect(JSON.stringify(adminView.body)).not.toContain("PRIVATE-ARG-W42");
    expect(JSON.stringify(adminView.body)).not.toContain("private label");
    expect((await api(other, "GET", `/agents/audit/${runId}`)).status).toBe(404);
    // Lists: the owner sees their runs; another member sees none of them; the admin sees them as metadata.
    const ownList = await api(owner, "GET", `/agents/audit?key=${key.id}`);
    expect(ownList.body.runs.map((run: { id: string }) => run.id)).toEqual([runId]);
    expect((await api(other, "GET", "/agents/audit")).body.runs.some((run: { id: string }) => run.id === runId)).toBe(false);
    const adminList = await api(admin, "GET", `/agents/audit?agent=${agentId}&status=ok`);
    expect(adminList.body.runs.find((run: { id: string }) => run.id === runId)).toMatchObject({ full: false, label: null });
    expect((await api(admin, "GET", "/agents/audit?status=bogus")).status).toBe(400);
    expect((await api(owner, "GET", "/agents/status")).body.auditVisible).toBe(true);
    expect((await api(other, "GET", "/agents/status")).body.auditVisible).toBe(false);
    // API runs never appear among chats, and chat runs never in the Audit log.
    expect((await api(owner, "GET", "/chats")).body.chats).toEqual([]);
    // The agent's manager sees counts, not content.
    const usage = await api(owner, "GET", `/agents/${agentId}/api-usage`);
    expect(usage.body.usage.totals.runs).toBeGreaterThan(0);
    expect(JSON.stringify(usage.body)).not.toContain("PRIVATE");
    expect((await api(other, "GET", `/agents/${agentId}/api-usage`)).status).toBe(404);
  });

  test("rows are append-only: a finished run, its entry, and its steps refuse edits and deletes", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const runId = (await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "echo:frozen" })).body.runId as string;
    expect(() => db.query("UPDATE agent_runs SET status = 'ok', label = 'x' WHERE id = ?").run(runId)).toThrow(/APPEND_ONLY/);
    expect(() => db.query("UPDATE agent_audit_entries SET output_text = 'x' WHERE run_id = ?").run(runId)).toThrow(/APPEND_ONLY/);
    expect(() => db.query("UPDATE agent_audit_steps SET text = 'x' WHERE run_id = ?").run(runId)).toThrow(/APPEND_ONLY/);
    expect(() => db.query("DELETE FROM agent_audit_steps WHERE run_id = ?").run(runId)).toThrow(/APPEND_ONLY/);
    expect(() => db.query("DELETE FROM agent_audit_entries WHERE run_id = ?").run(runId)).toThrow(/APPEND_ONLY/);
    expect(() => db.query("DELETE FROM agent_runs WHERE id = ?").run(runId)).toThrow(/APPEND_ONLY/);
    // The guard row does not reach a run younger than 7 days, whatever its cutoff says.
    expect(() => db.transaction(() => {
      db.query("INSERT INTO agent_retention_guard (id, cutoff) VALUES (1, '2999-01-01T00:00:00.000Z')").run();
      db.query("DELETE FROM agent_runs WHERE id = ?").run(runId);
    })()).toThrow(/APPEND_ONLY/);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_retention_guard").get()).toEqual({ count: 0 });
    // An API run always has a key and never a chat.
    expect(() => db.query("INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, user_id, model, status, queued_at) VALUES ('x', 'api', ?, 1, 'h', 1, ?, 'm', 'ok', ?)").run(agentId, owner.userId, new Date().toISOString())).toThrow(/AUDIT_SHAPE/);
    // A run still live at a restart may still be marked interrupted.
    const liveId = crypto.randomUUID();
    db.query("INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, user_id, key_id, model, status, queued_at) VALUES (?, 'api', ?, 1, 'h', 1, ?, ?, 'm', 'running', ?)").run(liveId, agentId, owner.userId, key.id, new Date().toISOString());
    markInterruptedRuns(() => undefined);
    expect(db.query("SELECT status FROM agent_runs WHERE id = ?").get(liveId)).toEqual({ status: "interrupted" });
  });

  test("retention: the sweeper deletes runs past the retention days through the guard, 500 at a time", () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const insert = (id: string, daysAgo: number) => {
      db.query("INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, user_id, key_id, model, status, queued_at, finished_at) VALUES (?, 'api', ?, 1, 'h', 1, ?, ?, 'm', 'ok', ?, ?)")
        .run(id, agentId, owner.userId, key.id, new Date(Date.now() - daysAgo * 86_400_000).toISOString(), new Date(Date.now() - daysAgo * 86_400_000).toISOString());
      db.query("INSERT INTO agent_audit_entries (run_id, input_text) VALUES (?, 'old')").run(id);
      db.query("INSERT INTO agent_audit_steps (run_id, seq, kind, duration_ms) VALUES (?, 1, 'model', 1)").run(id);
    };
    const oldIds = Array.from({ length: 503 }, () => crypto.randomUUID());
    db.transaction(() => { for (const id of oldIds) insert(id, 40); })();
    const keep = crypto.randomUUID();
    insert(keep, 10);
    expect(readAgentSettings().auditRetentionDays).toBe(30);
    expect(sweepAgentAudit()).toBe(503);
    expect(db.query(`SELECT COUNT(*) AS count FROM agent_audit_steps WHERE run_id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(oldIds))).toEqual({ count: 0 });
    expect(db.query("SELECT 1 AS kept FROM agent_runs WHERE id = ?").get(keep)).toEqual({ kept: 1 });
    // The admin's policy may shorten it (7–365): the ten-day-old run goes at 7.
    const settings = readAgentSettings();
    writeAgentSettings(admin.userId, { auditRetentionDays: 7 }, settings.revision);
    expect(sweepAgentAudit()).toBe(1);
    writeAgentSettings(admin.userId, { auditRetentionDays: 30 }, readAgentSettings().revision);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_retention_guard").get()).toEqual({ count: 0 });
  });

  test("export: JSON, attachment, no-store, the reader's own runs only, at most 1,000", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const runId = (await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "echo:Exported." })).body.runId as string;
    const one = await fetch(`${origin}/api/agents/audit/export?runId=${runId}`, { headers: { Cookie: owner.cookie } });
    expect(one.status).toBe(200);
    expect(one.headers.get("cache-control")).toContain("no-store");
    expect(one.headers.get("content-disposition")).toBe(`attachment; filename="nook-agent-run-${runId}.json"`);
    const body = await one.json() as { count: number; runs: Array<{ id: string; input: string; output: string; timeline: unknown[] }> };
    expect(body.runs[0]).toMatchObject({ id: runId, input: "echo:Exported.", output: "Exported." });
    // An admin cannot export someone else's run: it is not theirs.
    expect((await fetch(`${origin}/api/agents/audit/export?runId=${runId}`, { headers: { Cookie: admin.cookie } })).status).toBe(404);
    const adminAll = await (await fetch(`${origin}/api/agents/audit/export`, { headers: { Cookie: admin.cookie } })).json() as { runs: Array<{ id: string }> };
    expect(adminAll.runs.some((run) => run.id === runId)).toBe(false);
    // Up to 1,000 filtered runs.
    const bulkKey = runKey(owner, [agentGrant(agentId)], "rest", "Bulk");
    db.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        const id = crypto.randomUUID();
        db.query("INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, user_id, key_id, model, status, queued_at, finished_at) VALUES (?, 'api', ?, 1, 'h', 1, ?, ?, 'm', 'ok', ?, ?)")
          .run(id, agentId, owner.userId, bulkKey.id, new Date(Date.now() - index * 1000).toISOString(), new Date().toISOString());
        db.query("INSERT INTO agent_audit_entries (run_id, input_text) VALUES (?, 'bulk')").run(id);
      }
    })();
    const bulk = await (await fetch(`${origin}/api/agents/audit/export?key=${bulkKey.id}`, { headers: { Cookie: owner.cookie } })).json() as { count: number; truncated: boolean; runs: unknown[] };
    expect([bulk.count, bulk.truncated, bulk.runs.length]).toEqual([1000, true, 1000]);
    const page = await api(owner, "GET", `/agents/audit?key=${bulkKey.id}`);
    expect(page.body.runs).toHaveLength(50);
    const next = await api(owner, "GET", `/agents/audit?key=${bulkKey.id}&cursor=${encodeURIComponent(page.body.nextCursor)}`);
    expect(next.body.runs[0].id).not.toBe(page.body.runs[0].id);
    expect(next.body.runs).toHaveLength(50);
  });

  test("canary: neither the provider key nor the tool server's credential reaches any Audit log row or answer", async () => {
    const key = runKey(owner, [agentGrant(agentId)]);
    const marker = runMarker();
    const ran = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: `tool:wfortytwo__echo:{"text":"c ${marker}"}` });
    expect(ran.text).not.toContain("canary");
    const dump = JSON.stringify([
      db.query("SELECT * FROM agent_runs WHERE via <> 'chat'").all(),
      db.query("SELECT * FROM agent_audit_entries").all(),
      db.query("SELECT * FROM agent_audit_steps").all(),
      db.query("SELECT * FROM audit_log WHERE event_type LIKE 'agents.%'").all()
    ]);
    expect(dump).not.toContain(PROVIDER_CANARY);
    expect(dump).not.toContain("srv-canary-w42-0001");
    // The secrets did leave for their own endpoints only (proof the canary was live).
    const own = completionsWith(fake.calls, marker);
    expect(own).toHaveLength(2);
    for (const call of own) expect(call.headers.authorization).toBe(`Bearer ${PROVIDER_CANARY}`);
    const detail = await api(owner, "GET", `/agents/audit/${ran.body.runId}`);
    expect(JSON.stringify(detail.body)).not.toContain("canary");
  });
});
