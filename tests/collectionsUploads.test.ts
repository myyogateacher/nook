import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, call, newCollection, shareCollection } from "./support/collections";
import { attachmentsFolderOf, calendarWithEvent, contentStatus, filesList, link, listOn, upload, uploadAttachment } from "./support/attachments";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type Grant = import("../server/keyGrants").Grant;

/**
 * Uploads everywhere U3 (collections, G7): row uploads land in the uploader's Attachments folder
 * (`?attachTo=row`), Files items need the From Files confirm (D396), access follows the collection's
 * sharing live (D58, T340), the row's Bin and purge follow D395, MCP attaches only uploads made to
 * attach (D402, T341, T345), and CSV export carries names only (D407).
 */

beforeEach(() => resetMcpLimits());

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const on = (module: Grant["module"], permission: Grant["permission"], id: string): Grant => ({ module, permission, resourceKind: "collection", resourceId: id });
const makeKey = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Receipts agent", surfaces: "both", grants, expiresInDays: 30 });
async function tool(keyId: string, name: string, args: Record<string, unknown> = {}, surface: "mcp" | "rest" = "mcp") {
  const result = await invokeMcpToolForTests(name, args, keyId, surface);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
const docState = (id: string) => db.query("SELECT d.deleted_at IS NOT NULL AS binned, d.purpose, f.system_kind FROM documents d LEFT JOIN folders f ON f.id = d.folder_id WHERE d.id = ?").get(id) as { binned: number; purpose: string; system_kind: string | null };

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const collection = await newCollection(owner, { name: `${label} receipts`, fields: [{ name: "Item", type: "text" }, { name: "Receipt", type: "file" }, { name: "Photos", type: "file" }] });
  const [item, receipt, photos] = collection.fields;
  const row = await addRow(owner, collection.id, { [item!.id]: "Lunch" });
  return { owner, member, stranger, collection, row, item: item!, receipt: receipt!, photos: photos! };
}

