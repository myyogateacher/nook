import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTaskQueryRateLimit, TASK_QUERY_RATE_LIMIT } = await import("../server/tasks/queryRoutes");
const { dateInZone, addDays } = await import("../server/today/registry");

/** `POST /api/tasks/query` (research 2026-09-26 §10.4, D144, T115–T117). */

type Column = { id: string; name: string; is_done: 0 | 1 };
type Card = { id: string; title: string; board_id: string; column_state: string; [key: string]: unknown };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any>, headers: response.headers };
}

const query = (session: Session, body: Record<string, unknown>) => call(session, "POST", "/query", body);
/** Boards made by this file; other files' all_users boards are readable too, so results are narrowed to these. */
const ours = new Set<string>();
const mine = (result: { body: Record<string, any> }) => (result.body.cards as Card[]).filter((card) => ours.has(card.board_id));
const titles = (result: { body: Record<string, any> }) => mine(result).map((card) => card.title).sort();

async function board(owner: Session, name: string) {
  const created = await call(owner, "POST", "/boards", { name });
  ours.add(created.body.board.id);
  return { id: created.body.board.id as string, columns: created.body.columns as [Column, Column, Column] };
}

async function card(session: Session, target: { id: string; columns: Column[] }, title: string, column = 0, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", `/boards/${target.id}/cards`, { columnId: target.columns[column]!.id, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as { id: string; revision: number };
}

