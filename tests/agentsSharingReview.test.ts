import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";

const { shareLevel, shareReadableSql } = await import("../server/agents/sharing");
const { resetPublicLimitsForTests } = await import("../server/agents/publicShares");
const { resetAgentRateLimitsForTests } = await import("../server/agents/limits");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { deleteProvider } = await import("../server/agents/providers");
const { registeredMigrationIds, runMigrations } = await import("../server/migrations");
const { agentSharingMigration } = await import("../server/migrations/041_agent_sharing");

/**
 * Wave 43 (AC-D) independent security review probes. Tests named "FINDING" assert the secure
 * behaviour; they were `test.failing` until the Wave 43 fixes and pass now.
 *
 * 1. The TS live level (`shareLevel`) and its SQL twin (`shareReadableSql`) agree on every principal.
 * 2. A recipient following a live run never receives the owner's confirmation card.
 * 3. A manager's view of an agent the owner (an admin) built with tools from an admins-only server.
 * 4. Public links: no cookies on the doors, a demoted owner's link, the page's 404 for revoked links.
 * 5. Migration 041 keeps every pre-041 `access_grants_v` row, is idempotent, and its unique index holds.
 */

retireUsersAfterFile();
const fake = startFakeProvider(0);
const mcp = startFakeMcpServer(0);
let admin: Session;
let owner: Session;
let reader: Session;
let manager: Session;
let providerId: string;
let serverId: string;
const serverSlug = "w43-review-tools";

type Reply = { status: number; body: Record<string, any>; headers: Headers };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}
async function share(session: Session, kind: "agents" | "chats", id: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", `/${kind}/${id}/access`);
  if (current.status !== 200) return current;
  return send(session, "PUT", `/${kind}/${id}/access`, { people: [], groups: [], ...body }, { "If-Match": current.body.etag });
}

type SseEvent = { seq: number; type: string; data: Record<string, any> };
async function readEvents(session: Session, runId: string, until: (events: SseEvent[]) => boolean): Promise<{ status: number; events: SseEvent[] }> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/runs/${runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  if (response.status !== 200) return { status: response.status, events: [] };
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), 15_000);
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
      if (until(events)) { controller.abort(); break; }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return { status: 200, events };
}
const ended = (events: SseEvent[]) => events.some((event) => event.type === "done" || event.type === "snapshot");
const carded = (events: SseEvent[]) => events.some((event) => event.type === "confirmation_required") || ended(events);

async function setPolicy(on: boolean) {
  const current = await send(admin, "GET", "/agents/admin/settings");
  expect((await send(admin, "PUT", "/agents/admin/settings", { publicChatLinks: on, expectedRevision: current.body.settings.revision })).status).toBe(200);
}

