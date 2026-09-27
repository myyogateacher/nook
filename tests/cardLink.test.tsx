import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cardPermalink, copyCardLink, copyText, CopyCardLinkButton } from "../src/tasks/cardLink";
import { MoveCardSheet } from "../src/tasks/MoveCardSheet";
import type { BoardColumn, CardSummary } from "../src/tasks/tasksApi";

// Operator request: "Copy link" on the card header (dialog and full page) and in the lane card's ⋯
// sheet copies the card's permalink, without the board's view or filter query.
const board = "0b8f1c2e-5d4a-4e6b-9c3d-1a2b3c4d5e6f";
const card = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const noop = () => undefined;

test("the permalink is the canonical card route on this origin, with no query", () => {
  expect(cardPermalink(board, card, "https://nook.example")).toBe(`https://nook.example/tasks/${board}/card/${card}`);
  expect(cardPermalink(board.toUpperCase(), card.toUpperCase(), "https://nook.example")).toBe(`https://nook.example/tasks/${board}/card/${card}`);
});

test("copyText uses the Clipboard API, falls back to a textarea and execCommand, and reports failure", async () => {
  const written: string[] = [];
  expect(await copyText("a", { clipboard: { writeText: async (text) => { written.push(text); } } })).toBe(true);
  expect(written).toEqual(["a"]);

  const appended: Array<{ value: string; removed: boolean }> = [];
  const fakeDocument = (copies: boolean) => ({
    activeElement: null,
    body: { appendChild: (node: { value: string; removed: boolean }) => { appended.push(node); return node; } },
    createElement: () => {
      const node = { value: "", removed: false, style: {} as Record<string, string>, setAttribute: noop, select: noop, remove() { node.removed = true; } };
      return node;
    },
    execCommand: (command: string) => copies && command === "copy"
  }) as unknown as Document;
  const refused = { writeText: async () => { throw new Error("NotAllowedError"); } };
  expect(await copyText("b", { clipboard: refused, document: fakeDocument(true) })).toBe(true);
  expect(appended.at(-1)).toMatchObject({ value: "b", removed: true });
  expect(await copyText("c", { clipboard: undefined, document: fakeDocument(false) })).toBe(false);
  expect(appended.at(-1)?.removed).toBe(true);
  expect(await copyText("d", { clipboard: undefined, document: undefined })).toBe(false);
});

test("copyCardLink says Link copied, or shows the link to select by hand", async () => {
  // Server-side test run: give the permalink an origin for the call, then put window back.
  const host = globalThis as { window?: unknown };
  const saved = host.window;
  host.window = { location: { origin: "https://nook.example" } };
  const origin = "https://nook.example";
  const calls: unknown[][] = [];
  const notify = (...args: unknown[]) => { calls.push(args); };
  let copied = "";
  await copyCardLink(board, card, notify, async (text) => { copied = text; return true; });
  expect(copied).toBe(`${origin}/tasks/${board}/card/${card}`);
  expect(calls.at(-1)).toEqual(["Link copied"]);
  await copyCardLink(board, card, notify, async () => false);
  expect(calls.at(-1)).toEqual([`Could not copy — here is the link: ${origin}/tasks/${board}/card/${card}`, undefined, { selectable: true }]);
  if (saved === undefined) delete host.window;
  else host.window = saved;
});

test("the header button and the ⋯ sheet offer Copy link", () => {
  const button = renderToStaticMarkup(<CopyCardLinkButton boardId={board} cardId={card} notify={noop} />);
  expect(button).toContain('aria-label="Copy link to this card"');
  expect(button).toContain('title="Copy link"');
  expect(button).toContain("lucide-link");

  const column = { id: "c1", board_id: board, name: "To do", position: 1, is_done: 0, wip_limit: null, created_at: "", updated_at: "" } as unknown as BoardColumn;
  const summary = { id: card, board_id: board, column_id: "c1", title: "Ship it" } as unknown as CardSummary;
  const sheet = (onCopyLink?: () => void) => renderToStaticMarkup(<MoveCardSheet card={summary} columns={[column]} onMove={async () => undefined} onCancel={noop} onCopyLink={onCopyLink} />);
  expect(sheet(noop)).toContain("Copy link<small>A link to this card</small>");
  expect(sheet()).not.toContain("Copy link");
});
