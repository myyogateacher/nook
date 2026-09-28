import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { setKeyScopesForTests } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits, consumeMcpLimits, MCP_LIMITS, MCP_USER_LIMITS } = await import("../server/mcpRateLimit");
type McpScope = import("../server/mcpScopes").McpScope;

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string };

/** A key with exactly `scopes` stored, as the keys API would store them. */
function makeKey(session: Session, scopes: McpScope[], name = "Agent") {
  const key = createMcpApiKey(session.userId, name);
  setKeyScopesForTests(key.id, scopes);
  return { id: key.id, token: key.token } satisfies Key;
}

let rpcId = 0;
/** One JSON-RPC call over Streamable HTTP. Handles JSON and SSE responses. */
async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  const json = text.trimStart().startsWith("{")
    ? text
    : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return { status: response.status, body: JSON.parse(json) as { result?: Record<string, unknown>; error?: { code: number; message: string } } };
}

async function toolNames(key: Key) {
  const { body } = await rpc(key, "tools/list");
  return ((body as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name).sort();
}

type ToolOutcome = { isError: boolean; value: Record<string, unknown> };

/** Calls a tool and parses its JSON text content. A JSON-RPC error counts as an error outcome. */
async function callTool(key: Key, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const { status, body } = await rpc(key, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  const envelope = body as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
  if (envelope.error) return { isError: true, value: { error: envelope.error.message } };
  const text = envelope.result!.content[0]!.text;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    value = { error: text };
  }
  return { isError: envelope.result!.isError === true, value };
}

async function json<T>(response: Response) {
  return await response.json() as T;
}

async function publishedNote(session: Session, markdown: string, folderId: string | null = null) {
  const { note } = await json<{ note: { id: string } }>(await request("/notes", { method: "POST", body: JSON.stringify({ folderId }) }, session));
  expect((await request(`/notes/${note.id}/draft`, { method: "PUT", body: JSON.stringify({ markdown, revision: 1 }) }, session)).status).toBe(200);
  expect((await request(`/notes/${note.id}/publish`, { method: "POST", body: "{}" }, session)).status).toBe(200);
  return note.id;
}

const NOTES_READ_TOOLS = ["list_folders", "list_notes", "read_note", "search_notes"];

describe("MCP scopes", () => {
  test("a key created through the API defaults to notes:read and sees only the read tools", async () => {
    const owner = await createUser("Scope default");
    const created = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "Default", password: owner.password }) }, owner);
    expect(created.status).toBe(201);
    const { key } = await json<{ key: Key }>(created);
    expect((db.query("SELECT scopes FROM mcp_api_keys WHERE id = ?").get(key.id) as { scopes: string }).scopes).toBe('["notes:read"]');
    expect(await toolNames(key)).toEqual(NOTES_READ_TOOLS);
  });

  test("the keys API stores chosen scopes with implied reads, lists them, and audits them", async () => {
    const owner = await createUser("Scope chooser");
    const create = (body: Record<string, unknown>) => request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "Chosen", password: owner.password, ...body }) }, owner);
    const created = await create({ scopes: ["files:read", "notes:write-draft"] });
    expect(created.status).toBe(201);
    const { key } = await json<{ key: Key & { scopes: string[] } }>(created);
    expect(key.scopes).toEqual(["notes:read", "notes:write-draft", "files:read"]);
    const listed = await json<{ keys: Array<{ id: string; scopes: string[] }> }>(await request("/mcp/keys", {}, owner));
    expect(listed.keys.find((item) => item.id === key.id)?.scopes).toEqual(["notes:read", "notes:write-draft", "files:read"]);
    const auditRow = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'mcp.key_created'").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(auditRow.metadata_json)).toEqual({ keyId: key.id, name: "Chosen", scopes: ["notes:read", "notes:write-draft", "files:read"] });
    expect(await toolNames(key)).toContain("read_document_text");
    expect(await toolNames(key)).toContain("update_note_draft");

    const tasks = await json<{ key: { scopes: string[] } }>(await create({ scopes: ["tasks:write"] }));
    expect(tasks.key.scopes).toEqual(["tasks:read", "tasks:write"]);
    for (const scopes of [[], ["notes:read", "notes:read"], ["admin"], ["notes:read", "notes:write-draft", "files:read", "tasks:read", "tasks:write", "notes:read"], "notes:read"]) {
      expect((await create({ scopes })).status).toBe(400);
    }
  });

  test("tools are registered only for the key's scopes, and handlers re-check the scope", async () => {
    const owner = await createUser("Scope matrix");
    const filesOnly = makeKey(owner, ["files:read"]);
    const names = await toolNames(filesOnly);
    expect(names).toContain("list_folders");
    for (const tool of ["list_notes", "read_note", "search_notes", "create_note", "update_note_draft", "get_note_draft"]) expect(names).not.toContain(tool);

    // An unregistered tool cannot be called over the transport.
    const hidden = await callTool(filesOnly, "list_notes");
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden.value)).not.toContain("\"notes\"");

    // The handler checks again even when the tool is reached directly.
    const direct = await invokeMcpToolForTests("list_notes", {}, filesOnly.id);
    expect(direct.isError).toBe(true);
    expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });

    const notesKey = makeKey(owner, ["notes:read"]);
    expect((await invokeMcpToolForTests("list_notes", {}, notesKey.id)).isError).toBeUndefined();
  });

  test("a revoked key is refused by the transport and by the handler re-check", async () => {
    const owner = await createUser("Scope revoked");
    const key = makeKey(owner, ["notes:read"]);
    expect((await rpc(key, "tools/list")).status).toBe(200);
    expect((await request(`/mcp/keys/${key.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await rpc(key, "tools/list")).status).toBe(401);
    const direct = await invokeMcpToolForTests("list_notes", {}, key.id);
    expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
  });
});

describe("MCP search_notes and list_folders", () => {
  test("search finds published text the user can read, never drafts, with plain-text snippets", async () => {
    const owner = await createUser("Search owner");
    const reader = await createUser("Search reader");
    const stranger = await createUser("Search stranger");
    const noteId = await publishedNote(owner, "# Quokka field notes\n\nThe quokka smiles near the ferry.");
    // A newer draft that must never be searched or titled from.
    expect((await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# Secret wombat title\n\nquokka wombatdraft", revision: null }) }, owner)).status).toBe(200);
    await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [reader.userId] }) }, owner);

    const ownerKey = makeKey(owner, ["notes:read"]);
    const found = await callTool(ownerKey, "search_notes", { query: "quokka" });
    expect(found.isError).toBe(false);
    const results = found.value.results as Array<{ id: string; title: string; snippet: string; version: number }>;
    expect(results.map((hit) => hit.id)).toEqual([noteId]);
    expect(results[0]!.title).toBe("Quokka field notes");
    expect(results[0]!.version).toBe(1);
    expect(results[0]!.snippet).toContain("quokka");
    expect(results[0]!.snippet).not.toMatch(/[\u0000-\u001f<>]/);
    expect(JSON.stringify(found.value)).not.toContain("wombat");
    expect((await callTool(ownerKey, "search_notes", { query: "wombatdraft" })).value.results).toEqual([]);

    const readerKey = makeKey(reader, ["notes:read"]);
    expect(((await callTool(readerKey, "search_notes", { query: "quokka" })).value.results as unknown[]).length).toBe(1);
    const strangerKey = makeKey(stranger, ["notes:read"]);
    expect((await callTool(strangerKey, "search_notes", { query: "quokka" })).value.results).toEqual([]);

    // Unsharing takes effect at once.
    await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "private", userIds: [] }) }, owner);
    expect((await callTool(readerKey, "search_notes", { query: "quokka" })).value.results).toEqual([]);

    // Folder filter, limit bounds, and FTS syntax treated as words.
    const { folder } = await json<{ folder: { id: string } }>(await request("/folders", { method: "POST", body: JSON.stringify({ name: "Marsupials", parentId: null }) }, owner));
    const inFolder = await publishedNote(owner, "# Numbat\n\nquokka cousin", folder.id);
    const filtered = await callTool(ownerKey, "search_notes", { query: "quokka", folderId: folder.id });
    expect((filtered.value.results as Array<{ id: string }>).map((hit) => hit.id)).toEqual([inFolder]);
    expect((await callTool(ownerKey, "search_notes", { query: "quokka", limit: 21 })).isError).toBe(true);
    expect((await callTool(ownerKey, "search_notes", { query: "quokka OR NEAR(x) title:*" })).isError).toBe(false);

    // Binned notes disappear.
    expect((await request(`/notes/${inFolder}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await callTool(ownerKey, "search_notes", { query: "numbat" })).value.results).toEqual([]);
  });

  test("list_folders follows the GET /api/folders rules for notes:read and files:read keys", async () => {
    const owner = await createUser("Folder owner");
    const reader = await createUser("Folder reader");
    const { folder } = await json<{ folder: { id: string } }>(await request("/folders", { method: "POST", body: JSON.stringify({ name: "Shared plans", parentId: null }) }, owner));
    await request("/folders", { method: "POST", body: JSON.stringify({ name: "Private plans", parentId: null }) }, owner);
    await request(`/folders/${folder.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [reader.userId] }) }, owner);

    const readerKey = makeKey(reader, ["files:read"]);
    const listed = await callTool(readerKey, "list_folders");
    const names = (listed.value.folders as Array<{ name: string; is_owner: number }>).map((item) => item.name);
    const api = await json<{ folders: Array<{ name: string }> }>(await request("/folders", {}, reader));
    expect(names).toEqual(api.folders.map((item) => item.name));
    expect(names).toContain("Shared plans");
    expect(names).not.toContain("Private plans");
  });
});

describe("MCP rate limits", () => {
  test("a key gets 120 calls a minute, then RATE_LIMITED; other keys are unaffected", async () => {
    const owner = await createUser("Rate owner");
    const key = makeKey(owner, ["notes:read"]);
    for (let index = 0; index < MCP_LIMITS.call.limit; index += 1) {
      expect((await invokeMcpToolForTests("list_folders", {}, key.id)).isError).toBeUndefined();
    }
    const limited = await callTool(key, "list_folders");
    expect(limited.isError).toBe(true);
    expect(limited.value).toMatchObject({ code: "RATE_LIMITED" });
    expect(limited.value.retryAfterSeconds).toBeGreaterThan(0);
    const other = makeKey(owner, ["notes:read"]);
    expect((await callTool(other, "list_folders")).isError).toBe(false);
  });

  test("per-user limits span every key of the user", async () => {
    const owner = await createUser("User limit");
    const other = await createUser("User limit other");
    const noteId = await publishedNote(owner, "# Shared budget");
    const userWrites = MCP_USER_LIMITS.write!.limit;
    // Two keys of one user share the 60-writes budget although each key allows 30.
    const first = makeKey(owner, ["notes:write-draft"]);
    const second = makeKey(owner, ["notes:write-draft"]);
    for (let index = 0; index < userWrites; index += 1) {
      const key = index < userWrites / 2 ? first : second;
      await invokeMcpToolForTests("update_note_draft", { noteId, markdown: "x", baseRevision: 99, mode: "replace" }, key.id);
    }
    const third = makeKey(owner, ["notes:write-draft"]);
    expect((await callTool(third, "update_note_draft", { noteId, markdown: "x", baseRevision: 99, mode: "replace" })).value).toMatchObject({ code: "RATE_LIMITED" });
    // Reads are still under the per-user call limit, and other users are unaffected.
    expect((await callTool(third, "get_note_draft", { noteId })).isError).toBe(false);
    const otherNote = await publishedNote(other, "# Other");
    expect((await callTool(makeKey(other, ["notes:write-draft"]), "update_note_draft", { noteId: otherNote, markdown: "y", baseRevision: null, mode: "replace" })).isError).toBe(false);
  });

  test("per-user call and create_note limits apply across keys", () => {
    const start = 5_000_000;
    const callLimit = MCP_USER_LIMITS.call!.limit;
    const keys = Math.ceil(callLimit / MCP_LIMITS.call.limit);
    let admitted = 0;
    for (let key = 0; key <= keys; key += 1) {
      for (let index = 0; index < MCP_LIMITS.call.limit; index += 1) if (consumeMcpLimits({ keyId: `c${key}`, userId: "u" }, ["call"], start) === 0) admitted += 1;
    }
    expect(admitted).toBe(callLimit);
    let created = 0;
    for (let key = 0; key < 3; key += 1) {
      for (let index = 0; index < MCP_LIMITS.create_note.limit; index += 1) if (consumeMcpLimits({ keyId: `n${key}`, userId: "v" }, ["create_note"], start) === 0) created += 1;
    }
    expect(created).toBe(MCP_USER_LIMITS.create_note!.limit);
    // A refused user-level charge does not use the key's own budget.
    expect(consumeMcpLimits({ keyId: "n2" }, ["create_note"], start)).toBe(0);
  });

  test("write and daily buckets are charged only when every bucket has room", () => {
    const start = 1_000_000;
    for (let index = 0; index < MCP_LIMITS.write.limit; index += 1) expect(consumeMcpLimits({ keyId: "k" }, ["call", "write"], start)).toBe(0);
    expect(consumeMcpLimits({ keyId: "k" }, ["call", "write"], start)).toBeGreaterThan(0);
    // The refused write did not use a call.
    expect(consumeMcpLimits({ keyId: "k" }, ["call"], start)).toBe(0);
    // A minute later the write window resets; the daily bucket keeps counting.
    for (let index = 0; index < MCP_LIMITS.create_note.limit; index += 1) {
      expect(consumeMcpLimits({ keyId: "d" }, ["create_note"], start + index)).toBe(0);
    }
    expect(consumeMcpLimits({ keyId: "d" }, ["create_note"], start + 120_000)).toBeGreaterThan(3600);
    expect(consumeMcpLimits({ keyId: "d" }, ["create_note"], start + 86_400_000)).toBe(0);
    expect(consumeMcpLimits({ keyId: "k" }, ["call", "write"], start + 60_000)).toBe(0);
  });
});

type NoteDetailBody = { note: Record<string, unknown> & { markdown: string; draftMcpKeyName: string | null; current_version: number; draft_revision: number | null } };
const versionCount = (noteId: string) => (db.query("SELECT COUNT(*) AS count FROM note_versions WHERE note_id = ?").get(noteId) as { count: number }).count;
const auditRows = (noteId: string, eventType: string) => (db.query("SELECT metadata_json FROM audit_log WHERE note_id = ? AND event_type = ?").all(noteId, eventType) as Array<{ metadata_json: string }>)
  .map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);

describe("MCP draft-only note writes", () => {
  test("write tools need notes:write-draft, which also grants the read tools", async () => {
    const owner = await createUser("Writer scopes");
    const writer = makeKey(owner, ["notes:read", "notes:write-draft"]);
    expect(await toolNames(writer)).toEqual([...NOTES_READ_TOOLS, "create_folder", "create_note", "get_note_draft", "update_note_draft"].sort());
    // Stored without its read scope, the write scope still implies it.
    const writeOnly = makeKey(owner, ["notes:write-draft"]);
    expect(await toolNames(writeOnly)).toContain("list_notes");
    const reader = makeKey(owner, ["notes:read"]);
    expect(await toolNames(reader)).not.toContain("create_note");
    expect((await callTool(reader, "create_note", { markdown: "# Nope" })).isError).toBe(true);
    const direct = await invokeMcpToolForTests("create_note", { markdown: "# Nope" }, reader.id);
    expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect((db.query("SELECT COUNT(*) AS count FROM notes WHERE owner_id = ?").get(owner.userId) as { count: number }).count).toBe(0);
  });

  test("create_note makes an indexed, badged, draft-only note in an owned folder", async () => {
    const owner = await createUser("Creator");
    const other = await createUser("Creator other");
    const key = makeKey(owner, ["notes:write-draft"], "Laptop agent");
    const created = await callTool(key, "create_note", { markdown: "# Agent plan\n\nFeed the axolotl." });
    expect(created.isError).toBe(false);
    const noteId = created.value.noteId as string;
    expect(created.value).toMatchObject({ revision: 1, title: "Agent plan", url: `${origin}/notes/${noteId}` });
    expect(versionCount(noteId)).toBe(0);
    expect(db.query("SELECT current_version, draft_mcp_key_id FROM notes WHERE id = ?").get(noteId)).toEqual({ current_version: 0, draft_mcp_key_id: key.id });
    expect(auditRows(noteId, "mcp.note_create")).toEqual([{ via: "mcp", keyId: key.id }]);

    const detail = await json<NoteDetailBody>(await request(`/notes/${noteId}`, {}, owner));
    expect(detail.note.markdown).toBe("# Agent plan\n\nFeed the axolotl.");
    expect(detail.note.draftMcpKeyName).toBe("Laptop agent");
    expect(detail.note).not.toHaveProperty("draft_mcp_key_id");
    const list = await json<{ notes: Array<{ id: string; draft_mcp_key_name: string | null }> }>(await request("/notes", {}, owner));
    expect(list.notes.find((item) => item.id === noteId)?.draft_mcp_key_name).toBe("Laptop agent");
    // The owner's search finds the draft; MCP search never sees drafts.
    const search = await json<{ results: Array<{ id: string; source: string }> }>(await request("/search?q=axolotl", {}, owner));
    expect(search.results).toEqual([expect.objectContaining({ id: noteId, source: "draft" })]);
    expect((await callTool(key, "search_notes", { query: "axolotl" })).value.results).toEqual([]);

    const { folder } = await json<{ folder: { id: string } }>(await request("/folders", { method: "POST", body: JSON.stringify({ name: "Agent inbox", parentId: null }) }, owner));
    const inFolder = await callTool(key, "create_note", { markdown: "Inbox item", folderId: folder.id });
    expect(inFolder.value.folderId).toBe(folder.id);
    const { folder: foreign } = await json<{ folder: { id: string } }>(await request("/folders", { method: "POST", body: JSON.stringify({ name: "Not yours", parentId: null }) }, other));
    await request(`/folders/${foreign.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [owner.userId] }) }, other);
    expect((await callTool(key, "create_note", { markdown: "Sneaky", folderId: foreign.id })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(key, "create_note", { markdown: "   " })).isError).toBe(true);

    // Opening and publishing is the human step; publishing clears the badge.
    // An MCP-written draft cannot be published without naming the revision the person reviewed.
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner)).status).toBe(400);
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: JSON.stringify({ revision: 1 }) }, owner)).status).toBe(200);
    expect((db.query("SELECT draft_mcp_key_id FROM notes WHERE id = ?").get(noteId) as { draft_mcp_key_id: string | null }).draft_mcp_key_id).toBeNull();
    expect((await json<NoteDetailBody>(await request(`/notes/${noteId}`, {}, owner))).note.draftMcpKeyName).toBeNull();
  });

  test("update_note_draft replaces or appends with revision CAS and never creates a version", async () => {
    const owner = await createUser("Updater");
    const key = makeKey(owner, ["notes:write-draft"], "Editor agent");
    const noteId = await publishedNote(owner, "# Garden\n\nPlant tomatoes.");

    const fresh = await callTool(key, "get_note_draft", { noteId });
    expect(fresh.value).toMatchObject({ noteId, revision: null, hasDraft: false, markdown: "# Garden\n\nPlant tomatoes.", publishedVersion: 1 });

    const appended = await callTool(key, "update_note_draft", { noteId, markdown: "Water the basil.", baseRevision: null, mode: "append" });
    expect(appended.isError).toBe(false);
    expect(appended.value).toMatchObject({ revision: 1, hasDelta: true });
    expect((await callTool(key, "get_note_draft", { noteId })).value).toMatchObject({ revision: 1, markdown: "# Garden\n\nPlant tomatoes.\n\nWater the basil." });
    expect(versionCount(noteId)).toBe(1);
    expect(auditRows(noteId, "mcp.note_draft_update")).toEqual([{ via: "mcp", keyId: key.id, mode: "append", revision: 1 }]);

    // The draft text is indexed in the same write; published search still shows the published text.
    const ownerSearch = await json<{ results: Array<{ id: string; source: string }> }>(await request("/search?q=basil", {}, owner));
    expect(ownerSearch.results).toEqual([expect.objectContaining({ id: noteId, source: "draft" })]);
    expect((await callTool(key, "search_notes", { query: "basil" })).value.results).toEqual([]);

    // A stale revision is refused and nothing changes.
    const stale = await callTool(key, "update_note_draft", { noteId, markdown: "Overwrite", baseRevision: null, mode: "replace" });
    expect(stale.value).toMatchObject({ code: "DRAFT_CHANGED", currentRevision: 1 });

    // The human autosaves; the agent's older revision now loses (T38).
    expect((await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# Garden\n\nHuman edit", revision: 1 }) }, owner)).status).toBe(200);
    expect((await callTool(key, "update_note_draft", { noteId, markdown: "Agent edit", baseRevision: 1, mode: "replace" })).value).toMatchObject({ code: "DRAFT_CHANGED", currentRevision: 2 });
    expect((await json<NoteDetailBody>(await request(`/notes/${noteId}`, {}, owner))).note.markdown).toBe("# Garden\n\nHuman edit");

    const replaced = await callTool(key, "update_note_draft", { noteId, markdown: "# Garden v2\n\nAll new", baseRevision: 2, mode: "replace" });
    expect(replaced.value).toMatchObject({ revision: 3, title: "Garden v2" });
    expect(versionCount(noteId)).toBe(1);
    const detail = await json<NoteDetailBody>(await request(`/notes/${noteId}`, {}, owner));
    expect(detail.note.current_version).toBe(1);
    expect(detail.note.draftMcpKeyName).toBe("Editor agent");

    // Discarding clears the badge.
    expect((await request(`/notes/${noteId}/draft`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((db.query("SELECT draft_mcp_key_id FROM notes WHERE id = ?").get(noteId) as { draft_mcp_key_id: string | null }).draft_mcp_key_id).toBeNull();

    const tooLarge = await callTool(key, "update_note_draft", { noteId, markdown: "x".repeat(2_000_001), baseRevision: null, mode: "replace" });
    expect(tooLarge.isError).toBe(true);
  }, 20_000);

  test("publishing needs the revision the person last saw, so a later MCP write is never published unseen", async () => {
    const owner = await createUser("Publish race");
    const key = makeKey(owner, ["notes:write-draft"], "Racer");
    const noteId = await publishedNote(owner, "# Race\n\nv1");
    // The person autosaves revision 1, then the agent writes revision 2.
    expect((await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# Race\n\nhuman", revision: null }) }, owner)).status).toBe(200);
    expect((await callTool(key, "update_note_draft", { noteId, markdown: "agent text", baseRevision: 1, mode: "append" })).value).toMatchObject({ revision: 2 });

    const stale = await request(`/notes/${noteId}/publish`, { method: "POST", body: JSON.stringify({ revision: 1 }) }, owner);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "DRAFT_CHANGED", currentRevision: 2 });
    // A client that sends no revision cannot publish an MCP-written draft either.
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner)).status).toBe(400);
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: JSON.stringify({ revision: "2" }) }, owner)).status).toBe(400);
    expect(versionCount(noteId)).toBe(1);
    expect((db.query("SELECT draft_mcp_key_id FROM notes WHERE id = ?").get(noteId) as { draft_mcp_key_id: string | null }).draft_mcp_key_id).toBe(key.id);

    // After reviewing revision 2, the person publishes it.
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: JSON.stringify({ revision: 2 }) }, owner)).status).toBe(200);
    expect(versionCount(noteId)).toBe(2);
    // A human-only draft still publishes without a revision (older clients).
    expect((await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# Race\n\nv3", revision: null }) }, owner)).status).toBe(200);
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
  });

  test("shared, binned, and other users' notes are reported as not found", async () => {
    const owner = await createUser("Draft owner");
    const reader = await createUser("Draft reader");
    const sharedId = await publishedNote(owner, "# Shared\n\nfor everyone");
    await request(`/notes/${sharedId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [reader.userId] }) }, owner);
    const readerKey = makeKey(reader, ["notes:write-draft"]);
    // Readable, but not owned: writes and draft reads look exactly like a missing note.
    expect((await callTool(readerKey, "read_note", { noteId: sharedId })).isError).toBe(false);
    const missing = await callTool(readerKey, "get_note_draft", { noteId: crypto.randomUUID() });
    const shared = await callTool(readerKey, "get_note_draft", { noteId: sharedId });
    expect(shared.value).toEqual(missing.value);
    expect(shared.value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(readerKey, "update_note_draft", { noteId: sharedId, markdown: "vandal", baseRevision: null, mode: "replace" })).value).toMatchObject({ code: "NOT_FOUND" });

    const ownerKey = makeKey(owner, ["notes:write-draft"]);
    const binned = await publishedNote(owner, "# Binned\n\ngone");
    expect((await request(`/notes/${binned}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await callTool(ownerKey, "get_note_draft", { noteId: binned })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(ownerKey, "update_note_draft", { noteId: binned, markdown: "back", baseRevision: null, mode: "append" })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((db.query("SELECT draft_revision FROM notes WHERE id = ?").get(sharedId) as { draft_revision: number | null }).draft_revision).toBeNull();
  });

  test("writes are limited to 30 a minute per key, and create_note also counts per day", async () => {
    const owner = await createUser("Write limit");
    const key = makeKey(owner, ["notes:write-draft"]);
    const noteId = await publishedNote(owner, "# Limited");
    for (let index = 0; index < MCP_LIMITS.write.limit; index += 1) {
      // A refused CAS is still a write attempt.
      await invokeMcpToolForTests("update_note_draft", { noteId, markdown: "x", baseRevision: 99, mode: "replace" }, key.id);
    }
    expect((await callTool(key, "update_note_draft", { noteId, markdown: "x", baseRevision: null, mode: "replace" })).value).toMatchObject({ code: "RATE_LIMITED" });
    expect((await callTool(key, "create_note", { markdown: "x" })).value).toMatchObject({ code: "RATE_LIMITED" });
    // Reads still work within the call limit.
    expect((await callTool(key, "get_note_draft", { noteId })).isError).toBe(false);
  });
});

