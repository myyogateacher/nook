import { recordAccessEvent, type AccessVia } from "../access/events";
import { SHARE_TABLES } from "../access/shares";
import { revokeOwnKey } from "../apiKeys";
import { clearAvatar } from "../avatars";
import { revokeUserPushSubscriptions } from "../calendar/push";
import { passwordAuthEnabled } from "../config";
import { audit, db, now } from "../db";
import { pauseRoutinesOf } from "../inbox/routineHooks";
import { kickMailDispatch } from "../mail/dispatcher";
import { mailAccountEvent } from "../mail/triggers";
import { bumpUnsubscribeEpoch } from "../mail/unsubscribe";
import { isUsablePasswordHash, UNUSABLE_PASSWORD } from "../passwords";

/**
 * Admin-approved Google linking (Wave 35 review, HIGH-1; docs/plan/WAVE_35_GOOGLE_SIGNIN.md D293).
 *
 * A Google sign-in never links itself to an account whose address Nook has not verified, and never
 * resets one. An admin (Team → member, or the host CLI) can allow the next Google sign-in with the
 * account's address to link it: once, within 24 hours. When nobody knows who created the account,
 * the admin resets it first, at once: every credential and every way the account shares content.
 */

export const GOOGLE_LINK_ALLOWANCE_MS = 24 * 3_600_000;

export type GoogleLinkErrorCode = "NOT_FOUND" | "SELF_ACTION" | "ALREADY_LINKED" | "NOT_LINKED" | "NO_OTHER_SIGN_IN" | "RESET_VERIFIED" | "RESET_ADMIN";

export class GoogleLinkError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: GoogleLinkErrorCode, message: string) {
    super(message);
    this.name = "GoogleLinkError";
  }
}

type Actor = { id: string } | null;

/** The modules whose items an account owns and can share, with their visibility column. */
const OWNED_ITEMS = [
  { kind: "folder", table: "folders", inherit: false },
  { kind: "note", table: "notes", inherit: true },
  { kind: "document", table: "documents", inherit: true },
  { kind: "board", table: "boards", inherit: false },
  { kind: "task_view", table: "task_views", inherit: false },
  { kind: "collection", table: "collections", inherit: false },
  { kind: "calendar", table: "calendars", inherit: false }
] as const;

export type ResetCounts = {
  sessions: number;
  keys: number;
  feeds: number;
  /** Owned items that were not private (or had a direct share or group grant). */
  items: number;
  /** Direct shares and member rows on owned items. */
  shares: number;
  groupGrants: number;
  invites: number;
  routines: number;
  /** 1 when a usable password is removed. */
  password: number;
  /** 1 when two-factor is removed. */
  twoFactor: number;
};

type Target = { id: string; email: string; role: string; password_hash: string; totp_enabled_at: string | null; disabled_at: string | null; google_link_allowed_until: string | null; email_verified_at: string | null };
const targetRow = (userId: string) => db.query("SELECT id, email, role, password_hash, totp_enabled_at, disabled_at, google_link_allowed_until, email_verified_at FROM users WHERE id = ?").get(userId) as Target | null;

/**
 * Why the web may not reset this account (N2b), or null: a verified address means Nook knows the
 * account's owner, and an admin's reset of another admin is a takeover path. The host CLI may.
 */
export function webResetRefusal(target: Pick<Target, "email_verified_at" | "role">): GoogleLinkError | null {
  if (target.role === "admin") return new GoogleLinkError(403, "RESET_ADMIN", "Admin accounts cannot be reset here. Use the host command line if you must.");
  if (target.email_verified_at !== null) return new GoogleLinkError(409, "RESET_VERIFIED", "This account's address is verified, so its owner is known: allow Google sign-in without a reset.");
  return null;
}

/**
 * Wave 33 hook (N2c): once `access_notices` (migration 032) and `notifyAccess` are on main, call
 * `notifyAccess(userId, { kind: "google_reset", counts })` here so the member also sees the reset in
 * the bell. Until then the one-time sign-in notice (users.google_reset_notice_*) carries it.
 */
function notifyAccessAfterReset(_userId: string, _counts: ResetCounts) {
  // TODO(Wave 33): notifyAccess(_userId, { kind: "google_reset", counts: _counts });
}

