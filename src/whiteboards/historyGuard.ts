import { ELEMENT_TYPES, validateScene, type CanonicalScene, type SceneResult } from "../../shared/whiteboardScene";

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

/** The appState patch that closes every Excalidraw layer, applied with updateScene. */
export const closedExcalidrawLayers = () => ({ openDialog: null, openMenu: null, openPopup: null, openSidebar: null, contextMenu: null });

type LooseElement = { type?: unknown; isDeleted?: unknown } & Record<string, unknown>;

/**
 * The scene a save sends: live elements of the supported types only. Images are left out in
 * Wave 23 (no image tool; dropped or pasted images never reach the server, T164), and so are
 * element types the validator refuses (embeddables, AI frames).
 */
export function sceneForSave(elements: readonly LooseElement[], appState: Record<string, unknown>): SceneResult {
  const kept = elements.filter((element) => element.isDeleted !== true && typeof element.type === "string"
    && (ELEMENT_TYPES as readonly string[]).includes(element.type) && element.type !== "image");
  return validateScene({
    type: "excalidraw",
    version: 2,
    source: "nook",
    elements: kept.map((element) => ({ ...element })),
    appState: { viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.gridSize, gridStep: appState.gridStep, gridModeEnabled: appState.gridModeEnabled },
    files: {}
  });
}

/** Whether a set of elements holds anything the board cannot keep (an image dropped or pasted in). */
export const hasUnsupportedElements = (elements: readonly LooseElement[]) =>
  elements.some((element) => element.isDeleted !== true && (element.type === "image" || !(ELEMENT_TYPES as readonly string[]).includes(String(element.type))));

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
