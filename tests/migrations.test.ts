import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initialMigration } from "../server/migrations/001_initial";
import { folderSharingMigration } from "../server/migrations/002_folder_sharing";
import { totpMigration } from "../server/migrations/003_totp";
import { totpRecoveryCodesMigration } from "../server/migrations/004_totp_recovery_codes";
import { mcpApiKeysMigration } from "../server/migrations/005_mcp_api_keys";
import { documentsMigration } from "../server/migrations/006_documents";
import { binMigration } from "../server/migrations/007_bin";
import { noteSearchMigration } from "../server/migrations/008_note_search";
import { taskBoardsMigration } from "../server/migrations/009_task_boards";
import { mcpKeyScopesMigration } from "../server/migrations/010_mcp_key_scopes";
import { taskDatesMigration } from "../server/migrations/011_task_dates";
import { collectionsMigration } from "../server/migrations/012_collections";
import { calendarMigration } from "../server/migrations/013_calendar";
import { eventNextOccurrenceMigration } from "../server/migrations/014_event_next_occurrence";
import { userPreferencesMigration } from "../server/migrations/016_user_preferences";
import { taskCardUxMigration } from "../server/migrations/015_task_card_ux";
import { taskViewsMigration } from "../server/migrations/020_task_views";
import { registeredMigrationIds, runMigrations } from "../server/migrations";

const legacyMigrations = [initialMigration, folderSharingMigration, totpMigration, totpRecoveryCodesMigration, mcpApiKeysMigration];

/**
 * Every registered migration ran. Reads the registered list so the assertion
 * holds whether or not 023 or 024 are present yet (parallel waves), and pins 1–22.
 */
