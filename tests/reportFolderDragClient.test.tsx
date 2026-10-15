/**
 * K2: report folders dragged in the nav (nest or reorder) and the keyboard and phone alternative (⋯ →
 * Move folder to…, Move up, Move down), rendered with happy-dom; the pure planning helpers (depth limit,
 * own subfolder, insertion index); Undo; and Back/Forward over the Move folder to… sheet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { REPORT_FOLDER_DEPTH, type ReportFolder, type ReportFolderTree } from "../shared/reports";
import { captureToasts, installDom, mockApi, render, type ApiCall, type Rendered } from "./support/dom";

installDom("http://nook.test/reports");

const { ReportsHome } = await import("../src/reports/ReportsHome");
const { RoleContext } = await import("../src/team/roleAccess");
const { popStateClosedDialog, resetHistoryDialogsForTests, whenHistorySettled } = await import("../src/historyDialogs");
const tree = await import("../src/reports/reportFolderTree");
const { act } = await import("react");
afterEach(() => { resetHistoryDialogsForTests(); });

const at = "2026-10-14T00:00:00.000Z";
const FINANCE = "0b8f7c2e-0000-4000-8000-00000000000f";
const GROWTH = "0b8f7c2e-0000-4000-8000-00000000000a";
const QUARTER = "0b8f7c2e-0000-4000-8000-00000000000b";
const DEEP = "0b8f7c2e-0000-4000-8000-00000000000c";
const folder = (id: string, name: string, parentId: string | null, position: number): ReportFolder => ({ id, parentId, name, position, count: 0, createdAt: at, updatedAt: at, createdBy: null });
// Finance (3 levels: Finance / Quarterly / Deep), then Growth.
const FOLDERS = [folder(FINANCE, "Finance", null, 0), folder(GROWTH, "Growth", null, 1), folder(QUARTER, "Quarterly", FINANCE, 0), folder(DEEP, "Deep", QUARTER, 0)];
// Phase 2 (D483): reordering and nesting folders is an admin's; the server says so in the tree.
const folderTree = (): ReportFolderTree => ({ folders: FOLDERS, counts: { all: 0, unfiled: 0, shared: 0, favorites: 0 }, owners: [], canCreateFolders: true, canManageFolders: true });

const routes = (extra: Record<string, (call: ApiCall) => unknown> = {}) => mockApi({
  "GET /reports": () => ({ reports: [], nextCursor: null }),
  "GET /reports/folders": () => folderTree(),
  "GET /reports/datasources": () => ({ datasources: [{ id: "ds-1", name: "Warehouse", database: "analytics" }] }),
  "GET /reports/doc-servers": () => ({ servers: [] }),
  ...extra
});
const noop = () => undefined;
/** The app's popstate handler: dialogs first, else a route change. */
function Host() {
  useEffect(() => {
    const onPop = (event: PopStateEvent) => { popStateClosedDialog(event); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return <RoleContext.Provider value="member">
    <ReportsHome displayName="Me" role="member" onHome={noop} onSettings={noop} onSignOut={noop} onOpen={noop} onOpenDatasources={noop} />
  </RoleContext.Provider>;
}
const navLink = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".reports-sidebar .reports-nav-link")].find((item) => item.querySelector(".reports-nav-name")?.textContent === name)!;
const settle = () => new Promise<void>((resolve) => whenHistorySettled(resolve));

/** A drag event at `clientY` carrying a stand-in DataTransfer. */
function drag(type: string, store: Map<string, string>, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "dataTransfer", { value: {
    get types() { return [...store.keys()]; }, setData: (key: string, value: string) => { store.set(key, value); }, getData: (key: string) => store.get(key) ?? "",
    setDragImage: noop, effectAllowed: "all", dropEffect: "none"
  } });
  return event;
}
/** Every nav row is 40 px tall at y = 0: 0–9 is "before", 10–29 "into", 30–39 "after". */
function sizeRows() {
  for (const row of document.querySelectorAll<HTMLElement>(".reports-nav-link")) row.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: noop }) as DOMRect;
}
async function dragFolder(from: string, to: string, clientY: number, drop = true) {
  const store = new Map<string, string>();
  sizeRows();
  await act(async () => { navLink(from).dispatchEvent(drag("dragstart", store)); });
  expect(store.get(tree.FOLDER_DRAG_TYPE)).toBeTruthy();
  await act(async () => { navLink(to).dispatchEvent(drag("dragover", store, clientY)); });
  const classes = navLink(to).className;
  const note = document.querySelector(".reports-sidebar .reports-nav-drop-note")?.textContent ?? "";
  if (drop) await act(async () => { navLink(to).dispatchEvent(drag("drop", store, clientY)); navLink(from)?.dispatchEvent(drag("dragend", store)); });
  return { classes, note };
}
async function open(extra: Record<string, (call: ApiCall) => unknown> = {}) {
  const api = routes({ ...extra });
  const view = await render(<Host />);
  await view.waitFor(() => navLink("Deep"));
  return { api, view };
}
const { notify } = await import("../src/ui/notify");
/** Success toasts with their action (captureToasts keeps the message only). */
function captureActionToasts() {
  const toasts: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  const saved = notify.success;
  (notify as { success: unknown }).success = (message: string, options?: { action?: { label: string; onClick: () => void } }) => { toasts.push({ message, action: options?.action }); };
  afterEach(() => { (notify as { success: unknown }).success = saved; });
  return toasts;
}
const patches = (api: { calls: ApiCall[] }) => api.calls.filter((call) => call.method === "PATCH");
const patchOk = { [`PATCH /reports/folders/${GROWTH}`]: () => ({ folder: FOLDERS[1] }), [`PATCH /reports/folders/${FINANCE}`]: () => ({ folder: FOLDERS[0] }), [`PATCH /reports/folders/${QUARTER}`]: () => ({ folder: FOLDERS[2] }) };

