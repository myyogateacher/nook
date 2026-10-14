/**
 * Lane J: the Versions panel rendered with happy-dom: the header's Versions button and ⋯ entry, the
 * list's plain-words sources and who, a version's diff, the read-only view, Restore behind a
 * confirmation, and a reader's list (who, when, and the source only; nothing opens).
 */
import { describe, expect, mock, test } from "bun:test";
import type { ReportDetail } from "../shared/reports";
import { diffSpecVersions, type VersionHistoryItem } from "../shared/reportVersions";
import { captureToasts, installDom, mockApi, render } from "./support/dom";
import { historySpecs } from "./support/reportVersionsSeed";
import { sampleAnswer } from "./support/reportSeed";

installDom("http://nook.test/reports/0b8f7c2e-1111-4111-8111-111111111111");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { VersionsSheet, newVersionsMemory } = await import("../src/reports/VersionsSheet");
const { ReportRunsContext } = await import("../src/reports/RunsSheet");
const { overflowItems, ReportPage } = await import("../src/reports/ReportPage");
const { RoleContext } = await import("../src/team/roleAccess");
const { whenHistorySettled, popStateClosedDialog, isDialogSentinelState } = await import("../src/historyDialogs");
const { act, useEffect: useEffectHook, useRef: useRefHook, useState: useStateHook } = await import("react");

const REPORT_ID = "0b8f7c2e-1111-4111-8111-111111111111";
const specs = historySpecs();
const report = (isOwner = true): ReportDetail => ({
  id: REPORT_ID, title: "Revenue", datasourceId: "ds-1", datasourceName: "Analytics", status: "ready", isOwner, ownerName: "Pankaj",
  blockCount: specs[5]!.blocks.length, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", revision: 7,
  spec: specs[5]!, doc: null, lastError: null
});
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const item = (version: number, extra: Partial<VersionHistoryItem>): VersionHistoryItem => ({
  version, source: "manual", instructionId: null, restoredFrom: null, note: null, createdByName: "Pankaj", createdAt: ago(10 - version), blocks: 6, queries: 4, current: false,
  regenerated: false, askedByName: null, autoApplied: false, instructionText: null, runId: null, model: null, changeSummary: null, ...extra
});
const ownerList: VersionHistoryItem[] = [
  item(3, { source: "generate", regenerated: true, current: true, runId: "33333333-3333-4333-8333-333333333333", model: "claude-test-model", changeSummary: "+1 chart" }),
  item(2, { source: "edit", instructionId: "i-2", askedByName: "Ravi", instructionText: "Add a table of the latest orders", note: "Added the table", runId: "22222222-2222-4222-8222-222222222222", changeSummary: "+1 table, 1 query added" }),
  item(1, { source: "generate", changeSummary: "5 blocks, 3 queries" })
];
const readerList = ownerList.map((entry) => ({ ...entry, instructionText: null, note: null, runId: null, model: null, changeSummary: null }));
const noop = () => undefined;
const top = () => [...document.querySelectorAll(".file-dialog")].at(-1)!;

/** Unmounts whatever is still open and lets its history moves land, so no layer outlives a test. */
async function finish(view: Awaited<ReturnType<typeof render>>) {
  await view.rerender(<></>);
  await settleHistory(view);
}
async function settleHistory(view: Awaited<ReturnType<typeof render>>) {
  let settled = false;
  whenHistorySettled(() => { settled = true; });
  await view.waitFor(() => settled);
}

