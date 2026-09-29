/**
 * Team service (docs/plan/research/2026-09-26-team-module.md §3–§6, D71–D77). Every write runs in one
 * `db.transaction` with a compare-and-swap, records one `team_events` row and one `audit_log` row
 * (ids and roles only: no email, no reason text, T21/T83), and keeps at least one active admin (the
 * service check here, plus the `users_keep_one_admin` triggers from migration 017, T78).
 *
 * Admins see account metadata only; nothing here reads anyone's content (D73).
 */
import { revokeUserPushSubscriptions } from "../calendar/push";
import { isEmailAllowed } from "../config";
import { audit, db, now, type UserRow } from "../db";
import { joinedWithInvite } from "./invites";
import { can, type Role } from "./roles";
import { userRole } from "./userRole";
import { readPolicies } from "./policies";
import { pauseRoutinesOf } from "../inbox/routineHooks";
import { mailAccountEvent, mailRoleChanged } from "../mail/triggers";
import { avatarUrlFor } from "../avatars";

export type TeamVia = "web" | "cli" | "mcp";
/** Who is acting: a signed-in admin (web or MCP), or the host CLI (no actor). */
export type TeamActor = { id: string; role: Role } | null;

export type TeamErrorCode =
  | "NOT_FOUND"
  | "ADMIN_ONLY"
  | "ROLE_CHANGED"
  | "LAST_ADMIN"
  | "SELF_ACTION"
  | "ALREADY_BLOCKED"
  | "NOT_BLOCKED"
  | "GUEST_SHARE_DISABLED";

export class TeamError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: TeamErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "TeamError";
  }
}

const notFound = () => new TeamError(404, "NOT_FOUND", "Team member not found");
const lastAdmin = () => new TeamError(409, "LAST_ADMIN", "Nook needs at least one admin");

/** Most users the list returns (§6.3). */
export const TEAM_LIST_LIMIT = 500;
/** Activity rows on the detail page, and in the MCP tool. */
export const TEAM_EVENTS_LIMIT = 50;
export const BLOCK_REASON_MAX = 200;

const ROLE_ORDER = "CASE u.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END";

type MemberRow = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  created_at: string;
  disabled_at: string | null;
  blocked_by: string | null;
  blocked_by_name: string | null;
  block_reason: string | null;
  totp_enabled_at: string | null;
  last_seen_at: string | null;
  live_keys: number;
  storage_bytes: number;
  avatar_id: string | null;
};

const memberSelect = `
  SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.disabled_at, u.blocked_by, b.display_name AS blocked_by_name,
         u.block_reason, u.totp_enabled_at, u.avatar_id,
         (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
         (SELECT COUNT(*) FROM mcp_api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS live_keys,
         (SELECT COALESCE(SUM(d.size_bytes), 0) FROM documents d WHERE d.owner_id = u.id) AS storage_bytes
  FROM users u LEFT JOIN users b ON b.id = u.blocked_by`;

export type TeamMember = {
  id: string;
  displayName: string;
  role: Role;
  status: "active" | "blocked";
  createdAt: string;
  isYou: boolean;
  /** Same-origin picture (Wave 35, D299), or null for the letter avatar. */
  avatarUrl: string | null;
};

export type AdminTeamMember = TeamMember & {
  email: string;
  lastSeenAt: string | null;
  blockedAt: string | null;
  blockedBy: { id: string; displayName: string } | null;
  blockReason: string | null;
  totpEnabled: boolean;
  mcpKeys: { live: number };
  storageBytes: number;
  emailAllowed: boolean;
};

export type TeamEvent = {
  id: string;
  action: "role_change" | "block" | "unblock" | "sessions_revoked" | "bootstrap_admin";
  via: "web" | "cli" | "migration" | "bootstrap" | "mcp";
  fromRole: Role | null;
  toRole: Role | null;
  reason: string | null;
  createdAt: string;
  actor: { id: string; displayName: string } | null;
};

