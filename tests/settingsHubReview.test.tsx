import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRoute, parseRoute, type Route } from "../src/router";
import { firstTeamRoute, HUB_PUSHED_OVER_KEY, hubBackAction, hubEntries, hubListGoesUnder, isHubRoute, settingsRoute, teamGroupShown } from "../src/settings/hubModel";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { takeGoogleSettingsResult } from "../src/auth/googleSignIn";

/**
 * Wave 37 review probes: alias edge cases, the phone back arrow for Settings opened from the Team
 * button or a deep link, role gating of the nav, and the leave guard's reach over the header.
 */
const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const userId = "0b7c1e2a-5d4f-4a1b-9c3d-2e1f0a9b8c7d";
const groupId = "1c8d2f3b-6e5a-4b2c-8d4e-3f2a1b0c9d8e";

describe("aliases and deep links (review)", () => {
  test("trailing slashes and uppercase ids rewrite to one canonical URL; a second rewrite is a no-op (no loop)", () => {
    const cases: Array<[string, string]> = [
      ["/team/", "/settings/team/members"],
      ["/settings/team/", "/settings/team/members"],
      ["/settings/keys/", "/settings/keys"],
      ["/settings/mcp/", "/settings/keys"],
      [`/team/${userId.toUpperCase()}/access/`, `/settings/team/members/${userId}/access`],
      [`/settings/team/groups/${groupId.toUpperCase()}/`, `/settings/team/groups/${groupId}`],
      ["/settings/whatever", "/settings"],
      ["/settings/team/whatever", "/settings/team/members"],
      // The old scheme had no "members" segment: /team/members opens the list, not a member.
      ["/team/members", "/settings/team/members"]
    ];
    for (const [from, to] of cases) {
      const once = formatRoute(parseRoute(from));
      expect(once).toBe(to);
      expect(formatRoute(parseRoute(once))).toBe(once);
    }
  });

  test("every Team route formats under /settings/team, and every hub URL parses back to a hub route", () => {
    const routes: Route[] = [firstTeamRoute(), { app: "team", userId }, { app: "team", userId, access: true }, { app: "team", userId: null, invites: true }, { app: "team", userId: null, email: true }];
    for (const route of routes) {
      expect(formatRoute(route).startsWith("/settings/team/")).toBe(true);
      expect(isHubRoute(parseRoute(formatRoute(route)))).toBe(true);
    }
  });

  test("a Google return to an integration page is taken by the Team reader, never by Settings'", () => {
    const history = { state: null, replaceState: () => undefined };
    const location = { pathname: `/settings/team/integrations/${groupId}`, search: "", hash: "#google=reauthed" };
    expect(takeGoogleSettingsResult(location, history)).toBeNull();
    expect(takeGoogleSettingsResult(location, history, "/team/")).toEqual({ kind: "reauthed" });
  });
});

describe("nav per role (review)", () => {
  test("an unknown role (session without a role) never gets Team entries beyond Members, and never admin ones", () => {
    const ids = hubEntries(undefined, { teamModuleEnabled: true }).map((entry) => entry.id);
    expect(ids.filter((id) => id.startsWith("team-") && id !== "team-members")).toEqual([]);
    expect(teamGroupShown(undefined, false)).toBe(false);
  });

  test("members and viewers never get an admin-only Team entry, whatever the module state", () => {
    for (const role of ["member", "viewer", "guest"] as const) {
      for (const teamModuleEnabled of [true, false]) {
        const ids = hubEntries(role, { teamModuleEnabled }).map((entry) => entry.id);
        expect(ids.filter((id) => id.startsWith("team-") && id !== "team-members")).toEqual([]);
      }
    }
  });
});

describe("the phone back arrow (review)", () => {
  const pushed = (below: string, belowDepth: number) => withHistoryDepth({ [HUB_PUSHED_OVER_KEY]: below }, belowDepth + 1);

  test("Team button from Home: on a phone the list goes under Members (review L4), so the arrow is Back; an entry pushed straight over / still replaces", () => {
    expect(formatRoute(firstTeamRoute())).toBe("/settings/team/members");
    expect(hubListGoesUnder(firstTeamRoute(), parseRoute("/"), true)).toBe(true);
    expect(hubBackAction(pushed("/settings", 1))).toBe("history");
    // A computer has no list screen: Members goes straight over Home, and no arrow is shown there.
    expect(hubListGoesUnder(firstTeamRoute(), parseRoute("/"), false)).toBe(false);
    expect(hubBackAction(pushed("/", 0))).toBe("list");
  });

  test("a section pushed over the list is plain Back; over a query-carrying list URL it is not", () => {
    expect(hubBackAction(pushed("/settings", 1))).toBe("history");
    expect(hubBackAction(pushed("/settings?x=1", 1))).toBe("list");
    // Depth 0 (a deep link the page loaded on, or a replaced entry) is always the list.
    expect(hubBackAction({ [HUB_PUSHED_OVER_KEY]: "/settings" })).toBe("list");
    expect(readHistoryDepth(null)).toBe(0);
  });

  test("the phone opens Settings on the list, a computer on Security", () => {
    const app = read("App.tsx");
    expect(app).toContain('if (section === "settings") return settingsRoute(isMobileViewport() ? null : "security");');
    expect(formatRoute(settingsRoute(null))).toBe("/settings");
  });
});

describe("the leave guard's reach (review)", () => {
  test("the hub guards Home, Bin, Sign out, and (fixed, review M1) Inbox and the bell through hub-scoped contexts", () => {
    const app = read("App.tsx");
    expect(app).toContain("<AccountActions displayName={session.user.displayName} onSignOut={() => guardLeave(onSignOut)} onBin={onBin ? () => guardLeave(onBin) : undefined} binCount={binCount} />");
    // The app-wide contexts stay as they were; inside the hub they are replaced by guarded ones.
    expect(app).toContain('const inboxNav = { role: session.user.role, openInbox: () => { void openApp("inbox"); }, onInbox: shownApp === "inbox" };');
    expect(app).toContain("const hubInboxNav = useMemo(() => inboxNav && { ...inboxNav, openInbox: () => guardLeave(inboxNav.openInbox) }, [guardLeave, inboxNav]);");
    expect(app).toContain("openList: () => guardLeave(notificationsNav.openList), openPath: (path: string) => guardLeave(() => notificationsNav.openPath(path))");
    expect(app).toContain("<InboxNavContext.Provider value={hubInboxNav}><NotificationsContext.Provider value={hubNotificationsNav}>");
    // The Inbox button and the bell read those contexts, so the hub's header gets the guarded ones.
    expect(read("AppShell.tsx")).toContain("onClick={nav.openInbox}");
    expect(read("notifications/NotificationBell.tsx")).toContain("const context = useNotificationsContext();");
  });
});
