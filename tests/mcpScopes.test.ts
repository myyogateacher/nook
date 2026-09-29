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
  expect(mcpScopesForRole("viewer")).toEqual(["notes:read", "files:read", "tasks:read", "today:read", "calendar:read", "collections:read", "whiteboards:read"]);
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
  expect(mcpScopesForRole("viewer")).toEqual(["notes:read", "files:read", "tasks:read", "today:read", "calendar:read", "collections:read", "whiteboards:read"]);
  expect(effectiveMcpScopes(["notes:publish", "files:write", "bin:write", "notes:read"], "viewer")).toEqual(["notes:read"]);
  expect(mcpScopesForRole("member")).toContain("bin:write");
});

type McpScopeName = import("../server/mcpScopes").McpScope;
