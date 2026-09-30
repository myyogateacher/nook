import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits, setRole, share, type TestVault } from "./support/vault";

const { createApiKey, flushKeyUsage, resetKeyDenialsForTests } = await import("../server/apiKeys");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { invokeVaultToolForTests, vaultToolSpecs } = await import("../server/vault/mcpTools");
const { resetKeyAlertsForTests } = await import("../server/vault/keyApi");
const { mcpToolSpecs } = await import("../server/mcpTools");

/**
 * Wave 27 (Vault C): `nkv_` vault keys (D217–D221; access plan D264, D278, T217), REST
 * `/api/v1/vault/*` (T183, T184), the vault MCP tools (T191, T192), per-key limits and the alert,
 * key actors in Activity, "Keys with access", and the kind wall in both directions.
 */

beforeEach(() => {
  resetVaultLimits();
  resetMcpLimits();
  resetKeyRouteLimits();
  resetKeyAlertsForTests();
  resetKeyDenialsForTests();
});

type VaultGrantBody = { module: "vault"; permission: "read" | "write"; vaultId: string; envId?: string | null };

async function keysApi(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/keys${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

/** Creates a vault key through `POST /api/keys` (the test accounts sign in with a password only). */
async function vaultKey(session: Session, grants: VaultGrantBody[], extra: Record<string, unknown> = {}) {
  const created = await keysApi(session, "POST", "", { name: `Vault key ${crypto.randomUUID().slice(0, 6)}`, kind: "vault", surfaces: "both", grants, password: session.password, ...extra });
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
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string; description: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: unknown };
}
const toolNames = async (token: string) => ((await mcp(token, "tools/list")).result?.tools ?? []).map((tool) => tool.name).sort();

async function tool(keyId: string, name: string, args: Record<string, unknown>) {
  const result = await invokeVaultToolForTests(name, args, keyId);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

const valuePath = (vault: TestVault, secretId: string, slug: string) => `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs[slug]}`;

describe("creating vault keys (D217, D264, T217)", () => {
  test("a vault key is nkv_, expires (90 days by default, 365 at most), and holds vault grants only; the wall holds both ways at the API", async () => {
    const owner = await createUser("VK create");
    const vault = await newVault(owner);
    const created = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    expect(created.token.startsWith("nkv_")).toBe(true);
    expect(created.key.kind).toBe("vault");
    expect(created.key.vault).toEqual({ allowMcpValueReads: false, protectedAccess: false });
    const days = Math.round((Date.parse(created.key.expiresAt) - Date.parse(created.key.createdAt)) / 86_400_000);
    expect(days).toBe(90);
    expect(created.key.grants[0]).toMatchObject({ module: "vault", permission: "read", resource: { kind: "vault", id: vault.id, name: expect.any(String) }, env: null, active: true });

    // General grants on a vault key, vault grants on a general key, and a vault key without expiry.
    const mixed = await keysApi(owner, "POST", "", { name: "Mixed", kind: "vault", grants: [{ module: "vault", permission: "read", vaultId: vault.id }, { module: "notes", permission: "read" }], password: owner.password });
    expect(mixed).toMatchObject({ status: 400, body: { code: "KEY_KIND_WALL" } });
    const general = await keysApi(owner, "POST", "", { name: "General", grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: owner.password });
    expect(general).toMatchObject({ status: 400, body: { code: "KEY_KIND_WALL" } });
    const flags = await keysApi(owner, "POST", "", { name: "Flags", grants: [{ module: "notes", permission: "read" }], allowMcpValueReads: true, password: owner.password });
    expect(flags.status).toBe(400);
    const forever = await keysApi(owner, "POST", "", { name: "Forever", kind: "vault", expiresInDays: null, grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: owner.password });
    expect(forever).toMatchObject({ status: 400, body: { code: "EXPIRY_REQUIRED" } });
    const tooLong = await keysApi(owner, "POST", "", { name: "Long", kind: "vault", expiresInDays: 366, grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: owner.password });
    expect(tooLong.status).toBe(400);
    // The module name alone (the general grant shape) is not a vault grant.
    const shapeless = await keysApi(owner, "POST", "", { name: "Shape", kind: "vault", grants: [{ module: "vault", permission: "read" }], password: owner.password });
    expect(shapeless.status).toBe(400);
    // Re-authentication is required, and checked after every other refusal.
    const noPassword = await keysApi(owner, "POST", "", { name: "No password", kind: "vault", grants: [{ module: "vault", permission: "read", vaultId: vault.id }] });
    expect(noPassword).toMatchObject({ status: 401, body: { code: "REAUTH_FAILED" } });
  });

  test("the database refuses mixed kinds, vault flags on general keys, widening flags, foreign environments, and integration-owned vault keys", async () => {
    const owner = await createUser("VK wall db");
    const vault = await newVault(owner);
    const other = await newVault(owner);
    const general = createApiKey(owner.userId, { name: "General", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const vaultOne = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const at = new Date().toISOString();
    const grant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    expect(() => grant.run(crypto.randomUUID(), general.id, "vault", "read", "vault", vault.id, null, at)).toThrow(/KEY_KIND_WALL/);
    expect(() => grant.run(crypto.randomUUID(), vaultOne.id, "notes", "read", null, null, null, at)).toThrow(/KEY_KIND_WALL/);
    expect(() => grant.run(crypto.randomUUID(), vaultOne.id, "vault", "read", "vault", vault.id, other.envs.dev, at)).toThrow(/VAULT_GRANT_SHAPE/);
    expect(() => grant.run(crypto.randomUUID(), vaultOne.id, "vault", "create", "vault", vault.id, null, at)).toThrow();
    expect(() => grant.run(crypto.randomUUID(), vaultOne.id, "vault", "read", null, null, null, at)).toThrow();
    expect(() => db.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 1 WHERE id = ?").run(vaultOne.id)).toThrow(/WIDENING_NOT_ALLOWED/);
    expect(() => db.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 1 WHERE id = ?").run(general.id)).toThrow();
    expect(() => db.query("UPDATE mcp_api_keys SET kind = 'general' WHERE id = ?").run(vaultOne.id)).toThrow(/KEY_KIND_FIXED/);
    const integration = crypto.randomUUID();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES (?, ?, 'Robot', '!', ?, 'member', 'service')").run(integration, `${integration}@integration.invalid`, at);
    expect(() => db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, kind, expires_at) VALUES (?, ?, 'x', 'nkv_abcdefghijkl', ?, '[]', ?, 'vault', ?)")
      .run(crypto.randomUUID(), integration, crypto.randomUUID(), at, at)).toThrow(/PERSON_ONLY/);
  });

  test("grants must sit within the creator's current access; a protected environment needs protectedAccess and an explicit grant", async () => {
    const owner = await createUser("VK within owner");
    const member = await createUser("VK within member");
    const stranger = await createUser("VK within stranger");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: member, levels: { dev: "write", staging: "read" } }]);
    const body = (grants: VaultGrantBody[], extra: Record<string, unknown> = {}) => ({ name: "Within", kind: "vault", grants, password: member.password, ...extra });
    expect((await keysApi(member, "POST", "", body([{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.staging }]))).body.code).toBe("GRANT_EXCEEDS_ACCESS");
    expect((await keysApi(member, "POST", "", body([{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }]))).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await keysApi(stranger, "POST", "", { ...body([{ module: "vault", permission: "read", vaultId: vault.id }]), password: stranger.password })).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await keysApi(member, "POST", "", body([{ module: "vault", permission: "read", vaultId: crypto.randomUUID() }]))).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await vaultKey(member, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }])).key.kind).toBe("vault");

    // Owners: prod is protected; naming it needs the flag, and "every environment" never covers it.
    expect((await keysApi(owner, "POST", "", { ...body([{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }]), password: owner.password })).body.code).toBe("PROTECTED_ACCESS_REQUIRED");
    const everything = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }], { protectedAccess: true });
    // The flag is kept only when a grant names a protected environment.
    expect(everything.key.vault.protectedAccess).toBe(false);
    const secret = await newSecret(owner, vault, "DB_URL", { dev: "dev-db", prod: "prod-db" });
    expect((await rest(everything.token, "GET", `${valuePath(vault, secret.id, "dev")}`)).body.value.value).toBe("dev-db");
    expect((await rest(everything.token, "GET", `${valuePath(vault, secret.id, "prod")}`)).status).toBe(404);
    const listed = await rest(everything.token, "GET", `/vault/vaults/${vault.id}`);
    expect(listed.body.vault.environments.map((env: any) => env.slug)).toEqual(["dev", "staging"]);
    const prodKey = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }], { protectedAccess: true });
    expect(prodKey.key.vault.protectedAccess).toBe(true);
    expect(prodKey.key.grants[0].env).toMatchObject({ id: vault.envs.prod, protected: true });
    // No session window is needed for a key: the creation re-authenticated for it.
    expect((await rest(prodKey.token, "GET", `${valuePath(vault, secret.id, "prod")}`)).body.value.value).toBe("prod-db");
    expect((await rest(prodKey.token, "GET", `${valuePath(vault, secret.id, "dev")}`)).status).toBe(404);
    // Marking another environment protected cuts off a key without the flag at once.
    await call(owner, "PATCH", `/vaults/${vault.id}/environments/${vault.envs.dev}`, { protected: true });
    expect((await rest(everything.token, "GET", `${valuePath(vault, secret.id, "dev")}`)).status).toBe(404);
  });

  test("integrations cannot hold vault keys", async () => {
    const admin = await createUser("VK integration admin");
    setRole(admin, "admin");
    const created = await request("/team/integrations", { method: "POST", body: JSON.stringify({ name: "CI robot", role: "member" }) }, admin);
    expect(created.status).toBe(201);
    const integration = (await created.json() as { integration: { id: string } }).integration;
    const vault = await newVault(admin);
    const response = await request(`/team/integrations/${integration.id}/keys`, { method: "POST", body: JSON.stringify({ name: "vault", kind: "vault", grants: [{ module: "vault", permission: "read", vaultId: vault.id }], password: admin.password }) }, admin);
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("INTEGRATION_NOT_ALLOWED");
  });
});

