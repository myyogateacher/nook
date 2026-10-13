import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState, NodeSelection, type Transaction } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { noteContentExtensions } from "../src/editor/extensions";
import { fillSlot, pendingSlotCount, releaseSlot, reserveSlots, slotInfo, slotPercent, slotProgress, storedFileNode, uploadSlotsPlugin } from "../src/editor/uploadSlots";
import { draftFiles, mapDraftRemoval, missingDraftFiles, removalMessage, removedDraftFiles, restoreDraftFiles, type DraftRemoval } from "../src/editor/draftRemovals";
import { notifyRemoved } from "../src/ui/attachments/undoRemoval";
import { relinkToHost } from "../src/ui/attachments/uploadForHost";
import { LEAVE_UPLOADS_CONFIRM } from "../src/editor/uploadSlots";

/**
 * The client side of Undo for removed attachments and of note upload progress: the removal toast
 * (Undo calls the relink route, then says how it went), the note editor's draft removals (put back
 * where they were, never on Undo/Redo or an upload landing), the upload slots' progress and Cancel,
 * and the leave-mid-upload wiring (the app's confirm, a history layer for Back, beforeunload for the
 * tab). Interaction itself is covered by the live QA (no DOM in unit tests).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const schema = getSchema(noteContentExtensions());
const ids = ["0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d10", "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d12"];
const fileNode = (index: number, image = false) => storedFileNode(schema, { id: ids[index]!, name: image ? `photo-${index}.png` : `file-${index}.txt`, mime_type: image ? "image/png" : "text/plain", preview_kind: image ? "image" : "text" })!;

function noteWith(...nodes: Array<ReturnType<typeof fileNode>>) {
  const content = [schema.node("paragraph", null, [schema.text("Intro")]), ...nodes, schema.node("paragraph", null, [schema.text("End")])];
  return EditorState.create({ schema, doc: schema.node("doc", null, content), plugins: [uploadSlotsPlugin(), history()] });
}
/** The note's blocks, in order: paragraph text, or the file card or image by its index in `ids`. */
const blocks = (state: EditorState) => {
  const out: string[] = [];
  state.doc.forEach((node) => {
    if (node.type.name === "paragraph") out.push(`p:${node.textContent}`);
    else out.push(`${node.type.name}:${ids.indexOf([...draftFiles(schema.node("doc", null, [node])).keys()][0] ?? "")}`);
  });
  return out;
};
/** Deletes the block at document index `index` (a file card or an image) as a person would (select it, delete). */
function deleteBlock(state: EditorState, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += state.doc.child(i).nodeSize;
  return state.tr.setSelection(NodeSelection.create(state.doc, pos)).deleteSelection();
}

describe("draft removals (notes): Undo puts the file back in the draft", () => {
  test("a deleted file card and image are found, named, and put back where they were", () => {
    let state = noteWith(fileNode(0), fileNode(1, true), fileNode(2));
    expect(blocks(state)).toEqual(["p:Intro", "fileChip:0", "image:1", "fileChip:2", "p:End"]);
    const tr = deleteBlock(state, 2);
    state = state.apply(tr);
    const items = removedDraftFiles(tr, state.doc);
    expect(items.map((item) => item.id)).toEqual([ids[1]]);
    expect(removalMessage(items)).toBe("Removed photo-1.png");
    // More typing before Undo: positions follow.
    const removal: DraftRemoval = { key: "k", items };
    const typing = state.tr.insertText("New ", 1);
    state = state.apply(typing);
    mapDraftRemoval(removal, [typing]);
    state = state.apply(restoreDraftFiles(state, removal.items)!);
    expect(blocks(state)).toEqual(["p:New Intro", "fileChip:0", "image:1", "fileChip:2", "p:End"]);
    // Already back: nothing to do.
    expect(restoreDraftFiles(state, removal.items)).toBeNull();
    expect(missingDraftFiles(state, removal.items)).toBe(0);
  });

  test("several at once are one toast; a move, Undo/Redo, an upload landing, and a reload are not removals", () => {
    let state = noteWith(fileNode(0), fileNode(1));
    const both = state.tr.delete(state.doc.child(0).nodeSize, state.doc.child(0).nodeSize + state.doc.child(1).nodeSize + state.doc.child(2).nodeSize);
    state = state.apply(both);
    const items = removedDraftFiles(both, state.doc);
    expect(removalMessage(items)).toBe("Removed 2 files");
    state = state.apply(restoreDraftFiles(state, items)!);
    expect(blocks(state)).toEqual(["p:Intro", "fileChip:0", "fileChip:1", "p:End"]);

    // A drag within the note deletes and inserts in one step: the file is still there.
    const card = state.doc.child(1);
    const move = state.tr.delete(state.doc.child(0).nodeSize, state.doc.child(0).nodeSize + card.nodeSize);
    move.insert(move.doc.content.size, card);
    expect(removedDraftFiles(move, state.apply(move).doc)).toEqual([]);

    // Undo (prosemirror-history) of an insertion is not a removal.
    let withHistory = noteWith();
    withHistory = withHistory.apply(withHistory.tr.insert(withHistory.doc.child(0).nodeSize, fileNode(0)));
    let undone: Transaction | null = null;
    undo(withHistory, (tr) => { undone = tr; });
    expect(undone).not.toBeNull();
    expect(removedDraftFiles(undone!, withHistory.apply(undone!).doc)).toEqual([]);

    // A reload (setContent without an update) is not one either.
    const reload = state.tr.delete(0, state.doc.content.size).setMeta("preventUpdate", true);
    expect(removedDraftFiles(reload, state.apply(reload).doc)).toEqual([]);
  });
});

