import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute, type Route } from "../src/router";
import { firstTeamRoute, HUB_PUSHED_OVER_KEY, hubBackAction, hubEntries, hubEntryLabel, hubEntryOf, hubListGoesUnder, hubPopRoute, isHubRoute, isNestedHubRoute, leaveGuardAction, settingsRoute, teamGroupShown } from "../src/settings/hubModel";
import { SettingsHubShell } from "../src/settings/SettingsHub";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { unsavedKeyConfirm } from "../src/keys/unsavedKeyConfirm";

/**
 * Wave 37: Settings is a page (the hub), with Team inside it. Its routes and their old aliases, the
 * nav per role, the phone flow's history (list → section → Back → list → Back → where Settings was
 * opened; Forward), and the leave guard. The real-browser run of the same flows (1280 × 800 and
 * 390 × 844) is the Wave 37 smoke recorded in DEVELOPMENT_PLAN.md.
 */
const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const userId = "0b7c1e2a-5d4f-4a1b-9c3d-2e1f0a9b8c7d";
const groupId = "1c8d2f3b-6e5a-4b2c-8d4e-3f2a1b0c9d8e";
const integrationId = "2d9e3a4c-7f6b-4c3d-9e5f-4a3b2c1d0e9f";

describe("route scheme", () => {
  test("the Settings page: /settings is the list, /settings/:section an account section", () => {
    expect(parseRoute("/settings")).toEqual({ app: "settings", section: null });
    expect(parseRoute("/settings/")).toEqual({ app: "settings", section: null });
    expect(formatRoute({ app: "settings", section: null })).toBe("/settings");
    for (const [path, section] of [["/settings/security", "security"], ["/settings/notifications", "notifications"], ["/settings/access", "access"], ["/settings/keys", "mcp"], ["/settings/modules", "modules"], ["/settings/about", "about"]] as const) {
      expect(parseRoute(path)).toEqual({ app: "settings", section });
      expect(formatRoute(parseRoute(path))).toBe(path);
    }
    // Unknown sections (and object keys) open the list; /settingsx is not Settings at all.
    for (const path of ["/settings/nope", "/settings/constructor", "/settings/toString", "/settings/security/extra"]) expect(parseRoute(path)).toEqual({ app: "settings", section: null });
    expect(parseRoute("/settingsx")).toEqual({ app: "home" });
  });

  test("every Team screen has one canonical URL under /settings/team", () => {
    const canonical: Array<[string, Route]> = [
      ["/settings/team/members", { app: "team", userId: null }],
      [`/settings/team/members/${userId}`, { app: "team", userId }],
      [`/settings/team/members/${userId}/access`, { app: "team", userId, access: true }],
      ["/settings/team/invites", { app: "team", userId: null, invites: true }],
      ["/settings/team/groups", { app: "team", userId: null, groups: true }],
      [`/settings/team/groups/${groupId}`, { app: "team", userId: null, groups: true, groupId }],
      ["/settings/team/integrations", { app: "team", userId: null, integrations: true }],
      [`/settings/team/integrations/${integrationId}`, { app: "team", userId: null, integrations: true, integrationId }],
      ["/settings/team/keys", { app: "team", userId: null, keys: true }],
      ["/settings/team/policies", { app: "team", userId: null, policies: true }],
      ["/settings/team/templates", { app: "team", userId: null, templates: true }],
      ["/settings/team/activity", { app: "team", userId: null, activity: true }],
      ["/settings/team/email", { app: "team", userId: null, email: true }]
    ];
    for (const [path, route] of canonical) {
      expect(parseRoute(path)).toEqual(route);
      expect(formatRoute(route)).toBe(path);
    }
    // /settings/team is Members; uppercase ids are lowered; anything malformed opens Members.
    expect(formatRoute(parseRoute("/settings/team"))).toBe("/settings/team/members");
    expect(parseRoute(`/settings/team/members/${userId.toUpperCase()}`)).toEqual({ app: "team", userId });
    for (const path of ["/settings/team/members/garbage", `/settings/team/members/${userId}/extra`, "/settings/team/nope", `/settings/team/${userId}`]) expect(parseRoute(path)).toEqual({ app: "team", userId: null });
  });

  test("aliases: every old /team URL opens the same screen, and formats to the canonical one", () => {
    const aliases: Array<[string, string]> = [
      ["/team", "/settings/team/members"],
      [`/team/${userId}`, `/settings/team/members/${userId}`],
      [`/team/${userId}/access`, `/settings/team/members/${userId}/access`],
      ["/team/invites", "/settings/team/invites"],
      ["/team/email", "/settings/team/email"],
      ["/team/keys", "/settings/team/keys"],
      ["/team/policies", "/settings/team/policies"],
      ["/team/groups", "/settings/team/groups"],
      [`/team/groups/${groupId}`, `/settings/team/groups/${groupId}`],
      ["/team/integrations", "/settings/team/integrations"],
      [`/team/integrations/${integrationId}`, `/settings/team/integrations/${integrationId}`],
      ["/team/templates", "/settings/team/templates"],
      ["/team/activity", "/settings/team/activity"],
      ["/settings/mcp", "/settings/keys"]
    ];
    for (const [old, canonical] of aliases) {
      // Old → new: the app rewrites the entry in place to formatRoute's URL.
      expect(formatRoute(parseRoute(old))).toBe(canonical);
      // New → old: both name the same screen.
      expect(parseRoute(canonical)).toEqual(parseRoute(old));
    }
    // Every non-Notes route is rewritten in place (startup and popstate), so an alias never stays in history.
    const app = read("App.tsx");
    expect(app).toContain("if (formatRoute(route) !== locationUrl(window.location)) navigate(route, { replace: true });");
  });

  test("links the server sends and the Google round trips still land (mail /team/:id, /settings/:section#google=…)", () => {
    const links = readFileSync(join(import.meta.dir, "..", "server", "mail", "links.ts"), "utf8");
    expect(links).toContain("team: (userId: string) => `/team/${id(userId)}`");
    expect(formatRoute(parseRoute(`/team/${userId}`))).toBe(`/settings/team/members/${userId}`);
    // An admin's Google confirmation returns to the member's canonical page; an old /team/:id one still reads.
    expect(read("team/TeamGoogle.tsx")).toContain("returnTo={`/settings/team/members/${userId}`}");
    const google = read("auth/googleSignIn.tsx");
    expect(google).toContain('pathname.startsWith("/team/") || pathname.startsWith("/settings/team/")');
    expect(google).toContain("initialTeamPath.startsWith(`/settings/team/members/${userId}`)");
    // The app reads both results before its first route rewrite strips the fragment.
    const app = read("App.tsx");
    expect(app).toContain("const [googleSettings] = useState(initialGoogleSettingsResult);\n  // An admin's Google confirmation that came back to Team → member: read before the URL is rewritten.\n  useState(initialGoogleTeamResult);");
  });

  test("takeGoogleSettingsResult keeps Settings' and Team's results apart under /settings", async () => {
    const { takeGoogleSettingsResult } = await import("../src/auth/googleSignIn");
    const history = { state: null, replaceState: () => undefined };
    expect(takeGoogleSettingsResult({ pathname: "/settings/security", search: "", hash: "#google=linked" }, history)).toEqual({ kind: "linked" });
    expect(takeGoogleSettingsResult({ pathname: `/settings/team/members/${userId}`, search: "", hash: "#google=reauthed" }, history)).toBeNull();
    expect(takeGoogleSettingsResult({ pathname: `/settings/team/members/${userId}`, search: "", hash: "#google=reauthed" }, history, "/team/")).toEqual({ kind: "reauthed" });
    expect(takeGoogleSettingsResult({ pathname: `/team/${userId}`, search: "", hash: "#google=reauthed" }, history, "/team/")).toEqual({ kind: "reauthed" });
  });
});

