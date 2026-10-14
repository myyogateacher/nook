import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { PROBE_TIMEOUT_MS, runProbe } from "./support/probe";

const { deleteProvider } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { knowledgeTimers, resetKnowledgeTimersForTests, whenKnowledgeIdle } = await import("../server/knowledge/index");
const { chargeKeySearch, KNOWLEDGE_SEARCH_LIMITS } = await import("../server/knowledge/limits");
const { vectorsOf } = await import("../server/knowledge/search");
const { MODEL_CHANGING_NOTICE, PROVIDER_REMOVED, kbRow } = await import("../server/knowledge/service");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const teamService = await import("../server/team/service");
type Grant = import("../server/keyGrants").Grant;

/**
 * The AC-E deferred items (2026-10-08): Change embedding model (owner only, one transaction, never
 * two embedding spaces, keyword-only while it runs, the provider-removed way out, the shared hour),
 * per-source chunk previews (who sees them, pagination, no more text than a preview), knowledge
 * bases on Team → Groups, the per-key search limit (429 + Retry-After), the group-membership hook,
 * and the Re-index hour kept in SQLite (across a restart: a separate `bun --no-env-file` process).
 */

retireUsersAfterFile();
const providerA = startFakeProvider(0);
const providerB = startFakeProvider(0);
const providerC = startFakeProvider(0, { nativeDims: 384 });
let admin: Session;
let owner: Session;
let manager: Session;
let viewerShare: Session;
let readOnly: Session;
let stranger: Session;
let guest: Session;
let friend: Session;
let providerAId: string;
let providerBId: string;
let providerCId: string;

