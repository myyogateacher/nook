import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";

installDom("http://nook.test/settings/report-owners");

const { ShareSheet } = await import("../src/reports/ShareSheet");

/**
 * D503: the Share sheet's Owners list tags an owner who cannot act as one the way Settings → Report
 * owners does: Blocked, Guest, or Viewer (no tag for an active member or admin).
 */
describe("the Owners list's state tags", () => {
  test("Blocked, Guest, and Viewer, each with its reason; none for an active owner", async () => {
    const owner = (id: string, name: string, state: string, active: boolean) => ({ id, name, primary: id === "u1", active, state, addedBy: null, addedAt: "2026-10-15T00:00:00.000Z" });
    mockApi({
      "GET /users": () => ({ users: [] }),
      "GET /reports/r1/owners": () => ({
        owners: [owner("u1", "Ada Active", "active", true), owner("u2", "Bo Blocked", "blocked", false), owner("u3", "Gil Guest", "guest", false), owner("u4", "Vi Viewer", "viewer", true)],
        canManage: true
      })
    });
    const view = await render(<ShareSheet reportId="r1" title="Weekly revenue" canShare={false} canManageOwners onClose={() => undefined} />);
    const rows = await view.waitFor(() => {
      const items = [...document.querySelectorAll(".report-owner-list li")];
      return items.length === 4 ? items : null;
    });
    const tags = rows.map((row) => [...row.querySelectorAll(".report-owner-tag-off")].map((tag) => [tag.textContent, tag.getAttribute("title")]));
    expect(tags).toEqual([[], [["Blocked", "Blocked: can’t sign in"]], [["Guest", "A guest now: can’t act as an owner"]], [["Viewer", "A viewer now: can’t change the report"]]]);
    expect(document.body.textContent).not.toContain("Can’t sign in");
  });
});
