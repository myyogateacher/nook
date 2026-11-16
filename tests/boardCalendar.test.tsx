import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../shared/taskQuery";
import { BoardCalendar } from "../src/tasks/BoardCalendar";
import { cardsDueInMonth, displayedDay, displayedTime, dropDueOn, dueAnnouncement, emptyMonthNote, keyboardDayDelta, placeCards, selectGridDay, shiftedDueAt } from "../src/tasks/calendarPlacement";
import { monthHeading } from "../src/calendar/calendarFormat";
import { boardData, filterBoardCards, type BoardContext } from "../src/tasks/boardQuery";
import type { CardSummary } from "../src/tasks/tasksApi";

// WAVE_13_TASK_CARD_UX.md §4.5a, D115, §7 `tests/boardCalendar.test.ts`.
const me = "11111111-1111-4111-8111-111111111111";
const todo = "aaaaaaaa-0000-4000-8000-000000000001";
const done = "aaaaaaaa-0000-4000-8000-000000000003";
const card = (id: string, change: Record<string, unknown> = {}) => ({
  id, board_id: "b", column_id: todo, position: 1, title: id, has_description: 0, revision: 1, created_by: me, creator_name: "Me",
  due_on: null, assignees: [], assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0,
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", ...change
}) as CardSummary;
// Due 23:30 on 6 March at UTC+14 = 09:30 UTC on 6 March = 21:30 on 5 March at UTC−12.
const kiritimati = { due_on: "2026-03-06", due_time: "23:30", due_tz: "Pacific/Kiritimati", due_at: "2026-03-06T09:30:00.000Z" };
const board = boardData({
  columns: [{ id: todo, board_id: "b", name: "To do", position: 1, is_done: 0, created_at: "", updated_at: "" }, { id: done, board_id: "b", name: "Done", position: 2, is_done: 1, created_at: "", updated_at: "" }],
  cards: [
    card("date", { due_on: "2026-03-06", priority: "urgent" }),
    card("timed", { ...kiritimati, title: "Late <b>call</b>" }),
    card("none", { title: "Someday" }),
    card("shipped", { column_id: done, due_on: "2026-03-10" })
  ]
});

test("date-only cards sit on due_on; timed cards on the viewer-local date and time; the rest are unscheduled", () => {
  expect(displayedDay(board.cards[0]!, "Etc/GMT+12")).toBe("2026-03-06");
  expect(displayedDay(board.cards[1]!, "Pacific/Kiritimati")).toBe("2026-03-06");
  expect(displayedDay(board.cards[1]!, "Etc/GMT+12")).toBe("2026-03-05");
  expect(displayedTime(board.cards[1]!, "Etc/GMT+12")).toBe("21:30");
  expect(displayedTime(board.cards[0]!, "UTC")).toBeNull();
  const west = placeCards(board.cards, "Etc/GMT+12");
  expect(west.byDay.get("2026-03-05")?.map((item) => item.id)).toEqual(["timed"]);
  expect(west.byDay.get("2026-03-06")?.map((item) => item.id)).toEqual(["date"]);
  expect(west.unscheduled.map((item) => item.id)).toEqual(["none"]);
  // Same day: date-only first, then by time.
  const east = placeCards(board.cards, "Pacific/Kiritimati");
  expect(east.byDay.get("2026-03-06")?.map((item) => item.id)).toEqual(["date", "timed"]);
});

test("filters apply before placement", () => {
  const context: BoardContext = { userId: me, today: "2026-03-01", now: Date.parse("2026-03-01T00:00:00Z"), timeZone: "UTC" };
  const parsed = parse("flag:urgent", { boardScoped: true });
  if (!parsed.ok) throw new Error("parse");
  const placed = placeCards(filterBoardCards(board, parsed.query, context), "UTC");
  expect([...placed.byDay.keys()]).toEqual(["2026-03-06"]);
  expect(placed.unscheduled).toEqual([]);
});

test("a drop shifts the civil date by the displayed-day delta, keeping the time and zone", () => {
  const timed = board.cards[1]!;
  // Shown on the 5th for a UTC−12 viewer; dropped on the 7th is two days later: the 8th in its own zone.
  expect(dropDueOn(timed, "2026-03-07", "Etc/GMT+12")).toBe("2026-03-08");
  expect(dropDueOn(timed, "2026-03-05", "Etc/GMT+12")).toBeNull();
  expect(dropDueOn(board.cards[0]!, "2026-02-27", "UTC")).toBe("2026-02-27");
  // An unscheduled card takes the day itself.
  expect(dropDueOn(board.cards[2]!, "2026-03-09", "UTC")).toBe("2026-03-09");
  expect(shiftedDueAt(timed.due_at, 2)).toBe("2026-03-08T09:30:00.000Z");
  expect(shiftedDueAt(null, 2)).toBeNull();
});

