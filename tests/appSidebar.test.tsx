import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "../src/workspaceModules";
import { installDom, mockApi, render } from "./support/dom";
import { buildNavTree, type NavItem } from "../src/shell/navModel";
import { AppSidebar } from "../src/shell/AppSidebar";
import { AppFrame } from "../src/shell/AppFrame";
import { PageHeader } from "../src/shell/PageHeader";
import { useShellRail } from "../src/shell/shellContext";
import { isSidebarToggleKey, readSidebarPreference, SIDEBAR_STORAGE_KEY, sidebarMode, writeSidebarPreference } from "../src/shell/useSidebarState";

/**
 * The global sidebar and its frame (docs/plan/LEFT_NAV.md §2.1–2.2, D1270–D1273): the three states,
 * the saved choice, ⌘\, the drawer as a modal, and links that route through App's openApp.
 */

installDom("http://nook.test/tasks");

const features = { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true };
const tree = (active: Parameters<typeof buildNavTree>[0]["active"] = "tasks") => buildNavTree({ disabledModules: [], features, role: "member", active });
const noop = () => undefined;
/** The badges' and the timer's requests answer with nothing to show. */
const quietApi = () => mockApi({ "GET /inbox/count": () => ({ pending: 0 }), "GET /notifications?unread=1&limit=1": () => ({ items: [], unreadCount: 0 }) });
const sidebarProps = { displayName: "Ada Lovelace", inboxCount: 0, unreadCount: 0, onNavigate: noop, onSearch: noop, onAccount: noop, onSignOut: noop, onToggle: noop };

test("the mode follows the window until the person chooses; phones always get the drawer", () => {
  expect(sidebarMode(1440, null)).toBe("expanded");
  expect(sidebarMode(1280, null)).toBe("expanded");
  expect(sidebarMode(1279, null)).toBe("rail");
  expect(sidebarMode(761, null)).toBe("rail");
  expect(sidebarMode(760, null)).toBe("drawer");
  expect(sidebarMode(1440, "rail")).toBe("rail");
  expect(sidebarMode(900, "expanded")).toBe("expanded");
  expect(sidebarMode(390, "expanded")).toBe("drawer");
});

