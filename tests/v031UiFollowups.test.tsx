import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatRoute, settingsDocumentTitle, type AiTab, type Route } from "../src/router";
import { HUB_PUSHED_OVER_CHAIN_KEY, HUB_PUSHED_OVER_KEY, HUB_TITLE_ID, hubBackSteps, settingsRoute } from "../src/settings/hubModel";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { googleIntegrationNotice, googleSettingsNotice } from "../src/auth/GoogleAccountCard";

/**
 * The v0.31 small UI follow-ups (TODO.md "Small UI follow-ups"): phone sizing at 390 px, Settings
 * polish, Settings → AI's tabs, and the chat policy panel at 1280.
 */

const root = join(import.meta.dir, "..", "src");
const read = (path: string) => Bun.file(join(root, path)).text();
/** The declarations of one exact selector in a stylesheet (the first match). */
const rule = (sheet: string, selector: string) => {
  const start = sheet.indexOf(`${selector} {`);
  return start === -1 ? null : sheet.slice(start, sheet.indexOf("}", start));
};
/** The text of the stylesheet's phone media blocks (max-width: 760px), joined. */
const phoneRules = (sheet: string) => sheet.split("@media (max-width: 760px)").slice(1).join("\n");

describe("phone sizing at 390 px", () => {
  test("Tasks: the board header is two rows; the view switch leads a filter row that scrolls sideways", async () => {
    const view = await read("tasks/BoardView.tsx");
    // A computer keeps the switch in the header; a phone moves it into the controls row with the filters.
    expect(view).toContain("{detail && !phone && viewSwitch}");
    expect(view).toContain('{detail && (phone ? <div className="task-board-controls">{viewSwitch}{filterBar}</div> : filterBar)}');
    const phone = phoneRules(await read("tasks/boardViews.css"));
    expect(rule(phone, "  .task-board-header")).toContain("flex-wrap: nowrap");
    const controls = rule(phone, "  .task-board-controls");
    for (const declaration of ["overflow-x: auto", "flex: none", "min-width: 0"]) expect(controls).toContain(declaration);
    expect(rule(phone, "  .task-board-controls > .task-filter-bar")).toContain("flex-wrap: nowrap");
    // Every control in the row stays 44 px tall (the switch's buttons and the filter chips).
    expect(rule(phone, "  .task-view-switch .icon-button")).toContain("height: 44px");
    // Editing a filter needs the width: the row wraps then.
    expect(phone).toContain(".task-board-controls:has(.task-filter-editor) { flex-wrap: wrap; overflow-x: visible; }");
    // The old third row (the switch on a line of its own) is gone.
    expect(phone).not.toContain(".task-view-switch { order: 5; }");
  });

  test("Collections: the actions follow the toolbar in one scrolling row under the title", async () => {
    const view = await read("collections/CollectionView.tsx");
    expect(view).toContain("{!phone && headerActions}");
    expect(view).toContain('{phone ? <div className="collection-controls">{toolbar}{headerActions}</div> : toolbar}');
    const sheet = await read("collections/collections.css");
    const phone = phoneRules(sheet);
    expect(phone).toContain(".collection-header { flex-wrap: nowrap; }");
    expect(rule(phone, "  .collection-controls")).toContain("overflow-x: auto");
    expect(rule(phone, "  .collection-controls .icon-button")).toContain("height: 44px");
    // A row's panel covers the page: the controls hide with the toolbar.
    expect(phone).toContain(".collections-row-open .collection-controls { display: none; }");
  });

  test("the app header's top row fits 390 px: four 44 px buttons and the picture beside Home", async () => {
    const shell = await read("AppShell.tsx");
    const actions = shell.slice(shell.indexOf("export function AccountActions"), shell.indexOf("</div>;", shell.indexOf("export function AccountActions")));
    // Settings, Inbox, the bell, and Sign out (the Bin and Team buttons moved into Settings in Wave 38).
    expect(actions.match(/<button |<InboxButton |<NotificationBell /g)?.length).toBe(4);
    const css = await read("appShell.css");
    expect(css).toContain(".app-account-button { width: 44px; min-width: 44px; height: 44px;");
    // 390 − 2 × 18 px padding = 354 px: Home 44 + gap 8 + the brand mark 30 + gap 8 + (4 × 44 + the 28 px
    // picture with 2 × 2 px margins + 4 × 4 px gaps = 224) = 314 px, so the bell never wraps.
    expect(44 + 8 + 30 + 8 + (4 * 44 + 28 + 4 + 4 * 4)).toBeLessThanOrEqual(390 - 2 * 18);
  });

  test("the whiteboard editor-load error uses the shared action buttons with room between", async () => {
    const app = await read("whiteboards/WhiteboardsApp.tsx");
    expect(app).toContain('className="action-button" onClick={() => { this.setState({ failed: false }); this.props.onRetry(); }}><RotateCcw />Retry</button>');
    expect(app).toContain('className="action-button secondary" onClick={this.props.onBack}>Back to whiteboards</button>');
    const actions = rule(await read("whiteboards/whiteboards.css"), ".whiteboard-load-actions");
    expect(actions).toContain("gap: 10px");
    expect(actions).toContain("flex-wrap: wrap");
    expect(actions).not.toContain("min-height");
  });
});

