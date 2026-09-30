/**
 * QA M1: Excalidraw opens a shape's link on the pointer UP. On a touch screen the browser then
 * sends a compatibility click to whatever is under the finger at that moment, which by then is the
 * scrim of the "Open this link?" confirm that just opened, so the confirm closed at once and the
 * tap seemed to do nothing. Mouse clicks go to the canvas (where the press started) and are not
 * affected. This swallows that one click, only when it comes within `ms` of a touch or pen press.
 */
export function isTouchLike(event: unknown) {
  const pointerType = (event as { pointerType?: unknown } | null)?.pointerType;
  if (pointerType === "touch" || pointerType === "pen") return true;
  return typeof TouchEvent !== "undefined" && event instanceof TouchEvent;
}

export function swallowNextClick(ms = 700, target: Pick<Window, "addEventListener" | "removeEventListener"> = window) {
  const until = Date.now() + ms;
  const onClick = (event: Event) => {
    stop();
    if (Date.now() > until) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const timer = setTimeout(() => stop(), ms);
  function stop() {
    clearTimeout(timer);
    target.removeEventListener("click", onClick, true);
  }
  target.addEventListener("click", onClick, true);
  return stop;
}
