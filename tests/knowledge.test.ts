import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { fakeEmbedding, startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";

const { deleteProvider } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { agentNet } = await import("../server/agents/egress");
const { knowledgeTimers, sweepKnowledge, whenKnowledgeIdle, resetKnowledgeTimersForTests } = await import("../server/knowledge/index");
const { cosineTop, fuse, ftsQuery, keywordTop, knowledgeCache, resetKnowledgeCacheForTests, vectorsOf } = await import("../server/knowledge/search");
const { normalizeVector, blobToVector, vectorToBlob } = await import("../server/knowledge/embed");

/**
 * Wave 44 "AC-E" (agent chat plan §9, D367–D369, §14 T320, T321, T305, T314, §15 item 11): the
 * knowledge base lifecycle against the fake provider's `/embeddings`: sources (a published note, a
 * Files text and CSV document, pasted text), batching and normalization, the content-hash skip,
 * the publish hook, the hourly sweep, `unavailable` when the owner loses access, Re-index all,
 * search (cosine + BM25 + RRF, k caps, the LRU and its revision), budgets refused before the
 * provider, the egress guard for an embeddings URL on a private address, and the Bin.
 */

retireUsersAfterFile();
const fake = startFakeProvider(0);
let admin: Session;
let owner: Session;
let friend: Session;
let providerId: string;
let kbId: string;
let noteId: string;
let friendNoteId: string;

type Reply = { status: number; body: Record<string, any> };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

async function publishNote(session: Session, markdown: string, existing?: string) {
  let id = existing;
  if (!id) id = (await send(session, "POST", "/notes", { folderId: null })).body.note.id as string;
  const note = (await send(session, "GET", `/notes/${id}`)).body;
  const revision = note.note?.draft_revision ?? note.draftRevision ?? null;
  const saved = await send(session, "PUT", `/notes/${id}/draft`, { markdown, revision: existing ? revision : 1 });
  expect(saved.status).toBe(200);
  expect((await send(session, "POST", `/notes/${id}/publish`, {})).status).toBe(200);
  return id;
}

async function upload(session: Session, name: string, content: string) {
  const body = new FormData();
  body.append("file", new Blob([content]), name);
  const response = await request("/files?purpose=file", { method: "POST", body }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

async function shareNote(session: Session, id: string, people: Array<{ id: string; level: string }>) {
  const current = await send(session, "GET", `/notes/${id}/access`);
  const audience = people.length ? "selected" : "private";
  const saved = await send(session, "PUT", `/notes/${id}/access`, { audience, people, groups: [] }, { "If-Match": current.body.etag });
  expect(saved.status).toBe(200);
}

const embeddingCalls = () => fake.calls.filter((call) => call.path === "/v1/embeddings");
const sources = async (id = kbId) => (await send(owner, "GET", `/knowledge/${id}`)).body.knowledgeBase.sources as Array<Record<string, any>>;
const settle = async () => { await whenKnowledgeIdle(); await whenKnowledgeIdle(); };
const binItemsFor = async (session: Session) => (await send(session, "GET", "/bin")).body.items as Array<{ type: string; id: string }>;

const FAQ = [
  "# Billing FAQ",
  "",
  "## How do refunds work for annual plans?",
  "Annual plans are refunded pro rata for the unused months.",
  "",
  "## Can I pause my subscription?",
  "Yes, you can pause for up to three months.",
  "",
  "## More",
  "Q: Do you invoice in euros?",
  "A: Invoices are in the currency of your billing address."
].join("\n");

beforeAll(async () => {
  knowledgeTimers.publishDebounceMs = 30;
  admin = await createUser("W44 admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W44 owner");
  friend = await createUser("W44 friend");
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (knowledge)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0044", defaultModel: "gpt-6-luna", isDefault: true });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  noteId = await publishNote(owner, "# Onboarding\n\n## Laptops\n\nEvery new hire gets a laptop on day one.\n\n## Badges\n\nBadges are printed at reception.");
  friendNoteId = await publishNote(friend, "# Friend's guide\n\nThe office plants are watered on Fridays.");
});
beforeEach(() => resetKnowledgeTimersForTests());
afterAll(async () => {
  await settle();
  knowledgeTimers.publishDebounceMs = 60_000;
  const settings = readAgentSettings();
  if (settings.dailyTokensUser !== 500_000) writeAgentSettings(admin.userId, { dailyTokensUser: 500_000 }, settings.revision);
  deleteProvider(admin.userId, providerId);
  fake.stop();
});

describe("vectors (D368)", () => {
  test("normalized to unit length and stored as little-endian float32 (2 KiB at 512 dimensions)", () => {
    const vector = normalizeVector([3, 4]);
    expect([...vector]).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(normalizeVector([0, 0]).every((value) => value === 0)).toBe(true);
    const wide = normalizeVector(fakeEmbedding("refunds annual plans", 512));
    const blob = vectorToBlob(wide);
    expect(blob.byteLength).toBe(2048);
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    expect(view.getFloat32(0, true)).toBe(wide[0]!);
    expect([...blobToVector(blob)]).toEqual([...wide]);
  });
});

describe("the index lifecycle (plan §9)", () => {
  test("a base indexes a note, a Markdown file, a CSV file, and a pasted FAQ: batched, normalized, with heading paths", async () => {
    const callsBefore = embeddingCalls().length;
    const created = await send(owner, "POST", "/knowledge", { name: "Support FAQ", description: "Billing and onboarding" });
    expect(created.status).toBe(201);
    kbId = created.body.knowledgeBase.id;
    expect(created.body.knowledgeBase).toMatchObject({ embeddingModel: "text-embedding-3-small", dims: 512, status: "empty", yourLevel: "owner" });
    const markdownId = await upload(owner, "handbook.md", "# Handbook\n\n## Parking\n\nParking is free after 6 pm.");
    const csvRows = Array.from({ length: 1400 }, (_, index) => `${index},Product ${index},${index * 3}`);
    const csvId = await upload(owner, "prices.csv", ["id,name,price", ...csvRows].join("\n"));
    for (const body of [{ kind: "note", noteId }, { kind: "document", documentId: markdownId }, { kind: "document", documentId: csvId }, { kind: "text", title: "Billing FAQ", text: FAQ }]) {
      const added = await send(owner, "POST", `/knowledge/${kbId}/sources`, body);
      expect(added.status).toBe(201);
      expect(added.body.source.status).toBe("pending");
    }
    // The same note twice is refused.
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId })).body.code).toBe("SOURCE_EXISTS");
    await settle();
    const listed = await sources();
    expect(listed.map((source) => [source.kind, source.status])).toEqual([["note", "ready"], ["document", "ready"], ["document", "ready"], ["text", "ready"]]);
    expect(listed.map((source) => source.title)).toEqual(["Onboarding", "handbook.md", "prices.csv", "Billing FAQ"]);
    // 1,400 CSV rows are 70 chunks: two requests of at most 64 inputs, each asking for 512 dimensions.
    const calls = embeddingCalls().slice(callsBefore);
    for (const call of calls) {
      const body = call.body as { input: string[]; dimensions: number; model: string };
      expect(body.input.length).toBeLessThanOrEqual(64);
      expect(body).toMatchObject({ dimensions: 512, model: "text-embedding-3-small" });
      expect(call.headers.authorization).toBe("Bearer sk-test-fake-key-0044");
      expect(call.headers.cookie).toBeUndefined();
    }
    expect(calls.some((call) => (call.body as { input: string[] }).input.length === 64)).toBe(true);
    expect(listed[2]!.chunkCount).toBe(70);
    // Every stored vector is unit length; the FAQ is one chunk per question, with heading paths.
    const rows = db.query("SELECT heading, text, embedding FROM kb_chunks WHERE kb_id = ? ORDER BY id").all(kbId) as Array<{ heading: string | null; text: string; embedding: Uint8Array }>;
    for (const row of rows) {
      expect(row.embedding.byteLength).toBe(2048);
      const vector = blobToVector(row.embedding);
      expect(Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) - 1)).toBeLessThan(1e-5);
    }
    const faq = rows.filter((row) => row.heading?.startsWith("Billing FAQ"));
    expect(faq.map((row) => row.heading)).toEqual(["Billing FAQ › How do refunds work for annual plans?", "Billing FAQ › Can I pause my subscription?", "Billing FAQ › More"]);
    expect(faq[2]!.text).toBe("Q: Do you invoice in euros?\nA: Invoices are in the currency of your billing address.");
    const kb = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase;
    expect(kb).toMatchObject({ status: "ready", chunkCount: rows.length, counts: { ready: 4 } });
    // Embedding tokens count toward the owner's day, under kb:<id> (never the instance's agents).
    const usage = db.query("SELECT SUM(prompt_tokens) AS tokens FROM agent_usage_daily WHERE user_id = ? AND agent_id = ?").get(owner.userId, `kb:${kbId}`) as { tokens: number };
    expect(usage.tokens).toBeGreaterThan(0);
  });

  test("an unchanged source is not embedded again: the sweep and Re-index all", async () => {
    const before = embeddingCalls().length;
    const swept = await sweepKnowledge();
    expect(swept).toMatchObject({ unavailable: 0, changed: 0 });
    await settle();
    expect(embeddingCalls().length).toBe(before);
    // Re-index all embeds everything again (the hash is cleared).
    const reindexed = await send(owner, "POST", `/knowledge/${kbId}/reindex`, {});
    expect(reindexed.body).toMatchObject({ ok: true, sources: 4 });
    await settle();
    expect(embeddingCalls().length).toBeGreaterThan(before + 2);
    expect((await sources()).every((source) => source.status === "ready")).toBe(true);
  });

  test("publishing the note re-indexes it after the debounce; the sweep catches a change the hook missed", async () => {
    const before = embeddingCalls().length;
    await publishNote(owner, "# Onboarding\n\n## Laptops\n\nEvery new hire gets a laptop and a monitor on day one.", noteId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    expect(embeddingCalls().length).toBe(before + 1);
    const text = (db.query("SELECT group_concat(c.text, ' ') AS text FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE s.kb_id = ? AND s.kind = 'note'").get(kbId) as { text: string }).text;
    expect(text).toContain("a monitor");
    expect(text).not.toContain("Badges are printed");
    // A change behind the hook's back (the hook's timer reset) is found by the hourly check.
    knowledgeTimers.publishDebounceMs = 60_000;
    await publishNote(owner, "# Onboarding\n\nDesks are assigned on arrival.", noteId);
    resetKnowledgeTimersForTests();
    knowledgeTimers.publishDebounceMs = 30;
    expect((await sweepKnowledge()).changed).toBe(1);
    await settle();
    expect((db.query("SELECT c.text FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE s.kb_id = ? AND s.kind = 'note'").get(kbId) as { text: string }).text).toContain("Desks are assigned");
  });

  test("a source the owner can no longer read becomes unavailable and its chunks go (T320); it comes back when shared again", async () => {
    await shareNote(friend, friendNoteId, [{ id: owner.userId, level: "view" }]);
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId: friendNoteId })).status).toBe(201);
    await settle();
    const added = (await sources()).find((source) => source.refId === friendNoteId)!;
    expect(added).toMatchObject({ status: "ready", title: "Friend's guide" });
    // Unsharing it from the owner removes its chunks at once (Wave 44 fixes, M1: the access hook, not the hourly sweep).
    await shareNote(friend, friendNoteId, []);
    const gone = (await sources()).find((source) => source.id === added.id)!;
    expect(gone).toMatchObject({ status: "unavailable", chunkCount: 0 });
    expect((db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE source_id = ?").get(added.id) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM kb_chunk_fts WHERE kb_chunk_fts MATCH 'plants'").get() as { count: number }).count).toBe(0);
    expect((await sweepKnowledge()).unavailable).toBe(0);
    // Shared again: the hook queues it at once.
    await shareNote(friend, friendNoteId, [{ id: owner.userId, level: "view" }]);
    await settle();
    expect((await sources()).find((source) => source.id === added.id)!.status).toBe("ready");
    // Adding a note the owner cannot read is refused like a missing one.
    const privateNote = await publishNote(friend, "# Private\n\nNot for the owner.");
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId: privateNote })).status).toBe(404);
    // Removing a source removes its chunks and moves the revision.
    const revision = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.revision;
    expect((await send(owner, "DELETE", `/knowledge/${kbId}/sources/${added.id}`, {})).status).toBe(200);
    expect((await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.revision).toBeGreaterThan(revision);
  });

  test("sources are bounded: file types and sizes, pasted text, and the pickers offer only what both can read", async () => {
    // QA LOW-5: text, Markdown, and CSV by extension only; a .json file (stored as text/plain) is refused, and never offered.
    const json = await upload(owner, "photo.json", "{\"a\":1}");
    const refused = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "document", documentId: json });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("UNSUPPORTED_TYPE");
    expect((await send(owner, "GET", `/knowledge/${kbId}/candidates?kind=document&q=photo`)).body.candidates).toEqual([]);
    // .text is not one of them: Files stores it as application/octet-stream (its sniffing is unchanged).
    const textName = await upload(owner, "notes.text", "plain words");
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "document", documentId: textName })).body.code).toBe("UNSUPPORTED_TYPE");
    const huge = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "Huge", text: "x".repeat(256 * 1024 + 1) });
    expect(huge.status).toBe(400);
    const notes = await send(owner, "GET", `/knowledge/${kbId}/candidates?kind=note&q=`);
    expect(notes.status).toBe(200);
    const ids = notes.body.candidates.map((item: { id: string }) => item.id);
    expect(ids).toContain(noteId);
    expect(ids).toContain(friendNoteId);
    expect(notes.body.candidates.find((item: { id: string }) => item.id === noteId).added).toBe(true);
    const files = await send(owner, "GET", `/knowledge/${kbId}/candidates?kind=document&q=prices`);
    expect(files.body.candidates).toEqual([expect.objectContaining({ title: "prices.csv", detail: expect.stringContaining("CSV"), added: true })]);
    await settle();
  });
});

