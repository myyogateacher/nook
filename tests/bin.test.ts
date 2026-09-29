import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const bin = await import("../server/bin");
const { runSweep } = await import("../server/sweeper");

const noteDir = (id: string) => join(dataDir, "notes", id);
const objectPath = (id: string) => join(dataDir, "documents", "objects", id);

type NoteRowState = { deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null; draft_revision: number | null; draft_checksum: string | null };
const noteRow = (id: string) => db.query("SELECT deleted_at, deleted_by, purge_after, purge_started_at, draft_revision, draft_checksum FROM notes WHERE id = ?").get(id) as NoteRowState | null;

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

async function createNote(session: Session, markdown: string, options: { publish?: boolean; folderId?: string | null } = {}) {
  const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: options.folderId ?? null }) }, session);
  expect(created.status).toBe(201);
  const id = (await json<{ note: { id: string } }>(created)).note.id;
  if (markdown !== "") {
    const saved = await request(`/notes/${id}/draft`, { method: "PUT", body: JSON.stringify({ markdown, revision: 1 }) }, session);
    expect(saved.status).toBe(200);
  }
  if (options.publish) expect((await request(`/notes/${id}/publish`, { method: "POST", body: "{}" }, session)).status).toBe(200);
  return id;
}

async function createFolder(session: Session, name: string) {
  const response = await request("/folders", { method: "POST", body: JSON.stringify({ name }) }, session);
  expect(response.status).toBe(201);
  return (await json<{ folder: { id: string } }>(response)).folder.id;
}

