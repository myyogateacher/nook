import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, dataDir, db, origin } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits } from "./support/vault";

const { requireEnvGrant, requireVault, vaultGrant } = await import("../server/vault/access");
const { openValue, rotateKek, verifyKeys } = await import("../server/vault/crypto");
const { chargeVault, VAULT_LIMITS } = await import("../server/vault/limits");
const { config, parseVaultKey } = await import("../server/config");
const { createApiKey } = await import("../server/apiKeys");
const { GENERAL_KEY_MODULES, permissionsForModule } = await import("../server/keyGrants");
const { copySecret } = await import("../src/vault/reveal");

/**
 * Independent review probes for Wave 25 (Vault A). The two review findings (the grant minters and
 * the clipboard clear) were `test.failing` probes and are ordinary tests since their fixes.
 */

beforeEach(() => resetVaultLimits());

const valueRow = (secretId: string, envId: string) =>
  db.query("SELECT value_ct, comment_ct FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secretId, envId) as { value_ct: string; comment_ct: string | null };

describe("AAD binding beyond the implementer's swaps (T189)", () => {
  test("value <-> its comment, a comment from another environment, a secret comment from another secret, and a replayed history row all fail closed", async () => {
    const owner = await createUser("Review swap owner");
    const vault = await newVault(owner);
    const [dev, prod] = [vault.envs.dev!, vault.envs.prod!];
    const a = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "RV_A", comment: "a-secret-comment", values: { [dev]: { value: "a-dev", comment: "a-dev-comment" }, [prod]: { value: "a-prod", comment: "a-prod-comment" } } });
    const b = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "RV_B", comment: "b-secret-comment" });
    const aId = a.body.secret.id as string;
    const bId = b.body.secret.id as string;
    const readDev = () => call(owner, "GET", `/vaults/${vault.id}/secrets/${aId}/values/${dev}`);
    const original = valueRow(aId, dev);

    // Value and comment swapped in one row (same ids and version, different field).
    db.query("UPDATE vault_values SET value_ct = ?, comment_ct = ? WHERE secret_id = ? AND env_id = ?").run(original.comment_ct, original.value_ct, aId, dev);
    let read = await readDev();
    expect(read.body.code).toBe("VAULT_INTEGRITY");
    expect(read.text).not.toContain("a-dev");

    // Prod's value comment under dev (the value itself intact).
    db.query("UPDATE vault_values SET value_ct = ?, comment_ct = ? WHERE secret_id = ? AND env_id = ?").run(original.value_ct, valueRow(aId, prod).comment_ct, aId, dev);
    read = await readDev();
    expect(read.body.code).toBe("VAULT_INTEGRITY");
    expect(read.text).not.toContain("a-prod-comment");
    db.query("UPDATE vault_values SET comment_ct = ? WHERE secret_id = ? AND env_id = ?").run(original.comment_ct, aId, dev);
    expect((await readDev()).body.value).toMatchObject({ value: "a-dev", comment: "a-dev-comment" });

    // A's secret comment copied onto B.
    const aSecret = db.query("SELECT comment_ct, comment_generation FROM vault_secrets WHERE id = ?").get(aId) as { comment_ct: string; comment_generation: number };
    db.query("UPDATE vault_secrets SET comment_ct = ?, comment_generation = ? WHERE id = ?").run(aSecret.comment_ct, aSecret.comment_generation, bId);
    const bRead = await call(owner, "GET", `/vaults/${vault.id}/secrets/${bId}`);
    expect(bRead.body.code).toBe("VAULT_INTEGRITY");
    expect(bRead.text).not.toContain("a-secret-comment");

    // History: version 1's ciphertext replayed as version 2 in vault_value_versions.
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${aId}/values/${dev}`, { value: "a-dev-2", expectedVersion: 1 })).status).toBe(200);
    const v1 = db.query("SELECT value_ct FROM vault_value_versions WHERE secret_id = ? AND env_id = ? AND version = 1").get(aId, dev) as { value_ct: string };
    db.query("UPDATE vault_value_versions SET value_ct = ?, comment_ct = NULL WHERE secret_id = ? AND env_id = ? AND version = 2").run(v1.value_ct, aId, dev);
    const replay = await call(owner, "GET", `/vaults/${vault.id}/secrets/${aId}/values/${dev}/versions/2`);
    expect(replay.body.code).toBe("VAULT_INTEGRITY");
    // Restoring the tampered version writes nothing.
    const restore = await call(owner, "POST", `/vaults/${vault.id}/secrets/${aId}/values/${dev}/versions/2/restore`, { expectedVersion: 2 });
    expect(restore.body.code).toBe("VAULT_INTEGRITY");
    expect((db.query("SELECT version FROM vault_values WHERE secret_id = ? AND env_id = ?").get(aId, dev) as { version: number }).version).toBe(2);
  });
});

describe("the grant brand (D213)", () => {
  // Fixed (review L1): requireEnvGrant/vaultGrant accept only a VaultAccess that vaultAccess() made.
  test("a hand-made VaultAccess cannot mint a grant", async () => {
    const owner = await createUser("Review brand owner");
    const stranger = await createUser("Review brand stranger");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "BRAND", { dev: "brand-value" });
    const dev = vault.envs.dev!;
    const forged = {
      actor: { kind: "session" as const, userId: stranger.userId },
      vault: { id: vault.id } as never,
      role: "owner" as const,
      environments: [{ id: dev } as never],
      levels: new Map([[dev, "admin" as const]])
    };
    let grant: ReturnType<typeof requireEnvGrant> | null = null;
    try {
      grant = requireEnvGrant(forged, dev, "read");
    } catch {
      grant = null;
    }
    const stored = db.query("SELECT value_ct, comment_ct, generation, version FROM vault_values WHERE secret_id = ?").get(secret.id) as { value_ct: string; comment_ct: string | null; generation: number; version: number };
    const opened = grant ? openValue(grant, { secretId: secret.id, envId: dev, version: stored.version, generation: stored.generation, valueCt: stored.value_ct, commentCt: stored.comment_ct }).value : null;
    expect(opened).toBeNull();
    expect(() => vaultGrant(forged, "read")).toThrow("Vault access refused");
    // A copy of a real access (or one with a field swapped) is not the checked object either.
    const real = requireVault({ kind: "session", userId: owner.userId }, vault.id);
    expect(requireEnvGrant(real, dev, "read").vaultId).toBe(vault.id);
    expect(() => requireEnvGrant({ ...real, actor: { kind: "session", userId: stranger.userId } }, dev, "read")).toThrow("Vault access refused");
    expect(() => vaultGrant({ ...real }, "read")).toThrow("Vault access refused");
    expect(Object.isFrozen(real)).toBe(true);
  });
});

describe("CAS and history (D224)", () => {
  test("20 versions kept with the oldest evicted; restore writes a new version; clear is a version; apply-to-others is all-or-nothing", async () => {
    const owner = await createUser("Review history owner");
    const vault = await newVault(owner);
    const [dev, staging] = [vault.envs.dev!, vault.envs.staging!];
    const secret = await newSecret(owner, vault, "HIST");
    const path = `/vaults/${vault.id}/secrets/${secret.id}/values/${dev}`;
    expect((await call(owner, "PUT", path, { value: "h1", expectedVersion: 0 })).body.value.version).toBe(1);
    expect((await call(owner, "PUT", path, { value: "stale", expectedVersion: 0 }))).toMatchObject({ status: 409, body: { code: "VALUE_CHANGED", currentVersion: 1 } });
    for (let version = 2; version <= 25; version += 1) expect((await call(owner, "PUT", path, { value: `h${version}`, expectedVersion: version - 1 })).status).toBe(200);
    let versions = (await call(owner, "GET", `${path}/versions`)).body.versions as Array<{ version: number }>;
    expect(versions.length).toBe(20);
    expect(versions[0]!.version).toBe(25);
    expect(versions[19]!.version).toBe(6);
    expect((await call(owner, "GET", `${path}/versions/5`)).status).toBe(404);
    expect((await call(owner, "GET", `${path}/versions/6`)).body.version.value).toBe("h6");

    const restored = await call(owner, "POST", `${path}/versions/6/restore`, { expectedVersion: 25 });
    expect(restored.body.value.version).toBe(26);
    expect((await call(owner, "GET", path)).body.value.value).toBe("h6");
    expect((await call(owner, "POST", `${path}/versions/7/restore`, { expectedVersion: 25 })).body.code).toBe("VALUE_CHANGED");
    versions = (await call(owner, "GET", `${path}/versions`)).body.versions;
    expect(versions.length).toBe(20);
    expect(versions[19]!.version).toBe(7);

    expect((await call(owner, "DELETE", `${path}?expectedVersion=25`)).body.code).toBe("VALUE_CHANGED");
    expect((await call(owner, "DELETE", `${path}?expectedVersion=26`)).body).toMatchObject({ ok: true, version: 27 });
    expect((await call(owner, "GET", path)).body.code).toBe("VALUE_NOT_SET");
    expect((await call(owner, "POST", `${path}/versions/27/restore`, { expectedVersion: 27 })).body.code).toBe("VERSION_CLEARED");
    expect((await call(owner, "PUT", path, { value: "after-clear", expectedVersion: 26 })).body.code).toBe("VALUE_CHANGED");
    expect((await call(owner, "PUT", path, { value: "after-clear", expectedVersion: 27 })).body.value.version).toBe(28);

    // Apply to other environments: one bad CAS refuses the whole batch.
    const batch = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values`, { values: [{ envId: dev, value: "batch-dev", expectedVersion: 28 }, { envId: staging, value: "batch-staging", expectedVersion: 3 }] });
    expect(batch.body.code).toBe("VALUE_CHANGED");
    expect((await call(owner, "GET", path)).body.value).toMatchObject({ value: "after-clear", version: 28 });
    expect(db.query("SELECT 1 FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secret.id, staging)).toBeNull();
    const tooMany = Array.from({ length: 21 }, () => ({ envId: dev, value: "x", expectedVersion: 28 }));
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values`, { values: tooMany })).status).toBe(400);
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values`, { values: [{ envId: dev, value: "a", expectedVersion: 28 }, { envId: dev, value: "b", expectedVersion: 28 }] })).status).toBe(400);
  });
});

