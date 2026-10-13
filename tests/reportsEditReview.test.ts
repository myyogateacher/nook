import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeAnswer } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";
import { retireUsersAfterFile } from "./support/retireUsers";
import { qaEditScript, startScriptedProvider } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";

const { editDeps, liveEdits } = await import("../server/reports/edit");
const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { persistGenerated, validateSpec } = await import("../server/reports/specValidate");
const { forValidation } = await import("../server/reports/specCheck");
const { datasourceRow } = await import("../server/reports/datasources");
const { reportTools } = await import("../server/reports/mcpTools");
const { backfillVersion } = await import("../server/reports/versionBackfill");
const { guestJoinRefused, listGroups } = await import("../server/team/groups");
const { accessSummary, resetAccess } = await import("../server/team/memberAccess");

/**
 * The wave 48 review fixes (H1–H2, M1–M4, L1–L4): only validated specs are saved (strict blocks), Apply
 * and restore re-check the data source and allowlist, a commenter never sees the doc through the edit
 * agent, generation records its version, proposals compare the spec's hash and stale ones are rejected,
 * report shares on the member access page and in group counts, the target block's rows as data, the
 * doc's traces hidden from readers, a failed start fails the instruction, and the Bin stops work.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(24872);
const provider = startScriptedProvider(0, qaEditScript);
const originalConnection = editDeps.connection;
const scripted = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
editDeps.connection = scripted;

function answer(sql: string): FakeAnswer {
  if (sql.includes("net_revenue")) return { meta: [{ name: "country", type: "LowCardinality(String)" }, { name: "net_revenue", type: "Float64" }], data: [["US", 5120.5], ["DE", 3011]] };
  return sampleAnswer(sql);
}

afterAll(() => {
  editDeps.connection = originalConnection;
  fake.stop();
  provider.stop();
});
beforeEach(() => {
  fake.state.select = (sql) => answer(sql);
  provider.setScript(qaEditScript);
  provider.calls.length = 0;
  editDeps.connection = scripted;
});
afterEach(async () => {
  const until = Date.now() + 15_000;
  while (liveEdits().length) {
    if (Date.now() > until) throw new Error("an edit is still running");
    await Bun.sleep(20);
  }
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Review admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Review owner");
const commenter = await createUser("Review commenter");
const reader = await createUser("Review reader");

async function newDatasource() {
  const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Review DS ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
  await syncSchema(created.body.datasource.id).catch(() => undefined);
  return created.body.datasource.id as string;
}
const datasourceId = await newDatasource();

async function seededReport(title: string, ds = datasourceId) {
  const report = await send(owner, "POST", "/reports", { title, datasourceId: ds });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(sampleSpec()), id);
  // As the boot backfill would record a spec saved before wave 48.
  backfillVersion(id);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}

/** A generation's save, as generate.ts makes it (the doc and model are wave 46's tests). */
async function generateNow(reportId: string) {
  const run = refresh.takeRunLock({ reportId, kind: "generate", trigger: "user", userId: owner.userId, queryKeys: null });
  const report = db.query("SELECT datasource_id FROM reports WHERE id = ?").get(reportId) as { datasource_id: string };
  const check = await validateSpec(datasourceRow(report.datasource_id), forValidation(sampleSpec()), { userId: owner.userId, runId: run.id });
  if (!check.ok) throw new Error(check.errors.join("; "));
  persistGenerated({ reportId, runId: run.id, docSnapshotId: null, docHash: null, spec: check.spec, results: check.results });
  return run.id;
}