describe("the header", () => {
  test("Versions sits after Runs on wide screens and in ⋯ on a phone, for readers too", async () => {
    const owner = overflowItems({ ownerWrite: true, owner: true, commands: {}, runs: noop, versions: noop, share: noop, rename: noop, model: noop, remove: noop });
    expect(owner.map((entry) => entry.id).slice(0, 2)).toEqual(["runs", "versions"]);
    expect(owner.find((entry) => entry.id === "versions")).toMatchObject({ label: "Versions", narrowOnly: true });
    const reader = overflowItems({ ownerWrite: false, owner: false, commands: {}, versions: noop, copyLink: noop, share: noop, rename: noop, model: noop, remove: noop });
    expect(reader.map((entry) => entry.id)).toEqual(["copy-link", "versions"]);

    mockApi({ [`GET /reports/${REPORT_ID}`]: () => ({ report: report() }), [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: ownerList }) });
    const view = await render(<RoleContext.Provider value="admin">
      <ReportPage reportId={REPORT_ID} displayName="Pankaj" flash={noop} onBack={noop} onSettings={noop} onSignOut={noop} onGone={noop} />
    </RoleContext.Provider>);
    const actions = await view.waitFor(() => document.querySelector(".report-header-actions"));
    const labels = [...actions.querySelectorAll(":scope > button")].map((button) => button.textContent?.trim());
    expect(labels.indexOf("Versions")).toBe(labels.indexOf("Runs") + 1);
    await view.click(view.button("Versions", actions)!);
    await view.waitFor(() => document.querySelector(".report-versions-panel .report-vrow"));
    await view.click(document.querySelector('.report-versions-panel button[aria-label="Close"]')!);
    await view.waitFor(() => !document.querySelector(".report-versions-panel"));
    await settleHistory(view);
  });
});

