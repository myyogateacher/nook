import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits, setRole, share, unlock, type TestVault } from "./support/vault";
import { registeredMigrationIds, runMigrations } from "../server/migrations";

const { createApiKey, resetKeyDenialsForTests } = await import("../server/apiKeys");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { invokeVaultToolForTests } = await import("../server/vault/mcpTools");
const { resetKeyAlertsForTests } = await import("../server/vault/keyApi");
const { runRotationPass, pauseRotationRunnerForTests, rotationStatus } = await import("../server/vault/rotation");
const { reencryptBatch } = await import("../server/vault/crypto");
const { vaultKeysMigration } = await import("../server/migrations/038_vault_keys");
const { DEFAULT_POLICIES, policiesRevision, resetPoliciesForTests, writePolicies } = await import("../server/team/policies");
const { config } = await import("../server/config");

/**
 * Independent security review of the whole Vault (Waves 25–27), run against Wave 27 (Vault C):
 * `nkv_` keys, `/api/v1/vault/*`, the vault MCP tools, per-key limits, migration 038, and the
 * cross-wave invariants with key actors. Probes that document an open finding say FINDING in their
 * name and assert the behaviour as reviewed (so the suite stays green); `test.failing` marks a probe
 * that asserts the behaviour the plan promises and fails on the branch as reviewed.
 */

beforeEach(() => {
  resetVaultLimits();
  resetMcpLimits();
  resetKeyRouteLimits();
  resetKeyAlertsForTests();
  resetKeyDenialsForTests();
});
afterEach(() => {
  pauseRotationRunnerForTests(false);
  resetPoliciesForTests();
});

type VaultGrantBody = { module: "vault"; permission: "read" | "write"; vaultId: string; envId?: string | null };

async function keysApi(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/keys${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

async function vaultKey(session: Session, grants: VaultGrantBody[], extra: Record<string, unknown> = {}) {
  const created = await keysApi(session, "POST", "", { name: `R27 key ${crypto.randomUUID().slice(0, 6)}`, kind: "vault", surfaces: "both", grants, password: session.password, ...extra });
  if (created.status !== 201) throw new Error(`vault key refused: ${JSON.stringify(created.body)}`);
  return { id: created.body.key.id as string, token: created.body.key.token as string, key: created.body.key };
}

async function rest(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] ??= "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${origin}/api/v1${path}`, init);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

let rpcId = 0;
async function mcp(token: string, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return { status: response.status, body: JSON.parse(json) as { result?: any; error?: { code: number; message: string } } };
}

async function tool(keyId: string, name: string, args: Record<string, unknown>) {
  const result = await invokeVaultToolForTests(name, args, keyId);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

const valuePath = (vault: TestVault, secretId: string, slug: string) => `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs[slug]}`;
const sessionValuePath = (vault: TestVault, secretId: string, slug: string) => `/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs[slug]}`;

function group(name: string, members: Session[]) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, at, at);
  for (const member of members) db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, member.userId, at);
  return id;
}

const setProtected = (envId: string, value: 0 | 1) => db.query("UPDATE vault_environments SET protected = ? WHERE id = ?").run(value, envId);

// ------------------------------------------------------------------------------------------------
// 1. The kind wall (T217)