describe("Settings polish", () => {
  test("an integration's page never says Google sign-in is linked; Security still does", () => {
    expect(googleIntegrationNotice({ kind: "linked" })).toBeNull();
    expect(googleIntegrationNotice({ kind: "reauthed" })?.text).toBe("Confirmed with Google. Finish the change within 5 minutes.");
    expect(googleIntegrationNotice({ kind: "error", code: "denied" })?.tone).toBe("error");
    expect(googleIntegrationNotice(null)).toBeNull();
    expect(googleSettingsNotice({ kind: "linked" })?.text).toContain("Google sign-in is linked");
  });

  test("the page uses the integration notice", async () => {
    const page = await read("team/IntegrationPage.tsx");
    expect(page).toContain("googleIntegrationNotice(googleIntegrationResultFor(integrationId))");
    expect(page).not.toContain("googleSettingsNotice");
  });

  test("a script-focused heading shows the app's ring after a key press only", async () => {
    const styles = await read("styles.css");
    expect(styles).toContain(':is(h1, h2, h3, h4)[tabindex="-1"]:focus-visible { outline: 2px solid var(--yellow);');
    expect(styles).toContain("[data-script-focus]:focus, :is(h1, h2, h3, h4)[data-script-focus]:focus,");
    expect(await read("settings/SettingsHub.tsx")).toContain("focusFromScript(headingRef.current, { preventScroll: true })");
    expect(await read("keys/KeysSettings.tsx")).toContain("if (target === headingRef.current) focusFromScript(target);");
  });

  test("focusFromScript marks the move unless the last input was a key press", async () => {
    const attributes = new Map<string, string>();
    const listeners: Array<() => void> = [];
    let focused = 0;
    const element = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => undefined,
      focus: () => { focused += 1; }
    } as unknown as HTMLElement;
    const { focusFromScript, lastInputWasKeyboard } = await import("../src/ui/scriptFocus");
    // No input yet (a deep link): no ring.
    expect(lastInputWasKeyboard()).toBe(false);
    focusFromScript(element);
    expect(focused).toBe(1);
    expect(attributes.has("data-script-focus")).toBe(true);
    // Leaving the heading clears the mark.
    for (const listener of listeners) listener();
    expect(attributes.has("data-script-focus")).toBe(false);
  });

  test("account sections are labelled by the hub's heading, not a repeated h3", async () => {
    expect(await read("settings/SettingsHub.tsx")).toContain("<h1 id={HUB_TITLE_ID}");
    expect(HUB_TITLE_ID).toBe("settings-hub-title");
    const sections: Array<[string, string]> = [
      ["notifications/NotificationSettings.tsx", ">Notifications</h3>"],
      ["settings/MyAccess.tsx", ">My access</h3>"],
      ["chat/AgentsSettings.tsx", ">Agents</h3>"],
      ["chat/KnowledgeSettings.tsx", ">Knowledge</h3>"],
      ["ModulesSettings.tsx", ">Modules</h3>"],
      ["chat/AiSettings.tsx", ">AI</h3>"]
    ];
    for (const [file, duplicate] of sections) {
      const source = await read(file);
      expect(source).not.toContain(duplicate);
      expect(source).toContain("aria-labelledby={HUB_TITLE_ID}");
    }
    // API keys keeps its h3 only on an integration's page, where the page heading is the integration's name.
    const keys = await read("keys/KeysSettings.tsx");
    expect(keys).toContain('aria-labelledby={integration ? "keys-heading" : HUB_TITLE_ID}');
    expect(keys).toContain('{integration && <h3 id="keys-heading">API keys</h3>}');
  });
});

