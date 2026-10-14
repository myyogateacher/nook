import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startScriptedProvider } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import { loadCases, linkDoc } from "../evals/reports/load";
import { compareReports, formatReport, scoreFacts, totalsOf } from "../evals/reports/score";
import { startReplayer } from "../evals/reports/replay";
import { parseChUrl, seed, seedStatements } from "../evals/reports/clickhouse";
import { runCase, type EvalHost } from "../evals/reports/run";
import type { CaseResult, EvalReport, LoadedCase } from "../evals/reports/types";

/**
 * The report generation eval (E1): scoring is pure and tested on its own; the deterministic subset
 * (cases marked `ci`) runs the golden and trap specs through the real generation path with the
 * scripted provider and the recorded ClickHouse answers (evals/reports/cases/<id>/fixtures.json),
 * so a golden report must pass every fact and a trap must fail the facts it names. With
 * CLICKHOUSE_TEST_URL set, every case is seeded into the real ClickHouse and run the same way.
 */

retireUsersAfterFile();

const provider = startScriptedProvider(0);
const connection = { id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-eval", compat: DEFAULT_COMPAT };
let admin: Session;
let host: EvalHost;
let cases: LoadedCase[] = [];

beforeAll(async () => {
  admin = await createUser("Report eval");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  host = {
    origin, db,
    send: async (method, path, body) => {
      const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, admin);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    }
  };
  cases = await loadCases();
});
afterAll(() => provider.stop());

