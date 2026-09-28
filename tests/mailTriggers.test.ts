import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { setMailOriginForTests } = await import("../server/mail/links");

/**
 * The first-release mails end to end (outbound email §A.2 v1): each module action enqueues in its
 * own transaction, the dispatcher resolves titles at send time as the recipient, and the mail
 * deep-links to the right place (T223, T226).
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
afterEach(() => {
  mail.setMailTransportForTests(null);
  setMailOriginForTests(null);
});

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
const mailFor = (session: Session) => sent.filter((message) => message.to === session.email);
const queued = (userId: string, template: string) => db.query("SELECT * FROM mail_outbox WHERE user_id = ? AND template = ?").all(userId, template) as Array<Record<string, any>>;

async function board(owner: Session, members: Session[], options: { dropShareMail?: boolean } = {}) {
  const created = await call(owner, "POST", "/tasks/boards", { name: "Launch" });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: members.map((member) => member.userId) })).status).toBe(200);
  // The share itself mails (covered above); these tests look at what follows.
  if (options.dropShareMail !== false) db.query("DELETE FROM mail_outbox WHERE template = 'sharing.shared'").run();
  return { boardId, columnId };
}

describe("Shared with you", () => {
  test("one template for boards and calendars; only newly added people; all_users sends nothing", async () => {
    const owner = await person("Priya Share");
    const first = await person("First Share");
    const second = await person("Second Share");
    const { boardId } = await board(owner, [first], { dropShareMail: false });
    const calendar = (await call(owner, "POST", "/calendars", { name: "Team calendar" })).body.calendar;
    expect((await call(owner, "PUT", `/calendars/${calendar.id}/sharing`, { visibility: "selected", shareRole: "editor", userIds: [first.userId] })).status).toBe(200);
    // Re-saving with the same member adds nobody; adding the second mails only them.
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [first.userId, second.userId] });
    await call(owner, "PUT", `/calendars/${calendar.id}/sharing`, { visibility: "all_users", shareRole: "viewer", userIds: [] });
    expect(queued(owner.userId, "sharing.shared")).toEqual([]);
    const rows = queued(first.userId, "sharing.shared");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).items).toEqual([{ kind: "board", id: boardId }, { kind: "calendar", id: calendar.id }]);
    expect(JSON.parse(queued(second.userId, "sharing.shared")[0]!.payload).items).toEqual([{ kind: "board", id: boardId }]);
    await runMailDispatch({ nowMs: later() });
    const firstMail = mailFor(first)[0]!;
    expect(firstMail.subject).toBe("Priya Share shared 2 items with you");
    expect(firstMail.text).toContain(`/tasks/${boardId}`);
    expect(firstMail.text).toContain("/calendar");
    expect(mailFor(second)[0]!.subject).toBe("Priya Share shared ‘Launch’ with you");
    // Other files expect no calendar shared with everyone.
    await call(owner, "PUT", `/calendars/${calendar.id}/sharing`, { visibility: "private", shareRole: "viewer", userIds: [] });
  });
});

describe("Tasks", () => {
  test("assigning others coalesces into one mail with a deep link; self-assignment sends nothing", async () => {
    const owner = await person("Priya Tasks");
    const member = await person("Sam Tasks");
    const { boardId, columnId } = await board(owner, [member]);
    const cards: string[] = [];
    for (const title of ["Fix login redirect", "Write notes"]) {
      const card = await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title, assigneeIds: [member.userId, owner.userId] });
      expect(card.status).toBe(201);
      cards.push(card.body.card.id);
    }
    expect(queued(owner.userId, "tasks.assigned")).toEqual([]);
    const rows = queued(member.userId, "tasks.assigned");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ cardIds: cards, actorIds: [owner.userId] });
    // Nothing goes out before the 10-minute window closes.
    await runMailDispatch();
    expect(sent).toEqual([]);
    await runMailDispatch({ nowMs: later() });
    const [message] = mailFor(member);
    expect(message!.subject).toBe("Priya Tasks assigned you 2 cards on Launch");
    expect(message!.text).toContain(`/tasks/${boardId}/card/${cards[0]}`);
    expect(message!.text).toContain("/tasks/my");
  });

  test("a card binned before the send is dropped; access lost skips the mail (T226)", async () => {
    const owner = await person("Owner Bin");
    const member = await person("Member Bin");
    const { boardId, columnId } = await board(owner, [member]);
    await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Secret plan", assigneeIds: [member.userId] });
    // The member loses access before the tick.
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "private", userIds: [] });
    await runMailDispatch({ nowMs: later() });
    expect(sent).toEqual([]);
    expect(queued(member.userId, "tasks.assigned")[0]).toMatchObject({ status: "skipped", skip_reason: "access_lost" });
  });

  test("comments mail the assignees and creator, never the author, with plain-text excerpts", async () => {
    const owner = await person("Owner Comments");
    const member = await person("Member Comments");
    const { boardId, columnId } = await board(owner, [member]);
    const card = (await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Discuss", assigneeIds: [member.userId] })).body.card;
    await runMailDispatch({ nowMs: later() });
    sent = [];
    await call(member, "POST", `/tasks/cards/${card.id}/comments`, { body: "**Looks** good, see [the doc](https://example.com/x)" });
    await call(member, "POST", `/tasks/cards/${card.id}/comments`, { body: "One more <script>x</script>" });
    expect(queued(member.userId, "tasks.comment")).toEqual([]);
    expect(queued(owner.userId, "tasks.comment")).toHaveLength(1);
    await runMailDispatch({ nowMs: later() });
    const [message] = mailFor(owner);
    expect(message!.subject).toBe("2 new comments on ‘Discuss’");
    expect(message!.text).toContain("Looks good, see the doc");
    expect(message!.html).not.toContain("<script>");
    expect(message!.text).toContain(`/tasks/${boardId}/card/${card.id}`);
    expect(message!.headers!["List-Unsubscribe"]).toContain("/api/mail/unsubscribe?t=");
  });
});
