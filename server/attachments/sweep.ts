import { db } from "../db";
import { sourceAccessChangedHook } from "../knowledge/hooks";
import { ATTACHMENTS_FOLDER_KIND, binIfOrphanedAttachment } from "./service";

/**
 * The attachment sweeper steps (uploads everywhere plan D395, T347, T348), run hourly by
 * server/sweeper.ts, each bounded to SWEEP_LIMIT rows per run:
 *
 * 1. Stale links: `attachment_links` rows whose host row is gone. The 046 triggers already remove
 *    them on delete; this catches anything a trigger cannot (a host table without one). Links of a
 *    BINNED host stay, so restoring the host brings its attachments back (§4.4).
 * 2. Orphaned uploads: documents in an Attachments folder, older than a day, that nothing links in
 *    any link table (never linked after `?attachTo=`, or every host purged) move to their owner's
 *    Bin and purge 30 days later. Documents anywhere else are never touched.
 */

export const SWEEP_LIMIT = 100;
export const UNLINKED_GRACE_MS = 24 * 3_600_000;

/** Host kinds with a table to check, and the SQL that is true when the host row still exists. */
const HOST_EXISTS: Record<string, string> = {
  event: "EXISTS (SELECT 1 FROM events h WHERE h.id = l.host_id)",
  note: "EXISTS (SELECT 1 FROM notes h WHERE h.id = l.host_id)",
  chat_message: "EXISTS (SELECT 1 FROM chat_messages h WHERE h.id = l.host_id)",
  whiteboard: "EXISTS (SELECT 1 FROM whiteboards h WHERE h.document_id = l.host_id)"
};

export function sweepStaleAttachmentLinks() {
  let removed = 0;
  for (const [kind, exists] of Object.entries(HOST_EXISTS)) {
    const stale = db.query(`SELECT l.host_id, l.document_id FROM attachment_links l WHERE l.host_kind = ? AND NOT ${exists} LIMIT ${SWEEP_LIMIT}`).all(kind) as Array<{ host_id: string; document_id: string }>;
    for (const link of stale) removed += db.query("DELETE FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?").run(kind, link.host_id, link.document_id).changes;
  }
  return removed;
}

export function sweepOrphanedAttachments(options: { nowMs?: number } = {}) {
  const cutoff = new Date((options.nowMs ?? Date.now()) - UNLINKED_GRACE_MS).toISOString();
  const candidates = db.query(`SELECT d.id FROM documents d JOIN folders f ON f.id = d.folder_id AND f.system_kind = '${ATTACHMENTS_FOLDER_KIND}'
    WHERE d.deleted_at IS NULL AND d.purge_started_at IS NULL AND d.created_at < ? AND d.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM card_attachments c WHERE c.document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM collection_row_attachments r WHERE r.document_id = d.id)
    ORDER BY d.created_at LIMIT ${SWEEP_LIMIT}`).all(cutoff, cutoff) as Array<{ id: string }>;
  const binned: string[] = [];
  for (const candidate of candidates) {
    if (db.transaction(() => binIfOrphanedAttachment(candidate.id, null, { notify: false }))()) binned.push(candidate.id);
  }
  if (binned.length) sourceAccessChangedHook({ kind: "document", ids: binned });
  return binned.length;
}

/** Both steps, for server/sweeper.ts. */
export function sweepAttachments(options: { nowMs?: number } = {}) {
  return { staleLinks: sweepStaleAttachmentLinks(), orphansBinned: sweepOrphanedAttachments(options) };
}
