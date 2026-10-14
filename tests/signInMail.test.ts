import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createUser, db, request, spareEmail, type Session } from "./support/harness";
import { PROBE_TIMEOUT_MS, runProbe } from "./support/probe";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { deviceFamilies, deviceLabel, deviceLabelFromCode, MAX_DEVICES } = await import("../server/signInDevices");
const { createAccount } = await import("../server/accounts");
const { releaseWelcomeMail, startWelcomeMail, mailNewSignIn, NEW_SIGN_IN_GAP_MS, WELCOME_DELAY_MS } = await import("../server/mail/signInMail");
const { config } = await import("../server/config");
const { runMigrations } = await import("../server/migrations");

/**
 * The outbound email plan's "later" items (#9 New sign-in, #14 Welcome; migration 044): device
 * recognition (cookie, hash, cap, Forget), the new-sign-in mail and its 10-minute coalescing, the bell
 * notice, the welcome mail (once, a minute later, verified only, APP_NAME, never for older accounts),
 * and the gates (email off, unverified, integrations, the registration sign-in). Mail goes through the
 * file transport (MAIL_TRANSPORT=file's writer) into a scratch file; the restart case runs as a
 * separate process with MAIL_TRANSPORT=file (tests/support/welcomeRestartProbe.ts).
 */

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

const scratch = mkdtempSync(join(tmpdir(), "mynotes-signin-mail-"));
const mailFile = join(scratch, "mail.json");
type Filed = { to: string; subject: string; text: string; html: string };
const filed = (): Filed[] => existsSync(mailFile) ? JSON.parse(readFileSync(mailFile, "utf8")) as Filed[] : [];

beforeEach(() => {
  rmSync(mailFile, { force: true });
  mail.resetMailLimits();
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(mail.fileTransport(mailFile));
});
afterEach(() => mail.setMailTransportForTests(null));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function person(label: string, verified = true) {
  const session = await createUser(label);
  if (verified) db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}

type SignedIn = { status: number; device: string | null; session: string | null; setCookies: string[] };
async function signIn(who: Pick<Session, "email" | "password">, options: { device?: string | null; ua?: string } = {}): Promise<SignedIn> {
  const headers: Record<string, string> = { "User-Agent": options.ua ?? FIREFOX_LINUX };
  if (options.device) headers.Cookie = `mynotes_device=${options.device}`;
  const response = await request("/auth/login", { method: "POST", headers, body: JSON.stringify({ email: who.email, password: who.password }) });
  const setCookies = response.headers.getSetCookie();
  const value = (name: string) => setCookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(";", 1)[0]!.slice(name.length + 1) ?? null;
  return { status: response.status, device: value("mynotes_device"), session: value("mynotes_session"), setCookies };
}

const devices = (userId: string) => db.query("SELECT * FROM sign_in_devices WHERE user_id = ? ORDER BY last_seen_at DESC").all(userId) as Array<Record<string, string>>;
const notices = (userId: string) => db.query("SELECT kind, resource_kind, resource_id FROM access_notices WHERE user_id = ? AND kind = 'new_sign_in' ORDER BY created_at, rowid").all(userId) as Array<{ kind: string; resource_kind: string; resource_id: string }>;
const rows = (userId: string, template = "security.new_sign_in") => db.query("SELECT id, status, payload, not_before, skip_reason FROM mail_outbox WHERE user_id = ? AND template = ? ORDER BY created_at").all(userId, template) as Array<{ id: string; status: string; payload: string; not_before: string; skip_reason: string | null }>;
const hash = (userId: string, token: string) => createHash("sha256").update(`device:${userId}:${token}`).digest("hex");

