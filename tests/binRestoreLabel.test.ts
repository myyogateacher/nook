import { describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api, attachmentsFolderOf, calendarWithEvent, defaultFolderOf, link, upload, uploadAttachment, unlink } from "./support/attachments";
import { addRow, newCollection } from "./support/collections";
import { attachmentLabel, binFolderLabel } from "../src/bin/binFormat";

/**
 * v0.35.0: the Bin's "Restore to …" names the folder the restore really uses. The server sends it as
 * restore_folder_name, from restoreFolderName, the same rule restoreItem uses (server/bin.ts).
 */

type ListedItem = { type: string; id: string; folder_name: string | null; restore_folder_name?: string };
async function binned(session: Session, id: string) {
  const items = (await api(session, "GET", "/bin")).body.items as ListedItem[];
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`not in the Bin: ${id}`);
  return item;
}

/** The label the Bin shows, then the folder the restore really puts it in: they must match. */
async function labelThenRestore(session: Session, type: "note" | "document", id: string) {
  const item = await binned(session, id);
  const label = binFolderLabel({ ...item, type } as Parameters<typeof binFolderLabel>[0]);
  const restored = await api(session, "POST", `/bin/${type}/${id}/restore`, {});
  expect(restored.status).toBe(200);
  const table = type === "note" ? "notes" : "documents";
  const actual = db.query(`SELECT f.name FROM ${table} t JOIN folders f ON f.id = t.folder_id WHERE t.id = ?`).get(id) as { name: string };
  expect(restored.body.folderName).toBe(actual.name);
  return { label, restoredTo: actual.name, item };
}

const at = () => new Date().toISOString();
/** A published note in `folderId`, already in the Bin. */
function binnedNote(ownerId: string, folderId: string, title: string) {
  const id = crypto.randomUUID();
  db.query(`INSERT INTO notes (id, owner_id, folder_id, title, visibility, current_version, created_at, updated_at, deleted_at, deleted_by, purge_after)
    VALUES (?, ?, ?, ?, 'private', 1, ?, ?, ?, ?, ?)`).run(id, ownerId, folderId, title, at(), at(), at(), ownerId, new Date(Date.now() + 86_400_000).toISOString());
  return id;
}

