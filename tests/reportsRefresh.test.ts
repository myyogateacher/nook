import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";

const { syncSchema } = await import("../server/reports/schemaCatalog");
const refresh = await import("../server/reports/refresh");

/**
 * Wave 47 refresh (server/reports/refresh.ts): saved queries re-run through the guard two at a time,
 * results stored per run with the SQL as sent, rows read, and the query id; partial runs keep the last
 * good result (stale); the one-run lock (409 RUN_IN_PROGRESS) shared by per-block refreshes; leases,
 * abandonment, and KILL QUERY; and keeping the last 20 runs.
 */

const fake = startFakeClickhouse(24861);
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.state.select = (sql) => sampleAnswer(sql);
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Refresh admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Refresh owner");
const stranger = await createUser("Refresh stranger");

const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Refresh warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport(title = "Revenue") {
  const report = await send(owner, "POST", "/reports", { title, datasourceId });
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(sampleSpec()), report.body.report.id);
  return report.body.report.id as string;
}

const mainSelects = () => fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM ("));

async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("refresh", () => {
  test("re-runs every saved query through the guard and stores results with sent SQL, rows read, and query id", async () => {
    const reportId = await seededReport();
    const started = refresh.startRefresh(owner.userId, reportId, { trigger: "user" });
    expect(started.run).toMatchObject({ status: "running", kind: "refresh", trigger: "user", queryKeys: null });
    const run = await started.done;
    expect(run.status).toBe("succeeded");
    // Each query: an EXPLAIN QUERY TREE check, then the wrapped select with readonly=2 and its query id.
    expect(fake.requests.filter((item) => item.sql.startsWith("EXPLAIN QUERY TREE")).length).toBe(4);
    expect(mainSelects().length).toBe(4);
    for (const item of mainSelects()) {
      expect(item.params.readonly).toBe("2");
      expect(item.params.query_id).toStartWith(`nook-${run.id.replace(/-/g, "").slice(0, 16)}-`);
    }
    const view = await send(owner, "GET", `/reports/${reportId}/results`);
    expect(view.status).toBe(200);
    const daily = view.body.results.find((item: Json) => item.queryKey === "daily");
    expect(daily.stale).toBe(false);
    expect(daily.result).toMatchObject({ runId: run.id, rowCount: 14, rowsRead: 120000, truncated: false, error: null });
    expect(daily.result.sentSql).toContain("LIMIT 10001");
    expect(daily.result.chQueryId).toBe(refresh.runQueryId(run.id, "daily"));
    expect(daily.result.columns.map((column: Json) => column.name)).toEqual(["day", "revenue", "refunds"]);
    const report = db.query("SELECT status, last_run_at FROM reports WHERE id = ?").get(reportId) as { status: string; last_run_at: string };
    expect(report.status).toBe("ready");
    expect(report.last_run_at).toBeTruthy();
  });

  test("runs at most two queries at a time", async () => {
    const reportId = await seededReport();
    fake.state.delayMs = 120;
    let inFlight = 0;
    let peak = 0;
    const select = fake.state.select;
    // The fake answers after its delay; count from arrival (the request log) to answer.
    const arrivals: number[] = [];
    fake.state.select = (sql, request) => {
      inFlight -= 1;
      return select(sql, request);
    };
    const watcher = setInterval(() => {
      const count = mainSelects().length;
      while (arrivals.length < count) { arrivals.push(Date.now()); inFlight += 1; }
      peak = Math.max(peak, inFlight);
    }, 2);
    try {
      const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
      expect(run.status).toBe("succeeded");
    } finally {
      clearInterval(watcher);
    }
    expect(mainSelects().length).toBe(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  test("a partial run keeps the failed block's last good result, marked stale; all failing is failed", async () => {
    const reportId = await seededReport();
    expect((await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done).status).toBe("succeeded");
    fake.state.select = (sql) => sql.includes("GROUP BY country") ? { error: "Code: 241. DB::Exception: Memory limit exceeded. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)\n" } : sampleAnswer(sql);
    const partial = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    expect(partial).toMatchObject({ status: "partial", error: "1 of 4 queries failed" });
    const view = refresh.reportResults(reportId, owner.userId);
    const country = view.results.find((item) => item.queryKey === "by_country")!;
    expect(country.stale).toBe(true);
    expect(country.result?.rowCount).toBe(8);
    expect(country.failed).toMatchObject({ runId: partial.id, errorCode: "CLICKHOUSE" });
    expect(country.failed?.error).toContain("Memory limit exceeded");
    expect(view.results.find((item) => item.queryKey === "daily")!.result?.runId).toBe(partial.id);
    expect((db.query("SELECT status FROM reports WHERE id = ?").get(reportId) as { status: string }).status).toBe("stale");

    fake.state.select = () => ({ error: "Code: 81. DB::Exception: Database analytics does not exist. (UNKNOWN_DATABASE) (version 24.8.1.1)\n" });
    const failed = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    expect(failed.status).toBe("failed");
    // Everything shows its last good rows, stale.
    expect(refresh.reportResults(reportId, owner.userId).results.every((item) => item.stale && item.result)).toBe(true);
  });

  test("a guard refusal is a failed query with the guard's code, and nothing reaches ClickHouse for it", async () => {
    const reportId = await seededReport();
    const spec = sampleSpec();
    spec.queries[3]!.sql = "SELECT * FROM url('http://169.254.169.254/latest', CSV, 'a String')";
    db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), reportId);
    const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    expect(run.status).toBe("partial");
    const recent = refresh.reportResults(reportId, owner.userId).results.find((item) => item.queryKey === "recent")!;
    expect(recent.failed?.errorCode).toStartWith("GUARD:");
    expect(fake.requests.some((item) => item.sql.includes("169.254"))).toBe(false);
  });

  test("one run at a time: 409 RUN_IN_PROGRESS, also for a per-block refresh, which runs only its query", async () => {
    const reportId = await seededReport();
    fake.state.delayMs = 150;
    const first = await send(owner, "POST", `/reports/${reportId}/refresh`, {});
    expect(first.status).toBe(202);
    expect(first.body.run.status).toBe("running");
    const second = await send(owner, "POST", `/reports/${reportId}/refresh`, { queryKey: "daily" });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "RUN_IN_PROGRESS", runId: first.body.run.id });
    await waitFor(() => refresh.runRow(first.body.run.id)!.status !== "running");
    fake.requests.length = 0;
    fake.state.delayMs = 0;

    const single = await send(owner, "POST", `/reports/${reportId}/refresh`, { queryKey: "daily" });
    expect(single.status).toBe(202);
    expect(single.body.run.queryKeys).toEqual(["daily"]);
    await waitFor(() => refresh.runRow(single.body.run.id)!.status !== "running");
    expect(refresh.runRow(single.body.run.id)!.status).toBe("succeeded");
    expect(mainSelects().map((item) => item.sql)).toEqual([expect.stringContaining("GROUP BY day")]);
    const view = refresh.reportResults(reportId, owner.userId);
    expect(view.results.find((item) => item.queryKey === "daily")!.result?.runId).toBe(single.body.run.id);
    expect(view.results.find((item) => item.queryKey === "totals")!.result?.runId).toBe(first.body.run.id);
    // An unknown key and someone else's report.
    expect((await send(owner, "POST", `/reports/${reportId}/refresh`, { queryKey: "nope" })).status).toBe(404);
    expect((await send(owner, "POST", `/reports/${reportId}/refresh`, { queryKey: "Bad Key" })).status).toBe(400);
    expect((await send(stranger, "POST", `/reports/${reportId}/refresh`, {})).status).toBe(404);
    expect((await send(stranger, "GET", `/reports/${reportId}/results`)).status).toBe(404);
    // The run list and one run.
    const runs = await send(owner, "GET", `/reports/${reportId}/runs`);
    expect(runs.body.runs.map((item: Json) => item.id)).toEqual([single.body.run.id, first.body.run.id]);
    expect(runs.body.schedule).toMatchObject({ cadence: "manual", enabled: false });
    expect((await send(owner, "GET", `/reports/${reportId}/runs/${first.body.run.id}`)).body.run.status).toBe("succeeded");
  });

  test("an expired lease is abandoned (lazily and at boot) with a KILL QUERY, which frees the lock", async () => {
    const reportId = await seededReport();
    const lock = refresh.takeRunLock({ reportId, kind: "refresh", trigger: "user", userId: owner.userId, queryKeys: ["daily"], nowMs: Date.now() - 10 * 60_000 });
    expect(refresh.abandonRunsAtBoot()).toBeGreaterThanOrEqual(1);
    expect(refresh.runRow(lock.id)).toMatchObject({ status: "abandoned" });
    await waitFor(() => fake.requests.some((item) => item.sql.startsWith("KILL QUERY")));
    const kill = fake.requests.find((item) => item.sql.startsWith("KILL QUERY"))!;
    expect(kill.sql).toContain(refresh.runQueryId(lock.id, "daily"));

    // A live lease holds the lock; an expired one is abandoned when the next run starts.
    const live = refresh.takeRunLock({ reportId, kind: "generate", trigger: "user", userId: owner.userId, queryKeys: null });
    expect(() => refresh.startRefresh(owner.userId, reportId, { trigger: "user" })).toThrow("already running");
    db.query("UPDATE report_runs SET lease_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), live.id);
    const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    expect(run.status).toBe("succeeded");
    expect(refresh.runRow(live.id)!.status).toBe("abandoned");
  });

  test("a run whose lease is taken away stops and kills its in-flight queries", async () => {
    const reportId = await seededReport();
    fake.state.delayMs = 400;
    const started = refresh.startRefresh(owner.userId, reportId, { trigger: "user" });
    await waitFor(() => mainSelects().length >= 1);
    db.query("UPDATE report_runs SET lease_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), started.run.id);
    expect(refresh.abandonExpiredReportRuns(Date.now(), reportId)).toBe(1);
    const run = await started.done;
    expect(run.status).toBe("abandoned");
    await waitFor(() => fake.requests.some((item) => item.sql.startsWith("KILL QUERY")));
    expect(refresh.activeRefreshes()).toBe(0);
  });

  test("keeps the last 20 runs, and older runs that hold a query's last good result", async () => {
    const reportId = await seededReport();
    expect((await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done).status).toBe("succeeded");
    const keeper = refresh.reportResults(reportId, owner.userId).results.find((item) => item.queryKey === "by_country")!.result!.runId;
    fake.state.select = (sql) => sql.includes("GROUP BY country") ? { error: "Code: 241. DB::Exception: boom. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)\n" } : sampleAnswer(sql);
    for (let index = 0; index < 22; index += 1) await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const kept = db.query("SELECT id FROM report_runs WHERE report_id = ?").all(reportId) as Array<{ id: string }>;
    expect(kept.length).toBe(21);
    expect(kept.map((row) => row.id)).toContain(keeper);
    expect(refresh.reportResults(reportId, owner.userId).results.find((item) => item.queryKey === "by_country")!.result?.runId).toBe(keeper);
  });

  test("stored rows are capped at 10,000 and 2 MiB, and marked truncated", () => {
    const many = Array.from({ length: 12_000 }, (_, index) => [index]);
    expect(refresh.capRows(many)).toMatchObject({ kept: 10_000, cut: true });
    const wide = Array.from({ length: 50 }, () => ["x".repeat(100_000)]);
    const capped = refresh.capRows(wide);
    expect(capped.cut).toBe(true);
    expect(capped.json.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(capped.kept).toBe(20);
  });

  test("a report with no queries, or no data source, cannot refresh", async () => {
    const empty = await send(owner, "POST", "/reports", { title: "Empty", datasourceId });
    expect((await send(owner, "POST", `/reports/${empty.body.report.id}/refresh`, {})).body.code).toBe("INVALID");
  });
});

describe("review fixes", () => {
  const insertRunning = (reportId: string, startedAt: string, leaseUntil: string | null) => {
    const id = crypto.randomUUID();
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, lease_until, started_at) VALUES (?, ?, 'generate', 'user', 'running', ?, ?)").run(id, reportId, leaseUntil, startedAt);
    return id;
  };

  test("M1: boot abandons every running row, lease or not; the sweep abandons a lease-less row after the grace period", async () => {
    const live = await seededReport();
    const leased = insertRunning(live, new Date().toISOString(), new Date(Date.now() + 10 * 60_000).toISOString());
    expect(refresh.abandonRunsAtBoot()).toBeGreaterThanOrEqual(1);
    expect(refresh.runRow(leased)).toMatchObject({ status: "abandoned", error: "The server restarted before the run finished" });

    const fresh = insertRunning(live, new Date().toISOString(), null);
    expect(refresh.abandonExpiredReportRuns(Date.now(), live)).toBe(0);
    expect(refresh.runRow(fresh)!.status).toBe("running");
    // A lease-less run still holds the lock until the grace period passes.
    expect(() => refresh.startRefresh(owner.userId, live, { trigger: "user" })).toThrow("already running");
    expect(refresh.abandonExpiredReportRuns(Date.now() + refresh.NO_LEASE_GRACE_MS + 1000, live)).toBe(1);
    expect(refresh.runRow(fresh)!.status).toBe("abandoned");

    const old = insertRunning(live, new Date(Date.now() - refresh.NO_LEASE_GRACE_MS - 60_000).toISOString(), null);
    // The lazy check before a start frees it.
    expect((await refresh.startRefresh(owner.userId, live, { trigger: "user" }).done).status).toBe("succeeded");
    expect(refresh.runRow(old)!.status).toBe("abandoned");
  });

  test("M2: pruning keeps the run holding a query's newest result, so an old failure keeps its stale badge", async () => {
    const reportId = await seededReport();
    expect((await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done).status).toBe("succeeded");
    fake.state.select = (sql) => sql.includes("GROUP BY country") ? { error: "Code: 241. DB::Exception: boom. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)\n" } : sampleAnswer(sql);
    const failure = await refresh.startRefresh(owner.userId, reportId, { trigger: "user", queryKey: "by_country" }).done;
    expect(failure.status).toBe("failed");
    for (let index = 0; index < 21; index += 1) await refresh.startRefresh(owner.userId, reportId, { trigger: "user", queryKey: "daily" }).done;
    const kept = (db.query("SELECT id FROM report_runs WHERE report_id = ?").all(reportId) as Array<{ id: string }>).map((row) => row.id);
    expect(kept).toContain(failure.id);
    const country = refresh.reportResults(reportId, owner.userId).results.find((item) => item.queryKey === "by_country")!;
    expect(country).toMatchObject({ stale: true, failed: { runId: failure.id } });
  });

  test("L6: guests get 404 on every wave 47 route; a run id from another report is refused", async () => {
    const guest = await createUser("Refresh guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    const reportId = await seededReport();
    const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    for (const path of ["results", "runs", `runs/${run.id}`, `provenance?runId=${run.id}`, "schedule"]) {
      expect((await send(guest, "GET", `/reports/${reportId}/${path}`)).status).toBe(404);
    }
    // Writes: the app-wide role gate refuses a guest's mutation first (403, as everywhere), before the module's 404.
    const put = await send(guest, "PUT", `/reports/${reportId}/schedule`, { cadence: "daily", atTime: "09:00", weekday: null, tz: "UTC", enabled: true });
    const post = await send(guest, "POST", `/reports/${reportId}/refresh`, {});
    expect([put.status, post.status]).toEqual([403, 403]);
    expect(db.query("SELECT COUNT(*) AS count FROM report_schedules WHERE report_id = ?").get(reportId)).toEqual({ count: 0 });
    expect(refresh.runningRun(reportId)).toBeNull();

    const other = await seededReport("Other");
    expect((await send(owner, "GET", `/reports/${other}/runs/${run.id}`)).status).toBe(404);
    const crossed = await send(owner, "GET", `/reports/${other}/provenance?runId=${run.id}`);
    expect(crossed.status).toBe(200);
    expect(crossed.body).toEqual({ run: null, snapshot: null });
    expect((await send(owner, "GET", `/reports/${reportId}/provenance?runId=${run.id}`)).body.run.id).toBe(run.id);
    // Someone else's report, with a valid run id: 404.
    expect((await send(stranger, "GET", `/reports/${reportId}/provenance?runId=${run.id}`)).status).toBe(404);
  });
});
