import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";

const { resetMcpLimits } = await import("../server/mcpRateLimit");

/**
 * Managers and keys (Wave 32 review, D265, T145, T207): `manage` is never a key permission, so a
 * manager's key keeps the pre-Wave-32 rule for structure (the board's owner only, OWNER_ONLY),
 * while the manager's web session keeps its powers and the owner's key still works. Collections
 * and calendars have no structure tools, so a manager's key there only reaches content.
 */

beforeEach(() => resetMcpLimits());

const setLevel = (table: string, column: string, id: string, userId: string, level: string) =>
  db.query(`UPDATE ${table} SET level = ? WHERE ${column} = ? AND user_id = ?`).run(level, id, userId);

async function managedBoard(label: string) {
  const owner = await createUser(`${label} owner`);
  const manager = await createUser(`${label} manager`);
  const created = await api(owner, "POST", "/tasks/boards", { name: `${label} board`, template: "scrum" });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[1].id as string;
  expect((await api(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [manager.userId] })).status).toBe(200);
  setLevel("board_members", "board_id", boardId, manager.userId, "manage");
  const tag = (await api(owner, "POST", `/tasks/boards/${boardId}/tags`, { name: `Tag ${crypto.randomUUID().slice(0, 6)}` })).body.tag as { id: string };
  const sprint = (await api(owner, "POST", `/tasks/boards/${boardId}/sprints`, { name: "Planned" })).body.sprint as { id: string };
  return { owner, manager, boardId, columnId, tagId: tag.id, sprintId: sprint.id };
}

describe("a manager's key and structure", () => {
  test("tasks: a manager's key is OWNER_ONLY for tag rename and recolour, WIP limits, and sprints; the owner's key works", async () => {
    const { owner, manager, boardId, columnId, tagId, sprintId } = await managedBoard("Key manager");
    const managerKey = makeKey(manager, ["tasks:write"]);
    expect(await errorCode(managerKey, "manage_tags", { boardId, action: "rename", tagId, name: "Renamed" })).toBe("OWNER_ONLY");
    expect(await errorCode(managerKey, "manage_tags", { boardId, action: "recolour", tagId, color: "red" })).toBe("OWNER_ONLY");
    expect(await errorCode(managerKey, "set_wip_limit", { columnId, wipLimit: 3 })).toBe("OWNER_ONLY");
    expect(await errorCode(managerKey, "create_sprint", { boardId, name: "Key sprint" })).toBe("OWNER_ONLY");
    expect(await errorCode(managerKey, "start_sprint", { sprintId })).toBe("OWNER_ONLY");
    // Nothing changed.
    expect(db.query("SELECT wip_limit FROM board_columns WHERE id = ?").get(columnId)).toEqual({ wip_limit: null });
    expect(db.query("SELECT COUNT(*) AS count FROM board_sprints WHERE board_id = ?").get(boardId)).toEqual({ count: 2 });
    // Creating a tag needs edit, which a manager has.
    expect((await ok(managerKey, "manage_tags", { boardId, action: "create", name: "From a key" })).tag.name).toBe("From a key");
    // The manager's web session is unchanged.
    expect((await api(manager, "PATCH", `/tasks/columns/${columnId}`, { wipLimit: 4 })).status).toBe(200);
    expect((await api(manager, "PATCH", `/tasks/tags/${tagId}`, { color: "blue" })).status).toBe(200);

    const ownerKey = makeKey(owner, ["tasks:write"]);
    expect((await ok(ownerKey, "manage_tags", { boardId, action: "rename", tagId, name: "Owner renamed" })).tag.name).toBe("Owner renamed");
    expect((await ok(ownerKey, "set_wip_limit", { columnId, wipLimit: 5 })).column.wip_limit).toBe(5);
    expect((await ok(ownerKey, "create_sprint", { boardId, name: "Owner sprint" })).sprint.state).toBe("planned");
    expect((await ok(ownerKey, "start_sprint", { sprintId })).sprint.is_active).toBe(true);
  }, 20_000);

  test("tasks: an unknown column or sprint stays NOT_FOUND, and a stranger's key sees NOT_FOUND before OWNER_ONLY", async () => {
    const { boardId, columnId, tagId, sprintId } = await managedBoard("Key stranger");
    const stranger: Session = await createUser("Key stranger outsider");
    const key = makeKey(stranger, ["tasks:write"]);
    expect(await errorCode(key, "set_wip_limit", { columnId, wipLimit: 3 })).toBe("NOT_FOUND");
    expect(await errorCode(key, "start_sprint", { sprintId })).toBe("NOT_FOUND");
    expect(await errorCode(key, "manage_tags", { boardId, action: "rename", tagId, name: "No" })).toBe("NOT_FOUND");
    expect(await errorCode(key, "set_wip_limit", { columnId: crypto.randomUUID(), wipLimit: 3 })).toBe("NOT_FOUND");
    expect(await errorCode(key, "start_sprint", { sprintId: crypto.randomUUID() })).toBe("NOT_FOUND");
  });

  test("collections and calendars: no key tool reaches structure, and a manager's key writes content like an editor's", async () => {
    const owner = await createUser("Key cc owner");
    const manager = await createUser("Key cc manager");
    const collection = (await api(owner, "POST", "/collections", { name: "Key managed", fields: [{ name: "Name", type: "text" }] })).body.collection as { id: string };
    await api(owner, "PUT", `/collections/${collection.id}/sharing`, { visibility: "selected", userIds: [manager.userId], role: "editor" });
    setLevel("collection_members", "collection_id", collection.id, manager.userId, "manage");
    const calendar = (await api(owner, "POST", "/calendars", { name: "Key managed calendar", color: "blue" })).body.calendar.id as string;
    await api(owner, "PUT", `/calendars/${calendar}/sharing`, { visibility: "selected", shareRole: "editor", userIds: [manager.userId] });
    setLevel("calendar_members", "calendar_id", calendar, manager.userId, "manage");

    const key = makeKey(manager, ["collections:write", "calendar:write"]);
    const names = await toolNames(key);
    expect(names.filter((name) => /schema|field|view|rename|colou?r|shar|access|member|(update|patch|delete)_(collection|calendar)/.test(name))).toEqual([]);
    await ok(key, "create_row", { collectionId: collection.id, values: { Name: "From a manager's key" } });
    expect(db.query("SELECT COUNT(*) AS count FROM collection_rows WHERE collection_id = ?").get(collection.id)).toEqual({ count: 1 });
    await ok(key, "create_event", { calendarId: calendar, title: "Manager key event", allDay: true, start: "2026-10-01", end: "2026-10-02" });
    expect(db.query("SELECT COUNT(*) AS count FROM events WHERE calendar_id = ?").get(calendar)).toEqual({ count: 1 });
  });
});
