import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { cardFilterFromQuery, format, matchesQuery, parse, queryCards, queryFromCardFilter, type CardFilter, type MemoryQueryCard, type QueryCard } from "../shared/taskQuery";
import { hydrateBoard, type BoardPayload } from "../src/tasks/tasksApi";

const { filterBoardCardIds } = await import("../server/tasks/cardQuery");
const { runQuery } = await import("../server/tasks/query");

/**
 * One grammar (research 2026-09-26 §10.3, §10.6): a Wave 13 structured filter
 * and its canonical text form select the same cards through the board
 * pipeline (client, `shared/taskQuery.ts`), the board SQL (`list_cards`,
 * `server/tasks/cardQuery.ts`), and the cross-board query
 * (`server/tasks/query.ts`) scoped to the board. The `has:` filters agree
 * with the board payload's `relation_count` and `open_blockers`.
 */

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

let owner: Session;
let member: Session;
let boardId: string;
let otherBoardId: string;
let columns: Array<{ id: string; position: number }>;
let tagA: string;
let tagB: string;
const cardIds: Record<string, string> = {};
const stamp = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  owner = await createUser("Parity owner");
  member = await createUser("Parity member");
  const created = await call(owner, "POST", "/boards", { name: "Parity board" });
  boardId = created.body.board.id;
  columns = created.body.columns;
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const other = await call(member, "POST", "/boards", { name: "Parity private" });
  otherBoardId = other.body.board.id;
  const specs: Array<[string, number, string[], string | null]> = [
    ["Alpha invoice", 0, [owner.userId], "2026-10-01"],
    ["Beta", 0, [], null],
    ["Gamma", 1, [member.userId], "2026-10-05"],
    ["Delta invoice", 1, [owner.userId, member.userId], "2026-09-20"],
    ["Epsilon", 2, [], "2026-10-10"],
    ["Zeta", 2, [member.userId], null]
  ];
  for (const [title, column, assigneeIds, dueOn] of specs) {
    const card = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[column]!.id, title, assigneeIds, ...(dueOn ? { dueOn } : {}) });
    expect(card.status).toBe(201);
    cardIds[title] = card.body.card.id;
  }
  tagA = crypto.randomUUID();
  tagB = crypto.randomUUID();
  db.query("INSERT INTO board_tags (id, board_id, name, created_at, updated_at) VALUES (?, ?, 'Backend', ?, ?)").run(tagA, boardId, stamp, stamp);
  db.query("INSERT INTO board_tags (id, board_id, name, created_at, updated_at) VALUES (?, ?, 'Design', ?, ?)").run(tagB, boardId, stamp, stamp);
  const tag = db.query("INSERT INTO card_tags (card_id, tag_id, created_at) VALUES (?, ?, ?)");
  tag.run(cardIds["Alpha invoice"]!, tagA, stamp);
  tag.run(cardIds.Gamma!, tagA, stamp);
  tag.run(cardIds.Gamma!, tagB, stamp);
  const flag = db.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)");
  flag.run(cardIds.Beta!, "urgent", stamp);
  flag.run(cardIds.Gamma!, "blocked", stamp);
  db.query("UPDATE cards SET description_excerpt = 'pay the plumber' WHERE id = ?").run(cardIds.Zeta!);
  // Relations: Beta depends on Gamma (open), Epsilon depends on Zeta (done column), Alpha relates to a card the owner cannot read.
  const privateCard = await call(member, "POST", `/boards/${otherBoardId}/cards`, { columnId: other.body.columns[0].id, title: "Hidden" });
  const relate = db.query("INSERT INTO card_relations (id, source_card_id, target_card_id, kind, created_at) VALUES (?, ?, ?, ?, ?)");
  relate.run(crypto.randomUUID(), cardIds.Gamma!, cardIds.Beta!, "blocks", stamp);
  relate.run(crypto.randomUUID(), cardIds.Zeta!, cardIds.Epsilon!, "blocks", stamp);
  const [low, high] = [cardIds["Alpha invoice"]!, privateCard.body.card.id as string].sort();
  relate.run(crypto.randomUUID(), low, high, "relates", stamp);
});