test("Alt+Arrow targets a day or a week, and the move is announced", () => {
  expect([keyboardDayDelta("ArrowLeft"), keyboardDayDelta("ArrowRight"), keyboardDayDelta("ArrowUp"), keyboardDayDelta("ArrowDown"), keyboardDayDelta("Enter")]).toEqual([-1, 1, -7, 7, null]);
  expect(dueAnnouncement("2026-10-03", null)).toMatch(/^Due Saturday,? 3 October$|^Due Saturday, October 3$/);
  expect(dueAnnouncement("2026-10-03", "17:30")).toContain("at 17:30");
  expect(dueAnnouncement(null, null)).toBe("No due date");
});

test("the view says linked events stay in Calendar, holds the Unscheduled tray, and renders titles as text", () => {
  const markup = renderToStaticMarkup(<BoardCalendar board={board} cards={board.cards} layout="month" month="2026-03" today="2026-03-02" viewerZone="Etc/GMT+12" filtered={false}
    onMonth={() => undefined} onLayout={() => undefined} onOpenCard={() => undefined} onSetDue={() => undefined} />);
  expect(markup).toContain("Due dates of cards on this board. Events linked to cards are in Calendar.");
  expect(markup).toContain('role="radiogroup" aria-label="Calendar layout"');
  expect(markup).toContain('<h3 id="task-cal-tray-title">Unscheduled');
  expect(markup).toContain("Cards without a due date. Drag one onto a day to schedule it.");
  expect(markup).toContain('aria-label="Set due date for “Someday”"');
  expect(markup).toContain('aria-label="Late &lt;b&gt;call&lt;/b&gt;, due at 21:30, set as 23:30 Pacific/Kiritimati (21:30 your time)"');
  expect(markup).not.toContain("<b>call");
  expect(markup).toContain('class="task-cal-chip done"');
  expect(markup).toContain('data-day="2026-03-05"');
  expect(markup).toContain('aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"');
  const empty = renderToStaticMarkup(<BoardCalendar board={board} cards={[]} layout="month" month="2026-05" today="2026-03-02" viewerZone="UTC" filtered={false}
    onMonth={() => undefined} onLayout={() => undefined} onOpenCard={() => undefined} onSetDue={() => undefined} />);
  expect(empty).toContain(`No cards are due in ${monthHeading("2026-05")}.`);
  const agenda = renderToStaticMarkup(<BoardCalendar board={board} cards={board.cards} layout="agenda" month={null} today="2026-03-02" viewerZone="UTC" filtered={false}
    onMonth={() => undefined} onLayout={() => undefined} onOpenCard={() => undefined} onSetDue={() => undefined} />);
  expect(agenda).toContain('<section class="calendar-agenda" aria-label="Cards by due date">');
  expect(agenda).toContain('aria-labelledby="task-agenda-2026-03-06"');
});

test("tapping another month's day pages there and selects it instead of snapping back to Today", () => {
  // A trailing day of March shown in the April grid, with today in March: back to the current month (null).
  expect(selectGridDay("2026-03-30", "2026-04", "2026-03-02")).toEqual({ selected: "2026-03-30", month: null });
  // A leading day of May, from April: page to May.
  expect(selectGridDay("2026-05-02", "2026-04", "2026-03-02")).toEqual({ selected: "2026-05-02", month: "2026-05" });
  // A day of the month shown: only the selection changes.
  expect(selectGridDay("2026-04-15", "2026-04", "2026-03-02")).toEqual({ selected: "2026-04-15" });
});

test("the month summary counts only the month's own cards, and its note names the month", () => {
  const byDay = new Map<string, unknown[]>([["2026-04-30", [1, 2]], ["2026-05-01", [3]], ["2026-06-01", [4]]]);
  expect(cardsDueInMonth(byDay, "2026-05")).toBe(1);
  // May's grid shows April 30 and June 1 dots, yet May itself has none of them.
  expect(cardsDueInMonth(new Map([["2026-04-30", [1]], ["2026-06-01", [2]]]), "2026-05")).toBe(0);
  expect(emptyMonthNote("2026-05", false)).toBe(`No cards are due in ${monthHeading("2026-05")}.`);
  expect(emptyMonthNote("2026-05", true)).toBe(`No matching cards are due in ${monthHeading("2026-05")}.`);
  const markup = renderToStaticMarkup(<BoardCalendar board={board} cards={board.cards} layout="month" month="2026-02" today="2026-03-02" viewerZone="UTC" filtered={false}
    onMonth={() => undefined} onLayout={() => undefined} onOpenCard={() => undefined} onSetDue={() => undefined} />);
  // February's grid ends with March days that have cards, but February has none.
  expect(markup).toContain(`No cards are due in ${monthHeading("2026-02")}.`);
});
