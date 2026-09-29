import { describe, expect, test } from "bun:test";
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, autosaveLabel, autosaveReducer, hasPendingWork, initialAutosave, mayCaptureEdit, maySendCapture, nextSaveDelay, pendingCopyAction, pendingSyncAction, RETRY_MAX_MS, RETRY_MIN_MS, shouldSave, type AutosaveEvent, type AutosaveState, type Capture } from "../src/whiteboards/autosave";
import { changeKey, closedExcalidrawLayers, excalidrawLayerOpen, hasUnsupportedElements, isKeptElement, linkTarget, openExcalidrawLayer, restoreMessage, sceneForLoad, sceneForSave } from "../src/whiteboards/historyGuard";
import { installSyncTriggers, markBoardOpen, isBoardOpen, nextSyncTimer, pendingSyncDeps, requestPendingSync, setPendingSyncUser, stopPendingSyncTimer, syncPendingCopies, SYNC_TIMER_MAX_MS, SYNC_TIMER_MS, type SyncDeps } from "../src/whiteboards/pendingSync";
import { ApiError, noteRequestOutcome, onApiRecovered } from "../src/api";
import { installChunkReload, onBeforeChunkReload, resetChunkReloadForTests, BEFORE_RELOAD_MS } from "../src/chunkReload";
import { canonicalSceneJson, emptyScene, type CanonicalScene } from "../shared/whiteboardScene";
import { pendingKey } from "../src/whiteboards/pendingStore";
import { formatRoute, parseRoute } from "../src/router";
import { whiteboardsBackAction, whiteboardsRoute } from "../src/whiteboardsRoute";

/** The client side of Wave 23: the autosave machine (§8.2), history helpers (D202), routes (§10.1). */

const run = (events: AutosaveEvent[], start: AutosaveState = initialAutosave(1)) => events.reduce(autosaveReducer, start);

