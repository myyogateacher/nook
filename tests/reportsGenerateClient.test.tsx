import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyEvent, resultLine, stepDetail, toolLabel, type ProgressStep } from "../src/reports/GenerateProgress";
import { formatValue, SpecPreview } from "../src/reports/SpecPreview";
import type { ReportResult, ReportSpec } from "../shared/reports";

/**
 * The Wave 46 client: the generation step list folds run events into steps and shows each call's SQL
 * or target and why a call was refused; the spec preview renders markdown, KPIs, and the tables of
 * chart and table blocks from the stored results (until wave 47's viewer).
 */

const event = (type: string, data: Record<string, unknown>, seq = 1) => ({ type, data, seq }) as Parameters<typeof applyEvent>[1];

describe("generation progress", () => {
  test("tool calls and results become steps; other events leave them alone", () => {
    let steps: ProgressStep[] = [];
    steps = applyEvent(steps, event("tool_call", { messageId: "r", callId: "c1", tool: "run_sql", server: "Reports", serverId: null, argsPreview: "{\"sql\":\"SELECT 1\",\"purpose\":\"check\"}" }));
    steps = applyEvent(steps, event("delta", { messageId: "r", text: "hi" }));
    expect(steps).toEqual([{ callId: "c1", tool: "run_sql", args: "{\"sql\":\"SELECT 1\",\"purpose\":\"check\"}", ok: null, result: "", durationMs: null }]);
    steps = applyEvent(steps, event("tool_result", { messageId: "r", callId: "c1", ok: false, resultPreview: "{\"error\":\"url is not allowed\",\"code\":\"GUARD\",\"guard\":\"BANNED_FUNCTION\"}", truncated: false, durationMs: 4, decision: null, proposalId: null }));
    expect(steps[0]).toMatchObject({ ok: false, durationMs: 4 });
    expect(resultLine(steps[0]!)).toBe("BANNED_FUNCTION: url is not allowed");
    expect(toolLabel("run_sql")).toBe("Run SQL");
    expect(toolLabel("other")).toBe("other");
  });

  test("a step shows the SQL (even from a cut preview), the tables or query, or a spec's size", () => {
    expect(stepDetail("run_sql", "{\"sql\":\"SELECT 1\",\"purpose\":\"Check\"}")).toEqual({ code: "SELECT 1", text: "Check" });
    expect(stepDetail("run_sql", "{\"sql\":\"SELECT a\\nFROM t WHERE")).toEqual({ code: "SELECT a\nFROM t WHERE…", text: null });
    expect(stepDetail("describe_tables", "{\"tables\":[\"analytics.orders\",\"analytics.signups\"]}")).toEqual({ code: null, text: "analytics.orders, analytics.signups" });
    expect(stepDetail("search_schema", "{\"query\":\"orders\"}")).toEqual({ code: null, text: "“orders”" });
    expect(stepDetail("submit_report", "{\"blocks\":[{},{}],\"queries\":[{}]}")).toEqual({ code: null, text: "2 blocks, 1 query" });
    expect(resultLine({ tool: "submit_report", ok: false, result: "The spec was not saved:\n- block x: y" })).toBe("The spec was not saved:\n- block x: y");
    expect(resultLine({ tool: "submit_report", ok: true, result: "Saved: 3 blocks, 2 queries." })).toBe("Saved: 3 blocks, 2 queries.");
    expect(resultLine({ tool: "run_sql", ok: true, result: "{}" })).toBeNull();
  });
});

describe("spec preview", () => {
  const spec: ReportSpec = {
    version: 1,
    queries: [{ key: "daily", sql: "SELECT 1", purpose: "", createdBy: "agent" }, { key: "totals", sql: "SELECT 2", purpose: "", createdBy: "agent" }],
    blocks: [
      { id: "intro", type: "markdown", markdown: "## Revenue\nNet of refunds." },
      { id: "total", type: "kpi", queryKey: "totals", column: "total", format: "currency", label: "Total revenue" },
      { id: "chart", type: "chart", title: "Revenue per day", queryKey: "daily", kind: "stacked_bar", x: "day", y: ["revenue"] },
      { id: "table", type: "table", title: "Days", queryKey: "daily", columns: ["day"] },
      { id: "lost", type: "table", queryKey: "missing" }
    ]
  };
  const result = (queryKey: string, columns: Array<[string, string]>, rows: unknown[][]): ReportResult => ({
    runId: "r", queryKey, sql: "", sentSql: null, columns: columns.map(([name, type]) => ({ name, type })), rows, rowCount: rows.length, truncated: false,
    rowsRead: null, bytesRead: null, chQueryId: null, ms: 1, error: null, errorCode: null, createdAt: "2026-10-13T00:00:00.000Z"
  });

  test("markdown, a KPI in its format, and chart and table blocks as tables of their stored result", () => {
    const markup = renderToStaticMarkup(<SpecPreview spec={spec} results={[
      result("daily", [["day", "Date"], ["revenue", "Float64"]], [["2026-10-01", 120.5], ["2026-10-02", null]]),
      result("totals", [["total", "Float64"]], [[361.75]])
    ]} />);
    expect(markup).toContain("chat-md-h2\">Revenue</h3>");
    expect(markup).toContain("Revenue");
    expect(markup).toContain("Total revenue");
    expect(markup).toContain("$361.75");
    expect(markup).toContain("Stacked bar chart of revenue by day");
    expect(markup).toContain("120.5");
    expect(markup).toContain('<td class="report-null">NULL</td>');
    // The table block shows only its columns.
    expect(markup.split("aria-label=\"Rows of daily\"").length).toBe(3);
    expect(markup).toContain("No stored result for missing yet.");
  });

  test("formats", () => {
    expect(formatValue("1234.5", "integer")).toBe("1,235");
    expect(formatValue(0.256, "percent")).toBe("25.6%");
    expect(formatValue(2_500_000, "bytes")).toBe("2.5 MB");
    expect(formatValue(90, "duration_s")).toBe("1.5 min");
    expect(formatValue(null, "number")).toBe("—");
    expect(formatValue("DE", undefined)).toBe("DE");
  });
});