describe("effective rights recomputed on every call (D218, T182)", () => {
  test("the creator losing a level, an environment, or the vault narrows the key at once; a blocked creator disables it", async () => {
    const owner = await createUser("VK live owner");
    const member = await createUser("VK live member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "API_TOKEN", { dev: "d1", staging: "s1" });
    await share(owner, vault, [{ session: member, levels: { dev: "write", staging: "read" } }]);
    const key = await vaultKey(member, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }]);
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "d2", expectedVersion: 1 })).status).toBe(200);
    // Lowered to read on dev: writes stop, reads go on.
    await share(owner, vault, [{ session: member, levels: { dev: "read", staging: "read" } }]);
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "d3", expectedVersion: 2 })).body.code).toBe("VAULT_LEVEL");
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).body.value.value).toBe("d2");
    // Staging taken away: the key no longer sees it.
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "staging"))).status).toBe(404);
    // The key list marks what no longer works.
    const listed = (await keysApi(member, "GET", "")).body.keys.find((item: any) => item.id === key.id);
    expect(listed.grants.find((grant: any) => grant.env?.id === vault.envs.staging)).toMatchObject({ active: false, inactiveReason: "no-access" });
    // Removed from the vault: the vault is gone for the key.
    await share(owner, vault, []);
    expect((await rest(key.token, "GET", `/vault/vaults/${vault.id}`)).status).toBe(404);
    expect((await rest(key.token, "GET", "/vault/vaults")).body.vaults).toEqual([]);
    // Blocked: the key stops authenticating.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), member.userId);
    expect((await rest(key.token, "GET", "/vault/vaults")).body.code).toBe("KEY_INVALID");
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(member.userId);
  });

  test("the role caps the key: a viewer creates read keys only, and a demoted member's write key reads", async () => {
    const owner = await createUser("VK role owner");
    const member = await createUser("VK role member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "ROLE_SECRET", { dev: "v1" });
    await share(owner, vault, [{ session: member, levels: { dev: "write" } }]);
    const key = await vaultKey(member, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }]);
    setRole(member, "viewer");
    // Team policy keeps REST for admins and members by default; the viewer's key still works over MCP, read-only.
    expect((await rest(key.token, "GET", valuePath(vault, secret.id, "dev"))).body.code).toBe("KEY_POLICY");
    expect((await tool(key.id, "write_secret_value", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev, value: "v2", expectedVersion: 1 })).value.code).toBe("SCOPE_REQUIRED");
    expect((await tool(key.id, "read_vault", { vaultId: vault.id })).value.vault.environments).toEqual([expect.objectContaining({ slug: "dev", level: "read" })]);
    expect(await toolNames(key.token)).toEqual(["list_secrets", "list_vaults", "read_secret", "read_vault"]);
    expect((await keysApi(member, "POST", "", { name: "Viewer write", kind: "vault", grants: [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }], password: member.password })).body.code).toBe("SCOPE_NOT_ALLOWED");
    expect((await vaultKey(member, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }], { surfaces: "mcp" })).key.kind).toBe("vault");
    setRole(member, "guest");
    // A guest reaches nothing: the key answers, empty (guests are never vault members, V-O3).
    expect((await tool(key.id, "list_vaults", {})).value.vaults).toEqual([]);
    expect((await tool(key.id, "read_vault", { vaultId: vault.id })).value.code).toBe("NOT_FOUND");
    setRole(member, "member");
  });

  test("purging a vault empties the key's grants; the key stays, reaching nothing", async () => {
    const owner = await createUser("VK purge");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    db.query("DELETE FROM vaults WHERE id = ?").run(vault.id);
    expect((db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = ?").get(key.id) as { count: number }).count).toBe(0);
    expect(db.query("SELECT 1 FROM mcp_api_keys WHERE id = ? AND revoked_at IS NULL").get(key.id)).toBeTruthy();
    expect((await rest(key.token, "GET", "/vault/vaults")).body.vaults).toEqual([]);
  });
});

