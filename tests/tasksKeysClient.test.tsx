import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { cardShortLink, copyCardKey, copyCardLink, CardKeyButton, CopyCardLinkButton } from "../src/tasks/cardLink";
import { defaultTargetColumn, MoveCardSheet, moveTargets } from "../src/tasks/MoveCardSheet";
import { CardFace, cardFaceLabel } from "../src/tasks/CardFace";
import { NewBoardDialog } from "../src/tasks/NewBoardDialog";
import { BoardCodeRow } from "../src/tasks/BoardSettingsSheet";
import { hydrateBoard, type BoardColumn, type BoardPayload, type BoardSummary, type CardSummary } from "../src/tasks/tasksApi";
import { parentTasksRoute } from "../src/tasksRoute";
import { notifier } from "../src/ui/notify";

/** The app side of lane KEYS (docs/plan/TASK_KEYS.md D710–D716): short links, keys on cards, codes, and Move to another board. */
const board = "0b8f1c2e-5d4a-4e6b-9c3d-1a2b3c4d5e6f";
const card = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const noop = () => undefined;

test("/tasks/MYT-12 is a short-link route in upper case; Back from it is the board list; board ids still win", () => {
  const route = parseRoute("/tasks/myt-12");
  expect(route).toEqual({ app: "tasks", boardId: null, cardId: null, cardKey: "MYT-12" });
  expect(formatRoute(route)).toBe("/tasks/MYT-12");
  expect(parseRoute("/tasks/MYT-012")).toEqual({ app: "tasks", boardId: null, cardId: null });
  expect(parseRoute("/tasks/MYT-12/extra")).toEqual({ app: "tasks", boardId: null, cardId: null });
  expect(parseRoute(`/tasks/${board}`)).toMatchObject({ boardId: board, cardId: null });
  expect(parseRoute("/tasks/my")).toMatchObject({ home: { section: "my" } });
  expect(parentTasksRoute(route as Extract<ReturnType<typeof parseRoute>, { app: "tasks" }>)).toEqual({ app: "tasks", boardId: null, cardId: null });
});

test("Copy link copies the short link when the key is known, the permalink otherwise; the key button copies the key", async () => {
  expect(cardShortLink("myt-12", "https://nook.example")).toBe("https://nook.example/tasks/MYT-12");
  expect(cardShortLink(null, "https://nook.example")).toBeNull();
  expect(cardShortLink("not a key", "https://nook.example")).toBeNull();
  const host = globalThis as { window?: unknown };
  const saved = host.window;
  host.window = { location: { origin: "https://nook.example" } };
  const calls: unknown[][] = [];
  const record = (kind: string) => (...args: unknown[]) => { calls.push([kind, ...args]); };
  const notify = Object.assign(record("plain"), { success: record("success"), info: record("info"), warning: record("warning"), error: record("error") });
  let copied = "";
  await copyCardLink(board, card, notify, async (text) => { copied = text; return true; }, "MYT-12");
  expect(copied).toBe("https://nook.example/tasks/MYT-12");
  await copyCardLink(board, card, notify, async (text) => { copied = text; return true; }, null);
  expect(copied).toBe(`https://nook.example/tasks/${board}/card/${card}`);
  await copyCardKey("MYT-12", notify, async (text) => { copied = text; return true; });
  expect([copied, calls.at(-1)]).toEqual(["https://nook.example/tasks/MYT-12", ["success", "Copied link to MYT-12"]]);
  if (saved === undefined) delete host.window;
  else host.window = saved;
  expect(renderToStaticMarkup(<CardKeyButton cardKey="MYT-12" notify={notifier} />)).toContain('aria-label="MYT-12: copy a link to this card"');
  expect(renderToStaticMarkup(<CopyCardLinkButton boardId={board} cardId={card} cardKey="MYT-12" notify={notifier} />)).toContain("Copy link");
});

test("the board payload's cards get their keys from the board's code; the face shows the key and its label reads it", () => {
  const payload = {
    board: { id: board, code: "MYT" } as BoardSummary, columns: [],
    cards: [{ id: card, number: 12, assignee_ids: [], title: "Fix login" }, { id: "c2", number: null, assignee_ids: [], title: "Old" }],
    users: {}
  } as unknown as BoardPayload;
  const [first, second] = hydrateBoard(payload).cards;
  expect(first!.key).toBe("MYT-12");
  expect(second!.key).toBeUndefined();
  const face = { card: { ...first!, tag_ids: [], flags: [], comment_count: 0, attachment_count: 0 } as CardSummary, tags: [], done: false, today: "2026-11-13" };
  expect(renderToStaticMarkup(<CardFace {...face} excerptId="x" />)).toContain('<span class="task-card-key-face">MYT-12</span>');
  expect(cardFaceLabel(face)).toBe("Fix login, MYT-12");
});

test("Move to another board: only other boards the person edits; the first column that is not done; the sheet offers it only with a handler", () => {
  const summary = (id: string, level: string) => ({ id, name: id, level, is_owner: 1 }) as unknown as BoardSummary;
  expect(moveTargets([summary(board, "owner"), summary("b2", "edit"), summary("b3", "comment"), summary("b4", "manage"), summary("b5", "view")], board).map((item) => item.id)).toEqual(["b2", "b4"]);
  const column = (id: string, position: number, done: 0 | 1) => ({ id, board_id: "b2", name: id, position, is_done: done, created_at: "", updated_at: "" }) as BoardColumn;
  expect(defaultTargetColumn([column("done", 1, 1), column("doing", 3, 0), column("todo", 2, 0)])?.id).toBe("todo");
  expect(defaultTargetColumn([column("done", 1, 1)])?.id).toBe("done");
  expect(defaultTargetColumn([])).toBeNull();
  const cardSummary = { id: card, board_id: board, column_id: "c1", title: "Ship it" } as unknown as CardSummary;
  const columns = [column("c1", 1, 0)];
  const sheet = (onMoveToBoard?: () => Promise<void>) => renderToStaticMarkup(<MoveCardSheet card={cardSummary} columns={columns} onMove={async () => undefined} onCancel={noop} onMoveToBoard={onMoveToBoard} />);
  expect(sheet(async () => undefined)).toContain("Move to another board…");
  expect(sheet()).not.toContain("Move to another board");
  expect(renderToStaticMarkup(<MoveCardSheet card={cardSummary} columns={columns} onMove={async () => undefined} onCancel={noop} readOnly onMoveToBoard={async () => undefined} />)).not.toContain("another board");
});

test("New board asks for a code; Board settings shows it, and only the owner gets Change code", () => {
  const dialog = renderToStaticMarkup(<NewBoardDialog onSubmit={async () => undefined} onCancel={noop} suggest={async () => "MYT"} />);
  expect(dialog).toContain(">Code</label>");
  expect(dialog).toContain("Card keys start with it");
  const summary = { id: board, name: "My tasks", code: "MYT" } as BoardSummary;
  const owned = renderToStaticMarkup(<BoardCodeRow board={summary} isOwner onSaved={noop} notify={notifier} />);
  expect(owned).toContain("MYT-1, MYT-2");
  expect(owned).toContain("Change code");
  expect(renderToStaticMarkup(<BoardCodeRow board={summary} isOwner={false} onSaved={noop} notify={notifier} />)).not.toContain("Change code");
  expect(renderToStaticMarkup(<BoardCodeRow board={{ ...summary, code: null }} isOwner onSaved={noop} notify={notifier} />)).toBe("");
});
