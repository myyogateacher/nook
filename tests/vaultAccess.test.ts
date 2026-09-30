import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits, setRole } from "./support/vault";

/**
 * T181, T185, T198 for sessions (vault plan §6.1, §13 row 3; Wave 25 has no keys or MCP): every
 * vault route, called by the owner, another member, an admin who does not own the vault, a viewer,
 * and a guest. Anyone who does not own the vault gets the same 404 as for a vault that does not
 * exist (admins included, D73); guests get 404 on every read and the role gate's 403 on every write
 * (it answers before any lookup, so it says nothing about the vault); viewers are refused every write
 * except the reveal batch, which then finds nothing. A binned vault is 404 for its owner too.
 * Nothing any of them sends changes a row.
 */

beforeEach(() => resetVaultLimits());

type Route = { method: string; path: string; body?: unknown; read: boolean };

function routes(v: string, s: string, e: string): Route[] {
  const base = `/vaults/${v}`;
  const value = `${base}/secrets/${s}/values/${e}`;
  return [
    { method: "GET", path: base, read: true },
    { method: "PATCH", path: base, body: { name: "Taken", expectedRevision: 1 }, read: false },
    { method: "DELETE", path: base, read: false },
    { method: "POST", path: `${base}/environments`, body: { slug: "evil", name: "Evil" }, read: false },
    { method: "PUT", path: `${base}/environments/order`, body: { ids: [e], expectedRevision: 1 }, read: false },
    { method: "PATCH", path: `${base}/environments/${e}`, body: { name: "Evil" }, read: false },
    { method: "DELETE", path: `${base}/environments/${e}`, read: false },
    { method: "GET", path: `${base}/secrets`, read: true },
    { method: "POST", path: `${base}/secrets`, body: { name: "EVIL" }, read: false },
    { method: "GET", path: `${base}/secrets/${s}`, read: true },
    { method: "PATCH", path: `${base}/secrets/${s}`, body: { name: "EVIL", expectedRevision: 1 }, read: false },
    { method: "DELETE", path: `${base}/secrets/${s}`, read: false },
    { method: "GET", path: value, read: true },
    { method: "PUT", path: value, body: { value: "evil", expectedVersion: 1 }, read: false },
    { method: "DELETE", path: `${value}?expectedVersion=1`, read: false },
    { method: "PUT", path: `${base}/secrets/${s}/values`, body: { values: [{ envId: e, value: "evil", expectedVersion: 1 }] }, read: false },
    { method: "POST", path: `${base}/reveal`, body: { cells: [{ secretId: s, envId: e }] }, read: false },
    { method: "GET", path: `${value}/versions`, read: true },
    { method: "GET", path: `${value}/versions/1`, read: true },
    { method: "POST", path: `${value}/versions/1/restore`, body: { expectedVersion: 1 }, read: false }
  ];
}

