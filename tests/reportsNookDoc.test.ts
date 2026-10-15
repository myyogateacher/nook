import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, origin, request, tailscaleOrigin, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeAnswer } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import { sampleAnswer } from "./support/reportSeed";
import { qaScript, startScriptedProvider, type Script } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";

const { generateDeps, liveGenerations } = await import("../server/reports/generate");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { fetchNookFetched } = await import("../server/reports/docSource");
const { NOOK_FILE_SEARCH_LIMITS, resetNookFileSearchRate } = await import("../server/reports/nookFileSearch");
const { documentIndexReady, resetDocumentIndexForTests, whenDocumentIndexIdle } = await import("../server/documentSearch");
const { makePdf } = await import("./support/pdf");

/**
 * B4: Nook as a built-in doc source (`nook`): listed first, no sync; a doc ref is a link to a note or a
 * Files text document on any of this instance's origins (every route shape), or a bare id; it is read
 * as the report's OWNER with their live access (published notes only; NOT_FOUND, one message, for
 * anything they cannot read: another person's private note, a binned note, an unpublished draft).
 * Snapshots, Check doc, and the banner work as for a tool server; the browse tools are search_notes,
 * read_note, and read_document_text.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0);
const provider = startScriptedProvider(0);
const originalConnection = generateDeps.connection;

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}
function answer(sql: string): FakeAnswer {
  if (sql.includes("sum(amount) AS revenue")) return { meta: [{ name: "day", type: "Date" }, { name: "revenue", type: "Float64" }], data: [["2026-10-01", 120.5], ["2026-10-02", 98], ["2026-10-03", 143.25]] };
  if (sql.includes("count() AS orders") && sql.includes("country")) return { meta: [{ name: "country", type: "LowCardinality(String)" }, { name: "orders", type: "UInt64" }], data: [["DE", "41"], ["US", "33"], ["IN", "12"]] };
  if (sql.includes("total_revenue")) return { meta: [{ name: "total_revenue", type: "Float64" }, { name: "orders", type: "UInt64" }], data: [[361.75, "86"]] };
  return sampleAnswer(sql);
}

let admin: Session;
let owner: Session;
let other: Session;
let datasourceId = "";
let published = "";
let linked = "";
let file = "";

async function note(session: Session, markdown: string, publish = true) {
  const id = (await send(session, "POST", "/notes", { folderId: null })).body.note.id as string;
  expect((await send(session, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  if (publish) expect((await send(session, "POST", `/notes/${id}/publish`)).status).toBe(200);
  return id;
}
async function upload(session: Session, name: string, text: string | Uint8Array, type = "text/markdown") {
  const form = new FormData();
  form.append("file", new Blob([text], { type }), name);
  return ((await (await request("/files", { method: "POST", body: form }, session)).json()) as { document: { id: string } }).document.id;
}

beforeAll(async () => {
  admin = await createUser("Nook doc admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Nook doc owner");
  other = await createUser("Nook doc other");
  fake.state.tables = [{ db: "analytics", name: "orders", engine: "MergeTree", columns: [{ name: "order_date", type: "Date" }, { name: "amount", type: "Decimal(18, 2)" }, { name: "country", type: "String" }] }];
  const datasource = await send(admin, "POST", "/reports/admin/datasources", { name: `Nook DS ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
  datasourceId = datasource.body.datasource.id;
  await syncSchema(datasourceId);
  published = await note(owner, "# Revenue metrics\n\nUse `analytics.orders`. Table rules are in the linked note.");
  linked = await note(owner, "# Order rules\n\nExclude refunds (amount <= 0).");
  file = await upload(owner, "Revenue spec.md", "# Revenue spec\n\nSum amount by day.");
  generateDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
});
afterAll(() => {
  generateDeps.connection = originalConnection;
  fake.stop();
  provider.stop();
});
afterEach(async () => {
  const until = Date.now() + 15_000;
  while (liveGenerations().length) {
    if (Date.now() > until) throw new Error("a generation is still running");
    await Bun.sleep(20);
  }
  provider.setScript(qaScript);
});

async function waitForRun(runId: string) {
  const until = Date.now() + 20_000;
  for (;;) {
    const row = db.query("SELECT status, error FROM report_runs WHERE id = ?").get(runId) as { status: string; error: string | null };
    if (row.status !== "running" && !liveGenerations().some((item) => item.runId === runId)) return row;
    if (Date.now() > until) throw new Error("the run did not finish");
    await Bun.sleep(20);
  }
}
async function generate(session: Session, docRef: string, extra: Json = {}, script: Script = qaScript) {
  provider.setScript(script);
  provider.calls.length = 0;
  fake.state.select = (sql) => answer(sql);
  return send(session, "POST", "/reports/generate", { docRef, serverId: "nook", datasourceId, ...extra });
}

describe("the built-in source", () => {
  test("is listed first, synced, with its own tools, the app's origins, and no host", async () => {
    const listed = await send(owner, "GET", "/reports/doc-servers");
    expect(listed.body.servers[0]).toMatchObject({ id: "nook", name: "Nook (this workspace)", synced: true, builtin: true, host: null, toolNames: ["read_note", "read_document_text", "search_notes"] });
    expect(listed.body.servers[0].origins).toEqual(expect.arrayContaining([origin, tailscaleOrigin]));
    expect(db.query("SELECT COUNT(*) AS count FROM agent_tool_servers WHERE id = 'nook'").get()).toEqual({ count: 0 });
  });

  test("every link shape (both origins, app and API routes, any case, a bare id) reads the note or file as the owner", async () => {
    for (const ref of [`${origin}/notes/${published}`, `${tailscaleOrigin}/notes/${published.toUpperCase()}?panel=1#x`, `${origin}/api/notes/${published}`, `${origin}/api/notes/${published}/versions/1`, published]) {
      const doc = await fetchNookFetched(owner.userId, ref);
      expect([ref, doc.title, doc.tool]).toEqual([ref, "Revenue metrics", "read_note"]);
      expect(doc.markdown).toContain("analytics.orders");
    }
    for (const ref of [`${origin}/files/${file}`, `${origin}/api/files/${file}/content`, `${tailscaleOrigin}/api/files/${file}`, file]) {
      const doc = await fetchNookFetched(owner.userId, ref);
      expect([ref, doc.title, doc.tool]).toEqual([ref, "Revenue spec.md", "read_document_text"]);
    }
    for (const ref of [`https://elsewhere.example.test/notes/${published}`, `${origin}/notes/folder/${published}`, `${origin}/tasks/${published}`]) {
      await expect(fetchNookFetched(owner.userId, ref)).rejects.toMatchObject({ code: "INVALID" });
    }
  });

  test("a generation from a Nook note: the snapshot, doc_source nook, and no tool server row", async () => {
    const started = await generate(owner, `${origin}/notes/${published}`);
    expect(started.status).toBe(202);
    expect(started.body.report.title).toBe("Revenue metrics");
    expect(await waitForRun(started.body.run.id)).toMatchObject({ status: "succeeded" });
    const reportId = started.body.report.id as string;
    expect(db.query("SELECT doc_source, doc_server_id, doc_tool FROM reports WHERE id = ?").get(reportId)).toEqual({ doc_source: "nook", doc_server_id: null, doc_tool: "read_note" });
    expect(String(provider.calls[0]!.messages![0]!.content)).toContain("<document>\n# Revenue metrics");
    const state = await send(owner, "GET", `/reports/${reportId}/doc`);
    expect(state.body.doc).toMatchObject({ changed: false, doc: { serverId: "nook", serverName: "Nook (this workspace)", tool: "read_note" }, latest: { title: "Revenue metrics" } });
    expect((await send(owner, "GET", `/reports/${reportId}`)).body.report.doc).toMatchObject({ serverId: "nook" });
  });
});

describe("a PDF as the doc (D511)", () => {
  test("a PDF's text layer is the doc, read as the owner through the PDF worker; a scan or a broken PDF is DOC_FETCH with its reason", async () => {
    const pdf = await upload(owner, "Revenue spec.pdf", makePdf(["Revenue spec from a PDF", "Sum amount by day"]), "application/pdf");
    const doc = await fetchNookFetched(owner.userId, `${origin}/files/${pdf}`);
    expect([doc.title, doc.tool, doc.markdown]).toEqual(["Revenue spec.pdf", "read_document_text", "Revenue spec from a PDF\n\nSum amount by day"]);
    const scan = await upload(owner, "Scan.pdf", makePdf([""]), "application/pdf");
    await expect(fetchNookFetched(owner.userId, scan)).rejects.toMatchObject({ code: "DOC_FETCH", message: expect.stringContaining("no text layer (scanned?)") });
    const broken = await upload(owner, "Broken.pdf", "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "application/pdf");
    await expect(fetchNookFetched(owner.userId, broken)).rejects.toMatchObject({ code: "DOC_FETCH", message: expect.stringContaining("PDF") });
    const binary = await upload(owner, "blob.bin", "\u0000\u0001", "application/octet-stream");
    await expect(fetchNookFetched(owner.userId, binary)).rejects.toMatchObject({ code: "DOC_FETCH", message: expect.stringContaining("PDFs with a text layer") });
    // Another person's PDF is the same NOT_FOUND as anything else they cannot read.
    await expect(fetchNookFetched(other.userId, pdf)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a generation from a Nook PDF: the PDF's text is the document the model reads", async () => {
    const pdf = await upload(owner, "Orders brief.pdf", makePdf(["Orders brief", "Use analytics.orders and sum amount by day"]), "application/pdf");
    const started = await generate(owner, `${origin}/files/${pdf}`);
    expect(started.status).toBe(202);
    expect(await waitForRun(started.body.run.id)).toMatchObject({ status: "succeeded" });
    expect(db.query("SELECT doc_source, doc_tool FROM reports WHERE id = ?").get(started.body.report.id)).toEqual({ doc_source: "nook", doc_tool: "read_document_text" });
    expect(String(provider.calls[0]!.messages![0]!.content)).toContain("<document>\nOrders brief\n\nUse analytics.orders and sum amount by day");
  });
});

describe("owner access, never a leak", () => {
  test("another person's private note, a binned note, an unpublished draft, and a missing id are all NOT_FOUND with one message", async () => {
    const theirs = await note(other, "# Their secret metrics");
    const draft = await note(owner, "# Not yet", false);
    const binned = await note(owner, "# Binned");
    expect((await send(owner, "DELETE", `/notes/${binned}`)).status).toBeLessThan(300);
    const reports = (db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ?").get(owner.userId) as { count: number }).count;
    const messages = new Set<string>();
    for (const id of [theirs, binned, draft, crypto.randomUUID()]) {
      const refused = await generate(owner, `${origin}/notes/${id}`);
      expect([id, refused.status, refused.body.code]).toEqual([id, 404, "NOT_FOUND"]);
      expect(JSON.stringify(refused.body)).not.toContain("secret");
      messages.add(refused.body.error ?? refused.body.message);
    }
    expect(messages.size).toBe(1);
    // Nothing was created or called.
    expect((db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ?").get(owner.userId) as { count: number }).count).toBe(reports);
    // The other person may read their own note.
    expect((await fetchNookFetched(other.userId, theirs)).title).toBe("Their secret metrics");
    // Read as the report's owner whatever the link: their access, not the link's.
    await expect(fetchNookFetched(owner.userId, `${origin}/notes/${theirs}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Doc changed and Check doc", () => {
  test("a new published version is Doc changed; Regenerate keeps the Nook source", async () => {
    const id = await note(owner, "# Weekly KPIs\n\nRevenue per day from analytics.orders.");
    const started = await generate(owner, id);
    expect(await waitForRun(started.body.run.id)).toMatchObject({ status: "succeeded" });
    const reportId = started.body.report.id as string;
    expect((await send(owner, "POST", `/reports/${reportId}/doc/check`)).body.doc.changed).toBe(false);
    const detail = await send(owner, "GET", `/notes/${id}`);
    expect((await send(owner, "PUT", `/notes/${id}/draft`, { markdown: "# Weekly KPIs\n\nRevenue per day and per country.", revision: detail.body.note.draft_revision })).status).toBe(200);
    expect((await send(owner, "POST", `/notes/${id}/publish`)).status).toBe(200);
    const checked = await send(owner, "POST", `/reports/${reportId}/doc/check`);
    expect(checked.body.doc).toMatchObject({ changed: true, mainChanged: true, doc: { serverId: "nook" } });
    // Regenerate without a source: Nook again.
    const again = await send(owner, "POST", `/reports/${reportId}/generate`, {});
    expect(again.status).toBe(202);
    expect(await waitForRun(again.body.run.id)).toMatchObject({ status: "succeeded" });
    expect((await send(owner, "GET", `/reports/${reportId}/doc`)).body.doc).toMatchObject({ changed: false, doc: { serverId: "nook" } });
  });
});

describe("browse tools for Nook", () => {
  test("read_note follows a linked note as the owner; another person's note is refused to the model; the page is kept", async () => {
    const theirs = await note(other, "# Other rules SECRET");
    const script: Script = (context) => {
      if (context.step === 1) return { toolCalls: [{ name: "doc__read_note", arguments: { noteId: linked } }, { name: "doc__read_note", arguments: { noteId: theirs } }] };
      return qaScript({ ...context, step: context.step - 1 });
    };
    const refused = await generate(owner, published, { browseTools: ["read_note", "delete_note"] });
    expect([refused.status, refused.body.code]).toEqual([400, "DOC_TOOL_REFUSED"]);
    const started = await generate(owner, published, { browseTools: ["read_note", "search_notes"] }, script);
    expect(await waitForRun(started.body.run.id)).toMatchObject({ status: "succeeded" });
    const tools = provider.calls[0]!.tools!.map((tool) => tool.function.name);
    expect(tools).toEqual(expect.arrayContaining(["doc__read_note", "doc__search_notes"]));
    expect(tools).not.toContain("doc__read_document_text");
    const answers = (provider.calls.at(-1)!.messages ?? []).filter((turn) => turn.role === "tool").map((turn) => String(turn.content));
    expect(answers.some((text) => text.startsWith("<document tool=\"read_note\">") && text.includes("Exclude refunds"))).toBe(true);
    expect(answers.some((text) => text.includes("SECRET"))).toBe(false);
    expect(answers.some((text) => text.includes("DOC_FETCH") && text.includes("no published note"))).toBe(true);
    expect(db.query("SELECT server_id, tool, title FROM report_doc_pages WHERE run_id = ?").all(started.body.run.id)).toEqual([{ server_id: "nook", tool: "read_note", title: "Order rules" }]);
    const state = await send(owner, "GET", `/reports/${started.body.report.id}/doc`);
    expect(state.body.doc.pages).toEqual([expect.objectContaining({ title: "Order rules", serverName: "Nook", changed: false })]);
  });
});

describe("K1: generate straight into a folder", () => {
  test("the report is created in the owner's folder by the generate request; another person's or a binned folder is a 404 before anything is created", async () => {
    const folder = (await send(owner, "POST", "/reports/folders", { name: `Gen ${crypto.randomUUID().slice(0, 6)}` })).body.folder.id as string;
    const started = await generate(owner, published, { folderId: folder.toUpperCase() });
    expect(started.status).toBe(202);
    expect(db.query("SELECT folder_id FROM reports WHERE id = ?").get(started.body.report.id)).toEqual({ folder_id: folder });
    expect(await waitForRun(started.body.run.id)).toMatchObject({ status: "succeeded" });

    const count = () => (db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ?").get(owner.userId) as { count: number }).count;
    const before = count();
    // Phase 2 (D483): another member's folder is in the shared tree, so only a missing one is refused.
    const refused = await generate(owner, published, { folderId: crypto.randomUUID() });
    expect([refused.status, refused.body.code]).toEqual([404, "NOT_FOUND"]);
    const binned = (await send(owner, "POST", "/reports/folders", { name: "Binned" })).body.folder.id as string;
    expect((await send(admin, "DELETE", `/reports/folders/${binned}`)).status).toBe(200);
    expect((await generate(owner, published, { folderId: binned })).status).toBe(404);
    expect((await generate(owner, published, { folderId: "not-a-uuid" })).status).toBe(400);
    expect(count()).toBe(before);
  });
});

describe("K4: Pick from Nook searches Files text", () => {
  const search = async (session: Session, q: string, cursor?: string) => {
    resetNookFileSearchRate();
    await whenDocumentIndexIdle();
    return send(session, "GET", `/reports/nook-files?q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  };
  const ids = (body: Json) => (body.results as Array<{ id: string }>).map((hit) => hit.id);

  // Lane FTS: the indexed query once the backfill is done, the bounded scan before; the same answers.
  for (const indexed of [true, false]) test(`matches every word in the name or the text, with a plain snippet; access is exactly read_document_text's (${indexed ? "index" : "scan before the backfill"})`, async () => {
    await whenDocumentIndexIdle();
    const wasReady = documentIndexReady();
    resetDocumentIndexForTests({ ready: indexed });
    try { await matchesEveryWord(); } finally { resetDocumentIndexForTests({ ready: wasReady }); }
  });

  async function matchesEveryWord() {
    const word = `zq${crypto.randomUUID().slice(0, 8)}`;
    const byText = await upload(owner, "Quarter notes.md", `# Notes\n\nThe ${word} metric is net of refunds.`);
    const byName = await upload(owner, `${word} rules.txt`, "nothing here", "text/plain");
    const binary = await upload(owner, `${word}.bin`, "\u0000\u0001", "application/octet-stream");
    const binned = await upload(owner, "Old.md", `${word} old`);
    expect((await send(owner, "DELETE", `/files/${binned}`)).status).toBe(200);
    const theirs = await upload(other, "Theirs.md", `${word} private to them`);
    const shared = await upload(other, "Shared.md", `${word} shared with everyone`);
    expect((await send(other, "PUT", `/files/${shared}/sharing`, { visibility: "all_users", userIds: [] })).status).toBe(200);

    const found = await search(owner, `${word} REFUNDS`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ results: [expect.objectContaining({ id: byText, name: "Quarter notes.md", matched: "text", isOwner: true })], next: null });
    expect(found.body.results[0].snippet).toContain(`The ${word} metric is net of refunds.`);

    const all = await search(owner, word);
    expect(ids(all.body).sort()).toEqual([byText, byName, shared].sort());
    expect(all.body.results.find((hit: Json) => hit.id === byName)).toMatchObject({ matched: "name", snippet: null });
    // The same answer as reading each one as the doc source does (read_document_text): hit ⇔ readable text.
    for (const id of [byText, byName, binary, binned, theirs, shared]) {
      const readable = await fetchNookFetched(owner.userId, id).then(() => true, () => false);
      expect([id, readable]).toEqual([id, ids(all.body).includes(id)]);
    }
    expect(ids((await search(other, word)).body).sort()).toEqual([theirs, shared].sort());
    expect((await search(owner, "   ")).body).toEqual({ results: [], next: null });
    expect((await search(owner, word, "not-a-cursor")).status).toBe(400);
  }

  // D512: PDFs are offered too. The index offers a PDF by its text, never one with no text layer; the
  // bounded scan before the backfill never runs the PDF worker, so it matches a PDF by name only.
  for (const indexed of [true, false]) test(`offers PDFs with a text layer, labelled pdf (${indexed ? "index" : "scan before the backfill"})`, async () => {
    const word = `pd${crypto.randomUUID().slice(0, 8)}`;
    const byText = await upload(owner, "Quarterly.pdf", makePdf([`The ${word} metric`, "net of refunds"]), "application/pdf");
    const byName = await upload(owner, `${word} brief.pdf`, makePdf(["Nothing to see"]), "application/pdf");
    const scan = await upload(owner, `${word} scan.pdf`, makePdf([""]), "application/pdf");
    await whenDocumentIndexIdle();
    const wasReady = documentIndexReady();
    resetDocumentIndexForTests({ ready: indexed });
    try {
      const found = await search(owner, word);
      expect(found.status).toBe(200);
      const hits = new Map((found.body.results as Json[]).map((hit) => [hit.id as string, hit]));
      expect(hits.get(byName)).toMatchObject({ matched: "name", pdf: true, snippet: null });
      if (indexed) {
        expect([...hits.keys()].sort()).toEqual([byText, byName].sort());
        expect(hits.get(byText)).toMatchObject({ matched: "text", pdf: true, name: "Quarterly.pdf" });
        expect(hits.get(byText)!.snippet).toContain(`The ${word} metric`);
        // Every PDF the index offers reads as a doc.
        for (const id of hits.keys()) expect((await fetchNookFetched(owner.userId, id)).tool).toBe("read_document_text");
      } else {
        expect([...hits.keys()].sort()).toEqual([byName, scan].sort());
      }
    } finally {
      resetDocumentIndexForTests({ ready: wasReady });
    }
  });

  test("pages with a cursor (newest first among equals) when the scan or hit cap is reached; rate limited", async () => {
    const word = `pg${crypto.randomUUID().slice(0, 8)}`;
    const made: string[] = [];
    for (let index = 0; index < 5; index += 1) made.push(await upload(owner, `Page ${index}.md`, `${word} ${index}`));
    const saved = { ...NOOK_FILE_SEARCH_LIMITS };
    await whenDocumentIndexIdle();
    const wasReady = documentIndexReady();
    try {
      for (const indexed of [false, true]) {
        resetDocumentIndexForTests({ ready: indexed });
        // The scan pages by candidates read, the index by hits; equal ranks come newest first.
        if (indexed) NOOK_FILE_SEARCH_LIMITS.hits = 2;
        else NOOK_FILE_SEARCH_LIMITS.scan = 2;
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const answer = await search(owner, word, cursor);
          seen.push(...ids(answer.body));
          if (!answer.body.next) break;
          cursor = answer.body.next as string;
        }
        expect({ indexed, seen }).toEqual({ indexed, seen: [...made].reverse() });
        Object.assign(NOOK_FILE_SEARCH_LIMITS, saved);
      }
    } finally {
      Object.assign(NOOK_FILE_SEARCH_LIMITS, saved);
      resetDocumentIndexForTests({ ready: wasReady });
    }
    resetNookFileSearchRate();
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) statuses.push((await send(owner, "GET", `/reports/nook-files?q=${word}`)).status);
    expect(statuses.at(-1)).toBe(429);
    resetNookFileSearchRate();
  });
});
