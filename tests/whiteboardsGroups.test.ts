import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { resetSearchRateLimit } = await import("../server/searchRoutes");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { mcpScopesForRole } = await import("../server/team/roles");

/**
 * Whiteboards through Wave 32 access (Wave 23 follow-up): a board shared with a group reaches its
 * members on every surface (list, canvas read, search, Today, MCP) and stops when they leave;
 * the `share_with_guests` policy refuses shares that reach guests as for any file; a guest reached
 * through a group reads view-only and holds no whiteboard MCP scope; an admin who cannot read a
 * board never sees its name (D73, D269, T204).
 */

beforeEach(() => {
  resetTeamRateLimits();
  resetSearchRateLimit();
  resetMcpLimits();
});
afterEach(() => { db.query("DELETE FROM team_settings WHERE key = 'share_with_guests'").run(); });

type Json = Record<string, any>;
type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, text };
}
const policyOff = () => db.query("INSERT OR REPLACE INTO team_settings (key, value_json, updated_at) VALUES ('share_with_guests', 'false', ?)").run(new Date().toISOString());
const tag = () => crypto.randomUUID().slice(0, 8);

async function board(owner: Session, name: string, text: string) {
  const created = await send(owner, "POST", "/whiteboards", { name });
  expect(created.status).toBe(201);
  const id = created.body.whiteboard.id as string;
  const scene = { type: "excalidraw", elements: [{ id: `t${tag()}`, type: "text", x: 0, y: 0, width: 10, height: 10, text, originalText: text }], appState: {}, files: {} };
  expect((await send(owner, "PUT", `/whiteboards/${id}/scene`, { baseRevision: 1, scene })).status).toBe(200);
  return id;
}
async function group(admin: Session, members: Session[]) {
  const created = (await send(admin, "POST", "/team/groups", { name: `WB group ${tag()}` })).body.group;
  expect((await send(admin, "PUT", `/team/groups/${created.id}/members`, { userIds: members.map((member) => member.userId), revision: 1 })).status).toBe(200);
  return created.id as string;
}
async function shareAccess(owner: Session, id: string, body: Json) {
  const path = `/files/${id}/access`;
  const current = await request(path, {}, owner);
  const etag = current.headers.get("ETag")!;
  return send(owner, "PUT", path, body, { "If-Match": etag });
}
const revisionOf = async (admin: Session, groupId: string) => (await send(admin, "GET", `/team/groups/${groupId}`)).body.group.revision as number;
async function mcp(keyId: string, name: string, args: Json = {}) {
  const result = await invokeMcpToolForTests(name, args, keyId);
  return { isError: result.isError === true, text: result.content[0]!.text, value: JSON.parse(result.content[0]!.text) as Json };
}

describe("whiteboards shared with a group", () => {
  test("members read on every surface at view; leaving the group ends it everywhere", async () => {
    const admin = await user("WBG admin", "admin");
    const owner = await user("WBG owner");
    const member = await user("WBG member");
    const groupId = await group(admin, [member]);
    const id = await board(owner, "Group plan", "Quokkaboard notes");
    const shared = await shareAccess(owner, id, { audience: "selected", people: [], groups: [{ id: groupId, level: "view" }] });
    expect(shared.status).toBe(200);
    const key = createApiKey(member.userId, { name: "Member agent", surfaces: "mcp", grants: [{ module: "whiteboards", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 }).id;

    const surfaces = async () => ({
      list: (await send(member, "GET", "/whiteboards?folder=shared")).body.whiteboards.map((item: Json) => item.id),
      read: await send(member, "GET", `/whiteboards/${id}`),
      search: (await send(member, "GET", "/search?scope=whiteboards&q=quokkaboard")).body.results.map((hit: Json) => hit.id),
      today: (await send(member, "GET", "/today?tz=UTC")).body.sections.whiteboardsRecent.items.map((item: Json) => item.id),
      mcpList: (await mcp(key, "list_whiteboards")).value.whiteboards.map((item: Json) => item.id),
      mcpRead: await mcp(key, "read_whiteboard", { id })
    });

    const on = await surfaces();
    expect(on.list).toContain(id);
    expect(on.read.status).toBe(200);
    expect(on.read.body.whiteboard).toMatchObject({ canEdit: false, is_owner: 0 });
    expect(on.search).toEqual([id]);
    expect(on.today).toContain(id);
    expect(on.mcpList).toContain(id);
    expect(on.mcpRead.isError).toBe(false);
    expect(on.mcpRead.value.texts[0].text).toBe("Quokkaboard notes");
    // View only: a member's save is 404, like any recipient's.
    expect((await send(member, "PUT", `/whiteboards/${id}/scene`, { baseRevision: 2, scene: { type: "excalidraw", elements: [] } })).status).toBe(404);

    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [], revision: await revisionOf(admin, groupId) })).status).toBe(200);
    const off = await surfaces();
    expect(off.list).not.toContain(id);
    expect(off.read.status).toBe(404);
    expect(off.search).toEqual([]);
    expect(off.today).not.toContain(id);
    expect(off.mcpList).not.toContain(id);
    expect(off.mcpRead.value.code).toBe("NOT_FOUND");
    expect(off.mcpRead.text).not.toContain("Group plan");
  });
});