describe("the panel (the owner)", () => {
  test("rows say the source in plain words, who asked and applied, when, the instruction, what changed, the model, and the run", async () => {
    mockApi({ [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: ownerList }) });
    const view = await render(<ReportRunsContext.Provider value={noop}><VersionsSheet report={report()} canRestore onClose={noop} reopen={noop} onRestored={noop} /></ReportRunsContext.Provider>);
    const rows = await view.waitFor(() => { const found = document.querySelectorAll(".report-vrow"); return found.length === 3 ? [...found] : null; });
    expect(rows[0]!.textContent).toContain("v3");
    expect(rows[0]!.textContent).toContain("Current");
    expect(rows[0]!.textContent).toContain("Regenerated");
    expect(rows[0]!.textContent).toContain("claude-test-model");
    expect(view.button("Open run", rows[0]!)).not.toBeNull();
    expect(rows[1]!.textContent).toContain("Applied a change");
    expect(rows[1]!.textContent).toContain("Asked by Ravi · applied by Pankaj");
    expect(rows[1]!.textContent).toContain("“Add a table of the latest orders”");
    expect(rows[1]!.textContent).toContain("+1 table, 1 query added");
    expect(rows[2]!.textContent).toContain("Generated from the doc");
    // When: relative, with the exact time in the tooltip.
    const time = rows[1]!.querySelector("time")!;
    expect(time.textContent).toBe("8 h ago");
    expect(time.getAttribute("title")).toMatch(/\d/);
    expect(view.button("Compare versions")).not.toBeNull();
    await finish(view);
  });

  test("a row opens its diff against the version before; Restore asks first, and only Confirm restores", async () => {
    const toasts = captureToasts();
    const diff = diffSpecVersions(specs[3]!, specs[4]!, { from: 1, to: 2 });
    const api = mockApi({
      [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: ownerList }),
      [`GET /reports/${REPORT_ID}/version-diff?to=2&from=1`]: () => ({ diff }),
      [`POST /reports/${REPORT_ID}/versions/2/restore`]: () => ({ version: 4, refreshRunId: "r" })
    });
    let restored = 0;
    const view = await render(<VersionsSheet report={report()} canRestore onClose={noop} reopen={noop} onRestored={() => { restored += 1; }} />);
    const open = await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open v2: Applied a change"]'));
    await view.click(open);
    await view.waitFor(() => document.querySelector(".report-vdiff"));
    expect(top().querySelector("h2")!.textContent).toBe("Version 2");
    expect(document.querySelector(".report-vdiff-summary")!.textContent).toContain(diff.summary);
    // A SQL change shows as red and green lines.
    expect(document.querySelectorAll(".report-vdiff-line.is-del").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".report-vdiff-line.is-add").length).toBeGreaterThan(0);

    await view.click(view.button("Restore", top())!);
    const dialog = await view.waitFor(() => document.querySelector(".app-confirm-layer"));
    expect(dialog.textContent).toContain("Restore v2?");
    expect(dialog.textContent).toContain("become a new version (v4)");
    await view.click(view.button("Cancel", dialog)!);
    await view.waitFor(() => !document.querySelector(".app-confirm-layer"));
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);

    await view.click(view.button("Restore", top())!);
    const again = await view.waitFor(() => document.querySelector(".app-confirm-layer"));
    await view.click(view.button("Restore v2", again)!);
    await view.waitFor(() => restored === 1);
    expect(api.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([`/reports/${REPORT_ID}/versions/2/restore`]);
    expect(toasts).toContainEqual({ kind: "success", message: "Restored v2 as v4; refreshing its queries" });
    await finish(view);
    await settleHistory(view);
  });

  test("View this version draws it read-only over its stored results, with the banner and Back to current", async () => {
    const spec = specs[0]!;
    const results = spec.queries.map((query) => {
      const answer = sampleAnswer(query.sql) as { meta: Array<{ name: string; type: string }>; data: unknown[][] };
      return query.key === "by_country" ? { queryKey: query.key, result: null, failed: null, stale: false } : {
        queryKey: query.key, failed: null, stale: false,
        result: { runId: "r1", queryKey: query.key, sql: query.sql, sentSql: query.sql, columns: answer.meta, rows: answer.data, rowCount: answer.data.length, truncated: false, rowsRead: null, bytesRead: null, chQueryId: null, ms: 1, error: null, errorCode: null, createdAt: "2026-10-08T09:00:00.000Z" }
      };
    });
    mockApi({
      [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: ownerList }),
      [`GET /reports/${REPORT_ID}/version-diff?to=2&from=1`]: () => ({ diff: diffSpecVersions(specs[0]!, specs[1]!, { from: 1, to: 2 }) }),
      [`GET /reports/${REPORT_ID}/versions/2`]: () => ({ version: ownerList[1], spec, results })
    });
    let closed = 0;
    const view = await render(<VersionsSheet report={report()} canRestore onClose={() => { closed += 1; }} reopen={noop} onRestored={noop} />);
    await view.click(await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open v2: Applied a change"]')));
    await view.click(await view.waitFor(() => view.button("View this version")));
    const banner = await view.waitFor(() => document.querySelector(".report-vview-banner"));
    expect(banner.textContent).toContain("Viewing v2 (read-only)");
    expect(banner.textContent).toContain("1 query has no stored data from then");
    expect(document.querySelector(".report-versions-wide")).not.toBeNull();
    const panel = document.querySelector(".report-vview")!;
    // Read-only: no toolbar, no inspect or block menus; the query without stored data says so.
    expect(panel.querySelector(".report-view-toolbar")).toBeNull();
    expect(panel.querySelector(".report-block-buttons")).toBeNull();
    expect(panel.textContent).toContain("No data stored from this version");
    expect(panel.querySelectorAll(".report-block").length).toBe(spec.blocks.length - 1);
    await view.click(view.button("Back to current", top())!);
    await view.waitFor(() => closed === 1);
    await settleHistory(view);
  });

  test("Compare: any two versions, swapped in place", async () => {
    const api = mockApi({
      [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: ownerList }),
      [`GET /reports/${REPORT_ID}/version-diff?to=3&from=2`]: () => ({ diff: diffSpecVersions(specs[1]!, specs[5]!, { from: 2, to: 3 }) }),
      [`GET /reports/${REPORT_ID}/version-diff?to=2&from=3`]: () => ({ diff: diffSpecVersions(specs[5]!, specs[1]!, { from: 3, to: 2 }) })
    });
    const view = await render(<VersionsSheet report={report()} canRestore onClose={noop} reopen={noop} onRestored={noop} />);
    await view.click(await view.waitFor(() => view.button("Compare versions")));
    await view.waitFor(() => document.querySelector(".report-vdiff-summary")?.textContent?.startsWith("v2 → v3"));
    await view.click(view.button("Swap")!);
    await view.waitFor(() => document.querySelector(".report-vdiff-summary")?.textContent?.startsWith("v3 → v2"));
    expect(api.calls.filter((call) => call.path.includes("version-diff")).map((call) => call.path)).toEqual([`/reports/${REPORT_ID}/version-diff?to=3&from=2`, `/reports/${REPORT_ID}/version-diff?to=2&from=3`]);
    await view.click(document.querySelector('.report-versions-panel button[aria-label="Close"]')!);
    await settleHistory(view);
  });
});

