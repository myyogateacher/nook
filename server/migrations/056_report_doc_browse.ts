import { addColumn, type Migration } from "./types";

/**
 * Reports: the AI may browse docs (B3) and Nook as a built-in doc source (B4).
 *
 * - `reports.doc_browse_tools`: a JSON array of the doc server's read-only tools the person ticked
 *   ("Tools the AI may use to read more docs"); the generation and edit agents may call them during a
 *   run. Empty by default (only the main doc is read).
 * - `reports.doc_source`: `server` (the doc is read through `doc_server_id`, an admin's tool server) or
 *   `nook` (Nook's own notes and Files, read with the owner's access; `doc_server_id` stays NULL, since
 *   the built-in source is not a row in `agent_tool_servers`).
 * - `report_doc_pages`: a snapshot of each linked page an agent read during a run (owner-only, like the
 *   doc's snapshots): the source (`server_id`: a tool server's id or `nook`), the tool and its
 *   arguments (JSON and their SHA-256), the page's title, SHA-256, size, and markdown (at most 512 KiB).
 *   "Check doc" reads each page again and records what it found in `checked_sha256` / `checked_at`;
 *   a difference is "Doc changed" naming the page. A page belongs to its run (deleted with it).
 *
 * 054 stays reserved for the Messages module. Needs 050 and 052. Transactional and filesystem-free;
 * re-running changes nothing.
 */
export const reportDocBrowseMigration: Migration = {
  id: 56,
  name: "report_doc_browse",
  up(db) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    addColumn(db, "reports", "doc_browse_tools", "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(doc_browse_tools) AND json_type(doc_browse_tools) = 'array' AND length(doc_browse_tools) <= 4096)");
    addColumn(db, "reports", "doc_source", "TEXT NOT NULL DEFAULT 'server' CHECK (doc_source IN ('server','nook'))");
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_doc_pages (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL CHECK (length(server_id) BETWEEN 1 AND 64),
        tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 128),
        args_json TEXT NOT NULL CHECK (json_valid(args_json) AND length(args_json) <= 4096),
        args_sha256 TEXT NOT NULL CHECK (length(args_sha256) = 64),
        title TEXT CHECK (title IS NULL OR length(title) <= 500),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        fetched_at TEXT NOT NULL,
        markdown TEXT NOT NULL CHECK (length(CAST(markdown AS BLOB)) <= 524288),
        checked_sha256 TEXT CHECK (checked_sha256 IS NULL OR length(checked_sha256) = 64),
        checked_at TEXT,
        UNIQUE (run_id, server_id, tool, args_sha256)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_doc_pages_report ON report_doc_pages(report_id, run_id);
    `);
  }
};
