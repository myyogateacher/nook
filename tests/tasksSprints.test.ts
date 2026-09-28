import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addSprintDays, sprintDatesAfterCompleting } from "../shared/sprintPlan";

/** Board sprints (research 2026-09-26 §6, D124, D131, D132, D135, T118): the lifecycle, card assignment, and carry-over. */

type Column = { id: string; name: string; position: number; is_done: 0 | 1 };
type Card = { id: string; column_id: string; title: string; revision: number; parent_card_id: string | null; level: number; sprint_id: string | null };
type Sprint = { id: string; name: string; state: string; is_active: boolean; start_on: string | null; end_on: string | null; card_count: number; done_count: number; position: number; completed_at: string | null };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const SPRINT_TASKS = { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: true };

// One owner, member, and stranger for the whole file (the suite shares a bounded pool of test accounts).
let people: { owner: Session; member: Session; stranger: Session } | null = null;
async function users() {
  people ??= { owner: await createUser("Sprints owner"), member: await createUser("Sprints member"), stranger: await createUser("Sprints stranger") };
  return people;
}

/** A Sprint › Task › Subtask board with To do, Doing, Done, shared with the member. */
async function setup(label: string, structure: object = SPRINT_TASKS) {
  const { owner, member, stranger } = await users();
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure })).status).toBe(200);
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  return { owner, member, stranger, boardId, columns };
}

/** A planned sprint on the stranger's private board, which the owner and member cannot read. */
async function foreignSprint() {
  const { stranger } = await users();
  const created = await call(stranger, "POST", "/boards", { name: "Stranger board" });
  expect((await call(stranger, "PATCH", `/boards/${created.body.board.id}`, { structure: SPRINT_TASKS })).status).toBe(200);
  return addSprint(stranger, created.body.board.id, "Theirs");
}

async function addSprint(session: Session, boardId: string, name: string, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", `/boards/${boardId}/sprints`, { name, ...extra });
  expect(created.status).toBe(201);
  return created.body.sprint as Sprint;
}

async function addCard(session: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as Card;
}

const boardOf = async (session: Session, boardId: string) => (await call(session, "GET", `/boards/${boardId}`)).body as { cards: Card[]; sprints: Sprint[] };
const lastAudit = (action: string) => {
  const row = db.query("SELECT metadata_json FROM audit_log WHERE event_type = ? ORDER BY rowid DESC LIMIT 1").get(action) as { metadata_json: string } | null;
  return row ? JSON.parse(row.metadata_json) as Record<string, unknown> : null;
};