describe("device families and labels (never the User-Agent string)", () => {
  test("browser and OS families map to fixed labels", () => {
    expect(deviceFamilies(FIREFOX_LINUX)).toEqual({ browser: "firefox", os: "linux" });
    expect(deviceFamilies(CHROME_WINDOWS)).toEqual({ browser: "chrome", os: "windows" });
    expect(deviceFamilies(SAFARI_IOS)).toEqual({ browser: "safari", os: "ios" });
    expect(deviceFamilies("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0")).toEqual({ browser: "edge", os: "windows" });
    expect(deviceFamilies("Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36")).toEqual({ browser: "samsung", os: "android" });
    expect(deviceFamilies("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15")).toEqual({ browser: "safari", os: "macos" });
    expect(deviceFamilies("curl/8.5.0")).toEqual({ browser: "other", os: "other" });
    expect(deviceFamilies(undefined)).toEqual({ browser: "other", os: "other" });
    expect(deviceLabel("firefox", "linux")).toBe("Firefox on Linux");
    expect(deviceLabel("firefox", "other")).toBe("Firefox");
    expect(deviceLabel("other", "linux")).toBe("Browser on Linux");
    expect(deviceLabel("other", "other")).toBe("Unknown device");
    // Anything outside the lists falls back, so stored text can never reach a label.
    expect(deviceLabel("<script>", "x")).toBe("Unknown device");
    expect(deviceLabelFromCode("chrome:windows")).toBe("Chrome on Windows");
    expect(deviceLabelFromCode(null)).toBe("Unknown device");
  });

  test("headless Chrome counts as Chrome, and the stored code stays a fixed pair", () => {
    const headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.85 Safari/537.36";
    const families = deviceFamilies(headless);
    expect(families).toEqual({ browser: "chrome", os: "linux" });
    expect(deviceLabel(families.browser, families.os)).toBe("Chrome on Linux");
    expect(`${families.browser}:${families.os}`).toBe("chrome:linux");
    // A word that merely ends in "Chrome/" is not a browser token.
    expect(deviceFamilies("Mozilla/5.0 (X11; Linux x86_64) NotChrome/1.0").browser).toBe("other");
  });
});

