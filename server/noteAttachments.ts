import { editableNote } from "./access";
import { audit, db, now } from "./db";
import { checksum, storage, withNoteLock } from "./storage";
import { referencedDocumentIds } from "./attachments/noteLinks";
import { listAttachments, syncDerivedLinks } from "./attachments/service";

/**
 * Note attachments (uploads everywhere U4, plan D408, T350, G1). A note's files are the documents its
 * PUBLISHED Markdown references (`/api/files/<id>/content` images and `[📎 name](/files/<id>)` chips).
 * Links are derived on every publish, never from a request and never from a draft: the publisher's
 * own documents are linked, documents already linked stay, nobody else's file is ever linked
 * (`syncDerivedLinks`, server/attachments/service.ts). Readers of the published note then open its
 * files through the `note` host rule, whatever the files' own sharing (the G1 fix).
 *
 * **Existing notes** are backfilled once at boot (`backfillNoteLinks`): every live published note
 * gets the links its current version would have derived, for documents its OWNER owns. A marker
 * audit row (`attachment.backfill`, `{hostKind: "note"}`) records that it ran; later publishes keep
 * the links in step. Draft uploads need nothing here: the orphan sweep keeps every file a draft or
 * a stored version references (server/attachments/references.ts, U0 review M3).
 *
 * The publisher's own referenced files that are in their Bin come back as `binnedAttachments`, so the
 * app can offer to restore them; `resyncNoteLinks` then links them without a new version.
 */

export const NOTE_ATTACHMENT_LIMIT = 100;

/** D408: sets a note's links from its published Markdown. Call inside the publish transaction, under the note lock. */
export function syncNoteLinks(noteId: string, publisherId: string, publishedMarkdown: string) {
  const ids = referencedDocumentIds(publishedMarkdown);
  const result = syncDerivedLinks("note", noteId, publisherId, ids);
  // `binned` from the service lists only files it could not link; a file still linked from an earlier
  // version but now in the publisher's Bin shows broken just the same, so it is reported too (M3).
  const binned = new Set(result.binned);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const rows = db.query(`SELECT id FROM documents WHERE id IN (${marks}) AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`).all(...ids, publisherId) as Array<{ id: string }>;
    for (const row of rows) binned.add(row.id);
  }
  return { ...result, binned: ids.filter((id) => binned.has(id)) };
}

/** The note's files as `userId` sees them (MCP read_note), or [] when they cannot read the published note. */
export function noteAttachmentsFor(noteId: string, userId: string) {
  try {
    return listAttachments("note", noteId, userId).map((item) => item.removed
      ? { id: item.documentId, removed: true as const }
      : { id: item.documentId, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes });
  } catch {
    return [];
  }
}

/**
 * Re-derives a published note's links for `userId` (POST /api/notes/:id/attachments/sync), after they
 * restored their own files from the Bin (review M3): only their own documents are added (T350).
 * Returns null when they cannot edit the note or it is not published. Takes the note lock.
 */
export async function resyncNoteLinks(noteId: string, userId: string) {
  return withNoteLock(noteId, async () => {
    const note = editableNote(noteId, userId);
    if (!note || note.current_version < 1) return null;
    const metadata = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(noteId, note.current_version) as { checksum: string } | null;
    if (!metadata) return null;
    const markdown = await storage.readVersion(noteId, note.current_version);
    if (checksum(markdown) !== metadata.checksum) throw new Error("Version content failed integrity verification");
    const result = syncNoteLinks(noteId, userId, markdown);
    return { linked: result.linked.length, skippedAttachments: result.skipped.length, binnedAttachments: result.binned };
  });
}

const backfillDone = (hostKind: string) => Boolean(db.query("SELECT 1 FROM audit_log WHERE event_type = 'attachment.backfill' AND json_extract(metadata_json, '$.hostKind') = ? LIMIT 1").get(hostKind));

/**
 * Existing notes (U4): derives links once for every live published note from its current version,
 * linking only documents the note's OWNER owns (an image an editor uploaded links on that editor's
 * next publish). Idempotent; `force` runs it again (tests). Returns counts.
 */
export async function backfillNoteLinks(options: { force?: boolean } = {}) {
  if (!options.force && backfillDone("note")) return null;
  const notes = db.query("SELECT id FROM notes WHERE deleted_at IS NULL AND current_version > 0 AND purge_started_at IS NULL").all() as Array<{ id: string }>;
  const counts = { notes: 0, linked: 0, failed: 0 };
  for (const { id } of notes) {
    try {
      await withNoteLock(id, async () => {
        const note = db.query("SELECT owner_id, current_version FROM notes WHERE id = ? AND deleted_at IS NULL AND current_version > 0").get(id) as { owner_id: string; current_version: number } | null;
        if (!note) return;
        const metadata = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, note.current_version) as { checksum: string } | null;
        if (!metadata) return;
        const markdown = await storage.readVersion(id, note.current_version);
        if (checksum(markdown) !== metadata.checksum) throw new Error("Version checksum does not match");
        const ids = referencedDocumentIds(markdown);
        if (!ids.length) return;
        counts.notes += 1;
        counts.linked += syncDerivedLinks("note", id, note.owner_id, ids).linked.length;
      });
    } catch {
      counts.failed += 1;
    }
  }
  audit(null, null, "attachment.backfill", { hostKind: "note", at: now(), ...counts });
  return counts;
}
