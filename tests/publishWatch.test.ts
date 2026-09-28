import { expect, test } from "bun:test";
import { publishedElsewhere, type WatchedNote } from "../src/editor/publishWatch";

/** Friction 7: the open editor notices an Inbox approval that published the agent's draft. */

const open: WatchedNote = { id: "n1", current_version: 1, hasDraft: true, draftMcpKeyName: "Weekly agent" };
const published: WatchedNote = { id: "n1", current_version: 2, hasDraft: false, draftMcpKeyName: null };

test("a draft published elsewhere refreshes the editor with the key's name", () => {
  expect(publishedElsewhere(open, published, false)).toEqual({ refresh: true, toast: "Published by Weekly agent via the Inbox" });
  expect(publishedElsewhere({ ...open, draftMcpKeyName: null }, published, false)).toEqual({ refresh: true, toast: "Published in another window" });
});

test("no refresh over local edits, for another note, or when nothing was published", () => {
  expect(publishedElsewhere(open, published, true)).toEqual({ refresh: false });
  expect(publishedElsewhere(open, { ...published, id: "n2" }, false)).toEqual({ refresh: false });
  expect(publishedElsewhere(open, { ...open }, false)).toEqual({ refresh: false });
  // A new draft on top of a newer version is not "published": the editor keeps its state.
  expect(publishedElsewhere(open, { ...published, hasDraft: true }, false)).toEqual({ refresh: false });
  expect(publishedElsewhere({ ...open, hasDraft: false }, published, false)).toEqual({ refresh: false });
});

test("the app polls the open draft every 30 s and on focus", async () => {
  const source = await Bun.file(new URL("../src/editor/publishWatch.ts", import.meta.url)).text();
  expect(source).toContain("export const PUBLISH_WATCH_MS = 30_000;");
  expect(source).toContain('window.addEventListener("focus", run)');
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  expect(app).toContain("usePublishWatch(note?.isOwner && note.hasDraft ? note.id : null");
});
