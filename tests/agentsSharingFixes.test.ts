import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { settleAgentRunsAfterEach } from "./support/agentRuns";

const { resetAgentRateLimitsForTests } = await import("../server/agents/limits");
const { deleteProvider } = await import("../server/agents/providers");
const { listAccessNotices } = await import("../server/access/notices");
const { chatUpdateListeners } = await import("../server/agents/chatUpdates");
const { STREAM_CAPS } = await import("../server/agents/routes");

/**
 * Wave 43 fixes (AC-D sharing): QA M1 (a recipient with a shared chat open hears the owner's new
 * messages and follows the reply), review L5 (recipients get the active branch only), review L4 (the
 * owner hears of a manager's edits), and QA L3 (a binned agent is "no longer available" to anyone
 * but its owner). Review M1, L1, L2, and L3 are covered in agentsSharingReview.test.ts.
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();
const fake = startFakeProvider(0);
const mcp = startFakeMcpServer(0);
let admin: Session;
let owner: Session;
let reader: Session;
let manager: Session;
let stranger: Session;
let providerId: string;
let serverId: string;

type Reply = { status: number; body: Record<string, any> };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}
async function share(session: Session, kind: "agents" | "chats", id: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", `/${kind}/${id}/access`);
  expect(current.status).toBe(200);
  const saved = await send(session, "PUT", `/${kind}/${id}/access`, { people: [], groups: [], ...body }, { "If-Match": current.body.etag });
  expect(saved.status).toBe(200);
}

type SseEvent = { type: string; data: Record<string, any>; at: number };
/** An open SSE stream: the events so far, a wait for one that matches, and close. */
async function openStream(session: Session, path: string) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api${path}`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  const events: SseEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  if (response.status === 200) {
    void (async () => {
      const body = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await body.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at = buffer.indexOf("\n\n");
          while (at >= 0) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf("\n\n");
            if (frame.startsWith(":")) continue;
            const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
            events.push({ type: lines.event!, data: JSON.parse(lines.data!), at: Date.now() });
            notify?.();
          }
        }
      } catch { /* aborted */ }
      finished = true;
      notify?.();
    })();
  } else {
    await response.text();
  }
  const waitFor = async (match: (events: SseEvent[]) => boolean, ms = 8000) => {
    const until = Date.now() + ms;
    while (!match(events)) {
      if (finished || Date.now() > until) throw new Error(`stream ${path}: no matching event (${events.map((event) => event.type).join(", ")})`);
      await new Promise<void>((resolve) => { notify = resolve; setTimeout(resolve, 50); });
    }
    return events;
  };
  return { status: response.status, events, waitFor, close: () => controller.abort(), get finished() { return finished; } };
}
const has = (type: string) => (events: SseEvent[]) => events.some((event) => event.type === type);

async function untilListeners(chatId: string, count: number) {
  const until = Date.now() + 5000;
  while (chatUpdateListeners(chatId) !== count) {
    if (Date.now() > until) throw new Error(`listeners: ${chatUpdateListeners(chatId)}, expected ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitRunEnded(session: Session, runId: string) {
  const stream = await openStream(session, `/runs/${runId}/events?after=0`);
  expect(stream.status).toBe(200);
  await stream.waitFor((events) => events.some((event) => event.type === "done" || event.type === "snapshot"));
  stream.close();
  return stream.events;
}

