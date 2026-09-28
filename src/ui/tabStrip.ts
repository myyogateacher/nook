type Box = { left: number; width: number };
type Strip = {
  scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  getBoundingClientRect(): Box;
  querySelector(selector: string): { getBoundingClientRect(): Box } | null;
};

/**
 * Scrolls a sideways tab strip (Settings sections on a phone, 3c) so its aria-current tab sits in the
 * middle, on a deep link and after each change. A strip that fits is left alone.
 */
export function centerActiveTab(strip: Strip | null) {
  const active = strip?.querySelector('[aria-current="page"]');
  if (!strip || !active || strip.scrollWidth <= strip.clientWidth) return;
  const stripBox = strip.getBoundingClientRect();
  const tabBox = active.getBoundingClientRect();
  strip.scrollLeft += tabBox.left + tabBox.width / 2 - (stripBox.left + strip.clientWidth / 2);
}
