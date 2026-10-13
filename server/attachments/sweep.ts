import { db } from "../db";
import { sourceAccessChangedHook } from "../knowledge/hooks";
import { ATTACHMENTS_FOLDER_KIND, binIfOrphanedAttachment } from "./service";
import { isReferencedNow, refreshReferenceIndex, registeredReferences } from "./references";
import type { HostKind } from "./hosts";
import { linkChanged } from "./undoTickets";

/**
 * The attachment sweeper steps (uploads everywhere plan D395, T347, T348), run hourly by
 * server/sweeper.ts, each bounded to SWEEP_LIMIT rows per run:
 *
 * 1. Stale links: `attachment_links` rows whose host row is gone. The 046 triggers already remove
 *    them on delete; this catches anything a trigger cannot (a host table without one). Links of a
 *    BINNED host stay, so restoring the host brings its attachments back (§4.4).
 * 2. Orphaned uploads: documents in an Attachments folder, older than a day, that nothing links in
 *    any link table (never linked after `?attachTo=`, or every host purged) and that no note draft,
 *    stored note version, or whiteboard references (server/attachments/references.ts, review M3) move
 *    to their owner's Bin and purge 30 days later. Documents anywhere else are never touched.
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
    for (const link of stale) {
      removed += db.query("DELETE FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?").run(kind, link.host_id, link.document_id).changes;
      linkChanged(kind as HostKind, link.host_id, link.document_id);
    }
  }
  return removed;
}

export async function sweepOrphanedAttachments(options: { nowMs?: number } = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - UNLINKED_GRACE_MS).toISOString();
  const unlinked = `FROM documents d JOIN folders f ON f.id = d.folder_id AND f.system_kind = '${ATTACHMENTS_FOLDER_KIND}'
    WHERE d.deleted_at IS NULL AND d.purge_started_at IS NULL AND d.created_at < ? AND d.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM card_attachments c WHERE c.document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM collection_row_attachments r WHERE r.document_id = d.id)`;
  // Review L2: nothing to do, nothing read (no content scan, no S3 GET) on most runs.
  if (!db.query(`SELECT 1 ${unlinked} LIMIT 1`).get(cutoff, cutoff)) return 0;
  // Review M3: a file a note draft, a stored note version, or a whiteboard still references is kept,
  // even with no link (links are derived only on publish or save). The reference index (048) is
  // brought up to date first, reading only content it has not seen; a doubt bins nothing (L2).
  let unrecorded: Set<string>;
  try {
    unrecorded = await refreshReferenceIndex();
  } catch {
    return 0;
  }
  // With the index current, referenced files are left out in SQL, so they never crowd the batch out.
  const rows = (db.query(`SELECT d.id, d.updated_at ${unlinked} AND NOT EXISTS (SELECT 1 FROM content_references x WHERE x.document_id = d.id)
    ORDER BY d.created_at LIMIT ${SWEEP_LIMIT * 5}`).all(cutoff, cutoff) as Array<{ id: string; updated_at: string }>)
    .filter((row) => !unrecorded.has(row.id));
  const referenced = await registeredReferences(rows.map((row) => row.id));
  const candidates = rows.filter((row) => !referenced.has(row.id)).slice(0, SWEEP_LIMIT);
  const binned: string[] = [];
  // Review L2: the scan above awaited content reads, so each bin re-checks, in its own transaction,
  // that the row is unchanged (a restore or rename sets updated_at), and that no draft saved or board
  // saved since references it (writers record their references as they commit), before binning.
  const unchanged = db.query("SELECT 1 FROM documents WHERE id = ? AND updated_at = ? AND deleted_at IS NULL AND purge_started_at IS NULL");
  for (const candidate of candidates) {
    const done = db.transaction(() => {
      if (!unchanged.get(candidate.id, candidate.updated_at) || isReferencedNow(candidate.id)) return false;
      return binIfOrphanedAttachment(candidate.id, null, { notify: false });
    })();
    if (done) binned.push(candidate.id);
  }
  if (binned.length) sourceAccessChangedHook({ kind: "document", ids: binned });
  return binned.length;
}

/** The triggers migration 046 installs; the attachment rules rely on every one (review L3). */
export const ATTACHMENT_TRIGGERS = [
  "events_attachment_links_ad", "notes_attachment_links_ad", "chat_messages_attachment_links_ad", "whiteboards_attachment_links_ad",
  "folders_system_kind_fixed", "folders_system_unchanged", "folders_system_no_child_insert", "folders_system_no_child_update",
  "folder_shares_no_system", "group_grants_no_system_folder", "notes_no_system_folder_insert", "notes_no_system_folder_update", "whiteboards_no_system_folder"
] as const;

/** Boot self-check (the grant self-check's pattern: logged loudly, never fatal): the 046 trigger names that are missing. */
export function missingAttachmentTriggers(): string[] {
  const present = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name));
  return ATTACHMENT_TRIGGERS.filter((name) => !present.has(name));
}

/** Both steps, for server/sweeper.ts. */
export async function sweepAttachments(options: { nowMs?: number } = {}) {
  return { staleLinks: sweepStaleAttachmentLinks(), orphansBinned: await sweepOrphanedAttachments(options) };
}
