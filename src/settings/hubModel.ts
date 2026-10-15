// The Settings hub (Wave 37): which entries its left nav lists for a role, which entry a route
// selects, and where the phone's back arrow goes. Pure, so it is unit tested directly.
import { readHistoryDepth } from "../appShellNavigation";
import type { AiTab, KeysTab, Route, SettingsSection } from "../router";
import { AI_TAB_LABELS, AI_TABS, aiTabPath, formatRoute, KEYS_TABS, keysTabPath, SETTINGS_SECTION_NAMES } from "../router";
import { canManageTeam, canSeeTeam, type Role } from "../team/teamRoles";

export type TeamEntryId = "members" | "invites" | "groups" | "integrations" | "keys" | "policies" | "templates" | "activity" | "email";
export type HubEntryId = SettingsSection | "bin" | `team-${TeamEntryId}`;
/**
 * `badge` (Wave 38): a count shown beside the label (the Bin's items; Members' blocked accounts), and
 * `badgeNoun` names what is counted for assistive tech ("Bin, 3 items"; "Members, 1 blocked account").
 */
export type HubEntry = { id: HubEntryId; group: "account" | "workspace" | "team"; label: string; route: Route; badge?: number; badgeNoun?: string };

/** The Bin's entry (Wave 38): its own Workspace group between Account and Team. */
const BIN_ENTRY: HubEntry = { id: "bin", group: "workspace", label: "Bin", route: { app: "bin" } };

type TeamRoute = Extract<Route, { app: "team" }>;
const team = (flags: Partial<TeamRoute> = {}): TeamRoute => ({ app: "team", userId: null, ...flags });

/** Account entries, in nav order. My access, Agents, and Knowledge are for every role but guest; AI is for admins. */
const ACCOUNT_ORDER: readonly SettingsSection[] = ["security", "notifications", "access", "mcp", "agents", "knowledge", "ai", "datasources", "reportowners", "modules", "about"];
// Report data sources (Wave 45) and Report owners (D500) are for admins too.
const ADMIN_ONLY_SECTIONS: readonly SettingsSection[] = ["ai", "datasources", "reportowners"];

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
 * Whether the hub shows its Bin entry (Wave 38): while the Bin module is on, for everyone but guests.
 * A guest can delete nothing, so their Bin is always empty; its URL opens Security, as with the
 * module off.
 */
export function binEntryShown(role: Role | undefined, binModuleEnabled: boolean) {
  return binModuleEnabled && role !== "guest";
}

/**
 * The hub's nav entries for a role. While two-factor setup is required, Security is the only one.
 * The Bin (Wave 38) is for every role but guest (viewers read theirs) while the Bin module is on;
 * `blockedCount` (review L1) is the badge on Members for the roles that manage the team.
 */
export function hubEntries(role: Role | undefined, options: { teamModuleEnabled: boolean; binModuleEnabled?: boolean; setupRequired?: boolean; binCount?: number; blockedCount?: number }): HubEntry[] {
  if (options.setupRequired) return [{ id: "security", group: "account", label: SETTINGS_SECTION_NAMES.security, route: { app: "settings", section: "security" } }];
  const account: HubEntry[] = ACCOUNT_ORDER
    .filter((section) => (section !== "access" && section !== "agents" && section !== "knowledge") || role !== "guest")
    .filter((section) => !ADMIN_ONLY_SECTIONS.includes(section) || role === "admin")
    .map((section) => ({ id: section, group: "account", label: SETTINGS_SECTION_NAMES[section], route: { app: "settings", section } }));
  const workspace: HubEntry[] = !binEntryShown(role, options.binModuleEnabled !== false) ? [] : [options.binCount ? { ...BIN_ENTRY, badge: options.binCount } : BIN_ENTRY];
  if (!teamGroupShown(role, options.teamModuleEnabled)) return [...account, ...workspace];
  const admin = canManageTeam(role);
  const team = TEAM_ENTRIES.filter((entry) => admin || !entry.adminOnly).map((entry): HubEntry => ({ id: `team-${entry.id}`, group: "team", label: entry.label, route: entry.route }));
  if (admin && options.blockedCount) team[0] = { ...team[0]!, badge: options.blockedCount, badgeNoun: "blocked account" };
  return [...account, ...workspace, ...team];
}