test("the choice is stored under nook.sidebar; anything else there is no choice", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  expect(readSidebarPreference(storage)).toBeNull();
  writeSidebarPreference(storage, "rail");
  expect(store.get(SIDEBAR_STORAGE_KEY)).toBe("rail");
  expect(readSidebarPreference(storage)).toBe("rail");
  store.set(SIDEBAR_STORAGE_KEY, "wide");
  expect(readSidebarPreference(storage)).toBeNull();
  expect(readSidebarPreference({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
  expect(readSidebarPreference(null)).toBeNull();
});

test("⌘\\ and Ctrl+\\ toggle; other chords do not", () => {
  const key = (init: Partial<KeyboardEvent>) => ({ key: "\\", code: "Backslash", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
  expect(isSidebarToggleKey(key({ metaKey: true }))).toBe(true);
  expect(isSidebarToggleKey(key({ ctrlKey: true }))).toBe(true);
  expect(isSidebarToggleKey(key({}))).toBe(false);
  expect(isSidebarToggleKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(isSidebarToggleKey(key({ ctrlKey: true, key: "k", code: "KeyK" }))).toBe(false);
});

test("the sidebar is the Workspace nav: the app on screen is the current page, links are real URLs", () => {
  const markup = renderToStaticMarkup(<AppSidebar {...sidebarProps} tree={tree("tasks")} mode="expanded" inboxCount={3} unreadCount={120} />);
  expect(markup).toContain('<nav class="app-sidebar" aria-label="Workspace" data-mode="expanded" id="app-sidebar">');
  expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  // D1284: an app with sections has a disclosure chevron beside its link.
  expect(markup).toMatch(/<a class="app-sidebar-link active has-disclosure" href="\/tasks" aria-current="page">/);
  expect(markup).toContain('href="/contacts"');
  // The collapse button says what it does and which state it is in.
  expect(markup).toContain('aria-expanded="true" aria-controls="app-sidebar" aria-label="Collapse sidebar"');
  // Badges are bounded and named.
  expect(markup).toContain('aria-label="Inbox, 3 pending"');
  expect(markup).toContain('aria-label="Notifications, 100 or more unread"');
  expect(markup).toContain(">99+<");
  // The footer: Settings and the account menu (Sign out lives in it).
  expect(markup).toContain('href="/settings"');
  expect(markup).toContain('aria-label="Account: Ada Lovelace"');
  // No account-row leftovers.
  expect(markup).not.toContain("app-account");
});

test("in the rail the labels stay in each link (its name); the toggle expands", () => {
  const markup = renderToStaticMarkup(<AppSidebar {...sidebarProps} tree={tree("home")} mode="rail" />);
  expect(markup).toContain('data-mode="rail"');
  expect(markup).toContain('<span class="app-sidebar-label">Tasks</span>');
  expect(markup).toContain('aria-expanded="false" aria-controls="app-sidebar" aria-label="Expand sidebar"');
});

test("a plain click routes through onNavigate; a modifier click is left to the browser", async () => {
  quietApi();
  const opened: NavItem[] = [];
  const view = await render(<AppSidebar {...sidebarProps} tree={tree("home")} mode="expanded" onNavigate={(item) => opened.push(item)} />);
  const contacts = view.container.querySelector<HTMLAnchorElement>('a[href="/contacts"]')!;
  await view.click(contacts);
  expect(opened.map((item) => item.section)).toEqual(["crm"]);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  contacts.dispatchEvent(event);
  expect(opened).toHaveLength(1);
});

test("the account menu has Account and Sign out", async () => {
  quietApi();
  let signedOut = 0;
  const view = await render(<AppSidebar {...sidebarProps} tree={tree("home")} mode="expanded" onSignOut={() => { signedOut += 1; }} />);
  const account = view.container.querySelector<HTMLButtonElement>(".app-sidebar-account-button")!;
  expect(account.getAttribute("aria-haspopup")).toBe("menu");
  await view.click(account);
  expect(account.getAttribute("aria-expanded")).toBe("true");
  const items = [...view.container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  expect(items).toEqual(["Account and security", "Sign out"]);
  await view.click(view.button("Sign out")!);
  expect(signedOut).toBe(1);
});

test("the page header is one row: ☰ only inside the frame, the title, actions, the bell", () => {
  const outside = renderToStaticMarkup(<PageHeader title="Tasks" actions={<button>New</button>} />);
  expect(outside).toContain('<header class="app-page-header page-header">');
  expect(outside).toContain('<div class="page-header-title"><strong>Tasks</strong></div>');
  expect(outside).toContain('<div class="page-header-actions"><button>New</button></div>');
  expect(outside).not.toContain("shell-menu-button");
  expect(outside).not.toContain("app-home-button");
});

test("on a phone the frame has no sidebar until ☰ opens the drawer: a modal that Escape closes", async () => {
  quietApi();
  const width = window.innerWidth;
  (window as unknown as { innerWidth: number }).innerWidth = 390;
  try {
    const opened: string[] = [];
    const view = await render(<AppFrame tree={tree("tasks")} displayName="Ada" onNavigate={(item) => opened.push(item.id)} onSearch={noop} onAccount={noop} onSignOut={noop}>
      <main className="app-page"><PageHeader title="Tasks" /></main>
    </AppFrame>);
    expect(view.container.querySelector(".app-frame")?.getAttribute("data-sidebar")).toBe("drawer");
    expect(view.container.querySelector("nav.app-sidebar")).toBeNull();
    const menu = view.container.querySelector<HTMLButtonElement>(".shell-menu-button")!;
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await view.click(menu);
    const drawer = view.container.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
    expect(drawer.getAttribute("aria-label")).toBe("Menu");
    expect(drawer.querySelector('nav[aria-label="Workspace"]')).not.toBeNull();
    // Navigating closes the drawer.
    await view.click(drawer.querySelector<HTMLAnchorElement>('a[href="/calendar"]')!);
    expect(opened).toEqual(["calendar"]);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    // Escape closes it too.
    await view.click(menu);
    const reopened = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    const { act } = await import("react");
    await act(async () => { reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    (window as unknown as { innerWidth: number }).innerWidth = width;
  }
});

test("on a computer the toggle and ⌘\\ switch expanded and rail, and the choice is kept", async () => {
  quietApi();
  window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
  const view = await render(<AppFrame tree={tree("tasks")} displayName="Ada" onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop}><main className="app-page" /></AppFrame>);
  const frame = () => view.container.querySelector(".app-frame")!.getAttribute("data-sidebar");
  expect(frame()).toBe("expanded");
  await view.click(view.container.querySelector<HTMLButtonElement>(".app-sidebar-toggle")!);
  expect(frame()).toBe("rail");
  expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("rail");
  const { act } = await import("react");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Backslash", ctrlKey: true, bubbles: true, cancelable: true })); });
  expect(frame()).toBe("expanded");
  expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("expanded");
  window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
});

test("the frame asks App's guard, then the page's, before it moves", async () => {
  quietApi();
  const steps: string[] = [];
  let release: (() => void) | null = null;
  const view = await render(<AppFrame tree={tree("tasks")} displayName="Ada" onNavigate={(item) => steps.push(`open ${item.id}`)} onSearch={noop} onAccount={noop} onSignOut={noop}
    guard={(leave) => { steps.push("app guard"); release = leave; }}><main className="app-page" /></AppFrame>);
  await view.click(view.container.querySelector<HTMLAnchorElement>('a[href="/calendar"]')!);
  expect(steps).toEqual(["app guard"]);
  (release as unknown as () => void)();
  expect(steps).toEqual(["app guard", "open calendar"]);
});

function FullPageCard({ open }: { open: boolean }) {
  useShellRail(open);
  return <main className="app-page" />;
}

test("a full-page card holds the rail: the toggle says Expand, is unavailable, says why, and ⌘\\ does nothing (D1279)", async () => {
  quietApi();
  window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
  const frame = (open: boolean) => <AppFrame tree={tree("tasks")} displayName="Ada" onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop}><FullPageCard open={open} /></AppFrame>;
  const view = await render(frame(true));
  const mode = () => view.container.querySelector(".app-frame")!.getAttribute("data-sidebar");
  const toggle = () => view.container.querySelector<HTMLButtonElement>(".app-sidebar-toggle")!;
  expect(mode()).toBe("rail");
  expect(toggle().getAttribute("aria-label")).toBe("Expand sidebar");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(toggle().title).toBe("The sidebar stays narrow while a card is open full-page");
  await view.click(toggle());
  const { act } = await import("react");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Backslash", ctrlKey: true, bubbles: true, cancelable: true })); });
  expect(mode()).toBe("rail");
  expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  // Closing the card gives the sidebar back its own state.
  await view.rerender(frame(false));
  expect(mode()).toBe("expanded");
  expect(toggle().getAttribute("aria-label")).toBe("Collapse sidebar");
  expect(toggle().hasAttribute("aria-disabled")).toBe(false);
});

test("16 apps and the footer fit 900 px expanded and 800 px in the rail: 30 and 29 px rows (D1279)", async () => {
  const css = await Bun.file(new URL("../src/shell/sidebar.css", import.meta.url)).text();
  expect(css).toMatch(/\.app-sidebar-link \{ position: relative; min-width: 0; height: 30px;/);
  expect(css).toMatch(/\.app-sidebar\[data-mode="rail"\] \.app-sidebar-link \{ width: 40px; height: 29px;/);
  // Shorter windows still scroll the list rather than the frame.
  expect(css).toMatch(/\.app-sidebar-scroll \{[^}]*overflow-y: auto;/);
});

