/**
 * The Reports home's folders (Lane I), rendered with happy-dom: report rows, a row dragged onto a folder
 * (simulated drag events) files it, Move to… files it from the row's ⋯ menu, New report in a folder sends
 * its folderId, the folder URLs with Back and Forward, and the phone folder sheet.
 */
import { describe, expect, test } from "bun:test";
import type { ReportFolderTree, ReportSummary } from "../shared/reports";
import { captureToasts, installDom, mockApi, render, type ApiCall } from "./support/dom";

installDom("http://nook.test/reports");

const { ReportsHome } = await import("../src/reports/ReportsHome");
const { ReportsApp } = await import("../src/reports/ReportsApp");
const { RoleContext } = await import("../src/team/roleAccess");
const { formatRoute, parseRoute } = await import("../src/router");
const { whenHistorySettled } = await import("../src/historyDialogs");

const FINANCE = "0b8f7c2e-0000-4000-8000-00000000000f";
const GROWTH = "0b8f7c2e-0000-4000-8000-00000000000a";
const at = "2026-10-14T00:00:00.000Z";
const ME = "0b8f7c2e-2222-4222-8222-000000000001";
const BEN = "0b8f7c2e-2222-4222-8222-000000000002";
const summary = (id: string, title: string, extra: Partial<ReportSummary> = {}): ReportSummary => ({
  id, title, datasourceId: "ds-1", datasourceName: "Warehouse", status: "ready", isOwner: true, ownerName: "Me", blockCount: 1, lastRunAt: null,
  createdAt: at, updatedAt: at, revision: 1, folderId: null, scheduleCadence: null, ownerId: ME, favorite: false, ...extra
});
const REVENUE = "0b8f7c2e-1111-4111-8111-000000000001";
const LOOSE = "0b8f7c2e-1111-4111-8111-000000000002";
const SHARED = "0b8f7c2e-1111-4111-8111-000000000003";
const reports = () => [
  summary(REVENUE, "Weekly revenue", { folderId: FINANCE, scheduleCadence: "weekly" }),
  summary(LOOSE, "Trial conversions", { status: "draft" }),
  summary(SHARED, "Sales pipeline", { isOwner: false, ownerName: "Ben Ortiz", ownerId: BEN })
];
const tree = (): ReportFolderTree => ({
  folders: [
    { id: FINANCE, parentId: null, name: "Finance", position: 0, count: 1, createdAt: at, updatedAt: at },
    { id: GROWTH, parentId: null, name: "Growth", position: 1, count: 0, createdAt: at, updatedAt: at }
  ],
  counts: { all: 3, unfiled: 1, shared: 1, favorites: 0 },
  owners: [{ id: ME, name: "Me", count: 2, isMe: true }, { id: BEN, name: "Ben Ortiz", count: 1, isMe: false }],
  canCreateFolders: true, canManageFolders: true
});
/** The server's view filtering (phase 1 pages and filters on the server). */
const page = (list: ReportSummary[]) => () => ({ reports: list, nextCursor: null });
const routes = (extra: Record<string, (call: ApiCall) => unknown> = {}) => mockApi({
  "GET /reports": () => ({ reports: reports(), nextCursor: null }),
  [`GET /reports?folder=${FINANCE}`]: page(reports().filter((report) => report.folderId === FINANCE)),
  [`GET /reports?folder=${GROWTH}`]: page([]),
  "GET /reports?folder=unfiled": page(reports().filter((report) => report.isOwner && !report.folderId)),
  "GET /reports?shared=1": page(reports().filter((report) => !report.isOwner)),
  "GET /reports/folders": () => tree(),
  "GET /reports/datasources": () => ({ datasources: [{ id: "ds-1", name: "Warehouse", database: "analytics" }] }),
  "GET /reports/doc-servers": () => ({ servers: [] }),
  ...extra
});
const noop = () => undefined;
const home = (props: Partial<Parameters<typeof ReportsHome>[0]> = {}) => <RoleContext.Provider value="member">
  <ReportsHome displayName="Me" role="member" onHome={noop} onSettings={noop} onSignOut={noop} onOpen={noop} onOpenDatasources={noop} {...props} />
</RoleContext.Provider>;
const rowTitles = () => [...document.querySelectorAll(".reports-row-title > span")].map((item) => item.textContent);
const navLink = (name: string, within: ParentNode = document.querySelector(".reports-sidebar")!) => [...within.querySelectorAll<HTMLButtonElement>(".reports-nav-link")].find((item) => item.querySelector(".reports-nav-name")?.textContent === name)!;

