import { db } from "../db";
import { todayIn } from "../../shared/reportParams";
import { validTimeZone } from "../today/registry";

/**
 * The time zone a report's date presets resolve in (D489): its schedule's zone (the one the owner
 * picked in Schedule, the zone scheduled refreshes already use), else the instance's
 * (`REPORT_TIME_ZONE`, else the server process's zone, else UTC). "Today", "Last 30 days", month and
 * quarter to date are calendar days in that zone; a custom range is calendar dates in it.
 */
export function instanceTimeZone(): string {
  const configured = validTimeZone(process.env.REPORT_TIME_ZONE?.trim());
  if (configured) return configured;
  try {
    return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  } catch {
    return "UTC";
  }
}

export function reportTimeZone(reportId: string): string {
  const row = db.query("SELECT tz FROM report_schedules WHERE report_id = ?").get(reportId) as { tz: string } | null;
  return validTimeZone(row?.tz) ?? instanceTimeZone();
}

/** Today's calendar day in the report's zone. */
export const reportToday = (reportId: string, now = new Date()) => todayIn(reportTimeZone(reportId), now);

/** Today in the zone of the report a run belongs to (validation, run_sql); the instance's when the run is unknown. */
export function runToday(runId: string, now = new Date()): string {
  const row = db.query("SELECT report_id FROM report_runs WHERE id = ?").get(runId) as { report_id: string } | null;
  return row ? reportToday(row.report_id, now) : todayIn(instanceTimeZone(), now);
}
