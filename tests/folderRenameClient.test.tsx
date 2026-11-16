import { expect, test } from "bun:test";
import { useState } from "react";
import { Archive } from "lucide-react";
import "../src/workspaceModules";
import { captureToasts, installDom, mockApi, reply, render, type Rendered } from "./support/dom";
import { buildNavTree } from "../src/shell/navModel";
import { AppFrame } from "../src/shell/AppFrame";
import { ShellMenuButton, ShellSidebarPortal } from "../src/shell/shellContext";
import { SidebarFolderTree } from "../src/shell/SidebarFolderTree";
import { canRenameFolder, nextFolderName, rollbackFolderName, useFolderRename, withFolderName } from "../src/shell/folderRename";
import type { Folder } from "../src/types";

/**
 * Renaming Notes and Files folders in place (D1302): a ⋯ menu with Rename on the folders the person
 * may rename (theirs, not Default, not Attachments, a writing role), F2 on the row, an inline field
 * (Enter or leaving it saves, Escape cancels), an optimistic name, and a rollback with an error toast.
 */

installDom("http://nook.test/notes");

const at = "2026-11-01T00:00:00.000Z";
const folder = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({ id, owner_id: "me", owner_name: "Me", parent_id: null, name, is_default: 0, is_owner: 1, visibility: "private", created_at: at, updated_at: at, system_kind: null, ...extra });
const START = [
  folder("default", "Default", { is_default: 1 }),
  folder("plans", "Plans"),
  folder("attach", "Attachments", { system_kind: "attachments" }),
  folder("theirs", "Team docs", { is_owner: 0, owner_id: "other", owner_name: "Ola", visibility: "selected" })
];

test("who may rename which folder, and what a typed name becomes", () => {
  expect(START.map((item) => canRenameFolder(item, true))).toEqual([false, true, false, false]);
  expect(canRenameFolder(START[1]!, false)).toBe(false);
  expect(nextFolderName("  Roadmap ", "Plans")).toBe("Roadmap");
  expect(nextFolderName("   ", "Plans")).toBeNull();
  expect(nextFolderName(" Plans ", "Plans")).toBeNull();
  expect(nextFolderName("x".repeat(130), "Plans")).toHaveLength(120);
  const renamed = withFolderName(START, "plans", "Roadmap");
  expect(renamed[1]!.name).toBe("Roadmap");
  expect(rollbackFolderName(renamed, "plans", "Roadmap", "Plans")[1]!.name).toBe("Plans");
  // Something newer renamed it again: the rollback leaves it.
  expect(rollbackFolderName(withFolderName(START, "plans", "Later"), "plans", "Roadmap", "Plans")[1]!.name).toBe("Later");
});

const tree = () => buildNavTree({ disabledModules: [], features: { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true }, role: "member", active: "notes" });

function Tree({ canWrite = true }: { canWrite?: boolean }) {
  const [folders, setFolders] = useState<Folder[]>(START);
  const rename = useFolderRename<Folder>(setFolders);
  return <ShellSidebarPortal><SidebarFolderTree app="notes" label="Note folders"
    entries={[{ id: "all", label: "All notes", icon: Archive, href: "/notes", current: false, onSelect: () => undefined }]}
    groups={[{ id: "folders", heading: "Folders", folders: folders.filter((item) => item.is_owner === 1) }, { id: "shared", heading: "Shared folders", folders: folders.filter((item) => item.is_owner !== 1) }]}
    current={null} hrefFor={(item) => `/notes/folder/${item.id}`} onSelect={() => undefined} name={(item) => item.name}
    rename={{ can: (item) => canRenameFolder(item, canWrite), onRename: (item, name) => { void rename(item, name); } }} /></ShellSidebarPortal>;
}

const quiet = { "GET /inbox/count": () => ({ pending: 0 }), "GET /notifications?unread=1&limit=1": () => ({ items: [], unreadCount: 0 }) };
const frame = (node: React.ReactNode) => render(<AppFrame tree={tree()} displayName="Ada" onNavigate={() => undefined} onSearch={() => undefined} onAccount={() => undefined} onSignOut={() => undefined}>
  <main className="app-page"><ShellMenuButton />{node}</main>
</AppFrame>);
const treeNav = () => document.querySelector<HTMLElement>('nav[aria-label="Note folders"]')!;
const menuButton = (name: string) => treeNav().querySelector<HTMLButtonElement>(`button[aria-label="${name} folder actions"]`);
const field = () => treeNav().querySelector<HTMLInputElement>(".folder-rename input");

