import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTaskQueryRateLimit } = await import("../server/tasks/queryRoutes");
const { VIEW_LIMITS } = await import("../server/tasks/views");

/** Saved task views and column state (research 2026-09-26 §10.2, §10.4, D140, D141, T115, T116, T121; migration 020). */

type Column = { id: string; name: string; is_done: 0 | 1; state: string; position: number };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const ours = new Set<string>();
async function board(owner: Session, name: string) {
  const created = await call(owner, "POST", "/boards", { name });
  ours.add(created.body.board.id);
  return { id: created.body.board.id as string, columns: created.body.columns as [Column, Column, Column] };
}
const titles = (body: Record<string, any>) => (body.cards as Array<{ title: string; board_id: string }>).filter((card) => ours.has(card.board_id)).map((card) => card.title).sort();
const lastAudit = (userId: string, event: string) => {
  const row = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY rowid DESC LIMIT 1").get(userId, event) as { metadata_json: string } | null;
  return row ? JSON.parse(row.metadata_json) as Record<string, unknown> : null;
};
/** T121: the stored state and the done flag never disagree. */
const expectStateConsistent = () =>
  expect((db.query("SELECT COUNT(*) AS count FROM board_columns WHERE (state = 'done') <> (is_done = 1)").get() as { count: number }).count).toBe(0);

beforeEach(() => resetTaskQueryRateLimit());