describe("search (cosine + BM25 + RRF)", () => {
  test("fusion ranks a chunk found by both lists first; ties break by id", () => {
    expect(fuse([[1, 2, 3], [3, 4]]).map((hit) => hit.id)).toEqual([3, 1, 2, 4]);
    expect(fuse([[1, 2, 3], [3, 4]])[0]).toMatchObject({ id: 3, ranks: [3, 1] });
    expect(fuse([[5], [6]]).map((hit) => hit.id)).toEqual([5, 6]);
    expect(ftsQuery("Refunds, for ANNUAL plans?")).toBe('"refunds" OR "for" OR "annual" OR "plans"');
    expect(ftsQuery("? !")).toBeNull();
  });

  test("Try it returns the FAQ answer first with its heading path; k is capped at 8", async () => {
    const tried = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "How are refunds for annual plans handled?" });
    expect(tried.status).toBe(200);
    expect(tried.body.mode).toBe("hybrid");
    expect(tried.body.hits.length).toBe(5);
    expect(tried.body.hits[0]).toMatchObject({ heading: "Billing FAQ › How do refunds work for annual plans?", source: { kind: "text", title: "Billing FAQ" }, kb: { id: kbId, name: "Support FAQ" } });
    expect(tried.body.hits[0].ranks.keyword).toBe(1);
    expect(tried.body.hits[0].ranks.vector).toBeLessThanOrEqual(3);
    for (let index = 1; index < tried.body.hits.length; index += 1) expect(tried.body.hits[index].score).toBeLessThanOrEqual(tried.body.hits[index - 1].score);
    expect((await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "parking", k: 8 })).body.hits.length).toBe(8);
    expect((await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "parking", k: 9 })).status).toBe(400);
    expect((await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "x".repeat(501) })).status).toBe(400);
  });

  test("cosine over the cached matrix; the LRU reloads only when the revision moves", async () => {
    resetKnowledgeCacheForTests();
    const kb = db.query("SELECT * FROM knowledge_bases WHERE id = ?").get(kbId) as { id: string; revision: number; dims: number };
    const matrix = vectorsOf(kb);
    expect(knowledgeCache.loads).toBe(1);
    vectorsOf(kb);
    expect(knowledgeCache.loads).toBe(1);
    const query = normalizeVector(fakeEmbedding("Parking › Handbook Parking is free after 6 pm.", 512));
    const top = cosineTop(matrix, query, 3);
    const best = db.query("SELECT text FROM kb_chunks WHERE id = ?").get(top[0]!.id) as { text: string };
    expect(best.text).toBe("Parking is free after 6 pm.");
    expect(keywordTop([kbId], "parking", 5).length).toBeGreaterThan(0);
    // A new revision (a source added, removed, or indexed) reloads on the next search.
    db.query("UPDATE knowledge_bases SET revision = revision + 1 WHERE id = ?").run(kbId);
    vectorsOf(db.query("SELECT * FROM knowledge_bases WHERE id = ?").get(kbId) as typeof kb);
    expect(knowledgeCache.loads).toBe(2);
    // The cap: past it, the least recently used base is dropped.
    const saved = knowledgeCache.maxBytes;
    knowledgeCache.maxBytes = 1;
    const other = db.query("SELECT * FROM knowledge_bases WHERE id <> ? LIMIT 1").get(kbId) as typeof kb | null;
    if (other) {
      vectorsOf(other);
      vectorsOf(db.query("SELECT * FROM knowledge_bases WHERE id = ?").get(kbId) as typeof kb);
      expect(knowledgeCache.loads).toBe(4);
    }
    knowledgeCache.maxBytes = saved;
  });

  test("when the query cannot be embedded the search answers from keywords alone", async () => {
    const tried = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "fail:embed refunds" });
    expect(tried.status).toBe(200);
    expect(tried.body.mode).toBe("keyword");
    expect(tried.body.hits[0].heading).toBe("Billing FAQ › How do refunds work for annual plans?");
  });
});

