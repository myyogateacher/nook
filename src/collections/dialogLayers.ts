import { useEffect, useRef } from "react";
import { readHistoryDepth } from "../appShellNavigation";
import { dialogPopDirection, registerHistoryDialogGuard, undoDialogPop, useDialogSentinel } from "../historyDialogs";

/**
 * D69 for Collections: dialogs, sheets, and pickers push no history entry. Collections nests them
 * (a picker inside the row panel, the option editor inside the field editor), so every open piece
 * joins a stack and CollectionsApp registers one guard (on historyDialogs.ts's guard stack) that
 * closes the top-most layer. Back with a picker open over the row panel closes the picker; the
 * next Back leaves the row.
 */
type Layer = { close: () => void; depth: number };
const layers: Layer[] = [];

/** Pushes a layer opened on the entry at `depth`; returns its removal. */
export function openLayer(close: () => void, depth: number) {
  const layer: Layer = { close, depth };
  layers.push(layer);
  return () => {
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
  };
}

/** Joins the stack while `open` is true. The history depth is captured when the layer opens. */
export function useDialogLayer(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    return openLayer(() => closeRef.current(), readHistoryDepth(window.history.state));
  }, [open]);
  useDialogSentinel(open);
}

/** Closes the top-most layer for a popstate; true when the browser's move was undone. */
export function closeTopLayer(poppedState: unknown, undo: typeof undoDialogPop = undoDialogPop) {
  const layer = layers.pop();
  if (!layer) return false;
  layer.close();
  const direction = dialogPopDirection(layer.depth, readHistoryDepth(poppedState));
  // Direction unknown: let the route handlers follow the browser instead of leaving a stale URL.
  if (!direction) return false;
  undo(direction);
  return true;
}

/**
 * Sheets from the shared kits (the attach sheet and preview, src/ui/attachments) guard Back themselves
 * (useHistoryDialogGuard), so they are not layers here; they only hold Escape away from the row panel
 * while open, which counts them in openLayerCount.
 */
let held = 0;
export function useEscapeHold(open: boolean) {
  useEffect(() => {
    if (!open) return;
    held += 1;
    return () => { held -= 1; };
  }, [open]);
}

export const openLayerCount = () => layers.length + held;

/** Registered once by CollectionsApp. */
export function useCollectionsDialogGuard() {
  useEffect(() => registerHistoryDialogGuard((poppedState) => closeTopLayer(poppedState)), []);
}
