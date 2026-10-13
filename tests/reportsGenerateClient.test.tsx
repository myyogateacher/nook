import { describe, expect, test } from "bun:test";
import { applyEvent, resultLine, stepDetail, toolLabel, type ProgressStep } from "../src/reports/GenerateProgress";

/**
 * The Wave 46 client: the generation step list folds run events into steps and shows each call's SQL
 * or target and why a call was refused (the spec preview it once had is wave 47's viewer now,
 * tests/reportsViewClient.test.tsx).
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
