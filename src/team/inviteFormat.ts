/**
 * Pure helpers for Team invites (docs/plan/WAVES_18-20_SMALL.md §1.6). No DOM, so
 * tests/teamInvitesClient.test.tsx checks them directly.
 */
import type { InviteRole, InviteStatus, TeamInvite } from "./teamApi";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "./teamRoles";

export const INVITE_ROLES: readonly InviteRole[] = ["member", "viewer", "guest"];
/** The create dialog's default (Q4): Guest, mirroring the SIGNUP_ROLE default. */
export const DEFAULT_INVITE_ROLE: InviteRole = "guest";
export const EXPIRY_DAYS = ["1", "3", "7"] as const;
export type ExpiryDays = typeof EXPIRY_DAYS[number];
export const DEFAULT_EXPIRY: ExpiryDays = "7";

export const inviteRoleOptions = () => INVITE_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role] }));
export const expiryOptions = () => EXPIRY_DAYS.map((days) => ({ value: days, label: days === "1" ? "1 day" : `${days} days` }));

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = { live: "Live", used: "Used", expired: "Expired", revoked: "Revoked" };

/** "a Viewer" / "a Member" / "a Guest". */
export const withArticle = (role: InviteRole) => `a ${ROLE_LABELS[role]}`;

function days(fromMs: number, toMs: number) {
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

/** The time line of an invite card: "Expires in 6 days", "Used by Asha", "Revoked", "Expired". */
export function inviteTimeLabel(invite: TeamInvite, nowMs = Date.now()) {
  if (invite.status === "used") return invite.usedBy ? `Used by ${invite.usedBy.displayName}` : "Used";
  if (invite.status === "revoked") return "Revoked";
  if (invite.status === "expired") return "Expired";
  const left = Date.parse(invite.expiresAt) - nowMs;
  if (left < 3_600_000) return "Expires within an hour";
  if (left < 86_400_000) return `Expires in ${Math.round(left / 3_600_000)} hours`;
  const count = days(nowMs, Date.parse(invite.expiresAt));
  return `Expires in ${count} day${count === 1 ? "" : "s"}`;
}

/** The warning under a new link (§1.6). */
export function shownOnceWarning(role: InviteRole, expiresAt: string) {
  const date = new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `This link is shown once. Anyone with it can create ${withArticle(role)} account until ${date}.`;
}

/** Why "New invite" is unavailable, or null. */
export function inviteLimitHint(liveCount: number, liveLimit: number) {
  return liveCount >= liveLimit ? `${liveLimit} invites are live, the most Nook allows. Revoke one or wait for one to expire.` : null;
}
