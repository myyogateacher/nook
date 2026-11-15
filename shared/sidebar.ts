/**
 * The sidebar's synced layout (docs/plan/LEFT_NAV.md §4 phase 4, D1294–D1296): the words the server's
 * `/api/preferences` schema and the client share. Pure: no imports but shared/, so both load it.
 *
 * App ids are the sidebar's app rows (the launcher sections in `MODULES` order: Chat is `chat`, the
 * workspace modules their module id); `inbox` also opens like an app (its sections), so the expanded
 * list may name it. Ordering, pinning, and opening are presentation only: the route gate and every
 * API keep deciding what opens (T97).
 */
import { WORKSPACE_MODULE_IDS } from "./workspaceModules";

export const SIDEBAR_APP_IDS = ["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault", "chat", "reports", ...WORKSPACE_MODULE_IDS] as const;
export type SidebarAppId = (typeof SIDEBAR_APP_IDS)[number];

/** The rows that open in place by their chevron (D1284): the apps and the Inbox. */
export const SIDEBAR_EXPANDABLE_IDS = [...SIDEBAR_APP_IDS, "inbox"] as const;
export type SidebarExpandableId = (typeof SIDEBAR_EXPANDABLE_IDS)[number];

export const SIDEBAR_MODES = ["expanded", "rail"] as const;
export type SidebarSyncedMode = (typeof SIDEBAR_MODES)[number];

/** What `/api/preferences` keeps of the sidebar; every field optional ("no choice"). */
export type SidebarLayout = {
  mode?: SidebarSyncedMode;
  /** The apps in the person's order (pinned ones included); apps not listed keep their default place. */
  order?: SidebarAppId[];
  /** Apps pinned to the Pinned group at the top of Apps, in `order`'s order. */
  pinned?: SidebarAppId[];
  /** Apps opened by their chevron (D1284). */
  expanded?: SidebarExpandableId[];
};

const isIn = <T extends string>(list: readonly T[]) => (value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
export const isSidebarAppId = isIn(SIDEBAR_APP_IDS);
export const isSidebarExpandableId = isIn(SIDEBAR_EXPANDABLE_IDS);

const unique = <T>(values: readonly T[]) => values.filter((value, index) => values.indexOf(value) === index);

/**
 * A stored or received layout, cleaned: unknown ids and duplicates dropped, a mode other than the
 * two left out. Anything that is not an object is no layout (null). Empty lists stay (an empty
 * `pinned` means "nothing pinned", which differs from never having chosen).
 */
export function cleanSidebarLayout(value: unknown): SidebarLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const layout: SidebarLayout = {};
  if (raw.mode === "expanded" || raw.mode === "rail") layout.mode = raw.mode;
  if (Array.isArray(raw.order)) layout.order = unique(raw.order.filter(isSidebarAppId));
  if (Array.isArray(raw.pinned)) layout.pinned = unique(raw.pinned.filter(isSidebarAppId));
  if (Array.isArray(raw.expanded)) layout.expanded = unique(raw.expanded.filter(isSidebarExpandableId));
  return layout;
}

/** Same layout (field by field, order counts). */
export function sameSidebarLayout(left: SidebarLayout | null | undefined, right: SidebarLayout | null | undefined) {
  const a = left ?? {};
  const b = right ?? {};
  const list = (x?: readonly string[], y?: readonly string[]) => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.length === y.length && x.every((id, index) => y[index] === id));
  return a.mode === b.mode && list(a.order, b.order) && list(a.pinned, b.pinned) && list(a.expanded, b.expanded);
}

/** True when the layout says nothing (no field set). */
export const emptySidebarLayout = (layout: SidebarLayout | null | undefined) => !layout || (layout.mode === undefined && layout.order === undefined && layout.pinned === undefined && layout.expanded === undefined);
