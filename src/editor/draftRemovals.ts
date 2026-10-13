import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";
import { isNoteImageSrc } from "./imageUpload";
import { uploadSlotsKey } from "./uploadSlots";

/**
 * Undo for taking a file out of a note (uploads everywhere U4 and its Undo): a note's links follow
 * its published content (server/attachments/noteLinks.ts, D408), so removing an image or a file card
 * changes nothing on the server until the next publish. Undo therefore puts the node back in the
 * draft, where it was, and the links follow on publish as for any other edit.
 */

export type DraftRemovalItem = { id: string; node: ProseMirrorNode; pos: number };
/** A file or image the person took out of the draft, kept for the removal toast's Undo. */
export type DraftRemoval = { key: string; items: DraftRemovalItem[] };

const noteImageId = (src: unknown) => isNoteImageSrc(src) ? /\/api\/files\/([0-9a-f-]{36})\//i.exec(src)![1]!.toLowerCase() : null;

/** The files (images and file cards) of a document, with their positions, first occurrence per id. */
export function draftFiles(doc: ProseMirrorNode) {
  const files = new Map<string, { node: ProseMirrorNode; pos: number }>();
  doc.descendants((node, pos) => {
    const id = node.type.name === "image" ? noteImageId(node.attrs.src) : node.type.name === "fileChip" && typeof node.attrs.id === "string" ? node.attrs.id.toLowerCase() : null;
    if (id && !files.has(id)) files.set(id, { node, pos });
    return true;
  });
  return files;
}

/** The name a removal toast shows: the file card's name, or the image's alt text. */
export const fileLabel = (node: ProseMirrorNode) => String(node.type.name === "image" ? node.attrs.alt || "image" : node.attrs.name || "file");

/** "Removed photo.png", or "Removed 3 files". */
export const removalMessage = (items: readonly DraftRemovalItem[]) => items.length === 1 ? `Removed ${fileLabel(items[0]!.node)}` : `Removed ${items.length} files`;

/**
 * The files a person's change took out of the draft (not Undo or Redo, not an upload landing in its
 * slot, not a reload): each one whose id no longer appears anywhere in the note, with its old
 * position mapped into the new document (where Undo puts it back). A file moved within the note (a
 * drag, or cut and paste in one step) is still there, so it is not a removal. `mappings` are the
 * transaction and any appended to it, in order.
 */
export function removedDraftFiles(transaction: Transaction, after: ProseMirrorNode, mappings: readonly Transaction[] = [transaction]): DraftRemovalItem[] {
  if (transaction.getMeta("history$") || transaction.getMeta(uploadSlotsKey) || transaction.getMeta("preventUpdate")) return [];
  const before = draftFiles(transaction.before);
  if (!before.size) return [];
  const still = draftFiles(after);
  const removed: DraftRemovalItem[] = [];
  for (const [id, { node, pos }] of before) {
    if (still.has(id)) continue;
    let mapped = pos;
    for (const tr of mappings) mapped = tr.mapping.map(mapped, -1);
    removed.push({ id, node, pos: mapped });
  }
  return removed;
}

/** Keeps removed files' positions current through a later change (the toast's Undo may come later). */
export function mapDraftRemoval(removal: DraftRemoval, transactions: readonly Transaction[]) {
  for (const item of removal.items) for (const tr of transactions) item.pos = tr.mapping.map(item.pos, -1);
}

/** Puts removed files back at their (mapped) positions, those not already in the note. Null when nothing changes. */
export function restoreDraftFiles(state: EditorState, items: readonly DraftRemovalItem[]) {
  const present = draftFiles(state.doc);
  const missing = items.filter((item) => !present.has(item.id)).sort((a, b) => a.pos - b.pos);
  if (!missing.length) return null;
  const tr = state.tr;
  for (const item of missing) {
    const pos = Math.max(0, Math.min(tr.mapping.map(item.pos, 1), tr.doc.content.size));
    const point = insertPoint(tr.doc, pos, item.node.type);
    if (point === null) tr.replaceRangeWith(pos, pos, item.node);
    else tr.insert(point, item.node);
  }
  return tr;
}

/** How many files Undo would add back (for the 100-file limit). */
export const missingDraftFiles = (state: EditorState, items: readonly DraftRemovalItem[]) => {
  const present = draftFiles(state.doc);
  return items.filter((item) => !present.has(item.id)).length;
};