const filters: CardFilter[] = [
  {},
  { assignees: ["me"] },
  { assignees: ["none"] },
  { assignees: ["me", "none"] },
  { assignees: [crypto.randomUUID()] },
  { tags: ["TAG_A"] },
  { tags: ["none"] },
  { tags: ["TAG_A", "TAG_B"], flags: ["blocked"] },
  { flags: ["urgent", "none"] },
  { flags: ["none"] },
  { due: { before: "2026-10-05" } },
  { due: { after: "2026-10-01" } },
  { due: { before: "2026-10-10", after: "2026-09-20" } },
  { due: { before: "2026-10-05", none: true } },
  { due: { none: true } },
  { columns: ["COL_1"] },
  { columns: ["COL_0", "COL_2"], assignees: ["me"] },
  { text: "invoice" },
  { text: "PLUMBER" },
  { text: "invoice", due: { after: "2026-09-25" }, assignees: ["me"] }
];

const resolve = (filter: CardFilter): CardFilter => JSON.parse(JSON.stringify(filter)
  .replaceAll("TAG_A", tagA).replaceAll("TAG_B", tagB)
  .replaceAll("COL_0", columns[0]!.id).replaceAll("COL_1", columns[1]!.id).replaceAll("COL_2", columns[2]!.id));

describe("one grammar across the board pipeline, list_cards SQL, and the cross-board query", () => {
  test.each(filters.map((filter, index) => [index, filter] as const))("filter %i gives the same cards everywhere", async (_index, template) => {
    const filter = resolve(template);
    const board = hydrateBoard((await call(owner, "GET", `/boards/${boardId}`)).body as BoardPayload);
    const client = queryCards(board.cards as QueryCard[], board.columns, filter, { userId: owner.userId }).map((card) => card.id).sort();
    const boardSql = filterBoardCardIds(boardId, filter, { userId: owner.userId }).sort();
    const text = format(queryFromCardFilter(filter));
    const parsed = parse(`board:${boardId} ${text}`);
    if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
    const crossBoard = runQuery(owner.userId, parsed.query, { tz: "UTC", limit: 100 }).cards.map((card) => card.id).sort();
    expect(boardSql).toEqual(client);
    expect(crossBoard).toEqual(client);
    // The structured filter survives the round trip through its text form.
    const back = cardFilterFromQuery(parse(text, { boardScoped: true }).ok ? (parse(text, { boardScoped: true }) as { ok: true; query: never }).query : { terms: [] });
    expect(back).not.toBeNull();
    expect(queryCards(board.cards as QueryCard[], board.columns, back!, { userId: owner.userId }).map((card) => card.id).sort()).toEqual(client);
  });

  test("has:relation and has:blocked match relation_count and open_blockers on the board", async () => {
    for (const viewer of [owner, member]) {
      const board = (await call(viewer, "GET", `/boards/${boardId}`)).body;
      const expectIds = (predicate: (card: { relation_count: number; open_blockers: number }) => boolean) =>
        (board.cards as Array<{ id: string; relation_count: number; open_blockers: number }>).filter(predicate).map((card) => card.id).sort();
      const run = (text: string) => {
        const parsed = parse(`board:${boardId} ${text}`);
        if (!parsed.ok) throw new Error(parsed.error.message);
        return runQuery(viewer.userId, parsed.query, { tz: "UTC", limit: 100 }).cards.map((card) => card.id).sort();
      };
      expect(run("has:relation")).toEqual(expectIds((card) => card.relation_count > 0));
      expect(run("-has:relation")).toEqual(expectIds((card) => card.relation_count === 0));
      expect(run("has:blocked")).toEqual(expectIds((card) => card.open_blockers > 0));
    }
    // Binning the other board hides nothing from the owner (not in its audience) but hides the relation from its member.
    expect((await call(member, "DELETE", `/boards/${otherBoardId}`)).status).toBe(200);
    const alpha = cardIds["Alpha invoice"]!;
    const ownerRun = runQuery(owner.userId, (parse(`board:${boardId} has:relation`) as { ok: true; query: never }).query, { tz: "UTC" }).cards.map((card) => card.id);
    const memberRun = runQuery(member.userId, (parse(`board:${boardId} has:relation`) as { ok: true; query: never }).query, { tz: "UTC" }).cards.map((card) => card.id);
    expect(ownerRun).toContain(alpha);
    expect(memberRun).not.toContain(alpha);
    const memberBoard = (await call(member, "GET", `/boards/${boardId}`)).body.cards as Array<{ id: string; relation_count: number }>;
    expect(memberBoard.find((card) => card.id === alpha)!.relation_count).toBe(0);
  });

  test("queries the board pipeline cannot express map to null, not to a wider filter", () => {
    for (const text of ["-assignee:me", "state:todo", `board:${crypto.randomUUID()}`, "creator:me", "has:relation", "tag:Backend", "due:overdue",
      "due:today", "assignee:me assignee:none", '"a" "b"', "due:<2026-01-01 due:<2026-02-01", "due:<2026-01-01,none due:>2025-01-01", "due:2026-01-01"]) {
      const parsed = parse(text, { boardScoped: true });
      expect(parsed.ok).toBe(true);
      expect(cardFilterFromQuery((parsed as { ok: true; query: never }).query)).toBeNull();
    }
  });
});

