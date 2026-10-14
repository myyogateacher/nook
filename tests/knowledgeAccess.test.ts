import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { withoutNookAutoTools } from "./support/nookAuto";
import { settleAgentRunsAfterEach } from "./support/agentRuns";

const { createApiKey, validateGrants, KeyError } = await import("../server/apiKeys");
const { readPolicies } = await import("../server/team/policies");
const { invokeMcpToolForTests, mcpToolSpecs, loadLiveKey, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { deleteProvider } = await import("../server/agents/providers");
const { resetAgentRateLimitsForTests } = await import("../server/agents/limits");
const { offeredSpecs } = await import("../server/agents/nookBridge");
const { memberSharedRows } = await import("../server/agents/sharing");
const { whenKnowledgeIdle } = await import("../server/knowledge/index");
type Grant = import("../server/keyGrants").Grant;

/**
 * Wave 44 "AC-E" (agent chat plan §5.2, §9, §12, §14 T320, D367): who reaches a knowledge base
 * (owner, view, manage, non-member, guest, an admin who is not a member, a read-only team role), the
 * `search_knowledge` tool in a chat (a runner who cannot read a note source gets its text but not
 * its id or title, deliberately), over the API (`/api/v1/agents/:id/runs`), and for keys over MCP
 * (`agents:read` with an "all" or chosen-knowledge-base grant).
 */

retireUsersAfterFile();
// C2: this file expects exactly the tools it picks; the automatic Nook tools are off for its run.
withoutNookAutoTools();
settleAgentRunsAfterEach();
const fake = startFakeProvider(24624);
let admin: Session;
let owner: Session;
let viewer: Session;
let manager: Session;
let stranger: Session;
let guest: Session;
let outsiderAdmin: Session;
let readOnly: Session;
let providerId: string;
let kbId: string;
let otherKbId: string;
let noteId: string;
let agentId: string;

type Reply = { status: number; body: Record<string, any> };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}
async function share(session: Session, path: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", `${path}/access`);
  if (current.status !== 200) return current;
  return send(session, "PUT", `${path}/access`, { people: [], groups: [], ...body }, { "If-Match": current.body.etag });
}
async function publishNote(session: Session, markdown: string) {
  const id = (await send(session, "POST", "/notes", { folderId: null })).body.note.id as string;
  expect((await send(session, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  expect((await send(session, "POST", `/notes/${id}/publish`, {})).status).toBe(200);
  return id;
}

type SseEvent = { type: string; data: Record<string, any> };
async function chatOnce(session: Session, agent: string, content: string): Promise<{ events: SseEvent[]; messageId: string }> {
  const chat = await send(session, "POST", "/chats", { agentId: agent });
  expect(chat.status).toBe(201);
  const started = await send(session, "POST", `/chats/${chat.body.chat.id}/messages`, { content });
  expect(started.status).toBe(201);
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/runs/${started.body.runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf("\n\n");
        if (frame.startsWith(":")) continue;
        const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
        events.push({ type: lines.event!, data: JSON.parse(lines.data!) });
      }
      if (events.some((event) => event.type === "done" || event.type === "snapshot")) { controller.abort(); break; }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return { events, messageId: started.body.assistantMessage.id };
}
const toolTurns = () => fake.calls.filter((call) => call.path === "/v1/chat/completions").map((call) => call.body as { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string; parameters: Record<string, any> } }> });
const lastToolResult = () => [...toolTurns()].reverse().find((body) => body.messages.at(-1)?.role === "tool")!.messages.at(-1)!.content!;
const resultJson = (content: string) => JSON.parse(content.slice(content.indexOf("\n") + 1, content.lastIndexOf("\n"))) as { results: Array<Record<string, any>> };

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const kbGrant = (id: string): Grant => ({ module: "agents", permission: "read", resourceKind: "knowledge_base", resourceId: id });
const key = (session: Session, grants: Grant[], surfaces: "mcp" | "rest" | "both" = "mcp") => createApiKey(session.userId, { name: "KB key", surfaces, grants, expiresInDays: 30 });
const mcp = async (keyId: string, name: string, args: Record<string, unknown>) => {
  const result = await invokeMcpToolForTests(name, args, keyId);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
};

beforeAll(async () => {
  admin = await createUser("W44 access admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W44 access owner");
  viewer = await createUser("W44 access viewer");
  manager = await createUser("W44 access manager");
  stranger = await createUser("W44 access stranger");
  guest = await createUser("W44 access guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  outsiderAdmin = await createUser("W44 access outsider admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(outsiderAdmin.userId);
  readOnly = await createUser("W44 access read-only");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(readOnly.userId);
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (knowledge access)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0444", defaultModel: "gpt-6-luna", isDefault: true });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  noteId = await publishNote(owner, "# Owner's runbook\n\n## Escalation\n\nPage the on-call engineer for outages longer than ten minutes.");
  const kb = await send(owner, "POST", "/knowledge", { name: "Support FAQ" });
  kbId = kb.body.knowledgeBase.id;
  expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId })).status).toBe(201);
  expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "Billing FAQ", text: "# Billing\n\n## How do refunds work?\n\nRefunds are pro rata for annual plans." })).status).toBe(201);
  const other = await send(owner, "POST", "/knowledge", { name: "Product notes" });
  otherKbId = other.body.knowledgeBase.id;
  expect((await send(owner, "POST", `/knowledge/${otherKbId}/sources`, { kind: "text", title: "Releases", text: "# Releases\n\nVersion two ships in spring." })).status).toBe(201);
  await whenKnowledgeIdle();
  await whenKnowledgeIdle();
  const agent = await send(owner, "POST", "/agents", { name: "FAQ bot", providerId, tools: [{ source: "knowledge", kbId }] });
  expect(agent.status).toBe(201);
  agentId = agent.body.agent.id;
});
beforeEach(() => { resetMcpLimits(); resetAgentRateLimitsForTests(); });
afterAll(() => {
  deleteProvider(admin.userId, providerId);
  fake.stop();
});

