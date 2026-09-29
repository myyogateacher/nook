import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { dueStatus, localDateString } = await import("../src/tasks/taskActions");
const { isCalendarDate } = await import("../server/tasks/routes");

type Column = { id: string; name: string; is_done: 0 | 1 };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const card = (await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Plan" })).body.card as { id: string; revision: number };
  return { owner, member, stranger, boardId, columns, card };
}

describe("task due dates, assignees, and done columns", () => {
  test("new boards mark the default Done column as done", async () => {
    const { columns } = await setup("Default done");
    expect(columns.map((column) => [column.name, column.is_done])).toEqual([["To do", 0], ["Doing", 0], ["Done", 1]]);
  });

  test("readers set and clear due dates and assignees; responses carry the names", async () => {
    const { owner, member, boardId, card } = await setup("Due");
    let patched = await call(member, "PATCH", `/cards/${card.id}`, { dueOn: "2026-10-01", assigneeId: owner.userId, revision: card.revision });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ due_on: "2026-10-01", assignee_id: owner.userId, assignee_name: "Due owner", revision: 2, title: "Plan" });
    const board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards[0]).toMatchObject({ due_on: "2026-10-01", assignee_ids: [owner.userId] });
    expect(board.users[owner.userId]).toMatchObject({ display_name: "Due owner" });
    // Omitted fields are left alone; null clears.
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { title: "Plan it", revision: 2 });
    expect(patched.body.card).toMatchObject({ title: "Plan it", due_on: "2026-10-01", assignee_id: owner.userId });
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: null, assigneeId: null, revision: 3 });
    expect(patched.body.card).toMatchObject({ due_on: null, assignee_id: null, assignee_name: null, revision: 4 });
    // Revision CAS still applies.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: "2026-10-02", revision: 3 })).body.code).toBe("CARD_CHANGED");
    const audits = (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'task.card_update'").all(member.userId) as Array<{ metadata_json: string }>)
      .map((row) => JSON.parse(row.metadata_json));
    expect(audits.at(-1)).toMatchObject({ dueOn: "2026-10-01", assigneeId: owner.userId });
  });

  test("due dates must be real calendar dates", async () => {
    const { owner, boardId, columns, card } = await setup("Due validate");
    for (const dueOn of ["2026-02-30", "2026-13-01", "26-10-01", "2026-10-1", "2026-10-01T00:00", "", 20261001, "0999-01-01", "3000-01-01"]) {
      const response = await call(owner, "PATCH", `/cards/${card.id}`, { dueOn, revision: card.revision });
      expect(response.status).toBe(400);
    }
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    const created = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Dated", dueOn: "2028-02-29" });
    expect(created.status).toBe(201);
    expect(created.body.card.due_on).toBe("2028-02-29");
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Bad", dueOn: "2027-02-29" })).status).toBe(400);
  });

  test("assignees must be able to read the board (ASSIGNEE_NOT_MEMBER)", async () => {
    const { owner, member, stranger, boardId, card } = await setup("Assignee");
    const refused = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: stranger.userId, revision: card.revision });
    expect(refused).toMatchObject({ status: 400, body: { code: "ASSIGNEE_NOT_MEMBER" } });
    const missing = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: crypto.randomUUID(), revision: card.revision });
    expect(missing.body.code).toBe("ASSIGNEE_NOT_MEMBER");
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: member.userId, revision: card.revision })).status).toBe(200);
    // Once the board is open to everyone, anyone enabled can be assigned.
    expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "all_users", userIds: [] })).status).toBe(200);
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: stranger.userId, revision: 2 })).status).toBe(200);
    // A disabled user cannot be assigned.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), member.userId);
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: member.userId, revision: 3 })).body.code).toBe("ASSIGNEE_NOT_MEMBER");
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(member.userId);
  });

  test("the readers list is for readers only and matches who can open the board", async () => {
    const { owner, member, stranger, boardId } = await setup("Readers");
    const readers = await call(member, "GET", `/boards/${boardId}/readers`);
    expect(readers.status).toBe(200);
    expect((readers.body.users as Array<{ id: string }>).map((user) => user.id).sort()).toEqual([owner.userId, member.userId].sort());
    expect((await call(stranger, "GET", `/boards/${boardId}/readers`)).status).toBe(404);
    expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect((await call(owner, "GET", `/boards/${boardId}/readers`)).body.users).toEqual([{ id: owner.userId, displayName: "Readers owner", avatarUrl: null }]);
  });

  test("only the owner sets isDone on a column", async () => {
    const { owner, member, stranger, columns } = await setup("Done column");
    expect((await call(member, "PATCH", `/columns/${columns[1].id}`, { isDone: true })).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(stranger, "PATCH", `/columns/${columns[1].id}`, { isDone: true })).status).toBe(404);
    const done = await call(owner, "PATCH", `/columns/${columns[1].id}`, { isDone: true });
    expect(done.status).toBe(200);
    expect(done.body.column).toMatchObject({ id: columns[1].id, is_done: 1 });
    const undone = await call(owner, "PATCH", `/columns/${columns[2].id}`, { isDone: false });
    expect(undone.body.columns.map((column: Column) => column.is_done)).toEqual([0, 1, 0]);
    expect((await call(owner, "PATCH", `/columns/${columns[2].id}`, { isDone: "yes" })).status).toBe(400);
  });

  test("the due chip reads overdue, today, soon, later, and nothing in done columns", () => {
    expect(dueStatus(null, "2026-09-25")).toBeNull();
    expect(dueStatus("2026-09-20", "2026-09-25", true)).toBeNull();
    expect(dueStatus("2026-09-24", "2026-09-25")?.tone).toBe("overdue");
    expect(dueStatus("2026-09-25", "2026-09-25")).toMatchObject({ tone: "today", label: "Today" });
    expect(dueStatus("2026-09-26", "2026-09-25")).toMatchObject({ tone: "soon", label: "Tomorrow" });
    expect(dueStatus("2026-10-02", "2026-09-25")?.tone).toBe("soon");
    expect(dueStatus("2026-10-03", "2026-09-25")?.tone).toBe("later");
    // Across a month and year boundary.
    expect(dueStatus("2027-01-01", "2026-12-31")?.label).toBe("Tomorrow");
    expect(localDateString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

test("the due field saves only a complete real date that changed", async () => {
  const { committableDueDate } = await import("../src/tasks/taskActions");
  expect(committableDueDate("2026-10-01", null)).toBe("2026-10-01");
  expect(committableDueDate("2026-10-01", "2026-10-01")).toBeNull();
  // Partial years a browser reports while typing, and out-of-range or impossible dates.
  for (const value of ["", "0002-10-01", "0202-10-01", "1899-12-31", "3000-01-01", "2026-02-30", "2026-13-01", "2026-10"]) expect(committableDueDate(value, null)).toBeNull();
  expect(committableDueDate("1900-01-01", null)).toBe("1900-01-01");
  expect(committableDueDate("2028-02-29", "2026-10-01")).toBe("2028-02-29");
});
