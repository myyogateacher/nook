import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");

/**
 * Groups (Wave 32, access plan D267, O-A1, T200, T213): admin-managed membership with a revision
 * CAS and an append-only history; owners share with a group, admins decide who is in it.
 */

beforeEach(() => resetTeamRateLimits());

type Role = "admin" | "member" | "viewer" | "guest";
export async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

export async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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
