import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

// D91: every dropdown is the shared Select or Combobox from src/ui. The last native select, the Tasks
// card dialog's assignee picker, moved to Combobox in Wave 13B, so nothing is allowlisted.
const allowlist = new Set<string>();
const root = join(import.meta.dir, "..", "src");

test("no native select outside src/ui", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("**/*.tsx").scan({ cwd: root })) {
    if (path.startsWith("ui/") || allowlist.has(path)) continue;
    const source = await Bun.file(join(root, path)).text();
    source.split("\n").forEach((line, index) => {
      if (/<select(\s|>|$)/.test(line)) offenders.push(`src/${path}:${index + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("the allowlist only names files that still have a native select", async () => {
  for (const path of allowlist) {
    const source = await Bun.file(join(root, path)).text();
    expect(/<select[\s>]/.test(source)).toBe(true);
  }
});

// D91 (v0.13.0 QA, A3; C1 and review L4): no native prompt, alert, or confirm anywhere in the client.

/**
 * `source` with comments and string literals blanked out (newlines kept), so only code is searched.
 * Template literals are blanked whole, expressions included: a limitation, not a loophole worth it.
 */
function codeOnly(source: string) {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; out += "  "; index += 1; continue; }
      if (char === "/" && next === "*") { state = "block"; out += "  "; index += 1; continue; }
      if (char === "'" || char === '"' || char === "`") { state = char; out += char; continue; }
      out += char;
      continue;
    }
    if (state === "line") { if (char === "\n") { state = "code"; out += "\n"; } else out += " "; continue; }
    if (state === "block") { if (char === "*" && next === "/") { state = "code"; out += "  "; index += 1; } else out += char === "\n" ? "\n" : " "; continue; }
    // Inside a string.
    if (char === "\\") { out += "  "; index += 1; continue; }
    if (char === state) { state = "code"; out += char; continue; }
    out += char === "\n" ? "\n" : " ";
  }
  return out;
}

/**
 * Every way to reach the browser's own confirm, alert, or prompt (review L4): a bare call, a
 * property of window / globalThis / self / top / parent / frames (dot, optional chaining, or a
 * line break before the dot), bracket access by name, the `(0, confirm)(…)` form, and destructuring
 * them from window. Local helpers may not be called `confirm`, `alert`, or `prompt` either.
 */
function nativeDialogLines(source: string) {
  const code = codeOnly(source);
  const names = "(?:confirm|alert|prompt)";
  const patterns = [
    new RegExp(`(^|[^\\w.$])${names}\\s*(\\?\\.\\s*)?\\(`, "g"),
    new RegExp(`\\b(?:window|globalThis|self|top|parent|frames)\\s*(?:\\?\\.|\\.)\\s*${names}\\b`, "g"),
    new RegExp(`\\(\\s*0\\s*,\\s*${names}\\s*\\)`, "g"),
    new RegExp(`\\{[^}]*\\b${names}\\b[^}]*\\}\\s*=\\s*(?:window|globalThis|self)\\b`, "g")
  ];
  const lines = new Set<number>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) lines.add(code.slice(0, match.index).split("\n").length);
  }
  // Bracket access names the dialog in a string, which codeOnly blanks: match the source, keeping only
  // brackets that are code (not inside a comment or another string).
  for (const match of source.matchAll(new RegExp(`\\[\\s*(["'\`])${names}\\1\\s*\\]`, "g"))) {
    if (code[match.index!] === "[") lines.add(source.slice(0, match.index).split("\n").length);
  }
  return [...lines].sort((left, right) => left - right);
}

test("no native confirm, alert, or prompt in the client (C1, review L4: no whole-file allowance)", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    const source = await Bun.file(join(root, path)).text();
    for (const line of nativeDialogLines(source)) offenders.push(`src/${path}:${line}`);
  }
  expect(offenders).toEqual([]);
});

test("the check catches every form of reaching the native dialogs, and nothing in comments or strings", () => {
  const caught = [
    'if (!window.confirm("Leave?")) return;', 'ok = globalThis.confirm("x");', 'if (!confirm("Leave?")) return;', "window?.confirm('x')",
    'window["confirm"]("x")', "self['alert']('x')", "top.confirm('x')", "parent.prompt('x')", "(0, confirm)('x')", "confirm?.('x')",
    "const ok = window\n  .confirm('x');", "const { confirm: ask } = window;", "alert ('x')", "async function confirm() {}\nvoid confirm();"
  ];
  for (const source of caught) expect({ source, caught: nativeDialogLines(source).length > 0 }).toEqual({ source, caught: true });
  expect(nativeDialogLines("const ok = window\n  .confirm('x');")).toEqual([1]);
  const allowed = [
    'await ask(unsavedKeyConfirm("close"));\nonConfirm();', "// window.confirm('old')", "/* confirm('x') */", '"Please confirm (twice)"',
    "setPrompt(null); showAlert(); confirmAction();", "const pendingConfirm = null;", "`confirm(${x})`", "item.confirm()", "{ confirm: \"Save\" }"
  ];
  for (const source of allowed) expect({ source, lines: nativeDialogLines(source) }).toEqual({ source, lines: [] });
});

test("Notes → New folder and Add link use the app's name dialog as a history layer (A3)", async () => {
  const app = await Bun.file(join(root, "App.tsx")).text();
  expect(app).toContain("useHistoryDialogGuard(newFolderOpen, closeNewFolder)");
  expect(app).toMatch(/newFolderOpen && <NameDialog[\s\S]*?validate=\{validateFolderName\}/);
  const editor = await Bun.file(join(root, "editor", "NoteEditor.tsx")).text();
  expect(editor).toContain("useHistoryDialogGuard(linkDraft !== null, closeLink)");
});
