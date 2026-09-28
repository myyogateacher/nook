import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

/** Card hierarchy (research 2026-09-26 §6, D120–D135, T110–T114): parent and level, roll-ups, Bin subtrees, structure. */

type Column = { id: string; name: string; position: number; is_done: 0 | 1 };
type Card = { id: string; board_id: string; column_id: string; title: string; revision: number; parent_card_id: string | null; level: number; child_count: number; done_child_count: number };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(path.startsWith("/bin") ? path : `/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const EPICS = { levels: [{ name: "Epic", plural: "Epics" }, { name: "Story", plural: "Stories" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 1, sprints: false };

/** A shared board with three levels (set in the database, before the structure endpoint is used). */
async function setup(label: string, structure: object = EPICS) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  db.query("UPDATE boards SET structure_json = ? WHERE id = ?").run(JSON.stringify(structure), boardId);
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  return { owner, member, stranger, boardId, columns };
}

async function addCard(session: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as Card;
}

const boardCards = async (session: Session, boardId: string) => (await call(session, "GET", `/boards/${boardId}`)).body.cards as Card[];
const lastAudit = (action: string) => db.query("SELECT metadata_json FROM audit_log WHERE event_type = ? ORDER BY rowid DESC LIMIT 1").get(action) as { metadata_json: string } | null;

describe("card parent and level", () => {
  test("levels default to the parent's plus one, else the work level; an orphan story is fine, a subtask needs its story", async () => {
    const { member, boardId, columns } = await setup("Levels");
    const todo = columns[0].id;
    const story = await addCard(member, boardId, todo, "Orphan story");
    expect(story).toMatchObject({ level: 1, parent_card_id: null, child_count: 0, done_child_count: 0 });
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    expect(epic.level).toBe(0);
    const child = await addCard(member, boardId, todo, "Story", { parentId: epic.id });
    expect(child).toMatchObject({ level: 1, parent_card_id: epic.id });
    const subtask = await addCard(member, boardId, todo, "Subtask", { parentId: child.id, level: 2 });
    expect(subtask).toMatchObject({ level: 2, parent_card_id: child.id });
    const audit = JSON.parse(lastAudit("task.card_create")!.metadata_json);
    expect(audit).toMatchObject({ boardId, level: 2, parentId: child.id });
    // Below the work level a parent is required (operator QA 0.9.1): nothing is written.
    const before = (await boardCards(member, boardId)).length;
    expect(await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Loose subtask", level: 2 })).toMatchObject({
      status: 400, body: { code: "PARENT_REQUIRED", level: 2, error: "Pick the story this subtask belongs to, or make it a story" }
    });
    expect((await boardCards(member, boardId)).length).toBe(before);
  });

  test("a subtask cannot lose its parent or be made without one (PARENT_REQUIRED); a detached one stays editable", async () => {
    const { member, boardId, columns } = await setup("Parent required", { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: true });
    const todo = columns[0].id;
    const task = await addCard(member, boardId, todo, "Task");
    const other = await addCard(member, boardId, todo, "Other task");
    const subtask = await addCard(member, boardId, todo, "Subtask", { parentId: task.id });
    const refused = { status: 400, body: { code: "PARENT_REQUIRED", level: 1, error: "Pick the task this subtask belongs to, or make it a task" } };
    // Detach, or move a task down a level without a parent: refused, nothing changes.
    expect(await call(member, "PATCH", `/cards/${subtask.id}`, { parentId: null, revision: subtask.revision })).toMatchObject(refused);
    expect(await call(member, "PATCH", `/cards/${other.id}`, { level: 1, revision: other.revision })).toMatchObject(refused);
    expect(await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "No parent", level: 1 })).toMatchObject(refused);
    expect((await call(member, "GET", `/cards/${subtask.id}`)).body.card).toMatchObject({ parent_card_id: task.id, revision: subtask.revision });
    // Another parent is fine, and so is making it a task.
    const moved = await call(member, "PATCH", `/cards/${subtask.id}`, { parentId: other.id, revision: subtask.revision });
    expect(moved.body.card).toMatchObject({ parent_card_id: other.id, level: 1 });

    // Detached by a Bin restore (D130): still readable and editable; only a placement change must choose.
    db.query("UPDATE cards SET parent_card_id = NULL WHERE id = ?").run(subtask.id);
    const renamed = await call(member, "PATCH", `/cards/${subtask.id}`, { title: "Renamed", revision: moved.body.card.revision });
    expect(renamed.body.card).toMatchObject({ title: "Renamed", parent_card_id: null, level: 1 });
    expect((await call(member, "PATCH", `/cards/${subtask.id}`, { level: 1, revision: renamed.body.card.revision })).body.code).toBe("PARENT_REQUIRED");
    const promoted = await call(member, "PATCH", `/cards/${subtask.id}`, { level: 0, parentId: null, revision: renamed.body.card.revision });
    expect(promoted.body.card).toMatchObject({ parent_card_id: null, level: 0 });
  });

  test("every invalid parent is the same 400 PARENT_INVALID, and nothing is written (T113)", async () => {
    const { owner, member, stranger, boardId, columns } = await setup("Invalid parent");
    const todo = columns[0].id;
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    const story = await addCard(member, boardId, todo, "Story", { parentId: epic.id });
    const subtask = await addCard(member, boardId, todo, "Subtask", { parentId: story.id });
    const other = await call(stranger, "POST", "/boards", { name: "Stranger board" });
    db.query("UPDATE boards SET structure_json = ? WHERE id = ?").run(JSON.stringify(EPICS), other.body.board.id);
    const foreign = await addCard(stranger, other.body.board.id, other.body.columns[0].id, "Foreign epic", { level: 0 });
    const binned = await addCard(member, boardId, todo, "Binned epic", { level: 0 });
    expect((await call(member, "DELETE", `/cards/${binned.id}`)).status).toBe(200);
    const before = (await boardCards(owner, boardId)).length;
    const attempts: Array<Record<string, unknown>> = [
      { parentId: crypto.randomUUID() },       // unknown
      { parentId: foreign.id },                // another board, even one the caller cannot read
      { parentId: binned.id },                 // binned
      { parentId: epic.id, level: 2 },         // skips a level
      { parentId: story.id, level: 1 },        // same level
      { parentId: subtask.id }                 // below the last level
    ];
    for (const extra of attempts) {
      const response = await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Nope", ...extra });
      expect(response).toMatchObject({ status: 400, body: { code: "PARENT_INVALID", error: "Choose a card one level up on this board as the parent" } });
    }
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Too deep", level: 3 })).status).toBe(400);
    expect(await boardCards(owner, boardId)).toHaveLength(before);
    // A flat board has one level.
    const flat = await setup("Flat levels", { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false });
    expect(await call(flat.member, "POST", `/boards/${flat.boardId}/cards`, { columnId: flat.columns[0].id, title: "Level 1", level: 1 }))
      .toMatchObject({ status: 400, body: { code: "LEVEL_INVALID" } });
  });

  test("reparent with a revision compare-and-swap; the level stays unless it is changed", async () => {
    const { member, owner, boardId, columns } = await setup("Reparent");
    const todo = columns[0].id;
    const first = await addCard(member, boardId, todo, "First epic", { level: 0 });
    const second = await addCard(member, boardId, todo, "Second epic", { level: 0 });
    const story = await addCard(member, boardId, todo, "Story", { parentId: first.id });
    const moved = await call(member, "PATCH", `/cards/${story.id}`, { parentId: second.id, revision: story.revision });
    expect(moved).toMatchObject({ status: 200, body: { card: { parent_card_id: second.id, level: 1, revision: story.revision + 1 } } });
    expect(JSON.parse(lastAudit("task.card_reparent")!.metadata_json)).toEqual({ boardId, cardId: story.id, parentId: second.id });
    // A stale revision is CARD_CHANGED with the current card.
    const stale = await call(owner, "PATCH", `/cards/${story.id}`, { parentId: first.id, revision: story.revision });
    expect(stale).toMatchObject({ status: 409, body: { code: "CARD_CHANGED", card: { parent_card_id: second.id } } });
    // Detach.
    const detached = await call(member, "PATCH", `/cards/${story.id}`, { parentId: null, revision: story.revision + 1 });
    expect(detached.body.card).toMatchObject({ parent_card_id: null, level: 1 });
    // A story cannot sit under a story, or under itself.
    expect((await call(member, "PATCH", `/cards/${story.id}`, { parentId: story.id, revision: detached.body.card.revision })).body.code).toBe("PARENT_INVALID");
    const other = await addCard(member, boardId, todo, "Other story");
    expect((await call(member, "PATCH", `/cards/${story.id}`, { parentId: other.id, revision: detached.body.card.revision })).body.code).toBe("PARENT_INVALID");
  });

  test("change level: allowed without children, refused with HAS_CHILDREN, and a parent must follow the new level", async () => {
    const { member, boardId, columns } = await setup("Change level");
    const todo = columns[0].id;
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    const story = await addCard(member, boardId, todo, "Story", { parentId: epic.id });
    const refused = await call(member, "PATCH", `/cards/${epic.id}`, { level: 1, revision: epic.revision });
    expect(refused).toMatchObject({ status: 409, body: { code: "HAS_CHILDREN", childCount: 1 } });
    // Story → subtask under another story needs the new level and a parent one level up.
    const host = await addCard(member, boardId, todo, "Host story");
    expect((await call(member, "PATCH", `/cards/${story.id}`, { level: 2, revision: story.revision })).body.code).toBe("PARENT_INVALID");
    const changed = await call(member, "PATCH", `/cards/${story.id}`, { level: 2, parentId: host.id, revision: story.revision });
    expect(changed).toMatchObject({ status: 200, body: { card: { level: 2, parent_card_id: host.id } } });
    expect(JSON.parse(lastAudit("task.card_level")!.metadata_json)).toEqual({ boardId, cardId: story.id, level: 2 });
    // The epic has no children now and may change level.
    expect((await call(member, "PATCH", `/cards/${epic.id}`, { level: 1, revision: epic.revision })).body.card.level).toBe(1);
  });

  test("a card has at most 100 direct children (T111)", async () => {
    const { member, boardId, columns } = await setup("Width", { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: false });
    const todo = columns[0].id;
    const parent = await addCard(member, boardId, todo, "Parent");
    const insert = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, parent_card_id, level, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    for (let index = 0; index < 100; index += 1) insert.run(crypto.randomUUID(), boardId, todo, 10_000 + index, `Child ${index}`, parent.id);
    expect(await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "One too many", parentId: parent.id }))
      .toMatchObject({ status: 409, body: { code: "LIMIT_REACHED" } });
    const loose = await addCard(member, boardId, todo, "Loose", { parentId: (await addCard(member, boardId, todo, "Other parent")).id });
    expect((await call(member, "PATCH", `/cards/${loose.id}`, { parentId: parent.id, revision: loose.revision })).body.code).toBe("LIMIT_REACHED");
  });

  test("GET /cards/:k carries parent, ancestors, and children from the same board; strangers get 404", async () => {
    const { member, stranger, boardId, columns } = await setup("Detail");
    const [todo, doing, done] = [columns[0].id, columns[1].id, columns[2].id];
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    const story = await addCard(member, boardId, doing, "Story", { parentId: epic.id });
    const subtaskDone = await addCard(member, boardId, done, "Done subtask", { parentId: story.id });
    const subtaskOpen = await addCard(member, boardId, todo, "Open subtask", { parentId: story.id });
    const view = (await call(member, "GET", `/cards/${story.id}`)).body.card;
    expect(view.parent).toEqual({ id: epic.id, title: "Epic", level: 0 });
    expect(view.ancestors).toEqual([{ id: epic.id, title: "Epic", level: 0 }]);
    // Children by column position, then card position.
    expect(view.children.map((child: { id: string }) => child.id)).toEqual([subtaskOpen.id, subtaskDone.id]);
    expect(view.children[1]).toMatchObject({ title: "Done subtask", column_name: "Done", is_done: 1, level: 2 });
    expect(view).toMatchObject({ child_count: 2, done_child_count: 1 });
    const leaf = (await call(member, "GET", `/cards/${subtaskOpen.id}`)).body.card;
    expect(leaf.ancestors.map((item: { title: string }) => item.title)).toEqual(["Epic", "Story"]);
    expect((await call(member, "GET", `/cards/${story.id}/children`)).body.children).toHaveLength(2);
    expect((await call(stranger, "GET", `/cards/${story.id}/children`)).status).toBe(404);
  });
});

describe("Bin subtrees (D129, D130, T114)", () => {
  async function tree(label: string) {
    const context = await setup(label);
    const { member, boardId, columns } = context;
    const [todo, doing, done] = [columns[0].id, columns[1].id, columns[2].id];
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    const storyA = await addCard(member, boardId, doing, "Story A", { parentId: epic.id });
    const storyB = await addCard(member, boardId, todo, "Story B", { parentId: epic.id });
    const subA1 = await addCard(member, boardId, done, "Sub A1", { parentId: storyA.id });
    const subA2 = await addCard(member, boardId, todo, "Sub A2", { parentId: storyA.id });
    const subB1 = await addCard(member, boardId, doing, "Sub B1", { parentId: storyB.id });
    return { ...context, epic, storyA, storyB, subA1, subA2, subB1 };
  }
  const binItems = async (session: Session) => (await call(session, "GET", "/bin?type=card")).body.items as Array<{ id: string; title: string; descendant_count?: number }>;

  test("binning a card bins its live descendants; the Bin lists the root with its count, and one restore brings the tree back", async () => {
    const t = await tree("Bin tree");
    const deleted = await call(t.member, "DELETE", `/cards/${t.epic.id}`);
    expect(deleted).toMatchObject({ status: 200, body: { ok: true, descendantCount: 5 } });
    expect(JSON.parse(lastAudit("task.card_delete")!.metadata_json)).toMatchObject({ cardId: t.epic.id, descendantCount: 5 });
    expect(await boardCards(t.owner, t.boardId)).toHaveLength(0);
    for (const session of [t.member, t.owner]) {
      const items = await binItems(session);
      expect(items.filter((item) => [t.epic.id, t.storyA.id, t.subA1.id].includes(item.id)).map((item) => [item.title, item.descendant_count])).toEqual([["Epic", 5]]);
    }
    // A descendant is not a Bin item of its own: it cannot be restored or purged alone.
    expect((await call(t.owner, "POST", `/bin/card/${t.subA1.id}/restore`)).status).toBe(404);
    expect((await call(t.owner, "DELETE", `/bin/card/${t.subA1.id}`)).status).toBe(404);
    // Someone who did not delete it and does not own the board sees nothing (D41).
    expect(await binItems(t.stranger)).toEqual([]);
    const restored = await call(t.member, "POST", `/bin/card/${t.epic.id}/restore`, {});
    expect(restored).toMatchObject({ status: 200, body: { ok: true, descendantCount: 5 } });
    expect(restored.body.detached).toBeUndefined();
    const cards = await boardCards(t.owner, t.boardId);
    expect(cards).toHaveLength(6);
    const byId = new Map(cards.map((card) => [card.id, card]));
    expect(byId.get(t.subA1.id)).toMatchObject({ parent_card_id: t.storyA.id, column_id: t.columns[2].id, level: 2 });
    expect(byId.get(t.storyA.id)).toMatchObject({ parent_card_id: t.epic.id, child_count: 2, done_child_count: 1 });
    expect(byId.get(t.epic.id)).toMatchObject({ child_count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM cards WHERE bin_root_id IS NOT NULL").get()).toEqual({ count: 0 });
  });

  test("a descendant binned on its own keeps its entry; restored while its parent is binned, it comes back detached", async () => {
    const t = await tree("Bin separate");
    expect((await call(t.member, "DELETE", `/cards/${t.subA2.id}`)).body.descendantCount).toBe(0);
    expect((await call(t.member, "DELETE", `/cards/${t.storyA.id}`)).body.descendantCount).toBe(1);
    expect((await call(t.member, "DELETE", `/cards/${t.epic.id}`)).body.descendantCount).toBe(2);
    const items = await binItems(t.member);
    expect(new Map(items.map((item) => [item.id, item.descendant_count]))).toEqual(new Map([[t.subA2.id, undefined], [t.storyA.id, 1], [t.epic.id, 2]]));
    // Restoring the epic brings back Story B and Sub B1 only.
    expect((await call(t.member, "POST", `/bin/card/${t.epic.id}/restore`, {})).body.descendantCount).toBe(2);
    expect((await boardCards(t.owner, t.boardId)).map((card) => card.title).sort()).toEqual(["Epic", "Story B", "Sub B1"]);
    // Story A still has its parent (the epic is live again); Sub A2's parent is binned, so it comes back detached.
    const alone = await call(t.member, "POST", `/bin/card/${t.subA2.id}/restore`, {});
    expect(alone).toMatchObject({ status: 200, body: { detached: true } });
    expect((await boardCards(t.owner, t.boardId)).find((card) => card.id === t.subA2.id)).toMatchObject({ parent_card_id: null, level: 2 });
    const story = await call(t.member, "POST", `/bin/card/${t.storyA.id}/restore`, {});
    expect(story.body).toMatchObject({ ok: true, descendantCount: 1 });
    expect(story.body.detached).toBeUndefined();
    expect((await boardCards(t.owner, t.boardId)).find((card) => card.id === t.storyA.id)).toMatchObject({ parent_card_id: t.epic.id, child_count: 1 });
  });

  test("purging a root purges its group, by hand and by the sweeper; a separately binned child whose parent is purged restores detached", async () => {
    const t = await tree("Bin purge");
    expect((await call(t.member, "DELETE", `/cards/${t.subB1.id}`)).status).toBe(200);
    expect((await call(t.member, "DELETE", `/cards/${t.storyB.id}`)).status).toBe(200);
    expect((await call(t.member, "DELETE", `/cards/${t.storyA.id}`)).status).toBe(200);
    // Only the owner deletes forever.
    expect((await call(t.member, "DELETE", `/bin/card/${t.storyA.id}`)).status).toBe(403);
    expect((await call(t.owner, "DELETE", `/bin/card/${t.storyA.id}`)).status).toBe(200);
    expect(db.query("SELECT id FROM cards WHERE id IN (?, ?, ?)").all(t.storyA.id, t.subA1.id, t.subA2.id)).toEqual([]);
    expect(JSON.parse(lastAudit("task.card_purge")!.metadata_json)).toMatchObject({ cardId: t.storyA.id, descendantCount: 2 });
    // The sweeper purges Story B (a root) but not Sub B1, which is its own root and not due yet.
    db.query("UPDATE cards SET purge_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(t.storyB.id);
    const { sweepTaskBin } = await import("../server/tasks/bin");
    expect(await sweepTaskBin(new Date().toISOString(), 50)).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT id FROM cards WHERE id = ?").get(t.storyB.id)).toBeNull();
    // Its parent is gone, so Sub B1 was detached by the FK and restores as a loose subtask, and says so.
    const restored = await call(t.member, "POST", `/bin/card/${t.subB1.id}/restore`, {});
    expect(restored).toMatchObject({ status: 200, body: { ok: true, detached: true } });
    expect(JSON.parse(lastAudit("task.card_restore")!.metadata_json)).toMatchObject({ cardId: t.subB1.id, detached: true });
    expect((await boardCards(t.owner, t.boardId)).find((card) => card.id === t.subB1.id)).toMatchObject({ parent_card_id: null, level: 2 });
  });

  test("a top-level card never restores detached", async () => {
    const t = await tree("Bin top level");
    expect((await call(t.member, "DELETE", `/cards/${t.epic.id}`)).status).toBe(200);
    const restored = await call(t.member, "POST", `/bin/card/${t.epic.id}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.detached).toBeUndefined();
  });

  test("restoring under a parent that already has 100 children comes back detached instead of over the cap (D135)", async () => {
    const t = await tree("Bin full parent");
    expect((await call(t.member, "DELETE", `/cards/${t.subB1.id}`)).status).toBe(200);
    // Story B fills up with 100 live children meanwhile.
    const insert = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, parent_card_id, level, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    for (let index = 0; index < 100; index += 1) insert.run(crypto.randomUUID(), t.boardId, t.columns[0].id, 20_000 + index, `Filler ${index}`, t.storyB.id);
    const restored = await call(t.member, "POST", `/bin/card/${t.subB1.id}/restore`, {});
    expect(restored).toMatchObject({ status: 200, body: { ok: true, detached: true } });
    expect(db.query("SELECT parent_card_id, level, deleted_at FROM cards WHERE id = ?").get(t.subB1.id)).toEqual({ parent_card_id: null, level: 2, deleted_at: null });
    expect(db.query("SELECT COUNT(*) AS count FROM cards WHERE parent_card_id = ? AND deleted_at IS NULL").get(t.storyB.id)).toEqual({ count: 100 });
  });
});

