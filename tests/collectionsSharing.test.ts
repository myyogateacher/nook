import { describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";
import { addRow, call, newCollection, shareCollection, type Collection } from "./support/collections";

describe("collection sharing", () => {
  test("role matrix: viewers read, editors write rows, only the owner changes the collection, strangers get 404", async () => {
    const owner = await createUser("Matrix owner");
    const viewer = await createUser("Matrix viewer");
    const editor = await createUser("Matrix editor");
    const stranger = await createUser("Matrix stranger");
    const readOnly = await newCollection(owner, { name: "Recipes", fields: [{ name: "Name", type: "text" }] });
    const writable = await newCollection(owner, { name: "Chores", fields: [{ name: "Name", type: "text" }] });
    await shareCollection(owner, readOnly.id, "selected", [viewer.userId, editor.userId], "viewer");
    await shareCollection(owner, writable.id, "selected", [viewer.userId, editor.userId], "editor");
    const primary = (collection: Collection) => collection.fields[0]!.id;
    const ownerRow = await addRow(owner, readOnly.id, { [primary(readOnly)]: "Soup" });

    // Viewers of a viewer-role collection read everything and write nothing.
    const asViewer = await call(viewer, "GET", `/${readOnly.id}`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.role).toBe("viewer");
    expect((await call(viewer, "POST", `/${readOnly.id}/query`, {})).body.rows.map((row: { title: string }) => row.title)).toEqual(["Soup"]);
    expect((await call(viewer, "GET", `/rows/${ownerRow.id}`)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", `/${readOnly.id}/rows`, { values: { [primary(readOnly)]: "x" } }],
      ["PATCH", `/rows/${ownerRow.id}`, { values: { [primary(readOnly)]: "x" }, revision: 1 }],
      ["POST", `/rows/${ownerRow.id}/undo`, { revision: 1 }],
      ["DELETE", `/rows/${ownerRow.id}`]
    ] as const) {
      const result = await call(editor, method, path, body);
      expect([path, result.status, result.body.code]).toEqual([path, 403, "READ_ONLY"]);
    }

    // With the editor role, everyone with access writes rows.
    const editorRow = await addRow(editor, writable.id, { [primary(writable)]: "Dishes" });
    expect((await call(viewer, "PATCH", `/rows/${editorRow.id}`, { values: { [primary(writable)]: "Dishes done" }, revision: 1 })).status).toBe(200);
    expect((await call(editor, "POST", `/rows/${editorRow.id}/undo`, { revision: 2 })).status).toBe(200);
    expect((await call(editor, "GET", `/${writable.id}`)).body.role).toBe("editor");

    // Editors never edit the collection itself: the name and fields are the owner's or a manager's
    // (MANAGER_REQUIRED, Wave 32 D273); deleting and the older sharing route stay the owner's.
    const ownerOnly: Array<[string, string, unknown?, string?]> = [
      ["PATCH", `/${writable.id}`, { name: "Mine now" }, "MANAGER_REQUIRED"],
      ["DELETE", `/${writable.id}`],
      ["PUT", `/${writable.id}/schema`, { fields: [{ name: "A", type: "text" }], schemaVersion: 1 }, "MANAGER_REQUIRED"],
      ["GET", `/${writable.id}/sharing`],
      ["PUT", `/${writable.id}/sharing`, { visibility: "all_users", userIds: [], role: "editor" }]
    ];
    for (const [method, path, body, code = "OWNER_ONLY"] of ownerOnly) {
      const result = await call(editor, method, path, body);
      expect([path, result.status, result.body.code]).toEqual([path, 403, code]);
      expect((await call(stranger, method, path, body)).status).toBe(404);
    }
    expect((await call(stranger, "GET", `/rows/${editorRow.id}`)).status).toBe(404);
    expect((await call(stranger, "POST", `/${writable.id}/query`, {})).status).toBe(404);

    const listed = (await call(viewer, "GET", "")).body.collections as Collection[];
    expect(listed.filter((item) => item.id === readOnly.id || item.id === writable.id).map((item) => [item.name, item.role, item.is_owner])).toEqual([["Chores", "editor", 0], ["Recipes", "viewer", 0]]);
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'collection.sharing_changed' AND actor_id = ?").all(owner.userId) as Array<{ metadata_json: string }>;
    expect(JSON.parse(audits[0]!.metadata_json)).toMatchObject({ visibility: "selected", role: "viewer", recipientCount: 2 });
  });

  test("sharing follows the notes rules and unsharing revokes at once", async () => {
    const owner = await createUser("Sharing owner");
    const member = await createUser("Sharing member");
    const other = await createUser("Sharing other");
    const collection = await newCollection(owner);
    const bad: unknown[] = [
      { visibility: "selected", userIds: [owner.userId] },
      { visibility: "selected", userIds: [] },
      { visibility: "selected", userIds: [crypto.randomUUID()] },
      { visibility: "selected", userIds: Array.from({ length: 101 }, () => crypto.randomUUID()) },
      { visibility: "public", userIds: [] },
      { visibility: "private", userIds: [], role: "admin" }
    ];
    for (const body of bad) expect((await call(owner, "PUT", `/${collection.id}/sharing`, body)).status).toBe(400);

    await shareCollection(owner, collection.id, "selected", [member.userId], "editor");
    expect((await call(owner, "GET", `/${collection.id}/sharing`)).body).toEqual({ visibility: "selected", role: "editor", users: [{ id: member.userId, display_name: "Sharing member" }] });
    expect((await call(member, "GET", `/${collection.id}`)).status).toBe(200);
    expect((await call(other, "GET", `/${collection.id}`)).status).toBe(404);

    await shareCollection(owner, collection.id, "all_users", [], "viewer");
    expect((await call(other, "GET", `/${collection.id}`)).body.role).toBe("viewer");
    expect((await call(owner, "GET", `/${collection.id}/sharing`)).body.users).toEqual([]);

    await shareCollection(owner, collection.id, "private");
    expect((await call(member, "GET", `/${collection.id}`)).status).toBe(404);
    expect((await call(other, "POST", `/${collection.id}/query`, {})).status).toBe(404);
  });
});
