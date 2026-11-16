import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyLink, hostOf, lex, Markdown, type RenderContext } from "../src/chat/markdown/render";

/**
 * Wave 40 security review: hostile Markdown goldens against the renderer (T303, T304), the fixes of
 * the review (M1: backslash paths and mailto headers) and of QA (Q1 Bin kinds, Q2 request bodies).
 */

const calls: string[] = [];
const context: RenderContext = { onExternalLink: (href) => calls.push(`external:${href}`), onNookLink: (path) => calls.push(`nook:${path}`) };
const render = (text: string, streaming = false) => renderToStaticMarkup(<Markdown text={text} context={context} streaming={streaming} />);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
const NOOK = "https://nook.example.test";

describe("review: hostile Markdown", () => {
  test("script, nested HTML, event handlers, and an img onerror are text, never elements", () => {
    const html = render("<div><img src=x onerror=alert(1)><svg onload=alert(2)><iframe srcdoc='x'></iframe></div>\n\n<a href=\"javascript:alert(3)\">a</a> text <math><mtext><table><mglyph><style><img src=x onerror=alert(4)>");
    expect(html).not.toMatch(/<img|<svg|<iframe|<a |<math|<style/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror=/);
  });

  test("reference-style and autolinked javascript:, data:, vbscript:, file:, and protocol-relative links are text", () => {
    const html = render("[ref][1] [ref2][2] [ref3][3] <javascript:alert(1)> <data:text/html,x> [rel](//evil.example.test/x) [file](file:///etc/passwd) [back](\\\\evil.example.test)\n\n[1]: javascript:alert(1)\n[2]: data:text/html;base64,PHNjcmlwdD4=\n[3]: vbscript:msgbox");
    for (const href of hrefs(html)) {
      expect(href).toMatch(/^(https?:|mailto:|\/[^/])/);
    }
    expect(html).not.toMatch(/href="(javascript|data|vbscript|file):/);
    expect(html).not.toContain('href="//evil');
    expect(classifyLink("//evil.example.test/x")).toEqual({ kind: "text" });
    expect(classifyLink("\\\\evil.example.test")).toEqual({ kind: "text" });
  });

  test("a Nook path beginning with a backslash is text: browsers resolve it to another origin (M1)", () => {
    // `/\evil.example.test` looks like a path, yet `new URL("/\\evil.example.test", nook)` is https://evil.example.test/.
    for (const candidate of ["/\\x", "/\\\\x", "/\\evil.example.test", "/\\evil.example.test/steal?x=1", "/x/\\evil"]) {
      expect(new URL(candidate, NOOK).origin === NOOK && !candidate.includes("\\")).toBe(false);
      expect({ candidate, kind: classifyLink(candidate, NOOK).kind }).toEqual({ candidate, kind: "text" });
    }
    const html = render("[docs](/\\evil.example.test/steal?x=1)");
    expect(hrefs(html)).toEqual([]);
    expect(html).toContain("docs");
    // Real Nook paths are canonicalised against the page origin and keep their query; a middle click stays on Nook.
    for (const candidate of ["/%5Cevil.example.test", "/notes/abc", "/chat/abc?x=1#y", "/a/../b"]) {
      const target = classifyLink(candidate, NOOK);
      expect({ candidate, kind: target.kind }).toEqual({ candidate, kind: "nook" });
      if (target.kind === "nook") expect(new URL(target.path, NOOK).origin).toBe(NOOK);
    }
    expect(classifyLink("/a/../b", NOOK)).toEqual({ kind: "nook", path: "/b" });
    expect(hrefs(render("[n](/chat/abc?x=1)"))).toEqual(["/chat/abc?x=1"]);
  });

  test("a mailto keeps the address only: subject and body headers are dropped", () => {
    expect(classifyLink("mailto:a@b.test?subject=hi&body=Paste%20your%20password")).toEqual({ kind: "mailto", href: "mailto:a@b.test" });
    expect(classifyLink("mailto:a@b.test")).toEqual({ kind: "mailto", href: "mailto:a@b.test" });
    expect(hrefs(render("[mail](mailto:a@b.test?body=Paste%20your%20password)"))).toEqual(["mailto:a@b.test"]);
    expect(classifyLink("mailto:a@b.test/x").kind).toBe("text");
  });

  test("homoglyph hosts show their punycode form; the sheet gets the full URL", () => {
    calls.length = 0;
    const html = render("[Apple](https://аpple.example.test/login?next=x)");
    expect(html).toContain("xn--pple-43d.example.test");
    expect(hostOf("https://аpple.example.test/")).toBe("xn--pple-43d.example.test");
    const [href] = hrefs(html);
    expect(href).toBe("https://xn--pple-43d.example.test/login?next=x");
  });

  test("images never produce an img element, including inside links and with data: and javascript: sources", () => {
    const html = render("![a](data:image/svg+xml;base64,PHN2Zz4=) [![b](https://evil.example.test/p.png)](https://evil.example.test/) ![c](javascript:alert(1)) <img src=x>");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[a-z]+[^>]* src=/);
  });

  test("lexing time of a hostile inline-heavy message grows faster than its size (evidence for the renderer's cost)", () => {
    const line = "[a](/\\x) **b** *c* `d` <e> [f][g] ![h](i) ";
    const timeFor = (bytes: number) => {
      const text = `${line.repeat(Math.ceil(bytes / line.length))}\n\n[g]: javascript:x`;
      const started = performance.now();
      lex(text);
      return Math.round(performance.now() - started);
    };
    const at64 = timeFor(64 * 1024);
    const at256 = timeFor(256 * 1024);
    console.log(`review markdown lex: 64 KiB ${at64} ms, 256 KiB ${at256} ms (stored assistant cap is 256 KiB; the live stream is capped at 8 MiB)`);
    const html = render(`${line.repeat(64)}\n\n[g]: javascript:x`);
    expect(html).not.toContain("javascript:");
    expect(at256).toBeGreaterThan(0);
  }, 120_000);

  test("every chat, agent, and provider mutation sends a JSON body, so the server's Content-Type rule never answers 415 (QA Q2)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "chat", "chatApi.ts"), "utf8");
    const mutations = source.split("\n").filter((line) => /method:\s*"(POST|PATCH|PUT|DELETE)"/.test(line));
    expect(mutations.length).toBeGreaterThanOrEqual(10);
    for (const line of mutations) expect({ line, hasBody: /body:/.test(line) }).toEqual({ line, hasBody: true });
    expect(source).toContain('method: "DELETE", body: "{}"');
  });

  test("the Bin knows chats and agents and never crashes on an unknown kind (QA Q1)", async () => {
    const { binItemIcon } = await import("../src/bin/BinSection");
    const { binKindLabel, binItemLabel, filterBinItems } = await import("../src/bin/binFormat");
    const item = (type: string, title = "") => ({ type, title, id: type, folder_id: null, folder_name: null, size_bytes: null, deleted_at: "2026-10-01T00:00:00.000Z", purge_after: "2026-10-31T00:00:00.000Z", purging: false }) as unknown as import("../src/types").BinItem;
    expect(typeof binItemIcon(item("chat"))).toBe("object");
    expect(binItemIcon(item("agent"))).not.toBe(binItemIcon(item("chat")));
    expect(binItemIcon(item("something_new"))).toBe(binItemIcon(item("another_new")));
    expect(binKindLabel(item("chat"))).toBe("Chat");
    expect(binKindLabel(item("agent"))).toBe("Agent");
    expect(binKindLabel(item("something_new"))).toBe("Item");
    expect(binItemLabel(item("chat"))).toBe("Untitled chat");
    expect(binItemLabel(item("something_new"))).toBe("Untitled item");
    const items = [item("chat", "Plans"), item("agent", "Helper"), item("note", "N")];
    expect(filterBinItems(items, "chat").map((entry) => entry.title)).toEqual(["Plans"]);
    expect(filterBinItems(items, "agent").map((entry) => entry.title)).toEqual(["Helper"]);
    const section = readFileSync(join(import.meta.dir, "..", "src", "bin", "BinSection.tsx"), "utf8");
    expect(section).toContain('{ value: "chat", label: "Chats" }');
    expect(section).toContain('{ value: "agent", label: "Agents" }');
    expect(section).toContain("chats, agents, knowledge bases, and the items of your apps (forms, goals, contacts, standups, and more) stay here for 30 days");
  });

  test("code blocks keep their text verbatim and tables carry only the known alignments", () => {
    const html = render("```html\n<script>alert(1)</script>\n```\n\n| a | b |\n|:--|--:|\n| <b>x</b> | y |");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/style="text-align:left"/);
    expect(html).not.toContain("<b>x</b>");
  });
});
