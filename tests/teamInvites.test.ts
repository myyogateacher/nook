import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, spareEmail, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { resetInviteRateLimits, listInvites, sweepInvites, inviteStatus, maskEmail, hashInviteToken } = await import("../server/team/invites");
const { resetRegistrationRateLimit } = await import("../server/index");

/**
 * Team invites (docs/plan/WAVES_18-20_SMALL.md §1, T136–T141). The shared harness runs with
 * ALLOW_REGISTRATION=true; the closed-registration and empty-instance cases run in
 * tests/support/teamInvitesProbe.ts (see teamInvitesProbe.test.ts).
 */

type Role = "admin" | "member" | "viewer" | "guest";

beforeEach(() => {
  resetTeamRateLimits();
  resetInviteRateLimits();
  resetRegistrationRateLimit();
  db.query("DELETE FROM team_invites").run();
});

async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

const createInvite = (admin: Session, body: Record<string, unknown> = { role: "viewer" }) => call(admin, "POST", "/team/invites", body);

/** Emails from the end of the harness allowlist, which createUser() (from the start) never reaches. */
const freshEmail = spareEmail;

function registerWith(body: Record<string, unknown>) {
  resetRegistrationRateLimit();
  return call(undefined, "POST", "/auth/register", { displayName: "Invitee", password: "correct horse battery staple", ...body });
}

const inviteRow = (id: string) => db.query("SELECT * FROM team_invites WHERE id = ?").get(id) as Record<string, any>;
const auditRows = (type: string) => db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = ? ORDER BY created_at").all(type) as Array<{ actor_id: string | null; metadata_json: string }>;

