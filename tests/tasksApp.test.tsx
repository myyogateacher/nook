import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardList } from "../src/tasks/BoardList";
import { attachmentsFor, canRetryTitle, canUnlink, columnEyebrow, commentCountLabel, descriptionDirty, cardCountLabel, pickerDetail, commentBodyError, isInlineImage, sharingLabel, unlinkConfirmMessage, validateBoardName, validateCardTitle, validateColumnName } from "../src/tasks/taskActions";

test("the board list starts with its loading state and a New board action", () => {
  const markup = renderToStaticMarkup(<BoardList onOpen={() => undefined} notify={() => undefined} />);
  expect(markup).toContain("Loading boards…");
  expect(markup).toContain(">New board</button>");
  expect(markup).toContain('<h1 id="tasks-title">Boards</h1>');
});

test("name validation mirrors the server rules", () => {
  expect(validateBoardName("  Launch  ")).toEqual({ ok: true, name: "Launch", changed: true });
  expect(validateBoardName("Launch", "Launch")).toEqual({ ok: true, name: "Launch", changed: false });
  expect(validateBoardName("   ").ok).toBe(false);
  expect(validateBoardName("x".repeat(121)).ok).toBe(false);
  expect(validateBoardName("x".repeat(120)).ok).toBe(true);
  expect(validateColumnName("x".repeat(61)).ok).toBe(false);
  expect(validateCardTitle("x".repeat(200)).ok).toBe(true);
  expect(validateCardTitle("x".repeat(201)).ok).toBe(false);
  expect(validateCardTitle("bad\u0007bell").ok).toBe(false);
  expect(validateCardTitle("rtl‮trick").ok).toBe(false);
  expect(cardCountLabel(1)).toBe("1 card");
  expect(cardCountLabel(0)).toBe("0 cards");
  expect(sharingLabel("all_users")).toBe("Everyone here");
});

test("attachment helpers group by comment, gate removal, and pick inline images", () => {
  const base = { preview_kind: "image", mime_type: "image/png" };
  const items = [
    { ...base, document_id: "a", comment_id: null, linked_by: "u1" },
    { ...base, document_id: "b", comment_id: "c1", linked_by: "u2" },
    { document_id: "c", comment_id: null, linked_by: "u2", preview_kind: "none", mime_type: "application/zip" }
  ];
  expect(attachmentsFor(items, null).map((item) => item.document_id)).toEqual(["a", "c"]);
  expect(attachmentsFor(items, "c1").map((item) => item.document_id)).toEqual(["b"]);
  expect(canUnlink(items[1]!, "u2", false)).toBe(true);
  expect(canUnlink(items[1]!, "u1", false)).toBe(false);
  expect(canUnlink(items[1]!, "u1", true)).toBe(true);
  expect(isInlineImage(items[0]!)).toBe(true);
  expect(isInlineImage({ preview_kind: "image", mime_type: "image/svg+xml" })).toBe(false);
  expect(isInlineImage(items[2]!)).toBe(false);
  expect(unlinkConfirmMessage("a.png", true)).toContain("your Bin");
  expect(unlinkConfirmMessage("a.png", false)).toContain("uploader's Bin");
  expect(commentBodyError("  ")).not.toBeNull();
  expect(commentBodyError("é".repeat(8193))).not.toBeNull();
  expect(commentBodyError("ok")).toBeNull();
});

test("a title save retries after CARD_CHANGED only when nobody else renamed the card", () => {
  expect(canRetryTitle("Plan", "Plan")).toBe(true);
  expect(canRetryTitle("Plan", "Plan v2")).toBe(false);
});

test("only unsaved description edits ask before leaving the card", () => {
  expect(descriptionDirty(false, "changed", "saved")).toBe(false);
  expect(descriptionDirty(true, "saved", "saved")).toBe(false);
  expect(descriptionDirty(true, "changed", "saved")).toBe(true);
});

test("card copy uses one “In” prefix, plural counts, and picker details for duplicate names", () => {
  expect(columnEyebrow("In progress")).toBe("In progress");
  expect(columnEyebrow("Doing")).toBe("In Doing");
  expect(commentCountLabel(1)).toBe("1 comment");
  expect(commentCountLabel(3)).toBe("3 comments");
  const users = [{ id: "aaaaaaaa-1", displayName: "Sam" }, { id: "bbbbbbbb-2", displayName: "sam " }, { id: "cccccccc-3", displayName: "Kim", email: "kim@example.test" }];
  expect(pickerDetail(users[0]!, users)).toBe("ID aaaaaaaa");
  expect(pickerDetail(users[2]!, users)).toBe("kim@example.test");
  expect(pickerDetail({ id: "d", displayName: "Lee" }, users)).toBeNull();
});

test("cards show a due chip and assignee, and no chip in a done column", async () => {
  const { BoardColumnView } = await import("../src/tasks/BoardColumnView");
  const { localDateString } = await import("../src/tasks/taskActions");
  const noop = () => undefined;
  const card = {
    id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Pay rent", has_description: 0 as const, revision: 1, created_by: "u1", creator_name: "Ann",
    due_on: "2020-01-01", assignees: [{ id: "u2", display_name: "Bo", can_read: 1 }], comment_count: 0, attachment_count: 0, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z"
  };
  const render = (isDone: 0 | 1, dueOn: string) => renderToStaticMarkup(<BoardColumnView
    column={{ id: "c1", board_id: "b1", name: "To do", position: 1024, is_done: isDone, created_at: "", updated_at: "" }}
    cards={[{ ...card, due_on: dueOn }]} owner={false} isFirst isLast draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={async () => undefined} />);
  const open = render(0, "2020-01-01");
  expect(open).toContain("task-due-chip overdue");
  expect(open).toContain("Overdue, was due");
  expect(open).toContain("Assigned to Bo");
  expect(render(0, localDateString())).toContain("Due today");
  expect(render(1, "2020-01-01")).not.toContain("task-due-chip");
});