async function uploadFile(session: Session, content: string | Uint8Array, filename: string) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "application/octet-stream" }), filename);
  const response = await request("/files", { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return (await json<{ document: { id: string; preview_kind: string } }>(response)).document;
}

describe("MCP document tools", () => {
  test("files:read exposes the document tools and list_folders only", async () => {
    const owner = await createUser("Files scopes");
    expect(await toolNames(makeKey(owner, ["files:read"]))).toEqual(["get_document_metadata", "list_documents", "list_folders", "read_document_text"]);
    const notesKey = makeKey(owner, ["notes:read", "notes:write-draft"]);
    expect(await toolNames(notesKey)).not.toContain("list_documents");
    const direct = await invokeMcpToolForTests("read_document_text", { documentId: crypto.randomUUID() }, notesKey.id);
    expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  test("text files are read as strict UTF-8; PDFs, binaries, and files over 1 MiB are refused", async () => {
    const owner = await createUser("Files reader");
    const reader = await createUser("Files recipient");
    const stranger = await createUser("Files stranger");
    const key = makeKey(owner, ["files:read"]);
    const text = await uploadFile(owner, "Grocery list: café, naïve bread\n", "list.txt");
    expect(text.preview_kind).toBe("text");

    const read = await callTool(key, "read_document_text", { documentId: text.id });
    expect(read.value).toMatchObject({ id: text.id, name: "list.txt", text: "Grocery list: café, naïve bread\n" });
    const metadata = await callTool(key, "get_document_metadata", { documentId: text.id });
    expect(metadata.value.document).toMatchObject({ id: text.id, name: "list.txt", preview_kind: "text" });
    for (const secret of ["sha256", "upload_key", "objects", "deleted_at", "purpose"]) expect(JSON.stringify(metadata.value)).not.toContain(secret);
    const listed = await callTool(key, "list_documents");
    expect((listed.value.documents as Array<{ id: string }>).map((item) => item.id)).toContain(text.id);

    const pdf = await uploadFile(owner, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "paper.pdf");
    expect(pdf.preview_kind).toBe("pdf");
    expect((await callTool(key, "read_document_text", { documentId: pdf.id })).value).toMatchObject({ code: "NOT_TEXT" });
    const binary = await uploadFile(owner, new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9]), "blob.bin");
    expect((await callTool(key, "read_document_text", { documentId: binary.id })).value).toMatchObject({ code: "NOT_TEXT" });
    const large = await uploadFile(owner, "a".repeat(1_048_577), "large.txt");
    expect(large.preview_kind).toBe("text");
    expect((await callTool(key, "read_document_text", { documentId: large.id })).value).toMatchObject({ code: "TOO_LARGE" });
    // The sniffer only samples the start; the full read is strict.
    const tail = new Uint8Array(6000).fill(0x61);
    tail[5999] = 0xff;
    const badTail = await uploadFile(owner, tail, "tail.txt");
    expect(badTail.preview_kind).toBe("text");
    expect((await callTool(key, "read_document_text", { documentId: badTail.id })).value).toMatchObject({ code: "NOT_TEXT" });

    // Sharing, the Bin, and non-Files documents follow the Files list predicate.
    await request(`/files/${text.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [reader.userId] }) }, owner);
    expect((await callTool(makeKey(reader, ["files:read"]), "read_document_text", { documentId: text.id })).isError).toBe(false);
    const strangerKey = makeKey(stranger, ["files:read"]);
    const hidden = await callTool(strangerKey, "read_document_text", { documentId: text.id });
    expect(hidden.value).toEqual((await callTool(strangerKey, "read_document_text", { documentId: crypto.randomUUID() })).value);
    expect(hidden.value).toMatchObject({ code: "NOT_FOUND" });

    const attachment = await uploadFile(owner, "attached notes", "attached.txt");
    db.query("UPDATE documents SET purpose = 'task_attachment', folder_id = NULL WHERE id = ?").run(attachment.id);
    expect((await callTool(key, "get_document_metadata", { documentId: attachment.id })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(key, "read_document_text", { documentId: attachment.id })).value).toMatchObject({ code: "NOT_FOUND" });

    expect((await request(`/files/${text.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await callTool(key, "get_document_metadata", { documentId: text.id })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(key, "read_document_text", { documentId: text.id })).value).toMatchObject({ code: "NOT_FOUND" });
    const after = await callTool(key, "list_documents");
    expect((after.value.documents as Array<{ id: string }>).map((item) => item.id)).not.toContain(text.id);
  }, 20_000);
});
