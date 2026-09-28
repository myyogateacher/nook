import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AppPageName } from "../src/AppShell";
import { BinApp } from "../src/bin/BinApp";

const root = join(import.meta.dir, "..", "src");
const pages: Record<string, string> = {
  "tasks/TasksApp.tsx": "Tasks",
  "collections/CollectionsApp.tsx": "Collections",
  "calendar/CalendarApp.tsx": "Calendar",
  "team/TeamApp.tsx": "Team",
  "inbox/InboxApp.tsx": "Inbox",
  "bin/BinApp.tsx": "Bin",
  "notifications/NotificationsApp.tsx": "Notifications"
};

test("every app page header carries a visible phone page name (F2)", async () => {
  for (const [path, name] of Object.entries(pages)) {
    const source = await Bun.file(join(root, path)).text();
    const header = source.match(/<header className="app-page-header">([\s\S]*?)<\/header>/)?.[1] ?? "";
    expect(header).toContain(`<AppPageName name="${name}" />`);
  }
  expect(renderToStaticMarkup(<AppPageName name="Calendar" />)).toBe('<span class="app-page-name" aria-hidden="true">Calendar</span>');
});

test("Calendar, which has no other h1, names the page with an h1 in the header; Team keeps its list h1", async () => {
  for (const [path, name] of [["calendar/CalendarApp.tsx", "Calendar"]]) {
    const source = await Bun.file(join(root, path)).text();
    expect(source).toContain(`<h1 className="app-page-title">${name}</h1>`);
  }
  const team = await Bun.file(join(root, "team/TeamApp.tsx")).text();
  expect(team).toContain('<h1 id="team-title">Team</h1>');
  expect(team).not.toContain('className="app-page-title"');
});

test("the phone stylesheet shows the page name and keeps the hidden brand in the accessibility tree", async () => {
  const shell = await Bun.file(join(root, "appShell.css")).text();
  const phone = shell.slice(shell.lastIndexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.app-page-name \{[^}]*display: block/);
  const inbox = await Bun.file(join(root, "inbox", "inbox.css")).text();
  expect(inbox).not.toContain(".app-home-brand { display: none; }");
});

test("a rendered page header includes the page name", () => {
  const markup = renderToStaticMarkup(<BinApp displayName="Ada" onSettings={() => undefined} onSignOut={() => undefined} flash={() => undefined} onHome={() => undefined} />);
  expect(markup).toContain('<span class="app-page-name" aria-hidden="true">Bin</span>');
});
