import { config, googleAuthEnabled, passwordAuthEnabled } from "./config";
import { audit, db, type UserRow } from "./db";
import { isUsablePasswordHash, verifyPassword } from "./passwords";
import { decryptRecoveryCodes, decryptTotpSecret, encryptRecoveryCodes, recoveryCodeMatches, verifyTotp } from "./totp";

/**
 * Second-factor checks shared by sign-in, MCP key creation, and Team re-authentication. Each code
 * is consumed with a compare-and-swap, so a TOTP counter or recovery code works once.
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

/** How long a Google confirmation stands in for the password on its session (D297). */
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

/**
 * Which proof a re-authentication prompt asks for (D297): the password while the password method is
 * on and the account has one, else a Google confirmation while Google is on and the account is
 * linked, else none (nothing can confirm it: the account must set a password or link Google).
 */
export function reauthMethod(user: Pick<UserRow, "id" | "password_hash">): "password" | "google" | "none" {
  if (passwordAuthEnabled() && isUsablePasswordHash(user.password_hash)) return "password";
  if (googleAuthEnabled() && db.query("SELECT 1 FROM google_identities WHERE user_id = ?").get(user.id)) return "google";
  return "none";
}

/**
 * The first factor of a re-authentication: the password (only while the password method is on), or,
 * when no password is given, this session's Google confirmation from the last 5 minutes.
 */
export async function verifyFirstFactor(user: Pick<UserRow, "id" | "password_hash">, password: string | undefined, sessionId: string | undefined) {
  if (password) return passwordAuthEnabled() && await verifyPassword(password, user.password_hash);
  return googleReauthUntil(sessionId, user.id) !== null;
}

/**
 * Re-authenticates an active user with their password (or this session's fresh Google confirmation, D297) plus, when TOTP is enabled, a fresh
 * authentication or recovery code (the MCP key creation rule, index.ts). Codes are consumed only
 * after the password verifies. `purpose` is recorded when a recovery code is used.
 */
export async function verifyReauth(userId: string, input: ReauthInput, purpose: string, sessionId?: string) {
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as UserRow | null;
  if (!user || !await verifyFirstFactor(user, input.password, sessionId)) return false;
  if (!user.totp_enabled_at) return true;
  if (input.recoveryCode) {
    if (!consumeRecoveryCode(user, input.recoveryCode)) return false;
    audit(user.id, null, "auth.recovery_code_used", { purpose });
    return true;
  }
  return input.totpCode ? consumeTotp(user, input.totpCode) !== null : false;
}
