import { addColumn, type Migration } from "./types";

/**
 * Reports: the generation planner and auto-named reports.
 *
 * - `report_runs.plan_json`: a generate or edit run's plan (`plan_report` / `plan_change`: its goal,
 *   sections, and todos with their final statuses and notes), shown live, in Runs, and in Provenance.
 *   NULL for refreshes and for runs before the planner.
 * - `reports.title_source`: where the title came from: `default` ("Untitled report"), `doc` (the doc's
 *   title), `ai` (submit_report's title), or `user` (typed or renamed). Generation replaces a title only
 *   while it is not `user`. Existing reports read as `user`, except those still titled "Untitled report".
 *
 * 054 stays reserved for the Messages module; the doc-browse migration takes 056. Needs 050.
 * Transactional and filesystem-free; re-running changes nothing.
 */
export const reportRunPlansMigration: Migration = {
  id: 55,
  name: "report_run_plans",
  up(db) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    addColumn(db, "report_runs", "plan_json", "TEXT CHECK (plan_json IS NULL OR (json_valid(plan_json) AND length(plan_json) <= 65536))");
    const had = (db.query("PRAGMA table_info(reports)").all() as Array<{ name: string }>).some((column) => column.name === "title_source");
    addColumn(db, "reports", "title_source", "TEXT NOT NULL DEFAULT 'user' CHECK (title_source IN ('default','doc','ai','user'))");
    if (!had) db.exec("UPDATE reports SET title_source = 'default' WHERE title = 'Untitled report'");
  }
};
