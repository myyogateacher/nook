import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeAnswer } from "./support/fakeClickhouse";
import { sampleAnswer } from "./support/reportSeed";
import { retireUsersAfterFile } from "./support/retireUsers";
import { qaEditScript, startScriptedProvider } from "../scripts/fakeReportProvider";
import type { ReportSpec } from "../shared/reports";
import { DEFAULT_COMPAT } from "../shared/agents";

const { editDeps, editPrompt, EDIT_TOOLS, liveEdits } = await import("../server/reports/edit");
const { applyPatch, changedBlockIds, diffSpecs, parsePatch, PATCH_JSON_SCHEMA } = await import("../server/reports/patch");
const { reportModelFor } = await import("../server/reports/model");
const { reportTools } = await import("../server/reports/mcpTools");
const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");

/**
 * Waves 48 and 48b together (the reports integration): the edit agent runs on the report's model
 * (`reportModelFor`), speaks spec v2 (its prompt and `submit_patch`'s schema, section ops), checks
 * design rules only on the blocks it touches (so an old v1 report can still be edited), and every
 * spec it reads or writes is v2 (patches, versions, manual edits, MCP).
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0);
const provider = startScriptedProvider(0, qaEditScript);

afterAll(() => {
  fake.stop();
  provider.stop();
});
beforeEach(() => {
  fake.state.select = (sql) => sampleAnswer(sql) as FakeAnswer;
  provider.setScript(qaEditScript);
  provider.calls.length = 0;
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

const admin = await createUser("Integration admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Integration owner");

const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Integration warehouse ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

/**
 * A v1 spec as waves 45–47 stored it: no specVersion, no sections, v1 formats; `untitled` has neither
 * a title nor a format, which the design rules refuse on a block an edit adds or changes.
 */
const v1Spec = () => ({
  version: 1,
  queries: [
    { key: "daily", sql: "SELECT day, sum(revenue) AS revenue, sum(refunds) AS refunds FROM analytics.orders GROUP BY day ORDER BY day", purpose: "Revenue per day", createdBy: "user" },
    { key: "by_country", sql: "SELECT country, sum(revenue) AS revenue FROM analytics.orders GROUP BY country ORDER BY revenue DESC LIMIT 8", purpose: "Top countries", createdBy: "user" }
  ],
  blocks: [
    { id: "intro", type: "markdown", markdown: "Revenue, net of refunds.", provenance: { runId: null, version: 1 } },
    { id: "untitled", type: "chart", queryKey: "daily", kind: "line", x: "day", y: ["revenue"], provenance: { runId: null, version: 1 } },
    { id: "country-bar", type: "chart", title: "Top countries", queryKey: "by_country", kind: "bar", x: "country", y: ["revenue"], format: "currency", provenance: { runId: null, version: 1 } }
  ]
});

