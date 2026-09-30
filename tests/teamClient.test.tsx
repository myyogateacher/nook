import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as serverRoles from "../server/team/roles";
import { AccountActions, TeamNavContext, type TeamNav } from "../src/AppShell";
import type { TeamEvent, TeamMember } from "../src/team/teamApi";
import { eventLabel, filterTeam, isNewAccount, lastAdminReason, NEW_ACCOUNT_MS, statusLabel, teamBackAction, teamFilters } from "../src/team/teamFormat";
import { canManageTeam, canSeeTeam, roleOptions, ROLE_DESCRIPTIONS, ROLES, SELECTABLE_ROLES } from "../src/team/teamRoles";
import { TeamSection } from "../src/team/TeamApp";
import { Select } from "../src/ui/Select";

const member = (overrides: Partial<TeamMember>): TeamMember => ({
  id: crypto.randomUUID(), displayName: "Someone", role: "member", status: "active", createdAt: "2026-01-01T00:00:00.000Z", isYou: false, ...overrides
});

describe("Team roles on the client", () => {
  test("mirror the server's role list, and selectable roles", () => {
    expect([...ROLES]).toEqual([...serverRoles.ROLES]);
    expect([...SELECTABLE_ROLES]).toEqual([...serverRoles.SELECTABLE_ROLES]);
    for (const role of ROLES) {
      expect(canSeeTeam(role)).toBe(serverRoles.can(role, "team.read"));
      expect(canManageTeam(role)).toBe(serverRoles.can(role, "team.manage"));
    }
    expect(canSeeTeam(undefined)).toBe(false);
  });

  test("the server keeps team:read for admins only and narrows stored key scopes by role", () => {
    expect(serverRoles.mcpScopesForRole("admin")).toContain("team:read");
    for (const role of ["member", "viewer", "guest"] as const) expect(serverRoles.mcpScopesForRole(role)).not.toContain("team:read");
    expect(serverRoles.effectiveMcpScopes(["notes:read", "team:read"], "member")).toEqual(["notes:read"]);
    expect(serverRoles.effectiveMcpScopes(["notes:read", "team:read"], "admin")).toEqual(["notes:read", "team:read"]);
  });
});

describe("Team formatting", () => {
  const ada = member({ displayName: "Ada Lovelace", email: "ada@example.test", role: "admin" });
  const bob = member({ displayName: "Bob", role: "member", status: "blocked", blockedAt: "2026-02-01T00:00:00.000Z", blockedBy: { id: "x", displayName: "Ada" } });
  const old = member({ displayName: "Old", status: "blocked", blockedAt: "2026-01-02T00:00:00.000Z", blockedBy: null });

  test("filters by chip and searches names and emails", () => {
    const all = [ada, bob, old];
    expect(filterTeam(all, "admin", "")).toEqual([ada]);
    expect(filterTeam(all, "blocked", "")).toEqual([bob, old]);
    expect(filterTeam(all, "all", "EXAMPLE")).toEqual([ada]);
    expect(filterTeam(all, "all", " bo ")).toEqual([bob]);
    expect(teamFilters(all, true).map((chip) => [chip.value, chip.count])).toEqual([["all", 3], ["admin", 1], ["member", 2], ["blocked", 2]]);
    // Viewers and Guests appear once someone holds the role; Blocked shows to admins or when present.
    expect(teamFilters([ada], false).map((chip) => chip.value)).toEqual(["all", "admin", "member"]);
    expect(teamFilters([ada, member({ role: "guest" })], true).map((chip) => chip.value)).toEqual(["all", "admin", "member", "guest", "blocked"]);
  });

  test("status, New tags, and the last-admin guard", () => {
    expect(statusLabel(ada)).toBe("Active");
    expect(statusLabel(bob)).toBe("Blocked");
    expect(statusLabel(old)).toBe("Blocked (before Team)");
    const now = Date.parse("2026-03-01T00:00:00.000Z");
    expect(isNewAccount(new Date(now - NEW_ACCOUNT_MS + 1000).toISOString(), now)).toBe(true);
    expect(isNewAccount(new Date(now - NEW_ACCOUNT_MS - 1000).toISOString(), now)).toBe(false);
    expect(lastAdminReason(ada, [ada, bob])).toContain("at least one admin");
    expect(lastAdminReason(ada, [ada, member({ role: "admin" })])).toBeNull();
    expect(lastAdminReason(ada, [ada, member({ role: "admin", status: "blocked" })])).toContain("at least one admin");
    expect(lastAdminReason(bob, [bob])).toBeNull();
  });

  test("activity lines name the actor and the path", () => {
    const base: TeamEvent = { id: "e", action: "role_change", via: "web", fromRole: "member", toRole: "admin", reason: null, createdAt: "2026-01-01T00:00:00.000Z", actor: { id: "a", displayName: "Ada" } };
    expect(eventLabel(base)).toBe("Team role changed from Member to Admin by Ada");
    expect(eventLabel({ ...base, via: "cli", actor: null })).toBe("Team role changed from Member to Admin from the host command line");
    expect(eventLabel({ ...base, actor: null })).toBe("Team role changed from Member to Admin by a former account");
    expect(eventLabel({ ...base, action: "block" })).toBe("Blocked by Ada");
    expect(eventLabel({ ...base, action: "sessions_revoked" })).toBe("Signed out everywhere by Ada");
    expect(eventLabel({ ...base, action: "bootstrap_admin", via: "migration", actor: null })).toContain("oldest account");
    expect(eventLabel({ ...base, action: "bootstrap_admin", via: "bootstrap", actor: null })).toBe("Became admin as the first account");
  });

  test("Back steps through pushed entries, then detail to list, then Home", () => {
    expect(teamBackAction("u1", 2)).toEqual({ kind: "history" });
    expect(teamBackAction("u1", 0)).toEqual({ kind: "list" });
    expect(teamBackAction(null, 0)).toEqual({ kind: "home" });
  });
});

