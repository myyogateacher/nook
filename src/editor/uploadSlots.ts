import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import type { DocumentSummary } from "../types";
import { chipName } from "./fileChip";
import { imageAltText, imageContentUrl, isInsertableImageType } from "./imageUpload";
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Upload slots (v0.35.0 QA): where a pasted, dropped, or picked file goes while it uploads. Several
 * files used to replace each other: each one was inserted at the selection, and the node inserted
 * before it was the selection. Now every file gets a slot when it is chosen, in the order chosen, and
 * is inserted at its own slot when stored. Slots are positions mapped through every change (never
 * part of the document, so an autosave mid-upload saves nothing of them), shown as an "Uploading…"
 * line. Concurrent drops each get their own slots.
 *
 * Slots sit between blocks: images and file cards are blocks, and a slot inside a paragraph would
 * not keep its order when the paragraph is split. A slot made mid-paragraph splits the paragraph.
 *
 * A slot's line shows the upload's progress (a bar and a percentage, from XHR upload progress) and,
 * when the upload can be stopped, a Cancel button. Cancel asks the editor's host to abort that upload
 * (UPLOAD_SLOT_CANCEL_EVENT, a DOM event that bubbles from the line). Progress updates the line in
 * place, so a focused Cancel keeps focus.
 */

/** Leaving a note while its files are still uploading: the app's own confirm (D91), asked by the note's host. */
export const LEAVE_UPLOADS_CONFIRM = { title: "Leave this note?", message: "Uploads in progress. Leave and cancel them?", confirmLabel: "Leave and cancel", danger: true } as const;

/** Bubbles from a slot's Cancel button to the editor's wrapper: `detail` is `{ id }`. */
export const UPLOAD_SLOT_CANCEL_EVENT = "nook:upload-slot-cancel";
export type UploadSlotCancelDetail = { id: string };

type Slot = {
  id: string;
  pos: number;
  /** Creation order: files at one position stay in the order they were chosen. */
  seq: number;
  label: string;
  /** The cursor follows the inserted files until the person moves it. */
  follow: boolean;
  /** Bytes sent, 0–1; null before the upload starts (waiting for the ones before it) or when unknown. */
  progress: number | null;
  /** Whether the line offers Cancel. */
  cancelable: boolean;
};

type SlotState = { slots: Slot[]; seq: number };

type SlotMeta =
  | { add: { id: string; label: string }[]; pos: number; follow: boolean; cancelable: boolean }
  | { progress: string; value: number }
  | { fill: string; at: number; steps: number }
  | { remove: string };

export const uploadSlotsKey = new PluginKey<SlotState>("uploadSlots");

const slotState = (state: EditorState) => uploadSlotsKey.getState(state) ?? { slots: [], seq: 0 };

/** The block boundary at or next to `pos`; a position mid-paragraph is split there first. */
function blockBoundary(tr: Transaction, pos: number) {
  const $pos = tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)));
  if (!$pos.parent.isTextblock || $pos.depth === 0) return $pos.pos;
  if ($pos.parent.type.spec.code) return $pos.after();
  if ($pos.parentOffset === 0) return $pos.before();
  if ($pos.parentOffset === $pos.parent.content.size) return $pos.after();
  tr.split($pos.pos);
  return $pos.pos + 1;
}

/** The percentage shown on a slot's line ("" before the upload starts). */
export const slotPercent = (slot: Pick<Slot, "progress">) => slot.progress === null ? "" : `${Math.round(slot.progress * 100)}%`;

/**
 * Brings a slot's line up to date (in place, so a focused Cancel keeps focus). The words are announced
 * once (role="status"); the percentage is for the eye, and the bar carries the value for screen readers.
 */
function paintSlot(line: HTMLElement, slot: Slot) {
  const percent = line.querySelector<HTMLElement>(".upload-slot-percent");
  if (percent && percent.textContent !== slotPercent(slot)) percent.textContent = slotPercent(slot);
  const bar = line.querySelector<HTMLProgressElement>("progress");
  if (bar) {
    if (slot.progress === null) bar.removeAttribute("value");
    else bar.value = Math.round(slot.progress * 100);
  }
}

