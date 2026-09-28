import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createUser, db, request, type Session } from "./support/harness";
import { newCollection } from "./support/collections";

const { resetTeamRateLimits } = await import("../server/team/routes");

/**
 * Groups (Wave 32, access plan D267, O-A1, T200, T213): admin-managed membership with a revision
 * CAS and an append-only history; owners share with a group, admins decide who is in it.
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

const marker = () => crypto.randomUUID().slice(0, 8);

describe("Team → Groups", () => {
  test("admins create, rename, fill, and delete a group; everyone else is refused", async () => {
    const admin = await user("Groups admin", "admin");
    const member = await user("Groups member");
    const viewer = await user("Groups viewer", "viewer");
    const guest = await user("Groups guest", "guest");
    const name = `Ops ${marker()}`;

    expect((await send(member, "POST", "/team/groups", { name })).status).toBe(403);
    expect((await send(viewer, "GET", "/team/groups")).status).toBe(403);
    expect((await send(guest, "GET", "/team/groups")).status).toBe(404);

    const created = await send(admin, "POST", "/team/groups", { name, description: "On call" });
    expect(created.status).toBe(201);
    const group = created.body.group;
    expect(group).toMatchObject({ name, description: "On call", memberCount: 0, guestCount: 0, grantCount: 0, revision: 1, members: [], items: [] });
    expect(group.history.map((row: { action: string }) => row.action)).toEqual(["group.created"]);
    // Names are unique regardless of case.
    expect((await send(admin, "POST", "/team/groups", { name: name.toUpperCase() })).body.code).toBe("NAME_TAKEN");

    const filled = await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [member.userId, guest.userId, admin.userId], revision: 1 });
    expect(filled.status).toBe(200);
    expect(filled.body).toMatchObject({ added: 3, removed: 0, selfAdded: true });
    expect(filled.body.group.memberCount).toBe(3);
    expect(filled.body.group.guestCount).toBe(1);
    // O-A1: an admin may add themselves, and it is flagged on the row and in the history.
    const self = filled.body.group.members.find((row: { id: string }) => row.id === admin.userId);
    expect(self.selfAdded).toBe(true);
    expect(filled.body.group.members.find((row: { id: string }) => row.id === member.userId).selfAdded).toBe(false);
    expect(filled.body.group.history.filter((row: { self: boolean }) => row.self)).toHaveLength(1);

    // A stale revision is refused (CAS).
    const stale = await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [], revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("GROUP_CHANGED");

    const renamed = await send(admin, "PATCH", `/team/groups/${group.id}`, { name: `${name} renamed`, revision: 2 });
    expect(renamed.status).toBe(200);
    expect(renamed.body.group.name).toBe(`${name} renamed`);

    const removed = await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [member.userId], revision: 3 });
    expect(removed.body).toMatchObject({ added: 0, removed: 2 });

    // The picker list: names and counts only, for people who can share.
    const picker = await send(member, "GET", "/groups");
    expect(picker.status).toBe(200);
    const row = picker.body.groups.find((entry: { id: string }) => entry.id === group.id);
    expect(row).toEqual({ id: group.id, name: `${name} renamed`, memberCount: 1, guestCount: 0 });
    expect(JSON.stringify(picker.body)).not.toContain(member.userId);
    expect((await send(viewer, "GET", "/groups")).status).toBe(403);
    expect((await send(guest, "GET", "/groups")).status).toBe(403);

    const events = db.query("SELECT action, target_user_id, meta_json FROM access_events WHERE group_id = ? ORDER BY rowid").all(group.id) as Array<{ action: string; target_user_id: string | null; meta_json: string | null }>;
    expect(events.map((event) => event.action)).toEqual(["group.created", "group.member_added", "group.member_added", "group.member_added", "group.updated", "group.member_removed", "group.member_removed"]);
    expect(events.filter((event) => event.meta_json?.includes("\"self\":true"))).toHaveLength(2);

    const deleted = await send(admin, "DELETE", `/team/groups/${group.id}`, { revision: 4 });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ ok: true, removedMembers: 1 });
    expect((await send(admin, "GET", `/team/groups/${group.id}`)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?").get(group.id)).toEqual({ count: 0 });
  });

  test("members must be enabled accounts, and the body is bounded", async () => {
    const admin = await user("Groups bounds admin", "admin");
    const blocked = await user("Groups blocked");
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    const group = (await send(admin, "POST", "/team/groups", { name: `Bounds ${marker()}` })).body.group;
    const refused = await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [blocked.userId], revision: 1 });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_MEMBERS");
    expect((await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [crypto.randomUUID()], revision: 1 })).status).toBe(400);
    expect((await send(admin, "POST", "/team/groups", { name: "" })).status).toBe(400);
    expect((await send(admin, "POST", "/team/groups", { name: "x".repeat(61) })).status).toBe(400);
    expect((await send(admin, "GET", "/team/groups/not-a-uuid")).status).toBe(404);
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
  });
});

/** Inserts a group grant as the Access sheet does (the API tests use the sheet's route). */
function grant(kind: string, id: string, groupId: string, level = "view") {
  db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, id, groupId, level, new Date().toISOString());
}

