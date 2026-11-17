import { expect, test } from "bun:test";
import { useEffect } from "react";
import "../src/workspaceModules";
import { installDom, mockApi, reply, render } from "./support/dom";
import { buildNavTree, type NavItem } from "../src/shell/navModel";
import { AppFrame } from "../src/shell/AppFrame";
import { CommandPalette } from "../src/shell/CommandPalette";
import { CustomizeSidebar } from "../src/shell/ShellSheets";
import { filterPalette, flatPalette, fuzzyWordScore, paletteEntries, paletteScore, type PaletteEntry } from "../src/shell/paletteModel";
import { shortcutGroups, shortcutKeys } from "../src/shell/shortcuts";
import { alphabeticalIds, alphabeticalLayout, arrangeApps, arrangeIds, compareLabels, DEFAULT_APP_ORDER, isAlphabetical, moveApp, readLocalLayout, reconcileSidebarLayout, setAppPinned, SIDEBAR_APPS_KEY, SIDEBAR_DIRTY_KEY, stepApp, useSidebarSync, writeLocalLayout } from "../src/shell/sidebarPrefs";
import { SIDEBAR_EXPANDED_KEY, SIDEBAR_STORAGE_KEY } from "../src/shell/useSidebarState";
import { arrangedTodayApps, enabledTodayApps } from "../src/today/todayApps";
import { visibleQuickActions } from "../src/today/QuickActions";
import { SIDEBAR_SAVE_DELAY_MS, usePreferences } from "../src/usePreferences";
import { MODULES, type Preferences } from "../src/modules";
import { SIDEBAR_APP_IDS } from "../shared/sidebar";
import type { Role } from "../src/team/teamRoles";

/**
 * Left navigation phase 4 (docs/plan/LEFT_NAV.md §4, D1293–D1298): the ⌘K palette, the "?" sheet,
 * pinning and reordering apps, and the sidebar's layout synced through /api/preferences.
 */

installDom("http://nook.test/tasks");

const features = { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true };
const guestFeatures = { vault: false, agents: false, reports: false, time: false, crm: false, bookings: false };
const quietApi = (routes: Parameters<typeof mockApi>[0] = {}) => mockApi({ "GET /inbox/count": () => ({ pending: 0 }), "GET /notifications?unread=1&limit=1": () => ({ items: [], unreadCount: 0 }), ...routes });
const noop = () => undefined;
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const { act } = await import("react");
const key = async (target: EventTarget, init: KeyboardEventInit) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); }); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

// ---------------------------------------------------------------------------------------------
// Order and pins (D1294): a pure function on the tree.

test("the sidebar's app ids are the launcher's, in MODULES order", () => {
  expect([...SIDEBAR_APP_IDS]).toEqual(MODULES.flatMap((module) => module.launcher ? [module.launcher.section] : []));
});

test("order and pins arrange the tree; apps it does not list keep their default place", () => {
  expect(arrangeIds(["a", "b", "c", "d"], ["d", "c", "b", "a"])).toEqual(["d", "c", "b", "a"]);
  // An app added later (not in the saved order) lands right after its default neighbour.
  expect(arrangeIds(["a", "b", "c", "d"], ["c", "b", "a"])).toEqual(["c", "d", "b", "a"]);
  expect(arrangeIds(["a", "b"], ["zz", "b", "a"])).toEqual(["b", "a"]);
  const order = moveApp({}, DEFAULT_APP_ORDER, "crm", 0, false).order;
  expect(order.slice(0, 3)).toEqual(["crm", "bookings", "calendar"]);
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "home", layout: { order, pinned: ["tasks", "calendar"] } });
  // Pinned in the person's order (calendar comes before tasks there, A–Z, and order does not move them).
  expect(ids(tree.pinned)).toEqual(["calendar", "tasks"]);
  expect(ids(tree.apps).slice(0, 4)).toEqual(["crm", "bookings", "chat", "collections"]);
  expect(ids(tree.apps)).not.toContain("tasks");
  // Without a layout: A–Z by the names people see (D1305), nothing pinned.
  const plain = buildNavTree({ disabledModules: [], features, role: "member", active: "home" });
  expect(plain.pinned).toEqual([]);
  expect(ids(plain.apps)).toEqual([...DEFAULT_APP_ORDER]);
  expect(plain.apps.map((item) => item.label)).toEqual(["Bookings", "Calendar", "Chat", "Collections", "Contacts", "Files", "Forms", "Goals", "Notes", "Reports", "Standups", "Tasks", "Time", "Townhall", "Vault", "Whiteboards"]);
});

