import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTeamRateLimits } = await import("../server/team/routes");
const { runDispatch, resetReminderDeferrals } = await import("../server/calendar/reminders");
const { totpCodeAt, totpCounter } = await import("../server/totp");
// Fixture dates sit five years ahead of the current year (C12), so they never fall into the past.
const Y = new Date().getUTCFullYear() + 5;

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

async function call(session: Session | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(`/team${path}`, method === "GET" ? { headers } : { method, headers, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

const roleOf = (session: Session) => (db.query("SELECT role FROM users WHERE id = ?").get(session.userId) as { role: string }).role;
const eventsFor = (session: Session) => db.query("SELECT action, via, actor_id, from_role, to_role, reason FROM team_events WHERE target_user_id = ? ORDER BY rowid").all(session.userId) as Array<Record<string, unknown>>;
const sessionCount = (session: Session) => (db.query("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(session.userId) as { count: number }).count;
const me = (session: Session) => request("/auth/me", {}, session);
const login = (session: Session, password = session.password, extra: Record<string, unknown> = {}) =>
  request("/auth/login", { method: "POST", body: JSON.stringify({ email: session.email, password, ...extra }) });

/** Temporarily leaves `keep` as the only active admin (the shared test database has others), then restores them. */
async function asOnlyAdmin<T>(keep: Session, run: () => Promise<T>) {
  const others = db.query("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?").all(keep.userId) as Array<{ id: string }>;
  for (const other of others) db.query("UPDATE users SET role = 'member' WHERE id = ?").run(other.id);
  try {
    return await run();
  } finally {
    for (const other of others) db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(other.id);
  }
}

let rpcId = 0;
async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  if (response.status !== 200) return { status: response.status, body: null as any };
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return { status: 200, body: JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } } };
}

describe("Team API: reading", () => {
  test("admins get metadata, members get names and roles only, guests get 404 everywhere", async () => {
    const admin = await user("Read admin", "admin");
    const member = await user("Read member");
    const guest = await user("Read guest", "guest");

    const asAdmin = await call(admin, "GET", "");
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.me).toEqual({ id: admin.userId, role: "admin" });
    const memberAsSeenByAdmin = asAdmin.body.users.find((row: { id: string }) => row.id === member.userId);
    expect(memberAsSeenByAdmin).toMatchObject({ displayName: "Read member", role: "member", status: "active", isYou: false, email: member.email, totpEnabled: false, mcpKeys: { live: 0 }, emailAllowed: true });
    expect(asAdmin.body.users.find((row: { id: string }) => row.id === admin.userId).isYou).toBe(true);
    expect(asAdmin.body.users.length).toBeLessThanOrEqual(500);

    const asMember = await call(member, "GET", "");
    expect(asMember.status).toBe(200);
    const adminAsSeenByMember = asMember.body.users.find((row: { id: string }) => row.id === admin.userId);
    expect(Object.keys(adminAsSeenByMember).sort()).toEqual(["createdAt", "displayName", "id", "isYou", "role", "status"]);
    expect(JSON.stringify(asMember.body)).not.toContain("@example.test");

    const detail = await call(member, "GET", `/${admin.userId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.member.email).toBeUndefined();
    expect(detail.body.member.events).toBeUndefined();
    const adminDetail = await call(admin, "GET", `/${member.userId.toUpperCase()}`);
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.member.events).toEqual([]);

    for (const [method, path] of [["GET", ""], ["GET", `/${admin.userId}`], ["PUT", `/${member.userId}/role`], ["POST", `/${member.userId}/block`], ["POST", `/${member.userId}/unblock`], ["POST", `/${member.userId}/sessions/revoke`]] as const) {
      expect((await call(guest, method, path, { role: "admin", expectedRole: "member" })).status).toBe(404);
    }
    expect((await call(admin, "GET", "/not-a-uuid")).status).toBe(404);
    expect((await call(admin, "GET", `/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call(undefined, "GET", "")).status).toBe(401);
  });

  test("members and viewers get 403 on every write", async () => {
    const member = await user("Write member");
    const viewer = await user("Write viewer", "viewer");
    const target = await user("Write target");
    for (const actor of [member, viewer]) {
      expect((await call(actor, "PUT", `/${target.userId}/role`, { role: "admin", expectedRole: "member" })).body.code).toBe("ADMIN_ONLY");
      expect((await call(actor, "POST", `/${target.userId}/block`, {})).status).toBe(403);
      expect((await call(actor, "POST", `/${target.userId}/unblock`, {})).status).toBe(403);
      expect((await call(actor, "POST", `/${target.userId}/sessions/revoke`, {})).status).toBe(403);
    }
    expect(roleOf(target)).toBe("member");
    expect(roleOf(member)).toBe("member");
    expect(eventsFor(target)).toEqual([]);
  });

  test("/api/auth/me carries the role, and register ignores a supplied role", async () => {
    const admin = await user("Me admin", "admin");
    expect((await (await me(admin)).json() as { user: { role: string } }).user.role).toBe("admin");
    // Not sent over HTTP: registration is rate limited across the whole test run.
    const { loginSchema, registerSchema } = await import("../server/validation");
    expect(registerSchema.safeParse({ email: "escalate@example.test", displayName: "Escalate", password: "correct horse battery staple", role: "admin" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "escalate@example.test", password: "x", role: "admin" }).success).toBe(false);
  });
});

