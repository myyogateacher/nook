import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "../src/workspaceModules";
import { AppSidebar } from "../src/shell/AppSidebar";
import { buildNavTree } from "../src/shell/navModel";
import type { Role } from "../src/team/teamRoles";

/**
 * Review L2 (Notes' way into the Inbox), since D1270: Notes sits in the app frame like every other
 * app, so its own sidebar footer (Settings, Inbox, Sign out) is gone and the global sidebar's Inbox
 * row, with the same rules and pending badge, serves it.
 */

const noop = () => undefined;
const sidebar = (role: Role | undefined, disabledModules: Parameters<typeof buildNavTree>[0]["disabledModules"] = [], inboxCount = 0) => renderToStaticMarkup(<AppSidebar
  tree={buildNavTree({ disabledModules, role, active: "notes" })} mode="expanded" displayName="Ada" inboxCount={inboxCount} unreadCount={0}
  onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop} onToggle={noop} />);

describe("the Inbox row on Notes (L2)", () => {
  test("renders for members, viewers, and admins; not for guests, before the role is known, or with the Inbox module off", () => {
    for (const role of ["member", "viewer", "admin"] as const) expect(sidebar(role)).toContain('href="/inbox"');
    expect(sidebar("guest")).not.toContain('href="/inbox"');
    expect(sidebar(undefined)).not.toContain('href="/inbox"');
    expect(sidebar("member", ["inbox"])).not.toContain('href="/inbox"');
    expect(sidebar("member", [], 4)).toContain('aria-label="Inbox, 4 pending"');
  });

  test("Notes' own pane keeps only its folders: no brand Home button, no footer", async () => {
    const app = await Bun.file(new URL("../src/notes/NotesApp.tsx", import.meta.url)).text();
    const pane = app.slice(app.indexOf('<aside className="folder-pane" id="note-folders">'), app.indexOf("</aside>", app.indexOf('<aside className="folder-pane" id="note-folders">')));
    expect(pane).not.toContain('<footer className="sidebar-footer">');
    expect(pane).not.toContain("nav-home");
    expect(pane).not.toContain("SidebarInboxRow");
    expect(pane).toContain("<ShellMenuButton />");
    // D1279: one collapse control, the global sidebar's; the pane has none (Files neither).
    expect(app).not.toContain("Collapse folders sidebar");
    expect(app).not.toContain("collapsed-sidebar-toggle");
    const files = await Bun.file(new URL("../src/files/FilesApp.tsx", import.meta.url)).text();
    expect(files).not.toContain("Collapse folders sidebar");
    expect(files).not.toContain("setCollapsed");
  });
});