describe("the nav per role", () => {
  const ids = (entries: ReturnType<typeof hubEntries>) => entries.map((entry) => entry.id);

  test("admins: every account section, then every Team section", () => {
    expect(ids(hubEntries("admin", { teamModuleEnabled: true }))).toEqual([
      "security", "notifications", "access", "mcp", "modules", "about",
      "team-members", "team-invites", "team-groups", "team-integrations", "team-keys", "team-policies", "team-templates", "team-activity", "team-email"
    ]);
    // Team turned off in Modules: admins keep Team here (Team plan §6.2).
    expect(ids(hubEntries("admin", { teamModuleEnabled: false }))).toContain("team-invites");
  });

  test("members and viewers see Team → Members only, while Team is on; guests never", () => {
    for (const role of ["member", "viewer"] as const) {
      expect(ids(hubEntries(role, { teamModuleEnabled: true }))).toEqual(["security", "notifications", "access", "mcp", "modules", "about", "team-members"]);
      expect(ids(hubEntries(role, { teamModuleEnabled: false }))).not.toContain("team-members");
    }
    expect(ids(hubEntries("guest", { teamModuleEnabled: true }))).toEqual(["security", "notifications", "mcp", "modules", "about"]);
    expect(teamGroupShown("guest", true)).toBe(false);
  });

  test("while two-factor setup is required, Security is the only entry", () => {
    expect(ids(hubEntries("admin", { teamModuleEnabled: true, setupRequired: true }))).toEqual(["security"]);
  });

  test("the Team button opens the first Team entry every Team role has: Members", () => {
    expect(formatRoute(firstTeamRoute())).toBe("/settings/team/members");
    for (const role of ["admin", "member", "viewer"] as const) expect(hubEntries(role, { teamModuleEnabled: true }).find((entry) => entry.group === "team")?.id).toBe("team-members");
  });

  test("a route selects its entry; pages below a section select the section", () => {
    expect(hubEntryOf(settingsRoute("mcp"))).toBe("mcp");
    expect(hubEntryOf(settingsRoute(null))).toBeNull();
    expect(hubEntryOf(parseRoute(`/settings/team/members/${userId}/access`))).toBe("team-members");
    expect(hubEntryOf(parseRoute(`/settings/team/groups/${groupId}`))).toBe("team-groups");
    expect(hubEntryOf(parseRoute("/notes"))).toBeNull();
    expect(hubEntryLabel("team-activity")).toBe("Access activity");
    expect(hubEntryLabel("mcp")).toBe("API keys");
    expect(isNestedHubRoute(parseRoute(`/settings/team/members/${userId}`))).toBe(true);
    expect(isNestedHubRoute(parseRoute(`/settings/team/integrations/${integrationId}`))).toBe(true);
    expect(isNestedHubRoute(parseRoute("/settings/team/integrations"))).toBe(false);
    expect(isNestedHubRoute(parseRoute("/settings/keys"))).toBe(false);
    expect(isHubRoute(parseRoute("/team"))).toBe(true);
    expect(isHubRoute(parseRoute("/bin"))).toBe(false);
  });
});

