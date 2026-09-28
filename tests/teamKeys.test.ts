import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { resetTeamRateLimits } = await import("../server/team/routes");
const { DEFAULT_POLICIES, policiesRevision, resetPoliciesForTests, writePolicies } = await import("../server/team/policies");
type Grant = import("../server/keyGrants").Grant;

/**
 * Team → Keys (access plan §C.6, D268, D269, T204, T215, T218): every live key across the team,
 * metadata only, filterable, with admin revoke (reason required) that the owner sees.
 */

beforeEach(() => resetTeamRateLimits());
afterEach(() => resetPoliciesForTests());

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}
async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any>, text };
}
const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
async function mcpStatus(token: string) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  await response.text();
  return response.status;
}

describe("Team → Keys inventory state filter (review L3)", () => {
  test("the state filter runs before the page cut: pages are full and nextCursor is honest", async () => {
    const admin = await user("Inventory paging admin", "admin");
    const member = await user("Inventory paging member");
    const old = [0, 1, 2].map((index) => {
      const created = createApiKey(member.userId, { name: `Forever ${index}`, surfaces: "mcp", grants: [all("notes", "read")], expiresInDays: null });
      db.query("UPDATE mcp_api_keys SET created_at = ? WHERE id = ?").run(new Date(Date.now() - (10 + index) * 86_400_000).toISOString(), created.id);
      return created.id;
    });
    // More than a page of newer keys that do not match.
    for (let index = 0; index < 205; index += 1) createApiKey(member.userId, { name: `Busy ${index}`, surfaces: "mcp", grants: [all("notes", "read")], expiresInDays: 30 });
    const listed = await api(admin, "GET", `/team/keys?owner=${member.userId}&state=no_expiry`);
    expect(listed.body.keys.map((key: { id: string }) => key.id)).toEqual(old);
    expect(listed.body.nextCursor).toBeNull();
    // Unfiltered, the first page is full and points on.
    const first = await api(admin, "GET", `/team/keys?owner=${member.userId}`);
    expect(first.body.keys.length).toBe(200);
    expect(first.body.nextCursor).not.toBeNull();
    const active = await api(admin, "GET", `/team/keys?owner=${member.userId}&state=active`);
    expect(active.body.keys.length).toBe(200);
    const rest = await api(admin, "GET", `/team/keys?owner=${member.userId}&state=active&cursor=${encodeURIComponent(active.body.nextCursor)}`);
    expect(rest.body.keys.length).toBe(8);
    expect(rest.body.nextCursor).toBeNull();
  });

  test("every state filter returns exactly the keys whose listed state matches", async () => {
    const admin = await user("Inventory states admin", "admin");
    const member = await user("Inventory states member");
    const make = (name: string, surfaces: "mcp" | "rest" | "both", days: number | null) => createApiKey(member.userId, { name, surfaces, grants: [all("notes", "read")], expiresInDays: days }).id;
    make("Active", "mcp", 30);
    make("Soon", "mcp", 5);
    make("Forever", "both", null);
    make("Rest", "rest", 30);
    const long = make("Long", "mcp", 200);
    const grace = make("Grace", "mcp", 30);
    const ended = make("Grace ended", "mcp", 30);
    const expired = make("Expired", "mcp", 30);
    const unused = make("Unused", "mcp", 30);
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() + 3_600_000).toISOString(), grace);
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), ended);
    db.query("UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired);
    db.query("UPDATE mcp_api_keys SET last_used_at = ? WHERE user_id = ? AND id <> ?").run(new Date().toISOString(), member.userId, unused);
    // Blocks: the 200-day key by lifetime, the REST key by role; the both key keeps MCP.
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyMaxDays: 90, keyDefaultDays: 30, restRoles: ["admin"] }, policiesRevision());
    const everything = (await api(admin, "GET", `/team/keys?owner=${member.userId}`)).body.keys as Array<{ id: string; name: string; state: string; expiresAt: string | null; lastUsedAt: string | null }>;
    const expected: Record<string, (key: typeof everything[number]) => boolean> = {
      active: (key) => key.state === "active",
      grace: (key) => key.state === "grace",
      blocked: (key) => key.state === "blocked",
      expired: (key) => key.state === "expired",
      expiring: (key) => key.expiresAt !== null && Date.parse(key.expiresAt) > Date.now() && Date.parse(key.expiresAt) - Date.now() < 14 * 86_400_000,
      no_expiry: (key) => key.expiresAt === null,
      unused: (key) => key.lastUsedAt === null
    };
    for (const [state, matches] of Object.entries(expected)) {
      const filtered = (await api(admin, "GET", `/team/keys?owner=${member.userId}&state=${state}`)).body.keys as Array<{ name: string }>;
      expect({ state, names: filtered.map((key) => key.name).sort() }).toEqual({ state, names: everything.filter(matches).map((key) => key.name).sort() });
    }
    const names = (state: string) => everything.filter(expected[state]!).map((key) => key.name).sort();
    expect(names("blocked")).toEqual(["Long", "Rest"]);
    expect(names("active")).toEqual(["Active", "Forever", "Soon", "Unused"]);
    expect(names("grace")).toEqual(["Grace"]);
    expect(names("expired")).toEqual(["Expired"]);
    expect(everything.find((key) => key.id === long)!.state).toBe("blocked");
  });
});