async function waitFor<T>(read: () => T, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(15);
  }
}
const rowOf = (id: string) => db.query("SELECT status, error FROM report_instructions WHERE id = ?").get(id) as { status: string; error: string | null };
const waitStatus = (id: string, statuses: string[]) => waitFor(() => rowOf(id).status, (status) => statuses.includes(status));
const specJson = (reportId: string) => (db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json;
const specOf = (reportId: string) => JSON.parse(specJson(reportId)) as Json;
const tool = (name: string) => reportTools.find((item) => item.name === name)!;
const keyOf = (session: Session) => ({ keyId: `key-${session.userId.slice(0, 8)}`, userId: session.userId, name: "k", scopes: ["reports:read" as const, "reports:write" as const] });
async function ask(session: Session, reportId: string, text: string, blockId?: string) {
  const response = await send(session, "POST", `/reports/${reportId}/instructions`, { text, ...(blockId ? { blockId } : {}) });
  expect(response.status).toBe(201);
  return response.body.instruction.id as string;
}
async function patchDatasource(id: string, patch: Json) {
  const current = datasourceRow(id);
  const response = await send(admin, "PATCH", `/reports/admin/datasources/${id}`, { ...patch, expectedRevision: current.revision });
  expect(response.status).toBe(200);
}

const HIDDEN = ["<b>html</b>", "color: red", "formatterFn", "a private note"];

describe("H1: only validated specs are saved", () => {
  test("a patch with html, style, formatter, or note fields is refused every time; nothing of it is saved, shown, or prompted", async () => {
    const reportId = await seededReport("Hidden fields");
    provider.setScript(() => ({ toolCalls: [{ name: "submit_patch", arguments: { ops: [
      { op: "update_block", id: "country-bar", set: { html: HIDDEN[0], style: HIDDEN[1], formatter: HIDDEN[2], note: HIDDEN[3] } }
    ] } }] }));
    const id = await ask(owner, reportId, "make the chart fancy");
    await waitStatus(id, ["failed"]);
    const refusal = String(provider.calls[0]!.messages!.length ? provider.calls.at(-1)!.messages!.filter((turn) => turn.role === "tool").at(-1)!.content : "");
    expect(refusal).toMatch(/not part of the spec/);
    for (const text of HIDDEN) expect(specJson(reportId)).not.toContain(text);

    // A manual edit is refused the same way.
    const revision = (await send(owner, "GET", `/reports/${reportId}`)).body.report.revision as number;
    const manual = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "update_block", id: "intro", set: { note: HIDDEN[3] } }], expectedRevision: revision });
    expect(manual.status).toBe(400);
    for (const text of HIDDEN) expect(specJson(reportId)).not.toContain(text);

    // A spec saved before the schema was strict: its unknown fields never reach get_report or the edit prompt.
    const legacy = specOf(reportId);
    legacy.blocks[4] = { ...legacy.blocks[4], html: HIDDEN[0], note: HIDDEN[3] };
    db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(legacy), reportId);
    const shown = JSON.stringify(await tool("get_report").handler({ reportId }, keyOf(owner)));
    const block = JSON.stringify(await tool("get_report_block").handler({ reportId, blockId: "country-bar" }, keyOf(owner)));
    for (const text of HIDDEN) { expect(shown).not.toContain(text); expect(block).not.toContain(text); }
    provider.setScript(qaEditScript);
    provider.calls.length = 0;
    const next = await ask(owner, reportId, "retitle it", "country-bar");
    await waitStatus(next, ["proposed", "failed"]);
    const prompt = String(provider.calls[0]!.messages![0]!.content);
    for (const text of HIDDEN) expect(prompt).not.toContain(text);
    // The target block's rows are data inside <data> (review L1).
    expect(prompt).toContain("<data>\n[[");
    await send(owner, "POST", `/reports/${reportId}/instructions/${next}/reject`, {});
  });

  test("an applied patch saves the validated spec, with provenance put back by block id", async () => {
    const reportId = await seededReport("Validated");
    const id = await ask(owner, reportId, "add revenue by country");
    await waitStatus(id, ["proposed"]);
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {})).status).toBe(200);
    const spec = specOf(reportId);
    expect(spec.blocks.find((block: Json) => block.id === "intro").provenance).toEqual({ runId: null, version: 1 });
    expect(spec.blocks.find((block: Json) => block.id === "country_revenue").provenance.instructionId).toBe(id);
    expect(spec.queries.find((query: Json) => query.key === "daily").createdBy).toBe("user");
    expect(spec.queries.find((query: Json) => query.key === "revenue_by_country").createdBy).toBe("agent");
  });
});

