/**
 * D478 rendered with happy-dom: nested sheets each sit on their own history entry, Back closes the top
 * one, and Forward reopens them in order (Reports → Changes → Versions, → a proposal, → the Restore
 * confirm), plus a Settings-style dialog (API keys: HistoryDialogReopen) with a dropdown inside it.
 * × is an explicit close: Forward never reopens a layer closed that way, it steps back off its entry.
 * The page is opened on the landing entry (a deep link), where Back must never leave Nook.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import type { ReportDetail } from "../shared/reports";
import type { InstructionsView, ReportInstruction, ReportVersion } from "../shared/reportsEdit";
import { installDom, mockApi, render, type Rendered } from "./support/dom";

installDom("http://nook.test/reports/11111111-1111-4111-8111-111111111111");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ChangesPanel } = await import("../src/reports/ChangesPanel");
type ChangesSheet = import("../src/reports/ChangesPanel").ChangesSheet;
const { HistoryDialogReopen, newLayerReopenMemory, useHistoryDialogGuard } = await import("../src/ui/useHistoryDialogGuard");
const { isDialogSentinelState, popStateClosedDialog, resetHistoryDialogsForTests, useLayerOpener } = await import("../src/historyDialogs");
afterEach(() => { resetHistoryDialogsForTests(); });
const { ModalDialog } = await import("../src/files/Dialog");
const { Select } = await import("../src/ui/Select");

const REPORT = { id: "11111111-1111-4111-8111-111111111111", title: "Revenue", revision: 3, spec: { blocks: [], queries: [] } } as unknown as ReportDetail;
const instruction: ReportInstruction = {
  id: "22222222-2222-4222-8222-222222222222", reportId: REPORT.id, blockId: null, text: "Add a weekly chart", status: "proposed", position: 0,
  authorName: "Pat", isMine: true, via: "web", runId: null, agentRunId: null, summary: null, error: null, appliedVersion: null, autoApplied: false,
  createdAt: "2026-10-14T08:00:00.000Z", startedAt: null, finishedAt: null, decidedAt: null
} as ReportInstruction;
const view: InstructionsView = { instructions: [instruction], level: "owner", canComment: true, canApply: true, autoApply: false } as InstructionsView;
const version = (n: number, current: boolean): ReportVersion => ({ version: n, source: "edit", instructionId: null, restoredFrom: null, note: null, createdByName: "Pat", createdAt: "2026-10-14T08:00:00.000Z", blocks: 2, queries: 1, current });

function reportRoutes() {
  return {
    [`GET /reports/${REPORT.id}/instructions`]: () => view,
    [`GET /reports/${REPORT.id}/versions`]: () => ({ versions: [version(2, true), version(1, false)] }),
    [`GET /reports/${REPORT.id}/instructions/${instruction.id}/proposal`]: () => ({ error: "Not found" })
  };
}

/** The app's popstate handler: dialogs first (popStateClosedDialog), else a route change, recorded. */
function usePopState(routes: string[]) {
  useEffect(() => {
    const onPop = (event: PopStateEvent) => { if (!popStateClosedDialog(event)) routes.push("route"); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [routes]);
}

/** ReportPage's part: the Changes panel, its reopen, and the memory of the sheet over it. */
function ReportHost({ routes, routed = false }: { routes: string[]; routed?: boolean }) {
  if (!routed) usePopState(routes);
  const [changes, setChanges] = useState<{ blockId: string | null } | null>(null);
  const last = useRef<{ blockId: string | null }>({ blockId: null });
  const sheet = useRef(newLayerReopenMemory<ChangesSheet>());
  // As ReportPage: H3's opener, for Forward after Back went past the page.
  useLayerOpener("reports.changes", (blockId) => { last.current = { blockId: blockId || null }; setChanges(last.current); });
  return <>
    <button type="button" onClick={() => { last.current = { blockId: null }; setChanges({ blockId: null }); }}>Changes</button>
    {changes && <ChangesPanel report={REPORT} initialBlockId={null} onClose={() => setChanges(null)} reopen={() => setChanges(last.current)} sheetMemory={sheet} onReportChanged={() => undefined} />}
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
    window.history.pushState({ route: "report", "mynotes.depth": depth + 1 }, "", `/reports/${REPORT.id}`);
    setRoute("report");
  };
  return route === "report" ? <ReportHost key={mounts} routes={routes} routed /> : <button type="button" onClick={open}>Open report</button>;
}

const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((node) => node.textContent);
const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1)!;

