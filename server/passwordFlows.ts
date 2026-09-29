import type { Context, Hono } from "hono";
import { clientAddress } from "./clientAddress";
import { z } from "zod";
import type { AppEnv } from "./auth";
import { revokeUserPushSubscriptions } from "./calendar/push";
import { isEmailAllowed, isOriginAllowed } from "./config";
import { audit, db, now, type UserRow } from "./db";
import { addressHash, mailEnabled } from "./mail";
import { kickMailDispatch } from "./mail/dispatcher";
import { enqueueMail } from "./mail/outbox";
import { hashAuthToken } from "./mail/resolve";
import { mailPasswordChanged, mailTwoFactor } from "./mail/triggers";
import { bumpUnsubscribeEpoch } from "./mail/unsubscribe";
import { consumeRecoveryCode, consumeTotp, verifyReauth } from "./reauth";
import { passwordMethodRefusal } from "./authMethods";
import { hashPassword, verifyPassword } from "./passwords";
import { email, parseJson, password, recoveryCode, totpCode } from "./validation";

/**
 * Password flows (Wave 30, E3; docs/plan/research/2026-09-28-outbound-email.md §A.5, §E.6).
 *
 * Public, registered before the session middleware (they check Origin and Content-Type themselves):
 * - POST /api/auth/password-reset/request {email}: always 202 {ok:true}, never sooner than a floor of
 *   ~400 ms plus jitter, and the lookup and enqueue run only after the response is on its way, so
 *   neither the body nor the timing says whether the address has an account (T224). Mail goes only
 *   to an existing, unblocked, verified account on the allowlist. At most 3 an hour per address
 *   (hashed; unknown addresses count too, silently) and 10 an hour per client address (429).
 * - POST /api/auth/password-reset/check {token}: whether the link is live, and only whether a
 *   second-factor code will be needed (§E.6). Nothing changes.
 * - POST /api/auth/password-reset/complete {token, newPassword, totpCode? | recoveryCode?}: sets the
 *   password. When two-factor is on, a code or recovery code is required (T225); five wrong codes
 *   burn the link. Revokes every session and push subscription and every unsubscribe link (the
 *   epoch bump, §B.2), never signs in, sends security mail #12, and audits `auth.password_reset`.
 *   API keys are not revoked; the mail links to them.
 *
 * Signed in: POST /api/auth/password/change {currentPassword, newPassword, totpCode? | recoveryCode?}
 * keeps the current session, signs out every other one, voids pending reset links, sends #12, and
 * audits `auth.password_changed`. It works with email off.
 *
 * D246: there is no admin-initiated reset. Tokens live in `auth_tokens` (migration 026,
 * `purpose='password_reset'`), minted at send time by the mail resolver (server/mail/resolve.ts).
 */

const HOUR = 3_600_000;
export const RESET_LIMITS = { perAddressHour: 3, perClientHour: 10, tokenPerClientMinute: 20, wrongCodesPerToken: 5, changePerUserTenMinutes: 5 } as const;
export const RESET_FLOOR_MS = 400;
export const RESET_JITTER_MS = 150;

const resetRequestSchema = z.object({ email }).strict();
const resetToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const resetCheckSchema = z.object({ token: resetToken }).strict();
const resetCompleteSchema = z.object({ token: resetToken, newPassword: password, totpCode: totpCode.optional(), recoveryCode: recoveryCode.optional() }).strict()
  .refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");
const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: password, totpCode: totpCode.optional(), recoveryCode: recoveryCode.optional() }).strict()
  .refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