/** Test hook (N6): throws after the reset and before the allowance, inside the one transaction. */
let failAfterReset = false;
export function setGoogleAllowFailureForTests(value: boolean) {
  failAfterReset = value;
}
const identityOf = (userId: string) => db.query("SELECT id, email FROM google_identities WHERE user_id = ?").get(userId) as { id: string; email: string } | null;

const count = (sql: string, ...params: string[]) => (db.query(sql).get(...params) as { count: number }).count;

/** What a reset would remove now, as counts (shown before the admin confirms). */
export function googleResetPreview(userId: string): ResetCounts {
  const user = targetRow(userId);
  if (!user) throw new GoogleLinkError(404, "NOT_FOUND", "Team member not found");
  let items = 0;
  let shares = 0;
  let groupGrants = 0;
  for (const item of OWNED_ITEMS) {
    const share = SHARE_TABLES[item.kind];
    items += count(`SELECT COUNT(*) AS count FROM ${item.table} t WHERE t.owner_id = ? AND (t.visibility <> 'private'
      OR EXISTS (SELECT 1 FROM ${share.table} s WHERE s.${share.column} = t.id)
      OR EXISTS (SELECT 1 FROM group_grants g WHERE g.resource_kind = '${item.kind}' AND g.resource_id = t.id))`, userId);
    shares += count(`SELECT COUNT(*) AS count FROM ${share.table} s JOIN ${item.table} t ON t.id = s.${share.column} WHERE t.owner_id = ?`, userId);
    groupGrants += count(`SELECT COUNT(*) AS count FROM group_grants g JOIN ${item.table} t ON t.id = g.resource_id WHERE g.resource_kind = '${item.kind}' AND t.owner_id = ?`, userId);
  }
  return {
    sessions: count("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", userId),
    keys: count("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL", userId),
    feeds: count("SELECT COUNT(*) AS count FROM calendar_feeds WHERE user_id = ? AND revoked_at IS NULL", userId),
    items,
    shares,
    groupGrants,
    invites: count("SELECT COUNT(*) AS count FROM team_invites WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", userId, now()),
    routines: count("SELECT COUNT(*) AS count FROM routines WHERE owner_id = ? AND enabled = 1", userId),
    password: isUsablePasswordHash(user.password_hash) ? 1 : 0,
    twoFactor: user.totp_enabled_at !== null ? 1 : 0
  };
}

/**
 * Resets an account whose creator is unknown, in one transaction: sessions, push subscriptions, API
 * keys, calendar feeds, pending reset links, the password (the unusable sentinel), two-factor, and
 * unsubscribe links; and every way it shares: each owned item goes back to private, and its direct
 * shares, member rows, and group grants are deleted; its live invites are revoked and its routines
 * paused. Content is kept. Returns what was removed.
 */
