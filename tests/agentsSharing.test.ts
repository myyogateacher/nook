import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { call, makeKey } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { withoutNookAutoTools } from "./support/nookAuto";

const { deleteProvider } = await import("../server/agents/providers");
const { flushKeyUsage, createApiKey, validateGrants, resourceReachable } = await import("../server/apiKeys");
const { readPolicies } = await import("../server/team/policies");
const { shareLevel, shareLevelById } = await import("../server/agents/sharing");
const { resetPublicLimitsForTests, PUBLIC_LIMIT } = await import("../server/agents/publicShares");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetAgentRateLimitsForTests } = await import("../server/agents/limits");
const { listAccessNotices } = await import("../server/access/notices");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");

/**
 * Wave 43 "AC-D" (agent chat plan §6.2, §14 T311, T315, T316, §15 item 9, D356, D359, D361–D363):
 * sharing agents (view, manage) and chats (view) through the Access sheet's API, with groups; the
 * matrix of owner, viewer, manager, non-member, guest, and an admin who is not a member across agent
 * read/edit/delete, chat read, transcript, continue, and runs; a recipient's Nook tools through their
 * own linked key, never the owner's; Continue as a copy; public snapshots behind the policy; the Bin;
 * access_grants_v; Team → member access reductions; MCP get_chat and list_chats; agents:run on a
 * shared agent.
 */

retireUsersAfterFile();
// C2: this file covers the linked-key model; the automatic Nook tools are off for its run.
withoutNookAutoTools();
const fake = startFakeProvider(24563);
let admin: Session;
let owner: Session;
let viewer: Session;
let manager: Session;
let stranger: Session;
let guest: Session;
let outsiderAdmin: Session;
let viewerRole: Session;
let groupie: Session;
let providerId: string;
let agentId: string;
let groupId: string;

type Reply = { status: number; body: Record<string, any>; headers: Headers };
async function send(session: Session | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = session
    ? await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session)
    : await fetch(`${origin}/api${path}`, { method, headers });
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** GET then PUT …/access with its ETag. */
async function share(session: Session, kind: "agents" | "chats", id: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", `/${kind}/${id}/access`);
  if (current.status !== 200) return current;
  return send(session, "PUT", `/${kind}/${id}/access`, { people: [], groups: [], ...body }, { "If-Match": current.body.etag });
}

type SseEvent = { seq: number; type: string; data: Record<string, any> };
async function readEvents(session: Session, runId: string): Promise<{ status: number; events: SseEvent[] }> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/runs/${runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  if (response.status !== 200) return { status: response.status, events: [] };
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
        events.push({ seq: Number(lines.id), type: lines.event!, data: JSON.parse(lines.data!) });
      }
      if (events.some((event) => event.type === "done" || event.type === "snapshot")) { controller.abort(); break; }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return { status: 200, events };
}

async function sendAndWait(session: Session, chatId: string, content: string) {
  const started = await send(session, "POST", `/chats/${chatId}/messages`, { content });
  expect(started.status).toBe(201);
  const { events } = await readEvents(session, started.body.runId);
  return { runId: started.body.runId as string, messageId: started.body.assistantMessage.id as string, events };
}
const lastCompletion = () => fake.calls.filter((entry) => entry.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> };
const keyCalls = (keyId: string) => {
  flushKeyUsage();
  return (db.query("SELECT COALESCE(SUM(calls), 0) AS count FROM api_key_usage WHERE key_id = ?").get(keyId) as { count: number }).count;
};
async function setPolicy(on: boolean) {
  const current = await send(admin, "GET", "/agents/admin/settings");
  const written = await send(admin, "PUT", "/agents/admin/settings", { publicChatLinks: on, expectedRevision: current.body.settings.revision });
  expect(written.status).toBe(200);
}
const publicGet = (token: string) => fetch(`${origin}/api/public/chat-shares/${token}`);

beforeAll(async () => {
  admin = await createUser("W43 admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W43 owner");
  viewer = await createUser("W43 viewer");
  manager = await createUser("W43 manager");
  stranger = await createUser("W43 stranger");
  groupie = await createUser("W43 groupie");
  guest = await createUser("W43 guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  outsiderAdmin = await createUser("W43 outsider admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(outsiderAdmin.userId);
  viewerRole = await createUser("W43 read-only");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewerRole.userId);
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (sharing)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0043", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  const agent = await send(owner, "POST", "/agents", {
    name: "Shared helper", description: "Answers questions", systemPrompt: "SECRET-PROMPT-W43 be brief.", providerId, starters: ["Say hi"],
    tools: [{ source: "nook", toolName: "list_notes" }, { source: "nook", toolName: "list_boards" }]
  });
  expect(agent.status).toBe(201);
  agentId = agent.body.agent.id;
  const group = await send(admin, "POST", "/team/groups", { name: `W43 group ${crypto.randomUUID().slice(0, 6)}` });
  expect(group.status).toBe(201);
  groupId = group.body.group.id;
  expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [groupie.userId, guest.userId], revision: 1 })).status).toBe(200);
});
beforeEach(() => { resetMcpLimits(); resetAgentRateLimitsForTests(); resetPublicLimitsForTests(); });
afterAll(async () => {
  // Through the service: retireUsersAfterFile has already blocked this file's admin by now.
  const settings = readAgentSettings();
  if (settings.publicChatLinks) writeAgentSettings(admin.userId, { publicChatLinks: false }, settings.revision);
  deleteProvider(admin.userId, providerId);
  db.query("DELETE FROM user_groups WHERE id = ?").run(groupId);
  fake.stop();
});

