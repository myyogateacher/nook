import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, register, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { createUnsubscribeToken, bumpUnsubscribeEpoch } = await import("../server/mail/unsubscribe");
const { resetMailRouteLimits } = await import("../server/mail/routes");
const { readEmailPrefs } = await import("../server/mail/prefs");

/**
 * Email verification (D244, T231), preferences (B.1, CAS), one-click unsubscribe (B.2, T221), the
 * test email, and the admin Email log (D.4).
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  resetMailRouteLimits();
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
});
afterEach(() => mail.setMailTransportForTests(null));

async function call(session: Session | null, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session ?? undefined);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}
const tokenFrom = (message: Sent) => /#token=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
const verified = (userId: string) => (db.query("SELECT email_verified_at FROM users WHERE id = ?").get(userId) as { email_verified_at: string | null }).email_verified_at !== null;

describe("email verification", () => {
  test("registering queues a verify mail; the fragment token verifies once, without a session", async () => {
    const session = await register("Verify register");
    expect(verified(session.userId)).toBe(false);
    await runMailDispatch();
    const message = sent.find((item) => item.to === session.email)!;
    expect(message.subject).toBe("Verify your email for Nook");
    const token = tokenFrom(message);
    expect(message.html).toContain(`/verify-email#token=${token}`);
    expect((await call(null, "POST", "/mail/verify", { token: "x".repeat(43) })).body).toMatchObject({ code: "TOKEN_INVALID", emailEnabled: true });
    expect(await call(null, "POST", "/mail/verify", { token })).toEqual({ status: 200, body: { ok: true } });
    expect(verified(session.userId)).toBe(true);
    // Single use.
    expect((await call(null, "POST", "/mail/verify", { token })).status).toBe(400);
    // Wrong origin is refused like the other pre-auth routes.
    const foreign = await request("/mail/verify", { method: "POST", body: JSON.stringify({ token }), headers: { Origin: "https://evil.example.com" } });
    expect(foreign.status).toBe(403);
  });

  test("an expired token says so; a token for an old address no longer works (T231)", async () => {
    const session = await createUser("Verify expiry");
    expect((await call(session, "POST", "/mail/verify/send")).body).toEqual({ queued: true });
    await runMailDispatch();
    const token = tokenFrom(sent.at(-1)!);
    db.query("UPDATE auth_tokens SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - 1000).toISOString(), session.userId);
    expect((await call(null, "POST", "/mail/verify", { token })).body.code).toBe("TOKEN_EXPIRED");
    await call(session, "POST", "/mail/verify/send");
    await runMailDispatch();
    const second = tokenFrom(sent.at(-1)!);
    db.query("UPDATE users SET email = ? WHERE id = ?").run(`changed-${crypto.randomUUID()}@example.test`, session.userId);
    expect((await call(null, "POST", "/mail/verify", { token: second })).body.code).toBe("TOKEN_INVALID");
    expect(verified(session.userId)).toBe(false);
  });

  test("send is limited to 3 an hour and refused once verified; the test email needs a verified address", async () => {
    const session = await createUser("Verify limits");
    expect((await call(session, "POST", "/mail/test")).body.code).toBe("UNVERIFIED");
    for (let index = 0; index < 3; index += 1) expect((await call(session, "POST", "/mail/verify/send")).status).toBe(200);
    expect((await call(session, "POST", "/mail/verify/send")).status).toBe(429);
    db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
    expect((await call(session, "POST", "/mail/verify/send")).body.code).toBe("ALREADY_VERIFIED");
    expect((await call(session, "POST", "/mail/test")).status).toBe(200);
    await runMailDispatch();
    expect(sent.filter((item) => item.to === session.email).at(-1)!.subject).toBe("Test email from Nook");
    mail.setMailTransportForTests(null);
    expect((await call(session, "POST", "/mail/test")).body.code).toBe("NOT_CONFIGURED");
  });
});

describe("preferences", () => {
  test("defaults, save with CAS, and 409 on a stale revision; digest cadence is off, daily, or weekly", async () => {
    const session = await createUser("Prefs user");
    const initial = await call(session, "GET", "/mail/settings");
    expect(initial.body).toMatchObject({ configured: true, address: session.email, verified: false, suppressed: false, prefs: { enabled: true, revision: 0, digest: "off", tz: "UTC" } });
    expect(initial.body.prefs.categories).toEqual({ assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true });
    const input = { enabled: true, categories: { ...initial.body.prefs.categories, comments: false }, digest: "off", digestLocalTime: "08:00", quietHours: { start: "22:00", end: "07:30" }, tz: "Europe/Berlin", revision: 0 };
    const saved = await call(session, "PUT", "/mail/settings", input);
    expect(saved.status).toBe(200);
    expect(saved.body.prefs).toMatchObject({ revision: 1, quietStart: "22:00", quietEnd: "07:30", tz: "Europe/Berlin" });
    expect(saved.body.prefs.categories.comments).toBe(false);
    expect((await call(session, "PUT", "/mail/settings", input)).status).toBe(409);
    for (const bad of [{ ...input, revision: 1, digest: "monthly" }, { ...input, revision: 1, tz: "Mars/Olympus" }, { ...input, revision: 1, quietHours: { start: "25:00", end: "07:00" } }, { ...input, revision: 1, categories: { ...input.categories, security: false } }]) {
      expect((await call(session, "PUT", "/mail/settings", bad)).status).toBe(400);
    }
  });

  test("viewers and guests manage their own email settings", async () => {
    const guest = await createUser("Prefs guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    const current = (await call(guest, "GET", "/mail/settings")).body.prefs;
    const result = await call(guest, "PUT", "/mail/settings", { enabled: false, categories: current.categories, digest: "off", digestLocalTime: "08:00", quietHours: null, tz: "UTC", revision: current.revision });
    expect(result.status).toBe(200);
    expect(result.body.prefs.enabled).toBe(false);
  });
});

describe("one-click unsubscribe (T221)", () => {
  test("a valid POST turns only that category off; GET does nothing; forged tokens get the same answer", async () => {
    const session = await createUser("Unsubscribe user");
    const token = await createUnsubscribeToken(session.userId, "sharing");
    const get = await fetch(`${origin}/api/mail/unsubscribe?t=${token}`);
    expect(get.status).toBe(405);
    expect(readEmailPrefs(session.userId).categories.sharing).toBe(true);
    // The mailbox provider's RFC 8058 POST: no Origin, form body, no session.
    const oneClick = await fetch(`${origin}/api/mail/unsubscribe?t=${token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(oneClick.status).toBe(200);
    expect(await oneClick.text()).toBe("");
    const prefs = readEmailPrefs(session.userId);
    expect(prefs.categories).toMatchObject({ sharing: false, assignments: true, comments: true, proposals: true });
    expect(prefs.enabled).toBe(true);
    const [payload, signature] = token.split(".") as [string, string];
    const other = Buffer.from(Buffer.from(payload, "base64url").toString().replace("sharing", "comments")).toString("base64url");
    for (const forged of [`${other}.${signature}`, `${payload}.${"A".repeat(signature.length)}`, "garbage", ""]) {
      const response = await fetch(`${origin}/api/mail/unsubscribe?t=${encodeURIComponent(forged)}`, { method: "POST" });
      expect({ forged, status: response.status, body: await response.text() }).toEqual({ forged, status: 200, body: "" });
    }
    expect(readEmailPrefs(session.userId).categories.comments).toBe(true);
    // Bumping the epoch revokes older tokens.
    const assignments = await createUnsubscribeToken(session.userId, "assignments");
    bumpUnsubscribeEpoch(session.userId);
    await fetch(`${origin}/api/mail/unsubscribe?t=${assignments}`, { method: "POST" });
    expect(readEmailPrefs(session.userId).categories.assignments).toBe(true);
  });
});

describe("Team → Email log (D.4)", () => {
  test("admins see ids, templates, statuses, and names; never an address or payload; members get 403, guests 404", async () => {
    const admin = await createUser("Log admin");
    db.query("UPDATE users SET role = 'admin', email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), admin.userId);
    await call(admin, "POST", "/mail/test");
    await runMailDispatch();
    const log = await call(admin, "GET", "/team/mail-log");
    expect(log.status).toBe(200);
    expect(log.body.emailEnabled).toBe(true);
    expect(log.body.today.sent).toBeGreaterThanOrEqual(1);
    const entry = log.body.entries.find((item: any) => item.template === "account.test");
    expect(entry).toMatchObject({ status: "sent", attempts: 1, to: { userId: admin.userId, displayName: "Log admin" } });
    expect(JSON.stringify(log.body)).not.toContain(admin.email);
    expect(JSON.stringify(log.body)).not.toContain("payload");
    expect((await call(admin, "GET", "/team/mail-log?status=dead")).body.entries).toEqual([]);
    expect((await call(admin, "POST", `/team/mail-log/${entry.id}/retry`)).body.code).toBe("NOT_RETRYABLE");
    db.query("UPDATE mail_outbox SET status = 'dead', payload = '{}' WHERE id = ?").run(entry.id);
    expect((await call(admin, "POST", `/team/mail-log/${entry.id}/retry`)).status).toBe(200);
    expect((db.query("SELECT status FROM mail_outbox WHERE id = ?").get(entry.id) as { status: string }).status).toBe("queued");

    const member = await createUser("Log member");
    expect((await call(member, "GET", "/team/mail-log")).status).toBe(403);
    const guest = await createUser("Log guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await call(guest, "GET", "/team/mail-log")).status).toBe(404);
  });
});
