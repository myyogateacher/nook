/**
 * Lane J2, rendered with happy-dom on its own (the history stack is module state): Versions opened from
 * the Changes panel keeps its layers above Changes (a VersionsMemory kept by the page), so Forward
 * reopens Changes, then Versions, then the version over it, after Changes remounts (D478, D479); and
 * after Back went past the report page, Forward brings back the page, Versions, and the version by
 * their layer keys (D480).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import type { ReportDetail } from "../shared/reports";
import { diffSpecVersions, type VersionHistoryItem } from "../shared/reportVersions";
import { installDom, mockApi, render, type Rendered } from "./support/dom";
import { historySpecs } from "./support/reportVersionsSeed";

installDom("http://nook.test/reports/0b8f7c2e-1111-4111-8111-111111111111");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ChangesPanel } = await import("../src/reports/ChangesPanel");
type ChangesSheet = import("../src/reports/ChangesPanel").ChangesSheet;
const { newVersionsMemory } = await import("../src/reports/VersionsSheet");
const { newLayerReopenMemory } = await import("../src/ui/useHistoryDialogGuard");
const { popStateClosedDialog, resetHistoryDialogsForTests, useLayerOpener, whenHistorySettled } = await import("../src/historyDialogs");
const { VersionsSheet } = await import("../src/reports/VersionsSheet");
// The history stack is module state another file may have left in use: start and end clean.
beforeEach(() => { resetHistoryDialogsForTests(); });
afterEach(() => { resetHistoryDialogsForTests(); });
const { act } = await import("react");

const REPORT_ID = "0b8f7c2e-1111-4111-8111-111111111111";
const specs = historySpecs();
const report = { id: REPORT_ID, title: "Revenue", isOwner: true, revision: 7, spec: specs[5]!, doc: null } as unknown as ReportDetail;
const item = (version: number, extra: Partial<VersionHistoryItem>): VersionHistoryItem => ({
  version, source: "manual", instructionId: null, restoredFrom: null, note: null, createdByName: "Pankaj", createdAt: "2026-10-14T08:00:00.000Z", blocks: 6, queries: 4, current: false,
  regenerated: false, askedByName: null, autoApplied: false, instructionText: null, runId: null, model: null, changeSummary: null, renamedTo: null, ...extra
});
const versions = [item(2, { source: "edit", current: true }), item(1, { source: "generate" })];
const titles = () => [...document.querySelectorAll('[role="dialog"] > .file-dialog-header h2')].map((node) => node.textContent);

function Host({ routes }: { routes: string[] }) {
  useEffect(() => {
    const onPop = (event: PopStateEvent) => { if (!popStateClosedDialog(event)) routes.push("route"); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [routes]);
  const [open, setOpen] = useState(false);
  const sheet = useRef(newLayerReopenMemory<ChangesSheet>());
  const memory = useRef(newVersionsMemory());
  return <>
    <button type="button" onClick={() => setOpen(true)}>Changes</button>
    {open && <ChangesPanel report={report} initialBlockId={null} onClose={() => setOpen(false)} reopen={() => setOpen(true)} sheetMemory={sheet} versionsMemory={memory.current} onReportChanged={() => undefined} />}
  </>;
}

async function browser(view: Rendered, move: "back" | "forward") {
  await act(async () => { if (move === "back") window.history.back(); else window.history.forward(); await Bun.sleep(40); });
  await act(async () => { await Bun.sleep(20); });
  await view.waitFor(() => true);
}

describe("Versions opened from Changes", () => {
  test("Changes → Versions → a version: Back closes all three; Forward reopens Changes, Versions, then the version", async () => {
    mockApi({
      [`GET /reports/${REPORT_ID}/instructions`]: () => ({ instructions: [], level: "owner", canComment: true, canApply: true, autoApply: false }),
      [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions }),
      [`GET /reports/${REPORT_ID}/version-diff?to=2&from=1`]: () => ({ diff: diffSpecVersions(specs[0]!, specs[1]!, { from: 1, to: 2 }) })
    });
    const routes: string[] = [];
    const view = await render(<Host routes={routes} />);
    await view.click(view.button("Changes")!);
    await view.click(await view.waitFor(() => view.button("Versions")));
    await view.click(await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open v2: Applied a change"]')));
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Changes", "Versions", "Version 2"]);

    await browser(view, "back");
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "forward");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 2);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Changes", "Versions", "Version 2"]);
    expect(routes).toEqual([]);

    await view.rerender(<></>);
    let settled = false;
    whenHistorySettled(() => { settled = true; });
    await view.waitFor(() => settled);
  });
});

/** As ReportPage: the Versions panel with its opener (D480), mounted fresh each time the route comes back. */
function ReportHost() {
  const [open, setOpen] = useState(false);
  const memory = useRef(newVersionsMemory());
  useLayerOpener("reports.versions", () => setOpen(true));
  return <>
    <button type="button" onClick={() => setOpen(true)}>Versions</button>
    {open && <VersionsSheet report={report} canRestore onClose={() => setOpen(false)} reopen={() => setOpen(true)} layerKey="reports.versions" memory={memory.current} onRestored={() => undefined} />}
  </>;
}

/** Reports list ↔ report as routes: a route popstate remounts the report page, as the app does. */
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
  return route === "report" ? <ReportHost key={mounts} /> : <button type="button" onClick={open}>Open report</button>;
}

