import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cleanLine, escapeHtml, html, SafeHtml, stripMarkdown } from "../server/mail/html";
import { appLink, paths, setMailOriginForTests } from "../server/mail/links";
import { previewFixtures, renderTemplate, TEMPLATES } from "../server/mail/registry";
import { darkPreview, fixtureContext, registerMailPreviewRoutes, renderFixture } from "../server/mail/preview";
import { parseRoute } from "../src/router";

/**
 * Mail templates (docs/plan/research/2026-09-28-outbound-email.md §C, §F.2): golden files, the
 * design contract every mail keeps, escaping, and links (T222, T223, T228, T232, T233).
 * `UPDATE_GOLDEN=1 bun test tests/mailTemplates.test.ts` rewrites the goldens.
 */

const ORIGIN = "https://nook.test";
const GOLDEN = join(import.meta.dir, "mail", "__golden__");

beforeAll(() => setMailOriginForTests(ORIGIN));
afterAll(() => setMailOriginForTests(null));

const render = (id: string) => renderFixture(id, "nook.test")!;
/** Wave 29 templates also keep a dark golden (the dark-mode overrides applied, as the preview does). */
const DARK_GOLDEN = new Set(["calendar.reminder", "calendar.event_changed", "tasks.sprint", "bin.expiring", "digest.summary"]);
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));

describe("golden files", () => {
  for (const fixture of previewFixtures()) {
    test(fixture.id, () => {
      const rendered = render(fixture.id);
      const htmlPath = join(GOLDEN, `${fixture.id}.html`);
      const textPath = join(GOLDEN, `${fixture.id}.txt`);
      const text = `Subject: ${rendered.subject}\n\n${rendered.text}`;
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(htmlPath)) {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(htmlPath, rendered.html);
        writeFileSync(textPath, text);
      }
      expect(rendered.html).toBe(readFileSync(htmlPath, "utf8"));
      expect(text).toBe(readFileSync(textPath, "utf8"));
      if (DARK_GOLDEN.has(fixture.template)) {
        const darkPath = join(GOLDEN, `${fixture.id}.dark.html`);
        const dark = darkPreview(rendered.html);
        if (process.env.UPDATE_GOLDEN === "1" || !existsSync(darkPath)) writeFileSync(darkPath, dark);
        expect(dark).toContain("@media all{");
        expect(dark).toBe(readFileSync(darkPath, "utf8"));
      }
    });
  }
});