describe("Team invites: create, list, revoke", () => {
  test("invites made in the same millisecond list newest first, live and dead merged, whatever their random ids", async () => {
    const admin = await user("Invite tie admin", "admin");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    // Each newer invite gets a larger id than the one before it, so an ascending-id tie-break lists them oldest first.
    const ids = ["00000000-0000-4000-8000-000000000000", "88888888-0000-4000-8000-000000000000", "cccccccc-0000-4000-8000-000000000000", "ffffffff-0000-4000-8000-000000000000"];
    const insert = db.query(`INSERT INTO team_invites (id, token_hash, token_prefix, role, created_by, created_at, expires_at, revoked_at)
      VALUES (?, ?, 'tietie', 'viewer', ?, ?, ?, ?)`);
    ids.forEach((id, index) => insert.run(id, String(index).repeat(64), admin.userId, createdAt, expiresAt, index % 2 ? createdAt : null));
    const listed = await call(admin, "GET", "/team/invites");
    expect(listed.body.invites.map((item: { id: string; status: string }) => [item.id, item.status])).toEqual([
      [ids[3], "revoked"], [ids[2], "live"], [ids[1], "revoked"], [ids[0], "live"]
    ]);
    // The MCP list_invites path asks for live invites only.
    expect(listInvites({ id: admin.userId, role: "admin" }, { status: "live" }).invites.map((item) => item.id)).toEqual([ids[2], ids[0]]);
  });

  test("an admin creates an invite; the token is returned once and only its hash is stored", async () => {
    const admin = await user("Invite admin", "admin");
    const created = await createInvite(admin, { role: "viewer", note: "Design contractor", expiresInDays: 3 });
    expect(created.status).toBe(201);
    const { invite, token, url } = created.body;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The link carries the token in the fragment, never in the query (Director ruling).
    expect(url).toBe(`${origin}/register#invite=${token}`);
    expect(invite).toMatchObject({ role: "viewer", status: "live", note: "Design contractor", email: null, tokenPrefix: token.slice(0, 6), createdBy: { id: admin.userId, displayName: "Invite admin" }, usedBy: null });
    expect(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)).toBe(3 * 86_400_000);
    const row = inviteRow(invite.id);
    expect(row.token_hash).toBe(hashInviteToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const listed = await call(admin, "GET", "/team/invites");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ liveCount: 1, liveLimit: 20 });
    expect(listed.body.invites.map((item: { id: string }) => item.id)).toEqual([invite.id]);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(JSON.stringify(listed.body)).not.toContain(row.token_hash);

    // The default expiry is 7 days.
    const defaults = await createInvite(admin, { role: "guest" });
    expect(Date.parse(defaults.body.invite.expiresAt) - Date.parse(defaults.body.invite.createdAt)).toBe(7 * 86_400_000);
  });

  test("members and viewers get 403 ADMIN_ONLY, guests 404, anonymous 401", async () => {
    const admin = await user("Gate admin", "admin");
    const { invite } = (await createInvite(admin)).body;
    for (const role of ["member", "viewer"] as const) {
      const session = await user(`Invite ${role}`, role);
      expect((await call(session, "GET", "/team/invites")).body.code).toBe("ADMIN_ONLY");
      expect((await createInvite(session)).body.code).toBe("ADMIN_ONLY");
      expect((await call(session, "POST", `/team/invites/${invite.id}/revoke`, {})).body.code).toBe("ADMIN_ONLY");
    }
    const guest = await user("Invite guest", "guest");
    expect((await call(guest, "GET", "/team/invites")).status).toBe(404);
    expect((await createInvite(guest)).status).toBe(404);
    expect((await call(guest, "POST", `/team/invites/${invite.id}/revoke`, {})).status).toBe(404);
    expect((await call(undefined, "GET", "/team/invites")).status).toBe(401);
    expect(inviteRow(invite.id).revoked_at).toBeNull();
  });

  test("the role can never be admin, and the body is strict and bounded", async () => {
    const admin = await user("Strict admin", "admin");
    for (const body of [
      { role: "admin" },
      { role: "owner" },
      { role: "viewer", expiresInDays: 8 },
      { role: "viewer", expiresInDays: 0 },
      { role: "viewer", expiresInDays: 1.5 },
      { role: "viewer", note: "x".repeat(81) },
      { role: "viewer", email: "not-an-email" },
      { role: "viewer", token: "chosen" }
    ]) expect({ body, status: (await createInvite(admin, body)).status }).toEqual({ body, status: 400 });
    expect(db.query("SELECT COUNT(*) AS count FROM team_invites").get()).toEqual({ count: 0 });
  });

  test("a bound email must be allowed and unregistered", async () => {
    const admin = await user("Email admin", "admin");
    const outside = await createInvite(admin, { role: "viewer", email: "outsider@example.test" });
    expect(outside).toMatchObject({ status: 400, body: { code: "EMAIL_NOT_ALLOWED" } });
    const taken = await createInvite(admin, { role: "viewer", email: admin.email.toUpperCase() });
    expect(taken).toMatchObject({ status: 409, body: { code: "ACCOUNT_EXISTS" } });
    const email = freshEmail();
    const bound = await createInvite(admin, { role: "member", email: email.toUpperCase() });
    expect(bound.status).toBe(201);
    expect(bound.body.invite.email).toBe(email);
  });

  test("at most 10 creations an hour per admin, and 20 live invites per instance", async () => {
    const first = await user("Limit admin 1", "admin");
    const second = await user("Limit admin 2", "admin");
    const third = await user("Limit admin 3", "admin");
    for (let index = 0; index < 10; index += 1) expect((await createInvite(first)).status).toBe(201);
    expect(await createInvite(first)).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    for (let index = 0; index < 10; index += 1) expect((await createInvite(second)).status).toBe(201);
    expect(await createInvite(third)).toMatchObject({ status: 409, body: { code: "INVITE_LIMIT" } });
    const listed = await call(third, "GET", "/team/invites");
    expect(listed.body.liveCount).toBe(20);
    // A revoked invite frees a slot; dead invites do not count.
    expect((await call(third, "POST", `/team/invites/${listed.body.invites[0].id}/revoke`, {})).status).toBe(200);
    expect((await createInvite(third)).status).toBe(201);
  });

  test("revoking: live becomes revoked (repeatable); used or expired answer 409 INVITE_NOT_LIVE", async () => {
    const admin = await user("Revoke admin", "admin");
    const other = await user("Revoke admin 2", "admin");
    const live = (await createInvite(admin)).body.invite;
    const revoked = await call(other, "POST", `/team/invites/${live.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.invite).toMatchObject({ id: live.id, status: "revoked" });
    expect(inviteRow(live.id).revoked_by).toBe(other.userId);
    expect((await call(admin, "POST", `/team/invites/${live.id}/revoke`, {})).body.invite.status).toBe("revoked");
    expect(auditRows("team.invite_revoke").filter((row) => row.metadata_json.includes(live.id))).toHaveLength(1);

    const used = (await createInvite(admin)).body.invite;
    db.query("UPDATE team_invites SET used_at = ?, used_by = ? WHERE id = ?").run(new Date().toISOString(), other.userId, used.id);
    expect(await call(admin, "POST", `/team/invites/${used.id}/revoke`, {})).toMatchObject({ status: 409, body: { code: "INVITE_NOT_LIVE" } });
    const stale = (await createInvite(admin)).body.invite;
    db.query("UPDATE team_invites SET created_at = ?, expires_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", stale.id);
    expect(await call(admin, "POST", `/team/invites/${stale.id}/revoke`, {})).toMatchObject({ status: 409, body: { code: "INVITE_NOT_LIVE" } });
    expect((await call(admin, "POST", `/team/invites/${crypto.randomUUID()}/revoke`, {})).status).toBe(404);
    expect((await call(admin, "POST", "/team/invites/not-a-uuid/revoke", {})).status).toBe(404);

    const statuses = Object.fromEntries((await call(admin, "GET", "/team/invites")).body.invites.map((item: { id: string; status: string }) => [item.id, item.status]));
    expect(statuses).toEqual({ [live.id]: "revoked", [used.id]: "used", [stale.id]: "expired" });
  });

  test("inviteStatus and maskEmail", () => {
    const at = "2026-09-28T12:00:00.000Z";
    expect(inviteStatus({ used_at: null, revoked_at: null, expires_at: "2026-09-29T00:00:00.000Z" }, at)).toBe("live");
    expect(inviteStatus({ used_at: null, revoked_at: null, expires_at: at }, at)).toBe("expired");
    expect(inviteStatus({ used_at: at, revoked_at: null, expires_at: "2026-09-29T00:00:00.000Z" }, at)).toBe("used");
    expect(inviteStatus({ used_at: null, revoked_at: at, expires_at: "2026-09-29T00:00:00.000Z" }, at)).toBe("revoked");
    expect(maskEmail("pankaj@example.com")).toBe("p•••@example.com");
    expect(maskEmail("x")).toBe("•••");
  });

  test("the sweeper deletes invites dead for more than 90 days and keeps live ones", async () => {
    const admin = await user("Sweep admin", "admin");
    const live = (await createInvite(admin)).body.invite;
    const oldUsed = (await createInvite(admin)).body.invite;
    const recentRevoked = (await createInvite(admin)).body.invite;
    const oldExpired = (await createInvite(admin)).body.invite;
    const old = new Date(Date.now() - 91 * 86_400_000);
    db.query("UPDATE team_invites SET created_at = ?, expires_at = ?, used_at = ?, used_by = ? WHERE id = ?")
      .run(new Date(old.getTime() - 86_400_000).toISOString(), new Date(old.getTime() + 86_400_000).toISOString(), old.toISOString(), admin.userId, oldUsed.id);
    db.query("UPDATE team_invites SET revoked_at = ? WHERE id = ?").run(new Date(Date.now() - 89 * 86_400_000).toISOString(), recentRevoked.id);
    db.query("UPDATE team_invites SET created_at = ?, expires_at = ? WHERE id = ?").run(new Date(old.getTime() - 86_400_000).toISOString(), old.toISOString(), oldExpired.id);
    expect(sweepInvites()).toBe(2);
    const left = (db.query("SELECT id FROM team_invites ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id).sort();
    expect(left).toEqual([live.id, recentRevoked.id].sort());
  });
});

describe("Team invites: preview and register (registration open)", () => {
  test("preview takes the token in the body and masks a bound email", async () => {
    const admin = await user("Preview admin", "admin");
    const email = freshEmail();
    const { token, invite } = (await createInvite(admin, { role: "viewer", email })).body;
    const preview = await call(undefined, "POST", "/auth/invite", { token });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ role: "viewer", emailHint: `a•••${email.slice(email.indexOf("@"))}`, expiresAt: invite.expiresAt, inviterName: "Preview admin" });
    expect((await call(undefined, "POST", "/auth/invite", { token: "x".repeat(43) })).body.code).toBe("INVITE_INVALID");
    expect((await call(undefined, "POST", "/auth/invite", { token: "short" })).status).toBe(400);
    expect((await call(undefined, "POST", "/auth/invite", { token, extra: 1 })).status).toBe(400);
    // Not a GET route, with or without a query (the token must never sit in a URL).
    const byQuery = await request(`/auth/invite?token=${token}`, {}, admin);
    expect(byQuery.status).toBe(404);
    // Pre-auth checks: Origin and JSON.
    expect((await request("/auth/invite", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ token }) })).status).toBe(403);
    expect((await request("/auth/invite", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ token }) })).status).toBe(415);
  });

  test("preview is limited to 60 a minute server-wide", async () => {
    resetRegistrationRateLimit();
    for (let index = 0; index < 60; index += 1) expect((await call(undefined, "POST", "/auth/invite", { token: "y".repeat(43) })).status).toBe(404);
    expect((await call(undefined, "POST", "/auth/invite", { token: "y".repeat(43) })).status).toBe(429);
    resetRegistrationRateLimit();
  });

  test("a valid invite fixes the role, is single use, and writes one accept audit row", async () => {
    const admin = await user("Accept admin", "admin");
    const { token, invite } = (await createInvite(admin, { role: "viewer" })).body;
    const email = freshEmail();
    const registered = await registerWith({ email, inviteToken: token });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe("viewer");
    const row = inviteRow(invite.id);
    expect(row.used_by).toBe(registered.body.user.id);
    expect(row.used_at).toBeTruthy();
    const accepts = auditRows("team.invite_accept").filter((item) => item.metadata_json.includes(invite.id));
    expect(accepts).toEqual([{ actor_id: registered.body.user.id, metadata_json: JSON.stringify({ inviteId: invite.id, role: "viewer" }) }]);

    const again = await registerWith({ email: freshEmail(), inviteToken: token });
    expect(again).toMatchObject({ status: 404, body: { code: "INVITE_INVALID" } });
    expect((await call(undefined, "POST", "/auth/invite", { token })).status).toBe(404);

    // Admin detail shows how the account joined (D165), and the list shows who used it.
    const detail = await call(admin, "GET", `/team/${registered.body.user.id}`);
    expect(detail.body.member.joinedWithInvite).toMatchObject({ role: "viewer", invitedBy: { id: admin.userId, displayName: "Accept admin" } });
    expect((await call(admin, "GET", "/team/invites")).body.invites[0]).toMatchObject({ status: "used", usedBy: { id: registered.body.user.id, displayName: "Invitee" } });
  });

  test("an invalid, expired, revoked, or orphaned invite is refused, never silently ignored", async () => {
    const admin = await user("Refuse admin", "admin");
    const fresh = () => freshEmail();
    const users = () => (db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    const before = users();

    expect(await registerWith({ email: fresh(), inviteToken: "z".repeat(43) })).toMatchObject({ status: 404, body: { code: "INVITE_INVALID" } });
    expect((await registerWith({ email: fresh(), inviteToken: "bad" })).status).toBe(400);

    const expiredInvite = (await createInvite(admin)).body;
    db.query("UPDATE team_invites SET created_at = ?, expires_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", expiredInvite.invite.id);
    expect(await registerWith({ email: fresh(), inviteToken: expiredInvite.token })).toMatchObject({ status: 410, body: { code: "INVITE_EXPIRED" } });
    expect((await call(undefined, "POST", "/auth/invite", { token: expiredInvite.token })).body.code).toBe("INVITE_EXPIRED");

    const revokedInvite = (await createInvite(admin)).body;
    await call(admin, "POST", `/team/invites/${revokedInvite.invite.id}/revoke`, {});
    expect(await registerWith({ email: fresh(), inviteToken: revokedInvite.token })).toMatchObject({ status: 404, body: { code: "INVITE_INVALID" } });

    // The creator is demoted, then blocked: the link dies with the privilege (D162).
    const creator = await user("Former admin", "admin");
    const demoted = (await createInvite(creator)).body;
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(creator.userId);
    expect((await registerWith({ email: fresh(), inviteToken: demoted.token })).body.code).toBe("INVITE_INVALID");
    db.query("UPDATE users SET role = 'admin', disabled_at = ? WHERE id = ?").run(new Date().toISOString(), creator.userId);
    expect((await registerWith({ email: fresh(), inviteToken: demoted.token })).body.code).toBe("INVITE_INVALID");
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(creator.userId);
    // Restored, the same link works again (it was never claimed).
    expect((await registerWith({ email: fresh(), inviteToken: demoted.token })).status).toBe(201);
    // The former admin, and the one account the restored link created.
    expect(users()).toBe(before + 2);
  });

  test("the allowlist, a bound email, and a strict body still apply", async () => {
    const admin = await user("Bound admin", "admin");
    const email = freshEmail();
    const { token } = (await createInvite(admin, { role: "guest", email })).body;
    expect(await registerWith({ email: freshEmail(), inviteToken: token })).toMatchObject({ status: 403, body: { code: "INVITE_EMAIL_MISMATCH" } });
    expect((await registerWith({ email: "outsider@example.test", inviteToken: token })).status).toBe(403);
    expect((await registerWith({ email, inviteToken: token, role: "admin" })).status).toBe(400);
    // A made-up token answers INVITE_INVALID even for an existing account (no email probing).
    expect((await registerWith({ email: admin.email, inviteToken: "q".repeat(43) })).body.code).toBe("INVITE_INVALID");
    const registered = await registerWith({ email: email.toUpperCase(), inviteToken: token });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe("guest");
  });

  test("two concurrent claims of one invite create exactly one account", async () => {
    const admin = await user("Race admin", "admin");
    const { token, invite } = (await createInvite(admin, { role: "member" })).body;
    const emails = [freshEmail(), freshEmail()];
    resetRegistrationRateLimit();
    const results = await Promise.all(emails.map((email) => call(undefined, "POST", "/auth/register", { email, displayName: "Racer", password: "correct horse battery staple", inviteToken: token })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 404]);
    const created = db.query("SELECT COUNT(*) AS count FROM users WHERE email IN (?, ?)").get(emails[0]!, emails[1]!) as { count: number };
    expect(created.count).toBe(1);
    expect(inviteRow(invite.id).used_by).toBe(results.find((result) => result.status === 201)!.body.user.id);
  });

  test("audit rows never carry a token, hash, or email; team_events is unchanged", async () => {
    const admin = await user("Audit admin", "admin");
    const email = freshEmail();
    const eventsBefore = (db.query("SELECT COUNT(*) AS count FROM team_events").get() as { count: number }).count;
    const { token, invite } = (await createInvite(admin, { role: "viewer", email })).body;
    await registerWith({ email, inviteToken: token });
    const other = (await createInvite(admin)).body;
    await call(admin, "POST", `/team/invites/${other.invite.id}/revoke`, {});
    const rows = db.query("SELECT event_type, metadata_json FROM audit_log WHERE event_type LIKE 'team.invite_%'").all() as Array<{ event_type: string; metadata_json: string }>;
    expect(new Set(rows.map((row) => row.event_type))).toEqual(new Set(["team.invite_create", "team.invite_accept", "team.invite_revoke"]));
    const all = JSON.stringify(db.query("SELECT metadata_json FROM audit_log").all());
    for (const secret of [token, other.token, hashInviteToken(token), inviteRow(invite.id).token_hash, email]) expect(all).not.toContain(secret);
    for (const row of rows) expect(Object.keys(JSON.parse(row.metadata_json)).sort()).toEqual(["inviteId", "role"]);
    expect((db.query("SELECT COUNT(*) AS count FROM team_events").get() as { count: number }).count).toBe(eventsBefore);
  });
});