describe("board structure (D122, T120)", () => {
  test("the owner sets a structure; members get 403 and strangers 404; bad structures are 400", async () => {
    const { owner, member, stranger, boardId } = await setup("Structure", { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false });
    const saved = await call(owner, "PATCH", `/boards/${boardId}`, { structure: EPICS });
    expect(saved).toMatchObject({ status: 200, body: { board: { structure: EPICS } } });
    expect(JSON.parse(lastAudit("task.board_structure")!.metadata_json)).toEqual({ boardId, levels: 3, workLevel: 1, sprints: false });
    expect((await call(member, "PATCH", `/boards/${boardId}`, { structure: EPICS })).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(stranger, "PATCH", `/boards/${boardId}`, { structure: EPICS })).status).toBe(404);
    for (const structure of [{ levels: [] }, { ...EPICS, workLevel: 3 }, { ...EPICS, levels: [{ name: "x".repeat(30), plural: "y" }] }, "flat"]) {
      expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure })).status).toBe(400);
    }
    expect((await call(owner, "PATCH", `/boards/${boardId}`, {})).status).toBe(400);
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: EPICS, extra: 1 })).status).toBe(400);
    // Name and structure together; custom names are free.
    const custom = { levels: [{ name: "Goal", plural: "Goals" }, { name: "Step", plural: "Steps" }], workLevel: 0, sprints: false };
    const both = await call(owner, "PATCH", `/boards/${boardId}`, { name: "Renamed", structure: custom });
    expect(both.body.board).toMatchObject({ name: "Renamed", structure: custom });
  });

  test("a name and a structure in one PATCH are one transaction: both or neither (review L5)", async () => {
    const flat = { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false };
    const { owner, boardId } = await setup("Atomic patch", flat);
    // The rename is made to fail after the structure write; the structure must roll back with it.
    db.run(`CREATE TEMP TRIGGER trg_test_refuse_rename BEFORE UPDATE OF name ON boards WHEN NEW.id = '${boardId}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    try {
      expect((await call(owner, "PATCH", `/boards/${boardId}`, { name: "Renamed", structure: EPICS })).status).toBe(500);
    } finally {
      db.run("DROP TRIGGER IF EXISTS trg_test_refuse_rename");
    }
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.board).toMatchObject({ name: "Atomic patch board", structure: flat });
    const both = await call(owner, "PATCH", `/boards/${boardId}`, { name: "Both", structure: EPICS });
    expect(both.status).toBe(200);
    expect(both.body.board).toMatchObject({ name: "Both", structure: EPICS });
    // A refused structure leaves the name alone too.
    db.query("INSERT INTO cards (id, board_id, column_id, position, title, level, created_at, updated_at) SELECT ?, ?, id, 1, 'Deep', 2, '2026-01-01', '2026-01-01' FROM board_columns WHERE board_id = ? LIMIT 1")
      .run(crypto.randomUUID(), boardId, boardId);
    const refused = await call(owner, "PATCH", `/boards/${boardId}`, { name: "Not saved", structure: { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false } });
    expect(refused).toMatchObject({ status: 409, body: { code: "LEVEL_IN_USE" } });
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.board.name).toBe("Both");
  });

  test("removing a level that cards use is LEVEL_IN_USE, counting binned cards; sprints off with open sprints is SPRINTS_IN_USE", async () => {
    const { owner, member, boardId, columns } = await setup("Structure refusals");
    const todo = columns[0].id;
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    const story = await addCard(member, boardId, todo, "Story", { parentId: epic.id });
    const subtask = await addCard(member, boardId, todo, "Subtask", { parentId: story.id });
    const twoLevels = { levels: EPICS.levels.slice(0, 2), workLevel: 1, sprints: false };
    expect(await call(owner, "PATCH", `/boards/${boardId}`, { structure: twoLevels }))
      .toMatchObject({ status: 409, body: { code: "LEVEL_IN_USE", level: 2, cardCount: 1, binnedCount: 0, levels: [{ level: 2, name: "Subtask", cardCount: 1 }] } });
    // Two levels removed: per-level counts, not one level's name with the total (QA FAIL-4).
    await addCard(member, boardId, todo, "Second story", { parentId: epic.id });
    const oneLevel = await call(owner, "PATCH", `/boards/${boardId}`, { structure: { levels: EPICS.levels.slice(0, 1), workLevel: 0, sprints: false } });
    expect(oneLevel).toMatchObject({ status: 409, body: { code: "LEVEL_IN_USE", level: 1, cardCount: 3, levels: [{ level: 1, name: "Story", cardCount: 2 }, { level: 2, name: "Subtask", cardCount: 1 }] } });
    expect(oneLevel.body.error).toBe("2 cards are Stories and 1 is a Subtask. Move or change them before removing these levels.");
    expect((await call(member, "DELETE", `/cards/${subtask.id}`)).status).toBe(200);
    expect(await call(owner, "PATCH", `/boards/${boardId}`, { structure: twoLevels }))
      .toMatchObject({ status: 409, body: { code: "LEVEL_IN_USE", cardCount: 1, binnedCount: 1 } });
    expect((await call(owner, "DELETE", `/bin/card/${subtask.id}`)).status).toBe(200);
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: twoLevels })).status).toBe(200);
    // New cards may not use the removed level.
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Deep", parentId: story.id })).body.code).toBe("PARENT_INVALID");
    // Sprints on, then an open sprint blocks turning them off (17B creates sprints; inserted here).
    const withSprints = { ...twoLevels, sprints: true };
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: withSprints })).status).toBe(200);
    db.query("INSERT INTO board_sprints (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, 'Sprint 1', 1024, ?, ?)").run(crypto.randomUUID(), boardId, "2026-01-01", "2026-01-01");
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: twoLevels })).body.code).toBe("SPRINTS_IN_USE");
  });
});

describe("board templates (D136)", () => {
  test("each template sets its columns, states, structure, and tags, and never creates cards", async () => {
    const { TEMPLATES, BOARD_TEMPLATES } = await import("../shared/boardStructure");
    const user = await createUser("Templates");
    for (const id of BOARD_TEMPLATES) {
      const created = await call(user, "POST", "/boards", { name: `From ${id}`, template: id });
      expect(created.status).toBe(201);
      const template = TEMPLATES[id];
      expect(created.body.board.structure).toEqual(template.structure);
      expect(created.body.columns.map((column: { name: string; state: string; is_done: number }) => [column.name, column.state, column.is_done]))
        .toEqual(template.columns.map((column) => [column.name, column.state, column.state === "done" ? 1 : 0]));
      const board = (await call(user, "GET", `/boards/${created.body.board.id}`)).body;
      expect(board.cards).toEqual([]);
      expect(board.tags.map((tag: { name: string; color: string }) => [tag.name, tag.color]).sort()).toEqual((template.tags ?? []).map((tag) => [tag.name, tag.color]).sort());
    }
    // No template is the Simple kanban; an unknown one is 400.
    const plain = await call(user, "POST", "/boards", { name: "Plain" });
    expect(plain.body.columns.map((column: { name: string }) => column.name)).toEqual(["To do", "Doing", "Done"]);
    expect(plain.body.board.structure.levels).toHaveLength(1);
    expect((await call(user, "POST", "/boards", { name: "Bad", template: "gantt" })).status).toBe(400);
    expect(JSON.parse(lastAudit("task.board_create")!.metadata_json).template).toBeUndefined();
  });
});

describe("parent titles in Today and the calendar overlay (D138, T112)", () => {
  test("an assigned subtask shows its parent's title; a binned parent shows none", async () => {
    const { member, boardId, columns } = await setup("Today tree");
    const todo = columns[0].id;
    const story = await addCard(member, boardId, todo, "Checkout story");
    const today = new Date().toISOString().slice(0, 10);
    const subtask = await addCard(member, boardId, todo, "Build form", { parentId: story.id, dueOn: today, assigneeIds: [member.userId] });
    const due = async () => ((await (await request("/today?tz=UTC", {}, member)).json()) as { sections: Record<string, { items: Array<{ cardId: string; parentTitle: string | null }> }> })
      .sections.tasksDue!.items.find((item) => item.cardId === subtask.id);
    expect((await due())!.parentTitle).toBe("Checkout story");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const overlay = async () => ((await (await request(`/events?from=${today}&to=${tomorrow}&include=tasks`, {}, member)).json()) as { tasks: Array<{ cardId: string; parentTitle: string | null }> })
      .tasks.find((task) => task.cardId === subtask.id);
    expect((await overlay())?.parentTitle).toBe("Checkout story");
    // The cross-board query carries it too.
    const { runQuery } = await import("../server/tasks/query");
    const { parse } = await import("../shared/taskQuery");
    const parsed = parse(`board:${boardId} level:2`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(runQuery(member.userId, parsed.query, { tz: "UTC" }).cards.map((card) => card.parent_title)).toEqual(["Checkout story"]);
    // Detached (a Bin restore while its story is binned, D130), it names no parent. The API itself refuses to detach a subtask.
    expect((await call(member, "PATCH", `/cards/${subtask.id}`, { parentId: null, revision: subtask.revision })).body.code).toBe("PARENT_REQUIRED");
    db.query("UPDATE cards SET parent_card_id = NULL WHERE id = ?").run(subtask.id);
    expect((await due())!.parentTitle).toBeNull();
    expect(runQuery(member.userId, parsed.query, { tz: "UTC" }).cards.map((card) => card.parent_title)).toEqual([null]);
  });
});

describe("roll-ups", () => {
  test("the board payload counts live direct children and those in a done column, with one grouped query (D134)", async () => {
    const { owner, member, boardId, columns } = await setup("Rollup");
    const [todo, doing, done] = [columns[0].id, columns[1].id, columns[2].id];
    const epic = await addCard(member, boardId, todo, "Epic", { level: 0 });
    const story = await addCard(member, boardId, doing, "Story", { parentId: epic.id });
    const subtasks = [];
    for (const title of ["One", "Two", "Three"]) subtasks.push(await addCard(member, boardId, todo, title, { parentId: story.id }));
    const find = async (id: string) => (await boardCards(owner, boardId)).find((card) => card.id === id)!;
    expect(await find(epic.id)).toMatchObject({ child_count: 1, done_child_count: 0 });
    expect(await find(story.id)).toMatchObject({ child_count: 3, done_child_count: 0 });
    // Checking a subtask is a move to the done column; the parent's count follows.
    expect((await call(member, "POST", `/cards/${subtasks[0]!.id}/move`, { columnId: done, afterCardId: null })).status).toBe(200);
    expect((await call(member, "POST", `/cards/${subtasks[1]!.id}/move`, { columnId: done, afterCardId: null })).status).toBe(200);
    expect(await find(story.id)).toMatchObject({ child_count: 3, done_child_count: 2 });
    // Unchecking moves it back; binning a child drops it from the counts; direct children only.
    expect((await call(member, "POST", `/cards/${subtasks[1]!.id}/move`, { columnId: todo, afterCardId: null })).status).toBe(200);
    expect((await call(member, "DELETE", `/cards/${subtasks[2]!.id}`)).status).toBe(200);
    expect(await find(story.id)).toMatchObject({ child_count: 2, done_child_count: 1 });
    expect(await find(epic.id)).toMatchObject({ child_count: 1, done_child_count: 0 });
    // A done column turned off counts as open again.
    expect((await call(owner, "PATCH", `/columns/${done}`, { isDone: false })).status).toBe(200);
    expect(await find(story.id)).toMatchObject({ child_count: 2, done_child_count: 0 });
    // The board carries its structure.
    const board = (await call(member, "GET", `/boards/${boardId}`)).body.board;
    expect(board.structure).toEqual(EPICS);
    expect((await call(member, "GET", "/boards")).body.boards.find((item: { id: string }) => item.id === boardId).structure).toEqual(EPICS);
  });
});
