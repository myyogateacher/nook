import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { cpuMs, HEAVY_TEST_TIMEOUT_MS } from "./support/cpuTime";

const { reportTools } = await import("../server/reports/mcpTools");
const { visibleTools } = await import("../server/mcpTools");
const { registeredMigrations, runMigrations } = await import("../server/migrations");
const { reportFavoritesMigration } = await import("../server/migrations/061_report_favorites");
const { reportListSql } = await import("../server/reports/service");

/**
 * Report organization phase 1 (migration 061, D486, T393): favorites (star, unstar, refused on a report
 * the caller cannot open, gone from every list once access is lost), the paged and filtered Reports
 * list (keyset cursor, owner, status, data source, schedule, favorites, shared, folder and subtree,
 * title), the nav counts from one GROUP BY, the MCP tools, and the list query at scale (2,000 reports,
 * 300 folders, 50 groups) under 50 ms of CPU with its indexes in the plan.
 */

const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}
async function role(label: string, value: "admin" | "member" | "viewer" | "guest") {
  const session = await createUser(label);
  db.query("UPDATE users SET role = ? WHERE id = ?").run(value, session.userId);
  return session;
}

const admin = await role("Favorites admin", "admin");
const owner = await role("Favorites owner", "member");
const reader = await role("Favorites reader", "member");
const viewer = await role("Favorites viewer", "viewer");
const guest = await role("Favorites guest", "guest");

