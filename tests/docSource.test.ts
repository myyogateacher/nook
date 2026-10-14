import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";

const { McpClientError, McpSession } = await import("../server/agents/mcpClient");
const { cutBytes, docFromText, docServerChoices, docSessions, docState, docToolArgs, docToolOf, fetchDoc, pickDocTool, recordSnapshot, SNAPSHOTS_KEPT } = await import("../server/reports/docSource");
const { REPORT_LIMITS } = await import("../shared/reports");
type StoredTool = import("../server/agents/toolServers").StoredTool;
type ToolServerRow = import("../server/agents/toolServers").ToolServerRow;
type McpTransport = import("../server/agents/mcpClient").McpTransport;

/**
 * Wave 46 docSource (D424, T368): the doc tool's auto-pick and override, Outline's `{resource, id}`
 * convention, Outline-shaped and markdown results, DOC_FETCH and MCP_AUTH, the 512 KiB cap, snapshots
 * written only when the hash changes, and "Doc changed" / Check doc over HTTP. The MCP side is a fake
 * transport under a real McpSession (initialize, tools/call), so nothing leaves the process.
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const tool = (name: string, properties: Record<string, unknown>): StoredTool => ({ name, title: null, description: "", inputSchema: { type: "object", properties }, readOnly: true, openWorld: false, destructive: false });
const OUTLINE_FETCH = tool("fetch", { resource: { type: "string" }, id: { type: "string" } });

/** A fake MCP transport: answers initialize, and tools/call with `answer(name, args)`. */
class FakeTransport implements McpTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  constructor(private readonly answer: (name: string, args: Record<string, unknown>) => unknown) {}
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    if (method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
    if (method === "tools/call") return this.answer(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
    throw new McpClientError("MCP_PROTOCOL", "unexpected");
  }
  async notify() {}
  async close() {}
}

let transport = new FakeTransport(() => ({ content: [] }));
const original = docSessions.sessionFor;
beforeAll(() => { docSessions.sessionFor = () => new McpSession(transport, "Docs"); });
afterAll(() => { docSessions.sessionFor = original; });
afterEach(() => { transport = new FakeTransport(() => ({ content: [] })); });

const outlineAnswer = (title: string, text: string) => ({ content: [{ type: "text", text: JSON.stringify({ data: { id: "doc-1", urlId: "AbC123", title, text, url: "https://docs.example.test/doc/revenue-AbC123" } }) }] });

let admin: Session;
let member: Session;
let server: ToolServerRow;
let datasourceId = "";
beforeAll(async () => {
  admin = await createUser("Doc source admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Doc source member");
  const created = await send(admin, "POST", "/agents/admin/servers", { name: `Docs ${crypto.randomUUID().slice(0, 6)}`, url: "https://docs.example.test/mcp", availability: "all" });
  expect(created.status).toBe(201);
  db.query("UPDATE agent_tool_servers SET tools_json = ? WHERE id = ?").run(JSON.stringify([tool("search", { query: {} }), OUTLINE_FETCH, tool("get_page", { url: {} })]), created.body.server.id);
  server = db.query("SELECT * FROM agent_tool_servers WHERE id = ?").get(created.body.server.id) as ToolServerRow;
  const datasource = await send(admin, "POST", "/reports/admin/datasources", { name: `Docs DS ${crypto.randomUUID().slice(0, 6)}`, url: "https://ch.example.test:8443/", username: "ro", database: "analytics" });
  expect(datasource.status).toBe(201);
  datasourceId = datasource.body.datasource.id;
});
afterAll(() => {
  db.query("DELETE FROM agent_tool_servers WHERE id = ?").run(server.id);
});

