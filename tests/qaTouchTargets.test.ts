import { expect, test } from "bun:test";

// v0.13.0 QA, A8: 390 px tap targets on the Notes search input and the sign-in card's text links.

test("the Notes search input fills its box, which is 44 px on phones", async () => {
  const styles = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(styles).toContain(".search-box input { width: 100%; align-self: stretch; min-height: 0;");
  const search = await Bun.file(new URL("../src/search/search.css", import.meta.url)).text();
  const phone = search.indexOf("@media (max-width: 760px) {");
  expect(phone).toBeGreaterThan(-1);
  expect(search.indexOf("  .search-box { height: 44px; }", phone)).toBeGreaterThan(phone);
});

test("text links on the sign-in and register card are 44 px targets", async () => {
  const styles = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(styles).toContain(".auth-card .text-button { min-height: 44px; }");
});
