import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { addRow, call, insertNote, newCollection, shareCollection } from "./support/collections";

const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { consumeMcpLimits, MCP_LIMITS, resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTodayRateLimit } = await import("../server/today/rateLimit");
const { changedByKeyText } = await import("../src/collections/RowPanel");
type McpScope = import("../server/mcpScopes").McpScope;

beforeEach(() => { resetMcpLimits(); resetTodayRateLimit(); });

type Key = { id: string; token: string; userId: string };
const makeKey = (session: Session, scopes: McpScope[], name = "Rows agent"): Key => {
  const key = createMcpApiKey(session.userId, name, scopes);
  return { id: key.id, token: key.token, userId: session.userId };
};

let rpcId = 0;
async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
}

const toolNames = async (key: Key) => ((await rpc(key, "tools/list")).result!.tools!).map((tool) => tool.name).sort();

type Outcome = { isError: boolean; value: Record<string, any> };
async function callTool(key: Key, name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, value: { error: body.error.message } };
  const text = body.result!.content![0]!.text;
  let value: Record<string, any>;
  try { value = JSON.parse(text); } catch { value = { error: text }; }
  return { isError: body.result!.isError === true, value };
}

async function direct(key: Key, name: string, args: Record<string, unknown>) {
  const result = await invokeMcpToolForTests(name, args, key.id);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

const RECIPE_FIELDS = [
  { name: "Name", type: "text", required: true },
  { name: "Servings", type: "number" },
  { name: "Course", type: "select", options: [{ label: "Starter" }, { label: "Main" }, { label: "Dessert" }] },
  { name: "Tags", type: "multi_select", options: [{ label: "Quick" }, { label: "Vegan" }] },
  { name: "Recipe note", type: "note" },
  { name: "Photo", type: "file" },
  { name: "Done", type: "checkbox" }
];

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const editor = await createUser(`${label} editor`);
  const viewer = await createUser(`${label} viewer`);
  const stranger = await createUser(`${label} stranger`);
  const editable = await newCollection(owner, { name: `${label} recipes`, fields: RECIPE_FIELDS });
  const readOnly = await newCollection(owner, { name: `${label} pantry`, fields: [{ name: "Item", type: "text" }] });
  await shareCollection(owner, editable.id, "selected", [editor.userId, viewer.userId], "editor");
  await shareCollection(owner, readOnly.id, "selected", [editor.userId, viewer.userId], "viewer");
  const privateCollection = await newCollection(owner, { name: `${label} private`, fields: [{ name: "Secret", type: "text" }] });
  const f = (name: string) => editable.fields.find((field) => field.name === name)!;
  const option = (field: string, label: string) => f(field).options!.find((item) => item.label === label)!.id;
  const soup = await addRow(owner, editable.id, { [f("Name").id]: "Soup", [f("Servings").id]: 4, [f("Course").id]: option("Course", "Starter"), [f("Tags").id]: [option("Tags", "Quick")] });
  const pantryRow = await addRow(owner, readOnly.id, { [readOnly.fields[0]!.id]: "Flour" });
  const secretRow = await addRow(owner, privateCollection.id, { [privateCollection.fields[0]!.id]: "Hidden" });
  return { owner, editor, viewer, stranger, editable, readOnly, privateCollection, soup, pantryRow, secretRow, f, option };
}

const auditRows = (actorId: string, eventType: string) => (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY created_at").all(actorId, eventType) as Array<{ metadata_json: string }>)
  .map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);

const READ_TOOLS = ["get_row", "list_collections", "query_rows"];
const WRITE_TOOLS = ["create_collection", "create_row", "update_row"];