describe("Team role picker (shared Select, D91)", () => {
  test("offers every role with its description, and all four are selectable (Wave 15)", () => {
    const options = roleOptions();
    expect(options.map((option) => option.value)).toEqual([...ROLES]);
    expect(options.filter((option) => !option.disabled).map((option) => option.value)).toEqual([...SELECTABLE_ROLES]);
    expect([...SELECTABLE_ROLES]).toEqual([...ROLES]);
    expect(options[0]!.description).toBe(ROLE_DESCRIPTIONS.admin);
    expect(options.find((option) => option.value === "viewer")!.description).toBe(ROLE_DESCRIPTIONS.viewer);
    expect(options.find((option) => option.value === "guest")!.description).toContain("shared with them by name");
  });

  test("renders the shared listbox with every role enabled, never a native select", () => {
    const closed = renderToStaticMarkup(<Select label="Team role" value="member" options={roleOptions()} onChange={() => undefined} />);
    expect(closed).not.toContain("<select");
    expect(closed).toContain('aria-haspopup="listbox"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("Member");
    const open = renderToStaticMarkup(<Select label="Team role" value="member" options={roleOptions()} onChange={() => undefined} presentation="popup" defaultOpen />);
    expect(open).toContain('role="listbox"');
    expect(open).toContain(ROLE_DESCRIPTIONS.member);
    expect(open).toContain(ROLE_DESCRIPTIONS.guest);
    expect(open).not.toContain('aria-disabled="true"');
  });
});

describe("Team chrome", () => {
  const account = { displayName: "Ada", onSettings: () => undefined, onSignOut: () => undefined };
  const withNav = (nav: TeamNav | null) => renderToStaticMarkup(<TeamNavContext.Provider value={nav}><AccountActions {...account} onBin={() => undefined} /></TeamNavContext.Provider>);

  test("the account row shows Team after Bin for everyone but guests, and not on Team itself", () => {
    const markup = withNav({ role: "member", openTeam: () => undefined, onTeam: false });
    const titles = [...markup.matchAll(/title="([^"]+)"/g)].map((match) => match[1]);
    // Wave 37: Bin · Team · Settings · … · Sign out, the rightmost action.
    expect(titles).toEqual(["Bin", "Team", "Settings", "Sign out"]);
    expect(withNav({ role: "admin", openTeam: () => undefined, onTeam: false })).toContain('title="Team"');
    expect(withNav({ role: "guest", openTeam: () => undefined, onTeam: false })).not.toContain('title="Team"');
    expect(withNav({ role: "admin", openTeam: () => undefined, onTeam: true })).not.toContain('title="Team"');
    expect(withNav(null)).not.toContain('title="Team"');
  });

  test("Team → Members in the Settings hub renders its list shell, and tells guests it is unavailable", () => {
    const props = { route: { app: "team" as const, userId: null }, totpEnabled: false, navigate: () => undefined, flash: () => undefined, onLeave: () => undefined, guardLeave: (leave: () => void) => leave(), onKeyPendingChange: () => undefined };
    const markup = renderToStaticMarkup(<TeamSection {...props} role="admin" />);
    expect(markup).toContain('class="team-app team-layout split-layout"');
    expect(markup).toContain("Search names or emails");
    expect(markup).not.toContain("<select");
    // The admin sections are the hub's nav entries now, not rows above the list.
    expect(markup).not.toContain("team-invites-row");
    expect(renderToStaticMarkup(<TeamSection {...props} role="member" />)).toContain("Search names");
    expect(renderToStaticMarkup(<TeamSection {...props} role="guest" />)).toContain("Team is not available for your account");
  });
});
