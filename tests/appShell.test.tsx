import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WORKSPACE_MODULE_IDS } from "../shared/workspaceModules";
// A shipped workspace module adds its launcher tile and Today section (D832, D836); these checks are about the built-in ones.
const builtIn = (id: string) => !(WORKSPACE_MODULE_IDS as readonly string[]).includes(id);
import { TodayHome } from "../src/today/TodayHome";
import { storageText, TODAY_SECTIONS } from "../src/today/todaySections";
import { BinSection } from "../src/bin/BinSection";

const account = { displayName: "Ada Lovelace", onSettings: () => undefined, onSignOut: () => undefined };
const home = () => renderToStaticMarkup(<TodayHome {...account} userId="u1" onOpen={() => undefined} onOpenRoute={() => undefined} />);

test("Home's header is the one-row page header: its name and the bell; the account is in the sidebar (D1273)", () => {
  const markup = home();
  // The header names the section only; the product name lives on the login page and the document title.
  expect(markup).toContain('<header class="app-page-header page-header"><div class="page-header-title"><strong>Home</strong></div>');
  expect(markup).not.toContain("<small>Nook</small>");
  // No account row in any header (Settings, Inbox, the person, and Sign out are in the sidebar).
  expect(markup).not.toContain("app-account");
  expect(markup).not.toContain('title="Sign out"');
  expect(markup).not.toContain('title="Bin"');
  expect(markup).not.toContain('title="Team"');
});

test("the Bin is a Settings section: no header of its own, its retention line, filters, and Empty Bin", () => {
  const markup = renderToStaticMarkup(<BinSection flash={() => undefined} />);
  // The hub brings the header and the title; the section is its scroller.
  expect(markup).toMatch(/^<section class="settings-content bin-section" aria-labelledby="settings-hub-title">/);
  expect(markup).not.toContain("app-page-header");
  expect(markup).not.toContain(">Home</button>");
  expect(markup).not.toContain("<h1");
  expect(markup).toContain("stay here for 30 days, then they are deleted forever");
  // Nothing is loaded yet, so the list shows its loading state and Empty Bin is disabled.
  expect(markup).toContain("Loading the Bin…");
  expect(markup).toMatch(/<button class="bin-empty-button" disabled="">/);
  for (const label of ["All", "Notes", "Files"]) expect(markup).toContain(`>${label}</button>`);
});

