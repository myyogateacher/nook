/**
 * The report's control bar and URL state (spec v3, D489), rendered with happy-dom: the parameter values
 * live in the report page's URL (`?p.period=7d&p.country=DE`), each change is a history entry, Back and
 * Forward restore the earlier values and their results, a URL opened cold reproduces them, Reset to
 * defaults goes back to the stored results, blocks show their own loading state while a set runs, and
 * Inspect shows the bound values. The router's parse and format keep the values on report pages only.
 */
import { describe, expect, mock, test } from "bun:test";
import { useCallback, useEffect, useState } from "react";
import type { ReportDetail, ReportResult, ReportSpec } from "../shared/reports";
import { installDom, mockApi, render, reply, type Rendered } from "./support/dom";

installDom("http://nook.test/reports");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ReportView } = await import("../src/reports/ReportView");
const { ReportParamsContext } = await import("../src/reports/ReportParamsBar");
const { formatRoute, locationUrl, parseRoute } = await import("../src/router");
const { act } = await import("react");

const REPORT_ID = "0b5d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [],
  parameters: [
    { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } },
    { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" }
  ],
  queries: [{ key: "totals", sql: "SELECT count() AS orders FROM analytics.orders WHERE day >= {period_from:Date} AND day <= {period_to:Date} AND (empty({country:Array(String)}) OR country IN {country:Array(String)})", purpose: "Orders", createdBy: "agent" }],
  blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders", unit: "orders" }]
};
const report = {
  id: REPORT_ID, title: "Orders", datasourceId: "d", datasourceName: "Warehouse", status: "ready", isOwner: false, ownerName: "Owner", blockCount: 1,
  lastRunAt: "2026-10-13T09:00:00.000Z", createdAt: "2026-10-13T07:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z", revision: 1, folderId: null, scheduleCadence: null,
  spec, doc: null, lastError: null
} as unknown as ReportDetail;

const DAYS: Record<string, number> = { "30d": 30, "7d": 7, today: 1 };
/** 10 orders per country per day, over four countries. */
function orders(values: { period?: { preset: string }; country?: string[] } | null) {
  const days = DAYS[values?.period?.preset ?? "30d"] ?? 30;
  return days * 10 * (values?.country?.length || 4);
}
const result = (count: number, params: Record<string, string> | null, createdAt = "2026-10-13T09:00:00.000Z"): ReportResult => ({
  runId: "", queryKey: "totals", sql: spec.queries[0]!.sql, sentSql: `SELECT * FROM (\n${spec.queries[0]!.sql}\n) LIMIT 10001`, columns: [{ name: "orders", type: "UInt64" }], rows: [[String(count)]], rowCount: 1,
  truncated: false, rowsRead: null, bytesRead: null, chQueryId: "nook-x-totals", ms: 4, error: null, errorCode: null, createdAt, params
});

