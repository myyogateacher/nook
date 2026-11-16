import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { mentionMarkdown } = await import("../shared/itemActivity");
const { createCheckin } = await import("../server/checkins/service");
const { answerRound, driveCheckin } = await import("../server/checkins/rounds");
const { createContactBook, upsertContactByEmail } = await import("../server/people/contacts");
const { registeredMailTemplate } = await import("../server/mail/registry");
const { mentionTemplate, mergeMentionPayload, MENTION_MAIL_TEMPLATE } = await import("../server/activity/mentionMail");
const { readEmailPrefs } = await import("../server/mail/prefs");
const mail = await import("../server/mail");

/**
 * @mentions, phases B and C (docs/plan/MENTIONS.md §11, D1328, D1335, T662): notes notify on publish
 * (only new mentions), standup answers, contact notes, goal check-in notes, and the `mentions` email
 * (ids only, re-read as the recipient, skipped when they can no longer open the item).
 */

let author: Session;
let reader: Session;
let outsider: Session;

const api = async (session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await request(path, { method, headers, ...(body === undefined && method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }, session);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, any>, etag: response.headers.get("etag") };
};
const mentionRows = (userId: string, kind?: string) => db.query(`SELECT title, item_kind, item_id, module FROM notifications WHERE user_id = ? AND topic = 'core.mention'${kind ? " AND item_kind = ?" : ""} ORDER BY created_at`)
  .all(...(kind ? [userId, kind] : [userId])) as Array<{ title: string; item_kind: string; item_id: string; module: string }>;
const mails = (userId: string) => db.query("SELECT payload, category, status FROM mail_outbox WHERE user_id = ? AND template = ?").all(userId, MENTION_MAIL_TEMPLATE) as Array<{ payload: string; category: string; status: string }>;
const readAll = (session: Session) => api(session, "POST", "/notifications/read", { all: true });
const mention = (session: Session, name: string) => mentionMarkdown(name, session.userId);

beforeAll(async () => {
  author = await createUser("PhaseB Author");
  reader = await createUser("PhaseB Reader");
  outsider = await createUser("PhaseB Outsider");
  // Mail on (a fake transport), so the mentions email is queued.
  mail.setMailTransportForTests(async () => ({ id: "msg_1" }));
});
afterAll(() => { mail.setMailTransportForTests(null); });

