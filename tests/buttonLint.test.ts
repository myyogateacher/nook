import { describe, expect, test } from "bun:test";
import { lintButtons, lintReport, type LintButton } from "../scripts/buttonMetrics";

/**
 * C3: the button lint's rules on a synthetic page, as LINT_MEASURE would measure it: one button per
 * rule broken, a well-built text button and icon button that pass, and an allowlisted exception.
 */

const button = (patch: Partial<LintButton>): LintButton => ({
  selector: "button.secondary-button", label: "Save", text: true, width: 96, height: 40, scrollWidth: 70, clientWidth: 70, childClipped: false, lines: 1,
  lineHeight: 20, paddingTop: 10, paddingBottom: 10, paddingLeft: 13, paddingRight: 13, borderTop: 1, borderBottom: 1, ...patch
});

const page: LintButton[] = [
  button({ label: "Fine" }),
  button({ selector: "button.icon-button", label: "Close", text: false, width: 44, height: 44, paddingLeft: 0, paddingRight: 0 }),
  button({ selector: "button.overflowing", label: "A label far too long", scrollWidth: 140, clientWidth: 80 }),
  button({ selector: "button.clipped", label: "Ellipsis…", childClipped: true }),
  button({ selector: "button.wrapped", label: "Two lines", lines: 2, height: 60 }),
  button({ selector: "button.wrapped-height", label: "Measured by height", lines: null, height: 64 }),
  button({ selector: "button.tight", label: "Tight", paddingLeft: 6, paddingRight: 6 }),
  button({ selector: "button.narrow", label: "Go", width: 48 }),
  button({ selector: "button.small-target", label: "Tiny", text: false, width: 32, height: 32, paddingLeft: 0, paddingRight: 0 })
];

describe("button lint (C3)", () => {
  test("each rule flags its button, and only its button", () => {
    const at1280 = lintButtons("synthetic", 1280, page);
    const rulesOf = (selector: string) => at1280.filter((finding) => finding.selector === selector).map((finding) => finding.rule).sort();
    expect(rulesOf("button.secondary-button")).toEqual([]);
    expect(rulesOf("button.icon-button")).toEqual([]);
    expect(rulesOf("button.overflowing")).toEqual(["overflow"]);
    expect(rulesOf("button.clipped")).toEqual(["overflow"]);
    expect(rulesOf("button.wrapped")).toEqual(["wrap"]);
    expect(rulesOf("button.wrapped-height")).toEqual(["wrap"]);
    expect(rulesOf("button.tight")).toEqual(["padding"]);
    expect(rulesOf("button.narrow")).toEqual(["narrow"]);
    // Targets are a phone rule: none at 1280.
    expect(rulesOf("button.small-target")).toEqual([]);
  });

  test("at 390 targets under 44 px are flagged too", () => {
    const at390 = lintButtons("synthetic", 390, page);
    const targets = at390.filter((finding) => finding.rule === "target").map((finding) => finding.selector).sort();
    // The fine text button is 40 px tall: a phone target needs 44.
    expect(targets).toEqual(["button.clipped", "button.narrow", "button.overflowing", "button.secondary-button", "button.small-target", "button.tight"]);
  });

  test("the allowlist leaves out intentional exceptions by screen, selector, label, and rule", () => {
    const allowed = lintButtons("synthetic", 390, page, [
      { screen: "*", selector: "button.small-target", rule: "target", reason: "a dense toolbar" },
      { screen: "synthetic", selector: "button.narrow", label: "Go", rule: "*", reason: "a deliberate short label" },
      { screen: "other", selector: "button.tight", rule: "padding", reason: "another screen only" }
    ]);
    expect(allowed.some((finding) => finding.selector === "button.small-target")).toBe(false);
    expect(allowed.some((finding) => finding.selector === "button.narrow")).toBe(false);
    expect(allowed.some((finding) => finding.selector === "button.tight" && finding.rule === "padding")).toBe(true);
  });

  test("the report groups findings per screen and selector, with a total per rule", () => {
    const report = lintReport([...lintButtons("synthetic", 1280, page), ...lintButtons("synthetic", 390, page)]);
    expect(report).toContain("synthetic@1280");
    expect(report).toContain("synthetic@390");
    expect(report).toContain("  button.overflowing: overflow ×1");
    expect(report).toMatch(/findings: .*overflow \d+/);
    expect(lintReport([])).toContain("0 findings: none");
  });
});
