import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportDataSources } from "../src/settings/ReportDataSources";
import { HUB_TITLE_ID } from "../src/settings/hubModel";

/**
 * Settings → Report data sources (2026-10-14 fix): the page header names the section, so the section
 * repeats no heading; the card's buttons follow the app's settings-card buttons; the card wears the
 * app's CSS variables, not hard-coded colours.
 */
describe("Settings → Report data sources", () => {
  test("no second 'Report data sources' heading; labelled by the page header", () => {
    const markup = renderToStaticMarkup(<ReportDataSources />);
    expect(markup).not.toMatch(/<h3[^>]*>Report data sources<\/h3>/);
    expect(markup).toContain(`aria-labelledby="${HUB_TITLE_ID}"`);
    expect(markup).toContain("ClickHouse connections reports may query");
  });

  test("the card's buttons are padded, 44 px, one line; Remove apart; two even columns on a phone; colours are variables", () => {
    const css = readFileSync(new URL("../src/reports/reports.css", import.meta.url), "utf8");
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // Padding, one line and the icon come from the shared button spec (styles.css); the card asks for 44 px.
    expect(rule(".report-source-actions .secondary-button")).toContain("min-height: 44px");
    expect(rule(".report-source-actions .report-source-remove")).toContain("color: var(--red)");
    expect(css).toMatch(/\.report-source-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    // The phone grid keeps the button lint's 12 px side padding (release QA found 10 px).
    const phone = [...css.matchAll(/\.report-source-actions \.secondary-button \{([^}]*)\}/g)].map((match) => match[1]!);
    for (const body of phone) {
      const padding = /padding: 0 (\d+)px/.exec(body);
      if (padding) expect(Number(padding[1])).toBeGreaterThanOrEqual(12);
    }
    const card = css.slice(css.indexOf(".report-source {"), css.indexOf(".report-source-actions {"));
    expect(card).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
