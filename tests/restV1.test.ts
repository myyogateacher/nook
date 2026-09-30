import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createApiKey, flushKeyUsage } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTodayRateLimit } = await import("../server/today/rateLimit");
const { DEFAULT_POLICIES, policiesRevision, resetPoliciesForTests, writePolicies } = await import("../server/team/policies");
const { REST_STATUS } = await import("../server/restV1");
type Grant = import("../server/keyGrants").Grant;

/**
 * The REST surface `/api/v1` (Wave 34, access plan D280, T210): Bearer keys only, the same tool
 * definitions as MCP through the same runTool, surfaces and `rest_roles` checked per call, JSON only,
 * no CORS, keys never in URLs, per-surface limits and usage, and identical results on both surfaces.
 */

beforeEach(() => { resetMcpLimits(); resetTodayRateLimit(); });
afterEach(() => resetPoliciesForTests());

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
function key(session: Session, grants: Grant[], surfaces: "mcp" | "rest" | "both" = "rest") {
  return createApiKey(session.userId, { name: `REST ${surfaces}`, surfaces, grants, expiresInDays: 30 });
}

async function rest(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] ??= "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${origin}/api/v1${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

let rpcId = 0;
async function mcpToolNames(token: string) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return ((JSON.parse(json) as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name).sort();
}

async function tasksApi(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return (await response.json()) as Record<string, any>;
}

function setPolicies(actorId: string, patch: Partial<typeof DEFAULT_POLICIES>) {
  writePolicies(actorId, { ...DEFAULT_POLICIES, ...patch }, policiesRevision());
}