describe("the doc tool", () => {
  test("auto-picks fetch, get_document, or read_document taking id or url; Outline's resource convention; overrides", () => {
    expect(pickDocTool([tool("search", { query: {} }), OUTLINE_FETCH])).toEqual({ tool: "fetch", arg: "id", outline: true });
    // A fetch that takes neither id nor url is skipped for the next name.
    expect(pickDocTool([tool("fetch", { query: {} }), tool("get_document", { url: {} })])).toEqual({ tool: "get_document", arg: "url", outline: false });
    expect(pickDocTool([tool("read_document", { id: {}, url: {} })])).toEqual({ tool: "read_document", arg: "id", outline: false });
    expect(pickDocTool([tool("search", { query: {} }), tool("get_page", { url: {} })])).toBeNull();
    // The person's override: another tool, and its argument.
    expect(pickDocTool([tool("get_page", { url: {} })], { tool: "get_page" })).toEqual({ tool: "get_page", arg: "url", outline: false });
    expect(pickDocTool([tool("get_page", { page: {} })], { tool: "get_page", arg: "page" })).toEqual({ tool: "get_page", arg: "page", outline: false });
    expect(pickDocTool([OUTLINE_FETCH], { tool: "missing" })).toBeNull();
    expect(docToolArgs({ tool: "fetch", arg: "id", outline: true }, "https://docs.example.test/doc/x-AbC123")).toEqual({ resource: "document", id: "https://docs.example.test/doc/x-AbC123" });
    expect(docToolArgs({ tool: "get_page", arg: "url", outline: false }, "AbC123")).toEqual({ url: "AbC123" });
  });

  test("results: Outline JSON in its shapes, and plain markdown titled by its first heading", () => {
    expect(docFromText(JSON.stringify({ data: { title: "Revenue", text: "# R\nbody" } }))).toEqual({ title: "Revenue", markdown: "# R\nbody" });
    expect(docFromText(JSON.stringify({ title: "T", markdown: "md" }))).toEqual({ title: "T", markdown: "md" });
    expect(docFromText(JSON.stringify({ document: { content: "# Heading\ntext" } }))).toEqual({ title: "Heading", markdown: "# Heading\ntext" });
    expect(docFromText("intro\n# Weekly revenue\nmore")).toEqual({ title: "Weekly revenue", markdown: "intro\n# Weekly revenue\nmore" });
    expect(docFromText("{not json")).toEqual({ title: null, markdown: "{not json" });
  });

  test("fetches through the session with Outline's arguments; hashes the markdown", async () => {
    transport = new FakeTransport(() => outlineAnswer("Revenue metrics", "# Revenue metrics\nUse `analytics.orders`."));
    const doc = await fetchDoc(server, { tool: "fetch", arg: "id", outline: true }, "https://docs.example.test/doc/revenue-AbC123");
    expect(doc).toMatchObject({ title: "Revenue metrics", markdown: "# Revenue metrics\nUse `analytics.orders`.", truncated: false });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    const call = transport.calls.find((item) => item.method === "tools/call")!;
    expect(call.params).toEqual({ name: "fetch", arguments: { resource: "document", id: "https://docs.example.test/doc/revenue-AbC123" } });
  });

  test("errors: an error result and an empty doc are DOC_FETCH; a refused credential is MCP_AUTH (reconnect)", async () => {
    transport = new FakeTransport(() => ({ content: [{ type: "text", text: "Document not found <script>" }], isError: true }));
    const notFound = await fetchDoc(server, { tool: "fetch", arg: "id", outline: true }, "x").catch((error) => error);
    expect(notFound).toMatchObject({ code: "DOC_FETCH", status: 502 });
    expect(notFound.message).toContain("Document not found");
    expect(notFound.message).not.toContain("<script>");

    transport = new FakeTransport(() => ({ content: [{ type: "text", text: "   " }] }));
    expect(await fetchDoc(server, { tool: "fetch", arg: "id", outline: true }, "x").catch((error) => error)).toMatchObject({ code: "DOC_FETCH", message: "The document is empty" });

    transport = new FakeTransport(() => { throw new McpClientError("MCP_AUTH", "refused", 401); });
    const auth = await fetchDoc(server, { tool: "fetch", arg: "id", outline: true }, "x").catch((error) => error);
    expect(auth).toMatchObject({ code: "MCP_AUTH", status: 502, details: { reconnect: true, serverId: server.id } });

    transport = new FakeTransport(() => { throw new McpClientError("NETWORK", "connection refused"); });
    expect(await fetchDoc(server, { tool: "fetch", arg: "id", outline: true }, "x").catch((error) => error)).toMatchObject({ code: "DOC_FETCH" });
  });

  test("a doc past 512 KiB is cut on a character boundary and marked", async () => {
    const big = `# Big\n${"é".repeat(REPORT_LIMITS.docBytes)}`;
    transport = new FakeTransport(() => ({ content: [{ type: "text", text: big }] }));
    const doc = await fetchDoc(server, { tool: "get_page", arg: "url", outline: false }, "x");
    expect(doc.truncated).toBe(true);
    expect(doc.bytes).toBeLessThanOrEqual(REPORT_LIMITS.docBytes);
    expect(doc.markdown.endsWith("�")).toBe(false);
    expect(cutBytes("abc", 10)).toEqual({ text: "abc", truncated: false });
  });
});

