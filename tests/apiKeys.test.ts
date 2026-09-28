import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { flushKeyUsage, sweepKeyGraces } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { DEFAULT_POLICIES, policiesRevision, resetPoliciesForTests, writePolicies } = await import("../server/team/policies");

/**
 * `/api/keys` (access plan §C.4, §C.7, §G "Keys lifecycle"): create with grants and re-auth,
 * refusals before any code is consumed, narrowing without re-auth, rotation with grace, revoke,
 * the `/api/mcp/keys` alias, and the audit trail.
 */

beforeEach(() => {
  resetMcpLimits();
  resetKeyRouteLimits();
});
afterEach(() => resetPoliciesForTests());

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const grants = (...items: Array<[string, string, string[]?]>) => items.map(([module, permission, resourceIds]) => ({ module, permission, ...(resourceIds ? { resourceIds } : {}) }));

async function createKey(session: Session, body: Record<string, unknown> = {}) {
  return api(session, "POST", "/keys", { name: "Laptop", password: session.password, grants: grants(["notes", "read"], ["tasks", "write"]), ...body });
}

let rpcId = 0;
async function mcp(token: string, method = "tools/list") {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: {} })
  });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, tools: [] as string[] };
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return { status: 200, tools: ((JSON.parse(json) as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name).sort() };
}

async function board(owner: Session, name = "Keys board") {
  const created = await api(owner, "POST", "/tasks/boards", { name });
  return created.body.board.id as string;
}

const events = (keyId: string) => (db.query("SELECT action, via, meta_json FROM access_events WHERE key_id = ? ORDER BY created_at, rowid").all(keyId) as Array<{ action: string; via: string; meta_json: string | null }>);

