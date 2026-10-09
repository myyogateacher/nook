import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isJpeg, orientationSegment, readOrientation, stripImageLocation, stripJpegMetadata } from "../src/ui/attachments/exif";
import { AttachSheet, CAMERA_ACCEPT, CAMERA_CAPTURE, fromFilesConfirm } from "../src/ui/attachments/AttachSheet";
import { AttachmentList, showsThumbnail, THUMBNAIL_MAX_BYTES } from "../src/ui/attachments/AttachmentList";
import { htmlHasText, pastedFiles } from "../src/ui/attachments/usePasteFiles";
import { dragHasFiles } from "../src/ui/attachments/useFileDrop";
import { usageSummary, type HostAttachment } from "../src/ui/attachments/uploadForHost";
import { canDropOnFolder, moveTargets } from "../src/files/fileActions";
import type { Folder } from "../src/types";

/**
 * Uploads everywhere U0, the client attach kit (D398, D401, Q9): JPEG location stripping as a pure byte
 * operation, the attach sheet's controls (camera capture input, choose, From Files with its confirm),
 * paste and drop rules, the list, and the Files guards for the Attachments folder.
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const bytes = (...parts: Array<number[] | Uint8Array | string>) => {
  const chunks = parts.map((part) => typeof part === "string" ? new TextEncoder().encode(part) : part instanceof Uint8Array ? part : Uint8Array.from(part));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
};
const segment = (marker: number, payload: Uint8Array) => bytes([0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff], payload);

/** EXIF with IFD0 = {Orientation: 6, GPSInfo → a GPS IFD holding a latitude ref "N"}. Big-endian, to cover both orders. */
function exifPayload() {
  const tiff = new Uint8Array(8 + 2 + 2 * 12 + 4 + 2 + 12 + 4);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d], 0);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, 2);
  view.setUint16(10, 0x0112); view.setUint16(12, 3); view.setUint32(14, 1); view.setUint16(18, 6);
  const gpsOffset = 8 + 2 + 24 + 4;
  view.setUint16(22, 0x8825); view.setUint16(24, 4); view.setUint32(26, 1); view.setUint32(30, gpsOffset);
  view.setUint32(34, 0);
  view.setUint16(gpsOffset, 1);
  view.setUint16(gpsOffset + 2, 0x0001); view.setUint16(gpsOffset + 4, 2); view.setUint32(gpsOffset + 6, 2); tiff.set([0x4e, 0], gpsOffset + 10);
  return bytes("Exif\0\0", tiff);
}

