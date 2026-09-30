import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { accessBody, call, newSecret, newVault, putAccess, resetVaultLimits, share, type TestVault } from "./support/vault";
import { parseImport, parseDotenv, parseCsvImport, parseJsonImport, type TransferFormat } from "../shared/vaultTransfer";

const { runRotationPass, pauseRotationRunnerForTests, rotationStatus } = await import("../server/vault/rotation");
const { setVaultQuotaForTests, storedBytesOf } = await import("../server/vault/service");
const { sweepBin } = await import("../server/bin");

/**
 * Wave 26 operations: import and export in every format (round trips, preview, protected window,
 * audit), data-key rotation with the sweeper (values readable throughout, old keys gone after), the
 * per-person byte quota, and the canary across the new paths (T188).
 */

beforeEach(() => resetVaultLimits());
afterEach(() => {
  setVaultQuotaForTests(null);
  pauseRotationRunnerForTests(false);
});

const TRICKY: Record<string, string> = {
  DATABASE_URL: "postgres://user:p@ss w0rd@db:5432/app?sslmode=require",
  QUOTES: "she said \"hi\" and 'bye'",
  HASH_AND_SPACES: "  value # not a comment  ",
  MULTI_LINE: "line one\nline two\r\nline three\ttabbed",
  BACKSLASHES: "C:\\path\\to\\file \\n literally",
  UNICODE: "pässwörd ✓ 🔑",
  EQUALS: "a=b=c",
  EMPTY: ""
};