describe("Versions after Back past the page (D480)", () => {
  test("report → Versions → v4 → its read-only view: Back ×4 to the list, Forward ×4 brings back the report, Versions, v4, and the view", async () => {
    const list = [item(4, { source: "manual", current: true }), item(3, { source: "edit" })];
    mockApi({
      [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: list }),
      [`GET /reports/${REPORT_ID}/version-diff?to=4&from=3`]: () => ({ diff: diffSpecVersions(specs[2]!, specs[3]!, { from: 3, to: 4 }) }),
      [`GET /reports/${REPORT_ID}/versions/4`]: () => ({ version: list[0], spec: specs[3], results: [] })
    });
    const routes: string[] = [];
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "list", "mynotes.depth": depth + 1 }, "", "/reports");
    const view = await render(<RoutedReports routes={routes} />);
    await view.click(view.button("Open report")!);
    await view.click(view.button("Versions")!);
    await view.click(await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open v4: Edited by hand"]')));
    await view.click(await view.waitFor(() => view.button("View this version")));
    await view.waitFor(() => document.querySelector(".report-vview-banner"));
    expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);
    const length = window.history.length;

    await browser(view, "back");
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "back");
    expect(view.button("Open report")).not.toBeNull();

    await browser(view, "forward");
    expect(view.button("Versions")).not.toBeNull();
    expect(titles()).toEqual([]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 1);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 2);
    expect(titles()).toEqual(["Versions", "Version 4"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);
    expect(window.history.length).toBe(length);
    expect(routes).toEqual(["route", "route"]);

    await view.rerender(<></>);
    let settled = false;
    whenHistorySettled(() => { settled = true; });
    await view.waitFor(() => settled);
  });
});

/** The report page alone, with the app's popstate check in front of its route handler. */
function PageHost({ routes }: { routes: string[] }) {
  useEffect(() => {
    const onPop = (event: PopStateEvent) => { if (!popStateClosedDialog(event)) routes.push("route"); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [routes]);
  return <ReportHost />;
}


/** The "Back" button inside the top sheet (the version's view, its detail, or Compare). */
async function sheetBack(view: Rendered) {
  const top = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
  await act(async () => { view.button("Back", top)!.click(); await Bun.sleep(40); });
  await act(async () => { await Bun.sleep(20); });
}

const fourVersions = () => {
  const list = [item(4, { source: "manual", current: true }), item(3, { source: "edit" })];
  mockApi({
    [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: list }),
    [`GET /reports/${REPORT_ID}/version-diff?to=4&from=3`]: () => ({ diff: diffSpecVersions(specs[2]!, specs[3]!, { from: 3, to: 4 }) }),
    [`GET /reports/${REPORT_ID}/versions/4`]: () => ({ version: list[0], spec: specs[3], results: [] })
  });
};

async function openView(view: Rendered) {
  await view.click(view.button("Versions")!);
  await view.click(await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open v4: Edited by hand"]')));
  await view.click(await view.waitFor(() => view.button("View this version")));
  await view.waitFor(() => document.querySelector(".report-vview-banner"));
  expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);
}

async function finishHistory(view: Rendered) {
  await view.rerender(<></>);
  let settled = false;
  whenHistorySettled(() => { settled = true; });
  await view.waitFor(() => settled);
}

describe("the Versions sheets' own Back buttons (L1)", () => {
  test("browser Back from the read-only view, then Forward: the view comes back", async () => {
    fourVersions();
    const routes: string[] = [];
    const view = await render(<PageHost routes={routes} />);
    await openView(view);
    await browser(view, "back");
    expect(titles()).toEqual(["Versions", "Version 4"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);
    expect(routes).toEqual([]);
    await finishHistory(view);
  });

  test("the view's Back, then the detail's Back: Forward reopens the detail, then the view; Compare's Back too", async () => {
    fourVersions();
    const routes: string[] = [];
    const view = await render(<PageHost routes={routes} />);
    await openView(view);
    const length = window.history.length;
    await sheetBack(view);
    expect(titles()).toEqual(["Versions", "Version 4"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);

    await sheetBack(view);
    await sheetBack(view);
    expect(titles()).toEqual(["Versions"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 2);
    expect(titles()).toEqual(["Versions", "Version 4"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);
    expect(window.history.length).toBe(length);

    // Compare, over the list: its Back steps back too, and Forward shows it again.
    await sheetBack(view);
    await sheetBack(view);
    await view.click(await view.waitFor(() => view.button("Compare versions")));
    await view.waitFor(() => titles().length === 2);
    expect(titles()).toEqual(["Versions", "Compare versions"]);
    await sheetBack(view);
    expect(titles()).toEqual(["Versions"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 2);
    expect(titles()).toEqual(["Versions", "Compare versions"]);
    expect(routes).toEqual([]);
    await finishHistory(view);
  });

  test("the sheets' Back, then browser Back past the page: Forward ×4 brings back the report, Versions, v4, and the view", async () => {
    fourVersions();
    const routes: string[] = [];
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "list", "mynotes.depth": depth + 1 }, "", "/reports");
    const view = await render(<RoutedReports routes={routes} />);
    await view.click(view.button("Open report")!);
    await openView(view);
    const length = window.history.length;

    await sheetBack(view);
    await sheetBack(view);
    expect(titles()).toEqual(["Versions"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "back");
    expect(view.button("Open report")).not.toBeNull();

    await browser(view, "forward");
    expect(view.button("Versions")).not.toBeNull();
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 1);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 2);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 3);
    expect(titles()).toEqual(["Versions", "Version 4", "Viewing v4"]);
    expect(window.history.length).toBe(length);
    expect(routes).toEqual(["route", "route"]);
    await finishHistory(view);
  });
});
