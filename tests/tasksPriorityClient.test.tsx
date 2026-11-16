import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { format, parse, type TaskQuery } from "../shared/taskQuery";
import { PriorityBadge, PriorityPicker, priorityLabel } from "../src/tasks/priority";
import { CardFields } from "../src/tasks/CardFields";
import { FlagPicker } from "../src/tasks/TagPicker";
import { chipLabel, FilterBar } from "../src/tasks/FilterBar";
import { boardData, FILTER_FIELDS, filterBoardCards, type BoardContext } from "../src/tasks/boardQuery";
import { formatBoardSearch, parseBoardSearch } from "../src/tasks/boardUrl";
import { ACTIVITY_RENDERERS } from "../src/tasks/cardActivity";
import { applyFieldChange, composerDirty, createBody, emptyDraft } from "../src/tasks/composerDraft";
import { homeValueLabel } from "../src/tasks/home/HomeFilterBar";
import { SORT_LABELS } from "../src/tasks/home/HomeResultsPane";
import type { CardDetail, CardSummary } from "../src/tasks/tasksApi";

/** Card priority in the app (docs/plan/TASK_PRIORITY.md, D1310–D1319): the field, the indicator, the filter, and the URL. */

const noop = () => undefined;
const me = "11111111-1111-4111-8111-111111111111";
const todo = "aaaaaaaa-0000-4000-8000-000000000001";
const card = (id: string, change: Record<string, unknown> = {}) => ({
  id, board_id: "b", column_id: todo, position: 1, title: id, has_description: 0, revision: 1, created_by: me, creator_name: "Me",
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null, tag_ids: [], flags: [], description_excerpt: "",
  comment_count: 0, attachment_count: 0, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", ...change
}) as CardSummary;
const board = boardData({
  columns: [{ id: todo, board_id: "b", name: "To do", position: 1, is_done: 0, created_at: "", updated_at: "" }],
  cards: [card("u", { priority: "urgent" }), card("h", { position: 2, priority: "high", flags: ["blocked"] }), card("n", { position: 3 })],
  tags: []
});
const context: BoardContext = { userId: me, today: "2026-09-26", now: Date.parse("2026-09-26T12:00:00Z"), timeZone: "UTC" };
const query = (text: string): TaskQuery => {
  const parsed = parse(text, { boardScoped: true });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.query;
};

test("the Priority dropdown is the app's select: No priority, Urgent, High, Medium, Low, each with its icon", () => {
  const closed = renderToStaticMarkup(<PriorityPicker id="p" labelledBy="p-label" priority={null} onChange={noop} />);
  expect(closed).toContain('role="combobox"');
  expect(closed).toContain('aria-labelledby="p-label"');
  expect(closed).toContain('<span class="ui-select-value">No priority</span>');
  expect(closed).not.toContain("<select");
  const chosen = renderToStaticMarkup(<PriorityPicker id="p" labelledBy="p-label" priority="high" onChange={noop} />);
  expect(chosen).toContain('<span class="ui-select-value">High</span>');
  expect(chosen).toContain("task-priority-icon priority-high");
  const open = renderToStaticMarkup(<PriorityPicker id="p" labelledBy="p-label" priority="urgent" onChange={noop} presentation="popup" defaultOpen />);
  expect(open).toContain('role="listbox"');
  const labels = [...open.matchAll(/role="option"[^>]*aria-selected="(true|false)"[\s\S]*?class="ui-option-label">([^<]+)</g)].map((match) => `${match[2]}:${match[1]}`);
  expect(labels).toEqual(["No priority:false", "Urgent:true", "High:false", "Medium:false", "Low:false"]);
  for (const tone of ["none", "urgent", "high", "medium", "low"]) expect(open).toContain(`task-priority-icon priority-${tone}`);
});

test("the card shows Priority beside its dates and people; Flags no longer offer Urgent", () => {
  const detail = { ...card("k1", { priority: "medium" }), description: "" } as CardDetail;
  const markup = renderToStaticMarkup(<CardFields card={detail} userId={me} idPrefix="t" done={false} saving={false} onSave={async () => true} />);
  const at = (text: string) => markup.indexOf(text);
  expect(at('id="t-priority-label"')).toBeGreaterThan(at('for="t-due-input"'));
  expect(at('id="t-priority-label"')).toBeLessThan(at('for="t-assignees"'));
  expect(markup).toContain('<span class="ui-select-value">Medium</span>');
  expect(markup).not.toContain(">Urgent<");
  const flags = renderToStaticMarkup(<FlagPicker labelId="f" flags={[]} disabled={false} onCommit={async () => undefined} />);
  expect(flags).not.toContain("Urgent");
  expect(flags.match(/aria-pressed=/g)).toHaveLength(3);
  // A read-only role sees the word.
  const readOnly = renderToStaticMarkup(<CardFields card={{ ...detail, priority: "urgent" }} userId={me} idPrefix="r" done={false} saving={false} onSave={async () => true} readOnly />);
  expect(readOnly).toContain('aria-labelledby="r-priority-label">Urgent</p>');
  expect(renderToStaticMarkup(<CardFields card={{ ...detail, priority: null }} userId={me} idPrefix="r" done={false} saving={false} onSave={async () => true} readOnly />)).toContain(">No priority</p>");
});

