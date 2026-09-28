import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { onCheckedChange } from "../src/ui/checkedChange";
import { CrashCard, ErrorBoundary } from "../src/ui/ErrorBoundary";
import { toggleScope, type McpScope } from "../src/mcpPermissions";

test("the MCP permission toggle reads checked before React clears currentTarget (F1)", () => {
  let scopes: McpScope[] = ["notes:read"];
  const queued: Array<(current: McpScope[]) => McpScope[]> = [];
  const setScopes = (updater: (current: McpScope[]) => McpScope[]) => queued.push(updater);
  const handler = onCheckedChange((checked) => setScopes((current) => toggleScope(current, "inbox:write", checked)));
  const event = { currentTarget: { checked: true } as { checked: boolean } | null };
  handler(event as { currentTarget: { checked: boolean } });
  // React nulls currentTarget after dispatch; the updater runs later, during render.
  event.currentTarget = null;
  for (const updater of queued) scopes = updater(scopes);
  expect(scopes).toContain("inbox:write");
  expect(scopes).toContain("inbox:read");
});

const root = join(import.meta.dir, "..", "src");

test("no state updater callback reads event.currentTarget or event.target (F1)", async () => {
  const offenders: string[] = [];
  const setter = /\bset[A-Z]\w*\(\s*\(?\s*\w+\s*\)?\s*=>/g;
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    const source = await Bun.file(join(root, path)).text();
    for (const match of source.matchAll(setter)) {
      const start = source.indexOf("(", match.index!);
      let depth = 0;
      let end = start;
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++;
        else if (source[end] === ")" && --depth === 0) break;
      }
      if (/\b(event|e|ev)\.(currentTarget|target)\b/.test(source.slice(start, end))) offenders.push(`src/${path}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("no async handler reads event.currentTarget or event.target after an await (1b)", async () => {
  const offenders: string[] = [];
  const head = /\basync\s+(?:function\s*\w*\s*)?\(\s*(event|e|ev)\b[^)]*\)\s*(?::[^={]+)?(?:=>)?\s*\{/g;
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    const source = await Bun.file(join(root, path)).text();
    for (const match of source.matchAll(head)) {
      const start = match.index! + match[0].length - 1;
      let depth = 0;
      let end = start;
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}" && --depth === 0) break;
      }
      const body = source.slice(start, end);
      const firstAwait = body.search(/\bawait\b/);
      if (firstAwait < 0) continue;
      // The awaited expression runs before the handler yields; anything on later lines runs after React has cleared currentTarget.
      const lineEnd = body.indexOf("\n", firstAwait);
      const afterAwait = lineEnd < 0 ? "" : body.slice(lineEnd);
      if (new RegExp(`\\b${match[1]}\\.(currentTarget|target)\\b`).test(afterAwait)) offenders.push(`src/${path}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the root error boundary renders a reload card instead of a blank page", () => {
  const boundary = new ErrorBoundary({ children: null, showDetails: false });
  boundary.state = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
  const hidden = renderToStaticMarkup(boundary.render() as ReactElement);
  expect(hidden).toContain("Something went wrong");
  expect(hidden).toContain(">Reload</button>");
  expect(hidden).not.toContain("boom");
  const dev = renderToStaticMarkup(<CrashCard message="boom" onReload={() => undefined} />);
  expect(dev).toContain("boom");
});
