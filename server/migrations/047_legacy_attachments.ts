import type { Migration } from "./types";

/**
 * Uploads everywhere, slice U8 (docs/plan/research/2026-10-09-uploads-everywhere.md §5 047 (b), §6 U8,
 * operator decision Q3): the hidden card and row attachments of v0.34.0 and earlier
 * (`documents.purpose = 'task_attachment' | 'collection_attachment'`, no folder) become ordinary Files
 * documents in their uploader's Attachments system folder (046's `folders.system_kind = 'attachments'`),
 * like every upload made to attach since U0.
 *
 * - **No rebuild.** `documents` is a parent table with cascading children (shares, links, whiteboards);
 *   the runner holds `foreign_keys = ON` inside a transaction, where `DROP TABLE documents` would
 *   cascade-delete them. Rows are updated in place, inside 009's CHECK (`purpose = 'file'` was always
 *   allowed).
 * - **The folders.** An uploader who has no Attachments folder yet gets one, as
 *   `ensureSystemFolder` makes it (server/attachments/service.ts): at the root, private, not the
 *   default, named "Attachments", or "Attachments (Nook)" when they already have an ordinary root folder
 *   called "Attachments" in any case (U0 review L1). 046's guards hold for it from the start.
 * - **Links are kept.** `card_attachments` and `collection_row_attachments` are not touched, so every
 *   card and row shows the same files, and their readers keep reading them through the host rule (D43,
 *   D58; the registry's `card` and `row` hosts).
 * - **Access stays exactly as it was.** A legacy attachment was readable by its owner and through its
 *   links only: the Files sharing branches required `purpose = 'file'`. After the update it is
 *   inheriting (`sharing_override = 0`, `visibility = 'private'`) in a private system folder that can
 *   never be shared (046), so the Files branches still give nobody but the owner. Share rows and group
 *   grants on a legacy attachment granted nothing before; they are removed, so a later "Share" in Files
 *   starts from nobody.
 * - **Binned and purging rows** convert too (deleted_at, deleted_by, purge_after, and purge_started_at
 *   are unchanged), so no legacy purpose is left and a restore follows the Attachments-folder rule.
 * - **Never touched:** the bytes, `sha256`, the object key (the document id), `size_bytes` and owner
 *   (the quota still counts each file once, against its uploader), `created_at`, and `updated_at`.
 *
 * Needs 006, 009, 012, 025 and 046. Transactional and filesystem-free; a second run finds no legacy
 * rows and changes nothing.
 */
const LEGACY = "('task_attachment', 'collection_attachment')";

export const legacyAttachmentsMigration: Migration = {
  id: 47,
  name: "legacy_attachments",
  up(db) {
    const owners = db.query(`SELECT DISTINCT d.owner_id FROM documents d WHERE d.purpose IN ${LEGACY}
      AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.owner_id = d.owner_id AND f.system_kind = 'attachments')
      ORDER BY d.owner_id`).all() as Array<{ owner_id: string }>;
    const nameTaken = db.query("SELECT 1 FROM folders WHERE owner_id = ? AND parent_id IS NULL AND system_kind IS NULL AND name = 'Attachments' COLLATE NOCASE");
    const insertFolder = db.query(`INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind)
      VALUES (?, ?, NULL, ?, ?, ?, 'attachments')`);
    const timestamp = new Date().toISOString();
    for (const { owner_id: ownerId } of owners) {
      insertFolder.run(crypto.randomUUID(), ownerId, nameTaken.get(ownerId) ? "Attachments (Nook)" : "Attachments", timestamp, timestamp);
    }
    db.exec(`
      DELETE FROM document_shares WHERE document_id IN (SELECT id FROM documents WHERE purpose IN ${LEGACY});
      DELETE FROM group_grants WHERE resource_kind = 'document' AND resource_id IN (SELECT id FROM documents WHERE purpose IN ${LEGACY});
      UPDATE documents
        SET purpose = 'file', sharing_override = 0, visibility = 'private',
            folder_id = (SELECT f.id FROM folders f WHERE f.owner_id = documents.owner_id AND f.system_kind = 'attachments')
        WHERE purpose IN ${LEGACY};
    `);
  }
};