async function exportText(session: Session, vault: TestVault, slug: string, format: TransferFormat, comments = false) {
  const response = await request(`/vault/vaults/${vault.id}/environments/${vault.envs[slug]}/export?format=${format}${comments ? "&comments=1" : ""}`, {}, session);
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function importInto(session: Session, vault: TestVault, slug: string, entries: unknown[], extra: Record<string, unknown> = {}) {
  return call(session, "POST", `/vaults/${vault.id}/environments/${vault.envs[slug]}/import`, { entries, ...extra });
}

async function values(session: Session, vault: TestVault, slug: string) {
  const list = (await call(session, "GET", `/vaults/${vault.id}/secrets`)).body.secrets as Array<{ id: string; name: string; values: Record<string, { status: string }> }>;
  const out: Record<string, string> = {};
  for (const secret of list) {
    if (secret.values[vault.envs[slug]!]?.status !== "set") continue;
    out[secret.name] = (await call(session, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs[slug]}`)).body.value.value;
  }
  return out;
}

describe("import and export (§6.4)", () => {
  for (const format of ["dotenv", "json", "csv"] as const) {
    test(`${format}: export then import into another vault gives the same values; the export is audited`, async () => {
      const owner = await createUser(`Transfer ${format}`);
      const source = await newVault(owner);
      for (const [name, value] of Object.entries(TRICKY)) await newSecret(owner, source, name, { dev: value });
      const exported = await exportText(owner, source, "dev", format, true);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-disposition")).toStartWith("attachment;");
      expect(exported.headers.get("cache-control")).toContain("no-store");
      expect(exported.headers.get("content-security-policy")).toContain("sandbox");
      expect(exported.headers.get("x-content-type-options")).toBe("nosniff");
      const parsed = parseImport(format, exported.text);
      expect(parsed.problems).toEqual([]);
      expect(Object.fromEntries(parsed.entries.map((entry) => [entry.name, entry.value]))).toEqual(TRICKY);

      const target = await newVault(owner);
      const preview = await importInto(owner, target, "staging", parsed.entries, { dryRun: true });
      expect(preview.body.counts).toMatchObject({ create: Object.keys(TRICKY).length, invalid: 0 });
      expect(preview.text).not.toContain("p@ss w0rd");
      expect((await call(owner, "GET", `/vaults/${target.id}/secrets`)).body.secrets).toEqual([]);
      const imported = await importInto(owner, target, "staging", parsed.entries);
      expect(imported.body).toMatchObject({ dryRun: false, counts: { create: Object.keys(TRICKY).length } });
      expect(await values(owner, target, "staging")).toEqual(TRICKY);
      // Importing the same file again: everything is the same, nothing is written.
      const again = await importInto(owner, target, "staging", parsed.entries, { dryRun: true });
      expect(again.body.counts).toMatchObject({ same: Object.keys(TRICKY).length, create: 0, update: 0 });
      // Export of the copy equals the export of the original (same names and values).
      const reexported = parseImport(format, (await exportText(owner, target, "staging", format)).text);
      expect(Object.fromEntries(reexported.entries.map((entry) => [entry.name, entry.value]))).toEqual(TRICKY);

      const events = db.query("SELECT event, count FROM vault_events WHERE vault_id = ? AND event = 'export'").all(source.id);
      expect(events).toEqual([{ event: "export", count: Object.keys(TRICKY).length }]);
      const audited = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'vault.export' AND actor_id = ?").all(owner.userId) as Array<{ metadata_json: string }>;
      expect(audited.length).toBe(2);
      for (const row of audited) {
        expect(JSON.parse(row.metadata_json)).toMatchObject({ format, count: Object.keys(TRICKY).length });
        expect(row.metadata_json).not.toContain("DATABASE_URL");
      }
    });
  }

  test("modes, invalid entries, logins, comments, and bounds", async () => {
    const owner = await createUser("Import modes");
    const vault = await newVault(owner);
    const existing = await newSecret(owner, vault, "EXISTING", { dev: "old" });
    await call(owner, "POST", `/vaults/${vault.id}/secrets`, { name: "LOGIN", type: "login" });
    const entries = [
      { name: "EXISTING", value: "new" },
      { name: "FRESH", value: "fresh", comment: "from the file" },
      { name: "LOGIN", value: "not json" },
      { name: " bad", value: "x" },
      { name: "fresh", value: "dup" }
    ];
    const skip = await importInto(owner, vault, "dev", entries, { dryRun: true });
    expect(skip.body.entries.map((entry: any) => [entry.name, entry.status])).toEqual([
      ["EXISTING", "skip"], ["FRESH", "create"], ["LOGIN", "invalid"], [" bad", "invalid"], ["fresh", "invalid"]
    ]);
    expect(JSON.stringify(skip.body)).not.toContain("not json");
    const written = await importInto(owner, vault, "dev", entries, { mode: "overwrite" });
    expect(written.body.counts).toMatchObject({ update: 1, create: 1, invalid: 3 });
    // A NUL anywhere refuses the whole request at the schema, without echoing it.
    expect((await importInto(owner, vault, "dev", [{ name: "NUL", value: "a\u0000b" }], { dryRun: true })).status).toBe(400);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${existing.id}/values/${vault.envs.dev}`)).body.value.value).toBe("new");
    const fresh = (await call(owner, "GET", `/vaults/${vault.id}/secrets`)).body.secrets.find((item: any) => item.name === "FRESH");
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${fresh.id}/values/${vault.envs.dev}`)).body.value).toMatchObject({ value: "fresh", comment: "from the file" });
    expect((await importInto(owner, vault, "dev", Array.from({ length: 501 }, (_, index) => ({ name: `K${index}`, value: "v" })))).status).toBe(400);
    // A member with read only cannot import.
    const reader = await createUser("Import reader");
    await share(owner, vault, [{ session: reader, levels: { dev: "read" } }]);
    expect((await importInto(reader, vault, "dev", [{ name: "X", value: "y" }], { dryRun: true })).body.code).toBe("VAULT_LEVEL");
    const events = (db.query("SELECT event FROM vault_events WHERE vault_id = ? AND event LIKE 'import%' ORDER BY rowid").all(vault.id) as Array<{ event: string }>).map((row) => row.event);
    expect(events).toEqual(["import.preview", "import"]);
  });

  test("the parsers: export prefix, comments, quotes, CRLF, BOM, NUL, CSV quoting, JSON shapes", () => {
    const env = parseDotenv("\uFEFF# top\r\nexport A=1\r\nB = \"two\\nlines\" # c\r\nC='lit\\n'\r\nD=plain # comment\r\nE=\"multi\nline\"\r\nbad line\r\n1X=nope\r\nA=again\r\n");
    expect(env.entries).toEqual([{ name: "A", value: "again" }, { name: "B", value: "two\nlines" }, { name: "C", value: "lit\\n" }, { name: "D", value: "plain" }, { name: "E", value: "multi\nline" }]);
    expect(env.problems.map((problem) => problem.line)).toEqual([8, 9, 2]);
    expect(parseDotenv("A=\"never closed\n").problems[0]!.reason).toContain("never closed");
    expect(parseDotenv("A=b\u0000").entries).toEqual([]);
    expect(parseCsvImport("name,value,comment\r\nA,\"x,y\",\"he said \"\"hi\"\"\"\r\nB,\"two\nlines\",\r\n").entries).toEqual([{ name: "A", value: "x,y", comment: "he said \"hi\"" }, { name: "B", value: "two\nlines" }]);
    expect(parseCsvImport("key,val\nA,1").problems[0]!.reason).toContain("name, value");
    expect(parseJsonImport("{\"A\":\"1\",\"B\":2}")).toEqual({ entries: [{ name: "A", value: "1" }], problems: [{ line: null, name: "B", reason: "The value is not text" }] });
    expect(parseJsonImport("[{\"name\":\"A\",\"value\":\"1\",\"comment\":\"c\"}]").entries).toEqual([{ name: "A", value: "1", comment: "c" }]);
    expect(parseJsonImport("{\"secrets\":[{\"name\":\"A\",\"value\":\"1\"}]}").entries).toEqual([{ name: "A", value: "1" }]);
    expect(parseJsonImport("nope").problems[0]!.reason).toBe("Not valid JSON");
  });

  test("exports are limited to 10 an hour; a .env export leaves out names that are not keys and says how many", async () => {
    const owner = await createUser("Export limit");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "GOOD_KEY", { dev: "g" });
    await newSecret(owner, vault, "not a key", { dev: "n" });
    const first = await exportText(owner, vault, "dev", "dotenv");
    expect(first.headers.get("x-vault-export-skipped")).toBe("1");
    expect(first.text).toContain("GOOD_KEY=\"g\"");
    expect(first.text).not.toContain("not a key");
    for (let index = 1; index < 10; index += 1) expect((await exportText(owner, vault, "dev", "json")).status).toBe(200);
    expect((await exportText(owner, vault, "dev", "csv")).status).toBe(429);
  });
});

describe("data-key rotation and the sweeper (§3.3, T190)", () => {
  test("values stay readable while rows move; afterwards every row is on the new key and the old key is gone", async () => {
    pauseRotationRunnerForTests(true);
    const owner = await createUser("Rotation owner");
    const vault = await newVault(owner);
    const secrets = [];
    for (let index = 0; index < 6; index += 1) {
      const secret = await newSecret(owner, vault, `ROT_${index}`, { dev: `dev-${index}`, prod: `prod-${index}` }, { comment: `comment-${index}` });
      await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`, { value: `dev-${index}-v2`, comment: `vc-${index}`, expectedVersion: 1 });
      secrets.push(secret);
    }
    const oldKey = db.query("SELECT wrapped_dek FROM vault_keys WHERE vault_id = ? AND generation = 1").get(vault.id) as { wrapped_dek: string };
    const rotated = await call(owner, "POST", `/vaults/${vault.id}/rotate`, {});
    expect(rotated.body.rotation).toMatchObject({ generation: 2, done: false });
    expect(rotated.body.rotation.pendingRows).toBeGreaterThan(0);
    // A write now uses the new generation; older rows are still on the old one, and all read.
    await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secrets[0]!.id}/values/${vault.envs.prod}`, { value: "prod-0-v2", expectedVersion: 1 });
    expect(db.query("SELECT generation FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secrets[0]!.id, vault.envs.prod)).toEqual({ generation: 2 });
    const readAll = async () => {
      for (const [index, secret] of secrets.entries()) {
        expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).body.value).toMatchObject({ value: `dev-${index}-v2`, comment: `vc-${index}` });
        expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}`)).body.secret.comment).toBe(`comment-${index}`);
        expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}/versions/1`)).body.version.value).toBe(`dev-${index}`);
      }
    };
    await readAll();
    // One small pass at a time (the batch size is bounded), reading in between.
    let passes = 0;
    while (rotationStatus(vault.id).pendingRows > 0 && passes < 50) {
      runRotationPass(1);
      passes += 1;
      await readAll();
    }
    runRotationPass(1);
    const status = rotationStatus(vault.id);
    expect(status).toMatchObject({ generation: 2, pendingRows: 0, activeKeys: 1, done: true });
    for (const table of ["vault_values", "vault_value_versions"]) {
      expect(db.query(`SELECT DISTINCT t.generation FROM ${table} t JOIN vault_secrets s ON s.id = t.secret_id WHERE s.vault_id = ?`).all(vault.id)).toEqual([{ generation: 2 }]);
    }
    expect(db.query("SELECT DISTINCT comment_generation FROM vault_secrets WHERE vault_id = ?").all(vault.id)).toEqual([{ comment_generation: 2 }]);
    expect(db.query("SELECT generation FROM vault_keys WHERE vault_id = ?").all(vault.id)).toEqual([{ generation: 2 }]);
    expect(db.query("SELECT 1 FROM vault_keys WHERE wrapped_dek = ?").get(oldKey.wrapped_dek)).toBeNull();
    await readAll();
    const events = (db.query("SELECT event FROM vault_events WHERE vault_id = ? AND event LIKE 'key.%' ORDER BY rowid").all(vault.id) as Array<{ event: string }>).map((row) => row.event);
    expect(events).toEqual(["key.rotate", "key.retire"]);
    // An old-generation ciphertext kept from before (a backup, say) no longer opens here.
    db.query("UPDATE vault_values SET generation = 1 WHERE secret_id = ? AND env_id = ?").run(secrets[1]!.id, vault.envs.dev);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secrets[1]!.id}/values/${vault.envs.dev}`)).body.code).toBe("VAULT_INTEGRITY");
  });

  test("removing a member rotates the key and says so; the background runner finishes it", async () => {
    const owner = await createUser("Removal rotation owner");
    const member = await createUser("Removal rotation member");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "R", { dev: "r" });
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    const removed = await putAccess(owner, vault.id, accessBody(vault, owner, []));
    expect(removed.body).toMatchObject({ rotated: true, generation: 2, lostAccess: 1 });
    expect(db.query("SELECT event FROM vault_events WHERE vault_id = ? AND event IN ('member.remove', 'key.rotate.auto') ORDER BY rowid").all(vault.id)).toEqual([{ event: "member.remove" }, { event: "key.rotate.auto" }]);
    for (let wait = 0; wait < 50 && !rotationStatus(vault.id).done; wait += 1) await Bun.sleep(20);
    expect(rotationStatus(vault.id).done).toBe(true);
    expect((await call(member, "POST", `/vaults/${vault.id}/rotate`, {})).status).toBe(404);
  });
});

