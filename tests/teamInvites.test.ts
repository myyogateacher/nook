import { beforeEach, describe, expect, test } from "bun:test";
import { allowedTestEmails, createUser, db, origin, request, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { resetInviteRateLimits, sweepInvites, inviteStatus, maskEmail, hashInviteToken } = await import("../server/team/invites");
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
let spareEmail = allowedTestEmails.length;
const freshEmail = () => allowedTestEmails[--spareEmail]!;

function registerWith(body: Record<string, unknown>) {
  resetRegistrationRateLimit();
  return call(undefined, "POST", "/auth/register", { displayName: "Invitee", password: "correct horse battery staple", ...body });
}

const inviteRow = (id: string) => db.query("SELECT * FROM team_invites WHERE id = ?").get(id) as Record<string, any>;
const auditRows = (type: string) => db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = ? ORDER BY created_at").all(type) as Array<{ actor_id: string | null; metadata_json: string }>;

describe("Team invites: create, list, revoke", () => {
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
