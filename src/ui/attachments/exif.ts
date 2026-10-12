/**
 * Photo location stripping before upload (uploads everywhere plan D401, operator decision Q9, T349,
 * review M2). Pure byte operations, no dependency, done in the browser before the bytes leave it.
 *
 * - **JPEG**: the EXIF APP1 segment (GPS position, camera serial, and the rest) is replaced by a
 *   minimal EXIF block that keeps only the Orientation tag, so phone photos still display upright;
 *   XMP APP1, Photoshop/IPTC APP13, and MPF APP2 segments are removed. Stray bytes between segments
 *   are skipped. The entropy-coded data is copied unchanged up to the primary image's EOI, and
 *   everything after it is dropped: MPF secondary images (which carry their own EXIF and GPS) and
 *   motion-photo MP4 trailers.
 * - **PNG**: the `eXIf` chunk and XMP (`iTXt` with the `XML:com.adobe.xmp` keyword) are removed.
 * - **WebP**: the `EXIF` and `XMP ` chunks are removed and the VP8X flags and RIFF size fixed.
 * - **When a JPEG cannot be walked** (truncated or malformed) and it still carries EXIF or XMP, it is
 *   re-encoded through a canvas (`createImageBitmap` applies the orientation; the result has no
 *   metadata at all). When that is impossible too, the upload is refused with a clear message
 *   (`LocationStripError`); the caller may retry with `keepLocation`.
 * - **Not stripped:** HEIC/HEIF (and any other format), and files larger than 64 MiB
 *   (`STRIP_MAX_BYTES`), which are uploaded as they are. The server never rewrites bytes (an upload's
 *   SHA-256 must match what the client sent), so files uploaded by other means (MCP, REST, and in the
 *   Files app Upload files, Upload folder, and drag and drop) keep their metadata. Files' Take photo
 *   and paste do go through this function (U6).
 */

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP_HEADER = Array.from(new TextEncoder().encode("http://ns.adobe.com/"));
const MPF_HEADER = [0x4d, 0x50, 0x46, 0x00]; // "MPF\0"
const ORIENTATION_TAG = 0x0112;

/** Above this the kit uploads the file as it is (review L5): stripping reads the whole file into memory. */
export const STRIP_MAX_BYTES = 64 * 1024 * 1024;

export const isJpeg = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === SOI && bytes[2] === 0xff;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (bytes: Uint8Array) => bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
export const isWebp = (bytes: Uint8Array) => bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let out = "";
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) out += String.fromCharCode(bytes[offset + index]!);
  return out;
}
const startsWith = (bytes: Uint8Array, offset: number, prefix: readonly number[]) => prefix.every((value, index) => bytes[offset + index] === value);
function concat(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function indexOfBytes(haystack: Uint8Array, needle: readonly number[], from = 0) {
  outer: for (let index = from; index <= haystack.length - needle.length; index += 1) {
    for (let inner = 0; inner < needle.length; inner += 1) if (haystack[index + inner] !== needle[inner]) continue outer;
    return index;
  }
  return -1;
}

const MARKERS = [EXIF_HEADER, XMP_HEADER, Array.from(new TextEncoder().encode("eXIf")), Array.from(new TextEncoder().encode("EXIF"))];
/** Whether the bytes still hold an EXIF or XMP block anywhere (JPEG APP1, PNG eXIf, WebP EXIF): the refusal trigger. */
export const hasLocationMetadata = (bytes: Uint8Array) => MARKERS.some((marker) => indexOfBytes(bytes, marker) >= 0);

/** The Orientation (1–8) in an EXIF APP1 payload (starting at "Exif\0\0"), or null. */
export function readOrientation(payload: Uint8Array): number | null {
  if (!startsWith(payload, 0, EXIF_HEADER)) return null;
  const tiff = 6;
  if (payload.length < tiff + 8) return null;
  const little = payload[tiff] === 0x49 && payload[tiff + 1] === 0x49;
  const big = payload[tiff] === 0x4d && payload[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > payload.length) return null;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > payload.length) return null;
    if (u16(entry) === ORIENTATION_TAG) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A minimal EXIF APP1 segment (marker and length included) holding only `orientation`. */
export function orientationSegment(orientation: number): Uint8Array {
  const payload = new Uint8Array(6 + 8 + 2 + 12 + 4);
  payload.set(EXIF_HEADER, 0);
  const view = new DataView(payload.buffer);
  payload.set([0x49, 0x49], 6);
  view.setUint16(8, 42, true);
  view.setUint32(10, 8, true);
  view.setUint16(14, 1, true);
  view.setUint16(16, ORIENTATION_TAG, true);
  view.setUint16(18, 3, true); // SHORT
  view.setUint32(20, 1, true);
  view.setUint16(24, orientation, true);
  view.setUint32(28, 0, true);
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, APP1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff], 0);
  segment.set(payload, 4);
  return segment;
}

