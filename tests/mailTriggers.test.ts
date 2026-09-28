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

describe("Security and proposals", () => {
  test("role changes coalesce and a toggle back sends nothing; block, unblock, sign-out mail the target", async () => {
    const admin = await person("Priya Admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const target = await person("Target Security");
    const toggle = await createUser("Toggle Security");
    expect((await call(admin, "PUT", `/team/${target.userId}/role`, { role: "viewer", expectedRole: "member" })).status).toBe(200);
    expect((await call(admin, "PUT", `/team/${target.userId}/role`, { role: "guest", expectedRole: "viewer" })).status).toBe(200);
    await call(admin, "PUT", `/team/${toggle.userId}/role`, { role: "viewer", expectedRole: "member" });
    await call(admin, "PUT", `/team/${toggle.userId}/role`, { role: "member", expectedRole: "viewer" });
    expect(queued(target.userId, "security.role_changed")).toHaveLength(1);
    await runMailDispatch({ nowMs: later() });
    expect(mailFor(target).map((message) => message.subject)).toEqual(["Your Nook role is now Guest"]);
    expect(mailFor(target)[0]!.text).toContain("Member → Guest");
    expect(mailFor(target)[0]!.headers).toBeUndefined();
    expect(queued(toggle.userId, "security.role_changed")[0]).toMatchObject({ status: "skipped", skip_reason: "empty" });

    sent = [];
    expect((await call(admin, "POST", `/team/${target.userId}/block`, { reason: "Private admin reason" })).status).toBe(200);
    await runMailDispatch();
    const blocked = mailFor(target)[0]!;
    expect(blocked.subject).toBe("Your Nook account was blocked");
    expect(blocked.text + blocked.html).not.toContain("Private admin reason");
    await call(admin, "POST", `/team/${target.userId}/unblock`, {});
    await call(admin, "POST", `/team/${target.userId}/sessions/revoke`, {});
    await runMailDispatch();
    expect(mailFor(target).map((message) => message.subject)).toEqual(["Your Nook account was blocked", "Your Nook account was unblocked", "You were signed out of Nook everywhere"]);
  });

  test("a new MCP key mails its owner the key name and scopes", async () => {
    const owner = await person("Key Owner");
    const created = await call(owner, "POST", "/mcp/keys", { name: "laptop", password: owner.password, scopes: ["notes:read", "tasks:write"] });
    expect(created.status).toBe(201);
    await runMailDispatch();
    const message = mailFor(owner)[0]!;
    expect(message.subject).toBe("New API key “laptop” on your Nook account");
    expect(message.text).toContain("Notes: read · Tasks: read, write");
    expect(message.text).not.toContain(created.body.key.token);
    expect(message.text).toContain("/settings/mcp");
  });

  test("proposals coalesce for an hour and carry key names and counts only (T233)", async () => {
    const { notifyProposals } = await import("../server/inbox/service");
    const owner = await person("Proposal Owner");
    const keyId = crypto.randomUUID();
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at) VALUES (?, ?, 'laptop', 'mynotes_abcdefgh', ?, '[\"inbox:write\"]', ?)")
      .run(keyId, owner.userId, crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"), new Date().toISOString());
    for (let index = 0; index < 3; index += 1) {
      db.query("INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, rationale, payload, created_at, expires_at) VALUES (?, ?, ?, 'laptop', 'card_comment', 'card', ?, 'Click here to reset your password', 'Agent rationale', '{}', ?, ?)")
        .run(crypto.randomUUID(), owner.userId, keyId, crypto.randomUUID(), new Date().toISOString(), new Date(Date.now() + 3 * 86_400_000).toISOString());
      notifyProposals(owner.userId, keyId, 1);
    }
    expect(queued(owner.userId, "inbox.proposals")).toHaveLength(1);
    await runMailDispatch({ nowMs: Date.now() + 30 * 60_000 });
    expect(sent).toEqual([]);
    await runMailDispatch({ nowMs: Date.now() + 61 * 60_000 });
    const message = mailFor(owner)[0]!;
    expect(message.subject).toBe("Key “laptop” suggested 3 changes");
    expect(message.html + message.text).not.toMatch(/reset your password|Agent rationale/);
    expect(message.text).toContain("/inbox");
    // A new burst right after waits for the 3-hour gap (D240).
    notifyProposals(owner.userId, keyId, 1);
    const next = queued(owner.userId, "inbox.proposals").find((row) => row.status === "queued")!;
    expect(Date.parse(next.not_before) - Date.now()).toBeGreaterThan(2.9 * 3_600_000);
  });
});
