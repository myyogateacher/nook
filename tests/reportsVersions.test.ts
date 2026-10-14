import { afterAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { seedVersionHistory } from "./support/reportVersionsSeed";
import { parseRenameNote, renameNote, versionSourceLabel, versionWhoLabel, type VersionHistoryItem } from "../shared/reportVersions";
import { startFakeClickhouse } from "./support/fakeClickhouse";

const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const { syncSchema } = await import("../server/reports/schemaCatalog");
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

/**
 * Lane J: the Versions panel's routes. The list says where each version came from and who made it
 * (asked by, applied by), with the owner's extras (instruction text, note, run, change summary);
 * commenters and viewers get who, when, and the source only (D459). The diff and one version's spec
 * (the read-only view, with the results stored for its SQL) are the owner's. MCP list_report_versions
 * and get_report_version_diff follow the same rules.
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Versions admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Pankaj Versions");
const asker = await createUser("Ravi Versions");
const viewer = await createUser("Vera Versions");
const guest = await createUser("Gus Versions");
db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);

function newReport(title: string) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at, visibility) VALUES (?, ?, ?, ?, ?, 'selected')").run(id, owner.userId, title, at, at);
  db.query("INSERT INTO report_members (report_id, user_id, level, added_by, created_at) VALUES (?, ?, 'comment', ?, ?)").run(id, asker.userId, owner.userId, at);
  db.query("INSERT INTO report_members (report_id, user_id, level, added_by, created_at) VALUES (?, ?, 'view', ?, ?)").run(id, viewer.userId, owner.userId, at);
  return { id, seeded: seedVersionHistory(db, { reportId: id, ownerId: owner.userId, askerId: asker.userId }) };
}

const { id: reportId, seeded } = newReport("Versions history");
const list = async (session: Session) => (await send(session, "GET", `/reports/${reportId}/versions`)).body.versions as VersionHistoryItem[];

describe("the version list", () => {
  test("each source in plain words, with who asked and who applied", async () => {
    const versions = await list(owner);
    expect(versions.map((item) => [item.version, versionSourceLabel(item), versionWhoLabel(item), item.current])).toEqual([
      [6, "Regenerated", "By Pankaj Versions", true],
      [5, "Restored v2", "By Pankaj Versions", false],
      [4, "Edited by hand", "By Pankaj Versions", false],
      [3, "Applied a change", "Asked by Pankaj Versions · applied automatically", false],
      [2, "Applied a change", "Asked by Ravi Versions · applied by Pankaj Versions", false],
      [1, "Generated from the doc", "By Pankaj Versions", false]
    ]);
    expect(versionSourceLabel({ source: "initial", regenerated: false, restoredFrom: null })).toBe("First saved version");
    expect(versionWhoLabel({ source: "edit", askedByName: "Pankaj", createdByName: "Pankaj", autoApplied: false })).toBe("Asked and applied by Pankaj");
  });

  test("the owner sees the instruction, the note, the run, and what changed against the one before", async () => {
    const versions = await list(owner);
    const byNumber = new Map(versions.map((item) => [item.version, item]));
    expect(byNumber.get(2)).toMatchObject({ instructionText: "Add a table of the latest orders", runId: seeded.runs.v2, askedByName: "Ravi Versions" });
    expect(byNumber.get(2)!.note).toContain("SECRET");
    expect(byNumber.get(1)!.changeSummary).toBe("5 blocks, 3 queries");
    expect(byNumber.get(2)!.changeSummary).toBe("+1 table, title changed, 1 query added");
    expect(byNumber.get(3)!.changeSummary).toBe("1 block changed, text changed, 1 section changed");
    expect(byNumber.get(4)!.changeSummary).toBe("1 query changed");
    // v6 regenerated from v4's spec, so against v5 (a restore of v2) it carries v3 and v4 again.
    expect(byNumber.get(6)!.changeSummary).toBe("+1 chart, 1 block changed, text changed, 1 query changed, 1 section changed");
  });

  test("a commenter sees who, when, and the source; only their own instruction's text; no note, run, or change line", async () => {
    const versions = await list(asker);
    expect(versions.map((item) => [item.version, versionSourceLabel(item), versionWhoLabel(item)])).toEqual((await list(owner)).map((item) => [item.version, versionSourceLabel(item), versionWhoLabel(item)]));
    const byNumber = new Map(versions.map((item) => [item.version, item]));
    expect(byNumber.get(2)!.instructionText).toBe("Add a table of the latest orders");
    expect(byNumber.get(3)!.instructionText).toBeNull();
    for (const item of versions) expect([item.note, item.runId, item.model, item.changeSummary]).toEqual([null, null, null, null]);
    expect(JSON.stringify(versions)).not.toContain("SECRET");
    expect(JSON.stringify(versions)).not.toContain("Make the intro shorter");
  });

  test("a viewer sees no instruction text at all", async () => {
    const versions = await list(viewer);
    expect(versions).toHaveLength(6);
    expect(versions.every((item) => item.instructionText === null && item.note === null && item.runId === null && item.changeSummary === null)).toBe(true);
    expect(JSON.stringify(versions)).not.toMatch(/SECRET|latest orders|intro shorter|SELECT/);
  });

  test("guests and people the report is not shared with get 404", async () => {
    expect((await send(guest, "GET", `/reports/${reportId}/versions`)).status).toBe(404);
    const stranger = await createUser("Stranger Versions");
    expect((await send(stranger, "GET", `/reports/${reportId}/versions`)).status).toBe(404);
  });
});

describe("the diff (the owner's)", () => {
  test("a manual SQL edit: one query changed, as a line diff", async () => {
    const { status, body } = await send(owner, "GET", `/reports/${reportId}/version-diff?to=4`);
    expect(status).toBe(200);
    expect(body.diff).toMatchObject({ from: 3, to: 4, summary: "1 query changed", blocks: [], sections: [] });
    expect(body.diff.queries).toHaveLength(1);
    expect(body.diff.queries[0].key).toBe("by_country");
    expect(body.diff.queries[0].lines.filter((line: Json) => line.op !== "same").map((line: Json) => line.op)).toEqual(["del", "add"]);
    expect(body.diff.queries[0].lines.find((line: Json) => line.op === "add").text).toContain("LIMIT 10");
  });

  test("any two versions: blocks with changed fields, markdown text, and sections", async () => {
    const { body } = await send(owner, "GET", `/reports/${reportId}/version-diff?from=1&to=3`);
    const blocks = body.diff.blocks as Json[];
    expect(blocks.map((block) => [block.blockId, block.change])).toEqual([["intro", "changed"], ["kpi-orders", "changed"], ["country-bar", "changed"], ["recent-table", "added"]]);
    expect(blocks.find((block) => block.blockId === "kpi-orders")!.fields).toEqual([{ field: "width", before: null, after: "half" }, { field: "section", before: null, after: "overview" }]);
    expect(blocks.find((block) => block.blockId === "country-bar")!.fields).toEqual([{ field: "title", before: "Top countries", after: "Top countries by revenue" }]);
    expect(blocks.find((block) => block.blockId === "intro")!.text.some((line: Json) => line.op === "add" && line.text === "Source: `analytics.orders`.")).toBe(true);
    expect(body.diff.sections).toEqual([{ id: "overview", change: "added", title: "Overview", fields: [{ field: "title", before: null, after: "Overview" }, { field: "summary", before: null, after: "Revenue at a glance" }] }]);
    expect(body.diff.queries.map((query: Json) => [query.key, query.change])).toEqual([["recent", "added"]]);
  });

  test("the first version has nothing before it; a missing version is 404", async () => {
    expect((await send(owner, "GET", `/reports/${reportId}/version-diff?to=1`)).status).toBe(404);
    expect((await send(owner, "GET", `/reports/${reportId}/version-diff?to=99`)).status).toBe(404);
    expect((await send(owner, "GET", `/reports/${reportId}/version-diff?to=x`)).status).toBe(404);
  });

  test("commenters and viewers get 404: no SQL diff, no old text", async () => {
    for (const session of [asker, viewer, guest]) {
      expect((await send(session, "GET", `/reports/${reportId}/version-diff?to=4`)).status).toBe(404);
      expect((await send(session, "GET", `/reports/${reportId}/versions/2`)).status).toBe(404);
    }
  });
});

describe("one version for the read-only view (the owner's)", () => {
  test("its spec, and the results stored for exactly its SQL while it was current; none where its SQL never ran then", async () => {
    const { status, body } = await send(owner, "GET", `/reports/${reportId}/versions/4`);
    expect(status).toBe(200);
    expect(body.version).toMatchObject({ version: 4, source: "manual", current: false });
    expect(body.spec.queries.find((query: Json) => query.key === "by_country").sql).toContain("LIMIT 10");
    const results = new Map((body.results as Json[]).map((item) => [item.queryKey, item]));
    // totals and daily ran under v1 with the same SQL; by_country's LIMIT 10 ran only under v6, after v4.
    expect(results.get("totals").result.runId).toBe(seeded.runs.v1);
    expect(results.get("by_country").result).toBeNull();
    expect(results.get("recent").result).toBeNull();
    const current = await send(owner, "GET", `/reports/${reportId}/versions/6`);
    expect((current.body.results as Json[]).every((item) => item.result?.runId === seeded.runs.v6)).toBe(true);
    expect(current.body.version.current).toBe(true);
  });
});

describe("MCP", () => {
  const tool = (name: string) => reportTools.find((item) => item.name === name)!;
  const key = (session: Session) => ({ keyId: `k-${session.userId.slice(0, 6)}`, userId: session.userId, name: "k", scopes: ["reports:read" as const] });

  test("list_report_versions: labels for everyone, the owner's extras only for the owner", async () => {
    const mine = await tool("list_report_versions").handler({ reportId }, key(owner)) as { versions: Json[] };
    expect(mine.versions.map((item) => item.sourceLabel)).toEqual(["Regenerated", "Restored v2", "Edited by hand", "Applied a change", "Applied a change", "Generated from the doc"]);
    expect(mine.versions[4]).toMatchObject({ who: "Asked by Ravi Versions · applied by Pankaj Versions", instructionText: "Add a table of the latest orders" });
    const theirs = await tool("list_report_versions").handler({ reportId }, key(viewer)) as { versions: Json[] };
    expect(theirs.versions.map((item) => item.who)).toEqual(mine.versions.map((item) => item.who));
    expect(JSON.stringify(theirs)).not.toMatch(/SECRET|latest orders|changeSummary":"\+/);
  });

  test("get_report_version_diff: the owner's; anyone else NOT_FOUND", async () => {
    const diff = await tool("get_report_version_diff").handler({ reportId, to: 6 }, key(owner)) as { diff: Json };
    expect(diff.diff).toMatchObject({ from: 5, to: 6 });
    const compared = await tool("get_report_version_diff").handler({ reportId, from: 1, to: 6 }, key(owner)) as { diff: Json };
    expect(compared.diff.summary).toContain("+1 chart");
    for (const session of [asker, viewer]) {
      await expect(Promise.resolve(tool("get_report_version_diff").handler({ reportId, to: 6 }, key(session)))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(Promise.resolve(tool("get_report_version_diff").handler({ reportId, to: 1 }, key(owner)))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("both are read tools under reports:read, offered to agents", async () => {
    const { NOOK_AGENT_TOOLS } = await import("../server/agents/nookBridge");
    for (const name of ["list_report_versions", "get_report_version_diff"]) {
      expect([tool(name).scopes, tool(name).write, NOOK_AGENT_TOOLS.has(name)]).toEqual([["reports:read"], false, true]);
    }
  });
});

describe("J2: a rename is a version", () => {
  test("renaming records a manual version with the spec unchanged; everyone sees 'Renamed to …', the owner the old title too; the diff shows the title", async () => {
    const { id } = newReport("Rename me");
    const revision = (db.query("SELECT revision FROM reports WHERE id = ?").get(id) as { revision: number }).revision;
    const renamed = await send(owner, "PATCH", `/reports/${id}`, { title: "Weekly revenue (net)", expectedRevision: revision });
    expect(renamed.status).toBe(200);
    const row = db.query("SELECT version, source, note, spec_json FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT 1").get(id) as Json;
    expect([row.version, row.source, row.note]).toEqual([7, "manual", "Renamed from “Rename me” to “Weekly revenue (net)”"]);
    expect(row.spec_json).toBe((db.query("SELECT spec_json FROM reports WHERE id = ?").get(id) as Json).spec_json);
    const mine = (await send(owner, "GET", `/reports/${id}/versions`)).body.versions as VersionHistoryItem[];
    expect([versionSourceLabel(mine[0]!), mine[0]!.current, mine[1]!.current, mine[0]!.changeSummary]).toEqual(["Renamed to “Weekly revenue (net)”", true, false, "Title “Rename me” → “Weekly revenue (net)”"]);
    const theirs = (await send(viewer, "GET", `/reports/${id}/versions`)).body.versions as VersionHistoryItem[];
    expect([versionSourceLabel(theirs[0]!), theirs[0]!.note, theirs[0]!.changeSummary]).toEqual(["Renamed to “Weekly revenue (net)”", null, null]);
    const diff = (await send(owner, "GET", `/reports/${id}/version-diff?to=7`)).body.diff as Json;
    expect([diff.title, diff.summary, diff.blocks, diff.queries]).toEqual([{ field: "title", before: "Rename me", after: "Weekly revenue (net)" }, "report title changed", [], []]);
    // Across a range, the oldest title against the newest; a same-title PATCH records nothing.
    await send(owner, "PATCH", `/reports/${id}`, { title: "Revenue", expectedRevision: revision + 1 });
    expect((await send(owner, "GET", `/reports/${id}/version-diff?from=6&to=8`)).body.diff.title).toEqual({ field: "title", before: "Rename me", after: "Revenue" });
    await send(owner, "PATCH", `/reports/${id}`, { title: "Revenue", expectedRevision: revision + 2 });
    expect((db.query("SELECT max(version) AS v FROM report_versions WHERE report_id = ?").get(id) as Json).v).toBe(8);
  });

  test("a report with no blocks has no versions yet: a rename adds none; long titles fit the note", async () => {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES (?, ?, 'Empty', ?, ?)").run(id, owner.userId, at, at);
    expect((await send(owner, "PATCH", `/reports/${id}`, { title: "Still empty", expectedRevision: 1 })).status).toBe(200);
    expect((db.query("SELECT count(*) AS n FROM report_versions WHERE report_id = ?").get(id) as Json).n).toBe(0);
    const note = renameNote("a".repeat(200), "b".repeat(200));
    expect(note.length).toBeLessThanOrEqual(300);
    expect(parseRenameNote(note)!.after).toBe("b".repeat(200));
    expect(parseRenameNote("Shortened the intro")).toBeNull();
  });
});

describe("J2: Run with today's data", () => {
  test("the owner runs an old version's queries once: a run in Runs, results returned, the report's own results, status, and last run untouched", async () => {
    const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Versions DS ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
    const datasourceId = created.body.datasource.id as string;
    await syncSchema(datasourceId).catch(() => undefined);
    const { id, seeded } = newReport("Preview");
    db.query("UPDATE reports SET datasource_id = ? WHERE id = ?").run(datasourceId, id);
    const before = JSON.stringify((await send(owner, "GET", `/reports/${id}/results`)).body.results);
    const report = () => db.query("SELECT status, last_run_at, revision FROM reports WHERE id = ?").get(id) as Json;
    const was = report();
    const ran = await send(owner, "POST", `/reports/${id}/versions/1/preview`, {});
    expect(ran.status).toBe(200);
    expect(ran.body.status).toBe("succeeded");
    const results = ran.body.results as Json[];
    expect(results.map((item) => item.queryKey)).toEqual(seeded.specs[0]!.queries.map((query) => query.key));
    expect(results.every((item) => item.result && item.result.runId === ran.body.runId && item.result.rows.length > 0)).toBe(true);
    // The run is in Runs, marked as v1's preview; its results sit under keys no saved query can have.
    const run = db.query("SELECT kind, trigger, status, query_keys_json FROM report_runs WHERE id = ?").get(ran.body.runId) as Json;
    expect([run.kind, run.trigger, run.status, JSON.parse(run.query_keys_json)[0]]).toEqual(["refresh", "user", "succeeded", "~v1"]);
    expect((db.query("SELECT query_key FROM report_results WHERE run_id = ? ORDER BY query_key").all(ran.body.runId) as Json[]).map((row) => row.query_key)).toEqual(["~by_country", "~daily", "~totals"]);
    expect(JSON.stringify((await send(owner, "GET", `/reports/${id}/results`)).body.results)).toBe(before);
    expect(report()).toEqual(was);
    expect((await send(owner, "GET", `/reports/${id}/run-history`)).body.runs.some((item: Json) => item.id === ran.body.runId)).toBe(true);
    // Never for anyone else; a missing version is 404.
    for (const session of [asker, viewer]) expect((await send(session, "POST", `/reports/${id}/versions/1/preview`, {})).status).toBe(404);
    // A guest has no Reports module: refused before the report is looked up.
    expect([403, 404]).toContain((await send(guest, "POST", `/reports/${id}/versions/1/preview`, {})).status);
    expect((await send(owner, "POST", `/reports/${id}/versions/99/preview`, {})).status).toBe(404);
  });
});
