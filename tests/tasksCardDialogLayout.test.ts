import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The card dialog uses the screen (operator QA 0.9.1): wider from 761 px, two columns from 1100 px
// (fields ~40% left, description and the rest ~60% right), full screen on phones, never transformed.

const css = readFileSync(new URL("../src/tasks/tasks.css", import.meta.url), "utf8");
const block = (query: string) => {
  const start = css.indexOf(`@media (${query}) {\n  .task-card-modal`);
  expect(start, query).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start));
};

test("the card dialog widens on tablets and laptops and splits into fields and content at 1100 px", () => {
  expect(block("min-width: 761px")).toContain(".task-card-modal { width: min(880px, 94vw); max-height: min(92vh, calc(100dvh - 32px)); }");
  // 1100–1279 px: min(1080px, 94vw), fields 44% / content 56%; the fields stack full width.
  const wide = block("min-width: 1100px");
  expect(wide).toContain(".task-card-modal { width: min(1080px, 94vw); }");
  expect(wide).toContain("grid-template-columns: minmax(0, 44fr) minmax(0, 56fr)");
  expect(wide).toContain("gap: 20px;");
  expect(wide).toContain(".task-card-modal .task-card-side { grid-column: 1; }");
  expect(wide).toContain(".task-card-modal .task-card-main { grid-column: 2; }");
  expect(wide).toContain(".task-card-modal .task-card-side .task-card-details { grid-template-columns: minmax(0, 1fr); gap: 16px; }");
  // From 1280 px: min(1240px, 94vw), 46% / 54% (operator QA 0.9.2: the left column had no room).
  const wider = block("min-width: 1280px");
  expect(wider).toContain(".task-card-modal { width: min(1240px, 94vw); }");
  expect(wider).toContain("grid-template-columns: minmax(0, 46fr) minmax(0, 54fr)");
  // Due and Assignees pair up only when the left column is 520 px or wider (from 1280 px); Flags keep one row from 560 px (1370 px).
  expect(wider).toContain(".task-card-modal .task-card-side .task-card-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
  expect(css).toContain("@media (min-width: 1370px) {\n  .task-card-modal .task-card-side .task-flag-picker { flex-wrap: nowrap; }\n}");
  // No container queries: they would contain the fixed popups.
  expect(css).not.toContain("@container");
  expect(block("min-width: 761px")).toContain("max-height: min(92vh,");
  // Popups inside place against the viewport: no transform on the dialog.
  expect(/\.task-card-(dialog|modal)[^{]*\{[^}]*transform/.test(css)).toBe(false);
  // Phones keep the full-screen dialog.
  expect(css).toContain(".task-card-dialog { inset: 0; margin: 0; width: 100vw; max-height: none; height: 100dvh;");
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
