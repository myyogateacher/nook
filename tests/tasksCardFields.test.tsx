import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssigneePicker, CardFields } from "../src/tasks/CardFields";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { assigneeLabel, assigneeSentence, cardAssignees, committableDueTime, dueStatus, dueTimeNote, instantParts, sameIds, viewerTimeZone } from "../src/tasks/taskActions";
import type { CardDetail } from "../src/tasks/tasksApi";

const noop = () => undefined;
const card: CardDetail = {
  id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Pay rent", has_description: 0, revision: 3, created_by: "u1", creator_name: "Ann",
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null,
  comment_count: 0, attachment_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", description: ""
};

test("a timed due chip uses the viewer's local day and time of the instant", () => {
  // 16:00Z is 17:00 in Berlin in March.
  const timing = { dueAt: "2026-03-05T16:00:00.000Z", timeZone: "Europe/Berlin" };
  expect(dueStatus("2026-03-05", "2026-03-05", false, { ...timing, now: Date.parse("2026-03-05T12:00:00Z") }))
    .toEqual({ tone: "today", label: "Today 17:00", description: "Due today at 17:00" });
  expect(dueStatus("2026-03-05", "2026-03-05", false, { ...timing, now: Date.parse("2026-03-05T16:00:00Z") }))
    .toEqual({ tone: "overdue", label: "Today 17:00", description: "Overdue, was due today at 17:00" });
  expect(dueStatus("2026-03-05", "2026-03-04", false, { ...timing, now: Date.parse("2026-03-04T12:00:00Z") })?.label).toBe("Tomorrow 17:00");
  expect(dueStatus("2026-03-05", "2026-03-05", true, timing)).toBeNull();
});

test("a card due 23:30 at UTC+14 falls on the previous local day for a UTC−12 viewer", () => {
  // 2026-03-06 23:30 at UTC+14 is 2026-03-06 09:30Z, which is 2026-03-05 21:30 at UTC−12.
  const dueAt = "2026-03-06T09:30:00.000Z";
  expect(instantParts(dueAt, "Pacific/Kiritimati")).toEqual({ date: "2026-03-06", time: "23:30" });
  const west = dueStatus("2026-03-06", "2026-03-05", false, { dueAt, timeZone: "Etc/GMT+12", now: Date.parse("2026-03-05T12:00:00Z") });
  expect(west).toEqual({ tone: "today", label: "Today 21:30", description: "Due today at 21:30" });
});

test("date-only cards keep the date chip, and an undated card has none", () => {
  expect(dueStatus("2026-03-05", "2026-03-05", false, { dueAt: null })).toEqual({ tone: "today", label: "Today", description: "Due today" });
  expect(dueStatus(null, "2026-03-05", false, { dueAt: "2026-03-05T16:00:00Z" })).toBeNull();
});

test("the time field saves only a complete changed HH:MM", () => {
  const saved = { time: "17:00", zone: "Europe/Berlin" };
  expect(committableDueTime("17:00", saved, "Europe/Berlin")).toBeNull();
  expect(committableDueTime("17:00", saved, "America/New_York")).toBe("17:00");
  expect(committableDueTime("18:30", saved, "Europe/Berlin")).toBe("18:30");
  expect(committableDueTime("18:30:00", saved, "Europe/Berlin")).toBe("18:30");
  for (const bad of ["", "24:00", "9:05", "18:3", "18:30:15"]) expect(committableDueTime(bad, saved, "Europe/Berlin")).toBeNull();
  expect(committableDueTime("08:00", { time: null, zone: null }, "UTC")).toBe("08:00");
});

test("the zone note names the card's zone and the viewer's time only when they differ", () => {
  const timed = { due_time: "17:00", due_tz: "Europe/Berlin", due_at: "2026-03-05T16:00:00.000Z" };
  expect(dueTimeNote(timed, "Europe/Berlin")).toBe("17:00");
  expect(dueTimeNote(timed, "America/New_York")).toBe("17:00 Europe/Berlin (11:00 your time)");
  expect(dueTimeNote({ ...timed, due_time: "00:30", due_at: "2026-03-04T23:30:00.000Z" }, "America/New_York")).toMatch(/^00:30 Europe\/Berlin \(\S+ 18:30 your time\)$/);
  expect(dueTimeNote({ due_time: null, due_tz: null, due_at: null })).toBeNull();
});

