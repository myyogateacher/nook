import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, newCollection } from "./support/collections";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { itemLevel } = await import("../server/access/effective");

/**
 * Per-person levels (Wave 32, access plan D266, D272, §D.3): every module's level resolver, what
 * each level may and may not do, the Team role cap, and the older `/sharing` routes keeping levels.
 */

beforeEach(() => resetTeamRateLimits());

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function send(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

const setLevel = (table: string, column: string, id: string, userId: string, level: string) =>
  db.query(`UPDATE ${table} SET level = ? WHERE ${column} = ? AND user_id = ?`).run(level, id, userId);

describe("board levels (viewer, commenter, editor)", () => {
  test("view reads, comment also comments and reacts, edit changes cards; structure stays the owner's", async () => {
    const owner = await user("Level board owner");
    const person = await user("Level board person");
    const created = (await send(owner, "POST", "/tasks/boards", { name: "Levels board" })).body;
    const boardId = created.board.id as string;
    const columnId = created.columns[0].id as string;
    const card = (await send(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Owner card" })).body.card;
    const comment = (await send(owner, "POST", `/tasks/cards/${card.id}/comments`, { body: "Owner comment" })).body.comment;
    // The older route adds people at edit (D38 is kept for every existing and new member).
    expect((await send(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [person.userId] })).status).toBe(200);
    expect(db.query("SELECT level FROM board_members WHERE board_id = ? AND user_id = ?").get(boardId, person.userId)).toEqual({ level: "edit" });
    expect(itemLevel("board", boardId, person.userId)).toBe("edit");
    expect(itemLevel("board", boardId, owner.userId)).toBe("owner");

    const tryAll = async () => ({
      read: (await send(person, "GET", `/tasks/boards/${boardId}`)).status,
      createCard: (await send(person, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Person card" })).status,
      patchCard: (await send(person, "PATCH", `/tasks/cards/${card.id}`, { title: "Renamed", revision: (await send(owner, "GET", `/tasks/cards/${card.id}`)).body.card.revision })).status,
      comment: (await send(person, "POST", `/tasks/cards/${card.id}/comments`, { body: "Hello" })).status,
      react: (await send(person, "PUT", `/tasks/comments/${comment.id}/reactions/thumbs_up`)).status,
      tag: (await send(person, "POST", `/tasks/boards/${boardId}/tags`, { name: `T${crypto.randomUUID().slice(0, 6)}` })).status,
      column: (await send(person, "POST", `/tasks/boards/${boardId}/columns`, { name: "New column" })).status
    });

    setLevel("board_members", "board_id", boardId, person.userId, "view");
    const view = await tryAll();
    expect(view).toEqual({ read: 200, createCard: 403, patchCard: 403, comment: 403, react: 403, tag: 403, column: 403 });
    expect((await send(person, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "x" })).body.code).toBe("READ_ONLY");
    expect((await send(person, "GET", `/tasks/boards/${boardId}`)).body.board.level).toBe("view");

    setLevel("board_members", "board_id", boardId, person.userId, "comment");
    const commenter = await tryAll();
    expect(commenter).toEqual({ read: 200, createCard: 403, patchCard: 403, comment: 201, react: 200, tag: 403, column: 403 });

    setLevel("board_members", "board_id", boardId, person.userId, "edit");
    const editor = await tryAll();
    expect(editor.createCard).toBe(201);
    expect(editor.patchCard).toBe(200);
    expect(editor.comment).toBe(201);
    expect(editor.tag).toBe(201);
    expect(editor.column).toBe(403);

    // The older sharing route keeps a person's level when the owner re-shares.
    setLevel("board_members", "board_id", boardId, person.userId, "comment");
    const other = await user("Level board other");
    await send(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [person.userId, other.userId] });
    expect(db.query("SELECT user_id, level FROM board_members WHERE board_id = ? ORDER BY level").all(boardId)).toEqual([
      { user_id: person.userId, level: "comment" }, { user_id: other.userId, level: "edit" }
    ]);
  }, 20_000);

  test("the highest grant wins (direct or group) and the Team role caps it", async () => {
    const admin = await user("Level cap admin", "admin");
    const owner = await user("Level cap owner");
    const person = await user("Level cap person");
    const created = (await send(owner, "POST", "/tasks/boards", { name: "Cap board" })).body;
    const boardId = created.board.id as string;
    await send(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [person.userId] });
    setLevel("board_members", "board_id", boardId, person.userId, "view");
    const group = (await send(admin, "POST", "/team/groups", { name: `Cap ${crypto.randomUUID().slice(0, 8)}` })).body.group;
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [person.userId], revision: 1 });
    db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, created_at) VALUES ('board', ?, ?, 'edit', ?)").run(boardId, group.id, new Date().toISOString());
    expect(itemLevel("board", boardId, person.userId)).toBe("edit");
    expect((await send(person, "POST", `/tasks/boards/${boardId}/cards`, { columnId: created.columns[0].id, title: "Via group" })).status).toBe(201);
    // A viewer reads at most, whatever the grants say (D71).
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(person.userId);
    expect(itemLevel("board", boardId, person.userId)).toBe("view");
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(person.userId);
    // Blocked accounts reach nothing.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), person.userId);
    expect(itemLevel("board", boardId, person.userId)).toBe("none");
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(person.userId);
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
    expect(itemLevel("board", boardId, person.userId)).toBe("view");
  });

  test("an everyone board uses its audience level (boards.share_role)", async () => {
    const owner = await user("Level everyone owner");
    const person = await user("Level everyone person");
    const created = (await send(owner, "POST", "/tasks/boards", { name: "Everyone levels" })).body;
    const boardId = created.board.id as string;
    await send(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "all_users", userIds: [] });
    expect(itemLevel("board", boardId, person.userId)).toBe("edit");
    db.query("UPDATE boards SET share_role = 'view' WHERE id = ?").run(boardId);
    expect(itemLevel("board", boardId, person.userId)).toBe("view");
    expect((await send(person, "POST", `/tasks/boards/${boardId}/cards`, { columnId: created.columns[0].id, title: "x" })).status).toBe(403);
    await send(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "private", userIds: [] });
    expect(itemLevel("board", boardId, person.userId)).toBe("none");
  });
});

