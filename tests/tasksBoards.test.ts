import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

type Board = { id: string; name: string; owner_id: string; owner_name: string; is_owner: number; visibility: string; card_count: number };
type Column = { id: string; board_id: string; name: string; position: number };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function newBoard(owner: Session, name = "Launch plan") {
  const created = await call(owner, "POST", "/boards", { name });
  expect(created.status).toBe(201);
  return created.body as { board: Board; columns: Column[] };
}

async function share(owner: Session, boardId: string, visibility: string, userIds: string[] = []) {
  const result = await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility, userIds });
  expect(result.status).toBe(200);
}

function insertCard(boardId: string, columnId: string, position: number, options: { deleted?: boolean } = {}) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  db.query("INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at, deleted_at, purge_after) VALUES (?, ?, ?, ?, 'Card', ?, ?, ?, ?)")
    .run(id, boardId, columnId, position, timestamp, timestamp, options.deleted ? timestamp : null, options.deleted ? timestamp : null);
  return id;
}

describe("task boards", () => {
  test("creating a board adds To do, Doing, and Done at 1024, 2048, and 3072", async () => {
    const owner = await createUser("Board owner");
    const { board, columns } = await newBoard(owner, "  Launch plan  ");
    expect(board).toMatchObject({ name: "Launch plan", owner_id: owner.userId, owner_name: "Board owner", is_owner: 1, visibility: "private", card_count: 0 });
    expect(columns.map((column) => [column.name, column.position])).toEqual([["To do", 1024], ["Doing", 2048], ["Done", 3072]]);
    const fetched = await call(owner, "GET", `/boards/${board.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.columns.map((column: Column) => column.name)).toEqual(["To do", "Doing", "Done"]);
    expect(fetched.body.cards).toEqual([]);
  });

  test("validates board names and rejects unknown fields", async () => {
    const owner = await createUser("Name validator");
    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(121) }, { name: "bad\u0000name" }, { name: "rtl‮override" }, { name: "ok", extra: 1 }, {}]) {
      expect((await call(owner, "POST", "/boards", body)).status).toBe(400);
    }
    expect((await call(owner, "POST", "/boards", { name: "x".repeat(120) })).status).toBe(201);
    expect((await call(owner, "GET", "/boards/not-a-uuid")).status).toBe(400);
  });

  test("lists owned boards first and shared boards with the owner's name, never others", async () => {
    const owner = await createUser("Lister owner");
    const member = await createUser("Lister member");
    const stranger = await createUser("Lister stranger");
    const { board: shared } = await newBoard(owner, "Shared board");
    await newBoard(owner, "Private board");
    const { board: own } = await newBoard(member, "Member's own");
    await share(owner, shared.id, "selected", [member.userId]);

    const listed = (await call(member, "GET", "/boards")).body.boards as Board[];
    const mine = listed.filter((board) => board.owner_id === owner.userId || board.owner_id === member.userId);
    expect(mine.map((board) => [board.name, board.is_owner, board.owner_name])).toEqual([["Member's own", 1, "Lister member"], ["Shared board", 0, "Lister owner"]]);
    expect(mine[0]!.id).toBe(own.id);
    const strangerBoards = (await call(stranger, "GET", "/boards")).body.boards as Board[];
    expect(strangerBoards.some((board) => board.owner_id === owner.userId)).toBe(false);
  });

  test("owner-only actions return 403 OWNER_ONLY to a member and 404 to a stranger", async () => {
    const owner = await createUser("Matrix owner");
    const member = await createUser("Matrix member");
    const stranger = await createUser("Matrix stranger");
    const { board, columns } = await newBoard(owner);
    await share(owner, board.id, "selected", [member.userId]);
    const columnId = columns[1]!.id;
    // Structure is the owner's or a manager's (MANAGER_REQUIRED, Wave 32 D273); deleting and the
    // older sharing route stay the owner's. A member at edit is neither.
    const ownerOnly: Array<[string, string, unknown?, string?]> = [
      ["PATCH", `/boards/${board.id}`, { name: "Renamed" }, "MANAGER_REQUIRED"],
      ["DELETE", `/boards/${board.id}`],
      ["GET", `/boards/${board.id}/sharing`],
      ["PUT", `/boards/${board.id}/sharing`, { visibility: "private", userIds: [] }],
      ["POST", `/boards/${board.id}/columns`, { name: "Review" }, "MANAGER_REQUIRED"],
      ["PATCH", `/columns/${columnId}`, { name: "Renamed" }, "MANAGER_REQUIRED"],
      ["PATCH", `/columns/${columnId}`, { afterColumnId: null }, "MANAGER_REQUIRED"],
      ["DELETE", `/columns/${columnId}`, undefined, "MANAGER_REQUIRED"]
    ];
    for (const [method, path, body, code = "OWNER_ONLY"] of ownerOnly) {
      const asMember = await call(member, method, path, body);
      expect([method, path, asMember.status, asMember.body.code]).toEqual([method, path, 403, code]);
      const asStranger = await call(stranger, method, path, body);
      expect([method, path, asStranger.status]).toEqual([method, path, 404]);
    }
    expect((await call(member, "GET", `/boards/${board.id}`)).status).toBe(200);
    expect((await call(stranger, "GET", `/boards/${board.id}`)).status).toBe(404);
    // Nothing changed.
    const after = (await call(owner, "GET", `/boards/${board.id}`)).body;
    expect(after.board.name).toBe("Launch plan");
    expect(after.columns.map((column: Column) => column.name)).toEqual(["To do", "Doing", "Done"]);
    const unknown = crypto.randomUUID();
    expect((await call(owner, "GET", `/boards/${unknown}`)).status).toBe(404);
    expect((await call(owner, "PATCH", `/columns/${unknown}`, { name: "x" })).status).toBe(404);
  });

  test("all_users boards are readable by everyone but still owner-managed", async () => {
    const owner = await createUser("Open owner");
    const anyone = await createUser("Open anyone");
    const { board } = await newBoard(owner, "Open board");
    expect((await call(anyone, "GET", `/boards/${board.id}`)).status).toBe(404);
    await share(owner, board.id, "all_users");
    const seen = await call(anyone, "GET", `/boards/${board.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.board).toMatchObject({ is_owner: 0, visibility: "all_users" });
    expect((await call(anyone, "PATCH", `/boards/${board.id}`, { name: "Mine now" })).body.code).toBe("MANAGER_REQUIRED");
  });

  test("sharing follows the notes rules and revokes access at once", async () => {
    const owner = await createUser("Sharing owner");
    const member = await createUser("Sharing member");
    const { board } = await newBoard(owner);
    const put = (body: unknown) => call(owner, "PUT", `/boards/${board.id}/sharing`, body);
    expect((await put({ visibility: "selected", userIds: [owner.userId] })).status).toBe(400);
    expect((await put({ visibility: "selected", userIds: [] })).status).toBe(400);
    expect((await put({ visibility: "selected", userIds: [crypto.randomUUID()] })).status).toBe(400);
    expect((await put({ visibility: "selected", userIds: Array.from({ length: 101 }, () => crypto.randomUUID()) })).status).toBe(400);
    expect((await put({ visibility: "inherit", userIds: [] })).status).toBe(400);

    await share(owner, board.id, "selected", [member.userId, member.userId]);
    expect((await call(owner, "GET", `/boards/${board.id}/sharing`)).body).toEqual({ visibility: "selected", users: [{ id: member.userId, display_name: "Sharing member" }] });
    expect((await call(member, "GET", `/boards/${board.id}`)).status).toBe(200);

    await share(owner, board.id, "private");
    expect((await call(owner, "GET", `/boards/${board.id}/sharing`)).body).toEqual({ visibility: "private", users: [] });
    expect((await call(member, "GET", `/boards/${board.id}`)).status).toBe(404);
  });

  test("rename and delete are owner-only; a deleted board is gone for everyone", async () => {
    const owner = await createUser("Delete owner");
    const member = await createUser("Delete member");
    const { board } = await newBoard(owner);
    await share(owner, board.id, "selected", [member.userId]);
    const renamed = await call(owner, "PATCH", `/boards/${board.id}`, { name: "Q3 plan" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.board.name).toBe("Q3 plan");

    const deleted = await call(owner, "DELETE", `/boards/${board.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    expect(Date.parse(deleted.body.purgeAfter) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const row = db.query("SELECT deleted_at, deleted_by, purge_after FROM boards WHERE id = ?").get(board.id) as Record<string, string | null>;
    expect(row.deleted_by).toBe(owner.userId);
    expect(row.deleted_at).toBeTruthy();
    for (const session of [owner, member]) {
      expect((await call(session, "GET", `/boards/${board.id}`)).status).toBe(404);
      expect(((await call(session, "GET", "/boards")).body.boards as Board[]).some((item) => item.id === board.id)).toBe(false);
    }
    expect((await call(owner, "DELETE", `/boards/${board.id}`)).status).toBe(404);
  });

  test("an owner can have at most 50 live boards", async () => {
    const owner = await createUser("Many boards");
    const timestamp = new Date().toISOString();
    const insert = db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'Filler', ?, ?)");
    for (let index = 0; index < 49; index += 1) insert.run(crypto.randomUUID(), owner.userId, timestamp, timestamp);
    const fiftieth = await newBoard(owner, "Fiftieth");
    const refused = await call(owner, "POST", "/boards", { name: "Fifty-first" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LIMIT_REACHED");
    expect((await call(owner, "DELETE", `/boards/${fiftieth.board.id}`)).status).toBe(200);
    expect((await call(owner, "POST", "/boards", { name: "Room again" })).status).toBe(201);
  });

  test("audits board and column changes with ids only", async () => {
    const owner = await createUser("Audit owner");
    const member = await createUser("Audit member");
    const { board, columns } = await newBoard(owner, "Secret project name");
    await call(owner, "PATCH", `/boards/${board.id}`, { name: "Another secret" });
    await share(owner, board.id, "selected", [member.userId]);
    const column = (await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Hidden column" })).body.column as Column;
    await call(owner, "PATCH", `/columns/${column.id}`, { name: "Hidden again", afterColumnId: null });
    await call(owner, "DELETE", `/columns/${columns[2]!.id}`);
    await call(owner, "DELETE", `/boards/${board.id}`);
    const events = db.query("SELECT event_type, metadata_json FROM audit_log WHERE actor_id = ? AND event_type LIKE 'task.%' ORDER BY created_at, rowid").all(owner.userId) as Array<{ event_type: string; metadata_json: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      "task.board_create", "task.board_rename", "task.board_sharing_changed", "task.column_create", "task.column_rename", "task.column_move", "task.column_delete", "task.board_delete"
    ]);
    for (const event of events) {
      expect(event.metadata_json).not.toMatch(/secret|Hidden/i);
      expect(JSON.parse(event.metadata_json).boardId).toBe(board.id);
    }
    expect(JSON.parse(events[2]!.metadata_json)).toEqual({ boardId: board.id, visibility: "selected", recipientCount: 1 });
  });

  test("task mutations keep the JSON, Origin, and CSRF rules", async () => {
    const owner = await createUser("Csrf owner");
    const noCsrf = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { "X-CSRF-Token": "wrong" } }, owner);
    expect(noCsrf.status).toBe(403);
    const form = await request("/tasks/boards", { method: "POST", body: "name=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, owner);
    expect(form.status).toBe(415);
    const foreign = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { Origin: "https://evil.example" } }, owner);
    expect(foreign.status).toBe(403);
    expect((await request("/tasks/boards")).status).toBe(401);
  });
});

describe("board columns", () => {
  test("adds columns at the end or after an anchor with server-computed positions", async () => {
    const owner = await createUser("Column owner");
    const { board, columns } = await newBoard(owner);
    const end = await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Shipped" });
    expect(end.status).toBe(201);
    expect(end.body.column).toMatchObject({ name: "Shipped", position: 4096 });
    const middle = await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Review", afterColumnId: columns[1]!.id });
    expect(middle.body.column.position).toBe(2560);
    const first = await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Ideas", afterColumnId: null });
    expect(first.body.column.position).toBe(512);
    expect(first.body.columns.map((column: Column) => column.name)).toEqual(["Ideas", "To do", "Doing", "Review", "Done", "Shipped"]);
    // Positions are never taken from the client.
    expect((await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Bad", position: 1 })).status).toBe(400);
    expect((await call(owner, "POST", `/boards/${board.id}/columns`, { name: "x".repeat(61) })).status).toBe(400);
  });

  test("renames and reorders a column, rejecting anchors from another board", async () => {
    const owner = await createUser("Reorder owner");
    const { board, columns } = await newBoard(owner);
    const other = await newBoard(owner, "Other board");
    const [todo, doing, done] = columns as [Column, Column, Column];
    const moved = await call(owner, "PATCH", `/columns/${done.id}`, { afterColumnId: todo.id, name: "Finished" });
    expect(moved.status).toBe(200);
    expect(moved.body.columns.map((column: Column) => column.name)).toEqual(["To do", "Finished", "Doing"]);
    expect(moved.body.column.position).toBe(1536);
    const toEnd = await call(owner, "PATCH", `/columns/${todo.id}`, { afterColumnId: doing.id });
    expect(toEnd.body.columns.map((column: Column) => column.name)).toEqual(["Finished", "Doing", "To do"]);
    expect((await call(owner, "PATCH", `/columns/${todo.id}`, { afterColumnId: todo.id })).status).toBe(400);
    // IDOR: a column of board B is never an anchor on board A.
    const foreign = await call(owner, "PATCH", `/columns/${todo.id}`, { afterColumnId: other.columns[0]!.id });
    expect(foreign.status).toBe(404);
    expect((await call(owner, "POST", `/boards/${board.id}/columns`, { name: "X", afterColumnId: other.columns[0]!.id })).status).toBe(404);
    expect((await call(owner, "PATCH", `/columns/${todo.id}`, {})).status).toBe(400);
  });

  test("renormalises column positions when a gap drops below 1e-6", async () => {
    const owner = await createUser("Renormalise owner");
    const { board, columns } = await newBoard(owner);
    const [todo, doing, done] = columns as [Column, Column, Column];
    db.query("UPDATE board_columns SET position = ? WHERE id = ?").run(1, todo.id);
    db.query("UPDATE board_columns SET position = ? WHERE id = ?").run(1 + 1e-7, doing.id);
    const moved = await call(owner, "PATCH", `/columns/${done.id}`, { afterColumnId: todo.id });
    expect(moved.status).toBe(200);
    expect(moved.body.renormalized).toBe(true);
    expect(moved.body.columns.map((column: Column) => [column.name, column.position])).toEqual([["To do", 1024], ["Done", 2048], ["Doing", 3072]]);
  });

  test("a board has 1 to 20 columns and only empty columns can be deleted", async () => {
    const owner = await createUser("Column caps");
    const { board, columns } = await newBoard(owner);
    for (let index = 3; index < 20; index += 1) expect((await call(owner, "POST", `/boards/${board.id}/columns`, { name: `C${index}` })).status).toBe(201);
    const refused = await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Twenty-first" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LIMIT_REACHED");

    const cardId = insertCard(board.id, columns[0]!.id, 1024);
    const notEmpty = await call(owner, "DELETE", `/columns/${columns[0]!.id}`);
    expect(notEmpty.status).toBe(409);
    expect(notEmpty.body).toMatchObject({ code: "COLUMN_NOT_EMPTY", cardCount: 1 });
    // A binned card does not block deletion; it loses its column and restores to the first one later.
    db.query("UPDATE cards SET deleted_at = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), cardId);
    expect((await call(owner, "DELETE", `/columns/${columns[0]!.id}`)).status).toBe(200);
    expect((db.query("SELECT column_id FROM cards WHERE id = ?").get(cardId) as { column_id: string | null }).column_id).toBeNull();

    const remaining = (await call(owner, "GET", `/boards/${board.id}`)).body.columns as Column[];
    for (const column of remaining.slice(1)) expect((await call(owner, "DELETE", `/columns/${column.id}`)).status).toBe(200);
    const last = await call(owner, "DELETE", `/columns/${remaining[0]!.id}`);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe("LAST_COLUMN");
  });

  test("columns of a binned board are unreachable", async () => {
    const owner = await createUser("Binned columns");
    const { board, columns } = await newBoard(owner);
    await call(owner, "DELETE", `/boards/${board.id}`);
    expect((await call(owner, "PATCH", `/columns/${columns[0]!.id}`, { name: "Zombie" })).status).toBe(404);
    expect((await call(owner, "DELETE", `/columns/${columns[0]!.id}`)).status).toBe(404);
    expect((await call(owner, "POST", `/boards/${board.id}/columns`, { name: "Zombie" })).status).toBe(404);
  });
});