test("D1305: A–Z is by the shown name, case-insensitive; Reset to A–Z drops the custom order and keeps the pins in their order", () => {
  expect(alphabeticalIds(["notes", "chat", "crm", "checkins", "bookings"])).toEqual(["bookings", "chat", "crm", "notes", "checkins"]);
  expect(compareLabels("apple", "Banana")).toBeLessThan(0);
  expect(compareLabels("Écrit", "Zeta")).toBeLessThan(0);
  expect(isAlphabetical({})).toBe(true);
  const custom = moveApp({ pinned: ["tasks", "files"] }, ["tasks", "files", ...DEFAULT_APP_ORDER.filter((id) => id !== "tasks" && id !== "files")], "whiteboards", 2, false);
  expect(isAlphabetical(custom)).toBe(false);
  const reset = alphabeticalLayout(custom);
  expect(isAlphabetical(reset)).toBe(true);
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "home", layout: reset });
  expect(ids(tree.pinned)).toEqual(ids(buildNavTree({ disabledModules: [], features, role: "member", active: "home", layout: custom }).pinned));
  expect(ids(tree.apps)).toEqual(DEFAULT_APP_ORDER.filter((id) => !reset.pinned.includes(id)));
  expect(alphabeticalLayout({ order: ["whiteboards", "notes"] })).toEqual({ order: [], pinned: [] });
});

test("pinning never shows what is off or not offered (presentation only, T97)", () => {
  const layout = { order: ["vault", "crm", "notes"] as const, pinned: ["vault", "crm", "notes"] as const };
  const guest = buildNavTree({ disabledModules: [], features: guestFeatures, role: "guest", active: "home", layout: { order: [...layout.order], pinned: [...layout.pinned] } });
  expect(ids(guest.pinned)).toEqual(["notes"]);
  for (const hidden of ["vault", "crm", "chat", "reports", "bookings"]) expect(ids([...guest.pinned, ...guest.apps])).not.toContain(hidden);
  const notesOff = buildNavTree({ disabledModules: ["notes"], features, role: "member", active: "home", layout: { pinned: ["notes"] } });
  expect(ids([...notesOff.pinned, ...notesOff.apps])).not.toContain("notes");
});

test("dragging moves an app among the shown ones and pins or unpins it; hidden apps keep their place", () => {
  // collections is not shown (turned off).
  const shown = ["calendar", "files", "notes", "tasks"];
  // tasks to the top, pinned.
  const pinned = moveApp({}, shown, "tasks", 0, true);
  expect(pinned.pinned).toEqual(["tasks"]);
  expect(arrangeApps(shown, pinned, (id) => id)).toEqual({ pinned: ["tasks"], rest: ["calendar", "files", "notes"] });
  expect([...pinned.order].sort()).toEqual([...SIDEBAR_APP_IDS].sort());
  // Notes up to the top of Apps: chat and collections (hidden) keep their place after calendar, so turning them on puts them back there.
  const moved = moveApp(pinned, ["tasks", "calendar", "files", "notes"], "notes", 1, false);
  expect(arrangeApps(shown, moved, (id) => id)).toEqual({ pinned: ["tasks"], rest: ["notes", "calendar", "files"] });
  expect(moved.order.indexOf("chat")).toBe(moved.order.indexOf("calendar") + 1);
  // A second pin lands after the first; dropped among the apps again, unpinned where it fell.
  const two = moveApp(moved, ["tasks", "notes", "calendar", "files"], "files", 1, true);
  expect(arrangeApps(shown, two, (id) => id)).toEqual({ pinned: ["tasks", "files"], rest: ["notes", "calendar"] });
  const back = moveApp(two, ["tasks", "files", "notes", "calendar"], "tasks", 2, false);
  expect(arrangeApps(shown, back, (id) => id)).toEqual({ pinned: ["files"], rest: ["notes", "tasks", "calendar"] });
});

