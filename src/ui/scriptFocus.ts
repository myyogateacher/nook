// Focus a script moves (a section's heading after navigation, a list heading after a dialog): the
// heading takes focus so screen readers and the next Tab start there, but a focus ring on a heading
// nobody tabbed to reads as a stray outline. Chrome shows one whenever a script focuses an element
// before any pointer input (a deep link, a reload), so `:focus-visible` alone cannot tell.
//
// The rule (v0.31 follow-up): the ring shows when the move followed a key press (a keyboard user, who
// needs to see where focus went), and not after a pointer or touch, or before any input at all.
// styles.css hides the outline on `[data-script-focus]:focus`; the mark goes when focus moves elsewhere.

let keyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (event) => { if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboard = true; }, true);
  window.addEventListener("pointerdown", () => { keyboard = false; }, true);
}

/** Whether the last input was a key press (not a pointer or touch). False before any input. */
export const lastInputWasKeyboard = () => keyboard;

/** Focuses `element` for a script's move: its focus ring shows only when the move followed a key press. */
export function focusFromScript(element: HTMLElement | null | undefined, options: FocusOptions = {}) {
  if (!element) return;
  if (lastInputWasKeyboard()) element.removeAttribute("data-script-focus");
  else {
    element.setAttribute("data-script-focus", "");
    // The window losing focus (another app, a screenshot tool) blurs the element too, but it is still
    // the active element and is focused again on return, where Chrome's :focus-visible would then show
    // the ring: the mark stays until focus really moves elsewhere.
    const clear = () => {
      if (typeof document !== "undefined" && document.activeElement === element) return;
      element.removeAttribute("data-script-focus");
      element.removeEventListener("blur", clear);
    };
    element.addEventListener("blur", clear);
  }
  element.focus(options);
}