describe("review M2: only read-only doc tools", () => {
  test("a delete_document override is refused (DOC_TOOL_REFUSED) and never called; the auto-pick and the picker skip tools that are not auto", async () => {
    const destructive: StoredTool = { ...tool("delete_document", { id: {} }), readOnly: false, destructive: true };
    const unsafeFetch: StoredTool = { ...tool("fetch", { id: {} }), readOnly: false };
    db.query("UPDATE agent_tool_servers SET tools_json = ? WHERE id = ?").run(JSON.stringify([destructive, unsafeFetch, tool("get_document", { url: {} })]), server.id);
    try {
      const row = db.query("SELECT * FROM agent_tool_servers WHERE id = ?").get(server.id) as ToolServerRow;
      transport = new FakeTransport(() => ({ content: [{ type: "text", text: "Deleted" }] }));
      expect(() => docToolOf(row, { tool: "delete_document", arg: "id" })).toThrow(expect.objectContaining({ code: "DOC_TOOL_REFUSED", status: 400 }));
      // A fetch the server does not mark read-only defaults to confirm: skipped for get_document.
      expect(docToolOf(row, {})).toEqual({ tool: "get_document", arg: "url", outline: false });
      expect(() => docToolOf(row, { tool: "fetch" })).toThrow(expect.objectContaining({ code: "DOC_TOOL_REFUSED" }));
      // An admin's explicit auto makes a tool usable; an admin's confirm on a read-only tool takes it away.
      db.query("INSERT INTO agent_tool_policies (server_id, tool_name, policy) VALUES (?, 'fetch', 'auto'), (?, 'get_document', 'confirm')").run(server.id, server.id);
      expect(docToolOf(row, {})).toEqual({ tool: "fetch", arg: "id", outline: false });
      expect(() => docToolOf(row, { tool: "get_document" })).toThrow(expect.objectContaining({ code: "DOC_TOOL_REFUSED" }));
      const listed = docServerChoices("member").find((item) => item.id === server.id)!;
      expect(listed.tools.map((item) => item.name)).toEqual(["fetch"]);
      expect(transport.calls.filter((call) => call.method === "tools/call")).toEqual([]);
    } finally {
      db.query("DELETE FROM agent_tool_policies WHERE server_id = ?").run(server.id);
      db.query("UPDATE agent_tool_servers SET tools_json = ? WHERE id = ?").run(JSON.stringify([tool("search", { query: {} }), OUTLINE_FETCH, tool("get_page", { url: {} })]), server.id);
    }
  });
});

