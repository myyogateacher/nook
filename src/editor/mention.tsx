import { Extension, Node } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { MarkdownManager } from "@tiptap/markdown";
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { Avatar } from "../ui/Avatar";
import { MentionChip, MentionList } from "../ui/mentions/Mentions";
import { closesOnSpace, firstSelectable, mentionKeyAction, moveSelection } from "../ui/mentions/mentionModel";
import { mentionablePeople, type MentionTarget } from "../ui/mentions/mentionsApi";
import { mentionMarkdown, type MentionCandidate } from "../../shared/itemActivity";

/**
 * @mentions in the rich editor (docs/plan/MENTIONS.md §2, §3, D1320–D1322): the `mention` node, an
 * inline atom whose Markdown is the one mention format, `@[Name](user:<uuid>)`, and the "@" picker.
 *
 * The node is part of the note schema (extensions.ts), so read-only views (a card's description, a
 * published note) draw chips too. The picker (`MentionSuggestion`) is added only by hosts that name the
 * item the text belongs to (`NoteEditor`'s `mentionTarget`): it lists the people who can read it.
 */

/**
 * Marks around a mention (D1337). @tiptap/markdown marks only text nodes when it parses `**…**`, and
 * closes every open mark before a non-text node when it serializes, so `**@Ana**` lost its bold on
 * save. Both directions therefore go through placeholders: a private-use character pair holding an
 * index, which the lexer and the serializer treat as plain text (never escaped, never syntax).
 *
 * - Parse: each mention in the Markdown becomes a placeholder; after parsing, a text node holding one
 *   is split into text and `mention` nodes that keep the text's marks. Inside code (a code mark or a
 *   code block) the placeholder goes back to the literal Markdown.
 * - Serialize: each `mention` node becomes a placeholder text node with the mention's own marks, so
 *   bold, italic, strike, and links wrap it like any text; then the placeholder becomes the Markdown.
 */
type JsonNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type?: string } | string>; content?: JsonNode[] };
const OPEN = "";
const CLOSE = "";
const PLACEHOLDER = /(\d+)/g;
const MENTION_ANYWHERE = /@\[([^\]\n]{1,120})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;
const CODE = new Set(["code", "codeBlock"]);
const isCodeMark = (mark: { type?: string } | string) => CODE.has(typeof mark === "string" ? mark : mark.type ?? "");

export function protectMentions<T>(doc: T): { doc: T; mentions: string[] } {
  const mentions: string[] = [];
  const walk = (node: JsonNode): JsonNode => {
    if (node.type === "mention") {
      const id = node.attrs?.id;
      if (!isUuid(id)) return { type: "text", text: "" };
      mentions.push(mentionMarkdown(String(node.attrs?.label ?? ""), id.toLowerCase()));
      return { type: "text", text: `${OPEN}${mentions.length - 1}${CLOSE}`, ...(node.marks?.length ? { marks: node.marks } : {}) };
    }
    return node.content ? { ...node, content: node.content.map(walk).filter((child) => child.type !== "text" || child.text !== "") } : node;
  };
  if (Array.isArray(doc)) return { doc: (doc as JsonNode[]).map(walk) as T, mentions };
  return { doc: (doc && typeof doc === "object" ? walk(doc as JsonNode) : doc) as T, mentions };
}

export const restoreMentions = (markdown: string, mentions: readonly string[]) =>
  mentions.length ? markdown.replace(PLACEHOLDER, (_whole, index: string) => mentions[Number(index)] ?? "") : markdown;

/** The Markdown with each mention as a placeholder, and the mentions found (parse side). */
export function hideMentions(markdown: string) {
  const found: Array<{ raw: string; id: string; label: string }> = [];
  const text = markdown.replace(MENTION_ANYWHERE, (raw, label: string, id: string) => {
    found.push({ raw, id: id.toLowerCase(), label });
    return `${OPEN}${found.length - 1}${CLOSE}`;
  });
  return { text, found };
}

