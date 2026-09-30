import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountActions } from "../src/AppShell";
import { TodayHome } from "../src/today/TodayHome";
import { storageText, TODAY_SECTIONS } from "../src/today/todaySections";
import { BinApp } from "../src/bin/BinApp";

const account = { displayName: "Ada Lovelace", onSettings: () => undefined, onSignOut: () => undefined };
const home = () => renderToStaticMarkup(<TodayHome {...account} userId="u1" onOpen={() => undefined} onOpenRoute={() => undefined} />);

function accountButtons(markup: string) {
  const group = markup.match(/<div class="app-account" role="group" aria-label="Account">(.*?)<\/div>/)?.[1] ?? "";
  return [...group.matchAll(/<button[^>]*>/g)].map(([tag]) => tag);
}

test("Home offers Settings, Bin, and Sign out in its header", () => {
  const markup = home();
  // The header names the section only; the product name lives on the login page and the document title.
  expect(markup).toContain('<span class="brand-text"><strong>Home</strong></span>');
  expect(markup).not.toContain("<small>Nook</small>");
  const buttons = accountButtons(markup);
  expect(buttons).toHaveLength(3);
  expect(buttons[0]).toContain('aria-controls="account-settings-dialog"');
  expect(buttons[0]).toContain('aria-label="Open settings for Ada Lovelace"');
  expect(buttons[1]).toContain('title="Bin"');
  expect(buttons[1]).toContain('aria-label="Bin"');
  expect(buttons[2]).toContain('title="Sign out"');
  // The count badge waits for the lazy Bin fetch, so the first render has none.
  expect(markup).not.toContain("app-account-badge");
});

test("the Home Bin button shows a count badge only when the Bin has items", () => {
  const empty = renderToStaticMarkup(<AccountActions {...account} onBin={() => undefined} binCount={0} />);
  expect(empty).not.toContain("app-account-badge");
  const full = renderToStaticMarkup(<AccountActions {...account} onBin={() => undefined} binCount={3} />);
  expect(full).toContain('aria-label="Bin, 3 items"');
  expect(full).toContain('<span class="app-account-badge" aria-hidden="true">3</span>');
  expect(renderToStaticMarkup(<AccountActions {...account} onBin={() => undefined} binCount={140} />)).toContain(">99+</span>");
});

test("the Bin app offers Home and the same account actions", () => {
  const markup = renderToStaticMarkup(<BinApp {...account} flash={() => undefined} onHome={() => undefined} />);
  expect(accountButtons(markup)).toHaveLength(2);
  expect(markup).toContain(">Sign out</span>");
  expect(markup).toContain("<span class=\"brand-text\"><strong>Bin</strong></span>");
  expect(markup).not.toContain("<small>Nook</small>");
  expect(markup).toContain(">Home</button>");
  // Nothing is loaded yet, so the list shows its loading state and Empty Bin is disabled.
  expect(markup).toContain("Loading the Bin…");
  expect(markup).toMatch(/<button class="bin-empty-button" disabled="">/);
  for (const label of ["All", "Notes", "Files"]) expect(markup).toContain(`>${label}</button>`);
});

test("Today keeps the greeting and a launcher row of real links, without the Bin", () => {
  const markup = home();
  expect(markup).toContain("Good to see you, Ada.");
  const launcher = markup.match(/<nav class="today-launcher" aria-label="Apps">(.*?)<\/nav>/)?.[1] ?? "";
  expect([...launcher.matchAll(/<a class="today-app today-app-(\w+)" href="([^"]+)"/g)].map((match) => [match[1], match[2]])).toEqual([["notes", "/notes"], ["files", "/files"], ["tasks", "/tasks"], ["collections", "/collections"], ["calendar", "/calendar"], ["whiteboards", "/whiteboards"], ["vault", "/vault"]]);
  expect(launcher).not.toContain("Bin");
  expect(markup).not.toContain("app-card");
});

test("Today starts with busy skeleton sections, each labelled by its heading", () => {
  const markup = home();
  expect(markup).toContain('<div class="today-groups" aria-busy="true">');
  const sections = [...markup.matchAll(/<section class="today-section today-section-(\w+)" aria-labelledby="today-(\w+)"/g)];
  expect(sections.map((match) => match[1])).toEqual(["tasksDue", "upcoming", "tasksMine", "proposals", "notesRecent", "files", "collectionsRecent", "whiteboardsRecent", "drafts", "binSoon", "storage"]);
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
});

test("account buttons have 44px hit areas on phones without growing the icon", async () => {
  const css = await Bun.file(new URL("../src/appShell.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.app-account-button \{[^}]*width: 44px;[^}]*height: 44px;/);
  expect(css).toMatch(/\.app-account-button svg \{ width: 16px;/);
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