describe("the page", () => {
  const entries = hubEntries("admin", { teamModuleEnabled: true });
  const shell = (listScreen: boolean, showBack = true) => renderToStaticMarkup(<SettingsHubShell displayName="Ada" role="admin" entries={entries} selected="security" listScreen={listScreen} title="Security" showBack={showBack} onBack={() => undefined} onSelect={() => undefined} onHome={() => undefined} account={<div className="app-account" />}>
    <section className="settings-content">Content</section>
  </SettingsHubShell>);

  test("a page with a header, a grouped nav, and the section with the account identity and its title; no dialog", () => {
    const markup = shell(false);
    expect(markup).toContain('<main class="app-page settings-hub">');
    expect(markup).toContain('<header class="app-page-header">');
    expect(markup).toContain('aria-label="Settings sections"');
    expect(markup).toContain('<h2 id="settings-hub-group-account">Account</h2>');
    expect(markup).toContain('<h2 id="settings-hub-group-team">Team</h2>');
    expect(markup).toContain('<span class="eyebrow">Ada · Admin</span><h1 id="settings-hub-title" tabindex="-1">Security</h1>');
    expect(markup).toContain('aria-label="Back to Settings"');
    expect(markup).not.toContain("aria-modal");
    expect(markup).not.toContain('role="dialog"');
    // The phone's list screen is the same page with the list class (CSS shows the nav only).
    expect(shell(true)).toContain('<main class="app-page settings-hub settings-hub-list">');
    // A page below a section brings its own back link: the hub's arrow is left out.
    expect(shell(false, false)).not.toContain("settings-hub-back");
  });

  test("the modal is gone: no fixed dialog, no scrim, no Manage team link", () => {
    const app = read("App.tsx");
    expect(app).not.toContain("SettingsDialog");
    expect(app).not.toContain('aria-controls="account-settings-dialog"');
    expect(app).not.toContain("onManageTeam");
    expect(app).not.toContain("settingsOpen");
    expect(read("styles.css")).not.toContain(".settings-dialog");
    expect(read("AppShell.tsx")).not.toContain('aria-haspopup="dialog"');
    // Every "Settings" (header, sidebar footers, module hint) opens the page route.
    expect(app).toContain("void openRoute(settingsRoute(section ?? (isMobileViewport() ? null : \"security\")));");
    expect(app).toContain('openSettings("modules");');
  });
});

