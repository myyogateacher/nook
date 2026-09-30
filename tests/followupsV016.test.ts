import { expect, test } from "bun:test";

// Follow-ups found by QA on the released v0.16.0 (F1–F10). The scroll shells (F1, F2) are guarded in
// tests/scrollShells.test.ts, the Google card (F3) in tests/googleSignInUi.test.tsx.

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

/** The body of the first `@media (max-width: 760px)` block that contains `needle`. */
function phoneBlock(css: string, needle: string) {
  for (const match of css.matchAll(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/g)) if (match[1].includes(needle)) return match[1];
  return "";
}

test("F5: the phone note toolbar's Publish version button is a 44 px target inside the 58 px toolbar", async () => {
  const css = await read("styles.css");
  const phone = phoneBlock(css, ".publish-button {");
  expect(phone).toMatch(/\.publish-button \{ min-height: 44px; padding: 0 10px; \}/);
  expect(phone).toMatch(/\.editor-toolbar \{ height: 58px;/);
});

