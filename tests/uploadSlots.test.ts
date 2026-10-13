import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { markdownOptions, noteContentExtensions } from "../src/editor/extensions";
import { fillSlot, pendingSlotCount, releaseSlot, reserveSlots, slotPositions, storedFileNode, uploadSlotsPlugin } from "../src/editor/uploadSlots";
import { imageContentUrl } from "../src/editor/imageUpload";

/**
 * v0.35.0 QA (HIGH): pasting or dropping several files into a note kept only the last one, since
 * each was inserted at the selection and the one before it was the selection. Each file now gets an
 * upload slot when chosen and is inserted at it. Checked on the editor state (no DOM in unit tests).
 */

const schema = getSchema(noteContentExtensions());
const ids = Array.from({ length: 6 }, (_, index) => `0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d1${index}`);
const doc = (id: string, name: string, image = false) => ({ id, name, mime_type: image ? "image/png" : "text/plain", preview_kind: image ? "image" : "text" });
const fileNode = (index: number) => storedFileNode(schema, doc(ids[index]!, `file-${index}.txt`))!;
const imageNode = (index: number) => storedFileNode(schema, doc(ids[index]!, `photo-${index}.png`, true))!;

function start(text = "Hello world") {
  const state = EditorState.create({
    schema,
    doc: schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]),
    plugins: [uploadSlotsPlugin()]
  });
  return { state };
}
const apply = (box: { state: EditorState }, tr: Transaction | null) => {
  expect(tr).not.toBeNull();
  box.state = box.state.apply(tr!);
};
const reserve = (box: { state: EditorState }, names: string[], pos?: number) => {
  const { tr, ids: slots } = reserveSlots(box.state, names, pos);
  apply(box, tr);
  return slots;
};
const fill = (box: { state: EditorState }, slot: string, node = fileNode(0)) => apply(box, fillSlot(box.state, slot, node));
/** The note's blocks, in order: paragraph text, or the file card or image id. */
const blocks = (state: EditorState) => {
  const out: string[] = [];
  state.doc.forEach((node) => {
    if (node.type.name === "paragraph") out.push(`p:${node.textContent}`);
    else if (node.type.name === "fileChip") out.push(`file:${ids.indexOf(node.attrs.id)}`);
    else if (node.type.name === "image") out.push(`image:${ids.findIndex((id) => node.attrs.src === imageContentUrl(id))}`);
    else out.push(node.type.name);
  });
  return out;
};
const markdown = (state: EditorState) => new MarkdownManager({ extensions: noteContentExtensions(), markedOptions: markdownOptions }).serialize(state.doc.toJSON()).trim();

