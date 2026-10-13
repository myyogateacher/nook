import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createUser, db, type Session } from "./support/harness";
import { addCalendarMember, api, calendarWithEvent, defaultFolderOf, link, listOn, shareCalendar, unlink, upload, uploadAttachment } from "./support/attachments";

const { config } = await import("../server/config");
const { recordRemovedLink, removedLink, resetUndoTickets, sweepUndoRecords, undoTicketCounts, UNDO_TICKET_TTL_MS } = await import("../server/attachments/undoTickets");
const { attachmentUndoRecordsMigration, UNDO_RECORD_TRIGGERS } = await import("../server/migrations/049_attachment_undo_records");
const { runMigrations } = await import("../server/migrations");
const { missingAttachmentTriggers } = await import("../server/attachments/sweep");

/**
 * v0.37.0 (migration 049): attachment Undo records live in SQLite. A "restart" is a separate bun
 * process on the same data directory (tests/support/undoRestartProbe.ts) that opens the database
 * afresh with no in-process state; the records still put links back in their place, for a non-owner
 * too, and a Files item needs no new confirm. They still expire after 60 s and still end on any link
 * change, host purge, document purge, or user delete, including changes made through another
 * connection (the 049 triggers).
 */

const tasks = (session: Session, method: string, path: string, body?: unknown) => api(session, method, `/tasks${path}`, body);

function restarted(command: Record<string, unknown>) {
  const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "undoRestartProbe.ts"), JSON.stringify(command)], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
  if (probe.exitCode !== 0 || !output) throw new Error(`probe failed: ${probe.stderr.toString().slice(-2000)}`);
  return JSON.parse(output) as Record<string, unknown> | null;
}

/** Another connection to the same file: what a second process (or the restarted server) sees and writes. */
function reopened<T>(use: (other: Database) => T): T {
  const other = new Database(config.databasePath, { strict: true });
  try {
    other.exec("PRAGMA foreign_keys = ON");
    other.exec("PRAGMA busy_timeout = 5000");
    return use(other);
  } finally {
    other.close();
  }
}

const recordCount = (other: Database, hostId: string) => (other.query("SELECT COUNT(*) AS count FROM attachment_undo_records WHERE host_id = ?").get(hostId.toLowerCase()) as { count: number }).count;
const order = async (session: Session, kind: string, hostId: string) => ((await listOn(session, kind, hostId)).body.attachments as Array<{ documentId?: string; id?: string; document_id?: string }>)
  .map((item) => item.documentId ?? item.document_id ?? item.id);

async function managedEvent(label: string) {
  const owner = await createUser(`${label} owner`);
  const manager = await createUser(`${label} manager`);
  const { calendarId, eventId } = await calendarWithEvent(owner);
  await shareCalendar(owner, calendarId, "selected", [manager.userId], "viewer");
  addCalendarMember(calendarId, manager.userId, "edit");
  db.query("UPDATE calendar_members SET level = 'manage' WHERE calendar_id = ? AND user_id = ?").run(calendarId, manager.userId);
  return { owner, manager, calendarId, eventId };
}

