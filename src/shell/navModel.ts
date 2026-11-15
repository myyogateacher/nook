import { Bell, House, Inbox, Search, Settings, type LucideIcon } from "lucide-react";
import type { AppSection } from "../appShellNavigation";
import { hiddenModuleForApp, MODULES, normalizeDisabledModules, unavailableModules, type ModuleId } from "../modules";
import type { Role } from "../team/teamRoles";
import { readyWorkspaceModules } from "../workspaceModules/registry";
import { isWorkspaceModuleId, type WorkspaceModuleId } from "../workspaceModules/types";

/**
 * The global sidebar's tree (docs/plan/LEFT_NAV.md §2.1, §3; D1270). A pure function of the person's
 * module preferences, the server's features, their role, and the app on screen, so the sidebar shows
 * exactly the apps Home's launcher does today: the module registry's launcher entries in `MODULES`
 * order, without modules that are off (`disabledModules`), that the server does not offer this person
 * (`unavailableModules`: the Vault, Chat, Reports, Time, Contacts, and Bookings rules, guests included),
 * or workspace modules whose lane has not shipped (`readyWorkspaceModules`). Hiding stays
 * presentation, not access control (T97): the route gate still decides what opens.
 *
 * Phase 1 has no nested sections (phase 2 adds each module's `sections`).
 */

export type NavItemKind = "search" | "home" | "inbox" | "notifications" | "app" | "settings";

export type NavItem = {
  /** Stable key: the app section, or "search". */
  id: string;
  kind: NavItemKind;
  label: string;
  /** A real URL, for middle-click and Copy link; a plain click routes in the app. */
  href: string;
  icon: LucideIcon;
  /** The app section a click opens. */
  section: AppSection;
  /** The item for the app on screen (aria-current="page"). */
  current: boolean;
};

export type NavTree = {
  /** Search (Notes' search box and ⌘K until the phase-4 palette); null when Search or Notes is off. */
  search: NavItem | null;
  /** Home, Inbox, Notifications, in that order (Inbox and Notifications only when shown). */
  primary: NavItem[];
  /** The apps, in `MODULES` order. */
  apps: NavItem[];
  /** Settings, in the footer. */
  settings: NavItem;
};

export type NavFeatures = Parameters<typeof unavailableModules>[0];

export type NavInput = {
  /** The person's own disabled modules (Settings → Modules). */
  disabledModules: readonly ModuleId[];
  /** `/api/auth/me` features: what the server offers this person. */
  features?: NavFeatures;
  role: Role | undefined;
  /** The app section on screen. */
  active: AppSection;
  /** Ready workspace modules; defaults to the registry's. */
  readyModules?: readonly WorkspaceModuleId[];
};

/** The sidebar item an app section belongs to: Team and the Bin are Settings routes (Wave 38). */
export function navItemForSection(section: AppSection): string {
  return section === "team" || section === "bin" ? "settings" : section;
}

export function buildNavTree({ disabledModules, features, role, active, readyModules }: NavInput): NavTree {
  const unavailable = unavailableModules(features);
  const disabled = unavailable.length ? normalizeDisabledModules([...disabledModules, ...unavailable]) : disabledModules;
  const ready = readyModules ?? readyWorkspaceModules().map((module) => module.id);
  const currentId = navItemForSection(active);
  const on = (id: ModuleId) => !disabled.includes(id);
  const item = (id: string, kind: NavItemKind, label: string, href: string, icon: LucideIcon, section: AppSection): NavItem =>
    ({ id, kind, label, href, icon, section, current: kind !== "search" && currentId === id });

  const apps = MODULES.flatMap((module) => {
    const launcher = module.launcher;
    if (!launcher) return [];
    if (hiddenModuleForApp(disabled, launcher.section) !== null) return [];
    if (isWorkspaceModuleId(launcher.section) && !ready.includes(launcher.section)) return [];
    return [item(launcher.section, "app", module.label, launcher.href, module.icon, launcher.section)];
  });

  const primary = [item("home", "home", "Home", "/", House, "home")];
  // The Inbox: hidden for guests (they have no inbox, D152) and when its module is off.
  if (on("inbox") && role !== undefined && role !== "guest") primary.push(item("inbox", "inbox", "Inbox", "/inbox", Inbox, "inbox"));
  if (on("notifications")) primary.push(item("notifications", "notifications", "Notifications", "/notifications", Bell, "notifications"));

  return {
    search: on("search") && on("notes") ? item("search", "search", "Search", "/notes", Search, "notes") : null,
    primary,
    apps,
    settings: item("settings", "settings", "Settings", "/settings", Settings, "settings")
  };
}

/** Every item of a tree, top to bottom (search, primary, apps, settings). */
export const navItems = (tree: NavTree): NavItem[] => [...(tree.search ? [tree.search] : []), ...tree.primary, ...tree.apps, tree.settings];
