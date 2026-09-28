import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GENERAL_KEY_MODULES, SCOPE_GRANTS, SELECTOR_KINDS as SERVER_SELECTORS } from "../server/keyGrants";
import {
  expiryOptions, GRANT_MODULES, GRANT_SCOPES, grantChips, grantSummary, keyStateLabel, moduleChoices, permissionChoices, rowsToGrants, SELECTOR_KINDS, usageLabel,
  type GrantRow, type KeyGrantView
} from "../src/keys/keyGrants";
import { keyAfterRevoke, KeyRow, keyToRows } from "../src/keys/KeysSettings";
import type { ApiKey } from "../src/keys/keysApi";

/** Settings → API keys (access plan §E, §G "UI"): the client vocabulary, the builder's rules, and a key row. */

const policy = { keyMaxDays: 365, keyDefaultDays: 90, keyRequireExpiry: false, keysPerUser: 10, modules: [...GRANT_MODULES], mcpAllowed: true, restAllowed: true };
const row = (patch: Partial<GrantRow>): GrantRow => ({ key: crypto.randomUUID(), module: "notes", permission: "read", applies: "all", resourceIds: [], ...patch });

function apiKey(patch: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k1", name: "Claude Code", description: null, prefix: "mynotes_Ab3fXyZ", kind: "general", surfaces: "mcp",
    createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, expiresAt: new Date(Date.now() + 12 * 86_400_000 - 60_000).toISOString(), revokeAfter: null, revokedAt: null,
    rotatedFrom: null, state: "active", blockedBy: null, blockedMessage: null, revokedBy: null, revokeReason: null,
    grants: [{ module: "notes", permission: "read", resource: null, active: true, inactiveReason: null }], scopes: ["notes:read"], effectiveScopes: ["notes:read"],
    limits: {}, usage14d: Array.from({ length: 14 }, (_, index) => index === 13 ? 5 : 0), ...patch
  };
}

