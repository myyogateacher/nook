import { createHash } from "node:crypto";
import { db, type DocumentRow } from "../db";
import { DocumentIntegrityError, openObjectForRead } from "../documentStorage";
import { StorageUnavailableError } from "../objectStore";
import { AttachmentError, linkAttachment } from "../attachments/service";
import { CHAT_IMAGE_BOUNDS, isChatImageType, type ChatAttachment, type ChatAttachmentInput } from "../../shared/agents";
import { imageTypeOf } from "./images";
import type { ChatTurn, ContentPart } from "./loop";
import type { MessageRow } from "./chats";
import { AgentError } from "./status";

/**
 * Images in the chat composer (uploads everywhere U5; D404 as decided by the operator, Q10, Q11).
 *
 * - **What**: PNG, JPEG, GIF, and WebP files the sender owns, sniffed on upload and again when read
 *   (never SVG, never a declared type). PDFs and every other file are refused (`NOT_AN_IMAGE`) until a
 *   text extractor exists. At most `CHAT_IMAGE_BOUNDS.perMessage` (5) per message.
 * - **Who sees them**: only models an admin marked vision-capable on the provider (Settings → AI;
 *   `compat_json.vision`). Sending images to any other model is refused (`VISION_REQUIRED`) before
 *   anything is stored; history images under a model that lost the mark are replaced by a note.
 * - **Links**: the user message is an attachment host (`chat_message`, U0's registry): the owner, and
 *   people the chat is shared with while the message is on the branch they see. Never guests, never
 *   the public page. Links are made in the same transaction as the message (U0 `linkAttachment`).
 * - **Bytes**: read through the document store (`openObjectForRead`, the path the S3 layer replaces),
 *   checked against the stored size and SHA-256 and re-sniffed, then sent as `image_url` parts with a
 *   base64 data URL. Each image is at most `chatImageLimits.bytes` (5 MiB: the browser downscales
 *   larger photos before upload; the server never re-encodes, D20); a model call carries at most
 *   `chatImageLimits.requestBytes` (20 MiB) of images, newest first, older ones replaced by a note.
 * - **Audit**: ids and counts only, never bytes or names.
 */

/** The live limits, on an object so tests can lower them (the test upload cap is 4 MiB). */
export const chatImageLimits: { perMessage: number; bytes: number; requestBytes: number } = { perMessage: CHAT_IMAGE_BOUNDS.perMessage, bytes: CHAT_IMAGE_BOUNDS.bytes, requestBytes: CHAT_IMAGE_BOUNDS.requestBytes };

export const VISION_REQUIRED_TEXT = "This agent's model can't see images. Ask an admin to mark it vision-capable in Settings → AI → Model providers, or send text only";
export const NOT_AN_IMAGE_TEXT = "Only images (PNG, JPEG, GIF, or WebP) can be sent in a chat for now; PDFs and other files are not";

type ImageDocument = Pick<DocumentRow, "id" | "owner_id" | "name" | "mime_type" | "preview_kind" | "size_bytes" | "sha256">;

/**
 * Checks the images of a message before anything is written (the send route): the count, the model's
 * vision mark, and each document (the sender's own, live, an image, within the size cap). Throws the
 * AgentError the route answers; returns the de-duplicated inputs in order.
 */
export function checkChatAttachments(userId: string, inputs: readonly ChatAttachmentInput[], vision: boolean): ChatAttachmentInput[] {
  const unique: ChatAttachmentInput[] = [];
  for (const input of inputs) {
    const id = input.documentId.toLowerCase();
    const seen = unique.find((item) => item.documentId === id);
    if (seen) { seen.confirmed ||= input.confirmed === true; continue; }
    unique.push({ documentId: id, confirmed: input.confirmed === true });
  }
  if (unique.length === 0) return unique;
  if (unique.length > chatImageLimits.perMessage) throw new AgentError(400, "TOO_MANY_ATTACHMENTS", `A message can carry at most ${chatImageLimits.perMessage} images`, { limit: chatImageLimits.perMessage });
  if (!vision) throw new AgentError(409, "VISION_REQUIRED", VISION_REQUIRED_TEXT);
  for (const input of unique) {
    // The sender's own live Files document; anyone else's is the same 404 as a missing one (T341).
    const row = db.query("SELECT id, owner_id, name, mime_type, preview_kind, size_bytes, sha256 FROM documents WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND purpose = 'file' AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = documents.id)")
      .get(input.documentId, userId) as ImageDocument | null;
    if (!row) throw new AgentError(404, "NOT_FOUND", "File not found", { documentId: input.documentId });
    if (row.preview_kind !== "image" || !isChatImageType(row.mime_type)) throw new AgentError(415, "NOT_AN_IMAGE", NOT_AN_IMAGE_TEXT, { documentId: input.documentId });
    if (row.size_bytes > chatImageLimits.bytes) throw new AgentError(413, "IMAGE_TOO_LARGE", `An image can be at most ${Math.round(chatImageLimits.bytes / 1024 / 1024)} MiB`, { documentId: input.documentId, limit: chatImageLimits.bytes });
  }
  return unique;
}

