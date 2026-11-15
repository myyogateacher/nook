import { expect, test } from "bun:test";
import { Archive } from "lucide-react";
import "../src/workspaceModules";
import { installDom, mockApi, render } from "./support/dom";
import { buildNavTree, TREE_APPS } from "../src/shell/navModel";
import { AppFrame } from "../src/shell/AppFrame";
import { ShellMenuButton, ShellSidebarPortal } from "../src/shell/shellContext";
import { SidebarFolderTree } from "../src/shell/SidebarFolderTree";
import { closedFoldersKey, countByFolder, FOLDER_INDENT_CAP, folderAncestors, folderForest, readClosedFolders, visibleFolders, writeClosedFolders } from "../src/shell/folderTree";
import { hubEntries, hubGroups } from "../src/settings/hubModel";
import { ReportFolderNav } from "../src/reports/ReportFolderNav";
import { ModuleHome } from "../src/ui/ModuleHome";
import type { ReportFolderTree } from "../shared/reports";

/**
 * Phase 3 of the left navigation (docs/plan/LEFT_NAV.md §4, D1287–D1291): the app on screen draws its
 * own tree into the sidebar (Notes' and Files' folders, Reports' nav, the Settings hub's sections, a
 * standup's views). The folder tree's model, which apps carry a tree, the Settings groups per role,
 * and the slot itself (expanded, rail, drawer, the Settings view).
 */

installDom("http://nook.test/notes");

type F = { id: string; parent_id: string | null; name: string };
const f = (id: string, parent_id: string | null = null): F => ({ id, parent_id, name: id });
const ids = (rows: Array<{ folder: F }>) => rows.map((row) => row.folder.id);

test("folders nest by parent in the order given; a folder whose parent is not listed sits at the top", () => {
  const folders = [f("eng"), f("design"), f("platform", "eng"), f("api", "platform"), f("mobile", "eng"), f("shared-sub", "someone-elses")];
  const forest = folderForest(folders);
  expect(forest.map((node) => node.folder.id)).toEqual(["eng", "design", "shared-sub"]);
  expect(forest[0]!.children.map((node) => node.folder.id)).toEqual(["platform", "mobile"]);
  expect(forest[0]!.children[0]!.children[0]).toMatchObject({ depth: 2, folder: { id: "api" } });
  expect(visibleFolders(forest, new Set(), null, folders).map((row) => [row.folder.id, row.depth])).toEqual([["eng", 0], ["platform", 1], ["api", 2], ["mobile", 1], ["design", 0], ["shared-sub", 0]]);
});

test("a cycle or a folder that is its own parent never loops and never vanishes", () => {
  const folders = [f("a", "b"), f("b", "a"), f("self", "self"), f("c")];
  const all = visibleFolders(folderForest(folders), new Set(), null, folders);
  expect(ids(all).sort()).toEqual(["a", "b", "c", "self"]);
  expect(folderAncestors(folders, "a").length).toBeLessThanOrEqual(2);
});

test("closed folders hide their subfolders, except the folders above the one on screen; indentation is capped", () => {
  const deep = [f("l0"), f("l1", "l0"), f("l2", "l1"), f("l3", "l2"), f("l4", "l3"), f("l5", "l4"), f("x")];
  const forest = folderForest(deep);
  expect(ids(visibleFolders(forest, new Set(["l1"]), null, deep))).toEqual(["l0", "l1", "x"]);
  // On screen: l5 → l0…l4 stay open whatever was closed.
  const shown = visibleFolders(forest, new Set(["l1", "l3"]), "l5", deep);
  expect(ids(shown)).toEqual(["l0", "l1", "l2", "l3", "l4", "l5", "x"]);
  expect(shown.find((row) => row.folder.id === "l5")).toMatchObject({ depth: 5, indent: FOLDER_INDENT_CAP, hasChildren: false });
  expect(shown.find((row) => row.folder.id === "l1")).toMatchObject({ hasChildren: true, open: true });
  expect(folderAncestors(deep, "l3")).toEqual(["l2", "l1", "l0"]);
});

