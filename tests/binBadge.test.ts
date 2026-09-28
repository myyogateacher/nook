import { expect, test } from "bun:test";
import { notifyBinChanged, onBinChanged } from "../src/bin/binApi";

// Friction 8: the header Bin badge stayed stale after Restore all in a key's Review. Restores and
// deletes announce a change, and useBinCount counts again on each one.

test("a Bin change reaches every listener until it unsubscribes", () => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = new EventTarget();
  try {
    let heard = 0;
    const stop = onBinChanged(() => { heard += 1; });
    notifyBinChanged();
    notifyBinChanged();
    expect(heard).toBe(2);
    stop();
    notifyBinChanged();
    expect(heard).toBe(2);
  } finally {
    holder.window = previous;
  }
});

test("restore and delete announce the change; the badge hook and Restore all listen", async () => {
  const api = await Bun.file(new URL("../src/bin/binApi.ts", import.meta.url)).text();
  for (const name of ["restoreBinItem", "deleteBinItem", "emptyBin"]) expect(api).toMatch(new RegExp(`export const ${name} = [^\\n]*\\.then\\(changed\\);`));
  const shell = await Bun.file(new URL("../src/AppShell.tsx", import.meta.url)).text();
  expect(shell).toContain("const stop = onBinChanged(count);");
  const review = await Bun.file(new URL("../src/McpBinnedReview.tsx", import.meta.url)).text();
  expect(review).toContain("if (result.restored > 0) notifyBinChanged();");
});
