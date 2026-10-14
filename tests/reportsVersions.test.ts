import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { seedVersionHistory } from "./support/reportVersionsSeed";
import { versionSourceLabel, versionWhoLabel, type VersionHistoryItem } from "../shared/reportVersions";

const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));

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
