import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Image from "@tiptap/extension-image";
import { isNoteImageSrc } from "./imageUpload";
import { NoteTable } from "./tableMarkdown";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { WhiteboardEmbed } from "./whiteboardEmbed";

// Options for the marked lexer used by @tiptap/markdown. GFM enables pipe tables and task lists.
export const markdownOptions = { gfm: true, breaks: false };

// The extensions that define the note schema and its Markdown. Kept free of UI-only extensions
// (placeholder, slash menu, upload handlers) so tests can drive the serializer without a DOM.
export function noteContentExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ link: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Only this app's file URLs are kept (isNoteImageSrc); pasted HTML or loaded Markdown pointing
    // elsewhere, or at a data: URL, is dropped instead of parsed into a node.
    Image.extend({
      parseHTML: () => [{ tag: 'img[src^="/api/files/"]', getAttrs: (element) => isNoteImageSrc(element.getAttribute("src")) ? null : false }],
      parseMarkdown: (token, helpers) => {
        if (isNoteImageSrc(token.href)) return helpers.createNode("image", { src: token.href, title: token.title, alt: token.text });
        // Without child tokens the fallback parser has nothing to turn into alt text either.
        delete token.tokens;
        return [];
      }
    }).configure({ inline: false, allowBase64: false, HTMLAttributes: { class: "note-image", loading: "lazy" } }),
    // Column widths have no pipe-table syntax, so resizing is off; the wrapper scrolls on narrow screens.
    NoteTable.configure({ resizable: false, renderWrapper: true, HTMLAttributes: { class: "note-table" } }),
    TableRow,
    TableHeader,
    TableCell,
    // A whiteboard card (D208): `[Name](/whiteboards/<uuid> "whiteboard")` alone in its paragraph.
    WhiteboardEmbed
  ];
}
