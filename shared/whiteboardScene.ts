/**
 * Bounded whiteboard scene validation (docs/plan/research/2026-09-28-whiteboard-module.md §7, D197,
 * T160, T161, T164). Pure and dependency-free, so the server validates every write with it and the
 * client runs the same checks before a save and on load (a scene that somehow bypassed the server
 * never reaches Excalidraw unbounded).
 *
 * The result is canonical: deleted elements stripped, unknown `appState` keys dropped, keys sorted,
 * so the same scene always serializes to the same bytes (and the same sha256).
 */

export const WHITEBOARD_MIME = "application/vnd.excalidraw+json";
export const WHITEBOARD_SUFFIX = ".excalidraw";
export const WHITEBOARD_MAX_SCENE_BYTES = 4 * 1024 * 1024;
export const WHITEBOARD_MAX_DEPTH = 8;
export const WHITEBOARD_MAX_ELEMENTS = 5000;
export const WHITEBOARD_MAX_POINTS_PER_ELEMENT = 10_000;
export const WHITEBOARD_MAX_POINTS = 200_000;
export const WHITEBOARD_MAX_TEXT_CHARS = 20_000;
export const WHITEBOARD_MAX_SCENE_TEXT_BYTES = 1024 * 1024;
export const WHITEBOARD_MAX_LINK = 2048;
export const WHITEBOARD_MAX_FILES = 100;
export const WHITEBOARD_MAX_COORD = 1e7;
const MAX_ELEMENT_KEYS = 48;
const MAX_UNKNOWN_STRING = 256;
const MAX_UNKNOWN_ARRAY = 64;
const MAX_GROUPS = 32;
const MAX_BOUND_ELEMENTS = 1000;
const MAX_CUSTOM_DATA_BYTES = 1024;
/** Counters and timestamps Excalidraw stores as large integers (seed, version, updated). */
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

export const ELEMENT_TYPES = ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame"] as const;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type SceneErrorCode = "INVALID_SCENE" | "TOO_MANY_ELEMENTS" | "UNSUPPORTED_ELEMENT" | "TOO_MANY_POINTS" | "INVALID_LINK" | "DATA_URL_NOT_ALLOWED" | "IMAGES_NOT_SUPPORTED";

/**
 * Images (Wave 24, D198): an image element refers to a `files` entry that is only a reference to a
 * Nook document (`{ id, mimeType, nookDocumentId }`, never a dataURL). Callers may still pass
 * `{ images: false }` to refuse them (IMAGES_NOT_SUPPORTED).
 */
export const WHITEBOARD_IMAGES_ENABLED = true;
export type SceneOptions = { images?: boolean };

/**
 * Keys that must never become own properties of validated objects (review L9): assigning
 * `__proto__` changes an object's prototype and drops the key from JSON, so canonical output
 * would depend on it. They are skipped wherever user keys are copied.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const safeEntries = (value: Record<string, unknown>) => Object.entries(value).filter(([key]) => !FORBIDDEN_KEYS.has(key));
export type SceneElement = Record<string, unknown> & { id: string; type: (typeof ELEMENT_TYPES)[number] };
export type SceneFile = { id: string; mimeType: string; nookDocumentId: string };
export type CanonicalScene = {
  type: "excalidraw";
  version: 2;
  source: "nook";
  elements: SceneElement[];
  appState: { viewBackgroundColor?: string; gridSize?: number | null; gridStep?: number; gridModeEnabled?: boolean };
  files: Record<string, SceneFile>;
};
export type SceneStats = { elementCount: number; textBytes: number; pointCount: number };
export type SceneResult = { ok: true; scene: CanonicalScene; stats: SceneStats } | { ok: false; code: SceneErrorCode; message: string };

class SceneError extends Error {
  constructor(readonly code: SceneErrorCode, message: string) {
    super(message);
  }
}

const invalid = (message: string) => new SceneError("INVALID_SCENE", message);
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const colorPattern = /^(#[0-9a-fA-F]{3,8}|transparent)$/;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** D199: in-app paths a shape may link to. Nothing is ever fetched or unfurled. */
const nookPathPattern = new RegExp(`^/(notes/${uuidPattern}|files/${uuidPattern}|whiteboards/${uuidPattern}|tasks/${uuidPattern}(/card/${uuidPattern})?|collections/${uuidPattern}(/row/${uuidPattern})?|calendar/event/${uuidPattern})$`);
// C0 controls other than \t and \n (and DEL) are stripped from text.
const controlCharacters = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const GEOMETRY_KEYS = new Set(["x", "y", "width", "height", "angle", "fontSize", "strokeWidth", "lineHeight", "baseline"]);
const COLOR_KEYS = new Set(["strokeColor", "backgroundColor"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Depth of nested arrays and objects (the scene object is depth 1). Iterative, so hostile nesting cannot blow the stack. */
export function jsonDepth(value: unknown, limit = WHITEBOARD_MAX_DEPTH): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [current, depth] = stack.pop()!;
    if (typeof current !== "object" || current === null) continue;
    if (depth > max) max = depth;
    if (max > limit) return max;
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return max;
}

function number(value: unknown, key: string, bound = WHITEBOARD_MAX_COORD) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > bound) throw invalid(`${key} must be a finite number within ±${bound}`);
  return value;
}