/** Where a Team link opens: the first Team entry the role has, Members for everyone. */
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
  if (route.app === "bin") return "bin";
  return null;
}

/** The nav label of an entry. */
export function hubEntryLabel(id: HubEntryId): string {
  if (id === "bin") return BIN_ENTRY.label;
  if (id.startsWith("team-")) return TEAM_ENTRIES.find((entry) => `team-${entry.id}` === id)?.label ?? "Team";
  return SETTINGS_SECTION_NAMES[id as SettingsSection];
}

/**
 * A Team page below a section (a member, their access, a group, an integration): it brings its own
 * back button to the section, so the hub's phone back arrow (to the list) is not shown over it.
 */
export function isNestedHubRoute(route: Route) {
  if (route.app === "settings") return (route.section === "agents" && Boolean(route.agentId)) || (route.section === "knowledge" && Boolean(route.kbId));
  return route.app === "team" && Boolean(route.userId || route.groupId || route.integrationId);
}

/** Whether a route is one of the hub's (an account section, the list, the Bin, or a Team section). */
export const isHubRoute = (route: Route) => route.app === "settings" || route.app === "team" || route.app === "bin";

/** The account section the Home tile, the header button, and a hint open. */
export const settingsRoute = (section: SettingsSection | null = null): Route => ({ app: "settings", section });

/**
 * The id of the hub's page heading (SettingsHubShell's h1, the section's name). v0.31 follow-up: an
 * account section is labelled by it instead of repeating its name in an h3 of its own.
 */
export const HUB_TITLE_ID = "settings-hub-title";

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

/**
 * The URLs of a section's tabs, which sit side by side in one section: API keys' (/settings/keys/:tab)
 * and, since the v0.31 follow-ups, Settings → AI's (/settings/ai/:tab).
 */
const TAB_URLS: ReadonlySet<string> = new Set([...KEYS_TABS.map(keysTabPath), ...AI_TABS.map(aiTabPath)]);
/** The URLs an entry was pushed over, nearest first (App's PUSHED_OVER_CHAIN_KEY; kept in step by tests/keysTabs.test.tsx). */
export const HUB_PUSHED_OVER_CHAIN_KEY = "mynotes.pushed-over-chain";

/**
 * Phones: how many entries the section's back arrow steps back to reach the section list, when this
 * section was opened from it in this visit and then moved only between its tabs (API keys' or
 * Settings → AI's; each tab is an entry); 0 otherwise (the list replaces the section, as
 * hubBackAction's "list"). The chain is the URLs each entry was pushed over (App's
 * PUSHED_OVER_CHAIN_KEY), nearest first.
 */
export function hubBackSteps(state: unknown): number {
  if (hubBackAction(state) === "history") return 1;
  const entry = state && typeof state === "object" ? state as Record<string, unknown> : null;
  const chain = Array.isArray(entry?.[HUB_PUSHED_OVER_CHAIN_KEY]) ? entry![HUB_PUSHED_OVER_CHAIN_KEY] as unknown[] : [];
  const depth = readHistoryDepth(entry);
  for (let index = 0; index < chain.length && index < depth; index += 1) {
    const url = chain[index];
    if (url === "/settings") return index + 1;
    if (typeof url !== "string" || !TAB_URLS.has(url)) return 0;
  }
  return 0;
}

/** Whether two routes are API keys' tabs (a move between them is a tab switch, not a section change). */
export const isKeysTabMove = (target: Route, current: Route) =>
  target.app === "settings" && target.section === "mcp" && current.app === "settings" && current.section === "mcp";

