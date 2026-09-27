import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { popStateClosedDialog, registerHistoryDialogGuard } from "../src/historyDialogs";
import { CardFields } from "../src/tasks/CardFields";
import { applyFieldChange, emptyDraft } from "../src/tasks/composerDraft";
import { draftDateValid, dueChange, dueTriggerLabel, DuePicker, initialDueDraft, quickPickDate } from "../src/tasks/DuePicker";
import { viewerTimeZone } from "../src/tasks/taskActions";
import type { CardDetail } from "../src/tasks/tasksApi";
import { createDialogGuard } from "../src/tasks/useHistoryDialogGuard";

// The Due field saves only on Apply (operator QA 0.9.1): one change per Apply, nothing on blur,
// Cancel/Escape/Back discard.

const noop = () => undefined;
const zone = "Europe/Berlin";
const card: CardDetail = {
  id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Pay rent", has_description: 0, revision: 3, created_by: "u1", creator_name: "Ann",
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null,
  comment_count: 0, attachment_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", description: ""
};
const timed = { due_on: "2026-10-03", due_time: "18:45", due_tz: zone, due_at: "2026-10-03T16:45:00.000Z" };

test("quick picks count from the viewer's today, across month ends", () => {
  expect(quickPickDate("today", "2026-09-27")).toBe("2026-09-27");
  expect(quickPickDate("tomorrow", "2026-09-30")).toBe("2026-10-01");
  expect(quickPickDate("next-week", "2026-12-28")).toBe("2027-01-04");
});

test("Apply sends one change: date, date with time, time only, removals, and nothing when unchanged", () => {
  const none = { due_on: null };
  expect(dueChange(none, { date: "", time: "", withTime: false }, zone)).toBeNull();
  expect(dueChange(none, { date: "2026-10-03", time: "", withTime: false }, zone)).toEqual({ change: { dueOn: "2026-10-03" }, success: "Due date saved" });
  expect(dueChange(none, { date: "2026-10-03", time: "18:45", withTime: true }, zone))
    .toEqual({ change: { dueOn: "2026-10-03", dueTime: "18:45", dueTz: zone }, success: "Due date and time saved" });
  // Add time switched on but left empty: just the date.
  expect(dueChange(none, { date: "2026-10-03", time: "", withTime: true }, zone)?.change).toEqual({ dueOn: "2026-10-03" });

  expect(dueChange(timed, initialDueDraft(timed), zone)).toBeNull();
  expect(dueChange(timed, { ...initialDueDraft(timed), time: "09:00" }, zone)).toEqual({ change: { dueTime: "09:00", dueTz: zone }, success: "Due time saved" });
  expect(dueChange(timed, { ...initialDueDraft(timed), withTime: false }, zone)).toEqual({ change: { dueTime: null }, success: "Due time removed" });
  expect(dueChange(timed, { date: "2026-10-04", time: "18:45", withTime: true }, zone)).toEqual({ change: { dueOn: "2026-10-04" }, success: "Due date saved" });
  expect(dueChange(timed, { date: "", time: "", withTime: false }, zone)).toEqual({ change: { dueOn: null }, success: "Due date removed" });
  // A card timed in another zone keeps its zone when only the date moves (D115).
  expect(dueChange(timed, { date: "2026-10-05", time: "18:45", withTime: true }, "Asia/Tokyo")?.change).toEqual({ dueOn: "2026-10-05" });
  // An edited time is set in the viewer's zone.
  expect(dueChange(timed, { date: "2026-10-03", time: "10:00", withTime: true }, "Asia/Tokyo")?.change).toEqual({ dueTime: "10:00", dueTz: "Asia/Tokyo" });
  // A half-typed or impossible date waits.
  for (const date of ["2026-02-30", "0001-01-01", "2026-1-1"]) {
    expect(draftDateValid({ date, time: "", withTime: false })).toBe(false);
    expect(dueChange(none, { date, time: "", withTime: false }, zone)).toBeNull();
  }
});

test("each Apply goes through the composer's draft the same way as a saved card", () => {
  const draft = emptyDraft("c1");
  const withTime = applyFieldChange(draft, dueChange({ due_on: null }, { date: "2026-10-03", time: "18:45", withTime: true }, zone)!.change);
  expect([withTime.dueOn, withTime.dueTime, withTime.dueTz]).toEqual(["2026-10-03", "18:45", zone]);
  const cleared = applyFieldChange(withTime, dueChange({ due_on: withTime.dueOn, due_time: withTime.dueTime, due_tz: withTime.dueTz }, { date: "", time: "", withTime: false }, zone)!.change);
  expect([cleared.dueOn, cleared.dueTime, cleared.dueTz]).toEqual([null, null, null]);
});