describe("report eval scoring", () => {
  const blocks = [
    { id: "a", type: "kpi", queryKey: "t", column: "rate", format: "percent" },
    { id: "b", type: "kpi", queryKey: "t", column: "share", unit: "%" },
    { id: "c", type: "chart", queryKey: "r", kind: "bar", x: "route", y: ["served"], format: "number" }
  ];
  const results = [
    { queryKey: "t", columns: [{ name: "rate", type: "Float64" }, { name: "share", type: "Float64" }, { name: "revenue", type: "Decimal(12, 2)" }], rows: [[0.16, 25, "1000.50"]] },
    { queryKey: "r", columns: [{ name: "route", type: "String" }, { name: "served", type: "UInt64" }], rows: [["search", "40"], ["digest", "55"], ["notes", "12"]] }
  ];

  test("numbers match within tolerance, percent facts by the block's format, rows by their text, and top by a drawn measure", () => {
    const scored = scoreFacts([
      { id: "revenue", label: "Revenue", kind: "number", value: 1001 },
      { id: "revenue_exact", label: "Revenue exact", kind: "number", value: 1001, tolerance: 0 },
      { id: "rate", label: "Rate as a ratio with format percent", kind: "number", value: 0.16, percent: true },
      { id: "share", label: "Share ×100 with unit %", kind: "number", value: 0.25, percent: true },
      { id: "digest", label: "Digest served", kind: "number", value: 55, tolerance: 0, row: "digest" },
      { id: "search55", label: "55 in the search row", kind: "number", value: 55, tolerance: 0, row: "search" },
      { id: "top", label: "Top route", kind: "top", value: "digest" },
      { id: "top_wrong", label: "Top route wrong", kind: "top", value: "search" }
    ], blocks, results);
    expect(scored.map((fact) => [fact.id, fact.pass])).toEqual([["revenue", true], ["revenue_exact", false], ["rate", true], ["share", true], ["digest", true], ["search55", false], ["top", true], ["top_wrong", false]]);
    expect(scored[0]!.found).toBe("t.revenue = 1000.5");
    expect(scored[1]!.found).toBe("t.revenue = 1000.5");
  });

  test("a ratio shown with the wrong format fails (percent stored as 0–1 multiplied twice)", () => {
    const wrong = scoreFacts([{ id: "share", label: "Share", kind: "number", value: 0.25, percent: true }], [{ id: "a", type: "kpi", queryKey: "t", column: "share", format: "percent" }],
      [{ queryKey: "t", columns: [{ name: "share", type: "Float64" }], rows: [[25]] }]);
    expect(wrong[0]).toMatchObject({ pass: false, found: "t.share = 25 shown with format percent" });
  });

  test("the seed splitter, the doc links, and the compare report", () => {
    expect(seedStatements("-- note\nDROP DATABASE IF EXISTS x;\nCREATE TABLE x.t (a UInt8) ENGINE = Memory;\nINSERT INTO x.t VALUES (1);\n")).toEqual(["DROP DATABASE IF EXISTS x", "CREATE TABLE x.t (a UInt8) ENGINE = Memory", "INSERT INTO x.t VALUES (1)"]);
    expect(linkDoc("See [the page]({{link:metrics}}) and {{link:other}}.", { metrics: "http://n/notes/1" })).toBe("See [the page](http://n/notes/1) and {{link:other}}.");
    expect(parseChUrl("http://nook:pw%40x@127.0.0.1:22200")).toEqual({ base: "http://127.0.0.1:22200/", user: process.env.CLICKHOUSE_TEST_USER ?? "nook", password: process.env.CLICKHOUSE_TEST_PASSWORD ?? "pw@x" });
    const result = (passed: number, extra: Partial<CaseResult> = {}): CaseResult => ({
      id: "c", variant: "model", ok: passed === 2, error: null, reportId: "r", runId: "run", agentRunId: "a", runStatus: "succeeded", passed, model: "m",
      facts: [{ id: "x", label: "X", expected: "1", pass: true, found: "q.x = 1" }, { id: "y", label: "Y", expected: "2", pass: passed === 2, found: null }],
      firstSubmitPass: true, submits: 1, retries: 0, nudges: 0, sanityHints: 0, toolCalls: 9, promptTokens: 100, completionTokens: 10, wallMs: 2000, ...extra
    });
    const report = (cases: CaseResult[]): EvalReport => ({ startedAt: "s", finishedAt: "f", provider: { kind: "openai-compatible", model: "m", baseUrl: null }, clickhouse: "real", dataDir: null, origin: null, cases, totals: totalsOf(cases) });
    const a = report([result(1)]);
    const b = report([result(2, { retries: 1, toolCalls: 12 })]);
    expect(compareReports(a, b)).toContain("fixed y; facts 1→2; retries 0→1; tools 9→12");
    expect(formatReport(a)).toContain("✗ Y: expected 2, found nothing close");
  });

  test("every case has a doc, a seed for its own eval_<id> database, facts, and a golden spec; 8–12 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(cases.length).toBeLessThanOrEqual(12);
    for (const testCase of cases) {
      expect(testCase.seed).toContain(`DROP DATABASE IF EXISTS eval_${testCase.id};`);
      expect(seedStatements(testCase.seed).every((statement) => !/\b(?:DROP|CREATE)\s+DATABASE\b/i.test(statement) || statement.includes(`eval_${testCase.id}`))).toBe(true);
      expect(testCase.facts.length).toBeGreaterThan(0);
      if (testCase.trap) for (const id of testCase.trap.fails) expect(testCase.facts.map((fact) => fact.id)).toContain(id);
    }
    expect(cases.filter((testCase) => testCase.ci).every((testCase) => testCase.fixtures !== null)).toBe(true);
    expect(cases.some((testCase) => Object.keys(testCase.linked).length > 0)).toBe(true);
  });
});

async function runBoth(testCase: LoadedCase, clickhouse: string) {
  const datasources = new Map<string, string>();
  const golden = await runCase(host, testCase, { variant: "golden", clickhouse, connection, scripted: provider, datasources, timeoutMs: 30_000 });
  const trap = testCase.trap ? await runCase(host, testCase, { variant: "trap", clickhouse, connection, scripted: provider, datasources, timeoutMs: 30_000 }) : null;
  return { golden, trap };
}

