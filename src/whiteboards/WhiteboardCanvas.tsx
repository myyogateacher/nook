import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChevronLeft, Cloud, CloudOff, Ellipsis, ImageDown, LoaderCircle, Share2, TriangleAlert } from "lucide-react";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { ApiError } from "../api";
import { ConfirmDialog, ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { Folder } from "../types";
import { whiteboardDisplayName, type CanonicalScene } from "../../shared/whiteboardScene";
import { AUTOSAVE_DEBOUNCE_MS, autosaveLabel, autosaveReducer, hasPendingWork, initialAutosave, LEAVE_FLUSH_MS, pendingCopyAction, shouldSave, THUMBNAIL_INTERVAL_MS } from "./autosave";
import { BoardDialogs, type BoardDialog } from "./BoardDialogs";
import { changeKey, closedExcalidrawLayers, EXCALIDRAW_LAYER_SELECTOR, excalidrawLayerOpen, hasUnsupportedElements, linkTarget, sceneForLoad, sceneForSave } from "./historyGuard";
import { clearPending, readPending, writePending, type PendingEntry } from "./pendingStore";
import { announceThumbnail, createWhiteboard, getWhiteboard, putWhiteboardThumbnail, saveWhiteboardScene, type WhiteboardSummary } from "./whiteboardsApi";

/**
 * One board's canvas (whiteboard plan §10.3, D194, D202, D210): Excalidraw under Nook's 44 px header
 * with Back, the name, the save status, and the board menu. Only the owner edits; everyone else gets
 * Excalidraw's view mode (D195). Autosave writes 1.5 s after the last edit, on leave, and when the
 * tab is hidden, with the revision CAS; a pending copy in IndexedDB covers a crash or an offline
 * moment. Excalidraw's menus and dialogs, and Nook's sheets, close on Back first; undo never
 * touches history.
 */

type Props = {
  boardId: string;
  userId: string;
  folders: Folder[];
  flash: (message: string) => void;
  onBack: () => void;
  onOpenPath: (path: string) => void;
  onOpenBoard: (id: string) => void;
  onMissing: () => void;
  onDeleted: () => void;
};

type Loaded = { board: WhiteboardSummary; scene: CanonicalScene };
type Layer = { kind: "board"; dialog: BoardDialog } | { kind: "conflict" } | { kind: "discard" };

const PENDING_DEBOUNCE_MS = 500;
const THUMBNAIL_MAX_SIDE = 640;
const THUMBNAIL_MAX_BYTES = 128 * 1024;
const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
/** The appState a scene opens with (and that the first change key is computed from). */
const initialAppState = (scene: CanonicalScene) => ({ viewBackgroundColor: scene.appState.viewBackgroundColor ?? "#ffffff", gridSize: scene.appState.gridSize ?? 20, gridModeEnabled: scene.appState.gridModeEnabled ?? false });
const codeOf = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string; revision?: number }) : null;