describe("REST /api/v1/vault (D220, T183, T184)", () => {
  test("Bearer only, JSON only, keys never in URLs, the wall both ways, and the documented codes", async () => {
    const owner = await createUser("VK rest");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "REST_SECRET", { dev: "rest-dev" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    const general = createApiKey(owner.userId, { name: "General REST", surfaces: "rest", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });

    expect((await rest(null, "GET", "/vault/vaults")).status).toBe(401);
    const cookieOnly = await fetch(`${origin}/api/v1/vault/vaults`, { headers: { Cookie: owner.cookie } });
    expect(cookieOnly.status).toBe(401);
    expect((await rest(null, "GET", `/vault/vaults?key=${key.token}`)).body.code).toBe("KEY_IN_URL");
    expect((await rest(general.token, "GET", "/vault/vaults")).body.code).toBe("KEY_POLICY");
    expect((await rest(key.token, "GET", "/me")).body.code).toBe("KEY_POLICY");
    expect((await rest(key.token, "GET", "/tools")).body.code).toBe("KEY_POLICY");
    expect((await rest(key.token, "POST", "/tools/list_notes", {})).body.code).toBe("KEY_POLICY");
    expect((await rest(key.token, "GET", "/vault/nothing")).status).toBe(404);
    expect((await rest(key.token, "GET", "/vault/vaults/not-a-uuid")).status).toBe(404);
    expect((await rest(key.token, "DELETE", `/vault/vaults/${vault.id}`)).status).toBe(405);
    expect((await rest(key.token, "DELETE", `/vault/vaults/${vault.id}/secrets/${secret.id}`)).status).toBe(405);
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), "value=1", { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), "[1]")).body.code).toBe("INVALID_JSON");
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "x" })).body.code).toBe("INVALID");

    const listed = await rest(key.token, "GET", "/vault/vaults");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toContain("no-store");
    expect(listed.headers.get("access-control-allow-origin")).toBeNull();
    expect(listed.body.vaults.map((item: any) => item.id)).toEqual([vault.id]);
    const secrets = await rest(key.token, "GET", `/vault/vaults/${vault.id}/secrets`);
    expect(secrets.body.secrets.map((item: any) => item.name)).toEqual(["REST_SECRET"]);
    expect(secrets.text).not.toContain("rest-dev");
    const value = await rest(key.token, "GET", valuePath(vault, secret.id, "dev"));
    expect(value.body.value).toMatchObject({ value: "rest-dev", version: 1 });
    expect(value.headers.get("etag")).toBe("\"v1\"");
    // CAS: a stale version writes nothing and names the current one.
    expect((await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "rest-2", expectedVersion: 1 })).body.value.version).toBe(2);
    const stale = await rest(key.token, "PUT", valuePath(vault, secret.id, "dev"), { value: "rest-3", expectedVersion: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "VALUE_CHANGED", currentVersion: 2 } });
    const created = await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "FROM_CI", tags: ["ci"], values: { [vault.envs.dev!]: { value: "ci-value" } } });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain("ci-value");
    expect((await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "FROM_CI" })).body.code).toBe("NAME_TAKEN");
    const versions = await rest(key.token, "GET", `${valuePath(vault, secret.id, "dev")}/versions`);
    expect(versions.body.versions.map((item: any) => item.version)).toEqual([2, 1]);
    expect(versions.text).not.toContain("rest-dev");
    const detail = await rest(key.token, "GET", `/vault/vaults/${vault.id}/secrets/${secret.id}`);
    expect(detail.body.secret).toMatchObject({ name: "REST_SECRET", comment: null });

    // Audit: key actor, via api, never a value.
    const events = db.query("SELECT event, via, key_id, actor_id FROM vault_events WHERE vault_id = ? AND key_id = ? ORDER BY created_at").all(vault.id, key.id) as Array<{ event: string; via: string; key_id: string; actor_id: string }>;
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["apikey.create", "value.read", "value.write", "secret.create"]));
    expect(events.filter((event) => event.event !== "apikey.create").every((event) => event.via === "api" && event.actor_id === owner.userId)).toBe(true);
    const written = db.query("SELECT updated_via_key FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secret.id, vault.envs.dev) as { updated_via_key: string };
    expect(written.updated_via_key).toBe(key.id);
    flushKeyUsage();
    expect((db.query("SELECT SUM(calls + writes) AS calls FROM api_key_surface_usage WHERE key_id = ? AND surface = 'rest'").get(key.id) as { calls: number }).calls).toBeGreaterThan(5);
  });

  test("a vault key limited to MCP cannot use REST, and a revoked key stops at once", async () => {
    const owner = await createUser("VK surfaces");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }], { surfaces: "mcp" });
    expect((await rest(key.token, "GET", "/vault/vaults")).body.code).toBe("KEY_POLICY");
    const restKey = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }], { surfaces: "rest" });
    expect((await rest(restKey.token, "GET", "/vault/vaults")).status).toBe(200);
    expect((await keysApi(owner, "DELETE", `/${restKey.id}`)).status).toBe(200);
    expect((await rest(restKey.token, "GET", "/vault/vaults")).body.code).toBe("KEY_INVALID");
  });
});

