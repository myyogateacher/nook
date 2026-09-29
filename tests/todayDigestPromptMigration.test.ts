import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { todayDigestPromptMigration } from "../server/migrations/035_today_digest_prompt";

/** Migration 035 (C4, D248): `email_prefs.digest_prompt_at`, empty for every existing row. */

describe("migration 035 (today digest prompt)", () => {
  test("is registered after 029 (030–034 belong to parallel waves)", () => {
    expect(registeredMigrationIds).toContain(35);
    expect(registeredMigrationIds.indexOf(35)).toBeGreaterThan(registeredMigrationIds.indexOf(29));
  });

  test("adds a nullable column, keeps existing prefs rows as they were, and re-runs as a no-op", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const columns = () => (db.query("PRAGMA table_info(email_prefs)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
    expect(columns().find((column) => column.name === "digest_prompt_at")).toMatchObject({ notnull: 0, dflt_value: null });
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?, 'member')").run("2026-09-01T00:00:00.000Z");
    db.query("INSERT INTO email_prefs (user_id, digest, updated_at) VALUES ('u1', 'daily', ?)").run("2026-09-02T00:00:00.000Z");
    todayDigestPromptMigration.up(db);
    expect(columns().filter((column) => column.name === "digest_prompt_at")).toHaveLength(1);
    expect(db.query("SELECT digest, digest_prompt_at FROM email_prefs WHERE user_id = 'u1'").get()).toEqual({ digest: "daily", digest_prompt_at: null });
  });
});
