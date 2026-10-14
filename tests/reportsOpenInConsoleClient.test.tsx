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
});
