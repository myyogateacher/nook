import { afterAll, describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";

const { queryCards, QUERY_PAGE } = await import("../server/tasks/query");
const { dateInZone, addDays } = await import("../server/today/registry");

/**
 * Query bounds on a fixture (research 2026-09-26 §10.4, §11.2, T117).
 *
 * The default fixture is 20 boards × 500 cards (10 000 live cards) readable by
 * one user, plus 2 000 cards on boards they cannot read. Set
 * `MYNOTES_QUERY_PERF=large` for the plan's 10 users × 50 boards × 1000 cards
 * (all readable by the queried user through `all_users`), run by hand.
 */

const large = process.env.MYNOTES_QUERY_PERF === "large";
const BOARDS = large ? 500 : 20;
const CARDS_PER_BOARD = large ? 1000 : 500;
/**
 * The budget holds for the median of RUNS timed runs after WARMUP untimed ones (C9). The p95 of 20
 * runs is nearly the slowest run, so one scheduler hiccup on a busy machine failed the suite; the
 * median still catches a query that got slower, and both numbers are printed.
 */
const BUDGET_MS = 150;
const WARMUP = large ? 1 : 3;
const RUNS = large ? 5 : 15;
/** Per-test timeout: the large fixture takes seconds per query. */
const TIMEOUT_MS = large ? 300_000 : 5_000;

const owner = await createUser("Perf owner");
const stranger = await createUser("Perf stranger");
const boardIds: string[] = [];
const today = dateInZone(new Date(), "UTC");
const stamp = new Date().toISOString();

function seed() {
  const insertBoard = db.query("INSERT INTO boards (id, owner_id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insertColumn = db.query("INSERT INTO board_columns (id, board_id, name, position, is_done, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertCard = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, description_excerpt, due_on, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertAssignee = db.query("INSERT INTO card_assignees (card_id, user_id, created_at) VALUES (?, ?, ?)");
  const insertTag = db.query("INSERT INTO board_tags (id, board_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const insertCardTag = db.query("INSERT INTO card_tags (card_id, tag_id, created_at) VALUES (?, ?, ?)");
  const insertFlag = db.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    const addBoard = (boardOwner: string, index: number, visibility: string, cards: number) => {
      const boardId = crypto.randomUUID();
      boardIds.push(boardId);
      insertBoard.run(boardId, boardOwner, `Perf board ${index}`, visibility, stamp, stamp);
      const columns = [0, 1, 2].map((column) => {
        const id = crypto.randomUUID();
        insertColumn.run(id, boardId, ["To do", "Doing", "Done"][column]!, (column + 1) * 1024, column === 2 ? 1 : 0, ["todo", "doing", "done"][column]!, stamp, stamp);
        return id;
      });
      const tagId = crypto.randomUUID();
      insertTag.run(tagId, boardId, "Backend", stamp, stamp);
      for (let card = 0; card < cards; card += 1) {
        const id = crypto.randomUUID();
        const due = card % 3 === 0 ? null : addDays(today, (card % 40) - 10);
        insertCard.run(id, boardId, columns[card % 3]!, card * 1024, `Task ${index}-${card} ${card % 50 === 0 ? "invoice" : "chore"}`, "", due, boardOwner, stamp, stamp);
        if (card % 4 === 0) insertAssignee.run(id, boardOwner === owner.userId ? owner.userId : stranger.userId, stamp);
        if (card % 7 === 0) insertCardTag.run(id, tagId, stamp);
        if (card % 11 === 0) insertFlag.run(id, "urgent", stamp);
      }
    };
    for (let index = 0; index < BOARDS; index += 1) addBoard(large && index % 50 ? stranger.userId : owner.userId, index, large ? "all_users" : "private", CARDS_PER_BOARD);
    if (!large) for (let index = 0; index < 4; index += 1) addBoard(stranger.userId, 1000 + index, "private", 500);
  })();
}

const seedStart = performance.now();
seed();
const seedMs = performance.now() - seedStart;

afterAll(() => {
  // Deleting boards cascades to columns, cards, and their join rows.
  db.transaction(() => {
    for (const boardId of boardIds) db.query("DELETE FROM boards WHERE id = ?").run(boardId);
  })();
}, TIMEOUT_MS);

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Median and p95 of RUNS timed runs of `run`, after WARMUP untimed ones. */
function timeRuns(run: () => unknown, runs = RUNS, warmup = WARMUP) {
  for (let index = 0; index < warmup; index += 1) run();
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
  return { median, p95: times[Math.ceil(times.length * 0.95) - 1]! };
}

describe(`task query bounds on ${BOARDS} boards × ${CARDS_PER_BOARD} cards`, () => {
  const cases: Array<[string, Parameters<typeof queryCards>[1]]> = [
    ["My work (assignee:me state:todo,doing, sort due)", { q: "assignee:me state:todo,doing", sort: "due", tz: "UTC" }],
    ["everything, sort updated, 100 per page", { q: "", sort: "updated", limit: QUERY_PAGE.max, tz: "UTC" }],
    ["text + tag name + overdue, grouped by board", { q: "\"invoice\" tag:backend due:overdue,week", sort: "title", group: "board", tz: "UTC" }],
    ["negated flag, grouped by due bucket", { q: "-flag:urgent -state:done", sort: "board", group: "due", tz: "UTC" }]
  ];
  const measured: Record<string, { median: number; p95: number }> = {};

  for (const [name, input] of cases) {
    test(name, () => {
      const result = queryCards(owner.userId, input);
      expect(result.cards.length).toBeLessThanOrEqual(input.limit ?? QUERY_PAGE.default);
      expect(result.cards.every((card) => boardIds.includes(card.board_id))).toBe(true);
      // Nothing from the stranger's private boards.
      if (!large) expect(result.cards.every((card) => card.title.startsWith("Task ") && Number(card.title.split(" ")[1]!.split("-")[0]) < 1000)).toBe(true);
      const timing = timeRuns(() => queryCards(owner.userId, input));
      measured[name] = { median: round(timing.median), p95: round(timing.p95) };
      console.info(`task query "${name}": median ${round(timing.median)} ms, p95 ${round(timing.p95)} ms (budget ${BUDGET_MS} ms on the median)`);
      if (!large) expect(timing.median).toBeLessThan(BUDGET_MS);
    }, TIMEOUT_MS);
  }

  test("the second page costs about the same as the first", () => {
    const input = { q: "state:todo,doing", sort: "created" as const, limit: 100, tz: "UTC" };
    const first = queryCards(owner.userId, input);
    expect(first.nextCursor).toBeTruthy();
    const timing = timeRuns(() => queryCards(owner.userId, { ...input, cursor: first.nextCursor! }));
    measured["second page"] = { median: round(timing.median), p95: round(timing.p95) };
    if (!large) expect(timing.median).toBeLessThan(BUDGET_MS);
    console.info(`task query timings (ms), ${BOARDS}×${CARDS_PER_BOARD}, seeded in ${Math.round(seedMs)} ms:`, JSON.stringify(measured));
  }, TIMEOUT_MS);

  test("the timing helper takes the median after a warm-up", () => {
    let call = 0;
    // The warm-up call is the slow one here; it is not timed.
    const spin = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* busy */ } };
    const timing = timeRuns(() => { call += 1; spin(call === 1 ? 30 : 1); }, 5, 1);
    expect(call).toBe(6);
    expect(timing.median).toBeLessThan(15);
    expect(timing.p95).toBeGreaterThanOrEqual(timing.median);
  }, TIMEOUT_MS);
});
