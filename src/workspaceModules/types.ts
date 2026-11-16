import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { PendingLink, Route } from "../router";
import type { Role } from "../team/teamRoles";
import type { TodaySectionDef } from "../today/todaySections";
import type { EmbedKindDef, SlashItemDef } from "../editor/moduleEmbedRegistry";
import type { BoardHeaderItemDef, CardFaceBadgeDef, CardHeaderActionDef, CardSectionDef, TimelineDecorationDef } from "../ui/cardSlots";
import type { ItemSectionDef } from "../ui/itemSlots";
import type { MemberActionDef } from "../ui/memberSlots";
import type { WorkspaceModuleId } from "../../shared/workspaceModules";
import type { ItemActivityEntry } from "../../shared/itemActivity";

/**
 * The client side of a workspace module (docs/plan/WORKSPACE_MODULES.md §B.1, D801, D832). Each lane
 * fills `src/<module>/module.tsx` with one `WorkspaceClientModule`; `src/workspaceModules/index.ts`
 * imports the seven files and registers them, so a lane never edits src/modules.ts, router.ts,
 * App.tsx, appShellNavigation.ts, Today, the card dialog, or the editor.
 *
 * The ids are W1-CORE's (shared/workspaceModules.ts, D800), in Settings order; user-facing names
 * follow the product owner (§G.1): `crm` is "Contacts" at /contacts, `checkins` "Standups" at /standups.
 */
export { WORKSPACE_MODULE_IDS, isWorkspaceModuleId, type WorkspaceModuleId } from "../../shared/workspaceModules";

/**
 * A workspace module's route (D833): the one generic route shape. `path` is the URL's segments after
 * the module's own (`/goals/grow-mrr-k7f3q2ab01` → `["grow-mrr-k7f3q2ab01"]`), `search` its query
 * ("" or "?…"), both as the module's `parseRoute` normalized them; `pending` a friendly link the tab
 * cannot name yet (D773), which FriendlyLinkGate resolves before the module's app mounts.
 */
export type WorkspaceRoute = { app: WorkspaceModuleId; path: string[]; search: string; pending?: PendingLink };

/** What a module's `parseRoute` returns: its canonical segments and query, or a pending link. */
export type WorkspaceRoutePart = { path: string[]; search?: string; pending?: PendingLink };

/** The standard props every module app receives from App.tsx (§B.1). */
export type WorkspaceAppProps = {
  route: WorkspaceRoute;
  userId: string;
  displayName: string;
  role: Role;
  /** Moves to any in-app route (a new history entry unless `replace`). */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** An in-app path (a notification's href, a work ref's href), opened as a new entry. */
  onOpenPath: (path: string) => void;
  flash: (message: string) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

/** One button in Today's Quick actions row (§B.11): "Start timer", "New poll", "Log a call". */
export type QuickActionDef = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Where it goes: an in-app path (opened as a new entry). */
  href?: string;
  /** Or what it does in place (a sheet the module opens itself, a timer start). */
  run?: (context: QuickActionContext) => void | Promise<void>;
  /** Hidden for these roles (guests, viewers). */
  hiddenFor?: readonly Role[];
};
export type QuickActionContext = { openPath: (path: string) => void; flash: (message: string) => void };

/** A row of the "?" shortcut sheet a module adds (§E.1.4). */
export type ShortcutDef = { keys: string; label: string };

/** Settings → Notifications: one row per module topic (§B.7). */
export type NotificationTopicDef = { id: string; label: string; description?: string };

/** One renderer for a WorkSummary kind (§B.4): its icon and, optionally, a richer chip body. */
export type WorkKindRendererDef = { icon: LucideIcon; label: string; render?: (summary: { title: string; subtitle?: string }) => ReactNode };

/** One item-activity kind's line in ItemTimeline (§B.5): "moved *Grow MRR* to At risk" (after the actor's name). */
export type ActivityRendererDef = (entry: ItemActivityEntry) => ReactNode;

/** The module's section in global search's All scope (§B.12). */
export type SearchRendererDef = {
  scope: string;
  label: string;
  icon: LucideIcon;
  /** One result's row: title, a short second line, and its in-app href. */
  row: (result: Record<string, unknown>) => { key: string; title: string; meta?: string; href: string };
};

