import { Extension, Node } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
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
