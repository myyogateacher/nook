/**
 * Pure helpers for the Team app: filtering, labels, and the activity copy. No DOM, so they are
 * unit-tested directly (tests/teamClient.test.tsx).
 */
import type { JoinedWithInvite, TeamEvent, TeamMember } from "./teamApi";
import { ROLE_LABELS, type Role } from "./teamRoles";

export type TeamFilter = "all" | "admin" | "member" | "viewer" | "guest" | "blocked";

const FILTER_LABELS: Record<TeamFilter, string> = { all: "All", admin: "Admins", member: "Members", viewer: "Viewers", guest: "Guests", blocked: "Blocked" };

/** Accounts younger than this get a "New" tag (plan §8). */
export const NEW_ACCOUNT_MS = 7 * 86_400_000;

export const isNewAccount = (createdAt: string, now = Date.now()) => now - Date.parse(createdAt) < NEW_ACCOUNT_MS;

export function matchesFilter(member: TeamMember, filter: TeamFilter) {
  if (filter === "all") return true;
  if (filter === "blocked") return member.status === "blocked";
  return member.role === filter;
}

/** Client-side search over name and (for admins, who receive it) email. */
export function filterTeam(members: readonly TeamMember[], filter: TeamFilter, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return members.filter((member) => matchesFilter(member, filter)
    && (!needle || member.displayName.toLocaleLowerCase().includes(needle) || Boolean(member.email?.toLocaleLowerCase().includes(needle))));
}

/**
 * The filter chips to show: All, Admins, Members, and Blocked always (Blocked only for admins, who
 * manage blocks); Viewers and Guests only once someone holds that role.
 */
export function teamFilters(members: readonly TeamMember[], admin: boolean): Array<{ value: TeamFilter; label: string; count: number }> {
  const values: TeamFilter[] = ["all", "admin", "member"];
  for (const role of ["viewer", "guest"] as const) if (members.some((member) => member.role === role)) values.push(role);
  if (admin || members.some((member) => member.status === "blocked")) values.push("blocked");
  return values.map((value) => ({ value, label: FILTER_LABELS[value], count: members.filter((member) => matchesFilter(member, value)).length }));
}

/** The status chip: "Blocked", or "Blocked (before Team)" for accounts disabled before migration 017. */
export function statusLabel(member: TeamMember) {
  if (member.status !== "blocked") return "Active";
  return member.blockedAt && member.blockedBy === null ? "Blocked (before Team)" : "Blocked";
}

export const initialOf = (name: string) => (name.trim()[0] ?? "?").toLocaleUpperCase();

const roleName = (role: Role | null) => (role ? ROLE_LABELS[role] : "none");

/** One line of the Activity list, without the time. */
export function eventLabel(event: TeamEvent) {
  const by = event.via === "cli" ? " from the host command line"
    : event.via === "migration" ? " during the upgrade"
    : event.via === "bootstrap" ? ""
    : event.actor ? ` by ${event.actor.displayName}` : " by a former account";
  switch (event.action) {
    case "bootstrap_admin":
      return event.via === "migration" ? "Became admin as the oldest account during the upgrade" : "Became admin as the first account";
    case "role_change":
      return `Team role changed from ${roleName(event.fromRole)} to ${roleName(event.toRole)}${by}`;
    case "block":
      return `Blocked${by}`;
    case "unblock":
      return `Unblocked${by}`;
    case "sessions_revoked":
      return `Signed out everywhere${by}`;
  }
}

export type TeamBackAction = { kind: "history" } | { kind: "list" } | { kind: "home" };

/**
 * The in-app Back from the Team app: step back through an entry this visit pushed, otherwise
 * replace a deep-linked detail with the list, otherwise go Home (Back never leaves Nook).
 */
export function teamBackAction(userId: string | null, depth: number): TeamBackAction {
  if (depth > 0) return { kind: "history" };
  return userId ? { kind: "list" } : { kind: "home" };
}

/** Why the role picker or an action is unavailable, or null. */
export function lastAdminReason(member: TeamMember, members: readonly TeamMember[]) {
  if (member.role !== "admin" || member.status !== "active") return null;
  const others = members.filter((other) => other.id !== member.id && other.role === "admin" && other.status === "active").length;
  return others === 0 ? "Nook needs at least one admin. Make someone else an admin first." : null;
}

/** D165: the Activity line for an account created from an invite (derived from team_invites). */
export function joinedLabel(joined: JoinedWithInvite) {
  return `Joined with an invite${joined.invitedBy ? ` from ${joined.invitedBy.displayName}` : ""}, as ${ROLE_LABELS[joined.role]}`;
}
