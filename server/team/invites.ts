/**
 * Team invites (docs/plan/WAVES_18-20_SMALL.md §1, D161–D169). An admin creates a single-use link
 * with a fixed role; the recipient registers with it even while `ALLOW_REGISTRATION=false`.
 *
 * - The token is 32 random bytes (base64url, 43 characters). Only its SHA-256 and a 6-character
 *   prefix are stored; the token is returned once, by `createInvite` (D161, T136).
 * - An invite works only while its creator is an active admin (D162): every lookup JOINs the
 *   creator with `role = 'admin' AND disabled_at IS NULL`.
 * - Single use: `claimInvite` is one guarded UPDATE inside the register transaction, so a lost race
 *   rolls the new account back (D164, T141).
 * - Audit rows carry `{inviteId, role}` only: never the token, its hash, or an email (D165).
 */
import { createHash } from "node:crypto";
import { isEmailAllowed } from "../config";
import { audit, db, now, type TeamInviteRow } from "../db";
import { mailEnabled, sendMail, type MailOutcome } from "../mail";
import { inviteEmail } from "./inviteEmail";
import { can, type Role } from "./roles";

export const INVITE_ROLES = ["member", "viewer", "guest"] as const;
export type InviteRole = typeof INVITE_ROLES[number];
export type InviteStatus = "live" | "used" | "expired" | "revoked";

/** Live invites allowed on the instance at once (D164, Q3). */
export const LIVE_INVITE_LIMIT = 20;
/** Invites one admin may create per rolling hour (D164). */
export const INVITE_HOURLY_LIMIT = 10;
export const INVITE_MAX_DAYS = 7;
export const INVITE_NOTE_MAX = 80;
/** Dead invites (used, revoked, or expired) older than this are swept (D169). */
export const INVITE_RETENTION_MS = 90 * 86_400_000;
/** Dead invites the admin list returns besides every live one. */
const DEAD_LIST_LIMIT = 100;

export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type InviteErrorCode =
  | "NOT_FOUND"
  | "ADMIN_ONLY"
  | "RATE_LIMITED"
  | "INVITE_LIMIT"
  | "INVITE_NOT_LIVE"
  | "INVITE_INVALID"
  | "INVITE_EXPIRED"
  | "INVITE_EMAIL_MISMATCH"
  | "EMAIL_NOT_ALLOWED"
  | "ACCOUNT_EXISTS"
  | "EMAIL_REQUIRED";

export class InviteError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 410 | 429, readonly code: InviteErrorCode, message: string) {
    super(message);
    this.name = "InviteError";
  }
}

const invalid = () => new InviteError(404, "INVITE_INVALID", "This invite link is not valid. Ask your admin for a new link.");
const expired = () => new InviteError(410, "INVITE_EXPIRED", "This invite link has expired. Ask your admin for a new link.");

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** The status of an invite at `at` (an ISO timestamp). Pure. */
export function inviteStatus(row: Pick<TeamInviteRow, "used_at" | "revoked_at" | "expires_at">, at: string): InviteStatus {
  if (row.revoked_at !== null) return "revoked";
  if (row.used_at !== null) return "used";
  return row.expires_at <= at ? "expired" : "live";
}

/** `p•••@example.com`: enough for the holder to recognise their address, no more (D166). */
export function maskEmail(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export type TeamInvite = {
  id: string;
  tokenPrefix: string;
  role: InviteRole;
  email: string | null;
  note: string | null;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  createdBy: { id: string; displayName: string } | null;
  usedBy: { id: string; displayName: string } | null;
  usedAt: string | null;
  revokedAt: string | null;
};

type ListedRow = TeamInviteRow & { created_by_name: string | null; used_by_name: string | null; seq: number };

const listSelect = `
  SELECT i.*, i.rowid AS seq, c.display_name AS created_by_name, u.display_name AS used_by_name
  FROM team_invites i LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by`;

function present(row: ListedRow, at: string): TeamInvite {
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    role: row.role,
    email: row.email,
    note: row.note,
    status: inviteStatus(row, at),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by && row.created_by_name !== null ? { id: row.created_by, displayName: row.created_by_name } : null,
    usedBy: row.used_by && row.used_by_name !== null ? { id: row.used_by, displayName: row.used_by_name } : null,
    usedAt: row.used_at,
    revokedAt: row.revoked_at
  };
}