function id(value: unknown, key: string) {
  if (typeof value !== "string" || !idPattern.test(value)) throw invalid(`${key} must be an id of 1 to 64 letters, digits, - or _`);
  return value;
}

function cleanText(value: unknown, key: string) {
  if (typeof value !== "string") throw invalid(`${key} must be text`);
  if (value.length > WHITEBOARD_MAX_TEXT_CHARS) throw invalid(`${key} must be at most ${WHITEBOARD_MAX_TEXT_CHARS} characters`);
  return value.replace(controlCharacters, "");
}

/** D199: https, http, mailto, or a Nook path; at most 2,048 characters. */
export function isAllowedLink(value: string) {
  if (value.length === 0 || value.length > WHITEBOARD_MAX_LINK) return false;
  if (value.startsWith("/")) return nookPathPattern.test(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "mailto:") return true;
  return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0 && !/[\s<>"]/.test(value);
}

/** A primitive (strings ≤ 256) or an array of ≤ 64 numbers: the only shape unknown keys may take. */
function unknownValue(value: unknown, key: string) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return number(value, key, MAX_INTEGER);
  if (typeof value === "string") {
    if (value.length > MAX_UNKNOWN_STRING) throw invalid(`${key} is too long`);
    return value.replace(controlCharacters, "");
  }
  if (Array.isArray(value) && value.length <= MAX_UNKNOWN_ARRAY && value.every((item) => typeof item === "number")) {
    return value.map((item) => number(item, key, MAX_INTEGER));
  }
  throw invalid(`${key} has an unsupported value`);
}

/** A small nested object (roundness, bindings, crop): ≤ 16 keys of the unknown-value shape, ids checked. */
function smallObject(value: unknown, key: string, idKeys: readonly string[] = []) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw invalid(`${key} must be an object or null`);
  const entries = safeEntries(value);
  if (entries.length > 16) throw invalid(`${key} has too many keys`);
  const out: Record<string, unknown> = {};
  for (const [name, item] of entries) {
    if (item === undefined) continue;
    out[name] = idKeys.includes(name) ? id(item, `${key}.${name}`) : unknownValue(item, `${key}.${name}`);
  }
  return out;
}

function points(value: unknown, key: string) {
  if (!Array.isArray(value)) throw invalid(`${key} must be a list of points`);
  if (value.length > WHITEBOARD_MAX_POINTS_PER_ELEMENT) throw new SceneError("TOO_MANY_POINTS", `An element has more than ${WHITEBOARD_MAX_POINTS_PER_ELEMENT} points`);
  return value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) throw invalid(`${key} must hold [x, y] pairs`);
    return [number(point[0], key), number(point[1], key)];
  });
}

function customData(value: unknown) {
  if (!isPlainObject(value)) return undefined;
  const entries = safeEntries(value);
  if (!entries.every(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item) && (typeof item !== "number" || Number.isFinite(item)))) return undefined;
  const serialized = JSON.stringify(Object.fromEntries(entries));
  return serialized.length <= MAX_CUSTOM_DATA_BYTES ? Object.fromEntries(entries) : undefined;
}

