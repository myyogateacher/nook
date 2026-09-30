import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { createSession, ServiceAccountSignInError } = await import("../server/auth");
const { verifyReauth } = await import("../server/reauth");
const { isEmailAllowed } = await import("../server/config");
const { enqueueMail } = await import("../server/mail/outbox");
const mail = await import("../server/mail");
const { notifyAccess } = await import("../server/access/notices");
const { adminRevokeKey } = await import("../server/apiKeys");
const { serviceEmailFor } = await import("../server/team/serviceAccounts");

/**
 * Service accounts, "Integrations" in the UI (Wave 36, D287, O-A11, T212): an admin-made account of
 * kind 'service' that never signs in, reaches only what owners share with it by name, receives no
 * email or bell notice, and whose keys the admins hold.
 */

beforeEach(() => { resetTeamRateLimits(); resetKeyRouteLimits(); resetMcpLimits(); });
afterEach(() => mail.setMailTransportForTests(null));

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}
async function send(session: Session | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session ?? undefined);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}
async function putAccess(session: Session, path: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", path);
  expect(current.status).toBe(200);
  return send(session, "PUT", path, body, { "If-Match": current.headers.get("ETag")! });
}
async function rest(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const tag = () => crypto.randomUUID().slice(0, 8);
async function integration(admin: Session, role: "member" | "viewer" = "member", name = `Bot ${tag()}`) {
  const created = await send(admin, "POST", "/team/integrations", { name, role, description: "Posts build results" });
  expect(created.status).toBe(201);
  return created.body.integration as { id: string; displayName: string; role: string; status: string };
}
async function integrationKey(admin: Session, integrationId: string, grants: unknown[], surfaces: "mcp" | "rest" | "both" = "rest") {
  return send(admin, "POST", `/team/integrations/${integrationId}/keys`, { name: `Key ${tag()}`, surfaces, expiresInDays: 30, grants, password: admin.password });
}
const all = (module: string, permission: string) => ({ module, permission });

describe("every sign-in path refuses an integration", () => {
  test("its address is synthetic, reserved, and on no allowlist", async () => {
    const admin = await user("SA admin addr", "admin");
    const bot = await integration(admin);
    const row = db.query("SELECT email, password_hash, kind, role, totp_secret FROM users WHERE id = ?").get(bot.id) as Record<string, string | null>;
    expect(row).toEqual({ email: serviceEmailFor(bot.id), password_hash: "!unusable:service", kind: "service", role: "member", totp_secret: null });
    expect(row.email!.endsWith("@service.invalid")).toBe(true);
    expect(isEmailAllowed(row.email!)).toBe(false);
    expect(isEmailAllowed("anyone@example.invalid")).toBe(false);
  });

  test("password sign-in, registration, password reset, invites, sessions, re-authentication, and Google all refuse it", async () => {
    const admin = await user("SA admin signin", "admin");
    const bot = await integration(admin);
    const email = serviceEmailFor(bot.id);

    // 1. Password sign-in: the sentinel never verifies; even a real hash put there by hand does not sign in.
    expect((await send(null, "POST", "/auth/login", { email, password: "correct horse battery staple" })).status).toBe(401);
    db.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = ?) WHERE id = ?").run(admin.userId, bot.id);
    const forced = await send(null, "POST", "/auth/login", { email, password: admin.password });
    expect(forced.status).toBe(401);
    expect(forced.headers.get("set-cookie")).toBeNull();
    db.query("UPDATE users SET password_hash = '!unusable:service' WHERE id = ?").run(bot.id);

    // 2. Registration with its address, or any .invalid address.
    expect((await send(null, "POST", "/auth/register", { email, displayName: "Impostor", password: "correct horse battery staple" })).status).toBe(403);
    expect((await send(null, "POST", "/auth/register", { email: `svc-${crypto.randomUUID()}@service.invalid`, displayName: "Impostor", password: "correct horse battery staple" })).status).toBe(403);

    // 3. Password reset: a token for it (however it got there) is not a live token.
    const token = "t".repeat(43);
    db.query("INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email_at_issue, expires_at, created_at) VALUES (?, ?, 'password_reset', ?, ?, ?, ?)")
      .run(crypto.randomUUID(), bot.id, createHash("sha256").update(token).digest("hex"), email, new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());
    expect((await send(null, "POST", "/auth/password-reset/check", { token })).body.code).toBe("TOKEN_INVALID");
    expect((await send(null, "POST", "/auth/password-reset/complete", { token, newPassword: "a brand new long password" })).body.code).toBe("TOKEN_INVALID");
    const request_ = await send(null, "POST", "/auth/password-reset/request", { email });
    expect(request_.status).toBe(202);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ?").get(bot.id)).toEqual({ count: 0 });

    // 4. Invite acceptance: an invite cannot be bound to its address.
    const invite = await send(admin, "POST", "/team/invites", { role: "member", email });
    expect(invite.status).toBe(400);
    expect(invite.body.code).toBe("EMAIL_NOT_ALLOWED");
    // Q-L2: the refusal does not blame an allowlist that may not be set.
    expect(invite.body.error).toBe("This address cannot be invited");

    // 5. Sessions: none can be made (server and database), so no cookie can ever carry it.
    await expect(createSession({ req: { header: () => undefined } } as never, bot.id)).rejects.toBeInstanceOf(ServiceAccountSignInError);
    expect(() => db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 'x', ?, ?, ?)")
      .run(crypto.randomUUID(), bot.id, "h".repeat(64), new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())).toThrow("SERVICE_NO_SESSION");

    // 6. TOTP and re-authentication (the second factor and the key-creation check) never pass for it.
    expect(await verifyReauth(bot.id, { password: admin.password }, "test")).toBe(false);

    // 7. Google: no identity can be linked, and admins cannot allow or reset Google for it.
    expect(() => db.query("INSERT INTO google_identities (id, user_id, subject, email, linked_at, linked_via) VALUES (?, ?, ?, ?, ?, 'signin')")
      .run(crypto.randomUUID(), bot.id, `sub-${tag()}`, "bot@example.test", new Date().toISOString())).toThrow();
    expect((await send(admin, "GET", `/team/${bot.id}/google`)).status).toBe(404);
    expect((await send(admin, "POST", `/team/${bot.id}/google/allow`, {})).status).toBeGreaterThanOrEqual(400);

    // 8. The person routes of Team never reach it: no member page, no role change to admin.
    expect((await send(admin, "GET", `/team/${bot.id}`)).status).toBe(404);
    expect((await send(admin, "PUT", `/team/${bot.id}/role`, { role: "admin", expectedRole: "member" })).status).toBe(404);
    expect((await send(admin, "PATCH", `/team/integrations/${bot.id}`, { role: "admin" })).status).toBe(400);
    expect(() => db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(bot.id)).toThrow("SERVICE_ROLE");
    expect(() => db.query("UPDATE users SET kind = 'person' WHERE id = ?").run(bot.id)).toThrow("KIND_FIXED");
    expect((await send(admin, "GET", "/team")).body.users.some((member: { id: string }) => member.id === bot.id)).toBe(false);
  });
});