function slotWidget(slot: Slot) {
  return Decoration.widget(slot.pos, () => {
    const line = document.createElement("div");
    line.className = "upload-slot";
    line.dataset.slotId = slot.id;
    line.setAttribute("contenteditable", "false");
    const text = document.createElement("span");
    text.className = "upload-slot-text";
    text.setAttribute("role", "status");
    text.textContent = `Uploading ${slot.label}…`;
    const percent = document.createElement("span");
    percent.className = "upload-slot-percent";
    percent.setAttribute("aria-hidden", "true");
    line.append(text, percent);
    const bar = document.createElement("progress");
    bar.className = "upload-slot-bar";
    bar.max = 100;
    bar.setAttribute("aria-label", `Upload of ${slot.label}`);
    line.append(bar);
    if (slot.cancelable) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "upload-slot-cancel";
      cancel.textContent = "Cancel";
      cancel.setAttribute("aria-label", `Cancel upload of ${slot.label}`);
      // Keep the editor's selection: the button is not part of the document.
      cancel.addEventListener("mousedown", (event) => event.preventDefault());
      cancel.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancel.dispatchEvent(new CustomEvent<UploadSlotCancelDetail>(UPLOAD_SLOT_CANCEL_EVENT, { bubbles: true, detail: { id: slot.id } }));
      });
      line.append(cancel);
    }
    paintSlot(line, slot);
    return line;
  }, { side: slot.seq, key: slot.id, ignoreSelection: true, stopEvent: () => true });
}

export const uploadSlotsPlugin = () => new Plugin<SlotState>({
  key: uploadSlotsKey,
  state: {
    init: () => ({ slots: [], seq: 0 }),
    apply(tr, value) {
      const meta = tr.getMeta(uploadSlotsKey) as SlotMeta | undefined;
      let { slots, seq } = value;
      if (tr.docChanged) {
        // A fill inserts at its slot: slots chosen before it stay before, later ones go after.
        const filled = meta && "fill" in meta ? slots.find((slot) => slot.id === meta.fill) : undefined;
        // A paragraph the fill adds after its node (for the cursor) never moves slots past it.
        const steps = filled && meta && "fill" in meta ? meta.steps : tr.steps.length;
        const own = tr.mapping.slice(0, steps);
        const rest = tr.mapping.slice(steps);
        slots = slots.map((slot) => ({ ...slot, pos: rest.map(own.map(slot.pos, filled && slot.seq < filled.seq ? -1 : 1), -1) }));
      }
      // The person moved the cursor: it stops following the uploads.
      if (tr.selectionSet && !meta) slots = slots.map((slot) => slot.follow ? { ...slot, follow: false } : slot);
      if (meta && "add" in meta) {
        slots = [...slots, ...meta.add.map((item) => ({ id: item.id, label: item.label, pos: meta.pos, seq: seq += 1, follow: meta.follow, progress: null, cancelable: meta.cancelable }))];
      } else if (meta && "progress" in meta) {
        slots = slots.map((slot) => slot.id === meta.progress ? { ...slot, progress: Math.max(0, Math.min(1, meta.value)) } : slot);
      } else if (meta && "fill" in meta) {
        slots = slots.filter((slot) => slot.id !== meta.fill);
      } else if (meta && "remove" in meta) {
        slots = slots.filter((slot) => slot.id !== meta.remove);
      }
      return slots === value.slots && seq === value.seq ? value : { slots, seq };
    }
  },
  props: {
    decorations(state) {
      const { slots } = slotState(state);
      return slots.length ? DecorationSet.create(state.doc, slots.map(slotWidget)) : DecorationSet.empty;
    }
  },
  view: () => ({
    update(view, previous) {
      const { slots } = slotState(view.state);
      if (slots === slotState(previous).slots) return;
      for (const slot of slots) {
        const line = [...view.dom.querySelectorAll<HTMLElement>(".upload-slot")].find((element) => element.dataset.slotId === slot.id);
        if (line) paintSlot(line, slot);
      }
    }
  })
});

/** The note editor's extension: adds the slots plugin. */
export const UploadSlots = Extension.create({
  name: "uploadSlots",
  addProseMirrorPlugins() {
    return [uploadSlotsPlugin()];
  }
});

/** Uploads still waiting for their slot. */
export const pendingSlotCount = (state: EditorState) => slotState(state).slots.length;