describe("vault MCP tools (D221, T191, T192)", () => {
  test("vault keys see only the vault tools; general keys never see them; write tools need a write grant", async () => {
    const owner = await createUser("VK mcp list");
    const vault = await newVault(owner);
    const reader = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const writer = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    const general = createApiKey(owner.userId, { name: "General MCP", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect(await toolNames(reader.token)).toEqual(["list_secrets", "list_vaults", "read_secret", "read_vault"]);
    expect(await toolNames(writer.token)).toEqual(["create_secret", "list_secrets", "list_vaults", "read_secret", "read_vault", "write_secret_value"]);
    const generalTools = await toolNames(general.token);
    for (const spec of vaultToolSpecs) expect(generalTools).not.toContain(spec.name);
    expect(generalTools.length).toBeGreaterThan(0);
    // Calling a vault tool with a general key is refused, as is a write tool with a read key.
    expect((await tool(general.id, "list_vaults", {})).value.code).toBe("SCOPE_REQUIRED");
    expect((await tool(reader.id, "create_secret", { vaultId: vault.id, name: "NOPE" })).value.code).toBe("SCOPE_REQUIRED");
    // Every description states the rules agents need.
    for (const spec of vaultToolSpecs) expect(spec.description).toContain("never repeat them");
    expect(vaultToolSpecs.find((spec) => spec.name === "read_secret")!.description).toContain("allows MCP value reads");
  });

  test("values over MCP only with the flag, a read grant, and the environment named; writes use CAS", async () => {
    const owner = await createUser("VK mcp values");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "MCP_SECRET", { dev: "mcp-dev", staging: "mcp-staging" });
    const noFlag = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }]);
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }], { allowMcpValueReads: true });
    const hidden = await tool(noFlag.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev });
    expect(hidden.isError).toBe(false);
    expect(hidden.value.value).toBeNull();
    expect(hidden.value.valueWithheld).toContain("does not allow value reads");
    expect(JSON.stringify(hidden.value)).not.toContain("mcp-dev");
    const listed = await tool(noFlag.id, "read_vault", { vaultId: vault.id });
    expect(JSON.stringify(listed.value)).not.toContain("mcp-dev");
    expect(listed.value.secrets.map((item: any) => item.name)).toEqual(["MCP_SECRET"]);
    const noEnv = await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id });
    expect(noEnv.value.value).toBeNull();
    const shown = await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev });
    expect(shown.value.value).toMatchObject({ value: "mcp-dev", version: 1 });
    expect((await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.staging })).value.code).toBe("NOT_FOUND");
    // CAS over MCP.
    expect((await tool(noFlag.id, "write_secret_value", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev, value: "mcp-2", expectedVersion: 1 })).value.value.version).toBe(2);
    const stale = await tool(noFlag.id, "write_secret_value", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev, value: "mcp-3", expectedVersion: 1 });
    expect(stale.value).toMatchObject({ code: "VALUE_CHANGED", currentVersion: 2 });
    const created = await tool(noFlag.id, "create_secret", { vaultId: vault.id, name: "MADE_BY_AGENT", values: [{ envId: vault.envs.dev, value: "agent-value" }] });
    expect(created.value.secret.name).toBe("MADE_BY_AGENT");
    expect(JSON.stringify(created.value)).not.toContain("agent-value");
    // Unknown vaults and secrets look the same.
    expect((await tool(noFlag.id, "read_vault", { vaultId: crypto.randomUUID() })).value.code).toBe("NOT_FOUND");
    const mcpEvents = db.query("SELECT event FROM vault_events WHERE vault_id = ? AND key_id IS NOT NULL AND via = 'mcp'").all(vault.id) as Array<{ event: string }>;
    expect(mcpEvents.map((row) => row.event)).toEqual(expect.arrayContaining(["value.read", "value.write", "secret.create"]));
  });

  test("tools/call over the MCP endpoint runs the vault tool for a vault key", async () => {
    const owner = await createUser("VK mcp http");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const response = await mcp(key.token, "tools/call", { name: "list_vaults", arguments: {} });
    const text = response.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(text).vaults.map((item: any) => item.id)).toEqual([vault.id]);
  });
});

