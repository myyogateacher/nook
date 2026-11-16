import { describe, expect, test } from "bun:test";
import "../src/workspaceModules/index";
import { safeNotificationPath } from "../src/notifications/notificationsApi";
import { parseRoute } from "../src/router";
import { commentsPath } from "../shared/itemActivity";

/**
 * Deep links to the Activity panels (D1367): a notification or email about a comment on a form,
 * standup, townhall session, booking type, or time project opens where the comments are, and the
 * router keeps the part of the link that says so.
 */

const SHORT = "k7f3q2ab01";
describe("activity deep links (D1367)", () => {
  test("comment links of the five containers point at their Activity tab or section; other kinds at their page", () => {
    expect(commentsPath("form", `/forms/survey-${SHORT}`)).toBe(`/forms/survey-${SHORT}/activity`);
    expect(commentsPath("checkin", `/standups/daily-${SHORT}`)).toBe(`/standups/daily-${SHORT}/activity`);
    expect(commentsPath("townhall_session", `/townhall/all-hands-${SHORT}`)).toBe(`/townhall/all-hands-${SHORT}?tab=activity`);
    expect(commentsPath("time_project", `/time/projects/site-${SHORT}`)).toBe(`/time/projects/site-${SHORT}?tab=activity`);
    expect(commentsPath("booking_type", `/bookings/types/intro-${SHORT}`)).toBe(`/bookings/types/intro-${SHORT}?section=activity`);
    expect(commentsPath("goal", `/goals/grow-${SHORT}`)).toBe(`/goals/grow-${SHORT}`);
  });

  test("the bell follows each of them as written, and the router keeps the tab or section", () => {
    for (const [kind, href] of [["form", `/forms/survey-${SHORT}`], ["checkin", `/standups/daily-${SHORT}`], ["townhall_session", `/townhall/all-hands-${SHORT}`],
      ["time_project", `/time/projects/site-${SHORT}`], ["booking_type", `/bookings/types/intro-${SHORT}`]] as const) {
      const path = commentsPath(kind, href);
      expect({ kind, path: safeNotificationPath(path) }).toEqual({ kind, path });
    }
    expect(parseRoute(`/time/projects/site-${SHORT}`, "?tab=activity")).toMatchObject({ search: "?tab=activity" });
    expect(parseRoute(`/bookings/types/intro-${SHORT}`, "?section=activity")).toMatchObject({ search: "?section=activity" });
    // Anything else is dropped, as before.
    expect((parseRoute(`/bookings/types/intro-${SHORT}`, "?section=nope") as { search?: string }).search ?? "").toBe("");
    expect((parseRoute(`/time/projects/site-${SHORT}`, "?tab=nope") as { search?: string }).search ?? "").toBe("");
  });
});
