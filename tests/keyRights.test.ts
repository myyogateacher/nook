import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { DEFAULT_POLICIES, resetPoliciesForTests, writePolicies, policiesRevision } = await import("../server/team/policies");
type Grant = import("../server/keyGrants").Grant;
type Policies = import("../server/team/policies").Policies;

/**
 * The rights check (access plan §C.10, D263, D281, T201–T203, T209): effective = grants ∩ the
 * owner's current role ∩ org policy, recomputed on every call; tools/list and tools/call both use
 * it; chosen-item grants reach only tools that declare their resource, inside those items.
 */

beforeEach(() => resetMcpLimits());
afterEach(() => resetPoliciesForTests());

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });

function key(session: Session, grants: Grant[], options: { expiresInDays?: number | null; name?: string } = {}) {
  const created = createApiKey(session.userId, { name: options.name ?? "Agent", surfaces: "mcp", grants, expiresInDays: options.expiresInDays === undefined ? 90 : options.expiresInDays });
  return { id: created.id, token: created.token };
}

let rpcId = 0;
async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return { status: 200, body: JSON.parse(json) as { result?: { tools?: Array<{ name: string }> } } };
}
const toolNames = async (token: string) => (((await rpc(token, "tools/list")).body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name).sort();
async function call(keyId: string, name: string, args: Record<string, unknown> = {}) {
  const result = await invokeMcpToolForTests(name, args, keyId);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
async function tasksApi(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function board(owner: Session, name: string) {
  const created = await tasksApi(owner, "POST", "/boards", { name });
  const boardId = created.body.board.id as string;
  const columnId = (created.body.columns as Array<{ id: string }>)[0]!.id;
  const card = (await tasksApi(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: `${name} card` })).body.card as { id: string };
  return { boardId, columnId, cardId: card.id };
}

function setPolicies(actorId: string, patch: Partial<Policies>) {
  writePolicies(actorId, { ...DEFAULT_POLICIES, ...patch }, policiesRevision());
}

const NOTES_READ = ["list_folders", "list_notes", "read_note", "search_notes"];

describe("Nook key rights", () => {
  test("tools/list follows grants: notes:read plus tasks:write over all boards shows exactly those tools", async () => {
    const owner = await createUser("Rights grants");
    const created = key(owner, [all("notes", "read"), all("tasks", "write")]);
    const names = await toolNames(created.token);
    const expected = mcpToolSpecs.filter((spec) => spec.scopes.some((scope) => ["notes:read", "tasks:read", "tasks:write"].includes(scope))
      && (spec.alsoRequires ?? []).every((scope) => ["notes:read", "tasks:read", "tasks:write"].includes(scope))).map((spec) => spec.name).sort();
    expect(names).toEqual(expected);
    for (const tool of NOTES_READ) expect(names).toContain(tool);
    for (const tool of ["list_boards", "create_card", "move_card", "comment_on_card"]) expect(names).toContain(tool);
    for (const tool of ["bin_card", "create_note", "list_documents", "list_calendars", "query_rows", "get_today"]) expect(names).not.toContain(tool);
  });

  test("a key limited to one board sees only tools that name a board, and only inside it (D281, T203)", async () => {
    const owner = await createUser("Rights selector");
    const a = await board(owner, "Board A");
    const b = await board(owner, "Board B");
    const scoped = key(owner, [on("tasks", "write", "board", a.boardId), all("notes", "read")]);
    const names = await toolNames(scoped.token);
    for (const tool of ["list_boards", "list_cards", "get_card", "create_card", "update_card", "move_card", "comment_on_card", "list_sprints"]) expect(names).toContain(tool);
    // Tools that reach across boards (or into Files) stay hidden until Wave 34 filters them.
    for (const tool of ["search_cards", "link_cards", "link_attachment"]) expect(names).not.toContain(tool);
    expect(names).toEqual(expect.arrayContaining(NOTES_READ));

    const boards = await call(scoped.id, "list_boards");
    expect(boards.value.boards.map((item: { id: string }) => item.id)).toEqual([a.boardId]);
    expect((await call(scoped.id, "list_cards", { boardId: a.boardId })).isError).toBe(false);
    const outside = await call(scoped.id, "list_cards", { boardId: b.boardId });
    expect(outside).toMatchObject({ isError: true, value: { code: "NOT_FOUND" } });
    expect((await call(scoped.id, "get_card", { cardId: b.cardId })).value.code).toBe("NOT_FOUND");
    expect((await call(scoped.id, "get_card", { cardId: a.cardId })).value.card.id).toBe(a.cardId);
    expect((await call(scoped.id, "create_card", { boardId: b.boardId, columnId: b.columnId, title: "Nope" })).value.code).toBe("NOT_FOUND");
    expect((await call(scoped.id, "create_card", { boardId: a.boardId, columnId: a.columnId, title: "Yes" })).isError).toBe(false);
    expect((await call(scoped.id, "comment_on_card", { cardId: b.cardId, body: "x" })).value.code).toBe("NOT_FOUND");
    // A hidden tool reached directly is refused by the handler check too.
    expect((await call(scoped.id, "search_cards", { query: "card" })).value.code).toBe("SCOPE_REQUIRED");
    // A missing card id looks exactly like one outside the grant.
    expect((await call(scoped.id, "get_card", { cardId: crypto.randomUUID() })).value.code).toBe("NOT_FOUND");
  });

  test("losing access to a granted board makes the grant dead weight on the next call (T202)", async () => {
    const owner = await createUser("Rights lost owner");
    const member = await createUser("Rights lost member");
    const shared = await board(owner, "Shared board");
    expect((await tasksApi(owner, "PUT", `/boards/${shared.boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
    const memberKey = key(member, [on("tasks", "read", "board", shared.boardId)]);
    expect((await call(memberKey.id, "list_cards", { boardId: shared.boardId })).isError).toBe(false);
    expect((await tasksApi(owner, "PUT", `/boards/${shared.boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect((await call(memberKey.id, "list_cards", { boardId: shared.boardId })).value.code).toBe("NOT_FOUND");
    expect((await call(memberKey.id, "list_boards")).value.boards).toEqual([]);
  });

  test("a maximum lifetime blocks a longer key at call time with KEY_POLICY, and loosening it restores the key (T209)", async () => {
    const admin = await createUser("Rights policy admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const member = await createUser("Rights policy member");
    const long = key(member, [all("notes", "read")], { expiresInDays: 90 });
    const short = key(member, [all("notes", "read")], { expiresInDays: 20 });
    expect((await rpc(long.token, "tools/list")).status).toBe(200);
    setPolicies(admin.userId, { keyMaxDays: 30, keyDefaultDays: 30 });
    const blocked = await rpc(long.token, "tools/list");
    expect(blocked).toEqual({ status: 403, body: { error: expect.stringContaining("longer than team policy allows"), code: "KEY_POLICY" } });
    expect((await call(long.id, "list_notes")).value.code).toBe("KEY_POLICY");
    expect((await rpc(short.token, "tools/list")).status).toBe(200);
    // Blocked, not revoked.
    expect(db.query("SELECT revoked_at FROM mcp_api_keys WHERE id = ?").get(long.id)).toEqual({ revoked_at: null });
    // One policy_blocked event per key per day.
    await rpc(long.token, "tools/list");
    expect((db.query("SELECT COUNT(*) AS count FROM access_events WHERE key_id = ? AND action = 'key.policy_blocked'").get(long.id) as { count: number }).count).toBe(1);
    setPolicies(admin.userId, { keyMaxDays: 365 });
    expect((await rpc(long.token, "tools/list")).status).toBe(200);
  });

  test("require-expiry blocks keys without an expiry; MCP per role blocks a role; modules per role narrow grants", async () => {
    const admin = await createUser("Rights require admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const member = await createUser("Rights require member");
    const forever = key(member, [all("notes", "read"), all("tasks", "read")], { expiresInDays: null });
    expect((await rpc(forever.token, "tools/list")).status).toBe(200);
    setPolicies(admin.userId, { keyRequireExpiry: true });
    expect((await rpc(forever.token, "tools/list")).body).toMatchObject({ code: "KEY_POLICY" });
    setPolicies(admin.userId, { keyRequireExpiry: false, mcpRoles: ["admin"] });
    expect((await rpc(forever.token, "tools/list")).body).toMatchObject({ code: "KEY_POLICY" });
    setPolicies(admin.userId, { keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["notes"] } });
    const names = await toolNames(forever.token);
    expect(names).toEqual(NOTES_READ);
    expect((await call(forever.id, "list_boards")).value.code).toBe("SCOPE_REQUIRED");
  });

  test("expired keys and keys past their rotation grace stop at once (401)", async () => {
    const owner = await createUser("Rights expiry");
    const expired = key(owner, [all("notes", "read")]);
    db.query("UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.id);
    expect(await rpc(expired.token, "tools/list")).toEqual({ status: 401, body: { error: "This API key has expired" } });
    expect((await call(expired.id, "list_notes")).value.code).toBe("SCOPE_REQUIRED");
    const rotated = key(owner, [all("notes", "read")]);
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), rotated.id);
    expect((await rpc(rotated.token, "tools/list")).status).toBe(401);
  });

  test("a key's own lower limit applies before the global one (D282, T216)", async () => {
    const owner = await createUser("Rights limits");
    const limited = key(owner, [all("notes", "read")]);
    db.query("UPDATE mcp_api_keys SET limits_json = ? WHERE id = ?").run(JSON.stringify({ callsPerMinute: 2 }), limited.id);
    expect((await call(limited.id, "list_notes")).isError).toBe(false);
    expect((await call(limited.id, "list_notes")).isError).toBe(false);
    expect((await call(limited.id, "list_notes")).value.code).toBe("RATE_LIMITED");
    // A higher "limit" is ignored: only lower limits count.
    const raised = key(owner, [all("notes", "read")]);
    db.query("UPDATE mcp_api_keys SET limits_json = ? WHERE id = ?").run(JSON.stringify({ callsPerMinute: 100000 }), raised.id);
    for (let index = 0; index < 5; index += 1) expect((await call(raised.id, "list_notes")).isError).toBe(false);
  });

  test("a demoted owner's key loses what the new role cannot use, even with grants stored (T81, T201)", async () => {
    const owner = await createUser("Rights demoted");
    const writer = key(owner, [all("tasks", "write"), all("notes", "read")]);
    expect(await toolNames(writer.token)).toContain("create_card");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    const names = await toolNames(writer.token);
    expect(names).not.toContain("create_card");
    expect(names).toContain("list_boards");
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(owner.userId);
  });

  test("toolVisible never offers a tool without a declared resource to a chosen-items key", () => {
    const grants = [on("tasks", "write", "board", crypto.randomUUID()), on("collections", "write", "collection", crypto.randomUUID()), on("calendar", "write", "calendar", crypto.randomUUID())];
    const context = { keyId: "k", userId: "u", name: "k", scopes: ["tasks:read", "tasks:write", "collections:read", "collections:write", "calendar:read", "calendar:write"] as never, grants };
    for (const spec of mcpToolSpecs) {
      if (!toolVisible(spec, context)) continue;
      expect({ name: spec.name, declared: Boolean(spec.resource || spec.listFilter) }).toEqual({ name: spec.name, declared: true });
    }
  });

  test("no MCP tool manages keys, grants, policies, or access (D265)", () => {
    for (const spec of mcpToolSpecs) expect(spec.name).not.toMatch(/key|grant|polic|access|token|permission/);
  });
});