describe("Team API: roles", () => {
  test("promoting needs only the admin session and CSRF, runs a CAS, and records one event and one audit row", async () => {
    const admin = await user("Role admin", "admin");
    const target = await user("Role target");

    // Operator decision 2026-09-27: no password re-check. The body stays strict, so a password field is refused.
    const withPassword = await call(admin, "PUT", `/${target.userId}/role`, { role: "admin", expectedRole: "member", password: admin.password });
    expect(withPassword.status).toBe(400);
    expect(roleOf(target)).toBe("member");

    const stale = await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "admin" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "ROLE_CHANGED", currentRole: "member" });

    const promoted = await call(admin, "PUT", `/${target.userId}/role`, { role: "admin", expectedRole: "member" });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ changed: true, role: "admin", member: { role: "admin" } });
    expect(eventsFor(target)).toEqual([{ action: "role_change", via: "web", actor_id: admin.userId, from_role: "member", to_role: "admin", reason: null }]);
    const auditRow = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'team.role_changed' AND metadata_json LIKE ?").get(`%${target.userId}%`) as { actor_id: string; metadata_json: string };
    expect(auditRow.actor_id).toBe(admin.userId);
    expect(JSON.parse(auditRow.metadata_json)).toEqual({ targetId: target.userId, fromRole: "member", toRole: "admin", via: "web" });
    expect(auditRow.metadata_json).not.toContain("@");

    // The role applies on the target's next request.
    expect((await (await me(target)).json() as { user: { role: string } }).user.role).toBe("admin");

    // Demoting an admin needs only the session too.
    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "admin" })).status).toBe(200);
    expect(roleOf(target)).toBe("member");
    // A no-op keeps the log unchanged.
    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "member" })).body).toMatchObject({ changed: false });
    expect(eventsFor(target)).toHaveLength(2);
  });

  test("viewer and guest can be assigned (Wave 15), and strict bodies reject extra fields", async () => {
    const admin = await user("Enable admin", "admin");
    const target = await user("Enable target");
    let expectedRole = "member";
    for (const role of ["viewer", "guest", "member"]) {
      const changed = await call(admin, "PUT", `/${target.userId}/role`, { role, expectedRole });
      expect(changed).toMatchObject({ status: 200, body: { changed: true, role, member: { role } } });
      expect(roleOf(target)).toBe(role);
      expectedRole = role;
    }
    expect(eventsFor(target).map((event) => [event.from_role, event.to_role])).toEqual([["member", "viewer"], ["viewer", "guest"], ["guest", "member"]]);
    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "owner", expectedRole: "member" })).status).toBe(400);
    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "member", email: "x@example.test" })).status).toBe(400);
    expect(roleOf(target)).toBe("member");
  });

  test("the last active admin cannot step down; with a second admin one may demote themselves", async () => {
    const admin = await user("Last admin", "admin");
    await asOnlyAdmin(admin, async () => {
      const refused = await call(admin, "PUT", `/${admin.userId}/role`, { role: "member", expectedRole: "admin" });
      expect(refused).toMatchObject({ status: 409, body: { code: "LAST_ADMIN" } });
      expect(roleOf(admin)).toBe("admin");
      // The trigger refuses direct SQL too.
      expect(() => db.query("UPDATE users SET role = 'member' WHERE id = ?").run(admin.userId)).toThrow("LAST_ADMIN");
      expect(() => db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), admin.userId)).toThrow("LAST_ADMIN");

      const second = await user("Second admin", "admin");
      const selfDemote = await call(admin, "PUT", `/${admin.userId}/role`, { role: "member", expectedRole: "admin" });
      expect(selfDemote.status).toBe(200);
      expect(roleOf(admin)).toBe("member");
      // The demoted admin lost Team management at once.
      expect((await call(admin, "POST", `/${second.userId}/sessions/revoke`, {})).status).toBe(403);
      setRoleSql(admin, "admin");
      setRoleSql(second, "member");
    });
  });

  test("an admin with two-factor on manages roles and blocks with only the session and CSRF", async () => {
    const admin = await user("TOTP admin", "admin");
    const target = await user("TOTP target");
    const setup = await (await request("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: admin.password }) }, admin)).json() as { secret: string };
    const enable = await request("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: totpCodeAt(setup.secret, totpCounter() - 1) }) }, admin);
    expect(enable.status).toBe(200);

    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "admin", expectedRole: "member" })).status).toBe(200);
    expect((await call(admin, "POST", `/${target.userId}/block`, {})).status).toBe(200);
    expect((await call(admin, "POST", `/${target.userId}/unblock`, {})).status).toBe(200);
    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "admin" })).status).toBe(200);
    expect(roleOf(target)).toBe("member");
    // No password or code is ever asked for, so nothing can fail re-authentication.
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'team.reauth_failed'").get() as { count: number }).count).toBe(0);
    // Without a session the routes still refuse.
    const anonymous = await request(`/team/${target.userId}/role`, { method: "PUT", body: JSON.stringify({ role: "admin", expectedRole: "member" }) });
    expect(anonymous.status).toBe(401);
  });
});

