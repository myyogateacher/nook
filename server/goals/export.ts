import { audit } from "../db";
import { config } from "../config";
import { CSV_EXPORT_ROWS, csvText } from "../csvExport";
import { GOAL_STATE_LABEL } from "../../shared/goals";
import { HEALTH_LABEL } from "../../shared/tones";
import { listGoals, type GoalListFilter, type GoalSummary } from "./service";

/**
 * Goals as CSV (D1387): the goals list the viewer sees with the same filters (only goals they can
 * open), one row per goal. Audited (`goals.export`).
 */

const pct = (value: number | null) => value === null ? "" : Math.round(value * 100);

export function goalsCsv(userId: string, filter: GoalListFilter) {
  const goals: GoalSummary[] = [];
  let cursor: string | null = null;
  do {
    const page = listGoals(userId, { ...filter, view: "list" }, { cursor, limit: 100 });
    goals.push(...page.goals);
    cursor = page.nextCursor;
  } while (cursor && goals.length < CSV_EXPORT_ROWS);
  const truncated = goals.length > CSV_EXPORT_ROWS || Boolean(cursor);
  const rows = goals.slice(0, CSV_EXPORT_ROWS).map((goal) => [
    goal.title, goal.kind, GOAL_STATE_LABEL[goal.state] ?? goal.state, HEALTH_LABEL[goal.health as keyof typeof HEALTH_LABEL] ?? goal.health, pct(goal.progress), pct(goal.expected),
    goal.owner.name, goal.team?.name ?? "", goal.period?.name ?? "", goal.startOn ?? goal.period?.startsOn ?? "", goal.dueOn ?? goal.period?.endsOn ?? "",
    goal.krCount, goal.lastCheckinAt ?? "", `${config.appOrigin}${goal.href}`
  ]);
  audit(userId, null, "goals.export", { rows: rows.length });
  return csvText(["Goal", "Kind", "State", "Health", "Progress %", "Expected %", "Owner", "Team", "Period", "Start", "Due", "Key results", "Last check-in", "Link"], rows, truncated);
}