describe("/api/keys", () => {
  test("creates a key from grants, shows the token once, and lists grants, expiry, and state", async () => {
    const owner = await createUser("Keys create");
    // Mail on (a fake transport) so the Wave 28 security mail is queued.
    const mail = await import("../server/mail");
    mail.setMailTransportForTests(async () => ({ id: "msg_1" }));
    const created = await createKey(owner).finally(() => mail.setMailTransportForTests(null));
    expect(created.status).toBe(201);
    const key = created.body.key;
    expect(key.token).toMatch(/^mynotes_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(key.token.slice(0, 16));
    expect(key.kind).toBe("general");
    expect(key.surfaces).toBe("mcp");
    expect(key.state).toBe("active");
    expect(key.grants.map((grant: { module: string; permission: string; resource: unknown }) => [grant.module, grant.permission, grant.resource])).toEqual([["notes", "read", null], ["tasks", "write", null]]);
    expect(key.scopes).toEqual(["notes:read", "tasks:read", "tasks:write"]);
    const days = (Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86_400_000;
    expect(days).toBe(DEFAULT_POLICIES.keyDefaultDays);

    const listed = await api(owner, "GET", "/keys");
    const row = listed.body.keys.find((item: { id: string }) => item.id === key.id);
    expect(row.token).toBeUndefined();
    expect(JSON.stringify(listed.body)).not.toContain(key.token);
    expect(JSON.stringify(listed.body)).not.toContain("token_hash");
    expect(listed.body.policy).toMatchObject({ keyMaxDays: 365, keyDefaultDays: 90 });
    expect(listed.body.liveCount).toBe(1);

    const tools = await mcp(key.token);
    expect(tools.status).toBe(200);
    expect(tools.tools).toEqual(expect.arrayContaining(["list_notes", "list_boards", "create_card"]));
    expect(tools.tools).not.toContain("bin_card");

    expect(events(key.id).map((event) => event.action)).toEqual(["key.created"]);
    // The Wave 28 security mail for a new key, with ids only in its payload.
    const mails = db.query("SELECT payload FROM mail_outbox WHERE user_id = ? AND template = 'security.api_key_created'").all(owner.userId) as Array<{ payload: string }>;
    expect(mails.map((mail) => JSON.parse(mail.payload))).toEqual([{ keyId: key.id }]);
    const auditRow = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'mcp.key_created'").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(auditRow.metadata_json)).toMatchObject({ keyId: key.id, name: "Laptop" });
    // The key's own page carries its history.
    const detail = await api(owner, "GET", `/keys/${key.id}`);
    expect(detail.body.events.map((event: { action: string }) => event.action)).toEqual(["key.created"]);
    // Someone else's key is not found.
    const stranger = await createUser("Keys stranger");
    expect((await api(stranger, "GET", `/keys/${key.id}`)).status).toBe(404);
  });

  test("refuses before the password: policy, role, unreadable items, and the count; a wrong password consumes nothing", async () => {
    const owner = await createUser("Keys refusals");
    const wrong = { password: "not the password" };
    expect((await createKey(owner, { ...wrong, expiresInDays: 400 })).status).toBe(400);
    // A policy cap refuses with 403 KEY_POLICY although the password is wrong.
    const admin = await createUser("Keys refusals admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyMaxDays: 30, keyDefaultDays: 30 }, policiesRevision());
    expect((await createKey(owner, { ...wrong, expiresInDays: 90 })).body.code).toBe("KEY_POLICY");
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["notes"] } }, policiesRevision());
    expect((await createKey(owner, wrong)).body).toMatchObject({ code: "KEY_POLICY", module: "tasks" });
    resetPoliciesForTests();
    // team:read is admin-only; an unreadable board looks missing (T205).
    expect((await createKey(owner, { ...wrong, grants: grants(["team", "read"]) })).body.code).toBe("SCOPE_NOT_ALLOWED");
    const theirs = await board(admin, "Private board");
    expect((await createKey(owner, { ...wrong, grants: grants(["tasks", "read", [theirs]]) })).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await createKey(owner, { ...wrong, grants: grants(["tasks", "read", [crypto.randomUUID()]]) })).body.code).toBe("RESOURCE_NOT_FOUND");
    // Chosen items exist only for boards, collections, and calendars in Wave 31.
    expect((await createKey(owner, { ...wrong, grants: grants(["notes", "read", [crypto.randomUUID()]]) })).body.code).toBe("INVALID_GRANT");
    expect((await createKey(owner, { ...wrong, grants: grants(["notes", "manage"]) })).status).toBe(400);
    expect((await createKey(owner, { ...wrong, grants: [] })).status).toBe(400);
    // Now the password is checked: 401, and nothing was created.
    expect((await createKey(owner, wrong)).status).toBe(401);
    expect((db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ?").get(owner.userId) as { count: number }).count).toBe(0);
    // The count comes from policy.
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keysPerUser: 2 }, policiesRevision());
    expect((await createKey(owner)).status).toBe(201);
    expect((await createKey(owner)).status).toBe(201);
    expect((await createKey(owner, wrong)).body).toMatchObject({ code: "KEY_LIMIT", limit: 2 });
  });

  test("viewers create read-only keys and guests none; chosen boards must be readable", async () => {
    const viewer = await createUser("Keys viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect((await createKey(viewer)).body.code).toBe("SCOPE_NOT_ALLOWED");
    expect((await createKey(viewer, { grants: grants(["notes", "read"], ["tasks", "read"]) })).status).toBe(201);
    const guest = await createUser("Keys guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await createKey(guest, { grants: grants(["notes", "read"]) })).body.code).toBe("ROLE_READ_ONLY");
    const owner = await createUser("Keys chooser");
    const mine = await board(owner, "Mine");
    const scoped = await createKey(owner, { grants: grants(["tasks", "write", [mine]]) });
    expect(scoped.status).toBe(201);
    expect(scoped.body.key.grants).toEqual([{ module: "tasks", permission: "write", resource: { kind: "board", id: mine, name: "Mine" }, active: true, inactiveReason: null }]);
  });

  test("narrowing needs no password and never widens (D278)", async () => {
    const owner = await createUser("Keys narrow");
    const mine = await board(owner, "Narrow board");
    const { key } = (await createKey(owner)).body;
    const narrow = (body: Record<string, unknown>) => api(owner, "PATCH", `/keys/${key.id}`, body);
    // Remove tasks: the tools go at once.
    const removed = await narrow({ grants: grants(["notes", "read"]), name: "Laptop (read)" });
    expect(removed.status).toBe(200);
    expect(removed.body.changed).toEqual(["grants", "name"]);
    expect((await mcp(key.token)).tools).not.toContain("list_boards");
    // Adding tasks back widens.
    expect((await narrow({ grants: grants(["notes", "read"], ["tasks", "read"]) })).body.code).toBe("WIDENING_NOT_ALLOWED");
    // A second key: tasks:write on all boards narrows to one board, and to read.
    const wide = (await createKey(owner, { name: "Wide" })).body.key;
    const toBoard = await api(owner, "PATCH", `/keys/${wide.id}`, { grants: grants(["notes", "read"], ["tasks", "read", [mine]]) });
    expect(toBoard.status).toBe(200);
    expect(toBoard.body.key.grants.map((grant: { permission: string; resource: { id: string } | null }) => [grant.permission, grant.resource?.id ?? null])).toEqual([["read", null], ["read", mine]]);
    // Back to all boards widens.
    expect((await api(owner, "PATCH", `/keys/${wide.id}`, { grants: grants(["tasks", "read"]) })).body.code).toBe("WIDENING_NOT_ALLOWED");
    // Surfaces only shrink; expiry only comes closer; limits only go down.
    expect((await narrow({ surfaces: "both" })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await narrow({ expiresInDays: 200 })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await narrow({ expiresInDays: 7 })).body.changed).toEqual(["expiry"]);
    expect((await narrow({ limits: { callsPerMinute: 10 } })).body.key.limits).toEqual({ callsPerMinute: 10 });
    expect((await narrow({ limits: { callsPerMinute: 20 } })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await narrow({ limits: { callsPerMinute: null } })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await narrow({})).body.changed).toEqual([]);
    expect(events(key.id).map((event) => event.action)).toEqual(["key.created", "key.narrowed", "key.narrowed", "key.narrowed"]);
    // Another user's key: 404.
    const stranger = await createUser("Keys narrow stranger");
    expect((await api(stranger, "PATCH", `/keys/${key.id}`, { name: "Mine now" })).status).toBe(404);
  });

  test("rotation re-authenticates, keeps grants, moves routines, and honours the grace (D277, T208)", async () => {
    const owner = await createUser("Keys rotate");
    const { key } = (await createKey(owner, { grants: grants(["notes", "read"], ["inbox", "write"]) })).body;
    const routine = await api(owner, "POST", "/inbox/routines", {
      name: "Bound routine", instructions: "Suggest a note.", outputKinds: ["note_draft"], cadence: "daily", atTime: "08:00", tz: "UTC", keyId: key.id
    });
    expect(routine.status).toBe(200);
    expect((await api(owner, "POST", `/keys/${key.id}/rotate`, { password: "wrong", graceHours: 24 })).status).toBe(401);
    const rotated = await api(owner, "POST", `/keys/${key.id}/rotate`, { password: owner.password, graceHours: 24 });
    expect(rotated.status).toBe(201);
    const next = rotated.body.key;
    expect(next.token).not.toBe(key.token);
    expect(next.name).toBe(key.name);
    expect(next.rotatedFrom).toBe(key.id);
    expect(next.scopes).toEqual(key.scopes);
    expect(rotated.body.oldKey.state).toBe("grace");
    expect(Date.parse(rotated.body.oldKey.revokeAfter) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect((db.query("SELECT key_id FROM routines WHERE id = ?").get(routine.body.routine.id) as { key_id: string }).key_id).toBe(next.id);
    // Both work during the grace; a second rotation of the old key is refused.
    expect((await mcp(key.token)).status).toBe(200);
    expect((await mcp(next.token)).status).toBe(200);
    expect((await api(owner, "POST", `/keys/${key.id}/rotate`, { password: owner.password })).body.code).toBe("KEY_ROTATING");
    // The grace ends: the old key stops on its next call, and the sweeper records the revocation.
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), key.id);
    expect((await mcp(key.token)).status).toBe(401);
    expect(sweepKeyGraces().gracesEnded).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT revoked_at IS NOT NULL AS revoked FROM mcp_api_keys WHERE id = ?").get(key.id)).toEqual({ revoked: 1 });
    expect(events(key.id).map((event) => event.action)).toEqual(["key.created", "key.rotated", "key.grace_ended"]);
    expect(events(next.id).map((event) => event.action)).toEqual(["key.created"]);
    // No grace: the old key stops at once.
    const again = await api(owner, "POST", `/keys/${next.id}/rotate`, { password: owner.password, graceHours: 0 });
    expect(again.status).toBe(201);
    expect((await mcp(next.token)).status).toBe(401);
    expect((await mcp(again.body.key.token)).status).toBe(200);
  });

  test("rotation runs the creation checks before the password: role, policy, and the count with the graced key (review L1)", async () => {
    const admin = await createUser("Keys rotate admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const setPolicies = (patch: Record<string, unknown>) => writePolicies(admin.userId, { ...DEFAULT_POLICIES, ...patch }, policiesRevision());
    const owner = await createUser("Keys rotate checks");
    const { key } = (await createKey(owner, { grants: grants(["notes", "read"], ["tasks", "write"]) })).body;
    // Refusals come before the password: a wrong one still gets the policy code, never 401.
    const rotate = (id: string, graceHours: number, password = "wrong") => api(owner, "POST", `/keys/${id}/rotate`, { password, graceHours });

    // The count counts the old key while its grace runs: at the limit, only a 0-hour rotation fits.
    const live = (db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").get(owner.userId) as { count: number }).count;
    setPolicies({ keysPerUser: live });
    expect((await rotate(key.id, 24)).body).toMatchObject({ code: "KEY_LIMIT", limit: live });
    expect((await rotate(key.id, 24, owner.password)).status).toBe(409);
    expect(db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ?").get(owner.userId)).toEqual({ count: live });
    setPolicies({});

    // Surface and module policy.
    setPolicies({ mcpRoles: ["admin"] });
    expect((await rotate(key.id, 24)).body.code).toBe("KEY_POLICY");
    setPolicies({ keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["notes"] } });
    expect((await rotate(key.id, 24)).body).toMatchObject({ code: "KEY_POLICY", module: "tasks" });
    setPolicies({});

    // A viewer cannot renew a write grant; a demoted guest cannot rotate at all.
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    expect((await rotate(key.id, 24)).body.code).toBe("SCOPE_NOT_ALLOWED");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(owner.userId);
    expect((await rotate(key.id, 24)).body.code).toBe("ROLE_READ_ONLY");
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(owner.userId);
    expect(db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE rotated_from = ?").get(key.id)).toEqual({ count: 0 });

    // An expired key may still be rotated with the password: that is how it is renewed.
    db.query("UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), key.id);
    const renewed = await rotate(key.id, 24, owner.password);
    expect(renewed.status).toBe(201);
    expect(renewed.body.key.state).toBe("active");
    expect((await mcp(renewed.body.key.token)).status).toBe(200);
  });

  test("a key revoked by its owner during a rotation grace is listed as revoked by self, not by the rotation (review L4)", async () => {
    const owner = await createUser("Keys revoke during grace");
    const listedBy = async (id: string) => ((await api(owner, "GET", "/keys")).body.keys as Array<{ id: string; state: string; revokedBy: string | null }>).find((item) => item.id === id);
    const first = (await createKey(owner)).body.key;
    expect((await api(owner, "POST", `/keys/${first.id}/rotate`, { password: owner.password, graceHours: 24 })).status).toBe(201);
    expect(await listedBy(first.id)).toMatchObject({ state: "grace", revokedBy: null });
    expect((await api(owner, "DELETE", `/keys/${first.id}`)).status).toBe(200);
    expect(await listedBy(first.id)).toMatchObject({ state: "revoked", revokedBy: "self" });
    expect(db.query("SELECT revoked_by FROM mcp_api_keys WHERE id = ?").get(first.id)).toEqual({ revoked_by: owner.userId });
    // A grace that runs out, and a 0-hour rotation, are the rotation's.
    const second = (await createKey(owner, { name: "Second" })).body.key;
    const rotated = await api(owner, "POST", `/keys/${second.id}/rotate`, { password: owner.password, graceHours: 1 });
    db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), second.id);
    expect(await listedBy(second.id)).toMatchObject({ state: "revoked", revokedBy: "rotation" });
    sweepKeyGraces();
    expect(await listedBy(second.id)).toMatchObject({ state: "revoked", revokedBy: "rotation" });
    const third = rotated.body.key;
    expect((await api(owner, "POST", `/keys/${third.id}/rotate`, { password: owner.password, graceHours: 0 })).status).toBe(201);
    expect(await listedBy(third.id)).toMatchObject({ state: "revoked", revokedBy: "rotation" });
    // An owner revoke from before the actor was recorded still reads "self": it landed before the grace end.
    const legacy = (await createKey(owner, { name: "Legacy" })).body.key;
    db.query("UPDATE mcp_api_keys SET revoke_after = ?, revoked_at = ? WHERE id = ?").run(new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString(), legacy.id);
    expect(await listedBy(legacy.id)).toMatchObject({ state: "revoked", revokedBy: "self" });
  });

  test("revoke is immediate, withdraws pending proposals, and is the owner's only", async () => {
    const owner = await createUser("Keys revoke");
    const { key } = (await createKey(owner)).body;
    const stranger = await createUser("Keys revoke stranger");
    expect((await api(stranger, "DELETE", `/keys/${key.id}`)).status).toBe(404);
    expect((await api(owner, "DELETE", `/keys/${key.id}`)).status).toBe(200);
    expect((await mcp(key.token)).status).toBe(401);
    expect((await api(owner, "DELETE", `/keys/${key.id}`)).status).toBe(404);
    // Revoked keys stay listed for a week, marked, so the owner sees what happened.
    const listed = await api(owner, "GET", "/keys");
    expect(listed.body.keys.find((item: { id: string }) => item.id === key.id)).toMatchObject({ state: "revoked", revokedBy: "self" });
    expect(events(key.id).map((event) => event.action)).toEqual(["key.created", "key.revoked"]);
  });

  test("the list counts each key's pending Inbox suggestions, for the revoke confirm (Friction 7)", async () => {
    const owner = await createUser("Keys pending");
    const { key } = (await createKey(owner)).body;
    const { key: quiet } = (await createKey(owner, { name: "Quiet" })).body;
    const insert = (status: string) => db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at, status)
      VALUES (?, ?, ?, 'Laptop', 'card_create', 'board', 'b', 'Card', '{}', ?, ?, ?)`).run(crypto.randomUUID(), owner.userId, key.id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), status);
    insert("pending");
    insert("pending");
    insert("rejected");
    const listed = (await api(owner, "GET", "/keys")).body.keys as Array<{ id: string; pendingProposals: number }>;
    expect(listed.find((item) => item.id === key.id)!.pendingProposals).toBe(2);
    expect(listed.find((item) => item.id === quiet.id)!.pendingProposals).toBe(0);
  });

  test("counts calls per key per day (D283)", async () => {
    const owner = await createUser("Keys usage");
    const { key } = (await createKey(owner)).body;
    for (let index = 0; index < 3; index += 1) await invokeMcpToolForTests("list_notes", {}, key.id);
    await invokeMcpToolForTests("list_documents", {}, key.id);
    // An admitted write is recorded as a write (the handler's own not-found does not undo that).
    await invokeMcpToolForTests("create_card", { boardId: crypto.randomUUID(), columnId: crypto.randomUUID(), title: "x" }, key.id);
    flushKeyUsage();
    const usage = db.query("SELECT calls, writes, denied FROM api_key_usage WHERE key_id = ?").get(key.id);
    expect(usage).toEqual({ calls: 3, writes: 1, denied: 1 });
    // The row's 14-day count is every admitted call, reads and writes.
    const listed = await api(owner, "GET", "/keys");
    expect(listed.body.keys.find((item: { id: string }) => item.id === key.id).usage14d.at(-1)).toBe(4);
  });
});

describe("/api/mcp/keys alias", () => {
  test("creates all-resources grants for its scopes, with the default expiry, and obeys team policy", async () => {
    const owner = await createUser("Alias keys");
    const created = await api(owner, "POST", "/mcp/keys", { name: "Old client", password: owner.password, scopes: ["tasks:write"] });
    expect(created.status).toBe(201);
    const key = created.body.key;
    expect(key.scopes).toEqual(["tasks:read", "tasks:write"]);
    expect(db.query("SELECT module, permission, resource_id FROM api_key_grants WHERE key_id = ? ORDER BY permission").all(key.id)).toEqual([
      { module: "tasks", permission: "read", resource_id: null }, { module: "tasks", permission: "write", resource_id: null }
    ]);
    expect(Math.round((Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86_400_000)).toBe(90);
    const listed = await api(owner, "GET", "/mcp/keys");
    expect(listed.body.keys.find((item: { id: string }) => item.id === key.id)).toMatchObject({ key_prefix: key.prefix, scopes: ["tasks:read", "tasks:write"], state: "active" });
    const admin = await createUser("Alias admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["notes"] } }, policiesRevision());
    expect((await api(owner, "POST", "/mcp/keys", { name: "Blocked", password: "wrong", scopes: ["tasks:read"] })).body.code).toBe("KEY_POLICY");
    expect((await api(owner, "DELETE", `/mcp/keys/${key.id}`)).status).toBe(200);
  });
});