test("the trigger names the value: no due date, a day, or a day at a time", () => {
  expect(dueTriggerLabel({ due_on: null }, "2026-09-27", zone)).toBe("No due date");
  expect(dueTriggerLabel({ due_on: "2026-10-03" }, "2026-09-27", zone)).toBe(new Date(2026, 9, 3).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  expect(dueTriggerLabel(timed, "2026-09-27", zone)).toMatch(/ at 18:45$/);
  // Another zone: the viewer's local time of the instant.
  expect(dueTriggerLabel(timed, "2026-09-27", "Asia/Tokyo")).toMatch(/ at 01:45$/);
  expect(dueTriggerLabel({ due_on: "2027-01-02" }, "2026-09-27", zone)).toContain("2027");
});

test("closed, the field is a trigger button with no date input; open, the editor has quick picks, Add time, Apply, and Cancel", () => {
  const closed = renderToStaticMarkup(<CardFields card={card} userId="u1" idPrefix="t" done={false} saving={false} onSave={async () => true} />);
  expect(closed).toMatch(/<button id="t-due-input" type="button" class="task-due-trigger empty" aria-haspopup="dialog" aria-expanded="false" aria-describedby="t-due">/);
  expect(closed).toContain("<span>No due date</span>");
  expect(closed).not.toContain('type="date"');
  expect(closed).toContain('<label for="t-due-input">');

  const open = renderToStaticMarkup(<DuePicker card={{ ...card, due_on: "2999-01-01" }} idPrefix="t" done={false} disabled={false} onApply={async () => true} presentation="popup" defaultOpen />);
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('role="dialog" aria-label="Due date"');
  expect([...open.matchAll(/class="task-due-quick-pick[^"]*"[^>]*>([^<]+)</g)].map((match) => match[1])).toEqual(["Today", "Tomorrow", "Next week", "Clear"]);
  expect(open).toMatch(/type="date"[^>]*value="2999-01-01"/);
  expect(open).toContain(">Add time</button>");
  expect(open).not.toContain('type="time"');
  expect(open).toMatch(/>Cancel<\/button><button type="button" class="primary-button"[^>]*>Apply<\/button>/);

  const zoneHere = viewerTimeZone();
  const withTime = renderToStaticMarkup(<DuePicker card={{ ...card, due_on: "2999-01-01", due_time: "17:00", due_tz: zoneHere, due_at: "2999-01-01T17:00:00.000Z" }} idPrefix="t" done={false} disabled={false} onApply={async () => true} presentation="popup" defaultOpen />);
  expect(withTime).toContain('type="time"');
  expect(withTime).toContain('value="17:00"');
  expect(withTime).toContain("Remove time</button>");
  expect(withTime).not.toContain("Changing the time uses your zone");
  const elsewhere = renderToStaticMarkup(<DuePicker card={{ ...card, due_on: "2999-01-01", due_time: "17:30", due_tz: zoneHere === "Asia/Tokyo" ? "Europe/Berlin" : "Asia/Tokyo", due_at: "2999-01-01T08:30:00.000Z" }} idPrefix="t" done={false} disabled={false} onApply={async () => true} presentation="popup" defaultOpen />);
  expect(elsewhere).toMatch(/Set as 17:30 (Asia\/Tokyo|Europe\/Berlin) \(.*your time\)\. Changing the time uses your zone/);
});

test("on a phone the editor is a bottom sheet with Apply and Cancel in its footer", () => {
  const markup = renderToStaticMarkup(<DuePicker card={card} idPrefix="t" done={false} disabled={false} onApply={async () => true} presentation="sheet" defaultOpen />);
  expect(markup).toContain('role="dialog" aria-modal="true" aria-label="Due date"');
  expect(markup).toMatch(/class="ui-sheet-footer task-due-sheet-footer"><footer class="task-due-actions"><button[^>]*>Cancel<\/button><button[^>]*>Apply<\/button>/);
  // With no date there is nothing to Clear and no time to add.
  expect(markup).toMatch(/<button type="button" class="task-due-quick-pick" disabled="">Clear<\/button>/);
  expect(markup).toMatch(/<button type="button" class="task-add-time" disabled="">/);
});

test("Back closes the open due editor first, without saving, then the card", () => {
  let cardAsked = 0;
  let applied = 0;
  const unregisterCard = registerHistoryDialogGuard(() => { cardAsked += 1; return true; });
  let open = true;
  const closed: string[] = [];
  const unregisterDue = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => { open = false; }, close: () => { closed.push("due editor"); }, openDepth: () => 2, undo: noop
  }));
  expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
  expect(closed).toEqual(["due editor"]);
  expect(applied).toBe(0);
  expect(cardAsked).toBe(0);
  unregisterDue();
  expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
  expect(cardAsked).toBe(1);
  unregisterCard();
});