export default function WhiteboardCanvas({ boardId, userId, folders, flash, onBack, onOpenPath, onOpenBoard, onMissing, onDeleted }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offer, setOffer] = useState<PendingEntry | null>(null);
  const [layer, setLayer] = useState<Layer | null>(null);
  const [excalidrawLayer, setExcalidrawLayer] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [autosave, dispatch] = useReducer(autosaveReducer, initialAutosave(1));
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const stateRef = useRef(autosave);
  stateRef.current = autosave;
  const boardRef = useRef<WhiteboardSummary | null>(null);
  boardRef.current = loaded?.board ?? null;
  const lastKeyRef = useRef<string | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);
  const pendingTimer = useRef<number | null>(null);
  const lastThumbAt = useRef(0);
  /** The revision the newest thumbnail shows, so leaving refreshes a stale one (D200). */
  const thumbRevision = useRef<number | null>(null);
  const mounted = useRef(true);
  const applyPendingRef = useRef<PendingEntry | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const canEdit = Boolean(loaded?.board.canEdit);
  const name = loaded ? whiteboardDisplayName(loaded.board.name) : "Whiteboard";

  // ------------------------------------------------------------------ load
  useEffect(() => {
    mounted.current = true;
    let live = true;
    (async () => {
      try {
        const [{ whiteboard, scene }, pending] = await Promise.all([getWhiteboard(boardId), readPending(userId, boardId)]);
        if (!live) return;
        const safe = sceneForLoad(scene);
        if (!safe) throw new Error("This whiteboard could not be read");
        const action = whiteboard.canEdit ? pendingCopyAction(pending, whiteboard.revision) : "none";
        let initial = safe;
        if (action === "apply" && pending) {
          // Unsaved work from an earlier visit on top of this very revision: keep it and save it.
          initial = sceneForLoad(pending.scene) ?? safe;
          applyPendingRef.current = pending;
        } else if (action === "offer") {
          setOffer(pending);
        }
        dispatch({ type: "reset", revision: whiteboard.revision });
        // What Excalidraw reports for the loaded scene is not an edit; anything else is.
        lastKeyRef.current = changeKey(initial.elements, initialAppState(initial));
        lastThumbAt.current = whiteboard.hasThumbnail ? Date.now() : 0;
        thumbRevision.current = whiteboard.thumbRevision;
        setLoaded({ board: whiteboard, scene: initial });
        document.title = `${whiteboardDisplayName(whiteboard.name)} · Whiteboards · Nook`;
      } catch (reason) {
        if (!live) return;
        if (reason instanceof ApiError && reason.status === 404) onMissing();
        else setLoadError(messageOf(reason, "Could not open this whiteboard"));
      }
    })();
    return () => { live = false; mounted.current = false; };
    // Only when the board changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, userId]);

  // ------------------------------------------------------------------ saving
  const currentScene = useCallback(() => {
    const api = apiRef.current;
    if (!api) return null;
    return sceneForSave(api.getSceneElements() as never, api.getAppState() as unknown as Record<string, unknown>);
  }, []);

  const writePendingNow = useCallback(() => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    const result = currentScene();
    if (!result?.ok || !boardRef.current?.canEdit) return;
    void writePending(userId, boardId, { scene: result.scene, baseRevision: stateRef.current.baseRevision, savedAt: new Date().toISOString() });
  }, [boardId, currentScene, userId]);

  const refreshThumbnail = useCallback(async (revision: number, force = false) => {
    const api = apiRef.current;
    if (!api || !boardRef.current?.canEdit || thumbRevision.current === revision) return;
    if (!force && Date.now() - lastThumbAt.current < THUMBNAIL_INTERVAL_MS) return;
    lastThumbAt.current = Date.now();
    thumbRevision.current = revision;
    try {
      const elements = api.getSceneElements();
      const appState = { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false };
      let blob = await exportToBlob({ elements, appState, files: {}, maxWidthOrHeight: THUMBNAIL_MAX_SIDE, mimeType: "image/png" });
      if (blob.size > THUMBNAIL_MAX_BYTES) blob = await exportToBlob({ elements, appState, files: {}, maxWidthOrHeight: THUMBNAIL_MAX_SIDE / 2, mimeType: "image/png" });
      if (blob.size <= THUMBNAIL_MAX_BYTES) {
        await putWhiteboardThumbnail(boardId, revision, blob);
        announceThumbnail(boardId, revision);
      }
    } catch {
      // A thumbnail is a nicety; the list shows the placeholder instead.
    }
  }, [boardId]);

  const runSave = useCallback((): Promise<void> => {
    if (savingRef.current) return savingRef.current;
    const state = stateRef.current;
    if (!shouldSave(state) || !boardRef.current?.canEdit) return Promise.resolve();
    const result = currentScene();
    if (!result) return Promise.resolve();
    dispatch({ type: "saveStarted" });
    if (!result.ok) {
      dispatch({ type: "rejected", message: result.message });
      return Promise.resolve();
    }
    const savingVersion = state.editVersion;
    const promise = (async () => {
      try {
        const saved = await saveWhiteboardScene(boardId, state.baseRevision, result.scene);
        dispatch({ type: "saved", revision: saved.revision });
        if (stateRef.current.editVersion === savingVersion) void clearPending(userId, boardId);
        if (!saved.unchanged) void refreshThumbnail(saved.revision);
      } catch (reason) {
        const payload = codeOf(reason);
        if (payload?.code === "REVISION_CONFLICT") {
          dispatch({ type: "conflict", revision: payload.revision ?? state.baseRevision });
          writePendingNow();
          if (mounted.current) setLayer({ kind: "conflict" });
        } else if (reason instanceof ApiError && (reason.status === 400 || reason.status === 413 || reason.status === 404 || reason.status === 403)) {
          dispatch({ type: "rejected", message: reason.message });
          writePendingNow();
        } else {
          dispatch({ type: "failed" });
          writePendingNow();
        }
      } finally {
        savingRef.current = null;
      }
    })();
    savingRef.current = promise;
    return promise;
  }, [boardId, currentScene, refreshThumbnail, userId, writePendingNow]);

  // The debounce after an edit, and the retry backoff while offline.
  useEffect(() => {
    if (autosave.status !== "dirty" && autosave.status !== "offline") return;
    const timer = window.setTimeout(() => { void runSave(); }, autosave.status === "offline" ? autosave.retryMs : AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [autosave.status, autosave.editVersion, autosave.retryMs, runSave]);

  // A hidden tab saves at once (D194); leaving the canvas saves what is left and keeps the pending copy.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden" || !hasPendingWork(stateRef.current)) return;
      writePendingNow();
      void runSave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
      // Unmount (browser Back, or a link): save what is left. The request outlives the canvas.
      if (hasPendingWork(stateRef.current)) {
        writePendingNow();
        void runSave();
      } else if (stateRef.current.baseRevision > 1) {
        void refreshThumbnail(stateRef.current.baseRevision, true);
      }
    };
  }, [refreshThumbnail, runSave, writePendingNow]);

  /** Waits for the save to finish, at most three seconds; true when nothing is left unsaved. */
  const flush = useCallback(async () => {
    const deadline = Date.now() + LEAVE_FLUSH_MS;
    while (hasPendingWork(stateRef.current) && Date.now() < deadline) {
      if (stateRef.current.status === "conflict" || stateRef.current.status === "rejected") break;
      await Promise.race([savingRef.current ?? runSave(), new Promise((resolve) => window.setTimeout(resolve, 250))]);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return !hasPendingWork(stateRef.current);
  }, [runSave]);

  const leave = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    const clean = await flush();
    if (clean && stateRef.current.baseRevision > 1) await refreshThumbnail(stateRef.current.baseRevision, true);
    if (!clean) {
      writePendingNow();
      flash("Not saved yet. Your changes are kept on this device and saved when you open the whiteboard again.");
    }
    if (mounted.current) setLeaving(false);
    onBack();
  }, [flash, flush, leaving, onBack, writePendingNow]);

  // ------------------------------------------------------------------ Excalidraw
  const onChange = useCallback((elements: readonly unknown[], appState: AppState, _files: BinaryFiles) => {
    if (excalidrawLayerOpen(appState as never)) setExcalidrawLayer(true);
    const loose = elements as ReadonlyArray<Record<string, unknown>>;
    if (hasUnsupportedElements(loose)) {
      // Images arrive in Wave 24 (D198): a dropped or pasted image is removed before it is ever saved.
      apiRef.current?.updateScene({ elements: (elements as never[]).filter((element: { type?: string }) => element.type !== "image") as never });
      flash("Images are not supported on whiteboards yet");
      return;
    }
    const key = changeKey(loose, appState as unknown as Record<string, unknown>);
    if (applyPendingRef.current) {
      // A pending copy applied on open (D210) is unsaved work: save it.
      applyPendingRef.current = null;
      lastKeyRef.current = key;
      dispatch({ type: "edited" });
      return;
    }
    if (key === lastKeyRef.current || !boardRef.current?.canEdit || !apiRef.current) return;
    lastKeyRef.current = key;
    dispatch({ type: "edited" });
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(writePendingNow, PENDING_DEBOUNCE_MS);
  }, [flash, writePendingNow]);

  // D202: Back closes Excalidraw's own menus, dialogs, popups, and sidebar first. They are watched
  // in the DOM, since not all of them keep their open state in appState.
  const hasCanvas = loaded !== null;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const check = () => setExcalidrawLayer(Boolean(stage.querySelector(EXCALIDRAW_LAYER_SELECTOR)));
    const observer = new MutationObserver(check);
    observer.observe(stage, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  }, [hasCanvas]);
  useHistoryDialogGuard(excalidrawLayer && layer === null, () => {
    apiRef.current?.updateScene({ appState: closedExcalidrawLayers() as never });
    // Layers that keep their state elsewhere close on Escape, as they do from the keyboard.
    window.requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (!stage?.querySelector(EXCALIDRAW_LAYER_SELECTOR)) return;
      const target = stage.querySelector(".dropdown-menu, .Modal, .context-menu, .sidebar, .popover") ?? stage.querySelector(".excalidraw") ?? document;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    });
  });

  const onLinkOpen = useCallback((element: { link: string | null }, event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>) => {
    event.preventDefault();
    const target = element.link ? linkTarget(element.link) : null;
    if (!target) return;
    if (target.kind === "app") onOpenPath(target.path);
    else window.open(target.url, "_blank", "noopener,noreferrer");
  }, [onOpenPath]);

  // ------------------------------------------------------------------ export
  const exportPng = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const blob = await exportToBlob({ elements: api.getSceneElements(), appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false }, files: {}, mimeType: "image/png", exportPadding: 16 });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name}.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      flash("Could not export this whiteboard");
    }
  }, [flash, name]);

  // ------------------------------------------------------------------ conflict and pending copy
  const reloadLatest = useCallback(async () => {
    try {
      const { whiteboard, scene } = await getWhiteboard(boardId);
      const safe = sceneForLoad(scene);
      if (!safe) throw new Error("This whiteboard could not be read");
      lastKeyRef.current = changeKey(safe.elements, initialAppState(safe));
      apiRef.current?.updateScene({ elements: safe.elements as never, appState: { viewBackgroundColor: safe.appState.viewBackgroundColor ?? "#ffffff" } as never });
      apiRef.current?.history.clear();
      dispatch({ type: "reset", revision: whiteboard.revision });
      void clearPending(userId, boardId);
      setLoaded((current) => current ? { ...current, board: whiteboard } : current);
      setLayer(null);
      flash("Showing the latest version");
    } catch (reason) {
      flash(messageOf(reason, "Could not load the latest version"));
    }
  }, [boardId, flash, userId]);

  /** Saves a scene as a new board next to this one and opens it (the conflict's and the offer's way out). */
  const saveAsCopy = useCallback(async (scene: CanonicalScene) => {
    const board = boardRef.current;
    if (!board) return;
    try {
      const { whiteboard } = await createWhiteboard(`${whiteboardDisplayName(board.name)} (copy)`, board.folder_id);
      await saveWhiteboardScene(whiteboard.id, whiteboard.revision, scene);
      void clearPending(userId, boardId);
      // This board keeps its server state; the copy holds the local work.
      dispatch({ type: "reset", revision: stateRef.current.serverRevision ?? stateRef.current.baseRevision });
      setLayer(null);
      setOffer(null);
      flash("Saved your version as a copy");
      onOpenBoard(whiteboard.id);
    } catch (reason) {
      flash(messageOf(reason, "Could not save a copy"));
    }
  }, [boardId, flash, onOpenBoard, userId]);

  const copyLocal = useCallback(() => {
    const result = currentScene();
    if (result?.ok) void saveAsCopy(result.scene);
  }, [currentScene, saveAsCopy]);

  useHistoryDialogGuard(layer?.kind === "conflict" || layer?.kind === "discard", () => setLayer(layer?.kind === "discard" ? { kind: "conflict" } : null));

  // ------------------------------------------------------------------ render
  if (loadError) {
    return <div className="whiteboard-canvas-page whiteboard-loading" role="alert">
      <TriangleAlert aria-hidden="true" />
      <p>{loadError}</p>
      <button className="secondary-button" onClick={onBack}>Back to whiteboards</button>
    </div>;
  }
  if (!loaded) {
    return <div className="whiteboard-canvas-page whiteboard-loading" role="status"><LoaderCircle aria-hidden="true" /><p>Opening the whiteboard…</p></div>;
  }

  const { board, scene } = loaded;
  const status = autosave.status;
  const StatusIcon = status === "offline" || status === "rejected" || status === "conflict" ? CloudOff : status === "saving" ? LoaderCircle : Cloud;
  const boardDialog = layer?.kind === "board" ? layer.dialog : null;

  return <div className="whiteboard-canvas-page" data-status={status}>
    <header className="whiteboard-bar">
      <button className="icon-button whiteboard-back" onClick={() => { void leave(); }} disabled={leaving} aria-label="Back to whiteboards" title="Back"><ChevronLeft /></button>
      {canEdit
        ? <button className="whiteboard-title" onClick={() => setLayer({ kind: "board", dialog: { kind: "rename", board } })} title={`Rename ${name}`}><h1>{name}</h1></button>
        : <h1 className="whiteboard-title">{name}</h1>}
      {canEdit && (status === "conflict"
        ? <button className={`whiteboard-status status-${status}`} onClick={() => setLayer({ kind: "conflict" })} aria-label="Conflict: choose which version to keep"><StatusIcon aria-hidden="true" /><span>{autosaveLabel(autosave)}</span></button>
        : <span className={`whiteboard-status status-${status}`} role="status" aria-live="polite"><StatusIcon aria-hidden="true" /><span>{leaving ? "Saving…" : autosaveLabel(autosave)}</span></span>)}
      <div className="whiteboard-bar-actions">
        {canEdit && <button className="secondary-button whiteboard-bar-button desktop-only" onClick={() => setLayer({ kind: "board", dialog: { kind: "share", board } })}><Share2 />Share</button>}
        <button className="secondary-button whiteboard-bar-button desktop-only" onClick={() => { void exportPng(); }}><ImageDown />Export PNG</button>
        <button className="icon-button whiteboard-menu" onClick={() => setLayer({ kind: "board", dialog: { kind: "actions", board } })} aria-haspopup="dialog" aria-label={`Actions for ${name}`}><Ellipsis /></button>
      </div>
    </header>
    {!canEdit && <p className="whiteboard-banner" role="note"><strong>View only</strong> · Owned by {board.owner_name}</p>}
    {status === "rejected" && <p className="whiteboard-banner warn" role="alert">Not saved: {autosave.message}. Your changes are kept on this device.</p>}
    {offer && <div className="whiteboard-banner warn" role="alert">
      <span>You have unsaved changes from an earlier visit, made before this whiteboard last changed.</span>
      <button className="secondary-button" onClick={() => { void saveAsCopy(offer.scene); }}>Restore as a copy</button>
      <button className="secondary-button" onClick={() => { setOffer(null); void clearPending(userId, boardId); }}>Discard</button>
    </div>}
    <div className="whiteboard-stage" ref={stageRef}>
      <Excalidraw
        excalidrawAPI={(api) => { apiRef.current = api; }}
        initialData={{ elements: scene.elements as never, appState: initialAppState(scene), scrollToContent: true }}
        onChange={onChange}
        onLinkOpen={onLinkOpen as never}
        onPaste={(data) => !Object.keys(data.files ?? {}).length}
        theme="dark"
        langCode="en"
        name={name}
        viewModeEnabled={!canEdit}
        validateEmbeddable={false}
        renderTopRightUI={() => null}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: canEdit, toggleTheme: false, changeViewBackgroundColor: canEdit }, tools: { image: false } }}
      />
    </div>

    <BoardDialogs dialog={boardDialog} folders={folders} flash={flash}
      onClose={() => setLayer(null)}
      onExportPng={() => { void exportPng(); }}
      onChanged={(patch) => setLoaded((current) => current ? { ...current, board: { ...current.board, ...patch } } : current)}
      onDeleted={() => { void clearPending(userId, boardId); dispatch({ type: "reset", revision: stateRef.current.baseRevision }); onDeleted(); }}
      onAction={(action, target) => setLayer({ kind: "board", dialog: { kind: action, board: target } })} />
    {layer?.kind === "conflict" && <ModalDialog title="This whiteboard changed on another device" onClose={() => setLayer(null)}>
      <p className="file-dialog-copy">Someone saved a newer version of this whiteboard, from another tab or device. Your changes here are kept on this device until you choose.</p>
      <footer className="file-dialog-actions whiteboard-conflict-actions">
        <button className="secondary-button" onClick={() => setLayer({ kind: "discard" })}>Reload latest</button>
        <button className="primary-button" onClick={copyLocal} autoFocus>Save mine as a copy</button>
      </footer>
    </ModalDialog>}
    {layer?.kind === "discard" && <ConfirmDialog title="Discard your changes?" message="Reloading shows the latest saved version. The changes you made here since then are discarded." confirmLabel="Discard and reload" danger onCancel={() => setLayer({ kind: "conflict" })} onConfirm={() => { void reloadLatest(); }} />}
  </div>;
}
