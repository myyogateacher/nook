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
    expect(rule(".report-source-actions .secondary-button")).toMatch(/min-height: 44px.*padding: 0 14px.*white-space: nowrap/);
    expect(rule(".report-source-actions .report-source-remove")).toContain("color: var(--red)");
    expect(css).toMatch(/\.report-source-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    const card = css.slice(css.indexOf(".report-source {"), css.indexOf(".report-source-actions {"));
    expect(card).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