describe("whiteboards and guests", () => {
  test("with share_with_guests off, sharing a board with a guest, directly or through a group, is refused like any file", async () => {
    const admin = await user("WBG policy admin", "admin");
    const owner = await user("WBG policy owner");
    const guest = await user("WBG policy guest", "guest");
    const groupId = await group(admin, [guest]);
    const id = await board(owner, "Policy board", "Guestless");
    policyOff();
    const direct = await shareAccess(owner, id, { audience: "selected", people: [{ id: guest.userId, level: "view" }], groups: [] });
    expect(direct.status).toBe(400);
    expect(direct.body.code).toBe("GUEST_SHARE_DISABLED");
    const viaGroup = await shareAccess(owner, id, { audience: "selected", people: [], groups: [{ id: groupId, level: "view" }] });
    expect(viaGroup.status).toBe(400);
    expect(viaGroup.body.code).toBe("GUEST_SHARE_DISABLED");
    expect((await send(guest, "GET", `/whiteboards/${id}`)).status).toBe(404);
    // Everyone signed in never includes guests.
    expect((await shareAccess(owner, id, { audience: "all_users", people: [], groups: [] })).status).toBe(200);
    expect((await send(guest, "GET", `/whiteboards/${id}`)).status).toBe(404);
    expect((await send(guest, "GET", "/whiteboards")).body.whiteboards.map((item: Json) => item.id)).not.toContain(id);
  });

  test("a guest reached through a group reads view-only and holds no whiteboard MCP scope", async () => {
    const admin = await user("WBG guest admin", "admin");
    const owner = await user("WBG guest owner");
    const guest = await user("WBG group guest", "guest");
    const groupId = await group(admin, [guest]);
    const id = await board(owner, "Guest board", "Visible to the guest");
    expect((await shareAccess(owner, id, { audience: "selected", people: [], groups: [{ id: groupId, level: "view" }] })).status).toBe(200);
    const read = await send(guest, "GET", `/whiteboards/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.whiteboard.canEdit).toBe(false);
    const write = await send(guest, "PUT", `/whiteboards/${id}/scene`, { baseRevision: 2, scene: { type: "excalidraw", elements: [] } });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("ROLE_READ_ONLY");
    expect((await send(guest, "POST", "/whiteboards", { name: "Mine" })).status).toBe(403);
    expect(mcpScopesForRole("guest").some((scope) => scope.startsWith("whiteboards"))).toBe(false);
  });
});

describe("D73: an admin who cannot read a board never sees its name", () => {
  test("the group items page, the key inventory, and errors carry no board name", async () => {
    const admin = await user("WBG d73 admin", "admin");
    const owner = await user("WBG d73 owner");
    const member = await user("WBG d73 member");
    const groupId = await group(admin, [member]);
    const secret = `Secret board Zanzibar ${tag()}`;
    const id = await board(owner, secret, "Zanzibar text");
    expect((await shareAccess(owner, id, { audience: "selected", people: [], groups: [{ id: groupId, level: "view" }] })).status).toBe(200);

    const page = await send(admin, "GET", `/team/groups/${groupId}`);
    expect(page.status).toBe(200);
    const item = page.body.group.items.find((entry: Json) => entry.kind === "document");
    expect(item).toMatchObject({ titleHidden: true, title: "File owned by WBG d73 owner" });
    expect(item.id).toBeUndefined();
    expect(page.text).not.toContain("Zanzibar");

    // A member's key chosen for the board: the admin inventory never names the resource (T204).
    createApiKey(member.userId, { name: "Chosen board agent", surfaces: "mcp", grants: [{ module: "whiteboards", permission: "read", resourceKind: "whiteboard", resourceId: id }], expiresInDays: 30 });
    const inventory = await send(admin, "GET", `/team/keys?owner=${member.userId}`);
    expect(inventory.status).toBe(200);
    expect(inventory.text).not.toContain("Zanzibar");

    // Errors: every whiteboard route is the same 404 without the name, and search finds nothing.
    for (const [method, path] of [["GET", `/whiteboards/${id}`], ["GET", `/whiteboards/${id}/thumbnail`], ["GET", `/files/${id}`], ["GET", `/files/${id}/access`]] as const) {
      const result = await send(admin, method, path);
      expect({ path, status: result.status }).toEqual({ path, status: 404 });
      expect(result.text).not.toContain("Zanzibar");
    }
    expect((await send(admin, "GET", "/search?scope=whiteboards&q=zanzibar")).body.results).toEqual([]);
    expect((await send(admin, "GET", "/whiteboards")).text).not.toContain("Zanzibar");
    expect((await send(admin, "GET", "/files")).text).not.toContain("Zanzibar");
  });
});
