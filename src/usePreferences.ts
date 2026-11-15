import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PREFERENCES, withModuleEnabled, type ModuleId, type Preferences } from "./modules";
import { getPreferences, savePreferences } from "./preferencesApi";
import { sameSidebarLayout, type SidebarLayout } from "../shared/sidebar";

export type PreferencesStatus = { kind: "conflict" | "error"; message: string } | null;

const sameIds = (left: readonly ModuleId[], right: readonly ModuleId[]) => left.length === right.length && left.every((id, index) => right[index] === id);

/** A sidebar change waits this long for the next one before it is sent (a drag, several moves). */
export const SIDEBAR_SAVE_DELAY_MS = 600;

/**
 * The signed-in user's preferences (D92). Toggles apply at once (optimistic) and are saved one at a
 * time with the last confirmed revision. A 409 shows the server's value; any other failure goes
 * back to the last saved value. Coming back to the tab re-reads them, so another device's change
 * shows up without a reload.
 *
 * The sidebar's layout (left navigation phase 4, D1295) rides on the same row and revision: it is
 * sent a moment after the last change (debounced) with the modules. When only the layout changed
 * and another device saved meanwhile (409), this tab's layout is sent again on the server's newer
 * revision and modules: the latest arrangement wins, and nobody's module choice is undone. Errors
 * other than a conflict keep the layout in this browser (it is retried with the next change).
 *
 * `initial` is the value from /api/auth/me; without it (right after sign-in) the hook fetches it.
 * `loaded` says the server's value is known (from `initial` or the fetch).
 */
export function usePreferences(userId: string | null, initial: Preferences | undefined) {
  const [preferences, setPreferences] = useState<Preferences>(initial ?? DEFAULT_PREFERENCES);
  const [status, setStatus] = useState<PreferencesStatus>(null);
  const [loaded, setLoaded] = useState(Boolean(initial));
  const confirmedRef = useRef<Preferences>(initial ?? DEFAULT_PREFERENCES);
  const desiredRef = useRef<ModuleId[]>((initial ?? DEFAULT_PREFERENCES).disabledModules);
  const desiredSidebarRef = useRef<SidebarLayout | undefined>((initial ?? DEFAULT_PREFERENCES).sidebar);
  const sidebarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const userRef = useRef(userId);
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const apply = useCallback((next: Preferences) => {
    confirmedRef.current = next;
    desiredRef.current = next.disabledModules;
    desiredSidebarRef.current = next.sidebar;
    setPreferences(next);
  }, []);

  const sidebarWaiting = () => sidebarTimerRef.current !== null
    || (desiredSidebarRef.current !== undefined && !sameSidebarLayout(desiredSidebarRef.current, confirmedRef.current.sidebar));

  const refresh = useCallback(async () => {
    const user = userRef.current;
    if (!user) return;
    try {
      const next = await getPreferences();
      if (userRef.current !== user) return;
      setLoaded(true);
      // A toggle or a layout change made meanwhile wins; its own save reports any conflict.
      if (pendingRef.current === 0 && sameIds(desiredRef.current, confirmedRef.current.disabledModules) && !sidebarWaiting()) apply(next);
    } catch {
      // Best effort: keep what is shown (for example behind the TOTP setup gate).
    }
  }, [apply]);

  useEffect(() => {
    userRef.current = userId;
    setStatus(null);
    pendingRef.current = 0;
    chainRef.current = Promise.resolve();
    if (sidebarTimerRef.current) { clearTimeout(sidebarTimerRef.current); sidebarTimerRef.current = null; }
    apply(initialRef.current ?? DEFAULT_PREFERENCES);
    setLoaded(Boolean(initialRef.current));
    if (userId && !initialRef.current) void refresh();
  }, [userId, apply, refresh]);

  useEffect(() => () => { if (sidebarTimerRef.current) clearTimeout(sidebarTimerRef.current); }, []);

  useEffect(() => {
    if (!userId) return;
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId, refresh]);

  /** Sends what is wanted (modules and layout) unless the server already has it. One save at a time. */
  const enqueueSave = useCallback((user: string) => {
    pendingRef.current += 1;
    chainRef.current = chainRef.current.then(async () => {
      try {
        if (userRef.current !== user) return;
        const wanted = desiredRef.current;
        const wantedSidebar = desiredSidebarRef.current;
        const modulesChanged = !sameIds(wanted, confirmedRef.current.disabledModules);
        const sidebarChanged = wantedSidebar !== undefined && !sameSidebarLayout(wantedSidebar, confirmedRef.current.sidebar);
        if (!modulesChanged && !sidebarChanged) return;
        let result = await savePreferences(wanted, confirmedRef.current.revision, sidebarChanged ? wantedSidebar : undefined);
        if (userRef.current !== user) return;
        if (!result.ok && !modulesChanged && wantedSidebar) {
          // Only the layout changed here: keep the other device's modules, send this layout on its revision.
          const server = result.conflict;
          confirmedRef.current = server;
          desiredRef.current = server.disabledModules;
          setPreferences((current) => ({ ...current, disabledModules: server.disabledModules }));
          result = sameSidebarLayout(wantedSidebar, server.sidebar) ? { ok: true, preferences: server } : await savePreferences(server.disabledModules, server.revision, wantedSidebar);
          if (userRef.current !== user) return;
        }
        if (result.ok) {
          confirmedRef.current = result.preferences;
          setPreferences({ ...result.preferences, disabledModules: desiredRef.current });
        } else {
          apply(result.conflict);
          if (modulesChanged) setStatus({ kind: "conflict", message: "Modules were changed on another device or tab. The latest choice is shown; try again if needed." });
        }
      } catch (reason) {
        if (userRef.current !== user) return;
        const sidebarOnly = sameIds(desiredRef.current, confirmedRef.current.disabledModules);
        if (sidebarOnly) return; // The layout stays in this browser; the next change sends it again.
        apply(confirmedRef.current);
        setStatus({ kind: "error", message: `${reason instanceof Error ? reason.message : "Could not save"}. Your modules were not changed.` });
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
      }
    });
  }, [apply]);

  const setModuleEnabled = useCallback((id: ModuleId, enabled: boolean) => {
    const user = userRef.current;
    if (!user) return;
    const next = withModuleEnabled(desiredRef.current, id, enabled);
    desiredRef.current = next;
    setPreferences((current) => ({ ...current, disabledModules: next }));
    setStatus(null);
    enqueueSave(user);
  }, [enqueueSave]);

  /** The sidebar's layout changed in this browser (D1295): sent after a short pause. */
  const setSidebar = useCallback((layout: SidebarLayout) => {
    const user = userRef.current;
    if (!user) return;
    desiredSidebarRef.current = layout;
    if (sidebarTimerRef.current) clearTimeout(sidebarTimerRef.current);
    sidebarTimerRef.current = setTimeout(() => {
      sidebarTimerRef.current = null;
      if (userRef.current === user) enqueueSave(user);
    }, SIDEBAR_SAVE_DELAY_MS);
  }, [enqueueSave]);

  return { preferences, status, loaded, setModuleEnabled, setSidebar, refresh };
}
