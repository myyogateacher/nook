import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { registeredMigrations } from "../server/migrations";
import { cardPriorityMigration } from "../server/migrations/123_card_priority";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTaskQueryRateLimit } = await import("../server/tasks/queryRoutes");

/** Card priority (docs/plan/TASK_PRIORITY.md, D1310–D1319): migration 123, REST, activity, the query, and MCP. */

beforeEach(() => { resetMcpLimits(); resetTaskQueryRateLimit(); });

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as Array<{ id: string }>;
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const card = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0]!.id, title: "Plain" })).body.card as { id: string; revision: number };
  return { owner, member, stranger, boardId, columnId: columns[0]!.id, card };
}

const setLevel = (boardId: string, userId: string, level: string) => db.query("UPDATE board_members SET level = ? WHERE board_id = ? AND user_id = ?").run(level, boardId, userId);
const lastAudit = (userId: string, event: string) => {
  const row = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY rowid DESC LIMIT 1").get(userId, event) as { metadata_json: string } | null;
  return row ? JSON.parse(row.metadata_json) as Record<string, unknown> : null;
};
const priorityRows = (cardId: string) => (db.query("SELECT payload FROM card_activity WHERE card_id = ? AND kind = 'priority' ORDER BY created_at, id").all(cardId) as Array<{ payload: string }>)
  .map((row) => JSON.parse(row.payload) as { from: unknown; to: unknown });

describe("migration 123 card_priority (D1311)", () => {
  test("the Urgent flag becomes the Urgent priority; Blocked, Needs review, and On hold stay flags; re-running changes nothing", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 123)) sqlite.transaction(() => migration.up(sqlite))();
    const at = "2026-11-16T00:00:00.000Z";
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    sqlite.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Old board', ?, ?)").run(at, at);
    sqlite.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(at, at);
    const card = sqlite.query("INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at) VALUES (?, 'b1', 'c1', ?, ?, ?, ?)");
    const flag = sqlite.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)");
    card.run("urgent-only", 1, "Urgent only", at, at);
    flag.run("urgent-only", "urgent", at);
    card.run("urgent-blocked", 2, "Urgent and blocked", at, at);
    flag.run("urgent-blocked", "urgent", at);
    flag.run("urgent-blocked", "blocked", at);
    card.run("flags", 3, "Other flags", at, at);
    flag.run("flags", "needs_review", at);
    flag.run("flags", "on_hold", at);
    card.run("plain", 4, "Plain", at, at);

    sqlite.transaction(() => cardPriorityMigration.up(sqlite))();
    sqlite.transaction(() => cardPriorityMigration.up(sqlite))();
    const priorities = Object.fromEntries((sqlite.query("SELECT id, priority FROM cards").all() as Array<{ id: string; priority: string | null }>).map((row) => [row.id, row.priority]));
    expect(priorities).toEqual({ "urgent-only": "urgent", "urgent-blocked": "urgent", flags: null, plain: null });
    const flags = (sqlite.query("SELECT card_id, flag FROM card_flags ORDER BY card_id, flag").all() as Array<{ card_id: string; flag: string }>).map((row) => `${row.card_id}:${row.flag}`);
    expect(flags).toEqual(["flags:needs_review", "flags:on_hold", "urgent-blocked:blocked"]);
    // The column takes the four values or NULL, nothing else.
    for (const value of ["low", "medium", "high", "urgent", null]) sqlite.query("UPDATE cards SET priority = ? WHERE id = 'plain'").run(value);
    expect(() => sqlite.query("UPDATE cards SET priority = 'critical' WHERE id = 'plain'").run()).toThrow();
    expect(registeredMigrations.some((migration) => migration.id === 123 && migration.name === "card_priority")).toBe(true);
  });
});

