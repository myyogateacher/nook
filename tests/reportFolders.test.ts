import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";

const { reportTools } = await import("../server/reports/mcpTools");
const { visibleTools } = await import("../server/mcpTools");
const { registeredMigrations, runMigrations } = await import("../server/migrations");
const { reportFoldersMigration } = await import("../server/migrations/059_report_folders");

/**
 * Report folders (Lane I, migration 059): folder CRUD, nesting up to three levels, reorder, a folder
 * deleted to the Bin moves its reports to Unfiled (and a restore puts them back), owner-only access,
 * filing a report (PATCH and POST /reports with folderId), and the MCP folder tools by scope.
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

const admin = await role("Folders admin", "admin");
const owner = await role("Folders owner", "member");
const other = await role("Folders other", "member");
const viewer = await role("Folders viewer", "viewer");
const guest = await role("Folders guest", "guest");

// No password: a sealed secret here would outlive agentsReview's key swap when files share one database.
const datasource = (await send(admin, "POST", "/reports/admin/datasources", { name: "Folders warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: [] })).body.datasource as Json;
const newReport = async (session: Session, title: string, folderId?: string | null) => {
  const created = await send(session, "POST", "/reports", { title, datasourceId: datasource.id, ...(folderId !== undefined ? { folderId } : {}) });
  expect(created.status).toBe(201);
  return created.body.report as Json;
};
const newFolder = async (session: Session, name: string, parentId?: string) => {
  const created = await send(session, "POST", "/reports/folders", { name, ...(parentId ? { parentId } : {}) });
  expect(created.status).toBe(201);
  return created.body.folder as Json;
};
const tree = async (session: Session) => (await send(session, "GET", "/reports/folders")).body as { folders: Json[]; counts: Json };

describe("migration 059 report_folders", () => {
  test("adds report_folders with its checks and reports.folder_id; purging a folder clears it; re-running changes nothing", () => {
    const at = "2026-10-14T00:00:00.000Z";
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    memory.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of registeredMigrations.filter((item) => item.id < 59)) {
      memory.transaction(() => {
        migration.up(memory);
        memory.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
      })();
    }
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'Weekly revenue', ?, ?)").run(at, at);
    runMigrations(memory);
    expect(memory.query("SELECT folder_id FROM reports WHERE id = 'r1'").get()).toEqual({ folder_id: null });
    memory.query("INSERT INTO report_folders (id, owner_id, name, created_at, updated_at) VALUES ('f1', 'u1', 'Finance', ?, ?)").run(at, at);
    expect(() => memory.query("INSERT INTO report_folders (id, owner_id, name, created_at, updated_at) VALUES ('f2', 'u1', '', ?, ?)").run(at, at)).toThrow();
    expect(() => memory.query("INSERT INTO report_folders (id, owner_id, parent_id, name, created_at, updated_at) VALUES ('f3', 'u1', 'f3', 'Self', ?, ?)").run(at, at)).toThrow();
    expect(() => memory.query("UPDATE report_folders SET deleted_at = ? WHERE id = 'f1'").run(at)).toThrow();
    expect(() => memory.query("UPDATE report_folders SET unfiled_json = '{}' WHERE id = 'f1'").run()).toThrow();
    memory.query("UPDATE reports SET folder_id = 'f1' WHERE id = 'r1'").run();
    memory.query("DELETE FROM report_folders WHERE id = 'f1'").run();
    expect(memory.query("SELECT folder_id FROM reports WHERE id = 'r1'").get()).toEqual({ folder_id: null });
    reportFoldersMigration.up(memory);
    expect((memory.query("SELECT id FROM schema_migrations WHERE id >= 57 ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id)).toContain(59);
  });
});

describe("folders over HTTP", () => {
  test("create, nest up to three levels, rename, reorder, and move; counts per folder", async () => {
    const finance = await newFolder(owner, "Finance");
    const growth = await newFolder(owner, "Growth");
    const q1 = await newFolder(owner, "Q1", finance.id);
    const weekly = await newFolder(owner, "Weekly", q1.id);
    expect(weekly.parentId).toBe(q1.id);
    // A fourth level is refused, and so is a move that would make one.
    expect((await send(owner, "POST", "/reports/folders", { name: "Too deep", parentId: weekly.id })).body.code).toBe("TOO_DEEP");
    expect((await send(owner, "PATCH", `/reports/folders/${finance.id}`, { parentId: growth.id })).body.code).toBe("TOO_DEEP");
    // Not into itself.
    expect((await send(owner, "PATCH", `/reports/folders/${finance.id}`, { parentId: weekly.id })).status).toBe(400);
    expect((await send(owner, "POST", "/reports/folders", { name: "  " })).status).toBe(400);
    expect((await send(owner, "POST", "/reports/folders", { name: "Two\nlines" })).status).toBe(400);

    const renamed = await send(owner, "PATCH", `/reports/folders/${growth.id}`, { name: "Growth team" });
    expect(renamed.body.folder.name).toBe("Growth team");
    // Reorder: Growth first among the top-level folders.
    await send(owner, "PATCH", `/reports/folders/${growth.id}`, { position: 0 });
    let listed = await tree(owner);
    const top = listed.folders.filter((folder) => folder.parentId === null).sort((a, b) => a.position - b.position).map((folder) => folder.name);
    expect(top.slice(0, 2)).toEqual(["Growth team", "Finance"]);
    // Move Weekly to the top level.
    const moved = await send(owner, "PATCH", `/reports/folders/${weekly.id}`, { parentId: null });
    expect(moved.body.folder.parentId).toBeNull();

    await newReport(owner, "Revenue", finance.id);
    await newReport(owner, "Churn", finance.id);
    await newReport(owner, "Loose");
    listed = await tree(owner);
    expect(listed.folders.find((folder) => folder.id === finance.id)!.count).toBe(2);
    expect(listed.counts.unfiled).toBeGreaterThanOrEqual(1);
    const list = (await send(owner, "GET", "/reports")).body.reports as Json[];
    expect(list.find((report) => report.title === "Revenue")!.folderId).toBe(finance.id);
    expect(list.find((report) => report.title === "Loose")!.folderId).toBeNull();
    const audits = db.query("SELECT event_type FROM audit_log WHERE actor_id = ? AND event_type LIKE 'reports.folder.%'").all(owner.userId) as Array<{ event_type: string }>;
    expect(new Set(audits.map((row) => row.event_type))).toEqual(new Set(["reports.folder.create", "reports.folder.update"]));
  });

  test("file a report: PATCH folder and back to Unfiled, without changing its revision or updated time", async () => {
    const folder = await newFolder(owner, "Ops");
    const report = await newReport(owner, "Latency");
    const filed = await send(owner, "PATCH", `/reports/${report.id}/folder`, { folderId: folder.id });
    expect(filed.status).toBe(200);
    expect(filed.body).toMatchObject({ previousFolderId: null, report: { id: report.id, folderId: folder.id, revision: report.revision, updatedAt: report.updatedAt } });
    const unfiled = await send(owner, "PATCH", `/reports/${report.id}/folder`, { folderId: null });
    expect(unfiled.body).toMatchObject({ previousFolderId: folder.id, report: { folderId: null } });
    expect((await send(owner, "PATCH", `/reports/${report.id}/folder`, { folderId: crypto.randomUUID() })).status).toBe(404);
    expect((await send(owner, "PATCH", `/reports/${report.id}/folder`, {})).status).toBe(400);
  });

  test("owner only: another person's folder or report is a 404; a reader sees the report unfiled, under Shared; viewers and guests cannot write", async () => {
    const folder = await newFolder(owner, "Private");
    const report = await newReport(owner, "Shared revenue", folder.id);
    const othersOwn = await newReport(other, "Other's report");
    expect((await send(other, "PATCH", `/reports/folders/${folder.id}`, { name: "Mine" })).status).toBe(404);
    expect((await send(other, "DELETE", `/reports/folders/${folder.id}`)).status).toBe(404);
    expect((await send(other, "POST", "/reports/folders", { name: "Sub", parentId: folder.id })).status).toBe(404);
    expect((await send(other, "POST", "/reports", { title: "In yours", datasourceId: datasource.id, folderId: folder.id })).status).toBe(404);
    expect((await send(owner, "PATCH", `/reports/${othersOwn.id}/folder`, { folderId: folder.id })).status).toBe(404);
    expect((await tree(other)).folders.some((item) => item.id === folder.id)).toBe(false);

    // Shared with everyone: the reader lists it with no folder, and counts it under Shared with me.
    db.query("UPDATE reports SET visibility = 'all_users' WHERE id = ?").run(report.id);
    const seen = ((await send(other, "GET", "/reports")).body.reports as Json[]).find((item) => item.id === report.id)!;
    expect(seen).toMatchObject({ isOwner: false, folderId: null });
    expect((await tree(other)).counts.shared).toBeGreaterThanOrEqual(1);
    expect((await send(other, "PATCH", `/reports/${report.id}/folder`, { folderId: null })).status).toBe(404);
    db.query("UPDATE reports SET visibility = 'private' WHERE id = ?").run(report.id);

    expect((await send(viewer, "POST", "/reports/folders", { name: "Viewer" })).status).toBe(403);
    expect((await send(guest, "GET", "/reports/folders")).status).toBe(404);
  });

  test("deleting a folder moves it and its subfolders to the Bin and its reports to Unfiled; restore puts them back", async () => {
    const parent = await newFolder(owner, "Marketing");
    const child = await newFolder(owner, "Campaigns", parent.id);
    const inParent = await newReport(owner, "Signups", parent.id);
    const inChild = await newReport(owner, "CTR", child.id);
    const removed = await send(owner, "DELETE", `/reports/folders/${parent.id}`);
    expect(removed.body).toMatchObject({ ok: true, unfiled: 2, subfolders: 1 });
    // Never deleted: both reports are live and unfiled.
    const list = (await send(owner, "GET", "/reports")).body.reports as Json[];
    expect(list.filter((report) => [inParent.id, inChild.id].includes(report.id)).map((report) => report.folderId)).toEqual([null, null]);
    expect((await tree(owner)).folders.some((folder) => [parent.id, child.id].includes(folder.id))).toBe(false);
    // The Bin lists the folder deleted, not its subfolder.
    const bin = (await send(owner, "GET", "/bin")).body.items as Json[];
    expect(bin.filter((item) => item.type === "report_folder").map((item) => item.id)).toContain(parent.id);
    expect(bin.some((item) => item.id === child.id)).toBe(false);
    expect((await send(other, "POST", `/bin/report_folder/${parent.id}/restore`)).status).toBe(404);

    // One report is filed elsewhere meanwhile: it stays there after the restore.
    const elsewhere = await newFolder(owner, "Elsewhere");
    await send(owner, "PATCH", `/reports/${inChild.id}/folder`, { folderId: elsewhere.id });
    const restored = await send(owner, "POST", `/bin/report_folder/${parent.id}/restore`);
    expect(restored.status).toBe(200);
    const after = (await send(owner, "GET", "/reports")).body.reports as Json[];
    expect(after.find((report) => report.id === inParent.id)!.folderId).toBe(parent.id);
    expect(after.find((report) => report.id === inChild.id)!.folderId).toBe(elsewhere.id);
    expect((await tree(owner)).folders.find((folder) => folder.id === child.id)!.parentId).toBe(parent.id);

    // Purged: the folders go, the reports stay.
    await send(owner, "DELETE", `/reports/folders/${parent.id}`);
    expect((await send(owner, "DELETE", `/bin/report_folder/${parent.id}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM report_folders WHERE id IN (?, ?)").get(parent.id, child.id)).toEqual({ count: 0 });
    expect(db.query("SELECT folder_id, deleted_at FROM reports WHERE id = ?").get(inParent.id)).toEqual({ folder_id: null, deleted_at: null });
  });
});

describe("MCP folder tools", () => {
  test("list_report_folders under reports:read; create_report_folder and move_report_to_folder under reports:write, audited", async () => {
    const tool = (name: string) => reportTools.find((item) => item.name === name)!;
    const key = { keyId: "k-folders", userId: owner.userId, name: "k", scopes: ["reports:read" as const, "reports:write" as const] };
    expect(tool("list_report_folders").scopes).toEqual(["reports:read"]);
    expect([tool("create_report_folder").scopes, tool("move_report_to_folder").scopes]).toEqual([["reports:write"], ["reports:write"]]);
    expect(visibleTools({ ...key, scopes: ["reports:read"] }).map((item) => item.name)).not.toContain("create_report_folder");

    const created = await tool("create_report_folder").handler({ name: "From MCP" }, key) as { folder: Json };
    const report = await newReport(owner, "MCP filed");
    const moved = await tool("move_report_to_folder").handler({ reportId: report.id, folderId: created.folder.id }, key) as Json;
    expect(moved).toMatchObject({ report: { id: report.id, folderId: created.folder.id }, previousFolderId: null });
    const listed = await tool("list_report_folders").handler({}, key) as { folders: Json[]; counts: Json };
    expect(listed.folders.find((folder) => folder.id === created.folder.id)).toMatchObject({ name: "From MCP", parentId: null, reports: 1 });
    const audits = db.query("SELECT event_type, metadata_json FROM audit_log WHERE actor_id = ? AND metadata_json LIKE '%k-folders%'").all(owner.userId) as Array<{ event_type: string }>;
    expect(audits.map((row) => row.event_type).sort()).toEqual(["reports.folder.create", "reports.report.file"]);
    // Another person's report: NOT_FOUND.
    const othersReport = await newReport(other, "Not yours");
    await expect(Promise.resolve().then(() => tool("move_report_to_folder").handler({ reportId: othersReport.id, folderId: null }, key))).rejects.toThrow();
  });
});