describe("snapshots and Doc changed", () => {
  async function newReport() {
    const created = await send(member, "POST", "/reports", { title: `Doc report ${crypto.randomUUID().slice(0, 6)}`, datasourceId });
    expect(created.status).toBe(201);
    return created.body.report.id as string;
  }
  const snapshotCount = (reportId: string) => (db.query("SELECT COUNT(*) AS count FROM report_doc_snapshots WHERE report_id = ?").get(reportId) as { count: number }).count;
  const docOf = (markdown: string) => ({ title: "T", markdown, sha256: new Bun.CryptoHasher("sha256").update(markdown).digest("hex"), bytes: markdown.length, truncated: false });

  test("a snapshot is written only when the hash changes; old unreferenced ones are pruned", async () => {
    const reportId = await newReport();
    const first = recordSnapshot(reportId, docOf("v1"));
    expect(first.changed).toBe(true);
    expect(recordSnapshot(reportId, docOf("v1"))).toEqual({ id: first.id, sha256: first.sha256, changed: false });
    expect(snapshotCount(reportId)).toBe(1);
    const second = recordSnapshot(reportId, docOf("v2"));
    expect(second.changed).toBe(true);
    expect(second.id).not.toBe(first.id);
    // Back to v1 is a change from v2: a new row.
    expect(recordSnapshot(reportId, docOf("v1")).changed).toBe(true);
    expect(snapshotCount(reportId)).toBe(3);
    // A run names the first snapshot; it survives pruning.
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, doc_snapshot_id, started_at) VALUES (?, ?, 'generate', 'user', 'failed', ?, ?)").run(crypto.randomUUID(), reportId, first.id, new Date().toISOString());
    for (let index = 0; index < SNAPSHOTS_KEPT + 3; index += 1) recordSnapshot(reportId, docOf(`edit ${index}`));
    expect(snapshotCount(reportId)).toBe(SNAPSHOTS_KEPT + 1);
    expect(db.query("SELECT 1 FROM report_doc_snapshots WHERE id = ?").get(first.id)).not.toBeNull();
  });

  test("doc state: changed once the newest snapshot differs from the report's doc hash; Check doc over HTTP", async () => {
    const reportId = await newReport();
    expect(docState(reportId, member.userId)).toEqual({ doc: null, latest: null, changed: false });
    // Check doc needs a doc.
    expect((await send(member, "POST", `/reports/${reportId}/doc/check`)).body.code).toBe("INVALID");
    const v1 = docOf("# Revenue\nv1");
    recordSnapshot(reportId, v1);
    db.query("UPDATE reports SET doc_server_id = ?, doc_tool = 'fetch', doc_ref = 'https://docs.example.test/doc/revenue-AbC123', doc_hash = ? WHERE id = ?").run(server.id, v1.sha256, reportId);
    const unchanged = await send(member, "GET", `/reports/${reportId}/doc`);
    expect(unchanged.body.doc).toMatchObject({ changed: false, doc: { serverId: server.id, serverName: server.name, tool: "fetch", arg: null, hash: v1.sha256 }, latest: { sha256: v1.sha256, title: "T" } });

    // The doc is edited upstream: Check doc stores the new snapshot and says it changed.
    transport = new FakeTransport(() => outlineAnswer("Revenue", "# Revenue\nv2"));
    const checked = await send(member, "POST", `/reports/${reportId}/doc/check`);
    expect(checked.status).toBe(200);
    expect(checked.body.doc.changed).toBe(true);
    expect(checked.body.doc.latest.title).toBe("Revenue");
    expect(transport.calls.find((call) => call.method === "tools/call")!.params.arguments).toEqual({ resource: "document", id: "https://docs.example.test/doc/revenue-AbC123" });
    // Checking again with no edit writes nothing new.
    transport = new FakeTransport(() => outlineAnswer("Revenue", "# Revenue\nv2"));
    await send(member, "POST", `/reports/${reportId}/doc/check`);
    expect(snapshotCount(reportId)).toBe(2);
    // The audit row has hashes and sizes, never the doc's text.
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.doc.check' AND metadata_json LIKE ?").all(`%${reportId}%`) as Array<{ metadata_json: string }>;
    expect(audits.length).toBe(2);
    for (const row of audits) expect(row.metadata_json).not.toContain("v2");

    // A refused credential surfaces as MCP_AUTH (the UI's "reconnect").
    transport = new FakeTransport(() => { throw new McpClientError("MCP_AUTH", "refused", 401); });
    const refused = await send(member, "POST", `/reports/${reportId}/doc/check`);
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ code: "MCP_AUTH", reconnect: true });
    // Someone else's report is a 404.
    const other = await createUser("Doc source other");
    expect((await send(other, "GET", `/reports/${reportId}/doc`)).status).toBe(404);
  });

  test("the doc servers a person may use: enabled, open to them, with the auto-pick; an admin's off policy hides a tool", async () => {
    const listed = await send(member, "GET", "/reports/doc-servers");
    const mine = listed.body.servers.find((item: Json) => item.id === server.id);
    expect(mine).toMatchObject({ name: server.name, pick: { tool: "fetch", arg: "id", outline: true } });
    expect(mine.tools.map((item: Json) => item.name)).toEqual(["search", "fetch", "get_page"]);
    db.query("INSERT INTO agent_tool_policies (server_id, tool_name, policy) VALUES (?, 'fetch', 'off') ON CONFLICT(server_id, tool_name) DO UPDATE SET policy = 'off'").run(server.id);
    try {
      const again = await send(member, "GET", "/reports/doc-servers");
      expect(again.body.servers.find((item: Json) => item.id === server.id).pick).toBeNull();
    } finally {
      db.query("DELETE FROM agent_tool_policies WHERE server_id = ? AND tool_name = 'fetch'").run(server.id);
    }
    // An admin-only server is not offered to members.
    db.query("UPDATE agent_tool_servers SET visibility = 'private' WHERE id = ?").run(server.id);
    try {
      expect((await send(member, "GET", "/reports/doc-servers")).body.servers.some((item: Json) => item.id === server.id)).toBe(false);
    } finally {
      db.query("UPDATE agent_tool_servers SET visibility = 'all_users' WHERE id = ?").run(server.id);
    }
  });
});