const stamp = "2026-01-01T00:00:00.000Z";
const addTag = (boardId: string, name: string, cardIds: string[]) => {
  const tagId = crypto.randomUUID();
  db.query("INSERT INTO board_tags (id, board_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(tagId, boardId, name, stamp, stamp);
  for (const cardId of cardIds) db.query("INSERT INTO card_tags (card_id, tag_id, created_at) VALUES (?, ?, ?)").run(cardId, tagId, stamp);
  return tagId;
};
const addFlag = (cardId: string, flag: string) => db.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)").run(cardId, flag, stamp);
const relate = (source: string, target: string, kind: "relates" | "blocks") => {
  const [a, b] = kind === "relates" && source > target ? [target, source] : [source, target];
  db.query("INSERT INTO card_relations (id, source_card_id, target_card_id, kind, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), a, b, kind, stamp);
};
const setDue = (cardId: string, dueOn: string | null, dueTime: string | null = null, dueTz: string | null = null) =>
  db.query("UPDATE cards SET due_on = ?, due_time = ?, due_tz = ? WHERE id = ?").run(dueOn, dueTime, dueTz, cardId);

beforeEach(() => resetTaskQueryRateLimit());

/**
 * Alice owns two boards and a board shared with Bob. Carol owns a private
 * board. Queries run as each of them.
 */
async function world(label: string) {
  const alice = await createUser(`${label} Alice`);
  const bob = await createUser(`${label} Bob`);
  const carol = await createUser(`${label} Carol`);
  const home = await board(alice, `${label} Home`);
  const work = await board(alice, `${label} Work`);
  const shared = await board(alice, `${label} Shared`);
  expect((await call(alice, "PUT", `/boards/${shared.id}/sharing`, { visibility: "selected", userIds: [bob.userId] })).status).toBe(200);
  const secret = await board(carol, `${label} Secret`);
  const cards = {
    groceries: await card(alice, home, "Groceries", 0, { assigneeIds: [alice.userId] }),
    paint: await card(alice, home, "Paint fence", 1),
    taxes: await card(alice, home, "Taxes done", 2, { assigneeIds: [alice.userId] }),
    invoice: await card(alice, work, "Send invoice", 0, { assigneeIds: [alice.userId] }),
    review: await card(alice, work, "Review PR", 1),
    plan: await card(bob, shared, "Plan trip", 0, { assigneeIds: [bob.userId, alice.userId] }),
    secret: await card(carol, secret, "Carol secret invoice", 0, { assigneeIds: [carol.userId] })
  };
  return { alice, bob, carol, home, work, shared, secret, cards };
}

describe("POST /api/tasks/query: access (T115, T116)", () => {
  test("only live cards on boards the caller can read, whatever the filter names", async () => {
    const w = await world("Access");
    const all = await query(w.alice, { q: "" });
    expect(all.status).toBe(200);
    expect(titles(all)).toEqual(["Groceries", "Paint fence", "Plan trip", "Review PR", "Send invoice", "Taxes done"]);
    expect(all.body.total).toBeGreaterThanOrEqual(6);
    expect(titles(await query(w.bob, { q: "" }))).toEqual(["Plan trip"]);
    // Naming Carol's board matches nothing for others, and refs never resolve its name.
    const probe = await query(w.alice, { q: `board:${w.secret.id} "invoice"` });
    expect(probe.body).toMatchObject({ cards: [], total: 0, refs: { boards: [{ id: w.secret.id, restricted: true }] } });
    expect(JSON.stringify(probe.body)).not.toContain("Secret");
    expect(titles(await query(w.carol, { q: `board:${w.secret.id}` }))).toEqual(["Carol secret invoice"]);
    // Binned cards and binned boards drop out.
    expect((await call(w.alice, "DELETE", `/cards/${w.cards.paint.id}`)).status).toBe(200);
    expect((await call(w.alice, "DELETE", `/boards/${w.work.id}`)).status).toBe(200);
    expect(titles(await query(w.alice, { q: "" }))).toEqual(["Groceries", "Plan trip", "Taxes done"]);
    // Losing membership ends access at once.
    expect((await call(w.alice, "PUT", `/boards/${w.shared.id}/sharing`, { visibility: "private" })).status).toBe(200);
    expect(titles(await query(w.bob, { q: "assignee:me" }))).toEqual([]);
  });

  test("each card carries the caller's level on its board, so the web offers Move only at Can edit (QA v0.13.0 B2)", async () => {
    const w = await world("Levels");
    const levelOf = (result: { body: Record<string, any> }, title: string) => mine(result).find((card) => card.title === title)?.board_level;
    expect(levelOf(await query(w.alice, { q: "" }), "Groceries")).toBe("owner");
    // Bob was added by the older sharing route: Can edit (D38).
    expect(levelOf(await query(w.bob, { q: "" }), "Plan trip")).toBe("edit");
    db.query("UPDATE board_members SET level = 'comment' WHERE board_id = ? AND user_id = ?").run(w.shared.id, w.bob.userId);
    expect(levelOf(await query(w.bob, { q: "" }), "Plan trip")).toBe("comment");
    // A view run as Bob says the same.
    const view = await call(w.bob, "POST", "/views", { name: "Levels view", query: `board:${w.shared.id}` });
    expect(view.status).toBe(201);
    const run = await call(w.bob, "GET", `/views/${view.body.view.id}/cards?tz=UTC`);
    expect(run.status).toBe(200);
    expect(levelOf(run, "Plan trip")).toBe("comment");
  });

  test("refs name readable boards, columns, and users, and mark the rest", async () => {
    const w = await world("Refs");
    const result = await query(w.alice, { q: `board:${w.home.id},${w.secret.id} assignee:${w.bob.userId},${crypto.randomUUID()}` });
    expect(result.status).toBe(200);
    expect(result.body.refs.boards).toContainEqual({ id: w.home.id, name: "Refs Home" });
    expect(result.body.refs.boards).toContainEqual({ id: w.secret.id, restricted: true });
    expect(result.body.refs.users).toContainEqual({ id: w.bob.userId, display_name: "Refs Bob" });
    expect(result.body.refs.users.filter((user: { unknown?: boolean }) => user.unknown)).toHaveLength(1);
    const columns = await query(w.alice, { q: `board:${w.secret.id} column:${w.secret.columns[0].id}` });
    expect(columns.body.refs.columns).toEqual([{ id: w.secret.columns[0].id, restricted: true }]);
  });
});

describe("POST /api/tasks/query: filters", () => {
  test("assignee, creator, and state (first column todo, done column done, the rest doing)", async () => {
    const w = await world("Fields");
    expect(titles(await query(w.alice, { q: "assignee:me" }))).toEqual(["Groceries", "Plan trip", "Send invoice", "Taxes done"]);
    expect(titles(await query(w.alice, { q: "assignee:none" }))).toEqual(["Paint fence", "Review PR"]);
    expect(titles(await query(w.alice, { q: `assignee:none,${w.bob.userId}` }))).toEqual(["Paint fence", "Plan trip", "Review PR"]);
    expect(titles(await query(w.alice, { q: "creator:me" }))).toEqual(["Groceries", "Paint fence", "Review PR", "Send invoice", "Taxes done"]);
    expect(titles(await query(w.alice, { q: `creator:${w.bob.userId}` }))).toEqual(["Plan trip"]);
    expect(titles(await query(w.alice, { q: "state:todo" }))).toEqual(["Groceries", "Plan trip", "Send invoice"]);
    expect(titles(await query(w.alice, { q: "state:doing" }))).toEqual(["Paint fence", "Review PR"]);
    expect(titles(await query(w.alice, { q: "state:done" }))).toEqual(["Taxes done"]);
    expect(titles(await query(w.alice, { q: "assignee:me -state:done" }))).toEqual(["Groceries", "Plan trip", "Send invoice"]);
    const shaped = mine(await query(w.alice, { q: "\"groceries\"" }))[0]!;
    expect(shaped).toMatchObject({
      title: "Groceries", board_id: w.home.id, board_name: "Fields Home", column_name: "To do", column_state: "todo", is_done: 0,
      assignees: [{ id: w.alice.userId, display_name: "Fields Alice", can_read: 1 }], tags: [], flags: [], due_at: null, creator_name: "Fields Alice"
    });
    expect(Object.keys(shaped).some((key) => /^sk\d/.test(key))).toBe(false);
    expect(shaped.description).toBeUndefined();
  });

  test("column needs one board (FILTER_SCOPE), and bad filters report a position", async () => {
    const w = await world("Scope");
    const scoped = await query(w.alice, { q: `board:${w.home.id} column:${w.home.columns[1].id}` });
    expect(titles(scoped)).toEqual(["Paint fence"]);
    expect(scoped.body.refs.columns).toEqual([{ id: w.home.columns[1].id, name: "Doing", board_id: w.home.id }]);
    expect(await query(w.alice, { q: `column:${w.home.columns[1].id}` })).toMatchObject({ status: 400, body: { code: "FILTER_SCOPE", position: 0 } });
    expect(await query(w.alice, { q: "state:todo owner:me" })).toMatchObject({ status: 400, body: { code: "FILTER_INVALID", position: 11 } });
    expect(await query(w.alice, { q: "sprint:someday" })).toMatchObject({ status: 400, body: { code: "FILTER_INVALID", position: 7 } });
    expect((await query(w.alice, { q: "x".repeat(2001) })).status).toBe(400);
    expect((await query(w.alice, { q: "", limit: 101 })).status).toBe(400);
    expect((await query(w.alice, { q: "", limit: 0 })).status).toBe(400);
    expect((await query(w.alice, { q: "", sort: "random" })).status).toBe(400);
    expect((await query(w.alice, { q: "", tz: "Mars/Olympus" })).status).toBe(400);
    expect((await query(w.alice, { q: "", extra: 1 })).status).toBe(400);
  });

  test("tags by id and by name across boards, flags, and none", async () => {
    const w = await world("Tags");
    const homeTag = addTag(w.home.id, "Urgent-ish", [w.cards.groceries.id]);
    addTag(w.work.id, "urgent-ISH", [w.cards.invoice.id]);
    addTag(w.secret.id, "Urgent-ish", [w.cards.secret.id]);
    addFlag(w.cards.review.id, "blocked");
    addFlag(w.cards.review.id, "urgent");
    addFlag(w.cards.paint.id, "on_hold");
    expect(titles(await query(w.alice, { q: `tag:${homeTag}` }))).toEqual(["Groceries"]);
    expect(titles(await query(w.alice, { q: 'tag:"urgent-ish"' }))).toEqual(["Groceries", "Send invoice"]);
    expect(titles(await query(w.alice, { q: "tag:none" }))).toEqual(["Paint fence", "Plan trip", "Review PR", "Taxes done"]);
    expect(titles(await query(w.alice, { q: "flag:blocked,on_hold" }))).toEqual(["Paint fence", "Review PR"]);
    expect(titles(await query(w.alice, { q: "-flag:none" }))).toEqual(["Paint fence", "Review PR"]);
    const review = mine(await query(w.alice, { q: "flag:urgent" }))[0]!;
    expect(review.flags).toEqual(["urgent", "blocked"]);
    const groceries = (await query(w.alice, { q: `tag:${homeTag}` })).body;
    expect(groceries.cards[0].tags).toEqual([{ id: homeTag, name: "Urgent-ish", color: "gray" }]);
    expect(groceries.refs.tags).toEqual([{ id: homeTag, name: "Urgent-ish", color: "gray", board_id: w.home.id }]);
  });

  test("due windows use the caller's zone; negation keeps undated cards", async () => {
    const w = await world("Due");
    const today = dateInZone(new Date(), "UTC");
    setDue(w.cards.groceries.id, addDays(today, -1));
    setDue(w.cards.paint.id, today);
    setDue(w.cards.invoice.id, addDays(today, 6));
    setDue(w.cards.review.id, addDays(today, 7));
    setDue(w.cards.plan.id, addDays(today, 13));
    const q = (text: string) => query(w.alice, { q: text, tz: "UTC" }).then(titles);
    expect(await q("due:overdue")).toEqual(["Groceries"]);
    expect(await q("due:today")).toEqual(["Paint fence"]);
    expect(await q("due:week")).toEqual(["Paint fence", "Send invoice"]);
    expect(await q("due:next-week")).toEqual(["Plan trip", "Review PR"]);
    expect(await q("due:none")).toEqual(["Taxes done"]);
    expect(await q("-due:overdue")).toEqual(["Paint fence", "Plan trip", "Review PR", "Send invoice", "Taxes done"]);
    expect(await q(`due:${today}`)).toEqual(["Paint fence"]);
    expect(await q(`due:<${today}`)).toEqual(["Groceries"]);
    expect(await q(`due:>${addDays(today, 6)}`)).toEqual(["Plan trip", "Review PR"]);
    expect(await q("due:overdue,none")).toEqual(["Groceries", "Taxes done"]);
    // A timed card due today is overdue once its wall time passed.
    setDue(w.cards.paint.id, today, "00:00", "UTC");
    setDue(w.cards.taxes.id, today, "23:59", "UTC");
    const now = new Date();
    if (now.getUTCHours() !== 0 || now.getUTCMinutes() !== 0) expect(await q("due:overdue")).toEqual(["Groceries", "Paint fence"]);
    const timed = mine(await query(w.alice, { q: '"paint"' }))[0]!;
    expect(timed).toMatchObject({ due_on: today, due_time: "00:00", due_tz: "UTC", due_at: `${today}T00:00:00.000Z` });
  });

  test("text matches titles and excerpts without wildcards; relations follow per-viewer visibility", async () => {
    const w = await world("Text");
    db.query("UPDATE cards SET description_excerpt = 'call the plumber' WHERE id = ?").run(w.cards.paint.id);
    expect(titles(await query(w.alice, { q: "plumber" }))).toEqual(["Paint fence"]);
    expect(titles(await query(w.alice, { q: '"%"' }))).toEqual([]);
    expect(titles(await query(w.alice, { q: "INVOICE" }))).toEqual(["Send invoice"]);
    expect(titles(await query(w.alice, { q: '-"e"' }))).toEqual(["Plan trip"]);

    relate(w.cards.groceries.id, w.cards.paint.id, "relates");
    // A relation to a card Alice cannot read still counts (restricted); one to a readable binned card does not.
    relate(w.cards.invoice.id, w.cards.secret.id, "relates");
    relate(w.cards.review.id, w.cards.taxes.id, "relates");
    expect((await call(w.alice, "DELETE", `/cards/${w.cards.taxes.id}`)).status).toBe(200);
    expect(titles(await query(w.alice, { q: "has:relation" }))).toEqual(["Groceries", "Paint fence", "Send invoice"]);
    expect(titles(await query(w.alice, { q: "-has:relation" }))).toEqual(["Plan trip", "Review PR"]);

    // Blockers: open, readable, live, and not done.
    relate(w.cards.paint.id, w.cards.plan.id, "blocks");
    relate(w.cards.secret.id, w.cards.review.id, "blocks");
    expect(titles(await query(w.alice, { q: "has:blocked" }))).toEqual(["Plan trip"]);
    const done = w.home.columns[2];
    expect((await call(w.alice, "POST", `/cards/${w.cards.paint.id}/move`, { columnId: done.id, afterCardId: null })).status).toBe(200);
    expect(titles(await query(w.alice, { q: "has:blocked" }))).toEqual([]);
  });
});

describe("POST /api/tasks/query: paging, sorting, grouping, limits", () => {
  test("keyset pages cover every card once in every sort, stable under inserts", async () => {
    const owner = await createUser("Pager");
    const target = await board(owner, "Pager board");
    const other = await board(owner, "Another board");
    const today = dateInZone(new Date(), "UTC");
    for (let index = 0; index < 13; index += 1) {
      const created = await card(owner, index % 2 ? target : other, `Card ${String(index).padStart(2, "0")}`, index % 3);
      if (index % 4) setDue(created.id, addDays(today, index % 5), index % 3 ? "09:30" : null, index % 3 ? "UTC" : null);
    }
    for (const sort of ["due", "updated", "created", "title", "board"]) {
      for (const group of ["none", "board", "state", "due"]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await query(owner, { q: "", sort, group, limit: 4, ...(cursor ? { cursor } : {}) });
          expect(page.status).toBe(200);
          if (pages === 0) expect(page.body.total).toBeGreaterThanOrEqual(13);
          else expect(page.body.total).toBeUndefined();
          seen.push(...(page.body.cards as Card[]).map((item) => item.id));
          cursor = page.body.nextCursor ?? undefined;
          pages += 1;
          resetTaskQueryRateLimit();
          // An insert between pages never duplicates or skips existing cards.
          if (pages === 1 && sort === "title" && group === "none") await card(owner, target, "Card 00a");
        } while (cursor && pages < 10);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.length).toBeGreaterThanOrEqual(13);
      }
    }
    const byTitle = await query(owner, { q: "", sort: "title", limit: 100 });
    expect(mine(byTitle).map((item) => item.title).slice(0, 3)).toEqual(["Card 00", "Card 00a", "Card 01"]);
    const byState = mine(await query(owner, { q: "", group: "state", limit: 100 }));
    const states = byState.map((item) => item.column_state);
    expect(states).toEqual([...states].sort((a, b) => ["todo", "doing", "done"].indexOf(a) - ["todo", "doing", "done"].indexOf(b)));
    const byDue = mine(await query(owner, { q: "", sort: "due", limit: 100 })) as Array<Card & { due_on: string | null }>;
    const dated = byDue.map((item) => item.due_on);
    expect(dated.indexOf(null)).toBeGreaterThan(0);
    expect(dated.slice(dated.indexOf(null)).every((value) => value === null)).toBe(true);
  });

  test("a cursor only continues its own query", async () => {
    const owner = await createUser("Cursor");
    const target = await board(owner, "Cursor board");
    for (let index = 0; index < 3; index += 1) await card(owner, target, `C${index}`);
    const first = await query(owner, { q: "", sort: "title", limit: 1 });
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTruthy();
    expect((await query(owner, { q: "", sort: "title", limit: 1, cursor })).status).toBe(200);
    expect(await query(owner, { q: "", sort: "updated", limit: 1, cursor })).toMatchObject({ status: 400, body: { code: "CURSOR_INVALID" } });
    expect(await query(owner, { q: "state:todo", sort: "title", limit: 1, cursor })).toMatchObject({ status: 400, body: { code: "CURSOR_INVALID" } });
    expect(await query(owner, { q: "", sort: "title", cursor: "not a cursor" })).toMatchObject({ status: 400 });
    expect(await query(owner, { q: "", sort: "title", cursor: Buffer.from("[1,\"x\",1]").toString("base64url") })).toMatchObject({ status: 400, body: { code: "CURSOR_INVALID" } });
  });

  test("a cursor is signed and bound to its user: another user's or a tampered one is CURSOR_INVALID", async () => {
    const owner = await createUser("Signed cursor");
    const other = await createUser("Signed cursor other");
    const target = await board(owner, "Signed cursor board");
    for (let index = 0; index < 3; index += 1) await card(owner, target, `S${index}`);
    await card(other, await board(other, "Signed cursor other board"), "Other card");
    const cursor = (await query(owner, { q: "", sort: "title", limit: 1 })).body.nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect((await query(owner, { q: "", sort: "title", limit: 1, cursor })).status).toBe(200);
    // The same question from another user: the key matches, the MAC does not.
    expect(await query(other, { q: "", sort: "title", limit: 1, cursor })).toMatchObject({ status: 400, body: { code: "CURSOR_INVALID" } });
    // Swap the card id (the last sort value) and keep the MAC.
    const [payload, mac] = cursor.split(".") as [string, string];
    const values = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown[];
    values[values.length - 1] = crypto.randomUUID();
    const tampered = `${Buffer.from(JSON.stringify(values)).toString("base64url")}.${mac}`;
    expect(await query(owner, { q: "", sort: "title", limit: 1, cursor: tampered })).toMatchObject({ status: 400, body: { code: "CURSOR_INVALID" } });
    // An unsigned cursor in the old format is refused too.
    expect(await query(owner, { q: "", sort: "title", limit: 1, cursor: payload })).toMatchObject({ status: 400, body: { code: "CURSOR_INVALID" } });
  });

  test("30 queries per 10 seconds per user, then 429 with Retry-After", async () => {
    const user = await createUser("Limiter");
    const other = await createUser("Limiter other");
    for (let index = 0; index < TASK_QUERY_RATE_LIMIT; index += 1) expect((await query(user, { q: "" })).status).toBe(200);
    const limited = await query(user, { q: "" });
    expect(limited).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await query(other, { q: "" })).status).toBe(200);
  });

  test("needs a session and CSRF", async () => {
    const user = await createUser("Csrf");
    expect((await request("/tasks/query", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await request("/tasks/query", { method: "POST", body: "{}", headers: { "X-CSRF-Token": "wrong" } }, user)).status).toBe(403);
  });
});

