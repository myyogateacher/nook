/**
 * Google sign-in (Wave 35, docs/plan/WAVE_35_GOOGLE_SIGNIN.md, T250–T262). The server talks to a local
 * fake issuer (tests/support/fakeGoogle.ts); nothing reaches Google. `config.auth` is switched per
 * test and restored, since every test file shares one server (tests/support/harness.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, origin, request, spareEmail, type Session } from "./support/harness";
import { startFakeGoogle, type FakeGoogle, type FakeIdentity, type TokenTweaks } from "./support/fakeGoogle";
const { config, googleEndpoints } = await import("../server/config");
const { resetJwksCache, exchangeCode, OidcError } = await import("../server/google/oidc");
const { avatarWorkSettled } = await import("../server/google/routes");
const { resetRegistrationRateLimit } = await import("../server/authLimits");
const { UNUSABLE_PASSWORD } = await import("../server/passwords");
const { totpCodeAt, totpCounter } = await import("../server/totp");

let fake: FakeGoogle;
const suiteStarted = new Date().toISOString();
const saved = { auth: structuredClone(config.auth), allowRegistration: config.allowRegistration, signupRole: config.signupRole };

beforeAll(async () => {
  fake = await startFakeGoogle();
  // Accounts made here get SIGNUP_ROLE, not the bootstrap admin role, whichever file ran first.
  if (!db.query("SELECT 1 FROM users WHERE role = 'admin' AND disabled_at IS NULL").get()) {
    const admin = await createUser("Google suite admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  }
});
afterAll(() => {
  // The run shares one database and the Team list shows at most 500 people: remove this file's accounts.
  const ids = (db.query("SELECT id FROM users WHERE created_at >= ?").all(suiteStarted) as Array<{ id: string }>).map((row) => row.id);
  for (const id of ids) {
    try {
      db.transaction(() => {
        db.query("DELETE FROM team_events WHERE target_user_id = ? OR actor_id = ?").run(id, id);
        db.query("UPDATE team_invites SET used_by = NULL WHERE used_by = ?").run(id);
        db.query("DELETE FROM team_invites WHERE created_by = ?").run(id);
        db.query("DELETE FROM users WHERE id = ?").run(id);
      })();
    } catch {
      // Something else points at it; leaving one account behind is harmless.
    }
  }
  Object.assign(config.auth, structuredClone(saved.auth));
  config.allowRegistration = saved.allowRegistration;
  config.signupRole = saved.signupRole;
  resetJwksCache();
  fake.stop();
});
beforeEach(() => {
  config.auth.methods = "both";
  config.auth.google.clientId = fake.clientId;
  config.auth.google.clientSecret = fake.clientSecret;
  config.auth.google.allowedDomains = [];
  config.auth.google.endpoints = googleEndpoints(fake.url);
  config.allowRegistration = true;
  resetJwksCache();
  resetRegistrationRateLimit();
  // L4 caps live flows per client, and every request here comes from one address.
  db.query("DELETE FROM google_auth_flows").run();
});
afterEach(async () => {
  await avatarWorkSettled();
});

const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? null;
const fragmentOf = (location: string | null) => location?.split("#")[1] ?? "";
const newSub = () => `sub-${crypto.randomUUID()}`;
const identityFor = (email: string, extra: Partial<FakeIdentity> = {}): FakeIdentity => ({ sub: newSub(), email, name: "Google Person", picture: fake.avatarUrl(`${crypto.randomUUID()}.png`), ...extra });
/** A Workspace account for an example.test address: Google is authoritative for it (MEDIUM-1). */
const workspace = (email: string) => identityFor(email, { hd: "example.test" });
const mailEvents = (userId: string, template: string) => (db.query("SELECT payload FROM mail_outbox WHERE user_id = ? AND template = ?").all(userId, template) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload).event as string);
async function adminUser() {
  const admin = await createUser("Google admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  return admin;
}

async function start(query = "", headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api/auth/google/start${query}`, { redirect: "manual", headers });
  return { response, location: response.headers.get("location") ?? "", flowCookie: cookieOf(response, "nook_google_flow") };
}

/** The whole round trip: start, the fake's chooser, and the callback. */
async function googleSignIn(identity: FakeIdentity, options: { query?: string; tweaks?: TokenTweaks; headers?: Record<string, string>; flowCookie?: string } = {}) {
  const started = options.flowCookie ? null : await start(options.query ?? "", options.headers);
  const location = started?.location ?? "";
  const callbackUrl = fake.authorize(location, identity, options.tweaks ?? {});
  const flowCookie = options.flowCookie ?? started!.flowCookie!;
  const response = await fetch(callbackUrl, { redirect: "manual", headers: { Cookie: flowCookie } });
  return { started, callbackUrl, flowCookie, response, location: response.headers.get("location"), session: cookieOf(response, "mynotes_session") };
}

async function me(cookie: string | null) {
  const response = await fetch(`${origin}/api/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: response.status, body: await response.json() as { user: { id: string; email: string; role: string; avatarUrl: string | null }; csrfToken: string } };
}

const userRow = (email: string) => db.query("SELECT * FROM users WHERE email = ?").get(email) as Record<string, any> | null;
const audits = (userId: string, event: string) => (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type = ?").get(userId, event) as { count: number }).count;
const verify = (session: Session) => db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);