describe("upload slots: progress and Cancel", () => {
  test("progress shows as a percentage, updates only when it changes, and cancelable slots say so", () => {
    let state = noteWith();
    const { tr, ids: slots } = reserveSlots(state, ["big.mov", "small.txt"], state.doc.child(0).nodeSize, { cancelable: true });
    state = state.apply(tr);
    expect(slotInfo(state, slots[0]!)).toEqual({ label: "big.mov", progress: null, cancelable: true });
    expect(slotPercent(slotInfo(state, slots[0]!)!)).toBe("");
    state = state.apply(slotProgress(state, slots[0]!, 0.421)!);
    expect(slotPercent(slotInfo(state, slots[0]!)!)).toBe("42%");
    // The same shown percentage dispatches nothing.
    expect(slotProgress(state, slots[0]!, 0.4249)).toBeNull();
    state = state.apply(slotProgress(state, slots[0]!, 1.7)!);
    expect(slotInfo(state, slots[0]!)!.progress).toBe(1);
    // Progress is not an edit: Undo never sees it.
    expect(slotProgress(noteWith(), "slot:gone", 0.5)).toBeNull();
    // Non-attach editors (card descriptions) keep slots without Cancel.
    const plain = reserveSlots(state, ["c.png"]);
    expect(slotInfo(state.apply(plain.tr), plain.ids[0]!)!.cancelable).toBe(false);
  });

  test("a cancelled slot frees its room in the 100-file count at once; the others still land in order", () => {
    let state = noteWith();
    const { tr, ids: slots } = reserveSlots(state, ["a.txt", "b.txt", "c.txt"], state.doc.child(0).nodeSize, { cancelable: true });
    state = state.apply(tr);
    expect(pendingSlotCount(state)).toBe(3);
    state = state.apply(releaseSlot(state, slots[1]!)!);
    expect(pendingSlotCount(state)).toBe(2);
    state = state.apply(fillSlot(state, slots[0]!, fileNode(0))!);
    expect(fillSlot(state, slots[1]!, fileNode(1))).toBeNull();
    state = state.apply(fillSlot(state, slots[2]!, fileNode(2))!);
    expect(blocks(state)).toEqual(["p:Intro", "fileChip:0", "fileChip:2", "p:End"]);
  });

  test("the editor wires progress, Cancel, and the in-flight count", () => {
    const editor = source("editor/NoteEditor.tsx");
    expect(editor).toContain('uploadForHost(file, "note", { signal: controller.signal, onProgress:');
    expect(editor).toContain("{ cancelable: true }");
    expect(editor).toContain("UPLOAD_SLOT_CANCEL_EVENT");
    // Uploads in flight (waiting or sending) count against the 100-file limit.
    expect(editor).toContain("noteFileRoom(activeEditor) - pendingSlotCount(activeEditor.state)");
    expect(source("editor/uploadSlots.ts")).toContain('cancel.setAttribute("aria-label", `Cancel upload of ${slot.label}`)');
    expect(source("editor/uploadSlots.ts")).toContain('document.createElement("progress")');
  });
});

