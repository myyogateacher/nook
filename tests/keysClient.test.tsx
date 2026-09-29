import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GENERAL_KEY_MODULES, SCOPE_GRANTS, SELECTOR_KINDS as SERVER_SELECTORS } from "../server/keyGrants";
import {
  expiryChoices, expiryDays, expiryOptions, GRANT_MODULES, NO_EXPIRY, rotationExpiryDefault, GRANT_SCOPES, grantChips, grantSummary, keyStateLabel, moduleChoices, permissionChoices, rowModuleChoices, rowPermissionChoices, rowsToGrants, SELECTOR_KINDS, usageLabel,
  type GrantRow, type KeyGrantView
} from "../src/keys/keyGrants";
import { expiryNote, keyAfterRevoke, KeyRow, keyToRows, revokeCopy } from "../src/keys/KeysSettings";
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

  test("the builder never offers a module and permission another row holds (Friction 4)", () => {
    const rows = [row({ key: "a", module: "today", permission: "read" }), row({ key: "b", module: "tasks", permission: "read" }), row({ key: "c", module: "notes", permission: "read" })];
    // Today has one permission, held by row 1: another row cannot pick Today; row 1 itself can.
    expect(rowModuleChoices("member", policy, rows, "b").find((module) => module.value === "today")).toMatchObject({ disabled: true, description: "Already in permission 1" });
    expect(rowModuleChoices("member", policy, rows, "a").find((module) => module.value === "today")).toMatchObject({ disabled: false, firstPermission: "read" });
    // Tasks still has write free: open, and a switch to it starts on the free permission.
    expect(rowModuleChoices("member", policy, rows, "c").find((module) => module.value === "tasks")).toMatchObject({ disabled: false, firstPermission: "write" });
    expect(rowPermissionChoices("tasks", "member", policy, rows, "c").map((choice) => [choice.value, choice.disabled, choice.reason])).toEqual([["read", true, "Already in permission 2"], ["write", false, null]]);
    // Add permission (no row of its own) skips modules whose permissions are all taken.
    expect(rowModuleChoices("member", policy, rows, null).find((module) => !module.disabled)?.value).toBe("notes");
  });

  test("the board picker hides chosen boards, keeps a placeholder, and its chip × is 28 px on desktop, 44 px on phones (Friction 3)", async () => {
    const builder = await Bun.file(new URL("../src/keys/GrantBuilder.tsx", import.meta.url)).text();
    expect(builder).toContain("const unchosen = resourceOptions.filter((option) => !row.resourceIds.includes(option.value));");
    expect(builder).toContain("placeholderWithValues={`Add another ${selector.one}…`} value={row.resourceIds} options={unchosen}");
    const combobox = await Bun.file(new URL("../src/ui/Combobox.tsx", import.meta.url)).text();
    expect(combobox).toContain("placeholder={value.length && !inSheet ? placeholderWithValues : placeholder}");
    const css = await Bun.file(new URL("../src/keys/keys.css", import.meta.url)).text();
    const desktop = css.indexOf(".grant-resources .ui-chip-remove { width: 28px; height: 28px; }");
    const phone = css.indexOf(".grant-resources .ui-chip-remove, .policies-role .ui-chip-remove { width: 44px; height: 44px; }");
    expect(desktop).toBeGreaterThan(-1);
    // The phone rule comes later, so it wins inside its media query.
    expect(phone).toBeGreaterThan(desktop);
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
    // Creating whiteboards makes new boards: never "on 0 whiteboards" (Wave 23 QA Q7).
    expect(grantSummary([row({ module: "whiteboards", permission: "write", applies: "chosen", resourceIds: [] })]))
      .toBe("Whiteboards: create whiteboards. Never shares, never manages access or keys, and never deletes forever.");
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

  test("No expiry (C2) sits next to the day choices, off with its reason when policy requires an expiry", () => {
    const open = { keyMaxDays: 30, keyDefaultDays: 14, keyRequireExpiry: false };
    expect(expiryChoices(open).map((option) => [option.value, option.disabled])).toEqual([["7", false], ["14", false], ["30", false], [NO_EXPIRY, false]]);
    const strict = { ...open, keyRequireExpiry: true };
    expect(expiryChoices(strict).at(-1)).toMatchObject({ value: NO_EXPIRY, label: "No expiry", disabled: true, description: "Team policy requires an expiry" });
    expect(expiryDays(NO_EXPIRY)).toBeNull();
    expect(expiryDays("30")).toBe(30);
    expect(expiryNote(open)).toBe("Team policy allows at most 30 days, or no expiry.");
    expect(expiryNote(strict)).toBe("Team policy allows at most 30 days and requires an expiry.");
    // A rotation starts on the key's own lifetime (capped), or No expiry when it has none and policy allows.
    const created = "2026-01-01T00:00:00.000Z";
    expect(rotationExpiryDefault({ createdAt: created, expiresAt: null }, open)).toBe(NO_EXPIRY);
    expect(rotationExpiryDefault({ createdAt: created, expiresAt: null }, strict)).toBe("14");
    expect(rotationExpiryDefault({ createdAt: created, expiresAt: "2026-01-08T00:00:00.000Z" }, open)).toBe("7");
    expect(rotationExpiryDefault({ createdAt: created, expiresAt: "2027-01-01T00:00:00.000Z" }, open)).toBe("30");
    // A key row says No expiry in words.
    expect(renderToStaticMarkup(<KeyRow apiKey={apiKey({ expiresAt: null })} />)).toContain(">No expiry<");
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

  test("the revoke confirm names the old key and its prefix during a grace, and the Inbox only when it has suggestions (Friction 7)", () => {
    const grace = revokeCopy(apiKey({ state: "grace", pendingProposals: 0 }));
    expect(grace.title).toBe("Revoke the old key for Claude Code now?");
    expect(grace.description).toContain("The old key (mynotes_Ab3fXyZ…) stops working at once");
    expect(grace.description).toContain("The new key keeps working.");
    expect(grace.description).not.toContain("Inbox");
    expect(revokeCopy(apiKey({ state: "grace", pendingProposals: 1 })).description).toContain("Its pending suggestion in the Inbox is withdrawn.");
    const plain = revokeCopy(apiKey({ pendingProposals: 3 }));
    expect(plain.title).toBe("Revoke Claude Code?");
    expect(plain.description).toBe("Clients using this key (mynotes_Ab3fXyZ…) stop working at once. Its 3 pending suggestions in the Inbox are withdrawn. This cannot be undone.");
    expect(revokeCopy(apiKey()).description).not.toContain("Inbox");
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

describe("KeysDialog while busy (review L5)", () => {
  test("Back while a request is in flight is undone and keeps the dialog open; afterwards it closes", async () => {
    const { createDialogGuard } = await import("../src/ui/useHistoryDialogGuard");
    const { withHistoryDepth } = await import("../src/appShellNavigation");
    let busy = true;
    let open = true;
    const closed: string[] = [];
    const undone: string[] = [];
    const guard = createDialogGuard({
      isOpen: () => open, markClosed: () => { open = false; }, close: () => closed.push("close"), openDepth: () => 2,
      undo: (direction) => { undone.push(direction); }, blocked: () => busy
    });
    // Back and Forward during the request: the browser's move is undone, nothing closes, the guard stays armed.
    expect(guard(withHistoryDepth({}, 1))).toBe(true);
    expect(guard(withHistoryDepth({}, 3))).toBe(true);
    expect({ closed, undone, open }).toEqual({ closed: [], undone: ["back", "forward"], open: true });
    // Once the response is in (the token is on screen), Back closes as usual.
    busy = false;
    expect(guard(withHistoryDepth({}, 1))).toBe(true);
    expect({ closed, open }).toEqual({ closed: ["close"], open: false });
  });

  test("the dialog traps Tab and hands busy to its history guard", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/keys/KeysDialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("onKeyDown={trapTabKey}");
    expect(source).toContain("useHistoryDialogGuard(true, onClose, { blocked: busy })");
  });
});
