import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { newCollection } from "./support/collections";

const { resetTeamRateLimits } = await import("../server/team/routes");

/**
 * The item access API (Wave 32, access plan §C.5, §C.7, T204, T207, T213): GET/PUT …/access for the
 * seven shareable kinds, with the ETag compare, per-kind levels, the manager caps, the guest policy,
 * counts-only audit, and the older /sharing routes left working beside it.
 */

beforeEach(() => resetTeamRateLimits());

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** GET then PUT with the ETag, as the Access sheet does. */
async function putAccess(session: Session, path: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", path);
  expect(current.status).toBe(200);
  return send(session, "PUT", path, body, { "If-Match": current.headers.get("ETag")! });
}

const tag = () => crypto.randomUUID().slice(0, 8);

async function group(admin: Session, members: Session[]) {
  const created = (await send(admin, "POST", "/team/groups", { name: `Access ${tag()}` })).body.group;
  await send(admin, "PUT", `/team/groups/${created.id}/members`, { userIds: members.map((member) => member.userId), revision: 1 });
  return created.id as string;
}

describe("GET/PUT …/access", () => {
  test("round-trips people and groups with levels on all seven kinds", async () => {
    const admin = await user("Access admin", "admin");
    const owner = await user("Access owner");
    const person = await user("Access person");
    const inGroup = await user("Access in group");
    const groupId = await group(admin, [inGroup]);

    const folder = (await send(owner, "POST", "/folders", { name: `Access folder ${tag()}`, parentId: null })).body.folder.id as string;
    const note = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    await send(owner, "PUT", `/notes/${note}/draft`, { markdown: "# Access note", revision: 1 });
    await send(owner, "POST", `/notes/${note}/publish`);
    const form = new FormData();
    form.append("file", new Blob(["access"], { type: "text/plain" }), "access.txt");
    const document = ((await (await request("/files", { method: "POST", body: form }, owner)).json()) as { document: { id: string } }).document.id;
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Access board" })).body.board.id as string;
    const view = (await send(owner, "POST", "/tasks/views", { name: "Access view", query: "" })).body.view.id as string;
    const collection = (await newCollection(owner, { name: "Access collection", fields: [{ name: "Name", type: "text" }] })).id;
    const calendar = (await send(owner, "POST", "/calendars", { name: "Access calendar", color: "blue" })).body.calendar.id as string;

    const cases: Array<{ path: string; read: string; level: string; groupLevel: string; offered: string[] }> = [
      { path: `/notes/${note}/access`, read: `/notes/${note}`, level: "edit", groupLevel: "view", offered: ["view", "edit"] },
      { path: `/folders/${folder}/access`, read: "/folders", level: "view", groupLevel: "edit", offered: ["view", "edit"] },
      { path: `/files/${document}/access`, read: `/files/${document}`, level: "view", groupLevel: "view", offered: ["view"] },
      { path: `/tasks/boards/${board}/access`, read: `/tasks/boards/${board}`, level: "manage", groupLevel: "comment", offered: ["view", "comment", "edit", "manage"] },
      { path: `/tasks/views/${view}/access`, read: `/tasks/views/${view}`, level: "view", groupLevel: "view", offered: ["view"] },
      { path: `/collections/${collection}/access`, read: `/collections/${collection}`, level: "edit", groupLevel: "manage", offered: ["view", "edit", "manage"] },
      { path: `/calendars/${calendar}/access`, read: "/calendars", level: "manage", groupLevel: "edit", offered: ["view", "edit", "manage"] }
    ];
    for (const item of cases) {
      const before = await send(owner, "GET", item.path);
      expect({ path: item.path, status: before.status }).toEqual({ path: item.path, status: 200 });
      expect(before.body).toMatchObject({ audience: expect.any(String), people: [], groups: [], levels: item.offered, yourLevel: "owner", owner: { id: owner.userId } });
      expect(before.headers.get("ETag")).toBe(before.body.etag);
      expect(before.headers.get("Cache-Control")).toContain("no-store");
      const saved = await putAccess(owner, item.path, { audience: "selected", people: [{ id: person.userId, level: item.level }], groups: [{ id: groupId, level: item.groupLevel }] });
      expect({ path: item.path, status: saved.status, code: saved.body.code }).toEqual({ path: item.path, status: 200, code: undefined });
      expect(saved.body.people).toMatchObject([{ id: person.userId, level: item.level, teamRole: "member", via: "direct" }]);
      expect(saved.body.groups).toMatchObject([{ id: groupId, level: item.groupLevel, memberCount: 1, guestCount: 0 }]);
      expect(saved.body.etag).not.toBe(before.body.etag);
      // Both the person and the group member can now open it.
      for (const reader of [person, inGroup]) {
        const read = await send(reader, "GET", item.read);
        expect({ path: item.read, status: read.status }).toEqual({ path: item.read, status: 200 });
        if (item.read === "/folders") expect(JSON.stringify(read.body)).toContain(folder);
        if (item.read === "/calendars") expect(JSON.stringify(read.body)).toContain(calendar);
      }
      // A person without owner or manager rights gets 403, a stranger 404 (T204).
      const stranger = await user("Access stranger");
      expect((await send(stranger, "GET", item.path)).status).toBe(404);
    }
    // The person at edit on the note, at manage on the board: a note editor is not an owner.
    expect((await send(person, "GET", `/notes/${note}/access`)).body.code).toBe("OWNER_ONLY");
    expect((await send(person, "GET", `/tasks/boards/${board}/access`)).status).toBe(200);
    expect((await send(inGroup, "GET", `/collections/${collection}/access`)).status).toBe(200);
    expect((await send(inGroup, "GET", `/tasks/boards/${board}/access`)).body.code).toBe("OWNER_ONLY");
    expect((await send(owner, "GET", "/notes/not-a-uuid/access")).status).toBe(404);

    // The older route keeps working and leaves the group grant alone.
    expect((await send(owner, "PUT", `/tasks/boards/${board}/sharing`, { visibility: "selected", userIds: [person.userId] })).status).toBe(200);
    const after = (await send(owner, "GET", `/tasks/boards/${board}/access`)).body;
    expect(after.groups).toMatchObject([{ id: groupId, level: "comment" }]);
    expect(after.people).toMatchObject([{ id: person.userId, level: "manage" }]);
    await send(admin, "DELETE", `/team/groups/${groupId}`, {});
  }, 30_000);

  test("the ETag is required and stale saves are refused (no lost updates)", async () => {
    const owner = await user("ETag owner");
    const person = await user("ETag person");
    const board = (await send(owner, "POST", "/tasks/boards", { name: "ETag board" })).body.board.id as string;
    const path = `/tasks/boards/${board}/access`;
    const first = await send(owner, "GET", path);
    const body = { audience: "selected", people: [{ id: person.userId, level: "edit" }], groups: [] };
    const missing = await send(owner, "PUT", path, body);
    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe("ETAG_REQUIRED");
    expect((await send(owner, "PUT", path, body, { "If-Match": first.body.etag })).status).toBe(200);
    // The same ETag again is stale now; the 409 carries the current access.
    const stale = await send(owner, "PUT", path, { ...body, people: [] , audience: "private" }, { "If-Match": first.body.etag });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("ACCESS_CHANGED");
    expect(stale.body.access.people).toMatchObject([{ id: person.userId, level: "edit" }]);
    // The unquoted form is accepted too.
    const current = (await send(owner, "GET", path)).body.etag as string;
    expect((await send(owner, "PUT", path, { audience: "private" }, { "If-Match": current.slice(1, -1) })).status).toBe(200);
  });

  test("levels, audiences, people, and groups are validated per kind", async () => {
    const owner = await user("Validate owner");
    const person = await user("Validate person");
    const note = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Validate board" })).body.board.id as string;
    const form = new FormData();
    form.append("file", new Blob(["v"], { type: "text/plain" }), "v.txt");
    const document = ((await (await request("/files", { method: "POST", body: form }, owner)).json()) as { document: { id: string } }).document.id;
    const refusals: Array<[string, Record<string, unknown>, number, string]> = [
      [`/notes/${note}/access`, { audience: "selected", people: [{ id: person.userId, level: "manage" }] }, 400, "LEVEL_NOT_OFFERED"],
      [`/files/${document}/access`, { audience: "selected", people: [{ id: person.userId, level: "edit" }] }, 400, "LEVEL_NOT_OFFERED"],
      [`/tasks/boards/${board}/access`, { audience: "all_users", audienceLevel: "manage" }, 400, "LEVEL_NOT_OFFERED"],
      [`/tasks/boards/${board}/access`, { audience: "inherit" }, 400, "INVALID"],
      [`/notes/${note}/access`, { audience: "private", audienceLevel: "view" }, 400, "INVALID"],
      [`/tasks/boards/${board}/access`, { audience: "selected", people: [] }, 400, "INVALID"],
      [`/tasks/boards/${board}/access`, { audience: "private", people: [{ id: person.userId, level: "edit" }] }, 400, "INVALID"],
      [`/tasks/boards/${board}/access`, { audience: "selected", people: [{ id: owner.userId, level: "edit" }] }, 400, "INVALID"],
      [`/tasks/boards/${board}/access`, { audience: "selected", people: [{ id: crypto.randomUUID(), level: "edit" }] }, 400, "INVALID"],
      [`/tasks/boards/${board}/access`, { audience: "selected", groups: [{ id: crypto.randomUUID(), level: "edit" }] }, 400, "INVALID"]
    ];
    for (const [path, body, status, code] of refusals) {
      const result = await putAccess(owner, path, body);
      expect({ path, body, status: result.status, code: result.body.code }).toEqual({ path, body, status, code });
    }
    expect((await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "selected", people: Array.from({ length: 101 }, () => ({ id: crypto.randomUUID(), level: "view" })) })).status).toBe(400);
    // An everyone board at comment, and a note that inherits its folder.
    const everyone = await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "all_users", audienceLevel: "comment" });
    expect(everyone.body).toMatchObject({ audience: "all_users", audienceLevel: "comment", audienceLevels: ["view", "comment", "edit"] });
    const stranger = await user("Validate everyone member");
    expect((await send(stranger, "GET", `/tasks/boards/${board}`)).body.board.level).toBe("comment");
    expect((await putAccess(owner, `/notes/${note}/access`, { audience: "inherit" })).body.audience).toBe("inherit");
    await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "private" });
  });

  test("managers share up to Can edit and never touch the audience or other managers (T207)", async () => {
    const owner = await user("Cap owner");
    const manager = await user("Cap manager");
    const other = await user("Cap other manager");
    const newcomer = await user("Cap newcomer");
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Cap board" })).body.board.id as string;
    const path = `/tasks/boards/${board}/access`;
    await putAccess(owner, path, { audience: "selected", people: [{ id: manager.userId, level: "manage" }, { id: other.userId, level: "manage" }] });
    const seen = (await send(manager, "GET", path)).body;
    expect(seen.yourLevel).toBe("manage");
    expect(seen.youId).toBe(manager.userId);
    expect(seen.levels).toEqual(["view", "comment", "edit"]);
    const managers = [{ id: manager.userId, level: "manage" }, { id: other.userId, level: "manage" }];
    expect((await putAccess(manager, path, { audience: "selected", people: [...managers, { id: newcomer.userId, level: "edit" }] })).status).toBe(200);
    const refusals: Array<Record<string, unknown>> = [
      { audience: "selected", people: [...managers, { id: newcomer.userId, level: "manage" }] },
      { audience: "selected", people: [managers[0]!, { id: newcomer.userId, level: "edit" }] },
      { audience: "selected", people: [managers[0]!, { id: other.userId, level: "edit" }, { id: newcomer.userId, level: "edit" }] },
      { audience: "all_users" },
      { audience: "selected", audienceLevel: "view", people: [...managers, { id: newcomer.userId, level: "edit" }] }
    ];
    for (const body of refusals) {
      const result = await putAccess(manager, path, body);
      expect({ body, status: result.status, code: result.body.code }).toEqual({ body, status: 403, code: "MANAGER_CAP" });
    }
    // Removing an editor is fine for a manager.
    expect((await putAccess(manager, path, { audience: "selected", people: managers })).status).toBe(200);
  });

  test("share_with_guests off refuses shares reaching guests and hides guests from the picker (T213)", async () => {
    const admin = await user("Guest policy admin", "admin");
    const owner = await user("Guest policy owner");
    const guest = await user("Guest policy guest", "guest");
    const groupId = await group(admin, [guest]);
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Guest policy board" })).body.board.id as string;
    const path = `/tasks/boards/${board}/access`;
    db.query("INSERT OR REPLACE INTO team_settings (key, value_json, updated_at) VALUES ('share_with_guests', 'false', ?)").run(new Date().toISOString());
    try {
      expect((await putAccess(owner, path, { audience: "selected", people: [{ id: guest.userId, level: "view" }] })).body.code).toBe("GUEST_SHARE_DISABLED");
      expect((await putAccess(owner, path, { audience: "selected", groups: [{ id: groupId, level: "view" }] })).body.code).toBe("GUEST_SHARE_DISABLED");
      expect((await send(owner, "PUT", `/tasks/boards/${board}/sharing`, { visibility: "selected", userIds: [guest.userId] })).body.code).toBe("GUEST_SHARE_DISABLED");
      expect(JSON.stringify((await send(owner, "GET", "/users")).body)).not.toContain(guest.userId);
      expect((await send(owner, "GET", "/groups")).body.shareWithGuests).toBe(false);
      expect((await send(owner, "GET", path)).body.shareWithGuests).toBe(false);
    } finally {
      db.query("DELETE FROM team_settings WHERE key = 'share_with_guests'").run();
    }
    // With the policy on (the default), a guest in a group reads at most (D.2).
    expect((await putAccess(owner, path, { audience: "selected", groups: [{ id: groupId, level: "edit" }] })).status).toBe(200);
    expect((await send(owner, "GET", path)).body.groups[0]).toMatchObject({ guestCount: 1 });
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).body.board.level).toBe("view");
    await send(admin, "DELETE", `/team/groups/${groupId}`, {});
  });

  test("the audit keeps counts only, and read-only roles cannot save", async () => {
    const owner = await user("Audit owner");
    const person = await user("Audit person");
    const viewerOwner = await user("Audit viewer owner");
    const secret = `Secret board ${tag()}`;
    const board = (await send(owner, "POST", "/tasks/boards", { name: secret })).body.board.id as string;
    await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "selected", people: [{ id: person.userId, level: "comment" }] });
    const event = db.query("SELECT action, resource_kind, resource_id, meta_json FROM access_events WHERE resource_id = ? ORDER BY rowid DESC").get(board) as { action: string; resource_kind: string; meta_json: string };
    expect(event).toMatchObject({ action: "item.access_changed", resource_kind: "board" });
    expect(JSON.parse(event.meta_json)).toEqual({ kind: "board", audience: "selected", peopleCount: 1, groupCount: 0 });
    expect(event.meta_json).not.toContain(secret);
    expect(event.meta_json).not.toContain(person.userId);

    const own = (await send(viewerOwner, "POST", "/tasks/boards", { name: "Viewer's board" })).body.board.id as string;
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewerOwner.userId);
    const etag = (await send(viewerOwner, "GET", `/tasks/boards/${own}/access`)).body.etag as string;
    const refused = await send(viewerOwner, "PUT", `/tasks/boards/${own}/access`, { audience: "all_users" }, { "If-Match": etag });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ROLE_READ_ONLY");
  });
});
