import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Attachments, firstImage, toHostAttachment } from "../src/collections/Attachments";
import { CellEditor } from "../src/collections/cells";
import { CollectionCards, coverImage } from "../src/collections/CollectionCards";
import type { Attachment, CollectionRow, FieldDefinition } from "../src/collections/collectionsApi";
import { ROW_FILE_LIMIT } from "../src/collections/collectionsApi";
import { RowPanel } from "../src/collections/RowPanel";

/**
 * Uploads everywhere U3, the Collections client: the file field uses the shared attach kit (sheet,
 * drop, paste, list, preview), table cells and phone cards draw the first image as a thumbnail
 * (originals up to 8 MiB, D399), and the sheet and preview are history layers so Back closes them
 * before the row (D18, D21).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const name: FieldDefinition = { id: "f_aaaaaaaa", name: "Item", type: "text", required: true };
const receipt: FieldDefinition = { id: "f_bbbbbbbb", name: "Receipt", type: "file" };
const photos: FieldDefinition = { id: "f_cccccccc", name: "Photos", type: "file" };
const fields = [name, receipt, photos];

const file = (id: string, fileName: string, mime: string, size = 2048, preview = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : "none"): Attachment =>
  ({ id, name: fileName, mime_type: mime, preview_kind: preview, size_bytes: size, linked_by: "u" });
const row = (files: CollectionRow["files"] = {}): CollectionRow => ({
  id: "11111111-1111-4111-8111-111111111111", collection_id: "c", position: 1, title: "Lunch", values: { f_aaaaaaaa: "Lunch" }, links: {}, files, revision: 3, can_undo: false,
  created_by: null, created_by_name: null, updated_by_name: null, updated_via_key_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z"
});
const pdf = file("aaaaaaaa-0000-4000-8000-000000000001", "bill.pdf", "application/pdf");
const jpeg = file("aaaaaaaa-0000-4000-8000-000000000002", "receipt.jpg", "image/jpeg");
const huge = file("aaaaaaaa-0000-4000-8000-000000000003", "scan.png", "image/png", 9 * 1024 * 1024);
const svg = file("aaaaaaaa-0000-4000-8000-000000000004", "logo.svg", "image/svg+xml", 100, "none");

test("the file field lists files through the kit, with thumbnails for small images only", () => {
  const markup = renderToStaticMarkup(<Attachments row={row({ [receipt.id]: [pdf, jpeg, huge, svg] })} field={receipt} editable onChanged={() => undefined} notify={() => undefined} />);
  expect(markup).toContain('class="attachment-list" aria-label="Receipt files"');
  expect(markup).toContain(`src="/api/files/${jpeg.id}/content?disposition=inline"`);
  // A 9 MiB PNG and an SVG (never inline, D6) show a kind icon instead.
  for (const id of [huge.id, svg.id, pdf.id]) expect(markup).not.toContain(`src="/api/files/${id}/content`);
  // Open is a button that opens the preview sheet, not a new tab; Download is a plain link.
  expect(markup).toContain('aria-label="Open bill.pdf" aria-haspopup="dialog"');
  expect(markup).not.toContain('target="_blank"');
  expect(markup).toContain(`href="/api/files/${pdf.id}/content?disposition=attachment"`);
  expect(markup).toContain('aria-label="Remove bill.pdf"');
  // The attach button opens the sheet (a dialog), and the field says it takes drops and pastes.
  expect(markup).toMatch(/<button type="button" class="secondary-button row-attachment-add" aria-haspopup="dialog"[^>]*>.*Attach files<\/button>/);
  expect(markup).toContain("Or drop or paste files here");
  expect(markup).toContain('role="group" aria-label="Receipt files"');
});

test("viewers can open and download but not attach or remove; a full row says why", () => {
  const viewer = renderToStaticMarkup(<Attachments row={row({ [receipt.id]: [pdf] })} field={receipt} editable={false} onChanged={() => undefined} notify={() => undefined} />);
  expect(viewer).toContain('aria-label="Open bill.pdf"');
  expect(viewer).not.toContain("Remove bill.pdf");
  expect(viewer).not.toContain("Attach files");
  expect(viewer).not.toContain("drop or paste");
  expect(renderToStaticMarkup(<Attachments row={row()} field={receipt} editable={false} onChanged={() => undefined} notify={() => undefined} />)).toContain("No files");

  // 20 files across the row's file fields fill it (D400).
  const many = Array.from({ length: ROW_FILE_LIMIT }, (_, index) => file(`bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`, `r${index}.txt`, "text/plain"));
  const full = renderToStaticMarkup(<Attachments row={row({ [receipt.id]: many.slice(0, 12), [photos.id]: many.slice(12) })} field={receipt} editable onChanged={() => undefined} notify={() => undefined} />);
  expect(full).toMatch(/<button[^>]*disabled=""[^>]*>.*20 files per row<\/button>/);
});

test("table cells show the first image of the field next to its name or count", () => {
  const two = renderToStaticMarkup(<CellEditor field={receipt} row={row({ [receipt.id]: [pdf, jpeg] })} editable onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(two).toContain('class="file-thumb cell-file-thumb"');
  expect(two).toContain(`src="/api/files/${jpeg.id}/content?disposition=inline"`);
  expect(two).toContain('loading="lazy"');
  expect(two).toContain('<span class="cell-file-name">2 files</span>');
  // Read-only cells draw it too; a field without images, or an empty one, draws none.
  const readOnly = renderToStaticMarkup(<CellEditor field={receipt} row={row({ [receipt.id]: [jpeg] })} editable={false} onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(readOnly).toContain("cell-file-thumb");
  expect(readOnly).toContain("receipt.jpg");
  expect(renderToStaticMarkup(<CellEditor field={receipt} row={row({ [receipt.id]: [pdf, huge] })} editable onSave={async () => true} onOpenPicker={() => undefined} />)).not.toContain("<img");
  expect(renderToStaticMarkup(<CellEditor field={receipt} row={row()} editable onSave={async () => true} onOpenPicker={() => undefined} />)).not.toContain("<img");
  expect(firstImage(row({ [receipt.id]: [svg, huge, jpeg] }), receipt)?.id).toBe(jpeg.id);
});

test("phone cards take the first image of any file field, in field order, as a cover", () => {
  const sample = row({ [receipt.id]: [pdf], [photos.id]: [jpeg] });
  expect(coverImage(fields, sample)?.id).toBe(jpeg.id);
  const markup = renderToStaticMarkup(<CollectionCards fields={fields} rows={[sample]} editable conflicts={{}} onOpenRow={() => undefined} onRowActions={() => undefined} onReloadRow={() => undefined} />);
  expect(markup).toContain('class="collection-card has-cover"');
  expect(markup).toContain('class="file-thumb collection-card-cover" aria-hidden="true"');
  expect(coverImage(fields, row({ [receipt.id]: [pdf] }))).toBeNull();
  expect(renderToStaticMarkup(<CollectionCards fields={fields} rows={[row()]} editable conflicts={{}} onOpenRow={() => undefined} onRowActions={() => undefined} onReloadRow={() => undefined} />)).not.toContain("has-cover");
});

test("the row panel renders file fields through the kit for each file field", () => {
  const collection = { id: "c", name: "Receipts", icon: "table", owner_id: "o", owner_name: "O", is_owner: 1 as const, role: "owner" as const, visibility: "private" as const, share_role: "viewer" as const, row_count: 1, field_count: fields.length, template_id: null, created_at: "", updated_at: "", fields, schema_version: 1 };
  const sample = row({ [receipt.id]: [jpeg] });
  const markup = renderToStaticMarkup(<RowPanel collection={collection} rowId={sample.id} listed={sample} conflict={null} save={async () => null} onAcceptConflict={() => undefined} onActions={() => undefined}
    onClose={() => undefined} onMissing={() => undefined} editable
    renderFiles={(current, field) => <Attachments row={current} field={field} editable onChanged={() => undefined} notify={() => undefined} />} />);
  expect([...markup.matchAll(/class="row-attachments"/g)]).toHaveLength(2);
  expect(markup).toContain('aria-label="Photos files"');
  expect(toHostAttachment(jpeg, receipt.id)).toMatchObject({ documentId: jpeg.id, removed: false, previewKind: "image", partId: receipt.id });
});

test("uploads go to the Attachments folder through the kit; the sheet and preview are Back layers that hold Escape", () => {
  const attachments = source("collections/Attachments.tsx");
  // One upload path (D390): the kit's uploadForHost with attachTo=row, never the legacy hidden purpose.
  expect(attachments).toContain('uploadForHost(file, "row"');
  expect(attachments).not.toContain("collection_attachment");
  expect(source("collections/collectionsApi.ts")).not.toContain("purpose=collection_attachment");
  // The kit's sheet (camera, choose, From Files with its confirm) and preview, plus drop and paste.
  for (const name of ["<AttachSheet", "onPickDocument=", "<AttachmentPreview", "useFileDrop(", "usePasteFiles("]) expect({ name, used: attachments.includes(name) }).toEqual({ name, used: true });
  // Both guard Back themselves (useHistoryDialogGuard); the row panel's Escape waits while they are open.
  expect(source("ui/attachments/AttachSheet.tsx")).toContain("useHistoryDialogGuard(true, onClose)");
  expect(source("ui/attachments/AttachmentPreview.tsx")).toContain("useHistoryDialogGuard(true, onClose)");
  expect(attachments).toContain("useEscapeHold(sheetOpen || preview !== null)");
  expect(source("collections/dialogLayers.ts")).toContain("export const openLayerCount = () => layers.length + held;");
  expect(source("collections/RowPanel.tsx")).toContain("openLayerCount() > 0");
  // A photo whose location cannot be removed is refused by the kit with a friendly message (U0 review M2);
  // a viewer may still take their own file off through the generic route (U0 review M1).
  expect(attachments).toContain("reason instanceof LocationStripError");
  expect(attachments).toContain('unlinkFromHost("row"');
  expect(attachments).toContain("canRemove={(item) => editable || owned.has(item.documentId)}");
  // The From Files confirm is sent as `confirmed` (D396).
  expect(source("collections/collectionsApi.ts")).toContain("...(options.confirmed ? { confirmed: true } : {})");
});
