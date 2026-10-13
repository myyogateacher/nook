import type { Migration } from "./types";

/**
 * v0.37.0: the Undo records for removed attachments (POST /api/attachments/relink) move from memory
 * to SQLite, so a restart no longer forgets them (server/attachments/undoTickets.ts).
 *
 * - `attachment_undo_records`: one row per removal, for its remover only, holding the removed link as
 *   it was (part, position, linker, linked-at), whether the removal binned the file, and an expiry
 *   (epoch ms, 60 s after the removal). `generation` is the link generation: AUTOINCREMENT, so a
 *   number is never reused, even after the table empties. At most one row per link in practice (a
 *   removal drops every older record for it); the unique index is the (remover, link) key.
 * - Invalidation (review M1 of v0.36.0): any link created or removed for (kind, host, document), by
 *   any path, ends every record for it. AFTER INSERT / AFTER DELETE triggers on the three link tables
 *   (`attachment_links`, `card_attachments`, `collection_row_attachments`) do this in the same
 *   statement, so every write, FK cascade, and purge is covered. Purging a host (event, note, chat
 *   message, whiteboard, card, row), a document, or a user ends the records on it too (no FKs: a
 *   record never blocks a delete).
 *
 * Needs 009, 012, 013, 030, 039, and 046. Transactional and filesystem-free; created empty, so an
 * upgrade only loses the in-memory Undo records of the restart it takes (60 s at most).
 */
const LINK_TABLES = [
  { table: "attachment_links", kind: "NEW.host_kind", host: "host_id", short: "attachment_links" },
  { table: "card_attachments", kind: "'card'", host: "card_id", short: "card_attachments" },
  { table: "collection_row_attachments", kind: "'row'", host: "row_id", short: "row_attachments" }
] as const;

const HOST_TABLES = [
  { table: "events", kind: "event", id: "id" },
  { table: "notes", kind: "note", id: "id" },
  { table: "chat_messages", kind: "chat_message", id: "id" },
  { table: "whiteboards", kind: "whiteboard", id: "document_id" },
  { table: "cards", kind: "card", id: "id" },
  { table: "collection_rows", kind: "row", id: "id" }
] as const;

/** The trigger names 049 installs (the boot self-check lists any that are missing). */
export const UNDO_RECORD_TRIGGERS: readonly string[] = [
  ...LINK_TABLES.flatMap(({ short }) => [`${short}_undo_ai`, `${short}_undo_ad`]),
  ...HOST_TABLES.map(({ table }) => `${table}_undo_ad`),
  "documents_undo_ad", "users_undo_ad"
];

const linkTriggers = () => LINK_TABLES.map(({ table, kind, host, short }) => {
  const forRow = (row: "NEW" | "OLD") => `DELETE FROM attachment_undo_records
    WHERE host_kind = ${kind.replace("NEW.", `${row}.`)} AND host_id = lower(${row}.${host}) AND document_id = lower(${row}.document_id);`;
  return `
      CREATE TRIGGER IF NOT EXISTS ${short}_undo_ai AFTER INSERT ON ${table} BEGIN ${forRow("NEW")} END;
      CREATE TRIGGER IF NOT EXISTS ${short}_undo_ad AFTER DELETE ON ${table} BEGIN ${forRow("OLD")} END;`;
}).join("\n");

const hostTriggers = () => HOST_TABLES.map(({ table, kind, id }) => `
      CREATE TRIGGER IF NOT EXISTS ${table}_undo_ad AFTER DELETE ON ${table}
        BEGIN DELETE FROM attachment_undo_records WHERE host_kind = '${kind}' AND host_id = lower(OLD.${id}); END;`).join("\n");

export const attachmentUndoRecordsMigration: Migration = {
  id: 49,
  name: "attachment_undo_records",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_undo_records (
        generation INTEGER PRIMARY KEY AUTOINCREMENT,
        remover_id TEXT NOT NULL CHECK (length(remover_id) BETWEEN 1 AND 64),
        host_kind TEXT NOT NULL CHECK (length(host_kind) BETWEEN 1 AND 32 AND host_kind NOT GLOB '*[^a-z_]*'),
        host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 64),
        document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 64),
        part_id TEXT CHECK (part_id IS NULL OR length(part_id) <= 64),
        position INTEGER NOT NULL,
        linked_by TEXT CHECK (linked_by IS NULL OR length(linked_by) <= 64),
        linked_at TEXT NOT NULL,
        binned INTEGER NOT NULL DEFAULT 0 CHECK (binned IN (0, 1)),
        expires_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_undo_remover ON attachment_undo_records(remover_id, host_kind, host_id, document_id);
      CREATE INDEX IF NOT EXISTS idx_attachment_undo_link ON attachment_undo_records(host_kind, host_id, document_id);
      CREATE INDEX IF NOT EXISTS idx_attachment_undo_document ON attachment_undo_records(document_id);
      CREATE INDEX IF NOT EXISTS idx_attachment_undo_expiry ON attachment_undo_records(expires_at);
      ${linkTriggers()}
      ${hostTriggers()}
      CREATE TRIGGER IF NOT EXISTS documents_undo_ad AFTER DELETE ON documents
        BEGIN DELETE FROM attachment_undo_records WHERE document_id = lower(OLD.id); END;
      CREATE TRIGGER IF NOT EXISTS users_undo_ad AFTER DELETE ON users
        BEGIN
          DELETE FROM attachment_undo_records WHERE remover_id = OLD.id;
          UPDATE attachment_undo_records SET linked_by = NULL WHERE linked_by = OLD.id;
        END;
    `);
  }
};