test("counts are per folder; the closed folders are kept per app and anything odd stored there is ignored", () => {
  expect(countByFolder([{ folder_id: "a" }, { folder_id: "a" }, { folder_id: null }, { folder_id: "b" }])).toEqual(new Map([["a", 2], ["b", 1]]));
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  expect(readClosedFolders(storage, "notes")).toEqual([]);
  writeClosedFolders(storage, "notes", ["a", "b"]);
  expect(store.get(closedFoldersKey("notes"))).toBe('["a","b"]');
  expect(readClosedFolders(storage, "files")).toEqual([]);
  store.set(closedFoldersKey("files"), '{"no":1}');
  expect(readClosedFolders(storage, "files")).toEqual([]);
  store.set(closedFoldersKey("files"), '["ok", 3, "", null]');
  expect(readClosedFolders(storage, "files")).toEqual(["ok"]);
  expect(readClosedFolders({ getItem: () => { throw new Error("blocked"); } }, "notes")).toEqual([]);
});

const features = { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true };
const tree = (active: Parameters<typeof buildNavTree>[0]["active"], role: "admin" | "member" | "viewer" | "guest" = "member") => buildNavTree({ disabledModules: [], features, role, active });

test("Notes, Files, and Reports carry a tree only while on screen; other apps never", () => {
  expect(TREE_APPS).toEqual(["notes", "files", "reports"]);
  for (const app of TREE_APPS) {
    const nav = tree(app);
    expect(nav.apps.find((item) => item.id === app)?.tree).toBe(true);
    expect(nav.apps.filter((item) => item.tree).map((item) => item.id)).toEqual([app]);
  }
  expect(tree("calendar").apps.some((item) => item.tree)).toBe(false);
  expect(tree("settings").apps.some((item) => item.tree)).toBe(false);
});

test("the Settings tree's groups per role: admins get Team's sections, guests only their account, 2FA setup only Security", () => {
  const labels = (role: Parameters<typeof hubEntries>[0], options: Parameters<typeof hubEntries>[1]) => hubGroups(hubEntries(role, options)).map((group) => `${group.label}: ${group.items.map((item) => item.label).join(", ")}`);
  const admin = labels("admin", { teamModuleEnabled: true, binModuleEnabled: true, binCount: 3 });
  expect(admin.map((line) => line.split(":")[0])).toEqual(["Account", "Workspace", "Team"]);
  expect(admin[2]).toContain("Members, Invites, Groups");
  const bin = hubGroups(hubEntries("admin", { teamModuleEnabled: true, binCount: 3 })).find((group) => group.id === "workspace")!.items.find((item) => item.id === "bin");
  expect(bin?.badge).toBe(3);
  const member = labels("member", { teamModuleEnabled: true });
  expect(member[member.length - 1]).toBe("Team: Members");
  expect(member[0]).not.toContain("Report data sources");
  const guest = labels("guest", { teamModuleEnabled: true });
  expect(guest.map((line) => line.split(":")[0])).toEqual(["Account"]);
  expect(guest[0]).not.toContain("My access");
  expect(guest[0]).not.toContain("Agents");
  expect(labels("member", { teamModuleEnabled: false })[1] ?? "").not.toContain("Team");
  expect(labels("admin", { teamModuleEnabled: true, setupRequired: true })).toEqual(["Account: Security"]);
});

const quietApi = () => mockApi({ "GET /inbox/count": () => ({ pending: 0 }), "GET /notifications?unread=1&limit=1": () => ({ items: [], unreadCount: 0 }) });
const noop = () => undefined;
const folders = [f("eng"), f("platform", "eng"), f("ops")];

function NotesTree({ current, onSelect }: { current: string | null; onSelect: (id: string) => void }) {
  return <ShellSidebarPortal><SidebarFolderTree app="notes" label="Note folders"
    entries={[{ id: "all", label: "All notes", icon: Archive, href: "/notes", count: 2, current: current === null, onSelect: () => onSelect("all") }]}
    groups={[{ id: "folders", heading: "Folders", folders, onNew: noop }]} current={current} hrefFor={(folder) => `/notes/folder/${folder.id}`}
    onSelect={(folder) => onSelect(folder.id)} name={(folder) => folder.name} count={() => 1}
    action={(folder) => <button type="button" className="app-sidebar-tree-action" aria-label={`Share ${folder.name}`} />} /></ShellSidebarPortal>;
}

