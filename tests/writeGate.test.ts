import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, newCollection, shareCollection } from "./support/collections";

const { ROLE_READ_ONLY_ALLOWED_WRITES, SELF_GATED_WRITE_PREFIXES, isAllowedReadOnlyWrite } = await import("../server/team/writeGate");
const { requireEditableCollection, CollectionError } = await import("../server/collections/service");
// Fixture dates sit five years ahead of the current year (C12), so they never fall into the past.
const Y = new Date().getUTCFullYear() + 5;

/**
 * T87 (Team plan §5.2, D75): viewers and guests write nothing except an exact allowlist of personal
 * writes and reads sent as POST. Every mutating route in server/ is enumerated from the source, so
 * a new route that is neither refused nor allowlisted fails this file.
 */

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

async function send(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

/** Every `app.<method>("/api/…")` registration under server/ (migrations excluded). */
function mutatingRoutes() {
  const root = join(import.meta.dir, "..", "server");
  const routes: Array<{ method: string; path: string; file: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { if (entry !== "migrations") walk(path); continue; }
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/app\.(post|put|patch|delete)\(\s*"(\/api\/[^"]+)"/g)) {
        routes.push({ method: match[1]!.toUpperCase(), path: match[2]!, file: path.slice(root.length + 1) });
      }
    }
  };
  walk(root);
  return routes;
}

/** Registered before the session middleware: there is no user, so the gate never applies. */
const PUBLIC_WRITES = new Set(["POST /api/auth/login", "POST /api/auth/register", "POST /api/auth/invite", "POST /api/mail/verify", "POST /api/mail/unsubscribe", "POST /api/mail/webhook",
  // Wave 30: forgot / reset password work signed out.
  "POST /api/auth/password-reset/request", "POST /api/auth/password-reset/check", "POST /api/auth/password-reset/complete"]);

const concrete = (path: string) => path.replace(/:type/g, "note").replace(/:[A-Za-z]+/g, () => crypto.randomUUID());

