import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssOrderProblems, stylesheetLinks } from "../vite.config";

// v0.35.0 QA (Files layout): the global stylesheets must load before every module stylesheet. The
// build fails otherwise (cssOrder() in vite.config.ts); these cases pin what that check accepts.
describe("stylesheet order check", () => {
  const html = (...hrefs: string[]) => `<head><link rel="modulepreload" href="/assets/a.js">${hrefs.map((href) => `<link rel="stylesheet" crossorigin href="/assets/${href}">`).join("")}</head>`;

  test("lists stylesheet links in document order", () => {
    expect(stylesheetLinks(html("boot-1.css", "binUndo-2.css", "index-3.css"))).toEqual(["/assets/boot-1.css", "/assets/binUndo-2.css", "/assets/index-3.css"]);
    expect(stylesheetLinks('<link href="/x.css" rel=stylesheet><link rel="icon" href="/i.svg">')).toEqual(["/x.css"]);
  });

  test("accepts the global stylesheet first", () => {
    expect(cssOrderProblems(html("boot-1.css", "binUndo-2.css", "index-3.css"), ["assets/boot-1.css"])).toEqual([]);
  });

  test("refuses a module stylesheet ahead of the global one (the v0.35.0 regression)", () => {
    const problems = cssOrderProblems(html("binUndo-2.css", "index-3.css"), ["assets/index-3.css"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must come first");
  });

  test("refuses a build whose global stylesheet is not linked or not found", () => {
    expect(cssOrderProblems(html("index-3.css"), ["assets/boot-1.css"])[0]).toContain("does not link boot-1.css");
    expect(cssOrderProblems(html("index-3.css"), [])[0]).toContain("not in a CSS file of their own chunk");
  });

  test("the build keeps the global stylesheets in the boot chunk, imported first by the entry", () => {
    const config = readFileSync(join(import.meta.dir, "..", "vite.config.ts"), "utf8");
    expect(config).toMatch(/plugins: \[[^\]]*cssOrder\(\)/);
    expect(config).toContain('{ name: "boot", test: BOOT_MODULES, priority: 100 }');
    const main = readFileSync(join(import.meta.dir, "..", "src", "main.tsx"), "utf8");
    expect(main.indexOf('import "./styles.css"')).toBeLessThan(main.indexOf('import "./ui/ui.css"'));
  });
});