describe("key grants on the client", () => {
  test("mirror the server vocabulary: modules, scopes, and chosen-item kinds", () => {
    expect([...GRANT_MODULES]).toEqual([...GENERAL_KEY_MODULES]);
    for (const [scope, grant] of Object.entries(SCOPE_GRANTS)) expect(GRANT_SCOPES[grant.module as keyof typeof GRANT_SCOPES]?.[grant.permission]).toBe(scope as never);
    const clientPairs = Object.values(GRANT_SCOPES).flatMap((permissions) => Object.values(permissions));
    expect(clientPairs.sort()).toEqual(Object.keys(SCOPE_GRANTS).sort());
    for (const module of GRANT_MODULES) expect(SELECTOR_KINDS[module]?.kind).toBe(SERVER_SELECTORS[module]);
  });

  test("permission options say why one is off: admins only, read-only role, or team policy", () => {
    const member = permissionChoices("team", "member", policy);
    expect(member).toEqual([expect.objectContaining({ value: "read", disabled: true, reason: "Admins only" })]);
    const viewer = permissionChoices("tasks", "viewer", policy);
    expect(viewer.map((choice) => [choice.value, choice.disabled, choice.reason])).toEqual([["read", false, null], ["write", true, "Your team role reads only"]]);
    const off = permissionChoices("tasks", "member", { modules: ["notes"] });
    expect(off.every((choice) => choice.reason === "Turned off by team policy")).toBe(true);
    const modules = moduleChoices("viewer", policy);
    expect(modules.find((module) => module.value === "bin")).toMatchObject({ disabled: true });
    expect(modules.find((module) => module.value === "tasks")).toMatchObject({ disabled: false, firstPermission: "read" });
  });

  test("rows become the request's grants, with chosen items only where a module has them", () => {
    expect(rowsToGrants([row({}), row({ module: "tasks", permission: "write", applies: "chosen", resourceIds: ["b1", "b2"] })])).toEqual({
      grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "write", resourceIds: ["b1", "b2"] }], error: null
    });
    expect(rowsToGrants([]).error).toBe("Add at least one permission.");
    expect(rowsToGrants([row({}), row({})]).error).toContain("listed twice");
    expect(rowsToGrants([row({ module: "tasks", applies: "chosen" })]).error).toBe("Choose at least one board for Tasks, or pick All boards.");
    expect(grantSummary([row({ module: "tasks", permission: "write", applies: "chosen", resourceIds: ["b1", "b2"] })]))
      .toBe("Tasks: write tasks on 2 boards. Never shares, never manages access or keys, and never deletes forever.");
  });

  test("chips group chosen items, name them, and mark grants that grant nothing now", () => {
    const grants: KeyGrantView[] = [
      { module: "tasks", permission: "write", resource: { kind: "board", id: "b1", name: "Ops" }, active: true, inactiveReason: null },
      { module: "calendar", permission: "read", resource: { kind: "calendar", id: "c1", name: null }, active: false, inactiveReason: "no-access" },
      { module: "calendar", permission: "read", resource: { kind: "calendar", id: "c2", name: "Team" }, active: false, inactiveReason: "no-access" },
      { module: "team", permission: "read", resource: null, active: false, inactiveReason: "role" }
    ];
    expect(grantChips(grants).map((chip) => [chip.label, chip.active])).toEqual([
      ["Tasks: write tasks · Ops", true],
      ["Calendar: read calendar · 2 calendars (no current access)", false],
      ["Team: read team (your team role cannot use it)", false]
    ]);
    expect(keyToRows(apiKey({ grants }))).toEqual([
      { key: "edit-tasks:write:chosen", module: "tasks", permission: "write", applies: "chosen", resourceIds: ["b1"] },
      { key: "edit-calendar:read:chosen", module: "calendar", permission: "read", applies: "chosen", resourceIds: ["c1", "c2"] },
      { key: "edit-team:read:all", module: "team", permission: "read", applies: "all", resourceIds: [] }
    ]);
  });

  test("state lines: expiry, no expiry, grace, blocked, expired, revoked by an admin", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(keyStateLabel({ state: "active", expiresAt: "2026-10-10T12:00:00.000Z", revokeAfter: null }, now)).toEqual({ label: "Expires in 12 days", tone: "warn" });
    expect(keyStateLabel({ state: "active", expiresAt: "2026-12-28T12:00:00.000Z", revokeAfter: null }, now)).toEqual({ label: "Expires in 91 days", tone: "ok" });
    expect(keyStateLabel({ state: "active", expiresAt: null, revokeAfter: null }, now).label).toBe("No expiry");
    expect(keyStateLabel({ state: "grace", expiresAt: null, revokeAfter: "2026-09-29T11:00:00.000Z" }, now).label).toBe("Old key: stops in 23 h");
    expect(keyStateLabel({ state: "blocked", expiresAt: null, revokeAfter: null }, now).label).toBe("Blocked by team policy");
    expect(keyStateLabel({ state: "expired", expiresAt: null, revokeAfter: null }, now).label).toBe("Expired");
    expect(keyStateLabel({ state: "revoked", expiresAt: null, revokeAfter: null, revokedBy: "admin" }, now).label).toBe("Revoked by an admin");
    expect(usageLabel([0, 0])).toBe("No calls in the last 14 days");
    expect(usageLabel([1, 2])).toBe("3 calls in the last 14 days");
  });

  test("expiry options stop at the policy maximum and include the default", () => {
    expect(expiryOptions({ keyMaxDays: 30, keyDefaultDays: 14 }).map((option) => option.value)).toEqual(["7", "14", "30"]);
    expect(expiryOptions({ keyMaxDays: 365, keyDefaultDays: 90 }).find((option) => option.value === "90")?.description).toBe("Team default");
  });

  test("a key row shows kind, state, grants, usage, and 44 px actions, and never a token", () => {
    const markup = renderToStaticMarkup(<KeyRow apiKey={apiKey()} onRotate={() => undefined} onEdit={() => undefined} onRevoke={() => undefined} />);
    expect(markup).toContain("Claude Code");
    expect(markup).toContain(">MCP<");
    expect(markup).toContain("Expires in 12 days");
    expect(markup).toContain("<li>Notes: read notes</li>");
    expect(markup).toContain('aria-label="5 calls in the last 14 days"');
    for (const label of ["Rotate", "Edit", "Revoke"]) expect(markup).toContain(label);
    expect(markup).not.toContain("token");
    const grace = renderToStaticMarkup(<KeyRow apiKey={apiKey({ state: "grace", revokeAfter: new Date(Date.now() + 3_600_000).toISOString() })} onRotate={() => undefined} onRevoke={() => undefined} />);
    expect(grace).toContain("Revoke now");
    expect(grace).not.toContain("Rotate");
    const admin = renderToStaticMarkup(<KeyRow apiKey={apiKey({ state: "revoked", revokedBy: "admin", revokeReason: "Leaked" })} />);
    expect(admin).toContain("An admin revoked this key: “Leaked”");
  });

  test("after Revoke, Revoke now, Review, or Restore all, focus lands on a control, never the body (QA 0.12 item 2)", async () => {
    // The next live key down, else the one above, else none (New key, else the list heading).
    expect(keyAfterRevoke(["a", "b", "c"], "b")).toBe("c");
    expect(keyAfterRevoke(["a", "b", "c"], "c")).toBe("b");
    expect(keyAfterRevoke(["a"], "a")).toBeNull();
    expect(keyAfterRevoke(["a", "b"], "gone")).toBe("a");
    expect(renderToStaticMarkup(<KeyRow apiKey={apiKey()} />)).toContain('data-key-id="k1"');
    const source = await Bun.file(new URL("../src/keys/KeysSettings.tsx", import.meta.url)).text();
    expect(source).toContain("onRevoked={() => { closeDialogAfterReload(revokedFocusKey(dialog.key.id));");
    expect(source).toContain("onClose={() => closeDialogAfterReload(dialog.key.id)}");
    expect(source).toMatch(/\?\? \(newKeyRef\.current && !newKeyRef\.current\.disabled \? newKeyRef\.current : null\)\s+\?\? headingRef\.current;/);
    expect(source).toContain('<h4 ref={headingRef} tabIndex={-1}>Your keys</h4>');
    const review = await Bun.file(new URL("../src/McpBinnedReview.tsx", import.meta.url)).text();
    expect(review).toMatch(/refocusRef\.current = true;\s+setBusy\(false\);/);
    expect(review).toMatch(/if \(busy \|\| !refocusRef\.current\) return;\s+refocusRef\.current = false;\s+closeRef\.current\?\.focus\(\);/);
  });
});