/** A public page a module renders under /p/… (§B.8): no session; it fetches /api/public/… itself. */
export type PublicPageDef = { prefix: string; component: LazyExoticComponent<ComponentType<{ path: string; search: string }>> };

/**
 * One of a module's top-level views (docs/plan/LEFT_NAV.md §2.3, §3; D1280): People, Deals, Timesheet,
 * Insights… The global sidebar nests them under the module's app row, and ModuleHome's phone strip
 * lists the same entries, so the two never drift. Each is a route of its own.
 */
export type WorkspaceSectionDef = {
  id: string;
  label: string;
  /** The section's segments after the module's own ([] for the module's home). */
  path: readonly string[];
  /** Its query, when the section is a query view of the home (`?view=list`); "" or absent otherwise. */
  search?: string;
  /** Hidden for these roles (presentation only: the route gate and the server still decide, T97). */
  hiddenFor?: readonly Role[];
};

export type WorkspaceClientModule = {
  id: WorkspaceModuleId;
  /** The URL's first segment: "forms", "contacts" (crm), "standups" (checkins). */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** One line of help in Settings → Modules. */
  description: string;
  /** False keeps the module hidden everywhere (launcher, routes, Today, search, Settings); its lane flips it (D800). */
  ready: boolean;
  /** The module's app, lazy (its own chunk), or null in a stub. */
  app: LazyExoticComponent<ComponentType<WorkspaceAppProps>> | null;
  /** Parses the segments after `segment`; absent keeps them as they are and drops the query. */
  parseRoute?: (segments: string[], search: string) => WorkspaceRoutePart;
  /** The canonical URL of one of its routes; absent writes `/<segment>/<path…><search>`. */
  formatRoute?: (route: WorkspaceRoute) => string;
  /** A tile on the Today launcher (to `/<segment>`). */
  launcher?: boolean;
  /** Its top-level views, in order: the sidebar's nested rows and ModuleHome's phone strip (D1280). */
  sections?: readonly WorkspaceSectionDef[];
  /**
   * The section a route of this module belongs to, or null (an item's own page). Absent: the section
   * whose path is the longest prefix of the route's, else the home section on the home route.
   */
  sectionOf?: (route: Pick<WorkspaceRoute, "path" | "search">) => string | null;
  /** Its Today sections' client copy, by section name (the server's `registerTodayProvider` names). */
  todaySections?: Record<string, TodaySectionDef>;
  quickActions?: readonly QuickActionDef[];
  /** An item in every app header's account row (the running timer chip, §B.1). */
  topBarItem?: ComponentType;
  notificationTopics?: readonly NotificationTopicDef[];
  /**
   * Icons and labels of its work kinds. D1386: declared by Time, Contacts, Bookings, and Townhall but
   * not read yet; the link chips (src/ui/links) are to take their icon and label from here.
   */
  workKindRenderers?: Readonly<Record<string, WorkKindRendererDef>>;
  embedRenderers?: readonly EmbedKindDef[];
  slashItems?: readonly SlashItemDef[];
  activityRenderers?: Readonly<Record<string, ActivityRendererDef>>;
  searchRenderer?: SearchRendererDef;
  cardSections?: readonly CardSectionDef[];
  cardFaceBadges?: readonly CardFaceBadgeDef[];
  cardHeaderActions?: readonly CardHeaderActionDef[];
  timelineDecorations?: readonly TimelineDecorationDef[];
  /** Items in a board's header after its card count (the board's goal chip, D1048). */
  boardHeaderItems?: readonly BoardHeaderItemDef[];
  /** Panels on other modules' item pages (goal, contact, deal, booking…), D1056. */
  itemSections?: readonly ItemSectionDef[];
  /** Buttons on the Team page's member rows and profiles ("Book time with …"), D1253. */
  memberActions?: readonly MemberActionDef[];
  shortcuts?: readonly ShortcutDef[];
  /** Its public pages by path prefix (`/p/f/`, `/p/book/`, `/p/t/`). */
  publicPages?: readonly PublicPageDef[];
};
