import { Readable } from "node:stream";
import { config } from "../config";
import { db, ensureDefaultFolder, now } from "../db";
import { storeRawUpload, storedBytes } from "../documents";
import { purgeOwnedItem } from "../bin";
import { sanitizeDisplayName } from "../validation";
import { canonicalSceneJson, IMAGE_MIME_TYPES, jsonDepth, sceneWithoutImages, validateScene, WHITEBOARD_MAX_DEPTH, WHITEBOARD_MAX_FILES, WHITEBOARD_MAX_SCENE_BYTES, type CanonicalScene } from "../../shared/whiteboardScene";
import { createWhiteboard, unavailableImages, WhiteboardError, whiteboardStoredName } from "./service";

/**
 * Import `.excalidraw` (Wave 24, whiteboard plan §8, T160, T164). The file goes through the same
 * validator as every save. Images embedded as dataURLs are never stored in the scene: each one is
 * decoded, stored as an ordinary File in the board's folder through the upload pipeline (sniffed by
 * content, size-limited, counted toward the quota), and replaced by a reference to that document.
 * Images already referring to Nook files are kept when the importer can open them.
 *
 * The import is all or nothing for what the person asked for: the scene is validated and the quota
 * checked before anything is stored, and if storing an image or creating the board fails, the
 * images stored so far are deleted again.
 */

/** The request body cap: a 4 MiB scene plus embedded images (each also within MAX_UPLOAD_BYTES). */
export const WHITEBOARD_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

const dataUrlPattern = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/\r\n]*={0,2})$/;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Embedded = { fileId: string; mimeType: string; bytes: Uint8Array };

function refuse(code: string, message: string, status: 400 | 413 | 507 = 400): never {
  throw new WhiteboardError(status, code, message);
}

/**
 * Splits an Excalidraw file into its scene (with `files` as Nook references) and the images to
 * store. Pure apart from reading `config.maxUploadBytes`; placeholder ids stand in for the documents.
 */
export function planImport(file: unknown) {
  if (jsonDepth(file, WHITEBOARD_MAX_DEPTH + 1) > WHITEBOARD_MAX_DEPTH + 1) refuse("INVALID_SCENE", "This file is not a drawing Nook can open");
  if (!isPlainObject(file) || file.type !== "excalidraw" || !Array.isArray(file.elements)) refuse("INVALID_SCENE", "This file is not an Excalidraw drawing");
  const rawFiles = isPlainObject(file.files) ? file.files : {};
  const used = new Set(file.elements.flatMap((item) => isPlainObject(item) && item.type === "image" && item.isDeleted !== true && typeof item.fileId === "string" ? [item.fileId] : []));
  if (used.size > WHITEBOARD_MAX_FILES) refuse("INVALID_SCENE", `A whiteboard may hold at most ${WHITEBOARD_MAX_FILES} images`);
  const embedded: Embedded[] = [];
  const references: Record<string, { id: string; mimeType: string; nookDocumentId: string }> = {};
  const missing = new Set<string>();
  for (const fileId of used) {
    const entry = Object.hasOwn(rawFiles, fileId) ? rawFiles[fileId] : undefined;
    if (!isPlainObject(entry)) { missing.add(fileId); continue; }
    if (typeof entry.dataURL === "string") {
      const match = dataUrlPattern.exec(entry.dataURL);
      if (!match) refuse("IMAGE_TYPE_NOT_SUPPORTED", "This drawing has an image Nook can't store. Only PNG, JPEG, GIF, and WebP images can be imported.");
      const bytes = new Uint8Array(Buffer.from(match[2]!.replace(/[\r\n]/g, ""), "base64"));
      if (bytes.byteLength === 0) { missing.add(fileId); continue; }
      if (bytes.byteLength > config.maxUploadBytes) refuse("IMAGE_TOO_LARGE", "An image in this drawing is larger than the upload limit", 413);
      embedded.push({ fileId, mimeType: match[1]!, bytes });
      references[fileId] = { id: fileId, mimeType: match[1]!, nookDocumentId: crypto.randomUUID() };
    } else if (typeof entry.nookDocumentId === "string" && uuidPattern.test(entry.nookDocumentId.toLowerCase()) && typeof entry.mimeType === "string" && (IMAGE_MIME_TYPES as readonly string[]).includes(entry.mimeType)) {
      references[fileId] = { id: fileId, mimeType: entry.mimeType, nookDocumentId: entry.nookDocumentId.toLowerCase() };
    } else {
      missing.add(fileId);
    }
  }
  // Images without any picture data are left out (Excalidraw would draw an empty frame).
  const elements = file.elements.filter((item) => !(isPlainObject(item) && item.type === "image" && typeof item.fileId === "string" && missing.has(item.fileId)));
  const result = validateScene({ type: "excalidraw", version: 2, source: "nook", elements, appState: file.appState, files: references });
  if (!result.ok) refuse(result.code, `This drawing can't be imported: ${result.message}`);
  if (new TextEncoder().encode(canonicalSceneJson(result.scene)).byteLength > WHITEBOARD_MAX_SCENE_BYTES) refuse("SCENE_TOO_LARGE", "This drawing is too large for a whiteboard", 413);
  return { scene: result.scene, embedded, missing: missing.size };
}