/**
 * Links the checked images to the new user message (inside the send transaction, after the message
 * row exists). U0's `linkAttachment` re-checks ownership and the 5-per-message cap; a Files item
 * outside the Attachments folder needs `confirmed` (409 CONFIRM_REQUIRED), as everywhere else.
 */
export function linkChatAttachments(userId: string, messageId: string, inputs: readonly ChatAttachmentInput[]) {
  for (const input of inputs) {
    try {
      linkAttachment(userId, "chat_message", messageId, { documentId: input.documentId, confirmed: input.confirmed === true });
    } catch (error) {
      if (error instanceof AttachmentError) throw new AgentError(error.status, error.code, error.message, { ...error.details, documentId: input.documentId });
      throw error;
    }
  }
}

type LinkedRow = { host_id: string; document_id: string; position: number; owner_id: string | null; name: string | null; mime_type: string | null; size_bytes: number | null; deleted_at: string | null };

/** The links of these messages, in order, with their documents (purged ones are gone with their link). */
function linkedRows(messageIds: readonly string[]): LinkedRow[] {
  if (messageIds.length === 0) return [];
  const rows: LinkedRow[] = [];
  // In slices: SQLite's parameter limit.
  for (let start = 0; start < messageIds.length; start += 500) {
    const slice = messageIds.slice(start, start + 500);
    const marks = slice.map(() => "?").join(",");
    rows.push(...db.query(`SELECT l.host_id, l.document_id, l.position, d.owner_id, d.name, d.mime_type, d.size_bytes, d.deleted_at
      FROM attachment_links l JOIN documents d ON d.id = l.document_id
      WHERE l.host_kind = 'chat_message' AND l.host_id IN (${marks}) ORDER BY l.position, l.created_at, l.document_id`).all(...slice) as LinkedRow[]);
  }
  return rows;
}

/**
 * The images of each message, as the chat shows them. The caller has already limited `messageIds` to
 * what the reader may see (the owner: every message; people it is shared with: the active branch).
 */
export function chatAttachmentsFor(messageIds: readonly string[]): Map<string, ChatAttachment[]> {
  const map = new Map<string, ChatAttachment[]>();
  for (const row of linkedRows(messageIds)) {
    const list = map.get(row.host_id) ?? [];
    list.push(row.deleted_at !== null ? { documentId: row.document_id, removed: true } : { documentId: row.document_id, removed: false, name: row.name ?? "", mimeType: row.mime_type ?? "", sizeBytes: row.size_bytes ?? 0 });
    map.set(row.host_id, list);
  }
  return map;
}

/** How many live images each message carries (the window's budget counts them). */
export function imageCountsFor(messageIds: readonly string[], ownerId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of linkedRows(messageIds)) if (row.deleted_at === null && row.owner_id === ownerId) counts.set(row.host_id, (counts.get(row.host_id) ?? 0) + 1);
  return counts;
}

/**
 * Copies a chat's image links onto the copied messages (Continue as a copy), for documents the copier
 * owns: the owner continuing their own chat keeps the images; someone the chat is shared with gets the
 * text only (the plan's fork rule: links are never made to someone else's file, T341). Returns how
 * many images were linked and how many were left behind. Inside the fork's transaction.
 */
export function copyChatAttachments(userId: string, messageIds: ReadonlyMap<string, string>): { linked: number; skipped: number } {
  let linked = 0;
  let skipped = 0;
  for (const row of linkedRows([...messageIds.keys()])) {
    const target = messageIds.get(row.host_id);
    if (!target) continue;
    if (row.deleted_at !== null || row.owner_id !== userId) { skipped += 1; continue; }
    linkAttachment(userId, "chat_message", target, { documentId: row.document_id, confirmed: true });
    linked += 1;
  }
  return { linked, skipped };
}

