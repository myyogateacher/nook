import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { mentionMarkdown, MENTION_NOTIFY_MAX } = await import("../shared/itemActivity");
const { notifyMentions } = await import("../server/activity/mentions");

/**
 * @mentions (docs/plan/MENTIONS.md, D1323–D1334, T660–T664): who the picker offers, who is notified
 * from card comments, card descriptions, and item comments, the card history, the Mentions view, and MCP.
 */

let owner: Session;
let reader: Session;
let outsider: Session;
let guest: Session;
let boardId: string;
let columnId: string;
let cardId: string;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined && method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }, session);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, any> };
};

const mentionRows = (userId: string) => db.query("SELECT title, href, module, item_kind, item_id, read_at FROM notifications WHERE user_id = ? AND topic = 'core.mention' ORDER BY created_at")
  .all(userId) as Array<{ title: string; href: string; module: string; item_kind: string; item_id: string; read_at: string | null }>;
const clearMentions = () => db.query("DELETE FROM notifications WHERE topic = 'core.mention'").run();
const card = async () => {
  const created = await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: `Card ${crypto.randomUUID().slice(0, 6)}` });
  expect(created.status).toBe(201);
  return created.body.card as { id: string; revision: number };
};

beforeAll(async () => {
  owner = await createUser("Mention Owner");
  reader = await createUser("Mention Reader");
  outsider = await createUser("Mention Outsider");
  guest = await createUser("Mention Guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  const board = await api(owner, "POST", "/tasks/boards", { name: "Mentions board" });
  boardId = board.body.board.id;
  columnId = board.body.columns[0].id;
  expect((await api(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [reader.userId, guest.userId] })).status).toBe(200);
  cardId = (await card()).id;
});

describe("GET /api/people/mentionable (D1323, T660, T661)", () => {
  test("readers first; members see non-readers marked canRead false; never the caller; no emails", async () => {
    const found = await api(owner, "GET", `/people/mentionable?kind=card&id=${cardId}&q=mention&limit=20`);
    expect(found.status).toBe(200);
    const people = found.body.people as Array<{ id: string; displayName: string; canRead: boolean; avatarUrl: string | null }>;
    expect(people.map((person) => person.id)).not.toContain(owner.userId);
    const readerRow = people.find((person) => person.id === reader.userId)!;
    const outsiderRow = people.find((person) => person.id === outsider.userId)!;
    expect(readerRow).toMatchObject({ displayName: "Mention Reader", canRead: true });
    expect(outsiderRow).toMatchObject({ displayName: "Mention Outsider", canRead: false });
    expect(people.indexOf(readerRow)).toBeLessThan(people.indexOf(outsiderRow));
    expect(JSON.stringify(people)).not.toContain("@");
    // The query filters by name.
    const filtered = (await api(owner, "GET", `/people/mentionable?kind=card&id=${cardId}&q=reader`)).body.people as Array<{ id: string }>;
    expect(filtered.map((person) => person.id)).toEqual([reader.userId]);
  });

  test("a guest gets readers only; someone who cannot read the item gets 404; bad input is refused", async () => {
    const asGuest = (await api(guest, "GET", `/people/mentionable?kind=card&id=${cardId}&q=mention`)).body.people as Array<{ id: string; canRead: boolean }>;
    expect(asGuest.every((person) => person.canRead)).toBe(true);
    expect(asGuest.map((person) => person.id)).toEqual(expect.arrayContaining([owner.userId, reader.userId]));
    expect(asGuest.map((person) => person.id)).not.toContain(outsider.userId);
    expect((await api(outsider, "GET", `/people/mentionable?kind=card&id=${cardId}`)).status).toBe(404);
    expect((await api(owner, "GET", `/people/mentionable?kind=nope&id=${cardId}`)).status).toBe(404);
    expect((await api(owner, "GET", `/people/mentionable?kind=card&id=${cardId}&limit=99`)).status).toBe(400);
    expect((await api(owner, "GET", `/people/mentionable?kind=card&id=${cardId}&q=${"x".repeat(41)}`)).status).toBe(400);
  });
});