describe("role write gate (T87)", () => {
  const routes = mutatingRoutes();

  test("the enumeration finds every mutating route", () => {
    // 95 at the time of writing; a drop means the pattern stopped matching registrations.
    expect(routes.length).toBeGreaterThanOrEqual(90);
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) expect(routes.some((route) => route.method === verb)).toBe(true);
  });

  test("every allowlist entry names a real route", () => {
    const registered = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const entry of ROLE_READ_ONLY_ALLOWED_WRITES) expect({ entry: `${entry.method} ${entry.path}`, registered: registered.has(`${entry.method} ${entry.path}`) }).toEqual({ entry: `${entry.method} ${entry.path}`, registered: true });
  });

  test("viewers and guests get 403 ROLE_READ_ONLY on every mutating route that is not allowlisted", async () => {
    const viewer = await user("Gate viewer", "viewer");
    const guest = await user("Gate guest", "guest");
    let refused = 0;
    let allowed = 0;
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_WRITES.has(key)) continue;
      // Allowlisted calls run for real further down, on sessions that may be signed out.
      if (key === "POST /api/auth/logout") continue;
      const path = concrete(route.path);
      for (const [label, session, role] of [["viewer", viewer, "viewer"], ["guest", guest, "guest"]] as const) {
        const expectAllowed = isAllowedReadOnlyWrite(role, route.method, path);
        const response = route.method === "POST" && route.path === "/api/files"
          ? await request("/files", { method: "POST", body: new FormData() }, session)
          // A guest's task query must carry assignee:me (checked in its own test below).
          : await request(path.slice("/api".length), { method: route.method, body: key === "POST /api/tasks/query" ? JSON.stringify({ q: "assignee:me" }) : "{}" }, session);
        const body = await response.json().catch(() => ({})) as { code?: string };
        const observed = { route: key, label, readOnly: response.status === 403 && body.code === "ROLE_READ_ONLY" };
        expect(observed).toEqual({ route: key, label, readOnly: !expectAllowed });
        // Refused routes never reach a handler, so nothing answers 404 for the made-up ids first.
        if (!expectAllowed) expect(response.status).toBe(403);
        if (expectAllowed) allowed += 1; else refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(140);
    expect(allowed).toBeGreaterThan(20);
    // Team routes answer for themselves: 404 for guests, 403 ADMIN_ONLY for viewers (never ROLE_READ_ONLY).
    const target = crypto.randomUUID();
    expect((await send(guest, "POST", `/team/${target}/block`, {})).status).toBe(404);
    expect((await send(viewer, "POST", `/team/${target}/block`, {})).body.code).toBe("ADMIN_ONLY");
    expect(SELF_GATED_WRITE_PREFIXES).toEqual(["/api/team/"]);
    // Sign out is allowed (last, since it ends the session).
    expect((await send(viewer, "POST", "/auth/logout", {})).status).toBe(200);
    expect((await send(guest, "POST", "/auth/logout", {})).status).toBe(200);
  }, 60_000);

  test("members and admins pass the gate", async () => {
    for (const role of ["member", "admin"] as const) {
      const session = await user(`Gate ${role}`, role);
      const created = await send(session, "POST", "/folders", { name: `Gate ${role} folder`, parentId: null });
      expect(created.status).toBe(201);
    }
  });

  test("the gate compares exact paths: lookalikes are refused", () => {
    expect(isAllowedReadOnlyWrite("viewer", "POST", "/api/tasks/query")).toBe(true);
    expect(isAllowedReadOnlyWrite("viewer", "POST", "/api/tasks/query/")).toBe(false);
    expect(isAllowedReadOnlyWrite("viewer", "POST", "/api/tasks/queryx")).toBe(false);
    expect(isAllowedReadOnlyWrite("viewer", "PUT", "/api/tasks/query")).toBe(false);
    expect(isAllowedReadOnlyWrite("viewer", "POST", `/api/collections/${crypto.randomUUID()}/query`)).toBe(true);
    expect(isAllowedReadOnlyWrite("viewer", "POST", `/api/collections/a/b/query`)).toBe(false);
    expect(isAllowedReadOnlyWrite("viewer", "DELETE", `/api/tasks/views/${crypto.randomUUID()}`)).toBe(true);
    expect(isAllowedReadOnlyWrite("guest", "DELETE", `/api/tasks/views/${crypto.randomUUID()}`)).toBe(false);
    // Viewers may withdraw a share (the service allows only `private`); guests never.
    expect(isAllowedReadOnlyWrite("viewer", "PUT", `/api/tasks/views/${crypto.randomUUID()}/sharing`)).toBe(true);
    expect(isAllowedReadOnlyWrite("guest", "PUT", `/api/tasks/views/${crypto.randomUUID()}/sharing`)).toBe(false);
  });
});