describe("whiteboard autosave state machine", () => {
  test("an edit makes it dirty; the save confirms it and goes idle with the new revision", () => {
    const dirty = run([{ type: "edited", at: 0 }]);
    expect(dirty.status).toBe("dirty");
    expect(shouldSave(dirty)).toBe(true);
    expect(hasPendingWork(dirty)).toBe(true);
    const saving = autosaveReducer(dirty, { type: "saveStarted" });
    expect(saving).toMatchObject({ status: "saving", savingVersion: 1 });
    const saved = autosaveReducer(saving, { type: "saved", revision: 2, at: 0, live: 1 });
    expect(saved).toMatchObject({ status: "idle", baseRevision: 2, savedVersion: 1, savingVersion: null });
    expect(hasPendingWork(saved)).toBe(false);
    expect(autosaveLabel(saved)).toBe("Saved");
  });

  test("only one save in flight: an edit while saving waits and goes dirty again with the new base", () => {
    const saving = run([{ type: "edited", at: 0 }, { type: "saveStarted" }]);
    const editedMeanwhile = autosaveReducer(saving, { type: "edited", at: 0 });
    expect(editedMeanwhile.status).toBe("saving");
    expect(autosaveReducer(editedMeanwhile, { type: "saveStarted" })).toBe(editedMeanwhile);
    const back = autosaveReducer(editedMeanwhile, { type: "saved", revision: 7, at: 0, live: 1 });
    expect(back).toMatchObject({ status: "dirty", baseRevision: 7, savedVersion: 1, editVersion: 2 });
  });

  test("409 goes to conflict and stays there through edits; reset starts over from the server's revision", () => {
    const conflict = run([{ type: "edited", at: 0 }, { type: "saveStarted" }, { type: "conflict", revision: 5 }]);
    expect(conflict).toMatchObject({ status: "conflict", serverRevision: 5 });
    expect(shouldSave(conflict)).toBe(false);
    const stillConflict = autosaveReducer(conflict, { type: "edited", at: 0 });
    expect(stillConflict.status).toBe("conflict");
    expect(autosaveLabel(stillConflict)).toBe("Conflict");
    const reset = autosaveReducer(stillConflict, { type: "reset", revision: 5, live: 1 });
    expect(reset).toMatchObject({ status: "idle", baseRevision: 5 });
    expect(hasPendingWork(reset)).toBe(false);
  });

  test("a network error goes offline with backoff from 2 s to 30 s, keeping the edit; a later save recovers", () => {
    let state = run([{ type: "edited", at: 0 }, { type: "saveStarted" }, { type: "failed" }]);
    expect(state).toMatchObject({ status: "offline", retryMs: RETRY_MIN_MS });
    expect(shouldSave(state)).toBe(true);
    expect(autosaveLabel(state)).toBe("Offline, kept on this device");
    for (let attempt = 0; attempt < 8; attempt += 1) state = run([{ type: "saveStarted" }, { type: "failed" }], state);
    expect(state.retryMs).toBe(RETRY_MAX_MS);
    state = run([{ type: "saveStarted" }, { type: "saved", revision: 3, at: 0, live: 1 }], state);
    expect(state).toMatchObject({ status: "idle", retryMs: 0, baseRevision: 3 });
  });

  test("429 waits as long as the server says, with its own label, and keeps the edit (review L11)", () => {
    const throttled = run([{ type: "edited", at: 0 }, { type: "saveStarted" }, { type: "failed", retryAfterMs: 45_000, message: "Saving paused for a moment, kept on this device" }]);
    expect(throttled).toMatchObject({ status: "offline", retryMs: 45_000 });
    expect(autosaveLabel(throttled)).toBe("Saving paused for a moment, kept on this device");
    expect(hasPendingWork(throttled)).toBe(true);
    const recovered = run([{ type: "saveStarted" }, { type: "saved", revision: 2, at: 0, live: 1 }], throttled);
    expect(recovered).toMatchObject({ status: "idle", message: null });
  });

  test("400 or 413 is rejected with the reason and no retry, until the next edit", () => {
    const rejected = run([{ type: "edited", at: 0 }, { type: "saveStarted" }, { type: "rejected", message: "Too many elements" }]);
    expect(rejected).toMatchObject({ status: "rejected", message: "Too many elements" });
    expect(shouldSave(rejected)).toBe(false);
    expect(hasPendingWork(rejected)).toBe(true);
    expect(autosaveReducer(rejected, { type: "edited", at: 0 }).status).toBe("dirty");
  });

  test("the pending copy (D210, QA D2, Q8): same content is discarded, same base applies, empty over elements or another base is offered", () => {
    const server = { revision: 4, live: 3, content: "server" };
    expect(pendingCopyAction(null, server)).toBe("none");
    expect(pendingCopyAction({ baseRevision: 4, live: 4, content: "mine" }, server)).toBe("apply");
    expect(pendingCopyAction({ baseRevision: 3, live: 4, content: "mine" }, server)).toBe("offer");
    // Saved after all (the same bytes as the server's): nothing to restore.
    expect(pendingCopyAction({ baseRevision: 3, live: 3, content: "server" }, server)).toBe("discard");
    // An empty copy over a board with elements that carries no recorded edit is never applied silently.
    expect(pendingCopyAction({ baseRevision: 4, live: 0, content: "empty" }, server)).toBe("offer");
    expect(pendingCopyAction({ baseRevision: 4, live: 0, content: "empty" }, { ...server, live: 0 })).toBe("apply");
    // QA E1d: an empty copy from a real edit on the server's revision is applied like any other;
    // on an older base it is offered, as any other copy is.
    expect(pendingCopyAction({ baseRevision: 4, live: 0, content: "empty", origin: "edit" }, server)).toBe("apply");
    expect(pendingCopyAction({ baseRevision: 3, live: 0, content: "empty", origin: "edit" }, server)).toBe("offer");
    expect(pendingKey("u1", "b1")).toBe("nook.whiteboard.pending.u1.b1");
  });

  test("QA D4: a save starts 1.5 s after the last edit, but never later than 5 s after the oldest unsaved one", () => {
    let state = run([{ type: "edited", at: 1000 }]);
    expect(state.firstUnsavedAt).toBe(1000);
    expect(nextSaveDelay(state, 1000)).toBe(AUTOSAVE_DEBOUNCE_MS);
    // An edit every 1.1 s keeps the oldest time, so the delay shrinks to 0 by 6 s.
    for (let at = 2100; at <= 5500; at += 1100) state = autosaveReducer(state, { type: "edited", at });
    expect(state.firstUnsavedAt).toBe(1000);
    expect(nextSaveDelay(state, 5500)).toBe(500);
    expect(nextSaveDelay(state, 1000 + AUTOSAVE_MAX_WAIT_MS)).toBe(0);
    // Saved with an edit in flight: that edit is the new oldest one.
    state = run([{ type: "saveStarted" }, { type: "edited", at: 6100 }, { type: "saved", revision: 2, at: 6200, live: 5 }], state);
    expect(state).toMatchObject({ status: "dirty", firstUnsavedAt: 6200 });
    state = run([{ type: "saveStarted" }, { type: "saved", revision: 3, at: 7000, live: 6 }], state);
    expect(state).toMatchObject({ status: "idle", firstUnsavedAt: null });
    expect(nextSaveDelay(state, 7000)).toBeNull();
    // Offline, the retry backoff decides.
    expect(nextSaveDelay(run([{ type: "edited", at: 0 }, { type: "saveStarted" }, { type: "failed" }]), 0)).toBe(RETRY_MIN_MS);
  });

  test("QA D1–D3 and E1: only a captured edit the server has not confirmed is ever sent or kept", () => {
    const loaded = autosaveReducer(initialAutosave(1), { type: "reset", revision: 2, live: 3 });
    const asLoaded: Capture = { origin: "load", live: 3 };
    // Nothing edited: nothing may be written or flushed, whatever the editor reports.
    expect(maySendCapture(loaded, asLoaded)).toBe(false);
    expect(maySendCapture(loaded, { origin: "edit", live: 0 })).toBe(false);
    expect(maySendCapture(loaded, null)).toBe(false);
    const edited = autosaveReducer(loaded, { type: "edited", at: 0 });
    expect(maySendCapture(edited, { origin: "edit", live: 4 })).toBe(true);
    // A scene that is not an edit is never sent, even with unsaved work (a server scene shown, the loaded one).
    expect(maySendCapture(edited, { origin: "load", live: 3 })).toBe(false);
    expect(maySendCapture(edited, { origin: "server", live: 3 })).toBe(false);
    // Once saved, nothing is pending any more (the copy is not rewritten after the save).
    const saved = run([{ type: "saveStarted" }, { type: "saved", revision: 3, at: 1, live: 4 }], edited);
    expect(maySendCapture(saved, { origin: "edit", live: 4 })).toBe(false);
  });

  test("QA E1: a board emptied by a real edit is saved on leave, by the timer, and by the maximum wait", () => {
    // 3 shapes saved, then Reset the canvas (or select all and Delete): a real edit with 0 shapes.
    let state = autosaveReducer(autosaveReducer(initialAutosave(1), { type: "reset", revision: 2, live: 3 }), { type: "edited", at: 1000 });
    const emptied: Capture = { origin: "edit", live: 0 };
    // The leave flush (100 ms later) sends it: provenance decides, not content.
    expect(maySendCapture(state, emptied)).toBe(true);
    expect(hasPendingWork(state)).toBe(true);
    expect(shouldSave(state)).toBe(true);
    // The timer and the maximum wait treat it like any other edit.
    expect(nextSaveDelay(state, 1000)).toBe(AUTOSAVE_DEBOUNCE_MS);
    for (let at = 2000; at <= 5000; at += 1000) state = autosaveReducer(state, { type: "edited", at });
    expect(nextSaveDelay(state, 1000 + AUTOSAVE_MAX_WAIT_MS)).toBe(0);
    expect(maySendCapture(state, emptied)).toBe(true);
    // After the save the server has an empty board; nothing is pending.
    state = run([{ type: "saveStarted" }, { type: "saved", revision: 3, at: 6000, live: 0 }], state);
    expect(state).toMatchObject({ status: "idle", savedLive: 0 });
    expect(maySendCapture(state, emptied)).toBe(false);
  });

  test("QA E1: an empty scene from a teardown can never be captured as an edit", () => {
    // The only way a scene becomes an edit capture is through this gate.
    expect(mayCaptureEdit({ loaded: true, ready: true, tearingDown: false })).toBe(true);
    // Teardown begun (the editor then reports an empty scene): never an edit.
    expect(mayCaptureEdit({ loaded: true, ready: true, tearingDown: true })).toBe(false);
    // Before the loaded scene is in the editor (its start-up reports an empty scene): never an edit.
    expect(mayCaptureEdit({ loaded: true, ready: false, tearingDown: false })).toBe(false);
    expect(mayCaptureEdit({ loaded: false, ready: false, tearingDown: false })).toBe(false);
    expect(mayCaptureEdit({ loaded: false, ready: true, tearingDown: true })).toBe(false);
  });
});

