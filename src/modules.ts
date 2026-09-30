import { createContext, useContext } from "react";
import { Archive, Bell, CalendarDays, FileText, Inbox, KanbanSquare, KeyRound, PenTool, Search, Table2, Trash2, Users, type LucideIcon } from "lucide-react";
import type { AppSection } from "./appShellNavigation";

/**
 * The module registry (D92, docs/plan/WAVE_13_TASK_CARD_UX.md §4.8). Settings → Modules lists these,
 * and the launcher, header items, routes, and Today sections are filtered through it.
 *
 * Turning a module off only hides UI in this app. The server, MCP, feeds, reminders, and push are
 * unchanged, and every API keeps enforcing its own access rules: a hidden module is not a security
 * boundary (T97). Home and Settings are not modules and are always on.
 */

/** Every module id, in Settings order. Keep in step with `MODULE_IDS` in server/moduleIds.ts. */
export const MODULE_IDS = ["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault", "search", "bin", "notifications", "team", "inbox"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** The apps with a Today launcher tile. */
export type LauncherSection = "notes" | "files" | "tasks" | "collections" | "calendar" | "whiteboards" | "vault";

export type ModuleDef = {
  id: ModuleId;
  label: string;
  /** One line of help in Settings → Modules. */
  description: string;
  icon: LucideIcon;
  /** The app sections (route prefixes) this module owns. Opening one while it is off goes Home with a hint. */
  routeApps: readonly AppSection[];
  /** Its tile on the Today launcher. */
  launcher?: { section: LauncherSection; href: string };
  /** The Today sections it provides (keys of TODAY_SECTIONS and of the server's providers). */
  todaySections: readonly string[];
  /** Shared chrome it owns: the Bin button, the notification bell, or the Notes search box and Ctrl/⌘+K. */
  headerItem?: "bin" | "bell" | "search" | "inbox";
  /** Reserved for a later wave: accepted by the server, kept on by default, and not listed in Settings yet. */
  planned?: boolean;
};

export const MODULES: readonly ModuleDef[] = [
  { id: "notes", label: "Notes", description: "Markdown notes with drafts, versions, and sharing.", icon: Archive, routeApps: ["notes"], launcher: { section: "notes", href: "/notes" }, todaySections: ["notesRecent", "drafts"] },
  { id: "files", label: "Files", description: "Uploads, previews, and your storage use on Today.", icon: FileText, routeApps: ["files"], launcher: { section: "files", href: "/files" }, todaySections: ["files", "storage"] },
  { id: "tasks", label: "Tasks", description: "Boards, cards, and the Due soon and My tasks sections.", icon: KanbanSquare, routeApps: ["tasks"], launcher: { section: "tasks", href: "/tasks" }, todaySections: ["tasksDue", "tasksMine"] },
  { id: "collections", label: "Collections", description: "Tables of rows with fields, views, and CSV.", icon: Table2, routeApps: ["collections"], launcher: { section: "collections", href: "/collections" }, todaySections: ["collectionsRecent"] },
  { id: "calendar", label: "Calendar", description: "Calendars, events, and the Upcoming section.", icon: CalendarDays, routeApps: ["calendar"], launcher: { section: "calendar", href: "/calendar" }, todaySections: ["upcoming"] },
  // Whiteboards (Wave 23, D206). Off hides the launcher, routes, Today section, and Files' "Open
  // whiteboard"; boards still appear in Files as .excalidraw downloads (not a boundary, T97).
  { id: "whiteboards", label: "Whiteboards", description: "Sketches, diagrams, and floor plans saved in your Files.", icon: PenTool, routeApps: ["whiteboards"], launcher: { section: "whiteboards", href: "/whiteboards" }, todaySections: ["whiteboardsRecent"] },
  // The Vault (Wave 25, D229). Off hides the launcher and routes only; the server keeps enforcing
  // access, and a server without VAULT_ENCRYPTION_KEY hides it from everyone but admins (not a boundary, T97).
  { id: "vault", label: "Vault", description: "Team secrets per environment: encrypted at rest, and anyone with the server and its key can read every secret.", icon: KeyRound, routeApps: ["vault"], launcher: { section: "vault", href: "/vault" }, todaySections: [] },
  { id: "search", label: "Search", description: "The search box in Notes, Ctrl+K, and the text filter on boards. The Notes list and the other board filters stay.", icon: Search, routeApps: [], todaySections: [], headerItem: "search" },
  { id: "bin", label: "Bin", description: "Hides the Bin button and Leaving the Bin soon. Deleting still moves items to the Bin, and they are still deleted forever after 30 days.", icon: Trash2, routeApps: ["bin"], todaySections: ["binSoon"], headerItem: "bin" },
  { id: "notifications", label: "Notifications", description: "Hides the bell and the Notifications page. Reminders and push notifications still arrive.", icon: Bell, routeApps: ["notifications"], todaySections: [], headerItem: "bell" },
  { id: "team", label: "Team", description: "The Team button and the people in this workspace. Roles and blocking still apply.", icon: Users, routeApps: ["team"], todaySections: [] },
  // Agent inbox (D157): an account-row button next to the bell, no launcher tile. Hiding it is not a
  // boundary: MCP keys can still suggest changes, which wait until it is turned on again (T97).
  { id: "inbox", label: "Inbox", description: "Proposals from agents and your routines, and Proposals awaiting you on Today. Agents can still suggest changes while it is off; nothing is applied until you approve.", icon: Inbox, routeApps: ["inbox"], todaySections: ["proposals"], headerItem: "inbox" }
];

const byId = new Map(MODULES.map((module) => [module.id, module]));

export const moduleDef = (id: ModuleId) => byId.get(id)!;

/** The modules Settings lists (planned ones are left out until their wave ships). */
export const SETTINGS_MODULES = MODULES.filter((module) => !module.planned);

/**
 * The modules Settings lists for a role. Guests never see Team (Team plan §6.2, §11): they have no
 * access to it, so it is left out rather than shown as a switch.
 */
export function settingsModulesFor(role: string | undefined, unavailable: readonly ModuleId[] = []): readonly ModuleDef[] {
  // Guests have no inbox either (D152): they cannot hold keys or apply proposals; nor a vault (V-O3).
  const shown = role === "guest" ? SETTINGS_MODULES.filter((module) => module.id !== "team" && module.id !== "inbox" && module.id !== "vault") : SETTINGS_MODULES;
  return unavailable.length ? shown.filter((module) => !unavailable.includes(module.id)) : shown;
}

/**
 * Modules the server does not offer this person (Wave 25): the Vault without VAULT_ENCRYPTION_KEY
 * for everyone but admins, and always for guests (`/api/auth/me` `features`). They are hidden like a
 * module that is turned off, but Settings has no switch for them and the hint says why.
 */
export function unavailableModules(features: { vault?: boolean } | undefined): ModuleId[] {
  return features?.vault === false ? ["vault"] : [];
}

/** Unique known ids in registry order; anything else (unknown ids, non-arrays) is ignored. */
export function normalizeDisabledModules(value: unknown): ModuleId[] {
  if (!Array.isArray(value)) return [];
  return MODULE_IDS.filter((id) => value.includes(id));
}

export const isModuleEnabled = (disabled: readonly ModuleId[], id: ModuleId) => !disabled.includes(id);

/** Turns one module on or off, keeping registry order. */
export function withModuleEnabled(disabled: readonly ModuleId[], id: ModuleId, enabled: boolean): ModuleId[] {
  return normalizeDisabledModules(enabled ? disabled.filter((item) => item !== id) : [...disabled, id]);
}

/** The module that owns an app section; Home owns none. */
export function moduleForApp(app: AppSection): ModuleDef | null {
  return MODULES.find((module) => module.routeApps.includes(app)) ?? null;
}

/** False when the module that owns this app is off. Home is always on. */
export function isAppEnabled(disabled: readonly ModuleId[], app: AppSection) {
  const owner = moduleForApp(app);
  return !owner || isModuleEnabled(disabled, owner.id);
}

/**
 * The route gate (D92): the module that is off and owns this app, or null when the app may be shown.
 * The app then replaces the entry with Home and shows `moduleOffHint`. Deep links, Back and Forward,
 * and in-app links all pass through it; Home is never gated.
 */
export function hiddenModuleForApp(disabled: readonly ModuleId[], app: AppSection): ModuleId | null {
  const owner = moduleForApp(app);
  return owner && !isModuleEnabled(disabled, owner.id) ? owner.id : null;
}

export type HiddenEntryStep = "undo" | "back" | "replace";

/**
 * Back or Forward landed on the entry of a module that is off (D92). Replacing that entry with Home
 * would leave two Home entries side by side, so the entry is skipped instead: Forward is undone
 * (back to the entry it came from, the gated entry stays ahead), and Back steps on past it while
 * there is an entry below. Only at depth 0, or when the direction is unknown, is it replaced.
 */
export function hiddenEntryStep(direction: "back" | "forward" | null, poppedDepth: number): HiddenEntryStep {
  if (direction === "forward") return "undo";
  if (direction === "back" && poppedDepth > 0) return "back";
  return "replace";
}

/**
 * Records the depth of the entry a popstate landed on and returns the depth of the entry it left.
 * Called for every popstate, including the ones a dialog consumed and the ignored popstate of an
 * undo (history.go), so the next Forward onto a hidden entry still sees which way it moved. The ref
 * is never re-read from history.state on render: while an undo is in flight, history.state still
 * reads the entry being undone.
 */
export function recordPopDepth(ref: { current: number }, poppedDepth: number) {
  const previous = ref.current;
  ref.current = poppedDepth;
  return previous;
}

/** The Today sections of modules that are off. */
export function hiddenTodaySections(disabled: readonly ModuleId[]): string[] {
  return MODULES.filter((module) => disabled.includes(module.id)).flatMap((module) => module.todaySections);
}

/** The one-line hint after a route of a hidden module was replaced with Home. */
export const moduleOffHint = (id: ModuleId) => `${moduleDef(id).label} is turned off. Turn it on in Settings → Modules.`;

export type Preferences = { disabledModules: ModuleId[]; revision: number; updatedAt: string | null };
export const DEFAULT_PREFERENCES: Preferences = { disabledModules: [], revision: 0, updatedAt: null };

/** Reads a server `preferences` value defensively; anything malformed means every module is on. */
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCES;
  const raw = value as Record<string, unknown>;
  const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  return { disabledModules: normalizeDisabledModules(raw.disabledModules), revision, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
}

/** The disabled modules of the signed-in user. Outside a provider every module is on. */
export const ModulesContext = createContext<readonly ModuleId[]>([]);
export const useDisabledModules = () => useContext(ModulesContext);
export const useModuleEnabled = (id: ModuleId) => isModuleEnabled(useDisabledModules(), id);