/** A drag event carrying a stand-in DataTransfer (happy-dom has none to construct). */
function drag(type: string, store: Map<string, string>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: {
    get types() { return [...store.keys()]; }, setData: (key: string, value: string) => { store.set(key, value); }, getData: (key: string) => store.get(key) ?? "",
    setDragImage: noop, effectAllowed: "all", dropEffect: "none"
  } });
  return event;
}
const settle = () => new Promise<void>((resolve) => whenHistorySettled(resolve));

describe("Reports home folders", () => {
  test("rows: title, owner of a shared report, status, data source, schedule badge; the nav counts", async () => {
    routes();
    const view = await render(home());
    await view.waitFor(() => rowTitles().length === 3);
    expect(rowTitles()).toEqual(["Weekly revenue", "Trial conversions", "Sales pipeline"]);
    expect(document.querySelector(".reports-row:nth-child(3) .reports-row-title small")?.textContent).toBe("by Ben Ortiz");
    expect(document.querySelector(".reports-row:nth-child(1) .reports-row-schedule")?.textContent).toBe("Weekly");
    expect(document.querySelector(".reports-row:nth-child(1) .reports-row-folder")?.textContent).toBe("Finance");
    expect(navLink("Unfiled").querySelector("b")?.textContent).toBe("1");
    expect(navLink("Finance").querySelector("b")?.textContent).toBe("1");
    expect(navLink("Shared with me").querySelector("b")?.textContent).toBe("1");
    // A shared report cannot be dragged; the owner's can.
    expect(document.querySelector(".reports-row:nth-child(3)")?.getAttribute("draggable")).toBe("false");
    expect(document.querySelector(".reports-row:nth-child(2)")?.getAttribute("draggable")).toBe("true");
  });

  test("a folder view shows its reports only; Unfiled and Shared filter too", async () => {
    routes();
    const view = await render(home({ folder: FINANCE }));
    await view.waitFor(() => rowTitles().length === 1);
    expect(rowTitles()).toEqual(["Weekly revenue"]);
    await view.rerender(home({ folder: "shared" }));
    await view.waitFor(() => rowTitles()[0] === "Sales pipeline");
    await view.rerender(home({ folder: GROWTH }));
    await view.waitFor(() => document.querySelector(".reports-state h2")?.textContent === "This folder is empty");
  });

  test("dragging a row onto a folder highlights it and files the report, with Undo", async () => {
    const toasts = captureToasts();
    const api = routes({ [`PATCH /reports/${LOOSE}/folder`]: (call) => ({ report: summary(LOOSE, "Trial conversions", { folderId: (call.body as { folderId: string }).folderId }), previousFolderId: null }) });
    const view = await render(home());
    await view.waitFor(() => rowTitles().length === 3);
    const store = new Map<string, string>();
    const row = document.querySelectorAll(".reports-row")[1]!;
    const { act } = await import("react");
    await act(async () => { row.dispatchEvent(drag("dragstart", store)); });
    expect(store.get("application/x-nook-report")).toBe(LOOSE);
    await act(async () => { navLink("Growth").dispatchEvent(drag("dragenter", store)); navLink("Growth").dispatchEvent(drag("dragover", store)); });
    expect(navLink("Growth").classList.contains("drop-target")).toBe(true);
    await act(async () => { navLink("Growth").dispatchEvent(drag("drop", store)); });
    await view.waitFor(() => api.calls.some((call) => call.method === "PATCH"));
    expect(api.calls.find((call) => call.method === "PATCH")).toEqual({ method: "PATCH", path: `/reports/${LOOSE}/folder`, body: { folderId: GROWTH } });
    await view.waitFor(() => toasts.some((toast) => toast.message === "Moved “Trial conversions” to Growth"));
    expect(navLink("Growth").classList.contains("drop-target")).toBe(false);
  });

  test("Move to… in the row menu files the report through the folder picker", async () => {
    const api = routes({ [`PATCH /reports/${LOOSE}/folder`]: () => ({ report: summary(LOOSE, "Trial conversions", { folderId: FINANCE }), previousFolderId: null }) });
    const view = await render(home());
    await view.waitFor(() => rowTitles().length === 3);
    await view.click(document.querySelectorAll(".reports-row-menu button")[1]!);
    await view.click([...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === "Move to…")!);
    const sheet = await view.waitFor(() => document.querySelector(".report-move-sheet"));
    const options = [...sheet.querySelectorAll<HTMLButtonElement>(".move-option")];
    expect(options.map((item) => item.textContent)).toEqual(["UnfiledCurrent folder", "Finance", "Growth"]);
    expect(options[0]!.disabled).toBe(true);
    await view.click(options[1]!);
    await view.click(view.button("Move to Finance", sheet)!);
    await view.waitFor(() => !document.querySelector(".report-move-sheet"));
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ folderId: FINANCE });
    await settle();
  });

  test("New report in a folder says In: <folder> and sends its folderId", async () => {
    const api = routes({ "POST /reports": () => ({ report: { ...summary("0b8f7c2e-1111-4111-8111-000000000009", "Margins", { folderId: FINANCE }), spec: { version: 2, sections: [], blocks: [], queries: [] }, doc: null, lastError: null } }) });
    let opened = "";
    const view = await render(home({ folder: FINANCE, onOpen: (id) => { opened = id; } }));
    await view.waitFor(() => rowTitles().length === 1);
    await view.click(view.button("New report")!);
    const sheet = await view.waitFor(() => document.querySelector(".new-report-sheet"));
    expect(sheet.querySelector(".new-report-folder")?.textContent).toContain("In: Finance");
    await view.click([...sheet.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent === "Blank")!);
    const input = sheet.querySelector<HTMLInputElement>("input[placeholder='Weekly revenue']")!;
    const { act } = await import("react");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Margins");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await view.click(view.button("Create report", sheet)!);
    await view.waitFor(() => opened);
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({ title: "Margins", datasourceId: "ds-1", folderId: FINANCE });
    await settle();
  });

  test("the phone folder sheet: the folder button opens it; choosing a folder closes it and moves there", async () => {
    routes();
    const chosen: Array<string | null> = [];
    const view = await render(home({ onFolder: (next) => { chosen.push(next); } }));
    await view.waitFor(() => rowTitles().length === 3);
    await view.click(document.querySelector(".reports-folder-chip")!);
    const sheet = await view.waitFor(() => document.querySelector(".reports-folder-sheet"));
    await view.click(navLink("Growth", sheet));
    await view.waitFor(() => !document.querySelector(".reports-folder-sheet"));
    await view.waitFor(() => chosen.length === 1);
    expect(chosen).toEqual([GROWTH]);
  });
});

