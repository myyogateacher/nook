import { Readable } from "node:stream";
import * as z from "zod/v4";
import { config } from "./config";
import { db, ensureDefaultFolder, withAuditContext } from "./db";
import { ownedDocumentSummary } from "./documentAccess";
import { DocumentPatchError, patchDocument, storedBytes, storeRawUpload, type StoreRawOptions } from "./documents";
import { defineTool, McpToolError, notFound, type McpErrorCode, type McpKeyContext, type McpToolSpec } from "./mcpToolKit";
import { sanitizeDisplayName } from "./validation";

/**
 * Wave 19 file writes over MCP (docs/plan/WAVES_18-20_SMALL.md D176, D177, T146, T147), all
 * `files:write`: store a text file inline, upload a binary through a one-time ticket
 * (begin_upload → PUT /mcp/uploads/:id with the same Bearer key → finish_upload; there is no base64
 * path), and rename or move the key owner's own Files documents. Uploads land private (an owned
 * folder or Default, or as an unlinked card attachment) and go through the web upload's pipeline:
 * sniffing, quota, free disk, the T80 block re-check, and the audit row with `{via: "mcp", keyId}`.
 */

export const MCP_TEXT_FILE_MAX_BYTES = 1_048_576;
export const UPLOAD_TICKET_TTL_MS = 15 * 60_000;
export const OPEN_TICKETS_PER_KEY = 3;
export const DAILY_UPLOAD_BYTES_PER_USER = 1_073_741_824;

type Purpose = "file" | "task_attachment";
export type UploadTicket = {
  id: string; keyId: string; userId: string; name: string; sizeBytes: number; sha256: string; folderId: string | null; purpose: Purpose;
  expiresAt: number;
  state: "pending" | "receiving" | "committed" | "failed";
  documentId?: string;
  failure?: { code: McpErrorCode; message: string };
};

const tickets = new Map<string, UploadTicket>();

/** Tickets are kept for a grace period after they expire, so finish_upload can still say UPLOAD_EXPIRED. */
function sweepTickets(time = Date.now()) {
  for (const [id, ticket] of tickets) if (ticket.expiresAt + UPLOAD_TICKET_TTL_MS < time) tickets.delete(id);
}

export const uploadTicket = (id: string) => {
  sweepTickets();
  return tickets.get(id) ?? null;
};
export const ticketExpired = (ticket: UploadTicket, time = Date.now()) => ticket.state !== "committed" && ticket.expiresAt <= time;

/** Test hook: forget every ticket and byte budget (what a restart does). */
export function resetUploadTickets() {
  tickets.clear();
  dailyBytes.clear();
}

/** Test hook: move a ticket's expiry. */
export function expireUploadTicketForTests(id: string) {
  const ticket = tickets.get(id);
  if (ticket) ticket.expiresAt = Date.now() - 1;
}

// The per-user upload byte budget (in memory, charged at commit). An open ticket reserves its
// sizeBytes until it commits, fails, or expires, so open tickets cannot overshoot the budget (L3).
const dailyBytes = new Map<string, { bytes: number; resetAt: number }>();
function budget(userId: string, time = Date.now()) {
  let entry = dailyBytes.get(userId);
  if (!entry || entry.resetAt <= time) {
    entry = { bytes: 0, resetAt: time + 86_400_000 };
    dailyBytes.set(userId, entry);
  }
  return entry;
}
export const chargeUploadBytes = (userId: string, bytes: number) => { budget(userId).bytes += bytes; };
/** Bytes held by the user's open (pending or receiving, unexpired) tickets, except `exceptId`. */
function reservedBytes(userId: string, exceptId?: string, time = Date.now()) {
  let bytes = 0;
  for (const ticket of tickets.values()) {
    if (ticket.userId !== userId || ticket.id === exceptId) continue;
    if ((ticket.state === "pending" || ticket.state === "receiving") && !ticketExpired(ticket, time)) bytes += ticket.sizeBytes;
  }
  return bytes;
}
const budgetLeft = (userId: string, exceptTicketId?: string) => DAILY_UPLOAD_BYTES_PER_USER - budget(userId).bytes - reservedBytes(userId, exceptTicketId);
const budgetError = () => new McpToolError("RATE_LIMITED", "The daily upload volume for this account is used up. Try again tomorrow.");

/**
 * The commit-time re-check for a ticket: its bytes must still fit the budget next to what was
 * charged and what the user's other open tickets hold. Null when it fits.
 */
export function ticketBudgetError(ticket: UploadTicket) {
  return ticket.sizeBytes > budgetLeft(ticket.userId, ticket.id) ? budgetError() : null;
}

/** Folder for a new upload: an owned folder, or Default for Files; none for an attachment. */
function uploadFolder(userId: string, purpose: Purpose, folderId: string | undefined) {
  if (purpose === "task_attachment") {
    if (folderId) throw new McpToolError("INVALID", "Attachments have no folder");
    return null;
  }
  if (!folderId) return ensureDefaultFolder(userId);
  if (!db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(folderId, userId)) throw notFound("Folder");
  return folderId;
}