describe("knowledge bases: the access matrix (D367)", () => {
  test("owner, view, manage, non-member, guest, an admin who is not a member, and a read-only role", async () => {
    const path = `/knowledge/${kbId}`;
    for (const session of [viewer, manager, stranger, outsiderAdmin, readOnly]) {
      expect((await send(session, "GET", path)).status).toBe(404);
      expect((await send(session, "POST", `${path}/search`, { query: "refunds" })).status).toBe(404);
    }
    expect((await send(guest, "GET", path)).status).toBe(404);
    expect((await send(guest, "GET", "/knowledge")).status).toBe(404);
    // Guests cannot be named; levels are view and manage.
    expect((await share(owner, path, { audience: "selected", people: [{ id: guest.userId, level: "view" }] })).body.code).toBe("GUEST_NOT_ALLOWED");
    expect((await share(owner, path, { audience: "selected", people: [{ id: viewer.userId, level: "edit" }] })).body.code).toBe("LEVEL_NOT_OFFERED");
    const saved = await share(owner, path, { audience: "selected", people: [{ id: viewer.userId, level: "view" }, { id: manager.userId, level: "manage" }, { id: readOnly.userId, level: "manage" }] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ kind: "knowledge_base", audience: "selected", levels: ["view", "manage"] });

    // View: searches, sees the base, but not the title or id of a note it cannot read (T320); never changes it.
    const asViewer = await send(viewer, "GET", path);
    expect(asViewer.body.knowledgeBase).toMatchObject({ yourLevel: "view", audience: null });
    const noteSource = asViewer.body.knowledgeBase.sources.find((source: { kind: string }) => source.kind === "note");
    expect(noteSource).toMatchObject({ title: null, titleHidden: true, refId: null, status: "ready" });
    expect(JSON.stringify(asViewer.body)).not.toContain("Owner's runbook");
    expect(asViewer.body.knowledgeBase.sources.find((source: { kind: string }) => source.kind === "text")).toMatchObject({ title: "Billing FAQ" });
    const searched = await send(viewer, "POST", `${path}/search`, { query: "on-call engineer outages" });
    expect(searched.status).toBe(200);
    // QA LOW-2: the note's own title (its H1) is left out of the heading path for someone who cannot open it.
    expect(searched.body.hits[0]).toMatchObject({ heading: "Escalation", source: { kind: "note" } });
    expect(searched.body.hits[0].source.id).toBeUndefined();
    expect(searched.body.hits[0].source.title).toBeUndefined();
    expect(searched.body.hits[0].text).toContain("Page the on-call engineer");
    expect((await send(viewer, "POST", `${path}/sources`, { kind: "text", title: "Mine", text: "words" })).body.code).toBe("READ_ONLY");
    expect((await send(viewer, "PATCH", path, { name: "Renamed" })).body.code).toBe("READ_ONLY");
    expect((await send(viewer, "POST", `${path}/reindex`, {})).status).toBe(403);
    expect((await send(viewer, "DELETE", path, {})).body.code).toBe("OWNER_ONLY");
    expect((await send(viewer, "GET", `${path}/access`)).status).toBe(403);
    expect((await send(viewer, "GET", "/knowledge")).body.knowledgeBases.map((kb: { id: string }) => kb.id)).toContain(kbId);

    // Manage: edits sources and shares at view only; never deletes; sees every title.
    const asManager = await send(manager, "GET", path);
    expect(asManager.body.knowledgeBase.yourLevel).toBe("manage");
    expect(asManager.body.knowledgeBase.sources.find((source: { kind: string }) => source.kind === "note")).toMatchObject({ title: "Owner's runbook", titleHidden: false });
    const added = await send(manager, "POST", `${path}/sources`, { kind: "text", title: "From the manager", text: "Gift cards never expire." });
    expect(added.status).toBe(201);
    // A manager's own note the owner cannot read is refused (T320), as is the owner's private note to them.
    const managersNote = await publishNote(manager, "# Manager only\n\nPrivate to the manager.");
    expect((await send(manager, "POST", `${path}/sources`, { kind: "note", noteId: managersNote })).status).toBe(404);
    expect((await send(manager, "GET", `${path}/candidates?kind=note&q=`)).body.candidates.map((item: { id: string }) => item.id)).not.toContain(managersNote);
    expect((await send(manager, "DELETE", `${path}/sources/${added.body.source.id}`, {})).status).toBe(200);
    expect((await send(manager, "DELETE", path, {})).body.code).toBe("OWNER_ONLY");
    const sheet = await send(manager, "GET", `${path}/access`);
    expect(sheet.body).toMatchObject({ yourLevel: "manage", levels: ["view"] });
    // A read-only team role is capped at view (D71).
    expect((await send(readOnly, "GET", path)).body.knowledgeBase.yourLevel).toBe("view");
    // Still nothing for the others (D73: an admin is nobody special).
    for (const session of [stranger, outsiderAdmin]) expect((await send(session, "GET", path)).status).toBe(404);
    // access_grants_v and the member access page list the rows.
    expect(db.query("SELECT level FROM access_grants_v WHERE kind = 'knowledge_base' AND resource_id = ? AND user_id = ?").get(kbId, manager.userId)).toEqual({ level: "manage" });
    expect(memberSharedRows(admin.userId, viewer.userId).find((row) => row.kind === "knowledge_base")).toMatchObject({ title: "Knowledge base owned by W44 access owner", titleHidden: true, level: "view" });
  });
});

