import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";

installDom("http://nook.test/settings/report-owners");

const { ShareSheet } = await import("../src/reports/ShareSheet");
const { ReportOwnerReview } = await import("../src/settings/ReportOwnerReview");
const { popStateClosedDialog, resetHistoryDialogsForTests } = await import("../src/historyDialogs");
const { act, useEffect, useState } = await import("react");

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

/**
 * D508: Back left Settings → Report owners with a report's Owners sheet open, and Forward came back to
 * the section and its sheet. The section reloads only the list's first page, so a report from a later
 * page (Load more) is named by the owners answer, not "Report".
 */
describe("the Owners sheet Forward reopens", () => {
  test("is titled with the report's name for a report past the list's first page", async () => {
    resetHistoryDialogsForTests();
    const FIRST = "0b8f7c2e-1111-4111-8111-111111111111";
    const LATER = "0b8f7c2e-2222-4222-8222-222222222222";
    const row = (id: string, title: string) => ({ id, title, folder: null, owners: [], updatedAt: "2026-10-15T00:00:00.000Z", canOpen: false, managed: false });
    const page = (reports: unknown[], nextCursor: string | null, total: number | null) => ({ scope: "unmanaged", reports, total, limit: 200, nextCursor });
    mockApi({
      "GET /users": () => ({ users: [] }),
      "GET /reports/admin/owner-review?scope=unmanaged": () => page([row(FIRST, "First page report")], "c2", 2),
      "GET /reports/admin/owner-review?scope=unmanaged&cursor=c2": () => page([row(LATER, "Later page report")], null, null),
      [`GET /reports/${LATER}/owners`]: () => ({ owners: [], canManage: true, title: "Later page report" })
    });
    function Routed() {
      const [route, setRoute] = useState("settings");
      const [mounts, setMounts] = useState(0);
      useEffect(() => {
        const onPop = (event: PopStateEvent) => {
          if (popStateClosedDialog(event)) return;
          setRoute(String((event.state as Record<string, unknown> | null)?.route ?? "home"));
          setMounts((count) => count + 1);
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
      }, []);
      return route === "settings" ? <ReportOwnerReview key={mounts} /> : <p>Home</p>;
    }
    window.history.replaceState({ route: "home", "mynotes.depth": 0 }, "", "/");
    window.history.pushState({ route: "settings", "mynotes.depth": 1 }, "", "/settings/report-owners");
    const view = await render(<Routed />);
    const eyebrow = () => document.querySelector('[role="dialog"] .eyebrow')?.textContent ?? null;
    const browser = async (move: "back" | "forward") => {
      await act(async () => { if (move === "back") window.history.back(); else window.history.forward(); await Bun.sleep(40); });
      await act(async () => { await Bun.sleep(20); });
    };
    await view.click(await view.waitFor(() => view.button("Load more")));
    await view.waitFor(() => document.body.textContent?.includes("Later page report"));
    const later = [...document.querySelectorAll(".report-source")].find((item) => item.textContent?.includes("Later page report"))!;
    await view.click(later.querySelector("button")!);
    await view.waitFor(() => eyebrow() === "Later page report");

    await browser("back");
    await view.waitFor(() => document.querySelector('[role="dialog"]') === null);
    await browser("back");
    await view.waitFor(() => document.body.textContent?.includes("Home"));
    await browser("forward");
    await view.waitFor(() => document.body.textContent?.includes("First page report"));
    expect(document.body.textContent).not.toContain("Later page report");
    await browser("forward");
    expect(await view.waitFor(() => eyebrow())).toBe("Later page report");
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Owners");
    await view.rerender(<></>);
    resetHistoryDialogsForTests();
  });
});