describe("row uploads in the Attachments folder", () => {
  test("an attachTo=row upload links without a confirm, follows the collection's sharing, and lives in Files › Attachments", async () => {
    const { owner, member, stranger, collection, row, receipt } = await setup("U3 access");
    const documentId = await uploadAttachment(owner, "receipt.txt", "Lunch 12.50", "row");
    expect(docState(documentId)).toEqual({ binned: 0, purpose: "file", system_kind: "attachments" });
    const attached = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id });
    expect(attached.status).toBe(201);
    expect(attached.body.row.files[receipt.id].map((file: { id: string; name: string }) => [file.id, file.name])).toEqual([[documentId, "receipt.txt"]]);
    // The uploader sees it in Files (in their Attachments folder); others never get it in a list.
    expect(await filesList(owner)).toContain(documentId);

    expect(await contentStatus(member, documentId)).toBe(404);
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    expect(await contentStatus(member, documentId)).toBe(200);
    expect(await contentStatus(stranger, documentId)).toBe(404);
    expect(await filesList(member)).not.toContain(documentId);
    // The generic list reads the row's links for anyone who can open the row (U0 registry, D58).
    expect((await listOn(member, "row", row.id)).body.attachments.map((item: { documentId: string; partId: string }) => [item.documentId, item.partId])).toEqual([[documentId, receipt.id]]);
    expect((await listOn(stranger, "row", row.id)).status).toBe(404);
    // Rows link through their own route, never the generic one (HOST_MANAGED).
    expect((await link(owner, "row", row.id, { documentId })).body.code).toBe("HOST_MANAGED");

    // Unsharing revokes at once.
    await shareCollection(owner, collection.id, "private");
    expect(await contentStatus(member, documentId)).toBe(404);
    await shareCollection(owner, collection.id, "all_users");
    expect(await contentStatus(member, documentId)).toBe(200);

    // The usage list names the row (D409).
    const usage = await request(`/files/${documentId}/usage`, {}, owner);
    expect(((await usage.json()) as { uses: Array<{ hostKind: string; hostId: string }> }).uses).toEqual([expect.objectContaining({ hostKind: "row", hostId: row.id })]);
  });

  test("a Files item needs the confirm; someone else's file, a whiteboard, and a binned file are not found", async () => {
    const { owner, member, collection, row, receipt } = await setup("U3 confirm");
    await shareCollection(owner, collection.id, "selected", [member.userId], "editor");
    const fileItem = await upload(owner, "contract.txt", "terms");
    expect(fileItem.status).toBe(201);
    const refused = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: fileItem.id, fieldId: receipt.id });
    expect([refused.status, refused.body.code, refused.body.documentName]).toEqual([409, "CONFIRM_REQUIRED", "contract.txt"]);
    expect(await contentStatus(member, fileItem.id)).toBe(404);
    const confirmed = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: fileItem.id, fieldId: receipt.id, confirmed: true });
    expect(confirmed.status).toBe(201);
    expect(await contentStatus(member, fileItem.id)).toBe(200);
    expect((db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'collection.row_attach' AND metadata_json LIKE ?").get(`%${fileItem.id}%`) as { metadata_json: string }).metadata_json).toContain("fromFiles");
    // Unlinking a Files item never bins it.
    const detached = await call(owner, "DELETE", `/rows/${row.id}/attachments/${fileItem.id}`);
    expect(detached.body.documentBinned).toBe(false);
    expect(docState(fileItem.id).binned).toBe(0);

    // The member cannot link the owner's upload, even an Attachments-folder one, even confirmed (T341).
    const ownerUpload = await uploadAttachment(owner, "owner.txt", "x", "row");
    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId: ownerUpload, fieldId: receipt.id, confirmed: true })).status).toBe(404);
    // A whiteboard is a Files document but never attachable.
    const board = await request("/whiteboards", { method: "POST", body: JSON.stringify({ name: "Sketch" }) }, owner);
    expect(board.status).toBe(201);
    const boardId = ((await board.json()) as { whiteboard: { id: string } }).whiteboard.id;
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: boardId, fieldId: receipt.id, confirmed: true })).status).toBe(404);
    const binnedUpload = await uploadAttachment(owner, "gone.txt", "x", "row");
    db.query("UPDATE documents SET deleted_at = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), binnedUpload);
    expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: binnedUpload, fieldId: receipt.id })).status).toBe(404);
  });

  test("20 files per row across its file fields", async () => {
    const { owner, row, receipt, photos } = await setup("U3 cap");
    for (let index = 0; index < 20; index += 1) {
      const id = await uploadAttachment(owner, `r${index}.txt`, `receipt ${index}`, "row");
      expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: id, fieldId: index % 2 ? receipt.id : photos.id })).status).toBe(201);
    }
    const extra = await uploadAttachment(owner, "r20.txt", "one too many", "row");
    const full = await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: extra, fieldId: receipt.id });
    expect([full.status, full.body.code, full.body.limit]).toEqual([409, "LIMIT_REACHED", 20]);
    // The refused upload stays unlinked; the hourly sweep bins it after a day (U0).
    expect(docState(extra).binned).toBe(0);
  });

  test("unlink bins the upload and Undo brings it back; the row's Bin hides it and restore returns it; a purge bins it", async () => {
    const { owner, member, collection, row, receipt } = await setup("U3 lifecycle");
    await shareCollection(owner, collection.id, "all_users");
    const documentId = await uploadAttachment(owner, "bill.txt", "Bill", "row");
    await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id });

    const detached = await call(owner, "DELETE", `/rows/${row.id}/attachments/${documentId}`);
    expect(detached.body.documentBinned).toBe(true);
    expect(docState(documentId).binned).toBe(1);
    expect(await contentStatus(member, documentId)).toBe(404);
    const undone = await call(owner, "POST", `/rows/${row.id}/undo`, { revision: detached.body.row.revision });
    expect(undone.status).toBe(200);
    expect(undone.body.row.files[receipt.id].map((file: { id: string }) => file.id)).toEqual([documentId]);
    expect(docState(documentId)).toEqual({ binned: 0, purpose: "file", system_kind: "attachments" });
    expect(await contentStatus(member, documentId)).toBe(200);

    // Row to the Bin: links stay, readers lose access, the owner still has the file; restore returns access.
    expect((await call(owner, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    expect(await contentStatus(member, documentId)).toBe(404);
    expect(await contentStatus(owner, documentId)).toBe(200);
    expect(docState(documentId).binned).toBe(0);
    expect((await request(`/bin/collection_row/${row.id}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(await contentStatus(member, documentId)).toBe(200);

    // Purged with the row: the upload nothing else links goes to its owner's Bin (D395); a Files item does not.
    const fileItem = await upload(owner, "keep.txt", "keep");
    await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: fileItem.id, fieldId: receipt.id, confirmed: true });
    expect((await call(owner, "DELETE", `/rows/${row.id}`)).status).toBe(200);
    expect((await request(`/bin/collection_row/${row.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(docState(documentId).binned).toBe(1);
    expect(docState(fileItem.id).binned).toBe(0);
    expect(await contentStatus(member, fileItem.id)).toBe(404);
  });

  test("a file's owner can take it off a row after losing edit access (U0 review M1)", async () => {
    const { owner, member, collection, row, receipt } = await setup("U3 owner withdraw");
    await shareCollection(owner, collection.id, "selected", [member.userId], "editor");
    const documentId = await uploadAttachment(member, "mine.txt", "mine", "row");
    expect((await call(member, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id })).status).toBe(201);
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    // The row route needs edit access; the generic route lets the file's owner withdraw it.
    expect((await call(member, "DELETE", `/rows/${row.id}/attachments/${documentId}`)).status).toBe(403);
    const withdrawn = await request(`/attachments/row/${row.id}/${documentId}`, { method: "DELETE", body: "{}" }, member);
    expect(withdrawn.status).toBe(200);
    expect((await call(owner, "GET", `/rows/${row.id}`)).body.row.files[receipt.id] ?? []).toEqual([]);
    expect(docState(documentId).binned).toBe(1);
    // Nobody else's file: the collection owner cannot use the generic route for rows.
    const ownerUpload = await uploadAttachment(owner, "theirs.txt", "t", "row");
    await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId: ownerUpload, fieldId: receipt.id });
    expect((await request(`/attachments/row/${row.id}/${ownerUpload}`, { method: "DELETE", body: "{}" }, member)).status).not.toBe(200);
  });

  test("an upload also attached to an event is not binned when the row lets go of it", async () => {
    const { owner, row, receipt } = await setup("U3 shared upload");
    const { eventId } = await calendarWithEvent(owner, "U3 calendar");
    const documentId = await uploadAttachment(owner, "agenda.txt", "Agenda", "row");
    await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id });
    expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);
    expect((await call(owner, "DELETE", `/rows/${row.id}/attachments/${documentId}`)).body.documentBinned).toBe(false);
    expect(docState(documentId).binned).toBe(0);
  });
});

