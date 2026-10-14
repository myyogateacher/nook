import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** The app's shared button spec (D472): every primary, secondary, danger and action button is padded, one line, and clearly disabled. */
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const styles = read("styles.css");
const ALL = ":is(.primary-button, .secondary-button, .danger-button, .action-button)";
const rule = (selector: string) => {
  const start = styles.indexOf(`${selector} {`);
  return start < 0 ? null : styles.slice(start, styles.indexOf("}", start));
};

describe("shared button spec (D472)", () => {
  test("padded, one line, a 16 px icon 8 px from its label", () => {
    const base = rule(ALL);
    expect(base).not.toBeNull();
    for (const declaration of ["min-height: 40px", "display: inline-flex", "align-items: center", "gap: 8px", "padding: 0 14px", "white-space: nowrap"]) expect(base).toContain(declaration);
    expect(rule(`${ALL} > svg`)).toContain("width: 16px; height: 16px");
  });

  test("44 px on a phone or a coarse pointer; an icon-only button is square", () => {
    const touch = styles.slice(styles.indexOf("@media (max-width: 760px), (pointer: coarse) {"));
    expect(touch).toContain(`${ALL} { min-height: 44px; }`);
    expect(touch).toContain(`${ALL}.icon-only { width: 44px; min-width: 44px; }`);
    expect(rule(`${ALL}.icon-only`)).toContain("padding: 0");
  });

  test("disabled is flat grey, never a dimmed colour; busy keeps its colour; focus is visible", () => {
    const disabled = rule(`${ALL}:disabled:not([aria-busy="true"])`);
    expect(disabled).toContain("opacity: 1");
    expect(disabled).toContain("background: #1a1a1d");
    expect(rule(`${ALL}[aria-busy="true"]`)).toContain("cursor: progress");
    expect(rule(`${ALL}:focus-visible`)).toContain("outline: 2px solid var(--yellow)");
  });

  test("the old zero-padding rules and one-off copies are gone", () => {
    expect(styles).not.toMatch(/^\.secondary-button \{ border: 1px solid #3a3a3f; border-radius: 9px;/m);
    expect(styles).not.toContain(":where(.secondary-button, .primary-button, .danger-button)");
    const reports = read("reports/reports.css");
    expect(reports).not.toContain(".report-actions button, .report-console-head button");
    expect(reports).not.toContain(".report-overflow-button { min-width: 44px");
    expect(reports).not.toContain("padding: 0 14px; display: inline-flex");
  });

  test("the report header's overflow button is icon-only with a label; Run and Refresh all say when they are busy", () => {
    expect(read("reports/reportCommands.tsx")).toMatch(/className="secondary-button icon-only report-overflow-button"[^>]*aria-label=\{label\}/);
    const page = read("reports/ReportPage.tsx");
    expect(page).toContain("aria-busy={running || undefined}");
    expect(page).toContain("aria-busy={commands.refreshAll.busy || undefined}");
  });
});
