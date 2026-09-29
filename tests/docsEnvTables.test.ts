import { expect, test } from "bun:test";
import { join } from "node:path";

// C5: the docs site's environment table lists exactly the variables of OPERATIONS.md → Configuration
// (it had drifted: no RESEND_WEBHOOK_SECRET and no other email or push rows), and every variable that
// Compose or .env.example passes to the server is documented there.

const root = join(import.meta.dir, "..");
const read = (path: string) => Bun.file(join(root, path)).text();

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

test("the docs site's environment table matches OPERATIONS.md, row for row", async () => {
  const operations = await operationsVariables();
  expect(operations).toContain("RESEND_WEBHOOK_SECRET");
  expect(await siteVariables()).toEqual(operations);
});

test("every variable in .env.example and compose.yaml is documented in OPERATIONS.md", async () => {
  const documented = new Set(await operationsVariables());
  const example = [...(await read(".env.example")).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]!);
  const compose = await read("compose.yaml");
  const passed = [...compose.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!);
  expect([...example, ...passed].filter((name) => !documented.has(name))).toEqual([]);
});