const LIVE_WHERE = "used_at IS NULL AND revoked_at IS NULL AND expires_at > ?";
const liveCount = (at: string) => (db.query(`SELECT COUNT(*) AS count FROM team_invites WHERE ${LIVE_WHERE}`).get(at) as { count: number }).count;

type Actor = { id: string; role: Role };

function requireAdmin(actor: Actor) {
  if (!can(actor.role, "team.manage")) throw new InviteError(403, "ADMIN_ONLY", "Only admins can manage invites");
}

/**
 * Every live invite plus the latest dead ones, newest first (admins only). Invites made in the same
 * millisecond share `created_at`; rowid (insertion order) breaks the tie, never the random id.
 */
export function listInvites(actor: Actor, options: { status?: "live" | "all" } = {}) {
  requireAdmin(actor);
  const at = now();
  const live = db.query(`${listSelect} WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC, i.rowid DESC`).all(at) as ListedRow[];
  const dead = options.status === "live" ? [] : db.query(`${listSelect} WHERE NOT (i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?) ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`).all(at, DEAD_LIST_LIMIT) as ListedRow[];
  const invites = [...live, ...dead].sort((left, right) => right.created_at.localeCompare(left.created_at) || right.seq - left.seq).map((row) => present(row, at));
  return { invites, liveCount: live.length, liveLimit: LIVE_INVITE_LIMIT, emailEnabled: mailEnabled() };
}

/** Per-admin creation timestamps for the rolling hour (in memory, like the Team write limit). */
const creations = new Map<string, number[]>();

/** Test hook. */
export function resetInviteRateLimits() {
  creations.clear();
}

function recentCreations(userId: string, nowMs: number) {
  const recent = (creations.get(userId) ?? []).filter((time) => time > nowMs - 3_600_000);
  if (recent.length) creations.set(userId, recent);
  else creations.delete(userId);
  return recent;
}

export type CreateInviteInput = { role: InviteRole; email?: string | null; expiresInDays?: number; note?: string | null; sendEmail?: boolean };

/**
 * Creates an invite and returns the token once (D161). The link carries the token in the URL
 * fragment (`/register#invite=…`), so it never reaches the server, a proxy log, or a Referer.
 */
