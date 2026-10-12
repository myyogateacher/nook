import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { addCalendarMember, api, calendarWithEvent, contentStatus, documentRow, link, shareCalendar, unlink, upload, uploadAttachment, userWithRole } from "./support/attachments";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetFeedLimits } = await import("../server/calendar/feeds");
const { resetEventCreateLimit } = await import("../server/calendar/service");
const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { utcToZoned } = await import("../server/calendar/recurrence");
type Grant = import("../server/keyGrants").Grant;

/**
 * Uploads everywhere U1: files on calendar events. Access follows the event and its calendar through
 * the U0 host rule (T340); files belong to the whole series; the Bin hides them and a purge bins the
 * uploads nothing else uses; feeds (busy or full) and mail never carry them (D407, T343); MCP reports
 * them and attaches uploads made for attaching only (D402).
 */

beforeEach(() => {
  resetMcpLimits();
  resetFeedLimits();
  resetEventCreateLimit();
});

const event = (session: Session, eventId: string) => api(session, "GET", `/events/${eventId}`);
const names = (body: Record<string, any>) => (body.attachments as Array<{ name?: string }>).map((item) => item.name);

describe("event payloads", () => {
  test("open carries the files and the cap; the range list carries a count for every occurrence of the series", async () => {
    const owner = await createUser("U1 payload owner");
    const calendar = (await api(owner, "POST", "/calendars", { name: "Payloads" })).body.calendar.id as string;
    const weekly = await api(owner, "POST", `/calendars/${calendar}/events`, { title: "Standup", allDay: false, startLocal: "2026-11-02T09:00", tz: "UTC", durationMinutes: 15, repeat: { freq: "weekly", interval: 1, count: 4 } });
    const eventId = weekly.body.event.id as string;
    expect(weekly.body).toMatchObject({ attachments: [], attachmentLimit: 20 });
    const agenda = await uploadAttachment(owner, "agenda.md", "# Agenda");
    expect((await link(owner, "event", eventId, { documentId: agenda })).status).toBe(201);

    const opened = await event(owner, eventId);
    expect(opened.body.attachments).toEqual([expect.objectContaining({ documentId: agenda, name: "agenda.md", removed: false, isOwner: true, inAttachmentsFolder: true })]);
    const range = await api(owner, "GET", `/events?from=2026-11-01&to=2026-12-01&tz=UTC`);
    const mine = (range.body.occurrences as Array<{ eventId: string; attachmentCount: number }>).filter((item) => item.eventId === eventId);
    expect(mine.map((item) => item.attachmentCount)).toEqual([1, 1, 1, 1]);

    // Skipping a date and undoing a change leave the series' files alone.
    const skipped = await api(owner, "POST", `/events/${eventId}/exdates`, { date: "2026-11-09", revision: opened.body.event.revision });
    expect(names(skipped.body)).toEqual(["agenda.md"]);
    const undone = await api(owner, "POST", `/events/${eventId}/undo`, { revision: skipped.body.event.revision });
    expect(names(undone.body)).toEqual(["agenda.md"]);

    // A file in its owner's Bin is listed as removed and no longer counted.
    db.query("UPDATE documents SET deleted_at = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), agenda);
    expect((await event(owner, eventId)).body.attachments).toEqual([expect.objectContaining({ documentId: agenda, removed: true })]);
    const after = await api(owner, "GET", `/events?from=2026-11-01&to=2026-12-01&tz=UTC`);
    expect((after.body.occurrences as Array<{ eventId: string; attachmentCount: number }>).find((item) => item.eventId === eventId)!.attachmentCount).toBe(0);
  });

  test("levels: viewers read, editors link their own files, managers remove any, editors not others'; the cap is 20", async () => {
    const owner = await createUser("U1 level owner");
    const editor = await createUser("U1 level editor");
    const viewer = await createUser("U1 level viewer");
    const teamViewer = await userWithRole("U1 level team viewer", "viewer");
    const stranger = await createUser("U1 level stranger");
    const { calendarId, eventId } = await calendarWithEvent(owner, "Levels");
    await shareCalendar(owner, calendarId, "selected", [editor.userId, viewer.userId, teamViewer.userId], "viewer");
    addCalendarMember(calendarId, editor.userId, "edit");

    const ownersFile = await uploadAttachment(owner, "owners.pdf", "%PDF-1.4\n");
    const editorsFile = await uploadAttachment(editor, "editors.txt");
    expect((await link(owner, "event", eventId, { documentId: ownersFile })).status).toBe(201);
    expect((await link(editor, "event", eventId, { documentId: editorsFile })).status).toBe(201);
    for (const session of [viewer, teamViewer]) {
      expect(names((await event(session, eventId)).body)).toEqual(["owners.pdf", "editors.txt"]);
      expect(await contentStatus(session, editorsFile)).toBe(200);
      // Someone else's file, on an event they only view: refused before the file is even looked at.
      const own = await uploadAttachment(owner, `for-${session.userId}.txt`);
      expect((await link(session, "event", eventId, { documentId: own })).status).toBe(403);
    }
    expect((await event(stranger, eventId)).status).toBe(404);
    expect(await contentStatus(stranger, ownersFile)).toBe(404);
    // A viewer's own upload: READ_ONLY on the event.
    const viewersFile = await uploadAttachment(viewer, "viewer.txt");
    expect((await link(viewer, "event", eventId, { documentId: viewersFile })).body.code).toBe("READ_ONLY");

    // Editors remove their own file, never the owner's; the owner (a manager) removes anyone's.
    expect((await unlink(editor, "event", eventId, ownersFile)).status).toBe(403);
    expect((await unlink(viewer, "event", eventId, editorsFile)).status).toBe(403);
    const removed = await unlink(owner, "event", eventId, editorsFile);
    expect(removed.body).toEqual({ ok: true, documentBinned: true });
    expect(documentRow(editorsFile)!.deleted_at).not.toBeNull();

    // Up to 20 files per event (Q11).
    for (let index = 1; index < 20; index += 1) expect((await link(owner, "event", eventId, { documentId: await uploadAttachment(owner, `file-${index}.txt`) })).status).toBe(201);
    const over = await link(owner, "event", eventId, { documentId: await uploadAttachment(owner, "file-21.txt") });
    expect(over).toMatchObject({ status: 409, body: { code: "LIMIT_REACHED", limit: 20 } });
    expect((await event(owner, eventId)).body.attachments).toHaveLength(20);
  });
});

test("a file's owner who can now only view the event still removes their own file (U0 review M1)", async () => {
  const owner = await createUser("U1 m1 owner");
  const former = await createUser("U1 m1 former editor");
  const { calendarId, eventId } = await calendarWithEvent(owner, "M1");
  await shareCalendar(owner, calendarId, "selected", [former.userId], "viewer");
  addCalendarMember(calendarId, former.userId, "edit");
  const theirs = await uploadAttachment(former, "their-notes.txt");
  const owners = await uploadAttachment(owner, "owners-notes.txt");
  expect((await link(former, "event", eventId, { documentId: theirs })).status).toBe(201);
  expect((await link(owner, "event", eventId, { documentId: owners })).status).toBe(201);
  addCalendarMember(calendarId, former.userId, "view");
  expect((await event(former, eventId)).body.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: theirs, isOwner: true })]));
  expect((await unlink(former, "event", eventId, owners)).status).toBe(403);
  expect((await unlink(former, "event", eventId, theirs)).status).toBe(200);
  expect(names((await event(owner, eventId)).body)).toEqual(["owners-notes.txt"]);
});

