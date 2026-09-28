import { useCallback, useEffect, useRef, useState } from "react";
import { House, Sparkles } from "lucide-react";
import { AccountActions, useBinCount, AppPageName } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { popStateClosedDialog } from "../historyDialogs";
import { formatRoute, parseRoute, type Route } from "../router";
import { collectionsBackAction, collectionsRoute, createCollectionsHistoryState, underlyingViewFor, type CollectionsRoute } from "../collectionsRoute";
import { CollectionList } from "./CollectionList";
import { CollectionView } from "./CollectionView";
import { useCollectionsDialogGuard } from "./dialogLayers";
import "../bin/bin.css";
import "../files/files.css";
import "./collections.css";
import { ReadOnlyBanner } from "../team/roleAccess";

export type CollectionsNavigate = (route: Route, options?: { replace?: boolean }) => void;

type CollectionsAppProps = {
  userId: string;
  displayName: string;
  navigate: CollectionsNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  /** Opens the Bin from the header (Bin placement, Wave 10). */
  onBin?: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

const currentRoute = (): CollectionsRoute => {
  const route = parseRoute(window.location.pathname);
  return route.app === "collections" ? route : collectionsRoute();
};

export type GoOptions = { replace?: boolean; underlyingViewId?: string | null };

/**
 * Collections (D69): the list (/collections), a collection (/collections/:c), a saved view
 * (/collections/:c/view/:v), and a row (/collections/:c/row/:r). Every view is a history entry;
 * dialogs and sheets push none. Back steps row → view → collection → list → Home.
 */
export function CollectionsApp({ userId, displayName, navigate, flash, onHome, onBin, onSettings, onSignOut }: CollectionsAppProps) {
  const binCount = useBinCount(Boolean(onBin));
  const [route, setRoute] = useState<CollectionsRoute>(currentRoute);
  const [underlyingViewId, setUnderlyingViewId] = useState<string | null>(() => underlyingViewFor(window.history.state, userId, currentRoute()));
  const routeRef = useRef(route);
  routeRef.current = route;
  const underlyingRef = useRef(underlyingViewId);
  underlyingRef.current = underlyingViewId;
  // App's navigate is recreated on every render; read it through a ref so effects run once.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useCollectionsDialogGuard();
  const [importFor, setImportFor] = useState<string | null>(null);
  const importOpened = useCallback(() => setImportFor(null), []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname);
      if (next.app !== "collections") return;
      setRoute(next);
      setUnderlyingViewId(underlyingViewFor(event.state, userId, next));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [userId]);

  const go = useCallback((next: CollectionsRoute, options: GoOptions = {}) => {
    const replace = options.replace ?? false;
    const underlying = next.rowId ? options.underlyingViewId ?? null : null;
    setRoute(next);
    setUnderlyingViewId(underlying);
    if (formatRoute(next) !== window.location.pathname || replace) navigateRef.current(next, { replace });
    // Row entries remember the view they were opened over (the URL names only the row).
    if (next.rowId && next.collectionId) {
      window.history.replaceState(createCollectionsHistoryState(userId, { collectionId: next.collectionId, rowId: next.rowId, viewId: underlying }, window.history.state), "", window.location.pathname);
    }
  }, [userId]);

  const back = useCallback(() => {
    const action = collectionsBackAction(routeRef.current, readHistoryDepth(window.history.state), underlyingRef.current);
    if (action.kind === "history") window.history.back();
    else if (action.kind === "replace") go(action.route, { replace: true });
    else onHome();
  }, [go, onHome]);

  const onMissing = useCallback((what: "collection" | "view" | "row") => {
    const current = routeRef.current;
    if (what === "collection") {
      flash("Collection not found");
      go(collectionsRoute(), { replace: true });
    } else if (what === "view") {
      flash("View not found");
      go(collectionsRoute(current.collectionId), { replace: true });
    } else {
      flash("Row not found");
      go(collectionsRoute(current.collectionId, { viewId: underlyingRef.current }), { replace: true });
    }
  }, [flash, go]);

  return <main className={`app-page collections-app${route.collectionId ? " collections-open" : ""}${route.rowId ? " collections-row-open" : ""}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Collections</strong></span></span><AppPageName name="Collections" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />
    </header>
    <ReadOnlyBanner />
    {route.collectionId
      ? <CollectionView
        key={route.collectionId}
        userId={userId}
        collectionId={route.collectionId}
        viewId={route.rowId ? underlyingViewId : route.viewId}
        rowId={route.rowId}
        go={go}
        onBack={back}
        onMissing={onMissing}
        openImport={importFor === route.collectionId}
        onImportOpened={importOpened}
        notify={flash}
      />
      : <CollectionList userId={userId} onOpen={(collection) => go(collectionsRoute(collection.id))} onOpenRow={(collectionId, rowId) => go(collectionsRoute(collectionId, { rowId }))} notify={flash}
        onCreatedForImport={(collection) => { setImportFor(collection.id); go(collectionsRoute(collection.id)); }} />}
  </main>;
}
