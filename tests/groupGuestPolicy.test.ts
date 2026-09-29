import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");

/**
 * The `share_with_guests` policy and group membership (Wave 32 review, T213): with the policy off,
 * an admin cannot make a guest reach items by adding them to a group that already has a grant, or
 * by making someone in such a group a guest. Removals and ungranted groups are unaffected, and
 * the policy revokes nothing that already exists.
 */

beforeEach(() => resetTeamRateLimits());
afterEach(() => { db.query("DELETE FROM team_settings WHERE key = 'share_with_guests'").run(); });

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

const policyOff = () => db.query("INSERT OR REPLACE INTO team_settings (key, value_json, updated_at) VALUES ('share_with_guests', 'false', ?)").run(new Date().toISOString());
const tag = () => crypto.randomUUID().slice(0, 8);

/** A group with `members`, and a board shared with it at view (when `granted`). */
async function setup(label: string, members: Session[], granted = true) {
  const admin = await user(`${label} admin`, "admin");
  const owner = await user(`${label} owner`);
  const group = (await send(admin, "POST", "/team/groups", { name: `${label} ${tag()}` })).body.group;
  const filled = await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: members.map((member) => member.userId), revision: 1 });
  expect(filled.status).toBe(200);
  const board = (await send(owner, "POST", "/tasks/boards", { name: `${label} board` })).body.board.id as string;
  if (granted) {
    const path = `/tasks/boards/${board}/access`;
    const current = await send(owner, "GET", path);
    const shared = await send(owner, "PUT", path, { audience: "selected", groups: [{ id: group.id, level: "view" }] }, { "If-Match": current.headers.get("ETag")! });
    expect(shared.status).toBe(200);
  }
  return { admin, owner, groupId: group.id as string, board };
}

const revision = async (admin: Session, groupId: string) => (await send(admin, "GET", `/team/groups/${groupId}`)).body.group.revision as number;

describe("share_with_guests and group members", () => {
  test("with the policy off, adding a guest to a granted group is refused and the guest still cannot read", async () => {
    const member = await user("Policy member");
    const guest = await user("Policy guest", "guest");
    const { admin, groupId, board } = await setup("Policy grant", [member]);
    policyOff();
    const detail = (await send(admin, "GET", `/team/groups/${groupId}`)).body.group;
    expect(detail.guestAddRefused).toBe(true);
    const refused = await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [member.userId, guest.userId], revision: detail.revision });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: "Sharing with guests is turned off for this Nook", code: "GUEST_SHARE_DISABLED" });
    expect(db.query("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, guest.userId)).toBeNull();
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).status).toBe(404);
    // Nothing was written: the revision is unchanged, and adding a member alone still works.
    expect(await revision(admin, groupId)).toBe(detail.revision);
    const other = await user("Policy other member");
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [member.userId, other.userId], revision: detail.revision })).status).toBe(200);
  });

  test("with the policy off, guests already in a granted group stay and can be removed", async () => {
    const guest = await user("Policy stays guest", "guest");
    const member = await user("Policy stays member");
    // Shared while the policy was on (the default): the guest reads through the group.
    const { admin, groupId, board } = await setup("Policy stays", [guest, member]);
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).status).toBe(200);
    policyOff();
    // Not retroactive: the guest keeps reading.
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).status).toBe(200);
    // Keeping the guest while adding nobody new is fine, and so is removing them.
    const kept = await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [guest.userId, member.userId], revision: await revision(admin, groupId) });
    expect(kept.status).toBe(200);
    const removed = await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [member.userId], revision: await revision(admin, groupId) });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(1);
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).status).toBe(404);
  });

  test("with the policy off, a guest may join a group with no grants, and sharing that group is then refused", async () => {
    const guest = await user("Policy ungranted guest", "guest");
    const { admin, owner, groupId, board } = await setup("Policy ungranted", [], false);
    policyOff();
    expect((await send(admin, "GET", `/team/groups/${groupId}`)).body.group.guestAddRefused).toBe(false);
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [guest.userId], revision: await revision(admin, groupId) })).status).toBe(200);
    const path = `/tasks/boards/${board}/access`;
    const current = await send(owner, "GET", path);
    const shared = await send(owner, "PUT", path, { audience: "selected", groups: [{ id: groupId, level: "view" }] }, { "If-Match": current.headers.get("ETag")! });
    expect(shared.body.code).toBe("GUEST_SHARE_DISABLED");
  });

  test("with the policy on, a guest joins a granted group and reads at view", async () => {
    const guest = await user("Policy on guest", "guest");
    const { admin, groupId, board } = await setup("Policy on", []);
    expect((await send(admin, "GET", `/team/groups/${groupId}`)).body.group.guestAddRefused).toBe(false);
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [guest.userId], revision: await revision(admin, groupId) })).status).toBe(200);
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).body.board.level).toBe("view");
  });

  test("with the policy off, someone in a granted group cannot be made a guest until they leave it", async () => {
    const member = await user("Policy demote member");
    const { admin, groupId, board } = await setup("Policy demote", [member]);
    policyOff();
    const refused = await send(admin, "PUT", `/team/${member.userId}/role`, { role: "guest", expectedRole: "member" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("GUEST_SHARE_DISABLED");
    expect(db.query("SELECT role FROM users WHERE id = ?").get(member.userId)).toEqual({ role: "member" });
    // Other role changes are unaffected.
    expect((await send(admin, "PUT", `/team/${member.userId}/role`, { role: "viewer", expectedRole: "member" })).status).toBe(200);
    expect((await send(admin, "PUT", `/team/groups/${groupId}/members`, { userIds: [], revision: await revision(admin, groupId) })).status).toBe(200);
    expect((await send(admin, "PUT", `/team/${member.userId}/role`, { role: "guest", expectedRole: "viewer" })).status).toBe(200);
    expect((await send(member, "GET", `/tasks/boards/${board}`)).status).toBe(404);
  });
});
