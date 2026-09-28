import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { replacesInvitesRoute } from "../src/team/TeamApp";
import { groupEventLabel, guestCountLabel, memberCountLabel } from "../src/team/groupsApi";

/** Team → Groups on the client (Wave 32): routes, the admin-only rule, history lines, and the list pane. */

describe("Team groups on the client", () => {
  test("/team/groups and /team/groups/:groupId are routes of their own, before the member id rule", () => {
    const groupId = crypto.randomUUID();
    expect(parseRoute("/team/groups")).toEqual({ app: "team", userId: null, groups: true });
    expect(parseRoute(`/team/groups/${groupId.toUpperCase()}`)).toEqual({ app: "team", userId: null, groups: true, groupId });
    expect(parseRoute("/team/groups/not-an-id")).toEqual({ app: "team", userId: null, groups: true });
    expect(parseRoute(`/team/groups/${groupId}/extra`)).toEqual({ app: "team", userId: null });
    expect(formatRoute({ app: "team", userId: null, groups: true })).toBe("/team/groups");
    expect(formatRoute({ app: "team", userId: null, groups: true, groupId })).toBe(`/team/groups/${groupId}`);
  });

  test("only admins stay on the groups pane", () => {
    for (const role of ["member", "viewer", "guest"] as const) expect(replacesInvitesRoute({ userId: null, invites: false, groups: true }, role)).toBe(true);
    expect(replacesInvitesRoute({ userId: null, invites: false, groups: true, groupId: "g" }, "admin")).toBe(false);
  });

  test("history lines flag an admin adding themselves (O-A1)", () => {
    const actor = { id: "a", displayName: "Ada" };
    const target = { id: "b", displayName: "Ben" };
    expect(groupEventLabel({ id: "1", action: "group.member_added", createdAt: "", actor, target, self: false })).toBe("Ada added Ben");
    expect(groupEventLabel({ id: "2", action: "group.member_added", createdAt: "", actor, target: actor, self: true })).toBe("Ada added themselves");
    expect(groupEventLabel({ id: "3", action: "group.member_removed", createdAt: "", actor, target, self: false })).toBe("Ada removed Ben");
    expect(groupEventLabel({ id: "4", action: "group.created", createdAt: "", actor, target: null, self: false })).toBe("Ada created the group");
    expect(memberCountLabel(1)).toBe("1 person");
    expect(memberCountLabel(3) + guestCountLabel(2)).toBe("3 people · includes 2 guests");
  });

  test("the groups pane renders its loading state with a Team back button for phones and no native select", async () => {
    const { TeamGroups } = await import("../src/team/TeamGroups");
    const html = renderToStaticMarkup(<TeamGroups onBack={() => undefined} onOpenGroup={() => undefined} flash={() => undefined} />);
    expect(html).toContain('class="team-back"');
    expect(html).toContain("Loading groups…");
    expect(html).toContain("New group");
    expect(html).toContain("A group never opens anything by itself");
    expect(html).not.toContain("<select");
  });
});