describe("card comments (D1325–D1327, D1332, T662)", () => {
  test("only readers are notified, never the author; the card records who was mentioned", async () => {
    clearMentions();
    const body = `Hi ${mentionMarkdown("Mention Reader", reader.userId)} ${mentionMarkdown("Mention Outsider", outsider.userId)} ${mentionMarkdown("Me", owner.userId)}`;
    const posted = await api(owner, "POST", `/tasks/cards/${cardId}/comments`, { body });
    expect(posted.status).toBe(201);
    expect(mentionRows(reader.userId)).toEqual([expect.objectContaining({ title: "Mention Owner mentioned you on a card", module: "tasks", item_kind: "card", item_id: cardId })]);
    expect(mentionRows(reader.userId)[0]!.href).toMatch(/^\/tasks\//);
    expect(mentionRows(outsider.userId)).toEqual([]);
    expect(mentionRows(owner.userId)).toEqual([]);
    const activity = db.query("SELECT payload FROM card_activity WHERE card_id = ? AND kind = 'mentioned'").all(cardId) as Array<{ payload: string }>;
    expect(activity.map((row) => JSON.parse(row.payload).item)).toEqual([{ id: reader.userId, label: "Mention Reader" }]);
    // The bell shows it to the reader.
    const bell = await api(reader, "GET", "/notifications");
    expect(bell.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "module", module: "tasks", topic: "core.mention" })]));
  });

  test("an edit notifies only people it newly mentions", async () => {
    clearMentions();
    const first = await api(owner, "POST", `/tasks/cards/${cardId}/comments`, { body: `${mentionMarkdown("Mention Reader", reader.userId)} look` });
    expect(mentionRows(reader.userId)).toHaveLength(1);
    await api(reader, "POST", "/notifications/read", { all: true });
    // Same mention, new words: nothing new.
    expect((await api(owner, "PATCH", `/tasks/comments/${first.body.comment.id}`, { body: `${mentionMarkdown("Mention Reader", reader.userId)} look again` })).status).toBe(200);
    expect(mentionRows(reader.userId).filter((row) => row.read_at === null)).toEqual([]);
    // Adding the guest (a reader) notifies the guest only.
    await api(owner, "PATCH", `/tasks/comments/${first.body.comment.id}`, { body: `${mentionMarkdown("Mention Reader", reader.userId)} and ${mentionMarkdown("Mention Guest", guest.userId)}` });
    expect(mentionRows(guest.userId)).toHaveLength(1);
    expect(mentionRows(reader.userId).filter((row) => row.read_at === null)).toEqual([]);
  });

  test("someone who cannot comment cannot notify; a later reader is notified only by a new write", async () => {
    clearMentions();
    expect((await api(outsider, "POST", `/tasks/cards/${cardId}/comments`, { body: mentionMarkdown("Mention Reader", reader.userId) })).status).toBe(404);
    expect(mentionRows(reader.userId)).toEqual([]);
  });
});

