import { editableNote } from "./access";
import { audit, db, now } from "./db";
import { checksum, storage, withNoteLock } from "./storage";
import { referencedDocumentIds } from "./attachments/noteLinks";
import { ATTACHMENTS_FOLDER_KIND, listAttachments, syncDerivedLinks } from "./attachments/service";

/**
 * Note attachments (uploads everywhere U4, plan D408, T350, G1). A note's files are the documents its
 * PUBLISHED Markdown references (`/api/files/<id>/content` images and `[📎 name](/files/<id>)` chips).
 * Links are derived on every publish, never from a request and never from a draft: the publisher's
 * own documents are linked, documents already linked stay, nobody else's file is ever linked
 * (`syncDerivedLinks`, server/attachments/service.ts). Readers of the published note then open its
 * files through the `note` host rule, whatever the files' own sharing (the G1 fix).
 *
 * Two things are added here because notes have drafts and the other derived host does not:
 *
 * - **Existing notes** are backfilled once at boot (`backfillNoteLinks`): every live published note
 *   gets the links its current version would have derived, for documents its OWNER owns. A marker
 *   audit row (`attachment.backfill`, `{hostKind: "note"}`) records that it ran; later publishes keep
 *   the links in step.
 * - **Draft uploads** live in the Attachments folder before anything links them, and the hourly
 *   orphan sweep bins Attachments-folder files nothing has linked for a day. A draft can sit for
 *   longer, so a draft save, and an hourly pass over live drafts (`keepDraftAttachments`), refresh
 *   the `updated_at` of the Attachments-folder files the draft references that its owner or an
 *   editor owns. This grants nothing (drafts never link); it only keeps the sweep away.
 */

export const NOTE_ATTACHMENT_LIMIT = 100;
/** A draft's referenced uploads are refreshed when their `updated_at` is older than this. */
export const DRAFT_KEEP_REFRESH_MS = 6 * 3_600_000;
const DRAFT_KEEP_INTERVAL_MS = 3_600_000;

/** D408: sets a note's links from its published Markdown. Call inside the publish transaction, under the note lock. */
export function syncNoteLinks(noteId: string, publisherId: string, publishedMarkdown: string) {
  return syncDerivedLinks("note", noteId, publisherId, referencedDocumentIds(publishedMarkdown));
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
 * Keeps the Attachments-folder files a draft references out of the orphan sweep (see above). Only
 * live documents owned by the note's owner or by someone who can edit it, and only when their
 * `updated_at` is older than DRAFT_KEEP_REFRESH_MS, so frequent autosaves write nothing.
 */
export function keepDraftReferences(noteId: string, ownerId: string, markdown: string, nowMs = Date.now()) {
  const ids = referencedDocumentIds(markdown).slice(0, NOTE_ATTACHMENT_LIMIT);
  if (!ids.length) return 0;
  const marks = ids.map(() => "?").join(",");
  const stale = new Date(nowMs - DRAFT_KEEP_REFRESH_MS).toISOString();
  const candidates = db.query(`SELECT d.id, d.owner_id FROM documents d JOIN folders f ON f.id = d.folder_id AND f.system_kind = '${ATTACHMENTS_FOLDER_KIND}'
    WHERE d.id IN (${marks}) AND d.deleted_at IS NULL AND d.purge_started_at IS NULL AND d.updated_at < ?`).all(...ids, stale) as Array<{ id: string; owner_id: string }>;
  const allowed = new Map<string, boolean>();
  const mayKeep = (userId: string) => {
    if (userId === ownerId) return true;
    if (!allowed.has(userId)) allowed.set(userId, editableNote(noteId, userId) !== null);
    return allowed.get(userId)!;
  };
  const timestamp = new Date(nowMs).toISOString();
  let touched = 0;
  for (const candidate of candidates) {
    if (!mayKeep(candidate.owner_id)) continue;
    touched += db.query("UPDATE documents SET updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, candidate.id).changes;
  }
  return touched;
}

/** One pass over every note with a draft (live or in the Bin, so a restored note keeps its pictures). */
export async function keepDraftAttachments(nowMs = Date.now()) {
  const notes = db.query("SELECT id, owner_id, draft_checksum FROM notes WHERE draft_revision IS NOT NULL AND purge_started_at IS NULL").all() as Array<{ id: string; owner_id: string; draft_checksum: string | null }>;
  let touched = 0;
  for (const note of notes) {
    try {
      const markdown = await storage.readDraft(note.id);
      if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) continue;
      touched += keepDraftReferences(note.id, note.owner_id, markdown, nowMs);
    } catch {
      // A missing or unreadable draft keeps nothing; the next pass tries again.
    }
  }
  return touched;
}

let keeper: ReturnType<typeof setInterval> | null = null;

/** Runs keepDraftAttachments hourly (started at boot, after the first pass). */
export function startDraftAttachmentKeeper() {
  if (keeper) return;
  keeper = setInterval(() => {
    void keepDraftAttachments().catch(() => console.error("Draft attachment keeper failed"));
  }, DRAFT_KEEP_INTERVAL_MS);
  keeper.unref();
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
