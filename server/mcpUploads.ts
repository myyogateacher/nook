import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { authenticateKeyRequest, mcpJsonError, mcpResponse, withMcpRequestSlot } from "./mcp";
import { storeForKey, ticketBudgetError, ticketExpired, uploadTicket } from "./mcpFileTools";
import { hasScope } from "./mcpScopes";
import { loadLiveKey } from "./mcpTools";
import { canWriteContent } from "./team/userRole";
import { withSurfaceAuditContext } from "./db";

/**
 * PUT /mcp/uploads/:uploadId (docs/plan/WAVES_18-20_SMALL.md D176, T146): the byte half of the
 * begin_upload → PUT → finish_upload flow. Outside /api (no cookie, no CSRF), with the /mcp Host and
 * Origin checks and the same Bearer key that began the upload, so a leaked URL alone is useless. The
 * raw body streams through the web upload's pipeline (staging, SHA-256 while streaming, sniffing,
 * quota, free disk, the T80 block re-check), with the ticket id as the idempotency key: a retry after
 * success answers 200 with `idempotentReplay: true`.
 */

const json = (status: number, body: Record<string, unknown>) => mcpResponse(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handleMcpUpload(request: Request, uploadId: string, clientIp: string | null = null) {
  const id = uploadId.toLowerCase();
  const ticket = UUID.test(id) ? uploadTicket(id) : null;
  // The same key checks as a tool call, IP allowlist included, on the surface begin_upload was
  // called on (review S4). An unknown ticket authenticates as MCP; it is 404 after authentication.
  const surface = ticket?.surface ?? "mcp";
  const authenticated = authenticateKeyRequest(request, { surface, clientIp });
  if (authenticated instanceof Response) return authenticated;
  const key = loadLiveKey(authenticated.id, surface);
  if (!key) return mcpJsonError("Invalid or revoked API key", 401, true, "KEY_INVALID");
  if (!hasScope(key.scopes, "files:write") || !canWriteContent(key.userId)) return json(403, { error: "This API key cannot upload files", code: "SCOPE_REQUIRED" });

  // Another key's ticket looks like a missing one.
  if (!ticket || ticket.keyId !== key.keyId || ticket.userId !== key.userId) return json(404, { error: "Upload not found", code: "UPLOAD_NOT_FOUND" });
  if (ticket.state === "failed") return json(409, { error: ticket.failure!.message, code: ticket.failure!.code });
  if (ticket.state === "receiving") return json(409, { error: "This upload is already in progress", code: "UPLOAD_PENDING" });
  if (ticketExpired(ticket)) return json(404, { error: "The upload ticket expired", code: "UPLOAD_EXPIRED" });

  const lengthHeader = request.headers.get("content-length")?.trim();
  const declared = lengthHeader !== undefined && /^\d{1,16}$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (declared === null) return json(411, { error: "Content-Length is required for uploads", code: "LENGTH_REQUIRED" });
  if (declared !== ticket.sizeBytes) return json(400, { error: "Content-Length must equal the sizeBytes given to begin_upload", code: "SIZE_MISMATCH" });
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/octet-stream") return json(400, { error: "Content-Type must be application/octet-stream", code: "CONTENT_TYPE" });

  return withMcpRequestSlot(async () => {
    const committedBefore = ticket.state === "committed";
    // L3: the ticket's reservation must still fit the daily byte budget at commit.
    const overBudget = committedBefore ? null : ticketBudgetError(ticket);
    if (overBudget) return json(429, { error: overBudget.message, code: "RATE_LIMITED" });
    if (!committedBefore) ticket.state = "receiving";
    const source = request.body ? Readable.fromWeb(request.body as unknown as NodeWebReadableStream<Uint8Array>) : Readable.from([]);
    let result: { status: number; body: Record<string, unknown> };
    try {
      // A REST ticket's upload is audited as REST (review S4).
      result = await withSurfaceAuditContext(surface === "rest" ? { via: "rest" } : null, () => storeForKey(key, source, {
        userId: key.userId, name: ticket.name, folderId: ticket.folderId, purpose: ticket.purpose, uploadKey: ticket.id, expectedBytes: ticket.sizeBytes, sha256: ticket.sha256
      }, request.signal));
    } catch (error) {
      if (!committedBefore) ticket.state = "pending";
      throw error;
    }
    if (result.status === 200 || result.status === 201) {
      ticket.state = "committed";
      ticket.documentId = (result.body.document as { id: string }).id;
    } else if (result.body.code === "HASH_MISMATCH") {
      ticket.state = "failed";
      ticket.failure = { code: "HASH_MISMATCH", message: String(result.body.error) };
    } else if (!committedBefore) {
      // Anything else (a stall, a size mismatch, quota) may be retried while the ticket lasts.
      ticket.state = "pending";
    }
    // Every refusal carries a code (Wave 34 verification U1), also the upload pipeline's own.
    const coded = result.status >= 400 && typeof result.body.code !== "string"
      ? { ...result.body, code: result.status === 413 ? "TOO_LARGE" : result.status === 409 ? "UPLOAD_CONFLICT" : result.status === 404 ? "UPLOAD_NOT_FOUND" : "UPLOAD_FAILED" }
      : result.body;
    return json(result.status, coded);
  });
}
