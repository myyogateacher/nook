import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Contact } from "lucide-react";
import "../src/workspaceModules";
import { installDom, render } from "./support/dom";
import { buildNavTree, NAV_RECENT_LIMIT, navItems, type NavItem, type NavTree } from "../src/shell/navModel";
import { AppSidebar, FINE_POINTER_QUERY, FLYOUT_CLOSE_MS, FLYOUT_OPEN_MS } from "../src/shell/AppSidebar";
import { mergeRecents } from "../src/shell/recents";
import { readExpandedApps, SIDEBAR_EXPANDED_KEY, writeExpandedApps } from "../src/shell/useSidebarState";
import { readyWorkspaceModules, workspaceModule } from "../src/workspaceModules/registry";
import { sectionOfRoute, workspaceSections } from "../src/workspaceModules/sections";
import { ModuleHome } from "../src/ui/ModuleHome";
import type { Role } from "../src/team/teamRoles";
import type { AppSection } from "../src/appShellNavigation";

/**
 * Phase 2 of the left navigation (docs/plan/LEFT_NAV.md §2.3, D1280–D1285): each module's sections
 * are one list, read by the sidebar and by ModuleHome's phone strip; the section on screen comes from
 * the address; recent boards and collections; the chevron disclosure; the hover and rail flyouts.
 */

installDom("http://nook.test/contacts/deals");

const features = { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true };
const tree = (active: AppSection, pathname = "/", search = "", role: Role = "member", recents?: Parameters<typeof buildNavTree>[0]["recents"]) =>
  buildNavTree({ disabledModules: [], features, role, active, location: { pathname, search }, recents });
const app = (t: NavTree, id: string) => [...t.primary, ...t.apps].find((item) => item.id === id)!;
const current = (t: NavTree) => navItems(t).filter((item) => item.current).map((item) => item.id);
const noop = () => undefined;
const sidebarProps = { displayName: "Ada Lovelace", inboxCount: 0, unreadCount: 0, onNavigate: noop, onSearch: noop, onAccount: noop, onSignOut: noop, onToggle: noop };

const EXPECTED: Record<string, string[]> = {
  forms: ["My forms", "Shared with me", "To answer", "Insights"],
  time: ["Timer", "Timesheet", "Reports", "Projects"],
  goals: ["Tree", "List", "Timeline", "Mine", "Insights"],
  checkins: ["Standups", "Feed"],
  crm: ["People", "Companies", "Deals", "Lists", "Follow-ups", "Insights", "Settings"],
  bookings: ["Upcoming", "Past", "Cancelled", "Booking types", "Availability", "Insights", "Profile"],
  townhall: ["Sessions", "Insights"]
};

test("every workspace module nests exactly its definition's sections, the same for every role that sees it", () => {
  for (const module of readyWorkspaceModules()) {
    expect(module.sections?.map((section) => section.label)).toEqual(EXPECTED[module.id]!);
    for (const role of ["admin", "member", "viewer"] as Role[]) {
      const children = app(tree("home", "/", "", role), module.id).children!;
      expect(children.map((child) => child.label)).toEqual(workspaceSections(module.id, role).map((section) => section.label));
      expect(children.every((child) => child.kind === "section" && child.section === module.id)).toBe(true);
    }
  }
  // Guests see the modules their launcher shows, with the same sections (none is gated today).
  const guest = buildNavTree({ disabledModules: [], features: { ...features, vault: false, agents: false, reports: false, time: true, crm: false, bookings: false }, role: "guest", active: "home" });
  for (const item of guest.apps.filter((entry) => entry.id in EXPECTED)) expect(item.children!.map((child) => child.label)).toEqual(EXPECTED[item.id]!);
  // A section hidden for a role is hidden in both places (the same helper filters them).
  const crm = workspaceModule("crm")!;
  const original = crm.sections;
  try {
    crm.sections = [...original!.slice(0, 6), { ...original![6]!, hiddenFor: ["viewer"] }];
    expect(app(tree("home", "/", "", "viewer"), "crm").children!.map((child) => child.label)).not.toContain("Settings");
    expect(workspaceSections("crm", "viewer").map((section) => section.label)).not.toContain("Settings");
    expect(app(tree("home", "/", "", "member"), "crm").children!.map((child) => child.label)).toContain("Settings");
  } finally {
    crm.sections = original;
  }
});

