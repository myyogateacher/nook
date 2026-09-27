import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// QA 0.9.2: clicking Edit on a card description left focus on the page. Entering edit mode puts
// the caret at the end of the description (Tiptap's `autofocus: "end"` on the editing editor).
// The tests have no DOM, so these guard the wiring; the headless Chrome QA checks the focus itself.
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("the description editor opens with the caret at the end of the content", () => {
  const editor = source("../src/editor/NoteEditor.tsx");
  expect(editor).toContain("autofocus: autoFocus && editable ? \"end\" : false,");
  const dialog = source("../src/tasks/CardDialog.tsx");
  const editing = dialog.slice(dialog.indexOf('<div className="task-description-editor">'), dialog.indexOf('label="Card description"', dialog.indexOf('<div className="task-description-editor">')));
  expect(editing).toContain("autoFocus");
  // The read-only view never takes focus.
  expect(dialog).toMatch(/<NoteEditor key=\{`\$\{card\.id\}:\$\{card\.revision\}`\} markdown=\{card\.description\} editable=\{false\}(?![^>]*autoFocus)/);
});
