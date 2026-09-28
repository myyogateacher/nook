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
  expect(mcpScopesForRole("viewer")).toEqual(["notes:read", "files:read", "tasks:read", "today:read", "calendar:read", "collections:read"]);
  expect(normalizeScopes(["inbox:write"])).toEqual(["inbox:read", "inbox:write"]);
  expect(hasScope(["inbox:write"], "inbox:read")).toBe(true);
  expect(hasScope(["inbox:read"], "inbox:write")).toBe(false);
  expect(effectiveMcpScopes(["inbox:read", "inbox:write", "tasks:read"], "viewer")).toEqual(["tasks:read"]);
  expect(effectiveMcpScopes(["inbox:read", "inbox:write"], "member")).toEqual(["inbox:read", "inbox:write"]);
  expect(mcpScopesForRole("guest")).toEqual([]);
  expect(effectiveMcpScopes(["tasks:read", "tasks:write", "team:read"], "viewer")).toEqual(["tasks:read"]);
  expect(effectiveMcpScopes(["notes:read"], "guest")).toEqual([]);
});