describe("notes (D1335)", () => {
  test("publishing notifies the note's readers once; draft saves and republishing the same mentions notify no one", async () => {
    const id = (await api(author, "POST", "/notes", { folderId: null })).body.note.id as string;
    const sheet = await api(author, "GET", `/notes/${id}/access`);
    expect((await api(author, "PUT", `/notes/${id}/access`, { audience: "selected", people: [{ id: reader.userId, level: "view" }], groups: [] }, { "If-Match": sheet.body.etag })).status).toBe(200);
    const text = `Plan with ${mention(reader, "PhaseB Reader")} and ${mention(outsider, "PhaseB Outsider")}`;
    expect((await api(author, "PUT", `/notes/${id}/draft`, { markdown: text, revision: 1 })).status).toBe(200);
    // A draft save notifies no one.
    expect(mentionRows(reader.userId, "note")).toEqual([]);
    expect((await api(author, "POST", `/notes/${id}/publish`, {})).status).toBe(200);
    expect(mentionRows(reader.userId, "note")).toEqual([expect.objectContaining({ title: "PhaseB Author mentioned you in a note", module: "notes", item_id: id })]);
    expect(mentionRows(outsider.userId, "note")).toEqual([]);
    await readAll(reader);
    // A second version with the same mention: nothing new.
    const note = (await api(author, "GET", `/notes/${id}`)).body.note;
    expect((await api(author, "PUT", `/notes/${id}/draft`, { markdown: `${text}, edited`, revision: note.draft_revision ?? null })).status).toBe(200);
    expect((await api(author, "POST", `/notes/${id}/publish`, {})).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'core.mention' AND item_kind = 'note' AND read_at IS NULL").get(reader.userId)).toEqual({ n: 0 });
  });
});

describe("standup answers", () => {
  test("a named answer notifies the round's readers; an edit only new mentions; an anonymous answer never", () => {
    const t0 = Date.parse("2026-05-04T08:00:00Z");
    const row = createCheckin(author.userId, { template: "standup", schedule: { weekdays: [1, 2, 3, 4, 5], at: "09:00", zoneMode: "fixed", tz: "UTC" }, participants: { people: [author.userId, reader.userId], groups: [] } }, t0);
    driveCheckin(row.id, Date.parse("2026-05-04T09:00:00Z"));
    const round = db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ?").get(row.id) as { id: string };
    answerRound(author.userId, round.id, { answers: { done: `Paired with ${mention(reader, "PhaseB Reader")}`, plan: `Ask ${mention(outsider, "PhaseB Outsider")}` }, nowMs: Date.parse("2026-05-04T09:10:00Z") });
    expect(mentionRows(reader.userId, "checkin_round")).toEqual([expect.objectContaining({ title: "PhaseB Author mentioned you in a standup answer", module: "checkins", item_id: round.id })]);
    expect(mentionRows(outsider.userId, "checkin_round")).toEqual([]);
    db.query("UPDATE notifications SET read_at = ? WHERE user_id = ?").run(new Date().toISOString(), reader.userId);
    answerRound(author.userId, round.id, { answers: { done: `Paired with ${mention(reader, "PhaseB Reader")} again`, plan: "Docs" }, nowMs: Date.parse("2026-05-04T09:20:00Z") });
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND item_kind = 'checkin_round' AND read_at IS NULL").get(reader.userId)).toEqual({ n: 0 });
  });
});

describe("contact notes and goal check-ins", () => {
  test("a note on a contact notifies people who can read its book; editing adds only new ones", async () => {
    const bookId = createContactBook({ ownerId: author.userId, name: "PhaseB book" });
    const contact = db.transaction(() => upsertContactByEmail(bookId, { email: "phaseb@acme.test", name: "Pat" }, { source: "manual", actor: author.userId }))();
    const sheet = await api(author, "GET", `/access/contact_book/${bookId}`);
    expect((await api(author, "PUT", `/access/contact_book/${bookId}`, { audience: "selected", people: [{ id: reader.userId, level: "view" }] }, { "If-Match": sheet.etag! })).status).toBe(200);
    const logged = await api(author, "POST", "/crm/interactions", { kind: "note", body: `Call ${mention(reader, "PhaseB Reader")} and ${mention(outsider, "PhaseB Outsider")}`, subjects: [{ kind: "contact", id: contact.contactId }] });
    expect(logged.status).toBe(201);
    expect(mentionRows(reader.userId, "contact")).toEqual([expect.objectContaining({ title: "PhaseB Author mentioned you in a note on a contact", module: "crm" })]);
    expect(mentionRows(outsider.userId, "contact")).toEqual([]);
  });

  test("a goal check-in note notifies the goal's readers", async () => {
    const goal = await api(author, "POST", "/goals", { title: "PhaseB goal", visibility: "all_users", shareRole: "view" });
    expect(goal.status).toBe(201);
    const checked = await api(author, "POST", `/goals/${goal.body.goal.id}/checkins`, { health: "on_track", note: `Thanks ${mention(reader, "PhaseB Reader")}` });
    expect(checked.status).toBe(201);
    expect(mentionRows(reader.userId, "goal")).toEqual([expect.objectContaining({ title: "PhaseB Author mentioned you in a goal check-in", module: "goals" })]);
  });
});

describe("the mentions email (D1328, T662)", () => {
  test("queued per recipient in the mentions category, ids only, grouped; resolved as the recipient", () => {
    const queued = mails(reader.userId);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((row) => row.category === "mentions")).toBe(true);
    // One grouped mail per person while it waits; ids only, never the text.
    expect(queued.filter((row) => row.status === "queued")).toHaveLength(1);
    const payload = JSON.parse(queued.find((row) => row.status === "queued")!.payload) as { mentions: Array<Record<string, string>> };
    expect(payload.mentions.length).toBeGreaterThan(1);
    expect(Object.keys(payload.mentions[0]!).sort()).toEqual(["actorId", "id", "kind", "where"]);
    expect(JSON.stringify(payload)).not.toContain("PhaseB Reader");
    expect(mails(outsider.userId)).toEqual([]);
    // Resolved as the recipient: of these items the outsider can open only the all-users goal, so the
    // note, the round, and the contact (titles, authors, kind words) are left out of their copy.
    const resolve = registeredMailTemplate(MENTION_MAIL_TEMPLATE)!.resolve!;
    const recipient = (session: Session) => ({ id: session.userId, email: "x@example.test", displayName: "x", role: "member", tz: "UTC" });
    const asOutsider = resolve(payload, recipient(outsider), Date.now()) as { data: { mentions: Array<{ kindLabel: string }> } };
    expect(asOutsider.data.mentions.map((row) => row.kindLabel)).toEqual(["Goal"]);
    expect(resolve({ mentions: payload.mentions.filter((item) => item.kind !== "goal") }, recipient(outsider), Date.now())).toEqual({ skip: "access_lost" });
    const data = (resolve(payload, recipient(reader), Date.now()) as { data: { mentions: Array<{ actor: string; title: string; href: string }>; total: number } }).data;
    expect(data.total).toBe(payload.mentions.length);
    expect(data.mentions.every((row) => row.actor === "PhaseB Author" && row.href.startsWith("http"))).toBe(true);
    expect(readEmailPrefs(reader.userId).categories.mentions).toBe(true);
  });

  test("merging keeps one row per item and author, newest last, at most 20; the mail renders without the text", () => {
    const ref = (n: number) => ({ kind: "card", id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, actorId: author.userId, where: "on a card" });
    const merged = mergeMentionPayload({ mentions: [ref(1), ref(2)] }, { mentions: [ref(1)] });
    expect(merged.mentions.map((item) => item.id)).toEqual([ref(2).id, ref(1).id]);
    expect(mergeMentionPayload({ mentions: Array.from({ length: 25 }, (_, n) => ref(n)) }, { mentions: [] }).mentions).toHaveLength(20);
    expect(mergeMentionPayload({ mentions: [{ kind: "nope", id: "x", actorId: "y", where: "z" }] }, {}).mentions).toEqual([]);
    const rendered = mentionTemplate.render(mentionTemplate.fixture(), { instanceName: "Nook", tz: "UTC", unsubscribeHref: "https://nook.example/u" });
    expect(rendered.subject).toBe("2 new mentions of you");
    expect(rendered.text).toContain("Priya Shah mentioned you on a card");
    expect(rendered.html).toContain("Fix login redirect");
  });
});
