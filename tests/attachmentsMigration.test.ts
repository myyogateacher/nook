import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, registeredMigrations, runMigrations } from "../server/migrations";
import { attachmentsMigration } from "../server/migrations/046_attachments";

/**
 * Migration 046 (uploads everywhere U0): `folders.system_kind`, `attachment_links`, its indexes, the
 * purge triggers, and the system-folder guards. Additive, filesystem-free, idempotent, and it upgrades
 * a v0.34.0 database (every migration through 044) with its rows intact. 045 is reserved for the S3
 * branch and may land after it.
 */

const at = "2026-10-01T00:00:00.000Z";

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** A v0.34.0-shaped database: every registered migration below 045 applied, with a little of everything in it. */
function v034Database() {
  const db = openDb();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of registeredMigrations.filter((item) => item.id <= 44)) {
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    })();
  }
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'a@example.test', 'A', 'x', ?)").run(at);
  db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, created_at, updated_at) VALUES ('f1', 'u1', NULL, 'Default', 1, ?, ?)").run(at, at);
  db.query("INSERT INTO folders (id, owner_id, parent_id, name, visibility, created_at, updated_at) VALUES ('f2', 'u1', NULL, 'Attachments', 'all_users', ?, ?)").run(at, at);
  db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES ('n1', 'u1', 'f1', 'Kept', 1, ?, ?)").run(at, at);
  db.query("INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at) VALUES ('d1', 'u1', 'f2', 'a.txt', 'text/plain', 'text', 1, ?, 'file', ?, ?)").run("0".repeat(64), at, at);
  db.query("INSERT INTO calendars (id, owner_id, name, color, created_at, updated_at) VALUES ('k1', 'u1', 'Cal', 'blue', ?, ?)").run(at, at);
  db.query("INSERT INTO events (id, calendar_id, title, all_day, start_date, end_date, start_utc, created_at, updated_at) VALUES ('e1', 'k1', 'E', 1, '2026-10-01', '2026-10-02', ?, ?, ?)").run(at, at, at);
  return db;
}

const names = (db: Database, type: "table" | "index" | "trigger") => (db.query("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as Array<{ name: string }>).map((row) => row.name);
const TRIGGERS = [
  "chat_messages_attachment_links_ad", "events_attachment_links_ad", "folder_shares_no_system", "folders_system_kind_fixed", "folders_system_no_child_insert", "folders_system_no_child_update",
  "folders_system_unchanged", "group_grants_no_system_folder", "notes_attachment_links_ad", "notes_no_system_folder_insert", "notes_no_system_folder_update", "whiteboards_attachment_links_ad", "whiteboards_no_system_folder"
];

describe("migration 046 attachments", () => {
  test("is registered after 044 (045 is left for the S3 branch) and creates every object", () => {
    expect(registeredMigrationIds).toContain(46);
    expect(registeredMigrationIds).not.toContain(45);
    expect(registeredMigrationIds.indexOf(46)).toBe(registeredMigrationIds.indexOf(44) + 1);
    expect(attachmentsMigration.name).toBe("attachments");
    const db = openDb();
    runMigrations(db);
    expect(names(db, "table")).toContain("attachment_links");
    expect(names(db, "index")).toEqual(expect.arrayContaining(["idx_folders_system_kind", "idx_attachment_links_document", "idx_attachment_links_part"]));
    expect(names(db, "trigger")).toEqual(expect.arrayContaining(TRIGGERS));
    expect((db.query("PRAGMA table_info(folders)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("system_kind");
  });

  test("a v0.34.0 database upgrades in place, keeps every row, and a second run changes nothing", () => {
    const db = v034Database();
    const before = { folders: db.query("SELECT * FROM folders ORDER BY id").all(), documents: db.query("SELECT * FROM documents ORDER BY id").all(), notes: db.query("SELECT * FROM notes ORDER BY id").all() };
    runMigrations(db);
    expect((db.query("SELECT id FROM schema_migrations WHERE id = 46").get())).toEqual({ id: 46 });
    // Every existing folder is ordinary (system_kind NULL), including one that happens to be named "Attachments" and is shared.
    expect(db.query("SELECT id, system_kind FROM folders ORDER BY id").all()).toEqual([{ id: "f1", system_kind: null }, { id: "f2", system_kind: null }]);
    expect((db.query("SELECT * FROM folders ORDER BY id").all() as Array<Record<string, unknown>>).map(({ system_kind: _skip, ...rest }) => rest)).toEqual(before.folders as Array<Record<string, unknown>>);
    expect(db.query("SELECT * FROM documents ORDER BY id").all()).toEqual(before.documents);
    expect(db.query("SELECT * FROM notes ORDER BY id").all()).toEqual(before.notes);
    // The ordinary shared folder keeps working as before.
    db.query("UPDATE folders SET name = 'Renamed', visibility = 'selected' WHERE id = 'f2'").run();
    db.query("INSERT INTO folder_shares (folder_id, user_id, created_at) VALUES ('f2', 'u1', ?)").run(at);

    const schema = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    db.transaction(() => attachmentsMigration.up(db))();
    expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("links: shape checks, one row per (host, document), FK cascade from documents, and the purge triggers", () => {
    const db = v034Database();
    runMigrations(db);
    const insert = db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, part_id, linked_by, created_at) VALUES (?, ?, ?, ?, 'u1', ?)");
    insert.run("event", "e1", "d1", null, at);
    expect(() => insert.run("event", "e1", "d1", null, at)).toThrow();
    expect(() => insert.run("Event", "e2", "d1", null, at)).toThrow();
    expect(() => insert.run("event", "", "d1", null, at)).toThrow();
    expect(() => insert.run("event", "e3", "d1", "x".repeat(65), at)).toThrow();
    expect(() => insert.run("event", "e4", "missing", null, at)).toThrow();
    insert.run("note", "n1", "d1", null, at);
    db.query("DELETE FROM events WHERE id = 'e1'").run();
    expect(db.query("SELECT host_kind FROM attachment_links ORDER BY host_kind").all()).toEqual([{ host_kind: "note" }]);
    db.query("DELETE FROM notes WHERE id = 'n1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links").get()).toEqual({ count: 0 });
    insert.run("event", "e9", "d1", null, at);
    db.query("DELETE FROM documents WHERE id = 'd1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links").get()).toEqual({ count: 0 });
    // One system folder of a kind per person.
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES ('s1', 'u1', NULL, 'Attachments', ?, ?, 'attachments')").run(at, at);
    expect(() => db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES ('s2', 'u1', NULL, 'Attachments', ?, ?, 'attachments')").run(at, at)).toThrow();
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES ('s3', 'u1', NULL, 'Message uploads', ?, ?, 'messages')").run(at, at);
  });
});
