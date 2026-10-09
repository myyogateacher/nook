import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MarkdownManager } from "@tiptap/markdown";
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { markdownOptions, noteContentExtensions } from "../src/editor/extensions";
import { chipName, fileChipIcon, fileChipMarkdown, parseFileChipLine, FILE_CHIP_OPEN_EVENT } from "../src/editor/fileChip";
import { NOTE_FILE_LIMIT, noteFileIds } from "../src/editor/noteAttach";
import { imageContentUrl } from "../src/editor/imageUpload";
import { referencedDocumentIds } from "../server/attachments/noteLinks";

/**
 * Uploads everywhere U4, the note editor side: the file card's Markdown round trip (and that the
 * server derives the same ids from it), the 100-file count, the slash items, and the wiring of
 * paste, drop, the attach sheet, and the preview (a guarded sheet, so Back closes it at 390 px).
 * Interaction itself is covered by the live QA in headless Chrome (no DOM in unit tests).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const manager = () => new MarkdownManager({ extensions: noteContentExtensions(), markedOptions: markdownOptions });
const roundTrip = (markdown: string) => {
  const md = manager();
  return md.serialize(md.parse(markdown)).trim();
};
const A = "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11";
const B = "6f1d2c3b-4a59-4e8f-8a7b-1c2d3e4f5a6b";

describe("the file card (fileChip)", () => {
  test("round-trips as a link alone in its paragraph, and the server derives the same id", () => {
    const markdown = `# Trip\n\n${fileChipMarkdown(A, "Report Q3.pdf")}\n\nAfter the file.`;
    expect(markdown).toContain(`[📎 Report Q3.pdf](/files/${A})`);
    const json = manager().parse(markdown);
    expect(json.content?.find((node) => node.type === "fileChip")?.attrs).toMatchObject({ id: A, name: "Report Q3.pdf" });
    expect(roundTrip(markdown)).toBe(markdown);
    expect(referencedDocumentIds(markdown)).toEqual([A]);
  });

  test("names with brackets, backslashes, and line breaks stay one safe line", () => {
    const markdown = fileChipMarkdown(A, "a [draft]\\v2\n.txt");
    expect(markdown).toBe(`[📎 a \\[draft\\]\\\\v2 .txt](/files/${A})`);
    expect(parseFileChipLine(markdown)).toMatchObject({ id: A, name: "a [draft]\\v2 .txt" });
    expect(roundTrip(markdown)).toBe(markdown);
    expect(referencedDocumentIds(markdown)).toEqual([A]);
    expect(chipName("   ")).toBe("file");
    expect([...chipName("x".repeat(500))]).toHaveLength(200);
  });

  test("an ordinary link to a file stays a link, and other sites never become cards", () => {
    expect(manager().parse(`[see this](/files/${A})`).content?.some((node) => node.type === "fileChip")).toBe(false);
    expect(manager().parse(`[📎 x](https://example.com/files/${A})`).content?.some((node) => node.type === "fileChip")).toBe(false);
    expect(parseFileChipLine(`[📎 x](/files/not-a-uuid)`)).toBeNull();
  });

  test("icons follow the extension", () => {
    expect(fileChipIcon("a.pdf").displayName ?? "").not.toBe(fileChipIcon("a.zip").displayName ?? "x");
    expect(fileChipIcon("no-extension")).toBe(fileChipIcon("other"));
  });
});

describe("the 100-file count (Q11)", () => {
  test("counts distinct images and file cards", () => {
    const schema = getSchema(noteContentExtensions());
    const markdown = `![a](${imageContentUrl(A)})\n\n${fileChipMarkdown(B, "b.txt")}\n\n${fileChipMarkdown(A, "again.png")}\n\n[plain](/files/${B})`;
    const doc = ProseMirrorNode.fromJSON(schema, manager().parse(markdown));
    expect([...noteFileIds(doc)].sort()).toEqual([A, B].sort());
    expect(NOTE_FILE_LIMIT).toBe(100);
  });
});

describe("editor wiring", () => {
  const editor = source("editor/NoteEditor.tsx");
  test("with attachHost, pasted, dropped, and picked files of any kind upload to the Attachments folder", () => {
    // ImageInsert's paste and drop handlers feed one handler; with attachHost it is attachFiles.
    expect(editor).toContain("latest.current.attachHost ? attachFiles(activeEditor, files) : insertImages(activeEditor, files)");
    expect(editor).toContain('uploadForHost(file, "note"');
    expect(editor).toMatch(/preview_kind === "image" && isInsertableImageType\(document\.mime_type\)/);
    expect(editor).toContain("insertFileChip");
    expect(source("editor/imageInsert.ts")).toMatch(/handlePaste[\s\S]*handleDrop/);
  });

  test("the attach sheet, From Files, and the preview are the shared kit (Back closes each, D21)", () => {
    expect(editor).toContain('<AttachSheet hostNoun="note"');
    expect(editor).toContain('<FromFilesSheet hostNoun="note"');
    expect(editor).toContain("<AttachmentPreview");
    expect(editor).toContain("FILE_CHIP_OPEN_EVENT");
    expect(FILE_CHIP_OPEN_EVENT).toBe("nook:file-chip-open");
    // The kit's sheets register a history layer each.
    expect(source("ui/attachments/AttachSheet.tsx")).toContain("useHistoryDialogGuard(true, onClose)");
    expect(source("ui/attachments/AttachmentPreview.tsx")).toContain("useHistoryDialogGuard(true, onClose)");
    // Notes turn it on; card descriptions keep their own image upload.
    expect(source("App.tsx")).toContain('attachHost="note"');
    expect(source("tasks/CardDialog.tsx")).not.toContain("attachHost");
  });

  test("the slash menu offers File and From Files only where the editor has them", () => {
    const slash = source("editor/slash.ts");
    expect(slash).toMatch(/label: "File".*requires: "openAttachSheet"/);
    expect(slash).toMatch(/label: "From Files".*requires: "openFromFiles"/);
  });

  test("whiteboard pictures go to the Attachments folder and the picker offers the camera on phones", () => {
    expect(source("whiteboards/WhiteboardCanvas.tsx")).toContain('uploadPictureForHost(file, "whiteboard"');
    const picker = source("whiteboards/NookPickers.tsx");
    expect(picker).toContain("capture={CAMERA_CAPTURE}");
    expect(picker).toContain("Everyone who can open this whiteboard sees the pictures you own on it");
  });
});