async function shareFolderWith(owner: Session, folderId: string, recipient: Session) {
  const response = await request(`/folders/${folderId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [recipient.userId] }) }, owner);
  expect(response.status).toBe(200);
}

async function uploadDocument(session: Session, content: string, filename: string, folderId?: string) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  const response = await request(`/files${folderId ? `?folderId=${folderId}` : ""}`, { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return (await json<{ document: { id: string; folder_id: string } }>(response)).document;
}

const deleteNote = (session: Session, id: string) => request(`/notes/${id}`, { method: "DELETE", body: "{}" }, session);
const discardDraft = (session: Session, id: string) => request(`/notes/${id}/draft`, { method: "DELETE", body: "{}" }, session);
const deleteDocument = (session: Session, id: string) => request(`/files/${id}`, { method: "DELETE", body: "{}" }, session);

function mcpClient(session: Session) {
  const { token } = createMcpApiKey(session.userId, "Bin test client");
  return async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    expect(response.status).toBe(200);
    return response.text();
  };
}

describe("moving notes and documents to the Bin", () => {
  test("a deleted published note is hidden from every read path for the owner and recipients", async () => {
    const owner = await createUser("Bin owner");
    const recipient = await createUser("Bin recipient");
    const folderId = await createFolder(owner, "Shared for bin");
    await shareFolderWith(owner, folderId, recipient);
    const noteId = await createNote(owner, "# Binned secret title\n\nbody", { publish: true, folderId });
    const ownerMcp = mcpClient(owner);
    const recipientMcp = mcpClient(recipient);

    for (const session of [owner, recipient]) {
      expect((await request(`/notes/${noteId}`, {}, session)).status).toBe(200);
    }
    expect(await recipientMcp("list_notes", {})).toContain("Binned secret title");

    const deleted = await deleteNote(owner, noteId);
    expect(deleted.status).toBe(200);
    const body = await json<{ ok: boolean; purgeAfter: string }>(deleted);
    expect(body.ok).toBe(true);
    const row = noteRow(noteId)!;
    expect(row.deleted_by).toBe(owner.userId);
    expect(Date.parse(row.purge_after!) - Date.parse(row.deleted_at!)).toBe(30 * 86_400_000);
    expect(body.purgeAfter).toBe(row.purge_after!);
    expect(existsSync(join(noteDir(noteId), "versions", "000001.md"))).toBe(true);

    for (const session of [owner, recipient]) {
      const list = await json<{ notes: Array<{ id: string }> }>(await request("/notes", {}, session));
      expect(list.notes.some((note) => note.id === noteId)).toBe(false);
      const inFolder = await json<{ notes: Array<{ id: string }> }>(await request(`/notes?folderId=${folderId}`, {}, session));
      expect(inFolder.notes.some((note) => note.id === noteId)).toBe(false);
      expect((await request(`/notes/${noteId}`, {}, session)).status).toBe(404);
      expect((await request(`/notes/${noteId}/versions`, {}, session)).status).toBe(404);
      expect((await request(`/notes/${noteId}/versions/1`, {}, session)).status).toBe(404);
      expect((await request(`/notes/${noteId}/sharing`, {}, session)).status).toBe(404);
    }
    for (const call of [ownerMcp, recipientMcp]) {
      expect(await call("list_notes", {})).not.toContain("Binned secret title");
      const read = await call("read_note", { noteId });
      expect(read).toContain("Note not found or not published");
      expect(read).not.toContain("body");
    }
    // Owner mutations on a binned note behave as if it were missing.
    expect((await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "x", revision: null }) }, owner)).status).toBe(404);
    expect((await request(`/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ folderId: null }) }, owner)).status).toBe(404);
    expect((await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "all_users", userIds: [] }) }, owner)).status).toBe(404);
    expect((await deleteNote(owner, noteId)).status).toBe(404);
  }, 20_000);

  test("sharing changes are refused for a note binned or purged while the request waits for the lock", async () => {
    const owner = await createUser("Sharing race owner");
    const recipient = await createUser("Sharing race recipient");
    const { withNoteLock } = await import("../server/storage");
    for (const purgeToo of [false, true]) {
      const noteId = await createNote(owner, "# Shared race", { publish: true });
      let release!: () => void;
      const held = withNoteLock(noteId, () => new Promise<void>((resolve) => { release = resolve; }));
      const sharing = request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [recipient.userId] }) }, owner);
      await Bun.sleep(50);
      db.query("UPDATE notes SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ?").run(new Date().toISOString(), owner.userId, new Date(Date.now() + 86_400_000).toISOString(), noteId);
      if (purgeToo) db.query("DELETE FROM notes WHERE id = ?").run(noteId);
      release();
      await held;
      expect((await sharing).status).toBe(404);
      expect(db.query("SELECT 1 FROM note_shares WHERE note_id = ?").all(noteId)).toHaveLength(0);
    }
  });

  test("deleting a never-published note with a draft moves it to the Bin with the draft intact", async () => {
    const owner = await createUser("Draft bin owner");
    const noteId = await createNote(owner, "Unpublished thoughts");
    const before = noteRow(noteId)!;
    const deleted = await json<{ ok: boolean; purgeAfter?: string; purged?: boolean }>(await deleteNote(owner, noteId));
    expect(deleted.ok).toBe(true);
    expect(deleted.purged).toBeUndefined();
    expect(deleted.purgeAfter).toBeString();
    const after = noteRow(noteId)!;
    expect(after.deleted_at).not.toBeNull();
    expect(after.draft_revision).toBe(before.draft_revision);
    expect(after.draft_checksum).toBe(before.draft_checksum);
    expect(readFileSync(join(noteDir(noteId), "draft.md"), "utf8")).toBe("Unpublished thoughts");
  });

  test("a blank never-published note is purged immediately and never enters the Bin", async () => {
    const owner = await createUser("Blank owner");
    const noteId = await createNote(owner, "");
    expect(existsSync(noteDir(noteId))).toBe(true);
    const response = await deleteNote(owner, noteId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, purged: true });
    expect(noteRow(noteId)).toBeNull();
    expect(existsSync(noteDir(noteId))).toBe(false);
    const audit = db.query("SELECT actor_id, note_id, metadata_json FROM audit_log WHERE event_type = 'note.purge' AND metadata_json LIKE ?").get(`%${noteId}%`) as { actor_id: string; note_id: string | null; metadata_json: string };
    expect(audit.note_id).toBeNull();
    expect(JSON.parse(audit.metadata_json)).toEqual({ noteId, reason: "blank" });
  });

  test("a whitespace-only draft counts as blank on both delete routes", async () => {
    const owner = await createUser("Whitespace owner");
    const viaDelete = await createNote(owner, "\n");
    expect(await json(await deleteNote(owner, viaDelete))).toEqual({ ok: true, purged: true });
    expect(noteRow(viaDelete)).toBeNull();
    expect(existsSync(noteDir(viaDelete))).toBe(false);

    const viaDiscard = await createNote(owner, "  \n\t ");
    expect(await json(await discardDraft(owner, viaDiscard))).toEqual({ ok: true, purged: true });
    expect(noteRow(viaDiscard)).toBeNull();
    expect(existsSync(noteDir(viaDiscard))).toBe(false);
  });

  test("discarding the draft of a never-published note with content moves it to the Bin and keeps the draft", async () => {
    const owner = await createUser("Discard owner");
    const noteId = await createNote(owner, "Keep me for later");
    const before = noteRow(noteId)!;
    const response = await discardDraft(owner, noteId);
    expect(response.status).toBe(200);
    const body = await json<{ ok: boolean; binned: boolean; purgeAfter: string }>(response);
    expect(body).toMatchObject({ ok: true, binned: true });
    const after = noteRow(noteId)!;
    expect(after.deleted_at).not.toBeNull();
    expect(after.deleted_by).toBe(owner.userId);
    expect(after.draft_revision).toBe(before.draft_revision);
    expect(after.draft_checksum).toBe(before.draft_checksum);
    expect(readFileSync(join(noteDir(noteId), "draft.md"), "utf8")).toBe("Keep me for later");
    expect((await request(`/notes/${noteId}`, {}, owner)).status).toBe(404);

    const blank = await createNote(owner, "");
    expect(await json(await discardDraft(owner, blank))).toEqual({ ok: true, purged: true });
    expect(noteRow(blank)).toBeNull();
  });

  test("discarding the draft of a published note still only drops the draft", async () => {
    const owner = await createUser("Published discard owner");
    const noteId = await createNote(owner, "Published body", { publish: true });
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "Edited", revision: null }) }, owner);
    expect(await json(await discardDraft(owner, noteId))).toEqual({ ok: true });
    expect(noteRow(noteId)).toMatchObject({ deleted_at: null, draft_revision: null });
  });

  test("deleting a document moves it to the Bin; a second delete reports alreadyDeleted", async () => {
    const owner = await createUser("Document bin owner");
    const recipient = await createUser("Document bin recipient");
    const folderId = await createFolder(owner, "Docs for bin");
    await shareFolderWith(owner, folderId, recipient);
    const document = await uploadDocument(owner, "document body", "report.txt", folderId);
    expect((await request(`/files/${document.id}/content`, {}, recipient)).status).toBe(200);

    const first = await deleteDocument(owner, document.id);
    expect(first.status).toBe(200);
    const firstBody = await json<{ ok: boolean; purgeAfter: string; alreadyDeleted?: boolean }>(first);
    expect(firstBody.alreadyDeleted).toBeUndefined();
    const second = await json<{ ok: boolean; purgeAfter: string; alreadyDeleted: boolean }>(await deleteDocument(owner, document.id));
    expect(second).toEqual({ ok: true, alreadyDeleted: true, purgeAfter: firstBody.purgeAfter });
    expect(existsSync(objectPath(document.id))).toBe(true);

    for (const session of [owner, recipient]) {
      expect((await request(`/files/${document.id}`, {}, session)).status).toBe(404);
      expect((await request(`/files/${document.id}/content`, {}, session)).status).toBe(404);
      const list = await json<{ documents: Array<{ id: string }> }>(await request("/files", {}, session));
      expect(list.documents.some((item) => item.id === document.id)).toBe(false);
    }
    expect((await request(`/files/${document.id}/sharing`, {}, owner)).status).toBe(404);
  });
});