async function publishedNote(owner: Session, folderId: string | null, markdown: string) {
  const id = (await send(owner, "POST", "/notes", { folderId })).body.note.id as string;
  await send(owner, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 });
  expect((await send(owner, "POST", `/notes/${id}/publish`)).status).toBe(200);
  return id;
}

async function upload(owner: Session, name: string, folderId?: string) {
  const form = new FormData();
  form.append("file", new Blob(["group grant"], { type: "text/plain" }), name);
  const response = await request(`/files${folderId ? `?folderId=${folderId}` : ""}`, { method: "POST", body: form }, owner);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

describe("group grants in every access predicate (D270)", () => {
  test("a group member reads what is shared with the group, in every module and read path; leaving the group ends it at once", async () => {
    const admin = await user("Grants admin", "admin");
    const owner = await user("Grants owner");
    const inGroup = await user("Grants in group");
    const guestInGroup = await user("Grants guest in group", "guest");
    const outsider = await user("Grants outsider");
    const tag = `ggrant${marker()}`;
    const group = (await send(admin, "POST", "/team/groups", { name: `Grants ${tag}` })).body.group;
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [inGroup.userId, guestInGroup.userId], revision: 1 });

    // Items are `selected` with one direct recipient (a stranger: the legacy route needs one) and a
    // group grant each; the group branch alone must open them for the group's members.
    const stranger = await user("Grants stranger");
    const selected = { visibility: "selected", userIds: [stranger.userId] };
    const folder = (await send(owner, "POST", "/folders", { name: `${tag} folder`, parentId: null })).body.folder.id as string;
    await send(owner, "PUT", `/folders/${folder}/sharing`, selected);
    grant("folder", folder, group.id);
    const noteInFolder = await publishedNote(owner, folder, `# In folder ${tag}`);
    const noteOverride = await publishedNote(owner, null, `# Override ${tag}`);
    await send(owner, "PUT", `/notes/${noteOverride}/sharing`, selected);
    grant("note", noteOverride, group.id);
    const fileInFolder = await upload(owner, `${tag}-folder.txt`, folder);
    const fileOverride = await upload(owner, `${tag}-override.txt`);
    await send(owner, "PUT", `/files/${fileOverride}/sharing`, selected);
    grant("document", fileOverride, group.id);
    const board = (await send(owner, "POST", "/tasks/boards", { name: `${tag} board` })).body;
    await send(owner, "PUT", `/tasks/boards/${board.board.id}/sharing`, selected);
    grant("board", board.board.id, group.id, "edit");
    await send(owner, "POST", `/tasks/boards/${board.board.id}/cards`, { columnId: board.columns[0].id, title: `${tag} card` });
    const view = (await send(owner, "POST", "/tasks/views", { name: `${tag} view`, query: "" })).body.view.id as string;
    await send(owner, "PUT", `/tasks/views/${view}/sharing`, selected);
    grant("task_view", view, group.id);
    const collection = await newCollection(owner, { name: `${tag} collection`, fields: [{ name: "Name", type: "text" }] });
    await send(owner, "PUT", `/collections/${collection.id}/sharing`, { ...selected, role: "viewer" });
    grant("collection", collection.id, group.id);
    const calendar = (await send(owner, "POST", "/calendars", { name: `${tag} calendar`, color: "green" })).body.calendar.id as string;
    await send(owner, "PUT", `/calendars/${calendar}/sharing`, { ...selected, shareRole: "viewer" });
    grant("calendar", calendar, group.id);
    const event = (await send(owner, "POST", `/calendars/${calendar}/events`, { title: `${tag} event`, allDay: false, startLocal: "2026-05-04T09:00", tz: "UTC", durationMinutes: 30 })).body.event.id as string;

    const ids = [folder, noteInFolder, noteOverride, fileInFolder, fileOverride, board.board.id, view, collection.id, calendar, event];
    const singles: Array<[string, string]> = [
      [noteInFolder, `/notes/${noteInFolder}`], [noteOverride, `/notes/${noteOverride}`], [fileInFolder, `/files/${fileInFolder}`], [fileOverride, `/files/${fileOverride}`],
      [board.board.id, `/tasks/boards/${board.board.id}`], [view, `/tasks/views/${view}`], [collection.id, `/collections/${collection.id}`], [event, `/events/${event}`]
    ];
    async function reach(session: Session) {
      let all = "";
      for (const path of ["/notes", "/folders", "/files", "/tasks/boards", "/tasks/views", "/collections", "/calendars", "/events?from=2026-05-01&to=2026-05-10&tz=UTC", `/search?q=${tag}`]) {
        const result = await send(session, "GET", path);
        expect({ path, status: result.status }).toEqual({ path, status: 200 });
        all += JSON.stringify(result.body);
      }
      const single: Record<string, number> = {};
      for (const [id, path] of singles) single[id] = (await send(session, "GET", path)).status;
      return { all, single };
    }
    const expectReach = async (label: string, session: Session, reachable: boolean) => {
      const { all, single } = await reach(session);
      for (const id of ids) expect({ label, id, listed: all.includes(id) }).toEqual({ label, id, listed: reachable });
      for (const [id, status] of Object.entries(single)) expect({ label, id, status }).toEqual({ label, id, status: reachable ? 200 : 404 });
    };

    await expectReach("group member", inGroup, true);
    // A guest named through a group reads too (a named share, D.2); guests never match all_users.
    await expectReach("guest in the group", guestInGroup, true);
    await expectReach("outsider", outsider, false);

    // Removing someone from the group revokes at once (T202).
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [guestInGroup.userId], revision: 2 });
    await expectReach("removed from the group", inGroup, false);

    // Group grants count only under `selected`: a private item never leaks through an old group row.
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [guestInGroup.userId, inGroup.userId], revision: 3 });
    await send(owner, "PUT", `/tasks/boards/${board.board.id}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/notes/${noteOverride}/sharing`, { visibility: "private", userIds: [] });
    expect((await send(inGroup, "GET", `/tasks/boards/${board.board.id}`)).status).toBe(404);
    expect((await send(inGroup, "GET", `/notes/${noteOverride}`)).status).toBe(404);
    expect((await send(inGroup, "GET", `/notes/${noteInFolder}`)).status).toBe(200);

    // Deleting the group removes its grants.
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
    expect(db.query("SELECT COUNT(*) AS count FROM group_grants WHERE group_id = ?").get(group.id)).toEqual({ count: 0 });
    expect((await send(inGroup, "GET", `/notes/${noteInFolder}`)).status).toBe(404);
  }, 30_000);

  test("MCP list tools honour group grants, and a board commenter's key cannot write cards", async () => {
    const { createApiKey } = await import("../server/apiKeys");
    const { invokeMcpToolForTests } = await import("../server/mcpTools");
    const { resetMcpLimits } = await import("../server/mcpRateLimit");
    resetMcpLimits();
    const admin = await user("MCP grants admin", "admin");
    const owner = await user("MCP grants owner");
    const member = await user("MCP grants member");
    const group = (await send(admin, "POST", "/team/groups", { name: `MCP ${marker()}` })).body.group;
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [member.userId], revision: 1 });
    const created = (await send(owner, "POST", "/tasks/boards", { name: `MCP group board ${marker()}` })).body;
    const board = created.board.id as string;
    const stranger = await user("MCP grants stranger");
    await send(owner, "PUT", `/tasks/boards/${board}/sharing`, { visibility: "selected", userIds: [stranger.userId] });
    grant("board", board, group.id, "comment");
    const collection = await newCollection(owner, { name: `MCP group collection ${marker()}`, fields: [{ name: "Name", type: "text" }] });
    await send(owner, "PUT", `/collections/${collection.id}/sharing`, { visibility: "selected", userIds: [stranger.userId], role: "viewer" });
    grant("collection", collection.id, group.id);
    const keyId = createApiKey(member.userId, {
      name: "Group agent", surfaces: "mcp", expiresInDays: 30,
      grants: [{ module: "tasks", permission: "write", resourceKind: null, resourceId: null }, { module: "collections", permission: "read", resourceKind: null, resourceId: null }]
    }).id;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await invokeMcpToolForTests(name, args, keyId);
      return { isError: result.isError === true, text: result.content[0]!.text };
    };
    expect((await call("list_boards")).text).toContain(board);
    expect((await call("list_collections")).text).toContain(collection.id);
    // Comment level: the key reads the board but its card writes are READ_ONLY (D272).
    const refused = await call("create_card", { boardId: board, columnId: created.columns[0].id, title: "From a key" });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.text).code).toBe("READ_ONLY");
    // Leaving the group ends it on the next call (T202).
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [], revision: 2 });
    expect((await call("list_boards")).text).not.toContain(board);
    expect((await call("list_collections")).text).not.toContain(collection.id);
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
  });

  test("purging an item removes the group grants on it (T206)", async () => {
    const admin = await user("Purge grants admin", "admin");
    const owner = await user("Purge grants owner");
    const group = (await send(admin, "POST", "/team/groups", { name: `Purge ${marker()}` })).body.group;
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Purged board" })).body.board.id as string;
    grant("board", board, group.id, "edit");
    db.query("DELETE FROM boards WHERE id = ?").run(board);
    expect(db.query("SELECT COUNT(*) AS count FROM group_grants WHERE resource_id = ?").get(board)).toEqual({ count: 0 });
    // The sweeper's self-check reports a grant that points at nothing (ids only), should one ever appear.
    const { orphanGrantReport } = await import("../server/access/groups");
    const ghost = crypto.randomUUID();
    grant("calendar", ghost, group.id, "view");
    const report = orphanGrantReport();
    expect(report).toContainEqual(expect.objectContaining({ source: "group_grants", kind: "calendar", sample: expect.arrayContaining([ghost]) }));
    db.query("DELETE FROM group_grants WHERE resource_id = ?").run(ghost);
    expect(orphanGrantReport().some((row) => row.sample.includes(ghost))).toBe(false);
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
  });
});

