import { Bell, House, Inbox, Search, Settings, type LucideIcon } from "lucide-react";
import type { AppSection } from "../appShellNavigation";
import { hiddenModuleForApp, MODULES, normalizeDisabledModules, unavailableModules, type ModuleId } from "../modules";
import { parseRoute } from "../router";
import type { Role } from "../team/teamRoles";
import { readyWorkspaceModules, workspaceModule } from "../workspaceModules/registry";
import { sectionHref, sectionOfRoute, visibleSections } from "../workspaceModules/sections";
import { isWorkspaceModuleId, type WorkspaceModuleId, type WorkspaceRoute } from "../workspaceModules/types";

/**
 * The global sidebar's tree (docs/plan/LEFT_NAV.md §2.1, §3; D1270). A pure function of the person's
 * module preferences, the server's features, their role, and the app on screen, so the sidebar shows
 * exactly the apps Home's launcher does today: the module registry's launcher entries in `MODULES`
 * order, without modules that are off (`disabledModules`), that the server does not offer this person
 * (`unavailableModules`: the Vault, Chat, Reports, Time, Contacts, and Bookings rules, guests included),
 * or workspace modules whose lane has not shipped (`readyWorkspaceModules`). Hiding stays
 * presentation, not access control (T97): the route gate still decides what opens.
 *
 * Phase 2 (D1280, D1282): an app's sections nest under its row (`children`): a workspace module's
 * `sections`, and small adapters for Tasks (Boards, My work, Views, then recent boards), the Inbox
 * (Pending, History, Routines), and Collections (recent collections, then All collections). The
 * section on screen is read from the location, so a deep link lights the right one.
 */

export type NavItemKind = "search" | "home" | "inbox" | "notifications" | "app" | "settings" | "section" | "recent";

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
  /**
   * The item on screen: the app on screen, and the section of it on screen (that one is
   * aria-current="page"; its app row then says it holds the current page).
   */
  current: boolean;
  /** An app's sections and recent items, in order (D1280); the sidebar nests them under its row. */
  children?: NavItem[];
  /**
   * Phase 3 (D1287): the app on screen draws its own tree under its row (Notes' and Files' folders,
   * Reports' folders and lists), so the row opens like an app with sections even without `children`.
   */
  tree?: boolean;
};

/** The apps whose own tree moves into the sidebar while they are on screen (D1287). */
export const TREE_APPS: readonly AppSection[] = ["notes", "files", "reports"];

/** A recently opened board or collection (D1282), newest first. */
export type NavRecent = { id: string; name: string; href: string };
export type NavRecents = { tasks?: readonly NavRecent[]; collections?: readonly NavRecent[] };
/** The most recent items nested under Tasks or Collections. */
export const NAV_RECENT_LIMIT = 8;

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
  /** The address on screen, for the current section; absent marks no section current. */
  location?: { pathname: string; search: string };
  /** Recently opened boards and collections (D1282). */
  recents?: NavRecents;
};

/** The sidebar item an app section belongs to: Team and the Bin are Settings routes (Wave 38). */
export function navItemForSection(section: AppSection): string {
  return section === "team" || section === "bin" ? "settings" : section;
}

export function buildNavTree({ disabledModules, features, role, active, readyModules, location, recents }: NavInput): NavTree {
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
    const row = item(launcher.section, "app", module.label, launcher.href, module.icon, launcher.section);
    const children = appSections(launcher.section, { role, active, location, recents });
    const withTree = row.current && TREE_APPS.includes(launcher.section) ? { ...row, tree: true } : row;
    return [children.length ? { ...withTree, children } : withTree];
  });

  const primary = [item("home", "home", "Home", "/", House, "home")];
  // The Inbox: hidden for guests (they have no inbox, D152) and when its module is off.
  if (on("inbox") && role !== undefined && role !== "guest") primary.push({ ...item("inbox", "inbox", "Inbox", "/inbox", Inbox, "inbox"), children: appSections("inbox", { role, active, location, recents }) });
  if (on("notifications")) primary.push(item("notifications", "notifications", "Notifications", "/notifications", Bell, "notifications"));

  return {
    search: on("search") && on("notes") ? item("search", "search", "Search", "/notes", Search, "notes") : null,
    primary,
    apps,
    settings: item("settings", "settings", "Settings", "/settings", Settings, "settings")
  };
}