async function v1Report(title: string) {
  const report = await send(owner, "POST", "/reports", { title, datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(v1Spec()), id);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
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
const instruction = (id: string) => db.query("SELECT status, error FROM report_instructions WHERE id = ?").get(id) as { status: string; error: string | null };
const waitStatus = (id: string, statuses: string[]) => waitFor(() => instruction(id).status, (status) => statuses.includes(status));
const specOf = (reportId: string) => JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as Json;

async function settings(patch: Json) {
  const current = (await send(admin, "GET", "/agents/admin/settings")).body.settings;
  const saved = await send(admin, "PUT", "/agents/admin/settings", { ...patch, expectedRevision: current.revision });
  expect(saved.status).toBe(200);
  return current as Json;
}

describe("the edit agent's model", () => {
  test("an edit runs on the report's model (the admin's report model here: GLM-5.3 on its provider)", async () => {
    const added = await send(admin, "POST", "/agents/admin/providers", { name: `Report model ${crypto.randomUUID().slice(0, 6)}`, baseUrl: provider.baseUrl, apiKey: "sk-test-not-real", defaultModel: "chat-model" });
    expect(added.status).toBe(201);
    const providerId = added.body.provider.id as string;
    const before = await settings({ reportProviderId: providerId, reportModel: "glm-5.3" });
    try {
      const reportId = await v1Report("Model");
      // The test hook's default is the real resolution.
      expect(editDeps.connection(reportId)).toMatchObject({ id: providerId, model: "glm-5.3" });
      expect(reportModelFor(reportId)).toMatchObject({ id: providerId, model: "glm-5.3" });
      const asked = await send(owner, "POST", `/reports/${reportId}/instructions`, { text: "make it a stacked bar", blockId: "country-bar" });
      expect(asked.status).toBe(201);
      const id = asked.body.instruction.id as string;
      await waitStatus(id, ["proposed", "failed"]);
      expect(instruction(id)).toMatchObject({ status: "proposed" });
      expect(provider.calls.length).toBeGreaterThan(0);
      expect(provider.calls.every((call) => call.model === "glm-5.3")).toBe(true);
      const run = db.query("SELECT r.provider_id, r.model FROM agent_runs r JOIN report_instructions i ON i.agent_run_id = r.id WHERE i.id = ?").get(id) as Json;
      expect(run).toEqual({ provider_id: providerId, model: "glm-5.3" });
      await send(owner, "POST", `/reports/${reportId}/instructions/${id}/reject`, {});
    } finally {
      await settings({ reportProviderId: before.reportProviderId ?? null, reportModel: before.reportModel ?? null });
      db.query("DELETE FROM agent_providers WHERE id = ?").run(providerId);
    }
  });
});

describe("spec v2 in the edit agent", () => {
  test("the prompt and submit_patch's schema speak v2: intent, width, section, formats, unit, compareLabel, titles, no colours", () => {
    const tool = EDIT_TOOLS.find((item) => item.name === "submit_patch")!;
    expect(tool.parameters).toBe(PATCH_JSON_SCHEMA);
    const ops = ((PATCH_JSON_SCHEMA.properties as Json).ops.items.anyOf as Json[]);
    const add = ops.find((op) => op.properties.op.const === "add_block")!;
    const chart = (add.properties.block.anyOf as Json[]).find((item) => item.properties.type.const === "chart")!;
    expect(chart.additionalProperties).toBe(false);
    expect(chart.required).toEqual(expect.arrayContaining(["title", "intent"]));
    expect(Object.keys(chart.properties)).toEqual(expect.arrayContaining(["intent", "width", "section", "format", "unit", "emphasis"]));
    expect(chart.properties.format.pattern).toContain("currency:");
    const kpi = (add.properties.block.anyOf as Json[]).find((item) => item.properties.type.const === "kpi")!;
    expect(Object.keys(kpi.properties)).toEqual(expect.arrayContaining(["compareLabel", "compareTo", "unit", "hero", "sparkline"]));
    const set = ops.find((op) => op.properties.op.const === "update_block")!.properties.set;
    expect(set.additionalProperties).toBe(false);
    expect(Object.keys(set.properties)).toEqual(expect.arrayContaining(["intent", "width", "section", "format", "unit", "compareLabel", "kind"]));
    expect(set.properties.style).toBeUndefined();
    expect(ops.map((op) => op.properties.op.const)).toEqual(expect.arrayContaining(["add_section", "update_section", "remove_section"]));
    expect(ops.find((op) => op.properties.op.const === "move_block")!.properties.section).toBeDefined();

    const row = db.query("SELECT * FROM report_datasources WHERE id = ?").get(datasourceId) as Json;
    const prompt = editPrompt({ datasource: row as never, report: { id: "r" } as never, spec: { version: 1, specVersion: 2, sections: [{ id: "trend", title: "Over time" }], queries: [], blocks: [] }, blockId: null, doc: null });
    for (const word of ["intent", "width", "section", "currency:<ISO 4217 code>", "unit", "compareLabel", "needs a short title", "Never send colours", "add_section", "update_section", "remove_section", "move_block {id, after, section?}"]) expect(prompt).toContain(word);
    expect(prompt).toContain("\"sections\": [");
  });

  test("section ops: add, update, remove (its blocks stay), and move_block into a section", () => {
    const spec: ReportSpec = { version: 1, specVersion: 2, sections: [], queries: [], blocks: [{ id: "a", type: "markdown", markdown: "x" }, { id: "b", type: "markdown", markdown: "y" }] };
    const parsed = parsePatch({ ops: [
      { op: "add_section", section: { id: "mix", title: "Mix" } },
      { op: "add_section", section: { id: "trend", title: "Trend", summary: "s" }, after: null },
      { op: "update_section", id: "mix", set: { title: "Where orders come from", summary: "by country" } },
      { op: "move_block", id: "a", after: "b", section: "mix" }
    ] });
    expect(parsed.ok).toBe(true);
    const applied = applyPatch(spec, (parsed as { ok: true; patch: never }).patch, "agent");
    expect(applied.ok).toBe(true);
    const next = (applied as { ok: true; spec: ReportSpec }).spec;
    expect(next.sections).toEqual([{ id: "trend", title: "Trend", summary: "s" }, { id: "mix", title: "Where orders come from", summary: "by country" }]);
    expect(next.blocks.map((block) => [block.id, block.section ?? null])).toEqual([["b", null], ["a", "mix"]]);
    expect(changedBlockIds(diffSpecs(spec, next))).toEqual(["a"]);

    const removed = applyPatch(next, { ops: [{ op: "remove_section", id: "mix" }, { op: "update_section", id: "trend", set: { summary: null } }] }, "agent") as { ok: true; spec: ReportSpec };
    expect(removed.spec.sections).toEqual([{ id: "trend", title: "Trend" }]);
    expect(removed.spec.blocks.every((block) => block.section === undefined)).toBe(true);
    expect(applyPatch(spec, { ops: [{ op: "move_block", id: "a", after: null, section: "nope" }] }, "agent")).toEqual({ ok: false, errors: ["op 1 (move_block): no section with id nope; add_section first"] });
    expect(applyPatch(next, { ops: [{ op: "add_section", section: { id: "mix", title: "Again" } }] }, "agent").ok).toBe(false);
    expect(parsePatch({ ops: [{ op: "update_section", id: "mix", set: { colour: "red" } }] }).ok).toBe(true);
  });
});

describe("editing an old (v1) report", () => {
  const original = editDeps.connection;
  beforeEach(() => { editDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT }); });
  afterAll(() => { editDeps.connection = original; });

  test("design rules apply to the touched block only: the edit succeeds, Apply saves spec v2, untouched v1 blocks keep their legacy marker", async () => {
    const reportId = await v1Report("Old v1");
    const asked = await send(owner, "POST", `/reports/${reportId}/instructions`, { text: "make it a stacked bar", blockId: "country-bar" });
    const id = asked.body.instruction.id as string;
    await waitStatus(id, ["proposed", "failed"]);
    expect(instruction(id)).toMatchObject({ status: "proposed", error: null });
    // The prompt showed the upgraded spec without Nook's own fields.
    const system = String(provider.calls[0]!.messages![0]!.content);
    expect(system).toContain("\"sections\": []");
    expect(system).not.toContain("\"legacy\"");
    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${id}/proposal`)).body.proposal as Json;
    expect(proposal.blocks.map((change: Json) => [change.blockId, change.change])).toEqual([["country-bar", "updated"]]);
    expect(proposal.spec.specVersion).toBe(2);

    const applied = await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {});
    expect(applied.status).toBe(200);
    const saved = specOf(reportId);
    expect(saved).toMatchObject({ version: 1, specVersion: 2, sections: [] });
    const byId = new Map((saved.blocks as Json[]).map((block) => [block.id, block]));
    expect(byId.get("country-bar")).toMatchObject({ kind: "stacked_bar", title: "Top countries" });
    expect(byId.get("country-bar")!.legacy).toBeUndefined();
    expect(byId.get("untitled")).toMatchObject({ legacy: true, intent: "trend", width: "half" });
    expect(byId.get("untitled")!.title).toBeUndefined();
    const version = db.query("SELECT spec_json FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT 1").get(reportId) as { spec_json: string };
    expect(JSON.parse(version.spec_json).specVersion).toBe(2);

    // Versions read back as v2 (the backfilled v1 version too).
    const versions = (await send(owner, "GET", `/reports/${reportId}/versions`)).body.versions as Json[];
    const first = versions.at(-1)!;
    const old = (await send(owner, "GET", `/reports/${reportId}/versions/${first.version}`)).body.spec as Json;
    expect(old).toMatchObject({ specVersion: 2, sections: [] });
  });

  test("a manual edit adds a section and moves a v1 block into it; a changed block that breaks a rule is refused", async () => {
    const reportId = await v1Report("Manual v1");
    const revision = (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision;
    const moved = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: revision, ops: [
      { op: "add_section", section: { id: "mix", title: "Where revenue comes from" } },
      { op: "move_block", id: "country-bar", after: "untitled", section: "mix" }
    ] });
    expect(moved.status).toBe(200);
    const saved = specOf(reportId);
    expect(saved.sections).toEqual([{ id: "mix", title: "Where revenue comes from" }]);
    expect((saved.blocks as Json[]).find((block) => block.id === "country-bar")!.section).toBe("mix");

    // New SQL on the untitled v1 chart makes it a changed block: rule 8 (a title, a format) now applies to it.
    const next = (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision;
    const refused = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: next, ops: [
      { op: "update_query", key: "daily", sql: "SELECT day, sum(revenue) AS revenue, sum(refunds) AS refunds FROM analytics.orders WHERE revenue > 0 GROUP BY day ORDER BY day" }
    ] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("rule 8");
    const fixed = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: next, ops: [
      { op: "update_query", key: "daily", sql: "SELECT day, sum(revenue) AS revenue, sum(refunds) AS refunds FROM analytics.orders WHERE revenue > 0 GROUP BY day ORDER BY day" },
      { op: "update_block", id: "untitled", set: { title: "Revenue per day", format: "currency:USD" } }
    ] });
    expect(fixed.status).toBe(200);
  });

  test("MCP get_report and get_report_block answer spec v2 shapes for a v1 report", async () => {
    const reportId = await v1Report("Mcp v1");
    const key = { keyId: `key-${owner.userId.slice(0, 8)}`, userId: owner.userId, name: "k", scopes: ["reports:read" as const] };
    const tool = (name: string) => reportTools.find((item) => item.name === name)!;
    const report = await tool("get_report").handler({ reportId }, key) as Json;
    expect(report).toMatchObject({ specVersion: 2, sections: [] });
    const block = await tool("get_report_block").handler({ reportId, blockId: "country-bar" }, key) as Json;
    expect(block.block).toMatchObject({ id: "country-bar", intent: "compare", width: "half" });
  });
});

describe("final review L3 and M3", () => {
  test("L3: changing a report's data source is refused while a run holds the report; the title alone is not", async () => {
    const reportId = await v1Report("Datasource while running");
    const other = await send(admin, "POST", "/reports/admin/datasources", { name: `Integration other ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
    const revision = () => (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision;
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, lease_until, started_at) VALUES (?, ?, 'refresh', 'user', 'running', ?, ?)")
      .run(`l3-${reportId}`, reportId, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    try {
      const refused = await send(owner, "PATCH", `/reports/${reportId}`, { datasourceId: other.body.datasource.id, expectedRevision: revision() });
      expect([refused.status, refused.body.code]).toEqual([409, "RUN_IN_PROGRESS"]);
      expect((db.query("SELECT datasource_id FROM reports WHERE id = ?").get(reportId) as { datasource_id: string }).datasource_id).toBe(datasourceId);
      const renamed = await send(owner, "PATCH", `/reports/${reportId}`, { title: "Renamed while running", expectedRevision: revision() });
      expect(renamed.status).toBe(200);
    } finally {
      db.query("DELETE FROM report_runs WHERE id = ?").run(`l3-${reportId}`);
    }
    const moved = await send(owner, "PATCH", `/reports/${reportId}`, { datasourceId: other.body.datasource.id, expectedRevision: revision() });
    expect(moved.status).toBe(200);
  });

  test("M3: docs/OPERATIONS.md has the 0.38.0 reports upgrade section: 050–059, backup, disk, and the foreign-key refusal", async () => {
    const text = await Bun.file(new URL("../docs/OPERATIONS.md", import.meta.url)).text();
    const start = text.indexOf("### Upgrading to 0.38.0 (analytics reports, migrations 050–053 and 055–059)");
    expect(start).toBeGreaterThan(0);
    const section = text.slice(start, text.indexOf("\n**Upgrading to 0.37.0", start));
    for (const word of ["**050**", "api_key_grants", "**051**", "2× the size", "slow first boot", "**052**", "**053**", "**055**", "**056**", "**057**", "**058**", "**059**", "fallback model", "agent_settings", "APP_VERSION=0.38.0", "AGENT_ALLOWED_PRIVATE_HOSTS", "LOG_LEVEL", "Back up first", "./scripts/backup.sh --force", "Check free disk", "PRAGMA foreign_key_check", "If a migration refuses"]) expect([word, section.includes(word)]).toEqual([word, true]);
    // The refusals it quotes are the migrations' own.
    const m051 = await Bun.file(new URL("../server/migrations/051_report_runs_via.ts", import.meta.url)).text();
    const m053 = await Bun.file(new URL("../server/migrations/053_report_model.ts", import.meta.url)).text();
    expect(m051).toContain("Migration 051 cannot rebuild ${name}");
    expect(m053).toContain("Migration 053 cannot rebuild agent_settings");
    const m057 = await Bun.file(new URL("../server/migrations/057_agent_internal_keys.ts", import.meta.url)).text();
    expect(m057).toContain("Migration 057 cannot rebuild agent_settings");
    expect(section).toContain("Migration 053 cannot rebuild agent_settings");
    expect(section).toContain("Migration 057 cannot rebuild agent_settings");
    const m058 = await Bun.file(new URL("../server/migrations/058_report_metric_catalog.ts", import.meta.url)).text();
    expect(m058).toContain("Migration 058 cannot rebuild agent_settings");
    expect(section).toContain("Migration 058 cannot rebuild agent_settings");
    expect(section).toContain("PRAGMA foreign_key_check");
    // The release it names is this one.
    expect(section).not.toMatch(/\b0\.39\.\d/);
    const { registeredMigrationIds } = await import("../server/migrations");
    expect(registeredMigrationIds.filter((id) => id >= 50)).toEqual([50, 51, 52, 53, 55, 56, 57, 58, 59]);
  });
});
