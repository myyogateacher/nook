import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChainedCommands, Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import {
  BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Bold, Code2, Grid2x2X, Italic, Link2,
  Strikethrough, TableColumnsSplit, TableRowsSplit, type LucideIcon
} from "lucide-react";
import { SlashCommands } from "./slash";
import { markdownOptions, noteContentExtensions } from "./extensions";
import { ImageInsert } from "./imageInsert";
import { IMAGE_REJECTED_MESSAGE, isInsertableImageType, uploadNoteImage } from "./imageUpload";
import { mapDraftRemoval, missingDraftFiles, removalMessage, removedDraftFiles, restoreDraftFiles, type DraftRemoval } from "./draftRemovals";
import { fillSlot, pendingSlotCount, releaseSlot, reserveSlots, slotProgress, storedFileNode, UPLOAD_SLOT_CANCEL_EVENT, UploadSlots, type UploadSlotCancelDetail } from "./uploadSlots";
import { deleteFile } from "../files/filesApi";
import { FILE_CHIP_OPEN_EVENT, type FileChipOpenDetail } from "./fileChip";
import { NoteAttach, NOTE_FILE_LIMIT_MESSAGE, noteFileRoom } from "./noteAttach";
import { AttachmentPreview, AttachSheet, FromFilesSheet, uploadForHost } from "../ui/attachments";
import type { DocumentSummary } from "../types";
import { NameDialog } from "../files/RenameDialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { isModuleEnabled, useDisabledModules } from "../modules";
import { WhiteboardEmbedPicker } from "./whiteboardEmbed";
import "./editor.css";
import { notify, type NoticeSink, type NotifyKind } from "../ui/notify";

// The "Embed a whiteboard" picker loads only when opened (Wave 24, D208), so notes stay light.
const WhiteboardPicker = lazy(() => import("./WhiteboardPicker"));

const tableActions: { label: string; Icon: LucideIcon; run: (chain: ChainedCommands) => ChainedCommands }[] = [
  { label: "Add row above", Icon: BetweenHorizontalStart, run: (chain) => chain.addRowBefore() },
  { label: "Add row below", Icon: BetweenHorizontalEnd, run: (chain) => chain.addRowAfter() },
  { label: "Add column before", Icon: BetweenVerticalStart, run: (chain) => chain.addColumnBefore() },
  { label: "Add column after", Icon: BetweenVerticalEnd, run: (chain) => chain.addColumnAfter() },
  { label: "Delete row", Icon: TableRowsSplit, run: (chain) => chain.deleteRow() },
  { label: "Delete column", Icon: TableColumnsSplit, run: (chain) => chain.deleteColumn() },
  { label: "Delete table", Icon: Grid2x2X, run: (chain) => chain.deleteTable() }
];

// The table (or its scroll wrapper) around the cursor, used to anchor the table toolbar.
function currentTableElement(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== "table") continue;
    const dom = editor.view.nodeDOM($from.before(depth));
    return dom instanceof HTMLElement ? dom : null;
  }
  return null;
}

type Props = {
  markdown: string;
  editable: boolean;
  onChange: (markdown: string) => void;
  /** Folder that uploaded images are stored in; null uploads to the Default folder. */
  folderId?: string | null;
  /** Shows a short status message: the app toasts (ui/notify.ts), or a module's Notifier. */
  onNotice?: NoticeSink;
  /** Stores a picked, pasted, or dropped image and returns its node; defaults to a Files upload into `folderId`. */
  uploadImage?: (file: File) => Promise<{ src: string; alt: string }>;
  /**
   * "note" (uploads everywhere U4): any file can be added (Take photo, Choose files, From Files, paste,
   * drop, the slash menu's "File" and "From Files"). Uploads go to the person's Attachments folder
   * (`?attachTo=note`); a picture the server sniffs as PNG, JPEG, GIF, or WebP becomes an image, any
   * other file a file card. Without it, only images are added, through `uploadImage` or `folderId`.
   */
  attachHost?: "note";
  /**
   * A Files item (outside the Attachments folder) the person confirmed sharing with the note in the
   * From Files picker: the publish sends it as already confirmed, so they are not asked again (review M1).
   */
  onFileConfirmed?: (documentId: string) => void;
  /** Accessible name of the editing surface. */
  label?: string;
  placeholder?: string;
  /** Puts the caret at the end of the content once the editor is created (entering edit mode). */
  autoFocus?: boolean;
  /** U4: how many attach uploads are in flight (waiting or sending), whenever it changes; 0 on unmount. */
  onUploadsChange?: (count: number) => void;
  /** U4: filled with the editor's upload control, so the host can cancel every upload before leaving. */
  uploadControl?: { current: NoteUploadControl | null };
};

