import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpuMs } from "./support/cpuTime";
import "./support/harness";

const { runMigrations } = await import("../server/migrations");
const { reportListSizes, reportListSql } = await import("../server/reports/service");

/**
 * Report organization phase 2 leftover (D501): the Reports list past 50,000 reports and 1,000 folders,
 * the folder subtree above all (the shared tree of D483 lets the planner walk `reports_live_recent`
 * instead of `reports_folder`). Opt-in, because seeding 50,000 reports costs seconds:
 * `NOOK_PERF=1 bun --no-env-file test tests/reportListScale.test.ts`. The normal suite keeps the
 * 2,000-report check in tests/reportFavorites.test.ts.
 *
 * Skewed sets are the hard part: an owner of a third of all reports, a folder holding a fifth. The
 * list counts each set-shaped filter (reportListSizes) and either starts from the set or walks the
 * recent-first index. NOOK_PERF_NO_SIZES=1 measures the list without that choice; NOOK_PERF_PLANS=1
 * prints every plan; NOOK_PERF_REPORTS sets the size.
 */

const REPORTS = Number(process.env.NOOK_PERF_REPORTS ?? 50_000);
const FOLDERS = 1_000;
const USERS = 200;
const GROUPS = 100;

describe.skipIf(!process.env.NOOK_PERF)(`the list at ${REPORTS.toLocaleString()} reports (NOOK_PERF)`, () => {
  test("every filter, the folder subtree above all: no full scan, a page well under 50 ms of CPU", () => {
    const at = Date.parse("2026-10-15T00:00:00.000Z");
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    runMigrations(memory);
    const iso = (offset: number) => new Date(at - offset * 1000).toISOString();
    const users = Array.from({ length: USERS }, (_, index) => `user-${index}`);
    const groups = Array.from({ length: GROUPS }, (_, index) => `group-${index}`);
    const seedMs = cpuMs(() => memory.transaction(() => {
      const user = memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, ?)");
      for (const [index, id] of users.entries()) user.run(id, `${id}@example.test`, `Person ${index}`, iso(0), index === 0 ? "admin" : "member");
      memory.query("INSERT INTO report_datasources (id, name, kind, url, username, created_at, updated_at) VALUES ('ds', 'Warehouse', 'clickhouse', 'http://x', 'u', ?, ?)").run(iso(0), iso(0));
      const group = memory.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)");
      const member = memory.query("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)");
      for (const [index, id] of groups.entries()) {
        group.run(id, `Group ${index}`, iso(0), iso(0));
        for (let offset = 0; offset < 8; offset += 1) member.run(id, users[(index * 7 + offset) % USERS]!, iso(0));
      }
      // 1,000 folders on three levels: 100 at the top, 300 below them, 600 at the third level.
      const folder = memory.query("INSERT INTO report_folders (id, created_by, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (let index = 0; index < FOLDERS; index += 1) {
        const parent = index < 100 ? null : index < 400 ? `folder-${index % 100}` : `folder-${100 + (index % 300)}`;
        folder.run(`folder-${index}`, users[index % USERS]!, parent, `Folder ${index}`, index, iso(0), iso(0));
      }
      const report = memory.query("INSERT INTO reports (id, owner_id, title, datasource_id, status, visibility, created_at, updated_at, folder_id) VALUES (?, ?, ?, 'ds', ?, ?, ?, ?, ?)");
      const share = memory.query("INSERT INTO report_members (report_id, user_id, level, created_at) VALUES (?, ?, 'view', ?)");
      const groupShare = memory.query("INSERT INTO report_group_shares (report_id, group_id, level, created_at) VALUES (?, ?, 'view', ?)");
      const favorite = memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES (?, ?, ?)");
      const schedule = memory.query("INSERT INTO report_schedules (report_id, cadence, at_time, tz, enabled, created_at, updated_at) VALUES (?, 'daily', '08:00', 'UTC', 1, ?, ?)");
      const coOwner = memory.query("INSERT INTO report_owners (report_id, user_id, created_at) VALUES (?, ?, ?)");
      const statuses = ["draft", "ready", "stale", "error"];
      for (let index = 0; index < REPORTS; index += 1) {
        const id = `report-${index}`;
        const visibility = index % 10 === 0 ? "all_users" : index % 3 === 0 ? "selected" : "private";
        // A fifth unfiled, a fifth in folder-150 (under folder-50), the rest spread over every folder.
        const folderId = index % 5 === 0 ? null : index % 5 === 1 ? "folder-150" : `folder-${(index * 7919) % FOLDERS}`;
        report.run(id, users[index % USERS]!, `Report ${index} revenue`, statuses[index % 4]!, visibility, iso(index), iso(index), folderId);
        if (visibility === "selected") {
          share.run(id, users[(index + 1) % USERS]!, iso(0));
          groupShare.run(id, groups[index % GROUPS]!, iso(0));
        }
        if (index % 7 === 0) favorite.run(users[(index + 1) % USERS]!, id, iso(0));
        if (index % 9 === 0) schedule.run(id, iso(0), iso(0));
        // user-2 co-owns a third of all reports: the Owner filter for someone with many.
        if (index % 3 === 0 && index % USERS !== 2) coOwner.run(id, "user-2", iso(0));
      }
      memory.exec("ANALYZE");
    })());
    const userId = users[1]!;
    // folder-7: a top folder with its subtree (3 + 6 subfolders); folder-777: a third-level leaf.
    const cases: Array<{ name: string; options: Parameters<typeof reportListSql>[0]; as?: string }> = [
      { name: "all", options: {} },
      { name: "status", options: { statuses: ["ready", "stale"] } },
      { name: "owner", options: { ownerId: userId } },
      { name: "owner of a third", options: { ownerId: "user-2" } },
      { name: "my reports, a third of all", options: { ownerId: "user-2" }, as: "user-2" },
      { name: "all, as that owner", options: {}, as: "user-2" },
      { name: "favorites", options: { favorites: true } },
      { name: "folder", options: { folderId: "folder-7" } },
      { name: "top folder subtree", options: { folderId: "folder-7", subtree: true } },
      { name: "a fifth of all in one folder", options: { folderId: "folder-150" } },
      { name: "a fifth of all in a subtree", options: { folderId: "folder-50", subtree: true } },
      { name: "leaf folder subtree", options: { folderId: "folder-777", subtree: true } },
      { name: "unfiled", options: { folderId: "unfiled" } },
      { name: "title and schedule", options: { q: "revenue", scheduled: true } }
    ];
    const timings: Record<string, number> = {};
    const plans: Record<string, string> = {};
    for (const { name, options, as } of cases) {
      const sizes = () => process.env.NOOK_PERF_NO_SIZES ? {} : reportListSizes(options, as ?? userId, memory);
      const { sql, params } = reportListSql(options, sizes());
      const statement = memory.query(sql);
      const bind = { ...params, userId: as ?? userId, limit: 101 };
      plans[name] = (memory.query(`EXPLAIN QUERY PLAN ${sql}`).all(bind) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
      // Never a full scan of the reports table.
      expect({ name, plan: plans[name] }).not.toEqual({ name, plan: expect.stringMatching(/SCAN r(?! USING)/) });
      statement.all(bind);
      // The sizes count too: the list asks for them on every page.
      const runs = Array.from({ length: 5 }, () => cpuMs(() => { sizes(); statement.all(bind); })).sort((a, b) => a - b);
      timings[name] = runs[2]!;
    }
    console.log(`[report list at ${REPORTS.toLocaleString()}] seed ${Math.round(seedMs)} ms CPU; median CPU ms per page: ${Object.entries(timings).map(([name, ms]) => `${name} ${ms.toFixed(2)}`).join(", ")}`);
    if (process.env.NOOK_PERF_PLANS) for (const [name, plan] of Object.entries(plans)) console.log(`  ${name}: ${plan}`);
    for (const [name, ms] of Object.entries(timings)) expect({ name, ms: ms < 50 }).toEqual({ name, ms: true });
  }, 120_000);
});