describe("card descriptions (D1334)", () => {
  test("creating with a mention notifies; a save notifies only mentions it adds; unchanged saves notify no one", async () => {
    clearMentions();
    const created = await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "With description", description: `Owner: ${mentionMarkdown("Mention Reader", reader.userId)}` });
    const id = created.body.card.id as string;
    expect(mentionRows(reader.userId)).toEqual([expect.objectContaining({ title: "Mention Owner mentioned you in a card description", item_id: id })]);
    await api(reader, "POST", "/notifications/read", { all: true });
    let revision = created.body.card.revision as number;
    const save = async (description: string) => {
      const saved = await api(owner, "PATCH", `/tasks/cards/${id}`, { description, revision });
      expect(saved.status).toBe(200);
      revision = saved.body.card.revision;
    };
    await save(`Owner: ${mentionMarkdown("Mention Reader", reader.userId)} (edited)`);
    expect(mentionRows(reader.userId).filter((row) => row.read_at === null)).toEqual([]);
    await save(`Owner: ${mentionMarkdown("Mention Reader", reader.userId)}, help: ${mentionMarkdown("Mention Guest", guest.userId)}, ${mentionMarkdown("Mention Outsider", outsider.userId)}`);
    expect(mentionRows(guest.userId)).toEqual([expect.objectContaining({ title: "Mention Owner mentioned you in a card description" })]);
    expect(mentionRows(outsider.userId)).toEqual([]);
    expect(mentionRows(reader.userId).filter((row) => row.read_at === null)).toEqual([]);
  });

  test("at most MENTION_NOTIFY_MAX people per write; one unread row per person and item", () => {
    clearMentions();
    const many = Array.from({ length: MENTION_NOTIFY_MAX + 5 }, () => crypto.randomUUID());
    // Unknown ids are nobody: nothing is written for them.
    expect(db.transaction(() => notifyMentions({ kind: "card", itemId: cardId, authorId: owner.userId, text: many.map((id) => mentionMarkdown("X", id)).join(" ") }))()).toEqual([]);
    const text = mentionMarkdown("Mention Reader", reader.userId);
    db.transaction(() => notifyMentions({ kind: "card", itemId: cardId, authorId: owner.userId, text }))();
    db.transaction(() => notifyMentions({ kind: "card", itemId: cardId, authorId: outsider.userId, text }))();
    expect(mentionRows(reader.userId)).toHaveLength(1);
  });
});

describe("the Mentions view (D1333)", () => {
  test("?topic=core.mention lists mention rows only; a bad topic is refused", async () => {
    clearMentions();
    await api(owner, "POST", `/tasks/cards/${cardId}/comments`, { body: `${mentionMarkdown("Mention Reader", reader.userId)} ping` });
    const mentions = await api(reader, "GET", "/notifications?topic=core.mention");
    expect(mentions.status).toBe(200);
    expect(mentions.body.items.length).toBeGreaterThan(0);
    expect(mentions.body.items.every((item: { topic?: string }) => item.topic === "core.mention")).toBe(true);
    expect((await api(reader, "GET", "/notifications?topic=Bad%20Topic")).status).toBe(400);
  });
});

describe("MCP (D1330, D1331)", () => {
  test("find_people_to_mention gives ids, access, and the mention text; comment_on_card notifies readers", async () => {
    const key = createApiKey(owner.userId, { name: "Mentions key", surfaces: "both", grants: [{ module: "tasks", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const call = async (name: string, args: unknown) => {
      const result = await invokeMcpToolForTests(name, args, key.id);
      return { isError: result.isError ?? false, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
    };
    const found = await call("find_people_to_mention", { item: { kind: "card", id: cardId }, query: "mention" });
    expect(found.isError).toBe(false);
    const readerRow = found.value.people.find((person: { id: string }) => person.id === reader.userId);
    expect(readerRow).toEqual({ id: reader.userId, name: "Mention Reader", canRead: true, mention: mentionMarkdown("Mention Reader", reader.userId) });
    expect(found.value.people.find((person: { id: string }) => person.id === outsider.userId)).toMatchObject({ canRead: false });
    clearMentions();
    expect((await call("comment_on_card", { cardId, body: `${readerRow.mention} via MCP` })).isError).toBe(false);
    expect(mentionRows(reader.userId)).toHaveLength(1);
    // An item the person cannot read is NOT_FOUND.
    const other = await api(outsider, "POST", "/tasks/boards", { name: "Private" });
    const otherCard = await api(outsider, "POST", `/tasks/boards/${other.body.board.id}/cards`, { columnId: other.body.columns[0].id, title: "Secret" });
    const hidden = await call("find_people_to_mention", { item: { kind: "card", id: otherCard.body.card.id } });
    expect(hidden.isError).toBe(true);
  });
});
