import { describe, expect, test } from "bun:test";
import { MarkdownManager } from "@tiptap/markdown";
import { markdownOptions, noteContentExtensions } from "../src/editor/extensions";
import { embedLinkText, embedMarkdown, parseEmbedLine, pastedBoardId } from "../src/editor/whiteboardEmbed";
import { hasUnsupportedElements, isKeptElement, keptLink, refusedLinks, sceneForSave } from "../src/whiteboards/historyGuard";
import { placedSize } from "../src/whiteboards/boardImages";

/**
 * Connected whiteboards, client side (Wave 24): the save filter for pictures (D198, T164), links
 * from shapes (D199), the note embed's Markdown and paste rule (D208), and placement sizes. Pure.
 */

const origin = "https://nook.example.test";
const doc = "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11";
const other = "1c8d2b63-4f6a-4e9f-8b62-1d7b8a3c0e22";
const rect = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, ...extra });
const image = (id: string, fileId: string, extra: Record<string, unknown> = {}) => ({ id, type: "image", x: 0, y: 0, width: 10, height: 10, fileId, status: "pending", version: 1, ...extra });

describe("pictures in a save (D198)", () => {
  const refs = new Map([[doc, { id: doc, mimeType: "image/png", nookDocumentId: doc }]]);

  test("an image is saved only with a known Nook reference; the files map holds exactly those references", () => {
    const result = sceneForSave([rect("r"), image("i1", doc), image("i2", "uploading"), image("i3", other)], { viewBackgroundColor: "#ffffff" }, refs, origin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.elements.map((element) => element.id)).toEqual(["r", "i1"]);
    expect(result.scene.files).toEqual({ [doc]: { id: doc, mimeType: "image/png", nookDocumentId: doc } });
    expect(JSON.stringify(result.scene)).not.toContain("dataURL");
    // Without references, no picture is ever saved (Wave 23 behaviour).
    const bare = sceneForSave([image("i1", doc)], {}, new Map(), origin);
    expect(bare.ok && bare.scene.elements).toEqual([]);
  });

  test("an image with an unknown file is unsupported (removed on the canvas); a referenced one is kept", () => {
    expect(isKeptElement(image("i", doc), refs)).toBe(true);
    expect(isKeptElement(image("i", other), refs)).toBe(false);
    expect(isKeptElement(image("i", other, { isDeleted: true }), refs)).toBe(true);
    expect(hasUnsupportedElements([rect("r"), image("i", doc)], refs)).toBe(false);
    expect(hasUnsupportedElements([rect("r"), image("i", "pasted-from-elsewhere")], refs)).toBe(true);
    expect(hasUnsupportedElements([{ type: "embeddable" }], refs)).toBe(true);
  });

  test("a new picture keeps its proportions, at most the placement size", () => {
    expect(placedSize(4000, 2000, 480)).toEqual({ width: 480, height: 240 });
    expect(placedSize(100, 50, 480)).toEqual({ width: 100, height: 50 });
    expect(placedSize(1, 1000, 480)).toEqual({ width: 8, height: 480 });
  });
});

describe("links from shapes (D199)", () => {
  test("this instance's URLs become in-app paths; www gets https; anything else is dropped", () => {
    expect(keptLink(`${origin}/notes/${doc}`, origin)).toBe(`/notes/${doc}`);
    expect(keptLink(`/tasks/${doc}/card/${other}`, origin)).toBe(`/tasks/${doc}/card/${other}`);
    expect(keptLink(`/calendar/event/${doc}`, origin)).toBe(`/calendar/event/${doc}`);
    expect(keptLink("www.example.test/page", origin)).toBe("https://www.example.test/page");
    expect(keptLink("https://example.test/a?b=1", origin)).toBe("https://example.test/a?b=1");
    expect(keptLink("mailto:someone@example.test", origin)).toBe("mailto:someone@example.test");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example.test", `${origin}/api/files/${doc}/content`, "/notes/nope", "ftp://example.test"]) {
      expect({ bad, kept: keptLink(bad, origin) }).toEqual({ bad, kept: null });
    }
  });

  test("a refused link is dropped from the saved copy, never making the board unsavable", () => {
    const elements = [rect("a", { link: "javascript:alert(1)" }), rect("b", { link: `${origin}/whiteboards/${doc}` }), rect("c", { link: null })];
    const result = sceneForSave(elements, {}, new Map(), origin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.elements.map((element) => element.link ?? null)).toEqual([null, `/whiteboards/${doc}`, null]);
    expect(refusedLinks(elements, origin)).toBe(1);
  });
});

describe("the note embed card (D208)", () => {
  const manager = () => new MarkdownManager({ extensions: noteContentExtensions(), markedOptions: markdownOptions });
  const roundTrip = (markdown: string) => { const md = manager(); return md.serialize(md.parse(markdown)).trim(); };

  test("the Markdown is a titled link alone in its paragraph, and it round-trips", () => {
    const markdown = `# Plan\n\n${embedMarkdown(doc, "Floor plan")}\n\nAfter the board.`;
    const json = manager().parse(markdown);
    const node = json.content?.find((item) => item.type === "whiteboardEmbed");
    expect(node?.attrs).toMatchObject({ id: doc, name: "Floor plan" });
    expect(roundTrip(markdown)).toBe(markdown);
    expect(roundTrip(roundTrip(markdown))).toBe(markdown);
  });

  test("names with brackets and backslashes survive; a plain link or one inside text stays a link", () => {
    const name = "Plan [v2] \\ draft";
    expect(parseEmbedLine(`${embedMarkdown(doc, name)}\n`)).toEqual({ raw: `${embedMarkdown(doc, name)}\n`, id: doc, name });
    expect(roundTrip(embedMarkdown(doc, name))).toBe(embedMarkdown(doc, name));
    expect(embedLinkText("two\nlines")).toBe("two lines");
    const plain = `[Floor plan](/whiteboards/${doc})`;
    expect(manager().parse(plain).content?.some((item) => item.type === "whiteboardEmbed")).toBe(false);
    const inline = `See ${embedMarkdown(doc, "Floor plan")} here`;
    expect(manager().parse(inline).content?.some((item) => item.type === "whiteboardEmbed")).toBe(false);
    expect(parseEmbedLine(`[x](/whiteboards/not-a-uuid "whiteboard")`)).toBeNull();
  });

  test("the paste rule: only this instance's board link, alone", () => {
    expect(pastedBoardId(`${origin}/whiteboards/${doc}`, origin)).toBe(doc);
    expect(pastedBoardId(`  /whiteboards/${doc.toUpperCase()}/ `, origin)).toBe(doc);
    expect(pastedBoardId(`https://elsewhere.example.test/whiteboards/${doc}`, origin)).toBeNull();
    expect(pastedBoardId(`see ${origin}/whiteboards/${doc}`, origin)).toBeNull();
    expect(pastedBoardId(`${origin}/notes/${doc}`, origin)).toBeNull();
  });
});
