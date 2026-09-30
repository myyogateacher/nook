import { ELEMENT_TYPES, isAllowedLink, validateScene, type CanonicalScene, type SceneFile, type SceneResult } from "../../shared/whiteboardScene";

/**
 * Pure helpers between Excalidraw and Nook's history (whiteboard plan D202) and save pipeline.
 * No Excalidraw import, so this stays out of the lazy chunk's critical path and is unit tested.
 */

/** The parts of Excalidraw's appState that are layers Back must close first (D202, the D18 pattern). */
export type ExcalidrawLayers = {
  openDialog?: unknown;
  openMenu?: unknown;
  openPopup?: unknown;
  openSidebar?: unknown;
  contextMenu?: unknown;
};

export function excalidrawLayerOpen(appState: ExcalidrawLayers | null | undefined) {
  if (!appState) return false;
  return Boolean(appState.openDialog || appState.openMenu || appState.openPopup || appState.openSidebar || appState.contextMenu);
}

/**
 * Excalidraw's overlays as they appear in the DOM: the main and shape menus, its dialogs (help,
 * text to diagram, clear canvas), the context menu, the sidebar, and popovers (colour pickers).
 * Not every one keeps its open state in appState, so the canvas watches the DOM.
 */
export const EXCALIDRAW_LAYER_SELECTOR = ".dropdown-menu, .Modal, .context-menu, .sidebar, .popover, [data-radix-popper-content-wrapper]";

/**
 * The Excalidraw layer on screen, or null (QA E2): one inside the stage (menus, the context menu,
 * the sidebar), or one of its portals on <body> (dialogs in `.excalidraw-modal-container`, colour
 * pickers and other popovers). Only a rendered one counts, so a closed or hidden layer never holds
 * a Back entry.
 */
export function openExcalidrawLayer(stage: ParentNode | null, doc: Pick<Document, "querySelectorAll">): Element | null {
  const candidates = [
    ...(stage ? Array.from(stage.querySelectorAll(EXCALIDRAW_LAYER_SELECTOR)) : []),
    ...Array.from(doc.querySelectorAll(".excalidraw-modal-container .Modal, body > .excalidraw [data-radix-popper-content-wrapper], body > [data-radix-popper-content-wrapper]"))
  ];
  for (const element of candidates) {
    const rendered = typeof (element as HTMLElement).getClientRects !== "function" || (element as HTMLElement).getClientRects().length > 0;
    if (rendered) return element;
  }
  return null;
}

const shapes = (count: number) => `${count} ${count === 1 ? "shape" : "shapes"}`;

/** QA E6: the restore dialog's wording, neutral whichever version has more on it. */
export function restoreMessage(previous: { createdAt: string; elementCount: number } | null, currentCount: number, formatTime: (value: string) => string) {
  if (!previous) return `The current version has ${shapes(currentCount)}. You can switch back the same way.`;
  return `Switch to the version from ${formatTime(previous.createdAt)}, which has ${shapes(previous.elementCount)}; the current one has ${shapes(currentCount)}. You can switch back the same way.`;
}

/** The one message for every picture the board cannot keep as a Nook file (a Mermaid diagram drawn as an image, a picture pasted from outside Nook; QA Q5). */
export const IMAGES_REFUSED_MESSAGE = "Pictures on a whiteboard come from your files: use Insert image, or drop or paste a picture file.";

/** The appState patch that closes every Excalidraw layer, applied with updateScene. */
export const closedExcalidrawLayers = () => ({ openDialog: null, openMenu: null, openPopup: null, openSidebar: null, contextMenu: null });

type LooseElement = { type?: unknown; isDeleted?: unknown } & Record<string, unknown>;

/** The board's image references (D198): Excalidraw file id → the Nook document it shows. */
export type ImageRefs = ReadonlyMap<string, SceneFile>;
const noRefs: ImageRefs = new Map();

/** A Nook document id, which is also the file id a Nook image gets on the canvas. */
export const isDocumentId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** An element the board keeps: a supported type, and for an image, one whose file is a known Nook reference (deleted ones are harmless). */
export const isKeptElement = (element: LooseElement, refs: ImageRefs = noRefs) =>
  element.isDeleted === true || ((ELEMENT_TYPES as readonly string[]).includes(String(element.type)) && (element.type !== "image" || (typeof element.fileId === "string" && refs.has(element.fileId))));

/** Whether a set of elements holds anything the board cannot keep (an unreferenced image, an embed, or an AI frame). */
export const hasUnsupportedElements = (elements: readonly LooseElement[], refs: ImageRefs = noRefs) => !elements.every((element) => isKeptElement(element, refs));

/**
 * D199: the link a shape keeps. A full URL of this instance becomes its in-app path, a bare
 * `www.` host gets https, and anything the allowlist refuses becomes null (dropped before a save,
 * so one bad link never makes the whole board unsavable).
 */
export function keptLink(link: unknown, origin: string): string | null {
  if (typeof link !== "string" || !link.trim()) return null;
  let value = link.trim();
  if (value.startsWith(`${origin}/`)) value = value.slice(origin.length);
  else if (/^www\.[^\s/]+\.[^\s]+$/i.test(value)) value = `https://${value}`;
  return isAllowedLink(value) ? value : null;
}

/**
 * The scene a save sends: live elements of the supported types, and images only when their file is
 * a Nook reference the board knows (an image still uploading, or one pasted from outside Nook, is
 * never saved: T164). Links outside the D199 allowlist are dropped from the saved copy.
 */
export function sceneForSave(elements: readonly LooseElement[], appState: Record<string, unknown>, refs: ImageRefs = noRefs, origin = ""): SceneResult {
  const kept = elements.filter((element) => element.isDeleted !== true && isKeptElement(element, refs));
  const files: Record<string, SceneFile> = {};
  for (const element of kept) if (element.type === "image" && typeof element.fileId === "string") files[element.fileId] = refs.get(element.fileId)!;
  return validateScene({
    type: "excalidraw",
    version: 2,
    source: "nook",
    elements: kept.map((element) => element.link === undefined || element.link === null ? { ...element } : { ...element, link: keptLink(element.link, origin) }),
    appState: { viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.gridSize, gridStep: appState.gridStep, gridModeEnabled: appState.gridModeEnabled },
    files
  });
}

/** Elements whose link the save drops (to tell the person once). */
export const refusedLinks = (elements: readonly LooseElement[], origin: string) =>
  elements.filter((element) => element.isDeleted !== true && typeof element.link === "string" && element.link.trim() !== "" && keptLink(element.link, origin) === null).length;

/** A cheap change key for onChange: element versions plus the kept appState keys. */
export function changeKey(elements: readonly LooseElement[], appState: Record<string, unknown>) {
  let sum = 0;
  for (const element of elements) sum += (typeof element.version === "number" ? element.version : 0) * 31 + (element.isDeleted === true ? 7 : 1);
  return `${elements.length}:${sum}:${String(appState.viewBackgroundColor)}:${String(appState.gridSize)}:${String(appState.gridModeEnabled)}`;
}

/** Scenes from the server are validated again before Excalidraw sees them (T160). */
export function sceneForLoad(scene: unknown): CanonicalScene | null {
  const result = validateScene(scene);
  return result.ok ? result.scene : null;
}

/** D199: where a link on a shape goes. Nook paths route in the app; web and mail links open in a new tab. */
export function linkTarget(link: string): { kind: "app"; path: string } | { kind: "external"; url: string } | null {
  const trimmed = link.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return { kind: "app", path: trimmed };
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") return { kind: "external", url: url.href };
  } catch {
    return null;
  }
  return null;
}