const { act } = await import("react");

/**
 * The browser's Back or Forward: the move, any step back off a dead entry, and React's commits.
 * It waits on the popstate events themselves, not on a fixed sleep (a loaded host delivered them
 * late): the move's own, then more for as long as the app keeps stepping (a dead entry), until a
 * quiet window passes. A Forward with nothing ahead fires none and ends after NO_MOVE_MS.
 */
const NO_MOVE_MS = 1000;
const QUIET_MS = 30;
async function browser(view: Rendered, move: "back" | "forward") {
  let pops = 0;
  let popped: () => void = () => undefined;
  const onPop = () => { pops += 1; popped(); };
  const nextPop = (ms: number) => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    popped = () => { clearTimeout(timer); resolve(true); };
  });
  window.addEventListener("popstate", onPop);
  try {
    await act(async () => {
      const first = nextPop(NO_MOVE_MS);
      if (move === "back") window.history.back();
      else window.history.forward();
      if (!(await first) && pops === 0) return;
      // The app may step again (off a dead entry): wait until it stops.
      while (await nextPop(QUIET_MS)) { /* another step */ }
    });
    await act(async () => { await Bun.sleep(0); });
  } finally {
    window.removeEventListener("popstate", onPop);
  }
  await view.waitFor(() => true);
}

async function openReport() {
  const routes: string[] = [];
  mockApi(reportRoutes());
  const view = await render(<ReportHost routes={routes} />);
  await view.click(view.button("Changes")!);
  await view.waitFor(() => view.button("Versions"));
  return { view, routes };
}

describe("Reports: Changes → Versions → Restore confirm (D478)", () => {
  test("Back ×3 past the report to the list, then Forward ×3: the report, Changes, then Versions come back (H3)", async () => {
    const routes: string[] = [];
    mockApi(reportRoutes());
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "list", "mynotes.depth": depth + 1 }, "", "/reports");
    const view = await render(<RoutedReports routes={routes} />);
    await view.click(view.button("Open report")!);
    await view.click(view.button("Changes")!);
    await view.waitFor(() => view.button("Versions"));
    await view.click(view.button("Versions")!);
    await view.waitFor(() => view.button("Restore"));
    const length = window.history.length;
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "back");
    expect(view.button("Open report")).not.toBeNull();
    expect(routes).toEqual(["route"]);
    await browser(view, "forward");
    expect(view.button("Changes")).not.toBeNull();
    expect(titles()).toEqual([]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 1);
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "forward");
    await view.waitFor(() => view.button("Restore"));
    expect(titles()).toEqual(["Changes", "Versions"]);
    expect(window.history.length).toBe(length);
    expect(routes).toEqual(["route", "route"]);
    // Back still closes one layer at a time, and the report stays.
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(view.button("Changes")).not.toBeNull();
  });

  test("reached in-app (a pushed entry, D479): Back closes Versions, then Changes, staying on the report; Forward reopens both", async () => {
    // Home → Reports → the report, as navigate() pushes them: one level deeper each.
    const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
    window.history.pushState({ route: "reports", "mynotes.depth": depth + 1 }, "", "/reports");
    window.history.pushState({ route: "report", "mynotes.depth": depth + 2 }, "", `/reports/${REPORT.id}`);
    const { view, routes } = await openReport();
    await view.click(view.button("Versions")!);
    await view.waitFor(() => view.button("Restore"));
    await browser(view, "back");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(window.history.state).toEqual({ route: "report", "mynotes.depth": depth + 2 });
    expect(window.location.pathname).toBe(`/reports/${REPORT.id}`);
    await browser(view, "forward");
    await browser(view, "forward");
    await view.waitFor(() => view.button("Restore"));
    expect(titles()).toEqual(["Changes", "Versions"]);
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    // No route change reached the app: the report stayed on screen throughout.
    expect(routes).toEqual([]);
  });

  test("Back closes Versions, then Changes; Forward twice reopens Changes, then Versions over it", async () => {
    const { view, routes } = await openReport();
    await view.click(view.button("Versions")!);
    await view.waitFor(() => view.button("Restore"));
    const start = window.history.length;
    expect(titles()).toEqual(["Changes", "Versions"]);
    expect(isDialogSentinelState(window.history.state)).toBe(true);

    await browser(view, "back");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(isDialogSentinelState(window.history.state)).toBe(false);

    await browser(view, "forward");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "forward");
    await view.waitFor(() => view.button("Restore"));
    expect(titles()).toEqual(["Changes", "Versions"]);
    // No entry was added: Forward walked onto the layers' own entries.
    expect(window.history.length).toBe(start);

    // Restore asks first: the confirm is a third layer; Back closes it and Forward does not bring it back.
    await view.click(view.button("Restore")!);
    await view.waitFor(() => titles().length === 3);
    await browser(view, "back");
    expect(titles()).toEqual(["Changes", "Versions"]);
    await browser(view, "forward");
    expect(titles()).toEqual(["Changes", "Versions"]);

    // Back from every layer stays on the report: no route change ever reached the app.
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(routes).toEqual([]);
  });

  test("Back from Versions, then Forward twice: Versions comes back, and the second Forward goes nowhere", async () => {
    const { view, routes } = await openReport();
    await view.click(view.button("Versions")!);
    await view.waitFor(() => view.button("Restore"));
    await browser(view, "back");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "forward");
    await view.waitFor(() => view.button("Restore"));
    expect(titles()).toEqual(["Changes", "Versions"]);
    await browser(view, "forward");
    expect(titles()).toEqual(["Changes", "Versions"]);
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(routes).toEqual([]);
  });

  test("Changes → a proposal: Back closes the proposal, then Changes; Forward reopens both", async () => {
    const { view, routes } = await openReport();
    await view.click(view.button("Review")!);
    await view.waitFor(() => titles().includes("Review the change"));
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "forward");
    await browser(view, "forward");
    await view.waitFor(() => titles().includes("Review the change"));
    expect(titles()).toEqual(["Changes", "Review the change"]);
    await browser(view, "back");
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(routes).toEqual([]);
  });

  test("× on Versions is an explicit close: Back closes Changes, Forward reopens Changes only", async () => {
    const { view, routes } = await openReport();
    await view.click(view.button("Versions")!);
    await view.waitFor(() => view.button("Restore"));
    await view.click(topDialog().querySelector('[aria-label="Close"]')!);
    await browser(view, "forward");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "forward");
    expect(titles()).toEqual(["Changes"]);
    // Versions' old entry is stepped straight back off.
    await browser(view, "forward");
    expect(titles()).toEqual(["Changes"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(routes).toEqual([]);
  });
});

