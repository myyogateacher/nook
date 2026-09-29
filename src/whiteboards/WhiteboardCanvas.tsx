import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ChevronLeft, Cloud, CloudOff, Ellipsis, ImageDown, LoaderCircle, Share2, TriangleAlert } from "lucide-react";
import { Excalidraw, exportToBlob, MainMenu } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { api, ApiError } from "../api";
import { ConfirmDialog, ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { Folder } from "../types";
import { canonicalSceneJson, whiteboardDisplayName, type CanonicalScene } from "../../shared/whiteboardScene";
import {
  autosaveLabel, autosaveReducer, hasPendingWork, initialAutosave, LEAVE_FLUSH_MS, leaveFlushAllowed, mayWritePending, nextSaveDelay,
  pendingCopyAction, PENDING_WRITE_MS, shouldSave, THUMBNAIL_IDLE_MS
} from "./autosave";
import { BoardDialogs, type BoardDialog } from "./BoardDialogs";
import { changeKey, closedExcalidrawLayers, EXCALIDRAW_LAYER_SELECTOR, excalidrawLayerOpen, hasUnsupportedElements, IMAGES_REFUSED_MESSAGE, isKeptElement, linkTarget, sceneForLoad, sceneForSave } from "./historyGuard";
import { clearPending, readPending, writePending, type PendingEntry } from "./pendingStore";
import { announceThumbnail, createWhiteboard, getWhiteboard, putWhiteboardThumbnail, restorePreviousVersion, saveWhiteboardScene, type WhiteboardSummary } from "./whiteboardsApi";

/**
 * One board's canvas (whiteboard plan §10.3, D194, D202, D210): Excalidraw under Nook's 44 px header
 * with Back, the name, the save status, and the board menu. Only the owner edits; everyone else gets
 * Excalidraw's view mode (D195). Autosave writes 1.5 s after the last edit (at the latest 5 s after the
 * oldest unsaved one), on leave, and when the tab is hidden, with the revision CAS; a pending copy in
 * IndexedDB (written within 0.5 s of an edit) covers a crash or an offline moment. Excalidraw's menus
 * and dialogs, and Nook's sheets, close on Back first; undo never touches history.
 *
 * QA D1–D3 (data loss): every save, pending copy, and thumbnail comes from the last scene captured
 * from a real `onChange` while the editor was mounted and loaded (`sceneRef`), never from the editor's
 * API, which reports an empty scene once it is unmounting. Teardown flushes that captured scene first
 * and then stops everything: after it, nothing is captured, written, or sent.
 */

type Props = {
  boardId: string;
  userId: string;
  folders: Folder[];
  flash: (message: string) => void;
  onBack: () => void;
  onOpenPath: (path: string) => void;
  onOpenBoard: (id: string) => void;
  /** The board is gone or no longer readable (QA Q9): the host says so and shows the list. */
  onAccessLost: () => void;
  onDeleted: () => void;
};

type Loaded = { board: WhiteboardSummary; scene: CanonicalScene };
type Layer = { kind: "board"; dialog: BoardDialog } | { kind: "conflict" } | { kind: "discard" } | { kind: "restore" };
type Captured = { elements: ReadonlyArray<Record<string, unknown>>; appState: Record<string, unknown>; live: number };

const THUMBNAIL_MAX_SIDE = 640;
const THUMBNAIL_MAX_BYTES = 128 * 1024;
const THUMBNAIL_MIN_INTERVAL_MS = 5000;
const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
/** The appState a scene opens with (and that the first change key is computed from). */
const initialAppState = (scene: CanonicalScene) => ({ viewBackgroundColor: scene.appState.viewBackgroundColor ?? "#ffffff", gridSize: scene.appState.gridSize ?? 20, gridModeEnabled: scene.appState.gridModeEnabled ?? false });
const keptAppState = (appState: Record<string, unknown>) => ({ viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.gridSize, gridStep: appState.gridStep, gridModeEnabled: appState.gridModeEnabled });
const liveCount = (elements: ReadonlyArray<Record<string, unknown>>) => elements.reduce((count, element) => element.isDeleted === true ? count : count + 1, 0);
const codeOf = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string; revision?: number }) : null;
const lostAccess = (reason: unknown) => reason instanceof ApiError && (reason.status === 404 || reason.status === 403) && codeOf(reason)?.code !== "ROLE_READ_ONLY";

