import { editableNote } from "./access";
import { audit, db, now } from "./db";
import { checksum, storage, withNoteLock } from "./storage";
import { referencedDocumentIds } from "./attachments/noteLinks";
import { allowListPolicy, ATTACHMENTS_FOLDER_KIND, attachmentsOnlyPolicy, listAttachments, personLinkPolicy, planDerivedLinks, syncDerivedLinks, type LinkPolicy } from "./attachments/service";
import { keyMaySeeAttachmentId } from "./attachments/keyLinks";
import type { McpKeyContext } from "./mcpToolKit";

/**
 * Note attachments (uploads everywhere U4, plan D408, T350, G1). A note's files are the documents its
 * PUBLISHED Markdown references (`/api/files/<id>/content` images and `[📎 name](/files/<id>)` chips).
 * Links are derived on every publish, never from a request and never from a draft: the publisher's
 * own documents are linked, documents already linked stay, nobody else's file is ever linked
 * (`syncDerivedLinks`, server/attachments/service.ts). Readers of the published note then open its
 * files through the `note` host rule, whatever the files' own sharing (the G1 fix).
 *
 * Of the publisher's own files, only those in their **Attachments** folder join silently. Any other
 * Files item needs the publisher's explicit confirm: the publish answers 409 CONFIRM_REQUIRED until
 * the file is listed in `confirmAttachments`, because an editor may have put the reference in the
 * shared draft (v0.35.0 review M1, T350). A key publishing (MCP `publish_note_draft`) is never asked:
 * it links only Attachments files its grants reach and reports the rest as skipped (T354).
 *
 * **Existing notes** are backfilled once at boot (`backfillNoteLinks`): every live published note
 * gets links for the documents its OWNER owns that its current version references and that the
 * owner demonstrably put there (see `backfillNoteLinks`). A marker audit row (`attachment.backfill`,
 * `{hostKind: "note"}`) records that it ran; later publishes keep the links in step. Draft uploads
 * need nothing here: the orphan sweep keeps every file a draft or a stored version references
 * (server/attachments/references.ts, U0 review M3).
 *
 * The publisher's own referenced files that are in their Bin come back as `binnedAttachments`, so the
 * app can offer to restore them; `resyncNoteLinks` then links them without a new version.
 */

export const NOTE_ATTACHMENT_LIMIT = 100;

/**
 * The publisher's own files that publishing `markdown` would newly link only with their confirm
 * (review M1). Read-only; call under the note lock before staging the version.
 */
export function noteLinksNeedingConfirm(noteId: string, publisherId: string, publishedMarkdown: string, policy: LinkPolicy) {
  return planDerivedLinks("note", noteId, publisherId, referencedDocumentIds(publishedMarkdown), policy).confirm;
}

