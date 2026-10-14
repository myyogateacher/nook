import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startScriptedProvider, type Script } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import { loadCases } from "../evals/reports/load";
import { startReplayer } from "../evals/reports/replay";
import { runCase, type EvalHost } from "../evals/reports/run";
import { specScript } from "../evals/reports/script";
import type { LoadedCase } from "../evals/reports/types";

const { generateDeps } = await import("../server/reports/generate");
const { reportFallbackFor } = await import("../server/reports/model");

/**
 * E5: the "Fallback model for reports". A primary model that uses up its three submit tries hands the
 * run to the fallback once; the saved blocks record the fallback's model, the run log says why, and
 * the run shows the model that ran last. Off (the default), the run fails as before. The admin setting
 * round-trips through Settings → AI and resolves to a connection (not when it is the primary itself).
 * The run goes through the eval harness (the fanout_items case, replayed from its recorded answers).
 */

retireUsersAfterFile();

const primary = startScriptedProvider(0);
const backup = startScriptedProvider(0);
const primaryConnection = { id: "scripted-primary", baseUrl: primary.baseUrl, apiKey: null, model: "primary-model", compat: DEFAULT_COMPAT };
const backupConnection = { id: "scripted-backup", baseUrl: backup.baseUrl, apiKey: null, model: "fallback-model", compat: DEFAULT_COMPAT };
const original = generateDeps.fallback;
let admin: Session;
let host: EvalHost;
let testCase: LoadedCase;

/** Submits a spec whose block names a query that does not exist, every time (three refusals). */
const broken: Script = () => ({ toolCalls: [{ name: "submit_report", arguments: { title: "Broken", queries: [], blocks: [{ id: "k", type: "kpi", title: "K", intent: "headline", queryKey: "missing", column: "x", format: "number" }] } }] });

async function send(method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, admin);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  admin = await createUser("Fallback admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  host = { origin, db, send };
  testCase = (await loadCases(["fanout_items"]))[0]!;
});
afterAll(() => {
  generateDeps.fallback = original;
  primary.stop();
  backup.stop();
});

describe("the fallback model for reports", () => {
  test("a primary that uses up its tries hands the run to the fallback once; blocks and the run record the fallback's model", async () => {
    const replay = startReplayer(testCase.fixtures!.answers);
    try {
      primary.setScript(broken);
      backup.setScript(specScript(testCase.golden, testCase.catalog ?? []));
      generateDeps.fallback = () => backupConnection;
      const result = await runCase(host, testCase, { variant: "model", clickhouse: `http://nook:x@${new URL(replay.url).host}`, connection: primaryConnection, timeoutMs: 30_000 });
      expect({ error: result.error, passed: result.passed, of: result.facts.length }).toEqual({ error: null, passed: 4, of: 4 });
      const spec = JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(result.reportId) as { spec_json: string }).spec_json) as { blocks: Array<{ provenance: { model?: string } }> };
      expect(new Set(spec.blocks.map((block) => block.provenance.model))).toEqual(new Set(["fallback-model"]));
      const note = db.query("SELECT text FROM agent_audit_steps WHERE run_id = ? AND text LIKE '[Nook retried on the fallback model%'").get(result.agentRunId) as { text: string };
      expect(note.text).toStartWith("[Nook retried on the fallback model fallback-model: primary-model ended without a saved report (The model's report did not pass the checks:");
      expect(db.query("SELECT model, provider_id FROM agent_runs WHERE id = ?").get(result.agentRunId)).toEqual({ model: "fallback-model", provider_id: "scripted-backup" });
      expect(db.query("SELECT count(*) AS n FROM audit_log WHERE event_type = 'reports.generate.fallback' AND metadata_json LIKE ?").get(`%${result.runId}%`)).toEqual({ n: 1 });
      // The primary's three refusals, then the fallback's accepted submit.
      const submits = (db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.generate.submit' AND metadata_json LIKE ? ORDER BY created_at, rowid").all(`%"runId":"${result.runId}"%`) as Array<{ metadata_json: string }>).map((row) => JSON.parse(row.metadata_json).ok);
      expect(submits).toEqual([false, false, false, true]);
    } finally {
      replay.stop();
    }
  }, 60_000);

  test("off, the run fails as before (no second attempt)", async () => {
    const replay = startReplayer(testCase.fixtures!.answers);
    try {
      primary.setScript(broken);
      backup.calls.length = 0;
      generateDeps.fallback = () => null;
      const result = await runCase(host, testCase, { variant: "model", clickhouse: `http://nook:x@${new URL(replay.url).host}`, connection: primaryConnection, timeoutMs: 30_000 });
      expect(result.runStatus).toBe("failed");
      expect(backup.calls.length).toBe(0);
      expect(db.query("SELECT count(*) AS n FROM agent_audit_steps WHERE run_id = ? AND text LIKE '[Nook retried%'").get(result.agentRunId)).toEqual({ n: 0 });
    } finally {
      replay.stop();
    }
  }, 60_000);

  test("Settings → AI stores it (off by default); it resolves to a connection unless it is the primary itself", async () => {
    generateDeps.fallback = original;
    const provider = await send("POST", "/agents/admin/providers", { name: `Fallback ${crypto.randomUUID().slice(0, 6)}`, baseUrl: backup.baseUrl, defaultModel: "fallback-default" });
    expect(provider.status).toBe(201);
    const providerId = provider.body.provider.id as string;
    const before = (await send("GET", "/agents/admin/settings")).body.settings;
    expect(before).toMatchObject({ reportFallbackProviderId: null, reportFallbackModel: null });
    expect(reportFallbackFor(primaryConnection)).toBeNull();
    const saved = await send("PUT", "/agents/admin/settings", { reportFallbackProviderId: providerId, reportFallbackModel: "glm-backup", expectedRevision: before.revision });
    expect(saved.body.settings).toMatchObject({ reportFallbackProviderId: providerId, reportFallbackModel: "glm-backup" });
    expect(reportFallbackFor(primaryConnection)).toMatchObject({ id: providerId, model: "glm-backup" });
    expect(reportFallbackFor({ id: providerId, model: "glm-backup" })).toBeNull();
    expect((await send("PUT", "/agents/admin/settings", { reportFallbackProviderId: crypto.randomUUID(), expectedRevision: saved.body.settings.revision })).status).toBe(404);
    const off = await send("PUT", "/agents/admin/settings", { reportFallbackProviderId: null, reportFallbackModel: null, expectedRevision: saved.body.settings.revision });
    expect(off.body.settings.reportFallbackProviderId).toBeNull();
    expect(reportFallbackFor(primaryConnection)).toBeNull();
    // Leave no provider behind: other files read the provider list and the default.
    expect((await send("DELETE", `/agents/admin/providers/${providerId}`)).status).toBe(200);
  });
});
