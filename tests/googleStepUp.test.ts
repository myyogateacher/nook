/**
 * One re-authentication path for every step-up flow (server/reauth.ts `checkReauth`; THREAT_MODEL
 * MEDIUM-3, operator decision 2026-10-12). The fake Google behaves like real Google: no `auth_time`
 * unless the request asks for it, and `prompt=login` / `max_age` change nothing.
 *
 * - Google alone: API keys (/api/keys and /api/mcp/keys, create and rotate), integration keys, the
 *   vault's protected environments, two-factor setup, linking Google, and setting or changing the password.
 * - Google plus the code (with two-factor on): turning two-factor off, viewing or regenerating recovery
 *   codes, unlinking Google, and the Team admin Google actions. A recovery code stands in for the code.
 * - Password-only accounts: unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, spareEmail, type Session } from "./support/harness";
import { startFakeGoogle, type FakeGoogle, type FakeIdentity, type TokenTweaks } from "./support/fakeGoogle";
import { retireUsersAfterFile } from "./support/retireUsers";
const { config, googleEndpoints } = await import("../server/config");
const { resetJwksCache } = await import("../server/google/oidc");
const { resetRegistrationRateLimit } = await import("../server/authLimits");
const { UNUSABLE_PASSWORD } = await import("../server/passwords");
const { totpCodeAt, totpCounter } = await import("../server/totp");

let fake: FakeGoogle;
retireUsersAfterFile();
const saved = { auth: structuredClone(config.auth), allowRegistration: config.allowRegistration };

beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(() => {
  Object.assign(config.auth, structuredClone(saved.auth));
  config.allowRegistration = saved.allowRegistration;
  resetJwksCache();
  fake.stop();
});
beforeEach(() => {
  config.auth.methods = "both";
  config.auth.google.clientId = fake.clientId;
  config.auth.google.clientSecret = fake.clientSecret;
  config.auth.google.allowedDomains = [];
  config.auth.google.endpoints = googleEndpoints(fake.url);
  resetJwksCache();
  resetRegistrationRateLimit();
  db.query("DELETE FROM google_auth_flows").run();
});

const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? null;
const newSub = () => `sub-${crypto.randomUUID()}`;
const identityFor = (email: string, extra: Partial<FakeIdentity> = {}): FakeIdentity => ({ sub: newSub(), email, name: "Step-up Person", ...extra });

async function start(query: string, cookie: string) {
  const response = await fetch(`${origin}/api/auth/google/start${query}`, { redirect: "manual", headers: { Cookie: cookie } });
  return { location: response.headers.get("location") ?? "", flowCookie: cookieOf(response, "nook_google_flow") };
}

/** Start (with this session), the fake's chooser, and the callback. */
async function reauthRoundTrip(identity: FakeIdentity, cookie: string, tweaks: TokenTweaks = {}) {
  const started = await start("?intent=reauth&return=/settings/keys", cookie);
  // Refused before Google (no linked identity): the start answers with the error itself.
  if (started.location.startsWith("/")) return { callbackUrl: "", flowCookie: "", location: started.location };
  const callbackUrl = fake.authorize(started.location, identity, tweaks);
  const response = await fetch(callbackUrl, { redirect: "manual", headers: { Cookie: started.flowCookie! } });
  return { callbackUrl, flowCookie: started.flowCookie!, location: response.headers.get("location") };
}