describe("H2: Apply and restore re-check the data source", () => {
  test("after the allowlist narrows, Apply is 409 STALE_PROPOSAL (rejected, no stored rows published) and restore is 409 STALE_VERSION", async () => {
    const ds = await newDatasource();
    const reportId = await seededReport("Narrowed", ds);
    const id = await ask(owner, reportId, "add revenue by country");
    await waitStatus(id, ["proposed"]);
    const before = specJson(reportId);
    await patchDatasource(ds, { allowlist: ["analytics.signups"] });
    const proposal = await send(owner, "GET", `/reports/${reportId}/instructions/${id}/proposal`);
    expect(proposal.body.proposal.outOfDate).toBe(true);
    expect(JSON.stringify(proposal.body.proposal.results)).not.toContain("5120.5");
    const applied = await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {});
    expect([applied.status, applied.body.code]).toEqual([409, "STALE_PROPOSAL"]);
    expect(rowOf(id).status).toBe("rejected");
    expect(rowOf(id).error).toContain("data source changed");
    expect(specJson(reportId)).toBe(before);
    expect(db.query("SELECT COUNT(*) AS count FROM report_results WHERE report_id = ? AND query_key = 'revenue_by_country'").get(reportId)).toEqual({ count: 0 });

    // A version made before: its queries read analytics.orders, off the allowlist now.
    const revision = (await send(owner, "GET", `/reports/${reportId}`)).body.report.revision as number;
    await patchDatasource(ds, { allowlist: ["analytics"] });
    expect((await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "move_block", id: "recent-table", after: null }], expectedRevision: revision })).status).toBe(200);
    await patchDatasource(ds, { allowlist: ["analytics.signups"] });
    const restored = await send(owner, "POST", `/reports/${reportId}/versions/1/restore`, {});
    expect([restored.status, restored.body.code]).toEqual([409, "STALE_VERSION"]);
  });

  test("with the data source off, Apply is 409 STALE_PROPOSAL and restore is refused; a restore re-runs every restored query", async () => {
    const ds = await newDatasource();
    const reportId = await seededReport("Disabled", ds);
    const id = await ask(owner, reportId, "add revenue by country");
    await waitStatus(id, ["proposed"]);
    await patchDatasource(ds, { enabled: false });
    const applied = await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {});
    expect([applied.status, applied.body.code]).toEqual([409, "STALE_PROPOSAL"]);
    expect(rowOf(id).status).toBe("rejected");
    const versions = db.query("SELECT max(version) AS version FROM report_versions WHERE report_id = ?").get(reportId) as { version: number | null };
    const refused = await send(owner, "POST", `/reports/${reportId}/versions/${versions.version ?? 1}/restore`, {});
    expect(refused.status).toBe(409);
    await patchDatasource(ds, { enabled: true });

    // Restore re-runs: a new refresh of every query, never the old rows as the restored version's.
    const revision = (await send(owner, "GET", `/reports/${reportId}`)).body.report.revision as number;
    expect((await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "remove_block", id: "recent-table" }], expectedRevision: revision })).status).toBe(200);
    const restored = await send(owner, "POST", `/reports/${reportId}/versions/1/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.refreshRunId).toBeString();
    const run = await waitFor(() => refresh.runRow(restored.body.refreshRunId)!, (row) => row.status !== "running");
    expect(run.query_keys_json).toBeNull();
    expect((db.query("SELECT COUNT(*) AS count FROM report_results WHERE run_id = ?").get(run.id) as { count: number }).count).toBe(sampleSpec().queries.length);
  });
});

describe("M1: a commenter never sees the doc through the edit agent", () => {
  test("no live run or summary for a non-owner author, no auto-apply, and new markdown hidden until applied", async () => {
    const reportId = await seededReport("Commenter");
    await send(owner, "PUT", `/reports/${reportId}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: commenter.userId, level: "comment" }] });
    await send(owner, "PUT", `/reports/${reportId}/auto-apply`, { autoApply: true });
    provider.setScript(() => ({ toolCalls: [{ name: "submit_patch", arguments: { summary: "Quote the doc: SECRET-SUMMARY", ops: [{ op: "update_block", id: "intro", set: { markdown: "SECRET-DOC-TEXT from the metrics doc" } }] } }] }));
    const id = await ask(commenter, reportId, "explain net revenue in the intro");
    await waitStatus(id, ["proposed"]);
    const agentRun = (db.query("SELECT agent_run_id FROM report_instructions WHERE id = ?").get(id) as { agent_run_id: string }).agent_run_id;
    expect(db.query("SELECT user_id FROM agent_runs WHERE id = ?").get(agentRun)).toEqual({ user_id: owner.userId });
    expect((await send(commenter, "GET", `/runs/${agentRun}/events`)).status).toBe(404);
    const theirs = (await send(commenter, "GET", `/reports/${reportId}/instructions`)).body.instructions.find((item: Json) => item.id === id);
    expect(theirs).toMatchObject({ agentRunId: null, summary: null, status: "proposed" });
    const hidden = await send(commenter, "GET", `/reports/${reportId}/instructions/${id}/proposal`);
    expect(hidden.body.proposal.blocks[0]).toMatchObject({ blockId: "intro", change: "updated", textHidden: true });
    expect(JSON.stringify(hidden.body)).not.toContain("SECRET");
    const shown = await send(owner, "GET", `/reports/${reportId}/instructions/${id}/proposal`);
    expect(JSON.stringify(shown.body)).toContain("SECRET-DOC-TEXT");
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {})).status).toBe(200);
  });
});