test("sections are real URLs in each module's own format", () => {
  const hrefs = (id: string) => app(tree("home"), id).children!.map((child) => child.href);
  expect(hrefs("crm")).toEqual(["/contacts", "/contacts/companies", "/contacts/deals", "/contacts/lists", "/contacts/followups", "/contacts/insights", "/contacts/settings"]);
  expect(hrefs("goals")).toEqual(["/goals", "/goals?view=list", "/goals?view=timeline", "/goals?view=mine", "/goals?view=insights"]);
  expect(hrefs("time")).toEqual(["/time", "/time/timesheet", "/time/reports", "/time/projects"]);
  expect(hrefs("checkins")).toEqual(["/standups", "/standups/feed"]);
  expect(hrefs("tasks")).toEqual(["/tasks", "/tasks/my", "/tasks/views"]);
  expect(hrefs("inbox")).toEqual(["/inbox", "/inbox/history", "/inbox/routines"]);
  expect(hrefs("collections")).toEqual(["/collections"]);
});

test("the section on screen comes from the address: deep links light it, an item's own page lights none", () => {
  const cases: Array<[AppSection, string, string, string[]]> = [
    ["crm", "/contacts/deals", "", ["crm", "crm:deals"]],
    ["crm", "/contacts", "?book=abc", ["crm", "crm:contacts"]],
    ["crm", "/contacts/deals/engine-pilot-70znmx90j1", "", ["crm", "crm:deals"]],
    ["crm", "/contacts/ada-lovelace-03irax3ykj", "", ["crm", "crm:contacts"]],
    ["crm", "/contacts/duplicates", "", ["crm", "crm:contacts"]],
    ["goals", "/goals", "?view=mine&period=x", ["goals", "goals:mine"]],
    ["goals", "/goals", "", ["goals", "goals:tree"]],
    ["goals", "/goals/grow-mrr-8vw3wo21kt", "", ["goals"]],
    ["time", "/time/projects/website-96tunbqemp", "", ["time", "time:projects"]],
    ["forms", "/forms/answer", "", ["forms", "forms:answer"]],
    ["forms", "/forms/team-feedback-0tgrc2tkmb/edit", "", ["forms"]],
    ["checkins", "/standups/new", "", ["checkins", "checkins:standups"]],
    ["bookings", "/bookings/types/intro-call-abc", "", ["bookings", "bookings:types"]],
    ["bookings", "/bookings/b/0123", "", ["bookings"]],
    ["townhall", "/townhall/all-hands-1p8g2wi4bo", "", ["townhall"]],
    ["townhall", "/townhall/insights", "", ["townhall", "townhall:insights"]],
    ["tasks", "/tasks", "", ["tasks", "tasks:boards"]],
    ["tasks", "/tasks/my", "?q=x", ["tasks", "tasks:my"]],
    ["tasks", "/tasks/views/new", "", ["tasks", "tasks:views"]],
    ["inbox", "/inbox/history/p/abc", "", ["inbox", "inbox:history"]],
    ["inbox", "/inbox/routines", "", ["inbox", "inbox:routines"]],
    ["collections", "/collections", "", ["collections", "collections:all"]]
  ];
  for (const [active, pathname, search, expected] of cases) expect([pathname, current(tree(active, pathname, search))]).toEqual([pathname, expected]);
  // Another app's sections are never current, and without an address none is.
  expect(current(tree("time", "/time"))).toEqual(["time", "time:timer"]);
  expect(current(buildNavTree({ disabledModules: [], features, role: "member", active: "crm" }))).toEqual(["crm"]);
  // The helper modules use directly.
  expect(sectionOfRoute(workspaceModule("bookings")!, { path: ["past"], search: "" })).toBe("past");
});

