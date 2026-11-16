import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parse, type TaskQuery } from "../shared/taskQuery";
import { ModulesContext } from "../src/modules";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { chipLabel, FilterBar } from "../src/tasks/FilterBar";
import { boardData, type BoardContext } from "../src/tasks/boardQuery";
import type { CardSummary } from "../src/tasks/tasksApi";

// WAVE_13_TASK_CARD_UX.md §4.6 (filter bar), §4.8 (Search off hides the text box).
const me = "11111111-1111-4111-8111-111111111111";
const asha = "22222222-2222-4222-8222-222222222222";
const todo = "aaaaaaaa-0000-4000-8000-000000000001";
const tag = "bbbbbbbb-0000-4000-8000-000000000001";
const card = (id: string, change: Record<string, unknown> = {}) => ({
  id, board_id: "b", column_id: todo, position: 1, title: id, has_description: 0, revision: 1, created_by: me, creator_name: "Me",
  due_on: null, assignees: [], assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0,
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", ...change
}) as CardSummary;
const board = boardData({
  columns: [{ id: todo, board_id: "b", name: "To do", position: 1, is_done: 0, wip_limit: 3, created_at: "", updated_at: "" }],
  tags: [{ id: tag, name: "<b>Backend</b>", color: "blue" }],
  cards: [card("k1", { assignees: [{ id: asha, display_name: "Asha", can_read: 1 }], tag_ids: [tag] }), card("k2")]
});
const context: BoardContext = { userId: me, today: "2026-09-26", now: Date.parse("2026-09-26T12:00:00Z"), timeZone: "UTC" };
const query = (text: string): TaskQuery => {
  const parsed = parse(text, { boardScoped: true });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.query;
};
const render = (filter: TaskQuery, disabled: string[] = []) => renderToStaticMarkup(<ModulesContext.Provider value={disabled as never}>
  <FilterBar board={board} context={context} filter={filter} onChange={() => undefined} shown={1} total={2} />
</ModulesContext.Provider>);

test("chips read as sentences, including negated and grammar-only terms", () => {
  const [assignee, flag, due, has, text] = query(`assignee:me,${asha} -flag:urgent due:overdue,<2026-10-01 -has:relation "login"`).terms;
  expect(chipLabel(assignee!, board, context)).toBe("Assignee is Me, Asha");
  expect(chipLabel(flag!, board, context)).toBe("Priority is not Urgent");
  expect(chipLabel(due!, board, context)).toMatch(/^Overdue or Due before Oct 1, 2026$/);
  expect(chipLabel(has!, board, context)).toBe("No relations");
  expect(chipLabel(text!, board, context)).toBe("Text contains “login”");
  expect(chipLabel(query("tag:bbbbbbbb-0000-4000-8000-00000000ffff").terms[0]!, board, context)).toBe("Tag is Unknown tag");
  expect(chipLabel(query("state:done").terms[0]!, board, context)).toBe("State is done");
});

test("the bar shows removable chips, a + Filter dropdown, the text box, Clear, and the count", () => {
  const markup = render(query(`tag:${tag} "login"`));
  expect(markup).toContain('role="group" aria-label="Filters"');
  expect(markup).toContain('aria-label="Edit filter: Tag is &lt;b&gt;Backend&lt;/b&gt;"');
  expect(markup).toContain('aria-label="Remove filter: Tag is &lt;b&gt;Backend&lt;/b&gt;"');
  expect(markup).not.toContain("<b>Backend");
  expect(markup).toContain('role="combobox"');
  expect(markup).toContain("+ Filter");
  // The positive text term lives in the text box, not in a chip.
  expect(markup).toContain('aria-label="Filter cards by text"');
  expect(markup).toContain('value="login"');
  expect(markup).not.toContain("Text contains");
  expect(markup).toContain(">Clear</button>");
  expect(markup).toContain(">1 of 2 cards</span>");
  expect(markup).not.toContain("<select");
  const empty = render({ terms: [] });
  expect(empty).not.toContain(">Clear</button>");
  expect(empty).not.toContain("of 2 cards");
});

test("with Search off, the text box is hidden and a text filter from a link is a chip", () => {
  const markup = render(query('"login"'), ["search"]);
  expect(markup).not.toContain("Filter cards by text");
  expect(markup).toContain("Text contains “login”");
  expect(markup).toContain('aria-label="Remove filter: Text contains “login”"');
});

test("a filtered lane keeps the column's real WIP count and says no card matches", () => {
  const props = {
    column: board.columns[0]!, owner: true, isFirst: true, isLast: true, draggingId: null, dropIndex: null,
    onDragStart: () => undefined, onDragEnd: () => undefined, onDragOverIndex: () => undefined, onDropAt: () => undefined, onKeyMove: () => undefined,
    onCardMenu: () => undefined, onOpenCard: () => undefined, onColumnMenu: () => undefined, onMoveColumn: () => undefined, onAddCard: async () => undefined
  };
  const filtered = renderToStaticMarkup(<BoardColumnView {...props} cards={[]} totalCount={2} />);
  expect(filtered).toContain('aria-label="0 shown; 2 of 3 cards" title="WIP limit 3">0 · 2 / 3</b>');
  expect(filtered).toContain("No matching cards");
  const plain = renderToStaticMarkup(<BoardColumnView {...props} cards={[]} />);
  expect(plain).toContain("No cards yet");
});
