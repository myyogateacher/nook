import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, call, newCollection, shareCollection } from "./support/collections";

async function upload(session: Session, purpose: "file" | "collection_attachment", name = "receipt.txt") {
  const body = new FormData();
  body.append("file", new Blob([`contents of ${name}`]), name);
  const response = await request(`/files?purpose=${purpose}`, { method: "POST", body }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

const content = (session: Session, documentId: string) => request(`/files/${documentId}/content`, {}, session).then((response) => response.status);
const metadata = (session: Session, documentId: string) => request(`/files/${documentId}`, {}, session).then((response) => response.status);
const filesList = async (session: Session) => ((await (await request("/files", {}, session)).json()) as { documents: Array<{ id: string }> }).documents.map((document) => document.id);

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const collection = await newCollection(owner, { name: "Warranties", fields: [{ name: "Item", type: "text" }, { name: "Receipt", type: "file" }, { name: "Notes", type: "text" }] });
  const [item, receipt, notes] = collection.fields;
  const row = await addRow(owner, collection.id, { [item!.id]: "Fridge" });
  return { owner, member, stranger, collection, row, item: item!, receipt: receipt!, notes: notes! };
}

describe("row attachments", () => {
  test("a linked upload is readable through a live row, never listed in Files, and 404 after unshare, bin, or unlink", async () => {
    const { owner, member, stranger, collection, row, receipt } = await setup("Attach");
    const documentId = await upload(owner, "collection_attachment");
    const attached = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id });
    expect(attached.status).toBe(201);
    expect(attached.body.row.files[receipt.id].map((file: { id: string; name: string }) => [file.id, file.name])).toEqual([[documentId, "receipt.txt"]]);
    expect(attached.body.row.values[receipt.id]).toBeUndefined();

    // Not readable before sharing, readable after, and never listed in Files for anyone.
    expect(await content(member, documentId)).toBe(404);
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    expect(await content(member, documentId)).toBe(200);
    expect(await metadata(member, documentId)).toBe(200);
    expect(await content(stranger, documentId)).toBe(404);
    expect(await filesList(member)).not.toContain(documentId);
    expect(await filesList(owner)).not.toContain(documentId);
    const contentResponse = await request(`/files/${documentId}/content`, {}, member);
    expect(contentResponse.headers.get("cache-control")).toContain("no-store");

    // Unshare revokes at once.
    await shareCollection(owner, collection.id, "private");
    expect(await content(member, documentId)).toBe(404);
    await shareCollection(owner, collection.id, "all_users");
    expect(await content(member, documentId)).toBe(200);

    // Binning the row, then the collection, revokes; restoring the row data brings it back.
    expect((await call(owner, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    expect(await content(member, documentId)).toBe(404);
    db.query("UPDATE collection_rows SET deleted_at = NULL, purge_after = NULL, deleted_by = NULL WHERE id = ?").run(row.id);
    expect(await content(member, documentId)).toBe(200);
    expect((await call(owner, "DELETE", `/${collection.id}`)).status).toBe(200);
    expect(await content(member, documentId)).toBe(404);
    db.query("UPDATE collections SET deleted_at = NULL, purge_after = NULL, deleted_by = NULL WHERE id = ?").run(collection.id);

    // The last unlink moves the upload to the uploader's Bin.
    const detached = await call(owner, "DELETE", `/rows/${row.id}/attachments/${documentId}`);
    expect(detached.status).toBe(200);
    expect(detached.body.documentBinned).toBe(true);
    expect(await content(member, documentId)).toBe(404);
    expect(await content(owner, documentId)).toBe(404);
    const document = db.query("SELECT deleted_at, deleted_by, purpose, folder_id FROM documents WHERE id = ?").get(documentId) as { deleted_at: string | null; deleted_by: string; purpose: string; folder_id: string | null };
    expect(document).toMatchObject({ deleted_by: owner.userId, purpose: "collection_attachment", folder_id: null });
    expect(document.deleted_at).not.toBeNull();
    // Restoring an attachment no row links any more makes it a Files item in the uploader's
    // Default folder, never a hidden orphan; nobody else gains access.
    expect((await request(`/bin/document/${documentId}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    const defaultFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    expect(db.query("SELECT purpose, folder_id FROM documents WHERE id = ?").get(documentId)).toEqual({ purpose: "file", folder_id: defaultFolder });
    expect(await filesList(owner)).toContain(documentId);
    expect(await content(member, documentId)).toBe(404);
  });

  test("a binned attachment that a row still links is restored as an attachment, outside every folder", async () => {
    const { owner, member, collection, row, receipt } = await setup("Linked restore");
    await shareCollection(owner, collection.id, "all_users");
    const documentId = await upload(owner, "collection_attachment", "linked.txt");
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id })).status).toBe(201);
    db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), owner.userId, new Date(Date.now() + 86_400_000).toISOString(), documentId);
    const binItem = async () => ((await (await request("/bin", {}, owner)).json()) as { items: Array<{ id: string; attachment: boolean; attachment_of: string | null; attachment_kind: string | null }> }).items.find((item) => item.id === documentId);
    // The Bin names the row it still belongs to; once the row is binned it is still a row attachment.
    expect(await binItem()).toMatchObject({ attachment: true, attachment_of: "Fridge", attachment_kind: "row" });
    db.query("UPDATE collection_rows SET deleted_at = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), row.id);
    expect(await binItem()).toMatchObject({ attachment: true, attachment_of: null, attachment_kind: "row" });
    db.query("UPDATE collection_rows SET deleted_at = NULL, purge_after = NULL WHERE id = ?").run(row.id);
    expect((await request(`/bin/document/${documentId}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(db.query("SELECT purpose, folder_id, deleted_at FROM documents WHERE id = ?").get(documentId)).toEqual({ purpose: "collection_attachment", folder_id: null, deleted_at: null });
    expect(await filesList(owner)).not.toContain(documentId);
    expect(await content(member, documentId)).toBe(200);
  });

  test("files linked in the same millisecond list, and snapshot for Undo, in linking order whatever their random ids", async () => {
    const { owner, row, receipt } = await setup("Link ties");
    const timestamp = new Date().toISOString();
    const insert = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at, purpose)
      VALUES (?, ?, NULL, 'f.txt', 'text/plain', 'text', 1, ?, ?, ?, 'collection_attachment')`);
    const link = db.query("INSERT INTO collection_row_attachments (row_id, document_id, field_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)");
    // Each later link gets a smaller document id, so a document-id tie-break would reverse them.
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort().reverse();
    for (const id of ids) {
      insert.run(id, owner.userId, "d".repeat(64), timestamp, timestamp);
      link.run(row.id, id, receipt.id, owner.userId, timestamp);
    }
    const read = await call(owner, "GET", `/rows/${row.id}`);
    expect(read.body.row.files[receipt.id].map((file: { id: string }) => file.id)).toEqual(ids);
    // The next link change stores the links before it for Undo, in the same order.
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: await upload(owner, "collection_attachment"), fieldId: receipt.id })).status).toBe(201);
    const stored = db.query("SELECT prev_values_json FROM collection_rows WHERE id = ?").get(row.id) as { prev_values_json: string };
    expect((JSON.parse(stored.prev_values_json).$attachments as string[][]).map((snapshot) => snapshot[0])).toEqual(ids);
  });

  test("linking and unlinking bump the row revision, and Undo reverts them", async () => {
    const { owner, row, receipt, item } = await setup("Link undo");
    const documentId = await upload(owner, "collection_attachment", "undo.txt");
    const attached = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id });
    expect(attached.body.row).toMatchObject({ revision: row.revision + 1, can_undo: true });
    const stored = db.query("SELECT prev_values_json, prev_revision FROM collection_rows WHERE id = ?").get(row.id) as { prev_values_json: string; prev_revision: number };
    expect(stored.prev_revision).toBe(row.revision);
    expect(JSON.parse(stored.prev_values_json)).toEqual({ [item.id]: "Fridge", $attachments: [] });
    // The stale revision is refused like any other write.
    expect((await call(owner, "POST", `/rows/${row.id}/undo`, { revision: row.revision })).status).toBe(409);

    // Undo of the link removes it, and the upload no row links any more goes to the Bin.
    const undone = await call(owner, "POST", `/rows/${row.id}/undo`, { revision: attached.body.row.revision });
    expect(undone.status).toBe(200);
    expect(undone.body.row.files[receipt.id] ?? []).toEqual([]);
    expect(undone.body.row.values).toEqual({ [item.id]: "Fridge" });
    expect((db.query("SELECT deleted_at FROM documents WHERE id = ?").get(documentId) as { deleted_at: string | null }).deleted_at).not.toBeNull();

    // Unlink, then Undo: the upload comes back from the Bin with its link.
    const second = await upload(owner, "collection_attachment", "second.txt");
    const relinked = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: second, fieldId: receipt.id });
    const detached = await call(owner, "DELETE", `/rows/${row.id}/attachments/${second}`);
    expect(detached.body).toMatchObject({ documentBinned: true, row: { revision: relinked.body.row.revision + 1, can_undo: true } });
    const restored = await call(owner, "POST", `/rows/${row.id}/undo`, { revision: detached.body.row.revision });
    expect(restored.status).toBe(200);
    expect(restored.body.row.files[receipt.id].map((file: { id: string }) => file.id)).toEqual([second]);
    expect(restored.body.row.can_undo).toBe(false);
    expect(db.query("SELECT deleted_at, purpose FROM documents WHERE id = ?").get(second)).toEqual({ deleted_at: null, purpose: "collection_attachment" });
    expect(await content(owner, second)).toBe(200);
  });

  test("Undo of a link change follows the attach and unlink rules for the undoer", async () => {
    const { owner, member, stranger, collection, row, receipt } = await setup("Undo rules");
    await shareCollection(owner, collection.id, "selected", [member.userId, stranger.userId], "editor");
    const linkedDocument = (documentId: string) => db.query("SELECT linked_by FROM collection_row_attachments WHERE row_id = ? AND document_id = ?").get(row.id, documentId) as { linked_by: string } | null;

    // Editor A links, then unlinks, a private Files item; editor B cannot undo the unlink.
    const privateFile = await upload(member, "file", "private.txt");
    await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: privateFile, fieldId: receipt.id });
    const unlinked = await call(member, "DELETE", `/rows/${row.id}/attachments/${privateFile}`);
    expect(unlinked.status).toBe(200);
    const refused = await call(stranger, "POST", `/rows/${row.id}/undo`, { revision: unlinked.body.row.revision });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "NOT_LINKER", documentIds: [privateFile] });
    expect(linkedDocument(privateFile)).toBeNull();
    expect(await content(stranger, privateFile)).toBe(404);
    // Even the collection owner cannot link a document someone else owns.
    expect((await call(owner, "POST", `/rows/${row.id}/undo`, { revision: unlinked.body.row.revision })).status).toBe(403);
    // A can undo their own unlink.
    const ownUndo = await call(member, "POST", `/rows/${row.id}/undo`, { revision: unlinked.body.row.revision });
    expect(ownUndo.status).toBe(200);
    expect(linkedDocument(privateFile)).toEqual({ linked_by: member.userId });
    await call(member, "DELETE", `/rows/${row.id}/attachments/${privateFile}`);

    // B cannot undo A's attach: A's link stays and A's upload is not binned.
    const upload1 = await upload(member, "collection_attachment", "a.txt");
    const attached = await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: upload1, fieldId: receipt.id });
    const blocked = await call(stranger, "POST", `/rows/${row.id}/undo`, { revision: attached.body.row.revision });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: "NOT_LINKER", documentIds: [upload1] });
    expect(linkedDocument(upload1)).toEqual({ linked_by: member.userId });
    expect((db.query("SELECT deleted_at FROM documents WHERE id = ?").get(upload1) as { deleted_at: string | null }).deleted_at).toBeNull();

    // The collection owner may undo anyone's attach, as they may unlink anyone's file.
    const ownerUndo = await call(owner, "POST", `/rows/${row.id}/undo`, { revision: attached.body.row.revision });
    expect(ownerUndo.status).toBe(200);
    expect(linkedDocument(upload1)).toBeNull();
    expect(db.query("SELECT deleted_by FROM documents WHERE id = ? AND deleted_at IS NOT NULL").get(upload1)).toEqual({ deleted_by: owner.userId });
  });

  test("Files items the linker owns can be linked and are never binned on unlink", async () => {
    const { owner, member, collection, row, receipt } = await setup("Own file");
    const fileId = await upload(owner, "file", "manual.txt");
    await shareCollection(owner, collection.id, "all_users");
    expect(await content(member, fileId)).toBe(404);
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: fileId, fieldId: receipt.id })).status).toBe(201);
    expect(await content(member, fileId)).toBe(200);
    // Still listed in the owner's Files, never in the member's.
    expect(await filesList(owner)).toContain(fileId);
    expect(await filesList(member)).not.toContain(fileId);
    const detached = await call(owner, "DELETE", `/rows/${row.id}/attachments/${fileId}`);
    expect(detached.body.documentBinned).toBe(false);
    expect((db.query("SELECT deleted_at FROM documents WHERE id = ?").get(fileId) as { deleted_at: string | null }).deleted_at).toBeNull();
    expect(await content(member, fileId)).toBe(404);
  });

  test("only editors link their own live documents to file fields; linkers or the owner unlink; 20 per row", async () => {
    const { owner, member, stranger, collection, row, receipt, notes } = await setup("Attach rules");
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    const memberUpload = await upload(member, "collection_attachment", "theirs.txt");
    const ownerUpload = await upload(owner, "collection_attachment", "mine.txt");
    const viewerTry = await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: memberUpload, fieldId: receipt.id });
    expect([viewerTry.status, viewerTry.body.code]).toEqual([403, "READ_ONLY"]);
    expect((await call(stranger, "POST", `/rows/${row.id}/attachments`, { documentId: memberUpload, fieldId: receipt.id })).status).toBe(404);

    await shareCollection(owner, collection.id, "selected", [member.userId], "editor");
    // Someone else's document, a text field, an unknown document, and a binned document are refused.
    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: ownerUpload, fieldId: receipt.id })).status).toBe(404);
    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: memberUpload, fieldId: notes.id })).status).toBe(400);
    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: crypto.randomUUID(), fieldId: receipt.id })).status).toBe(404);
    const taskDoc = crypto.randomUUID();
    db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at, purpose)
      VALUES (?, ?, NULL, 't.txt', 'text/plain', 'text', 1, ?, ?, ?, 'task_attachment')`).run(taskDoc, member.userId, "c".repeat(64), new Date().toISOString(), new Date().toISOString());
    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: taskDoc, fieldId: receipt.id })).status).toBe(404);

    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: memberUpload, fieldId: receipt.id })).status).toBe(201);
    const again = await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: memberUpload, fieldId: receipt.id });
    expect([again.status, again.body.code]).toEqual([409, "ALREADY_ATTACHED"]);
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: ownerUpload, fieldId: receipt.id })).status).toBe(201);
    // The member did not link the owner's upload.
    const notLinker = await call(member, "DELETE", `/rows/${row.id}/attachments/${ownerUpload}`);
    expect([notLinker.status, notLinker.body.code]).toEqual([403, "NOT_LINKER"]);
    // The owner may unlink anything.
    expect((await call(owner, "DELETE", `/rows/${row.id}/attachments/${memberUpload}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/rows/${row.id}/attachments/${memberUpload}`)).status).toBe(404);

    const insert = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at, purpose)
      VALUES (?, ?, NULL, 'f.txt', 'text/plain', 'text', 1, ?, ?, ?, 'collection_attachment')`);
    const link = db.query("INSERT INTO collection_row_attachments (row_id, document_id, field_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)");
    for (let index = 0; index < 19; index += 1) {
      const id = crypto.randomUUID();
      insert.run(id, owner.userId, "d".repeat(64), new Date().toISOString(), new Date().toISOString());
      link.run(row.id, id, receipt.id, owner.userId, new Date().toISOString());
    }
    const full = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: await upload(owner, "collection_attachment"), fieldId: receipt.id });
    expect([full.status, full.body.code]).toEqual([409, "LIMIT_REACHED"]);
  });

  test("Files routes never rename, move, share, or bin a linked row attachment; sharing rows never widen it", async () => {
    const { owner, member, collection, row, receipt } = await setup("Files rule");
    const documentId = await upload(owner, "collection_attachment");
    const folderId = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
    expect((await request(`/files/${documentId}`, json("PATCH", { name: "renamed.txt" }), owner)).status).toBe(404);
    expect((await request(`/files/${documentId}`, json("PATCH", { folderId }), owner)).status).toBe(404);
    expect((await request(`/files/${documentId}/sharing`, {}, owner)).status).toBe(404);
    expect((await request(`/files/${documentId}/sharing`, json("PUT", { visibility: "all_users", userIds: [] }), owner)).status).toBe(404);
    // Sharing rows or a folder set before this rule never make an attachment readable.
    db.query("UPDATE documents SET sharing_override = 1, visibility = 'all_users' WHERE id = ?").run(documentId);
    expect(await content(member, documentId)).toBe(404);
    db.query("UPDATE documents SET sharing_override = 0, visibility = 'private', folder_id = ? WHERE id = ?").run(folderId, documentId);
    db.query("UPDATE folders SET visibility = 'all_users' WHERE id = ?").run(folderId);
    expect(await content(member, documentId)).toBe(404);
    db.query("UPDATE folders SET visibility = 'private' WHERE id = ?").run(folderId);
    db.query("UPDATE documents SET folder_id = NULL WHERE id = ?").run(documentId);
    // While a row links it, DELETE /api/files is refused; the owner still reads it.
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id })).status).toBe(201);
    const linked = await request(`/files/${documentId}`, json("DELETE", {}), owner);
    expect(linked.status).toBe(409);
    expect(((await linked.json()) as { code: string }).code).toBe("ATTACHMENT_LINKED");
    expect(await content(owner, documentId)).toBe(200);
    await shareCollection(owner, collection.id, "all_users");
    expect(await content(member, documentId)).toBe(200);
    // Unlinked (here by the owner through the row), the upload is binned; an unlinked upload can be deleted directly.
    await call(owner, "DELETE", `/rows/${row.id}/attachments/${documentId}`);
    const spare = await upload(owner, "collection_attachment");
    expect((await request(`/files/${spare}`, json("DELETE", {}), owner)).status).toBe(200);
  });

  test("the sweeper bins uploads that were never linked to a row after 24 hours", async () => {
    const { owner, row, receipt } = await setup("Sweep unlinked");
    const { sweepUnlinkedRowAttachments } = await import("../server/collections/sweep");
    const stale = await upload(owner, "collection_attachment", "stale.txt");
    const linked = await upload(owner, "collection_attachment", "linked.txt");
    const fresh = await upload(owner, "collection_attachment", "fresh.txt");
    const fileItem = await upload(owner, "file", "file.txt");
    await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: linked, fieldId: receipt.id });
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    for (const id of [stale, linked, fileItem]) db.query("UPDATE documents SET created_at = ? WHERE id = ?").run(old, id);
    expect(sweepUnlinkedRowAttachments()).toBeGreaterThanOrEqual(1);
    const state = (id: string) => db.query("SELECT deleted_at IS NOT NULL AS binned, deleted_by FROM documents WHERE id = ?").get(id) as { binned: number; deleted_by: string | null };
    expect(state(stale)).toEqual({ binned: 1, deleted_by: null });
    expect(state(linked).binned).toBe(0);
    expect(state(fresh).binned).toBe(0);
    expect(state(fileItem).binned).toBe(0);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.delete' AND metadata_json LIKE ?").get(`%${stale}%`) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ documentId: stale, reason: "attachment_never_linked" });
  });

  test("IDOR: attachment routes join the row to a readable collection", async () => {
    const first = await setup("IDOR one");
    const second = await setup("IDOR two");
    const documentId = await upload(first.owner, "collection_attachment");
    await call(first.owner, "POST", `/rows/${first.row.id}/attachments`, { documentId, fieldId: first.receipt.id });
    // The other owner cannot detach through their own row or reach the first row.
    expect((await call(second.owner, "DELETE", `/rows/${second.row.id}/attachments/${documentId}`)).status).toBe(404);
    expect((await call(second.owner, "DELETE", `/rows/${first.row.id}/attachments/${documentId}`)).status).toBe(404);
    expect((await call(second.owner, "POST", `/rows/${second.row.id}/attachments`, { documentId, fieldId: second.receipt.id })).status).toBe(404);
    expect(await content(second.owner, documentId)).toBe(404);
  });

  test("note links never grant access: unreadable notes stay restricted for other readers", async () => {
    const owner = await createUser("Link owner");
    const reader = await createUser("Link reader");
    const collection = await newCollection(owner, { name: "Links", fields: [{ name: "Name", type: "text" }, { name: "Note", type: "note" }] });
    const [name, note] = collection.fields;
    const noteId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES (?, ?, NULL, 'Private plans', 1, ?, ?)").run(noteId, owner.userId, timestamp, timestamp);
    const row = await addRow(owner, collection.id, { [name!.id]: "Trip", [note!.id]: noteId });
    await shareCollection(owner, collection.id, "all_users");
    const seen = await call(reader, "GET", `/rows/${row.id}`);
    expect(seen.body.row.links[note!.id]).toEqual({ id: noteId, restricted: true });
    expect(JSON.stringify(seen.body)).not.toContain("Private plans");
    expect((await request(`/notes/${noteId}`, {}, reader)).status).toBe(404);
    expect((await call(owner, "GET", `/rows/${row.id}`)).body.row.links[note!.id]).toEqual({ id: noteId, title: "Private plans" });
  });
});
