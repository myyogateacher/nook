import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ellipsis, House, LayoutGrid, List as ListIcon, PenTool, Plus, RotateCcw, Sparkles, TriangleAlert, Users } from "lucide-react";
import { api } from "../api";
import { AccountActions, AppPageName, useBinCount } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { relativeTime } from "../files/format";
import { popStateClosedDialog } from "../historyDialogs";
import { isMobileViewport } from "../mobileNavigation";
import { parseRoute, type Route } from "../router";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import type { Folder } from "../types";
import { Avatar } from "../ui/Avatar";
import { IntegrationBadge } from "../ui/IntegrationBadge";
import { Select } from "../ui/Select";
import { whiteboardsBackAction, whiteboardsRoute, type WhiteboardsRoute } from "../whiteboardsRoute";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";
import { BoardDialogs, NewBoardDialog, type BoardDialog } from "./BoardDialogs";
import { PENDING_SYNCED_EVENT, pendingSyncDeps, requestPendingSync } from "./pendingSync";
import { listWhiteboards, THUMBNAIL_EVENT, thumbnailUrl, type WhiteboardSort, type WhiteboardSummary } from "./whiteboardsApi";
import "../files/files.css";
import "./whiteboards.css";

/**
 * The canvas is the app's only lazy route chunk (D191, Q13): Excalidraw and its CSS load on the
 * first visit to /whiteboards/:id, never for people who do not open a board. Fonts are self-hosted
 * (D203): the asset path is set before the import, so no inline script is needed.
 */
const loadCanvas = () => {
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  return import("./WhiteboardCanvas");
};
const WhiteboardCanvas = lazy(loadCanvas);
let prefetched = false;
/** Desktop only: a card hovered or focused starts loading the canvas chunk (Q13). */
const prefetchCanvas = () => {
  if (prefetched || isMobileViewport()) return;
  prefetched = true;
  void loadCanvas().catch(() => { prefetched = false; });
};

type WhiteboardsNavigate = (route: Route, options?: { replace?: boolean; removed?: boolean }) => void;

/**
 * Wave 23 QA 1c: the canvas chunk could not be loaded (offline, or a release removed it and the one
 * reload chunkReload.ts allows did not help). Instead of a blank page: what happened, Retry, and the
 * way back to the list. Retry loads the page again: the browser keeps a failed module import for the
 * life of the page, so only a fresh page fetches the chunk again (nothing is unsaved: the canvas never
 * opened).
 */
class CanvasLoadBoundary extends Component<{ children: ReactNode; onRetry: () => void; onBack: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Could not load the whiteboard editor", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="whiteboard-canvas-page whiteboard-loading" role="alert">
      <TriangleAlert aria-hidden="true" />
      <p>The whiteboard editor could not be loaded. Check your connection and try again.</p>
      <div className="whiteboard-load-actions">
        <button type="button" className="primary-button" onClick={() => { this.setState({ failed: false }); this.props.onRetry(); }}><RotateCcw />Retry</button>
        <button type="button" className="secondary-button" onClick={this.props.onBack}>Back to whiteboards</button>
      </div>
    </div>;
  }
}

type WhiteboardsAppProps = {
  userId: string;
  displayName: string;
  navigate: WhiteboardsNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onBin?: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens an in-app path (a link on a shape) as a new history entry. */
  onOpenPath: (path: string) => void;
};

const currentRoute = (): WhiteboardsRoute => {
  const route = parseRoute(window.location.pathname);
  return route.app === "whiteboards" ? route : whiteboardsRoute();
};

