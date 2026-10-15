import type { Migration } from "./types";

/**
 * Files full-text index (lane FTS, approved 2026-10-15): the name and text of Files documents.
 *
 * - `document_search`: one row per indexed document (the mapping, like `whiteboard_search`), with the
 *   `source_sha256` the row was built from. A document whose `sha256` differs, or that has no row, is
 *   waiting for the background indexer (server/documentSearch.ts), which reads text the way
 *   `read_document_text` does. `body_state` says what the body holds: `text` (indexed, capped),
 *   `none` (not a text file, or too large: the name only), or `unreadable` (not UTF-8, or failed
 *   its integrity check: the name only).
 * - `document_fts`: name and body, with the whiteboard tokenizer. Binned documents stay indexed so a
 *   restore needs nothing; queries filter them. A purge cascades the mapping, and a trigger the FTS row.
 *
 * Needs only 006 (documents). Transactional and filesystem-free; the backfill runs after boot.
 */
export const documentFtsMigration: Migration = {
  id: 60,
  name: "document_fts",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_search (
        id            INTEGER PRIMARY KEY,
        document_id   TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
        source_sha256 TEXT NOT NULL,
        body_state    TEXT NOT NULL CHECK (body_state IN ('text', 'none', 'unreadable')),
        indexed_at    TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS document_search_ad AFTER DELETE ON document_search
        BEGIN DELETE FROM document_fts WHERE rowid = old.id; END;
    `);
  }
};