test("the arrows move within a group and stop at its edges; pin goes to the end of Pinned", () => {
  const layout = { order: [], pinned: ["files"] } as const;
  const shown = ["files", "notes", "tasks"];
  expect(stepApp(layout, shown, "files", -1)).toBeNull();
  expect(stepApp(layout, shown, "notes", -1)).toBeNull(); // would cross into Pinned
  const down = stepApp(layout, shown, "notes", 1)!;
  expect(arrangeApps(shown, down, (id) => id)).toEqual({ pinned: ["files"], rest: ["tasks", "notes"] });
  const both = setAppPinned(layout, shown, "tasks", true);
  expect(arrangeApps(shown, both, (id) => id)).toEqual({ pinned: ["files", "tasks"], rest: ["notes"] });
  const unpinned = setAppPinned(both, ["files", "tasks", "notes"], "files", false);
  expect(arrangeApps(shown, unpinned, (id) => id)).toEqual({ pinned: ["tasks"], rest: ["files", "notes"] });
});

test("Home's phone tiles follow the sidebar's order, pinned first", () => {
  const layout = setAppPinned(moveApp({}, DEFAULT_APP_ORDER, "whiteboards", 0, false), DEFAULT_APP_ORDER, "files", true);
  const tiles = arrangedTodayApps(enabledTodayApps([]), layout).map((app) => app.section);
  const tree = buildNavTree({ disabledModules: [], features, role: "admin", active: "home", layout });
  expect(tiles).toEqual(ids([...tree.pinned, ...tree.apps]));
  expect(tiles.slice(0, 3)).toEqual(["files", "whiteboards", "bookings"]);
});

// ---------------------------------------------------------------------------------------------
// Sync (D1295): this browser first, the server reconciles.

test("reconciling: a pending change here is sent; else the server wins field by field; an empty server is seeded", () => {
  const local = { mode: "rail" as const, order: ["crm" as const] };
  expect(reconcileSidebarLayout({ local, server: { pinned: ["notes"] }, dirty: true })).toEqual({ apply: null, push: local });
  expect(reconcileSidebarLayout({ local, server: { ...local }, dirty: true })).toEqual({ apply: null, push: null });
  expect(reconcileSidebarLayout({ local, server: { pinned: ["notes"], mode: "expanded" }, dirty: false })).toEqual({ apply: { mode: "expanded", order: ["crm"], pinned: ["notes"] }, push: null });
  expect(reconcileSidebarLayout({ local, server: { ...local }, dirty: false })).toEqual({ apply: null, push: null });
  expect(reconcileSidebarLayout({ local, server: null, dirty: false })).toEqual({ apply: null, push: local });
  expect(reconcileSidebarLayout({ local: {}, server: null, dirty: false })).toEqual({ apply: null, push: null });
});

test("the layout lives under nook.sidebar*, read back cleaned", () => {
  window.localStorage.clear();
  expect(readLocalLayout()).toEqual({});
  writeLocalLayout({ mode: "rail", order: ["crm", "notes"], pinned: ["crm"], expanded: ["inbox"] }, "server");
  expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("rail");
  expect(JSON.parse(window.localStorage.getItem(SIDEBAR_APPS_KEY)!)).toEqual({ order: ["crm", "notes"], pinned: ["crm"] });
  expect(JSON.parse(window.localStorage.getItem(SIDEBAR_EXPANDED_KEY)!)).toEqual(["inbox"]);
  window.localStorage.setItem(SIDEBAR_APPS_KEY, JSON.stringify({ order: ["crm", "retired", "crm"], pinned: "x" }));
  expect(readLocalLayout()).toEqual({ mode: "rail", order: ["crm"], expanded: ["inbox"] });
  window.localStorage.clear();
});

