import { afterAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse } from "./support/fakeClickhouse";

const { reportTools } = await import("../server/reports/mcpTools");
const { NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");

/**
 * D500, T399: Settings → Report owners. Admins list live reports nobody can manage (no owner who is an
 * active member or admin) and, separately, the reports they cannot open; each row is title, folder,
 * owners with their state, and last change, never content. Recovery is the existing owners API
 * (audited). Everyone else gets 404; the MCP tool is admin-only, the unmanaged list only.
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

const admin = await person("Review admin", "admin");
const owner = await person("Review owner", "member");
const leaver = await person("Review leaver", "member");
const demoted = await person("Review demoted", "member");
const member = await person("Review member", "member");
const datasource = (await send(admin, "POST", "/reports/admin/datasources", { name: "Review warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: [] })).body.datasource as Json;
const newReport = async (session: Session, title: string, extra: Json = {}) => {
  const created = await send(session, "POST", "/reports", { title, datasourceId: datasource.id, ...extra });
  expect(created.status).toBe(201);
  return created.body.report as Json;
};
const review = async (session: Session, query: string) => send(session, "GET", `/reports/admin/owner-review?${query}`);

// Made unmanaged in SQL, as data from before 062 or a demotion with no admin left would be: blocking
// through the Team service hands the reports to an admin (D482).
const folder = (await send(owner, "POST", "/reports/folders", { name: "Review folder" })).body.folder as Json;
const healthy = await newReport(owner, "Zq review healthy");
const blocked = await newReport(leaver, "Zq review blocked owner", { folderId: folder.id });
const viewerOwned = await newReport(demoted, "Zq review viewer owner");
const ownerless = await newReport(member, "Zq review no owners");
await send(leaver, "PUT", `/reports/${blocked.id}/sharing`, { visibility: "all_users", shares: [] });
db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), leaver.userId);
db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(demoted.userId);
db.exec("PRAGMA foreign_keys = OFF");
db.query("DELETE FROM report_owners WHERE report_id = ?").run(ownerless.id);
db.exec("PRAGMA foreign_keys = ON");

describe("GET /api/reports/admin/owner-review", () => {
  test("unmanaged: reports with no active owner, with title, folder, owners and their state, last change; healthy and binned ones left out", async () => {
    const binnedBlocked = await newReport(admin, "Zq review binned");
    expect((await send(admin, "DELETE", `/reports/${binnedBlocked.id}`)).status).toBe(200);
    db.query("DELETE FROM report_owners WHERE report_id = ?").run(binnedBlocked.id);
    const result = await review(admin, "q=zq%20review");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ scope: "unmanaged", total: 3, limit: 200 });
    const byTitle = new Map((result.body.reports as Json[]).map((report) => [report.title, report]));
    expect([...byTitle.keys()].sort()).toEqual(["Zq review blocked owner", "Zq review no owners", "Zq review viewer owner"]);
    expect(byTitle.get("Zq review blocked owner")).toEqual({
      id: blocked.id, title: "Zq review blocked owner", folder: { id: folder.id, name: "Review folder" }, owners: [{ id: leaver.userId, name: "Review leaver", state: "blocked" }],
      updatedAt: expect.any(String), canOpen: true, managed: false
    });
    expect(byTitle.get("Zq review viewer owner")).toMatchObject({ owners: [{ id: demoted.userId, state: "viewer" }], canOpen: false, folder: null });
    expect(byTitle.get("Zq review no owners")).toMatchObject({ owners: [], canOpen: false });
    // Nothing beyond title and place: no spec, doc, status, or sharing.
    for (const report of result.body.reports as Json[]) expect(Object.keys(report).sort()).toEqual(["canOpen", "folder", "id", "managed", "owners", "title", "updatedAt"]);
    // Showing reports the admin cannot open is audited.
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'reports.owner.review' ORDER BY created_at DESC LIMIT 1").get(admin.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ scope: "unmanaged", shown: 3, unopenable: 2, query: true });
  });

  test("unopenable: every live report the admin cannot open, managed or not; readable ones left out", async () => {
    const result = await review(admin, "scope=unopenable&q=zq%20review");
    const titles = (result.body.reports as Json[]).map((report) => [report.title, report.managed]).sort();
    expect(titles).toEqual([["Zq review healthy", true], ["Zq review no owners", false], ["Zq review viewer owner", false]]);
    expect(result.body.reports.every((report: Json) => report.canOpen === false)).toBe(true);
  });

  test("an admin recovers one with the owners API (audited as an admin); it leaves the list", async () => {
    const added = await send(admin, "POST", `/reports/${ownerless.id}/owners`, { userId: admin.userId });
    expect(added.status).toBe(200);
    const event = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.owner.add' AND metadata_json LIKE ?").get(`%${ownerless.id}%`) as { metadata_json: string };
    expect(JSON.parse(event.metadata_json)).toMatchObject({ reportId: ownerless.id, userId: admin.userId });
    const viewerFix = await send(admin, "POST", `/reports/${viewerOwned.id}/owners`, { userId: member.userId });
    expect(JSON.parse((db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.owner.add' AND metadata_json LIKE ?").get(`%${viewerOwned.id}%`) as { metadata_json: string }).metadata_json)).toMatchObject({ asAdmin: true });
    // D503: the Share sheet's Owners list tags the demoted owner "Viewer", as Settings → Report owners does (`active` still means "can sign in").
    expect(viewerFix.body.owners.map((item: Json) => [item.id, item.active, item.state])).toEqual([[demoted.userId, true, "viewer"], [member.userId, true, "active"]]);
    const titles = ((await review(admin, "q=zq%20review")).body.reports as Json[]).map((report) => report.title);
    expect(titles).toEqual(["Zq review blocked owner"]);
  });

  test("anyone but an admin gets 404; a bad scope or an extra parameter is a 400", async () => {
    for (const session of [owner, member, await person("Review viewer", "viewer"), await person("Review guest", "guest")]) expect((await review(session, "")).status).toBe(404);
    expect((await review(admin, "scope=everything")).status).toBe(400);
    expect((await review(admin, "nope=1")).status).toBe(400);
  });
});

describe("list_unmanaged_reports", () => {
  const tool = () => reportTools.find((item) => item.name === "list_unmanaged_reports")!;
  const keyOf = (session: Session) => ({ keyId: `k-review-${session.userId.slice(0, 6)}`, userId: session.userId, name: "k", scopes: ["reports:read" as const] });

  test("admins only, the unmanaged list only, under reports:read; never offered to chat agents", async () => {
    expect([tool().scopes, tool().write, NOOK_NEVER_TOOLS.has("list_unmanaged_reports")]).toEqual([["reports:read"], false, true]);
    expect("scope" in ((tool().inputSchema as unknown as { shape: Record<string, unknown> }).shape)).toBe(false);
    const listed = await tool().handler({ query: "zq review" }, keyOf(admin)) as Json;
    expect(listed).toEqual({ reports: [{ id: blocked.id, title: "Zq review blocked owner", folder: "Review folder", owners: [{ id: leaver.userId, name: "Review leaver", state: "blocked" }], updatedAt: expect.any(String), canOpen: true }], total: 1 });
    await expect(Promise.resolve().then(() => tool().handler({}, keyOf(member)))).rejects.toThrow(/admin/i);
  });
});