describe("review 27: the kind wall beyond the implementer's probes (T217, D264)", () => {
  test("a vault key never reaches a general surface: MCP prompts/resources, a general tool by name, the upload PUT, or a routine binding", async () => {
    const owner = await createUser("R27 wall surfaces");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    const general = createApiKey(owner.userId, { name: "R27 general", surfaces: "both", grants: [{ module: "notes", permission: "write", resourceKind: null, resourceId: null }, { module: "files", permission: "write", resourceKind: null, resourceId: null }, { module: "inbox", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });

    // A general tool called by name over /mcp is unknown to a vault key's server.
    const notes = await mcp(key.token, "tools/call", { name: "list_notes", arguments: {} });
    expect(JSON.stringify(notes.body)).not.toContain("\"notes\":");
    expect(notes.body.error ?? notes.body.result?.isError).toBeTruthy();
    // No routine prompts and no resources for a vault key.
    const prompts = await mcp(key.token, "prompts/list");
    expect(prompts.body.result?.prompts ?? []).toEqual([]);
    // And a vault tool called by name over /mcp with a general key is unknown too.
    const reverse = await mcp(general.token, "tools/call", { name: "list_vaults", arguments: {} });
    expect(reverse.body.error ?? reverse.body.result?.isError).toBeTruthy();
    expect(JSON.stringify(reverse.body)).not.toContain(vault.id);
    // The ticketed upload PUT (a general-key surface) refuses a vault key before looking at a ticket.
    const upload = await fetch(`${origin}/mcp/uploads/${crypto.randomUUID()}`, { method: "PUT", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/octet-stream", "Content-Length": "1" }, body: "x" });
    expect(upload.status).toBe(403);
    expect(((await upload.json()) as { code: string }).code).toBe("SCOPE_REQUIRED");
    // A routine binds general keys only.
    const routine = await request("/inbox/routines", { method: "POST", body: JSON.stringify({ name: "R27 routine", instructions: "Look at my boards.", outputKinds: ["card_create"], cadence: "daily", atTime: "08:00", tz: "Europe/London", keyId: key.id }) }, owner);
    expect(routine.status).toBe(404);
    expect(((await routine.json()) as { code: string }).code).toBe("KEY_NOT_FOUND");
    // Session routes ignore a Bearer vault key (T184).
    const session = await fetch(`${origin}/api/vault/vaults`, { headers: { Authorization: `Bearer ${key.token}` } });
    expect(session.status).toBe(401);
  });

  test("rotating or narrowing a general key cannot bring in a vault grant or a vault flag; integration keys never take the flags", async () => {
    const owner = await createUser("R27 wall rotate");
    const vault = await newVault(owner);
    const general = createApiKey(owner.userId, { name: "R27 general rotate", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const rotate = await keysApi(owner, "POST", `/${general.id}/rotate`, { graceHours: 0, grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: owner.password });
    expect(rotate.body.code).toBe("KEY_KIND_WALL");
    const flags = await keysApi(owner, "POST", `/${general.id}/rotate`, { graceHours: 0, allowMcpValueReads: true, password: owner.password });
    expect(flags.status).toBe(400);
    expect((await keysApi(owner, "PATCH", `/${general.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id }] })).body.code).toBe("KEY_KIND_WALL");
    // The general key is untouched.
    expect(db.query("SELECT kind, allow_mcp_value_reads, vault_protected_access FROM mcp_api_keys WHERE id = ?").get(general.id)).toEqual({ kind: "general", allow_mcp_value_reads: 0, vault_protected_access: 0 });

    const admin = await createUser("R27 wall integration admin");
    setRole(admin, "admin");
    const created = await request("/team/integrations", { method: "POST", body: JSON.stringify({ name: "R27 robot", role: "member" }) }, admin);
    const integration = ((await created.json()) as { integration: { id: string } }).integration.id;
    const withFlag = await request(`/team/integrations/${integration}/keys`, { method: "POST", body: JSON.stringify({ name: "flag", grants: [{ module: "notes", permission: "read" }], allowMcpValueReads: true, password: admin.password }) }, admin);
    expect(withFlag.status).toBe(403);
  });

  test("migration 038 in the database: grant rows cannot be edited in place, a general key cannot carry a flag even with its kind left to the default, and a blank user never owns a vault key", async () => {
    const owner = await createUser("R27 wall db");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    const other = await newVault(owner);
    // In-place edits of a vault grant are refused (narrowing deletes and re-inserts through the checks).
    expect(() => db.query("UPDATE api_key_grants SET env_id = NULL WHERE key_id = ?").run(key.id)).toThrow(/VAULT_GRANT_SHAPE/);
    expect(() => db.query("UPDATE api_key_grants SET resource_id = ? WHERE key_id = ?").run(other.id, key.id)).toThrow(/VAULT_GRANT_SHAPE/);
    expect(() => db.query("UPDATE api_key_grants SET permission = 'write' WHERE key_id = ?").run(key.id)).toThrow(/VAULT_GRANT_SHAPE/);
    const at = new Date().toISOString();
    // `kind` omitted: the default ('general') is what the trigger sees.
    expect(() => db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, allow_mcp_value_reads) VALUES (?, ?, 'x', 'mynotes_abcdefgh', ?, '[]', ?, 1)")
      .run(crypto.randomUUID(), owner.userId, crypto.randomUUID(), at)).toThrow(/VAULT_FLAGS_ON_GENERAL_KEY/);
    expect(() => db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, vault_protected_access) VALUES (?, ?, 'x', 'mynotes_abcdefgh', ?, '[]', ?, 1)")
      .run(crypto.randomUUID(), owner.userId, crypto.randomUUID(), at)).toThrow(/VAULT_FLAGS_ON_GENERAL_KEY/);
    // An unknown user id is not a person (NULL IS NOT 'person').
    expect(() => db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, kind) VALUES (?, ?, 'x', 'nkv_abcdefghijkl', ?, '[]', ?, 'vault')")
      .run(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), at)).toThrow();
    // Turning a flag off is allowed; on again is not.
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }], { allowMcpValueReads: true });
    db.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 0 WHERE id = ?").run(flagged.id);
    expect(() => db.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 1 WHERE id = ?").run(flagged.id)).toThrow(/WIDENING_NOT_ALLOWED/);
  });
});

// ------------------------------------------------------------------------------------------------
// 2. Effective rights (D218, T182)

describe("review 27: effective rights with key actors (D218, T182)", () => {
  test("access through a group counts for a key, and removing the creator from the group cuts the key at once", async () => {
    const owner = await createUser("R27 group owner");
    const member = await createUser("R27 group member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "GROUPED", { dev: "g-dev" });
    const teamGroup = group("R27 group", [member]);
    await share(owner, vault, [], [{ id: teamGroup, levels: { dev: "write" } }]);
    const key = await vaultKey(member, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }]);
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).body.value.value).toBe("g-dev");
    db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(teamGroup, member.userId);
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).status).toBe(404);
    expect((await rest(key.token, "GET", "/vault/vaults")).body.vaults).toEqual([]);
  });

  test("a creator who hands the vault over and keeps read loses write on the key at once; a key is never an owner", async () => {
    const owner = await createUser("R27 handover owner");
    const heir = await createUser("R27 handover heir");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "HANDED", { dev: "h1" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    expect((await rest(key.token, "GET", `/vault/vaults/${vault.id}`)).body.vault.environments.every((env: any) => env.level === "write")).toBe(true);
    // Hand over: the heir becomes owner and the former owner stays a member with read on dev.
    const handed = await request(`/vault/vaults/${vault.id}/access`, { method: "GET" }, owner);
    const etag = handed.headers.get("etag") ?? "";
    const put = await request(`/vault/vaults/${vault.id}/access`, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ people: [{ id: heir.userId, role: "owner", levels: {} }, { id: owner.userId, role: "member", levels: { [vault.envs.dev!]: "read" } }], groups: [] }) }, owner);
    expect(put.status).toBe(200);
    const view = await rest(key.token, "GET", `/vault/vaults/${vault.id}`);
    expect(view.body.vault.environments).toEqual([expect.objectContaining({ slug: "dev", level: "read" })]);
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "h2", expectedVersion: 1 })).body.code).toBe("VAULT_LEVEL");
  });

  test("protected environments: an 'every environment' grant never covers one, and marking one protected later cuts keys that did not name it on a flagged key", async () => {
    const owner = await createUser("R27 protect later");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "PROTECT_LATER", { dev: "p-dev", staging: "p-staging", prod: "p-prod" });
    const every = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const named = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }]);
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }], { protectedAccess: true });
    expect(flagged.key.vault.protectedAccess).toBe(true);
    // prod is protected from the start: only the flagged key that names it reaches it.
    expect((await rest(every.token, "GET", valuePath(vault, secret.id, "prod"))).status).toBe(404);
    expect((await rest(flagged.token, "GET", valuePath(vault, secret.id, "prod"))).body.value.value).toBe("p-prod");
    // A flag asked for without naming a protected environment is not stored.
    const unneeded = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }], { protectedAccess: true });
    expect(unneeded.key.vault.protectedAccess).toBe(false);
    // Staging becomes protected: "every" and the unflagged named key lose it; nothing else changes.
    setProtected(vault.envs.staging!, 1);
    expect((await rest(every.token, "GET", valuePath(vault, secret.id, "staging"))).status).toBe(404);
    expect((await rest(named.token, "GET", valuePath(vault, secret.id, "staging"))).status).toBe(404);
    expect((await rest(unneeded.token, "GET", valuePath(vault, secret.id, "staging"))).status).toBe(404);
    expect((await rest(every.token, "GET", valuePath(vault, secret.id, "dev"))).body.value.value).toBe("p-dev");
    setProtected(vault.envs.staging!, 0);
  });

  test("FINDING (LOW): a flagged key keeps an environment it named while it was unprotected once that environment is marked protected", async () => {
    const owner = await createUser("R27 flag scope");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "FLAG_SCOPE", { staging: "fs-staging", prod: "fs-prod" });
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }], { protectedAccess: true });
    setProtected(vault.envs.staging!, 1);
    // The creation's re-authentication covered prod, not staging; the key still reads staging.
    expect((await rest(flagged.token, "GET", valuePath(vault, secret.id, "staging"))).body.value.value).toBe("fs-staging");
    setProtected(vault.envs.staging!, 0);
  });

  test("environments come and go: a new unprotected one joins an 'every environment' grant, a new protected one does not, a binned one leaves, a purged one drops the grant row", async () => {
    const owner = await createUser("R27 env lifecycle");
    const vault = await newVault(owner);
    const every = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const qa = await call(owner, "POST", `/vaults/${vault.id}/environments`, { slug: "qa", name: "QA" });
    expect(qa.status).toBe(201);
    const locked = await call(owner, "POST", `/vaults/${vault.id}/environments`, { slug: "dr", name: "DR", protected: true });
    expect(locked.status).toBe(201);
    const slugs = async () => (await rest(every.token, "GET", `/vault/vaults/${vault.id}`)).body.vault.environments.map((env: any) => env.slug).sort();
    expect(await slugs()).toEqual(["dev", "qa", "staging"]);
    const named = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: qa.body.environment?.id ?? qa.body.id }]);
    const qaId = qa.body.environment?.id ?? qa.body.id;
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/environments/${qaId}`)).status).toBe(200);
    expect(await slugs()).toEqual(["dev", "staging"]);
    expect((await rest(named.token, "GET", `/vault/vaults/${vault.id}`)).status).toBe(404);
    db.query("DELETE FROM vault_environments WHERE id = ?").run(qaId);
    expect((db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = ?").get(named.id) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = ?").get(every.id) as { count: number }).count).toBe(1);
  });

  test("a key never reaches an owner-only, member, Bin, import, or export operation: there is no route for it", async () => {
    const owner = await createUser("R27 owner ops");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "OPS", { dev: "o" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    const paths: Array<[string, string]> = [
      ["PATCH", `/vault/vaults/${vault.id}`], ["DELETE", `/vault/vaults/${vault.id}`], ["POST", `/vault/vaults`],
      ["POST", `/vault/vaults/${vault.id}/environments`], ["GET", `/vault/vaults/${vault.id}/access`], ["GET", `/vault/vaults/${vault.id}/members`],
      ["GET", `/vault/vaults/${vault.id}/events`], ["POST", `/vault/vaults/${vault.id}/rotate`], ["POST", `/vault/vaults/${vault.id}/reveal`],
      ["GET", `/vault/vaults/${vault.id}/environments/${vault.envs.dev}/export`], ["POST", `/vault/vaults/${vault.id}/environments/${vault.envs.dev}/import`],
      ["DELETE", `/vault/vaults/${vault.id}/secrets/${secret.id}`], ["PATCH", `/vault/vaults/${vault.id}/secrets/${secret.id}`],
      ["DELETE", valuePath(vault, secret.id, "dev")], ["GET", `${valuePath(vault, secret.id, "dev")}/versions/1`], ["POST", `${valuePath(vault, secret.id, "dev")}/versions/1/restore`],
      ["GET", `/vault/keys`], ["GET", `/bin`], ["POST", `/vault/vaults/${vault.id}/leave`]
    ];
    for (const [method, path] of paths) {
      const response = await rest(key.token, method, path, method === "GET" ? undefined : {});
      expect({ method, path, refused: [403, 404, 405].includes(response.status) }).toEqual({ method, path, refused: true });
      expect(response.text).not.toContain("\"o\"");
    }
    // Nothing moved.
    expect(db.query("SELECT deleted_at FROM vault_secrets WHERE id = ?").get(secret.id)).toEqual({ deleted_at: null });
    expect(db.query("SELECT deleted_at FROM vaults WHERE id = ?").get(vault.id)).toEqual({ deleted_at: null });
  });
});

// ------------------------------------------------------------------------------------------------
// 3. Values

describe("review 27: values over the key surfaces (T188, T191)", () => {
  test("versions never carry a value; MCP without the flag never returns a value or a comment; with it, only the named environment", async () => {
    const owner = await createUser("R27 values");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "VALUES", { dev: "v-dev-1", staging: "v-staging" }, { comment: "secret-comment-xyz" });
    await call(owner, "PUT", sessionValuePath(vault, secret.id, "dev"), { value: "v-dev-2", comment: "value-comment-xyz", expectedVersion: 1 });
    const plain = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const versions = await rest(plain.token, "GET", `${valuePath(vault, secret.id, "dev")}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.text).not.toContain("v-dev");
    expect(versions.text).not.toContain("comment-xyz");
    for (const args of [{ vaultId: vault.id, secretId: secret.id }, { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev }]) {
      const result = await tool(plain.id, "read_secret", args);
      expect(JSON.stringify(result.value)).not.toContain("v-dev");
      expect(JSON.stringify(result.value)).not.toContain("comment-xyz");
    }
    for (const name of ["list_vaults", "read_vault", "list_secrets"]) {
      const result = await tool(plain.id, name, { vaultId: vault.id });
      expect(JSON.stringify(result.value)).not.toMatch(/v-dev|v-staging|comment-xyz/);
    }
    // REST returns the value (and the secret's comment) at read level: the plan's CI path.
    expect((await rest(plain.token, "GET", valuePath(vault, secret.id, "dev"))).body.value).toMatchObject({ value: "v-dev-2", comment: "value-comment-xyz" });
    expect((await rest(plain.token, "GET", `/vault/vaults/${vault.id}/secrets/${secret.id}`)).body.secret.comment).toBe("secret-comment-xyz");
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }], { allowMcpValueReads: true });
    const one = await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev });
    expect(one.value.value.value).toBe("v-dev-2");
    expect(JSON.stringify(one.value)).not.toContain("v-staging");
  });

  test("FINDING (LOW): one MCP value read costs two reads in the key's read buckets and records a comment read, even when the value itself is refused", async () => {
    const owner = await createUser("R27 double charge");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "DOUBLE", { dev: "d" }, { comment: "c" });
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }], { allowMcpValueReads: true });
    expect((await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev })).value.value.value).toBe("d");
    const bucket = (name: string) => (db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`${name}:${flagged.id}`) as { count: number } | null)?.count ?? 0;
    expect(bucket("keyRead")).toBe(2);
    expect(bucket("keyMcpValue")).toBe(1);
    // A value the key cannot read (staging is not granted): the comment was still opened, charged, and audited.
    resetVaultLimits();
    const refused = await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.staging });
    expect(refused.value.code).toBe("NOT_FOUND");
    expect(bucket("keyRead")).toBe(1);
    const commentReads = db.query("SELECT COUNT(*) AS count FROM vault_events WHERE key_id = ? AND event = 'comment.read'").get(flagged.id) as { count: number };
    expect(commentReads.count).toBe(2);
  });

  test("HEAD on a value is a full audited read whose body the client never gets", async () => {
    const owner = await createUser("R27 head");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "HEADED", { dev: "head-value" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const head = await fetch(`${origin}/api/v1${valuePath(vault, secret.id, "dev")}`, { method: "HEAD", headers: { Authorization: `Bearer ${key.token}` } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toContain("no-store");
    expect((db.query("SELECT COUNT(*) AS count FROM vault_events WHERE key_id = ? AND event = 'value.read'").get(key.id) as { count: number }).count).toBe(1);
  });

  test("canary: values and comments sent through REST and MCP never reach any table in plaintext, the database file or its WAL, or the server's console", async () => {
    const owner = await createUser("R27 canary");
    const vault = await newVault(owner);
    const canary = `NOOK-CANARY-${crypto.randomUUID()}`;
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }], { allowMcpValueReads: true });
    const captured: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const name of ["log", "error", "warn", "info"] as const) console[name] = (...args: unknown[]) => { captured.push(args.map((arg) => arg instanceof Error ? `${arg.name}:${arg.message}:${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); };
    const bodies: string[] = [];
    try {
      const created = await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "R27_CANARY", comment: `${canary}-sc`, tags: ["canary"], values: { [vault.envs.dev!]: { value: canary, comment: `${canary}-vc` } } });
      expect(created.status).toBe(201);
      bodies.push(created.text);
      const secretId = created.body.secret.id as string;
      bodies.push((await rest(key.token, "PUT", `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs.dev}`, { value: `${canary}-w`, comment: `${canary}-wc`, expectedVersion: 1 })).text);
      bodies.push((await rest(key.token, "PUT", `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs.staging}`, { value: `${canary}-login`, expectedVersion: 5 })).text);
      bodies.push((await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "R27_CANARY_LOGIN", type: "login", values: { [vault.envs.dev!]: { value: `${canary}-not-json` } } })).text);
      bodies.push((await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: `${canary}\u0007` })).text);
      bodies.push((await rest(key.token, "PUT", `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs.dev}`, `{"value":"${canary}-broken`)).text);
      bodies.push(JSON.stringify((await tool(key.id, "write_secret_value", { vaultId: vault.id, secretId, envId: vault.envs.dev, value: `${canary}-m`, comment: `${canary}-mc`, expectedVersion: 2 })).value));
      bodies.push(JSON.stringify((await tool(key.id, "write_secret_value", { vaultId: vault.id, secretId, envId: vault.envs.dev, value: `${canary}-stale`, expectedVersion: 1 })).value));
      bodies.push(JSON.stringify((await tool(key.id, "create_secret", { vaultId: vault.id, name: "R27_CANARY_2", tags: [`bad tag ${canary}`], values: [{ envId: vault.envs.dev, value: `${canary}-t` }] })).value));
      bodies.push(JSON.stringify((await tool(key.id, "create_secret", { vaultId: vault.id, name: "R27_CANARY_3", type: "login", values: [{ envId: vault.envs.dev, value: `${canary}-l` }] })).value));
      expect((await tool(key.id, "read_secret", { vaultId: vault.id, secretId, envId: vault.envs.dev })).value.value.value).toBe(`${canary}-m`);
      expect((await rest(key.token, "GET", `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs.dev}`)).body.value.value).toBe(`${canary}-m`);
    } finally {
      Object.assign(console, originals);
    }
    for (const body of bodies) expect(body).not.toContain(canary);
    expect(captured.join("\n")).not.toContain(canary);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of tables) {
      const leaked = JSON.stringify(db.query(`SELECT * FROM "${table}"`).all()).includes(canary);
      expect({ table, leaked }).toEqual({ table, leaked: false });
    }
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (const path of [config.databasePath, `${config.databasePath}-wal`]) {
      if (!existsSync(path)) continue;
      expect({ path, leaked: readFileSync(path).includes(Buffer.from(canary)) }).toEqual({ path, leaked: false });
    }
  });
});