function SyncProbe({ userId, initial }: { userId: string; initial: Preferences }) {
  const preferences = usePreferences(userId, initial);
  useSidebarSync({ userId, loaded: preferences.loaded, server: preferences.preferences.sidebar ?? null, save: preferences.setSidebar });
  useEffect(() => { (window as unknown as { probe: typeof preferences }).probe = preferences; });
  return <p data-revision={preferences.preferences.revision} data-modules={preferences.preferences.disabledModules.join(",")} />;
}
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("sign-in applies the server's layout here; a change here is sent once, debounced", async () => {
  window.localStorage.clear();
  const api = quietApi({ "PUT /preferences": (call) => ({ preferences: { ...(call.body as object), revision: 2, updatedAt: "2026-11-15T00:00:00.000Z" } }) });
  const view = await render(<SyncProbe userId="u1" initial={{ disabledModules: [], revision: 1, updatedAt: null, sidebar: { mode: "rail", pinned: ["crm"], order: ["crm"] } }} />);
  expect(readLocalLayout()).toEqual({ mode: "rail", pinned: ["crm"], order: ["crm"] });
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  // Two quick changes: one PUT, with the latest layout and the revision last read.
  await act(async () => { writeLocalLayout({ order: ["notes", "crm"], pinned: ["crm"] }, "local"); });
  await act(async () => { writeLocalLayout({ order: ["tasks", "notes", "crm"], pinned: ["crm"] }, "local"); });
  expect(window.localStorage.getItem(SIDEBAR_DIRTY_KEY)).toBe("u1");
  await wait(SIDEBAR_SAVE_DELAY_MS + 100);
  const puts = api.calls.filter((call) => call.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(puts[0]!.body).toEqual({ disabledModules: [], revision: 1, sidebar: { mode: "rail", order: ["tasks", "notes", "crm"], pinned: ["crm"] } });
  await view.waitFor(() => view.container.querySelector('[data-revision="2"]'));
  // The server holds it now: nothing is pending here.
  expect(window.localStorage.getItem(SIDEBAR_DIRTY_KEY)).toBeNull();
  window.localStorage.clear();
});

test("a pending change from before sign-in wins over the server's older layout and is sent", async () => {
  window.localStorage.clear();
  window.localStorage.setItem(SIDEBAR_APPS_KEY, JSON.stringify({ order: ["goals"], pinned: ["goals"] }));
  window.localStorage.setItem(SIDEBAR_DIRTY_KEY, "u2");
  const api = quietApi({ "PUT /preferences": (call) => ({ preferences: { ...(call.body as object), revision: 6, updatedAt: "x" } }) });
  await render(<SyncProbe userId="u2" initial={{ disabledModules: [], revision: 5, updatedAt: null, sidebar: { pinned: ["notes"] } }} />);
  await wait(SIDEBAR_SAVE_DELAY_MS + 100);
  expect(readLocalLayout()).toEqual({ order: ["goals"], pinned: ["goals"] });
  expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ disabledModules: [], revision: 5, sidebar: { order: ["goals"], pinned: ["goals"] } });
  window.localStorage.clear();
});

test("a revision conflict on a layout-only save keeps the other device's modules and resends the layout on its revision", async () => {
  window.localStorage.clear();
  let puts = 0;
  const api = quietApi({
    "PUT /preferences": (call) => {
      puts += 1;
      const body = call.body as { revision: number; disabledModules: string[]; sidebar?: object };
      if (body.revision === 3) return reply(409, { code: "PREFERENCES_CHANGED", error: "changed", preferences: { disabledModules: ["calendar"], revision: 4, updatedAt: "x", sidebar: { pinned: ["files"] } } });
      return { preferences: { ...body, revision: body.revision + 1, updatedAt: "y" } };
    }
  });
  const view = await render(<SyncProbe userId="u3" initial={{ disabledModules: [], revision: 3, updatedAt: null }} />);
  await act(async () => { writeLocalLayout({ order: ["crm"], pinned: ["crm"] }, "local"); });
  await wait(SIDEBAR_SAVE_DELAY_MS + 100);
  await view.waitFor(() => view.container.querySelector('[data-revision="5"]'));
  expect(puts).toBe(2);
  const sent = api.calls.filter((call) => call.method === "PUT").map((call) => call.body);
  expect(sent[1]).toEqual({ disabledModules: ["calendar"], revision: 4, sidebar: { order: ["crm"], pinned: ["crm"] } });
  expect(view.container.querySelector("p")!.getAttribute("data-modules")).toBe("calendar");
  expect(readLocalLayout()).toEqual({ order: ["crm"], pinned: ["crm"] });
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------------------------
// The palette (D1293).

const entriesFor = (role: Role, disabled: string[] = [], extra: Partial<Parameters<typeof paletteEntries>[0]> = {}) => {
  const tree = buildNavTree({ disabledModules: disabled as never, features: role === "guest" ? guestFeatures : features, role, active: "home" });
  return { tree, entries: paletteEntries({ tree, searchNotes: tree.notesSearch, quickActions: visibleQuickActions(disabled, role), moduleLabels: Object.fromEntries(MODULES.map((module) => [module.id, module.label])), canCustomize: true, canToggleSidebar: true, ...extra }) };
};
const labelOf = (entry: PaletteEntry) => [entry.context, entry.label].filter(Boolean).join(" › ");

test("nothing typed: recent items (six at most), quick actions, apps, then commands; sections wait for a query", () => {
  const boards = Array.from({ length: 5 }, (_, index) => ({ id: `b${index}`, name: `Board ${index}`, href: `/tasks/b${index}` }));
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "home", recents: { tasks: boards } });
  const entries = paletteEntries({ tree, searchNotes: true, quickActions: visibleQuickActions([], "member"), recentNotes: [{ id: "n1", name: "Launch plan", href: "/notes/n1" }, { id: "n2", name: "Hiring", href: "/notes/n2" }], canCustomize: true });
  const groups = filterPalette(entries, "", true);
  expect(groups.map((group) => group.label)).toEqual(["Recent", "Quick actions", "Apps", "Commands"]);
  expect(groups[0]!.entries.map(labelOf)).toEqual(["Tasks › Board 0", "Tasks › Board 1", "Tasks › Board 2", "Tasks › Board 3", "Tasks › Board 4", "Notes › Launch plan"]);
  expect(groups[1]!.entries.map((entry) => entry.label)).toContain("Start timer");
  const apps = groups[2]!.entries.map((entry) => entry.label);
  expect(apps.slice(0, 3)).toEqual(["Home", "Inbox", "Notifications"]);
  expect(apps).toContain("Contacts");
  expect(apps).not.toContain("Insights");
  expect(groups[3]!.entries.map((entry) => entry.label)).toEqual(["Keyboard shortcuts", "Customize sidebar"]);
  // Enter with nothing typed opens the newest recent item; a query finds the seventh one too.
  expect(flatPalette(groups)[0]!.id).toBe("nav:tasks:recent:b0");
  expect(flatPalette(filterPalette(entries, "hiring", true)).map(labelOf)).toContain("Notes › Hiring");
  // A query keeps relevance order: apps lead when an app ranks first.
  expect(filterPalette(entries, "ins", true)[0]!.label).toBe("Apps");
});