function uploadName(name: string) {
  const cleaned = sanitizeDisplayName(name, "upload");
  if (!cleaned) throw new McpToolError("INVALID", "Give a file name of 1 to 255 bytes that is not . or ..");
  return cleaned;
}

function quotaCheck(userId: string, bytes: number) {
  const quota = config.userStorageQuotaBytes;
  if (quota > 0 && storedBytes(userId) + bytes > quota) throw new McpToolError("QUOTA_EXCEEDED", "Storage quota exceeded");
  if (bytes > budgetLeft(userId)) throw budgetError();
}

/** A web upload status and body as an MCP error. */
export function uploadErrorToMcp(status: number, body: Record<string, unknown>) {
  const code = typeof body.code === "string" ? body.code : "";
  const message = typeof body.error === "string" ? body.error : "The upload failed";
  const mapped: McpErrorCode = code === "HASH_MISMATCH" ? "HASH_MISMATCH"
    : status === 507 ? "QUOTA_EXCEEDED"
    : status === 413 ? "TOO_LARGE"
    : status === 404 ? "NOT_FOUND"
    : status === 429 ? "RATE_LIMITED"
    : status === 401 ? "SCOPE_REQUIRED"
    : status === 409 ? "LIMIT_REACHED"
    : "INVALID";
  return new McpToolError(mapped, message, code ? { reason: code } : undefined);
}

/** Stores through the web pipeline as the key's owner, audited with the key. */
export async function storeForKey(key: Pick<McpKeyContext, "keyId" | "userId">, source: Readable, options: StoreRawOptions, signal?: AbortSignal) {
  const result = await withAuditContext({ via: "mcp", keyId: key.keyId }, () => storeRawUpload(source, options, signal));
  if (result.status === 200 || result.status === 201) {
    const document = result.body.document as { id: string; size_bytes: number };
    if (result.status === 201) chargeUploadBytes(key.userId, document.size_bytes);
  }
  return result;
}

const uuid = z.string().uuid();
const sha256Hex = z.string().regex(/^[0-9a-fA-F]{64}$/, "sha256 is 64 hex characters");
const purposeInput = z.enum(["file", "task_attachment"]).optional().describe("file (default): a Files document in folderId or Default. task_attachment: no folder, for link_attachment");

function patchErrorToMcp(error: DocumentPatchError) {
  if (error.code === "AUDIENCE_CHANGE") return new McpToolError("AUDIENCE_CHANGE", error.message);
  return new McpToolError(error.status === 404 ? "NOT_FOUND" : "INVALID", error.message);
}