/** Inserts a binned, never-published note row with a directory on disk, bypassing the API. */
function insertBinnedNote(ownerId: string, purgeAfter: string, options: { purgeStartedAt?: string | null } = {}) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  db.query(`INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at, deleted_at, deleted_by, purge_after, purge_started_at)
    VALUES (?, ?, NULL, 'Fixture', 0, ?, ?, ?, ?, ?, ?)`)
    .run(id, ownerId, timestamp, timestamp, timestamp, ownerId, purgeAfter, options.purgeStartedAt ?? null);
  mkdirSync(noteDir(id), { recursive: true, mode: 0o700 });
  writeFileSync(join(noteDir(id), "draft.md"), "fixture", { mode: 0o600 });
  return id;
}

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const dueCount = () => (db.query("SELECT COUNT(*) AS count FROM notes WHERE deleted_at IS NOT NULL AND (purge_after <= ? OR purge_started_at IS NOT NULL)").get(new Date().toISOString()) as { count: number }).count;

describe("restore, purge, and the retention sweeper", () => {
  test("restore returns an item to its original folder, or to Default when the folder is gone", async () => {
    const owner = await createUser("Restore module owner");
    const folderId = await createFolder(owner, "Original");
    const kept = await createNote(owner, "Kept folder", { publish: true, folderId });
    const orphaned = await createNote(owner, "Folder deleted", { publish: true, folderId });
    await deleteNote(owner, kept);
    await deleteNote(owner, orphaned);
    expect(await bin.restoreItem("note", kept, owner.userId)).toEqual({ status: "restored", folderId, folderName: "Original", visibility: "private" });
    await deleteNote(owner, kept);
    expect((await request(`/folders/${folderId}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    const defaultFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    expect(await bin.restoreItem("note", orphaned, owner.userId)).toEqual({ status: "restored", folderId: defaultFolder, folderName: "Default", visibility: "private" });
    expect(await bin.restoreItem("note", orphaned, owner.userId)).toEqual({ status: "already_restored", folderId: defaultFolder, folderName: "Default" });
    expect(noteRow(orphaned)).toMatchObject({ deleted_at: null, deleted_by: null, purge_after: null });
  });

  test("the sweeper purges items whose retention ended and keeps the rest, one batch per run", async () => {
    const owner = await createUser("Retention owner");
    await runSweep();
    expect(dueCount()).toBe(0);
    const due = Array.from({ length: bin.SWEEP_BATCH_SIZE + 5 }, () => insertBinnedNote(owner.userId, past()));
    const keep = insertBinnedNote(owner.userId, future());
    const liveDocument = await uploadDocument(owner, "retention doc", "keep.txt");
    const dueDocument = await uploadDocument(owner, "expired doc", "expired.txt");
    await deleteDocument(owner, dueDocument.id);
    db.query("UPDATE documents SET purge_after = ? WHERE id = ?").run(past(), dueDocument.id);

    const first = await runSweep();
    expect(first!.bin.purged).toBe(bin.SWEEP_BATCH_SIZE + 1);
    expect(dueCount()).toBe(5);
    const second = await runSweep();
    expect(second!.bin.purged).toBe(5);
    expect(dueCount()).toBe(0);

    for (const id of due) {
      expect(noteRow(id)).toBeNull();
      expect(existsSync(noteDir(id))).toBe(false);
    }
    expect(noteRow(keep)).not.toBeNull();
    expect(existsSync(noteDir(keep))).toBe(true);
    expect(db.query("SELECT id FROM documents WHERE id = ?").get(dueDocument.id)).toBeNull();
    expect(existsSync(objectPath(dueDocument.id))).toBe(false);
    expect(existsSync(objectPath(liveDocument.id))).toBe(true);
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.purge' AND metadata_json LIKE ?").all(`%${dueDocument.id}%`) as Array<{ metadata_json: string }>;
    expect(audits.map((row) => JSON.parse(row.metadata_json))).toEqual([{ documentId: dueDocument.id, reason: "retention" }]);
  }, 20_000);

  test("an item restored and deleted again after the sweep's snapshot keeps its new retention", async () => {
    const owner = await createUser("Re-deleted owner");
    const id = insertBinnedNote(owner.userId, past());
    // sweepBin takes its snapshot synchronously and only then waits for each row's lock,
    // so the restore and second delete below land between the snapshot and the purge.
    const sweep = bin.sweepBin();
    const redeletedAt = new Date();
    const newPurgeAfter = new Date(redeletedAt.getTime() + 30 * 86_400_000).toISOString();
    db.query("UPDATE notes SET deleted_at = ?, purge_after = ? WHERE id = ?").run(redeletedAt.toISOString(), newPurgeAfter, id);
    await sweep;
    expect(noteRow(id)).toMatchObject({ purge_after: newPurgeAfter, purge_started_at: null });
    expect(existsSync(noteDir(id))).toBe(true);
  });

  test("legacy never-published notes backfilled by migration 007 are purged by the first sweep", async () => {
    const owner = await createUser("Legacy owner");
    const legacyAt = "2025-01-01T00:00:00.000Z";
    const insert = db.query(`INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at, deleted_at)
      VALUES (?, ?, NULL, 'Legacy', ?, ?, ?, ?)`);
    const unpublished = crypto.randomUUID();
    const published = crypto.randomUUID();
    insert.run(unpublished, owner.userId, 0, legacyAt, legacyAt, legacyAt);
    insert.run(published, owner.userId, 1, legacyAt, legacyAt, legacyAt);
    for (const id of [unpublished, published]) mkdirSync(noteDir(id), { recursive: true, mode: 0o700 });
    const { binMigration } = await import("../server/migrations/007_bin");
    // Re-running 007 is a no-op for rows it already backfilled and fills in the two legacy rows.
    binMigration.up(db);
    expect(noteRow(unpublished)).toMatchObject({ deleted_by: owner.userId });
    await runSweep();
    expect(noteRow(unpublished)).toBeNull();
    expect(existsSync(noteDir(unpublished))).toBe(false);
    expect(noteRow(published)).toMatchObject({ deleted_at: legacyAt, deleted_by: owner.userId, purge_started_at: null });
    expect(Date.parse(noteRow(published)!.purge_after!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect((await listBin(owner)).items.map((item) => item.id)).toEqual([published]);
  });

  test("the sweeper finishes interrupted purges", async () => {
    const owner = await createUser("Interrupted owner");
    const id = insertBinnedNote(owner.userId, future(), { purgeStartedAt: past() });
    expect(await bin.restoreItem("note", id, owner.userId)).toEqual({ status: "purging" });
    await runSweep();
    expect(noteRow(id)).toBeNull();
    expect(existsSync(noteDir(id))).toBe(false);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'note.purge' AND metadata_json LIKE ?").get(`%${id}%`) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ noteId: id, reason: "resumed" });
  });

  test("tombstones that keep failing do not starve expired items", async () => {
    const owner = await createUser("Starvation owner");
    await runSweep();
    const failing = new Set(Array.from({ length: bin.SWEEP_RESUME_BATCH_SIZE + 10 }, () => insertBinnedNote(owner.userId, past(), { purgeStartedAt: past() })));
    const due = insertBinnedNote(owner.userId, past());
    const original = bin.binStorage.removeBytes;
    bin.binStorage.removeBytes = async (type, id) => {
      if (failing.has(id)) throw Object.assign(new Error("injected"), { code: "EACCES" });
      return original(type, id);
    };
    try {
      const counts = await runSweep();
      expect(counts!.bin.pending).toBe(bin.SWEEP_RESUME_BATCH_SIZE);
      expect(counts!.bin.purged).toBe(1);
    } finally {
      bin.binStorage.removeBytes = original;
    }
    expect(noteRow(due)).toBeNull();
    await runSweep();
    await runSweep();
    for (const id of failing) expect(noteRow(id)).toBeNull();
  });

  test("a byte-removal failure leaves the tombstone for the next sweep", async () => {
    const owner = await createUser("Failing purge owner");
    const id = insertBinnedNote(owner.userId, past());
    const original = bin.binStorage.removeBytes;
    bin.binStorage.removeBytes = async () => { throw Object.assign(new Error("injected"), { code: "EACCES" }); };
    try {
      const counts = await runSweep();
      expect(counts!.bin.pending).toBeGreaterThanOrEqual(1);
    } finally {
      bin.binStorage.removeBytes = original;
    }
    expect(noteRow(id)!.purge_started_at).not.toBeNull();
    expect(existsSync(noteDir(id))).toBe(true);
    await runSweep();
    expect(noteRow(id)).toBeNull();
    expect(existsSync(noteDir(id))).toBe(false);
  });
});

type BinItem = { type: "note" | "document"; id: string; title: string; folder_id: string | null; folder_name: string | null; size_bytes: number | null; deleted_at: string; purge_after: string; purging: boolean };
const listBin = async (session: Session, query = "") => json<{ items: BinItem[] }>(await request(`/bin${query}`, {}, session));
const restore = (session: Session, type: string, id: string) => request(`/bin/${type}/${id}/restore`, { method: "POST", body: "{}" }, session);
const purge = (session: Session, type: string, id: string) => request(`/bin/${type}/${id}`, { method: "DELETE", body: "{}" }, session);
const emptyBin = (session: Session) => request("/bin", { method: "DELETE", body: "{}" }, session);

describe("Bin API", () => {
  test("lists only the caller's binned notes and documents, newest deletion first, with a type filter", async () => {
    const owner = await createUser("Bin list owner");
    const other = await createUser("Bin list other");
    const folderId = await createFolder(owner, "Listed folder");
    const noteId = await createNote(owner, "# Listed note", { publish: true, folderId });
    const document = await uploadDocument(owner, "twelve bytes", "listed.txt");
    const live = await createNote(owner, "Still live", { publish: true });
    const othersNote = await createNote(other, "Not yours", { publish: true });
    await deleteNote(owner, noteId);
    await Bun.sleep(5);
    await deleteDocument(owner, document.id);
    await deleteNote(other, othersNote);

    const { items } = await listBin(owner);
    expect(items.map((item) => item.id)).toEqual([document.id, noteId]);
    const [documentItem, noteItem] = items;
    expect(noteItem).toEqual({
      type: "note", id: noteId, title: "Listed note", folder_id: folderId, folder_name: "Listed folder", size_bytes: null,
      deleted_at: noteRow(noteId)!.deleted_at!, purge_after: noteRow(noteId)!.purge_after!, purging: false,
      board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null, can_purge: true
    });
    expect(documentItem).toMatchObject({ type: "document", title: "listed.txt", folder_name: "Default", size_bytes: 12, purging: false });
    expect(Object.keys(documentItem!).sort()).toEqual(["attachment", "attachment_kind", "attachment_of", "board_id", "board_name", "can_purge", "deleted_at", "folder_id", "folder_name", "id", "kind", "purge_after", "purging", "size_bytes", "title", "type"]);
    expect(documentItem!.kind).toBe("file");
    expect(items.some((item) => item.id === live || item.id === othersNote)).toBe(false);
    expect((await listBin(owner, "?type=note")).items.map((item) => item.id)).toEqual([noteId]);
    expect((await listBin(owner, "?type=document")).items.map((item) => item.id)).toEqual([document.id]);
    expect((await request("/bin?type=folder", {}, owner)).status).toBe(400);

    // The original folder is gone: the item reports no folder and will restore to Default.
    expect((await request(`/folders/${folderId}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await listBin(owner, "?type=note")).items[0]).toMatchObject({ folder_id: null, folder_name: null });
    expect((await request("/bin", {}, undefined)).status).toBe(401);
  });

  test("restore returns items to their folder or Default, reports visibility, and reactivates shares", async () => {
    const owner = await createUser("Restore owner");
    const recipient = await createUser("Restore recipient");
    const stranger = await createUser("Restore stranger");
    const folderId = await createFolder(owner, "Restore target");
    const shared = await createNote(owner, "# Shared note", { publish: true, folderId });
    const shareResponse = await request(`/notes/${shared}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [recipient.userId] }) }, owner);
    expect(shareResponse.status).toBe(200);
    expect((await request(`/notes/${shared}`, {}, recipient)).status).toBe(200);
    await deleteNote(owner, shared);
    expect((await request(`/notes/${shared}`, {}, recipient)).status).toBe(404);

    expect((await restore(stranger, "note", shared)).status).toBe(404);
    expect((await restore(recipient, "note", shared)).status).toBe(404);
    const restored = await restore(owner, "note", shared);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ ok: true, folderId, folderName: "Restore target", visibility: "selected" });
    expect((await request(`/notes/${shared}`, {}, recipient)).status).toBe(200);
    const again = await restore(owner, "note", shared);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, alreadyRestored: true, folderId, folderName: "Restore target" });
    expect(db.query("SELECT event_type FROM audit_log WHERE note_id = ? AND event_type = 'note.restore'").all(shared)).toHaveLength(1);

    // Default fallback: the original folder is deleted and Default is shared with everyone.
    const defaultFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    expect((await request(`/folders/${defaultFolder}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "all_users", userIds: [] }) }, owner)).status).toBe(200);
    const document = await uploadDocument(owner, "inheriting file", "inherit.txt", folderId);
    const draftNote = await createNote(owner, "Draft only, never published", { folderId });
    await deleteDocument(owner, document.id);
    await discardDraft(owner, draftNote);
    expect((await request(`/folders/${folderId}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    const documentRestore = await restore(owner, "document", document.id);
    expect(await documentRestore.json()).toEqual({ ok: true, folderId: defaultFolder, folderName: "Default", visibility: "all_users" });
    expect((await request(`/files/${document.id}/content`, {}, stranger)).status).toBe(200);
    expect(db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.restore' AND metadata_json LIKE ?").all(`%${document.id}%`)).toHaveLength(1);

    const noteRestore = await restore(owner, "note", draftNote);
    expect(await noteRestore.json()).toMatchObject({ ok: true, folderId: defaultFolder, folderName: "Default" });
    const reopened = await json<{ note: { markdown: string; folder_id: string; current_version: number } }>(await request(`/notes/${draftNote}`, {}, owner));
    expect(reopened.note).toMatchObject({ markdown: "Draft only, never published", folder_id: defaultFolder, current_version: 0 });

    expect((await restore(owner, "folder", document.id)).status).toBe(400);
    expect((await restore(owner, "note", "not-a-uuid")).status).toBe(400);
    expect((await restore(owner, "note", crypto.randomUUID())).status).toBe(404);
  });

  test("delete forever removes bytes, rows, and cascades, audits the purge, and is idempotent", async () => {
    const owner = await createUser("Purge owner");
    const recipient = await createUser("Purge recipient");
    const noteId = await createNote(owner, "# Forever", { publish: true });
    await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [recipient.userId] }) }, owner);
    const document = await uploadDocument(owner, "forever file", "forever.txt");
    await request(`/files/${document.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [recipient.userId] }) }, owner);

    expect((await purge(owner, "note", noteId)).status).toBe(409);
    const live = await purge(owner, "document", document.id);
    expect(live.status).toBe(409);
    expect(((await live.json()) as { code: string }).code).toBe("NOT_IN_BIN");

    await deleteNote(owner, noteId);
    await deleteDocument(owner, document.id);
    expect((await purge(recipient, "note", noteId)).status).toBe(404);
    expect(noteRow(noteId)).not.toBeNull();

    for (const [type, id] of [["note", noteId], ["document", document.id]] as const) {
      const response = await purge(owner, type, id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await purge(owner, type, id)).status).toBe(404);
      expect((await restore(owner, type, id)).status).toBe(404);
    }
    expect(noteRow(noteId)).toBeNull();
    expect(existsSync(noteDir(noteId))).toBe(false);
    expect(db.query("SELECT 1 FROM note_versions WHERE note_id = ?").all(noteId)).toHaveLength(0);
    expect(db.query("SELECT 1 FROM note_shares WHERE note_id = ?").all(noteId)).toHaveLength(0);
    expect(db.query("SELECT 1 FROM documents WHERE id = ?").get(document.id)).toBeNull();
    expect(db.query("SELECT 1 FROM document_shares WHERE document_id = ?").all(document.id)).toHaveLength(0);
    expect(existsSync(objectPath(document.id))).toBe(false);
    const audits = db.query("SELECT event_type, actor_id, note_id, metadata_json FROM audit_log WHERE event_type IN ('note.purge', 'document.purge') AND (metadata_json LIKE ? OR metadata_json LIKE ?) ORDER BY event_type")
      .all(`%${noteId}%`, `%${document.id}%`) as Array<{ event_type: string; actor_id: string; note_id: string | null; metadata_json: string }>;
    expect(audits.map((row) => [row.event_type, row.actor_id, row.note_id, JSON.parse(row.metadata_json)])).toEqual([
      ["document.purge", owner.userId, null, { documentId: document.id, reason: "user" }],
      ["note.purge", owner.userId, null, { noteId, reason: "user" }]
    ]);
    // Earlier audit rows for the note survive with their note_id nulled by the FK.
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE note_id = ?").get(noteId) as { count: number }).count).toBe(0);
    expect(JSON.stringify(audits)).not.toContain("forever.txt");
  });

  test("a tombstoned item is unreadable, cannot be restored, and is finished by the sweeper", async () => {
    const owner = await createUser("Tombstone owner");
    const noteId = await createNote(owner, "# Tombstoned", { publish: true });
    const document = await uploadDocument(owner, "tombstoned bytes", "tomb.txt");
    await deleteNote(owner, noteId);
    await deleteDocument(owner, document.id);
    const startedAt = new Date().toISOString();
    db.query("UPDATE notes SET purge_started_at = ? WHERE id = ?").run(startedAt, noteId);
    db.query("UPDATE documents SET purge_started_at = ? WHERE id = ?").run(startedAt, document.id);
    expect(existsSync(join(noteDir(noteId), "versions", "000001.md"))).toBe(true);

    expect((await request(`/notes/${noteId}`, {}, owner)).status).toBe(404);
    expect((await request(`/files/${document.id}/content`, {}, owner)).status).toBe(404);
    expect((await deleteDocument(owner, document.id)).status).toBe(404);
    expect((await listBin(owner)).items.every((item) => item.purging)).toBe(true);
    for (const [type, id] of [["note", noteId], ["document", document.id]] as const) {
      const response = await restore(owner, type, id);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("PURGING");
    }
    await runSweep();
    expect(noteRow(noteId)).toBeNull();
    expect(existsSync(noteDir(noteId))).toBe(false);
    expect(db.query("SELECT 1 FROM documents WHERE id = ?").get(document.id)).toBeNull();
    expect(existsSync(objectPath(document.id))).toBe(false);
  });

  test("a failed byte removal answers 202 pending and the next sweep finishes", async () => {
    const owner = await createUser("Pending owner");
    const noteId = await createNote(owner, "# Pending", { publish: true });
    await deleteNote(owner, noteId);
    const original = bin.binStorage.removeBytes;
    bin.binStorage.removeBytes = async () => { throw Object.assign(new Error("injected"), { code: "EBUSY" }); };
    try {
      const response = await purge(owner, "note", noteId);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, pending: true });
    } finally {
      bin.binStorage.removeBytes = original;
    }
    expect(noteRow(noteId)!.purge_started_at).not.toBeNull();
    expect(existsSync(noteDir(noteId))).toBe(true);
    expect((await restore(owner, "note", noteId)).status).toBe(409);
    await runSweep();
    expect(noteRow(noteId)).toBeNull();
    expect(existsSync(noteDir(noteId))).toBe(false);
    expect((await purge(owner, "note", noteId)).status).toBe(404);
  });

  test("Empty Bin purges only the caller's items and reports counts", async () => {
    const owner = await createUser("Empty owner");
    const other = await createUser("Empty other");
    const ownerNotes = [await createNote(owner, "# One", { publish: true }), await createNote(owner, "Two draft")];
    const ownerDocument = await uploadDocument(owner, "empty me", "empty.txt");
    const keepLive = await createNote(owner, "# Live", { publish: true });
    const othersNote = await createNote(other, "# Theirs", { publish: true });
    for (const id of ownerNotes) await deleteNote(owner, id);
    await deleteDocument(owner, ownerDocument.id);
    await deleteNote(other, othersNote);

    const response = await emptyBin(owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, purged: 3, pending: 0 });
    expect((await listBin(owner)).items).toHaveLength(0);
    for (const id of ownerNotes) expect(existsSync(noteDir(id))).toBe(false);
    expect(existsSync(objectPath(ownerDocument.id))).toBe(false);
    expect(noteRow(keepLive)!.deleted_at).toBeNull();
    expect((await listBin(other)).items.map((item) => item.id)).toEqual([othersNote]);
    expect(existsSync(noteDir(othersNote))).toBe(true);
    expect(await json(await emptyBin(owner))).toEqual({ ok: true, purged: 0, pending: 0 });
  });

  test("parallel restore and delete forever: exactly one wins with no half state", async () => {
    const owner = await createUser("Race owner");
    for (let round = 0; round < 6; round += 1) {
      const noteId = await createNote(owner, `# Race ${round}`, { publish: true });
      await deleteNote(owner, noteId);
      const [restored, purged] = round % 2 === 0
        ? await Promise.all([restore(owner, "note", noteId), purge(owner, "note", noteId)])
        : (await Promise.all([purge(owner, "note", noteId), restore(owner, "note", noteId)])).reverse() as [Response, Response];
      const pair = [restored.status, purged.status];
      const row = noteRow(noteId);
      if (row) {
        expect(pair).toEqual([200, 409]);
        expect(row).toMatchObject({ deleted_at: null, purge_started_at: null });
        expect(existsSync(join(noteDir(noteId), "versions", "000001.md"))).toBe(true);
      } else {
        expect(pair).toEqual([404, 200]);
        expect(existsSync(noteDir(noteId))).toBe(false);
      }
    }
  });

  test("purging a binned document frees its quota", async () => {
    const owner = await createUser("Quota owner");
    const chunk = "q".repeat(4_000_000);
    const documents = [];
    for (let index = 0; index < 3; index += 1) documents.push(await uploadDocument(owner, chunk, `quota-${index}.bin`));
    const upload = () => {
      const form = new FormData();
      form.append("file", new Blob([chunk]), "extra.bin");
      return request("/files", { method: "POST", body: form }, owner);
    };
    expect((await upload()).status).toBe(507);
    await deleteDocument(owner, documents[0]!.id);
    expect((await upload()).status).toBe(507);
    expect((await purge(owner, "document", documents[0]!.id)).status).toBe(200);
    expect((await upload()).status).toBe(201);
  }, 20_000);
});
