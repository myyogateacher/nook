import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardGroupedList } from "../src/tasks/BoardGroupedList";
import { BoardTable, nextSort } from "../src/tasks/BoardTable";
import { BoardViewSwitch } from "../src/tasks/BoardViewSwitch";
import { KeyboardMoveHint } from "../src/tasks/boardViewParts";
import { moduleDef } from "../src/modules";
import { applyBoardQuery, boardData, type BoardContext } from "../src/tasks/boardQuery";
import { DEFAULT_BOARD_QUERY, parseBoardSearch } from "../src/tasks/boardUrl";
import type { CardSummary } from "../src/tasks/tasksApi";

// WAVE_13_TASK_CARD_UX.md §4.5 (table and grouped list views), rendered with react-dom/server.
const me = "11111111-1111-4111-8111-111111111111";
const todo = "aaaaaaaa-0000-4000-8000-000000000001";
const done = "aaaaaaaa-0000-4000-8000-000000000003";
const tag = "bbbbbbbb-0000-4000-8000-000000000001";
const card = (id: string, change: Record<string, unknown> = {}) => ({
  id, board_id: "b", column_id: todo, position: 1, title: id, has_description: 0, revision: 1, created_by: me, creator_name: "Me",
  due_on: null, assignees: [], assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0,
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", ...change
}) as CardSummary;
const column = (id: string, name: string, position: number, isDone: 0 | 1 = 0) => ({ id, board_id: "b", name, position, is_done: isDone, created_at: "", updated_at: "" });
const board = boardData({
  columns: [column(todo, "To do", 1), column(done, "Done", 2, 1)],
  tags: [{ id: tag, name: "Backend", color: "blue" }],
  cards: [
    card("k1", { title: "<img src=x onerror=alert(1)>", tag_ids: [tag], flags: ["on_hold"], priority: "urgent", assignees: [{ id: me, display_name: "Pat", can_read: 1 }, { id: "22222222-2222-4222-8222-222222222222", display_name: "Asha", can_read: 0 }] }),
    card("k2", { title: "Ship", column_id: done, due_on: "2026-09-20" })
  ]
});
const context: BoardContext = { userId: me, today: "2026-09-26", now: Date.parse("2026-09-26T12:00:00Z"), timeZone: "UTC" };
const noop = () => undefined;

test("the view switch is a labelled radio group with one tab stop", () => {
  const markup = renderToStaticMarkup(<BoardViewSwitch value="table" onChange={noop} />);
  expect(markup).toContain('role="radiogroup" aria-label="View"');
  expect(markup.match(/role="radio"/g)).toHaveLength(5);
  expect(markup).toContain('aria-checked="true" tabindex="0" class="icon-button active" aria-label="Table"');
  expect(markup.match(/tabindex="-1"/g)).toHaveLength(4);
  expect(renderToStaticMarkup(<BoardViewSwitch value="board" onChange={noop} views={["board", "table", "list"]} />)).not.toContain("Calendar");
});

test("table headers sort with aria-sort and cycle asc, desc, then board order", () => {
  expect(nextSort(null, "due")).toEqual({ field: "due", direction: "asc" });
  expect(nextSort({ field: "due", direction: "asc" }, "due")).toEqual({ field: "due", direction: "desc" });
  expect(nextSort({ field: "due", direction: "desc" }, "due")).toBeNull();
  expect(nextSort({ field: "due", direction: "desc" }, "title")).toEqual({ field: "title", direction: "asc" });
  const markup = renderToStaticMarkup(<BoardTable board={board} cards={board.cards} sort={{ field: "due", direction: "desc" }} today={context.today} filtered={false} onSort={noop} onOpenCard={noop} onCardMenu={noop} />);
  expect(markup).toContain('role="region" aria-label="Cards table" tabindex="0"');
  expect(markup).toContain('aria-sort="descending" class="task-table-due"');
  expect(markup.match(/aria-sort="none"/g)).toHaveLength(8);
  for (const label of ["Title", "Column", "Assignees", "Due", "Priority", "Tags", "Flags", "Created", "Updated"]) expect(markup).toContain(`<span>${label}</span>`);
  // Titles are text, never markup (T98); the sticky title column holds the open button and ⋯.
  expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(markup).not.toContain("<img");
  expect(markup).toContain('class="task-table-title"');
  expect(markup).toContain('data-open-card="k1"');
  expect(markup).toContain("Pat, Asha (no access)");
  expect(markup).toContain('aria-label="Tags Backend"');
  expect(markup).toContain('aria-label="On hold"');
  expect(markup).toContain('<span class="task-table-priority"><svg');
  // A done card shows no due chip.
  expect(markup).toContain('<tr class="done" data-card-id="k2">');
  expect(markup).not.toContain("Overdue");
  expect(markup).not.toContain("<select");
});

