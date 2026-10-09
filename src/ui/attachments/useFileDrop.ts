import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from "react";

/** Whether a drag carries files from the system (not text, links, or an in-app row). */
export const dragHasFiles = (event: { dataTransfer: Pick<DataTransfer, "types"> | null }) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

/**
 * Drag-and-drop of system files onto a host (a card dialog, an event sheet), D398. Desktop only in
 * practice (phones have no file drag). Spread `bind` on the drop zone and show an overlay while
 * `dragging`. Nested children firing enter/leave are counted, so the overlay never flickers.
 */
export function useFileDrop(onFiles: (files: File[]) => void, options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!enabled || !dragHasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, [enabled]);
  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!enabled || !dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [enabled]);
  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!enabled || !dragHasFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, [enabled]);
  const onDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!enabled || !dragHasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) handler.current(files);
  }, [enabled]);

  return { dragging, bind: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