describe("per-key limits, the alert, Activity, and Keys with access", () => {
  test("a key's reads are limited below a person's; the refusal is 429 with Retry-After, an access event, a vault event, and one bell notice", async () => {
    const owner = await createUser("VK limits");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "LIMITED", { dev: "l" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    let refused: Awaited<ReturnType<typeof rest>> | null = null;
    for (let index = 0; index < 25 && !refused; index += 1) {
      const response = await rest(key.token, "GET", valuePath(vault, secret.id, "dev"));
      if (response.status === 429) refused = response;
    }
    expect(refused).not.toBeNull();
    expect(refused!.body.code).toBe("RATE_LIMITED");
    expect(Number(refused!.headers.get("retry-after"))).toBeGreaterThan(0);
    // The owner's own session is not limited by the key.
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM access_events WHERE key_id = ? AND action = 'key.vault.limited'").get(key.id)).toBeTruthy();
    expect(db.query("SELECT 1 FROM vault_events WHERE key_id = ? AND event = 'key.limited'").get(key.id)).toBeTruthy();
    expect((db.query("SELECT COUNT(*) AS count FROM access_notices WHERE key_id = ? AND kind = 'key_vault_limited'").get(key.id) as { count: number }).count).toBe(1);
    // MCP value reads have their own hourly bucket too.
    resetVaultLimits();
    resetKeyAlertsForTests();
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }], { allowMcpValueReads: true });
    db.query("INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 60, 0)").run(`keyMcpValue:${flagged.id}`, Math.floor(Date.now() / 3_600_000) * 3_600_000);
    expect((await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id, envId: vault.envs.dev })).value.code).toBe("RATE_LIMITED");
    expect((await tool(flagged.id, "read_secret", { vaultId: vault.id, secretId: secret.id })).isError).toBe(false);
  });

  test("Activity shows the key as the actor; owners list the keys with access, members see the count and their own, Team admins outside the vault get 404", async () => {
    const owner = await createUser("VK activity owner");
    const member = await createUser("VK activity member");
    const admin = await createUser("VK activity admin");
    setRole(admin, "admin");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "ACT", { dev: "a" });
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    const ownerKey = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const memberKey = await vaultKey(member, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    await rest(memberKey.token, "GET", valuePath(vault, secret.id, "dev"));
    const activity = (await call(owner, "GET", `/vaults/${vault.id}/events?event=apikeys`)).body;
    const read = activity.events.find((event: any) => event.event === "value.read" && event.key);
    expect(read).toMatchObject({ via: "api", actor: { displayName: "VK activity member" }, key: { name: memberKey.key.name } });
    expect(JSON.stringify(activity)).not.toContain("\"a\"");
    const ownerView = (await call(owner, "GET", `/vaults/${vault.id}/keys`)).body;
    expect(ownerView).toMatchObject({ count: 2, scope: "vault" });
    expect(ownerView.keys.map((key: any) => key.owner.displayName).sort()).toEqual(["VK activity member", "VK activity owner"]);
    expect(ownerView.keys.find((key: any) => key.id === memberKey.id).levels).toEqual({ [vault.envs.dev!]: "read" });
    const memberView = (await call(member, "GET", `/vaults/${vault.id}/keys`)).body;
    expect(memberView).toMatchObject({ count: 2, scope: "own" });
    expect(memberView.keys.map((key: any) => key.id)).toEqual([memberKey.id]);
    expect((await call(admin, "GET", `/vaults/${vault.id}/keys`)).status).toBe(404);
    // Revoked keys drop out.
    await keysApi(owner, "DELETE", `/${ownerKey.id}`);
    expect((await call(owner, "GET", `/vaults/${vault.id}/keys`)).body.count).toBe(1);
    // The key's own Recent activity lists its vault events for its owner.
    const detail = (await keysApi(member, "GET", `/${memberKey.id}`)).body;
    expect(detail.vaultEvents.map((event: any) => event.event)).toContain("value.read");
    expect(detail.vaultEvents[0].vault.name).toBeTruthy();
  });

  test("Team → Keys filters by kind and shows vault keys without vault names", async () => {
    const admin = await createUser("VK team admin");
    setRole(admin, "admin");
    const owner = await createUser("VK team owner");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const response = await request("/team/keys?kind=vault", {}, admin);
    const body = await response.json() as { keys: Array<{ id: string; kind: string; grants: Array<{ resource: { name: string | null } | null }> }> };
    expect(body.keys.every((item) => item.kind === "vault")).toBe(true);
    const found = body.keys.find((item) => item.id === key.id)!;
    expect(found.grants[0]!.resource!.name).toBeNull();
    expect((await request("/team/keys?kind=general", {}, admin).then((r) => r.json()) as { keys: Array<{ id: string }> }).keys.some((item) => item.id === key.id)).toBe(false);
    expect((await request("/team/keys?kind=other", {}, admin)).status).toBe(400);
  });
});

