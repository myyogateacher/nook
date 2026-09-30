import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, spareEmail, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetTeamRateLimits } = await import("../server/team/routes");

beforeEach(() => {
  resetTeamRateLimits();
  resetMcpLimits();
});

type Role = "admin" | "member" | "viewer" | "guest";
const setRoleSql = (session: Session, role: Role) => db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);

async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") setRoleSql(session, role);
  return session;
}

const call = (session: Session, method: string, path: string, body: unknown = {}) => request(`/team${path}`, { method, body: JSON.stringify(body) }, session);

let rpcId = 0;
async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };
}
// A key with no effective scopes registers no tools, so the server offers no tools/list at all.
const toolNames = async (token: string) => (await rpc(token, "tools/list")).result?.tools?.map((tool) => tool.name) ?? [];
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  return { isError: body.result!.isError === true, value: JSON.parse(body.result!.content![0]!.text) as Record<string, any> };
}

describe("Team MCP", () => {
  test("team:read is admin-only at key creation", async () => {
    const admin = await user("Key admin", "admin");
    const member = await user("Key member");
    const body = (session: Session) => JSON.stringify({ name: "Team", scopes: ["team:read"], password: session.password });
    const refused = await request("/mcp/keys", { method: "POST", body: body(member) }, member);
    expect(refused.status).toBe(403);
    expect((await refused.json() as { code: string }).code).toBe("SCOPE_NOT_ALLOWED");
    expect((await request("/mcp/keys", { method: "POST", body: body(admin) }, admin)).status).toBe(201);
  });

  test("the tools list members without emails, and a demoted admin's key loses them on the next call", async () => {
    const admin = await user("MCP admin", "admin");
    // Sorted first among members, so it stays inside the 500-row team list however many accounts the run made.
    const target = await user("0 MCP target");
    const key = createMcpApiKey(admin.userId, "Team key", ["team:read", "notes:read"]);
    expect(await toolNames(key.token)).toEqual(expect.arrayContaining(["list_team_members", "get_team_member", "list_notes"]));

    const listed = await callTool(key.token, "list_team_members", { status: "active" });
    expect(listed.isError).toBe(false);
    const row = listed.value.members.find((member: { id: string }) => member.id === target.userId);
    expect(Object.keys(row).sort()).toEqual(["createdAt", "displayName", "id", "lastSeenAt", "role", "status"]);
    expect(JSON.stringify(listed.value)).not.toContain("@example.test");

    await call(admin, "POST", `/${target.userId}/block`, { reason: "Private reason" });
    const detail = await callTool(key.token, "get_team_member", { userId: target.userId });
    expect(detail.value).toMatchObject({ id: target.userId, status: "blocked" });
    expect(detail.value.events[0]).toMatchObject({ action: "block", actor: "MCP admin" });
    expect(JSON.stringify(detail.value)).not.toContain("Private reason");
    expect(JSON.stringify(detail.value)).not.toContain("@example.test");
    expect((await callTool(key.token, "get_team_member", { userId: crypto.randomUUID() })).value.code).toBe("NOT_FOUND");
    await call(admin, "POST", `/${target.userId}/unblock`, {});

    setRoleSql(admin, "member");
    const names = await toolNames(key.token);
    expect(names).not.toContain("list_team_members");
    expect(names).toContain("list_notes");
    const direct = await invokeMcpToolForTests("list_team_members", {}, key.id);
    expect(JSON.parse(direct.content[0]!.text).code).toBe("SCOPE_REQUIRED");
    setRoleSql(admin, "admin");
    expect(await toolNames(key.token)).toContain("list_team_members");
  });

  test("the key list shows stored and effective scopes, so a demoted admin sees team:read is inactive", async () => {
    const admin = await user("List admin", "admin");
    const key = createMcpApiKey(admin.userId, "Team key", ["team:read", "notes:read"]);
    type Listed = { keys: Array<{ id: string; scopes: string[]; effectiveScopes: string[] }> };
    const listed = async () => (await (await request("/mcp/keys", {}, admin)).json() as Listed).keys.find((row) => row.id === key.id)!;
    expect(await listed()).toMatchObject({ scopes: ["notes:read", "team:read"], effectiveScopes: ["notes:read", "team:read"] });
    setRoleSql(admin, "member");
    expect(await listed()).toMatchObject({ scopes: ["notes:read", "team:read"], effectiveScopes: ["notes:read"] });
  });

  test("viewers create read-only keys, guests none, and a demoted member's write key keeps only reads (T81)", async () => {
    const viewer = await user("Scope viewer", "viewer");
    const guest = await user("Scope guest", "guest");
    const create = (session: Session, scopes: string[]) => request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "Key", scopes, password: session.password }) }, session);
    const writeRefused = await create(viewer, ["tasks:write"]);
    expect(writeRefused.status).toBe(403);
    expect((await writeRefused.json() as { code: string }).code).toBe("SCOPE_NOT_ALLOWED");
    // The Wave 19 scopes are write scopes: a viewer can hold none of them (T144).
    for (const scope of ["notes:publish", "files:write", "bin:write"]) {
      const refused = await create(viewer, [scope]);
      expect(refused.status).toBe(403);
      expect((await refused.json() as { code: string }).code).toBe("SCOPE_NOT_ALLOWED");
    }
    expect((await create(viewer, ["notes:read", "tasks:read", "calendar:read", "collections:read", "files:read", "today:read"])).status).toBe(201);
    const guestRefused = await create(guest, ["notes:read"]);
    expect(guestRefused.status).toBe(403);
    expect((await guestRefused.json() as { code: string }).code).toBe("ROLE_READ_ONLY");
    // Revoking stays allowed for everyone.
    const guestKey = createMcpApiKey(guest.userId, "Old key", ["notes:read"]);
    expect((await request(`/mcp/keys/${guestKey.id}`, { method: "DELETE", body: "{}" }, guest)).status).toBe(200);

    const member = await user("Scope member");
    const key = createMcpApiKey(member.userId, "Writer", ["tasks:write", "notes:write-draft", "collections:write", "calendar:write"]);
    const writeTools = ["create_card", "create_note", "update_note_draft", "create_row", "create_event", "create_reminder"];
    expect(await toolNames(key.token)).toEqual(expect.arrayContaining(writeTools));
    setRoleSql(member, "viewer");
    const asViewer = await toolNames(key.token);
    for (const tool of writeTools) expect(asViewer).not.toContain(tool);
    expect(asViewer).toEqual(expect.arrayContaining(["list_boards", "list_notes", "list_collections", "list_calendars"]));
    expect(JSON.parse((await invokeMcpToolForTests("create_note", {}, key.id)).content[0]!.text).code).toBe("SCOPE_REQUIRED");
    setRoleSql(member, "guest");
    expect(await toolNames(key.token)).toEqual([]);
    expect(JSON.parse((await invokeMcpToolForTests("list_notes", {}, key.id)).content[0]!.text).code).toBe("SCOPE_REQUIRED");
    const listed = (await (await request("/mcp/keys", {}, member)).json() as { keys: Array<{ id: string; effectiveScopes: string[] }> }).keys.find((row) => row.id === key.id)!;
    expect(listed.effectiveScopes).toEqual([]);
    setRoleSql(member, "member");
  });

  test("a viewer's MCP reads follow the guest-free audience; a guest's key reaches nothing (T84)", async () => {
    const owner = await user("MCP audience owner");
    const viewer = await user("MCP audience viewer", "viewer");
    const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    const noteId = (await created.json() as { note: { id: string } }).note.id;
    expect((await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# MCP everyone note", revision: 1 }) }, owner)).status).toBe(200);
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect((await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "all_users", userIds: [] }) }, owner)).status).toBe(200);
    const viewerKey = createMcpApiKey(viewer.userId, "Viewer reads", ["notes:read"]);
    expect((await callTool(viewerKey.token, "list_notes")).value.notes.some((note: { id: string }) => note.id === noteId)).toBe(true);
    // The same key, once its holder is a guest, has no tools; the query itself also drops all_users.
    setRoleSql(viewer, "guest");
    expect(await toolNames(viewerKey.token)).toEqual([]);
    const { readableNote } = await import("../server/access");
    expect(readableNote(noteId, viewer.userId)).toBeNull();
    setRoleSql(viewer, "viewer");
    expect(readableNote(noteId, viewer.userId)?.id).toBe(noteId);
    expect((await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "private", userIds: [] }) }, owner)).status).toBe(200);
  });

  test("list_invites is team:read only, read-only, and never returns tokens, prefixes, emails, or labels (D168)", async () => {
    const { resetInviteRateLimits } = await import("../server/team/invites");
    resetInviteRateLimits();
    db.query("DELETE FROM team_invites").run();
    const admin = await user("MCP invites admin", "admin");
    const created = await (await call(admin, "POST", "/invites", { role: "viewer", note: "Secret label", email: spareEmail() })).json() as { token: string; invite: { id: string; tokenPrefix: string } };
    const revoked = await (await call(admin, "POST", "/invites", { role: "guest" })).json() as { invite: { id: string } };
    await call(admin, "POST", `/invites/${revoked.invite.id}/revoke`, {});

    const noTeam = createMcpApiKey(admin.userId, "No team", ["notes:read"]);
    expect(await toolNames(noTeam.token)).not.toContain("list_invites");
    const key = createMcpApiKey(admin.userId, "Invites", ["team:read"]);
    expect(await toolNames(key.token)).toContain("list_invites");
    expect((await toolNames(key.token)).some((name) => /invite/.test(name) && name !== "list_invites")).toBe(false);

    const all = await callTool(key.token, "list_invites");
    expect(all.isError).toBe(false);
    expect(all.value.liveCount).toBe(1);
    expect(all.value.invites.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([[revoked.invite.id, "revoked"], [created.invite.id, "live"]]);
    expect(Object.keys(all.value.invites[1]).sort()).toEqual(["createdAt", "createdBy", "expiresAt", "id", "role", "status", "usedBy"]);
    expect(all.value.invites[1]).toMatchObject({ role: "viewer", createdBy: "MCP invites admin", usedBy: null });
    const text = JSON.stringify(all.value);
    for (const secret of [created.token, created.invite.tokenPrefix, "Secret label", "@example.test"]) expect(text).not.toContain(secret);
    expect((await callTool(key.token, "list_invites", { status: "live" })).value.invites.map((row: { id: string }) => row.id)).toEqual([created.invite.id]);

    // A demoted admin's key loses the tool, and the handler refuses a direct call.
    setRoleSql(admin, "member");
    expect(await toolNames(key.token)).not.toContain("list_invites");
    expect(JSON.parse((await invokeMcpToolForTests("list_invites", {}, key.id)).content[0]!.text).code).toBe("SCOPE_REQUIRED");
    setRoleSql(admin, "admin");
    db.query("DELETE FROM team_invites").run();
  });
});