describe("Team → Integrations", () => {
  test("admins only: members get 403, guests 404", async () => {
    const member = await user("SA member");
    const guest = await user("SA guest", "guest");
    expect((await send(member, "GET", "/team/integrations")).status).toBe(403);
    expect((await send(member, "POST", "/team/integrations", { name: "Nope", role: "member" })).status).toBe(403);
    expect((await send(guest, "GET", "/team/integrations")).status).toBe(404);
  });

  test("create, rename, change role, block, unblock", async () => {
    const admin = await user("SA admin crud", "admin");
    const bot = await integration(admin, "viewer", "CI reporter");
    expect(bot).toMatchObject({ displayName: "CI reporter", role: "viewer", status: "active" });
    const listed = await send(admin, "GET", "/team/integrations");
    expect(listed.body.integrations.find((item: { id: string }) => item.id === bot.id)).toMatchObject({ displayName: "CI reporter", description: "Posts build results", createdBy: { id: admin.userId } });
    const renamed = await send(admin, "PATCH", `/team/integrations/${bot.id}`, { name: "CI bot", role: "member" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.integration).toMatchObject({ displayName: "CI bot", role: "member" });
    expect(renamed.body.changed.sort()).toEqual(["name", "role"]);
    const blocked = await send(admin, "POST", `/team/integrations/${bot.id}/block`, {});
    expect(blocked.body.integration.status).toBe("blocked");
    const unblocked = await send(admin, "POST", `/team/integrations/${bot.id}/unblock`, {});
    expect(unblocked.body.integration.status).toBe("active");
    // Q-L5: Access activity says blocked and unblocked, not "changed".
    const actions = (db.query("SELECT action FROM access_events WHERE target_user_id = ? ORDER BY created_at, rowid").all(bot.id) as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toEqual(["integration.created", "integration.updated", "integration.blocked", "integration.unblocked"]);
    expect((await send(admin, "POST", "/team/integrations", { name: "Admin bot", role: "admin" })).status).toBe(400);
    expect((await send(admin, "POST", "/team/integrations", { name: "Guest bot", role: "guest" })).status).toBe(400);
  });

  test("key creation re-authenticates the admin; the key acts as the integration with its role cap, shown in Team → Keys", async () => {
    const admin = await user("SA admin keys", "admin");
    const bot = await integration(admin, "member");
    const viewerBot = await integration(admin, "viewer");
    // The admin's password is required, and a wrong one consumes nothing.
    const wrong = await send(admin, "POST", `/team/integrations/${bot.id}/keys`, { name: "k", surfaces: "rest", expiresInDays: 30, grants: [all("tasks", "read")], password: "not the password" });
    expect(wrong.status).toBe(401);
    // The role cap is the integration's: a viewer integration cannot hold a write grant. Inbox is never offered.
    expect((await integrationKey(admin, viewerBot.id, [all("tasks", "write")], "mcp")).body.code).toBe("SCOPE_NOT_ALLOWED");
    expect((await integrationKey(admin, bot.id, [all("inbox", "read")])).body.code).toBe("KEY_POLICY");
    const created = await integrationKey(admin, bot.id, [all("tasks", "read")]);
    expect(created.status).toBe(201);
    const token = created.body.key.token as string;
    expect(db.query("SELECT user_id, created_by FROM mcp_api_keys WHERE id = ?").get(created.body.key.id)).toEqual({ user_id: bot.id, created_by: admin.userId });

    // REST /me: the owner is the integration, kind 'service'; ALLOWED_EMAILS (set in tests) does not apply to it.
    const me = await rest(token, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.owner).toEqual({ id: bot.id, displayName: bot.displayName, role: "member", kind: "service" });
    expect(me.body.scopes).toEqual(["tasks:read"]);

    // Team → Keys lists it with the integration as its owner.
    const inventory = await send(admin, "GET", `/team/keys?owner=${bot.id}`);
    expect(inventory.body.keys.map((key: { id: string; owner: { id: string; kind: string } }) => [key.id, key.owner.id, key.owner.kind])).toEqual([[created.body.key.id, bot.id, "service"]]);

    // The detail lists it; narrowing and revoking need no password.
    const detail = await send(admin, "GET", `/team/integrations/${bot.id}`);
    expect(detail.body.keys.keys.map((key: { id: string }) => key.id)).toEqual([created.body.key.id]);
    expect(detail.body.keys.policy.modules).not.toContain("inbox");
    expect((await send(admin, "PATCH", `/team/integrations/${bot.id}/keys/${created.body.key.id}`, { name: "Renamed" })).body.key.name).toBe("Renamed");
    // A member cannot touch it, and a person's key id under another integration is not found.
    const member = await user("SA key member");
    expect((await send(member, "DELETE", `/team/integrations/${bot.id}/keys/${created.body.key.id}`, {})).status).toBe(403);
    // Blocking the integration pauses the key; unblocking resumes it.
    await send(admin, "POST", `/team/integrations/${bot.id}/block`, {});
    expect((await rest(token, "GET", "/me")).status).toBe(401);
    await send(admin, "POST", `/team/integrations/${bot.id}/unblock`, {});
    expect((await rest(token, "GET", "/me")).status).toBe(200);
    // Rotation re-authenticates too.
    expect((await send(admin, "POST", `/team/integrations/${bot.id}/keys/${created.body.key.id}/rotate`, { graceHours: 0, password: "wrong" })).status).toBe(401);
    const rotated = await send(admin, "POST", `/team/integrations/${bot.id}/keys/${created.body.key.id}/rotate`, { graceHours: 0, password: admin.password });
    expect(rotated.status).toBe(201);
    expect((await rest(token, "GET", "/me")).status).toBe(401);
    const newToken = rotated.body.key.token as string;
    expect((await rest(newToken, "GET", "/me")).status).toBe(200);
    expect((await send(admin, "DELETE", `/team/integrations/${bot.id}/keys/${rotated.body.key.id}`, {})).status).toBe(200);
    expect((await rest(newToken, "GET", "/me")).status).toBe(401);
  });

  test("its key reaches an item only after the owner shares it by name, never through “everyone”", async () => {
    const admin = await user("SA admin share", "admin");
    const owner = await user("SA owner");
    const bot = await integration(admin);
    const board = (await send(owner, "POST", "/tasks/boards", { name: `Shared with the bot ${tag()}` })).body.board.id as string;
    const created = await integrationKey(admin, bot.id, [all("tasks", "read")]);
    const token = created.body.key.token as string;
    const boards = async () => ((await rest(token, "POST", "/tools/list_boards", {})).body.boards as Array<{ id: string }>).map((item) => item.id);

    expect(await boards()).not.toContain(board);
    // Everyone signed in: people only; the integration is not part of that audience (D287).
    expect((await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "all_users", people: [], groups: [] })).status).toBe(200);
    expect(await boards()).not.toContain(board);
    // The admin's own view does not help either: the picker offers only what is shared with the integration.
    expect((await send(admin, "GET", `/team/integrations/${bot.id}/resources?module=tasks`)).body.resources).toEqual([]);

    // Shared by name, like a person, from the Access sheet: the picker lists it with its kind.
    const directory = await send(owner, "GET", "/users");
    expect(directory.body.users.find((person: { id: string }) => person.id === bot.id)).toMatchObject({ kind: "service", avatarUrl: null });
    const saved = await putAccess(owner, `/tasks/boards/${board}/access`, { audience: "selected", people: [{ id: bot.id, level: "view" }], groups: [] });
    expect(saved.status).toBe(200);
    expect(saved.body.people).toEqual([expect.objectContaining({ id: bot.id, kind: "service", level: "view" })]);
    expect(await boards()).toContain(board);
    expect((await send(admin, "GET", `/team/integrations/${bot.id}/resources?module=tasks`)).body.resources.map((item: { value: string }) => item.value)).toEqual([`board:${board}`]);

    // A key limited to that board can be made now, and not for a board the integration cannot open.
    const other = (await send(owner, "POST", "/tasks/boards", { name: "Not shared" })).body.board.id as string;
    expect((await integrationKey(admin, bot.id, [{ module: "tasks", permission: "read", resources: [{ kind: "board", id: other }] }])).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await integrationKey(admin, bot.id, [{ module: "tasks", permission: "read", resources: [{ kind: "board", id: board }] }])).status).toBe(201);
  });

  test("groups refuse integrations with a clear message", async () => {
    const admin = await user("SA admin groups", "admin");
    const bot = await integration(admin);
    const group = (await send(admin, "POST", "/team/groups", { name: `SA group ${tag()}` })).body.group;
    const added = await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [bot.id], revision: group.revision ?? 1 });
    expect(added.status).toBe(400);
    expect(added.body.code).toBe("INTEGRATION_NOT_ALLOWED");
  });

  test("integrations never get email or bell notices", async () => {
    const admin = await user("SA admin notices", "admin");
    const person = await user("SA notice person");
    const bot = await integration(admin);
    db.query("UPDATE users SET email_verified_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), bot.id, person.userId);
    mail.setMailTransportForTests(async () => ({ id: "msg" }));
    const payload = { event: "enabled", at: new Date().toISOString(), remaining: null };
    expect(enqueueMail({ userId: bot.id, template: "security.two_factor", payload })).toBeNull();
    expect(enqueueMail({ userId: person.userId, template: "security.two_factor", payload })).not.toBeNull();
    // An admin revoking its key from Team → Keys: a person would get a bell notice; the integration does not.
    const created = await integrationKey(admin, bot.id, [all("tasks", "read")]);
    adminRevokeKey(admin.userId, created.body.key.id, "Test");
    expect(db.query("SELECT COUNT(*) AS count FROM access_notices WHERE user_id = ?").get(bot.id)).toEqual({ count: 0 });
    expect(notifyAccess({ userId: bot.id, kind: "group_added", actorId: admin.userId })).toBe(false);
    expect(notifyAccess({ userId: person.userId, kind: "group_added", actorId: admin.userId })).toBe(true);
    // Sharing a board with it and assigning it a card mail nobody.
    const owner = await user("SA notice owner");
    const board = await send(owner, "POST", "/tasks/boards", { name: "Notice board" });
    await putAccess(owner, `/tasks/boards/${board.body.board.id}/access`, { audience: "selected", people: [{ id: bot.id, level: "edit" }], groups: [] });
    const columnId = (board.body.columns as Array<{ id: string }>)[0]!.id;
    await send(owner, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId, title: "For the bot", assigneeIds: [bot.id] });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ?").get(bot.id)).toEqual({ count: 0 });
  });

  test("its content shows its name and the integration mark; delete keeps it blocked when it wrote something", async () => {
    const admin = await user("SA admin delete", "admin");
    const owner = await user("SA delete owner");
    const quiet = await integration(admin);
    const busy = await integration(admin);
    const board = await send(owner, "POST", "/tasks/boards", { name: "Delete board" });
    const boardId = board.body.board.id as string;
    const columnId = (board.body.columns as Array<{ id: string }>)[0]!.id;
    await putAccess(owner, `/tasks/boards/${boardId}/access`, { audience: "selected", people: [{ id: busy.id, level: "edit" }], groups: [] });
    const writeKey = await integrationKey(admin, busy.id, [all("tasks", "write")]);
    const card = await rest(writeKey.body.key.token, "POST", "/tools/create_card", { boardId, columnId, title: "Made by a bot" });
    expect(card.status).toBe(200);
    const cardId = (card.body.card ?? card.body).id as string;
    const comment = await rest(writeKey.body.key.token, "POST", "/tools/comment_on_card", { cardId, body: "Build passed" });
    expect(comment.status).toBe(200);
    // Attribution: the owner sees the integration's name with the integration mark.
    const detail = await send(owner, "GET", `/tasks/cards/${cardId}`);
    expect(detail.body.card).toMatchObject({ creator_name: busy.displayName, creator_is_integration: 1 });
    const comments = await send(owner, "GET", `/tasks/cards/${cardId}/comments`);
    expect(comments.body.comments[0]).toMatchObject({ author_name: busy.displayName, author_is_integration: 1, author_avatar_url: null });

    // Never keyed and made nothing: removed, and Team history about it (a block and an unblock) goes with it.
    await send(admin, "POST", `/team/integrations/${quiet.id}/block`, {});
    await send(admin, "POST", `/team/integrations/${quiet.id}/unblock`, {});
    const gone = await send(admin, "DELETE", `/team/integrations/${quiet.id}`, {});
    expect(gone.body).toMatchObject({ deleted: true, keysRevoked: 0 });
    expect(db.query("SELECT 1 FROM users WHERE id = ?").get(quiet.id)).toBeNull();

    // Keyed (even if it only read): kept as retired, so its keys' history stays; the key stops at once.
    const reader = await integration(admin);
    const readerKey = await integrationKey(admin, reader.id, [all("tasks", "read")]);
    const retired = await send(admin, "DELETE", `/team/integrations/${reader.id}`, {});
    expect(retired.body).toMatchObject({ deleted: false, retained: true, keysRevoked: 1, integration: { status: "retired", hadKeys: true, ownsContent: false } });
    expect((await rest(readerKey.body.key.token, "GET", "/me")).status).toBe(401);

    const kept = await send(admin, "DELETE", `/team/integrations/${busy.id}`, {});
    expect(kept.body).toMatchObject({ deleted: false, retained: true, keysRevoked: 1, integration: { status: "retired" } });
    expect((await rest(writeKey.body.key.token, "GET", "/me")).status).toBe(401);
    expect((await send(owner, "GET", `/tasks/cards/${cardId}`)).body.card.creator_name).toBe(busy.displayName);
  });
});

