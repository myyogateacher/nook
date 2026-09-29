import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, spareEmail, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { resetInviteRateLimits } = await import("../server/team/invites");
const { resetRegistrationRateLimit } = await import("../server/index");

/**
 * Wave 33 with the Wave 32 review's guest rule (T213): with `share_with_guests` off, a guest never
 * joins a group that has grants, whether through Team → Groups, an invite's access template (the
 * group is skipped and recorded; the account is still created), or applying a template to someone
 * (refused as a whole). Refused changes send no bell notice. The member access page's reductions
 * (remove from a group, Reset access) always work with the policy off. Kind headlines count items.
 */

beforeEach(() => {
  resetTeamRateLimits();
  resetInviteRateLimits();
  resetRegistrationRateLimit();
});
afterEach(() => { db.query("DELETE FROM team_settings WHERE key = 'share_with_guests'").run(); });

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function send(session: Session | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

const policyOff = () => db.query("INSERT OR REPLACE INTO team_settings (key, value_json, updated_at) VALUES ('share_with_guests', 'false', ?)").run(new Date().toISOString());
const tag = () => crypto.randomUUID().slice(0, 8);
const notices = (userId: string) => (db.query("SELECT kind FROM access_notices WHERE user_id = ?").all(userId) as Array<{ kind: string }>).map((row) => row.kind);
const groupsOf = (userId: string) => (db.query("SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id").all(userId) as Array<{ group_id: string }>).map((row) => row.group_id);

async function putAccess(owner: Session, path: string, body: Record<string, unknown>) {
  const current = await send(owner, "GET", path);
  const saved = await send(owner, "PUT", path, body, { "If-Match": current.headers.get("ETag")! });
  expect(saved.status).toBe(200);
}

/** One granted group (a board shared with it) and one without grants. */
async function groups(admin: Session, owner: Session) {
  const granted = (await send(admin, "POST", "/team/groups", { name: `Granted ${tag()}` })).body.group.id as string;
  const plain = (await send(admin, "POST", "/team/groups", { name: `Plain ${tag()}` })).body.group.id as string;
  const board = (await send(owner, "POST", "/tasks/boards", { name: "Guest rule board" })).body.board.id as string;
  await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "selected", groups: [{ id: granted, level: "view" }] });
  return { granted, plain, board };
}

