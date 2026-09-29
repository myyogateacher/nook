import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { newCollection } from "./support/collections";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { createApiKey, keysReachingItem } = await import("../server/apiKeys");
const { itemSortKey, sealItemHandle } = await import("../server/access/handles");

/**
 * Central access management (Wave 33, access plan §C.6, §C.7, D268, D269, T204, T214, T218): the
 * member access page, its redaction and opaque handles, the admin reductions (remove, lower,
 * leave a group, Reset access), owner bell notices, the self view, and the access activity log.
 */

beforeEach(() => resetTeamRateLimits());

/**
 * The suite shares one database: an item shared with everyone would show up in other files' lists,
 * so each test registers its undo here, and it runs even when the test fails.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

// Many accounts: block them when the file ends so other files' Team lists keep their own (TEAM_LIST_LIMIT).
retireUsersAfterFile();

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
  return { status: response.status, body: parsed, text, headers: response.headers };
}

async function putAccess(session: Session, path: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", path);
  expect(current.status).toBe(200);
  const saved = await send(session, "PUT", path, body, { "If-Match": current.headers.get("ETag")! });
  expect(saved.status).toBe(200);
  return saved;
}

const tag = () => crypto.randomUUID().slice(0, 8);

async function groupWith(admin: Session, members: Session[], name = `Central ${tag()}`) {
  const created = (await send(admin, "POST", "/team/groups", { name })).body.group;
  await send(admin, "PUT", `/team/groups/${created.id}/members`, { userIds: members.map((member) => member.userId), revision: 1 });
  return created.id as string;
}

async function board(owner: Session, name: string) {
  return (await send(owner, "POST", "/tasks/boards", { name })).body.board.id as string;
}

const items = async (admin: Session, userId: string, kind: string, cursor?: string) =>
  send(admin, "GET", `/team/members/${userId}/access?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);

describe("the member access page", () => {
  test("admins only: guests get 404, members and viewers 403; the self view is for every role but guests", async () => {
    const admin = await user("Central gate admin", "admin");
    const member = await user("Central gate member");
    const viewer = await user("Central gate viewer", "viewer");
    const guest = await user("Central gate guest", "guest");
    expect((await send(member, "GET", `/team/members/${viewer.userId}/access`)).body.code).toBe("ADMIN_ONLY");
    expect((await send(viewer, "GET", `/team/members/${member.userId}/access`)).status).toBe(403);
    expect((await send(guest, "GET", `/team/members/${member.userId}/access`)).status).toBe(404);
    expect((await send(member, "POST", `/team/members/${viewer.userId}/access/reset`, {})).status).toBe(403);
    expect((await send(admin, "GET", `/team/members/${crypto.randomUUID()}/access`)).status).toBe(404);
    expect((await send(admin, "GET", "/team/members/not-a-uuid/access")).status).toBe(404);
    expect((await send(admin, "GET", `/team/members/${member.userId}/access?kind=nope`)).status).toBe(400);

    expect((await send(guest, "GET", "/me/access")).status).toBe(404);
    const mine = await send(viewer, "GET", "/me/access");
    expect(mine.status).toBe(200);
    expect(mine.body.member).toMatchObject({ id: viewer.userId, role: "viewer", isYou: true });
    expect(mine.headers.get("Cache-Control")).toContain("no-store");
  });

  test("lists direct and group grants per kind, hides titles and ids the admin cannot read (D269, T204), and counts audience-wide items", async () => {
    const admin = await user("Central list admin", "admin");
    const owner = await user("Central list owner");
    const target = await user("Central list target");
    const groupId = await groupWith(admin, [target]);
    const secretName = `Secret board ${tag()}`;
    const secret = await board(owner, secretName);
    await putAccess(owner, `/tasks/boards/${secret}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [] });
    const collectionName = `Group collection ${tag()}`;
    const collection = (await newCollection(owner, { name: collectionName, fields: [{ name: "Name", type: "text" }] })).id;
    await putAccess(owner, `/collections/${collection}/access`, { audience: "selected", people: [], groups: [{ id: groupId, level: "edit" }] });
    // The admin's own board, shared with the target: its title and id show.
    const ownName = `Admin board ${tag()}`;
    const own = await board(admin, ownName);
    await putAccess(admin, `/tasks/boards/${own}/access`, { audience: "selected", people: [{ id: target.userId, level: "manage" }], groups: [] });
    // An everyone calendar is an audience-wide count, never a row.
    const everyone = (await send(owner, "POST", "/calendars", { name: `Everyone ${tag()}`, color: "blue" })).body.calendar.id as string;
    cleanups.push(() => { db.query("UPDATE calendars SET visibility = 'private' WHERE id = ?").run(everyone); });
    await putAccess(owner, `/calendars/${everyone}/access`, { audience: "all_users", people: [], groups: [] });

    const summary = await send(admin, "GET", `/team/members/${target.userId}/access`);
    expect(summary.status).toBe(200);
    expect(summary.body.member).toMatchObject({ id: target.userId, displayName: "Central list target", isYou: false });
    expect(summary.body.groups.map((group: { id: string }) => group.id)).toContain(groupId);
    const byKind = Object.fromEntries(summary.body.kinds.map((row: { kind: string }) => [row.kind, row]));
    expect(byKind.board).toMatchObject({ items: 2, direct: 2, group: 0 });
    expect(byKind.collection).toMatchObject({ group: 1 });
    expect(byKind.calendar.audience).toBeGreaterThanOrEqual(1);
    expect(summary.body.pageSize).toBe(200);

    const boards = await items(admin, target.userId, "board");
    expect(boards.status).toBe(200);
    const hidden = boards.body.items.find((item: { titleHidden: boolean }) => item.titleHidden);
    expect(hidden).toMatchObject({ kind: "board", title: "Board owned by Central list owner", titleHidden: true, level: "edit", active: true, sources: [{ via: "direct", level: "edit", lowerTo: ["view", "comment"] }] });
    expect(hidden.id).toBeUndefined();
    expect(typeof hidden.sources[0].handle).toBe("string");
    expect(boards.text).not.toContain(secret);
    expect(boards.text).not.toContain(secretName);
    const visible = boards.body.items.find((item: { titleHidden: boolean }) => !item.titleHidden);
    expect(visible).toMatchObject({ id: own, title: ownName, level: "manage", sources: [{ via: "direct", lowerTo: ["view", "comment", "edit"] }] });
    const collections = await items(admin, target.userId, "collection");
    expect(collections.body.items).toHaveLength(1);
    expect(collections.body.items[0]).toMatchObject({ title: "Collection owned by Central list owner", sources: [{ via: "group", group: { id: groupId }, lowerTo: [] }] });
    expect(collections.text).not.toContain(collection);
    expect(collections.text).not.toContain(collectionName);

    // The self view shows the person's own titles and carries no handles.
    const self = await send(target, "GET", "/me/access?kind=board");
    expect(self.body.items.map((item: { title: string }) => item.title).sort()).toEqual([ownName, secretName].sort());
    expect(self.body.items.every((item: { sources: Array<{ handle?: string }> }) => item.sources.every((source) => source.handle === undefined))).toBe(true);

    // A guest never counts audience-wide items.
    const guest = await user("Central list guest", "guest");
    const guestSummary = await send(admin, "GET", `/team/members/${guest.userId}/access`);
    expect(guestSummary.body.kinds.every((row: { audience: number }) => row.audience === 0)).toBe(true);
  });

  test("handles are opaque, bound to the admin and the person, and refused when tampered with", async () => {
    const admin = await user("Handle admin", "admin");
    const other = await user("Handle other admin", "admin");
    const owner = await user("Handle owner");
    const target = await user("Handle target");
    const second = await user("Handle second");
    const id = await board(owner, "Handle board");
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }, { id: second.userId, level: "edit" }], groups: [] });
    const handle = (await items(admin, target.userId, "board")).body.items[0].sources[0].handle as string;
    expect(handle).not.toContain(id);
    expect(Buffer.from(handle, "base64url").toString("latin1")).not.toContain(id);
    // Another admin, another person, or a changed byte: the same 404.
    expect((await send(other, "DELETE", `/team/members/${target.userId}/access/${handle}`)).status).toBe(404);
    expect((await send(admin, "DELETE", `/team/members/${second.userId}/access/${handle}`)).status).toBe(404);
    const flipped = `${handle.slice(0, -2)}${handle.endsWith("AA") ? "BB" : "AA"}`;
    expect((await send(admin, "DELETE", `/team/members/${target.userId}/access/${flipped}`)).status).toBe(404);
    expect((await send(admin, "DELETE", `/team/members/${target.userId}/access/short`)).status).toBe(404);
    // An expired handle is refused too.
    const expired = sealItemHandle(admin.userId, target.userId, { kind: "board", id, via: "direct", groupId: null }, Date.now() - 7 * 3_600_000);
    expect((await send(admin, "DELETE", `/team/members/${target.userId}/access/${expired}`)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM board_members WHERE board_id = ?").get(id)).toEqual({ count: 2 });
  });
});

describe("admin reductions (D268)", () => {
  test("removing a direct share ends access at once, is logged, and tells the owner; a second try is 404", async () => {
    const admin = await user("Remove admin", "admin");
    const owner = await user("Remove owner");
    const target = await user("Remove target");
    const name = `Removed board ${tag()}`;
    const id = await board(owner, name);
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [] });
    expect((await send(target, "GET", `/tasks/boards/${id}`)).status).toBe(200);
    const handle = (await items(admin, target.userId, "board")).body.items[0].sources[0].handle as string;

    const removed = await send(admin, "DELETE", `/team/members/${target.userId}/access/${handle}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: "share", kind: "board" });
    expect((await send(target, "GET", `/tasks/boards/${id}`)).status).toBe(404);
    expect((await send(admin, "DELETE", `/team/members/${target.userId}/access/${handle}`)).status).toBe(404);

    const event = db.query("SELECT actor_id, target_user_id, resource_kind, resource_id, meta_json FROM access_events WHERE action = 'access.share_removed' AND target_user_id = ?").get(target.userId) as Record<string, string>;
    expect(event).toMatchObject({ actor_id: admin.userId, resource_kind: "board", resource_id: id });
    expect(JSON.parse(event.meta_json!)).toEqual({ level: "edit" });
    const bell = await send(owner, "GET", "/notifications");
    expect(bell.body.items[0].title).toBe(`Remove admin removed Remove target's access to “${name}”`);
    expect(bell.body.items[0].href).toBe("/notifications");
    expect(bell.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect((await send(owner, "POST", "/notifications/read", { all: true })).body.updated).toBeGreaterThanOrEqual(1);
    expect((await send(owner, "GET", "/notifications")).body.unreadCount).toBe(0);
  });

  test("lowering is reduction only: never up, never sideways, only offered levels", async () => {
    const admin = await user("Lower admin", "admin");
    const owner = await user("Lower owner");
    const target = await user("Lower target");
    const id = await board(owner, "Lower board");
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [] });
    const row = (await items(admin, target.userId, "board")).body.items[0];
    const path = `/team/members/${target.userId}/access/${row.sources[0].handle}`;
    expect((await send(admin, "PATCH", path, { level: "manage" })).body.code).toBe("NOT_A_REDUCTION");
    expect((await send(admin, "PATCH", path, { level: "edit" })).body.code).toBe("NOT_A_REDUCTION");
    expect((await send(admin, "PATCH", path, { level: "view", extra: 1 })).status).toBe(400);
    const lowered = await send(admin, "PATCH", path, { level: "comment" });
    expect(lowered.status).toBe(200);
    expect(lowered.body).toMatchObject({ lowered: true, from: "edit", to: "comment" });
    expect(db.query("SELECT level FROM board_members WHERE board_id = ? AND user_id = ?").get(id, target.userId)).toEqual({ level: "comment" });
    // The same handle cannot raise it back.
    expect((await send(admin, "PATCH", path, { level: "edit" })).body.code).toBe("NOT_A_REDUCTION");
    expect(db.query("SELECT COUNT(*) AS count FROM access_events WHERE action = 'access.share_lowered' AND target_user_id = ?").get(target.userId)).toEqual({ count: 1 });
    // The owner's bell names the new level (review R2).
    expect((await send(owner, "GET", "/notifications")).body.items[0].title).toBe("Lower admin lowered Lower target's access to “Lower board” to Can comment");
    // Manager → edit says "Can edit", not "Can view or less".
    const managed = await board(owner, "Managed board");
    await putAccess(owner, `/tasks/boards/${managed}/access`, { audience: "selected", people: [{ id: target.userId, level: "manage" }], groups: [] });
    const managedRow = (await items(admin, target.userId, "board")).body.items.find((item: { title: string }) => item.title === "Board owned by Lower owner" && item.level === "manage");
    expect((await send(admin, "PATCH", `/team/members/${target.userId}/access/${managedRow.sources[0].handle}`, { level: "edit" })).status).toBe(200);
    expect((await send(owner, "GET", "/notifications")).body.items[0].title).toBe("Lower admin lowered Lower target's access to “Managed board” to Can edit");

    // A file share is view-only: nothing to lower to.
    const form = new FormData();
    form.append("file", new Blob(["lower"], { type: "text/plain" }), "lower.txt");
    const document = ((await (await request("/files", { method: "POST", body: form }, owner)).json()) as { document: { id: string } }).document.id;
    await putAccess(owner, `/files/${document}/access`, { audience: "selected", people: [{ id: target.userId, level: "view" }], groups: [] });
    const file = (await items(admin, target.userId, "document")).body.items[0];
    expect(file.sources[0].lowerTo).toEqual([]);
    expect((await send(admin, "PATCH", `/team/members/${target.userId}/access/${file.sources[0].handle}`, { level: "view" })).body.code).toBe("NOT_A_REDUCTION");
  });

  test("a group row removes the person from the group; the member hears about it, and the group page moves on", async () => {
    const admin = await user("Group row admin", "admin");
    const owner = await user("Group row owner");
    const target = await user("Group row target");
    const groupName = `Row group ${tag()}`;
    const groupId = await groupWith(admin, [target], groupName);
    const id = await board(owner, "Group row board");
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [], groups: [{ id: groupId, level: "view" }] });
    const row = (await items(admin, target.userId, "board")).body.items[0];
    expect(row.sources).toMatchObject([{ via: "group", group: { id: groupId, name: groupName } }]);
    const removed = await send(admin, "DELETE", `/team/members/${target.userId}/access/${row.sources[0].handle}`);
    expect(removed.body).toMatchObject({ removed: "group", groupId });
    expect((await send(target, "GET", `/tasks/boards/${id}`)).status).toBe(404);
    expect((await send(admin, "GET", `/team/groups/${groupId}`)).body.group).toMatchObject({ memberCount: 0, revision: 3 });
    const bell = await send(target, "GET", "/notifications");
    expect(bell.body.items.map((item: { title: string }) => item.title)).toContain(`Group row admin removed you from the group “${groupName}”`);
    expect(bell.body.items.map((item: { title: string }) => item.title)).toContain(`Group row admin added you to the group “${groupName}”`);
    // Directly by group id as well.
    await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [target.userId], revision: 3 });
    expect((await send(admin, "DELETE", `/team/members/${target.userId}/groups/${groupId}`)).status).toBe(200);
    expect((await send(admin, "DELETE", `/team/members/${target.userId}/groups/${groupId}`)).status).toBe(404);
    // C15a: once the group is deleted, older notices say so in a sentence of their own.
    const revision = (await send(admin, "GET", `/team/groups/${groupId}`)).body.group.revision;
    expect((await send(admin, "DELETE", `/team/groups/${groupId}`, { revision })).status).toBe(200);
    const titles = ((await send(target, "GET", "/notifications")).body.items as Array<{ title: string }>).map((item) => item.title);
    expect(titles).toContain("Group row admin added you to a group that has since been deleted");
    expect(titles).toContain("Group row admin removed you from a group that has since been deleted");
    expect(titles.some((title) => title.includes("the group a group"))).toBe(false);
  });

  test("Reset access removes shares, groups, keys, feeds, and routines in one go, with counts before and after; never on yourself", async () => {
    const admin = await user("Reset admin", "admin");
    const ownerA = await user("Reset owner A");
    const ownerB = await user("Reset owner B");
    const target = await user("Reset target");
    const groupId = await groupWith(admin, [target]);
    const boardA = await board(ownerA, "Reset A1");
    const boardA2 = await board(ownerA, "Reset A2");
    const boardB = await board(ownerB, "Reset B");
    for (const [owner, id] of [[ownerA, boardA], [ownerA, boardA2], [ownerB, boardB]] as const) {
      await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [] });
    }
    const everyone = await board(ownerB, "Reset everyone");
    cleanups.push(() => { db.query("UPDATE boards SET visibility = 'private' WHERE id = ?").run(everyone); });
    await putAccess(ownerB, `/tasks/boards/${everyone}/access`, { audience: "all_users", people: [], groups: [] });
    const key = createApiKey(target.userId, { name: "Reset key", surfaces: "mcp", grants: [{ module: "tasks", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const calendar = (await send(target, "POST", "/calendars", { name: "Own calendar", color: "blue" })).body.calendar.id as string;
    db.query("INSERT INTO calendar_feeds (id, calendar_id, user_id, token_hash, token_prefix, detail, created_at) VALUES (?, ?, ?, ?, 'abcdef', 'busy', ?)")
      .run(crypto.randomUUID(), calendar, target.userId, "f".repeat(64).replace(/^f{8}/, tag()), new Date().toISOString());

    const before = (await send(admin, "GET", `/team/members/${target.userId}/access`)).body.resetCounts;
    expect(before).toEqual({ directShares: 3, groups: 1, keys: 1, feeds: 1, routines: 0 });
    expect((await send(admin, "POST", `/team/members/${admin.userId}/access/reset`, {})).body.code).toBe("SELF_ACTION");
    expect((await send(admin, "POST", `/team/members/${target.userId}/access/reset`, { force: true })).status).toBe(400);

    const reset = await send(admin, "POST", `/team/members/${target.userId}/access/reset`, {});
    expect(reset.status).toBe(200);
    expect(reset.body.removed).toEqual({ directShares: 3, groups: 1, keys: 1, feeds: 1, routines: 0 });
    expect(reset.body.remaining).toEqual({ directShares: 0, groups: 0, keys: 0, feeds: 0, routines: 0 });
    // Owned items and everyone-signed-in stay.
    expect((await send(target, "GET", `/tasks/boards/${everyone}`)).status).toBe(200);
    expect((await send(target, "GET", `/tasks/boards/${boardA}`)).status).toBe(404);
    expect(db.query("SELECT revoked_by, revoke_reason FROM mcp_api_keys WHERE id = ?").get(key.id)).toEqual({ revoked_by: admin.userId, revoke_reason: "Access reset by an admin" });
    // One notice per owner, with their count; one for the person.
    expect((await send(ownerA, "GET", "/notifications")).body.items[0].title).toBe("Reset admin reset Reset target's access, including 2 of your items");
    expect((await send(ownerB, "GET", "/notifications")).body.items[0].title).toBe("Reset admin reset Reset target's access, including 1 of your items");
    const own = (await send(target, "GET", "/notifications")).body.items.map((item: { title: string }) => item.title);
    expect(own).toContain("Reset admin reset your access: direct shares, groups, API keys, and calendar feeds");
    expect(own.some((title: string) => title.includes("revoked your API key"))).toBe(false);
    const event = db.query("SELECT meta_json FROM access_events WHERE action = 'access.reset' AND target_user_id = ?").get(target.userId) as { meta_json: string };
    expect(JSON.parse(event.meta_json)).toEqual({ directShares: 3, groups: 1, keys: 1, feeds: 1, routines: 0 });
  });

  test("the person's Reset line names only what was removed (QA Q5)", async () => {
    const admin = await user("Reset line admin", "admin");
    const owner = await user("Reset line owner");
    const target = await user("Reset line target");
    const id = await board(owner, "Reset line board");
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [] });
    expect((await send(admin, "POST", `/team/members/${target.userId}/access/reset`, {})).status).toBe(200);
    expect((await send(target, "GET", "/notifications")).body.items[0].title).toBe("Reset line admin reset your access: direct shares");
  });

  test("an admin revoking a key from Team → Keys puts a notice on the owner's bell", async () => {
    const admin = await user("Key bell admin", "admin");
    const owner = await user("Key bell owner");
    const key = createApiKey(owner.userId, { name: "Bell key", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect((await send(admin, "POST", `/team/keys/${key.id}/revoke`, { reason: "Leaving" })).status).toBe(200);
    expect((await send(owner, "GET", "/notifications")).body.items[0].title).toBe("Key bell admin revoked your API key “Bell key”");
  });
});

describe("paging and the activity log (T218, D288)", () => {
  test("pages hold 200 rows with a sealed cursor that only works for its viewer", async () => {
    const admin = await user("Paging admin", "admin");
    const other = await user("Paging other admin", "admin");
    const owner = await user("Paging owner");
    const target = await user("Paging target");
    const at = new Date().toISOString();
    for (let index = 0; index < 205; index += 1) {
      const id = crypto.randomUUID();
      db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, visibility, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, 'selected', ?, ?)").run(id, owner.userId, `Paged ${index}`, at, at);
      db.query("INSERT INTO folder_shares (folder_id, user_id, created_at, level) VALUES (?, ?, ?, 'view')").run(id, target.userId, at);
    }
    const first = await items(admin, target.userId, "folder");
    expect(first.body.items).toHaveLength(200);
    expect(first.body.items.every((item: { titleHidden: boolean; active: boolean }) => item.titleHidden && item.active)).toBe(true);
    expect(typeof first.body.nextCursor).toBe("string");
    const second = await items(admin, target.userId, "folder", first.body.nextCursor);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    expect((await items(other, target.userId, "folder", first.body.nextCursor)).body.code).toBe("INVALID_CURSOR");
    expect((await items(admin, target.userId, "note", first.body.nextCursor)).status).toBe(400);
  });

  test("the activity view filters by person and action family and redacts items the admin cannot open", async () => {
    const admin = await user("Activity admin", "admin");
    const owner = await user("Activity owner");
    const target = await user("Activity target");
    const name = `Activity board ${tag()}`;
    const id = await board(owner, name);
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [] });
    const handle = (await items(admin, target.userId, "board")).body.items[0].sources[0].handle as string;
    await send(admin, "DELETE", `/team/members/${target.userId}/access/${handle}`);

    const member = await user("Activity member");
    expect((await send(member, "GET", "/team/activity")).status).toBe(403);
    const activity = await send(admin, "GET", `/team/activity?user=${target.userId}&action=items`);
    expect(activity.status).toBe(200);
    const row = activity.body.events.find((event: { action: string }) => event.action === "access.share_removed");
    expect(row).toMatchObject({ actor: { id: admin.userId }, target: { id: target.userId }, item: { kind: "board", titleHidden: true, title: "Board owned by Activity owner" }, meta: { level: "edit" } });
    expect(activity.text).not.toContain(name);
    expect(activity.text).not.toContain(id);
    expect(activity.body.events.every((event: { action: string }) => event.action.startsWith("item.") || event.action.startsWith("access."))).toBe(true);
    expect((await send(admin, "GET", "/team/activity?action=bogus")).status).toBe(400);
    const keys = await send(admin, "GET", "/team/activity?action=keys");
    expect(keys.body.events.every((event: { action: string }) => event.action.startsWith("key."))).toBe(true);
    // C15b: key events carry the key's owner, so a key that is no longer live can be told apart.
    const created = createApiKey(target.userId, { name: "Gone key", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    db.query("UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), created.id);
    const byKey = await send(admin, "GET", `/team/activity?key=${created.id}`);
    expect(byKey.body.events[0].key).toEqual({ id: created.id, name: "Gone key", prefix: created.prefix, owner: { id: target.userId, displayName: "Activity target" } });
  });
});

describe("the Access sheet's key line (§C.5)", () => {
  test("the owner sees how many of their own usable keys reach the item; managers see no count", async () => {
    const owner = await user("Key line owner");
    const manager = await user("Key line manager");
    const id = await board(owner, "Key line board");
    await putAccess(owner, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: manager.userId, level: "manage" }], groups: [] });
    expect((await send(owner, "GET", `/tasks/boards/${id}/access`)).body.keysWithAccess).toBe(0);
    createApiKey(owner.userId, { name: "Tasks key", surfaces: "mcp", grants: [{ module: "tasks", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    createApiKey(owner.userId, { name: "Notes key", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect((await send(owner, "GET", `/tasks/boards/${id}/access`)).body.keysWithAccess).toBe(1);
    expect((await send(manager, "GET", `/tasks/boards/${id}/access`)).body.keysWithAccess).toBeUndefined();
  });
});

describe("review fixes (Wave 33)", () => {
  test("the key line counts only keys that reach the item now: not revoked, expired, or policy-blocked; a key in its rotation grace still counts (R6)", async () => {
    const owner = await user("Key states owner");
    const id = await board(owner, "Key states board");
    const tasks = (name: string, expiresInDays: number | null = 30) => createApiKey(owner.userId, { name, surfaces: "mcp", grants: [{ module: "tasks", permission: "read", resourceKind: null, resourceId: null }], expiresInDays });
    const count = async () => (await send(owner, "GET", `/tasks/boards/${id}/access`)).body.keysWithAccess as number;
    tasks("Active");
    const expired = tasks("Expired");
    db.query("UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), expired.id);
    const revoked = tasks("Revoked");
    db.query("UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), revoked.id);
    const grace = tasks("In grace");
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() + 3_600_000).toISOString(), grace.id);
    const graceEnded = tasks("Grace ended");
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), graceEnded.id);
    tasks("No expiry", null);
    expect(await count()).toBe(3);
    // A policy that requires an expiry blocks the key without one.
    cleanups.push(() => { db.query("DELETE FROM team_settings WHERE key = 'key_require_expiry'").run(); });
    db.query("INSERT OR REPLACE INTO team_settings (key, value_json, updated_at) VALUES ('key_require_expiry', 'true', ?)").run(new Date().toISOString());
    expect(await count()).toBe(2);
    // A guest's role allows no key scopes: nothing reaches the item.
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(owner.userId);
    expect(keysReachingItem(owner.userId, "tasks", "board", id)).toBe(0);
  });

  test("the order depends on the viewer and the person, so two people's pages never line up; the same page is stable (follow-up P1)", async () => {
    const admin = await user("Order mix admin", "admin");
    const first = await user("Order mix first");
    const second = await user("Order mix second");
    const at = new Date().toISOString();
    // 20 folders of one owner (the admin, so the ids show on the admin page) shared with both people.
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, visibility, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, 'selected', ?, ?)").run(id, admin.userId, `Mixed ${index}`, at, at);
      for (const person of [first, second]) db.query("INSERT INTO folder_shares (folder_id, user_id, created_at, level) VALUES (?, ?, ?, 'view')").run(id, person.userId, at);
    }
    const order = async (viewer: Session, path: string) => (await send(viewer, "GET", path)).body.items.map((item: { id: string }) => item.id) as string[];
    const adminFirst = await order(admin, `/team/members/${first.userId}/access?kind=folder`);
    const adminSecond = await order(admin, `/team/members/${second.userId}/access?kind=folder`);
    const selfFirst = await order(first, "/me/access?kind=folder");
    expect([...adminFirst].sort()).toEqual([...ids].sort());
    expect([...adminSecond].sort()).toEqual([...ids].sort());
    // 20 items: an equal order by chance is 1 in 20! (about 4e-19).
    expect(adminSecond).not.toEqual(adminFirst);
    expect(selfFirst).not.toEqual(adminFirst);
    // Stable: the same page twice comes in the same order.
    expect(await order(admin, `/team/members/${first.userId}/access?kind=folder`)).toEqual(adminFirst);
    expect(await order(first, "/me/access?kind=folder")).toEqual(selfFirst);
    // And the keys themselves differ per person and per viewer.
    expect(itemSortKey(admin.userId, first.userId, ids[0]!)).not.toBe(itemSortKey(admin.userId, second.userId, ids[0]!));
    expect(itemSortKey(first.userId, first.userId, ids[0]!)).not.toBe(itemSortKey(admin.userId, first.userId, ids[0]!));
  });

  test("one row per item with every way the person reaches it, ordered by owner then a keyed hash, never by id (R3)", async () => {
    const admin = await user("Order admin", "admin");
    const zed = await user("Zed order owner");
    const amy = await user("Amy order owner");
    const target = await user("Order target");
    const groupId = await groupWith(admin, [target]);
    const both = await board(zed, "Both ways");
    await putAccess(zed, `/tasks/boards/${both}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [{ id: groupId, level: "view" }] });
    const amyBoards: string[] = [];
    for (const name of ["A1", "A2", "A3", "A4"]) {
      const id = await board(amy, name);
      amyBoards.push(id);
      await putAccess(amy, `/tasks/boards/${id}/access`, { audience: "selected", people: [{ id: target.userId, level: "view" }], groups: [] });
    }
    const page = await items(admin, target.userId, "board");
    expect(page.body.items).toHaveLength(5);
    // Amy's boards first, among themselves in keyed-hash order; then Zed's one row with both sources.
    expect(page.body.items.slice(0, 4).map((item: { owner: { displayName: string } }) => item.owner.displayName)).toEqual(Array(4).fill("Amy order owner"));
    const expectedAmy = [...amyBoards].sort((left, right) => itemSortKey(target.userId, target.userId, left) < itemSortKey(target.userId, target.userId, right) ? -1 : 1);
    const selfPage = await send(target, "GET", "/me/access?kind=board");
    expect(selfPage.body.items.slice(0, 4).map((item: { id: string }) => item.id)).toEqual(expectedAmy);
    const last = page.body.items[4];
    expect(last).toMatchObject({ title: "Board owned by Zed order owner", titleHidden: true, level: "edit" });
    expect(last.sources.map((source: { via: string }) => source.via)).toEqual(["direct", "group"]);
    expect(page.text).not.toContain(both);
  });
});