describe("narrowing and rotating vault keys (D277, D278)", () => {
  test("PATCH narrows (drop, write → read, every environment → one, flags off) and refuses widening", async () => {
    const owner = await createUser("VK narrow");
    const vault = await newVault(owner);
    const other = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }, { module: "vault", permission: "read", vaultId: other.id }], { allowMcpValueReads: true });
    const patch = (body: unknown) => keysApi(owner, "PATCH", `/${key.id}`, body);
    expect((await patch({ grants: [{ module: "vault", permission: "write", vaultId: vault.id }, { module: "vault", permission: "write", vaultId: other.id }] })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await patch({ grants: [{ module: "notes", permission: "read" }] })).body.code).toBe("KEY_KIND_WALL");
    expect((await patch({ grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }] })).body.changed).toEqual(["grants"]);
    expect((await patch({ grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }] })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await patch({ allowMcpValueReads: false })).body.key.vault.allowMcpValueReads).toBe(false);
    expect((await patch({ allowMcpValueReads: true })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await patch({ protectedAccess: true })).body.code).toBe("WIDENING_NOT_ALLOWED");
    const general = createApiKey(owner.userId, { name: "G", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect((await keysApi(owner, "PATCH", `/${general.id}`, { allowMcpValueReads: false })).status).toBe(400);
  });

  test("an explicit protected grant never narrows from 'every environment' on a protectedAccess key", async () => {
    const owner = await createUser("VK narrow protected");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }], { protectedAccess: true });
    expect(key.key.vault.protectedAccess).toBe(true);
    // Dropping the prod grant is fine; replacing "every" with staging on this key is not (it could be protected later).
    expect((await keysApi(owner, "PATCH", `/${key.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }] })).body.code).toBe("WIDENING_NOT_ALLOWED");
    // Wave 27 QA M2: dropping the last protected grant turns the flag off too.
    expect((await keysApi(owner, "PATCH", `/${key.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id }] })).body.changed).toEqual(["grants", "vaultFlags"]);
    expect((await keysApi(owner, "GET", `/${key.id}`)).body.key.vault.protectedAccess).toBe(false);
  });

  test("rotation keeps the kind, the grants, and the flags; it re-checks the creator's access", async () => {
    const owner = await createUser("VK rotate owner");
    const member = await createUser("VK rotate member");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: member, levels: { dev: "write" } }]);
    const key = await vaultKey(member, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }], { allowMcpValueReads: true });
    const rotated = await keysApi(member, "POST", `/${key.id}/rotate`, { graceHours: 0, password: member.password });
    expect(rotated.status).toBe(201);
    expect(rotated.body.key).toMatchObject({ kind: "vault", vault: { allowMcpValueReads: true, protectedAccess: false } });
    expect(rotated.body.key.token.startsWith("nkv_")).toBe(true);
    expect(rotated.body.key.grants[0]).toMatchObject({ permission: "write", env: { id: vault.envs.dev } });
    // A rotation may turn the flag off, never widen past the creator.
    await share(owner, vault, [{ session: member, levels: { dev: "read" } }]);
    const refused = await keysApi(member, "POST", `/${rotated.body.key.id}/rotate`, { graceHours: 0, password: member.password });
    expect(refused.body.code).toBe("GRANT_EXCEEDS_ACCESS");
  });
});