test("\"ins\" finds the Insights sections first, by app; 'Search notes for' ends the list", () => {
  const { entries } = entriesFor("member");
  const groups = filterPalette(entries, "ins", true);
  expect(groups[0]!.label).toBe("Apps");
  const top = groups[0]!.entries.slice(0, 6).map(labelOf);
  for (const name of ["Contacts › Insights", "Forms › Insights", "Goals › Insights"]) expect(top).toContain(name);
  expect(groups.at(-1)!.entries.map((entry) => entry.label)).toEqual(["Search notes for “ins”"]);
  // Narrowing by app: every word must match.
  expect(flatPalette(filterPalette(entries, "con ins", true)).map(labelOf)[0]).toBe("Contacts › Insights");
  // Without Notes' search there is no fallback.
  expect(filterPalette(entries, "ins", false).some((group) => group.id === "search")).toBe(false);
});

test("the palette offers what the sidebar does for the role: guests and viewers get no gated items", () => {
  const guest = entriesFor("guest", visibleQuickActions([], "guest").length ? [] : []);
  const guestLabels = guest.entries.map(labelOf);
  for (const hidden of ["Vault", "Chat", "Reports", "Contacts", "Bookings", "Inbox", "Time"]) expect(guestLabels).not.toContain(hidden);
  expect(guestLabels.some((label) => label.startsWith("Contacts ›") || label.startsWith("Bookings ›") || label.startsWith("Inbox ›"))).toBe(false);
  // Guests and viewers do not get the quick actions hidden for them.
  for (const action of ["New poll", "New contact", "Copy booking link", "Check in on a goal"]) expect(guestLabels.join("|")).not.toContain(action);
  const viewer = entriesFor("viewer").entries.map((entry) => entry.label);
  expect(viewer).not.toContain("Start timer");
  expect(viewer).not.toContain("New contact");
  // Modules turned off are not offered either, nor their sections and quick actions.
  const off = entriesFor("member", ["crm", "time"]).entries.map(labelOf);
  expect(off.some((label) => label === "Contacts" || label.startsWith("Contacts ›") || label === "Log a call" || label === "Start timer")).toBe(false);
});