test("the sticky title column paints over scrolled cells, avatar stacks included", () => {
  const css = readFileSync(new URL("../src/tasks/boardViews.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.match(new RegExp(`^${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
  const zIndex = (selector: string) => Number(/z-index: (\d+)/.exec(rule(selector))?.[1] ?? 0);
  // The avatars stack with z-index 1–3 (tasks.css); isolated, those stay inside the cell.
  expect(rule(".task-table-people .task-card-people")).toContain("isolation: isolate");
  expect(rule(".task-table .task-table-title")).toContain("background: #121214");
  expect(zIndex(".task-table .task-table-title")).toBeGreaterThan(3);
  expect(zIndex(".task-table thead .task-table-title")).toBeGreaterThan(zIndex(".task-table .task-table-title"));
});

test("an empty table says whether filters hide the cards", () => {
  expect(renderToStaticMarkup(<BoardTable board={board} cards={[]} sort={null} today={context.today} filtered onSort={noop} onOpenCard={noop} onCardMenu={noop} />)).toContain("No cards match these filters.");
});

test("the grouped list shows counted, collapsible sections and marks cards listed twice", () => {
  const groups = applyBoardQuery(board, { ...DEFAULT_BOARD_QUERY, view: "list", group: "assignee" }, context).groups!;
  const markup = renderToStaticMarkup(<BoardGroupedList board={board} groups={groups} group="assignee" today={context.today} filtered={false} onGroup={noop} onOpenCard={noop} onCardMenu={noop} />);
  expect(markup).toContain('role="combobox"');
  expect(markup).toContain('aria-labelledby="task-group-label"');
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain('<span class="task-group-name">Pat (you)</span><span class="task-group-count" aria-label="1 card">1</span>');
  expect(markup).toContain("also in Asha");
  expect(markup).toContain("No assignee");
  expect(markup).not.toContain("<select");
  const byColumn = applyBoardQuery(board, { ...parseBoardSearch("?view=list&q=priority:urgent") }, context).groups!;
  const columnMarkup = renderToStaticMarkup(<BoardGroupedList board={board} groups={byColumn} group="column" today={context.today} filtered onGroup={noop} onOpenCard={noop} onCardMenu={noop} />);
  expect(columnMarkup).toContain('<span class="task-group-name">Done</span><span class="task-group-count" aria-label="0 cards">0</span>');
  expect(columnMarkup).toContain("No cards");
});

test("polish: the Alt+Arrow hint, module help, avatar overlap, and focus ring", () => {
  // Rendered for a keyboard; on a touch-only device the hint is left empty (useFinePointer).
  expect(renderToStaticMarkup(<KeyboardMoveHint id="task-card-keys">Press Alt</KeyboardMoveHint>)).toBe('<p id="task-card-keys" class="sr-only">Press Alt</p>');
  expect(moduleDef("search").description).toContain("the text filter on boards");
  const tasksCss = readFileSync(new URL("../src/tasks/tasks.css", import.meta.url), "utf8");
  expect(tasksCss).toContain("border-radius: 999px; margin-left: -4px;");
  expect(tasksCss).toContain(".task-description-editor .editor-surface:focus-within { outline: 2px solid var(--yellow);");
  // Muted copy in the Tasks views keeps at least 4.5:1 on the darkest panels (#85858c on #1c1c20 is 4.6:1).
  const boardCss = readFileSync(new URL("../src/tasks/boardViews.css", import.meta.url), "utf8");
  for (const css of [tasksCss, boardCss]) expect(css).not.toMatch(/[{; ]color: #(55555c|6f6f76|7c7c83)/);
});
