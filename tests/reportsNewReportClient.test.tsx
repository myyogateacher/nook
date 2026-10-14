import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocServerChoice } from "../shared/reportsGenerate";
import { DocSourceNotice, docModeDisabled, docSourceState } from "../src/reports/NewReportSheet";

/**
 * New report's "From a doc" (B1): why it is unavailable (the doc servers failed to load, with Retry;
 * none yet), or why the chosen server may not work (never synced; no read-only fetch tool), with the
 * admin's link to Settings → AI → Tool servers. Only the first two turn "From a doc" off.
 */

const server = (patch: Partial<DocServerChoice> = {}): DocServerChoice => ({
  id: "s1", name: "Outline", status: "ok", synced: true, tools: [{ name: "fetch", title: null, args: ["id"] }], pick: { tool: "fetch", arg: "id", outline: false }, ...patch
});
const render = (state: ReturnType<typeof docSourceState>, admin: boolean) => renderToStaticMarkup(<DocSourceNotice state={state} admin={admin} onRetry={() => undefined} />);

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

  test("an unsynced server or one with no read-only fetch tool: says why; From a doc stays on", () => {
    const unsynced = docSourceState([server({ synced: false, tools: [], pick: null })], null, server({ synced: false, tools: [], pick: null }));
    expect(unsynced).toEqual({ kind: "ready", issue: { kind: "unsynced", serverName: "Outline" } });
    expect(docModeDisabled(unsynced)).toBe(false);
    expect(render(unsynced, true)).toContain("Outline hasn&#x27;t been synced yet");
    expect(render(unsynced, true)).toContain('href="/settings/ai/tools"');
    expect(render(unsynced, false)).toContain("Ask an admin to sync it");
    const noTool = docSourceState([server({ pick: null })], null, server({ pick: null }));
    expect(noTool).toEqual({ kind: "ready", issue: { kind: "no-tool", serverName: "Outline" } });
    expect(docModeDisabled(noTool)).toBe(false);
    expect(render(noTool, false)).toContain("has no read-only tool that returns a document");
  });

  test("loading and a working server show nothing", () => {
    expect(render(docSourceState(null, null, null), true)).toBe("");
    expect(render(docSourceState([server()], null, server()), true)).toBe("");
  });
});
