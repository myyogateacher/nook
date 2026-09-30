import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ChevronLeft, Cloud, CloudOff, Copy, Ellipsis, ImageDown, ImagePlus, Link as LinkIcon, LoaderCircle, Share2, TriangleAlert } from "lucide-react";
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, exportToBlob, exportToSvg, MainMenu, newElementWith, restoreElements, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { api, ApiError } from "../api";
import { ConfirmDialog, ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { whenHistorySettled } from "../historyDialogs";
import type { Folder } from "../types";
import { canonicalSceneJson, sceneWithoutImages, whiteboardDisplayName, type CanonicalScene, type SceneFile } from "../../shared/whiteboardScene";
import { isInsertableImageType, uploadImageDocument } from "../editor/imageUpload";
import { useRole } from "../team/roleAccess";
import type { DocumentSummary } from "../types";
import {
  autosaveLabel, autosaveReducer, hasPendingWork, initialAutosave, LEAVE_FLUSH_MS, mayCaptureEdit, maySendCapture, nextSaveDelay,
  pendingCopyAction, PENDING_WRITE_MS, shouldSave, THUMBNAIL_IDLE_MS, type CaptureOrigin
} from "./autosave";
import { BoardDialogs, type BoardDialog } from "./BoardDialogs";
import { changeKey, closedExcalidrawLayers, hasUnsupportedElements, IMAGES_REFUSED_MESSAGE, isDocumentId, isKeptElement, keptLink, linkTarget, openExcalidrawLayer, refusedLinks, restoreMessage, sceneForLoad, sceneForSave } from "./historyGuard";
import { IMAGE_PLACE_MAX_SIDE, loadNookImage, placedSize } from "./boardImages";
import { HistorySheet } from "./HistorySheet";
import { ImagePickerSheet, LinkPickerSheet } from "./NookPickers";
import { markBoardOpen } from "./pendingSync";
import { onBeforeChunkReload } from "../chunkReload";
import { clearPending, readPending, writePending, type PendingEntry } from "./pendingStore";
import {
  announceThumbnail, createWhiteboard, duplicateWhiteboard, getWhiteboard, putWhiteboardThumbnail, restoreSnapshot, saveWhiteboardScene, whiteboardLink,
  type WhiteboardSnapshot, type WhiteboardSummary
} from "./whiteboardsApi";
import { Avatar } from "../ui/Avatar";

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
 *
 * QA E1: each captured scene carries its provenance (`origin`). Only an `edit` capture is saved or
 * kept as the pending copy, whatever it holds: a board the person emptied (Reset the canvas, select
 * all and Delete) is saved by the timer, the maximum wait, and the leave flush like any other edit.
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
type Layer =
  | { kind: "board"; dialog: BoardDialog } | { kind: "conflict" } | { kind: "discard" }
  /** Wave 24: Nook's image picker (D198), the link picker (D199), History (D207), a version's restore confirm, and the external-link confirm. */
  | { kind: "image" } | { kind: "link" } | { kind: "history" } | { kind: "restoreVersion"; snapshot: WhiteboardSnapshot } | { kind: "external"; url: string };
type Captured = { elements: ReadonlyArray<Record<string, unknown>>; appState: Record<string, unknown>; live: number; origin: CaptureOrigin };

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
const formatTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Where the person was looking (Wave 24, D199): kept on this device for half an hour after leaving,
 * so Back from a Nook item a shape links to returns to the same part of the board.
 */
type Viewport = { scrollX: number; scrollY: number; zoom: number };
const VIEWPORT_TTL_MS = 30 * 60_000;
const viewportKey = (userId: string, boardId: string) => `nook.whiteboard.view.${userId}.${boardId}`;
function readViewport(userId: string, boardId: string): Viewport | null {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(viewportKey(userId, boardId)) ?? "null") as (Viewport & { at: number }) | null;
    if (!raw || Date.now() - raw.at > VIEWPORT_TTL_MS || ![raw.scrollX, raw.scrollY, raw.zoom].every((value) => typeof value === "number" && Number.isFinite(value)) || raw.zoom <= 0) return null;
    return { scrollX: raw.scrollX, scrollY: raw.scrollY, zoom: raw.zoom };
  } catch {
    return null;
  }
}
function writeViewport(userId: string, boardId: string, viewport: Viewport | null) {
  if (!viewport) return;
  try { window.sessionStorage.setItem(viewportKey(userId, boardId), JSON.stringify({ ...viewport, at: Date.now() })); } catch { /* private mode: not kept */ }
}
const refsOf = (scene: CanonicalScene) => new Map<string, SceneFile>(Object.entries(scene.files));

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
  /** Asks the layer watcher to look again (QA E2); set once the canvas is on screen. */
  const checkLayersRef = useRef<() => void>(() => undefined);
  /** D198: the board's image references (file id → Nook document), and the pictures loaded for display. */
  const refsRef = useRef<Map<string, SceneFile>>(new Map());
  const filesRef = useRef<BinaryFiles>({});
  const [apiReady, setApiReady] = useState(false);
  /** Uploads in flight (a picture joins the board only once its file is stored). */
  const uploadsRef = useRef(new Set<AbortController>());
  const [uploading, setUploading] = useState<string | null>(null);
  /** The selected shapes, for "Link shape to a Nook item" (D199). */
  const [selection, setSelection] = useState<{ count: number; link: string | null }>({ count: 0, link: null });
  const selectionKey = useRef("0:");
  const viewportRef = useRef<Viewport | null>(null);
  const initialViewRef = useRef<Viewport | null>(null);
  const linkWarned = useRef(0);
  const { canWrite } = useRole();

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
          ? pendingCopyAction({ baseRevision: pending.baseRevision, live: pendingScene.elements.length, content: canonicalSceneJson(pendingScene), origin: pending.origin }, { revision: whiteboard.revision, live: safe.elements.length, content: canonicalSceneJson(safe) })
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
        // The references the board knows: the saved scene's, and an applied pending copy's.
        refsRef.current = new Map([...refsOf(safe), ...refsOf(initial)]);
        filesRef.current = {};
        initialViewRef.current = readViewport(userId, boardId);
        // What Excalidraw reports for the loaded scene is not an edit; anything else is.
        lastKeyRef.current = changeKey(initial.elements, initialAppState(initial));
        sceneRef.current = { elements: initial.elements, appState: initialAppState(initial), live: initial.elements.length, origin: "load" };
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
    return sceneForSave(captured.elements as never, captured.appState, refsRef.current, window.location.origin);
  }, []);

  const writePendingNow = useCallback((): Promise<void> => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    // Only a captured edit the server has not confirmed (QA E1): never the loaded scene, never after teardown began.
    if (tearingDownRef.current || !boardRef.current?.canEdit || !maySendCapture(stateRef.current, sceneRef.current)) return Promise.resolve();
    const result = currentScene();
    if (!result?.ok) return Promise.resolve();
    return writePending(userId, boardId, { scene: result.scene, baseRevision: stateRef.current.baseRevision, savedAt: new Date().toISOString(), live: result.stats.elementCount, origin: "edit" });
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
        const elements = captured.elements.filter((element) => element.isDeleted !== true && isKeptElement(element, refsRef.current)) as never;
        const appState = { ...captured.appState, exportBackground: true, exportWithDarkMode: false };
        // The whole drawing, with padding, fitted into the longest side (QA Q3). Never with its
        // pictures (T165): everyone who can read the board sees the thumbnail, also people who
        // cannot open a picture's file, so pictures are left blank in it.
        const files: BinaryFiles = {};
        const first = await exportToBlob({ elements, appState, files, maxWidthOrHeight: THUMBNAIL_MAX_SIDE, mimeType: "image/png", exportPadding: 24 });
        blob = first.size <= THUMBNAIL_MAX_BYTES ? first : await exportToBlob({ elements, appState, files, maxWidthOrHeight: THUMBNAIL_MAX_SIDE / 2, mimeType: "image/png", exportPadding: 16 });
        if (blob && blob.size > THUMBNAIL_MAX_BYTES) blob = await exportToBlob({ elements, appState, files, maxWidthOrHeight: THUMBNAIL_MAX_SIDE / 4, mimeType: "image/png", exportPadding: 8 });
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
    // Only a captured edit is ever sent (QA E1), on every path: the timer, the maximum wait, a
    // hidden tab, and the leave flush. An empty board from a real edit is sent like any other.
    if (!maySendCapture(state, sceneRef.current)) return Promise.resolve();
    const result = currentScene();
    if (!result) return Promise.resolve();
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
    // QA E4: end text editing while the editor is still whole. Its text box submits on blur, and a
    // blur during the editor's own unmount threw ("Error: Error"). What was typed is already captured.
    const editing = stageRef.current?.querySelector<HTMLTextAreaElement>("textarea.excalidraw-wysiwyg");
    if (editing) {
      try { editing.blur(); } catch { /* the editor is going away either way */ }
    }
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
    // Wave 24: a picture still uploading never joins the board (it is only placed once its file is
    // stored, and nothing is placed after teardown); the upload is cancelled and the person told.
    if (uploadsRef.current.size) {
      for (const controller of uploadsRef.current) controller.abort();
      uploadsRef.current.clear();
      flash("A picture was still uploading when you left, so it was not added to the whiteboard.");
    }
    writeViewport(userId, boardId, viewportRef.current);
  };
  useLayoutEffect(() => () => teardownRef.current(), []);
  // QA E5: while this canvas is open, the background sync leaves this board's pending copy alone.
  useEffect(() => markBoardOpen(boardId), [boardId]);
  // Wave 23 QA 1c: a release removed a lazy chunk and the page is about to reload once
  // (chunkReload.ts): unsaved edits go to the pending copy first, which the reloaded page applies
  // (same base) or offers (the board changed meanwhile), as after any other interruption.
  useEffect(() => onBeforeChunkReload(async () => {
    if (!hasPendingWork(stateRef.current)) return;
    await writePendingNow();
    void runSave();
  }), [runSave, writePendingNow]);

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
    checkLayersRef.current();
    const state = appState as unknown as Record<string, unknown>;
    // QA Q5: a refused image (paste, drop, or a Mermaid diagram Excalidraw renders as an image) gets
    // one friendly message instead of Excalidraw's error dialog.
    if (typeof state.errorMessage === "string" && /image/i.test(state.errorMessage)) {
      apiRef.current.updateScene({ appState: { errorMessage: null } as never });
      flash(IMAGES_REFUSED_MESSAGE);
      return;
    }
    const loose = elements as ReadonlyArray<Record<string, unknown>>;
    if (hasUnsupportedElements(loose, refsRef.current)) {
      // Pictures are Nook files (D198): one that is not (a Mermaid diagram drawn as an image, a
      // picture pasted from outside Nook) is removed before it is ever saved, and so are embeds and
      // AI frames (D199, review L2).
      apiRef.current.updateScene({ elements: (elements as never[]).filter((element) => isKeptElement(element as Record<string, unknown>, refsRef.current)) as never });
      flash(IMAGES_REFUSED_MESSAGE);
      return;
    }
    // Where the person looks (kept on leave, D199) and what they selected (the link picker).
    const zoom = (appState as { zoom?: { value?: number } }).zoom?.value;
    if (typeof appState.scrollX === "number" && typeof appState.scrollY === "number" && typeof zoom === "number") viewportRef.current = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom };
    const selectedIds = Object.keys(appState.selectedElementIds ?? {}).filter((id) => (appState.selectedElementIds as Record<string, boolean>)[id]);
    const firstSelected = selectedIds.length ? loose.find((element) => element.id === selectedIds[0]) : undefined;
    const firstLink = typeof firstSelected?.link === "string" && firstSelected.link ? firstSelected.link : null;
    const nextSelectionKey = `${selectedIds.length}:${firstLink ?? ""}`;
    if (nextSelectionKey !== selectionKey.current) {
      selectionKey.current = nextSelectionKey;
      setSelection({ count: selectedIds.length, link: firstLink });
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
        // A pending copy applied on open (D210) is unsaved work from a recorded edit: save it.
        applyPendingRef.current = null;
        lastKeyRef.current = key;
        sceneRef.current = { elements: loose.slice(), appState: keptAppState(state), live, origin: "edit" };
        dispatch({ type: "edited", at: Date.now() });
        schedulePendingWrite();
        return;
      }
      if (live === loadedLiveRef.current) {
        // The editor's report of the loaded scene: the baseline, not an edit.
        lastKeyRef.current = key;
        sceneRef.current = { elements: loose.slice(), appState: keptAppState(state), live, origin: "load" };
        // QA E6: a thumbnail older than the board (a reload or a closed tab right after a save) is
        // drawn again from the loaded scene once the board has been idle for a while.
        if (boardRef.current?.canEdit && stateRef.current.baseRevision > 1 && thumbRevision.current !== stateRef.current.baseRevision) scheduleThumbnail(stateRef.current.baseRevision);
        return;
      }
    }
    if (key === lastKeyRef.current || !boardRef.current?.canEdit) return;
    if (!mayCaptureEdit({ loaded: true, ready: readyRef.current, tearingDown: tearingDownRef.current })) return;
    lastKeyRef.current = key;
    sceneRef.current = { elements: loose.slice(), appState: keptAppState(state), live, origin: "edit" };
    dispatch({ type: "edited", at: Date.now() });
    schedulePendingWrite();
    if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current);
    // D199: a link outside the allowlist is not saved; say so once per new one.
    const refused = refusedLinks(loose, window.location.origin);
    if (refused > linkWarned.current) flash("A link was not kept: shapes can link to web pages (https), email, or a Nook item.");
    linkWarned.current = refused;
  }, [flash, schedulePendingWrite, scheduleThumbnail]);

  // D202: Back closes Excalidraw's own menus, dialogs, popups, and sidebar first. They are watched
  // in the DOM, since not all of them keep their open state in appState, and their dialogs and
  // popovers render outside the stage (portals on <body>). QA E2: the watch is both ways, so a layer
  // closed any other way (Escape, a click or tap outside, its own close control) releases its guard,
  // and its history sentinel, at once: the next Back does what it would have done without the layer.
  const hasCanvas = loaded !== null;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame: number | null = null;
    const check = () => {
      frame = null;
      if (!tearingDownRef.current) setExcalidrawLayer(openExcalidrawLayer(stage, document) !== null);
    };
    const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(check); };
    checkLayersRef.current = schedule;
    const observer = new MutationObserver(schedule);
    observer.observe(stage, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "data-state"] });
    // Portals are appended to <body>; their own subtrees change as a dialog opens and closes.
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      checkLayersRef.current = () => undefined;
    };
  }, [hasCanvas]);

  // QA E3: Escape closes Excalidraw's dialogs (Help, Mermaid, Clear canvas) even when focus is not
  // inside them (Excalidraw only listens inside the dialog). Its own handler runs first when it can.
  useEffect(() => {
    if (!hasCanvas) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const layer = openExcalidrawLayer(stageRef.current, document);
      if (!(layer instanceof HTMLElement) || !layer.matches(".Modal") || layer.contains(document.activeElement)) return;
      const close = layer.querySelector<HTMLElement>(".Dialog__close") ?? layer.querySelector<HTMLElement>(".Modal__background");
      if (!close) return;
      event.preventDefault();
      event.stopPropagation();
      close.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasCanvas]);
  useHistoryDialogGuard(excalidrawLayer && layer === null, () => {
    apiRef.current?.updateScene({ appState: closedExcalidrawLayers() as never });
    // The guard is spent: mark the layer closed so the next overlay arms a fresh guard (the DOM
    // watcher sets it again if anything is still open).
    setExcalidrawLayer(false);
    // Layers that keep their state elsewhere close on Escape, as they do from the keyboard.
    window.requestAnimationFrame(() => {
      const layer = openExcalidrawLayer(stageRef.current, document);
      if (!layer) return;
      // A dialog closes with its own control (its close button, or a click on its backdrop).
      const close = layer.matches(".Modal") ? layer.querySelector<HTMLElement>(".Dialog__close") ?? layer.querySelector<HTMLElement>(".Modal__background") : null;
      if (close) { close.click(); return; }
      layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      const editor = stageRef.current?.querySelector(".excalidraw");
      if (layer.isConnected && editor) editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    });
  });

  // ------------------------------------------------------------------ pictures (D198)
  /** Loads the pictures of `files` the viewer can open and hands them to the editor; the rest stay placeholders (T165). */
  const hydrate = useCallback(async (files: Iterable<SceneFile>) => {
    const pending = [...files].filter((file) => !filesRef.current[file.id]);
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const file = pending[next++]!;
        try {
          const image = await loadNookImage(file.nookDocumentId);
          const live = apiRef.current;
          if (!live || tearingDownRef.current || !mounted.current) return;
          const data = { id: file.id, mimeType: image.mimeType, dataURL: image.dataURL, created: Date.now() } as unknown as BinaryFileData;
          filesRef.current = { ...filesRef.current, [file.id]: data };
          live.addFiles([data]);
        } catch {
          // Not a file this viewer can open (or it is gone): Excalidraw keeps drawing its placeholder.
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }, []);

  const loadedKey = loaded ? loaded.board.id : null;
  useEffect(() => {
    if (!apiReady || !loadedKey) return;
    void hydrate(refsRef.current.values());
  }, [apiReady, hydrate, loadedKey]);

  /**
   * Places a Nook picture on the board: only once its file is stored and loaded, only while the
   * editor is mounted, ready, and editable, and never after teardown began. The element refers to
   * the document (file id = document id); the scene never holds the picture itself.
   */
  const placeImage = useCallback(async (document: Pick<DocumentSummary, "id" | "mime_type">, at?: { x: number; y: number }) => {
    if (!apiRef.current || !readyRef.current || tearingDownRef.current || !boardRef.current?.canEdit) return false;
    let image: Awaited<ReturnType<typeof loadNookImage>>;
    try {
      image = await loadNookImage(document.id);
    } catch (reason) {
      if (!tearingDownRef.current) flash(messageOf(reason, "Could not load the picture"));
      return false;
    }
    const live = apiRef.current;
    if (!live || !mounted.current || tearingDownRef.current || !readyRef.current) return false;
    const fileId = document.id;
    refsRef.current.set(fileId, { id: fileId, mimeType: document.mime_type, nookDocumentId: document.id });
    if (!filesRef.current[fileId]) {
      const data = { id: fileId, mimeType: image.mimeType, dataURL: image.dataURL, created: Date.now() } as unknown as BinaryFileData;
      filesRef.current = { ...filesRef.current, [fileId]: data };
      live.addFiles([data]);
    }
    const appState = live.getAppState();
    const visibleSide = Math.min(appState.width, appState.height) / appState.zoom.value;
    const size = placedSize(image.width, image.height, Math.max(64, Math.min(IMAGE_PLACE_MAX_SIDE, visibleSide * 0.6)));
    const point = at ?? { x: appState.offsetLeft + appState.width / 2, y: appState.offsetTop + appState.height / 2 };
    const center = viewportCoordsToSceneCoords({ clientX: point.x, clientY: point.y }, appState);
    const [element] = convertToExcalidrawElements([{ type: "image", fileId: fileId as never, x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height, status: "saved" }]);
    if (!element) return false;
    live.updateScene({ elements: [...live.getSceneElementsIncludingDeleted(), element] as never, appState: { selectedElementIds: { [element.id]: true } } as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    return true;
  }, [flash]);

  /** Uploads pictures into the board's folder as Files, then places each (D198). */
  const uploadImages = useCallback(async (files: File[], at?: { x: number; y: number }) => {
    const board = boardRef.current;
    if (!board?.canEdit) return;
    for (const file of files) {
      if (tearingDownRef.current) return;
      if (!isInsertableImageType(file.type)) {
        flash("Only PNG, JPEG, GIF, and WebP pictures can be added to a whiteboard");
        continue;
      }
      const controller = new AbortController();
      uploadsRef.current.add(controller);
      setUploading(file.name || "picture");
      try {
        const document = await uploadImageDocument(file, board.folder_id, controller.signal);
        uploadsRef.current.delete(controller);
        if (!tearingDownRef.current) await placeImage(document, at);
      } catch (reason) {
        if (!controller.signal.aborted && !tearingDownRef.current) flash(messageOf(reason, "Could not upload the picture"));
      } finally {
        uploadsRef.current.delete(controller);
        if (mounted.current && !tearingDownRef.current) setUploading(null);
      }
    }
  }, [flash, placeImage]);

  // The image tool (toolbar, shortcut 9, command palette) opens Nook's picker (vite.config.ts patch).
  useEffect(() => {
    const onImageTool = () => {
      apiRef.current?.setActiveTool({ type: "selection" });
      if (boardRef.current?.canEdit && !tearingDownRef.current && readyRef.current) setLayer({ kind: "image" });
    };
    window.addEventListener("nook:excalidraw-image", onImageTool);
    return () => window.removeEventListener("nook:excalidraw-image", onImageTool);
  }, []);

  // Dropped pictures go through the same upload (never Excalidraw's own path, which would embed them
  // and resize them with WebAssembly); other dropped files (a drawing, a PDF) are not opened here.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !loadedKey) return;
    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (!boardRef.current?.canEdit) return;
      const images = files.filter((file) => isInsertableImageType(file.type));
      if (!images.length) {
        flash("Only PNG, JPEG, GIF, and WebP pictures can be dropped on a whiteboard. To open a drawing, use Import on the whiteboards list.");
        return;
      }
      void uploadImages(images, { x: event.clientX, y: event.clientY });
    };
    stage.addEventListener("drop", onDrop, true);
    return () => stage.removeEventListener("drop", onDrop, true);
  }, [flash, loadedKey, uploadImages]);

  /**
   * Paste of a picture file: uploaded like a drop. Excalidraw inserts a pasted picture itself BEFORE
   * it asks `onPaste` (embedding it, and resizing it with WebAssembly), so the paste is caught first,
   * in the capture phase on window, whenever the editor has focus and the clipboard holds a picture.
   */
  useEffect(() => {
    if (!loadedKey) return;
    const onPasteCapture = (event: ClipboardEvent) => {
      const stage = stageRef.current;
      if (!stage || !stage.contains(document.activeElement) || !boardRef.current?.canEdit) return;
      const pictures = Array.from(event.clipboardData?.files ?? []).filter((file) => isInsertableImageType(file.type));
      if (!pictures.length) return;
      event.preventDefault();
      event.stopPropagation();
      void uploadImages(pictures);
    };
    window.addEventListener("paste", onPasteCapture, true);
    return () => window.removeEventListener("paste", onPasteCapture, true);
  }, [loadedKey, uploadImages]);

  /**
   * Paste of shapes: shapes copied from a Nook board keep their pictures when the pasted file ids are
   * Nook documents this person can open; any other pasted picture is removed (onChange) with a message.
   */
  const onPaste = useCallback(async (data: { files?: BinaryFiles }, event: ClipboardEvent | null) => {
    const pictures = Array.from(event?.clipboardData?.files ?? []).filter((file) => isInsertableImageType(file.type));
    if (pictures.length) return false;
    const files = data.files ?? {};
    for (const id of Object.keys(files)) {
      if (refsRef.current.has(id) || !isDocumentId(id)) continue;
      try {
        const { document } = await api<{ document: DocumentSummary }>(`/files/${encodeURIComponent(id)}`);
        if (document.preview_kind === "image") refsRef.current.set(id, { id, mimeType: document.mime_type, nookDocumentId: id });
      } catch {
        // Not a file this person can open: the pasted picture is removed.
      }
    }
    for (const [id, file] of Object.entries(files)) if (refsRef.current.has(id) && !filesRef.current[id]) filesRef.current = { ...filesRef.current, [id]: file };
    return !tearingDownRef.current;
  }, []);

  // ------------------------------------------------------------------ links (D199)
  const onLinkOpen = useCallback((element: { link: string | null }, event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>) => {
    event.preventDefault();
    const kept = element.link ? keptLink(element.link, window.location.origin) : null;
    const target = kept ? linkTarget(kept) : null;
    if (!target) {
      flash("This link can't be opened: shapes can link to web pages (https), email, or a Nook item.");
      return;
    }
    // A Nook item opens in the app as a new history entry; Back returns here, where the person was.
    if (target.kind === "app") {
      writeViewport(userId, boardId, viewportRef.current);
      onOpenPath(target.path);
    } else {
      setLayer({ kind: "external", url: target.url });
    }
  }, [boardId, flash, onOpenPath, userId]);

  /** Sets (or clears) the link of the selected shapes, as one undoable edit. */
  const applyLink = useCallback((link: string | null) => {
    setLayer(null);
    const live = apiRef.current;
    if (!live || !readyRef.current || tearingDownRef.current || !boardRef.current?.canEdit) return;
    const selected = live.getAppState().selectedElementIds;
    const ids = new Set(Object.keys(selected).filter((id) => selected[id]));
    if (!ids.size) {
      flash("Select a shape first, then link it.");
      return;
    }
    live.updateScene({ elements: live.getSceneElementsIncludingDeleted().map((element) => ids.has(element.id) ? newElementWith(element as never, { link } as never) : element) as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    flash(link ? "Linked. Select the shape and use its link to open it." : "Link removed");
  }, [flash]);

  // ------------------------------------------------------------------ export
  const download = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  /** PNG (D201) with the pictures this viewer can open; the others stay blank. */
  const exportPng = useCallback(async () => {
    const captured = sceneRef.current;
    if (!captured) return;
    try {
      const elements = captured.elements.filter((element) => element.isDeleted !== true && isKeptElement(element, refsRef.current)) as never;
      download(await exportToBlob({ elements, appState: { ...captured.appState, exportBackground: true, exportWithDarkMode: false }, files: filesRef.current, mimeType: "image/png", exportPadding: 16 }), `${name}.png`);
    } catch {
      flash("Could not export this whiteboard");
    }
  }, [download, flash, name]);

  /**
   * SVG (D201): built here from the validated scene and only ever downloaded as a file. Fonts are not
   * inlined (`skipInliningFonts`): inlining loads Excalidraw's font-subsetting chunk, which calls
   * Function() and so is refused by the CSP; the file names Excalidraw's fonts instead.
   */
  const exportSvg = useCallback(async () => {
    const captured = sceneRef.current;
    if (!captured) return;
    try {
      const elements = captured.elements.filter((element) => element.isDeleted !== true && isKeptElement(element, refsRef.current)) as never;
      const svg = await exportToSvg({ elements, appState: { ...captured.appState, exportBackground: true, exportWithDarkMode: false } as never, files: filesRef.current, exportPadding: 16, skipInliningFonts: true });
      download(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), `${name}.svg`);
    } catch {
      flash("Could not export this whiteboard");
    }
  }, [download, flash, name]);

  // ------------------------------------------------------------------ conflict, pending copy, versions
  const showServerScene = useCallback(async (message: string) => {
    const { whiteboard, scene } = await getWhiteboard(boardId);
    // Left meanwhile (a restore that was still on its way): the server has it; the next open shows it.
    if (tearingDownRef.current || !mounted.current) return;
    const safe = sceneForLoad(scene);
    if (!safe) throw new Error("This whiteboard could not be read");
    refsRef.current = new Map([...refsRef.current, ...refsOf(safe)]);
    // The editor takes complete elements: a stored scene may leave out defaults (one written by
    // import, MCP, or an older version), which Excalidraw fills in on load but not in updateScene.
    const elements = restoreElements(safe.elements as never, null, { refreshDimensions: false, repairBindings: true }) as unknown as ReadonlyArray<Record<string, unknown>>;
    lastKeyRef.current = changeKey(elements, initialAppState(safe));
    sceneRef.current = { elements, appState: initialAppState(safe), live: elements.length, origin: "server" };
    apiRef.current?.updateScene({ elements: elements as never, appState: { viewBackgroundColor: safe.appState.viewBackgroundColor ?? "#ffffff" } as never });
    apiRef.current?.history.clear();
    dispatch({ type: "reset", revision: whiteboard.revision, live: safe.elements.length });
    void clearPending(userId, boardId);
    setLoaded((current) => current ? { ...current, board: whiteboard } : current);
    setLayer(null);
    flash(message);
    scheduleThumbnail(whiteboard.revision);
    void hydrate(Object.values(safe.files));
  }, [boardId, flash, hydrate, scheduleThumbnail, userId]);

  const reloadLatest = useCallback(async () => {
    try {
      await showServerScene("Showing the latest version");
    } catch (reason) {
      if (lostAccess(reason)) loseAccess();
      else flash(messageOf(reason, "Could not load the latest version"));
    }
  }, [flash, loseAccess, showServerScene]);

  /**
   * D207: a kept version becomes a NEW revision through the revision check. Anything unsaved is
   * saved first, so a restore never discards work; if that cannot be saved now, nothing happens.
   */
  const restoreVersion = useCallback(async (snapshot: WhiteboardSnapshot) => {
    setLayer(null);
    if (!await flush()) {
      flash("Your latest changes are not saved yet, so nothing was restored. Try again in a moment.");
      return;
    }
    try {
      await restoreSnapshot(boardId, snapshot.id, stateRef.current.baseRevision);
      await showServerScene(`Restored the version from ${formatTime(snapshot.createdAt)}`);
    } catch (reason) {
      const payload = codeOf(reason);
      if (payload?.code === "REVISION_CONFLICT") {
        dispatch({ type: "conflict", revision: payload.revision ?? stateRef.current.baseRevision });
        if (!tearingDownRef.current) setLayer({ kind: "conflict" });
      } else if (lostAccess(reason) && payload?.code !== "NO_SNAPSHOT") loseAccess();
      else if (!tearingDownRef.current) flash(messageOf(reason, "Could not restore that version"));
    }
  }, [boardId, flash, flush, loseAccess, showServerScene]);

  /** A private copy of this board (or of one kept version), opened once it exists. */
  const duplicate = useCallback(async (snapshot?: WhiteboardSnapshot) => {
    if (boardRef.current?.canEdit && !snapshot && !await flush()) {
      flash("Your latest changes are not saved yet. Try again in a moment.");
      return;
    }
    try {
      const { whiteboard, imagesLeftOut } = await duplicateWhiteboard(boardId, snapshot ? { snapshotId: snapshot.id } : {});
      if (tearingDownRef.current) return;
      setLayer(null);
      flash(`Saved a copy: ${whiteboardDisplayName(whiteboard.name)}${imagesLeftOut ? `. ${imagesLeftOut === 1 ? "One picture" : `${imagesLeftOut} pictures`} you can't open ${imagesLeftOut === 1 ? "was" : "were"} left out.` : ""}`);
      onOpenBoard(whiteboard.id);
    } catch (reason) {
      if (!tearingDownRef.current) flash(messageOf(reason, "Could not duplicate this whiteboard"));
    }
  }, [boardId, flash, flush, onOpenBoard]);

  /** The pictures on hand, for History previews (stable, so previews are drawn once). */
  const heldFiles = useCallback(() => filesRef.current, []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(whiteboardLink(boardId));
      flash("Link copied. Paste it alone on a line in a note to show this whiteboard as a card.");
    } catch {
      flash(`Could not copy. The link is ${whiteboardLink(boardId)}`);
    }
  }, [boardId, flash]);

  /** Saves a scene as a new board next to this one and opens it (the conflict's and the offer's way out). */
  const saveAsCopy = useCallback(async (scene: CanonicalScene) => {
    const board = boardRef.current;
    if (!board) return;
    try {
      const { whiteboard } = await createWhiteboard(`${whiteboardDisplayName(board.name)} (copy)`, board.folder_id);
      let saved;
      try {
        saved = await saveWhiteboardScene(whiteboard.id, whiteboard.revision, scene);
      } catch (reason) {
        // A picture whose file this person can no longer open cannot start a new board: the copy keeps the rest.
        const payload = reason instanceof ApiError ? reason.payload as { code?: string; documentIds?: string[] } | null : null;
        if (payload?.code !== "IMAGE_NOT_AVAILABLE" || !payload.documentIds?.length) throw reason;
        saved = await saveWhiteboardScene(whiteboard.id, whiteboard.revision, sceneWithoutImages(scene, new Set(payload.documentIds)));
      }
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

  useHistoryDialogGuard(layer?.kind === "conflict" || layer?.kind === "discard" || layer?.kind === "restoreVersion" || layer?.kind === "external",
    () => setLayer(layer?.kind === "discard" ? { kind: "conflict" } : layer?.kind === "restoreVersion" ? { kind: "history" } : null));

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
  const initialView = initialViewRef.current;
  const openLinkPicker = () => {
    if (!selection.count) {
      flash("Select a shape first, then link it to a Nook item.");
      return;
    }
    setLayer({ kind: "link" });
  };

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
        {canEdit && <button className="icon-button whiteboard-bar-icon" onClick={() => setLayer({ kind: "image" })} aria-label="Insert image" title="Insert image"><ImagePlus /></button>}
        {canEdit && selection.count > 0 && <button className="icon-button whiteboard-bar-icon" onClick={openLinkPicker} aria-label="Link shape to a Nook item" title="Link to a Nook item"><LinkIcon /></button>}
        {canEdit && <button className="secondary-button whiteboard-bar-button desktop-only" onClick={() => setLayer({ kind: "board", dialog: { kind: "share", board } })}><Share2 />Share</button>}
        <button className="secondary-button whiteboard-bar-button desktop-only" onClick={() => { void exportPng(); }}><ImageDown />Export PNG</button>
        <button className="icon-button whiteboard-menu" onClick={() => setLayer({ kind: "board", dialog: { kind: "actions", board } })} aria-haspopup="dialog" aria-label={`Actions for ${name}`}><Ellipsis /></button>
      </div>
    </header>
    {!canEdit && <div className="whiteboard-banner" role="note">
      <span><strong>View only</strong> · Owned by <Avatar className="whiteboard-owner-avatar" name={board.owner_name} url={board.ownerAvatarUrl} /> {board.owner_name}</span>
      {canWrite && <button className="secondary-button" onClick={() => { void duplicate(); }}><Copy />Duplicate to my whiteboards</button>}
    </div>}
    {status === "rejected" && <p className="whiteboard-banner warn" role="alert">Not saved: {autosave.message}. Your changes are kept on this device.</p>}
    {uploading && <p className="whiteboard-banner" role="status"><LoaderCircle className="spin" aria-hidden="true" />Uploading {uploading}… It joins the board once it is saved in Files.</p>}
    {offer && <div className="whiteboard-banner warn" role="alert">
      <span>You have unsaved changes from an earlier visit that differ from this whiteboard as it is saved now.</span>
      <button className="secondary-button" onClick={() => { void saveAsCopy(offer.scene); }}>Restore as a copy</button>
      <button className="secondary-button" onClick={() => { setOffer(null); void clearPending(userId, boardId); }}>Discard</button>
    </div>}
    <div className="whiteboard-stage" ref={stageRef} onPointerDownCapture={(event) => {
      // QA E6: keyboard hints are for keyboards; a touch hides them for the rest of the visit.
      if (event.pointerType === "touch") event.currentTarget.dataset.touch = "true";
    }}>
      <Excalidraw
        excalidrawAPI={(instance) => { apiRef.current = instance; setApiReady(true); }}
        initialData={{
          elements: scene.elements as never,
          // Back to where the person was looking (D199), or the whole drawing.
          appState: { ...initialAppState(scene), ...(initialView ? { scrollX: initialView.scrollX, scrollY: initialView.scrollY, zoom: { value: initialView.zoom } } : {}) } as never,
          scrollToContent: !initialView
        }}
        onChange={onChange}
        onLinkOpen={onLinkOpen as never}
        onPaste={onPaste as never}
        theme="dark"
        langCode="en"
        name={name}
        viewModeEnabled={!canEdit}
        validateEmbeddable={false}
        renderTopRightUI={() => null}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: canEdit, toggleTheme: false, changeViewBackgroundColor: canEdit }, tools: { image: canEdit } }}
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
      extras={{
        onExportPng: () => { void exportPng(); },
        onExportSvg: () => { void exportSvg(); },
        onHistory: () => setLayer({ kind: "history" }),
        onInsertImage: () => setLayer({ kind: "image" }),
        onLinkItem: selection.count > 0 ? () => setLayer({ kind: "link" }) : undefined,
        onDuplicate: canWrite ? () => { void duplicate(); } : undefined,
        onCopyLink: () => { void copyLink(); }
      }}
      onChanged={(patch) => setLoaded((current) => current ? { ...current, board: { ...current.board, ...patch } } : current)}
      onDeleted={() => {
        void clearPending(userId, boardId);
        dispatch({ type: "reset", revision: stateRef.current.baseRevision, live: stateRef.current.savedLive });
        // The confirm is a history layer: close it and let its guard go (and any history move it
        // made land) before leaving, or the guard would take the step back as "close the dialog".
        setLayer(null);
        window.setTimeout(() => whenHistorySettled(onDeleted), 0);
      }}
      onAction={(action, target) => setLayer({ kind: "board", dialog: { kind: action, board: target } })} />
    {layer?.kind === "image" && <ImagePickerSheet onClose={() => setLayer(null)}
      onPick={(document) => { setLayer(null); void placeImage(document); }}
      onUpload={(files) => { setLayer(null); void uploadImages(files); }} />}
    {layer?.kind === "link" && <LinkPickerSheet currentLink={selection.link} onClose={() => setLayer(null)} onPick={(path) => applyLink(path)} onRemove={() => applyLink(null)} />}
    {(layer?.kind === "history" || layer?.kind === "restoreVersion") && <HistorySheet boardId={boardId} files={heldFiles}
      onClose={() => setLayer(null)}
      onRestore={(snapshot) => setLayer({ kind: "restoreVersion", snapshot })}
      onCopy={(snapshot) => duplicate(snapshot)} />}
    {layer?.kind === "restoreVersion" && <ConfirmDialog title="Restore this version?"
      message={restoreMessage({ createdAt: layer.snapshot.createdAt, elementCount: layer.snapshot.elementCount ?? 0 }, sceneRef.current?.live ?? autosave.savedLive, formatTime)}
      confirmLabel="Restore" onCancel={() => setLayer({ kind: "history" })} onConfirm={() => { void restoreVersion(layer.snapshot); }} />}
    {layer?.kind === "external" && <ModalDialog title="Open this link?" onClose={() => setLayer(null)}>
      <p className="file-dialog-copy">This opens a page outside Nook in a new tab:</p>
      <p className="whiteboard-link-url"><code>{layer.url}</code></p>
      <footer className="file-dialog-actions">
        <button className="secondary-button" onClick={() => setLayer(null)}>Cancel</button>
        <button className="primary-button" autoFocus onClick={() => {
          const url = layer.url;
          setLayer(null);
          window.open(url, "_blank", "noopener,noreferrer");
        }}>Open link</button>
      </footer>
    </ModalDialog>}
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
