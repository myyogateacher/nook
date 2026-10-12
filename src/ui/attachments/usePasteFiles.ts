import { useEffect, useRef, type RefObject } from "react";

/**
 * Pasted files for the attach kit (D398), with the note editor's rule (src/editor/imageInsert.ts):
 * office apps and browsers put a rendered snapshot next to rich text, so a paste whose HTML has any
 * text stays a text paste; only a clipboard that holds nothing but files is taken over.
 */
export function pastedFiles(data: Pick<DataTransfer, "files" | "getData"> | null): File[] {
  const files = Array.from(data?.files ?? []);
  if (!files.length || !data) return [];
  const html = data.getData("text/html");
  if (html && htmlHasText(html)) return [];
  return files;
}

/** Whether pasted HTML carries any visible text (a bare `<img>` does not). */
export function htmlHasText(html: string) {
  if (typeof DOMParser !== "undefined") return Boolean(new DOMParser().parseFromString(html, "text/html").body.textContent?.trim());
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;
}

/**
 * Calls `onFiles` for file pastes inside `target` (a composer, a dialog), preventing the default only
 * then; text pastes go through untouched. Works on desktop and on phones that paste images into a
 * focused field (iOS).
 */
export function usePasteFiles(target: RefObject<HTMLElement | null>, onFiles: (files: File[]) => void, options: { enabled?: boolean } = {}) {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  const enabled = options.enabled ?? true;
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const files = pastedFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      handler.current(files);
    };
    element.addEventListener("paste", onPaste);
    return () => element.removeEventListener("paste", onPaste);
  }, [target, enabled]);
}
