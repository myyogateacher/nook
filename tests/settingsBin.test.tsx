import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, hubDocumentTitle, parseRoute, type Route } from "../src/router";
import { HUB_PUSHED_OVER_KEY, hubBackAction, hubEntries, hubEntryLabel, hubEntryOf, hubListGoesUnder, hubPopRoute, isHubRoute, leaveGuardAction, settingsRoute } from "../src/settings/hubModel";
import { SettingsHubShell } from "../src/settings/SettingsHub";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { moduleDef } from "../src/modules";

/**
 * Wave 38: the Bin is Settings → Bin (a hub section at /settings/bin; /bin is an alias), and the top
 * bar loses its Bin and Team buttons (both live in Settings). The real-browser run of the same flows
 * (1280 × 800 and 390 × 844) is the Wave 38 smoke recorded in DEVELOPMENT_PLAN.md.
 */
const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
// Settings → Workspace (D836) joins the hub once a workspace module ships; these checks are about the rest.
const ids = (entries: ReturnType<typeof hubEntries>) => entries.filter((entry) => entry.id !== "workspace").map((entry) => entry.id);

describe("routes", () => {
  test("/settings/bin is canonical; /bin opens the same screen and is rewritten to it (both directions)", () => {
    expect(parseRoute("/settings/bin")).toEqual({ app: "bin" });
    expect(formatRoute({ app: "bin" })).toBe("/settings/bin");
    expect(formatRoute(parseRoute("/bin"))).toBe("/settings/bin");
    expect(parseRoute("/settings/bin")).toEqual(parseRoute("/bin"));
    // The app rewrites any non-Notes URL that is not the canonical one in place (startup and popstate),
    // so the alias never leaves a second entry.
    expect(read("App.tsx")).toContain("if (formatRoute(route) !== locationUrl(window.location)) navigate(route, { replace: true });");
    // Server links (mail's /bin, Today's "Leaving the Bin soon" href) stay aliases.
    expect(readFileSync(join(import.meta.dir, "..", "server", "mail", "links.ts"), "utf8")).toContain('bin: () => "/bin"');
  });

  test("the Bin is a hub route with its own entry and title", () => {
    const bin: Route = { app: "bin" };
    expect(isHubRoute(bin)).toBe(true);
    expect(hubEntryOf(bin)).toBe("bin");
    expect(hubEntryLabel("bin")).toBe("Bin");
    expect(hubDocumentTitle(hubEntryLabel("bin"))).toBe("Settings · Bin · Nook");
    expect(read("App.tsx")).toContain('if (route.app === "bin") document.title = hubDocumentTitle(hubEntryLabel("bin"));');
    // Moving between the Bin and another section is a section move for the leave guard.
    expect(leaveGuardAction(bin, settingsRoute("security"))).toBe("section");
  });

  test("Open Bin links (the binned whiteboard card) go to /settings/bin", () => {
    expect(read("editor/whiteboardEmbed.tsx")).toContain('openPath("/settings/bin")');
    // D1260: the open-path listener opens any checked in-app path (the Bin included; tests/openPath.test.ts).
    expect(read("App.tsx")).toContain("const path = inAppOpenPath(href);");
  });
});