describe("read-only roles and item share roles (§2.4)", () => {
  test("a viewer or guest on an editor collection is a viewer of it, and the service refuses owners who are read-only", async () => {
    const owner = await user("Cap owner");
    const viewer = await user("Cap viewer", "viewer");
    const guest = await user("Cap guest", "guest");
    const member = await user("Cap member");
    const collection = await newCollection(owner);
    await addRow(owner, collection.id, {});
    await shareCollection(owner, collection.id, "selected", [viewer.userId, guest.userId, member.userId], "editor");
    for (const session of [viewer, guest]) {
      expect((await send(session, "GET", `/collections/${collection.id}`)).body.role).toBe("viewer");
      expect((await send(session, "GET", "/collections")).body.collections.find((item: { id: string }) => item.id === collection.id).role).toBe("viewer");
      expect((await send(session, "POST", `/collections/${collection.id}/rows`, { values: {} })).body.code).toBe("ROLE_READ_ONLY");
      expect((await send(session, "POST", `/collections/${collection.id}/query`, {})).status).toBe(200);
    }
    expect((await send(member, "GET", `/collections/${collection.id}`)).body.role).toBe("editor");
    // Defence in depth (§5.4): the service itself refuses a demoted owner, whatever the route.
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    expect(() => requireEditableCollection(collection.id, owner.userId)).toThrow(CollectionError);
    try { requireEditableCollection(collection.id, owner.userId); } catch (error) { expect((error as InstanceType<typeof CollectionError>).code).toBe("READ_ONLY"); }
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(owner.userId);
    expect(requireEditableCollection(collection.id, owner.userId).id).toBe(collection.id);
  });

  test("calendars: editor shares are capped, reminders stay personal, and read-only roles get no Personal calendar", async () => {
    const owner = await user("Cal cap owner");
    const viewer = await user("Cal cap viewer", "viewer");
    const guest = await user("Cal cap guest", "guest");
    const calendar = (await send(owner, "POST", "/calendars", { name: "Shared", color: "green" })).body.calendar.id as string;
    expect((await send(owner, "PUT", `/calendars/${calendar}/sharing`, { visibility: "selected", shareRole: "editor", userIds: [viewer.userId, guest.userId] })).status).toBe(200);
    const eventId = (await send(owner, "POST", `/calendars/${calendar}/events`, { title: "Standup", allDay: false, startLocal: `${Y - 1}-05-04T09:00`, tz: "UTC", durationMinutes: 15 })).body.event.id as string;
    for (const session of [viewer, guest]) {
      const listed = (await send(session, "GET", "/calendars")).body.calendars as Array<{ id: string; role: string; is_owner: number }>;
      expect(listed.filter((item) => item.is_owner === 1)).toEqual([]);
      expect(listed.find((item) => item.id === calendar)!.role).toBe("viewer");
      expect((await send(session, "GET", `/events/${eventId}`)).body.role).toBe("viewer");
      expect((await send(session, "PATCH", `/events/${eventId}`, { title: "Mine", revision: 1 })).body.code).toBe("ROLE_READ_ONLY");
      const reminder = await send(session, "POST", "/reminders", { eventId, offsetMinutes: 10, tz: "UTC" });
      expect(reminder.status).toBe(201);
      expect((await send(session, "POST", `/calendars/${calendar}/feeds`, { kind: "full" })).body.code).toBe("ROLE_READ_ONLY");
    }
  });

  test("a board reader who is a viewer cannot write cards; viewers keep private views only; guests none", async () => {
    const owner = await user("Board cap owner");
    const viewer = await user("Board cap viewer", "viewer");
    const guest = await user("Board cap guest", "guest");
    const board = (await send(owner, "POST", "/tasks/boards", { name: "Capped" })).body;
    expect((await send(owner, "PUT", `/tasks/boards/${board.board.id}/sharing`, { visibility: "selected", userIds: [viewer.userId, guest.userId] })).status).toBe(200);
    for (const session of [viewer, guest]) {
      expect((await send(session, "GET", `/tasks/boards/${board.board.id}`)).status).toBe(200);
      expect((await send(session, "POST", `/tasks/boards/${board.board.id}/cards`, { columnId: board.columns[0].id, title: "Nope" })).body.code).toBe("ROLE_READ_ONLY");
      expect((await send(session, "POST", "/tasks/query", { q: `assignee:me board:${board.board.id}` })).status).toBe(200);
    }
    expect((await send(viewer, "POST", "/tasks/query", { q: `board:${board.board.id}` })).status).toBe(200);
    // Guests only run "my work" queries: a plain, positive assignee:me term (task plan Q12).
    for (const q of [`board:${board.board.id}`, "", "-assignee:me", "assignee:me,none", "assignee:none"]) {
      expect({ q, ...(await send(guest, "POST", "/tasks/query", { q })) }).toMatchObject({ q, status: 403, body: { code: "ROLE_READ_ONLY" } });
    }
    expect((await send(guest, "POST", "/tasks/query", { q: "assignee:me state:todo" })).status).toBe(200);
    expect((await send(guest, "POST", "/tasks/query", "not json")).status).toBe(403);
    const view = await send(viewer, "POST", "/tasks/views", { name: "My work", query: "assignee:me" });
    expect(view.status).toBe(201);
    expect((await send(viewer, "PUT", `/tasks/views/${view.body.view.id}/sharing`, { visibility: "all_users", userIds: [] })).body.code).toBe("VIEW_SHARED_READ_ONLY");
    expect((await send(viewer, "PATCH", `/tasks/views/${view.body.view.id}`, { name: "Renamed", revision: view.body.view.revision })).status).toBe(200);
    expect((await send(viewer, "DELETE", `/tasks/views/${view.body.view.id}`, {})).status).toBe(200);
    expect((await send(guest, "POST", "/tasks/views", { name: "My work", query: "assignee:me" })).body.code).toBe("ROLE_READ_ONLY");
  });

  test("a member demoted to viewer can withdraw a shared view but not change it while shared; guests change nothing", async () => {
    const owner = await user("Demoted view owner");
    const reader = await user("Demoted view reader");
    const created = (await send(owner, "POST", "/tasks/views", { name: "Team work", query: "state:todo" })).body.view;
    const privateView = (await send(owner, "POST", "/tasks/views", { name: "Mine", query: "assignee:me" })).body.view;
    expect((await send(owner, "PUT", `/tasks/views/${created.id}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    let revision = (await send(owner, "GET", `/tasks/views/${created.id}`)).body.view.revision as number;
    expect(await send(owner, "PATCH", `/tasks/views/${created.id}`, { name: "Renamed", revision })).toMatchObject({ status: 403, body: { code: "VIEW_SHARED_READ_ONLY" } });
    expect(await send(owner, "DELETE", `/tasks/views/${created.id}`, {})).toMatchObject({ status: 403, body: { code: "VIEW_SHARED_READ_ONLY" } });
    expect(await send(owner, "PUT", `/tasks/views/${created.id}/sharing`, { visibility: "selected", userIds: [reader.userId] })).toMatchObject({ status: 403, body: { code: "VIEW_SHARED_READ_ONLY" } });
    expect((await send(reader, "GET", `/tasks/views/${created.id}`)).status).toBe(200);
    // Withdrawing the share works, and then the now-private view is theirs to change.
    expect((await send(owner, "PUT", `/tasks/views/${created.id}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect((await send(reader, "GET", `/tasks/views/${created.id}`)).status).toBe(404);
    revision = (await send(owner, "GET", `/tasks/views/${created.id}`)).body.view.revision as number;
    expect((await send(owner, "PATCH", `/tasks/views/${created.id}`, { name: "Renamed", revision })).status).toBe(200);
    expect((await send(owner, "PATCH", `/tasks/views/${privateView.id}`, { name: "Still mine", revision: privateView.revision })).status).toBe(200);
    // A guest owner is refused every view write at the gate, private or shared.
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(owner.userId);
    const current = (await send(owner, "GET", `/tasks/views/${privateView.id}`)).body.view;
    for (const [method, path, body] of [
      ["PATCH", `/tasks/views/${privateView.id}`, { name: "Guest", revision: current.revision }],
      ["DELETE", `/tasks/views/${privateView.id}`, {}],
      ["PUT", `/tasks/views/${privateView.id}/sharing`, { visibility: "private", userIds: [] }],
      ["POST", `/tasks/views/${privateView.id}/duplicate`, {}]
    ] as const) {
      expect({ method, ...(await send(owner, method, path, body)) }).toMatchObject({ method, status: 403, body: { code: "ROLE_READ_ONLY" } });
    }
  });

  test("the share picker is refused to read-only roles and hints each recipient's role", async () => {
    const member = await user("Picker member");
    const guest = await user("00 Picker guest", "guest");
    const viewer = await user("00 Picker viewer", "viewer");
    const listed = (await send(member, "GET", "/users")).body.users as Array<{ id: string; role: string }>;
    expect(listed.find((row) => row.id === guest.userId)!.role).toBe("guest");
    expect(listed.find((row) => row.id === viewer.userId)!.role).toBe("viewer");
    for (const session of [viewer, guest]) expect(await send(session, "GET", "/users")).toMatchObject({ status: 403, body: { code: "ROLE_READ_ONLY" } });
  });

  test("read-only roles keep their personal writes: notifications, preferences, and two-factor setup", async () => {
    const viewer = await user("Personal viewer", "viewer");
    expect((await send(viewer, "POST", "/notifications/read", { all: true })).status).toBe(200);
    const preferences = (await send(viewer, "GET", "/preferences")).body.preferences;
    expect((await send(viewer, "PUT", "/preferences", { disabledModules: ["files"], revision: preferences.revision })).status).toBe(200);
    expect((await send(viewer, "POST", "/auth/totp/setup", { password: viewer.password })).status).toBe(200);
  });
});
