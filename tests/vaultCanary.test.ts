import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createUser, db, request } from "./support/harness";
import { call, newVault, resetVaultLimits } from "./support/vault";

const { config } = await import("../server/config");

/**
 * T188 (vault plan §13 row 6): a canary written through every vault write path, and every error
 * path that receives one, never appears in plaintext anywhere at rest or in output: not in the
 * database file or its WAL (so no table: audit_log, vault_events, search indexes), not in any
 * response other than the reads that exist to return it, and not in anything the server logs.
 */

const CANARY = `NOOK-CANARY-${crypto.randomUUID()}`;
const logged: string[] = [];
const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };

beforeAll(() => {
  for (const name of ["log", "warn", "error", "info"] as const) {
    console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); originals[name](...args); };
  }
});
afterAll(() => Object.assign(console, originals));

describe("the canary (T188)", () => {
  test("never lands in the database, logs, events, or any response but a read", async () => {
    resetVaultLimits();
    const owner = await createUser("Canary owner");
    const vault = await newVault(owner);
    const [dev, staging, prod] = [vault.envs.dev!, vault.envs.staging!, vault.envs.prod!];
    const bodies: string[] = [];
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await call(owner, method, path, body);
      bodies.push(response.text);
      return response;
    };

    const created = await send("POST", `/vaults/${vault.id}/secrets`, { name: "CANARY_SECRET", comment: `${CANARY}-secret-comment`, values: { [dev]: { value: `${CANARY}-dev`, comment: `${CANARY}-dev-comment` } } });
    expect(created.status).toBe(201);
    const secretId = created.body.secret.id;
    // The detail read returns the decrypted comment by design; it is checked apart from the rest.
    const detailText = created.text;
    bodies.pop();
    expect(detailText).toContain(`${CANARY}-secret-comment`);

    expect((await send("PUT", `/vaults/${vault.id}/secrets/${secretId}/values/${dev}`, { value: `${CANARY}-dev-2`, comment: `${CANARY}-c2`, expectedVersion: 1 })).status).toBe(200);
    expect((await send("PUT", `/vaults/${vault.id}/secrets/${secretId}/values`, { values: [{ envId: staging, value: `${CANARY}-staging`, expectedVersion: 0 }, { envId: prod, value: `${CANARY}-prod`, comment: `${CANARY}-pc`, expectedVersion: 0 }] })).status).toBe(200);
    expect((await send("POST", `/vaults/${vault.id}/secrets/${secretId}/values/${dev}/versions/1/restore`, { expectedVersion: 2 })).status).toBe(200);
    expect((await send("DELETE", `/vaults/${vault.id}/secrets/${secretId}/values/${staging}?expectedVersion=1`)).status).toBe(200);
    const patched = await send("PATCH", `/vaults/${vault.id}/secrets/${secretId}`, { comment: `${CANARY}-secret-comment-2`, tags: ["canary"], expectedRevision: 1 });
    expect(patched.status).toBe(200);
    bodies.pop();
    const login = await send("POST", `/vaults/${vault.id}/secrets`, { name: "CANARY_LOGIN", type: "login", values: { [dev]: { value: JSON.stringify({ username: "u", password: `${CANARY}-pw`, url: "" }) } } });
    expect(login.status).toBe(201);

    // Error paths that receive a canary: CAS conflicts, a bad login, too large, invalid input, a missing environment.
    expect((await send("PUT", `/vaults/${vault.id}/secrets/${secretId}/values/${dev}`, { value: `${CANARY}-conflict`, expectedVersion: 1 })).status).toBe(409);
    expect((await send("PUT", `/vaults/${vault.id}/secrets/${login.body.secret.id}/values/${dev}`, { value: `${CANARY}-not-json`, expectedVersion: 1 })).status).toBe(400);
    expect((await send("PUT", `/vaults/${vault.id}/secrets/${secretId}/values/${dev}`, { value: `${CANARY}${"é".repeat(40_000)}`, expectedVersion: 3 })).status).toBe(413);
    expect((await send("PUT", `/vaults/${vault.id}/secrets/${secretId}/values/${dev}`, { value: `${CANARY}\u0000`, expectedVersion: 3 })).status).toBe(400);
    expect((await send("PUT", `/vaults/${vault.id}/secrets/${secretId}/values/${crypto.randomUUID()}`, { value: CANARY, expectedVersion: 0 })).status).toBe(404);
    expect((await send("POST", `/vaults/${vault.id}/secrets`, { name: "BAD", extra: CANARY })).status).toBe(400);
    // Listing, history, and the Bin never carry values.
    expect((await send("GET", `/vaults/${vault.id}/secrets`)).status).toBe(200);
    expect((await send("GET", `/vaults/${vault.id}/secrets/${secretId}/values/${dev}/versions`)).status).toBe(200);
    bodies.push(await (await request("/bin", {}, owner)).text());

    for (const body of bodies) expect(body).not.toContain(CANARY);

    // The reads do return it (so the canary is really stored, encrypted).
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secretId}/values/${prod}`)).body.value.value).toBe(`${CANARY}-prod`);

    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (const path of [config.databasePath, `${config.databasePath}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      expect({ path: path.split("/").pop(), found: bytes.includes(Buffer.from("NOOK-CANARY")) }).toEqual({ path: path.split("/").pop(), found: false });
    }
    for (const row of db.query("SELECT metadata_json FROM audit_log WHERE metadata_json IS NOT NULL").all() as Array<{ metadata_json: string }>) expect(row.metadata_json).not.toContain("NOOK-CANARY");
    expect(logged.join("\n")).not.toContain("NOOK-CANARY");
  });
});
