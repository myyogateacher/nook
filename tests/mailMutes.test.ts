import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");

/**
 * Per-board and per-calendar "Mute emails" (outbound email §B.1 D249): the caller's own switch on
 * items they can read, listed in Settings → Email, honoured when a mail is queued and again when it
 * is sent. Security mail and the caller's own reminders are never muted.
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
const later = () => Date.now() + 11 * 60_000;

beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
});
afterEach(() => mail.setMailTransportForTests(null));

async function person(label: string) {
  const session = await createUser(label);
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
async function sharedBoard(owner: Session, member: Session, name = "Muted board") {
  const created = await call(owner, "POST", "/tasks/boards", { name });
  const boardId = created.body.board.id as string;
  await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] });
  db.query("DELETE FROM mail_outbox").run();
  return { boardId, columnId: created.body.columns[0].id as string };
}

describe("mute routes", () => {
  test("mute, list, and unmute a readable board and calendar; unreadable or unknown targets are 404", async () => {
    const owner = await person("Mute Owner");
    const member = await person("Mute Member");
    const stranger = await person("Mute Stranger");
    const { boardId } = await sharedBoard(owner, member);
    const calendar = (await call(owner, "POST", "/calendars", { name: "Muted calendar" })).body.calendar;
    await call(owner, "PUT", `/calendars/${calendar.id}/sharing`, { visibility: "selected", shareRole: "viewer", userIds: [member.userId] });
    expect(await call(member, "PUT", `/mail/mutes/board/${boardId}`)).toEqual({ status: 200, body: { muted: true } });
    expect((await call(member, "PUT", `/mail/mutes/board/${boardId}`)).status).toBe(200);
    expect((await call(member, "PUT", `/mail/mutes/calendar/${calendar.id}`)).status).toBe(200);
    const listed = (await call(member, "GET", "/mail/mutes")).body.mutes as Array<{ targetType: string; targetId: string; name: string }>;
    expect(listed.map((mute) => [mute.targetType, mute.name]).sort()).toEqual([["board", "Muted board"], ["calendar", "Muted calendar"]]);
    expect((await call(stranger, "PUT", `/mail/mutes/board/${boardId}`)).status).toBe(404);
    expect((await call(member, "PUT", `/mail/mutes/note/${boardId}`)).status).toBe(404);
    expect((await call(member, "PUT", "/mail/mutes/board/not-an-id")).status).toBe(404);
    expect(await call(member, "DELETE", `/mail/mutes/calendar/${calendar.id}`)).toEqual({ status: 200, body: { muted: false } });
    expect((await call(member, "GET", "/mail/mutes")).body.mutes).toHaveLength(1);
    // Losing access hides the mute from the list (it no longer names anything the caller can open).
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "private", userIds: [] });
    expect((await call(member, "GET", "/mail/mutes")).body.mutes).toEqual([]);
    await call(owner, "PUT", `/calendars/${calendar.id}/sharing`, { visibility: "private", shareRole: "viewer", userIds: [] });
  });
});

describe("mutes honoured by the triggers", () => {
  test("a muted board sends no assigned-to-you or comment mail; other boards still do", async () => {
    const owner = await person("Mute Assigner");
    const member = await person("Mute Assignee");
    const muted = await sharedBoard(owner, member, "Quiet board");
    const loud = await sharedBoard(owner, member, "Loud board");
    await call(member, "PUT", `/mail/mutes/board/${muted.boardId}`);
    const card = (await call(owner, "POST", `/tasks/boards/${muted.boardId}/cards`, { columnId: muted.columnId, title: "Hidden", assigneeIds: [member.userId] })).body.card;
    await call(owner, "POST", `/tasks/cards/${card.id}/comments`, { body: "A comment" });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ?").get(member.userId)).toEqual({ count: 0 });
    await call(owner, "POST", `/tasks/boards/${loud.boardId}/cards`, { columnId: loud.columnId, title: "Visible", assigneeIds: [member.userId] });
    await runMailDispatch({ nowMs: later() });
    expect(sent.filter((message) => message.to === member.email).map((message) => message.subject)).toEqual(["Mute Assigner assigned you ‘Visible’"]);
  });

  test("a mute set while a mail waits still holds at send time", async () => {
    const owner = await person("Mute Late Owner");
    const member = await person("Mute Late Member");
    const { boardId, columnId } = await sharedBoard(owner, member, "Late mute");
    await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Queued", assigneeIds: [member.userId] });
    await call(member, "PUT", `/mail/mutes/board/${boardId}`);
    await runMailDispatch({ nowMs: later() });
    expect(sent).toEqual([]);
    expect(db.query("SELECT status, skip_reason FROM mail_outbox WHERE user_id = ?").get(member.userId)).toEqual({ status: "skipped", skip_reason: "muted" });
  });
});
