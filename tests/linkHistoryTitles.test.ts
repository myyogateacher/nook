import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");

/**
 * Link history names the other item per reader (D1390, T706): the payload keeps only the other
 * side's id and kind word; when a history is listed, a reader who can open the other item sees its
 * current title, and anyone else sees the kind word alone (no title, no id). Old card rows without
 * `kind` resolve too (goal_* ⇒ goal; otherwise the kind word reversed).
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
};

let owner: Session;
let member: Session;
let stranger: Session;
let cardId: string;
let hiddenCardId: string;
let secretGoalId: string;
let sharedGoalId: string;
let secretLinkId: string;

const SECRET_GOAL = "Secret acquisition goal";
const SHARED_GOAL = "Shared revenue goal";
const HIDDEN_CARD = "Hidden roadmap card";
const CARD = "Visible launch card";

beforeAll(async () => {
  owner = await createUser("History owner");
  member = await createUser("History member");
  stranger = await createUser("History stranger");
  const board = await api(owner, "POST", "/tasks/boards", { name: "Shared history board" });
  expect((await api(owner, "PUT", `/tasks/boards/${board.body.board.id}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  cardId = (await api(owner, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId: board.body.columns[0].id, title: CARD })).body.card.id;
  const privateBoard = await api(owner, "POST", "/tasks/boards", { name: "Private history board" });
  hiddenCardId = (await api(owner, "POST", `/tasks/boards/${privateBoard.body.board.id}/cards`, { columnId: privateBoard.body.columns[0].id, title: HIDDEN_CARD })).body.card.id;
  secretGoalId = (await api(owner, "POST", "/goals", { title: SECRET_GOAL, visibility: "private" })).body.goal.id;
  sharedGoalId = (await api(owner, "POST", "/goals", { title: SHARED_GOAL, visibility: "all_users" })).body.goal.id;

  const link = async (b: { kind: string; id: string }, relation = "contributes") => {
    const created = await api(owner, "POST", "/links", { a: { kind: "card", id: cardId }, b, relation });
    expect(created.status).toBe(201);
    return created.body.link.id as string;
  };
  secretLinkId = await link({ kind: "goal", id: secretGoalId });
  await link({ kind: "goal", id: sharedGoalId });
  await link({ kind: "card", id: hiddenCardId }, "relates");
  expect((await api(owner, "DELETE", `/links/${secretLinkId}`)).status).toBe(204);
});

const cardHistory = async (session: Session) => {
  const page = await api(session, "GET", `/tasks/cards/${cardId}/activity?order=asc`);
  expect(page.status).toBe(200);
  return page.body;
};
const linkEntries = (body: Json) => (body.activity as Json[]).filter((entry) => ["goal_linked", "goal_unlinked", "relation_added", "relation_removed"].includes(entry.kind));

describe("link history titles (D1390)", () => {
  test("titles are never stored; card rows store the other side's kind", () => {
    const rows = db.query("SELECT kind, payload FROM card_activity WHERE card_id = ? AND kind IN ('goal_linked', 'goal_unlinked', 'relation_added')").all(cardId) as Array<{ kind: string; payload: string }>;
    expect(rows.map((row) => JSON.parse(row.payload).item)).toEqual([
      { id: secretGoalId, label: "Goal", kind: "goal" },
      { id: sharedGoalId, label: "Goal", kind: "goal" },
      { id: hiddenCardId, label: "Card", kind: "card" },
      { id: secretGoalId, label: "Goal", kind: "goal" }
    ]);
    const stored = JSON.stringify(db.query("SELECT payload FROM item_activity WHERE item_id IN (?, ?)").all(secretGoalId, sharedGoalId));
    expect(stored).not.toContain(CARD);
    expect(JSON.stringify(rows)).not.toContain(SECRET_GOAL);
  });

  test("a card reader who can open the linked items sees their titles, linked and unlinked", async () => {
    expect(linkEntries(await cardHistory(owner)).map((entry) => [entry.kind, entry.payload.item])).toEqual([
      ["goal_linked", { id: secretGoalId, label: SECRET_GOAL, kind: "goal" }],
      ["goal_linked", { id: sharedGoalId, label: SHARED_GOAL, kind: "goal" }],
      ["relation_added", { id: hiddenCardId, label: HIDDEN_CARD, kind: "card" }],
      ["goal_unlinked", { id: secretGoalId, label: SECRET_GOAL, kind: "goal" }]
    ]);
  });

  test("a card reader who cannot open them sees the kind word only: no title, no id", async () => {
    const body = await cardHistory(member);
    expect(linkEntries(body).map((entry) => [entry.kind, entry.payload.item])).toEqual([
      ["goal_linked", { label: "Goal", kind: "goal" }],
      ["goal_linked", { id: sharedGoalId, label: SHARED_GOAL, kind: "goal" }],
      ["relation_added", { label: "Card", kind: "card" }],
      ["goal_unlinked", { label: "Goal", kind: "goal" }]
    ]);
    const json = JSON.stringify(body);
    for (const secret of [SECRET_GOAL, secretGoalId, HIDDEN_CARD, hiddenCardId]) expect(json).not.toContain(secret);
  });

  test("an item's Activity tab names the card for its readers only", async () => {
    const mine = await api(owner, "GET", `/items/goal/${secretGoalId}/activity?order=asc`);
    expect((mine.body.entries as Json[]).filter((entry) => entry.kind === "linked" || entry.kind === "unlinked").map((entry) => [entry.kind, entry.payload.item])).toEqual([
      ["linked", { id: cardId, label: CARD, kind: "card" }],
      ["unlinked", { id: cardId, label: CARD, kind: "card" }]
    ]);
    // The stranger reads the shared goal but not the card.
    const theirs = await api(stranger, "GET", `/items/goal/${sharedGoalId}/activity`);
    expect(theirs.status).toBe(200);
    expect((theirs.body.entries as Json[]).filter((entry) => entry.kind === "linked").map((entry) => entry.payload)).toEqual([{ item: { label: "Card", kind: "card" }, extra: { relation: "contributes" } }]);
    expect(JSON.stringify(theirs.body)).not.toContain(CARD);
    expect(JSON.stringify(theirs.body)).not.toContain(cardId);
    // The member reads both.
    const member_ = await api(member, "GET", `/items/goal/${sharedGoalId}/activity`);
    expect((member_.body.entries as Json[]).find((entry) => entry.kind === "linked")?.payload.item).toEqual({ id: cardId, label: CARD, kind: "card" });
  });

  test("old card rows without kind resolve (goal_* is a goal; otherwise the kind word)", async () => {
    const at = new Date().toISOString();
    const boardId = (db.query("SELECT board_id FROM cards WHERE id = ?").get(cardId) as { board_id: string }).board_id;
    const insert = db.query("INSERT INTO card_activity (id, card_id, board_id, actor_id, actor_label, via, kind, payload, created_at) VALUES (?, ?, ?, ?, '', NULL, ?, ?, ?)");
    insert.run(Bun.randomUUIDv7(), cardId, boardId, owner.userId, "goal_linked", JSON.stringify({ item: { id: sharedGoalId, label: "Goal" } }), at);
    insert.run(Bun.randomUUIDv7(), cardId, boardId, owner.userId, "relation_removed", JSON.stringify({ item: { id: hiddenCardId, label: "Card" } }), at);
    const tail = (body: Json) => linkEntries(body).slice(-2).map((entry) => [entry.kind, entry.payload.item]);
    expect(tail(await cardHistory(owner))).toEqual([
      ["goal_linked", { id: sharedGoalId, label: SHARED_GOAL, kind: "goal" }],
      ["relation_removed", { id: hiddenCardId, label: HIDDEN_CARD, kind: "card" }]
    ]);
    expect(tail(await cardHistory(member))).toEqual([
      ["goal_linked", { id: sharedGoalId, label: SHARED_GOAL, kind: "goal" }],
      ["relation_removed", { label: "Card", kind: "card" }]
    ]);
  });

  test("get_card_activity hides a linked goal's title from a key that does not reach Goals (T203)", async () => {
    const key = createApiKey(owner.userId, { name: "Tasks only", surfaces: "both", grants: [{ module: "tasks", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const result = JSON.parse((await invokeMcpToolForTests("get_card_activity", { cardId, order: "asc" }, key.id, "mcp")).content[0]!.text) as Json;
    expect(result.code).toBeUndefined();
    const items = linkEntries(result).map((entry) => entry.payload.item);
    expect(items.filter((item) => item.kind === "goal").every((item) => item.label === "Goal" && !item.id)).toBe(true);
    expect(items).toContainEqual({ id: hiddenCardId, label: HIDDEN_CARD, kind: "card" });
    expect(JSON.stringify(result)).not.toContain(SHARED_GOAL);
  });
});

describe("link history words (D1390)", () => {
  test("a resolved item reads with its kind and title; a hidden one with the kind word only", async () => {
    const { activityPlain } = await import("../src/crm/activityText");
    const { linkedItemNoun } = await import("../shared/workRefs");
    const entry = (item: Json) => ({ id: "a", kind: "linked", payload: { item }, createdAt: "2026-11-17T00:00:00Z" }) as never;
    expect(activityPlain(entry({ id: "x", label: "Q3 plan", kind: "goal" }))).toBe("linked the goal Q3 plan");
    expect(activityPlain(entry({ label: "Goal", kind: "goal" }))).toBe("linked a goal");
    expect(linkedItemNoun({ id: "x", kind: "key_result" })).toBe("the key result ");
    expect(linkedItemNoun({ kind: "card" })).toBe("");
  });
});