describe("planning a folder move (pure)", () => {
  test("depth, height, the drop zones, and the insertion index", () => {
    expect(REPORT_FOLDER_DEPTH).toBe(3);
    expect([tree.folderDepth(FOLDERS, null), tree.folderDepth(FOLDERS, FINANCE), tree.folderDepth(FOLDERS, DEEP)]).toEqual([0, 1, 3]);
    expect([tree.folderHeight(FOLDERS, FINANCE), tree.folderHeight(FOLDERS, GROWTH), tree.folderHeight(FOLDERS, QUARTER)]).toEqual([3, 1, 2]);
    expect([5, 20, 35].map((y) => tree.dropZoneAt(y, 40))).toEqual(["before", "into", "after"]);
    expect(tree.planFolderDrop(FOLDERS, GROWTH, FINANCE, "before")).toEqual({ ok: true, place: { parentId: null, position: 0 } });
    expect(tree.planFolderDrop(FOLDERS, GROWTH, FINANCE, "after")).toEqual({ ok: "same" });
    expect(tree.planFolderDrop(FOLDERS, GROWTH, QUARTER, "into")).toEqual({ ok: true, place: { parentId: QUARTER, position: 1 } });
    expect(tree.planFolderDrop(FOLDERS, GROWTH, DEEP, "into")).toEqual({ ok: false, reason: "Folders nest up to 3 levels" });
    expect(tree.planFolderDrop(FOLDERS, FINANCE, GROWTH, "into")).toEqual({ ok: false, reason: "Folders nest up to 3 levels (this one takes 3 with its subfolders)" });
    expect(tree.planFolderDrop(FOLDERS, FINANCE, DEEP, "after")).toEqual({ ok: false, reason: "A folder cannot go inside its own subfolder" });
    expect(tree.planFolderDrop(FOLDERS, QUARTER, GROWTH, "after")).toEqual({ ok: true, place: { parentId: null, position: 2 } });
    expect(tree.planFolderDrop(FOLDERS, FINANCE, FINANCE, "into")).toEqual({ ok: "same" });
    expect([tree.planStep(FOLDERS, FINANCE, -1), tree.planStep(FOLDERS, FINANCE, 1), tree.planStep(FOLDERS, GROWTH, 1)]).toEqual([null, { parentId: null, position: 1 }, null]);
    expect(tree.placeOf(FOLDERS, QUARTER)).toEqual({ parentId: FINANCE, position: 0 });
  });
});

