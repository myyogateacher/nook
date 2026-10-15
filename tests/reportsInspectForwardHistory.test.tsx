/**
 * Inspect after Back past the report page (D480), rendered with happy-dom on its own (the history stack
 * is module state): report → a block's ⋯ → View data (Inspect on its Data tab) → Back closes it → Back
 * to the list → Forward brings back the report → Forward reopens Inspect on the Data tab, by its layer
 * key (`reports.inspect:<blockId>:<tab>`, ReportView's opener). The in-page path (Back closes, Forward
 * reopens on the same page) still works.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useState } from "react";
import type { ReportDetail, ReportResult } from "../shared/reports";
import type { QueryResultView, ReportResultsView } from "../shared/reportsView";
import { installDom, render, type Rendered } from "./support/dom";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";

installDom("http://nook.test/reports");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ReportView } = await import("../src/reports/ReportView");
const { popStateClosedDialog, resetHistoryDialogsForTests, whenHistorySettled } = await import("../src/historyDialogs");
beforeEach(() => { resetHistoryDialogsForTests(); });
afterEach(() => { resetHistoryDialogsForTests(); });
const { act } = await import("react");

const REPORT_ID = "0b5d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";
const spec = sampleSpec();
const result = (key: string): ReportResult => {
  const query = spec.queries.find((item) => item.key === key)!;
  const answer = sampleAnswer(query.sql) as { meta: Array<{ name: string; type: string }>; data: unknown[][] };
  return {
    runId: "11111111-1111-4111-8111-111111111111", queryKey: key, sql: query.sql, sentSql: query.sql, columns: answer.meta, rows: answer.data, rowCount: answer.data.length,
    truncated: false, rowsRead: null, bytesRead: null, chQueryId: `nook-${key}`, ms: 4, error: null, errorCode: null, createdAt: "2026-10-13T08:00:00.000Z"
  };
};
const views: QueryResultView[] = spec.queries.map((query) => ({ queryKey: query.key, result: result(query.key), failed: null, stale: false }));
const initial: { results: ReportResultsView } = { results: { results: views, running: null } };
const report: ReportDetail = {
  id: REPORT_ID, title: "Revenue", datasourceId: "d", datasourceName: "Warehouse", status: "ready", isOwner: true, ownerName: "Owner", blockCount: spec.blocks.length,
  lastRunAt: "2026-10-13T09:00:00.000Z", createdAt: "2026-10-13T07:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z", revision: 1, folderId: null, scheduleCadence: null,
  spec, doc: null, lastError: null
} as ReportDetail;
const dataBlock = spec.blocks.find((block) => block.type !== "markdown")!;
const blockTitle = dataBlock.title ?? (dataBlock.type === "kpi" ? dataBlock.label ?? dataBlock.column : dataBlock.queryKey);

const moreButton = () => document.querySelector<HTMLButtonElement>(`button[aria-label="More for ${blockTitle}"]`);
const inspectTab = () => document.querySelector('.report-inspect [role="tab"][aria-selected="true"]')?.textContent ?? null;

/** Reports list ↔ report as routes: a route popstate remounts the report view, as the app does. */
function RoutedReports({ routes }: { routes: string[] }) {
  const [route, setRoute] = useState(() => String((window.history.state as Record<string, unknown> | null)?.route ?? "list"));
  const [mounts, setMounts] = useState(0);
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      routes.push("route");
      setRoute(String((event.state as Record<string, unknown> | null)?.route ?? "list"));
      setMounts((count) => count + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [routes]);
  const open = () => {
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "report", "mynotes.depth": depth + 1 }, "", `/reports/${REPORT_ID}`);
    setRoute("report");
  };
  return route === "report" ? <ReportView key={mounts} report={report} canWrite initial={initial} /> : <button type="button" onClick={open}>Open report</button>;
}

async function browser(view: Rendered, move: "back" | "forward") {
  await act(async () => { if (move === "back") window.history.back(); else window.history.forward(); await Bun.sleep(40); });
  await act(async () => { await Bun.sleep(20); });
  await view.waitFor(() => true);
}

async function viewData(view: Rendered) {
  await view.click(moreButton()!);
  await view.click(await view.waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "View data") ?? null));
  await view.waitFor(() => document.querySelector(".report-inspect"));
}

async function finishHistory(view: Rendered) {
  await view.rerender(<></>);
  let settled = false;
  whenHistorySettled(() => { settled = true; });
  await view.waitFor(() => settled);
}

describe("Inspect and Forward (D480)", () => {
  test("report → View data → Back past the page → Forward ×2 reopens Inspect on its Data tab", async () => {
    const routes: string[] = [];
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "list", "mynotes.depth": depth + 1 }, "", "/reports");
    const view = await render(<RoutedReports routes={routes} />);
    await view.click(view.button("Open report")!);
    await viewData(view);
    expect(inspectTab()).toBe("Data");
    const length = window.history.length;

    await browser(view, "back");
    expect(document.querySelector(".report-inspect")).toBeNull();
    await browser(view, "back");
    expect(view.button("Open report")).not.toBeNull();

    await browser(view, "forward");
    expect(moreButton()).not.toBeNull();
    expect(document.querySelector(".report-inspect")).toBeNull();
    await browser(view, "forward");
    await view.waitFor(() => document.querySelector(".report-inspect"));
    expect(inspectTab()).toBe("Data");
    expect(document.querySelector(".report-inspect h2")?.textContent).toBe(blockTitle);
    expect(window.history.length).toBe(length);
    expect(routes).toEqual(["route", "route"]);
    await finishHistory(view);
  });

  test("Inspect's first tab, then the Data tab: Back ×3 past the page, Forward ×3 brings back the report, Inspect, and the Data tab", async () => {
    const routes: string[] = [];
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "list", "mynotes.depth": depth + 1 }, "", "/reports");
    const view = await render(<RoutedReports routes={routes} />);
    await view.click(view.button("Open report")!);
    await view.click(document.querySelector<HTMLButtonElement>(`button[aria-label="How was ${blockTitle} built"]`)!);
    await view.waitFor(() => inspectTab() === "Query");
    await view.click(view.button("Data", document.querySelector(".report-inspect")!)!);
    expect(inspectTab()).toBe("Data");
    const length = window.history.length;

    await browser(view, "back");
    expect(inspectTab()).toBe("Query");
    await browser(view, "back");
    expect(document.querySelector(".report-inspect")).toBeNull();
    await browser(view, "back");
    expect(view.button("Open report")).not.toBeNull();

    await browser(view, "forward");
    expect(moreButton()).not.toBeNull();
    await browser(view, "forward");
    await view.waitFor(() => inspectTab() === "Query");
    await browser(view, "forward");
    await view.waitFor(() => inspectTab() === "Data");
    expect(window.history.length).toBe(length);
    expect(routes).toEqual(["route", "route"]);
    await finishHistory(view);
  });

  test("in the page: Back closes Inspect, Forward reopens it on the same tab", async () => {
    const routes: string[] = [];
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "report", "mynotes.depth": depth + 1 }, "", `/reports/${REPORT_ID}`);
    const view = await render(<RoutedReports routes={routes} />);
    await viewData(view);
    await browser(view, "back");
    expect(document.querySelector(".report-inspect")).toBeNull();
    await browser(view, "forward");
    await view.waitFor(() => document.querySelector(".report-inspect"));
    expect(inspectTab()).toBe("Data");
    expect(routes).toEqual([]);
    await finishHistory(view);
  });
});