test("closer matches rank first: a run beats scattered letters, a word start beats a middle", () => {
  expect(fuzzyWordScore("ins", "contacts › insights")).toBeGreaterThan(fuzzyWordScore("ins", "settings"));
  expect(fuzzyWordScore("xyz", "settings")).toBe(0);
  // Letters scattered inside words are no match; runs that start words are ("cin": Contacts › INsights).
  expect(fuzzyWordScore("ins", "collections")).toBe(0);
  expect(fuzzyWordScore("ins", "inbox › history")).toBe(0);
  expect(fuzzyWordScore("cin", "contacts › insights")).toBeGreaterThan(0);
  // In the app on screen, equal matches rank first.
  const here = entriesFor("member").entries.map((entry) => entry.label === "Insights" && entry.context === "Goals" ? { ...entry, here: true } : entry);
  expect(labelOf(flatPalette(filterPalette(here, "ins", true))[0]!)).toBe("Goals › Insights");
  expect(paletteScore({ label: "Deals", context: "Contacts" }, "deals")).toBeGreaterThan(paletteScore({ label: "Contacts" }, "deals") || 0);
  expect(paletteScore({ label: "Timesheet", context: "Time" }, "café")).toBe(0);
  expect(paletteScore({ label: "Café notes" }, "cafe")).toBeGreaterThan(0);
});

test("the palette is a modal combobox: arrows move the active option, Enter runs it, Escape closes", async () => {
  const { entries } = entriesFor("member");
  const ran: string[] = [];
  let closed = 0;
  const view = await render(<CommandPalette entries={entries} searchNotes onRun={(entry) => ran.push(labelOf(entry))} onClose={() => { closed += 1; }} initialQuery="deals" />);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const input = dialog.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  expect(document.activeElement).toBe(input);
  const listbox = dialog.querySelector('[role="listbox"]')!;
  expect(input.getAttribute("aria-controls")).toBe(listbox.id);
  const active = () => document.getElementById(input.getAttribute("aria-activedescendant")!)!;
  expect(active().getAttribute("aria-selected")).toBe("true");
  expect(active().textContent).toContain("Deals");
  await key(input, { key: "ArrowDown" });
  expect(active().textContent).not.toContain("Contacts › Deals");
  await key(input, { key: "ArrowUp" });
  await key(input, { key: "ArrowUp" });
  // Up from the first wraps to the last: the notes search.
  expect(active().textContent).toContain("Search notes for “deals”");
  // Tab stays in the dialog.
  await key(input, { key: "Tab" });
  expect(document.activeElement).toBe(input);
  // The pointer selects as the keys do.
  const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
  await act(async () => { options[0]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); });
  expect(active()).toBe(options[0]!);
  await key(input, { key: "Enter" });
  expect(ran).toEqual(["Contacts › Deals"]);
  await key(input, { key: "Escape" });
  expect(closed).toBe(1);
  // Groups are labelled.
  expect([...listbox.querySelectorAll('[role="group"]')].map((group) => document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent)).toContain("Apps");
  void view;
});

test("nothing matches: says so, and Enter does nothing", async () => {
  const { entries } = entriesFor("member");
  const ran: string[] = [];
  await render(<CommandPalette entries={entries} searchNotes={false} onRun={(entry) => ran.push(entry.id)} onClose={noop} initialQuery="zzqx" />);
  expect(document.querySelector(".palette-empty")!.textContent).toContain("zzqx");
  await key(document.querySelector('input[role="combobox"]')!, { key: "Enter" });
  expect(ran).toEqual([]);
});

const frameTree = (active: Parameters<typeof buildNavTree>[0]["active"] = "tasks") => buildNavTree({ disabledModules: [], features, role: "member", active });

test("⌘K opens the palette anywhere in the frame; Enter goes through the leave guards; Search opens it too", async () => {
  quietApi();
  const steps: string[] = [];
  let release: (() => void) | null = null;
  const view = await render(<AppFrame tree={frameTree()} displayName="Ada" onNavigate={(item: NavItem) => steps.push(`open ${item.id}`)} onAccount={noop} onSignOut={noop}
    guard={(leave) => { steps.push("app guard"); release = leave; }} palette={{ onOpenPath: (href) => steps.push(`path ${href}`), onSearchNotes: (query) => steps.push(`search ${query}`) }}>
    <main className="app-page"><input aria-label="Page field" /></main>
  </AppFrame>);
  // From inside a text field too.
  const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Page field"]')!;
  field.focus();
  await key(field, { key: "k", metaKey: true });
  const input = await view.waitFor(() => document.querySelector<HTMLInputElement>('.palette input[role="combobox"]'));
  await type(input, "contacts deals");
  await key(input, { key: "Enter" });
  expect(document.querySelector(".palette")).toBeNull();
  expect(steps).toEqual(["app guard"]);
  (release as unknown as () => void)();
  expect(steps).toEqual(["app guard", "open crm:deals"]);
  // The sidebar's Search row opens it as well; ⌘K again closes it and focus returns.
  const search = view.container.querySelector<HTMLButtonElement>(".app-sidebar-search")!;
  expect(search.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+K$/);
  await view.click(search);
  expect(document.querySelector(".palette")).not.toBeNull();
  await key(window, { key: "k", ctrlKey: true });
  expect(document.querySelector(".palette")).toBeNull();
  // "Search notes for …" opens Notes' search through the guards too.
  await key(window, { key: "k", ctrlKey: true });
  await type(document.querySelector<HTMLInputElement>('.palette input')!, "budget");
  const options = [...document.querySelectorAll<HTMLElement>('.palette [role="option"]')];
  await view.click(options.find((option) => option.textContent?.includes("Search notes for"))!);
  (release as unknown as () => void)();
  expect(steps.at(-1)).toBe("search budget");
});

