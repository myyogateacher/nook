import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayGroups } from "../src/today/TodayHome";
import type { TodayResponse, TodaySection } from "../src/today/todayApi";
import { DEFAULT_SECTION_ORDER, groupTodaySections, sectionCount, TODAY_GROUPS, TODAY_SECTIONS } from "../src/today/todaySections";

const empty = (href = "/"): TodaySection => ({ items: [], more: false, href });
const card = (id: string, title: string) => ({ cardId: id, boardId: "b1", boardName: "Home", title, dueOn: "2026-09-28" });
const note = (id: string, title: string) => ({ id, title, is_owner: 1, updated_at: new Date().toISOString() });

function response(sections: Record<string, TodaySection>): TodayResponse {
  return { generatedAt: new Date().toISOString(), date: "2026-09-27", sections };
}

const render = (names: readonly string[], data: TodayResponse | null, busy = false) =>
  renderToStaticMarkup(<TodayGroups names={names} data={data} busy={busy} retrying={new Set()} onRetry={() => undefined} onOpenRoute={() => undefined} />);

const groupsIn = (markup: string) => [...markup.matchAll(/<section class="today-group today-group-(\w+)" aria-labelledby="today-group-\1">/g)].map((match) => match[1]);
const cardsIn = (markup: string) => [...markup.matchAll(/<section class="today-section today-section-(\w+)"/g)].map((match) => match[1]);
const quietIn = (markup: string) => [...markup.matchAll(/<li class="today-quiet today-quiet-(\w+)">/g)].map((match) => match[1]);

test("every client section names one of the three fixed groups, listed in group order", () => {
  expect(TODAY_GROUPS.map((group) => group.title)).toEqual(["Today", "Recent work", "Housekeeping"]);
  const ids = TODAY_GROUPS.map((group) => group.id as string);
  const order = DEFAULT_SECTION_ORDER.map((name) => ids.indexOf(TODAY_SECTIONS[name]!.group));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(groupTodaySections(DEFAULT_SECTION_ORDER).map((group) => [group.id, group.names])).toEqual([
    ["today", ["tasksDue", "upcoming", "tasksMine"]],
    ["recent", ["notesRecent", "files", "collectionsRecent"]],
    ["housekeeping", ["drafts", "agentDrafts", "binSoon", "storage"]]
  ]);
});

test("grouping ignores server order and unknown names, and drops a group with nothing shown", () => {
  expect(groupTodaySections(["storage", "team", "notesRecent", "tasksDue"]).map((group) => [group.id, group.names])).toEqual([
    ["today", ["tasksDue"]],
    ["recent", ["notesRecent"]],
    ["housekeeping", ["storage"]]
  ]);
  expect(groupTodaySections(["files"]).map((group) => group.id)).toEqual(["recent"]);
});

test("while loading, each group shows headed skeleton cards", () => {
  const markup = render(DEFAULT_SECTION_ORDER, null, true);
  expect(markup).toContain('<div class="today-groups" aria-busy="true">');
  expect(groupsIn(markup)).toEqual(["today", "recent", "housekeeping"]);
  expect(markup).toContain('<h2 id="today-group-today" class="today-group-title">Today</h2>');
  expect(markup).toContain('<h2 id="today-group-recent" class="today-group-title">Recent work</h2>');
  expect(cardsIn(markup)).toEqual(DEFAULT_SECTION_ORDER);
  expect(quietIn(markup)).toEqual([]);
});