type Reply = { status: number; body: Record<string, any>; headers: Headers };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}
async function publishNote(session: Session, markdown: string) {
  const id = (await send(session, "POST", "/notes", { folderId: null })).body.note.id as string;
  expect((await send(session, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  expect((await send(session, "POST", `/notes/${id}/publish`, {})).status).toBe(200);
  return id;
}
async function shareItem(session: Session, path: string, people: Array<{ id: string; level: string }>, groups: Array<{ id: string; level: string }> = []) {
  const current = await send(session, "GET", `${path}/access`);
  const saved = await send(session, "PUT", `${path}/access`, { audience: people.length || groups.length ? "selected" : "private", people, groups }, { "If-Match": current.body.etag });
  expect(saved.status).toBe(200);
}
const settle = async () => { await whenKnowledgeIdle(); await whenKnowledgeIdle(); };
const newBase = async (session: Session, name: string) => {
  const created = await send(session, "POST", "/knowledge", { name });
  expect(created.status).toBe(201);
  return created.body.knowledgeBase.id as string;
};
const addText = async (session: Session, kbId: string, title: string, text: string) => {
  const added = await send(session, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title, text });
  expect(added.status).toBe(201);
  return added.body.source.id as string;
};
const embeddingCalls = (provider: typeof providerA) => provider.calls.filter((call) => call.path === "/v1/embeddings").length;
const chunkSizes = (kbId: string) => (db.query("SELECT length(embedding) AS bytes, COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? GROUP BY length(embedding) ORDER BY bytes").all(kbId) as Array<{ bytes: number; count: number }>);
const sourceRow = (id: string) => db.query("SELECT status, error, chunk_count FROM kb_sources WHERE id = ?").get(id) as { status: string; error: string | null; chunk_count: number };
const setBudget = (tokens: number) => writeAgentSettings(admin.userId, { dailyTokensUser: tokens }, readAgentSettings().revision);
const makeDefault = (id: string) => { db.query("UPDATE agent_providers SET is_default = 0").run(); db.query("UPDATE agent_providers SET is_default = 1 WHERE id = ?").run(id); };
const FAQ = "# Support\n\n## How do refunds work?\nRefunds are pro rata and arrive within five days.\n\n## Where is the office?\nThe office is on the third floor beside the library.";

beforeAll(async () => {
  admin = await createUser("KBDEF admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("KBDEF owner");
  manager = await createUser("KBDEF manager");
  viewerShare = await createUser("KBDEF viewer share");
  readOnly = await createUser("KBDEF read-only");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(readOnly.userId);
  stranger = await createUser("KBDEF stranger");
  guest = await createUser("KBDEF guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  friend = await createUser("KBDEF friend");
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake A (knowledge deferred)", baseUrl: providerA.baseUrl, apiKey: "sk-test-fake-key-kbdef-a", defaultModel: "gpt-6-luna", isDefault: true });
  expect(created.status).toBe(201);
  providerAId = created.body.provider.id;
  const second = await send(admin, "POST", "/agents/admin/providers", { name: "Fake B (knowledge deferred)", baseUrl: providerB.baseUrl, apiKey: "sk-test-fake-key-kbdef-b", defaultModel: "gpt-6-luna", embeddingModel: "text-embedding-3-large", embeddingDims: 256 });
  expect(second.status).toBe(201);
  providerBId = second.body.provider.id;
  const third = await send(admin, "POST", "/agents/admin/providers", { name: "Fake C (knowledge deferred)", baseUrl: providerC.baseUrl, apiKey: "sk-test-fake-key-kbdef-c", defaultModel: "gpt-6-luna" });
  expect(third.status).toBe(201);
  providerCId = third.body.provider.id;
  writeAgentSettings(admin.userId, { kbsPerUser: 50 }, readAgentSettings().revision);
});
beforeEach(() => resetKnowledgeTimersForTests());
afterAll(async () => {
  await settle();
  if (readAgentSettings().dailyTokensUser !== 500_000) setBudget(500_000);
  writeAgentSettings(admin.userId, { kbsPerUser: 10 }, readAgentSettings().revision);
  resetKnowledgeTimersForTests();
  for (const id of (db.query("SELECT id FROM agent_providers WHERE name LIKE 'Fake%(knowledge deferred)'").all() as Array<{ id: string }>).map((row) => row.id)) deleteProvider(admin.userId, id);
  providerA.stop();
  providerB.stop();
  providerC.stop();
});

/** A base of the owner with one FAQ source, indexed with provider A, shared with the manager (manage) and viewerShare (view). */
async function sharedBase(name: string) {
  const kbId = await newBase(owner, name);
  const sourceId = await addText(owner, kbId, "Support FAQ", FAQ);
  await settle();
  expect(sourceRow(sourceId).status).toBe("ready");
  await shareItem(owner, `/knowledge/${kbId}`, [{ id: manager.userId, level: "manage" }, { id: viewerShare.userId, level: "view" }, { id: readOnly.userId, level: "view" }]);
  return { kbId, sourceId };
}

describe("Change embedding model", () => {
  test("only the owner may change it: managers and viewers 403, others 404, guests 404, blocked 401", async () => {
    const { kbId } = await sharedBase("Model rights");
    const body = { providerId: providerBId, model: "text-embedding-3-large", dims: 256 };
    expect((await send(manager, "POST", `/knowledge/${kbId}/model`, body)).body.code).toBe("OWNER_ONLY");
    expect((await send(manager, "GET", `/knowledge/${kbId}/embedding-options`)).status).toBe(403);
    expect((await send(viewerShare, "POST", `/knowledge/${kbId}/model`, body)).status).toBe(403);
    // A read-only (viewer role) account is stopped by the write gate before the module.
    expect((await send(readOnly, "POST", `/knowledge/${kbId}/model`, body)).status).toBe(403);
    expect((await send(stranger, "POST", `/knowledge/${kbId}/model`, body)).status).toBe(404);
    expect((await send(stranger, "GET", `/knowledge/${kbId}/embedding-options`)).status).toBe(404);
    expect((await send(guest, "POST", `/knowledge/${kbId}/model`, body)).status).toBe(404);
    // Bad input.
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { ...body, model: "bad model id" })).status).toBe(400);
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { ...body, dims: 32 })).status).toBe(400);
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { ...body, providerId: crypto.randomUUID() })).status).toBe(400);
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerAId, model: "text-embedding-3-small", dims: 512 })).body.code).toBe("UNCHANGED");
    // The owner's options: names and embedding defaults, never an address or key.
    const options = await send(owner, "GET", `/knowledge/${kbId}/embedding-options`);
    expect(options.status).toBe(200);
    expect(options.body.current).toEqual({ providerId: providerAId, model: "text-embedding-3-small", dims: 512 });
    expect(options.body.providers.find((item: { id: string }) => item.id === providerBId)).toMatchObject({ name: "Fake B (knowledge deferred)", embeddingModel: "text-embedding-3-large", embeddingDims: 256 });
    expect(JSON.stringify(options.body)).not.toContain(providerB.baseUrl);
    expect(JSON.stringify(options.body)).not.toContain("sk-test");
    // Blocked: the session is gone.
    const blockedOwner = await createUser("KBDEF blocked owner");
    const blockedKb = await newBase(blockedOwner, "Blocked");
    teamService.blockUser({ id: admin.userId, role: "admin" }, blockedOwner.userId, null, { via: "web" });
    expect((await send(blockedOwner, "POST", `/knowledge/${blockedKb}/model`, body)).status).toBe(401);
    expect(kbRow(blockedKb)!.provider_id).toBe(providerAId);
  });

  test("A → B: one transaction drops the old vectors, search is keyword-only while it runs, and A is never called again", async () => {
    const { kbId, sourceId } = await sharedBase("Model switch");
    expect(chunkSizes(kbId)).toEqual([{ bytes: 512 * 4, count: sourceRow(sourceId).chunk_count }]);
    const chunks = sourceRow(sourceId).chunk_count;
    // Over budget: the re-embed waits (paused), so the switch can be observed.
    setBudget(1);
    const callsA = embeddingCalls(providerA);
    const callsB = embeddingCalls(providerB);
    const changed = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerBId, model: "text-embedding-3-large", dims: 256 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ ok: true, sources: 1 });
    expect(changed.body.knowledgeBase).toMatchObject({ embeddingModel: "text-embedding-3-large", dims: 256, providerName: "Fake B (knowledge deferred)", changingModel: true, notice: MODEL_CHANGING_NOTICE });
    await settle();
    expect(kbRow(kbId)).toMatchObject({ provider_id: providerBId, embedding_model: "text-embedding-3-large", dims: 256 });
    // Every old vector is gone; the text stays (keyword search).
    expect(chunkSizes(kbId)).toEqual([{ bytes: 0, count: chunks }]);
    expect(vectorsOf(kbRow(kbId)!).ids.length).toBe(0);
    expect(sourceRow(sourceId).status).toBe("pending");
    // Keyword-only with the notice, and no query embedding anywhere (no call to A or B).
    const during = await send(viewerShare, "POST", `/knowledge/${kbId}/search`, { query: "How do refunds work?" });
    expect(during.status).toBe(200);
    expect(during.body.mode).toBe("keyword");
    expect(during.body.notice).toBe(MODEL_CHANGING_NOTICE);
    expect(during.body.hits.length).toBeGreaterThan(0);
    expect(during.body.hits[0].ranks.vector).toBeNull();
    expect(embeddingCalls(providerA)).toBe(callsA);
    expect(embeddingCalls(providerB)).toBe(callsB);
    // The hour is used: Re-index and another change wait (429 + Retry-After).
    const again = await send(owner, "POST", `/knowledge/${kbId}/reindex`, {});
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(3000);
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerAId, model: "text-embedding-3-small", dims: 512 })).status).toBe(429);
    // The budget back: B embeds everything, A is never called.
    setBudget(500_000);
    await settle();
    expect(sourceRow(sourceId).status).toBe("ready");
    expect(chunkSizes(kbId)).toEqual([{ bytes: 256 * 4, count: sourceRow(sourceId).chunk_count }]);
    const sent = providerB.calls.filter((call) => call.path === "/v1/embeddings").at(-1)!.body as { model: string; dimensions: number };
    expect(sent).toMatchObject({ model: "text-embedding-3-large", dimensions: 256 });
    const after = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "How do refunds work?" });
    expect(after.body.mode).toBe("hybrid");
    expect(after.body.notice).toBeUndefined();
    expect(after.body.hits[0].ranks.vector).toBe(1);
    expect(embeddingCalls(providerA)).toBe(callsA);
    const detail = await send(owner, "GET", `/knowledge/${kbId}`);
    expect(detail.body.knowledgeBase).toMatchObject({ changingModel: false, notice: null });
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'knowledge.model_change' ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ kbId, providerId: providerBId, model: "text-embedding-3-large", dims: 256 });
  });

  test("a model that answers in its own size is adopted; vectors of two sizes never mix", async () => {
    const kbId = await newBase(owner, "Native size");
    await addText(owner, kbId, "One", FAQ);
    await addText(owner, kbId, "Two", "# Holidays\n\nThe office closes on public holidays.");
    await settle();
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerCId, model: "nomic-embed-text" })).status).toBe(200);
    await settle();
    expect(kbRow(kbId)!.dims).toBe(384);
    expect(chunkSizes(kbId)).toEqual([{ bytes: 384 * 4, count: kbRow(kbId)!.chunk_count }]);
    // No `dimensions` was sent to a model that does not take it.
    const sent = providerC.calls.filter((call) => call.path === "/v1/embeddings").map((call) => call.body as { dimensions?: number });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((body) => body.dimensions === undefined)).toBe(true);
    const search = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "public holidays" });
    expect(search.body.mode).toBe("hybrid");
  });

  test("a batch in flight for the old model is dropped: its result is never written and the next batch is never sent", async () => {
    const slow = startFakeProvider(0, { embedDelayMs: 400 });
    let slowId = "";
    try {
      const made = await send(admin, "POST", "/agents/admin/providers", { name: "Fake slow (knowledge deferred)", baseUrl: slow.baseUrl, apiKey: "sk-test-fake-key-kbdef-s", defaultModel: "gpt-6-luna", isDefault: true });
      expect(made.status).toBe(201);
      slowId = made.body.provider.id;
      const kbId = await newBase(owner, "Mid-batch");
      makeDefault(providerAId);
      // 70 question headings: 70 chunks, two batches of 64 and 6.
      const text = Array.from({ length: 70 }, (_, index) => `## Question number ${index + 1}?\nAnswer ${index + 1}.`).join("\n\n");
      const sourceId = await addText(owner, kbId, "Many", `# Many\n\n${text}`);
      for (let attempt = 0; attempt < 200 && slow.calls.filter((call) => call.path === "/v1/embeddings").length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(embeddingCalls(slow)).toBe(1);
      expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerBId, model: "text-embedding-3-large", dims: 256 })).status).toBe(200);
      await settle();
      // The old provider answered the first batch late; nothing it returned was kept, and its second batch never went.
      expect(embeddingCalls(slow)).toBe(1);
      expect(sourceRow(sourceId)).toMatchObject({ status: "ready", chunk_count: 70 });
      expect(chunkSizes(kbId)).toEqual([{ bytes: 256 * 4, count: 70 }]);
    } finally {
      if (slowId) deleteProvider(admin.userId, slowId);
      makeDefault(providerAId);
      slow.stop();
    }
  });

  test("the way out of a removed provider: allowed within the hour, every errored source embedded again", async () => {
    const extra = startFakeProvider(0);
    try {
      const made = await send(admin, "POST", "/agents/admin/providers", { name: "Fake D (knowledge deferred)", baseUrl: extra.baseUrl, apiKey: "sk-test-fake-key-kbdef-d", defaultModel: "gpt-6-luna", isDefault: true });
      expect(made.status).toBe(201);
      const kbId = await newBase(owner, "Orphaned");
      const sourceId = await addText(owner, kbId, "FAQ", FAQ);
      await settle();
      expect(kbRow(kbId)!.provider_id).toBe(made.body.provider.id);
      // Re-index now: the hour is used.
      expect((await send(owner, "POST", `/knowledge/${kbId}/reindex`, {})).status).toBe(200);
      await settle();
      deleteProvider(admin.userId, made.body.provider.id);
      expect(sourceRow(sourceId)).toMatchObject({ status: "error", error: PROVIDER_REMOVED });
      const page = await send(owner, "GET", `/knowledge/${kbId}`);
      expect(page.body.knowledgeBase.providerName).toBeNull();
      expect(page.body.knowledgeBase.notice).toContain("Change embedding model");
      const changed = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerAId, model: "text-embedding-3-small", dims: 512 });
      expect(changed.status).toBe(200);
      await settle();
      expect(sourceRow(sourceId).status).toBe("ready");
      expect((await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "refunds" })).body.mode).toBe("hybrid");
    } finally {
      // Fake A becomes the default again.
      makeDefault(providerAId);
      extra.stop();
    }
  });
});

