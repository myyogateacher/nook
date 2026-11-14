import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsHubShell } from "../src/settings/SettingsHub";
import { PageHeader } from "../src/shell/PageHeader";

/**
 * F2 (the page's name on phones), since D1273: the one-row page header shows the page's name at
 * every width, so the separate phone-only page-name line (AppPageName) is gone.
 */

const root = join(import.meta.dir, "..", "src");
const pages: Record<string, string> = {
  "tasks/TasksApp.tsx": "Tasks",
  "collections/CollectionsApp.tsx": "Collections",
  "inbox/InboxApp.tsx": "Inbox",
  "chat/ChatApp.tsx": "Chat",
  "notifications/NotificationsApp.tsx": "Notifications",
  "whiteboards/WhiteboardsApp.tsx": "Whiteboards",
  "vault/VaultApp.tsx": "Vault",
  "reports/ReportsHome.tsx": "Reports"
};

test("every app page has the one-row page header with its name (F2, D1273)", async () => {
  for (const [path, name] of Object.entries(pages)) {
    const source = await Bun.file(join(root, path)).text();
    expect(source).toContain(`<PageHeader title="${name}" />`);
    expect(source).not.toContain("AppPageName");
    expect(source).not.toContain('className="app-home-button"');
  }
  const markup = renderToStaticMarkup(<PageHeader title="Calendar" />);
  expect(markup).toContain('<div class="page-header-title"><strong>Calendar</strong></div>');
});

test("Calendar, which has no other h1, names the page with an h1 in the header; the Settings hub names its section", async () => {
  const calendar = await Bun.file(join(root, "calendar/CalendarApp.tsx")).text();
  expect(calendar).toContain('<PageHeader title={<h1 className="app-page-title">Calendar</h1>} />');
  // Wave 37: Team lives in the Settings hub, whose section header carries the page's h1.
  const hub = await Bun.file(join(root, "settings/SettingsHub.tsx")).text();
  expect(hub).toContain('<h1 id={HUB_TITLE_ID} ref={headingRef} tabIndex={-1}>{title}</h1>');
  expect(hub).not.toContain('className="app-page-title"');
});

test("the header is one row on phones: no wrapping second line", async () => {
  const css = await Bun.file(join(root, "shell", "sidebar.css")).text();
  expect(css).toMatch(/\.app-page-header\.page-header \{ height: 52px; min-height: 52px; display: flex; flex-wrap: nowrap;/);
  const phone = css.slice(css.indexOf("@media (max-width: 760px) {\n  .app-page-header.page-header"));
  expect(phone).toMatch(/\.app-page-header\.page-header \{ height: 56px; min-height: 56px;/);
  const shell = await Bun.file(join(root, "appShell.css")).text();
  expect(shell).not.toContain(".app-page-name");
});

test("a rendered Settings page header names Settings (the Bin is Settings → Bin since Wave 38)", () => {
  const markup = renderToStaticMarkup(<SettingsHubShell displayName="Ada" role="member" entries={[]} selected="bin" listScreen={false} title="Bin" showBack onBack={() => undefined} onSelect={() => undefined} onHome={() => undefined}>{null}</SettingsHubShell>);
  expect(markup).toContain('<div class="page-header-title"><strong>Settings</strong></div>');
});
