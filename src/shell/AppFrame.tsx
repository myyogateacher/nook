import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useInboxCount } from "../AppShell";
import { focusIntoDialog, trapTabKey } from "../files/Dialog";
import { useReturnFocus } from "../calendar/hooks";
import { isEditableTarget } from "../ui/moduleKeys";
import { notify } from "../ui/notify";
import type { QuickActionDef } from "../workspaceModules/types";
import { AppSidebar, isMacPlatform, toggleShortcutLabel } from "./AppSidebar";
import type { NavItem, NavRecent, NavTree } from "./navModel";
import { paletteEntries, type PaletteEntry } from "./paletteModel";
import { paletteResultRenderers, resultGroups, shownApps } from "./paletteSearch";
import type { PaletteSearchRun } from "./usePaletteSearch";
import { appOfKind, useRecentItems } from "./recentItems";
import { appIcon } from "../ui/links/workIcons";
import type { SearchSection } from "../../shared/workspaceSearch";
import { ShellContext, useUnreadNotifications, type LeaveGuard, type ShellValue } from "./shellContext";
import { CommandPalette } from "./CommandPalette";
import { CustomizeSidebar, ShortcutSheet, type CustomizeApp } from "./ShellSheets";
import { shortcutGroups, type ShortcutContext } from "./shortcuts";
import { moveApp, updateAppsLayout, type AppsLayout } from "./sidebarPrefs";
import { useSidebarState } from "./useSidebarState";
import "./sidebar.css";

export type AppFrameProps = {
  tree: NavTree;
  displayName: string;
  avatarUrl?: string | null;
  /** Opens an item's app through App's `openApp` (Notes saves first). */
  onNavigate: (item: NavItem) => void;
  onAccount: () => void;
  onSignOut: () => void;
  /**
   * App's own leave guard (the Settings hub's unsaved-key confirm), asked before the page's guard
   * (Files' uploads) and before any sidebar move.
   */
  guard?: LeaveGuard;
  /** Phase 4 (D1294): the person's app order and pins (the tree is already arranged by them). */
  layout?: AppsLayout;
  /** Phase 4 (D1293): what the ⌘K palette offers beyond the tree, and how it opens paths. */
  palette?: FramePalette;
  /** Phase 4 (D1296): the "?" sheet's context (the module on screen, Notes, Time). */
  shortcuts?: Omit<ShortcutContext, "mac" | "notesSearch">;
  /** Phase 4 (D1294): every app the Customize sheet lists, and the Show switch (Settings → Modules). */
  customize?: { apps: readonly CustomizeApp[]; onShown: (id: string, shown: boolean) => void };
  children: ReactNode;
};

export type FramePalette = {
  recentNotes?: readonly NavRecent[];
  quickActions?: ReadonlyArray<QuickActionDef & { module: string }>;
  moduleLabels?: Readonly<Record<string, string>>;
  /** An in-app path (a recent note, a quick action's href), through App's openContentPath (Notes saves first). */
  onOpenPath: (href: string) => void;
  /** Opens Notes' search with the query (Notes saves first). */
  onSearchNotes: (query: string) => void;
  /** D1340: search across apps (the server's All scope); absent while the Search module is off. Keep it stable. */
  searchAll?: PaletteSearchRun;
  /** D1344: whose recently opened items the palette lists (recorded by App as pages open). */
  userId?: string;
};

/** ⌘K, or Ctrl+K elsewhere (either is accepted, as for ⌘\). */
export function isPaletteKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

/** "?" outside a text field and without ⌘, Ctrl, or Alt. */
export function isShortcutSheetKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">) {
  return event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target);
}

/** A modal of the page (a dialog, a sheet) is open; the phone drawer and the palette are the frame's own. */
const pageModalOpen = () => typeof document !== "undefined" && document.querySelector('[aria-modal="true"]:not(#app-drawer):not(.palette)') !== null;

/**
 * The signed-in app frame (docs/plan/LEFT_NAV.md §2.1, §3; D1270): a grid of the global sidebar and
 * the page. The page stays its own scroll container (scrollShells). On phones the sidebar is a modal
 * drawer (focus kept inside, Escape and the scrim close it, and it closes after any navigation) that
 * the page header's ☰ opens. A whiteboard canvas covers the frame (sidebar.css); a full-page task
 * card holds the rail through `useShellRail` (D1279).
 */