describe("MCP collection tools", () => {
  test("appear only for collection scopes, write implies read, the handler re-checks, and nothing deletes or edits schema", async () => {
    const user = await createUser("Collections scopes");
    const reader = makeKey(user, ["collections:read"]);
    expect(await toolNames(reader)).toEqual(READ_TOOLS);
    const writer = makeKey(user, ["collections:write"]);
    expect(await toolNames(writer)).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    const other = makeKey(user, ["notes:read", "calendar:write", "tasks:write", "today:read"]);
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) expect(await toolNames(other)).not.toContain(name);
    for (const name of await toolNames(writer)) expect(name).not.toMatch(/delete|schema|share|import|view|attach/);
    expect((await direct(other, "list_collections", {})).value.code).toBe("SCOPE_REQUIRED");
    expect((await direct(reader, "create_row", { collectionId: crypto.randomUUID(), values: {} })).value.code).toBe("SCOPE_REQUIRED");
    const created = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "all", password: user.password, scopes: ["notes:read", "notes:write-draft", "files:read", "tasks:read", "tasks:write", "today:read", "calendar:read", "calendar:write", "collections:read", "collections:write"] }) }, user);
    expect(created.status).toBe(201);
    expect(((await created.json()) as { key: { scopes: string[] } }).key.scopes.length).toBe(10);
  });

  test("list_collections and reads follow the role matrix; strangers and private rows are NOT_FOUND", async () => {
    const s = await setup("Collections roles");
    const viewer = makeKey(s.viewer, ["collections:read"]);
    const stranger = makeKey(s.stranger, ["collections:read"]);
    const listed = (await callTool(viewer, "list_collections")).value.collections as Array<{ id: string; role: string; fields: Array<{ name: string; type: string; options?: Array<{ label: string }> }> }>;
    const byId = new Map(listed.map((collection) => [collection.id, collection]));
    expect(byId.get(s.editable.id)?.role).toBe("editor");
    expect(byId.get(s.readOnly.id)?.role).toBe("viewer");
    expect(byId.has(s.privateCollection.id)).toBe(false);
    const recipe = byId.get(s.editable.id)!;
    expect(recipe.fields.map((field) => [field.name, field.type])).toEqual(RECIPE_FIELDS.map((field) => [field.name, field.type]));
    expect(recipe.fields[2]!.options!.map((item) => item.label)).toEqual(["Starter", "Main", "Dessert"]);
    // Other tests share collections with everyone; none of these three is among the stranger's.
    const strangerIds = ((await callTool(stranger, "list_collections")).value.collections as Array<{ id: string }>).map((collection) => collection.id);
    for (const id of [s.editable.id, s.readOnly.id, s.privateCollection.id]) expect(strangerIds).not.toContain(id);

    for (const [key, args] of [
      [stranger, { collectionId: s.editable.id }],
      [viewer, { collectionId: s.privateCollection.id }],
      [viewer, { collectionId: crypto.randomUUID() }]
    ] as const) expect((await callTool(key, "query_rows", args)).value.code).toBe("NOT_FOUND");
    expect((await callTool(stranger, "get_row", { rowId: s.soup.id })).value.code).toBe("NOT_FOUND");
    expect((await callTool(viewer, "get_row", { rowId: s.secretRow.id })).value.code).toBe("NOT_FOUND");

    const got = await callTool(viewer, "get_row", { rowId: s.soup.id });
    expect(got.value).toMatchObject({ revision: 1, role: "editor", row: { title: "Soup", values: { Name: "Soup", Servings: 4, Course: "Starter", Tags: ["Quick"] } } });
    // Binned collections disappear.
    expect((await call(s.owner, "DELETE", `/${s.readOnly.id}`)).status).toBe(200);
    expect((await callTool(viewer, "get_row", { rowId: s.pantryRow.id })).value.code).toBe("NOT_FOUND");
  });

  test("query_rows keys rows by field name, filters and sorts by name or label, pages with a cursor, and caps limit at 50", async () => {
    const s = await setup("Collections query");
    const key = makeKey(s.owner, ["collections:read"]);
    for (const [name, servings, course] of [["Salad", 2, "Starter"], ["Stew", 6, "Main"], ["Cake", 8, "Dessert"]] as const) {
      await addRow(s.owner, s.editable.id, { [s.f("Name").id]: name, [s.f("Servings").id]: servings, [s.f("Course").id]: s.option("Course", course) });
    }
    const starters = await callTool(key, "query_rows", { collectionId: s.editable.id, filters: [{ field: "Course", op: "is", value: "Starter" }], sort: [{ field: "Name" }] });
    expect(starters.isError).toBe(false);
    expect(starters.value.rows.map((row: { title: string }) => row.title)).toEqual(["Salad", "Soup"]);
    expect(starters.value.total).toBe(2);
    expect(starters.value.rows[1].values).toEqual({ Name: "Soup", Servings: 4, Course: "Starter", Tags: ["Quick"] });
    expect(starters.value.rows[1].url).toBe(`${origin}/collections/${s.editable.id}/row/${s.soup.id}`);
    const big = await callTool(key, "query_rows", { collectionId: s.editable.id, filters: [{ field: "Servings", op: "gte", value: 6 }], sort: [{ field: s.f("Servings").id, direction: "desc" }] });
    expect(big.value.rows.map((row: { title: string }) => row.title)).toEqual(["Cake", "Stew"]);
    expect((await callTool(key, "query_rows", { collectionId: s.editable.id, q: "stew" })).value.rows.map((row: { title: string }) => row.title)).toEqual(["Stew"]);

    const first = await callTool(key, "query_rows", { collectionId: s.editable.id, sort: [{ field: "Name" }], limit: 2 });
    expect(first.value.rows.map((row: { title: string }) => row.title)).toEqual(["Cake", "Salad"]);
    const second = await callTool(key, "query_rows", { collectionId: s.editable.id, sort: [{ field: "Name" }], limit: 2, cursor: first.value.nextCursor });
    expect(second.value.rows.map((row: { title: string }) => row.title)).toEqual(["Soup", "Stew"]);
    expect(second.value.nextCursor).toBeNull();

    for (const bad of [
      { filters: [{ field: "Nope", op: "is", value: "x" }] },
      { filters: [{ field: "Course", op: "contains", value: "x" }] },
      { filters: [{ field: "Course", op: "is", value: "Brunch" }] },
      { filters: [{ field: "Name", op: "contains", value: "x".repeat(500) }] },
      { sort: [{ field: "Photo" }] },
      { limit: 51 },
      { cursor: "garbage" }
    ]) {
      const result = await direct(key, "query_rows", { collectionId: s.editable.id, ...bad });
      expect(result.isError).toBe(true);
      expect(result.value.code).toBe("INVALID");
    }
  });

  test("links come back as titles or restricted, and attachments as names only", async () => {
    const s = await setup("Collections links");
    const readable = insertNote(s.owner.userId, "Grandma's soup", { visibility: "all_users" });
    const hidden = insertNote(s.owner.userId, "Owner private note");
    const withReadable = await addRow(s.owner, s.editable.id, { [s.f("Name").id]: "Readable", [s.f("Recipe note").id]: readable });
    const withHidden = await addRow(s.owner, s.editable.id, { [s.f("Name").id]: "Hidden link", [s.f("Recipe note").id]: hidden });
    const upload = new FormData();
    upload.append("file", new Blob(["jpeg-ish bytes"]), "soup-photo.txt");
    const documentId = ((await (await request("/files?purpose=collection_attachment", { method: "POST", body: upload }, s.owner)).json()) as { document: { id: string } }).document.id;
    expect((await call(s.owner, "POST", `/rows/${withReadable.id}/attachments`, { documentId, fieldId: s.f("Photo").id })).status).toBe(201);

    const viewer = makeKey(s.viewer, ["collections:read"]);
    const readableRow = (await callTool(viewer, "get_row", { rowId: withReadable.id })).value.row;
    expect(readableRow.values["Recipe note"]).toEqual({ noteId: readable, title: "Grandma's soup" });
    expect(readableRow.values.Photo).toEqual(["soup-photo.txt"]);
    expect(JSON.stringify(readableRow)).not.toContain(documentId);
    const hiddenRow = (await callTool(viewer, "get_row", { rowId: withHidden.id })).value.row;
    expect(hiddenRow.values["Recipe note"]).toEqual({ restricted: true });
    expect(JSON.stringify(hiddenRow)).not.toContain("Owner private note");
    expect(JSON.stringify(hiddenRow)).not.toContain(hidden);
  });

  test("create_row needs the editor role; values use names and labels; the key is marked and audited", async () => {
    const s = await setup("Collections create");
    const editor = makeKey(s.editor, ["collections:write"], "Kitchen bot");
    const viewer = makeKey(s.viewer, ["collections:write"]);
    const stranger = makeKey(s.stranger, ["collections:write"]);
    const values = { Name: "Pancakes", Servings: 3, Course: "dessert", Tags: ["Quick", "Vegan"], Done: true };
    expect((await callTool(viewer, "create_row", { collectionId: s.readOnly.id, values: { Item: "Sugar" } })).value.code).toBe("READ_ONLY");
    expect((await callTool(stranger, "create_row", { collectionId: s.editable.id, values })).value.code).toBe("NOT_FOUND");
    expect((await callTool(viewer, "create_row", { collectionId: s.privateCollection.id, values: { Secret: "x" } })).value.code).toBe("NOT_FOUND");
    const created = await callTool(editor, "create_row", { collectionId: s.editable.id, values });
    expect(created.isError).toBe(false);
    expect(created.value).toEqual({ rowId: expect.any(String), revision: 1, url: `${origin}/collections/${s.editable.id}/row/${created.value.rowId}` });
    const stored = db.query("SELECT values_json, created_by, updated_via_key_id FROM collection_rows WHERE id = ?").get(created.value.rowId) as { values_json: string; created_by: string; updated_via_key_id: string };
    expect(JSON.parse(stored.values_json)).toEqual({
      [s.f("Name").id]: "Pancakes", [s.f("Servings").id]: 3, [s.f("Course").id]: s.option("Course", "Dessert"),
      [s.f("Tags").id]: [s.option("Tags", "Quick"), s.option("Tags", "Vegan")], [s.f("Done").id]: true
    });
    expect(stored.created_by).toBe(s.editor.userId);
    expect(stored.updated_via_key_id).toBe(editor.id);
    expect(auditRows(s.editor.userId, "collection.row_create").at(-1)).toMatchObject({ rowId: created.value.rowId, via: "mcp", keyId: editor.id });

    // Validation errors name fields; files cannot be written; required fields are enforced.
    const bad = await direct(editor, "create_row", { collectionId: s.editable.id, values: { Name: "x", Servings: "four", Course: "Brunch" } });
    expect(bad.value.code).toBe("INVALID");
    expect(Object.keys(bad.value.fieldErrors).sort()).toEqual(["Course", "Servings"]);
    expect((await direct(editor, "create_row", { collectionId: s.editable.id, values: { Unknown: 1 } })).value.fieldErrors).toEqual({ Unknown: "Unknown field" });
    expect((await direct(editor, "create_row", { collectionId: s.editable.id, values: { Name: "x", Photo: ["a"] } })).value.code).toBe("INVALID");
    expect((await direct(editor, "create_row", { collectionId: s.editable.id, values: { Servings: 1 } })).value.fieldErrors).toEqual({ Name: "This field is required" });
    expect((await direct(editor, "create_row", { collectionId: s.editable.id, values: { Name: "x", "Recipe note": insertNote(s.owner.userId, "Not readable by editor") } })).value.fieldErrors).toEqual({ "Recipe note": "You can't link this note" });
  });

  test("a legacy field named __proto__ is written by id and comes back as an ordinary key", async () => {
    const owner = await createUser("Proto owner");
    const collection = await newCollection(owner, { name: "Proto", fields: [{ name: "Item", type: "text" }, { name: "Legacy", type: "text" }] });
    // New schemas refuse the name; this collection predates the rule.
    expect((await call(owner, "POST", "", { name: "Refused", fields: [{ name: "Item", type: "text" }, { name: "__proto__", type: "text" }] })).status).toBe(400);
    const legacy = collection.fields[1]!;
    const stored = db.query("SELECT schema_json FROM collections WHERE id = ?").get(collection.id) as { schema_json: string };
    db.query("UPDATE collections SET schema_json = ? WHERE id = ?").run(stored.schema_json.replace('"name":"Legacy"', '"name":"__proto__"'), collection.id);
    const key = makeKey(owner, ["collections:write"]);
    const created = await direct(key, "create_row", { collectionId: collection.id, values: { Item: "Kettle", [legacy.id]: "kept" } });
    expect(created.isError).toBe(false);
    expect(JSON.parse((db.query("SELECT values_json FROM collection_rows WHERE id = ?").get(created.value.rowId) as { values_json: string }).values_json)[legacy.id]).toBe("kept");
    const row = await direct(key, "get_row", { rowId: created.value.rowId });
    expect(Object.keys(row.value.row.values).sort()).toEqual(["Item", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(row.value.row.values, "__proto__")?.value).toBe("kept");
  });

  test("update_row merges with revision CAS, marks the key, shows Changed by <key>, and can be undone", async () => {
    const s = await setup("Collections update");
    const key = makeKey(s.editor, ["collections:write"], "Meal planner");
    const viewer = makeKey(s.viewer, ["collections:write"]);
    expect((await callTool(viewer, "update_row", { rowId: s.pantryRow.id, values: { Item: "Salt" }, baseRevision: 1 })).value.code).toBe("READ_ONLY");
    expect((await callTool(makeKey(s.stranger, ["collections:write"]), "update_row", { rowId: s.soup.id, values: { Name: "x" }, baseRevision: 1 })).value.code).toBe("NOT_FOUND");

    const updated = await callTool(key, "update_row", { rowId: s.soup.id, values: { Servings: 5, Tags: null }, baseRevision: 1 });
    expect(updated.isError).toBe(false);
    expect(updated.value.revision).toBe(2);
    const row = (await callTool(key, "get_row", { rowId: s.soup.id })).value.row;
    // Merge: other fields are kept, null cleared Tags.
    expect(row.values).toEqual({ Name: "Soup", Servings: 5, Course: "Starter" });
    expect(row.changedByKey).toBe("Meal planner");
    expect(auditRows(s.editor.userId, "collection.row_update").at(-1)).toMatchObject({ rowId: s.soup.id, via: "mcp", keyId: key.id });

    const stale = await callTool(key, "update_row", { rowId: s.soup.id, values: { Servings: 9 }, baseRevision: 1 });
    expect(stale.value).toMatchObject({ code: "ROW_CHANGED", currentRevision: 2 });
    expect((await direct(key, "update_row", { rowId: s.soup.id, values: { Name: null }, baseRevision: 2 })).value.fieldErrors).toEqual({ Name: "This field is required" });

    // The app shows who changed it and offers Undo.
    const viaApi = await call(s.owner, "GET", `/rows/${s.soup.id}`);
    expect(viaApi.body.row).toMatchObject({ updated_via_key_id: key.id, updated_via_key_name: "Meal planner", can_undo: true });
    expect(changedByKeyText(viaApi.body.row)).toBe("Changed by the MCP key “Meal planner”");
    const { RowPanel } = await import("../src/collections/RowPanel");
    const collection = (await call(s.owner, "GET", `/${s.editable.id}`)).body.collection;
    const markup = renderToStaticMarkup(createElement(RowPanel, {
      collection, rowId: s.soup.id, editable: true, listed: viaApi.body.row, conflict: null,
      save: async () => null, onAcceptConflict: () => undefined, onActions: () => undefined, onUndo: () => undefined, onClose: () => undefined, onMissing: () => undefined
    }));
    expect(markup).toContain("Changed by the MCP key “Meal planner”");
    expect(markup).toMatch(/<button[^>]*>.*Undo<\/button>/);
    const undone = await call(s.owner, "POST", `/rows/${s.soup.id}/undo`, { revision: 2 });
    expect(undone.status).toBe(200);
    expect(undone.body.row.updated_via_key_id).toBeNull();
    // A person's edit clears the mark.
    expect((await call(s.owner, "PATCH", `/rows/${s.soup.id}`, { values: { [s.f("Servings").id]: 7 }, revision: 3 })).body.row.updated_via_key_id).toBeNull();
  });

  test("writes are capped at 500 a day per key, and per user across keys", async () => {
    const s = await setup("Collections caps");
    const key = makeKey(s.owner, ["collections:write"]);
    expect(MCP_LIMITS.row_write.limit).toBe(500);
    for (let index = 0; index < 500; index += 1) consumeMcpLimits({ keyId: key.id }, ["row_write"]);
    expect((await callTool(key, "create_row", { collectionId: s.editable.id, values: { Name: "One more" } })).value.code).toBe("RATE_LIMITED");
    expect((await callTool(key, "update_row", { rowId: s.soup.id, values: { Servings: 1 }, baseRevision: 1 })).value.code).toBe("RATE_LIMITED");
    expect((await callTool(key, "query_rows", { collectionId: s.editable.id })).isError).toBe(false);
    for (let index = 0; index < 1000; index += 1) consumeMcpLimits({ keyId: `other-${index}`, userId: s.owner.userId }, ["row_write"]);
    expect((await callTool(makeKey(s.owner, ["collections:write"], "Fresh"), "create_row", { collectionId: s.editable.id, values: { Name: "User cap" } })).value.code).toBe("RATE_LIMITED");
  });
});