describe("group branch guard (D270)", () => {
  const serverRoot = join(import.meta.dir, "..", "server");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "migrations") walk(path);
      } else if (entry.endsWith(".ts")) files.push(path);
    }
  };
  walk(serverRoot);
  const MEMBER_TABLES = "note_shares|folder_shares|document_shares|board_members|task_view_members|collection_members|calendar_members";

  /** The index just past the parenthesis that closes the one opening at `open`. */
  function closing(source: string, open: number) {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")" && --depth === 0) return index + 1;
    }
    return source.length;
  }

  test("every direct-share EXISTS in an access predicate is ORed with the group branch", () => {
    expect(files.length).toBeGreaterThan(40);
    const offenders: string[] = [];
    let guarded = 0;
    const pattern = new RegExp(`EXISTS\\s*\\(\\s*SELECT 1 FROM (${MEMBER_TABLES})\\s+\\w+\\s+WHERE`, "g");
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(pattern)) {
        const end = closing(source, source.indexOf("(", match.index!));
        const after = source.slice(end, end + 160);
        if (/^\s*OR\s+(\(\w+\.visibility = 'selected' AND )?\$\{groupGrantExists\(/.test(after)) guarded += 1;
        else offenders.push(`${path.slice(serverRoot.length + 1)}: ${source.slice(match.index!, match.index! + 90).split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Notes (2), note folder id (1), folders (1), files (3), boards (7+), views (1), collections, calendars.
    expect(guarded).toBeGreaterThanOrEqual(17);
  });

  test("the fragment matches only members of a group granted on that very item", async () => {
    const { groupGrantExists } = await import("../server/access/groups");
    const admin = await user("Fragment admin", "admin");
    const inside = await user("Fragment inside");
    const outside = await user("Fragment outside");
    const group = (await send(admin, "POST", "/team/groups", { name: `Fragment ${marker()}` })).body.group;
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [inside.userId], revision: 1 });
    const itemId = crypto.randomUUID();
    grant("board", itemId, group.id, "comment");
    const check = (userId: string, id: string, kind: "board" | "collection" = "board", levels?: Array<"view" | "comment" | "edit" | "manage">) =>
      (db.query(`SELECT ${groupGrantExists(kind, "$itemId", "$userId", levels)} AS ok`).get({ userId, itemId: id }) as { ok: number }).ok;
    expect(check(inside.userId, itemId)).toBe(1);
    expect(check(outside.userId, itemId)).toBe(0);
    expect(check(inside.userId, crypto.randomUUID())).toBe(0);
    expect(check(inside.userId, itemId, "collection")).toBe(0);
    expect(check(inside.userId, itemId, "board", ["edit", "manage"])).toBe(0);
    expect(check(inside.userId, itemId, "board", ["comment"])).toBe(1);
    db.query("DELETE FROM group_grants WHERE resource_id = ?").run(itemId);
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
  });
});