const utf8Bytes = (value: string) => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
};

type Tally = { points: number; textBytes: number };

function element(raw: unknown, files: Record<string, SceneFile>, tally: Tally, options: SceneOptions): SceneElement {
  if (!isPlainObject(raw)) throw invalid("Each element must be an object");
  const type = raw.type;
  if (typeof type !== "string" || !(ELEMENT_TYPES as readonly string[]).includes(type)) {
    throw new SceneError("UNSUPPORTED_ELEMENT", `Element type ${typeof type === "string" ? type.slice(0, 32) : "unknown"} is not supported`);
  }
  if (type === "image" && !(options.images ?? WHITEBOARD_IMAGES_ENABLED)) throw new SceneError("IMAGES_NOT_SUPPORTED", "Images are not supported on whiteboards yet");
  const entries = safeEntries(raw).filter(([, value]) => value !== undefined);
  if (entries.length > MAX_ELEMENT_KEYS) throw invalid(`An element has more than ${MAX_ELEMENT_KEYS} keys`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    switch (key) {
      case "id": out.id = id(value, "id"); break;
      case "type": out.type = type; break;
      case "frameId": case "containerId": out[key] = value === null ? null : id(value, key); break;
      case "groupIds":
        if (!Array.isArray(value) || value.length > MAX_GROUPS) throw invalid(`groupIds must be a list of at most ${MAX_GROUPS} ids`);
        out.groupIds = value.map((item) => id(item, "groupIds"));
        break;
      case "boundElements":
        if (value === null) { out.boundElements = null; break; }
        if (!Array.isArray(value) || value.length > MAX_BOUND_ELEMENTS) throw invalid("boundElements must be a list");
        out.boundElements = value.map((item) => smallObject(item, "boundElements", ["id"]));
        break;
      case "startBinding": case "endBinding": out[key] = smallObject(value, key, ["elementId"]); break;
      case "roundness": case "crop": out[key] = smallObject(value, key); break;
      case "fixedSegments":
        if (value === null) { out.fixedSegments = null; break; }
        if (!Array.isArray(value) || value.length > MAX_UNKNOWN_ARRAY) throw invalid("fixedSegments must be a short list");
        out.fixedSegments = value.map((segment) => {
          if (!isPlainObject(segment)) throw invalid("fixedSegments must hold objects");
          return Object.fromEntries(safeEntries(segment).map(([name, item]) => [name, name === "start" || name === "end" ? points([item], "fixedSegments")[0] : unknownValue(item, `fixedSegments.${name}`)]));
        });
        break;
      case "points": {
        const list = points(value, "points");
        tally.points += list.length;
        if (tally.points > WHITEBOARD_MAX_POINTS) throw new SceneError("TOO_MANY_POINTS", `A scene may hold at most ${WHITEBOARD_MAX_POINTS} points`);
        out.points = list;
        break;
      }
      case "pressures":
        if (!Array.isArray(value) || value.length > WHITEBOARD_MAX_POINTS_PER_ELEMENT) throw new SceneError("TOO_MANY_POINTS", "pressures has too many values");
        out.pressures = value.map((item) => number(item, "pressures", 1e3));
        break;
      case "lastCommittedPoint": case "scale":
        out[key] = value === null ? null : points([value], key)[0];
        break;
      case "text": case "originalText": {
        const text = cleanText(value, key);
        tally.textBytes += utf8Bytes(text);
        if (tally.textBytes > WHITEBOARD_MAX_SCENE_TEXT_BYTES) throw invalid("A scene may hold at most 1 MiB of text");
        out[key] = text;
        break;
      }
      case "name":
        out.name = value === null ? null : cleanText(value, "name").slice(0, MAX_UNKNOWN_STRING);
        break;
      case "link":
        if (value === null || value === "") { out.link = null; break; }
        if (typeof value !== "string" || !isAllowedLink(value)) throw new SceneError("INVALID_LINK", "Links must be https, http, mailto, or a Nook path");
        out.link = value;
        break;
      case "customData": {
        const data = customData(value);
        if (data) out.customData = data;
        break;
      }
      case "fileId": out.fileId = value === null ? null : id(value, "fileId"); break;
      case "status": out.status = "saved"; break;
      default:
        if (COLOR_KEYS.has(key)) {
          if (typeof value !== "string" || !colorPattern.test(value)) throw invalid(`${key} must be a colour`);
          out[key] = value;
        } else if (GEOMETRY_KEYS.has(key)) {
          out[key] = number(value, key);
        } else {
          out[key] = unknownValue(value, key);
        }
    }
  }
  if (typeof out.id !== "string") throw invalid("Each element needs an id");
  if (type === "image") {
    if (typeof out.fileId !== "string" || !Object.hasOwn(files, out.fileId)) throw invalid("An image must refer to one of the scene's files");
    out.status = "saved";
  }
  return out as SceneElement;
}

