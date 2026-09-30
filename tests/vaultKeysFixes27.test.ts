import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits, share } from "./support/vault";

const { resetKeyAlertsForTests } = await import("../server/vault/keyApi");
const { countKeyValueReads } = await import("../server/vault/limits");
const { listAccessNotices } = await import("../server/access/notices");
const { keyEventLine } = await import("../src/keys/keyGrants");

/**
 * Wave 27 fixes beyond the reviewer's probes (tests/vaultReview27.test.ts): the daily value-read
 * counter never refuses and crosses once a day (V-O6, M1); the bell line; the database rules for
 * `protected_at_grant` (L2); narrowing keeps it (write → read on a protected environment).
 */

beforeEach(() => {
  resetVaultLimits();
  resetKeyAlertsForTests();
});

type VaultGrantBody = { module: "vault"; permission: "read" | "write"; vaultId: string; envId?: string | null };

async function keysApi(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/keys${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

async function vaultKey(session: Session, grants: VaultGrantBody[], extra: Record<string, unknown> = {}) {
  const created = await keysApi(session, "POST", "", { name: `F27 key ${crypto.randomUUID().slice(0, 6)}`, kind: "vault", surfaces: "both", grants, password: session.password, ...extra });
  if (created.status !== 201) throw new Error(`vault key refused: ${JSON.stringify(created.body)}`);
  return { id: created.body.key.id as string, token: created.body.key.token as string };
}

async function restValue(token: string, vaultId: string, secretId: string, envId: string) {
  const response = await fetch(`${origin}/api/v1/vault/vaults/${vaultId}/secrets/${secretId}/values/${envId}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("wave 27 fixes: the daily value-read alert (V-O6)", () => {
  test("the counter never refuses, crosses 500 once a UTC day, and starts over the next day", () => {
    const keyId = crypto.randomUUID();
    const day = Date.UTC(2026, 8, 30, 12);
    expect(countKeyValueReads(keyId, 500, day)).toEqual({ total: 500, crossed: false });
    expect(countKeyValueReads(keyId, 1, day)).toEqual({ total: 501, crossed: true });
    for (let index = 0; index < 5; index += 1) expect(countKeyValueReads(keyId, 100, day).crossed).toBe(false);
    expect(countKeyValueReads(keyId, 1, day + 24 * 3_600_000)).toEqual({ total: 1, crossed: false });
  });

  test("the bell line and the key's history say what happened, never a value", async () => {
    const owner = await createUser("F27 volume line");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const { notifyAccess } = await import("../server/access/notices");
    notifyAccess({ userId: owner.userId, kind: "key_vault_volume", actorId: null, keyId: key.id, count: 501 });
    const notice = listAccessNotices(owner.userId, { unread: true, limit: 10 }).find((item) => item.title.includes("500 values"));
    expect(notice?.title).toMatch(/^Your vault API key “F27 key .+” read more than 500 values today\. If you did not expect this much use, revoke it/);
    expect(keyEventLine({ action: "key.vault.volume", meta: { threshold: 500, surface: "rest" } })).toBe("Read more than 500 values today over REST");
    expect(keyEventLine({ action: "key.vault.limited", meta: { surface: "mcp" } })).toBe("Hit a vault limit over MCP");
  });
});

describe("wave 27 QA fixes", () => {
  test("M2: narrowing away the only protected grant turns protectedAccess off; protecting the kept environment later cuts the key", async () => {
    const owner = await createUser("F27 qa m2");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "QA_M2", { dev: "m2-dev" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }], { protectedAccess: true });
    const narrowed = await keysApi(owner, "PATCH", `/${key.id}`, { grants: [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }] });
    expect(narrowed.status).toBe(200);
    expect(db.query("SELECT vault_protected_access FROM mcp_api_keys WHERE id = ?").get(key.id)).toEqual({ vault_protected_access: 0 });
    expect(db.query("SELECT protected_at_grant FROM api_key_grants WHERE key_id = ?").all(key.id)).toEqual([{ protected_at_grant: 0 }]);
    expect((await keysApi(owner, "GET", `/${key.id}`)).body.key.vault).toEqual({ allowMcpValueReads: false, protectedAccess: false });
    db.query("UPDATE vault_environments SET protected = 1 WHERE id = ?").run(vault.envs.dev!);
    expect((await restValue(key.token, vault.id, secret.id, vault.envs.dev!)).status).toBe(404);
    db.query("UPDATE vault_environments SET protected = 0 WHERE id = ?").run(vault.envs.dev!);
    // Narrowing that keeps a protected grant keeps the flag.
    const kept = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }], { protectedAccess: true });
    expect((await keysApi(owner, "PATCH", `/${kept.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }] })).status).toBe(200);
    expect(db.query("SELECT vault_protected_access FROM mcp_api_keys WHERE id = ?").get(kept.id)).toEqual({ vault_protected_access: 1 });
  });

  test("L1: a write grant shows no-access once the creator is lowered to read (it still reads); L2: a binned environment shows its name and 'binned'", async () => {
    const owner = await createUser("F27 qa l1 owner");
    const member = await createUser("F27 qa l1 member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "QA_L1", { dev: "l1", staging: "l1s" });
    await share(owner, vault, [{ session: member, levels: { dev: "write", staging: "read" } }]);
    const key = await vaultKey(member, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.dev }, { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }]);
    const grants = async () => (await keysApi(member, "GET", `/${key.id}`)).body.key.grants as Array<any>;
    expect((await grants()).map((grant) => grant.inactiveReason)).toEqual([null, null]);
    await share(owner, vault, [{ session: member, levels: { dev: "read", staging: "read" } }]);
    expect((await grants())[0]).toMatchObject({ permission: "write", active: false, inactiveReason: "no-access" });
    expect((await restValue(key.token, vault.id, secret.id, vault.envs.dev!)).status).toBe(200);
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/environments/${vault.envs.staging}`)).status).toBe(200);
    expect((await grants())[1]).toMatchObject({ active: false, inactiveReason: "binned", env: { id: vault.envs.staging, name: "Staging" } });
  });
});

describe("wave 27 fixes: protected_at_grant (L2)", () => {
  test("stored only on a grant naming an environment protected at the time, on a flagged key; the database refuses it anywhere else", async () => {
    const owner = await createUser("F27 protected at grant");
    const vault = await newVault(owner);
    const flagged = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.prod }, { module: "vault", permission: "read", vaultId: vault.id }], { protectedAccess: true });
    expect(db.query("SELECT env_id, protected_at_grant FROM api_key_grants WHERE key_id = ? ORDER BY protected_at_grant").all(flagged.id))
      .toEqual([{ env_id: null, protected_at_grant: 0 }, { env_id: vault.envs.prod, protected_at_grant: 1 }]);
    const plain = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    const insert = (keyId: string, module: string, envId: string | null, resourceKind: string | null = "vault", resourceId: string | null = vault.id) => () => db.query(`INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, protected_at_grant, created_at)
      VALUES (?, ?, ?, 'read', ?, ?, ?, 1, ?)`).run(crypto.randomUUID(), keyId, module, resourceKind, resourceId, envId, new Date().toISOString());
    // An unflagged key, an "every environment" grant, and a general key's grant cannot carry it.
    expect(insert(plain.id, "vault", vault.envs.staging!)).toThrow("VAULT_GRANT_SHAPE");
    expect(insert(flagged.id, "vault", null)).toThrow("VAULT_GRANT_SHAPE");
    const general = await keysApi(owner, "POST", "", { name: "F27 general", surfaces: "mcp", grants: [{ module: "notes", permission: "read" }], password: owner.password });
    expect(general.status).toBe(201);
    expect(insert(general.body.key.id, "notes", null, null, null)).toThrow("VAULT_GRANT_SHAPE");
    expect(() => db.query("UPDATE api_key_grants SET protected_at_grant = 1 WHERE key_id = ?").run(general.body.key.id)).toThrow("VAULT_GRANT_SHAPE");
  });

  test("narrowing write → read on a protected environment keeps its reach", async () => {
    const owner = await createUser("F27 narrow keeps");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.prod }], { protectedAccess: true });
    const narrowed = await keysApi(owner, "PATCH", `/${key.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.prod }] });
    expect(narrowed.status).toBe(200);
    expect(db.query("SELECT permission, protected_at_grant FROM api_key_grants WHERE key_id = ?").all(key.id)).toEqual([{ permission: "read", protected_at_grant: 1 }]);
    const listed = await keysApi(owner, "GET", "");
    const grant = listed.body.keys.find((item: any) => item.id === key.id).grants[0];
    expect(grant).toMatchObject({ active: true, env: { id: vault.envs.prod, protected: true } });
  });
});
