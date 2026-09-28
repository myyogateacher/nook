import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { api, auditRows, call, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";

const { resetMcpLimits } = await import("../server/mcpRateLimit");

beforeEach(() => resetMcpLimits());

const tasks = (session: Session, method: string, path: string, body?: unknown) => api(session, method, `/tasks${path}`, body);

async function board(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await tasks(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const [todo, doing] = created.body.columns as Array<{ id: string }>;
  expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  return { owner, member, stranger, boardId, todo: todo!.id, doing: doing!.id };
}

const cardRow = (id: string) => db.query("SELECT deleted_at, deleted_by, bin_root_id, parent_card_id FROM cards WHERE id = ?").get(id) as
  { deleted_at: string | null; deleted_by: string | null; bin_root_id: string | null; parent_card_id: string | null };

function uploadForm(session: Session, query: string, name: string, content: string) {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  return request(`/files${query}`, { method: "POST", body: form }, session);
}

describe("tasks: bin_card and restore_card", () => {
  test("bins a card with its children and restores the tree; only the owner or the binner restores", async () => {
    const { owner, member, stranger, boardId, todo } = await board("Bin tree");
    const levels = { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: false };
    db.query("UPDATE boards SET structure_json = ? WHERE id = ?").run(JSON.stringify(levels), boardId);
    const parent = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Parent" })).body.card.id as string;
    const child = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Child", parentId: parent })).body.card.id as string;
    const memberKey = makeKey(member, ["tasks:write", "bin:write"]);
    const binned = await ok(memberKey, "bin_card", { cardId: parent });
    expect(binned).toMatchObject({ cardId: parent, binned: true, descendantCount: 1 });
    expect(cardRow(child)).toMatchObject({ bin_root_id: parent });
    expect(auditRows(member.userId, "task.card_delete").at(-1)).toMatchObject({ cardId: parent, via: "mcp", keyId: memberKey.id });
    // A stranger, and a board reader who did not bin it, see NOT_FOUND.
    expect(await errorCode(makeKey(stranger, ["tasks:write", "bin:write"]), "restore_card", { cardId: parent })).toBe("NOT_FOUND");
    const third = await createUser("Bin tree third");
    expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId, third.userId] })).status).toBe(200);
    expect(await errorCode(makeKey(third, ["tasks:write", "bin:write"]), "restore_card", { cardId: parent })).toBe("NOT_FOUND");
    const restored = await ok(memberKey, "restore_card", { cardId: parent });
    expect(restored).toMatchObject({ cardId: parent, restored: true, descendantCount: 1, columnId: todo });
    expect(cardRow(parent).deleted_at).toBeNull();
    expect(cardRow(child).deleted_at).toBeNull();
    // The owner may restore what someone else binned.
    await ok(memberKey, "bin_card", { cardId: child });
    expect((await ok(makeKey(owner, ["tasks:write", "bin:write"]), "restore_card", { cardId: child })).restored).toBe(true);
  });

  test("a card on a binned board is PARENT_IN_BIN, and tasks:write alone cannot bin", async () => {
    const { owner, boardId, todo } = await board("Bin board");
    const cardId = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "Lonely" })).body.card.id as string;
    const key = makeKey(owner, ["tasks:write", "bin:write"]);
    await ok(key, "bin_card", { cardId });
    expect((await tasks(owner, "DELETE", `/boards/${boardId}`)).status).toBe(200);
    expect(await errorCode(key, "restore_card", { cardId })).toBe("PARENT_IN_BIN");
    const writer = makeKey(owner, ["tasks:write"]);
    expect(await toolNames(writer)).not.toContain("bin_card");
    expect(await errorCode(writer, "bin_card", { cardId })).toBe("SCOPE_REQUIRED");
  });
});