describe("recognition: cookie, hash, new vs known", () => {
  test("a sign-in sets an HttpOnly, SameSite=Lax device cookie after the session cookie and stores only its per-account hash", async () => {
    const who = await person("Device cookie");
    const first = await signIn(who);
    expect(first.status).toBe(200);
    expect(first.setCookies[0]!.startsWith("mynotes_session=")).toBe(true);
    const cookie = first.setCookies.find((item) => item.startsWith("mynotes_device="))!;
    expect(first.device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${400 * 86_400}`);
    // http here (COOKIE_SECURE=false); Secure is set when the origin is https.
    expect(cookie).not.toContain("Secure");
    const stored = devices(who.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).toBe(hash(who.userId, first.device!));
    expect(stored[0]!.token_hash).not.toContain(first.device!);
    expect({ browser: stored[0]!.browser, os: stored[0]!.os }).toEqual({ browser: "firefox", os: "linux" });
    // No column keeps the User-Agent or an address.
    expect(Object.keys(stored[0]!).sort()).toEqual(["browser", "first_seen_at", "id", "last_seen_at", "os", "token_hash", "user_id"]);
    expect(JSON.stringify(stored)).not.toContain("Gecko");

    // The same browser again: known, nothing new.
    const again = await signIn(who, { device: first.device });
    expect(again.device).toBe(first.device);
    expect(devices(who.userId)).toHaveLength(1);
    expect(notices(who.userId)).toHaveLength(1);
    expect(rows(who.userId)).toHaveLength(1);
  });

  test("the same browser used by two accounts keeps one cookie and two unrelated hashes", async () => {
    const a = await person("Shared browser A");
    const b = await person("Shared browser B");
    const first = await signIn(a);
    const second = await signIn(b, { device: first.device });
    expect(second.device).toBe(first.device);
    expect(devices(a.userId)[0]!.token_hash).not.toBe(devices(b.userId)[0]!.token_hash);
    expect(devices(b.userId)[0]!.token_hash).toBe(hash(b.userId, first.device!));
  });

  test("a malformed device cookie is replaced", async () => {
    const who = await person("Bad cookie");
    const result = await signIn(who, { device: "not-a-valid-cookie" });
    expect(result.device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(devices(who.userId)[0]!.token_hash).toBe(hash(who.userId, result.device!));
  });
});

describe("the New sign-in mail and the bell", () => {
  test("one mail per new device, coalesced while queued, then at most one per 10 minutes", async () => {
    const who = await person("Coalesce");
    const first = await signIn(who);
    // The bell line, for people without email.
    expect(notices(who.userId)).toEqual([{ kind: "new_sign_in", resource_kind: "device", resource_id: "firefox:linux" }]);
    const bell = await (await request("/notifications", {}, { ...who, cookie: `mynotes_session=${first.session}` })).json() as { items?: Array<{ title: string; href: string }>; notifications?: Array<{ title: string; href: string }> };
    const items = bell.items ?? bell.notifications ?? [];
    expect(items.some((item) => item.title === "New sign-in from Firefox on Linux" && item.href === "/settings/security")).toBe(true);

    // A second new device while the first mail is queued joins it.
    await signIn(who, { ua: CHROME_WINDOWS });
    expect(rows(who.userId)).toHaveLength(1);
    expect(JSON.parse(rows(who.userId)[0]!.payload).total).toBe(2);
    const now = Date.now();
    expect((await runMailDispatch({ nowMs: now + 1000 }))!.sent).toBe(1);
    const sent = filed().filter((item) => item.to === who.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("2 new sign-ins to your Nook account");
    expect(sent[0]!.text).toContain("Chrome on Windows");
    expect(sent[0]!.text).toContain("Firefox on Linux");
    expect(sent[0]!.text).toContain("If this was you, you can ignore this.");
    expect(sent[0]!.text).toContain("Wasn't you? Change your password and sign out other devices");
    expect(sent[0]!.text).toContain("/settings/security");
    expect(sent[0]!.text).toContain("(UTC)");
    expect(sent[0]!.text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::1|localhost:\d+\/api/);

    // A third new device within 10 minutes of the send waits; a fourth joins it.
    await signIn(who, { ua: SAFARI_IOS });
    await signIn(who, { ua: SAFARI_IOS });
    const held = rows(who.userId).filter((row) => row.status === "queued");
    expect(held).toHaveLength(1);
    expect(Date.parse(held[0]!.not_before)).toBeGreaterThanOrEqual(now + NEW_SIGN_IN_GAP_MS - 5_000);
    expect((await runMailDispatch({ nowMs: now + 60_000 }))!.sent).toBe(0);
    expect((await runMailDispatch({ nowMs: now + NEW_SIGN_IN_GAP_MS + 5_000 }))!.sent).toBe(1);
    const later = filed().filter((item) => item.to === who.email);
    expect(later).toHaveLength(2);
    expect(later[1]!.subject).toBe("2 new sign-ins to your Nook account");
    expect(later[1]!.text).toContain("Safari on iOS");
  });

  test("the user's stored time zone is used for the time", async () => {
    const who = await person("Zone");
    db.query("INSERT INTO email_prefs (user_id, tz, updated_at) VALUES (?, 'Europe/Berlin', ?)").run(who.userId, new Date().toISOString());
    await signIn(who);
    await runMailDispatch({ nowMs: Date.now() + 1000 });
    expect(filed().find((item) => item.to === who.email)!.text).toContain("(Europe/Berlin)");
  });

  test("no mail when the address is unverified or email is off, but the bell still shows", async () => {
    const unverified = await person("Unverified sign-in", false);
    await signIn(unverified);
    expect(notices(unverified.userId)).toHaveLength(1);
    expect(rows(unverified.userId)).toHaveLength(0);
    // Verified after it was queued: still skipped at send time if unverified then.
    const flips = await person("Unverified later");
    await signIn(flips);
    db.query("UPDATE users SET email_verified_at = NULL WHERE id = ?").run(flips.userId);
    await runMailDispatch({ nowMs: Date.now() + 1000 });
    expect(rows(flips.userId)[0]).toMatchObject({ status: "skipped", skip_reason: "unverified" });
    expect(filed().some((item) => item.to === flips.email)).toBe(false);

    mail.setMailTransportForTests(null);
    const off = await person("Email off sign-in");
    await signIn(off);
    expect(notices(off.userId)).toHaveLength(1);
    expect(rows(off.userId)).toHaveLength(0);
  });

  test("the sign-in that creates the account sends no New sign-in mail and no notice", async () => {
    const email = spareEmail();
    const response = await request("/auth/register", { method: "POST", headers: { "User-Agent": FIREFOX_LINUX }, body: JSON.stringify({ email, displayName: "Fresh", password: "correct horse battery staple" }) });
    expect(response.status).toBe(201);
    const userId = ((await response.json()) as { user: { id: string } }).user.id;
    expect(response.headers.getSetCookie()[0]!.startsWith("mynotes_session=")).toBe(true);
    expect(devices(userId)).toHaveLength(1);
    expect(notices(userId)).toHaveLength(0);
    expect(rows(userId)).toHaveLength(0);
  });

  test("integrations never sign in, so they get no device, notice, or mail", async () => {
    const admin = await person("Integration admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const created = await request("/team/integrations", { method: "POST", body: JSON.stringify({ name: `Signin bot ${crypto.randomUUID().slice(0, 6)}`, role: "member", description: "CI" }) }, admin);
    expect(created.status).toBe(201);
    const bot = ((await created.json()) as { integration: { id: string } }).integration;
    mailNewSignIn(bot.id, { browser: "firefox", os: "linux", method: "password", at: new Date().toISOString() });
    startWelcomeMail(bot.id);
    expect(rows(bot.id)).toHaveLength(0);
    expect(rows(bot.id, "account.welcome")).toHaveLength(0);
    expect(devices(bot.id)).toHaveLength(0);
  });
});

describe("Recognised devices: list, cap, Forget", () => {
  test("lists newest first with This device, keeps the 20 most recent, and Forget brings the mail back", async () => {
    const who = await person("Device list");
    const old = new Date(Date.now() - 86_400_000);
    for (let index = 0; index < MAX_DEVICES; index += 1) {
      const at = new Date(old.getTime() + index * 1000).toISOString();
      db.query("INSERT INTO sign_in_devices (id, user_id, token_hash, browser, os, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'chrome', 'windows', ?, ?)")
        .run(crypto.randomUUID(), who.userId, hash(who.userId, `old-${index}`), at, at);
    }
    const oldest = devices(who.userId).at(-1)!.id;
    const current = await signIn(who);
    const stored = devices(who.userId);
    expect(stored).toHaveLength(MAX_DEVICES);
    expect(stored.some((row) => row.id === oldest)).toBe(false);
    const session: Session = { ...who, cookie: `mynotes_session=${current.session}; mynotes_device=${current.device}` };
    const me = await request("/auth/me", {}, session);
    const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
    const signedIn = { ...session, csrf };
    const listed = await (await request("/auth/devices", {}, signedIn)).json() as { devices: Array<{ id: string; label: string; current: boolean; firstSeenAt: string; lastSeenAt: string }>; max: number };
    expect(listed.max).toBe(MAX_DEVICES);
    expect(listed.devices).toHaveLength(MAX_DEVICES);
    expect(listed.devices[0]).toMatchObject({ label: "Firefox on Linux", current: true });
    expect(listed.devices.filter((device) => device.current)).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("token");

    // Another account's device is not found; Forget signs nothing out.
    const other = await person("Device other");
    const otherSignIn = await signIn(other);
    const otherDevice = devices(other.userId)[0]!.id;
    expect((await request(`/auth/devices/${otherDevice}`, { method: "DELETE", body: "{}" }, signedIn)).status).toBe(404);
    expect((await request("/auth/devices/not-a-uuid", { method: "DELETE", body: "{}" }, signedIn)).status).toBe(404);
    expect(devices(other.userId)).toHaveLength(1);
    expect(otherSignIn.status).toBe(200);
    expect((await request(`/auth/devices/${listed.devices[0]!.id}`, { method: "DELETE", body: "{}" }, signedIn)).status).toBe(200);
    expect((await request("/auth/me", {}, signedIn)).status).toBe(200);
    expect(devices(who.userId).some((row) => row.token_hash === hash(who.userId, current.device!))).toBe(false);

    // The forgotten browser signs in again: new again, so the bell and the mail come back.
    db.query("DELETE FROM mail_outbox").run();
    const before = notices(who.userId).length;
    await signIn(who, { device: current.device });
    expect(notices(who.userId)).toHaveLength(before + 1);
    expect(rows(who.userId)).toHaveLength(1);

    const all = await request("/auth/devices", { method: "DELETE", body: "{}" }, signedIn);
    expect(((await all.json()) as { forgotten: number }).forgotten).toBe(MAX_DEVICES);
    expect(devices(who.userId)).toHaveLength(0);
    expect((await request("/auth/me", {}, signedIn)).status).toBe(200);
  });

  test("viewers and guests can forget their own devices (write gate allowlist)", async () => {
    const viewer = await person("Device viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    const result = await signIn(viewer);
    const session = { ...viewer, cookie: `mynotes_session=${result.session}` };
    const csrf = ((await (await request("/auth/me", {}, session)).json()) as { csrfToken: string }).csrfToken;
    const id = devices(viewer.userId)[0]!.id;
    expect((await request(`/auth/devices/${id}`, { method: "DELETE", body: "{}" }, { ...session, csrf })).status).toBe(200);
    expect((await request("/auth/devices", { method: "DELETE", body: "{}" }, { ...session, csrf })).status).toBe(200);
  });

  test("an account from before 044 records its first device quietly, once (users.device_baseline)", async () => {
    const existing = await person("Baseline account");
    db.query("UPDATE users SET device_baseline = 1 WHERE id = ?").run(existing.userId);
    // Its pre-044 session expired: the usual browser signs in without a cookie. Quiet, and the flag clears.
    const usual = await signIn(existing);
    expect(devices(existing.userId)).toHaveLength(1);
    expect(devices(existing.userId)[0]!.token_hash).toBe(hash(existing.userId, usual.device!));
    expect(notices(existing.userId)).toHaveLength(0);
    expect(rows(existing.userId)).toHaveLength(0);
    expect((db.query("SELECT device_baseline FROM users WHERE id = ?").get(existing.userId) as { device_baseline: number }).device_baseline).toBe(0);
    // The next unknown browser is new as usual.
    await signIn(existing, { ua: CHROME_WINDOWS });
    expect(notices(existing.userId)).toHaveLength(1);
    expect(rows(existing.userId)).toHaveLength(1);

    // With the flag but a device already recorded (a legacy session enrolled it), an unknown browser is new.
    const enrolled = await person("Baseline enrolled");
    db.query("UPDATE users SET device_baseline = 1 WHERE id = ?").run(enrolled.userId);
    db.query("INSERT INTO sign_in_devices (id, user_id, token_hash, browser, os, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'chrome', 'windows', ?, ?)")
      .run(crypto.randomUUID(), enrolled.userId, hash(enrolled.userId, "enrolled-token"), new Date().toISOString(), new Date().toISOString());
    await signIn(enrolled);
    expect(notices(enrolled.userId)).toHaveLength(1);
    expect(rows(enrolled.userId)).toHaveLength(1);
    expect((db.query("SELECT device_baseline FROM users WHERE id = ?").get(enrolled.userId) as { device_baseline: number }).device_baseline).toBe(0);

    // New accounts never carry the flag: their first sign-in after registration is quiet for its own reason.
    const fresh = await person("Baseline fresh");
    expect((db.query("SELECT device_baseline FROM users WHERE id = ?").get(fresh.userId) as { device_baseline: number }).device_baseline).toBe(0);
    await signIn(fresh);
    expect(notices(fresh.userId)).toHaveLength(1);
  });

  test("last seen moves at most hourly on ordinary requests", async () => {
    const who = await person("Touch hourly");
    const result = await signIn(who);
    const session = { ...who, cookie: `mynotes_session=${result.session}; mynotes_device=${result.device}` };
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("UPDATE sign_in_devices SET last_seen_at = ? WHERE user_id = ?").run(recent, who.userId);
    expect((await request("/auth/me", {}, session)).status).toBe(200);
    expect(devices(who.userId)[0]!.last_seen_at).toBe(recent);
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db.query("UPDATE sign_in_devices SET last_seen_at = ? WHERE user_id = ?").run(old, who.userId);
    expect((await request("/auth/me", {}, session)).status).toBe(200);
    expect(Date.parse(devices(who.userId)[0]!.last_seen_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a block clears the account's devices", async () => {
    const admin = await person("Block admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const target = await person("Block target");
    await signIn(target);
    expect(devices(target.userId)).toHaveLength(1);
    const blocked = await request(`/team/${target.userId}/block`, { method: "POST", body: "{}" }, admin);
    expect(blocked.status).toBe(200);
    expect(devices(target.userId)).toHaveLength(0);
  });

  test("a session from before 044 enrols its browser quietly on its next request; a newer session never does", async () => {
    const legacy = await person("Legacy session");
    db.query("UPDATE sessions SET legacy_device = 1 WHERE user_id = ?").run(legacy.userId);
    const response = await request("/auth/me", { headers: { "User-Agent": CHROME_WINDOWS } }, legacy);
    expect(response.status).toBe(200);
    const token = response.headers.getSetCookie().find((cookie) => cookie.startsWith("mynotes_device="))!.split(";", 1)[0]!.slice("mynotes_device=".length);
    expect(devices(legacy.userId)).toEqual([expect.objectContaining({ token_hash: hash(legacy.userId, token), browser: "chrome", os: "windows" })]);
    expect(notices(legacy.userId)).toHaveLength(0);
    expect(rows(legacy.userId)).toHaveLength(0);
    // Once: the flag is cleared, and the browser now signs in as known.
    expect((db.query("SELECT legacy_device FROM sessions WHERE user_id = ?").get(legacy.userId) as { legacy_device: number }).legacy_device).toBe(0);
    await signIn(legacy, { device: token, ua: CHROME_WINDOWS });
    expect(notices(legacy.userId)).toHaveLength(0);

    // A legacy session in a browser whose cookie another account set: this account gets its own row for it.
    const other = await person("Legacy other");
    const otherSignIn = await signIn(other);
    const shared = await person("Legacy shared browser");
    db.query("UPDATE sessions SET legacy_device = 1 WHERE user_id = ?").run(shared.userId);
    const sharedResponse = await request("/auth/me", { headers: { Cookie: `${shared.cookie}; mynotes_device=${otherSignIn.device}` } }, { ...shared, cookie: `${shared.cookie}; mynotes_device=${otherSignIn.device}` });
    expect(sharedResponse.status).toBe(200);
    expect(sharedResponse.headers.getSetCookie().some((cookie) => cookie.startsWith("mynotes_device="))).toBe(false);
    expect(devices(shared.userId).map((row) => row.token_hash)).toEqual([hash(shared.userId, otherSignIn.device!)]);
    expect(notices(shared.userId)).toHaveLength(0);
    // The same browser then signs in to it as known.
    await signIn(shared, { device: otherSignIn.device });
    expect(notices(shared.userId)).toHaveLength(0);

    const fresh = await person("Fresh session");
    const plain = await request("/auth/me", {}, fresh);
    expect(plain.headers.getSetCookie().some((cookie) => cookie.startsWith("mynotes_device="))).toBe(false);
    expect(devices(fresh.userId)).toHaveLength(0);
  });
});

describe("the Welcome mail", () => {
  async function account(label: string, verified: boolean) {
    const email = spareEmail();
    const password = "correct horse battery staple";
    const { id } = createAccount({ email, displayName: label, passwordHash: await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 }), inviteHash: null, emailVerified: verified });
    return { userId: id, email, password };
  }
  const state = (userId: string) => (db.query("SELECT welcome_mail FROM users WHERE id = ?").get(userId) as { welcome_mail: string | null }).welcome_mail;

  test("sent exactly once, about a minute after the first sign-in, with APP_NAME and three links", async () => {
    const who = await account("Welcome <Dana>", true);
    expect(state(who.userId)).toBe("pending");
    const start = Date.now();
    await signIn(who);
    expect(state(who.userId)).toBe("queued");
    const queued = rows(who.userId, "account.welcome");
    expect(queued).toHaveLength(1);
    expect(Date.parse(queued[0]!.not_before)).toBeGreaterThanOrEqual(start + WELCOME_DELAY_MS);
    // A second sign-in from a new device queues nothing more for the welcome.
    await signIn(who, { ua: CHROME_WINDOWS });
    expect(rows(who.userId, "account.welcome")).toHaveLength(1);
    const before = config.appName;
    config.appName = "Acme Notes";
    try {
      await runMailDispatch({ nowMs: start + 5_000 });
      expect(filed().filter((item) => item.subject.startsWith("Welcome"))).toHaveLength(0);
      await runMailDispatch({ nowMs: start + WELCOME_DELAY_MS + 5_000 });
    } finally {
      config.appName = before;
    }
    const welcome = filed().filter((item) => item.to === who.email && item.subject.startsWith("Welcome"));
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.subject).toBe("Welcome to Acme Notes");
    expect(welcome[0]!.text).toContain("Welcome to Acme Notes, Welcome <Dana>");
    expect(welcome[0]!.html).toContain("Welcome &lt;Dana&gt;");
    expect(welcome[0]!.html).not.toContain("<Dana>");
    expect(welcome[0]!.text).toContain("You joined as a Member.");
    expect(welcome[0]!.text).not.toContain("as a Admin");
    expect(welcome[0]!.text).toContain("/settings/notifications");
    expect(welcome[0]!.text).toContain("https://pankajsoni19.github.io/nook/");
    expect(welcome[0]!.text).not.toContain("Nook");
    // No unsubscribe: it is one-off account mail.
    expect(welcome[0]!.text).not.toContain("/mail/unsubscribe");
    await runMailDispatch({ nowMs: start + 30 * 60_000 });
    expect(filed().filter((item) => item.to === who.email && item.subject.startsWith("Welcome"))).toHaveLength(1);
  });

  test("an unverified address waits, and verifying it queues the welcome", async () => {
    const who = await account("Welcome waits", false);
    await signIn(who);
    expect(state(who.userId)).toBe("waiting");
    expect(rows(who.userId, "account.welcome")).toHaveLength(0);
    db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), who.userId);
    releaseWelcomeMail(who.userId);
    expect(state(who.userId)).toBe("queued");
    expect(rows(who.userId, "account.welcome")).toHaveLength(1);
    releaseWelcomeMail(who.userId);
    expect(rows(who.userId, "account.welcome")).toHaveLength(1);
  });

  test("email off at the first sign-in skips it for good; a stale wait is skipped too", async () => {
    mail.setMailTransportForTests(null);
    const off = await account("Welcome off", true);
    await signIn(off);
    expect(state(off.userId)).toBe("skipped");
    mail.setMailTransportForTests(mail.fileTransport(mailFile));
    await signIn(off, { ua: CHROME_WINDOWS });
    expect(rows(off.userId, "account.welcome")).toHaveLength(0);

    const late = await account("Welcome late", false);
    await signIn(late);
    db.query("UPDATE users SET created_at = ?, email_verified_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), new Date().toISOString(), late.userId);
    releaseWelcomeMail(late.userId);
    expect(state(late.userId)).toBe("skipped");
    expect(rows(late.userId, "account.welcome")).toHaveLength(0);
  });

  test("accounts that existed before (or were made outside registration) never get it", async () => {
    const existing = await person("Welcome existing");
    expect(state(existing.userId)).toBeNull();
    await signIn(existing);
    expect(rows(existing.userId, "account.welcome")).toHaveLength(0);
    expect(state(existing.userId)).toBeNull();
  });
});

describe("migration 044", () => {
  test("adds the devices table and columns: older accounts get no welcome, older sessions enrol quietly, and re-running is a no-op", () => {
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    runMigrations(memory);
    // Back to the 042 shape, with an account and a session from before.
    memory.exec("DROP TABLE sign_in_devices; ALTER TABLE users DROP COLUMN welcome_mail; ALTER TABLE users DROP COLUMN device_baseline; ALTER TABLE sessions DROP COLUMN legacy_device; DELETE FROM schema_migrations WHERE id = 44;");
    const at = "2026-09-01T00:00:00.000Z";
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES ('s1', 'u1', ?, 'c', ?, ?, '2099-01-01T00:00:00.000Z')").run("a".repeat(64), at, at);
    runMigrations(memory);
    expect(memory.query("SELECT welcome_mail, device_baseline FROM users WHERE id = 'u1'").get()).toEqual({ welcome_mail: null, device_baseline: 1 });
    // Accounts made after the migration start without the baseline flag.
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'u2@example.test', 'U2', 'x', ?, 'member')").run(at);
    expect(memory.query("SELECT device_baseline FROM users WHERE id = 'u2'").get()).toEqual({ device_baseline: 0 });
    expect(() => memory.query("UPDATE users SET device_baseline = 2 WHERE id = 'u2'").run()).toThrow();
    memory.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(memory.query("SELECT legacy_device FROM sessions WHERE id = 's1'").get()).toEqual({ legacy_device: 1 });
    memory.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES ('s2', 'u1', ?, 'c', ?, ?, '2099-01-01T00:00:00.000Z')").run("b".repeat(64), at, at);
    expect(memory.query("SELECT legacy_device FROM sessions WHERE id = 's2'").get()).toEqual({ legacy_device: 0 });
    expect(() => memory.query("UPDATE users SET welcome_mail = 'sent' WHERE id = 'u1'").run()).toThrow();
    expect(() => memory.query("INSERT INTO sign_in_devices (id, user_id, token_hash, browser, os, first_seen_at, last_seen_at) VALUES ('d1', 'u1', 'short', 'firefox', 'linux', ?, ?)").run(at, at)).toThrow();
    memory.query("INSERT INTO sign_in_devices (id, user_id, token_hash, browser, os, first_seen_at, last_seen_at) VALUES ('d1', 'u1', ?, 'firefox', 'linux', ?, ?)").run("c".repeat(64), at, at);
    // Devices go with the account.
    memory.query("DELETE FROM sessions WHERE user_id = 'u1'").run();
    memory.query("DELETE FROM users WHERE id = 'u1'").run();
    expect(memory.query("SELECT COUNT(*) AS count FROM sign_in_devices").get()).toEqual({ count: 0 });
    memory.close();
  });
});

describe("the welcome survives a restart (separate processes, MAIL_TRANSPORT=file)", () => {
  test("queued by the first process, sent once by the next, with APP_NAME", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mynotes-welcome-probe-"));
    try {
      const probe = (phase: string) => {
        return runProbe<Record<string, unknown>>("welcomeRestartProbe.ts", [phase, dataDir]);
      };
      const first = probe("queue");
      // Open registration leaves the address unverified: the welcome waits, and verifying queues it. The
      // sign-in after that is from a new device (no cookie jar), so its tick sends the New sign-in mail.
      expect(first).toMatchObject({ registered: 201, afterRegister: "waiting", verified: "verified", signedIn: 200, welcomeMail: "queued", tickSent: 1 });
      expect(first.outbox).toEqual([expect.objectContaining({ template: "account.welcome", status: "queued" })]);
      expect((first.subjects as string[]).some((subject) => subject.startsWith("Welcome"))).toBe(false);
      const second = probe("send");
      expect(second).toMatchObject({ early: 0, due: 1, again: 0, welcomeCount: 1 });
      expect((second.subjects as string[]).filter((subject) => subject === "Welcome to Acme Notes")).toHaveLength(1);
      expect(second.welcomeText).toContain("Probe <b>Person</b>");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT_MS * 2);
});
