import { db, now } from "./db";
import { cleanIndexText, searchText } from "./search";
import { checksum, storage, withNoteLock } from "./storage";
import { neutralizeWhiteboardEmbeds } from "../shared/whiteboardEmbed";

/**
 * Note search index sync (docs/plan/WAVES_7-9.md §2.2, D30–D34).
 *
 * Each note has at most two rows: the published version and the owner's
 * draft. Both write helpers are plain statements meant to run inside the
 * caller's transaction, next to the notes UPDATE they mirror. The index is
 * built from version files and draft.md after their checksums were verified,
 * never from the current.md mirror.
 */
export type SearchKind = "published" | "draft";

const deleteRow = db.query("DELETE FROM note_search_rows WHERE note_id = ? AND kind = ?");
const insertRow = db.query("INSERT INTO note_search_rows (note_id, kind, source_checksum, indexed_at) VALUES (?, ?, ?, ?)");
const insertFts = db.query("INSERT INTO note_fts (rowid, title, body) VALUES (?, ?, ?)");

/** Removes a note's row of one kind. The AFTER DELETE trigger removes its FTS row. */
export function unindexNote(noteId: string, kind: SearchKind) {
  deleteRow.run(noteId, kind);
}

/**
 * Replaces a note's row of one kind. `sourceChecksum` is the checksum of
 * `markdown` as recorded in the database. A note whose text projects to
 * nothing (an empty draft) is unindexed instead. Returns whether a row was written.
 */
export function indexNote(noteId: string, kind: SearchKind, title: string, markdown: string, sourceChecksum: string) {
  deleteRow.run(noteId, kind);
  // A board name in an older card's link text is not searchable by the note's readers (QA H1).
  const text = searchText(neutralizeWhiteboardEmbeds(markdown));
  if (text === "") return false;
  const indexedTitle = cleanIndexText(title);
  // The title is usually the first line; keep it out of the body so snippets do not repeat it.
  const [firstLine, ...rest] = text.split("\n");
  const body = firstLine === indexedTitle ? rest.join("\n") : text;
  const rowid = Number(insertRow.run(noteId, kind, sourceChecksum, now()).lastInsertRowid);
  insertFts.run(rowid, indexedTitle, body);
  return true;
}

type ExpectedRow = { noteId: string; kind: SearchKind; checksum: string };
export type SearchReconcileCounts = { indexed: number; removed: number; unreadable: number };

/** Every row the index should hold, with the checksum it should have been built from. Purging notes are skipped. */
function expectedRows() {
  const published = db.query(`
    SELECT n.id AS noteId, 'published' AS kind, v.checksum
    FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version
    WHERE n.current_version > 0 AND n.purge_started_at IS NULL
  `).all() as ExpectedRow[];
  const drafts = db.query(`
    SELECT id AS noteId, 'draft' AS kind, draft_checksum AS checksum
    FROM notes WHERE draft_revision IS NOT NULL AND draft_checksum IS NOT NULL AND purge_started_at IS NULL
  `).all() as ExpectedRow[];
  return [...published, ...drafts];
}

/** The checksum and title a row should be built from now, or null when no row is expected. */
function currentSource(noteId: string, kind: SearchKind) {
  if (kind === "published") {
    return db.query(`
      SELECT v.checksum, v.title, n.current_version AS version FROM notes n
      JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version
      WHERE n.id = ? AND n.current_version > 0 AND n.purge_started_at IS NULL
    `).get(noteId) as { checksum: string; title: string; version: number } | null;
  }
  return db.query(`
    SELECT draft_checksum AS checksum, title, 0 AS version FROM notes
    WHERE id = ? AND draft_revision IS NOT NULL AND draft_checksum IS NOT NULL AND purge_started_at IS NULL
  `).get(noteId) as { checksum: string; title: string; version: number } | null;
}

/**
 * Boot reconcile: backfills an index created by migration 008, repairs rows
 * that are missing or stale (their source_checksum no longer matches the
 * database), removes orphans, and optimizes the FTS table. Binned notes stay
 * indexed so a restore finds them again. Each note is handled under its lock.
 * Logs counts only.
 */
export async function reconcileSearchIndex(): Promise<SearchReconcileCounts> {
  const counts: SearchReconcileCounts = { indexed: 0, removed: 0, unreadable: 0 };

  const total = () => (db.query("SELECT COUNT(*) AS count FROM note_search_rows").get() as { count: number }).count
    + (db.query("SELECT COUNT(*) AS count FROM note_fts WHERE rowid NOT IN (SELECT id FROM note_search_rows)").get() as { count: number }).count;
  const before = total();
  db.transaction(() => {
    // FTS rows without a mapping row, and mapping rows without an FTS row (rebuilt below).
    db.query("DELETE FROM note_fts WHERE rowid NOT IN (SELECT id FROM note_search_rows)").run();
    db.query("DELETE FROM note_search_rows WHERE id NOT IN (SELECT rowid FROM note_fts)").run();
    // Rows whose source no longer exists: no published version, no draft, or a purge in progress.
    db.query(`
      DELETE FROM note_search_rows WHERE id IN (
        SELECT r.id FROM note_search_rows r JOIN notes n ON n.id = r.note_id
        WHERE n.purge_started_at IS NOT NULL
           OR (r.kind = 'published' AND n.current_version = 0)
           OR (r.kind = 'draft' AND (n.draft_revision IS NULL OR n.draft_checksum IS NULL))
      )
    `).run();
  })();
  counts.removed = before - total();

  const indexed = new Map((db.query("SELECT note_id, kind, source_checksum FROM note_search_rows").all() as Array<{ note_id: string; kind: SearchKind; source_checksum: string }>)
    .map((row) => [`${row.note_id}:${row.kind}`, row.source_checksum]));

  for (const expected of expectedRows()) {
    if (indexed.get(`${expected.noteId}:${expected.kind}`) === expected.checksum) continue;
    try {
      await withNoteLock(expected.noteId, async () => {
        const source = currentSource(expected.noteId, expected.kind);
        if (!source) return;
        const markdown = expected.kind === "published"
          ? await storage.readVersion(expected.noteId, source.version)
          : await storage.readDraft(expected.noteId);
        if (checksum(markdown) !== source.checksum) {
          counts.unreadable += 1;
          db.transaction(() => unindexNote(expected.noteId, expected.kind))();
          return;
        }
        db.transaction(() => {
          const recheck = currentSource(expected.noteId, expected.kind);
          if (recheck?.checksum !== source.checksum) return;
          if (indexNote(expected.noteId, expected.kind, source.title, markdown, source.checksum)) counts.indexed += 1;
        })();
      });
    } catch {
      counts.unreadable += 1;
    }
  }

  db.query("INSERT INTO note_fts (note_fts) VALUES ('optimize')").run();
  if (counts.indexed || counts.removed || counts.unreadable) {
    console.info(`Search index: ${counts.indexed} indexed, ${counts.removed} removed, ${counts.unreadable} unreadable`);
  }
  return counts;
}