export type StripResult = { bytes: Uint8Array; changed: boolean; failed?: boolean };

/** Where the entropy-coded data that starts at `from` ends: the index of the next real marker's 0xFF. */
function entropyEnd(bytes: Uint8Array, from: number) {
  for (let index = from; index < bytes.length - 1; index += 1) {
    if (bytes[index] !== 0xff) continue;
    const next = bytes[index + 1]!;
    // Stuffed 0xFF00, restart markers, and fill bytes stay inside the scan.
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) continue;
    return index;
  }
  return -1;
}

/**
 * Removes location-bearing metadata from a JPEG and everything after its primary image (see the file
 * comment). `failed` is set when the bytes could not be walked to the primary image's EOI; the bytes
 * then come back unchanged and the caller decides (stripImageLocation re-encodes).
 */
export function stripJpegMetadata(bytes: Uint8Array): StripResult {
  if (!isJpeg(bytes)) return { bytes, changed: false };
  const unchanged = (failed: boolean): StripResult => ({ bytes, changed: false, ...(failed ? { failed: true } : {}) });
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let changed = false;
  let orientation: number | null = null;
  let insertAt = -1;
  let ended = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Stray bytes between segments (some encoders pad or leave junk): skip to the next marker.
      const next = bytes.indexOf(0xff, offset);
      if (next < 0) return unchanged(true);
      changed = true;
      offset = next;
      continue;
    }
    let markerAt = offset;
    while (markerAt + 1 < bytes.length && bytes[markerAt + 1] === 0xff) markerAt += 1;
    const marker = bytes[markerAt + 1];
    if (marker === undefined) return unchanged(true);
    if (marker === EOI) {
      if (insertAt < 0) insertAt = parts.length;
      parts.push(bytes.subarray(markerAt, markerAt + 2));
      // Anything after the primary image (MPF secondary images, a motion-photo MP4) is dropped.
      if (markerAt + 2 < bytes.length) changed = true;
      ended = true;
      break;
    }
    // Stand-alone markers (TEM, RSTn) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(markerAt, markerAt + 2));
      offset = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > bytes.length) return unchanged(true);
    const length = (bytes[markerAt + 2]! << 8) | bytes[markerAt + 3]!;
    const end = markerAt + 2 + length;
    if (length < 2 || end > bytes.length) return unchanged(true);
    const payload = bytes.subarray(markerAt + 4, end);
    if (marker === SOS) {
      if (insertAt < 0) insertAt = parts.length;
      // The scan header, then its entropy-coded data up to the next real marker (more scans, EOI).
      const dataEnd = entropyEnd(bytes, end);
      if (dataEnd < 0) return unchanged(true);
      parts.push(bytes.subarray(markerAt, dataEnd));
      offset = dataEnd;
      continue;
    }
    const isExif = marker === APP1 && startsWith(payload, 0, EXIF_HEADER);
    if (marker === APP1 || marker === APP13 || (marker === APP2 && startsWith(payload, 0, MPF_HEADER))) {
      if (isExif) {
        orientation ??= readOrientation(payload);
        if (insertAt < 0) insertAt = parts.length;
      }
      changed = true;
    } else {
      // The minimal EXIF goes after APP0 (JFIF), before every other segment.
      if (insertAt < 0 && marker !== 0xe0) insertAt = parts.length;
      parts.push(bytes.subarray(markerAt, end));
    }
    offset = end;
  }
  if (!ended) return unchanged(true);
  if (!changed) return { bytes, changed: false };
  if (orientation !== null && orientation !== 1) parts.splice(insertAt < 0 ? 1 : insertAt, 0, orientationSegment(orientation));
  return { bytes: concat(parts), changed: true };
}

