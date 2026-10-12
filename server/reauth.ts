import { config, googleAuthEnabled, passwordAuthEnabled } from "./config";
import { audit, db, type UserRow } from "./db";
import { isUsablePasswordHash, verifyPassword } from "./passwords";
import { decryptRecoveryCodes, decryptTotpSecret, encryptRecoveryCodes, recoveryCodeMatches, verifyTotp } from "./totp";

/**
 * Second-factor checks shared by sign-in, and the one re-authentication check (`checkReauth`) every
 * step-up flow uses. Each code is consumed with a compare-and-swap, so a TOTP counter or recovery
 * code works once.
 */

export function consumeTotp(user: Pick<UserRow, "id" | "totp_secret" | "totp_last_counter">, code: string) {
  if (!user.totp_secret || !config.totpEncryptionKey) return null;
  let secret: string;
  try {
    secret = decryptTotpSecret(user.totp_secret, config.totpEncryptionKey, user.id);
  } catch {
    audit(user.id, null, "auth.totp_secret_unreadable");
    return null;
  }
  const counter = verifyTotp(secret, code, user.totp_last_counter);
  if (counter === null) return null;
  const result = db.query(`
    UPDATE users SET totp_last_counter = ?
    WHERE id = ? AND totp_secret = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)
  `).run(counter, user.id, user.totp_secret, counter);
  return result.changes === 1 ? counter : null;
}

export function consumeRecoveryCode(user: Pick<UserRow, "id" | "totp_recovery_codes">, code: string) {
  if (!user.totp_recovery_codes || !config.totpEncryptionKey) return false;
  try {
    const codes = decryptRecoveryCodes(user.totp_recovery_codes, config.totpEncryptionKey, user.id);
    const index = codes.findIndex((candidate) => recoveryCodeMatches(candidate, code));
    if (index < 0) return false;
    const remaining = codes.filter((_, itemIndex) => itemIndex !== index);
    const encrypted = encryptRecoveryCodes(remaining, config.totpEncryptionKey, user.id);
    const result = db.query("UPDATE users SET totp_recovery_codes = ? WHERE id = ? AND totp_recovery_codes = ?")
      .run(encrypted, user.id, user.totp_recovery_codes);
    return result.changes === 1;
  } catch {
    audit(user.id, null, "auth.totp_recovery_unreadable");
    return false;
  }
}

export type ReauthInput = { password?: string; totpCode?: string; recoveryCode?: string };

/** How long a Google confirmation counts on its session (D297). */
export const GOOGLE_REAUTH_MS = 5 * 60_000;

