/**
 * The Settings page title never shows a focus ring after a mouse click (UI fix, 2026-10-14): a section
 * move that loses focus sends it to the hub's h1 through ui/scriptFocus, which marks it
 * `data-script-focus` (styles.css: no outline). The mark used to go on any blur, so the window losing
 * focus (another app, a screenshot tool) dropped it while the h1 stayed focused, and Chrome's
 * :focus-visible showed the yellow ring on return. Rendered with happy-dom.
 */
import { describe, expect, test } from "bun:test";
import { installDom, render } from "./support/dom";
import { hubEntries } from "../src/settings/hubModel";

installDom("http://nook.test/settings/notifications");

describe("Settings title focus", () => {
  test("a mouse click that moves to another section focuses the h1 without a ring, and the mark survives a window blur", async () => {
    const { SettingsHubShell } = await import("../src/settings/SettingsHub");
    const entries = hubEntries("admin", { teamModuleEnabled: true });
    const page = (selected: "notifications" | "ai", title: string, children: React.ReactNode) => <SettingsHubShell displayName="Ada" role="admin" entries={entries} selected={selected} listScreen={false} title={title} screenKey={selected} showBack={false} onBack={() => undefined} onSelect={() => undefined} onHome={() => undefined} account={<div className="app-account" />}>
      {children}
    </SettingsHubShell>;
    const view = await render(page("notifications", "Notifications", <section className="settings-content"><button type="button">Open AI settings</button></section>));
    const heading = () => document.getElementById("settings-hub-title") as HTMLElement;

    // A mouse click on a control the next section does not have: focus is lost with it, so it moves to the title.
    const control = view.button("Open AI settings")!;
    control.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    control.focus();
    await view.rerender(page("ai", "AI", <section className="settings-content">Providers</section>));
    expect(document.activeElement).toBe(heading());
    expect(heading().textContent).toBe("AI");
    expect(heading().hasAttribute("data-script-focus")).toBe(true);

    // The window losing focus blurs the h1 but leaves it the active element: the mark stays.
    heading().dispatchEvent(new window.FocusEvent("blur"));
    expect(document.activeElement).toBe(heading());
    expect(heading().hasAttribute("data-script-focus")).toBe(true);

    // Focus really moving elsewhere clears it.
    view.button("Home")!.focus();
    expect(heading().hasAttribute("data-script-focus")).toBe(false);
  });

  test("the stylesheet hides the outline on a marked heading and keeps rings on buttons", async () => {
    const styles = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
    expect(styles).toContain("[data-script-focus]:focus, :is(h1, h2, h3, h4)[data-script-focus]:focus,");
    expect(styles).toContain("button:focus-visible, input:focus-visible, [contenteditable]:focus-visible { outline: 2px solid var(--yellow);");
  });
});