const datasource = (await send(admin, "POST", "/reports/admin/datasources", { name: "Favorites warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: [] })).body.datasource as Json;
const otherSource = (await send(admin, "POST", "/reports/admin/datasources", { name: "Favorites lake", url: fake.url, username: "nook_ro", database: "lake", allowlist: [] })).body.datasource as Json;
const newReport = async (session: Session, title: string, extra: Json = {}) => {
  const created = await send(session, "POST", "/reports", { title, datasourceId: datasource.id, ...extra });
  expect(created.status).toBe(201);
  return created.body.report as Json;
};
const share = async (session: Session, reportId: string, shares: Json[]) => {
  const result = await send(session, "PUT", `/reports/${reportId}/sharing`, { visibility: "selected", shares });
  expect(result.status).toBe(200);
};
const list = async (session: Session, query = "") => (await send(session, "GET", `/reports${query ? `?${query}` : ""}`));
const titles = (body: Json) => (body.reports as Json[]).map((report) => report.title);

describe("migration 061 report_favorites", () => {
  test("adds report_favorites (cascades from users and reports) and the list indexes; re-running changes nothing", () => {
    const at = "2026-10-15T00:00:00.000Z";
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    memory.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of registeredMigrations.filter((item) => item.id < 61)) {
      memory.transaction(() => {
        migration.up(memory);
        memory.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
      })();
    }
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'Weekly revenue', ?, ?)").run(at, at);
    runMigrations(memory);
    const indexes = (memory.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('report_favorites_report', 'reports_status', 'reports_live_recent') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(["report_favorites_report", "reports_live_recent", "reports_status"]);
    expect(String((memory.query("SELECT sql FROM sqlite_master WHERE name = 'report_favorites'").get() as { sql: string }).sql)).toContain("STRICT");
    memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES ('u1', 'r1', ?), ('u2', 'r1', ?)").run(at, at);
    expect(() => memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES ('u1', 'r1', ?)").run(at)).toThrow();
    expect(() => memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES ('u1', 'nope', ?)").run(at)).toThrow();
    memory.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(memory.query("SELECT user_id FROM report_favorites").all()).toEqual([{ user_id: "u1" }]);
    memory.query("DELETE FROM reports WHERE id = 'r1'").run();
    expect(memory.query("SELECT COUNT(*) AS count FROM report_favorites").get()).toEqual({ count: 0 });
    reportFavoritesMigration.up(memory);
    expect((memory.query("SELECT id FROM schema_migrations WHERE id >= 59 ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id)).toContain(61);
  });
});

describe("favorites", () => {
  test("star and unstar a report you can open; a report you cannot is a 404; viewers star, guests have nothing", async () => {
    const mine = await newReport(owner, "Star mine");
    const hidden = await newReport(owner, "Star hidden");
    const starred = await send(owner, "PUT", `/reports/${mine.id}/favorite`);
    expect(starred).toEqual({ status: 200, body: { favorite: true } });
    // Twice is the same star, audited once.
    expect((await send(owner, "PUT", `/reports/${mine.id}/favorite`)).status).toBe(200);
    expect((await send(owner, "GET", `/reports/${mine.id}`)).body.report.favorite).toBe(true);
    expect((await list(owner, "favorites=1")).body.reports.map((report: Json) => report.id)).toEqual([mine.id]);
    // Someone else's private report: the same 404 as a missing one, and nothing stored.
    expect((await send(reader, "PUT", `/reports/${hidden.id}/favorite`)).status).toBe(404);
    expect((await send(reader, "PUT", `/reports/${crypto.randomUUID()}/favorite`)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM report_favorites WHERE user_id = ?").get(reader.userId)).toEqual({ count: 0 });
    // A viewer it is shared with stars it (a personal write the role gate allows); a guest is refused (no Reports module).
    await share(owner, mine.id, [{ kind: "user", id: viewer.userId, level: "view" }, { kind: "user", id: reader.userId, level: "view" }]);
    expect((await send(viewer, "PUT", `/reports/${mine.id}/favorite`)).body).toEqual({ favorite: true });
    expect((await send(guest, "PUT", `/reports/${mine.id}/favorite`)).status).toBe(403);
    expect((await send(guest, "GET", "/reports?favorites=1")).status).toBe(404);
    expect((await send(owner, "DELETE", `/reports/${mine.id}/favorite`)).body).toEqual({ favorite: false });
    expect((await list(owner, "favorites=1")).body.reports).toEqual([]);
    const audits = db.query("SELECT event_type FROM audit_log WHERE actor_id = ? AND event_type LIKE 'reports.report.%star' ORDER BY created_at").all(owner.userId) as Array<{ event_type: string }>;
    expect(audits.map((row) => row.event_type)).toEqual(["reports.report.star", "reports.report.unstar"]);
  });

  test("a favorite drops out of the reader's lists and counts the moment access is lost (T393), and comes back with it", async () => {
    const shared = await newReport(owner, "Star shared then unshared");
    await share(owner, shared.id, [{ kind: "user", id: reader.userId, level: "view" }]);
    expect((await send(reader, "PUT", `/reports/${shared.id}/favorite`)).status).toBe(200);
    const before = (await send(reader, "GET", "/reports/folders")).body;
    expect((await list(reader, "favorites=1")).body.reports.map((report: Json) => report.id)).toContain(shared.id);
    await send(owner, "PUT", `/reports/${shared.id}/sharing`, { visibility: "private", shares: [] });
    expect((await list(reader, "favorites=1")).body.reports.map((report: Json) => report.id)).not.toContain(shared.id);
    expect((await send(reader, "GET", "/reports/folders")).body.counts.favorites).toBe(before.counts.favorites - 1);
    // The row stays (the reader's own); shared again, the star is back.
    await share(owner, shared.id, [{ kind: "user", id: reader.userId, level: "view" }]);
    expect((await list(reader, "favorites=1")).body.reports.map((report: Json) => report.id)).toContain(shared.id);
    // Binned: gone from favorites; purged: the row goes too.
    await send(owner, "DELETE", `/reports/${shared.id}`);
    expect((await list(reader, "favorites=1")).body.reports.map((report: Json) => report.id)).not.toContain(shared.id);
    db.query("DELETE FROM reports WHERE id = ?").run(shared.id);
    expect(db.query("SELECT COUNT(*) AS count FROM report_favorites WHERE report_id = ?").get(shared.id)).toEqual({ count: 0 });
  });
});

describe("the paged, filtered list", () => {
  test("filters by owner, status, data source, schedule, shared, folder (direct and subtree), unfiled, and title", async () => {
    const lister = await role("Favorites lister", "member");
    const sharer = await role("Favorites sharer", "member");
    const parent = (await send(lister, "POST", "/reports/folders", { name: "Parent" })).body.folder as Json;
    const child = (await send(lister, "POST", "/reports/folders", { name: "Child", parentId: parent.id })).body.folder as Json;
    const inParent = await newReport(lister, "Alpha in parent", { folderId: parent.id });
    const inChild = await newReport(lister, "Beta in child", { folderId: child.id });
    const loose = await newReport(lister, "Gamma unfiled");
    const lake = (await send(lister, "POST", "/reports", { title: "Delta on the lake", datasourceId: otherSource.id })).body.report as Json;
    db.query("UPDATE reports SET status = 'ready' WHERE id IN (?, ?)").run(inParent.id, lake.id);
    db.query("UPDATE reports SET status = 'error' WHERE id = ?").run(inChild.id);
    db.query("INSERT INTO report_schedules (report_id, cadence, at_time, tz, enabled, created_at, updated_at) VALUES (?, 'daily', '08:00', 'UTC', 1, ?, ?)").run(loose.id, new Date().toISOString(), new Date().toISOString());
    const theirs = await newReport(sharer, "Epsilon shared");
    await share(sharer, theirs.id, [{ kind: "user", id: lister.userId, level: "view" }]);

    // Reports other test files share with everyone are readable too: look only at this test's titles.
    const mine = new Set(["Alpha in parent", "Beta in child", "Delta on the lake", "Epsilon shared", "Gamma unfiled"]);
    const sorted = (body: Json) => titles(body).filter((title) => mine.has(title)).sort();
    expect(sorted((await list(lister)).body)).toEqual([...mine].sort());
    expect(sorted((await list(lister, "owner=me")).body)).toEqual(["Alpha in parent", "Beta in child", "Delta on the lake", "Gamma unfiled"]);
    expect(titles((await list(lister, `owner=${sharer.userId}`)).body)).toEqual(["Epsilon shared"]);
    expect(sorted((await list(lister, "status=ready,error")).body)).toEqual(["Alpha in parent", "Beta in child", "Delta on the lake"]);
    expect(titles((await list(lister, `datasource=${otherSource.id}`)).body)).toEqual(["Delta on the lake"]);
    expect(sorted((await list(lister, "scheduled=1")).body)).toEqual(["Gamma unfiled"]);
    expect(titles((await list(lister, "scheduled=0")).body)).not.toContain("Gamma unfiled");
    expect(sorted((await list(lister, "shared=1")).body)).toEqual(["Epsilon shared"]);
    expect(titles((await list(lister, "shared=1")).body)).not.toContain("Gamma unfiled");
    expect(titles((await list(lister, `folder=${parent.id}`)).body)).toEqual(["Alpha in parent"]);
    expect(sorted((await list(lister, `folder=${parent.id}&subtree=1`)).body)).toEqual(["Alpha in parent", "Beta in child"]);
    // Phase 2 (D483): Unfiled is every readable report in no folder, a shared one too.
    expect(sorted((await list(lister, "folder=unfiled")).body)).toEqual(["Delta on the lake", "Epsilon shared", "Gamma unfiled"]);
    expect(sorted((await list(lister, "q=GAMMA")).body)).toEqual(["Gamma unfiled"]);
    expect(titles((await list(lister, `q=a&status=ready&owner=me&folder=${parent.id}`)).body)).toEqual(["Alpha in parent"]);
    // The tree is shared (D483), but a folder lists only what the person can read (T391).
    expect(titles((await list(sharer, `folder=${parent.id}&subtree=1`)).body)).toEqual([]);
    // Malformed filters are a 400.
    expect((await list(lister, "status=gone")).status).toBe(400);
    expect((await list(lister, "owner=someone")).status).toBe(400);
    expect((await list(lister, "folder=../x")).status).toBe(400);
    expect((await list(lister, "nope=1")).status).toBe(400);

    // The nav: every count from one GROUP BY over the readable set, and the owners for the Owner filter.
    await send(lister, "PUT", `/reports/${theirs.id}/favorite`);
    await send(lister, "PUT", `/reports/${inChild.id}/favorite`);
    const nav = (await send(lister, "GET", "/reports/folders")).body;
    const everyone = (db.query("SELECT COUNT(*) AS count FROM reports WHERE visibility = 'all_users' AND deleted_at IS NULL AND owner_id NOT IN (?, ?)").get(lister.userId, sharer.userId) as { count: number }).count;
    const everyoneUnfiled = (db.query("SELECT COUNT(*) AS count FROM reports WHERE visibility = 'all_users' AND deleted_at IS NULL AND folder_id IS NULL AND owner_id NOT IN (?, ?)").get(lister.userId, sharer.userId) as { count: number }).count;
    expect(nav.counts).toEqual({ all: 5 + everyone, unfiled: 3 + everyoneUnfiled, shared: 1 + everyone, favorites: 2 });
    expect(nav.folders.filter((folder: Json) => [parent.id, child.id].includes(folder.id)).map((folder: Json) => [folder.name, folder.count]).sort()).toEqual([["Child", 1], ["Parent", 1]]);
    expect(nav.owners[0]).toMatchObject({ id: lister.userId, count: 4, isMe: true });
    expect(nav.owners.find((item: Json) => item.id === sharer.userId)).toMatchObject({ count: 1, isMe: false });
    const row = (await list(lister, "favorites=1")).body.reports.find((report: Json) => report.id === theirs.id);
    expect(row).toMatchObject({ favorite: true, ownerId: sharer.userId, isOwner: false, folderId: null });
  });

  test("keyset pages of up to 100, newest change first, with an opaque cursor; ties break by id; a bad cursor is a 400", async () => {
    const pager = await role("Favorites pager", "member");
    const at = "2026-10-15T09:00:00.000Z";
    const insert = db.query("INSERT INTO reports (id, owner_id, title, datasource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    const ids: string[] = [];
    db.transaction(() => {
      for (let index = 0; index < 230; index += 1) {
        const id = crypto.randomUUID();
        ids.push(id);
        // Every fifth shares one time, so pages split inside a tie.
        const updated = index % 5 === 0 ? at : new Date(Date.parse(at) - (index + 1) * 1000).toISOString();
        insert.run(id, pager.userId, `Paged ${index}`, datasource.id, updated, updated);
      }
    })();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; body: Json } = await list(pager, `owner=me${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.status).toBe(200);
      expect(page.body.reports.length).toBeLessThanOrEqual(100);
      seen.push(...page.body.reports.map((report: Json) => report.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen.length).toBe(230);
    expect(new Set(seen).size).toBe(230);
    const expected = (db.query("SELECT id FROM reports WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id").all(pager.userId) as Array<{ id: string }>).map((row) => row.id);
    expect(seen).toEqual(expected);
    expect((await list(pager, "limit=7")).body.reports.length).toBe(7);
    expect((await list(pager, "limit=101")).status).toBe(400);
    expect((await list(pager, "cursor=not-a-cursor")).body.code).toBe("INVALID");
    expect((await list(pager, `cursor=${Buffer.from(JSON.stringify({ a: 1 })).toString("base64url")}`)).status).toBe(400);
  });
});

describe("MCP", () => {
  test("list_reports filters and pages; star_report and unstar_report under reports:write, audited with the key; a report the key cannot open is NOT_FOUND", async () => {
    const tool = (name: string) => reportTools.find((item) => item.name === name)!;
    const mcpUser = await role("Favorites MCP", "member");
    const key = { keyId: "k-favorites", userId: mcpUser.userId, name: "k", scopes: ["reports:read" as const, "reports:write" as const] };
    expect([tool("star_report").scopes, tool("unstar_report").scopes, tool("star_report").buckets]).toEqual([["reports:write"], ["reports:write"], ["report_write"]]);
    expect(visibleTools({ ...key, scopes: ["reports:read"] }).map((item) => item.name)).not.toContain("star_report");
    const first = await newReport(mcpUser, "MCP first");
    const second = await newReport(mcpUser, "MCP second");
    expect(await tool("star_report").handler({ reportId: first.id }, key)).toEqual({ favorite: true });
    const favorites = await tool("list_reports").handler({ favorites: true }, key) as Json;
    expect(favorites.reports.map((report: Json) => [report.id, report.favorite, report.owner])).toEqual([[first.id, true, "me"]]);
    const page = await tool("list_reports").handler({ limit: 1, ownerId: "me" }, key) as Json;
    expect(page.reports.map((report: Json) => report.id)).toEqual([second.id]);
    const next = await tool("list_reports").handler({ limit: 1, ownerId: "me", cursor: page.nextCursor }, key) as Json;
    expect(next.reports.map((report: Json) => report.id)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
    expect(await tool("unstar_report").handler({ reportId: first.id }, key)).toEqual({ favorite: false });
    const audits = db.query("SELECT event_type FROM audit_log WHERE actor_id = ? AND metadata_json LIKE '%k-favorites%' ORDER BY created_at").all(mcpUser.userId) as Array<{ event_type: string }>;
    expect(audits.map((row) => row.event_type)).toEqual(["reports.report.star", "reports.report.unstar"]);
    const othersReport = await newReport(owner, "Not the key's");
    await expect(Promise.resolve().then(() => tool("star_report").handler({ reportId: othersReport.id }, key))).rejects.toThrow();
    const folders = await tool("list_report_folders").handler({}, key) as Json;
    expect(folders.counts).toMatchObject({ favorites: 0 });
    expect(folders.owners[0]).toEqual({ id: mcpUser.userId, name: "me", reports: 2 });
  });
});

describe("the list at scale", () => {
  test("2,000 reports, 300 folders, 50 groups: a page in under 50 ms of CPU, through the indexes", () => {
    const at = Date.parse("2026-10-15T00:00:00.000Z");
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    runMigrations(memory);
    const iso = (offset: number) => new Date(at - offset * 1000).toISOString();
    const users = Array.from({ length: 60 }, (_, index) => `user-${index}`);
    const groups = Array.from({ length: 50 }, (_, index) => `group-${index}`);
    memory.transaction(() => {
      for (const [index, id] of users.entries()) memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, 'member')").run(id, `${id}@example.test`, `Person ${index}`, iso(0));
      memory.query("INSERT INTO report_datasources (id, name, kind, url, username, created_at, updated_at) VALUES ('ds', 'Warehouse', 'clickhouse', 'http://x', 'u', ?, ?)").run(iso(0), iso(0));
      for (const [index, id] of groups.entries()) {
        memory.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `Group ${index}`, iso(0), iso(0));
        for (let member = 0; member < 6; member += 1) memory.query("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, users[(index * 7 + member) % users.length]!, iso(0));
      }
      for (let index = 0; index < 300; index += 1) {
        const ownerId = users[index % users.length]!;
        memory.query("INSERT INTO report_folders (id, created_by, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(`folder-${index}`, ownerId, index >= 60 && index < 180 ? `folder-${index - 60}` : null, `Folder ${index}`, index, iso(0), iso(0));
      }
      const statuses = ["draft", "ready", "stale", "error"];
      for (let index = 0; index < 2000; index += 1) {
        const ownerId = users[index % users.length]!;
        const visibility = index % 10 === 0 ? "all_users" : index % 3 === 0 ? "selected" : "private";
        const folder = index % 4 === 0 ? null : `folder-${(index % 5) * 60 + (index % users.length)}`;
        const folderOwner = folder ? users[Number(folder.slice(7)) % users.length] : null;
        memory.query("INSERT INTO reports (id, owner_id, title, datasource_id, status, visibility, created_at, updated_at, folder_id) VALUES (?, ?, ?, 'ds', ?, ?, ?, ?, ?)")
          .run(`report-${index}`, ownerId, `Report ${index} revenue`, statuses[index % 4]!, visibility, iso(index), iso(index), folderOwner === ownerId ? folder : null);
        if (visibility === "selected") {
          memory.query("INSERT INTO report_members (report_id, user_id, level, created_at) VALUES (?, ?, 'view', ?)").run(`report-${index}`, users[(index + 1) % users.length]!, iso(0));
          memory.query("INSERT INTO report_group_shares (report_id, group_id, level, created_at) VALUES (?, ?, 'view', ?)").run(`report-${index}`, groups[index % groups.length]!, iso(0));
        }
        if (index % 7 === 0) memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES (?, ?, ?)").run(users[(index + 1) % users.length]!, `report-${index}`, iso(0));
        if (index % 9 === 0) memory.query("INSERT INTO report_schedules (report_id, cadence, at_time, tz, enabled, created_at, updated_at) VALUES (?, 'daily', '08:00', 'UTC', 1, ?, ?)").run(`report-${index}`, iso(0), iso(0));
      }
      memory.exec("ANALYZE");
    })();
    const userId = users[1]!;
    const cases: Array<{ name: string; options: Parameters<typeof reportListSql>[0]; index: RegExp }> = [
      { name: "all", options: {}, index: /reports_live_recent/ },
      { name: "status", options: { statuses: ["ready", "stale"] }, index: /reports_status|reports_live_recent/ },
      { name: "owner", options: { ownerId: userId }, index: /report_owners|reports_live_recent/ },
      { name: "favorites", options: { favorites: true }, index: /report_favorites|reports_live_recent/ },
      // Phase 2 (D483): the shared tree; the planner may walk the recent-first index and filter by the subtree list.
      { name: "folder subtree", options: { folderId: "folder-1", subtree: true }, index: /reports_folder|reports_live_recent/ },
      { name: "title and schedule", options: { q: "revenue", scheduled: true }, index: /reports_live_recent/ }
    ];
    const timings: Record<string, number> = {};
    for (const { name, options, index } of cases) {
      const { sql, params } = reportListSql(options);
      const statement = memory.query(sql);
      const bind = { ...params, userId, limit: 101 };
      const plan = (memory.query(`EXPLAIN QUERY PLAN ${sql}`).all(bind) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
      expect({ name, plan }).toEqual({ name, plan: expect.stringMatching(index) });
      // Never a full scan of the reports table.
      expect({ name, plan }).not.toEqual({ name, plan: expect.stringMatching(/SCAN r(?! USING)/) });
      statement.all(bind);
      const runs = Array.from({ length: 5 }, () => cpuMs(() => statement.all(bind))).sort((a, b) => a - b);
      timings[name] = runs[2]!;
    }
    for (const [name, ms] of Object.entries(timings)) expect({ name, ms: ms < 50 }).toEqual({ name, ms: true });
    console.log(`[report list at scale] median CPU ms per page: ${Object.entries(timings).map(([name, ms]) => `${name} ${ms.toFixed(2)}`).join(", ")}`);
  }, HEAVY_TEST_TIMEOUT_MS);
});
