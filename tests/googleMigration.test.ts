import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { isUsablePasswordHash, UNUSABLE_PASSWORD, verifyPassword } from "../server/passwords";

const columns = (db: Database, table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

describe("migration 034 google_identities (Wave 35)", () => {
  test("a fresh database gets the identity and flow tables, the avatar pointer, and the re-auth stamp", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    expect(registeredMigrationIds).toContain(34);
    expect(columns(db, "google_identities")).toEqual(["id", "user_id", "subject", "email", "picture_url", "created_at", "last_login_at"]);
    expect(columns(db, "google_auth_flows")).toEqual(expect.arrayContaining(["session_id", "client_hash"]));
    expect(columns(db, "users")).toEqual(expect.arrayContaining(["avatar_id", "google_link_allowed_until", "google_relink_remove_credentials", "google_last_refusal_at", "google_last_refusal_reason"]));
    expect(columns(db, "sessions")).toContain("reauth_at");
    const at = new Date().toISOString();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'a@nook.test', 'A', ?, ?)").run(UNUSABLE_PASSWORD, at);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u2', 'b@nook.test', 'B', ?, ?)").run(UNUSABLE_PASSWORD, at);
    db.query("INSERT INTO google_identities (id, user_id, subject, email, created_at, last_login_at) VALUES ('g1', 'u1', 'sub-1', 'a@nook.test', ?, ?)").run(at, at);
    // One account per sub and one identity per account.
    expect(() => db.query("INSERT INTO google_identities (id, user_id, subject, email, created_at, last_login_at) VALUES ('g2', 'u2', 'sub-1', 'b@nook.test', ?, ?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO google_identities (id, user_id, subject, email, created_at, last_login_at) VALUES ('g3', 'u1', 'sub-3', 'a@nook.test', ?, ?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO google_auth_flows (id, state_hash, nonce, code_verifier, intent, return_to, created_at, expires_at) VALUES ('f', 's', 'n', 'v', 'other', '/', ?, ?)").run(at, at)).toThrow();
    // Deleting the account removes its identity.
    db.query("DELETE FROM users WHERE id = 'u1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM google_identities").get()).toEqual({ count: 0 });
  });

  test("an existing database at the current schema gains 034 and keeps its rows", () => {
    const db = new Database(":memory:", { strict: true });
    runMigrations(db);
    // Back to the schema before 034 (what an upgrading install has).
    db.exec(`DELETE FROM schema_migrations WHERE id = 34; DROP TABLE google_identities; DROP TABLE google_auth_flows;
      ALTER TABLE users DROP COLUMN avatar_id; ALTER TABLE users DROP COLUMN google_link_allowed_until; ALTER TABLE users DROP COLUMN google_reset_notice_at; ALTER TABLE users DROP COLUMN google_reset_notice_json; ALTER TABLE sessions DROP COLUMN reauth_at;`);
    const at = new Date().toISOString();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'a@nook.test', 'A', '$argon2id$v=19$m=4096,t=2,p=1$x$y', ?)").run(at);
    db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES ('s1', 'u1', 'h', 'c', ?, ?, ?)").run(at, at, at);
    runMigrations(db);
    expect(db.query("SELECT id FROM schema_migrations WHERE id = 34").get()).toEqual({ id: 34 });
    expect(db.query("SELECT avatar_id, google_link_allowed_until FROM users WHERE id = 'u1'").get()).toEqual({ avatar_id: null, google_link_allowed_until: null });
    expect(db.query("SELECT reauth_at FROM sessions WHERE id = 's1'").get()).toEqual({ reauth_at: null });
    // Running again changes nothing.
    runMigrations(db);
    expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 34").get()).toEqual({ count: 1 });
  });
});

describe("the unusable password sentinel (D294)", () => {
  test("never verifies, and never reaches Bun.password.verify (which throws on it)", async () => {
    expect(isUsablePasswordHash(UNUSABLE_PASSWORD)).toBe(false);
    expect(isUsablePasswordHash("!anything")).toBe(false);
    expect(isUsablePasswordHash("")).toBe(false);
    for (const attempt of ["", "unusable:google", UNUSABLE_PASSWORD, "!unusable:google", "correct horse battery staple"]) {
      expect(await verifyPassword(attempt, UNUSABLE_PASSWORD)).toBe(false);
    }
    expect(await Bun.password.verify("x", UNUSABLE_PASSWORD).then(() => "resolved", () => "threw")).toBe("threw");
    const hash = await Bun.password.hash("correct horse battery staple", { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 });
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword(undefined, hash)).toBe(false);
  });
});
