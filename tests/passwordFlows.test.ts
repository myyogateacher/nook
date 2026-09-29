import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, spareEmail, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { resetMailRouteLimits } = await import("../server/mail/routes");
const { hashAuthToken } = await import("../server/mail/resolve");
const flows = await import("../server/passwordFlows");
const { totpCodeAt, totpCounter } = await import("../server/totp");

/**
 * Wave 30 (E3): change password, forgot / reset password (outbound email §A.5, T224, T225), and
 * the password-changed security mail (#12).
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  resetMailRouteLimits();
  flows.resetPasswordFlowLimits();
  // Most tests do not measure the floor; the timing test puts it back.
  flows.setResetFloorForTests(0, 0);
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
});
afterEach(() => {
  mail.setMailTransportForTests(null);
  flows.setResetFloorForTests(null);
});

async function call(session: Session | null, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, { method: "POST", body: JSON.stringify(body), headers }, session ?? undefined);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {}, raw: text };
}

async function verifiedUser(label: string) {
  const session = await createUser(label);
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}

/** Requests a reset, runs the post-response work and a dispatcher tick, and returns the mailed token. */
async function requestReset(address: string) {
  const result = await call(null, "/auth/password-reset/request", { email: address });
  await flows.passwordResetWorkSettled();
  await runMailDispatch();
  const message = sent.filter((item) => item.to === address && item.subject === "Reset your Nook password").at(-1);
  return { result, token: message ? /#token=([A-Za-z0-9_-]{43})/.exec(message.text)![1]! : null, message };
}

const sessionCount = (userId: string) => (db.query("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(userId) as { count: number }).count;
const audits = (userId: string, event: string) => (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type = ?").get(userId, event) as { count: number }).count;

async function signIn(address: string, password: string, extra: Record<string, string> = {}) {
  return call(null, "/auth/login", { email: address, password, ...extra });
}

async function extraSession(session: Session) {
  const login = await request("/auth/login", { method: "POST", body: JSON.stringify({ email: session.email, password: session.password }) });
  expect(login.status).toBe(200);
  return (login.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
}

async function enableTotp(session: Session) {
  const setup = await (await request("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: session.password }) }, session)).json() as { secret: string };
  const enabled = await request("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: totpCodeAt(setup.secret, totpCounter() - 1) }) }, session);
  expect(enabled.status).toBe(200);
  const { recoveryCodes } = await enabled.json() as { recoveryCodes: string[] };
  return { secret: setup.secret, recoveryCodes };
}

const NEW_PASSWORD = "a brand new horse battery";

describe("reset request (T224)", () => {
  test("identical 202 bodies for existing, unknown, blocked, and unverified addresses; mail only to the verified one", async () => {
    const good = await verifiedUser("Reset good");
    const blocked = await verifiedUser("Reset blocked");
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    const unverified = await createUser("Reset unverified");
    const unknown = spareEmail();
    const outcomes = [];
    for (const address of [good.email, unknown, blocked.email, unverified.email, "not-on-allowlist@example.com"]) outcomes.push((await call(null, "/auth/password-reset/request", { email: address })));
    for (const outcome of outcomes) expect({ status: outcome.status, raw: outcome.raw }).toEqual({ status: 202, raw: JSON.stringify({ ok: true }) });
    await flows.passwordResetWorkSettled();
    await runMailDispatch();
    expect(sent.map((item) => item.to)).toEqual([good.email]);
    expect(sent[0]!.subject).toBe("Reset your Nook password");
  });

  test("each answer waits at least the floor, whatever the address", async () => {
    flows.setResetFloorForTests(null);
    const good = await verifiedUser("Reset floor");
    for (const address of [good.email, spareEmail()]) {
      const started = performance.now();
      const result = await call(null, "/auth/password-reset/request", { email: address });
      expect(result.status).toBe(202);
      expect(performance.now() - started).toBeGreaterThanOrEqual(flows.RESET_FLOOR_MS - 5);
    }
    await flows.passwordResetWorkSettled();
  });

  test("the lookup runs after the response: nothing is queued until the work settles", async () => {
    const good = await verifiedUser("Reset after");
    await call(null, "/auth/password-reset/request", { email: good.email });
    await flows.passwordResetWorkSettled();
    expect((db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ? AND template = 'account.password_reset'").get(good.userId) as { count: number }).count).toBe(1);
    // The outbox holds no token (T220).
    const row = db.query("SELECT payload FROM mail_outbox WHERE user_id = ?").get(good.userId) as { payload: string };
    expect(row.payload).toBe("{}");
  });

  test("email off: still 202, nothing is looked up or queued, and /api/about says resets are off", async () => {
    const good = await verifiedUser("Reset mail off");
    expect((await (await request("/about")).json() as { passwordReset: boolean }).passwordReset).toBe(true);
    mail.setMailTransportForTests(null);
    expect((await call(null, "/auth/password-reset/request", { email: good.email })).status).toBe(202);
    await flows.passwordResetWorkSettled();
    expect(db.query("SELECT 1 FROM mail_outbox WHERE user_id = ?").get(good.userId)).toBeNull();
    expect((await (await request("/about")).json() as { passwordReset: boolean }).passwordReset).toBe(false);
  });

  test("3 an hour per address (silent, unknown addresses too) and 10 an hour per client (429)", async () => {
    const good = await verifiedUser("Reset limits");
    for (let index = 0; index < 5; index += 1) expect((await call(null, "/auth/password-reset/request", { email: good.email })).status).toBe(202);
    await flows.passwordResetWorkSettled();
    expect(audits(good.userId, "auth.password_reset_requested")).toBe(3);
    for (let index = 0; index < 5; index += 1) expect((await call(null, "/auth/password-reset/request", { email: spareEmail() })).status).toBe(202);
    expect((await call(null, "/auth/password-reset/request", { email: spareEmail() })).body.code).toBe("RATE_LIMITED");
    await flows.passwordResetWorkSettled();
  });

  test("refuses a foreign origin and non-JSON like the other pre-auth routes", async () => {
    expect((await call(null, "/auth/password-reset/request", { email: spareEmail() }, { Origin: "https://evil.example.com" })).status).toBe(403);
    const plain = await request("/auth/password-reset/request", { method: "POST", body: "email=x", headers: { "Content-Type": "text/plain" } });
    expect(plain.status).toBe(415);
  });
});

describe("reset link", () => {
  test("the token is hashed at rest, the link uses APP_ORIGIN (never Host), and it works once", async () => {
    const user = await verifiedUser("Reset once");
    const other = await extraSession(user);
    const response = await request("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: user.email }), headers: { "X-Forwarded-Host": "evil.example.com" } });
    expect(response.status).toBe(202);
    await flows.passwordResetWorkSettled();
    await runMailDispatch();
    const message = sent.at(-1)!;
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
    expect(message.text).toContain(`${origin}/reset-password#token=${token}`);
    expect(message.html).not.toContain("evil.example.com");
    const stored = db.query("SELECT token_hash, expires_at, created_at FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset'").all(user.userId) as Array<{ token_hash: string; expires_at: string; created_at: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).toBe(hashAuthToken(token));
    expect(stored[0]!.token_hash).not.toContain(token);
    expect(Date.parse(stored[0]!.expires_at) - Date.parse(stored[0]!.created_at)).toBe(30 * 60_000);

    expect(await call(null, "/auth/password-reset/check", { token })).toMatchObject({ status: 200, body: { ok: true, needsCode: false } });
    const done = await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD });
    expect(done).toMatchObject({ status: 200, body: { ok: true } });
    // No automatic sign-in, and every session is gone.
    expect(done.raw).not.toContain("csrfToken");
    expect(sessionCount(user.userId)).toBe(0);
    expect((await request("/auth/me", {}, user)).status).toBe(401);
    expect((await request("/auth/me", { headers: { Cookie: other } })).status).toBe(401);
    expect((await signIn(user.email, user.password)).status).toBe(401);
    expect((await signIn(user.email, NEW_PASSWORD)).status).toBe(200);
    // Single use.
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: "yet another long password" })).body.code).toBe("TOKEN_INVALID");
    expect((await call(null, "/auth/password-reset/check", { token })).body.code).toBe("TOKEN_INVALID");
    expect(audits(user.userId, "auth.password_reset")).toBe(1);
    await runMailDispatch();
    const changed = sent.at(-1)!;
    expect(changed.subject).toBe("Your Nook password was reset");
    expect(changed.text).toContain(`${origin}/settings/keys`);
  });

  test("completing a reset voids unsubscribe links mailed before it (§B.2); a password change does not", async () => {
    const { createUnsubscribeToken, verifyUnsubscribeToken } = await import("../server/mail/unsubscribe");
    const user = await verifiedUser("Reset unsubscribe");
    const before = await createUnsubscribeToken(user.userId, "sharing");
    expect(await verifyUnsubscribeToken(before)).toEqual({ userId: user.userId, category: "sharing" });
    // A change keeps them: the plan names only "Reset email links" and a reset.
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await verifyUnsubscribeToken(before)).not.toBeNull();
    const token = (await requestReset(user.email)).token!;
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: "the reset long password" })).status).toBe(200);
    expect(await verifyUnsubscribeToken(before)).toBeNull();
    // The one-click POST answers the same empty 200 and changes nothing.
    const oneClick = await fetch(`${origin}/api/mail/unsubscribe?t=${before}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(oneClick.status).toBe(200);
    expect(await oneClick.text()).toBe("");
    const prefs = db.query("SELECT categories FROM email_prefs WHERE user_id = ?").get(user.userId) as { categories: string };
    expect(JSON.parse(prefs.categories).sharing).toBe(1);
    // A link minted afterwards works.
    expect(await verifyUnsubscribeToken(await createUnsubscribeToken(user.userId, "sharing"))).not.toBeNull();
  });

  test("a newer link supersedes the older one; an expired link says so", async () => {
    const user = await verifiedUser("Reset supersede");
    const first = (await requestReset(user.email)).token!;
    const second = (await requestReset(user.email)).token!;
    expect(first).not.toBe(second);
    expect((await call(null, "/auth/password-reset/check", { token: first })).body.code).toBe("TOKEN_INVALID");
    expect((await call(null, "/auth/password-reset/check", { token: second })).status).toBe(200);
    db.query("UPDATE auth_tokens SET expires_at = ? WHERE user_id = ? AND purpose = 'password_reset'").run(new Date(Date.now() - 1000).toISOString(), user.userId);
    expect((await call(null, "/auth/password-reset/check", { token: second })).body.code).toBe("TOKEN_EXPIRED");
    expect((await call(null, "/auth/password-reset/complete", { token: second, newPassword: NEW_PASSWORD })).body.code).toBe("TOKEN_EXPIRED");
    expect((await signIn(user.email, user.password)).status).toBe(200);
  });

  test("blocked after the mail, or an address changed since: the link does nothing", async () => {
    const user = await verifiedUser("Reset blocked later");
    const token = (await requestReset(user.email)).token!;
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), user.userId);
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD })).body.code).toBe("TOKEN_INVALID");
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(user.userId);
    db.query("UPDATE users SET email = ? WHERE id = ?").run(`changed-${crypto.randomUUID()}@example.test`, user.userId);
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD })).body.code).toBe("TOKEN_INVALID");
  });

  test("a 2FA account needs a code or recovery code (T225); five wrong codes burn the link", async () => {
    const user = await verifiedUser("Reset 2FA");
    const { secret, recoveryCodes } = await enableTotp(user);
    let token = (await requestReset(user.email)).token!;
    expect((await call(null, "/auth/password-reset/check", { token })).body).toEqual({ ok: true, needsCode: true });
    expect(await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD })).toMatchObject({ status: 428, body: { code: "TOTP_REQUIRED", requiresTotp: true } });
    for (let index = 0; index < 4; index += 1) expect((await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD, totpCode: "000000" })).body.code).toBe("TOTP_INVALID");
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD, totpCode: "000001" })).body.code).toBe("TOKEN_INVALID");
    expect((await call(null, "/auth/password-reset/check", { token })).body.code).toBe("TOKEN_INVALID");
    expect((await signIn(user.email, NEW_PASSWORD)).status).toBe(401);

    flows.resetPasswordFlowLimits();
    token = (await requestReset(user.email)).token!;
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: NEW_PASSWORD, totpCode: totpCodeAt(secret, totpCounter()) })).status).toBe(200);
    expect(sessionCount(user.userId)).toBe(0);
    // Two-factor survives the reset.
    expect((await signIn(user.email, NEW_PASSWORD)).status).toBe(428);

    // A recovery code works too, once.
    flows.resetPasswordFlowLimits();
    token = (await requestReset(user.email)).token!;
    expect((await call(null, "/auth/password-reset/complete", { token, newPassword: "the third long password", recoveryCode: recoveryCodes[0]! })).status).toBe(200);
    expect(audits(user.userId, "auth.password_reset")).toBe(2);
  });
});

describe("change password", () => {
  test("keeps this session, signs out the others, voids reset links, mails, and audits", async () => {
    const user = await verifiedUser("Change basic");
    const other = await extraSession(user);
    const pendingLink = (await requestReset(user.email)).token!;
    sent = [];
    expect((await call(user, "/auth/password/change", { currentPassword: "wrong password", newPassword: NEW_PASSWORD })).body.code).toBe("REAUTH_FAILED");
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: user.password })).body.code).toBe("SAME_PASSWORD");
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: "too short" })).status).toBe(400);
    const changed = await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD });
    expect(changed).toMatchObject({ status: 200, body: { ok: true, signedOut: 1 } });
    expect((await request("/auth/me", {}, user)).status).toBe(200);
    expect((await request("/auth/me", { headers: { Cookie: other } })).status).toBe(401);
    expect((await call(null, "/auth/password-reset/check", { token: pendingLink })).body.code).toBe("TOKEN_INVALID");
    expect((await signIn(user.email, NEW_PASSWORD)).status).toBe(200);
    expect(audits(user.userId, "auth.password_changed")).toBe(1);
    await runMailDispatch();
    expect(sent.map((item) => item.subject)).toEqual(["Your Nook password was changed"]);
  });

  test("needs CSRF and a session", async () => {
    const user = await verifiedUser("Change csrf");
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD }, { "X-CSRF-Token": "nope" })).status).toBe(403);
    expect((await call(null, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD })).status).toBe(401);
  });

  test("with 2FA a code is required and consumed after the password", async () => {
    const user = await verifiedUser("Change 2FA");
    const { secret } = await enableTotp(user);
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD })).status).toBe(428);
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD, totpCode: "000000" })).body.code).toBe("REAUTH_FAILED");
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD, totpCode: totpCodeAt(secret, totpCounter()) })).status).toBe(200);
  });

  test("works with email off, and a viewer may change their own password", async () => {
    mail.setMailTransportForTests(null);
    const user = await verifiedUser("Change viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(user.userId);
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(db.query("SELECT 1 FROM mail_outbox WHERE user_id = ?").get(user.userId)).toBeNull();
  });

  test("5 attempts per 10 minutes", async () => {
    const user = await verifiedUser("Change limit");
    for (let index = 0; index < 5; index += 1) expect((await call(user, "/auth/password/change", { currentPassword: "wrong password", newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await call(user, "/auth/password/change", { currentPassword: user.password, newPassword: NEW_PASSWORD })).status).toBe(429);
  });
});

test("pages are served with Referrer-Policy: no-referrer", async () => {
  const response = await fetch(`${origin}/reset-password`);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
