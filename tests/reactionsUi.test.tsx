import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { popStateClosedDialog, registerHistoryDialogGuard } from "../src/historyDialogs";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";
import { REACTION_GRID_COLUMNS, ReactionPicker, reactionGridMove } from "../src/ui/ReactionPicker";
import { CommentReactions } from "../src/tasks/CommentReactions";
import { reactionChipLabel, reactionPeople, replaceAggregate, toggleAggregate } from "../src/tasks/reactionsModel";
import { REACTIONS, type ReactionAggregate } from "../shared/reactions";

/** Wave 20 UI (WAVES_18-20_SMALL.md §3.5, §3.7 "UI"). */
const noop = () => undefined;
const thumbs: ReactionAggregate = { emoji: "thumbs_up", count: 3, reacted: true, names: ["Asha", "Ben"], more: 0 };
const heart: ReactionAggregate = { emoji: "heart", count: 1, reacted: false, names: ["Asha"], more: 0 };
const choices = REACTIONS.map((reaction) => ({ key: reaction.key, glyph: reaction.glyph, label: reaction.label, pressed: reaction.key === "heart" }));
const ref = { current: null };

test("toggle is optimistic set-state: add, remove, drop at zero, join someone else's", () => {
  expect(toggleAggregate([], "tada")).toEqual({ next: [{ emoji: "tada", count: 1, reacted: true, names: [], more: 0 }], on: true });
  expect(toggleAggregate([thumbs, heart], "thumbs_up")).toEqual({ next: [{ ...thumbs, count: 2, reacted: false }, heart], on: false });
  expect(toggleAggregate([heart], "heart")).toEqual({ next: [{ ...heart, count: 2, reacted: true }], on: true });
  expect(toggleAggregate([{ ...heart, reacted: true, names: [] }], "heart")).toEqual({ next: [], on: false });
});

test("replace touches only its emoji, so out-of-order answers for different emoji never undo each other", () => {
  expect(replaceAggregate([thumbs, heart], "heart", undefined)).toEqual([thumbs]);
  expect(replaceAggregate([thumbs], "heart", heart, 0)).toEqual([heart, thumbs]);
  expect(replaceAggregate([thumbs], "heart", heart)).toEqual([thumbs, heart]);
  expect(replaceAggregate([thumbs, heart], "thumbs_up", { ...thumbs, count: 9 })).toEqual([{ ...thumbs, count: 9 }, heart]);
  expect(replaceAggregate([thumbs], "eyes", undefined)).toEqual([thumbs]);
});

test("names read as a sentence and the chip label says what a press does", () => {
  expect(reactionPeople(thumbs)).toBe("Asha, Ben, and you");
  expect(reactionPeople({ ...heart, reacted: true })).toBe("Asha and you");
  expect(reactionPeople({ ...heart, names: [], reacted: true })).toBe("you");
  expect(reactionPeople({ ...heart, count: 12, names: ["A", "B"], more: 10 })).toBe("A, B, and 10 others");
  expect(reactionPeople({ ...heart, count: 2, names: ["A"], more: 1 })).toBe("A and 1 other");
  expect(reactionChipLabel(thumbs, false)).toBe("👍 3: Asha, Ben, and you. Press to remove yours.");
  expect(reactionChipLabel(heart, false)).toBe("❤️ 1: Asha. Press to add yours.");
  expect(reactionChipLabel(heart, true)).toBe("❤️ 1: Asha.");
});

test("chips are toggle buttons with aria-pressed and the count; Add reaction sits last", () => {
  const markup = renderToStaticMarkup(<CommentReactions commentId="m1" reactions={[thumbs, heart]} readOnly={false} onUpdate={noop} notify={noop} />);
  expect(markup).toContain('class="task-reactions" role="group" aria-label="Reactions"');
  expect(markup).toContain('class="task-reaction-chip reacted" aria-pressed="true" aria-label="👍 3: Asha, Ben, and you. Press to remove yours."');
  expect(markup).toContain('class="task-reaction-chip" aria-pressed="false" aria-label="❤️ 1: Asha. Press to add yours."');
  expect(markup).toContain('<span aria-hidden="true">3</span>');
  expect(markup.indexOf('aria-label="Add reaction"')).toBeGreaterThan(markup.lastIndexOf("task-reaction-chip"));
  // The picker is not rendered until opened.
  expect(markup).not.toContain("ui-reaction-grid");
  // No reactions: only the Add button, in the "empty" row that desktop shows on hover or focus.
  const empty = renderToStaticMarkup(<CommentReactions commentId="m1" reactions={[]} readOnly={false} onUpdate={noop} notify={noop} />);
  expect(empty).toContain('class="task-reactions empty"');
  expect(empty).toContain('aria-label="Add reaction"');
  expect(empty).not.toContain("task-reaction-chip");
});