describe("Per-source chunk previews", () => {
  test("owner and managers who can read the source; viewers never; pagination; previews only", async () => {
    const kbId = await newBase(owner, "Previews");
    const long = Array.from({ length: 30 }, (_, index) => `## Question ${index + 1}?\n${"Answer text that goes on. ".repeat(20)}`).join("\n\n");
    const textId = await addText(owner, kbId, "Long FAQ", `# Long\n\n${long}`);
    // A note of the owner's own the manager cannot read, and one shared with the manager.
    const privateNote = await publishNote(owner, "# Private plan\n\nThe launch is in March.");
    const sharedNote = await publishNote(owner, "# Shared plan\n\nThe offsite is in May.");
    await shareItem(owner, `/notes/${sharedNote}`, [{ id: manager.userId, level: "view" }, { id: viewerShare.userId, level: "view" }]);
    for (const noteId of [privateNote, sharedNote]) expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId })).status).toBe(201);
    await settle();
    await shareItem(owner, `/knowledge/${kbId}`, [{ id: manager.userId, level: "manage" }, { id: viewerShare.userId, level: "view" }]);
    const ids = db.query("SELECT id, ref_id FROM kb_sources WHERE kb_id = ?").all(kbId) as Array<{ id: string; ref_id: string | null }>;
    const privateSource = ids.find((row) => row.ref_id === privateNote)!.id;
    const sharedSource = ids.find((row) => row.ref_id === sharedNote)!.id;
    const total = sourceRow(textId).chunk_count;
    expect(total).toBeGreaterThan(5);

    // The owner: pages, heading paths, at most 300 characters each.
    const first = await send(owner, "GET", `/knowledge/${kbId}/sources/${textId}/chunks?limit=5`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total, offset: 0, limit: 5 });
    expect(first.body.chunks.length).toBe(5);
    expect(first.body.chunks[0].heading).toContain("Long");
    for (const chunk of first.body.chunks) {
      expect(chunk.preview.length).toBeLessThanOrEqual(300);
      expect(chunk.chars).toBeGreaterThanOrEqual(chunk.preview.length);
      expect(Object.keys(chunk).sort()).toEqual(["chars", "heading", "ord", "preview"]);
    }
    const second = await send(owner, "GET", `/knowledge/${kbId}/sources/${textId}/chunks?offset=5&limit=5`);
    expect(second.body.chunks[0].ord).toBe(first.body.chunks[4].ord + 1);
    const tail = await send(owner, "GET", `/knowledge/${kbId}/sources/${textId}/chunks?offset=${total - 1}`);
    expect(tail.body.chunks.length).toBe(1);
    // Limits are clamped (at most 50), junk falls back to the defaults.
    expect((await send(owner, "GET", `/knowledge/${kbId}/sources/${textId}/chunks?limit=500`)).body.limit).toBe(50);
    expect((await send(owner, "GET", `/knowledge/${kbId}/sources/${textId}/chunks?limit=abc&offset=-3`)).body).toMatchObject({ offset: 0, limit: 20 });
    expect((await send(owner, "GET", `/knowledge/${kbId}/sources/${privateSource}/chunks`)).status).toBe(200);

    // The manager: sources they can read (pasted text, the shared note), not the private note.
    expect((await send(manager, "GET", `/knowledge/${kbId}/sources/${textId}/chunks`)).status).toBe(200);
    expect((await send(manager, "GET", `/knowledge/${kbId}/sources/${sharedSource}/chunks`)).body.chunks[0].preview).toContain("offsite");
    const refused = await send(manager, "GET", `/knowledge/${kbId}/sources/${privateSource}/chunks`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("PREVIEW_REFUSED");
    expect(JSON.stringify(refused.body)).not.toContain("March");

    // Viewers: nothing, even for a note they can open; strangers and guests the 404.
    for (const sourceId of [textId, sharedSource, privateSource]) {
      expect((await send(viewerShare, "GET", `/knowledge/${kbId}/sources/${sourceId}/chunks`)).status).toBe(404);
      expect((await send(stranger, "GET", `/knowledge/${kbId}/sources/${sourceId}/chunks`)).status).toBe(404);
      expect((await send(guest, "GET", `/knowledge/${kbId}/sources/${sourceId}/chunks`)).status).toBe(404);
    }
    // Another base's source through this base: 404.
    const otherKb = await newBase(owner, "Other");
    expect((await send(owner, "GET", `/knowledge/${otherKb}/sources/${textId}/chunks`)).status).toBe(404);

    // The page says who may expand which source.
    const flags = (detail: Reply) => Object.fromEntries((detail.body.knowledgeBase.sources as Array<{ id: string; previewable: boolean }>).map((item) => [item.id, item.previewable]));
    expect(flags(await send(owner, "GET", `/knowledge/${kbId}`))).toEqual({ [textId]: true, [privateSource]: true, [sharedSource]: true });
    expect(flags(await send(manager, "GET", `/knowledge/${kbId}`))).toEqual({ [textId]: true, [privateSource]: false, [sharedSource]: true });
    expect(flags(await send(viewerShare, "GET", `/knowledge/${kbId}`))).toEqual({ [textId]: false, [privateSource]: false, [sharedSource]: false });

    // A blocked manager is signed out.
    const blockedManager = await createUser("KBDEF blocked manager");
    await shareItem(owner, `/knowledge/${kbId}`, [{ id: manager.userId, level: "manage" }, { id: viewerShare.userId, level: "view" }, { id: blockedManager.userId, level: "manage" }]);
    expect((await send(blockedManager, "GET", `/knowledge/${kbId}/sources/${textId}/chunks`)).status).toBe(200);
    teamService.blockUser({ id: admin.userId, role: "admin" }, blockedManager.userId, null, { via: "web" });
    expect((await send(blockedManager, "GET", `/knowledge/${kbId}/sources/${textId}/chunks`)).status).toBe(401);
  });
});

