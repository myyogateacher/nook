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
  const wide = block("min-width: 1100px");
  expect(wide).toContain(".task-card-modal { width: min(1040px, 92vw); }");
  expect(wide).toContain("grid-template-columns: minmax(0, 4fr) minmax(0, 6fr)");
  expect(wide).toContain(".task-card-modal .task-card-side { grid-column: 1; }");
  expect(wide).toContain(".task-card-modal .task-card-main { grid-column: 2; }");
  expect(wide).toContain(".task-card-modal .task-card-side .task-card-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
  // Popups inside place against the viewport: no transform on the dialog.
  expect(/\.task-card-(dialog|modal)[^{]*\{[^}]*transform/.test(css)).toBe(false);
  // Phones keep the full-screen dialog.
  expect(css).toContain(".task-card-dialog { inset: 0; margin: 0; width: 100vw; max-height: none; height: 100dvh;");
});

test("phone touch targets: New tag, Manage tags…, Add time, and Remove time are at least 44 px tall (QA 0.9.2)", () => {
  const base = css.indexOf(".task-add-time { justify-self: start; min-height: 32px;");
  const phone = css.indexOf("@media (max-width: 760px) {\n  .task-add-time, .task-due-editor .task-small-button { min-height: 44px; }\n}");
  expect(base).toBeGreaterThanOrEqual(0);
  // After the base rule, so it wins the cascade at the same specificity.
  expect(phone).toBeGreaterThan(base);
});
