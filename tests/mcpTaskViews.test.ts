import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTaskQueryRateLimit, TASK_QUERY_RATE_LIMIT } = await import("../server/tasks/queryRoutes");
type McpScope = import("../server/mcpScopes").McpScope;

/** MCP `list_views` and `query_cards` (research 2026-09-26 §10.5, D145, T115, T116). */

beforeEach(() => { resetMcpLimits(); resetTaskQueryRateLimit(); });

type Key = { id: string; token: string; userId: string };
const makeKey = (session: Session, scopes: McpScope[]): Key => {
  const key = createMcpApiKey(session.userId, "View agent", scopes);
  return { id: key.id, token: key.token, userId: session.userId };
};

let rpcId = 0;
async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
}

async function callTool(key: Key, name: string, args: Record<string, unknown> = {}) {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, value: { error: body.error.message } as Record<string, any> };
  const text = body.result!.content![0]!.text;
  let value: Record<string, any>;
  try { value = JSON.parse(text); } catch { value = { error: text }; }
  return { isError: body.result!.isError === true, value };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const ours = new Set<string>();
const titles = (value: Record<string, any>) => (value.cards as Array<{ title: string; board_id: string }>).filter((card) => ours.has(card.board_id)).map((card) => card.title).sort();

async function world(label: string) {
  const alice = await createUser(`${label} Alice`);
  const bob = await createUser(`${label} Bob`);
  const privateBoard = await api(alice, "POST", "/boards", { name: `${label} Private` });
  const sharedBoard = await api(alice, "POST", "/boards", { name: `${label} Shared` });
  ours.add(privateBoard.body.board.id);
  ours.add(sharedBoard.body.board.id);
  await api(alice, "PUT", `/boards/${sharedBoard.body.board.id}/sharing`, { visibility: "selected", userIds: [bob.userId] });
  await api(alice, "POST", `/boards/${privateBoard.body.board.id}/cards`, { columnId: privateBoard.body.columns[0].id, title: "Private plan", assigneeIds: [alice.userId] });
  const shared = await api(alice, "POST", `/boards/${sharedBoard.body.board.id}/cards`, { columnId: sharedBoard.body.columns[1].id, title: "Shared plan", assigneeIds: [alice.userId, bob.userId], dueOn: "2026-10-01" });
  db.query("UPDATE cards SET priority = 'urgent' WHERE id = ?").run(shared.body.card.id);
  const view = await api(alice, "POST", "/views", { name: `${label} everything`, query: `board:${privateBoard.body.board.id},${sharedBoard.body.board.id}`, display: { sort: "title" } });
  return { alice, bob, privateBoardId: privateBoard.body.board.id as string, sharedBoardId: sharedBoard.body.board.id as string, viewId: view.body.view.id as string };
}

