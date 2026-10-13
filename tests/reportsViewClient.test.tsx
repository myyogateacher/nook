import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import type { ChartBlock, KpiBlock, ReportDetail, ReportResult, TableBlock } from "../shared/reports";
import type { QueryResultView, ReportResultsView } from "../shared/reportsView";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";

// ECharts is mocked: the lazy chart module renders what it was given, so the tests see the option.
const drawn: Array<{ label: string; option: Record<string, unknown> }> = [];
mock.module("../src/reports/charts", () => ({
  default: ({ option, label }: { option: Record<string, unknown>; label: string }) => {
    drawn.push({ label, option });
    return <div className="mock-echart" data-label={label} data-series={(option.series as unknown[]).length} />;
  }
}));

const { buildChartOption, CHART_PALETTES, formatValue, optionJson, toNumber, axisLabel, MAX_CHART_SERIES } = await import("../src/reports/chartOption");
const { ReportView } = await import("../src/reports/ReportView");
const { InspectSheet, blockMapping, docLink } = await import("../src/reports/InspectSheet");
const { createInspectTabHistory, inspectMark: inspectMarkOf } = await import("../src/reports/inspectHistory");
type InspectTab = import("../src/reports/inspectHistory").InspectTab;
const { themedPalette } = await import("../src/reports/chartOption");
const { kpiValue } = await import("../src/reports/KpiTile");
const { toCsv, runLabel, timeAgo } = await import("../src/reports/reportViewApi");
const { scheduleBadge, scheduleForm, scheduleInput } = await import("../src/reports/ScheduleSheet");
const { readHistoryDepth, withHistoryDepth } = await import("../src/appShellNavigation");
// A private copy of historyDialogs: its sentinel and guard stack are module state that other test
// files in this process may leave in use; these history tests need a clean one.
const { acquireDialogSentinel, dialogPopDirection, popStateClosedDialog, registerHistoryDialogGuard, undoDialogPop } = await import("../src/historyDialogs.ts?reports-inspect-tests");

/**
 * The Wave 47 viewer: chart options built only from the block spec (both palettes), formats, KPI
 * tiles, the report view over its results (stale and error badges, inspect buttons), the inspect
 * sheet's four tabs, its tabs as Back steps, CSV export, and the schedule form.
 */

const spec = sampleSpec();
const result = (key: string, runId = "11111111-1111-4111-8111-111111111111", createdAt = "2026-10-13T08:00:00.000Z"): ReportResult => {
  const answer = sampleAnswer(spec.queries.find((query) => query.key === key)!.sql) as { meta: Array<{ name: string; type: string }>; data: unknown[][]; rowsRead?: number };
  return {
    runId, queryKey: key, sql: spec.queries.find((query) => query.key === key)!.sql, sentSql: `SELECT * FROM (\n${spec.queries.find((query) => query.key === key)!.sql}\n) LIMIT 10001`,
    columns: answer.meta, rows: answer.data, rowCount: answer.data.length, truncated: false, rowsRead: answer.rowsRead ?? null, bytesRead: null,
    chQueryId: `nook-1111-${key}`, ms: 42, error: null, errorCode: null, createdAt
  };
};
const failedResult = (key: string): ReportResult => ({ ...result(key, "22222222-2222-4222-8222-222222222222", "2026-10-13T09:00:00.000Z"), sentSql: null, columns: [], rows: [], rowCount: 0, rowsRead: null, ms: 5, error: "Memory limit exceeded", errorCode: "CLICKHOUSE" });
const chart = (overrides: Partial<ChartBlock> = {}): ChartBlock => ({ ...(spec.blocks.find((block) => block.id === "daily-line") as ChartBlock), ...overrides });
const dark = CHART_PALETTES.dark;

