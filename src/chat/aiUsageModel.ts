// Settings → AI → Usage (D1381): pure helpers over GET /api/agents/admin/usage, unit tested directly.

/** One day of one person's or agent's usage, as the endpoint returns it. Counts only (D73): no chat text, no cost. */
export type AiUsageRow = { day: string; id: string; name: string; runs: number; promptTokens: number; completionTokens: number };
export type AiUsageGroup = "user" | "agent";
export type AiUsageResponse = { from: string; to: string; group: AiUsageGroup; rows: AiUsageRow[] };

/** The server returns at most this many rows (day × person or agent); a full page means the range was cut. */
export const AI_USAGE_ROW_LIMIT = 2000;
/** The range choices, in days (today included). The endpoint's own default is 14. */
export const AI_USAGE_RANGES = [7, 14, 30, 90] as const;
export type AiUsageRange = typeof AI_USAGE_RANGES[number];

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The from/to days (UTC, as the budgets reset at midnight UTC) of the last `days` days, today included. */
export function usageRange(days: number, nowMs = Date.now()) {
  return { from: isoDay(nowMs - (days - 1) * DAY_MS), to: isoDay(nowMs) };
}

/** Every day from `from` to `to`, oldest first (bounded at 366 so a bad range cannot hang the page). */
export function usageDays(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let at = start; at <= end && days.length < 366; at += DAY_MS) days.push(isoDay(at));
  return days;
}

export type AiUsageTotal = { id: string; name: string; runs: number; promptTokens: number; completionTokens: number; totalTokens: number };

/** One row per person or agent over the whole range, most tokens first (then name). */
export function usageTotals(rows: readonly AiUsageRow[]): AiUsageTotal[] {
  const totals = new Map<string, AiUsageTotal>();
  for (const row of rows) {
    const entry = totals.get(row.id) ?? { id: row.id, name: row.name, runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    entry.runs += row.runs;
    entry.promptTokens += row.promptTokens;
    entry.completionTokens += row.completionTokens;
    entry.totalTokens += row.promptTokens + row.completionTokens;
    totals.set(row.id, entry);
  }
  return [...totals.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
}

/** The whole range's sums, for the KPI tiles. */
export function usageSummary(rows: readonly AiUsageRow[]) {
  return rows.reduce((sum, row) => ({ runs: sum.runs + row.runs, promptTokens: sum.promptTokens + row.promptTokens, completionTokens: sum.completionTokens + row.completionTokens }), { runs: 0, promptTokens: 0, completionTokens: 0 });
}

/** Tokens per day (prompt and completion), every day of the range present, for the stacked chart. */
export function usageDailySeries(rows: readonly AiUsageRow[], from: string, to: string) {
  const days = usageDays(from, to);
  const index = new Map(days.map((day, at) => [day, at]));
  const prompt = days.map(() => 0);
  const completion = days.map(() => 0);
  for (const row of rows) {
    const at = index.get(row.day);
    if (at === undefined) continue;
    prompt[at]! += row.promptTokens;
    completion[at]! += row.completionTokens;
  }
  // "Nov 3": short labels, read in UTC like the days themselves.
  const categories = days.map((day) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }));
  return { categories, series: [{ name: "Prompt tokens", values: prompt }, { name: "Completion tokens", values: completion }] };
}

/** The query string of a usage request. */
export const usageQuery = (group: AiUsageGroup, from: string, to: string) => new URLSearchParams({ group, from, to }).toString();
