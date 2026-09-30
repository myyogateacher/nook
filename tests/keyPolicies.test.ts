import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { resetTeamRateLimits } = await import("../server/team/routes");
const { DEFAULT_POLICIES, readPolicies, resetPoliciesForTests } = await import("../server/team/policies");

/**
 * `/api/team/policies` (access plan D285, T209): admins only, CAS by revision, every change in
 * access_events, an impact preview that matches what the call-time check then blocks.
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
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

describe("team key policies", () => {
  test("admins read and write; members and viewers get 403, guests 404", async () => {
    const admin = await user("Policies admin", "admin");
    const state = await api(admin, "GET", "/team/policies");
    expect(state.status).toBe(200);
    expect(state.body.policies).toEqual(DEFAULT_POLICIES);
    expect(state.body.revision).toBe(0);
    for (const role of ["member", "viewer"] as const) {
      const other = await user(`Policies ${role}`, role);
      expect((await api(other, "GET", "/team/policies")).body.code).toBe("ADMIN_ONLY");
      expect((await api(other, "PUT", "/team/policies", { policies: DEFAULT_POLICIES, revision: 0 })).status).toBe(403);
    }
    const guest = await user("Policies guest", "guest");
    expect((await api(guest, "GET", "/team/policies")).status).toBe(404);
    expect((await api(guest, "PUT", "/team/policies", { policies: DEFAULT_POLICIES, revision: 0 })).status).toBe(404);
  });

  test("saves with a compare-and-swap, validates, and records only which settings changed", async () => {
    const admin = await user("Policies writer", "admin");
    const next = { ...DEFAULT_POLICIES, keyMaxDays: 30, keyDefaultDays: 14, keyRequireExpiry: true };
    const saved = await api(admin, "PUT", "/team/policies", { policies: next, revision: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body.changed).toEqual(["key_max_days", "key_default_days", "key_require_expiry"]);
    expect(saved.body.revision).toBe(3);
    expect(readPolicies()).toEqual(next);
    // A stale revision is refused.
    expect((await api(admin, "PUT", "/team/policies", { policies: DEFAULT_POLICIES, revision: 0 })).body.code).toBe("POLICIES_CHANGED");
    // Default longer than the maximum, unknown modules or roles, and out-of-range numbers are 400.
    for (const bad of [{ keyDefaultDays: 60 }, { keyMaxDays: 0 }, { keyMaxDays: 400 }, { keysPerUser: 0 }, { mcpRoles: ["guest"] },
      { keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["vault"] } }, { extra: true }]) {
      expect((await api(admin, "PUT", "/team/policies", { policies: { ...next, ...bad }, revision: 3 })).status).toBe(400);
    }
    const event = db.query("SELECT actor_id, meta_json FROM access_events WHERE action = 'policy.changed' ORDER BY created_at DESC LIMIT 1").get() as { actor_id: string; meta_json: string };
    expect(event.actor_id).toBe(admin.userId);
    expect(JSON.parse(event.meta_json)).toEqual({ settings: ["key_max_days", "key_default_days", "key_require_expiry"] });
    expect(saved.body.updatedBy).toEqual({ id: admin.userId, displayName: "Policies writer" });
  });

  test("the preview counts the keys a change would block, and matches the call-time check", async () => {
    resetPoliciesForTests();
    const admin = await user("Policies preview", "admin");
    const member = await user("Policies preview member");
    // Other files' keys share this database: measure the change these three keys make.
    const strict = { ...DEFAULT_POLICIES, keyMaxDays: 30, keyDefaultDays: 30, keyRequireExpiry: true };
    const notesOnly = { ...DEFAULT_POLICIES, keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["notes" as const] } };
    const impact = async (policies: typeof DEFAULT_POLICIES) => (await api(admin, "POST", "/team/policies/preview", { policies })).body.impact as Record<string, number>;
    const before = { strict: await impact(strict), notesOnly: await impact(notesOnly), current: (await api(admin, "GET", "/team/policies")).body.impact as Record<string, number> };
    createApiKey(member.userId, { name: "Long", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 90 });
    createApiKey(member.userId, { name: "Short", surfaces: "mcp", grants: [{ module: "tasks", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 10 });
    createApiKey(member.userId, { name: "Forever", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: null });
    const delta = (after: Record<string, number>, base: Record<string, number>) => Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - base[name]!]));
    expect(delta(await impact(strict), before.strict)).toEqual({ liveKeys: 3, blocked: 2, newlyBlocked: 2, narrowed: 0, lostSurface: 0, lostModule: 0 });
    expect(delta(await impact(notesOnly), before.notesOnly)).toEqual({ liveKeys: 3, blocked: 0, newlyBlocked: 0, narrowed: 1, lostSurface: 0, lostModule: 1 });
    expect(delta((await api(admin, "GET", "/team/policies")).body.impact, before.current)).toEqual({ liveKeys: 3, blocked: 0, newlyBlocked: 0, narrowed: 0, lostSurface: 0, lostModule: 0 });
    // The member sees the policy summary on their own keys page.
    const mine = await api(member, "GET", "/keys");
    expect(mine.body.policy).toMatchObject({ keyMaxDays: 365, modules: DEFAULT_POLICIES.keyModulesByRole.member, mcpAllowed: true, restAllowed: true });
  });

  test("the preview skips expired and grace-ended keys and checks each key on its own surfaces (review L2)", async () => {
    resetPoliciesForTests();
    const admin = await user("Policies surfaces", "admin");
    const member = await user("Policies surfaces member");
    const noMcp = { ...DEFAULT_POLICIES, mcpRoles: ["admin" as const, "viewer" as const] };
    const noRest = { ...DEFAULT_POLICIES, restRoles: ["admin" as const] };
    const neither = { ...noMcp, restRoles: ["admin" as const] };
    const impact = async (policies: typeof DEFAULT_POLICIES) => (await api(admin, "POST", "/team/policies/preview", { policies })).body.impact as Record<string, number>;
    const before = { noMcp: await impact(noMcp), noRest: await impact(noRest), neither: await impact(neither) };
    const grant = [{ module: "notes" as const, permission: "read" as const, resourceKind: null, resourceId: null }];
    const make = (name: string, surfaces: "mcp" | "rest" | "both") => createApiKey(member.userId, { name, surfaces, grants: grant, expiresInDays: 30 }).id;
    make("MCP", "mcp");
    make("REST", "rest");
    make("Both", "both");
    const expired = make("Expired", "mcp");
    const graceEnded = make("Grace ended", "rest");
    db.query("UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired);
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), graceEnded);
    const delta = (after: Record<string, number>, base: Record<string, number>) => Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - base[name]!]));
    // Only the three usable keys count. MCP off: the MCP key is blocked, the both key loses a surface.
    expect(delta(await impact(noMcp), before.noMcp)).toEqual({ liveKeys: 3, blocked: 1, newlyBlocked: 1, narrowed: 1, lostSurface: 1, lostModule: 0 });
    // REST off: the REST key is blocked (it was checked against mcpRoles before), the both key narrowed.
    expect(delta(await impact(noRest), before.noRest)).toEqual({ liveKeys: 3, blocked: 1, newlyBlocked: 1, narrowed: 1, lostSurface: 1, lostModule: 0 });
    // Both off: all three blocked.
    expect(delta(await impact(neither), before.neither)).toEqual({ liveKeys: 3, blocked: 3, newlyBlocked: 3, narrowed: 0, lostSurface: 0, lostModule: 0 });
  });

  test("a stored value that no longer validates falls back to its default, field by field", () => {
    db.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES ('key_max_days', '9999', ?)").run(new Date().toISOString());
    db.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES ('keys_per_user', '3', ?)").run(new Date().toISOString());
    expect(readPolicies()).toEqual({ ...DEFAULT_POLICIES, keysPerUser: 3 });
  });
});