describe("note editors (D274)", () => {
  test("an editor writes the shared draft and publishes a version authored by them, but never shares, moves, discards, restores, or deletes", async () => {
    const owner = await user("Editor note owner");
    const editor = await user("Editor note editor");
    const reader = await user("Editor note reader");
    const note = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    await send(owner, "PUT", `/notes/${note}/draft`, { markdown: "# Plan\n\nOwner text", revision: 1 });
    await send(owner, "POST", `/notes/${note}/publish`);
    await send(owner, "PUT", `/notes/${note}/sharing`, { visibility: "selected", userIds: [editor.userId, reader.userId] });
    setLevel("note_shares", "note_id", note, editor.userId, "edit");

    const opened = (await send(editor, "GET", `/notes/${note}`)).body.note;
    expect({ isOwner: opened.isOwner, level: opened.level, canEdit: opened.canEdit }).toEqual({ isOwner: false, level: "edit", canEdit: true });
    expect((await send(reader, "GET", `/notes/${note}`)).body.note).toMatchObject({ level: "view", canEdit: false });

    // The reader cannot write; the editor can, with the draft revision CAS.
    expect((await send(reader, "PUT", `/notes/${note}/draft`, { markdown: "# Nope", revision: null })).status).toBe(404);
    const saved = await send(editor, "PUT", `/notes/${note}/draft`, { markdown: "# Plan\n\nEditor text", revision: null });
    expect(saved.status).toBe(200);
    expect((await send(editor, "PUT", `/notes/${note}/draft`, { markdown: "# Stale", revision: saved.body.revision - 1 })).status).toBe(409);
    // The owner sees the editor's draft (one shared draft per note).
    expect((await send(owner, "GET", `/notes/${note}`)).body.note.markdown).toContain("Editor text");
    // The editor sees it when reopening too.
    expect((await send(editor, "GET", `/notes/${note}`)).body.note).toMatchObject({ hasDraft: true, hasDelta: true });

    const published = await send(editor, "POST", `/notes/${note}/publish`, { revision: saved.body.revision });
    expect(published.status).toBe(200);
    expect(published.body.version).toBe(2);
    const versions = (await send(owner, "GET", `/notes/${note}/versions`)).body.versions as Array<{ version_number: number; author_name: string }>;
    const editorName = (db.query("SELECT display_name FROM users WHERE id = ?").get(editor.userId) as { display_name: string }).display_name;
    expect(versions.find((version) => version.version_number === 2)?.author_name).toBe(editorName);
    expect((db.query("SELECT author_id FROM note_versions WHERE note_id = ? AND version_number = 2").get(note) as { author_id: string }).author_id).toBe(editor.userId);
    // Readers see the editor's version.
    expect((await send(reader, "GET", `/notes/${note}`)).body.note.markdown).toContain("Editor text");

    // Owner-only actions stay 404 for the editor.
    await send(editor, "PUT", `/notes/${note}/draft`, { markdown: "# Plan\n\nMore", revision: null });
    expect((await send(editor, "PUT", `/notes/${note}/sharing`, { visibility: "private", userIds: [] })).status).toBe(404);
    expect((await send(editor, "GET", `/notes/${note}/sharing`)).status).toBe(404);
    expect((await send(editor, "DELETE", `/notes/${note}/draft`)).status).toBe(404);
    expect((await send(editor, "DELETE", `/notes/${note}`)).status).toBe(404);
    expect((await send(editor, "PATCH", `/notes/${note}`, { folderId: null })).status).toBe(404);
    expect((await send(editor, "POST", `/notes/${note}/versions/1/restore`)).status).toBe(404);
    expect((await send(owner, "GET", `/notes/${note}`)).body.note.markdown).toContain("More");

    // A folder shared at edit makes its notes editable (immediate folder only, D271).
    const folder = (await send(owner, "POST", "/folders", { name: "Editors folder", parentId: null })).body.folder.id as string;
    await send(owner, "PUT", `/folders/${folder}/sharing`, { visibility: "selected", userIds: [editor.userId] });
    const inFolder = (await send(owner, "POST", "/notes", { folderId: folder })).body.note.id as string;
    await send(owner, "PUT", `/notes/${inFolder}/draft`, { markdown: "# Folder note", revision: 1 });
    await send(owner, "POST", `/notes/${inFolder}/publish`);
    expect((await send(editor, "PUT", `/notes/${inFolder}/draft`, { markdown: "# Folder note edited", revision: null })).status).toBe(404);
    setLevel("folder_shares", "folder_id", folder, editor.userId, "edit");
    expect((await send(editor, "PUT", `/notes/${inFolder}/draft`, { markdown: "# Folder note edited", revision: null })).status).toBe(200);
    // A viewer Team role never edits (the write gate, then the service).
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(editor.userId);
    expect((await send(editor, "PUT", `/notes/${inFolder}/draft`, { markdown: "# x", revision: null })).status).toBe(403);
    expect((await send(editor, "GET", `/notes/${inFolder}`)).body.note.canEdit).toBe(false);
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(editor.userId);
  }, 20_000);
});