/** Every item of a tree, top to bottom (search, primary, apps, settings), children after their app. */
export const navItems = (tree: NavTree): NavItem[] => [...(tree.search ? [tree.search] : []), ...tree.primary, ...tree.apps, tree.settings]
  .flatMap((item) => [item, ...(item.children ?? [])]);

type SectionContext = Pick<NavInput, "role" | "active" | "location" | "recents">;
type SectionRow = { id: string; label: string; href: string; kind?: "section" | "recent"; current: boolean };

/**
 * An app's nested rows (D1280, D1282). Each is a real URL, and at most one is current: the one the
 * location on screen belongs to (none on an item's own page, such as one form or one session).
 */
export function appSections(section: AppSection, { role, active, location, recents }: SectionContext): NavItem[] {
  const here = location && navItemForSection(active) === section ? location : null;
  const rows = sectionRows(section, role, here, recents);
  const parent = MODULES.find((module) => module.launcher?.section === section);
  const icon = parent?.icon ?? (section === "inbox" ? Inbox : House);
  return rows.map((row) => ({ id: `${section}:${row.kind === "recent" ? "recent:" : ""}${row.id}`, kind: row.kind ?? "section", label: row.label, href: row.href, icon, section, current: row.current }));
}

const pathSegments = (pathname: string) => pathname.split("/").filter(Boolean);

function sectionRows(section: AppSection, role: Role | undefined, here: NavInput["location"] | null, recents: NavRecents | undefined): SectionRow[] {
  if (isWorkspaceModuleId(section)) {
    const module = workspaceModule(section);
    if (!module) return [];
    const route = here ? parseRoute(here.pathname, here.search) : null;
    const currentId = route && route.app === section && !(route as WorkspaceRoute).pending ? sectionOfRoute(module, route as WorkspaceRoute) : null;
    return visibleSections(module, role).map((item) => ({ id: item.id, label: item.label, href: sectionHref(section, item), current: item.id === currentId }));
  }
  const segments = here ? pathSegments(here.pathname) : null;
  if (section === "tasks") {
    const route = here ? parseRoute(here.pathname, here.search) : null;
    const boardId = route?.app === "tasks" ? route.boardId ?? null : null;
    const home = segments && !boardId ? (segments[1] === "my" ? "my" : segments[1] === "views" ? "views" : segments.length <= 1 ? "boards" : null) : null;
    return [
      { id: "boards", label: "Boards", href: "/tasks", current: home === "boards" },
      { id: "my", label: "My work", href: "/tasks/my", current: home === "my" },
      { id: "views", label: "Views", href: "/tasks/views", current: home === "views" },
      ...(recents?.tasks ?? []).slice(0, NAV_RECENT_LIMIT).map((board) => ({ id: board.id, label: board.name, href: board.href, kind: "recent" as const, current: boardId !== null && boardId === board.id }))
    ];
  }
  if (section === "inbox") {
    const view = segments ? (segments[1] === "routines" ? "routines" : segments[1] === "history" ? "history" : "pending") : null;
    return [
      { id: "pending", label: "Pending", href: "/inbox", current: view === "pending" },
      { id: "history", label: "History", href: "/inbox/history", current: view === "history" },
      { id: "routines", label: "Routines", href: "/inbox/routines", current: view === "routines" }
    ];
  }
  if (section === "collections") {
    const route = here ? parseRoute(here.pathname, here.search) : null;
    const collectionId = route?.app === "collections" ? route.collectionId ?? null : null;
    return [
      ...(recents?.collections ?? []).slice(0, NAV_RECENT_LIMIT).map((collection) => ({ id: collection.id, label: collection.name, href: collection.href, kind: "recent" as const, current: collectionId !== null && collectionId === collection.id })),
      { id: "all", label: "All collections", href: "/collections", current: segments !== null && !collectionId }
    ];
  }
  return [];
}