describe("whiteboard history and save helpers", () => {
  test("Excalidraw's menus, dialogs, popups, sidebar, and context menu count as layers Back closes", () => {
    expect(excalidrawLayerOpen({ openMenu: null, openDialog: null })).toBe(false);
    expect(excalidrawLayerOpen({ openMenu: "canvas" })).toBe(true);
    expect(excalidrawLayerOpen({ openDialog: { name: "help" } })).toBe(true);
    expect(excalidrawLayerOpen({ openSidebar: { name: "default" } })).toBe(true);
    expect(excalidrawLayerOpen({ contextMenu: { items: [] } })).toBe(true);
    expect(closedExcalidrawLayers()).toEqual({ openDialog: null, openMenu: null, openPopup: null, openSidebar: null, contextMenu: null });
  });

  test("a save leaves out deleted, image, and unsupported elements, and keeps only the allowlisted appState", () => {
    const base = { x: 0, y: 0, width: 1, height: 1 };
    const result = sceneForSave([
      { id: "keep", type: "rectangle", ...base },
      { id: "gone", type: "rectangle", isDeleted: true, ...base },
      { id: "img", type: "image", fileId: "f1", ...base },
      { id: "web", type: "embeddable", link: "https://example.test", ...base }
    ], { viewBackgroundColor: "#fafafa", gridSize: 20, zoom: { value: 3 }, scrollX: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.elements.map((element) => element.id)).toEqual(["keep"]);
    expect(result.scene.appState).toEqual({ viewBackgroundColor: "#fafafa", gridSize: 20 });
    expect(result.scene.files).toEqual({});
    expect(hasUnsupportedElements([{ type: "image" }])).toBe(true);
    expect(hasUnsupportedElements([{ type: "embeddable" }])).toBe(true);
    expect(hasUnsupportedElements([{ type: "magicframe" }])).toBe(true);
    expect([{ type: "rectangle" }, { type: "embeddable" }, { type: "image" }, { type: "magicframe", isDeleted: true }].filter(isKeptElement).map((element) => element.type)).toEqual(["rectangle", "magicframe"]);
    expect(hasUnsupportedElements([{ type: "image", isDeleted: true }, { type: "text" }])).toBe(false);
  });

  test("scenes from the server are validated again on load (T160)", () => {
    expect(sceneForLoad({ type: "excalidraw", elements: [{ id: "a", type: "iframe" }] })).toBeNull();
    expect(sceneForLoad({ type: "excalidraw", elements: [] })?.source).toBe("nook");
  });

  test("the change key moves with element versions and the kept appState, not with scrolling", () => {
    const elements = [{ id: "a", type: "rectangle", version: 3 }];
    const key = changeKey(elements, { viewBackgroundColor: "#fff", gridSize: 20, scrollX: 0 });
    expect(changeKey(elements, { viewBackgroundColor: "#fff", gridSize: 20, scrollX: 500 })).toBe(key);
    expect(changeKey([{ ...elements[0], version: 4 }], { viewBackgroundColor: "#fff", gridSize: 20 })).not.toBe(key);
    expect(changeKey(elements, { viewBackgroundColor: "#000", gridSize: 20 })).not.toBe(key);
  });

  test("links (D199): Nook paths route in the app, web and mail links open outside, anything else nowhere", () => {
    expect(linkTarget("/notes/123e4567-e89b-42d3-a456-426614174000")).toEqual({ kind: "app", path: "/notes/123e4567-e89b-42d3-a456-426614174000" });
    expect(linkTarget("https://example.test/x")).toEqual({ kind: "external", url: "https://example.test/x" });
    expect(linkTarget("mailto:a@example.test")?.kind).toBe("external");
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("//evil.example.test")).toBeNull();
    expect(linkTarget("data:text/html,x")).toBeNull();
  });
});

