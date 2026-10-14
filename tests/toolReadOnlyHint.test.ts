import { describe, expect, test } from "bun:test";
import "./support/harness";

const { defaultPolicy, parseTools, storedTool } = await import("../server/agents/toolServers");
const { checkBrowseTools } = await import("../server/reports/docBrowse");
type McpToolInfo = import("../server/agents/mcpClient").McpToolInfo;

/**
 * Tool-server sync keeps the server's raw `readOnlyHint` and `destructiveHint` (tri-state: absent
 * means "not annotated"), so a declared write (`readOnlyHint: false`) differs from a tool the server
 * said nothing about. Stored rows from before keep parsing; the default policy is unchanged.
 */

const info = (annotations: McpToolInfo["annotations"]): McpToolInfo => ({ name: "fetch", title: null, description: "", inputSchema: { type: "object" }, annotations });

describe("raw tool hints", () => {
  test("sync stores readOnlyHint and destructiveHint only when the server gave them", () => {
    const declaredWrite = storedTool(info({ readOnlyHint: false, destructiveHint: false, openWorldHint: null }));
    expect(declaredWrite).toMatchObject({ readOnly: false, destructive: false, readOnlyHint: false, destructiveHint: false });
    const silent = storedTool(info({ readOnlyHint: null, destructiveHint: null, openWorldHint: null }));
    expect(["readOnlyHint" in silent, "destructiveHint" in silent, silent.readOnly]).toEqual([false, false, false]);
    const reader = storedTool(info({ readOnlyHint: true, destructiveHint: null, openWorldHint: false }));
    expect(reader).toMatchObject({ readOnly: true, readOnlyHint: true });
    // The default policy is unchanged: auto only for a declared read-only tool.
    expect([defaultPolicy(declaredWrite), defaultPolicy(silent), defaultPolicy(reader)]).toEqual(["confirm", "confirm", "auto"]);
  });

  test("stored JSON round-trips; rows synced before the hints were kept parse without them; junk hints are dropped", () => {
    const stored = [storedTool(info({ readOnlyHint: false, destructiveHint: true, openWorldHint: null }))];
    expect(parseTools(JSON.stringify(stored))[0]).toMatchObject({ readOnlyHint: false, destructiveHint: true, destructive: true });
    const old = parseTools(JSON.stringify([{ name: "fetch", title: null, description: "", inputSchema: { type: "object" }, readOnly: true, openWorld: false, destructive: false }]))[0]!;
    expect(["readOnlyHint" in old, "destructiveHint" in old, old.readOnly]).toEqual([false, false, true]);
    const junk = parseTools(JSON.stringify([{ name: "fetch", readOnlyHint: "false", destructiveHint: 0 }]))[0]!;
    expect(["readOnlyHint" in junk, "destructiveHint" in junk]).toEqual([false, false]);
  });

  test("a declared write cannot be ticked for doc browsing, even at Auto", () => {
    const base = { title: null, description: "", inputSchema: { type: "object" }, readOnly: false, openWorld: true, destructive: false, policy: "auto" as const };
    expect(checkBrowseTools([{ ...base, name: "fetch" }], ["fetch"], "Outline")).toEqual(["fetch"]);
    expect(() => checkBrowseTools([{ ...base, name: "sync_pages", readOnlyHint: false }], ["sync_pages"], "Outline")).toThrow(expect.objectContaining({ code: "DOC_TOOL_REFUSED" }));
  });
});