/** In memory, like the sign-in limits: a restart clears them. */
function limited(key: string, limit: number, windowMs: number) {
  const time = Date.now();
  if (buckets.size > 2000) for (const [entryKey, entry] of buckets) if (entry.resetAt <= time) buckets.delete(entryKey);
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= time) {
    buckets.set(key, { count: 1, resetAt: time + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}
/** Wrong second-factor codes per reset token (in memory). */
const wrongCodes = new Map<string, number>();

let floorMs = RESET_FLOOR_MS;
let jitterMs = RESET_JITTER_MS;
const pending = new Set<Promise<void>>();

/** Test hooks. */
export function resetPasswordFlowLimits() {
  buckets.clear();
  wrongCodes.clear();
}
export function setResetFloorForTests(floor: number | null, jitter: number | null = null) {
  floorMs = floor ?? RESET_FLOOR_MS;
  jitterMs = jitter ?? (floor === null ? RESET_JITTER_MS : 0);
}
/** Resolves once the work queued by earlier reset requests has run. */
export async function passwordResetWorkSettled() {
  while (pending.size) await Promise.all([...pending]);
}


function publicRequestRefusal(c: Context<AppEnv>) {
  // D295: with AUTH_METHODS=google there are no passwords to reset.
  const methodRefusal = passwordMethodRefusal(c);
  if (methodRefusal) return methodRefusal;
  if (!isOriginAllowed(c.req.header("Origin"))) return c.json({ error: "Invalid request origin" }, 403);
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Content-Type must be application/json" }, 415);
  return null;
}


/**
 * The work behind a reset request, run after the response: the per-address limit, then the lookup,
 * then the enqueue. Only an existing, unblocked, verified, allowlisted account gets mail; the
 * dispatcher checks blocked and unverified again at send time and mints the token then.
 */
export function processResetRequest(address: string) {
  if (limited(`reset-address:${addressHash(address)}`, RESET_LIMITS.perAddressHour, HOUR)) return;
  if (!isEmailAllowed(address)) return;
  const user = db.query("SELECT id, disabled_at, email_verified_at FROM users WHERE email = ?").get(address) as { id: string; disabled_at: string | null; email_verified_at: string | null } | null;
  if (!user || user.disabled_at !== null || user.email_verified_at === null) return;
  const id = enqueueMail({ userId: user.id, template: "account.password_reset", payload: {}, coalesceKey: `account.password_reset:${user.id}`, merge: (queued) => queued });
  if (!id) return;
  audit(user.id, null, "auth.password_reset_requested");
  kickMailDispatch();
}

type TokenRow = { id: string; user_id: string; expires_at: string; used_at: string | null; email_at_issue: string };
type TokenLookup = { kind: "live"; token: TokenRow; user: UserRow } | { kind: "invalid" | "expired" };

/** A reset token that is unused, for the account's current address, on an unblocked account. */
function lookupResetToken(token: string, nowMs = Date.now()): TokenLookup {
  const row = db.query("SELECT id, user_id, expires_at, used_at, email_at_issue FROM auth_tokens WHERE token_hash = ? AND purpose = 'password_reset'").get(hashAuthToken(token)) as TokenRow | null;
  if (!row || row.used_at !== null) return { kind: "invalid" };
  const user = db.query("SELECT * FROM users WHERE id = ?").get(row.user_id) as UserRow | null;
  if (!user || user.disabled_at !== null || user.email.toLowerCase() !== row.email_at_issue.toLowerCase()) return { kind: "invalid" };
  if (Date.parse(row.expires_at) <= nowMs) return { kind: "expired" };
  return { kind: "live", token: row, user };
}

const tokenRefusal = (c: Context<AppEnv>, kind: "invalid" | "expired") => kind === "expired"
  ? c.json({ error: "This link expired. Ask for a new one.", code: "TOKEN_EXPIRED" }, 400)
  : c.json({ error: "This link is not valid. It may have been used already.", code: "TOKEN_INVALID" }, 400);

/** Public reset routes: call before the session middleware. */
export function registerPasswordResetRoutes(app: Hono<AppEnv>) {
  app.post("/api/auth/password-reset/request", async (c) => {
    const refusal = publicRequestRefusal(c);
    if (refusal) return refusal;
    const started = Date.now();
    if (limited(`reset-client:${clientAddress(c)}`, RESET_LIMITS.perClientHour, HOUR)) return c.json({ error: "Too many attempts. Try again later.", code: "RATE_LIMITED" }, 429);
    const body = await parseJson(c.req.raw, resetRequestSchema);
    // With email off nothing is looked up at all.
    const enabled = mailEnabled();
    const wait = floorMs + Math.random() * jitterMs - (Date.now() - started);
    if (wait > 0) await Bun.sleep(wait);
    if (enabled) {
      // After the response: the handler returns first, so the lookup cannot change its timing.
      const work = new Promise<void>((resolve) => setTimeout(() => {
        try {
          processResetRequest(body.email);
        } catch (error) {
          console.error(`Password reset request failed: error=${error instanceof Error ? error.name : "Unknown"}`);
        }
        resolve();
      }, 0));
      pending.add(work);
      void work.then(() => pending.delete(work));
    }
    return c.json({ ok: true }, 202);
  });

  app.post("/api/auth/password-reset/check", async (c) => {
    const refusal = publicRequestRefusal(c);
    if (refusal) return refusal;
    if (limited(`reset-token:${clientAddress(c)}`, RESET_LIMITS.tokenPerClientMinute, 60_000)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    const body = await parseJson(c.req.raw, resetCheckSchema);
    const found = lookupResetToken(body.token);
    if (found.kind !== "live") return tokenRefusal(c, found.kind);
    return c.json({ ok: true, needsCode: found.user.totp_enabled_at !== null });
  });

  app.post("/api/auth/password-reset/complete", async (c) => {
    const refusal = publicRequestRefusal(c);
    if (refusal) return refusal;
    if (limited(`reset-token:${clientAddress(c)}`, RESET_LIMITS.tokenPerClientMinute, 60_000)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    const body = await parseJson(c.req.raw, resetCompleteSchema);
    const found = lookupResetToken(body.token);
    if (found.kind !== "live") return tokenRefusal(c, found.kind);
    const { token, user } = found;
    // T225: the reset replaces the password, not the second factor.
    if (user.totp_enabled_at) {
      if (!body.totpCode && !body.recoveryCode) return c.json({ error: "Enter your six-digit authentication code", code: "TOTP_REQUIRED", requiresTotp: true }, 428);
      const valid = body.recoveryCode ? consumeRecoveryCode(user, body.recoveryCode) : consumeTotp(user, body.totpCode!) !== null;
      if (!valid) {
        audit(user.id, null, "auth.password_reset_code_failed");
        const count = (wrongCodes.get(token.id) ?? 0) + 1;
        wrongCodes.set(token.id, count);
        if (count >= RESET_LIMITS.wrongCodesPerToken) {
          // Too many wrong codes: the link stops working, so a stolen mailbox cannot guess its way in.
          db.query("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now(), token.id);
          wrongCodes.delete(token.id);
          return c.json({ error: "Too many wrong codes. This link no longer works; ask for a new one.", code: "TOKEN_INVALID" }, 400);
        }
        return c.json({ error: "Invalid or already-used authentication or recovery code", code: "TOTP_INVALID", requiresTotp: true }, 401);
      }
      if (body.recoveryCode) {
        audit(user.id, null, "auth.recovery_code_used", { purpose: "password_reset" });
        mailTwoFactor(user.id, "recovery_used");
      }
    }
    const passwordHash = await hashPassword(body.newPassword);
    const done = db.transaction(() => {
      const at = now();
      // Single use: a second completion (or a race) finds the token already claimed.
      const claimed = db.query("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(at, token.id, at);
      if (claimed.changes !== 1) return null;
      db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
      db.query("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL").run(user.id);
      const sessions = db.query("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
      revokeUserPushSubscriptions(user.id, "password_reset");
      // Outbound email §B.2: a reset also voids every unsubscribe link mailed so far (T221).
      bumpUnsubscribeEpoch(user.id);
      audit(user.id, null, "auth.password_reset", { sessions });
      mailPasswordChanged(user.id, "reset");
      return sessions;
    })();
    wrongCodes.delete(token.id);
    if (done === null) return tokenRefusal(c, "invalid");
    kickMailDispatch();
    // No automatic sign-in (OWASP): the person signs in with the new password.
    return c.json({ ok: true });
  });
}

/** The signed-in change: register after the session, CSRF, and role middleware. */
export function registerPasswordChangeRoute(app: Hono<AppEnv>) {
  app.post("/api/auth/password/change", async (c) => {
    const methodRefusal = passwordMethodRefusal(c);
    if (methodRefusal) return methodRefusal;
    const current = c.get("user");
    const body = await parseJson(c.req.raw, passwordChangeSchema);
    if (limited(`password-change:${current.id}`, RESET_LIMITS.changePerUserTenMinutes, 10 * 60_000)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    if (current.totp_enabled_at && !body.totpCode && !body.recoveryCode) return c.json({ error: "Enter your six-digit authentication code", code: "TOTP_REQUIRED", requiresTotp: true }, 428);
    // The password first; a code is consumed only after it verifies (server/reauth.ts).
    if (!await verifyReauth(current.id, { password: body.currentPassword, totpCode: body.totpCode, recoveryCode: body.recoveryCode }, "password_change", c.get("sessionId"))) {
      audit(current.id, null, "auth.password_change_failed");
      return c.json({ error: current.totp_enabled_at ? "Invalid password or authentication code" : "Your current password is not correct", code: "REAUTH_FAILED" }, 400);
    }
    if (body.recoveryCode) mailTwoFactor(current.id, "recovery_used");
    const user = db.query("SELECT password_hash FROM users WHERE id = ?").get(current.id) as { password_hash: string };
    if (await verifyPassword(body.newPassword, user.password_hash)) return c.json({ error: "Choose a password that is different from your current one", code: "SAME_PASSWORD" }, 400);
    const passwordHash = await hashPassword(body.newPassword);
    const signedOut = db.transaction(() => {
      db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, current.id);
      // A pending reset link stops working once the password has changed.
      db.query("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL").run(current.id);
      const sessions = db.query("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(current.id, c.get("sessionId")).changes;
      audit(current.id, null, "auth.password_changed", { sessions });
      mailPasswordChanged(current.id, "changed");
      return sessions;
    })();
    kickMailDispatch();
    return c.json({ ok: true, signedOut });
  });
}

/** Whether the forgot-password page can offer a link (email on); `/api/about` carries it. */
export const passwordResetAvailable = () => mailEnabled();
