import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { registeredMigrations } from "../server/migrations";
import { boardKeysMigration } from "../server/migrations/079_board_keys";
import { cardKey, normalizeBoardCode, parseCardKey, suggestBoardCode, uniqueBoardCode } from "../shared/boardKeys";

const { resetCardSearchRateLimit } = await import("../server/tasks/cardSearch");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type Grant = import("../server/keyGrants").Grant;

/**
 * Board codes, card keys, short links, and moving a card to another board (lane KEYS,
 * docs/plan/TASK_KEYS.md D710–D716, T460–T462, migration 079).
 */

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
async function board(owner: Session, name: string, extra: Record<string, unknown> = {}) {
  const created = await call(owner, "POST", "/boards", { name, ...extra });
  expect(created.status).toBe(201);
  return { id: created.body.board.id as string, code: created.body.board.code as string, columns: created.body.columns as Array<{ id: string; name: string; state: string }> };
}
async function card(owner: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as { id: string; revision: number; number: number; key: string };
}
const share = (owner: Session, boardId: string, userIds: string[]) => call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds });
const setLevel = (boardId: string, userId: string, level: string) => db.query("UPDATE board_members SET level = ? WHERE board_id = ? AND user_id = ?").run(level, boardId, userId);
const lookup = (session: Session, key: string) => call(session, "GET", `/keys/${encodeURIComponent(key)}`);

beforeEach(() => { resetCardSearchRateLimit(); resetMcpLimits(); });

describe("codes and keys (shared/boardKeys.ts, D710, D711)", () => {
  test("a name suggests a code; codes normalize; keys parse in any case", () => {
    expect(suggestBoardCode("My tasks")).toBe("MYT");
    expect(suggestBoardCode("Roadmap")).toBe("ROA");
    expect(suggestBoardCode("Q3 launch plan")).toBe("QLP");
    expect(suggestBoardCode("2026 roadmap")).toBe("ROA");
    expect(suggestBoardCode("Café crème")).toBe("CAC");
    expect(suggestBoardCode("X")).toBe("XBR");
    expect(suggestBoardCode("!!! 123")).toBe("BRD");
    expect(suggestBoardCode("Alpha beta gamma delta epsilon")).toBe("ABGD");
    expect(normalizeBoardCode(" myt ")).toBe("MYT");
    for (const bad of ["M", "1AB", "AB-C", "ABCDEFGHIJK", "", "ÄB"]) expect(normalizeBoardCode(bad)).toBeNull();
    expect(uniqueBoardCode("MYT", (code) => ["MYT", "MYT2"].includes(code))).toBe("MYT3");
    expect(uniqueBoardCode("ABCDEFGHIJ", (code) => code === "ABCDEFGHIJ")).toBe("ABCDEFGHI2");
    expect(parseCardKey("myt-12")).toEqual({ code: "MYT", number: 12 });
    for (const bad of ["MYT-0", "MYT-012", "MYT12", "1A-3", "MYT-1234567890"]) expect(parseCardKey(bad)).toBeNull();
    expect(cardKey("MYT", 3)).toBe("MYT-3");
    expect(cardKey(null, 3)).toBeNull();
  });
});