/** Settings → API keys' shape: the section offers its dialog back (HistoryDialogReopen); the dialog has a dropdown. */
function KeysHost({ routes }: { routes: string[] }) {
  usePopState(routes);
  const [dialog, setDialog] = useState<"edit" | null>(null);
  return <HistoryDialogReopen.Provider value={dialog ? () => setDialog(dialog) : null}>
    <button type="button" onClick={() => setDialog("edit")}>Edit key</button>
    {dialog && <KeyDialog onClose={() => setDialog(null)} />}
  </HistoryDialogReopen.Provider>;
}

function KeyDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<"read" | "write">("read");
  useHistoryDialogGuard(true, onClose);
  return <ModalDialog title="Edit key" onClose={onClose}>
    <Select label="Scope" value={scope} onChange={setScope} options={[{ value: "read", label: "Read" }, { value: "write", label: "Write" }]} presentation="popup" />
  </ModalDialog>;
}

describe("Settings: a key dialog with a dropdown inside (D478)", () => {
  test("Back closes the dropdown, then the dialog; Forward reopens the dialog, never the dropdown", async () => {
    const routes: string[] = [];
    const view = await render(<KeysHost routes={routes} />);
    await view.click(view.button("Edit key")!);
    const trigger = document.querySelector('[role="combobox"]')!;
    await view.click(trigger);
    await view.waitFor(() => document.querySelector('[role="listbox"]'));
    await browser(view, "back");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(titles()).toEqual(["Edit key"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    await browser(view, "forward");
    expect(titles()).toEqual(["Edit key"]);
    // A dropdown is not reopened: Forward onto its entry steps back off it.
    await browser(view, "forward");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(titles()).toEqual(["Edit key"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);
    expect(routes).toEqual([]);
  });
});