/** Removes the PNG `eXIf` chunk and XMP `iTXt` chunks. CRCs of the kept chunks are untouched. */
export function stripPngMetadata(bytes: Uint8Array): StripResult {
  if (!isPng(bytes)) return { bytes, changed: false };
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let changed = false;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + length;
    if (end > bytes.length) return { bytes, changed: false, failed: true };
    const type = ascii(bytes, offset + 4, 4);
    const xmp = type === "iTXt" && ascii(bytes, offset + 8, 17) === "XML:com.adobe.xmp";
    if (type === "eXIf" || xmp) changed = true;
    else parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return changed ? { bytes: concat(parts), changed: true } : { bytes, changed: false };
}

/** Removes the WebP `EXIF` and `XMP ` chunks, clears their VP8X flags, and fixes the RIFF size. */
export function stripWebpMetadata(bytes: Uint8Array): StripResult {
  if (!isWebp(bytes)) return { bytes, changed: false };
  const parts: Uint8Array[] = [];
  let offset = 12;
  let changed = false;
  while (offset + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const end = offset + 8 + size + (size % 2);
    if (offset + 8 + size > bytes.length) return { bytes, changed: false, failed: true };
    const fourcc = ascii(bytes, offset, 4);
    if (fourcc === "EXIF" || fourcc === "XMP ") changed = true;
    else if (fourcc === "VP8X") {
      const chunk = bytes.slice(offset, Math.min(end, bytes.length));
      chunk[8] = chunk[8]! & ~0x0c; // clear the EXIF (0x08) and XMP (0x04) flags
      parts.push(chunk);
    } else parts.push(bytes.subarray(offset, Math.min(end, bytes.length)));
    offset = end;
  }
  if (!changed) return { bytes, changed: false };
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12), 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return { bytes: out, changed: true };
}

/** Thrown when a photo still carries location data and could not be cleaned; the upload is refused. */
export class LocationStripError extends Error {
  constructor(readonly fileName: string) {
    super(`The location in “${fileName}” could not be removed, so it was not uploaded`);
    this.name = "LocationStripError";
  }
}

/** Re-encodes an image through a canvas (no metadata survives; the orientation is applied). */
async function reencodeJpeg(file: File): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The file to upload: a JPEG, PNG, or WebP without its location (same name, type, and modified
 * time), or the same file when there is nothing to strip, the type is not one of those (HEIC is not
 * stripped), or it is larger than STRIP_MAX_BYTES. A JPEG that cannot be walked but still holds EXIF
 * or XMP is re-encoded; when even that fails it throws LocationStripError.
 */
export async function stripImageLocation(file: File): Promise<File> {
  if (file.size > STRIP_MAX_BYTES) return file;
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  } catch {
    return file;
  }
  const strip = isJpeg(head) ? stripJpegMetadata : isPng(head) ? stripPngMetadata : isWebp(head) ? stripWebpMetadata : null;
  if (!strip) return file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = strip(bytes);
  const rebuilt = (out: Uint8Array, type = file.type) => new File([out as BlobPart], file.name, { type: type || "application/octet-stream", lastModified: file.lastModified });
  if (result.changed) return rebuilt(result.bytes);
  if (result.failed && hasLocationMetadata(bytes)) {
    const reencoded = strip === stripJpegMetadata ? await reencodeJpeg(file) : null;
    if (reencoded) return rebuilt(reencoded, "image/jpeg");
    throw new LocationStripError(file.name);
  }
  return file;
}
