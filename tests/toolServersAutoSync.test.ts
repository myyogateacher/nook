import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api } from "./support/mcpClient";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";

const toolServers = await import("../server/agents/toolServers");
const { captureLogs } = await import("../server/log");
const { createServerAndSync, deleteServer, ensureSynced, resyncStaleServers, resetAutoSyncForTests, resetToolServersForTests, serverRow, setPolicies, syncInFlight, LAZY_SYNC_INTERVAL_MS } = toolServers;

/**
 * C1: tool servers sync on their own. A save syncs (create; an edit of the URL, transport,
 * credential, or turning it on), a failing sync still saves and records why, a sync past the
 * save's bound finishes in the background as `syncing`, the hourly sweep re-syncs servers last
 * synced over a day ago, `ensureSynced` syncs a never-synced server at most once a minute, and
 * admin policies carry across syncs (kept for tools that return, defaults for new ones).
 */

retireUsersAfterFile();
const first = startFakeMcpServer(0);
const second = startFakeMcpServer(0);
/** A port nothing listens on: the sync fails as unreachable. */
const deadUrl = (() => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const url = `http://127.0.0.1:${probe.port}/mcp`;
  probe.stop(true);
  return url;
})();
let admin: Session;
const created: string[] = [];
const listCalls = (server: { calls: Array<{ method: string | null }> }) => server.calls.filter((call) => call.method === "tools/list").length;

