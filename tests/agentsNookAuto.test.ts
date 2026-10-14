import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, type Session } from "./support/harness";
import { api, makeKey } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { settleAgentRunsAfterEach } from "./support/agentRuns";

const { deleteProvider } = await import("../server/agents/providers");
const { ensureInternalAgentKey, internalAgentKeyId, hashKeyToken, INTERNAL_AGENT_KEY_NAME, listApiKeys, narrowApiKey, KeyError } = await import("../server/apiKeys");
const { chatNookKey } = await import("../server/agents/tools");

/**
 * C2: agents get Nook's tools with no key to link. Each runner gets one hidden internal key (every
 * module's read plus `inbox:write`), created on first need and only for that person; writes are
 * Inbox proposals; the tools agents never get stay out; a guest, a blocked account, or a revoked
 * key get nothing; the admin setting and the agent's toggle turn it off; a linked key is preferred;
 * and the key is refused over HTTP and MCP.
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();
const fake = startFakeProvider(0);
let admin: Session;
let member: Session;
let providerId: string;

type SseEvent = { seq: number; type: string; data: Record<string, any> };
async function readEvents(session: Session, runId: string, options: { after?: number; until?: (events: SseEvent[]) => boolean } = {}): Promise<SseEvent[]> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/runs/${runId}/events?after=${options.after ?? 0}`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
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
        events.push({ seq: Number(lines.id), type: lines.event, data: JSON.parse(lines.data) });
      }
      if ((options.until ?? finished)(events)) { controller.abort(); break; }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return events;
}
const finished = (events: SseEvent[]) => events.some((event) => event.type === "done" || event.type === "snapshot");
const awaitingConfirmation = (events: SseEvent[]) => events.some((event) => event.type === "confirmation_required") || finished(events);
const lastTools = () => ((fake.calls.filter((call) => call.path === "/v1/chat/completions").at(-1)!.body as { tools?: Array<{ function: { name: string; description: string } }> }).tools ?? []);

async function newAgent(session: Session, patch: Record<string, unknown> = {}) {
  const created = await api(session, "POST", "/agents", { name: "Auto Nook", systemPrompt: "Help.", providerId, ...patch });
  expect(created.status).toBe(201);
  return created.body.agent as { id: string; revision: number; nookAuto: boolean };
}
async function newChat(session: Session, agentId: string) {
  const created = await api(session, "POST", "/chats", { agentId });
  expect(created.status).toBe(201);
  return created.body.chat.id as string;
}
async function send(session: Session, chatId: string, content: string, until = finished) {
  const started = await api(session, "POST", `/chats/${chatId}/messages`, { content });
  expect(started.status).toBe(201);
  return { runId: started.body.runId as string, events: await readEvents(session, started.body.runId, { until }) };
}
const catalogNames = async (session: Session, agentId: string) => {
  const catalog = (await api(session, "GET", `/agents/catalog?agentId=${agentId}`)).body.catalog;
  return { nook: catalog.nook as { linked: boolean; auto: string; tools: Array<{ name: string }> }, names: (catalog.nook.tools as Array<{ name: string }>).map((tool) => tool.name) };
};
async function setAutoSetting(on: boolean) {
  const current = (await api(admin, "GET", "/agents/admin/settings")).body.settings;
  const saved = await api(admin, "PUT", "/agents/admin/settings", { nookAutoTools: on, expectedRevision: current.revision });
  expect(saved.status).toBe(200);
  expect(saved.body.settings.nookAutoTools).toBe(on);
}

beforeAll(async () => {
  admin = await createUser("Auto admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Auto member");
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (auto nook)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0057", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
});
afterAll(() => {
  deleteProvider(admin.userId, providerId);
  fake.stop();
});

describe("the internal agents key (C2)", () => {
  test("created once per person, with every module's read plus inbox:write, listed read-only", () => {
    const person = member.userId;
    const first = ensureInternalAgentKey(person)!;
    expect(first).toBeTruthy();
    expect(ensureInternalAgentKey(person)).toBe(first);
    expect((db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND internal = 1").get(person) as { count: number }).count).toBe(1);
    const listed = listApiKeys(person).keys.find((key) => key.id === first)!;
    expect(listed).toMatchObject({ internal: true, name: INTERNAL_AGENT_KEY_NAME, prefix: "internal", surfaces: "mcp", state: "active" });
    const scopes = [...listed.scopes].sort();
    expect(scopes).toContain("inbox:write");
    for (const scope of ["notes:read", "files:read", "tasks:read", "calendar:read", "collections:read", "reports:read"]) expect(scopes).toContain(scope);
    // Reads only, besides inbox:write: never a module write, the Bin, the vault, or agents.
    expect(scopes.filter((scope) => !scope.endsWith(":read") && scope !== "inbox:write")).toEqual([]);
    expect(scopes.some((scope) => scope.startsWith("agents:") || scope.startsWith("bin:") || scope.startsWith("vault"))).toBe(false);
    // It does not count toward the person's key limit, and it cannot be edited or rotated.
    expect(listApiKeys(person).liveCount).toBe(0);
    expect(() => narrowApiKey(person, first, { name: "Mine now" })).toThrow(KeyError);
  });

  test("never for a guest or a blocked account", async () => {
    const guest = await createUser("Auto guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect(ensureInternalAgentKey(guest.userId)).toBeNull();
    expect(chatNookKey({ id: crypto.randomUUID(), nook_auto: 1 }, guest.userId)).toBeNull();
    const blocked = await createUser("Auto blocked");
    const keyId = ensureInternalAgentKey(blocked.userId)!;
    expect(chatNookKey({ id: crypto.randomUUID(), nook_auto: 1 }, blocked.userId)?.key.keyId).toBe(keyId);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    expect(chatNookKey({ id: crypto.randomUUID(), nook_auto: 1 }, blocked.userId)).toBeNull();
    expect(ensureInternalAgentKey(blocked.userId)).toBeNull();
  });

  test("refused over HTTP and MCP, even with its token", async () => {
    const keyId = ensureInternalAgentKey(member.userId)!;
    // Its token is never kept; pretend one leaked by giving the row a token we know.
    const token = `mynotes_${"x".repeat(43)}`;
    db.query("UPDATE mcp_api_keys SET token_hash = ? WHERE id = ?").run(hashKeyToken(token), keyId);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", Origin: origin };
    const mcp = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(401);
    expect(((await mcp.json()) as { code: string }).code).toBe("KEY_INVALID");
    const rest = await fetch(`${origin}/api/v1/me`, { headers });
    expect(rest.status).toBe(401);
    expect(((await rest.json()) as { code: string }).code).toBe("KEY_INVALID");
  });
});

describe("agents get Nook's tools automatically (C2)", () => {
  test("an agent with no picks gets the reads and proposals; the never-offered tools stay out", async () => {
    const agent = await newAgent(member);
    expect(agent.nookAuto).toBe(true);
    const { nook, names } = await catalogNames(member, agent.id);
    expect(nook.auto).toBe("on");
    expect(nook.linked).toBe(false);
    for (const name of ["list_notes", "read_note", "list_boards", "create_card", "get_report", "list_reports"]) expect(names).toContain(name);
    for (const name of ["update_report_query", "list_report_datasources", "submit_proposals", "begin_upload", "bin_note", "restore_card", "list_agents", "run_agent", "list_chats"]) expect(names).not.toContain(name);
    const chatId = await newChat(member, agent.id);
    await send(member, chatId, "echo:hello");
    const offered = lastTools().map((tool) => tool.function.name);
    expect(offered).toContain("nook__list_notes");
    expect(offered).toContain("nook__create_card");
    expect(offered.some((name) => /update_report_query|bin_|vault|run_agent|begin_upload/.test(name))).toBe(false);
  });

  test("writes are Inbox proposals, even with direct writes on; audited as internal", async () => {
    const agent = await newAgent(member, { nookDirectWrites: true });
    const board = await api(member, "POST", "/tasks/boards", { name: "Auto board" });
    const boardId = board.body.board.id as string;
    const columnId = board.body.columns[0].id as string;
    const chatId = await newChat(member, agent.id);
    await send(member, chatId, "echo:tools?");
    expect(lastTools().find((tool) => tool.function.name === "nook__create_card")!.function.description).toContain("becomes a proposal");
    expect(lastTools().some((tool) => tool.function.name === "nook__move_card")).toBe(false);
    const since = new Date().toISOString();
    const { runId, events } = await send(member, chatId, `tool:nook__create_card:${JSON.stringify({ boardId, columnId, title: "Auto proposed" })}`, awaitingConfirmation);
    const card = events.find((event) => event.type === "confirmation_required")!;
    expect(card.data).toMatchObject({ tool: "create_card", server: "nook", proposal: true });
    expect((await api(member, "POST", `/runs/${runId}/confirm`, { confirmationId: card.data.confirmationId, argsHash: card.data.argsHash, decision: "once" })).status).toBe(200);
    const rest = await readEvents(member, runId, { after: card.seq });
    const result = rest.find((event) => event.type === "tool_result")!;
    expect(result.data.proposalId).toBeTruthy();
    const proposal = db.query("SELECT status, key_id, owner_id FROM proposals WHERE id = ?").get(result.data.proposalId) as Record<string, string>;
    expect(proposal).toMatchObject({ status: "pending", key_id: internalAgentKeyId(member.userId)!, owner_id: member.userId });
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE title = 'Auto proposed'").get() as { count: number }).count).toBe(0);
    const audited = db.query("SELECT metadata_json FROM audit_log WHERE created_at >= ? AND metadata_json LIKE '%\"internal\":true%' AND metadata_json LIKE '%\"via\":\"agent\"%'").all(since);
    expect(audited.length).toBeGreaterThan(0);
  });

  test("the agent's toggle and the admin setting turn it off", async () => {
    const agent = await newAgent(member);
    const off = await api(member, "PATCH", `/agents/${agent.id}`, { nookAuto: false, expectedRevision: agent.revision });
    expect(off.body.agent.nookAuto).toBe(false);
    let catalog = await catalogNames(member, agent.id);
    expect(catalog.nook.auto).toBe("off_agent");
    expect(catalog.names).toEqual([]);
    const other = await newAgent(member);
    await setAutoSetting(false);
    try {
      catalog = await catalogNames(member, other.id);
      expect(catalog.nook.auto).toBe("off_admin");
      expect(catalog.names).toEqual([]);
      const chatId = await newChat(member, other.id);
      await send(member, chatId, "echo:anything?");
      expect(lastTools().some((tool) => tool.function.name.startsWith("nook__"))).toBe(false);
    } finally {
      await setAutoSetting(true);
    }
    expect((await catalogNames(member, other.id)).nook.auto).toBe("on");
  });

  test("a linked key is preferred over the internal one", async () => {
    const agent = await newAgent(member);
    const notesOnly = makeKey(member, ["notes:read"], "Auto notes only");
    expect((await api(member, "PUT", `/agents/${agent.id}/link`, { nookKeyId: notesOnly.id })).status).toBe(200);
    const { nook, names } = await catalogNames(member, agent.id);
    expect(nook.linked).toBe(true);
    expect(names).toContain("list_notes");
    expect(names).not.toContain("list_boards");
    // The internal key is never linkable.
    const linkable = (await api(member, "GET", `/agents/${agent.id}/link`)).body.keys.map((key: { id: string }) => key.id);
    expect(linkable).not.toContain(internalAgentKeyId(member.userId));
    expect((await api(member, "PUT", `/agents/${agent.id}/link`, { nookKeyId: internalAgentKeyId(member.userId) })).status).toBe(404);
  });

  test("revoking the internal key turns the tools off until the person turns them on again", async () => {
    const person = await createUser("Auto revoker");
    const agent = await newAgent(person);
    expect((await catalogNames(person, agent.id)).names).toContain("list_notes");
    const keyId = internalAgentKeyId(person.userId)!;
    expect((await api(person, "DELETE", `/keys/${keyId}`, {})).status).toBe(200);
    let catalog = await catalogNames(person, agent.id);
    expect(catalog.nook.auto).toBe("revoked");
    expect(catalog.names).toEqual([]);
    expect(internalAgentKeyId(person.userId)).toBeNull();
    expect((await api(person, "POST", "/agents/nook-key/restore", {})).status).toBe(200);
    catalog = await catalogNames(person, agent.id);
    expect(catalog.nook.auto).toBe("on");
    expect(internalAgentKeyId(person.userId)).not.toBe(keyId);
  });
});
