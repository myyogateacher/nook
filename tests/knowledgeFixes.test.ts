import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";

const { deleteProvider, updateProvider, connectionFor } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { budgetWakeScheduled, knowledgeQueue, resetKnowledgeTimersForTests, scheduleKnowledge, sweepKnowledge, whenKnowledgeIdle } = await import("../server/knowledge/index");
const { headingFor } = await import("../server/knowledge/search");
const { addSource, OWNER_BLOCKED_NOTICE, PROVIDER_REMOVED, PROVIDER_REMOVED_NOTICE } = await import("../server/knowledge/service");
const { batchSizeFor, embedTexts } = await import("../server/knowledge/embed");
const { liveAttachedBases } = await import("../server/knowledge/tool");
const { agentTools } = await import("../server/agents/mcpTools");
const teamService = await import("../server/team/service");
type Grant = import("../server/keyGrants").Grant;

/**
 * Wave 44 fixes (AC-E review and QA): stale chunks from sources the owner can no longer read (M1:
 * unshare, the Bin, a purge, search's own check, and a waiting source over budget), a blocked owner
 * (M2), the pinned provider (M3: removed, or pointed elsewhere), attaching needs manage (M4),
 * Re-index all once an hour (L1), batches by width (L2), round robin (L3), keyword mode (L6), the
 * explicit list_agents reach, guests' 404 on writes (LOW-1), heading paths (LOW-2), the budget pause
 * (LOW-3), and the Bin's restore shape (LOW-6).
 */