function sceneFiles(value: unknown): Record<string, SceneFile> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw invalid("files must be an object");
  const entries = safeEntries(value);
  if (entries.length > WHITEBOARD_MAX_FILES) throw invalid(`A scene may refer to at most ${WHITEBOARD_MAX_FILES} files`);
  const out: Record<string, SceneFile> = {};
  for (const [key, raw] of entries) {
    if (!isPlainObject(raw)) throw invalid("Each file must be an object");
    if (Object.hasOwn(raw, "dataURL")) throw new SceneError("DATA_URL_NOT_ALLOWED", "Images must be files in Nook, not embedded data");
    const fileId = id(key, "files");
    if (raw.id !== fileId) throw invalid("A file's id must match its key");
    if (typeof raw.mimeType !== "string" || !(IMAGE_MIME_TYPES as readonly string[]).includes(raw.mimeType)) throw invalid("Images must be PNG, JPEG, GIF, or WebP");
    if (typeof raw.nookDocumentId !== "string" || !new RegExp(`^${uuidPattern}$`).test(raw.nookDocumentId)) throw invalid("Images must refer to a Nook file");
    out[fileId] = { id: fileId, mimeType: raw.mimeType, nookDocumentId: raw.nookDocumentId };
  }
  return out;
}

function appState(value: unknown): CanonicalScene["appState"] {
  if (!isPlainObject(value)) return {};
  const out: CanonicalScene["appState"] = {};
  if (typeof value.viewBackgroundColor === "string" && colorPattern.test(value.viewBackgroundColor)) out.viewBackgroundColor = value.viewBackgroundColor;
  if (value.gridSize === null || (typeof value.gridSize === "number" && Number.isInteger(value.gridSize) && value.gridSize >= 1 && value.gridSize <= 1000)) out.gridSize = value.gridSize;
  if (typeof value.gridStep === "number" && Number.isInteger(value.gridStep) && value.gridStep >= 1 && value.gridStep <= 100) out.gridStep = value.gridStep;
  if (typeof value.gridModeEnabled === "boolean") out.gridModeEnabled = value.gridModeEnabled;
  return out;
}