// ------------------------------------------------------------------------------------------------
// 4. REST v1 conformance and per-key limits

describe("review 27: REST conformance and per-key limits (T183, T194, T195)", () => {
  test("every refusal is JSON with a code and no-store; the vault routes answer 401 before telling a general key's holder anything", async () => {
    const owner = await createUser("R27 rest codes");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const cases = [
      await rest(null, "GET", `/vault/vaults/${vault.id}`),
      await rest("nkv_" + "x".repeat(43), "GET", `/vault/vaults/${vault.id}`),
      await rest(null, "GET", `/vault/vaults?token=${key.token}`),
      await rest(null, "GET", `/vault/${key.token}`),
      await rest(key.token, "GET", `/vault/vaults/${crypto.randomUUID()}`),
      await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "x" }),
      await rest(key.token, "OPTIONS", `/vault/vaults`)
    ];
    for (const response of cases) {
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(response.headers.get("cache-control") ?? "").toContain("no-store");
      expect(typeof response.body.code).toBe("string");
      expect(response.text).not.toContain(key.token);
    }
    expect(cases.map((response) => response.body.code)).toEqual(["AUTH_REQUIRED", "KEY_INVALID", "KEY_IN_URL", "KEY_IN_URL", "NOT_FOUND", "VAULT_LEVEL", "METHOD_NOT_ALLOWED"]);
    // A read key's POST is refused by level, and nothing was created.
    expect(db.query("SELECT 1 FROM vault_secrets WHERE vault_id = ? AND name = 'x'").get(vault.id)).toBeNull();
  });

  test("the key's buckets are its own: 20 reads a minute, 10 writes a minute, persisted in SQLite; the creator's session budget and the key's do not touch", async () => {
    const owner = await createUser("R27 buckets");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "BUCKET", { dev: "b0" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) statuses.push((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).status);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    const row = db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`keyRead:${key.id}`) as { count: number };
    expect(row.count).toBe(20);
    expect(db.query("SELECT 1 FROM vault_rate_limits WHERE bucket = ?").get(`read:${owner.userId}`)).toBeNull();
    // The creator's session reads freely and charges only the person's bucket.
    expect((await call(owner, "GET", sessionValuePath(vault, secret.id, "dev"))).status).toBe(200);
    expect((db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`read:${owner.userId}`) as { count: number }).count).toBe(1);
    expect((db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`keyRead:${key.id}`) as { count: number }).count).toBe(20);
    // Writes: 10 a minute.
    let version = 1;
    const sessionWrites = () => (db.query("SELECT count FROM vault_rate_limits WHERE bucket = ?").get(`write:${owner.userId}`) as { count: number } | null)?.count ?? 0;
    const sessionWritesBefore = sessionWrites();
    const writes: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: `b${index + 1}`, expectedVersion: version });
      writes.push(response.status);
      if (response.status === 200) version = response.body.value.version;
    }
    expect(writes.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(writes[10]).toBe(429);
    expect(sessionWrites()).toBe(sessionWritesBefore);
    // A refused write writes nothing.
    expect((db.query("SELECT version FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secret.id, vault.envs.dev) as { version: number }).version).toBe(version);
    // Hourly and daily buckets hold too (seeded to their limit).
    resetVaultLimits();
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    db.query("INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 1000, 0)").run(`keyReadHour:${key.id}`, hour);
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).status).toBe(429);
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    db.query("INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 200, 0)").run(`keyWriteDay:${key.id}`, day);
    const refused = await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "day", expectedVersion: version });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(3600);
  });

  test("the limit alert is throttled: one access event per key per 10 minutes and one bell notice a day, however many refusals", async () => {
    const owner = await createUser("R27 alert");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "ALERT", { dev: "a" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    db.query("INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 20, 0)").run(`keyRead:${key.id}`, minute);
    for (let index = 0; index < 5; index += 1) expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).status).toBe(429);
    expect((db.query("SELECT COUNT(*) AS count FROM access_events WHERE key_id = ? AND action = 'key.vault.limited'").get(key.id) as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM vault_events WHERE key_id = ? AND event = 'key.limited'").get(key.id) as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM access_notices WHERE key_id = ? AND kind = 'key_vault_limited'").get(key.id) as { count: number }).count).toBe(1);
    // After the in-memory throttle resets (a restart), the access event may repeat but the bell does not.
    resetKeyAlertsForTests();
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).status).toBe(429);
    expect((db.query("SELECT COUNT(*) AS count FROM access_notices WHERE key_id = ? AND kind = 'key_vault_limited'").get(key.id) as { count: number }).count).toBe(1);
  });
});