describe("attach_file_to_row and row reads over MCP", () => {
  test("attaches an upload made to attach, marks the row with the key, and reads it back by id", async () => {
    const { owner, member, collection, row, receipt } = await setup("U3 MCP");
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    const writer = makeKey(owner, [all("collections", "write"), all("files", "write")]);
    const created = await tool(writer.id, "create_text_file", { name: "receipt.csv", text: "item,price\nlunch,12.50\n", purpose: "attachment" });
    expect(created.isError).toBe(false);
    const documentId = created.value.document.id as string;
    expect(docState(documentId).system_kind).toBe("attachments");

    const attached = await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId });
    expect(attached.isError).toBe(false);
    expect(attached.value).toMatchObject({ rowId: row.id, field: "Receipt", file: { id: documentId, name: "receipt.csv" }, alreadyAttached: false });
    expect(db.query("SELECT updated_via_key_id FROM collection_rows WHERE id = ?").get(row.id)).toEqual({ updated_via_key_id: writer.id });
    // Again: harmless, over REST too (D403).
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: receipt.id, documentId }, "rest")).value).toMatchObject({ alreadyAttached: true });

    // Reads: get_row gives { id, name }, list_attachments and read_attachment_text take hostKind "row".
    const reader = makeKey(member, [all("collections", "read")]);
    const got = await tool(reader.id, "get_row", { rowId: row.id });
    expect(got.value.row.values.Receipt).toEqual([{ id: documentId, name: "receipt.csv" }]);
    expect(JSON.stringify(got.value)).not.toContain("/api/files");
    expect((await tool(reader.id, "list_attachments", { hostKind: "row", hostId: row.id })).value.attachments).toEqual([expect.objectContaining({ id: documentId, name: "receipt.csv", partId: receipt.id })]);
    expect((await tool(reader.id, "read_attachment_text", { hostKind: "row", hostId: row.id, documentId })).value.text).toBe("item,price\nlunch,12.50\n");
    const queried = await tool(reader.id, "query_rows", { collectionId: collection.id, filters: [{ field: "Receipt", op: "not_empty" }] });
    expect(queried.value.rows.map((item: { id: string }) => item.id)).toEqual([row.id]);
    // The viewer's own Files list is unchanged.
    expect(await filesList(member)).not.toContain(documentId);
  });

  test("scope, grant, role, and the uploads-only rule", async () => {
    const { owner, member, collection, row, receipt } = await setup("U3 MCP rules");
    const other = await newCollection(owner, { name: "U3 other", fields: [{ name: "Item", type: "text" }, { name: "File", type: "file" }] });
    const otherRow = await addRow(owner, other.id, { [other.fields[0]!.id]: "Elsewhere" });
    const upload1 = await uploadAttachment(owner, "a.txt", "a", "row");

    // collections:read alone is not enough; a key over another collection gets NOT_FOUND, never the row.
    expect((await tool(makeKey(owner, [all("collections", "read")]).id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: upload1 })).value.code).toBe("SCOPE_REQUIRED");
    const chosen = makeKey(owner, [on("collections", "write", other.id)]);
    expect((await tool(chosen.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: upload1 })).value.code).toBe("NOT_FOUND");
    expect((await tool(makeKey(owner, [on("collections", "write", collection.id)]).id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: upload1 })).isError).toBe(false);

    const writer = makeKey(owner, [all("collections", "write")]);
    // Not a file field, an unknown field.
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Item", documentId: upload1 })).value.code).toBe("INVALID");
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Nope", documentId: upload1 })).value.code).toBe("INVALID");
    // A Files item is never attached over MCP, confirm or not (no sharing by side effect, T341).
    const fileItem = await upload(owner, "private.txt", "private");
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: fileItem.id })).value.code).toBe("INVALID");
    // Nor an upload already attached outside this collection (another collection's row, an event).
    const shared = await uploadAttachment(owner, "shared.txt", "s", "row");
    await call(owner, "POST", `/rows/${otherRow.id}/attachments`, { documentId: shared, fieldId: other.fields[1]!.id });
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: shared })).value.code).toBe("INVALID");
    const onEvent = await uploadAttachment(owner, "event.txt", "e", "event");
    const { eventId } = await calendarWithEvent(owner, "U3 MCP calendar");
    await link(owner, "event", eventId, { documentId: onEvent });
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: onEvent })).value.code).toBe("INVALID");
    // Someone else's upload is NOT_FOUND, like a missing one.
    const theirs = await uploadAttachment(member, "theirs.txt", "t", "row");
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: theirs })).value.code).toBe("NOT_FOUND");
    expect((await tool(writer.id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: crypto.randomUUID() })).value.code).toBe("NOT_FOUND");

    // A viewer of the collection gets READ_ONLY; a stranger NOT_FOUND.
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    const memberUpload = await uploadAttachment(member, "m.txt", "m", "row");
    expect((await tool(makeKey(member, [all("collections", "write")]).id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: memberUpload })).value.code).toBe("READ_ONLY");
    const stranger = await createUser("U3 MCP stranger");
    expect((await tool(makeKey(stranger, [all("collections", "write")]).id, "attach_file_to_row", { rowId: row.id, field: "Receipt", documentId: memberUpload })).value.code).toBe("NOT_FOUND");
    // create_row and update_row still refuse file values, pointing at the tool.
    const refused = await tool(writer.id, "create_row", { collectionId: collection.id, values: { Item: "x", Receipt: [upload1] } });
    expect(refused.value.fieldErrors).toEqual({ Receipt: "Attach files with attach_file_to_row" });
    expect(receipt.type).toBe("file");
  });
});

describe("CSV export of file fields", () => {
  test("names only: no document ids, no content links, and formula-like names are neutralised", async () => {
    const { owner, collection, row, receipt } = await setup("U3 CSV");
    const plain = await uploadAttachment(owner, "receipt one.pdf", "%PDF-1.4 not really", "row");
    const risky = await uploadAttachment(owner, "=HYPERLINK(evil).txt", "x", "row");
    for (const documentId of [plain, risky]) expect((await call(owner, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id })).status).toBe(201);
    const response = await request(`/collections/${collection.id}/export.csv`, {}, owner);
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("receipt one.pdf; ");
    for (const forbidden of [plain, risky, "/api/files", "/files/", "attachTo"]) expect({ forbidden, found: csv.includes(forbidden) }).toEqual({ forbidden, found: false });
    // The cell does not start with "=" (CSV injection guard).
    const line = csv.split(/\r?\n/).find((item) => item.startsWith("Lunch"))!;
    expect(line).not.toMatch(/,=/);
    expect(attachmentsFolderOf(owner.userId)).not.toBeNull();
  });
});