test("recent boards and collections: newest first, at most 8, the open one current, then All collections", () => {
  const board = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n % 10}${n >= 10 ? "x" : ""}`, name: `Board ${n}`, href: `/tasks/B${n}` });
  const boards = Array.from({ length: 10 }, (_, n) => board(n));
  const tasks = app(tree("tasks", "/tasks", "", "member", { tasks: boards }), "tasks");
  expect(tasks.children!.filter((child) => child.kind === "recent")).toHaveLength(NAV_RECENT_LIMIT);
  const collections = app(tree("collections", "/collections", "", "member", { collections: [{ id: "c1", name: "Reading list", href: "/collections/reading-list-1" }] }), "collections");
  expect(collections.children!.map((child) => [child.kind, child.label])).toEqual([["recent", "Reading list"], ["section", "All collections"]]);
  // The stored list is checked against what can be opened, renamed, and filled by last update.
  const merged = mergeRecents(
    [{ id: "a", name: "Old name", href: "/tasks/A" }, { id: "gone", name: "Deleted", href: "/tasks/G" }],
    [{ id: "b", name: "B", updated_at: "2026-01-02" }, { id: "a", name: "New name", updated_at: "2026-01-01" }, { id: "c", name: "C", updated_at: "2026-01-03" }],
    (id) => `/tasks/${id.toUpperCase()}`);
  expect(merged).toEqual([{ id: "a", name: "New name", href: "/tasks/A" }, { id: "c", name: "C", href: "/tasks/C" }, { id: "b", name: "B", href: "/tasks/B" }]);
  expect(mergeRecents([{ id: "a", name: "A", href: "/tasks/A" }], null, String)).toEqual([{ id: "a", name: "A", href: "/tasks/A" }]);
});

test("ModuleHome reads the same sections: a phone strip (hidden on computers by CSS), the header names the section", () => {
  const markup = renderToStaticMarkup(<ModuleHome icon={Contact} title="Contacts" displayName="Ada" onHome={noop} onSettings={noop} onSignOut={noop}
    sections={{ module: "crm", role: "member", active: "deals", onSelect: noop, counts: { lists: 2 } }}><p>x</p></ModuleHome>);
  const strip = markup.slice(markup.indexOf('<nav class="ui-module-sections"'), markup.indexOf("</nav>", markup.indexOf('<nav class="ui-module-sections"')));
  const labels = [...strip.matchAll(/class="ui-module-tab"[^>]*>([^<]+)/g)].map((match) => match[1]);
  expect(labels).toEqual(app(tree("crm", "/contacts/deals"), "crm").children!.map((child) => child.label));
  expect(strip).toContain('aria-current="page">Deals');
  expect(strip).toContain('aria-label=", 2">2</span>');
  expect(markup).toContain('<span class="ui-module-crumb">· Deals</span>');
  // An item's own tabs stay a strip on every screen; no section is current on the item's page.
  const item = renderToStaticMarkup(<ModuleHome icon={Contact} title="Forms" heading="Team feedback" displayName="Ada" onHome={noop} onSettings={noop} onSignOut={noop}
    tabs={[{ id: "respond", label: "Respond" }, { id: "edit", label: "Edit" }]} activeTab="edit"><p>x</p></ModuleHome>);
  expect(item).not.toContain("ui-module-sections");
  expect(item).toContain('aria-current="page">Edit');
  expect(item).not.toContain("ui-module-crumb");
});

test("the app on screen is open in place; its section is the current page and the app says it holds it", () => {
  const markup = renderToStaticMarkup(<AppSidebar {...sidebarProps} tree={tree("crm", "/contacts/deals")} mode="expanded" />);
  expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  expect(markup).toMatch(/<a class="app-sidebar-sublink active" href="\/contacts\/deals" aria-current="page">/);
  expect(markup).toContain('href="/contacts" aria-current="true"');
  expect(markup).toContain('aria-expanded="true" aria-controls="app-sidebar-sections-crm" aria-label="Hide Contacts sections"');
  expect(markup).toContain('aria-expanded="false" aria-controls="app-sidebar-sections-goals" aria-label="Show Goals sections"');
  // Other apps are one row until opened.
  expect(markup).not.toContain('href="/goals?view=list"');
  // The rail: no chevrons, no nested rows; the app row is the current page.
  const rail = renderToStaticMarkup(<AppSidebar {...sidebarProps} tree={tree("crm", "/contacts/deals")} mode="rail" />);
  expect(rail).not.toContain("app-sidebar-disclosure");
  expect(rail).not.toContain("app-sidebar-sublink");
  expect(rail).toContain('href="/contacts" aria-current="page"');
});

test("a chevron opens another app's sections without moving, and the choice survives a reload", async () => {
  window.localStorage.removeItem(SIDEBAR_EXPANDED_KEY);
  const opened: NavItem[] = [];
  const view = await render(<AppSidebar {...sidebarProps} tree={tree("notes", "/notes")} mode="expanded" onNavigate={(item) => opened.push(item)} />);
  const chevron = view.container.querySelector<HTMLButtonElement>('[aria-controls="app-sidebar-sections-crm"]')!;
  await view.click(chevron);
  expect(opened).toEqual([]);
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
  expect(readExpandedApps(window.localStorage)).toEqual(["crm"]);
  const insights = view.container.querySelector<HTMLAnchorElement>('#app-sidebar-sections-crm a[href="/contacts/insights"]')!;
  await view.click(insights);
  expect(opened.map((item) => [item.kind, item.id, item.href])).toEqual([["section", "crm:insights", "/contacts/insights"]]);
  // A second sidebar (a reload) starts with it open; the chevron closes it again.
  const again = await render(<AppSidebar {...sidebarProps} tree={tree("notes", "/notes")} mode="expanded" />);
  const reopened = again.container.querySelector<HTMLButtonElement>('[aria-controls="app-sidebar-sections-crm"]')!;
  expect(reopened.getAttribute("aria-expanded")).toBe("true");
  await again.click(reopened);
  expect(readExpandedApps(window.localStorage)).toEqual([]);
  // Stored junk is no choice.
  writeExpandedApps(window.localStorage, ["crm"]);
  window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, "{bad");
  expect(readExpandedApps(window.localStorage)).toEqual([]);
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stubPointer = (fine: boolean) => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query === FINE_POINTER_QUERY ? fine : false, media: query, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
};

test("expanded, on a fine pointer: hover intent opens another app's flyout and leaving closes it; touch never does", async () => {
  const { act } = await import("react");
  const restore = stubPointer(true);
  try {
    const view = await render(<AppSidebar {...sidebarProps} tree={tree("time", "/time")} mode="expanded" />);
    const row = view.container.querySelector<HTMLAnchorElement>('a.app-sidebar-link[href="/contacts"]')!;
    const flyout = () => document.querySelector(".app-sidebar-flyout");
    await act(async () => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); await pause(FLYOUT_OPEN_MS / 3); });
    expect(flyout()).toBeNull();
    await act(async () => { await pause(FLYOUT_OPEN_MS); });
    expect(flyout()?.getAttribute("aria-label")).toBe("Contacts sections");
    expect([...flyout()!.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toContain("/contacts/insights");
    // Leaving the row, then coming into the flyout in time, keeps it open.
    await act(async () => { row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); await pause(FLYOUT_CLOSE_MS / 3); });
    await act(async () => { flyout()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); await pause(FLYOUT_CLOSE_MS); });
    expect(flyout()).not.toBeNull();
    await act(async () => { flyout()!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); await pause(FLYOUT_CLOSE_MS + 60); });
    expect(flyout()).toBeNull();
    // The app on screen is open in place: hovering it shows no flyout.
    const time = view.container.querySelector<HTMLAnchorElement>('a.app-sidebar-link[href="/time"]')!;
    await act(async () => { time.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); await pause(FLYOUT_OPEN_MS + 60); });
    expect(flyout()).toBeNull();
  } finally {
    restore();
  }
  const restoreTouch = stubPointer(false);
  try {
    const view = await render(<AppSidebar {...sidebarProps} tree={tree("time", "/time")} mode="expanded" />);
    const row = view.container.querySelector<HTMLAnchorElement>('a.app-sidebar-link[href="/contacts"]')!;
    await act(async () => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); await pause(FLYOUT_OPEN_MS + 60); });
    expect(document.querySelector(".app-sidebar-flyout")).toBeNull();
  } finally {
    restoreTouch();
  }
});

test("the rail's flyout by keyboard: focus opens it, ArrowRight walks in, Escape closes and returns to the app", async () => {
  const { act } = await import("react");
  const view = await render(<AppSidebar {...sidebarProps} tree={tree("time", "/time")} mode="rail" />);
  const goals = view.container.querySelector<HTMLAnchorElement>('a.app-sidebar-link[href="/goals"]')!;
  await act(async () => { goals.focus(); });
  const flyout = () => view.container.querySelector<HTMLElement>(".app-sidebar-flyout");
  expect(flyout()?.getAttribute("aria-label")).toBe("Goals sections");
  expect(goals.getAttribute("aria-expanded")).toBe("true");
  await act(async () => { goals.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); await pause(10); });
  expect(document.activeElement?.getAttribute("href")).toBe("/goals");
  expect(document.activeElement?.className).toContain("app-sidebar-sublink");
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(flyout()).toBeNull();
  expect(document.activeElement).toBe(goals);
});