/** Shapes a row for the viewer: admins get metadata, everyone else name, role, and status only (T85). */
function present(row: MemberRow, viewer: { id: string; role: Role }): TeamMember | AdminTeamMember {
  const base: TeamMember = {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    status: row.disabled_at === null ? "active" : "blocked",
    createdAt: row.created_at,
    isYou: row.id === viewer.id,
    avatarUrl: avatarUrlFor(row.id, row.avatar_id)
  };
  if (!can(viewer.role, "team.manage")) return base;
  return {
    ...base,
    email: row.email,
    lastSeenAt: row.last_seen_at,
    blockedAt: row.disabled_at,
    blockedBy: row.blocked_by && row.blocked_by_name !== null ? { id: row.blocked_by, displayName: row.blocked_by_name } : null,
    blockReason: row.block_reason,
    totpEnabled: row.totp_enabled_at !== null,
    mcpKeys: { live: row.live_keys },
    storageBytes: row.storage_bytes,
    emailAllowed: isEmailAllowed(row.email)
  };
}

/** The current role of an account, or null when it does not exist. */
export { userRole };

/** The Team list: active before blocked, then by role, then by name (§6.3). */
export function listTeam(viewer: { id: string; role: Role }) {
  const rows = db.query(`${memberSelect} ORDER BY u.disabled_at IS NOT NULL, ${ROLE_ORDER}, u.display_name COLLATE NOCASE, u.id LIMIT ?`)
    .all(TEAM_LIST_LIMIT) as MemberRow[];
  return { me: { id: viewer.id, role: viewer.role }, users: rows.map((row) => present(row, viewer)) };
}

/** One member; admins also get the latest activity. Null when the account does not exist. */
export function teamMember(viewer: { id: string; role: Role }, userId: string) {
  const row = db.query(`${memberSelect} WHERE u.id = ?`).get(userId) as MemberRow | null;
  if (!row) return null;
  const member = present(row, viewer);
  // D165: "Joined with an invite from <admin>, as <role>" comes from team_invites, not team_events.
  return can(viewer.role, "team.manage") ? { ...member, events: teamEvents(userId), joinedWithInvite: joinedWithInvite(userId) } : member;
}

export function teamEvents(userId: string, limit = TEAM_EVENTS_LIMIT): TeamEvent[] {
  const rows = db.query(`
    SELECT e.id, e.action, e.via, e.from_role, e.to_role, e.reason, e.created_at, e.actor_id, a.display_name AS actor_name
    FROM team_events e LEFT JOIN users a ON a.id = e.actor_id
    WHERE e.target_user_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?
  `).all(userId, limit) as Array<{ id: string; action: TeamEvent["action"]; via: TeamEvent["via"]; from_role: Role | null; to_role: Role | null; reason: string | null; created_at: string; actor_id: string | null; actor_name: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    via: row.via,
    fromRole: row.from_role,
    toRole: row.to_role,
    reason: row.reason,
    createdAt: row.created_at,
    actor: row.actor_id && row.actor_name !== null ? { id: row.actor_id, displayName: row.actor_name } : null
  }));
}