describe("whiteboard routes", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  test("parse and format /whiteboards, shared, a folder, and one board; uppercase ids are lowercased; malformed falls back to the list", () => {
    expect(parseRoute("/whiteboards")).toEqual({ app: "whiteboards", folder: "all", boardId: null });
    expect(parseRoute("/whiteboards/shared")).toEqual({ app: "whiteboards", folder: "shared", boardId: null });
    expect(parseRoute(`/whiteboards/folder/${id}`)).toEqual({ app: "whiteboards", folder: id, boardId: null });
    expect(parseRoute(`/whiteboards/${id.toUpperCase()}`)).toEqual({ app: "whiteboards", folder: "all", boardId: id });
    expect(parseRoute("/whiteboards/not-an-id")).toEqual({ app: "whiteboards", folder: "all", boardId: null });
    expect(parseRoute(`/whiteboards/${id}/extra`)).toEqual({ app: "whiteboards", folder: "all", boardId: null });
    for (const path of ["/whiteboards", "/whiteboards/shared", `/whiteboards/folder/${id}`, `/whiteboards/${id}`]) expect(formatRoute(parseRoute(path))).toBe(path);
  });

  test("in-app Back: history when this visit pushed the canvas, else the list; the list goes Home", () => {
    expect(whiteboardsBackAction(whiteboardsRoute("all", id), 2)).toEqual({ kind: "history" });
    expect(whiteboardsBackAction(whiteboardsRoute("shared", id), 0)).toEqual({ kind: "replace", route: whiteboardsRoute("shared") });
    expect(whiteboardsBackAction(whiteboardsRoute(), 3)).toEqual({ kind: "home" });
  });
});

