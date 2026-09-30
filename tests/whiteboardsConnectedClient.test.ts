import { describe, expect, test } from "bun:test";
import { MarkdownManager } from "@tiptap/markdown";
import { markdownOptions, noteContentExtensions } from "../src/editor/extensions";
import { cardSummary, clearCardSummaries, embedMarkdown, parseEmbedLine, pastedBoardId } from "../src/editor/whiteboardEmbed";
import { neutralizeWhiteboardEmbeds } from "../shared/whiteboardEmbed";
import { hasUnsupportedElements, isKeptElement, keptLink, refusedImagesMessage, refusedLinks, sceneForSave, withoutRefusedImages } from "../src/whiteboards/historyGuard";
import { autosaveReducer, changedSince, hasPendingWork, initialAutosave, nextSaveDelay, shouldSave } from "../src/whiteboards/autosave";
import { nextPlacement, placedSize, PLACE_STEP_PX } from "../src/whiteboards/boardImages";
import { isTouchLike, swallowNextClick } from "../src/whiteboards/touchClick";
import { binItemLabel, binKindLabel } from "../src/bin/binFormat";

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
    const markdown = `# Plan\n\n${embedMarkdown(doc)}\n\nAfter the board.`;
    expect(embedMarkdown(doc)).toBe(`[Whiteboard](/whiteboards/${doc} "whiteboard")`);
    const json = manager().parse(markdown);
    const node = json.content?.find((item) => item.type === "whiteboardEmbed");
    expect(node?.attrs).toMatchObject({ id: doc });
    expect(roundTrip(markdown)).toBe(markdown);
    expect(roundTrip(roundTrip(markdown))).toBe(markdown);
  });

  test("QA H1: the board's name never reaches the Markdown; an older named line reads the same and saves neutral", () => {
    const named = `[Plan [v2\\] \\ draft](/whiteboards/${doc} "whiteboard")`;
    expect(parseEmbedLine(`${named}\n`)?.id).toBe(doc);
    expect(roundTrip(named)).toBe(embedMarkdown(doc));
    // A card inserted with a name (the picker) still writes the neutral text.
    const md = manager();
    const json = { type: "doc", content: [{ type: "whiteboardEmbed", attrs: { id: doc, name: "Secret merger plan" } }] };
    expect(md.serialize(json).trim()).toBe(embedMarkdown(doc));
    const plain = `[Floor plan](/whiteboards/${doc})`;
    expect(manager().parse(plain).content?.some((item) => item.type === "whiteboardEmbed")).toBe(false);
    const inline = `See ${embedMarkdown(doc)} here`;
    expect(manager().parse(inline).content?.some((item) => item.type === "whiteboardEmbed")).toBe(false);
    expect(parseEmbedLine(`[x](/whiteboards/not-a-uuid "whiteboard")`)).toBeNull();
  });

  test("QA H1: the server-side normalisation rewrites embed lines only, outside code fences, idempotently", () => {
    const text = [
      "# Notes",
      `[Secret](/whiteboards/${doc} "whiteboard")  `,
      `See [Secret](/whiteboards/${doc} "whiteboard") inline`,
      "```md",
      `[Kept](/whiteboards/${other} "whiteboard")`,
      "```",
      `[A \\] b](/whiteboards/${other} "whiteboard")`
    ].join("\n");
    const out = neutralizeWhiteboardEmbeds(text);
    expect(out.split("\n")).toEqual([
      "# Notes",
      `[Whiteboard](/whiteboards/${doc} "whiteboard")  `,
      `See [Secret](/whiteboards/${doc} "whiteboard") inline`,
      "```md",
      `[Kept](/whiteboards/${other} "whiteboard")`,
      "```",
      `[Whiteboard](/whiteboards/${other} "whiteboard")`
    ]);
    expect(neutralizeWhiteboardEmbeds(out)).toBe(out);
    const untouched = "# Nothing to do";
    expect(neutralizeWhiteboardEmbeds(untouched)).toBe(untouched);
  });

  test("the paste rule: only this instance's board link, alone", () => {
    expect(pastedBoardId(`${origin}/whiteboards/${doc}`, origin)).toBe(doc);
    expect(pastedBoardId(`  /whiteboards/${doc.toUpperCase()}/ `, origin)).toBe(doc);
    expect(pastedBoardId(`https://elsewhere.example.test/whiteboards/${doc}`, origin)).toBeNull();
    expect(pastedBoardId(`see ${origin}/whiteboards/${doc}`, origin)).toBeNull();
    expect(pastedBoardId(`${origin}/notes/${doc}`, origin)).toBeNull();
  });
});

