import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteDeleteConfirm, noteDeleteMessage } from "../src/App";

// Friction 14 (D91): the notes list's trash icon asked with the browser's native confirm. It now
// opens the app's confirm dialog, which Back or Forward closes, and the icon is 44 px on phones.

test("the note delete confirm is the app's dialog, not the browser's", async () => {
  const markup = renderToStaticMarkup(<NoteDeleteConfirm title="Plans" onConfirm={() => undefined} onCancel={() => undefined} />);
  expect(markup).toContain('role="dialog"');
  expect(markup).toContain("Move “Plans” to the Bin? You can restore it for 30 days.");
  expect(markup).toContain("Move to Bin");
  expect(markup).toContain("Cancel");
  expect(noteDeleteMessage("")).toBe("Move “Untitled” to the Bin? You can restore it for 30 days.");
  const source = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  expect(source).not.toContain("window.confirm(`Move “${title}” to the Bin?");
  expect(source).toMatch(/export function NoteDeleteConfirm[^\n]*\n\s+useHistoryDialogGuard\(true, onCancel\);/);
  expect(source).toContain("onClick={(event) => askDeleteNote(item.id, item.title, event.currentTarget)}");
});

test("the trash icon is a 44 px target on phones", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 760px)", css.indexOf(".note-delete-button {")));
  expect(phone).toContain(".note-delete-button { opacity: 1; width: 44px; height: 44px; }");
});
