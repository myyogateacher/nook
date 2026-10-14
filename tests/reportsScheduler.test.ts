import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";

const { syncSchema } = await import("../server/reports/schemaCatalog");
const scheduler = await import("../server/reports/scheduler");
const refresh = await import("../server/reports/refresh");

/**
 * Wave 47 schedules (server/reports/scheduler.ts) on a fake clock: off by default; the routines'
 * cadences with time of day, weekday, and zone (DST included); the tick claims due schedules with a
 * compare-and-set and advances next_due_at even when the run fails; at most two scheduled refreshes
 * at once; the owner re-checked at run time; five failures in a row turn the schedule off.
 */

const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.state.select = (sql) => sampleAnswer(sql);
  // Earlier tests' schedules must not be due on this test's clock.
  db.query("UPDATE report_schedules SET enabled = 0, next_due_at = NULL").run();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Schedule admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Schedule owner");
const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Schedule warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport(session: Session = owner) {
  const report = await send(session, "POST", "/reports", { title: "Scheduled", datasourceId });
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(sampleSpec()), report.body.report.id);
  return report.body.report.id as string;
}

// Friday 2026-03-06 12:00 UTC (07:00 in New York, EST; DST starts Sunday 2026-03-08).
const FRIDAY_NOON = Date.parse("2026-03-06T12:00:00Z");
const daily = (at = "09:00", tz = "America/New_York") => ({ cadence: "daily", atTime: at, weekday: null, tz, enabled: true });
const scheduleOf = (reportId: string) => scheduler.getSchedule(reportId, owner.userId);

describe("saving a schedule", () => {
  test("off by default; validates the cadence, time, weekday, and zone; the first run is the next slot", async () => {
    const reportId = await seededReport();
    expect(scheduleOf(reportId)).toMatchObject({ cadence: "manual", enabled: false, nextDueAt: null, autoDisabled: false });
    expect(() => scheduler.saveSchedule(owner.userId, reportId, { cadence: "daily", atTime: null, weekday: null, tz: "UTC", enabled: true })).toThrow("time of day");
    expect(() => scheduler.saveSchedule(owner.userId, reportId, { cadence: "weekly", atTime: "08:00", weekday: null, tz: "UTC", enabled: true })).toThrow("day of the week");
    expect(() => scheduler.saveSchedule(owner.userId, reportId, daily("09:00", "Mars/Olympus"))).toThrow("time zone");
    expect(() => scheduler.saveSchedule(owner.userId, reportId, { cadence: "cron", atTime: "09:00", weekday: null, tz: "UTC", enabled: true })).toThrow();

    expect(scheduler.saveSchedule(owner.userId, reportId, daily(), FRIDAY_NOON)).toMatchObject({ cadence: "daily", atTime: "09:00", enabled: true, nextDueAt: "2026-03-06T14:00:00.000Z", failCount: 0 });
    // Weekly on Monday 08:30 in Kolkata (UTC+5:30), and weekdays from a Friday evening.
    expect(scheduler.saveSchedule(owner.userId, reportId, { cadence: "weekly", atTime: "08:30", weekday: 1, tz: "Asia/Kolkata", enabled: true }, FRIDAY_NOON).nextDueAt).toBe("2026-03-09T03:00:00.000Z");
    expect(scheduler.saveSchedule(owner.userId, reportId, { cadence: "weekdays", atTime: "09:00", weekday: null, tz: "America/New_York", enabled: true }, Date.parse("2026-03-06T20:00:00Z")).nextDueAt).toBe("2026-03-09T13:00:00.000Z");
    expect(scheduler.saveSchedule(owner.userId, reportId, { cadence: "hourly", atTime: "00:15", weekday: null, tz: "UTC", enabled: true }, FRIDAY_NOON).nextDueAt).toBe("2026-03-06T12:15:00.000Z");
    // Manual, or off: never due.
    expect(scheduler.saveSchedule(owner.userId, reportId, { cadence: "manual", atTime: null, weekday: null, tz: "UTC", enabled: true }, FRIDAY_NOON)).toMatchObject({ enabled: false, nextDueAt: null });
    expect(scheduler.saveSchedule(owner.userId, reportId, { ...daily(), enabled: false }, FRIDAY_NOON)).toMatchObject({ enabled: false, nextDueAt: null });

    // Over HTTP: the owner saves; anyone else gets 404.
    const other = await createUser("Schedule other");
    expect((await send(other, "PUT", `/reports/${reportId}/schedule`, daily())).status).toBe(404);
    const saved = await send(owner, "PUT", `/reports/${reportId}/schedule`, daily("07:45", "Europe/Berlin"));
    expect(saved.status).toBe(200);
    expect(saved.body.schedule).toMatchObject({ cadence: "daily", atTime: "07:45", tz: "Europe/Berlin", enabled: true });
    expect((await send(owner, "PUT", `/reports/${reportId}/schedule`, { ...daily(), atTime: "25:00" })).status).toBe(400);
  });
});