describe("M2: generation records its version", () => {
  test("generate, apply, restore v1, regenerate: versions and block provenance agree", async () => {
    const report = await send(owner, "POST", "/reports", { title: "Generated", datasourceId });
    const reportId = report.body.report.id as string;
    const first = await generateNow(reportId);
    const versions = () => db.query("SELECT version, source, run_id FROM report_versions WHERE report_id = ? ORDER BY version").all(reportId) as Json[];
    expect(versions()).toEqual([{ version: 1, source: "generate", run_id: first }]);
    expect(specOf(reportId).blocks.every((block: Json) => block.provenance.version === 1)).toBe(true);
    const id = await ask(owner, reportId, "add revenue by country");
    await waitStatus(id, ["proposed"]);
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {})).body.instruction.appliedVersion).toBe(2);
    const restored = await send(owner, "POST", `/reports/${reportId}/versions/1/restore`, {});
    expect(restored.body.version).toBe(3);
    await waitFor(() => refresh.runningRun(reportId), (value) => value === null);
    const second = await generateNow(reportId);
    expect(versions().map((row) => [row.version, row.source])).toEqual([[1, "generate"], [2, "edit"], [3, "restore"], [4, "generate"]]);
    expect(versions().at(-1)!.run_id).toBe(second);
    expect(specOf(reportId).blocks.every((block: Json) => block.provenance.version === 4 && block.provenance.runId === second)).toBe(true);
    // Listing does not write versions any more; the list is what the writers recorded.
    expect((await send(owner, "GET", `/reports/${reportId}/versions`)).body.versions.map((item: Json) => item.version)).toEqual([4, 3, 2, 1]);
  });
});

describe("M3: proposals compare the spec, and stale ones never block the queue", () => {
  test("a rename keeps a proposal; a spec change rejects it with a reason and the next instruction runs", async () => {
    const reportId = await seededReport("Stale");
    const first = await ask(owner, reportId, "add revenue by country");
    await waitStatus(first, ["proposed"]);
    const detail = (await send(owner, "GET", `/reports/${reportId}`)).body.report;
    expect((await send(owner, "PATCH", `/reports/${reportId}`, { title: "Renamed", expectedRevision: detail.revision })).status).toBe(200);
    expect((await send(owner, "GET", `/reports/${reportId}/instructions/${first}/proposal`)).body.proposal.outOfDate).toBe(false);
    const second = await ask(owner, reportId, "retitle the intro");
    const revision = (await send(owner, "GET", `/reports/${reportId}`)).body.report.revision as number;
    expect((await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "move_block", id: "recent-table", after: null }], expectedRevision: revision })).status).toBe(200);
    const { sweepInstructions } = await import("../server/reports/instructions");
    sweepInstructions();
    expect(rowOf(first)).toEqual({ status: "rejected", error: "The report changed since this was proposed" });
    await waitStatus(second, ["proposed"]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${second}/reject`, {});
  });
});

describe("M4: report shares on the access pages and in group rules", () => {
  test("the member access page lists them, Reset removes them, group counts and the guest rule include them", async () => {
    const reportId = await seededReport("Access");
    const group = db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id").get(crypto.randomUUID(), `Review group ${crypto.randomUUID().slice(0, 6)}`, new Date().toISOString(), new Date().toISOString()) as { id: string };
    db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(group.id, commenter.userId, new Date().toISOString());
    expect(guestJoinRefused(group.id, [])).toBe(false);
    await send(owner, "PUT", `/reports/${reportId}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: reader.userId, level: "view" }, { kind: "group", id: group.id, level: "comment" }] });
    expect(listGroups().groups.find((item) => item.id === group.id)!.grantCount).toBe(1);
    const guest = await createUser("Review guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    const { readPolicies } = await import("../server/team/policies");
    if (!readPolicies().shareWithGuests) expect(guestJoinRefused(group.id, [guest.userId])).toBe(true);

    // An admin who cannot open the report sees it only as "Report owned by …" (D269).
    const asAdmin = accessSummary(admin.userId, reader.userId) as Json;
    expect(asAdmin.reports).toEqual([expect.objectContaining({ kind: "report", titleHidden: true, title: "Report owned by Review owner" })]);
    expect(JSON.stringify(asAdmin.reports)).not.toContain(reportId);
    const summary = accessSummary(reader.userId, reader.userId) as Json;
    expect(summary.reports.find((row: Json) => row.id === reportId)).toMatchObject({ kind: "report", level: "view", active: true, sources: [{ via: "direct", level: "view" }] });
    expect(summary.resetCounts.directShares).toBeGreaterThanOrEqual(1);
    const viaGroup = accessSummary(commenter.userId, commenter.userId) as Json;
    expect(viaGroup.reports.find((row: Json) => row.id === reportId).sources[0]).toMatchObject({ via: "group", level: "comment" });
    resetAccess(admin.userId, reader.userId);
    expect(db.query("SELECT COUNT(*) AS count FROM report_members WHERE user_id = ?").get(reader.userId)).toEqual({ count: 0 });
    expect((await send(reader, "GET", `/reports/${reportId}`)).status).toBe(404);
  });
});

