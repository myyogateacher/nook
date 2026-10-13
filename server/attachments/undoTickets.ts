import { db } from "../db";
import type { HostKind } from "./hosts";

/**
 * Undo records for removed attachments (POST /api/attachments/relink). When someone removes a link,
 * the link as it was (its part, position, linker, and time) is kept for a short while, for that person
 * only. Undo uses it to put the link back exactly where it was, and it is the only way a link to a
 * file the person does not own can come back: the file's owner made that link, and Undo only restores
 * it (it never makes a new one). Without a record (expired, or never made), Undo falls back to the
 * ordinary link rules (the owner's own file, appended at the end).
 *
 * The records live in SQLite (`attachment_undo_records`, migration 049, v0.37.0), so a restart keeps
 * them. A removal records its ticket in the same transaction as the removal.
 *
 * A record undoes ONE removal, the latest one (v0.36.0 review M1). Whenever any link for (kind, host,
 * document) is created or removed, by anyone and by any path, every record for that link is deleted
 * and the link's generation ends: the 049 triggers on the link tables do it in the same statement (FK
 * cascades and purges included), and linkChanged / linksChanged / hostLinksGone say it explicitly at
 * each write. A removal then records a fresh row whose generation (AUTOINCREMENT, never reused) is the
 * link's new one, so an older removal can never override a later decision (for example the file's
 * owner linking it again and withdrawing it). Purging a host, a document, or a user ends its records.
 */

export type RemovedLink = {
  partId: string | null;
  position: number;
  linkedBy: string | null;
  createdAt: string;
  /** Whether the removal moved the file to its owner's Bin. */
  binned: boolean;
};

/** A live ticket as removedLink returns it: the removed link and the link generation it belongs to. */
export type RemovalTicket = RemovedLink & { generation: number };

/** The toast's Undo lasts 10 s; this leaves slack for a slow phone and stays a mistake's undo. */
export const UNDO_TICKET_TTL_MS = 60_000;
/** A bound on the table: the oldest records go first. */
export const UNDO_TICKET_MAX = 10_000;

type Row = { generation: number; part_id: string | null; position: number; linked_by: string | null; linked_at: string; binned: number; expires_at: number };

const lower = (value: string) => value.toLowerCase();

/**
 * A link for (kind, host, document) was created or removed, by anyone, by any path: every record for
 * it is deleted and its generation ends. Call inside the link change's transaction (the 049 triggers
 * already do it in the same statement; a rollback restores the record with the link).
 */
export function linkChanged(kind: HostKind, hostId: string, documentId: string) {
  db.query("DELETE FROM attachment_undo_records WHERE host_kind = ? AND host_id = ? AND document_id = ?").run(kind, lower(hostId), lower(documentId));
}

/** linkChanged for several documents on one host. */
export function linksChanged(kind: HostKind, hostId: string, documentIds: Iterable<string>) {
  for (const documentId of documentIds) linkChanged(kind, hostId, documentId);
}

/** Hosts were purged with all their links (a cascade): every record on them goes. */
export function hostLinksGone(kind: HostKind, hostIds: Iterable<string>) {
  const drop = db.query("DELETE FROM attachment_undo_records WHERE host_kind = ? AND host_id = ?");
  for (const hostId of new Set([...hostIds].map(lower))) drop.run(kind, hostId);
}

/** Deletes expired records (on read, on record, and in the hourly sweep); returns how many went. */
export function sweepUndoRecords(nowMs = Date.now()) {
  let removed = db.query("DELETE FROM attachment_undo_records WHERE expires_at <= ?").run(nowMs).changes;
  const count = (db.query("SELECT COUNT(*) AS count FROM attachment_undo_records").get() as { count: number }).count;
  if (count > UNDO_TICKET_MAX) {
    removed += db.query(`DELETE FROM attachment_undo_records WHERE generation IN
      (SELECT generation FROM attachment_undo_records ORDER BY generation LIMIT ?)`).run(count - UNDO_TICKET_MAX).changes;
  }
  return removed;
}

/**
 * Records the link `userId` just removed (deleting every older record for that link). Call inside the
 * removal's transaction, after the delete, so the record commits (or rolls back) with it.
 */
export function recordRemovedLink(userId: string, kind: HostKind, hostId: string, documentId: string, link: RemovedLink, nowMs = Date.now()) {
  db.transaction(() => {
    linkChanged(kind, hostId, documentId);
    db.query(`INSERT INTO attachment_undo_records (remover_id, host_kind, host_id, document_id, part_id, position, linked_by, linked_at, binned, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, kind, lower(hostId), lower(documentId), link.partId, link.position, link.linkedBy, link.createdAt, link.binned ? 1 : 0, nowMs + UNDO_TICKET_TTL_MS);
    sweepUndoRecords(nowMs);
  })();
}

/**
 * The live record for this removal, or null (not consumed). Expired, or the link changed since: null.
 * Call inside the host's lock or transaction, where the relink checks the link.
 */
export function removedLink(userId: string, kind: HostKind, hostId: string, documentId: string, nowMs = Date.now()): RemovalTicket | null {
  db.query("DELETE FROM attachment_undo_records WHERE expires_at <= ?").run(nowMs);
  const row = db.query(`SELECT generation, part_id, position, linked_by, linked_at, binned, expires_at FROM attachment_undo_records
    WHERE remover_id = ? AND host_kind = ? AND host_id = ? AND document_id = ?`).get(userId, kind, lower(hostId), lower(documentId)) as Row | null;
  if (!row) return null;
  return { partId: row.part_id, position: row.position, linkedBy: row.linked_by, createdAt: row.linked_at, binned: row.binned === 1, generation: row.generation };
}

/** Deletes the caller's record once the link is back (or can never come back). */
export function forgetRemovedLink(userId: string, kind: HostKind, hostId: string, documentId: string) {
  db.query("DELETE FROM attachment_undo_records WHERE remover_id = ? AND host_kind = ? AND host_id = ? AND document_id = ?").run(userId, kind, lower(hostId), lower(documentId));
}

/** Tests only: deletes every record. */
export function resetUndoTickets() {
  db.query("DELETE FROM attachment_undo_records").run();
}

/** Tests only: how many records are held, and for how many links. */
export function undoTicketCounts() {
  return db.query("SELECT COUNT(*) AS tickets, COUNT(DISTINCT host_kind || char(0) || host_id || char(0) || document_id) AS links FROM attachment_undo_records").get() as { tickets: number; links: number };
}
