import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AI_USAGE_ROW_LIMIT, usageDailySeries, usageDays, usageQuery, usageRange, usageSummary, usageTotals, type AiUsageRow } from "../src/chat/aiUsageModel";
import { AI_TAB_LABELS, formatRoute, parseRoute } from "../src/router";
import { aiTabsFor } from "../src/settings/hubModel";

/** D1381: Settings → AI → Usage, over GET /api/agents/admin/usage (admins only). */

const rows: AiUsageRow[] = [
  { day: "2026-11-16", id: "u1", name: "Ana", runs: 2, promptTokens: 100, completionTokens: 50 },
  { day: "2026-11-15", id: "u1", name: "Ana", runs: 1, promptTokens: 10, completionTokens: 5 },
  { day: "2026-11-15", id: "u2", name: "Ben", runs: 4, promptTokens: 500, completionTokens: 300 },
  { day: "2026-10-01", id: "u2", name: "Ben", runs: 1, promptTokens: 1, completionTokens: 1 }
];

describe("AI usage model", () => {
  test("the range is the last N UTC days, today included", () => {
    const now = Date.parse("2026-11-16T23:30:00Z");
    expect(usageRange(14, now)).toEqual({ from: "2026-11-03", to: "2026-11-16" });
    expect(usageRange(1, now)).toEqual({ from: "2026-11-16", to: "2026-11-16" });
    expect(usageDays("2026-11-14", "2026-11-16")).toEqual(["2026-11-14", "2026-11-15", "2026-11-16"]);
    expect(usageDays("2026-11-16", "2026-11-14")).toEqual([]);
    expect(usageQuery("agent", "2026-11-03", "2026-11-16")).toBe("group=agent&from=2026-11-03&to=2026-11-16");
  });

  test("totals per person, most tokens first; the summary sums every row", () => {
    expect(usageTotals(rows).map((row) => [row.name, row.runs, row.totalTokens])).toEqual([["Ben", 5, 802], ["Ana", 3, 165]]);
    expect(usageSummary(rows)).toEqual({ runs: 8, promptTokens: 611, completionTokens: 356 });
  });

  test("the daily series has every day of the range, zero-filled, and ignores days outside it", () => {
    const series = usageDailySeries(rows, "2026-11-14", "2026-11-16");
    expect(series.categories).toHaveLength(3);
    expect(series.series).toEqual([{ name: "Prompt tokens", values: [0, 510, 100] }, { name: "Completion tokens", values: [0, 305, 50] }]);
    expect(AI_USAGE_ROW_LIMIT).toBe(2000);
  });
});

describe("the Usage tab", () => {
  test("is its own URL, for admins only, labelled Usage", () => {
    expect(formatRoute({ app: "settings", section: "ai", aiTab: "usage" })).toBe("/settings/ai/usage");
    expect(parseRoute("/settings/ai/usage")).toMatchObject({ app: "settings", section: "ai", aiTab: "usage" });
    expect(AI_TAB_LABELS.usage).toBe("Usage");
    expect(aiTabsFor("admin")).toContain("usage");
    expect(aiTabsFor("member")).toEqual([]);
  });

  test("reads the admin usage endpoint and says it is counts only", () => {
    const source = readFileSync(new URL("../src/chat/AiUsage.tsx", import.meta.url), "utf8");
    expect(source).toContain("/agents/admin/usage?");
    expect(source).toContain("Counts only");
    expect(readFileSync(new URL("../src/chat/AiSettings.tsx", import.meta.url), "utf8")).toContain("{usageShown && <AiUsage />}");
  });
});