function withDocumentIds(scene: CanonicalScene, stored: Map<string, { id: string; mimeType: string }>): CanonicalScene {
  const files: CanonicalScene["files"] = {};
  for (const [key, file] of Object.entries(scene.files)) {
    const document = stored.get(key);
    files[key] = document ? { id: key, mimeType: document.mimeType, nookDocumentId: document.id } : file;
  }
  return { ...scene, files };
}

/** Deletes documents this import stored before it failed (Bin, then purge; never visible for long). */
async function discard(userId: string, ids: string[]) {
  for (const id of ids) {
    const timestamp = now();
    db.query("UPDATE documents SET deleted_at = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").run(timestamp, timestamp, id, userId);
    await purgeOwnedItem("document", id, userId).catch(() => console.error("Could not remove an image of a failed whiteboard import; the Bin keeps it"));
  }
}

/** POST /api/whiteboards/import. */
export async function importWhiteboard(userId: string, input: { name: string; folderId?: string | null; file: unknown }) {
  const boardName = whiteboardStoredName(input.name);
  const folderId = input.folderId ?? ensureDefaultFolder(userId);
  if (!db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(folderId, userId)) throw new WhiteboardError(404, "NOT_FOUND", "Folder not found");
  const plan = planImport(input.file);
  // References to Nook files the importer cannot open are left out, as for a duplicate (T165).
  const foreign = unavailableImages(userId, { files: Object.fromEntries(Object.entries(plan.scene.files).filter(([key]) => !plan.embedded.some((item) => item.fileId === key))) });
  const images = plan.embedded.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  const quota = config.userStorageQuotaBytes;
  if (quota > 0 && storedBytes(userId) + images > quota) refuse("QUOTA_EXCEEDED", "Storage quota exceeded: this drawing's images do not fit", 507);

  const stored = new Map<string, { id: string; mimeType: string }>();
  const displayName = boardName.replace(/\.excalidraw$/i, "");
  try {
    let index = 0;
    for (const item of plan.embedded) {
      index += 1;
      const name = sanitizeDisplayName(`${displayName} image ${index}.${extensions[item.mimeType]}`, "upload") ?? `image ${index}.${extensions[item.mimeType]}`;
      const result = await storeRawUpload(Readable.from([Buffer.from(item.bytes)]), { userId, name, folderId, purpose: "file", uploadKey: null, expectedBytes: item.bytes.byteLength });
      const document = result.body.document as { id: string; mime_type: string; preview_kind: string } | undefined;
      if (result.status !== 201 || !document) {
        if (result.status === 507) refuse("QUOTA_EXCEEDED", "Storage quota exceeded: this drawing's images do not fit", 507);
        if (result.status === 413) refuse("IMAGE_TOO_LARGE", "An image in this drawing is larger than the upload limit", 413);
        refuse("IMAGE_NOT_STORED", "An image in this drawing could not be stored");
      }
      stored.set(item.fileId, { id: document.id, mimeType: document.mime_type });
      // The server's sniff decides what the bytes are, never the file's own label.
      if (document.preview_kind !== "image" || !(IMAGE_MIME_TYPES as readonly string[]).includes(document.mime_type)) {
        refuse("IMAGE_TYPE_NOT_SUPPORTED", "An image in this drawing is not a PNG, JPEG, GIF, or WebP picture");
      }
    }
    const scene = sceneWithoutImages(withDocumentIds(plan.scene, stored), foreign);
    const { whiteboard } = await createWhiteboard(userId, {
      name: boardName, folderId, scene,
      audit: { action: "whiteboard.import", details: { images: stored.size, imagesLeftOut: plan.missing + foreign.size } }
    });
    return { whiteboard, images: stored.size, imagesLeftOut: plan.missing + foreign.size };
  } catch (error) {
    await discard(userId, [...stored.values()].map((document) => document.id));
    throw error;
  }
}