describe("Undo records survive a restart", () => {
  test("049 is applied with its triggers", () => {
    expect(UNDO_RECORD_TRIGGERS.length).toBe(14);
    expect(missingAttachmentTriggers()).toEqual([]);
    expect(db.query("SELECT 1 FROM schema_migrations WHERE id = 49").get()).not.toBeNull();
    // A second run changes nothing (a fresh database with every migration, then 049 again).
    const fresh = new Database(":memory:", { strict: true });
    runMigrations(fresh);
    const schema = () => fresh.query("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%undo%' ORDER BY name").all();
    const before = schema();
    expect(before.length).toBe(14 + 5);
    attachmentUndoRecordsMigration.up(fresh);
    expect(schema()).toEqual(before);
    fresh.close();
  });

  test("a manager's Undo of someone else's file, after a restart: back in the middle, linker kept", async () => {
    const { owner, manager, eventId } = await managedEvent("Durable event");
    // Files items (outside Attachments, so never binned by an unlink): only the record lets a non-owner put one back.
    const files: string[] = [];
    for (const name of ["a.txt", "b.txt", "c.txt"]) files.push((await upload(owner, name, name, { folderId: defaultFolderOf(owner.userId) })).id as string);
    for (const documentId of files) expect((await link(owner, "event", eventId, { documentId, confirmed: true })).status).toBe(201);
    const before = db.query("SELECT part_id, position, linked_by, created_at FROM attachment_links WHERE host_kind = 'event' AND host_id = ? AND document_id = ?").get(eventId, files[1]!);
    expect((await unlink(manager, "event", eventId, files[1]!)).status).toBe(200);
    // The record is in the database, seen from a fresh connection.
    expect(reopened((other) => recordCount(other, eventId))).toBe(1);

    const outcome = restarted({ op: "relink", userId: manager.userId, input: { hostKind: "event", hostId: eventId, documentId: files[1] } });
    expect(outcome).toEqual({ relinked: true, restored: false });
    expect(db.query("SELECT part_id, position, linked_by, created_at FROM attachment_links WHERE host_kind = 'event' AND host_id = ? AND document_id = ?").get(eventId, files[1]!)).toEqual(before);
    expect(await order(owner, "event", eventId)).toEqual(files);
    // Used: the record is gone, in every process.
    expect(removedLink(manager.userId, "event", eventId, files[1]!)).toBeNull();
    expect(reopened((other) => recordCount(other, eventId))).toBe(0);
  });

  test("the owner's Files item comes back after a restart without a new confirm", async () => {
    const { owner, eventId } = await managedEvent("Durable files item");
    const spec = (await upload(owner, "spec.txt", "The spec", { folderId: defaultFolderOf(owner.userId) })).id as string;
    expect((await link(owner, "event", eventId, { documentId: spec, confirmed: true })).status).toBe(201);
    expect((await unlink(owner, "event", eventId, spec)).status).toBe(200);
    expect(restarted({ op: "relink", userId: owner.userId, input: { hostKind: "event", hostId: eventId, documentId: spec } })).toEqual({ relinked: true, restored: false });
  });

  test("a card file removed to the Bin comes back out of it, in its old place, after a restart", async () => {
    const owner = await createUser("Durable card owner");
    const created = await tasks(owner, "POST", "/boards", { name: "Durable board" });
    const boardId = created.body.board.id as string;
    const cardId = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: created.body.columns[0].id, title: "Durable card" })).body.card.id as string;
    const files: string[] = [];
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      const id = (await upload(owner, name, name, { attachTo: "card" })).id as string;
      expect((await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: id })).status).toBe(201);
      files.push(id);
    }
    const removed = await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${files[1]}`);
    expect(removed.status).toBe(200);
    expect((db.query("SELECT deleted_at FROM documents WHERE id = ?").get(files[1]!) as { deleted_at: string | null }).deleted_at).not.toBeNull();
    expect(restarted({ op: "relink", userId: owner.userId, input: { hostKind: "card", hostId: cardId, documentId: files[1] } })).toEqual({ relinked: true, restored: true });
    const onCard = (db.query("SELECT document_id FROM card_attachments WHERE card_id = ? ORDER BY created_at, rowid").all(cardId) as Array<{ document_id: string }>).map((row) => row.document_id);
    expect(onCard).toEqual(files);
  });

  test("the event sheet's Save: every removal commits its own record; Undo puts them all back in their places", async () => {
    const { owner, manager, eventId } = await managedEvent("Durable sheet");
    const files: string[] = [];
    for (const name of ["s1.txt", "s2.txt", "s3.txt", "s4.txt"]) files.push((await upload(owner, name, name, { folderId: defaultFolderOf(owner.userId) })).id as string);
    for (const documentId of files) expect((await link(owner, "event", eventId, { documentId, confirmed: true })).status).toBe(201);
    // Save applies the staged removals one by one (applySheetAttachmentChanges): the second and the fourth.
    for (const documentId of [files[1]!, files[3]!]) expect((await unlink(manager, "event", eventId, documentId)).status).toBe(200);
    expect(reopened((other) => recordCount(other, eventId))).toBe(2);
    // The toast's Undo re-links each (undoSheetRemovals); one after a restart.
    expect((await api(manager, "POST", "/attachments/relink", { hostKind: "event", hostId: eventId, documentId: files[3] })).body).toEqual({ relinked: true, restored: false });
    expect(restarted({ op: "relink", userId: manager.userId, input: { hostKind: "event", hostId: eventId, documentId: files[1] } })).toEqual({ relinked: true, restored: false });
    expect(await order(owner, "event", eventId)).toEqual(files);
  });

  test("after a restart a record still expires at 60 s", () => {
    const hostId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nowMs = Date.now();
    recordRemovedLink(userId, "event", hostId, documentId, { partId: null, position: 2, linkedBy: null, createdAt: new Date(nowMs).toISOString(), binned: false }, nowMs);
    const live = restarted({ op: "removed", userId, kind: "event", hostId, documentId, nowMs: nowMs + UNDO_TICKET_TTL_MS - 1 });
    expect(live).toMatchObject({ position: 2, binned: false });
    expect(restarted({ op: "removed", userId, kind: "event", hostId, documentId, nowMs: nowMs + UNDO_TICKET_TTL_MS })).toBeNull();
    // Read at the expiry, it was deleted, not only hidden.
    expect(reopened((other) => recordCount(other, hostId))).toBe(0);
  });

  test("the sweep deletes expired records and keeps live ones", () => {
    resetUndoTickets();
    const nowMs = Date.now();
    const link = { partId: null, position: 0, linkedBy: null, createdAt: new Date(nowMs).toISOString(), binned: false };
    recordRemovedLink(crypto.randomUUID(), "event", crypto.randomUUID(), crypto.randomUUID(), link, nowMs);
    recordRemovedLink(crypto.randomUUID(), "event", crypto.randomUUID(), crypto.randomUUID(), link, nowMs + 5_000);
    expect(undoTicketCounts().tickets).toBe(2);
    expect(sweepUndoRecords(nowMs + UNDO_TICKET_TTL_MS - 1)).toBe(0);
    expect(sweepUndoRecords(nowMs + UNDO_TICKET_TTL_MS)).toBe(1);
    expect(undoTicketCounts()).toEqual({ tickets: 1, links: 1 });
  });

  test("a link made again through another connection (049 trigger) ends the record, seen after a restart", async () => {
    const { owner, manager, eventId } = await managedEvent("Durable change");
    const file = await uploadAttachment(owner, "x.txt");
    expect((await link(owner, "event", eventId, { documentId: file })).status).toBe(201);
    expect((await unlink(manager, "event", eventId, file)).status).toBe(200);
    reopened((other) => other.query("INSERT INTO attachment_links (host_kind, host_id, document_id, part_id, position, linked_by, created_at) VALUES ('event', ?, ?, NULL, 9, ?, ?)")
      .run(eventId, file, owner.userId, new Date().toISOString()));
    expect(restarted({ op: "removed", userId: manager.userId, kind: "event", hostId: eventId, documentId: file })).toBeNull();
    // Removed again by the owner: the manager's old removal cannot come back.
    expect((await unlink(owner, "event", eventId, file)).status).toBe(200);
    expect(restarted({ op: "relink", userId: manager.userId, input: { hostKind: "event", hostId: eventId, documentId: file } })).toEqual({ error: { status: 404, code: "NOT_FOUND" } });
  });

  test("purging the host, the document, or the remover ends the records", async () => {
    const { owner, manager, eventId } = await managedEvent("Durable purge");
    const files = [await uploadAttachment(owner, "p1.txt"), await uploadAttachment(owner, "p2.txt")];
    for (const documentId of files) expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);
    for (const documentId of files) expect((await unlink(manager, "event", eventId, documentId)).status).toBe(200);
    expect(reopened((other) => recordCount(other, eventId))).toBe(2);
    // A document purge (its row goes): only its record goes.
    reopened((other) => other.query("DELETE FROM documents WHERE id = ?").run(files[0]!));
    expect(reopened((other) => recordCount(other, eventId))).toBe(1);
    // The event purge: every record on it goes.
    reopened((other) => other.query("DELETE FROM events WHERE id = ?").run(eventId));
    expect(reopened((other) => recordCount(other, eventId))).toBe(0);

    // A user delete: their records go.
    const hostId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    recordRemovedLink(userId, "card", hostId, crypto.randomUUID(), { partId: null, position: 0, linkedBy: null, createdAt: new Date().toISOString(), binned: false });
    expect(reopened((other) => recordCount(other, hostId))).toBe(1);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) SELECT ?, ?, 'Gone', password_hash, created_at FROM users WHERE id = ?").run(userId, `${userId}@example.test`, owner.userId);
    reopened((other) => other.query("DELETE FROM users WHERE id = ?").run(userId));
    expect(reopened((other) => recordCount(other, hostId))).toBe(0);
  });
});
