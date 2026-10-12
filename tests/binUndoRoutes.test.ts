import { describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api, calendarWithEvent, shareCalendar, upload } from "./support/attachments";
import { addRow, newCollection, shareCollection } from "./support/collections";

/**
 * v0.35.0: Undo after a move to the Bin calls POST /api/bin/:type/:id/restore, with the Bin's own
 * access rules. No new server route was needed: every module's delete has a Bin restore. These check
 * that each delete the client offers Undo for comes back through that path, for the person who
 * deleted it, and never for someone else.
 */

const restore = (session: Session, type: string, id: string) => api(session, "POST", `/bin/${type}/${id}/restore`, {});
const live = (table: string, id: string) => (db.query(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id) as { deleted_at: string | null }).deleted_at === null;

function publishedNote(ownerId: string) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.query("INSERT INTO notes (id, owner_id, folder_id, title, visibility, current_version, created_at, updated_at) VALUES (?, ?, NULL, 'Undo me', 'private', 1, ?, ?)").run(id, ownerId, at, at);
  return id;
}

describe("Undo's restore path, per module", () => {
  test("a note: the owner gets it back; someone else cannot", async () => {
    const owner = await createUser("Undo note");
    const stranger = await createUser("Undo note stranger");
    const note = publishedNote(owner.userId);
    expect((await api(owner, "DELETE", `/notes/${note}`)).status).toBe(200);
    expect(live("notes", note)).toBe(false);
    expect((await restore(stranger, "note", note)).status).toBe(404);
    expect((await restore(owner, "note", note)).status).toBe(200);
    expect(live("notes", note)).toBe(true);
  });

  test("a file or whiteboard (a document)", async () => {
    const owner = await createUser("Undo doc");
    const stranger = await createUser("Undo doc stranger");
    const file = (await upload(owner, "board.excalidraw", "{}")).id;
    expect((await api(owner, "DELETE", `/files/${file}`)).status).toBe(200);
    expect((await restore(stranger, "document", file)).status).toBe(404);
    expect((await restore(owner, "document", file)).status).toBe(200);
    expect(live("documents", file)).toBe(true);
  });

  test("a calendar, and an event binned by an editor who is not the owner", async () => {
    const owner = await createUser("Undo cal owner");
    const editor = await createUser("Undo cal editor");
    const stranger = await createUser("Undo cal stranger");
    const { calendarId, eventId } = await calendarWithEvent(owner);
    await shareCalendar(owner, calendarId, "selected", [editor.userId], "editor");
    expect((await api(editor, "DELETE", `/events/${eventId}`)).status).toBe(200);
    expect((await restore(stranger, "event", eventId)).status).toBe(404);
    expect((await restore(editor, "event", eventId)).status).toBe(200);
    expect(live("events", eventId)).toBe(true);

    expect((await api(owner, "DELETE", `/calendars/${calendarId}`)).status).toBe(200);
    expect((await restore(editor, "calendar", calendarId)).status).toBe(404);
    expect((await restore(owner, "calendar", calendarId)).status).toBe(200);
    expect(live("calendars", calendarId)).toBe(true);
  });

  test("a collection, and a row binned by an editor who is not the owner", async () => {
    const owner = await createUser("Undo coll owner");
    const editor = await createUser("Undo coll editor");
    const stranger = await createUser("Undo coll stranger");
    const collection = await newCollection(owner);
    await shareCollection(owner, collection.id, "selected", [editor.userId], "editor");
    const row = await addRow(owner, collection.id, {});
    expect((await api(editor, "DELETE", `/collections/rows/${row.id}`)).status).toBe(200);
    expect((await restore(stranger, "collection_row", row.id)).status).toBe(404);
    expect((await restore(editor, "collection_row", row.id)).status).toBe(200);
    expect(live("collection_rows", row.id)).toBe(true);

    expect((await api(owner, "DELETE", `/collections/${collection.id}`)).status).toBe(200);
    expect((await restore(editor, "collection", collection.id)).status).toBe(404);
    expect((await restore(owner, "collection", collection.id)).status).toBe(200);
    expect(live("collections", collection.id)).toBe(true);
  });

  test("an item purged before Undo is 404, which the toast reports as no longer in the Bin", async () => {
    const owner = await createUser("Undo purged");
    const note = publishedNote(owner.userId);
    expect((await api(owner, "DELETE", `/notes/${note}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/note/${note}`)).status).toBe(200);
    expect((await restore(owner, "note", note)).status).toBe(404);
  });
});