async function passwordLogin(email: string, password: string) {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

describe("configuration and method enforcement (D295)", () => {
  test("/api/about reports the methods; the default harness is password only", async () => {
    let about = await (await request("/about")).json() as { authMethods: { password: boolean; google: boolean } };
    expect(about.authMethods).toEqual({ password: true, google: true });
    config.auth.methods = "google";
    about = await (await request("/about")).json() as typeof about;
    expect(about.authMethods).toEqual({ password: false, google: true });
    config.auth.methods = "password";
    about = await (await request("/about")).json() as typeof about;
    expect(about.authMethods).toEqual({ password: true, google: false });
  });

  test("AUTH_METHODS=google refuses every password route on the server", async () => {
    const person = await createUser("Password only");
    config.auth.methods = "google";
    const refused = [
      await passwordLogin(person.email, person.password),
      await request("/auth/register", { method: "POST", body: JSON.stringify({ email: spareEmail(), displayName: "X", password: "correct horse battery staple" }) }),
      await request("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: person.email }) }),
      await request("/auth/password-reset/check", { method: "POST", body: JSON.stringify({ token: "a".repeat(43) }) }),
      await request("/auth/password-reset/complete", { method: "POST", body: JSON.stringify({ token: "a".repeat(43), newPassword: "another long password" }) }),
      await request("/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword: person.password, newPassword: "another long password" }) }, person)
    ];
    for (const response of refused) expect({ status: response.status, code: (await response.json() as { code?: string }).code }).toEqual({ status: 403, code: "PASSWORD_SIGNIN_DISABLED" });
    // Re-authentication by password is refused too: a key cannot be made with the password.
    const key = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "k", scopes: ["notes:read"], password: person.password }) }, person);
    expect(key.status).toBe(401);
  });

  test("AUTH_METHODS=password answers 404 GOOGLE_SIGNIN_DISABLED on every Google route", async () => {
    const person = await createUser("Google off");
    config.auth.methods = "password";
    const responses = [
      await fetch(`${origin}/api/auth/google/start`, { redirect: "manual" }),
      await fetch(`${origin}/api/auth/google/callback?code=x&state=y`, { redirect: "manual" }),
      await request("/auth/google/second-factor", { method: "POST", body: JSON.stringify({ totpCode: "123456" }) }),
      await request("/auth/google/invite", { method: "POST", body: JSON.stringify({ token: "a".repeat(43) }) }),
      await request("/auth/google", { method: "DELETE", body: "{}" }, person)
    ];
    for (const response of responses) expect({ status: response.status, code: (await response.json() as { code?: string }).code }).toEqual({ status: 404, code: "GOOGLE_SIGNIN_DISABLED" });
    const account = await (await request("/auth/account", {}, person)).json() as { methods: unknown; reauth: string };
    expect(account.methods).toEqual({ password: true, google: false });
    expect(account.reauth).toBe("password");
  });
});

describe("the round trip (D289, D291, T250–T253, T260)", () => {
  test("start sends PKCE S256, state, nonce, and the APP_ORIGIN redirect URI whatever the Host header says", async () => {
    const { response, location, flowCookie } = await start("?return=/tasks", { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" });
    expect(response.status).toBe(302);
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/o/oauth2/v2/auth`);
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/google/callback`);
    expect(url.searchParams.get("client_id")).toBe(fake.clientId);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = response.headers.getSetCookie().find((value) => value.startsWith("nook_google_flow="))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/auth/google");
    expect(setCookie).toContain("Max-Age=600");
    expect(flowCookie).toBeTruthy();
    // Only the state's hash is stored; the verifier stays on the server.
    const row = db.query("SELECT state_hash, code_verifier FROM google_auth_flows ORDER BY created_at DESC LIMIT 1").get() as { state_hash: string; code_verifier: string };
    expect(row.state_hash).not.toBe(url.searchParams.get("state"));
    expect(location).not.toContain(row.code_verifier);
  });

  test("a new Google account is created, verified, signed in, and lands on the return path", async () => {
    const email = spareEmail();
    const result = await googleSignIn(identityFor(email, { name: "  Asha Google  " }), { query: "?return=%2Ftasks%2Fmy%3Fq%3Dx" });
    expect(result.response.status).toBe(303);
    expect(result.location).toBe("/tasks/my?q=x");
    expect(result.session).toBeTruthy();
    const current = await me(result.session);
    expect(current.status).toBe(200);
    expect(current.body.user.email).toBe(email);
    expect(current.body.user.role).toBe("member");
    const row = userRow(email)!;
    expect(row.display_name).toBe("Asha Google");
    expect(row.email_verified_at).not.toBeNull();
    expect(row.password_hash).toBe(UNUSABLE_PASSWORD);
    expect(audits(row.id, "auth.register")).toBe(1);
    // No password can sign in to it (D294): the sentinel is refused without throwing.
    for (const attempt of ["", "!unusable:google", UNUSABLE_PASSWORD, "correct horse battery staple"]) {
      const response = await passwordLogin(email, attempt || "x");
      expect(response.status).toBe(401);
    }
    // The flow cookie is cleared and the row is used.
    expect(result.response.headers.getSetCookie().some((value) => value.startsWith("nook_google_flow=;"))).toBe(true);
    // Google's tokens are never stored.
    expect(JSON.stringify(db.query("SELECT * FROM google_auth_flows").all())).not.toContain("fake-access-token");
  });

  test("a replayed callback (used state) and a callback from another browser are refused", async () => {
    const email = spareEmail();
    const first = await googleSignIn(identityFor(email));
    expect(first.session).toBeTruthy();
    const replay = await fetch(first.callbackUrl, { redirect: "manual", headers: { Cookie: first.flowCookie } });
    expect(replay.headers.get("location")).toBe("/login#error=expired");
    expect(cookieOf(replay, "mynotes_session")).toBeNull();
    // Login CSRF (T250): the victim's browser has no flow cookie (or its own), so the attacker's code is useless.
    const attacker = await start();
    const url = fake.authorize(attacker.location, identityFor(spareEmail()));
    const victim = await start();
    const forged = await fetch(url, { redirect: "manual", headers: { Cookie: victim.flowCookie! } });
    expect(forged.headers.get("location")).toBe("/login#error=expired");
    const noCookie = await fetch(url, { redirect: "manual" });
    expect(noCookie.headers.get("location")).toBe("/login#error=expired");
  });

  test("a cancelled chooser answers denied; a flow past 10 minutes answers expired", async () => {
    const started = await start();
    const state = new URL(started.location).searchParams.get("state")!;
    const denied = await fetch(`${origin}/api/auth/google/callback?error=access_denied&state=${state}`, { redirect: "manual", headers: { Cookie: started.flowCookie! } });
    expect(denied.headers.get("location")).toBe("/login#error=denied");
    const old = await start();
    db.query("UPDATE google_auth_flows SET expires_at = ? WHERE used_at IS NULL").run(new Date(Date.now() - 1000).toISOString());
    const late = await fetch(fake.authorize(old.location, identityFor(spareEmail())), { redirect: "manual", headers: { Cookie: old.flowCookie! } });
    expect(late.headers.get("location")).toBe("/login#error=expired");
  });

  test("ID token checks: signature, foreign key, aud, azp, iss, exp, iat, nonce, alg, and email_verified", async () => {
    const cases: Array<[TokenTweaks, string]> = [
      [{ badSignature: true }, "error=failed"],
      [{ foreignKey: true }, "error=failed"],
      [{ claims: { aud: "someone-else.apps.nook.test", azp: "someone-else.apps.nook.test" } }, "error=failed"],
      [{ claims: { azp: "someone-else.apps.nook.test" } }, "error=failed"],
      [{ claims: { iss: "https://accounts.evil.test" } }, "error=failed"],
      [{ claims: { exp: Math.floor(Date.now() / 1000) - 120 } }, "error=failed"],
      [{ claims: { iat: Math.floor(Date.now() / 1000) + 600 } }, "error=failed"],
      [{ claims: { nonce: "not-the-flow-nonce" } }, "error=failed"],
      [{ header: { alg: "HS256" } }, "error=failed"],
      [{ claims: { email_verified: false } }, "error=unverified"],
      [{ claims: { email_verified: "true" } }, "error=unverified"]
    ];
    for (const [tweaks, expected] of cases) {
      const email = spareEmail();
      const result = await googleSignIn(identityFor(email), { tweaks });
      expect({ tweaks, fragment: fragmentOf(result.location) }).toEqual({ tweaks, fragment: expected });
      expect(result.session).toBeNull();
      expect(userRow(email)).toBeNull();
    }
  });

  test("the token endpoint refuses a code without the right PKCE verifier", async () => {
    const started = await start();
    const code = new URL(fake.authorize(started.location, identityFor(spareEmail()))).searchParams.get("code")!;
    const error = await exchangeCode(code, "the-wrong-verifier-0123456789012345678901234567").catch((reason) => reason);
    expect(error).toBeInstanceOf(OidcError);
    expect((error as InstanceType<typeof OidcError>).reason).toBe("token_status_400");
  });

  test("return paths are validated (T253)", async () => {
    const { safeReturnPath } = await import("../server/google/flows");
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test/x", "evil", "/api/auth/me", "/login", "/login?x=1", "/%0d%0aSet-Cookie:x", `/${"a".repeat(600)}`, "/\u0000x", ""]) {
      expect({ bad, path: safeReturnPath(bad) }).toEqual({ bad, path: bad === "/%0d%0aSet-Cookie:x" ? "/%0d%0aSet-Cookie:x" : "/" });
    }
    expect(safeReturnPath("/notes/folder/abc?x=1#frag")).toBe("/notes/folder/abc?x=1");
    expect(safeReturnPath("/settings/security")).toBe("/settings/security");
    const result = await googleSignIn(identityFor(spareEmail()), { query: `?return=${encodeURIComponent("//evil.test/phish")}` });
    expect(result.location).toBe("/");
  });
});

