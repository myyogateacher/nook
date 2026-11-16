import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";
import { foldText, queryCards, sortCards, type CardFilter, type QueryCard } from "../shared/taskQuery";
import { hydrateBoard, type BoardPayload } from "../src/tasks/tasksApi";

/**
 * The card query of D113 (WAVE_13_TASK_CARD_UX.md §5.5, §7): the pure
 * client-side pipeline in `shared/taskQuery.ts` over the board JSON, the
 * server's bound SQL in `server/tasks/cardQuery.ts`, and MCP `list_cards`
 * must give the same cards for the same filter.
 */

const { filterBoardCardIds } = await import("../server/tasks/cardQuery");
const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const card = (overrides: Partial<QueryCard> & { id: string }): QueryCard => ({
  column_id: "c1", position: 1, title: "", description_excerpt: "", due_on: null, assignees: [], tag_ids: [], flags: [],
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...overrides
});

describe("shared/taskQuery (unit)", () => {
  const columns = [{ id: "c1", position: 1024 }, { id: "c2", position: 2048 }];
  const cards = [
    card({ id: "d", column_id: "c2", position: 1, title: "Zeta", due_on: "2026-10-02", updated_at: "2026-01-03T00:00:00.000Z" }),
    card({ id: "b", column_id: "c1", position: 2, title: "émile", due_on: null }),
    card({ id: "a", column_id: "c1", position: 1, title: "Alpha", due_on: "2026-10-02", assignees: [{ id: "u1" }], tag_ids: ["t1"], flags: [], priority: "urgent" }),
    card({ id: "c", column_id: "c1", position: 2, title: "beta", due_on: "2026-09-30", description_excerpt: "Crème brûlée" })
  ];
  const ids = (list: QueryCard[]) => list.map((item) => item.id);

  test("board order is column position, card position, then id", () => {
    expect(ids(sortCards(cards, columns))).toEqual(["a", "b", "c", "d"]);
    expect(ids(sortCards(cards, columns, { key: "board", direction: "desc" }))).toEqual(["d", "c", "b", "a"]);
  });

  test("due sorts undated cards last both ways and ties break by board order; title folds accents", () => {
    expect(ids(sortCards(cards, columns, { key: "due", direction: "asc" }))).toEqual(["c", "a", "d", "b"]);
    expect(ids(sortCards(cards, columns, { key: "due", direction: "desc" }))).toEqual(["a", "d", "c", "b"]);
    expect(ids(sortCards(cards, columns, { key: "title", direction: "asc" }))).toEqual(["a", "c", "b", "d"]);
    expect(ids(sortCards(cards, columns, { key: "updated", direction: "desc" }))).toEqual(["d", "a", "b", "c"]);
  });

  test("filters: OR within a field, AND across fields, me and none, exclusive due bounds, folded text", () => {
    const run = (filter: CardFilter) => ids(queryCards(cards, columns, filter, { userId: "U1" }));
    expect(run({})).toEqual(["a", "b", "c", "d"]);
    expect(run({ assignees: ["me"] })).toEqual(["a"]);
    expect(run({ assignees: ["none"] })).toEqual(["b", "c", "d"]);
    expect(run({ assignees: ["me", "none"] })).toEqual(["a", "b", "c", "d"]);
    expect(run({ tags: ["T1"], flags: ["urgent"] })).toEqual(["a"]);
    // Urgent is a priority now (D1310): the card has no flags, and the legacy urgent flag filter reads its priority (D1313).
    expect(run({ tags: ["t1"], flags: ["none"] })).toEqual(["a"]);
    expect(run({ priorities: ["urgent"] })).toEqual(["a"]);
    expect(run({ priorities: ["none"] })).not.toContain("a");
    expect(run({ due: { before: "2026-10-02" } })).toEqual(["c"]);
    expect(run({ due: { after: "2026-09-30" } })).toEqual(["a", "d"]);
    expect(run({ due: { none: true } })).toEqual(["b"]);
    expect(run({ due: { before: "2026-10-01", none: true } })).toEqual(["b", "c"]);
    expect(run({ text: "EMILE" })).toEqual(["b"]);
    expect(run({ text: "creme" })).toEqual(["c"]);
    expect(run({ text: "   " })).toEqual(["a", "b", "c", "d"]);
    expect(run({ columns: ["c2"] })).toEqual(["d"]);
    expect(foldText("Ünïcödé")).toBe("unicode");
  });
});