describe("the list's choice between a set and the recent-first walk (D501)", () => {
  test("a large owner, favorites, or folder walks reports_live_recent; a small one starts from the set; both give the same page", () => {
    const at = Date.parse("2026-10-15T00:00:00.000Z");
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    runMigrations(memory);
    const iso = (offset: number) => new Date(at - offset * 1000).toISOString();
    const rid = (index: number) => `report-${String(index).padStart(3, "0")}`;
    memory.transaction(() => {
      for (const id of ["big", "small"]) memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, 'member')").run(id, `${id}@example.test`, id, iso(0));
      memory.query("INSERT INTO report_folders (id, created_by, parent_id, name, position, created_at, updated_at) VALUES ('top', 'big', NULL, 'Top', 0, ?, ?), ('sub', 'big', 'top', 'Sub', 0, ?, ?)").run(iso(0), iso(0), iso(0), iso(0));
      for (let index = 0; index < 600; index += 1) {
        // Ties in updated_at, so the id order matters too.
        memory.query("INSERT INTO reports (id, owner_id, title, visibility, created_at, updated_at, folder_id) VALUES (?, ?, ?, 'all_users', ?, ?, ?)")
          .run(rid(index), index % 20 === 0 ? "small" : "big", `Report ${index}`, iso(index), iso(index % 50), index % 3 === 0 ? null : index % 3 === 1 ? "sub" : "top");
        if (index % 2 === 0) memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES ('big', ?, ?)").run(rid(index), iso(0));
        if (index % 50 === 0) memory.query("INSERT INTO report_favorites (user_id, report_id, created_at) VALUES ('small', ?, ?)").run(rid(index), iso(0));
      }
      memory.exec("ANALYZE");
    })();
    const page = (options: Parameters<typeof reportListSql>[0], userId: string, sizes: ReturnType<typeof reportListSizes>) => {
      const { sql, params } = reportListSql(options, sizes);
      const bind = { ...params, userId, limit: 101 };
      const plan = (memory.query(`EXPLAIN QUERY PLAN ${sql}`).all(bind) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
      return { plan, ids: (memory.query(sql).all(bind) as Array<{ id: string }>).map((row) => row.id) };
    };
    const cases: Array<{ options: Parameters<typeof reportListSql>[0]; userId: string; large: boolean }> = [
      { options: { ownerId: "big" }, userId: "small", large: true },
      { options: { ownerId: "small" }, userId: "small", large: false },
      { options: { favorites: true }, userId: "big", large: true },
      { options: { favorites: true }, userId: "small", large: false },
      { options: { folderId: "sub" }, userId: "small", large: false },
      { options: { folderId: "top", subtree: true }, userId: "small", large: true }
    ];
    for (const { options, userId, large } of cases) {
      const sizes = reportListSizes(options, userId, memory);
      // 600 reports: a set is large from √(101 × 600) ≈ 247 (the sub folder holds 200, the subtree 400).
      expect(sizes.largeAt).toBe(247);
      const chosen = page(options, userId, sizes);
      const other = page(options, userId, large ? {} : { ...sizes, largeAt: 0 });
      const walks = /SCAN r USING INDEX reports_live_recent/.test(chosen.plan);
      expect({ options, walks }).toEqual({ options, walks: large });
      expect(chosen.ids.length).toBe(options.ownerId === "small" ? 30 : options.favorites && userId === "small" ? 12 : 101);
      expect(chosen.ids).toEqual(other.ids);
    }
    expect(reportListSizes({ statuses: ["ready"] }, "big", memory)).toEqual({});
  });
});