function recordEvent(targetId: string, actor: TeamActor, via: TeamVia | "bootstrap", action: TeamEvent["action"], extra: { fromRole?: Role; toRole?: Role; reason?: string | null } = {}, timestamp = now()) {
  db.query(`INSERT INTO team_events (id, target_user_id, actor_id, via, action, from_role, to_role, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), targetId, actor?.id ?? null, via, action, extra.fromRole ?? null, extra.toRole ?? null, extra.reason ?? null, timestamp);
}

/** Whether any account is an admin that is not blocked (the last-admin rule keeps one once there is one). */
export const hasActiveAdmin = () => Boolean(db.query("SELECT 1 FROM users WHERE role = 'admin' AND disabled_at IS NULL LIMIT 1").get());

export const NO_ACTIVE_ADMIN_WARNING = "Nook has accounts but no active admin (every admin is blocked, or migration 017 found no enabled account). "
  + "Recover from the host: docker compose exec mynotes bun server/team-admin.ts unblock <email> (if the account is blocked), then "
  + "docker compose exec mynotes bun server/team-admin.ts set-role <email> admin. "
  + "While there is no active admin, the next account registered becomes the admin.";

/**
 * Boot check: logs NO_ACTIVE_ADMIN_WARNING when accounts exist but none is an active admin. An
 * empty database is a fresh install (the first registration becomes the admin) and stays quiet.
 */
export function warnIfNoActiveAdmin(warn: (message: string) => void = console.warn) {
  if (hasActiveAdmin() || !db.query("SELECT 1 FROM users LIMIT 1").get()) return false;
  warn(NO_ACTIVE_ADMIN_WARNING);
  return true;
}

/**
 * D76: the first registered account is the admin, and so is one registered while there is no active
 * admin at all (an upgraded database whose accounts were all disabled). Call inside the register
 * transaction.
 */
export function recordBootstrapAdmin(userId: string, timestamp: string) {
  recordEvent(userId, null, "bootstrap", "bootstrap_admin", { toRole: "admin" }, timestamp);
  audit(userId, null, "team.bootstrap_admin", { targetId: userId });
}

const otherActiveAdmins = (userId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM users WHERE id <> ? AND role = 'admin' AND disabled_at IS NULL").get(userId) as { count: number }).count;

type TargetRow = Pick<UserRow, "id" | "role" | "disabled_at">;
const loadTarget = (userId: string) => db.query("SELECT id, role, disabled_at FROM users WHERE id = ?").get(userId) as TargetRow | null;

function requireManager(actor: TeamActor) {
  if (actor && !can(actor.role, "team.manage")) throw new TeamError(403, "ADMIN_ONLY", "Only admins can manage the team");
}

/** Runs a write transaction, turning the trigger's LAST_ADMIN abort into the API error. */
function write<T>(operation: () => T): T {
  try {
    return db.transaction(operation)();
  } catch (error) {
    if (error instanceof Error && !(error instanceof TeamError) && error.message.includes("LAST_ADMIN")) throw lastAdmin();
    throw error;
  }
}

/** Whether the user is in a group that has at least one grant. */
const inGrantedGroup = (userId: string) =>
  Boolean(db.query("SELECT 1 FROM group_members gm WHERE gm.user_id = ? AND EXISTS (SELECT 1 FROM group_grants gg WHERE gg.group_id = gm.group_id) LIMIT 1").get(userId));

const auditMeta = (via: TeamVia, extra: Record<string, unknown>) => ({ ...extra, via });

/**
 * Changes a role with a compare-and-swap on `expectedRole` (T79). No re-authentication (operator
 * decision 2026-09-27). An admin may demote themselves only while another active admin exists.
 *
 * With `share_with_guests` off, making someone a guest while they are in a group that has a grant
 * is refused (400 GUEST_SHARE_DISABLED, T213), like adding a guest to that group: the admin removes
 * them from those groups first. Direct shares owners made before are existing shares and stay (the
 * policy is not retroactive; admins cannot change other people's shares, D73).
 */
export function setRole(actor: TeamActor, targetId: string, input: { role: Role; expectedRole: Role }, options: { via: TeamVia }) {
  requireManager(actor);
  return write(() => {
    const target = loadTarget(targetId);
    if (!target) throw notFound();
    if (target.role !== input.expectedRole) {
      throw new TeamError(409, "ROLE_CHANGED", "This role was changed by someone else. Review it and try again.", { currentRole: target.role });
    }
    if (target.role === input.role) return { changed: false as const, role: target.role };
    if (target.role === "admin" && target.disabled_at === null && otherActiveAdmins(target.id) === 0) throw lastAdmin();
    if (input.role === "guest" && !readPolicies().shareWithGuests && inGrantedGroup(target.id)) {
      throw new TeamError(400, "GUEST_SHARE_DISABLED", "Sharing with guests is turned off for this Nook. Remove this person from groups that are shared with items first.");
    }
    const result = db.query("UPDATE users SET role = ? WHERE id = ? AND role = ?").run(input.role, target.id, target.role);
    if (result.changes !== 1) throw new TeamError(409, "ROLE_CHANGED", "This role was changed by someone else. Review it and try again.", { currentRole: userRole(target.id) });
    recordEvent(target.id, actor, options.via, "role_change", { fromRole: target.role, toRole: input.role });
    // Agent inbox D152: a read-only role cannot use routines, so they pause (resume after a promotion).
    if (input.role === "viewer" || input.role === "guest") pauseRoutinesOf(target.id);
    audit(actor?.id ?? null, null, "team.role_changed", auditMeta(options.via, { targetId: target.id, fromRole: target.role, toRole: input.role }));
    // Security mail (outbound email #2), coalesced 10 min; a toggle back sends nothing.
    mailRoleChanged(target.id, target.role, actor?.id ?? null);
    return { changed: true as const, role: input.role };
  });
}

/**
 * Blocks an account (D77): sets the block, deletes every session (an unblock does not revive
 * them), and removes push subscriptions, in one transaction. MCP keys and feed tokens pause and
 * resume on unblock (O9).
 */
export function blockUser(actor: TeamActor, targetId: string, reason: string | null, options: { via: TeamVia }) {
  requireManager(actor);
  const cleanReason = reason?.trim() ? reason.trim().slice(0, BLOCK_REASON_MAX) : null;
  return write(() => {
    const target = loadTarget(targetId);
    if (!target) throw notFound();
    if (actor && actor.id === target.id) throw new TeamError(409, "SELF_ACTION", "You cannot block your own account");
    if (target.disabled_at !== null) throw new TeamError(409, "ALREADY_BLOCKED", "This account is already blocked");
    if (target.role === "admin" && otherActiveAdmins(target.id) === 0) throw lastAdmin();
    const timestamp = now();
    const result = db.query("UPDATE users SET disabled_at = ?, blocked_by = ?, block_reason = ? WHERE id = ? AND disabled_at IS NULL AND role = ?")
      .run(timestamp, actor?.id ?? null, cleanReason, target.id, target.role);
    if (result.changes !== 1) throw new TeamError(409, "ROLE_CHANGED", "This account changed while you were blocking it. Review it and try again.", { currentRole: userRole(target.id) });
    const sessions = db.query("DELETE FROM sessions WHERE user_id = ?").run(target.id).changes;
    revokeUserPushSubscriptions(target.id, "user_blocked");
    recordEvent(target.id, actor, options.via, "block", { reason: cleanReason }, timestamp);
    audit(actor?.id ?? null, null, "team.user_blocked", auditMeta(options.via, { targetId: target.id, sessions }));
    // Security mail (#3), without the admin's reason (O11).
    mailAccountEvent(target.id, "blocked", actor?.id ?? null);
    const pausedKeys = (db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").get(target.id) as { count: number }).count;
    return { blockedAt: timestamp, sessionsRevoked: sessions, mcpKeysPaused: pausedKeys };
  });
}

/** Lifts a block. Old sessions stay deleted; keys and feeds resume; the role is unchanged (§4.2). */
export function unblockUser(actor: TeamActor, targetId: string, options: { via: TeamVia }) {
  requireManager(actor);
  return write(() => {
    const target = loadTarget(targetId);
    if (!target) throw notFound();
    if (target.disabled_at === null) throw new TeamError(409, "NOT_BLOCKED", "This account is not blocked");
    const result = db.query("UPDATE users SET disabled_at = NULL, blocked_by = NULL, block_reason = NULL WHERE id = ? AND disabled_at IS NOT NULL").run(target.id);
    if (result.changes !== 1) throw new TeamError(409, "NOT_BLOCKED", "This account is not blocked");
    recordEvent(target.id, actor, options.via, "unblock");
    audit(actor?.id ?? null, null, "team.user_unblocked", auditMeta(options.via, { targetId: target.id }));
    mailAccountEvent(target.id, "unblocked", actor?.id ?? null);
    return { ok: true as const };
  });
}

/** Signs an account out everywhere without blocking it. Admins sign themselves out from Settings. */
export function revokeSessions(actor: TeamActor, targetId: string, options: { via: TeamVia }) {
  requireManager(actor);
  return write(() => {
    const target = loadTarget(targetId);
    if (!target) throw notFound();
    if (actor && actor.id === target.id) throw new TeamError(409, "SELF_ACTION", "Use Sign out to end your own session");
    const sessions = db.query("DELETE FROM sessions WHERE user_id = ?").run(target.id).changes;
    revokeUserPushSubscriptions(target.id, "sessions_revoked");
    recordEvent(target.id, actor, options.via, "sessions_revoked");
    audit(actor?.id ?? null, null, "team.sessions_revoked", auditMeta(options.via, { targetId: target.id, sessions }));
    mailAccountEvent(target.id, "sessions_revoked", actor?.id ?? null);
    return { sessionsRevoked: sessions };
  });
}
