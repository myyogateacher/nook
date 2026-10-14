import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsTabs } from "../src/settings/SettingsTabs";

const root = join(import.meta.dir, "..", "src");
const read = (path: string) => Bun.file(join(root, path)).text();
/** The declarations of one exact selector in a stylesheet. */
const rule = (sheet: string, selector: string) => {
  const start = sheet.indexOf(`${selector} {`);
  return start === -1 ? null : sheet.slice(start, sheet.indexOf("}", start));
};

describe("v0.29 layout fixes", () => {
  test("H1: the tab row sits in a bar that does not scroll, so a short page cannot collapse it", async () => {
    const markup = renderToStaticMarkup(<SettingsTabs label="AI settings" idPrefix="ai" tabs={[{ id: "providers", label: "Model providers" }, { id: "policy", label: "Chat policy" }]} selected="policy" onSelect={() => undefined} />);
    expect(markup).toStartWith('<div class="settings-tabs-bar"><div class="settings-tabs" role="tablist" aria-label="AI settings">');
    const hub = await read("settings/settingsHub.css");
    const bar = rule(hub, ".settings-tabs-bar");
    expect(bar).not.toBeNull();
    // The grid or flex item: never shrinks, and lets the row inside scroll sideways.
    for (const declaration of ["flex: none", "min-width: 0"]) expect(bar).toContain(declaration);
    // Not itself a scroll container (a scroller's automatic minimum height is 0: the 1 px collapse).
    expect(bar).not.toContain("overflow");
    expect(rule(hub, ".settings-tabs")).toContain("flex: none");
    // The keys page's own wrapper is gone: the shared bar does its job everywhere.
    expect(await read("keys/KeysSettings.tsx")).not.toContain("keys-tabs-bar");
    expect(await read("keys/keys.css")).not.toContain(".keys-tabs-bar");
  });

  test("M1: dialog forms keep their rows at their own height in a full-height sheet", async () => {
    expect(rule(await read("files/files.css"), ".file-dialog-form")).toContain("align-content: start");
    expect(rule(await read("chat/chat.css"), ".chat-link-key")).toContain("align-content: start");
    // The sticky footer stays: the body scrolls, the footer pins to its bottom.
    const files = await read("files/files.css");
    expect(rule(files, ".file-dialog > .file-dialog-form")).toContain("overflow-y: auto");
    expect(rule(files, ".file-dialog > .file-dialog-form > .file-dialog-actions:last-child")).toContain("position: sticky");
  });

  test("L1: Continue as a copy is a shared secondary action button", async () => {
    expect(await read("chat/ChatApp.tsx")).toContain('className="action-button secondary chat-continue"');
    const own = rule(await read("chat/chat.css"), ".chat-continue");
    expect(own).not.toContain("min-height");
    expect(own).not.toContain("display");
  });

  test("L2: New API key keeps Create in view, with the shared labels and button size", async () => {
    const keys = await read("keys/keys.css");
    const footer = rule(keys, ".keys-dialog-body > form > .keys-dialog-actions.inline:last-child");
    expect(footer).toContain("position: sticky");
    expect(footer).toContain("bottom: 0");
    // A field scrolled into view stops above the footer, not under it.
    expect(rule(keys, ".keys-dialog-body:has(> form > .keys-dialog-actions.inline:last-child)")).toContain("scroll-padding-bottom");
    const styles = await read("styles.css");
    expect(styles).toMatch(/:is\(\.keys-dialog, \.team-dialog\) :is\([^)]*\.keys-fieldset > legend[^)]*\.grant-field > span:first-child\) \{[^}]*text-transform: uppercase/);
    for (const file of ["keys/GrantBuilder.tsx", "keys/VaultGrantBuilder.tsx"]) expect(await read(file)).toContain('className="action-button secondary grant-add"');
  });

  test("L3: a button that starts with an icon keeps the icon beside its label", async () => {
    const styles = await read("styles.css");
    const shared = rule(styles, ":where(.secondary-button, .primary-button, .danger-button):where(:has(> svg:first-child))");
    expect(shared).not.toBeNull();
    for (const declaration of ["display: inline-flex", "align-items: center", "gap: 6px"]) expect(shared).toContain(declaration);
    // The Sync tools button is one of them.
    expect(await read("chat/ToolServers.tsx")).toContain('className="secondary-button" onClick={() => { void sync(server); }} disabled={syncing === server.id}><RefreshCw />');
    // The inline-icon hack that assumed an inline svg is gone.
    expect(await read("chat/chat.css")).not.toContain(".ai-provider-actions .secondary-button svg { width: 14px; margin-right: 5px; vertical-align: -2px; }");
  });
});