async function send(session: Session, method: string, path: string, body: unknown = {}) {
  const response = await request(path, { method, body: JSON.stringify(body) }, session);
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

async function enableTotpFor(session: Session) {
  const setup = await (await request("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: session.password }) }, session)).json() as { secret: string };
  const enabled = await request("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: totpCodeAt(setup.secret, totpCounter() - 1) }) }, session);
  expect(enabled.status).toBe(200);
  return setup.secret;
}

type Linked = { person: Session; identity: FakeIdentity; secret: string | null };
/** A Nook account with Google linked: with or without a password, with or without two-factor. */
async function linkedAccount(options: { password: boolean; totp: boolean }): Promise<Linked> {
  const person = await createUser("Step-up");
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), person.userId);
  const secret = options.totp ? await enableTotpFor(person) : null;
  const identity = identityFor(person.email);
  const at = new Date().toISOString();
  db.query("INSERT INTO google_identities (id, user_id, subject, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), person.userId, identity.sub, person.email, at, at);
  if (!options.password) db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(UNUSABLE_PASSWORD, person.userId);
  return { person, identity, secret };
}

const confirm = (linked: Linked, tweaks: TokenTweaks = {}) => reauthRoundTrip(linked.identity, linked.person.cookie, tweaks);
const REAUTHED = "/settings/keys#google=reauthed";
const confirmedSessions = (userId: string) => (db.query("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND reauth_at IS NOT NULL").get(userId) as { count: number }).count;
const keyBody = { name: "Step-up key", grants: [{ module: "notes", permission: "read" }] };
const code = (linked: Linked, offset = 0) => totpCodeAt(linked.secret!, totpCounter() + offset);
const nowS = () => Math.floor(Date.now() / 1000);

describe("Google step-up (MEDIUM-3, 2026-10-12)", () => {
  test("a stale or missing auth_time confirms; the start asks for the account chooser only", async () => {
    const linked = await linkedAccount({ password: false, totp: false });
    const params = new URL((await start("?intent=reauth", linked.person.cookie)).location).searchParams;
    expect(params.get("prompt")).toBe("select_account");
    expect(params.get("max_age")).toBeNull();
    expect(params.get("login_hint")).toBe(linked.person.email);
    // Missing: Google's default.
    expect((await confirm(linked)).location).toBe(REAUTHED);
    expect(confirmedSessions(linked.person.userId)).toBe(1);
    // Stale: an hour-old Google session.
    db.query("UPDATE sessions SET reauth_at = NULL WHERE user_id = ?").run(linked.person.userId);
    expect((await confirm(linked, { claims: { auth_time: nowS() - 3600 } })).location).toBe(REAUTHED);
    // Fresh still works, with no extra step.
    db.query("UPDATE sessions SET reauth_at = NULL WHERE user_id = ?").run(linked.person.userId);
    expect((await confirm(linked, { claims: { auth_time: nowS() } })).location).toBe(REAUTHED);
    expect((await send(linked.person, "POST", "/keys", keyBody)).status).toBe(201);
    // The audit records how old Google's sign-in was; it is never required.
    const ages = (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'auth.google_reauth' ORDER BY rowid").all(linked.person.userId) as Array<{ metadata_json: string }>).map((row) => JSON.parse(row.metadata_json).authTime);
    expect(ages).toEqual(["missing", "stale", "fresh"]);
  });

  test("a mismatched sub, a replayed callback, and another session's flow confirm nothing", async () => {
    const linked = await linkedAccount({ password: false, totp: false });
    expect((await reauthRoundTrip(identityFor(spareEmail()), linked.person.cookie)).location).toBe("/settings/keys#google-error=reauth_mismatch");
    // The right address on another Google account (another sub) is a mismatch too.
    expect((await reauthRoundTrip({ ...linked.identity, sub: newSub() }, linked.person.cookie)).location).toBe("/settings/keys#google-error=reauth_mismatch");
    expect(confirmedSessions(linked.person.userId)).toBe(0);
    expect((await send(linked.person, "POST", "/keys", keyBody)).body.code).toBe("GOOGLE_REAUTH_REQUIRED");
    // Replay: the same callback (code and state) a second time.
    const first = await confirm(linked);
    expect(first.location).toBe(REAUTHED);
    db.query("UPDATE sessions SET reauth_at = NULL WHERE user_id = ?").run(linked.person.userId);
    const replay = await fetch(first.callbackUrl, { redirect: "manual", headers: { Cookie: first.flowCookie } });
    expect(replay.headers.get("location")).not.toContain("reauthed");
    expect(confirmedSessions(linked.person.userId)).toBe(0);
    // Another account's session cannot use this identity's round trip.
    const other = await createUser("Step-up other");
    expect((await reauthRoundTrip(linked.identity, other.cookie)).location).toBe("/settings/keys#google-error=reauth_mismatch");
    expect(confirmedSessions(other.userId)).toBe(0);
    // A flow whose session ended before the callback confirms nothing.
    const started = await start("?intent=reauth&return=/settings/keys", linked.person.cookie);
    db.query("DELETE FROM sessions WHERE user_id = ?").run(linked.person.userId);
    const late = await fetch(fake.authorize(started.location, linked.identity), { redirect: "manual", headers: { Cookie: started.flowCookie! } });
    expect(late.headers.get("location")).not.toContain("reauthed");
  });

  test("an expired window asks again with GOOGLE_REAUTH_REQUIRED", async () => {
    const linked = await linkedAccount({ password: false, totp: false });
    expect((await confirm(linked)).location).toBe(REAUTHED);
    db.query("UPDATE sessions SET reauth_at = ? WHERE user_id = ?").run(new Date(Date.now() - 6 * 60_000).toISOString(), linked.person.userId);
    const refused = await send(linked.person, "POST", "/keys", keyBody);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("GOOGLE_REAUTH_REQUIRED");
    expect(refused.body.error).toContain("Confirm with Google again");
    expect((await send(linked.person, "POST", "/vault/reauth", {})).body.code).toBe("GOOGLE_REAUTH_REQUIRED");
    expect((await send(linked.person, "POST", "/auth/totp/setup", {})).body.code).toBe("GOOGLE_REAUTH_REQUIRED");
    expect((await confirm(linked)).location).toBe(REAUTHED);
    expect((await send(linked.person, "POST", "/keys", keyBody)).status).toBe(201);
  });

  for (const password of [false, true]) {
    test(`Google alone passes keys, the vault, and the password with two-factor on (${password ? "password and Google" : "Google only"})`, async () => {
      const linked = await linkedAccount({ password, totp: true });
      expect((await send(linked.person, "POST", "/keys", keyBody)).body.code).toBe("GOOGLE_REAUTH_REQUIRED");
      expect((await confirm(linked)).location).toBe(REAUTHED);
      const created = await send(linked.person, "POST", "/keys", keyBody);
      expect(created.status).toBe(201);
      expect((await send(linked.person, "POST", `/keys/${created.body.key.id}/rotate`, { graceHours: 0 })).status).toBe(201);
      expect((await send(linked.person, "POST", "/mcp/keys", { name: "MCP step-up", scopes: ["notes:read"] })).status).toBe(201);
      expect((await send(linked.person, "POST", "/vault/reauth", {})).status).toBe(200);
      // Set (Google only) or change (with a password) the password, with no current password.
      expect((await send(linked.person, "POST", "/auth/password/change", { newPassword: "a brand new long password" })).status).toBe(200);
      // A wrong current password is still refused, even inside the window.
      expect((await send(linked.person, "POST", "/auth/password/change", { currentPassword: "not the password", newPassword: "another new long password", totpCode: code(linked) })).status).toBe(400);
    });
  }

  test("Google alone passes an admin's integration keys", async () => {
    const linked = await linkedAccount({ password: false, totp: true });
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(linked.person.userId);
    const bot = await send(linked.person, "POST", "/team/integrations", { name: `Bot ${crypto.randomUUID().slice(0, 8)}`, role: "member", description: "Step-up" });
    expect(bot.status).toBe(201);
    const keyPath = `/team/integrations/${bot.body.integration.id}/keys`;
    const body = { ...keyBody, surfaces: "rest", expiresInDays: 30 };
    expect((await send(linked.person, "POST", keyPath, body)).body.code).toBe("GOOGLE_REAUTH_REQUIRED");
    expect((await confirm(linked)).location).toBe(REAUTHED);
    const created = await send(linked.person, "POST", keyPath, body);
    expect(created.status).toBe(201);
    expect((await send(linked.person, "POST", `${keyPath}/${created.body.key.id}/rotate`, { graceHours: 0 })).status).toBe(201);
  });

  test("the two-factor actions need the code after Google, and take a recovery code instead", async () => {
    const linked = await linkedAccount({ password: true, totp: true });
    expect((await confirm(linked)).location).toBe(REAUTHED);
    // View: Google alone is not enough; Google and the code are.
    expect((await send(linked.person, "POST", "/auth/totp/recovery-codes", {})).status).toBe(400);
    const viewed = await send(linked.person, "POST", "/auth/totp/recovery-codes", { code: code(linked) });
    expect(viewed.status).toBe(200);
    const codes = viewed.body.recoveryCodes as string[];
    // Regenerate with a recovery code (a lost authenticator).
    const regenerated = await send(linked.person, "POST", "/auth/totp/recovery-codes/regenerate", { recoveryCode: codes[0] });
    expect(regenerated.status).toBe(200);
    const fresh = regenerated.body.recoveryCodes as string[];
    // A replaced recovery code no longer works; a used one works once.
    expect((await send(linked.person, "DELETE", "/auth/totp", { recoveryCode: codes[1] })).status).toBe(400);
    expect((await send(linked.person, "POST", "/auth/totp/recovery-codes", { recoveryCode: fresh[0] })).status).toBe(200);
    expect((await send(linked.person, "POST", "/auth/totp/recovery-codes", { recoveryCode: fresh[0] })).status).toBe(400);
    // Unlink Google: the code too.
    expect((await send(linked.person, "DELETE", "/auth/google", {})).body.code).toBe("TOTP_REQUIRED");
    // Turn two-factor off with Google and a recovery code.
    expect((await send(linked.person, "DELETE", "/auth/totp", {})).status).toBe(400);
    expect((await send(linked.person, "DELETE", "/auth/totp", { recoveryCode: fresh[1] })).status).toBe(200);
    expect((db.query("SELECT totp_enabled_at FROM users WHERE id = ?").get(linked.person.userId) as { totp_enabled_at: string | null }).totp_enabled_at).toBeNull();
    // Off now: unlinking needs Google alone.
    expect((await send(linked.person, "DELETE", "/auth/google", {})).status).toBe(200);
  });

  test("a Google-only account with two-factor turns it off with Google and the code; unlinking stays refused", async () => {
    const linked = await linkedAccount({ password: false, totp: true });
    expect((await send(linked.person, "DELETE", "/auth/totp", { code: code(linked) })).body.code).toBe("GOOGLE_REAUTH_REQUIRED");
    expect((await confirm(linked)).location).toBe(REAUTHED);
    expect((await send(linked.person, "DELETE", "/auth/google", { totpCode: code(linked) })).body.code).toBe("PASSWORD_REQUIRED");
    expect((await send(linked.person, "DELETE", "/auth/totp", { code: code(linked, 1) })).status).toBe(200);
  });

  test("Team admin Google actions need the code after Google when two-factor is on", async () => {
    const linked = await linkedAccount({ password: false, totp: true });
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(linked.person.userId);
    const target = await createUser("Step-up target");
    expect((await confirm(linked)).location).toBe(REAUTHED);
    expect((await send(linked.person, "POST", `/team/${target.userId}/google/allow`, { reset: false })).body.code).toBe("TOTP_REQUIRED");
    expect((await send(linked.person, "POST", `/team/${target.userId}/google/allow`, { reset: false, totpCode: code(linked) })).status).toBe(200);
  });

  test("password-only accounts are unchanged; a lost authenticator turns off with a recovery code", async () => {
    const person = await createUser("Password only step-up");
    expect((await (await request("/auth/account", {}, person)).json() as { reauth: string }).reauth).toBe("password");
    const none = await send(person, "POST", "/keys", keyBody);
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("REAUTH_FAILED");
    expect((await send(person, "POST", "/keys", { ...keyBody, password: person.password })).status).toBe(201);
    const secret = await enableTotpFor(person);
    expect((await send(person, "POST", "/keys", { ...keyBody, password: person.password })).status).toBe(401);
    expect((await send(person, "POST", "/keys", { ...keyBody, password: person.password, totpCode: totpCodeAt(secret, totpCounter()) })).status).toBe(201);
    // No linked identity: a Google round trip is refused.
    expect((await reauthRoundTrip(identityFor(person.email), person.cookie)).location).toBe("/settings/keys#google-error=reauth_mismatch");
    const viewed = await send(person, "POST", "/auth/totp/recovery-codes", { password: person.password, code: totpCodeAt(secret, totpCounter() + 1) });
    expect(viewed.status).toBe(200);
    expect((await send(person, "DELETE", "/auth/totp", { recoveryCode: viewed.body.recoveryCodes[0] })).status).toBe(400);
    expect((await send(person, "DELETE", "/auth/totp", { password: person.password, recoveryCode: viewed.body.recoveryCodes[0] })).status).toBe(200);
  });
});