describe("history at 390 px", () => {
  /** A browser history: entries with state and URL; pushState, replaceState, back, forward. */
  function browser(start: string) {
    const entries: Array<{ url: string; state: Record<string, unknown> | null }> = [{ url: start, state: null }];
    let index = 0;
    return {
      get url() { return entries[index]!.url; },
      get state() { return entries[index]!.state; },
      /** What App's navigate pushes: the depth one deeper, and the URL it was pushed over. */
      push(route: Route) {
        const below = entries[index]!;
        entries.splice(index + 1);
        entries.push({ url: formatRoute(route), state: withHistoryDepth({ [HUB_PUSHED_OVER_KEY]: below.url }, readHistoryDepth(below.state) + 1) });
        index += 1;
      },
      replace(route: Route) { entries[index] = { url: formatRoute(route), state: entries[index]!.state }; },
      back() { index = Math.max(0, index - 1); },
      forward() { index = Math.min(entries.length - 1, index + 1); },
      get length() { return entries.length; }
    };
  }
  /** What the hub shows for a URL on a phone: the list, or a section by its nav entry. */
  const screen = (url: string) => {
    const route = parseRoute(url);
    if (!isHubRoute(route)) return `app:${route.app}`;
    return route.app === "settings" && route.section === null ? "list" : hubEntryOf(route);
  };

  test("Home → Settings (the list) → a section → Back → the list → Back → Home; Forward reopens both", () => {
    const history = browser("/");
    // A phone's Settings button opens the list; tapping an entry pushes the section.
    history.push(settingsRoute(null));
    expect(screen(history.url)).toBe("list");
    history.push(settingsRoute("notifications"));
    expect(screen(history.url)).toBe("notifications");
    history.back();
    expect(screen(history.url)).toBe("list");
    history.back();
    expect(screen(history.url)).toBe("app:home");
    history.forward();
    expect(screen(history.url)).toBe("list");
    history.forward();
    expect(screen(history.url)).toBe("notifications");
  });

  test("phones: a section opened from outside the hub gets the list under it, so Back and the arrow agree (review L4, QA Q1)", () => {
    const history = browser("/");
    // The Team button on Home: App's navigate pushes the list, then Members.
    const target = firstTeamRoute();
    expect(hubListGoesUnder(target, parseRoute(history.url), true)).toBe(true);
    history.push(settingsRoute(null));
    history.push(target);
    expect(history.length).toBe(3);
    // The arrow is exactly browser Back: the list, then Home; Forward reopens Members.
    expect(hubBackAction(history.state)).toBe("history");
    history.back();
    expect(screen(history.url)).toBe("list");
    history.back();
    expect(screen(history.url)).toBe("app:home");
    history.forward();
    history.forward();
    expect(screen(history.url)).toBe("team-members");
    // Within the hub, on a computer, or to the list itself: nothing extra.
    expect(hubListGoesUnder(settingsRoute("security"), settingsRoute(null), true)).toBe(false);
    expect(hubListGoesUnder(settingsRoute("security"), firstTeamRoute(), true)).toBe(false);
    expect(hubListGoesUnder(settingsRoute("security"), parseRoute("/"), false)).toBe(false);
    expect(hubListGoesUnder(settingsRoute(null), parseRoute("/"), true)).toBe(false);
    const app = read("App.tsx");
    expect(app).toContain('if (!options.replace && hubListGoesUnder(route, routeFromLocation(window.location), isMobileViewport())) writeHistory(session.user.id, settingsRoute(null), options.panel ?? mobilePanel, "push");');
  });

  test("a Settings deep link gets Home underneath (review L5, as Wave 28 did); phones also the list", () => {
    const app = read("App.tsx");
    expect(app).toContain("if (isHubRoute(target) && readHistoryDepth(window.history.state) === 0) {");
    expect(app).toContain('writeHistory(userId, { app: "home" }, panel, "replace");\n          if (hubListGoesUnder(target, { app: "home" }, isMobileViewport())) writeHistory(userId, settingsRoute(null), panel, "push");\n          writeHistory(userId, target, panel, "push");');
    // The model: a phone lands on /settings/team/policies; Back walks the list, then Home, never off Nook.
    const history = browser("/settings/team/policies");
    history.replace({ app: "home" });
    history.push(settingsRoute(null));
    history.push({ app: "team", userId: null, policies: true });
    expect(hubBackAction(history.state)).toBe("history");
    history.back();
    expect(screen(history.url)).toBe("list");
    history.back();
    expect(screen(history.url)).toBe("app:home");
    // A hub screen replaced in place keeps the URL it was pushed over, so the arrow still steps back.
    expect(app).toContain('const below = isHubRoute(route) && current && typeof current === "object" ? current as Record<string, unknown> : null;');
  });

  test("review M2: Members → Back → Team turned off → Forward keeps the section the URL names", () => {
    // A member on /settings/modules opened Members, went Back, and turned Team off. Forward pops
    // /settings/team/members: the hub leaves it alone, the route gate undoes the move (D92), and once
    // that undo settled the hub reads the URL again: /settings/modules.
    const members = parseRoute("/settings/team/members");
    expect(hubPopRoute(members, teamGroupShown("member", false))).toBeNull();
    expect(hubPopRoute(parseRoute("/settings/modules"), teamGroupShown("member", false))).toEqual(settingsRoute("modules"));
    // Admins keep Team with the module off; a non-hub URL never changes the hub's screen.
    expect(hubPopRoute(members, teamGroupShown("admin", false))).toEqual(members);
    expect(hubPopRoute(parseRoute("/notes"), true)).toBeNull();
    // The hub listener does exactly that (re-reads after the gate's undo, via whenHistorySettled).
    const app = read("App.tsx");
    expect(app).toContain("teamShownRef.current = teamGroupShown(session.user.role, teamModuleEnabled);");
    expect(app).toContain("if (next) setLocationRoute((current) => formatRoute(current) === formatRoute(next) ? current : next);");
  });

  test("the section's back arrow is Back when the list is below it, else the list replaces the section", () => {
    const history = browser("/");
    history.push(settingsRoute(null));
    history.push(settingsRoute("security"));
    expect(hubBackAction(history.state)).toBe("history");
    // A deep link (depth 0) or a section opened from elsewhere: the list replaces it, no extra entry.
    const deep = browser("/settings/security");
    expect(hubBackAction(deep.state)).toBe("list");
    const fromHome = browser("/");
    fromHome.push(settingsRoute("modules"));
    expect(hubBackAction(fromHome.state)).toBe("list");
    // The page's arrow follows that rule; the history key is App's.
    const app = read("App.tsx");
    expect(app).toContain(`export const PUSHED_OVER_KEY = "${HUB_PUSHED_OVER_KEY}";`);
    expect(app).toContain('if (hubBackAction(window.history.state) === "history") window.history.back();');
  });

  test("Team inside the hub: list → Members → a member → Back → Members → Back → list", () => {
    const history = browser("/");
    history.push(settingsRoute(null));
    history.push(firstTeamRoute());
    history.push({ app: "team", userId });
    expect(history.url).toBe(`/settings/team/members/${userId}`);
    expect(isNestedHubRoute(parseRoute(history.url))).toBe(true);
    history.back();
    expect(screen(history.url)).toBe("team-members");
    history.back();
    expect(screen(history.url)).toBe("list");
    // Phones: the list screen hides the section, a section hides the list (CSS), and a member hides Members.
    const css = read("settings/settingsHub.css");
    expect(css).toContain(".settings-hub-list .settings-hub-main { display: none; }");
    expect(css).toContain(".settings-hub:not(.settings-hub-list) .settings-hub-nav { display: none; }");
    expect(read("team/team.css")).toContain(".team-app.team-detail-open .team-list-pane { display: none; }");
  });

  test("the hub follows Back and Forward itself (a dialog open at the time only closes)", () => {
    const app = read("App.tsx");
    // Review M2: a move that was undone (a dialog's, a leave guard's, or the route gate's) is read again once it settled.
    expect(app).toContain("if (popStateClosedDialog(event)) { cancel = whenHistorySettled(follow); return; }");
    expect(app).toContain("const next = hubPopRoute(routeFromLocation(window.location), teamShownRef.current);");
    // Account and Team routes render the same page element, so moving between them never remounts it.
    expect(app).toContain(': shownApp === "settings" || shownApp === "team" ? settingsPage(false)');
    expect(app).toContain('key="settings-hub"');
  });
});

