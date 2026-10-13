import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUser, db, origin, type Session } from "./support/harness";
import { api } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { settleAgentRunsAfterEach } from "./support/agentRuns";

const { createApiKey, narrowApiKey, rotateApiKey, revokeOwnKey, KeyError } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { deleteProvider } = await import("../server/agents/providers");
const { createServer, deleteServer, updateServer, serverRow, resetToolServersForTests } = await import("../server/agents/toolServers");
const { resetAgentRateLimitsForTests, holdPlainRun, heldPlainRuns, HELD_RUN_SLOTS } = await import("../server/agents/limits");
const { runWatch } = await import("../server/agents/loop");
const { liveExternalRuns } = await import("../server/agents/external");
type Grant = import("../server/keyGrants").Grant;

/**
 * Wave 42 fixes (AC-C review R and QA Q findings): the HTTP-hop recursion guards (Nook keys refused
 * as tool-server credentials, the Nook-Agent-Run header out and in, `agents:run` never on a linked
 * key), held plain runs capped at half of each surface's slots, one label rule, blank turns refused,
 * run_agent's errors by code, the right re-checked while a model call streams (API and chat), the
 * partial step charged on cancel and stop, the facets of the Audit log's filters, the SSE order,
 * the explained ending on API runs, and the shared slots' message.
 *
 * Every test uses its own owner and agent, and ends only once its runs have ended
 * (`settleAgentRunsAfterEach`), so slots and live runs never carry into the next test under load.
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();
const fake = startFakeProvider(0);
const mcp = startFakeMcpServer(0);

/** A tool server that calls Nook back, forwarding the Nook-Agent-Run header it got (a well-behaved bridge). */
const hop: { token: string | null; seen: Array<string | null>; answers: Array<{ status: number; body: string }>; target: "rest" | "tool" | "mcp" } = { token: null, seen: [], answers: [], target: "rest" };
const hopServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/mcp" || request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 });
    const message = await request.json() as { id?: unknown; method?: string; params?: Record<string, any> };
    if (message.id === undefined || message.id === null) return new Response(null, { status: 202 });
    const respond = (result: unknown, headers: Record<string, string> = {}) => Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers });
    if (message.method === "initialize") return respond({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hop", version: "1" } }, { "Mcp-Session-Id": "s-hop" });
    if (message.method === "tools/list") return respond({ tools: [{ name: "callback", description: "Calls Nook back.", inputSchema: { type: "object", properties: { agentId: { type: "string" } } }, annotations: { readOnlyHint: true, openWorldHint: false } }] });
    if (message.method === "tools/call") {
      const runHeader = request.headers.get("nook-agent-run");
      hop.seen.push(runHeader);
      const agentId = (message.params?.arguments as { agentId?: string } | undefined)?.agentId;
      const headers: Record<string, string> = { Authorization: `Bearer ${hop.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(runHeader ? { "Nook-Agent-Run": runHeader } : {}) };
      const response = hop.target === "rest" ? await fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers, body: JSON.stringify({ input: "echo:inner" }) })
        : hop.target === "tool" ? await fetch(`${origin}/api/v1/tools/run_agent`, { method: "POST", headers, body: JSON.stringify({ agentId, input: "echo:inner" }) })
        : await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_agent", arguments: { agentId, input: "echo:inner" } } }) });
      const body = await response.text();
      hop.answers.push({ status: response.status, body });
      return respond({ content: [{ type: "text", text: `status ${response.status}` }] });
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});

let admin: Session;
let providerId: string;
let serverId: string;
let hopServerId: string;

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const agentGrant = (id: string): Grant => ({ module: "agents", permission: "run", resourceKind: "agent", resourceId: id });
const runKey = (session: Session, grants: Grant[], surfaces: "mcp" | "rest" | "both" = "rest") => createApiKey(session.userId, { name: "Fixes", surfaces, grants, expiresInDays: 30 });

async function rest(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] ??= "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${origin}/api/v1${path}`, init);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

type SseEvent = { type: string; data: Record<string, any> };
const parseSse = (text: string): SseEvent[] => text.split("\n\n").filter((frame) => frame.trim() && !frame.startsWith(":")).map((frame) => {
  const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  return { type: lines.event!, data: JSON.parse(lines.data!) };
});

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const runRow = (runId: string) => db.query("SELECT status, error_code, prompt_tokens, completion_tokens, tokens_estimated FROM agent_runs WHERE id = ?").get(runId) as { status: string; error_code: string | null; prompt_tokens: number; completion_tokens: number; tokens_estimated: number };
const keyTokens = (keyId: string) => (db.query("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens FROM agent_usage_daily WHERE key_id = ?").get(keyId) as { tokens: number }).tokens;
const userChatTokens = (userId: string) => (db.query("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens FROM agent_usage_daily WHERE user_id = ? AND key_id = ''").get(userId) as { tokens: number }).tokens;
const LONG = "slow:120:" + Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");

async function ownerWithAgent(name: string, tools: unknown[] = []) {
  const person = await createUser(name);
  const created = await api(person, "POST", "/agents", { name: `${name} agent`, systemPrompt: "x", providerId, maxSteps: 3, tools });
  expect(created.status).toBe(201);
  return { person, agentId: created.body.agent.id as string };
}

beforeAll(async () => {
  admin = await createUser("W42F admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Fake (W42 fixes)", baseUrl: fake.baseUrl, apiKey: "sk-canary-w42-fixes-000000000001", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  const server = await api(admin, "POST", "/agents/admin/servers", { name: "W42F tools", slug: "wftools", url: mcp.url, authKind: "none", availability: "all", timeoutMs: 5000 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect((await api(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
  const cb = await api(admin, "POST", "/agents/admin/servers", { name: "W42F hop", slug: "wfhop", url: `http://127.0.0.1:${hopServer.port}/mcp`, authKind: "none", availability: "all", timeoutMs: 20000 });
  expect(cb.status).toBe(201);
  hopServerId = cb.body.server.id;
  expect((await api(admin, "POST", `/agents/admin/servers/${hopServerId}/sync`, {})).status).toBe(200);
  runWatch.intervalMs = 150;
});
beforeEach(() => { resetMcpLimits(); resetAgentRateLimitsForTests(); });
afterAll(async () => {
  runWatch.intervalMs = 2000;
  deleteServer(admin.userId, serverId);
  deleteServer(admin.userId, hopServerId);
  deleteProvider(admin.userId, providerId);
  await resetToolServersForTests();
  fake.stop();
  mcp.stop();
  hopServer.stop(true);
});

describe("R-M1: recursion across an HTTP hop (T318)", () => {
  test("(a) a Nook key is refused as a tool server's credential at save and edit, by shape or by hash", async () => {
    const owner = await createUser("W42F creds");
    const key = runKey(owner, [all("notes", "read")]);
    const refused = (input: Record<string, unknown>) => {
      try { createServer(admin.userId, { name: "Refused", url: mcp.url, availability: "all", ...input } as never); return "saved"; } catch (error) { return (error as { code?: string }).code; }
    };
    expect(refused({ authKind: "bearer", secret: key.token })).toBe("NOOK_KEY_REFUSED");
    expect(refused({ authKind: "header", authHeader: "X-Api-Key", secret: `Bearer ${key.token}` })).toBe("NOOK_KEY_REFUSED");
    expect(refused({ authKind: "bearer", secret: "nkv_somethingsomething" })).toBe("NOOK_KEY_REFUSED");
    // A token without the prefix whose hash is a Nook key's (a pasted key minus its prefix would not match; the full one does).
    const unprefixed = key.token.replace(/^mynotes_/, "");
    db.query("UPDATE mcp_api_keys SET token_hash = ? WHERE id = ?").run(new Bun.CryptoHasher("sha256").update(unprefixed).digest("hex"), key.id);
    expect(refused({ authKind: "bearer", secret: unprefixed })).toBe("NOOK_KEY_REFUSED");
    // Wrapped: Basic auth (either half), custom headers with odd Bearer spacing or casing, URL-encoded, base64url.
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const b64url = (text: string) => Buffer.from(text).toString("base64url");
    const wrapped = [
      { authKind: "header", authHeader: "Authorization", secret: `Basic ${b64(`user:${key.token}`)}` },
      { authKind: "header", authHeader: "Authorization", secret: `basic   ${b64(`${key.token}:x`)}` },
      { authKind: "header", authHeader: "Authorization", secret: `Basic ${b64("vault:nkv_abcdefghijklmnop")}` },
      { authKind: "header", authHeader: "X-Token", secret: `bEaReR\t\t${key.token}` },
      { authKind: "header", authHeader: "X-Token", secret: `BEARER:${key.token}` },
      { authKind: "header", authHeader: "X-Token", secret: `"Bearer ${key.token}"` },
      { authKind: "header", authHeader: "X-Token", secret: encodeURIComponent(`Bearer ${key.token}`) },
      { authKind: "header", authHeader: "X-Token", secret: `token%3D${key.token}` },
      { authKind: "header", authHeader: "X-Token", secret: b64url(`user:${key.token}`) },
      { authKind: "header", authHeader: "X-Token", secret: `Basic ${b64url(`${key.token}:?>?>`)}` },
      { authKind: "header", authHeader: "X-Token", secret: b64(`Basic ${b64(`u:${key.token}`)}`) },
      { authKind: "bearer", secret: b64(unprefixed) }
    ];
    for (const input of wrapped) expect({ secret: input.secret, code: refused(input) }).toEqual({ secret: input.secret, code: "NOOK_KEY_REFUSED" });
    // Ordinary wrapped credentials still save: Basic auth for a user, a base64 token, a percent-encoded one.
    for (const secret of [`Basic ${b64("svc-user:s3cret-pass")}`, b64("just-some-random-token-bytes"), "abc%2Fdef-123", "Bearer srv-own-token-456"]) {
      const saved = createServer(admin.userId, { name: "Wrapped fine", url: mcp.url, authKind: "header", authHeader: "Authorization", secret, availability: "all" } as never);
      deleteServer(admin.userId, saved.id);
    }
    // Over HTTP: 400 with the code and the field.
    const http = await api(admin, "POST", "/agents/admin/servers", { name: "Refused", url: mcp.url, authKind: "bearer", secret: key.token, availability: "all" });
    expect(http).toMatchObject({ status: 400, body: { code: "NOOK_KEY_REFUSED" } });
    // Edit: the same refusal; an ordinary credential saves.
    const row = serverRow(serverId);
    expect(() => updateServer(admin.userId, serverId, { expectedRevision: row.revision, authKind: "bearer", secret: "mynotes_abc" })).toThrow();
    expect(() => updateServer(admin.userId, serverId, { expectedRevision: row.revision, authKind: "header", authHeader: "Authorization", secret: `Basic ${Buffer.from(`me:${key.token}`).toString("base64")}` })).toThrow(expect.objectContaining({ code: "NOOK_KEY_REFUSED" }));
    const ok = createServer(admin.userId, { name: "Fine creds", url: mcp.url, authKind: "bearer", secret: "srv-own-credential-123", availability: "all" } as never);
    deleteServer(admin.userId, ok.id);
  });

  test("(b) outbound MCP calls carry Nook-Agent-Run; a run, run_agent over REST, and MCP run_agent refuse a request carrying it (409 AGENT_RECURSION)", async () => {
    const { person, agentId } = await ownerWithAgent("W42F hop", [{ source: "server", serverId: hopServerId, toolName: "callback", policy: null }]);
    const outer = runKey(person, [agentGrant(agentId)], "rest");
    const inner = runKey(person, [agentGrant(agentId)], "both");
    hop.token = inner.token;
    for (const target of ["rest", "tool", "mcp"] as const) {
      hop.target = target;
      hop.seen = [];
      hop.answers = [];
      const ran = await rest(outer.token, "POST", `/agents/${agentId}/runs`, { input: `tool:wfhop__callback:${JSON.stringify({ agentId })}` });
      expect(ran.body.status).toBe("ok");
      expect(hop.seen[0]).toBe(ran.body.runId);
      expect(hop.answers[0]!.status).toBe(409);
      expect(JSON.parse(hop.answers[0]!.body).code).toBe("AGENT_RECURSION");
    }
    // The inner key never started a run.
    expect((db.query("SELECT COUNT(*) AS count FROM agent_runs WHERE key_id = ?").get(inner.id) as { count: number }).count).toBe(0);
    // Without the header the same key runs (the hop is then bounded by the slots, documented in OPERATIONS).
    expect((await rest(inner.token, "POST", `/agents/${agentId}/runs`, { input: "echo:direct" })).body.status).toBe("ok");
    // An admin's sync (outside any run) sends no header.
    const syncs = mcp.calls.filter((call) => call.method === "tools/list");
    expect(syncs.every((call) => !("nook-agent-run" in call.headers))).toBe(true);
  });

  test("(c) agents:run never sits on a key linked as an agent's Nook key: link, narrow, and rotate refuse; the link list leaves it out", async () => {
    const { person, agentId } = await ownerWithAgent("W42F link");
    const runner = runKey(person, [all("notes", "read"), agentGrant(agentId)], "both");
    // Link: refused with a clear code; the sheet does not offer the key.
    const link = await api(person, "PUT", `/agents/${agentId}/link`, { nookKeyId: runner.id });
    expect(link).toMatchObject({ status: 409, body: { code: "KEY_RUNS_AGENTS" } });
    expect((await api(person, "GET", `/agents/${agentId}/link`)).body.keys.map((key: { id: string }) => key.id)).not.toContain(runner.id);
    // A plain key links; a link made before the rule (forced here) blocks narrowing that keeps agents:run and rotation that adds it.
    const plain = runKey(person, [all("notes", "read")], "both");
    expect((await api(person, "PUT", `/agents/${agentId}/link`, { nookKeyId: plain.id })).status).toBe(200);
    let code: unknown = null;
    try { rotateApiKey(person.userId, plain.id, 0, undefined, { grants: [{ module: "notes", permission: "read" }, { module: "agents", permission: "run" }] as never }); } catch (error) { code = error instanceof KeyError ? error.code : String(error); }
    expect(code).toBe("KEY_LINKED_TO_AGENT");
    db.query("UPDATE agent_user_links SET nook_key_id = ? WHERE agent_id = ? AND user_id = ?").run(runner.id, agentId, person.userId);
    code = null;
    try { narrowApiKey(person.userId, runner.id, { name: "Renamed" }); } catch (error) { code = error instanceof KeyError ? error.code : String(error); }
    expect(code).toBe("KEY_LINKED_TO_AGENT");
    // Narrowing that drops "Run agents" is allowed; and a linked key holding it gives the agent no Nook tools meanwhile.
    expect(narrowApiKey(person.userId, runner.id, { grants: [{ module: "notes", permission: "read" }] as never }).changed).toContain("grants");
  });

  test("(c) creating a key checks the rule too (a new key is never linked)", async () => {
    const person = await createUser("W42F create");
    expect(runKey(person, [all("agents", "run")]).id).toBeString();
  });
});

describe("R-L2: held plain runs take at most half of a surface's slots", () => {
  test("12 REST and 12 MCP held runs, then 503 AGENT_BUSY; release is idempotent", () => {
    expect(HELD_RUN_SLOTS).toEqual({ rest: 12, mcp: 12 });
    const releases = Array.from({ length: 12 }, () => holdPlainRun("rest"));
    let refused: unknown = null;
    try { holdPlainRun("rest"); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ status: 503, code: "AGENT_BUSY" });
    // The MCP pool is separate.
    const mcpRelease = holdPlainRun("mcp");
    expect(heldPlainRuns()).toEqual({ rest: 12, mcp: 1 });
    for (const release of releases) { release(); release(); }
    mcpRelease();
    expect(heldPlainRuns()).toEqual({ rest: 0, mcp: 0 });
  });

  test("AGENT_MAX_CONCURRENT_RUNS is at most 16", () => {
    const configPath = join(import.meta.dir, "..", "server", "config.ts");
    const load = (value: string) => Bun.spawnSync(["bun", "--no-env-file", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(config.agents.maxConcurrentRuns);`], {
      cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), AGENT_MAX_CONCURRENT_RUNS: value }, stdout: "pipe", stderr: "pipe"
    });
    expect(load("16").stdout.toString().trim()).toBe("16");
    const over = load("17");
    expect(over.exitCode).not.toBe(0);
    expect(over.stderr.toString()).toContain("AGENT_MAX_CONCURRENT_RUNS must be an integer between 1 and 16");
  });

  test("run_agent over MCP and REST holds a slot while it waits and gives it back", async () => {
    const { person, agentId } = await ownerWithAgent("W42F held");
    const key = runKey(person, [agentGrant(agentId)], "both");
    const pending = invokeMcpToolForTests("run_agent", { agentId, input: "slow:40:a b c d e" }, key.id);
    await waitFor(() => heldPlainRuns().mcp === 1);
    await pending;
    expect(heldPlainRuns()).toEqual({ rest: 0, mcp: 0 });
  });
});

describe("R-L3, R-L4, R-L5: labels, blank turns, run_agent's errors", () => {
  test("MCP run_agent labels follow the REST rule; blank turns are refused", async () => {
    const { person, agentId } = await ownerWithAgent("W42F label");
    const key = runKey(person, [agentGrant(agentId)], "both");
    for (const label of ["line one\nline two", "bell\u0007", "esc\u001b[31m", "sep x", "c1\u0085x"]) {
      expect(JSON.parse((await invokeMcpToolForTests("run_agent", { agentId, input: "echo:x", label }, key.id)).content[0]!.text).code).toBe("INVALID");
      expect((await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "echo:x", label })).body.code).toBe("INVALID");
    }
    expect(JSON.parse((await invokeMcpToolForTests("run_agent", { agentId, input: "echo:x", label: "  nightly  " }, key.id)).content[0]!.text).label).toBe("nightly");
    const blank = await rest(key.token, "POST", `/agents/${agentId}/runs`, { messages: [{ role: "assistant", content: " \n\t " }, { role: "user", content: "echo:ok" }] });
    expect(blank).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(blank.body.details.join(" ")).toContain("must not be blank");
  });

  test("errors map by code on /api/v1/tools/run_agent as on /api/v1/agents: 429 AGENT_BUSY per key or owner, 503 for a full instance", async () => {
    const { config } = await import("../server/config");
    const { person, agentId } = await ownerWithAgent("W42F codes");
    const key = runKey(person, [agentGrant(agentId)], "both");
    const a = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:60:a b c d e f g h" });
    const b = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:60:a b c d e f g h" });
    await waitFor(() => (db.query("SELECT COUNT(*) AS count FROM agent_runs WHERE key_id = ? AND status = 'running'").get(key.id) as { count: number }).count === 2);
    const viaTool = await rest(key.token, "POST", "/tools/run_agent", { agentId, input: "echo:x" });
    const viaRoute = await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "echo:x" });
    expect(viaTool).toMatchObject({ status: 429, body: { code: "AGENT_BUSY" } });
    expect(viaRoute).toMatchObject({ status: 429, body: { code: "AGENT_BUSY" } });
    expect(viaTool.headers.get("retry-after")).toBe("5");
    await Promise.all([a, b]);
    const saved = config.agents.maxConcurrentRuns;
    const { person: other, agentId: otherAgent } = await ownerWithAgent("W42F full");
    const otherKey = runKey(other, [agentGrant(otherAgent)], "both");
    const c = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:60:a b c d e f" });
    await waitFor(() => liveExternalRuns().length === 1);
    config.agents.maxConcurrentRuns = 1;
    try {
      expect(await rest(otherKey.token, "POST", "/tools/run_agent", { agentId: otherAgent, input: "echo:x" })).toMatchObject({ status: 503, body: { code: "AGENT_BUSY" } });
      const full = await rest(otherKey.token, "POST", `/agents/${otherAgent}/runs`, { input: "echo:x" });
      expect(full).toMatchObject({ status: 503, body: { code: "AGENT_BUSY" } });
      expect(full.headers.get("retry-after")).toBe("5");
      expect(JSON.parse((await invokeMcpToolForTests("run_agent", { agentId: otherAgent, input: "echo:x" }, otherKey.id)).content[0]!.text)).toMatchObject({ code: "AGENT_BUSY", scope: "instance" });
    } finally {
      config.agents.maxConcurrentRuns = saved;
    }
    await c;
  });
});

describe("Q-M1 and Q-M2: the right while a model call streams, and stopped steps are charged", () => {
  test("API: revoking the key during a slow stream ends the run KEY_INACTIVE with the partial output and its tokens", async () => {
    const { person, agentId } = await ownerWithAgent("W42F revoke");
    const key = runKey(person, [agentGrant(agentId)]);
    const started = Date.now();
    const pending = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: LONG });
    await waitFor(() => (db.query("SELECT first_token_at FROM agent_runs WHERE key_id = ?").get(key.id) as { first_token_at: string | null } | null)?.first_token_at != null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    revokeOwnKey(person.userId, key.id);
    const result = (await pending).body;
    // 60 words at 120 ms is 7 s; the run ends well before.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result).toMatchObject({ status: "error", error: { code: "KEY_INACTIVE" } });
    expect(result.output).toStartWith("word0 ");
    expect(result.output).not.toContain("word59");
    expect(result.usage.completionTokens).toBeGreaterThan(0);
    expect(result.usage.estimated).toBe(true);
    expect(runRow(result.runId)).toMatchObject({ status: "error", error_code: "KEY_INACTIVE" });
    expect(runRow(result.runId).completion_tokens).toBeGreaterThan(0);
    expect(keyTokens(key.id)).toBe(result.usage.promptTokens + result.usage.completionTokens);
    // The stopped step is in the timeline, and the output is kept.
    expect((db.query("SELECT COUNT(*) AS count FROM agent_audit_steps WHERE run_id = ? AND kind = 'model'").get(result.runId) as { count: number }).count).toBe(1);
    expect((db.query("SELECT output_text FROM agent_audit_entries WHERE run_id = ?").get(result.runId) as { output_text: string }).output_text).toBe(result.output);
  });

  test("API: cancel charges the partial step (nonzero tokens), so stream-and-cancel cannot skip the budgets", async () => {
    const { person, agentId } = await ownerWithAgent("W42F cancel");
    const key = runKey(person, [agentGrant(agentId)]);
    const response = await fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: LONG, stream: true }) });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const runId = /"runId":"([0-9a-f-]{36})"/.exec(first)![1]!;
    await waitFor(() => (db.query("SELECT first_token_at FROM agent_runs WHERE id = ?").get(runId) as { first_token_at: string | null }).first_token_at !== null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await rest(key.token, "POST", `/agents/${agentId}/runs/${runId}/cancel`, {})).body).toEqual({ status: "cancelled" });
    let text = first;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const events = parseSse(text);
    const done = events.find((event) => event.type === "done")!.data;
    expect(done.status).toBe("cancelled");
    expect(done.usage.promptTokens + done.usage.completionTokens).toBeGreaterThan(0);
    expect(runRow(runId).completion_tokens).toBeGreaterThan(0);
    expect(keyTokens(key.id)).toBeGreaterThan(0);
    // The stopped step's usage event went out before done.
    expect(events.map((event) => event.type).slice(-2)).toEqual(["usage", "done"]);
  });

  test("chat: Stop charges the partial step; the message and the run carry its tokens", async () => {
    const { person, agentId } = await ownerWithAgent("W42F stop");
    const chat = (await api(person, "POST", "/chats", { agentId })).body.chat as { id: string };
    const before = userChatTokens(person.userId);
    const sent = await api(person, "POST", `/chats/${chat.id}/messages`, { content: LONG });
    expect(sent.status).toBe(201);
    await waitFor(() => (db.query("SELECT first_token_at FROM agent_runs WHERE id = ?").get(sent.body.runId) as { first_token_at: string | null }).first_token_at !== null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await api(person, "POST", `/runs/${sent.body.runId}/cancel`, {})).status).toBe(200);
    await waitFor(() => runRow(sent.body.runId).status === "cancelled");
    expect(runRow(sent.body.runId).completion_tokens).toBeGreaterThan(0);
    const message = db.query("SELECT status, content, usage_json FROM chat_messages WHERE id = ?").get(sent.body.assistantMessage.id) as { status: string; content: string; usage_json: string | null };
    expect(message.status).toBe("cancelled");
    expect(message.content).toStartWith("word0");
    expect(JSON.parse(message.usage_json!).completionTokens).toBeGreaterThan(0);
    expect(userChatTokens(person.userId)).toBeGreaterThan(before);
  });

  test("chat: losing chat rights during a slow stream ends the answer ACCESS_REVOKED with the partial text", async () => {
    const { person, agentId } = await ownerWithAgent("W42F demote");
    const chat = (await api(person, "POST", "/chats", { agentId })).body.chat as { id: string };
    const sent = await api(person, "POST", `/chats/${chat.id}/messages`, { content: LONG });
    await waitFor(() => (db.query("SELECT first_token_at FROM agent_runs WHERE id = ?").get(sent.body.runId) as { first_token_at: string | null }).first_token_at !== null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(person.userId);
    try {
      await waitFor(() => runRow(sent.body.runId).status !== "running", 4000);
      expect(runRow(sent.body.runId)).toMatchObject({ status: "error", error_code: "ACCESS_REVOKED" });
      expect(runRow(sent.body.runId).completion_tokens).toBeGreaterThan(0);
      const message = db.query("SELECT status, content, error_code FROM chat_messages WHERE id = ?").get(sent.body.assistantMessage.id) as { status: string; content: string; error_code: string };
      expect(message).toMatchObject({ status: "error", error_code: "ACCESS_REVOKED" });
      expect(message.content).toStartWith("word0");
      expect(message.content).not.toContain("word59");
    } finally {
      db.query("UPDATE users SET role = 'member' WHERE id = ?").run(person.userId);
    }
  });
});

describe("Q-L6, Q-L7, Q-L8", () => {
  test("SSE order: run, delta…, usage, done", async () => {
    const { person, agentId } = await ownerWithAgent("W42F order");
    const key = runKey(person, [agentGrant(agentId)]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: "echo:one two three four five", stream: true }) });
      const types = parseSse(await response.text()).map((event) => event.type);
      expect(types[0]).toBe("run");
      expect(types.at(-1)).toBe("done");
      expect(types.at(-2)).toBe("usage");
      expect(types.slice(1, -2).every((type) => type === "delta")).toBe(true);
      expect(types.length).toBeGreaterThan(3);
    }
  });

  test("an API run whose model calls a tool none was offered ends with the reason, kept in the Audit log", async () => {
    const { person, agentId } = await ownerWithAgent("W42F nothing offered");
    const key = runKey(person, [agentGrant(agentId)]);
    const result = (await rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "tool:wftools__echo:{}" })).body;
    expect(result.status).toBe("ok");
    expect(result.output).toContain("no tools were available to it here");
    expect(result.output).toContain("Over the API and MCP an agent gets only the tools that run on their own");
    expect((db.query("SELECT output_text FROM agent_audit_entries WHERE run_id = ?").get(result.runId) as { output_text: string }).output_text).toContain("no tools were available");
  });

  test("API runs that fill the owner's slots: the chat says runs (chats or API), not chats", async () => {
    const { person, agentId } = await ownerWithAgent("W42F shared slots");
    const key = runKey(person, [agentGrant(agentId)]);
    const a = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:60:a b c d e f g h", stream: false });
    const b = rest(key.token, "POST", `/agents/${agentId}/runs`, { input: "slow:60:a b c d e f g h" });
    await waitFor(() => (db.query("SELECT COUNT(*) AS count FROM agent_runs WHERE key_id = ? AND status = 'running'").get(key.id) as { count: number }).count === 2);
    const chat = (await api(person, "POST", "/chats", { agentId })).body.chat as { id: string };
    const sent = await api(person, "POST", `/chats/${chat.id}/messages`, { content: "echo:hi" });
    expect(sent).toMatchObject({ status: 429, body: { code: "AGENT_BUSY" } });
    expect(sent.body.error).toContain("You have 2 runs going (chats or API)");
    await Promise.all([a, b]);
  });
});

describe("Q-M3: the Audit log's facets", () => {
  test("own keys and agents without runs; admins get other people's keys and agents as names only", async () => {
    const { person, agentId } = await ownerWithAgent("W42F facets");
    const idle = (await api(person, "POST", "/agents", { name: "Idle agent", providerId })).body.agent.id as string;
    const used = runKey(person, [agentGrant(agentId)]);
    const unused = runKey(person, [all("agents", "run")]);
    runKey(person, [all("notes", "read")]);
    const ran = await rest(used.token, "POST", `/agents/${agentId}/runs`, { input: "echo:FACET-SECRET", label: "FACET-LABEL" });
    expect(ran.body.status).toBe("ok");
    const mine = (await api(person, "GET", "/agents/audit/facets")).body.facets;
    expect(mine.keys.map((key: { id: string }) => key.id).sort()).toEqual([used.id, unused.id].sort());
    expect(mine.agents.map((agent: { id: string }) => agent.id).sort()).toEqual([agentId, idle].sort());
    expect(mine.keys.every((key: { own: boolean }) => key.own)).toBe(true);
    // A key with no runs filters to an empty page, not an error.
    expect((await api(person, "GET", `/agents/audit?key=${unused.id}`)).body.runs).toEqual([]);
    const theirs = (await api(admin, "GET", "/agents/audit/facets")).body.facets;
    const seen = theirs.keys.find((key: { id: string }) => key.id === used.id);
    expect(seen).toMatchObject({ name: "Fixes", own: false, ownerName: "W42F facets" });
    expect(theirs.keys.some((key: { id: string }) => key.id === unused.id)).toBe(false);
    expect(theirs.agents.find((agent: { id: string }) => agent.id === agentId)).toMatchObject({ name: "W42F facets agent", own: false });
    expect(JSON.stringify(theirs)).not.toContain("FACET-SECRET");
    expect(JSON.stringify(theirs)).not.toContain("FACET-LABEL");
    // Another member sees none of it.
    const stranger = await createUser("W42F stranger");
    expect((await api(stranger, "GET", "/agents/audit/facets")).body.facets).toEqual({ keys: [], agents: [] });
  });
});

describe("AC-B verification M2: the live re-check says why", () => {
  test("a linked key that lost inbox:write before a pending proposal runs: SCOPE_REQUIRED naming the scope", async () => {
    const { liveToolFailure } = await import("../server/agents/tools");
    const person = await createUser("W42F scope");
    const key = runKey(person, [all("tasks", "read"), all("inbox", "write")], "both");
    const created = await api(person, "POST", "/agents", { name: "Proposer", providerId, tools: [{ source: "nook", toolName: "create_card" }] });
    const agentId = created.body.agent.id as string;
    expect((await api(person, "PUT", `/agents/${agentId}/link`, { nookKeyId: key.id })).status).toBe(200);
    const identity = { kind: "nook" as const, toolName: "create_card", mode: "proposal" as const, keyId: key.id };
    narrowApiKey(person.userId, key.id, { grants: [{ module: "tasks", permission: "read" }] as never });
    expect(liveToolFailure(agentId, person.userId, identity)).toMatchObject({ code: "SCOPE_REQUIRED", scope: "inbox:write" });
    revokeOwnKey(person.userId, key.id);
    expect(liveToolFailure(agentId, person.userId, identity).code).toBe("KEY_INACTIVE");
    expect(liveToolFailure(agentId, person.userId, { kind: "server", serverId, toolName: "echo", revision: 1 }).code).toBe("TOOL_UNAVAILABLE");
  });
});