describe("MCP list_views and query_cards", () => {
  test("listed only with a tasks scope and re-checked in the handler", async () => {
    const user = await createUser("View scopes");
    const reader = makeKey(user, ["tasks:read"]);
    const names = ((await rpc(reader, "tools/list")).result!.tools!).map((tool) => tool.name);
    expect(names).toContain("list_views");
    expect(names).toContain("query_cards");
    const notes = makeKey(user, ["notes:read"]);
    const notesNames = ((await rpc(notes, "tools/list")).result!.tools!).map((tool) => tool.name);
    expect(notesNames).not.toContain("list_views");
    expect(notesNames).not.toContain("query_cards");
    for (const name of ["list_views", "query_cards"]) {
      const direct = await invokeMcpToolForTests(name, { filter: "" }, notes.id);
      expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
    }
  });

  test("query_cards runs as the key's user with the shared grammar, bounds, and restricted refs (T115, T116)", async () => {
    const w = await world("Agent");
    const aliceKey = makeKey(w.alice, ["tasks:read"]);
    const bobKey = makeKey(w.bob, ["tasks:read"]);
    const mine = await callTool(aliceKey, "query_cards", { filter: "assignee:me state:todo,doing" });
    expect(mine.isError).toBe(false);
    expect(titles(mine.value)).toEqual(["Private plan", "Shared plan"]);
    const shared = (mine.value.cards as Array<Record<string, unknown>>).find((card) => card.title === "Shared plan")!;
    expect(shared).toMatchObject({
      board_name: "Agent Shared", column_name: "Doing", state: "doing", assignees: ["Agent Alice", "Agent Bob"], assignee_name: "Agent Alice",
      tags: [], flags: [], priority: "urgent", due_on: "2026-10-01", description_excerpt: ""
    });
    expect(shared.description).toBeUndefined();
    expect(mine.value.query).toBe("state:todo,doing assignee:me");

    // Bob names Alice's private board: nothing from it, and no name.
    const probe = await callTool(bobKey, "query_cards", { filter: `board:${w.privateBoardId},${w.sharedBoardId}` });
    expect(titles(probe.value)).toEqual(["Shared plan"]);
    expect(probe.value.refs.boards).toContainEqual({ id: w.privateBoardId, restricted: true });
    expect(JSON.stringify(probe.value)).not.toContain("Agent Private");

    // Grammar errors carry the position; scope and bounds are enforced.
    expect((await callTool(aliceKey, "query_cards", { filter: "state:todo owner:me" })).value).toMatchObject({ code: "INVALID", reason: "FILTER_INVALID", position: 11 });
    expect((await callTool(aliceKey, "query_cards", { filter: `column:${crypto.randomUUID()}` })).value).toMatchObject({ code: "INVALID", reason: "FILTER_SCOPE" });
    expect((await callTool(aliceKey, "query_cards", { filter: "sprint:someday" })).value).toMatchObject({ code: "INVALID", reason: "FILTER_INVALID" });
    expect((await callTool(aliceKey, "query_cards", { filter: "", limit: 51 })).isError).toBe(true);
    expect((await callTool(aliceKey, "query_cards", {})).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(aliceKey, "query_cards", { filter: "", viewId: w.viewId })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(aliceKey, "query_cards", { viewId: w.viewId, sort: "title" })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(aliceKey, "query_cards", { filter: "", tz: "Mars/Base" })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(aliceKey, "query_cards", { filter: "", cursor: "bogus" })).value).toMatchObject({ code: "INVALID", reason: "CURSOR_INVALID" });

    // Paging with nextCursor.
    const first = await callTool(aliceKey, "query_cards", { filter: `board:${w.privateBoardId},${w.sharedBoardId}`, sort: "title", limit: 1 });
    expect(first.value.cards.map((card: { title: string }) => card.title)).toEqual(["Private plan"]);
    expect(first.value.total).toBe(2);
    const second = await callTool(aliceKey, "query_cards", { filter: `board:${w.privateBoardId},${w.sharedBoardId}`, sort: "title", limit: 1, cursor: first.value.nextCursor });
    expect(second.value).toMatchObject({ nextCursor: null, cards: [{ title: "Shared plan" }] });
  });

  test("list_views shows only readable views, and a shared view runs as the recipient (the T115 twin)", async () => {
    const w = await world("Shared view");
    const aliceKey = makeKey(w.alice, ["tasks:read"]);
    const bobKey = makeKey(w.bob, ["tasks:write"]);
    expect(((await callTool(bobKey, "list_views")).value.views as Array<{ id: string }>).map((view) => view.id)).not.toContain(w.viewId);
    expect((await callTool(bobKey, "query_cards", { viewId: w.viewId })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(bobKey, "query_cards", { viewId: crypto.randomUUID() })).value).toMatchObject({ code: "NOT_FOUND" });

    await api(w.alice, "PUT", `/views/${w.viewId}/sharing`, { visibility: "selected", userIds: [w.bob.userId] });
    const listed = (await callTool(bobKey, "list_views")).value.views as Array<Record<string, unknown>>;
    expect(listed.find((view) => view.id === w.viewId)).toEqual({
      id: w.viewId, name: "Shared view everything", owner_name: "Shared view Alice", is_owner: 0, visibility: "selected",
      board_id: null, lanes: "columns", layout: "list", revision: 2, pinned_board_ids: [],
      query:[w.privateBoardId, w.sharedBoardId].sort().reduce((text, id, index) => `${text}${index ? "," : "board:"}${id}`, "")
    });
    const asBob = await callTool(bobKey, "query_cards", { viewId: w.viewId });
    expect(asBob.isError).toBe(false);
    expect(asBob.value.view).toEqual({ id: w.viewId, name: "Shared view everything", owner_name: "Shared view Alice" });
    expect(titles(asBob.value)).toEqual(["Shared plan"]);
    expect(JSON.stringify(asBob.value)).not.toContain("Private plan");
    const asAlice = await callTool(aliceKey, "query_cards", { viewId: w.viewId });
    expect(titles(asAlice.value)).toEqual(["Private plan", "Shared plan"]);
    // Reads are not audited (save_view, lane VIEWS2, is the one view write).
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type LIKE 'task.view%'").get(w.bob.userId) as { count: number }).count).toBe(0);
    const writerTools = ((await rpc(bobKey, "tools/list")).result!.tools!).map((tool) => tool.name);
    expect(writerTools.filter((name) => /view/.test(name) && name !== "list_views")).toEqual(["save_view"]);
  });

  test("query_cards shares the per-user query limit with the REST routes, for views and filters (T117)", async () => {
    const w = await world("Query limit");
    const key = makeKey(w.alice, ["tasks:read"]);
    const call = async (args: Record<string, unknown>, keyId = key.id) => JSON.parse((await invokeMcpToolForTests("query_cards", args, keyId)).content[0]!.text) as Record<string, any>;
    for (let index = 0; index < TASK_QUERY_RATE_LIMIT; index += 1) {
      expect((await call(index % 2 ? { viewId: w.viewId } : { filter: "state:todo" })).code).toBeUndefined();
    }
    for (const args of [{ filter: "" }, { viewId: w.viewId }]) {
      const limited = await call(args);
      expect(limited.code).toBe("RATE_LIMITED");
      expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    // The same budget as POST /api/tasks/query.
    expect((await api(w.alice, "POST", "/query", { q: "" })).status).toBe(429);
    // Another user is not affected.
    expect((await call({ filter: "" }, makeKey(w.bob, ["tasks:read"]).id)).code).toBeUndefined();
  });
});
