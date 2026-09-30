import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { serviceAccountsMigration } from "../server/migrations/036_service_accounts";

/**
 * Wave 36 review: migration 036 on a database upgraded from 035 with people already in it. It
 * must be the last migration, re-run as a no-op, and leave every person flow (role changes, blocks,
 * sessions, Google identities) working while it refuses the same for an integration.
 */

const TRIGGERS = [
  "users_kind_fixed", "users_service_role_insert", "users_service_role_update", "sessions_person_only", "google_identities_person_only",
  "sessions_person_only_move", "google_identities_person_only_move", "users_retired_final"
];
const at = "2026-09-01T00:00:00.000Z";

/** A database at 035: every migration, then 036 taken back out (its triggers, its column, its row). */
function databaseAt035() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec("ALTER TABLE users DROP COLUMN description");
  db.exec("ALTER TABLE users DROP COLUMN retired_at");
  db.query("DELETE FROM schema_migrations WHERE id = 36").run();
  return db;
}

const person = (db: Database, id: string, role: string) =>
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, ?)").run(id, `${id}@example.test`, id, at, role);
const session = (db: Database, userId: string) =>
  db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 'c', ?, ?, ?)")
    .run(crypto.randomUUID(), userId, crypto.randomUUID(), at, at, "2099-01-01T00:00:00.000Z");
const identity = (db: Database, userId: string) =>
  db.query("INSERT INTO google_identities (id, user_id, subject, email, created_at, last_login_at) VALUES (?, ?, ?, 'g@example.test', ?, ?)")
    .run(crypto.randomUUID(), userId, `sub-${crypto.randomUUID()}`, at, at);

describe("review: migration 036 (service accounts) on an upgraded database", () => {
  test("is the last registered migration and the only one after 035", () => {
    expect(registeredMigrationIds.at(-1)).toBe(36);
    expect(registeredMigrationIds.filter((id) => id > 35)).toEqual([36]);
  });

  test("upgrades a 035 database with people in it, re-runs as a no-op, and leaves person flows alone", () => {
    const db = databaseAt035();
    person(db, "admin1", "admin");
    person(db, "admin2", "admin");
    person(db, "member1", "member");
    person(db, "guest1", "guest");
    session(db, "member1");
    identity(db, "member1");

    runMigrations(db);
    expect(db.query("SELECT id FROM schema_migrations WHERE id = 36").get()).toEqual({ id: 36 });
    expect((db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (SELECT value FROM json_each(?)) ORDER BY name").all(JSON.stringify(TRIGGERS)) as Array<{ name: string }>).map((row) => row.name))
      .toEqual([...TRIGGERS].sort());
    expect(db.query("SELECT COUNT(*) AS count FROM users WHERE kind = 'person' AND description IS NULL AND retired_at IS NULL").get()).toEqual({ count: 4 });
    // Re-running the migration's body changes nothing and throws nothing.
    serviceAccountsMigration.up(db);
    runMigrations(db);

    // Person flows: every role change, block, a same-value kind write, sessions, and Google identities.
    db.query("UPDATE users SET role = 'guest' WHERE id = 'member1'").run();
    db.query("UPDATE users SET role = 'admin' WHERE id = 'guest1'").run();
    db.query("UPDATE users SET role = 'viewer' WHERE id = 'admin2'").run();
    db.query("UPDATE users SET kind = kind, disabled_at = ? WHERE id = 'admin2'").run(at);
    session(db, "admin1");
    identity(db, "admin1");
    expect(db.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 2 });

    // An integration is refused a session, an identity, a role beyond member or viewer, and a kind change.
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES ('bot', 'svc-bot@service.invalid', 'Bot', '!unusable:service', ?, 'viewer', 'service')").run(at);
    expect(() => session(db, "bot")).toThrow("SERVICE_NO_SESSION");
    expect(() => identity(db, "bot")).toThrow("SERVICE_NO_GOOGLE");
    for (const role of ["admin", "guest"]) expect(() => db.query("UPDATE users SET role = ? WHERE id = 'bot'").run(role)).toThrow("SERVICE_ROLE");
    expect(() => db.query("UPDATE users SET kind = 'person' WHERE id = 'bot'").run()).toThrow("KIND_FIXED");
    expect(() => db.query("UPDATE users SET kind = 'service' WHERE id = 'member1'").run()).toThrow("KIND_FIXED");
    expect(() => db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES ('bot2', 'svc-bot2@service.invalid', 'Bot', 'x', ?, 'admin', 'service')").run(at)).toThrow("SERVICE_ROLE");
    db.query("UPDATE users SET role = 'member' WHERE id = 'bot'").run();
    expect(() => db.query("UPDATE users SET description = ? WHERE id = 'bot'").run("x".repeat(201))).toThrow();

    // Fixed (R5): moving an existing session or Google identity onto an integration is refused too,
    // while moving one between people still works.
    expect(() => db.query("UPDATE sessions SET user_id = 'bot' WHERE user_id = 'admin1'").run()).toThrow("SERVICE_NO_SESSION");
    expect(() => db.query("UPDATE google_identities SET user_id = 'bot' WHERE user_id = 'admin1'").run()).toThrow("SERVICE_NO_GOOGLE");
    expect(db.query("UPDATE sessions SET user_id = 'member1' WHERE user_id = 'admin1'").run().changes).toBe(1);

    // A retired integration: only an integration, only a blocked one, and final.
    expect(() => db.query("UPDATE users SET retired_at = ? WHERE id = 'member1'").run(at)).toThrow();
    expect(() => db.query("UPDATE users SET retired_at = ? WHERE id = 'bot'").run(at)).toThrow();
    db.query("UPDATE users SET disabled_at = ?, retired_at = ? WHERE id = 'bot'").run(at, at);
    expect(() => db.query("UPDATE users SET disabled_at = NULL WHERE id = 'bot'").run()).toThrow("RETIRED");
    expect(() => db.query("UPDATE users SET retired_at = NULL WHERE id = 'bot'").run()).toThrow("RETIRED");
    db.query("UPDATE users SET display_name = 'Kept' WHERE id = 'bot'").run();
  });
});