export function resetAccountForGoogle(userId: string, actor: Actor, via: AccessVia): ResetCounts {
  const counts = googleResetPreview(userId);
  db.transaction(() => {
    const at = now();
    db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
    revokeUserPushSubscriptions(userId, "google_reset");
    for (const { id } of db.query("SELECT id FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").all(userId) as Array<{ id: string }>) revokeOwnKey(userId, id);
    db.query("UPDATE calendar_feeds SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(at, userId);
    db.query("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL").run(userId);
    db.query(`UPDATE users SET password_hash = ?, totp_secret = NULL, totp_enabled_at = NULL, totp_last_counter = NULL, totp_recovery_codes = NULL
      WHERE id = ?`).run(UNUSABLE_PASSWORD, userId);
    bumpUnsubscribeEpoch(userId);
    for (const item of OWNED_ITEMS) {
      const share = SHARE_TABLES[item.kind];
      db.query(`DELETE FROM ${share.table} WHERE ${share.column} IN (SELECT id FROM ${item.table} WHERE owner_id = ?)`).run(userId);
      db.query(`DELETE FROM group_grants WHERE resource_kind = '${item.kind}' AND resource_id IN (SELECT id FROM ${item.table} WHERE owner_id = ?)`).run(userId);
      // Notes and files follow their (now private) folder; everything else is private itself.
      db.query(item.inherit
        ? `UPDATE ${item.table} SET visibility = 'private', sharing_override = 0 WHERE owner_id = ? AND (visibility <> 'private' OR sharing_override <> 0)`
        : `UPDATE ${item.table} SET visibility = 'private' WHERE owner_id = ? AND visibility <> 'private'`).run(userId);
    }
    db.query("UPDATE team_invites SET revoked_at = ?, revoked_by = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").run(at, actor?.id ?? null, userId, at);
    pauseRoutinesOf(userId);
    audit(actor?.id ?? null, null, "team.google_reset", { targetId: userId, via, ...counts });
    recordAccessEvent({ actorId: actor?.id ?? null, via, action: "account.google_reset", targetUserId: userId, meta: { ...counts } }, at);
    mailAccountEvent(userId, "google_reset", actor?.id ?? null, { ...counts });
    // N2c: shown once at the member's next sign-in, dismissed when read.
    db.query("UPDATE users SET google_reset_notice_at = ?, google_reset_notice_json = ? WHERE id = ?").run(at, JSON.stringify(counts), userId);
    notifyAccessAfterReset(userId, counts);
  })();
  kickMailDispatch();
  return counts;
}

/**
 * Allows the next Google sign-in with this account's (verified-by-Google, authoritative) address to
 * link it, once, within 24 hours; optionally resets the account first. The web refuses an admin's
 * own account (the host CLI is the way out for a lone admin).
 */
/** The refusals of an allowance, checked before the admin re-authenticates (no code is spent on them). */
export function checkAllowGoogleLink(actor: Actor, targetId: string, options: { reset: boolean; via: AccessVia }) {
  const user = targetRow(targetId);
  if (!user) throw new GoogleLinkError(404, "NOT_FOUND", "Team member not found");
  if (options.via === "web" && actor?.id === targetId) throw new GoogleLinkError(403, "SELF_ACTION", "You cannot do this for your own account. Another admin, or the host CLI, can.");
  // A linked account gets a re-linking allowance (N5): the next authoritative Google sign-in with
  // its address replaces the identity; the old Google account keeps working until then.
  const relink = identityOf(targetId) !== null;
  if (options.reset && relink) throw new GoogleLinkError(409, "ALREADY_LINKED", "This account signs in with Google; allow re-linking without a reset.");
  if (options.reset && options.via === "web") {
    const refusal = webResetRefusal(user);
    if (refusal) throw refusal;
  }
  return { relink };
}

export function allowGoogleLink(actor: Actor, targetId: string, options: { reset: boolean; via: AccessVia }) {
  const { relink } = checkAllowGoogleLink(actor, targetId, options);
  const until = new Date(Date.now() + GOOGLE_LINK_ALLOWANCE_MS).toISOString();
  // N6: the reset and the allowance commit together, or neither does.
  const reset = db.transaction(() => {
    const counts = options.reset ? resetAccountForGoogle(targetId, actor, options.via) : null;
    if (failAfterReset) throw new Error("Injected failure after the reset (test)");
    db.query("UPDATE users SET google_link_allowed_until = ? WHERE id = ?").run(until, targetId);
    audit(actor?.id ?? null, null, "team.google_link_allowed", { targetId, via: options.via, reset: Boolean(counts), relink });
    recordAccessEvent({ actorId: actor?.id ?? null, via: options.via, action: "account.google_allowed", targetUserId: targetId, meta: { reset: Boolean(counts), relink } });
    // The reset mails its own summary.
    if (!counts) mailAccountEvent(targetId, "google_allowed", actor?.id ?? null);
    return counts;
  })();
  kickMailDispatch();
  return { allowedUntil: until, reset, relink };
}

/**
 * Consumes a live allowance for `userId` (one guarded UPDATE). True when this sign-in may link. A
 * blocked account's allowance is never used (the caller refuses blocked accounts first).
 */
export function consumeGoogleLinkAllowance(userId: string, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  return db.query("UPDATE users SET google_link_allowed_until = NULL WHERE id = ? AND disabled_at IS NULL AND google_link_allowed_until IS NOT NULL AND google_link_allowed_until > ?").run(userId, at).changes === 1;
}

/**
 * An admin removes an account's Google identity (L6: a recreated Google account has a new `sub`).
 * On the web the account must keep a way in: a usable password with the password method on, or a
 * live allowance for the next Google sign-in. The CLI may always unlink.
 */
/** The refusals of an admin unlink, checked before the admin re-authenticates. */
export function checkUnlinkGoogle(actor: Actor, targetId: string, via: AccessVia) {
  const user = targetRow(targetId);
  if (!user) throw new GoogleLinkError(404, "NOT_FOUND", "Team member not found");
  if (via === "web" && actor?.id === targetId) throw new GoogleLinkError(403, "SELF_ACTION", "Unlink your own Google sign-in from Settings → Security.");
  if (!identityOf(targetId)) throw new GoogleLinkError(404, "NOT_LINKED", "This account does not sign in with Google");
  const allowed = user.google_link_allowed_until !== null && Date.parse(user.google_link_allowed_until) > Date.now();
  if (via === "web" && !allowed && !(passwordAuthEnabled() && isUsablePasswordHash(user.password_hash))) {
    throw new GoogleLinkError(409, "NO_OTHER_SIGN_IN", "Unlinking would leave this person no way to sign in. If they have a new Google account, use Allow re-linking instead: their next Google sign-in with this address replaces the old one.");
  }
}

export async function unlinkGoogleForAccount(actor: Actor, targetId: string, via: AccessVia) {
  checkUnlinkGoogle(actor, targetId, via);
  const user = targetRow(targetId);
  if (!user) throw new GoogleLinkError(404, "NOT_FOUND", "Team member not found");
  if (via === "web" && actor?.id === targetId) throw new GoogleLinkError(403, "SELF_ACTION", "Unlink your own Google sign-in from Settings → Security.");
  const identity = identityOf(targetId);
  if (!identity) throw new GoogleLinkError(404, "NOT_LINKED", "This account does not sign in with Google");
  const allowed = user.google_link_allowed_until !== null && Date.parse(user.google_link_allowed_until) > Date.now();
  if (via === "web" && !allowed && !(passwordAuthEnabled() && isUsablePasswordHash(user.password_hash))) {
    throw new GoogleLinkError(409, "NO_OTHER_SIGN_IN", "Unlinking would leave this person no way to sign in. If they have a new Google account, use Allow re-linking instead: their next Google sign-in with this address replaces the old one.");
  }
  db.transaction(() => {
    db.query("DELETE FROM google_identities WHERE id = ?").run(identity.id);
    db.query("UPDATE sessions SET reauth_at = NULL WHERE user_id = ?").run(targetId);
    audit(actor?.id ?? null, null, "team.google_unlinked", { targetId, via });
    recordAccessEvent({ actorId: actor?.id ?? null, via, action: "account.google_unlinked", targetUserId: targetId });
    mailAccountEvent(targetId, "google_unlinked", actor?.id ?? null);
  })();
  kickMailDispatch();
  await clearAvatar(targetId);
  return { ok: true as const };
}

/** The one-time "an admin reset this account" notice (N2c), or null. */
export function googleResetNotice(userId: string) {
  const row = db.query("SELECT google_reset_notice_at, google_reset_notice_json FROM users WHERE id = ?").get(userId) as { google_reset_notice_at: string | null; google_reset_notice_json: string | null } | null;
  if (!row?.google_reset_notice_at) return null;
  let counts: Partial<ResetCounts> = {};
  try {
    counts = row.google_reset_notice_json ? JSON.parse(row.google_reset_notice_json) as Partial<ResetCounts> : {};
  } catch {
    counts = {};
  }
  return { at: row.google_reset_notice_at, counts };
}

export function dismissGoogleResetNotice(userId: string) {
  db.query("UPDATE users SET google_reset_notice_at = NULL, google_reset_notice_json = NULL WHERE id = ?").run(userId);
}

/** What Team → member shows admins about Google sign-in. */
export function googleAdminState(targetId: string) {
  const user = targetRow(targetId);
  if (!user) return null;
  const identity = identityOf(targetId);
  const allowed = user.google_link_allowed_until !== null && Date.parse(user.google_link_allowed_until) > Date.now();
  const refusal = identity ? null : webResetRefusal(user);
  return {
    linked: identity ? { email: identity.email } : null,
    allowedUntil: allowed ? user.google_link_allowed_until : null,
    emailVerified: user.email_verified_at !== null,
    hasPassword: isUsablePasswordHash(user.password_hash),
    /** Whether the web offers "Reset this account first", and why not (N2b). */
    resetAllowed: !identity && refusal === null,
    resetRefusal: refusal ? { code: refusal.code, message: refusal.message } : null
  };
}