describe("QA E5: the background sync of pending copies", () => {
  const scene = (count: number): CanonicalScene => ({ ...emptyScene(), elements: Array.from({ length: count }, (_, index) => ({ id: `r${index}`, type: "rectangle", x: index * 10, y: 0, width: 5, height: 5, angle: 0, version: 1, isDeleted: false })) as never });
  const fakeDeps = (options: { pending: Record<string, { baseRevision: number; count: number; origin?: "edit" }>; server: Record<string, { revision: number; count: number; canEdit?: boolean } | "gone">; save?: (id: string) => Promise<void>; open?: string[]; current?: () => boolean }) => {
    const store = new Map(Object.entries(options.pending).map(([id, entry]) => [id, { scene: scene(entry.count), baseRevision: entry.baseRevision, savedAt: "t", origin: entry.origin }]));
    const saves: string[] = [];
    const deps: SyncDeps = {
      listBoards: async () => [...store.keys()],
      readPending: async (id) => store.get(id) ?? null,
      getBoard: async (id) => {
        const board = options.server[id];
        if (!board || board === "gone") throw new ApiError("Not found", 404, { code: "NOT_FOUND" });
        return { whiteboard: { revision: board.revision, canEdit: board.canEdit ?? true }, scene: scene(board.count) };
      },
      save: async (id) => { saves.push(id); await options.save?.(id); return { revision: 9, savedAt: "t", sha256: "x", sizeBytes: 1 }; },
      clear: async (id) => { store.delete(id); },
      isCurrent: options.current ?? (() => true),
      isOpen: (id) => (options.open ?? []).includes(id)
    };
    return { deps, saves, store };
  };

  test("pendingSyncAction: only a copy the open would apply is sent; the same content is cleared; anything else waits", () => {
    const server = { revision: 4, live: 3, content: "server", canEdit: true };
    expect(pendingSyncAction({ baseRevision: 4, live: 4, content: "mine", origin: "edit" }, server)).toBe("send");
    expect(pendingSyncAction({ baseRevision: 4, live: 0, content: "empty", origin: "edit" }, server)).toBe("send");
    expect(pendingSyncAction({ baseRevision: 4, live: 0, content: "empty" }, server)).toBe("keep");
    expect(pendingSyncAction({ baseRevision: 3, live: 4, content: "mine", origin: "edit" }, server)).toBe("keep");
    expect(pendingSyncAction({ baseRevision: 3, live: 3, content: "server" }, server)).toBe("clear");
    expect(pendingSyncAction({ baseRevision: 4, live: 4, content: "mine", origin: "edit" }, { ...server, canEdit: false })).toBe("keep");
    expect(pendingSyncAction({ baseRevision: 4, live: 4, content: "mine", origin: "edit" }, null)).toBe("keep");
  });

  test("sends copies one at a time through the CAS, leaves conflicts and open boards, and clears the sent ones", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps, saves, store } = fakeDeps({
      pending: { a: { baseRevision: 2, count: 4, origin: "edit" }, b: { baseRevision: 1, count: 2, origin: "edit" }, c: { baseRevision: 5, count: 1, origin: "edit" }, d: { baseRevision: 3, count: 3 }, e: { baseRevision: 7, count: 2, origin: "edit" } },
      server: { a: { revision: 2, count: 3 }, b: { revision: 2, count: 3 }, c: { revision: 5, count: 0 }, d: { revision: 3, count: 3 }, e: { revision: 7, count: 1 } },
      open: ["e"],
      save: async (id) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (id === "c") throw new ApiError("This whiteboard changed on another device", 409, { code: "REVISION_CONFLICT", revision: 6 });
      }
    });
    const result = await syncPendingCopies(deps);
    expect(saves).toEqual(["a", "c"]);
    expect(maxInFlight).toBe(1);
    expect(result).toMatchObject({ sent: ["a"], cleared: ["d"], stopped: null });
    // b (older base) waits to be offered; c (409) waits; e is open in a canvas.
    expect(result.kept.sort()).toEqual(["b", "c", "e"]);
    expect([...store.keys()].sort()).toEqual(["b", "c", "e"]);
  });

  test("stops at a 429, while offline, and when the person signs out; never sends for another user", async () => {
    const limited = fakeDeps({
      pending: { a: { baseRevision: 1, count: 2, origin: "edit" }, b: { baseRevision: 1, count: 2, origin: "edit" } },
      server: { a: { revision: 1, count: 1 }, b: { revision: 1, count: 1 } },
      save: async () => { throw new ApiError("Too many saves", 429, { code: "RATE_LIMITED", retryAfter: 30 }); }
    });
    expect(await syncPendingCopies(limited.deps)).toMatchObject({ stopped: "rate-limited", sent: [] });
    expect(limited.saves).toEqual(["a"]);
    const offline = fakeDeps({ pending: { a: { baseRevision: 1, count: 2, origin: "edit" } }, server: { a: { revision: 1, count: 1 } }, save: async () => { throw new TypeError("Failed to fetch"); } });
    expect(await syncPendingCopies(offline.deps)).toMatchObject({ stopped: "offline" });
    expect(offline.store.size).toBe(1);
    let signedIn = true;
    const signOut = fakeDeps({
      pending: { a: { baseRevision: 1, count: 2, origin: "edit" }, b: { baseRevision: 1, count: 2, origin: "edit" } },
      server: { a: { revision: 1, count: 1 }, b: { revision: 1, count: 1 } },
      save: async () => { signedIn = false; },
      current: () => signedIn
    });
    expect(await syncPendingCopies(signOut.deps)).toMatchObject({ stopped: "signed-out", sent: ["a"] });
    expect(signOut.saves).toEqual(["a"]);
    const nobody = fakeDeps({ pending: { a: { baseRevision: 1, count: 2, origin: "edit" } }, server: { a: { revision: 1, count: 1 } }, current: () => false });
    expect(await syncPendingCopies(nobody.deps)).toMatchObject({ stopped: "signed-out" });
    expect(nobody.saves).toEqual([]);
    // A board that is gone stays (the next open says so) and the run goes on.
    const gone = fakeDeps({ pending: { a: { baseRevision: 1, count: 2, origin: "edit" } }, server: { a: "gone" } });
    expect(await syncPendingCopies(gone.deps)).toMatchObject({ kept: ["a"], stopped: null });
    expect(canonicalSceneJson(scene(0))).toBe(canonicalSceneJson(emptyScene()));
  });

  test("a board a canvas has open is left to that canvas", () => {
    expect(isBoardOpen("x")).toBe(false);
    const release = markBoardOpen("x");
    const again = markBoardOpen("x");
    expect(isBoardOpen("x")).toBe(true);
    release();
    release();
    expect(isBoardOpen("x")).toBe(true);
    again();
    expect(isBoardOpen("x")).toBe(false);
  });
});