/** Turns placeholders in parsed JSON back into mention nodes (with the text's marks), or literal text inside code. */
export function revealMentions<T>(doc: T, found: ReadonlyArray<{ raw: string; id: string; label: string }>): T {
  if (!found.length) return doc;
  const walk = (node: JsonNode, inCode: boolean): JsonNode[] => {
    if (node.type === "text" && node.text?.includes(OPEN)) {
      if (inCode || node.marks?.some(isCodeMark)) return [{ ...node, text: node.text.replace(PLACEHOLDER, (_whole, index: string) => found[Number(index)]?.raw ?? "") }];
      const parts: JsonNode[] = [];
      let last = 0;
      for (const match of node.text.matchAll(PLACEHOLDER)) {
        const index = match.index ?? 0;
        if (index > last) parts.push({ ...node, text: node.text.slice(last, index) });
        const mention = found[Number(match[1])];
        if (mention) parts.push({ type: "mention", attrs: { id: mention.id, label: mention.label }, ...(node.marks?.length ? { marks: node.marks } : {}) });
        last = index + match[0].length;
      }
      if (last < node.text.length) parts.push({ ...node, text: node.text.slice(last) });
      return parts;
    }
    // Attributes (a link's href, a code block's text) keep the literal Markdown.
    const attrs = node.attrs && JSON.stringify(node.attrs).includes(OPEN)
      ? JSON.parse(JSON.stringify(node.attrs).replace(PLACEHOLDER, (_whole, index: string) => JSON.stringify(found[Number(index)]?.raw ?? "").slice(1, -1))) as Record<string, unknown>
      : node.attrs;
    const code = inCode || CODE.has(node.type ?? "");
    return [{ ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.flatMap((child) => walk(child, code)) } : {}) }];
  };
  if (Array.isArray(doc)) return (doc as JsonNode[]).flatMap((node) => walk(node, false)) as T;
  return (doc && typeof doc === "object" ? walk(doc as JsonNode, false)[0] : doc) as T;
}

const patched = Symbol.for("nook.mentionMarkdown");
const proto = MarkdownManager.prototype as unknown as { serialize: (doc: unknown) => string; parse: (markdown: string) => unknown; [patched]?: true };
if (!proto[patched]) {
  const serialize = proto.serialize;
  const parse = proto.parse;
  proto.serialize = function (this: unknown, doc: unknown) {
    const { doc: safe, mentions } = protectMentions(doc);
    return restoreMentions(serialize.call(this, safe), mentions);
  };
  proto.parse = function (this: unknown, markdown: string) {
    if (typeof markdown !== "string" || !markdown.includes("@[")) return parse.call(this, markdown);
    const { text, found } = hideMentions(markdown);
    return revealMentions(parse.call(this, text), found);
  };
  proto[patched] = true;
}

const tokenPattern = /^@\[([^\]\n]{1,120})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/;
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Parses one mention at the start of `src` (pure; exported for tests). */
export function parseMentionToken(src: string): { raw: string; id: string; label: string } | null {
  const match = tokenPattern.exec(src);
  return match ? { raw: match[0], label: match[1]!, id: match[2]!.toLowerCase() } : null;
}

function MentionNodeView({ node, editor }: NodeViewProps) {
  const id = String(node.attrs.id ?? "");
  const label = String(node.attrs.label ?? "");
  // While editing, the chip is text (a click places the caret); read-only, it opens the person's profile.
  return <NodeViewWrapper as="span" className="mention-node">
    {editor.isEditable
      ? <span className="mention-chip" data-user-id={id} contentEditable={false}><Avatar className="mention-chip-avatar" name={label} /><span>@{label}</span></span>
      : <MentionChip name={label} userId={id} />}
  </NodeViewWrapper>;
}

export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (element) => element.getAttribute("data-user-id"), renderHTML: (attrs) => ({ "data-user-id": attrs.id }) },
      label: { default: "", parseHTML: (element) => element.getAttribute("data-label") ?? element.textContent?.replace(/^@/, "") ?? "", renderHTML: (attrs) => ({ "data-label": attrs.label }) }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention]", getAttrs: (element) => isUuid((element as HTMLElement).getAttribute("data-user-id")) ? null : false }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ["span", { ...HTMLAttributes, "data-mention": "", class: "mention-chip" }, `@${String(node.attrs.label ?? "")}`];
  },
  renderText: ({ node }) => `@${String(node.attrs.label ?? "")}`,
  markdownTokenizer: {
    name: "mention",
    level: "inline",
    start: (src: string) => src.indexOf("@["),
    tokenize: (src: string) => {
      const parsed = parseMentionToken(src);
      return parsed ? { type: "mention", raw: parsed.raw, id: parsed.id, label: parsed.label } : undefined;
    }
  },
  parseMarkdown: (token, helpers) => helpers.createNode("mention", { id: (token as { id?: string }).id, label: (token as { label?: string }).label }),
  renderMarkdown: (node) => isUuid(node.attrs?.id) ? mentionMarkdown(String(node.attrs?.label ?? ""), String(node.attrs.id).toLowerCase()) : "",
  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView, { as: "span" });
  }
});

