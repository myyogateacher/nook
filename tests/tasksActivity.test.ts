import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { upload } from "./support/attachments";
import { CARD_ACTIVITY_KIND_NAMES, type CardActivityEntry } from "../shared/cardActivity";

const { createMcpApiKey } = await import("../server/mcp");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { purgeTaskItem, restoreTaskItem } = await import("../server/tasks/bin");
const { sweepAutoArchive } = await import("../server/tasks/archive");
const { recordCardActivity } = await import("../server/tasks/activity");

/** Card activity history (lane ACTIVITY, D740–D746, migration 081). */

type Column = { id: string; name: string };
type Card = { id: string; revision: number; column_id: string };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

// One owner, member, and stranger for the whole file (the suite shares a bounded pool of test accounts).
let people: { owner: Session; member: Session; stranger: Session } | null = null;
async function users() {
  people ??= { owner: await createUser("Activity owner"), member: await createUser("Activity member"), stranger: await createUser("Activity stranger") };
  return people;
}

const SPRINT_TASKS = { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: true };

async function setup(label: string, structure?: object) {
  const { owner, member, stranger } = await users();
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  if (structure) expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure })).status).toBe(200);
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  return { owner, member, stranger, boardId, columns };
}

async function addCard(session: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as Card;
}

const revision = (cardId: string) => (db.query("SELECT revision FROM cards WHERE id = ?").get(cardId) as { revision: number }).revision;
async function patch(session: Session, cardId: string, body: Record<string, unknown>) {
  const result = await call(session, "PATCH", `/cards/${cardId}`, { ...body, revision: revision(cardId) });
  expect(result.status).toBe(200);
  return result.body.card as Card;
}

/** Oldest first, straight from the table. */
const stored = (cardId: string) => (db.query("SELECT kind, actor_id, via, payload FROM card_activity WHERE card_id = ? ORDER BY created_at, id").all(cardId) as Array<{ kind: string; actor_id: string | null; via: string | null; payload: string }>)
  .map((row) => ({ kind: row.kind, actor: row.actor_id, via: row.via, ...JSON.parse(row.payload) as Record<string, unknown> }));
const kinds = (cardId: string) => stored(cardId).map((row) => row.kind);
/** Moves every entry of the card back past the coalescing window, as if the edits were minutes apart. */
const age = (cardId: string) => db.query("UPDATE card_activity SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-5 minutes') WHERE card_id = ?").run(cardId);

async function history(session: Session, cardId: string, query = "") {
  return call(session, "GET", `/cards/${cardId}/activity${query}`);
}

