import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The card dialog is a right-hand drawer on desktop (operator QA 0.9.2): fixed to the right edge,
// the full viewport height, wider from 1100 and 1280 px, with the fields in their own scrolling
// column from 1100 px and a comment box that sticks to the bottom; full screen on phones; never
// transformed at rest (fixed popups inside place against the viewport).

const css = readFileSync(new URL("../src/tasks/tasks.css", import.meta.url), "utf8");
const block = (query: string) => {
  const start = css.indexOf(`@media (${query}) {\n  .task-card-modal`);
  expect(start, query).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start));
};

test("from 761 px the card is a full-height drawer on the right that slides in without a resting transform", () => {
  const drawer = block("min-width: 761px");
  const modal = drawer.slice(drawer.indexOf(".task-card-modal {"), drawer.indexOf("}", drawer.indexOf(".task-card-modal {")));
  expect(modal).toContain("inset-block: 0; right: 0; left: auto; margin: 0;");
  expect(modal).toContain("width: min(880px, 94vw); height: auto; max-height: none;");
  expect(modal).toContain("border-radius: 0;");
  // The slide animates `translate` for 180 ms only; no fill mode keeps it after the animation.
  expect(modal).toContain("animation: task-drawer-in 180ms ");
  expect(modal).not.toMatch(/forwards|both/);
  expect(css).toContain("@keyframes task-drawer-in { from { translate: 100% 0; } }");
  expect(drawer).toContain(".task-card-scrim { animation: task-scrim-in 180ms ease-out; }");
  // Reduced motion: no slide, no fade.
  expect(css).toContain("@media (min-width: 761px) and (prefers-reduced-motion: reduce) {\n  .task-card-modal, .task-card-scrim { animation: none; }\n}");
  // The comment box sticks to the bottom of the scroll, with the thread scrolling above it.
  expect(drawer).toContain(".task-card-modal .task-comment-composer { position: sticky; bottom: 0;");
  // Popups inside place against the viewport: no transform on the dialog, no container queries.
  expect(/\.task-card-(dialog|modal)[^{]*\{[^}]*transform/.test(css)).toBe(false);
  expect(css).not.toContain("@container");
  // The composer keeps the centred modal: the drawer rules name .task-card-modal only.
  expect(drawer).not.toContain(".task-composer");
  // Phones keep the full-screen dialog.
  expect(css).toContain(".task-card-dialog { inset: 0; margin: 0; width: 100vw; max-height: none; height: 100dvh;");
});

test("from 1100 px the drawer splits into a fields column and a content column that scroll on their own", () => {
  // 1100–1279 px: min(1080px, 94vw), fields 44% / content 56%; the fields stack full width.
  const wide = block("min-width: 1100px");
  expect(wide).toContain(".task-card-modal { width: min(1080px, 94vw); }");
  expect(wide).toContain("overflow: hidden; padding: 0; grid-template-columns: minmax(0, 44fr) minmax(0, 56fr); grid-template-rows: minmax(0, 1fr); align-items: stretch;");
  expect(wide).toContain("grid-row: 1; overflow-y: auto; overscroll-behavior: contain; }");
  expect(wide).toContain(".task-card-modal .task-card-side { grid-column: 1;");
  expect(wide).toContain(".task-card-modal .task-card-main { grid-column: 2;");
  expect(wide).toContain(".task-card-modal .task-card-side .task-card-details { grid-template-columns: minmax(0, 1fr); gap: 16px; }");
  // From 1280 px: min(1240px, 92vw), 48% / 52%, so the fields column is 520 px or wider and pairs Due and Assignees.
  const wider = block("min-width: 1280px");
  expect(wider).toContain(".task-card-modal { width: min(1240px, 92vw); }");
  expect(wider).toContain("grid-template-columns: minmax(0, 48fr) minmax(0, 52fr)");
  expect(wider).toContain(".task-card-modal .task-card-side .task-card-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
  expect(css).toContain("@media (min-width: 1370px) {\n  .task-card-modal .task-card-side .task-flag-picker { flex-wrap: nowrap; }\n}");
});

test("phones: the board header and the sprint bar use the 16 px gutter of the filter row (QA 0.9.2)", () => {
  expect(css).toContain("  .task-board-header { padding: 8px 16px 4px; gap: 4px; }\n  .task-board-header .task-back { margin-left: -8px; }");
  expect(css).toContain("  .task-sprint-bar { padding: 0 16px 6px; gap: 6px 8px; }");
});

test("phone touch targets: New tag, Manage tags…, Add time, and Remove time are at least 44 px tall (QA 0.9.2)", () => {
  const base = css.indexOf(".task-add-time { justify-self: start; min-height: 32px;");
  const phone = css.indexOf("@media (max-width: 760px) {\n  .task-add-time, .task-due-editor .task-small-button { min-height: 44px; }\n}");
  expect(base).toBeGreaterThanOrEqual(0);
  // After the base rule, so it wins the cascade at the same specificity.
  expect(phone).toBeGreaterThan(base);
});
