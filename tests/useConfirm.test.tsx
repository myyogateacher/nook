import { expect, test } from "bun:test";
import { unsavedKeyConfirm } from "../src/App";

// C1 (D91): the last native confirms (an unsaved API key, two-factor, recovery codes, discarding a
// draft, Bin Delete forever and Empty Bin, leaving Files during uploads) use one awaitable hook over
// the app's confirm dialog. The browser proof (no native dialog fires) is in the release QA.

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

test("the confirm layer is a history layer whose Back is Cancel, above every panel", async () => {
  const hook = await read("ui/useConfirm.tsx");
  expect(hook).toContain("useHistoryDialogGuard(true, cancel);");
  expect(hook).toContain("<ConfirmDialog");
  // Focus goes back to the control that asked, once the layer's own history clean-up has landed.
  expect(hook).toContain("whenHistorySettled(");
  expect(hook).toContain("answer.opener.focus()");
  const css = await read("ui/ui.css");
  expect(css).toContain(".app-confirm-layer > :is(.panel-scrim, .file-dialog) { z-index: 80; }");
});

test("every former native confirm site asks through useConfirm", async () => {
  const app = await read("App.tsx");
  expect(app.match(/await ask\(unsavedKeyConfirm\("(close|section|leave)"\)\)/g)?.length).toBe(3);
  expect(app).toContain("appConfirm.ask(unsavedKeyConfirm(\"close\"))");
  expect(app).toContain('title: "Disable two-factor authentication?"');
  expect(app).toContain('title: "Generate new recovery codes?"');
  expect(app).toContain("const confirmed = await appConfirm.ask({");
  // Escape on a confirm over Settings cancels the confirm only; Settings' own Escape stands aside.
  expect(app).toContain('!event.defaultPrevented && !document.querySelector(".app-confirm-layer")) void guardedClose();');
  const bin = await read("bin/BinApp.tsx");
  expect(bin).toContain('title: "Delete forever?"');
  expect(bin).toContain('title: "Empty the Bin?"');
  expect(bin).toContain("{confirmElement}");
  const files = await read("files/FilesApp.tsx");
  expect(files).toContain('title: "Leave Files?"');
  expect(files).toContain("{leaveConfirm}");
  // No beforeunload prompt: closing the tab is not guarded.
  expect(files).not.toContain("beforeunload");
});

test("the unsaved key confirm names what is being left", () => {
  expect(unsavedKeyConfirm("close")).toMatchObject({ title: "Leave without saving the key?", confirmLabel: "Close without saving", danger: true });
  expect(unsavedKeyConfirm("section").message).toContain("Leave this section without copying it?");
  expect(unsavedKeyConfirm("leave").confirmLabel).toBe("Leave without saving");
});
