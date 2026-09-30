import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalSceneJson, emptyScene, isAllowedLink, jsonDepth, sceneImageDocumentIds, sceneTexts, sceneWithoutImages, validateScene, whiteboardDisplayName, whiteboardFileName, WHITEBOARD_IMAGES_ENABLED,
  WHITEBOARD_MAX_ELEMENTS, WHITEBOARD_MAX_POINTS, WHITEBOARD_MAX_POINTS_PER_ELEMENT, WHITEBOARD_MAX_TEXT_CHARS
} from "../shared/whiteboardScene";

/** The bounded scene validator (whiteboard plan §7, D197, T160, T161, T164). Pure. */

const fixturesDir = join(import.meta.dir, "fixtures", "whiteboards");
const fixture = (name: string) => JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as Record<string, any>;

let counter = 0;
function rect(extra: Record<string, unknown> = {}) {
  counter += 1;
  return {
    id: `el${counter}`, type: "rectangle", x: 10, y: 20, width: 100, height: 50, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0",
    roundness: { type: 3 }, seed: 1_968_410_350, version: 3, versionNonce: 1_157_293_487, isDeleted: false, boundElements: null,
    updated: 1_759_100_000_000, link: null, locked: false, ...extra
  };
}
const scene = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {}, ...extra });
const code = (input: unknown) => {
  const result = validateScene(input);
  return result.ok ? "OK" : result.code;
};

