import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, call, newCollection, shareCollection } from "./support/collections";

const { binProviders, sweepBin } = await import("../server/bin");

type BinItem = { type: string; id: string; title: string; folder_id: string | null; folder_name: string | null; can_purge?: boolean };

async function bin(session: Session, type?: string) {
  const response = await request(`/bin${type ? `?type=${type}` : ""}`, {}, session);
  return { status: response.status, items: response.ok ? ((await response.json()) as { items: BinItem[] }).items : [] };
}
const restore = (session: Session, type: string, id: string) => request(`/bin/${type}/${id}/restore`, { method: "POST", body: "{}" }, session)
  .then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
const purge = (session: Session, type: string, id: string) => request(`/bin/${type}/${id}`, { method: "DELETE", body: "{}" }, session).then((response) => response.status);

async function uploadAttachment(session: Session, name = "a.txt") {
  const body = new FormData();
  body.append("file", new Blob([name]), name);
  const response = await request("/files?purpose=collection_attachment", { method: "POST", body }, session);
  return ((await response.json()) as { document: { id: string } }).document.id;
}
const documentDeleted = (id: string) => (db.query("SELECT deleted_at FROM documents WHERE id = ?").get(id) as { deleted_at: string | null }).deleted_at !== null;

describe("collections in the Bin", () => {
  test("a binned collection is listed for its owner only, restores with a CAS, and respects the cap", async () => {
    const owner = await createUser("Bin owner");
    const member = await createUser("Bin member");
    const collection = await newCollection(owner, { name: "Old stuff" });
    await shareCollection(owner, collection.id, "selected", [member.userId], "editor");
    expect((await call(owner, "DELETE", `/${collection.id}`)).status).toBe(200);
    expect((await call(member, "GET", `/${collection.id}`)).status).toBe(404);
    const listed = await bin(owner);
    expect(listed.items.find((item) => item.id === collection.id)).toMatchObject({ type: "collection", title: "Old stuff" });
    expect((await bin(owner, "collection")).items.map((item) => item.id)).toEqual([collection.id]);
    expect((await bin(owner, "note")).items.some((item) => item.id === collection.id)).toBe(false);
    expect((await bin(member)).items.some((item) => item.id === collection.id)).toBe(false);
    expect((await restore(member, "collection", collection.id)).status).toBe(404);
    expect(await purge(member, "collection", collection.id)).toBe(404);
    expect((await bin(owner, "cards")).status).toBe(400);

    const restored = await restore(owner, "collection", collection.id);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, visibility: "selected" });
    expect((await restore(owner, "collection", collection.id)).body.alreadyRestored).toBe(true);
    // Sharing was kept, so the member regains access.
    expect((await call(member, "GET", `/${collection.id}`)).status).toBe(200);
    expect(await purge(owner, "collection", collection.id)).toBe(409);

    await call(owner, "DELETE", `/${collection.id}`);
    const timestamp = new Date().toISOString();
    const filler = db.query("INSERT INTO collections (id, owner_id, name, schema_json, created_at, updated_at) VALUES (?, ?, 'Filler', '{\"fields\":[]}', ?, ?)");
    for (let index = 0; index < 100; index += 1) filler.run(crypto.randomUUID(), owner.userId, timestamp, timestamp);
    const capped = await restore(owner, "collection", collection.id);
    expect([capped.status, capped.body.code]).toEqual([409, "LIMIT_REACHED"]);
  });

  test("a binned row is listed for the owner and its deleter; either restores, only the owner purges; PARENT_IN_BIN", async () => {
    const owner = await createUser("Row bin owner");
    const editor = await createUser("Row bin editor");
    const stranger = await createUser("Row bin stranger");
    const collection = await newCollection(owner, { name: "Chores", fields: [{ name: "Task", type: "text" }] });
    await shareCollection(owner, collection.id, "selected", [editor.userId], "editor");
    const row = await addRow(editor, collection.id, { [collection.fields[0]!.id]: "Dishes" });
    const other = await addRow(owner, collection.id, { [collection.fields[0]!.id]: "Laundry" });
    expect((await call(editor, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/rows/${other.id}`)).status).toBe(200);

    const forEditor = (await bin(editor, "collection_row")).items;
    expect(forEditor.map((item) => [item.title, item.folder_name, item.can_purge])).toEqual([["Dishes", "Chores", false]]);
    const forOwner = (await bin(owner, "collection_row")).items;
    expect(forOwner.map((item) => item.title).sort()).toEqual(["Dishes", "Laundry"]);
    expect(forOwner.every((item) => item.can_purge)).toBe(true);
    expect((await bin(stranger)).items.some((item) => item.id === row.id)).toBe(false);
    expect((await restore(stranger, "collection_row", row.id)).status).toBe(404);
    // The editor did not bin Laundry, so it is not theirs to restore.
    expect((await restore(editor, "collection_row", other.id)).status).toBe(404);
    expect(await purge(editor, "collection_row", row.id)).toBe(404);

    // With the collection itself in the Bin, a child restore is refused until the parent is back.
    expect((await call(owner, "DELETE", `/${collection.id}`)).status).toBe(200);
    const blocked = await restore(owner, "collection_row", other.id);
    expect([blocked.status, blocked.body.code]).toEqual([409, "PARENT_IN_BIN"]);
    expect((await restore(owner, "collection", collection.id)).status).toBe(200);

    const restored = await restore(editor, "collection_row", row.id);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ folderId: collection.id, folderName: "Chores" });
    expect((await call(editor, "GET", `/rows/${row.id}`)).body.row.title).toBe("Dishes");

    // A deleter who can no longer edit the collection cannot restore.
    expect((await call(editor, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    await shareCollection(owner, collection.id, "selected", [editor.userId], "viewer");
    expect((await restore(editor, "collection_row", row.id)).status).toBe(404);
    // ...and no longer sees it (its title or the collection name) in their Bin; the owner still does.
    expect((await bin(editor)).items.some((item) => item.id === row.id)).toBe(false);
    expect((await bin(editor, "collection_row")).items).toEqual([]);
    await shareCollection(owner, collection.id, "private");
    expect((await bin(editor)).items.some((item) => item.id === row.id)).toBe(false);
    expect((await bin(owner, "collection_row")).items.some((item) => item.id === row.id)).toBe(true);

    expect(await purge(owner, "collection_row", other.id)).toBe(200);
    expect(db.query("SELECT 1 FROM collection_rows WHERE id = ?").get(other.id)).toBeNull();
    const events = db.query("SELECT event_type FROM audit_log WHERE event_type LIKE 'collection.row_%' AND metadata_json LIKE ?").all(`%${other.id}%`) as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toContain("collection.row_purge");
  });

  test("purges move attachments no other row links to the Bin, and the sweeper purges by retention", async () => {
    const owner = await createUser("Sweep owner");
    const collection = await newCollection(owner, { name: "Receipts", fields: [{ name: "Item", type: "text" }, { name: "Scan", type: "file" }] });
    const [item, scan] = collection.fields;
    const first = await addRow(owner, collection.id, { [item!.id]: "TV" });
    const second = await addRow(owner, collection.id, { [item!.id]: "Radio" });
    const only = await uploadAttachment(owner, "only.txt");
    const shared = await uploadAttachment(owner, "shared.txt");
    for (const [rowId, documentId] of [[first.id, only], [first.id, shared], [second.id, shared]] as const) {
      expect((await call(owner, "POST", `/rows/${rowId}/attachments`, { documentId, fieldId: scan!.id })).status).toBe(201);
    }
    // Purging the first row bins its own upload; the shared one is still linked by the second row.
    await call(owner, "DELETE", `/rows/${first.id}`);
    expect(await purge(owner, "collection_row", first.id)).toBe(200);
    expect(documentDeleted(only)).toBe(true);
    expect(documentDeleted(shared)).toBe(false);

    // The sweeper purges a collection whose retention ended, rows and all, and bins its last attachment.
    await call(owner, "DELETE", `/${collection.id}`);
    const past = new Date(Date.now() - 1000).toISOString();
    db.query("UPDATE collections SET purge_after = ? WHERE id = ?").run(past, collection.id);
    const counts = await sweepBin();
    expect(counts.purged).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT 1 FROM collections WHERE id = ?").get(collection.id)).toBeNull();
    expect(db.query("SELECT 1 FROM collection_rows WHERE id = ?").get(second.id)).toBeNull();
    expect(documentDeleted(shared)).toBe(true);
    // An Attachments-folder file binned by its links' end is recorded as removed by its owner (D395; U8).
    expect((db.query("SELECT deleted_by FROM documents WHERE id = ?").get(shared) as { deleted_by: string | null }).deleted_by).toBe(owner.userId);
    // A binned row whose retention ended is swept too.
    const again = await newCollection(owner, { name: "Again" });
    const row = await addRow(owner, again.id, { [again.fields[0]!.id]: "Old" });
    await call(owner, "DELETE", `/rows/${row.id}`);
    db.query("UPDATE collection_rows SET purge_after = ? WHERE id = ?").run(past, row.id);
    await sweepBin();
    expect(db.query("SELECT 1 FROM collection_rows WHERE id = ?").get(row.id)).toBeNull();
    expect(db.query("SELECT 1 FROM collections WHERE id = ?").get(again.id)).toBeTruthy();
  });

  test("Empty Bin purges the owner's collections and rows", async () => {
    const owner = await createUser("Empty owner");
    const doomed = await newCollection(owner, { name: "Doomed" });
    const kept = await newCollection(owner, { name: "Kept" });
    const row = await addRow(owner, kept.id, { [kept.fields[0]!.id]: "Gone" });
    await call(owner, "DELETE", `/${doomed.id}`);
    await call(owner, "DELETE", `/rows/${row.id}`);
    const emptied = await request("/bin", { method: "DELETE", body: "{}" }, owner);
    expect(emptied.status).toBe(200);
    expect(((await emptied.json()) as { purged: number }).purged).toBeGreaterThanOrEqual(2);
    expect(db.query("SELECT 1 FROM collections WHERE id = ?").get(doomed.id)).toBeNull();
    expect(db.query("SELECT 1 FROM collection_rows WHERE id = ?").get(row.id)).toBeNull();
    expect(db.query("SELECT 1 FROM collections WHERE id = ?").get(kept.id)).toBeTruthy();
  });
  test("a provided Bin type without a registered provider is refused with 400, never a 500", async () => {
    const owner = await createUser("Unregistered owner");
    const collection = await newCollection(owner, { name: "Gone module", fields: [{ name: "Task", type: "text" }] });
    const row = await addRow(owner, collection.id, { [collection.fields[0]!.id]: "Orphan" });
    expect((await call(owner, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    const provider = binProviders.get("collection_row")!;
    binProviders.delete("collection_row");
    try {
      expect((await bin(owner, "collection_row")).status).toBe(400);
      expect((await restore(owner, "collection_row", row.id)).status).toBe(400);
      expect(await purge(owner, "collection_row", row.id)).toBe(400);
      // The rest of the Bin keeps working, and the unregistered type is simply absent.
      const all = await bin(owner);
      expect(all.status).toBe(200);
      expect(all.items.some((item) => item.id === row.id)).toBe(false);
      expect((await bin(owner, "collection")).status).toBe(200);
    } finally {
      binProviders.set("collection_row", provider);
    }
    expect((await restore(owner, "collection_row", row.id)).status).toBe(200);
  });
});
