import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute, parseSettingsPath, settingsPath } from "../src/router";
import { reportsBackAction, reportsRoute } from "../src/reportsRoute";
import { readAppHistorySection, createAppHistoryState } from "../src/appShellNavigation";
import { hiddenModuleForApp, unavailableModules, settingsModulesFor } from "../src/modules";
import { hubEntries } from "../src/settings/hubModel";
import { cellText, countLabel, parseAllowlistText } from "../src/reports/reportsApi";
import { ResultView } from "../src/reports/ReportPage";

/**
 * The Reports client (Wave 45): routes and Back (never leaving Nook before Home), the module gate,
 * Settings → Report data sources for admins only, and the console's result view.
 */

const id = "0b5d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";

describe("routes", () => {
  test("/reports and /reports/:id parse and format; anything else opens the list", () => {
    expect(parseRoute("/reports")).toEqual({ app: "reports", reportId: null });
    expect(parseRoute(`/reports/${id.toUpperCase()}`)).toEqual({ app: "reports", reportId: id });
    expect(parseRoute("/reports/not-an-id")).toEqual({ app: "reports", reportId: null });
    expect(parseRoute(`/reports/${id}/extra`)).toEqual({ app: "reports", reportId: null });
    expect(formatRoute(reportsRoute(id))).toBe(`/reports/${id}`);
    expect(formatRoute(reportsRoute())).toBe("/reports");
    expect(readAppHistorySection(createAppHistoryState("u", "reports", null), "u")).toBe("reports");
  });

  test("Back steps through history, then to the list from a deep link, then Home", () => {
    expect(reportsBackAction(reportsRoute(id), 2)).toEqual({ kind: "history" });
    expect(reportsBackAction(reportsRoute(id), 0)).toEqual({ kind: "replace", route: reportsRoute() });
    expect(reportsBackAction(reportsRoute(), 3)).toEqual({ kind: "home" });
  });

  test("Settings → Report data sources is an admin section", () => {
    expect(settingsPath("datasources")).toBe("/settings/datasources");
    expect(parseSettingsPath("/settings/datasources")).toBe("datasources");
    expect(hubEntries("admin", { teamModuleEnabled: false }).map((entry) => entry.id)).toContain("datasources");
    for (const role of ["member", "viewer", "guest"] as const) expect(hubEntries(role, { teamModuleEnabled: false }).map((entry) => entry.id)).not.toContain("datasources");
  });

  test("the module gate: off hides /reports; guests never have it", () => {
    expect(hiddenModuleForApp(["reports"], "reports")).toBe("reports");
    expect(hiddenModuleForApp([], "reports")).toBeNull();
    expect(unavailableModules({ reports: false })).toEqual(["reports"]);
    expect(settingsModulesFor("guest").map((module) => module.id)).not.toContain("reports");
    expect(settingsModulesFor("viewer").map((module) => module.id)).toContain("reports");
  });
});

describe("console helpers and the result view", () => {
  test("cells, counts, and allowlist text", () => {
    expect([cellText(null), cellText("a"), cellText(3), cellText([1, "b"]), cellText({ k: 1 })]).toEqual(["NULL", "a", "3", "[1,\"b\"]", "{\"k\":1}"]);
    expect([countLabel(1), countLabel(340), countLabel(12_500), countLabel(1_250_000), countLabel(9_800_000_000), countLabel(null)]).toEqual(["1 row", "340 rows", "13 K rows", "1.3 M rows", "9.8 B rows", "? rows"]);
    expect(parseAllowlistText("analytics\n staging.orders_*, analytics")).toEqual(["analytics", "staging.orders_*"]);
  });

  test("the result shows the class, counts, the SQL as sent, the query id, and a scrollable table", () => {
    const markup = renderToStaticMarkup(<ResultView outcome={{ class: "select", columns: [{ name: "week", type: "Date" }, { name: "revenue", type: "Float64" }], rows: [["2026-01-05", 12.5], ["2026-01-12", null]], truncated: true, sentSql: "SELECT * FROM (\nSELECT 1\n) LIMIT 1001", chQueryId: "nook-console-abc", rowsRead: 5000, bytesRead: 1, ms: 12 }} />);
    expect(markup).toContain("2 rows (more were cut off)");
    expect(markup).toContain("5,000 rows read");
    expect(markup).toContain("nook-console-abc");
    expect(markup).toContain("LIMIT 1001");
    expect(markup).toContain('class="report-table-scroll" tabindex="0" role="region" aria-label="Query result"');
    expect(markup).toContain('<td class="report-null">NULL</td>');
    expect(markup).not.toContain("List cut short");
  });

  test("a SHOW list the server cut short at its read cap says so, even when few rows passed the allowlist", () => {
    const outcome = { class: "metadata" as const, columns: [{ name: "name", type: "String" }], rows: [["orders"], ["signups"]], sentSql: "SHOW TABLES FROM analytics", chQueryId: "nook-console-def", rowsRead: null, bytesRead: null, ms: 9 };
    const cut = renderToStaticMarkup(<ResultView outcome={{ ...outcome, truncated: true }} />);
    expect(cut).toContain("List cut short");
    expect(cut).toContain("2 rows<");
    expect(cut).not.toContain("more were cut off");
    const whole = renderToStaticMarkup(<ResultView outcome={{ ...outcome, truncated: false }} />);
    expect(whole).not.toContain("List cut short");
  });
});
