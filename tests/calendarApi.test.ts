import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, newCollection } from "./support/collections";

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

type Calendar = { id: string; name: string; role: string; is_owner: number; color: string };
type EventBody = { event: { id: string; revision: number; title: string; canUndo: boolean; exdates: string[]; repeat: unknown }; role: string; links: Array<{ targetType: string; targetId: string; title: string | null; restricted: boolean }> };
type Occurrence = { eventId: string; calendarId: string; title: string; allDay: boolean; date: string; start: string; end: string; recurring: boolean };

const send = (session: Session, method: string, path: string, body?: unknown) =>
  request(path, { method, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) }, session);

async function calendars(session: Session) {
  const response = await request("/calendars", {}, session);
  expect(response.status).toBe(200);
  return (await json<{ calendars: Calendar[] }>(response)).calendars;
}

async function newCalendar(session: Session, name = "Family") {
  const response = await send(session, "POST", "/calendars", { name, color: "green" });
  expect(response.status).toBe(201);
  return (await json<{ calendar: Calendar }>(response)).calendar;
}

async function share(owner: Session, calendarId: string, shareRole: "viewer" | "editor", users: Session[]) {
  const response = await send(owner, "PUT", `/calendars/${calendarId}/sharing`, { visibility: "selected", shareRole, userIds: users.map((user) => user.userId) });
  expect(response.status).toBe(200);
}

const timedEvent = (overrides: Record<string, unknown> = {}) => ({ title: "Dentist", allDay: false, startLocal: "2026-05-04T09:00", tz: "Europe/Berlin", durationMinutes: 60, ...overrides });

async function newEvent(session: Session, calendarId: string, overrides: Record<string, unknown> = {}) {
  const response = await send(session, "POST", `/calendars/${calendarId}/events`, timedEvent(overrides));
  expect(response.status).toBe(201);
  return (await json<EventBody>(response)).event;
}

async function occurrences(session: Session, from: string, to: string, extra = "") {
  const response = await request(`/events?from=${from}&to=${to}&tz=UTC${extra}`, {}, session);
  expect(response.status).toBe(200);
  return json<{ occurrences: Occurrence[]; truncated: boolean }>(response);
}

