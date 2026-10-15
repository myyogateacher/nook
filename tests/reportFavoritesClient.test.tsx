/**
 * Report organization phase 1 on the Reports home, rendered with happy-dom: ☆/★ on a row (optimistic,
 * rolled back with a toast on error) and on the report header, Favorites in the nav and its empty state,
 * the filter bar in the URL (Back and Forward restore it, Clear filters, "No reports match"), Load
 * more, and the phone's filter sheet as a history layer (Back closes it, Forward reopens it).
 */
import { describe, expect, test } from "bun:test";
import type { ReportFolderTree, ReportSummary } from "../shared/reports";
import { captureToasts, installDom, mockApi, render, reply, type ApiCall, type Rendered } from "./support/dom";

installDom("http://nook.test/reports");

const { ReportsHome, listQueryFor } = await import("../src/reports/ReportsHome");
const { ReportsApp } = await import("../src/reports/ReportsApp");
const { RoleContext } = await import("../src/team/roleAccess");
const { formatRoute, locationUrl, parseRoute } = await import("../src/router");
const { reportListSearch } = await import("../src/reports/reportsApi");
const { popStateClosedDialog, takeDialogSentinelEntry, whenHistorySettled } = await import("../src/historyDialogs");
const { act } = await import("react");

const at = "2026-10-15T00:00:00.000Z";
const ME = "0b8f7c2e-2222-4222-8222-000000000001";
const BEN = "0b8f7c2e-2222-4222-8222-000000000002";
const DS = "0b8f7c2e-3333-4333-8333-000000000001";
const REVENUE = "0b8f7c2e-1111-4111-8111-000000000001";
const PIPELINE = "0b8f7c2e-1111-4111-8111-000000000002";
const summary = (id: string, title: string, extra: Partial<ReportSummary> = {}): ReportSummary => ({
  id, title, datasourceId: DS, datasourceName: "Warehouse", status: "ready", isOwner: true, ownerName: "Me", blockCount: 1, lastRunAt: null,
  createdAt: at, updatedAt: at, revision: 1, folderId: null, scheduleCadence: null, ownerId: ME, favorite: false, ...extra
});
const tree = (favorites = 0): ReportFolderTree => ({
  folders: [], counts: { all: 2, unfiled: 1, shared: 1, favorites },
  owners: [{ id: ME, name: "Me", count: 1, isMe: true }, { id: BEN, name: "Ben Ortiz", count: 1, isMe: false }]
});
const base = (extra: Record<string, (call: ApiCall) => unknown> = {}) => mockApi({
  "GET /reports": () => ({ reports: [summary(REVENUE, "Weekly revenue"), summary(PIPELINE, "Sales pipeline", { isOwner: false, ownerName: "Ben Ortiz", ownerId: BEN, status: "stale" })], nextCursor: null }),
  "GET /reports/folders": () => tree(),
  "GET /reports/datasources": () => ({ datasources: [{ id: DS, name: "Warehouse", database: "analytics" }] }),
  ...extra
});
const noop = () => undefined;
const home = (props: Partial<Parameters<typeof ReportsHome>[0]> = {}) => <RoleContext.Provider value="member">
  <ReportsHome displayName="Me" role="member" onHome={noop} onSettings={noop} onSignOut={noop} onOpen={noop} onOpenDatasources={noop} {...props} />
</RoleContext.Provider>;
const rowTitles = () => [...document.querySelectorAll(".reports-row-title > span")].map((item) => item.textContent);
const navLink = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".reports-sidebar .reports-nav-link")].find((item) => item.querySelector(".reports-nav-name")?.textContent === name)!;
const starOf = (title: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Star ${title}"], button[aria-label="Unstar ${title}"]`)!;
const settle = () => new Promise<void>((resolve) => whenHistorySettled(resolve));
async function pick(view: Rendered, label: string, option: string, within: ParentNode = document.body) {
  await view.click(within.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${label}"]`)!);
  await view.click(await view.waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === option) ?? null));
}
async function browser(view: Rendered, move: "back" | "forward") {
  await act(async () => { if (move === "back") window.history.back(); else window.history.forward(); await Bun.sleep(40); });
  await act(async () => { await Bun.sleep(20); });
  await view.waitFor(() => true);
}

