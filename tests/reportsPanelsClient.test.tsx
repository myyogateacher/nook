import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChartBlock, ReportDetail, ReportQuery } from "../shared/reports";
import { sampleSpec } from "./support/reportSeed";

mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { overflowItems, consoleOnPage, consoleInPanel } = await import("../src/reports/ReportPage");
const { copyReportLink, copyText, CopyLinkRow, LINK_COPIED, reportLink } = await import("../src/reports/reportLink");
const { ReportConsoleContext } = await import("../src/reports/reportConsole");
const { InspectSheet } = await import("../src/reports/InspectSheet");
const { ReportCommentContext } = await import("../src/reports/reportComment");
const { chartTheme } = await import("../src/reports/chartOption");

/**
 * Item 4: Share copies the report's link (and falls back to a selected field), readers get "Copy
 * link" in ⋯, the SQL console leaves a report with blocks for ⋯ → SQL console and Inspect → "Open in
 * console", and stays on an empty report; and the wide panels' CSS.
 */

const noop = () => undefined;
const handlers = { share: noop, rename: noop, model: noop, remove: noop };

describe("Share copies the link", () => {
  test("the link is the app's origin and the report route", () => {
    expect(reportLink("0b8f7c2e-1111-4111-8111-111111111111", "https://nook.example.test")).toBe("https://nook.example.test/reports/0b8f7c2e-1111-4111-8111-111111111111");
  });

  test("a click copies it and says so; a refusing clipboard opens the fallback instead", async () => {
    const written: string[] = [];
    const flashed: string[] = [];
    let fallback = 0;
    const ok = await copyReportLink("https://nook.example.test/reports/x", { flash: (message) => flashed.push(message), onFallback: () => { fallback += 1; }, clipboard: { writeText: async (text) => { written.push(text); } } });
    expect([ok, written, flashed, fallback]).toEqual([true, ["https://nook.example.test/reports/x"], [LINK_COPIED], 0]);
    expect(LINK_COPIED).toBe("Link copied. Only people the report is shared with can open it.");
    const refused = await copyReportLink("u", { flash: (message) => flashed.push(message), onFallback: () => { fallback += 1; }, clipboard: { writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } } });
    expect([refused, fallback, flashed.length]).toEqual([false, 1, 1]);
    expect(await copyText("u", undefined)).toBe(false);
  });

  test("the Share panel's link row: the URL read-only with Copy; after a refusal it says to copy it by hand", () => {
    const row = renderToStaticMarkup(<CopyLinkRow url="https://nook.example.test/reports/x" selectFirst={false} flash={noop} />);
    expect(row).toContain('readOnly=""');
    expect(row).toContain('value="https://nook.example.test/reports/x"');
    expect(row).toContain('class="secondary-button"');
    expect(row).not.toContain("Copy the link below");
    expect(renderToStaticMarkup(<CopyLinkRow url="u" selectFirst flash={noop} />)).toContain("Copy the link below");
  });

  test("viewers and commenters get Copy link in ⋯; the owner shares from the header", () => {
    const reader = overflowItems({ ownerWrite: false, owner: false, commands: {}, copyLink: noop, ...handlers });
    expect(reader.map((item) => [item.id, item.label])).toEqual([["copy-link", "Copy link"]]);
    const owner = overflowItems({ ownerWrite: true, owner: true, commands: {}, copyLink: noop, ...handlers });
    expect(owner.some((item) => item.id === "copy-link")).toBe(false);
    expect(owner.find((item) => item.id === "share")).toMatchObject({ narrowOnly: true });
  });
});