describe("QA E2, E6: the layer watcher and the restore wording", () => {
  type Fake = { matches?: (selector: string) => boolean; getClientRects: () => { length: number } };
  const node = (rendered: boolean): Fake => ({ getClientRects: () => ({ length: rendered ? 1 : 0 }) });
  const root = (found: Fake[]) => ({ querySelectorAll: () => found as never });

  test("only a rendered Excalidraw layer, in the stage or in a portal on <body>, counts", () => {
    expect(openExcalidrawLayer(root([]) as never, root([]) as never)).toBeNull();
    expect(openExcalidrawLayer(null, root([]) as never)).toBeNull();
    const menu = node(true);
    expect(openExcalidrawLayer(root([menu]) as never, root([]) as never)).toBe(menu as never);
    // Help or Mermaid: a portal outside the stage.
    const help = node(true);
    expect(openExcalidrawLayer(root([]) as never, root([help]) as never)).toBe(help as never);
    // A layer left in the DOM but not rendered (closed by a click outside) does not hold a Back entry.
    expect(openExcalidrawLayer(root([node(false)]) as never, root([node(false)]) as never)).toBeNull();
  });

  test("the restore dialog names the version it switches to and both counts, whichever has more", () => {
    const at = (value: string) => `[${value}]`;
    expect(restoreMessage({ createdAt: "t1", elementCount: 3 }, 0, at)).toBe("Switch to the version from [t1], which has 3 shapes; the current one has 0 shapes. You can switch back the same way.");
    expect(restoreMessage({ createdAt: "t2", elementCount: 0 }, 1, at)).toBe("Switch to the version from [t2], which has 0 shapes; the current one has 1 shape. You can switch back the same way.");
    expect(restoreMessage(null, 2, at)).not.toMatch(/removed/);
  });
});

