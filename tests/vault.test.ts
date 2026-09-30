import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits } from "./support/vault";

const { sweepBin } = await import("../server/bin");
const { chargeVault, VAULT_LIMITS } = await import("../server/vault/limits");

/** Wave 25 (Vault A): vaults, environments, secrets, values, history, the Bin, and limits over the session API. */

beforeEach(() => resetVaultLimits());

describe("vaults and environments", () => {
  test("a new vault has dev, staging, and prod (protected) and the creator as its only owner", async () => {
    const owner = await createUser("Vault owner");
    const created = await call(owner, "POST", "/vaults", { name: "Payments", description: "Card processing" });
    expect(created.status).toBe(201);
    const vault = created.body.vault;
    expect(vault).toMatchObject({ name: "Payments", description: "Card processing", role: "owner", revision: 1, secretCount: 0 });
    expect(vault.environments.map((env: any) => [env.slug, env.name, env.protected, env.level])).toEqual([
      ["dev", "Development", false, "admin"], ["staging", "Staging", false, "admin"], ["prod", "Production", true, "admin"]
    ]);
    expect(db.query("SELECT role FROM vault_members WHERE vault_id = ?").all(vault.id)).toEqual([{ role: "owner" }]);
    expect((db.query("SELECT COUNT(*) AS count FROM vault_keys WHERE vault_id = ?").get(vault.id) as { count: number }).count).toBe(1);
    const listed = await call(owner, "GET", "/vaults");
    expect(listed.body.vaults.map((item: any) => item.id)).toContain(vault.id);
    expect(listed.headers.get("cache-control")).toBe("no-store");
  });

  test("custom environments, rename with CAS, add, rename, reorder, and the last environment stays", async () => {
    const owner = await createUser("Env owner");
    const created = await call(owner, "POST", "/vaults", { name: "Custom", environments: [{ slug: "local", name: "Local" }, { slug: "live", name: "Live", protected: true }] });
    expect(created.status).toBe(201);
    const vault = created.body.vault;
    const [local, live] = vault.environments;
    expect((await call(owner, "POST", "/vaults", { name: "Dup", environments: [{ slug: "a", name: "A" }, { slug: "a", name: "B" }] })).body.code).toBe("SLUG_TAKEN");
    expect((await call(owner, "POST", "/vaults", { name: "Bad", environments: [{ slug: "Prod!", name: "B" }] })).status).toBe(400);

    const renamed = await call(owner, "PATCH", `/vaults/${vault.id}`, { name: "Renamed", expectedRevision: 1 });
    expect(renamed.body.vault).toMatchObject({ name: "Renamed", revision: 2 });
    const stale = await call(owner, "PATCH", `/vaults/${vault.id}`, { name: "Stale", expectedRevision: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "REVISION_CHANGED", currentRevision: 2 } });

    const added = await call(owner, "POST", `/vaults/${vault.id}/environments`, { slug: "qa", name: "QA" });
    expect(added.status).toBe(201);
    expect((await call(owner, "POST", `/vaults/${vault.id}/environments`, { slug: "qa", name: "QA again" })).body.code).toBe("SLUG_TAKEN");
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/environments/${added.body.environment.id}`, { name: "Quality" })).body.environment.name).toBe("Quality");

    const current = (await call(owner, "GET", `/vaults/${vault.id}`)).body.vault;
    const order = [added.body.environment.id, live.id, local.id];
    const reordered = await call(owner, "PUT", `/vaults/${vault.id}/environments/order`, { ids: order, expectedRevision: current.revision });
    expect(reordered.body.vault.environments.map((env: any) => env.id)).toEqual(order);
    expect((await call(owner, "PUT", `/vaults/${vault.id}/environments/order`, { ids: order.slice(1), expectedRevision: reordered.body.vault.revision })).status).toBe(400);
    expect((await call(owner, "PUT", `/vaults/${vault.id}/environments/order`, { ids: order, expectedRevision: current.revision })).body.code).toBe("REVISION_CHANGED");

    expect((await call(owner, "DELETE", `/vaults/${vault.id}/environments/${local.id}`)).body).toEqual({ ok: true, binned: true });
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/environments/${live.id}`)).body).toEqual({ ok: true, binned: true });
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/environments/${added.body.environment.id}`))).toMatchObject({ status: 409, body: { code: "LAST_ENVIRONMENT" } });
  });

  test("names are one line; malformed ids are 404; validation errors never echo the input", async () => {
    const owner = await createUser("Validation owner");
    const bad = await call(owner, "POST", "/vaults", { name: "Line\nbreak SECRET-INPUT" });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("SECRET-INPUT");
    expect((await call(owner, "GET", "/vaults/not-a-uuid")).status).toBe(404);
    const vault = await newVault(owner);
    const tooBig = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "BIG", values: { [vault.envs.dev!]: { value: "x".repeat(70_000) } } });
    expect(tooBig.status).toBe(400);
    expect(tooBig.text).not.toContain("xxxx");
    // 64 KiB of characters, but more than 64 KiB of UTF-8 bytes: 413.
    const wide = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "WIDE", values: { [vault.envs.dev!]: { value: "é".repeat(40_000) } } });
    expect(wide).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
    const exact = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "EXACT", values: { [vault.envs.dev!]: { value: "y".repeat(65_536) } } });
    expect(exact.status).toBe(201);
  });
});

describe("secrets and values", () => {
  test("create with values, list without values, reveal, set with CAS, clear, and history", async () => {
    const owner = await createUser("Secrets owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "DATABASE_URL", { dev: "postgres://dev", prod: "postgres://prod" }, { comment: "Primary DB", tags: ["db", "core"] });
    expect(secret.values[vault.envs.dev!]).toMatchObject({ status: "set", version: 1 });
    expect(secret.values[vault.envs.staging!]).toMatchObject({ status: "empty", version: 0 });
    expect((await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "database_url" })).body.code).toBe("NAME_TAKEN");

    const list = await call(owner, "GET", `/vaults/${vault.id}/secrets`);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("postgres://");
    expect(list.text).not.toContain("Primary DB");
    expect(list.body.secrets[0]).toMatchObject({ name: "DATABASE_URL", type: "value", tags: ["db", "core"], hasComment: true });
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets?q=base`)).body.secrets).toHaveLength(1);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets?q=zzz`)).body.secrets).toHaveLength(0);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets?tag=core`)).body.secrets).toHaveLength(1);

    const detail = await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}`);
    expect(detail.body.secret.comment).toBe("Primary DB");

    const read = await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`);
    expect(read.body.value).toMatchObject({ value: "postgres://prod", version: 1, comment: null });
    expect(read.headers.get("etag")).toBe('"v1"');
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.staging}`)).body.code).toBe("VALUE_NOT_SET");

    const set = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`, { value: "postgres://prod2", comment: "rotated", expectedVersion: 1 });
    expect(set.body.value).toMatchObject({ version: 2 });
    const conflict = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`, { value: "lost", expectedVersion: 1 });
    expect(conflict).toMatchObject({ status: 409, body: { code: "VALUE_CHANGED", currentVersion: 2 } });
    expect(conflict.text).not.toContain("postgres://prod2");
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`)).body.value).toMatchObject({ value: "postgres://prod2", comment: "rotated" });

    const staleClear = await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}?expectedVersion=1`);
    expect(staleClear.body.code).toBe("VALUE_CHANGED");
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`)).status).toBe(400);
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}?expectedVersion=2`)).body).toEqual({ ok: true, version: 3 });
    const listed = (await call(owner, "GET", `/vaults/${vault.id}/secrets`)).body.secrets[0];
    expect(listed.values[vault.envs.prod!]).toMatchObject({ status: "empty", version: 3 });

    const history = await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}/versions`);
    expect(history.body.versions.map((item: any) => [item.version, item.cleared])).toEqual([[3, true], [2, false], [1, false]]);
    expect(history.text).not.toContain("postgres://");
    const old = await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}/versions/1`);
    expect(old.body.version).toMatchObject({ version: 1, cleared: false, value: "postgres://prod" });
    const restored = await call(owner, "POST", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}/versions/1/restore`, { expectedVersion: 3 });
    expect(restored.body.value.version).toBe(4);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`)).body.value.value).toBe("postgres://prod");
    expect((await call(owner, "POST", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}/versions/3/restore`, { expectedVersion: 4 })).body.code).toBe("VERSION_CLEARED");

    const events = db.query("SELECT event, count FROM vault_events WHERE vault_id = ? ORDER BY created_at, rowid").all(vault.id) as Array<{ event: string }>;
    expect(events.map((row) => row.event)).toEqual(expect.arrayContaining(["vault.create", "secret.create", "value.read", "value.write", "value.clear", "version.read", "value.restore"]));
  });

  test("history keeps the last 20 versions per secret and environment", async () => {
    const owner = await createUser("History owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "TOKEN", { dev: "v1" });
    for (let version = 1; version < 25; version += 1) {
      const result = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`, { value: `v${version + 1}`, expectedVersion: version });
      expect(result.status).toBe(200);
    }
    const versions = (await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}/versions`)).body.versions.map((item: any) => item.version);
    expect(versions).toHaveLength(20);
    expect(versions[0]).toBe(25);
    expect(versions.at(-1)).toBe(6);
  });

  test("apply to other environments writes all or nothing", async () => {
    const owner = await createUser("Apply owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "API_URL", { dev: "https://dev" });
    const failed = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values`, { values: [
      { envId: vault.envs.staging, value: "https://shared", expectedVersion: 0 },
      { envId: vault.envs.dev, value: "https://shared", expectedVersion: 0 }
    ] });
    expect(failed.body.code).toBe("VALUE_CHANGED");
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.staging}`)).body.code).toBe("VALUE_NOT_SET");
    const applied = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values`, { values: [
      { envId: vault.envs.staging, value: "https://shared", expectedVersion: 0 },
      { envId: vault.envs.prod, value: "https://shared", expectedVersion: 0 },
      { envId: vault.envs.dev, value: "https://shared", expectedVersion: 1 }
    ] });
    expect(applied.body.values.map((item: any) => item.version)).toEqual([1, 1, 2]);
  });

  test("reveal batch opens readable cells and hides which others failed", async () => {
    const owner = await createUser("Reveal owner");
    const vault = await newVault(owner);
    const a = await newSecret(owner, vault, "A", { dev: "alpha", prod: "alpha-prod" });
    const other = await newVault(owner);
    const b = await newSecret(owner, other, "B", { dev: "beta" });
    const revealed = await call(owner, "POST", `/vaults/${vault.id}/reveal`, { cells: [
      { secretId: a.id, envId: vault.envs.dev }, { secretId: a.id, envId: vault.envs.staging }, { secretId: b.id, envId: other.envs.dev }, { secretId: a.id, envId: other.envs.dev }
    ] });
    expect(revealed.body.cells.map((cell: any) => [cell.status, cell.value ?? null])).toEqual([["ok", "alpha"], ["unavailable", null], ["unavailable", null], ["unavailable", null]]);
    expect(revealed.text).not.toContain("beta");
    const event = db.query("SELECT count FROM vault_events WHERE vault_id = ? AND event = 'value.read' ORDER BY created_at DESC LIMIT 1").get(vault.id) as { count: number };
    expect(event.count).toBe(1);
  });

  test("login secrets hold three fields; the type changes only without values", async () => {
    const owner = await createUser("Login owner");
    const vault = await newVault(owner);
    const bad = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "Admin panel", type: "login", values: { [vault.envs.dev!]: { value: "not json" } } });
    expect(bad.body.code).toBe("INVALID_VALUE");
    const login = JSON.stringify({ username: "root", password: "hunter2", url: "https://admin.example.test" });
    const created = await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "Admin panel", type: "login", values: { [vault.envs.dev!]: { value: login } } });
    expect(created.status).toBe(201);
    const secret = created.body.secret;
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/secrets/${secret.id}`, { type: "value", expectedRevision: 1 })).body.code).toBe("TYPE_HAS_VALUES");
    const empty = await newSecret(owner, vault, "Later");
    const retyped = await call(owner, "PATCH", `/vaults/${vault.id}/secrets/${empty.id}`, { type: "note", name: "Later note", tags: ["x"], comment: "hello", expectedRevision: 1 });
    expect(retyped.body.secret).toMatchObject({ type: "note", name: "Later note", tags: ["x"], comment: "hello", revision: 2 });
    const cleared = await call(owner, "PATCH", `/vaults/${vault.id}/secrets/${empty.id}`, { comment: null, expectedRevision: 2 });
    expect(cleared.body.secret).toMatchObject({ comment: null, hasComment: false });
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/secrets/${empty.id}`, { name: "x", expectedRevision: 2 })).body.code).toBe("REVISION_CHANGED");
  });
});

describe("the Bin (D225, T196)", () => {
  test("a binned secret disappears everywhere, restores, and a reused name blocks its restore", async () => {
    const owner = await createUser("Bin secret owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "SECRET_KEY", { dev: "s3cr3t" });
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}`)).body).toEqual({ ok: true, binned: true });
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}`)).status).toBe(404);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).status).toBe(404);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets`)).body.secrets).toHaveLength(0);
    const bin = await (await request("/bin", {}, owner)).json() as { items: Array<{ type: string; id: string; title: string; folder_name: string }> };
    expect(bin.items.find((item) => item.id === secret.id)).toMatchObject({ type: "vault_secret", title: "SECRET_KEY" });

    await newSecret(owner, vault, "secret_key");
    const blocked = await request(`/bin/vault_secret/${secret.id}/restore`, { method: "POST", body: "{}" }, owner);
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as { code: string }).code).toBe("NAME_TAKEN");
    const reused = (await call(owner, "GET", `/vaults/${vault.id}/secrets`)).body.secrets[0];
    await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${reused.id}`);
    const restored = await request(`/bin/vault_secret/${secret.id}/restore`, { method: "POST", body: "{}" }, owner);
    expect(restored.status).toBe(200);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).body.value.value).toBe("s3cr3t");
  });

  test("a binned environment hides its values and returns them on restore", async () => {
    const owner = await createUser("Bin env owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "X", { staging: "stage-value" });
    await call(owner, "DELETE", `/vaults/${vault.id}/environments/${vault.envs.staging}`);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.staging}`)).status).toBe(404);
    const listed = (await call(owner, "GET", `/vaults/${vault.id}/secrets`)).body.secrets[0];
    expect(Object.keys(listed.values)).not.toContain(vault.envs.staging);
    const restored = await request(`/bin/vault_environment/${vault.envs.staging}/restore`, { method: "POST", body: "{}" }, owner);
    expect(restored.status).toBe(200);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.staging}`)).body.value.value).toBe("stage-value");
  });

  test("purging a vault deletes its data keys (crypto-shred), rows, and events; the sweeper purges after 30 days", async () => {
    const owner = await createUser("Bin vault owner");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "GONE", { dev: "gone" });
    await call(owner, "DELETE", `/vaults/${vault.id}`);
    expect((await call(owner, "GET", `/vaults/${vault.id}`)).status).toBe(404);
    expect((await call(owner, "GET", "/vaults")).body.vaults.map((item: any) => item.id)).not.toContain(vault.id);
    const stranger = await createUser("Bin stranger");
    expect((await request(`/bin/vault/${vault.id}`, { method: "DELETE", body: "{}" }, stranger)).status).toBe(404);
    expect((await request(`/bin/vault/${vault.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    for (const table of ["vaults", "vault_keys", "vault_environments", "vault_secrets", "vault_members", "vault_events"]) {
      const column = table === "vaults" ? "id" : "vault_id";
      expect({ table, rows: (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(vault.id) as { count: number }).count }).toEqual({ table, rows: 0 });
    }

    const later = await newVault(owner);
    const kept = await newSecret(owner, later, "KEPT", { dev: "kept" });
    const binned = await newSecret(owner, later, "SWEPT", { dev: "swept" });
    await call(owner, "DELETE", `/vaults/${later.id}/secrets/${binned.id}`);
    await sweepBin({ nowMs: Date.now() + 31 * 86_400_000 });
    expect(db.query("SELECT id FROM vault_secrets WHERE id = ?").get(binned.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM vault_value_versions WHERE secret_id = ?").get(binned.id)).toEqual({ count: 0 });
    expect((await call(owner, "GET", `/vaults/${later.id}/secrets/${kept.id}/values/${later.envs.dev}`)).body.value.value).toBe("kept");
  });
});

describe("rate limits (§7)", () => {
  test("reads beyond 300 in ten minutes get 429 with retryAfterSeconds, and the window is kept in SQLite", async () => {
    const owner = await createUser("Limit owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "L", { dev: "l" });
    chargeVault("read", owner.userId, VAULT_LIMITS.read.limit - 1);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).status).toBe(200);
    const limited = await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers.get("retry-after")).toBe(String(limited.body.retryAfterSeconds));
    expect(db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`read:${owner.userId}`)).toEqual({ count: VAULT_LIMITS.read.limit });
    // Writes have their own bucket.
    expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`, { value: "m", expectedVersion: 1 })).status).toBe(200);
  });

  test("the previous window still counts while it overlaps", () => {
    const subject = crypto.randomUUID();
    const window = VAULT_LIMITS.write.windowMs;
    const start = Math.floor(Date.now() / window) * window;
    chargeVault("write", subject, 300, start + 1);
    // Just after the window turns over, nearly all of the previous 300 still count.
    expect(() => chargeVault("write", subject, 1, start + window + 1000)).toThrow("Too many vault requests");
    // Once the previous window has slid out, the bucket is empty again.
    expect(() => chargeVault("write", subject, 300, start + 2 * window)).not.toThrow();
  });
});