describe("retired integrations (review R3, R7)", () => {
  test("do not count toward the integration limit", async () => {
    const admin = await user("SA limit admin", "admin");
    const live = (db.query("SELECT COUNT(*) AS count FROM users WHERE kind = 'service' AND retired_at IS NULL").get() as { count: number }).count;
    const stamp = new Date().toISOString();
    const filler: string[] = [];
    try {
      // Fill every slot, then retire the fillers: a new one fits again.
      for (let index = live; index < 100; index += 1) {
        const id = crypto.randomUUID();
        filler.push(id);
        db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES (?, ?, 'Filler', '!unusable:service', ?, 'viewer', 'service')").run(id, serviceEmailFor(id), stamp);
      }
      const full = await send(admin, "POST", "/team/integrations", { name: "One too many", role: "viewer" });
      expect({ status: full.status, code: full.body.code }).toEqual({ status: 409, code: "INTEGRATION_LIMIT" });
      for (const id of filler) db.query("UPDATE users SET disabled_at = ?, retired_at = ? WHERE id = ?").run(stamp, stamp, id);
      const fits = await send(admin, "POST", "/team/integrations", { name: "Fits again", role: "viewer" });
      expect(fits.status).toBe(201);
      filler.push(fits.body.integration.id);
    } finally {
      for (const id of filler) db.query("DELETE FROM users WHERE id = ?").run(id);
    }
  });

  test("the host CLI labels integrations and refuses to manage them", async () => {
    const admin = await user("SA cli admin", "admin");
    const bot = await integration(admin, "viewer", `CLI bot ${tag()}`);
    const cli = (...args: string[]) => Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "..", "server", "team-admin.ts"), ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(cli("list").stdout.toString()).toContain(`${bot.displayName} (integration)`);
    for (const args of [["unblock", serviceEmailFor(bot.id)], ["set-role", serviceEmailFor(bot.id), "admin"]]) {
      const refused = cli(...args);
      expect({ code: refused.exitCode, err: refused.stderr.toString().trim() }).toEqual({ code: 1, err: "That account is an integration; manage it in Team → Integrations." });
    }
  }, 30_000);
});