describe("existing accounts (D292, D293, HIGH-1, MEDIUM-1, T254, T255)", () => {
  test("signing in again by sub reuses the account; a new Google address on the same sub does not move it (L8)", async () => {
    const email = spareEmail();
    const identity = identityFor(email);
    const first = await googleSignIn(identity);
    const firstUser = (await me(first.session)).body.user;
    const newAddress = spareEmail();
    const again = await googleSignIn({ ...identity, email: newAddress });
    expect((await me(again.session)).body.user.id).toBe(firstUser.id);
    expect((await me(again.session)).body.user.email).toBe(email);
    // The identity's display address follows Google; the Nook email never does.
    expect((db.query("SELECT email FROM google_identities WHERE user_id = ?").get(firstUser.id) as { email: string }).email).toBe(newAddress);
  });

  test("a verified account is linked when Google is authoritative for the address, keeps its password, and is mailed (L2)", async () => {
    const mail = await import("../server/mail");
    mail.setMailTransportForTests(async () => ({ id: "msg_google" }));
    try {
      const person = await createUser("Verified linker");
      verify(person);
      const result = await googleSignIn(workspace(person.email));
      expect(result.location).toBe("/");
      expect((await me(result.session)).body.user.id).toBe(person.userId);
      expect((await passwordLogin(person.email, person.password)).status).toBe(200);
      expect((await me(person.cookie)).status).toBe(200);
      expect(audits(person.userId, "auth.google_linked")).toBe(1);
      expect(mailEvents(person.userId, "security.password_changed")).toContain("google_linked");
    } finally {
      mail.setMailTransportForTests(null);
    }
  });

  test("MEDIUM-1: a consumer Google account with a company address (no hd) never links by email", async () => {
    const person = await createUser("Company address");
    verify(person);
    const result = await googleSignIn(identityFor(person.email));
    expect(result.location).toBe("/login#error=link_required");
    expect(result.session).toBeNull();
    expect(db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(person.userId)).toBeNull();
    // A different Workspace domain is not authoritative either.
    expect((await googleSignIn(identityFor(person.email, { hd: "other.test" }))).location).toBe("/login#error=link_required");
    const { googleAuthoritative } = await import("../server/google/oidc");
    expect(googleAuthoritative({ email: "a@gmail.com", hd: null })).toBe(true);
    expect(googleAuthoritative({ email: "a@googlemail.com", hd: null })).toBe(true);
    expect(googleAuthoritative({ email: "a@gmail.com", hd: "gmail.com" })).toBe(false);
    expect(googleAuthoritative({ email: "a@corp.test", hd: "corp.test" })).toBe(true);
    expect(googleAuthoritative({ email: "a@corp.test", hd: null })).toBe(false);
  });

  test("HIGH-1 repro: a never-verified squatter account gets link_required and nothing changes; an admin reset then an allowed link", async () => {
    const mail = await import("../server/mail");
    mail.setMailTransportForTests(async () => ({ id: "msg_google" }));
    try {
      const squatter = await createUser("Squatter");
      const friend = await createUser("Squatter friend");
      const key = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "squat", scopes: ["notes:read"], password: squatter.password }) }, squatter);
      expect(key.status).toBe(201);
      await enableTotpFor(squatter);
      const folder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(squatter.userId) as { id: string }).id;
      expect((await request(`/folders/${folder}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [friend.userId] }) }, squatter)).status).toBe(200);
      const before = JSON.stringify(userRow(squatter.email));

      const victim = workspace(squatter.email);
      const refused = await googleSignIn(victim);
      expect(refused.location).toBe("/login#error=link_required");
      expect(refused.session).toBeNull();
      // Nothing changed: the account, its session, its password, its key, and its share.
      expect(JSON.stringify(userRow(squatter.email))).toBe(before);
      expect((await me(squatter.cookie)).status).toBe(200);
      expect(db.query("SELECT 1 FROM folder_shares WHERE folder_id = ? AND user_id = ?").get(folder, friend.userId)).not.toBeNull();
      expect(db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(squatter.userId)).toBeNull();

      const admin = await adminUser();
      const preview = await (await request(`/team/${squatter.userId}/google`, {}, admin)).json() as { linked: unknown; emailVerified: boolean; resetPreview: Record<string, number> };
      expect(preview).toMatchObject({ linked: null, emailVerified: false, resetPreview: { sessions: 1, keys: 1, items: 1, shares: 1, password: 1, twoFactor: 1 } });
      const allowed = await request(`/team/${squatter.userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: true }) }, admin);
      expect(allowed.status).toBe(200);
      const result = await allowed.json() as { allowedUntil: string; reset: Record<string, number> };
      expect(result.reset).toMatchObject({ sessions: 1, keys: 1, items: 1, shares: 1, password: 1, twoFactor: 1 });
      expect(Date.parse(result.allowedUntil) - Date.now()).toBeGreaterThan(23 * 3_600_000);
      // The squatter is out: session, password, key, two-factor, and the share are gone; Default is private.
      expect((await me(squatter.cookie)).status).toBe(401);
      expect((await passwordLogin(squatter.email, squatter.password)).status).toBe(401);
      expect(userRow(squatter.email)!.password_hash).toBe(UNUSABLE_PASSWORD);
      expect(userRow(squatter.email)!.totp_enabled_at).toBeNull();
      expect((db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").get(squatter.userId) as { count: number }).count).toBe(0);
      expect(db.query("SELECT 1 FROM folder_shares WHERE folder_id = ?").get(folder)).toBeNull();
      expect((db.query("SELECT visibility FROM folders WHERE id = ?").get(folder) as { visibility: string }).visibility).toBe("private");
      expect(mailEvents(squatter.userId, "security.account")).toContain("google_reset");
      expect((db.query("SELECT COUNT(*) AS count FROM access_events WHERE target_user_id = ? AND action IN ('account.google_reset', 'account.google_allowed')").get(squatter.userId) as { count: number }).count).toBe(2);
      // The owner signs in with Google and is linked; the allowance is used up.
      const owner = await googleSignIn(victim);
      expect(owner.location).toBe("/");
      expect((await me(owner.session)).body.user.id).toBe(squatter.userId);
      expect(userRow(squatter.email)!.google_link_allowed_until).toBeNull();
      expect(userRow(squatter.email)!.email_verified_at).not.toBeNull();
    } finally {
      mail.setMailTransportForTests(null);
    }
  });

  test("an allowance without reset keeps everything; it is single use, expires, never crosses addresses, and never opens a blocked account", async () => {
    const admin = await adminUser();
    const person = await createUser("Allowed plain");
    const allow = async (target: Session) => request(`/team/${target.userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: false }) }, admin);
    expect((await allow(person)).status).toBe(200);
    expect((await me(person.cookie)).status).toBe(200);
    expect((await passwordLogin(person.email, person.password)).status).toBe(200);
    // A consumer account with this company address is still not authoritative.
    expect((await googleSignIn(identityFor(person.email))).location).toBe("/login#error=link_required");
    const identity = workspace(person.email);
    expect((await googleSignIn(identity)).location).toBe("/");
    expect((await me(person.cookie)).status).toBe(200);
    expect(userRow(person.email)!.google_link_allowed_until).toBeNull();
    expect((await allow(person)).status).toBe(409);

    // Expired.
    const late = await createUser("Allowed late");
    expect((await allow(late)).status).toBe(200);
    db.query("UPDATE users SET google_link_allowed_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), late.userId);
    expect((await googleSignIn(workspace(late.email))).location).toBe("/login#error=link_required");

    // Another address: account A's allowance does nothing for Google account B.
    const a = await createUser("Allowed A");
    const b = await createUser("Not allowed B");
    expect((await allow(a)).status).toBe(200);
    expect((await googleSignIn(workspace(b.email))).location).toBe("/login#error=link_required");
    expect(db.query("SELECT 1 FROM google_identities WHERE user_id IN (?, ?)").get(a.userId, b.userId)).toBeNull();

    // Blocked.
    const blocked = await createUser("Allowed blocked");
    expect((await allow(blocked)).status).toBe(200);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    expect((await googleSignIn(workspace(blocked.email))).location).toBe("/login#error=blocked");
    expect(db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(blocked.userId)).toBeNull();

    // Admins cannot use it on themselves through the web; non-admins cannot use it at all.
    const self = await request(`/team/${admin.userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: true }) }, admin);
    expect(self.status).toBe(403);
    expect((await self.json() as { code: string }).code).toBe("SELF_ACTION");
    const member = await createUser("Plain member");
    expect((await request(`/team/${a.userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: false }) }, member)).status).toBe(403);
  });

  test("an admin unlinks a member's Google sign-in only when they keep a way in (L6)", async () => {
    const admin = await adminUser();
    const person = await createUser("Unlink by admin");
    verify(person);
    const identity = workspace(person.email);
    expect((await googleSignIn(identity)).session).toBeTruthy();
    expect((await request(`/team/${person.userId}/google`, { method: "DELETE", body: "{}" }, admin)).status).toBe(200);
    expect(db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(person.userId)).toBeNull();
    // A Google-only account needs an allowance first, so it can link its (new) Google account.
    const googleOnly = identityFor(spareEmail());
    const signedIn = await googleSignIn(googleOnly);
    const userId = (await me(signedIn.session)).body.user.id;
    const refused = await request(`/team/${userId}/google`, { method: "DELETE", body: "{}" }, admin);
    expect(refused.status).toBe(409);
    expect((await refused.json() as { code: string }).code).toBe("NO_OTHER_SIGN_IN");
    expect((await request(`/team/${userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: false }) }, admin)).status).toBe(409);
  });

  test("the host CLI allows (with reset) and unlinks", async () => {
    const person = await createUser("CLI person");
    const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "server", "team-admin.ts"), ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const allowed = cli("allow-google-link", person.email, "--reset");
    expect({ code: allowed.exitCode, err: allowed.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(allowed.stdout.toString()).toContain("Reset first");
    expect(userRow(person.email)!.password_hash).toBe(UNUSABLE_PASSWORD);
    expect(userRow(person.email)!.google_link_allowed_until).not.toBeNull();
    expect((await googleSignIn(workspace(person.email))).location).toBe("/");
    // The Google account was recreated (new sub): unlink, allow, and the new one links.
    const recreated = workspace(person.email);
    expect((await googleSignIn(recreated)).location).toBe("/login#error=already_linked");
    expect(cli("unlink-google", person.email).exitCode).toBe(0);
    expect(cli("allow-google-link", person.email).exitCode).toBe(0);
    expect((await googleSignIn(recreated)).location).toBe("/");
    expect(cli("allow-google-link", "nobody@nook.test").exitCode).not.toBe(0);
  }, 30_000);

  test("a blocked account is refused after Google proves the address, and is not linked", async () => {
    const person = await createUser("Blocked Google");
    verify(person);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), person.userId);
    const result = await googleSignIn(workspace(person.email));
    expect(result.location).toBe("/login#error=blocked");
    expect(result.session).toBeNull();
    expect(db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(person.userId)).toBeNull();
    // A linked account blocked later is refused the same way.
    const linked = await createUser("Blocked later");
    verify(linked);
    const identity = workspace(linked.email);
    expect((await googleSignIn(identity)).session).toBeTruthy();
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), linked.userId);
    expect((await googleSignIn(identity)).location).toBe("/login#error=blocked");
  });

  test("closed registration refuses creation but existing accounts still sign in", async () => {
    const identity = identityFor(spareEmail());
    expect((await googleSignIn(identity)).session).toBeTruthy();
    config.allowRegistration = false;
    const stranger = spareEmail();
    const refused = await googleSignIn(identityFor(stranger));
    expect(refused.location).toBe("/login#error=signup_closed");
    expect(userRow(stranger)).toBeNull();
    expect((await googleSignIn(identity)).session).toBeTruthy();
  });
});