test("sections with items are cards with a count, empty ones fold into one muted line", () => {
  const data = response({
    tasksDue: { items: [card("c1", "Pay rent"), card("c2", "Call Bo"), card("c3", "Water plants")], more: false, href: "/tasks" },
    upcoming: empty("/calendar"),
    tasksMine: empty("/tasks"),
    notesRecent: { items: Array.from({ length: 10 }, (_, index) => note(`n${index}`, `Note ${index}`)), more: true, href: "/notes" },
    files: empty("/files"),
    collectionsRecent: empty("/collections")
  });
  const markup = render(["tasksDue", "upcoming", "tasksMine", "notesRecent", "files", "collectionsRecent"], data);
  expect(cardsIn(markup)).toEqual(["tasksDue", "notesRecent"]);
  expect(markup).toContain('<h3 id="today-tasksDue">Due soon<span class="today-section-count"> · 3</span></h3>');
  expect(markup).toContain('<h3 id="today-notesRecent">Recent notes<span class="today-section-count"> · 10+</span></h3>');
  expect(markup).toContain(">View all<");
  expect(quietIn(markup)).toEqual(["upcoming", "tasksMine", "files", "collectionsRecent"]);
  expect(markup).toContain('<li class="today-quiet today-quiet-upcoming"><span class="today-quiet-title">Upcoming</span> · nothing in the next 7 days</li>');
  // The quiet lines sit in their own group, after its cards.
  const today = markup.slice(markup.indexOf("today-group-today"), markup.indexOf("today-group-recent"));
  expect(today.indexOf("today-section-tasksDue")).toBeLessThan(today.indexOf("today-quiet-upcoming"));
  expect(markup).not.toContain("All clear");
});

test("a whole empty group is one All clear line; an error keeps its card", () => {
  const data = response({
    tasksDue: empty(), upcoming: empty(), tasksMine: empty(),
    drafts: empty(), binSoon: empty(), storage: { items: [], more: false, href: "/files", error: "boom" }
  });
  const markup = render(["tasksDue", "upcoming", "tasksMine", "drafts", "binSoon", "storage"], data);
  expect(groupsIn(markup)).toEqual(["today", "housekeeping"]);
  const today = markup.slice(markup.indexOf("today-group-today"), markup.indexOf("today-group-housekeeping"));
  expect(today).toContain('<p class="today-all-clear"><strong>All clear</strong> · nothing due or coming up</p>');
  expect(today).not.toContain("today-quiet");
  expect(cardsIn(markup)).toEqual(["storage"]);
  expect(markup).toContain("Storage could not be loaded.");
  expect(quietIn(markup)).toEqual(["drafts", "binSoon"]);
});

test("storage usage is a card without a count", () => {
  const data = response({ storage: { items: [{ usedBytes: 1024, binnedBytes: 0, quotaBytes: null }], more: false, href: "/files" } });
  const markup = render(["storage"], data);
  expect(cardsIn(markup)).toEqual(["storage"]);
  expect(markup).toContain('<h3 id="today-storage">Storage</h3>');
});

test("groups are one column on phones, two from 761 px with Housekeeping below, three from 1100 px", async () => {
  const css = await Bun.file(new URL("../src/today/today.css", import.meta.url)).text();
  expect(css).toMatch(/\.today-groups \{ display: grid; grid-template-columns: minmax\(0, 1fr\);[^}]*align-items: start;/);
  const tablet = css.slice(css.indexOf("@media (min-width: 761px)"), css.indexOf("@media (min-width: 1100px)"));
  expect(tablet).toMatch(/\.today-groups \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  expect(tablet).toMatch(/\.today-group-housekeeping \{ grid-column: 1 \/ -1; \}/);
  const wide = css.slice(css.indexOf("@media (min-width: 1100px)"));
  expect(wide).toMatch(/\.today-groups \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  expect(wide).toMatch(/\.today-group-housekeeping \{ grid-column: auto; \}/);
  // Cards stack inside their group column, so no row-based grid spans the groups.
  expect(css).toMatch(/\.today-group \{[^}]*align-content: start;/);
  expect(css).toMatch(/\.today-list li \+ li \{ border-top: 1px solid/);
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.today-quiet \{ min-height: 44px; \}/);
});

test("sectionCount is empty for nothing and marks a capped list", () => {
  expect(sectionCount([], false)).toBeNull();
  expect(sectionCount([1, 2], false)).toBe("2");
  expect(sectionCount(Array(10).fill(0), true)).toBe("10+");
});