type ListProps = { people: MentionCandidate[]; active: number; loading: boolean; noun: string; onPick: (person: MentionCandidate) => void; onActive: (index: number) => void };

/** The list as a component ReactRenderer can update. */
function MentionPopover(props: ListProps) {
  const [id] = useState(() => `mention-list-${Math.random().toString(36).slice(2, 9)}`);
  return <div className="mention-popover-editor"><MentionList id={id} {...props} /></div>;
}

/** The "@" picker for an editor whose text belongs to `target` (D1321, D1322). */
export const MentionSuggestion = Extension.create<{ target: MentionTarget | null; noun: string }>({
  name: "mentionSuggestion",
  addOptions() {
    return { target: null, noun: "item" };
  },
  addProseMirrorPlugins() {
    const { target, noun } = this.options;
    if (!target) return [];
    const pluginKey = new PluginKey("mentionSuggestion");
    return [
      Suggestion<MentionCandidate>({
        editor: this.editor,
        pluginKey,
        char: "@",
        allowSpaces: true,
        allowedPrefixes: [" ", "("],
        // A read-only view (or a note locked for editing) offers no picker.
        allow: ({ editor }) => editor.isEditable,
        debounce: 120,
        items: async ({ query }) => {
          try { return await mentionablePeople(target, query.trim()); } catch { return []; }
        },
        command: ({ editor, range, props }) => {
          if (!props.canRead) return;
          editor.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { id: props.id, label: props.displayName } }, { type: "text", text: " " }]).run();
        },
        render: () => {
          let renderer: ReactRenderer<unknown, ListProps> | null = null;
          let unmount: (() => void) | null = null;
          let current: SuggestionProps<MentionCandidate> | null = null;
          let active = -1;
          const props = (): ListProps => ({
            people: current?.items ?? [], active, loading: current?.loading ?? false, noun,
            onPick: (person) => current?.command(person),
            onActive: (index) => { active = index; renderer?.updateProps(props()); }
          });
          const sync = (next: SuggestionProps<MentionCandidate>) => {
            current = next;
            if (!next.loading && closesOnSpace(next.query, next.items.length)) {
              // Not inside the view's update: a transaction there would be re-entrant.
              queueMicrotask(() => { if (!next.editor.isDestroyed) exitSuggestion(next.editor.view, pluginKey); });
              return;
            }
            if (active < 0 || active >= next.items.length || !next.items[active]?.canRead) active = firstSelectable(next.items);
            renderer?.updateProps(props());
          };
          return {
            onStart(next: SuggestionProps<MentionCandidate>) {
              current = next;
              active = firstSelectable(next.items);
              renderer = new ReactRenderer(MentionPopover, { props: props(), editor: next.editor });
              // Above the card dialog and the app frame (the plugin positions it, absolutely, in <body>).
              (renderer.element as HTMLElement).classList.add("mention-popover-host");
              const element = renderer.element as HTMLElement;
              unmount = next.mount(element, {
                // Kept 12 px inside the viewport's sides (a phone's caret near the left edge).
                onPosition: ({ x, y, strategy }) => {
                  const scrollX = strategy === "absolute" ? window.scrollX : 0;
                  const max = scrollX + window.innerWidth - element.offsetWidth - 12;
                  Object.assign(element.style, { position: strategy, left: `${Math.max(scrollX + 12, Math.min(x, max))}px`, top: `${y}px` });
                }
              });
            },
            onUpdate: sync,
            onKeyDown({ event }: SuggestionKeyDownProps) {
              const action = mentionKeyAction(event.key, { shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
              const people = current?.items ?? [];
              if (action === "close") return true;
              if (action === "down" || action === "up") {
                active = moveSelection(people, active, action === "down" ? 1 : -1);
                renderer?.updateProps(props());
                return true;
              }
              if (action === "pick" && active >= 0 && people[active]) {
                current?.command(people[active]!);
                return true;
              }
              return false;
            },
            onExit() {
              unmount?.();
              renderer?.destroy();
              renderer = null;
              unmount = null;
              current = null;
              active = -1;
            }
          };
        }
      })
    ];
  }
});
