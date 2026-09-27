import { useEffect, useRef } from "react";
import type { ChainedCommands, Editor } from "@tiptap/core";
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
import "./editor.css";

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
  /** Shows a short status message (the app toast). */
  onNotice?: (message: string) => void;
  /** Stores a picked, pasted, or dropped image and returns its node; defaults to a Files upload into `folderId`. */
  uploadImage?: (file: File) => Promise<{ src: string; alt: string }>;
  /** Accessible name of the editing surface. */
  label?: string;
  placeholder?: string;
  /** Puts the caret at the end of the content once the editor is created (entering edit mode). */
  autoFocus?: boolean;
};

export function NoteEditor({ markdown, editable, onChange, folderId = null, onNotice, uploadImage, label = "Note content", placeholder = "Start writing… Type / for commands", autoFocus = false }: Props) {
  // The editor is created once, so the upload handler reads the latest props through a ref.
  const latest = useRef({ folderId, onNotice, uploadImage });
  latest.current = { folderId, onNotice, uploadImage };

  const insertImages = async (activeEditor: Editor, files: File[]) => {
    const notice = (message: string) => latest.current.onNotice?.(message);
    for (const file of files) {
      if (!isInsertableImageType(file.type)) {
        notice(IMAGE_REJECTED_MESSAGE);
        continue;
      }
      notice(`Uploading ${file.name || "image"}…`);
      try {
        const image = latest.current.uploadImage ? await latest.current.uploadImage(file) : await uploadNoteImage(file, latest.current.folderId);
        if (activeEditor.isDestroyed || !activeEditor.isEditable) {
          notice("Image saved to Files, but the note is no longer open for editing");
          continue;
        }
        activeEditor.chain().focus().setImage(image).run();
        notice("Image added");
      } catch (reason) {
        notice(reason instanceof Error ? reason.message : "Image upload failed");
      }
    }
  };

  const editor = useEditor({
    extensions: [
      ...noteContentExtensions(),
      Placeholder.configure({ placeholder }),
      Markdown.configure({ markedOptions: markdownOptions }),
      ImageInsert.configure({ onFiles: (activeEditor, files) => { void insertImages(activeEditor, files); } }),
      SlashCommands
    ],
    content: markdown,
    contentType: "markdown",
    editable,
    autofocus: autoFocus && editable ? "end" : false,
    editorProps: {
      attributes: { class: "note-prose", spellcheck: "true", "aria-label": label }
    },
    onUpdate: ({ editor: activeEditor }) => onChange(activeEditor.getMarkdown())
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

  if (!editor) return <div className="editor-skeleton" />;

  return (
    <div className="editor-surface">
      {editable && (
        <BubbleMenu editor={editor} className="bubble-menu">
          <button type="button" className={editor.isActive("bold") ? "active" : ""} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold"><Bold /></button>
          <button type="button" className={editor.isActive("italic") ? "active" : ""} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic"><Italic /></button>
          <button type="button" className={editor.isActive("strike") ? "active" : ""} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label="Strikethrough"><Strikethrough /></button>
          <button type="button" className={editor.isActive("code") ? "active" : ""} onClick={() => editor.chain().focus().toggleCode().run()} aria-label="Inline code"><Code2 /></button>
          <button type="button" onClick={() => {
            const href = window.prompt("Link URL", editor.getAttributes("link").href ?? "https://");
            if (href === null) return;
            if (!href) editor.chain().focus().unsetLink().run();
            else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
          }} aria-label="Add link"><Link2 /></button>
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
    </div>
  );
}

