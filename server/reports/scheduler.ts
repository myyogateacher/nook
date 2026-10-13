import { audit, db, now } from "../db";
import { validTimeZone } from "../today/registry";
import { REPORT_LIMITS, type ReportRun } from "../../shared/reports";
import { dueAfterRun, isCadence, nextSlotAfter, scheduleProblem, type Cadence, type RoutineSchedule } from "../../shared/routineSchedule";
import type { ScheduleInput, ScheduleView } from "../../shared/reportsView";
import { ownedReport, readableReport, roleHasReports } from "./access";
import { ReportError } from "./errors";
import { abandonExpiredReportRuns, startRefresh } from "./refresh";

/**
 * Report schedules (plan wave 47): an optional cadence per report, off by default. The
 * cadences, time of day, weekday, and zone are the routines' (shared/routineSchedule.ts: `hourly` at
 * minute MM, `daily`, `weekdays`, `weekly` at HH:MM in the report's zone, DST handled there).
 *
 * The tick (once a minute) claims due schedules one by one with a compare-and-set
 * `UPDATE … WHERE next_due_at = <seen> RETURNING`, which also advances `next_due_at` to the next slot
 * after the claimed one, so a slot runs once even if two ticks overlap, and the schedule moves on
 * whether the refresh then succeeds or fails. At most two scheduled refreshes run at once on the
 * server. At run time the owner must still be an active person whose role writes reports and the
 * report must still be theirs and live; otherwise the run is recorded as failed. Five failed
 * scheduled runs in a row turn the schedule off (`autoDisabled`, a badge on the page).
 */

export const SCHEDULER_TICK_MS = 60_000;
export const MAX_SCHEDULED_REFRESHES = 2;

type ScheduleRow = {
  report_id: string; cadence: Cadence; at_time: string | null; weekday: number | null; tz: string; next_due_at: string | null;
  enabled: number; fail_count: number; last_run_id: string | null; created_at: string; updated_at: string;
};

const scheduleOf = (row: Pick<ScheduleRow, "cadence" | "at_time" | "weekday" | "tz">): RoutineSchedule => ({ cadence: row.cadence, atTime: row.at_time, weekday: row.weekday, tz: row.tz });

const scheduleRow = (reportId: string) => db.query("SELECT * FROM report_schedules WHERE report_id = ?").get(reportId) as ScheduleRow | null;

export function scheduleView(row: ScheduleRow | null): ScheduleView {
  if (!row) return { cadence: "manual", atTime: null, weekday: null, tz: "UTC", enabled: false, nextDueAt: null, failCount: 0, autoDisabled: false, lastRunId: null };
  return {
    cadence: row.cadence, atTime: row.at_time, weekday: row.weekday, tz: row.tz, enabled: row.enabled === 1, nextDueAt: row.next_due_at,
    failCount: row.fail_count, autoDisabled: row.enabled === 0 && row.fail_count >= REPORT_LIMITS.scheduleFailures, lastRunId: row.last_run_id
  };
}

export function getSchedule(reportId: string, userId: string): ScheduleView {
  readableReport(reportId, userId);
  return scheduleView(scheduleRow(reportId));
}

/** Saves a report's schedule (the owner). Turning it on (or saving it on) starts counting failures afresh; the first run is the next slot. */
export function saveSchedule(userId: string, reportId: string, input: ScheduleInput, nowMs = Date.now()): ScheduleView {
  ownedReport(reportId, userId);
  if (!isCadence(input.cadence)) throw new ReportError(400, "INVALID", "Choose how often the report refreshes");
  const tz = validTimeZone(input.tz);
  if (!tz) throw new ReportError(400, "INVALID", "Unknown time zone");
  const schedule: RoutineSchedule = {
    cadence: input.cadence,
    atTime: input.cadence === "manual" ? null : input.atTime,
    weekday: input.cadence === "weekly" ? input.weekday : null,
    tz
  };
  const problem = scheduleProblem(schedule);
  if (problem) throw new ReportError(400, "INVALID", problem.replace("the routine runs", "the report refreshes"));
  const enabled = input.enabled && schedule.cadence !== "manual";
  const slot = enabled ? nextSlotAfter(schedule, nowMs) : null;
  const nextDue = slot === null ? null : new Date(slot).toISOString();
  const at = now();
  db.query(`INSERT INTO report_schedules (report_id, cadence, at_time, weekday, tz, next_due_at, enabled, fail_count, created_at, updated_at)
    VALUES ($id, $cadence, $atTime, $weekday, $tz, $next, $enabled, 0, $at, $at)
    ON CONFLICT (report_id) DO UPDATE SET cadence = $cadence, at_time = $atTime, weekday = $weekday, tz = $tz, next_due_at = $next, enabled = $enabled, fail_count = 0, updated_at = $at`)
    .run({ id: reportId, cadence: schedule.cadence, atTime: schedule.atTime, weekday: schedule.weekday, tz, next: nextDue, enabled: enabled ? 1 : 0, at });
  audit(userId, null, "reports.schedule.save", { reportId, cadence: schedule.cadence, enabled });
  return scheduleView(scheduleRow(reportId));
}

