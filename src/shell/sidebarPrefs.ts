import { useEffect, useRef, useState } from "react";
import { cleanSidebarLayout, emptySidebarLayout, isSidebarAppId, sameSidebarLayout, SIDEBAR_APP_IDS, type SidebarAppId, type SidebarLayout } from "../../shared/sidebar";
import { announceSidebarPrefs, readExpandedApps, readSidebarPreference, SIDEBAR_EXPANDED_KEY, SIDEBAR_PREFS_EVENT, SIDEBAR_STORAGE_KEY, type SidebarPrefsChange } from "./useSidebarState";

/**
 * The sidebar's layout (docs/plan/LEFT_NAV.md §4 phase 4, D1294–D1296): the person's app order, the
 * apps pinned to the top of Apps, and — with the collapse choice (D1271) and the apps opened by their
 * chevron (D1284) — what `/api/preferences` keeps so another device shows the same sidebar.
 *
 * This browser's localStorage stays the fast path: the sidebar draws from it at once on load, and a
 * change is written there first. The server's copy reconciles on sign-in (and when the tab comes
 * back), and changes are sent a moment later (debounced, through usePreferences, so the shared
 * `revision` stays in step with Settings → Modules). Ordering and pinning are presentation, never
 * access control (T97): the route gate and every API still decide what opens.
 */

export type { SidebarAppId, SidebarLayout } from "../../shared/sidebar";
export type AppsLayout = Pick<SidebarLayout, "order" | "pinned">;

/** `{ order, pinned }` of this browser. */
export const SIDEBAR_APPS_KEY = "nook.sidebar.apps";
/** The signed-in person whose layout change here has not reached the server yet. */
export const SIDEBAR_DIRTY_KEY = "nook.sidebar.dirty";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const localStore = (): Store | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
const safeGet = (storage: Pick<Storage, "getItem"> | null | undefined, key: string) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };


/** The layout kept in this browser; a field never chosen here is left out. */
export function readLocalLayout(storage: Pick<Storage, "getItem"> | null | undefined = localStore()): SidebarLayout {
  const layout: SidebarLayout = {};
  const mode = readSidebarPreference(storage);
  if (mode) layout.mode = mode;
  if (safeGet(storage, SIDEBAR_EXPANDED_KEY) !== null) layout.expanded = cleanSidebarLayout({ expanded: readExpandedApps(storage) })?.expanded ?? [];
  let apps: unknown = null;
  try { apps = JSON.parse(safeGet(storage, SIDEBAR_APPS_KEY) ?? "null"); } catch { apps = null; }
  const cleaned = cleanSidebarLayout(apps);
  if (cleaned?.order) layout.order = cleaned.order;
  if (cleaned?.pinned) layout.pinned = cleaned.pinned;
  return layout;
}

/**
 * Writes the fields given into this browser and tells the sidebar. `local`: the person changed it
 * here (it is then sent to the server); `server`: the server's copy was applied (nothing is sent).
 */
export function writeLocalLayout(patch: SidebarLayout, source: SidebarPrefsChange["source"], storage: Store | null = localStore()) {
  try {
    if (patch.mode) storage?.setItem(SIDEBAR_STORAGE_KEY, patch.mode);
    if (patch.expanded) storage?.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify(patch.expanded.slice(0, 40)));
    if (patch.order || patch.pinned) {
      const current = readLocalLayout(storage);
      storage?.setItem(SIDEBAR_APPS_KEY, JSON.stringify({ order: patch.order ?? current.order ?? [], pinned: patch.pinned ?? current.pinned ?? [] }));
    }
  } catch { /* private mode: this visit only */ }
  announceSidebarPrefs(source);
}

/** Changes the app order or pins here (the sidebar's drag, the Customize sheet). */
export const updateAppsLayout = (layout: Required<AppsLayout>) => writeLocalLayout(layout, "local");

/**
 * Ids in the person's order. Ids `order` lists come in its order; one it does not list (a module
 * turned on or shipped later) keeps its default place: right after the id before it by default.
 */