test("Today keeps the greeting and a launcher row of real links, without the Bin", () => {
  const markup = home();
  expect(markup).toContain("Good to see you, Ada.");
  const launcher = markup.match(/<nav class="today-launcher" aria-label="Apps">(.*?)<\/nav>/)?.[1] ?? "";
  expect([...launcher.matchAll(/<a class="today-app today-app-(\w+)" href="([^"]+)"/g)].map((match) => [match[1], match[2]]).filter(([section]) => builtIn(section!))).toEqual([["notes", "/notes"], ["files", "/files"], ["tasks", "/tasks"], ["collections", "/collections"], ["calendar", "/calendar"], ["whiteboards", "/whiteboards"], ["vault", "/vault"], ["chat", "/chat"], ["reports", "/reports"]]);
  expect(launcher).not.toContain("Bin");
  expect(markup).not.toContain("app-card");
});

test("Today starts with busy skeleton sections, each labelled by its heading", () => {
  const markup = home();
  expect(markup).toContain('<div class="today-groups" aria-busy="true">');
  const sections = [...markup.matchAll(/<section class="today-section today-section-(\w+)" aria-labelledby="today-(\w+)"/g)];
  expect(sections.map((match) => match[1]).filter((name) => !TODAY_SECTIONS[name!]?.module)).toEqual(["tasksDue", "upcoming", "tasksMine", "proposals", "notesRecent", "files", "collectionsRecent", "whiteboardsRecent", "drafts", "binSoon", "storage"]);
  for (const [, name] of sections) expect(markup).toContain(`<h3 id="today-${name}">${TODAY_SECTIONS[name!]!.title}</h3>`);
  expect(markup).toContain('class="today-skeleton" aria-hidden="true"');
  expect(markup).toContain('role="status" aria-live="polite"');
  expect(markup).toContain(">Refresh</button>");
});

test("Today's upcoming rows open the event and say when it starts", () => {
  const row = TODAY_SECTIONS.upcoming!.row!({ eventId: "e1", calendarId: "k", title: "Picnic", start: "2026-09-26", end: "2026-09-27", allDay: true, date: "2026-09-26" }, "2026-09-25");
  expect(row).toMatchObject({ label: "Picnic", meta: "Tomorrow · All day", route: { app: "calendar", view: "agenda", month: null, eventId: "e1" } });
  expect(TODAY_SECTIONS.upcoming!.row!({ eventId: "e2", title: "", start: "2026-09-20", end: "2026-09-30", allDay: true, date: "2026-09-20" }, "2026-09-25")).toMatchObject({ label: "Untitled event", meta: "Today · All day", tone: "today" });
});

test("Today rows link to their app routes and show due and storage copy", () => {
  const due = TODAY_SECTIONS.tasksDue!.row!({ cardId: "c", boardId: "b", boardName: "Home", title: "Pay rent", dueOn: "2026-09-20", overdue: true }, "2026-09-25");
  expect(due).toMatchObject({ label: "Pay rent", tone: "overdue", route: { app: "tasks", boardId: "b", cardId: "c" } });
  expect(due.meta).toContain("Home · Overdue");
  expect(TODAY_SECTIONS.tasksMine!.row!({ cardId: "c", boardId: "b", boardName: "Home", title: "x", dueOn: null, reason: "assigned" }, "2026-09-25").meta).toBe("Home · Assigned to you");
  expect(TODAY_SECTIONS.notesRecent!.row!({ id: "n", title: "", is_owner: 0, owner_name: "Bo", updated_at: new Date().toISOString() }, "").label).toBe("Untitled");
  expect(TODAY_SECTIONS.binSoon!.row!({ type: "document", id: "d", title: "a.pdf", purge_after: new Date(Date.now() + 86_400_000).toISOString() }, "").route).toEqual({ app: "bin" });
  expect(TODAY_SECTIONS.collectionsRecent!.row!({ rowId: "r1", collectionId: "c1", collectionName: "Recipes", title: "", updated_at: new Date().toISOString(), changedByKey: true }, "")).toMatchObject({
    key: "r1", label: "Untitled", route: { app: "collections", collectionId: "c1", viewId: null, rowId: "r1" }
  });
  expect(TODAY_SECTIONS.collectionsRecent!.row!({ rowId: "r1", collectionId: "c1", collectionName: "Recipes", title: "Soup", updated_at: new Date().toISOString(), changedByKey: true }, "").meta).toContain("Recipes · Changed by an MCP key");
  expect(TODAY_SECTIONS.drafts!.row!({ id: "n", title: "T", neverPublished: true, updated_at: new Date().toISOString() }, "").meta).toContain("Never published");
  expect(storageText({ usedBytes: 3.2 * 1024 ** 3, binnedBytes: 0, quotaBytes: 10 * 1024 ** 3 }).summary).toBe("3.2 GB of 10 GB");
  expect(storageText({ usedBytes: 0, binnedBytes: 0, quotaBytes: null })).toEqual({ summary: "0 B used", detail: "No storage limit" });
  // D1265: notes, cards, and boards in the Bin take no bytes; the line counts them instead of saying it is empty.
  expect(storageText({ usedBytes: 0, binnedBytes: 0, quotaBytes: 10 * 1024 ** 3, binnedItems: 3 }).detail).toBe("3 items in the Bin");
  expect(storageText({ usedBytes: 0, binnedBytes: 0, quotaBytes: null, binnedItems: 1 }).detail).toBe("1 item in the Bin");
  expect(storageText({ usedBytes: 0, binnedBytes: 0, quotaBytes: 10 * 1024 ** 3, binnedItems: 0 }).detail).toBe("Nothing in the Bin");
});

test("the bell keeps a 44px hit area on phones without growing the icon", async () => {
  const css = await Bun.file(new URL("../src/notifications/notifications.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.app-notification-bell \{ width: 44px; height: 44px; \}/);
  const shell = await Bun.file(new URL("../src/appShell.css", import.meta.url)).text();
  expect(shell).toMatch(/\.app-account-button svg \{ width: 16px;/);
});

test("hidden Today sections are kept per user and survive bad storage", async () => {
  const { hiddenSectionsKey, readHiddenSections, toggleHidden, writeHiddenSections } = await import("../src/today/todayPreferences");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  expect(readHiddenSections("u1", storage)).toEqual([]);
  writeHiddenSections("u1", toggleHidden([], "files", false), storage);
  expect(values.get(hiddenSectionsKey("u1"))).toBe('["files"]');
  expect(readHiddenSections("u1", storage)).toEqual(["files"]);
  expect(readHiddenSections("u2", storage)).toEqual([]);
  expect(toggleHidden(["files", "drafts"], "files", true)).toEqual(["drafts"]);
  values.set(hiddenSectionsKey("u1"), "{not json");
  expect(readHiddenSections("u1", storage)).toEqual([]);
  values.set(hiddenSectionsKey("u1"), JSON.stringify(["drafts", 5, "<script>", "drafts"]));
  expect(readHiddenSections("u1", storage)).toEqual(["drafts"]);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(readHiddenSections("u1", throwing)).toEqual([]);
  expect(() => writeHiddenSections("u1", ["files"], throwing)).not.toThrow();
});

test("Today is one column with 44px rows and targets on phones", async () => {
  const css = await Bun.file(new URL("../src/today/today.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.today-groups \{ grid-template-columns: minmax\(0, 1fr\);/);
  expect(phone).toMatch(/\.today-row \{ min-height: 44px;/);
  expect(phone).toMatch(/\.today-view-all \{ min-height: 44px;/);
  expect(phone).toMatch(/\.today-refresh, \.today-retry, \.today-customize[^{]*\{ min-height: 44px; \}/);
  expect(css).toMatch(/\.today-customize-option \{ min-height: 44px;/);
});
