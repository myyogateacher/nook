import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocServerChoice } from "../shared/reportsGenerate";
import { DocSourceNotice, docModeDisabled, docSourceState } from "../src/reports/NewReportSheet";
import { BrowseToolsPicker } from "../src/reports/BrowseToolsPicker";
import { docChangedText } from "../src/reports/ReportGeneration";
import { overflowItems } from "../src/reports/ReportPage";
import { defaultBrowseTools, type DocPageInfo } from "../shared/reportsGenerate";

/**
 * New report's "From a doc" (B1, B2): why it is unavailable (the doc servers failed to load, with
 * Retry; none yet), or why the chosen server may not work (never synced; a doc tool whose policy is
 * not Auto, with the admin's "Allow … automatically"; no doc tool at all, listing its tools), with
 * the admin's link to Settings → AI → Tool servers. Only the first two turn "From a doc" off. Then
 * the dialog's copy ("How Nook reads the doc", "Tool", "Link goes into") and its layout rules.
 */

const server = (patch: Partial<DocServerChoice> = {}): DocServerChoice => ({
  id: "s1", name: "Outline", status: "ok", synced: true, tools: [{ name: "fetch", title: null, args: ["id"] }], pick: { tool: "fetch", arg: "id", outline: false },
  candidates: [], toolNames: ["fetch"], ...patch
});
const render = (state: ReturnType<typeof docSourceState>, admin: boolean, onAllow?: () => void) => renderToStaticMarkup(<DocSourceNotice state={state} admin={admin} onRetry={() => undefined} onAllow={onAllow} />);
const stateFor = (patch: Partial<DocServerChoice>) => docSourceState([server(patch)], null, server(patch));

describe("From a doc: states", () => {
  test("load failed: the error and Retry; From a doc is off", () => {
    const state = docSourceState(null, "Network error", null);
    expect(state).toEqual({ kind: "failed", message: "Network error" });
    expect(docModeDisabled(state)).toBe(true);
    const html = render(state, false);
    expect(html).toContain("Could not load the doc servers: Network error");
    expect(html).toContain(">Retry</button>");
    expect(html).not.toContain("an admin adds");
  });

  test("no servers: says so, with the link for admins only; From a doc is off", () => {
    const state = docSourceState([], null, null);
    expect(state.kind).toBe("none");
    expect(docModeDisabled(state)).toBe(true);
    expect(render(state, true)).toContain('href="/settings/ai/tools"');
    const member = render(state, false);
    expect(member).not.toContain("href=");
    expect(member).toContain("an admin adds the doc system");
  });

  test("an unsynced server: says it hasn't been synced; From a doc stays on", () => {
    const unsynced = stateFor({ synced: false, tools: [], pick: null, toolNames: [] });
    expect(unsynced).toEqual({ kind: "ready", issue: { kind: "unsynced", serverId: "s1", serverName: "Outline" } });
    expect(docModeDisabled(unsynced)).toBe(false);
    expect(render(unsynced, true)).toContain("Outline hasn&#x27;t been synced yet");
    expect(render(unsynced, true)).toContain('href="/settings/ai/tools"');
    expect(render(unsynced, false)).toContain("Ask an admin to sync it");
  });

  test("a doc tool held back by policy: names it; admins get Allow … automatically", () => {
    const needs = stateFor({ tools: [], pick: null, candidates: [{ name: "fetch", args: ["resource", "id"], policy: "confirm" }], toolNames: ["fetch", "search"] });
    expect(needs).toEqual({ kind: "ready", issue: { kind: "needs-auto", serverId: "s1", serverName: "Outline", tool: "fetch", policy: "confirm" } });
    expect(docModeDisabled(needs)).toBe(false);
    const admin = render(needs, true, () => undefined);
    expect(admin).toContain("Outline&#x27;s <code>fetch</code> needs to be allowed to run automatically");
    expect(admin).toContain("Ask first");
    expect(admin).toContain(">Allow fetch automatically</button>");
    expect(admin).toContain('href="/settings/ai/tools"');
    const member = render(needs, false, () => undefined);
    expect(member).not.toContain("Allow fetch automatically</button>");
    expect(member).toContain("Ask an admin to allow it");
  });

  test("no doc tool at all: lists the server's tools", () => {
    const none = stateFor({ tools: [{ name: "search", title: null, args: ["query"] }], pick: null, candidates: [], toolNames: ["search", "list_collections"] });
    expect(none).toEqual({ kind: "ready", issue: { kind: "no-tool", serverId: "s1", serverName: "Outline", tools: ["search", "list_collections"] } });
    const html = render(none, false);
    expect(html).toContain("has no tool that returns a document");
    expect(html).toContain("Its tools: <span><code>search</code></span><span>, <code>list_collections</code></span>.");
  });

  test("loading and a working server show nothing", () => {
    expect(render(docSourceState(null, null, null), true)).toBe("");
    expect(render(docSourceState([server()], null, server()), true)).toBe("");
  });
});