describe("column state (D141, T121)", () => {
  test("new boards and columns get states; the owner sets state, which drives is_done", async () => {
    const owner = await createUser("State owner");
    const member = await createUser("State member");
    const stranger = await createUser("State stranger");
    const target = await board(owner, "State board");
    expect(target.columns.map((column) => [column.name, column.state, column.is_done])).toEqual([["To do", "todo", 0], ["Doing", "doing", 0], ["Done", "done", 1]]);
    expect((await call(owner, "PUT", `/boards/${target.id}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
    const added = await call(owner, "POST", `/boards/${target.id}/columns`, { name: "Review" });
    expect(added.body.column).toMatchObject({ state: "doing", is_done: 0 });
    expectStateConsistent();

    let patched = await call(owner, "PATCH", `/columns/${added.body.column.id}`, { state: "done" });
    expect(patched.body.column).toMatchObject({ state: "done", is_done: 1 });
    expect(lastAudit(owner.userId, "task.column_state")).toEqual({ boardId: target.id, columnId: added.body.column.id, state: "done" });
    expectStateConsistent();
    patched = await call(owner, "PATCH", `/columns/${added.body.column.id}`, { state: "todo" });
    expect(patched.body.column).toMatchObject({ state: "todo", is_done: 0 });
    // isDone keeps working: on sets done; off sets todo for the first column and doing otherwise.
    patched = await call(owner, "PATCH", `/columns/${target.columns[0].id}`, { isDone: true });
    expect(patched.body.column).toMatchObject({ state: "done", is_done: 1 });
    patched = await call(owner, "PATCH", `/columns/${target.columns[0].id}`, { isDone: false });
    expect(patched.body.column).toMatchObject({ state: "todo", is_done: 0 });
    patched = await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { isDone: false });
    expect(patched.body.column).toMatchObject({ state: "doing", is_done: 0 });
    // isDone false on a column that is not done keeps its state.
    patched = await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { state: "todo" });
    patched = await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { isDone: false });
    expect(patched.body.column).toMatchObject({ state: "todo" });
    expect((await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { isDone: true, state: "done" })).body.column).toMatchObject({ state: "done", is_done: 1 });
    expectStateConsistent();

    expect((await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { isDone: false, state: "done" })).status).toBe(400);
    expect((await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { state: "later" })).status).toBe(400);
    expect((await call(member, "PATCH", `/columns/${target.columns[2].id}`, { state: "todo" })).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(stranger, "PATCH", `/columns/${target.columns[2].id}`, { state: "todo" })).status).toBe(404);
    // Reorder, rename, and delete leave the pair consistent.
    await call(owner, "PATCH", `/columns/${target.columns[2].id}`, { afterColumnId: null, name: "Shipped" });
    await call(owner, "DELETE", `/columns/${added.body.column.id}`);
    expectStateConsistent();
    const columns = (await call(owner, "GET", `/boards/${target.id}`)).body.columns as Column[];
    expect(columns.every((column) => ["todo", "doing", "done"].includes(column.state))).toBe(true);
  });

  test("the query's state filter reads the stored state", async () => {
    const owner = await createUser("State query");
    const target = await board(owner, "State query board");
    await call(owner, "POST", `/boards/${target.id}/cards`, { columnId: target.columns[1].id, title: "Middle" });
    expect(titles((await call(owner, "POST", "/query", { q: "state:doing" })).body)).toEqual(["Middle"]);
    await call(owner, "PATCH", `/columns/${target.columns[1].id}`, { state: "todo" });
    expect(titles((await call(owner, "POST", "/query", { q: "state:todo" })).body)).toEqual(["Middle"]);
    expect((await call(owner, "POST", "/query", { q: "state:todo" })).body.cards.find((card: { title: string }) => card.title === "Middle"))
      .toMatchObject({ column_state: "todo", is_done: 0 });
  });
});

/**
 * Alice owns a private board and a board shared with Bob. Carol is a
 * stranger. Alice's view names her private board; sharing it never shows Bob
 * or Carol those cards.
 */
async function sharing(label: string) {
  const alice = await createUser(`${label} Alice`);
  const bob = await createUser(`${label} Bob`);
  const carol = await createUser(`${label} Carol`);
  const privateBoard = await board(alice, `${label} Private`);
  const sharedBoard = await board(alice, `${label} Shared`);
  expect((await call(alice, "PUT", `/boards/${sharedBoard.id}/sharing`, { visibility: "selected", userIds: [bob.userId] })).status).toBe(200);
  await call(alice, "POST", `/boards/${privateBoard.id}/cards`, { columnId: privateBoard.columns[0].id, title: "Private plan", assigneeIds: [alice.userId] });
  await call(alice, "POST", `/boards/${sharedBoard.id}/cards`, { columnId: sharedBoard.columns[0].id, title: "Shared plan", assigneeIds: [alice.userId, bob.userId] });
  const created = await call(alice, "POST", "/views", {
    name: `${label} plans`,
    query: `board:${privateBoard.id},${sharedBoard.id}  state:todo`,
    display: { layout: "table", group: "board", sort: "title" }
  });
  expect(created.status).toBe(201);
  return { alice, bob, carol, privateBoard, sharedBoard, view: created.body.view as Record<string, any> };
}

describe("task views: create, read, and run as the viewer (T115, T116)", () => {
  test("create stores the canonical query and display; the owner runs it", async () => {
    const { alice, privateBoard, sharedBoard, view } = await sharing("Create");
    const [first, second] = [privateBoard.id, sharedBoard.id].sort();
    expect(view).toMatchObject({
      name: "Create plans", owner_id: alice.userId, owner_name: "Create Alice", is_owner: 1, visibility: "private", revision: 1,
      query: `board:${first},${second} state:todo`, display: { layout: "table", group: "board", sort: "title" }
    });
    expect(lastAudit(alice.userId, "task.view_create")).toEqual({ viewId: view.id });
    const run = await call(alice, "GET", `/views/${view.id}/cards`);
    expect(run.status).toBe(200);
    expect(titles(run.body)).toEqual(["Private plan", "Shared plan"]);
    expect(run.body.view.id).toBe(view.id);
    expect(run.body.refs.boards).toHaveLength(2);
    expect((await call(alice, "GET", "/views")).body.mine.map((item: { id: string }) => item.id)).toContain(view.id);
  });

  test("a shared view runs as the recipient: never cards from boards only the owner can read", async () => {
    const { alice, bob, carol, privateBoard, view } = await sharing("Matrix");
    // Private: Bob and Carol get 404, the same as a missing view.
    expect((await call(bob, "GET", `/views/${view.id}`)).status).toBe(404);
    expect((await call(bob, "GET", `/views/${view.id}/cards`)).status).toBe(404);
    expect((await call(bob, "GET", `/views/${crypto.randomUUID()}`)).status).toBe(404);

    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [bob.userId] })).status).toBe(200);
    expect(lastAudit(alice.userId, "task.view_sharing_changed")).toEqual({ viewId: view.id, visibility: "selected", recipientCount: 1 });
    const bobRun = await call(bob, "GET", `/views/${view.id}/cards`);
    expect(bobRun.status).toBe(200);
    expect(titles(bobRun.body)).toEqual(["Shared plan"]);
    expect(bobRun.body.refs.boards).toContainEqual({ id: privateBoard.id, restricted: true });
    expect(JSON.stringify(bobRun.body)).not.toContain("Private plan");
    expect(JSON.stringify(bobRun.body)).not.toContain("Matrix Private");
    expect((await call(bob, "GET", "/views")).body.shared.map((item: { id: string }) => item.id)).toEqual([view.id]);
    expect((await call(carol, "GET", `/views/${view.id}/cards`)).status).toBe(404);

    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "all_users" })).status).toBe(200);
    const carolRun = await call(carol, "GET", `/views/${view.id}/cards`);
    expect(carolRun.status).toBe(200);
    expect(titles(carolRun.body)).toEqual([]);
    expect((await call(carol, "GET", "/views")).body.everyone.map((item: { id: string }) => item.id)).toContain(view.id);
    expect((await call(bob, "GET", "/views")).body.shared.map((item: { id: string }) => item.id)).toEqual([]);

    // Bob loses the board: the view still opens, with nothing in it.
    expect((await call(alice, "PUT", `/boards/${(await call(alice, "GET", "/boards")).body.boards.find((b: { name: string }) => b.name === "Matrix Shared").id}/sharing`, { visibility: "private" })).status).toBe(200);
    expect(titles((await call(bob, "GET", `/views/${view.id}/cards`)).body)).toEqual([]);
  });

  test("assignee:me in a shared view means the viewer", async () => {
    const { alice, bob, view } = await sharing("Me");
    const mine = await call(alice, "POST", "/views", { name: "My plans", query: "assignee:me" });
    expect((await call(alice, "PUT", `/views/${mine.body.view.id}/sharing`, { visibility: "selected", userIds: [bob.userId] })).status).toBe(200);
    expect(titles((await call(alice, "GET", `/views/${mine.body.view.id}/cards`)).body)).toEqual(["Private plan", "Shared plan"]);
    expect(titles((await call(bob, "GET", `/views/${mine.body.view.id}/cards`)).body)).toEqual(["Shared plan"]);
    expect(view.id).toBeTruthy();
  });

  test("a disabled owner's shared views vanish for recipients", async () => {
    const { alice, bob, view } = await sharing("Disabled");
    await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "all_users" });
    expect((await call(bob, "GET", `/views/${view.id}`)).status).toBe(200);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), alice.userId);
    try {
      expect((await call(bob, "GET", `/views/${view.id}`)).status).toBe(404);
      expect((await call(bob, "GET", "/views")).body.everyone.map((item: { id: string }) => item.id)).not.toContain(view.id);
    } finally {
      db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(alice.userId);
    }
  });

  test("create validates the filter, the display, the name, and the per-owner cap", async () => {
    const owner = await createUser("Views cap");
    expect(await call(owner, "POST", "/views", { name: "Bad", query: "owner:me" })).toMatchObject({ status: 400, body: { code: "FILTER_INVALID", position: 0 } });
    expect(await call(owner, "POST", "/views", { name: "Scope", query: `column:${crypto.randomUUID()}` })).toMatchObject({ status: 400, body: { code: "FILTER_SCOPE" } });
    expect(await call(owner, "POST", "/views", { name: "Later", query: "sprint:someday" })).toMatchObject({ status: 400, body: { code: "FILTER_INVALID" } });
    expect((await call(owner, "POST", "/views", { name: "", query: "" })).status).toBe(400);
    expect((await call(owner, "POST", "/views", { name: "x".repeat(81), query: "" })).status).toBe(400);
    expect((await call(owner, "POST", "/views", { name: "Bidi‮", query: "" })).status).toBe(400);
    expect((await call(owner, "POST", "/views", { name: "Layout", query: "", display: { layout: "gantt" } })).status).toBe(400);
    expect((await call(owner, "POST", "/views", { name: "Extra", query: "", display: { color: "red" } })).status).toBe(400);
    expect((await call(owner, "POST", "/views", { name: "Fields", query: "", display: { fields: ["due", "due"] } })).status).toBe(400);
    expect((await call(owner, "POST", "/views", { name: "Everything", query: "" })).body.view).toMatchObject({ query: "", display: { layout: "list", group: "none", sort: "due" } });
    for (let index = 1; index < VIEW_LIMITS.perOwner; index += 1) expect((await call(owner, "POST", "/views", { name: `View ${index}`, query: "state:todo" })).status).toBe(201);
    expect(await call(owner, "POST", "/views", { name: "One too many", query: "" })).toMatchObject({ status: 409, body: { code: "LIMIT_REACHED" } });
    const listed = (await call(owner, "GET", "/views")).body.mine as Array<{ position: number }>;
    expect(listed).toHaveLength(VIEW_LIMITS.perOwner);
    expect(listed.map((item) => item.position)).toEqual([...listed.map((item) => item.position)].sort((a, b) => a - b));
  });
});

describe("task views: owner-only changes, CAS, duplicate, delete", () => {
  test("only the owner edits, shares, or deletes; readers get 403 and others 404", async () => {
    const { alice, bob, carol, view } = await sharing("Owner");
    await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [bob.userId] });
    expect((await call(bob, "PATCH", `/views/${view.id}`, { name: "Mine now", revision: 1 })).body.code).toBe("OWNER_ONLY");
    expect((await call(bob, "PUT", `/views/${view.id}/sharing`, { visibility: "all_users" })).body.code).toBe("OWNER_ONLY");
    expect((await call(bob, "GET", `/views/${view.id}/sharing`)).body.code).toBe("OWNER_ONLY");
    expect((await call(bob, "DELETE", `/views/${view.id}`)).body.code).toBe("OWNER_ONLY");
    expect((await call(carol, "PATCH", `/views/${view.id}`, { name: "x", revision: 1 })).status).toBe(404);
    expect((await call(carol, "DELETE", `/views/${view.id}`)).status).toBe(404);
    expect((await call(carol, "POST", `/views/${view.id}/duplicate`)).status).toBe(404);
    expect((await call(alice, "GET", `/views/${view.id}/sharing`)).body).toEqual({ visibility: "selected", users: [{ id: bob.userId, display_name: "Owner Bob" }] });
    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [] })).status).toBe(400);
    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [alice.userId] })).status).toBe(400);
    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [crypto.randomUUID()] })).status).toBe(400);
  });

  test("a sharing change bumps the revision, so an editor holding the old one gets 409 VIEW_CHANGED", async () => {
    const { alice, bob, view } = await sharing("Share revision");
    expect(view.revision).toBe(1);
    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [bob.userId] })).status).toBe(200);
    const stale = await call(alice, "PATCH", `/views/${view.id}`, { name: "Stale editor", revision: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "VIEW_CHANGED", view: { visibility: "selected", revision: 2 } } });
    expect((await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "private" })).status).toBe(200);
    expect((await call(alice, "GET", `/views/${view.id}`)).body.view).toMatchObject({ visibility: "private", revision: 3 });
    expect((await call(alice, "PATCH", `/views/${view.id}`, { name: "Fresh editor", revision: 3 })).body.view).toMatchObject({ name: "Fresh editor", revision: 4 });
  });

  test("patch uses a revision compare-and-swap, re-canonicalizes the query, and merges display", async () => {
    const { alice, view } = await sharing("Patch");
    const patched = await call(alice, "PATCH", `/views/${view.id}`, { name: "Renamed", query: "due:week   assignee:me", display: { layout: "board" }, revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.view).toMatchObject({ name: "Renamed", query: "assignee:me due:week", revision: 2, display: { layout: "board", group: "board", sort: "title" } });
    expect(lastAudit(alice.userId, "task.view_update")).toEqual({ viewId: view.id, renamed: true, query: true, display: true });
    const stale = await call(alice, "PATCH", `/views/${view.id}`, { name: "Stale", revision: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "VIEW_CHANGED", view: { name: "Renamed", revision: 2 } } });
    expect((await call(alice, "PATCH", `/views/${view.id}`, { query: "nope:1", revision: 2 })).body.code).toBe("FILTER_INVALID");
    expect((await call(alice, "PATCH", `/views/${view.id}`, { revision: 2 })).status).toBe(400);
    // Reorder: put a second view first.
    const second = (await call(alice, "POST", "/views", { name: "Second", query: "" })).body.view;
    const moved = await call(alice, "PATCH", `/views/${second.id}`, { afterViewId: null, revision: 1 });
    expect(moved.body.view.position).toBeLessThan(patched.body.view.position);
    expect((await call(alice, "GET", "/views")).body.mine.slice(0, 2).map((item: { id: string }) => item.id)).toEqual([second.id, view.id]);
    expect((await call(alice, "PATCH", `/views/${second.id}`, { afterViewId: crypto.randomUUID(), revision: 2 })).status).toBe(404);
    expect((await call(alice, "PATCH", `/views/${second.id}`, { afterViewId: second.id, revision: 2 })).status).toBe(400);
  });

  test("recipients duplicate a view into a private copy; the owner deletes", async () => {
    const { alice, bob, view } = await sharing("Copy");
    await call(alice, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [bob.userId] });
    const copy = await call(bob, "POST", `/views/${view.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body.view).toMatchObject({ name: "Copy plans (copy)", owner_id: bob.userId, visibility: "private", query: view.query, display: view.display, revision: 1 });
    expect(lastAudit(bob.userId, "task.view_create")).toEqual({ viewId: copy.body.view.id, sourceViewId: view.id });
    // The copy is Bob's: he edits it, and it still only shows what Bob can read.
    expect((await call(bob, "PATCH", `/views/${copy.body.view.id}`, { name: "Bob's", revision: 1 })).status).toBe(200);
    expect(titles((await call(bob, "GET", `/views/${copy.body.view.id}/cards`)).body)).toEqual(["Shared plan"]);
    expect((await call(alice, "DELETE", `/views/${view.id}`)).body).toEqual({ ok: true });
    expect(lastAudit(alice.userId, "task.view_delete")).toEqual({ viewId: view.id });
    expect((await call(bob, "GET", `/views/${view.id}`)).status).toBe(404);
    expect((await call(bob, "GET", `/views/${copy.body.view.id}`)).status).toBe(200);
    expect((await call(alice, "DELETE", `/views/${view.id}`)).status).toBe(404);
  });

  test("view cards page with the view's sort and validate query parameters", async () => {
    const owner = await createUser("View pages");
    const target = await board(owner, "View pages board");
    for (const title of ["C", "A", "B"]) await call(owner, "POST", `/boards/${target.id}/cards`, { columnId: target.columns[0].id, title });
    const view = (await call(owner, "POST", "/views", { name: "Titles", query: `board:${target.id}`, display: { sort: "title" } })).body.view;
    const first = await call(owner, "GET", `/views/${view.id}/cards?limit=2`);
    expect(first.body.cards.map((card: { title: string }) => card.title)).toEqual(["A", "B"]);
    const second = await call(owner, "GET", `/views/${view.id}/cards?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toMatchObject({ nextCursor: null });
    expect(second.body.cards.map((card: { title: string }) => card.title)).toEqual(["C"]);
    expect((await call(owner, "GET", `/views/${view.id}/cards?limit=101`)).status).toBe(400);
    expect((await call(owner, "GET", `/views/${view.id}/cards?limit=abc`)).status).toBe(400);
    expect((await call(owner, "GET", `/views/${view.id}/cards?tz=Nowhere/Else`)).status).toBe(400);
    expect((await call(owner, "GET", `/views/${view.id}/cards?cursor=${"x".repeat(2000)}`)).status).toBe(400);
    expect((await call(owner, "GET", `/views/not-a-uuid/cards`)).status).toBe(400);
  });
});
