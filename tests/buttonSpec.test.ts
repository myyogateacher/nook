import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { diffMetrics } from "../scripts/buttonMetrics";

/**
 * D472: the reports module's shared button spec, scoped so the screens built before keep their exact
 * buttons; elsewhere only an unpadded shared button gains its 14 px (the squished-label bug).
 */
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const styles = read("styles.css");
const SCOPE = ":is(.reports-app, .reports-dialog, .report-sources) :is(.primary-button, .secondary-button, .danger-button)";
const rule = (selector: string) => {
  const start = styles.indexOf(`${selector} {`);
  return start < 0 ? null : styles.slice(start, styles.indexOf("}", start));
};

describe("the shared button spec (D472)", () => {
  test("reports: padded, one line, a 16 px icon 8 px from its label", () => {
    const base = rule(SCOPE);
    expect(base).not.toBeNull();
    for (const declaration of ["min-height: 40px", "display: inline-flex", "align-items: center", "gap: 8px", "padding: 0 14px", "white-space: nowrap"]) expect(base).toContain(declaration);
    expect(rule(`${SCOPE} > svg`)).toContain("width: 16px; height: 16px");
  });

  test("reports: 44 px on a phone or a coarse pointer; an icon-only button is square", () => {
    const touch = styles.slice(styles.lastIndexOf("@media (max-width: 760px), (pointer: coarse) {"));
    expect(touch).toContain(`${SCOPE} { min-height: 44px; }`);
    expect(touch).toContain(`${SCOPE}.icon-only { width: 44px; min-width: 44px; }`);
  });

  test("reports: a sheet's footer buttons are at least 64 px wide (release QA: Share's Save was 61 px)", () => {
    expect(rule(".reports-dialog .file-dialog-actions :is(.primary-button, .secondary-button, .danger-button):not(.icon-only)")).toContain("min-width: 64px");
  });

  test("reports: disabled is flat grey, never a dimmed colour; busy keeps its colour; focus is visible", () => {
    const disabled = rule(`${SCOPE}:disabled:not([aria-busy="true"])`);
    expect(disabled).toContain("opacity: 1");
    expect(disabled).toContain("background: #1a1a1d");
    expect(rule(`${SCOPE}[aria-busy="true"]`)).toContain("cursor: progress");
    expect(rule(`${SCOPE}:focus-visible`)).toContain("outline: 2px solid var(--yellow)");
  });

  test("elsewhere only padding: the old rules stay as they were, and an unpadded button gains 14 px", () => {
    expect(styles).toContain(".secondary-button { border: 1px solid #3a3a3f; border-radius: 9px; background: #212125; color: #e1e1e3; cursor: pointer; }");
    expect(styles).toContain(".primary-button { min-height: 46px; margin-top: 4px; }");
    expect(rule(".primary-button, .secondary-button, .danger-button")).toBe(".primary-button, .secondary-button, .danger-button { padding-inline: 14px; ");
  });

  test("the report header's overflow button is icon-only with a label; Run and Refresh all say when they are busy", () => {
    expect(read("reports/reportCommands.tsx")).toMatch(/"secondary-button icon-only report-overflow-button"\}[^>]*aria-label=\{label\}/);
    const page = read("reports/ReportPage.tsx");
    expect(page).toContain("aria-busy={running || undefined}");
    expect(page).toContain("aria-busy={commands.refreshAll.busy || undefined}");
  });
});

describe("scripts/buttonMetrics.ts diff", () => {
  const row = (screen: string, path: string, key: string, metrics: Record<string, string>) => ({ screen, path, width: 1280, key, metrics });
  test("a changed button outside the allowed paths fails; an unpadded one or an allowed path passes", () => {
    const before = [
      row("tasks", "/tasks", "primary-button|New board", { height: "44", "padding-left": "18px", "padding-right": "18px" }),
      row("chat", "/chat", "primary-button|New chat", { height: "46", "padding-left": "0px", "padding-right": "0px" }),
      row("reports", "/reports", "secondary-button|Changes", { height: "44", "padding-left": "0px", "padding-right": "0px" })
    ];
    const after = [
      row("tasks", "/tasks", "primary-button|New board", { height: "36", "padding-left": "14px", "padding-right": "14px" }),
      row("chat", "/chat", "primary-button|New chat", { height: "46", "padding-left": "14px", "padding-right": "14px" }),
      row("reports", "/reports", "secondary-button|Changes", { height: "40", "padding-left": "14px", "padding-right": "14px" })
    ];
    const { changes } = diffMetrics(before, after, ["/reports"]);
    expect(changes.map((item) => [item.id.split("|")[0], item.allowed])).toEqual([["tasks@1280", false], ["chat@1280", true], ["reports@1280", true]]);
    expect(changes[0]!.changes).toContain("height: 44 → 36");
  });
});
