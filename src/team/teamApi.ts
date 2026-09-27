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

export type TeamMemberDetail = TeamMember & { events?: TeamEvent[] };

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