describe("the doc tool picker's copy and layout", () => {
  const source = readFileSync("src/reports/NewReportSheet.tsx", "utf8");
  const css = readFileSync("src/reports/generate.css", "utf8");

  test("the disclosure and its two fields explain themselves", () => {
    expect(source).toContain("<summary>How Nook reads the doc</summary>");
    expect(source).toContain(">Tool</span>");
    expect(source).toContain("The doc server's tool that returns a document, e.g. Outline's <code>fetch</code>.");
    expect(source).toContain(">Link goes into</label>");
    expect(source).toContain("That tool's input for the link, e.g. <code>id</code>.");
    expect(source).not.toContain("Argument for the link");
  });

  test("each field stacks its label over its input; the body scrolls under a bordered sticky footer", () => {
    // <details> content is not a grid item, so the fields sit in their own grid wrappers.
    expect(css).toMatch(/\.new-report-advanced-body \{ display: grid;/);
    expect(css).toMatch(/\.new-report-field \{ display: grid;/);
    expect(css).toMatch(/\.new-report-sheet > \.file-dialog-form > \.file-dialog-actions:last-child \{ border-top: 1px solid/);
  });
});

describe("B3: tools the AI may use to read more docs", () => {
  test("fetch, list, and search tools are ticked by default", () => {
    expect(defaultBrowseTools(["fetch", "search", "list_documents", "list_collection_documents", "create_document", "get_page"])).toEqual(["fetch", "search", "list_documents", "list_collection_documents"]);
  });

  test("Auto tools can be ticked; the others are greyed out with why", () => {
    const html = renderToStaticMarkup(<BrowseToolsPicker server={{ name: "Outline", tools: [{ name: "fetch", title: null, args: ["id"] }, { name: "search", title: null, args: ["query"] }], toolNames: ["fetch", "search", "delete_document"] }} value={["fetch"]} onChange={() => undefined} />);
    expect(html).toContain("Tools the AI may use to read more docs");
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span class="browse-tools-name"><code>fetch<\/code>/);
    expect(html).toMatch(/<input type="checkbox"\/><span class="browse-tools-name"><code>search<\/code>/);
    expect(html).toContain('<li class="is-excluded"><label><input type="checkbox" disabled=""/><span class="browse-tools-name"><code>delete_document</code><span class="browse-tools-why">needs Auto in Settings → AI → Tool servers</span>');
  });

  test("the Doc changed banner names the main doc, a linked page, or both", () => {
    const page = (title: string | null, changed: boolean): DocPageInfo => ({ id: title ?? "p", title, tool: "fetch", serverName: "Outline", bytes: 10, sha256: "a".repeat(64), fetchedAt: "2026-10-14T00:00:00.000Z", checkedAt: null, changed });
    const latest = { id: "s", sha256: "b".repeat(64), title: "Revenue metrics", bytes: 10, fetchedAt: "2026-10-14T00:00:00.000Z" };
    expect(docChangedText({ mainChanged: true, pages: [page("Rules", false)], latest })).toBe("The doc (Revenue metrics) changed since this report was generated.");
    expect(docChangedText({ mainChanged: false, pages: [page("Rules", true)], latest })).toBe("The linked page “Rules” changed since this report was generated.");
    expect(docChangedText({ mainChanged: true, pages: [page("Rules", true), page(null, true), page("C", true)], latest })).toBe("Both the doc (Revenue metrics) and the linked pages “Rules” and “a page read with fetch” and 1 more changed since this report was generated.");
  });

  test("⋯ has Doc settings for the owner once the generation part offers it", () => {
    const noop = () => undefined;
    const handlers = { share: noop, rename: noop, model: noop, remove: noop };
    const ids = overflowItems({ ownerWrite: true, owner: true, commands: { checkDoc: { run: noop, busy: false }, regenerate: { run: noop, busy: false }, docSettings: { open: noop } }, ...handlers }).map((item) => item.id);
    expect(ids).toEqual(["share", "rename", "model", "check-doc", "doc-settings", "regenerate", "bin"]);
  });
});
