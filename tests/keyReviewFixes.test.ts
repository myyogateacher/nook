import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { isIP as nodeIsIP } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { config } = await import("../server/config");
const { clientAddress, clientIp } = await import("../server/clientAddress");
const { isIP } = await import("../shared/ipRanges");
const { createApiKey, flushKeyUsage, resetKeyDenialsForTests } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { DEFAULT_POLICIES, policiesRevision, resetPoliciesForTests, writePolicies } = await import("../server/team/policies");
type Grant = import("../server/keyGrants").Grant;

/**
 * The Wave 34 security review (S1–S7) and end-user QA (Q1–Q14) fixes on the server: proxies named by
 * address, own-view grants, proposal reach before validation, upload surfaces, one denial count,
 * case-insensitive Bearer, visible refusals, widening by rotation, blocked surfaces, argument names in
 * errors, stable auth codes, create-only grants, and inventory counts.
 */

const savedHops = config.trustedProxyHops;
const savedProxies = config.trustedProxyAddresses;
beforeEach(() => { resetMcpLimits(); resetKeyRouteLimits(); resetKeyDenialsForTests(); });
afterEach(() => { config.trustedProxyHops = savedHops; (config as { trustedProxyAddresses: string[] }).trustedProxyAddresses = savedProxies; resetPoliciesForTests(); });

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });
const makeKey = (session: Session, grants: Grant[], surfaces: "mcp" | "rest" | "both" = "both") => createApiKey(session.userId, { name: "Review key", surfaces, grants, expiresInDays: 30 });

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function rest(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) as Record<string, any> : {} };
}
async function mcpStatus(authorization: string) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: authorization, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  return { status: response.status, body: await response.text() };
}
function setPolicies(actorId: string, patch: Partial<typeof DEFAULT_POLICIES>) {
  writePolicies(actorId, { ...DEFAULT_POLICIES, ...patch }, policiesRevision());
}
async function admin(label: string) {
  const session = await createUser(label);
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(session.userId);
  return session;
}
async function board(owner: Session, name: string) {
  const created = await api(owner, "POST", "/tasks/boards", { name });
  const boardId = created.body.board.id as string;
  const columnId = (created.body.columns as Array<{ id: string }>)[0]!.id;
  const card = (await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: `${name} card` })).body.card as { id: string };
  return { boardId, columnId, cardId: card.id };
}