describe("stars", () => {
  test("☆ on a row stars it at once (PUT), the Favorites count follows; an error puts it back with a toast", async () => {
    const toasts = captureToasts();
    let fail = false;
    const api = base({
      [`PUT /reports/${REVENUE}/favorite`]: () => fail ? reply(500, { error: "Nope" }) : { favorite: true },
      [`DELETE /reports/${REVENUE}/favorite`]: () => ({ favorite: false })
    });
    const view = await render(home());
    await view.waitFor(() => rowTitles().length === 2);
    expect(navLink("Favorites").querySelector("b")?.textContent).toBe("0");
    await view.click(starOf("Weekly revenue"));
    expect(starOf("Weekly revenue").getAttribute("aria-pressed")).toBe("true");
    expect(navLink("Favorites").querySelector("b")?.textContent).toBe("1");
    await view.waitFor(() => api.calls.some((call) => call.method === "PUT" && call.path === `/reports/${REVENUE}/favorite`));
    await view.click(starOf("Weekly revenue"));
    await view.waitFor(() => api.calls.some((call) => call.method === "DELETE"));
    expect(starOf("Weekly revenue").getAttribute("aria-pressed")).toBe("false");
    fail = true;
    await view.click(starOf("Weekly revenue"));
    await view.waitFor(() => toasts.some((toast) => toast.kind === "error"));
    expect(starOf("Weekly revenue").getAttribute("aria-pressed")).toBe("false");
    expect(navLink("Favorites").querySelector("b")?.textContent).toBe("0");
    expect(toasts.find((toast) => toast.kind === "error")?.message).toContain("Nope");
  });

  test("Favorites lists the starred (favorites=1); unstarring there drops the row; empty, it says how to star", async () => {
    base({
      "GET /reports?favorites=1": () => ({ reports: [summary(REVENUE, "Weekly revenue", { favorite: true })], nextCursor: null }),
      "GET /reports/folders": () => tree(1),
      [`DELETE /reports/${REVENUE}/favorite`]: () => ({ favorite: false })
    });
    const view = await render(home({ folder: "favorites" }));
    await view.waitFor(() => rowTitles().join() === "Weekly revenue");
    expect(document.querySelector("#reports-title")?.textContent).toBe("Favorites · 1");
    expect(navLink("Favorites").getAttribute("aria-current")).toBe("page");
    await view.click(starOf("Weekly revenue"));
    await view.waitFor(() => document.querySelector(".reports-state h2")?.textContent === "No favorites yet");
    expect(document.querySelector(".reports-state p")?.textContent).toContain("Star a report");
    expect(parseRoute("/reports/favorites")).toEqual({ app: "reports", reportId: null, folder: "favorites" });
    expect(formatRoute({ app: "reports", reportId: null, folder: "favorites" })).toBe("/reports/favorites");
  });
});