describe("card priority over REST (D1310, D1312)", () => {
  test("set, change, and clear; one revision each; audited; reads carry it; validation", async () => {
    const { owner, member, boardId, columnId, card } = await setup("Priority REST");
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card.priority).toBeNull();
    let patched = await call(member, "PATCH", `/cards/${card.id}`, { priority: "high", revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ priority: "high", revision: 2 });
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ cardId: card.id, priority: "high" });
    patched = await call(member, "PATCH", `/cards/${card.id}`, { priority: "urgent", revision: 2 });
    expect(patched.body.card).toMatchObject({ priority: "urgent", revision: 3 });
    // The board payload sends a priority only when set (the D113 trim).
    const board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.find((item: { id: string }) => item.id === card.id).priority).toBe("urgent");
    for (const priority of ["critical", "URGENT", 1, ""]) {
      expect((await call(member, "PATCH", `/cards/${card.id}`, { priority, revision: 3 })).status).toBe(400);
    }
    patched = await call(member, "PATCH", `/cards/${card.id}`, { priority: null, revision: 3 });
    expect(patched.body.card).toMatchObject({ priority: null, revision: 4 });
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ priority: null });
    const plain = (await call(owner, "GET", `/boards/${boardId}`)).body.cards.find((item: { id: string }) => item.id === card.id);
    expect("priority" in plain).toBe(false);

    const created = await call(member, "POST", `/boards/${boardId}/cards`, { columnId, title: "Born low", priority: "low" });
    expect(created.status).toBe(201);
    expect(created.body.card.priority).toBe("low");
    expect(lastAudit(member.userId, "task.card_create")).toMatchObject({ priority: "low" });
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId, title: "Bad", priority: "soon" })).status).toBe(400);
  });

  test("the deprecated urgent flag still works: it sets the Urgent priority and is never stored as a flag", async () => {
    const { owner, member, boardId, columnId, card } = await setup("Priority legacy");
    const patched = await call(member, "PATCH", `/cards/${card.id}`, { flags: ["blocked", "urgent"], revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ flags: ["blocked"], priority: "urgent", revision: 2 });
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ flags: ["blocked"], priority: "urgent" });
    expect(db.query("SELECT COUNT(*) AS count FROM card_flags WHERE flag = 'urgent'").get()).toEqual({ count: 0 });
    // Flags without urgent leave the priority alone (a pre-priority client never sees Urgent among the flags).
    const again = await call(member, "PATCH", `/cards/${card.id}`, { flags: [], revision: 2 });
    expect(again.body.card).toMatchObject({ flags: [], priority: "urgent" });
    // An explicit priority in the same write wins over the legacy flag.
    const both = await call(member, "PATCH", `/cards/${card.id}`, { flags: ["urgent"], priority: "low", revision: 3 });
    expect(both.body.card).toMatchObject({ flags: [], priority: "low" });
    const created = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Old client", flags: ["urgent", "on_hold"] });
    expect(created.body.card).toMatchObject({ flags: ["on_hold"], priority: "urgent" });
    expect((await call(member, "PATCH", `/cards/${card.id}`, { flags: ["urgent", "urgent"], revision: 4 })).status).toBe(400);
  });

  test("permissions: view and comment levels are READ_ONLY, a stranger gets 404, and nothing changes", async () => {
    const { owner, member, stranger, boardId, card } = await setup("Priority access");
    setLevel(boardId, member.userId, "view");
    expect((await call(member, "PATCH", `/cards/${card.id}`, { priority: "high", revision: 1 })).body.code).toBe("READ_ONLY");
    setLevel(boardId, member.userId, "comment");
    expect((await call(member, "PATCH", `/cards/${card.id}`, { priority: "high", revision: 1 })).body.code).toBe("READ_ONLY");
    expect((await call(stranger, "PATCH", `/cards/${card.id}`, { priority: "high", revision: 1 })).status).toBe(404);
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card).toMatchObject({ priority: null, revision: 1 });
  });
});

describe("priority history (D1314)", () => {
  test("set, change, and clear are recorded with their words; a quick change folds; the history route reads them", async () => {
    const { owner, member, card } = await setup("Priority history");
    await call(owner, "PATCH", `/cards/${card.id}`, { priority: "high", revision: 1 });
    // Another person's change is a separate entry.
    await call(member, "PATCH", `/cards/${card.id}`, { priority: "urgent", revision: 2 });
    // The same person within two minutes folds into their entry: from High to Low.
    await call(member, "PATCH", `/cards/${card.id}`, { priority: "low", revision: 3 });
    await call(owner, "PATCH", `/cards/${card.id}`, { priority: null, revision: 4 });
    expect(priorityRows(card.id)).toEqual([
      { from: null, to: { id: "high", label: "High" } },
      { from: { id: "high", label: "High" }, to: { id: "low", label: "Low" } },
      { from: { id: "low", label: "Low" }, to: null }
    ]);
    // A patch that leaves the priority as it was records nothing.
    await call(owner, "PATCH", `/cards/${card.id}`, { priority: null, title: "Renamed", revision: 5 });
    expect(priorityRows(card.id)).toHaveLength(3);
    const listed = await call(owner, "GET", `/cards/${card.id}/activity`);
    expect(listed.status).toBe(200);
    expect((listed.body.activity as Array<{ kind: string }>).filter((entry) => entry.kind === "priority")).toHaveLength(3);
    // The legacy flag records a priority change, not a flag entry.
    await call(owner, "PATCH", `/cards/${card.id}`, { flags: ["urgent"], revision: 6 });
    expect(priorityRows(card.id).at(-1)).toEqual({ from: null, to: { id: "urgent", label: "Urgent" } });
    expect(db.query("SELECT COUNT(*) AS count FROM card_activity WHERE card_id = ? AND kind = 'flag_set'").get(card.id)).toEqual({ count: 0 });
  });
});

