import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpKeyScopeChips } from "../src/McpKeyScopes";
import { keyScopeChips } from "../src/mcpPermissions";

test("a scope the key cannot use under the owner's role is marked inactive", () => {
  expect(keyScopeChips(["notes:read", "team:read"], ["notes:read"])).toEqual([
    { scope: "notes:read", label: "Read notes", active: true },
    { scope: "team:read", label: "Read team (admins only, inactive)", active: false }
  ]);
  // Without effective scopes (an older server) every stored scope is active.
  expect(keyScopeChips(["team:read"]).every((chip) => chip.active)).toBe(true);
});

test("Settings renders a demoted admin's team:read chip as inactive", () => {
  const markup = renderToStaticMarkup(<McpKeyScopeChips name="Team key" scopes={["notes:read", "team:read"]} effectiveScopes={["notes:read"]} />);
  expect(markup).toContain('aria-label="Permissions for Team key"');
  expect(markup).toContain("<li>Read notes</li>");
  expect(markup).toContain('<li class="inactive">Read team (admins only, inactive)</li>');
  const admin = renderToStaticMarkup(<McpKeyScopeChips name="Team key" scopes={["team:read"]} effectiveScopes={["team:read"]} />);
  expect(admin).toContain("<li>Read team</li>");
  expect(admin).not.toContain("inactive");
});

test("key chips name the Wave 19 permissions", () => {
  const markup = renderToStaticMarkup(<McpKeyScopeChips name="Agent" scopes={["notes:publish", "files:write", "bin:write"]} effectiveScopes={["notes:publish", "files:write", "bin:write"]} />);
  expect(markup).toContain("<li>Publish notes</li>");
  expect(markup).toContain("<li>Write files</li>");
  expect(markup).toContain("<li>Move to Bin</li>");
});