describe("S1: forwarding headers only from named proxies", () => {
  function addressVia(peer: string, forwarded: string | undefined, hops: number, proxies: string[]) {
    const app = new Hono();
    app.get("/", (c) => c.text(`${clientIp(c, hops, proxies)}|${clientAddress(c, hops, proxies)}`));
    const env = { requestIP: () => ({ address: peer, family: peer.includes(":") ? "IPv6" : "IPv4", port: 5555 }) };
    return Promise.resolve(app.fetch(new Request("http://nook.test/", { headers: forwarded ? { "X-Forwarded-For": forwarded } : {} }), env)).then((response) => response.text());
  }

  test("a peer in TRUSTED_PROXY_ADDRESSES has its header read; any other peer is itself; hops 0 never reads", async () => {
    expect(await addressVia("10.0.0.5", "203.0.113.9", 1, ["10.0.0.0/8"])).toBe("203.0.113.9|203.0.113.9");
    expect(await addressVia("198.51.100.1", "203.0.113.9", 1, ["10.0.0.0/8"])).toBe("198.51.100.1|198.51.100.1");
    expect(await addressVia("::ffff:10.1.2.3", "203.0.113.9", 1, ["10.0.0.0/8"])).toBe("203.0.113.9|203.0.113.9");
    // Without a list (the old behaviour, with a startup warning) any peer's header is read.
    expect(await addressVia("198.51.100.1", "203.0.113.9", 1, [])).toBe("203.0.113.9|203.0.113.9");
    expect(await addressVia("10.0.0.5", "203.0.113.9", 0, ["10.0.0.0/8"])).toBe("10.0.0.5|10.0.0.5");
  });

  test("a direct caller cannot claim an address inside a key's allowlist", async () => {
    config.trustedProxyHops = 1;
    (config as { trustedProxyAddresses: string[] }).trustedProxyAddresses = ["192.0.2.0/24"];
    const owner = await createUser("S1 direct");
    const created = await api(owner, "POST", "/keys", { name: "CI", surfaces: "rest", password: owner.password, grants: [{ module: "notes", permission: "read" }], ipAllowlist: ["203.0.113.0/24"] });
    // The test client connects from loopback, which is not a named proxy: its header is ignored.
    const refused = await rest(created.body.key.token, "GET", "/me", undefined, { "X-Forwarded-For": "203.0.113.9" });
    expect(refused).toMatchObject({ status: 403, body: { code: "IP_NOT_ALLOWED" } });
    (config as { trustedProxyAddresses: string[] }).trustedProxyAddresses = ["127.0.0.0/8", "::1"];
    expect((await rest(created.body.key.token, "GET", "/me", undefined, { "X-Forwarded-For": "203.0.113.9" })).status).toBe(200);
    expect((await api(owner, "GET", "/keys")).body.policy.ipProxyPinned).toBe(true);
  });

  test("TRUSTED_PROXY_ADDRESSES is validated at startup", () => {
    const configPath = join(import.meta.dir, "..", "server", "config.ts");
    const load = (value: string) => Bun.spawnSync(["bun", "--no-env-file", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(config.trustedProxyAddresses));`], {
      cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), TRUSTED_PROXY_ADDRESSES: value }, stdout: "pipe", stderr: "pipe"
    });
    expect(load(" 127.0.0.1 , 172.16.0.0/12,::1").stdout.toString().trim()).toBe(JSON.stringify(["127.0.0.1", "172.16.0.0/12", "::1"]));
    for (const bad of ["proxy.example", "10.0.0.0/0", "10.0.0.1/40"]) {
      const result = load(bad);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("TRUSTED_PROXY_ADDRESSES must be");
    }
  }, 30_000);

  test("the shared address parser agrees with node:net on every sample", () => {
    const samples = ["1.2.3.4", "255.255.255.255", "256.1.1.1", "01.2.3.4", "1.2.3", "::", "::1", "1::", "2001:db8::1", "2001:db8:0:0:0:0:0:1", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1::2::3",
      "::ffff:1.2.3.4", "::ffff:1.2.3.256", "1:2:3:4:5:6:1.2.3.4", "12345::", "g::1", "1:::2", ":1:2:3:4:5:6:7", "fe80::1", "", "a.b.c.d", "1.2.3.4.5"];
    // Verification R1: eight written groups leave no room for `::`.
    samples.push("1::2:3:4:5:6:7:8", "1:2:3:4::5:6:7:8", "1:2:3:4:5:6:7::8", "::2:3:4:5:6:7:8", "1:2:3:4:5:6:7::", "1:2:3:4:5:6::1.2.3.4", "1:2:3:4:5::1.2.3.4");
    // A seeded fuzz: 1 to 9 groups, with `::` (or not) at every position, some ending in dotted IPv4.
    let seed = 34;
    const next = (max: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % max;
    for (let round = 0; round < 400; round += 1) {
      const groups = Array.from({ length: 1 + next(9) }, () => next(0x10000).toString(16));
      if (next(4) === 0) groups.push(`${next(256)}.${next(256)}.${next(256)}.${next(256)}`);
      const at = next(groups.length + 2) - 1;
      samples.push(at < 0 ? groups.join(":") : [...groups.slice(0, at), "", ...groups.slice(at)].join(":").replace(/^:(?!:)/, "::").replace(/(?<!:):$/, "::"));
    }
    for (const sample of samples) expect({ sample, kind: isIP(sample) }).toEqual({ sample, kind: nodeIsIP(sample) });
  });
});

describe("S2: saved-view grants only on the holder's own views", () => {
  test("creation and rotation refuse others' views; an old grant on one is no longer available and reaches nothing", async () => {
    const owner = await createUser("S2 owner");
    const other = await createUser("S2 other");
    const theirs = (await api(other, "POST", "/tasks/views", { name: "Their view", query: "" })).body.view as { id: string };
    await api(other, "PUT", `/tasks/views/${theirs.id}/sharing`, { visibility: "all_users", userIds: [] });
    const mine = (await api(owner, "POST", "/tasks/views", { name: "My view", query: "" })).body.view as { id: string };
    const body = { name: "View key", surfaces: "mcp", password: owner.password };
    const refused = await api(owner, "POST", "/keys", { ...body, grants: [{ module: "tasks", permission: "read", resources: [{ kind: "task_view", id: theirs.id }] }] });
    expect(refused).toMatchObject({ status: 404, body: { code: "RESOURCE_NOT_FOUND" } });
    expect((await api(owner, "POST", "/keys", { ...body, grants: [{ module: "tasks", permission: "read", resources: [{ kind: "task_view", id: mine.id }] }] })).status).toBe(201);
    // A grant made before this rule (inserted directly) grants nothing and says why.
    const old = makeKey(owner, [on("tasks", "read", "task_view", theirs.id), on("tasks", "read", "task_view", mine.id)], "mcp");
    expect((await invokeMcpToolForTests("query_cards", { viewId: theirs.id }, old.id).then((result) => JSON.parse(result.content[0]!.text))).code).toBe("NOT_FOUND");
    expect((await invokeMcpToolForTests("query_cards", { viewId: mine.id }, old.id)).isError ?? false).toBe(false);
    const listed = (await api(owner, "GET", "/keys")).body.keys.find((key: { id: string }) => key.id === old.id);
    expect(listed.grants.find((grant: { resource: { id: string } }) => grant.resource.id === theirs.id)).toMatchObject({ active: false, inactiveReason: "unavailable" });
    expect((await api(owner, "POST", `/keys/${old.id}/rotate`, { password: owner.password })).body.code).toBe("INVALID_GRANT");
    expect((await api(owner, "PATCH", `/keys/${old.id}`, { grants: [{ module: "tasks", permission: "read", resources: [{ kind: "task_view", id: theirs.id }] }] })).body.code).toBe("INVALID_GRANT");
    expect((await api(owner, "PATCH", `/keys/${old.id}`, { grants: [{ module: "tasks", permission: "read", resources: [{ kind: "task_view", id: mine.id }] }] })).status).toBe(200);
  });
});

describe("S3: proposals are checked against the key's items first", () => {
  test("outside the grant is NOT_FOUND whatever else is wrong, exactly like a missing target", async () => {
    const owner = await createUser("S3 owner");
    const a = await board(owner, "S3 A");
    const b = await board(owner, "S3 B");
    const key = makeKey(owner, [on("tasks", "read", "board", a.boardId), all("inbox", "write")], "mcp");
    const submit = async (payload: Record<string, unknown>, kind = "card_create", title = "x") =>
      JSON.parse((await invokeMcpToolForTests("submit_proposals", { proposals: [{ kind, title, payload }] }, key.id)).content[0]!.text).results[0] as { code?: string; status?: string };
    const table: Array<[string, Record<string, unknown>, string?]> = [
      ["bad column on B", { boardId: b.boardId, columnId: crypto.randomUUID(), title: "x" }],
      ["no title on B", { boardId: b.boardId, columnId: b.columnId }],
      ["missing board", { boardId: crypto.randomUUID(), columnId: b.columnId, title: "x" }],
      ["huge title on B", { boardId: b.boardId, columnId: b.columnId, title: "x".repeat(500) }],
      ["no board", { columnId: b.columnId, title: "x" }],
      ["card update on B, bad payload", { cardId: b.cardId }, "card_update"],
      ["missing card", { cardId: crypto.randomUUID(), baseRevision: 1, title: "y" }, "card_update"]
    ];
    for (const [label, payload, kind] of table) expect({ label, code: (await submit(payload, kind)).code }).toEqual({ label, code: "NOT_FOUND" });
    // Inside the grant the usual validation answers.
    expect((await submit({ boardId: a.boardId, columnId: crypto.randomUUID(), title: "x" })).code).toBe("NOT_FOUND");
    expect((await submit({ boardId: a.boardId, columnId: a.columnId, title: "fine" })).status).toBe("pending");
  });
});

describe("S4, S5, S7: upload surfaces, one denial count, and the Bearer scheme", () => {
  test("a REST upload ticket is finished on REST only and audited as REST", async () => {
    const owner = await createUser("S4 owner");
    const key = makeKey(owner, [all("files", "write")], "both");
    const bytes = new TextEncoder().encode("hello over rest");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ticket = await rest(key.token, "POST", "/tools/begin_upload", { name: "rest.txt", sizeBytes: bytes.byteLength, sha256 });
    expect(ticket.status).toBe(200);
    const admin1 = await admin("S4 admin");
    // With REST off for members, the PUT is refused even though the key could use MCP.
    setPolicies(admin1.userId, { restRoles: ["admin"] });
    const put = () => fetch(ticket.body.uploadUrl.replace(/^https?:\/\/[^/]+/, origin), { method: "PUT", headers: { Authorization: `bearer ${key.token}`, "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) }, body: bytes });
    expect((await put()).status).toBe(403);
    resetPoliciesForTests();
    const stored = await put();
    expect(stored.status).toBe(201);
    const documentId = ((await stored.json()) as { document: { id: string } }).document.id;
    const row = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.upload' AND metadata_json LIKE ?").get(`%${documentId}%`) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({ via: "rest" });
    const wrongType = await fetch(ticket.body.uploadUrl.replace(/^https?:\/\/[^/]+/, origin), { method: "PUT", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "text/plain", "Content-Length": String(bytes.byteLength) }, body: bytes });
    expect((await wrongType.json() as { code: string }).code).toBe("CONTENT_TYPE");
  });

  test("a policy-blocked call is counted once, on the surface that was refused", async () => {
    const admin1 = await admin("S5 admin");
    const member = await createUser("S5 member");
    const key = makeKey(member, [all("notes", "read")], "both");
    setPolicies(admin1.userId, { restRoles: ["admin"] });
    expect((await rest(key.token, "GET", "/me")).status).toBe(403);
    flushKeyUsage();
    expect(db.query("SELECT surface, denied FROM api_key_surface_usage WHERE key_id = ? ORDER BY surface").all(key.id)).toEqual([{ surface: "rest", denied: 1 }]);
  });

  test("the Bearer scheme is case-insensitive on REST and MCP", async () => {
    const owner = await createUser("S7 owner");
    const key = makeKey(owner, [all("notes", "read")], "both");
    expect((await rest(null, "GET", "/me", undefined, { Authorization: `bearer ${key.token}` })).status).toBe(200);
    expect((await rest(null, "GET", "/me", undefined, { Authorization: `BEARER ${key.token}` })).status).toBe(200);
    expect((await mcpStatus(`bearer ${key.token}`)).status).toBe(200);
    const me = await rest(key.token, "GET", "/me");
    expect(me.body.limits.perSurface).toBe(true);
    expect(me.body.limits.note).toContain("on each");
  });
});

describe("Q1, Q3, Q5: refusals the owner can see, with stable codes", () => {
  test("an address refusal shows on the key row and in its events once an hour; admins see no address", async () => {
    config.trustedProxyHops = 1;
    (config as { trustedProxyAddresses: string[] }).trustedProxyAddresses = [];
    const owner = await createUser("Q1 owner");
    const created = await api(owner, "POST", "/keys", { name: "CI", surfaces: "rest", password: owner.password, grants: [{ module: "notes", permission: "read" }], ipAllowlist: ["203.0.113.0/24"] });
    const token = created.body.key.token as string;
    expect((await rest(token, "GET", "/me", undefined, { "X-Forwarded-For": "198.51.100.77" })).status).toBe(403);
    expect((await rest(token, "GET", "/me", undefined, { "X-Forwarded-For": "198.51.100.78" })).status).toBe(403);
    const key = (await api(owner, "GET", "/keys")).body.keys.find((item: { id: string }) => item.id === created.body.key.id);
    expect(key.lastDenied).toMatchObject({ reason: "ip", surface: "rest" });
    const events = (await api(owner, "GET", `/keys/${key.id}`)).body.events.filter((event: { action: string }) => event.action === "key.denied");
    expect(events).toHaveLength(1);
    expect(events[0].meta).toEqual({ reason: "ip", surface: "rest", clientPrefix: "198.51.100.0/24" });
    const admin1 = await admin("Q1 admin");
    const activity = await api(admin1, "GET", `/team/activity?keyId=${key.id}`);
    const denial = (activity.body.events as Array<{ action: string; meta: Record<string, unknown> | null }>).find((event) => event.action === "key.denied")!;
    expect(denial.meta).toEqual({ reason: "ip", surface: "rest" });
    expect(JSON.stringify(activity.body)).not.toContain("198.51.100");
  });

  test("a REST refusal by policy names REST, says MCP still works, marks the row, and records the real surface", async () => {
    const admin1 = await admin("Q3 admin");
    const member = await createUser("Q3 member");
    const key = makeKey(member, [all("notes", "read")], "both");
    setPolicies(admin1.userId, { restRoles: ["admin"] });
    const refused = await rest(key.token, "POST", "/tools/list_notes", {});
    expect(refused.body).toMatchObject({ code: "KEY_POLICY" });
    expect(refused.body.error).toContain("over the REST API");
    expect(refused.body.error).toContain("still works over MCP");
    const row = (await api(member, "GET", "/keys")).body.keys.find((item: { id: string }) => item.id === key.id);
    expect(row.blockedSurfaces).toEqual(["rest"]);
    expect(row.lastDenied).toMatchObject({ reason: "policy_surface_role", surface: "rest" });
    expect(db.query("SELECT via FROM access_events WHERE key_id = ? AND action = 'key.policy_blocked'").all(key.id)).toEqual([{ via: "rest" }]);
  });

  test("every refusal has a stable code, and a key that does not authenticate is always KEY_INVALID", async () => {
    const owner = await createUser("Q5 owner");
    const key = makeKey(owner, [all("notes", "read")], "both");
    expect((await rest(null, "GET", "/me")).body.code).toBe("AUTH_REQUIRED");
    expect((await rest(null, "GET", "/me", undefined, { Authorization: `Basic ${key.token}` })).body.code).toBe("AUTH_REQUIRED");
    expect((await rest("mynotes_" + "x".repeat(43), "GET", "/me")).body.code).toBe("KEY_INVALID");
    expect((await rest(key.token, "GET", "/me", undefined, { Origin: "https://evil.example" })).body.code).toBe("ORIGIN_INVALID");
    const expired = makeKey(owner, [all("notes", "read")], "both");
    db.query("UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.id);
    const revoked = makeKey(owner, [all("notes", "read")], "both");
    db.query("UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), revoked.id);
    for (const token of [expired.token, revoked.token]) {
      const result = await rest(token, "GET", "/me");
      expect(result).toMatchObject({ status: 401, body: { code: "KEY_INVALID", error: "This API key is not valid or no longer active" } });
    }
    // The owner sees why on the expired key (the revoked one they revoked themselves).
    expect((await api(owner, "GET", "/keys")).body.keys.find((item: { id: string }) => item.id === expired.id).lastDenied).toMatchObject({ reason: "expired", surface: "rest" });
  });
});

describe("Q2, Q4, Q7, Q11, Q12, Q14", () => {
  test("rotation may widen addresses, surfaces, and access; editing may not", async () => {
    config.trustedProxyHops = 1;
    const owner = await createUser("Q2 owner");
    const created = await api(owner, "POST", "/keys", { name: "Rotating", surfaces: "mcp", password: owner.password, grants: [{ module: "notes", permission: "read" }], ipAllowlist: ["203.0.113.8/29"] });
    const id = created.body.key.id as string;
    expect((await api(owner, "PATCH", `/keys/${id}`, { ipAllowlist: ["203.0.113.0/24"] })).body.error).toContain("Rotate the key to change this");
    const rotated = await api(owner, "POST", `/keys/${id}/rotate`, {
      password: owner.password, graceHours: 0, ipAllowlist: ["203.0.113.0/24", "198.51.100.0/24"], surfaces: "both",
      grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "write" }]
    });
    expect(rotated.status).toBe(201);
    expect(rotated.body.key).toMatchObject({ surfaces: "both", ipAllowlist: ["203.0.113.0/24", "198.51.100.0/24"] });
    expect(rotated.body.key.grants.map((grant: { module: string; permission: string }) => `${grant.module}:${grant.permission}`)).toEqual(["notes:read", "tasks:write"]);
    const cleared = await api(owner, "POST", `/keys/${rotated.body.key.id}/rotate`, { password: owner.password, graceHours: 0, ipAllowlist: null });
    expect(cleared.body.key.ipRestricted).toBe(false);
  });

  test("REST validation errors name the argument; a harmless token parameter is told to revoke only a real key", async () => {
    const owner = await createUser("Q4 owner");
    const key = makeKey(owner, [all("tasks", "write")], "rest");
    const invalid = await rest(key.token, "POST", "/tools/get_card", { cardId: 12 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.join(" ")).toContain("cardId:");
    const tokenParam = await rest(key.token, "GET", "/me?token=abc");
    expect(tokenParam.body).toMatchObject({ code: "KEY_IN_URL" });
    expect(tokenParam.body.error).toContain("If this was a real key");
  });

  test("create-only permissions take no chosen items", async () => {
    const owner = await createUser("Q7 owner");
    const refused = await api(owner, "POST", "/keys", { name: "Boards", surfaces: "mcp", password: owner.password, grants: [{ module: "whiteboards", permission: "write", resources: [{ kind: "whiteboard", id: crypto.randomUUID() }] }] });
    expect(refused).toMatchObject({ status: 400, body: { code: "INVALID_GRANT" } });
  });

  test("the inventory shows calls per surface per day and how many keys the filters match", async () => {
    const admin1 = await admin("Q12 admin");
    const member = await createUser("Q12 member");
    const key = makeKey(member, [all("notes", "read")], "both");
    await rest(key.token, "POST", "/tools/list_notes", {});
    await invokeMcpToolForTests("list_notes", {}, key.id, "mcp");
    const inventory = await api(admin1, "GET", `/team/keys?owner=${member.userId}&surface=rest`);
    const row = inventory.body.keys[0];
    expect(row.usageBySurface14d.daily.rest.at(-1)).toBe(1);
    expect(row.usageBySurface14d.daily.mcp.at(-1)).toBe(1);
    expect(row.lastUsed.rest).not.toBeNull();
    expect(inventory.body.summary.matching).toBe(1);
    expect(inventory.body.summary.live).toBeGreaterThanOrEqual(1);
  });
});
