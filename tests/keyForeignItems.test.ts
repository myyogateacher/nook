import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";
import { addRow, insertNote, newCollection } from "./support/collections";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type Grant = import("../server/keyGrants").Grant;

/**
 * Foreign items a tool presents (access plan T203, review H1): runTool checks the one resource a
 * call names, and every relation, event link, or note field a handler shows about another item is
 * checked against the key's grants too. A key without the target module's read grant, or whose
 * grant covers chosen containers the target is outside of, sees the module's restricted shape.
 */

beforeEach(() => resetMcpLimits());

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });

const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Agent", surfaces: "mcp", grants, expiresInDays: 90 }).id;

async function call(keyId: string, name: string, args: Record<string, unknown> = {}) {
  const result = await invokeMcpToolForTests(name, args, keyId);
  return { isError: result.isError === true, text: result.content[0]!.text, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const SECRETS = { boardB: "Secret board Bravo", cardB: "Secret card on Bravo", note: "Secret note Nimbus", rowY: "Secret row Yankee", collectionY: "Secret collection Yankee", calendarD: "Secret calendar Delta", eventD: "Secret event Delta" };

/** One owner's world: two boards, two collections, two calendars, a note, and links across them. */
async function world(label: string) {
  const owner = await createUser(label);
  const boardA = (await api(owner, "POST", "/tasks/boards", { name: `${label} board Alpha` })).body;
  const boardB = (await api(owner, "POST", "/tasks/boards", { name: SECRETS.boardB })).body;
  const a = { boardId: boardA.board.id as string, columnId: boardA.columns[0].id as string };
  const b = { boardId: boardB.board.id as string, columnId: boardB.columns[0].id as string };
  const cardA = (await api(owner, "POST", `/tasks/boards/${a.boardId}/cards`, { columnId: a.columnId, title: "Alpha card" })).body.card.id as string;
  const siblingA = (await api(owner, "POST", `/tasks/boards/${a.boardId}/cards`, { columnId: a.columnId, title: "Alpha sibling" })).body.card.id as string;
  const cardB = (await api(owner, "POST", `/tasks/boards/${b.boardId}/cards`, { columnId: b.columnId, title: SECRETS.cardB })).body.card.id as string;
  expect((await api(owner, "POST", `/tasks/cards/${cardA}/relations`, { type: "depends_on", cardId: cardB })).status).toBe(201);
  expect((await api(owner, "POST", `/tasks/cards/${cardA}/relations`, { type: "relates_to", cardId: siblingA })).status).toBe(201);

  const noteId = insertNote(owner.userId, SECRETS.note);
  const collectionX = await newCollection(owner, { name: `${label} collection X`, fields: [{ name: "Name", type: "text" }, { name: "Linked note", type: "note" }] });
  const collectionY = await newCollection(owner, { name: SECRETS.collectionY, fields: [{ name: "Name", type: "text" }] });
  const rowX = await addRow(owner, collectionX.id, { [collectionX.fields[0]!.id]: "Row X", [collectionX.fields[1]!.id]: noteId });
  const plainRowX = await addRow(owner, collectionX.id, { [collectionX.fields[0]!.id]: "Plain row X" });
  const rowY = await addRow(owner, collectionY.id, { [collectionY.fields[0]!.id]: SECRETS.rowY });

  const calendarC = (await api(owner, "POST", "/calendars", { name: `${label} calendar C` })).body.calendar.id as string;
  const calendarD = (await api(owner, "POST", "/calendars", { name: SECRETS.calendarD })).body.calendar.id as string;
  const eventC = (await api(owner, "POST", `/calendars/${calendarC}/events`, { title: "Event C", allDay: true, startDate: "2026-10-01", endDate: "2026-10-02" })).body.event.id as string;
  await api(owner, "POST", `/calendars/${calendarD}/events`, { title: SECRETS.eventD, allDay: true, startDate: "2026-10-01", endDate: "2026-10-02" });
  for (const [targetType, targetId] of [["card", cardB], ["collection_row", rowY.id], ["note", noteId], ["card", cardA]] as const) {
    expect((await api(owner, "POST", `/events/${eventC}/links`, { targetType, targetId })).status).toBe(201);
  }
  return { owner, a, b, cardA, siblingA, cardB, noteId, collectionX, collectionY, rowX, plainRowX, rowY, calendarC, calendarD, eventC };
}

const linkFor = (links: Array<Record<string, unknown>>, targetType: string, targetId?: string) =>
  links.filter((link) => link.targetType === targetType && (targetId === undefined || link.targetId === targetId || link.restricted === true));

describe("foreign items a key may not read (T203)", () => {
  test("(a) get_card on a chosen board: a relation to another board is restricted; one on the same board stays", async () => {
    const w = await world("Foreign relations");
    const scoped = key(w.owner, [on("tasks", "read", "board", w.a.boardId)]);
    const got = await call(scoped, "get_card", { cardId: w.cardA });
    expect(got.isError).toBe(false);
    const relations = got.value.relations as Array<Record<string, unknown>>;
    expect(relations).toContainEqual({ type: "depends_on", restricted: true });
    expect(relations).toContainEqual(expect.objectContaining({ type: "relates_to", cardId: w.siblingA, title: "Alpha sibling" }));
    for (const secret of [SECRETS.cardB, SECRETS.boardB, w.cardB]) expect(got.text).not.toContain(secret);
    // The same key over every board sees both.
    const wide = key(w.owner, [all("tasks", "read")]);
    expect((await call(wide, "get_card", { cardId: w.cardA })).value.relations).toContainEqual(expect.objectContaining({ cardId: w.cardB, title: SECRETS.cardB, boardName: SECRETS.boardB }));
  });

  test("(b) get_event on a chosen calendar: links to cards, rows, and notes the key may not read are restricted", async () => {
    const w = await world("Foreign links chosen");
    const scoped = key(w.owner, [on("calendar", "read", "calendar", w.calendarC), on("tasks", "read", "board", w.a.boardId)]);
    const got = await call(scoped, "get_event", { eventId: w.eventC });
    expect(got.isError).toBe(false);
    const links = got.value.links as Array<Record<string, unknown>>;
    // Card A is on the chosen board: its title shows. Card B, the row, and the note do not.
    expect(links).toContainEqual({ targetType: "card", targetId: w.cardA, title: "Alpha card" });
    expect(links).toContainEqual({ targetType: "card", restricted: true });
    expect(links).toContainEqual({ targetType: "collection_row", restricted: true });
    expect(links).toContainEqual({ targetType: "note", restricted: true });
    for (const secret of [SECRETS.cardB, SECRETS.rowY, SECRETS.note, w.cardB, w.rowY.id, w.noteId]) expect(got.text).not.toContain(secret);
  });

  test("(c) calendar:read over every calendar without a tasks grant: card links are restricted", async () => {
    const w = await world("Foreign links all");
    const calendarOnly = key(w.owner, [all("calendar", "read")]);
    const got = await call(calendarOnly, "get_event", { eventId: w.eventC });
    const links = got.value.links as Array<Record<string, unknown>>;
    expect(linkFor(links, "card")).toEqual([{ targetType: "card", restricted: true }, { targetType: "card", restricted: true }]);
    expect(linkFor(links, "collection_row")).toEqual([{ targetType: "collection_row", restricted: true }]);
    expect(linkFor(links, "note")).toEqual([{ targetType: "note", restricted: true }]);
    for (const secret of ["Alpha card", SECRETS.cardB, SECRETS.rowY, SECRETS.note]) expect(got.text).not.toContain(secret);
    // Both grants: titles come back (the owner can read them all).
    const both = key(w.owner, [all("calendar", "read"), all("tasks", "read"), all("collections", "read"), all("notes", "read")]);
    const full = (await call(both, "get_event", { eventId: w.eventC })).value.links as Array<Record<string, unknown>>;
    expect(full).toContainEqual({ targetType: "card", targetId: w.cardB, title: SECRETS.cardB });
    expect(full).toContainEqual({ targetType: "collection_row", targetId: w.rowY.id, title: SECRETS.rowY });
    expect(full).toContainEqual({ targetType: "note", targetId: w.noteId, title: SECRETS.note });
  });

  test("(d) a chosen collection without notes:read: a note field is restricted in get_row and query_rows", async () => {
    const w = await world("Foreign note field");
    const scoped = key(w.owner, [on("collections", "read", "collection", w.collectionX.id)]);
    const row = await call(scoped, "get_row", { rowId: w.rowX.id });
    expect(row.value.row.values["Linked note"]).toEqual({ restricted: true });
    const rows = await call(scoped, "query_rows", { collectionId: w.collectionX.id });
    expect((rows.value.rows as Array<{ id: string; values: Record<string, unknown> }>).find((item) => item.id === w.rowX.id)!.values["Linked note"]).toEqual({ restricted: true });
    for (const result of [row, rows]) {
      expect(result.text).not.toContain(SECRETS.note);
      expect(result.text).not.toContain(w.noteId);
    }
    // With notes:read the title is back.
    const withNotes = key(w.owner, [on("collections", "read", "collection", w.collectionX.id), all("notes", "read")]);
    expect((await call(withNotes, "get_row", { rowId: w.rowX.id })).value.row.values["Linked note"]).toEqual({ noteId: w.noteId, title: SECRETS.note });
  });

  test("(e) create_row and update_row pointing a note field at a note the key may not read are NOT_FOUND", async () => {
    const w = await world("Foreign note write");
    const scoped = key(w.owner, [on("collections", "write", "collection", w.collectionX.id)]);
    const current = (await call(scoped, "get_row", { rowId: w.plainRowX.id })).value;
    const update = await call(scoped, "update_row", { rowId: w.plainRowX.id, values: { "Linked note": w.noteId }, baseRevision: current.revision });
    expect(update).toMatchObject({ isError: true, value: { code: "NOT_FOUND" } });
    // Nothing changed, and the next read shows no title.
    const after = await call(scoped, "get_row", { rowId: w.plainRowX.id });
    expect(after.value.revision).toBe(current.revision);
    expect(after.text).not.toContain(SECRETS.note);
    expect((await call(scoped, "create_row", { collectionId: w.collectionX.id, values: { Name: "New", "Linked note": w.noteId } })).value.code).toBe("NOT_FOUND");
    // A missing note looks the same.
    expect((await call(scoped, "create_row", { collectionId: w.collectionX.id, values: { Name: "New", "Linked note": crypto.randomUUID() } })).value.code).toBe("NOT_FOUND");
    // Clearing the field is always allowed, and a key with notes:read may link.
    expect((await call(scoped, "update_row", { rowId: w.rowX.id, values: { "Linked note": null }, baseRevision: 1 })).isError).toBe(false);
    const withNotes = key(w.owner, [on("collections", "write", "collection", w.collectionX.id), all("notes", "read")]);
    expect((await call(withNotes, "update_row", { rowId: w.plainRowX.id, values: { "Linked note": w.noteId }, baseRevision: current.revision })).isError).toBe(false);
  });

  test("enumeration: every read tool a chosen-items key can see presents nothing outside its grants", async () => {
    const w = await world("Foreign enumeration");
    const keyId = key(w.owner, [
      on("tasks", "write", "board", w.a.boardId),
      on("calendar", "write", "calendar", w.calendarC),
      on("collections", "write", "collection", w.collectionX.id)
    ]);
    const context = loadLiveKey(keyId)!;
    // Sample arguments for each resource argument, all inside the grants.
    const samples: Record<string, unknown> = {
      boardId: w.a.boardId, cardId: w.cardA, columnId: w.a.columnId, collectionId: w.collectionX.id, rowId: w.rowX.id, calendarId: w.calendarC, eventId: w.eventC,
      // Wave 34: the cross-board and cross-calendar reads are offered to chosen-item keys too.
      query: "a", filter: "", from: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10), to: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    };
    const visible = mcpToolSpecs.filter((spec) => toolVisible(spec, context));
    const reads = visible.filter((spec) => !spec.write);
    expect(reads.length).toBeGreaterThan(5);
    const called: string[] = [];
    for (const spec of reads) {
      const shape = (spec.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
      const args = Object.fromEntries(Object.keys(shape).filter((name) => name in samples).map((name) => [name, samples[name]]));
      const parsed = spec.inputSchema.safeParse(args);
      // Every read tool this key can see must be callable from the samples, so a new one is covered.
      expect({ tool: spec.name, ok: parsed.success }).toEqual({ tool: spec.name, ok: true });
      const result = await call(keyId, spec.name, args);
      expect({ tool: spec.name, isError: result.isError }).toEqual({ tool: spec.name, isError: false });
      for (const secret of [...Object.values(SECRETS), w.cardB, w.b.boardId, w.noteId, w.rowY.id, w.collectionY.id, w.calendarD]) {
        expect({ tool: spec.name, leaked: result.text.includes(secret) ? secret : null }).toEqual({ tool: spec.name, leaked: null });
      }
      called.push(spec.name);
    }
    for (const name of ["get_card", "list_cards", "get_event", "get_row", "query_rows"]) expect(called).toContain(name);
  });
});