describe("the tick", () => {
  test("nothing before the slot; at the slot it refreshes once and moves to the next day, across DST", async () => {
    const reportId = await seededReport();
    scheduler.saveSchedule(owner.userId, reportId, daily(), FRIDAY_NOON);
    expect(scheduler.schedulerTick(FRIDAY_NOON).claimed).toBe(0);
    const tick = scheduler.schedulerTick(Date.parse("2026-03-06T14:00:30Z"));
    expect(tick).toMatchObject({ claimed: 1, started: 1 });
    // A second tick at the same moment finds nothing due (the claim advanced it).
    expect(scheduler.schedulerTick(Date.parse("2026-03-06T14:00:31Z")).claimed).toBe(0);
    await tick.done;
    expect(scheduleOf(reportId).nextDueAt).toBe("2026-03-07T14:00:00.000Z");
    const runs = refresh.listRuns(reportId, owner.userId);
    expect(runs[0]).toMatchObject({ trigger: "schedule", kind: "refresh", status: "succeeded" });
    expect(scheduleOf(reportId)).toMatchObject({ failCount: 0, lastRunId: runs[0]!.id });
    // Saturday's run; Sunday's slot is 09:00 EDT, 13:00 UTC.
    await scheduler.schedulerTick(Date.parse("2026-03-07T14:00:00Z")).done;
    expect(scheduleOf(reportId).nextDueAt).toBe("2026-03-08T13:00:00.000Z");
  });

  test("a tick that comes late runs once, not once per missed slot", async () => {
    const reportId = await seededReport();
    scheduler.saveSchedule(owner.userId, reportId, { cadence: "hourly", atTime: "00:00", weekday: null, tz: "UTC", enabled: true }, FRIDAY_NOON);
    const late = scheduler.schedulerTick(Date.parse("2026-03-06T17:20:00Z"));
    expect(late.started).toBe(1);
    await late.done;
    expect(scheduleOf(reportId).nextDueAt).toBe("2026-03-06T18:00:00.000Z");
    expect(scheduler.schedulerTick(Date.parse("2026-03-06T17:30:00Z")).claimed).toBe(0);
  });

  test("weekly on a weekday: runs on that day, then a week later", async () => {
    const reportId = await seededReport();
    scheduler.saveSchedule(owner.userId, reportId, { cadence: "weekly", atTime: "08:30", weekday: 1, tz: "Asia/Kolkata", enabled: true }, FRIDAY_NOON);
    expect(scheduler.schedulerTick(Date.parse("2026-03-08T12:00:00Z")).claimed).toBe(0);
    await scheduler.schedulerTick(Date.parse("2026-03-09T03:01:00Z")).done;
    expect(scheduleOf(reportId).nextDueAt).toBe("2026-03-16T03:00:00.000Z");
  });

  test("failures advance next_due_at; five in a row turn the schedule off with a badge", async () => {
    const reportId = await seededReport();
    fake.state.select = () => ({ error: "Code: 81. DB::Exception: Database analytics does not exist. (UNKNOWN_DATABASE) (version 24.8.1.1)\n" });
    scheduler.saveSchedule(owner.userId, reportId, { cadence: "hourly", atTime: "00:00", weekday: null, tz: "UTC", enabled: true }, FRIDAY_NOON);
    let at = Date.parse("2026-03-06T13:00:10Z");
    for (let index = 1; index <= 5; index += 1) {
      const tick = scheduler.schedulerTick(at);
      expect(tick.started).toBe(1);
      await tick.done;
      const schedule = scheduleOf(reportId);
      expect(schedule.failCount).toBe(index);
      if (index < 5) expect(schedule).toMatchObject({ enabled: true, nextDueAt: new Date(at - 10_000 + 3_600_000).toISOString(), autoDisabled: false });
      at += 3_600_000;
    }
    expect(scheduleOf(reportId)).toMatchObject({ enabled: false, nextDueAt: null, autoDisabled: true, failCount: 5 });
    expect(scheduler.schedulerTick(at).claimed).toBe(0);
    // Saving it again turns it back on and starts counting afresh.
    expect(scheduler.saveSchedule(owner.userId, reportId, { cadence: "hourly", atTime: "00:00", weekday: null, tz: "UTC", enabled: true }, at)).toMatchObject({ enabled: true, failCount: 0, autoDisabled: false });
  });

  test("a success resets the failure count; a partial run is not a failure", async () => {
    const reportId = await seededReport();
    scheduler.saveSchedule(owner.userId, reportId, { cadence: "hourly", atTime: "00:00", weekday: null, tz: "UTC", enabled: true }, FRIDAY_NOON);
    fake.state.select = () => ({ error: "Code: 81. DB::Exception: nope. (UNKNOWN_DATABASE) (version 24.8.1.1)\n" });
    await scheduler.schedulerTick(Date.parse("2026-03-06T13:00:00Z")).done;
    expect(scheduleOf(reportId).failCount).toBe(1);
    fake.state.select = (sql) => sql.includes("GROUP BY day") ? { error: "Code: 241. DB::Exception: boom. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)\n" } : sampleAnswer(sql);
    await scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z")).done;
    expect(scheduleOf(reportId).failCount).toBe(0);
    expect(refresh.listRuns(reportId, owner.userId)[0]!.status).toBe("partial");
  });

  test("the owner is checked at run time: a blocked owner's or binned report's run fails without reaching ClickHouse", async () => {
    const blocked = await createUser("Schedule blocked owner");
    const reportId = await seededReport(blocked);
    scheduler.saveSchedule(blocked.userId, reportId, daily(), FRIDAY_NOON);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    const tick = scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z"));
    expect(tick).toMatchObject({ claimed: 1, started: 0, failed: 1 });
    expect(fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM (")).length).toBe(0);
    const row = db.query("SELECT status, trigger, error FROM report_runs WHERE report_id = ? ORDER BY started_at DESC LIMIT 1").get(reportId) as Json;
    expect(row).toMatchObject({ status: "failed", trigger: "schedule", error: "The report's owner is blocked" });
    expect(db.query("SELECT next_due_at, fail_count FROM report_schedules WHERE report_id = ?").get(reportId)).toEqual({ next_due_at: "2026-03-07T14:00:00.000Z", fail_count: 1 });

    const demoted = await createUser("Schedule demoted owner");
    const second = await seededReport(demoted);
    scheduler.saveSchedule(demoted.userId, second, daily(), FRIDAY_NOON);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(demoted.userId);
    expect(scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z"))).toMatchObject({ failed: 1, started: 0 });
  });

  test("at most two scheduled refreshes run at once; the rest wait for the next tick", async () => {
    const reports = [await seededReport(), await seededReport(), await seededReport()];
    for (const reportId of reports) scheduler.saveSchedule(owner.userId, reportId, daily(), FRIDAY_NOON);
    fake.state.delayMs = 60;
    const first = scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z"));
    expect(first).toMatchObject({ claimed: 2, started: 2 });
    expect(scheduler.scheduledInFlight()).toBe(2);
    expect(scheduler.schedulerTick(Date.parse("2026-03-06T14:00:05Z")).claimed).toBe(0);
    await first.done;
    expect(scheduler.scheduledInFlight()).toBe(0);
    const second = scheduler.schedulerTick(Date.parse("2026-03-06T14:01:00Z"));
    expect(second).toMatchObject({ claimed: 1, started: 1 });
    await second.done;
    for (const reportId of reports) expect(scheduleOf(reportId).nextDueAt).toBe("2026-03-07T14:00:00.000Z");
  });

  test("a scheduled run whose data source an admin turned off counts as a failure", async () => {
    const off = await send(admin, "POST", "/reports/admin/datasources", { name: "Schedule warehouse off", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
    await syncSchema(off.body.datasource.id).catch(() => undefined);
    const report = await send(owner, "POST", "/reports", { title: "Scheduled off", datasourceId: off.body.datasource.id });
    const reportId = report.body.report.id as string;
    db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(sampleSpec()), reportId);
    scheduler.saveSchedule(owner.userId, reportId, daily(), FRIDAY_NOON);
    db.query("UPDATE report_datasources SET enabled = 0 WHERE id = ?").run(off.body.datasource.id);
    fake.requests.length = 0;
    const tick = scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z"));
    expect(tick).toMatchObject({ claimed: 1, started: 0, failed: 1 });
    await tick.done;
    expect(fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM (")).length).toBe(0);
    expect(scheduleOf(reportId)).toMatchObject({ failCount: 1, nextDueAt: "2026-03-07T14:00:00.000Z", enabled: true });
    expect(refresh.listRuns(reportId, owner.userId)[0]).toMatchObject({ trigger: "schedule", status: "failed", error: "An admin turned this data source off" });
  });

  test("L5: a failure recording the outcome is logged, never an unhandled rejection", async () => {
    const source = await Bun.file(new URL("../server/reports/scheduler.ts", import.meta.url)).text();
    expect(source).toContain(".catch((error: unknown) => { slog.error(\"Report schedule outcome could not be recorded\"");
    const reportId = await seededReport();
    scheduler.saveSchedule(owner.userId, reportId, daily(), FRIDAY_NOON);
    const tick = scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z"));
    expect(tick.started).toBe(1);
    // The report goes before the run ends: recording the outcome finds no schedule, and nothing throws.
    db.query("DELETE FROM report_schedules WHERE report_id = ?").run(reportId);
    await expect(tick.done).resolves.toBeDefined();
    expect(scheduler.scheduledInFlight()).toBe(0);
  });

  test("a report already running skips the slot without counting a failure", async () => {
    const reportId = await seededReport();
    scheduler.saveSchedule(owner.userId, reportId, daily(), FRIDAY_NOON);
    const held = refresh.takeRunLock({ reportId, kind: "generate", trigger: "user", userId: owner.userId, queryKeys: null });
    expect(scheduler.schedulerTick(Date.parse("2026-03-06T14:00:00Z"))).toMatchObject({ claimed: 1, skipped: 1, failed: 0 });
    expect(scheduleOf(reportId)).toMatchObject({ failCount: 0, nextDueAt: "2026-03-07T14:00:00.000Z" });
    db.query("UPDATE report_runs SET status = 'succeeded' WHERE id = ?").run(held.id);
  });
});