describe("review fixes on the canvas", () => {
  const refs = new Map([[doc, { id: doc, mimeType: "image/png", nookDocumentId: doc }], [other, { id: other, mimeType: "image/png", nookDocumentId: other }]]);

  test("M1: pictures a save was refused for leave the scene and the references; the rest is kept and saves", () => {
    const elements = [rect("r"), image("i1", doc), image("i2", other), image("i3", doc, { isDeleted: true })];
    const fixed = withoutRefusedImages(elements, refs, [doc]);
    expect(fixed.removed).toBe(1);
    expect([...fixed.fileIds]).toEqual([doc]);
    expect(fixed.elements.map((element) => element.id)).toEqual(["r", "i2"]);
    expect([...fixed.refs.keys()]).toEqual([other]);
    const scene = sceneForSave(fixed.elements, {}, fixed.refs, origin);
    expect(scene.ok && Object.keys(scene.scene.files)).toEqual([other]);
    // Ids not on this canvas: nothing to take off, so the canvas does not retry.
    expect(withoutRefusedImages(elements, refs, ["2d9e3c74-5a7b-4f8a-9c73-2e8c9b4d1f33"]).fileIds.size).toBe(0);
    expect(refusedImagesMessage(1)).toContain("no longer shared");
    expect(refusedImagesMessage(2)).toStartWith("2 pictures");
  });

  test("M1: after the refused pictures are removed, the save that failed is retried at once", () => {
    let state = autosaveReducer(initialAutosave(3), { type: "edited", at: 0 });
    state = autosaveReducer(state, { type: "saveStarted" });
    state = autosaveReducer(state, { type: "retry" });
    expect(state.status).toBe("dirty");
    expect(shouldSave(state)).toBe(true);
    expect(hasPendingWork(state)).toBe(true);
    expect(nextSaveDelay(state, 10_000)).toBe(0);
    // Only a save in flight (or a refused one) is retried.
    const idle = initialAutosave(3);
    expect(autosaveReducer(idle, { type: "retry" })).toBe(idle);
  });

  test("M2: a restored version replaces the canvas only when nothing changed since the confirm", () => {
    const mark = { editVersion: 4, key: "3:96:#fff:20:false" };
    expect(changedSince(mark, { ...mark })).toBe(false);
    expect(changedSince(mark, { ...mark, editVersion: 5 })).toBe(true);
    expect(changedSince(mark, { ...mark, key: "4:128:#fff:20:false" })).toBe(true);
  });

  test("L3: card summaries are forgotten at sign-out", async () => {
    const first = cardSummary(doc);
    expect(cardSummary(doc)).toBe(first);
    clearCardSummaries();
    expect(cardSummary(doc)).not.toBe(first);
    await Promise.allSettled([first]);
  });
});

describe("QA fixes b (L2, M1, L6)", () => {
  test("L2: pictures placed in one view step down and right; a moved view starts at the centre again", () => {
    const first = nextPlacement(null, "view-a");
    expect(first.offsetPx).toBe(0);
    const second = nextPlacement(first, "view-a");
    expect(second.offsetPx).toBe(PLACE_STEP_PX);
    expect(nextPlacement(second, "view-a").offsetPx).toBe(2 * PLACE_STEP_PX);
    expect(nextPlacement(second, "view-b").offsetPx).toBe(0);
    let step = first;
    for (let index = 0; index < 8; index += 1) step = nextPlacement(step, "view-a");
    expect(step.offsetPx).toBe(0);
  });

  test("M1: only a touch or pen press swallows the one click that follows it, and only briefly", () => {
    expect(isTouchLike({ pointerType: "touch" })).toBe(true);
    expect(isTouchLike({ pointerType: "pen" })).toBe(true);
    expect(isTouchLike({ pointerType: "mouse" })).toBe(false);
    expect(isTouchLike(undefined)).toBe(false);
    const target = new EventTarget();
    swallowNextClick(700, target as never);
    const later = { swallowed: 0 };
    target.addEventListener("click", () => { later.swallowed += 1; });
    const first = new Event("click", { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = new Event("click", { cancelable: true });
    target.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  test("L6: the Bin names a whiteboard as a whiteboard", () => {
    const item = { type: "document" as const, attachment: false, kind: "whiteboard" as const, title: "Floor plan.excalidraw" };
    expect(binKindLabel(item)).toBe("Whiteboard");
    expect(binItemLabel(item)).toBe("Floor plan");
    expect(binKindLabel({ type: "document", attachment: false, kind: "file" })).toBe("File");
    expect(binItemLabel({ type: "document", title: "report.excalidraw" })).toBe("report.excalidraw");
  });
});
