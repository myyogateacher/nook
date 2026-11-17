import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AI_TABS, formatRoute, parseRoute, type Route } from "../src/router";
import { AI_TAB_LABELS, aiTabRedirect, aiTabsFor, hubEntries, hubEntryOf, hubPopRoute, isNestedHubRoute } from "../src/settings/hubModel";
import { SettingsTabs, settingsTabIds } from "../src/settings/SettingsTabs";

/**
 * Settings → AI is tabbed: Model providers, Tool servers, and Chat policy, each its own URL under
 * /settings/ai, so Back and Forward move between tabs; bare /settings/ai and an unknown tab open the
 * first tab the role sees, in place.
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const ai = (aiTab?: (typeof AI_TABS)[number]): Route => aiTab ? { app: "settings", section: "ai", aiTab } : { app: "settings", section: "ai" };

describe("routes", () => {
  test("each tab is a URL that round-trips; bare /settings/ai stays bare", () => {
    const rows: Array<[string, Route]> = [
      ["/settings/ai", ai()],
      ["/settings/ai/providers", ai("providers")],
      ["/settings/ai/tools", ai("tools")],
      ["/settings/ai/policy", ai("policy")]
    ];
    for (const [path, route] of rows) {
      expect(parseRoute(path)).toEqual(route);
      expect(formatRoute(route)).toBe(path);
    }
    expect([...AI_TABS]).toEqual(["providers", "tools", "policy", "usage"]);
    expect(AI_TAB_LABELS).toEqual({ providers: "Model providers", tools: "Tool servers", policy: "Chat policy", usage: "Usage" });
  });

  test("an unknown or malformed subpath opens bare AI (which then opens the first tab); other sections take no tab", () => {
    for (const path of ["/settings/ai/nope", "/settings/ai/PROVIDERS", "/settings/ai/tools/extra", "/settings/ai/providers/x/y"]) expect(parseRoute(path)).toEqual(ai());
    expect(parseRoute("/settings/security/providers")).toEqual({ app: "settings", section: null });
    expect(formatRoute({ app: "settings", section: "security", aiTab: "tools" })).toBe("/settings/security");
  });

  test("every tab keeps the AI nav entry selected, is not a nested page, and is followed on Back and Forward", () => {
    for (const tab of AI_TABS) {
      expect(hubEntryOf(ai(tab))).toBe("ai");
      expect(isNestedHubRoute(ai(tab))).toBe(false);
      expect(hubPopRoute(ai(tab), true)).toEqual(ai(tab));
    }
    expect(hubEntryOf(ai())).toBe("ai");
  });
});

describe("tab visibility and the redirect", () => {
  test("admins see every tab; every other role sees none (the page and its nav entry are for admins)", () => {
    expect(aiTabsFor("admin")).toEqual(["providers", "tools", "policy", "usage"]);
    for (const role of ["member", "viewer", "guest", undefined] as const) {
      expect(aiTabsFor(role)).toEqual([]);
      expect(hubEntries(role, { teamModuleEnabled: true }).map((entry) => entry.id)).not.toContain("ai");
    }
  });

  test("bare /settings/ai and an unknown tab open the first visible tab; a known tab stays", () => {
    expect(aiTabRedirect(ai(), "admin")).toEqual(ai("providers"));
    expect(aiTabRedirect(parseRoute("/settings/ai/nope"), "admin")).toEqual(ai("providers"));
    for (const tab of AI_TABS) expect(aiTabRedirect(ai(tab), "admin")).toBeNull();
  });

  test("no redirect for a role without tabs (the page says it is for admins), nor off the AI section", () => {
    for (const role of ["member", "viewer", "guest", undefined] as const) {
      expect(aiTabRedirect(ai(), role)).toBeNull();
      expect(aiTabRedirect(ai("tools"), role)).toBeNull();
    }
    expect(aiTabRedirect({ app: "settings", section: "security" }, "admin")).toBeNull();
    expect(aiTabRedirect({ app: "home" }, "admin")).toBeNull();
  });

  test("App replaces the entry for the redirect (Back does not bounce) and keeps the admin gate", () => {
    const app = read("App.tsx");
    expect(app).toContain("useEffect(() => { if (aiRedirectUrl) go(parseRoute(aiRedirectUrl), { replace: true }); }, [aiRedirectUrl, go]);");
    expect(app).toContain('section === "ai" ? (session.user.role === "admin" ?');
    expect(app).toContain('onSelectTab={(tab) => go({ app: "settings", section: "ai", aiTab: tab })}');
  });
});

describe("the tab row", () => {
  const tabs = [{ id: "providers", label: "Model providers", count: 2, countNoun: "provider" }, { id: "tools", label: "Tool servers", count: 1, countNoun: "tool server" }, { id: "policy", label: "Chat policy" }] as const;
  const markup = renderToStaticMarkup(<SettingsTabs label="AI settings" idPrefix="ai" tabs={tabs} selected="tools" onSelect={() => undefined} />);

  test("a tablist of tabs with aria-selected, a roving tabindex, and panels to point at", () => {
    expect(markup).toContain('role="tablist" aria-label="AI settings"');
    expect((markup.match(/role="tab"/g) ?? []).length).toBe(3);
    expect(markup).toContain(`id="ai-tab-tools" aria-selected="true" aria-controls="${settingsTabIds("ai", "tools").panel}"`);
    expect(markup).toContain('id="ai-tab-providers" aria-selected="false"');
    expect((markup.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((markup.match(/tabindex="-1"/g) ?? []).length).toBe(2);
    expect(settingsTabIds("ai", "policy")).toEqual({ tab: "ai-tab-policy", panel: "ai-panel-policy" });
  });

  test("counts show beside the label and are named for assistive tech", () => {
    expect(markup).toContain('aria-label="Model providers, 2 providers"');
    expect(markup).toContain('aria-label="Tool servers, 1 tool server"');
    expect(markup).toContain('<span class="settings-tab-count" aria-hidden="true">2</span>');
    expect(markup).not.toContain('aria-label="Chat policy');
  });

  test("the page renders tab panels, arrow keys move between tabs, and the row scrolls without wrapping", () => {
    const page = read("chat/AiSettings.tsx");
    expect(page).toContain('role: "tabpanel"');
    expect(page).toContain('<SettingsTabs label="AI settings" idPrefix="ai"');
    expect(page).not.toMatch(/<select[\s>]|window\.confirm\(/);
    const row = read("settings/SettingsTabs.tsx");
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) expect(row).toContain(`"${key}"`);
    const css = read("settings/settingsHub.css");
    expect(css).toMatch(/\.settings-tabs \{[^}]*overflow-x: auto;/);
    expect(css).toMatch(/\.settings-tab \{[^}]*flex: none;[^}]*white-space: nowrap;/);
  });
});