describe("agents: the access matrix (D356)", () => {
  test("owner, viewer, manager, non-member, guest, and an admin who is not a member", async () => {
    // Before sharing: nobody else reaches it, an admin included (D73).
    for (const session of [viewer, manager, stranger, outsiderAdmin]) expect((await send(session, "GET", `/agents/${agentId}`)).status).toBe(404);
    // Guests cannot be named (they never reach Chat, AC-O2).
    const refused = await share(owner, "agents", agentId, { audience: "selected", people: [{ id: guest.userId, level: "view" }] });
    expect(refused).toMatchObject({ status: 400, body: { code: "GUEST_NOT_ALLOWED" } });
    // Chat levels are view only; agents view and manage.
    expect((await share(owner, "agents", agentId, { audience: "selected", people: [{ id: viewer.userId, level: "edit" }] })).body.code).toBe("LEVEL_NOT_OFFERED");
    const saved = await share(owner, "agents", agentId, { audience: "selected", people: [{ id: viewer.userId, level: "view" }, { id: manager.userId, level: "manage" }, { id: viewerRole.userId, level: "manage" }] });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("etag")).toBe(saved.body.etag);
    expect(saved.body).toMatchObject({ kind: "agent", audience: "selected", yourLevel: "owner", levels: ["view", "manage"], guestsExcluded: true });
    // A stale ETag is a 409 with the latest; no If-Match is 428.
    expect((await send(owner, "PUT", `/agents/${agentId}/access`, { audience: "private", people: [], groups: [] }, { "If-Match": "\"stale\"" })).body.code).toBe("ACCESS_CHANGED");
    expect((await send(owner, "PUT", `/agents/${agentId}/access`, { audience: "private", people: [], groups: [] })).status).toBe(428);

    // The viewer chats with it and never sees the prompt or the tools configuration.
    const asViewer = await send(viewer, "GET", `/agents/${agentId}`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.agent).toMatchObject({ yourLevel: "view", systemPrompt: null, tools: [], usesNook: true, ownerName: "W43 owner", starters: ["Say hi"] });
    expect(JSON.stringify(asViewer.body)).not.toContain("SECRET-PROMPT-W43");
    const listed = await send(viewer, "GET", "/agents");
    expect(listed.body.agents.find((item: { id: string }) => item.id === agentId)).toMatchObject({ yourLevel: "view", tools: [] });
    expect(JSON.stringify(listed.body)).not.toContain("SECRET-PROMPT-W43");
    expect((await send(viewer, "PATCH", `/agents/${agentId}`, { name: "Mine now", expectedRevision: asViewer.body.agent.revision })).body.code).toBe("READ_ONLY");
    expect((await send(viewer, "DELETE", `/agents/${agentId}`, {})).status).toBe(403);
    expect((await send(viewer, "GET", `/agents/${agentId}/access`)).status).toBe(403);
    expect((await send(viewer, "GET", `/agents/${agentId}/api-usage`)).status).toBe(403);
    expect((await send(viewer, "POST", "/chats", { agentId })).status).toBe(201);

    // The manager edits (the prompt included), shares at view only, and never deletes.
    const asManager = await send(manager, "GET", `/agents/${agentId}`);
    expect(asManager.body.agent).toMatchObject({ yourLevel: "manage", systemPrompt: "SECRET-PROMPT-W43 be brief." });
    expect(asManager.body.agent.tools).toHaveLength(2);
    const edited = await send(manager, "PATCH", `/agents/${agentId}`, { description: "Edited by the manager", expectedRevision: asManager.body.agent.revision });
    expect(edited.status).toBe(200);
    expect((await send(manager, "DELETE", `/agents/${agentId}`, {})).body.code).toBe("OWNER_ONLY");
    expect((await send(manager, "GET", `/agents/${agentId}/api-usage`)).status).toBe(200);
    const sheet = await send(manager, "GET", `/agents/${agentId}/access`);
    expect(sheet.body).toMatchObject({ yourLevel: "manage", levels: ["view"] });
    const people = sheet.body.people.map((person: { id: string; level: string }) => ({ id: person.id, level: person.level }));
    expect((await send(manager, "PUT", `/agents/${agentId}/access`, { audience: "selected", people: [...people, { id: stranger.userId, level: "manage" }], groups: [] }, { "If-Match": sheet.body.etag })).body.code).toBe("MANAGER_CAP");
    expect((await send(manager, "PUT", `/agents/${agentId}/access`, { audience: "all_users", people: [], groups: [] }, { "If-Match": sheet.body.etag })).body.code).toBe("MANAGER_CAP");
    const managerShared = await send(manager, "PUT", `/agents/${agentId}/access`, { audience: "selected", people: [...people, { id: stranger.userId, level: "view" }], groups: [] }, { "If-Match": sheet.body.etag });
    expect(managerShared.status).toBe(200);
    expect((await send(stranger, "GET", `/agents/${agentId}`)).status).toBe(200);
    // ...and the owner takes it back.
    expect((await share(owner, "agents", agentId, { audience: "selected", people })).status).toBe(200);

    // A viewer role is capped at view whatever the row says (D71).
    expect((await send(viewerRole, "GET", `/agents/${agentId}`)).body.agent).toMatchObject({ yourLevel: "view", systemPrompt: null });
    // Non-members, guests, and an admin who is not a member: 404 everywhere (D73).
    for (const session of [stranger, guest, outsiderAdmin]) {
      expect((await send(session, "GET", `/agents/${agentId}`)).status).toBe(404);
      expect((await send(session, "GET", `/agents/${agentId}/access`)).status).toBe(404);
      // Guests' writes stop at the role write gate (403 ROLE_READ_ONLY) before anything is looked up.
      expect((await send(session, "POST", "/chats", { agentId })).status).toBe(session === guest ? 403 : 404);
      expect((await send(session, "DELETE", `/agents/${agentId}`, {})).status).toBe(session === guest ? 403 : 404);
      expect((await send(session, "GET", "/agents")).body.agents?.some((item: { id: string }) => item.id === agentId) ?? false).toBe(false);
    }
    // The shared person heard about it (the bell names the agent only while they can open it).
    const notices = listAccessNotices(viewer.userId, { unread: false, limit: 20 });
    expect(notices.find((notice) => notice.title.includes("shared the agent “Shared helper”"))).toMatchObject({ href: `/chat/new?agent=${agentId}` });
  });

  test("groups (and their removal), everyone signed in without guests or integrations, and access_grants_v", async () => {
    const agent = (await send(owner, "POST", "/agents", { name: "Group agent", providerId })).body.agent;
    expect((await share(owner, "agents", agent.id, { audience: "selected", groups: [{ id: groupId, level: "view" }] })).status).toBe(200);
    expect((await send(groupie, "GET", `/agents/${agent.id}`)).status).toBe(200);
    // A guest in the group gets nothing (the module is not theirs).
    expect((await send(guest, "GET", `/agents/${agent.id}`)).status).toBe(404);
    expect(shareLevelById("agent", agent.id, guest.userId)).toBe("none");
    // The view lists the group's members as group rows (D270), and direct rows as direct.
    expect((await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: viewer.userId, level: "manage" }], groups: [{ id: groupId, level: "view" }] })).status).toBe(200);
    const rows = db.query("SELECT kind, user_id, level, via, group_id FROM access_grants_v WHERE resource_id = ? ORDER BY via, user_id").all(agent.id) as Array<Record<string, string | null>>;
    expect(rows).toContainEqual({ kind: "agent", user_id: viewer.userId, level: "manage", via: "direct", group_id: null });
    expect(rows).toContainEqual({ kind: "agent", user_id: groupie.userId, level: "view", via: "group", group_id: groupId });
    // Leaving the group (an admin removes the member) ends it at once.
    const groupRow = await send(admin, "GET", `/team/groups/${groupId}`);
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [guest.userId], revision: groupRow.body.group.revision })).status).toBe(200);
    expect((await send(groupie, "GET", `/agents/${agent.id}`)).status).toBe(404);
    const back = await send(admin, "GET", `/team/groups/${groupId}`);
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [groupie.userId, guest.userId], revision: back.body.group.revision })).status).toBe(200);
    expect((await send(groupie, "GET", `/agents/${agent.id}`)).status).toBe(200);
    // Removing the group grant ends it too.
    expect((await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: viewer.userId, level: "manage" }] })).status).toBe(200);
    expect((await send(groupie, "GET", `/agents/${agent.id}`)).status).toBe(404);
    // Everyone signed in: people, never guests or integrations; group rows no longer count.
    expect((await share(owner, "agents", agent.id, { audience: "all_users" })).status).toBe(200);
    expect((await send(stranger, "GET", `/agents/${agent.id}`)).body.agent.yourLevel).toBe("view");
    expect((await send(viewer, "GET", `/agents/${agent.id}`)).body.agent.yourLevel).toBe("view");
    expect((await send(guest, "GET", `/agents/${agent.id}`)).status).toBe(404);
    const integrationId = crypto.randomUUID();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES (?, ?, 'W43 bot', '!unusable:service', ?, 'member', 'service')").run(integrationId, `bot-${integrationId}@service.invalid`, new Date().toISOString());
    const row = db.query("SELECT id, owner_id, visibility, deleted_at FROM agents WHERE id = ?").get(agent.id) as { id: string; owner_id: string; visibility: string; deleted_at: string | null };
    expect(shareLevel("agent", row, integrationId)).toBe("none");
    expect(shareLevel("agent", row, stranger.userId)).toBe("view");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_access WHERE resource_id = ?").get(agent.id)).toEqual({ count: 0 });
  });

  test("a chosen-agent agents:run grant may name a shared agent the creator can view, re-checked on every call", async () => {
    const policies = readPolicies();
    const grant = [{ module: "agents" as const, permission: "run" as const, resources: [{ kind: "agent" as const, id: agentId }] }];
    expect(validateGrants(viewer.userId, "member", grant, policies)).toEqual([{ module: "agents", permission: "run", resourceKind: "agent", resourceId: agentId }]);
    expect(() => validateGrants(stranger.userId, "member", grant, policies)).toThrow();
    expect(resourceReachable(viewer.userId, "agent", agentId, "run")).toBe(true);
    expect(resourceReachable(outsiderAdmin.userId, "agent", agentId, "run")).toBe(false);
    const key = createApiKey(viewer.userId, { name: "W43 runner", surfaces: "rest", grants: [{ module: "agents", permission: "run", resourceKind: "agent", resourceId: agentId }], expiresInDays: 30 });
    const list = async () => (await (await fetch(`${origin}/api/v1/agents`, { headers: { Authorization: `Bearer ${key.token}` } })).json()) as { agents: Array<{ id: string }> };
    expect((await list()).agents.map((item) => item.id)).toEqual([agentId]);
    // The owner unshares: the key reaches nothing at its next call.
    const before = await send(owner, "GET", `/agents/${agentId}/access`);
    const people = before.body.people.map((person: { id: string; level: string }) => ({ id: person.id, level: person.level }));
    expect((await share(owner, "agents", agentId, { audience: "selected", people: people.filter((person: { id: string }) => person.id !== viewer.userId) })).status).toBe(200);
    expect((await list()).agents).toEqual([]);
    const run = await fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: "echo:hi" }) });
    expect(run.status).toBe(404);
    expect((await share(owner, "agents", agentId, { audience: "selected", people })).status).toBe(200);
  });
});

