import { expect, test } from "bun:test";
import { IMPLIED_READ_SCOPE, MCP_SCOPES } from "../server/mcpScopes";
import { ADMIN_ONLY_MCP_SCOPES, lockedScopes, MCP_PERMISSIONS, OFFERED_MCP_PERMISSIONS, offeredMcpPermissions, scopeLabel, toggleScope } from "../src/mcpPermissions";
import { ADMIN_ONLY_SCOPES, mcpScopesForRole } from "../server/team/roles";

test("the Settings permissions mirror the server scopes and their implied reads", () => {
  expect(MCP_PERMISSIONS.map((permission) => permission.scope)).toEqual([...MCP_SCOPES]);
  for (const permission of MCP_PERMISSIONS) expect(permission.implies).toBe(IMPLIED_READ_SCOPE[permission.scope]);
  expect(MCP_PERMISSIONS.find((permission) => permission.scope === "notes:write-draft")!.help).toContain("never publishes");
  expect(OFFERED_MCP_PERMISSIONS.map((permission) => permission.scope)).toEqual([...MCP_SCOPES]);
  expect(MCP_PERMISSIONS.find((permission) => permission.scope === "tasks:write")!.help).toBe("Create, move, and comment on cards, and manage tags, WIP limits, sprints (owner only), and attachments; never deletes.");
});

test("checking a write scope checks and locks its read scope", () => {
  const withWrite = toggleScope(["files:read"], "notes:write-draft", true);
  expect(withWrite).toEqual(["notes:read", "notes:write-draft", "files:read"]);
  expect(lockedScopes(withWrite)).toEqual(["notes:read"]);
  // The locked read scope cannot be unchecked while the write scope is.
  expect(toggleScope(withWrite, "notes:read", false)).toEqual(withWrite);
  // Unchecking the write scope unlocks, but keeps, the read scope.
  const withoutWrite = toggleScope(withWrite, "notes:write-draft", false);
  expect(withoutWrite).toEqual(["notes:read", "files:read"]);
  expect(lockedScopes(withoutWrite)).toEqual([]);
  expect(toggleScope(withoutWrite, "notes:read", false)).toEqual(["files:read"]);
});

test("scope chips use the permission labels", () => {
  expect(scopeLabel("notes:write-draft")).toBe("Write drafts");
  expect(scopeLabel("future:read")).toBe("future:read");
});

test("team:read is offered only to admins, matching the server's role scopes", () => {
  expect([...ADMIN_ONLY_MCP_SCOPES]).toEqual([...ADMIN_ONLY_SCOPES]);
  expect(offeredMcpPermissions("admin").map((permission) => permission.scope)).toEqual(mcpScopesForRole("admin"));
  for (const role of ["member", "viewer", "guest"] as const) {
    expect(offeredMcpPermissions(role).map((permission) => permission.scope)).toEqual(mcpScopesForRole(role));
  }
  expect(offeredMcpPermissions(undefined).some((permission) => permission.scope === "team:read")).toBe(false);
});

test("the client write list mirrors the server's, so viewers are never offered bin:write, notes:publish, or files:write (D171)", async () => {
  const { MCP_WRITE_SCOPES: serverWrite } = await import("../server/mcpScopes");
  const { MCP_WRITE_SCOPES: clientWrite, isWriteScope } = await import("../src/mcpPermissions");
  expect([...clientWrite]).toEqual([...serverWrite]);
  expect(isWriteScope("bin:write")).toBe(true);
  const viewerScopes = offeredMcpPermissions("viewer").map((permission) => permission.scope);
  for (const scope of ["bin:write", "notes:publish", "files:write"] as const) expect(viewerScopes).not.toContain(scope);
  expect(MCP_PERMISSIONS.find((permission) => permission.scope === "notes:publish")!.warning).toBe("An agent can make its drafts visible to everyone the note is shared with.");
  expect(toggleScope([], "notes:publish", true)).toEqual(["notes:read", "notes:publish"]);
  expect(toggleScope([], "files:write", true)).toEqual(["files:read", "files:write"]);
  expect(toggleScope([], "bin:write", true)).toEqual(["bin:write"]);
});

test("every permission description ends with a full stop, so \"Included with write access.\" reads as its own sentence (1c)", () => {
  for (const permission of MCP_PERMISSIONS) {
    expect({ scope: permission.scope, help: permission.help.endsWith(".") }).toEqual({ scope: permission.scope, help: true });
    if (permission.warning) expect(permission.warning.endsWith(".")).toBe(true);
  }
});

test("Settings → MCP server controls are 44 px targets on phones (5b)", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("/* 5b: 44 px phone targets"));
  expect(phone).toContain(".settings-header .icon-button, .mcp-endpoint .icon-button { width: 44px; height: 44px; }");
  expect(phone).toContain(".mcp-key-list .text-danger { min-height: 44px;");
  expect(phone).toContain(".mcp-key-form .primary-button { min-height: 44px; }");
});