async function createNote(session: Session, markdown: string) {
  const created = await send(session, "POST", "/notes", { folderId: null });
  const id = (await json<{ note: { id: string } }>(created)).note.id;
  expect((await send(session, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  expect((await send(session, "POST", `/notes/${id}/publish`)).status).toBe(200);
  return id;
}

describe("calendars", () => {
  test("the first list creates one Personal calendar, and only once", async () => {
    const user = await createUser("Calendar first use");
    const first = await calendars(user);
    expect(first.map((calendar) => [calendar.name, calendar.role, calendar.is_owner])).toEqual([["Personal", "owner", 1]]);
    expect((await calendars(user)).length).toBe(1);
    // Binning Personal does not bring a new one back.
    expect((await send(user, "DELETE", `/calendars/${first[0]!.id}`)).status).toBe(200);
    expect(await calendars(user)).toEqual([]);
  });

  test("create validates names and colours and caps calendars per owner", async () => {
    const user = await createUser("Calendar caps");
    expect((await send(user, "POST", "/calendars", { name: "", color: "blue" })).status).toBe(400);
    expect((await send(user, "POST", "/calendars", { name: "Bad\u0007", color: "blue" })).status).toBe(400);
    expect((await send(user, "POST", "/calendars", { name: "Pink", color: "pink" })).status).toBe(400);
    expect((await send(user, "POST", "/calendars", { name: "x".repeat(81) })).status).toBe(400);
    await calendars(user); // Personal
    for (let index = 1; index < 20; index += 1) await newCalendar(user, `Calendar ${index}`);
    const over = await send(user, "POST", "/calendars", { name: "One too many" });
    expect(over.status).toBe(409);
    expect((await json<{ code: string }>(over)).code).toBe("LIMIT_REACHED");
  });

  test("owner-only actions: 403 OWNER_ONLY for viewers and editors, 404 for strangers", async () => {
    const owner = await createUser("Calendar owner");
    const viewer = await createUser("Calendar viewer");
    const editor = await createUser("Calendar editor");
    const stranger = await createUser("Calendar stranger");
    const readOnly = await newCalendar(owner, "Read only");
    const shared = await newCalendar(owner, "Shared editing");
    await share(owner, readOnly.id, "viewer", [viewer]);
    await share(owner, shared.id, "editor", [editor]);

    expect((await calendars(viewer)).find((calendar) => calendar.id === readOnly.id)?.role).toBe("viewer");
    expect((await calendars(editor)).find((calendar) => calendar.id === shared.id)?.role).toBe("editor");
    expect((await calendars(stranger)).some((calendar) => calendar.id === readOnly.id || calendar.id === shared.id)).toBe(false);

    for (const [session, calendarId] of [[viewer, readOnly.id], [editor, shared.id]] as const) {
      for (const [method, path, body] of [
        ["PATCH", `/calendars/${calendarId}`, { name: "Renamed" }],
        ["DELETE", `/calendars/${calendarId}`, undefined],
        ["GET", `/calendars/${calendarId}/sharing`, undefined],
        ["PUT", `/calendars/${calendarId}/sharing`, { visibility: "private", userIds: [] }]
      ] as const) {
        const response = await send(session, method, path, body);
        expect(response.status).toBe(403);
        // Rename and colour are the owner's or a manager's (Wave 32, D273); the rest the owner's.
        expect((await json<{ code: string }>(response)).code).toBe(method === "PATCH" ? "MANAGER_REQUIRED" : "OWNER_ONLY");
        const strangerResponse = await send(stranger, method, path, body);
        expect(strangerResponse.status).toBe(404);
      }
    }
    expect((await send(owner, "PATCH", `/calendars/${shared.id}`, { name: "Family", color: "violet" })).status).toBe(200);
    expect((await send(owner, "PATCH", `/calendars/${shared.id}`, {})).status).toBe(400);
    expect((await send(owner, "PATCH", "/calendars/not-a-uuid", { name: "x" })).status).toBe(400);
  });

  test("sharing validates recipients and reports the audience", async () => {
    const owner = await createUser("Sharing owner");
    const friend = await createUser("Sharing friend");
    const calendar = await newCalendar(owner);
    const put = (body: unknown) => send(owner, "PUT", `/calendars/${calendar.id}/sharing`, body);
    expect((await put({ visibility: "selected", userIds: [owner.userId] })).status).toBe(400);
    expect((await put({ visibility: "selected", userIds: [] })).status).toBe(400);
    expect((await put({ visibility: "selected", userIds: [crypto.randomUUID()] })).status).toBe(400);
    expect((await put({ visibility: "selected", userIds: Array.from({ length: 101 }, () => crypto.randomUUID()) })).status).toBe(400);
    expect((await put({ visibility: "selected", shareRole: "owner", userIds: [friend.userId] })).status).toBe(400);
    expect((await put({ visibility: "selected", shareRole: "editor", userIds: [friend.userId, friend.userId] })).status).toBe(200);
    const sharing = await json<{ visibility: string; shareRole: string; users: Array<{ id: string }> }>(await send(owner, "GET", `/calendars/${calendar.id}/sharing`));
    expect(sharing).toMatchObject({ visibility: "selected", shareRole: "editor", users: [{ id: friend.userId }] });
    expect((await put({ visibility: "all_users", shareRole: "viewer" })).status).toBe(200);
    expect((await calendars(friend)).find((item) => item.id === calendar.id)?.role).toBe("viewer");
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'calendar.sharing_changed' AND actor_id = ? ORDER BY rowid DESC LIMIT 1").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ calendarId: calendar.id, visibility: "all_users", shareRole: "viewer", recipientCount: 0 });
  });
});

describe("events", () => {
  test("role matrix: editors write, viewers read with 403 READ_ONLY, strangers get 404", async () => {
    const owner = await createUser("Event owner");
    const viewer = await createUser("Event viewer");
    const editor = await createUser("Event editor");
    const stranger = await createUser("Event stranger");
    const calendar = await newCalendar(owner);
    await share(owner, calendar.id, "viewer", [viewer]);
    const event = await newEvent(owner, calendar.id);

    const viewerRead = await send(viewer, "GET", `/events/${event.id}`);
    expect(viewerRead.status).toBe(200);
    expect((await json<EventBody>(viewerRead)).role).toBe("viewer");
    for (const [method, path, body] of [
      ["POST", `/calendars/${calendar.id}/events`, timedEvent()],
      ["PATCH", `/events/${event.id}`, { title: "Nope", revision: event.revision }],
      ["POST", `/events/${event.id}/undo`, { revision: event.revision }],
      ["POST", `/events/${event.id}/exdates`, { date: "2026-05-04" }],
      ["DELETE", `/events/${event.id}`, undefined],
      ["POST", `/events/${event.id}/links`, { targetType: "card", targetId: crypto.randomUUID() }],
      ["DELETE", `/events/${event.id}/links`, { targetType: "card", targetId: crypto.randomUUID() }]
    ] as const) {
      const response = await send(viewer, method, path, body);
      expect(response.status).toBe(403);
      expect((await json<{ code: string }>(response)).code).toBe("READ_ONLY");
      expect((await send(stranger, method, path, body)).status).toBe(404);
    }
    expect((await send(stranger, "GET", `/events/${event.id}`)).status).toBe(404);
    expect((await occurrences(stranger, "2026-05-01", "2026-05-10", `&calendars=${calendar.id}`)).occurrences).toEqual([]);
    expect((await occurrences(viewer, "2026-05-01", "2026-05-10", `&calendars=${calendar.id}`)).occurrences.map((item) => item.eventId)).toEqual([event.id]);

    await share(owner, calendar.id, "editor", [editor]);
    // The viewer was replaced by the editor: access follows the live audience.
    expect((await send(viewer, "GET", `/events/${event.id}`)).status).toBe(404);
    const created = await newEvent(editor, calendar.id, { title: "Editor's event" });
    const patched = await send(editor, "PATCH", `/events/${event.id}`, { title: "Moved", revision: event.revision });
    expect(patched.status).toBe(200);
    expect((await send(editor, "DELETE", `/events/${created.id}`)).status).toBe(200);
    expect((await send(editor, "GET", `/events/${created.id}`)).status).toBe(404);

    // A binned calendar hides its events from everyone.
    expect((await send(owner, "DELETE", `/calendars/${calendar.id}`)).status).toBe(200);
    expect((await send(owner, "GET", `/events/${event.id}`)).status).toBe(404);
    expect((await send(editor, "PATCH", `/events/${event.id}`, { title: "Late", revision: 2 })).status).toBe(404);
    expect((await occurrences(owner, "2026-05-01", "2026-05-10")).occurrences.some((item) => item.eventId === event.id)).toBe(false);
  });

  test("IDOR: ids from someone else's calendar are refused through every path", async () => {
    const alice = await createUser("IDOR Alice");
    const bob = await createUser("IDOR Bob");
    const aliceCalendar = await newCalendar(alice, "Alice");
    const bobCalendar = await newCalendar(bob, "Bob");
    const aliceEvent = await newEvent(alice, aliceCalendar.id);
    await newEvent(bob, bobCalendar.id);
    expect((await send(bob, "POST", `/calendars/${aliceCalendar.id}/events`, timedEvent())).status).toBe(404);
    expect((await send(bob, "GET", `/events/${aliceEvent.id}`)).status).toBe(404);
    expect((await send(bob, "PATCH", `/events/${aliceEvent.id}`, { title: "Mine now", revision: 1 })).status).toBe(404);
    // A calendars filter naming Alice's calendar returns nothing of hers.
    const listed = await occurrences(bob, "2026-05-01", "2026-05-10", `&calendars=${aliceCalendar.id},${bobCalendar.id}`);
    expect(listed.occurrences.every((item) => item.calendarId === bobCalendar.id)).toBe(true);
    expect(listed.occurrences.length).toBe(1);
    expect((await request(`/events?from=2026-05-01&to=2026-05-10&calendars=nope`, {}, bob)).status).toBe(400);
    expect((await send(alice, "GET", `/events/${crypto.randomUUID()}`)).status).toBe(404);
  });

  test("validates timing, rules, and text", async () => {
    const user = await createUser("Event validation");
    const calendar = await newCalendar(user);
    const post = (body: Record<string, unknown>) => send(user, "POST", `/calendars/${calendar.id}/events`, body);
    expect((await post(timedEvent({ tz: undefined }))).status).toBe(400);
    expect((await post(timedEvent({ tz: "Mars/Olympus" }))).status).toBe(400);
    expect((await post(timedEvent({ startLocal: "2026-02-30T09:00" }))).status).toBe(400);
    expect((await post(timedEvent({ durationMinutes: 10_081 }))).status).toBe(400);
    expect((await post(timedEvent({ title: "Line\nbreak" }))).status).toBe(400);
    expect((await post(timedEvent({ title: "" }))).status).toBe(400);
    expect((await post(timedEvent({ description: "x".repeat(8193) }))).status).toBe(400);
    expect((await post(timedEvent({ repeat: { freq: "weekly", interval: 1, byDay: ["TU"] } }))).status).toBe(400);
    expect((await post(timedEvent({ repeat: { freq: "daily", interval: 1, count: 731 } }))).status).toBe(400);
    expect((await post(timedEvent({ repeat: { freq: "hourly", interval: 1 } }))).status).toBe(400);
    expect((await post({ title: "Trip", allDay: true, startDate: "2026-05-04", endDate: "2026-05-04" })).status).toBe(400);
    expect((await post({ title: "Trip", allDay: true, startDate: "2026-05-04", endDate: "2026-05-07", extra: 1 })).status).toBe(400);
    const allDay = await post({ title: "Trip", allDay: true, startDate: "2026-05-04", endDate: "2026-05-07", description: "Line one\nLine two", location: "Lisbon" });
    expect(allDay.status).toBe(201);
    const body = (await json<EventBody & { event: { all_day: boolean; start_local: string | null; tz: string | null } }>(allDay)).event;
    expect(body).toMatchObject({ all_day: true, start_local: null, tz: null });
    // Audit rows carry ids only.
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'event.create' AND actor_id = ?").get(user.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ eventId: body.id, calendarId: calendar.id });
  });

  test("PATCH is a compare-and-swap: stale revisions get 409 EVENT_CHANGED, and one step can be undone", async () => {
    const owner = await createUser("CAS owner");
    const editor = await createUser("CAS editor");
    const calendar = await newCalendar(owner);
    await share(owner, calendar.id, "editor", [editor]);
    const event = await newEvent(owner, calendar.id);
    expect(event.canUndo).toBe(false);

    const first = await send(editor, "PATCH", `/events/${event.id}`, { title: "Dentist (moved)", startLocal: "2026-05-05T10:30", revision: 1 });
    expect(first.status).toBe(200);
    const afterFirst = (await json<EventBody>(first)).event;
    expect(afterFirst).toMatchObject({ revision: 2, title: "Dentist (moved)", canUndo: true });

    const stale = await send(owner, "PATCH", `/events/${event.id}`, { title: "Old view", revision: 1 });
    expect(stale.status).toBe(409);
    const staleBody = await json<{ code: string; revision: number; event: { title: string } }>(stale);
    expect(staleBody).toMatchObject({ code: "EVENT_CHANGED", revision: 2, event: { title: "Dentist (moved)" } });

    expect((await send(owner, "POST", `/events/${event.id}/undo`, { revision: 1 })).status).toBe(409);
    const undone = await send(owner, "POST", `/events/${event.id}/undo`, { revision: 2 });
    expect(undone.status).toBe(200);
    const restored = (await json<EventBody & { event: { start_local: string } }>(undone)).event;
    expect(restored).toMatchObject({ revision: 3, title: "Dentist", start_local: "2026-05-04T09:00", canUndo: false });
    const nothing = await send(owner, "POST", `/events/${event.id}/undo`, { revision: 3 });
    expect(nothing.status).toBe(409);
    expect((await json<{ code: string }>(nothing)).code).toBe("NOTHING_TO_UNDO");

    // Switching to all-day clears the timed columns, and the occurrence moves with it.
    const toAllDay = await send(owner, "PATCH", `/events/${event.id}`, { allDay: true, startDate: "2026-05-06", endDate: "2026-05-07", revision: 3 });
    expect(toAllDay.status).toBe(200);
    expect((await json<EventBody & { event: { all_day: boolean; tz: string | null } }>(toAllDay)).event).toMatchObject({ all_day: true, tz: null, revision: 4 });
    const listed = await occurrences(owner, "2026-05-01", "2026-05-10", `&calendars=${calendar.id}`);
    expect(listed.occurrences).toMatchObject([{ eventId: event.id, allDay: true, start: "2026-05-06", end: "2026-05-07" }]);
    expect((await send(owner, "PATCH", `/events/${event.id}`, { allDay: false, revision: 4 })).status).toBe(400);
  });

  test("range listing expands occurrences server-side, applies exdates, and rejects ranges over 100 days", async () => {
    const user = await createUser("Range user");
    const calendar = await newCalendar(user);
    const weekly = await newEvent(user, calendar.id, { title: "Standup", tz: "America/New_York", startLocal: "2026-03-02T09:00", repeat: { freq: "weekly", interval: 1, byDay: ["MO", "WE"] } });
    const listed = await occurrences(user, "2026-03-01", "2026-03-15", `&calendars=${calendar.id}`);
    expect(listed.occurrences.map((item) => [item.date, item.start])).toEqual([
      ["2026-03-02", "2026-03-02T14:00:00.000Z"],
      ["2026-03-04", "2026-03-04T14:00:00.000Z"],
      // New York moved to daylight time on 2026-03-08; the wall time stays 09:00.
      ["2026-03-09", "2026-03-09T13:00:00.000Z"],
      ["2026-03-11", "2026-03-11T13:00:00.000Z"]
    ]);
    expect(listed.occurrences.every((item) => item.recurring)).toBe(true);

    expect((await send(user, "POST", `/events/${weekly.id}/exdates`, { date: "2026-03-05" })).status).toBe(400);
    expect((await send(user, "POST", `/events/${weekly.id}/exdates`, { date: "2026-02-30" })).status).toBe(400);
    const skipped = await send(user, "POST", `/events/${weekly.id}/exdates`, { date: "2026-03-04" });
    expect(skipped.status).toBe(200);
    expect((await json<EventBody>(skipped)).event).toMatchObject({ exdates: ["2026-03-04"], canUndo: true });
    expect((await occurrences(user, "2026-03-01", "2026-03-15", `&calendars=${calendar.id}`)).occurrences.map((item) => item.date)).toEqual(["2026-03-02", "2026-03-09", "2026-03-11"]);
    const single = await newEvent(user, calendar.id, { title: "Once" });
    expect((await send(user, "POST", `/events/${single.id}/exdates`, { date: "2026-05-04" })).status).toBe(400);

    for (const query of ["from=2026-01-01&to=2026-04-12", "from=2026-01-02&to=2026-01-01", "from=2026-01-01&to=2026-01-05&tz=Nowhere/City", "from=2026-02-30&to=2026-03-02", "to=2026-01-05"]) {
      expect((await request(`/events?${query}`, {}, user)).status).toBe(400);
    }
    expect((await request("/events?from=2026-01-01&to=2026-04-11", {}, user)).status).toBe(200);
  });

  test("expansion stops at 1000 instances per request and says so", async () => {
    const user = await createUser("Cap user");
    const calendar = await newCalendar(user);
    for (let index = 0; index < 11; index += 1) {
      await newEvent(user, calendar.id, { title: `Daily ${index}`, tz: "UTC", startLocal: "2026-01-01T08:00", durationMinutes: 15, repeat: { freq: "daily", interval: 1 } });
    }
    const listed = await occurrences(user, "2026-01-01", "2026-04-11", `&calendars=${calendar.id}`);
    expect(listed.occurrences.length).toBe(1000);
    expect(listed.truncated).toBe(true);
    const short = await occurrences(user, "2026-01-01", "2026-01-11", `&calendars=${calendar.id}`);
    expect(short.occurrences.length).toBe(110);
    expect(short.truncated).toBe(false);
  });

  test("a calendar holds at most 20k live events", async () => {
    const user = await createUser("Event cap user");
    const calendar = await newCalendar(user);
    const insert = db.query(`INSERT INTO events (id, calendar_id, title, all_day, start_date, end_date, start_utc, series_end_utc, created_at, updated_at)
      VALUES (?, ?, 'Bulk', 1, '2020-01-01', '2020-01-02', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`);
    db.transaction(() => { for (let index = 0; index < 20_000; index += 1) insert.run(crypto.randomUUID(), calendar.id); })();
    const over = await send(user, "POST", `/calendars/${calendar.id}/events`, timedEvent());
    expect(over.status).toBe(409);
    expect((await json<{ code: string }>(over)).code).toBe("LIMIT_REACHED");
    db.query("DELETE FROM events WHERE calendar_id = ?").run(calendar.id);
  });

  test("links: the linker must read the target, and titles resolve per viewer", async () => {
    const owner = await createUser("Link owner");
    const editor = await createUser("Link editor");
    const calendar = await newCalendar(owner);
    await share(owner, calendar.id, "editor", [editor]);
    const event = await newEvent(owner, calendar.id);
    const ownerNote = await createNote(owner, "# Packing list\n\nsocks");
    const editorNote = await createNote(editor, "# Editor private note");

    const linked = await send(owner, "POST", `/events/${event.id}/links`, { targetType: "note", targetId: ownerNote });
    expect(linked.status).toBe(201);
    expect((await json<{ link: unknown }>(linked)).link).toEqual({ targetType: "note", targetId: ownerNote, title: "Packing list", restricted: false });
    expect((await send(owner, "POST", `/events/${event.id}/links`, { targetType: "note", targetId: ownerNote })).status).toBe(200);
    // The owner cannot read the editor's private note, so cannot link it.
    expect((await send(owner, "POST", `/events/${event.id}/links`, { targetType: "note", targetId: editorNote })).status).toBe(404);
    expect((await send(editor, "POST", `/events/${event.id}/links`, { targetType: "note", targetId: editorNote })).status).toBe(201);
    // Card and collection-row links use the Tasks and Collections ACLs: the linker must read the target.
    const tasks = async (method: string, path: string, body?: unknown) => (await (await request(`/tasks${path}`, { method, body: JSON.stringify(body ?? {}) }, editor)).json()) as Record<string, any>;
    const board = await tasks("POST", "/boards", { name: "Editor board" });
    const cardId = (await tasks("POST", `/boards/${board.board.id}/cards`, { columnId: board.columns[0].id, title: "Book train" })).card.id as string;
    expect((await send(owner, "POST", `/events/${event.id}/links`, { targetType: "card", targetId: cardId })).status).toBe(404);
    expect((await send(editor, "POST", `/events/${event.id}/links`, { targetType: "card", targetId: crypto.randomUUID() })).status).toBe(404);
    const cardLink = await send(editor, "POST", `/events/${event.id}/links`, { targetType: "card", targetId: cardId });
    expect(cardLink.status).toBe(201);
    expect((await json<{ link: { restricted: boolean; title: string | null } }>(cardLink)).link).toMatchObject({ restricted: false, title: "Book train" });
    const collection = await newCollection(editor, { name: "Trip", fields: [{ name: "Name", type: "text" }] });
    const row = await addRow(editor, collection.id, { [collection.fields[0]!.id]: "Passport" });
    const rowLink = await send(editor, "POST", `/events/${event.id}/links`, { targetType: "collection_row", targetId: row.id });
    expect(rowLink.status).toBe(201);
    expect((await json<{ link: { restricted: boolean; title: string | null } }>(rowLink)).link).toMatchObject({ restricted: false, title: "Passport" });
    expect((await send(editor, "POST", `/events/${event.id}/links`, { targetType: "folder", targetId: cardId })).status).toBe(400);
    expect((await send(editor, "POST", `/events/${event.id}/links`, { targetType: "card", targetId: "abc" })).status).toBe(400);

    const ownerView = (await json<EventBody>(await send(owner, "GET", `/events/${event.id}`))).links;
    expect(ownerView).toEqual([
      { targetType: "note", targetId: ownerNote, title: "Packing list", restricted: false },
      { targetType: "note", targetId: editorNote, title: null, restricted: true },
      { targetType: "card", targetId: cardId, title: null, restricted: true },
      { targetType: "collection_row", targetId: row.id, title: null, restricted: true }
    ]);
    const editorView = (await json<EventBody>(await send(editor, "GET", `/events/${event.id}`))).links;
    expect(editorView.map((link) => link.restricted)).toEqual([true, false, false, false]);
    expect(editorView[1]!.title).toBe("Editor private note");
    expect(editorView[2]!.title).toBe("Book train");
    expect(editorView[3]!.title).toBe("Passport");

    expect((await send(editor, "DELETE", `/events/${event.id}/links`, { targetType: "card", targetId: cardId })).status).toBe(200);
    expect((await send(editor, "DELETE", `/events/${event.id}/links`, { targetType: "card", targetId: cardId })).status).toBe(404);
    const auditRow = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'event.unlink' AND actor_id = ?").get(editor.userId) as { metadata_json: string };
    expect(JSON.parse(auditRow.metadata_json)).toEqual({ eventId: event.id, targetType: "card", targetId: cardId });
  });
});
