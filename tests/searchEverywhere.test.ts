import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetSearchRateLimit } = await import("../server/searchRoutes");
const { notePath } = await import("../server/friendlyPaths");

/**
 * Search everywhere (docs/plan/SEARCH_EVERYWHERE.md, D1341–D1343, T680–T682): `scope=all` adds cards,
 * events, the caller's own chats, and collections by name; every built-in hit carries
 * `ref: { kind, id, title, href }`; each scope keeps its list endpoint's read check, so a member sees
 * only what they can open and a guest never sees an everyone-shared item, a report, or a chat.
 */

beforeEach(() => resetSearchRateLimit());

let owner: Session;
let member: Session;
let guest: Session;
const tag = `zq${crypto.randomUUID().slice(0, 6)}`;
const ids: Record<string, string> = {};

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

type Section = { scope: string; label: string; results: Array<Record<string, any>>; truncated: boolean };
async function all(session: Session, q: string) {
  const response = await api(session, "GET", `/search?scope=all&q=${encodeURIComponent(q)}`);
  expect(response.status).toBe(200);
  return response.body.sections as Section[];
}
const section = (sections: Section[], scope: string) => sections.find((item) => item.scope === scope);
const refsOf = (sections: Section[]) => sections.flatMap((item) => item.results.map((result) => result.ref ?? null));

async function publishedNote(session: Session, title: string, shared: boolean) {
  const id = (await api(session, "POST", "/notes", {})).body.note.id as string;
  expect((await api(session, "PUT", `/notes/${id}/draft`, { markdown: `# ${title}\n\nBody of ${title}`, revision: 1 })).status).toBe(200);
  expect((await api(session, "POST", `/notes/${id}/publish`, {})).status).toBe(200);
  if (shared) db.query("UPDATE notes SET visibility = 'all_users', sharing_override = 1 WHERE id = ?").run(id);
  return id;
}

beforeAll(async () => {
  owner = await createUser("Search owner");
  member = await createUser("Search member");
  guest = await createUser("Search guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);

  ids.sharedNote = await publishedNote(owner, `${tag} shared plan`, true);
  ids.privateNote = await publishedNote(owner, `${tag} private plan`, false);

  const board = await api(owner, "POST", "/tasks/boards", { name: `${tag} board` });
  ids.board = board.body.board.id;
  const column = board.body.columns[0].id as string;
  ids.card = (await api(owner, "POST", `/tasks/boards/${ids.board}/cards`, { columnId: column, title: `${tag} launch card` })).body.card.id;
  db.query("UPDATE boards SET visibility = 'all_users' WHERE id = ?").run(ids.board);
  const privateBoard = await api(owner, "POST", "/tasks/boards", { name: `${tag} private board` });
  ids.privateCard = (await api(owner, "POST", `/tasks/boards/${privateBoard.body.board.id}/cards`, { columnId: privateBoard.body.columns[0].id, title: `${tag} secret card` })).body.card.id;

  const calendar = (await api(owner, "POST", "/calendars", { name: `${tag} team calendar`, color: "blue" })).body.calendar.id as string;
  ids.calendar = calendar;
  db.query("UPDATE calendars SET visibility = 'all_users' WHERE id = ?").run(calendar);
  ids.event = (await api(owner, "POST", `/calendars/${calendar}/events`, { title: `${tag} offsite`, allDay: true, startDate: "2026-12-01", endDate: "2026-12-02" })).body.event.id;
  const privateCalendar = (await api(owner, "POST", "/calendars", { name: "Private", color: "red" })).body.calendar.id as string;
  ids.privateEvent = (await api(owner, "POST", `/calendars/${privateCalendar}/events`, { title: `${tag} dentist`, allDay: true, startDate: "2026-12-03", endDate: "2026-12-04" })).body.event.id;

  ids.collection = (await api(owner, "POST", "/collections", { name: `${tag} roadmap` })).body.collection.id;

  const at = new Date().toISOString();
  for (const [key, session] of [["ownerChat", owner], ["memberChat", member]] as const) {
    const id = crypto.randomUUID();
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)").run(id, session.userId, `${tag} chat of ${key}`, at, at);
    db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES (?, ?, ?, '')").run(id, session.userId, `${tag} chat of ${key}`);
    ids[key] = id;
  }
});

// The suite shares one database: the everyone-shared items go back to private, so later files'
// fresh accounts do not see them (tests/calendarApi.test.ts expects only its own Personal calendar).
afterAll(() => {
  db.query("UPDATE calendars SET visibility = 'private' WHERE id = ?").run(ids.calendar);
  db.query("UPDATE boards SET visibility = 'private' WHERE id = ?").run(ids.board);
  db.query("UPDATE notes SET visibility = 'private' WHERE id = ?").run(ids.sharedNote);
});