describe("hierarchy keys (17A): the board's in-memory matcher and the cross-board query agree", () => {
  test("parent:, level:, and has:subtasks, positive and negated", async () => {
    const user = await createUser("Parity hierarchy");
    const created = await call(user, "POST", "/boards", { name: "Parity tree" });
    const treeBoard = created.body.board.id as string;
    const todo = created.body.columns[0].id as string;
    const structure = { levels: [{ name: "Epic", plural: "Epics" }, { name: "Story", plural: "Stories" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 1, sprints: false };
    expect((await call(user, "PATCH", `/boards/${treeBoard}`, { structure })).status).toBe(200);
    const add = async (title: string, extra: Record<string, unknown>) => (await call(user, "POST", `/boards/${treeBoard}/cards`, { columnId: todo, title, ...extra })).body.card.id as string;
    const epic = await add("Epic", { level: 0 });
    const story = await add("Story", { parentId: epic });
    await add("Subtask", { parentId: story });
    await add("Loose story", {});
    // A detached subtask (restored while its parent was in the Bin, D130): the API refuses to make one.
    db.query("UPDATE cards SET parent_card_id = NULL WHERE id = ?").run(await add("Loose subtask", { parentId: story }));
    const board = (await call(user, "GET", `/boards/${treeBoard}`)).body;
    for (const text of ["parent:none", `parent:${epic}`, `parent:${story},none`, "level:work", "level:0,2", "-level:work", "has:subtasks", "-has:subtasks", `level:1 parent:${epic}`]) {
      const parsed = parse(`board:${treeBoard} ${text}`);
      if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
      const memory = (board.cards as MemoryQueryCard[]).filter((card) => matchesQuery({ ...card, board_id: treeBoard } as MemoryQueryCard, parsed.query, { userId: user.userId, today: "2026-09-26", workLevel: 1 }))
        .map((card) => card.id).sort();
      const server = runQuery(user.userId, parsed.query, { tz: "UTC", limit: 100 }).cards.map((card) => card.id).sort();
      expect(server).toEqual(memory);
      expect(server.length).toBeGreaterThan(0);
    }
  });
});

describe("sprint key (17B): the board's in-memory matcher and the cross-board query agree", () => {
  test("sprint:current, next, none, and ids, positive and negated, with subtasks inheriting", async () => {
    const user = await createUser("Parity sprints");
    const created = await call(user, "POST", "/boards", { name: "Parity sprints", template: "scrum" });
    const sprintBoard = created.body.board.id as string;
    const todo = created.body.columns[0].id as string;
    const done = created.body.columns[4].id as string;
    const first = (await call(user, "GET", `/boards/${sprintBoard}`)).body.sprints[0].id as string;
    expect((await call(user, "PATCH", `/sprints/${first}`, { state: "active" })).status).toBe(200);
    const next = (await call(user, "POST", `/boards/${sprintBoard}/sprints`, { name: "Sprint 2" })).body.sprint.id as string;
    const later = (await call(user, "POST", `/boards/${sprintBoard}/sprints`, { name: "Sprint 3" })).body.sprint.id as string;
    const add = async (title: string, extra: Record<string, unknown>) => (await call(user, "POST", `/boards/${sprintBoard}/cards`, { columnId: todo, title, ...extra })).body.card.id as string;
    const task = await add("Current task", { sprintId: first });
    await add("Its subtask", { parentId: task });
    await add("Shipped", { sprintId: first, columnId: done });
    const nextTask = await add("Next task", { sprintId: next });
    await add("Next subtask", { parentId: nextTask });
    await add("Later task", { sprintId: later });
    await add("Backlog task", {});
    // A detached subtask (restored while its parent was in the Bin, D130): the API refuses to make one.
    db.query("UPDATE cards SET parent_card_id = NULL WHERE id = ?").run(await add("Loose subtask", { parentId: nextTask }));
    // A second board with its own active sprint: `current` is per board.
    const other = await call(user, "POST", "/boards", { name: "Parity sprints two", template: "scrum" });
    const otherSprint = (await call(user, "GET", `/boards/${other.body.board.id}`)).body.sprints[0].id as string;
    await call(user, "PATCH", `/sprints/${otherSprint}`, { state: "active" });
    await call(user, "POST", `/boards/${other.body.board.id}/cards`, { columnId: other.body.columns[0].id, title: "Other current", sprintId: otherSprint });

    const board = (await call(user, "GET", `/boards/${sprintBoard}`)).body;
    const sprints = { current: first, next };
    for (const text of ["sprint:current", "sprint:next", "sprint:none", "sprint:backlog", `sprint:${later}`, `sprint:${later},none`, "-sprint:current", "-sprint:none", "sprint:current state:done", "sprint:current,next"]) {
      const parsed = parse(`board:${sprintBoard} ${text}`);
      if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
      const memory = (board.cards as MemoryQueryCard[]).filter((card) => matchesQuery({ ...card, board_id: sprintBoard } as MemoryQueryCard, parsed.query,
        { userId: user.userId, today: "2026-09-26", workLevel: 0, sprints, columnStates: Object.fromEntries(board.columns.map((column: { id: string; state: "todo" | "doing" | "done" }) => [column.id, column.state])) }))
        .map((card) => card.id).sort();
      const server = runQuery(user.userId, parsed.query, { tz: "UTC", limit: 100 }).cards.map((card) => card.id).sort();
      expect(server).toEqual(memory);
      expect(server.length).toBeGreaterThan(0);
    }
    // Across boards, `current` matches each board's own active sprint; cards carry the sprint name.
    const across = runQuery(user.userId, parse("sprint:current").ok ? (parse("sprint:current") as { ok: true; query: never }).query : { terms: [] }, { tz: "UTC", limit: 100 }).cards;
    expect(across.map((card) => card.title).sort()).toEqual(["Current task", "Its subtask", "Other current", "Shipped"]);
    expect(across.find((card) => card.title === "Its subtask")).toMatchObject({ sprint_id: first, sprint_name: "Sprint 1" });
  });
});
