import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { replacesInvitesRoute } from "../src/team/TeamApp";
import { impactLine } from "../src/team/TeamPolicies";

/** Team → Keys and Team → Policies (Wave 31): routes, the admin-only rule, and the impact line. */

describe("Team keys and policies on the client", () => {
  test("/team/keys and /team/policies are routes of their own, matched before the member id rule", () => {
    expect(parseRoute("/team/keys")).toEqual({ app: "team", userId: null, keys: true });
    expect(parseRoute("/team/policies")).toEqual({ app: "team", userId: null, policies: true });
    expect(parseRoute("/team/keys/extra")).toEqual({ app: "team", userId: null });
    expect(formatRoute({ app: "team", userId: null, keys: true })).toBe("/settings/team/keys");
    expect(formatRoute({ app: "team", userId: null, policies: true })).toBe("/settings/team/policies");
    // A member id wins over the flags, as for invites.
    const userId = crypto.randomUUID();
    expect(formatRoute({ app: "team", userId, keys: true })).toBe(`/settings/team/members/${userId}`);
  });

  test("only admins stay on the keys and policies panes", () => {
    for (const role of ["member", "viewer", "guest"] as const) {
      expect(replacesInvitesRoute({ userId: null, invites: false, keys: true }, role)).toBe(true);
      expect(replacesInvitesRoute({ userId: null, invites: false, policies: true }, role)).toBe(true);
    }
    expect(replacesInvitesRoute({ userId: null, invites: false, keys: true }, "admin")).toBe(false);
    expect(replacesInvitesRoute({ userId: null, invites: false }, "member")).toBe(false);
  });

  test("the impact line says what a change would block, and that blocked keys are not revoked", () => {
    expect(impactLine(null, true)).toBe("Checking which keys these settings affect…");
    expect(impactLine({ liveKeys: 4, blocked: 0, newlyBlocked: 0, narrowed: 0 }, false)).toBe("No live key is blocked or narrowed (4 live).");
    expect(impactLine({ liveKeys: 4, blocked: 2, newlyBlocked: 1, narrowed: 1 }, true))
      .toBe("2 of 4 live keys would be blocked (1 newly); 1 key would lose at least one module. Blocked keys are not revoked: loosening the policy brings them back.");
  });

  test("both panes render their loading state with a Team back button for phones", async () => {
    const { TeamKeys } = await import("../src/team/TeamKeys");
    const { TeamPolicies } = await import("../src/team/TeamPolicies");
    const keys = renderToStaticMarkup(<TeamKeys members={[{ id: "u1", displayName: "Asha" }]} onBack={() => undefined} flash={() => undefined} />);
    expect(keys).toContain('class="team-back"');
    expect(keys).toContain("Loading keys…");
    expect(keys).toContain("never the secrets");
    const policies = renderToStaticMarkup(<TeamPolicies onBack={() => undefined} flash={() => undefined} />);
    expect(policies).toContain("Loading policies…");
    expect(policies).not.toContain("<select");
  });
});
