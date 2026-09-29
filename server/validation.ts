import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { MCP_SCOPES } from "./mcpScopes";

export const uuid = z.string().uuid();
export const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
export const password = z.string().min(12).max(256);

/** A team invite token (D161): 32 random bytes, base64url. It travels in JSON bodies only. */
export const inviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This invite link is not valid");

/** `role` is never accepted: an invite fixes it, otherwise SIGNUP_ROLE or the bootstrap rule does (D163). */
export const registerSchema = z.object({
  email,
  displayName: z.string().trim().min(1).max(80),
  password,
  inviteToken: inviteToken.optional()
}).strict();
export const invitePreviewSchema = z.object({ token: inviteToken }).strict();

export const totpCode = z.string().trim().regex(/^\d{6}$/, "Enter the six-digit authentication code");
export const recoveryCode = z.string().trim().min(10).max(32);
export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(256),
  totpCode: totpCode.optional(),
  recoveryCode: recoveryCode.optional()
}).strict().refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");
export const totpCodeSchema = z.object({ code: totpCode }).strict();
// The password is optional where a fresh Google confirmation of this session can stand in (D297).
const reauthPassword = z.string().min(1).max(256).optional();
export const totpSetupSchema = z.object({ password: reauthPassword }).strict();
export const totpDisableSchema = z.object({ code: totpCode, password: reauthPassword }).strict();
export const totpRecoveryViewSchema = z.object({ code: totpCode, password: reauthPassword }).strict();
export const folderSchema = z.object({ name: z.string().trim().min(1).max(120), parentId: uuid.nullish() }).strict();
export const noteCreateSchema = z.object({ folderId: uuid.nullish() }).strict();
export const noteMetaSchema = z.object({ folderId: uuid.nullish() }).strict();
export const draftSchema = z.object({
  markdown: z.string(),
  revision: z.number().int().nonnegative().nullable()
}).strict();
/** The draft revision the client last saw. Optional only for older clients (see POST /publish). */
export const publishSchema = z.object({ revision: z.number().int().positive().optional() }).strict();
export const sharingSchema = z.object({
  visibility: z.enum(["inherit", "private", "selected", "all_users"]),
  userIds: z.array(uuid).max(100).default([])
}).strict();
export const documentPatchSchema = z.object({
  name: z.string().max(1024).optional(),
  folderId: uuid.nullable().optional()
}).strict().refine((value) => value.name !== undefined || value.folderId !== undefined, "Provide a name or a folderId");
export const folderSharingSchema = z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  userIds: z.array(uuid).max(100).default([])
}).strict();
export const mcpApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** 1 to one-per-defined-scope unique values; defaults to notes:read. A write scope adds its read scope. */
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(MCP_SCOPES.length)
    .refine((values) => new Set(values).size === values.length, "Scopes must be unique")
    .optional(),
  password: reauthPassword,
  totpCode: totpCode.optional(),
  recoveryCode: recoveryCode.optional()
}).strict().refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");

/** Maximum JSON (and MCP) request body, enforced while reading regardless of Content-Length. */
export const JSON_BODY_LIMIT_BYTES = 2_100_000;

const tooLarge = () => new HTTPException(413, { message: "Request is too large" });

/**
 * Reads a request body into memory, aborting with 413 as soon as more than
 * `limit` bytes arrive. A declared Content-Length over the limit is rejected
 * before anything is read; chunked bodies are counted as they stream.
 */
export async function readBoundedBody(request: Request, limit = JSON_BODY_LIMIT_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge();
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Returns an equivalent request whose body has been read through `readBoundedBody`. */
export async function boundedRequest(request: Request, limit = JSON_BODY_LIMIT_BYTES): Promise<Request> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return request;
  const body = await readBoundedBody(request, limit);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await readBoundedBody(request);
  return schema.parse(JSON.parse(new TextDecoder().decode(body)));
}

// A title is at most eight words, so only the start of a line matters. The patterns below
// rescan from every unmatched "[" or "<", so bounding the line keeps a huge first line cheap.
const TITLE_SOURCE_CHARS = 2048;

export function deriveNoteTitle(markdown: string) {
  for (const sourceLine of markdown.split(/\r?\n/)) {
    const line = sourceLine
      .trimStart()
      .slice(0, TITLE_SOURCE_CHARS)
      .trim()
      .replace(/^```.*$/, "")
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line || /^[-=]{3,}$/.test(line)) continue;
    const short = line.split(" ").slice(0, 8).join(" ");
    return short.length > 80 ? `${short.slice(0, 77).trimEnd()}…` : short;
  }
  return "New note";
}

const MAX_DISPLAY_NAME_BYTES = 255;
const MAX_PRESERVED_EXTENSION_BYTES = 32;
// C0 and C1 controls, DEL, bidi embeddings/overrides/isolates/marks, and zero-width characters.
const strippedCharacters = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const utf8Length = (value: string) => Buffer.byteLength(value, "utf8");
const cleanEdges = (value: string) => value.replace(/^[\s.]+|[\s.]+$/g, "");

function truncateUtf8(value: string, maxBytes: number) {
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = utf8Length(codePoint);
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}

/**
 * Sanitizes a document display name (DEVELOPMENT_PLAN §6.4). The result is
 * only ever stored in SQLite and never used in a filesystem path.
 *
 * - "upload": falls back to "Untitled" and truncates to 255 UTF-8 bytes,
 *   keeping a short extension when possible.
 * - "rename": returns null when the result is empty or longer than 255 bytes.
 */
export function sanitizeDisplayName(input: string, mode: "upload" | "rename"): string | null {
  const cleaned = cleanEdges(
    input
      .replace(/\p{Cs}/gu, "")
      .normalize("NFC")
      .replace(strippedCharacters, "")
      .replace(/[/\\:]/g, "-")
      .replace(/\s+/g, " ")
  );
  const valid = cleaned !== "" && cleaned !== "." && cleaned !== "..";
  if (mode === "rename") return valid && utf8Length(cleaned) <= MAX_DISPLAY_NAME_BYTES ? cleaned : null;
  if (!valid) return "Untitled";
  if (utf8Length(cleaned) <= MAX_DISPLAY_NAME_BYTES) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? cleaned.slice(dot) : "";
  if (extension && utf8Length(extension) <= MAX_PRESERVED_EXTENSION_BYTES && !/\s/.test(extension)) {
    const base = cleanEdges(truncateUtf8(cleaned.slice(0, dot), MAX_DISPLAY_NAME_BYTES - utf8Length(extension)));
    if (base) return `${base}${extension}`;
  }
  return cleanEdges(truncateUtf8(cleaned, MAX_DISPLAY_NAME_BYTES)) || "Untitled";
}