function snapshot() {
  return ["vaults", "vault_environments", "vault_secrets", "vault_values", "vault_value_versions", "vault_members", "vault_keys"].map((table) =>
    db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

describe("the access matrix for sessions (T181)", () => {
  test("only the owner reaches a vault; everyone else gets 404 or the role gate, and nothing changes", async () => {
    const owner = await createUser("Matrix owner");
    const member = await createUser("Matrix member");
    const admin = await createUser("Matrix admin");
    const viewer = await createUser("Matrix viewer");
    const guest = await createUser("Matrix guest");
    setRole(admin, "admin");
    setRole(viewer, "viewer");
    setRole(guest, "guest");
    try {
      const vault = await newVault(owner);
      const secret = await newSecret(owner, vault, "MATRIX", { dev: "matrix-value" });
      const envId = vault.envs.dev!;
      const missing = { v: crypto.randomUUID(), s: crypto.randomUUID(), e: crypto.randomUUID() };
      const before = snapshot();

      for (const [label, session] of [["member", member], ["admin", admin], ["viewer", viewer], ["guest", guest]] as const) {
        for (const route of routes(vault.id, secret.id, envId)) {
          const response = await call(session, route.method, route.path, route.body);
          const readOnlyGate = !route.read && (label === "guest" || (label === "viewer" && !route.path.endsWith("/reveal")));
          const expected = readOnlyGate ? { status: 403, code: "ROLE_READ_ONLY" } : { status: 404, code: label === "guest" ? undefined : "NOT_FOUND" };
          expect({ label, route: `${route.method} ${route.path}`, status: response.status, code: response.body.code }).toEqual({ label, route: `${route.method} ${route.path}`, ...expected });
          expect(response.text).not.toContain("matrix-value");
          expect(response.text).not.toContain("MATRIX");
        }
        // Missing ids answer exactly as forbidden ones (404 parity, T194).
        for (const route of routes(missing.v, missing.s, missing.e).filter((item) => item.read)) {
          const response = await call(session, route.method, route.path);
          expect({ label, route: route.path, status: response.status }).toEqual({ label, route: route.path, status: 404 });
        }
        const list = await call(session, "GET", "/vaults");
        if (label === "guest") expect(list.status).toBe(404);
        else expect(list.body.vaults.map((item: { id: string }) => item.id)).not.toContain(vault.id);
      }
      expect(snapshot()).toEqual(before);
      expect((await call(guest, "GET", "/status")).status).toBe(404);
      expect((await call(guest, "POST", "/vaults", { name: "Guest vault" })).status).toBe(403);
      expect((await call(viewer, "POST", "/vaults", { name: "Viewer vault" })).body.code).toBe("ROLE_READ_ONLY");
      // The admin can create their own vault, and it is theirs alone.
      const own = await call(admin, "POST", "/vaults", { name: "Admin vault" });
      expect(own.status).toBe(201);
      expect((await call(owner, "GET", `/vaults/${own.body.vault.id}`)).status).toBe(404);

      // The owner reaches every route (reads here; writes are covered in tests/vault.test.ts).
      for (const route of routes(vault.id, secret.id, envId).filter((item) => item.read)) {
        expect({ route: route.path, status: (await call(owner, "GET", route.path)).status }).toEqual({ route: route.path, status: 200 });
      }
    } finally {
      // The admin stays one: the last active admin cannot be demoted (LAST_ADMIN).
      for (const session of [viewer, guest]) setRole(session, "member");
    }
  });

  test("an owner demoted to viewer reads (including the reveal batch) but writes nothing; a guest owner reaches nothing", async () => {
    const owner = await createUser("Demoted owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "DEMOTED", { dev: "demoted-value" });
    const envId = vault.envs.dev!;
    setRole(owner, "viewer");
    try {
      const listed = await call(owner, "GET", "/vaults");
      const summary = listed.body.vaults.find((item: { id: string }) => item.id === vault.id);
      expect(summary.environments.map((env: { level: string }) => env.level)).toEqual(["read", "read", "read"]);
      expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${envId}`)).body.value.value).toBe("demoted-value");
      const reveal = await call(owner, "POST", `/vaults/${vault.id}/reveal`, { cells: [{ secretId: secret.id, envId }] });
      expect(reveal.body.cells[0].value).toBe("demoted-value");
      expect((await call(owner, "PUT", `/vaults/${vault.id}/secrets/${secret.id}/values/${envId}`, { value: "x", expectedVersion: 1 })).body.code).toBe("ROLE_READ_ONLY");
      setRole(owner, "guest");
      for (const route of routes(vault.id, secret.id, envId).filter((item) => item.read)) expect((await call(owner, "GET", route.path)).status).toBe(404);
      setRole(owner, "member");
      db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), owner.userId);
      expect((await call(owner, "GET", `/vaults/${vault.id}`)).status).toBe(401);
    } finally {
      db.query("UPDATE users SET role = 'member', disabled_at = NULL WHERE id = ?").run(owner.userId);
    }
  });

  test("a binned vault is 404 for its owner on every route", async () => {
    const owner = await createUser("Binned owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "BINNED", { dev: "binned-value" });
    await call(owner, "DELETE", `/vaults/${vault.id}`);
    for (const route of routes(vault.id, secret.id, vault.envs.dev!)) {
      const response = await call(owner, route.method, route.path, route.body);
      expect({ route: `${route.method} ${route.path}`, status: response.status }).toEqual({ route: `${route.method} ${route.path}`, status: 404 });
    }
  });

  test("a secret or environment id from another vault is 404 inside this one", async () => {
    const owner = await createUser("IDOR owner");
    const one = await newVault(owner);
    const two = await newVault(owner);
    const secretTwo = await newSecret(owner, two, "TWO", { dev: "two-value" });
    expect((await call(owner, "GET", `/vaults/${one.id}/secrets/${secretTwo.id}`)).status).toBe(404);
    expect((await call(owner, "GET", `/vaults/${one.id}/secrets/${secretTwo.id}/values/${two.envs.dev}`)).status).toBe(404);
    expect((await call(owner, "GET", `/vaults/${two.id}/secrets/${secretTwo.id}/values/${one.envs.dev}`)).status).toBe(404);
    expect((await call(owner, "PUT", `/vaults/${one.id}/secrets/${secretTwo.id}/values/${one.envs.dev}`, { value: "x", expectedVersion: 0 })).status).toBe(404);
  });
});