describe("the design contract", () => {
  for (const fixture of previewFixtures()) {
    test(`${fixture.id}: layout, text part, links`, () => {
      const { html: markup, text, subject } = render(fixture.id);
      const definition = TEMPLATES[fixture.template];
      expect(markup).toContain('<meta name="color-scheme" content="light dark">');
      expect(markup).toContain("@media (prefers-color-scheme:dark)");
      expect(markup).toContain('role="presentation"');
      expect(markup).toContain('aria-roledescription="email"');
      if (fixture.id !== "security.account") expect(markup).toContain("<!--[if mso]><v:roundrect");
      expect(markup).toContain("max-width:600px");
      expect(markup).toContain("#111113");
      expect(markup).toMatch(/display:none;max-height:0/);
      // No images, remote fonts, scripts, or tracking.
      expect(markup).not.toMatch(/<img|<script|<link|src=|@import|url\(/i);
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject.length).toBeLessThanOrEqual(120);
      // Text part: no markup or entities, and every link on its own line.
      expect(text).not.toMatch(/<[a-z!/]|&[a-z]+;|&#\d+;/i);
      for (const link of hrefs(markup)) {
        expect(link.startsWith(`${ORIGIN}/`)).toBe(true);
        expect(text.split("\n").some((line) => line.trim() === link)).toBe(true);
      }
      // Unsubscribe on activity, reminders, and digest mail (B.2); security says it can't be turned off.
      const unsubscribes = hrefs(markup).filter((link) => link.includes("/mail/unsubscribe"));
      expect(unsubscribes.length > 0).toBe(definition.class === "activity" || definition.class === "reminders" || definition.class === "digest");
      expect(markup.includes("Security emails can't be turned off") || markup.includes("Security emails can&#39;t be turned off")).toBe(definition.class === "security");
    });
  }

  test("every link parses back to the intended app with the router; tokens only in fragments", () => {
    const expected: Record<string, string> = {
      "tasks.assigned": "tasks", "tasks.assigned.many": "tasks", "tasks.comment": "tasks", "sharing.shared": "notes", "sharing.shared.one": "notes",
      "inbox.proposals": "inbox", "security.api_key_created": "home", "security.role_changed": "team", "account.test": "home",
      "calendar.reminder": "calendar", "calendar.reminder.all_day": "calendar", "calendar.reminder.standalone": "notifications",
      "calendar.event_changed": "calendar", "calendar.event_changed.cancelled": "calendar",
      "tasks.sprint": "tasks", "tasks.sprint.completed": "tasks", "bin.expiring": "bin", "digest.summary": "tasks", "digest.summary.weekly": "tasks"
    };
    for (const fixture of previewFixtures()) {
      const links = hrefs(render(fixture.id).html);
      for (const link of links) {
        const url = new URL(link);
        expect(url.origin).toBe(ORIGIN);
        // Only the unsubscribe page's token and nothing else uses a fragment; there are no queries.
        expect(url.search).toBe("");
        if (url.hash) expect(url.hash).toMatch(/^#(t|token|invite)=[A-Za-z0-9_.-]+$/);
        expect(parseRoute(url.pathname).app).toBeTruthy();
      }
      const primary = links.find((link) => !link.includes("/settings/") && !link.includes("/mail/unsubscribe"));
      if (expected[fixture.id] && primary) expect({ id: fixture.id, app: parseRoute(new URL(primary).pathname).app }).toEqual({ id: fixture.id, app: expected[fixture.id] });
    }
    expect(parseRoute(new URL(appLink(paths.card("5f0c5a6e-1b2d-4c3e-8f4a-111111111111", "6a1d6b7f-2c3e-4d4f-9a5b-222222222222"))).pathname))
      .toEqual({ app: "tasks", boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111", cardId: "6a1d6b7f-2c3e-4d4f-9a5b-222222222222" });
    expect(() => paths.card("../../x", "y")).toThrow();
    expect(() => paths.note("5f0c5a6e-1b2d-4c3e-8f4a-111111111111?next=//evil")).toThrow();
    expect(() => appLink("//evil.example.com/x")).toThrow();
    expect(() => paths.verifyEmail("has space")).toThrow();
  });

  test("proposals mail carries key names and counts only (T233)", () => {
    const rendered = renderTemplate("inbox.proposals", { keys: [{ name: "laptop", count: 2 }], total: 2, oldestExpiresAt: null }, fixtureContext("inbox.proposals", "nook.test"));
    expect(rendered.subject).toBe("Key \u201claptop\u201d suggested 2 changes");
    expect(Object.keys(TEMPLATES["inbox.proposals"].fixture())).toEqual(["keys", "total", "oldestExpiresAt"]);
  });
});

describe("escaping (T222, T228)", () => {
  const nasty = ["<script>alert(1)</script>", "\"><img src=x onerror=alert(1)>", "Tom &amp; Jerry", "line\r\nBcc: victim@example.com", "abc\u202egnp.exe", "x".repeat(10_000)];

  test("hostile titles and names render escaped, one line, and capped", () => {
    for (const value of nasty) {
      const rendered = renderTemplate("tasks.assigned", {
        actors: [value],
        cards: [{ boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111", cardId: "6a1d6b7f-2c3e-4d4f-9a5b-222222222222", title: value, boardName: value, dueOn: null, column: value }]
      }, fixtureContext("tasks.assigned", "nook.test"));
      expect(rendered.html).not.toContain("<script>");
      expect(rendered.html).not.toContain("<img");
      expect(rendered.html).not.toContain("\u202e");
      expect(rendered.subject).not.toMatch(/[\r\n\u202e]/);
      expect(rendered.subject.length).toBeLessThanOrEqual(120);
      expect(rendered.html.length).toBeLessThan(40_000);
      expect(rendered.text).not.toMatch(/\r|\u202e/);
    }
    const amp = renderTemplate("sharing.shared", { actors: ["A"], items: [{ kind: "note", id: "7b2e7c80-3d4f-4e5a-8b6c-333333333333", title: "Tom &amp; Jerry", access: null }] }, fixtureContext("sharing.shared", "nook.test"));
    expect(amp.html).toContain("Tom &amp;amp; Jerry");
  });

  test("Wave 29 templates escape hostile titles, places, and names the same way", () => {
    const value = "<script>x</script>\r\nBcc: v@example.test \u202e" + "y".repeat(5000);
    const renders = [
      renderTemplate("calendar.reminder", { ...TEMPLATES["calendar.reminder"].fixture(), title: value, location: value, calendarName: value }, fixtureContext("calendar.reminder", "nook.test")),
      renderTemplate("calendar.event_changed", { ...TEMPLATES["calendar.event_changed"].fixture(), title: value, calendarName: value, actors: [value], after: { time: null, location: value } }, fixtureContext("calendar.event_changed", "nook.test"))
    ];
    for (const rendered of renders) {
      expect(rendered.html).not.toContain("<script>");
      expect(rendered.html).not.toContain("\u202e");
      expect(rendered.subject).not.toMatch(/[\r\n\u202e]/);
      expect(rendered.subject.length).toBeLessThanOrEqual(120);
      expect(rendered.html.length).toBeLessThan(40_000);
    }
  });

  test("SafeHtml is built only by the html tag", () => {
    const Constructor = SafeHtml as unknown as new (value: string) => SafeHtml;
    expect(() => new Constructor("<script>")).toThrow();
    const fake = Object.assign(["<b>"], { raw: ["<b>"] }) as unknown as TemplateStringsArray;
    expect(() => html(fake)).toThrow();
    expect(html`<p>${"<b>"}</p>`.toString()).toBe("<p>&lt;b&gt;</p>");
    expect(html`<p>${html`<b>${"&"}</b>`}</p>`.toString()).toBe("<p><b>&amp;</b></p>");
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  test("cleanLine and stripMarkdown", () => {
    expect(cleanLine("  a\r\n\tb\u202ec  ")).toBe("a b c");
    expect(cleanLine("abcdef", 4)).toBe("abc\u2026");
    expect(cleanLine("", 10, "Untitled")).toBe("Untitled");
    expect(stripMarkdown("# Title\n\n**bold** and [a link](https://x.example) `code`\n- item")).toBe("Title bold and a link code item");
    expect(stripMarkdown("y".repeat(400)).length).toBe(280);
  });
});

describe("dev preview route (D253, T232)", () => {
  test("renders fixtures outside production and answers 404 in production", async () => {
    const dev = new Hono();
    registerMailPreviewRoutes(dev, false);
    const index = await dev.request("/dev/mail/preview");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("tasks.assigned");
    const one = await dev.request("/dev/mail/preview/tasks.assigned?scheme=dark");
    expect(one.status).toBe(200);
    expect(await one.text()).toContain("@media all{");
    const text = await dev.request("/dev/mail/preview/security.account?format=text");
    expect(await text.text()).toStartWith("Subject: Your Nook account was blocked");
    expect((await dev.request("/dev/mail/preview/nope")).status).toBe(404);

    const production = new Hono();
    registerMailPreviewRoutes(production, true);
    production.get("/*", (c) => c.html("spa"));
    for (const path of ["/dev/mail/preview", "/dev/mail/preview/tasks.assigned"]) expect((await production.request(path)).status).toBe(404);
  });
});