/** A plain white PNG for an empty board, so a cleared board never keeps its old picture (QA Q3). */
function emptyBoardPng(background: string): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = /^#[0-9a-fA-F]{3,8}$/.test(background) ? background : "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

export default function WhiteboardCanvas({ boardId, userId, folders, flash, onBack, onOpenPath, onOpenBoard, onAccessLost, onDeleted }: Props) {
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
  /** The last scene a real onChange reported while mounted and loaded: the only source of saves. */
  const sceneRef = useRef<Captured | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  /** Live elements of the loaded scene; the editor is ready once it reports at least that many. */
  const loadedLiveRef = useRef(0);
  const readyRef = useRef(false);
  /** Set when unmounting starts: from then on nothing is captured, written, or sent. */
  const tearingDownRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const pendingTimer = useRef<number | null>(null);
  const thumbTimer = useRef<number | null>(null);
  const lastThumbAt = useRef(0);
  /** The revision the newest thumbnail shows (D200, QA Q3). */
  const thumbRevision = useRef<number | null>(null);
  const mounted = useRef(true);
  const applyPendingRef = useRef<PendingEntry | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const accessLostRef = useRef(false);

  const canEdit = Boolean(loaded?.board.canEdit);
  const name = loaded ? whiteboardDisplayName(loaded.board.name) : "Whiteboard";

  const loseAccess = useCallback(() => {
    if (accessLostRef.current || tearingDownRef.current) return;
    accessLostRef.current = true;
    onAccessLost();
  }, [onAccessLost]);

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
        const pendingScene = pending ? sceneForLoad(pending.scene) : null;
        const action = whiteboard.canEdit && pending && pendingScene
          ? pendingCopyAction({ baseRevision: pending.baseRevision, live: pendingScene.elements.length, content: canonicalSceneJson(pendingScene) }, { revision: whiteboard.revision, live: safe.elements.length, content: canonicalSceneJson(safe) })
          : pending ? "discard" : "none";
        let initial = safe;
        if (action === "apply" && pending && pendingScene) {
          // Unsaved work from an earlier visit on top of this very revision: keep it and save it.
          initial = pendingScene;
          applyPendingRef.current = pending;
        } else if (action === "offer" && pending) {
          setOffer(pending);
        } else if (action === "discard") {
          void clearPending(userId, boardId);
        }
        dispatch({ type: "reset", revision: whiteboard.revision, live: safe.elements.length });
        // What Excalidraw reports for the loaded scene is not an edit; anything else is.
        lastKeyRef.current = changeKey(initial.elements, initialAppState(initial));
        sceneRef.current = { elements: initial.elements, appState: initialAppState(initial), live: initial.elements.length };
        loadedLiveRef.current = initial.elements.length;
        readyRef.current = false;
        lastThumbAt.current = 0;
        thumbRevision.current = whiteboard.thumbRevision;
        setLoaded({ board: whiteboard, scene: initial });
        document.title = `${whiteboardDisplayName(whiteboard.name)} · Whiteboards · Nook`;
      } catch (reason) {
        if (!live) return;
        if (reason instanceof ApiError && reason.status === 404) loseAccess();
        else setLoadError(messageOf(reason, "Could not open this whiteboard"));
      }
    })();
    return () => { live = false; mounted.current = false; };
    // Only when the board changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, userId]);

  // ------------------------------------------------------------------ saving
  /** The captured scene, validated for a save; never read from the editor itself. */
  const currentScene = useCallback(() => {
    const captured = sceneRef.current;
    if (!captured) return null;
    return sceneForSave(captured.elements as never, captured.appState);
  }, []);

  const writePendingNow = useCallback(() => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    if (tearingDownRef.current || !boardRef.current?.canEdit || !mayWritePending(stateRef.current)) return;
    const result = currentScene();
    if (!result?.ok) return;
    // An empty copy over a board that has elements is never kept (QA D2): clearing is saved while open.
    if (result.stats.elementCount === 0 && stateRef.current.savedLive > 0) return;
    void writePending(userId, boardId, { scene: result.scene, baseRevision: stateRef.current.baseRevision, savedAt: new Date().toISOString(), live: result.stats.elementCount });
  }, [boardId, currentScene, userId]);

  /** Throttled, not debounced (QA D4): the copy is written within 0.5 s of an edit while edits keep coming. */
  const schedulePendingWrite = useCallback(() => {
    if (pendingTimer.current !== null) return;
    pendingTimer.current = window.setTimeout(() => { pendingTimer.current = null; writePendingNow(); }, PENDING_WRITE_MS);
  }, [writePendingNow]);

  const uploadThumbnail = useCallback(async (revision: number, captured: Captured) => {
    try {
      let blob: Blob | null;
      if (captured.live === 0) blob = await emptyBoardPng(String(captured.appState.viewBackgroundColor ?? "#ffffff"));
      else {
        const elements = captured.elements.filter((element) => element.isDeleted !== true && isKeptElement(element)) as never;
        const appState = { ...captured.appState, exportBackground: true, exportWithDarkMode: false };
        // The whole drawing, with padding, fitted into the longest side (QA Q3).
        const first = await exportToBlob({ elements, appState, files: {}, maxWidthOrHeight: THUMBNAIL_MAX_SIDE, mimeType: "image/png", exportPadding: 24 });
        blob = first.size <= THUMBNAIL_MAX_BYTES ? first : await exportToBlob({ elements, appState, files: {}, maxWidthOrHeight: THUMBNAIL_MAX_SIDE / 2, mimeType: "image/png", exportPadding: 16 });
      }
      if (blob && blob.size <= THUMBNAIL_MAX_BYTES) {
        await putWhiteboardThumbnail(boardId, revision, blob);
        announceThumbnail(boardId, revision);
      }
    } catch (reason) {
      if (lostAccess(reason)) loseAccess();
      // Otherwise a thumbnail is a nicety; the list shows the older one or a placeholder.
    }
  }, [boardId, loseAccess]);

  /** A thumbnail of `revision` from the captured scene, at most every 5 s (the server allows 30 a minute). */
  const refreshThumbnail = useCallback((revision: number) => {
    const captured = sceneRef.current;
    if (!captured || !boardRef.current?.canEdit || thumbRevision.current === revision) return;
    if (Date.now() - lastThumbAt.current < THUMBNAIL_MIN_INTERVAL_MS) return;
    lastThumbAt.current = Date.now();
    thumbRevision.current = revision;
    void uploadThumbnail(revision, captured);
  }, [uploadThumbnail]);

  /** After a save, once the board has been idle for 3 s (QA Q3). */
  const scheduleThumbnail = useCallback((revision: number) => {
    if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current);
    thumbTimer.current = window.setTimeout(() => {
      thumbTimer.current = null;
      if (!tearingDownRef.current && stateRef.current.status === "idle" && stateRef.current.baseRevision === revision) refreshThumbnail(revision);
    }, THUMBNAIL_IDLE_MS);
  }, [refreshThumbnail]);

  const runSave = useCallback((options: { leaving?: boolean } = {}): Promise<void> => {
    if (savingRef.current) return savingRef.current;
    const state = stateRef.current;
    if (!shouldSave(state) || !boardRef.current?.canEdit) return Promise.resolve();
    if (tearingDownRef.current && !options.leaving) return Promise.resolve();
    const result = currentScene();
    if (!result) return Promise.resolve();
    // Never an empty scene from a leave flush over a board that had elements (QA D1–D3).
    if (options.leaving && result.ok && !leaveFlushAllowed(state, result.stats.elementCount)) return Promise.resolve();
    dispatch({ type: "saveStarted" });
    if (!result.ok) {
      dispatch({ type: "rejected", message: result.message });
      return Promise.resolve();
    }
    const savingVersion = state.editVersion;
    const live = result.stats.elementCount;
    const promise = (async () => {
      try {
        const saved = await saveWhiteboardScene(boardId, state.baseRevision, result.scene);
        dispatch({ type: "saved", revision: saved.revision, at: Date.now(), live });
        if (stateRef.current.editVersion === savingVersion) void clearPending(userId, boardId);
        if (saved.snapshotKept) setLoaded((current) => current ? { ...current, board: { ...current.board, snapshotCount: current.board.snapshotCount + 1, snapshotAt: saved.savedAt } } : current);
        if (!saved.unchanged && !tearingDownRef.current) scheduleThumbnail(saved.revision);
      } catch (reason) {
        const payload = codeOf(reason);
        if (payload?.code === "REVISION_CONFLICT") {
          dispatch({ type: "conflict", revision: payload.revision ?? state.baseRevision });
          writePendingNow();
          if (mounted.current && !tearingDownRef.current) setLayer({ kind: "conflict" });
        } else if (reason instanceof ApiError && reason.status === 429) {
          // Too many saves this minute (review L11): wait as the server says, keep the pending copy.
          const retryAfter = typeof (reason.payload as { retryAfter?: unknown } | null)?.retryAfter === "number" ? (reason.payload as { retryAfter: number }).retryAfter : 30;
          dispatch({ type: "failed", retryAfterMs: retryAfter * 1000, message: "Saving paused for a moment, kept on this device" });
          writePendingNow();
        } else if (lostAccess(reason)) {
          dispatch({ type: "rejected", message: "You no longer have access to this whiteboard" });
          loseAccess();
        } else if (reason instanceof ApiError && (reason.status === 400 || reason.status === 413 || reason.status === 403)) {
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
  }, [boardId, currentScene, loseAccess, scheduleThumbnail, userId, writePendingNow]);

  // The timer after an edit (1.5 s after the last, 5 s after the oldest), and the retry backoff.
  useEffect(() => {
    const delay = nextSaveDelay(autosave, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(() => { void runSave(); }, delay);
    return () => window.clearTimeout(timer);
  }, [autosave, runSave]);

  // A hidden tab saves at once (D194).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden" || !hasPendingWork(stateRef.current) || tearingDownRef.current) return;
      writePendingNow();
      void runSave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
    };
  }, [runSave, writePendingNow]);

  // QA Q9: when the tab comes back, a light check that the board is still readable.
  useEffect(() => {
    const onFocus = () => {
      if (tearingDownRef.current || document.visibilityState === "hidden") return;
      api(`/files/${encodeURIComponent(boardId)}`).catch((reason) => { if (lostAccess(reason)) loseAccess(); });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [boardId, loseAccess]);

  // Teardown (browser Back, a link, the app's own Back): flush the captured scene FIRST, while the
  // editor is still mounted (layout cleanups run before the editor's own unmount), then stop
  // everything. The request outlives the canvas.
  const teardownRef = useRef(() => undefined as void);
  teardownRef.current = () => {
    if (hasPendingWork(stateRef.current)) {
      writePendingNow();
      void runSave({ leaving: true });
    } else if (stateRef.current.baseRevision > 1 && thumbRevision.current !== stateRef.current.baseRevision && sceneRef.current && boardRef.current?.canEdit) {
      // Leaving a board whose thumbnail is older than its last save (QA Q3), without delaying navigation.
      thumbRevision.current = stateRef.current.baseRevision;
      void uploadThumbnail(stateRef.current.baseRevision, sceneRef.current);
    }
    tearingDownRef.current = true;
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current);
    pendingTimer.current = null;
    thumbTimer.current = null;
  };
  useLayoutEffect(() => () => teardownRef.current(), []);

  /** Waits for the save to finish, at most three seconds; true when nothing is left unsaved. */
  const flush = useCallback(async () => {
    const deadline = Date.now() + LEAVE_FLUSH_MS;
    // At most two save attempts: offline, a failed request returns at once, and retrying in a
    // loop would flood the network; the pending copy keeps the work instead.
    let attempts = 0;
    while (hasPendingWork(stateRef.current) && Date.now() < deadline) {
      if (stateRef.current.status === "conflict" || stateRef.current.status === "rejected") break;
      const remaining = new Promise((resolve) => window.setTimeout(resolve, Math.max(0, deadline - Date.now())));
      if (savingRef.current) {
        await Promise.race([savingRef.current, remaining]);
        continue;
      }
      if (attempts >= 2) break;
      attempts += 1;
      await Promise.race([runSave({ leaving: true }), remaining]);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return !hasPendingWork(stateRef.current);
  }, [runSave]);

  const leave = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    const clean = await flush();
    if (!clean) {
      writePendingNow();
      flash("Not saved yet. Your changes are kept on this device and saved when you open the whiteboard again.");
    }
    if (mounted.current) setLeaving(false);
    onBack();
  }, [flash, flush, leaving, onBack, writePendingNow]);

  // ------------------------------------------------------------------ Excalidraw
  const onChange = useCallback((elements: readonly unknown[], appState: AppState, _files: BinaryFiles) => {
    // Nothing counts before the loaded scene is in the editor, or once unmounting has begun.
    if (tearingDownRef.current || !sceneRef.current || !apiRef.current) return;
    if (excalidrawLayerOpen(appState as never)) setExcalidrawLayer(true);
    const state = appState as unknown as Record<string, unknown>;
    // QA Q5: a refused image (paste, drop, or a Mermaid diagram Excalidraw renders as an image) gets
    // one friendly message instead of Excalidraw's error dialog.
    if (typeof state.errorMessage === "string" && /image/i.test(state.errorMessage)) {
      apiRef.current.updateScene({ appState: { errorMessage: null } as never });
      flash(IMAGES_REFUSED_MESSAGE);
      return;
    }
    const loose = elements as ReadonlyArray<Record<string, unknown>>;
    if (hasUnsupportedElements(loose)) {
      // Images arrive in Wave 24 (D198); embeds and AI frames never (D199). Anything outside the
      // supported types is removed before it is ever saved (review L2).
      apiRef.current.updateScene({ elements: (elements as never[]).filter((element) => isKeptElement(element as Record<string, unknown>)) as never });
      flash(IMAGES_REFUSED_MESSAGE);
      return;
    }
    // Review L5: the shape library (and its "Browse libraries" link to a third-party site) is not
    // offered; the sidebar opens only on its search tab.
    const sidebar = (appState as { openSidebar?: { name?: string; tab?: string } | null }).openSidebar;
    if (sidebar && sidebar.tab !== "search") {
      apiRef.current.updateScene({ appState: { openSidebar: sidebar.name ? { name: sidebar.name, tab: "search" } : null } as never });
      return;
    }
    const live = liveCount(loose);
    const key = changeKey(loose, state);
    if (!readyRef.current) {
      // Until the editor reports the loaded scene, its changes are its own start-up, not edits.
      if (live < loadedLiveRef.current) return;
      readyRef.current = true;
      if (applyPendingRef.current) {
        // A pending copy applied on open (D210) is unsaved work: save it.
        applyPendingRef.current = null;
        lastKeyRef.current = key;
        sceneRef.current = { elements: loose.slice(), appState: keptAppState(state), live };
        dispatch({ type: "edited", at: Date.now() });
        schedulePendingWrite();
        return;
      }
      if (live === loadedLiveRef.current) {
        lastKeyRef.current = key;
        sceneRef.current = { elements: loose.slice(), appState: keptAppState(state), live };
        return;
      }
    }
    if (key === lastKeyRef.current || !boardRef.current?.canEdit) return;
    lastKeyRef.current = key;
    sceneRef.current = { elements: loose.slice(), appState: keptAppState(state), live };
    dispatch({ type: "edited", at: Date.now() });
    schedulePendingWrite();
    if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current);
  }, [flash, schedulePendingWrite]);

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
    // The guard is spent: mark the layer closed so the next overlay arms a fresh guard (the DOM
    // watcher sets it again if anything is still open).
    setExcalidrawLayer(false);
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
    const captured = sceneRef.current;
    if (!captured) return;
    try {
      const elements = captured.elements.filter((element) => element.isDeleted !== true && isKeptElement(element)) as never;
      const blob = await exportToBlob({ elements, appState: { ...captured.appState, exportBackground: true, exportWithDarkMode: false }, files: {}, mimeType: "image/png", exportPadding: 16 });
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

  // ------------------------------------------------------------------ conflict, pending copy, restore
  const showServerScene = useCallback(async (message: string) => {
    const { whiteboard, scene } = await getWhiteboard(boardId);
    const safe = sceneForLoad(scene);
    if (!safe) throw new Error("This whiteboard could not be read");
    lastKeyRef.current = changeKey(safe.elements, initialAppState(safe));
    sceneRef.current = { elements: safe.elements, appState: initialAppState(safe), live: safe.elements.length };
    apiRef.current?.updateScene({ elements: safe.elements as never, appState: { viewBackgroundColor: safe.appState.viewBackgroundColor ?? "#ffffff" } as never });
    apiRef.current?.history.clear();
    dispatch({ type: "reset", revision: whiteboard.revision, live: safe.elements.length });
    void clearPending(userId, boardId);
    setLoaded((current) => current ? { ...current, board: whiteboard } : current);
    setLayer(null);
    flash(message);
    scheduleThumbnail(whiteboard.revision);
  }, [boardId, flash, scheduleThumbnail, userId]);

  const reloadLatest = useCallback(async () => {
    try {
      await showServerScene("Showing the latest version");
    } catch (reason) {
      if (lostAccess(reason)) loseAccess();
      else flash(messageOf(reason, "Could not load the latest version"));
    }
  }, [flash, loseAccess, showServerScene]);

  const restorePrevious = useCallback(async () => {
    try {
      await restorePreviousVersion(boardId, stateRef.current.baseRevision);
      await showServerScene("Restored the previous version");
    } catch (reason) {
      const payload = codeOf(reason);
      if (payload?.code === "REVISION_CONFLICT") {
        dispatch({ type: "conflict", revision: payload.revision ?? stateRef.current.baseRevision });
        setLayer({ kind: "conflict" });
      } else if (lostAccess(reason) && payload?.code !== "NO_SNAPSHOT") loseAccess();
      else {
        setLayer(null);
        flash(messageOf(reason, "Could not restore the previous version"));
      }
    }
  }, [boardId, flash, loseAccess, showServerScene]);

  /** Saves a scene as a new board next to this one and opens it (the conflict's and the offer's way out). */
  const saveAsCopy = useCallback(async (scene: CanonicalScene) => {
    const board = boardRef.current;
    if (!board) return;
    try {
      const { whiteboard } = await createWhiteboard(`${whiteboardDisplayName(board.name)} (copy)`, board.folder_id);
      const saved = await saveWhiteboardScene(whiteboard.id, whiteboard.revision, scene);
      // The copy gets its thumbnail right away (QA Q3); nothing else would draw it until it is opened.
      void (async () => {
        try {
          const elements = scene.elements as never[];
          const blob = elements.length === 0
            ? await emptyBoardPng(scene.appState.viewBackgroundColor ?? "#ffffff")
            : await exportToBlob({ elements, appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false }, files: {}, maxWidthOrHeight: THUMBNAIL_MAX_SIDE, mimeType: "image/png", exportPadding: 24 });
          if (blob && blob.size <= THUMBNAIL_MAX_BYTES) await putWhiteboardThumbnail(whiteboard.id, saved.revision, blob);
        } catch {
          // The copy shows a placeholder until it is opened.
        }
      })();
      void clearPending(userId, boardId);
      // This board keeps its server state; the copy holds the local work.
      dispatch({ type: "reset", revision: stateRef.current.serverRevision ?? stateRef.current.baseRevision, live: stateRef.current.savedLive });
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

  useHistoryDialogGuard(layer?.kind === "conflict" || layer?.kind === "discard" || layer?.kind === "restore", () => setLayer(layer?.kind === "discard" ? { kind: "conflict" } : null));

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
  const snapshotTime = board.snapshotAt ? new Date(board.snapshotAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;

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
      <span>You have unsaved changes from an earlier visit that differ from this whiteboard as it is saved now.</span>
      <button className="secondary-button" onClick={() => { void saveAsCopy(offer.scene); }}>Restore as a copy</button>
      <button className="secondary-button" onClick={() => { setOffer(null); void clearPending(userId, boardId); }}>Discard</button>
    </div>}
    <div className="whiteboard-stage" ref={stageRef}>
      <Excalidraw
        excalidrawAPI={(instance) => { apiRef.current = instance; }}
        initialData={{ elements: scene.elements as never, appState: initialAppState(scene), scrollToContent: true }}
        onChange={onChange}
        onLinkOpen={onLinkOpen as never}
        onPaste={(data) => {
          if (!Object.keys(data.files ?? {}).length) return true;
          flash(IMAGES_REFUSED_MESSAGE);
          return false;
        }}
        theme="dark"
        langCode="en"
        name={name}
        viewModeEnabled={!canEdit}
        validateEmbeddable={false}
        renderTopRightUI={() => null}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: canEdit, toggleTheme: false, changeViewBackgroundColor: canEdit }, tools: { image: false } }}
      >
        {/* Nook's own main menu: no social links or promotions, only what works here. */}
        <MainMenu>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {canEdit && <MainMenu.DefaultItems.ClearCanvas />}
          {canEdit && <MainMenu.DefaultItems.ChangeCanvasBackground />}
        </MainMenu>
      </Excalidraw>
    </div>

    <BoardDialogs dialog={boardDialog} folders={folders} flash={flash}
      onClose={() => setLayer(null)}
      onExportPng={() => { void exportPng(); }}
      onRestorePrevious={() => setLayer({ kind: "restore" })}
      onChanged={(patch) => setLoaded((current) => current ? { ...current, board: { ...current.board, ...patch } } : current)}
      onDeleted={() => { void clearPending(userId, boardId); dispatch({ type: "reset", revision: stateRef.current.baseRevision, live: stateRef.current.savedLive }); onDeleted(); }}
      onAction={(action, target) => setLayer({ kind: "board", dialog: { kind: action, board: target } })} />
    {layer?.kind === "conflict" && <ModalDialog title="This whiteboard changed on another device" onClose={() => setLayer(null)}>
      <p className="file-dialog-copy">Someone saved a newer version of this whiteboard, from another tab or device. Your changes here are kept on this device until you choose.</p>
      <footer className="file-dialog-actions whiteboard-conflict-actions">
        <button className="secondary-button" onClick={() => setLayer({ kind: "discard" })}>Reload latest</button>
        <button className="primary-button" onClick={copyLocal} autoFocus>Save mine as a copy</button>
      </footer>
    </ModalDialog>}
    {layer?.kind === "discard" && <ConfirmDialog title="Discard your changes?" message="Reloading shows the latest saved version. The changes you made here since then are discarded." confirmLabel="Discard and reload" danger onCancel={() => setLayer({ kind: "conflict" })} onConfirm={() => { void reloadLatest(); }} />}
    {layer?.kind === "restore" && <ConfirmDialog title="Restore the previous version?" message={`This saves the version kept${snapshotTime ? ` on ${snapshotTime}` : ""}, before most of this whiteboard was removed, as the newest version. What is on the board now is kept too, so you can switch back the same way.`} confirmLabel="Restore" onCancel={() => setLayer(null)} onConfirm={() => { void restorePrevious(); }} />}
  </div>;
}