describe("user refs for read-only roles (review L1)", () => {
  beforeEach(() => resetTaskQueryRateLimit());
  const setRole = (session: Session, role: string) => db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  const userRef = (result: { body: Record<string, any> }, id: string) => (result.body.refs.users as Array<{ id: string }>).find((ref) => ref.id === id);

  test("viewers and guests resolve only themselves, card people on the page, and readers of their boards", async () => {
    const owner = await createUser("Refs owner");
    const colleague = await createUser("Refs colleague");
    const stranger = await createUser("Refs stranger");
    const hiddenGuest = await createUser("Refs hidden guest");
    const viewer = await createUser("Refs viewer");
    const guest = await createUser("Refs guest");
    setRole(viewer, "viewer");
    setRole(guest, "guest");
    setRole(hiddenGuest, "guest");
    const shared = await board(owner, "Refs shared");
    expect((await call(owner, "PUT", `/boards/${shared.id}/sharing`, { visibility: "selected", userIds: [viewer.userId, guest.userId, colleague.userId] })).status).toBe(200);
    await card(owner, shared, "Refs card", 0, { assigneeIds: [guest.userId] });

    // A member still resolves anyone, as GET /api/users would.
    expect(userRef(await query(owner, { q: `creator:${stranger.userId}` }), stranger.userId)).toEqual({ id: stranger.userId, display_name: "Refs stranger" });

    // A guest: self, the board's owner and readers resolve; a stranger does not.
    for (const [target, name] of [[guest, "Refs guest"], [owner, "Refs owner"], [colleague, "Refs colleague"]] as const) {
      expect(userRef(await query(guest, { q: `assignee:me creator:${target.userId}` }), target.userId)).toEqual({ id: target.userId, display_name: name });
    }
    expect(userRef(await query(guest, { q: `assignee:me creator:${stranger.userId}` }), stranger.userId)).toEqual({ id: stranger.userId, unknown: true });

    // A viewer: the same rule. A guest on no board the viewer reads stays unknown.
    expect(userRef(await query(viewer, { q: `creator:${owner.userId}` }), owner.userId)).toEqual({ id: owner.userId, display_name: "Refs owner" });
    expect(userRef(await query(viewer, { q: `creator:${hiddenGuest.userId}` }), hiddenGuest.userId)).toEqual({ id: hiddenGuest.userId, unknown: true });
  });

  test("a person on a card of the page resolves for a guest although they no longer read the board", async () => {
    const owner = await createUser("Refs page owner");
    const former = await createUser("Refs former reader");
    const guest = await createUser("Refs page guest");
    setRole(guest, "guest");
    const shared = await board(owner, "Refs page board");
    expect((await call(owner, "PUT", `/boards/${shared.id}/sharing`, { visibility: "selected", userIds: [former.userId, guest.userId] })).status).toBe(200);
    await card(former, shared, "Made by former", 0, { assigneeIds: [guest.userId] });
    expect((await call(owner, "PUT", `/boards/${shared.id}/sharing`, { visibility: "selected", userIds: [guest.userId] })).status).toBe(200);
    const result = await query(guest, { q: `assignee:me creator:${former.userId}` });
    expect(titles(result)).toEqual(["Made by former"]);
    expect(userRef(result, former.userId)).toEqual({ id: former.userId, display_name: "Refs former reader" });
  });
});