describe("chart options", () => {
  test("a line chart: categories from x, one series per y, numbers from ClickHouse strings, the palette, a legend for two series", () => {
    const built = buildChartOption(chart(), result("daily"), dark);
    expect(built.problems).toEqual([]);
    const option = built.option!;
    expect(option.color).toEqual(dark.series);
    expect((option.xAxis as { data: string[] }).data[0]).toBe("2026-10-01");
    const series = option.series as Array<{ type: string; name: string; data: number[] }>;
    expect(series.map((item) => [item.type, item.name])).toEqual([["line", "revenue"], ["line", "refunds"]]);
    expect(typeof series[0]!.data[0]).toBe("number");
    expect((option.legend as { show: boolean }).show).toBe(true);
    expect(built.mapped).toEqual({ day: "x", revenue: "y1", refunds: "y2" });
    // Formatters are Nook's, by name.
    expect(optionJson(option)).toContain("\"ƒ axis:currency\"");
    expect(optionJson(option)).toContain("\"ƒ tooltip:currency\"");
  });

  test("bar kinds, pie, scatter, and area", () => {
    const bars = buildChartOption(chart({ kind: "stacked_bar" }), result("daily"), dark).option!;
    expect((bars.series as Array<{ type: string; stack: string }>).every((item) => item.type === "bar" && item.stack === "total")).toBe(true);
    const horizontal = buildChartOption(chart({ kind: "horizontal_bar", x: "day", y: ["revenue"] }), result("daily"), dark).option!;
    expect((horizontal.xAxis as { type: string }).type).toBe("value");
    expect((horizontal.yAxis as { type: string; inverse: boolean })).toMatchObject({ type: "category", inverse: true });
    expect((horizontal.legend as { show: boolean }).show).toBe(false);
    const pie = buildChartOption(chart({ kind: "pie", x: "country", y: ["revenue"], queryKey: "by_country" }), result("by_country"), dark).option!;
    const pieSeries = (pie.series as Array<{ type: string; data: Array<{ name: string; value: number }> }>)[0]!;
    expect(pieSeries.type).toBe("pie");
    expect(pieSeries.data[0]).toEqual({ name: "US", value: 14000 });
    const area = buildChartOption(chart({ kind: "area" }), result("daily"), dark).option!;
    expect((area.series as Array<{ areaStyle?: unknown }>)[0]!.areaStyle).toBeTruthy();
    const scatter = buildChartOption(chart({ kind: "scatter", x: "revenue", y: ["refunds"] }), result("daily"), dark).option!;
    expect((scatter.xAxis as { type: string }).type).toBe("value");
  });

  test("a series column pivots long rows; past eight series the rest fold into Other", () => {
    const columns = [{ name: "week", type: "Date" }, { name: "country", type: "String" }, { name: "revenue", type: "Float64" }];
    const rows = ["2026-01-05", "2026-01-12"].flatMap((week) => Array.from({ length: 10 }, (_, index) => [week, `C${index}`, 100 - index]));
    const built = buildChartOption(chart({ x: "week", y: ["revenue"], series: "country", kind: "bar" }), { columns, rows }, dark);
    const series = built.option!.series as Array<{ name: string; data: number[] }>;
    expect(series.length).toBe(MAX_CHART_SERIES);
    expect(series.at(-1)).toMatchObject({ name: "Other", data: [93 + 92 + 91, 93 + 92 + 91] });
    expect(series[0]).toMatchObject({ name: "C0", data: [100, 100] });
    expect(built.foldedSeries).toBe(3);
    expect((built.option!.xAxis as { data: string[] }).data).toEqual(["2026-01-05", "2026-01-12"]);
  });

  test("missing columns are problems, not a chart; nothing outside the spec's fields reaches the option", () => {
    expect(buildChartOption(chart({ y: ["nope"] }), result("daily"), dark)).toMatchObject({ option: null, problems: ["The result has no column \"nope\" for y"] });
    const sneaky = { ...chart(), option: { graphic: [{ type: "image", style: { image: "https://evil.test/x.png" } }] }, formatter: "{a}<img src=x onerror=alert(1)>" } as unknown as ChartBlock;
    const json = optionJson(buildChartOption(sneaky, result("daily"), dark).option);
    expect(json).not.toContain("evil.test");
    expect(json).not.toContain("onerror");
    expect(json).not.toContain("graphic");
  });

  test("the tooltip escapes names and values (it renders as HTML)", () => {
    const columns = [{ name: "x", type: "String" }, { name: "y", type: "Float64" }];
    const option = buildChartOption(chart({ x: "x", y: ["y"] }), { columns, rows: [["<img src=x onerror=alert(1)>", 1]] }, dark).option!;
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    const html = formatter([{ seriesName: "<b>y</b>", name: "<img src=x onerror=alert(1)>", value: 1234.5, color: "#3987e5" }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;y&lt;/b&gt;");
    expect(formatter([{ seriesName: "y", name: "a", value: 1, color: "url(javascript:alert(1))" }])).not.toContain("javascript");
  });

  test("both palettes are eight fixed hues with their own text tokens", () => {
    for (const palette of [CHART_PALETTES.dark, CHART_PALETTES.light]) {
      expect(palette.series.length).toBe(8);
      expect(new Set(palette.series).size).toBe(8);
      expect(palette.text).not.toBe(palette.surface);
    }
    expect(CHART_PALETTES.light.text).not.toBe(CHART_PALETTES.dark.text);
    const light = buildChartOption(chart(), result("daily"), CHART_PALETTES.light).option!;
    expect(light.color).toEqual(CHART_PALETTES.light.series);
    expect((light.textStyle as { color: string }).color).toBe(CHART_PALETTES.light.text);
  });

  test("values and formats", () => {
    expect([toNumber("12.50"), toNumber("1312"), toNumber("1e3"), toNumber("abc"), toNumber(""), toNumber(null), toNumber(true)]).toEqual([12.5, 1312, 1000, null, null, null, 1]);
    expect(formatValue("48210.5", "currency")).toBe("48,210.50");
    expect(formatValue("1312", "integer")).toBe("1,312");
    expect(formatValue(0.256, "percent")).toBe("25.6%");
    expect(formatValue(1536, "bytes")).toBe("1.5 KiB");
    expect(formatValue(3725, "duration_s")).toBe("1h 2m");
    expect(formatValue("2026-10-13 08:00:00", "date")).toBe("2026-10-13");
    expect(formatValue(null, "number")).toBe("—");
    expect(formatValue("hello", "currency")).toBe("hello");
    expect([axisLabel(12_345, "number"), axisLabel(4_500_000, "currency"), axisLabel(0.5, "percent")]).toEqual(["12.3K", "4.5M", "50%"]);
  });
});

describe("KPI tiles and helpers", () => {
  test("the first row's column, and the change against the compare column", () => {
    const block = spec.blocks.find((item) => item.id === "kpi-revenue") as KpiBlock;
    expect(kpiValue(block, result("totals"))).toMatchObject({ problem: null, text: "48,210.50", change: { direction: "up", text: "+9.3%" } });
    expect(kpiValue({ ...block, column: "missing" }, result("totals")).problem).toContain("no column");
    expect(kpiValue(block, { columns: result("totals").columns, rows: [] }).problem).toContain("no rows");
  });

  test("CSV defuses formulas and quotes what needs it; doc links are http(s) only", () => {
    expect(toCsv([{ name: "a" }, { name: "b,c" }], [["=HYPERLINK(\"x\")", -12.5], ["line\nbreak", null], ["@cmd", "-1"]]))
      .toBe("a,\"b,c\"\r\n\"'=HYPERLINK(\"\"x\"\")\",-12.5\r\n\"line\nbreak\",\r\n'@cmd,-1\r\n");
    // Review L6: a number stays a number; leading whitespace before a formula is defused too.
    expect(toCsv([{ name: "n" }], [["-1"], [-1], ["+3"], [" =x"], ["\t=x"], ["  @y"], ["- note"]]))
      .toBe("n\r\n-1\r\n-1\r\n+3\r\n' =x\r\n'\t=x\r\n'  @y\r\n'- note\r\n");
    expect(docLink("https://docs.example.test/doc/metrics-abc")).toBe("https://docs.example.test/doc/metrics-abc");
    expect(docLink("javascript:alert(1)")).toBeNull();
    expect(docLink("metrics-abc")).toBeNull();
    expect(runLabel({ kind: "refresh", trigger: "schedule", queryKeys: null })).toBe("Refreshed on schedule");
    expect(runLabel({ kind: "refresh", trigger: "user", queryKeys: ["daily"] })).toBe("Re-ran daily by hand");
    expect(timeAgo("2026-10-13T08:00:00Z", Date.parse("2026-10-13T08:05:00Z"))).toBe("5 min ago");
  });

  test("the schedule form is off by default and saves the routine fields", () => {
    const fresh = scheduleForm(null, "Europe/Berlin");
    expect(fresh).toMatchObject({ enabled: false, cadence: "weekdays", time: "08:00", tz: "Europe/Berlin" });
    expect(scheduleInput({ ...fresh, enabled: true, cadence: "weekly", weekday: "3" })).toEqual({ cadence: "weekly", atTime: "08:00", weekday: 3, tz: "Europe/Berlin", enabled: true });
    expect(scheduleInput({ ...fresh, enabled: true, cadence: "hourly", minute: "15" })).toMatchObject({ cadence: "hourly", atTime: "00:15", weekday: null });
    const base = { cadence: "daily", atTime: "09:00", weekday: null, tz: "UTC", enabled: true, nextDueAt: null, failCount: 0, autoDisabled: false, lastRunId: null };
    expect(scheduleBadge(base)).toEqual({ text: "Daily at 09:00", tone: "ready" });
    expect(scheduleBadge({ ...base, enabled: false, failCount: 5, autoDisabled: true })).toEqual({ text: "Schedule off after 5 failures", tone: "error" });
    expect(scheduleBadge({ ...base, enabled: false })).toBeNull();
  });
});

const report: ReportDetail = {
  id: "0b5d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a", title: "Revenue", datasourceId: "d", datasourceName: "Warehouse", status: "stale", isOwner: true, ownerName: "Owner",
  blockCount: spec.blocks.length, lastRunAt: "2026-10-13T09:00:00.000Z", createdAt: "2026-10-13T07:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z", revision: 1,
  spec, doc: { serverId: null, tool: null, ref: "https://docs.example.test/doc/metrics", hash: null }, lastError: null
};
const views: QueryResultView[] = [
  { queryKey: "totals", result: result("totals"), failed: null, stale: false },
  { queryKey: "daily", result: result("daily"), failed: null, stale: false },
  { queryKey: "by_country", result: result("by_country"), failed: failedResult("by_country"), stale: true },
  { queryKey: "recent", result: null, failed: failedResult("recent"), stale: false }
];
const initial: { results: ReportResultsView } = { results: { results: views, running: null } };

async function html(element: React.ReactElement) {
  const { prelude } = await prerender(element);
  return await new Response(prelude).text();
}

describe("the report view (ECharts mocked)", () => {
  test("every block over its result: markdown, KPIs, charts (lazy), stale and error badges, inspect and menu buttons", async () => {
    drawn.length = 0;
    const markup = await html(<ReportView report={report} canWrite initial={initial} />);
    expect(markup).toContain("<strong>net of refunds</strong>");
    expect(markup).toContain("48,210.50");
    expect(markup).toContain("+9.3%");
    expect(markup).toContain("1,312");
    // Two charts drawn by the mocked ECharts, from Nook's options.
    expect(drawn.map((item) => item.label)).toEqual([
      "Revenue and refunds per day: line chart of revenue, refunds by day",
      "Top countries: bar chart of revenue by country"
    ]);
    expect(markup).toContain('class="mock-echart"');
    // The country chart is stale (last good result kept); the table has only an error.
    expect(markup).toContain(">Stale<");
    expect(markup).toContain(">Error<");
    expect(markup).toContain("Memory limit exceeded");
    expect(markup).toContain("2 stale");
    expect(markup.match(/aria-label="How was [^"]+ built"/g)?.length).toBe(5);
    expect(markup.match(/aria-label="More for [^"]+"/g)?.length).toBe(5);
    expect(markup).toContain("Refresh all");
    expect(markup).toContain("report-block-wide");
    // A viewer gets no Refresh all.
    expect(await html(<ReportView report={report} canWrite={false} initial={initial} />)).not.toContain("Refresh all");
  });

  test("a report without blocks renders nothing", () => {
    expect(renderToStaticMarkup(<ReportView report={{ ...report, spec: { version: 1, blocks: [], queries: [] } }} canWrite initial={initial} />)).toBe("");
  });
});

describe("the inspect sheet", () => {
  const block = spec.blocks.find((item) => item.id === "daily-line") as ChartBlock;
  const query = spec.queries.find((item) => item.key === "daily");
  const props = { report, block, query, view: views[1], palette: dark, canRerun: true, busy: false, onRerun: () => undefined, onClose: () => undefined };

  test("Query: saved SQL, SQL as sent, purpose, query id, timings, rows, Copy, and Re-run", () => {
    const markup = renderToStaticMarkup(<InspectSheet {...props} />);
    expect(markup).toContain("How was this built");
    expect(markup).toContain("Revenue and refunds per day");
    expect(markup).toContain("SQL as saved");
    expect(markup).toContain("GROUP BY day ORDER BY day");
    expect(markup).toContain("LIMIT 10001");
    expect(markup).toContain("nook-1111-daily");
    expect(markup).toContain("42 ms");
    expect(markup).toContain("120,000");
    expect(markup).toContain("Re-run this query");
    expect(markup).toContain('aria-selected="true"');
    expect(markup.match(/>Copy</g)?.length).toBe(2);
  });

  test("Query shows the last failure and that the block keeps its last good result", () => {
    const markup = renderToStaticMarkup(<InspectSheet {...props} block={spec.blocks.find((item) => item.id === "country-bar") as ChartBlock} view={views[2]} query={spec.queries[2]} />);
    expect(markup).toContain("Memory limit exceeded");
    expect(markup).toContain("The block shows the last good result");
  });

  test("Data: raw rows with types, the mapped columns highlighted, and CSV export", () => {
    const markup = renderToStaticMarkup(<InspectSheet {...props} initialTab="data" />);
    expect(markup).toContain("Decimal(18, 2)");
    expect(markup).toContain("2026-10-01");
    expect(markup).toContain('<em class="report-role">x</em>');
    expect(markup).toContain('<em class="report-role">y1</em>');
    expect(markup).toContain("Export CSV");
  });

  test("Mapping: the block spec and the final ECharts option from chartOption.ts", () => {
    const markup = renderToStaticMarkup(<InspectSheet {...props} initialTab="mapping" />);
    expect(markup).toContain("Chart (line)");
    expect(markup).toContain("ECharts option");
    expect(markup).toContain("&quot;type&quot;: &quot;line&quot;");
    expect(markup).toContain("ƒ axis:currency");
    expect(blockMapping(spec.blocks.find((item) => item.id === "kpi-revenue") as KpiBlock)).toEqual({ revenue: "value", revenue_prev: "compare" });
    expect(blockMapping({ ...(spec.blocks.find((item) => item.id === "recent-table") as TableBlock), columns: ["country"] })).toEqual({ country: "shown" });
  });

  test("Provenance: the run, the doc snapshot, the doc link, the instruction, and the version", () => {
    const withProvenance = { ...block, provenance: { runId: "33333333-3333-4333-8333-333333333333", version: 3, instructionId: "44444444-4444-4444-8444-444444444444", docSnapshotId: "55555555-5555-4555-8555-555555555555" } };
    const markup = renderToStaticMarkup(<InspectSheet {...props} block={withProvenance} initialTab="provenance" provenance={{
      run: { id: "33333333-3333-4333-8333-333333333333", reportId: report.id, kind: "generate", trigger: "user", status: "succeeded", agentRunId: null, docSnapshotId: "55555555-5555-4555-8555-555555555555", queryKeys: null, startedAt: "2026-10-13T07:00:00.000Z", finishedAt: "2026-10-13T07:01:00.000Z", error: null },
      snapshot: { id: "55555555-5555-4555-8555-555555555555", title: "Revenue metrics", sha256: "a".repeat(64), fetchedAt: "2026-10-13T06:59:00.000Z" }
    }} />);
    expect(markup).toContain("v3");
    expect(markup).toContain("Generated by hand");
    expect(markup).toContain("Revenue metrics");
    expect(markup).toContain("sha256 aaaaaaaaaaaa");
    expect(markup).toContain('href="https://docs.example.test/doc/metrics" target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain("44444444-4444-4444-8444-444444444444");
    expect(renderToStaticMarkup(<InspectSheet {...props} initialTab="provenance" />)).toContain("Written by hand (no AI run)");
  });
});

describe("inspect tabs are real Back and Forward steps", () => {
  /** A browser history with moves delivered like a browser's (popstate through historyDialogs). */
  function harness(initial: unknown[], landingDepth: number) {
    const entries: unknown[] = [...initial];
    let index = entries.length - 1;
    const moves: number[] = [];
    const history = {
      get state() { return entries[index]; },
      pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
      back() { moves.push(-1); },
      go(delta: number) { moves.push(delta); }
    };
    const env = { history: history as unknown as History, href: () => "https://nook.test/reports/x", landingDepth: () => landingDepth };
    const deliver = () => { index += moves.shift()!; return popStateClosedDialog({ state: entries[index] }); };
    const userBack = () => { index -= 1; return popStateClosedDialog({ state: entries[index] }); };
    const userForward = () => { index += 1; return popStateClosedDialog({ state: entries[index] }); };
    return { entries, history, env, deliver, userBack, userForward, moves, index: () => index };
  }

  /** Mounts the sheet the way InspectSheet does: its dialog layer, then the tab history's guard. */
  function mountSheet(h: ReturnType<typeof harness>) {
    const sheet = { open: true, tab: "query" as InspectTab, step: 0 };
    const release = acquireDialogSentinel(h.env);
    const depth = readHistoryDepth(h.history.state);
    const tabs = createInspectTabHistory({
      history: h.history as unknown as History, href: () => "https://nook.test/reports/x", initialTab: "query",
      show: (tab, step) => { sheet.tab = tab; sheet.step = step; },
      close: () => { sheet.open = false; release(); }
    });
    // The sheet's layer, as createDialogGuard does it: close, then undo the browser's move.
    const unregisterSheet = registerHistoryDialogGuard((popped) => {
      if (!sheet.open) return false;
      sheet.open = false;
      release();
      const direction = dialogPopDirection(depth, readHistoryDepth(popped));
      if (!direction) return false;
      undoDialogPop(direction, (delta) => h.history.go(delta));
      return true;
    });
    const unregisterTabs = registerHistoryDialogGuard((state) => tabs.guard(state));
    return { sheet, tabs, unmount: () => { unregisterTabs(); unregisterSheet(); release(); } };
  }

  test("each tab is an entry: Back and Forward move through them; Back from the first tab closes the sheet, never leaving", async () => {
    const h = harness([withHistoryDepth({ route: "reports" }, 1), withHistoryDepth({ route: "report" }, 2)], 0);
    const { sheet, tabs, unmount } = mountSheet(h);
    try {
      tabs.select("data", sheet.tab);
      tabs.select("mapping", sheet.tab);
      tabs.select("mapping", sheet.tab);
      expect(h.entries.length).toBe(4);
      expect(inspectMarkOf(h.history.state)).toMatchObject({ tab: "mapping", step: 2 });
      expect(readHistoryDepth(h.history.state)).toBe(4);

      expect(h.userBack()).toBe(true);
      expect(sheet).toMatchObject({ open: true, tab: "data", step: 1 });
      expect(h.userBack()).toBe(true);
      expect(sheet).toMatchObject({ open: true, tab: "query", step: 0 });
      // Forward redoes the steps.
      expect(h.userForward()).toBe(true);
      expect(sheet.tab).toBe("data");
      expect(h.userForward()).toBe(true);
      expect(sheet.tab).toBe("mapping");
      expect(h.moves).toEqual([]);

      // The sheet's own Back button is the browser's Back.
      tabs.back();
      expect(h.moves).toEqual([-1]);
      h.deliver();
      expect(sheet.tab).toBe("data");
      h.userBack();
      expect(sheet.tab).toBe("query");
      // Back from the first tab closes the sheet and undoes the move: still on the report's entry.
      expect(h.userBack()).toBe(true);
      expect(sheet.open).toBe(false);
      expect(h.moves).toEqual([1]);
      h.deliver();
      expect(h.index()).toBe(1);
      await Bun.sleep(5);
      // Forward onto a tab entry of the closed sheet steps straight back off it (historyDialogs uses window.history here).
      const holder = globalThis as { window?: unknown };
      const previous = holder.window;
      holder.window = { history: h.history };
      try { expect(h.userForward()).toBe(true); } finally { holder.window = previous; }
      expect(h.moves).toEqual([-1]);
      h.deliver();
      expect(h.index()).toBe(1);
    } finally {
      unmount();
    }
  });

  test("on a landing entry (the dialog sentinel) the tabs stack above it; × unwinds to the base, then closes", async () => {
    const h = harness([withHistoryDepth({ route: "report" }, 0)], 0);
    const { sheet, tabs, unmount } = mountSheet(h);
    try {
      expect(h.entries.length).toBe(2);
      tabs.select("data", sheet.tab);
      tabs.select("provenance", sheet.tab);
      expect(h.entries.length).toBe(4);
      expect(h.userBack()).toBe(true);
      expect(sheet.tab).toBe("data");
      expect(h.userForward()).toBe(true);
      expect(sheet.tab).toBe("provenance");
      // ×: back to the sentinel first (one go), then the sheet closes and its sentinel is popped.
      tabs.requestClose();
      expect(sheet.open).toBe(true);
      expect(h.moves).toEqual([-2]);
      h.deliver();
      expect(sheet).toMatchObject({ open: false, tab: "query" });
      expect(h.index()).toBe(1);
      await Bun.sleep(5);
      expect(h.moves).toEqual([-1]);
      h.deliver();
      expect(h.index()).toBe(0);
    } finally {
      unmount();
    }
  });

  test("the sheet registers its tab guard after its own, and charts stay lazy and tree-shaken", async () => {
    const source = await Bun.file(new URL("../src/reports/InspectSheet.tsx", import.meta.url)).text();
    expect(source.indexOf("useHistoryDialogGuard(true, onClose)")).toBeLessThan(source.indexOf("registerHistoryDialogGuard((state) => tabs.guard(state))"));
    expect(source).toContain("onClose={close}");
    const charts = await Bun.file(new URL("../src/reports/charts.tsx", import.meta.url)).text();
    expect(charts).toContain('from "echarts/core"');
    expect(charts).not.toMatch(/from "echarts"/);
    expect(charts).toContain("SVGRenderer");
    const view = await Bun.file(new URL("../src/reports/ReportView.tsx", import.meta.url)).text();
    expect(view).toContain('lazy(() => import("./charts"))');
  });
});

describe("one theme source", () => {
  test("the palette takes the scheme's hues and the page's resolved tokens; unusable values are ignored", () => {
    const themed = themedPalette("dark", { surface: "#111113", text: "rgb(245, 245, 244)", grid: "color-mix(in srgb, red 10%, blue)", muted: "var(--muted)" });
    expect(themed).toMatchObject({ mode: "dark", surface: "#111113", text: "rgb(245, 245, 244)", grid: CHART_PALETTES.dark.grid, muted: CHART_PALETTES.dark.muted });
    expect(themed.series).toEqual(CHART_PALETTES.dark.series);
    expect(themedPalette("light").series).toEqual(CHART_PALETTES.light.series);
    expect(themedPalette("light dark").mode).toBe("dark");
    expect(themedPalette("normal").mode).toBe("dark");
  });

  test("reportView.css uses the app's tokens, not literal dark colors", async () => {
    const css = await Bun.file(new URL("../src/reports/reportView.css", import.meta.url)).text();
    const rules = css.slice(css.indexOf(".report-view-toolbar"));
    expect(rules.match(/#[0-9a-f]{3,6}\b/gi) ?? []).toEqual([]);
    expect(css).toContain("--report-surface: var(--panel)");
    expect(css).not.toContain("data-theme");
    const view = await Bun.file(new URL("../src/reports/ReportView.tsx", import.meta.url)).text();
    expect(view).toContain("new MutationObserver(update)");
    expect(view).toContain('matchMedia("(prefers-color-scheme: dark)")');
  });
});

const { ReportGeneration } = await import("../src/reports/ReportGeneration");
const { resultsLoadKey } = await import("../src/reports/ReportView");

describe("the report page after waves 46 and 47 merged", () => {
  test("the generation controls wrap the real viewer (charts, inspect, Refresh all, Schedule); no spec preview", async () => {
    const markup = await html(<ReportGeneration report={report} canWrite onChanged={() => {}} />);
    expect(markup).toContain('class="report-generation"');
    expect(markup).toContain("Check doc");
    expect(markup).toContain("Regenerate");
    expect(markup).toContain('class="report-view"');
    expect(markup).toContain("Refresh all");
    expect(markup).toContain(">Schedule<");
    expect(markup.match(/aria-label="How was [^"]+ built"/g)?.length).toBe(5);
    expect(markup).not.toContain("spec-preview");
    expect(await Bun.file(new URL("../src/reports/SpecPreview.tsx", import.meta.url)).exists()).toBe(false);
  });

  test("a finished generation's new revision reloads the viewer's results, with no manual refresh", async () => {
    // The viewer's load effect is keyed on this: a generation that saved a spec bumps the revision.
    expect(resultsLoadKey(report)).not.toBe(resultsLoadKey({ ...report, revision: report.revision + 1 }));
    expect(resultsLoadKey(report)).toBe(resultsLoadKey({ ...report, title: "Renamed" } as typeof report));
    const view = await Bun.file(new URL("../src/reports/ReportView.tsx", import.meta.url)).text();
    expect(view).toMatch(/const loadKey = resultsLoadKey\(report\);\n\s+useEffect\(\(\) => \{\n\s+if \(initial\) return;\n\s+void loadResults\(\)/);
    expect(view).toContain("[initial, loadResults, loadRuns, loadKey]");
    // ReportGeneration reloads the report when the run ends, so the page passes the new revision down.
    const generation = await Bun.file(new URL("../src/reports/ReportGeneration.tsx", import.meta.url)).text();
    expect(generation).toMatch(/const finished = [^]*?void load\(\);\s+onChanged\(\);/);
    // The new spec's first results are drawn as soon as they arrive.
    drawn.length = 0;
    const markup = await html(<ReportView report={{ ...report, revision: 2 }} canWrite initial={initial} />);
    expect(drawn.length).toBe(2);
    expect(markup).toContain("48,210.50");
  });
});