describe("L2–L4", () => {
  test("readers see runs without the agent run or doc snapshot (L2)", async () => {
    const reportId = await seededReport("Readers");
    db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at) VALUES (?, ?, ?, 'Secret doc title', 'x', ?)").run(crypto.randomUUID(), reportId, "a".repeat(64), new Date().toISOString());
    const snapshot = (db.query("SELECT id FROM report_doc_snapshots WHERE report_id = ?").get(reportId) as { id: string }).id;
    const run = refresh.takeRunLock({ reportId, kind: "generate", trigger: "user", userId: owner.userId, queryKeys: null });
    db.query("UPDATE report_runs SET status = 'succeeded', finished_at = ?, lease_until = NULL, doc_snapshot_id = ?, agent_run_id = NULL WHERE id = ?").run(new Date().toISOString(), snapshot, run.id);
    await send(owner, "PUT", `/reports/${reportId}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: reader.userId, level: "view" }] });
    const ownerView = await send(owner, "GET", `/reports/${reportId}/provenance?runId=${run.id}`);
    expect(ownerView.body.snapshot.title).toBe("Secret doc title");
    const readerView = await send(reader, "GET", `/reports/${reportId}/provenance?runId=${run.id}&snapshotId=${snapshot}`);
    expect(readerView.body).toMatchObject({ snapshot: null, run: { id: run.id, docSnapshotId: null, agentRunId: null } });
    expect((await send(reader, "GET", `/reports/${reportId}/generation`)).body.run).toMatchObject({ docSnapshotId: null, agentRunId: null });
    expect((await send(reader, "GET", `/reports/${reportId}/runs`)).body.runs.every((item: Json) => item.docSnapshotId === null && item.agentRunId === null)).toBe(true);
    expect((await send(reader, "GET", `/reports/${reportId}/runs/${run.id}`)).body.run.docSnapshotId).toBeNull();
    expect(JSON.stringify((await send(reader, "GET", `/reports/${reportId}/provenance?runId=${run.id}`)).body)).not.toContain("Secret doc title");
  });

  test("a start that fails for another reason than the lock fails the instruction with a reason (L3)", async () => {
    const reportId = await seededReport("Start fails");
    editDeps.connection = () => ({ ...scripted(), model: null as unknown as string });
    const id = await ask(owner, reportId, "retitle the intro");
    expect(rowOf(id).status).toBe("failed");
    expect(rowOf(id).error).toBeString();
    expect(refresh.runningRun(reportId)).toBeNull();
  });

  test("moving a report to the Bin stops its running edit and cancels the queue (L4)", async () => {
    const reportId = await seededReport("Binned");
    const slow = startScriptedProvider(0, qaEditScript, { delayMs: 600 });
    editDeps.connection = () => ({ ...scripted(), baseUrl: slow.baseUrl });
    try {
      const running = await ask(owner, reportId, "retitle the intro");
      const queued = await ask(owner, reportId, "retitle again");
      expect(rowOf(running).status).toBe("running");
      expect((await send(owner, "DELETE", `/reports/${reportId}`)).status).toBe(200);
      expect(rowOf(queued).status).toBe("cancelled");
      await waitStatus(running, ["cancelled", "failed"]);
      await waitFor(() => liveEdits().length, (count) => count === 0);
    } finally {
      slow.stop();
    }
  });
});
