/**
 * Inspect → "Open in console", rendered with happy-dom: on a report with blocks, a block's Inspect →
 * Query → "Open in console" opens the SQL console panel with the block's saved SQL in it.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ReportDetail } from "../shared/reports";
import { installDom, mockApi, render } from "./support/dom";
import { sampleSpec } from "./support/reportSeed";

installDom("http://nook.test/reports/0b8f7c2e-1111-4111-8111-111111111111");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ReportPage } = await import("../src/reports/ReportPage");
const { RoleContext } = await import("../src/team/roleAccess");
const { whenHistorySettled } = await import("../src/historyDialogs");

const REPORT_ID = "0b8f7c2e-1111-4111-8111-111111111111";
const spec = sampleSpec();
const report: ReportDetail = {
  id: REPORT_ID, title: "Revenue", datasourceId: "ds-1", datasourceName: "Analytics", status: "ready", isOwner: true, ownerName: "Me",
  blockCount: spec.blocks.length, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", revision: 1,
  spec, doc: null, lastError: null
};
const noop = () => undefined;

describe("Inspect → Open in console", () => {
  test("opens the SQL console panel prefilled with the block's saved SQL", async () => {
    // A console draft from earlier is replaced by the block's SQL.
    window.sessionStorage.setItem(`mynotes:reports-console:${REPORT_ID}`, "SELECT 1");
    mockApi({ [`GET /reports/${REPORT_ID}`]: () => ({ report }) });
    const view = await render(<RoleContext.Provider value="admin">
      <ReportPage reportId={REPORT_ID} displayName="Me" flash={noop} onBack={noop} onSettings={noop} onSignOut={noop} onGone={noop} />
    </RoleContext.Provider>);
    const inspect = await view.waitFor(() => document.querySelector('[aria-label="How was Revenue and refunds per day built"]'));
    await view.click(inspect);
    const dialog = await view.waitFor(() => document.querySelector(".report-inspect"));
    const open = await view.waitFor(() => view.button("Open in console", dialog));
    await view.click(open);
    const textarea = await view.waitFor(() => document.querySelector<HTMLTextAreaElement>(".report-console-sheet textarea.report-sql"));
    const daily = spec.queries.find((query) => query.key === "daily")!;
    expect(textarea.value).toBe(daily.sql);
    expect(view.button("Run", document.querySelector(".report-console-sheet")!)?.disabled).toBe(false);
    // Inspect stays open under the panel; closing the panel goes back to it.
    expect(document.querySelector(".report-inspect")).not.toBeNull();
    await view.click(document.querySelector('.report-console-sheet button[aria-label="Close"]')!);
    await view.waitFor(() => !document.querySelector(".report-console-sheet"));
    expect(view.button("Open in console", document.querySelector(".report-inspect")!)).not.toBeNull();
    // Close Inspect too and let its history moves land, so no dialog layer outlives this file.
    await view.click(document.querySelector('.report-inspect button[aria-label="Close"]')!);
    await view.waitFor(() => !document.querySelector(".report-inspect"));
    let settled = false;
    whenHistorySettled(() => { settled = true; });
    await view.waitFor(() => settled);
  });

  test("D490: a saved query's {name:Type} placeholders get a typed input each, prefilled with the shown values; Run binds them as params", async () => {
    window.sessionStorage.removeItem(`mynotes:reports-console:${REPORT_ID}`);
    const base = sampleSpec();
    const sql = "SELECT day, sum(revenue) AS revenue, sum(refunds) AS refunds FROM analytics.orders WHERE day >= {period_from:Date} AND day <= {period_to:Date} AND (empty({plans:Array(String)}) OR plan IN {plans:Array(String)}) AND note != {note:String} GROUP BY day ORDER BY day";
    const paramSpec = {
      ...base, specVersion: 3,
      parameters: [
        { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } },
        { id: "plans", label: "Plan", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT plan FROM analytics.orders" },
        { id: "note", label: "Note", type: "text", chType: "String", default: "" }
      ],
      queries: base.queries.map((query) => query.key === "daily" ? { ...query, sql } : query)
    } as ReportDetail["spec"];
    const bound = { period_from: "2026-09-01", period_to: "2026-09-30", plans: "['pro']", note: "a\\tb" };
    const daily = { runId: "", queryKey: "daily", sql, sentSql: `SELECT * FROM (\n${sql}\n) LIMIT 10001`, columns: [{ name: "day", type: "Date" }, { name: "revenue", type: "Float64" }, { name: "refunds", type: "Float64" }],
      rows: [["2026-09-01", 10, 1]], rowCount: 1, truncated: false, rowsRead: 1, bytesRead: 8, chQueryId: "nook-x-daily", ms: 3, error: null, errorCode: null, createdAt: "2026-10-01T00:00:00.000Z", params: bound };
    const api = mockApi({
      [`GET /reports/${REPORT_ID}`]: () => ({ report: { ...report, spec: paramSpec } }),
      [`GET /reports/${REPORT_ID}/results`]: () => ({ results: [{ queryKey: "daily", result: daily, failed: null, stale: false }], running: null }),
      [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
      [`GET /reports/${REPORT_ID}/parameters/plans/options`]: () => ({ options: { paramId: "plans", options: ["pro", "team"], truncated: false, error: null, at: null } }),
      [`POST /reports/${REPORT_ID}/console`]: () => ({ outcome: { class: "select", columns: [{ name: "day", type: "Date" }], rows: [["2026-09-02"]], truncated: false, sentSql: "SELECT 1", chQueryId: "nook-console-x", rowsRead: 1, bytesRead: 1, ms: 2 } })
    });
    const view = await render(<RoleContext.Provider value="admin">
      <ReportPage reportId={REPORT_ID} displayName="Me" flash={noop} onBack={noop} onSettings={noop} onSignOut={noop} onGone={noop} />
    </RoleContext.Provider>);
    await view.click(await view.waitFor(() => document.querySelector('[aria-label="How was Revenue and refunds per day built"]')));
    const dialog = await view.waitFor(() => document.querySelector(".report-inspect"));
    await view.click(await view.waitFor(() => view.button("Open in console", dialog)));
    const sheet = await view.waitFor(() => document.querySelector(".report-console-sheet"));
    const inputs = await view.waitFor(() => { const found = [...sheet.querySelectorAll<HTMLInputElement>(".report-console-param input")]; return found.length ? found : null; });
    // One input per placeholder name, typed (a date picker for Date), prefilled as typed (a String unescaped).
    expect([...sheet.querySelectorAll(".report-console-param code")].map((item) => item.textContent)).toEqual(["{period_from:Date}", "{period_to:Date}", "{plans:Array(String)}", "{note:String}"]);
    expect(inputs.map((input) => input.type)).toEqual(["date", "date", "text", "text"]);
    expect(inputs.map((input) => input.value)).toEqual(["2026-09-01", "2026-09-30", "['pro']", "a\tb"]);
    // A value that does not fit its type disables Run.
    const { act } = await import("react");
    const setValue = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await setValue(inputs[2]!, "['pro'");
    expect(view.button("Run", sheet)?.disabled).toBe(true);
    expect(sheet.querySelector(".report-console-param .form-error")?.textContent).toContain("list");
    await setValue(inputs[2]!, "['pro', 'team']");
    expect(view.button("Run", sheet)?.disabled).toBe(false);
    await view.click(view.button("Run", sheet)!);
    await view.waitFor(() => sheet.querySelector(".report-result"));
    const call = api.calls.find((item) => item.method === "POST" && item.path.endsWith("/console"))!;
    expect(call.body).toEqual({ sql, params: { period_from: "2026-09-01", period_to: "2026-09-30", plans: "['pro', 'team']", note: "a\tb" } });
    await view.click(document.querySelector('.report-console-sheet button[aria-label="Close"]')!);
    await view.waitFor(() => !document.querySelector(".report-console-sheet"));
    await view.click(document.querySelector('.report-inspect button[aria-label="Close"]')!);
    await view.waitFor(() => !document.querySelector(".report-inspect"));
    let settled = false;
    whenHistorySettled(() => { settled = true; });
    await view.waitFor(() => settled);
  });
});