test("the app's tree draws under its row: real links, its own handler, the app row holds the page", async () => {
  quietApi();
  window.localStorage.removeItem("nook.sidebar");
  window.localStorage.removeItem(closedFoldersKey("notes"));
  const picked: string[] = [];
  const opened: string[] = [];
  const view = await render(<AppFrame tree={tree("notes")} displayName="Ada" onNavigate={(item) => opened.push(item.id)} onSearch={noop} onAccount={noop} onSignOut={noop}>
    <main className="app-page"><NotesTree current="platform" onSelect={(id) => picked.push(id)} /></main>
  </AppFrame>);
  const nav = view.container.querySelector<HTMLElement>('nav[aria-label="Workspace"]')!;
  const tree_ = nav.querySelector<HTMLElement>('.app-sidebar-slot nav[aria-label="Note folders"]')!;
  expect(tree_).not.toBeNull();
  // Under Notes' row, after its chevron (D1284): one group.
  expect(tree_.closest(".app-sidebar-app")?.querySelector(".app-sidebar-link")?.getAttribute("href")).toBe("/notes");
  const platform = tree_.querySelector<HTMLAnchorElement>('a[href="/notes/folder/platform"]')!;
  expect(platform.getAttribute("aria-current")).toBe("page");
  expect(tree_.querySelectorAll(".app-sidebar-tree-action").length).toBe(3);
  expect(nav.querySelector('.app-sidebar-app .app-sidebar-link[href="/notes"]')?.getAttribute("aria-current")).toBe("true");
  expect(nav.querySelectorAll('[aria-current="page"]').length).toBe(1);
  await view.click(tree_.querySelector<HTMLAnchorElement>('a[href="/notes/folder/ops"]')!);
  expect(picked).toEqual(["ops"]);
  expect(opened).toEqual([]);
  // A chevron closes a folder's subfolders and the choice is kept.
  const toggle = tree_.querySelector<HTMLButtonElement>('button[aria-label="Hide subfolders of eng"]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await view.click(toggle);
  expect(tree_.querySelector('a[href="/notes/folder/platform"]')).toBeNull();
  expect(window.localStorage.getItem(closedFoldersKey("notes"))).toBe('["eng"]');
  window.localStorage.removeItem(closedFoldersKey("notes"));
});

test("in the rail the tree waits for the app's flyout; on a phone the drawer carries it and a pick closes the drawer", async () => {
  quietApi();
  window.localStorage.setItem("nook.sidebar", "rail");
  const rail = await render(<AppFrame tree={tree("notes")} displayName="Ada" onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop}>
    <main className="app-page"><NotesTree current={null} onSelect={noop} /></main>
  </AppFrame>);
  expect(rail.container.querySelector(".app-frame")?.getAttribute("data-sidebar")).toBe("rail");
  expect(rail.container.querySelector('nav[aria-label="Note folders"]')).toBeNull();
  window.localStorage.removeItem("nook.sidebar");

  const width = window.innerWidth;
  (window as unknown as { innerWidth: number }).innerWidth = 390;
  try {
    const picked: string[] = [];
    const view = await render(<AppFrame tree={tree("notes")} displayName="Ada" onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop}>
      <main className="app-page"><ShellMenuButton /><NotesTree current={null} onSelect={(id) => picked.push(id)} /></main>
    </AppFrame>);
    expect(view.container.querySelector('nav[aria-label="Note folders"]')).toBeNull();
    await view.click(view.container.querySelector<HTMLButtonElement>(".shell-menu-button")!);
    const drawer = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    // The drawer's rows are narrow: no per-row Share there (the Folders panel keeps it).
    expect(drawer.querySelector("nav[aria-label=\"Note folders\"] a")).not.toBeNull();
    expect(drawer.querySelectorAll(".app-sidebar-tree-action").length).toBe(0);
    await view.click(drawer.querySelector<HTMLAnchorElement>('nav[aria-label="Note folders"] a[href="/notes/folder/ops"]')!);
    expect(picked).toEqual(["ops"]);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    (window as unknown as { innerWidth: number }).innerWidth = width;
  }
});

test("on a Settings page the list is the Settings tree with Back to apps; the footer's Settings brings it back", async () => {
  quietApi();
  const view = await render(<AppFrame tree={tree("bin")} displayName="Ada" onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop}>
    <main className="app-page"><ShellSidebarPortal><nav aria-label="Settings sections"><a href="/settings/bin" aria-current="page">Bin</a></nav></ShellSidebarPortal></main>
  </AppFrame>);
  const nav = () => view.container.querySelector<HTMLElement>('nav[aria-label="Workspace"]')!;
  expect(nav().querySelector('.app-sidebar-slot nav[aria-label="Settings sections"]')).not.toBeNull();
  expect(nav().querySelector("#app-sidebar-apps")).toBeNull();
  const footer = nav().querySelector<HTMLAnchorElement>('.app-sidebar-foot a[href="/settings"]')!;
  expect(footer.getAttribute("aria-current")).toBe("true");
  await view.click(nav().querySelector<HTMLButtonElement>(".app-sidebar-back")!);
  expect(nav().querySelector("#app-sidebar-apps")).not.toBeNull();
  expect(nav().querySelector('nav[aria-label="Settings sections"]')).toBeNull();
  expect(nav().querySelector('.app-sidebar-foot a[href="/settings"]')?.getAttribute("aria-current")).toBe("page");
  await view.click(nav().querySelector<HTMLAnchorElement>('.app-sidebar-foot a[href="/settings"]')!);
  expect(nav().querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
});