test("\"?\" opens the shortcut sheet (not while typing); it lists the global keys and the module's own", async () => {
  quietApi();
  const crm = (await import("../src/workspaceModules")).workspaceModule("crm")!;
  const view = await render(<AppFrame tree={frameTree("crm")} displayName="Ada" onNavigate={noop} onAccount={noop} onSignOut={noop}
    shortcuts={{ module: { label: crm.label, shortcuts: crm.shortcuts }, time: true }}>
    <main className="app-page"><input aria-label="Page field" /></main>
  </AppFrame>);
  const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Page field"]')!;
  await key(field, { key: "?" });
  expect(document.querySelector(".shortcut-sheet")).toBeNull();
  await key(document.body, { key: "?" });
  const sheet = await view.waitFor(() => document.querySelector<HTMLElement>(".shortcut-sheet"));
  expect(sheet.getAttribute("role")).toBe("dialog");
  const text = sheet.textContent ?? "";
  for (const line of ["Go to an app, section, or action", "Collapse or expand the sidebar", "Show these shortcuts", "Start or stop the timer", "Contacts", "Log an interaction on the open record"]) expect(text).toContain(line);
  // The account menu reaches it too.
  await key(sheet, { key: "Escape" });
  expect(document.querySelector(".shortcut-sheet")).toBeNull();
  await view.click(view.container.querySelector<HTMLButtonElement>(".app-sidebar-account-button")!);
  await view.click(view.button("Keyboard shortcuts")!);
  expect(document.querySelector(".shortcut-sheet")).not.toBeNull();
});

test("shortcut rows: the platform's keys, each key its own <kbd>", () => {
  const mac = shortcutGroups({ mac: true, time: true, module: { label: "Time", shortcuts: [{ keys: "Alt+T", label: "Start or stop the timer" }] } });
  expect(mac[0]!.rows.map((row) => row.keys)).toEqual(["⌘K", "⌘\\", "?", "⌥T"]);
  expect(mac.at(-1)).toEqual({ id: "module", label: "Time", rows: [{ keys: "⌥T", label: "Start or stop the timer" }] });
  const other = shortcutGroups({ mac: false });
  expect(other[0]!.rows.map((row) => row.keys)).toEqual(["Ctrl+K", "Ctrl+\\", "?"]);
  expect(other.map((group) => group.id)).toEqual(["everywhere", "page"]);
  expect(shortcutKeys("j / k")).toEqual([{ key: "j" }, { text: "/" }, { key: "k" }]);
  expect(shortcutKeys("/")).toEqual([{ key: "/" }]);
});

