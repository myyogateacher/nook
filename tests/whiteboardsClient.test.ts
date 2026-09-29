import { describe, expect, test } from "bun:test";
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, autosaveLabel, autosaveReducer, hasPendingWork, initialAutosave, leaveFlushAllowed, mayWritePending, nextSaveDelay, pendingCopyAction, RETRY_MAX_MS, RETRY_MIN_MS, shouldSave, type AutosaveEvent, type AutosaveState } from "../src/whiteboards/autosave";
import { changeKey, closedExcalidrawLayers, excalidrawLayerOpen, hasUnsupportedElements, isKeptElement, linkTarget, sceneForLoad, sceneForSave } from "../src/whiteboards/historyGuard";
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
    // An empty copy over a board with elements is never applied silently.
    expect(pendingCopyAction({ baseRevision: 4, live: 0, content: "empty" }, server)).toBe("offer");
    expect(pendingCopyAction({ baseRevision: 4, live: 0, content: "empty" }, { ...server, live: 0 })).toBe("apply");
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

  test("QA D1–D3: only an unsaved edit may become pending, and a leave flush never sends an empty scene over elements", () => {
    const loaded = autosaveReducer(initialAutosave(1), { type: "reset", revision: 2, live: 3 });
    expect(loaded.savedLive).toBe(3);
    // Nothing edited: nothing may be written or flushed, whatever the editor reports.
    expect(mayWritePending(loaded)).toBe(false);
    expect(leaveFlushAllowed(loaded, 0)).toBe(false);
    expect(leaveFlushAllowed(loaded, 3)).toBe(false);
    const edited = autosaveReducer(loaded, { type: "edited", at: 0 });
    expect(mayWritePending(edited)).toBe(true);
    expect(leaveFlushAllowed(edited, 4)).toBe(true);
    // An empty scene over a board with 3 saved elements is never sent from a leave flush.
    expect(leaveFlushAllowed(edited, 0)).toBe(false);
    // Once saved, nothing is pending any more (the copy is not rewritten after the save).
    const saved = run([{ type: "saveStarted" }, { type: "saved", revision: 3, at: 1, live: 4 }], edited);
    expect(mayWritePending(saved)).toBe(false);
    // A board that is empty on the server may be saved empty.
    const emptyBoard = autosaveReducer(autosaveReducer(initialAutosave(1), { type: "reset", revision: 1, live: 0 }), { type: "edited", at: 0 });
    expect(leaveFlushAllowed(emptyBoard, 0)).toBe(true);
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