type ViewMode = "grid" | "list";
const viewKey = (userId: string) => `mynotes:whiteboards-view:${userId}`;
function readView(userId: string): ViewMode {
  try { return window.localStorage.getItem(viewKey(userId)) === "list" ? "list" : "grid"; } catch { return "grid"; }
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

/** QA Q6: the Files list's name and modified orders; the server pages in the chosen one. */
export const WHITEBOARD_SORT_OPTIONS: Array<{ value: WhiteboardSort; label: string }> = [
  { value: "updated-desc", label: "Newest modified" },
  { value: "updated-asc", label: "Oldest modified" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" }
];
const sortKey = (userId: string) => `mynotes:whiteboards-sort:${userId}`;
function readSort(userId: string): WhiteboardSort {
  try {
    const value = window.localStorage.getItem(sortKey(userId));
    return WHITEBOARD_SORT_OPTIONS.some((option) => option.value === value) ? value as WhiteboardSort : "updated-desc";
  } catch {
    return "updated-desc";
  }
}

/**
 * Whiteboards (docs/plan/research/2026-09-28-whiteboard-module.md §10): the list at /whiteboards
 * (all, shared, or one folder) and a board's canvas at /whiteboards/:id, each a history entry;
 * sheets and dialogs push none, so Back closes them first (D18), then the canvas, then the app.
 */
export function WhiteboardsApp({ userId, displayName, navigate, flash, onHome, onBin, onSettings, onSignOut, onOpenPath }: WhiteboardsAppProps) {
  const { canWrite } = useRole();
  const binCount = useBinCount(Boolean(onBin));
  const [route, setRoute] = useState<WhiteboardsRoute>(currentRoute);
  const [boards, setBoards] = useState<WhiteboardSummary[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => readView(userId));
  const [sort, setSort] = useState<WhiteboardSort>(() => readSort(userId));
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [creating, setCreating] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const generation = useRef(0);

  const go = useCallback((next: WhiteboardsRoute, replace = false) => {
    setRoute(next);
    navigateRef.current(next, { replace });
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname);
      if (next.app === "whiteboards") setRoute(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const folderFilter = route.folder;
  const loadList = useCallback(async () => {
    const current = ++generation.current;
    setLoadError(null);
    try {
      const [{ whiteboards, nextCursor: more }, { folders: loaded }] = await Promise.all([listWhiteboards(folderFilter, null, sort), api<{ folders: Folder[] }>("/folders")]);
      if (current !== generation.current) return;
      setBoards(whiteboards);
      setNextCursor(more);
      setFolders(loaded);
    } catch (reason) {
      if (current === generation.current) setLoadError(messageOf(reason, "Could not load your whiteboards"));
    }
  }, [folderFilter, sort]);

  // The list reloads when it is shown (and after the canvas closes, so thumbnails and names are fresh).
  useEffect(() => {
    if (route.boardId) return;
    void loadList();
  }, [loadList, route.boardId]);

  // QA E5: showing the list sends pending copies from earlier visits (one at a time, through the
  // CAS save); the list refreshes once any was saved.
  const showingList = !route.boardId;
  useEffect(() => {
    if (!showingList) return;
    // A run stops at its next step once this person has signed out (the app shell says who is signed in).
    void requestPendingSync(() => pendingSyncDeps(userId));
  }, [showingList, userId]);
  useEffect(() => {
    const onSynced = () => {
      const now = parseRoute(window.location.pathname);
      if (now.app === "whiteboards" && !now.boardId) void loadList();
    };
    window.addEventListener(PENDING_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(PENDING_SYNCED_EVENT, onSynced);
  }, [loadList]);

  useEffect(() => {
    if (route.boardId) return;
    const folderName = route.folder === "shared" ? "Shared" : route.folder !== "all" ? folders.find((folder) => folder.id === route.folder)?.name : null;
    document.title = `${folderName ? `${folderName} · ` : ""}Whiteboards · Nook`;
  }, [folders, route.boardId, route.folder]);

  const openBoard = useCallback((board: Pick<WhiteboardSummary, "id">) => {
    setDialog(null);
    go(whiteboardsRoute(folderFilter, board.id));
  }, [folderFilter, go]);

  const back = useCallback(() => {
    const action = whiteboardsBackAction(currentRoute(), readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "replace") go(action.route, true);
    else onHome();
  }, [go, onHome]);

  async function loadMore() {
    if (!nextCursor) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await listWhiteboards(folderFilter, nextCursor, sort);
      if (current !== generation.current) return;
      setBoards((existing) => [...(existing ?? []), ...page.whiteboards.filter((board) => !(existing ?? []).some((item) => item.id === board.id))]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      flash(messageOf(reason, "Could not load more whiteboards"));
    } finally {
      setLoadingMore(false);
    }
  }

  const chooseSort = (next: WhiteboardSort) => {
    setSort(next);
    try { window.localStorage.setItem(sortKey(userId), next); } catch { /* private mode: this visit only */ }
  };

  const chooseView = (next: ViewMode) => {
    setView(next);
    try { window.localStorage.setItem(viewKey(userId), next); } catch { /* private mode: this visit only */ }
  };

  const patchBoard = useCallback((patch: Partial<WhiteboardSummary> & { id: string }) => {
    setBoards((current) => current?.map((board) => board.id === patch.id ? { ...board, ...patch } : board) ?? current);
  }, []);

  useEffect(() => {
    const onThumbnail = (event: Event) => {
      const { id, revision } = (event as CustomEvent<{ id: string; revision: number }>).detail;
      patchBoard({ id, hasThumbnail: true, thumbRevision: revision });
    };
    window.addEventListener(THUMBNAIL_EVENT, onThumbnail);
    return () => window.removeEventListener(THUMBNAIL_EVENT, onThumbnail);
  }, [patchBoard]);

  const folderOptions = useMemo(() => {
    const owned = folders.filter((folder) => folder.is_owner === 1).sort((a, b) => b.is_default - a.is_default || a.name.localeCompare(b.name));
    const shared = folders.filter((folder) => folder.is_owner !== 1);
    return [
      { value: "all", label: "All whiteboards" },
      { value: "shared", label: "Shared with me" },
      ...owned.map((folder) => ({ value: folder.id, label: folder.name, group: "Your folders" })),
      ...shared.map((folder) => ({ value: folder.id, label: folder.name, description: folder.owner_name, group: "Shared folders" }))
    ];
  }, [folders]);

  if (route.boardId) {
    return <CanvasLoadBoundary key={route.boardId} onBack={back} onRetry={() => window.location.reload()}><Suspense fallback={<div className="whiteboard-canvas-page whiteboard-loading" role="status"><PenTool aria-hidden="true" /><p>Opening the whiteboard…</p></div>}>
      <WhiteboardCanvas
        key={route.boardId}
        boardId={route.boardId}
        userId={userId}
        folders={folders}
        flash={flash}
        onBack={back}
        onOpenPath={onOpenPath}
        onOpenBoard={(id) => go(whiteboardsRoute(folderFilter, id))}
        onAccessLost={() => { flash("You no longer have access to this whiteboard"); go(whiteboardsRoute(folderFilter), true); }}
        onDeleted={() => {
          // Wave 23 QA 1e: the board is gone, so its entry is not left behind for Back to repeat.
          const list = whiteboardsRoute(folderFilter);
          setRoute(list);
          navigateRef.current(list, { replace: true, removed: true });
        }}
      />
    </Suspense></CanvasLoadBoundary>;
  }

  const count = boards?.length ?? 0;
  const countLabel = nextCursor ? `${count}+` : String(count);
  const heading = route.folder === "shared" ? "Shared with me" : route.folder === "all" ? "All whiteboards" : folders.find((folder) => folder.id === route.folder)?.name ?? "Folder";

  return <main className="app-page whiteboards-app">
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Whiteboards</strong></span></span><AppPageName name="Whiteboards" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />
    </header>
    <ReadOnlyBanner />
    <section className="whiteboards-body" aria-labelledby="whiteboards-title">
      <div className="whiteboards-toolbar">
        <h1 id="whiteboards-title">{heading}{boards && <span className="whiteboards-count"> · {countLabel}</span>}</h1>
        <div className="whiteboards-controls">
          <Select label="Show" value={route.folder} onChange={(value) => { if (value !== route.folder) go(whiteboardsRoute(value)); }} options={folderOptions} className="whiteboards-folder-select" />
          <Select label="Sort" value={sort} onChange={chooseSort} options={WHITEBOARD_SORT_OPTIONS} className="whiteboards-sort-select" />
          <div className="whiteboards-view-toggle" role="group" aria-label="Layout">
            <button type="button" className={view === "grid" ? "active" : ""} aria-pressed={view === "grid"} onClick={() => chooseView("grid")} aria-label="Grid" title="Grid"><LayoutGrid /></button>
            <button type="button" className={view === "list" ? "active" : ""} aria-pressed={view === "list"} onClick={() => chooseView("list")} aria-label="List" title="List"><ListIcon /></button>
          </div>
          {canWrite && <button type="button" className="primary-button whiteboards-new" onClick={() => setCreating(true)}><Plus />New</button>}
        </div>
      </div>

      {loadError && <div className="whiteboards-state" role="alert">
        <span className="whiteboards-state-icon"><TriangleAlert /></span>
        <h2>Could not load your whiteboards</h2>
        <p>{loadError}</p>
        <button className="secondary-button" onClick={() => { void loadList(); }}><RotateCcw />Try again</button>
      </div>}
      {!loadError && !boards && <ul className={`whiteboards-grid whiteboards-${view}`} aria-busy="true" aria-label="Loading whiteboards">
        {Array.from({ length: 4 }, (_, index) => <li key={index} className="whiteboard-card whiteboard-skeleton" aria-hidden="true"><span className="whiteboard-thumb" /><span className="whiteboard-card-copy"><span /><span /></span></li>)}
      </ul>}
      {!loadError && boards && boards.length === 0 && <div className="whiteboards-state">
        <span className="whiteboards-state-icon"><PenTool /></span>
        <h2>{route.folder === "shared" ? "Nothing shared with you" : "No whiteboards yet"}</h2>
        <p>{route.folder === "shared" ? "Whiteboards other people share with you appear here." : "Sketch a plan, a floor plan, or a retro."}</p>
        {canWrite && route.folder !== "shared" && <button className="primary-button" onClick={() => setCreating(true)}><Plus />New whiteboard</button>}
      </div>}
      {!loadError && boards && boards.length > 0 && <ul className={`whiteboards-grid whiteboards-${view}`} aria-label={heading}>
        {boards.map((board) => {
          const name = whiteboardDisplayName(board.name);
          return <li key={board.id} className="whiteboard-card">
            <button type="button" className="whiteboard-open" onClick={() => openBoard(board)} onMouseEnter={prefetchCanvas} onFocus={prefetchCanvas} aria-label={`Open ${name}`}>
              <span className="whiteboard-thumb">{board.hasThumbnail ? <img src={thumbnailUrl(board)} alt="" loading="lazy" draggable={false} /> : <PenTool aria-hidden="true" />}</span>
              <span className="whiteboard-card-copy">
                <span className="whiteboard-name" title={name}>{name}</span>
                <span className="whiteboard-meta">
                  <time dateTime={board.updated_at}>{relativeTime(board.updated_at)}</time>
                  {board.is_owner === 0 && <span className="owner-badge"><Avatar className="whiteboard-owner-avatar" name={board.owner_name} url={board.ownerAvatarUrl} integration={board.ownerIsIntegration} />{board.owner_name}{board.ownerIsIntegration && <IntegrationBadge />}</span>}
                  {board.visibility !== "private" && <Users className="whiteboard-shared" aria-label="Shared" />}
                </span>
              </span>
            </button>
            <button type="button" className="icon-button whiteboard-more" onClick={() => setDialog({ kind: "actions", board })} aria-haspopup="dialog" aria-label={`Actions for ${name}`}><Ellipsis /></button>
          </li>;
        })}
      </ul>}
      {!loadError && boards && nextCursor && <button type="button" className="secondary-button whiteboards-more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</button>}
    </section>

    <BoardDialogs dialog={dialog} folders={folders} flash={flash}
      onClose={() => setDialog(null)}
      onOpen={openBoard}
      onChanged={(patch) => { patchBoard(patch); if (patch.folder_id !== undefined && route.folder !== "all") void loadList(); }}
      onDeleted={(board) => setBoards((current) => current?.filter((item) => item.id !== board.id) ?? current)}
      onAction={(action, board) => setDialog({ kind: action, board })} />
    {creating && <NewBoardDialog folders={folders} initialFolderId={route.folder !== "all" && route.folder !== "shared" ? route.folder : null}
      onCancel={() => setCreating(false)}
      onCreated={(board) => { setCreating(false); openBoard(board); }} />}
  </main>;
}
