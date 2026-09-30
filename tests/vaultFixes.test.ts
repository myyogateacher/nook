import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits } from "./support/vault";

const { sweepVaultEvents, VAULT_EVENT_RETENTION_DAYS } = await import("../server/vault/service");
const { VAULT_BOUNDS } = await import("../shared/vault");

/** Wave 25 review fixes L4 (comment reads), L5 (bounds count the Bin; event retention). */

beforeEach(() => resetVaultLimits());

const events = (vaultId: string, event: string) =>
  (db.query("SELECT COUNT(*) AS count FROM vault_events WHERE vault_id = ? AND event = ?").get(vaultId, event) as { count: number }).count;
const readBucket = (userId: string) =>
  (db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`read:${userId}`) as { count: number } | null)?.count ?? 0;

describe("secret comments are reads (L4)", () => {
  test("opening a comment is audited comment.read and charged; no comment, create, and update are not", async () => {
    const owner = await createUser("Fix comment owner");
    const vault = await newVault(owner);
    const withComment = await newSecret(owner, vault, "WITH_COMMENT", {}, { comment: "rotate monthly" });
    const without = await newSecret(owner, vault, "NO_COMMENT");
    expect(events(vault.id, "comment.read")).toBe(0);
    expect(readBucket(owner.userId)).toBe(0);

    const read = await call(owner, "GET", `/vaults/${vault.id}/secrets/${withComment.id}`);
    expect(read.body.secret.comment).toBe("rotate monthly");
    expect(events(vault.id, "comment.read")).toBe(1);
    expect(readBucket(owner.userId)).toBe(1);
    const row = db.query("SELECT secret_id, count, actor_id FROM vault_events WHERE vault_id = ? AND event = 'comment.read'").get(vault.id);
    expect(row).toEqual({ secret_id: withComment.id, count: 1, actor_id: owner.userId });

    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${without.id}`)).status).toBe(200);
    const updated = await call(owner, "PATCH", `/vaults/${vault.id}/secrets/${withComment.id}`, { comment: "rotate weekly", expectedRevision: withComment.revision });
    expect(updated.body.secret.comment).toBe("rotate weekly");
    expect(events(vault.id, "comment.read")).toBe(1);
    expect(readBucket(owner.userId)).toBe(1);

    // Rate-limited like a value read.
    db.query("INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 300, 0) ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 300")
      .run(`read:${owner.userId}`, Math.floor(Date.now() / 600_000) * 600_000);
    const limited = await call(owner, "GET", `/vaults/${vault.id}/secrets/${withComment.id}`);
    expect(limited.status).toBe(429);
    expect(limited.text).not.toContain("rotate weekly");
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${without.id}`)).status).toBe(200);
  });
});

describe("bounds count the Bin (L5)", () => {
  test("binned vaults count toward 100 owned vaults, and binned secrets toward 1,000 per vault", async () => {
    const owner = await createUser("Fix bounds owner");
    const vault = await newVault(owner);
    const timestamp = new Date().toISOString();
    const fillers: string[] = [];
    for (let index = 1; index < VAULT_BOUNDS.ownedVaults; index += 1) {
      const id = crypto.randomUUID();
      fillers.push(id);
      db.query("INSERT INTO vaults (id, owner_id, name, description, current_generation, revision, created_at, updated_at, deleted_at, deleted_by, purge_after) VALUES (?, ?, ?, '', 1, 1, ?, ?, ?, ?, ?)")
        .run(id, owner.userId, `Binned ${index}`, timestamp, timestamp, timestamp, owner.userId, "2099-01-01T00:00:00.000Z");
    }
    try {
      const refused = await call(owner, "POST", "/vaults", { name: "One too many" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("LIMIT_REACHED");
    } finally {
      db.query("DELETE FROM vaults WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(fillers));
    }

    const binned = await newSecret(owner, vault, "BINNED_ONE");
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${binned.id}`)).status).toBe(200);
    const insert = db.query("INSERT INTO vault_secrets (id, vault_id, name, type, tags, revision, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, 'value', '[]', 1, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let index = 1; index < VAULT_BOUNDS.secretsPerVault; index += 1) insert.run(crypto.randomUUID(), vault.id, `FILL_${index}`, owner.userId, timestamp, owner.userId, timestamp);
    })();
    const full = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "ONE_TOO_MANY" });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("LIMIT_REACHED");
    db.query("DELETE FROM vault_secrets WHERE vault_id = ? AND name LIKE 'FILL_%'").run(vault.id);
    expect((await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "FITS_NOW" })).status).toBe(201);
  });
});

describe("vault_events retention (L5)", () => {
  test("the sweep removes rows past 90 days; newer rows stay append-only, even for the sweep", async () => {
    const owner = await createUser("Fix retention owner");
    const vault = await newVault(owner);
    const nowMs = Date.now();
    const insert = db.query("INSERT INTO vault_events (id, vault_id, actor_id, key_id, via, event, secret_id, env_id, count, created_at) VALUES (?, ?, NULL, NULL, 'session', 'test.fill', NULL, NULL, NULL, ?)");
    const old = new Date(nowMs - (VAULT_EVENT_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const recent = new Date(nowMs - (VAULT_EVENT_RETENTION_DAYS - 1) * 86_400_000).toISOString();
    const recentId = crypto.randomUUID();
    db.transaction(() => {
      for (let index = 0; index < 3; index += 1) insert.run(crypto.randomUUID(), vault.id, old);
      insert.run(recentId, vault.id, recent);
    })();
    expect(sweepVaultEvents(nowMs)).toBe(3);
    expect(events(vault.id, "test.fill")).toBe(1);
    expect(events(vault.id, "vault.create")).toBe(1);
    // 031's trigger still refuses deleting a row younger than 90 days, and a sweep "from the future"
    // never asks it to.
    expect(() => db.query("DELETE FROM vault_events WHERE id = ?").run(recentId)).toThrow("APPEND_ONLY");
    expect(sweepVaultEvents(nowMs + 30 * 86_400_000)).toBe(0);
    expect(events(vault.id, "test.fill")).toBe(1);
  });
});