/** What the note's host may do with the editor's uploads (leaving mid-upload). */
export type NoteUploadControl = { count: () => number; cancelAll: () => void };

export function NoteEditor({ markdown, editable, onChange, folderId = null, onNotice, uploadImage, attachHost, onFileConfirmed, label = "Note content", placeholder = "Start writing… Type / for commands", autoFocus = false, onUploadsChange, uploadControl }: Props) {
  // The editor is created once, so the upload handler reads the latest props through a ref.
  const latest = useRef({ folderId, onNotice, uploadImage, attachHost, onFileConfirmed, onUploadsChange });
  latest.current = { folderId, onNotice, uploadImage, attachHost, onFileConfirmed, onUploadsChange };
  // U4: the attach sheet or the From Files picker, for the editor that asked; and the file preview.
  const [attachLayer, setAttachLayer] = useState<{ editor: Editor; what: "sheet" | "files" } | null>(null);
  const [preview, setPreview] = useState<FileChipOpenDetail | null>(null);
  // Attach uploads in flight, by slot: waiting for the ones before them, or sending. Each can be
  // cancelled from its slot's line, and all of them when the person leaves the note.
  const jobs = useRef(new Map<string, { controller: AbortController; editor: Editor }>());
  const reportUploads = () => latest.current.onUploadsChange?.(jobs.current.size);
  const surface = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => {
    for (const job of jobs.current.values()) job.controller.abort();
    jobs.current.clear();
    latest.current.onUploadsChange?.(0);
  }, []);
  // Whiteboard cards (D208): the slash item and the paste rule, only while the module is on.
  const whiteboards = isModuleEnabled(useDisabledModules(), "whiteboards");
  const [boardPicker, setBoardPicker] = useState<Editor | null>(null);

  // v0.35.0 QA: each file gets an upload slot when chosen (uploadSlots.ts) and is inserted there,
  // after the one before it, so several pasted or dropped files no longer replace each other.
  const dispatchSlot = (activeEditor: Editor, tr: Transaction | null) => {
    if (!tr || activeEditor.isDestroyed) return false;
    activeEditor.view.dispatch(tr);
    return true;
  };
  const reserve = (activeEditor: Editor, names: string[], options: { cancelable?: boolean } = {}) => {
    const { tr, ids } = reserveSlots(activeEditor.state, names, activeEditor.state.selection.to, options);
    dispatchSlot(activeEditor, tr);
    return ids;
  };
  const progress = (activeEditor: Editor, slot: string, value: number) => {
    if (!activeEditor.isDestroyed) dispatchSlot(activeEditor, slotProgress(activeEditor.state, slot, value));
  };
  /** Cancel on a slot's line, or leaving the note: stops that upload and takes its line away. */
  const cancelUpload = (slot: string) => {
    const job = jobs.current.get(slot);
    if (!job) return;
    jobs.current.delete(slot);
    job.controller.abort();
    if (!job.editor.isDestroyed) dispatchSlot(job.editor, releaseSlot(job.editor.state, slot));
    reportUploads();
  };
  const cancelRef = useRef(cancelUpload);
  cancelRef.current = cancelUpload;
  useEffect(() => {
    if (!uploadControl) return undefined;
    const control: NoteUploadControl = {
      count: () => jobs.current.size,
      cancelAll: () => { for (const slot of [...jobs.current.keys()]) cancelRef.current(slot); }
    };
    uploadControl.current = control;
    return () => { if (uploadControl.current === control) uploadControl.current = null; };
  }, [uploadControl]);
  const fill = (activeEditor: Editor, slot: string, node: ProseMirrorNode | null) =>
    !activeEditor.isDestroyed && activeEditor.isEditable && node !== null && dispatchSlot(activeEditor, fillSlot(activeEditor.state, slot, node));
  const release = (activeEditor: Editor, slot: string) => {
    if (!activeEditor.isDestroyed) dispatchSlot(activeEditor, releaseSlot(activeEditor.state, slot));
  };

  const insertImages = async (activeEditor: Editor, files: File[]) => {
    const notice = (kind: NotifyKind, message: string, id?: string) => latest.current.onNotice?.[kind](message, id ? { id } : undefined);
    const images = files.filter((file) => isInsertableImageType(file.type));
    if (images.length < files.length) notice("warning", IMAGE_REJECTED_MESSAGE);
    if (activeEditor.isDestroyed || !images.length) return;
    const slots = reserve(activeEditor, images.map((file) => file.name || "image"));
    for (const [index, file] of images.entries()) {
      const slot = slots[index]!;
      // One toast per upload: "Uploading…" turns into the outcome.
      const id = `upload:${crypto.randomUUID()}`;
      notice("info", `Uploading ${file.name || "image"}…`, id);
      try {
        const image = latest.current.uploadImage ? await latest.current.uploadImage(file) : await uploadNoteImage(file, latest.current.folderId);
        if (!fill(activeEditor, slot, activeEditor.isDestroyed ? null : activeEditor.schema.nodes.image?.create(image) ?? null)) {
          notice("warning", "Image saved to Files, but the note is no longer open for editing", id);
          continue;
        }
        notice("success", "Image added", id);
      } catch (reason) {
        notice("error", reason instanceof Error ? reason.message : "Image upload failed", id);
      } finally {
        release(activeEditor, slot);
      }
    }
  };

  /** Inserts a stored document after the selection: an image when the server says it is one, otherwise a file card. */
  const insertDocument = (activeEditor: Editor, document: Pick<DocumentSummary, "id" | "name" | "mime_type" | "preview_kind">) => {
    if (activeEditor.isDestroyed || !activeEditor.isEditable) return false;
    const [slot] = reserve(activeEditor, [document.name]);
    const added = fill(activeEditor, slot!, storedFileNode(activeEditor.schema, document));
    release(activeEditor, slot!);
    if (added) activeEditor.commands.focus();
    return added;
  };

  /** U4: uploads any files to the Attachments folder (`?attachTo=note`) and inserts each once stored. */
  const attachFiles = async (activeEditor: Editor, files: File[]) => {
    const notice = (kind: NotifyKind, message: string, id?: string) => latest.current.onNotice?.[kind](message, id ? { id } : undefined);
    if (activeEditor.isDestroyed) return;
    // Uploads still in flight count against the note's file limit too.
    const room = Math.max(0, noteFileRoom(activeEditor) - pendingSlotCount(activeEditor.state));
    const chosen = files.slice(0, room);
    if (chosen.length < files.length) notice("warning", NOTE_FILE_LIMIT_MESSAGE);
    if (!chosen.length) return;
    const slots = reserve(activeEditor, chosen.map((file) => file.name || "file"), { cancelable: true });
    // Every chosen file is in flight from now (the limit and the leave prompt count it), one upload at a time.
    const queue = chosen.map((file, index) => {
      const controller = new AbortController();
      jobs.current.set(slots[index]!, { controller, editor: activeEditor });
      return { file, slot: slots[index]!, controller };
    });
    reportUploads();
    for (const { file, slot, controller } of queue) {
      if (controller.signal.aborted) continue;
      if (activeEditor.isDestroyed) {
        cancelUpload(slot);
        continue;
      }
      const name = file.name || "file";
      const id = `upload:${crypto.randomUUID()}`;
      notice("info", `Uploading ${name}…`, id);
      progress(activeEditor, slot, 0);
      try {
        const { document } = await uploadForHost(file, "note", { signal: controller.signal, onProgress: (loaded, total) => progress(activeEditor, slot, total ? loaded / total : 0) });
        if (controller.signal.aborted) {
          // Cancelled as the last bytes arrived: the stored copy goes to the Bin instead of the note.
          void deleteFile(document.id).catch(() => undefined);
          notify.dismiss(id);
          continue;
        }
        if (!fill(activeEditor, slot, activeEditor.isDestroyed ? null : storedFileNode(activeEditor.schema, document))) {
          notice("warning", "Saved to Files › Attachments, but the note is no longer open for editing", id);
          continue;
        }
        notice("success", `${document.name} added`, id);
      } catch (reason) {
        if (!controller.signal.aborted) notice("error", reason instanceof Error ? reason.message : "Upload failed", id);
        else notify.dismiss(id);
      } finally {
        if (jobs.current.get(slot)?.controller === controller) {
          jobs.current.delete(slot);
          reportUploads();
        }
        release(activeEditor, slot);
      }
    }
  };

  // U4 Undo: a file or image the person takes out of the draft gets a toast with Undo, which puts it
  // back where it was (links follow the draft on publish, so nothing is unlinked on the server here).
  const removals = useRef<DraftRemoval[]>([]);
  const trackRemovals = (activeEditor: Editor, transaction: Transaction, appended: readonly Transaction[]) => {
    const all = [transaction, ...appended];
    if (!all.some((tr) => tr.docChanged)) return;
    // A reload (the note published, a draft discarded) replaces the document: old positions mean nothing.
    if (transaction.getMeta("preventUpdate")) {
      removals.current = [];
      return;
    }
    for (const removal of removals.current) mapDraftRemoval(removal, all);
    if (latest.current.attachHost !== "note" || !activeEditor.isEditable) return;
    const items = removedDraftFiles(transaction, activeEditor.state.doc, all);
    if (!items.length) return;
    const removal: DraftRemoval = { key: crypto.randomUUID(), items };
    removals.current = [...removals.current.slice(-19), removal];
    latest.current.onNotice?.success(removalMessage(items), { action: { label: "Undo", onClick: () => undoRemoval(activeEditor, removal.key) } });
  };
  const trackRemovalsRef = useRef(trackRemovals);
  trackRemovalsRef.current = trackRemovals;
  const undoRemoval = (activeEditor: Editor, key: string) => {
    const removal = removals.current.find((item) => item.key === key);
    removals.current = removals.current.filter((item) => item.key !== key);
    if (!removal) return;
    if (activeEditor.isDestroyed || !activeEditor.isEditable) {
      latest.current.onNotice?.warning("The note is no longer open for editing");
      return;
    }
    // Uploads still in flight count against the note's file limit too.
    if (missingDraftFiles(activeEditor.state, removal.items) > noteFileRoom(activeEditor) - pendingSlotCount(activeEditor.state)) {
      latest.current.onNotice?.warning(NOTE_FILE_LIMIT_MESSAGE);
      return;
    }
    dispatchSlot(activeEditor, restoreDraftFiles(activeEditor.state, removal.items));
  };

  const editor = useEditor({
    extensions: [
      ...noteContentExtensions(),
      Placeholder.configure({ placeholder }),
      Markdown.configure({ markedOptions: markdownOptions }),
      UploadSlots,
      ImageInsert.configure({ onFiles: (activeEditor, files) => { void (latest.current.attachHost ? attachFiles(activeEditor, files) : insertImages(activeEditor, files)); } }),
      ...(attachHost ? [NoteAttach.configure({ onOpen: (activeEditor: Editor, what: "sheet" | "files") => setAttachLayer({ editor: activeEditor, what }) })] : []),
      ...(whiteboards ? [WhiteboardEmbedPicker.configure({ onOpenPicker: (activeEditor: Editor) => setBoardPicker(activeEditor) })] : []),
      SlashCommands
    ],
    content: markdown,
    contentType: "markdown",
    editable,
    autofocus: autoFocus && editable ? "end" : false,
    editorProps: {
      attributes: { class: "note-prose", spellcheck: "true", "aria-label": label }
    },
    onUpdate: ({ editor: activeEditor }) => onChange(activeEditor.getMarkdown()),
    onTransaction: ({ editor: activeEditor, transaction, appendedTransactions }) => trackRemovalsRef.current(activeEditor, transaction, appendedTransactions)
  });

  useEffect(() => {
    if (!editor) return;
    // Never emit an update here: Tiptap would report its normalised Markdown as a user change.
    editor.setEditable(editable, false);
  }, [editable, editor]);

  useEffect(() => {
    if (!editor || editor.getMarkdown() === markdown) return;
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  }, [editor, markdown]);

  // Add link (D91): the app's own dialog instead of the browser's own prompt; empty removes the link.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const closeLink = useCallback(() => {
    setLinkDraft(null);
    editor?.commands.focus();
  }, [editor]);
  useHistoryDialogGuard(linkDraft !== null, closeLink);

  // A file card asks for its preview (FILE_CHIP_OPEN_EVENT); readers and editors alike.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<FileChipOpenDetail>).detail;
      if (detail?.id) setPreview({ id: detail.id, name: detail.name });
    };
    // An upload slot's Cancel (uploadSlots.ts).
    const onCancel = (event: Event) => {
      const detail = (event as CustomEvent<UploadSlotCancelDetail>).detail;
      if (detail?.id) cancelRef.current(detail.id);
    };
    element.addEventListener(FILE_CHIP_OPEN_EVENT, onOpen);
    element.addEventListener(UPLOAD_SLOT_CANCEL_EVENT, onCancel);
    return () => {
      element.removeEventListener(FILE_CHIP_OPEN_EVENT, onOpen);
      element.removeEventListener(UPLOAD_SLOT_CANCEL_EVENT, onCancel);
    };
  }, [editor]);
  const closeAttach = useCallback((target?: Editor) => {
    setAttachLayer(null);
    if (target && !target.isDestroyed) target.commands.focus();
  }, []);

  if (!editor) return <div className="editor-skeleton" />;

  return (
    <div className="editor-surface" ref={surface}>
      {editable && (
        <BubbleMenu editor={editor} className="bubble-menu">
          <button type="button" className={editor.isActive("bold") ? "active" : ""} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold"><Bold /></button>
          <button type="button" className={editor.isActive("italic") ? "active" : ""} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic"><Italic /></button>
          <button type="button" className={editor.isActive("strike") ? "active" : ""} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label="Strikethrough"><Strikethrough /></button>
          <button type="button" className={editor.isActive("code") ? "active" : ""} onClick={() => editor.chain().focus().toggleCode().run()} aria-label="Inline code"><Code2 /></button>
          <button type="button" onClick={() => setLinkDraft(editor.getAttributes("link").href ?? "https://")} aria-label="Add link" aria-haspopup="dialog"><Link2 /></button>
        </BubbleMenu>
      )}
      {editable && (
        <BubbleMenu
          editor={editor}
          pluginKey="tableMenu"
          className="bubble-menu table-menu"
          shouldShow={({ editor: activeEditor, view }) => activeEditor.isEditable && view.hasFocus() && activeEditor.isActive("table")}
          getReferencedVirtualElement={() => {
            const element = currentTableElement(editor);
            return element ? { getBoundingClientRect: () => element.getBoundingClientRect() } : null;
          }}
          options={{ placement: "top-start", offset: 8 }}
        >
          {tableActions.map(({ label, Icon, run }) => (
            <button key={label} type="button" onClick={() => run(editor.chain().focus()).run()} aria-label={label} title={label}><Icon /></button>
          ))}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {linkDraft !== null && <NameDialog
        title="Link"
        eyebrow="Note"
        label="Link URL"
        initialValue={linkDraft}
        submitLabel="Save link"
        hint="Leave empty to remove the link."
        validate={(value) => ({ ok: true, name: value.trim(), changed: true })}
        onSubmit={(href) => {
          setLinkDraft(null);
          if (!href) editor.chain().focus().unsetLink().run();
          else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
        }}
        onCancel={closeLink}
      />}
      {boardPicker && <Suspense fallback={null}><WhiteboardPicker folderId={latest.current.folderId}
        onClose={() => { setBoardPicker(null); editor.commands.focus(); }}
        onPick={(board) => {
          const target = boardPicker;
          setBoardPicker(null);
          if (!target.isDestroyed && target.isEditable) target.chain().focus().insertWhiteboardEmbed(board).run();
        }} /></Suspense>}
      {attachLayer?.what === "sheet" && <AttachSheet hostNoun="note" closeOnPick
        disabledReason={noteFileRoom(attachLayer.editor) <= 0 ? NOTE_FILE_LIMIT_MESSAGE : null}
        onClose={() => closeAttach(attachLayer.editor)}
        onFiles={(files) => { void attachFiles(attachLayer.editor, files); }}
        onPickDocument={(document, options) => { if (insertDocument(attachLayer.editor, document) && options.confirmed) latest.current.onFileConfirmed?.(document.id); }} />}
      {attachLayer?.what === "files" && <FromFilesSheet hostNoun="note"
        onClose={() => closeAttach(attachLayer.editor)}
        onPick={(document, options) => {
          const target = attachLayer.editor;
          setAttachLayer(null);
          if (noteFileRoom(target) <= 0) latest.current.onNotice?.warning(NOTE_FILE_LIMIT_MESSAGE);
          else if (insertDocument(target, document) && options.confirmed) latest.current.onFileConfirmed?.(document.id);
        }} />}
      {preview && <AttachmentPreview documentId={preview.id} name={preview.name} onClose={() => setPreview(null)} />}
    </div>
  );
}