export function AppFrame({ tree, displayName, avatarUrl, onNavigate, onAccount, onSignOut, guard, layout, palette, shortcuts, customize, children }: AppFrameProps) {
  // A full-page task card holds the rail (D1279); phones keep the drawer.
  const [railHolds, setRailHolds] = useState(0);
  const sidebar = useSidebarState(railHolds > 0);
  const { drawerOpen, closeDrawer, openDrawer } = sidebar;
  const holdRail = useCallback(() => {
    setRailHolds((count) => count + 1);
    let released = false;
    return () => { if (!released) { released = true; setRailHolds((count) => count - 1); } };
  }, []);
  const railForced = railHolds > 0 && sidebar.mode !== "drawer";
  const mode = railForced ? "rail" : sidebar.mode;
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  const inboxShown = tree.primary.some((item) => item.kind === "inbox");
  const notificationsShown = tree.primary.some((item) => item.kind === "notifications");
  const inboxCount = useInboxCount(inboxShown);
  const unreadCount = useUnreadNotifications(notificationsShown);
  const attention = (inboxShown && inboxCount > 0) || (notificationsShown && unreadCount > 0);

  const guardRef = useRef(guard);
  guardRef.current = guard;
  /** App's guard, then the page's, then the move; the drawer closes first so a confirm is not under it. */
  const guarded = useCallback((action: () => void) => {
    closeDrawer();
    const page = () => { const pageGuard = leaveGuardRef.current; if (pageGuard) pageGuard(action); else action(); };
    const app = guardRef.current;
    if (app) app(page); else page();
  }, [closeDrawer]);

  // Phase 4: the ⌘K palette (D1293), the "?" sheet (D1296), and Customize sidebar (D1294). Closing one
  // without going anywhere puts focus back where it was.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheet, setSheet] = useState<"shortcuts" | "customize" | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rememberFocus = () => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".palette, #app-drawer")) returnFocusRef.current = active;
  };
  const restoreFocus = () => {
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    if (element?.isConnected) window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
  };
  const openPalette = useCallback(() => { rememberFocus(); closeDrawer(); setSheet(null); setPaletteOpen(true); }, [closeDrawer]);
  const openSheet = useCallback((which: "shortcuts" | "customize") => { if (!returnFocusRef.current) rememberFocus(); closeDrawer(); setPaletteOpen(false); setSheet(which); }, [closeDrawer]);
  const closePalette = () => { setPaletteOpen(false); restoreFocus(); };
  const closeSheet = () => { setSheet(null); restoreFocus(); };

  const toggleRef = useRef(sidebar.toggle);
  toggleRef.current = sidebar.toggle;
  const keysRef = useRef({ paletteOpen, openPalette, openSheet, closePalette });
  keysRef.current = { paletteOpen, openPalette, openSheet, closePalette };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const keys = keysRef.current;
      if (isPaletteKey(event)) {
        // ⌘K wins everywhere in the app, Notes' editor included (D1297); a page's dialog keeps it.
        if (keys.paletteOpen) { event.preventDefault(); keys.closePalette(); return; }
        if (pageModalOpen()) return;
        event.preventDefault();
        keys.openPalette();
      } else if (isShortcutSheetKey(event) && !keys.paletteOpen && !pageModalOpen()) {
        event.preventDefault();
        keys.openSheet("shortcuts");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const mac = isMacPlatform();
  // D1344: recently opened items, resolved (and access-checked) by the server each time it opens; only
  // kinds whose app this person's sidebar shows.
  const opened = useRecentItems(palette?.userId, paletteOpen);
  const recentItems = useMemo(() => {
    const apps = shownApps(tree);
    return opened.flatMap((item) => {
      const app = apps.get(appOfKind(item.kind));
      return app ? [{ kind: item.kind, id: item.id, title: item.title, href: item.href, icon: appIcon(item.kind), app: app.label }] : [];
    });
  }, [opened, tree]);
  const entries = useMemo(() => paletteOpen ? paletteEntries({
    tree,
    recentNotes: palette?.recentNotes,
    recentItems,
    quickActions: palette?.quickActions,
    moduleLabels: palette?.moduleLabels,
    searchNotes: tree.notesSearch,
    canToggleSidebar: mode !== "drawer" && !railForced,
    toggleShortcut: toggleShortcutLabel(),
    canCustomize: Boolean(customize)
  }) : [], [paletteOpen, tree, palette, recentItems, mode, railForced, customize]);
  // D1340: search across the apps this person's sidebar shows, drawn by each scope's renderer.
  const searchAll = palette?.searchAll;
  const paletteSearch = useMemo(() => {
    if (!paletteOpen || !searchAll) return undefined;
    const renderers = paletteResultRenderers();
    const apps = shownApps(tree);
    return { run: searchAll, groups: (sections: readonly SearchSection[]) => resultGroups(sections, renderers, apps) };
  }, [paletteOpen, searchAll, tree]);

  const runEntry = (entry: PaletteEntry) => {
    const action = entry.action;
    setPaletteOpen(false);
    if (action.kind === "command") {
      if (action.command === "toggleSidebar") { restoreFocus(); toggleRef.current(); }
      else openSheet(action.command);
      return;
    }
    returnFocusRef.current = null;
    if (action.kind === "nav") guarded(() => onNavigate(action.item));
    else if (action.kind === "path") guarded(() => palette?.onOpenPath(action.href));
    else if (action.kind === "searchNotes") guarded(() => palette?.onSearchNotes(action.query));
    else {
      const quick = action.action;
      const openPath = (path: string) => guarded(() => palette?.onOpenPath(path));
      if (quick.href && !quick.run) openPath(quick.href);
      else void Promise.resolve(quick.run?.({ openPath, flash: (message) => notify.info(message) })).catch((reason: unknown) => notify.error(reason instanceof Error ? reason.message : "That did not work"));
    }
  };

  const shownIds = [...tree.pinned, ...tree.apps].map((item) => item.id);
  const onMoveApp = (id: string, index: number, pinned: boolean) => updateAppsLayout(moveApp(layout, shownIds, id, index, pinned));

  // D1287: the slot the app on screen draws its own tree into (under its row, or in its flyout).
  const [sidebarSlot, setSidebarSlot] = useState<HTMLElement | null>(null);
  const appsLayout = layout ?? null;
  const shell = useMemo<ShellValue>(() => ({ mode, drawerOpen, openDrawer, closeDrawer, attention, leaveGuardRef, holdRail, sidebarSlot, appsLayout, openPalette }), [mode, drawerOpen, openDrawer, closeDrawer, attention, holdRail, sidebarSlot, appsLayout, openPalette]);

  const drawerRef = useRef<HTMLDivElement>(null);
  useReturnFocus(drawerOpen, ".shell-menu-button");
  useEffect(() => { if (drawerOpen) focusIntoDialog(drawerRef.current?.querySelector(".app-sidebar") as HTMLElement | null); }, [drawerOpen]);
  // The drawer's keys and clicks are native listeners: the app's tree in the slot is a portal, whose
  // React events bubble through the app, not through the drawer. Escape closes; Tab stays inside; a
  // link or action in the app's tree closes the drawer as any sidebar move does (a disclosure or a ⋯
  // menu's own button keeps it open).
  useEffect(() => {
    const element = drawerRef.current;
    if (!drawerOpen || !element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeDrawer(); return; }
      trapTabKey(event as unknown as ReactKeyboardEvent<HTMLElement>);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const action = target?.closest(".app-sidebar-slot a[href], .app-sidebar-slot button, .app-sidebar-slot [role='menuitem']");
      if (!action || action.closest("[data-keep-drawer]") || action.matches("[aria-haspopup='menu'], [aria-expanded]:not([role='menuitem'])")) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      closeDrawer();
    };
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("click", onClick);
    return () => { element.removeEventListener("keydown", onKeyDown); element.removeEventListener("click", onClick); };
  }, [drawerOpen, closeDrawer]);

  const sidebarElement = (drawer: boolean) => <AppSidebar
    tree={tree}
    mode={mode}
    displayName={displayName}
    avatarUrl={avatarUrl}
    inboxCount={inboxShown ? inboxCount : 0}
    unreadCount={notificationsShown ? unreadCount : 0}
    onNavigate={(item) => guarded(() => onNavigate(item))}
    onSearch={openPalette}
    onAccount={() => guarded(onAccount)}
    onSignOut={() => guarded(onSignOut)}
    onToggle={sidebar.toggle}
    railForced={railForced}
    onClose={drawer ? closeDrawer : undefined}
    onSlot={setSidebarSlot}
    onMoveApp={layout ? onMoveApp : undefined}
    onCustomize={customize ? () => openSheet("customize") : undefined}
    onShortcuts={() => openSheet("shortcuts")}
  />;

  return <ShellContext.Provider value={shell}>
    <div className="app-frame" data-sidebar={mode}>
      {mode !== "drawer" && sidebarElement(false)}
      <div className="app-frame-page">{children}</div>
      {mode === "drawer" && drawerOpen && <div className="app-drawer-layer">
        <button type="button" className="app-drawer-scrim" tabIndex={-1} aria-label="Close menu" onClick={closeDrawer} />
        <div ref={drawerRef} id="app-drawer" className="app-drawer" role="dialog" aria-modal="true" aria-label="Menu">
          {sidebarElement(true)}
        </div>
      </div>}
      {paletteOpen && <CommandPalette entries={entries} searchNotes={tree.notesSearch} search={paletteSearch} onRun={runEntry} onClose={closePalette} />}
      {sheet === "shortcuts" && <ShortcutSheet groups={shortcutGroups({ mac, notesSearch: tree.notesSearch, ...shortcuts })} onClose={closeSheet} />}
      {sheet === "customize" && customize && <CustomizeSidebar apps={customize.apps} layout={layout ?? {}} onLayout={updateAppsLayout} onShown={customize.onShown} onClose={closeSheet} />}
    </div>
  </ShellContext.Provider>;
}
