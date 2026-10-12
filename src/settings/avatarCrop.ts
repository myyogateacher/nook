import { api } from "../api";

/**
 * The profile picture editor's pure parts (uploads everywhere U7): the square crop, its zoom and pan,
 * the 512 px re-encode, and the API calls. The picture is drawn onto a canvas and encoded again, so
 * nothing from the original file (EXIF location, camera, XMP) survives; the server still sniffs it.
 */

/** The longest side the web uploads (a square of this size or smaller). */
export const AVATAR_OUTPUT_SIZE = 512;
/** The server's cap (server/avatars.ts AVATAR_MAX_BYTES). */
export const AVATAR_UPLOAD_MAX_BYTES = 1_048_576;
/** Files larger than this are not opened at all (a phone photo is a few MB). */
export const AVATAR_SOURCE_MAX_BYTES = 40 * 1_048_576;
export const AVATAR_MAX_ZOOM = 4;

/** Where the square sits: `zoom` 1 is the largest square that fits; the centre is in source pixels. */
export type Crop = { zoom: number; centerX: number; centerY: number };
export type CropRect = { x: number; y: number; side: number };

/** The largest centred square at zoom 1. */
export const initialCrop = (width: number, height: number): Crop => ({ zoom: 1, centerX: width / 2, centerY: height / 2 });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The zoom kept within 1–AVATAR_MAX_ZOOM and the square kept inside the picture. */
export function clampCrop(width: number, height: number, crop: Crop): Crop {
  const zoom = clamp(Number.isFinite(crop.zoom) ? crop.zoom : 1, 1, AVATAR_MAX_ZOOM);
  const half = Math.min(width, height) / zoom / 2;
  return { zoom, centerX: clamp(crop.centerX, half, width - half), centerY: clamp(crop.centerY, half, height - half) };
}

/** The source square a crop selects, in source pixels. */
export function cropRect(width: number, height: number, crop: Crop): CropRect {
  const clamped = clampCrop(width, height, crop);
  const side = Math.min(width, height) / clamped.zoom;
  return { x: clamped.centerX - side / 2, y: clamped.centerY - side / 2, side };
}

/** Dragging the picture by (dx, dy) screen pixels in a stage `stage` pixels wide moves the square the other way. */
export function panCrop(width: number, height: number, crop: Crop, dx: number, dy: number, stage: number): Crop {
  const scale = cropRect(width, height, crop).side / Math.max(1, stage);
  return clampCrop(width, height, { ...crop, centerX: crop.centerX - dx * scale, centerY: crop.centerY - dy * scale });
}

/** A new zoom about the current centre. */
export const zoomCrop = (width: number, height: number, crop: Crop, zoom: number) => clampCrop(width, height, { ...crop, zoom });

/** The output square's side: AVATAR_OUTPUT_SIZE, never larger than the selected source (no upscaling). */
export const outputSide = (rect: CropRect, max = AVATAR_OUTPUT_SIZE) => Math.max(1, Math.min(max, Math.round(rect.side)));

export type DecodedPicture = { source: CanvasImageSource; width: number; height: number; close: () => void };

export class AvatarPictureError extends Error {}

/**
 * Never SVG or another text format (the server refuses them anyway; drawing one would run nothing,
 * but a vector picture is not what the picker offers): an image type, and bytes that do not start
 * like markup. Phone formats the browser can decode (HEIC on Safari) pass and are re-encoded.
 */
export async function looksLikeRasterPicture(file: Blob & { name?: string }) {
  if (file.type && (!file.type.startsWith("image/") || file.type.includes("svg"))) return false;
  if (file.name && /\.svgz?$/i.test(file.name)) return false;
  const head = new TextDecoder("latin1").decode(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  return !/^[\s﻿]*</.test(head);
}

/** Opens a picked file as a drawable picture, upright (EXIF orientation applied by the browser). */
export async function decodePicture(file: File): Promise<DecodedPicture> {
  if (file.size > AVATAR_SOURCE_MAX_BYTES) throw new AvatarPictureError("That picture is too large to open. Choose one under 40 MB.");
  if (!await looksLikeRasterPicture(file)) throw new AvatarPictureError("Choose a PNG, JPEG, or WebP picture.");
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    // Older Safari: an <img> from an object URL (it applies the orientation too).
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("empty");
      return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined };
    } catch {
      throw new AvatarPictureError("This picture could not be opened. Choose a PNG, JPEG, or WebP picture.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

type CanvasLike = { width: number; height: number; getContext(type: "2d"): CanvasRenderingContext2D | null; toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void };

const toBlob = (canvas: CanvasLike, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Draws the selected square at `outputSide` and encodes it as WebP (JPEG where the browser cannot
 * write WebP), stepping the quality down until it fits the server's cap.
 */
export async function renderAvatar(picture: Pick<DecodedPicture, "source" | "width" | "height">, crop: Crop, makeCanvas: () => CanvasLike = () => document.createElement("canvas")): Promise<Blob> {
  const rect = cropRect(picture.width, picture.height, crop);
  const side = outputSide(rect);
  const canvas = makeCanvas();
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) throw new AvatarPictureError("This browser could not prepare the picture.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(picture.source, rect.x, rect.y, rect.side, rect.side, 0, 0, side, side);
  for (const quality of [0.9, 0.8, 0.65]) {
    let blob = await toBlob(canvas, "image/webp", quality);
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality);
    if (blob && blob.size <= AVATAR_UPLOAD_MAX_BYTES) return blob;
  }
  throw new AvatarPictureError("The picture could not be made small enough. Try another one.");
}

/** Base64 of the bytes, in chunks (String.fromCharCode has an argument limit). */
export async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export type AvatarSource = "upload" | "google" | "none";
export type AvatarState = { avatarUrl: string | null; source: AvatarSource; google: { linked: boolean; hasPicture: boolean } };

export const loadAvatarState = () => api<AvatarState>("/me/avatar");
export const changeAvatar = (body: { source: "upload"; image: string } | { source: "google" } | { source: "none" }) => api<AvatarState>("/me/avatar", { method: "PUT", body: JSON.stringify(body) });

/** The line under the picture in Settings. */
export function avatarSourceLine(state: Pick<AvatarState, "source"> | null) {
  if (!state) return "Loading…";
  if (state.source === "upload") return "A picture you uploaded.";
  if (state.source === "google") return "Your Google picture. It follows Google when you sign in with Google.";
  return "No picture: your initial is shown.";
}