describe("the leave guard (a key shown only once)", () => {
  test("switching section, the back arrow, Home, Bin, sign-out, and Back/Forward all ask first", () => {
    const app = read("App.tsx");
    expect(app).toContain('guardLeave(() => go(entry.route), "section");');
    expect(app).toContain('onBack={() => guardLeave(backToList, "section")}');
    expect(app).toContain("onHome={onHome ? () => guardLeave(onHome) : undefined}");
    expect(app).toContain("onSignOut={() => guardLeave(onSignOut)} onBin={onBin ? () => guardLeave(onBin) : undefined}");
    expect(app).toContain("useLeaveGuard(pending && !confirmOpen, (direction) => {");
    // Both keys hold the page: Settings → API keys and a Team integration's new key.
    expect(app).toContain("<KeysSettings notice={googleNoticeLine} onPendingChange={onMcpKeyPending}");
    expect(app).toContain("onKeyPendingChange={onIntegrationKeyPending}");
    // The confirmed move runs once the guard let go (after its sentinel is popped).
    expect(app).toContain('whenHistorySettled(() => "direction" in next ? window.history.go(repeatDelta(next.direction)) : next.leave())');
    expect(unsavedKeyConfirm("section")).toMatchObject({ title: "Leave without saving the key?", confirmLabel: "Leave section" });
    expect(unsavedKeyConfirm("integration").message).toContain("Leave this integration");
  });

  test("review L2: Back or Forward out of Settings says Leave Settings; to another section, Leave section", () => {
    const here = settingsRoute("mcp");
    expect(leaveGuardAction(settingsRoute("security"), here)).toBe("section");
    expect(leaveGuardAction(firstTeamRoute(), here)).toBe("section");
    expect(leaveGuardAction(parseRoute("/notes"), here)).toBe("leave");
    // Back off the landing entry's sentinel: the URL still reads the page's own, and the move leaves Nook.
    expect(leaveGuardAction(here, here)).toBe("leave");
    expect(read("App.tsx")).toContain("void ask(confirmFor(leaveGuardAction(routeFromLocation(window.location), routeRef.current))).then((confirmed) => {");
    expect(unsavedKeyConfirm("leave").message).toContain("Leave Settings without copying it?");
  });

  test("review L1: a section's own guard (Policies' unsaved changes) runs before every in-app move of the hub", () => {
    const app = read("App.tsx");
    expect(app).toContain("if (beforeLeaveRef.current?.(keyGuarded)) return;");
    expect(app).toContain("<HubBeforeLeaveContext.Provider value={registerBeforeLeave}>");
    // The phone arrow and the nav go through guardLeave, so they ask too.
    expect(app).toContain('onBack={() => guardLeave(backToList, "section")}');
    const policies = read("team/TeamPolicies.tsx");
    expect(policies).toContain("useBeforeHubLeave((leave) => {\n    if (!dirty) return false;\n    pendingLeaveRef.current = leave;\n    setLeaving(true);\n    return true;\n  });");
    // Discard runs the move asked about once the draft's history guards let go.
    expect(policies).toContain("const leave = pendingLeaveRef.current ?? onBack;");
    expect(policies).toContain("window.setTimeout(() => { whenHistorySettled(leave); }, 0);");
  });
});