describe("Settings → AI tabs", () => {
  test("each tab has its own document title, as API keys' tabs", async () => {
    expect(settingsDocumentTitle("ai", undefined, "providers")).toMatch(/^Settings · AI · Model providers · /);
    expect(settingsDocumentTitle("ai", undefined, "tools")).toMatch(/^Settings · AI · Tool servers · /);
    expect(settingsDocumentTitle("ai", undefined, "policy")).toMatch(/^Settings · AI · Chat policy · /);
    expect(settingsDocumentTitle("ai")).toMatch(/^Settings · AI · /);
    // The lazily loaded page sets the same title per tab (it used to set "Settings · AI" after App).
    const page = await read("chat/AiSettings.tsx");
    expect(page).toContain('useEffect(() => { document.title = settingsDocumentTitle("ai", undefined, tab); }, [tab]);');
    expect(page).not.toContain('hubDocumentTitle("AI")');
  });

  /** A browser history of hub entries, as App writes them (the URL each was pushed over, nearest first). */
  function browser(start: string) {
    const entries: Array<{ url: string; state: Record<string, unknown> | null }> = [{ url: start, state: null }];
    let index = 0;
    return {
      get url() { return entries[index]!.url; },
      get state() { return entries[index]!.state; },
      push(route: Route) {
        const below = entries[index]!;
        const chain = [below.url, ...((below.state?.[HUB_PUSHED_OVER_CHAIN_KEY] as string[] | undefined) ?? [])].slice(0, 4);
        entries.splice(index + 1);
        entries.push({ url: formatRoute(route), state: withHistoryDepth({ [HUB_PUSHED_OVER_KEY]: below.url, [HUB_PUSHED_OVER_CHAIN_KEY]: chain }, readHistoryDepth(below.state) + 1) });
        index += 1;
      },
      go(delta: number) { index = Math.min(entries.length - 1, Math.max(0, index + delta)); }
    };
  }
  const aiTab = (tab: AiTab): Route => ({ app: "settings", section: "ai", aiTab: tab });

  test("phones: list → AI → Tool servers → Chat policy: the back arrow steps over the tabs to the list; Forward returns", () => {
    const history = browser("/");
    history.push(settingsRoute(null));
    history.push(aiTab("providers"));
    history.push(aiTab("tools"));
    history.push(aiTab("policy"));
    expect(hubBackSteps(history.state)).toBe(3);
    history.go(-3);
    expect(history.url).toBe("/settings");
    history.go(1);
    expect(history.url).toBe("/settings/ai/providers");
    expect(hubBackSteps(history.state)).toBe(1);
    history.go(1);
    expect(hubBackSteps(history.state)).toBe(2);
    history.go(-2);
    history.go(-1);
    expect(history.url).toBe("/");
  });

  test("a tab opened by a deep link, or from outside the list, still puts the list in place", () => {
    const history = browser("/");
    history.push(aiTab("providers"));
    history.push(aiTab("policy"));
    expect(hubBackSteps(history.state)).toBe(0);
    const other = browser("/");
    other.push(settingsRoute(null));
    other.push({ app: "settings", section: "notifications" });
    other.push(aiTab("tools"));
    // Notifications is not a tab of AI: the arrow does not step back over it.
    expect(hubBackSteps(other.state)).toBe(0);
  });
});

describe("chat policy panel", () => {
  test("each cell keeps its label right above its control", async () => {
    const css = await read("chat/chat.css");
    expect(rule(css, ".ai-policy-grid")).toContain("align-items: start");
    expect(rule(css, ".ai-policy-grid > label, .ai-policy-grid > div")).toContain("align-content: start");
    // The role checkboxes keep their own inline layout (the old descendant selector made them grids too).
    expect(css).not.toContain(".ai-policy-grid label, .ai-policy-grid > div {");
    expect(css).toContain("@media (max-width: 760px) { .ai-roles label, .ai-policy .ai-check { min-height: 44px; } }");
  });
});