/**
 * The route the hub shows after Back or Forward (review M2): the hub route on the URL, or null to
 * keep the screen (not a hub route, a Team entry while the role's Team group is hidden, or the Bin
 * while its entry is hidden: the route gate skips that entry, D92, and the hub reads the URL again
 * once that move settled; at depth 0 the gate replaces it with Security).
 */
export function hubPopRoute(route: Route, teamShown: boolean, binShown = true): Route | null {
  if (!isHubRoute(route)) return null;
  if (route.app === "team" && !teamShown) return null;
  if (route.app === "bin" && !binShown) return null;
  return route;
}

/**
 * The leave guard's wording for a browser move it undid (review L2): "tab" between API keys' tabs,
 * "section" when the move went to another hub screen, "leave" when it leaves Settings (another app, or off the landing entry's
 * sentinel, where the URL still reads the page's own).
 */
export function leaveGuardAction(target: Route, current: Route): "section" | "tab" | "leave" {
  if (isKeysTabMove(target, current) && formatRoute(target) !== formatRoute(current)) return "tab";
  return isHubRoute(target) && formatRoute(target) !== formatRoute(current) ? "section" : "leave";
}

/**
 * Phones (review L4/Q1): a hub section opened from outside the hub (a Team link, "Open Bin", "Turn on in
 * Settings", a notification, a deep link) gets the section list pushed under it first, so browser
 * Back and the section's back arrow agree (both return to the list, then to where Settings was
 * opened) and Forward reopens the section. One extra entry per visit, none within the hub.
 */
export function hubListGoesUnder(target: Route, current: Route, mobile: boolean) {
  return mobile && isHubRoute(target) && !(target.app === "settings" && target.section === null) && !isHubRoute(current);
}

/** Settings → AI's tab labels (kept in the router, beside the document title that uses them). */
export { AI_TAB_LABELS };

/**
 * The Settings → AI tabs a role sees, in tab order. The whole page is for admins (its nav entry and
 * App's gate; the server's /agents/admin routes check the same), so admins see every tab and anyone
 * else none.
 */
export function aiTabsFor(role: Role | undefined): AiTab[] {
  return role === "admin" ? [...AI_TABS] : [];
}

/**
 * Where a Settings → AI route goes instead (replaced in place): bare /settings/ai, an unknown tab
 * (parsed as bare AI), or a tab the role does not see opens the first tab it sees. Null to stay, or
 * when the role sees no tab (the page says it is for admins).
 */
export function aiTabRedirect(route: Route, role: Role | undefined): Route | null {
  if (route.app !== "settings" || route.section !== "ai") return null;
  const tabs = aiTabsFor(role);
  const first = tabs[0];
  if (!first || (route.aiTab && tabs.includes(route.aiTab))) return null;
  return { app: "settings", section: "ai", aiTab: first };
}

/** What turns API keys' tabs on: the Vault (`features.vault`) and Chat (`features.agents`). */
export type KeysTabFeatures = { vault: boolean; agents: boolean };

/** The API keys tabs on show, in tab order: General always; Vault with the Vault on; Agents while Chat is available. */
export function keysTabsFor(features: KeysTabFeatures): KeysTab[] {
  return KEYS_TABS.filter((tab) => tab === "general" || (tab === "vault" ? features.vault : features.agents));
}

/**
 * Where an API keys route goes instead (replaced in place), as Settings → AI: bare /settings/keys (and
 * /settings/mcp), an unknown tab, or a hidden one (the Vault or Chat off) opens General. Null to stay.
 */
export function keysTabRedirect(route: Route, features: KeysTabFeatures): Route | null {
  if (route.app !== "settings" || route.section !== "mcp") return null;
  if (route.keysTab && keysTabsFor(features).includes(route.keysTab)) return null;
  return { app: "settings", section: "mcp", keysTab: "general" };
}