describe("Team API: blocking", () => {
  test("a block signs the user out everywhere, pauses keys, removes push, and explains itself only after the right password", async () => {
    const admin = await user("Block admin", "admin");
    const target = await user("Block target");
    const key = createMcpApiKey(target.userId, "Target key", ["notes:read"]);
    expect((await rpc(key.token, "tools/list")).status).toBe(200);
    db.query("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, 'p', 'a', 'Phone', ?)")
      .run(crypto.randomUUID(), target.userId, `https://push.example.test/${crypto.randomUUID()}`, new Date().toISOString());
    const secondSession = await login(target);
    expect(secondSession.status).toBe(200);
    expect(sessionCount(target)).toBe(2);

    expect((await call(admin, "POST", `/${admin.userId}/block`, {})).body.code).toBe("SELF_ACTION");
    const blocked = await call(admin, "POST", `/${target.userId}/block`, { reason: "  Left the team  " });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ sessionsRevoked: 2, mcpKeysPaused: 1, member: { status: "blocked", blockReason: "Left the team", blockedBy: { id: admin.userId } } });
    expect(sessionCount(target)).toBe(0);
    expect((await me(target)).status).toBe(401);
    expect((db.query("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?").get(target.userId) as { count: number }).count).toBe(0);
    expect((await rpc(key.token, "tools/list")).status).toBe(401);
    expect((await call(admin, "POST", `/${target.userId}/block`, {})).body.code).toBe("ALREADY_BLOCKED");

    const rightPassword = await login(target);
    expect(rightPassword.status).toBe(403);
    const refused = await rightPassword.json() as { code: string; error: string };
    expect(refused.code).toBe("ACCOUNT_BLOCKED");
    expect(refused.error).not.toContain("Left the team");
    const wrongPassword = await login(target, "not the password at all");
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "Invalid email or password" });

    // Blocked accounts leave the share pickers.
    const picker = await (await request("/users", {}, admin)).json() as { users: Array<{ id: string }> };
    expect(picker.users.some((row) => row.id === target.userId)).toBe(false);

    // One event and one audit row; the audit row carries no reason text.
    expect(eventsFor(target)).toEqual([{ action: "block", via: "web", actor_id: admin.userId, from_role: null, to_role: null, reason: "Left the team" }]);
    const auditRow = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'team.user_blocked' AND metadata_json LIKE ?").get(`%${target.userId}%`) as { metadata_json: string };
    expect(auditRow.metadata_json).not.toContain("Left");

    // Unblock: old sessions stay dead, sign-in works, the key resumes, the role is unchanged.
    const unblocked = await call(admin, "POST", `/${target.userId}/unblock`, {});
    expect(unblocked.body.member).toMatchObject({ status: "active", blockReason: null, blockedBy: null, role: "member" });
    expect((await call(admin, "POST", `/${target.userId}/unblock`, {})).body.code).toBe("NOT_BLOCKED");
    expect((await me(target)).status).toBe(401);
    expect((await login(target)).status).toBe(200);
    expect((await rpc(key.token, "tools/list")).status).toBe(200);
    expect(eventsFor(target).map((event) => event.action)).toEqual(["block", "unblock"]);
  });

  test("blocking an admin needs only the session and never removes the last active admin", async () => {
    const admin = await user("Block-admin actor", "admin");
    const other = await user("Block-admin target", "admin");
    expect((await call(admin, "POST", `/${other.userId}/block`, { password: admin.password })).status).toBe(400);
    expect((await call(admin, "POST", `/${other.userId}/block`, {})).status).toBe(200);
    expect((await call(admin, "POST", `/${other.userId}/unblock`, {})).status).toBe(200);
    setRoleSql(other, "member");
  });

  test("sign out everywhere deletes sessions without blocking", async () => {
    const admin = await user("Revoke admin", "admin");
    const target = await user("Revoke target");
    expect((await call(admin, "POST", `/${admin.userId}/sessions/revoke`, {})).body.code).toBe("SELF_ACTION");
    const revoked = await call(admin, "POST", `/${target.userId}/sessions/revoke`, {});
    expect(revoked.body).toMatchObject({ sessionsRevoked: 1, member: { status: "active" } });
    expect((await me(target)).status).toBe(401);
    expect((await login(target)).status).toBe(200);
    expect(eventsFor(target).map((event) => event.action)).toEqual(["sessions_revoked"]);
  });

  test("team writes need CSRF, the app Origin, and JSON", async () => {
    const admin = await user("CSRF admin", "admin");
    const target = await user("CSRF target");
    expect((await call(admin, "POST", `/${target.userId}/block`, {}, { "X-CSRF-Token": "wrong" })).status).toBe(403);
    expect((await call(admin, "POST", `/${target.userId}/block`, {}, { Origin: "https://evil.example.test" })).status).toBe(403);
    expect((await call(admin, "POST", `/${target.userId}/block`, "reason=x", { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect(roleOf(target)).toBe("member");
    expect(sessionCount(target)).toBe(1);
  });

  test("an upload that started before a block cannot commit after it", async () => {
    const admin = await user("Upload admin", "admin");
    const target = await user("Upload target");
    const encoder = new TextEncoder();
    const boundary = "----nook-team-race";
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="race.txt"\r\nContent-Type: text/plain\r\n\r\n${"a".repeat(2000)}`);
    const tail = encoder.encode(`${"b".repeat(2000)}\r\n--${boundary}--\r\n`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(head);
        await gate;
        controller.enqueue(tail);
        controller.close();
      }
    });
    const pending = fetch(`${origin}/api/files`, {
      method: "POST",
      headers: { Cookie: target.cookie, Origin: origin, "X-CSRF-Token": target.csrf, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(head.length + tail.length) },
      body,
      duplex: "half"
    } as RequestInit);
    const staged = () => readdirSync(join(dataDir, "documents", ".staging")).filter((name) => name.endsWith(".part")).length;
    for (let wait = 0; wait < 40 && staged() === 0; wait += 1) await Bun.sleep(25);
    // The upload passed requireAuth and is streaming into staging when the block lands.
    expect(staged()).toBe(1);
    expect((await call(admin, "POST", `/${target.userId}/block`, {})).status).toBe(200);
    release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect((db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(target.userId) as { count: number }).count).toBe(0);
    expect(staged()).toBe(0);
    expect(readdirSync(join(dataDir, "documents", "objects"), { recursive: true }).some((name) => String(name).includes(target.userId))).toBe(false);
    expect((await call(admin, "POST", `/${target.userId}/unblock`, {})).status).toBe(200);
  });

  test("the reminders dispatcher skips blocked accounts until they are unblocked", async () => {
    const admin = await user("Reminder admin", "admin");
    const target = await user("Reminder target");
    const created = await request("/reminders", { method: "POST", body: JSON.stringify({ tz: "UTC", title: "Call", fireAt: `${Y}-05-01T09:00` }) }, target);
    expect(created.status).toBe(201);
    const { reminder } = await created.json() as { reminder: { id: string } };
    expect((await call(admin, "POST", `/${target.userId}/block`, {})).status).toBe(200);
    resetReminderDeferrals();
    runDispatch({ nowMs: Date.parse(`${Y}-05-01T09:01:00Z`) });
    const notifications = (userId: string) => (db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?").get(userId) as { count: number }).count;
    expect(notifications(target.userId)).toBe(0);
    expect((db.query("SELECT claimed_at, next_fire_at FROM reminders WHERE id = ?").get(reminder.id) as { claimed_at: string | null; next_fire_at: string | null }).next_fire_at).not.toBeNull();
    expect((await call(admin, "POST", `/${target.userId}/unblock`, {})).status).toBe(200);
    runDispatch({ nowMs: Date.parse(`${Y}-05-01T09:01:30Z`) });
    expect(notifications(target.userId)).toBe(1);
  });
});

describe("Team rate limit", () => {
  test("an admin gets 30 team writes a minute", async () => {
    const admin = await user("Limit admin", "admin");
    const target = await user("Limit target");
    for (let index = 0; index < 30; index += 1) {
      expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "member" })).status).toBe(200);
    }
    expect((await call(admin, "PUT", `/${target.userId}/role`, { role: "member", expectedRole: "member" })).status).toBe(429);
  });
});
