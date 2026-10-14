/**
 * E4: the Metrics view, rendered with happy-dom: the catalog's metrics with their check state, an edit
 * that saves a new version (the whole list, with the version it read), the empty state, ⋯ → Metrics
 * for the owner only, and "Doc changed" naming the changed metrics.
 */
import { describe, expect, test } from "bun:test";
import type { MetricCatalogView } from "../shared/reportsMetrics";
import { captureToasts, installDom, mockApi, render } from "./support/dom";

installDom("http://nook.test/reports/0b8f7c2e-1111-4111-8111-111111111111");

const { MetricsSheet, draftProblems } = await import("../src/reports/MetricsSheet");
const { overflowItems } = await import("../src/reports/ReportPage");
const { docChangedText } = await import("../src/reports/ReportGeneration");
const { whenHistorySettled } = await import("../src/historyDialogs");

const REPORT_ID = "0b8f7c2e-1111-4111-8111-111111111111";
const noop = () => undefined;
const catalog: MetricCatalogView = {
  version: 1, source: "extract", docSha256: "a".repeat(64), snapshotId: null, createdAt: new Date().toISOString(), createdBy: null,
  versions: [{ version: 1, source: "extract", createdAt: new Date().toISOString() }],
  metrics: [
    { id: "net_revenue", name: "Net revenue", definition: "Paid and shipped orders.", expression: "sum(amount)", table: "shop.orders", filters: ["_peerdb_is_deleted = 0"], final: true, grain: "total", unit: "currency:USD", timeColumn: "created_at", excerpt: "- **Net revenue**", problems: [] },
    { id: "orders", name: "Orders", definition: "", expression: "count()", table: "shop.missing", filters: [], final: false, grain: null, unit: null, timeColumn: null, excerpt: null, problems: ["No allowlisted table shop.missing"] }
  ]
};

describe("the Metrics view", () => {
  test("lists the metrics with their checks; an edit saves the whole list as a new version", async () => {
    const toasts = captureToasts();
    const api = mockApi({
      [`GET /reports/${REPORT_ID}/metrics`]: () => ({ catalog }),
      [`PUT /reports/${REPORT_ID}/metrics`]: (call) => ({ catalog: { ...catalog, version: 2, source: "edit", versions: [{ version: 2, source: "edit", createdAt: catalog.createdAt }, ...catalog.versions], metrics: (call.body as { metrics: MetricCatalogView["metrics"] }).metrics.map((metric) => ({ ...metric, problems: metric.table === "shop.missing" ? ["No allowlisted table shop.missing"] : [] })) } })
    });
    const view = await render(<MetricsSheet reportId={REPORT_ID} title="Revenue" canEdit onClose={noop} reopen={noop} />);
    const panel = await view.waitFor(() => document.querySelector(".report-metrics-panel"));
    await view.waitFor(() => panel.textContent?.includes("Net revenue"));
    expect(panel.textContent).toContain("sum(amount)");
    expect(panel.textContent).toContain("shop.orders FINAL");
    expect(panel.textContent).toContain("No allowlisted table shop.missing");
    expect(panel.querySelectorAll('[aria-label="Not checked"]').length).toBe(1);
    await view.click(panel.querySelector('button[aria-label="Edit Net revenue"]')!);
    const form = await view.waitFor(() => panel.querySelector<HTMLFormElement>("form.report-metric-form"));
    const filters = [...form.querySelectorAll("textarea")].find((item) => item.closest("label")?.textContent?.startsWith("Required filters"))!;
    const { act } = await import("react");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(filters, "_peerdb_is_deleted = 0\nstatus IN ('paid', 'shipped')");
      filters.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await view.click(view.button("Save", form)!);
    await view.waitFor(() => api.calls.some((call) => call.method === "PUT"));
    const put = api.calls.find((call) => call.method === "PUT")!.body as { expectedVersion: number; metrics: Array<{ id: string; filters: string[] }> };
    expect(put.expectedVersion).toBe(1);
    expect(put.metrics.map((metric) => [metric.id, metric.filters])).toEqual([["net_revenue", ["_peerdb_is_deleted = 0", "status IN ('paid', 'shipped')"]], ["orders", []]]);
    await view.waitFor(() => !panel.querySelector("form.report-metric-form"));
    expect(toasts.at(-1)).toEqual({ kind: "warning", message: "Saved Net revenue (version 2); 1 metric does not pass Nook's checks" });
    expect(panel.textContent).toContain("Edited");
    await new Promise<void>((resolve) => whenHistorySettled(resolve));
  });

  test("an empty catalog explains when Nook makes one; a reader cannot edit", async () => {
    mockApi({ [`GET /reports/${REPORT_ID}/metrics`]: () => ({ catalog: null }) });
    const view = await render(<MetricsSheet reportId={REPORT_ID} title="Revenue" canEdit={false} onClose={noop} reopen={noop} />);
    await view.waitFor(() => document.querySelector(".report-metrics-panel")?.textContent?.includes("No metric catalog yet"));
    expect(view.button("Add metric")).toBeNull();
    await new Promise<void>((resolve) => whenHistorySettled(resolve));
  });

  test("draft checks, ⋯ → Metrics for the owner, and Doc changed naming metrics", () => {
    const draft = { id: "Net", name: "", definition: "", expression: "", table: "", filters: "", final: false, grain: "", unit: "", timeColumn: "" };
    expect(draftProblems(draft, [])).toEqual(["The id is lower case letters, digits, and _ (starting with a letter)", "Give the metric a name", "Give the SQL expression, for example sum(amount)", "Give the table as db.table"]);
    expect(draftProblems({ ...draft, id: "net", name: "N", expression: "count()", table: "a.b" }, ["net"])).toEqual(["The id net is used by another metric"]);
    const handlers = { share: noop, rename: noop, model: noop, remove: noop };
    expect(overflowItems({ ownerWrite: true, owner: true, commands: {}, metrics: noop, ...handlers }).map((item) => item.id)).toEqual(["share", "rename", "model", "metrics", "bin"]);
    expect(overflowItems({ ownerWrite: false, owner: false, commands: {}, metrics: noop, copyLink: noop, ...handlers }).some((item) => item.id === "metrics")).toBe(false);
    const latest = { id: "s", sha256: "b".repeat(64), title: "Revenue metrics", bytes: 10, fetchedAt: "2026-10-01T00:00:00.000Z" };
    expect(docChangedText({ mainChanged: true, pages: [], latest, metricsChanged: ["Net revenue"] })).toBe("The doc (Revenue metrics) changed since this report was generated. The definition of “Net revenue” changed.");
    expect(docChangedText({ mainChanged: true, pages: [], latest, metricsChanged: ["A", "B", "C", "D"] })).toBe("The doc (Revenue metrics) changed since this report was generated. The definitions of “A”, “B”, “C” and 1 more changed.");
  });
});
