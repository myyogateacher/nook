import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { consumeMcpLimits, MCP_LIMITS, resetMcpLimits } = await import("../server/mcpRateLimit");
type McpScope = import("../server/mcpScopes").McpScope;

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string; userId: string };
const makeKey = (session: Session, scopes: McpScope[], name = "Calendar agent"): Key => {
  const key = createMcpApiKey(session.userId, name, scopes);
  return { id: key.id, token: key.token, userId: session.userId };
};

/**
 * Events that get reminders fall in a later calendar year (the fixture is next year's 5 October), so a reminder never lies in the past. Berlin is
 * on summer time that day in every year (it ends on the last Sunday of October): UTC+2.
 */
const Y = new Date().getUTCFullYear() + 1;

let rpcId = 0;
async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
}

const toolNames = async (key: Key) => ((await rpc(key, "tools/list")).result!.tools!).map((tool) => tool.name).sort();

type Outcome = { isError: boolean; value: Record<string, any> };
async function callTool(key: Key, name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, value: { error: body.error.message } };
  const text = body.result!.content![0]!.text;
  let value: Record<string, any>;
  try { value = JSON.parse(text); } catch { value = { error: text }; }
  return { isError: body.result!.isError === true, value };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const editor = await createUser(`${label} editor`);
  const viewer = await createUser(`${label} viewer`);
  const stranger = await createUser(`${label} stranger`);
  const editable = (await api(owner, "POST", "/calendars", { name: `${label} family`, color: "green" })).body.calendar.id as string;
  const readOnly = (await api(owner, "POST", "/calendars", { name: `${label} club`, color: "blue" })).body.calendar.id as string;
  expect((await api(owner, "PUT", `/calendars/${editable}/sharing`, { visibility: "selected", shareRole: "editor", userIds: [editor.userId, viewer.userId] })).status).toBe(200);
  expect((await api(owner, "PUT", `/calendars/${readOnly}/sharing`, { visibility: "selected", shareRole: "viewer", userIds: [editor.userId, viewer.userId] })).status).toBe(200);
  // The viewer only views the club calendar, and is not on a third private one.
  const privateId = (await api(owner, "POST", "/calendars", { name: `${label} private`, color: "red" })).body.calendar.id as string;
  const event = (await api(owner, "POST", `/calendars/${readOnly}/events`, { title: "Club night", allDay: false, startLocal: `${Y}-10-05T19:00`, tz: "Europe/Berlin", durationMinutes: 120, description: "Bring snacks" })).body.event as { id: string; revision: number };
  const privateEvent = (await api(owner, "POST", `/calendars/${privateId}/events`, { title: "Secret", allDay: true, startDate: `${Y}-10-06`, endDate: `${Y}-10-07` })).body.event as { id: string };
  return { owner, editor, viewer, stranger, editable, readOnly, privateId, eventId: event.id, privateEventId: privateEvent.id };
}

const auditRows = (actorId: string, eventType: string) => (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY created_at").all(actorId, eventType) as Array<{ metadata_json: string }>)
  .map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);

const READ_TOOLS = ["get_event", "list_calendars", "list_events"];
const WRITE_TOOLS = ["create_event", "create_reminder", "update_event"];

