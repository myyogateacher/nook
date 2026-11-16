import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { CardComposer } from "../src/tasks/CardComposer";
import { applyFieldChange, composerDirty, composerError, createBody, defaultColumnId, draftCard, emptyDraft } from "../src/tasks/composerDraft";
import { dueStatus, wallTimeInstant } from "../src/tasks/taskActions";
import { dueAt } from "../server/tasks/dueTime";
import type { BoardColumn } from "../src/tasks/tasksApi";

const noop = () => undefined;
const column = (id: string, position: number, extra: Partial<BoardColumn> = {}): BoardColumn => ({ id, board_id: "b1", name: id.toUpperCase(), position, is_done: 0, wip_limit: null, created_at: "", updated_at: "", ...extra });
const columns = [column("todo", 1, { wip_limit: 1 }), column("doing", 2), column("done", 3, { is_done: 1 })];
const cards = [{ id: "k1", column_id: "todo" }];

test("the composer starts in the column it was opened from, unless that column is full", () => {
  expect(defaultColumnId(columns, [], "done")).toBe("done");
  expect(defaultColumnId(columns, [], null)).toBe("todo");
  // To do is full (limit 1): the first open column with room.
  expect(defaultColumnId(columns, cards, "todo")).toBe("doing");
  expect(defaultColumnId(columns, cards, null)).toBe("doing");
  // Every open column full: a done column with room, then the one asked for.
  const full = [column("a", 1, { wip_limit: 1 }), column("z", 2, { is_done: 1 })];
  expect(defaultColumnId(full, [{ id: "k", column_id: "a" }], null)).toBe("z");
  expect(defaultColumnId([column("a", 1, { wip_limit: 1 })], [{ id: "k", column_id: "a" }], "a")).toBe("a");
  expect(defaultColumnId([], [], null)).toBe("");
});

test("anything entered makes the draft dirty", () => {
  const draft = emptyDraft("todo");
  expect(composerDirty(draft)).toBe(false);
  expect(composerDirty({ ...draft, title: "   " })).toBe(false);
  expect(composerDirty({ ...draft, title: "x" })).toBe(true);
  expect(composerDirty({ ...draft, description: "notes" })).toBe(true);
  expect(composerDirty({ ...draft, dueOn: "2026-10-01" })).toBe(true);
  expect(composerDirty({ ...draft, flags: ["on_hold"] })).toBe(true);
  expect(composerDirty({ ...draft, attachments: [{ id: "f", name: "a.txt", mime_type: "text/plain", preview_kind: "text", size_bytes: 1 }] })).toBe(true);
  // Switching the column alone is not worth a prompt.
  expect(composerDirty({ ...draft, columnId: "doing" })).toBe(false);
});

test("field changes follow the server's rules: clearing the date clears the time, a time needs a date", () => {
  let draft = applyFieldChange(emptyDraft("todo"), { dueTime: "17:00", dueTz: "Europe/Berlin" });
  expect(draft.dueTime).toBeNull();
  draft = applyFieldChange(draft, { dueOn: "2026-10-01" });
  draft = applyFieldChange(draft, { dueTime: "17:00", dueTz: "Europe/Berlin" });
  expect([draft.dueOn, draft.dueTime, draft.dueTz]).toEqual(["2026-10-01", "17:00", "Europe/Berlin"]);
  expect(applyFieldChange(draft, { dueTime: null })).toMatchObject({ dueOn: "2026-10-01", dueTime: null, dueTz: null });
  expect(applyFieldChange(draft, { dueOn: null })).toMatchObject({ dueOn: null, dueTime: null, dueTz: null });
  // Moving the date keeps the time (D115).
  expect(applyFieldChange(draft, { dueOn: "2026-10-02" })).toMatchObject({ dueOn: "2026-10-02", dueTime: "17:00" });
});