export const fileWriteTools: McpToolSpec[] = [
  defineTool({
    name: "create_text_file",
    title: "Store a text file",
    description: `Store UTF-8 text (up to ${MCP_TEXT_FILE_MAX_BYTES} bytes, for example Markdown, CSV, or JSON) as a new private file in a folder the user owns (default: Default), or as a card attachment for link_attachment. Use a name with an extension such as .md, .csv, .json, or .txt. For binary files use begin_upload.`,
    scopes: ["files:write"],
    access: { mode: "items", items: [{ arg: "folderId", kind: "folder" }] },
    write: true,
    buckets: ["file_write"],
    inputSchema: z.object({
      name: z.string().min(1).max(255),
      text: z.string(),
      folderId: uuid.optional(),
      purpose: purposeInput
    }).strict(),
    handler: async ({ name, text, folderId, purpose }, key) => {
      // A lone surrogate is the one way a JS string can fail to be valid UTF-8.
      if (text.includes("\u0000") || /\p{Cs}/u.test(text)) throw new McpToolError("INVALID", "text must be valid UTF-8 without NUL characters");
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > MCP_TEXT_FILE_MAX_BYTES) throw new McpToolError("TOO_LARGE", `Text files are limited to ${MCP_TEXT_FILE_MAX_BYTES} bytes here; use begin_upload for larger files`);
      const cleanName = uploadName(name);
      const kind = purpose ?? "file";
      const folder = uploadFolder(key.userId, kind, folderId);
      quotaCheck(key.userId, bytes.byteLength);
      const result = await storeForKey(key, Readable.from([bytes]), { userId: key.userId, name: cleanName, folderId: folder, purpose: kind, uploadKey: null, expectedBytes: bytes.byteLength });
      if (result.status !== 201) throw uploadErrorToMcp(result.status, result.body);
      return { document: result.body.document };
    }
  }),
  defineTool({
    name: "begin_upload",
    title: "Begin a file upload",
    description: `Start uploading a file of sizeBytes (up to ${config.maxUploadBytes} bytes) whose SHA-256 is sha256 (hex). Returns an uploadUrl: send the raw bytes with HTTP PUT to it, with this same API key as Authorization: Bearer, Content-Type: application/octet-stream, and Content-Length: sizeBytes. Then call finish_upload with the uploadId. The ticket works once and expires after 15 minutes; at most ${OPEN_TICKETS_PER_KEY} are open per key. The file is private (a folder the user owns, or Default), or a card attachment for link_attachment.`,
    scopes: ["files:write"],
    access: { mode: "items", items: [{ arg: "folderId", kind: "folder" }] },
    write: true,
    buckets: ["file_write"],
    inputSchema: z.object({
      name: z.string().min(1).max(255),
      sizeBytes: z.number().int().min(0),
      sha256: sha256Hex,
      folderId: uuid.optional(),
      purpose: purposeInput
    }).strict(),
    handler: ({ name, sizeBytes, sha256, folderId, purpose }, key) => {
      sweepTickets();
      if (sizeBytes > config.maxUploadBytes) throw new McpToolError("TOO_LARGE", `Files are limited to ${config.maxUploadBytes} bytes`);
      const open = [...tickets.values()].filter((ticket) => ticket.keyId === key.keyId && (ticket.state === "pending" || ticket.state === "receiving") && !ticketExpired(ticket)).length;
      if (open >= OPEN_TICKETS_PER_KEY) throw new McpToolError("LIMIT_REACHED", `At most ${OPEN_TICKETS_PER_KEY} uploads can be open per key. Finish one first.`);
      const cleanName = uploadName(name);
      const kind = purpose ?? "file";
      const folder = uploadFolder(key.userId, kind, folderId);
      // The storage quota is advisory here; the byte budget counts other open tickets, and the new
      // ticket then reserves sizeBytes. Both are checked again at commit.
      quotaCheck(key.userId, sizeBytes);
      const id = crypto.randomUUID();
      const expiresAt = Date.now() + UPLOAD_TICKET_TTL_MS;
      tickets.set(id, { id, keyId: key.keyId, userId: key.userId, name: cleanName, sizeBytes, sha256: sha256.toLowerCase(), folderId: folder, purpose: kind, expiresAt, state: "pending" });
      return {
        uploadId: id,
        uploadUrl: `${config.appOrigin}/mcp/uploads/${id}`,
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(sizeBytes) },
        expiresAt: new Date(expiresAt).toISOString()
      };
    }
  }),
  defineTool({
    name: "finish_upload",
    title: "Finish a file upload",
    description: "Get the stored file of an upload started with begin_upload, once its PUT has succeeded. UPLOAD_PENDING while the bytes have not arrived, UPLOAD_EXPIRED after 15 minutes, HASH_MISMATCH when the bytes did not match sha256 (nothing was stored).",
    scopes: ["files:write"],
    access: { mode: "own", related: ["uploadId"] },
    write: false,
    inputSchema: z.object({ uploadId: uuid }).strict(),
    handler: ({ uploadId }, key) => {
      const ticket = uploadTicket(uploadId.toLowerCase());
      if (!ticket || ticket.keyId !== key.keyId) throw notFound("Upload");
      if (ticket.state === "committed") {
        tickets.delete(ticket.id);
        const document = ownedDocumentSummary(ticket.documentId!, key.userId);
        if (!document) throw notFound("File");
        return { document };
      }
      if (ticket.state === "failed") {
        tickets.delete(ticket.id);
        throw new McpToolError(ticket.failure!.code, ticket.failure!.message);
      }
      if (ticketExpired(ticket)) {
        tickets.delete(ticket.id);
        throw new McpToolError("UPLOAD_EXPIRED", "The upload ticket expired before the file arrived. Start again with begin_upload.");
      }
      throw new McpToolError("UPLOAD_PENDING", "The file has not been received yet. PUT it to the uploadUrl first.");
    }
  }),
  defineTool({
    name: "rename_file",
    title: "Rename a file",
    description: "Rename a Files document the user owns. Sharing does not change.",
    scopes: ["files:write"],
    access: { mode: "items", items: [{ arg: "documentId", kind: "document" }] },
    write: true,
    buckets: ["structure_write"],
    inputSchema: z.object({ documentId: uuid, name: z.string().min(1).max(1024) }).strict(),
    handler: async ({ documentId, name }, key) => {
      try {
        return { document: await withAuditContext({ via: "mcp", keyId: key.keyId }, () => patchDocument(key.userId, documentId.toLowerCase(), { name })) };
      } catch (error) {
        if (error instanceof DocumentPatchError) throw patchErrorToMcp(error);
        throw error;
      }
    }
  }),
  defineTool({
    name: "move_file",
    title: "Move a file",
    description: "Move a Files document the user owns into another folder they own. Refuses moves that would change who can see the file (AUDIENCE_CHANGE): a file that follows its folder's sharing can only move between folders shared with the same people. A file with its own sharing moves freely.",
    scopes: ["files:write"],
    access: { mode: "items", items: [{ arg: "documentId", kind: "document" }, { arg: "folderId", kind: "folder" }] },
    write: true,
    buckets: ["structure_write"],
    inputSchema: z.object({ documentId: uuid, folderId: uuid }).strict(),
    handler: async ({ documentId, folderId }, key) => {
      try {
        return { document: await withAuditContext({ via: "mcp", keyId: key.keyId }, () => patchDocument(key.userId, documentId.toLowerCase(), { folderId: folderId.toLowerCase() }, { refuseAudienceChange: true })) };
      } catch (error) {
        if (error instanceof DocumentPatchError) throw patchErrorToMcp(error);
        throw error;
      }
    }
  })
];
