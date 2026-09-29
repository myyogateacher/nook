import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute, parseSettingsPath, settingsDocumentTitle } from "../src/router";
import { replacesInvitesRoute } from "../src/team/TeamApp";
import { activityLabel, resetSummary, viaLabel, type AccessSummary } from "../src/access/memberAccessApi";
import { keysReachLine } from "../src/access/accessApi";

/**
 * Central access management on the client (Wave 33): the new routes survive a reload, the admin
 * pages stay admin-only, the member access overview redacts and uses custom controls, and the
 * copy the confirm dialogs and activity lines use.
 */

const summary = (): AccessSummary => ({
  member: { id: "u1", displayName: "Ada", role: "member", status: "active", isYou: false },
  groups: [{ id: "g1", name: "Ops", grantCount: 2, memberCount: 3, addedAt: "2026-09-29T00:00:00.000Z", addedBy: null, selfAdded: false }],
  keys: [],
  feeds: { live: 0 },
  routines: { enabled: 0 },
  kinds: [
    { kind: "note", module: "notes", direct: 0, group: 0, audience: 4 },
    { kind: "folder", module: "notes", direct: 0, group: 0, audience: 0 },
    { kind: "document", module: "files", direct: 0, group: 0, audience: 0 },
    { kind: "board", module: "tasks", direct: 2, group: 1, audience: 0 },
    { kind: "task_view", module: "tasks", direct: 0, group: 0, audience: 0 },
    { kind: "collection", module: "collections", direct: 0, group: 0, audience: 0 },
    { kind: "calendar", module: "calendar", direct: 0, group: 0, audience: 1 }
  ],
  resetCounts: { directShares: 2, groups: 1, keys: 0, feeds: 0, routines: 0 },
  pageSize: 200
});

describe("central access on the client", () => {
  test("/team/:userId/access, /team/templates, /team/activity, and /settings/access are real URLs", () => {
    const userId = crypto.randomUUID();
    expect(parseRoute(`/team/${userId.toUpperCase()}/access`)).toEqual({ app: "team", userId, access: true });
    expect(formatRoute({ app: "team", userId, access: true })).toBe(`/team/${userId}/access`);
    expect(parseRoute(`/team/${userId}`)).toEqual({ app: "team", userId });
    expect(parseRoute("/team/not-an-id/access")).toEqual({ app: "team", userId: null });
    expect(parseRoute("/team/templates")).toEqual({ app: "team", userId: null, templates: true });
    expect(formatRoute({ app: "team", userId: null, templates: true })).toBe("/team/templates");
    expect(parseRoute("/team/activity")).toEqual({ app: "team", userId: null, activity: true });
    expect(formatRoute({ app: "team", userId: null, activity: true })).toBe("/team/activity");
    expect(parseSettingsPath("/settings/access")).toBe("access");
    expect(settingsDocumentTitle("access")).toBe("Settings · My access · Nook");
  });

  test("only admins stay on the member access page, Templates, and Access activity", () => {
    for (const role of ["member", "viewer", "guest"] as const) {
      expect(replacesInvitesRoute({ userId: "u1", invites: false, access: true }, role)).toBe(true);
      expect(replacesInvitesRoute({ userId: null, invites: false, templates: true }, role)).toBe(true);
      expect(replacesInvitesRoute({ userId: null, invites: false, activity: true }, role)).toBe(true);
    }
    expect(replacesInvitesRoute({ userId: "u1", invites: false, access: true }, "admin")).toBe(false);
  });

  test("labels: via, reset counts, activity lines with hidden titles, and the Access sheet's key line", () => {
    expect(viaLabel({ level: "edit", via: "direct", group: null })).toBe("Can edit (direct)");
    expect(viaLabel({ level: "view", via: "group", group: { id: "g", name: "Ops" } })).toBe("Can view (via Ops)");
    expect(resetSummary({ directShares: 1, groups: 2, keys: 0, feeds: 1, routines: 3 })).toBe("1 direct share · 2 groups · 0 API keys · 1 calendar feed · 3 routines paused");
    const base = { id: "e", via: "web", createdAt: "", actor: { id: "a", displayName: "Ada" }, target: { id: "b", displayName: "Ben" }, group: null, key: null, meta: null };
    expect(activityLabel({ ...base, action: "access.share_removed", item: { kind: "board", title: "Board owned by Carol", titleHidden: true } })).toBe("Ada removed Ben's access to a board owned by Carol");
    expect(activityLabel({ ...base, action: "access.share_lowered", item: { kind: "board", title: "Ops", titleHidden: false, id: "x" } })).toBe("Ada lowered Ben's access to “Ops”");
    expect(activityLabel({ ...base, action: "group.member_added", group: { id: "g", name: "Ops" }, item: null, meta: { self: true } })).toBe("Ada added themselves to “Ops”");
    expect(activityLabel({ ...base, action: "access.reset", item: null })).toBe("Ada reset Ben's access");
    expect(keysReachLine(1)).toBe("1 of your API keys can reach this. Manage them in Settings → API keys.");
    expect(keysReachLine(2)).toBe("2 of your API keys can reach this. Manage them in Settings → API keys.");
  });

  test("the overview lists modules with counts, audience-wide items as counts, and no native select", async () => {
    const { AccessOverview } = await import("../src/access/AccessOverview");
    const html = renderToStaticMarkup(<AccessOverview summary={summary()} loadPage={async (kind) => ({ kind, items: [], nextCursor: null })} actions={{ onRemove: () => undefined, onLower: () => undefined }} />);
    expect(html).toContain("3 boards");
    expect(html).toContain("2 direct, 1 through groups");
    expect(html).toContain("4 notes shared with everyone signed in");
    expect(html).toContain("1 calendar shared with everyone signed in");
    expect(html).toContain("Nothing shared.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<select");
  });

  test("the admin pages render their loading states with a way back and no native select", async () => {
    const { MemberAccess } = await import("../src/team/MemberAccess");
    const { Templates } = await import("../src/team/Templates");
    const { AccessActivity } = await import("../src/team/AccessActivity");
    const { MyAccess } = await import("../src/settings/MyAccess");
    const pages = [
      renderToStaticMarkup(<MemberAccess userId="u1" onBack={() => undefined} flash={() => undefined} />),
      renderToStaticMarkup(<Templates onBack={() => undefined} flash={() => undefined} />),
      renderToStaticMarkup(<AccessActivity members={[{ id: "u1", displayName: "Ada" }]} onBack={() => undefined} />),
      renderToStaticMarkup(<MyAccess />)
    ];
    expect(pages[0]).toContain("Loading access…");
    expect(pages[1]).toContain("New template");
    expect(pages[1]).toContain('class="team-back"');
    expect(pages[2]).toContain("Access activity");
    expect(pages[2]).toContain("Any change");
    expect(pages[3]).toContain("My access");
    for (const html of pages) expect(html).not.toContain("<select");
  });
});
