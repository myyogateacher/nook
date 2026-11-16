import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { progressSource } = await import("../server/goalsProgress");
const { DRIVE_PURPOSE, WATCHDOG_PURPOSE, strandedCheckins } = await import("../server/checkins/rounds");

/**
 * Audit 2 fixes for Standups and Contacts (docs/plan/WORKSPACE_MODULES.md §D.9, D1160–D1167): the
 * standup watchdog, blocked participants, import undo's companies, pipeline stage removal moves,
 * merge moving time entries, restoring a company whose domain was taken, one-currency progress, and
 * board drops on a filtered board.
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json };
};

let owner: Session;
let member: Session;

beforeAll(async () => {
  owner = await createUser("Audit2 owner");
  member = await createUser("Audit2 member");
});

const driveSchedule = (checkinId: string) => db.query("SELECT id, next_fire_at FROM schedules WHERE owner_kind = 'checkin' AND owner_id = ? AND purpose = ?").get(checkinId, DRIVE_PURPOSE) as { id: string; next_fire_at: string | null } | null;

describe("standups", () => {
  test("CC1: a drive occurrence lost to a crash is picked up by the watchdog (D1160)", async () => {
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "Watchdog standup", participants: { people: [owner.userId], groups: [] } });
    expect(created.status).toBe(201);
    const checkinId = created.body.checkin.id as string;
    const schedule = driveSchedule(checkinId)!;
    expect(schedule.next_fire_at).not.toBeNull();
    expect(db.query("SELECT 1 FROM schedules WHERE purpose = ?").get(WATCHDOG_PURPOSE)).not.toBeNull();
    // A crash after the dispatcher recorded the fire row: the occurrence never runs, the {once} rule has no next fire.
    db.query("INSERT INTO schedule_fires (schedule_id, fire_at, status, started_at) VALUES (?, ?, 'running', ?)").run(schedule.id, schedule.next_fire_at, new Date().toISOString());
    const fireMs = Date.parse(schedule.next_fire_at!);
    db.query("UPDATE schedules SET next_fire_at = ? WHERE purpose = ?").run(new Date(fireMs + 3_600_000).toISOString(), WATCHDOG_PURPOSE);
    await runScheduleTick({ nowMs: fireMs + 1000 });
    expect(driveSchedule(checkinId)!.next_fire_at).toBeNull();
    expect(strandedCheckins()).toContain(checkinId);
    // The watchdog's next run drives the standup: its round opens and its drive schedule is armed again.
    db.query("UPDATE schedules SET next_fire_at = ? WHERE purpose = ?").run(new Date(fireMs + 2000).toISOString(), WATCHDOG_PURPOSE);
    await runScheduleTick({ nowMs: fireMs + 3000 });
    expect(strandedCheckins()).not.toContain(checkinId);
    expect(driveSchedule(checkinId)!.next_fire_at).not.toBeNull();
    expect(db.query("SELECT 1 FROM checkin_rounds WHERE checkin_id = ?").get(checkinId)).not.toBeNull();
  });

  test("CC6: blocked participants are not asked, counted, or a reason the list can't be saved (D1161)", async () => {
    const gone = await createUser("Audit2 gone");
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "Blocked standup", participants: { people: [owner.userId, gone.userId], groups: [] } });
    const checkinId = created.body.checkin.id as string;
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), gone.userId);
    expect((await api(owner, "POST", `/checkins/${checkinId}/rounds`)).status).toBe(201);
    const round = db.query("SELECT id, participant_count FROM checkin_rounds WHERE checkin_id = ?").get(checkinId) as { id: string; participant_count: number };
    expect(round.participant_count).toBe(1);
    expect(db.query("SELECT 1 FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(round.id, gone.userId)).toBeNull();
    const detail = await api(owner, "GET", `/checkins/${checkinId}`);
    expect(detail.body.checkin.people.map((person: Json) => person.id)).not.toContain(gone.userId);
    // A stale list that still names the blocked person saves (they are dropped); a new blocked person is still refused.
    const saved = await api(owner, "PUT", `/checkins/${checkinId}/participants`, { people: [owner.userId, gone.userId, member.userId], groups: [] });
    expect(saved.status).toBe(200);
    expect(db.query("SELECT 1 FROM checkin_participants WHERE checkin_id = ? AND user_id = ?").get(checkinId, gone.userId)).toBeNull();
    const other = await createUser("Audit2 other gone");
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), other.userId);
    expect((await api(owner, "PUT", `/checkins/${checkinId}/participants`, { people: [owner.userId, other.userId], groups: [] })).status).toBe(400);
  });
});

describe("contacts", () => {
  let bookId: string;
  beforeAll(async () => {
    bookId = (await api(owner, "POST", "/crm/books", { name: "Audit2 book" })).body.book.id;
  });

  test("CC2: undoing a contact import deletes only the companies it made (D1162)", async () => {
    const mine = (await api(owner, "POST", "/crm/import", { bookId, entity: "contact", csv: "Name,Email,Company\nAna,ana@example.org,Umbrella\n" })).body.preview.jobId;
    expect((await api(owner, "POST", `/crm/import/${mine}/commit`, {})).status).toBe(200);
    const others = (await api(owner, "POST", "/crm/import", { bookId, entity: "company", csv: "Name,Domain\nGlobex,globex.test\nInitech,initech.test\n" })).body.preview.jobId;
    expect((await api(owner, "POST", `/crm/import/${others}/commit`, {})).status).toBe(200);
    const names = () => (db.query("SELECT name FROM companies WHERE book_id = ? ORDER BY name").all(bookId) as Array<{ name: string }>).map((row) => row.name);
    expect(names()).toEqual(["Globex", "Initech", "Umbrella"]);
    expect((await api(owner, "POST", `/crm/import/${mine}/undo`)).status).toBe(200);
    expect(names()).toEqual(["Globex", "Initech"]);
  });

  test("CC3: removing a stage moves its deals as a stage change does (D1163)", async () => {
    const pipeline = (await api(owner, "GET", `/crm/pipelines?book=${bookId}`)).body.pipelines[0];
    const deal = (await api(owner, "POST", "/crm/deals", { bookId, pipelineId: pipeline.id, title: "Moved by removal", value: 1000 })).body.deal;
    const lost = pipeline.stages.find((stage: Json) => stage.kind === "lost");
    const won = pipeline.stages.find((stage: Json) => stage.kind === "won");
    // First onto the lost stage (with a reason), then that stage is removed and its deals go to Won.
    expect((await api(owner, "PATCH", `/crm/deals/${deal.id}`, { stageId: lost.id, lostReason: "Budget" })).status).toBe(200);
    const stages = pipeline.stages.filter((stage: Json) => stage.id !== lost.id).map((stage: Json) => ({ id: stage.id, name: stage.name, kind: stage.kind, probability: stage.probability }));
    stages.push({ name: "Lost again", kind: "lost", probability: 0 });
    expect((await api(owner, "PATCH", `/crm/pipelines/${pipeline.id}`, { stages, moveDealsTo: won.id })).status).toBe(200);
    const row = db.query("SELECT stage_id, status, closed_at, lost_reason FROM deals WHERE id = ?").get(deal.id) as Json;
    expect(row).toMatchObject({ stage_id: won.id, status: "won", lost_reason: null });
    expect(row.closed_at).not.toBeNull();
    const changes = db.query("SELECT from_stage_id, to_stage_id FROM deal_stage_changes WHERE deal_id = ? ORDER BY at, rowid").all(deal.id) as Json[];
    expect(changes.at(-1)).toEqual({ from_stage_id: lost.id, to_stage_id: won.id });
    expect(db.query("SELECT 1 FROM item_activity WHERE item_kind = 'deal' AND item_id = ? AND kind = 'crm_stage' AND payload LIKE ?").get(deal.id, `%${won.id}%`)).not.toBeNull();
  });

  test("CC4: merging contacts and companies moves their time entries (D1164)", async () => {
    const a = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Merge source", email: "merge-source@example.org" })).body.contact;
    const b = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Merge target", email: "merge-target@example.org" })).body.contact;
    const c1 = (await api(owner, "POST", "/crm/companies", { bookId, name: "Merge co source" })).body.company;
    const c2 = (await api(owner, "POST", "/crm/companies", { bookId, name: "Merge co target" })).body.company;
    const at = new Date().toISOString();
    const entry = (kind: string, id: string) => {
      const entryId = crypto.randomUUID();
      db.query("INSERT INTO time_entries (id, user_id, started_at, ended_at, duration_s, target_kind, target_id, created_at, updated_at) VALUES (?, ?, ?, ?, 60, ?, ?, ?, ?)").run(entryId, owner.userId, at, at, kind, id, at, at);
      return entryId;
    };
    const contactEntry = entry("contact", a.id);
    const companyEntry = entry("company", c1.id);
    expect((await api(owner, "POST", `/crm/contacts/${a.id}/merge`, { intoId: b.id })).status).toBe(200);
    expect((await api(owner, "POST", `/crm/companies/${c1.id}/merge`, { intoId: c2.id })).status).toBe(200);
    expect((db.query("SELECT target_id FROM time_entries WHERE id = ?").get(contactEntry) as Json).target_id).toBe(b.id);
    expect((db.query("SELECT target_id FROM time_entries WHERE id = ?").get(companyEntry) as Json).target_id).toBe(c2.id);
  });

  test("CC5: restoring a company whose domain another took answers a conflict, not a 500 (D1165)", async () => {
    const first = (await api(owner, "POST", "/crm/companies", { bookId, name: "Acme", domain: "acme-audit2.test" })).body.company;
    expect((await api(owner, "DELETE", `/crm/companies/${first.id}`)).status).toBe(200);
    expect((await api(owner, "POST", "/crm/companies", { bookId, name: "Acme Two", domain: "acme-audit2.test" })).status).toBe(201);
    const restored = await api(owner, "POST", `/bin/company/${first.id}/restore`);
    expect(restored.status).toBe(409);
    expect(restored.body.code).toBe("NAME_TAKEN");
    expect(restored.body.error).toContain("acme-audit2.test");
    expect((db.query("SELECT deleted_at FROM companies WHERE id = ?").get(first.id) as Json).deleted_at).not.toBeNull();
  });

  test("CC7: value progress adds up one currency (D1166)", async () => {
    const book = (await api(owner, "POST", "/crm/books", { name: "Audit2 currencies" })).body.book.id;
    const pipeline = (await api(owner, "GET", `/crm/pipelines?book=${book}`)).body.pipelines[0];
    const won = pipeline.stages.find((stage: Json) => stage.kind === "won");
    await api(owner, "PATCH", `/crm/pipelines/${pipeline.id}`, { currency: "USD" });
    for (const [currency, value] of [["USD", 1000], ["EUR", 5000]] as const) {
      const deal = (await api(owner, "POST", "/crm/deals", { bookId: book, pipelineId: pipeline.id, title: `${currency} deal`, value, currency })).body.deal;
      await api(owner, "PATCH", `/crm/deals/${deal.id}`, { stageId: won.id });
      await api(owner, "POST", "/crm/deals", { bookId: book, pipelineId: pipeline.id, title: `${currency} open`, value, currency });
    }
    const context = { ownerId: owner.userId, period: null, tz: "UTC", nowMs: Date.now() };
    expect(await progressSource("crm_won_value")!.compute({ pipelineId: pipeline.id }, context)).toEqual({ value: 1000, detail: "USD" });
    expect(await progressSource("crm_pipeline_value")!.compute({ pipelineId: pipeline.id }, context)).toEqual({ value: 1000, detail: "USD" });
    expect(await progressSource("crm_won_value")!.compute({ pipelineId: pipeline.id, currency: "EUR" }, context)).toEqual({ value: 5000, detail: "EUR" });
  });

  test("CC8: a drop on a filtered board lands between its visible neighbours (D1167)", async () => {
    const pipeline = (await api(owner, "GET", `/crm/pipelines?book=${bookId}`)).body.pipelines[0];
    const stage = pipeline.stages[0];
    await api(owner, "PUT", `/crm/books/${bookId}/members`, { members: [{ userId: member.userId, level: "edit" }] });
    const make = async (title: string, ownerId: string) => (await api(owner, "POST", "/crm/deals", { bookId, pipelineId: pipeline.id, stageId: stage.id, title, ownerId })).body.deal.id as string;
    // Stage order: mine1, theirs1, theirs2, mine2. "Mine" shows mine1, mine2; dragging mine2 above mine1 lands it first.
    const ids = { mine1: await make("Mine 1", owner.userId), theirs1: await make("Theirs 1", member.userId), theirs2: await make("Theirs 2", member.userId), mine2: await make("Mine 2", owner.userId) };
    const order = () => (db.query("SELECT id FROM deals WHERE stage_id = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY position, id").all(stage.id, JSON.stringify(Object.values(ids))) as Array<{ id: string }>).map((row) => row.id);
    expect(order()).toEqual([ids.mine1, ids.theirs1, ids.theirs2, ids.mine2]);
    expect((await api(owner, "PATCH", `/crm/deals/${ids.mine2}`, { stageId: stage.id, afterId: null, beforeId: ids.mine1 })).status).toBe(200);
    expect(order()).toEqual([ids.mine2, ids.mine1, ids.theirs1, ids.theirs2]);
    // Dropped right after mine1 (the visible list's last card): lands after mine1, not at the stage's index 1 among all.
    expect((await api(owner, "PATCH", `/crm/deals/${ids.mine2}`, { stageId: stage.id, afterId: ids.mine1, beforeId: null })).status).toBe(200);
    expect(order()).toEqual([ids.mine1, ids.mine2, ids.theirs1, ids.theirs2]);
    // The index form (MCP, older clients) still works.
    expect((await api(owner, "PATCH", `/crm/deals/${ids.mine2}`, { position: 3 })).status).toBe(200);
    expect(order().at(-1)).toBe(ids.mine2);
  });
});
