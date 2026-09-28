import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTodayRateLimit, TODAY_RATE_LIMIT } = await import("../server/today/rateLimit");
type McpScope = import("../server/mcpScopes").McpScope;

beforeEach(() => { resetMcpLimits(); resetTodayRateLimit(); });

async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };
}

async function getToday(session: Session, scopes: McpScope[], args: Record<string, unknown> = {}) {
  const key = createMcpApiKey(session.userId, "Today agent", scopes);
  const body = await rpc(key.token, "tools/call", { name: "get_today", arguments: args });
  return { isError: body.result?.isError === true, value: JSON.parse(body.result!.content![0]!.text) as Record<string, any>, key };
}

describe("get_today MCP tool", () => {
  test("is offered only with today:read", async () => {
    const user = await createUser("MCP today tools");
    const without = createMcpApiKey(user.userId, "No today", ["notes:read", "files:read", "tasks:write"]);
    expect(((await rpc(without.token, "tools/list")).result!.tools!).map((tool) => tool.name)).not.toContain("get_today");
    const withToday = createMcpApiKey(user.userId, "Today", ["today:read"]);
    expect(((await rpc(withToday.token, "tools/list")).result!.tools!).map((tool) => tool.name)).toContain("get_today");
    // The handler re-checks the scope even when called directly (T72).
    const direct = await invokeMcpToolForTests("get_today", {}, without.id);
    expect(direct.isError).toBe(true);
    expect(JSON.parse(direct.content[0]!.text).code).toBe("SCOPE_REQUIRED");
  });

  test("returns only the sections whose module scope the key also holds (T74)", async () => {
    const user = await createUser("MCP today scopes");
    const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, user);
    const noteId = ((await created.json()) as { note: { id: string } }).note.id;
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# Agent visible title\n\nsecret body text", revision: 1 }) }, user);

    const alone = await getToday(user, ["today:read"]);
    expect(alone.isError).toBe(false);
    expect(Object.keys(alone.value.sections)).toEqual(["binSoon", "storage"]);
    expect(JSON.stringify(alone.value)).not.toContain("Agent visible title");

    const notes = await getToday(user, ["today:read", "notes:read"]);
    expect(Object.keys(notes.value.sections)).toEqual(["notesRecent", "drafts", "binSoon", "storage"]);
    expect(notes.value.sections.drafts.items).toEqual([expect.objectContaining({ id: noteId, title: "Agent visible title" })]);
    // Titles only: never a body.
    expect(JSON.stringify(notes.value)).not.toContain("secret body text");

    expect(Object.keys((await getToday(user, ["today:read", "files:read"])).value.sections)).toEqual(["files", "binSoon", "storage"]);
    // A write scope implies its read scope.
    expect(Object.keys((await getToday(user, ["today:read", "tasks:write"])).value.sections)).toEqual(["tasksDue", "tasksMine", "binSoon", "storage"]);
    // Upcoming events need calendar:read (calendar:write implies it).
    expect(Object.keys((await getToday(user, ["today:read", "calendar:read"])).value.sections)).toEqual(["binSoon", "upcoming", "storage"]);
    expect(Object.keys((await getToday(user, ["today:read", "calendar:write"])).value.sections)).toEqual(["binSoon", "upcoming", "storage"]);
    const all = await getToday(user, ["today:read", "notes:read", "files:read", "tasks:read"]);
    expect(Object.keys(all.value.sections)).toEqual(["tasksDue", "tasksMine", "notesRecent", "drafts", "files", "binSoon", "storage"]);
    // Proposals need inbox:read (agent inbox D158), and list only the calling key's own (T131).
    expect(Object.keys((await getToday(user, ["today:read", "inbox:read"])).value.sections)).toEqual(["binSoon", "storage", "proposals"]);
  });

  test("shares the 30-a-minute Today budget with the web, per user", async () => {
    const user = await createUser("MCP today limit");
    const key = createMcpApiKey(user.userId, "Busy agent", ["today:read"]);
    for (let index = 0; index < TODAY_RATE_LIMIT - 1; index += 1) expect((await invokeMcpToolForTests("get_today", {}, key.id)).isError).toBeFalsy();
    expect((await request("/today?tz=UTC", {}, user)).status).toBe(200);
    const limited = await invokeMcpToolForTests("get_today", {}, key.id);
    expect(limited.isError).toBe(true);
    expect(JSON.parse(limited.content[0]!.text)).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: expect.any(Number) });
    expect((await request("/today?tz=UTC", {}, user)).status).toBe(429);
    const other = await createUser("MCP today limit other");
    expect((await invokeMcpToolForTests("get_today", {}, createMcpApiKey(other.userId, "Other", ["today:read"]).id)).isError).toBeFalsy();
  });

  test("validates tz, defaults to UTC, and is not audited", async () => {
    const user = await createUser("MCP today tz");
    const utc = await getToday(user, ["today:read"]);
    expect(utc.value.date).toBe(new Date(utc.value.generatedAt).toISOString().slice(0, 10));
    const bad = await getToday(user, ["today:read"], { tz: "Mars/Olympus" });
    expect(bad.isError).toBe(true);
    expect(bad.value.code).toBe("INVALID");
    expect((await getToday(user, ["today:read"], { tz: "Pacific/Kiritimati" })).isError).toBe(false);
    const audits = db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type NOT LIKE 'mcp.key%'").get(user.userId) as { count: number };
    expect(audits.count).toBe(0);
  });
});