describe("a shared agent never uses its owner's access (D359, T311)", () => {
  test("the recipient's runs use the recipient's own linked key; a tool the owner's key reaches is not offered to them", async () => {
    const ownerKey = makeKey(owner, ["notes:read"], "Owner notes");
    const viewerKey = makeKey(viewer, ["tasks:read"], "Viewer boards");
    expect((await send(owner, "PUT", `/agents/${agentId}/link`, { nookKeyId: ownerKey.id })).status).toBe(200);
    // The owner's own chat: list_notes through the owner's key.
    const ownChat = (await send(owner, "POST", "/chats", { agentId })).body.chat;
    await sendAndWait(owner, ownChat.id, "echo:owner run");
    expect(lastCompletion().tools!.map((tool) => tool.function.name)).toEqual(["nook__list_notes"]);
    const ownerCallsBefore = keyCalls(ownerKey.id);
    // The viewer without a link: no Nook tools at all, whatever the owner linked.
    const chat = (await send(viewer, "POST", "/chats", { agentId })).body.chat;
    await sendAndWait(viewer, chat.id, "echo:no link");
    expect(lastCompletion().tools).toBeUndefined();
    // The viewer cannot link the owner's key (not theirs: the same 404).
    expect((await send(viewer, "PUT", `/agents/${agentId}/link`, { nookKeyId: ownerKey.id })).status).toBe(404);
    expect((await send(viewer, "PUT", `/agents/${agentId}/link`, { nookKeyId: viewerKey.id })).status).toBe(200);
    await sendAndWait(viewer, chat.id, "echo:linked");
    expect(lastCompletion().tools!.map((tool) => tool.function.name)).toEqual(["nook__list_boards"]);
    // The probe: the owner's key reaches list_notes; the viewer's model asks for it and gets nothing.
    const probe = await sendAndWait(viewer, chat.id, "tool:nook__list_notes:{}");
    const result = probe.events.find((event) => event.type === "tool_result")!;
    expect(result.data.ok).toBe(false);
    expect(lastCompletion().messages.find((turn) => turn.role === "tool")!.content).toContain("UNKNOWN_TOOL");
    const boards = await sendAndWait(viewer, chat.id, "tool:nook__list_boards:{}");
    expect(boards.events.find((event) => event.type === "tool_result")!.data.ok).toBe(true);
    // The owner's key was never used for the viewer's runs; the viewer's key was.
    expect(keyCalls(ownerKey.id)).toBe(ownerCallsBefore);
    expect(keyCalls(viewerKey.id)).toBeGreaterThan(0);
    const runs = db.query("SELECT user_id FROM agent_runs WHERE chat_id = ?").all(chat.id) as Array<{ user_id: string }>;
    expect(runs.every((row) => row.user_id === viewer.userId)).toBe(true);
    // Unsharing mid-life: the viewer's chat stays theirs and readable, and cannot send.
    const before = await send(owner, "GET", `/agents/${agentId}/access`);
    const people = before.body.people.map((person: { id: string; level: string }) => ({ id: person.id, level: person.level }));
    expect((await share(owner, "agents", agentId, { audience: "selected", people: people.filter((person: { id: string }) => person.id !== viewer.userId) })).status).toBe(200);
    expect((await send(viewer, "GET", `/chats/${chat.id}`)).status).toBe(200);
    expect((await send(viewer, "POST", `/chats/${chat.id}/messages`, { content: "echo:after" })).body.code).toBe("AGENT_GONE");
    expect((await share(owner, "agents", agentId, { audience: "selected", people })).status).toBe(200);
  });
});