/** One image read for a model call, or why it could not be. */
async function readImage(documentId: string, ownerId: string): Promise<{ mimeType: string; base64: string; bytes: number } | null> {
  const row = db.query("SELECT id, owner_id, name, mime_type, preview_kind, size_bytes, sha256 FROM documents WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
    .get(documentId, ownerId) as ImageDocument | null;
  if (!row || row.size_bytes > chatImageLimits.bytes || !isChatImageType(row.mime_type)) return null;
  let bytes: Uint8Array;
  try {
    bytes = await (await openObjectForRead(row.id, row.size_bytes)).bytes();
  } catch (error) {
    if (error instanceof DocumentIntegrityError) return null;
    // S3 storage: an unreachable store omits the picture from this turn (counted as omitted), never fails the run.
    if (error instanceof StorageUnavailableError) {
      console.warn(`Chat image omitted: file storage unavailable (${error.code})`);
      return null;
    }
    throw error;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) return null;
  const mimeType = imageTypeOf(bytes);
  if (!mimeType) return null;
  return { mimeType, base64: Buffer.from(bytes).toString("base64"), bytes: bytes.byteLength };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export type ImageTurnStats = { sent: number; omitted: number; bytes: number };

/**
 * Turns the window's user turns that carry images into content-part turns (U5): the text part, then
 * one `image_url` part per image (a base64 data URL). Newest messages first, within
 * `chatImageLimits.requestBytes`; images past it, removed ones, and all of them when the model is not
 * vision-capable become a bracketed note the model reads instead. `entries` pairs each turn with its
 * message id (null for the system turn).
 */
export async function withImageParts(entries: ReadonlyArray<{ turn: ChatTurn; messageId: string | null }>, ownerId: string, vision: boolean): Promise<{ turns: ChatTurn[]; stats: ImageTurnStats }> {
  const ids = entries.flatMap((entry) => entry.messageId && entry.turn.role === "user" ? [entry.messageId] : []);
  const byMessage = new Map<string, LinkedRow[]>();
  for (const row of linkedRows(ids)) byMessage.set(row.host_id, [...(byMessage.get(row.host_id) ?? []), row]);
  const stats: ImageTurnStats = { sent: 0, omitted: 0, bytes: 0 };
  const out: ChatTurn[] = entries.map((entry) => entry.turn);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const rows = entry.messageId ? byMessage.get(entry.messageId) : undefined;
    if (!rows || rows.length === 0 || entry.turn.role !== "user") continue;
    const text = typeof entry.turn.content === "string" ? entry.turn.content : "";
    const parts: ContentPart[] = [];
    const notes: string[] = [];
    let unavailable = 0;
    let overBudget = 0;
    let unseen = 0;
    for (const row of rows) {
      if (!vision) { unseen += 1; continue; }
      if (row.deleted_at !== null || row.owner_id !== ownerId) { unavailable += 1; continue; }
      if ((row.size_bytes ?? 0) + stats.bytes > chatImageLimits.requestBytes) { overBudget += 1; continue; }
      const image = await readImage(row.document_id, ownerId);
      if (!image) { unavailable += 1; continue; }
      if (image.bytes + stats.bytes > chatImageLimits.requestBytes) { overBudget += 1; continue; }
      stats.bytes += image.bytes;
      stats.sent += 1;
      parts.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } });
    }
    if (unseen) notes.push(`[The person attached ${plural(unseen, "image", "images")} here; this model cannot see images, so ${unseen === 1 ? "it was" : "they were"} not sent.]`);
    if (unavailable) notes.push(`[${plural(unavailable, "image", "images")} the person attached here ${unavailable === 1 ? "is" : "are"} no longer available.]`);
    if (overBudget) notes.push(`[${plural(overBudget, "earlier image was", "earlier images were")} left out to keep the request small.]`);
    stats.omitted += unseen + unavailable + overBudget;
    const fullText = [text, ...notes].filter(Boolean).join("\n");
    if (parts.length === 0) {
      out[index] = { role: "user", content: fullText };
      continue;
    }
    out[index] = { role: "user", content: [...(fullText ? [{ type: "text" as const, text: fullText }] : []), ...parts] };
  }
  return { turns: out, stats };
}