describe("Wave 37 fixes (QA)", () => {
  test("L3: every hub screen is titled Settings · <Section> · Nook; pages below a section by their name", () => {
    for (const file of ["TeamApp", "TeamPolicies", "Templates", "AccessActivity", "TeamGroups", "TeamEmailLog", "TeamIntegrations", "TeamKeys", "IntegrationPage", "GroupPage", "MemberAccess"]) {
      const source = read(`team/${file}.tsx`);
      expect(source).not.toMatch(/· (Team|Groups|Integrations) · Nook/);
      expect(source).toContain("document.title = hubDocumentTitle(");
    }
  });

  test("Q3: inside the hub a Team section's own title is for assistive tech only (the hub header shows it)", () => {
    const css = read("settings/settingsHub.css");
    expect(css).toContain(".settings-team-content :is(#team-invites-title, #team-groups-title, #team-integrations-title, #team-keys-title, #team-policies-title, #team-templates-title, #team-activity-title, #team-email-title) {");
  });

  test("Q2: a member's page links back to Members", () => {
    expect(read("team/TeamApp.tsx")).toContain('<button type="button" className="team-back" onClick={onBack}><ChevronLeft />Members</button>');
  });

  test("Q4: after a move, focus goes to the section heading", () => {
    const hub = read("settings/SettingsHub.tsx");
    expect(hub).toContain("if (lost || (isMobileViewport() && !inSection)) headingRef.current?.focus({ preventScroll: true });");
    expect(read("App.tsx")).toContain("screenKey={formatRoute(route)}");
  });

  test("Q5: Turn on in Settings scrolls to the module's row, focuses its switch, and highlights it", () => {
    const app = read("App.tsx");
    expect(app).toContain('onClick={() => { setHighlightModule(moduleHint); setModuleHint(null); openSettings("modules"); }}');
    expect(app).toContain("<ModulesSettings {...modules} highlight={highlightModule} onHighlightDone={onHighlightDone} />");
    const modules = read("ModulesSettings.tsx");
    expect(modules).toContain('row.scrollIntoView({ block: "center" });');
    expect(modules).toContain('${highlighted === id ? " highlight" : ""}');
  });

  test("Q6: a guest's /settings/access opens Security; Q7: an admin-only Team URL says why it opened Members", () => {
    const app = read("App.tsx");
    expect(app).toContain('const guestAccess = route.app === "settings" && route.section === "access" && session.user.role === "guest";');
    expect(app).toContain('useEffect(() => { if (guestAccess) go(settingsRoute("security"), { replace: true }); }, [go, guestAccess]);');
    const team = read("team/TeamApp.tsx");
    expect(team).toContain('export const ADMINS_ONLY_HINT = "That section is for admins";');
    expect(team).toContain("flash(ADMINS_ONLY_HINT);\n    navigateRef.current({ app: \"team\", userId: null }, { replace: true });");
  });

  test("L6: a Google return to an integration's page shows its result there", () => {
    const page = read("team/IntegrationPage.tsx");
    expect(page).toContain("const result = googleIntegrationResultFor(integrationId);");
    expect(page).toContain("notice={returned && <GoogleReturnNotice notice={returned} onDismiss={() => setReturned(null)} />}");
    expect(read("auth/googleSignIn.tsx")).toContain("initialTeamPath.startsWith(`/settings/team/integrations/${integrationId}`)");
  });
});
