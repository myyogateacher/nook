import { useEffect, useState } from "react";
import { Extension, Node, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Lock, PenTool } from "lucide-react";
import { getWhiteboardSummary, thumbnailUrl, type WhiteboardCardSummary } from "../whiteboards/whiteboardsApi";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";

/**
 * A whiteboard shown as a card in a note (Wave 24, D208). The Markdown is an ordinary link alone in
 * its paragraph, `[Name](/whiteboards/<uuid> "whiteboard")`: the title is the marker, so it survives
 * round trips and reads as a plain link anywhere else. Published notes and note versions keep this
 * reference, never a copy of the board.
 *
 * The card asks the server as the reader (`GET /api/whiteboards/:id/summary`): someone who can read
 * the board sees its thumbnail (same origin), its current name, and Open; anyone else sees
 * "Whiteboard unavailable" and nothing about the board, not even the name in the Markdown (D73).
 * No iframe. Open is an in-app navigation, a history entry of its own, so Back returns to the note.
 */

export const WHITEBOARD_EMBED_TITLE = "whiteboard";
/** Asks the app shell to open an in-app path (the board) as a new history entry. */
export const OPEN_PATH_EVENT = "nook:open-path";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** One embed line: the link alone on its line (trailing spaces allowed). */
const embedLine = new RegExp(`^\\[((?:[^\\]\\\\\\n]|\\\\.)*)\\]\\(/whiteboards/(${uuid}) "${WHITEBOARD_EMBED_TITLE}"\\)[ \\t]*(?:\\n+|$)`);
const embedLineAnywhere = new RegExp(`^\\[(?:[^\\]\\\\\\n]|\\\\.)*\\]\\(/whiteboards/${uuid} "${WHITEBOARD_EMBED_TITLE}"\\)[ \\t]*$`, "m");

/** The name as the Markdown link text: brackets and backslashes escaped, one line, at most 200 characters. */
export const embedLinkText = (name: string) => [...name.replace(/[\r\n\t]+/g, " ").trim()].slice(0, 200).join("").replace(/[\\[\]]/g, "\\$&") || "Whiteboard";
export const embedMarkdown = (id: string, name: string) => `[${embedLinkText(name)}](/whiteboards/${id} "${WHITEBOARD_EMBED_TITLE}")`;

/** Parses one embed line (pure; exported for tests). */
export function parseEmbedLine(src: string): { raw: string; id: string; name: string } | null {
  const match = embedLine.exec(src);
  if (!match) return null;
  return { raw: match[0], id: match[2]!.toLowerCase(), name: match[1]!.replace(/\\(.)/g, "$1") };
}

/**
 * A pasted board link of THIS instance (full URL or path), alone: the board's id, else null. A link
 * to another site is never turned into a card.
 */
export function pastedBoardId(text: string, origin: string): string | null {
  const trimmed = text.trim();
  const path = trimmed.startsWith(`${origin}/`) ? trimmed.slice(origin.length) : trimmed;
  const match = new RegExp(`^/whiteboards/(${uuid})/?$`, "i").exec(path);
  return match ? match[1]!.toLowerCase() : null;
}

/** Card summaries, shared by every card on screen and kept briefly (a note can show one board twice). */
const summaries = new Map<string, { at: number; value: Promise<WhiteboardCardSummary | null> }>();
const SUMMARY_TTL_MS = 30_000;
export function cardSummary(id: string) {
  const cached = summaries.get(id);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;
  const value = getWhiteboardSummary(id).then((result) => result.whiteboard, () => null);
  if (summaries.size > 200) summaries.clear();
  summaries.set(id, { at: Date.now(), value });
  return value;
}

/**
 * Review L3: forgets every card summary. Called at sign-out and sign-in (the app does not reload),
 * so the next person on this tab never sees a board name the previous one could read.
 */
export function clearCardSummaries() {
  summaries.clear();
}

