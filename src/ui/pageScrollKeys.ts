import { useEffect, useRef } from "react";

/**
 * F6 (v0.16.0 QA): End, Home, PageDown, and PageUp scroll a page's main scroll container when focus
 * is on the page itself (nothing focused yet) or on a control outside every scroller, such as the
 * phone tab bar right after a tap. The body never scrolls (styles.css), so the browser's own handling
 * of these keys had nothing to move there. Focus inside a scroller keeps the browser's own scrolling
 * (and the Files list's Home/End selection), and text fields, the note editor while editable, menus,
 * lists, and open dialogs keep their own meaning for the keys.
 */

export const PAGE_SCROLL_KEYS = new Set(["End", "Home", "PageDown", "PageUp"]);

/** Where a page key moves a scroller: the ends, or most of one screen (as browsers page). */
export function pageKeyScrollTop(key: string, scrollTop: number, scrollHeight: number, clientHeight: number) {
  const max = Math.max(0, scrollHeight - clientHeight);
  const page = Math.max(40, Math.round(clientHeight * 0.875));
  switch (key) {
    case "End": return max;
    case "Home": return 0;
    case "PageDown": return Math.min(max, scrollTop + page);
    case "PageUp": return Math.max(0, scrollTop - page);
    default: return scrollTop;
  }
}

/** Elements whose own keyboard handling owns these keys. */
const KEEPS_KEYS = "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role=dialog], [role=listbox], [role=menu], [role=combobox], [role=grid], [role=slider], [role=tablist], [role=tree]";

const scrollable = (element: Element) => {
  const style = window.getComputedStyle(element);
  return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
};

/** Whether the browser already scrolls something for a page key pressed on `target`. */
function insideScroller(target: Element) {
  for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) if (scrollable(node)) return true;
  return false;
}

/**
 * The Notes and Files workspace's main scroller for the panel on screen: on a phone the folders, the
 * list, or the note or file preview; on a computer the open note's body in Notes and the list in Files.
 */
export function workspaceScroller(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>("main.workspace");
  if (!main) return null;
  const phone = window.matchMedia("(max-width: 760px)").matches;
  const files = main.classList.contains("files-workspace");
  const panel = phone ? main.dataset.mobilePanel : files ? "notes" : main.querySelector(".document-shell") ? "editor" : "notes";
  const candidates = panel === "folders" ? [".folder-nav"] : panel === "editor" ? [".document-shell", ".file-text-preview", ".file-preview-body"] : ["#file-list", ".note-list"];
  for (const selector of candidates) {
    const element = main.querySelector<HTMLElement>(selector);
    if (element && element.getClientRects().length && scrollable(element)) return element;
  }
  return null;
}

/** Page keys pressed with focus on the page scroll `getScroller()`'s element (see above). */
export function usePageScrollKeys(getScroller: () => HTMLElement | null) {
  const scrollerRef = useRef(getScroller);
  scrollerRef.current = getScroller;
  useEffect(() => {
    // The browser pages the scroller last clicked or tapped even when that left focus on the page;
    // that choice is the person's, so it stays the browser's.
    let pointed: Element | null = null;
    const onPointerDown = (event: PointerEvent) => { pointed = event.target instanceof Element ? event.target : null; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!PAGE_SCROLL_KEYS.has(event.key) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(KEEPS_KEYS) || document.querySelector("[aria-modal='true']")) return;
      const onPage = !target || target === document.body || target === document.documentElement;
      if (!onPage && insideScroller(target)) return;
      if (onPage && pointed?.isConnected && insideScroller(pointed)) return;
      const scroller = scrollerRef.current();
      if (!scroller) return;
      event.preventDefault();
      scroller.scrollTop = pageKeyScrollTop(event.key, scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
