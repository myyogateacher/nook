import { expect, test } from "bun:test";
import { centerActiveTab } from "../src/ui/tabStrip";

/** 3c: a phone deep link to /settings/notifications shows the Notifications tab, not Security. */

function strip(tabLeft: number, scrollWidth = 780) {
  let scrollLeft = 0;
  return {
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(value: number) { scrollLeft = value; },
    scrollWidth,
    clientWidth: 390,
    getBoundingClientRect: () => ({ left: 0, width: 390 }),
    // The tab's box moves left as the strip scrolls.
    querySelector: (selector: string) => selector === '[aria-current="page"]' ? { getBoundingClientRect: () => ({ left: tabLeft - scrollLeft, width: 130 }) } : null
  };
}

test("the active tab is scrolled to the middle of an overflowing strip", () => {
  const tabs = strip(530);
  centerActiveTab(tabs);
  expect(tabs.scrollLeft).toBe(530 + 65 - 195);
  // Already centred: nothing moves.
  centerActiveTab(tabs);
  expect(tabs.scrollLeft).toBe(400);
});

test("a strip that fits, or has no active tab, is left alone", () => {
  const fits = strip(200, 390);
  centerActiveTab(fits);
  expect(fits.scrollLeft).toBe(0);
  centerActiveTab(null);
  const none = { ...strip(200), querySelector: () => null };
  centerActiveTab(none);
  expect(none.scrollLeft).toBe(0);
});