export function arrangeIds<T extends string>(defaults: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order?.length) return [...defaults];
  const result: T[] = order.filter((id): id is T => (defaults as readonly string[]).includes(id));
  const seen = new Set<string>(result);
  defaults.forEach((id, index) => {
    if (seen.has(id)) return;
    let at = 0;
    for (let back = index - 1; back >= 0; back -= 1) {
      const found = result.indexOf(defaults[back]!);
      if (found >= 0) { at = found + 1; break; }
    }
    result.splice(at, 0, id);
    seen.add(id);
  });
  return result;
}

/** Items split into the Pinned group and the rest, each in the person's order (D1294). */
export function arrangeApps<T>(items: readonly T[], layout: AppsLayout | null | undefined, idOf: (item: T) => string): { pinned: T[]; rest: T[] } {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const ordered = arrangeIds(items.map(idOf), layout?.order).map((id) => byId.get(id)!);
  const pinned = new Set<string>(layout?.pinned ?? []);
  return { pinned: ordered.filter((item) => pinned.has(idOf(item))), rest: ordered.filter((item) => !pinned.has(idOf(item))) };
}

/** Pinned first, then the rest: the order the sidebar shows. */
export const arrangedIds = (ids: readonly string[], layout: AppsLayout | null | undefined) => {
  const { pinned, rest } = arrangeApps(ids, layout, (id) => id);
  return [...pinned, ...rest];
};

/**
 * Moves `id` to `index` of the shown list (`shown`: the apps on screen, pinned first, without `id`
 * counted twice) and pins or unpins it. Apps not shown (turned off, not offered) keep their place
 * after the app before them, so turning one back on puts it where it was.
 */
export function moveApp(layout: AppsLayout | null | undefined, shown: readonly string[], id: string, index: number, pinned: boolean): Required<AppsLayout> {
  const sequence = shown.filter((entry) => entry !== id);
  const at = Math.max(0, Math.min(index, sequence.length));
  sequence.splice(at, 0, id);
  const pins = new Set<string>(layout?.pinned ?? []);
  if (pinned) pins.add(id); else pins.delete(id);
  // Only the moved app changes place in the full order: right after the app now before it in its
  // group, else right before the app now after it. Everything else, shown or not, keeps its place;
  // alone in its group it keeps its own.
  const full = arrangeIds<string>(SIDEBAR_APP_IDS, layout?.order);
  const result = full.filter((entry) => entry !== id);
  const next = sequence[at + 1];
  const previous = sequence[at - 1];
  const sameGroup = (entry: string | undefined) => entry !== undefined && pins.has(entry) === pinned && result.includes(entry);
  if (sameGroup(previous)) result.splice(result.indexOf(previous!) + 1, 0, id);
  else if (sameGroup(next)) result.splice(result.indexOf(next!), 0, id);
  else result.splice(Math.max(0, full.indexOf(id)), 0, id);
  const order = result.filter(isSidebarAppId) as SidebarAppId[];
  return { order, pinned: order.filter((entry) => pins.has(entry)) };
}

/** Pins (to the end of Pinned) or unpins (to the top of Apps) one app. */
export function setAppPinned(layout: AppsLayout | null | undefined, shown: readonly string[], id: string, pinned: boolean): Required<AppsLayout> {
  const pinnedNow = new Set(layout?.pinned ?? []);
  const pinnedCount = shown.filter((entry) => entry !== id && pinnedNow.has(entry as SidebarAppId)).length;
  return moveApp(layout, shown, id, pinnedCount, pinned);
}

/** Moves one app up (-1) or down (+1) within its group (Pinned or Apps). */
export function stepApp(layout: AppsLayout | null | undefined, shown: readonly string[], id: string, delta: -1 | 1): Required<AppsLayout> | null {
  const pinned = new Set<string>(layout?.pinned ?? []);
  const isPinned = pinned.has(id);
  const at = shown.indexOf(id);
  const target = at + delta;
  if (at < 0 || target < 0 || target >= shown.length || pinned.has(shown[target]!) !== isPinned) return null;
  return moveApp(layout, shown, id, target, isPinned);
}

