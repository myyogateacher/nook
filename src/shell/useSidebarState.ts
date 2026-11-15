import { useCallback, useEffect, useState } from "react";

/**
 * The sidebar's three states (docs/plan/LEFT_NAV.md §2.1, D1271): expanded (240 px, labels), rail
 * (56 px, icons with tooltips), and the phone drawer. Without a choice the window decides: expanded
 * from 1280 px, the rail from 761 to 1279 px, the drawer at 760 px and under. Once the person
 * collapses or expands it, that choice (localStorage `nook.sidebar`) wins on every computer-sized
 * window; phones always use the drawer. ⌘\ (Ctrl+\ elsewhere) toggles it, as the button does.
 */

export type SidebarPreference = "expanded" | "rail";
export type SidebarMode = "expanded" | "rail" | "drawer";

export const SIDEBAR_STORAGE_KEY = "nook.sidebar";
export const PHONE_MAX = 760;
export const EXPANDED_MIN = 1280;
export const SIDEBAR_PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
export const SIDEBAR_WIDE_QUERY = `(min-width: ${EXPANDED_MIN}px)`;

/** The mode for a window width and the saved choice. */
export function sidebarMode(width: number, preference: SidebarPreference | null): SidebarMode {
  if (width <= PHONE_MAX) return "drawer";
  return preference ?? (width >= EXPANDED_MIN ? "expanded" : "rail");
}

/** The saved choice; anything else (nothing, a stale value, storage blocked) is no choice. */
export function readSidebarPreference(storage: Pick<Storage, "getItem"> | null | undefined): SidebarPreference | null {
  try {
    const value = storage?.getItem(SIDEBAR_STORAGE_KEY);
    return value === "expanded" || value === "rail" ? value : null;
  } catch {
    return null;
  }
}

export function writeSidebarPreference(storage: Pick<Storage, "setItem"> | null | undefined, value: SidebarPreference) {
  try { storage?.setItem(SIDEBAR_STORAGE_KEY, value); } catch { /* private mode: the choice lasts this visit */ }
}

/** The apps the person opened in the sidebar by their chevron (D1284), kept across reloads. */
export const SIDEBAR_EXPANDED_KEY = "nook.sidebar.expanded";
export function readExpandedApps(storage: Pick<Storage, "getItem"> | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SIDEBAR_EXPANDED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 40).slice(0, 40) : [];
  } catch {
    return [];
  }
}
export function writeExpandedApps(storage: Pick<Storage, "setItem"> | null | undefined, ids: readonly string[]) {
  try { storage?.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify(ids.slice(0, 40))); } catch { /* private mode: this visit only */ }
}

/** ⌘\ on a Mac, Ctrl+\ elsewhere (either is accepted: a Mac keyboard on Linux sends Meta). */
export function isSidebarToggleKey(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "\\" || event.code === "Backslash");
}

const localStore = () => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
const windowWidth = () => typeof window === "undefined" ? EXPANDED_MIN : window.innerWidth;

export type SidebarState = {
  mode: SidebarMode;
  /** The saved choice (null: the window decides). */
  preference: SidebarPreference | null;
  drawerOpen: boolean;
  /** Expanded ↔ rail on a computer (and saves it); opens or closes the drawer on a phone. */
  toggle: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
};

/** `locked`: the page holds the rail (D1279), so the computer toggle (button and ⌘\) does nothing. */
export function useSidebarState(locked = false): SidebarState {
  const [preference, setPreference] = useState<SidebarPreference | null>(() => readSidebarPreference(localStore()));
  const [width, setWidth] = useState(windowWidth);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mode = sidebarMode(width, preference);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    // Only the two breakpoints matter, so the width is re-read when one of them flips (no resize storm).
    const queries = [window.matchMedia(SIDEBAR_PHONE_QUERY), window.matchMedia(SIDEBAR_WIDE_QUERY)];
    const update = () => setWidth(window.innerWidth);
    for (const query of queries) query.addEventListener?.("change", update);
    update();
    return () => { for (const query of queries) query.removeEventListener?.("change", update); };
  }, []);

  // Another tab changed the choice.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => { if (event.key === SIDEBAR_STORAGE_KEY) setPreference(readSidebarPreference(localStore())); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Leaving the phone layout closes the drawer.
  useEffect(() => { if (mode !== "drawer") setDrawerOpen(false); }, [mode]);

  const toggle = useCallback(() => {
    const current = sidebarMode(windowWidth(), readSidebarPreference(localStore()) ?? preference);
    if (current === "drawer") { setDrawerOpen((open) => !open); return; }
    if (locked) return;
    const next: SidebarPreference = current === "expanded" ? "rail" : "expanded";
    writeSidebarPreference(localStore(), next);
    setPreference(next);
    setWidth(windowWidth());
  }, [preference, locked]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isSidebarToggleKey(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  return { mode, preference, drawerOpen, toggle, openDrawer, closeDrawer };
}