describe("canary: no value in logs, events, or errors on the key paths (T188)", () => {
  test("values written and read over REST and MCP never reach audit_log, vault_events, access_events, notices, or error bodies", async () => {
    const owner = await createUser("VK canary");
    const vault = await newVault(owner);
    const canary = `NOOK-CANARY-${crypto.randomUUID()}`;
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }], { allowMcpValueReads: true });
    const created = await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "CANARY", comment: `${canary}-c`, values: { [vault.envs.dev!]: { value: canary, comment: `${canary}-vc` } } });
    expect(created.status).toBe(201);
    const secretId = created.body.secret.id as string;
    const bodies: string[] = [];
    bodies.push((await rest(key.token, "PUT", `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs.dev}`, { value: `${canary}-2`, expectedVersion: 7 })).text);
    bodies.push((await rest(key.token, "POST", `/vault/vaults/${vault.id}/secrets`, { name: "CANARY", values: { [vault.envs.dev!]: { value: `${canary}-3` } } })).text);
    bodies.push((await rest(key.token, "PUT", `/vault/vaults/${vault.id}/secrets/${secretId}/values/${vault.envs.dev}`, { value: `${canary}\u0000`, expectedVersion: 1 })).text);
    bodies.push(JSON.stringify((await tool(key.id, "write_secret_value", { vaultId: vault.id, secretId, envId: vault.envs.dev, value: `${canary}-4`, expectedVersion: 9 })).value));
    bodies.push(JSON.stringify((await tool(key.id, "create_secret", { vaultId: vault.id, name: "CANARY", values: [{ envId: vault.envs.dev, value: `${canary}-5` }] })).value));
    expect((await tool(key.id, "read_secret", { vaultId: vault.id, secretId, envId: vault.envs.dev })).value.value.value).toBe(canary);
    for (const body of bodies) expect(body).not.toContain(canary);
    for (const table of ["audit_log", "vault_events", "access_events", "access_notices", "api_key_grants", "mcp_api_keys"]) {
      const rows = db.query(`SELECT * FROM ${table}`).all();
      expect({ table, leaked: JSON.stringify(rows).includes(canary) }).toEqual({ table, leaked: false });
    }
    const stored = db.query("SELECT value_ct, comment_ct FROM vault_values WHERE secret_id = ?").all(secretId);
    expect(JSON.stringify(stored)).not.toContain(canary);
  });

  test("the tool lists never hold a destructive, key, or access tool", () => {
    for (const spec of [...vaultToolSpecs, ...mcpToolSpecs.filter((item) => item.name.includes("vault") || item.name.includes("secret"))]) {
      expect(spec.name).not.toMatch(/key|grant|polic|access|token|permission|share|sharing|group|template|purge|delete|clear|remove|restore|rotate|import|export|member/);
    }
    expect(mcpToolSpecs.some((spec) => vaultToolSpecs.some((vaultSpec) => vaultSpec.name === spec.name))).toBe(false);
  });
});
