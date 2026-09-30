import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { config } = await import("../server/config");
const { addressAllowed, allowlistNarrows, normalizeAllowlist, parseEntry, formatEntry } = await import("../server/ipAllowlist");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");

/**
 * Per-key IP allowlists (Wave 34, access plan D284, O-A7, T211): offered and enforced only with
 * TRUSTED_PROXY_HOPS ≥ 1; the right-most trusted X-Forwarded-For entry decides; both surfaces;
 * adding or tightening narrows, removing or widening needs a rotation or a new key; refusals never
 * echo the list; admins see only that a key is limited.
 */

const savedHops = config.trustedProxyHops;
beforeEach(() => { resetMcpLimits(); resetKeyRouteLimits(); });
afterEach(() => { config.trustedProxyHops = savedHops; });

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function restMe(token: string, forwardedFor?: string) {
  const response = await fetch(`${origin}/api/v1/me`, { headers: { Authorization: `Bearer ${token}`, ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}) } });
  return { status: response.status, text: await response.text() };
}
async function mcpList(token: string, forwardedFor?: string) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  return response.status;
}
const createBody = (session: Session, extra: Record<string, unknown> = {}) => ({ name: "CI key", surfaces: "both", password: session.password, grants: [{ module: "notes", permission: "read" }], ...extra });

describe("IP allowlist parsing", () => {
  test("addresses and ranges, IPv4 and IPv6, in canonical form", () => {
    expect(normalizeAllowlist(["203.0.113.7", "203.0.113.9/24", "2001:DB8::1", "2001:db8:0:0::/32", "::ffff:198.51.100.4"])).toEqual(["203.0.113.7", "203.0.113.0/24", "2001:db8::1", "2001:db8::/32", "198.51.100.4"]);
    for (const bad of ["", "300.1.1.1", "10.0.0.0/0", "10.0.0.0/33", "2001:db8::/129", "example.com", "10.0.0.1/abc", "fe80::1%eth0"]) expect(parseEntry(bad)).toBeNull();
    expect(() => normalizeAllowlist(Array.from({ length: 11 }, (_, index) => `10.0.0.${index}`))).toThrow();
    expect(formatEntry(parseEntry("::ffff:10.0.0.0/104")!)).toBe("10.0.0.0/8");
  });

  test("membership and narrowing", () => {
    const list = ["203.0.113.0/24", "2001:db8::/32"];
    expect(addressAllowed(list, "203.0.113.200")).toBe(true);
    expect(addressAllowed(list, "::ffff:203.0.113.5")).toBe(true);
    expect(addressAllowed(list, "2001:db8:1::5")).toBe(true);
    expect(addressAllowed(list, "203.0.114.1")).toBe(false);
    expect(addressAllowed(list, "2001:db9::1")).toBe(false);
    expect(addressAllowed(list, null)).toBe(false);
    expect(allowlistNarrows(null, ["10.0.0.0/8"])).toBe(true);
    expect(allowlistNarrows(list, ["203.0.113.8/29", "2001:db8:5::/48"])).toBe(true);
    expect(allowlistNarrows(list, ["203.0.0.0/16"])).toBe(false);
    expect(allowlistNarrows(list, ["198.51.100.1"])).toBe(false);
  });
});

describe("IP allowlists on keys", () => {
  test("hidden and refused while TRUSTED_PROXY_HOPS is 0 (O-A7)", async () => {
    config.trustedProxyHops = 0;
    const owner = await createUser("Allowlist off");
    expect((await api(owner, "GET", "/keys")).body.policy.ipAllowlistAvailable).toBe(false);
    const refused = await api(owner, "POST", "/keys", createBody(owner, { ipAllowlist: ["203.0.113.0/24"] }));
    expect(refused).toMatchObject({ status: 400, body: { code: "IP_ALLOWLIST_UNAVAILABLE" } });
  });

  test("enforced on REST and MCP from the right-most trusted hop, never echoing the list", async () => {
    config.trustedProxyHops = 1;
    const owner = await createUser("Allowlist on");
    expect((await api(owner, "GET", "/keys")).body.policy.ipAllowlistAvailable).toBe(true);
    const created = await api(owner, "POST", "/keys", createBody(owner, { ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"] }));
    expect(created.status).toBe(201);
    expect(created.body.key).toMatchObject({ ipRestricted: true, ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"] });
    const token = created.body.key.token as string;
    expect((await restMe(token, "203.0.113.9")).status).toBe(200);
    expect((await restMe(token, "2001:db8:abcd::1")).status).toBe(200);
    // The client-controlled left part is never read: only the entry the proxy added counts.
    expect((await restMe(token, "203.0.113.9, 198.51.100.7")).status).toBe(403);
    expect((await restMe(token, "198.51.100.7, 203.0.113.9")).status).toBe(200);
    const outside = await restMe(token, "198.51.100.7");
    expect(outside.status).toBe(403);
    expect(outside.text).toContain("IP_NOT_ALLOWED");
    expect(outside.text).not.toContain("203.0.113");
    expect(outside.text).not.toContain("198.51.100.7");
    expect(await mcpList(token, "198.51.100.7")).toBe(403);
    expect(await mcpList(token, "203.0.113.20")).toBe(200);

    // The admin inventory shows that a key is limited, not where to.
    const admin = await createUser("Allowlist admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const inventory = await api(admin, "GET", `/team/keys?owner=${owner.userId}&ipRestricted=true`);
    expect(inventory.body.keys.map((key: { id: string }) => key.id)).toEqual([created.body.key.id]);
    expect(inventory.body.keys[0].ipRestricted).toBe(true);
    expect(JSON.stringify(inventory.body)).not.toContain("203.0.113");
    expect((await api(admin, "GET", `/team/keys?owner=${owner.userId}&ipRestricted=false`)).body.keys).toEqual([]);

    // Hops back to 0: a limited key is refused rather than let through.
    config.trustedProxyHops = 0;
    expect((await restMe(token, "203.0.113.9")).status).toBe(403);
  });

  test("adding or tightening narrows without re-authentication; widening or removing is refused (D278); rotation keeps it", async () => {
    config.trustedProxyHops = 1;
    const owner = await createUser("Allowlist narrow");
    const created = await api(owner, "POST", "/keys", createBody(owner));
    const id = created.body.key.id as string;
    expect((await api(owner, "PATCH", `/keys/${id}`, { ipAllowlist: ["203.0.113.0/24"] })).body.changed).toEqual(["ipAllowlist"]);
    expect((await api(owner, "PATCH", `/keys/${id}`, { ipAllowlist: ["203.0.113.8/29"] })).body.key.ipAllowlist).toEqual(["203.0.113.8/29"]);
    expect((await api(owner, "PATCH", `/keys/${id}`, { ipAllowlist: ["203.0.113.0/24"] })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await api(owner, "PATCH", `/keys/${id}`, { ipAllowlist: null })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await api(owner, "PATCH", `/keys/${id}`, { ipAllowlist: ["not an address"] })).body.code).toBe("INVALID_IP_ALLOWLIST");
    const rotated = await api(owner, "POST", `/keys/${id}/rotate`, { graceHours: 0, password: owner.password });
    expect(rotated.status).toBe(201);
    expect(rotated.body.key.ipAllowlist).toEqual(["203.0.113.8/29"]);
  });
});