describe("Team → Groups lists knowledge bases", () => {
  test("titles only for admins who can open the base; counts include them", async () => {
    const outsiderAdmin = await createUser("KBDEF outsider admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(outsiderAdmin.userId);
    const group = (await send(admin, "POST", "/team/groups", { name: `KBDEF group ${crypto.randomUUID().slice(0, 8)}` })).body.group;
    const kbId = await newBase(owner, "Grouped base");
    await shareItem(owner, `/knowledge/${kbId}`, [{ id: admin.userId, level: "view" }], [{ id: group.id, level: "manage" }]);
    const page = (await send(admin, "GET", `/team/groups/${group.id}`)).body.group;
    expect(page.grantCount).toBe(1);
    expect(page.items).toEqual([{ kind: "knowledge_base", title: "Grouped base", titleHidden: false, owner: { id: owner.userId, displayName: expect.any(String) }, id: kbId, level: "manage" }]);
    const hidden = (await send(outsiderAdmin, "GET", `/team/groups/${group.id}`)).body.group;
    expect(hidden.items).toHaveLength(1);
    expect(hidden.items[0]).toMatchObject({ kind: "knowledge_base", titleHidden: true, level: "manage" });
    expect(hidden.items[0].id).toBeUndefined();
    expect(JSON.stringify(hidden.items)).not.toContain("Grouped base");
    expect((await send(outsiderAdmin, "GET", "/team/groups")).body.groups.find((row: { id: string }) => row.id === group.id).grantCount).toBe(1);
    // A binned base is not listed or counted.
    expect((await send(owner, "DELETE", `/knowledge/${kbId}`, {})).status).toBe(200);
    expect((await send(admin, "GET", `/team/groups/${group.id}`)).body.group).toMatchObject({ items: [], grantCount: 0 });
    expect((await send(owner, "POST", `/bin/knowledge_base/${kbId}/restore`, {})).status).toBe(200);
    const deleted = await send(admin, "DELETE", `/team/groups/${group.id}`, { revision: (await send(admin, "GET", `/team/groups/${group.id}`)).body.group.revision });
    expect(deleted.body).toMatchObject({ ok: true, removedGrants: 1 });
  });
});

describe("Group-membership hook", () => {
  test("leaving, joining, and deleting a group re-checks the owner's sources at once", async () => {
    const group = (await send(admin, "POST", "/team/groups", { name: `KBDEF hook ${crypto.randomUUID().slice(0, 8)}` })).body.group;
    expect((await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [owner.userId], revision: group.revision })).status).toBe(200);
    const noteId = await publishNote(friend, "# Team handbook\n\nThe espresso machine is descaled on Fridays.");
    await shareItem(friend, `/notes/${noteId}`, [], [{ id: group.id, level: "view" }]);
    const kbId = await newBase(owner, "Through a group");
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId })).status).toBe(201);
    await settle();
    const sourceId = (db.query("SELECT id FROM kb_sources WHERE kb_id = ?").get(kbId) as { id: string }).id;
    expect(sourceRow(sourceId).status).toBe("ready");
    const revision = () => db.query("SELECT revision FROM user_groups WHERE id = ?").get(group.id) as { revision: number };

    // Removed from the group: unavailable and its chunks gone, before any sweep or search.
    expect((await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [], revision: revision().revision })).status).toBe(200);
    expect(sourceRow(sourceId)).toMatchObject({ status: "unavailable", chunk_count: 0 });
    expect((db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE source_id = ?").get(sourceId) as { count: number }).count).toBe(0);

    // Added back: waiting again at once, then indexed.
    expect((await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [owner.userId], revision: revision().revision })).status).toBe(200);
    expect(["pending", "indexing"]).toContain(sourceRow(sourceId).status);
    await settle();
    expect(sourceRow(sourceId).status).toBe("ready");

    // Removed from the member access page.
    expect((await send(admin, "DELETE", `/team/members/${owner.userId}/groups/${group.id}`, {})).status).toBe(200);
    expect(sourceRow(sourceId).status).toBe("unavailable");
    expect((await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [owner.userId], revision: revision().revision })).status).toBe(200);
    await settle();
    expect(sourceRow(sourceId).status).toBe("ready");

    // The group deleted.
    expect((await send(admin, "DELETE", `/team/groups/${group.id}`, { revision: revision().revision })).status).toBe(200);
    expect(sourceRow(sourceId).status).toBe("unavailable");
  });
});