const at = "2026-11-01T00:00:00.000Z";
const reportTree = (): ReportFolderTree => ({
  folders: [
    { id: "f-sales", parentId: null, name: "Sales", position: 0, count: 2, createdAt: at, updatedAt: at },
    { id: "f-emea", parentId: "f-sales", name: "EMEA", position: 0, count: 1, createdAt: at, updatedAt: at }
  ],
  counts: { all: 4, unfiled: 1, shared: 0, favorites: 2 },
  owners: [],
  canCreateFolders: true, canManageFolders: true
});
const folderActions = { rename: noop, newSubfolder: noop, newReportIn: noop, remove: noop, moveTo: noop, place: noop };

test("Reports' nav in the sidebar: every view a real link that still selects through the app; buttons elsewhere", async () => {
  const picked: Array<string | null> = [];
  const view = await render(<ReportFolderNav tree={reportTree()} view="f-emea" onSelect={(next) => picked.push(next)} canWrite dragging={null} onDropReport={noop} onNewFolder={noop} actions={folderActions}
    lists={[]} hrefFor={(next) => next ? `/reports?folder=${next}` : "/reports"} />);
  const links = [...view.container.querySelectorAll<HTMLAnchorElement>("a.reports-nav-link")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/reports", "/reports?folder=favorites", "/reports?folder=unfiled", "/reports?folder=f-sales", "/reports?folder=f-emea", "/reports?folder=shared"]);
  expect(view.container.querySelector('a[aria-current="page"]')?.textContent).toContain("EMEA");
  await view.click(links[0]!);
  await view.click(links[3]!);
  expect(picked).toEqual([null, "f-sales"]);
  const plain = await render(<ReportFolderNav tree={reportTree()} view={null} onSelect={noop} canWrite dragging={null} onDropReport={noop} onNewFolder={noop} actions={folderActions} />);
  expect(plain.container.querySelector("a.reports-nav-link")).toBeNull();
  expect(plain.container.querySelectorAll("button.reports-nav-link").length).toBe(6);
});

test("an open item's views go to the expanded sidebar under its name; the header names the module first", async () => {
  quietApi();
  window.localStorage.removeItem("nook.sidebar");
  const tabs: string[] = [];
  const moved: string[] = [];
  const view = await render(<AppFrame tree={tree("checkins")} displayName="Ada" onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop}>
    <ModuleHome icon={Archive} title="Standups" heading="Daily standup" displayName="Ada" onHome={noop} onSettings={noop} onSignOut={noop}
      tabs={[{ id: "round", label: "Rounds" }, { id: "insights", label: "Insights" }]} activeTab="round" onTab={(id) => tabs.push(id)}
      tabsInSidebar={{ label: "Daily standup", hrefFor: (id) => `/standups/daily/${id}` }}
      parent={{ label: "Standups", href: "/standups", onClick: () => moved.push("up") }}><p>Body</p></ModuleHome>
  </AppFrame>);
  const slot = view.container.querySelector<HTMLElement>(".app-sidebar-slot")!;
  expect(slot.querySelector(".app-sidebar-subheading")?.textContent).toBe("Daily standup");
  expect([...slot.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([["Rounds", "/standups/daily/round", "page"], ["Insights", "/standups/daily/insights", null]]);
  // The page's strip is gone while the sidebar shows them; the app row holds the page.
  expect(view.container.querySelector(".ui-module-views")).toBeNull();
  expect(view.container.querySelector('.app-sidebar-app .app-sidebar-link[aria-current]')?.getAttribute("aria-current")).toBe("true");
  await view.click(slot.querySelectorAll<HTMLAnchorElement>("a")[1]!);
  expect(tabs).toEqual(["insights"]);
  const header = view.container.querySelector<HTMLElement>(".ui-module-header")!;
  const parent = header.querySelector<HTMLAnchorElement>("a.ui-module-parent")!;
  expect(parent.getAttribute("href")).toBe("/standups");
  expect(parent.compareDocumentPosition(header.querySelector("h1")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await view.click(parent);
  expect(moved).toEqual(["up"]);
});
