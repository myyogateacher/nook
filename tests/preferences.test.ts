import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { MODULE_IDS } = await import("../server/preferences");

type Preferences = { disabledModules: string[]; revision: number; updatedAt: string | null };

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

async function getPreferences(session: Session) {
  const response = await request("/preferences", {}, session);
  expect(response.status).toBe(200);
  return (await json<{ preferences: Preferences }>(response)).preferences;
}

function put(session: Session, body: unknown) {
  return request("/preferences", { method: "PUT", body: JSON.stringify(body) }, session);
}

describe("preferences API (D92, T97)", () => {
  test("a user without a row has every module on at revision 0, and /api/auth/me says so", async () => {
    const user = await createUser("Prefs default");
    expect(await getPreferences(user)).toEqual({ disabledModules: [], revision: 0, updatedAt: null });
    const me = await json<{ preferences: Preferences }>(await request("/auth/me", {}, user));
    expect(me.preferences).toEqual({ disabledModules: [], revision: 0, updatedAt: null });
  });

  test("PUT saves in registry order, bumps the revision by one, and /api/auth/me includes the result", async () => {
    const user = await createUser("Prefs save");
    const first = await put(user, { disabledModules: ["bin", "calendar"], revision: 0 });
    expect(first.status).toBe(200);
    const saved = (await json<{ preferences: Preferences }>(first)).preferences;
    expect(saved.disabledModules).toEqual(["calendar", "bin"]);
    expect(saved.revision).toBe(1);
    expect(typeof saved.updatedAt).toBe("string");

    const second = await put(user, { disabledModules: ["team"], revision: 1 });
    expect(second.status).toBe(200);
    expect((await json<{ preferences: Preferences }>(second)).preferences).toMatchObject({ disabledModules: ["team"], revision: 2 });
    const me = await json<{ preferences: Preferences }>(await request("/auth/me", {}, user));
    expect(me.preferences).toMatchObject({ disabledModules: ["team"], revision: 2 });

    const cleared = await put(user, { disabledModules: [], revision: 2 });
    expect((await json<{ preferences: Preferences }>(cleared)).preferences).toMatchObject({ disabledModules: [], revision: 3 });
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'preferences.update' ORDER BY created_at").all(user.userId) as Array<{ metadata_json: string }>;
    expect(audits.length).toBe(3);
  });

  test("a stale revision gets 409 PREFERENCES_CHANGED with the current value, and exactly one racer wins", async () => {
    const user = await createUser("Prefs race");
    expect((await put(user, { disabledModules: ["tasks"], revision: 0 })).status).toBe(200);
    const stale = await put(user, { disabledModules: ["files"], revision: 0 });
    expect(stale.status).toBe(409);
    const body = await json<{ code: string; preferences: Preferences }>(stale);
    expect(body.code).toBe("PREFERENCES_CHANGED");
    expect(body.preferences).toMatchObject({ disabledModules: ["tasks"], revision: 1 });
    expect((await put(user, { disabledModules: ["files"], revision: 7 })).status).toBe(409);

    const racers = await Promise.all([put(user, { disabledModules: ["notes"], revision: 1 }), put(user, { disabledModules: ["search"], revision: 1 })]);
    expect(racers.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await getPreferences(user)).revision).toBe(2);
  });

  test("unknown ids, duplicates, extra keys, and oversized lists get 400 and change nothing", async () => {
    const user = await createUser("Prefs invalid");
    for (const body of [
      { disabledModules: ["home"], revision: 0 },
      { disabledModules: ["settings"], revision: 0 },
      { disabledModules: ["Calendar"], revision: 0 },
      { disabledModules: ["calendar", "calendar"], revision: 0 },
      { disabledModules: [...MODULE_IDS, "notes"], revision: 0 },
      { disabledModules: "calendar", revision: 0 },
      { disabledModules: ["calendar"], revision: -1 },
      { disabledModules: ["calendar"] },
      { disabledModules: [], revision: 0, admin: true }
    ]) expect((await put(user, body)).status).toBe(400);
    expect(await getPreferences(user)).toEqual({ disabledModules: [], revision: 0, updatedAt: null });
  });

  test("preferences are per user and need a session and the CSRF token", async () => {
    const owner = await createUser("Prefs owner");
    const other = await createUser("Prefs other");
    expect((await put(owner, { disabledModules: ["collections"], revision: 0 })).status).toBe(200);
    expect((await getPreferences(other)).disabledModules).toEqual([]);
    expect((await request("/preferences")).status).toBe(401);
    const noCsrf = await request("/preferences", { method: "PUT", body: JSON.stringify({ disabledModules: [], revision: 1 }), headers: { "X-CSRF-Token": "wrong" } }, owner);
    expect(noCsrf.status).toBe(403);
    expect((await getPreferences(owner)).disabledModules).toEqual(["collections"]);
  });

  test("ids that are no longer known are dropped on read", async () => {
    const user = await createUser("Prefs legacy");
    db.query("INSERT INTO user_preferences (user_id, disabled_modules, revision, updated_at) VALUES (?, ?, 4, ?)").run(user.userId, '["retired","calendar"]', new Date().toISOString());
    expect(await getPreferences(user)).toMatchObject({ disabledModules: ["calendar"], revision: 4 });
  });

  test("a disabled module's API still works and still enforces its ACL (a hidden module is not a security boundary)", async () => {
    const owner = await createUser("Prefs tasks owner");
    const stranger = await createUser("Prefs tasks stranger");
    expect((await put(owner, { disabledModules: ["tasks", "calendar"], revision: 0 })).status).toBe(200);
    const created = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Hidden but working" }) }, owner);
    expect(created.status).toBe(201);
    const boardId = (await json<{ board: { id: string } }>(created)).board.id;
    expect((await request(`/tasks/boards/${boardId}`, {}, owner)).status).toBe(200);
    expect((await request(`/tasks/boards/${boardId}`, {}, stranger)).status).toBe(404);
    // The stranger turning Tasks off (or on) changes nothing either.
    expect((await put(stranger, { disabledModules: [], revision: 0 })).status).toBe(200);
    expect((await request(`/tasks/boards/${boardId}`, {}, stranger)).status).toBe(404);
    expect((await request("/calendars", {}, owner)).status).toBe(200);
  });
});

