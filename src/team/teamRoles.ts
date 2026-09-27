/**
 * Team roles as the client shows them. Mirrors server/team/roles.ts (tests/teamClient.test.tsx keeps
 * them in step). The platform role is always labelled "Team role" in copy, so it never reads like
 * the per-item "View only" share role of Collections and Calendar (plan §2.4).
 */
export type Role = "admin" | "member" | "viewer" | "guest";

export const ROLES: readonly Role[] = ["admin", "member", "viewer", "guest"];
/** Roles an admin can assign: all four (viewer and guest are enforced since Wave 15). */
export const SELECTABLE_ROLES: readonly Role[] = ROLES;

export const ROLE_LABELS: Record<Role, string> = { admin: "Admin", member: "Member", viewer: "Viewer", guest: "Guest" };

/** One line per role, from the permission matrix (Team plan §2.2). */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Everything a member can do, plus managing the team: roles, blocking, and sign-outs",
  member: "Creates, edits, and shares notes, files, tasks, collections, and events",
  viewer: "Reads what is shared with them or with everyone; creates, edits, and shares nothing",
  guest: "Reads only what is shared with them by name; no Team list and no API keys"
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

/** Who can open Team at all (guests cannot, O7). */
export const canSeeTeam = (role: Role | undefined) => role !== undefined && role !== "guest";
export const canManageTeam = (role: Role | undefined) => role === "admin";

/** The Team role picker's options (the shared Select, D91): every role with its one-line description. */
export const roleOptions = () => ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
  description: ROLE_DESCRIPTIONS[role],
  disabled: !SELECTABLE_ROLES.includes(role)
}));

/** Whether a Team role writes content (members and admins); viewers and guests only read. */
export const canWriteContent = (role: Role | undefined) => role === undefined || role === "admin" || role === "member";

/** The share picker's hint next to a recipient who will only read (§2.2 notes); null for writers. */
export const shareRoleHint = (role: Role | undefined) => role === "viewer" || role === "guest" ? ROLE_LABELS[role] : null;