describe("REST v1: authentication and transport", () => {
  test("GET /me describes the key and its owner without secrets; cookies, missing keys, and keys in URLs are refused", async () => {
    const owner = await createUser("REST me");
    const created = key(owner, [all("notes", "read"), all("tasks", "write")]);
    const me = await rest(created.token, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.key).toMatchObject({ id: created.id, prefix: created.prefix, surfaces: "rest", kind: "general", ipRestricted: false });
    expect(me.body.owner).toEqual({ id: owner.userId, displayName: "REST me", role: "member" });
    expect(me.body.grants).toEqual(expect.arrayContaining([{ module: "notes", permission: "read", resource: null }]));
    expect(me.body.limits.perKey.callsPerMinute).toBe(120);
    expect(me.text).not.toContain(created.token);
    expect(me.text).not.toMatch(/token_hash|[0-9a-f]{64}/);
    expect(me.headers.get("cache-control")).toContain("no-store");
    expect(me.headers.get("access-control-allow-origin")).toBeNull();

    expect((await rest(null, "GET", "/me")).status).toBe(401);
    // A session cookie is never a credential here.
    const cookieOnly = await fetch(`${origin}/api/v1/me`, { headers: { Cookie: owner.cookie } });
    expect(cookieOnly.status).toBe(401);
    // A key in the URL is refused before anything else, with advice to revoke it.
    const inUrl = await rest(null, "GET", `/me?api_key=${created.token}`);
    expect(inUrl).toMatchObject({ status: 400, body: { code: "KEY_IN_URL" } });
    expect(inUrl.text).not.toContain(created.token);
    expect((await rest(created.token, "GET", `/tools?x=${created.token}`)).body.code).toBe("KEY_IN_URL");
    // Other sites' origins are refused; there are no CORS preflights.
    expect((await rest(created.token, "GET", "/me", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    const preflight = await rest(null, "OPTIONS", "/tools/list_notes", undefined, { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect((await rest(created.token, "GET", "/nothing")).status).toBe(404);
    expect((await rest(created.token, "POST", "/me", {})).status).toBe(405);
  });

  test("a key works on REST only with the REST surface and a role in rest_roles, checked per call (D279, O-A8)", async () => {
    const admin = await createUser("REST roles admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const member = await createUser("REST roles member");
    const mcpOnly = key(member, [all("notes", "read")], "mcp");
    expect(await rest(mcpOnly.token, "GET", "/me")).toMatchObject({ status: 403, body: { code: "KEY_POLICY" } });
    const both = key(member, [all("notes", "read")], "both");
    expect((await rest(both.token, "GET", "/me")).status).toBe(200);
    setPolicies(admin.userId, { restRoles: ["admin"] });
    expect(await rest(both.token, "GET", "/me")).toMatchObject({ status: 403, body: { code: "KEY_POLICY" } });
    expect((await rest(both.token, "POST", "/tools/list_notes", {})).status).toBe(403);
    // MCP still works for the same key: the policy blocks one surface.
    expect(await mcpToolNames(both.token)).toContain("list_notes");
  });

  test("JSON only: content type, a JSON object body, and unknown or hidden tools look missing", async () => {
    const owner = await createUser("REST json");
    const created = key(owner, [all("notes", "read")]);
    expect((await rest(created.token, "POST", "/tools/list_notes", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await rest(created.token, "POST", "/tools/list_notes", "not json")).body.code).toBe("INVALID_JSON");
    expect((await rest(created.token, "POST", "/tools/list_notes", "[1]")).body.code).toBe("INVALID_JSON");
    expect((await rest(created.token, "POST", "/tools/list_notes", {})).status).toBe(200);
    expect((await rest(created.token, "POST", "/tools/no_such_tool", {})).status).toBe(404);
    // A real tool this key cannot use is the same 404 (no tool oracle).
    expect(await rest(created.token, "POST", "/tools/create_card", {})).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect((await rest(created.token, "POST", "/tools/list_notes", { unknownArgument: true })).status).toBe(200);
  });

  test("a viewer's REST key runs no write tool", async () => {
    const admin = await createUser("REST viewer admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    setPolicies(admin.userId, { restRoles: ["admin", "member", "viewer"] });
    const viewer = await createUser("REST viewer");
    const created = key(viewer, [all("tasks", "write"), all("notes", "draft"), all("calendar", "write")]);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    const tools = (await rest(created.token, "GET", "/tools")).body.tools as Array<{ name: string; write: boolean }>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((tool) => tool.write)).toEqual([]);
    for (const spec of mcpToolSpecs.filter((item) => item.write)) expect((await rest(created.token, "POST", `/tools/${spec.name}`, {})).status).toBeGreaterThanOrEqual(400);
  });
});

describe("REST v1: parity with MCP", () => {
  test("GET /tools lists exactly the MCP tools, with JSON input schemas", async () => {
    const owner = await createUser("REST tools");
    const created = key(owner, [all("notes", "read"), all("tasks", "write"), all("calendar", "read"), all("inbox", "write"), all("today", "read")], "both");
    const listed = (await rest(created.token, "GET", "/tools")).body.tools as Array<{ name: string; inputSchema: { type: string; properties?: Record<string, unknown> } }>;
    expect(listed.map((tool) => tool.name).sort()).toEqual(await mcpToolNames(created.token));
    const createCard = listed.find((tool) => tool.name === "create_card")!;
    expect(createCard.inputSchema.type).toBe("object");
    expect(Object.keys(createCard.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["boardId", "columnId", "title"]));
  });

  test("every tool gives the same result through MCP and REST (empty arguments, and real reads)", async () => {
    const owner = await createUser("REST parity");
    const board = await tasksApi(owner, "POST", "/boards", { name: "Parity board" });
    const boardId = board.board.id as string;
    const columnId = (board.columns as Array<{ id: string }>)[0]!.id;
    const card = (await tasksApi(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Parity card" })).card as { id: string };
    const grants: Grant[] = ["notes", "files", "tasks", "calendar", "collections", "inbox", "whiteboards"].flatMap((module) => [all(module as Grant["module"], "read")]);
    grants.push(all("today", "read"), all("tasks", "write"), all("notes", "draft"), all("notes", "publish"), all("files", "write"), all("calendar", "write"), all("collections", "write"), all("inbox", "write"), all("whiteboards", "write"), all("bin", "write"));
    const created = key(owner, grants, "both");
    const volatile = (text: string) => text.replace(/"(generatedAt|expiresAt|uploadId|uploadUrl)":"[^"]*"/g, "\"$1\":\"…\"");
    // Every tool with empty arguments: the same body and the status its code maps to.
    const context = loadLiveKey(created.id)!;
    for (const spec of mcpToolSpecs) {
      resetMcpLimits();
      const viaRest = await rest(created.token, "POST", `/tools/${spec.name}`, {});
      // A tool the key cannot see is not offered on either surface (MCP does not register it).
      if (!toolVisible(spec, context)) {
        expect({ tool: spec.name, status: viaRest.status }).toEqual({ tool: spec.name, status: 404 });
        continue;
      }
      const viaMcp = await invokeMcpToolForTests(spec.name, {}, created.id, "mcp");
      const mcpBody = JSON.parse(viaMcp.content[0]!.text) as Record<string, unknown>;
      if (viaMcp.isError) {
        expect({ tool: spec.name, status: viaRest.status }).toEqual({ tool: spec.name, status: REST_STATUS[mcpBody.code as keyof typeof REST_STATUS] ?? 400 });
        expect({ tool: spec.name, body: viaRest.body }).toEqual({ tool: spec.name, body: mcpBody });
      } else if (!spec.write) {
        expect({ tool: spec.name, status: viaRest.status }).toEqual({ tool: spec.name, status: 200 });
        expect({ tool: spec.name, body: volatile(JSON.stringify(viaRest.body)) }).toEqual({ tool: spec.name, body: volatile(JSON.stringify(mcpBody)) });
      }
    }
    // Real reads with arguments.
    for (const [name, args] of [["list_cards", { boardId }], ["get_card", { cardId: card.id }], ["search_cards", { query: "Parity" }], ["query_cards", { filter: "" }]] as const) {
      const viaMcp = JSON.parse((await invokeMcpToolForTests(name, args, created.id, "mcp")).content[0]!.text);
      const viaRest = await rest(created.token, "POST", `/tools/${name}`, args);
      expect({ name, status: viaRest.status }).toEqual({ name, status: 200 });
      expect(viaRest.body).toEqual(viaMcp);
    }
  });

  test("writes through REST are audited as rest, counted per surface, and limited per surface", async () => {
    const owner = await createUser("REST writes");
    const board = await tasksApi(owner, "POST", "/boards", { name: "Audit board" });
    const created = key(owner, [all("tasks", "write")], "both");
    const made = await rest(created.token, "POST", "/tools/create_card", { boardId: board.board.id, columnId: board.columns[0].id, title: "Via REST" });
    expect(made.status).toBe(200);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'task.card_create' AND metadata_json LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${created.id}%`) as { metadata_json: string } | null;
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ via: "rest", keyId: created.id });
    flushKeyUsage();
    const rows = db.query("SELECT surface, calls + writes AS used FROM api_key_surface_usage WHERE key_id = ? ORDER BY surface").all(created.id);
    expect(rows).toEqual([{ surface: "rest", used: 1 }]);
    expect((db.query("SELECT last_used_rest_at, last_used_mcp_at FROM mcp_api_keys WHERE id = ?").get(created.id) as { last_used_rest_at: string | null; last_used_mcp_at: string | null }).last_used_rest_at).not.toBeNull();

    // A key's lower limit is per surface: REST runs out, MCP still has its own minute.
    db.query("UPDATE mcp_api_keys SET limits_json = ? WHERE id = ?").run(JSON.stringify({ callsPerMinute: 2 }), created.id);
    resetMcpLimits();
    expect((await rest(created.token, "POST", "/tools/list_boards", {})).status).toBe(200);
    expect((await rest(created.token, "POST", "/tools/list_boards", {})).status).toBe(200);
    const limited = await rest(created.token, "POST", "/tools/list_boards", {});
    expect(limited).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const viaMcp = await invokeMcpToolForTests("list_boards", {}, created.id, "mcp");
    expect(viaMcp.content[0]!.text).not.toContain("error");
  });
});
