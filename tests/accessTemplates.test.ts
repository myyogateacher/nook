import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, spareEmail, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { resetInviteRateLimits } = await import("../server/team/invites");
const { resetRegistrationRateLimit } = await import("../server/index");

/**
 * Access templates (Wave 33, access plan D286, §C.6): a role plus groups, admin CRUD with a
 * revision CAS, attached to an invite and applied inside the registration transaction; a deleted
 * template leaves the invite working (ON DELETE SET NULL). Templates never grant items directly.
 */

beforeEach(() => {
  resetTeamRateLimits();
  resetInviteRateLimits();
  resetRegistrationRateLimit();
});

// Many accounts: block them when the file ends so other files' Team lists keep their own (TEAM_LIST_LIMIT).
retireUsersAfterFile();

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function send(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

const tag = () => crypto.randomUUID().slice(0, 8);
const group = async (admin: Session) => (await send(admin, "POST", "/team/groups", { name: `Template group ${tag()}` })).body.group.id as string;
const registerWith = (body: Record<string, unknown>) => {
  resetRegistrationRateLimit();
  return send(undefined, "POST", "/auth/register", { displayName: "Template invitee", password: "correct horse battery staple", ...body });
};
const groupsOf = (userId: string) => (db.query("SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id").all(userId) as Array<{ group_id: string }>).map((row) => row.group_id);

describe("access templates", () => {
  test("admins create, edit, list, and delete; everyone else is refused; names are unique", async () => {
    const admin = await user("Template admin", "admin");
    const member = await user("Template member");
    const guest = await user("Template guest", "guest");
    const ops = await group(admin);
    const name = `Ops ${tag()}`;
    expect((await send(member, "GET", "/team/templates")).status).toBe(403);
    expect((await send(guest, "GET", "/team/templates")).status).toBe(404);
    expect((await send(member, "POST", "/team/templates", { name, role: "member", groupIds: [] })).status).toBe(403);

    const created = await send(admin, "POST", "/team/templates", { name, role: "member", groupIds: [ops] });
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject({ name, role: "member", groups: [{ id: ops }], liveInvites: 0, revision: 1 });
    const id = created.body.template.id as string;
    expect((await send(admin, "POST", "/team/templates", { name: name.toUpperCase(), role: "viewer" })).body.code).toBe("NAME_TAKEN");
    expect((await send(admin, "POST", "/team/templates", { name: "Admins", role: "admin" })).status).toBe(400);
    expect((await send(admin, "POST", "/team/templates", { name: `Bad ${tag()}`, role: "member", groupIds: [crypto.randomUUID()] })).body.code).toBe("INVALID_GROUPS");
    expect((await send(admin, "POST", "/team/templates", { name: `Extra ${tag()}`, role: "member", extra: true })).status).toBe(400);

    const patched = await send(admin, "PATCH", `/team/templates/${id}`, { role: "viewer", groupIds: [], revision: 1 });
    expect(patched.body.template).toMatchObject({ role: "viewer", groups: [], revision: 2 });
    expect((await send(admin, "PATCH", `/team/templates/${id}`, { name: "Stale", revision: 1 })).body.code).toBe("TEMPLATE_CHANGED");
    expect((await send(admin, "GET", "/team/templates")).body.templates.some((template: { id: string }) => template.id === id)).toBe(true);

    expect((await send(admin, "DELETE", `/team/templates/${id}`, { revision: 2 })).body).toMatchObject({ ok: true, liveInvites: 0 });
    expect((await send(admin, "DELETE", `/team/templates/${id}`, {})).status).toBe(404);
    const actions = (db.query("SELECT action FROM access_events WHERE action LIKE 'template.%' AND meta_json LIKE ? ORDER BY rowid").all(`%${id}%`) as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toEqual(["template.created", "template.updated", "template.deleted"]);
  });

  test("an invite with a template adds the new account to its groups in the registration transaction; the role must match", async () => {
    const admin = await user("Invite template admin", "admin");
    const first = await group(admin);
    const second = await group(admin);
    const template = (await send(admin, "POST", "/team/templates", { name: `Onboard ${tag()}`, role: "viewer", groupIds: [first, second] })).body.template;
    expect((await send(admin, "POST", "/team/invites", { role: "member", templateId: template.id })).body.code).toBe("TEMPLATE_ROLE_MISMATCH");
    expect((await send(admin, "POST", "/team/invites", { role: "viewer", templateId: crypto.randomUUID() })).body.code).toBe("TEMPLATE_NOT_FOUND");
    const invite = await send(admin, "POST", "/team/invites", { role: "viewer", templateId: template.id });
    expect(invite.status).toBe(201);
    expect(invite.body.invite.template).toEqual({ id: template.id, name: template.name, groupCount: 2, edited: false, guestSkipped: [] });
    expect((await send(admin, "GET", "/team/templates")).body.templates.find((row: { id: string }) => row.id === template.id).liveInvites).toBe(1);
    // A group deleted meanwhile is skipped; the other one is joined.
    await send(admin, "DELETE", `/team/groups/${second}`, {});

    const registered = await registerWith({ email: spareEmail(), inviteToken: invite.body.token });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe("viewer");
    const userId = registered.body.user.id as string;
    expect(groupsOf(userId)).toEqual([first]);
    const member = db.query("SELECT added_by FROM group_members WHERE group_id = ? AND user_id = ?").get(first, userId) as { added_by: string };
    expect(member.added_by).toBe(admin.userId);
    const applied = db.query("SELECT actor_id, meta_json FROM access_events WHERE action = 'template.applied' AND target_user_id = ?").get(userId) as { actor_id: string; meta_json: string };
    expect(applied.actor_id).toBe(admin.userId);
    expect(JSON.parse(applied.meta_json)).toEqual({ templateId: template.id, templateName: template.name, added: 1, skipped: 1 });
  });

  test("editing a template never changes an invite already sent: registration gets the groups it had then, the invite's role, and the inviting admin as adder (review R1)", async () => {
    const adminA = await user("Snapshot admin A", "admin");
    const adminB = await user("Snapshot admin B", "admin");
    const original = await group(adminA);
    const later = await group(adminB);
    const template = (await send(adminA, "POST", "/team/templates", { name: `Snapshot ${tag()}`, role: "member", groupIds: [original] })).body.template;
    const invite = (await send(adminA, "POST", "/team/invites", { role: "member", templateId: template.id })).body;
    expect(invite.invite.template).toMatchObject({ id: template.id, name: template.name, groupCount: 1, edited: false });
    // Admin B changes the template's groups, role, and name after the invite went out.
    const edited = await send(adminB, "PATCH", `/team/templates/${template.id}`, { name: `${template.name} v2`, role: "viewer", groupIds: [later], revision: 1 });
    expect(edited.status).toBe(200);
    const listed = (await send(adminA, "GET", "/team/invites")).body.invites.find((row: { id: string }) => row.id === invite.invite.id);
    expect(listed.template).toEqual({ id: template.id, name: template.name, groupCount: 1, edited: true, guestSkipped: [] });
    const registered = await registerWith({ email: spareEmail(), inviteToken: invite.token });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe("member");
    const userId = registered.body.user.id as string;
    expect(groupsOf(userId)).toEqual([original]);
    expect(db.query("SELECT added_by FROM group_members WHERE group_id = ? AND user_id = ?").get(original, userId)).toEqual({ added_by: adminA.userId });
    // A new invite takes the edited template.
    const next = (await send(adminA, "POST", "/team/invites", { role: "viewer", templateId: template.id })).body;
    expect(next.invite.template).toMatchObject({ name: `${template.name} v2`, groupCount: 1, edited: false });
  });

  test("deleting a template leaves its invites working, with their role and no groups", async () => {
    const admin = await user("Deleted template admin", "admin");
    const ops = await group(admin);
    const template = (await send(admin, "POST", "/team/templates", { name: `Gone ${tag()}`, role: "member", groupIds: [ops] })).body.template;
    const invite = (await send(admin, "POST", "/team/invites", { role: "member", templateId: template.id })).body;
    expect((await send(admin, "DELETE", `/team/templates/${template.id}`, {})).body.liveInvites).toBe(1);
    expect((db.query("SELECT template_id FROM team_invites WHERE id = ?").get(invite.invite.id) as { template_id: string | null }).template_id).toBeNull();
    const listed = (await send(admin, "GET", "/team/invites")).body.invites.find((row: { id: string }) => row.id === invite.invite.id);
    expect(listed.template).toBeNull();
    const registered = await registerWith({ email: spareEmail(), inviteToken: invite.token });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe("member");
    expect(groupsOf(registered.body.user.id)).toEqual([]);
  });

  test("an admin applies a template to an existing person from their access page: groups only, never the role", async () => {
    const admin = await user("Apply template admin", "admin");
    const target = await user("Apply template target", "viewer");
    const ops = await group(admin);
    const template = (await send(admin, "POST", "/team/templates", { name: `Apply ${tag()}`, role: "member", groupIds: [ops] })).body.template;
    const applied = await send(admin, "POST", `/team/members/${target.userId}/templates/${template.id}/apply`, {});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ added: 1, skipped: 0 });
    expect(groupsOf(target.userId)).toEqual([ops]);
    expect((db.query("SELECT role FROM users WHERE id = ?").get(target.userId) as { role: string }).role).toBe("viewer");
    // Applying again adds nothing.
    expect((await send(admin, "POST", `/team/members/${target.userId}/templates/${template.id}/apply`, {})).body.added).toBe(0);
    expect((await send(admin, "POST", `/team/members/${target.userId}/templates/${crypto.randomUUID()}/apply`, {})).status).toBe(404);
    const member = await user("Apply template member");
    expect((await send(member, "POST", `/team/members/${target.userId}/templates/${template.id}/apply`, {})).status).toBe(403);
  });
});
