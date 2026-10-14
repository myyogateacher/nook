import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Several agents run `bun test` on one host at once, so no test may listen on a fixed port: fakes and
 * upstreams take port 0 and read `server.port` (tests/support/ports.ts). This scans tests/ for a
 * listen call with a fixed port. Port numbers in origins of processes that never listen (the probes
 * call the app's fetch handler directly) and in URLs that are only refused are not listen ports.
 */

const testsDir = import.meta.dir;
const self = join(testsDir, "testPorts.test.ts");
// The fakes the tests share with the QA instances (fake doc MCP, scripted report provider) live in scripts/.
const scriptsDir = join(testsDir, "..", "scripts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && path !== self ? [path] : [];
  });
}

/** The argument text of the call whose "(" is at `open`, by bracket depth (good enough for test sources). */
function callArguments(source: string, open: number) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

/** Port values a listen call may use: 0, or a helper's own `port` parameter that defaults to 0. */
const ALLOWED_PORT_VALUES = new Set(["0", "port", "options.port ?? 0"]);

function fixedListenPorts(text: string) {
  // A support file's `import.meta.main` block is a manual QA entry point that takes its port from argv.
  const source = text.split("if (import.meta.main)")[0]!;
  const findings: string[] = [];
  const line = (index: number) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(/(?<!function )\bstart(?:Fake(?!Google\b|S3\b)\w+|ScriptedProvider)\(\s*([^,)\s]+)/g)) {
    if (match[1] !== "0") findings.push(`line ${line(match.index!)}: ${match[0]}`);
  }
  for (const match of source.matchAll(/(?<!function )\b(?:Bun\.(?:serve|listen)|startFakeGoogle|startFakeS3)\s*\(/g)) {
    const open = match.index! + match[0].length - 1;
    const port = /\bport\s*:\s*([^,\n}]+)/.exec(callArguments(source, open))?.[1]?.trim();
    if (port !== undefined && !ALLOWED_PORT_VALUES.has(port)) findings.push(`line ${line(match.index!)}: ${match[0]} port: ${port}`);
  }
  for (const match of source.matchAll(/\.listen\(\s*([^,)\s{]+)/g)) {
    if (match[1] !== "0") findings.push(`line ${line(match.index!)}: ${match[0]}`);
  }
  return findings;
}

describe("test ports", () => {
  test("the scan catches fixed listen ports and lets ephemeral ones through", () => {
    expect(fixedListenPorts(`const a = startFakeProvider(24478); const b = startFakeMcpServer(PORT, { sse: true });`)).toHaveLength(2);
    expect(fixedListenPorts(`Bun.serve({ hostname: "127.0.0.1", port: 24538, fetch() { return new Response(); } });`)).toHaveLength(1);
    expect(fixedListenPorts(`Bun.serve({\n  hostname: "127.0.0.1", port: IMAGE_PORT,\n  fetch() {}\n});`)).toHaveLength(1);
    expect(fixedListenPorts(`createServer(handler).listen(24001);`)).toHaveLength(1);
    expect(fixedListenPorts(`await startFakeGoogle({ port: 22302 });`)).toHaveLength(1);
    expect(fixedListenPorts(`export function startFakeProvider(port: number) {}\nif (import.meta.main) startFakeS3({ port: Number(argv) });`)).toEqual([]);
    expect(fixedListenPorts(`startFakeClickhouse(24871); startFakeDocMcp(24900, { token }); startScriptedProvider(24901, qaScript);`)).toHaveLength(3);
    expect(fixedListenPorts(`startFakeClickhouse(0); startFakeDocMcp(0, { token }); startScriptedProvider(0, qaEditScript); startFakeGoogle({ port: 0 });`)).toEqual([]);
    expect(fixedListenPorts(`startFakeProvider(0); Bun.serve({ port: 0, fetch }); Bun.serve(serverOptions); server.listen(0);`)).toEqual([]);
  });

  test("no file under tests/ listens on a fixed port", () => {
    const fakes = readdirSync(scriptsDir).filter((name) => /^fake.*\.ts$/.test(name)).map((name) => join(scriptsDir, name));
    const findings = [...sourceFiles(testsDir), ...fakes].flatMap((path) => fixedListenPorts(readFileSync(path, "utf8")).map((finding) => `${relative(testsDir, path)} ${finding}`));
    expect(findings).toEqual([]);
  });
});
