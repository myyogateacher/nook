import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute, parseSettingsPath, settingsDocumentTitle } from "../src/router";
import { replacesInvitesRoute } from "../src/team/TeamApp";
import { activityLabel, feedsAndRoutines, guestRefusalReason, kindBreakdown, resetSummary, viaLabel, type AccessSummary, type AccessTemplate } from "../src/access/memberAccessApi";
import { itemRef } from "../src/team/MemberAccess";
import { templateHint } from "../src/team/TeamInvites";
import { templateLabel } from "../src/team/inviteFormat";
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
    { kind: "note", module: "notes", items: 0, direct: 0, groupItems: 0, both: 0, group: 0, audience: 4 },
    { kind: "folder", module: "notes", items: 0, direct: 0, groupItems: 0, both: 0, group: 0, audience: 0 },
    { kind: "document", module: "files", items: 0, direct: 0, groupItems: 0, both: 0, group: 0, audience: 0 },
    { kind: "board", module: "tasks", items: 2, direct: 2, groupItems: 1, both: 1, group: 1, audience: 0 },
    { kind: "task_view", module: "tasks", items: 0, direct: 0, groupItems: 0, both: 0, group: 0, audience: 0 },
    { kind: "collection", module: "collections", items: 0, direct: 0, groupItems: 0, both: 0, group: 0, audience: 0 },
    { kind: "calendar", module: "calendar", items: 0, direct: 0, groupItems: 0, both: 0, group: 0, audience: 1 }
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
    expect(resetSummary({ directShares: 1, groups: 2, keys: 0, feeds: 1, routines: 3 })).toBe("1 direct share · 2 group memberships · 1 calendar feed (revoked) · 3 routines (paused)");
    expect(resetSummary({ directShares: 0, groups: 0, keys: 0, feeds: 0, routines: 0 })).toBe("nothing");
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
    // The headline counts distinct items: one board is shared both directly and through a group.
    expect(html).toContain("2 boards");
    expect(html).toContain("2 shared directly · 1 through groups · 1 both ways");
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

  test("QA copy: breakdowns that cannot read as a sum, zero counts hidden, template names, and quotes only around real titles (Q2, Q5, Q7)", () => {
    expect(kindBreakdown({ direct: 3, groupItems: 2, both: 1 })).toBe("3 shared directly · 2 through groups · 1 both ways");
    expect(kindBreakdown({ direct: 0, groupItems: 2, both: 0 })).toBe("2 through groups");
    expect(feedsAndRoutines({ feeds: { live: 0 }, routines: { enabled: 0 } })).toBeNull();
    expect(feedsAndRoutines({ feeds: { live: 1 }, routines: { enabled: 0 } })).toBe("1 calendar feed");
    expect(itemRef({ title: "Board owned by Carol", titleHidden: true })).toBe("the board owned by Carol");
    expect(itemRef({ title: "Ops", titleHidden: false })).toBe("“Ops”");
    const base = { id: "e", via: "web", createdAt: "", actor: { id: "a", displayName: "Ada" }, target: { id: "b", displayName: "Ben" }, group: null, key: null, item: null };
    expect(activityLabel({ ...base, action: "template.applied", meta: { templateName: "Ops starter" } })).toBe("Ada applied the template “Ops starter” to Ben");
    expect(activityLabel({ ...base, action: "template.created", meta: { templateName: "Ops starter" } })).toBe("Ada created the template “Ops starter”");
    const template: AccessTemplate = { id: "t", name: "Guests", role: "guest", groups: [{ id: "g1", name: "Ops", guestRefused: true }, { id: "g2", name: "Lobby", guestRefused: false }], liveInvites: 0, revision: 1, createdAt: "", updatedAt: "" };
    expect(templateHint(template, "guest")).toBe(`They join Lobby when they register. Skipped for a guest: Ops. ${guestRefusalReason(["Ops"])}`);
    expect(templateHint({ ...template, groups: template.groups.map((group) => ({ ...group, guestRefused: false })) }, "guest")).toBe("They join Ops, Lobby when they register.");
    expect(templateLabel({ name: "Guests", groupCount: 2, edited: false, guestSkipped: ["Ops"] })).toBe("Template: Guests (2 groups). A guest skips Ops: sharing with guests is off and it is shared with items");
  });

  test("the activity page offers Person, Group, Key, and Change filters with custom dropdowns (Q1)", async () => {
    const { AccessActivity } = await import("../src/team/AccessActivity");
    const html = renderToStaticMarkup(<AccessActivity members={[{ id: "u1", displayName: "Ada" }]} onBack={() => undefined} />);
    for (const label of ["Person", "Group", "Key", "Change"]) expect(html).toContain(`>${label}</span>`);
    expect(html).toContain("Any key");
    expect(html).not.toContain("<select");
  });

  test("the template form checks the name itself, without the browser's bubble (Q3)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/team/Templates.tsx", import.meta.url), "utf8");
    expect(source).toContain("onSubmit={submit} noValidate");
    expect(source).toContain("Give the template a name.");
    expect(source).not.toMatch(/<input[^>]*\brequired\b/);
    const invites = readFileSync(new URL("../src/team/TeamInvites.tsx", import.meta.url), "utf8");
    expect(invites).toContain("<form onSubmit={submit} noValidate>");
  });
});