/** D408: sets a note's links from its published Markdown. Call inside the publish transaction, under the note lock. */
export function syncNoteLinks(noteId: string, publisherId: string, publishedMarkdown: string, policy: LinkPolicy = personLinkPolicy()) {
  const ids = referencedDocumentIds(publishedMarkdown);
  const result = syncDerivedLinks("note", noteId, publisherId, ids, policy);
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

/**
 * The note's files as `userId` sees them (MCP read_note), or [] when they cannot read the published
 * note. Through a key, the owner's own files the key may not see are left out (T354).
 */
export function noteAttachmentsFor(noteId: string, userId: string, key?: McpKeyContext) {
  try {
    return listAttachments("note", noteId, userId)
      .filter((item) => !key || keyMaySeeAttachmentId(key, { kind: "note", hostId: noteId }, item.documentId))
      .map((item) => item.removed
        ? { id: item.documentId, removed: true as const }
        : { id: item.documentId, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes });
  } catch {
    return [];
  }
}

/**
 * Re-derives a published note's links for `userId` (POST /api/notes/:id/attachments/sync), after they
 * restored their own files from the Bin (review M3): only their own Attachments-folder documents are
 * added (T350; a Files item needs the confirm of a publish, review M1). Returns null when they cannot
 * edit the note or it is not published. Takes the note lock.
 */
export async function resyncNoteLinks(noteId: string, userId: string) {
  return withNoteLock(noteId, async () => {
    const note = editableNote(noteId, userId);
    if (!note || note.current_version < 1) return null;
    const markdown = await verifiedVersion(noteId, note.current_version).catch((error: Error) => {
      if (error.message === "Version metadata is missing") return null;
      throw new Error("Version content failed integrity verification");
    });
    if (markdown === null) return null;
    const result = syncNoteLinks(noteId, userId, markdown, attachmentsOnlyPolicy);
    return { linked: result.linked.length, skippedAttachments: result.skipped.length, binnedAttachments: result.binned };
  });
}

const backfillDone = (hostKind: string) => Boolean(db.query("SELECT 1 FROM audit_log WHERE event_type = 'attachment.backfill' AND json_extract(metadata_json, '$.hostKind') = ? LIMIT 1").get(hostKind));

/**
 * Existing notes (U4; rule tightened by the v0.35.0 review M1, T350): derives links once for every
 * live published note from its current version, for documents the note's OWNER owns, and only when
 * the owner demonstrably put the reference there:
 *
 * - a file in the owner's **Attachments** folder (it exists only to be attached), or
 * - any other file of the owner's only when the **first stored version that references it was
 *   authored by the owner** (`note_versions.author_id`). Before 0.35 a picture pasted into a note was
 *   an ordinary Files upload (`purpose = 'file'`, in the note's folder or Default, an Idempotency-Key
 *   like any Files upload, and a plain `document.upload` audit row), so nothing tells it apart from a
 *   file uploaded in Files; the version author is the evidence. A reference an editor introduced
 *   (D274) is never backfilled; the owner's next publish asks them to confirm it.
 *
 * Idempotent; `force` runs it again (tests). Returns counts.
 */
export async function backfillNoteLinks(options: { force?: boolean } = {}) {
  if (!options.force && backfillDone("note")) return null;
  const notes = db.query("SELECT id FROM notes WHERE deleted_at IS NULL AND current_version > 0 AND purge_started_at IS NULL").all() as Array<{ id: string }>;
  const counts = { notes: 0, linked: 0, withheld: 0, failed: 0 };
  for (const { id } of notes) {
    try {
      await withNoteLock(id, async () => {
        const note = db.query("SELECT owner_id, current_version FROM notes WHERE id = ? AND deleted_at IS NULL AND current_version > 0").get(id) as { owner_id: string; current_version: number } | null;
        if (!note) return;
        if (!db.query("SELECT 1 FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, note.current_version)) return;
        const markdown = await verifiedVersion(id, note.current_version);
        const ids = referencedDocumentIds(markdown);
        if (!ids.length) return;
        const allowed = await ownerIntroduced(id, note.owner_id, note.current_version, ids);
        counts.notes += 1;
        const result = syncDerivedLinks("note", id, note.owner_id, ids, allowListPolicy(allowed));
        counts.linked += result.linked.length;
        counts.withheld += result.skipped.filter((documentId) => !allowed.has(documentId)).length;
      });
    } catch {
      counts.failed += 1;
    }
  }
  audit(null, null, "attachment.backfill", { hostKind: "note", at: now(), ...counts });
  return counts;
}

/** A stored version's Markdown, checked against its checksum. */
async function verifiedVersion(noteId: string, version: number) {
  const metadata = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(noteId, version) as { checksum: string } | null;
  if (!metadata) throw new Error("Version metadata is missing");
  const markdown = await storage.readVersion(noteId, version);
  if (checksum(markdown) !== metadata.checksum) throw new Error("Version checksum does not match");
  return markdown;
}

/**
 * The referenced documents of the owner's that the backfill may link: Attachments-folder files, and
 * other files whose first referencing version (oldest first) the owner authored. An unreadable or
 * altered older version withholds every file it might have introduced.
 */
async function ownerIntroduced(noteId: string, ownerId: string, currentVersion: number, ids: readonly string[]) {
  const allowed = new Set<string>();
  const marks = ids.map(() => "?").join(",");
  const owned = db.query(`SELECT d.id, f.system_kind FROM documents d LEFT JOIN folders f ON f.id = d.folder_id WHERE d.id IN (${marks}) AND d.owner_id = ?`)
    .all(...ids, ownerId) as Array<{ id: string; system_kind: string | null }>;
  const open = new Set<string>();
  for (const row of owned) (row.system_kind === ATTACHMENTS_FOLDER_KIND ? allowed : open).add(row.id);
  if (!open.size) return allowed;
  const versions = db.query("SELECT version_number, author_id FROM note_versions WHERE note_id = ? AND version_number <= ? ORDER BY version_number")
    .all(noteId, currentVersion) as Array<{ version_number: number; author_id: string }>;
  for (const version of versions) {
    if (!open.size) break;
    let markdown: string;
    try {
      markdown = await verifiedVersion(noteId, version.version_number);
    } catch {
      break;
    }
    for (const documentId of referencedDocumentIds(markdown)) {
      if (!open.delete(documentId)) continue;
      if (version.author_id === ownerId) allowed.add(documentId);
    }
  }
  return allowed;
}
