import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { scheduleBinExpiry, resetBinScanForTests } = await import("../server/mail/laterMail");

/**
 * Sprint started/completed (#20, D235, D236) and items leaving the Bin (#29, D243): both categories
 * are off by default; sprint mail goes to board readers with cards in the sprint, never the actor,
 * not for a muted board; the Bin mail comes at most once a week and lists what is left at send time.
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
const later = () => Date.now() + 11 * 60_000;
const CATEGORIES = { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true };

beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  resetBinScanForTests();
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
});
afterEach(() => mail.setMailTransportForTests(null));
// The suite shares one database: Bin clean-up left on, with items about to leave the Bin, would mail
// these people from every later file's dispatch tick.
const people: string[] = [];
afterAll(() => {
  db.query("UPDATE email_prefs SET categories = json_set(categories, '$.bin', json('false')) WHERE user_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(people));
});

async function person(label: string) {
  const session = await createUser(label);
  people.push(session.userId);
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
const turnOn = (session: Session, category: "sprints" | "bin") =>
  call(session, "PUT", "/mail/settings", { enabled: true, categories: { ...CATEGORIES, [category]: true }, digest: "off", digestLocalTime: "08:00", quietHours: null, tz: "UTC", revision: 0 });

describe("sprint mail", () => {
  test("started and completed mail assignees with cards in the sprint, with their own counts; off by default", async () => {
    const owner = await person("Sprint Owner");
    const member = await person("Sprint Member");
    const idle = await person("Sprint Idle");
    const defaults = await person("Sprint Defaults");
    const created = await call(owner, "POST", "/tasks/boards", { name: "Launch" });
    const boardId = created.body.board.id as string;
    const [todo, , done] = created.body.columns as Array<{ id: string }>;
    await call(owner, "PATCH", `/tasks/boards/${boardId}`, { structure: { levels: [{ name: "Task", plural: "Tasks" }], workLevel: 0, sprints: true } });
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId, idle.userId, defaults.userId] });
    for (const session of [member, idle, owner]) await turnOn(session, "sprints");
    const sprint = (await call(owner, "POST", `/tasks/boards/${boardId}/sprints`, { name: "Sprint 12", startOn: "2026-09-28", endOn: "2026-10-09" })).body.sprint;
    for (const [title, column, assignees] of [["One", todo, [member.userId, defaults.userId]], ["Two", done, [member.userId, owner.userId]], ["Three", todo, []]] as const) {
      await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: column!.id, title, assigneeIds: assignees, sprintId: sprint.id });
    }
    db.query("DELETE FROM mail_outbox").run();
    expect((await call(owner, "PATCH", `/tasks/sprints/${sprint.id}`, { state: "active" })).status).toBe(200);
    // Only people with cards in it: the member (and the defaults user, whose category is off); never the owner-actor.
    expect((db.query("SELECT user_id FROM mail_outbox WHERE template = 'tasks.sprint'").all() as Array<{ user_id: string }>).map((row) => row.user_id).sort())
      .toEqual([member.userId, defaults.userId].sort());
    await runMailDispatch({ nowMs: later() });
    const started = sent.find((message) => message.to === member.email)!;
    expect(started.subject).toBe("Sprint 12 started on Launch");
    expect(started.text).toContain("2 cards assigned to you");
    expect(started.text).toContain(`/tasks/${boardId}/sprints`);
    expect(sent.some((message) => message.to === defaults.email)).toBe(false);
    expect(db.query("SELECT skip_reason FROM mail_outbox WHERE user_id = ?").get(defaults.userId)).toEqual({ skip_reason: "prefs_off" });

    expect((await call(owner, "POST", `/tasks/sprints/${sprint.id}/complete`, { carryTo: "backlog" })).status).toBe(200);
    await runMailDispatch({ nowMs: later() });
    const completed = sent.filter((message) => message.to === member.email).at(-1)!;
    expect(completed.subject).toBe("Sprint 12 is complete on Launch");
    expect(completed.text).toContain("1 done · 2 carried over");
    expect(completed.text).toContain("1 done · 1 carried over");
  });

  test("a muted board sends no sprint mail", async () => {
    const owner = await person("Sprint Mute Owner");
    const member = await person("Sprint Mute Member");
    const created = await call(owner, "POST", "/tasks/boards", { name: "Muted sprints" });
    const boardId = created.body.board.id as string;
    await call(owner, "PATCH", `/tasks/boards/${boardId}`, { structure: { levels: [{ name: "Task", plural: "Tasks" }], workLevel: 0, sprints: true } });
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] });
    await turnOn(member, "sprints");
    await call(member, "PUT", `/mail/mutes/board/${boardId}`);
    const sprint = (await call(owner, "POST", `/tasks/boards/${boardId}/sprints`, { name: "S1" })).body.sprint;
    await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: created.body.columns[0].id, title: "Mine", assigneeIds: [member.userId], sprintId: sprint.id });
    db.query("DELETE FROM mail_outbox").run();
    await call(owner, "PATCH", `/tasks/sprints/${sprint.id}`, { state: "active" });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE template = 'tasks.sprint'").get()).toEqual({ count: 0 });
  });
});

describe("items leaving the Bin", () => {
  test("one mail a week at most, only with Bin clean-up on, listing what is left at send time", async () => {
    const user = await person("Bin Mail");
    const other = await person("Bin Mail Off");
    for (const session of [user, other]) {
      const created = await call(session, "POST", "/tasks/boards", { name: "Bin board" });
      const card = (await call(session, "POST", `/tasks/boards/${created.body.board.id}/cards`, { columnId: created.body.columns[0].id, title: "Old parser" })).body.card;
      expect((await call(session, "DELETE", `/tasks/cards/${card.id}`)).status).toBe(200);
    }
    // The cards purge in two days.
    db.query("UPDATE cards SET purge_after = ? WHERE deleted_at IS NOT NULL AND title = 'Old parser'").run(new Date(Date.now() + 2 * 86_400_000).toISOString());
    await turnOn(user, "bin");
    expect(scheduleBinExpiry(Date.now(), true)).toBe(1);
    // Hourly at most, and weekly per person.
    expect(scheduleBinExpiry(Date.now() + 60_000)).toBe(0);
    expect(scheduleBinExpiry(Date.now() + 2 * 3_600_000, true)).toBe(0);
    await runMailDispatch({ nowMs: Date.now() + 1000 });
    const message = sent.find((item) => item.to === user.email)!;
    expect(message.subject).toBe("1 item leaves your Bin within 3 days");
    expect(message.text).toContain("Old parser");
    expect(message.text).toContain("/bin");
    expect(sent.some((item) => item.to === other.email)).toBe(false);
    // A week later, with items still due to leave, it may mail again.
    expect(scheduleBinExpiry(Date.now() + 8 * 86_400_000, true)).toBe(1);
  });
});
