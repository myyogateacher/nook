import { expect, test } from "bun:test";
import { hasAnyScope, hasScope, MCP_SCOPES, normalizeScopes, parseStoredScopes } from "../server/mcpScopes";

test("normalizeScopes adds implied read scopes, dedupes, and orders canonically", () => {
  expect(normalizeScopes(["tasks:write"])).toEqual(["tasks:read", "tasks:write"]);
  expect(normalizeScopes(["notes:write-draft", "files:read", "notes:write-draft"])).toEqual(["notes:read", "notes:write-draft", "files:read"]);
  expect(normalizeScopes([...MCP_SCOPES].reverse())).toEqual([...MCP_SCOPES]);
});

test("write implies read, never the other way", () => {
  expect(hasScope(["notes:write-draft"], "notes:read")).toBe(true);
  expect(hasScope(["notes:read"], "notes:write-draft")).toBe(false);
  expect(hasScope(["tasks:write"], "tasks:read")).toBe(true);
  expect(hasScope(["tasks:read"], "tasks:write")).toBe(false);
  expect(hasScope(["calendar:write"], "calendar:read")).toBe(true);
  expect(hasScope(["calendar:read"], "calendar:write")).toBe(false);
  expect(hasScope(["files:read"], "notes:read")).toBe(false);
  expect(hasAnyScope(["files:read"], ["notes:read", "files:read"])).toBe(true);
  expect(hasAnyScope([], ["notes:read"])).toBe(false);
});

test("stored scopes read leniently and never grant more than stored", () => {
  expect(parseStoredScopes('["notes:read"]')).toEqual(["notes:read"]);
  expect(parseStoredScopes(null)).toEqual(["notes:read"]);
  expect(parseStoredScopes("not json")).toEqual(["notes:read"]);
  expect(parseStoredScopes('{"notes:read":true}')).toEqual(["notes:read"]);
  expect(parseStoredScopes('["files:read","admin","future:write"]')).toEqual(["files:read"]);
  expect(parseStoredScopes('["calendar:write"]')).toEqual(["calendar:read", "calendar:write"]);
  expect(parseStoredScopes('["tasks:write"]')).toEqual(["tasks:read", "tasks:write"]);
  expect(parseStoredScopes("[]")).toEqual([]);
});

test("mcpScopesForRole: admins all, members all but team:read, viewers read scopes only, guests none (§7)", async () => {
  const { effectiveMcpScopes, mcpScopesForRole } = await import("../server/team/roles");
  expect(mcpScopesForRole("admin")).toEqual([...MCP_SCOPES]);
  expect(mcpScopesForRole("member")).toEqual(MCP_SCOPES.filter((scope) => scope !== "team:read"));
  // Viewers get no inbox scopes (D152), not even inbox:read.
  expect(mcpScopesForRole("viewer")).toEqual(["notes:read", "files:read", "tasks:read", "today:read", "calendar:read", "collections:read", "whiteboards:read", "agents:read", "reports:read"]);
  expect(normalizeScopes(["inbox:write"])).toEqual(["inbox:read", "inbox:write"]);
  expect(hasScope(["inbox:write"], "inbox:read")).toBe(true);
  expect(hasScope(["inbox:read"], "inbox:write")).toBe(false);
  expect(effectiveMcpScopes(["inbox:read", "inbox:write", "tasks:read"], "viewer")).toEqual(["tasks:read"]);
  expect(effectiveMcpScopes(["inbox:read", "inbox:write"], "member")).toEqual(["inbox:read", "inbox:write"]);
  expect(mcpScopesForRole("guest")).toEqual([]);
  expect(effectiveMcpScopes(["tasks:read", "tasks:write", "team:read"], "viewer")).toEqual(["tasks:read"]);
  expect(effectiveMcpScopes(["notes:read"], "guest")).toEqual([]);
});

test("every scope is classified exactly once as read or write, and bin:write is a write scope with no read (D171, T144)", async () => {
  const { MCP_READ_SCOPES, MCP_WRITE_SCOPES, isWriteScope, IMPLIED_READ_SCOPE } = await import("../server/mcpScopes");
  for (const scope of MCP_SCOPES) expect(Number(MCP_READ_SCOPES.includes(scope)) + Number(MCP_WRITE_SCOPES.includes(scope))).toBe(1);
  expect([...MCP_READ_SCOPES, ...MCP_WRITE_SCOPES].sort()).toEqual([...MCP_SCOPES].sort());
  // Every scope that implies a read is a write scope; bin:write is one without an implied read.
  for (const scope of Object.keys(IMPLIED_READ_SCOPE) as McpScopeName[]) expect(isWriteScope(scope)).toBe(true);
  expect(isWriteScope("bin:write")).toBe(true);
  expect(IMPLIED_READ_SCOPE["bin:write"]).toBeUndefined();
  expect(normalizeScopes(["bin:write"])).toEqual(["bin:write"]);
  expect(normalizeScopes(["notes:publish", "files:write"])).toEqual(["notes:read", "notes:publish", "files:read", "files:write"]);
});

