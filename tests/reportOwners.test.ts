import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { seedVersionHistory } from "./support/reportVersionsSeed";
import { startFakeClickhouse } from "./support/fakeClickhouse";

const { visibleTools } = await import("../server/mcpTools");
const { reportTools } = await import("../server/reports/mcpTools");
const { registeredMigrations, runMigrations } = await import("../server/migrations");
const { reportOwnersMigration } = await import("../server/migrations/062_report_owners");
const { blockUser, setRole, unblockUser } = await import("../server/team/service");
const { NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");

/**
 * Report organization phase 2 (migration 062, D481–D483, T389–T391): several owners per report (each
 * with every owner right), owners and admins manage owners, the last owner is never removed, a blocked
 * or demoted last owner hands the report to an admin, one workspace-wide folder tree (members create;
 * admins rename, move, reorder, delete), the MCP owner tools by scope, and D459 still redacting for
 * everyone who is not an owner.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}
async function person(label: string, value: "admin" | "member" | "viewer" | "guest") {
  const session = await createUser(label);
  db.query("UPDATE users SET role = ? WHERE id = ?").run(value, session.userId);
  return session;
}

const admin = await person("Owners admin", "admin");
const owner = await person("Owners owner", "member");
const coOwner = await person("Owners co-owner", "member");
const commenter = await person("Owners commenter", "member");
const viewer = await person("Owners viewer", "viewer");
const guest = await person("Owners guest", "guest");
const outsider = await person("Owners outsider", "member");

const datasource = (await send(admin, "POST", "/reports/admin/datasources", { name: "Owners warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: [] })).body.datasource as Json;
const newReport = async (session: Session, title: string) => {
  const created = await send(session, "POST", "/reports", { title, datasourceId: datasource.id });
  expect(created.status).toBe(201);
  return created.body.report as Json;
};
const share = (session: Session, reportId: string, shares: Json[]) => send(session, "PUT", `/reports/${reportId}/sharing`, { visibility: "selected", shares });
const owners = async (session: Session, reportId: string) => (await send(session, "GET", `/reports/${reportId}/owners`)).body.owners as Json[] | undefined;
const audits = (event: string, reportId: string) => (db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = ? AND metadata_json LIKE ?").all(event, `%${reportId}%`) as Array<{ actor_id: string | null; metadata_json: string }>);

describe("migration 062 report_owners", () => {
  test("copies every owner, makes folders shared with created_by, keeps folder_id, keeps duplicate names, and re-running changes nothing", () => {
    const at = "2026-10-15T00:00:00.000Z";
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    memory.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of registeredMigrations.filter((item) => item.id < 62)) {
      memory.transaction(() => {
        migration.up(memory);
        memory.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
      })();
    }
    for (const id of ["u1", "u2"]) memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, 'member')").run(id, `${id}@example.test`, id.toUpperCase(), at);
    // Two people's own top-level "Finance", a subfolder, and a binned folder.
    memory.query("INSERT INTO report_folders (id, owner_id, name, position, created_at, updated_at) VALUES ('f1', 'u1', 'Finance', 0, ?, ?)").run(at, at);
    memory.query("INSERT INTO report_folders (id, owner_id, name, position, created_at, updated_at) VALUES ('f2', 'u2', 'Finance', 0, ?, ?)").run(at, at);
    memory.query("INSERT INTO report_folders (id, owner_id, parent_id, name, position, created_at, updated_at) VALUES ('f3', 'u1', 'f1', 'Q1', 3, ?, ?)").run(at, at);
    memory.query("INSERT INTO report_folders (id, owner_id, name, position, created_at, updated_at, deleted_at, deleted_by, purge_after, unfiled_json) VALUES ('f4', 'u2', 'Old', 1, ?, ?, ?, 'u2', ?, '[\"r2\"]')").run(at, at, at, at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at, folder_id) VALUES ('r1', 'u1', 'Weekly revenue', ?, ?, 'f3')").run(at, at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at, folder_id) VALUES ('r2', 'u2', 'Churn', ?, ?, 'f2')").run(at, at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r3', 'u2', 'Loose', ?, ?)").run(at, at);

    runMigrations(memory);
    expect(memory.query("SELECT report_id, user_id, added_by FROM report_owners ORDER BY report_id").all()).toEqual([
      { report_id: "r1", user_id: "u1", added_by: "u1" }, { report_id: "r2", user_id: "u2", added_by: "u2" }, { report_id: "r3", user_id: "u2", added_by: "u2" }
    ]);
    const columns = (memory.query("PRAGMA table_info(report_folders)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("created_by");
    expect(columns).not.toContain("owner_id");
    expect(memory.query("SELECT id, created_by, parent_id, name, position, deleted_by, unfiled_json FROM report_folders ORDER BY id").all()).toEqual([
      { id: "f1", created_by: "u1", parent_id: null, name: "Finance", position: 0, deleted_by: null, unfiled_json: "[]" },
      { id: "f2", created_by: "u2", parent_id: null, name: "Finance", position: 0, deleted_by: null, unfiled_json: "[]" },
      { id: "f3", created_by: "u1", parent_id: "f1", name: "Q1", position: 3, deleted_by: null, unfiled_json: "[]" },
      { id: "f4", created_by: "u2", parent_id: null, name: "Old", position: 1, deleted_by: "u2", unfiled_json: "[\"r2\"]" }
    ]);
    // The rebuild undid the drop's SET NULL.
    expect(memory.query("SELECT id, folder_id FROM reports ORDER BY id").all()).toEqual([{ id: "r1", folder_id: "f3" }, { id: "r2", folder_id: "f2" }, { id: "r3", folder_id: null }]);
    expect(memory.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // The foreign keys still hold: a folder's parent and reports.folder_id.
    memory.query("DELETE FROM report_folders WHERE id = 'f1'").run();
    expect(memory.query("SELECT id FROM report_folders WHERE id = 'f3'").get()).toBeNull();
    expect(memory.query("SELECT folder_id FROM reports WHERE id = 'r1'").get()).toEqual({ folder_id: null });
    // A new report is owned by its creator, and a new primary owner joins the owners (the triggers).
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r4', 'u1', 'New', ?, ?)").run(at, at);
    memory.query("UPDATE reports SET owner_id = 'u1' WHERE id = 'r3'").run();
    expect(memory.query("SELECT user_id FROM report_owners WHERE report_id IN ('r3', 'r4') ORDER BY report_id, user_id").all()).toEqual([{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u1" }]);
    // Purging the report removes its owners.
    memory.query("DELETE FROM reports WHERE id = 'r4'").run();
    expect(memory.query("SELECT COUNT(*) AS count FROM report_owners WHERE report_id = 'r4'").get()).toEqual({ count: 0 });

    const schema = memory.query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    const owned = memory.query("SELECT * FROM report_owners ORDER BY report_id, user_id").all();
    reportOwnersMigration.up(memory);
    expect(memory.query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).toEqual(schema);
    expect(memory.query("SELECT * FROM report_owners ORDER BY report_id, user_id").all()).toEqual(owned);
  });
});

describe("several owners (D482)", () => {
  test("an owner adds a co-owner, who gets every owner right; commenters and viewers keep theirs; outsiders and guests get 404", async () => {
    const report = await newReport(owner, "Co-owned revenue");
    await share(owner, report.id, [{ kind: "user", id: commenter.userId, level: "comment" }, { kind: "user", id: viewer.userId, level: "view" }]);
    // Not yet an owner: the co-owner cannot even read it.
    expect((await send(coOwner, "GET", `/reports/${report.id}`)).status).toBe(404);
    const added = await send(owner, "POST", `/reports/${report.id}/owners`, { userId: coOwner.userId });
    expect(added.status).toBe(200);
    expect(added.body.owners.map((item: Json) => [item.id, item.primary])).toEqual([[owner.userId, true], [coOwner.userId, false]]);
    expect(audits("reports.owner.add", report.id).map((row) => row.actor_id)).toEqual([owner.userId]);

    // Each action against each person (T168: a non-owner's refusal is the report's 404).
    const actions: Array<[string, (session: Session) => Promise<number>]> = [
      ["read", async (session) => (await send(session, "GET", `/reports/${report.id}`)).status],
      ["rename", async (session) => (await send(session, "PATCH", `/reports/${report.id}`, { title: "Renamed", expectedRevision: (db.query("SELECT revision FROM reports WHERE id = ?").get(report.id) as { revision: number }).revision })).status],
      ["sharing", async (session) => (await send(session, "GET", `/reports/${report.id}/sharing`)).status],
      ["owners", async (session) => (await send(session, "GET", `/reports/${report.id}/owners`)).status],
      ["file", async (session) => (await send(session, "PATCH", `/reports/${report.id}/folder`, { folderId: null })).status],
      ["auto-apply", async (session) => (await send(session, "PUT", `/reports/${report.id}/auto-apply`, { autoApply: false })).status]
    ];
    const matrix: Record<string, Record<string, number>> = {};
    for (const [label, session] of [["owner", owner], ["co-owner", coOwner], ["admin", admin], ["commenter", commenter], ["viewer", viewer], ["guest", guest], ["outsider", outsider]] as const) {
      matrix[label] = {};
      for (const [name, act] of actions) matrix[label]![name] = await act(session);
    }
    expect(matrix).toEqual({
      owner: { read: 200, rename: 200, sharing: 200, owners: 200, file: 200, "auto-apply": 200 },
      "co-owner": { read: 200, rename: 200, sharing: 200, owners: 200, file: 200, "auto-apply": 200 },
      // An admin manages owners of any report, but is no owner by role.
      admin: { read: 404, rename: 404, sharing: 404, owners: 200, file: 404, "auto-apply": 404 },
      commenter: { read: 200, rename: 404, sharing: 404, owners: 404, file: 404, "auto-apply": 404 },
      viewer: { read: 200, rename: 403, sharing: 404, owners: 404, file: 403, "auto-apply": 403 },
      // The write gate answers a guest's changes with 403 before the reports module (no Reports: 404 on reads).
      guest: { read: 404, rename: 403, sharing: 404, owners: 404, file: 403, "auto-apply": 403 },
      outsider: { read: 404, rename: 404, sharing: 404, owners: 404, file: 404, "auto-apply": 404 }
    });

    // The list: the co-owner's "Mine", the row level, and the counts.
    const row = async (session: Session) => ((await send(session, "GET", "/reports?owner=me")).body.reports as Json[]).find((item) => item.id === report.id);
    expect(await row(coOwner)).toMatchObject({ isOwner: true, level: "owner", ownerCount: 2 });
    expect(((await send(commenter, "GET", "/reports")).body.reports as Json[]).find((item) => item.id === report.id)).toMatchObject({ isOwner: false, level: "comment" });
    expect(((await send(viewer, "GET", "/reports")).body.reports as Json[]).find((item) => item.id === report.id)).toMatchObject({ isOwner: false, level: "view" });
    expect(((await send(commenter, "GET", `/reports?owner=${coOwner.userId}`)).body.reports as Json[]).map((item) => item.id)).toContain(report.id);
    // Sharing with an owner is refused; the detail says who may manage owners.
    expect((await share(owner, report.id, [{ kind: "user", id: coOwner.userId, level: "view" }])).status).toBe(400);
    expect((await send(coOwner, "GET", `/reports/${report.id}`)).body.report).toMatchObject({ canManageOwners: true });
    expect((await send(commenter, "GET", `/reports/${report.id}`)).body.report).toMatchObject({ canManageOwners: false });
    // Viewers and guests are never owners.
    expect((await send(owner, "POST", `/reports/${report.id}/owners`, { userId: viewer.userId })).status).toBe(400);
    expect((await send(owner, "POST", `/reports/${report.id}/owners`, { userId: guest.userId })).status).toBe(400);
    expect((await send(commenter, "POST", `/reports/${report.id}/owners`, { userId: commenter.userId })).status).toBe(404);
  });

  test("the last owner is never removed; removing the primary moves it; an admin manages owners of a report they cannot read", async () => {
    const report = await newReport(owner, "Last owner");
    const refused = await send(owner, "DELETE", `/reports/${report.id}/owners/${owner.userId}`);
    expect([refused.status, refused.body.code]).toEqual([409, "LAST_OWNER"]);
    expect((await send(admin, "DELETE", `/reports/${report.id}/owners/${owner.userId}`)).body.code).toBe("LAST_OWNER");
    // The admin adds a co-owner to a private report they cannot open, and that is audited as an admin's act.
    expect((await send(admin, "GET", `/reports/${report.id}`)).status).toBe(404);
    expect((await send(admin, "POST", `/reports/${report.id}/owners`, { userId: coOwner.userId })).status).toBe(200);
    expect(JSON.parse(audits("reports.owner.add", report.id)[0]!.metadata_json)).toMatchObject({ asAdmin: true, userId: coOwner.userId });
    // The creator leaves: the co-owner becomes the primary owner, and the creator loses access.
    const left = await send(owner, "DELETE", `/reports/${report.id}/owners/${owner.userId}`);
    expect(left.body).toEqual({ owners: [], canManage: false });
    expect(db.query("SELECT owner_id FROM reports WHERE id = ?").get(report.id)).toEqual({ owner_id: coOwner.userId });
    expect((await send(owner, "GET", `/reports/${report.id}`)).status).toBe(404);
    expect((await owners(coOwner, report.id))!.map((item) => [item.id, item.primary])).toEqual([[coOwner.userId, true]]);
    expect((await send(coOwner, "DELETE", `/reports/${report.id}/owners/${coOwner.userId}`)).body.code).toBe("LAST_OWNER");
    expect(audits("reports.owner.remove", report.id)).toHaveLength(1);
  });

  test("blocking the last owner hands the report to the blocking admin; a co-owner who can act just becomes primary; making one a guest does the same", async () => {
    const solo = await person("Owners solo", "member");
    const pair = await person("Owners pair", "member");
    const alone = await newReport(solo, "Solo report");
    const shared = await newReport(pair, "Pair report");
    await send(pair, "POST", `/reports/${shared.id}/owners`, { userId: coOwner.userId });
    const binned = await newReport(solo, "Solo binned");
    await send(solo, "DELETE", `/reports/${binned.id}`);

    blockUser({ id: admin.userId, role: "admin" }, solo.userId, null, { via: "web" });
    expect((await owners(admin, alone.id))!.map((item) => [item.id, item.primary, item.active])).toEqual([[solo.userId, false, false], [admin.userId, true, true]]);
    expect(db.query("SELECT COUNT(*) AS count FROM report_owners WHERE report_id = ? AND user_id = ?").get(binned.id, admin.userId)).toEqual({ count: 1 });
    expect(JSON.parse(audits("reports.owner.handover", alone.id)[0]!.metadata_json)).toMatchObject({ from: solo.userId, to: admin.userId });
    // The admin now owns it, so they can open it and restore the binned one.
    expect((await send(admin, "GET", `/reports/${alone.id}`)).status).toBe(200);
    unblockUser({ id: admin.userId, role: "admin" }, solo.userId, { via: "web" });

    setRole({ id: admin.userId, role: "admin" }, pair.userId, { role: "guest", expectedRole: "member" }, { via: "web" });
    // Another owner can act: no admin is added; the primary moves to them.
    expect(db.query("SELECT owner_id FROM reports WHERE id = ?").get(shared.id)).toEqual({ owner_id: coOwner.userId });
    expect(db.query("SELECT COUNT(*) AS count FROM report_owners WHERE report_id = ? AND user_id = ?").get(shared.id, admin.userId)).toEqual({ count: 0 });
    expect(audits("reports.owner.handover", shared.id)).toHaveLength(0);
  });
});

describe("one shared folder tree (D481, D483)", () => {
  test("members create; only admins rename, move, reorder, delete; viewers and guests create nothing; a folder never grants access", async () => {
    const created = await send(owner, "POST", "/reports/folders", { name: "Sales" });
    expect(created.status).toBe(201);
    const folder = created.body.folder as Json;
    expect(folder.createdBy).toEqual({ id: owner.userId, name: "Owners owner" });
    const same = await send(outsider, "POST", "/reports/folders", { name: "Sales" });
    expect(same.status).toBe(201);
    expect((await send(viewer, "POST", "/reports/folders", { name: "Nope" })).status).toBe(403);
    expect((await send(guest, "POST", "/reports/folders", { name: "Nope" })).status).toBe(403);
    expect((await send(guest, "GET", "/reports/folders")).status).toBe(404);

    const rights = async (session: Session) => {
      const tree = (await send(session, "GET", "/reports/folders")).body;
      return [tree.canCreateFolders, tree.canManageFolders, tree.folders.some((item: Json) => item.id === folder.id)];
    };
    expect([await rights(admin), await rights(owner), await rights(viewer)]).toEqual([[true, true, true], [true, false, true], [false, false, true]]);

    for (const [session, expected] of [[owner, 403], [coOwner, 403], [viewer, 403], [admin, 200]] as const) {
      expect([session.userId, (await send(session, "PATCH", `/reports/folders/${folder.id}`, { name: "Sales team" })).status]).toEqual([session.userId, expected]);
    }
    expect((await send(owner, "PATCH", `/reports/folders/${folder.id}`, { position: 0 })).body.code).toBe("ADMIN_ONLY");
    expect((await send(owner, "PATCH", `/reports/folders/${folder.id}`, { parentId: same.body.folder.id })).body.code).toBe("ADMIN_ONLY");
    expect((await send(owner, "DELETE", `/reports/folders/${folder.id}`)).status).toBe(403);

    // A folder never grants: the outsider sees the folder, not the private report in it.
    const report = await newReport(owner, "In Sales");
    expect((await send(owner, "PATCH", `/reports/${report.id}/folder`, { folderId: folder.id })).status).toBe(200);
    expect(((await send(outsider, "GET", `/reports?folder=${folder.id}`)).body.reports as Json[]).length).toBe(0);
    expect((await send(outsider, "GET", "/reports/folders")).body.folders.find((item: Json) => item.id === folder.id).count).toBe(0);
    expect((await send(outsider, "GET", `/reports/${report.id}`)).status).toBe(404);

    // The admin's delete moves every report in it to Unfiled, whoever owns it, and the restore files them back.
    const removed = await send(admin, "DELETE", `/reports/folders/${folder.id}`);
    expect(removed.body).toMatchObject({ ok: true, unfiled: 1 });
    expect(db.query("SELECT folder_id FROM reports WHERE id = ?").get(report.id)).toEqual({ folder_id: null });
    expect((await send(admin, "POST", `/bin/report_folder/${folder.id}/restore`)).status).toBe(200);
    expect(db.query("SELECT folder_id FROM reports WHERE id = ?").get(report.id)).toEqual({ folder_id: folder.id });
    const events = (db.query("SELECT event_type FROM audit_log WHERE metadata_json LIKE ? AND event_type LIKE 'reports.folder.%'").all(`%${folder.id}%`) as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(new Set(events)).toEqual(new Set(["reports.folder.create", "reports.folder.update", "reports.folder.bin", "reports.folder.restore"]));
  });
});

describe("MCP owner and folder tools", () => {
  const tool = (name: string) => reportTools.find((item) => item.name === name)!;
  const keyOf = (session: Session, scopes: Array<"reports:read" | "reports:write">) => ({ keyId: `k-owners-${session.userId.slice(0, 6)}`, userId: session.userId, name: "k", scopes });

  test("list_report_owners under reports:read; add under reports:write, audited; no removal over MCP (D180); never offered to agents", async () => {
    expect([tool("list_report_owners").scopes, tool("add_report_owner").scopes, tool("update_report_folder").scopes]).toEqual([["reports:read"], ["reports:write"], ["reports:write"]]);
    expect(reportTools.some((item) => item.name === "remove_report_owner")).toBe(false);
    const readOnly = visibleTools(keyOf(owner, ["reports:read"])).map((item) => item.name);
    expect(readOnly).toContain("list_report_owners");
    expect(readOnly).not.toContain("add_report_owner");
    for (const name of ["list_report_owners", "add_report_owner", "update_report_folder"]) expect([name, NOOK_NEVER_TOOLS.has(name)]).toEqual([name, true]);

    const report = await newReport(owner, "MCP owners");
    const key = keyOf(owner, ["reports:read", "reports:write"]);
    const added = await tool("add_report_owner").handler({ reportId: report.id, userId: coOwner.userId }, key) as Json;
    expect(added.owners.map((item: Json) => item.id)).toEqual([owner.userId, coOwner.userId]);
    expect(((await tool("list_report_owners").handler({ reportId: report.id }, key)) as Json).owners).toHaveLength(2);
    const events = audits("reports.owner.add", report.id).map((row) => JSON.parse(row.metadata_json) as Json);
    expect(events).toHaveLength(1);
    expect(events.every((meta) => meta.via === "mcp" && meta.keyId === key.keyId)).toBe(true);
    // A commenter's key cannot list or change the owners.
    await share(owner, report.id, [{ kind: "user", id: commenter.userId, level: "comment" }]);
    await expect(Promise.resolve().then(() => tool("list_report_owners").handler({ reportId: report.id }, keyOf(commenter, ["reports:read"])))).rejects.toThrow();
    await expect(Promise.resolve().then(() => tool("add_report_owner").handler({ reportId: report.id, userId: commenter.userId }, keyOf(commenter, ["reports:write"])))).rejects.toThrow();
  });

  test("create_report_folder for any member; update_report_folder for admins only", async () => {
    const created = await tool("create_report_folder").handler({ name: "MCP shared" }, keyOf(outsider, ["reports:write"])) as Json;
    await expect(Promise.resolve().then(() => tool("update_report_folder").handler({ folderId: created.folder.id, name: "Mine" }, keyOf(outsider, ["reports:write"])))).rejects.toThrow(/admin/);
    const renamed = await tool("update_report_folder").handler({ folderId: created.folder.id, name: "MCP renamed" }, keyOf(admin, ["reports:write"])) as Json;
    expect(renamed.folder.name).toBe("MCP renamed");
    const listed = await tool("list_report_folders").handler({}, keyOf(owner, ["reports:read"])) as Json;
    expect(listed.folders.find((item: Json) => item.id === created.folder.id)).toMatchObject({ name: "MCP renamed" });
    expect([listed.canCreateFolders, listed.canManageFolders]).toEqual([true, false]);
  });
});

describe("D459 still redacts for everyone who is not an owner", () => {
  test("a co-owner sees the agent's notes and changes; a commenter sees who and when only", async () => {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at, visibility) VALUES (?, ?, 'Redacted history', ?, ?, 'selected')").run(id, owner.userId, at, at);
    db.query("INSERT INTO report_members (report_id, user_id, level, added_by, created_at) VALUES (?, ?, 'comment', ?, ?)").run(id, commenter.userId, owner.userId, at);
    seedVersionHistory(db, { reportId: id, ownerId: owner.userId, askerId: commenter.userId });
    await send(owner, "POST", `/reports/${id}/owners`, { userId: coOwner.userId });
    const versions = async (session: Session) => (await send(session, "GET", `/reports/${id}/versions`)).body.versions as Json[];
    const forCoOwner = (await versions(coOwner)).find((item) => item.version === 2)!;
    const forCommenter = (await versions(commenter)).find((item) => item.version === 2)!;
    expect(forCoOwner.note).toContain("SECRET");
    expect(forCoOwner.changeSummary).toBeTruthy();
    expect(forCommenter.note ?? null).toBeNull();
    expect(forCommenter.changeSummary).toBeNull();
  });
});
