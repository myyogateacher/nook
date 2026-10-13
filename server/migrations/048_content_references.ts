import type { Migration } from "./types";

/**
 * v0.35.0 review L2: an index of the document ids that stored content references, so the orphan
 * sweep (server/attachments/sweep.ts) stops re-reading every note draft, note version, and whiteboard
 * object (an S3 GET each, with S3 storage) on every run.
 *
 * - `content_reference_sources`: one row per immutable piece of content that has been scanned, keyed
 *   by what identifies its bytes: `draft:<noteId>:<draftChecksum>`, `version:<noteId>:<number>`, or
 *   `object:<whiteboardObjectId>` (a board's scene or snapshot; every save writes a new object).
 * - `content_references`: the lower-case UUIDs each source contains.
 *
 * Draft saves, publishes, and board saves record their own content as they commit; the sweep scans
 * only sources it has not seen (older content, anything a writer did not record) and drops sources
 * that no longer exist. A cache only: rebuilding it from nothing is always safe, so this migration
 * creates empty tables and touches no other table. Transactional and filesystem-free; a second run
 * changes nothing.
 */
export const contentReferencesMigration: Migration = {
  id: 48,
  name: "content_references",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_reference_sources (
        source TEXT PRIMARY KEY CHECK (length(source) <= 200),
        scanned_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS content_references (
        source TEXT NOT NULL REFERENCES content_reference_sources(source) ON DELETE CASCADE,
        document_id TEXT NOT NULL CHECK (length(document_id) = 36),
        PRIMARY KEY (source, document_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS content_references_document ON content_references(document_id);
    `);
  }
};