/**
 * Sign-in (or the tab coming back): what to do with this browser's layout and the server's.
 * - A change made here that has not reached the server yet (`dirty`) is sent.
 * - Otherwise the server's copy wins, field by field (a field it never had keeps this browser's).
 * - A server without any layout is seeded from this browser.
 */
export function reconcileSidebarLayout({ local, server, dirty }: { local: SidebarLayout; server: SidebarLayout | null | undefined; dirty: boolean }): { apply: SidebarLayout | null; push: SidebarLayout | null } {
  if (dirty && !emptySidebarLayout(local)) return { apply: null, push: sameSidebarLayout(local, server) ? null : local };
  if (!emptySidebarLayout(server)) {
    const merged: SidebarLayout = { ...local, ...server };
    return { apply: sameSidebarLayout(merged, local) ? null : merged, push: null };
  }
  return { apply: null, push: emptySidebarLayout(local) ? null : local };
}

/** The layout of this browser, following every change (here, another tab, or the server). */
export function useLocalLayout(): SidebarLayout {
  const [layout, setLayout] = useState<SidebarLayout>(() => readLocalLayout());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reread = () => setLayout((current) => { const next = readLocalLayout(); return sameSidebarLayout(current, next) ? current : next; });
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith("nook.sidebar")) reread(); };
    window.addEventListener(SIDEBAR_PREFS_EVENT, reread);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(SIDEBAR_PREFS_EVENT, reread); window.removeEventListener("storage", onStorage); };
  }, []);
  return layout;
}

/**
 * Keeps this browser's layout and the server's in step (D1295). `server` is the saved copy (null:
 * none saved; ignored until `loaded`); `save` sends a layout (usePreferences debounces it and keeps
 * the revision). A change here marks the person's layout dirty until the server holds it.
 */
export function useSidebarSync({ userId, loaded, server, save }: { userId: string | null; loaded: boolean; server: SidebarLayout | null; save: (layout: SidebarLayout) => void }) {
  const saveRef = useRef(save);
  saveRef.current = save;
  const reconciledFor = useRef<string | null>(null);

  // A change made here: remember it until the server has it, and send it.
  useEffect(() => {
    if (!userId || typeof window === "undefined") return;
    const onChange = (event: Event) => {
      if ((event as CustomEvent<SidebarPrefsChange>).detail?.source !== "local") return;
      try { localStore()?.setItem(SIDEBAR_DIRTY_KEY, userId); } catch { /* private mode */ }
      if (reconciledFor.current === userId) saveRef.current(readLocalLayout());
    };
    window.addEventListener(SIDEBAR_PREFS_EVENT, onChange);
    return () => window.removeEventListener(SIDEBAR_PREFS_EVENT, onChange);
  }, [userId]);

  // Sign-in, and every new server copy (a save confirmed, another device's change read on focus).
  useEffect(() => {
    if (!userId || !loaded) return;
    const store = localStore();
    const dirty = safeGet(store, SIDEBAR_DIRTY_KEY) === userId;
    const local = readLocalLayout(store);
    const first = reconciledFor.current !== userId;
    reconciledFor.current = userId;
    if (dirty && sameSidebarLayout(local, { ...local, ...(server ?? {}) }) && !emptySidebarLayout(server)) {
      try { store?.removeItem(SIDEBAR_DIRTY_KEY); } catch { /* private mode */ }
      return;
    }
    // After sign-in a pending change here is sent; later, a newer server copy waits for it to land.
    const { apply, push } = reconcileSidebarLayout({ local, server, dirty });
    if (apply) writeLocalLayout(apply, "server", store);
    if (push && first) saveRef.current(push);
  }, [userId, loaded, server]);
}
