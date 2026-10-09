/**
 * Photo location stripping before upload (uploads everywhere plan D401, operator decision Q9, T349).
 *
 * Every JPEG the attach kit uploads is rewritten as a pure byte operation, with no re-encode and no
 * dependency: the EXIF APP1 segment (GPS position, camera serial, and the rest) is replaced by a
 * minimal EXIF block that keeps only the Orientation tag, so phone photos still display upright; XMP
 * APP1 segments and Photoshop/IPTC APP13 segments (which can also carry places) are removed. The
 * compressed image data from the first SOS marker on is copied unchanged. Anything that is not a
 * well-formed JPEG comes back untouched. The server never rewrites bytes (an upload's SHA-256 must
 * match what the client sent), so files uploaded by other means (MCP, the Files app) keep their EXIF.
 */

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;
const APP13 = 0xed;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const ORIENTATION_TAG = 0x0112;

export const isJpeg = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === SOI && bytes[2] === 0xff;

const startsWith = (bytes: Uint8Array, offset: number, prefix: readonly number[]) => prefix.every((value, index) => bytes[offset + index] === value);

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
  // "Exif\0\0" + TIFF header (II*\0, IFD0 at 8) + IFD0 with one SHORT entry + next-IFD 0.
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

/**
 * Removes location-bearing metadata from a JPEG (see the file comment). Returns the same array when
 * nothing needed removing or the bytes are not a JPEG it can walk safely.
 */
export function stripJpegMetadata(bytes: Uint8Array): { bytes: Uint8Array; changed: boolean } {
  if (!isJpeg(bytes)) return { bytes, changed: false };
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let changed = false;
  let orientation: number | null = null;
  let insertAt = -1;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return { bytes, changed: false };
    // Fill bytes before a marker.
    let markerAt = offset;
    while (markerAt + 1 < bytes.length && bytes[markerAt + 1] === 0xff) markerAt += 1;
    const marker = bytes[markerAt + 1];
    if (marker === undefined) return { bytes, changed: false };
    if (marker === SOS || marker === EOI) {
      if (insertAt < 0) insertAt = parts.length;
      parts.push(bytes.subarray(markerAt));
      offset = bytes.length;
      break;
    }
    // Stand-alone markers (TEM, RSTn) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(markerAt, markerAt + 2));
      offset = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > bytes.length) return { bytes, changed: false };
    const length = (bytes[markerAt + 2]! << 8) | bytes[markerAt + 3]!;
    const end = markerAt + 2 + length;
    if (length < 2 || end > bytes.length) return { bytes, changed: false };
    const payload = bytes.subarray(markerAt + 4, end);
    if (marker === APP1 || marker === APP13) {
      if (marker === APP1 && startsWith(payload, 0, EXIF_HEADER)) {
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
  if (!changed) return { bytes, changed: false };
  if (orientation !== null && orientation !== 1) parts.splice(insertAt < 0 ? 1 : insertAt, 0, orientationSegment(orientation));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { bytes: out, changed: true };
}

/**
 * The file to upload: a JPEG without its location (same name, type, and modified time), or the same
 * file when there is nothing to strip. Never throws; an unreadable file is uploaded as it is.
 */
export async function stripImageLocation(file: File): Promise<File> {
  try {
    const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    if (!isJpeg(head)) return file;
    const result = stripJpegMetadata(new Uint8Array(await file.arrayBuffer()));
    if (!result.changed) return file;
    return new File([result.bytes as BlobPart], file.name, { type: file.type || "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  }
}
