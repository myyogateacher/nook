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

// D91 (v0.13.0 QA, A3): no native prompt or alert anywhere in the client. The remaining
// window.confirm calls are scheduled separately and are not checked here.
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

test("Notes → New folder and Add link use the app's name dialog as a history layer (A3)", async () => {
  const app = await Bun.file(join(root, "App.tsx")).text();
  expect(app).toContain("useHistoryDialogGuard(newFolderOpen, closeNewFolder)");
  expect(app).toMatch(/newFolderOpen && <NameDialog[\s\S]*?validate=\{validateFolderName\}/);
  const editor = await Bun.file(join(root, "editor", "NoteEditor.tsx")).text();
  expect(editor).toContain("useHistoryDialogGuard(linkDraft !== null, closeLink)");
});