retireUsersAfterFile();
const fake = startFakeProvider(0);
const fakeTwo = startFakeProvider(0);
const fakeThree = startFakeProvider(0);
let admin: Session;
let owner: Session;
let friend: Session;
let viewer: Session;
let manager: Session;
let guest: Session;
let providerId: string;

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
async function upload(session: Session, name: string, content: string) {
  const body = new FormData();
  body.append("file", new Blob([content]), name);
  const response = await request("/files?purpose=file", { method: "POST", body }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}
async function share(session: Session, path: string, people: Array<{ id: string; level: string }>) {
  const current = await send(session, "GET", `${path}/access`);
  const saved = await send(session, "PUT", `${path}/access`, { audience: people.length ? "selected" : "private", people, groups: [] }, { "If-Match": current.body.etag });
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
const source = (id: string) => db.query("SELECT * FROM kb_sources WHERE id = ?").get(id) as { status: string; error: string | null; title: string; chunk_count: number; content_hash: string | null };
const chunksOf = (sourceId: string) => (db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE source_id = ?").get(sourceId) as { count: number }).count;
const ftsHits = (word: string) => (db.query("SELECT COUNT(*) AS count FROM kb_chunk_fts WHERE kb_chunk_fts MATCH ?").get(`"${word}"`) as { count: number }).count;
const embeddingCalls = (provider = fake) => provider.calls.filter((call) => call.path === "/v1/embeddings");
const kbSourceFor = (kbId: string, refId: string) => db.query("SELECT id FROM kb_sources WHERE kb_id = ? AND ref_id = ?").get(kbId, refId) as { id: string };
const setBudget = (tokens: number) => writeAgentSettings(admin.userId, { dailyTokensUser: tokens }, readAgentSettings().revision);

beforeAll(async () => {
  admin = await createUser("W44F admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W44F owner");
  friend = await createUser("W44F friend");
  viewer = await createUser("W44F viewer");
  manager = await createUser("W44F manager");
  guest = await createUser("W44F guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (knowledge fixes)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0441", defaultModel: "gpt-6-luna", isDefault: true });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
});
beforeEach(() => resetKnowledgeTimersForTests());
afterAll(async () => {
  await settle();
  knowledgeQueue.passSources = 20;
  if (readAgentSettings().dailyTokensUser !== 500_000) setBudget(500_000);
  resetKnowledgeTimersForTests();
  for (const id of (db.query("SELECT id FROM agent_providers WHERE name LIKE 'Fake%(knowledge fixes%'").all() as Array<{ id: string }>).map((row) => row.id)) deleteProvider(admin.userId, id);
  fake.stop();
  fakeTwo.stop();
  fakeThree.stop();
});

describe("M1: stale chunks leave at once", () => {
  test("unsharing a note from the owner, the Bin, and a purge remove its text at once; a restore brings it back", async () => {
    const kbId = await newBase(owner, "Hooks");
    const friendNote = await publishNote(friend, "# Friend's handbook\n\n## Plants\n\nThe ficus is watered on Tuesdays.");
    await share(friend, `/notes/${friendNote}`, [{ id: owner.userId, level: "view" }]);
    const ownNote = await publishNote(owner, "# Owner's diary\n\n## Lunch\n\nThe cafeteria serves quinoa on Mondays.");
    const fileId = await upload(owner, "garage.md", "# Garage\n\nThe garage door code changes monthly.");
    for (const body of [{ kind: "note", noteId: friendNote }, { kind: "note", noteId: ownNote }, { kind: "document", documentId: fileId }]) {
      expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, body)).status).toBe(201);
    }
    await settle();
    const friendSource = kbSourceFor(kbId, friendNote).id;
    const ownSource = kbSourceFor(kbId, ownNote).id;
    const fileSource = kbSourceFor(kbId, fileId).id;
    for (const id of [friendSource, ownSource, fileSource]) expect(source(id).status).toBe("ready");
    expect(ftsHits("ficus")).toBe(1);

    // Unshare: no sweep needed.
    await share(friend, `/notes/${friendNote}`, []);
    expect(source(friendSource)).toMatchObject({ status: "unavailable", chunk_count: 0 });
    expect(chunksOf(friendSource)).toBe(0);
    expect(ftsHits("ficus")).toBe(0);

    // The Bin (a note and a file).
    expect((await send(owner, "DELETE", `/notes/${ownNote}`, {})).status).toBe(200);
    expect(source(ownSource).status).toBe("unavailable");
    expect(ftsHits("quinoa")).toBe(0);
    expect((await send(owner, "DELETE", `/files/${fileId}`, {})).status).toBe(200);
    expect(source(fileSource).status).toBe("unavailable");
    expect(ftsHits("garage")).toBe(0);

    // A restore: readable again, so indexed again.
    expect((await send(owner, "POST", `/bin/document/${fileId}/restore`, {})).status).toBe(200);
    expect(["pending", "indexing"]).toContain(source(fileSource).status);
    await settle();
    expect(source(fileSource).status).toBe("ready");
    expect(ftsHits("garage")).toBeGreaterThan(0);

    // A purge: no text and no title left anywhere.
    expect((await send(owner, "DELETE", `/bin/note/${ownNote}`, {})).status).toBe(200);
    expect(source(ownSource)).toMatchObject({ status: "unavailable", title: "Deleted note", chunk_count: 0 });
    expect(JSON.stringify(db.query("SELECT * FROM kb_sources WHERE kb_id = ?").all(kbId))).not.toContain("Owner's diary");
    expect(ftsHits("quinoa")).toBe(0);
    db.exec("INSERT INTO kb_chunk_fts (kb_chunk_fts) VALUES ('integrity-check')");
  });

  test("search drops a hit whose source the owner can no longer read, and marks the source afterwards", async () => {
    const kbId = await newBase(owner, "Search check");
    const friendNote = await publishNote(friend, "# Rota\n\n## Kitchen\n\nThe kettle is descaled on Thursdays.");
    await share(friend, `/notes/${friendNote}`, [{ id: owner.userId, level: "view" }]);
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId: friendNote })).status).toBe(201);
    await settle();
    const sourceId = kbSourceFor(kbId, friendNote).id;
    expect((await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "kettle descaled" })).body.hits.length).toBe(1);
    // Access lost behind the hooks' back (straight in SQLite): search alone must not return the text.
    db.query("DELETE FROM note_shares WHERE note_id = ?").run(friendNote);
    db.query("UPDATE notes SET visibility = 'private', sharing_override = 1 WHERE id = ?").run(friendNote);
    const tried = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "kettle descaled" });
    expect(tried.status).toBe(200);
    expect(tried.body.hits).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source(sourceId).status).toBe("unavailable");
    expect(chunksOf(sourceId)).toBe(0);
  });

  test("the sweep checks waiting sources too: one paused on the budget that becomes unreadable loses its chunks", async () => {
    const kbId = await newBase(owner, "Sweep pending");
    const friendNote = await publishNote(friend, "# Parking\n\nVisitors park on level minus two.");
    await share(friend, `/notes/${friendNote}`, [{ id: owner.userId, level: "view" }]);
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "note", noteId: friendNote })).status).toBe(201);
    await settle();
    const sourceId = kbSourceFor(kbId, friendNote).id;
    setBudget(1);
    try {
      // The note changes, so its source waits; over budget, it stays waiting (with its old chunks).
      db.query("UPDATE kb_sources SET status = 'pending', content_hash = NULL WHERE id = ?").run(sourceId);
      scheduleKnowledge(kbId);
      await settle();
      expect(source(sourceId).status).toBe("pending");
      expect(source(sourceId).error).toContain("Paused");
      expect(chunksOf(sourceId)).toBeGreaterThan(0);
      db.query("DELETE FROM note_shares WHERE note_id = ?").run(friendNote);
      db.query("UPDATE notes SET visibility = 'private', sharing_override = 1 WHERE id = ?").run(friendNote);
      expect((await sweepKnowledge()).unavailable).toBe(1);
      expect(source(sourceId).status).toBe("unavailable");
      expect(chunksOf(sourceId)).toBe(0);
    } finally {
      setBudget(500_000);
    }
  });
});