test("Customize sidebar: arrows reorder within a group, pin moves to Pinned, Show is Settings → Modules", async () => {
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "home" });
  // Given in any order: the sheet shows them A–Z (D1305), Pinned first.
  const apps = tree.apps.filter((item) => ["tasks", "notes", "files", "collections"].includes(item.id)).reverse().map((item) => ({ id: item.id, label: item.label, icon: item.icon, shown: item.id !== "collections" }));
  const layouts: unknown[] = [];
  const shownCalls: Array<[string, boolean]> = [];
  const view = await render(<CustomizeSidebar apps={apps} layout={{ pinned: ["files"] }} onLayout={(layout) => layouts.push(layout)} onShown={(id, shown) => shownCalls.push([id, shown])} onClose={noop} />);
  const sheet = document.querySelector<HTMLElement>(".customize-sheet")!;
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  const rows = () => [...sheet.querySelectorAll<HTMLElement>(".customize-row")].map((row) => row.dataset.app);
  expect(rows()).toEqual(["files", "collections", "notes", "tasks"]);
  expect(view.button("Reset to A–Z")!.disabled).toBe(true);
  expect(sheet.querySelector<HTMLButtonElement>('[aria-label="Move Files up"]')!.disabled).toBe(true);
  expect(sheet.querySelector<HTMLButtonElement>('[aria-label="Move Collections up"]')!.disabled).toBe(true);
  await view.click(sheet.querySelector('[aria-label="Move Notes down"]')!);
  expect(arrangeApps(["files", "notes", "tasks", "collections"], layouts.at(-1) as never, (id) => id)).toEqual({ pinned: ["files"], rest: ["collections", "tasks", "notes"] });
  const pin = sheet.querySelector<HTMLButtonElement>('[aria-label="Pin Tasks"]')!;
  expect(pin.getAttribute("aria-pressed")).toBe("false");
  await view.click(pin);
  expect((layouts.at(-1) as { pinned: string[] }).pinned).toEqual(["files", "tasks"]);
  expect(sheet.querySelector<HTMLInputElement>('[aria-label="Show Collections"]')!.checked).toBe(false);
  await view.click(sheet.querySelector('[aria-label="Show Collections"]')!);
  expect(shownCalls).toEqual([["collections", true]]);
  await view.click(view.button("Reset order and pins")!);
  expect(layouts.at(-1)).toEqual({ order: [], pinned: [] });
  // Reset to A–Z (D1305): with a custom order it is offered, and it keeps the pins.
  const custom = { order: ["tasks", "files", "notes", "collections"], pinned: ["files"] } as never;
  await view.rerender(<CustomizeSidebar apps={apps} layout={custom} onLayout={(layout) => layouts.push(layout)} onShown={noop} onClose={noop} />);
  expect(rows()).toEqual(["files", "tasks", "notes", "collections"]);
  await view.click(view.button("Reset to A–Z")!);
  const reset = layouts.at(-1) as { order: string[]; pinned: string[] };
  expect(reset.pinned).toEqual(["files"]);
  expect(arrangeApps(["files", "notes", "tasks", "collections"], reset as never, (id) => id)).toEqual({ pinned: ["files"], rest: ["collections", "notes", "tasks"] });
});

test("the sidebar shows Pinned above Apps, Apps' ⋯ opens Customize, and a drop reorders through the layout", async () => {
  quietApi();
  window.localStorage.clear();
  const layout = { order: [], pinned: ["calendar"] } as { order: never[]; pinned: "calendar"[] };
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "home", layout });
  const view = await render(<AppFrame tree={tree} displayName="Ada" onNavigate={noop} onAccount={noop} onSignOut={noop} layout={layout}
    customize={{ apps: [...tree.pinned, ...tree.apps].map((item) => ({ id: item.id, label: item.label, icon: item.icon, shown: true })), onShown: noop }}>
    <main className="app-page" />
  </AppFrame>);
  const pinnedList = view.container.querySelector('ul[aria-labelledby="app-sidebar-pinned"]')!;
  expect([...pinnedList.querySelectorAll(":scope > li > a, :scope > li .app-sidebar-row > a")].map((link) => link.getAttribute("href"))).toEqual(["/calendar"]);
  await view.click(view.container.querySelector('button[aria-label="Customize sidebar"]')!);
  expect(document.querySelector(".customize-sheet")).not.toBeNull();
  await key(document.querySelector(".customize-sheet")!, { key: "Escape" });
  // Drag Contacts onto the top half of Notes: it lands before Notes, unpinned.
  const row = (href: string) => view.container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!.closest("li")!;
  const data = new Map<string, string>();
  const transfer = { types: [] as string[], setData: (format: string, value: string) => { data.set(format, value); transfer.types = [...data.keys()]; }, getData: (format: string) => data.get(format) ?? "", effectAllowed: "", dropEffect: "" };
  const drag = (type: string, target: Element, clientY = 0) => { const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent; Object.assign(event, { dataTransfer: transfer, clientY }); target.dispatchEvent(event); };
  await act(async () => { drag("dragstart", row("/contacts").querySelector("a")!); });
  await act(async () => { drag("dragover", row("/notes"), -1000); });
  await act(async () => { drag("drop", row("/notes"), -1000); });
  const saved = JSON.parse(window.localStorage.getItem(SIDEBAR_APPS_KEY)!) as { order: string[]; pinned: string[] };
  expect(saved.pinned).toEqual(["calendar"]);
  expect(saved.order.indexOf("crm")).toBe(saved.order.indexOf("notes") - 1);
  window.localStorage.clear();
});
