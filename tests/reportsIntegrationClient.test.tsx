import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KpiBlock, ReportResult } from "../shared/reports";
import type { QueryResultView } from "../shared/reportsView";

mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { BlockMenu } = await import("../src/reports/ReportView");
const { BlockPreview } = await import("../src/reports/ProposalSheet");
const { ReportCommentContext } = await import("../src/reports/reportComment");
const { ReportOverflowMenu, ReportCommandsContext } = await import("../src/reports/reportCommands");
const { overflowItems } = await import("../src/reports/ReportPage");
const { chartTheme } = await import("../src/reports/chartOption");

/**
 * The reports integration's client parts: the report header's overflow menu (its items, order, and
 * who sees them), "Ask for a change" in a block's menu, and a proposal's KPI drawn with the lookup
 * (its comparison and sparkline read other queries' results) in the report theme.
 */

const noop = () => undefined;
const result = (queryKey: string, columns: Array<{ name: string; type: string }>, rows: unknown[][]): ReportResult => ({
  runId: "11111111-1111-4111-8111-111111111111", queryKey, sql: "SELECT 1", sentSql: "SELECT 1", columns, rows, rowCount: rows.length, truncated: false,
  rowsRead: null, bytesRead: null, chQueryId: null, ms: 1, error: null, errorCode: null, createdAt: "2026-10-13T08:00:00.000Z"
});
const view = (item: ReportResult): QueryResultView => ({ queryKey: item.queryKey, result: item, failed: null, stale: false }) as QueryResultView;

describe("the report header's overflow menu", () => {
  const commands = {
    refreshAll: { run: noop, busy: false, disabled: false },
    schedule: { open: noop, badge: "Daily 08:00" },
    checkDoc: { run: noop, busy: false },
    regenerate: { run: noop, busy: false }
  };
  const handlers = { share: noop, rename: noop, model: noop, remove: noop };

  test("the owner: Share and Schedule for phones first, then Rename, Model, Check doc, Regenerate, and Move to Bin last (dangerous)", () => {
    const items = overflowItems({ ownerWrite: true, commands, ...handlers });
    expect(items.map((item) => item.id)).toEqual(["share", "schedule", "rename", "model", "check-doc", "regenerate", "bin"]);
    expect(items.filter((item) => item.narrowOnly).map((item) => item.id)).toEqual(["share", "schedule"]);
    expect(items.at(-1)).toMatchObject({ id: "bin", label: "Move to Bin", danger: true });
    expect(items.filter((item) => item.danger).length).toBe(1);
    // Without a doc, no Check doc or Regenerate.
    expect(overflowItems({ ownerWrite: true, commands: { schedule: commands.schedule }, ...handlers }).map((item) => item.id)).toEqual(["share", "schedule", "rename", "model", "bin"]);
    // A check in flight disables both doc actions.
    const busy = overflowItems({ ownerWrite: true, commands: { ...commands, checkDoc: { run: noop, busy: true } }, ...handlers });
    expect(busy.filter((item) => item.disabled).map((item) => item.id)).toEqual(["check-doc", "regenerate"]);
  });

  test("a reader (view or comment) sees no owner action: only Schedule (read-only), for phones", () => {
    expect(overflowItems({ ownerWrite: false, commands, ...handlers }).map((item) => item.id)).toEqual(["schedule"]);
    expect(overflowItems({ ownerWrite: false, commands: {}, ...handlers })).toEqual([]);
  });

  test("the menu button is a closed menu button; with no items there is no button", () => {
    const markup = renderToStaticMarkup(<ReportOverflowMenu label="More report actions" items={overflowItems({ ownerWrite: true, commands, ...handlers })} />);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="More report actions"');
    expect(markup).not.toContain('role="menu"');
    expect(renderToStaticMarkup(<ReportOverflowMenu items={[]} />)).toBe("");
    // The owner's menu shows everywhere; a reader's (phone-only Schedule) only on a phone.
    expect(markup).not.toContain("report-narrow-only-menu");
    const reader = renderToStaticMarkup(<ReportOverflowMenu items={overflowItems({ ownerWrite: false, commands, ...handlers })} />);
    expect(reader).toContain('class="report-overflow report-narrow-only-menu"');
  });

  test("inside the page's commands provider the viewer hides its own Refresh all and Schedule", async () => {
    const { ReportView } = await import("../src/reports/ReportView");
    const { sampleSpec } = await import("./support/reportSeed");
    const report = { id: "r1", title: "R", spec: sampleSpec(), revision: 1, lastRunAt: null } as never;
    const initial = { results: { results: [], running: null } as never, schedule: null, runs: [] };
    const alone = renderToStaticMarkup(<ReportView report={report} canWrite initial={initial} />);
    expect(alone).toContain("Refresh all");
    const inPage = renderToStaticMarkup(<ReportCommandsContext.Provider value={{ set: noop }}><ReportView report={report} canWrite initial={initial} /></ReportCommandsContext.Provider>);
    expect(inPage).not.toContain("Refresh all");
    expect(inPage).not.toContain(">Schedule<");
  });
});