describe("the hub's entries", () => {
  test("every role but guest has the Bin in a Workspace group between Account and Team", () => {
    for (const role of ["admin", "member", "viewer"] as const) {
      const entries = hubEntries(role, { teamModuleEnabled: true }).filter((entry) => entry.id !== "workspace");
      const bin = entries.findIndex((entry) => entry.id === "bin");
      expect(entries[bin]).toMatchObject({ group: "workspace", label: "Bin", route: { app: "bin" } });
      expect(entries.slice(0, bin).every((entry) => entry.group === "account")).toBe(true);
      expect(entries.slice(bin + 1).every((entry) => entry.group === "team")).toBe(true);
    }
    // wave38-fixes: a guest can delete nothing, so their (always empty) Bin has no entry.
    expect(hubEntries("guest", { teamModuleEnabled: true }).some((entry) => entry.id === "bin")).toBe(false);
  });

  test("the Bin module off removes the entry; the Team module still decides Team", () => {
    expect(ids(hubEntries("member", { teamModuleEnabled: true, binModuleEnabled: false }))).toEqual(["security", "notifications", "access", "mcp", "agents", "knowledge", "modules", "about", "team-members"]);
    expect(ids(hubEntries("guest", { teamModuleEnabled: true, binModuleEnabled: false }))).toEqual(["security", "notifications", "mcp", "modules", "about"]);
    expect(ids(hubEntries("admin", { teamModuleEnabled: false, binModuleEnabled: false }))).not.toContain("bin");
    // While two-factor setup is required there is only Security.
    expect(ids(hubEntries("admin", { teamModuleEnabled: true, setupRequired: true, binCount: 4 }))).toEqual(["security"]);
    // The module's help in Settings → Modules names the new place.
    expect(moduleDef("bin").description).toContain("Settings → Bin");
  });

  test("with the Bin off, /settings/bin opens Security in place and Back/Forward skip the entry", () => {
    const app = read("App.tsx");
    expect(app).toContain('const binHidden = route.app === "bin" && !binShown;');
    expect(app).toContain('useEffect(() => { if (binHidden) go(settingsRoute("security"), { replace: true }); }, [binHidden, go]);');
    // The app-wide gate (Home and a hint) leaves the Bin to the hub, which is shown for it.
    expect(app).toContain('const hubGatesItself = teamGateOpen || activeApp === "bin";');
    expect(app).toContain("const hidden = hubGatesItself ? null : hiddenModuleForApp(routeDisabled, activeApp);");
    // The hub ignores a popped Bin entry while the module is off (the route gate skips it, D92).
    expect(hubPopRoute({ app: "bin" }, true, false)).toBeNull();
    expect(hubPopRoute({ app: "bin" }, true, true)).toEqual({ app: "bin" });
  });

  test("the Bin's entry carries the item count (the top bar's badge before)", () => {
    const entries = hubEntries("member", { teamModuleEnabled: true, binCount: 3 });
    expect(entries.find((entry) => entry.id === "bin")?.badge).toBe(3);
    expect(hubEntries("member", { teamModuleEnabled: true, binCount: 0 }).find((entry) => entry.id === "bin")?.badge).toBeUndefined();
    const shell = (count: number) => renderToStaticMarkup(<SettingsHubShell displayName="Ada" role="member" entries={hubEntries("member", { teamModuleEnabled: true, binCount: count })} selected="security" listScreen={false} title="Security" showBack onBack={() => undefined} onSelect={() => undefined} account={null}>{null}</SettingsHubShell>);
    const markup = shell(3);
    expect(markup).toContain('<h2 id="settings-hub-group-workspace">Workspace</h2>');
    expect(markup).toContain('aria-label="Bin, 3 items"');
    expect(markup).toContain('<span class="settings-hub-badge" aria-hidden="true">3</span>');
    expect(shell(1)).toContain('aria-label="Bin, 1 item"');
    expect(shell(140)).toContain(">99+</span>");
    expect(shell(0)).not.toContain("settings-hub-badge");
    // The count follows the Bin (notifyBinChanged) and is not fetched with the module off.
    expect(read("App.tsx")).toContain("const binCount = useBinCount(binShown && !setupRequired);");
  });
});