describe("the byte quota (review L5)", () => {
  test("a write past the creator's quota is refused and rolled back; clearing still works; the counter matches the rows", async () => {
    const owner = await createUser("Quota owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "BIG", { dev: "x".repeat(10_000) });
    const used = storedBytesOf(owner.userId);
    expect(used).toBeGreaterThan(20_000);
    setVaultQuotaForTests(used + 5_000);
    const refused = await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.staging}`, { value: "y".repeat(10_000), expectedVersion: 0 });
    expect(refused).toMatchObject({ status: 413, body: { code: "QUOTA_EXCEEDED" } });
    expect(db.query("SELECT 1 FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secret.id, vault.envs.staging)).toBeNull();
    expect(storedBytesOf(owner.userId)).toBe(used);
    expect((await importInto(owner, vault, "staging", [{ name: "BIG2", value: "z".repeat(10_000) }])).body.code).toBe("QUOTA_EXCEEDED");
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}?expectedVersion=1`)).status).toBe(200);
    expect((await call(owner, "GET", "/quota")).body).toMatchObject({ quotaBytes: used + 5_000 });

    // The trigger-kept counter equals a recount, through writes, clears, a purge, and a member's writes.
    const member = await createUser("Quota member");
    await share(owner, vault, [{ session: member, levels: { dev: "write" } }]);
    setVaultQuotaForTests(null);
    await call(member, "POST", `/vaults/${vault.id}/secrets`, { name: "BY_MEMBER", comment: "c", values: { [vault.envs.dev!]: { value: "m" } } });
    const recount = () => (db.query(`SELECT
        (SELECT ifnull(sum(length(comment_ct)), 0) FROM vault_secrets WHERE vault_id = $v)
        + (SELECT ifnull(sum(length(x.value_ct) + ifnull(length(x.comment_ct), 0)), 0) FROM vault_values x JOIN vault_secrets s ON s.id = x.secret_id WHERE s.vault_id = $v)
        + (SELECT ifnull(sum(ifnull(length(h.value_ct), 0) + ifnull(length(h.comment_ct), 0)), 0) FROM vault_value_versions h JOIN vault_secrets s ON s.id = h.secret_id WHERE s.vault_id = $v) AS bytes`).get({ v: vault.id }) as { bytes: number }).bytes;
    const counter = () => (db.query("SELECT stored_bytes FROM vaults WHERE id = ?").get(vault.id) as { stored_bytes: number }).stored_bytes;
    expect(counter()).toBe(recount());
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}`)).status).toBe(200);
    await sweepBin({ nowMs: Date.now() + 40 * 86_400_000 });
    expect(db.query("SELECT 1 FROM vault_secrets WHERE id = ?").get(secret.id)).toBeNull();
    expect(counter()).toBe(recount());
    expect(storedBytesOf(member.userId)).toBe(0);
  });
});

describe("the canary across Wave 26 paths (T188)", () => {
  test("plaintext never lands in the audit log, events, notices, access events, mail, or error bodies", async () => {
    const CANARY = `NOOK-CANARY-${crypto.randomUUID()}`;
    const owner = await createUser("Canary B owner");
    const member = await createUser("Canary B member");
    const vault = await newVault(owner);
    await importInto(owner, vault, "prod", [{ name: "CANARY_A", value: `${CANARY}-a`, comment: `${CANARY}-c` }]);
    await importInto(owner, vault, "prod", [{ name: "CANARY_A", value: `${CANARY}-b` }], { mode: "overwrite", dryRun: true });
    await share(owner, vault, [{ session: member, levels: { prod: "read" } }]);
    const exported = await exportText(owner, vault, "prod", "json", true);
    expect(exported.text).toContain(`${CANARY}-a`);
    const locked = await exportText(member, vault, "prod", "csv");
    expect(locked.text).not.toContain(CANARY);
    await call(owner, "POST", `/vaults/${vault.id}/rotate`, {});
    runRotationPass(10);
    await putAccess(owner, vault.id, accessBody(vault, owner, []));
    const bad = await importInto(owner, vault, "prod", [{ name: `${CANARY}\n`, value: `${CANARY}-bad` }], { dryRun: true });
    expect(bad.text).not.toContain(`${CANARY}-bad`);
    for (const table of ["audit_log", "vault_events", "access_notices", "access_events", "mail_outbox", "vault_rate_limits", "sessions"]) {
      const dump = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
      expect({ table, leaked: dump.includes(CANARY) }).toEqual({ table, leaked: false });
    }
    for (const table of ["vault_values", "vault_value_versions", "vault_secrets"]) {
      const dump = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
      expect({ table, leaked: dump.includes(CANARY) }).toEqual({ table, leaked: false });
    }
  });
});
