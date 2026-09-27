import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Operator report (v0.9.x): a one-line card description rendered in a ~530 px box because the Notes
// page's `.editor-surface { min-height: 55vh }` and `.note-prose { min-height: 50vh }` leaked into
// the card dialog, the full-page card, and the composer. These guards keep the card surfaces compact.
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const tasks = source("../src/tasks/tasks.css");
const styles = source("../src/styles.css");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string) {
  const at = css.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return css.slice(at + selector.length + 3, css.indexOf("}", at));
}

test("the Notes editor keeps its own tall surface", () => {
  expect(rule(styles, ".editor-surface")).toContain("min-height: 55vh");
  expect(styles).toMatch(/\.note-prose \{ min-height: 50vh;/);
});

test("card description surfaces override the Notes 55vh / 50vh floors in read and edit mode", () => {
  expect(rule(tasks, ".task-description-view .editor-surface, .task-description-editor .editor-surface")).toContain("min-height: 0");
  const prose = rule(tasks, ".task-description-view .note-prose, .task-description-editor .note-prose");
  // About three lines at least, never a viewport fraction.
  expect(prose).toContain("min-height: calc(3 * 1.78em + 16px)");
  expect(prose).not.toContain("vh");
});

test("editing grows with the text and scrolls inside itself past 60vh", () => {
  const editing = rule(tasks, ".task-description-editor .note-prose");
  expect(editing).toContain("max-height: 60vh");
  expect(editing).toContain("overflow-y: auto");
});

test("no card description rule reintroduces a viewport-height minimum", () => {
  const descriptionRules = tasks.split("}").filter((block) => block.includes(".task-description"));
  for (const block of descriptionRules) expect(block).not.toMatch(/min-height:\s*\d+(\.\d+)?vh/);
});