async function typeInto(input: HTMLInputElement, value: string) {
  const { act } = await import("react");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(view: Rendered, target: Element, key: string) {
  const { act } = await import("react");
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await view.waitFor(() => true);
}
async function submit(view: Rendered) {
  const { act } = await import("react");
  await act(async () => { field()!.form!.requestSubmit(); });
  await view.waitFor(() => true);
}
async function openRename(view: Rendered, name: string) {
  await view.click(menuButton(name)!);
  const item = [...treeNav().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === "Rename")!;
  await view.click(item);
  return view.waitFor(() => field());
}

test("only the person's own ordinary folders get a ⋯ with Rename; a read-only role gets none", async () => {
  mockApi(quiet);
  const view = await frame(<Tree />);
  expect(menuButton("Plans")).not.toBeNull();
  for (const name of ["Default", "Attachments", "Team docs"]) expect(menuButton(name)).toBeNull();
  await view.click(menuButton("Plans")!);
  expect([...treeNav().querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Rename"]);
  const readOnly = await frame(<Tree canWrite={false} />);
  expect(readOnly.container.querySelector(".app-sidebar-tree-menu")).toBeNull();
});

test("Rename turns the row into a field; Enter saves at once (optimistic) and the trimmed name is sent; focus returns to the row", async () => {
  let release: (value: unknown) => void = () => undefined;
  const api = mockApi({ ...quiet, "PATCH /folders/plans": (call) => new Promise((resolve) => { release = () => resolve({ ok: true, folder: { id: "plans", name: (call.body as { name: string }).name } }); }) });
  const view = await frame(<Tree />);
  const input = await openRename(view, "Plans");
  expect(input.value).toBe("Plans");
  expect(input.form?.noValidate).toBe(true);
  expect(input.maxLength).toBe(120);
  expect(document.activeElement).toBe(input);
  await typeInto(input, "  Roadmap  ");
  await submit(view);
  // Shown before the server answers.
  expect(field()).toBeNull();
  expect(treeNav().querySelector('a[href="/notes/folder/plans"]')?.textContent).toContain("Roadmap");
  expect(api.calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/folders/plans", body: { name: "Roadmap" } }]);
  release(null);
  await view.waitFor(() => document.activeElement === treeNav().querySelector('a[href="/notes/folder/plans"]'));
  expect(treeNav().querySelector('a[href="/notes/folder/plans"]')?.textContent).toContain("Roadmap");
});

test("Escape cancels without a request; a blank or unchanged name saves nothing; leaving the field saves", async () => {
  const api = mockApi({ ...quiet, "PATCH /folders/plans": (call) => ({ ok: true, folder: { id: "plans", name: (call.body as { name: string }).name } }) });
  const view = await frame(<Tree />);
  let input = await openRename(view, "Plans");
  await typeInto(input, "Nope");
  await press(view, input, "Escape");
  expect(field()).toBeNull();
  expect(treeNav().querySelector('a[href="/notes/folder/plans"]')?.textContent).toContain("Plans");
  input = await openRename(view, "Plans");
  await typeInto(input, "   ");
  await submit(view);
  expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  input = await openRename(view, "Plans");
  await typeInto(input, "Blurred");
  const { act } = await import("react");
  await act(async () => { input.blur(); });
  await view.waitFor(() => api.calls.some((call) => call.method === "PATCH"));
  expect(api.calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{ name: "Blurred" }]);
  await view.waitFor(() => treeNav().querySelector('a[href="/notes/folder/plans"]')?.textContent?.includes("Blurred"));
});

test("F2 on a folder row starts renaming it; not on a folder that cannot be renamed", async () => {
  mockApi(quiet);
  const view = await frame(<Tree />);
  await press(view, treeNav().querySelector('a[href="/notes/folder/default"]')!, "F2");
  expect(field()).toBeNull();
  await press(view, treeNav().querySelector('a[href="/notes/folder/plans"]')!, "F2");
  expect(field()?.value).toBe("Plans");
});

test("a refused rename puts the old name back and says why", async () => {
  const toasts = captureToasts();
  mockApi({ ...quiet, "PATCH /folders/plans": () => reply(409, { error: "The Default folder already exists", code: "NAME_TAKEN" }) });
  const view = await frame(<Tree />);
  const input = await openRename(view, "Plans");
  await typeInto(input, "default");
  await submit(view);
  await view.waitFor(() => toasts.length > 0);
  expect(toasts).toEqual([{ kind: "error", message: "The Default folder already exists" }]);
  expect(treeNav().querySelector('a[href="/notes/folder/plans"]')?.textContent).toContain("Plans");
});

test("on a phone the drawer's folder rows keep the ⋯ (no Share there), and Escape in the field leaves the drawer open", async () => {
  mockApi(quiet);
  const width = window.innerWidth;
  (window as unknown as { innerWidth: number }).innerWidth = 390;
  try {
    const view = await frame(<Tree />);
    await view.click(view.container.querySelector<HTMLButtonElement>(".shell-menu-button")!);
    const drawer = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(drawer.querySelector('button[aria-label="Plans folder actions"]')).not.toBeNull();
    const input = await openRename(view, "Plans");
    await press(view, input, "Escape");
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
  } finally {
    (window as unknown as { innerWidth: number }).innerWidth = width;
  }
});