describe("upload slots", () => {
  test("a paste of three files keeps all three, in the order chosen", () => {
    const box = start();
    box.state = box.state.apply(box.state.tr.setSelection(TextSelection.create(box.state.doc, box.state.doc.content.size - 1)));
    const slots = reserve(box, ["a.txt", "b.txt", "c.txt"]);
    expect(pendingSlotCount(box.state)).toBe(3);
    slots.forEach((slot, index) => fill(box, slot, fileNode(index)));
    expect(blocks(box.state)).toEqual(["p:Hello world", "file:0", "file:1", "file:2", "p:"]);
    expect(pendingSlotCount(box.state)).toBe(0);
    // The cursor moved past the last file, so typing goes after the files.
    expect(box.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(box.state.selection.from).toBe(box.state.doc.content.size - 1);
  });

  test("uploads that finish out of order still land in the order chosen", () => {
    const box = start();
    const slots = reserve(box, ["a", "b", "c"], box.state.doc.content.size - 1);
    fill(box, slots[2]!, fileNode(2));
    fill(box, slots[0]!, fileNode(0));
    fill(box, slots[1]!, fileNode(1));
    expect(blocks(box.state)).toEqual(["p:Hello world", "file:0", "file:1", "file:2", "p:"]);
  });

  test("mixed images and files, pasted mid-paragraph, split it around them", () => {
    const box = start();
    const slots = reserve(box, ["p.png", "f.txt", "q.png"], 1 + "Hello".length);
    fill(box, slots[1]!, fileNode(1));
    fill(box, slots[0]!, imageNode(0));
    fill(box, slots[2]!, imageNode(2));
    expect(blocks(box.state)).toEqual(["p:Hello", "image:0", "file:1", "image:2", "p: world"]);
    const saved = markdown(box.state);
    expect(saved.indexOf(ids[0]!)).toBeLessThan(saved.indexOf(ids[1]!));
    expect(saved.indexOf(ids[1]!)).toBeLessThan(saved.indexOf(ids[2]!));
  });

  test("two drops at once each keep their files, in their own order", () => {
    const box = start("");
    box.state = box.state.apply(box.state.tr.insert(box.state.doc.content.size, schema.node("paragraph", null, [schema.text("Second")])));
    // The first drop lands on the empty first line, the second at the end of "Second".
    const first = reserve(box, ["a", "b"], 1);
    const second = reserve(box, ["c", "d"], box.state.doc.content.size - 1);
    // Both batches upload at the same time; the fills interleave.
    fill(box, second[0]!, fileNode(2));
    fill(box, first[1]!, fileNode(1));
    fill(box, second[1]!, fileNode(3));
    fill(box, first[0]!, fileNode(0));
    expect(blocks(box.state)).toEqual(["file:0", "file:1", "p:", "p:Second", "file:2", "file:3", "p:"]);
  });

  test("two drops at the same place keep the first drop's files first", () => {
    const box = start();
    const end = box.state.doc.content.size - 1;
    const first = reserve(box, ["a", "b"], end);
    const second = reserve(box, ["c"], end);
    fill(box, second[0]!, fileNode(2));
    fill(box, first[1]!, fileNode(1));
    fill(box, first[0]!, fileNode(0));
    expect(blocks(box.state)).toEqual(["p:Hello world", "file:0", "file:1", "file:2", "p:"]);
  });

  test("typing while files upload moves the slots with the text, and the cursor stays put", () => {
    const box = start();
    const slots = reserve(box, ["a", "b"], box.state.doc.content.size - 1);
    box.state = box.state.apply(box.state.tr.setSelection(TextSelection.create(box.state.doc, 1)));
    box.state = box.state.apply(box.state.tr.insertText("Oh, "));
    fill(box, slots[0]!, fileNode(0));
    fill(box, slots[1]!, fileNode(1));
    expect(blocks(box.state)).toEqual(["p:Oh, Hello world", "file:0", "file:1"]);
    expect(box.state.selection.from).toBe(1 + "Oh, ".length);
  });

  test("a failed upload releases its slot, and the slot is never part of the saved note", () => {
    const box = start();
    const slots = reserve(box, ["a", "b"], box.state.doc.content.size - 1);
    expect(markdown(box.state)).toBe("Hello world");
    apply(box, releaseSlot(box.state, slots[0]!));
    expect(slotPositions(box.state).map((slot) => slot.id)).toEqual([slots[1]!]);
    expect(fillSlot(box.state, slots[0]!, fileNode(0))).toBeNull();
    fill(box, slots[1]!, fileNode(1));
    expect(blocks(box.state)).toEqual(["p:Hello world", "file:1", "p:"]);
    expect(releaseSlot(box.state, slots[1]!)).toBeNull();
  });

  test("the note editor reserves slots for paste, drop, and picks, and counts them against the limit", () => {
    const editor = readFileSync(join(import.meta.dir, "..", "src", "editor", "NoteEditor.tsx"), "utf8");
    expect(editor).toContain("UploadSlots,");
    expect(editor).toContain("noteFileRoom(activeEditor) - pendingSlotCount(activeEditor.state)");
    expect(editor.match(/reserve\(activeEditor, /g)?.length).toBeGreaterThanOrEqual(3);
    expect(editor).not.toContain(".setImage(");
    expect(editor).not.toContain(".insertFileChip(");
  });
});
