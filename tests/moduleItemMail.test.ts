import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { registeredMailTemplate } = await import("../server/mail/registry");
const { fireFollowup } = await import("../server/crm/interactions");
const { readEmailPrefs, prefsAllow } = await import("../server/mail/prefs");
const mail = await import("../server/mail");

/**
 * The Time, Goals, and Contacts emails (D1370–D1371): each event that notifies also queues the module's
 * email in its own category (ids only), and the mail is read again as the recipient when it is sent:
 * someone who lost access gets nothing (`access_lost`), and the module's switch turns it off.
 */

type Json = Record<string, any>;
async function api(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { status: response.status, body: json };
}
async function share(session: Session, kind: string, id: string, people: Array<{ id: string; level: string }>) {
  const sheet = await request(`/access/${kind}/${id}`, {}, session);
  const etag = sheet.headers.get("ETag")!;
  const put = await api(session, "PUT", `/access/${kind}/${id}`, { audience: people.length ? "selected" : "private", people, groups: [] }, { "If-Match": etag });
  expect(put.status).toBe(200);
}

const mails = (userId: string, template: string) => (db.query("SELECT payload, category FROM mail_outbox WHERE user_id = ? AND template = ? ORDER BY created_at")
  .all(userId, template) as Array<{ payload: string; category: string }>).map((row) => ({ category: row.category, payload: JSON.parse(row.payload) as Json }));
const recipient = (session: Session) => ({ id: session.userId, email: "x@example.test", displayName: "x", role: "member", tz: "UTC" });
const resolveAs = (template: string, payload: Json, session: Session) => registeredMailTemplate(template)!.resolve!(payload, recipient(session), Date.now()) as Json;

let owner: Session;
let member: Session;
let outsider: Session;

beforeAll(async () => {
  owner = await createUser("Mail owner");
  member = await createUser("Mail member");
  outsider = await createUser("Mail outsider");
  mail.setMailTransportForTests(async () => ({ id: "msg_1" }));
});
afterAll(() => { mail.setMailTransportForTests(null); });

describe("the templates", () => {
  test("Time, Goals, and Contacts register an activity template in their own category, and render their fixture", () => {
    for (const [name, category] of [["time.update", "time"], ["goals.update", "goals"], ["crm.update", "crm"]] as const) {
      const template = registeredMailTemplate(name)!;
      expect(template.class).toBe("activity");
      expect(template.category).toBe(category);
      const rendered = template.render(template.fixture() as never, { instanceName: "Nook", tz: "UTC", unsubscribeHref: "https://nook.example/u" });
      expect(rendered.subject.length).toBeGreaterThan(5);
      expect(rendered.html).toContain(template.fixture().item);
    }
  });

  test("the module's switch turns its mail off (the dispatcher's prefsAllow)", () => {
    const prefs = readEmailPrefs(member.userId);
    expect(prefsAllow(prefs, "activity", "time")).toBe(true);
    expect(prefsAllow({ ...prefs, categories: { ...prefs.categories, time: false } }, "activity", "time")).toBe(false);
  });
});

describe("Time (D1370)", () => {
  test("a submitted week mails the managers, a decision mails the person; resolved as the recipient", async () => {
    const project = (await api(owner, "POST", "/time/projects", { name: "Mail project" })).body.project.id as string;
    await share(owner, "time_project", project, [{ id: member.userId, level: "edit" }]);
    const day = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    expect((await api(member, "POST", "/time/entries", { startedAt: `${day}T10:00:00.000Z`, duration: 3600, projectId: project, tz: "UTC" })).status).toBe(201);
    const weekStart = (await api(member, "GET", `/time/timesheet?week=${day}&tz=UTC`)).body.weekStart as string;
    expect((await api(member, "POST", "/time/approvals", { projectId: project, weekStart })).status).toBe(201);
    const submitted = mails(owner.userId, "time.update").filter((row) => row.payload.topic === "time.approval");
    expect(submitted).toEqual([{ category: "time", payload: { topic: "time.approval", kind: "time_project", id: project, actorId: member.userId, weekStart } }]);
    const data = resolveAs("time.update", submitted[0]!.payload, owner).data;
    expect(data.title).toBe(`Mail member submitted the week of ${weekStart}`);
    expect(data.item).toBe("Mail project");
    expect(data.href).toContain("?tab=approvals");
    // Someone who cannot open the project gets nothing.
    expect(resolveAs("time.update", submitted[0]!.payload, outsider)).toEqual({ skip: "access_lost" });

    const approval = (await api(owner, "GET", "/time/approvals?status=submitted")).body.approvals.find((row: Json) => row.weekStart === weekStart) as Json;
    expect((await api(owner, "PATCH", `/time/approvals/${approval.id}`, { decision: "reject", note: "Missing Friday" })).status).toBe(200);
    const decided = mails(member.userId, "time.update");
    expect(decided.map((row) => row.payload)).toEqual([{ topic: "time.approval_decided", kind: "time_project", id: project, actorId: owner.userId, weekStart, decision: "reject" }]);
    // The note is never mailed: ids and enums only.
    expect(JSON.stringify(decided)).not.toContain("Missing Friday");
    const returned = resolveAs("time.update", decided[0]!.payload, member).data;
    expect(returned.title).toBe(`Your week of ${weekStart} was returned`);
    expect(returned.href).toContain(`/time/timesheet?week=${weekStart}`);
    // Unshared: the decision mail is skipped at send time.
    await share(owner, "time_project", project, []);
    expect(resolveAs("time.update", decided[0]!.payload, member)).toEqual({ skip: "access_lost" });
  });

  test("a budget alert mails the managers once per crossing", async () => {
    const project = (await api(owner, "POST", "/time/projects", { name: "Mail budget", budget: { kind: "hours", value: 1 } })).body.project.id as string;
    expect((await api(owner, "POST", "/time/entries", { startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), duration: 3000, projectId: project })).status).toBe(201);
    const alerts = mails(owner.userId, "time.update").filter((row) => row.payload.topic === "time.budget" && row.payload.id === project);
    expect(alerts.map((row) => row.payload.threshold)).toEqual([80]);
    expect(resolveAs("time.update", alerts[0]!.payload, owner).data.title).toBe("A project has used 80% of its budget");
  });
});