test("assignee copy: sentences, no assignees, and lost access", () => {
  expect(assigneeSentence([])).toBe("");
  expect(assigneeSentence(["Asha"])).toBe("Asha");
  expect(assigneeSentence(["Asha", "Ben"])).toBe("Asha and Ben");
  expect(assigneeSentence(["Asha", "Ben", "Chen"])).toBe("Asha, Ben, and Chen");
  expect(assigneeSentence(["Asha", "Ben", "Chen", "Dee"])).toBe("Asha, Ben, and 2 others");
  // The deprecated single-assignee fields are gone since v0.9.0 (D113 trim): no assignees means none.
  expect(cardAssignees({})).toEqual([]);
  expect(cardAssignees({ assignees: [] })).toEqual([]);
  expect(assigneeLabel({ id: "u2", display_name: "Bo", can_read: 0 })).toBe("Bo (no access)");
  expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
});

test("card fields: the due field is a trigger showing the value and the zone note; the editor opens on demand", () => {
  const empty = renderToStaticMarkup(<CardFields card={card} userId="u1" idPrefix="t" done={false} saving={false} onSave={async () => true} />);
  expect(empty).toContain("No due date");
  expect(empty).not.toContain("Add time");
  expect(empty).not.toContain("<select");
  expect(empty).not.toContain('type="date"');
  const zone = viewerTimeZone();
  const timed = renderToStaticMarkup(<CardFields card={{ ...card, due_on: "2999-01-01", due_time: "17:00", due_tz: zone, due_at: "2999-01-01T17:00:00.000Z" }} userId="u1" idPrefix="t" done={false} saving={false} onSave={async () => true} />);
  expect(timed).toMatch(/class="task-due-trigger"[^>]*>.*<span>[^<]+ at \d\d:\d\d<\/span>/);
  expect(timed).not.toContain('type="time"');
  expect(timed).not.toContain("Set as");
  const elsewhere = renderToStaticMarkup(<CardFields card={{ ...card, due_on: "2999-01-01", due_time: "17:00", due_tz: zone === "Asia/Tokyo" ? "Europe/Berlin" : "Asia/Tokyo", due_at: "2999-01-01T08:00:00.000Z" }} userId="u1" idPrefix="t" done={false} saving={false} onSave={async () => true} />);
  expect(elsewhere).toMatch(/Set as 17:00 (Europe\/Berlin|Asia\/Tokyo) \(/);
});

test("the assignee picker is a multiple combobox with Remove chips and marks lost access", () => {
  const markup = renderToStaticMarkup(<AssigneePicker boardId="b1" userId="u1" inputId="t-assignees" disabled={false} onCommit={async () => undefined}
    assignees={[{ id: "u1", display_name: "Ann", can_read: 1 }, { id: "u2", display_name: "Bo", can_read: 0 }]} />);
  expect(markup).toContain('id="t-assignees"');
  expect(markup).toContain('role="combobox" aria-autocomplete="list"');
  expect(markup).toContain('aria-label="Remove Ann"');
  expect(markup).toContain('aria-label="Remove Bo (no access)"');
  expect(markup).toContain("they can no longer open this board");
  expect(markup).not.toContain("<select");
});

test("lane cards show every assignee to screen readers and a timed due chip", () => {
  const markup = renderToStaticMarkup(<BoardColumnView
    column={{ id: "c1", board_id: "b1", name: "To do", position: 1024, is_done: 0, wip_limit: null, created_at: "", updated_at: "" }}
    cards={[{ ...card, due_on: "2999-01-01", due_time: "09:15", due_tz: "UTC", due_at: "2999-01-01T09:15:00.000Z", assignees: [{ id: "u1", display_name: "Ann", can_read: 1 }, { id: "u2", display_name: "Bo", can_read: 1 }] }]}
    owner={false} isFirst isLast draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={async () => undefined} />);
  expect(markup).toContain("Assigned to Ann and Bo");
  // 13C: the face shows up to three avatars (initials) instead of the first name and "+1".
  expect(markup).toContain("assigned to Ann and Bo");
  expect(markup).toMatch(/class="task-avatar tone-\d">A<\/span><span class="task-avatar tone-\d">B<\/span>/);
  expect(markup).toContain(`at ${instantParts("2999-01-01T09:15:00.000Z", viewerTimeZone()).time}`);
});
