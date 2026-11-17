import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { runDatasetQuery } = await import("../server/datasets/registry");
const { searchScope } = await import("../server/searchRegistry");
const { progressSource } = await import("../server/goalsProgress");
const { binProviders } = await import("../server/bin");
const { upsertContactByEmail } = await import("../server/people/contacts");
const { notifyRotting } = await import("../server/crm/deals");
const { resetCrmExportLimitForTests } = await import("../server/crm/importExport");
const { buildSchema } = await import("../server/collections/schema");

/**
 * Contacts (docs/plan/WORKSPACE_MODULES.md §D.5): books, custom fields through the Collections engine,
 * contacts and companies with dedupe, merge, deals on pipelines with stage moves and board totals,
 * interactions and rotting, follow-ups on the schedules engine, CSV import with undo, export, search,
 * datasets, progress sources, the Bin and purge, access (T560, T562), and the MCP tools with chosen-book keys.
 */

type Json = Record<string, unknown> & { [key: string]: any };
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json, headers: response.headers };
};

let owner: Session;
let other: Session;
let viewer: Session;
let bookId: string;

beforeAll(async () => {
  owner = await createUser("Crm owner");
  other = await createUser("Crm other");
  viewer = await createUser("Crm viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
  const created = await api(owner, "POST", "/crm/books", { name: "Sales" });
  expect(created.status).toBe(201);
  bookId = created.body.book.id;
});

describe("books, fields, contacts, companies", () => {
  test("a new book has a five-stage pipeline and a rotting schedule", async () => {
    const pipelines = await api(owner, "GET", `/crm/pipelines?book=${bookId}`);
    expect(pipelines.body.pipelines).toHaveLength(1);
    expect(pipelines.body.pipelines[0].stages.map((stage: Json) => stage.kind)).toEqual(["open", "open", "open", "won", "lost"]);
    expect(db.query("SELECT 1 FROM schedules WHERE owner_id = ? AND purpose = 'crm.rotting'").get(bookId)).not.toBeNull();
  });

  test("custom fields use the Collections engine (select, person) and validate values", async () => {
    const fields = await api(owner, "PUT", `/crm/books/${bookId}/fields/contact`, { fields: [{ name: "Tier", type: "select", options: [{ label: "Gold" }, { label: "Silver" }] }, { name: "Account manager", type: "person" }] });
    expect(fields.status).toBe(200);
    const [tier, manager] = fields.body.book.fields.contact as Json[];
    expect(tier!.options).toHaveLength(2);
    const bad = await api(owner, "POST", "/crm/contacts", { bookId, name: "Bad Field", custom: { [manager!.id]: crypto.randomUUID() } });
    expect(bad.status).toBe(400);
    const good = await api(owner, "POST", "/crm/contacts", { bookId, name: "Gold Person", custom: { Tier: tier!.options[0].id, [manager!.id]: owner.userId } });
    expect(good.status).toBe(201);
    expect(good.body.contact.custom[tier!.id]).toBe(tier!.options[0].id);
    // Collections offers the relation types too since D1200.
    expect(buildSchema([{ name: "Title", type: "text" }, { name: "Who", type: "person" }]).fields[1]!.type).toBe("person");
  });

  test("contacts dedupe by email, link companies by domain, and keep hand edits from upserts (D806)", async () => {
    const ana = await api(owner, "POST", "/crm/contacts", { bookId, name: "Ana Silva", email: "Ana@Acme.io", phone: "+1 555 0100" });
    expect(ana.status).toBe(201);
    expect(ana.body.contact.companyName).toBe("Acme");
    const dupe = await api(owner, "POST", "/crm/contacts", { bookId, name: "Ana Two", email: "ana@acme.io" });
    expect(dupe).toMatchObject({ status: 409, body: { code: "EXISTS", contactId: ana.body.contact.id } });
    const renamed = await api(owner, "PATCH", `/crm/contacts/${ana.body.contact.shortId}`, { name: "Ana M. Silva", jobTitle: "CTO" });
    expect(renamed.body.contact.displayName).toBe("Ana M. Silva");
    db.transaction(() => upsertContactByEmail(bookId, { email: "ana@acme.io", name: "Somebody Else" }, { source: "booking", actor: null }))();
    const read = await api(owner, "GET", `/crm/contacts/${ana.body.contact.id}`);
    expect(read.body.contact.displayName).toBe("Ana M. Silva");
    expect(read.body.contact.channels.map((channel: Json) => channel.kind).sort()).toEqual(["email", "phone"]);
    const stale = await api(owner, "PATCH", `/crm/contacts/${ana.body.contact.id}`, { jobTitle: "CEO", expectedRevision: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
  });

  test("lists, filters, sorts, and keyset pages", async () => {
    for (const name of ["Zed One", "Yan Two", "Xia Three"]) await api(owner, "POST", "/crm/contacts", { bookId, name, lifecycle: "Lead" });
    const page1 = await api(owner, "GET", `/crm/contacts?book=${bookId}&limit=2&filter=${encodeURIComponent(JSON.stringify([{ field: "lifecycle", op: "eq", value: "lead" }]))}&sort=${encodeURIComponent(JSON.stringify({ field: "name", dir: "desc" }))}`);
    expect(page1.body.items.map((item: Json) => item.displayName)).toEqual(["Zed One", "Yan Two"]);
    const page2 = await api(owner, "GET", `/crm/contacts?book=${bookId}&limit=2&cursor=${page1.body.nextCursor}&filter=${encodeURIComponent(JSON.stringify([{ field: "lifecycle", op: "eq", value: "lead" }]))}&sort=${encodeURIComponent(JSON.stringify({ field: "name", dir: "desc" }))}`);
    expect(page2.body.items.map((item: Json) => item.displayName)).toEqual(["Xia Three"]);
    const list = await api(owner, "POST", "/crm/lists", { bookId, name: "Hot leads", entity: "contact" });
    await api(owner, "POST", `/crm/lists/${list.body.list.id}/members`, { add: [page1.body.items[0].id] });
    const members = await api(owner, "GET", `/crm/contacts?book=${bookId}&list=${list.body.list.shortId}`);
    expect(members.body.items.map((item: Json) => item.displayName)).toEqual(["Zed One"]);
    const view = await api(owner, "POST", "/crm/views", { bookId, entity: "contact", name: "Leads", config: { filters: [{ field: "lifecycle", op: "eq", value: "Lead" }] } });
    expect(view.body.view.mine).toBe(true);
    expect((await api(owner, "GET", `/crm/views?book=${bookId}&entity=contact`)).body.views).toHaveLength(1);
  });

  test("other people and read-only roles: NOT_FOUND without access, READ_ONLY for viewers (T560)", async () => {
    const contacts = await api(owner, "GET", `/crm/contacts?book=${bookId}`);
    const id = contacts.body.items[0].id;
    expect((await api(other, "GET", `/crm/contacts/${id}`)).status).toBe(404);
    expect((await api(other, "GET", `/crm/contacts?book=${bookId}`)).status).toBe(404);
    db.query("UPDATE contact_books SET visibility = 'all_users', share_role = 'edit' WHERE id = ?").run(bookId);
    expect((await api(viewer, "GET", `/crm/contacts/${id}`)).status).toBe(200);
    expect((await api(viewer, "PATCH", `/crm/contacts/${id}`, { jobTitle: "x" })).status).toBe(403);
    db.query("UPDATE contact_books SET visibility = 'private' WHERE id = ?").run(bookId);
  });
});

describe("deals, board, interactions", () => {
  let pipelineId: string;
  let stages: Json[];
  test("deals move between stages, close as won/lost, and the board totals and orders them", async () => {
    const pipelines = await api(owner, "GET", `/crm/pipelines?book=${bookId}`);
    pipelineId = pipelines.body.pipelines[0].id;
    stages = pipelines.body.pipelines[0].stages;
    const a = await api(owner, "POST", "/crm/deals", { bookId, title: "Acme renewal", value: 120000, currency: "USD" });
    const b = await api(owner, "POST", "/crm/deals", { bookId, title: "Beta pilot", value: 50000, currency: "USD", stageId: stages[1]!.id });
    const c = await api(owner, "POST", "/crm/deals", { bookId, title: "Gamma", value: 10000, currency: "USD" });
    expect(a.body.deal.stageName).toBe("Lead");
    // Drag Gamma above Acme in Lead.
    await api(owner, "PATCH", `/crm/deals/${c.body.deal.id}`, { stageId: stages[0]!.id, position: 0 });
    let board = (await api(owner, "GET", `/crm/pipelines/${pipelineId}/board`)).body.board;
    expect(board.columns[0].deals.map((deal: Json) => deal.title)).toEqual(["Gamma", "Acme renewal"]);
    expect(board.columns[0]).toMatchObject({ count: 2, sum: 130000, weighted: 13000 });
    expect(board.columns[1]).toMatchObject({ count: 1, sum: 50000, weighted: 15000 });
    const won = await api(owner, "PATCH", `/crm/deals/${a.body.deal.id}`, { stageName: "won" });
    expect(won.body.deal).toMatchObject({ status: "won", stageName: "Won" });
    expect(won.body.deal.closedAt).not.toBeNull();
    const lost = await api(owner, "PATCH", `/crm/deals/${b.body.deal.id}`, { stageId: stages[4]!.id, lostReason: "Budget" });
    expect(lost.body.deal).toMatchObject({ status: "lost", lostReason: "Budget" });
    expect((db.query("SELECT COUNT(*) AS n FROM deal_stage_changes WHERE deal_id = ?").get(a.body.deal.id) as { n: number }).n).toBe(2);
    board = (await api(owner, "GET", `/crm/pipelines/${pipelineId}/board`)).body.board;
    expect(board.totals).toMatchObject({ count: 1, sum: 10000 });
  });

  test("a stage in use can't be removed without a destination", async () => {
    const kept = stages.filter((stage) => stage.name !== "Lead").map((stage) => ({ id: stage.id, name: stage.name, kind: stage.kind, probability: stage.probability }));
    expect((await api(owner, "PATCH", `/crm/pipelines/${pipelineId}`, { stages: kept })).body.code).toBe("STAGE_IN_USE");
    const moved = await api(owner, "PATCH", `/crm/pipelines/${pipelineId}`, { stages: [{ name: "Intro", kind: "open", probability: 5 }, ...kept], moveDealsTo: stages[1]!.id });
    expect(moved.status).toBe(200);
    expect(moved.body.pipeline.stages.map((stage: Json) => stage.name)).toEqual(["Intro", "Qualified", "Proposal", "Won", "Lost"]);
  });

  test("interactions update last interaction, restart rotting, and show on the timeline; deletes undo", async () => {
    const contact = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Rita Rot", email: "rita@rotco.com" })).body.contact;
    const deal = (await api(owner, "POST", "/crm/deals", { bookId, title: "Rotting deal", contactIds: [contact.id] })).body.deal;
    db.query("UPDATE deals SET last_activity_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 86_400_000).toISOString(), deal.id);
    expect((await api(owner, "GET", `/crm/deals/${deal.id}`)).body.deal.rotting).toBe(true);
    expect(notifyRotting(bookId)).toBeGreaterThanOrEqual(0);
    const logged = await api(owner, "POST", "/crm/interactions", { kind: "call", title: "Intro call", body: "Talked budgets", subjects: [{ kind: "contact", id: contact.id }, { kind: "deal", id: deal.id }] });
    expect(logged.status).toBe(201);
    expect((await api(owner, "GET", `/crm/deals/${deal.id}`)).body.deal.rotting).toBe(false);
    expect((await api(owner, "GET", `/crm/contacts/${contact.id}`)).body.contact.lastInteractionAt).not.toBeNull();
    const timeline = await api(owner, "GET", `/crm/records/contact/${contact.shortId}/timeline`);
    expect(timeline.body.interactions[0].title).toBe("Intro call");
    // The company timeline includes its contacts' interactions.
    const company = await api(owner, "GET", `/crm/records/company/${contact.companyId}/timeline`);
    expect(company.body.interactions).toHaveLength(1);
    const removed = await api(owner, "DELETE", `/crm/interactions/${logged.body.interaction.id}`);
    expect((await api(owner, "GET", `/crm/records/contact/${contact.id}/timeline`)).body.interactions).toHaveLength(0);
    await api(owner, "POST", `/undo/${removed.body.undoTicket}`);
    expect((await api(owner, "GET", `/crm/records/contact/${contact.id}/timeline`)).body.interactions).toHaveLength(1);
  });

  test("rotting notifies the owner once per stage stay", async () => {
    const deal = (await api(owner, "POST", "/crm/deals", { bookId, title: "Quiet deal", ownerId: other.userId })).body.deal;
    db.query("UPDATE contact_books SET visibility = 'all_users', share_role = 'view' WHERE id = ?").run(bookId);
    db.query("UPDATE deals SET last_activity_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString(), deal.id);
    expect(notifyRotting(bookId)).toBe(1);
    expect(notifyRotting(bookId)).toBe(0);
    expect(db.query("SELECT 1 FROM notifications WHERE user_id = ? AND topic = 'crm.deal_rotting'").get(other.userId)).not.toBeNull();
    db.query("UPDATE contact_books SET visibility = 'private' WHERE id = ?").run(bookId);
  });

  test("a follow-up fires an inbox notification through the schedules engine", async () => {
    const contact = (await api(owner, "GET", `/crm/contacts?book=${bookId}&q=rita`)).body.items[0];
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const followup = await api(owner, "POST", "/crm/followups", { subject: { kind: "contact", id: contact.id }, dueAt: due, note: "Send the proposal" });
    expect(followup.status).toBe(201);
    await runScheduleTick({ nowMs: Date.now() + 2 * 3_600_000 });
    const row = db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'crm.followup_due'").get(owner.userId) as { title: string } | null;
    expect(row?.title).toBe("Follow up: Rita Rot");
    const done = await api(owner, "PATCH", `/crm/followups/${followup.body.followup.id}`, { done: true });
    expect(done.body.followup.doneAt).not.toBeNull();
  });
});

describe("merge, import, export", () => {
  test("merging contacts moves deals, interactions, and channels; other books are refused (D965, T562)", async () => {
    const a = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Merge Me", email: "merge1@m.test", phone: "+1 555 0199" })).body.contact;
    const b = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Merge Me", email: "merge2@m.test" })).body.contact;
    const deal = (await api(owner, "POST", "/crm/deals", { bookId, title: "Merge deal", contactIds: [a.id] })).body.deal;
    await api(owner, "POST", "/crm/interactions", { kind: "note", body: "about a", subjects: [{ kind: "contact", id: a.id }] });
    expect((await api(owner, "GET", `/crm/contacts/${b.id}`)).body.contact.duplicates.map((item: Json) => item.id)).toContain(a.id);
    const merged = await api(owner, "POST", `/crm/contacts/${a.id}/merge`, { intoId: b.id });
    expect(merged.status).toBe(200);
    const read = (await api(owner, "GET", `/crm/contacts/${b.id}`)).body.contact;
    expect(read.channels.map((channel: Json) => channel.value).sort()).toEqual(["+15550199", "merge1@m.test", "merge2@m.test"].sort());
    expect(read.deals.map((item: Json) => item.id)).toEqual([deal.id]);
    expect((await api(owner, "GET", `/crm/records/contact/${b.id}/timeline`)).body.interactions).toHaveLength(1);
    expect((await api(owner, "GET", `/crm/contacts/${a.id}`)).status).toBe(404);
    const otherBook = (await api(owner, "POST", "/crm/books", { name: "Hiring" })).body.book;
    const c = (await api(owner, "POST", "/crm/contacts", { bookId: otherBook.id, name: "Elsewhere" })).body.contact;
    expect((await api(owner, "POST", `/crm/contacts/${c.id}/merge`, { intoId: b.id })).body.code).toBe("OTHER_BOOK");
  });

  test("CSV import: preview with duplicates, commit with update, undo, re-import (D966)", async () => {
    const book = (await api(owner, "POST", "/crm/books", { name: "Import book" })).body.book;
    for (let index = 0; index < 10; index += 1) await api(owner, "POST", "/crm/contacts", { bookId: book.id, name: `Existing ${index}`, email: `person${index}@import.test` });
    const lines = ["Full Name,Email,Company,Title"];
    for (let index = 0; index < 200; index += 1) lines.push(`Person ${index},person${index}@import.test,${index % 2 ? "Acme Ltd" : "=cmd()"},Engineer`);
    const preview = await api(owner, "POST", "/crm/import", { bookId: book.id, entity: "contact", csv: lines.join("\n") });
    expect(preview.status).toBe(201);
    expect(preview.body.preview).toMatchObject({ total: 200, duplicates: 10, creates: 190, invalid: 0 });
    expect(preview.body.preview.mapping).toEqual({ 0: "name", 1: "email", 2: "company", 3: "job_title" });
    const committed = await api(owner, "POST", `/crm/import/${preview.body.preview.jobId}/commit`, { duplicates: "update" });
    expect(committed.body.result).toMatchObject({ created: 190, updated: 10, skipped: 0 });
    expect((await api(owner, "GET", `/crm/books/${book.id}`)).body.book.counts.contacts).toBe(200);
    expect((await api(owner, "GET", `/crm/contacts?book=${book.id}&q=person3@import.test`)).body.items[0].displayName).toBe("Person 3");
    const undone = await api(owner, "POST", `/crm/import/${preview.body.preview.jobId}/undo`);
    expect(undone.body).toMatchObject({ deleted: 190, restored: 10 });
    expect((await api(owner, "GET", `/crm/books/${book.id}`)).body.book.counts.contacts).toBe(10);
    expect((await api(owner, "GET", `/crm/contacts?book=${book.id}&q=person3@import.test`)).body.items[0].displayName).toBe("Existing 3");
    const again = await api(owner, "POST", "/crm/import", { bookId: book.id, entity: "contact", csv: lines.join("\n") });
    const skip = await api(owner, "POST", `/crm/import/${again.body.preview.jobId}/commit`, { duplicates: "skip" });
    expect(skip.body.result).toMatchObject({ created: 190, skipped: 10 });
    // Export is formula-safe (T514/T561).
    resetCrmExportLimitForTests();
    const response = await request(`/crm/export.csv?book=${book.id}&entity=contact`, {}, owner);
    const csv = await response.text();
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(csv).toContain("'=cmd()");
    expect(csv.split("\r\n").filter(Boolean).length).toBe(201);
  });

  test("vCard export escapes values", async () => {
    const contact = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Vic; Card", email: "vic@vcard.test" })).body.contact;
    const response = await request(`/crm/contacts/${contact.id}/vcard`, {}, owner);
    const text = await response.text();
    expect(text).toContain("FN:Vic\\; Card");
    expect(text).toContain("EMAIL;TYPE=INTERNET:vic@vcard.test");
  });
});

describe("search, datasets, progress, Bin", () => {
  test("search finds contacts, companies, and deals in readable books only", async () => {
    const scope = searchScope("contacts")!;
    const mine = await scope.search({ userId: owner.userId, role: "member", q: "acme", limit: 400 });
    expect(mine.results.some((result) => result.kind === "company")).toBe(true);
    const theirs = await scope.search({ userId: other.userId, role: "member", q: "acme", limit: 5 });
    expect(theirs.results).toHaveLength(0);
    const deals = await scope.search({ userId: owner.userId, role: "member", q: "gamma", limit: 5 });
    expect(deals.results[0]).toMatchObject({ kind: "deal", title: "Gamma" });
  });

  test("datasets: pipeline by stage and win counts, scoped to readable books (T502)", () => {
    const result = runDatasetQuery({ dataset: "crm.deals", measures: [{ fn: "count" }, { fn: "sum", column: "value" }], dimensions: ["status"], sort: [{ column: "status", dir: "asc" }] }, { userId: owner.userId, role: "member" });
    const byStatus = Object.fromEntries(result.rows.map((row) => [row[0], row]));
    expect(byStatus.won?.[2]).toBe(120000);
    const none = runDatasetQuery({ dataset: "crm.deals", measures: [{ fn: "count" }] }, { userId: other.userId, role: "member" });
    expect(none.rows[0]![0]).toBe(0);
    const changes = runDatasetQuery({ dataset: "crm.deal_stage_changes", measures: [{ fn: "count" }], dimensions: ["to_kind"] }, { userId: owner.userId, role: "member" });
    expect(changes.rows.length).toBeGreaterThan(0);
  });

  test("every dimension of every Contacts dataset groups without SQL errors", async () => {
    const { listDatasets } = await import("../server/datasets/registry");
    for (const info of listDatasets("member").filter((item) => item.module === "crm")) {
      for (const column of info.columns.filter((item) => item.dimension)) {
        const result = runDatasetQuery({ dataset: info.id, measures: [{ fn: "count" }], dimensions: [column.name], ...(info.timeColumn ? { timeBucket: "month" as const } : {}) }, { userId: owner.userId, role: "member" });
        expect({ dataset: info.id, column: column.name, ok: Array.isArray(result.rows) }).toEqual({ dataset: info.id, column: column.name, ok: true });
      }
    }
  });

  test("goal progress sources: won value and open pipeline value", async () => {
    const won = await progressSource("crm_won_value")!.compute({ bookId }, { ownerId: owner.userId, period: null, tz: "UTC", nowMs: Date.now() });
    expect(won?.value).toBe(120000);
    const open = await progressSource("crm_pipeline_value")!.compute({ bookId }, { ownerId: other.userId, period: null, tz: "UTC", nowMs: Date.now() });
    expect(open?.value).toBe(0);
  });

  test("binning and purging a deal leaves no orphans", async () => {
    const deal = (await api(owner, "POST", "/crm/deals", { bookId, title: "Purge me" })).body.deal;
    await api(owner, "POST", "/crm/interactions", { kind: "note", body: "x", subjects: [{ kind: "deal", id: deal.id }] });
    await api(owner, "POST", "/crm/followups", { subject: { kind: "deal", id: deal.id }, dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    await api(owner, "DELETE", `/crm/deals/${deal.id}`);
    expect((await api(owner, "GET", `/crm/deals/${deal.id}`)).status).toBe(404);
    const provider = binProviders.get("deal")!;
    expect(provider.list(owner.userId).some((item) => item.id === deal.id)).toBe(true);
    expect(await provider.purge(deal.id, owner.userId)).toBe("purged");
    for (const sql of ["SELECT COUNT(*) AS n FROM item_activity WHERE item_id = ?", "SELECT COUNT(*) AS n FROM interaction_subjects WHERE subject_id = ?", "SELECT COUNT(*) AS n FROM crm_followups WHERE subject_id = ?",
      "SELECT COUNT(*) AS n FROM work_links WHERE a_id = ?1 OR b_id = ?1", "SELECT COUNT(*) AS n FROM crm_search WHERE item_id = ?"]) {
      expect({ sql, n: (db.query(sql).get(deal.id) as { n: number }).n }).toEqual({ sql, n: 0 });
    }
  });
});

describe("MCP (§D.5 acceptance)", () => {
  test("upsert_contact → create_deal → update_deal stage Won → pipeline_summary; log_interaction", async () => {
    resetMcpLimits();
    const key = createApiKey(owner.userId, { name: "Crm key", surfaces: "both", grants: [{ module: "crm", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const call = async (name: string, args: unknown, surface: "mcp" | "rest" = "mcp") => JSON.parse((await invokeMcpToolForTests(name, args, key.id, surface)).content[0]!.text) as Json;
    const upserted = await call("upsert_contact", { bookId, email: "mcp@buyer.test", name: "Mia Buyer" });
    expect(upserted.created).toBe(true);
    const deal = await call("create_deal", { bookId, title: "MCP deal", value: 99900, contactIds: [upserted.contact.id] });
    expect(deal.deal.stageName).toBe("Intro");
    const won = await call("update_deal", { dealId: deal.deal.shortId, stage: "Won" });
    expect(won.deal.status).toBe("won");
    const summary = await call("pipeline_summary", { bookId }, "rest");
    expect(summary.stages.find((stage: Json) => stage.name === "Won").sum).toBe(219900);
    const logged = await call("log_interaction", { kind: "call", title: "Kickoff", contactIds: [upserted.contact.id], dealIds: [deal.deal.id] });
    expect(logged.interaction.subjects).toHaveLength(2);
    const listed = await call("list_contacts", { bookId, q: "mia" });
    expect(listed.items[0]).not.toHaveProperty("email");
    const dry = await call("bulk_update_deals", { deals: [{ dealId: deal.deal.id, nextStep: "Invoice" }], dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect((await call("get_deal", { dealId: deal.deal.id })).deal.nextStep).toBeNull();
  });

  test("a chosen-book key can't see another book", async () => {
    resetMcpLimits();
    const hiring = (await api(owner, "POST", "/crm/books", { name: "Secret book" })).body.book;
    const secret = (await api(owner, "POST", "/crm/contacts", { bookId: hiring.id, name: "Hidden Person" })).body.contact;
    const key = createApiKey(owner.userId, { name: "Sales only", surfaces: "both", grants: [{ module: "crm", permission: "read", resourceKind: "contact_book", resourceId: bookId }], expiresInDays: 30 });
    const call = async (name: string, args: unknown) => JSON.parse((await invokeMcpToolForTests(name, args, key.id)).content[0]!.text) as Json;
    expect((await call("get_contact", { contactId: secret.id })).code).toBe("NOT_FOUND");
    const listed = await call("list_contacts", {});
    expect(listed.items.some((item: Json) => item.bookId === hiring.id)).toBe(false);
    expect(listed.items.length).toBeGreaterThan(0);
    expect((await call("list_contact_books", {})).books.map((book: Json) => book.id)).toEqual([bookId]);
    expect((await call("search_crm", { q: "hidden" })).results).toHaveLength(0);
  });
});