describe("budgets and egress (T314, T305)", () => {
  test("over the owner's daily budget, nothing is sent to the provider and the source waits", async () => {
    const settings = readAgentSettings();
    writeAgentSettings(admin.userId, { dailyTokensUser: 1 }, settings.revision);
    try {
      const before = embeddingCalls().length;
      const added = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "Later", text: "Holiday hours are posted in December." });
      expect(added.status).toBe(201);
      await settle();
      expect(embeddingCalls().length).toBe(before);
      const waiting = (await sources()).find((source) => source.id === added.body.source.id)!;
      expect(waiting.status).toBe("pending");
      expect(waiting.error).toContain("budget");
      // Try it falls back to keywords rather than calling the provider.
      const tried = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "refunds" });
      expect(tried.body.mode).toBe("keyword");
      expect(embeddingCalls().length).toBe(before);
    } finally {
      const current = readAgentSettings();
      writeAgentSettings(admin.userId, { dailyTokensUser: 500_000 }, current.revision);
    }
    await sweepKnowledge();
    await settle();
    expect((await sources()).every((source) => source.status === "ready" || source.status === "error")).toBe(true);
  });

  test("an embeddings URL that resolves to a private address is refused before any request (T305)", async () => {
    const realResolve = agentNet.resolve;
    const realFetch = agentNet.fetch;
    let fetched = 0;
    agentNet.resolve = async (host: string) => host === "embeddings.example.test" ? ["10.20.30.40"] : realResolve(host);
    agentNet.fetch = (url: string, init: RequestInit) => { if (url.includes("10.20.30.40") || url.includes("embeddings.example.test")) fetched += 1; return realFetch(url, init); };
    try {
      const privateProvider = await send(admin, "POST", "/agents/admin/providers", { name: "Private embeddings", baseUrl: "https://embeddings.example.test/v1", apiKey: "sk-test-private-0044" });
      expect(privateProvider.status).toBe(201);
      const created = await send(owner, "POST", "/knowledge", { name: "Private egress" });
      const privateKb = created.body.knowledgeBase.id as string;
      db.query("UPDATE knowledge_bases SET provider_id = ? WHERE id = ?").run(privateProvider.body.provider.id, privateKb);
      await send(owner, "POST", `/knowledge/${privateKb}/sources`, { kind: "text", title: "Secret", text: "Should never leave." });
      await settle();
      const [source] = await sources(privateKb);
      expect(source).toMatchObject({ status: "error" });
      expect(source!.error).toContain("private");
      expect(fetched).toBe(0);
      deleteProvider(admin.userId, privateProvider.body.provider.id);
      expect((await send(owner, "DELETE", `/knowledge/${privateKb}`, {})).status).toBe(200);
    } finally {
      agentNet.resolve = realResolve;
      agentNet.fetch = realFetch;
    }
  });

  test("a provider failure marks the source error with the redacted message (T309)", async () => {
    const added = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "Broken", text: "fail:embed this one" });
    await settle();
    const failed = (await sources()).find((source) => source.id === added.body.source.id)!;
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("HTTP 500");
    expect(failed.error).not.toContain("sk-secret");
    expect((await send(owner, "DELETE", `/knowledge/${kbId}/sources/${added.body.source.id}`, {})).status).toBe(200);
  });
});

