import { describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { newCollection, shareCollection } from "./support/collections";

/**
 * Wave 36 review probes (D287, T212, D73): an admin who creates an integration and holds its key
 * reaches only what owners shared with the integration by name. One member makes one private and
 * one "everyone signed in" item per module; the integration's widest read key must see none of
 * them through any list, search, query, Today, or single read, and must see a named share.
 */

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}
const send = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
};
const ok = async (session: Session, method: string, path: string, body?: unknown) => {
  const result = await send(session, method, path, body);
  expect({ path, status: result.status < 300 ? "ok" : result.text }).toEqual({ path, status: "ok" });
  return result.body;
};
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/api/v1/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  return { status: response.status, text: await response.text() };
}
async function publishedNote(owner: Session, folderId: string | null, markdown: string) {
  const id = (await ok(owner, "POST", "/notes", { folderId })).note.id as string;
  await ok(owner, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 });
  await ok(owner, "POST", `/notes/${id}/publish`);
  return id;
}
async function upload(owner: Session, name: string, folderId?: string) {
  const form = new FormData();
  form.append("file", new Blob(["integration probe"], { type: "text/plain" }), name);
  const response = await request(`/files${folderId ? `?folderId=${folderId}` : ""}`, { method: "POST", body: form }, owner);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

describe("review: an admin holding an integration's key (D73)", () => {
  test("reaches no private or everyone item of a member, through any read tool; a named share does reach it", async () => {
    const admin = await user("Rev36 admin", "admin");
    const owner = await user("Rev36 owner");
    const marker = `rev36${crypto.randomUUID().slice(0, 8)}`;

    const bot = (await ok(admin, "POST", "/team/integrations", { name: "Rev36 bot", role: "member" })).integration as { id: string };
    const grants = ["notes", "files", "tasks", "today", "calendar", "collections", "whiteboards"].map((module) => ({ module, permission: "read" }));
    const created = await send(admin, "POST", `/team/integrations/${bot.id}/keys`, { name: "Probe", surfaces: "rest", expiresInDays: 30, grants, password: admin.password });
    expect(created.status).toBe(201);
    const token = created.body.key.token as string;

    // Everyone signed in, in every module; and a private twin of each.
    const everyoneFolder = (await ok(owner, "POST", "/folders", { name: `${marker} everyone`, parentId: null })).folder.id as string;
    await ok(owner, "PUT", `/folders/${everyoneFolder}/sharing`, { visibility: "all_users", userIds: [] });
    const noteInFolder = await publishedNote(owner, everyoneFolder, `# Folder ${marker}`);
    const noteOverride = await publishedNote(owner, null, `# Override ${marker}`);
    await ok(owner, "PUT", `/notes/${noteOverride}/sharing`, { visibility: "all_users", userIds: [] });
    const privateNote = await publishedNote(owner, null, `# Private ${marker}`);
    const fileInFolder = await upload(owner, `${marker}-folder.txt`, everyoneFolder);
    const fileOverride = await upload(owner, `${marker}-override.txt`);
    await ok(owner, "PUT", `/files/${fileOverride}/sharing`, { visibility: "all_users", userIds: [] });
    const whiteboard = (await ok(owner, "POST", "/whiteboards", { name: `${marker} board`, folderId: everyoneFolder })).whiteboard.id as string;
    const board = await ok(owner, "POST", "/tasks/boards", { name: `${marker} everyone board` });
    await ok(owner, "PUT", `/tasks/boards/${board.board.id}/sharing`, { visibility: "all_users", userIds: [] });
    const card = (await ok(owner, "POST", `/tasks/boards/${board.board.id}/cards`, { columnId: board.columns[0].id, title: `${marker} everyone card` })).card.id as string;
    const view = (await ok(owner, "POST", "/tasks/views", { name: `${marker} view`, query: "" })).view.id as string;
    await ok(owner, "PUT", `/tasks/views/${view}/sharing`, { visibility: "all_users", userIds: [] });
    const collection = await newCollection(owner, { name: `${marker} everyone collection`, fields: [{ name: "Name", type: "text" }] });
    await shareCollection(owner, collection.id, "all_users", [], "editor");
    const calendar = (await ok(owner, "POST", "/calendars", { name: `${marker} everyone calendar`, color: "green" })).calendar.id as string;
    await ok(owner, "PUT", `/calendars/${calendar}/sharing`, { visibility: "all_users", shareRole: "editor", userIds: [] });
    const event = (await ok(owner, "POST", `/calendars/${calendar}/events`, { allDay: false, startLocal: "2026-05-04T09:00", tz: "UTC", durationMinutes: 30, title: `${marker} everyone event` })).event.id as string;

    const hidden = [everyoneFolder, noteInFolder, noteOverride, privateNote, fileInFolder, fileOverride, whiteboard, board.board.id, card, view, collection.id, calendar, event];

    const reads: Array<[string, Record<string, unknown>]> = [
      ["list_notes", {}], ["list_folders", {}], ["search_notes", { query: marker }], ["list_documents", {}], ["list_whiteboards", {}],
      ["list_boards", {}], ["list_views", {}], ["query_cards", { filter: "" }], ["search_cards", { query: marker }], ["get_today", {}],
      ["list_collections", {}], ["list_calendars", {}], ["list_events", { from: "2026-05-01", to: "2026-05-10" }]
    ];
    const seen: string[] = [];
    for (const [name, args] of reads) {
      const result = await tool(token, name, args);
      expect({ name, status: result.status }).toEqual({ name, status: 200 });
      seen.push(result.text);
    }
    const everything = seen.join("\n");
    for (const id of hidden) expect({ id, listed: everything.includes(id) }).toEqual({ id, listed: false });
    // No title either (search tools must not echo a match); the context makes a failure readable.
    for (const [index, text] of seen.entries()) {
      const at = text.indexOf(marker);
      const name = reads[index]![0];
      expect({ name, context: at < 0 ? null : text.slice(Math.max(0, at - 120), at + 60) }).toEqual({ name, context: null });
    }

    // Single reads by id: not found.
    const singles: Array<[string, Record<string, unknown>]> = [
      ["read_note", { noteId: noteOverride }], ["read_note", { noteId: noteInFolder }], ["read_note", { noteId: privateNote }],
      ["read_document_text", { documentId: fileOverride }], ["get_card", { cardId: card }], ["get_event", { eventId: event }],
      ["query_cards", { viewId: view }], ["query_rows", { collectionId: collection.id }], ["read_whiteboard", { id: whiteboard }]
    ];
    for (const [name, args] of singles) {
      const result = await tool(token, name, args);
      expect({ name, status: result.status, leaks: result.text.includes(marker) }).toEqual({ name, status: 404, leaks: false });
    }

    // The admin's picker for chosen-item grants offers none of it either.
    for (const module of ["notes", "files", "tasks", "calendar", "collections", "whiteboards"]) {
      const resources = await send(admin, "GET", `/team/integrations/${bot.id}/resources?module=${module}`);
      expect({ module, leaks: resources.text.includes(marker) }).toEqual({ module, leaks: false });
    }

    // Shared by name, it is reached.
    await ok(owner, "PUT", `/notes/${privateNote}/sharing`, { visibility: "selected", userIds: [bot.id] });
    const named = await tool(token, "read_note", { noteId: privateNote });
    expect(named.status).toBe(200);
    expect(named.text).toContain(`Private ${marker}`);

    // Leave no everyone items behind for other test files.
    await send(owner, "PUT", `/folders/${everyoneFolder}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/notes/${noteOverride}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/files/${fileOverride}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/tasks/boards/${board.board.id}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/tasks/views/${view}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/collections/${collection.id}/sharing`, { visibility: "private", userIds: [], role: "viewer" });
    await send(owner, "PUT", `/calendars/${calendar}/sharing`, { visibility: "private", shareRole: "viewer", userIds: [] });
  }, 30_000);
});

describe("review: integration lifecycle (role cap, block, delete, tombstone)", () => {
  const makeKey = (admin: Session, id: string, grants: unknown[]) =>
    send(admin, "POST", `/team/integrations/${id}/keys`, { name: `Key ${crypto.randomUUID().slice(0, 6)}`, surfaces: "rest", expiresInDays: 30, grants, password: admin.password });

  test("a member integration demoted to viewer loses writes on its existing key at once", async () => {
    const admin = await user("Rev36 cap admin", "admin");
    const owner = await user("Rev36 cap owner");
    const bot = (await ok(admin, "POST", "/team/integrations", { name: "Rev36 cap bot", role: "member" })).integration as { id: string };
    const board = await ok(owner, "POST", "/tasks/boards", { name: "Rev36 cap board" });
    const etag = (await send(owner, "GET", `/tasks/boards/${board.board.id}/access`)).body.etag as string;
    const shared = await request(`/tasks/boards/${board.board.id}/access`, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ audience: "selected", people: [{ id: bot.id, level: "edit" }], groups: [] }) }, owner);
    expect(shared.status).toBe(200);
    const key = await makeKey(admin, bot.id, [{ module: "tasks", permission: "write" }]);
    expect(key.status).toBe(201);
    const token = key.body.key.token as string;
    const card = (title: string) => tool(token, "create_card", { boardId: board.board.id, columnId: board.columns[0].id, title });
    expect((await card("Before")).status).toBe(200);
    expect((await send(admin, "PATCH", `/team/integrations/${bot.id}`, { role: "viewer", expectedRole: "member" })).status).toBe(200);
    expect((await card("After")).status).toBe(403);
  });

  test("delete of a key-only integration erases its key rows and usage; a tombstone can be unblocked and re-keyed", async () => {
    const admin = await user("Rev36 life admin", "admin");
    const bot = (await ok(admin, "POST", "/team/integrations", { name: "Rev36 quiet bot", role: "member" })).integration as { id: string };
    const key = await makeKey(admin, bot.id, [{ module: "notes", permission: "read" }]);
    expect(key.status).toBe(201);
    expect((await tool(key.body.key.token, "list_notes")).status).toBe(200);
    const keyId = key.body.key.id as string;
    expect((db.query("SELECT last_used_at FROM mcp_api_keys WHERE id = ?").get(keyId) as { last_used_at: string | null }).last_used_at).not.toBeNull();

    // Blocked: no new key and no rotation (409).
    await ok(admin, "POST", `/team/integrations/${bot.id}/block`, {});
    expect((await makeKey(admin, bot.id, [{ module: "notes", permission: "read" }])).status).toBe(409);
    expect((await send(admin, "POST", `/team/integrations/${bot.id}/keys/${keyId}/rotate`, { graceHours: 0, password: admin.password })).status).toBe(409);
    await ok(admin, "POST", `/team/integrations/${bot.id}/unblock`, {});

    // Hard delete (it only read): the revoked key, its grants, and its usage go with it; only logs keep the id.
    const gone = await send(admin, "DELETE", `/team/integrations/${bot.id}`, {});
    expect(gone.body).toMatchObject({ deleted: true, keysRevoked: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE id = ?").get(keyId)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = ?").get(keyId)).toEqual({ count: 0 });
    expect((db.query("SELECT COUNT(*) AS count FROM access_events WHERE key_id = ?").get(keyId) as { count: number }).count).toBeGreaterThan(0);

    // A tombstone (it made something) is an ordinary blocked integration: Unblock brings it back and it can be keyed again.
    const busy = (await ok(admin, "POST", "/team/integrations", { name: "Rev36 busy bot", role: "member" })).integration as { id: string };
    const folder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(busy.id) as { id: string }).id;
    const stamp = new Date().toISOString();
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, is_default) VALUES (?, ?, ?, 'Made by bot', ?, ?, 0)").run(crypto.randomUUID(), busy.id, folder, stamp, stamp);
    const retired = await send(admin, "DELETE", `/team/integrations/${busy.id}`, {});
    expect(retired.body).toMatchObject({ deleted: false, retained: true, integration: { status: "blocked" } });
    expect((await send(admin, "POST", `/team/integrations/${busy.id}/unblock`, {})).status).toBe(200);
    expect((await makeKey(admin, busy.id, [{ module: "notes", permission: "read" }])).status).toBe(201);
  });
});