describe("history at 390 px: Home → Settings list → Bin → a row's sheet → Back chain", () => {
  /** A browser history with App's push (the depth, and the URL pushed over) and a guarded sheet layer. */
  function browser(start: string) {
    const entries: Array<{ url: string; state: Record<string, unknown> | null }> = [{ url: start, state: null }];
    let index = 0;
    let sheet = false;
    return {
      get url() { return entries[index]!.url; },
      get state() { return entries[index]!.state; },
      get sheet() { return sheet; },
      push(route: Route) {
        const below = entries[index]!;
        entries.splice(index + 1);
        entries.push({ url: formatRoute(route), state: withHistoryDepth({ [HUB_PUSHED_OVER_KEY]: below.url }, readHistoryDepth(below.state) + 1) });
        index += 1;
      },
      openSheet() { sheet = true; },
      // D18: Back while the sheet is open closes only the sheet (useHistoryDialogGuard undoes the move).
      back() { if (sheet) sheet = false; else index = Math.max(0, index - 1); },
      forward() { index = Math.min(entries.length - 1, index + 1); }
    };
  }
  const screen = (url: string) => {
    const route = parseRoute(url);
    if (!isHubRoute(route)) return `app:${route.app}`;
    return route.app === "settings" && route.section === null ? "list" : hubEntryOf(route);
  };

  test("the sheet closes on Back, then Back returns to the list, then Home; Forward reopens the Bin", () => {
    const history = browser("/");
    history.push(settingsRoute(null));
    history.push({ app: "bin" });
    expect(history.url).toBe("/settings/bin");
    history.openSheet();
    history.back();
    expect(history.sheet).toBe(false);
    expect(screen(history.url)).toBe("bin");
    // The Bin's back arrow is exactly browser Back here (it was pushed over the list).
    expect(hubBackAction(history.state)).toBe("history");
    history.back();
    expect(screen(history.url)).toBe("list");
    history.back();
    expect(screen(history.url)).toBe("app:home");
    history.forward();
    history.forward();
    expect(screen(history.url)).toBe("bin");
  });

  test("a Bin opened from outside the hub (Open Bin, Leaving the Bin soon, /bin) gets the list under it", () => {
    expect(hubListGoesUnder({ app: "bin" }, parseRoute("/notes"), true)).toBe(true);
    expect(hubListGoesUnder({ app: "bin" }, parseRoute("/"), true)).toBe(true);
    expect(hubListGoesUnder({ app: "bin" }, settingsRoute(null), true)).toBe(false);
    expect(hubListGoesUnder({ app: "bin" }, parseRoute("/"), false)).toBe(false);
    const history = browser("/notes");
    history.push(settingsRoute(null));
    history.push({ app: "bin" });
    history.back();
    expect(screen(history.url)).toBe("list");
    history.back();
    expect(screen(history.url)).toBe("app:notes");
  });

  test("the row sheet and the confirms keep their history guards", () => {
    const bin = read("bin/BinSection.tsx");
    expect(bin).toContain("useHistoryDialogGuard(sheetKey !== null, closeSheet);");
    // Delete forever and Empty Bin ask in the app's own dialog (useConfirm, itself a history layer).
    expect(bin).toContain("const { ask, confirmElement } = useConfirm();");
    expect(bin).toContain('title: "Delete forever?"');
    expect(bin).toContain('title: "Empty the Bin?"');
    expect(bin).not.toMatch(/window\.(confirm|alert|prompt)/);
  });
});

describe("the top bar (Wave 38)", () => {
  test("no Bin or Team button anywhere: the sidebar has Home · Inbox · Notifications · the apps · Settings · the account (D1270)", () => {
    const shell = read("AppShell.tsx");
    expect(shell).not.toContain("TeamNavContext");
    expect(shell).not.toMatch(/\bonBin\b/);
    const sidebar = read("shell/AppSidebar.tsx");
    expect(sidebar).not.toMatch(/\bonBin\b/);
    const order = ["tree.search &&", "tree.primary.map", "tree.apps.map", "<TopBarItems />", "link(tree.settings", "<AccountMenu "].map((marker) => sidebar.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No app hands its header a Bin, and neither sidebar footer (Notes, Files) has a Bin row.
    for (const file of ["App.tsx", "files/FilesApp.tsx", "tasks/TasksApp.tsx", "collections/CollectionsApp.tsx", "calendar/CalendarApp.tsx", "inbox/InboxApp.tsx", "vault/VaultApp.tsx", "whiteboards/WhiteboardsApp.tsx", "today/TodayHome.tsx"]) {
      const source = read(file);
      expect({ file, onBin: /\bonBin\b/.test(source) }).toEqual({ file, onBin: false });
      expect({ file, footerBin: source.includes('className="footer-bin"') }).toEqual({ file, footerBin: false });
    }
  });
});