describe("MCP calendar tools", () => {
  test("appear only for calendar scopes, write implies read, the handler re-checks, and nothing deletes", async () => {
    const user = await createUser("Calendar scopes");
    const reader = makeKey(user, ["calendar:read"]);
    expect(await toolNames(reader)).toEqual(READ_TOOLS);
    const writer = makeKey(user, ["calendar:write"]);
    expect(await toolNames(writer)).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    const other = makeKey(user, ["notes:read", "tasks:write", "today:read"]);
    const otherTools = await toolNames(other);
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) expect(otherTools).not.toContain(name);
    for (const name of await toolNames(writer)) expect(name).not.toMatch(/delete|share|feed|exdate/);
    // Direct handler calls are refused without the scope (T72).
    const direct = await invokeMcpToolForTests("list_calendars", {}, other.id);
    expect(JSON.parse(direct.content[0]!.text).code).toBe("SCOPE_REQUIRED");
    const readWrite = await invokeMcpToolForTests("create_event", { calendarId: crypto.randomUUID(), title: "x", allDay: true, start: "2026-10-01" }, reader.id);
    expect(JSON.parse(readWrite.content[0]!.text).code).toBe("SCOPE_REQUIRED");
    // Settings and the keys API accept the new scopes.
    const created = await api(user, "POST", "/mcp/keys", { name: "via api", password: user.password, scopes: ["calendar:write"] });
    expect(created.status).toBe(201);
    expect(created.body.key.scopes).toEqual(["calendar:read", "calendar:write"]);
  });

  test("role matrix: reads follow readable calendars; editors write; viewers and strangers cannot", async () => {
    const s = await setup("Calendar roles");
    const owner = makeKey(s.owner, ["calendar:write"]);
    const editor = makeKey(s.editor, ["calendar:write"]);
    const viewer = makeKey(s.viewer, ["calendar:write"]);
    const stranger = makeKey(s.stranger, ["calendar:write"]);

    const roles = (value: Record<string, any>) => Object.fromEntries((value.calendars as Array<{ id: string; role: string }>).map((calendar) => [calendar.id, calendar.role]));
    const ownerRoles = roles((await callTool(owner, "list_calendars")).value);
    expect([ownerRoles[s.editable], ownerRoles[s.readOnly], ownerRoles[s.privateId]]).toEqual(["owner", "owner", "owner"]);
    const viewerRoles = roles((await callTool(viewer, "list_calendars")).value);
    expect([viewerRoles[s.editable], viewerRoles[s.readOnly], viewerRoles[s.privateId]]).toEqual(["editor", "viewer", undefined]);
    expect(roles((await callTool(stranger, "list_calendars")).value)[s.readOnly]).toBeUndefined();

    const range = { from: `${Y}-10-01`, to: `${Y}-10-10` };
    const titles = async (key: Key) => ((await callTool(key, "list_events", range)).value.occurrences as Array<{ title: string }>).map((item) => item.title).sort();
    expect(await titles(owner)).toEqual(["Club night", "Secret"]);
    expect(await titles(viewer)).toEqual(["Club night"]);
    expect(await titles(stranger)).toEqual([]);
    expect((await callTool(viewer, "list_events", { ...range, calendarIds: [s.privateId] })).value.occurrences).toEqual([]);

    const got = await callTool(viewer, "get_event", { eventId: s.eventId });
    expect(got.isError).toBe(false);
    expect(got.value).toMatchObject({ revision: 1, role: "viewer", event: { title: "Club night", description: "Bring snacks", start: `${Y}-10-05T19:00`, tz: "Europe/Berlin", durationMinutes: 120 } });
    for (const [key, eventId] of [[stranger, s.eventId], [viewer, s.privateEventId], [owner, crypto.randomUUID()]] as const) {
      const missing = await callTool(key, "get_event", { eventId });
      expect(missing.isError).toBe(true);
      expect(missing.value.code).toBe("NOT_FOUND");
    }

    const allDay = { title: "Picnic", allDay: true, start: "2026-10-08" };
    const viewerCreate = await callTool(viewer, "create_event", { calendarId: s.readOnly, ...allDay });
    expect(viewerCreate.value.code).toBe("READ_ONLY");
    expect((await callTool(stranger, "create_event", { calendarId: s.editable, ...allDay })).value.code).toBe("NOT_FOUND");
    expect((await callTool(viewer, "create_event", { calendarId: s.privateId, ...allDay })).value.code).toBe("NOT_FOUND");
    const created = await callTool(editor, "create_event", { calendarId: s.editable, ...allDay });
    expect(created.isError).toBe(false);
    expect(created.value).toEqual({ eventId: expect.any(String), revision: 1, url: `${origin}/calendar/event/${created.value.eventId}` });
    const stored = db.query("SELECT all_day, start_date, end_date, created_by, updated_via_key_id FROM events WHERE id = ?").get(created.value.eventId);
    expect(stored).toEqual({ all_day: 1, start_date: "2026-10-08", end_date: "2026-10-09", created_by: s.editor.userId, updated_via_key_id: editor.id });

    expect((await callTool(viewer, "update_event", { eventId: s.eventId, baseRevision: 1, title: "Hacked" })).value.code).toBe("READ_ONLY");
    expect((await callTool(stranger, "update_event", { eventId: s.eventId, baseRevision: 1, title: "Hacked" })).value.code).toBe("NOT_FOUND");

    // A binned calendar hides its events from reads and writes.
    expect((await api(s.owner, "DELETE", `/calendars/${s.editable}`)).status).toBe(200);
    expect((await callTool(editor, "get_event", { eventId: created.value.eventId })).value.code).toBe("NOT_FOUND");
    expect((await callTool(editor, "create_event", { calendarId: s.editable, ...allDay })).value.code).toBe("NOT_FOUND");
  });

  test("timed events: end or duration, validation, and the 100-day range", async () => {
    const user = await createUser("Calendar timed");
    const key = makeKey(user, ["calendar:write"]);
    const calendarId = (await callTool(key, "list_calendars")).value.calendars[0].id as string;
    const byEnd = await callTool(key, "create_event", { calendarId, title: "Call", allDay: false, start: "2026-03-29T01:30", end: "2026-03-29T04:30", tz: "Europe/Berlin" });
    expect(byEnd.isError).toBe(false);
    // 01:30 CET to 04:30 CEST is two hours of real time.
    expect(db.query("SELECT duration_minutes FROM events WHERE id = ?").get(byEnd.value.eventId)).toEqual({ duration_minutes: 120 });
    const byDuration = await callTool(key, "create_event", { calendarId, title: "Standup", allDay: false, start: "2026-10-05T09:00", durationMinutes: 15, tz: "America/New_York", repeat: { freq: "weekly", byDay: ["MO", "WE"], count: 10 }, location: "Room 1" });
    expect(byDuration.isError).toBe(false);
    expect((await callTool(key, "get_event", { eventId: byDuration.value.eventId })).value.event.repeat).toEqual({ freq: "weekly", interval: 1, byDay: ["MO", "WE"], count: 10 });
    for (const bad of [
      { title: "", allDay: true, start: "2026-10-01" },
      { title: "No tz", allDay: false, start: "2026-10-01T09:00", durationMinutes: 30 },
      { title: "Bad zone", allDay: false, start: "2026-10-01T09:00", durationMinutes: 30, tz: "Mars/Olympus" },
      { title: "Backwards", allDay: false, start: "2026-10-01T09:00", end: "2026-10-01T08:00", tz: "UTC" },
      { title: "Bad rule", allDay: true, start: "2026-10-01", repeat: { freq: "hourly" } },
      { title: "Bell\u0007", allDay: true, start: "2026-10-01" }
    ]) {
      // Through runTool directly: the MCP transport may reject schema-level problems before the handler.
      const result = await invokeMcpToolForTests("create_event", { calendarId, ...bad }, key.id);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).code).toBe("INVALID");
    }
    const tooWide = await callTool(key, "list_events", { from: "2026-01-01", to: "2026-06-01" });
    expect(tooWide.value.code).toBe("INVALID");
    const listed = await callTool(key, "list_events", { from: "2026-10-01", to: "2026-10-15", tz: "America/New_York" });
    expect((listed.value.occurrences as Array<{ title: string; recurring: boolean }>).filter((item) => item.title === "Standup").length).toBe(4);
  });

  test("update_event uses revision CAS, marks the key, and the app can undo it", async () => {
    const user = await createUser("Calendar CAS");
    const key = makeKey(user, ["calendar:write"], "Planner bot");
    const calendarId = (await callTool(key, "list_calendars")).value.calendars[0].id as string;
    const { eventId } = (await callTool(key, "create_event", { calendarId, title: "Draft plan", allDay: true, start: "2026-11-01" })).value;
    // A person edits it in the app, which clears the key mark.
    const edited = await api(user, "PATCH", `/events/${eventId}`, { title: "Person plan", revision: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.event.changedByKey).toBe(false);

    const stale = await callTool(key, "update_event", { eventId, baseRevision: 1, title: "Agent plan" });
    expect(stale.isError).toBe(true);
    expect(stale.value).toMatchObject({ code: "EVENT_CHANGED", currentRevision: 2 });
    expect(db.query("SELECT title FROM events WHERE id = ?").get(eventId)).toEqual({ title: "Person plan" });

    const updated = await callTool(key, "update_event", { eventId, baseRevision: 2, title: "Agent plan", start: "2026-11-02", location: "Park" });
    expect(updated.isError).toBe(false);
    expect(updated.value.revision).toBe(3);
    expect(db.query("SELECT title, start_date, end_date, location, updated_via_key_id FROM events WHERE id = ?").get(eventId)).toEqual({ title: "Agent plan", start_date: "2026-11-02", end_date: "2026-11-03", location: "Park", updated_via_key_id: key.id });
    const detail = await api(user, "GET", `/events/${eventId}`);
    expect(detail.body.event).toMatchObject({ changedByKey: true, changedByKeyName: "Planner bot", canUndo: true });

    // Converting to timed needs a start time and tz; a duration-only change keeps the rest.
    const timed = await callTool(key, "update_event", { eventId, baseRevision: 3, allDay: false, start: "2026-11-02T10:00", tz: "UTC", durationMinutes: 45 });
    expect(timed.isError).toBe(false);
    const longer = await callTool(key, "update_event", { eventId, baseRevision: 4, end: "2026-11-02T12:00" });
    expect(longer.isError).toBe(false);
    expect(db.query("SELECT all_day, start_local, duration_minutes FROM events WHERE id = ?").get(eventId)).toEqual({ all_day: 0, start_local: "2026-11-02T10:00", duration_minutes: 120 });

    const undone = await api(user, "POST", `/events/${eventId}/undo`, { revision: 5 });
    expect(undone.status).toBe(200);
    expect(undone.body.event).toMatchObject({ duration_minutes: 45, changedByKey: false });
  });

  test("create_reminder is for the key owner only, on events they can read", async () => {
    const s = await setup("Calendar reminders");
    const viewer = makeKey(s.viewer, ["calendar:write"]);
    const stranger = makeKey(s.stranger, ["calendar:write"]);
    const created = await callTool(viewer, "create_reminder", { eventId: s.eventId, offsetMinutes: 30, tz: "Europe/Berlin" });
    expect(created.isError).toBe(false);
    const reminderId = created.value.reminderId as string;
    expect(created.value).toMatchObject({ reminderId: expect.any(String), nextFireAt: `${Y}-10-05T16:30:00.000Z`, eventId: s.eventId });
    expect(db.query("SELECT user_id, created_via_key_id FROM reminders WHERE id = ?").get(reminderId)).toEqual({ user_id: s.viewer.userId, created_via_key_id: viewer.id });
    // Nobody else sees it, including the calendar owner.
    expect((await api(s.owner, "GET", `/reminders?eventId=${s.eventId}`)).body.reminders).toEqual([]);
    expect((await api(s.viewer, "GET", `/reminders?eventId=${s.eventId}`)).body.reminders.length).toBe(1);
    // There is no way to name another user.
    expect((await callTool(viewer, "create_reminder", { eventId: s.eventId, offsetMinutes: 60, userId: s.owner.userId })).isError).toBe(false);
    expect((db.query("SELECT COUNT(*) AS count FROM reminders WHERE user_id = ?").get(s.owner.userId) as { count: number }).count).toBe(0);

    expect((await callTool(stranger, "create_reminder", { eventId: s.eventId, offsetMinutes: 30 })).value.code).toBe("NOT_FOUND");
    expect((await callTool(viewer, "create_reminder", { eventId: s.privateEventId, offsetMinutes: 30 })).value.code).toBe("NOT_FOUND");
    expect((await callTool(viewer, "create_reminder", { eventId: s.eventId, offsetMinutes: 30, tz: "Europe/Berlin" })).value.code).toBe("REMINDER_EXISTS");
    expect((await callTool(viewer, "create_reminder", { eventId: s.eventId, title: "Both", fireAt: "2030-01-01T09:00" })).value.code).toBe("INVALID");
    const standalone = await callTool(stranger, "create_reminder", { title: "Call mum", fireAt: "2030-01-01T09:00", tz: "Europe/London" });
    expect(standalone.value).toMatchObject({ nextFireAt: "2030-01-01T09:00:00.000Z", eventId: null });
    expect((await callTool(stranger, "create_reminder", { title: "Past", fireAt: "2020-01-01T09:00" })).value.code).toBe("INVALID");
  });

  test("writes are audited with via and keyId; reads are not audited", async () => {
    const user = await createUser("Calendar audit");
    const key = makeKey(user, ["calendar:write"]);
    const calendarId = (await callTool(key, "list_calendars")).value.calendars[0].id as string;
    const before = (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?").get(user.userId) as { count: number }).count;
    await callTool(key, "list_events", { from: "2026-10-01", to: "2026-10-02" });
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?").get(user.userId) as { count: number }).count).toBe(before);
    const { eventId } = (await callTool(key, "create_event", { calendarId, title: "Audited", allDay: true, start: `${Y + 1}-01-01` })).value;
    await callTool(key, "update_event", { eventId, baseRevision: 1, title: "Audited again" });
    await callTool(key, "create_reminder", { eventId, offsetMinutes: -540 });
    expect(auditRows(user.userId, "event.create").at(-1)).toMatchObject({ eventId, via: "mcp", keyId: key.id });
    expect(auditRows(user.userId, "event.update").at(-1)).toMatchObject({ eventId, via: "mcp", keyId: key.id });
    expect(auditRows(user.userId, "reminder.create").at(-1)).toMatchObject({ eventId, via: "mcp", keyId: key.id });
    // App writes carry no MCP marker.
    await api(user, "PATCH", `/events/${eventId}`, { title: "By hand", revision: 2 });
    expect(auditRows(user.userId, "event.update").at(-1)).not.toHaveProperty("via");
  });

  test("daily caps: 200 event writes and 100 reminders per key, and per-user limits", async () => {
    const user = await createUser("Calendar caps");
    const key = makeKey(user, ["calendar:write"]);
    const calendarId = (await callTool(key, "list_calendars")).value.calendars[0].id as string;
    expect(MCP_LIMITS.event_write.limit).toBe(200);
    expect(MCP_LIMITS.reminder_write.limit).toBe(100);
    for (let index = 0; index < 200; index += 1) expect(consumeMcpLimits({ keyId: key.id }, ["event_write"])).toBe(0);
    const capped = await callTool(key, "create_event", { calendarId, title: "One too many", allDay: true, start: `${Y + 1}-02-01` });
    expect(capped.value.code).toBe("RATE_LIMITED");
    // Reminders have their own bucket.
    const { eventId } = (await callTool(makeKey(user, ["calendar:write"], "Second"), "create_event", { calendarId, title: "Other key", allDay: true, start: `${Y + 1}-02-01` })).value;
    expect((await callTool(key, "create_reminder", { eventId, offsetMinutes: 60 })).isError).toBe(false);
    for (let index = 0; index < 99; index += 1) consumeMcpLimits({ keyId: key.id }, ["reminder_write"]);
    expect((await callTool(key, "create_reminder", { eventId, offsetMinutes: 120 })).value.code).toBe("RATE_LIMITED");
    // Reads still work.
    expect((await callTool(key, "list_calendars")).isError).toBe(false);
    // Per user, across keys.
    for (let index = 0; index < 400; index += 1) consumeMcpLimits({ keyId: `other-${index}`, userId: user.userId }, ["event_write"]);
    expect((await callTool(makeKey(user, ["calendar:write"], "Fresh"), "create_event", { calendarId, title: "User cap", allDay: true, start: `${Y + 1}-02-02` })).value.code).toBe("RATE_LIMITED");
  });

  test("links come back as titles, or restricted when the user cannot open them", async () => {
    const owner = await createUser("Calendar links owner");
    const member = await createUser("Calendar links member");
    const calendarId = (await api(owner, "POST", "/calendars", { name: "Linked" })).body.calendar.id as string;
    expect((await api(owner, "PUT", `/calendars/${calendarId}/sharing`, { visibility: "selected", shareRole: "viewer", userIds: [member.userId] })).status).toBe(200);
    const eventId = (await api(owner, "POST", `/calendars/${calendarId}/events`, { title: "With note", allDay: true, startDate: "2026-10-01", endDate: "2026-10-02" })).body.event.id as string;
    const noteId = (await api(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Private note title", revision: 1 });
    await api(owner, "POST", `/notes/${noteId}/publish`);
    expect((await api(owner, "POST", `/events/${eventId}/links`, { targetType: "note", targetId: noteId })).status).toBe(201);
    // A link title needs the target module's read scope too (T203).
    const ownerView = await callTool(makeKey(owner, ["calendar:read", "notes:read"]), "get_event", { eventId });
    expect(ownerView.value.links).toEqual([{ targetType: "note", targetId: noteId, title: "Private note title" }]);
    expect((await callTool(makeKey(owner, ["calendar:read"]), "get_event", { eventId })).value.links).toEqual([{ targetType: "note", restricted: true }]);
    const memberView = await callTool(makeKey(member, ["calendar:read"]), "get_event", { eventId });
    expect(memberView.value.links).toEqual([{ targetType: "note", restricted: true }]);
    expect(JSON.stringify(memberView.value)).not.toContain("Private note title");
  });
});