describe("dragging a folder in the nav", () => {
  test("its top edge shows the before line and reorders it, with Undo putting it back", async () => {
    const toasts = captureActionToasts();
    const { api, view } = await open(patchOk);
    const { classes } = await dragFolder("Growth", "Finance", 4);
    expect(classes).toContain("drop-before");
    await view.waitFor(() => patches(api).length === 1);
    expect(patches(api)[0]).toEqual({ method: "PATCH", path: `/reports/folders/${GROWTH}`, body: { parentId: null, position: 0 } });
    const toast = await view.waitFor(() => toasts.find((item) => item.message === "Reordered the folder Growth"));
    await act(async () => { toast.action!.onClick(); });
    await view.waitFor(() => patches(api).length === 2);
    expect(patches(api)[1]!.body).toEqual({ parentId: null, position: 1 });
    expect(navLink("Finance").className).not.toContain("drop-");
  });

  test("its middle nests it (into highlight), at the end of the target's subfolders", async () => {
    const toasts = captureToasts();
    const { api, view } = await open(patchOk);
    const { classes } = await dragFolder("Growth", "Quarterly", 20);
    expect(classes).toContain("drop-target");
    await view.waitFor(() => patches(api).length === 1);
    expect(patches(api)[0]!.body).toEqual({ parentId: QUARTER, position: 1 });
    await view.waitFor(() => toasts.some((item) => item.message === "Moved the folder Growth into Finance / Quarterly"));
  });

  test("a drop past the depth limit or into its own subfolder is refused with the reason, and nothing is sent", async () => {
    const { api } = await open(patchOk);
    const deep = await dragFolder("Finance", "Growth", 20);
    expect(deep.classes).toContain("drop-refused");
    expect(deep.note).toBe("Folders nest up to 3 levels (this one takes 3 with its subfolders)");
    const own = await dragFolder("Finance", "Deep", 35);
    expect(own.classes).toContain("drop-refused");
    expect(own.note).toBe("A folder cannot go inside its own subfolder");
    await act(async () => { await Bun.sleep(20); });
    expect(patches(api)).toEqual([]);
    expect(document.querySelector(".reports-nav-drop-note")).toBeNull();
  });

  test("a report drag still files onto a folder (the two drags never mix)", async () => {
    const { view } = await open();
    const store = new Map<string, string>([[tree.REPORT_DRAG_TYPE, "r"]]);
    sizeRows();
    await act(async () => { navLink("Growth").dispatchEvent(drag("dragover", store, 4)); });
    expect(navLink("Growth").className).not.toContain("drop-before");
    expect(view).toBeTruthy();
  });
});

async function menuItem(view: Rendered, name: string, label: string) {
  const entry = navLink(name).closest("li")!;
  await view.click(entry.querySelector<HTMLButtonElement>(".reports-nav-menu button")!);
  return [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === label)!;
}

describe("⋯ → Move up / Move down / Move folder to…", () => {
  test("Move up is disabled for the first folder; Move down sends the next index", async () => {
    const { api, view } = await open(patchOk);
    expect((await menuItem(view, "Finance", "Move up")).disabled).toBe(true);
    await view.click(navLink("Finance").closest("li")!.querySelector<HTMLButtonElement>(".reports-nav-menu button")!);
    await settle();
    await view.click(await menuItem(view, "Finance", "Move down"));
    await view.waitFor(() => patches(api).length === 1);
    expect(patches(api)[0]).toEqual({ method: "PATCH", path: `/reports/folders/${FINANCE}`, body: { parentId: null, position: 1 } });
    await settle();
  });

  test("Move folder to… disables its own subfolders and places past the limit, with the reason; a choice moves it", async () => {
    const { api, view } = await open(patchOk);
    await view.click(await menuItem(view, "Quarterly", "Move folder to…"));
    const sheet = await view.waitFor(() => document.querySelector(".report-folder-move-sheet"));
    const options = [...sheet.querySelectorAll<HTMLButtonElement>(".move-option")];
    expect(options.map((item) => item.textContent)).toEqual(["Top level", "FinanceCurrent place", "QuarterlyThis folder", "DeepA folder cannot go inside its own subfolder", "Growth"]);
    expect(options.map((item) => item.disabled)).toEqual([false, true, true, true, false]);
    await view.click(options[4]!);
    await view.click(view.button("Move to Growth", sheet)!);
    await view.waitFor(() => !document.querySelector(".report-folder-move-sheet"));
    expect(patches(api)[0]).toEqual({ method: "PATCH", path: `/reports/folders/${QUARTER}`, body: { parentId: GROWTH, position: 0 } });
    await settle();
  });

  test("Back closes the sheet and Forward reopens it for the same folder", async () => {
    const { view } = await open(patchOk);
    await settle();
    await view.click(await menuItem(view, "Growth", "Move folder to…"));
    await view.waitFor(() => document.querySelector(".report-folder-move-sheet"));
    await settle();
    await act(async () => { window.history.back(); await Bun.sleep(60); });
    await view.waitFor(() => !document.querySelector(".report-folder-move-sheet"));
    await settle();
    await act(async () => { window.history.forward(); await Bun.sleep(60); });
    const sheet = await view.waitFor(() => document.querySelector(".report-folder-move-sheet"));
    expect(sheet.querySelector("h2")?.textContent).toBe("Move “Growth”");
    await act(async () => { window.history.back(); await Bun.sleep(60); });
    await view.waitFor(() => !document.querySelector(".report-folder-move-sheet"));
    await settle();
  });
});