describe("Today collectionsRecent", () => {
  test("lists recently edited rows in readable collections, titles only, for sessions and keys with collections:read", async () => {
    const s = await setup("Collections today");
    await addRow(s.owner, s.editable.id, { [s.f("Name").id]: "Latest", [s.f("Servings").id]: 12 });
    const web = (await (await request("/today?tz=UTC", {}, s.viewer)).json()) as { sections: Record<string, { items: Array<Record<string, unknown>>; href: string }> };
    const recent = web.sections.collectionsRecent!;
    expect(recent.href).toBe("/collections");
    expect(recent.items[0]).toMatchObject({ collectionId: s.editable.id, title: "Latest", changedByKey: false });
    const titles = recent.items.map((item) => item.title);
    expect(titles).toContain("Flour");
    expect(titles).not.toContain("Hidden");
    // Titles and ids only: no other values.
    expect(Object.keys(recent.items[0]!).sort()).toEqual(["changedByKey", "collectionId", "collectionName", "rowId", "title", "updated_at"]);
    const stranger = (await (await request("/today?tz=UTC", {}, s.stranger)).json()) as { sections: Record<string, { items: unknown[] }> };
    const mine = new Set([s.editable.id, s.readOnly.id, s.privateCollection.id]);
    expect((stranger.sections.collectionsRecent!.items as Array<{ collectionId: string }>).filter((item) => mine.has(item.collectionId))).toEqual([]);

    const today = async (scopes: McpScope[]) => JSON.parse((await invokeMcpToolForTests("get_today", {}, makeKey(s.viewer, scopes).id)).content[0]!.text) as { sections: Record<string, unknown> };
    expect(Object.keys((await today(["today:read"])).sections)).not.toContain("collectionsRecent");
    resetTodayRateLimit();
    expect(Object.keys((await today(["today:read", "collections:read"])).sections)).toEqual(["collectionsRecent", "binSoon", "storage"]);
    expect(Object.keys((await today(["today:read", "collections:write"])).sections)).toContain("collectionsRecent");
  });
});