describe("review 27: detection below the limits (T183, V-O6)", () => {
  // FINDING (MEDIUM): V-O6 records the operator's decision "alert the creator after 500 value reads a
  // day"; Wave 27 decision 4 replaced it with an alert only when a per-key limit refuses a call. A
  // stolen key paced under 20 a minute and 1,000 an hour reads up to 24,000 values a day (a whole
  // 1,000-secret x 20-environment vault in about 20 hours) and its creator hears nothing.
  test.failing("a key that reads more than 500 values in a day without ever hitting a limit alerts its creator", async () => {
    const owner = await createUser("R27 paced thief");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "PACED", { dev: "p" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    for (let index = 0; index < 510; index += 1) {
      // Each batch of 15 stands for a minute passing: the per-minute buckets are cleared, the hourly one is kept.
      if (index % 15 === 0) {
        db.query("DELETE FROM vault_rate_limits WHERE bucket = ?").run(`keyRead:${key.id}`);
        resetMcpLimits();
      }
      const response = await rest(key.token, "GET", valuePath(vault, secret.id, "dev"));
      expect(response.status).toBe(200);
    }
    expect((db.query("SELECT COUNT(*) AS count FROM vault_events WHERE key_id = ? AND event = 'value.read'").get(key.id) as { count: number }).count).toBe(510);
    const alerts = db.query("SELECT COUNT(*) AS count FROM access_notices WHERE key_id = ? AND user_id = ?").get(key.id, owner.userId) as { count: number };
    expect(alerts.count).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------
// 5. Key lifecycle

describe("review 27: key lifecycle (D217, D277, D278)", () => {
  test("creation and rotation check every refusal before the password, so a wrong password never outranks a refusal (no code is consumed)", async () => {
    const owner = await createUser("R27 order owner");
    const member = await createUser("R27 order member");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    const wrong = { password: "definitely-not-the-password" };
    const post = (body: Record<string, unknown>) => keysApi(member, "POST", "", { name: "Order", kind: "vault", ...wrong, ...body });
    expect((await post({ grants: [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }] })).body.code).toBe("GRANT_EXCEEDS_ACCESS");
    expect((await post({ grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }] })).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await post({ grants: [{ module: "vault", permission: "read", vaultId: vault.id }], expiresInDays: null })).body.code).toBe("EXPIRY_REQUIRED");
    expect((await post({ grants: [{ module: "vault", permission: "read", vaultId: vault.id }, { module: "notes", permission: "read" }] })).body.code).toBe("KEY_KIND_WALL");
    const ownerPost = (body: Record<string, unknown>) => keysApi(owner, "POST", "", { name: "Order", kind: "vault", ...wrong, ...body });
    expect((await ownerPost({ grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }] })).body.code).toBe("PROTECTED_ACCESS_REQUIRED");
    // Only then the password.
    expect((await post({ grants: [{ module: "vault", permission: "read", vaultId: vault.id }] })).body.code).toBe("REAUTH_FAILED");
    // Rotation: the vault checks come first too.
    const key = await vaultKey(member, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    expect((await keysApi(member, "POST", `/${key.id}/rotate`, { graceHours: 0, expiresInDays: null, ...wrong })).body.code).toBe("EXPIRY_REQUIRED");
    expect((await keysApi(member, "POST", `/${key.id}/rotate`, { graceHours: 0, grants: [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }], ...wrong })).body.code).toBe("GRANT_EXCEEDS_ACCESS");
    expect((await keysApi(member, "POST", `/${key.id}/rotate`, { graceHours: 0, ...wrong })).body.code).toBe("REAUTH_FAILED");
  });

  test("rotation re-validates: a flag asked for on a rotation without a protected grant is not stored; a rotated key's old token stops at once with no grace", async () => {
    const owner = await createUser("R27 rotate");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "ROT", { dev: "r" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const rotated = await keysApi(owner, "POST", `/${key.id}/rotate`, { graceHours: 0, protectedAccess: true, allowMcpValueReads: true, password: owner.password });
    expect(rotated.status).toBe(201);
    expect(rotated.body.key.vault).toEqual({ allowMcpValueReads: true, protectedAccess: false });
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).body.code).toBe("KEY_INVALID");
    expect((await rest(rotated.body.key.token, "GET", valuePath(vault, secret.id, "dev"))).body.value.value).toBe("r");
    const days = Math.round((Date.parse(rotated.body.key.expiresAt) - Date.parse(rotated.body.key.createdAt)) / 86_400_000);
    expect(days).toBeLessThanOrEqual(365);
  });

  // FINDING (LOW): narrowing "every environment" to one checks only that the id is an environment
  // "of" the grant, not that it exists in that vault; 038's VAULT_GRANT_SHAPE trigger then refuses
  // the row and the request ends as a 500 INTERNAL (fail-closed: the transaction rolls back).
  test.failing("narrowing to an environment of another vault, or to no environment at all, is a 400, not a 500", async () => {
    const owner = await createUser("R27 narrow foreign");
    const vault = await newVault(owner);
    const other = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    for (const envId of [other.envs.dev, crypto.randomUUID()]) {
      const response = await keysApi(owner, "PATCH", `/${key.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId }] });
      expect(response.status).toBe(400);
    }
  });

  test("the refused narrowing above leaves the key exactly as it was (the database wall holds)", async () => {
    const owner = await createUser("R27 narrow foreign held");
    const vault = await newVault(owner);
    const other = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const response = await keysApi(owner, "PATCH", `/${key.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: other.envs.dev }] });
    expect(response.status).toBe(500);
    expect(db.query("SELECT resource_id, env_id FROM api_key_grants WHERE key_id = ?").all(key.id)).toEqual([{ resource_id: vault.id, env_id: null }]);
  });

  test("a key never borrows its creator's protected-environment window (D226)", async () => {
    const owner = await createUser("R27 no borrowed window");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "WINDOW", { prod: "w-prod" });
    await unlock(owner);
    expect((await call(owner, "GET", sessionValuePath(vault, secret.id, "prod"))).status).toBe(200);
    const named = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }], { allowMcpValueReads: true });
    expect((await rest(named.token, "GET", valuePath(vault, secret.id, "prod"))).status).toBe(404);
    expect((await tool(named.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.prod })).value.code).toBe("NOT_FOUND");
  });

  test("team policy: surfaces, the lifetime cap, and the key count bind vault keys; the per-role module list does not list the vault", async () => {
    const admin = await createUser("R27 policy admin");
    setRole(admin, "admin");
    const owner = await createUser("R27 policy owner");
    const vault = await newVault(owner);
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyMaxDays: 30, keyDefaultDays: 30, keysPerUser: 2 }, policiesRevision());
    const first = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    expect(Math.round((Date.parse(first.key.expiresAt) - Date.parse(first.key.createdAt)) / 86_400_000)).toBe(30);
    expect((await keysApi(owner, "POST", "", { name: "Long", kind: "vault", expiresInDays: 60, grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: owner.password })).body.code).toBe("KEY_POLICY");
    await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    expect((await keysApi(owner, "POST", "", { name: "Third", kind: "vault", grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: owner.password })).body.code).toBe("KEY_LIMIT");
    // REST taken away from members: the vault key stops on REST at once.
    resetPoliciesForTests();
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, restRoles: ["admin"] }, policiesRevision());
    expect((await rest(first.token, "GET", "/vault/vaults")).body.code).toBe("KEY_POLICY");
  });

  test("a Team admin revokes a vault key from Team → Keys and it stops at once, over REST and MCP", async () => {
    const admin = await createUser("R27 admin revoke admin");
    setRole(admin, "admin");
    const owner = await createUser("R27 admin revoke owner");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const revoked = await request(`/team/keys/${key.id}/revoke`, { method: "POST", body: JSON.stringify({ reason: "Leaked in a CI log" }) }, admin);
    expect(revoked.status).toBe(200);
    expect((await rest(key.token, "GET", "/vault/vaults")).body.code).toBe("KEY_INVALID");
    expect((await tool(key.id, "list_vaults", {})).isError).toBe(true);
    expect((await mcp(key.token, "tools/list")).status).toBe(401);
  });

  test("FINDING (LOW): Team → Keys hides vault names from admins but still lists each vault's and environment's id", async () => {
    const admin = await createUser("R27 inventory admin");
    setRole(admin, "admin");
    const owner = await createUser("R27 inventory owner");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    const body = await (await request("/team/keys?kind=vault", {}, admin)).json() as { keys: Array<{ id: string; grants: Array<{ resource: { id: string; name: string | null } | null; env?: { id: string; name: string | null } | null }> }> };
    const found = body.keys.find((item) => item.id === key.id)!;
    expect(found.grants[0]!.resource).toMatchObject({ id: vault.id, name: null });
    expect(found.grants[0]!.env).toMatchObject({ id: vault.envs.dev, name: null });
    // The admin still gets the vault's 404.
    expect((await call(admin, "GET", `/vaults/${vault.id}`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------
// 6. Migration 038

describe("review 27: migration 038", () => {
  test("applies after 037, re-runs as a no-op, and lands correctly on a database that got 031, 037, and 038 after 032–036", () => {
    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON");
    runMigrations(fresh);
    fresh.transaction(() => vaultKeysMigration.up(fresh))();
    fresh.transaction(() => vaultKeysMigration.up(fresh))();
    const triggers = (database: Database) => (database.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'api_keys_vault_%' OR name LIKE 'api_key_grants_vault_%') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(triggers(fresh)).toEqual(["api_key_grants_vault_shape", "api_key_grants_vault_shape_update", "api_keys_vault_flags_insert", "api_keys_vault_flags_widen", "api_keys_vault_person_only"]);
    expect(registeredMigrationIds.indexOf(38)).toBe(registeredMigrationIds.indexOf(37) + 1);
    fresh.close();

    // Late vault: 032–036 first (031, 037, 038 marked as not yet applied), then the rest.
    const late = new Database(":memory:", { strict: true });
    late.exec("PRAGMA foreign_keys = ON");
    late.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const id of [31, 37, 38]) late.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, 'placeholder', 'x')").run(id);
    runMigrations(late);
    late.exec("DELETE FROM schema_migrations WHERE id IN (31, 37, 38)");
    runMigrations(late);
    expect(triggers(late)).toEqual(["api_key_grants_vault_shape", "api_key_grants_vault_shape_update", "api_keys_vault_flags_insert", "api_keys_vault_flags_widen", "api_keys_vault_person_only"]);
    const columns = (late.query("PRAGMA table_info(mcp_api_keys)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain("vault_protected_access");
    late.close();
  });
});

// ------------------------------------------------------------------------------------------------
// 7. Cross-wave (A–C) with key actors

describe("review 27: cross-wave invariants with key actors", () => {
  test("a data-key rotation in progress never shows a key VAULT_INTEGRITY: reads over REST and MCP work at every step", async () => {
    pauseRotationRunnerForTests(true);
    const owner = await createUser("R27 rotation");
    const vault = await newVault(owner);
    const secrets = [];
    for (let index = 0; index < 3; index += 1) secrets.push(await newSecret(owner, vault, `ROT_${index}`, { dev: `rd${index}` }, { comment: `rc${index}` }));
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }], { allowMcpValueReads: true });
    const readAll = async () => {
      resetVaultLimits();
      for (const [index, secret] of secrets.entries()) {
        const viaRest = await rest(key.token, "GET", valuePath(vault, secret.id, "dev"));
        expect(viaRest.body.value?.value ?? viaRest.body.code).toBe(index === 0 && written ? "rd0-new" : `rd${index}`);
        const viaMcp = await tool(key.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev });
        expect(viaMcp.value.secret?.comment ?? viaMcp.value.code).toBe(`rc${index}`);
      }
    };
    let written = false;
    expect((await call(owner, "POST", `/vaults/${vault.id}/rotate`, {})).status).toBe(200);
    expect(reencryptBatch(vault.id, 1).moved).toBe(1);
    await readAll();
    const version = (await rest(key.token, "GET", valuePath(vault, secrets[0]!.id, "dev"))).body.value.version;
    expect((await rest(key.token, "PUT", valuePath(vault, secrets[0]!.id, "dev"), { value: "rd0-new", expectedVersion: version })).status).toBe(200);
    written = true;
    for (let pass = 0; pass < 100 && !rotationStatus(vault.id).done; pass += 1) {
      reencryptBatch(vault.id, 1);
      runRotationPass(0);
      await readAll();
    }
    runRotationPass(1);
    expect(rotationStatus(vault.id).done).toBe(true);
    await readAll();
    expect(db.query("SELECT 1 FROM vault_events WHERE vault_id = ? AND event = 'integrity.fail'").get(vault.id)).toBeNull();
  });

  test("Activity attribution comes from the server: the key id and creator are recorded, and a key's name is shown live (a rename re-labels old events)", async () => {
    const owner = await createUser("R27 attribution owner");
    const member = await createUser("R27 attribution member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "ATTR", { dev: "a" });
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    const key = await vaultKey(member, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).status).toBe(200);
    const row = db.query("SELECT actor_id, key_id, via FROM vault_events WHERE vault_id = ? AND event = 'value.read' AND key_id IS NOT NULL").get(vault.id);
    expect(row).toEqual({ actor_id: member.userId, key_id: key.id, via: "api" });
    // The creator renames the key to look like someone else's session: the actor stays the creator.
    expect((await keysApi(member, "PATCH", `/${key.id}`, { name: "R27 attribution owner (session)" })).status).toBe(200);
    const events = (await call(owner, "GET", `/vaults/${vault.id}/events?event=apikeys`)).body.events as Array<any>;
    const read = events.find((event) => event.event === "value.read");
    expect(read).toMatchObject({ via: "api", actor: { displayName: "R27 attribution member" }, key: { name: "R27 attribution owner (session)" } });
  });

  test("Keys with access: a member who is not an owner sees the count and only their own keys; a stranger and an admin outside get 404", async () => {
    const owner = await createUser("R27 kwa owner");
    const member = await createUser("R27 kwa member");
    const stranger = await createUser("R27 kwa stranger");
    const admin = await createUser("R27 kwa admin");
    setRole(admin, "admin");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: member, levels: { dev: "admin" } }]);
    const ownerKey = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    await vaultKey(member, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    const memberView = (await call(member, "GET", `/vaults/${vault.id}/keys`)).body;
    expect(memberView.count).toBe(2);
    expect(JSON.stringify(memberView)).not.toContain(ownerKey.id);
    expect(JSON.stringify(memberView)).not.toContain(ownerKey.key.name);
    for (const outsider of [stranger, admin]) expect((await call(outsider, "GET", `/vaults/${vault.id}/keys`)).status).toBe(404);
    // Protected levels a member cannot see never show in the owner's key list for them either.
    const ownerView = (await call(owner, "GET", `/vaults/${vault.id}/keys`)).body;
    expect(ownerView.keys.find((item: any) => item.id === ownerKey.id).levels[vault.envs.prod!]).toBeUndefined();
  });
});

