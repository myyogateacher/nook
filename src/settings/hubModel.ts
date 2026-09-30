// The Settings hub (Wave 37): which entries its left nav lists for a role, which entry a route
// selects, and where the phone's back arrow goes. Pure, so it is unit tested directly.
import { readHistoryDepth } from "../appShellNavigation";
import type { Route, SettingsSection } from "../router";
import { SETTINGS_SECTION_NAMES } from "../router";
import { canManageTeam, canSeeTeam, type Role } from "../team/teamRoles";

export type TeamEntryId = "members" | "invites" | "groups" | "integrations" | "keys" | "policies" | "templates" | "activity" | "email";
export type HubEntryId = SettingsSection | `team-${TeamEntryId}`;
export type HubEntry = { id: HubEntryId; group: "account" | "team"; label: string; route: Route };

type TeamRoute = Extract<Route, { app: "team" }>;
const team = (flags: Partial<TeamRoute> = {}): TeamRoute => ({ app: "team", userId: null, ...flags });

/** Account entries, in nav order. My access is for every role but guest. */
const ACCOUNT_ORDER: readonly SettingsSection[] = ["security", "notifications", "access", "mcp", "modules", "about"];

/** Team entries, in nav order. Only Members is for every role that sees Team; the rest are admins only. */
const TEAM_ENTRIES: ReadonlyArray<{ id: TeamEntryId; label: string; route: TeamRoute; adminOnly: boolean }> = [
  { id: "members", label: "Members", route: team(), adminOnly: false },
  { id: "invites", label: "Invites", route: team({ invites: true }), adminOnly: true },
  { id: "groups", label: "Groups", route: team({ groups: true }), adminOnly: true },
  { id: "integrations", label: "Integrations", route: team({ integrations: true }), adminOnly: true },
  { id: "keys", label: "Keys", route: team({ keys: true }), adminOnly: true },
  { id: "policies", label: "Policies", route: team({ policies: true }), adminOnly: true },
  { id: "templates", label: "Templates", route: team({ templates: true }), adminOnly: true },
  { id: "activity", label: "Access activity", route: team({ activity: true }), adminOnly: true },
  { id: "email", label: "Email log", route: team({ email: true }), adminOnly: true }
];

/**
 * Whether the hub shows its Team group. Admins always keep it, even with the Team module turned off
 * (Team plan §6.2: it was "Manage team" in the Settings dialog before); members and viewers see it
 * while Team is on; guests never.
 */
export function teamGroupShown(role: Role | undefined, teamModuleEnabled: boolean) {
  return canManageTeam(role) || (canSeeTeam(role) && teamModuleEnabled);
}

/**
 * The hub's nav entries for a role. While two-factor setup is required, Security is the only one.
 */
export function hubEntries(role: Role | undefined, options: { teamModuleEnabled: boolean; setupRequired?: boolean }): HubEntry[] {
  if (options.setupRequired) return [{ id: "security", group: "account", label: SETTINGS_SECTION_NAMES.security, route: { app: "settings", section: "security" } }];
  const account: HubEntry[] = ACCOUNT_ORDER
    .filter((section) => section !== "access" || role !== "guest")
    .map((section) => ({ id: section, group: "account", label: SETTINGS_SECTION_NAMES[section], route: { app: "settings", section } }));
  if (!teamGroupShown(role, options.teamModuleEnabled)) return account;
  const admin = canManageTeam(role);
  return [...account, ...TEAM_ENTRIES.filter((entry) => admin || !entry.adminOnly).map((entry): HubEntry => ({ id: `team-${entry.id}`, group: "team", label: entry.label, route: entry.route }))];
}

/** Where the Team button (and a Team link) opens: the first Team entry the role has, Members for everyone. */
export function firstTeamRoute(): Route {
  return team();
}

/** The Team entry a Team route belongs to (a member and their access are Members; a group is Groups). */
export function teamEntryOf(route: TeamRoute): TeamEntryId {
  if (route.userId) return "members";
  if (route.invites) return "invites";
  if (route.groups) return "groups";
  if (route.integrations) return "integrations";
  if (route.keys) return "keys";
  if (route.policies) return "policies";
  if (route.templates) return "templates";
  if (route.activity) return "activity";
  if (route.email) return "email";
  return "members";
}

/**
 * The entry a hub route selects. The bare /settings (the section list on phones) shows Security on
 * a computer, so it selects Security there; `null` only means "the list" to the phone layout.
 */
export function hubEntryOf(route: Route): HubEntryId | null {
  if (route.app === "settings") return route.section;
  if (route.app === "team") return `team-${teamEntryOf(route)}`;
  return null;
}

/** The nav label of an entry. */
export function hubEntryLabel(id: HubEntryId): string {
  if (id.startsWith("team-")) return TEAM_ENTRIES.find((entry) => `team-${entry.id}` === id)?.label ?? "Team";
  return SETTINGS_SECTION_NAMES[id as SettingsSection];
}

/**
 * A Team page below a section (a member, their access, a group, an integration): it brings its own
 * back button to the section, so the hub's phone back arrow (to the list) is not shown over it.
 */
export function isNestedHubRoute(route: Route) {
  return route.app === "team" && Boolean(route.userId || route.groupId || route.integrationId);
}

/** Whether a route is one of the hub's (an account section, the list, or a Team section). */
export const isHubRoute = (route: Route) => route.app === "settings" || route.app === "team";

/** The account section the Home tile, the header button, and a hint open. */
export const settingsRoute = (section: SettingsSection | null = null): Route => ({ app: "settings", section });

/** The URL an entry was pushed over (App's PUSHED_OVER_KEY; kept in step by tests/settingsHub.test.tsx). */
export const HUB_PUSHED_OVER_KEY = "mynotes.pushed-over";

/**
 * Phones: the section's back arrow. "history" when this entry was pushed over the section list in this
 * visit (so it is exactly browser Back, and Forward reopens the section); "list" otherwise (a deep link,
 * or a section opened from elsewhere), where the list replaces the section.
 */
export function hubBackAction(state: unknown): "history" | "list" {
  const entry = state && typeof state === "object" ? state as Record<string, unknown> : null;
  return readHistoryDepth(entry) > 0 && entry?.[HUB_PUSHED_OVER_KEY] === "/settings" ? "history" : "list";
}