describe("scope=all across apps (D1341)", () => {
  test("the owner finds notes, cards, events, collections, and their own chat, each with a uniform ref", async () => {
    const sections = await all(owner, tag);
    expect(sections.map((item) => item.scope)).toEqual(expect.arrayContaining(["notes", "cards", "events", "files", "whiteboards", "collections", "reports", "chats"]));
    expect(section(sections, "cards")).toMatchObject({ label: "Tasks" });
    const refs = refsOf(sections);
    for (const ref of refs) {
      expect(ref).toEqual({ kind: expect.any(String), id: expect.any(String), title: expect.any(String), href: expect.stringMatching(/^\//) });
    }
    const byId = new Map(refs.map((ref) => [ref.id, ref]));
    expect(byId.get(ids.sharedNote)).toMatchObject({ kind: "note", title: `${tag} shared plan` });
    expect(byId.get(ids.card)).toMatchObject({ kind: "card", title: `${tag} launch card`, href: expect.stringMatching(/^\/tasks\//) });
    expect(byId.get(ids.event)).toEqual({ kind: "event", id: ids.event, title: `${tag} offsite`, href: `/calendar/event/${ids.event}` });
    expect(byId.get(ids.collection)).toMatchObject({ kind: "collection", title: `${tag} roadmap`, href: expect.stringMatching(/^\/collections\//) });
    expect(byId.get(ids.ownerChat)).toEqual({ kind: "chat", id: ids.ownerChat, title: `${tag} chat of ownerChat`, href: `/chat/${ids.ownerChat}` });
    // Another person's chat is never found, even by its exact title.
    expect(byId.has(ids.memberChat)).toBe(false);
    // Built-in hits keep their own fields beside the ref (additive).
    expect(section(sections, "notes")!.results[0]).toEqual(expect.objectContaining({ title: expect.any(Array), snippet: expect.any(Array), is_owner: 1 }));
  });

  test("a member sees only what they can open: shared items, never private ones or the owner's chat", async () => {
    const refs = refsOf(await all(member, tag));
    const found = new Set(refs.map((ref) => ref.id));
    expect(found.has(ids.sharedNote)).toBe(true);
    expect(found.has(ids.card)).toBe(true);
    expect(found.has(ids.event)).toBe(true);
    expect(found.has(ids.memberChat)).toBe(true);
    for (const hidden of [ids.privateNote, ids.privateCard, ids.privateEvent, ids.collection, ids.ownerChat]) expect(found.has(hidden)).toBe(false);
    expect(JSON.stringify(refs)).not.toContain("secret card");
    expect(JSON.stringify(refs)).not.toContain("dentist");
  });

  test("a guest gets no everyone-shared items, no Reports section, and no Chat section", async () => {
    const sections = await all(guest, tag);
    expect(sections.map((item) => item.scope)).not.toContain("reports");
    expect(sections.map((item) => item.scope)).not.toContain("chats");
    expect(refsOf(sections)).toEqual([]);
    expect((await api(guest, "GET", `/search?scope=chats&q=${tag}`)).body).toEqual({ results: [], truncated: false });
  });

  test("single scopes: cards, events, and chats run on their own with the same checks; refs are added to the old scopes", async () => {
    const cards = await api(member, "GET", `/search?scope=cards&q=${tag}`);
    expect(cards.body.results.map((hit: { id: string }) => hit.id)).toEqual([ids.card]);
    expect(cards.body.results[0]).toMatchObject({ board_name: `${tag} board`, kind: "card", ref: { kind: "card", id: ids.card } });
    const events = await api(member, "GET", `/search?scope=events&q=${tag}`);
    expect(events.body.results.map((hit: { id: string }) => hit.id)).toEqual([ids.event]);
    expect(events.body.results[0]).toMatchObject({ calendarName: `${tag} team calendar`, allDay: true, start: "2026-12-01", recurring: false });
    const chats = await api(owner, "GET", `/search?scope=chats&q=${tag}`);
    expect(chats.body.results.map((hit: { id: string }) => hit.id)).toEqual([ids.ownerChat]);
    const notes = await api(owner, "GET", `/search?scope=notes&q=${tag}`);
    expect(notes.body.results.every((hit: { ref?: { kind: string } }) => hit.ref?.kind === "note")).toBe(true);
    expect((await api(owner, "GET", `/search?scope=collections&q=${tag}`)).body).toMatchObject({ results: [], truncated: false });
    expect((await api(owner, "GET", "/search?scope=bogus&q=x")).status).toBe(400);
  });

  test("a card key finds its card; `%` and `_` are literal in title matches", async () => {
    db.query("UPDATE boards SET code = 'ZQS' WHERE id = ?").run(ids.board);
    db.query("UPDATE cards SET number = 7 WHERE id = ?").run(ids.card);
    const byKey = await api(member, "GET", "/search?scope=cards&q=ZQS-7");
    expect(byKey.body.results[0]).toMatchObject({ id: ids.card, key: "ZQS-7", href: "/tasks/ZQS-7" });
    expect((await api(owner, "GET", "/search?scope=events&q=%25")).body.results).toEqual([]);
  });
});

describe("note links never slug a draft title (D1343, T680)", () => {
  test("notePath uses the published title while the owner has a newer draft", async () => {
    const before = notePath(ids.sharedNote);
    expect(before).toContain(`${tag}-shared-plan`);
    const saved = await api(owner, "PUT", `/notes/${ids.sharedNote}/draft`, { markdown: "# Reorg layoffs draft\n\nNot yet", revision: null });
    expect(saved.status).toBe(200);
    expect(db.query("SELECT title FROM notes WHERE id = ?").get(ids.sharedNote)).toEqual({ title: "Reorg layoffs draft" });
    expect(notePath(ids.sharedNote)).toBe(before);
    const refs = refsOf(await all(member, tag));
    expect(JSON.stringify(refs)).not.toContain("layoffs");
  });
});