describe("M2: a blocked owner", () => {
  test("their bases pause and answer no search; an unblock resumes them", async () => {
    const blockedOwner = await createUser("W44F blocked owner");
    const kbId = await newBase(blockedOwner, "Paused base");
    await addText(blockedOwner, kbId, "Wifi", "# Wifi\n\nThe guest network password is on the fridge.");
    await settle();
    await share(blockedOwner, `/knowledge/${kbId}`, [{ id: viewer.userId, level: "view" }, { id: manager.userId, level: "manage" }]);
    expect((await send(viewer, "POST", `/knowledge/${kbId}/search`, { query: "guest network" })).body.hits.length).toBe(1);
    const actor = { id: admin.userId, role: "admin" as const };
    teamService.blockUser(actor, blockedOwner.userId, null, { via: "web" });
    try {
      expect((await send(viewer, "POST", `/knowledge/${kbId}/search`, { query: "guest network" })).body.hits).toEqual([]);
      expect((await send(viewer, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.notice).toBe(OWNER_BLOCKED_NOTICE);
      // A manager's new source waits: nothing is sent while the owner is blocked.
      const before = embeddingCalls().length;
      const waiting = await addText(manager, kbId, "Printer", "The printer is on the third floor.");
      await settle();
      await sweepKnowledge();
      await settle();
      expect(source(waiting).status).toBe("pending");
      expect(embeddingCalls().length).toBe(before);
      teamService.unblockUser(actor, blockedOwner.userId, { via: "web" });
      await settle();
      expect(source(waiting).status).toBe("ready");
      expect((await send(viewer, "POST", `/knowledge/${kbId}/search`, { query: "guest network" })).body.hits.length).toBeGreaterThan(0);
      expect((await send(viewer, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.notice).toBeNull();
    } finally {
      if (db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NOT NULL").get(blockedOwner.userId)) teamService.unblockUser(actor, blockedOwner.userId, { via: "web" });
    }
  });
});

describe("M3: the provider is pinned", () => {
  test("a provider pointed elsewhere re-embeds; a removed one fails closed (keyword search with a notice, never the default)", async () => {
    const second = await send(admin, "POST", "/agents/admin/providers", { name: "Fake two (knowledge fixes)", baseUrl: fakeTwo.baseUrl, apiKey: "sk-test-fake-key-0442", defaultModel: "gpt-6-luna", isDefault: true });
    expect(second.status).toBe(201);
    const secondId = second.body.provider.id as string;
    const kbId = await newBase(owner, "Pinned");
    expect(db.query("SELECT provider_id FROM knowledge_bases WHERE id = ?").get(kbId)).toEqual({ provider_id: secondId });
    const sourceId = await addText(owner, kbId, "Keys", "# Keys\n\nSpare office keys are kept by reception.");
    await settle();
    expect(embeddingCalls(fakeTwo).length).toBe(1);
    const firstHash = source(sourceId).content_hash;
    // The default goes back to the first provider; the base keeps its own.
    const firstRevision = (db.query("SELECT revision FROM agent_providers WHERE id = ?").get(providerId) as { revision: number }).revision;
    updateProvider(admin.userId, providerId, { isDefault: true, expectedRevision: firstRevision });

    // Changed: the same provider at another address re-embeds every source (the hash includes it).
    const revision = (db.query("SELECT revision FROM agent_providers WHERE id = ?").get(secondId) as { revision: number }).revision;
    updateProvider(admin.userId, secondId, { baseUrl: fakeThree.baseUrl, expectedRevision: revision });
    await settle();
    expect(embeddingCalls(fakeThree).length).toBe(1);
    expect(source(sourceId).status).toBe("ready");
    expect(source(sourceId).content_hash).not.toBe(firstHash);

    // Removed: every source errors, search is keyword-only with a notice, and the default is never used.
    const before = embeddingCalls().length;
    deleteProvider(admin.userId, secondId);
    expect(source(sourceId)).toMatchObject({ status: "error", error: PROVIDER_REMOVED });
    const tried = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "office keys reception" });
    expect(tried.body).toMatchObject({ mode: "keyword", notice: PROVIDER_REMOVED_NOTICE });
    expect(tried.body.hits.length).toBe(1);
    const page = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase;
    expect(page).toMatchObject({ notice: PROVIDER_REMOVED_NOTICE, status: "error" });
    const added = await addText(owner, kbId, "Later", "Nothing new is indexed.");
    await settle();
    expect(source(added)).toMatchObject({ status: "error", error: PROVIDER_REMOVED });
    await sweepKnowledge();
    await settle();
    expect(embeddingCalls().length).toBe(before);
  });
});

describe("M4: attaching needs manage", () => {
  test("a view-only user cannot attach (API and picker); a downgrade drops the base at run time", async () => {
    const kbId = await newBase(owner, "Manage needed");
    await addText(owner, kbId, "Holidays", "# Holidays\n\nThe office closes between Christmas and New Year.");
    await settle();
    await share(owner, `/knowledge/${kbId}`, [{ id: viewer.userId, level: "view" }, { id: manager.userId, level: "manage" }]);
    const refused = await send(viewer, "POST", "/agents", { name: "Viewer bot", providerId, tools: [{ source: "knowledge", kbId }] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("KB_MANAGE_REQUIRED");
    const viewerCatalog = (await send(viewer, "GET", "/agents/catalog")).body.catalog.knowledge.find((kb: { id: string }) => kb.id === kbId);
    expect(viewerCatalog).toMatchObject({ manageable: false });
    expect((await send(owner, "GET", "/agents/catalog")).body.catalog.knowledge.find((kb: { id: string }) => kb.id === kbId)).toMatchObject({ manageable: true });
    // A manager attaches it to their own agent, and it runs while they manage it.
    const agent = await send(manager, "POST", "/agents", { name: "Manager bot", providerId, tools: [{ source: "knowledge", kbId }] });
    expect(agent.status).toBe(201);
    const agentRow = { id: agent.body.agent.id as string, owner_id: manager.userId };
    expect(liveAttachedBases(agentRow).map((kb) => kb.id)).toEqual([kbId]);
    // Downgraded to view: it drops out like a binned base; the pick stays, shown as no longer managed.
    await share(owner, `/knowledge/${kbId}`, [{ id: viewer.userId, level: "view" }, { id: manager.userId, level: "view" }]);
    expect(liveAttachedBases(agentRow)).toEqual([]);
    expect((await send(manager, "GET", `/agents/${agentRow.id}`)).body.agent.tools).toEqual([{ source: "knowledge", kbId }]);
    expect((await send(manager, "GET", `/agents/catalog?agentId=${agentRow.id}`)).body.catalog.knowledge.find((kb: { id: string }) => kb.id === kbId)).toMatchObject({ manageable: false });
    // Saving the agent keeps the pick (it was already there) but cannot add it anew elsewhere.
    expect((await send(manager, "PATCH", `/agents/${agentRow.id}`, { tools: [{ source: "knowledge", kbId }], expectedRevision: agent.body.agent.revision })).status).toBe(200);
    expect((await send(manager, "POST", "/agents", { name: "Second bot", providerId, tools: [{ source: "knowledge", kbId }] })).status).toBe(403);
  });
});

describe("the review's LOWs", () => {
  test("L1: Re-index all at most once an hour per base (429 with Retry-After)", async () => {
    const kbId = await newBase(friend, "Rate limited");
    await addText(friend, kbId, "One", "Re-index me.");
    await settle();
    expect((await send(friend, "POST", `/knowledge/${kbId}/reindex`, {})).status).toBe(200);
    await settle();
    const again = await send(friend, "POST", `/knowledge/${kbId}/reindex`, {});
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("REINDEX_RATE_LIMITED");
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(3000);
    expect(again.body.error).toContain("less than an hour ago");
  });

  test("L2: batches shrink with the vector width (3072 dimensions: 10 inputs a request)", async () => {
    expect(batchSizeFor(512)).toBe(64);
    expect(batchSizeFor(1536)).toBe(21);
    expect(batchSizeFor(3072)).toBe(10);
    expect(batchSizeFor(null)).toBe(10);
    expect(batchSizeFor(64)).toBe(64);
    const before = embeddingCalls().length;
    const result = await embedTexts(connectionFor(providerId, null), "text-embedding-3-large", 3072, Array.from({ length: 25 }, (_, index) => `passage ${index}`));
    expect(result.vectors.length).toBe(25);
    expect(result.vectors[0]!.length).toBe(3072);
    const calls = embeddingCalls().slice(before).map((call) => (call.body as { input: string[] }).input.length);
    expect(calls).toEqual([10, 10, 5]);
  });

  test("L3: the worker takes bases in turn", async () => {
    const first = await newBase(owner, "Round A");
    const second = await newBase(owner, "Round B");
    knowledgeQueue.passSources = 1;
    try {
      for (const index of [1, 2, 3]) {
        addSource({ userId: owner.userId }, first, { kind: "text", title: `A${index}`, text: `alpha round ${index}` });
        addSource({ userId: owner.userId }, second, { kind: "text", title: `B${index}`, text: `beta round ${index}` });
      }
      const before = embeddingCalls().length;
      scheduleKnowledge(first);
      scheduleKnowledge(second);
      await settle();
      const order = embeddingCalls().slice(before).map((call) => (call.body as { input: string[] }).input[0]!.split(" ")[0]);
      expect(order).toEqual(["alpha", "beta", "alpha", "beta", "alpha", "beta"]);
    } finally {
      knowledgeQueue.passSources = 20;
    }
  });

  test("list_agents reads every agent only when agents:read reaches everything, whatever the scopes say", async () => {
    const mine = await send(owner, "POST", "/agents", { name: "Listed", providerId });
    const other = await send(owner, "POST", "/agents", { name: "Not listed", providerId });
    expect(mine.status).toBe(201);
    const kbId = await newBase(friend, "Scoped");
    await share(friend, `/knowledge/${kbId}`, [{ id: owner.userId, level: "view" }]);
    const grants: Grant[] = [
      { module: "agents", permission: "read", resourceKind: "knowledge_base", resourceId: kbId },
      { module: "agents", permission: "run", resourceKind: "agent", resourceId: mine.body.agent.id }
    ];
    const listAgents = agentTools.find((spec) => spec.name === "list_agents")!;
    const result = await listAgents.handler({}, { keyId: crypto.randomUUID(), userId: owner.userId, name: "Scoped key", scopes: ["agents:read", "agents:run"], grants }) as { agents: Array<{ id: string }> };
    expect(result.agents.map((agent) => agent.id)).toEqual([mine.body.agent.id]);
    expect(result.agents.map((agent) => agent.id)).not.toContain(other.body.agent.id);
  });
});

describe("QA LOWs", () => {
  test("LOW-1: a guest's knowledge writes are the module's 404, not ROLE_READ_ONLY", async () => {
    for (const [method, path] of [["POST", "/knowledge"], ["PATCH", `/knowledge/${crypto.randomUUID()}`], ["POST", `/knowledge/${crypto.randomUUID()}/search`], ["DELETE", `/knowledge/${crypto.randomUUID()}`]] as const) {
      const reply = await send(guest, method, path, method === "POST" && path === "/knowledge" ? { name: "Nope" } : { query: "x" });
      expect(reply.status).toBe(404);
      expect(reply.body.code).not.toBe("ROLE_READ_ONLY");
    }
  });

  test("LOW-2: heading paths drop the note's own title for someone who cannot open it", () => {
    expect(headingFor("Owner's runbook › Escalation › Paging", "Owner's runbook", false)).toBe("Escalation › Paging");
    expect(headingFor("Owner's runbook", "Owner's runbook", false)).toBeNull();
    expect(headingFor("Owner's runbook › Escalation", "Owner's runbook", true)).toBe("Owner's runbook › Escalation");
    expect(headingFor("Other heading › Escalation", "Owner's runbook", false)).toBe("Other heading › Escalation");
    expect(headingFor(null, "Owner's runbook", false)).toBeNull();
  });

  test("LOW-3: every waiting source shows the pause; the midnight wake-up is set; raising the budget wakes the queue", async () => {
    const kbId = await newBase(owner, "Budget pause");
    setBudget(1);
    let ids: string[] = [];
    try {
      ids = [await addText(owner, kbId, "First", "Paused one."), await addText(owner, kbId, "Second", "Paused two."), await addText(owner, kbId, "Third", "Paused three.")];
      await settle();
      for (const id of ids) {
        expect(source(id).status).toBe("pending");
        expect(source(id).error).toContain("Paused");
      }
      expect(budgetWakeScheduled()).toBe(true);
    } finally {
      setBudget(500_000);
    }
    await settle();
    for (const id of ids) expect(source(id)).toMatchObject({ status: "ready", error: null });
  });

  test("LOW-6: restoring a knowledge base from the Bin names the base, not a folder", async () => {
    const kbId = await newBase(friend, "Restorable");
    expect((await send(friend, "DELETE", `/knowledge/${kbId}`, {})).status).toBe(200);
    const restored = await send(friend, "POST", `/bin/knowledge_base/${kbId}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ ok: true, knowledgeBaseId: kbId, knowledgeBaseName: "Restorable" });
  });
});
