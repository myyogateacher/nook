import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "./auth";
import { audit, db, now } from "./db";
import { notifyAccess } from "./access/notices";
import { mailNewSignIn, startWelcomeMail } from "./mail/signInMail";
import { kickMailDispatch } from "./mail/dispatcher";
import { deviceFamilies, deviceLabel, type BrowserFamily, type OsFamily, type SignInMethod } from "./deviceLabels";
import { logger } from "./log";

const slog = logger("auth");

export { deviceFamilies, deviceLabel, deviceLabelFromCode, SIGN_IN_METHODS, type SignInMethod } from "./deviceLabels";

/**
 * Recognised devices (outbound email plan #9 and §A.3, as built; migration 044, T327–T331).
 *
 * A browser that signs in gets a random device cookie (`mynotes_device`: 32 random bytes,
 * base64url, HttpOnly, SameSite=Lax, Secure on https, 400 days). For each account that signs in
 * there, the server keeps only SHA-256("device:" + user id + ":" + cookie), a browser family and an
 * OS family from a fixed list (never the User-Agent string), and first-seen and last-seen times. No
 * IP address is stored or mailed. A sign-in whose cookie has no row for the account is a new device:
 * the account gets a bell notice and a "New sign-in" security mail (at most one per 10 minutes),
 * except on the sign-in that creates the account. Clearing cookies makes the browser new again,
 * which is accepted: the mail is a calm signal, not a control. At most 20 devices per account; the
 * least recently seen are forgotten first. Forgetting a device signs nothing out.
 */

export const DEVICE_COOKIE = "mynotes_device";
/** Chrome caps cookie lifetimes at 400 days; the others accept it. */
export const DEVICE_COOKIE_MAX_AGE = 400 * 86_400;
export const MAX_DEVICES = 20;
/** last_seen_at moves at most this often on ordinary requests (a sign-in always moves it). */
export const DEVICE_TOUCH_MS = 3_600_000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** What a sign-in says about itself: how it happened, and whether it is the one that created the account. */
export type SignInContext = { method: SignInMethod; registered?: boolean };

export const deviceHash = (userId: string, token: string) => createHash("sha256").update(`device:${userId}:${token}`).digest("hex");

function readDeviceCookie(c: Context) {
  const value = getCookie(c, DEVICE_COOKIE);
  return value && COOKIE_VALUE.test(value) ? value : null;
}

function writeDeviceCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, DEVICE_COOKIE, token, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: DEVICE_COOKIE_MAX_AGE });
}

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Keeps the MAX_DEVICES most recently seen devices of an account. */
function prune(userId: string) {
  return db.query(`DELETE FROM sign_in_devices WHERE user_id = ? AND id NOT IN (
      SELECT id FROM sign_in_devices WHERE user_id = ? ORDER BY last_seen_at DESC, first_seen_at DESC LIMIT ?)`).run(userId, userId, MAX_DEVICES).changes;
}