describe("search_knowledge in chats (§5.2, T320)", () => {
  test("the picker lists bases; attaching needs the editor and the agent's owner to open them", async () => {
    const catalog = await send(owner, "GET", `/agents/catalog?agentId=${agentId}`);
    expect(catalog.body.catalog.knowledge.map((kb: { name: string }) => kb.name).sort()).toEqual(["Product notes", "Support FAQ"]);
    // A stranger cannot attach a base they cannot open.
    const theirs = await send(stranger, "POST", "/agents", { name: "Sneaky", providerId, tools: [{ source: "knowledge", kbId: otherKbId }] });
    expect(theirs.status).toBe(400);
    // The trifecta counts a knowledge base as private data.
    expect((await send(owner, "GET", `/agents/${agentId}`)).body.agent.tools).toEqual([{ source: "knowledge", kbId }]);
  });

  test("the runner's chat: the tool is auto, its results carry heading paths, and the owner sees the note's id and title", async () => {
    const { events } = await chatOnce(owner, agentId, "tool:knowledge__search_knowledge:{\"query\":\"How do refunds work?\"}");
    const call = events.find((event) => event.type === "tool_call")!;
    expect(call.data).toMatchObject({ tool: "search_knowledge", server: "knowledge" });
    expect(events.some((event) => event.type === "confirmation_required")).toBe(false);
    const result = events.find((event) => event.type === "tool_result")!;
    expect(result.data.ok).toBe(true);
    expect(result.data.resultPreview).toContain("Billing › How do refunds work?");
    const offered = toolTurns().filter((body) => body.tools?.some((tool) => tool.function.name === "knowledge__search_knowledge")).at(-1)!;
    const parameters = offered.tools!.find((tool) => tool.function.name === "knowledge__search_knowledge")!.function.parameters;
    expect(parameters.properties.kb.enum).toEqual([kbId]);
    const hits = resultJson(lastToolResult()).results;
    expect(hits[0]).toMatchObject({ heading: "Billing › How do refunds work?", source: { kind: "text", title: "Billing FAQ" }, kb: "Support FAQ" });
    // The owner can read the note: its id and title come back.
    await chatOnce(owner, agentId, "tool:knowledge__search_knowledge:{\"query\":\"on-call engineer\",\"k\":1}");
    expect(resultJson(lastToolResult()).results[0]).toMatchObject({ source: { kind: "note", id: noteId, title: "Owner's runbook" } });
  });

  test("a runner who cannot read the note gets its text, never its id or title (deliberate, documented)", async () => {
    expect((await share(owner, `/agents/${agentId}`, { audience: "selected", people: [{ id: stranger.userId, level: "view" }] })).status).toBe(200);
    await chatOnce(stranger, agentId, "tool:knowledge__search_knowledge:{\"query\":\"on-call engineer\",\"k\":1}");
    const [hit] = resultJson(lastToolResult()).results;
    expect(hit).toMatchObject({ heading: "Escalation", source: { kind: "note" } });
    expect(lastToolResult()).not.toContain("Owner's runbook");
    expect(hit!.source).toEqual({ kind: "note" });
    expect(hit!.text).toContain("Page the on-call engineer");
    // A base binned (or no longer open to the agent's owner) drops out at the next step.
    expect((await send(owner, "DELETE", `/knowledge/${kbId}`, {})).status).toBe(200);
    const before = toolTurns().length;
    const after = await chatOnce(owner, agentId, "tool:knowledge__search_knowledge:{\"query\":\"refunds\"}");
    expect(after.events.some((event) => event.type === "tool_result")).toBe(false);
    expect(toolTurns().slice(before).every((body) => !body.tools?.length)).toBe(true);
    expect((await send(owner, "POST", `/bin/knowledge_base/${kbId}/restore`, {})).status).toBe(200);
  });

  test("over the API: search_knowledge is offered (read-only, auto) and runs as the key's owner", async () => {
    const runKey = key(owner, [{ module: "agents", permission: "run", resourceKind: "agent", resourceId: agentId }], "rest");
    const response = await fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers: { Authorization: `Bearer ${runKey.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: "tool:knowledge__search_knowledge:{\"query\":\"refunds\"}" }) });
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", toolCalls: [{ name: "search_knowledge", server: "knowledge", ok: true }] });
    expect(body.output).toContain("Done:");
    const steps = db.query("SELECT tool_name, result_text FROM agent_audit_steps WHERE run_id = ? AND kind = 'tool'").all(body.runId) as Array<{ tool_name: string; result_text: string }>;
    expect(steps[0]!.tool_name).toBe("search_knowledge");
    expect(steps[0]!.result_text).toContain("How do refunds work?");
    // Read back later (the Audit log and GET …/runs/:runId) the call is still named as a knowledge search.
    const later = await (await fetch(`${origin}/api/v1/agents/${agentId}/runs/${body.runId}`, { headers: { Authorization: `Bearer ${runKey.token}` } })).json() as Record<string, any>;
    expect(later.toolCalls).toEqual([expect.objectContaining({ name: "search_knowledge", server: "knowledge", ok: true })]);
    const audited = await send(owner, "GET", `/agents/audit/${body.runId}`);
    expect(audited.body.run.timeline.find((step: { kind: string }) => step.kind === "tool")).toMatchObject({ server: "knowledge", tool: "search_knowledge" });
    const listed = await (await fetch(`${origin}/api/v1/agents`, { headers: { Authorization: `Bearer ${runKey.token}` } })).json() as { agents: Array<{ tools: string[] }> };
    expect(listed.agents[0]!.tools).toEqual(["knowledge/search_knowledge"]);
  });
});

describe("search_knowledge for keys (MCP, agents:read + a knowledge_base grant)", () => {
  test("grants: chosen bases need agents:read and a base the creator can open; it is never an agent's Nook tool", () => {
    const policies = readPolicies();
    expect(validateGrants(owner.userId, "member", [{ module: "agents", permission: "read", resources: [{ kind: "knowledge_base", id: kbId }] }], policies)).toEqual([kbGrant(kbId)]);
    const refused = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return error instanceof KeyError ? [error.status, error.code] : String(error); } };
    expect(refused(() => validateGrants(stranger.userId, "member", [{ module: "agents", permission: "read", resources: [{ kind: "knowledge_base", id: otherKbId }] }], policies))).toEqual([404, "RESOURCE_NOT_FOUND"]);
    expect(refused(() => validateGrants(owner.userId, "member", [{ module: "agents", permission: "read", resources: [{ kind: "agent", id: agentId }] }], policies))).toEqual([400, "INVALID_GRANT"]);
    expect(refused(() => validateGrants(owner.userId, "member", [{ module: "agents", permission: "run", resources: [{ kind: "knowledge_base", id: kbId }] }], policies))).toEqual([400, "INVALID_GRANT"]);
    expect(offeredSpecs().some((spec) => spec.name === "search_knowledge")).toBe(false);
    expect(mcpToolSpecs.find((spec) => spec.name === "search_knowledge")!.access).toEqual({ mode: "items", items: [{ arg: "kb", kind: "knowledge_base", ifAbsent: "allow" }] });
  });

  test("all bases, chosen bases, and no grant", async () => {
    const wide = key(owner, [all("agents", "read")]);
    const everything = await mcp(wide.id, "search_knowledge", { query: "refunds spring" });
    expect(everything.isError).toBe(false);
    expect(new Set(everything.value.results.map((hit: { kb: { name: string } }) => hit.kb.name))).toEqual(new Set(["Support FAQ", "Product notes"]));
    expect(everything.value.results.find((hit: { source: { kind: string } }) => hit.source.kind === "note")?.source.id ?? noteId).toBe(noteId);
    const one = await mcp(wide.id, "search_knowledge", { query: "refunds", kb: otherKbId });
    expect(one.value.results.every((hit: { kb: { id: string } }) => hit.kb.id === otherKbId)).toBe(true);

    const chosen = key(owner, [kbGrant(otherKbId)]);
    const live = loadLiveKey(chosen.id)!;
    // QA LOW-6: a key over chosen knowledge bases is not offered list_agents (it reads no agents).
    expect(mcpToolSpecs.filter((spec) => toolVisible(spec, live)).map((spec) => spec.name).sort()).toEqual(["search_knowledge"]);
    const narrowed = await mcp(chosen.id, "search_knowledge", { query: "refunds spring" });
    expect(narrowed.value.results.map((hit: { kb: { id: string } }) => hit.kb.id)).toEqual(narrowed.value.results.map(() => otherKbId));
    expect(narrowed.value.bases).toBe(1);
    expect((await mcp(chosen.id, "search_knowledge", { query: "refunds", kb: kbId })).value.code).toBe("NOT_FOUND");
    expect((await mcp(chosen.id, "list_chats", {})).value.code).toBe("SCOPE_REQUIRED");
    expect((await mcp(chosen.id, "list_agents", {})).value.code).toBe("SCOPE_REQUIRED");

    const none = key(owner, [all("notes", "read")]);
    expect(mcpToolSpecs.filter((spec) => toolVisible(spec, loadLiveKey(none.id)!)).some((spec) => spec.name === "search_knowledge")).toBe(false);
    expect((await mcp(none.id, "search_knowledge", { query: "refunds" })).value.code).toBe("SCOPE_REQUIRED");

    // A stranger's key with agents:read on every base reaches none of the owner's (D73).
    const theirs = key(stranger, [all("agents", "read")]);
    expect((await mcp(theirs.id, "search_knowledge", { query: "spring" })).value.results).toEqual([]);
    expect((await mcp(theirs.id, "search_knowledge", { query: "spring", kb: otherKbId })).value.code).toBe("NOT_FOUND");
    // The query's tokens count toward the key's owner and the key.
    expect((db.query("SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens FROM agent_usage_daily WHERE key_id = ?").get(wide.id) as { tokens: number }).tokens).toBeGreaterThan(0);
  });
});