describe("leaving a note mid-upload", () => {
  test("the app's confirm (never window.confirm), a history layer for Back, beforeunload only for the tab", () => {
    expect(LEAVE_UPLOADS_CONFIRM.message).toBe("Uploads in progress. Leave and cancel them?");
    const app = source("App.tsx");
    expect(app).toContain("appConfirm.ask(LEAVE_UPLOADS_CONFIRM)");
    expect(app).toContain("useLeaveGuard(noteUploads > 0 && uploadLeaveMove === null");
    expect(app).toContain('window.addEventListener("beforeunload", onUnload)');
    expect(app).toContain("onUploadsChange={setNoteUploads} uploadControl={noteUploadControl}");
    // Every in-app way out asks first: another note, another folder, a new note, another section.
    for (const name of ["createNote", "selectNote", "selectFolder", "leaveNotes"]) {
      const body = app.slice(app.indexOf(`async function ${name}(`), app.indexOf(`async function ${name}(`) + 700);
      expect({ name, asks: body.includes("if (!await confirmLeaveUploads()) return") }).toEqual({ name, asks: true });
    }
    expect(app).not.toMatch(/window\.confirm\(/);
  });
});

describe("the removal toast's Undo", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("relinkToHost posts the host, the file, and only a real part", async () => {
    const calls: Array<{ url: string; body: unknown; method?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), method: init?.method });
      return new Response(JSON.stringify({ relinked: true, restored: true }), { status: 200 });
    }) as typeof fetch;
    expect(await relinkToHost("event", "e1", "d1")).toEqual({ relinked: true, restored: true });
    await relinkToHost("card", "c1", "d2", { partId: "comment-1" });
    await relinkToHost("row", "r1", "d3", { partId: null });
    expect(calls).toEqual([
      { url: "/api/attachments/relink", method: "POST", body: { hostKind: "event", hostId: "e1", documentId: "d1" } },
      { url: "/api/attachments/relink", method: "POST", body: { hostKind: "card", hostId: "c1", documentId: "d2", partId: "comment-1" } },
      { url: "/api/attachments/relink", method: "POST", body: { hostKind: "row", hostId: "r1", documentId: "d3" } }
    ]);
  });

  test("Undo runs the relink, then says it is back, or why not; no Undo without one", async () => {
    const shown: Array<{ kind: string; message: string; action?: { label: string; onClick: () => void } }> = [];
    const sink = {
      success: (message: string, options?: { action?: { label: string; onClick: () => void } }) => { shown.push({ kind: "success", message, action: options?.action }); },
      error: (message: string) => { shown.push({ kind: "error", message }); }
    };
    let ran = 0;
    notifyRemoved("Removed a.txt", async () => { ran += 1; }, sink);
    expect(shown[0]).toMatchObject({ kind: "success", message: "Removed a.txt", action: { label: "Undo" } });
    shown[0]!.action!.onClick();
    await Bun.sleep(0);
    expect(ran).toBe(1);
    expect(shown[1]).toEqual({ kind: "success", message: "File put back", action: undefined });

    notifyRemoved("Removed b.txt", async () => { throw new Error("This file is in its owner's Bin. Only they can restore it."); }, sink);
    shown[2]!.action!.onClick();
    await Bun.sleep(0);
    expect(shown[3]).toEqual({ kind: "error", message: "This file is in its owner's Bin. Only they can restore it." });

    notifyRemoved("Removed c.txt", null, sink);
    expect(shown[4]).toEqual({ kind: "success", message: "Removed c.txt", action: undefined });
  });

  test("events, cards, and rows offer Undo through the one route; a file in someone else's Bin gets none", () => {
    const event = source("calendar/EventAttachments.tsx");
    expect(event).toContain('relinkToHost("event", eventId, item.documentId)');
    expect(event).toContain("const undoable = canEdit && !item.removed && (!result.documentBinned || item.isOwner);");
    const card = source("tasks/CardDialog.tsx");
    expect(card).toContain('relinkToHost("card", cardId, attachment.document_id, { partId: attachment.comment_id })');
    expect(card).toContain("const undoable = !readOnly && !attachment.removed && (!movedToBin || attachment.linked_by === userId);");
    const row = source("collections/Attachments.tsx");
    expect(row).toContain('relinkToHost("row", rowId, item.documentId, { partId: field.id })');
    expect(row).toContain("const undoable = !item.removed && (!result.documentBinned || owned.has(item.documentId));");
    // The event sheet stages removals until Save: its Undo takes the staged removal back.
    expect(source("calendar/CalendarApp.tsx")).toContain("removed: state.removed.filter((id) => id !== item.documentId)");
    // Notes put the file back in the draft (links follow on publish); nothing calls the server.
    const editor = source("editor/NoteEditor.tsx");
    expect(editor).toContain("restoreDraftFiles(activeEditor.state, removal.items)");
    expect(editor).not.toContain("relinkToHost");
    // Chat: removing a picture from the composer unlinks nothing stored (it was never linked).
    expect(source("chat/ComposerImages.tsx")).not.toContain("unlinkFromHost");
  });
});