describe("the sidebar's layout in preferences (left navigation phase 4, D1295, T97)", () => {
  type WithSidebar = Preferences & { sidebar?: { mode?: string; order?: string[]; pinned?: string[]; expanded?: string[] } };

  test("absent until saved; saved whole with the modules, and kept by a modules-only save", async () => {
    const user = await createUser("Prefs sidebar save");
    expect(await getPreferences(user)).toEqual({ disabledModules: [], revision: 0, updatedAt: null });
    const sidebar = { mode: "rail", order: ["crm", "notes", "tasks"], pinned: ["crm"], expanded: ["inbox", "crm"] };
    const first = await put(user, { disabledModules: ["bin"], revision: 0, sidebar });
    expect(first.status).toBe(200);
    expect((await json<{ preferences: WithSidebar }>(first)).preferences).toMatchObject({ disabledModules: ["bin"], revision: 1, sidebar });
    // Settings → Modules sends no sidebar: the layout stays.
    expect((await put(user, { disabledModules: [], revision: 1 })).status).toBe(200);
    expect(await getPreferences(user)).toMatchObject({ disabledModules: [], revision: 2, sidebar });
    const me = await json<{ preferences: WithSidebar }>(await request("/auth/me", {}, user));
    expect(me.preferences.sidebar).toEqual(sidebar);
    // A new layout replaces the old whole; null clears it.
    expect((await json<{ preferences: WithSidebar }>(await put(user, { disabledModules: [], revision: 2, sidebar: { pinned: [] } }))).preferences.sidebar).toEqual({ pinned: [] });
    const cleared = await json<{ preferences: WithSidebar }>(await put(user, { disabledModules: [], revision: 3, sidebar: null }));
    expect(cleared.preferences).toEqual({ disabledModules: [], revision: 4, updatedAt: expect.any(String) });
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'preferences.update' ORDER BY created_at").all(user.userId) as Array<{ metadata_json: string }>;
    expect(audits.length).toBe(4);
    expect(JSON.parse(audits[0]!.metadata_json).sidebar).toEqual(sidebar);
  });

  test("a stale revision gets 409 with the other device's layout, and exactly one of two racers wins", async () => {
    const user = await createUser("Prefs sidebar race");
    expect((await put(user, { disabledModules: [], revision: 0, sidebar: { order: ["tasks", "notes"] } })).status).toBe(200);
    const stale = await put(user, { disabledModules: [], revision: 0, sidebar: { order: ["files"] } });
    expect(stale.status).toBe(409);
    expect((await json<{ code: string; preferences: WithSidebar }>(stale)).preferences).toMatchObject({ revision: 1, sidebar: { order: ["tasks", "notes"] } });
    const racers = await Promise.all([
      put(user, { disabledModules: [], revision: 1, sidebar: { pinned: ["calendar"] } }),
      put(user, { disabledModules: [], revision: 1, sidebar: { pinned: ["files"] } })
    ]);
    expect(racers.map((response) => response.status).sort()).toEqual([200, 409]);
    const after = await getPreferences(user) as WithSidebar;
    expect(after.revision).toBe(2);
    expect([["calendar"], ["files"]]).toContainEqual(after.sidebar?.pinned);
  });

  test("unknown ids, duplicates, other modes, extra keys, and oversized lists get 400 and change nothing", async () => {
    const user = await createUser("Prefs sidebar invalid");
    for (const sidebar of [
      { mode: "wide" },
      { order: ["home"] },
      { order: ["agents"] },
      { order: ["settings"] },
      { pinned: ["notes", "notes"] },
      { expanded: ["Inbox"] },
      { order: ["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault", "chat", "reports", "forms", "time", "goals", "checkins", "crm", "bookings", "townhall", "notes"] },
      { order: "notes" },
      { order: [], admin: true },
      [],
      "rail"
    ]) expect((await put(user, { disabledModules: [], revision: 0, sidebar })).status).toBe(400);
    expect(await getPreferences(user)).toEqual({ disabledModules: [], revision: 0, updatedAt: null });
  });

  test("ids that are no longer known are dropped on read; the stored value is bounded", async () => {
    const user = await createUser("Prefs sidebar legacy");
    db.query("INSERT INTO user_preferences (user_id, disabled_modules, revision, updated_at, sidebar) VALUES (?, '[]', 2, ?, ?)")
      .run(user.userId, new Date().toISOString(), JSON.stringify({ mode: "rail", order: ["retired", "crm"], pinned: ["retired"] }));
    expect(await getPreferences(user)).toMatchObject({ revision: 2, sidebar: { mode: "rail", order: ["crm"], pinned: [] } });
    expect(() => db.query("UPDATE user_preferences SET sidebar = ? WHERE user_id = ?").run("not json", user.userId)).toThrow();
    expect(() => db.query("UPDATE user_preferences SET sidebar = ? WHERE user_id = ?").run("[]", user.userId)).toThrow();
    expect(() => db.query("UPDATE user_preferences SET sidebar = ? WHERE user_id = ?").run(JSON.stringify({ order: "x".repeat(3000) }), user.userId)).toThrow();
  });

  test("ordering and pinning are presentation: a pinned app turned off stays off, and its API still enforces access", async () => {
    const owner = await createUser("Prefs sidebar pinned owner");
    const stranger = await createUser("Prefs sidebar pinned stranger");
    const created = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Pinned elsewhere" }) }, owner);
    const boardId = (await json<{ board: { id: string } }>(created)).board.id;
    expect((await put(stranger, { disabledModules: ["tasks"], revision: 0, sidebar: { pinned: ["tasks"], order: ["tasks"] } })).status).toBe(200);
    expect((await getPreferences(stranger)).disabledModules).toEqual(["tasks"]);
    expect((await request(`/tasks/boards/${boardId}`, {}, stranger)).status).toBe(404);
  });
});