/** Validates and canonicalizes a parsed scene (§7). Never throws. */
export function validateScene(input: unknown, options: SceneOptions = {}): SceneResult {
  try {
    if (jsonDepth(input) > WHITEBOARD_MAX_DEPTH) throw invalid(`The scene is nested more than ${WHITEBOARD_MAX_DEPTH} levels deep`);
    if (!isPlainObject(input)) throw invalid("The scene must be an object");
    if (input.type !== "excalidraw") throw invalid("The scene must be an Excalidraw scene");
    if (!Array.isArray(input.elements)) throw invalid("The scene needs a list of elements");
    const files = sceneFiles(input.files);
    if (Object.keys(files).length > 0 && !(options.images ?? WHITEBOARD_IMAGES_ENABLED)) throw new SceneError("IMAGES_NOT_SUPPORTED", "Images are not supported on whiteboards yet");
    const live = input.elements.filter((item) => !(isPlainObject(item) && item.isDeleted === true));
    if (live.length > WHITEBOARD_MAX_ELEMENTS) throw new SceneError("TOO_MANY_ELEMENTS", `A whiteboard may hold at most ${WHITEBOARD_MAX_ELEMENTS} elements`);
    const tally: Tally = { points: 0, textBytes: 0 };
    const elements = live.map((item) => element(item, files, tally, options));
    const ids = new Set<string>();
    for (const item of elements) {
      if (ids.has(item.id)) throw invalid("Element ids must be unique");
      ids.add(item.id);
    }
    // Only files a live image element uses are kept (a deleted image's entry is dropped), so the
    // stored references are exactly what the board shows (D198).
    const used = new Set(elements.flatMap((item) => item.type === "image" && typeof item.fileId === "string" ? [item.fileId] : []));
    const kept: Record<string, SceneFile> = {};
    for (const key of Object.keys(files).sort()) if (used.has(key)) kept[key] = files[key]!;
    const scene: CanonicalScene = { type: "excalidraw", version: 2, source: "nook", elements, appState: appState(input.appState), files: kept };
    return { ok: true, scene, stats: { elementCount: elements.length, textBytes: tally.textBytes, pointCount: tally.points } };
  } catch (error) {
    if (error instanceof SceneError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "INVALID_SCENE", message: "The scene is not valid" };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined && !FORBIDDEN_KEYS.has(key)) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** The stored bytes of a validated scene: sorted keys, no whitespace, UTF-8. */
export const canonicalSceneJson = (scene: CanonicalScene) => JSON.stringify(sortKeys(scene));

export const emptyScene = (): CanonicalScene => ({ type: "excalidraw", version: 2, source: "nook", elements: [], appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} });

/** The words a board is found by and MCP reads (D204): text elements (and their original text) and frame names. */
export function sceneTexts(scene: CanonicalScene) {
  const frames = new Map(scene.elements.filter((item) => item.type === "frame").map((item) => [item.id, typeof item.name === "string" ? item.name : null]));
  const texts: Array<{ elementId: string; text: string; containerId?: string; frame?: string }> = [];
  for (const item of scene.elements) {
    if (item.type === "text") {
      const text = typeof item.originalText === "string" && item.originalText ? item.originalText : typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;
      const frame = typeof item.frameId === "string" ? frames.get(item.frameId) : null;
      texts.push({ elementId: item.id, text, ...(typeof item.containerId === "string" ? { containerId: item.containerId } : {}), ...(frame ? { frame } : {}) });
    }
  }
  return { texts, frameNames: [...frames.values()].filter((name): name is string => Boolean(name)) };
}

/** The Nook documents a scene's images refer to (D198). */
export const sceneImageDocumentIds = (scene: Pick<CanonicalScene, "files">) => new Set(Object.values(scene.files).map((file) => file.nookDocumentId));

/**
 * The scene without the images that refer to `documentIds` (their elements and files entries):
 * a duplicate keeps only the images its new owner can open (whiteboard plan §8, T165).
 */
export function sceneWithoutImages(scene: CanonicalScene, documentIds: ReadonlySet<string>): CanonicalScene {
  if (documentIds.size === 0) return scene;
  const dropped = new Set(Object.values(scene.files).filter((file) => documentIds.has(file.nookDocumentId)).map((file) => file.id));
  if (dropped.size === 0) return scene;
  const elements = scene.elements.filter((item) => !(item.type === "image" && typeof item.fileId === "string" && dropped.has(item.fileId)));
  const files = Object.fromEntries(Object.entries(scene.files).filter(([key]) => !dropped.has(key)));
  return { ...scene, elements, files };
}

/** Board names are stored with the `.excalidraw` suffix (D192); the UI shows them without it. */
export const whiteboardDisplayName = (name: string) => name.toLowerCase().endsWith(WHITEBOARD_SUFFIX) && name.length > WHITEBOARD_SUFFIX.length ? name.slice(0, -WHITEBOARD_SUFFIX.length) : name;
export const whiteboardFileName = (name: string) => name.toLowerCase().endsWith(WHITEBOARD_SUFFIX) ? name : `${name}${WHITEBOARD_SUFFIX}`;
