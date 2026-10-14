/**
 * D478 rendered with happy-dom: nested sheets each sit on their own history entry, Back closes the top
 * one, and Forward reopens them in order (Reports → Changes → Versions, → a proposal, → the Restore
 * confirm), plus a Settings-style dialog (API keys: HistoryDialogReopen) with a dropdown inside it.
 * × is an explicit close: Forward never reopens a layer closed that way, it steps back off its entry.
 * The page is opened on the landing entry (a deep link), where Back must never leave Nook.
 */
import { describe, expect, mock, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import type { ReportDetail } from "../shared/reports";
import type { InstructionsView, ReportInstruction, ReportVersion } from "../shared/reportsEdit";
import { installDom, mockApi, render, type Rendered } from "./support/dom";

installDom("http://nook.test/reports/11111111-1111-4111-8111-111111111111");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ChangesPanel } = await import("../src/reports/ChangesPanel");
type ChangesSheet = import("../src/reports/ChangesPanel").ChangesSheet;
const { HistoryDialogReopen, newLayerReopenMemory, useHistoryDialogGuard } = await import("../src/ui/useHistoryDialogGuard");
const { isDialogSentinelState, popStateClosedDialog } = await import("../src/historyDialogs");
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
function ReportHost({ routes }: { routes: string[] }) {
  usePopState(routes);
  const [changes, setChanges] = useState<{ blockId: string | null } | null>(null);
  const last = useRef<{ blockId: string | null }>({ blockId: null });
  const sheet = useRef(newLayerReopenMemory<ChangesSheet>());
  return <>
    <button type="button" onClick={() => { last.current = { blockId: null }; setChanges({ blockId: null }); }}>Changes</button>
    {changes && <ChangesPanel report={REPORT} initialBlockId={null} onClose={() => setChanges(null)} reopen={() => setChanges(last.current)} sheetMemory={sheet} onReportChanged={() => undefined} />}
  </>;
}

const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((node) => node.textContent);
const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1)!;

const { act } = await import("react");

/** The browser's Back or Forward: the move, any step back off a dead entry, and React's commits. */
async function browser(view: Rendered, move: "back" | "forward") {
  await act(async () => {
    if (move === "back") window.history.back();
    else window.history.forward();
    await Bun.sleep(40);
  });
  await act(async () => { await Bun.sleep(20); });
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