beforeAll(async () => {
  admin = await createUser("W43F admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W43F owner");
  reader = await createUser("W43F reader");
  manager = await createUser("W43F manager");
  stranger = await createUser("W43F stranger");
  const provider = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (W43 fixes)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-w43f", defaultModel: "gpt-6-luna" });
  expect(provider.status).toBe(201);
  providerId = provider.body.provider.id;
  const server = await send(admin, "POST", "/agents/admin/servers", { name: "W43 Fix Tools", url: mcp.url, availability: "all", timeoutMs: 5000, resultCapBytes: 4096 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect((await send(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
});
beforeEach(() => { resetAgentRateLimitsForTests(); });
afterAll(() => {
  db.query("DELETE FROM agent_tools WHERE server_id = ?").run(serverId);
  db.query("DELETE FROM agent_tool_servers WHERE id = ?").run(serverId);
  deleteProvider(admin.userId, providerId);
  fake.stop();
  mcp.stop();
});

async function sharedChat(name: string) {
  const agent = (await send(owner, "POST", "/agents", { name, providerId })).body.agent;
  await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
  const chat = (await send(owner, "POST", "/chats", { agentId: agent.id })).body.chat;
  await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
  return { agentId: agent.id as string, chatId: chat.id as string };
}

describe("QA M1: a recipient's open chat hears the owner", () => {
  test("the owner's new message and its streamed reply reach the recipient's open chat within a few seconds", async () => {
    const { chatId } = await sharedChat("W43F live");
    const opened = await send(reader, "GET", `/chats/${chatId}`);
    expect(opened.status).toBe(200);
    expect(opened.body.messages).toHaveLength(0);
    const updates = await openStream(reader, `/chats/${chatId}/updates?since=${opened.body.chat.revision}`);
    expect(updates.status).toBe(200);
    await untilListeners(chatId, 1);
    const sentAt = Date.now();
    const started = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:W43F the owner speaks" });
    expect(started.status).toBe(201);
    const events = await updates.waitFor(has("run_started"), 5000);
    expect(events.find((event) => event.type === "message_added")!.data).toMatchObject({ messageId: started.body.userMessage.id });
    const runStarted = events.find((event) => event.type === "run_started")!;
    expect(runStarted.data).toMatchObject({ runId: started.body.runId, messageId: started.body.assistantMessage.id });
    expect(runStarted.at - sentAt).toBeLessThan(3000);
    // Ids and the revision only, never text.
    expect(JSON.stringify(events)).not.toContain("the owner speaks");
    // The recipient follows the run it was told of, and reads the streamed reply.
    const run = await waitRunEnded(reader, runStarted.data.runId);
    expect(run.filter((event) => event.type === "delta").map((event) => event.data.text).join("")).toContain("W43F the owner speaks");
    expect(Date.now() - sentAt).toBeLessThan(8000);
    const after = await send(reader, "GET", `/chats/${chatId}`);
    expect(after.body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(after.body.messages[1].content).toContain("W43F the owner speaks");
    // A branch switch or rename is a `chat_changed`.
    const renamed = await send(owner, "PATCH", `/chats/${chatId}`, { title: "Renamed by the owner", expectedRevision: after.body.chat.revision });
    expect(renamed.status).toBe(200);
    await updates.waitFor(has("chat_changed"));
    updates.close();
    await untilListeners(chatId, 0);
  }, 20_000);

  test("catch-up from an old revision, gone when unshared or deleted, the 404 for strangers, and the per-chat cap", async () => {
    const { chatId } = await sharedChat("W43F gone");
    expect((await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:first" })).status).toBe(201);
    const runId = (await send(owner, "GET", `/chats/${chatId}/run`)).body.run?.id as string | undefined;
    if (runId) await waitRunEnded(owner, runId);
    // Behind: the first event says so at once.
    const behind = await openStream(reader, `/chats/${chatId}/updates?since=0`);
    expect(behind.status).toBe(200);
    expect((await behind.waitFor((events) => events.length > 0))[0]!.type).toBe("chat_changed");
    behind.close();
    // Strangers, and an id that is not one, get the 404.
    expect((await openStream(stranger, `/chats/${chatId}/updates`)).status).toBe(404);
    expect((await openStream(reader, `/chats/not-an-id/updates`)).status).toBe(404);
    // Four per person per chat; the fifth is 429.
    await untilListeners(chatId, 0);
    const open = [];
    for (let index = 0; index < STREAM_CAPS.perRun; index += 1) {
      const stream = await openStream(reader, `/chats/${chatId}/updates?since=999999`);
      expect(stream.status).toBe(200);
      open.push(stream);
    }
    const fifth = await openStream(reader, `/chats/${chatId}/updates?since=999999`);
    expect(fifth.status).toBe(429);
    for (const stream of open.slice(1)) stream.close();
    await untilListeners(chatId, 1);
    // Unshared: the open stream says `gone` and ends.
    await share(owner, "chats", chatId, { audience: "private" });
    await open[0]!.waitFor(has("gone"));
    await untilListeners(chatId, 0);
    // The owner's own other tab hears a delete.
    const ownTab = await openStream(owner, `/chats/${chatId}/updates?since=999999`);
    await untilListeners(chatId, 1);
    expect((await send(owner, "DELETE", `/chats/${chatId}`, {})).status).toBe(200);
    await ownTab.waitFor(has("gone"));
  }, 20_000);
});

describe("review L5: recipients get the active branch only", () => {
  test("the owner's other versions of a message stay with the owner", async () => {
    const { chatId } = await sharedChat("W43F branches");
    const first = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:W43F first version" });
    await waitRunEnded(owner, first.body.runId);
    // An edit of the first message: a new root sibling, which becomes the active branch.
    const edited = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:W43F second version", parentId: null });
    expect(edited.status).toBe(201);
    await waitRunEnded(owner, edited.body.runId);
    const mine = await send(owner, "GET", `/chats/${chatId}`);
    expect(mine.body.messages).toHaveLength(4);
    const theirs = await send(reader, "GET", `/chats/${chatId}`);
    expect(theirs.body.messages.map((message: { id: string }) => message.id)).toEqual([edited.body.userMessage.id, edited.body.assistantMessage.id]);
    expect(JSON.stringify(theirs.body.messages)).not.toContain("first version");
  });
});

describe("review L4: the owner hears of a manager's edits", () => {
  test("a bell notice for the prompt, the tools, direct writes, and the trifecta; none for other fields or the owner's own edits", async () => {
    const agent = (await send(owner, "POST", "/agents", { name: "W43F managed", providerId, tools: [{ source: "server", serverId, toolName: "echo", policy: null }, { source: "nook", toolName: "list_notes" }] })).body.agent;
    expect(agent.trifecta).toBe(false);
    await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: manager.userId, level: "manage" }] });
    const notices = () => db.query("SELECT kind, actor_id, count FROM access_notices WHERE user_id = ? AND resource_id = ? ORDER BY created_at, rowid").all(owner.userId, agent.id) as Array<{ kind: string; actor_id: string; count: number }>;
    let current = (await send(manager, "GET", `/agents/${agent.id}`)).body.agent;
    // The manager adds an open-world tool next to Nook's: the tools changed (2) and the trifecta turned on (8).
    let saved = await send(manager, "PATCH", `/agents/${agent.id}`, { tools: [...current.tools, { source: "server", serverId, toolName: "fetch_page", policy: null }], expectedRevision: current.revision });
    expect(saved.status).toBe(200);
    expect(saved.body.agent.trifecta).toBe(true);
    expect(notices()).toEqual([{ kind: "agent_changed", actor_id: manager.userId, count: 10 }]);
    const line = listAccessNotices(owner.userId, { unread: true, limit: 20 }).find((item) => item.title.includes("W43F managed"))!;
    expect(line.title).toBe("W43F manager changed the tools on your agent “W43F managed”; it can now read your Nook and reach the open web (the trifecta)");
    expect(line.href).toBe(`/settings/agents/${agent.id}`);
    // Other fields, an unchanged prompt, and the same tools in another order say nothing.
    current = saved.body.agent;
    saved = await send(manager, "PATCH", `/agents/${agent.id}`, { name: "W43F managed", description: "New words", systemPrompt: current.systemPrompt, tools: [...current.tools].reverse(), expectedRevision: current.revision });
    expect(saved.status).toBe(200);
    expect(notices()).toHaveLength(1);
    // The owner's own edits never notify the owner.
    saved = await send(owner, "PATCH", `/agents/${agent.id}`, { systemPrompt: "Owner's words", nookDirectWrites: true, expectedRevision: saved.body.agent.revision });
    expect(saved.status).toBe(200);
    expect(notices()).toHaveLength(1);
    // Turning direct writes off (4) with a new prompt (1) is one notice naming both.
    saved = await send(manager, "PATCH", `/agents/${agent.id}`, { systemPrompt: "Manager's words", nookDirectWrites: false, expectedRevision: saved.body.agent.revision });
    expect(saved.status).toBe(200);
    expect(notices().at(-1)).toEqual({ kind: "agent_changed", actor_id: manager.userId, count: 5 });
    expect(listAccessNotices(owner.userId, { unread: true, limit: 20 })[0]!.title).toBe("W43F manager changed the system prompt and direct Nook writes on your agent “W43F managed”");
  });
});

describe("QA L3: a binned agent is the Bin to its owner and 'no longer available' to everyone else", () => {
  test("the owner's chat and a recipient's copy word it differently", async () => {
    const { agentId, chatId } = await sharedChat("W43F binned");
    const first = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:W43F before the Bin" });
    await waitRunEnded(owner, first.body.runId);
    const copy = await send(reader, "POST", `/chats/${chatId}/fork`, { messageId: first.body.assistantMessage.id });
    expect(copy.status).toBe(201);
    expect((await send(reader, "GET", `/chats/${copy.body.chat.id}`)).body.agentState).toBe("usable");
    expect((await send(owner, "DELETE", `/agents/${agentId}`, {})).status).toBe(200);
    const theirs = await send(reader, "POST", `/chats/${copy.body.chat.id}/messages`, { content: "echo:after" });
    expect([theirs.status, theirs.body.code]).toEqual([409, "AGENT_GONE"]);
    expect(theirs.body.error).toBe("This chat's agent is no longer available; start a new chat with another agent");
    expect((await send(reader, "GET", `/chats/${copy.body.chat.id}`)).body.agentState).toBe("unavailable");
    const mine = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:after" });
    expect([mine.status, mine.body.code, mine.body.error]).toEqual([409, "AGENT_GONE", "This chat's agent is in the Bin; restore it to continue"]);
    expect((await send(owner, "GET", `/chats/${chatId}`)).body.agentState).toBe("binned");
    // Continuing the owner's chat (still shared with the recipient) words it the same way.
    const again = await send(reader, "POST", `/chats/${chatId}/fork`, { messageId: first.body.assistantMessage.id });
    expect([again.status, again.body.error]).toEqual([409, "This chat's agent is no longer available; start a new chat with another agent"]);
  });
});