describe("sprint lifecycle", () => {
  test("the owner creates, renames, dates, reorders, and starts sprints; readers list them; strangers get 404", async () => {
    const { owner, member, stranger, boardId } = await setup("Lifecycle");
    const first = await addSprint(owner, boardId, "Sprint 1", { goal: "Ship the checkout", startOn: "2026-10-01", endOn: "2026-10-14" });
    expect(first).toMatchObject({ name: "Sprint 1", state: "planned", is_active: false, start_on: "2026-10-01", end_on: "2026-10-14", card_count: 0, done_count: 0, completed_at: null });
    expect(lastAudit("task.sprint_create")).toEqual({ boardId, sprintId: first.id });
    const second = await addSprint(owner, boardId, "Sprint 2");
    expect(second.position).toBeGreaterThan(first.position);

    // Readers list; strangers and missing boards are 404.
    const listed = await call(member, "GET", `/boards/${boardId}/sprints`);
    expect(listed.status).toBe(200);
    expect(listed.body.sprints.map((sprint: Sprint) => sprint.name)).toEqual(["Sprint 1", "Sprint 2"]);
    expect(listed.body.nextCursor).toBeNull();
    expect((await call(stranger, "GET", `/boards/${boardId}/sprints`)).status).toBe(404);
    expect((await call(member, "GET", `/boards/${boardId}/sprints?state=closed`)).status).toBe(400);

    // Owner-only writes: members get 403, strangers 404.
    expect(await call(member, "POST", `/boards/${boardId}/sprints`, { name: "Mine" })).toMatchObject({ status: 403, body: { code: "OWNER_ONLY" } });
    expect(await call(member, "PATCH", `/sprints/${first.id}`, { name: "Renamed" })).toMatchObject({ status: 403, body: { code: "OWNER_ONLY" } });
    expect((await call(stranger, "PATCH", `/sprints/${first.id}`, { name: "Renamed" })).status).toBe(404);
    expect((await call(stranger, "DELETE", `/sprints/${second.id}`)).status).toBe(404);

    const renamed = await call(owner, "PATCH", `/sprints/${first.id}`, { name: "  Sprint 12 ", endOn: "2026-10-10" });
    expect(renamed.body.sprint).toMatchObject({ name: "Sprint 12", start_on: "2026-10-01", end_on: "2026-10-10" });
    expect(lastAudit("task.sprint_update")).toEqual({ boardId, sprintId: first.id, fields: ["name", "endOn"] });
    expect((await call(owner, "PATCH", `/sprints/${first.id}`, { endOn: "2026-09-01" })).status).toBe(400);
    expect((await call(owner, "POST", `/boards/${boardId}/sprints`, { name: "Backwards", startOn: "2026-10-14", endOn: "2026-10-01" })).status).toBe(400);
    expect((await call(owner, "POST", `/boards/${boardId}/sprints`, { name: "Bad date", startOn: "2026-02-30" })).status).toBe(400);
    expect((await call(owner, "POST", `/boards/${boardId}/sprints`, { name: "x".repeat(61) })).status).toBe(400);

    // Reorder: Sprint 2 first.
    expect((await call(owner, "PATCH", `/sprints/${second.id}`, { afterSprintId: null })).status).toBe(200);
    expect((await call(member, "GET", `/boards/${boardId}/sprints`)).body.sprints.map((sprint: Sprint) => sprint.name)).toEqual(["Sprint 2", "Sprint 12"]);

    // Start: one active sprint per board, and it lists first.
    const started = await call(owner, "PATCH", `/sprints/${first.id}`, { state: "active" });
    expect(started.body.sprint).toMatchObject({ state: "active", is_active: true });
    expect(lastAudit("task.sprint_start")).toEqual({ boardId, sprintId: first.id });
    expect(await call(owner, "PATCH", `/sprints/${second.id}`, { state: "active" })).toMatchObject({ status: 409, body: { code: "SPRINT_ACTIVE", activeSprintId: first.id } });
    expect((await call(owner, "PATCH", `/sprints/${first.id}`, { state: "completed" })).status).toBe(400);
    const board = await boardOf(member, boardId);
    expect(board.sprints.map((sprint) => [sprint.name, sprint.state])).toEqual([["Sprint 12", "active"], ["Sprint 2", "planned"]]);
  });

  test("sprints need sprints on; at most 50 open; only an empty planned sprint is deleted", async () => {
    const flat = await setup("Sprints off", { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false });
    expect(await call(flat.owner, "POST", `/boards/${flat.boardId}/sprints`, { name: "Sprint 1" })).toMatchObject({ status: 409, body: { code: "SPRINTS_OFF" } });

    const { owner, member, boardId, columns } = await setup("Limits");
    const planned = await addSprint(owner, boardId, "Planned");
    const card = await addCard(member, boardId, columns[0].id, "Planned work", { sprintId: planned.id });
    expect(await call(owner, "DELETE", `/sprints/${planned.id}`)).toMatchObject({ status: 409, body: { code: "SPRINT_NOT_EMPTY", cardCount: 1 } });
    expect((await call(member, "PATCH", `/cards/${card.id}`, { sprintId: null, revision: card.revision })).status).toBe(200);
    expect((await call(owner, "DELETE", `/sprints/${planned.id}`)).status).toBe(200);
    expect(lastAudit("task.sprint_delete")).toEqual({ boardId, sprintId: planned.id });
    const active = await addSprint(owner, boardId, "Active");
    await call(owner, "PATCH", `/sprints/${active.id}`, { state: "active" });
    expect(await call(owner, "DELETE", `/sprints/${active.id}`)).toMatchObject({ status: 409, body: { code: "SPRINT_NOT_PLANNED" } });

    const insert = db.query("INSERT INTO board_sprints (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 1; index < 50; index += 1) insert.run(crypto.randomUUID(), boardId, `Bulk ${index}`, 5000 + index, "2026-01-01", "2026-01-01");
    expect(await call(owner, "POST", `/boards/${boardId}/sprints`, { name: "One too many" })).toMatchObject({ status: 409, body: { code: "LIMIT_REACHED" } });
    // Turning sprints off is refused while sprints are open (T120).
    expect(await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...SPRINT_TASKS, sprints: false } })).toMatchObject({ status: 409, body: { code: "SPRINTS_IN_USE" } });
  });

  test("the Scrum template starts with a planned Sprint 1 of two weeks", async () => {
    const { owner } = await users();
    const created = await call(owner, "POST", "/boards", { name: "Web app", template: "scrum" });
    expect(created.status).toBe(201);
    const { sprints } = await boardOf(owner, created.body.board.id);
    expect(sprints).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 13)).toISOString().slice(0, 10);
    expect(sprints[0]).toMatchObject({ name: "Sprint 1", state: "planned", start_on: today, end_on: end });
    const kanban = await call(owner, "POST", "/boards", { name: "Plain" });
    expect((await boardOf(owner, kanban.body.board.id)).sprints).toEqual([]);
    // The creator's zone dates Sprint 1 from their today, not UTC's (QA NOTE-a).
    const zone = "Pacific/Kiritimati";
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const zoned = await call(owner, "POST", "/boards", { name: "Kiritimati", template: "scrum", tz: zone });
    expect((await boardOf(owner, zoned.body.board.id)).sprints[0]).toMatchObject({ start_on: local, end_on: addSprintDays(local, 13) });
    expect((await call(owner, "POST", "/boards", { name: "Bad zone", template: "scrum", tz: "Mars/Olympus" })).status).toBe(400);
  });
});

