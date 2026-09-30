import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";

type Command = {
  label: string;
  hint: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
  /** Offered only when the editor has this command (the Whiteboard item needs the picker, Wave 24). */
  requires?: string;
};

const commands: Command[] = [
  { label: "Text", hint: "Plain paragraph", keywords: "paragraph text", run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run() },
  { label: "Heading 1", hint: "Large heading", keywords: "title h1", run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
  { label: "Heading 2", hint: "Section heading", keywords: "subtitle h2", run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run() },
  { label: "Heading 3", hint: "Small heading", keywords: "h3", run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run() },
  { label: "Bullet list", hint: "Unordered list", keywords: "bullet list unordered", run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { label: "Numbered list", hint: "Ordered list", keywords: "number list ordered", run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { label: "Checklist", hint: "Track tasks", keywords: "todo task check", run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
  { label: "Quote", hint: "Capture a quotation", keywords: "blockquote quote", run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { label: "Code block", hint: "Monospace code", keywords: "code pre", run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
  { label: "Image", hint: "Upload a picture", keywords: "image picture photo upload img", run: (editor, range) => editor.chain().focus().deleteRange(range).openImagePicker().run() },
  { label: "Whiteboard", hint: "Show a whiteboard as a card", keywords: "whiteboard board drawing sketch diagram canvas excalidraw embed", requires: "openWhiteboardPicker", run: (editor, range) => editor.chain().focus().deleteRange(range).openWhiteboardPicker().run() },
  { label: "Table", hint: "3 × 3 grid with a header row", keywords: "table grid columns rows", run: (editor, range) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Divider", hint: "Separate sections", keywords: "rule divider hr", run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
  { label: "Today", hint: "Insert today’s date", keywords: "date today", run: (editor, range) => editor.chain().focus().deleteRange(range).insertContent(new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date())).run() }
];

export const SlashCommands = Extension.create({
  name: "slashCommands",
  addProseMirrorPlugins() {
    return [
      Suggestion<Command>({
        editor: this.editor,
        pluginKey: new PluginKey("slashCommands"),
        char: "/",
        startOfLine: true,
        allowSpaces: true,
        items: ({ query, editor }) => {
          const needle = query.toLowerCase();
          return commands.filter((item) => (!item.requires || item.requires in editor.commands) && `${item.label} ${item.keywords}`.toLowerCase().includes(needle)).slice(0, 16);
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let container: HTMLDivElement | null = null;
          let selected = 0;
          let current: SuggestionProps<Command> | null = null;

          const place = () => {
            if (!container || !current?.clientRect) return;
            const rect = current.clientRect();
            if (!rect) return;
            container.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 292))}px`;
            container.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - container.offsetHeight - 12)}px`;
          };

          const paint = () => {
            if (!container || !current) return;
            container.replaceChildren();
            current.items.forEach((item, index) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = `slash-item${index === selected ? " is-selected" : ""}`;
              const label = document.createElement("span");
              label.textContent = item.label;
              const hint = document.createElement("small");
              hint.textContent = item.hint;
              button.append(label, hint);
              button.addEventListener("mousedown", (event) => {
                event.preventDefault();
                current?.command(item);
              });
              container?.append(button);
              if (index === selected) button.scrollIntoView?.({ block: "nearest" });
            });
            place();
          };

          return {
            onStart(props: SuggestionProps<Command>) {
              current = props;
              selected = 0;
              container = document.createElement("div");
              container.className = "slash-menu";
              container.setAttribute("role", "listbox");
              document.body.append(container);
              paint();
            },
            onUpdate(props: SuggestionProps<Command>) {
              current = props;
              selected = Math.min(selected, Math.max(0, props.items.length - 1));
              paint();
            },
            onKeyDown({ event }: SuggestionKeyDownProps) {
              if (!current?.items.length) return event.key === "Escape";
              if (event.key === "ArrowDown") {
                selected = (selected + 1) % current.items.length;
                paint();
                return true;
              }
              if (event.key === "ArrowUp") {
                selected = (selected - 1 + current.items.length) % current.items.length;
                paint();
                return true;
              }
              if (event.key === "Enter") {
                current.command(current.items[selected]);
                return true;
              }
              return event.key === "Escape";
            },
            onExit() {
              container?.remove();
              container = null;
              current = null;
            }
          };
        }
      })
    ];
  }
});
