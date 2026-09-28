import { describe, expect, test } from "bun:test";
import { createUser } from "./support/harness";
import { addRow, call, newCollection, shareCollection, type Row } from "./support/collections";

describe("saved views", () => {
  test("owners save sort, filters, and hidden fields; queries apply them and requests can override", async () => {
    const owner = await createUser("View owner");
    const collection = await newCollection(owner, { name: "Books", fields: [{ name: "Title", type: "text" }, { name: "Pages", type: "number" }, { name: "Read", type: "checkbox" }] });
    const [title, pages, read] = collection.fields;
    for (const [name, count, done] of [["A", 100, true], ["B", 300, false], ["C", 200, true]] as const) {
      await addRow(owner, collection.id, { [title!.id]: name, [pages!.id]: count, [read!.id]: done });
    }
    const created = await call(owner, "POST", `/${collection.id}/views`, {
      name: "Read, longest first",
      config: { sort: [{ fieldId: pages!.id, direction: "desc" }], filters: [{ fieldId: read!.id, op: "is", value: true }], hiddenFieldIds: [read!.id] }
    });
    expect(created.status).toBe(201);
    const view = created.body.view;
    expect(view).toMatchObject({ name: "Read, longest first", kind: "table", collection_id: collection.id });
    expect((await call(owner, "GET", `/${collection.id}`)).body.views.map((item: { id: string }) => item.id)).toEqual([view.id]);
    const viaView = await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id });
    expect(viaView.body.rows.map((row: Row) => row.title)).toEqual(["C", "A"]);
    const overridden = await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id, filters: [], sort: [{ fieldId: title!.id, direction: "asc" }] });
    expect(overridden.body.rows.map((row: Row) => row.title)).toEqual(["A", "B", "C"]);

    const renamed = await call(owner, "PATCH", `/views/${view.id}`, { name: "Finished", config: { filters: [{ fieldId: pages!.id, op: "gte", value: 200 }] } });
    expect(renamed.body.view).toMatchObject({ name: "Finished", config: { filters: [{ fieldId: pages!.id, op: "gte", value: 200 }] } });

    // A field removed later drops out of the view's clauses instead of breaking it.
    const fields = collection.fields.filter((field) => field.id !== pages!.id).map((field) => ({ id: field.id, name: field.name, type: field.type }));
    expect((await call(owner, "PUT", `/${collection.id}/schema`, { schemaVersion: 1, fields })).status).toBe(200);
    expect((await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id })).body.rows).toHaveLength(3);

    expect((await call(owner, "DELETE", `/views/${view.id}`)).status).toBe(200);
    expect((await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id })).status).toBe(404);
  });

  test("a view whose filter field was removed can still be re-sorted, with its clauses copied back", async () => {
    const owner = await createUser("Stale view owner");
    const collection = await newCollection(owner, { name: "Stale", fields: [{ name: "Title", type: "text" }, { name: "Pages", type: "number" }, { name: "Read", type: "checkbox" }] });
    const [title, pages, read] = collection.fields;
    for (const [name, count] of [["B", 100], ["A", 300]] as const) await addRow(owner, collection.id, { [title!.id]: name, [pages!.id]: count, [read!.id]: true });
    const staleFilter = { fieldId: pages!.id, op: "gte", value: 50 };
    const staleSort = { fieldId: pages!.id, direction: "desc" };
    const view = (await call(owner, "POST", `/${collection.id}/views`, { name: "Long", config: { sort: [staleSort], filters: [staleFilter] } })).body.view;
    const fields = collection.fields.filter((field) => field.id !== pages!.id).map((field) => ({ id: field.id, name: field.name, type: field.type }));
    expect((await call(owner, "PUT", `/${collection.id}/schema`, { schemaVersion: 1, fields })).status).toBe(200);

    const sort = [{ fieldId: title!.id, direction: "asc" }];
    const resorted = await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id, sort });
    expect(resorted.status).toBe(200);
    expect(resorted.body.rows.map((row: Row) => row.title)).toEqual(["A", "B"]);
    // The UI sends copies of the view's clauses alongside its own; the stale ones are dropped.
    const copied = await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id, sort: [{ ...staleSort }, ...sort], filters: [{ ...staleFilter }, { fieldId: read!.id, op: "is", value: true }] });
    expect(copied.status).toBe(200);
    expect(copied.body.rows.map((row: Row) => row.title)).toEqual(["A", "B"]);
    // A stale clause the view never had is still refused.
    const foreign = await call(owner, "POST", `/${collection.id}/query`, { viewId: view.id, filters: [{ fieldId: pages!.id, op: "lt", value: 5 }] });
    expect([foreign.status, foreign.body.code]).toEqual([400, "INVALID_QUERY"]);
  });

  test("view configs are validated against the schema, capped at 20, and owner-only", async () => {
    const owner = await createUser("View validator");
    const editor = await createUser("View editor");
    const stranger = await createUser("View stranger");
    const collection = await newCollection(owner, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Due", type: "date" }] });
    const [name, due] = collection.fields;
    await shareCollection(owner, collection.id, "selected", [editor.userId], "editor");
    for (const config of [
      { filters: [{ fieldId: "f_zzzzzzzz", op: "empty" }] },
      { filters: [{ fieldId: due!.id, op: "contains", value: "x" }] },
      { sort: [{ fieldId: `${name!.id}"`, direction: "asc" }] },
      { hiddenFieldIds: [name!.id] },
      { hiddenFieldIds: ["f_zzzzzzzz"] },
      { q: "not stored" }
    ]) {
      expect((await call(owner, "POST", `/${collection.id}/views`, { name: "Bad", config })).status).toBe(400);
    }
    expect((await call(owner, "POST", `/${collection.id}/views`, { name: "x".repeat(61), config: {} })).status).toBe(400);
    expect((await call(owner, "POST", `/${collection.id}/views`, `{"name":"P","config":{"__proto__":{"x":1}}}`)).status).toBe(400);
    const views: string[] = [];
    for (let index = 0; index < 20; index += 1) views.push((await call(owner, "POST", `/${collection.id}/views`, { name: `View ${index}`, config: {} })).body.view.id);
    const over = await call(owner, "POST", `/${collection.id}/views`, { name: "One more", config: {} });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("LIMIT_REACHED");

    for (const [method, path, body] of [
      ["POST", `/${collection.id}/views`, { name: "Mine", config: {} }],
      ["PATCH", `/views/${views[0]}`, { name: "Mine" }],
      ["DELETE", `/views/${views[0]}`]
    ] as const) {
      expect((await call(editor, method, path, body)).body.code).toBe("MANAGER_REQUIRED");
      expect((await call(stranger, method, path, body)).status).toBe(404);
    }
    // Editors can still use the owner's views.
    expect((await call(editor, "POST", `/${collection.id}/query`, { viewId: views[0] })).status).toBe(200);
  });

  test("IDOR: a view only works with its own collection", async () => {
    const owner = await createUser("View IDOR owner");
    const first = await newCollection(owner, { name: "First" });
    const second = await newCollection(owner, { name: "Second" });
    const other = await createUser("View IDOR other");
    const foreign = await newCollection(other, { name: "Foreign" });
    const view = (await call(owner, "POST", `/${first.id}/views`, { name: "V", config: {} })).body.view;
    const foreignView = (await call(other, "POST", `/${foreign.id}/views`, { name: "F", config: {} })).body.view;
    expect((await call(owner, "POST", `/${second.id}/query`, { viewId: view.id })).status).toBe(404);
    expect((await call(owner, "POST", `/${first.id}/query`, { viewId: foreignView.id })).status).toBe(404);
    expect((await call(owner, "PATCH", `/views/${foreignView.id}`, { name: "Taken" })).status).toBe(404);
    expect((await call(owner, "DELETE", `/views/${foreignView.id}`)).status).toBe(404);
    expect((await call(other, "GET", `/${foreign.id}`)).body.views[0].name).toBe("F");
  });
});