describe("chats: sharing, the live transcript, and Continue as a copy (D361)", () => {
  test("recipients read the transcript live and read-only; others get 404; MCP get_chat and list_chats include it", async () => {
    const chat = (await send(owner, "POST", "/chats", { agentId })).body.chat;
    const first = await sendAndWait(owner, chat.id, "echo:the first answer");
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: viewer.userId, level: "manage" }] })).body.code).toBe("LEVEL_NOT_OFFERED");
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: viewer.userId, level: "view" }], groups: [{ id: groupId, level: "view" }] })).status).toBe(200);
    for (const reader of [viewer, groupie]) {
      const read = await send(reader, "GET", `/chats/${chat.id}`);
      expect(read.status).toBe(200);
      expect(read.body.chat).toMatchObject({ yourLevel: "view", ownerName: "W43 owner", audience: null, pinned: false });
      expect(read.body.messages.map((message: { content: string }) => message.content)).toContain("the first answer");
      expect(read.body.publicLink).toBeUndefined();
      expect((await send(reader, "GET", "/chats?shared=1")).body.chats.map((item: { id: string }) => item.id)).toContain(chat.id);
      expect((await send(reader, "GET", "/chats")).body.chats.map((item: { id: string }) => item.id)).not.toContain(chat.id);
      // Read-only: no send, rename, delete, branch switch, sheet, or regenerate.
      expect((await send(reader, "POST", `/chats/${chat.id}/messages`, { content: "echo:mine?" })).body.code).toBe("READ_ONLY");
      expect((await send(reader, "PATCH", `/chats/${chat.id}`, { title: "Nope", expectedRevision: read.body.chat.revision })).status).toBe(403);
      expect((await send(reader, "DELETE", `/chats/${chat.id}`, {})).status).toBe(403);
      expect((await send(reader, "POST", `/chats/${chat.id}/messages/${first.messageId}/regenerate`, {})).status).toBe(403);
      expect((await send(reader, "GET", `/chats/${chat.id}/access`)).status).toBe(403);
    }
    // The owner's run streams to a recipient (resume included); a stranger gets 404 on the chat and the run.
    const started = await send(owner, "POST", `/chats/${chat.id}/messages`, { content: "slow:30:one two three four five" });
    const followed = await readEvents(viewer, started.body.runId);
    expect(followed.events.filter((event) => event.type === "delta" || event.type === "snapshot").length).toBeGreaterThan(0);
    await readEvents(owner, started.body.runId);
    for (const outsider of [stranger, outsiderAdmin]) {
      expect((await send(outsider, "GET", `/chats/${chat.id}`)).status).toBe(404);
      expect((await readEvents(outsider, started.body.runId)).status).toBe(404);
      expect((await send(outsider, "GET", "/chats?shared=1")).body.chats.map((item: { id: string }) => item.id)).not.toContain(chat.id);
    }
    expect((await send(guest, "GET", `/chats/${chat.id}`)).status).toBe(404);
    // MCP: the recipient's agents:read key reads it (marked shared); a stranger's does not.
    const key = makeKey(viewer, ["agents:read"], "W43 reader");
    const listed = await call(key, "list_chats", {});
    expect(listed.value.chats.find((item: { id: string }) => item.id === chat.id)).toMatchObject({ shared: true, ownerName: "W43 owner" });
    const got = await call(key, "get_chat", { chatId: chat.id });
    expect(got.isError).toBe(false);
    expect(got.value.chat).toMatchObject({ id: chat.id, shared: true });
    expect(got.value.messages.map((message: { content: string }) => message.content)).toContain("the first answer");
    const strangerKey = makeKey(stranger, ["agents:read"], "W43 stranger reader");
    expect((await call(strangerKey, "get_chat", { chatId: chat.id })).value.code).toBe("NOT_FOUND");
    // The bell told the person named directly about the chat.
    expect(listAccessNotices(viewer.userId, { unread: false, limit: 30 }).some((notice) => notice.href === `/chat/${chat.id}`)).toBe(true);
  });

  test("Continue as a copy: owned by the recipient, private, noted, runs as them; the owner sees nothing of it", async () => {
    const chat = (await send(owner, "POST", "/chats", { agentId })).body.chat;
    const one = await sendAndWait(owner, chat.id, "echo:alpha");
    await sendAndWait(owner, chat.id, "echo:beta");
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: viewer.userId, level: "view" }, { id: stranger.userId, level: "view" }] })).status).toBe(200);
    // Reading the chat is not using its agent: the stranger cannot continue it.
    expect((await send(stranger, "POST", `/chats/${chat.id}/fork`, { messageId: one.messageId })).body.code).toBe("AGENT_NOT_SHARED");
    expect((await send(outsiderAdmin, "POST", `/chats/${chat.id}/fork`, { messageId: one.messageId })).status).toBe(404);
    const forked = await send(viewer, "POST", `/chats/${chat.id}/fork`, { messageId: one.messageId });
    expect(forked.status).toBe(201);
    expect(forked.body.chat).toMatchObject({ yourLevel: "owner", copiedFrom: "W43 owner", audience: "private", agentId });
    const copy = await send(viewer, "GET", `/chats/${forked.body.chat.id}`);
    expect(copy.body.messages.map((message: { role: string; content: string }) => `${message.role}:${message.content}`)).toEqual(["user:echo:alpha", "assistant:alpha"]);
    expect(copy.body.messages.every((message: { runId: string | null }) => message.runId === null)).toBe(true);
    expect((db.query("SELECT owner_id, copied_from_user_id FROM chats WHERE id = ?").get(forked.body.chat.id) as { owner_id: string; copied_from_user_id: string })).toEqual({ owner_id: viewer.userId, copied_from_user_id: owner.userId });
    // The owner sees nothing of it: not in their chats, not shared with them, a 404 on the id.
    expect((await send(owner, "GET", `/chats/${forked.body.chat.id}`)).status).toBe(404);
    expect((await send(owner, "GET", "/chats")).body.chats.map((item: { id: string }) => item.id)).not.toContain(forked.body.chat.id);
    expect((await send(owner, "GET", "/chats?shared=1")).body.chats.map((item: { id: string }) => item.id)).not.toContain(forked.body.chat.id);
    // The copy runs as the recipient (their run row, their usage), from the copied branch.
    const reply = await sendAndWait(viewer, forked.body.chat.id, "echo:gamma");
    expect(reply.events.at(-1)!.data.status).toBe("ok");
    expect(lastCompletion().messages.map((turn) => turn.content).filter(Boolean).join("|")).not.toContain("beta");
    expect((db.query("SELECT user_id FROM agent_runs WHERE id = ?").get(reply.runId) as { user_id: string }).user_id).toBe(viewer.userId);
    // The original is unchanged.
    expect((await send(owner, "GET", `/chats/${chat.id}`)).body.messages).toHaveLength(4);
  });

  test("the Bin: recipients lose access while it is binned; only the owner restores it, and access returns", async () => {
    const chat = (await send(owner, "POST", "/chats", { agentId })).body.chat;
    await sendAndWait(owner, chat.id, "echo:bin me");
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: viewer.userId, level: "view" }] })).status).toBe(200);
    expect((await send(owner, "DELETE", `/chats/${chat.id}`, {})).status).toBe(200);
    expect((await send(viewer, "GET", `/chats/${chat.id}`)).status).toBe(404);
    expect((await send(viewer, "GET", "/chats?shared=1")).body.chats.map((item: { id: string }) => item.id)).not.toContain(chat.id);
    expect((await send(viewer, "POST", `/bin/chat/${chat.id}/restore`, {})).status).toBe(404);
    const restored = await send(owner, "POST", `/bin/chat/${chat.id}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.visibility).toBe("selected");
    expect((await send(viewer, "GET", `/chats/${chat.id}`)).status).toBe(200);
    // An agent in the Bin: its viewers and managers lose it; the manager cannot restore it.
    const agent = (await send(owner, "POST", "/agents", { name: "Binned agent", providerId })).body.agent;
    expect((await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: viewer.userId, level: "view" }, { id: manager.userId, level: "manage" }] })).status).toBe(200);
    expect((await send(owner, "DELETE", `/agents/${agent.id}`, {})).status).toBe(200);
    for (const session of [viewer, manager]) {
      expect((await send(session, "GET", `/agents/${agent.id}`)).status).toBe(404);
      expect((await send(session, "POST", "/chats", { agentId: agent.id })).status).toBe(404);
      expect((await send(session, "POST", `/bin/agent/${agent.id}/restore`, {})).status).toBe(404);
    }
    expect((await send(owner, "POST", `/bin/agent/${agent.id}/restore`, {})).status).toBe(200);
    expect((await send(manager, "GET", `/agents/${agent.id}`)).body.agent.yourLevel).toBe("manage");
  });
});

describe("public links (AC-O1, D362, T315, T316)", () => {
  test("off by default: every route 404 and nothing offered", async () => {
    const chat = (await send(owner, "POST", "/chats", { agentId })).body.chat;
    expect((await send(owner, "GET", "/agents/status")).body.publicChatLinks).toBe(false);
    expect((await send(owner, "GET", `/chats/${chat.id}/public`)).status).toBe(404);
    expect((await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false })).status).toBe(404);
    expect((await send(owner, "DELETE", `/chats/${chat.id}/public`, {})).status).toBe(404);
    expect((await publicGet("a".repeat(43))).status).toBe(404);
  });

  test("create, hash only, headers, results hidden by default, frozen until Update, new link, revoke, policy off and on, Bin", async () => {
    await setPolicy(true);
    expect((await send(owner, "GET", "/agents/status")).body.publicChatLinks).toBe(true);
    expect((await send(viewerRole, "GET", "/agents/status")).body.publicChatLinks).toBe(false);
    // A chat with a Nook tool call (the owner's linked key from above reaches list_notes).
    const chat = (await send(owner, "POST", "/chats", { agentId })).body.chat;
    const toolRun = await sendAndWait(owner, chat.id, "tool:nook__list_notes:{}");
    expect(toolRun.events.find((event) => event.type === "tool_result")!.data.ok).toBe(true);
    // Only the owner, member and above: a recipient is refused, a stranger gets 404.
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: viewer.userId, level: "view" }] })).status).toBe(200);
    expect((await send(viewer, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false })).status).toBe(403);
    expect((await send(stranger, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false })).status).toBe(404);
    const created = await send(owner, "PUT", `/chats/${chat.id}/public`, {});
    expect(created.status).toBe(200);
    expect(created.body.url).toMatch(new RegExp(`^${origin}/share/c/[A-Za-z0-9_-]{43}$`));
    expect(created.body.link.includeToolResults).toBe(false);
    const token = created.body.url.split("/").at(-1) as string;
    // Only the SHA-256 of the token is stored; the token appears nowhere in the database row.
    const row = db.query("SELECT * FROM chat_public_shares WHERE chat_id = ?").get(chat.id) as Record<string, string>;
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await send(owner, "GET", `/chats/${chat.id}/public`)).body.link).toMatchObject({ includeToolResults: false });
    expect((await send(owner, "GET", `/chats/${chat.id}`)).body.publicLink).toMatchObject({ includeToolResults: false });
    // The public read: no session, the strict header set, names only.
    const response = await publicGet(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.json() as { snapshot: { ownerName: string; agentName: string; title: string; includeToolResults: boolean; messages: Array<{ role: string; content: string; toolCalls: Array<Record<string, unknown>> }> } };
    expect(body.snapshot).toMatchObject({ ownerName: "W43 owner", agentName: "Shared helper", includeToolResults: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain(owner.email);
    expect(text).not.toContain(chat.id);
    expect(text).not.toContain(owner.userId);
    // Tool calls by name only; arguments and results hidden by default.
    const calls = body.snapshot.messages.flatMap((message) => message.toolCalls);
    expect(calls).toEqual([{ tool: "list_notes", server: "nook", ok: true }]);
    // The page: no-index, no-store, and a CSP that allows only Nook's own files.
    const page = await fetch(`${origin}/share/c/${token}`);
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // A later message is not in the snapshot until Update; Update keeps the same link.
    await sendAndWait(owner, chat.id, "echo:a later turn");
    const frozen = await (await publicGet(token)).json() as typeof body;
    expect(frozen.snapshot.messages.map((message) => message.content)).not.toContain("a later turn");
    const updated = await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: true });
    expect(updated.body.url).toBeNull();
    const fresh = await (await publicGet(token)).json() as typeof body;
    expect(fresh.snapshot.messages.map((message) => message.content)).toContain("a later turn");
    expect(fresh.snapshot.includeToolResults).toBe(true);
    expect(fresh.snapshot.messages.flatMap((message) => message.toolCalls)[0]).toMatchObject({ tool: "list_notes", args: expect.any(String), result: expect.any(String) });
    // New link: the old token stops working at once.
    const replaced = await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false, newLink: true });
    const next = replaced.body.url.split("/").at(-1) as string;
    expect(next).not.toBe(token);
    expect((await publicGet(token)).status).toBe(404);
    expect((await publicGet(next)).status).toBe(200);
    // Policy off: 404 at once, the row kept; on again: back.
    await setPolicy(false);
    expect((await publicGet(next)).status).toBe(404);
    expect((await send(owner, "GET", `/chats/${chat.id}/public`)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM chat_public_shares WHERE chat_id = ?").get(chat.id)).toEqual({ count: 1 });
    await setPolicy(true);
    expect((await publicGet(next)).status).toBe(200);
    // The Bin: 404 while binned, back on restore.
    expect((await send(owner, "DELETE", `/chats/${chat.id}`, {})).status).toBe(200);
    expect((await publicGet(next)).status).toBe(404);
    expect((await send(owner, "POST", `/bin/chat/${chat.id}/restore`, {})).status).toBe(200);
    expect((await publicGet(next)).status).toBe(200);
    // Malformed tokens never reach the database.
    expect((await publicGet("short")).status).toBe(404);
    // Revoke deletes the row; then 404.
    expect((await send(owner, "DELETE", `/chats/${chat.id}/public`, {})).status).toBe(200);
    expect((await publicGet(next)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM chat_public_shares WHERE chat_id = ?").get(chat.id)).toEqual({ count: 0 });
    expect((await send(owner, "DELETE", `/chats/${chat.id}/public`, {})).status).toBe(404);
  });

  test("60 requests a minute per address, then 429 with Retry-After", async () => {
    await setPolicy(true);
    resetPublicLimitsForTests();
    const unknown = "b".repeat(43);
    for (let index = 0; index < PUBLIC_LIMIT.perMinute; index += 1) expect((await publicGet(unknown)).status).toBe(404);
    const limited = await publicGet(unknown);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    resetPublicLimitsForTests();
  });
});

describe("Team → member access: agents and chats, reductions only (D268, D269)", () => {
  test("the admin sees redacted rows, lowers a manager, removes a share and a group membership, and Reset clears direct rows", async () => {
    const agent = (await send(owner, "POST", "/agents", { name: "Member access agent", providerId })).body.agent;
    const chat = (await send(owner, "POST", "/chats", { agentId: agent.id })).body.chat;
    expect((await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: manager.userId, level: "manage" }], groups: [{ id: groupId, level: "view" }] })).status).toBe(200);
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: manager.userId, level: "view" }] })).status).toBe(200);
    const summary = await send(admin, "GET", `/team/members/${manager.userId}/access`);
    expect(summary.status).toBe(200);
    const rows = summary.body.chat as Array<{ kind: string; title: string; titleHidden: boolean; id?: string; level: string; sources: Array<{ via: string; level: string; lowerTo: string[]; handle?: string }> }>;
    const agentRow = rows.find((row) => row.kind === "agent" && row.title === "Agent owned by W43 owner" && row.level === "manage")!;
    expect(agentRow).toMatchObject({ titleHidden: true });
    expect(agentRow.id).toBeUndefined();
    expect(JSON.stringify(summary.body)).not.toContain("Member access agent");
    expect(agentRow.sources[0]).toMatchObject({ via: "direct", lowerTo: ["view"] });
    // Lower manage → view (never up), then remove the chat share. Titles are hidden, so every agent the
    // manager manages (this one and the matrix's) is lowered; raising is refused.
    expect((await send(admin, "PATCH", `/team/members/${manager.userId}/access/${encodeURIComponent(agentRow.sources[0]!.handle!)}`, { level: "manage" })).status).toBe(400);
    for (const row of rows.filter((item) => item.kind === "agent" && item.level === "manage")) {
      expect((await send(admin, "PATCH", `/team/members/${manager.userId}/access/${encodeURIComponent(row.sources[0]!.handle!)}`, { level: "view" })).status).toBe(200);
    }
    expect((await send(manager, "GET", `/agents/${agent.id}`)).body.agent.yourLevel).toBe("view");
    const chatRow = rows.find((row) => row.kind === "chat" && row.title === "Chat owned by W43 owner")!;
    expect((await send(admin, "DELETE", `/team/members/${manager.userId}/access/${encodeURIComponent(chatRow.sources[0]!.handle!)}`, {})).status).toBe(200);
    expect((await send(manager, "GET", `/chats/${chat.id}`)).status).toBe(404);
    // The owner heard about both.
    const ownerNotices = listAccessNotices(owner.userId, { unread: false, limit: 20 }).map((notice) => notice.title);
    expect(ownerNotices.some((title) => title.includes("lowered") && title.includes("W43 manager"))).toBe(true);
    expect(ownerNotices.some((title) => title.includes("removed W43 manager's access to the chat"))).toBe(true);
    // A group row: removing it takes the person out of the group.
    const groupieRows = (await send(admin, "GET", `/team/members/${groupie.userId}/access`)).body.chat as typeof rows;
    const viaGroup = groupieRows.find((row) => row.kind === "agent" && row.sources.some((source) => source.via === "group"))!;
    expect((await send(admin, "DELETE", `/team/members/${groupie.userId}/access/${encodeURIComponent(viaGroup.sources.find((source) => source.via === "group")!.handle!)}`, {})).body.removed).toBe("group");
    expect((await send(groupie, "GET", `/agents/${agent.id}`)).status).toBe(404);
    const back = await send(admin, "GET", `/team/groups/${groupId}`);
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [groupie.userId, guest.userId], revision: back.body.group.revision })).status).toBe(200);
    // The person's own view (Settings → My access) has no handles.
    const mine = await send(manager, "GET", "/me/access");
    expect((mine.body.chat as typeof rows).every((row) => row.sources.every((source) => source.handle === undefined))).toBe(true);
    // Reset access removes their direct agent and chat rows, counted with the direct shares.
    const counts = (await send(admin, "GET", `/team/members/${manager.userId}/access`)).body.resetCounts;
    expect(counts.directShares).toBeGreaterThan(0);
    expect((await send(admin, "POST", `/team/members/${manager.userId}/access/reset`, {})).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_access WHERE user_id = ?").get(manager.userId)).toEqual({ count: 0 });
    expect((await send(manager, "GET", `/agents/${agentId}`)).status).toBe(404);
    // Put the shared agent back for the files that follow (the matrix's manager).
    const before = await send(owner, "GET", `/agents/${agentId}/access`);
    const people = before.body.people.map((person: { id: string; level: string }) => ({ id: person.id, level: person.level }));
    expect((await share(owner, "agents", agentId, { audience: "selected", people: [...people, { id: manager.userId, level: "manage" }] })).status).toBe(200);
  });
});