describe("Reports folder URLs", () => {
  test("parse and format /reports, /reports/folder/:id, /reports/unfiled, /reports/shared", () => {
    expect(parseRoute("/reports")).toEqual({ app: "reports", reportId: null });
    expect(parseRoute(`/reports/folder/${FINANCE.toUpperCase()}`)).toEqual({ app: "reports", reportId: null, folder: FINANCE });
    expect(parseRoute("/reports/unfiled")).toEqual({ app: "reports", reportId: null, folder: "unfiled" });
    expect(parseRoute("/reports/shared")).toEqual({ app: "reports", reportId: null, folder: "shared" });
    expect(parseRoute("/reports/folder/nope")).toEqual({ app: "reports", reportId: null });
    expect(parseRoute(`/reports/${REVENUE}`)).toEqual({ app: "reports", reportId: REVENUE });
    for (const path of ["/reports", `/reports/folder/${FINANCE}`, "/reports/unfiled", "/reports/shared", `/reports/${REVENUE}`]) expect(formatRoute(parseRoute(path))).toBe(path);
  });

  test("choosing a folder pushes its URL; Back and Forward move between folders", async () => {
    routes();
    await settle();
    window.history.replaceState(null, "", "/reports");
    const pushed: string[] = [];
    // The app's navigate: one history entry per move.
    const navigate = (route: Parameters<typeof formatRoute>[0], options?: { replace?: boolean }) => {
      pushed.push(formatRoute(route));
      window.history[options?.replace ? "replaceState" : "pushState"]({ "mynotes.depth": pushed.length }, "", formatRoute(route));
    };
    const view = await render(<RoleContext.Provider value="member">
      <ReportsApp displayName="Me" role="member" navigate={navigate} flash={noop} onHome={noop} onSettings={noop} onSignOut={noop} onOpenDatasources={noop} />
    </RoleContext.Provider>);
    await view.waitFor(() => rowTitles().length === 3);
    await view.click(navLink("Finance"));
    expect(pushed).toEqual([`/reports/folder/${FINANCE}`]);
    await view.waitFor(() => document.querySelector("#reports-title")?.textContent?.startsWith("Finance"));
    await view.click(navLink("Unfiled"));
    expect(pushed.at(-1)).toBe("/reports/unfiled");
    const { act } = await import("react");
    const pop = async (path: string) => act(async () => {
      window.history.replaceState({ "mynotes.depth": 1 }, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: { "mynotes.depth": 1 } }));
    });
    await pop(`/reports/folder/${FINANCE}`);
    await view.waitFor(() => document.querySelector("#reports-title")?.textContent?.startsWith("Finance"));
    await view.waitFor(() => rowTitles().join() === "Weekly revenue");
    await pop("/reports/unfiled");
    await view.waitFor(() => document.querySelector("#reports-title")?.textContent?.startsWith("Unfiled"));
    await view.waitFor(() => rowTitles().join() === "Trial conversions");
    await pop("/reports");
    await view.waitFor(() => document.querySelector("#reports-title")?.textContent?.startsWith("All reports"));
  });
});