describe("tasks: tags, WIP limits, sprints, and attachments", () => {
  test("any writer creates tags; rename and recolour are owner only; a tag of another board is NOT_FOUND", async () => {
    const { owner, member, stranger, boardId } = await board("Tags");
    const memberKey = makeKey(member, ["tasks:write"]);
    const created = await ok(memberKey, "manage_tags", { boardId, action: "create", name: "Urgent" });
    expect(created.tag).toMatchObject({ name: "Urgent" });
    expect(await errorCode(memberKey, "manage_tags", { boardId, action: "create", name: "urgent" })).toBe("NAME_TAKEN");
    expect(await errorCode(memberKey, "manage_tags", { boardId, action: "rename", tagId: created.tag.id, name: "Later" })).toBe("OWNER_ONLY");
    expect(await errorCode(memberKey, "manage_tags", { boardId, action: "recolour", tagId: created.tag.id, color: "red" })).toBe("OWNER_ONLY");
    const ownerKey = makeKey(owner, ["tasks:write"]);
    expect((await ok(ownerKey, "manage_tags", { boardId, action: "rename", tagId: created.tag.id, name: "Soon" })).tag.name).toBe("Soon");
    expect((await ok(ownerKey, "manage_tags", { boardId, action: "recolour", tagId: created.tag.id, color: "red" })).tag.color).toBe("red");
    expect(await errorCode(ownerKey, "manage_tags", { boardId, action: "rename", tagId: created.tag.id, name: "X", color: "red" })).toBe("INVALID");
    const other = (await tasks(owner, "POST", "/boards", { name: "Other tags" })).body.board.id as string;
    expect(await errorCode(ownerKey, "manage_tags", { boardId: other, action: "rename", tagId: created.tag.id, name: "Moved" })).toBe("NOT_FOUND");
    expect(await errorCode(makeKey(stranger, ["tasks:write"]), "manage_tags", { boardId, action: "create", name: "Probe" })).toBe("NOT_FOUND");
    expect(auditRows(member.userId, "task.tag_create").at(-1)).toMatchObject({ via: "mcp", keyId: memberKey.id });
  });

  test("set_wip_limit is owner only and clears with null", async () => {
    const { owner, member, doing } = await board("Wip");
    expect(await errorCode(makeKey(member, ["tasks:write"]), "set_wip_limit", { columnId: doing, wipLimit: 3 })).toBe("OWNER_ONLY");
    const key = makeKey(owner, ["tasks:write"]);
    expect((await ok(key, "set_wip_limit", { columnId: doing, wipLimit: 3 })).column.wip_limit).toBe(3);
    expect((await ok(key, "set_wip_limit", { columnId: doing, wipLimit: null })).column.wip_limit).toBeNull();
    expect(await errorCode(key, "set_wip_limit", { columnId: doing, wipLimit: 0 })).toBe("INVALID");
  });

  test("sprints: owner only, SPRINTS_OFF is INVALID, a second start is SPRINT_ACTIVE, and there is no complete tool", async () => {
    const { owner, member, boardId } = await board("Sprints");
    const key = makeKey(owner, ["tasks:write"]);
    expect((await call(key, "create_sprint", { boardId, name: "Sprint 1" })).value).toMatchObject({ code: "INVALID", reason: "SPRINTS_OFF" });
    const structure = { levels: [{ name: "Task", plural: "Tasks" }], workLevel: 0, sprints: true };
    expect((await tasks(owner, "PATCH", `/boards/${boardId}`, { structure })).status).toBe(200);
    expect(await errorCode(makeKey(member, ["tasks:write"]), "create_sprint", { boardId, name: "Mine" })).toBe("OWNER_ONLY");
    const first = (await ok(key, "create_sprint", { boardId, name: "Sprint 1", startOn: "2026-10-01", endOn: "2026-10-14" })).sprint;
    const second = (await ok(key, "create_sprint", { boardId, name: "Sprint 2" })).sprint;
    expect(first.state).toBe("planned");
    expect((await ok(key, "start_sprint", { sprintId: first.id })).sprint.is_active).toBe(true);
    expect((await call(key, "start_sprint", { sprintId: second.id })).value).toMatchObject({ code: "SPRINT_ACTIVE", activeSprintId: first.id });
    expect(auditRows(owner.userId, "task.sprint_start").at(-1)).toMatchObject({ sprintId: first.id, via: "mcp", keyId: key.id });
    expect(await toolNames(key)).not.toContain("complete_sprint");
  });

  test("link_attachment links the user's own task attachment, idempotently; a Files document is NOT_FOUND", async () => {
    const { owner, boardId, todo } = await board("Attach");
    const cardId = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo, title: "With file" })).body.card.id as string;
    const attachment = (await (await uploadForm(owner, "?purpose=task_attachment", "notes.txt", "hello")).json() as { document: { id: string } }).document;
    const filesDoc = (await (await uploadForm(owner, "", "plain.txt", "files")).json() as { document: { id: string } }).document;
    const key = makeKey(owner, ["tasks:write"]);
    const linked = await ok(key, "link_attachment", { cardId, documentId: attachment.id });
    expect(linked).toMatchObject({ alreadyLinked: false, attachment: { documentId: attachment.id, name: "notes.txt" } });
    expect((await ok(key, "link_attachment", { cardId, documentId: attachment.id })).alreadyLinked).toBe(true);
    expect(await errorCode(key, "link_attachment", { cardId, documentId: filesDoc.id })).toBe("NOT_FOUND");
  });
});

describe("calendar: bin_event and restore_event", () => {
  test("an editor bins and restores; a reader who did not bin gets NOT_FOUND; a binned calendar is PARENT_IN_BIN", async () => {
    const owner = await createUser("Event bin owner");
    const editor = await createUser("Event bin editor");
    const other = await createUser("Event bin other");
    const calendarId = (await api(owner, "POST", "/calendars", { name: "Shared cal", color: "green" })).body.calendar.id as string;
    expect((await api(owner, "PUT", `/calendars/${calendarId}/sharing`, { visibility: "selected", shareRole: "editor", userIds: [editor.userId, other.userId] })).status).toBe(200);
    const eventId = (await api(owner, "POST", `/calendars/${calendarId}/events`, { title: "Standup", allDay: true, startDate: "2026-10-06", endDate: "2026-10-07" })).body.event.id as string;
    const editorKey = makeKey(editor, ["calendar:write", "bin:write"]);
    expect(await toolNames(makeKey(editor, ["calendar:write"]))).not.toContain("bin_event");
    expect(await ok(editorKey, "bin_event", { eventId })).toMatchObject({ eventId, binned: true });
    expect(auditRows(editor.userId, "event.delete").at(-1)).toMatchObject({ eventId, via: "mcp", keyId: editorKey.id });
    expect(await errorCode(makeKey(other, ["calendar:write", "bin:write"]), "restore_event", { eventId })).toBe("NOT_FOUND");
    expect(await ok(editorKey, "restore_event", { eventId })).toMatchObject({ eventId, restored: true, calendarId });
    await ok(editorKey, "bin_event", { eventId });
    expect((await api(owner, "DELETE", `/calendars/${calendarId}`)).status).toBe(200);
    expect(await errorCode(makeKey(owner, ["calendar:write", "bin:write"]), "restore_event", { eventId })).toBe("PARENT_IN_BIN");
  });
});

