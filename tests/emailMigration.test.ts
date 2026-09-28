import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import type { Migration } from "../server/migrations/types";

/** Every migration module on disk, by id (the registry tolerates gaps for parallel plans). */
async function migrationsBefore(id: number) {
  const dir = join(import.meta.dir, "..", "server", "migrations");
  const found: Migration[] = [];
  for (const file of readdirSync(dir).filter((name) => /^\d{3}_.*\.ts$/.test(name))) {
    const module = await import(join(dir, file)) as Record<string, unknown>;
    for (const value of Object.values(module)) if (value && typeof value === "object" && "up" in value && "id" in value) found.push(value as Migration);
  }
  return found.filter((migration) => migration.id < id && registeredMigrationIds.includes(migration.id)).sort((a, b) => a.id - b.id);
}

async function before026() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of await migrationsBefore(26)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-09-01T00:00:00.000Z");
  }
  return db;
}

const user = (db: Database, id: string, email: string, role = "member", createdAt = "2026-09-01T00:00:00.000Z") =>
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, ?)").run(id, email, id, createdAt, role);

describe("migration 026_email", () => {
  test("registered as 26 and applied on a fresh database with every table", () => {
    expect(registeredMigrationIds).toContain(26);
    const db = new Database(":memory:", { strict: true });
    runMigrations(db);
    for (const table of ["email_prefs", "mail_outbox", "mail_suppressions", "auth_tokens", "mail_webhook_events", "email_mutes"]) {
      expect({ table, found: Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) }).toEqual({ table, found: true });
    }
    const userColumns = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(userColumns).toContain("email_verified_at");
    const reminderColumns = db.query("PRAGMA table_info(reminders)").all() as Array<{ name: string; dflt_value: string }>;
    expect(reminderColumns.find((column) => column.name === "channels")?.dflt_value).toBe("'push'");
    db.close();
  });

  test("backfill: the bootstrap admin and email-bound invitees are verified, everyone else is not", async () => {
    const db = await before026();
    user(db, "boot", "boot@example.test", "admin", "2026-09-01T00:00:00.000Z");
    user(db, "second-admin", "admin2@example.test", "admin", "2026-08-01T00:00:00.000Z");
    user(db, "bound", "Bound@example.test");
    user(db, "unbound", "unbound@example.test");
    user(db, "open", "open@example.test");
    db.query("INSERT INTO audit_log (id, actor_id, note_id, event_type, metadata_json, created_at) VALUES ('a1', 'boot', NULL, 'team.bootstrap_admin', NULL, '2026-09-01T00:00:00.000Z')").run();
    const invite = (id: string, email: string | null, usedBy: string) => db.query(`INSERT INTO team_invites (id, token_hash, token_prefix, email, role, created_by, created_at, expires_at, used_at, used_by)
      VALUES (?, ?, 'abcdef', ?, 'member', 'boot', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z', '2026-09-02T01:00:00.000Z', ?)`).run(id, id.padEnd(64, "0"), email, usedBy);
    invite("i1", "bound@example.test", "bound");
    invite("i2", null, "unbound");
    runMigrations(db);
    const verified = (db.query("SELECT id FROM users WHERE email_verified_at IS NOT NULL ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    expect(verified).toEqual(["boot", "bound"]);
    db.close();
  });

  test("without a bootstrap audit the oldest admin is verified; constraints hold", async () => {
    const db = await before026();
    user(db, "late", "late@example.test", "admin", "2026-09-05T00:00:00.000Z");
    user(db, "early", "early@example.test", "admin", "2026-09-01T00:00:00.000Z");
    runMigrations(db);
    expect(db.query("SELECT id FROM users WHERE email_verified_at IS NOT NULL").all()).toEqual([{ id: "early" }]);
    const at = "2026-09-28T00:00:00.000Z";
    const outbox = (overrides: Record<string, unknown>) => db.query(`INSERT INTO mail_outbox (id, user_id, to_hash, template, class, payload, idempotency_key, not_before, created_at)
      VALUES ($id, $user_id, $to_hash, $template, $class, $payload, $id, $at, $at)`).run({ id: crypto.randomUUID(), user_id: "early", to_hash: "abcdefabcdef", template: "tasks.assigned", class: "activity", payload: "{}", at, ...overrides } as never);
    outbox({});
    expect(() => outbox({ class: "marketing" })).toThrow();
    expect(() => outbox({ to_hash: "short" })).toThrow();
    expect(() => outbox({ payload: "not json" })).toThrow();
    expect(() => outbox({ user_id: null })).toThrow();
    expect(() => db.query("INSERT INTO email_prefs (user_id, quiet_start, updated_at) VALUES ('early', '22:00', ?)").run(at)).toThrow();
    const reminder = (id: string, channels: string) => db.query("INSERT INTO reminders (id, user_id, title, tz, next_fire_at, created_at, channels) VALUES (?, 'early', 'x', 'UTC', ?, ?, ?)").run(id, at, at, channels);
    reminder("r1", "push_email");
    expect(() => reminder("r2", "sms")).toThrow();
    db.close();
  });
});

describe("migration 028_email_digests", () => {
  test("registered as 28 with the soft-bounce counter and the share log; constraints hold", () => {
    expect(registeredMigrationIds).toContain(28);
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const at = "2026-09-28T00:00:00.000Z";
    user(db, "u1", "u1@example.test");
    db.query("INSERT INTO mail_soft_bounces (address_hash, count, first_at, last_at) VALUES (?, 1, ?, ?)").run("a".repeat(64), at, at);
    expect(() => db.query("INSERT INTO mail_soft_bounces (address_hash, count, first_at, last_at) VALUES ('short', 1, ?, ?)").run(at, at)).toThrow();
    const share = (kind: string, itemId: string) => db.query("INSERT INTO mail_share_log (id, user_id, kind, item_id, actor_id, created_at) VALUES (?, 'u1', ?, ?, NULL, ?)").run(crypto.randomUUID(), kind, itemId, at);
    share("board", "5f0c5a6e-1b2d-4c3e-8f4a-111111111111");
    expect(() => share("secret", "5f0c5a6e-1b2d-4c3e-8f4a-111111111111")).toThrow();
    expect(() => share("note", "x")).toThrow();
    // Deleting the account removes its log rows.
    db.query("DELETE FROM users WHERE id = 'u1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM mail_share_log").get()).toEqual({ count: 0 });
    db.close();
  });
});