describe("QA F1: sending kept drawings never depends on one event", () => {
  test("the timer: 30 s after a run that sent something, doubling to 5 minutes after runs that could not; none when nothing is pending or nobody is signed in", () => {
    const sent = { sent: ["a"], stopped: null } as const;
    const offline = { sent: [], stopped: "offline" } as const;
    expect(nextSyncTimer(sent, 1, 3)).toEqual({ delay: SYNC_TIMER_MS, streak: 0 });
    let streak = 0;
    const delays: number[] = [];
    for (let run = 0; run < 7; run += 1) {
      const next = nextSyncTimer(offline, 2, streak);
      delays.push(next.delay!);
      streak = next.streak;
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, SYNC_TIMER_MAX_MS, SYNC_TIMER_MAX_MS, SYNC_TIMER_MAX_MS]);
    // A 429 backs off the same way; so do runs with only copies that wait for their board's next open.
    expect(nextSyncTimer({ sent: [], stopped: "rate-limited" }, 1, 0).delay).toBe(SYNC_TIMER_MS);
    expect(nextSyncTimer({ sent: [], stopped: null }, 1, 1).delay).toBe(60_000);
    // Nothing pending, or signed out: no timer, and the streak starts over.
    expect(nextSyncTimer(offline, 0, 4)).toEqual({ delay: null, streak: 0 });
    expect(nextSyncTimer({ sent: [], stopped: "signed-out" }, 3, 4)).toEqual({ delay: null, streak: 0 });
  });

  test("each trigger runs the sync: online, the tab shown again, focus, and the first success after a failed request", () => {
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (name: string, listener: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
      removeEventListener: (name: string, listener: () => void) => { listeners.get(name)?.delete(listener); }
    };
    const doc = { ...target, visibilityState: "hidden" as DocumentVisibilityState };
    const fire = (name: string) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(); };
    let runs = 0;
    const remove = installSyncTriggers(target as never, doc as never, () => { runs += 1; }, onApiRecovered);
    fire("online");
    expect(runs).toBe(1);
    fire("focus");
    expect(runs).toBe(2);
    fire("visibilitychange");
    expect(runs).toBe(2);
    doc.visibilityState = "visible";
    fire("visibilitychange");
    expect(runs).toBe(3);
    // Successes alone say nothing; the first success after a failure does, once.
    noteRequestOutcome(true);
    expect(runs).toBe(3);
    noteRequestOutcome(false);
    noteRequestOutcome(false);
    noteRequestOutcome(true);
    noteRequestOutcome(true);
    expect(runs).toBe(4);
    remove();
    fire("online"); fire("focus"); fire("visibilitychange");
    noteRequestOutcome(false); noteRequestOutcome(true);
    expect(runs).toBe(4);
  });

  test("the real deps run only for the person signed in, and not after sign-out", async () => {
    setPendingSyncUser(null);
    const nobody = await requestPendingSync(() => pendingSyncDeps("u-sync"));
    expect(nobody?.stopped).toBe("signed-out");
    setPendingSyncUser("someone-else");
    expect((await requestPendingSync(() => pendingSyncDeps("u-sync")))?.stopped).toBe("signed-out");
    setPendingSyncUser(null);
    stopPendingSyncTimer();
  });
});

describe("Wave 23 QA 1c: a chunk reload keeps unsaved whiteboard edits", () => {
  test("the reload waits for the hooks (the pending copy is written first); without hooks it is immediate", async () => {
    resetChunkReloadForTests();
    const calls: string[] = [];
    const listeners: Array<(event: { preventDefault: () => void }) => void> = [];
    const target = { addEventListener: ((_name: string, listener: never) => { listeners.push(listener); }) as never, sessionStorage: { getItem: () => null, setItem: () => undefined }, location: { href: "https://nook.test/whiteboards/b1", reload: () => { calls.push("reload"); }, replace: () => undefined } as never };
    installChunkReload(target);
    const remove = onBeforeChunkReload(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); calls.push("pending copy written"); });
    listeners.at(-1)!({ preventDefault: () => undefined });
    expect(calls).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual(["pending copy written", "reload"]);
    remove();
    // A hook that never finishes does not hold the reload past BEFORE_RELOAD_MS.
    expect(BEFORE_RELOAD_MS).toBeLessThanOrEqual(2000);
    resetChunkReloadForTests();
  });
});