test("assignees keep the names the picker passed; tags and flags replace the set", () => {
  let draft = applyFieldChange(emptyDraft("todo"), { assigneeIds: ["u1", "u2"] }, { assignees: [{ id: "u1", display_name: "Ann", can_read: 1 }, { id: "u2", display_name: "Bo", can_read: 1 }] });
  expect(draft.assignees.map((person) => person.display_name)).toEqual(["Ann", "Bo"]);
  draft = applyFieldChange(draft, { assigneeIds: ["u2"] });
  expect(draft.assignees).toEqual([{ id: "u2", display_name: "Bo", can_read: 1 }]);
  draft = applyFieldChange(draft, { tagIds: ["t1"], flags: ["on_hold", "blocked"] });
  expect([draft.tagIds, draft.flags]).toEqual([["t1"], ["on_hold", "blocked"]]);
  expect(applyFieldChange(draft, { tagIds: [], flags: [] })).toMatchObject({ tagIds: [], flags: [] });
  // The card-shaped view that CardFields reads.
  const card = draftCard(draft, "b1");
  expect(card).toMatchObject({ board_id: "b1", column_id: "todo", assignees: [{ id: "u2", display_name: "Bo", can_read: 1 }], due_on: null });
  expect(card).not.toHaveProperty("assignee_id");
  expect((card as unknown as { flags: string[] }).flags).toEqual(["on_hold", "blocked"]);
});

test("the composer's due summary includes the time, as the card dialog's does", () => {
  const draft = applyFieldChange(applyFieldChange(emptyDraft("todo"), { dueOn: "2026-10-03" }), { dueTime: "18:45", dueTz: "Europe/Berlin" });
  const card = draftCard(draft, "b1");
  expect(card.due_at).toBe(dueAt({ due_on: "2026-10-03", due_time: "18:45", due_tz: "Europe/Berlin" }));
  const today = "2026-09-27";
  const now = Date.parse("2026-09-27T08:00:00Z");
  const summary = dueStatus(card.due_on, today, false, { dueAt: card.due_at, now, timeZone: "Europe/Berlin" });
  expect(summary?.description).toMatch(/^Due .+ at 18:45$/);
  // A date alone still reads as a date.
  expect(draftCard(applyFieldChange(emptyDraft("todo"), { dueOn: "2026-10-03" }), "b1").due_at).toBeNull();
});

test("the client's wall-time instant matches the server's due_at, DST gaps and overlaps included", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-10-03", "18:45", "Europe/Berlin"], ["2026-03-29", "02:30", "Europe/Berlin"], ["2026-10-25", "02:30", "Europe/Berlin"],
    ["2026-03-08", "02:15", "America/New_York"], ["2026-11-01", "01:30", "America/New_York"], ["2026-06-01", "09:00", "Asia/Kolkata"],
    ["2026-01-01", "00:00", "Pacific/Kiritimati"], ["2026-12-31", "23:59", "UTC"]
  ];
  for (const [date, time, zone] of cases) expect(wallTimeInstant(date, time, zone)).toBe(dueAt({ due_on: date, due_time: time, due_tz: zone }));
  expect(wallTimeInstant("2026-10-03", "18:45", "Not/AZone")).toBeNull();
});

test("the create request carries only what was set", () => {
  expect(createBody(emptyDraft("todo"), "Pay rent")).toEqual({ columnId: "todo", title: "Pay rent" });
  const draft = {
    ...emptyDraft("doing"), description: "Call first", dueOn: "2026-10-01", dueTime: "09:30", dueTz: "Asia/Kolkata",
    assignees: [{ id: "u1", display_name: "Ann", can_read: 1 as const }], tagIds: ["t1"], flags: ["on_hold"],
    relations: [{ key: "depends_on:c9", type: "depends_on" as const, card: { id: "c9", board_id: "b2", board_name: "Ops", title: "Order", column_name: "To do", is_done: 0 as const } }],
    attachments: [{ id: "f1", name: "a.pdf", mime_type: "application/pdf", preview_kind: "pdf", size_bytes: 10 }]
  };
  expect(createBody(draft, "Pay rent")).toEqual({
    columnId: "doing", title: "Pay rent", description: "Call first", dueOn: "2026-10-01", dueTime: "09:30", dueTz: "Asia/Kolkata",
    assigneeIds: ["u1"], tagIds: ["t1"], flags: ["on_hold"], relations: [{ targetCardId: "c9", type: "depends_on" }], attachmentIds: ["f1"]
  });
  // A time never goes without its zone, nor without a date.
  expect(createBody({ ...emptyDraft("todo"), dueTime: "09:30", dueTz: "UTC" }, "x")).toEqual({ columnId: "todo", title: "x" });
});