const SCAN = bytes([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00], [0x12, 0x34, 0xff, 0x00, 0x56], [0xff, 0xd9]);
function photo() {
  return bytes([0xff, 0xd8],
    segment(0xe0, bytes("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xe1, exifPayload()),
    segment(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0", "<x:xmpmeta><exif:GPSLatitude>51,30N</exif:GPSLatitude></x:xmpmeta>")),
    segment(0xed, bytes("Photoshop 3.0\0", "8BIM city=Lisbon")),
    segment(0xdb, new Uint8Array(65)),
    SCAN);
}
const contains = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle));

describe("EXIF location stripping (D401, Q9, T349)", () => {
  test("removes EXIF GPS, XMP, and IPTC, keeps the orientation, and copies the image data unchanged", () => {
    const input = photo();
    expect(readOrientation(exifPayload())).toBe(6);
    const { bytes: out, changed } = stripJpegMetadata(input);
    expect(changed).toBe(true);
    expect(isJpeg(out)).toBe(true);
    for (const marker of ["GPSLatitude", "xmpmeta", "Lisbon", "Photoshop", "http://ns.adobe.com"]) expect({ marker, found: contains(out, marker) }).toEqual({ marker, found: false });
    // The GPS IFD's "N" with its pointer tag is gone: the only EXIF left is the minimal orientation block.
    expect(Buffer.from(out).includes(Buffer.from([0x88, 0x25]))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from(orientationSegment(6)))).toBe(true);
    // APP0 stays first, the orientation block follows it, and everything from SOS on is byte-identical.
    expect(Array.from(out.subarray(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(Array.from(out.subarray(out.length - SCAN.length))).toEqual(Array.from(SCAN));
    expect(out.length).toBeLessThan(input.length);
    // Running it again changes nothing more.
    expect(stripJpegMetadata(out)).toEqual({ bytes: out, changed: true });
  });

  test("an upright photo gets no EXIF at all; PNG, a clean JPEG, and malformed bytes come back untouched", () => {
    const upright = bytes([0xff, 0xd8], segment(0xe1, bytes("Exif\0\0", orientationSegment(1).subarray(10))), SCAN);
    const stripped = stripJpegMetadata(upright);
    expect(stripped.changed).toBe(true);
    expect(contains(stripped.bytes, "Exif")).toBe(false);
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "tEXtGPS");
    expect(stripJpegMetadata(png)).toEqual({ bytes: png, changed: false });
    const clean = bytes([0xff, 0xd8], segment(0xe0, bytes("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0])), SCAN);
    expect(stripJpegMetadata(clean).bytes).toBe(clean);
    const truncated = bytes([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00], "Exif");
    expect(stripJpegMetadata(truncated)).toEqual({ bytes: truncated, changed: false });
  });

  test("stripImageLocation keeps the File's name and type, and returns other files as they are", async () => {
    const file = new File([photo() as BlobPart], "IMG_0001.jpg", { type: "image/jpeg", lastModified: 1_700_000_000_000 });
    const out = await stripImageLocation(file);
    expect(out).not.toBe(file);
    expect({ name: out.name, type: out.type, lastModified: out.lastModified }).toEqual({ name: "IMG_0001.jpg", type: "image/jpeg", lastModified: 1_700_000_000_000 });
    expect(contains(new Uint8Array(await out.arrayBuffer()), "GPSLatitude")).toBe(false);
    const png = new File([bytes([0x89, 0x50, 0x4e, 0x47]) as BlobPart], "shot.png", { type: "image/png" });
    expect(await stripImageLocation(png)).toBe(png);
    // The kit strips before every upload unless the caller opts out for that file.
    expect(source("ui/attachments/uploadForHost.ts")).toContain("options.keepLocation ? file : await stripImageLocation(file)");
  });
});

describe("the attach sheet (D398, §4.3)", () => {
  const render = (props: Partial<Parameters<typeof AttachSheet>[0]> = {}) => renderToStaticMarkup(<AttachSheet hostNoun="event" onClose={() => undefined} onFiles={() => undefined} onPickDocument={() => undefined} camera {...props} />);

  test("Take photo is a camera capture input; Choose files takes several; From Files opens the owner's picker", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Attach to this event");
    for (const label of ["Take photo", "Choose files", "From Files"]) expect(html).toContain(label);
    expect(CAMERA_ACCEPT).toBe("image/*");
    expect(CAMERA_CAPTURE).toBe("environment");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"[^>]*data-attach-input="camera"/);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple=""[^>]*data-attach-input="files"/);
    // Buttons are the shared action buttons; no native select or confirm.
    expect(html).toContain("action-button secondary attach-sheet-action");
    expect(html).not.toContain("<select");
    expect(html).toContain("Photo locations are removed before upload");
  });

  test("no camera off touch devices, no From Files without a handler, and a cap disables everything with the reason", () => {
    expect(render({ camera: false })).not.toContain("Take photo");
    expect(render({ camera: false })).not.toContain('capture="environment"');
    expect(render({ onPickDocument: undefined })).not.toContain("From Files");
    const capped = render({ disabledReason: "An event can have up to 20 files" });
    expect(capped.match(/disabled=""/g)?.length).toBe(3);
    expect(capped).toContain("An event can have up to 20 files");
  });

  test("Back closes the sheet and then the picker first (history layers), and From Files lists only the caller's own files with a confirm", () => {
    const sheet = source("ui/attachments/AttachSheet.tsx");
    expect(sheet).toContain("useHistoryDialogGuard(true, onClose);");
    expect(sheet).toContain("useHistoryDialogGuard(true, onClose, { blocked: confirmOpen });");
    expect(sheet).toContain("document.is_owner === 1 && document.kind !== \"whiteboard\"");
    expect(sheet).toContain("await ask({ ...fromFilesConfirm(hostNoun, document.name), opener: trigger })");
    expect(sheet).toContain('"/folders?include=system"');
    expect(sheet).toContain("(pointer: coarse)");
    expect(fromFilesConfirm("card", "spec.pdf")).toEqual({ title: "Attach a file from Files?", message: "People who can open this card will be able to open “spec.pdf”. It stays in its folder in Files.", confirmLabel: "Attach" });
    expect(source("ui/attachments/AttachmentPreview.tsx")).toContain("useHistoryDialogGuard(true, onClose);");
  });
});

describe("paste, drop, list, and usage", () => {
  const file = new File(["x"], "shot.png", { type: "image/png" });
  const clipboard = (html: string) => ({ files: [file] as unknown as FileList, getData: (type: string) => type === "text/html" ? html : "" });

  test("a rich-text paste stays text; a files-only paste (or one with a bare image) is taken", () => {
    expect(pastedFiles(clipboard("<p>Quarterly numbers</p><img src=x>"))).toEqual([]);
    expect(pastedFiles(clipboard(""))).toEqual([file]);
    expect(pastedFiles(clipboard("<img src=x>"))).toEqual([file]);
    expect(pastedFiles(null)).toEqual([]);
    expect(htmlHasText("<b> &nbsp; </b>")).toBe(false);
    expect(dragHasFiles({ dataTransfer: { types: ["Files"] } as unknown as DataTransfer })).toBe(true);
    expect(dragHasFiles({ dataTransfer: { types: ["text/plain"] } as unknown as DataTransfer })).toBe(false);
  });

  test("thumbnails only for small sniffed images; removed files show as such; usage reads as a sentence", () => {
    const item = (over: Partial<Extract<HostAttachment, { removed: false }>> = {}): HostAttachment => ({ documentId: "d1", removed: false, name: "a.png", mimeType: "image/png", previewKind: "image", sizeBytes: 1000, partId: null, position: 0, linkedAt: "", isOwner: true, inAttachmentsFolder: true, ...over });
    expect(showsThumbnail(item())).toBe(true);
    expect(showsThumbnail(item({ sizeBytes: THUMBNAIL_MAX_BYTES + 1 }))).toBe(false);
    expect(showsThumbnail(item({ mimeType: "image/svg+xml" }))).toBe(false);
    const html = renderToStaticMarkup(<AttachmentList items={[item(), { documentId: "d2", removed: true, partId: null, position: 1, linkedAt: "" }]} onOpen={() => undefined} onRemove={() => undefined} canRemove={() => true} />);
    expect(html).toContain('src="/api/files/d1/content?disposition=inline"');
    expect(html).toContain('href="/api/files/d1/content?disposition=attachment"');
    expect(html).toContain("File removed");
    expect(html).not.toContain("d2/content");
    expect(usageSummary({ uses: [{ hostKind: "card", hostId: "c1", title: null }, { hostKind: "card", hostId: "c2", title: null }, { hostKind: "event", hostId: "e1", title: null }], hiddenCount: 0, total: 3 })).toBe("Used on 2 cards and 1 event");
    expect(usageSummary({ uses: [], hiddenCount: 1, total: 1 })).toBe("Used on 1 place you cannot open");
    expect(usageSummary({ uses: [], hiddenCount: 0, total: 0 })).toBeNull();
  });

  test("Files never offers the Attachments folder as a move or drop target, and shows it with a lock", () => {
    const folder = (over: Partial<Folder>): Folder => ({ id: "f", owner_id: "u", owner_name: "U", parent_id: null, name: "F", is_default: 0, is_owner: 1, visibility: "private", created_at: "", updated_at: "", system_kind: null, ...over });
    const system = folder({ id: "s", name: "Attachments", system_kind: "attachments" });
    expect(moveTargets([folder({ id: "d", name: "Default", is_default: 1 }), system], null).map((target) => target.id)).toEqual(["d"]);
    expect(canDropOnFolder(system, null)).toBe(false);
    expect(canDropOnFolder(folder({}), null)).toBe(true);
    const app = source("files/FilesApp.tsx");
    expect(app).toContain('"/folders?include=system"');
    expect(app).toContain("folder-system-badge");
    expect(source("files/files.css")).toContain(".folder-link:has(> .folder-system-badge)");
    expect(app).toContain("fileUsage(deleteDocumentId)");
  });
});