describe("a block's menu", () => {
  const block = { id: "country-bar", type: "chart", title: "Top countries", queryKey: "by_country", kind: "bar", x: "country", y: ["revenue"] } as const;
  test("has Ask for a change for those who may comment, as a menu item", () => {
    const markup = renderToStaticMarkup(<ReportCommentContext.Provider value={noop}>
      <BlockMenu block={block as never} canWrite busy={false} onClose={noop} onInspect={noop} onRerun={noop} />
    </ReportCommentContext.Provider>);
    expect(markup).toContain("Ask for a change");
    expect(markup).toMatch(/role="menuitem"[^>]*>(<svg[\s\S]*?<\/svg>)?Ask for a change/);
  });
  test("has no Ask for a change for a view-only reader", () => {
    const markup = renderToStaticMarkup(<BlockMenu block={block as never} canWrite={false} busy={false} onClose={noop} onInspect={noop} onRerun={noop} />);
    expect(markup).not.toContain("Ask for a change");
    expect(markup).toContain("View data");
  });
});

describe("a proposal's blocks", () => {
  test("a KPI draws its comparison (compareLabel) and sparkline from other queries through the lookup", () => {
    const kpi: KpiBlock = {
      id: "revenue", type: "kpi", title: "Net revenue", queryKey: "kpis", column: "revenue", format: "currency:USD",
      compareTo: { queryKey: "prev", column: "revenue_prev" }, compareLabel: "vs prior 2 weeks", sparkline: { queryKey: "trend", x: "day", y: "web" }
    };
    const kpis = result("kpis", [{ name: "revenue", type: "Float64" }], [[1200]]);
    const prev = result("prev", [{ name: "revenue_prev", type: "Float64" }], [[1000]]);
    const trend = result("trend", [{ name: "day", type: "Date" }, { name: "web", type: "Float64" }], [["2026-10-01", 10], ["2026-10-02", 30], ["2026-10-03", 20]]);
    const results = new Map([["kpis", view(kpis)]]);
    const others = new Map([["prev", prev], ["trend", trend]]);
    const withLookup = renderToStaticMarkup(<BlockPreview block={kpi} results={results} palette={chartTheme("dark")} lookup={(key) => others.get(key) ?? null} />);
    expect(withLookup).toContain("+20.0%");
    expect(withLookup).toContain("vs prior 2 weeks");
    expect(withLookup).toContain("class=\"report-kpi-spark\"");
    const without = renderToStaticMarkup(<BlockPreview block={kpi} results={results} palette={chartTheme("dark")} lookup={() => null} />);
    expect(without).not.toContain("+20.0%");
    expect(without).not.toContain("report-kpi-spark");
  });
});