describe("filters", () => {
  test("the URL query: parse, format, the list's server query, and locationUrl keeps it on list paths only", () => {
    const route = parseRoute("/reports/unfiled", "?status=stale,ready,bogus&owner=me&schedule=on&datasource=nope");
    expect(route).toEqual({ app: "reports", reportId: null, folder: "unfiled", filter: { status: ["ready", "stale"], owner: "me", schedule: "on" } });
    expect(formatRoute(route)).toBe("/reports/unfiled?owner=me&status=ready,stale&schedule=on");
    expect(parseRoute(`/reports/${REVENUE}`, "?status=ready")).toEqual({ app: "reports", reportId: REVENUE });
    expect(locationUrl({ pathname: "/reports/favorites", search: "?status=ready" })).toBe("/reports/favorites?status=ready");
    expect(locationUrl({ pathname: `/reports/${REVENUE}`, search: "?x=1" })).toBe(`/reports/${REVENUE}`);
    // D489: a report page keeps only its parameter values.
    expect(locationUrl({ pathname: `/reports/${REVENUE}`, search: "?x=1&p.period=7d" })).toBe(`/reports/${REVENUE}?p.period=7d`);
    const query = listQueryFor("unfiled", { status: ["ready"], owner: BEN, datasource: DS, schedule: "off" }, " rev ", false);
    expect(reportListSearch(query)).toBe(`?q=rev&owner=${BEN}&status=ready&datasource=${DS}&scheduled=0&folder=unfiled`);
    expect(reportListSearch(listQueryFor("unfiled", undefined, "rev", true))).toBe("?q=rev");
  });

  test("a pill pushes its filter into the URL; Back and Forward restore it; Clear filters; no match says so", async () => {
    base({
      "GET /reports?status=stale": () => ({ reports: [summary(PIPELINE, "Sales pipeline", { isOwner: false, ownerName: "Ben Ortiz", ownerId: BEN, status: "stale" })], nextCursor: null }),
      "GET /reports?status=stale&scheduled=1": () => ({ reports: [], nextCursor: null })
    });
    await settle();
    window.history.replaceState({ "mynotes.depth": 0 }, "", "/reports");
    // The app's navigate (App.tsx writeHistory): a push from a dropdown's sentinel takes the sentinel's place.
    const navigate = (route: Parameters<typeof formatRoute>[0], options?: { replace?: boolean }) => {
      const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
      if (options?.replace || takeDialogSentinelEntry(window.history.state)) window.history.replaceState({ "mynotes.depth": depth }, "", formatRoute(route));
      else window.history.pushState({ "mynotes.depth": depth + 1 }, "", formatRoute(route));
    };
    const view = await render(<RoleContext.Provider value="member">
      <ReportsApp displayName="Me" role="member" navigate={navigate} flash={noop} onHome={noop} onSettings={noop} onSignOut={noop} onOpenDatasources={noop} />
    </RoleContext.Provider>);
    await view.waitFor(() => rowTitles().length === 2);
    await pick(view, "Status", "Stale");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/reports?status=stale");
    await view.waitFor(() => rowTitles().join() === "Sales pipeline");
    expect(document.querySelector(".reports-filter.active")).not.toBeNull();
    await pick(view, "Schedule", "Scheduled");
    expect(window.location.search).toBe("?status=stale&schedule=on");
    await view.waitFor(() => document.querySelector(".reports-state h2")?.textContent === "No reports match these filters");

    await browser(view, "back");
    expect(window.location.search).toBe("?status=stale");
    await view.waitFor(() => rowTitles().join() === "Sales pipeline");
    await browser(view, "back");
    await view.waitFor(() => rowTitles().length === 2);
    expect(document.querySelector(".reports-filter.active")).toBeNull();
    await browser(view, "forward");
    await view.waitFor(() => rowTitles().join() === "Sales pipeline");
    await view.click(view.button("Clear filters")!);
    expect(window.location.search).toBe("");
    await view.waitFor(() => rowTitles().length === 2);
  });

  test("Load more fetches the next page by cursor and appends it", async () => {
    const api = base({
      "GET /reports": () => ({ reports: [summary(REVENUE, "Weekly revenue")], nextCursor: "c1" }),
      "GET /reports?cursor=c1": () => ({ reports: [summary(PIPELINE, "Sales pipeline")], nextCursor: null })
    });
    const view = await render(home());
    await view.waitFor(() => rowTitles().length === 1);
    expect(document.querySelector("#reports-title")?.textContent).toBe("All reports · 2");
    await view.click(view.button("Load more")!);
    await view.waitFor(() => rowTitles().length === 2);
    expect(rowTitles()).toEqual(["Weekly revenue", "Sales pipeline"]);
    expect(view.button("Load more")).toBeNull();
    expect(api.calls.filter((call) => call.path === "/reports?cursor=c1").length).toBe(1);
  });
});

describe("the phone's filter sheet", () => {
  test("Filters opens a sheet; Show reports applies; Back closes it and Forward reopens it (its layer key)", async () => {
    const applied: Array<unknown> = [];
    base();
    function Host() {
      return home({ onFilter: (filter) => { applied.push(filter); } });
    }
    const routes: string[] = [];
    const onPop = (event: PopStateEvent) => { if (!popStateClosedDialog(event)) routes.push("route"); };
    window.addEventListener("popstate", onPop);
    try {
      const view = await render(<Host />);
      await view.waitFor(() => rowTitles().length === 2);
      await view.click(document.querySelector<HTMLButtonElement>(".reports-filter-open")!);
      const sheet = await view.waitFor(() => document.querySelector(".reports-filter-sheet"));
      expect(sheet.querySelectorAll('button[role="combobox"]').length).toBe(4);
      await browser(view, "back");
      expect(document.querySelector(".reports-filter-sheet")).toBeNull();
      await browser(view, "forward");
      await view.waitFor(() => document.querySelector(".reports-filter-sheet"));
      await pick(view, "Owner", "By Ben Ortiz", document.querySelector(".reports-filter-sheet")!);
      await view.click(view.button("Show reports")!);
      await view.waitFor(() => applied.length === 1);
      expect(applied).toEqual([{ owner: BEN }]);
      expect(document.querySelector(".reports-filter-sheet")).toBeNull();
      expect(routes).toEqual([]);
    } finally {
      window.removeEventListener("popstate", onPop);
    }
  });
});