describe("Bin restore label matches the restore (Task 1)", () => {
  test("an Attachments-folder file still linked restores to Attachments, and says so", async () => {
    const owner = await createUser("Label linked");
    const { eventId } = await calendarWithEvent(owner);
    const attachment = await uploadAttachment(owner);
    await link(owner, "event", eventId, { documentId: attachment });
    expect((await api(owner, "DELETE", `/files/${attachment}`)).status).toBe(200);
    const { label, restoredTo, item } = await labelThenRestore(owner, "document", attachment);
    expect(item.folder_name).toBe("Attachments");
    expect(label).toBe("Attachments");
    expect(restoredTo).toBe("Attachments");
  });

  test("an Attachments-folder file nothing links any more restores to Attachments too, never a shared Default (review L1)", async () => {
    const owner = await createUser("Label unlinked");
    const reader = await createUser("Label unlinked reader");
    // A Default folder shared with someone: restoring there would widen the file's audience.
    expect((await api(owner, "PUT", `/folders/${defaultFolderOf(owner.userId)}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    const { eventId } = await calendarWithEvent(owner);
    const attachment = await uploadAttachment(owner);
    await link(owner, "event", eventId, { documentId: attachment });
    expect((await unlink(owner, "event", eventId, attachment)).body.documentBinned).toBe(true);
    const { label, restoredTo, item } = await labelThenRestore(owner, "document", attachment);
    expect(item.folder_name).toBe("Attachments");
    expect(item.restore_folder_name).toBe("Attachments");
    expect(label).toBe("Attachments");
    expect(restoredTo).toBe("Attachments");
    expect((await api(reader, "GET", `/files/${attachment}`)).status).toBe(404);
  });

  test("a renamed Default folder is named by its real name", async () => {
    const owner = await createUser("Label renamed default");
    db.query("UPDATE folders SET name = 'Inbox' WHERE id = ?").run(defaultFolderOf(owner.userId));
    const folder = (await api(owner, "POST", "/folders", { name: "Short-lived", parentId: null })).body.folder.id as string;
    const file = (await upload(owner, "loose.txt", "x", { folderId: folder })).id;
    expect((await api(owner, "DELETE", `/files/${file}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/folders/${folder}`)).status).toBe(200);
    const { label, restoredTo } = await labelThenRestore(owner, "document", file);
    expect(label).toBe("Inbox");
    expect(restoredTo).toBe("Inbox");
  });

  test("an ordinary file and a note return to their own folder", async () => {
    const owner = await createUser("Label ordinary");
    const folder = (await api(owner, "POST", "/folders", { name: "Projects", parentId: null })).body.folder.id as string;
    const file = (await upload(owner, "plan.txt", "plan", { folderId: folder })).id;
    expect((await api(owner, "DELETE", `/files/${file}`)).status).toBe(200);
    const fileResult = await labelThenRestore(owner, "document", file);
    expect(fileResult.label).toBe("Projects");
    expect(fileResult.restoredTo).toBe("Projects");

    const note = binnedNote(owner.userId, folder, "Plan");
    const noteResult = await labelThenRestore(owner, "note", note);
    expect(noteResult.label).toBe("Projects");
    expect(noteResult.restoredTo).toBe("Projects");
  });

  test("a file or note whose folder is gone restores to Default, and says so", async () => {
    const owner = await createUser("Label gone");
    const folder = (await api(owner, "POST", "/folders", { name: "Doomed", parentId: null })).body.folder.id as string;
    const file = (await upload(owner, "gone.txt", "gone", { folderId: folder })).id;
    const note = binnedNote(owner.userId, folder, "Gone");
    expect((await api(owner, "DELETE", `/files/${file}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/folders/${folder}`)).status).toBe(200);
    for (const [type, id] of [["document", file], ["note", note]] as const) {
      const { label, restoredTo, item } = await labelThenRestore(owner, type, id);
      expect(item.folder_name).toBeNull();
      expect(label).toBe("Default");
      expect(restoredTo).toBe("Default");
    }
  });

  test("a Tasks card attachment converted by 047 restores to Attachments, linked or not", async () => {
    const owner = await createUser("Label card");
    const board = await api(owner, "POST", "/tasks/boards", { name: "Board" });
    const card = (await api(owner, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId: board.body.columns[0].id, title: "Card" })).body.card.id as string;
    const linked = await uploadAttachment(owner, "linked.txt", "x", "card");
    const loose = await uploadAttachment(owner, "loose.txt", "x", "card");
    // As 047 left them: Attachments-folder files with a card_attachments row (and no attachment_links).
    db.query("INSERT INTO card_attachments (card_id, document_id, linked_by, created_at) VALUES (?, ?, ?, ?)").run(card, linked, owner.userId, at());
    expect(attachmentsFolderOf(owner.userId)).not.toBeNull();
    db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id IN (?, ?)").run(at(), owner.userId, new Date(Date.now() + 86_400_000).toISOString(), linked, loose);
    const kept = await labelThenRestore(owner, "document", linked);
    expect(kept.label).toBe("Attachments");
    expect(kept.restoredTo).toBe("Attachments");
    const orphan = await labelThenRestore(owner, "document", loose);
    expect(orphan.label).toBe("Attachments");
    expect(orphan.restoredTo).toBe("Attachments");
  });

  test("a Collections row attachment converted by 047 restores to Attachments, linked or not", async () => {
    const owner = await createUser("Label row");
    const collection = await newCollection(owner, { name: "Receipts", fields: [{ name: "Name", type: "text" }, { name: "Receipt", type: "file" }] });
    const row = await addRow(owner, collection.id, {});
    const fieldId = collection.fields.find((field) => field.name === "Receipt")!.id;
    const linked = await uploadAttachment(owner, "receipt.pdf", "x", "row");
    const loose = await uploadAttachment(owner, "old.pdf", "x", "row");
    db.query("INSERT INTO collection_row_attachments (row_id, document_id, field_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, linked, fieldId, owner.userId, at());
    db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id IN (?, ?)").run(at(), owner.userId, new Date(Date.now() + 86_400_000).toISOString(), linked, loose);
    const kept = await labelThenRestore(owner, "document", linked);
    expect(kept.label).toBe("Attachments");
    expect(kept.restoredTo).toBe("Attachments");
    const orphan = await labelThenRestore(owner, "document", loose);
    expect(orphan.label).toBe("Attachments");
    expect(orphan.restoredTo).toBe("Attachments");
  });

  test("the client label prefers restore_folder_name, and falls back for older servers", () => {
    expect(binFolderLabel({ type: "document", folder_name: "Attachments", restore_folder_name: "Default" })).toBe("Default");
    expect(binFolderLabel({ type: "note", folder_name: "Projects", restore_folder_name: "Projects" })).toBe("Projects");
    expect(binFolderLabel({ type: "document", folder_name: "Attachments" })).toBe("Attachments");
    expect(binFolderLabel({ type: "document", folder_name: null })).toBe("Default");
    expect(attachmentLabel({ attachment_of: null, attachment_kind: null, folder_name: "Attachments", restore_folder_name: "Default" })).toBe("Attachment · restores to Default");
    // Other kinds keep their own destinations.
    expect(binFolderLabel({ type: "collection_row", folder_name: "Receipts", restore_folder_name: "ignored" })).toBe("Receipts");
  });

  test("the Bin's restore button builds its label from binFolderLabel", async () => {
    const source = await Bun.file(new URL("../src/bin/BinSection.tsx", import.meta.url)).text();
    expect(source).toContain("`Restore to ${binFolderLabel(sheetItem)}`");
  });
});