describe("managers (D273, T207)", () => {
  test("a board manager changes structure, columns, tags, and sprints, but never deletes the board or uses the owner's sharing route", async () => {
    const owner = await user("Manager board owner");
    const manager = await user("Manager board manager");
    const editor = await user("Manager board editor");
    const created = (await send(owner, "POST", "/tasks/boards", { name: "Managed board", template: "scrum" })).body;
    const boardId = created.board.id as string;
    await send(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [manager.userId, editor.userId] });
    setLevel("board_members", "board_id", boardId, manager.userId, "manage");
    expect((await send(manager, "GET", `/tasks/boards/${boardId}`)).body.board.level).toBe("manage");

    expect((await send(manager, "PATCH", `/tasks/boards/${boardId}`, { name: "Managed board 2" })).status).toBe(200);
    const column = await send(manager, "POST", `/tasks/boards/${boardId}/columns`, { name: "Review" });
    expect(column.status).toBe(201);
    expect((await send(manager, "PATCH", `/tasks/columns/${column.body.column.id}`, { wipLimit: 3 })).status).toBe(200);
    const tag = (await send(manager, "POST", `/tasks/boards/${boardId}/tags`, { name: "Ops" })).body.tag;
    expect((await send(manager, "PATCH", `/tasks/tags/${tag.id}`, { color: "red" })).status).toBe(200);
    expect((await send(manager, "POST", `/tasks/boards/${boardId}/sprints`, { name: "Managed sprint" })).status).toBe(201);
    expect((await send(manager, "DELETE", `/tasks/columns/${column.body.column.id}`)).status).toBe(200);

    // An editor does none of that.
    expect((await send(editor, "PATCH", `/tasks/boards/${boardId}`, { name: "No" })).body.code).toBe("MANAGER_REQUIRED");
    expect((await send(editor, "PATCH", `/tasks/tags/${tag.id}`, { color: "blue" })).body.code).toBe("MANAGER_REQUIRED");

    // The owner's alone: delete, and the older audience-wide sharing route.
    expect((await send(manager, "DELETE", `/tasks/boards/${boardId}`)).body.code).toBe("OWNER_ONLY");
    expect((await send(manager, "GET", `/tasks/boards/${boardId}/sharing`)).body.code).toBe("OWNER_ONLY");
    expect((await send(manager, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "all_users", userIds: [] })).body.code).toBe("OWNER_ONLY");
  }, 20_000);

  test("collection and calendar managers change structure but never delete", async () => {
    const owner = await user("Manager cc owner");
    const manager = await user("Manager cc manager");
    const collection = await newCollection(owner, { name: "Managed collection", fields: [{ name: "Name", type: "text" }] });
    await send(owner, "PUT", `/collections/${collection.id}/sharing`, { visibility: "selected", userIds: [manager.userId], role: "editor" });
    setLevel("collection_members", "collection_id", collection.id, manager.userId, "manage");
    expect((await send(manager, "PATCH", `/collections/${collection.id}`, { name: "Managed 2" })).status).toBe(200);
    expect((await send(manager, "PUT", `/collections/${collection.id}/schema`, { fields: [{ id: collection.fields[0]!.id, name: "Title", type: "text" }, { name: "Qty", type: "number" }], schemaVersion: collection.schema_version })).status).toBe(200);
    const view = await send(manager, "POST", `/collections/${collection.id}/views`, { name: "Mine", config: {} });
    expect(view.status).toBe(201);
    expect((await send(manager, "DELETE", `/collections/views/${view.body.view.id}`)).status).toBe(200);
    expect((await send(manager, "DELETE", `/collections/${collection.id}`)).body.code).toBe("OWNER_ONLY");
    // The older route keeps the manager a manager whatever role it sends.
    await send(owner, "PUT", `/collections/${collection.id}/sharing`, { visibility: "selected", userIds: [manager.userId], role: "viewer" });
    expect(itemLevel("collection", collection.id, manager.userId)).toBe("manage");

    const calendar = (await send(owner, "POST", "/calendars", { name: "Managed calendar", color: "blue" })).body.calendar.id as string;
    await send(owner, "PUT", `/calendars/${calendar}/sharing`, { visibility: "selected", shareRole: "viewer", userIds: [manager.userId] });
    setLevel("calendar_members", "calendar_id", calendar, manager.userId, "manage");
    const patched = await send(manager, "PATCH", `/calendars/${calendar}`, { name: "Managed calendar 2", color: "red" });
    expect(patched.status).toBe(200);
    expect(patched.body.calendar).toMatchObject({ name: "Managed calendar 2", color: "red", level: "manage", role: "editor" });
    expect((await send(manager, "DELETE", `/calendars/${calendar}`)).body.code).toBe("OWNER_ONLY");
    // A read-only Team role never manages, whatever the row says.
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(manager.userId);
    expect(itemLevel("calendar", calendar, manager.userId)).toBe("view");
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(manager.userId);
  });
});

