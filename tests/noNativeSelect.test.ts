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

// D91 (v0.13.0 QA, A3; C1 in v0.14): no native prompt, alert, or confirm anywhere in the client.
test("no native prompt or alert in the client", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    const source = await Bun.file(join(root, path)).text();
    source.split("\n").forEach((line, index) => {
      if (/(^|[^\w.])(prompt|alert)\(/.test(line) || /window\.(prompt|alert)\b/.test(line)) offenders.push(`src/${path}:${index + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

/** Offending lines for a native confirm in `source`; a bare `confirm(` counts unless the file defines its own `confirm`. */
function nativeConfirmLines(source: string) {
  const ownConfirm = /\b(function|const|let)\s+confirm\b/.test(source);
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (/^\s*(\/\/|\/?\*)/.test(line)) return;
    if (/\b(window|globalThis|self)\s*\.\s*confirm\b/.test(line) || (!ownConfirm && /(^|[^\w.$])confirm\(/.test(line))) lines.push(index + 1);
  });
  return lines;
}

test("no native confirm in the client (C1: every confirm is the app's own dialog)", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    const source = await Bun.file(join(root, path)).text();
    for (const line of nativeConfirmLines(source)) offenders.push(`src/${path}:${line}`);
  }
  expect(offenders).toEqual([]);
});

test("the native confirm check catches window.confirm and a bare confirm, not a local confirm()", () => {
  expect(nativeConfirmLines('if (!window.confirm("Leave?")) return;')).toEqual([1]);
  expect(nativeConfirmLines('ok = globalThis.confirm("x");')).toEqual([1]);
  expect(nativeConfirmLines('if (!confirm("Leave?")) return;')).toEqual([1]);
  expect(nativeConfirmLines("async function confirm() {}\nvoid confirm();")).toEqual([]);
  expect(nativeConfirmLines("await ask(unsavedKeyConfirm(\"close\"));\nonConfirm();")).toEqual([]);
});

test("Notes → New folder and Add link use the app's name dialog as a history layer (A3)", async () => {
  const app = await Bun.file(join(root, "App.tsx")).text();
  expect(app).toContain("useHistoryDialogGuard(newFolderOpen, closeNewFolder)");
  expect(app).toMatch(/newFolderOpen && <NameDialog[\s\S]*?validate=\{validateFolderName\}/);
  const editor = await Bun.file(join(root, "editor", "NoteEditor.tsx")).text();
  expect(editor).toContain("useHistoryDialogGuard(linkDraft !== null, closeLink)");
});
