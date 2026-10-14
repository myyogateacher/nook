import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase, Fixtures, LoadedCase } from "./types";

export const CASES_DIR = join(import.meta.dir, "cases");

/** Every case folder (sorted), or only the named ones. Unknown names are an error. */
export async function loadCases(only: readonly string[] = []): Promise<LoadedCase[]> {
  const ids = readdirSync(CASES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const unknown = only.filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`Unknown eval case ${unknown.join(", ")} (cases: ${ids.join(", ")})`);
  const picked = only.length ? ids.filter((id) => only.includes(id)) : ids;
  const out: LoadedCase[] = [];
  for (const id of picked) {
    const dir = join(CASES_DIR, id);
    const module = await import(join(dir, "case.ts")) as { default: EvalCase };
    const testCase = module.default;
    if (testCase.id !== id) throw new Error(`Case folder ${id} declares id ${testCase.id}`);
    const linked: Record<string, string> = {};
    for (const file of readdirSync(dir)) if (file.endsWith(".md") && file !== "doc.md") linked[file.slice(0, -3)] = readFileSync(join(dir, file), "utf8");
    const fixturesPath = join(dir, "fixtures.json");
    out.push({
      ...testCase, dir, linked,
      doc: readFileSync(join(dir, "doc.md"), "utf8"),
      seed: readFileSync(join(dir, "seed.sql"), "utf8"),
      fixtures: existsSync(fixturesPath) ? JSON.parse(readFileSync(fixturesPath, "utf8")) as Fixtures : null
    });
  }
  return out;
}

/** The doc with each `{{link:<name>}}` replaced by that linked page's link. */
export function linkDoc(markdown: string, links: Record<string, string>): string {
  return markdown.replace(/\{\{link:([a-z0-9_-]+)\}\}/g, (whole, name: string) => links[name] ?? whole);
}
