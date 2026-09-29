import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";

// C5: the docs site's environment table lists exactly the variables of OPERATIONS.md → Configuration
// (it had drifted: no RESEND_WEBHOOK_SECRET and no other email or push rows), and every variable that
// Compose or .env.example passes to the server is documented there.

const root = join(import.meta.dir, "..");
const read = (path: string) => Bun.file(join(root, path)).text();
// The Docker verify stage copies src, server, and tests only: the docs checks run in the repository.
const docsPresent = ["docs/OPERATIONS.md", "site/index.html", ".env.example", "compose.yaml"].every((path) => existsSync(join(root, path)));

async function operationsVariables() {
  const text = await read("docs/OPERATIONS.md");
  const section = text.slice(text.indexOf("## Configuration"), text.indexOf("\n## ", text.indexOf("## Configuration") + 5));
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1]!);
}

async function siteVariables() {
  const html = await read("site/index.html");
  const section = html.slice(html.indexOf('id="configuration"'), html.indexOf("</section>", html.indexOf('id="configuration"')));
  return [...section.matchAll(/<tr><td><code>([A-Z][A-Z0-9_]+)<\/code><\/td>/g)].map((match) => match[1]!);
}

test.skipIf(!docsPresent)("the docs site's environment table matches OPERATIONS.md, row for row", async () => {
  const operations = await operationsVariables();
  expect(operations).toContain("RESEND_WEBHOOK_SECRET");
  expect(await siteVariables()).toEqual(operations);
});

test.skipIf(!docsPresent)("every variable in .env.example and compose.yaml is documented in OPERATIONS.md", async () => {
  const documented = new Set(await operationsVariables());
  const example = [...(await read(".env.example")).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]!);
  const compose = await read("compose.yaml");
  const passed = [...compose.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!);
  expect([...example, ...passed].filter((name) => !documented.has(name))).toEqual([]);
});

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function headingAnchors(markdown: string) {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const heading = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const text = heading[1]!.replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "");
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of markdown.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]!);
  return anchors;
}

test("heading anchors follow GitHub's rules", () => {
  expect([...headingAnchors("# Rate limits and reverse proxies\n## Upgrades\n## Upgrades\n### `APP_ORIGIN` and TLS\n```\n# not a heading\n```")])
    .toEqual(["rate-limits-and-reverse-proxies", "upgrades", "upgrades-1", "app_origin-and-tls"]);
});

test.skipIf(!docsPresent)("every in-repo Markdown link to an anchor lands on a heading (README, docs)", async () => {
  const { Glob } = await import("bun");
  const { dirname, relative } = await import("node:path");
  const files = ["README.md", ...await Array.fromAsync(new Glob("docs/**/*.md").scan({ cwd: root }))];
  const broken: string[] = [];
  const cache = new Map<string, Set<string> | null>();
  const anchorsOf = async (path: string) => {
    if (!cache.has(path)) cache.set(path, existsSync(join(root, path)) ? headingAnchors(await read(path)) : null);
    return cache.get(path)!;
  };
  for (const file of files) {
    const markdown = await read(file);
    for (const match of markdown.matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)) {
      const [, target, anchor] = match;
      if (/^[a-z]+:/i.test(target!)) continue;
      const path = target ? relative(root, join(root, dirname(file), target)) : file;
      if (!path.endsWith(".md")) continue;
      const anchors = await anchorsOf(path);
      if (!anchors?.has(decodeURIComponent(anchor!))) broken.push(`${file} → ${path}#${anchor}`);
    }
  }
  expect(broken).toEqual([]);
});