/** When this session's Google confirmation stops counting, or null when there is none (D297). */
export function googleReauthUntil(sessionId: string | undefined, userId: string) {
  if (!sessionId || !googleAuthEnabled()) return null;
  const row = db.query(`SELECT s.reauth_at FROM sessions s JOIN google_identities g ON g.user_id = s.user_id
    WHERE s.id = ? AND s.user_id = ?`).get(sessionId, userId) as { reauth_at: string | null } | null;
  if (!row?.reauth_at) return null;
  const until = Date.parse(row.reauth_at) + GOOGLE_REAUTH_MS;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

/** Whether the password can confirm this account: the password method is on and the account has one. */
export const passwordReauthAvailable = (user: Pick<UserRow, "password_hash">) => passwordAuthEnabled() && isUsablePasswordHash(user.password_hash);

/**
 * Which proof a re-authentication prompt shows first (D297; operator decision 2026-10-12, MEDIUM-3):
 * a Google confirmation for every account with a linked Google identity while Google is on (its
 * password, if it has one, stays an optional alternative); else the password; else none (nothing can
 * confirm it: the account must set a password or link Google).
 */
export function reauthMethod(user: Pick<UserRow, "id" | "password_hash">): "password" | "google" | "none" {
  if (googleAuthEnabled() && db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(user.id)) return "google";
  if (passwordReauthAvailable(user)) return "password";
  return "none";
}

export type ReauthRefusalCode = "REAUTH_FAILED" | "GOOGLE_REAUTH_REQUIRED" | "REAUTH_UNAVAILABLE";
export type ReauthResult =
  | { ok: true; via: "google" | "password"; recoveryCodeUsed: boolean }
  | { ok: false; code: ReauthRefusalCode; error: string };

export const REAUTH_MESSAGES = {
  failed: "Invalid password or authentication code",
  googleRequired: "Your Google confirmation ran out or was not done on this device. Confirm with Google again, then try once more.",
  unavailable: "This account has no password here and no linked Google account, so it cannot confirm changes. Link Google under Settings → Security, or ask your admin."
} as const;

const refusal = (code: ReauthRefusalCode, error: string): ReauthResult => ({ ok: false, code, error });

/** `secondFactor`: the action changes the factors themselves, so the code is asked for on the Google route too. */
export type ReauthOptions = { secondFactor?: boolean };

/**
 * The one re-authentication check every step-up flow uses: API keys (own and integration), the vault's
 * protected environments, two-factor setup, recovery codes and turning it off, the password change,
 * Google link and unlink, and the Team admin Google actions. Two ways through:
 *
 * - Google (no password given): this session completed a Google round trip for the account's linked
 *   identity in the last 5 minutes (`sessions.reauth_at`). That alone is enough for keys, the vault,
 *   linking Google, two-factor setup, and the password (operator decision 2026-10-12, THREAT_MODEL
 *   MEDIUM-3). With two-factor on, the actions that change the factors (turning it off, recovery
 *   codes, unlinking Google, Team admin Google actions) also need a code: `secondFactor: true`.
 * - The password (only while the password method is on), plus, with two-factor on, a fresh
 *   authentication code or a recovery code (unchanged). A code is consumed only after the first factor.
 *
 * A recovery code stands in for the authenticator code everywhere. `purpose` is recorded when one is used.
 */
export async function checkReauth(userId: string, input: ReauthInput, purpose: string, sessionId?: string, options: ReauthOptions = {}): Promise<ReauthResult> {
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL AND kind = 'person'").get(userId) as UserRow | null;
  if (!user) return refusal("REAUTH_FAILED", REAUTH_MESSAGES.failed);
  let via: "google" | "password";
  if (!input.password) {
    const method = reauthMethod(user);
    if (method === "none") return refusal("REAUTH_UNAVAILABLE", REAUTH_MESSAGES.unavailable);
    if (method !== "google") return refusal("REAUTH_FAILED", REAUTH_MESSAGES.failed);
    if (googleReauthUntil(sessionId, user.id) === null) return refusal("GOOGLE_REAUTH_REQUIRED", REAUTH_MESSAGES.googleRequired);
    via = "google";
  } else {
    if (!passwordAuthEnabled() || !await verifyPassword(input.password, user.password_hash)) return refusal("REAUTH_FAILED", REAUTH_MESSAGES.failed);
    via = "password";
  }
  // The code: always on the password route with two-factor on (unchanged); on the Google route only
  // for the actions that change the factors themselves (`secondFactor: true`).
  if (!user.totp_enabled_at || (via === "google" && !options.secondFactor)) return { ok: true, via, recoveryCodeUsed: false };
  if (input.recoveryCode) {
    if (!consumeRecoveryCode(user, input.recoveryCode)) return refusal("REAUTH_FAILED", REAUTH_MESSAGES.failed);
    audit(user.id, null, "auth.recovery_code_used", { purpose });
    return { ok: true, via, recoveryCodeUsed: true };
  }
  return input.totpCode && consumeTotp(user, input.totpCode) !== null
    ? { ok: true, via, recoveryCodeUsed: false }
    : refusal("REAUTH_FAILED", REAUTH_MESSAGES.failed);
}

/**
 * Whether a request still lacks its two-factor code (the 428 `TOTP_REQUIRED` hint some forms answer
 * first): with two-factor on, on the password route, or on the Google route of a `secondFactor` action.
 */
export const needsTotpCode = (user: Pick<UserRow, "totp_enabled_at">, input: ReauthInput, options: ReauthOptions = {}) =>
  Boolean(user.totp_enabled_at && (input.password || options.secondFactor) && !input.totpCode && !input.recoveryCode);