describe("Goals (D1370, D1371)", () => {
  test("made owner or contributor, and at risk, mail the people who can open the goal", async () => {
    const created = await api(owner, "POST", "/goals", { title: "Mail goal", ownerId: member.userId, contributorIds: [outsider.userId], visibility: "all_users" });
    expect(created.status).toBe(201);
    const goalId = created.body.goal.id as string;
    expect(mails(member.userId, "goals.update").map((row) => row.payload)).toEqual([{ topic: "goals.assigned", kind: "goal", id: goalId, actorId: owner.userId, role: "owner" }]);
    expect(mails(outsider.userId, "goals.update").map((row) => row.payload.role)).toEqual(["contributor"]);
    // The bell row for the new owner, never the person who did it.
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'goals.assigned' AND item_id = ?").get(member.userId, goalId)).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'goals.assigned' AND item_id = ?").get(owner.userId, goalId)).toEqual({ n: 0 });
    expect(resolveAs("goals.update", mails(member.userId, "goals.update")[0]!.payload, member).data.title).toBe("You own a goal now");

    const revision = (await api(member, "GET", `/goals/${goalId}`)).body.goal.revision;
    expect((await api(member, "PATCH", `/goals/${goalId}`, { health: "at_risk", expectedRevision: revision })).status).toBe(200);
    const risk = mails(outsider.userId, "goals.update").filter((row) => row.payload.topic === "goals.health_changed");
    expect(risk).toHaveLength(1);
    expect(resolveAs("goals.update", risk[0]!.payload, outsider).data.title).toBe("A goal is at risk");
    // The goal made private: the contributor still reads it (contributors are members); a stranger does not.
    const stranger = await createUser("Mail stranger");
    db.query("UPDATE goals SET visibility = 'private' WHERE id = ?").run(goalId);
    expect(resolveAs("goals.update", risk[0]!.payload, stranger)).toEqual({ skip: "access_lost" });
    // Recovered before the mail went: nothing to say.
    db.query("UPDATE goals SET visibility = 'all_users', health = 'on_track' WHERE id = ?").run(goalId);
    expect(resolveAs("goals.update", risk[0]!.payload, outsider)).toEqual({ skip: "empty" });
  });
});

describe("Contacts (D1370)", () => {
  test("deal owner, won, and a follow-up due mail the person; a reader who lost the book gets nothing", async () => {
    const bookId = (await api(owner, "POST", "/crm/books", { name: "Mail book" })).body.book.id as string;
    await share(owner, "contact_book", bookId, [{ id: member.userId, level: "edit" }]);
    const deal = (await api(owner, "POST", "/crm/deals", { bookId, title: "Mail deal", ownerId: member.userId })).body.deal;
    expect(deal).toBeTruthy();
    expect(mails(member.userId, "crm.update").map((row) => row.payload)).toEqual([{ topic: "crm.deal_assigned", kind: "deal", id: deal.id, actorId: owner.userId }]);
    expect(resolveAs("crm.update", mails(member.userId, "crm.update")[0]!.payload, member).data.title).toBe("You own a deal now");
    expect((await api(owner, "PATCH", `/crm/deals/${deal.id}`, { stageName: "won" })).status).toBe(200);
    const won = mails(member.userId, "crm.update").filter((row) => row.payload.topic === "crm.deal_won");
    expect(won).toHaveLength(1);
    expect(resolveAs("crm.update", won[0]!.payload, member).data.title).toBe("A deal you own was won");

    const contact = (await api(member, "POST", "/crm/contacts", { bookId, name: "Mail contact" })).body.contact;
    const followup = (await api(member, "POST", "/crm/followups", { subject: { kind: "contact", id: contact.id }, dueAt: new Date(Date.now() + 86_400_000).toISOString(), note: "Private note" })).body.followup;
    fireFollowup(followup.id);
    const due = mails(member.userId, "crm.update").filter((row) => row.payload.topic === "crm.followup_due");
    expect(due.map((row) => row.payload)).toEqual([{ topic: "crm.followup_due", kind: "contact", id: contact.id, followupId: followup.id }]);
    expect(JSON.stringify(due)).not.toContain("Private note");
    expect(resolveAs("crm.update", due[0]!.payload, member).data.title).toBe("Follow up on a contact");

    await share(owner, "contact_book", bookId, []);
    expect(resolveAs("crm.update", due[0]!.payload, member)).toEqual({ skip: "access_lost" });
    expect(resolveAs("crm.update", won[0]!.payload, member)).toEqual({ skip: "access_lost" });
  });
});