beforeAll(async () => {
  admin = await createUser("W43R admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W43R owner");
  reader = await createUser("W43R reader");
  manager = await createUser("W43R manager");
  const provider = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (W43 review)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-w43r", defaultModel: "gpt-6-luna" });
  expect(provider.status).toBe(201);
  providerId = provider.body.provider.id;
  const server = await send(admin, "POST", "/agents/admin/servers", { name: "W43 Review Tools", url: mcp.url, availability: "all", timeoutMs: 5000, resultCapBytes: 4096 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect(server.body.server.slug).toBe(serverSlug);
  expect((await send(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
});
beforeEach(() => { resetAgentRateLimitsForTests(); resetPublicLimitsForTests(); });
afterAll(async () => {
  const settings = readAgentSettings();
  if (settings.publicChatLinks) writeAgentSettings(admin.userId, { publicChatLinks: false }, settings.revision);
  db.query("DELETE FROM agent_tools WHERE server_id = ?").run(serverId);
  db.query("DELETE FROM agent_tool_servers WHERE id = ?").run(serverId);
  deleteProvider(admin.userId, providerId);
  fake.stop();
  mcp.stop();
});

// ------------------------------------------------------------------------------------------------ 1

describe("review 1: shareLevel and shareReadableSql agree", () => {
  const at = new Date().toISOString();
  const ids: Record<string, string> = {};
  const person = (name: string, role: string, options: { kind?: string; blocked?: boolean } = {}) => {
    const id = crypto.randomUUID();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind, disabled_at) VALUES (?, ?, ?, '!unusable', ?, ?, ?, ?)")
      .run(id, `w43r-${id}@example.test`, `W43R ${name}`, at, role, options.kind ?? "person", options.blocked ? at : null);
    ids[name] = id;
    return id;
  };
  const sqlReadable = (kind: "agent" | "chat", id: string, userId: string) => {
    const table = kind === "agent" ? "agents" : "chats";
    return db.query(`SELECT 1 FROM ${table} x WHERE x.id = $id AND ${shareReadableSql(kind, "x")}`).get({ id, userId }) !== null;
  };
  const rowOf = (kind: "agent" | "chat", id: string) =>
    db.query(`SELECT id, owner_id, visibility, deleted_at FROM ${kind === "agent" ? "agents" : "chats"} WHERE id = ?`).get(id) as { id: string; owner_id: string; visibility: string; deleted_at: string | null };

  let groupId: string;
  let agentSelected: string;
  let agentAll: string;
  let agentBinned: string;
  let chatSelected: string;
  let blockedOwnerAgent: string;

  beforeAll(() => {
    for (const [name, role] of [["owner", "member"], ["direct-view", "member"], ["direct-manage", "member"], ["group-view", "member"], ["group-manage", "member"],
      ["removed", "member"], ["guest-direct", "guest"], ["guest-group", "guest"], ["viewer-role-manage", "viewer"], ["outsider-admin", "admin"], ["outsider", "member"]] as const) person(name, role);
    person("integration-direct", "member", { kind: "service" });
    person("integration-group", "member", { kind: "service" });
    person("blocked-direct", "member", { blocked: true });
    person("blocked-owner", "member", { blocked: true });
    groupId = crypto.randomUUID();
    db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(groupId, `W43R ${groupId.slice(0, 8)}`, at, at);
    for (const name of ["group-view", "guest-group", "integration-group"]) db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(groupId, ids[name]!, at);
    const managersGroup = crypto.randomUUID();
    db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(managersGroup, `W43R m ${managersGroup.slice(0, 8)}`, at, at);
    db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(managersGroup, ids["group-manage"]!, at);
    const agent = (owner: string, visibility: string, deleted = false) => {
      const id = crypto.randomUUID();
      db.query("INSERT INTO agents (id, owner_id, name, created_at, updated_at, visibility, deleted_at) VALUES (?, ?, 'W43R matrix', ?, ?, ?, ?)").run(id, owner, at, at, visibility, deleted ? at : null);
      return id;
    };
    const grant = (kind: string, id: string, who: { user?: string; group?: string }, level: string) =>
      db.query("INSERT INTO agent_access (resource_kind, resource_id, user_id, group_id, level, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(kind, id, who.user ?? null, who.group ?? null, level, at);
    const grantAll = (kind: string, id: string) => {
      grant(kind, id, { user: ids["direct-view"] }, "view");
      grant(kind, id, { user: ids["direct-manage"] }, kind === "agent" ? "manage" : "view");
      grant(kind, id, { user: ids["viewer-role-manage"] }, kind === "agent" ? "manage" : "view");
      grant(kind, id, { user: ids["guest-direct"] }, "view");
      grant(kind, id, { user: ids["integration-direct"] }, "view");
      grant(kind, id, { user: ids["blocked-direct"] }, "view");
      grant(kind, id, { group: groupId }, "view");
      grant(kind, id, { group: managersGroup }, kind === "agent" ? "manage" : "view");
    };
    agentSelected = agent(ids.owner!, "selected");
    grantAll("agent", agentSelected);
    agentAll = agent(ids.owner!, "all_users");
    grantAll("agent", agentAll);
    agentBinned = agent(ids.owner!, "selected", true);
    grantAll("agent", agentBinned);
    blockedOwnerAgent = agent(ids["blocked-owner"]!, "private");
    chatSelected = crypto.randomUUID();
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, created_at, updated_at, visibility) VALUES (?, ?, ?, 'W43R chat', ?, ?, 'selected')").run(chatSelected, ids.owner!, agentSelected, at, at);
    grantAll("chat", chatSelected);
    // "removed": was in the group, then taken out.
    db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(groupId, ids.removed!, at);
    db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, ids.removed!);
  });

  test("the expected levels (selected agent)", () => {
    const level = (name: string) => shareLevel("agent", rowOf("agent", agentSelected), ids[name]!);
    expect(level("owner")).toBe("owner");
    expect(level("direct-view")).toBe("view");
    expect(level("direct-manage")).toBe("manage");
    expect(level("group-view")).toBe("view");
    expect(level("group-manage")).toBe("manage");
    expect(level("viewer-role-manage")).toBe("view");
    for (const name of ["removed", "guest-direct", "guest-group", "outsider-admin", "outsider", "blocked-direct"]) expect(level(name)).toBe("none");
    // D287: an integration shared by name (or through a group) reaches it, as in the other modules.
    expect(level("integration-direct")).toBe("view");
    expect(level("integration-group")).toBe("view");
    // all_users: people only (never guests or integrations); group and direct rows do not count (no manage).
    const all = (name: string) => shareLevel("agent", rowOf("agent", agentAll), ids[name]!);
    expect(all("outsider")).toBe("view");
    expect(all("outsider-admin")).toBe("view");
    expect(all("direct-manage")).toBe("view");
    expect(all("integration-direct")).toBe("none");
    expect(all("guest-direct")).toBe("none");
    // Chats cap at view whatever the row says.
    expect(shareLevel("chat", rowOf("chat", chatSelected), ids["direct-manage"]!)).toBe("view");
    expect(shareLevel("chat", rowOf("chat", chatSelected), ids["group-manage"]!)).toBe("view");
    // Binned: nobody.
    for (const name of ["owner", "direct-view", "direct-manage"]) expect(shareLevel("agent", rowOf("agent", agentBinned), ids[name]!)).toBe("none");
  });

  test("TS and SQL agree for every principal on every item, the blocked owner included", () => {
    const disagreements: string[] = [];
    for (const [kind, id] of [["agent", agentSelected], ["agent", agentAll], ["agent", agentBinned], ["chat", chatSelected], ["agent", blockedOwnerAgent]] as const) {
      for (const [name, userId] of Object.entries(ids)) {
        const ts = shareLevel(kind, rowOf(kind, id), userId) !== "none";
        const sql = sqlReadable(kind, id, userId);
        if (ts !== sql) disagreements.push(`${kind}:${id === blockedOwnerAgent ? "blocked-owner-agent" : id.slice(0, 8)}:${name}: ts=${ts} sql=${sql}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("FINDING L1 (fixed): a blocked owner reads as 'none' in SQL as in TS (shareReadableSql checks disabled_at for the owner)", () => {
    expect(sqlReadable("agent", blockedOwnerAgent, ids["blocked-owner"]!)).toBe(shareLevel("agent", rowOf("agent", blockedOwnerAgent), ids["blocked-owner"]!) !== "none");
  });
});

// ------------------------------------------------------------------------------------------------ 2

describe("review 2: a recipient following a run that waits on a confirmation", () => {
  let recipientEvents: SseEvent[] = [];
  let runId = "";

  test("setup: the owner's run waits on a card; the recipient follows it; the recipient's confirm is refused", async () => {
    const agent = await send(owner, "POST", "/agents", { name: "W43R confirmer", providerId, tools: [{ source: "server", serverId, toolName: "write_thing", policy: null }] });
    expect(agent.status).toBe(201);
    const chat = (await send(owner, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat;
    expect((await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: reader.userId, level: "view" }] })).status).toBe(200);
    const started = await send(owner, "POST", `/chats/${chat.id}/messages`, { content: `tool:${serverSlug}__write_thing:{"what":"W43R-PRIVATE-ARG"}` });
    expect(started.status).toBe(201);
    runId = started.body.runId;
    const own = await readEvents(owner, runId, carded);
    const card = own.events.find((event) => event.type === "confirmation_required");
    expect(card).toBeDefined();
    // The chat detail hides the card from the recipient (as built)...
    expect((await send(reader, "GET", `/chats/${chat.id}`)).body.pendingConfirmation).toBeNull();
    // ...and the stream replays the ring to them, then follows live to the end (after the owner's answer below).
    const following = readEvents(reader, runId, ended);
    // The card never reaches them (FINDING L2 below); even with its nonce and hash in hand, the
    // recipient cannot answer it: they can read the chat, so it is 403 READ_ONLY, not a 404.
    const refused = await send(reader, "POST", `/runs/${runId}/confirm`, { confirmationId: card!.data.confirmationId, argsHash: card!.data.argsHash, decision: "once" });
    expect([refused.status, refused.body.code]).toEqual([403, "READ_ONLY"]);
    const stopped = await send(reader, "POST", `/runs/${runId}/cancel`, {});
    expect([stopped.status, stopped.body.code]).toEqual([403, "READ_ONLY"]);
    // A stranger cannot follow it at all.
    expect((await readEvents(manager, runId, ended)).status).toBe(404);
    // The owner denies; the run finishes.
    expect((await send(owner, "POST", `/runs/${runId}/confirm`, { confirmationId: card!.data.confirmationId, argsHash: card!.data.argsHash, decision: "deny" })).status).toBe(200);
    await readEvents(owner, runId, ended);
    const followed = await following;
    expect(followed.status).toBe(200);
    recipientEvents = followed.events;
    // They saw the call and its (denied) result, the transcript as the owner did, minus the card and its outcome.
    expect(recipientEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["run", "tool_call", "tool_result", "done"]));
    expect(recipientEvents.some((event) => event.type === "confirmation_resolved")).toBe(false);
  });

  test("FINDING L2 (fixed): the live stream never sends recipients the owner's confirmation card (nonce, args hash, full arguments)", () => {
    expect(recipientEvents.length).toBeGreaterThan(0);
    expect(recipientEvents.some((event) => event.type === "confirmation_required")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ 3

describe("review 3: a manager and an admin owner's tools from an admins-only server", () => {
  let agentId = "";
  let managerView: Record<string, any> = {};

  test("setup: the manager keeps the owner's admins-only pick on save, and cannot add new picks from it", async () => {
    const created = await send(admin, "POST", "/agents", { name: "W43R admin agent", providerId, tools: [{ source: "server", serverId, toolName: "echo", policy: null }] });
    expect(created.status).toBe(201);
    agentId = created.body.agent.id;
    const server = await send(admin, "GET", `/agents/admin/servers/${serverId}`);
    expect((await send(admin, "PATCH", `/agents/admin/servers/${serverId}`, { availability: "admins", expectedRevision: server.body.server.revision })).status).toBe(200);
    expect((await share(admin, "agents", agentId, { audience: "selected", people: [{ id: manager.userId, level: "manage" }] })).status).toBe(200);
    const read = await send(manager, "GET", `/agents/${agentId}`);
    expect(read.status).toBe(200);
    managerView = read.body.agent;
    // The pick is withheld from the manager and counted (FINDING L3 below).
    expect(managerView.tools).toHaveLength(0);
    expect(managerView.hiddenTools).toBe(1);
    // Saving the list as read keeps the pick (decision 5): the save re-merges what the manager was not shown.
    const kept = await send(manager, "PATCH", `/agents/${agentId}`, { tools: managerView.tools, expectedRevision: managerView.revision });
    expect(kept.status).toBe(200);
    expect((await send(admin, "GET", `/agents/${agentId}`)).body.agent.tools).toEqual([{ source: "server", serverId, toolName: "echo", policy: null }]);
    // A new pick from the server the manager cannot use is refused.
    const added = await send(manager, "PATCH", `/agents/${agentId}`, { tools: [...managerView.tools, { source: "server", serverId, toolName: "fetch_page", policy: null }], expectedRevision: kept.body.agent.revision });
    expect(added.status).toBe(400);
    // The manager's own runs never get the admins-only tool (resolveTools uses the runner's role).
    const back = await send(admin, "GET", `/agents/admin/servers/${serverId}`);
    expect((await send(admin, "PATCH", `/agents/admin/servers/${serverId}`, { availability: "all", expectedRevision: back.body.server.revision })).status).toBe(200);
  });

  test("FINDING L3 (fixed): the manager is not shown the owner's picks from a server they cannot see (server id and tool name)", () => {
    expect(managerView.tools.some((tool: { serverId?: string }) => tool.serverId === serverId)).toBe(false);
  });

  test("a manager can switch on direct Nook writes for the owner's agent (design: manage = edit); the owner gets a bell notice (review L4)", async () => {
    const current = await send(manager, "GET", `/agents/${agentId}`);
    const flipped = await send(manager, "PATCH", `/agents/${agentId}`, { nookDirectWrites: true, systemPrompt: "Changed by a manager", expectedRevision: current.body.agent.revision });
    expect(flipped.status).toBe(200);
    expect((await send(admin, "GET", `/agents/${agentId}`)).body.agent.nookDirectWrites).toBe(true);
    const notices = db.query("SELECT kind, actor_id, count FROM access_notices WHERE user_id = ? AND resource_id = ?").all(admin.userId, agentId) as Array<{ kind: string; actor_id: string; count: number }>;
    // The system prompt (1) and direct Nook writes (4); the earlier no-op save of the tools said nothing.
    expect(notices).toEqual([{ kind: "agent_changed", actor_id: manager.userId, count: 5 }]);
  });
});

// ------------------------------------------------------------------------------------------------ 4

describe("review 4: public links", () => {
  test("the doors set no cookie; an unknown and a revoked token answer alike; a demoted owner's link closes until re-promotion", async () => {
    await setPolicy(true);
    const agent = (await send(owner, "POST", "/agents", { name: "W43R public", providerId })).body.agent;
    const chat = (await send(owner, "POST", "/chats", { agentId: agent.id })).body.chat;
    const started = await send(owner, "POST", `/chats/${chat.id}/messages`, { content: "echo:public words" });
    await readEvents(owner, started.body.runId, ended);
    const created = await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false });
    expect(created.status).toBe(200);
    const token = (created.body.url as string).split("/").at(-1)!;
    // The API and the page: no Set-Cookie, no session needed, strict headers on the 404 too.
    for (const path of [`/api/public/chat-shares/${token}`, `/share/c/${token}`]) {
      const response = await fetch(`${origin}${path}`);
      await response.text();
      // The page needs a built client (dist), which the test server may not have: its status is not asserted here.
      if (path.startsWith("/api/")) expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    // An `includeToolResults` snuck in through an unknown field is refused (strict schema).
    expect((await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false, include_tool_results: true })).status).toBe(400);
    // Revoked versus never existed: the same status, body, and headers.
    const replaced = await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false, newLink: true });
    const fresh = (replaced.body.url as string).split("/").at(-1)!;
    const revoked = await fetch(`${origin}/api/public/chat-shares/${token}`);
    const unknown = await fetch(`${origin}/api/public/chat-shares/${"Z".repeat(43)}`);
    expect([revoked.status, await revoked.text()]).toEqual([unknown.status, await unknown.text()]);
    expect(revoked.headers.get("content-security-policy")).toBe(unknown.headers.get("content-security-policy"));
    const revokedPage = await fetch(`${origin}/share/c/${token}`);
    await revokedPage.text();
    expect(revokedPage.status).toBe(404);
    expect(revokedPage.headers.get("x-robots-tag")).toContain("noindex");
    // Demoted to viewer (a role that may not create links): the existing link closes (review L3)...
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    try {
      expect((await send(owner, "PUT", `/chats/${chat.id}/public`, { includeToolResults: false })).status).toBe(403);
      const closed = await fetch(`${origin}/api/public/chat-shares/${fresh}`);
      await closed.text();
      expect(closed.status).toBe(404);
    } finally {
      db.query("UPDATE users SET role = 'member' WHERE id = ?").run(owner.userId);
    }
    // ...and opens again on re-promotion (the row was kept).
    const reopened = await fetch(`${origin}/api/public/chat-shares/${fresh}`);
    await reopened.text();
    expect(reopened.status).toBe(200);
    expect((await send(owner, "DELETE", `/chats/${chat.id}/public`, {})).status).toBe(200);
    await setPolicy(false);
  });
});

// ------------------------------------------------------------------------------------------------ 5

describe("review 5: migration 041 on a 040 database", () => {
  /** Inserts one row into `table` with dummy values for every NOT NULL column (checks and FKs off). */
  function seedRow(database: Database, table: string, overrides: Record<string, string | number | null>) {
    const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const values: Record<string, string | number | null> = {};
    for (const column of columns) {
      if (column.name in overrides) values[column.name] = overrides[column.name]!;
      else if (column.notnull && column.dflt_value === null) values[column.name] = /INT|REAL/i.test(column.type) ? 1 : `${table}-${column.name}`;
    }
    const names = Object.keys(values);
    database.query(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((name) => values[name]!));
  }

  test("every non-agent row of access_grants_v is identical before and after; idempotent; the unique index holds", () => {
    expect(registeredMigrationIds).toContain(41);
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    database.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (41, 'skipped', '2026-10-06T00:00:00.000Z')").run();
    runMigrations(database);
    // A v0.28.0 database: the 025 view, with rows in every source table.
    const before040 = (database.query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'access_grants_v'").get() as { sql: string }).sql;
    expect(before040).not.toContain("agent_access");
    database.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
    const levels: Record<string, string> = { note_shares: "edit", folder_shares: "comment", document_shares: "view", board_members: "manage", task_view_members: "view", collection_members: "edit", calendar_members: "view" };
    const keyColumn: Record<string, string> = { note_shares: "note_id", folder_shares: "folder_id", document_shares: "document_id", board_members: "board_id", task_view_members: "view_id", collection_members: "collection_id", calendar_members: "calendar_id" };
    for (const [table, level] of Object.entries(levels)) {
      const hasLevel = (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === "level");
      for (const user of ["u1", "u2"]) seedRow(database, table, { [keyColumn[table]!]: `${table}-item`, user_id: user, ...(hasLevel ? { level } : {}) });
    }
    seedRow(database, "user_groups", { id: "g1", name: "G1" });
    for (const user of ["u1", "u3"]) seedRow(database, "group_members", { group_id: "g1", user_id: user });
    for (const kind of ["folder", "note", "document", "board", "task_view", "collection", "calendar", "vault"]) seedRow(database, "group_grants", { resource_kind: kind, resource_id: `${kind}-g`, group_id: "g1", level: "view", env_id: null });
    database.exec("PRAGMA ignore_check_constraints = OFF;");
    const snapshot = () => database.query("SELECT kind, resource_id, user_id, level, via, group_id FROM access_grants_v WHERE kind NOT IN ('agent','chat') ORDER BY kind, resource_id, user_id, via, group_id").all();
    const old = snapshot();
    expect(old.length).toBe(14 + 16);
    // 041 applies on top, keeping every row.
    database.query("DELETE FROM schema_migrations WHERE id = 41").run();
    runMigrations(database);
    expect(snapshot()).toEqual(old);
    // The 025 halves are carried verbatim.
    const after = (database.query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'access_grants_v'").get() as { sql: string }).sql.replace(/\s+/g, " ");
    const oldBody = before040.replace(/\s+/g, " ").replace(/^CREATE VIEW (IF NOT EXISTS )?access_grants_v AS /, "").replace(/;$/, "").trim();
    expect(after).toContain(oldBody);
    // Re-running 041 changes nothing.
    database.transaction(() => agentSharingMigration.up(database))();
    database.transaction(() => agentSharingMigration.up(database))();
    expect(snapshot()).toEqual(old);
    // agent_access rows appear (direct and per group member) and the unique index refuses duplicates.
    database.exec("PRAGMA foreign_keys = OFF");
    const insert = database.query("INSERT INTO agent_access (resource_kind, resource_id, user_id, group_id, level, created_at) VALUES (?, ?, ?, ?, ?, 'now')");
    insert.run("agent", "a1", "u1", null, "view");
    insert.run("agent", "a1", null, "g1", "manage");
    insert.run("chat", "a1", "u1", null, "view");
    expect(() => insert.run("agent", "a1", "u1", null, "manage")).toThrow();
    expect(() => insert.run("agent", "a1", null, "g1", "view")).toThrow();
    const agentRows = database.query("SELECT kind, user_id, level, via, group_id FROM access_grants_v WHERE resource_id = 'a1' ORDER BY kind, via, user_id").all();
    expect(agentRows).toEqual([
      { kind: "agent", user_id: "u1", level: "view", via: "direct", group_id: null },
      { kind: "agent", user_id: "u1", level: "manage", via: "group", group_id: "g1" },
      { kind: "agent", user_id: "u3", level: "manage", via: "group", group_id: "g1" },
      { kind: "chat", user_id: "u1", level: "view", via: "direct", group_id: null }
    ]);
    const columns = (database.query("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("copied_from_user_id");
    expect(columns).toContain("copied_from_name");
    database.close();
  });
});