describe("Team → Keys inventory", () => {
  test("lists every live key with owner and grant summary, never token material or item names", async () => {
    const admin = await user("Inventory admin", "admin");
    const member = await user("Inventory member");
    const board = (await api(member, "POST", "/tasks/boards", { name: "Secret roadmap" })).body.board.id as string;
    const scoped = createApiKey(member.userId, { name: "CI bot", surfaces: "mcp", grants: [all("notes", "read"), { module: "tasks", permission: "write", resourceKind: "board", resourceId: board }], expiresInDays: 30 });
    const forever = createApiKey(member.userId, { name: "Old laptop", surfaces: "mcp", grants: [all("notes", "read")], expiresInDays: null });
    const listed = await api(admin, "GET", `/team/keys?owner=${member.userId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.keys.map((key: { name: string }) => key.name).sort()).toEqual(["CI bot", "Old laptop"]);
    const row = listed.body.keys.find((key: { id: string }) => key.id === scoped.id);
    expect(row.owner).toEqual({ id: member.userId, displayName: "Inventory member", role: "member", blocked: false });
    expect(row.prefix).toBe(scoped.prefix);
    expect(row.grants).toEqual([
      { module: "notes", permission: "read", resource: null, active: true, inactiveReason: null },
      { module: "tasks", permission: "write", resource: { kind: "board", id: board, name: null }, active: true, inactiveReason: null }
    ]);
    // No token, no hash, and no item title anywhere in the payload (T204, T215).
    expect(listed.text).not.toContain(scoped.token);
    expect(listed.text).not.toContain("token_hash");
    expect(listed.text).not.toContain("Secret roadmap");
    expect(listed.text).not.toMatch(/"hash"/);
    // Filters: module, no expiry, expiring soon, blocked.
    expect((await api(admin, "GET", `/team/keys?owner=${member.userId}&module=tasks`)).body.keys.map((key: { id: string }) => key.id)).toEqual([scoped.id]);
    expect((await api(admin, "GET", `/team/keys?owner=${member.userId}&state=no_expiry`)).body.keys.map((key: { id: string }) => key.id)).toEqual([forever.id]);
    expect((await api(admin, "GET", `/team/keys?owner=${member.userId}&state=expiring`)).body.keys).toEqual([]);
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyRequireExpiry: true }, policiesRevision());
    const blocked = await api(admin, "GET", `/team/keys?owner=${member.userId}&state=blocked`);
    expect(blocked.body.keys.map((key: { id: string; blockedBy: string }) => [key.id, key.blockedBy])).toEqual([[forever.id, "expiry_required"]]);
    expect((await api(admin, "GET", "/team/keys?state=bogus")).status).toBe(400);
    expect((await api(admin, "GET", "/team/keys?owner=not-a-uuid")).status).toBe(400);
    expect(listed.body.summary.live).toBeGreaterThanOrEqual(2);
  });

  test("members and viewers get 403, guests 404", async () => {
    for (const role of ["member", "viewer"] as const) {
      const other = await user(`Inventory ${role}`, role);
      expect((await api(other, "GET", "/team/keys")).body.code).toBe("ADMIN_ONLY");
      expect((await api(other, "POST", `/team/keys/${crypto.randomUUID()}/revoke`, { reason: "x" })).status).toBe(403);
    }
    const guest = await user("Inventory guest", "guest");
    expect((await api(guest, "GET", "/team/keys")).status).toBe(404);
    expect((await api(guest, "POST", `/team/keys/${crypto.randomUUID()}/revoke`, { reason: "x" })).status).toBe(404);
  });

  test("an admin revoke needs a reason, stops the key at once, and the owner sees who and why", async () => {
    const admin = await user("Revoke admin", "admin");
    const member = await user("Revoke member");
    const key = createApiKey(member.userId, { name: "Leaked", surfaces: "mcp", grants: [all("notes", "read")], expiresInDays: 30 });
    expect(await mcpStatus(key.token)).toBe(200);
    expect((await api(admin, "POST", `/team/keys/${key.id}/revoke`, {})).status).toBe(400);
    expect((await api(admin, "POST", `/team/keys/${key.id}/revoke`, { reason: "" })).status).toBe(400);
    const revoked = await api(admin, "POST", `/team/keys/${key.id}/revoke`, { reason: "Posted in a public channel" });
    expect(revoked.status).toBe(200);
    expect(await mcpStatus(key.token)).toBe(401);
    expect((await api(admin, "POST", `/team/keys/${key.id}/revoke`, { reason: "Again" })).status).toBe(404);
    expect((await api(admin, "POST", `/team/keys/${crypto.randomUUID()}/revoke`, { reason: "Nope" })).status).toBe(404);
    const mine = await api(member, "GET", "/keys");
    expect(mine.body.keys.find((item: { id: string }) => item.id === key.id)).toMatchObject({ state: "revoked", revokedBy: "admin", revokeReason: "Posted in a public channel" });
    // The inventory no longer lists it.
    expect((await api(admin, "GET", `/team/keys?owner=${member.userId}`)).body.keys).toEqual([]);
    // The log keeps ids and the reason's length only.
    const event = db.query("SELECT actor_id, target_user_id, meta_json FROM access_events WHERE key_id = ? AND action = 'key.revoked'").get(key.id) as { actor_id: string; target_user_id: string; meta_json: string };
    expect(event).toEqual({ actor_id: admin.userId, target_user_id: member.userId, meta_json: JSON.stringify({ by: "admin", reasonLength: 26 }) });
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'team.key_revoked' AND actor_id = ?").get(admin.userId)).toEqual({ count: 1 });
  });

  test("bulk revoke takes up to 50 keys with one reason", async () => {
    const admin = await user("Bulk admin", "admin");
    const member = await user("Bulk member");
    const keys = [1, 2, 3].map((index) => createApiKey(member.userId, { name: `Key ${index}`, surfaces: "mcp", grants: [all("notes", "read")], expiresInDays: 30 }));
    const result = await api(admin, "POST", "/team/keys/revoke", { keyIds: [...keys.map((key) => key.id), crypto.randomUUID()], reason: "Offboarding" });
    expect(result.body.revoked).toBe(3);
    for (const key of keys) expect(await mcpStatus(key.token)).toBe(401);
    expect((await api(admin, "POST", "/team/keys/revoke", { keyIds: [], reason: "x" })).status).toBe(400);
  });
});
