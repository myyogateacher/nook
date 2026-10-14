import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createUser, db, request } from "./support/harness";
import { api } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { storedSecretCount } from "./support/storedSecrets";

const { config } = await import("../server/config");
const { openSecret, sealSecret, secretHint, verifySecrets } = await import("../server/agents/secrets");
const { setAgentsKeyForTests, agentsStatus } = await import("../server/agents/status");

/**
 * Provider secrets (agent chat plan §4.2, D354, T309): AES-256-GCM under AGENT_SECRETS_KEY with a
 * per-row AAD, write-only in the API, shown only as a hint, and a canary that never reaches the
 * database file or WAL, the audit log, any response, the provider's request body, or the logs.
 */

const CANARY = `sk-NOOKCANARY-${crypto.randomUUID().replace(/-/g, "")}`;
const logged: string[] = [];
const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
const fake = startFakeProvider(0);

beforeAll(() => {
  for (const name of ["log", "warn", "error", "info"] as const) {
    console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); originals[name](...args); };
  }
});
afterAll(() => { Object.assign(console, originals); fake.stop(); });

describe("agent secrets (D354, T309)", () => {
  test("round trip, AAD binding, and the hint", () => {
    const key = Buffer.alloc(32, 5);
    const sealed = sealSecret("provider", "row-1", "sk-test-abcdef", key);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("sk-test");
    expect(openSecret("provider", "row-1", sealed, key)).toBe("sk-test-abcdef");
    expect(() => openSecret("provider", "row-2", sealed, key)).toThrow(/integrity/);
    expect(() => openSecret("server", "row-1", sealed, key)).toThrow(/integrity/);
    expect(() => openSecret("provider", "row-1", sealed, Buffer.alloc(32, 6))).toThrow(/integrity/);
    expect(() => openSecret("provider", "row-1", "v1:nope", key)).toThrow(/integrity/);
    expect(secretHint("sk-proj-ABCDEFGHIJKLMNOP1234")).toBe("sk-…1234");
    expect(secretHint("short")).toBe("…");
  });

  test("the API is write-only: the canary never appears at rest, in responses, in logs, or in audit rows", async () => {
    const admin = await createUser("Secrets admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const bodies: string[] = [];
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, admin);
      const text = await response.text();
      bodies.push(text);
      return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : null };
    };
    const created = await send("POST", "/agents/admin/providers", { name: "Canary provider", baseUrl: fake.baseUrl, apiKey: CANARY, defaultModel: "gpt-6-luna" });
    expect(created.status).toBe(201);
    const provider = created.body!.provider;
    expect(provider.hasSecret).toBe(true);
    expect(provider.hint).toBe(`${CANARY.slice(0, 3)}…${CANARY.slice(-4)}`);
    expect(Object.keys(provider)).not.toContain("apiKey");
    expect((await send("GET", "/agents/admin/providers")).status).toBe(200);
    expect((await send("GET", `/agents/admin/providers/${provider.id}`)).status).toBe(200);
    // Editing without a key keeps the old one; an empty key keeps it too; a wrong revision refuses.
    const patched = await send("PATCH", `/agents/admin/providers/${provider.id}`, { name: "Canary provider 2", expectedRevision: provider.revision });
    expect(patched.status).toBe(200);
    expect(patched.body!.provider.hasSecret).toBe(true);
    expect((await send("PATCH", `/agents/admin/providers/${provider.id}`, { apiKey: "", expectedRevision: patched.body!.provider.revision })).body!.provider.hasSecret).toBe(true);
    expect((await send("PATCH", `/agents/admin/providers/${provider.id}`, { apiKey: `${CANARY}-stale`, expectedRevision: 1 })).status).toBe(409);
    // The test call sends the key to the provider as a Bearer header, and nowhere else.
    const tested = await send("POST", `/agents/admin/providers/${provider.id}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.body!.test.ok).toBe(true);
    const outbound = fake.calls.filter((call) => call.headers.authorization === `Bearer ${CANARY}`);
    expect(outbound.length).toBeGreaterThan(0);
    for (const call of fake.calls) expect(JSON.stringify(call.body ?? {})).not.toContain(CANARY);
    // Validation and 404 paths that receive the canary echo nothing.
    expect((await send("POST", "/agents/admin/providers", { name: "", apiKey: CANARY })).status).toBe(400);
    expect((await send("PATCH", `/agents/admin/providers/${crypto.randomUUID()}`, { apiKey: CANARY, expectedRevision: 1 })).status).toBe(404);
    expect((await send("POST", "/agents/admin/providers", { name: "Bad url", baseUrl: `javascript:${CANARY}`, apiKey: CANARY })).status).toBe(400);
    // Remove clears it.
    const current = (await send("GET", `/agents/admin/providers/${provider.id}`)).body!.provider;
    const removed = await send("PATCH", `/agents/admin/providers/${provider.id}`, { removeSecret: true, expectedRevision: current.revision });
    expect(removed.body!.provider).toMatchObject({ hasSecret: false, hint: null });
    // Put it back for the at-rest check, then look everywhere.
    const again = await send("PATCH", `/agents/admin/providers/${provider.id}`, { apiKey: CANARY, expectedRevision: removed.body!.provider.revision });
    expect(again.body!.provider.hasSecret).toBe(true);

    for (const body of bodies) expect(body).not.toContain(CANARY);
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (const path of [config.databasePath, `${config.databasePath}-wal`]) {
      if (!existsSync(path)) continue;
      expect({ path: path.split("/").pop(), found: readFileSync(path).includes(Buffer.from("NOOKCANARY")) }).toEqual({ path: path.split("/").pop(), found: false });
    }
    for (const row of db.query("SELECT metadata_json FROM audit_log WHERE metadata_json IS NOT NULL").all() as Array<{ metadata_json: string }>) expect(row.metadata_json).not.toContain("NOOKCANARY");
    expect(logged.join("\n")).not.toContain("NOOKCANARY");
    // The stored envelope opens under the configured key and nothing else.
    expect(verifySecrets(config.agents.key!)).toMatchObject({ failed: 0 });
    expect(verifySecrets(Buffer.alloc(32, 99)).failed).toBeGreaterThan(0);
    await send("DELETE", `/agents/admin/providers/${provider.id}`);
  });

  test("non-admins never see the admin routes; without the key the module answers 503 and hides itself", async () => {
    const member = await createUser("Secrets member");
    expect((await api(member, "GET", "/agents/admin/providers")).status).toBe(404);
    expect((await api(member, "POST", "/agents/admin/providers", { name: "x", apiKey: CANARY })).status).toBe(404);
    expect((await api(member, "GET", "/agents/admin/settings")).status).toBe(404);
    const admin = await createUser("Secrets admin 2");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const key = config.agents.key;
    try {
      expect(setAgentsKeyForTests(null)).toEqual({ enabled: false, reason: "unset" });
      expect((await api(member, "GET", "/agents")).status).toBe(503);
      expect((await api(member, "GET", "/chats")).status).toBe(503);
      // Off is not a capacity condition: no Retry-After.
      const off = await request("/chats", {}, member);
      expect(off.status).toBe(503);
      expect(off.headers.get("retry-after")).toBeNull();
      expect((await api(admin, "GET", "/agents/admin/providers")).status).toBe(503);
      expect((await api(member, "GET", "/agents/status")).body).toMatchObject({ enabled: false, reason: null, canChat: false });
      expect((await api(admin, "GET", "/agents/status")).body).toMatchObject({ enabled: false, reason: "unset" });
      expect((await api(member, "GET", "/auth/me")).body.features.agents).toBe(false);
      expect((await api(admin, "GET", "/auth/me")).body.features.agents).toBe(true);
      // A key that does not open stored secrets keeps the module off with its own reason.
      // Wave 41: tool-server credentials are checked too.
      // Report data source passwords count too: whatever earlier files stored, the check sees all three tables.
      expect(setAgentsKeyForTests(Buffer.alloc(32, 77)).reason).toBe(storedSecretCount() > 0 ? "key_mismatch" : null);
    } finally {
      setAgentsKeyForTests(key);
    }
    expect(agentsStatus().enabled).toBe(true);
    // Members see the module once it is on and a provider exists (QA Q5); admins always.
    expect((await api(member, "GET", "/auth/me")).body.features.agents).toBe(db.query("SELECT 1 FROM agent_providers LIMIT 1").get() !== null);
    expect((await api(admin, "GET", "/auth/me")).body.features.agents).toBe(true);
  });
});