describe("parity: client pipeline, server SQL, and MCP list_cards (D113)", () => {
  let fixture: {
    viewer: Session; stranger: Session; boardId: string; board: { cards: QueryCard[]; columns: Array<{ id: string; position: number }> };
    users: Record<"owner" | "viewer" | "other", string>; tags: Record<"backend" | "frontend" | "cafe", string>; columns: [string, string, string]; keyId: string;
  };

  beforeAll(async () => {
    const owner = await createUser("Parity owner");
    const viewer = await createUser("Parity viewer");
    const other = await createUser("Parity other");
    const stranger = await createUser("Parity stranger");
    const created = await call(owner, "POST", "/boards", { name: "Parity board" });
    const boardId = created.body.board.id as string;
    const columns = (created.body.columns as Array<{ id: string }>).map((column) => column.id) as [string, string, string];
    expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [viewer.userId, other.userId] })).status).toBe(200);
    const tag = async (name: string) => (await call(owner, "POST", `/boards/${boardId}/tags`, { name })).body.tag.id as string;
    const tags = { backend: await tag("Backend"), frontend: await tag("Frontend"), cafe: await tag("Café") };
    const specs: Array<Record<string, unknown>> = [
      { title: "Plan the release", columnId: columns[0], assigneeIds: [viewer.userId], tagIds: [tags.backend], flags: ["urgent"], dueOn: "2026-10-01" },
      { title: "Résumé template", description: "Draft the **crème** section", columnId: columns[0], assigneeIds: [owner.userId, viewer.userId], tagIds: [tags.cafe, tags.frontend], dueOn: "2026-10-15" },
      { title: "Fix login", columnId: columns[1], assigneeIds: [other.userId], flags: ["blocked", "needs_review"], dueOn: "2026-09-30", dueTime: "17:00", dueTz: "Europe/Berlin" },
      { title: "Unassigned idea", columnId: columns[1] },
      { title: "Ship it", description: "PLAN ahead", columnId: columns[2], tagIds: [tags.backend, tags.frontend], flags: ["on_hold"], dueOn: "2026-10-10" },
      { title: "Café visit", columnId: columns[2], assigneeIds: [owner.userId], tagIds: [tags.cafe], dueOn: "2026-10-01" },
      { title: "Binned card", columnId: columns[0], assigneeIds: [viewer.userId], tagIds: [tags.backend] }
    ];
    const ids: string[] = [];
    for (const spec of specs) {
      const response = await call(owner, "POST", `/boards/${boardId}/cards`, spec);
      expect(response.status).toBe(201);
      ids.push(response.body.card.id);
    }
    expect((await call(owner, "DELETE", `/cards/${ids.at(-1)}`)).status).toBe(200);
    const board = hydrateBoard((await call(viewer, "GET", `/boards/${boardId}`)).body as BoardPayload) as unknown as { cards: QueryCard[]; columns: Array<{ id: string; position: number }> };
    expect(board.cards).toHaveLength(6);
    fixture = {
      viewer, stranger, boardId, board, tags, columns,
      users: { owner: owner.userId, viewer: viewer.userId, other: other.userId },
      keyId: createMcpApiKey(viewer.userId, "Parity agent", ["tasks:read"]).id
    };
  });

  const filters = (): Array<{ name: string; filter: CardFilter; args: Record<string, unknown>; expected?: number }> => {
    const { users, tags, columns } = fixture;
    return [
      { name: "everything", filter: {}, args: {}, expected: 6 },
      { name: "me", filter: { assignees: ["me"] }, args: { assigneeIds: ["me"] }, expected: 2 },
      { name: "none assigned", filter: { assignees: ["none"] }, args: { assigneeIds: ["none"] }, expected: 2 },
      { name: "owner or other", filter: { assignees: [users.owner, users.other] }, args: { assigneeIds: [users.owner, users.other] }, expected: 3 },
      { name: "other or none", filter: { assignees: [users.other, "none"] }, args: { assigneeIds: [users.other, "none"] }, expected: 3 },
      { name: "backend", filter: { tags: [tags.backend] }, args: { tags: ["backend"] }, expected: 2 },
      { name: "frontend or café", filter: { tags: [tags.frontend, tags.cafe] }, args: { tags: ["Frontend", tags.cafe] }, expected: 3 },
      { name: "untagged", filter: { tags: ["none"] }, args: { tags: ["none"] }, expected: 2 },
      { name: "an id no card has", filter: { tags: [crypto.randomUUID()] }, args: null as never, expected: 0 },
      { name: "urgent", filter: { flags: ["urgent"] }, args: { flags: ["urgent"] }, expected: 1 },
      { name: "blocked or on hold", filter: { flags: ["blocked", "on_hold"] }, args: { flags: ["blocked", "on_hold"] }, expected: 2 },
      { name: "unflagged", filter: { flags: ["none"] }, args: { flags: ["none"] }, expected: 4 }, // The Urgent card is a priority now, not a flag (D1310).
      { name: "due before", filter: { due: { before: "2026-10-01" } }, args: { dueBefore: "2026-10-01" }, expected: 1 },
      { name: "due after", filter: { due: { after: "2026-10-01" } }, args: { dueAfter: "2026-10-01" }, expected: 2 },
      { name: "due range", filter: { due: { after: "2026-09-30", before: "2026-10-15" } }, args: { dueAfter: "2026-09-30", dueBefore: "2026-10-15" }, expected: 3 },
      { name: "no due date", filter: { due: { none: true } }, args: { dueNone: true }, expected: 1 },
      { name: "due before or none", filter: { due: { before: "2026-10-02", none: true } }, args: { dueBefore: "2026-10-02", dueNone: true }, expected: 4 },
      { name: "column", filter: { columns: [columns[1]] }, args: { columnId: columns[1] }, expected: 2 },
      { name: "text in title, case-folded", filter: { text: "PLAN" }, args: { text: "PLAN" }, expected: 2 },
      { name: "text accent-folded in the excerpt", filter: { text: "creme" }, args: { text: "creme" }, expected: 1 },
      { name: "text accent-folded in the title", filter: { text: "resume" }, args: { text: "resume" }, expected: 1 },
      { name: "text with LIKE wildcards", filter: { text: "%" }, args: { text: "%" }, expected: 0 },
      { name: "me and backend", filter: { assignees: ["me"], tags: [tags.backend] }, args: { assigneeIds: ["me"], tags: ["Backend"] }, expected: 1 },
      { name: "flags and due", filter: { flags: ["urgent", "blocked"], due: { before: "2026-10-05" } }, args: { flags: ["urgent", "blocked"], dueBefore: "2026-10-05" }, expected: 2 },
      { name: "column and text", filter: { columns: [columns[2]], text: "café" }, args: { columnId: columns[2], text: "café" }, expected: 1 },
      { name: "nothing matches", filter: { assignees: ["none"], flags: ["urgent"] }, args: { assigneeIds: ["none"], flags: ["urgent"] }, expected: 0 }
    ];
  };

  test("the server SQL returns exactly the client pipeline's cards, in board order", () => {
    const context = { userId: fixture.users.viewer };
    for (const { name, filter, expected } of filters()) {
      const client = queryCards(fixture.board.cards, fixture.board.columns, filter, context).map((item) => item.id);
      const server = filterBoardCardIds(fixture.boardId, filter, context);
      expect({ name, ids: server }).toEqual({ name, ids: client });
      if (expected !== undefined) expect({ name, count: client.length }).toEqual({ name, count: expected });
    }
    // The readable predicate: a stranger's filter finds nothing, even with every card matching.
    expect(filterBoardCardIds(fixture.boardId, {}, { userId: fixture.stranger.userId })).toEqual([]);
  });

  test("MCP list_cards returns the same cards as the client pipeline", async () => {
    const context = { userId: fixture.users.viewer };
    for (const { name, filter, args } of filters()) {
      if (args === null) continue;
      resetMcpLimits();
      const result = await invokeMcpToolForTests("list_cards", { boardId: fixture.boardId, ...args }, fixture.keyId);
      const body = JSON.parse(result.content[0]!.text) as { cards?: Array<{ id: string }>; code?: string };
      expect({ name, error: body.code }).toEqual({ name, error: undefined });
      const client = queryCards(fixture.board.cards, fixture.board.columns, filter, context).map((item) => item.id).sort();
      expect({ name, ids: body.cards!.map((item) => item.id).sort() }).toEqual({ name, ids: client });
    }
  });
});