describe("Bin and purge", () => {
  test("a binned event hides its files; restore brings them back; purge bins the uploads only", async () => {
    const owner = await createUser("U1 bin owner");
    const viewer = await createUser("U1 bin viewer");
    const { calendarId, eventId } = await calendarWithEvent(owner, "Bin");
    await shareCalendar(owner, calendarId, "selected", [viewer.userId], "viewer");
    const uploaded = await uploadAttachment(owner, "slides.txt");
    const filesItem = (await upload(owner, "budget.csv", "a,b\n1,2\n")).id;
    expect((await link(owner, "event", eventId, { documentId: uploaded })).status).toBe(201);
    expect((await link(owner, "event", eventId, { documentId: filesItem })).body.code).toBe("CONFIRM_REQUIRED");
    expect((await link(owner, "event", eventId, { documentId: filesItem, confirmed: true })).status).toBe(201);
    expect(await contentStatus(viewer, filesItem)).toBe(200);

    expect((await api(owner, "DELETE", `/events/${eventId}`)).status).toBe(200);
    for (const id of [uploaded, filesItem]) expect(await contentStatus(viewer, id)).toBe(404);
    expect((await api(viewer, "GET", `/attachments/event/${eventId}`)).status).toBe(404);
    // Binning keeps the links and the files.
    expect(documentRow(uploaded)!.deleted_at).toBeNull();
    expect((await api(owner, "POST", `/bin/event/${eventId}/restore`)).status).toBe(200);
    expect(await contentStatus(viewer, uploaded)).toBe(200);
    expect(names((await event(viewer, eventId)).body)).toEqual(["slides.txt", "budget.csv"]);

    // Purged: the links go with the row; the upload moves to the Bin, the Files item stays.
    expect((await api(owner, "DELETE", `/events/${eventId}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/event/${eventId}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE host_id = ?").get(eventId)).toEqual({ count: 0 });
    expect(documentRow(uploaded)!.deleted_at).not.toBeNull();
    expect(documentRow(filesItem)!.deleted_at).toBeNull();
    expect(await contentStatus(viewer, filesItem)).toBe(404);
  });

  test("purging a calendar purges its events' links and bins their uploads unless something else uses them", async () => {
    const owner = await createUser("U1 calendar purge");
    const first = await calendarWithEvent(owner, "Doomed");
    const second = await calendarWithEvent(owner, "Kept");
    const only = await uploadAttachment(owner, "only.txt");
    const shared = await uploadAttachment(owner, "shared.txt");
    expect((await link(owner, "event", first.eventId, { documentId: only })).status).toBe(201);
    expect((await link(owner, "event", first.eventId, { documentId: shared })).status).toBe(201);
    expect((await link(owner, "event", second.eventId, { documentId: shared })).status).toBe(201);
    expect((await api(owner, "DELETE", `/calendars/${first.calendarId}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/calendar/${first.calendarId}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE host_id = ?").get(first.eventId)).toEqual({ count: 0 });
    expect(documentRow(only)!.deleted_at).not.toBeNull();
    expect(documentRow(shared)!.deleted_at).toBeNull();
    expect(names((await event(owner, second.eventId)).body)).toEqual(["shared.txt"]);
  });
});

describe("public surfaces (D407, T343)", () => {
  test("busy and full feeds carry no file names, links, or ATTACH lines, and a feed token opens no file", async () => {
    const owner = await createUser("U1 feed owner");
    const { calendarId, eventId } = await calendarWithEvent(owner, "Feeds");
    const documentId = await uploadAttachment(owner, "secret-plan.txt", "the plan");
    expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);
    for (const detail of ["busy", "full"] as const) {
      const feed = (await api(owner, "POST", `/calendars/${calendarId}/feeds`, { detail })).body as { token: string };
      const response = await fetch(`${origin}/api/calendars/${calendarId}/feed.ics?token=${encodeURIComponent(feed.token)}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("BEGIN:VEVENT");
      for (const needle of ["secret-plan", "/api/files", documentId, "ATTACH"]) expect({ detail, needle, found: text.includes(needle) }).toEqual({ detail, needle, found: false });
      // The token is for the feed only: it never opens a file, with or without a session.
      const byToken = await fetch(`${origin}/api/files/${documentId}/content?token=${encodeURIComponent(feed.token)}`);
      expect(byToken.status).not.toBe(200);
      const byBearer = await fetch(`${origin}/api/files/${documentId}/content`, { headers: { Authorization: `Bearer ${feed.token}` } });
      expect(byBearer.status).not.toBe(200);
    }
  });

  describe("mail", () => {
    type Sent = Parameters<import("../server/mail").MailTransport>[0];
    let sent: Sent[] = [];
    beforeEach(() => {
      sent = [];
      mail.resetMailLimits();
      db.query("DELETE FROM mail_outbox").run();
      mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
    });
    afterEach(() => mail.setMailTransportForTests(null));

    test("event changed and cancelled mail name no file and link to none", async () => {
      const owner = await createUser("U1 mail owner");
      const reader = await createUser("U1 mail reader");
      db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), reader.userId);
      const calendarId = (await api(owner, "POST", "/calendars", { name: "Mail" })).body.calendar.id as string;
      await shareCalendar(owner, calendarId, "selected", [reader.userId], "editor");
      const start = utcToZoned(Math.ceil((Date.now() + 26 * 3_600_000) / 60_000) * 60_000, "UTC").slice(0, 16);
      const created = (await api(owner, "POST", `/calendars/${calendarId}/events`, { title: "Review", allDay: false, startLocal: start, tz: "UTC", durationMinutes: 30, location: "Room 2" })).body.event as { id: string; revision: number };
      const documentId = await uploadAttachment(owner, "minutes-q4.txt");
      expect((await link(owner, "event", created.id, { documentId })).status).toBe(201);
      expect((await api(reader, "POST", "/reminders", { eventId: created.id, offsetMinutes: 15, tz: "UTC", channels: "push_email" })).status).toBe(201);
      db.query("DELETE FROM mail_outbox").run();
      expect((await api(owner, "PATCH", `/events/${created.id}`, { revision: created.revision, location: "Room 4" })).status).toBe(200);
      expect((await api(owner, "DELETE", `/events/${created.id}`)).status).toBe(200);
      await runMailDispatch({ nowMs: Date.now() + 11 * 60_000 });
      const toReader = sent.filter((message) => message.to === reader.email);
      expect(toReader.length).toBeGreaterThan(0);
      for (const message of toReader) {
        const all = JSON.stringify(message);
        for (const needle of ["minutes-q4", "/api/files", documentId]) expect(all.includes(needle)).toBe(false);
      }
      const payloads = (db.query("SELECT payload FROM mail_outbox").all() as Array<{ payload: string }>).map((row) => row.payload).join("\n");
      expect(payloads).not.toContain(documentId);
    });
  });
});

describe("MCP and REST (D402, D403)", () => {
  const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
  const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });
  const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "U1 agent", surfaces: "both", grants, expiresInDays: 30 });
  async function call(keyId: string, name: string, args: Record<string, unknown>) {
    const result = await invokeMcpToolForTests(name, args, keyId);
    return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
  }

  test("get_event and list_events report files; attach_file_to_event takes the caller's uploads made for attaching only", async () => {
    const owner = await createUser("U1 mcp owner");
    const viewer = await createUser("U1 mcp viewer");
    const first = await calendarWithEvent(owner, "Agent first");
    const second = await calendarWithEvent(owner, "Agent second");
    await shareCalendar(owner, first.calendarId, "selected", [viewer.userId], "viewer");
    const writer = key(owner, [all("calendar", "write")]);

    const upload1 = await uploadAttachment(owner, "notes.md", "# Notes");
    const attached = await call(writer.id, "attach_file_to_event", { eventId: first.eventId, documentId: upload1 });
    expect(attached.isError).toBe(false);
    expect(attached.value).toMatchObject({ eventId: first.eventId, documentId: upload1, alreadyAttached: false, limit: 20, attachments: [{ id: upload1, name: "notes.md", mimeType: expect.any(String), sizeBytes: 7 }] });
    expect((await call(writer.id, "attach_file_to_event", { eventId: first.eventId, documentId: upload1 })).value.alreadyAttached).toBe(true);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'attachment.link' ORDER BY created_at DESC LIMIT 1").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ via: "mcp", keyId: writer.id, hostKind: "event" });

    const reader = key(owner, [all("calendar", "read")]);
    const got = await call(reader.id, "get_event", { eventId: first.eventId });
    expect(got.value.attachments).toEqual([{ id: upload1, name: "notes.md", mimeType: expect.any(String), sizeBytes: 7 }]);
    const listed = await call(reader.id, "list_events", { from: "2026-10-01", to: "2026-11-01" });
    expect((listed.value.occurrences as Array<{ eventId: string; attachmentCount: number }>).find((item) => item.eventId === first.eventId)!.attachmentCount).toBe(1);
    expect((await call(reader.id, "attach_file_to_event", { eventId: first.eventId, documentId: upload1 })).value.code).toBe("SCOPE_REQUIRED");

    // An ordinary Files item is refused (no side-effect sharing); someone else's file is NOT_FOUND.
    const filesItem = (await upload(owner, "private.txt", "keep out")).id;
    expect((await call(writer.id, "attach_file_to_event", { eventId: first.eventId, documentId: filesItem })).value.code).toBe("INVALID");
    const viewersUpload = await uploadAttachment(viewer, "viewer.txt");
    expect((await call(writer.id, "attach_file_to_event", { eventId: first.eventId, documentId: viewersUpload })).value.code).toBe("NOT_FOUND");
    // The viewer's key: READ_ONLY on a calendar they only view.
    const viewerKey = key(viewer, [all("calendar", "write")]);
    expect((await call(viewerKey.id, "attach_file_to_event", { eventId: first.eventId, documentId: viewersUpload })).value.code).toBe("READ_ONLY");
    // A key over the second calendar cannot reach the first.
    const chosen = key(owner, [on("calendar", "write", "calendar", second.calendarId)]);
    const upload2 = await uploadAttachment(owner, "two.txt");
    expect((await call(chosen.id, "attach_file_to_event", { eventId: first.eventId, documentId: upload2 })).value.code).toBe("NOT_FOUND");
    expect((await call(chosen.id, "attach_file_to_event", { eventId: second.eventId, documentId: upload2 })).isError).toBe(false);

    // The cap, over MCP.
    for (let index = 1; index < 20; index += 1) await link(owner, "event", second.eventId, { documentId: await uploadAttachment(owner, `cap-${index}.txt`) });
    const capped = await call(writer.id, "attach_file_to_event", { eventId: second.eventId, documentId: await uploadAttachment(owner, "cap-21.txt") });
    expect(capped.value.code).toBe("LIMIT_REACHED");

    // REST runs the same tool.
    const upload3 = await uploadAttachment(owner, "rest.txt");
    const response = await fetch(`${origin}/api/v1/tools/attach_file_to_event`, { method: "POST", headers: { Authorization: `Bearer ${writer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: first.eventId, documentId: upload3 }) });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("rest.txt");
    expect(await contentStatus(viewer, upload3)).toBe(200);
    void request;
  });
});