describe("migration 079", () => {
  test("backfills codes from names without duplicates and numbers cards in creation order, binned ones included; new cards take the next number", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 79)) sqlite.transaction(() => migration.up(sqlite))();
    const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at(0));
    const addBoard = (id: string, name: string, minute: number) => {
      sqlite.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?)").run(id, name, at(minute), at(minute));
      sqlite.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, 'To do', 1024, ?, ?)").run(`${id}-c`, id, at(minute), at(minute));
    };
    addBoard("b1", "My tasks", 1);
    addBoard("b2", "My team", 2);
    addBoard("b3", "Roadmap", 3);
    const addCard = (id: string, boardId: string, minute: number, binned = false) => sqlite.query(`INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at, deleted_at, purge_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, boardId, `${boardId}-c`, minute, id, at(minute), at(minute), binned ? at(minute) : null, binned ? at(minute) : null);
    addCard("k3", "b1", 13);
    addCard("k1", "b1", 11);
    addCard("k2", "b1", 12, true);
    addCard("r1", "b3", 20);
    sqlite.transaction(() => boardKeysMigration.up(sqlite))();
    sqlite.transaction(() => boardKeysMigration.up(sqlite))();
    expect(sqlite.query("SELECT id, code, next_card_number FROM boards ORDER BY id").all()).toEqual([
      { id: "b1", code: "MYT", next_card_number: 4 }, { id: "b2", code: "MYT2", next_card_number: 1 }, { id: "b3", code: "ROA", next_card_number: 2 }
    ]);
    expect(sqlite.query("SELECT id, number FROM cards ORDER BY board_id, number").all()).toEqual([
      { id: "k1", number: 1 }, { id: "k2", number: 2 }, { id: "k3", number: 3 }, { id: "r1", number: 1 }
    ]);
    // The insert trigger numbers every new card (D713).
    addCard("k4", "b1", 30);
    addCard("m1", "b2", 31);
    expect(sqlite.query("SELECT id, number FROM cards WHERE id IN ('k4', 'm1') ORDER BY id").all()).toEqual([{ id: "k4", number: 4 }, { id: "m1", number: 1 }]);
    expect(sqlite.query("SELECT next_card_number FROM boards WHERE id = 'b1'").get()).toEqual({ next_card_number: 5 });
    // Codes are unique without case, and well formed.
    expect(() => sqlite.query("UPDATE boards SET code = 'myt' WHERE id = 'b3'").run()).toThrow();
    expect(() => sqlite.query("UPDATE boards SET code = 'ROAD-1' WHERE id = 'b3'").run()).toThrow();
    expect(() => sqlite.query("UPDATE cards SET number = 1 WHERE id = 'k3'").run()).toThrow();
    // A re-run never lowers a board's counter: the purged k4's number is not handed out again.
    sqlite.query("DELETE FROM cards WHERE id = 'k4'").run();
    sqlite.transaction(() => boardKeysMigration.up(sqlite))();
    expect(sqlite.query("SELECT next_card_number FROM boards WHERE id = 'b1'").get()).toEqual({ next_card_number: 5 });
  });
});

describe("board codes over the API (D711, D712, D714)", () => {
  test("a new board gets a free code from its name, or the one asked for; malformed and taken codes are refused", async () => {
    const owner = await createUser("Keys Codes owner");
    const first = await board(owner, "Zebra stripes");
    expect(first.code).toBe("ZES");
    const second = await board(owner, "Zebra stripes");
    expect(second.code).toBe("ZES2");
    const chosen = await board(owner, "Anything", { code: "kq7" });
    expect(chosen.code).toBe("KQ7");
    expect((await call(owner, "POST", "/boards", { name: "Bad", code: "7up" })).body.code).toBe("CODE_INVALID");
    const taken = await call(owner, "POST", "/boards", { name: "Taken", code: "zes" });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: "CODE_TAKEN", suggestion: "ZES3" });
    expect((await call(owner, "GET", `/board-codes/suggest?name=${encodeURIComponent("Zebra stripes")}`)).body).toEqual({ code: "ZES3" });
    expect((await call(owner, "GET", "/boards")).body.boards.find((item: { id: string }) => item.id === first.id).code).toBe("ZES");
  });

  test("only the owner changes the code; old keys keep resolving; no other board can take a former code; the board can take it back", async () => {
    const owner = await createUser("Keys Rename owner");
    const manager = await createUser("Keys Rename manager");
    const a = await board(owner, "Rename A", { code: "RNA" });
    const b = await board(owner, "Rename B", { code: "RNB" });
    await share(owner, a.id, [manager.userId]);
    setLevel(a.id, manager.userId, "manage");
    const one = await card(owner, a.id, a.columns[0]!.id, "First");
    expect(one.key).toBe("RNA-1");
    const refused = await call(manager, "PATCH", `/boards/${a.id}`, { code: "MGR" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("OWNER_ONLY");
    const changed = await call(owner, "PATCH", `/boards/${a.id}`, { code: "road" });
    expect(changed.status).toBe(200);
    expect(changed.body.board.code).toBe("ROAD");
    expect((await call(owner, "GET", `/cards/${one.id}`)).body.card.key).toBe("ROAD-1");
    expect((await lookup(owner, "rna-1")).body).toEqual({ cardId: one.id, boardId: a.id, key: "ROAD-1", moved: true });
    expect((await lookup(owner, "ROAD-1")).body).toEqual({ cardId: one.id, boardId: a.id, key: "ROAD-1", moved: false });
    expect((await call(owner, "PATCH", `/boards/${b.id}`, { code: "RNA" })).body.code).toBe("CODE_TAKEN");
    expect((await call(owner, "POST", "/boards", { name: "New", code: "RNA" })).status).toBe(409);
    expect((await call(owner, "PATCH", `/boards/${a.id}`, { code: "RNA" })).body.board.code).toBe("RNA");
    expect((await lookup(owner, "ROAD-1")).body.key).toBe("RNA-1");
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'task.board_code' AND metadata_json LIKE ?").get(`%${a.id}%`)).toEqual({ count: 2 });
  });

  test("numbers are per board and never reused, even after a card goes to the Bin", async () => {
    const owner = await createUser("Keys Numbers owner");
    const a = await board(owner, "Numbers", { code: "NUM" });
    const one = await card(owner, a.id, a.columns[0]!.id, "One");
    const two = await card(owner, a.id, a.columns[0]!.id, "Two");
    expect([one.number, two.number]).toEqual([1, 2]);
    expect((await call(owner, "DELETE", `/cards/${two.id}`)).status).toBe(200);
    const three = await card(owner, a.id, a.columns[0]!.id, "Three");
    expect(three.key).toBe("NUM-3");
    const payload = await call(owner, "GET", `/boards/${a.id}`);
    expect(payload.body.board.code).toBe("NUM");
    expect(payload.body.cards.map((item: { number: number }) => item.number)).toEqual([1, 3]);
    // A binned card's key is not found (it is not readable), and comes back with its key on restore.
    expect((await lookup(owner, "NUM-2")).status).toBe(404);
  });
});

describe("short links and search (D713, T460)", () => {
  test("a key resolves only for readers: unknown, unreadable, and malformed keys answer alike", async () => {
    const owner = await createUser("Keys Links owner");
    const reader = await createUser("Keys Links reader");
    const stranger = await createUser("Keys Links stranger");
    const shared = await board(owner, "Links shared", { code: "LNK" });
    const secret = await board(owner, "Links secret", { code: "SEC" });
    await share(owner, shared.id, [reader.userId]);
    const open = await card(owner, shared.id, shared.columns[0]!.id, "Open card");
    const hidden = await card(owner, secret.id, secret.columns[0]!.id, "Hidden card");
    expect((await lookup(reader, "lnk-1")).body).toEqual({ cardId: open.id, boardId: shared.id, key: "LNK-1", moved: false });
    const unreadable = await lookup(reader, hidden.key);
    const unknown = await lookup(reader, "SEC-99");
    const noBoard = await lookup(reader, "NOPE-1");
    expect([unreadable.status, unknown.status, noBoard.status]).toEqual([404, 404, 404]);
    expect(unreadable.body).toEqual(unknown.body);
    expect(unreadable.body).toEqual(noBoard.body);
    expect((await lookup(stranger, "LNK-1")).status).toBe(404);
    expect((await lookup(reader, "not-a-key!")).status).toBe(400);
  });

  test("card search finds a card by its key first, only when readable", async () => {
    const owner = await createUser("Keys Search owner");
    const reader = await createUser("Keys Search reader");
    const shared = await board(owner, "Search shared", { code: "SRK" });
    const secret = await board(owner, "Search secret", { code: "SRX" });
    await share(owner, shared.id, [reader.userId]);
    await card(owner, shared.id, shared.columns[0]!.id, "Mentions SRK-2 in its title");
    const target = await card(owner, shared.id, shared.columns[0]!.id, "Target");
    await card(owner, secret.id, secret.columns[0]!.id, "Hidden");
    const hits = await call(reader, "GET", "/cards/search?q=srk-2");
    expect(hits.body.results[0]).toMatchObject({ id: target.id, key: "SRK-2" });
    expect(hits.body.results).toHaveLength(2);
    expect((await call(reader, "GET", "/cards/search?q=SRX-1")).body.results).toEqual([]);
  });
});

describe("move a card to another board (D715, D716, T462)", () => {
  async function scene(label: string) {
    const owner = await createUser(`${label} owner`);
    const source = await board(owner, `${label} source`, { template: "scrum" });
    const target = await board(owner, `${label} target`);
    return { owner, source, target };
  }

  test("lands at the bottom of the first open column with a new key; tags map by name, the rest drop; sprint and parent are cleared; the old key redirects", async () => {
    const { owner, source, target } = await scene("Keys Move");
    const sourceUrgent = (await call(owner, "POST", `/boards/${source.id}/tags`, { name: "Urgent" })).body.tag.id;
    const sourceOnly = (await call(owner, "POST", `/boards/${source.id}/tags`, { name: "Source only" })).body.tag.id;
    const targetUrgent = (await call(owner, "POST", `/boards/${target.id}/tags`, { name: "urgent" })).body.tag.id;
    const existing = await card(owner, target.id, target.columns[0]!.id, "Already there");
    const sprintId = (await call(owner, "GET", `/boards/${source.id}`)).body.sprints[0].id as string;
    const moving = await card(owner, source.id, source.columns[0]!.id, "Moving", { tagIds: [sourceUrgent, sourceOnly], flags: ["blocked"], priority: "high", dueOn: "2026-12-01", sprintId });
    expect((await call(owner, "POST", `/cards/${moving.id}/comments`, { body: "Comes along" })).status).toBe(201);
    const before = (await call(owner, "GET", `/cards/${moving.id}`)).body.card;
    expect(before.sprint_id).toBe(sprintId);
    const moved = await call(owner, "POST", `/cards/${moving.id}/move-board`, { boardId: target.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ fromBoardId: source.id, previousKey: before.key, droppedTags: ["Source only"] });
    expect(moved.body.parentDetached).toBeUndefined();
    const after = moved.body.card;
    expect(after).toMatchObject({ board_id: target.id, column_id: target.columns[0]!.id, key: `${target.code}-2`, tag_ids: [targetUrgent], flags: ["blocked"], priority: "high", due_on: "2026-12-01", sprint_id: null, parent_card_id: null, comment_count: 1, revision: before.revision + 1 });
    expect(after.position).toBeGreaterThan((await call(owner, "GET", `/cards/${existing.id}`)).body.card.position);
    expect((await lookup(owner, before.key)).body).toEqual({ cardId: moving.id, boardId: target.id, key: `${target.code}-2`, moved: true });
    // The source board never reuses the number.
    const next = await card(owner, source.id, source.columns[0]!.id, "Next on source");
    expect(next.number).toBe(before.number + 1);
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'task.card_move_board' AND metadata_json LIKE ?").get(`%${moving.id}%`)).toEqual({ count: 1 });
    // A subtask leaves its parent behind and takes a level the destination has (its only one here).
    const task = await card(owner, source.id, source.columns[0]!.id, "Task");
    const subtask = await card(owner, source.id, source.columns[0]!.id, "Subtask", { parentId: task.id });
    const detached = await call(owner, "POST", `/cards/${subtask.id}/move-board`, { boardId: target.id });
    expect(detached.body.parentDetached).toBe(true);
    expect(detached.body.card).toMatchObject({ parent_card_id: null, level: 0, board_id: target.id });
    expect((await call(owner, "GET", `/cards/${task.id}`)).body.card.child_count).toBe(0);
  });

  test("the sheet lists a target board's columns from GET /boards/:b/columns, for readers only", async () => {
    const owner = await createUser("Keys Columns owner");
    const stranger = await createUser("Keys Columns stranger");
    const target = await board(owner, "Columns target");
    await card(owner, target.id, target.columns[0]!.id, "Not sent");
    const listed = await call(owner, "GET", `/boards/${target.id}/columns`);
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body)).toEqual(["columns"]);
    expect((listed.body.columns as Array<{ id: string; board_id: string }>).map((column) => column.id)).toEqual(target.columns.map((column) => column.id));
    expect((await call(stranger, "GET", `/boards/${target.id}/columns`)).status).toBe(404);
  });

  test("refused: below edit on either board, an unreadable board, the same board, a card with sub-cards, a full column", async () => {
    const { owner, source, target } = await scene("Keys Refuse");
    const member = await createUser("Keys Refuse member");
    const elsewhere = await board(member, "Keys Refuse elsewhere");
    await share(owner, source.id, [member.userId]);
    await share(owner, target.id, [member.userId]);
    const plain = await card(owner, source.id, source.columns[0]!.id, "Plain");
    setLevel(target.id, member.userId, "view");
    const viewer = await call(member, "POST", `/cards/${plain.id}/move-board`, { boardId: target.id });
    expect([viewer.status, viewer.body.code]).toEqual([403, "READ_ONLY"]);
    setLevel(target.id, member.userId, "edit");
    setLevel(source.id, member.userId, "comment");
    expect((await call(member, "POST", `/cards/${plain.id}/move-board`, { boardId: target.id })).body.code).toBe("READ_ONLY");
    setLevel(source.id, member.userId, "edit");
    // The owner cannot reach the member's private board: 404 like a missing board.
    expect((await call(owner, "POST", `/cards/${plain.id}/move-board`, { boardId: elsewhere.id })).status).toBe(404);
    expect((await call(owner, "POST", `/cards/${plain.id}/move-board`, { boardId: source.id })).body.code).toBe("SAME_BOARD");
    const parent = await card(owner, source.id, source.columns[0]!.id, "Parent", { level: 0 });
    await card(owner, source.id, source.columns[0]!.id, "Child", { parentId: parent.id });
    const withChildren = await call(owner, "POST", `/cards/${parent.id}/move-board`, { boardId: target.id });
    expect([withChildren.status, withChildren.body.code, withChildren.body.childCount]).toEqual([409, "HAS_CHILDREN", 1]);
    expect((await call(owner, "PATCH", `/columns/${target.columns[1]!.id}`, { wipLimit: 1 })).status).toBe(200);
    await card(owner, target.id, target.columns[1]!.id, "Fills it");
    expect((await call(owner, "POST", `/cards/${plain.id}/move-board`, { boardId: target.id, columnId: target.columns[1]!.id })).body.code).toBe("COLUMN_FULL");
    // A column of another board is not found.
    expect((await call(owner, "POST", `/cards/${plain.id}/move-board`, { boardId: target.id, columnId: source.columns[0]!.id })).status).toBe(404);
    // The member, with edit on both, moves it.
    expect((await call(member, "POST", `/cards/${plain.id}/move-board`, { boardId: target.id })).status).toBe(200);
  });

  test("two moves in opposite directions at once both finish (locks taken in board order)", async () => {
    const { owner, source, target } = await scene("Keys Race");
    const one = await card(owner, source.id, source.columns[0]!.id, "One way");
    const two = await card(owner, target.id, target.columns[0]!.id, "Other way");
    const [a, b] = await Promise.all([
      call(owner, "POST", `/cards/${one.id}/move-board`, { boardId: target.id }),
      call(owner, "POST", `/cards/${two.id}/move-board`, { boardId: source.id })
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});

describe("MCP (D713, D716)", () => {
  const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Keys", surfaces: "both", grants, expiresInDays: 30 }).id;
  async function tool(keyId: string, name: string, args: Record<string, unknown> = {}) {
    const result = await invokeMcpToolForTests(name, args, keyId);
    return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
  }

  test("get_card takes a key; a key limited to chosen boards reaches only those; move_card_to_board needs both boards", async () => {
    const owner = await createUser("Keys MCP owner");
    const a = await board(owner, "MCP keys A", { code: "MKA" });
    const b = await board(owner, "MCP keys B", { code: "MKB" });
    const one = await card(owner, a.id, a.columns[0]!.id, "By key");
    const whole = key(owner, [{ module: "tasks", permission: "write", resourceKind: null, resourceId: null }]);
    const read = await tool(whole, "get_card", { cardId: "mka-1" });
    expect(read.isError).toBe(false);
    expect(read.value.card).toMatchObject({ id: one.id, key: "MKA-1" });
    expect((await tool(whole, "get_card", { cardId: "MKA-99" })).value.code).toBe("NOT_FOUND");
    // list_cards keys each card from the board it loaded.
    await card(owner, a.id, a.columns[0]!.id, "Second");
    const listed = await tool(whole, "list_cards", { boardId: a.id });
    expect((listed.value.cards as Array<{ title: string; key: string }>).map((item) => [item.title, item.key])).toEqual([["By key", "MKA-1"], ["Second", "MKA-2"]]);
    const onlyB = key(owner, [{ module: "tasks", permission: "write", resourceKind: "board", resourceId: b.id }]);
    expect((await tool(onlyB, "get_card", { cardId: "MKA-1" })).value.code).toBe("NOT_FOUND");
    expect((await tool(onlyB, "move_card_to_board", { cardId: "MKA-1", boardId: b.id })).value.code).toBe("NOT_FOUND");
    const moved = await tool(whole, "move_card_to_board", { cardId: "MKA-1", boardId: b.id });
    expect(moved.isError).toBe(false);
    expect(moved.value.card).toMatchObject({ id: one.id, key: "MKB-1", board_id: b.id, previous_key: "MKA-1" });
    expect((await tool(whole, "get_card", { cardId: "MKA-1" })).value.card.key).toBe("MKB-1");
  });
});