function insertDevice(userId: string, token: string, families: { browser: BrowserFamily; os: OsFamily }, at: string, ifMissing = false) {
  db.query(`INSERT ${ifMissing ? "OR IGNORE " : ""}INTO sign_in_devices (id, user_id, token_hash, browser, os, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), userId, deviceHash(userId, token), families.browser, families.os, at, at);
  prune(userId);
}

/**
 * Called by createSession right after the session cookie is set, for every sign-in (password,
 * Google, or the two-factor step that completes either). Records or refreshes the device, and for a
 * device the account has not used: the bell notice and the "New sign-in" mail, unless this sign-in
 * created the account. Also starts the welcome mail on an account's first sign-in. Never throws: a
 * device problem must not fail a sign-in.
 */
export function recordSignIn(c: Context, userId: string, signIn: SignInContext, secure: boolean) {
  try {
    const existing = readDeviceCookie(c);
    const token = existing ?? newToken();
    // A browser keeps one device cookie for every account signed in there; each account hashes it with its own id.
    writeDeviceCookie(c, token, secure);
    const families = deviceFamilies(c.req.header("User-Agent"));
    const at = now();
    const isNew = db.transaction(() => {
      const known = existing ? db.query("UPDATE sign_in_devices SET last_seen_at = ?, browser = ?, os = ? WHERE user_id = ? AND token_hash = ?")
        .run(at, families.browser, families.os, userId, deviceHash(userId, existing)).changes === 1 : false;
      if (known) return false;
      // An account from before migration 044 with no device yet (its session expired, or this is its
      // usual second browser): the first device is its baseline, recorded without a notice or mail.
      const baseline = db.query("UPDATE users SET device_baseline = 0 WHERE id = ? AND device_baseline = 1").run(userId).changes === 1
        && !db.query("SELECT 1 FROM sign_in_devices WHERE user_id = ? LIMIT 1").get(userId);
      insertDevice(userId, token, families, at);
      if (signIn.registered || baseline) return false;
      // The bell, so people without email see it too (outbound email plan #9 as built).
      notifyAccess({ userId, kind: "new_sign_in", actorId: null, resource: { kind: "device", id: `${families.browser}:${families.os}` } }, at);
      return true;
    })();
    // Queued (or joined) and then sent on the next tick, like the other security mail. Coalescing still
    // holds: once one is sent, the next new device waits 10 minutes after it (not_before) and later
    // ones within that wait merge into the same queued row, so a kick cannot send a second one early.
    if (isNew && mailNewSignIn(userId, { browser: families.browser, os: families.os, method: signIn.method, at })) kickMailDispatch();
    startWelcomeMail(userId);
  } catch (error) {
    slog.error(`Sign-in device record failed`, error);
  }
}

/**
 * Once per authenticated request (from requireAuth): moves the device's last-seen time at most hourly,
 * and quietly enrols the browser of a session that was signed in before devices were recorded
 * (`sessions.legacy_device`, migration 044), so the next sign-in there is not "new". A session made
 * since then never enrols itself: only a sign-in records a device. Never throws.
 */
export function touchDevice(c: Context, userId: string, session: { id: string; legacyDevice: boolean }, secure: boolean) {
  try {
    const token = readDeviceCookie(c);
    if (token) {
      // A read first: the write (and its lock) happens at most hourly per device, not on every request.
      const hash = deviceHash(userId, token);
      const seen = db.query("SELECT id, last_seen_at FROM sign_in_devices WHERE user_id = ? AND token_hash = ?").get(userId, hash) as { id: string; last_seen_at: string } | null;
      if (seen && Date.parse(seen.last_seen_at) < Date.now() - DEVICE_TOUCH_MS) {
        db.query("UPDATE sign_in_devices SET last_seen_at = ? WHERE id = ? AND last_seen_at = ?").run(now(), seen.id, seen.last_seen_at);
      }
    }
    if (!session.legacyDevice) return;
    db.transaction(() => {
      const families = deviceFamilies(c.req.header("User-Agent"));
      if (!token) {
        const fresh = newToken();
        insertDevice(userId, fresh, families, now());
        writeDeviceCookie(c, fresh, secure);
      } else {
        // The browser already has a cookie (another account signed in here, or this one forgot it):
        // this account's own row for it, unless it has one.
        insertDevice(userId, token, families, now(), true);
      }
      db.query("UPDATE sessions SET legacy_device = 0 WHERE id = ?").run(session.id);
      // Its baseline is set (migration 044): a later sign-in from another browser is new.
      db.query("UPDATE users SET device_baseline = 0 WHERE id = ? AND device_baseline = 1").run(userId);
    })();
  } catch (error) {
    slog.error(`Device touch failed`, error);
  }
}

export type DeviceView = { id: string; label: string; browser: string; os: string; firstSeenAt: string; lastSeenAt: string; current: boolean };

/** The account's recognised devices, most recently seen first; `current` marks this browser's. */
export function listDevices(c: Context, userId: string): DeviceView[] {
  const token = readDeviceCookie(c);
  const currentHash = token ? deviceHash(userId, token) : null;
  const rows = db.query("SELECT id, token_hash, browser, os, first_seen_at, last_seen_at FROM sign_in_devices WHERE user_id = ? ORDER BY last_seen_at DESC, first_seen_at DESC LIMIT ?")
    .all(userId, MAX_DEVICES) as Array<{ id: string; token_hash: string; browser: string; os: string; first_seen_at: string; last_seen_at: string }>;
  return rows.map((row) => ({
    id: row.id, label: deviceLabel(row.browser, row.os), browser: row.browser, os: row.os,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, current: row.token_hash === currentHash
  }));
}

/** Forgets one device (or all of them). Sessions are untouched. Returns how many rows went. */
export function forgetDevices(userId: string, deviceId: string | null) {
  return db.transaction(() => {
    const removed = deviceId === null
      ? db.query("DELETE FROM sign_in_devices WHERE user_id = ?").run(userId).changes
      : db.query("DELETE FROM sign_in_devices WHERE user_id = ? AND id = ?").run(userId, deviceId).changes;
    if (removed > 0) audit(userId, null, deviceId === null ? "auth.devices_forgotten" : "auth.device_forgotten", { count: removed });
    return removed;
  })();
}

/** Clears an account's devices: a block and a Google reset or re-link start the list over. Call inside their transaction. */
export const clearDevices = (userId: string) => db.query("DELETE FROM sign_in_devices WHERE user_id = ?").run(userId).changes;

const deviceId = z.string().uuid();

/** Settings → Security → Recognised devices (session only, every role: the write gate allowlists the deletes). */
export function registerDeviceRoutes(app: Hono<AppEnv>) {
  app.get("/api/auth/devices", (c) => c.json({ devices: listDevices(c, c.get("user").id), max: MAX_DEVICES }));
  app.delete("/api/auth/devices/:id", (c) => {
    const parsed = deviceId.safeParse(c.req.param("id"));
    if (!parsed.success || forgetDevices(c.get("user").id, parsed.data.toLowerCase()) === 0) return c.json({ error: "Device not found" }, 404);
    return c.json({ ok: true });
  });
  app.delete("/api/auth/devices", (c) => c.json({ ok: true, forgotten: forgetDevices(c.get("user").id, null) }));
}