function expectScored(testCase: LoadedCase, golden: CaseResult, trap: CaseResult | null) {
  expect({ id: testCase.id, error: golden.error, failing: golden.facts.filter((fact) => !fact.pass) }).toEqual({ id: testCase.id, error: null, failing: [] });
  expect(golden.firstSubmitPass).toBe(true);
  expect(golden.toolCalls).toBeGreaterThan(0);
  // E4: a case with a catalog has it stored with the report (extracted once for the doc snapshot).
  if (testCase.catalog) {
    const stored = db.query("SELECT source, metrics_json FROM report_metric_catalogs WHERE report_id = ? ORDER BY version DESC LIMIT 1").get(golden.reportId) as { source: string; metrics_json: string };
    expect({ source: stored.source, metrics: (JSON.parse(stored.metrics_json) as Array<{ id: string; problems: string[] }>).map((metric) => [metric.id, metric.problems]) }).toEqual({ source: "extract", metrics: testCase.catalog.map((metric) => [metric.id, []]) });
  }
  // E2: a golden report never trips a sanity check; a trap that one catches is refused once first.
  expect({ id: testCase.id, hints: golden.sanityHints }).toEqual({ id: testCase.id, hints: 0 });
  if (trap && testCase.trap?.sanity) {
    expect({ id: testCase.id, firstSubmitPass: trap.firstSubmitPass, hinted: trap.sanityHints > 0, retries: trap.retries }).toEqual({ id: testCase.id, firstSubmitPass: false, hinted: true, retries: 1 });
    const text = (db.query("SELECT group_concat(result_text, ' ') AS text FROM agent_audit_steps WHERE run_id = ? AND tool_name = 'submit_report' AND ok = 0").get(trap.agentRunId) as { text: string }).text;
    for (const kind of testCase.trap.sanity) expect(text).toContain(`sanity ${kind}:`);
  }
  if (trap && testCase.trap) {
    expect(trap.runStatus).toBe("succeeded");
    const failed = trap.facts.filter((fact) => !fact.pass).map((fact) => fact.id);
    for (const id of testCase.trap.fails) expect({ id: testCase.id, fact: id, failed: failed.includes(id) }).toEqual({ id: testCase.id, fact: id, failed: true });
  }
}

describe("report eval: deterministic subset (recorded ClickHouse answers)", () => {
  test("golden reports pass every fact and traps fail theirs, through the real generation path", async () => {
    const subset = cases.filter((testCase) => testCase.ci);
    expect(subset.length).toBeGreaterThanOrEqual(4);
    for (const testCase of subset) {
      const replay = startReplayer(testCase.fixtures!.answers);
      try {
        const { golden, trap } = await runBoth(testCase, `http://nook:x@${new URL(replay.url).host}`);
        expect({ id: testCase.id, missing: replay.missing }).toEqual({ id: testCase.id, missing: [] });
        expectScored(testCase, golden, trap);
        // The run is in the Runs view's tables: the report, its run, and its agent run.
        expect(db.query("SELECT kind, status FROM report_runs WHERE id = ?").get(golden.runId)).toEqual({ kind: "generate", status: "succeeded" });
      } finally {
        replay.stop();
      }
    }
  }, 60_000);
});

describe.skipIf(!process.env.CLICKHOUSE_TEST_URL)("report eval: every case against a real ClickHouse (CLICKHOUSE_TEST_URL)", () => {
  test("seeds each case and scores its golden and trap reports", async () => {
    const url = process.env.CLICKHOUSE_TEST_URL!;
    const ch = parseChUrl(url);
    const clickhouse = `http://${encodeURIComponent(ch.user)}:${encodeURIComponent(ch.password)}@${new URL(ch.base).host}`;
    for (const testCase of cases) {
      await seed(ch, testCase.seed);
      const { golden, trap } = await runBoth(testCase, clickhouse);
      expectScored(testCase, golden, trap);
    }
  }, 180_000);
});
