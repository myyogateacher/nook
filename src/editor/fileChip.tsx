import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, type LucideIcon } from "lucide-react";

/**
 * A file in a note (uploads everywhere U4, plan D408): a card that opens the file's preview, with
 * Download. The Markdown is an ordinary link alone in its paragraph, `[📎 name](/files/<uuid>)`, so it
 * reads as a link anywhere else (Version history, MCP, an export), and in-app it opens the file in
 * Files. On publish the server links every `/files/<uuid>` the publisher owns to the note
 * (server/attachments/noteLinks.ts), so the note's readers can open it; a file someone else owns
 * opens only for people it is shared with.
 *
 * Opening asks the editor's host to show the preview (FILE_CHIP_OPEN_EVENT, a DOM event that
 * bubbles from the card); the preview is a guarded sheet, so Back closes it (D21).
 */

export const FILE_CHIP_MARKER = "📎";
/** Bubbles from a card to the editor's wrapper: `detail` is `{ id, name }`. */
export const FILE_CHIP_OPEN_EVENT = "nook:file-chip-open";
export type FileChipOpenDetail = { id: string; name: string };

const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const chipLine = new RegExp(`^\\[${FILE_CHIP_MARKER} ((?:[^\\]\\\\\\n]|\\\\.)*)\\]\\(/files/(${uuid})\\)[ \\t]*(?:\\n+|$)`);
const chipLineAnywhere = new RegExp(`^\\[${FILE_CHIP_MARKER} (?:[^\\]\\\\\\n]|\\\\.)*\\]\\(/files/${uuid}\\)[ \\t]*$`, "m");
const isUuid = (value: unknown): value is string => typeof value === "string" && new RegExp(`^${uuid}$`).test(value);

/** A file name as link text: one line, at most 200 characters, `\`, `[`, `]` escaped. */
export function chipName(name: string) {
  return [...name.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()].slice(0, 200).join("") || "file";
}
const escapeName = (name: string) => chipName(name).replace(/([\\[\]])/g, "\\$1");

/** One chip's Markdown. */
export const fileChipMarkdown = (id: string, name: string) => `[${FILE_CHIP_MARKER} ${escapeName(name)}](/files/${id.toLowerCase()})`;

/** Parses one chip line (pure; exported for tests). */
export function parseFileChipLine(src: string): { raw: string; id: string; name: string } | null {
  const match = chipLine.exec(src);
  if (!match) return null;
  return { raw: match[0], id: match[2]!.toLowerCase(), name: match[1]!.replace(/\\(.)/g, "$1") };
}

const ICONS: Array<[RegExp, LucideIcon]> = [
  [/\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/i, FileImage],
  [/\.(pdf|txt|md|markdown|rtf|docx?|odt|pages|log|json)$/i, FileText],
  [/\.(csv|tsv|xlsx?|ods|numbers)$/i, FileSpreadsheet],
  [/\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/i, FileAudio],
  [/\.(mp4|m4v|mov|webm|mkv|avi)$/i, FileVideo],
  [/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i, FileArchive]
];
export const fileChipIcon = (name: string) => ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? File;

function FileChipCard({ node, selected }: NodeViewProps) {
  const id = String(node.attrs.id ?? "");
  const name = String(node.attrs.name ?? "file");
  const Icon = fileChipIcon(name);
  const open = (target: HTMLElement) => target.dispatchEvent(new CustomEvent<FileChipOpenDetail>(FILE_CHIP_OPEN_EVENT, { bubbles: true, detail: { id, name } }));
  return <NodeViewWrapper className={`file-chip${selected ? " is-selected" : ""}`} data-file-chip="">
    <button type="button" className="file-chip-card" contentEditable={false} title={name} aria-label={`Open ${name}`}
      onMouseDown={(event) => event.preventDefault()} onClick={(event) => open(event.currentTarget)}>
      <span className="file-chip-icon" aria-hidden="true"><Icon /></span>
      <span className="file-chip-name">{name}</span>
      <span className="file-chip-open" aria-hidden="true">Open</span>
    </button>
  </NodeViewWrapper>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fileChip: {
      /** Inserts a file card at the selection. */
      insertFileChip: (attrs: { id: string; name: string }) => ReturnType;
    };
  }
}

/** The node: schema, Markdown, and the card. Part of the note schema (extensions.ts). */
export const FileChip = Node.create({
  name: "fileChip",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (element) => element.getAttribute("data-id"), renderHTML: (attrs) => ({ "data-id": attrs.id }) },
      name: { default: "file", parseHTML: (element) => element.getAttribute("data-name") ?? "file", renderHTML: (attrs) => ({ "data-name": attrs.name }) }
    };
  },
  parseHTML() {
    return [{ tag: "div[data-file-chip]", getAttrs: (element) => isUuid((element as HTMLElement).getAttribute("data-id")) ? null : false }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ["div", { ...HTMLAttributes, "data-file-chip": "", class: "file-chip" }, `${FILE_CHIP_MARKER} ${String(node.attrs.name ?? "file")}`];
  },
  markdownTokenizer: {
    name: "fileChip",
    level: "block",
    start: (src: string) => src.search(chipLineAnywhere),
    tokenize: (src: string) => {
      const parsed = parseFileChipLine(src);
      return parsed ? { type: "fileChip", raw: parsed.raw, id: parsed.id, name: parsed.name } : undefined;
    }
  },
  parseMarkdown: (token, helpers) => helpers.createNode("fileChip", { id: (token as { id?: string }).id, name: (token as { name?: string }).name }),
  renderMarkdown: (node) => isUuid(node.attrs?.id) ? fileChipMarkdown(node.attrs.id, String(node.attrs.name ?? "file")) : "",
  addCommands() {
    return {
      insertFileChip: (attrs) => ({ commands }) => isUuid(attrs.id) ? commands.insertContent({ type: this.name, attrs: { id: attrs.id.toLowerCase(), name: chipName(attrs.name) } }) : false
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileChipCard);
  }
});