describe("the Bin", () => {
  test("binned bases reach nobody and their agents stop seeing them; restore brings them back; purge removes every row", async () => {
    const created = await send(owner, "POST", "/knowledge", { name: "Short-lived base" });
    const id = created.body.knowledgeBase.id as string;
    await send(owner, "POST", `/knowledge/${id}/sources`, { kind: "text", title: "Temp", text: "# Temp\n\nTemporary words about zebras." });
    await settle();
    const agent = await send(owner, "POST", "/agents", { name: "KB bin agent", providerId, tools: [{ source: "knowledge", kbId: id }] });
    expect(agent.status).toBe(201);
    expect(agent.body.agent.tools).toEqual([{ source: "knowledge", kbId: id }]);
    expect((await send(friend, "DELETE", `/knowledge/${id}`, {})).status).toBe(404);
    expect((await send(owner, "DELETE", `/knowledge/${id}`, {})).status).toBe(200);
    expect((await send(owner, "GET", `/knowledge/${id}`)).status).toBe(404);
    expect((await send(owner, "POST", `/knowledge/${id}/search`, { query: "zebras" })).status).toBe(404);
    expect((await binItemsFor(owner)).some((item) => item.type === "knowledge_base" && item.id === id)).toBe(true);
    expect((await send(owner, "POST", `/bin/knowledge_base/${id}/restore`, {})).status).toBe(200);
    expect((await send(owner, "POST", `/knowledge/${id}/search`, { query: "zebras" })).body.hits.length).toBe(1);
    expect((await send(owner, "DELETE", `/knowledge/${id}`, {})).status).toBe(200);
    const purged = await send(owner, "DELETE", `/bin/knowledge_base/${id}`, {});
    expect(purged.status).toBe(200);
    for (const table of ["knowledge_bases WHERE id = ?", "kb_sources WHERE kb_id = ?", "kb_chunks WHERE kb_id = ?"]) {
      expect((db.query(`SELECT COUNT(*) AS count FROM ${table}`).get(id) as { count: number }).count).toBe(0);
    }
    expect((db.query("SELECT COUNT(*) AS count FROM agent_tools WHERE kb_id = ?").get(id) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM kb_chunk_fts WHERE kb_chunk_fts MATCH 'zebras'").get() as { count: number }).count).toBe(0);
    db.exec("INSERT INTO kb_chunk_fts (kb_chunk_fts) VALUES ('integrity-check')");
    void origin;
  });
});