export function createInvite(actor: Actor, input: CreateInviteInput, origin: string) {
  if (input.sendEmail && !input.email?.trim()) throw new InviteError(400, "EMAIL_REQUIRED", "Add the invitee's email to send the link by email");
  requireAdmin(actor);
  const nowMs = Date.now();
  const recent = recentCreations(actor.id, nowMs);
  if (recent.length >= INVITE_HOURLY_LIMIT) {
    throw new InviteError(429, "RATE_LIMITED", "You created 10 invites in the last hour. Try again later.");
  }
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !isEmailAllowed(email)) throw new InviteError(400, "EMAIL_NOT_ALLOWED", "This email is not on this Nook's allowed list (ALLOWED_EMAILS)");
  const note = input.note?.trim() ? input.note.trim().slice(0, INVITE_NOTE_MAX) : null;
  const days = Math.min(INVITE_MAX_DAYS, Math.max(1, Math.trunc(input.expiresInDays ?? INVITE_MAX_DAYS)));
  const token = newToken();
  const id = crypto.randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + days * 86_400_000).toISOString();
  const row = db.transaction(() => {
    if (email && db.query("SELECT 1 FROM users WHERE email = ?").get(email)) throw new InviteError(409, "ACCOUNT_EXISTS", "An account with that email already exists");
    if (liveCount(createdAt) >= LIVE_INVITE_LIMIT) throw new InviteError(409, "INVITE_LIMIT", `This Nook already has ${LIVE_INVITE_LIMIT} live invites. Revoke one or wait for one to expire.`);
    db.query(`INSERT INTO team_invites (id, token_hash, token_prefix, email, role, note, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hashInviteToken(token), token.slice(0, 6), email, input.role, note, actor.id, createdAt, expiresAt);
    audit(actor.id, null, "team.invite_create", { inviteId: id, role: input.role });
    return db.query(`${listSelect} WHERE i.id = ?`).get(id) as ListedRow;
  })();
  creations.set(actor.id, [...recent, nowMs]);
  return { invite: present(row, createdAt), token, url: inviteUrl(origin, token), row };
}

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const inviteUrl = (origin: string, token: string) => `${origin}/register#invite=${token}`;

/**
 * Emails an invite link to the invite's bound address, and only there: an email-less invite is
 * never mailed, so email cannot carry a token anywhere else. Never throws; the outcome says what
 * happened, and the invite itself stands either way.
 */
export async function emailInvite(actor: Actor, invite: Pick<TeamInviteRow, "id" | "role" | "email" | "expires_at">, url: string): Promise<MailOutcome> {
  if (!invite.email) return { sent: false, reason: "failed" };
  const inviter = (db.query("SELECT display_name FROM users WHERE id = ?").get(actor.id) as { display_name: string } | null)?.display_name ?? "An admin";
  const outcome = await sendMail(inviteEmail({ to: invite.email, url, role: invite.role, expiresAt: invite.expires_at, inviterName: inviter }), { purpose: "team_invite", senderId: actor.id });
  if (outcome.sent) audit(actor.id, null, "team.invite_emailed", { inviteId: invite.id, role: invite.role });
  return outcome;
}

/**
 * "Resend email" on a live, email-bound invite. The token is never stored, so a new one is made
 * and mailed; only once the mail is accepted does it replace the old one (the old link then stops
 * working). The new token is never shown to the admin.
 */
export async function resendInviteEmail(actor: Actor, inviteId: string, origin: string) {
  requireAdmin(actor);
  const load = () => db.query("SELECT * FROM team_invites WHERE id = ?").get(inviteId) as TeamInviteRow | null;
  const row = load();
  if (!row) throw new InviteError(404, "NOT_FOUND", "Invite not found");
  if (inviteStatus(row, now()) !== "live") throw new InviteError(409, "INVITE_NOT_LIVE", "Only a live invite can be emailed");
  if (!row.email) throw new InviteError(400, "EMAIL_REQUIRED", "This invite has no email address. Create a new invite bound to one.");
  const present = () => ({ invite: presentOne(inviteId) });
  if (!mailEnabled()) return { ...present(), email: { sent: false, reason: "not_configured" } as MailOutcome };
  const token = newToken();
  const outcome = await emailInvite(actor, row, inviteUrl(origin, token));
  if (outcome.sent) {
    const at = now();
    const result = db.query(`UPDATE team_invites SET token_hash = ?, token_prefix = ? WHERE id = ? AND ${LIVE_WHERE}`).run(hashInviteToken(token), token.slice(0, 6), inviteId, at);
    if (result.changes !== 1) throw new InviteError(409, "INVITE_NOT_LIVE", "This invite was used or revoked while the email was sent");
  }
  return { ...present(), email: outcome };
}

const presentOne = (inviteId: string) => present(db.query(`${listSelect} WHERE i.id = ?`).get(inviteId) as ListedRow, now());

/** Revokes a live invite. Revoking a revoked invite answers with it again (idempotent). */
export function revokeInvite(actor: Actor, inviteId: string) {
  requireAdmin(actor);
  return db.transaction(() => {
    const at = now();
    const row = db.query("SELECT * FROM team_invites WHERE id = ?").get(inviteId) as TeamInviteRow | null;
    if (!row) throw new InviteError(404, "NOT_FOUND", "Invite not found");
    const status = inviteStatus(row, at);
    if (status === "live") {
      const result = db.query(`UPDATE team_invites SET revoked_at = ?, revoked_by = ? WHERE id = ? AND ${LIVE_WHERE}`).run(at, actor.id, row.id, at);
      if (result.changes !== 1) throw new InviteError(409, "INVITE_NOT_LIVE", "This invite was used or expired meanwhile");
      audit(actor.id, null, "team.invite_revoke", { inviteId: row.id, role: row.role });
    } else if (status !== "revoked") {
      throw new InviteError(409, "INVITE_NOT_LIVE", status === "used" ? "This invite was already used" : "This invite has expired");
    }
    return { invite: present(db.query(`${listSelect} WHERE i.id = ?`).get(row.id) as ListedRow, at) };
  })();
}

type ClaimableRow = TeamInviteRow & { inviter_name: string };

/**
 * The invite for `tokenHash`, if its creator is still an active admin (D162). Unknown, used,
 * revoked, and orphaned invites all answer INVITE_INVALID; only an expired one says so (D166).
 */
function findUsable(tokenHash: string, at: string) {
  const row = db.query(`SELECT i.*, a.display_name AS inviter_name FROM team_invites i JOIN users a ON a.id = i.created_by
    WHERE i.token_hash = ? AND a.role = 'admin' AND a.disabled_at IS NULL`).get(tokenHash) as ClaimableRow | null;
  if (!row || row.used_at !== null || row.revoked_at !== null) throw invalid();
  if (row.expires_at <= at) throw expired();
  return row;
}

/** Pre-auth preview (`POST /api/auth/invite`): what the invitee sees before registering. */
export function previewInvite(token: string) {
  const row = findUsable(hashInviteToken(token), now());
  return { role: row.role, emailHint: row.email ? maskEmail(row.email) : null, expiresAt: row.expires_at, inviterName: row.inviter_name };
}

/**
 * Checks an invite for registering `email` at `at`. Call inside the register transaction (and it
 * may be called before it, to answer without revealing whether an account exists).
 */
export function inviteForRegistration(tokenHash: string, email: string, at: string) {
  const row = findUsable(tokenHash, at);
  if (row.email !== null && row.email.toLowerCase() !== email.toLowerCase()) {
    throw new InviteError(403, "INVITE_EMAIL_MISMATCH", "This invite is for a different email address");
  }
  return row;
}

/** Marks the invite used by `userId`. One guarded UPDATE: a lost race throws INVITE_INVALID (T141). */
export function claimInvite(inviteId: string, userId: string, at: string) {
  const result = db.query(`UPDATE team_invites SET used_at = ?, used_by = ? WHERE id = ? AND ${LIVE_WHERE}`).run(at, userId, inviteId, at);
  if (result.changes !== 1) throw invalid();
}

/** How an account joined, for Team Activity (D165): derived from `team_invites.used_by`. */
export function joinedWithInvite(userId: string) {
  const row = db.query(`SELECT i.role, i.used_at, i.created_by, c.display_name AS created_by_name
    FROM team_invites i LEFT JOIN users c ON c.id = i.created_by WHERE i.used_by = ? ORDER BY i.used_at DESC LIMIT 1`)
    .get(userId) as { role: InviteRole; used_at: string; created_by: string | null; created_by_name: string | null } | null;
  if (!row) return null;
  return {
    role: row.role,
    usedAt: row.used_at,
    invitedBy: row.created_by && row.created_by_name !== null ? { id: row.created_by, displayName: row.created_by_name } : null
  };
}

/** Deletes invites dead for longer than the retention (D169). Live invites are never swept. */
export function sweepInvites(nowMs = Date.now()) {
  const cutoff = new Date(nowMs - INVITE_RETENTION_MS).toISOString();
  return db.query(`DELETE FROM team_invites WHERE (used_at IS NOT NULL AND used_at < $cutoff)
    OR (revoked_at IS NOT NULL AND revoked_at < $cutoff)
    OR (used_at IS NULL AND revoked_at IS NULL AND expires_at < $cutoff)`).run({ cutoff }).changes;
}
