import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement } from "react";
import { toast, type ToastT } from "sonner";
import { ACTION_DURATION, SELECTABLE_DURATION, TOAST_DURATION, errorText, flash, notifier, notify } from "../src/ui/notify";

/** The toast Sonner holds for an id (its history keeps every toast shown in this process). */
const shown = (id: string | number) => {
  const found = [...toast.getHistory()].reverse().find((item) => item.id === id && !("dismiss" in item && item.dismiss));
  if (!found) throw new Error(`no toast ${id}`);
  return found as ToastT;
};
const root = join(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
});

describe("notify (ui/notify.ts)", () => {
  test("each type maps to Sonner's type with its default duration", () => {
    for (const kind of ["success", "info", "warning"] as const) {
      const item = shown(notify[kind](`A ${kind} message`));
      expect(item.type).toBe(kind);
      expect(item.title).toBe(`A ${kind} message`);
      expect(item.duration).toBe(TOAST_DURATION[kind]);
      expect(item.closeButton).toBeUndefined();
    }
    expect(TOAST_DURATION.success).toBe(4000);
    expect(TOAST_DURATION.info).toBe(4000);
  });

  test("an error stays until dismissed, has a close button, and is announced assertively", () => {
    const item = shown(notify.error("Could not save the note"));
    expect(item.type).toBe("error");
    expect(item.duration).toBe(Infinity);
    expect(item.closeButton).toBe(true);
    // Sonner's region is polite; the error's text is its own role="alert".
    expect(isValidElement(item.title)).toBe(true);
    const title = item.title as ReactElement<{ role: string; children: string }>;
    expect(title.props.role).toBe("alert");
    expect(title.props.children).toBe("Could not save the note");
    // Even an explicit duration does not shorten an error unless asked: the option wins.
    expect(shown(notify.error("Short error", { duration: 8000 })).duration).toBe(8000);
  });

  test("an action is a button on the toast, and the toast stays long enough to reach it", () => {
    let undone = 0;
    const item = shown(notify.success("Moved “a.pdf” to the Bin", { action: { label: "Undo", onClick: () => { undone += 1; } } }));
    expect(item.type).toBe("success");
    expect(item.duration).toBe(ACTION_DURATION);
    const action = item.action as { label: string; onClick: (event: unknown) => void };
    expect(action.label).toBe("Undo");
    action.onClick({});
    expect(undone).toBe(1);
  });

  test("a duration can be set; a selectable message stays longer and is not swiped", () => {
    expect(shown(notify.info("Custom", { duration: 1234 })).duration).toBe(1234);
    const item = shown(notify.warning("Could not copy. The link is https://x", { selectable: true }));
    expect(item.duration).toBe(SELECTABLE_DURATION);
    expect(item.dismissible).toBe(false);
    expect(item.className).toBe("toast-selectable");
  });

  test("the same message replaces the toast on screen instead of stacking a copy", () => {
    expect(notify.success("Saved")).toBe(notify.success("Saved"));
    expect(notify.success("Saved")).not.toBe(notify.error("Saved"));
    expect(notify.info("One", { id: "fixed" })).toBe("fixed");
  });

  test("flash stays a neutral toast for the call sites without a type", () => {
    flash("Published in another window");
    expect(shown("info:Published in another window").type).toBe("info");
  });

  test("the module notifier: typed methods, and the plain call is neutral with an optional action", () => {
    notifier.error("Could not move the card");
    expect(shown("error:Could not move the card").duration).toBe(Infinity);
    let ran = false;
    notifier("All subtasks are done", { label: "Move", run: () => { ran = true; } }, { selectable: false });
    const item = shown("info:All subtasks are done");
    expect(item.type).toBe("info");
    (item.action as { onClick: (event: unknown) => void }).onClick({});
    expect(ran).toBe(true);
  });

  test("errorText takes a caught error's message or the fallback", () => {
    expect(errorText(new Error("Too large"), "Could not upload")).toBe("Too large");
    expect(errorText(new Error(""), "Could not upload")).toBe("Could not upload");
    expect(errorText("nope", "Could not upload")).toBe("Could not upload");
  });
});

describe("one toast system", () => {
  const files = sources(join(root, "src"));
  const all = files.map((path) => ({ path, text: readFileSync(path, "utf8") }));

  test("one <Toaster>, mounted once at the app root, with at most 3 toasts at the bottom centre", () => {
    expect(all.filter(({ text }) => /import \{[^}]*\bToaster\b[^}]*\} from "sonner"/.test(text)).map(({ path }) => path.slice(root.length + 1))).toEqual(["src/ui/AppToaster.tsx"]);
    // Everything else goes through the wrapper.
    expect(all.filter(({ text }) => /from "sonner"/.test(text)).map(({ path }) => path.slice(root.length + 1)).sort()).toEqual(["src/ui/AppToaster.tsx", "src/ui/notify.ts"]);
    expect(all.filter(({ text }) => text.includes("<AppToaster")).map(({ path }) => path.slice(root.length + 1))).toEqual(["src/main.tsx"]);
    expect(read("src", "main.tsx").match(/<AppToaster \/>/g)).toHaveLength(1);
    const toaster = read("src", "ui", "AppToaster.tsx");
    expect(toaster).toContain("export const VISIBLE_TOASTS = 3;");
    expect(toaster).toContain('position="bottom-center"');
    expect(toaster).toContain('theme="dark"');
    // Toasts push no history entry: nothing in the toast layer touches history.
    expect(toaster).not.toMatch(/history\.|pushState|useHistoryDialogGuard/);
    expect(read("src", "ui", "notify.ts")).not.toMatch(/history\.|pushState/);
  });

  test("on a phone the stack sits above the bottom bar and the safe area", () => {
    const css = read("src", "ui", "toasts.css");
    expect(css).toContain("--toast-offset-bottom: 28px;");
    expect(css).toMatch(/@media \(max-width: 760px\) \{\n {2}:root \{ --toast-offset-bottom: calc\(74px \+ env\(safe-area-inset-bottom\)\); \}/);
  });

  test("the module copies are gone (Files, Tasks, Inbox, and App's own)", () => {
    for (const { path, text } of all) {
      const name = path.slice(root.length + 1);
      for (const old of ["setToast(", "setPhoneToast", "toastDispatch", "fileToastReducer", "toastDuration", 'className="toast', "inbox-toast", "file-toast"]) {
        if (text.includes(old)) throw new Error(`${name} still has ${old}`);
      }
    }
    expect(read("src", "styles.css")).not.toMatch(/^\s*\.toast \{/m);
  });

  test("Sonner is pinned, and its stylesheet is a static file rather than a runtime <style>", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.sonner).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read("src", "ui", "AppToaster.tsx")).toContain('import "sonner/dist/styles.css";');
    const vite = read("vite.config.ts");
    expect(vite).toContain("function sonnerStaticStyles(): Plugin");
    expect(vite).toMatch(/plugins: \[[^\]]*sonnerStaticStyles\(\)/);
  });
});