describe("search_knowledge's own limit for keys", () => {
  const kbGrant = (id: string): Grant => ({ module: "agents", permission: "read", resourceKind: "knowledge_base", resourceId: id });
  test("60 a minute and 2,000 a day per key: 429 with Retry-After over REST, RATE_LIMITED over MCP, nothing embedded", async () => {
    const kbId = await newBase(owner, "Limited");
    await addText(owner, kbId, "FAQ", FAQ);
    await settle();
    const key = createApiKey(owner.userId, { name: "KBDEF search", surfaces: "both", grants: [kbGrant(kbId)], expiresInDays: 1 });
    const rest = (body: unknown) => fetch(`${origin}/api/v1/tools/search_knowledge`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = await rest({ query: "refunds" });
    expect(ok.status).toBe(200);
    // Use up the minute (59 more, charged directly), then one more over REST and over MCP.
    for (let index = 1; index < KNOWLEDGE_SEARCH_LIMITS.minute.limit; index += 1) expect(chargeKeySearch(key.id)).toBe(0);
    const calls = embeddingCalls(providerA);
    const refused = await rest({ query: "refunds" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await refused.json() as { code: string; retryAfterSeconds: number };
    expect(body).toMatchObject({ code: "RATE_LIMITED", limit: "search_knowledge" });
    const viaMcp = await invokeMcpToolForTests("search_knowledge", { query: "refunds" }, key.id);
    expect(viaMcp.isError).toBe(true);
    expect(JSON.parse(viaMcp.content[0]!.text)).toMatchObject({ code: "RATE_LIMITED" });
    expect(embeddingCalls(providerA)).toBe(calls);
    // Another key of the same owner is not affected.
    const other = createApiKey(owner.userId, { name: "KBDEF search 2", surfaces: "mcp", grants: [kbGrant(kbId)], expiresInDays: 1 });
    expect((await invokeMcpToolForTests("search_knowledge", { query: "refunds" }, other.id)).isError).not.toBe(true);
    // The day: 2,000 (fixed UTC day).
    const dayKey = createApiKey(owner.userId, { name: "KBDEF search 3", surfaces: "mcp", grants: [kbGrant(kbId)], expiresInDays: 1 });
    const dayStart = Math.floor(Date.now() / KNOWLEDGE_SEARCH_LIMITS.day.windowMs) * KNOWLEDGE_SEARCH_LIMITS.day.windowMs;
    db.query("INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, ?, 0)").run(`kb_search_day:${dayKey.id}`, dayStart, KNOWLEDGE_SEARCH_LIMITS.day.limit);
    expect(JSON.parse((await invokeMcpToolForTests("search_knowledge", { query: "refunds" }, dayKey.id)).content[0]!.text).code).toBe("RATE_LIMITED");
  });
});

describe("v0.33.0 review LOWs", () => {
  test("LOW-1: a blocked owner's base shows no previews (404, previewable false)", async () => {
    const blockedOwner = await createUser("KBDEF previews blocked owner");
    const kbId = await newBase(blockedOwner, "Blocked previews");
    const sourceId = await addText(blockedOwner, kbId, "FAQ", FAQ);
    await settle();
    await shareItem(blockedOwner, `/knowledge/${kbId}`, [{ id: manager.userId, level: "manage" }]);
    expect((await send(manager, "GET", `/knowledge/${kbId}/sources/${sourceId}/chunks`)).status).toBe(200);
    teamService.blockUser({ id: admin.userId, role: "admin" }, blockedOwner.userId, null, { via: "web" });
    try {
      const refused = await send(manager, "GET", `/knowledge/${kbId}/sources/${sourceId}/chunks`);
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toContain("refunds");
      const page = await send(manager, "GET", `/knowledge/${kbId}`);
      expect(page.body.knowledgeBase.sources.map((item: { previewable: boolean }) => item.previewable)).toEqual([false]);
    } finally {
      teamService.unblockUser({ id: admin.userId, role: "admin" }, blockedOwner.userId, { via: "web" });
    }
  });

  test("LOW-2: the member access page's group count leaves binned items out, like the group page", async () => {
    const group = (await send(admin, "POST", "/team/groups", { name: `KBDEF count ${crypto.randomUUID().slice(0, 8)}` })).body.group;
    expect((await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [friend.userId], revision: group.revision })).status).toBe(200);
    const kbId = await newBase(owner, "Counted base");
    await shareItem(owner, `/knowledge/${kbId}`, [], [{ id: group.id, level: "view" }]);
    const memberCount = async () => ((await send(admin, "GET", `/team/members/${friend.userId}/access`)).body.groups as Array<{ id: string; grantCount: number }>).find((row) => row.id === group.id)!.grantCount;
    const pageCount = async () => (await send(admin, "GET", `/team/groups/${group.id}`)).body.group.grantCount as number;
    expect([await memberCount(), await pageCount()]).toEqual([1, 1]);
    expect((await send(owner, "DELETE", `/knowledge/${kbId}`, {})).status).toBe(200);
    expect([await memberCount(), await pageCount()]).toEqual([0, 0]);
  });

  test("LOW-3: the model change audit counts the vectors dropped, not the trigger writes", async () => {
    const kbId = await newBase(owner, "Audit count");
    await addText(owner, kbId, "FAQ", FAQ);
    await settle();
    const chunks = kbRow(kbId)!.chunk_count;
    expect(chunks).toBeGreaterThan(0);
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: providerBId, model: "text-embedding-3-large", dims: 256 })).status).toBe(200);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'knowledge.model_change' ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ kbId, vectorsDropped: chunks });
    await settle();
  });

  test("LOW-4: a preview's heading path is cut at 300 characters too", async () => {
    const kbId = await newBase(owner, "Long heading");
    const heading = `${"Very long heading words ".repeat(20)}end`;
    const sourceId = await addText(owner, kbId, "Long", `# ${heading}\n\nThe body text.`);
    await settle();
    const page = await send(owner, "GET", `/knowledge/${kbId}/sources/${sourceId}/chunks`);
    expect(page.status).toBe(200);
    expect(page.body.chunks[0].heading.length).toBe(300);
    expect(heading.startsWith(page.body.chunks[0].heading)).toBe(true);
  });
});

