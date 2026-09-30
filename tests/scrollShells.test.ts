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

test("Whiteboards: the list scrolls as a page with a fixed header; the canvas fills the screen and never scrolls", async () => {
  const shell = await read("appShell.css");
  expect(bounded(rule(shell, ".app-page:not(.tasks-app):not(.collections-app)"))).toBe(true);
  // The list renders the `app-page` root the page rule matches (it is neither Tasks nor Collections).
  expect(await read("whiteboards/WhiteboardsApp.tsx")).toContain(`<main className="app-page whiteboards-app">`);
  const whiteboards = await read("whiteboards/whiteboards.css");
  // The list's own rules never take the page's scrolling away.
  expect(whiteboards).not.toMatch(/\.whiteboards-app\s*\{[^}]*overflow/);
  // The canvas is its own fixed full-screen page outside the page rule: no page scroll, the stage fills the rest.
  const canvas = rule(whiteboards, ".whiteboard-canvas-page") ?? "";
  expect(canvas).toContain("position: fixed");
  expect(canvas).toContain("height: 100dvh");
  expect(canvas).toContain("overflow: hidden");
  expect(await read("whiteboards/WhiteboardCanvas.tsx")).not.toContain("app-page");
  const stage = rule(whiteboards, ".whiteboard-stage") ?? "";
  expect(stage).toContain("flex: 1 1 auto");
  expect(stage).toContain("min-height: 0");
});

test("F2: Home (Today) keeps its header fixed while its content scrolls, like the module pages", async () => {
  const today = await read("today/today.css");
  expect(bounded(rule(today, ".today-home"))).toBe(true);
  const header = rule(today, ".today-home > .app-home-header") ?? "";
  expect(header).toContain("position: sticky");
  expect(header).toContain("top: 0");
  expect(await read("today/TodayHome.tsx")).toMatch(/<main className="app-home today-home">\s*<header className="app-home-header">/);
});

test("F1: two-pane pages (Team and its sections, Inbox proposals) scroll each pane on its own on a computer, as one page on phones", async () => {
  const shell = await read("appShell.css");
  const desktop = /@media \(min-width: 761px\) \{\s*\.app-page:not\(\.tasks-app\):not\(\.collections-app\):has\(> \.split-layout\)[\s\S]*?\n\}/.exec(shell)?.[0] ?? "";
  // The page stops scrolling; the layout fills the space under the header.
  expect(rule(desktop, ".app-page:not(.tasks-app):not(.collections-app):has(> .split-layout)")).toContain("overflow: hidden");
  const layout = rule(desktop, ".app-page > .split-layout") ?? "";
  expect(layout).toContain("flex: 1 1 auto");
  expect(layout).toContain("min-height: 0");
  expect(layout).toContain("grid-template-rows: minmax(0, 1fr)");
  // Each pane is a bounded scroller and never sticky (a sticky pane taller than the window hid its top).
  const pane = rule(desktop, ".split-layout > .split-pane") ?? "";
  expect(pane).toMatch(/overflow-y:\s*auto/);
  expect(pane).toContain("max-height: 100%");
  expect(pane).toContain("position: static");
  // Phones keep the page scroller: the split rules live only in the computer media query.
  expect(shell.replace(desktop, "")).not.toContain(".split-pane {");
  const team = await read("team/TeamApp.tsx");
  expect(team).toContain(`<div className="team-layout split-layout">`);
  expect(team).toContain(`className="team-list-pane split-pane"`);
  expect(team).toContain(`className="team-detail-pane split-pane"`);
  // A newly chosen row (member, invites, groups, templates, keys, email log, ...) opens at the pane's top.
  expect(team).toMatch(/detailPaneRef\.current\?\.scrollTo\(\{ top: 0 \}\); \}, \[paneKey\]\)/);
  const inbox = await read("inbox/InboxApp.tsx");
  expect(inbox).toContain(`" split-layout"`);
  expect(inbox).toContain(`className="inbox-detail-pane split-pane"`);
  expect(inbox).toMatch(/detailPaneRef\.current\?\.scrollTo\(\{ top: 0 \}\); \}, \[route\.proposalId\]\)/);
});