describe("planning cards in sprints", () => {
  test("only work-level cards store a sprint; subtasks inherit it on read and follow a reparent", async () => {
    const { owner, member, boardId, columns } = await setup("Assign");
    const sprint = await addSprint(owner, boardId, "Sprint 1");
    const other = await addSprint(owner, boardId, "Sprint 2");
    const task = await addCard(member, boardId, columns[0].id, "Checkout", { sprintId: sprint.id });
    expect(task.sprint_id).toBe(sprint.id);
    expect(lastAudit("task.card_create")).toMatchObject({ boardId, cardId: task.id, sprintId: sprint.id });
    const subtask = await addCard(member, boardId, columns[0].id, "Form", { parentId: task.id });
    expect(subtask.sprint_id).toBe(sprint.id);
    // A subtask stores none: 400 SPRINT_LEVEL on create and on PATCH, and nothing is written.
    expect(await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Nope", parentId: task.id, sprintId: other.id }))
      .toMatchObject({ status: 400, body: { code: "SPRINT_LEVEL" } });
    expect(await call(member, "PATCH", `/cards/${subtask.id}`, { sprintId: other.id, revision: subtask.revision })).toMatchObject({ status: 400, body: { code: "SPRINT_LEVEL" } });
    expect((db.query("SELECT sprint_id FROM cards WHERE id = ?").get(subtask.id) as { sprint_id: string | null }).sprint_id).toBeNull();

    // Moving the task to another sprint moves the subtask with it (derived, D124).
    const moved = await call(member, "PATCH", `/cards/${task.id}`, { sprintId: other.id, revision: task.revision });
    expect(moved.body.card).toMatchObject({ sprint_id: other.id, revision: task.revision + 1 });
    expect(lastAudit("task.card_update")).toMatchObject({ cardId: task.id, sprintId: other.id });
    let cards = (await boardOf(member, boardId)).cards;
    expect(cards.find((card) => card.id === subtask.id)!.sprint_id).toBe(other.id);
    // Reparenting the subtask under a backlog task takes it out of the sprint.
    const backlog = await addCard(member, boardId, columns[0].id, "Backlog task");
    const current = cards.find((card) => card.id === subtask.id)!;
    expect((await call(member, "PATCH", `/cards/${subtask.id}`, { parentId: backlog.id, revision: current.revision })).body.card.sprint_id).toBeNull();
    // A stale revision is CARD_CHANGED.
    expect(await call(member, "PATCH", `/cards/${task.id}`, { sprintId: null, revision: task.revision })).toMatchObject({ status: 409, body: { code: "CARD_CHANGED" } });
    // Counts are work-level cards only.
    cards = (await boardOf(member, boardId)).cards;
    const summary = (await boardOf(member, boardId)).sprints.find((item) => item.id === other.id)!;
    expect(summary).toMatchObject({ card_count: 1, done_count: 0 });
    expect(cards.filter((card) => card.sprint_id === other.id).map((card) => card.title)).toEqual(["Checkout"]);
  });

  test("a work-level card created without sprintId joins the active sprint; null keeps it in the backlog (Friction 3)", async () => {
    const { owner, member, boardId, columns } = await setup("Default sprint");
    // No active sprint yet: an omitted sprint is the backlog.
    const early = await addCard(member, boardId, columns[0].id, "Before the sprint");
    expect(early.sprint_id).toBeNull();
    const sprint = await addSprint(owner, boardId, "Sprint 1");
    expect((await call(owner, "PATCH", `/sprints/${sprint.id}`, { state: "active" })).status).toBe(200);
    const joined = await addCard(member, boardId, columns[0].id, "From a routine");
    expect(joined.sprint_id).toBe(sprint.id);
    expect(lastAudit("task.card_create")).toMatchObject({ cardId: joined.id, sprintId: sprint.id });
    const backlog = await addCard(member, boardId, columns[0].id, "For later", { sprintId: null });
    expect(backlog.sprint_id).toBeNull();
    // Below the work level nothing is stored; the subtask follows its parent.
    const subtask = await addCard(member, boardId, columns[0].id, "Its subtask", { parentId: backlog.id });
    expect(subtask.sprint_id).toBeNull();
    expect((db.query("SELECT sprint_id FROM cards WHERE id = ?").get(subtask.id) as { sprint_id: string | null }).sprint_id).toBeNull();
    // A board with sprints off never defaults.
    const flat = await setup("Default sprint flat", { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false });
    expect((await addCard(flat.member, flat.boardId, flat.columns[0].id, "Plain")).sprint_id).toBeNull();
  });

  test("a sprint of another board is 404, a completed one 409, and sprints off 400; changing level clears the stored sprint", async () => {
    const { owner, member, boardId, columns } = await setup("Refusals");
    const sprint = await addSprint(owner, boardId, "Sprint 1");
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Nope", sprintId: (await foreignSprint()).id })).status).toBe(404);
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Nope", sprintId: crypto.randomUUID() })).status).toBe(404);
    db.query("UPDATE board_sprints SET state = 'closed', closed_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", sprint.id);
    expect(await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Nope", sprintId: sprint.id })).toMatchObject({ status: 409, body: { code: "SPRINT_COMPLETED" } });
    const open = await addSprint(owner, boardId, "Sprint 2");
    const task = await addCard(member, boardId, columns[0].id, "Task", { sprintId: open.id });
    // Change level: the card is now a subtask (under another task), so it no longer stores a sprint.
    const host = await addCard(member, boardId, columns[0].id, "Host task");
    const releveled = await call(member, "PATCH", `/cards/${task.id}`, { level: 1, parentId: host.id, revision: task.revision });
    expect(releveled.status).toBe(200);
    expect(releveled.body.card.sprint_id).toBeNull();
    expect((db.query("SELECT sprint_id FROM cards WHERE id = ?").get(task.id) as { sprint_id: string | null }).sprint_id).toBeNull();

    const flat = await setup("Refusals flat", { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false });
    const flatCard = await addCard(flat.member, flat.boardId, flat.columns[0].id, "Card");
    expect(await call(flat.member, "PATCH", `/cards/${flatCard.id}`, { sprintId: open.id, revision: flatCard.revision })).toMatchObject({ status: 400, body: { code: "SPRINTS_OFF" } });
    // null is always accepted (nothing to store).
    expect((await call(flat.member, "PATCH", `/cards/${flatCard.id}`, { sprintId: null, revision: flatCard.revision })).status).toBe(200);
  });

  test("completed sprints page newest first", async () => {
    const { owner, member, boardId } = await setup("Paging");
    const insert = db.query("INSERT INTO board_sprints (id, board_id, name, state, position, closed_at, created_at, updated_at) VALUES (?, ?, ?, 'closed', ?, ?, ?, ?)");
    for (let index = 0; index < 25; index += 1) {
      const at = `2026-0${1 + Math.floor(index / 10)}-${String(10 + (index % 10)).padStart(2, "0")}T00:00:00.000Z`;
      insert.run(crypto.randomUUID(), boardId, `Old ${index}`, index, at, at, at);
    }
    await addSprint(owner, boardId, "Next");
    const first = await call(member, "GET", `/boards/${boardId}/sprints`);
    expect(first.body.sprints).toHaveLength(21);
    expect(first.body.sprints[0]).toMatchObject({ name: "Next", state: "planned" });
    expect(first.body.sprints[1]).toMatchObject({ name: "Old 24", state: "completed" });
    const second = await call(member, "GET", `/boards/${boardId}/sprints?state=completed&cursor=${first.body.nextCursor}`);
    expect(second.body.sprints.map((sprint: Sprint) => sprint.name)).toEqual(["Old 4", "Old 3", "Old 2", "Old 1", "Old 0"]);
    expect(second.body.nextCursor).toBeNull();
    expect((await call(member, "GET", `/boards/${boardId}/sprints?cursor=bad!`)).status).toBe(400);
    // The board payload carries the open sprints and the last five completed ones.
    expect((await boardOf(member, boardId)).sprints).toHaveLength(6);
  });
});

describe("completing a sprint", () => {
  async function running(label: string) {
    const setupResult = await setup(label);
    const { owner, member, boardId, columns } = setupResult;
    const sprint = await addSprint(owner, boardId, "Sprint 12", { startOn: "2026-09-21", endOn: "2026-10-04" });
    expect((await call(owner, "PATCH", `/sprints/${sprint.id}`, { state: "active" })).status).toBe(200);
    const done = await addCard(member, boardId, columns[2].id, "Shipped", { sprintId: sprint.id });
    const open = await addCard(member, boardId, columns[0].id, "Still open", { sprintId: sprint.id });
    const doing = await addCard(member, boardId, columns[1].id, "Half done", { sprintId: sprint.id });
    const subtask = await addCard(member, boardId, columns[0].id, "Its subtask", { parentId: open.id });
    const backlog = await addCard(member, boardId, columns[0].id, "Backlog", { sprintId: null });
    return { ...setupResult, sprint, done, open, doing, subtask, backlog };
  }

  test("carry to the next planned sprint: unfinished cards move with a revision bump, done cards stay, subtasks follow", async () => {
    const { owner, member, stranger, boardId, columns, sprint, done, open, doing, subtask, backlog } = await running("Carry next");
    const next = await addSprint(owner, boardId, "Sprint 13");
    const later = await addSprint(owner, boardId, "Sprint 14");
    const binned = await addCard(member, boardId, columns[0].id, "Binned", { sprintId: sprint.id });
    expect((await call(member, "DELETE", `/cards/${binned.id}`)).status).toBe(200);
    // Members cannot complete it; strangers see 404.
    expect(await call(member, "POST", `/sprints/${sprint.id}/complete`, { carryTo: "next" })).toMatchObject({ status: 403, body: { code: "OWNER_ONLY" } });
    expect((await call(stranger, "POST", `/sprints/${sprint.id}/complete`, { carryTo: "next" })).status).toBe(404);
    const completed = await call(owner, "POST", `/sprints/${sprint.id}/complete`, { carryTo: "next" });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ carried: 2, doneCount: 1, created: false, sprint: { id: sprint.id, state: "completed", is_active: false, card_count: 1, done_count: 1 }, target: { id: next.id, card_count: 2 } });
    expect(completed.body.sprint.completed_at).toBeTruthy();
    expect(lastAudit("task.sprint_complete")).toEqual({ boardId, sprintId: sprint.id, carried: 2, doneCount: 1, carryTo: "next", targetSprintId: next.id });
    const cards = new Map((await boardOf(member, boardId)).cards.map((card) => [card.id, card]));
    expect(cards.get(done.id)).toMatchObject({ sprint_id: sprint.id, revision: done.revision });
    expect(cards.get(open.id)).toMatchObject({ sprint_id: next.id, revision: open.revision + 1 });
    expect(cards.get(doing.id)!.sprint_id).toBe(next.id);
    expect(cards.get(subtask.id)!.sprint_id).toBe(next.id);
    expect(cards.get(backlog.id)!.sprint_id).toBeNull();
    // The binned card keeps the completed sprint; the later sprint is untouched.
    expect((db.query("SELECT sprint_id FROM cards WHERE id = ?").get(binned.id) as { sprint_id: string }).sprint_id).toBe(sprint.id);
    expect((await boardOf(member, boardId)).sprints.find((item) => item.id === later.id)).toMatchObject({ card_count: 0, state: "planned" });
    // A stale editor of a carried card gets CARD_CHANGED.
    expect(await call(member, "PATCH", `/cards/${open.id}`, { title: "Stale", revision: open.revision })).toMatchObject({ status: 409, body: { code: "CARD_CHANGED" } });
    // Only the active sprint completes, once.
    expect(await call(owner, "POST", `/sprints/${sprint.id}/complete`, { carryTo: "backlog" })).toMatchObject({ status: 409, body: { code: "SPRINT_NOT_ACTIVE" } });
    expect(await call(owner, "POST", `/sprints/${next.id}/complete`, { carryTo: "backlog" })).toMatchObject({ status: 409, body: { code: "SPRINT_NOT_ACTIVE" } });
    // A completed sprint cannot be started again or take new cards; the next one can start now.
    expect(await call(owner, "PATCH", `/sprints/${sprint.id}`, { state: "active" })).toMatchObject({ status: 409, body: { code: "SPRINT_COMPLETED" } });
    expect(await call(member, "PATCH", `/cards/${backlog.id}`, { sprintId: sprint.id, revision: backlog.revision })).toMatchObject({ status: 409, body: { code: "SPRINT_COMPLETED" } });
    expect((await call(owner, "PATCH", `/sprints/${next.id}`, { state: "active" })).status).toBe(200);
  });

  test("carry to the backlog, to a chosen planned sprint, or to a new sprint named and dated after this one", async () => {
    const toBacklog = await running("Carry backlog");
    const result = await call(toBacklog.owner, "POST", `/sprints/${toBacklog.sprint.id}/complete`, { carryTo: "backlog" });
    expect(result.body).toMatchObject({ carried: 2, doneCount: 1, target: null, created: false });
    expect(lastAudit("task.sprint_complete")).toMatchObject({ carryTo: "backlog", carried: 2 });
    expect(lastAudit("task.sprint_complete")!.targetSprintId).toBeUndefined();
    const cards = new Map((await boardOf(toBacklog.member, toBacklog.boardId)).cards.map((card) => [card.id, card]));
    expect(cards.get(toBacklog.open.id)!.sprint_id).toBeNull();
    expect(cards.get(toBacklog.subtask.id)!.sprint_id).toBeNull();
    expect(cards.get(toBacklog.done.id)!.sprint_id).toBe(toBacklog.sprint.id);

    const chosen = await running("Carry chosen");
    const first = await addSprint(chosen.owner, chosen.boardId, "Sprint 13");
    const second = await addSprint(chosen.owner, chosen.boardId, "Sprint 14");
    expect((await call(chosen.owner, "POST", `/sprints/${chosen.sprint.id}/complete`, { carryTo: second.id })).body).toMatchObject({ carried: 2, target: { id: second.id } });
    expect(lastAudit("task.sprint_complete")).toMatchObject({ carryTo: "sprint", targetSprintId: second.id });
    expect((await boardOf(chosen.member, chosen.boardId)).sprints.find((item) => item.id === first.id)!.card_count).toBe(0);

    const fresh = await running("Carry new");
    // No planned sprint: "next" is refused and nothing changes.
    expect(await call(fresh.owner, "POST", `/sprints/${fresh.sprint.id}/complete`, { carryTo: "next" })).toMatchObject({ status: 409, body: { code: "NO_NEXT_SPRINT" } });
    expect((await boardOf(fresh.member, fresh.boardId)).sprints[0]).toMatchObject({ id: fresh.sprint.id, state: "active" });
    // A sprint of another board, the active sprint itself, or an unknown id is 404; a name without "new" is 400.
    const theirs = await foreignSprint();
    expect((await call(fresh.owner, "POST", `/sprints/${fresh.sprint.id}/complete`, { carryTo: theirs.id })).status).toBe(404);
    expect((await call(fresh.owner, "POST", `/sprints/${fresh.sprint.id}/complete`, { carryTo: fresh.sprint.id })).status).toBe(404);
    expect((await call(fresh.owner, "POST", `/sprints/${fresh.sprint.id}/complete`, { carryTo: "backlog", name: "X" })).status).toBe(400);
    expect((await call(fresh.owner, "POST", `/sprints/${fresh.sprint.id}/complete`, { carryTo: "later" })).status).toBe(400);
    const made = await call(fresh.owner, "POST", `/sprints/${fresh.sprint.id}/complete`, { carryTo: "new" });
    // Completed before its end date: the new sprint starts today, as long as this one (QA NOTE-a).
    const expected = sprintDatesAfterCompleting({ start_on: "2026-09-21", end_on: "2026-10-04" }, new Date().toISOString().slice(0, 10));
    expect(made.body).toMatchObject({ carried: 2, created: true, target: { name: "Sprint 13", state: "planned", start_on: expected.startOn, end_on: expected.endOn, card_count: 2 } });
    expect(lastAudit("task.sprint_create")).toEqual({ boardId: fresh.boardId, sprintId: made.body.target.id });
    // A new sprint skips names the board already uses: Sprint 13 is taken, so it is Sprint 14.
    const taken = await running("Carry new taken");
    await addSprint(taken.owner, taken.boardId, "Sprint 13");
    expect((await call(taken.owner, "POST", `/sprints/${taken.sprint.id}/complete`, { carryTo: "new" })).body.target.name).toBe("Sprint 14");
    const named = await running("Carry new named");
    const custom = await call(named.owner, "POST", `/sprints/${named.sprint.id}/complete`, { carryTo: "new", name: "Hardening", startOn: "2026-11-01", endOn: null });
    expect(custom.body.target).toMatchObject({ name: "Hardening", start_on: "2026-11-01", end_on: null });
  });

  test("a move racing the completion is serialized by the board lock: a card is either done and stays, or open and carried (T118)", async () => {
    const { owner, member, boardId, columns, sprint, open } = await running("Race");
    const next = await addSprint(owner, boardId, "Sprint 13");
    const [moved, completed] = await Promise.all([
      call(member, "POST", `/cards/${open.id}/move`, { columnId: columns[2].id, afterCardId: null }),
      call(owner, "POST", `/sprints/${sprint.id}/complete`, { carryTo: "next" })
    ]);
    expect(moved.status).toBe(200);
    expect(completed.status).toBe(200);
    const card = (await boardOf(member, boardId)).cards.find((item) => item.id === open.id)!;
    expect(card.column_id).toBe(columns[2].id);
    // Whichever ran first, the result is consistent with it.
    if (card.sprint_id === sprint.id) expect(completed.body.doneCount).toBe(2);
    else expect(card.sprint_id).toBe(next.id);
  });
});

