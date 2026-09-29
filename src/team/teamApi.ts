import { api } from "../api";
import type { Role } from "./teamRoles";

/** GET /api/team rows (docs/plan/API_CONTRACTS.md, Team). Admin-only fields are absent for others. */
export type TeamMember = {
  id: string;
  displayName: string;
  role: Role;
  status: "active" | "blocked";
  createdAt: string;
  isYou: boolean;
  /** Wave 35 (D299): a same-origin picture, or null (older servers leave it out) for the letter. */
  avatarUrl?: string | null;
  email?: string;
  lastSeenAt?: string | null;
  blockedAt?: string | null;
  blockedBy?: { id: string; displayName: string } | null;
  blockReason?: string | null;
  totpEnabled?: boolean;
  mcpKeys?: { live: number };
  storageBytes?: number;
  emailAllowed?: boolean;
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

/** Admin detail only (D165): how the account joined, derived from team_invites. */
export type JoinedWithInvite = { role: InviteRole; usedAt: string; invitedBy: { id: string; displayName: string } | null };

export type TeamMemberDetail = TeamMember & { events?: TeamEvent[]; joinedWithInvite?: JoinedWithInvite | null };

/** Invite roles (D163): never admin. */
export type InviteRole = Exclude<Role, "admin">;
export type InviteStatus = "live" | "used" | "expired" | "revoked";

/** GET /api/team/invites rows (docs/plan/API_CONTRACTS.md, Team → Invites). Never carries the token. */
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
  /** The template snapshot this invite applies: its name and group count when the invite was made; `edited` when the template changed since. */
  template?: { id: string; name: string; groupCount: number; edited: boolean; guestSkipped?: string[] } | null;
};

/** `emailEnabled`: whether mail is configured on the server (RESEND_API_KEY and MAIL_FROM). */
export type TeamInviteList = { invites: TeamInvite[]; liveCount: number; liveLimit: number; emailEnabled?: boolean };
export type CreateInviteBody = { role: InviteRole; email?: string; expiresInDays?: number; note?: string; sendEmail?: boolean; templateId?: string };
export type MailOutcome = { sent: true; id: string } | { sent: false; reason: "not_configured" | "rate_limited" | "failed" };

const memberPath = (userId: string) => `/team/${encodeURIComponent(userId)}`;

export const listTeam = () => api<{ me: { id: string; role: Role }; users: TeamMember[] }>("/team");
export const getTeamMember = (userId: string) => api<{ member: TeamMemberDetail }>(memberPath(userId));
export const setTeamRole = (userId: string, body: { role: Role; expectedRole: Role }) =>
  api<{ changed: boolean; role: Role; member: TeamMemberDetail }>(`${memberPath(userId)}/role`, { method: "PUT", body: JSON.stringify(body) });
export const blockTeamMember = (userId: string, body: { reason?: string }) =>
  api<{ blockedAt: string; sessionsRevoked: number; mcpKeysPaused: number; member: TeamMemberDetail }>(`${memberPath(userId)}/block`, { method: "POST", body: JSON.stringify(body) });
export const unblockTeamMember = (userId: string) =>
  api<{ ok: true; member: TeamMemberDetail }>(`${memberPath(userId)}/unblock`, { method: "POST", body: "{}" });
export const revokeTeamSessions = (userId: string) =>
  api<{ sessionsRevoked: number; member: TeamMemberDetail }>(`${memberPath(userId)}/sessions/revoke`, { method: "POST", body: "{}" });

export const listTeamInvites = () => api<TeamInviteList>("/team/invites");
/** The token and link come back from this call only (D161). */
export const createTeamInvite = (body: CreateInviteBody) =>
  api<{ invite: TeamInvite; token: string; url: string; email?: MailOutcome }>("/team/invites", { method: "POST", body: JSON.stringify(body) });
/** Mails a fresh link to the invite's bound address; the old link stops working once it is sent. */
export const emailTeamInvite = (inviteId: string) =>
  api<{ invite: TeamInvite; email: MailOutcome }>(`/team/invites/${encodeURIComponent(inviteId)}/email`, { method: "POST", body: "{}" });
export const revokeTeamInvite = (inviteId: string) =>
  api<{ invite: TeamInvite }>(`/team/invites/${encodeURIComponent(inviteId)}/revoke`, { method: "POST", body: "{}" });