describe("the panel (a commenter or viewer)", () => {
  test("who, when, and the source; nothing opens, no compare, no restore", async () => {
    mockApi({ [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: readerList }) });
    const view = await render(<VersionsSheet report={report(false)} canRestore={false} onClose={noop} reopen={noop} onRestored={noop} />);
    const rows = await view.waitFor(() => { const found = document.querySelectorAll(".report-vrow"); return found.length === 3 ? [...found] : null; });
    expect(rows[1]!.textContent).toContain("Asked by Ravi · applied by Pankaj");
    expect(rows[1]!.textContent).not.toContain("latest orders");
    expect(document.querySelector(".report-vrow-open")).toBeNull();
    expect(view.button("Compare versions")).toBeNull();
    expect(view.button("Restore")).toBeNull();
    expect(view.button("Open run")).toBeNull();
    expect(document.body.textContent).toContain("what changed is shown to the report's owner");
    await finish(view);
  });
});

describe("Back and Forward, layer by layer (D478)", () => {
  const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((node) => node.textContent);

  /** ReportPage's part: the Versions panel, its reopen, and the memory of the layers over it. */
  function Host({ routes }: { routes: string[] }) {
    useEffectHook(() => {
      const onPop = (event: PopStateEvent) => { if (!popStateClosedDialog(event)) routes.push("route"); };
      window.addEventListener("popstate", onPop);
      return () => window.removeEventListener("popstate", onPop);
    }, [routes]);
    const [open, setOpen] = useStateHook(false);
    const memory = useRefHook(newVersionsMemory());
    return <>
      <button type="button" onClick={() => setOpen(true)}>Open versions</button>
      {open && <VersionsSheet report={report()} canRestore onClose={() => setOpen(false)} reopen={() => setOpen(true)} onRestored={noop} memory={memory.current} />}
    </>;
  }
  async function browser(view: Awaited<ReturnType<typeof render>>, move: "back" | "forward") {
    await act(async () => {
      if (move === "back") window.history.back();
      else window.history.forward();
      await Bun.sleep(40);
    });
    await act(async () => { await Bun.sleep(20); });
    await view.waitFor(() => true);
  }

  test("the panel, a version, and its read-only view: Back closes them one by one; Forward reopens them in order; the report never leaves", async () => {
    mockApi({
      [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: ownerList }),
      [`GET /reports/${REPORT_ID}/version-diff?to=2&from=1`]: () => ({ diff: diffSpecVersions(specs[0]!, specs[1]!, { from: 1, to: 2 }) }),
      [`GET /reports/${REPORT_ID}/versions/2`]: () => ({ version: ownerList[1], spec: specs[1], results: [] })
    });
    const routes: string[] = [];
    const view = await render(<Host routes={routes} />);
    await view.click(view.button("Open versions")!);
    await view.click(await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open v2: Applied a change"]')));
    await view.click(await view.waitFor(() => view.button("View this version")));
    await view.waitFor(() => document.querySelector(".report-vview-banner"));
    const start = window.history.length;
    expect(titles()).toEqual(["Versions", "Version 2", "Viewing v2"]);
    expect(isDialogSentinelState(window.history.state)).toBe(true);

    await browser(view, "back");
    expect(titles()).toEqual(["Versions", "Version 2"]);
    await browser(view, "back");
    expect(titles()).toEqual(["Versions"]);
    await browser(view, "back");
    expect(titles()).toEqual([]);

    await browser(view, "forward");
    expect(titles()).toEqual(["Versions"]);
    await browser(view, "forward");
    await view.waitFor(() => titles().length === 2);
    expect(titles()).toEqual(["Versions", "Version 2"]);
    await browser(view, "forward");
    await view.waitFor(() => document.querySelector(".report-vview-banner"));
    expect(titles()).toEqual(["Versions", "Version 2", "Viewing v2"]);
    expect(window.history.length).toBe(start);

    // The view's own Back button is a close of its layer; "Back to current" closes them all.
    await view.click(view.button("Back", [...document.querySelectorAll(".file-dialog")].at(-1)!)!);
    expect(titles()).toEqual(["Versions", "Version 2"]);
    await view.click(view.button("View this version")!);
    await view.waitFor(() => titles().length === 3);
    await view.click(view.button("Back to current")!);
    await view.waitFor(() => titles().length === 0);
    await settleHistory(view);
    expect(routes).toEqual([]);
  });
});