/** Whether the owner may still have their report refreshed: an active person whose role writes reports, and the report live and theirs. */
function ownerProblem(reportId: string): { ownerId: string | null; problem: string | null } {
  const row = db.query("SELECT r.owner_id, r.deleted_at, u.role, u.disabled_at FROM reports r JOIN users u ON u.id = r.owner_id WHERE r.id = ?").get(reportId) as
    { owner_id: string; deleted_at: string | null; role: string; disabled_at: string | null } | null;
  if (!row || row.deleted_at) return { ownerId: row?.owner_id ?? null, problem: "The report is in the Bin" };
  if (row.disabled_at) return { ownerId: row.owner_id, problem: "The report's owner is blocked" };
  if (!roleHasReports(row.role) || row.role === "viewer") return { ownerId: row.owner_id, problem: "The report's owner can no longer refresh reports" };
  try {
    readableReport(reportId, row.owner_id);
  } catch {
    return { ownerId: row.owner_id, problem: "The report's owner can no longer open it" };
  }
  return { ownerId: row.owner_id, problem: null };
}

/** A scheduled run that could not start: recorded as a failed run so the history says why. */
function recordStartFailure(reportId: string, ownerId: string | null, message: string) {
  const id = crypto.randomUUID();
  const at = now();
  db.query(`INSERT INTO report_runs (id, report_id, kind, trigger, status, created_by, started_at, finished_at, error) VALUES (?, ?, 'refresh', 'schedule', 'failed', ?, ?, ?, ?)`)
    .run(id, reportId, ownerId, at, at, message.slice(0, 1000));
  recordOutcome(reportId, id, "failed");
}

/** After a scheduled run: a failure counts toward the auto-off; anything that refreshed something resets it. */
function recordOutcome(reportId: string, runId: string, status: ReportRun["status"]) {
  if (status === "failed" || status === "abandoned") {
    const row = db.query("UPDATE report_schedules SET fail_count = fail_count + 1, last_run_id = ?, updated_at = ? WHERE report_id = ? RETURNING fail_count, enabled")
      .get(runId, now(), reportId) as { fail_count: number; enabled: number } | null;
    if (row && row.enabled === 1 && row.fail_count >= REPORT_LIMITS.scheduleFailures) {
      db.query("UPDATE report_schedules SET enabled = 0, next_due_at = NULL WHERE report_id = ?").run(reportId);
      audit(null, null, "reports.schedule.auto_disabled", { reportId, failures: row.fail_count });
    }
    return;
  }
  db.query("UPDATE report_schedules SET fail_count = 0, last_run_id = ?, updated_at = ? WHERE report_id = ?").run(runId, now(), reportId);
}

let inFlight = 0;
/** Test hook. */
export const scheduledInFlight = () => inFlight;

export type TickResult = { claimed: number; started: number; skipped: number; failed: number; done: Promise<unknown> };

/**
 * One scheduler tick at `nowMs` (the fake clock in tests): abandon expired runs, then claim due
 * schedules while fewer than two scheduled refreshes run.
 */
export function schedulerTick(nowMs = Date.now()): TickResult {
  // Leases are wall-clock; the schedule's clock may be a test's.
  abandonExpiredReportRuns(Date.now());
  const result: TickResult = { claimed: 0, started: 0, skipped: 0, failed: 0, done: Promise.resolve() };
  const room = MAX_SCHEDULED_REFRESHES - inFlight;
  if (room <= 0) return result;
  const nowIso = new Date(nowMs).toISOString();
  const due = db.query(`SELECT s.* FROM report_schedules s JOIN reports r ON r.id = s.report_id
    WHERE s.enabled = 1 AND s.next_due_at IS NOT NULL AND s.next_due_at <= ? ORDER BY s.next_due_at, s.report_id LIMIT ?`).all(nowIso, room * 4) as ScheduleRow[];
  const pending: Promise<unknown>[] = [];
  for (const row of due) {
    if (inFlight >= MAX_SCHEDULED_REFRESHES) break;
    const next = dueAfterRun(scheduleOf(row), Date.parse(row.next_due_at!), nowMs);
    const claimed = db.query(`UPDATE report_schedules SET next_due_at = ?, updated_at = ? WHERE report_id = ? AND enabled = 1 AND next_due_at = ? RETURNING report_id`)
      .get(next, now(), row.report_id, row.next_due_at) as { report_id: string } | null;
    if (!claimed) continue;
    result.claimed += 1;
    const { ownerId, problem } = ownerProblem(row.report_id);
    if (problem || !ownerId) {
      recordStartFailure(row.report_id, ownerId, problem ?? "The report's owner is gone");
      result.failed += 1;
      continue;
    }
    let start;
    try {
      start = startRefresh(ownerId, row.report_id, { trigger: "schedule" });
    } catch (error) {
      // Already running (a person's refresh, a generation): this slot is covered; not a failure.
      if (error instanceof ReportError && error.code === "RUN_IN_PROGRESS") {
        result.skipped += 1;
        continue;
      }
      recordStartFailure(row.report_id, ownerId, error instanceof Error ? error.message : "The refresh could not start");
      result.failed += 1;
      continue;
    }
    inFlight += 1;
    result.started += 1;
    pending.push(start.done
      .then((run) => recordOutcome(row.report_id, run.id, run.status))
      // Never an unhandled rejection: a failed bookkeeping write is logged (the run itself is recorded).
      .catch((error: unknown) => { console.error("Report schedule outcome could not be recorded", error instanceof Error ? error.name : "Unknown error"); })
      .finally(() => { inFlight -= 1; }));
  }
  result.done = Promise.all(pending);
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the once-a-minute tick (server/index.ts). */
export function startReportScheduler() {
  if (timer) return;
  const tick = () => {
    try {
      schedulerTick().done.catch((error: unknown) => console.error("Report scheduled refresh failed", error instanceof Error ? error.name : "Unknown error"));
    } catch (error) {
      console.error("Report scheduler tick failed", error instanceof Error ? error.name : "Unknown error");
    }
  };
  timer = setInterval(tick, SCHEDULER_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
}