describe("allowlists and domains (T256, T258)", () => {
  test("ALLOWED_EMAILS applies to new and existing accounts with one answer", async () => {
    const outside = await googleSignIn(identityFor("outsider@nook.test"));
    expect(outside.location).toBe("/login#error=not_allowed");
    expect(userRow("outsider@nook.test")).toBeNull();
  });

  test("GOOGLE_ALLOWED_DOMAINS needs the listed domain and a matching signed hd", async () => {
    config.auth.google.allowedDomains = ["example.test"];
    const started = await start();
    expect(new URL(started.location).searchParams.get("hd")).toBe("example.test");
    expect((await googleSignIn(identityFor(spareEmail(), { hd: "example.test" }))).session).toBeTruthy();
    expect((await googleSignIn(identityFor(spareEmail()))).location).toBe("/login#error=not_allowed");
    expect((await googleSignIn(identityFor(spareEmail(), { hd: "other.test" }))).location).toBe("/login#error=not_allowed");
    // An existing linked account is checked on every sign-in, not only at creation.
    config.auth.google.allowedDomains = [];
    const identity = identityFor(spareEmail());
    expect((await googleSignIn(identity)).session).toBeTruthy();
    config.auth.google.allowedDomains = ["nook.test"];
    expect((await googleSignIn(identity)).location).toBe("/login#error=not_allowed");
  });

  test("the hd rule for Workspace and consumer domains", async () => {
    const { domainAllowed } = await import("../server/google/oidc");
    config.auth.google.allowedDomains = ["corp.test", "gmail.com"];
    expect(domainAllowed({ email: "a@corp.test", hd: "corp.test" })).toBe(true);
    expect(domainAllowed({ email: "a@corp.test", hd: null })).toBe(false);
    expect(domainAllowed({ email: "a@gmail.com", hd: null })).toBe(true);
    expect(domainAllowed({ email: "a@gmail.com", hd: "gmail.com" })).toBe(false);
    expect(domainAllowed({ email: "a@evil.test", hd: "corp.test" })).toBe(false);
    config.auth.google.allowedDomains = [];
    expect(domainAllowed({ email: "a@anything.test", hd: null })).toBe(true);
  });
});

