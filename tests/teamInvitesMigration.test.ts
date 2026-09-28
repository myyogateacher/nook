import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
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
import { taskCardUxMigration } from "../server/migrations/015_task_card_ux";
import { userPreferencesMigration } from "../server/migrations/016_user_preferences";
import { teamRolesMigration } from "../server/migrations/017_team_roles";
import { taskHierarchyMigration } from "../server/migrations/019_task_hierarchy";
import { taskViewsMigration } from "../server/migrations/020_task_views";

/** The v0.9.3 schema: 1–17, 19, and 20 (018 was reserved and not shipped). */
const v093 = [initialMigration, folderSharingMigration, totpMigration, totpRecoveryCodesMigration, mcpApiKeysMigration, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration, taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration, teamRolesMigration, taskHierarchyMigration, taskViewsMigration];

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function v093Db() {
  const db = openDb();
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of v093) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-09-01T00:00:00.000Z");
  }
  return db;
}

const ids = (db: Database) => (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);

function insertInvite(db: Database, overrides: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    token_hash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"),
    token_prefix: "abcdef",
    email: null,
    role: "viewer",
    note: null,
    created_by: "admin",
    created_at: "2026-09-28T10:00:00.000Z",
    expires_at: "2026-10-05T10:00:00.000Z",
    ...overrides
  };
  db.query(`INSERT INTO team_invites (id, token_hash, token_prefix, email, role, note, created_by, created_at, expires_at)
    VALUES ($id, $token_hash, $token_prefix, $email, $role, $note, $created_by, $created_at, $expires_at)`).run(row as never);
  return row.id;
}

describe("migration 018_team_invites", () => {
  test("a fresh database registers 1–20 in order", () => {
    const db = openDb();
    runMigrations(db);
    expect(ids(db)).toEqual([...registeredMigrationIds]);
    expect(ids(db).slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_invites'").get()).toBeTruthy();
    db.close();
  });

  test("a v0.9.3 database (17, 19, 20 applied) gets 018 afterwards and keeps its data", () => {
    const db = v093Db();
    expect(ids(db)).not.toContain(18);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('admin', 'admin@example.test', 'Admin', 'x', '2026-09-01T00:00:00.000Z', 'admin')").run();
    runMigrations(db);
    expect(ids(db)).toContain(18);
    expect(ids(db).slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(ids(db)).toEqual([...registeredMigrationIds]);
    expect((db.query("SELECT role FROM users WHERE id = 'admin'").get() as { role: string }).role).toBe("admin");
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'team_invites' AND name LIKE 'idx_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(["idx_team_invites_created", "idx_team_invites_live", "idx_team_invites_used_by"]);
    // Re-running is a no-op.
    runMigrations(db);
    db.close();
  });

  test("CHECKs refuse an admin role, a >7-day or non-positive expiry, bad hashes, and used-and-revoked rows", () => {
    const db = openDb();
    runMigrations(db);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('admin', 'admin@example.test', 'Admin', 'x', '2026-09-01T00:00:00.000Z', 'admin')").run();
    for (const role of ["member", "viewer", "guest"]) expect(() => insertInvite(db, { role })).not.toThrow();
    expect(() => insertInvite(db, { role: "admin" })).toThrow();
    expect(() => insertInvite(db, { role: "owner" })).toThrow();
    // Exactly 7 days is allowed; 8 days, zero, and negative are refused.
    expect(() => insertInvite(db, { expires_at: "2026-10-05T10:00:00.000Z" })).not.toThrow();
    expect(() => insertInvite(db, { expires_at: "2026-10-06T10:00:00.000Z" })).toThrow();
    expect(() => insertInvite(db, { expires_at: "2026-10-05T10:30:00.000Z" })).toThrow();
    expect(() => insertInvite(db, { expires_at: "2026-09-28T10:00:00.000Z" })).toThrow();
    expect(() => insertInvite(db, { expires_at: "2026-09-27T10:00:00.000Z" })).toThrow();
    expect(() => insertInvite(db, { token_hash: "short" })).toThrow();
    expect(() => insertInvite(db, { token_prefix: "abc" })).toThrow();
    expect(() => insertInvite(db, { note: "x".repeat(81) })).toThrow();
    const hash = "b".repeat(64);
    insertInvite(db, { token_hash: hash });
    expect(() => insertInvite(db, { token_hash: hash })).toThrow();

    const id = insertInvite(db);
    db.query("UPDATE team_invites SET used_at = '2026-09-29T00:00:00.000Z', used_by = 'admin' WHERE id = ?").run(id);
    expect(() => db.query("UPDATE team_invites SET revoked_at = '2026-09-29T00:00:00.000Z' WHERE id = ?").run(id)).toThrow();
    const other = insertInvite(db);
    expect(() => db.query("UPDATE team_invites SET used_by = 'admin' WHERE id = ?").run(other)).toThrow();
    db.close();
  });

  test("an email binding compares case-insensitively, and deleting an account keeps its invites", () => {
    const db = openDb();
    runMigrations(db);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('admin', 'admin@example.test', 'Admin', 'x', '2026-09-01T00:00:00.000Z', 'admin')").run();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('admin2', 'admin2@example.test', 'Admin 2', 'x', '2026-09-01T00:00:00.000Z', 'admin')").run();
    const id = insertInvite(db, { email: "Invitee@Example.test", created_by: "admin2" });
    expect(db.query("SELECT id FROM team_invites WHERE email = 'invitee@example.test'").get()).toEqual({ id });
    db.query("DELETE FROM users WHERE id = 'admin2'").run();
    expect(db.query("SELECT created_by FROM team_invites WHERE id = ?").get(id)).toEqual({ created_by: null });
    db.close();
  });
});