describe("the SQL console moves off a report with blocks", () => {
  const spec = sampleSpec();
  const report = (blocks: number, isOwner = true) => ({ isOwner, spec: { ...spec, specVersion: 2 as const, sections: [], blocks: spec.blocks.slice(0, blocks) } }) as Pick<ReportDetail, "isOwner" | "spec">;

  test("on the page only for an empty report; a panel otherwise; never for a reader", () => {
    expect([consoleOnPage(report(0)), consoleInPanel(report(0))]).toEqual([true, false]);
    expect([consoleOnPage(report(3)), consoleInPanel(report(3))]).toEqual([false, true]);
    expect([consoleOnPage(report(0, false)), consoleInPanel(report(3, false))]).toEqual([false, false]);
  });

  test("⋯ → SQL console for the owner of a report with blocks", () => {
    expect(overflowItems({ ownerWrite: true, owner: true, commands: {}, console: noop, ...handlers }).find((item) => item.id === "console")).toMatchObject({ label: "SQL console" });
    expect(overflowItems({ ownerWrite: true, owner: true, commands: {}, ...handlers }).some((item) => item.id === "console")).toBe(false);
    expect(overflowItems({ ownerWrite: false, owner: false, commands: {}, console: noop, copyLink: noop, ...handlers }).some((item) => item.id === "console")).toBe(false);
  });

  test("Inspect → Query has Open in console, which opens it prefilled with the block's SQL", () => {
    const block = spec.blocks.find((item) => item.id === "daily-line") as ChartBlock;
    const query = spec.queries.find((item) => item.key === block.queryKey) as ReportQuery;
    const detail = { id: "r", title: "Revenue", doc: null, spec } as unknown as ReportDetail;
    const props = { report: detail, block, query, view: undefined, palette: chartTheme("dark"), canRerun: true, busy: false, onRerun: noop, onClose: noop };
    const opened: Array<string | undefined> = [];
    const markup = renderToStaticMarkup(<ReportConsoleContext.Provider value={(sql) => opened.push(sql)}><InspectSheet {...props} initialTab="query" /></ReportConsoleContext.Provider>);
    expect(markup).toContain("Open in console");
    expect(renderToStaticMarkup(<InspectSheet {...props} initialTab="query" />)).not.toContain("Open in console");
  });

  test("Inspect → Query keeps Re-run and Ask for a change in one action row (release QA: they touched, stacked in two rows)", () => {
    const block = spec.blocks.find((item) => item.id === "daily-line") as ChartBlock;
    const query = spec.queries.find((item) => item.key === block.queryKey) as ReportQuery;
    const detail = { id: "r", title: "Revenue", doc: null, spec } as unknown as ReportDetail;
    const props = { report: detail, block, query, view: undefined, palette: chartTheme("dark"), canRerun: true, busy: false, onRerun: noop, onClose: noop };
    const rows = (markup: string) => [...markup.matchAll(/<div class="report-inspect-actions">([\s\S]*?)<\/div>/g)].map((match) => match[1]!);
    const both = rows(renderToStaticMarkup(<ReportCommentContext.Provider value={noop}><InspectSheet {...props} initialTab="query" /></ReportCommentContext.Provider>));
    const row = both.find((item) => item.includes("Re-run this query"));
    expect(row).toContain("Ask for a change");
    expect(both.filter((item) => item.includes("Ask for a change"))).toHaveLength(1);
    // A reader who may comment but not re-run still gets the button; the old second row is gone.
    const reader = renderToStaticMarkup(<ReportCommentContext.Provider value={noop}><InspectSheet {...props} canRerun={false} initialTab="query" /></ReportCommentContext.Provider>);
    expect(reader).toContain("Ask for a change");
    expect(reader).not.toContain("Re-run this query");
    expect(reader).not.toContain("report-inspect-comment");
  });
});

describe("wide panels (CSS)", () => {
  test("side panels clamp(480px, 40vw, 720px) from 1024 px; Inspect min(1100px, 92vw) and 88vh; full screen on a phone; SQL scrolls sideways", async () => {
    const css = await Bun.file(new URL("../src/reports/reports.css", import.meta.url)).text();
    const panels = ".file-dialog.reports-dialog:is(.report-changes, .report-edit-sheet, .report-schedule, .report-model-sheet, .report-console-sheet)";
    expect(css).toContain(`${panels} { width: clamp(480px, 40vw, 720px); }`);
    expect(css).toContain(".file-dialog.reports-dialog.report-inspect { width: min(1100px, 92vw); height: 88vh; max-height: 88vh; }");
    expect(css).toContain(`${panels} { top: 0; max-height: none; height: 100dvh; border: 0; border-radius: 0; }`);
    expect(css).toContain(".report-inspect .report-code { white-space: pre;");
  });
});