describe("recording each kind", () => {
  test("created, title, description, column, assignees, due, tags, flags, archive, and Bin are recorded with snapshots", async () => {
    const { owner, member, boardId, columns } = await setup("Kinds");
    const card = await addCard(owner, boardId, columns[0].id, "Draft");
    expect(stored(card.id)).toEqual([{ kind: "created", actor: owner.userId, via: null, from: null, to: { id: columns[0].id, label: columns[0].name } }]);

    await patch(owner, card.id, { title: "Ship it" });
    await patch(owner, card.id, { description: "Some **text**" });
    // Saving the same description again records nothing.
    await patch(owner, card.id, { description: "Some **text**" });
    expect(kinds(card.id)).toEqual(["created", "title", "description"]);
    expect(stored(card.id)[1]).toMatchObject({ from: { label: "Draft" }, to: { label: "Ship it" } });

    expect((await call(owner, "POST", `/cards/${card.id}/move`, { columnId: columns[1].id, afterCardId: null })).status).toBe(200);
    // A reorder within the column is not history.
    expect((await call(owner, "POST", `/cards/${card.id}/move`, { columnId: columns[1].id, afterCardId: null })).status).toBe(200);
    expect(stored(card.id).at(-1)).toMatchObject({ kind: "column", from: { id: columns[0].id, label: columns[0].name }, to: { id: columns[1].id, label: columns[1].name } });

    await patch(owner, card.id, { assigneeIds: [owner.userId, member.userId] });
    await patch(owner, card.id, { assigneeIds: [member.userId] });
    const assignees = stored(card.id).filter((row) => row.kind.startsWith("assignee_"));
    expect(assignees.map((row) => [row.kind, (row.item as { id: string }).id])).toEqual([
      ["assignee_added", owner.userId], ["assignee_added", member.userId], ["assignee_removed", owner.userId]
    ]);

    await patch(owner, card.id, { dueOn: "2026-12-01" });
    age(card.id);
    await patch(owner, card.id, { dueOn: "2026-12-02", dueTime: "14:30", dueTz: "Europe/Paris" });
    age(card.id);
    await patch(owner, card.id, { dueOn: null });
    const due = stored(card.id).filter((row) => row.kind === "due");
    expect(due).toEqual([
      expect.objectContaining({ from: null, to: { id: "2026-12-01", label: "2026-12-01" } }),
      expect.objectContaining({ from: { id: "2026-12-01", label: "2026-12-01" }, to: { id: "2026-12-02T14:30", label: "2026-12-02 14:30", detail: "Europe/Paris" } }),
      expect.objectContaining({ from: { id: "2026-12-02T14:30", label: "2026-12-02 14:30", detail: "Europe/Paris" }, to: null })
    ]);

    const tag = (await call(owner, "POST", `/boards/${boardId}/tags`, { name: "Backend" })).body.tag as { id: string };
    await patch(owner, card.id, { tagIds: [tag.id], flags: ["blocked"] });
    await patch(owner, card.id, { tagIds: [], flags: [] });
    // Deleting the tag later keeps the history readable.
    expect((await call(owner, "DELETE", `/tags/${tag.id}`)).status).toBe(200);
    expect(stored(card.id).filter((row) => /^(tag|flag)_/.test(row.kind)).map((row) => [row.kind, row.item])).toEqual([
      ["tag_added", { id: tag.id, label: "Backend" }], ["flag_set", { id: "blocked", label: "blocked" }],
      ["tag_removed", { id: tag.id, label: "Backend" }], ["flag_cleared", { id: "blocked", label: "blocked" }]
    ]);

    expect((await call(owner, "POST", `/cards/${card.id}/archive`)).status).toBe(200);
    expect((await call(owner, "POST", `/cards/${card.id}/unarchive`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/cards/${card.id}`)).status).toBe(200);
    expect(await restoreTaskItem("card", card.id, owner.userId)).toMatchObject({ status: "restored" });
    expect(kinds(card.id).slice(-4)).toEqual(["archived", "unarchived", "binned", "restored"]);

    // The reader sees names as they are now and the kinds they know.
    const page = await history(member, card.id);
    expect(page.status).toBe(200);
    const entries = page.body.activity as CardActivityEntry[];
    expect(entries[0]).toMatchObject({ kind: "restored", actor_id: owner.userId, actor_name: "Activity owner", via: null });
    expect(entries.every((entry) => CARD_ACTIVITY_KIND_NAMES.includes(entry.kind))).toBe(true);
  });

  test("the auto-archive sweep is recorded as Nook itself", async () => {
    const { owner, boardId, columns } = await setup("Sweep");
    const card = await addCard(owner, boardId, columns[2].id, "Old and done");
    db.query("UPDATE cards SET done_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), card.id);
    expect(sweepAutoArchive()).toBeGreaterThanOrEqual(1);
    expect(stored(card.id).at(-1)).toMatchObject({ kind: "archived", actor: null, via: "system" });
  });

  test("parent, level, and sprint changes, and a sprint's carry-over", async () => {
    const { owner, boardId, columns } = await setup("Plan", SPRINT_TASKS);
    const sprint = (await call(owner, "POST", `/boards/${boardId}/sprints`, { name: "Sprint A" })).body.sprint as { id: string };
    const next = (await call(owner, "POST", `/boards/${boardId}/sprints`, { name: "Sprint B" })).body.sprint as { id: string };
    const parent = await addCard(owner, boardId, columns[0].id, "Parent task");
    const task = await addCard(owner, boardId, columns[0].id, "Child task");
    await patch(owner, task.id, { sprintId: sprint.id });
    age(task.id);
    await patch(owner, task.id, { parentId: parent.id, level: 1 });
    const rows = stored(task.id);
    expect(rows.find((row) => row.kind === "sprint")).toMatchObject({ from: null, to: { id: sprint.id, label: "Sprint A" } });
    // Becoming a subtask: level and parent, and its stored sprint is cleared (it follows the parent's).
    expect(rows.find((row) => row.kind === "level")).toMatchObject({ from: { id: "0", label: "Task" }, to: { id: "1", label: "Subtask" } });
    expect(rows.find((row) => row.kind === "parent")).toMatchObject({ from: null, to: { id: parent.id, label: "Parent task" } });
    expect(rows.filter((row) => row.kind === "sprint").at(-1)).toMatchObject({ from: { id: sprint.id }, to: null });
    await patch(owner, task.id, { parentId: null, level: 0 });
    expect(stored(task.id).filter((row) => row.kind === "parent").at(-1)).toMatchObject({ from: { id: parent.id }, to: null });

    // Completing a sprint carries the unfinished card, and its history says so.
    await patch(owner, parent.id, { sprintId: sprint.id });
    age(parent.id);
    expect((await call(owner, "PATCH", `/sprints/${sprint.id}`, { state: "active" })).status).toBe(200);
    const completed = await call(owner, "POST", `/sprints/${sprint.id}/complete`, { carryTo: next.id });
    expect(completed.status).toBe(200);
    expect(stored(parent.id).at(-1)).toMatchObject({ kind: "sprint", from: { id: sprint.id, label: "Sprint A" }, to: { id: next.id, label: "Sprint B" } });
  });

  test("relations are recorded on both cards, and a reader who cannot open the other card sees no title", async () => {
    const { owner, member, boardId, columns } = await setup("Links");
    const card = await addCard(owner, boardId, columns[0].id, "Here");
    const other = await addCard(owner, boardId, columns[0].id, "There");
    const privateBoard = (await call(owner, "POST", "/boards", { name: "Links private" })).body as { board: { id: string }; columns: Column[] };
    const secret = await addCard(owner, privateBoard.board.id, privateBoard.columns[0]!.id, "Secret plan");

    const linked = await call(owner, "POST", `/cards/${card.id}/relations`, { cardId: other.id, type: "depends_on" });
    expect(linked.status).toBe(201);
    expect(stored(card.id).at(-1)).toMatchObject({ kind: "relation_added", item: { id: other.id, label: "There", detail: "depends_on" } });
    expect(stored(other.id).at(-1)).toMatchObject({ kind: "relation_added", item: { id: card.id, label: "Here", detail: "needed_by" } });
    expect((await call(owner, "DELETE", `/cards/${card.id}/relations/${linked.body.relation.id}`)).status).toBe(200);
    expect(stored(other.id).at(-1)).toMatchObject({ kind: "relation_removed", item: { id: card.id, detail: "needed_by" } });

    expect((await call(owner, "POST", `/cards/${card.id}/relations`, { cardId: secret.id, type: "relates_to" })).status).toBe(201);
    const ownerView = (await history(owner, card.id)).body.activity as CardActivityEntry[];
    expect(ownerView[0]!.payload.item).toEqual({ id: secret.id, label: "Secret plan", detail: "relates_to" });
    const memberView = (await history(member, card.id)).body.activity as CardActivityEntry[];
    expect(memberView[0]!.payload.item).toEqual({ label: "a card you can't open", detail: "relates_to" });
    expect(JSON.stringify(memberView)).not.toContain("Secret plan");
  });

  test("card files are recorded with their names; a comment's files are not", async () => {
    const { owner, boardId, columns } = await setup("Files");
    const card = await addCard(owner, boardId, columns[0].id, "With files");
    const file = await upload(owner, "plan.txt", "The plan", { attachTo: "card" });
    expect(file.status).toBe(201);
    expect((await call(owner, "POST", `/cards/${card.id}/attachments`, { documentId: file.id })).status).toBe(201);
    expect(stored(card.id).at(-1)).toMatchObject({ kind: "attachment_added", item: { id: file.id, label: "plan.txt" } });
    expect((await call(owner, "DELETE", `/cards/${card.id}/attachments/${file.id}`)).status).toBe(200);
    expect(stored(card.id).at(-1)).toMatchObject({ kind: "attachment_removed", item: { id: file.id, label: "plan.txt" } });

    const commentFile = await upload(owner, "photo.txt", "A photo", { attachTo: "card" });
    expect((await call(owner, "POST", `/cards/${card.id}/comments`, { body: "See this", attachmentIds: [commentFile.id] })).status).toBe(201);
    expect(kinds(card.id).at(-1)).toBe("attachment_removed");
    // Removing a comment's file is not recorded either (its attach never was): from the card, or by
    // its owner through /api/attachments.
    const before = kinds(card.id).length;
    expect((await call(owner, "DELETE", `/cards/${card.id}/attachments/${commentFile.id}`)).status).toBe(200);
    const ownerFile = await upload(owner, "scan.txt", "A scan", { attachTo: "card" });
    expect((await call(owner, "POST", `/cards/${card.id}/comments`, { body: "And this", attachmentIds: [ownerFile.id] })).status).toBe(201);
    const withdrawn = await request(`/attachments/card/${card.id}/${ownerFile.id}`, { method: "DELETE", body: "{}" }, owner);
    expect(withdrawn.status).toBe(200);
    expect(kinds(card.id).length).toBe(before);
  });
});

describe("coalescing and atomicity", () => {
  test("repeat edits of one field by one person within two minutes are one entry; going back drops it", async () => {
    const { owner, member, boardId, columns } = await setup("Coalesce");
    const card = await addCard(owner, boardId, columns[0].id, "Dragged");
    for (const column of [columns[1], columns[2]]) expect((await call(owner, "POST", `/cards/${card.id}/move`, { columnId: column.id, afterCardId: null })).status).toBe(200);
    expect(stored(card.id).filter((row) => row.kind === "column")).toEqual([
      expect.objectContaining({ from: { id: columns[0].id, label: columns[0].name }, to: { id: columns[2].id, label: columns[2].name } })
    ]);
    // Another person's change is its own entry.
    expect((await call(member, "POST", `/cards/${card.id}/move`, { columnId: columns[1].id, afterCardId: null })).status).toBe(200);
    expect(stored(card.id).filter((row) => row.kind === "column")).toHaveLength(2);
    // Back where it started: the folded entry goes.
    expect((await call(member, "POST", `/cards/${card.id}/move`, { columnId: columns[2].id, afterCardId: null })).status).toBe(200);
    expect(stored(card.id).filter((row) => row.kind === "column")).toHaveLength(1);
    // Past the window, a new entry.
    age(card.id);
    expect((await call(owner, "POST", `/cards/${card.id}/move`, { columnId: columns[0].id, afterCardId: null })).status).toBe(200);
    expect(stored(card.id).filter((row) => row.kind === "column")).toHaveLength(2);
    // Three title edits in a row: one entry, first title to last.
    await patch(owner, card.id, { title: "One" });
    await patch(owner, card.id, { title: "Two" });
    expect(stored(card.id).filter((row) => row.kind === "title")).toEqual([expect.objectContaining({ from: { label: "Dragged" }, to: { label: "Two" } })]);
  });

  test("a refused change records nothing", async () => {
    const { owner, stranger, boardId, columns } = await setup("Atomic");
    const before = (db.query("SELECT COUNT(*) AS count FROM card_activity").get() as { count: number }).count;
    // The attachment check fails inside the create's transaction, after the card row was written.
    const refused = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Never", attachmentIds: [crypto.randomUUID()] });
    expect(refused.status).toBe(404);
    expect((db.query("SELECT COUNT(*) AS count FROM card_activity").get() as { count: number }).count).toBe(before);
    expect(db.query("SELECT 1 FROM cards WHERE title = 'Never'").get()).toBeNull();

    const card = await addCard(owner, boardId, columns[0].id, "Kept");
    const count = kinds(card.id).length;
    // A stale revision, a non-reader, and an unknown assignee change nothing.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { title: "Stale", revision: card.revision + 5 })).status).toBe(409);
    expect((await call(stranger, "PATCH", `/cards/${card.id}`, { title: "Theirs", revision: card.revision })).status).toBe(404);
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { title: "Who", assigneeIds: [stranger.userId], revision: card.revision })).status).toBe(400);
    expect(kinds(card.id)).toHaveLength(count);
    // A transaction that fails after recording rolls the entry back with it.
    expect(() => db.transaction(() => {
      recordCardActivity({ cardId: card.id, boardId, actorId: owner.userId, kind: "title", payload: { from: { label: "a" }, to: { label: "b" } } });
      throw new Error("boom");
    })()).toThrow("boom");
    expect(kinds(card.id)).toHaveLength(count);
  });
});

describe("reading the history", () => {
  test("readers page it newest or oldest first; non-readers get 404; bad parameters are 400", async () => {
    const { owner, member, stranger, boardId, columns } = await setup("Paging");
    const card = await addCard(owner, boardId, columns[0].id, "Paged");
    for (const [index, title] of ["A", "B", "C", "D"].entries()) {
      await patch(index % 2 ? member : owner, card.id, { title });
      age(card.id);
    }
    const all = kinds(card.id);
    expect(all).toEqual(["created", "title", "title", "title", "title"]);

    const first = await history(member, card.id, "?limit=2");
    expect(first.status).toBe(200);
    expect((first.body.activity as CardActivityEntry[]).map((entry) => entry.payload.to?.label)).toEqual(["D", "C"]);
    const second = await history(member, card.id, `?limit=2&cursor=${first.body.next}`);
    expect((second.body.activity as CardActivityEntry[]).map((entry) => entry.payload.to?.label)).toEqual(["B", "A"]);
    const third = await history(member, card.id, `?limit=2&cursor=${second.body.next}`);
    expect((third.body.activity as CardActivityEntry[]).map((entry) => entry.kind)).toEqual(["created"]);
    expect(third.body.next).toBeNull();

    const ascending = await history(owner, card.id, "?order=asc&limit=3");
    expect((ascending.body.activity as CardActivityEntry[]).map((entry) => entry.kind)).toEqual(["created", "title", "title"]);
    const rest = await history(owner, card.id, `?order=asc&limit=3&cursor=${ascending.body.next}`);
    expect((rest.body.activity as CardActivityEntry[]).map((entry) => entry.payload.to?.label)).toEqual(["C", "D"]);
    expect(rest.body.next).toBeNull();
    // The web payload carries each actor's picture field.
    expect(ascending.body.activity[0]).toHaveProperty("actor_avatar_url");

    expect((await history(stranger, card.id)).status).toBe(404);
    expect((await history(undefined, card.id)).status).toBe(401);
    expect((await history(owner, crypto.randomUUID())).status).toBe(404);
    expect((await history(owner, card.id, "?order=sideways")).status).toBe(400);
    expect((await history(owner, card.id, "?limit=0")).status).toBe(400);
    expect((await history(owner, card.id, "?limit=101")).status).toBe(400);
    expect((await history(owner, card.id, "?cursor=nope")).status).toBe(400);
  });

  test("MCP and REST changes are recorded with their surface, and get_card_activity reads the history", async () => {
    const { owner, stranger, boardId, columns } = await setup("Surfaces");
    const card = await addCard(owner, boardId, columns[0].id, "Remote");
    const key = createApiKey(owner.userId, { name: "Activity agent", surfaces: "both", grants: [{ module: "tasks", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const run = async (name: string, args: Record<string, unknown>, surface: "mcp" | "rest" = "mcp") => {
      const result = JSON.parse((await invokeMcpToolForTests(name, args, key.id, surface)).content[0]!.text) as Record<string, any>;
      expect(result.code).toBeUndefined();
      return result;
    };
    await run("update_card", { cardId: card.id, title: "Via MCP", baseRevision: revision(card.id) });
    await run("move_card", { cardId: card.id, columnId: columns[1].id }, "rest");
    expect(stored(card.id).slice(-2)).toMatchObject([{ kind: "title", via: "mcp", actor: owner.userId }, { kind: "column", via: "rest" }]);
    // An MCP edit does not fold into the web app's (another surface).
    await patch(owner, card.id, { title: "Via web" });
    expect(stored(card.id).filter((row) => row.kind === "title").map((row) => row.via)).toEqual(["mcp", null]);

    const page = await run("get_card_activity", { cardId: card.id, order: "asc", limit: 2 });
    expect(page.activity.map((entry: CardActivityEntry) => entry.kind)).toEqual(["created", "title"]);
    expect(typeof page.next).toBe("string");
    expect((await run("get_card_activity", { cardId: card.id, cursor: page.next, order: "asc" })).activity.map((entry: CardActivityEntry) => entry.kind)).toEqual(["column", "title"]);
    const strangerKey = createMcpApiKey(stranger.userId, "Stranger agent", ["tasks:read"]);
    const refused = JSON.parse((await invokeMcpToolForTests("get_card_activity", { cardId: card.id }, strangerKey.id, "mcp")).content[0]!.text);
    expect(refused.code).toBe("NOT_FOUND");
  });
});

describe("purge", () => {
  test("purging a card from the Bin deletes its history, and its subtasks' too", async () => {
    const { owner, boardId, columns } = await setup("Purge", SPRINT_TASKS);
    const card = await addCard(owner, boardId, columns[0].id, "Doomed");
    const child = await addCard(owner, boardId, columns[0].id, "Doomed child", { parentId: card.id });
    await patch(owner, child.id, { title: "Doomed child renamed" });
    const keep = await addCard(owner, boardId, columns[0].id, "Survivor");
    const entries = (cardId: string) => (db.query("SELECT COUNT(*) AS count FROM card_activity WHERE card_id = ?").get(cardId) as { count: number }).count;
    expect(entries(card.id)).toBeGreaterThan(0);
    expect(entries(child.id)).toBe(2);
    expect((await call(owner, "DELETE", `/cards/${card.id}`)).status).toBe(200);
    expect(stored(card.id).at(-1)).toMatchObject({ kind: "binned", count: 1 });
    expect(await purgeTaskItem("card", card.id, owner.userId)).toBe("purged");
    expect(entries(card.id)).toBe(0);
    expect(entries(child.id)).toBe(0);
    expect(entries(keep.id)).toBe(1);

    // Purging a whole board takes every card's history with it.
    expect((await call(owner, "DELETE", `/boards/${boardId}`)).status).toBe(200);
    expect(await purgeTaskItem("board", boardId, owner.userId)).toBe("purged");
    expect(entries(keep.id)).toBe(0);
  });
});