beforeAll(async () => {
  admin = await createUser("Auto-sync admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
});

afterAll(async () => {
  for (const id of created) {
    try { deleteServer(admin.userId, id); } catch { /* already gone */ }
  }
  await resetToolServersForTests();
  first.stop();
  second.stop();
});

async function add(body: Record<string, unknown>) {
  const response = await api(admin, "POST", "/agents/admin/servers", { timeoutMs: 5000, ...body });
  expect(response.status).toBe(201);
  created.push(response.body.server.id);
  return response.body as { server: { id: string; revision: number; status: string; lastError: string | null; tools: Array<{ name: string; policy: string }>; toolsSyncedAt: string | null }; synced: boolean };
}

describe("tool servers sync on save (C1)", () => {
  test("create syncs at once and returns the synced catalog", async () => {
    const before = listCalls(first);
    const saved = await add({ name: "Auto one", url: first.url });
    expect(saved.synced).toBe(true);
    expect(saved.server.status).toBe("ok");
    expect(saved.server.toolsSyncedAt).not.toBeNull();
    expect(saved.server.tools.map((tool) => tool.name)).toContain("echo");
    expect(listCalls(first)).toBeGreaterThan(before);
  });

  test("an edit of the URL re-syncs; a rename does not", async () => {
    const saved = await add({ name: "Auto move", url: first.url });
    const renamed = await api(admin, "PATCH", `/agents/admin/servers/${saved.server.id}`, { name: "Auto moved", expectedRevision: saved.server.revision });
    expect(renamed.status).toBe(200);
    expect(renamed.body.synced).toBe(false);
    const before = listCalls(second);
    const moved = await api(admin, "PATCH", `/agents/admin/servers/${saved.server.id}`, { url: second.url, expectedRevision: renamed.body.server.revision });
    expect(moved.status).toBe(200);
    expect(moved.body.synced).toBe(true);
    expect(moved.body.server.status).toBe("ok");
    expect(listCalls(second)).toBeGreaterThan(before);
  });

  test("turning a server on syncs it", async () => {
    const saved = await add({ name: "Auto off", url: first.url, enabled: false });
    expect(saved.synced).toBe(false);
    expect(saved.server.toolsSyncedAt).toBeNull();
    const on = await api(admin, "PATCH", `/agents/admin/servers/${saved.server.id}`, { enabled: true, expectedRevision: saved.server.revision });
    expect(on.body.synced).toBe(true);
    expect(on.body.server.status).toBe("ok");
  });

  test("a failing sync still saves the server, with its status and error", async () => {
    const logs = captureLogs({ level: "info" });
    let saved;
    try {
      saved = await add({ name: "Auto dead", url: deadUrl });
    } finally {
      logs.restore();
    }
    expect(saved.synced).toBe(true);
    expect(saved.server.status).toBe("unreachable");
    expect(saved.server.lastError).toBeTruthy();
    expect(serverRow(saved.server.id).status).toBe("unreachable");
    expect(logs.text()).toContain("sync failed");
    expect(logs.text()).toContain("agents");
  });

  test("a sync past the save's bound finishes in the background as syncing", async () => {
    const saved = await createServerAndSync(admin.userId, { name: "Auto slow", url: first.url, timeoutMs: 5000 }, 0);
    created.push(saved.server.id);
    expect(saved.synced).toBe(true);
    expect(saved.server.status).toBe("syncing");
    for (let i = 0; i < 100 && syncInFlight(saved.server.id); i += 1) await Bun.sleep(20);
    expect(serverRow(saved.server.id).status).toBe("ok");
  });
});

describe("background re-sync (C1)", () => {
  test("servers last synced over a day ago re-sync; fresh and disabled ones do not", async () => {
    const stale = await add({ name: "Auto stale", url: first.url });
    const fresh = await add({ name: "Auto fresh", url: second.url });
    const off = await add({ name: "Auto stale off", url: second.url });
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.query("UPDATE agent_tool_servers SET tools_synced_at = ? WHERE id IN (?, ?)").run(old, stale.server.id, off.server.id);
    db.query("UPDATE agent_tool_servers SET enabled = 0 WHERE id = ?").run(off.server.id);
    // Other files' servers may be stale too; only these three are checked.
    const firstBefore = listCalls(first);
    const secondBefore = listCalls(second);
    const count = await resyncStaleServers();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(serverRow(stale.server.id).tools_synced_at! > old).toBe(true);
    expect(listCalls(first)).toBeGreaterThan(firstBefore);
    expect(serverRow(off.server.id).tools_synced_at).toBe(old);
    expect(serverRow(fresh.server.id).tools_synced_at).toBe(fresh.server.toolsSyncedAt);
    expect(listCalls(second)).toBe(secondBefore);
  });
});

describe("lazy sync (C1)", () => {
  test("a never-synced enabled server syncs once, at most once a minute", async () => {
    resetAutoSyncForTests();
    const saved = await add({ name: "Auto lazy", url: deadUrl, enabled: false });
    db.query("UPDATE agent_tool_servers SET enabled = 1 WHERE id = ?").run(saved.server.id);
    const t0 = Date.now();
    await ensureSynced(saved.server.id, t0);
    const afterFirst = serverRow(saved.server.id);
    expect(afterFirst.status).toBe("unreachable");
    await ensureSynced(saved.server.id, t0 + 1000);
    expect(serverRow(saved.server.id).revision).toBe(afterFirst.revision);
    await ensureSynced(saved.server.id, t0 + LAZY_SYNC_INTERVAL_MS + 1);
    expect(serverRow(saved.server.id).revision).toBeGreaterThan(afterFirst.revision);
    // Once synced, it is never lazily synced again.
    db.query("UPDATE agent_tool_servers SET url = ? WHERE id = ?").run(first.url, saved.server.id);
    await ensureSynced(saved.server.id, t0 + 3 * LAZY_SYNC_INTERVAL_MS);
    expect(serverRow(saved.server.id).status).toBe("ok");
    const before = listCalls(first);
    await ensureSynced(saved.server.id, t0 + 5 * LAZY_SYNC_INTERVAL_MS);
    expect(listCalls(first)).toBe(before);
  });

  test("the agents tool catalog lazily syncs a never-synced server", async () => {
    resetAutoSyncForTests();
    const saved = await add({ name: "Auto catalog", url: first.url, enabled: false, availability: "all" });
    db.query("UPDATE agent_tool_servers SET enabled = 1 WHERE id = ?").run(saved.server.id);
    const catalog = await api(admin, "GET", "/agents/catalog");
    expect(catalog.status).toBe(200);
    const listed = (catalog.body.catalog.servers as Array<{ id: string; status: string; tools: unknown[] }>).find((server) => server.id === saved.server.id)!;
    expect(listed.status).toBe("ok");
    expect(listed.tools.length).toBeGreaterThan(0);
  });
});

describe("policies across syncs (C1)", () => {
  test("admin policies stay, new tools get the default, removed tools keep theirs for a return", async () => {
    const saved = await add({ name: "Auto policy", url: first.url });
    const id = saved.server.id;
    setPolicies(admin.userId, id, { echo: "off", fetch_page: "confirm" });
    // Pretend write_thing is new and `returning` was listed before and has gone away.
    const row = serverRow(id);
    const tools = (JSON.parse(row.tools_json) as Array<{ name: string }>).filter((tool) => tool.name !== "write_thing");
    db.query("UPDATE agent_tool_servers SET tools_json = ? WHERE id = ?").run(JSON.stringify([...tools, { ...tools[0], name: "returning" }]), id);
    db.query("DELETE FROM agent_tool_policies WHERE server_id = ? AND tool_name = 'write_thing'").run(id);
    db.query("INSERT INTO agent_tool_policies (server_id, tool_name, policy) VALUES (?, 'returning', 'off')").run(id);
    const logs = captureLogs({ level: "info" });
    let synced;
    try {
      synced = await toolServers.syncServer(admin.userId, id);
    } finally {
      logs.restore();
    }
    const policy = Object.fromEntries(synced.tools.map((tool) => [tool.name, tool.policy]));
    expect(policy).toMatchObject({ echo: "off", fetch_page: "confirm", write_thing: "confirm" });
    expect(policy.returning).toBeUndefined();
    const stored = db.query("SELECT policy FROM agent_tool_policies WHERE server_id = ? AND tool_name = 'returning'").get(id) as { policy: string } | null;
    expect(stored?.policy).toBe("off");
    expect(logs.text()).toContain("1 added (write_thing)");
    expect(logs.text()).toContain("1 removed (returning)");
  });
});