/** The slots' positions, in document order then creation order (for tests and the host). */
export const slotPositions = (state: EditorState) => slotState(state).slots
  .slice().sort((a, b) => a.pos - b.pos || a.seq - b.seq).map(({ id, pos }) => ({ id, pos }));

/** One slot as the host and tests see it, or null when it is gone. */
export function slotInfo(state: EditorState, id: string) {
  const slot = slotState(state).slots.find((item) => item.id === id);
  return slot ? { label: slot.label, progress: slot.progress, cancelable: slot.cancelable } : null;
}

/**
 * Reserves one slot per label at `pos` (default: the selection), in order. Returns the transaction to
 * dispatch and the slot ids, in the same order as the labels. `cancelable` slots show Cancel.
 */
export function reserveSlots(state: EditorState, labels: string[], pos = state.selection.to, options: { cancelable?: boolean } = {}) {
  const tr = state.tr;
  const at = blockBoundary(tr, pos);
  const ids = labels.map(() => `slot:${crypto.randomUUID()}`);
  // A split moves the cursor into the second half; it should stay before the files.
  const follow = state.selection.empty;
  if (tr.docChanged && state.selection.empty) tr.setSelection(Selection.near(tr.doc.resolve(at - 1), -1));
  tr.setMeta(uploadSlotsKey, { add: ids.map((id, index) => ({ id, label: labels[index] ?? "file" })), pos: at, follow, cancelable: options.cancelable ?? false } satisfies SlotMeta);
  tr.setMeta("addToHistory", false);
  return { tr, ids };
}

/**
 * The slot's upload progress (0–1), for its line. Null when the slot is gone or the percentage shown
 * would not change (so a fast upload dispatches at most about a hundred of these).
 */
export function slotProgress(state: EditorState, id: string, value: number) {
  const slot = slotState(state).slots.find((item) => item.id === id);
  if (!slot || (slot.progress !== null && Math.round(slot.progress * 100) === Math.round(value * 100))) return null;
  return state.tr.setMeta(uploadSlotsKey, { progress: id, value } satisfies SlotMeta).setMeta("addToHistory", false);
}

/**
 * Inserts `node` at its slot and removes the slot. Returns null when the slot is gone (the note was
 * reloaded, or the slot released). While the cursor follows the uploads, it moves past the node.
 */
export function fillSlot(state: EditorState, id: string, node: ProseMirrorNode) {
  const slot = slotState(state).slots.find((item) => item.id === id);
  if (!slot) return null;
  const tr = state.tr;
  const pos = Math.min(slot.pos, tr.doc.content.size);
  const point = insertPoint(tr.doc, pos, node.type);
  if (point === null) tr.replaceRangeWith(pos, pos, node);
  else tr.insert(point, node);
  const at = point ?? pos;
  tr.setMeta(uploadSlotsKey, { fill: id, at, steps: tr.steps.length } satisfies SlotMeta);
  if (slot.follow) {
    let after = tr.mapping.map(at, 1);
    const $after = tr.doc.resolve(after);
    // The node is the last in its container: a paragraph after it takes the cursor.
    const paragraph = state.schema.nodes.paragraph;
    if (!$after.nodeAfter && paragraph && $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
      tr.insert(after, paragraph.create());
    }
    after = Math.min(after + 1, tr.doc.content.size);
    if (after > tr.selection.head || !tr.selection.empty) tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
  }
  return tr;
}

/** The node for a stored file: an image when the server says it is one, otherwise a file card. */
export function storedFileNode(schema: Schema, document: Pick<DocumentSummary, "id" | "name" | "mime_type" | "preview_kind">) {
  if (document.preview_kind === "image" && isInsertableImageType(document.mime_type) && schema.nodes.image) {
    return schema.nodes.image.create({ src: imageContentUrl(document.id), alt: imageAltText(document.name) });
  }
  return schema.nodes.fileChip?.create({ id: document.id.toLowerCase(), name: chipName(document.name) }) ?? null;
}

/** Removes a slot whose upload failed or was cancelled. */
export function releaseSlot(state: EditorState, id: string) {
  if (!slotState(state).slots.some((slot) => slot.id === id)) return null;
  return state.tr.setMeta(uploadSlotsKey, { remove: id } satisfies SlotMeta).setMeta("addToHistory", false);
}
