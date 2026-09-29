import { expect, test } from "bun:test";

/**
 * P0 (final carry-overs): the body never scrolls (styles.css: `overflow: hidden`), so every app shell
 * must own a scroll container with a bounded height, or its content below the fold is unreachable.
 * Team, Bin, Inbox, Notifications, and Calendar had none; Files on phones let its pane grow past the
 * screen; sign-in pages could not scroll on a short landscape phone. This guards the shells; the
 * real-browser audit that scrolls every route at both widths is docs/plan/qa/scroll-audit.mjs.
 */

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
const css = async () => (await Promise.all(["styles.css", "appShell.css", "tasks/tasks.css", "collections/collections.css", "today/today.css", "files/files.css"].map(read))).join("\n");

/** The declarations of the first rule whose selector list contains `selector` exactly. */
function rule(stylesheet: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(stylesheet);
  return match?.[2] ?? null;
}

const bounded = (declarations: string | null) => Boolean(declarations && /(^|;)\s*(height:\s*100dvh|flex:\s*1\b)/.test(declarations) && /overflow(-y)?:\s*(auto|scroll)/.test(declarations));

test("the body stays fixed, so every shell below must scroll on its own", async () => {
  expect(rule(await read("styles.css"), "body")).toContain("overflow: hidden");
});

test("module pages without their own shell (Team, Bin, Inbox, Notifications, Calendar) scroll as a page with a fixed header", async () => {
  const shell = await read("appShell.css");
  const page = rule(shell, ".app-page:not(.tasks-app):not(.collections-app)");
  expect(bounded(page)).toBe(true);
  expect(rule(shell, ".app-page:not(.tasks-app):not(.collections-app) > .app-page-header")).toContain("position: sticky");
  // Each of those modules renders the `app-page` root the rule matches.
  for (const [file, root] of [["team/TeamApp.tsx", "app-page team-app"], ["bin/BinApp.tsx", "app-page bin-app"], ["inbox/InboxApp.tsx", "app-page inbox-app"], ["notifications/NotificationsApp.tsx", "app-page notifications-app"], ["calendar/CalendarApp.tsx", "app-page calendar-app"]] as const) {
    expect({ file, root: (await read(file)).includes(root) }).toEqual({ file, root: true });
  }
});

test("shells with their own scroll pane keep it: Tasks, Collections, Today, Notes and Files panes, Settings", async () => {
  const sheet = await css();
  for (const selector of [".tasks-content", ".collections-content", ".collection-body", ".today-home", ".note-list", ".folder-nav", ".settings-content"]) {
    const declarations = rule(sheet, selector);
    expect({ selector, scrolls: /overflow(-y)?:\s*(auto|scroll)/.test(declarations ?? "") }).toEqual({ selector, scrolls: true });
  }
  expect(bounded(rule(sheet, ".tasks-app")) || /height:\s*100dvh/.test(rule(sheet, ".tasks-app") ?? "")).toBe(true);
  expect(rule(sheet, ".workspace")).toContain("height: 100dvh");
});

test("Files on phones: the pane keeps the absolute panel box, so its list scrolls inside the screen", async () => {
  const files = await read("files/files.css");
  expect(files).not.toMatch(/^\.file-pane \{ position: relative; \}/m);
  expect(files).toContain("@media (min-width: 761px) { .file-pane { position: relative; } }");
});

test("sign-in pages scroll on a short screen and keep their top reachable", async () => {
  const declarations = /^\.auth-page \{([^}]*)\}/m.exec(await read("styles.css"))?.[1] ?? "";
  expect(declarations).toContain("height: 100dvh");
  expect(declarations).toContain("overflow-y: auto");
  expect(declarations).toContain("place-items: safe center");
});
