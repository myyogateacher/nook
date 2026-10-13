import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// v0.35.0 release QA, the low findings (checked live at 1280 and 390 px; these pin the wiring).
const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

describe("v0.35.0 QA low fixes", () => {
  test("Attach from Files shows the system folder's real name", () => {
    const sheet = source("ui/attachments/AttachSheet.tsx");
    expect(sheet).toContain("setAttachmentsFolder(folder ? { id: folder.id, name: folder.name } : null)");
    expect(sheet).toContain("` · ${attachmentsFolder.name}`");
    expect(sheet).not.toContain('" · Attachments"');
  });

  test("a long folder name in the Files sidebar ends in an ellipsis, with the whole name as its title", () => {
    expect(source("files/FilesApp.tsx")).toContain('<span className="folder-copy" title={item.name}><span className="folder-name">{item.name}</span></span>');
    expect(source("styles.css")).toMatch(/\.folder-copy > \.folder-name \{[^}]*text-overflow: ellipsis/);
  });

  test("a restore from Settings › Bin is a success toast, as Undo's is", () => {
    expect(source("bin/BinSection.tsx")).toContain("notify.success(restoreResultMessage(item, result))");
  });

  test("binning the open file closes its confirm before leaving the file, so Back is not undone", () => {
    const files = source("files/FilesApp.tsx");
    const body = files.slice(files.indexOf("async function deleteDocument"), files.indexOf("async function deleteDocument") + 2000);
    expect(body.indexOf("dialogOpenRef.current = false;")).toBeGreaterThan(0);
    expect(body.indexOf("dialogOpenRef.current = false;")).toBeLessThan(body.indexOf("removed: true"));
  });

  test("the event editor's forms use the shared scrolling body with a pinned footer", () => {
    expect(source("calendar/EventSheet.tsx")).toContain("calendar-form calendar-event-form file-dialog-body");
    expect(source("calendar/EventLinks.tsx")).toContain('className="calendar-form file-dialog-body"');
    expect(source("files/files.css")).toContain(".file-dialog > :is(.file-dialog-form, .file-dialog-body) > .file-dialog-actions:last-child { position: sticky;");
  });

  test("the key dialogs validate in the app, not with the browser's bubble", () => {
    const keys = source("keys/KeysSettings.tsx");
    expect(keys).not.toContain('<form className="keys-form" onSubmit={submit}>');
    expect(keys).toContain('"Enter your password to confirm."');
    expect(keys).toContain('"Enter the six-digit code from your authenticator app."');
  });
});