test("the compact indicator names the priority and shows nothing without one", () => {
  expect(renderToStaticMarkup(<PriorityBadge priority="high" />)).toContain('role="img" aria-label="High priority" title="High priority"');
  expect(renderToStaticMarkup(<PriorityBadge priority={null} />)).toBe("");
  expect(renderToStaticMarkup(<PriorityBadge priority="bogus" />)).toBe("");
  expect(priorityLabel("none")).toBe("No priority");
});

test("+ Filter offers Priority before Flag; values OR together; the chip reads as a sentence", () => {
  expect(Object.keys(FILTER_FIELDS).indexOf("priority")).toBe(Object.keys(FILTER_FIELDS).indexOf("flag") - 1);
  expect(FILTER_FIELDS.priority!.optionsFor(board, context).map((option) => option.label)).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
  const markup = renderToStaticMarkup(<FilterBar board={board} context={context} filter={query("priority:high,urgent")} onChange={noop} shown={2} total={3} />);
  expect(markup).toContain(">Priority is Urgent, High<");
  expect(chipLabel(query("-priority:none").terms[0]!, board, context)).toBe("Priority is not No priority");
  expect(filterBoardCards(board, query("priority:urgent,high"), context).map((item) => item.id)).toEqual(["u", "h"]);
  expect(filterBoardCards(board, query("priority:none"), context).map((item) => item.id)).toEqual(["n"]);
  expect(homeValueLabel("priority", "low", { board: String, column: String, user: String, tag: String } as never)).toBe("Low");
});

test("the filter, sort, and group live in the URL; a legacy flag=urgent or flag:urgent link reads as priority:urgent", () => {
  const search = "?q=priority:urgent,high&sort=priority:asc&group=priority&view=list";
  const parsed = parseBoardSearch(search);
  expect(format(parsed.filter)).toBe("priority:urgent,high");
  expect(parsed.sort).toEqual({ field: "priority", direction: "asc" });
  expect(parsed.group).toBe("priority");
  const canonical = formatBoardSearch(parsed);
  expect(canonical).toBe("?view=list&group=priority&sort=priority:asc&q=priority:urgent,high");
  expect(formatBoardSearch(parseBoardSearch(canonical))).toBe(canonical);
  expect(formatBoardSearch(parseBoardSearch("?flag=urgent"))).toBe("?q=priority:urgent");
  expect(formatBoardSearch(parseBoardSearch("?q=flag:urgent"))).toBe("?q=priority:urgent");
  expect(formatBoardSearch(parseBoardSearch("?q=-flag:urgent"))).toBe("?q=-priority:urgent");
  // Mixed with another flag it stays a flag term ("blocked or urgent"), matched against the priority.
  const mixed = parseBoardSearch("?q=flag:urgent,blocked");
  expect(format(mixed.filter)).toBe("flag:urgent,blocked");
  expect(filterBoardCards(board, mixed.filter, context).map((item) => item.id)).toEqual(["u", "h"]);
  expect(SORT_LABELS.priority).toBe("Priority");
});

test("history reads set, changed, and cleared priorities, and old Urgent flag entries", () => {
  const text = (kind: keyof typeof ACTIVITY_RENDERERS, payload: Record<string, unknown>) => renderToStaticMarkup(<>{ACTIVITY_RENDERERS[kind].text(payload)}</>).replace(/<[^>]+>/g, "");
  expect(text("priority", { from: null, to: { id: "high", label: "High" } })).toBe("set the priority to High");
  expect(text("priority", { from: { id: "high", label: "High" }, to: { id: "urgent", label: "Urgent" } })).toBe("changed the priority from High to Urgent");
  expect(text("priority", { from: { id: "low", label: "Low" }, to: null })).toBe("cleared the priority (was Low)");
  expect(text("flag_set", { item: { id: "urgent", label: "urgent" } })).toBe("flagged this Urgent");
});

test("the composer carries a priority into the one create request", () => {
  let draft = emptyDraft("c1");
  expect(draft.priority).toBeNull();
  draft = applyFieldChange(draft, { priority: "low" });
  expect(draft.priority).toBe("low");
  expect(composerDirty(draft)).toBe(true);
  expect(createBody(draft, "New")).toMatchObject({ priority: "low" });
  expect(createBody(applyFieldChange(draft, { priority: null }), "New").priority).toBeUndefined();
  expect(applyFieldChange(draft, { priority: "soon" }).priority).toBeNull();
  // A view's single priority starts the card with it, and is not a change until it changes.
  const prefilled = emptyDraft("c1", {}, { priority: "high" });
  expect(prefilled.priority).toBe("high");
  expect(composerDirty(prefilled, { priority: "high" })).toBe(false);
});