test("read-only roles see static chips with no button role and no picker", () => {
  const markup = renderToStaticMarkup(<CommentReactions commentId="m1" reactions={[thumbs]} readOnly onUpdate={noop} notify={noop} />);
  expect(markup).toContain('class="task-reaction-chip static" role="img" aria-label="👍 3: Asha, Ben, and you."');
  expect(markup).not.toContain("<button");
  expect(markup).not.toContain("aria-pressed");
  expect(markup).not.toContain("Add reaction");
  expect(renderToStaticMarkup(<CommentReactions commentId="m1" reactions={[]} readOnly onUpdate={noop} notify={noop} />)).toBe("");
});

test("the desktop popover is a 4 × 3 grid of pressed-aware buttons with one tab stop", () => {
  const markup = renderToStaticMarkup(<ReactionPicker choices={choices} anchorRef={ref} containerRef={ref} onPick={noop} onClose={noop} presentation="popup" />);
  expect(markup).toContain('class="ui-popup"');
  expect(markup).not.toContain("ui-sheet");
  expect(markup).toContain('class="ui-reaction-grid" role="group" aria-label="Add reaction"');
  expect(markup.match(/class="ui-reaction-choice/g)?.length).toBe(12);
  expect(markup.match(/tabindex="0"/g)?.length).toBe(1);
  expect(markup).toContain('class="ui-reaction-choice pressed" tabindex="-1" aria-pressed="true" aria-label="Heart"');
  expect(markup).toContain('aria-pressed="false" aria-label="Thumbs up"');
  expect(markup).not.toContain("<select");
});

test("the phone sheet is a dialog whose header lists the current reactions with names", () => {
  const summary = <ul className="task-reaction-summary"><li>👍 3 Asha, Ben, and you</li></ul>;
  const markup = renderToStaticMarkup(<ReactionPicker choices={choices} anchorRef={ref} containerRef={ref} onPick={noop} onClose={noop} presentation="sheet" sheetSummary={summary} />);
  expect(markup).toContain('class="ui-sheet-layer"');
  expect(markup).toContain('role="dialog" aria-modal="true" aria-label="Add reaction"');
  expect(markup).toContain("Asha, Ben, and you");
  expect(markup.indexOf("task-reaction-summary")).toBeLessThan(markup.indexOf("ui-reaction-grid"));
  expect(markup).not.toContain('class="ui-popup"');
  // The summary is for the sheet only.
  expect(renderToStaticMarkup(<ReactionPicker choices={choices} anchorRef={ref} containerRef={ref} onPick={noop} onClose={noop} presentation="popup" sheetSummary={summary} />)).not.toContain("task-reaction-summary");
});

test("grid keys: arrows move by one or a row without wrapping, Home and End jump, others are ignored", () => {
  expect(REACTION_GRID_COLUMNS).toBe(4);
  expect(reactionGridMove(12, 0, "ArrowRight")).toBe(1);
  expect(reactionGridMove(12, 0, "ArrowLeft")).toBe(0);
  expect(reactionGridMove(12, 11, "ArrowRight")).toBe(11);
  expect(reactionGridMove(12, 1, "ArrowDown")).toBe(5);
  expect(reactionGridMove(12, 9, "ArrowDown")).toBe(9);
  expect(reactionGridMove(12, 5, "ArrowUp")).toBe(1);
  expect(reactionGridMove(12, 2, "ArrowUp")).toBe(2);
  expect(reactionGridMove(12, 6, "Home")).toBe(0);
  expect(reactionGridMove(12, 6, "End")).toBe(11);
  expect(reactionGridMove(12, 6, "Enter")).toBeNull();
  expect(reactionGridMove(12, 6, "a")).toBeNull();
});

test("at 390 px Back closes the picker sheet before the card, and Forward is undone the other way", () => {
  // The card view registered its guard first; the sheet's guard (DropdownSheet, D69) is newer.
  let cardAsked = 0;
  const unregisterCard = registerHistoryDialogGuard(() => { cardAsked += 1; return true; });
  let open = true;
  let closed = 0;
  const undone: string[] = [];
  const unregisterSheet = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => { open = false; }, close: () => { closed += 1; }, openDepth: () => 3, undo: (direction) => { undone.push(direction); }
  }));
  expect(popStateClosedDialog({ state: { "mynotes.depth": 2 } })).toBe(true);
  expect([closed, cardAsked, undone]).toEqual([1, 0, ["back"]]);
  unregisterSheet();
  // The next Back belongs to the card.
  expect(popStateClosedDialog({ state: { "mynotes.depth": 2 } })).toBe(true);
  expect(cardAsked).toBe(1);
  unregisterCard();
  open = true;
  const again = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => { open = false; }, close: () => { closed += 1; }, openDepth: () => 3, undo: (direction) => { undone.push(direction); }
  }));
  expect(popStateClosedDialog({ state: { "mynotes.depth": 4 } })).toBe(true);
  expect(undone).toEqual(["back", "forward"]);
  again();
});