test("alsoRequires is all-of: bin:write alone satisfies nothing that also needs a module write scope (D172)", async () => {
  const { hasAllScopes } = await import("../server/mcpScopes");
  expect(hasAllScopes(["bin:write"], ["bin:write", "tasks:write"])).toBe(false);
  expect(hasAllScopes(["bin:write", "tasks:write"], ["bin:write", "tasks:write"])).toBe(true);
  expect(hasAllScopes(["notes:read"], undefined)).toBe(true);
  expect(hasAllScopes(["bin:write", "notes:read"], ["bin:write", "notes:write-draft"])).toBe(false);
});

test("viewers can hold none of the Wave 19 scopes (snapshot, T144)", async () => {
  const { effectiveMcpScopes, mcpScopesForRole } = await import("../server/team/roles");
  expect(mcpScopesForRole("viewer")).toEqual(["notes:read", "files:read", "tasks:read", "today:read", "calendar:read", "collections:read", "whiteboards:read", "agents:read", "reports:read"]);
  expect(effectiveMcpScopes(["notes:publish", "files:write", "bin:write", "notes:read"], "viewer")).toEqual(["notes:read"]);
  expect(mcpScopesForRole("member")).toContain("bin:write");
});

type McpScopeName = import("../server/mcpScopes").McpScope;

test("reports:read and reports:write are a pair: write implies read and is a write scope; viewers get read only, guests nothing (Wave 45)", async () => {
  const { isWriteScope, MCP_READ_SCOPES } = await import("../server/mcpScopes");
  const { mcpScopesForRole } = await import("../server/team/roles");
  expect(normalizeScopes(["reports:write"])).toEqual(["reports:read", "reports:write"]);
  expect(hasScope(["reports:write"], "reports:read")).toBe(true);
  expect(hasScope(["reports:read"], "reports:write")).toBe(false);
  expect(isWriteScope("reports:write")).toBe(true);
  expect(MCP_READ_SCOPES).toContain("reports:read");
  expect(mcpScopesForRole("viewer")).toContain("reports:read");
  expect(mcpScopesForRole("viewer")).not.toContain("reports:write");
  expect(mcpScopesForRole("member")).toContain("reports:write");
  expect(mcpScopesForRole("guest")).toEqual([]);
});

test("the reports tools split by scope: reads under reports:read, every write under reports:write and counted; SQL only through update_report_query (Wave 48, D457, T361, T383)", async () => {
  // The registry first: importing the reports tools on their own closes an import cycle through it.
  await import("../server/mcpTools");
  const { reportTools } = await import("../server/reports/mcpTools");
  const read = ["list_reports", "list_report_datasources", "list_report_folders", "get_report", "get_report_block", "get_report_run", "get_report_instruction", "list_report_versions", "get_report_version_diff", "get_report_metrics", "list_report_owners", "list_unmanaged_reports"];
  const write = ["create_report", "refresh_report", "set_report_schedule", "add_report_instruction", "apply_report_proposal", "reject_report_proposal", "update_report_query", "create_report_folder", "move_report_to_folder", "update_report_metric", "star_report", "unstar_report",
    "update_report_folder", "add_report_owner"];
  expect(reportTools.map((tool) => tool.name).sort()).toEqual([...read, ...write].sort());
  for (const tool of reportTools) {
    const isWrite = write.includes(tool.name);
    expect([tool.name, tool.scopes, tool.write]).toEqual([tool.name, [isWrite ? "reports:write" : "reports:read"], isWrite]);
    if (isWrite) expect([tool.name, tool.buckets]).toEqual([tool.name, ["report_write"]]);
  }
  // No tool runs SQL it was handed: no run_sql, no console, nothing that deletes (the Bin's tools do).
  // Owner removal is app-only (D180, D482).
  expect(reportTools.some((tool) => /run_sql|console|sql|delete|remove|purge/i.test(tool.name))).toBe(false);
  // Review L4: the one tool that takes SQL is update_report_query, and the docs say so (no "no ad-hoc SQL" claim).
  const takesSql = reportTools.filter((tool) => "sql" in ((tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {})).map((tool) => tool.name);
  expect(takesSql).toEqual(["update_report_query"]);
  const source = await Bun.file(new URL("../server/reports/mcpTools.ts", import.meta.url)).text() + await Bun.file(new URL("../server/mcpScopes.ts", import.meta.url)).text();
  expect(source).not.toMatch(/no ad-hoc SQL|runs ad-hoc SQL/i);
  expect(source).toContain("update_report_query runs guarded SELECTs, saved as a version (T383)");
  const { mcpScopesForRole } = await import("../server/team/roles");
  expect(mcpScopesForRole("viewer").filter((scope) => scope.startsWith("reports:"))).toEqual(["reports:read"]);
});