describe("the guest rule reaches templates (T213, D286)", () => {
  test("an invite's template skips a granted group for a guest and records it; the account is still created", async () => {
    const admin = await user("Guest template admin", "admin");
    const owner = await user("Guest template owner");
    const { granted, plain } = await groups(admin, owner);
    const template = (await send(admin, "POST", "/team/templates", { name: `Guests ${tag()}`, role: "guest", groupIds: [granted, plain] })).body.template;
    const invite = (await send(admin, "POST", "/team/invites", { role: "guest", templateId: template.id })).body;
    policyOff();
    resetRegistrationRateLimit();
    const registered = await send(undefined, "POST", "/auth/register", { displayName: "Guest invitee", password: "correct horse battery staple", email: spareEmail(), inviteToken: invite.token });
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id as string;
    expect(groupsOf(userId)).toEqual([plain]);
    const applied = db.query("SELECT meta_json FROM access_events WHERE action = 'template.applied' AND target_user_id = ?").get(userId) as { meta_json: string };
    expect(JSON.parse(applied.meta_json)).toEqual({ templateId: template.id, added: 1, skipped: 1, guestRefused: 1 });
  });

  test("applying a template to a guest is refused as a whole with the policy off, and allowed with it on", async () => {
    const admin = await user("Guest apply admin", "admin");
    const owner = await user("Guest apply owner");
    const guest = await user("Guest apply target", "guest");
    const { granted, plain } = await groups(admin, owner);
    const template = (await send(admin, "POST", "/team/templates", { name: `Apply guests ${tag()}`, role: "guest", groupIds: [plain, granted] })).body.template;
    policyOff();
    const refused = await send(admin, "POST", `/team/members/${guest.userId}/templates/${template.id}/apply`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("GUEST_SHARE_DISABLED");
    expect(groupsOf(guest.userId)).toEqual([]);
    expect(notices(guest.userId)).toEqual([]);
    db.query("DELETE FROM team_settings WHERE key = 'share_with_guests'").run();
    const allowed = await send(admin, "POST", `/team/members/${guest.userId}/templates/${template.id}/apply`, {});
    expect(allowed.body).toMatchObject({ added: 2, guestRefused: 0 });
  });

  test("a refused group change sends no bell notice", async () => {
    const admin = await user("Guest bell admin", "admin");
    const owner = await user("Guest bell owner");
    const member = await user("Guest bell member");
    const guest = await user("Guest bell guest", "guest");
    const { granted } = await groups(admin, owner);
    policyOff();
    const revision = (await send(admin, "GET", `/team/groups/${granted}`)).body.group.revision as number;
    const refused = await send(admin, "PUT", `/team/groups/${granted}/members`, { userIds: [member.userId, guest.userId], revision });
    expect(refused.body.code).toBe("GUEST_SHARE_DISABLED");
    expect(notices(member.userId)).toEqual([]);
    expect(notices(guest.userId)).toEqual([]);
  });

  test("reductions always work with the policy off: remove from a group and Reset access on a guest", async () => {
    const admin = await user("Guest reduce admin", "admin");
    const owner = await user("Guest reduce owner");
    const guest = await user("Guest reduce target", "guest");
    const other = await user("Guest reduce other", "guest");
    const { granted, board } = await groups(admin, owner);
    // Joined while the policy was on (not retroactive), plus a direct share.
    const revision = (await send(admin, "GET", `/team/groups/${granted}`)).body.group.revision as number;
    expect((await send(admin, "PUT", `/team/groups/${granted}/members`, { userIds: [guest.userId, other.userId], revision })).status).toBe(200);
    await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "selected", people: [{ id: guest.userId, level: "view" }], groups: [{ id: granted, level: "view" }] });
    policyOff();
    expect((await send(admin, "DELETE", `/team/members/${other.userId}/groups/${granted}`, {})).status).toBe(200);
    const reset = await send(admin, "POST", `/team/members/${guest.userId}/access/reset`, {});
    expect(reset.status).toBe(200);
    expect(reset.body.removed).toMatchObject({ directShares: 1, groups: 1 });
    expect(reset.body.remaining).toMatchObject({ directShares: 0, groups: 0 });
  });
});

describe("kind headlines count items (Wave 33 review)", () => {
  test("an item shared directly and through a group counts once", async () => {
    const admin = await user("Items admin", "admin");
    const owner = await user("Items owner");
    const target = await user("Items target");
    const group = (await send(admin, "POST", "/team/groups", { name: `Items ${tag()}` })).body.group.id as string;
    await send(admin, "PUT", `/team/groups/${group}/members`, { userIds: [target.userId], revision: 1 });
    const both = (await send(owner, "POST", "/tasks/boards", { name: "Both ways" })).body.board.id as string;
    const direct = (await send(owner, "POST", "/tasks/boards", { name: "Direct only" })).body.board.id as string;
    await putAccess(owner, `/tasks/boards/${both}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }], groups: [{ id: group, level: "view" }] });
    await putAccess(owner, `/tasks/boards/${direct}/access`, { audience: "selected", people: [{ id: target.userId, level: "edit" }] });
    const summary = await send(admin, "GET", `/team/members/${target.userId}/access`);
    expect(summary.body.kinds.find((row: { kind: string }) => row.kind === "board")).toMatchObject({ items: 2, direct: 2, group: 1 });
    expect((await send(target, "GET", "/me/access")).body.kinds.find((row: { kind: string }) => row.kind === "board").items).toBe(2);
  });
});
