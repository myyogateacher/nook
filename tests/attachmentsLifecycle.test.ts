import { describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { api, attachmentsFolderOf, calendarWithEvent, defaultFolderOf, documentRow, link, upload, uploadAttachment, unlink } from "./support/attachments";

const { sweepAttachments, sweepOrphanedAttachments, sweepStaleAttachmentLinks, UNLINKED_GRACE_MS } = await import("../server/attachments/sweep");
const { ensureSystemFolder } = await import("../server/attachments/service");

/**
 * Uploads everywhere U0: the Attachments folder on demand (D391), the lifecycle (D395), the sweepers
 * (T347, T348), and the Bin (§4.4). Only Attachments-folder documents are ever binned by link changes.
 */

const longAgo = () => new Date(Date.now() - UNLINKED_GRACE_MS - 3_600_000).toISOString();
const backdate = (documentId: string) => db.query("UPDATE documents SET created_at = ?, updated_at = ? WHERE id = ?").run(longAgo(), longAgo(), documentId);

describe("the Attachments folder", () => {
  test("is created on first attach upload, once per person, private, at the root, and visible in Files only", async () => {
    const owner = await createUser("Folder owner");
    expect(attachmentsFolderOf(owner.userId)).toBeNull();
    // Not even listing creates it.
    await request("/folders?include=system", {}, owner);
    expect(attachmentsFolderOf(owner.userId)).toBeNull();
    const first = await uploadAttachment(owner);
    const folderId = attachmentsFolderOf(owner.userId)!;
    expect(folderId).not.toBeNull();
    expect(db.query("SELECT name, parent_id, visibility, system_kind, is_default FROM folders WHERE id = ?").get(folderId)).toEqual({ name: "Attachments", parent_id: null, visibility: "private", system_kind: "attachments", is_default: 0 });
    expect(documentRow(first)).toMatchObject({ folder_id: folderId, purpose: "file" });
    await uploadAttachment(owner, "second.txt");
    expect(ensureSystemFolder(owner.userId)).toBe(folderId);
    expect(db.query("SELECT COUNT(*) AS count FROM folders WHERE owner_id = ? AND system_kind IS NOT NULL").get(owner.userId)).toEqual({ count: 1 });
    // Files asks for it; Notes and the other pickers never see it.
    const withSystem = (await api(owner, "GET", "/folders?include=system")).body.folders as Array<{ id: string; system_kind: string | null }>;
    expect(withSystem.find((folder) => folder.id === folderId)?.system_kind).toBe("attachments");
    expect(((await api(owner, "GET", "/folders")).body.folders as Array<{ id: string }>).some((folder) => folder.id === folderId)).toBe(false);
    // An unknown attachTo kind and attachTo with a folder are refused.
    expect((await upload(owner, "x.txt", "x", { attachTo: "robot" })).status).toBe(400);
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.txt");
    expect((await request(`/files?attachTo=event&folderId=${defaultFolderOf(owner.userId)}`, { method: "POST", body: form }, owner)).status).toBe(400);
  });
});

describe("lifecycle (D395)", () => {
  test("the last unlink bins an Attachments-folder file; a Files item, or a file moved out, is never binned by unlinking", async () => {
    const owner = await createUser("Lifecycle owner");
    const { eventId } = await calendarWithEvent(owner);
    const second = await calendarWithEvent(owner, "Second");
    const attachment = await uploadAttachment(owner);
    await link(owner, "event", eventId, { documentId: attachment });
    await link(owner, "event", second.eventId, { documentId: attachment });
    expect((await unlink(owner, "event", eventId, attachment)).body).toEqual({ ok: true, documentBinned: false });
    expect((await unlink(owner, "event", second.eventId, attachment)).body).toEqual({ ok: true, documentBinned: true });
    expect(documentRow(attachment)!.deleted_at).not.toBeNull();
    // Restored with nothing linking it, it becomes an ordinary file in Default (never re-swept).
    expect((await request(`/bin/document/${attachment}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(documentRow(attachment)).toMatchObject({ folder_id: defaultFolderOf(owner.userId), deleted_at: null, purpose: "file" });

    const filesItem = (await upload(owner, "kept.txt", "kept")).id;
    await link(owner, "event", eventId, { documentId: filesItem, confirmed: true });
    expect((await unlink(owner, "event", eventId, filesItem)).body.documentBinned).toBe(false);
    expect(documentRow(filesItem)!.deleted_at).toBeNull();

    const movedOut = await uploadAttachment(owner, "moved.txt");
    await link(owner, "event", eventId, { documentId: movedOut });
    expect((await api(owner, "PATCH", `/files/${movedOut}`, { folderId: defaultFolderOf(owner.userId) })).status).toBe(200);
    expect((await unlink(owner, "event", eventId, movedOut)).body.documentBinned).toBe(false);
    expect(documentRow(movedOut)!.deleted_at).toBeNull();
  });

  test("a binned host keeps its links; a file binned from Files comes back to Attachments while something links it", async () => {
    const owner = await createUser("Bin owner");
    const { eventId } = await calendarWithEvent(owner);
    const attachment = await uploadAttachment(owner);
    await link(owner, "event", eventId, { documentId: attachment });
    expect((await api(owner, "DELETE", `/files/${attachment}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE document_id = ?").get(attachment)).toEqual({ count: 1 });
    expect((await request(`/bin/document/${attachment}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(documentRow(attachment)).toMatchObject({ folder_id: attachmentsFolderOf(owner.userId), deleted_at: null });
  });
});

describe("sweepers", () => {
  test("never-linked uploads older than a day go to the Bin; linked ones, fresh ones, and files elsewhere stay", async () => {
    const owner = await createUser("Sweep owner");
    const { eventId } = await calendarWithEvent(owner);
    const orphan = await uploadAttachment(owner, "orphan.txt");
    const linked = await uploadAttachment(owner, "linked.txt");
    const fresh = await uploadAttachment(owner, "fresh.txt");
    const elsewhere = (await upload(owner, "elsewhere.txt", "e")).id;
    await link(owner, "event", eventId, { documentId: linked });
    for (const id of [orphan, linked, elsewhere]) backdate(id);
    expect(sweepOrphanedAttachments()).toBeGreaterThanOrEqual(1);
    expect(documentRow(orphan)!.deleted_at).not.toBeNull();
    for (const id of [linked, fresh, elsewhere]) expect(documentRow(id)!.deleted_at).toBeNull();
    expect(db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.delete' AND metadata_json LIKE ?").get(`%${orphan}%`)).toMatchObject({ metadata_json: expect.stringContaining("attachment_unlinked") });
  });

  test("purging a host (and its calendar) drops its links, and the sweeper then bins the orphaned upload", async () => {
    const owner = await createUser("Purge owner");
    const { calendarId, eventId } = await calendarWithEvent(owner);
    const attachment = await uploadAttachment(owner);
    await link(owner, "event", eventId, { documentId: attachment });
    backdate(attachment);
    // An FK cascade (calendar purge) fires the events trigger too.
    db.query("DELETE FROM calendars WHERE id = ?").run(calendarId);
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE host_id = ?").get(eventId)).toEqual({ count: 0 });
    sweepAttachments();
    expect(documentRow(attachment)!.deleted_at).not.toBeNull();
  });

  test("stale links whose host row is gone are removed; links of a binned host stay", async () => {
    const owner = await createUser("Stale owner");
    const { eventId } = await calendarWithEvent(owner);
    const attachment = await uploadAttachment(owner);
    await link(owner, "event", eventId, { documentId: attachment });
    const ghost = crypto.randomUUID();
    db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, linked_by, created_at) VALUES ('event', ?, ?, ?, ?)").run(ghost, attachment, owner.userId, new Date().toISOString());
    db.query("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), eventId);
    expect(sweepStaleAttachmentLinks()).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT host_id FROM attachment_links WHERE document_id = ? ORDER BY host_id").all(attachment)).toEqual([{ host_id: eventId }]);
  });
});