describe("collection and calendar levels", () => {
  test("collections: each person has their own level; the older route's role still applies to everyone it names", async () => {
    const owner = await user("Level collection owner");
    const editor = await user("Level collection editor");
    const reader = await user("Level collection reader");
    const collection = await newCollection(owner, { name: "Levels collection", fields: [{ name: "Name", type: "text" }] });
    const primary = collection.fields[0]!.id;
    const row = await addRow(owner, collection.id, { [primary]: "Row" });
    await send(owner, "PUT", `/collections/${collection.id}/sharing`, { visibility: "selected", userIds: [editor.userId, reader.userId], role: "editor" });
    expect(itemLevel("collection", collection.id, editor.userId)).toBe("edit");
    setLevel("collection_members", "collection_id", collection.id, reader.userId, "view");
    expect(itemLevel("collection", collection.id, reader.userId)).toBe("view");
    const detail = (await send(reader, "GET", `/collections/${collection.id}`)).body;
    expect({ role: detail.role, level: detail.collection.level }).toEqual({ role: "viewer", level: "view" });
    expect((await send(reader, "POST", `/collections/${collection.id}/rows`, { values: { [primary]: "No" } })).status).toBe(403);
    expect((await send(editor, "POST", `/collections/${collection.id}/rows`, { values: { [primary]: "Yes" } })).status).toBe(201);
    expect((await send(editor, "PATCH", `/collections/rows/${row.id}`, { values: { [primary]: "Changed" }, revision: 1 })).status).toBe(200);
    // Schema stays with the owner (and managers, D273).
    expect((await send(editor, "PATCH", `/collections/${collection.id}`, { name: "Renamed" })).status).toBe(403);
  });

  test("calendars: levels per person, and editors write events", async () => {
    const owner = await user("Level calendar owner");
    const editor = await user("Level calendar editor");
    const reader = await user("Level calendar reader");
    const calendar = (await send(owner, "POST", "/calendars", { name: "Levels calendar", color: "blue" })).body.calendar.id as string;
    await send(owner, "PUT", `/calendars/${calendar}/sharing`, { visibility: "selected", shareRole: "editor", userIds: [editor.userId, reader.userId] });
    setLevel("calendar_members", "calendar_id", calendar, reader.userId, "view");
    const event = { title: "Standup", allDay: false, startLocal: "2026-05-04T09:00", tz: "UTC", durationMinutes: 15 };
    expect((await send(editor, "POST", `/calendars/${calendar}/events`, event)).status).toBe(201);
    expect((await send(reader, "POST", `/calendars/${calendar}/events`, event)).status).toBe(403);
    const listed = (await send(reader, "GET", "/calendars")).body.calendars.find((row: { id: string }) => row.id === calendar);
    expect({ role: listed.role, level: listed.level }).toEqual({ role: "viewer", level: "view" });
    expect(itemLevel("calendar", calendar, editor.userId)).toBe("edit");
  });

  test("notes, folders, files, and views resolve their levels too", async () => {
    const owner = await user("Level notes owner");
    const person = await user("Level notes person");
    const folder = (await send(owner, "POST", "/folders", { name: "Levels folder", parentId: null })).body.folder.id as string;
    await send(owner, "PUT", `/folders/${folder}/sharing`, { visibility: "selected", userIds: [person.userId] });
    const note = (await send(owner, "POST", "/notes", { folderId: folder })).body.note.id as string;
    await send(owner, "PUT", `/notes/${note}/draft`, { markdown: "# Levels", revision: 1 });
    await send(owner, "POST", `/notes/${note}/publish`);
    expect(itemLevel("folder", folder, person.userId)).toBe("view");
    expect(itemLevel("note", note, person.userId)).toBe("view");
    setLevel("folder_shares", "folder_id", folder, person.userId, "edit");
    expect(itemLevel("note", note, person.userId)).toBe("edit");
    expect(itemLevel("note", note, owner.userId)).toBe("owner");
    const stranger = await user("Level notes stranger");
    expect(itemLevel("note", note, stranger.userId)).toBe("none");
    const view = (await send(owner, "POST", "/tasks/views", { name: "Levels view", query: "" })).body.view.id as string;
    await send(owner, "PUT", `/tasks/views/${view}/sharing`, { visibility: "selected", userIds: [person.userId] });
    expect(itemLevel("task_view", view, person.userId)).toBe("view");
    expect(itemLevel("task_view", view, owner.userId)).toBe("owner");
  });
});