async function enableTotpFor(session: Session) {
  const setup = await (await request("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: session.password }) }, session)).json() as { secret: string };
  const enabled = await request("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: totpCodeAt(setup.secret, totpCounter() - 1) }) }, session);
  expect(enabled.status).toBe(200);
  return { secret: setup.secret };
}

describe("two-factor after Google (D296)", () => {
  test("a TOTP account needs its code before a session exists; wrong codes end the flow at five", async () => {
    const person = await createUser("Google two-factor");
    verify(person);
    const { secret } = await enableTotpFor(person);
    const identity = workspace(person.email);
    const result = await googleSignIn(identity, { query: "?return=/calendar" });
    expect(result.location).toBe("/login#google=code");
    expect(result.session).toBeNull();
    const flow = cookieOf(result.response, "nook_google_flow")!;
    expect(flow).toBeTruthy();
    const post = (body: unknown, cookie = flow) => fetch(`${origin}/api/auth/google/second-factor`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
    const wrong = await post({ totpCode: "000000" });
    expect(wrong.status).toBe(401);
    expect((await wrong.json() as { code: string }).code).toBe("TOTP_INVALID");
    const foreign = await fetch(`${origin}/api/auth/google/second-factor`, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json", Cookie: flow }, body: "{}" });
    expect(foreign.status).toBe(403);
    const right = await post({ totpCode: totpCodeAt(secret, totpCounter()) });
    expect(right.status).toBe(200);
    const body = await right.json() as { returnTo: string; csrfToken: string };
    expect(body.returnTo).toBe("/calendar");
    expect((await me(cookieOf(right, "mynotes_session"))).body.user.id).toBe(person.userId);
    const again = await post({ totpCode: totpCodeAt(secret, totpCounter() + 1) });
    expect((await again.json() as { code: string }).code).toBe("FLOW_EXPIRED");
    // Five wrong codes end the flow.
    const second = await googleSignIn(identity);
    const cookie = cookieOf(second.response, "nook_google_flow")!;
    for (let attempt = 1; attempt <= 4; attempt += 1) expect((await post({ totpCode: "111111" }, cookie)).status).toBe(401);
    const fifth = await post({ totpCode: "111111" }, cookie);
    expect((await fifth.json() as { code: string }).code).toBe("FLOW_EXPIRED");
  });
});

describe("invites (D298)", () => {
  async function adminAndInvite(email: string | null, role = "viewer") {
    const admin = await createUser("Invite admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const created = await request("/team/invites", { method: "POST", body: JSON.stringify({ role, ...(email ? { email } : {}) }) }, admin);
    expect(created.status).toBe(201);
    return (await created.json() as { token: string }).token;
  }

  async function prepare(token: string) {
    const response = await request("/auth/google/invite", { method: "POST", body: JSON.stringify({ token }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { start: string };
    expect(body.start).toBe("/api/auth/google/start?intent=invite");
    return cookieOf(response, "nook_google_flow")!;
  }

  test("a bound invite opens a closed instance for the same Google address, with the invite's role, once", async () => {
    const email = spareEmail();
    const token = await adminAndInvite(email);
    config.allowRegistration = false;
    const prepared = await prepare(token);
    const started = await start("?intent=invite", { Cookie: prepared });
    expect(started.response.status).toBe(302);
    // The token never enters a URL.
    expect(started.location).not.toContain(token);
    const callback = await fetch(fake.authorize(started.location, identityFor(email)), { redirect: "manual", headers: { Cookie: started.flowCookie! } });
    expect(callback.headers.get("location")).toBe("/");
    const row = userRow(email)!;
    expect(row.role).toBe("viewer");
    expect(row.email_verified_at).not.toBeNull();
    expect((db.query("SELECT used_by FROM team_invites WHERE used_by = ?").get(row.id) as { used_by: string } | null)?.used_by).toBe(row.id);
    // Single use: a second hand-off with the same token is refused.
    const reuse = await request("/auth/google/invite", { method: "POST", body: JSON.stringify({ token }) });
    expect((await reuse.json() as { code: string }).code).toBe("INVITE_INVALID");
  });

  test("a bound invite refuses another Google address and creates nothing", async () => {
    const bound = spareEmail();
    const token = await adminAndInvite(bound);
    config.allowRegistration = false;
    const prepared = await prepare(token);
    const started = await start("?intent=invite", { Cookie: prepared });
    const other = spareEmail();
    const callback = await fetch(fake.authorize(started.location, identityFor(other)), { redirect: "manual", headers: { Cookie: started.flowCookie! } });
    // QA U8: back to the invite page with the message; the invite waits server side, still usable.
    expect(callback.headers.get("location")).toBe("/register#google-error=invite_mismatch");
    expect(callback.headers.get("location")).not.toContain(token);
    expect(userRow(other)).toBeNull();
    const kept = cookieOf(callback, "nook_google_flow")!;
    const preview = await fetch(`${origin}/api/auth/google/invite`, { headers: { Cookie: kept } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ role: "viewer" });
    const retry = await start("?intent=invite", { Cookie: kept });
    const joined = await fetch(fake.authorize(retry.location, identityFor(bound)), { redirect: "manual", headers: { Cookie: retry.flowCookie! } });
    expect(joined.headers.get("location")).toBe("/");
    expect(userRow(bound)!.role).toBe("viewer");
    // Without a prepared invite, intent=invite goes nowhere.
    expect((await start("?intent=invite")).location).toBe("/login#error=invite_invalid");
  });
});

describe("re-authentication, linking, and unlinking (D297, D300, T261, MEDIUM-2, MEDIUM-3, L3)", () => {
  test("a Google-only account creates a key after a fresh Google confirmation, only on that session", async () => {
    const email = spareEmail();
    const identity = identityFor(email);
    const signedIn = await googleSignIn(identity);
    const session = signedIn.session!;
    const csrf = (await me(session)).body.csrfToken;
    const createKey = (cookie: string, token: string) => fetch(`${origin}/api/mcp/keys`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": token }, body: JSON.stringify({ name: "g", scopes: ["notes:read"] }) });
    expect((await createKey(session, csrf)).status).toBe(401);
    let account = await (await fetch(`${origin}/api/auth/account`, { headers: { Cookie: session } })).json() as { reauth: string; reauthUntil: string | null; hasPassword: boolean; google: { email: string } };
    expect(account).toMatchObject({ reauth: "google", reauthUntil: null, hasPassword: false, google: { email } });
    // MEDIUM-3: the request forces a new Google login.
    const started = await start("?intent=reauth&return=/settings/mcp", { Cookie: session });
    const params = new URL(started.location).searchParams;
    expect(params.get("prompt")).toBe("login");
    expect(params.get("max_age")).toBe("0");
    // A reauth with a different Google account is refused.
    const wrong = await googleSignIn(identityFor(spareEmail()), { query: "?intent=reauth&return=/settings/mcp", headers: { Cookie: session } });
    expect(wrong.location).toBe("/settings/mcp#google-error=reauth_mismatch");
    // An old or missing auth_time is not a re-authentication.
    const stale = await googleSignIn(identity, { query: "?intent=reauth&return=/settings/mcp", headers: { Cookie: session }, tweaks: { claims: { auth_time: Math.floor(Date.now() / 1000) - 600 } } });
    expect(stale.location).toBe("/settings/mcp#google-error=reauth_stale");
    const missing = await googleSignIn(identity, { query: "?intent=reauth&return=/settings/mcp", headers: { Cookie: session }, tweaks: { claims: { auth_time: undefined } } });
    expect(missing.location).toBe("/settings/mcp#google-error=reauth_stale");
    const confirmed = await googleSignIn(identity, { query: "?intent=reauth&return=/settings/mcp", headers: { Cookie: session } });
    expect(confirmed.location).toBe("/settings/mcp#google=reauthed");
    expect(confirmed.session).toBeNull();
    account = await (await fetch(`${origin}/api/auth/account`, { headers: { Cookie: session } })).json() as typeof account;
    expect(account.reauthUntil).not.toBeNull();
    expect((await createKey(session, csrf)).status).toBe(201);
    // Another session of the same account is not confirmed.
    const other = (await googleSignIn(identity)).session!;
    expect((await createKey(other, (await me(other)).body.csrfToken)).status).toBe(401);
    // Five minutes later it no longer counts.
    db.query("UPDATE sessions SET reauth_at = ? WHERE reauth_at IS NOT NULL").run(new Date(Date.now() - 6 * 60_000).toISOString());
    expect((await createKey(session, csrf)).status).toBe(401);
    // Reauth without a session goes to sign in.
    expect((await start("?intent=reauth")).location).toBe("/login#error=expired");
  });

  test("MEDIUM-2 repro: an account with a password must give it, even right after a Google confirmation", async () => {
    const person = await createUser("Password and Google");
    verify(person);
    const identity = workspace(person.email);
    expect((await googleSignIn(identity)).session).toBeTruthy();
    const confirmed = await googleSignIn(identity, { query: "?intent=reauth&return=/settings/security", headers: { Cookie: person.cookie } });
    expect(confirmed.location).toBe("/settings/security#google=reauthed");
    const setup = await request("/auth/totp/setup", { method: "POST", body: "{}" }, person);
    expect(setup.status).toBe(400);
    expect((await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "k", scopes: ["notes:read"] }) }, person)).status).toBe(401);
    expect((await request("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: person.password }) }, person)).status).toBe(200);
  });

  test("Settings links Google only after re-authentication, for the same address, and unlinks with the password (L3)", async () => {
    const person = await createUser("Settings linker");
    const link = (body: unknown) => request("/auth/google/link", { method: "POST", body: JSON.stringify(body) }, person);
    expect((await link({})).status).toBe(401);
    expect((await link({ password: "wrong password here" })).status).toBe(401);
    // Starting a link without the re-authenticated hand-off goes nowhere.
    expect((await start("?intent=link", { Cookie: person.cookie })).location).toBe("/settings/security#google-error=expired");
    const linkWith = async (identity: FakeIdentity) => {
      const prepared = await link({ password: person.password });
      expect(prepared.status).toBe(200);
      expect((await prepared.json() as { start: string }).start).toBe("/api/auth/google/start?intent=link");
      return googleSignIn(identity, { query: "?intent=link", headers: { Cookie: `${person.cookie}; ${cookieOf(prepared, "nook_google_flow")}` } });
    };
    expect((await linkWith(identityFor(spareEmail()))).location).toBe("/settings/security#google-error=link_mismatch");
    // A consumer Google account for the address is fine here: the signed-in owner proved the password.
    const linked = await linkWith(identityFor(person.email));
    expect(linked.location).toBe("/settings/security#google=linked");
    expect((await me(person.cookie)).status).toBe(200);
    expect(userRow(person.email)!.email_verified_at).not.toBeNull();
    expect((await link({ password: person.password })).status).toBe(409);
    await avatarWorkSettled();
    expect(userRow(person.email)!.avatar_id).not.toBeNull();
    expect((await request("/auth/google", { method: "DELETE", body: "{}" }, person)).status).toBe(401);
    const unlink = await request("/auth/google", { method: "DELETE", body: JSON.stringify({ password: person.password }) }, person);
    expect(unlink.status).toBe(200);
    expect(db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(person.userId)).toBeNull();
    expect(userRow(person.email)!.avatar_id).toBeNull();
    // A Google-only account cannot unlink its only way in.
    const googleOnly = await googleSignIn(identityFor(spareEmail()));
    const csrf = (await me(googleOnly.session)).body.csrfToken;
    const refused = await fetch(`${origin}/api/auth/google`, { method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json", Cookie: googleOnly.session!, "X-CSRF-Token": csrf }, body: "{}" });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { code: string }).code).toBe("PASSWORD_REQUIRED");
  });
});

describe("review LOW fixes", () => {
  test("L1: a token that is not valid yet (nbf) is refused", async () => {
    const email = spareEmail();
    const result = await googleSignIn(identityFor(email), { tweaks: { claims: { nbf: Math.floor(Date.now() / 1000) + 600 } } });
    expect(result.location).toBe("/login#error=failed");
    expect(userRow(email)).toBeNull();
  });

  test("L4: one client holds at most 10 live flows; the per-client bucket is checked first", async () => {
    for (let index = 0; index < 10; index += 1) expect((await start()).response.status).toBe(302);
    expect((await start()).location).toBe("/login#error=rate_limited");
  });

  test("L7: /api/about offers no password reset in google mode", async () => {
    const mail = await import("../server/mail");
    mail.setMailTransportForTests(async () => ({ id: "msg" }));
    try {
      expect((await (await request("/about")).json() as { passwordReset: boolean }).passwordReset).toBe(true);
      config.auth.methods = "google";
      expect((await (await request("/about")).json() as { passwordReset: boolean }).passwordReset).toBe(false);
    } finally {
      mail.setMailTransportForTests(null);
    }
  });

  test("U7: Use another account ends the pending two-factor step on the server", async () => {
    const person = await createUser("Cancel two-factor");
    verify(person);
    await enableTotpFor(person);
    const result = await googleSignIn(workspace(person.email));
    expect(result.location).toBe("/login#google=code");
    const flow = cookieOf(result.response, "nook_google_flow")!;
    const cancel = await fetch(`${origin}/api/auth/google/cancel`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: flow }, body: "{}" });
    expect(cancel.status).toBe(200);
    const after = await fetch(`${origin}/api/auth/google/second-factor`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: flow }, body: JSON.stringify({ totpCode: "123456" }) });
    expect((await after.json() as { code: string }).code).toBe("FLOW_EXPIRED");
  });

  test("U9: when Google reports no picture on a later sign-in, the stored avatar goes", async () => {
    const email = spareEmail();
    const identity = identityFor(email);
    await googleSignIn(identity);
    await avatarWorkSettled();
    const avatarId = userRow(email)!.avatar_id as string;
    expect(avatarId).toBeTruthy();
    const again = await googleSignIn({ ...identity, picture: null });
    await avatarWorkSettled();
    expect(userRow(email)!.avatar_id).toBeNull();
    expect(existsSync(join(dataDir, "avatars", avatarId))).toBe(false);
    expect((await me(again.session)).body.user.avatarUrl).toBeNull();
  });

  test("U10: a password attempt on a Google-only account keeps the generic answer", async () => {
    const email = spareEmail();
    await googleSignIn(identityFor(email));
    const response = await passwordLogin(email, "some long password here");
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe("Invalid email or password");
  });

  test("U4: card comments in web payloads carry the author's picture", async () => {
    const email = spareEmail();
    const signedIn = await googleSignIn(identityFor(email));
    await avatarWorkSettled();
    const cookie = signedIn.session!;
    const csrf = (await me(cookie)).body.csrfToken;
    const send = (path: string, body: unknown) => fetch(`${origin}/api/tasks${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: JSON.stringify(body) }).then((response) => response.json() as Promise<Record<string, any>>);
    const board = await send("/boards", { name: "Avatars" });
    const boardId = (board.board ?? board).id as string;
    const detail = await (await fetch(`${origin}/api/tasks/boards/${boardId}`, { headers: { Cookie: cookie } })).json() as { columns: Array<{ id: string }> };
    const card = await send(`/boards/${boardId}/cards`, { title: "Pictured", columnId: detail.columns[0]!.id });
    const cardId = (card.card ?? card).id as string;
    await send(`/cards/${cardId}/comments`, { body: "Hello" });
    const loaded = await (await fetch(`${origin}/api/tasks/cards/${cardId}`, { headers: { Cookie: cookie } })).json() as { comments: Array<{ author_avatar_url: string | null }> };
    expect(loaded.comments[0]!.author_avatar_url).toBe((await me(cookie)).body.user.avatarUrl);
  });

  test("L9: a callback with a junk state leaves the in-progress flow alone", async () => {
    const started = await start();
    const junk = await fetch(`${origin}/api/auth/google/callback?code=x&state=junk`, { redirect: "manual", headers: { Cookie: started.flowCookie! } });
    expect(junk.headers.get("location")).toBe("/login#error=expired");
    expect(junk.headers.getSetCookie().some((value) => value.startsWith("nook_google_flow="))).toBe(false);
    const real = await fetch(fake.authorize(started.location, identityFor(spareEmail())), { redirect: "manual", headers: { Cookie: started.flowCookie! } });
    expect(cookieOf(real, "mynotes_session")).toBeTruthy();
  });
});

describe("avatars (D299, T257, T262)", () => {
  test("the picture is downloaded, served same-origin with safe headers, and refreshed when it changes", async () => {
    const email = spareEmail();
    const identity = identityFor(email);
    const signedIn = await googleSignIn(identity);
    await avatarWorkSettled();
    const url = (await me(signedIn.session)).body.user.avatarUrl!;
    expect(url).toMatch(/^\/api\/users\/[0-9a-f-]{36}\/avatar\?v=[0-9a-f-]{36}$/);
    const image = await fetch(`${origin}${url}`, { headers: { Cookie: signedIn.session! } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("private, max-age=86400");
    const etag = image.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await fetch(`${origin}${url}`, { headers: { Cookie: signedIn.session!, "If-None-Match": etag } })).status).toBe(304);
    // Any signed-in person with the URL may load it; nobody without a session; an old or guessed v is 404.
    const viewer = await createUser("Avatar viewer");
    expect((await fetch(`${origin}${url}`, { headers: { Cookie: viewer.cookie } })).status).toBe(200);
    expect((await fetch(`${origin}${url}`)).status).toBe(401);
    expect((await fetch(`${origin}${url.replace(/v=.*/, `v=${crypto.randomUUID()}`)}`, { headers: { Cookie: viewer.cookie } })).status).toBe(404);
    const before = fake.stats().avatarRequests;
    await googleSignIn(identity);
    await avatarWorkSettled();
    expect(fake.stats().avatarRequests).toBe(before);
    const oldId = userRow(email)!.avatar_id as string;
    await googleSignIn({ ...identity, picture: fake.avatarUrl("changed.png") });
    await avatarWorkSettled();
    const newId = userRow(email)!.avatar_id as string;
    expect(newId).not.toBe(oldId);
    expect(existsSync(join(dataDir, "avatars", oldId))).toBe(false);
    expect(existsSync(join(dataDir, "avatars", newId))).toBe(true);
    expect((await fetch(`${origin}${url}`, { headers: { Cookie: viewer.cookie } })).status).toBe(404);
    // The team list, the share picker, and the Access sheet carry the URL beside the name.
    const member = await (await request(`/team/${userRow(email)!.id}`, {}, viewer)).json() as { member: { avatarUrl: string | null } };
    expect(member.member.avatarUrl).toBe(`/api/users/${userRow(email)!.id}/avatar?v=${newId}`);
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(viewer.userId);
    const picker = await (await request("/users", {}, viewer)).json() as { users: Array<{ id: string; avatarUrl: string | null }> };
    expect(picker.users.length).toBeGreaterThan(0);
    for (const person of picker.users) expect(person.avatarUrl === null || person.avatarUrl.startsWith(`/api/users/${person.id}/avatar?v=`)).toBe(true);
  });

  test("fetch limits: host, scheme, redirects, size, and type; a failure never fails the sign-in", async () => {
    const { fetchAvatar, isAllowedAvatarUrl, AVATAR_MAX_BYTES } = await import("../server/avatars");
    const other = fake.url.replace("localhost", "127.0.0.1");
    expect(isAllowedAvatarUrl(fake.avatarUrl("a.png"))).toBe(true);
    expect(isAllowedAvatarUrl(`${other}/avatar/a.png`)).toBe(false);
    expect(isAllowedAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedAvatarUrl(fake.avatarUrl("a.png").replace("http://", "http://user:pw@"))).toBe(false);
    fake.setAvatar("big.png", { body: new Uint8Array(AVATAR_MAX_BYTES + 1).fill(0x89) });
    fake.setAvatar("svg.png", { body: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", headers: { "Content-Type": "image/png" } });
    fake.setAvatar("html.png", { body: "<html><script>alert(1)</script></html>", headers: { "Content-Type": "image/png" } });
    fake.setAvatar("away.png", { status: 302, headers: { Location: `${other}/avatar/a.png` } });
    fake.setAvatar("hop.png", { status: 302, headers: { Location: fake.avatarUrl("a.png") } });
    fake.setAvatar("gone.png", { status: 404, body: "no" });
    expect(await fetchAvatar(fake.avatarUrl("big.png"))).toEqual({ ok: false, reason: "size" });
    expect(await fetchAvatar(fake.avatarUrl("svg.png"))).toEqual({ ok: false, reason: "type" });
    expect(await fetchAvatar(fake.avatarUrl("html.png"))).toEqual({ ok: false, reason: "type" });
    expect(await fetchAvatar(fake.avatarUrl("away.png"))).toEqual({ ok: false, reason: "redirect" });
    expect(await fetchAvatar(`${other}/avatar/a.png`)).toEqual({ ok: false, reason: "url" });
    expect(await fetchAvatar(fake.avatarUrl("gone.png"))).toEqual({ ok: false, reason: "status" });
    expect((await fetchAvatar(fake.avatarUrl("hop.png"))).ok).toBe(true);
    // Production rules: https on *.googleusercontent.com only.
    const endpoints = config.auth.google.endpoints;
    config.auth.google.endpoints = googleEndpoints(null);
    expect(isAllowedAvatarUrl("https://lh3.googleusercontent.com/a/x=s96-c")).toBe(true);
    expect(isAllowedAvatarUrl("http://lh3.googleusercontent.com/a/x")).toBe(false);
    expect(isAllowedAvatarUrl("https://googleusercontent.com.evil.test/a")).toBe(false);
    expect(isAllowedAvatarUrl("https://evil.test/googleusercontent.com")).toBe(false);
    expect(isAllowedAvatarUrl("https://lh3.googleusercontent.com:8443/a")).toBe(false);
    config.auth.google.endpoints = endpoints;
    const email = spareEmail();
    const result = await googleSignIn(identityFor(email, { picture: fake.avatarUrl("svg.png") }));
    await avatarWorkSettled();
    expect(result.session).toBeTruthy();
    expect(userRow(email)!.avatar_id).toBeNull();
    expect((await me(result.session)).body.user.avatarUrl).toBeNull();
  });

  test("the sweep removes avatar files no account points at", async () => {
    const { sweepAvatarFiles, avatarDir } = await import("../server/avatars");
    const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    mkdirSync(avatarDir(), { recursive: true });
    const orphan = crypto.randomUUID();
    writeFileSync(join(avatarDir(), orphan), "x");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(avatarDir(), orphan), old, old);
    const fresh = crypto.randomUUID();
    writeFileSync(join(avatarDir(), fresh), "x");
    await sweepAvatarFiles();
    expect(existsSync(join(avatarDir(), orphan))).toBe(false);
    expect(existsSync(join(avatarDir(), fresh))).toBe(true);
  });
});
