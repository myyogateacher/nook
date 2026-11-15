import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { FriendlyLinkGate } from "../FriendlyLinkGate";
import { popStateClosedDialog } from "../historyDialogs";
import { parseRoute, type Route } from "../router";
import { SHELL_ROUTE_EVENT } from "../shell/locationSignal";
import { workspaceHomeRoute, workspaceModule } from "./registry";
import type { WorkspaceAppProps, WorkspaceModuleId, WorkspaceRoute } from "./types";

type HostProps = Omit<WorkspaceAppProps, "route" | "navigate"> & {
  id: WorkspaceModuleId;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
};

/**
 * The module's own route for an in-app path (a work ref's or notification's href), or null when the
 * path belongs to another app or is not a same-origin path.
 */
export function inModuleRoute(id: WorkspaceModuleId, path: string): WorkspaceRoute | null {
  let url: URL;
  try {
    url = new URL(path, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const route = parseRoute(url.pathname, url.search);
  return route.app === id ? route as WorkspaceRoute : null;
}

const currentRoute = (id: WorkspaceModuleId): WorkspaceRoute => {
  const route = parseRoute(window.location.pathname, window.location.search);
  return route.app === id ? route as WorkspaceRoute : workspaceHomeRoute(id);
};

/**
 * The one generic render branch of App.tsx for workspace modules (D833): a friendly link is resolved
 * first (FriendlyLinkGate), then the module's lazy app mounts with the standard props and its route,
 * which follows the location: the module's own moves, Back, and Forward (a popstate a dialog consumed
 * is left alone, D18). A path the module opens through `onOpenPath` that is its own (a link from one
 * of its items to another) moves the module the same way; any other path goes to App's handler.
 * A module without an app (a stub) is never routed here: its segment does not parse.
 */
export function WorkspaceModuleHost({ id, navigate, onOpenPath, ...props }: HostProps) {
  const module = workspaceModule(id);
  const [route, setRoute] = useState<WorkspaceRoute>(() => currentRoute(id));
  // A friendly link this tab cannot name yet is resolved by a fresh gate (it reads the location on mount).
  const [gate, setGate] = useState(0);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const openPathRef = useRef(onOpenPath);
  openPathRef.current = onOpenPath;

  const go = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    if (next.app === id) setRoute(next as WorkspaceRoute);
    navigateRef.current(next, options);
    if (next.app === id && (next as WorkspaceRoute).pending) setGate((value) => value + 1);
  }, [id]);

  const openPath = useCallback((path: string) => {
    const next = inModuleRoute(id, path);
    if (next) go(next);
    else openPathRef.current(path);
  }, [id, go]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname, window.location.search);
      if (next.app === id) setRoute(next as WorkspaceRoute);
    };
    // The sidebar moved this module to another of its sections (D1282): follow the address, as on Back.
    const onShellRoute = () => {
      const next = parseRoute(window.location.pathname, window.location.search);
      if (next.app === id) setRoute(next as WorkspaceRoute);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener(SHELL_ROUTE_EVENT, onShellRoute);
    return () => { window.removeEventListener("popstate", onPopState); window.removeEventListener(SHELL_ROUTE_EVENT, onShellRoute); };
  }, [id]);

  if (!module?.app) return null;
  const App = module.app;
  return <FriendlyLinkGate key={gate} app={id} listRoute={workspaceHomeRoute(id)} navigate={go}>
    <Suspense fallback={<main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading {module.label}…</p></main>}>
      <App {...props} route={route} navigate={go} onOpenPath={openPath} />
    </Suspense>
  </FriendlyLinkGate>;
}
