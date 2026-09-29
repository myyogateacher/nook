import type { Migration } from "./types";

/**
 * Whiteboards stored as Files documents (Wave 23, docs/plan/research/2026-09-28-whiteboard-module.md
 * §6, D192–D193, D204, D207). The plan reserved `023_whiteboards`; that id was taken, so this is 030.
 *
 * - `whiteboards` marks a `documents` row (purpose 'file') as a board and holds its revision, the
 *   current scene object (copy-on-write, D193), counts, and the owner's thumbnail (D200).
 * - `whiteboard_snapshots` is used from Wave 24 (D207); it is created now so 030 is the only
 *   whiteboard migration.
 * - `whiteboard_search` and `whiteboard_fts` index board names and text (D204), the Collections pattern.
 *
 * Needs only 006 (documents). Transactional and filesystem-free.
 */
export const whiteboardsMigration: Migration = {
  id: 30,
  name: "whiteboards",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whiteboards (
        document_id    TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        format         TEXT NOT NULL DEFAULT 'excalidraw' CHECK (format IN ('excalidraw')),
        revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        object_id      TEXT NOT NULL UNIQUE,
        element_count  INTEGER NOT NULL DEFAULT 0 CHECK (element_count BETWEEN 0 AND 5000),
        text_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (text_bytes >= 0),
        thumb_png      BLOB CHECK (thumb_png IS NULL OR length(thumb_png) <= 131072),
        thumb_revision INTEGER,
        thumb_sha256   TEXT CHECK (thumb_sha256 IS NULL OR length(thumb_sha256) = 64),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS whiteboard_snapshots (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision    INTEGER NOT NULL,
        object_id   TEXT NOT NULL UNIQUE,
        size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
        created_at  TEXT NOT NULL,
        UNIQUE (document_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_whiteboard_snapshots_doc ON whiteboard_snapshots(document_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS whiteboard_search (
        id            INTEGER PRIMARY KEY,
        document_id   TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
        source_sha256 TEXT NOT NULL,
        indexed_at    TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS whiteboard_fts USING fts5(title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS whiteboard_search_ad AFTER DELETE ON whiteboard_search
        BEGIN DELETE FROM whiteboard_fts WHERE rowid = old.id; END;
    `);
  }
};