function WhiteboardEmbedCard({ node, selected }: NodeViewProps) {
  const id = String(node.attrs.id ?? "");
  const [state, setState] = useState<{ id: string; board: WhiteboardCardSummary | null } | null>(null);
  useEffect(() => {
    let live = true;
    void cardSummary(id).then((board) => { if (live) setState({ id, board }); });
    return () => { live = false; };
  }, [id]);
  const board = state?.id === id ? state.board : undefined;
  const open = () => window.dispatchEvent(new CustomEvent(OPEN_PATH_EVENT, { detail: { path: `/whiteboards/${id}` } }));
  return <NodeViewWrapper className={`whiteboard-embed${selected ? " is-selected" : ""}`} data-whiteboard-embed="">
    <div className="whiteboard-embed-card" contentEditable={false}>
      {board === undefined && <span className="whiteboard-embed-thumb" aria-hidden="true"><PenTool /></span>}
      {board === null && <>
        <span className="whiteboard-embed-thumb unavailable" aria-hidden="true"><Lock /></span>
        <span className="whiteboard-embed-copy"><strong>Whiteboard unavailable</strong><small>It was deleted, or it is not shared with you.</small></span>
      </>}
      {board === undefined && <span className="whiteboard-embed-copy" role="status"><strong>Loading whiteboard…</strong></span>}
      {board && <>
        <span className="whiteboard-embed-thumb">{board.hasThumbnail ? <img src={thumbnailUrl(board)} alt="" loading="lazy" draggable={false} /> : <PenTool aria-hidden="true" />}</span>
        <span className="whiteboard-embed-copy">
          <strong title={whiteboardDisplayName(board.name)}>{whiteboardDisplayName(board.name)}</strong>
          <small>Whiteboard{board.is_owner === 0 ? ` · ${board.owner_name}` : ""}</small>
        </span>
        <button type="button" className="secondary-button whiteboard-embed-open" onClick={open} onMouseDown={(event) => event.preventDefault()}>Open</button>
      </>}
    </div>
  </NodeViewWrapper>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    whiteboardEmbed: {
      /** Inserts a whiteboard card at the selection. */
      insertWhiteboardEmbed: (attrs: { id: string; name: string }) => ReturnType;
    };
    whiteboardEmbedPicker: {
      /** Opens the note's "Embed a whiteboard" picker (the editor's host shows it). */
      openWhiteboardPicker: () => ReturnType;
    };
  }
}

/** The node: schema, Markdown, and the card. Part of the note schema (extensions.ts). */
export const WhiteboardEmbed = Node.create({
  name: "whiteboardEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (element) => element.getAttribute("data-id"), renderHTML: (attrs) => ({ "data-id": attrs.id }) },
      name: { default: "Whiteboard", parseHTML: (element) => element.getAttribute("data-name") ?? "Whiteboard", renderHTML: (attrs) => ({ "data-name": attrs.name }) }
    };
  },
  parseHTML() {
    return [{ tag: "div[data-whiteboard-embed]", getAttrs: (element) => new RegExp(`^${uuid}$`).test((element as HTMLElement).getAttribute("data-id") ?? "") ? null : false }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-whiteboard-embed": "", class: "whiteboard-embed" }, String(HTMLAttributes["data-name"] ?? "Whiteboard")];
  },
  markdownTokenizer: {
    name: "whiteboardEmbed",
    level: "block",
    start: (src: string) => src.search(embedLineAnywhere),
    tokenize: (src: string) => {
      const parsed = parseEmbedLine(src);
      return parsed ? { type: "whiteboardEmbed", raw: parsed.raw, id: parsed.id, name: parsed.name } : undefined;
    }
  },
  parseMarkdown: (token, helpers) => helpers.createNode("whiteboardEmbed", { id: (token as { id?: string }).id, name: (token as { name?: string }).name }),
  renderMarkdown: (node) => typeof node.attrs?.id === "string" ? embedMarkdown(node.attrs.id, String(node.attrs.name ?? "Whiteboard")) : "",
  addCommands() {
    return {
      insertWhiteboardEmbed: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs: { id: attrs.id, name: whiteboardDisplayName(attrs.name) } })
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(WhiteboardEmbedCard);
  }
});

/**
 * The editing side (NoteEditor only): the slash item's picker and the paste rule. Pasting this
 * instance's board link alone becomes a card named as the pasting person sees the board (or plain
 * "Whiteboard" when they cannot read it, which never reveals a name).
 */
export const WhiteboardEmbedPicker = Extension.create<{ onOpenPicker: (editor: Editor) => void }>({
  name: "whiteboardEmbedPicker",
  addOptions() {
    return { onOpenPicker: () => undefined };
  },
  addCommands() {
    return {
      openWhiteboardPicker: () => ({ editor }) => {
        this.options.onOpenPicker(editor);
        return true;
      }
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("whiteboardEmbedPaste"),
        props: {
          handlePaste: (_view, event) => {
            if (!editor.isEditable) return false;
            const id = pastedBoardId(event.clipboardData?.getData("text/plain") ?? "", window.location.origin);
            if (!id) return false;
            event.preventDefault();
            void cardSummary(id).then((board) => {
              if (!editor.isDestroyed && editor.isEditable) editor.chain().focus().insertWhiteboardEmbed({ id, name: board ? board.name : "Whiteboard" }).run();
            });
            return true;
          }
        }
      })
    ];
  }
});