function expectAllMigrations(ids: number[]) {
  expect(ids).toEqual([...registeredMigrationIds]);
  expect(ids.slice(0, 22)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  expect(ids.slice(22).every((id) => id >= 23)).toBe(true);
}

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("database migrations", () => {
  test("a fresh database contains every registered migration", () => {
    const db = openDb();
    runMigrations(db);
    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    db.close();
  });

  test("a v0.2.2-shaped database upgrades cleanly to the latest migration", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of legacyMigrations) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const timestamp = "2026-01-02T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(timestamp);
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, created_at, updated_at) VALUES ('f1', 'u1', NULL, 'Default', 1, ?, ?)").run(timestamp, timestamp);
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES ('n1', 'u1', 'f1', 'Kept', 1, ?, ?)").run(timestamp, timestamp);
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, created_at, updated_at, deleted_at) VALUES ('n2', 'u1', 'f1', 'Deleted', ?, ?, ?)").run(timestamp, timestamp, timestamp);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(2);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'document%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(["document_shares", "documents"]);

    const insert = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at, deleted_at, purge_after)
      VALUES (?, 'u1', 'f1', 'a.txt', 'text/plain; charset=utf-8', 'text', 1, ?, ?, ?, ?, ?)`);
    insert.run("d1", "a".repeat(64), timestamp, timestamp, null, null);
    expect(() => insert.run("d2", "a".repeat(64), timestamp, timestamp, timestamp, null)).toThrow();
    expect(() => insert.run("d3", "short", timestamp, timestamp, null, null)).toThrow();
    db.query("DELETE FROM folders WHERE id = 'f1'").run();
    expect((db.query("SELECT folder_id FROM documents WHERE id = 'd1'").get() as { folder_id: string | null }).folder_id).toBeNull();
    db.close();
  });

  test("migration 007 backfills legacy soft-deleted notes into the Bin with one timestamp", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, created_at, updated_at) VALUES ('f1', 'u1', NULL, 'Default', 1, ?, ?)").run(old, old);
    const insertNote = db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at, deleted_at) VALUES (?, 'u1', 'f1', ?, ?, ?, ?, ?)");
    insertNote.run("live", "Live", 1, old, old, null);
    insertNote.run("published", "Published", 2, old, old, old);
    insertNote.run("unpublished", "Unpublished", 0, old, old, old);

    const before = Date.now();
    runMigrations(db);
    const after = Date.now();

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    const rows = Object.fromEntries((db.query("SELECT id, deleted_at, deleted_by, purge_after, purge_started_at FROM notes").all() as Array<{
      id: string; deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
    }>).map((row) => [row.id, row]));
    expect(rows.live).toMatchObject({ deleted_at: null, deleted_by: null, purge_after: null, purge_started_at: null });
    expect(rows.published).toMatchObject({ deleted_at: old, deleted_by: "u1", purge_started_at: null });
    expect(rows.unpublished).toMatchObject({ deleted_at: old, deleted_by: "u1", purge_started_at: null });
    const unpublishedDue = Date.parse(rows.unpublished!.purge_after!);
    const publishedDue = Date.parse(rows.published!.purge_after!);
    expect(unpublishedDue).toBeGreaterThanOrEqual(before);
    expect(unpublishedDue).toBeLessThanOrEqual(after);
    // Both rows share the single migration timestamp T.
    expect(publishedDue - unpublishedDue).toBe(30 * 86_400_000);

    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_notes_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_notes_bin", "idx_notes_purge"]));
    db.close();
  });
  test("migration 008 adds the note search tables, and deleting a note cascades to its FTS rows", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration, binMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES ('n1', 'u1', NULL, 'One', 1, ?, ?)").run(old, old);
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES ('n2', 'u1', NULL, 'Two', 1, ?, ?)").run(old, old);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    // Migration 008 is filesystem-free: existing notes are backfilled at boot, not here.
    expect((db.query("SELECT COUNT(*) AS count FROM note_search_rows").get() as { count: number }).count).toBe(0);

    const insertRow = db.query("INSERT INTO note_search_rows (note_id, kind, source_checksum, indexed_at) VALUES (?, ?, ?, ?)");
    const insertFts = db.query("INSERT INTO note_fts (rowid, title, body) VALUES (?, ?, ?)");
    for (const [noteId, kind, text] of [["n1", "published", "Café crème"], ["n1", "draft", "Café draft"], ["n2", "published", "Other words"]] as const) {
      const rowid = Number(insertRow.run(noteId, kind, "a".repeat(64), old).lastInsertRowid);
      insertFts.run(rowid, noteId, text);
    }
    expect(() => insertRow.run("n2", "published", "a".repeat(64), old)).toThrow();
    expect(() => insertRow.run("n2", "draft", "short", old)).toThrow();
    expect(() => insertRow.run("n2", "other", "a".repeat(64), old)).toThrow();
    // remove_diacritics 2 folds accents and case.
    expect((db.query("SELECT COUNT(*) AS count FROM note_fts WHERE note_fts MATCH ?").get('"cafe"') as { count: number }).count).toBe(2);
    expect((db.query("SELECT COUNT(*) AS count FROM note_fts WHERE note_fts MATCH ?").get('"cr"*') as { count: number }).count).toBe(1);

    db.query("DELETE FROM notes WHERE id = 'n1'").run();

    expect((db.query("SELECT COUNT(*) AS count FROM note_search_rows WHERE note_id = 'n1'").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM note_fts").get() as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM note_fts WHERE note_fts MATCH ?").get('"cafe"') as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM note_fts WHERE note_fts MATCH ?").get('"other"') as { count: number }).count).toBe(1);
    db.close();
  });
  test("a v0.5.0-shaped database upgrades cleanly to migration 9 with task tables and documents.purpose", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u2', 'member@example.test', 'Member', 'x', ?)").run(old);
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, created_at, updated_at) VALUES ('f1', 'u1', NULL, 'Default', 1, ?, ?)").run(old, old);
    db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at)
      VALUES ('d1', 'u1', 'f1', 'a.txt', 'text/plain', 'text', 1, ?, ?, ?)`).run("a".repeat(64), old, old);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    // Existing documents are Files items.
    expect((db.query("SELECT purpose FROM documents WHERE id = 'd1'").get() as { purpose: string }).purpose).toBe("file");
    const insertDocument = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at, purpose)
      VALUES (?, 'u1', NULL, 'b.png', 'image/png', 'image', 1, ?, ?, ?, ?)`);
    insertDocument.run("d2", "b".repeat(64), old, old, "task_attachment");
    insertDocument.run("d3", "b".repeat(64), old, old, "collection_attachment");
    expect(() => insertDocument.run("d4", "b".repeat(64), old, old, "system")).toThrow();
    // No system folder for attachments (director review §7).
    const folderColumns = (db.query("PRAGMA table_info(folders)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(folderColumns).not.toContain("system_role");

    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('boards','board_members','board_columns','cards','card_comments','card_attachments') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(["board_columns", "board_members", "boards", "card_attachments", "card_comments", "cards"]);

    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    expect(() => db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b2', 'u1', '', ?, ?)").run(old, old)).toThrow();
    expect(() => db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at, deleted_at) VALUES ('b3', 'u1', 'Half binned', ?, ?, ?)").run(old, old, old)).toThrow();
    db.query("INSERT INTO board_members (board_id, user_id, created_at) VALUES ('b1', 'u2', ?)").run(old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(old, old);
    const insertCard = db.query("INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at, deleted_at, purge_after) VALUES (?, 'b1', ?, 1024, ?, 'u1', ?, ?, ?, ?)");
    insertCard.run("k1", "c1", "First", old, old, null, null);
    // A live card must have a column; a binned one may lose it.
    expect(() => insertCard.run("k2", null, "No column", old, old, null, null)).toThrow();
    insertCard.run("k3", "c1", "Binned", old, old, old, old);
    db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES ('m1', 'k1', 'u2', 'Hi', ?)").run(old);
    expect(() => db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES ('m2', 'k1', 'u2', '', ?)").run(old)).toThrow();
    db.query("INSERT INTO card_attachments (card_id, document_id, comment_id, linked_by, created_at) VALUES ('k1', 'd2', 'm1', 'u2', ?)").run(old);

    expect(() => db.query("DELETE FROM board_columns WHERE id = 'c1'").run()).toThrow();
    db.query("DELETE FROM cards WHERE id = 'k1'").run();
    expect((db.query("SELECT COUNT(*) AS count FROM card_comments").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM card_attachments").get() as { count: number }).count).toBe(0);
    // Unlinking never removes the document itself.
    expect(db.query("SELECT 1 FROM documents WHERE id = 'd2'").get()).toBeTruthy();
    db.query("DELETE FROM board_columns WHERE id = 'c1'").run();
    expect((db.query("SELECT column_id FROM cards WHERE id = 'k3'").get() as { column_id: string | null }).column_id).toBeNull();
    db.query("DELETE FROM boards WHERE id = 'b1'").run();
    expect((db.query("SELECT COUNT(*) AS count FROM cards").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM board_members").get() as { count: number }).count).toBe(0);
    db.close();
  });
  test("migration 010 gives existing MCP keys notes:read and adds draft_mcp_key_id, independently of 009", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at) VALUES ('k1', 'u1', 'Laptop', 'mynotes_abcdefgh', ?, ?)").run("h".repeat(64), old);
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES ('n1', 'u1', NULL, 'One', 1, ?, ?)").run(old, old);

    // 010 applies on an 008-shaped database without 009's tables.
    mcpKeyScopesMigration.up(db);
    expect((db.query("SELECT scopes FROM mcp_api_keys WHERE id = 'k1'").get() as { scopes: string }).scopes).toBe('["notes:read"]');
    expect((db.query("SELECT draft_mcp_key_id FROM notes WHERE id = 'n1'").get() as { draft_mcp_key_id: string | null }).draft_mcp_key_id).toBeNull();
    // Idempotent column adds, then the runner records every pending migration in id order.
    runMigrations(db);
    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);

    expect(() => db.query("UPDATE mcp_api_keys SET scopes = 'not json' WHERE id = 'k1'").run()).toThrow();
    db.query("UPDATE mcp_api_keys SET scopes = ? WHERE id = 'k1'").run(JSON.stringify(["notes:read", "notes:write-draft"]));
    db.query("UPDATE notes SET draft_mcp_key_id = 'k1' WHERE id = 'n1'").run();
    expect(() => db.query("UPDATE notes SET draft_mcp_key_id = 'missing' WHERE id = 'n1'").run()).toThrow();
    db.query("DELETE FROM mcp_api_keys WHERE id = 'k1'").run();
    expect((db.query("SELECT draft_mcp_key_id FROM notes WHERE id = 'n1'").get() as { draft_mcp_key_id: string | null }).draft_mcp_key_id).toBeNull();
    db.close();
  });
  test("a v0.6.0-shaped database upgrades to migration 11 with due dates, assignees, and backfilled done columns", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u2', 'member@example.test', 'Member', 'x', ?)").run(old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    const insertColumn = db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES (?, 'b1', ?, ?, ?, ?)");
    insertColumn.run("c1", "To do", 1024, old, old);
    insertColumn.run("c2", "Done", 2048, old, old);
    insertColumn.run("c3", "done", 3072, old, old);
    insertColumn.run("c4", "Done soon", 4096, old, old);
    insertColumn.run("c5", "DONE", 5120, old, old);
    db.query("INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at) VALUES ('k1', 'b1', 'c1', 1024, 'First', 'u1', ?, ?)").run(old, old);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    const done = Object.fromEntries((db.query("SELECT id, is_done FROM board_columns").all() as Array<{ id: string; is_done: number }>).map((row) => [row.id, row.is_done]));
    expect(done).toEqual({ c1: 0, c2: 1, c3: 1, c4: 0, c5: 1 });
    expect(db.query("SELECT due_on, assignee_id FROM cards WHERE id = 'k1'").get()).toEqual({ due_on: null, assignee_id: null });

    db.query("UPDATE cards SET due_on = '2026-09-30', assignee_id = 'u2' WHERE id = 'k1'").run();
    expect(() => db.query("UPDATE cards SET due_on = '30/09/2026' WHERE id = 'k1'").run()).toThrow();
    expect(() => db.query("UPDATE cards SET due_on = '2026-9-30' WHERE id = 'k1'").run()).toThrow();
    expect(() => db.query("UPDATE cards SET assignee_id = 'missing' WHERE id = 'k1'").run()).toThrow();
    expect(() => db.query("UPDATE board_columns SET is_done = 2 WHERE id = 'c1'").run()).toThrow();
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect((db.query("SELECT assignee_id FROM cards WHERE id = 'k1'").get() as { assignee_id: string | null }).assignee_id).toBeNull();

    // Migration 015 drops idx_cards_assignee: assignees live in card_assignees from then on.
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_cards_due','idx_cards_assignee','idx_cards_creator') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(["idx_cards_creator", "idx_cards_due"]);
    db.close();
  });

  test("migration 012 adds the collection tables with byte caps, Bin checks, and a row FTS cascade", () => {
    const db = openDb();
    runMigrations(db);
    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 12").get() as { name: string }).name).toBe("collections");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'collection%' AND name NOT LIKE 'collection_row_fts_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(["collection_members", "collection_row_attachments", "collection_row_fts", "collection_row_search", "collection_rows", "collection_views", "collections"]);

    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    const insertCollection = db.query("INSERT INTO collections (id, owner_id, name, schema_json, created_at, updated_at, deleted_at, purge_after) VALUES (?, 'u1', ?, ?, ?, ?, ?, ?)");
    insertCollection.run("c1", "Inventory", '{"fields":[]}', old, old, null, null);
    expect(() => insertCollection.run("c2", "", "{}", old, old, null, null)).toThrow();
    expect(() => insertCollection.run("c3", "Bad", "not json", old, old, null, null)).toThrow();
    expect(() => insertCollection.run("c4", "Half binned", "{}", old, old, old, null)).toThrow();
    expect(() => db.query("INSERT INTO collections (id, owner_id, name, schema_json, created_at, updated_at, share_role) VALUES ('c5', 'u1', 'X', '{}', ?, ?, 'admin')").run(old, old)).toThrow();

    const insertRow = db.query("INSERT INTO collection_rows (id, collection_id, position, values_json, created_at, updated_at) VALUES (?, 'c1', 1024, ?, ?, ?)");
    insertRow.run("r1", '{"f_aaaaaaaa":"Mug"}', old, old);
    expect(() => insertRow.run("r2", JSON.stringify({ f_aaaaaaaa: "é".repeat(8200) }), old, old)).toThrow();
    expect(() => insertRow.run("r3", "{", old, old)).toThrow();

    const mapping = Number(db.query("INSERT INTO collection_row_search (row_id, source_revision, schema_version, indexed_at) VALUES ('r1', 1, 1, ?)").run(old).lastInsertRowid);
    db.query("INSERT INTO collection_row_fts (rowid, title, body) VALUES (?, 'Mug', 'Kitchen')").run(mapping);
    expect((db.query("SELECT COUNT(*) AS count FROM collection_row_fts WHERE collection_row_fts MATCH ?").get('"kitchen"') as { count: number }).count).toBe(1);
    db.query("DELETE FROM collections WHERE id = 'c1'").run();
    expect((db.query("SELECT COUNT(*) AS count FROM collection_rows").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM collection_row_search").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM collection_row_fts").get() as { count: number }).count).toBe(0);
    db.close();
  });

  test("migration 015 backfills card_assignees losslessly and enforces the Wave 13 task schema", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const upTo014 = [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration,
      taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration];
    for (const migration of upTo014) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    const insertUser = db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, disabled_at) VALUES (?, ?, ?, 'x', ?, ?)");
    insertUser.run("u1", "owner@example.test", "Owner", old, null);
    insertUser.run("u2", "member@example.test", "Member", old, null);
    insertUser.run("u3", "gone@example.test", "Disabled later", old, old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b2', 'u1', 'Other', ?, ?)").run(old, old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(old, old);
    const insertCard = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at, deleted_at, purge_after, assignee_id, due_on)
      VALUES (?, 'b1', 'c1', ?, ?, 'u1', ?, ?, ?, ?, ?, ?)`);
    insertCard.run("k1", 1024, "Assigned", old, "2025-02-01T00:00:00.000Z", null, null, "u2", "2026-10-01");
    insertCard.run("k2", 2048, "Unassigned", old, old, null, null, null, null);
    insertCard.run("k3", 3072, "Binned and assigned", old, "2025-03-01T00:00:00.000Z", old, old, "u1", null);
    insertCard.run("k4", 4096, "Assigned to a disabled user", old, old, null, null, "u3", null);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 15").get() as { name: string }).name).toBe("task_card_ux");
    // Exactly one row per non-NULL assignee_id, binned cards included; the legacy mirror is unchanged.
    expect(db.query("SELECT card_id, user_id, assigned_by, created_at FROM card_assignees ORDER BY card_id").all()).toEqual([
      { card_id: "k1", user_id: "u2", assigned_by: null, created_at: "2025-02-01T00:00:00.000Z" },
      { card_id: "k3", user_id: "u1", assigned_by: null, created_at: "2025-03-01T00:00:00.000Z" },
      { card_id: "k4", user_id: "u3", assigned_by: null, created_at: old }
    ]);
    expect(db.query("SELECT id, assignee_id FROM cards ORDER BY id").all()).toEqual([
      { id: "k1", assignee_id: "u2" }, { id: "k2", assignee_id: null }, { id: "k3", assignee_id: "u1" }, { id: "k4", assignee_id: "u3" }
    ]);
    expect(db.query("SELECT due_time, due_tz, description_excerpt FROM cards WHERE id = 'k1'").get()).toEqual({ due_time: null, due_tz: null, description_excerpt: "" });
    expect(db.query("SELECT wip_limit FROM board_columns WHERE id = 'c1'").get()).toEqual({ wip_limit: null });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_cards_assignee'").get()).toBeNull();

    // Due time: a time needs a date and a zone, and must be HH:MM up to 23:59 (sibling-column CHECK).
    const setDue = db.query("UPDATE cards SET due_on = ?, due_time = ?, due_tz = ? WHERE id = 'k2'");
    setDue.run("2026-10-01", "17:30", "Europe/Berlin");
    expect(() => setDue.run(null, "17:30", "Europe/Berlin")).toThrow();
    expect(() => setDue.run("2026-10-01", "24:00", "UTC")).toThrow();
    expect(() => setDue.run("2026-10-01", "9:05", "UTC")).toThrow();
    expect(() => setDue.run("2026-10-01", "17:30", null)).toThrow();
    expect(() => setDue.run("2026-10-01", null, "UTC")).toThrow();
    expect(() => setDue.run("2026-10-01", "17:30", "")).toThrow();
    expect(() => db.query("UPDATE cards SET due_on = NULL WHERE id = 'k2'").run()).toThrow();
    setDue.run(null, null, null);
    expect(() => db.query("UPDATE cards SET description_excerpt = ? WHERE id = 'k2'").run("x".repeat(161))).toThrow();
    for (const wip of [0, 1001]) expect(() => db.query("UPDATE board_columns SET wip_limit = ? WHERE id = 'c1'").run(wip)).toThrow();
    db.query("UPDATE board_columns SET wip_limit = 1000 WHERE id = 'c1'").run();
    expect(() => db.query("INSERT INTO card_assignees (card_id, user_id, created_at) VALUES ('k1', 'u2', ?)").run(old)).toThrow();

    // Relations: no self relation, `relates` in canonical order, one relation per unordered pair (expression index).
    const insertRelation = db.query("INSERT INTO card_relations (id, source_card_id, target_card_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, 'u1', ?)");
    expect(() => insertRelation.run("r0", "k1", "k1", "blocks", old)).toThrow();
    expect(() => insertRelation.run("r0", "k2", "k1", "relates", old)).toThrow();
    expect(() => insertRelation.run("r0", "k1", "k2", "parent", old)).toThrow();
    insertRelation.run("r1", "k1", "k2", "relates", old);
    expect(() => insertRelation.run("r2", "k2", "k1", "blocks", old)).toThrow();
    expect(() => insertRelation.run("r2", "k1", "k2", "duplicates", old)).toThrow();
    insertRelation.run("r3", "k2", "k4", "blocks", old);
    insertRelation.run("r4", "k4", "k1", "duplicates", old);

    // Tags and flags.
    const insertTag = db.query("INSERT INTO board_tags (id, board_id, name, color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'u1', ?, ?)");
    insertTag.run("t1", "b1", "Bug", "red", old, old);
    expect(() => insertTag.run("t2", "b1", "bug", "gray", old, old)).toThrow();
    insertTag.run("t3", "b2", "bug", "gray", old, old);
    expect(() => insertTag.run("t4", "b1", "Other", "magenta", old, old)).toThrow();
    expect(() => insertTag.run("t5", "b1", "", "gray", old, old)).toThrow();
    expect(() => insertTag.run("t6", "b1", "x".repeat(41), "gray", old, old)).toThrow();
    db.query("INSERT INTO card_tags (card_id, tag_id, created_at) VALUES ('k1', 't1', ?), ('k2', 't1', ?)").run(old, old);
    const insertFlag = db.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)");
    for (const flag of ["urgent", "blocked", "needs_review", "on_hold"]) insertFlag.run("k1", flag, old);
    expect(() => insertFlag.run("k1", "later", old)).toThrow();
    expect(() => insertFlag.run("k1", "urgent", old)).toThrow();

    const count = (table: string) => (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    // Deleting a tag unlinks it; deleting a user drops their assignments; purging cards and boards cascades.
    db.query("DELETE FROM board_tags WHERE id = 't1'").run();
    expect(count("card_tags")).toBe(0);
    db.query("DELETE FROM users WHERE id = 'u3'").run();
    expect(db.query("SELECT card_id FROM card_assignees WHERE user_id = 'u3'").all()).toEqual([]);
    db.query("DELETE FROM cards WHERE id = 'k1'").run();
    expect(db.query("SELECT id FROM card_relations ORDER BY id").all()).toEqual([{ id: "r3" }]);
    expect(count("card_flags")).toBe(0);
    expect(db.query("SELECT card_id FROM card_assignees ORDER BY card_id").all()).toEqual([{ card_id: "k3" }]);
    db.query("DELETE FROM boards WHERE id = 'b1'").run();
    expect([count("card_assignees"), count("card_relations"), count("card_flags"), count("cards")]).toEqual([0, 0, 0, 0]);
    expect(db.query("SELECT id FROM board_tags").all()).toEqual([{ id: "t3" }]);
    db.close();
  });

  test("migration 016 adds user preferences with defaults, a bounded JSON array CHECK, and a user cascade", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    // A 014-shaped database: every released migration, then 016 on top without a backfill.
    for (const migration of [initialMigration, folderSharingMigration, totpMigration, totpRecoveryCodesMigration, mcpApiKeysMigration, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2026-01-02T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u2', 'other@example.test', 'Other', 'x', ?)").run(old);
    runMigrations(db);
    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 16").get() as { name: string }).name).toBe("user_preferences");
    expect((db.query("SELECT COUNT(*) AS count FROM user_preferences").get() as { count: number }).count).toBe(0);

    db.query("INSERT INTO user_preferences (user_id, updated_at) VALUES ('u1', ?)").run(old);
    expect(db.query("SELECT disabled_modules, revision FROM user_preferences WHERE user_id = 'u1'").get()).toEqual({ disabled_modules: "[]", revision: 1 });
    const insert = db.query("INSERT INTO user_preferences (user_id, disabled_modules, updated_at) VALUES ('u2', ?, ?)");
    expect(() => insert.run("not json", old)).toThrow();
    expect(() => insert.run('{"a":1}', old)).toThrow();
    expect(() => insert.run(JSON.stringify(["x".repeat(520)]), old)).toThrow();
    expect(() => db.query("INSERT INTO user_preferences (user_id, updated_at) VALUES ('missing', ?)").run(old)).toThrow();
    insert.run('["calendar"]', old);
    // 017 makes u1 (the oldest account) the only admin, and the last admin cannot be deleted, so the
    // cascade is checked on the member.
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect((db.query("SELECT user_id FROM user_preferences").all() as Array<{ user_id: string }>).map((row) => row.user_id)).toEqual(["u1"]);
    db.close();
  });

  test("a database that ran 016 before 015 existed still gets 015 (sub-waves merge in any order)", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration,
      taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, userPreferencesMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(old, old);
    db.query("INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at, assignee_id) VALUES ('k1', 'b1', 'c1', 1024, 'A', ?, ?, 'u1')").run(old, old);
    runMigrations(db);
    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect(db.query("SELECT card_id, user_id FROM card_assignees").all()).toEqual([{ card_id: "k1", user_id: "u1" }]);
    db.close();
  });

  test("migration 019 adds the hierarchy and sprint schema on a database that already has 020, with its invariants", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    // 1–16 and 020 applied (17C landed before 17A); 017, 018, and 019 are missing.
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration,
      taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration, taskViewsMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b2', 'u1', 'Other', ?, ?)").run(old, old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(old, old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c2', 'b2', 'To do', 1024, ?, ?)").run(old, old);
    db.query("INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at) VALUES ('k1', 'b1', 'c1', 1024, 'Kept', ?, ?)").run(old, old);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 19").get() as { name: string }).name).toBe("task_hierarchy");
    // No backfill: existing cards are level 0 with no parent, and boards are Flat.
    expect(db.query("SELECT parent_card_id, level, sprint_id, bin_root_id FROM cards WHERE id = 'k1'").get()).toEqual({ parent_card_id: null, level: 0, sprint_id: null, bin_root_id: null });
    expect(JSON.parse((db.query("SELECT structure_json FROM boards WHERE id = 'b1'").get() as { structure_json: string }).structure_json))
      .toEqual({ levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false });
    expect(() => db.query("UPDATE boards SET structure_json = 'not json' WHERE id = 'b1'").run()).toThrow();
    expect(() => db.query("UPDATE boards SET structure_json = '[]' WHERE id = 'b1'").run()).toThrow();
    expect(() => db.query("UPDATE boards SET structure_json = ? WHERE id = 'b1'").run(JSON.stringify({ a: "x".repeat(1100) }))).toThrow();

    const card = db.query("INSERT INTO cards (id, board_id, column_id, position, title, parent_card_id, level, created_at, updated_at) VALUES (?, ?, ?, 2048, ?, ?, ?, ?, ?)");
    expect(() => db.query("UPDATE cards SET level = 3 WHERE id = 'k1'").run()).toThrow();
    // A child sits exactly one level below a parent on the same board.
    card.run("k2", "b1", "c1", "Child", "k1", 1, old, old);
    expect(() => card.run("k3", "b1", "c1", "Skips a level", "k1", 2, old, old)).toThrow("PARENT_INVALID");
    expect(() => card.run("k3", "b1", "c1", "Same level", "k1", 0, old, old)).toThrow("PARENT_INVALID");
    expect(() => card.run("k3", "b2", "c2", "Other board", "k1", 1, old, old)).toThrow("PARENT_INVALID");
    expect(() => card.run("k3", "b1", "c1", "Unknown parent", "nope", 1, old, old)).toThrow("PARENT_INVALID");
    card.run("k3", "b1", "c1", "Grandchild", "k2", 2, old, old);
    expect(() => db.query("UPDATE cards SET parent_card_id = 'k3', level = 1 WHERE id = 'k1'").run()).toThrow();
    expect(() => db.query("UPDATE cards SET parent_card_id = id, level = 1 WHERE id = 'k1'").run()).toThrow();
    // Cards with children keep their level.
    expect(() => db.query("UPDATE cards SET level = 1 WHERE id = 'k1'").run()).toThrow("HAS_CHILDREN");
    // Purging a parent detaches its children (ON DELETE SET NULL); they keep their level.
    db.query("DELETE FROM cards WHERE id = 'k2'").run();
    expect(db.query("SELECT parent_card_id, level FROM cards WHERE id = 'k3'").get()).toEqual({ parent_card_id: null, level: 2 });

    const sprint = db.query(`INSERT INTO board_sprints (id, board_id, name, start_on, end_on, state, position, closed_at, created_at, updated_at)
      VALUES (?, 'b1', ?, ?, ?, ?, 1024, ?, ?, ?)`);
    sprint.run("s1", "Sprint 1", "2026-10-01", "2026-10-14", "active", null, old, old);
    expect(() => sprint.run("s2", "Sprint 2", null, null, "active", null, old, old)).toThrow();
    sprint.run("s2", "Sprint 2", null, null, "planned", null, old, old);
    expect(() => sprint.run("s3", "Backwards", "2026-10-14", "2026-10-01", "planned", null, old, old)).toThrow();
    expect(() => sprint.run("s3", "Bad date", "Oct 1", null, "planned", null, old, old)).toThrow();
    expect(() => sprint.run("s3", "Closed without a time", null, null, "closed", null, old, old)).toThrow();
    expect(() => sprint.run("s3", "", null, null, "planned", null, old, old)).toThrow();
    db.query("UPDATE cards SET sprint_id = 's1' WHERE id = 'k1'").run();
    db.query("DELETE FROM board_sprints WHERE id = 's1'").run();
    expect((db.query("SELECT sprint_id FROM cards WHERE id = 'k1'").get() as { sprint_id: string | null }).sprint_id).toBeNull();
    // Deleting a board removes its sprints.
    db.query("DELETE FROM boards WHERE id = 'b1'").run();
    expect((db.query("SELECT COUNT(*) AS count FROM board_sprints").get() as { count: number }).count).toBe(0);
    db.close();
  });

  test("migration 020 backfills column states and adds task views with CHECKs and cascades on a 016-shaped database", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    // A 016-shaped database (no Team or hierarchy migrations yet): 020 needs only 009, 011, and 015.
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration,
      taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u2', 'member@example.test', 'Member', 'x', ?)").run(old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b2', 'u1', 'Done first', ?, ?)").run(old, old);
    const column = db.query("INSERT INTO board_columns (id, board_id, name, position, is_done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    column.run("c1", "b1", "Backlog", 1024, 0, old, old);
    column.run("c2", "b1", "Doing", 2048, 0, old, old);
    column.run("c3", "b1", "Review", 3072, 0, old, old);
    column.run("c4", "b1", "Shipped", 4096, 1, old, old);
    column.run("c5", "b2", "Done", 512, 1, old, old);
    column.run("c6", "b2", "Later", 1024, 0, old, old);
    // Two columns tied at the lowest position (only a hand-edited or pre-rebalance board has this).
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b3', 'u1', 'Tied', ?, ?)").run(old, old);
    column.run("t1", "b3", "Inbox", 1024, 0, old, old);
    column.run("t2", "b3", "Triage", 1024, 0, old, old);
    column.run("t3", "b3", "Next", 2048, 0, old, old);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect(ids).toContain(20);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 20").get() as { name: string }).name).toBe("task_views");
    // Done columns are done; otherwise the first column is todo and the rest doing. A board whose first column is done has no todo.
    expect(db.query("SELECT id, state FROM board_columns ORDER BY id").all()).toEqual([
      { id: "c1", state: "todo" }, { id: "c2", state: "doing" }, { id: "c3", state: "doing" }, { id: "c4", state: "done" },
      { id: "c5", state: "done" }, { id: "c6", state: "doing" },
      // Ties at the lowest position all become todo. Harmless by design (not reconciled at boot or in a new
      // migration): state only labels the column for filters and views, is_done is untouched so Today and the
      // done counts stay right (T121), and the board owner fixes it with PATCH /api/tasks/columns/:c { state }.
      { id: "t1", state: "todo" }, { id: "t2", state: "todo" }, { id: "t3", state: "doing" }
    ]);
    expect((db.query("SELECT COUNT(*) AS count FROM board_columns WHERE (state = 'done') <> (is_done = 1)").get() as { count: number }).count).toBe(0);
    expect(() => db.query("UPDATE board_columns SET state = 'later' WHERE id = 'c1'").run()).toThrow();
    // A column inserted without a state (older code) is doing.
    column.run("c7", "b1", "Extra", 5120, 0, old, old);
    expect((db.query("SELECT state FROM board_columns WHERE id = 'c7'").get() as { state: string }).state).toBe("doing");

    const view = db.query(`INSERT INTO task_views (id, owner_id, name, query, display_json, visibility, position, created_at, updated_at)
      VALUES (?, 'u1', ?, ?, ?, ?, 1024, ?, ?)`);
    view.run("v1", "Mine", "assignee:me", '{"layout":"list"}', "private", old, old);
    expect(db.query("SELECT revision, visibility FROM task_views WHERE id = 'v1'").get()).toEqual({ revision: 1, visibility: "private" });
    expect(() => view.run("v2", "", "q", "{}", "private", old, old)).toThrow();
    expect(() => view.run("v2", "x".repeat(81), "q", "{}", "private", old, old)).toThrow();
    expect(() => view.run("v2", "Long", "x".repeat(2001), "{}", "private", old, old)).toThrow();
    expect(() => view.run("v2", "Bad JSON", "q", "not json", "private", old, old)).toThrow();
    expect(() => view.run("v2", "Array", "q", "[]", "private", old, old)).toThrow();
    expect(() => view.run("v2", "Big", "q", JSON.stringify({ a: "x".repeat(2050) }), "private", old, old)).toThrow();
    expect(() => view.run("v2", "Public", "q", "{}", "public", old, old)).toThrow();
    view.run("v2", "Shared", "state:todo", "{}", "selected", old, old);
    db.query("INSERT INTO task_view_members (view_id, user_id, created_at) VALUES ('v2', 'u2', ?)").run(old);
    expect(() => db.query("INSERT INTO task_view_members (view_id, user_id, created_at) VALUES ('v2', 'missing', ?)").run(old)).toThrow();
    db.query(`INSERT INTO task_views (id, owner_id, name, query, display_json, position, created_at, updated_at)
      VALUES ('v3', 'u2', 'Member view', '', '{}', 1024, ?, ?)`).run(old, old);
    // Deleting a user removes their memberships and their own views (u1 is the last admin since 017, so u2 goes).
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect((db.query("SELECT COUNT(*) AS count FROM task_view_members").get() as { count: number }).count).toBe(0);
    expect(db.query("SELECT id FROM task_views ORDER BY id").all()).toEqual([{ id: "v1" }, { id: "v2" }]);
    db.query("DELETE FROM task_views WHERE id = 'v2'").run();
    db.close();
  });

  test("migration 021 adds the inbox tables and notification columns and backfills MCP drafts as proposals", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    // A v0.9.3-shaped database without 017–020: 021 needs only 005, 010, 013, and 016.
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration,
      taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, created_at, updated_at) VALUES ('f1', 'u1', NULL, 'Default', 1, ?, ?)").run(old, old);
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at) VALUES ('k1', 'u1', 'laptop', 'mynotes_abc', 'h1', '[\"notes:write-draft\"]', ?)").run(old);
    const note = db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, draft_revision, draft_checksum, draft_mcp_key_id, created_at, updated_at, deleted_at, purge_after) VALUES (?, 'u1', 'f1', ?, ?, ?, 'c', ?, ?, ?, ?, ?)");
    note.run("n1", "Agent draft", 1, 3, "k1", old, old, null, null);
    note.run("n2", "Agent new note", 0, 1, "k1", old, old, null, null);
    note.run("n3", "Human draft", 1, 2, null, old, old, null, null);
    note.run("n4", "Binned agent draft", 1, 2, "k1", old, old, old, "2025-02-01T00:00:00.000Z");
    db.query("INSERT INTO notifications (id, user_id, created_at) VALUES ('old', 'u1', ?)").run(old);

    runMigrations(db);

    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 21").get() as { name: string }).name).toBe("agent_inbox");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('proposals','routines','routine_runs') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(["proposals", "routine_runs", "routines"]);
    // Existing notifications are reminders.
    expect(db.query("SELECT kind, proposal_count FROM notifications WHERE id = 'old'").get()).toEqual({ kind: "reminder", proposal_count: null });

    // Live MCP drafts only, with one timestamp and a 14-day expiry.
    const backfilled = db.query("SELECT target_id, kind, target_type, status, key_id, key_name, title, payload, created_at, expires_at FROM proposals ORDER BY target_id").all() as Array<Record<string, string>>;
    expect(backfilled.map((row) => row.target_id)).toEqual(["n1", "n2"]);
    expect(backfilled.every((row) => row.kind === "note_draft" && row.target_type === "note" && row.status === "pending" && row.key_id === "k1" && row.key_name === "laptop")).toBe(true);
    expect(JSON.parse(backfilled[0]!.payload!)).toEqual({ noteId: "n1", revision: 3, created: false });
    expect(JSON.parse(backfilled[1]!.payload!)).toEqual({ noteId: "n2", revision: 1, created: true });
    expect(backfilled[0]!.created_at).toBe(backfilled[1]!.created_at!);
    expect(Date.parse(backfilled[0]!.expires_at!) - Date.parse(backfilled[0]!.created_at!)).toBe(14 * 86_400_000);

    // CHECKs refuse bad kinds, statuses, sizes, and JSON.
    const insert = db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, status, created_at, expires_at)
      VALUES (?, 'u1', 'k1', 'laptop', ?, ?, 'x', ?, ?, ?, ?, ?)`);
    insert.run("p1", "card_create", "board", "Add a card", "{}", "pending", old, old);
    expect(() => insert.run("p2", "card_delete", "board", "Delete", "{}", "pending", old, old)).toThrow();
    expect(() => insert.run("p2", "card_create", "board", "Add", "{}", "approved", old, old)).toThrow();
    expect(() => insert.run("p2", "card_create", "user", "Add", "{}", "pending", old, old)).toThrow();
    expect(() => insert.run("p2", "card_create", "board", "", "{}", "pending", old, old)).toThrow();
    expect(() => insert.run("p2", "card_create", "board", "x".repeat(121), "{}", "pending", old, old)).toThrow();
    expect(() => insert.run("p2", "card_create", "board", "Add", "not json", "pending", old, old)).toThrow();
    expect(() => insert.run("p2", "card_create", "board", "Add", JSON.stringify({ a: "x".repeat(65_536) }), "pending", old, old)).toThrow();
    expect(() => db.query("UPDATE proposals SET reject_reason = ? WHERE id = 'p1'").run("x".repeat(201))).toThrow();
    expect(() => db.query("INSERT INTO notifications (id, user_id, created_at, kind) VALUES ('n', 'u1', ?, 'mail')").run(old)).toThrow();

    // One running run per routine.
    db.query(`INSERT INTO routines (id, owner_id, name, name_fold, instructions, output_kinds, cadence, tz, created_at, updated_at)
      VALUES ('r1', 'u1', 'Weekly', 'weekly', 'Do it', '["card_create"]', 'weekly', 'UTC', ?, ?)`).run(old, old);
    const run = db.query("INSERT INTO routine_runs (id, routine_id, owner_id, status, started_at, lease_expires_at) VALUES (?, 'r1', 'u1', ?, ?, ?)");
    run.run("run1", "running", old, old);
    expect(() => run.run("run2", "running", old, old)).toThrow();
    run.run("run2", "succeeded", old, old);
    expect(() => db.query(`INSERT INTO routines (id, owner_id, name, name_fold, instructions, output_kinds, cadence, tz, created_at, updated_at)
      VALUES ('r2', 'u1', 'WEEKLY', 'weekly', 'x', '[]', 'weekly', 'UTC', ?, ?)`).run(old, old)).toThrow();
    // Deleting a key keeps its proposals (key_name stays); deleting the owner removes them.
    db.query("DELETE FROM mcp_api_keys WHERE id = 'k1'").run();
    expect(db.query("SELECT key_id, key_name FROM proposals WHERE id = 'p1'").get()).toEqual({ key_id: null, key_name: "laptop" });
    db.close();
  });

  test("migration 022 adds reactions with shape CHECKs, one row per user × target × emoji, and cleanup on every comment delete path", () => {
    // A 016-shaped database: 022 needs only 001 (users) and 009 (card_comments), not 017–021.
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of [...legacyMigrations, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration,
      taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration]) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    runMigrations(db);
    const ids = (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expectAllMigrations(ids);
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 22").get() as { name: string }).name).toBe("reactions");

    const old = "2025-01-01T00:00:00.000Z";
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'owner@example.test', 'Owner', 'x', ?)").run(old);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u2', 'member@example.test', 'Member', 'x', ?)").run(old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Plan', ?, ?)").run(old, old);
    db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b2', 'u1', 'Other', ?, ?)").run(old, old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(old, old);
    db.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c2', 'b2', 'To do', 1024, ?, ?)").run(old, old);
    const card = db.query("INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at) VALUES (?, ?, ?, 1024, 'Card', 'u1', ?, ?)");
    card.run("k1", "b1", "c1", old, old);
    card.run("k2", "b1", "c1", old, old);
    card.run("k3", "b2", "c2", old, old);
    const ids36 = Array.from({ length: 4 }, () => crypto.randomUUID());
    const [m1, m2, m3, m4] = ids36 as [string, string, string, string];
    const comment = db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES (?, ?, 'u1', 'Hi', ?)");
    comment.run(m1, "k1", old);
    comment.run(m2, "k1", old);
    comment.run(m3, "k2", old);
    comment.run(m4, "k3", old);
    const react = db.query("INSERT INTO reactions (target_kind, target_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)");
    const count = () => (db.query("SELECT COUNT(*) AS count FROM reactions").get() as { count: number }).count;
    for (const id of ids36) { react.run("card_comment", id, "u1", "thumbs_up", old); react.run("card_comment", id, "u2", "heart", old); }
    expect(count()).toBe(8);
    // The primary key refuses a duplicate; another emoji or another user is a new row.
    expect(() => react.run("card_comment", m1, "u1", "thumbs_up", old)).toThrow();
    react.run("card_comment", m1, "u1", "tada", old);
    expect(count()).toBe(9);
    // Shape CHECKs: keys only, never glyphs, capitals, or spaces; a 36-character target id.
    for (const [kind, target, emoji] of [["card_comment", m1, "👍"], ["card_comment", m1, "Thumbs"], ["card_comment", m1, "thumbs up"], ["card_comment", m1, ""],
      ["card_comment", m1, "x".repeat(25)], ["Card", m1, "heart"], ["", m1, "heart"], ["card-comment", m1, "heart"], ["card_comment", "short", "heart"]] as const) {
      expect(() => react.run(kind, target, "u1", emoji, old)).toThrow();
    }
    expect(() => react.run("card_comment", m1, "missing", "eyes", old)).toThrow();
    // Another kind's row with the same id is not touched by the card comment trigger.
    react.run("message", m1, "u1", "heart", old);
    // A direct comment delete removes its reactions only.
    db.query("DELETE FROM card_comments WHERE id = ?").run(m2);
    expect(db.query("SELECT COUNT(*) AS count FROM reactions WHERE target_id = ?").get(m2)).toEqual({ count: 0 });
    expect(count()).toBe(8);
    // A card purge cascades to its comments, and the trigger fires for the cascade.
    db.query("DELETE FROM cards WHERE id = 'k2'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM reactions WHERE target_id = ?").get(m3)).toEqual({ count: 0 });
    // A board purge cascades through cards and comments too.
    db.query("DELETE FROM boards WHERE id = 'b2'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM reactions WHERE target_id = ?").get(m4)).toEqual({ count: 0 });
    // Deleting a user removes their reactions (u1 is the last admin since 017, so u2 goes).
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(db.query("SELECT target_kind, target_id, user_id, emoji FROM reactions ORDER BY target_kind, emoji").all()).toEqual([
      { target_kind: "card_comment", target_id: m1, user_id: "u1", emoji: "tada" },
      { target_kind: "card_comment", target_id: m1, user_id: "u1", emoji: "thumbs_up" },
      { target_kind: "message", target_id: m1, user_id: "u1", emoji: "heart" }
    ]);
    db.close();
  });

  test("migration 027 adds the pre-agent draft base to proposals; existing rows keep an unknown base", () => {
    const db = openDb();
    runMigrations(db);
    const columns = (db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["base_state", "base_draft_revision", "base_draft_markdown", "base_draft_key_id"]));
    expect((db.query("SELECT name FROM schema_migrations WHERE id = 27").get() as { name: string }).name).toBe("proposal_base");
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'o@example.test', 'Owner', 'x', '2026-01-01')").run();
    const insert = (id: string, state: string | null) => db.query(`INSERT INTO proposals (id, owner_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at, base_state)
      VALUES (?, 'u1', 'k', 'note_draft', 'note', 'n', 'T', '{}', '2026-01-01', '2026-02-01', ?)`).run(id, state);
    insert("p1", null);
    insert("p2", "draft");
    expect(() => insert("p3", "weird")).toThrow();
    db.close();
  });
});