describe("limits (T194, T195)", () => {
  test("reveal batches over 100 are refused; a 64 KiB + 1 byte value is refused; 300 reads per 10 minutes then 429 with Retry-After", async () => {
    const owner = await createUser("Review limits owner");
    const vault = await newVault(owner);
    const dev = vault.envs.dev!;
    const secret = await newSecret(owner, vault, "LIM", { dev: "lim" });
    const cell = { secretId: secret.id, envId: dev };
    expect((await call(owner, "POST", `/vaults/${vault.id}/reveal`, { cells: Array.from({ length: 101 }, () => cell) })).status).toBe(400);
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${dev}`, { value: "é".repeat(32_768) + "a", expectedVersion: 1 })).status).toBe(413);
    // QA Q6: over 65,536 characters is over 64 KiB too, and the same 413 TOO_LARGE.
    const chars = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${dev}`, { value: "a".repeat(65_537), expectedVersion: 1 });
    expect(chars.status).toBe(413);
    expect(chars.body.code).toBe("TOO_LARGE");
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${dev}`, { value: "ok", comment: "c".repeat(2049), expectedVersion: 1 })).body.code).toBe("TOO_LARGE");
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${dev}`, { value: "a".repeat(65_536), expectedVersion: 1 })).status).toBe(200);
    for (let batch = 0; batch < 3; batch += 1) expect((await call(owner, "POST", `/vaults/${vault.id}/reveal`, { cells: Array.from({ length: 100 }, () => cell) })).status).toBe(200);
    const limited = await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${dev}`);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.text).not.toContain("lim\"");
  });

  test("the sliding window: the previous window still counts by its overlap, and two windows later it is gone", () => {
    const subject = `review-${crypto.randomUUID()}`;
    const { windowMs, limit } = VAULT_LIMITS.read;
    const start = Math.floor(Date.now() / windowMs) * windowMs;
    chargeVault("read", subject, limit, start + 1);
    expect(() => chargeVault("read", subject, 1, start + 2)).toThrow("Too many");
    // Early in the next window almost the whole previous window still overlaps.
    expect(() => chargeVault("read", subject, 1, start + windowMs + 1000)).toThrow("Too many");
    // Half-way through the next window, half the previous one counts: 150 left.
    chargeVault("read", subject, 149, start + windowMs + windowMs / 2);
    expect(() => chargeVault("read", subject, 2, start + windowMs + windowMs / 2)).toThrow("Too many");
    chargeVault("read", subject, limit - 1, start + 3 * windowMs);
    db.query("DELETE FROM vault_rate_limits WHERE bucket = ?").run(`read:${subject}`);
  });
});

describe("no vault surface for keys in Wave 25 (D221)", () => {
  test("a general key holding every grant lists no vault tool over MCP or REST v1, and cannot hold a vault grant", async () => {
    const member = await createUser("Review keys member");
    const grants = GENERAL_KEY_MODULES.flatMap((module) => permissionsForModule(module).map((permission) => ({ module, permission, resourceKind: null, resourceId: null })));
    const key = createApiKey(member.userId, { name: "Everything", surfaces: "both", grants, expiresInDays: 30 });
    const mcp = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const text = await mcp.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    const names = ((JSON.parse(json) as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => /vault|secret/i.test(name))).toEqual([]);
    const rest = await fetch(`${origin}/api/v1/tools`, { headers: { Authorization: `Bearer ${key.token}` } });
    expect(rest.status).toBe(200);
    expect((await rest.text()).toLowerCase()).not.toContain("vault");
    expect(() => createApiKey(member.userId, { name: "Vault", surfaces: "both", grants: [{ module: "vault", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 })).toThrow();
    // No /api/v1/vault route exists; a session cookie there is not a key either.
    expect((await fetch(`${origin}/api/v1/vault/vaults`, { headers: { Authorization: `Bearer ${key.token}` } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("the Bin (T193, T196)", () => {
  test("names show to the owner only; another member and an admin cannot see, restore, or purge; a purge shreds keys and grants and leaves no ciphertext in the file", async () => {
    const owner = await createUser("Review bin owner");
    const other = await createUser("Review bin other");
    const vault = await newVault(owner, "Review Bin Vault Name");
    const secret = await newSecret(owner, vault, "REVIEW_BINNED_SECRET", { dev: "review-binned-value" });
    const ct = valueRow(secret.id, vault.envs.dev!).value_ct;
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}`)).status).toBe(200);
    const bin = (session: typeof owner) => fetch(`${origin}/api/bin`, { headers: { Cookie: session.cookie } }).then((response) => response.text());
    expect(await bin(owner)).toContain("REVIEW_BINNED_SECRET");
    expect(await bin(other)).not.toContain("REVIEW_BINNED_SECRET");
    const binCall = (session: typeof owner, path: string) => fetch(`${origin}/api/bin/${path}`, { method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    expect((await binCall(other, `vault_secret/${secret.id}/restore`)).status).toBe(404);

    expect((await call(owner, "DELETE", `/vaults/${vault.id}`)).status).toBe(200);
    expect(await bin(other)).not.toContain("Review Bin Vault Name");
    expect((await binCall(other, `vault/${vault.id}/restore`)).status).toBe(404);
    const purgeAs = (session: typeof owner) => fetch(`${origin}/api/bin/vault/${vault.id}`, { method: "DELETE", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    expect((await purgeAs(other)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM vault_keys WHERE vault_id = ?").get(vault.id)).toEqual({ count: 1 });

    // A vault key's grant naming this vault (025's table) goes with the purge.
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, kind) VALUES (?, ?, 'CI', 'nkv_review', ?, ?, 'vault')").run(crypto.randomUUID(), owner.userId, crypto.randomUUID(), new Date().toISOString());
    const keyId = (db.query("SELECT id FROM mcp_api_keys WHERE key_prefix = 'nkv_review' AND user_id = ?").get(owner.userId) as { id: string }).id;
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at) VALUES (?, ?, 'vault', 'read', 'vault', ?, NULL, ?)").run(crypto.randomUUID(), keyId, vault.id, new Date().toISOString());

    expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
    const purged = await purgeAs(owner);
    expect(purged.status).toBeLessThan(300);
    for (const table of ["vault_keys", "vault_secrets", "vault_environments", "vault_events", "vault_members"]) {
      expect({ table, count: (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE vault_id = ?`).get(vault.id) as { count: number }).count }).toEqual({ table, count: 0 });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = ?").get(keyId)).toEqual({ count: 0 });
    db.query("DELETE FROM mcp_api_keys WHERE id = ?").run(keyId);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const needle = Buffer.from(ct.split(":")[3]!.slice(0, 32));
    for (const path of [config.databasePath, `${config.databasePath}-wal`]) {
      if (!existsSync(path)) continue;
      expect({ path: path.split("/").pop(), found: readFileSync(path).includes(needle) }).toEqual({ path: path.split("/").pop(), found: false });
    }
  });
});

describe("keys and rotation (T199)", () => {
  test("a key file reached through a symlink into DATA_DIR is refused", () => {
    const outside = mkdtempSync(join(tmpdir(), "rev25-key-"));
    try {
      const inside = join(dataDir, "rev25-vault.key");
      writeFileSync(inside, `${Buffer.alloc(32, 21).toString("base64")}\n`, { mode: 0o600 });
      const link = join(outside, "vault.key");
      symlinkSync(inside, link);
      expect(() => parseVaultKey({ VAULT_ENCRYPTION_KEY_FILE: link }, null, dataDir)).toThrow("outside DATA_DIR");
      rmSync(inside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(() => parseVaultKey({ VAULT_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") }, null)).toThrow("32-byte");
    expect(() => parseVaultKey({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("hex") }, null)).toThrow("32-byte");
    const totp = Buffer.alloc(32, 3);
    expect(() => parseVaultKey({ VAULT_ENCRYPTION_KEY: totp.toString("base64") }, totp)).toThrow("must differ");
  });

  test("rotate-kek is all-or-nothing: one DEK the old key cannot open aborts the run and nothing is re-wrapped", async () => {
    const owner = await createUser("Review rotation owner");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "ROT_REVIEW", { dev: "rot-review" });
    const oldKey = config.vault.key!;
    const newKey = Buffer.alloc(32, 22);
    const before = verifyKeys(oldKey);
    expect(before.failed).toBe(0);
    // A corrupt wrapped DEK sorted after a good one: the run fails part-way through its loop.
    db.query("INSERT INTO vault_keys (vault_id, generation, wrapped_dek, created_at) VALUES (?, 2, 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA', ?)").run(vault.id, new Date().toISOString());
    try {
      expect(() => rotateKek(oldKey, newKey)).toThrow();
      const after = verifyKeys(oldKey);
      expect(after.keys).toBe(before.keys + 1);
      expect(after.failed).toBe(1);
      expect(verifyKeys(newKey).failed).toBe(after.keys);
    } finally {
      db.query("DELETE FROM vault_keys WHERE vault_id = ? AND generation = 2").run(vault.id);
    }
    expect((await call(owner, "GET", `/vaults/${vault.id}`)).status).toBe(200);
  });
});

describe("the clipboard (T187)", () => {
  // Fixed (review L2): the 30-second clear reads the clipboard first and clears only the secret.
  test("clearing never wipes something copied after the secret", async () => {
    const focus = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { hasFocus: () => true };
    try {
      let content = "";
      const clipboard = {
        writeText: async (text: string) => { content = text; },
        readText: async () => content
      };
      await copySecret("s3cret", clipboard, 5);
      content = "something the user copied later";
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(content).toBe("something the user copied later");
    } finally {
      (globalThis as { document?: unknown }).document = focus;
    }
  });
});