describe("priority in the task query (D1313, D1315, D1316)", () => {
  test("priority: filters, the legacy flag:urgent, and sort=priority", async () => {
    const { owner, boardId, columnId } = await setup("Priority query");
    const make = async (title: string, priority: string | null, flags: string[] = []) =>
      (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title, ...(priority ? { priority } : {}), flags })).body.card.id as string;
    await make("U", "urgent");
    await make("H", "high", ["blocked"]);
    await make("M", "medium");
    await make("L", "low");
    const run = async (q: string, sort?: string) => {
      const result = await call(owner, "POST", "/query", { q: `board:${boardId} ${q}`, ...(sort ? { sort } : {}), tz: "UTC" });
      expect(result.status).toBe(200);
      return result.body as { query: string; cards: Array<{ title: string; priority: string | null }> };
    };
    const titles = async (q: string) => (await run(q)).cards.map((item) => item.title).sort();
    expect(await titles("priority:urgent,high")).toEqual(["H", "U"]);
    expect(await titles("priority:none")).toEqual(["Plain"]);
    expect(await titles("-priority:none -priority:low")).toEqual(["H", "M", "U"]);
    // Legacy links and saved views: flag:urgent alone is rewritten; mixed with other flags it ORs the priority.
    const legacy = await run("flag:urgent");
    expect(legacy.query).toBe(`board:${boardId} priority:urgent`);
    expect(legacy.cards.map((item) => item.title)).toEqual(["U"]);
    expect(await titles("flag:urgent,blocked")).toEqual(["H", "U"]);
    expect(await titles("-flag:urgent")).toEqual(["H", "L", "M", "Plain"]);
    expect((await call(owner, "POST", "/query", { q: "priority:soon", tz: "UTC" })).body.code).toBe("FILTER_INVALID");
    const sorted = await run("", "priority");
    expect(sorted.cards.map((item) => item.title)).toEqual(["U", "H", "M", "L", "Plain"]);
    expect(sorted.cards[0]!.priority).toBe("urgent");
    // A saved view stored with the old flag keeps working.
    const view = await call(owner, "POST", "/views", { name: "Old urgent view", query: `board:${boardId} flag:urgent`, display: { sort: "priority" } });
    expect(view.status).toBe(201);
    const ran = await call(owner, "GET", `/views/${view.body.view.id}/cards?tz=UTC`);
    expect(ran.status === 200 ? (ran.body.cards as Array<{ title: string }>).map((item) => item.title) : ran.body).toEqual(["U"]);
  });
});

describe("priority over MCP (D1318)", () => {
  type Key = { token: string };
  let rpcId = 0;
  async function callTool(key: Key, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
    });
    const text = await response.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    const body = JSON.parse(json) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
    if (body.error) return { isError: true, value: { error: body.error.message } as Record<string, any> };
    const content = body.result!.content![0]!.text;
    let value: Record<string, any>;
    try { value = JSON.parse(content); } catch { value = { error: content }; }
    return { isError: body.result!.isError === true, value };
  }

  test("create_card, update_card, list_cards, and query_cards take and return priority; the urgent flag is accepted as deprecated", async () => {
    const { member, boardId, columnId } = await setup("Priority MCP");
    const key = createMcpApiKey(member.userId, "Priority agent", ["tasks:read", "tasks:write"]);
    const created = await callTool(key, "create_card", { boardId, columnId, title: "From MCP", priority: "medium" });
    expect(created.isError).toBe(false);
    expect(created.value.card).toMatchObject({ priority: "medium", flags: [] });
    const cardId = created.value.card.id as string;
    const updated = await callTool(key, "update_card", { cardId, baseRevision: 1, priority: "high" });
    expect(updated.value.card).toMatchObject({ priority: "high", revision: 2 });
    const cleared = await callTool(key, "update_card", { cardId, baseRevision: 2, priority: null });
    expect(cleared.value.card).toMatchObject({ priority: null, revision: 3 });
    const legacy = await callTool(key, "update_card", { cardId, baseRevision: 3, flags: ["urgent", "needs_review"] });
    expect(legacy.value.card).toMatchObject({ priority: "urgent", flags: ["needs_review"], revision: 4 });
    expect((await callTool(key, "update_card", { cardId, baseRevision: 4, priority: "critical" })).isError).toBe(true);
    const listed = await callTool(key, "list_cards", { boardId, priorities: ["urgent"] });
    expect((listed.value.cards as Array<{ id: string; priority: string }>).map((item) => [item.id, item.priority])).toEqual([[cardId, "urgent"]]);
    expect((await callTool(key, "list_cards", { boardId, priorities: ["none"] })).value.cards).toHaveLength(1);
    expect((await callTool(key, "get_card", { cardId })).value.card.priority).toBe("urgent");
    const queried = await callTool(key, "query_cards", { filter: `board:${boardId} priority:urgent`, sort: "priority" });
    expect(queried.isError).toBe(false);
    expect((queried.value.cards as Array<{ id: string; priority: string }>).map((item) => [item.id, item.priority])).toEqual([[cardId, "urgent"]]);
  });
});