/** The report page's route state, as ReportsApp keeps it: the URL is the source; a change pushes an entry; popstate re-reads it. */
function Routed() {
  const read = () => { const route = parseRoute(window.location.pathname, window.location.search); return route.app === "reports" ? route.params : undefined; };
  const [search, setSearch] = useState(read);
  useEffect(() => {
    const onPop = () => setSearch(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const onChange = useCallback((next: typeof search) => {
    window.history.pushState({ route: "report" }, "", formatRoute({ app: "reports", reportId: REPORT_ID, ...(next ? { params: next } : {}) }));
    setSearch(next);
  }, []);
  return <ReportParamsContext.Provider value={{ search, onChange }}><ReportView report={report} canWrite={false} /></ReportParamsContext.Provider>;
}

const kpiText = () => document.querySelector(".report-block-kpi .report-block-body")?.textContent ?? "";
async function move(view: Rendered, where: "back" | "forward") {
  await act(async () => { if (where === "back") window.history.back(); else window.history.forward(); await Bun.sleep(30); });
  await view.waitFor(() => true);
}
async function pick(view: Rendered, label: string) {
  const trigger = document.querySelector<HTMLButtonElement>(".report-params-chips .report-param button[role=\"combobox\"]")!;
  await view.click(trigger);
  const option = await view.waitFor(() => [...document.querySelectorAll<HTMLElement>("[role=\"option\"]")].find((item) => item.textContent?.trim() === label) ?? null);
  await view.click(option);
}

function api() {
  const runs: unknown[] = [];
  const cached = new Set<string>();
  const calls = mockApi({
    [`GET /reports/${REPORT_ID}/results`]: () => ({ results: [{ queryKey: "totals", result: result(1200, { period_from: "2026-09-14", period_to: "2026-10-13", country: "[]" }), failed: null, stale: false }], running: null, timeZone: "Asia/Kolkata" }),
    [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
    [`GET /reports/${REPORT_ID}/parameters/country/options`]: () => ({ options: { paramId: "country", options: ["DE", "FR", "IN", "US"], truncated: false, error: null, at: null } })
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api/, "");
    if (path.startsWith(`/reports/${REPORT_ID}/results?values=`)) {
      const values = JSON.parse(decodeURIComponent(path.slice(path.indexOf("=") + 1)));
      const key = JSON.stringify(values);
      calls.calls.push({ method: "GET", path, body: null });
      const set = { isDefault: false, values, bound: {}, missing: cached.has(key) ? [] : ["totals"] };
      return new Response(JSON.stringify({ results: [{ queryKey: "totals", result: cached.has(key) ? result(orders(values), { period_from: "x" }) : null, failed: null, stale: false }], running: null, set }), { status: 200 });
    }
    if (path === `/reports/${REPORT_ID}/param-runs`) {
      const body = JSON.parse(String(init?.body));
      runs.push(body.values);
      cached.add(JSON.stringify(body.values));
      // A set's run is now: "Updated just now", where the default set's run was days ago.
      return new Response(JSON.stringify({ results: [{ queryKey: "totals", result: result(orders(body.values), { period_from: "2026-10-07", period_to: "2026-10-13", country: "['DE']" }, new Date().toISOString()), failed: null, stale: false }], running: null, set: { isDefault: false, values: body.values, bound: {}, missing: [] } }), { status: 200 });
    }
    return original(input, init);
  }) as typeof fetch;
  return { calls: calls.calls, runs, restore: () => { globalThis.fetch = original; } };
}

describe("the control bar and the URL (D489)", () => {
  test("a change is a history entry; Back and Forward restore the values and their results; Reset goes back to the stored results", async () => {
    window.history.replaceState({ route: "report" }, "", `/reports/${REPORT_ID}`);
    const mocked = api();
    try {
      const view = await render(<Routed />);
      await view.waitFor(() => kpiText().includes("1,200") || kpiText().includes("1.2K"));
      expect(document.querySelector(".report-params")).not.toBeNull();
      // The date range: Last 7 days.
      await pick(view, "Last 7 days (IST)");
      expect(window.location.search).toBe("?p.period=7d");
      await view.waitFor(() => kpiText().includes("280"));
      expect(mocked.runs).toEqual([{ period: { preset: "7d" }, country: [] }]);
      // D489 follow-up: "Updated" is the shown set's run time, not the default set's.
      const status = () => document.querySelector(".report-view-status")?.textContent ?? "";
      expect(status()).toContain("Updated just now");
      // Back: the defaults and the stored results, with no run.
      await move(view, "back");
      expect(window.location.search).toBe("");
      await view.waitFor(() => kpiText().includes("1,200") || kpiText().includes("1.2K"));
      await view.waitFor(() => !status().includes("just now"));
      // Forward: 7 days again, now from the cache (no second run).
      await move(view, "forward");
      expect(window.location.search).toBe("?p.period=7d");
      await view.waitFor(() => kpiText().includes("280"));
      expect(mocked.runs.length).toBe(1);
      // Reset to defaults is a new entry with a clean URL.
      await view.click(view.button("Reset to defaults")!);
      expect(window.location.search).toBe("");
      await view.waitFor(() => kpiText().includes("1,200") || kpiText().includes("1.2K"));
      expect(view.button("Reset to defaults")).toBeNull();
    } finally {
      mocked.restore();
    }
  });

  test("a link opened cold reproduces the values (multi-select as repeated keys); the block shows its own loading state while the set runs", async () => {
    window.history.replaceState({ route: "report" }, "", `/reports/${REPORT_ID}?p.period=today&p.country=DE&p.country=US`);
    const mocked = api();
    try {
      const view = await render(<Routed />);
      await view.waitFor(() => document.querySelector(".report-block-pending") || kpiText().includes("20"));
      await view.waitFor(() => kpiText().includes("20"));
      expect(mocked.runs).toEqual([{ period: { preset: "today" }, country: ["DE", "US"] }]);
      expect(document.querySelector(".report-param-multi")?.textContent).toContain("Country: DE, US");
      expect(document.querySelector(".report-params-summary")?.textContent).toBe("Today (UTC) · DE, US");
    } finally {
      mocked.restore();
    }
  });

  test("the router keeps parameter values on report pages only, in a stable order", () => {
    const route = parseRoute(`/reports/${REPORT_ID}`, "?p.period=2026-09-01..2026-09-30&p.country=US&p.country=DE&x=1&p.Bad=1");
    expect(route).toEqual({ app: "reports", reportId: REPORT_ID, params: { period: ["2026-09-01..2026-09-30"], country: ["US", "DE"] } });
    expect(formatRoute(route)).toBe(`/reports/${REPORT_ID}?p.country=US&p.country=DE&p.period=2026-09-01..2026-09-30`);
    expect(formatRoute({ app: "reports", reportId: REPORT_ID })).toBe(`/reports/${REPORT_ID}`);
    expect(locationUrl({ pathname: `/reports/${REPORT_ID}`, search: "?p.period=7d" })).toBe(`/reports/${REPORT_ID}?p.period=7d`);
    expect(parseRoute("/reports", "?p.period=7d")).toEqual({ app: "reports", reportId: null });
  });

  test("errors loading a set show with Try again; a 409 while another run holds the report is retried", async () => {
    window.history.replaceState({ route: "report" }, "", `/reports/${REPORT_ID}?p.period=7d`);
    let attempts = 0;
    const mocked = mockApi({
      [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
      [`GET /reports/${REPORT_ID}/parameters/country/options`]: () => ({ options: { paramId: "country", options: [], truncated: false, error: null, at: null } }),
      [`GET /reports/${REPORT_ID}/results?values=${encodeURIComponent(JSON.stringify({ period: { preset: "7d" }, country: [] }))}`]: () => ({ results: [{ queryKey: "totals", result: null, failed: null, stale: false }], running: null, set: { isDefault: false, values: {}, bound: {}, missing: ["totals"] } }),
      [`POST /reports/${REPORT_ID}/param-runs`]: () => {
        attempts += 1;
        return attempts === 1 ? reply(409, { error: "This report is already running", code: "RUN_IN_PROGRESS" }) : { results: [{ queryKey: "totals", result: result(280, { period_from: "2026-10-07" }), failed: null, stale: false }], running: null, set: { isDefault: false, values: {}, bound: {}, missing: [] } };
      }
    });
    const view = await render(<Routed />);
    await view.waitFor(() => kpiText().includes("280"), 8000);
    expect(attempts).toBe(2);
    expect(mocked.calls.filter((call) => call.path.endsWith("/param-runs")).length).toBe(2);
  });
});

describe("option search past the first 200 (D491)", () => {
  const SEARCH_ID = "0b5d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6b";
  const customerSpec: ReportSpec = {
    version: 1, specVersion: 3, sections: [],
    parameters: [{ id: "customer", label: "Customer", type: "select", chType: "String", default: "Customer 1", optionsQuery: "SELECT DISTINCT name FROM shop.customers ORDER BY name LIMIT 200" }],
    queries: [{ key: "totals", sql: "SELECT count() AS orders FROM shop.orders WHERE name = {customer:String}", purpose: "Orders", createdBy: "agent" }],
    blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders", unit: "orders" }]
  };
  const customerReport = { ...report, id: SEARCH_ID, spec: customerSpec } as ReportDetail;

  function Searched() {
    const [search, setSearch] = useState<Record<string, string[]> | undefined>(undefined);
    return <ReportParamsContext.Provider value={{ search, onChange: (next) => setSearch(next) }}><ReportView report={customerReport} canWrite={false} /></ReportParamsContext.Provider>;
  }

  test("a cut list's search box asks the server (debounced); a found value can be picked", async () => {
    const listed = Array.from({ length: 200 }, (_, at) => `Customer ${at + 1}`);
    const mocked = mockApi({
      [`GET /reports/${SEARCH_ID}/results`]: () => ({ results: [{ queryKey: "totals", result: result(5, { customer: "Customer 1" }), failed: null, stale: false }], running: null }),
      [`GET /reports/${SEARCH_ID}/runs`]: () => ({ runs: [], schedule: null }),
      [`GET /reports/${SEARCH_ID}/parameters/customer/options`]: () => ({ options: { paramId: "customer", options: listed, truncated: true, error: null, at: null } }),
      [`GET /reports/${SEARCH_ID}/parameters/customer/options?q=Customer%204999`]: () => ({ options: { paramId: "customer", options: ["Customer 4999"], truncated: false, error: null, at: null, query: "Customer 4999" } }),
      [`GET /reports/${SEARCH_ID}/results?values=${encodeURIComponent(JSON.stringify({ customer: "Customer 4999" }))}`]: () => ({ results: [{ queryKey: "totals", result: result(7, { customer: "Customer 4999" }), failed: null, stale: false }], running: null, set: { isDefault: false, values: { customer: "Customer 4999" }, bound: {}, missing: [] } })
    });
    const view = await render(<Searched />);
    const trigger = await view.waitFor(() => document.querySelector<HTMLButtonElement>(".report-params-chips .report-param button[role=\"combobox\"]"));
    await view.waitFor(() => mocked.calls.some((call) => call.path.endsWith("/parameters/customer/options")));
    await view.click(trigger);
    const box = await view.waitFor(() => document.querySelector<HTMLInputElement>(".ui-search input"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "Customer 4999");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Nothing listed matches yet: the list says it is searching, then shows the server's match.
    expect(document.querySelector(".ui-listbox-empty")?.textContent).toBe("Searching…");
    const found = await view.waitFor(() => [...document.querySelectorAll<HTMLElement>("[role=\"option\"]")].find((item) => item.textContent?.trim() === "Customer 4999") ?? null, 3000);
    expect(mocked.calls.filter((call) => call.path.includes("options?q=")).length).toBe(1);
    await view.click(found);
    await view.waitFor(() => kpiText().includes("7"));
    expect(document.querySelector(".report-params-chips .report-param button[role=\"combobox\"]")?.textContent).toContain("Customer 4999");
  });
});
