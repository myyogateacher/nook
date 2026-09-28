import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarInboxRow } from "../src/AppShell";
import { ModulesContext } from "../src/modules";

/**
 * Review L2: Notes renders its own shell, outside the account row's InboxNavContext, so its sidebar
 * footer carries an Inbox row (with the pending badge) next to Bin: the phone's way into the Inbox.
 */

const noop = () => undefined;

describe("Notes sidebar Inbox row (L2)", () => {
  test("renders for members, viewers, and admins; not for guests or with the Inbox module off", () => {
    for (const role of ["member", "viewer", "admin"] as const) {
      const markup = renderToStaticMarkup(<SidebarInboxRow nav={{ role, openInbox: noop }} />);
      expect(markup).toContain('class="footer-bin footer-inbox"');
      expect(markup).toContain('aria-label="Inbox"');
      expect(markup).toContain(">Inbox</button>");
    }
    expect(renderToStaticMarkup(<SidebarInboxRow nav={{ role: "guest", openInbox: noop }} />)).toBe("");
    expect(renderToStaticMarkup(<SidebarInboxRow nav={{ role: undefined, openInbox: noop }} />)).toBe("");
    expect(renderToStaticMarkup(<ModulesContext.Provider value={["inbox"]}><SidebarInboxRow nav={{ role: "member", openInbox: noop }} /></ModulesContext.Provider>)).toBe("");
  });

  test("the Notes sidebar footer places it between Bin and Sign out, and the row keeps a 44 px target", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    const footer = app.slice(app.indexOf('<footer className="sidebar-footer">'), app.indexOf("</footer>", app.indexOf('<footer className="sidebar-footer">')));
    expect(footer.indexOf("footer-bin")).toBeGreaterThan(0);
    expect(footer.indexOf("<SidebarInboxRow nav={inboxNav} />")).toBeGreaterThan(footer.indexOf("footer-bin"));
    expect(footer.indexOf("footer-signout")).toBeGreaterThan(footer.indexOf("<SidebarInboxRow"));
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
    expect(css).toContain(".footer-bin, .footer-signout { min-height: 44px; }");
  });
});
