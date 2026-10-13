import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { newCollection } from "./support/collections";
import { newVault } from "./support/vault";
import { formatRoute, parseRoute } from "../src/router";
import { safeNotificationPath } from "../src/notifications/notificationsApi";

const { resetTeamRateLimits } = await import("../server/team/routes");
const { accessNoticeHref, notifyAccess } = await import("../server/access/notices");
const { createApiKey } = await import("../server/apiKeys");
const { notifyProposals } = await import("../server/inbox/service");

/**
 * Bell deep links (v0.32) and the member access page's per-feed revoke and per-routine pause.
 *
 * - Every bell kind opens a path built from ids only (T68): the item while the reader can open it,
 *   else the module's list; a path the router itself writes, so the client follows it unchanged.
 * - Admins revoke one calendar feed link or pause one routine of a member (D268, reductions only):
 *   members 403, guests 404, the person hears on the bell, and Team → Access activity records it.
 */

beforeEach(() => resetTeamRateLimits());
retireUsersAfterFile();

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function send(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A path the router writes back unchanged, whose every segment is a word or an id. */
function expectIdOnlyPath(href: string) {
  expect(href.startsWith("/")).toBe(true);
  expect(formatRoute(parseRoute(href))).toBe(href);
  expect(safeNotificationPath(href)).toBe(href);
  const [path, query] = href.split("?");
  for (const segment of path!.split("/").filter(Boolean)) expect(ID.test(segment) || /^[a-z]+$/.test(segment)).toBe(true);
  if (query) expect(query).toMatch(/^agent=[0-9a-f-]{36}$/);
}

/** The kinds named in `AccessNoticeKind`, read from the source, so a new kind cannot skip this file. */
async function noticeKinds() {
  const source = await Bun.file(new URL("../server/access/notices.ts", import.meta.url)).text();
  const union = source.slice(source.indexOf("export type AccessNoticeKind ="), source.indexOf("export type AccessNotice ="));
  return [...union.replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!).sort();
}

const tag = () => crypto.randomUUID().slice(0, 8);

describe("bell deep links (id-only hrefs, T68)", () => {
  test("every access notice kind opens the item it is about, from ids only; the line's text never reaches the link", async () => {
    const admin = await user("Bell admin", "admin");
    const owner = await user("Bell owner");
    const folder = (await send(owner, "POST", "/folders", { name: `Bell folder ${tag()}`, parentId: null })).body.folder.id as string;
    const note = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    const form = new FormData();
    form.append("file", new Blob(["bell"], { type: "text/plain" }), "bell.txt");
    const document = ((await (await request("/files", { method: "POST", body: form }, owner)).json()) as { document: { id: string } }).document.id;
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Secret board name" })).body.board.id as string;
    const view = (await send(owner, "POST", "/tasks/views", { name: "Bell view", query: "" })).body.view.id as string;
    const collection = (await newCollection(owner, { name: "Bell collection", fields: [{ name: "Name", type: "text" }] })).id as string;
    const calendar = (await send(owner, "POST", "/calendars", { name: "Bell calendar", color: "blue" })).body.calendar.id as string;
    const vault = await newVault(owner);
    const routine = (await send(owner, "POST", "/inbox/routines", { name: "Bell routine", instructions: "Suggest a note.", outputKinds: ["note_draft"], cadence: "daily", atTime: "08:00", tz: "UTC" })).body.routine.id as string;
    const gone = crypto.randomUUID();

    // [kind, resource, expected href]
    const cases: Array<[string, { kind: any; id: string } | null, string]> = [
      ["share_removed", { kind: "note", id: note }, `/notes/${note}`],
      ["share_removed", { kind: "folder", id: folder }, `/notes/folder/${folder}`],
      ["share_removed", { kind: "document", id: document }, `/files/${document}`],
      ["share_lowered", { kind: "board", id: board }, `/tasks/${board}`],
      ["share_lowered", { kind: "task_view", id: view }, `/tasks/views/${view}`],
      ["share_lowered", { kind: "collection", id: collection }, `/collections/${collection}`],
      ["share_lowered", { kind: "calendar", id: calendar }, "/calendar"],
      // Gone (or never readable): the module's list, never the id.
      ["share_removed", { kind: "board", id: gone }, "/tasks"],
      ["share_removed", { kind: "agent", id: gone }, "/settings/agents"],
      ["share_removed", { kind: "chat", id: gone }, "/chat"],
      ["access_reset", null, "/notifications"],
      ["access_reset_self", null, "/settings/access"],
      ["group_added", null, "/settings/access"],
      ["group_removed", null, "/settings/access"],
      ["key_revoked", null, "/settings/keys"],
      ["key_vault_limited", null, "/settings/keys"],
      ["key_vault_volume", null, "/settings/keys"],
      ["google_allowed", null, "/settings/security"],
      ["google_relink_allowed", null, "/settings/security"],
      ["google_reset", null, "/settings/security"],
      ["google_unlinked", null, "/settings/security"],
      ["google_relinked", null, "/settings/security"],
      ["vault_shared", { kind: "vault", id: vault.id }, `/vault/${vault.id}`],
      ["vault_removed", { kind: "vault", id: gone }, "/vault"],
      ["vault_key_rotated", { kind: "vault", id: vault.id }, `/vault/${vault.id}`],
      ["agent_shared", { kind: "agent", id: gone }, "/chat"],
      ["chat_shared", { kind: "chat", id: gone }, "/chat"],
      ["knowledge_base_shared", { kind: "knowledge_base", id: gone }, "/settings/knowledge"],
      ["agent_changed", { kind: "agent", id: gone }, "/settings/agents"],
      ["new_sign_in", { kind: "device", id: "firefox:linux" }, "/settings/security"],
      ["feed_revoked", { kind: "calendar", id: calendar }, "/settings/access"],
      ["routine_paused", { kind: "routine", id: routine }, "/inbox/routines"],
      ["avatar_removed", null, "/settings/security"]
    ];
    // Every kind the server can store is covered (readable agents, chats, and bases: tests/agentsSharing*.test.ts, knowledge tests).
    expect([...new Set(cases.map(([kind]) => kind))].sort()).toEqual(await noticeKinds());
    for (const [kind, resource, expected] of cases) {
      expect({ kind, href: accessNoticeHref({ kind, resource_kind: resource?.kind ?? null, resource_id: resource?.id ?? null }, owner.userId) }).toEqual({ kind, href: expected });
      expectIdOnlyPath(expected);
      notifyAccess({ userId: owner.userId, kind: kind as never, actorId: admin.userId, targetUserId: admin.userId, resource });
    }

    // Over HTTP: the same hrefs, each one a path the client follows unchanged; no title rides in a link.
    const bell = await send(owner, "GET", "/notifications?limit=50");
    expect(bell.status).toBe(200);
    const items = bell.body.items as Array<{ title: string; href: string }>;
    expect(items.length).toBe(cases.length);
    for (const item of items) {
      expectIdOnlyPath(item.href);
      expect(item.href).not.toContain("Secret");
      expect(item.href).not.toContain(" ");
    }
    expect(items.map((item) => item.href).sort()).toEqual(cases.map(([, , href]) => href).sort());
    expect(items.find((item) => item.title.includes("paused your routine"))).toMatchObject({ title: "Bell admin paused your routine “Bell routine”", href: "/inbox/routines" });
    expect(items.find((item) => item.title.includes("calendar feed link"))).toMatchObject({ title: "Bell admin revoked your calendar feed link for “Bell calendar”", href: "/settings/access" });
  });

  test("an item the reader cannot open links to its list, never to its id; the reader of a shared item gets the item", async () => {
    const owner = await user("Bell private owner");
    const reader = await user("Bell reader");
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Private bell board" })).body.board.id as string;
    expect(accessNoticeHref({ kind: "share_removed", resource_kind: "board", resource_id: board }, reader.userId)).toBe("/tasks");
    expect(accessNoticeHref({ kind: "feed_revoked", resource_kind: "calendar", resource_id: crypto.randomUUID() }, reader.userId)).toBe("/settings/access");
    // A routine notice names only the reader's own routine: someone else's id gives no name.
    const routine = (await send(owner, "POST", "/inbox/routines", { name: "Owner only routine", instructions: "Suggest a note.", outputKinds: ["note_draft"], cadence: "manual", tz: "UTC" })).body.routine.id as string;
    notifyAccess({ userId: reader.userId, kind: "routine_paused", actorId: owner.userId, resource: { kind: "routine", id: routine } });
    const bell = await send(reader, "GET", "/notifications");
    expect(bell.body.items[0]).toMatchObject({ title: "Bell private owner paused your routine", href: "/inbox/routines" });
    // Shared with the reader: the board itself.
    const access = await request(`/tasks/boards/${board}/access`, {}, owner);
    const shared = await request(`/tasks/boards/${board}/access`, { method: "PUT", headers: { "If-Match": access.headers.get("ETag")! }, body: JSON.stringify({ audience: "selected", people: [{ id: reader.userId, level: "view" }], groups: [] }) }, owner);
    expect(shared.status).toBe(200);
    expect(accessNoticeHref({ kind: "share_removed", resource_kind: "board", resource_id: board }, reader.userId)).toBe(`/tasks/${board}`);
  });

  test("a proposals notification about one proposal opens it; several open the Inbox", async () => {
    const owner = await user("Bell proposals");
    const key = createApiKey(owner.userId, { name: "Bell key", surfaces: "mcp", grants: [{ module: "inbox", permission: "write", resourceKind: null, resourceId: null }, { module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const keyId = key.id;
    const note = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    const proposal = crypto.randomUUID();
    const created = new Date(Date.now() - 1000).toISOString();
    db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
      VALUES (?, ?, ?, 'Bell key', 'note_draft', 'note', ?, 'One change', '{}', ?, ?)`).run(proposal, owner.userId, keyId, note, created, new Date(Date.now() + 86_400_000).toISOString());
    notifyProposals(owner.userId, keyId, 1);
    let bell = await send(owner, "GET", "/notifications");
    expect(bell.body.items[0]).toMatchObject({ kind: "proposals", title: "Key “Bell key” suggested 1 change", href: `/inbox/p/${proposal}` });
    expectIdOnlyPath(bell.body.items[0].href);
    // Resolved: it opens beside History.
    db.query("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), proposal);
    bell = await send(owner, "GET", "/notifications");
    expect(bell.body.items[0].href).toBe(`/inbox/history/p/${proposal}`);
    // A burst of several: the Inbox.
    notifyProposals(owner.userId, keyId, 2);
    bell = await send(owner, "GET", "/notifications");
    expect(bell.body.items[0]).toMatchObject({ title: "Key “Bell key” suggested 3 changes", href: "/inbox" });
  });
});

async function feedFor(session: Session, name = `Feed calendar ${tag()}`) {
  const calendar = (await send(session, "POST", "/calendars", { name, color: "green" })).body.calendar.id as string;
  const created = await send(session, "POST", `/calendars/${calendar}/feeds`, { detail: "busy" });
  expect(created.status).toBe(201);
  return { calendar, feedId: created.body.feed.id as string, token: created.body.token as string };
}

async function routineFor(session: Session, name = `Routine ${tag()}`) {
  const created = await send(session, "POST", "/inbox/routines", { name, instructions: "Suggest a note.", outputKinds: ["note_draft"], cadence: "daily", atTime: "08:00", tz: "UTC" });
  expect(created.status).toBe(200);
  return created.body.routine.id as string;
}

const fetchFeed = (calendar: string, token: string) => request(`/calendars/${calendar}/feed.ics?token=${token}`);

describe("member access: per-feed revoke and per-routine pause (D268)", () => {
  test("the page lists each feed link (calendar redacted for the admin, D269) and each routine (no instructions)", async () => {
    const admin = await user("Feeds list admin", "admin");
    const target = await user("Feeds list target");
    const feed = await feedFor(target, "Private feed calendar");
    const routine = await routineFor(target, "Listed routine");
    const page = await send(admin, "GET", `/team/members/${target.userId}/access`);
    expect(page.status).toBe(200);
    expect(page.body.feeds.live).toBe(1);
    expect(page.body.feeds.items).toEqual([expect.objectContaining({ id: feed.feedId, detail: "busy", calendar: { title: "Calendar owned by Feeds list target", titleHidden: true, owner: { displayName: "Feeds list target" } } })]);
    expect(JSON.stringify(page.body.feeds)).not.toContain(feed.calendar);
    expect(JSON.stringify(page.body.feeds)).not.toContain(feed.token);
    expect(page.body.routines.items).toEqual([expect.objectContaining({ id: routine, name: "Listed routine", enabled: true, schedule: "Daily at 08:00" })]);
    expect(JSON.stringify(page.body.routines)).not.toContain("Suggest a note");
    // The person sees their own, with the calendar named.
    const mine = await send(target, "GET", "/me/access");
    expect(mine.body.feeds.items[0].calendar).toMatchObject({ title: "Private feed calendar", titleHidden: false });
    expect(mine.body.routines.items[0]).toMatchObject({ id: routine, enabled: true });
  });

  test("only admins act: members and viewers 403, guests 404, someone else's feed or routine 404", async () => {
    const admin = await user("Feeds gate admin", "admin");
    const target = await user("Feeds gate target");
    const other = await user("Feeds gate other");
    const viewer = await user("Feeds gate viewer", "viewer");
    const guest = await user("Feeds gate guest", "guest");
    const feed = await feedFor(target);
    const routine = await routineFor(target);
    const revoke = `/team/members/${target.userId}/feeds/${feed.feedId}/revoke`;
    const pause = `/team/members/${target.userId}/routines/${routine}/pause`;
    for (const path of [revoke, pause]) {
      expect((await send(other, "POST", path, {})).body.code).toBe("ADMIN_ONLY");
      expect((await send(target, "POST", path, {})).status).toBe(403);
      expect((await send(viewer, "POST", path, {})).status).toBe(403);
      expect((await send(guest, "POST", path, {})).status).toBe(404);
      expect((await send(undefined, "POST", path, {})).status).toBe(401);
    }
    // Another member cannot use the owner routes on someone else's either.
    expect((await send(other, "DELETE", `/feeds/${feed.feedId}`, {})).status).toBe(404);
    expect((await send(other, "POST", `/inbox/routines/${routine}/pause`, {})).status).toBe(404);
    // The feed or routine must be the person's own: under someone else's page it is 404.
    expect((await send(admin, "POST", `/team/members/${other.userId}/feeds/${feed.feedId}/revoke`, {})).status).toBe(404);
    expect((await send(admin, "POST", `/team/members/${other.userId}/routines/${routine}/pause`, {})).status).toBe(404);
    expect((await send(admin, "POST", `/team/members/${target.userId}/feeds/not-an-id/revoke`, {})).status).toBe(404);
    expect((await send(admin, "POST", `/team/members/${crypto.randomUUID()}/routines/${routine}/pause`, {})).status).toBe(404);
    // Nothing changed.
    expect((await fetchFeed(feed.calendar, feed.token)).status).toBe(200);
    expect((db.query("SELECT enabled FROM routines WHERE id = ?").get(routine) as { enabled: number }).enabled).toBe(1);
    // Admins never resume (reductions only): there is no such route.
    expect((await send(admin, "POST", `/team/members/${target.userId}/routines/${routine}/resume`, {})).status).toBe(404);
  });

  test("an admin revokes one feed link: it stops at once, is recorded, and the person hears", async () => {
    const admin = await user("Feeds revoke admin", "admin");
    const target = await user("Feeds revoke target");
    const feed = await feedFor(target, "Revoked feed calendar");
    const kept = await feedFor(target, "Kept feed calendar");
    const revoked = await send(admin, "POST", `/team/members/${target.userId}/feeds/${feed.feedId}/revoke`, {});
    expect(revoked).toMatchObject({ status: 200, body: { revoked: true, feedId: feed.feedId } });
    expect((await fetchFeed(feed.calendar, feed.token)).status).toBe(404);
    expect((await fetchFeed(kept.calendar, kept.token)).status).toBe(200);
    expect((await send(admin, "POST", `/team/members/${target.userId}/feeds/${feed.feedId}/revoke`, {})).status).toBe(404);

    const event = db.query("SELECT actor_id, via, resource_kind, resource_id, meta_json FROM access_events WHERE action = 'access.feed_revoked' AND target_user_id = ?").get(target.userId) as Record<string, string>;
    expect(event).toMatchObject({ actor_id: admin.userId, via: "web", resource_kind: "calendar", resource_id: feed.calendar });
    expect(JSON.parse(event.meta_json)).toEqual({ by: "admin", detail: "busy" });
    const audit = db.query("SELECT actor_id AS user_id, metadata_json AS metadata FROM audit_log WHERE event_type = 'team.feed_revoked' ORDER BY rowid DESC LIMIT 1").get() as { user_id: string; metadata: string };
    expect(audit.user_id).toBe(admin.userId);
    expect(audit.metadata).not.toContain(feed.token);

    const bell = await send(target, "GET", "/notifications");
    expect(bell.body.items[0]).toMatchObject({ title: "Feeds revoke admin revoked your calendar feed link for “Revoked feed calendar”", href: "/settings/access", read: false });
    // Access activity: the admin's line, the calendar hidden from an admin who cannot open it (D269).
    const activity = await send(admin, "GET", `/team/activity?user=${target.userId}&action=items`);
    expect(activity.body.events[0]).toMatchObject({ action: "access.feed_revoked", actor: { id: admin.userId }, target: { id: target.userId }, item: { title: "Calendar owned by Feeds revoke target", titleHidden: true }, meta: { by: "admin", detail: "busy" } });
    expect(JSON.stringify(activity.body.events[0])).not.toContain(feed.calendar);
    // The page now lists one live link.
    expect((await send(admin, "GET", `/team/members/${target.userId}/access`)).body.feeds).toMatchObject({ live: 1, items: [{ id: kept.feedId }] });
  });

  test("an admin pauses one routine: recorded, the person hears, only they resume it", async () => {
    const admin = await user("Routine pause admin", "admin");
    const target = await user("Routine pause target");
    const routine = await routineFor(target, "Nightly triage");
    const other = await routineFor(target, "Left alone");
    const paused = await send(admin, "POST", `/team/members/${target.userId}/routines/${routine}/pause`, {});
    expect(paused).toMatchObject({ status: 200, body: { paused: true, routineId: routine } });
    expect((db.query("SELECT enabled FROM routines WHERE id = ?").get(routine) as { enabled: number }).enabled).toBe(0);
    expect((db.query("SELECT enabled FROM routines WHERE id = ?").get(other) as { enabled: number }).enabled).toBe(1);
    expect((await send(admin, "POST", `/team/members/${target.userId}/routines/${routine}/pause`, {})).body.code).toBe("ALREADY_PAUSED");

    expect(db.query("SELECT actor_id, resource_kind, resource_id FROM access_events WHERE action = 'access.routine_paused' AND target_user_id = ?").get(target.userId))
      .toEqual({ actor_id: admin.userId, resource_kind: "routine", resource_id: routine });
    expect(db.query("SELECT actor_id AS user_id FROM audit_log WHERE event_type = 'team.routine_paused' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ user_id: admin.userId });
    const bell = await send(target, "GET", "/notifications");
    expect(bell.body.items[0]).toMatchObject({ title: "Routine pause admin paused your routine “Nightly triage”", href: "/inbox/routines" });
    // The routine's name is the owner's: Access activity says "a routine".
    const activity = await send(admin, "GET", `/team/activity?user=${target.userId}`);
    expect(activity.body.events[0]).toMatchObject({ action: "access.routine_paused", item: { title: "A routine", titleHidden: true } });
    expect(JSON.stringify(activity.body.events[0])).not.toContain("Nightly triage");
    // The owner resumes it from My access (the Inbox route).
    expect((await send(target, "POST", `/inbox/routines/${routine}/resume`, {})).status).toBe(200);
    expect((await send(target, "GET", "/me/access")).body.routines.items.find((row: { id: string }) => row.id === routine).enabled).toBe(true);
  });

  test("a blocked person's feeds and routines can still be taken away; an admin acting on their own page is not notified", async () => {
    const admin = await user("Feeds block admin", "admin");
    const target = await user("Feeds block target");
    const feed = await feedFor(target);
    const routine = await routineFor(target);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), target.userId);
    try {
      expect((await send(admin, "POST", `/team/members/${target.userId}/feeds/${feed.feedId}/revoke`, {})).status).toBe(200);
      expect((await send(admin, "POST", `/team/members/${target.userId}/routines/${routine}/pause`, {})).status).toBe(200);
      expect((db.query("SELECT COUNT(*) AS count FROM access_notices WHERE user_id = ? AND kind IN ('feed_revoked','routine_paused')").get(target.userId) as { count: number }).count).toBe(2);
    } finally {
      db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(target.userId);
    }
    // A blocked admin's session no longer acts.
    const blockedAdmin = await user("Feeds blocked admin", "admin");
    const another = await feedFor(target);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blockedAdmin.userId);
    expect((await send(blockedAdmin, "POST", `/team/members/${target.userId}/feeds/${another.feedId}/revoke`, {})).status).toBe(401);
    expect((await fetchFeed(another.calendar, another.token)).status).toBe(200);
    // Your own page: the action works, and nobody is told about their own action.
    const own = await feedFor(admin);
    expect((await send(admin, "POST", `/team/members/${admin.userId}/feeds/${own.feedId}/revoke`, {})).status).toBe(200);
    expect(db.query("SELECT 1 FROM access_notices WHERE user_id = ? AND kind = 'feed_revoked'").get(admin.userId)).toBeNull();
  });

  test("on My access the person revokes their own feed links (viewers too) and pauses or resumes routines", async () => {
    const member = await user("Feeds self member");
    const feed = await feedFor(member);
    const routine = await routineFor(member);
    expect((await send(member, "DELETE", `/feeds/${feed.feedId}`, {})).status).toBe(200);
    expect((await send(member, "POST", `/inbox/routines/${routine}/pause`, {})).status).toBe(200);
    expect((await send(member, "GET", "/me/access")).body).toMatchObject({ feeds: { live: 0, items: [] }, routines: { enabled: 0, items: [{ id: routine, enabled: false }] } });
    // A member demoted to viewer keeps their links and may still revoke them (a reduction).
    const viewer = await user("Feeds self viewer");
    const viewerFeed = await feedFor(viewer);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect((await send(viewer, "DELETE", `/feeds/${viewerFeed.feedId}`, {})).status).toBe(200);
    expect((await fetchFeed(viewerFeed.calendar, viewerFeed.token)).status).toBe(404);
    // Guests have no access page.
    const guest = await user("Feeds self guest", "guest");
    expect((await send(guest, "GET", "/me/access")).status).toBe(404);
  });
});