describe("Re-index hour and search limit survive a restart", () => {
  test.skipIf(!Bun.which("bun"))("a second process on the same data still refuses (429 + Retry-After) and keeps the key's count", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nook-kb-limits-"));
    try {
      const run = (phase: string) => runProbe("knowledgeLimitsProbe.ts", [phase, dataDir]);
      const first = run("first");
      expect(first).toMatchObject({ reindex: "ok", searches: 60, refusedSearch: true });
      const second = run("second");
      expect(second.reindex).toBe("REINDEX_RATE_LIMITED");
      expect(second.retryAfterSeconds).toBeGreaterThan(3000);
      expect(second.dayCount).toBe(60);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT_MS * 2);

  test("the in-process hour comes from SQLite (the cooldown is not a Map)", async () => {
    const kbId = await newBase(owner, "Persistent hour");
    await addText(owner, kbId, "FAQ", FAQ);
    await settle();
    expect((await send(owner, "POST", `/knowledge/${kbId}/reindex`, {})).status).toBe(200);
    const row = db.query("SELECT window_start FROM agent_rate_limits WHERE bucket = ?").get(`kb_reindex:${kbId}`) as { window_start: number } | null;
    expect(row).not.toBeNull();
    expect((await send(owner, "POST", `/knowledge/${kbId}/reindex`, {})).status).toBe(429);
    // An hour later (moved back in the table), allowed again.
    db.query("UPDATE agent_rate_limits SET window_start = ? WHERE bucket = ?").run(Date.now() - knowledgeTimers.reindexCooldownMs - 1000, `kb_reindex:${kbId}`);
    expect((await send(owner, "POST", `/knowledge/${kbId}/reindex`, {})).status).toBe(200);
    await settle();
  });
});