describe("collections: create_collection, bin_row, and restore_row", () => {
  const col = (session: Session, method: string, path: string, body?: unknown) => api(session, method, `/collections${path}`, body);

  test("creates a private collection from a template or fields, refusing both, prototype keys, and the 101st", async () => {
    const owner = await createUser("Collection create owner");
    const other = await createUser("Collection create other");
    const key = makeKey(owner, ["collections:write"]);
    const fromTemplate = await ok(key, "create_collection", { name: "Stock", templateId: "inventory" });
    expect(fromTemplate.fields.length).toBeGreaterThan(0);
    const custom = await ok(key, "create_collection", { name: "Books", fields: [{ name: "Title", type: "text" }, { name: "Read", type: "checkbox" }] });
    expect(custom.fields.map((field: { name: string }) => field.name)).toEqual(["Title", "Read"]);
    expect((db.query("SELECT visibility FROM collections WHERE id = ?").get(custom.collectionId) as { visibility: string }).visibility).toBe("private");
    expect(((await col(other, "GET", "")).body.collections as Array<{ id: string }>).some((item) => item.id === custom.collectionId)).toBe(false);
    expect(await errorCode(key, "create_collection", { name: "Both", templateId: "inventory", fields: [{ name: "A", type: "text" }] })).toBe("INVALID");
    expect(await errorCode(key, "create_collection", { name: "Neither" })).toBe("INVALID");
    expect(await errorCode(key, "create_collection", { name: "Proto", fields: [JSON.parse('{"name":"A","type":"text","__proto__":{"x":1}}')] })).toBe("INVALID");
    expect(await errorCode(key, "create_collection", { name: "Bad", fields: [{ name: "A", type: "rocket" }] })).toBe("INVALID");
    expect(auditRows(owner.userId, "collection.create").at(-1)).toMatchObject({ collectionId: custom.collectionId, via: "mcp", keyId: key.id });
    const filler = await createUser("Collection create full");
    const fullKey = makeKey(filler, ["collections:write"]);
    const now = new Date().toISOString();
    const insert = db.query("INSERT INTO collections (id, owner_id, name, icon, schema_json, created_at, updated_at) VALUES (?, ?, ?, 'table', ?, ?, ?)");
    for (let index = 0; index < 100; index += 1) insert.run(crypto.randomUUID(), filler.userId, `Filler ${index}`, JSON.stringify({ fields: [{ id: "f_aaaaaaaa", name: "Name", type: "text" }] }), now, now);
    expect(await errorCode(fullKey, "create_collection", { name: "One too many", templateId: "inventory" })).toBe("LIMIT_REACHED");
  });

  test("an editor bins and restores a row; a viewer cannot; a binned collection is PARENT_IN_BIN", async () => {
    const owner = await createUser("Row bin owner");
    const editor = await createUser("Row bin editor");
    const viewer = await createUser("Row bin viewer");
    const collectionId = (await col(owner, "POST", "", { name: "Tasks list", fields: [{ name: "Name", type: "text" }] })).body.collection.id as string;
    expect((await col(owner, "PUT", `/${collectionId}/sharing`, { visibility: "selected", userIds: [editor.userId], role: "editor" })).status).toBe(200);
    const rowId = (await col(owner, "POST", `/${collectionId}/rows`, { values: {} })).body.row.id as string;
    const editorKey = makeKey(editor, ["collections:write", "bin:write"]);
    expect(await errorCode(makeKey(viewer, ["collections:write", "bin:write"]), "bin_row", { rowId })).toBe("NOT_FOUND");
    expect(await ok(editorKey, "bin_row", { rowId })).toMatchObject({ rowId, binned: true });
    expect(auditRows(editor.userId, "collection.row_delete").at(-1)).toMatchObject({ rowId, via: "mcp", keyId: editorKey.id });
    expect(await ok(editorKey, "restore_row", { rowId })).toMatchObject({ rowId, restored: true, collectionId });
    await ok(editorKey, "bin_row", { rowId });
    expect((await col(owner, "DELETE", `/${collectionId}`)).status).toBe(200);
    expect(await errorCode(makeKey(owner, ["collections:write", "bin:write"]), "restore_row", { rowId })).toBe("PARENT_IN_BIN");
  });
});