describe("whiteboard scene validator", () => {
  test("Excalidraw 0.18.1 fixtures pass and come out canonical", () => {
    const files = readdirSync(fixturesDir).filter((name) => name.endsWith(".excalidraw"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const result = validateScene(fixture(name));
      if (!result.ok) throw new Error(`${name}: ${result.code} ${result.message}`);
      expect(result.scene.source).toBe("nook");
      // Canonical: validating the canonical output gives the same bytes again.
      const again = validateScene(JSON.parse(canonicalSceneJson(result.scene)));
      expect(again.ok && canonicalSceneJson(again.scene)).toBe(canonicalSceneJson(result.scene));
    }
  });

  test("the same input always hashes the same, whatever its key order", () => {
    const a = validateScene(scene([rect({ id: "same" })]));
    const shuffled = Object.fromEntries(Object.entries(rect({ id: "same" })).reverse());
    const b = validateScene(scene([shuffled]));
    const hash = (value: typeof a) => value.ok ? createHash("sha256").update(canonicalSceneJson(value.scene)).digest("hex") : "";
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe("");
  });

  test("deleted elements are stripped and appState keeps only the allowlist", () => {
    const result = validateScene(scene([rect({ id: "kept" }), rect({ id: "gone", isDeleted: true })], {
      appState: { viewBackgroundColor: "#fff", gridSize: 20, gridStep: 5, gridModeEnabled: true, scrollX: 5, zoom: { value: 2 }, collaborators: [], theme: "dark" }
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.elements.map((item) => item.id)).toEqual(["kept"]);
    expect(result.scene.appState).toEqual({ viewBackgroundColor: "#fff", gridSize: 20, gridStep: 5, gridModeEnabled: true });
    expect(result.stats.elementCount).toBe(1);
  });

  test("element count: the limit passes, one more is TOO_MANY_ELEMENTS (deleted ones do not count)", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, type: "rectangle", x: 0, y: 0, width: 1, height: 1 }));
    expect(code(scene(many(WHITEBOARD_MAX_ELEMENTS)))).toBe("OK");
    expect(code(scene(many(WHITEBOARD_MAX_ELEMENTS + 1)))).toBe("TOO_MANY_ELEMENTS");
    expect(code(scene([...many(WHITEBOARD_MAX_ELEMENTS), { ...many(1)[0], id: "deleted", isDeleted: true }]))).toBe("OK");
  });

  test("points per element and per scene", () => {
    const line = (id: string, count: number) => ({ id, type: "freedraw", x: 0, y: 0, width: 1, height: 1, points: Array.from({ length: count }, (_, index) => [index, index]), pressures: [] });
    expect(code(scene([line("a", WHITEBOARD_MAX_POINTS_PER_ELEMENT)]))).toBe("OK");
    expect(code(scene([line("a", WHITEBOARD_MAX_POINTS_PER_ELEMENT + 1)]))).toBe("TOO_MANY_POINTS");
    const full = Array.from({ length: WHITEBOARD_MAX_POINTS / WHITEBOARD_MAX_POINTS_PER_ELEMENT }, (_, index) => line(`f${index}`, WHITEBOARD_MAX_POINTS_PER_ELEMENT));
    expect(code(scene(full))).toBe("OK");
    expect(code(scene([...full, line("extra", 1)]))).toBe("TOO_MANY_POINTS");
    expect(code(scene([{ ...line("bad", 1), points: [[1, 2, 3]] }]))).toBe("INVALID_SCENE");
  });

  test("text: the limit passes, more is refused, controls are stripped", () => {
    const text = (value: string) => ({ ...rect({ id: "t" }), type: "text", text: value, originalText: value, fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 });
    expect(code(scene([text("x".repeat(WHITEBOARD_MAX_TEXT_CHARS))]))).toBe("OK");
    expect(code(scene([text("x".repeat(WHITEBOARD_MAX_TEXT_CHARS + 1))]))).toBe("INVALID_SCENE");
    const result = validateScene(scene([text("a\u0000b\u0007c\nd\te")]));
    expect(result.ok && result.scene.elements[0]!.text).toBe("abc\nd\te");
    // 1 MiB of text per scene.
    const chunk = "y".repeat(WHITEBOARD_MAX_TEXT_CHARS);
    const texts = Array.from({ length: 27 }, (_, index) => ({ ...text(chunk), id: `t${index}`, originalText: chunk }));
    expect(code(scene(texts))).toBe("INVALID_SCENE");
  });

  test("numbers: finite and within ±1e7 for geometry; counters may be large integers", () => {
    expect(code(scene([rect({ x: 1e7 })]))).toBe("OK");
    expect(code(scene([rect({ x: 1e7 + 1 })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ width: Number.NaN })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ updated: 1_759_100_000_000, seed: 2_147_483_000 })]))).toBe("OK");
  });

  test("ids, group ids, colours", () => {
    expect(code(scene([rect({ id: "bad id" })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ id: "x".repeat(65) })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ groupIds: Array.from({ length: 32 }, (_, index) => `g${index}`) })]))).toBe("OK");
    expect(code(scene([rect({ groupIds: Array.from({ length: 33 }, (_, index) => `g${index}`) })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ strokeColor: "red" })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ backgroundColor: "url(javascript:alert(1))" })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ id: "dup" }), rect({ id: "dup" })]))).toBe("INVALID_SCENE");
  });

  test("element types: embeddable, iframe, magicframe, and unknown types are UNSUPPORTED_ELEMENT", () => {
    for (const type of ["embeddable", "iframe", "magicframe", "selection", "script"]) expect(code(scene([rect({ type })]))).toBe("UNSUPPORTED_ELEMENT");
    for (const type of ["rectangle", "diamond", "ellipse", "frame"]) expect(code(scene([rect({ type })]))).toBe("OK");
  });

  test("links: https, http, mailto, and Nook paths only", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    for (const link of ["https://example.test/a?b=c", "http://example.test", "mailto:someone@example.test", `/notes/${uuid}`, `/whiteboards/${uuid}`, `/tasks/${uuid}/card/${uuid}`, `/collections/${uuid}/row/${uuid}`]) {
      expect({ link, allowed: isAllowedLink(link) }).toEqual({ link, allowed: true });
      expect(code(scene([rect({ link })]))).toBe("OK");
    }
    for (const link of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox", "//evil.example.test", "/notes/not-a-uuid", "/api/files/x", "file:///etc/passwd", `https://example.test/${"a".repeat(2048)}`]) {
      expect({ link, allowed: isAllowedLink(link) }).toEqual({ link, allowed: false });
      expect(code(scene([rect({ link })]))).toBe("INVALID_LINK");
    }
    expect(code(scene([rect({ link: "" })]))).toBe("OK");
  });

  test("Wave 24 turns images on (D198); { images: false } still refuses them as IMAGES_NOT_SUPPORTED", () => {
    const fileId = "f".repeat(40);
    const image = { ...rect({ id: "img" }), type: "image", fileId, status: "pending", scale: [1, 1], crop: null };
    const nook = { [fileId]: { id: fileId, mimeType: "image/png", nookDocumentId: "123e4567-e89b-42d3-a456-426614174000" } };
    expect(WHITEBOARD_IMAGES_ENABLED).toBe(true);
    expect(code(scene([image], { files: nook }))).toBe("OK");
    const off = (input: unknown) => { const result = validateScene(input, { images: false }); return result.ok ? "OK" : result.code; };
    expect(off(scene([image], { files: nook }))).toBe("IMAGES_NOT_SUPPORTED");
    expect(off(scene([], { files: nook }))).toBe("IMAGES_NOT_SUPPORTED");
    expect(off(scene([rect()], { files: {} }))).toBe("OK");
  });

  test("only files a live image uses are kept; a duplicate can leave out images by document (T165)", () => {
    const a = "a".repeat(20), b = "b".repeat(20), c = "c".repeat(20);
    const doc = (n: number) => `123e4567-e89b-42d3-a456-42661417400${n}`;
    const files = Object.fromEntries([[a, 1], [b, 2], [c, 3]].map(([id, n]) => [id, { id, mimeType: "image/png", nookDocumentId: doc(n as number) }]));
    const image = (id: string, fileId: string, extra: Record<string, unknown> = {}) => ({ ...rect({ id }), type: "image", fileId, ...extra });
    const result = validateScene(scene([image("i1", a), image("i2", b, { isDeleted: true }), rect({ id: "r1" })], { files }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.scene.files)).toEqual([a]);
    expect([...sceneImageDocumentIds(result.scene)]).toEqual([doc(1)]);
    const both = validateScene(scene([image("i1", a), image("i3", c), rect({ id: "r2" })], { files }));
    if (!both.ok) throw new Error("expected ok");
    const without = sceneWithoutImages(both.scene, new Set([doc(3)]));
    expect(without.elements.map((item) => item.id)).toEqual(["i1", "r2"]);
    expect(Object.keys(without.files)).toEqual([a]);
    expect(sceneWithoutImages(both.scene, new Set())).toBe(both.scene);
  });

  test("with images on (Wave 24): dataURL is refused; images must refer to a listed Nook file", () => {
    const fileId = "f".repeat(40);
    const image = { ...rect({ id: "img" }), type: "image", fileId, status: "pending", scale: [1, 1], crop: null };
    const nook = { [fileId]: { id: fileId, mimeType: "image/png", nookDocumentId: "123e4567-e89b-42d3-a456-426614174000" } };
    const on = (input: unknown) => { const result = validateScene(input, { images: true }); return result.ok ? "OK" : result.code; };
    const ok = validateScene(scene([image], { files: nook }), { images: true });
    expect(ok.ok && ok.scene.elements[0]!.status).toBe("saved");
    expect(on(scene([image], { files: { [fileId]: { ...nook[fileId], dataURL: "data:image/png;base64,AAAA" } } }))).toBe("DATA_URL_NOT_ALLOWED");
    expect(on(scene([image], { files: {} }))).toBe("INVALID_SCENE");
    expect(on(scene([], { files: { [fileId]: { ...nook[fileId], mimeType: "image/svg+xml" } } }))).toBe("INVALID_SCENE");
  });

  test("__proto__, constructor, and prototype keys never change the canonical output (review L9)", () => {
    const plain = '{"type":"excalidraw","elements":[{"id":"p1","type":"rectangle","x":1,"y":2,"width":3,"height":4,"roundness":{"type":3}}],"appState":{},"files":{}}';
    const polluted = '{"files":{},"__proto__":{"polluted":true},"appState":{"__proto__":{"x":1}},"elements":[{"height":4,"__proto__":[1,2],"width":3,"constructor":"x","y":2,"x":1,"type":"rectangle","id":"p1","prototype":7,"roundness":{"__proto__":{"a":1},"type":3}}],"type":"excalidraw"}';
    const a = validateScene(JSON.parse(plain));
    const b = validateScene(JSON.parse(polluted));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const hash = (value: typeof a & { ok: true }) => createHash("sha256").update(canonicalSceneJson(value.scene)).digest("hex");
    expect(hash(b)).toBe(hash(a));
    expect(canonicalSceneJson(b.scene)).not.toContain("proto");
    expect(canonicalSceneJson(b.scene)).not.toContain("constructor");
    expect(Object.getPrototypeOf(b.scene.elements[0])).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("unknown element keys: primitives and short number arrays only, at most 48 keys", () => {
    expect(code(scene([rect({ futureFlag: true, futureName: "x", futureList: [1, 2, 3] })]))).toBe("OK");
    expect(code(scene([rect({ futureObject: { a: 1 } })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ futureString: "x".repeat(257) })]))).toBe("INVALID_SCENE");
    expect(code(scene([rect({ futureList: Array.from({ length: 65 }, () => 1) })]))).toBe("INVALID_SCENE");
    const wide = rect(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index])));
    expect(code(scene([wide]))).toBe("INVALID_SCENE");
  });

  test("customData: small primitive objects are kept, anything else is dropped", () => {
    const kept = validateScene(scene([rect({ id: "a", customData: { tag: "x", n: 1 } })]));
    expect(kept.ok && kept.scene.elements[0]!.customData).toEqual({ tag: "x", n: 1 });
    const dropped = validateScene(scene([rect({ id: "b", customData: { nested: { a: 1 } } })]));
    expect(dropped.ok && "customData" in dropped.scene.elements[0]!).toBe(false);
  });

  test("depth: 8 levels pass, 9 are refused", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 9; level += 1) deep = [deep];
    expect(jsonDepth(deep)).toBe(9);
    // scene(1) > elements(2) > element(3) > fixedSegments(4) > segment(5) > start(6): within 8.
    const arrow = { ...rect({ id: "arr" }), type: "arrow", points: [[0, 0], [10, 10]], fixedSegments: [{ start: [0, 0], end: [1, 1], index: 1 }], startBinding: { elementId: "x1", focus: 0, gap: 1 }, endBinding: null, elbowed: true };
    expect(code(scene([arrow]))).toBe("OK");
    expect(code(scene([rect({ futureList: [1] })], { extra: deep }))).toBe("INVALID_SCENE");
  });

  test("not an Excalidraw scene", () => {
    expect(code(null)).toBe("INVALID_SCENE");
    expect(code({ type: "canvas", elements: [] })).toBe("INVALID_SCENE");
    expect(code({ type: "excalidraw" })).toBe("INVALID_SCENE");
    expect(code(emptyScene())).toBe("OK");
  });

  test("texts: wrapped text in full, with its container and frame", () => {
    const result = validateScene(scene([
      { ...rect({ id: "frame1" }), type: "frame", name: "Kitchen" },
      rect({ id: "box", frameId: "frame1" }),
      { ...rect({ id: "label", frameId: "frame1" }), type: "text", text: "Island\nsink", originalText: "Island sink", containerId: "box" },
      { ...rect({ id: "blank" }), type: "text", text: "  ", originalText: "  " }
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sceneTexts(result.scene)).toEqual({ texts: [{ elementId: "label", text: "Island sink", containerId: "box", frame: "Kitchen" }], frameNames: ["Kitchen"] });
  });

  test("names carry the .excalidraw suffix; the UI hides it", () => {
    expect(whiteboardFileName("Plan")).toBe("Plan.excalidraw");
    expect(whiteboardFileName("Plan.excalidraw")).toBe("Plan.excalidraw");
    expect(whiteboardDisplayName("Plan.excalidraw")).toBe("Plan");
    expect(whiteboardDisplayName(".excalidraw")).toBe(".excalidraw");
  });
});
