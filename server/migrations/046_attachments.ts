import { addColumn, type Migration } from "./types";

/**
 * Uploads everywhere, slice U0 (docs/plan/research/2026-10-09-uploads-everywhere.md §5, D390–D395).
 * Additive only; no table is rebuilt (the `documents` purpose CHECK stays as 009 made it).
 *
 * - `folders.system_kind`: NULL for every ordinary folder, or a short `[a-z_]` word for a folder the
 *   server owns on the person's behalf. `attachments` is the per-person "Attachments" folder (D391);
 *   Messages may add `messages` later with no rebuild. One per (owner, kind).
 * - `attachment_links`: one row per (host, document). The host registry in code
 *   (server/attachments/hosts.ts) says what each `host_kind` is and who may read it; `part_id` is the
 *   comment, field, or message part inside the host. Card and row links stay in their own tables.
 * - AFTER DELETE triggers on `events`, `notes`, `chat_messages`, and `whiteboards` (for U4b) drop their links, so a purge (and an
 *   FK cascade, such as a calendar purge) leaves none behind (T348).
 * - System-folder guards (D392, T342): a system folder is never shared (no folder share row, no group
 *   grant, visibility stays private), never renamed or moved, holds no subfolders and no notes, and a
 *   folder never becomes (or stops being) a system folder after it is made. The routes refuse first with
 *   400 SYSTEM_FOLDER; these triggers make it hold for every other path too. Files may live in it, and
 *   the owner may move them out.
 *
 * Needs 001, 002, 006, 013, 025, 030, and 039. Transactional and filesystem-free; re-running changes nothing.
 */
const SYSTEM_FOLDER = (column: string) => `EXISTS (SELECT 1 FROM folders sf WHERE sf.id = ${column} AND sf.system_kind IS NOT NULL)`;

export const attachmentsMigration: Migration = {
  id: 46,
  name: "attachments",
  up(db) {
    addColumn(db, "folders", "system_kind", "TEXT CHECK (system_kind IS NULL OR (length(system_kind) BETWEEN 1 AND 32 AND system_kind NOT GLOB '*[^a-z_]*'))");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_system_kind ON folders(owner_id, system_kind) WHERE system_kind IS NOT NULL;

      CREATE TABLE IF NOT EXISTS attachment_links (
        host_kind TEXT NOT NULL CHECK (length(host_kind) BETWEEN 1 AND 32 AND host_kind NOT GLOB '*[^a-z_]*'),
        host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 64),
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        part_id TEXT CHECK (part_id IS NULL OR length(part_id) <= 64),
        position INTEGER NOT NULL DEFAULT 0,
        linked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (host_kind, host_id, document_id)
      );
      CREATE INDEX IF NOT EXISTS idx_attachment_links_document ON attachment_links(document_id);
      CREATE INDEX IF NOT EXISTS idx_attachment_links_part ON attachment_links(host_kind, part_id) WHERE part_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS events_attachment_links_ad AFTER DELETE ON events
        BEGIN DELETE FROM attachment_links WHERE host_kind = 'event' AND host_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS notes_attachment_links_ad AFTER DELETE ON notes
        BEGIN DELETE FROM attachment_links WHERE host_kind = 'note' AND host_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_attachment_links_ad AFTER DELETE ON chat_messages
        BEGIN DELETE FROM attachment_links WHERE host_kind = 'chat_message' AND host_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS whiteboards_attachment_links_ad AFTER DELETE ON whiteboards
        BEGIN DELETE FROM attachment_links WHERE host_kind = 'whiteboard' AND host_id = OLD.document_id; END;

      CREATE TRIGGER IF NOT EXISTS folders_system_kind_fixed BEFORE UPDATE OF system_kind ON folders
        WHEN NEW.system_kind IS NOT OLD.system_kind
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS folders_system_unchanged BEFORE UPDATE OF name, parent_id, visibility, owner_id ON folders
        WHEN OLD.system_kind IS NOT NULL AND (NEW.name IS NOT OLD.name OR NEW.parent_id IS NOT OLD.parent_id OR NEW.visibility <> 'private' OR NEW.owner_id IS NOT OLD.owner_id)
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS folders_system_no_child_insert BEFORE INSERT ON folders
        WHEN NEW.parent_id IS NOT NULL AND ${SYSTEM_FOLDER("NEW.parent_id")}
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS folders_system_no_child_update BEFORE UPDATE OF parent_id ON folders
        WHEN NEW.parent_id IS NOT NULL AND ${SYSTEM_FOLDER("NEW.parent_id")}
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS folder_shares_no_system BEFORE INSERT ON folder_shares
        WHEN ${SYSTEM_FOLDER("NEW.folder_id")}
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS group_grants_no_system_folder BEFORE INSERT ON group_grants
        WHEN NEW.resource_kind = 'folder' AND ${SYSTEM_FOLDER("NEW.resource_id")}
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS notes_no_system_folder_insert BEFORE INSERT ON notes
        WHEN NEW.folder_id IS NOT NULL AND ${SYSTEM_FOLDER("NEW.folder_id")}
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS notes_no_system_folder_update BEFORE UPDATE OF folder_id ON notes
        WHEN NEW.folder_id IS NOT NULL AND NEW.folder_id IS NOT OLD.folder_id AND ${SYSTEM_FOLDER("NEW.folder_id")}
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
      CREATE TRIGGER IF NOT EXISTS whiteboards_no_system_folder BEFORE INSERT ON whiteboards
        WHEN EXISTS (SELECT 1 FROM documents wd WHERE wd.id = NEW.document_id AND wd.folder_id IS NOT NULL AND ${SYSTEM_FOLDER("wd.folder_id")})
        BEGIN SELECT RAISE(ABORT, 'SYSTEM_FOLDER'); END;
    `);
  }
};