describe("get_today Bin items follow the key's module scopes (T74)", () => {
  test("each Bin type needs its module's read scope; the web sees all", async () => {
    const { newCollection, addRow, call: collections } = await import("./support/collections");
    const user = await createUser("MCP today bin");
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const noteResponse = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, user);
    const noteId = ((await noteResponse.json()) as { note: { id: string } }).note.id;
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# Binned note title", revision: 1 }) }, user);
    await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, user);
    expect((await request(`/notes/${noteId}`, { method: "DELETE", body: "{}" }, user)).status).toBe(200);
    const form = new FormData();
    form.append("file", new Blob(["x"]), "binned-file.txt");
    const documentId = ((await (await request("/files", { method: "POST", body: form }, user)).json()) as { document: { id: string } }).document.id;
    expect((await request(`/files/${documentId}`, { method: "DELETE", body: "{}" }, user)).status).toBe(200);
    const tasks = async (method: string, path: string, body?: unknown) => (await (await request(`/tasks${path}`, { method, body: JSON.stringify(body ?? {}) }, user)).json()) as Record<string, any>;
    const created = await tasks("POST", "/boards", { name: "Binned board" });
    const card = (await tasks("POST", `/boards/${created.board.id}/cards`, { columnId: created.columns[0].id, title: "Binned card" })).card;
    await tasks("DELETE", `/cards/${card.id}`);
    const other = await tasks("POST", "/boards", { name: "Board in bin" });
    await tasks("DELETE", `/boards/${other.board.id}`);
    const collection = await newCollection(user, { name: "Binned collection", fields: [{ name: "Name", type: "text" }] });
    const keep = await newCollection(user, { name: "Kept collection", fields: [{ name: "Name", type: "text" }] });
    const row = await addRow(user, keep.id, { [keep.fields[0]!.id]: "Binned row" });
    expect((await collections(user, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    expect((await collections(user, "DELETE", `/${collection.id}`)).status).toBe(200);
    // Calendar items need calendar:read.
    const calendarId = ((await (await request("/calendars", { method: "POST", body: JSON.stringify({ name: "Binned calendar" }) }, user)).json()) as { calendar: { id: string } }).calendar.id;
    expect((await request(`/calendars/${calendarId}`, { method: "DELETE", body: "{}" }, user)).status).toBe(200);
    for (const table of ["notes", "documents", "cards", "boards", "collections", "collection_rows", "calendars"]) db.query(`UPDATE ${table} SET purge_after = ? WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after > ?`).run(soon, soon);

    const types = (value: Record<string, any>) => (value.sections.binSoon.items as Array<{ type: string }>).map((item) => item.type).sort();
    expect(types((await getToday(user, ["today:read"])).value)).toEqual([]);
    expect(types((await getToday(user, ["today:read", "notes:read"])).value)).toEqual(["note"]);
    expect(types((await getToday(user, ["today:read", "files:read"])).value)).toEqual(["document"]);
    expect(types((await getToday(user, ["today:read", "tasks:read"])).value)).toEqual(["board", "card"]);
    expect(types((await getToday(user, ["today:read", "calendar:read"])).value)).toEqual(["calendar"]);
    expect(types((await getToday(user, ["today:read", "collections:read"])).value)).toEqual(["collection", "collection_row"]);
    const all = (await getToday(user, ["today:read", "notes:read", "files:read", "tasks:write"])).value;
    expect(types(all)).toEqual(["board", "card", "document", "note"]);
    expect(JSON.stringify(all)).not.toContain("Binned collection");
    expect(JSON.stringify(all)).not.toContain("Binned row");
    expect(JSON.stringify(all)).not.toContain("Binned calendar");
    // The web (a session) sees every type, as the Bin does.
    const { resetTodayRateLimit } = await import("../server/today/routes");
    resetTodayRateLimit();
    const web = (await (await request("/today?tz=UTC", {}, user)).json()) as Record<string, any>;
    expect(types(web)).toEqual(["board", "calendar", "card", "collection", "collection_row", "document", "note"]);
  });
});