describe("structure changes and finished sprints (review L4)", () => {
  test("cards in completed sprints keep their sprint and do not block sprints off or a new work level; open sprints still do", async () => {
    const { owner, member, boardId, columns } = await setup("Finished sprints");
    const finished = await addSprint(owner, boardId, "Finished");
    const done = await addCard(member, boardId, columns[2].id, "Shipped", { sprintId: finished.id });
    db.query("UPDATE board_sprints SET state = 'closed', closed_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", finished.id);
    const planned = await addSprint(owner, boardId, "Next");
    const pending = await addCard(member, boardId, columns[0].id, "Pending", { sprintId: planned.id });
    const subtaskWork = { ...SPRINT_TASKS, workLevel: 1 };
    // A card in an open sprint still blocks moving the work level.
    expect(await call(owner, "PATCH", `/boards/${boardId}`, { structure: subtaskWork })).toMatchObject({ status: 409, body: { code: "SPRINTS_IN_USE", cardCount: 1 } });
    expect((await call(member, "PATCH", `/cards/${pending.id}`, { sprintId: null, revision: pending.revision })).status).toBe(200);
    expect((await call(owner, "DELETE", `/sprints/${planned.id}`)).status).toBe(200);
    // Only the finished sprint's card has a sprint now: it blocks neither change, and keeps its sprint.
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...SPRINT_TASKS, sprints: false } })).status).toBe(200);
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...subtaskWork, sprints: false } })).status).toBe(200);
    expect(db.query("SELECT sprint_id FROM cards WHERE id = ?").get(done.id)).toEqual({ sprint_id: finished.id });
  });
});