test("refusals are explained next to the field they concern", () => {
  expect(composerError({ status: 409, code: "COLUMN_FULL", wipLimit: 3 }, columns[1])).toEqual({ field: "column", message: "“DOING” is full (limit 3). Move a card out of it first." });
  expect(composerError({ status: 404, code: "NOT_FOUND" }, columns[1], true).field).toBe("relations");
  expect(composerError({ status: 404 }, columns[1], false).field).toBe("form");
  expect(composerError({ status: 409, code: "RELATION_EXISTS" }, columns[1]).field).toBe("relations");
  expect(composerError({ status: 400, code: "ASSIGNEE_NOT_MEMBER" }, columns[1]).message).toContain("can no longer open this board");
  expect(composerError({ status: 409, code: "LIMIT_REACHED", message: "This board has 1000 cards" }, columns[1])).toEqual({ field: "form", message: "This board has 1000 cards" });
});

test("the composer is a modal dialog with the title first, a column Select, and the three create actions", () => {
  const markup = renderToStaticMarkup(<CardComposer boardId="b1" boardName="Home" userId="u1" columns={columns} cards={cards} initialColumnId="todo" onClose={noop} onCreated={noop} notify={noop} />);
  expect(markup).toContain('role="dialog"');
  expect(markup).toContain('aria-modal="true"');
  expect(markup).toContain("New card · Home");
  expect(markup).toContain('aria-label="Card title"');
  expect(markup).not.toContain("<select");
  // The full column is offered but disabled, and the composer starts in Doing.
  expect(markup).toContain("DOING");
  expect(markup).toContain(">Create another<");
  expect(markup).toContain(">Create and open<");
  expect(markup).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
  expect(markup).toContain("Add relation");
  expect(markup).toContain("Files upload now and are attached when the card is created.");
  expect(markup).toContain('aria-label="Close the new card"');
});

test("the composer offers the board's tags and the flags through the card fields (13C)", () => {
  const tags = [{ id: "t1", board_id: "b1", name: "Ops", color: "blue" as const, card_count: 0 }];
  const markup = renderToStaticMarkup(<CardComposer boardId="b1" boardName="Home" userId="u1" columns={columns} cards={cards} initialColumnId="todo" onClose={noop} onCreated={noop} notify={noop} tags={tags} owner />);
  expect(markup).toContain("Add tags…");
  expect(markup).toContain(">Flags<");
  expect(markup).toContain("task-flag-picker");
  // Without the board's tags the Tags field is left out, as in the dialog.
  expect(renderToStaticMarkup(<CardComposer boardId="b1" boardName="Home" userId="u1" columns={columns} cards={cards} initialColumnId="todo" onClose={noop} onCreated={noop} notify={noop} />)).not.toContain("Add tags…");
});

test("a column's Add a card opens the composer instead of an inline form", () => {
  const markup = renderToStaticMarkup(<BoardColumnView column={columns[1]!} cards={[]} owner={false} isFirst isLast={false} draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={noop} />);
  expect(markup).toContain('aria-label="Add a card to DOING"');
  expect(markup).toContain('aria-haspopup="dialog"');
  expect(markup).not.toContain("<form");
});
