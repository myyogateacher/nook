import * as z from "zod/v4";
import { anchorsOf, keyReach, reachCovers } from "../keyResources";
import { defineTool, McpToolError, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import type { McpScope } from "../mcpScopes";
import type { ResourceKind } from "../keyGrants";
import { HOST_KINDS, HOSTS, type HostKind } from "./hosts";
import { AttachmentError, listAttachments, readableAttachment } from "./service";

/**
 * Generic attachment tools (uploads everywhere plan D402, D70, T345), on MCP and REST
 * (`/api/v1/tools/:name`, D403). Each call is gated by the HOST module's read scope and the key's
 * grant on the host (a key over chosen calendars reaches events on those calendars only), never by
 * `files:read`: a Files-only key reaches no attachment it could not already list in Files. Chat
 * messages are whole-module (like the chat tools), so only a key whose agents:read covers everything
 * reaches them. Everything a key may not see is the same NOT_FOUND.
 */

const READ_SCOPES = [...new Set(HOST_KINDS.map((kind) => HOSTS[kind].readScope))] as McpScope[];
const hostKindInput = z.enum(HOST_KINDS).describe(`The kind of item the files are attached to: ${HOST_KINDS.join(", ")}`);
const uuid = z.string().uuid();
/** The containers a key can choose that hold hosts (events by calendar, cards by board, and so on). */
const HOST_CONTAINERS: ResourceKind[] = ["calendar", "note", "folder", "board", "collection", "whiteboard"];
const HOST_ACCESS = (related: string[]): McpToolSpec["access"] => ({ mode: "list", lists: HOST_CONTAINERS, listsNeedReach: true, related });

/** The host, if the key's grants reach it for its module's read scope; otherwise NOT_FOUND. */
function requireKeyReach(key: McpKeyContext, hostKind: HostKind, hostId: string) {
  const spec = HOSTS[hostKind];
  const reach = keyReach(key, spec.readScope);
  const covered = spec.itemKind === null ? reach === "all" : reachCovers(reach, anchorsOf(spec.itemKind, hostId));
  if (!covered) throw new McpToolError("NOT_FOUND", `${spec.noun[0]!.toUpperCase()}${spec.noun.slice(1)} not found`);
  return spec;
}

function rethrow(error: unknown): never {
  if (error instanceof AttachmentError) throw new McpToolError(error.status === 404 ? "NOT_FOUND" : "INVALID", error.message);
  throw error;
}

export const attachmentTools: McpToolSpec[] = [
  defineTool({
    name: "list_attachments",
    title: "List attachments",
    description: "List the files attached to an item you can read (a calendar event, a published note, a chat message, a whiteboard, a task card, or a collection row): id, name, type, size, and the comment or field it belongs to. Files in their owner's Bin are listed as removed, with no name. Needs the read scope of the item's module.",
    scopes: READ_SCOPES,
    // Each call checks the host module's scope and the key's grant on the host in the handler; a key whose
    // chosen items hold no host container (only knowledge bases, say) is never offered it.
    access: HOST_ACCESS(["hostId"]),
    write: false,
    inputSchema: z.object({ hostKind: hostKindInput, hostId: uuid.describe("The item's id") }).strict(),
    handler: ({ hostKind, hostId }, key) => {
      const id = hostId.toLowerCase();
      const spec = requireKeyReach(key, hostKind, id);
      try {
        const attachments = listAttachments(hostKind, id, key.userId).map((item) => item.removed
          ? { id: item.documentId, removed: true, partId: item.partId }
          : { id: item.documentId, name: item.name, mimeType: item.mimeType, previewKind: item.previewKind, sizeBytes: item.sizeBytes, partId: item.partId, linkedAt: item.linkedAt });
        return { hostKind, hostId: id, attachments, limit: spec.caps.perHost };
      } catch (error) {
        rethrow(error);
      }
    }
  }),
  defineTool({
    name: "read_attachment_text",
    title: "Read an attached text file",
    description: "Read a text file (such as .txt, .md, .csv, or .json) attached to an item you can read, up to 1048576 bytes as UTF-8. Other files return NOT_TEXT or TOO_LARGE. Needs the read scope of the item's module.",
    scopes: READ_SCOPES,
    access: HOST_ACCESS(["hostId", "documentId"]),
    write: false,
    inputSchema: z.object({ hostKind: hostKindInput, hostId: uuid.describe("The item's id"), documentId: uuid.describe("The attached file's id, from list_attachments") }).strict(),
    handler: async ({ hostKind, hostId, documentId }, key) => {
      const id = hostId.toLowerCase();
      requireKeyReach(key, hostKind, id);
      const document = readableAttachment(hostKind, id, documentId.toLowerCase(), key.userId);
      if (!document) throw new McpToolError("NOT_FOUND", "Attachment not found");
      // Loaded at call time: server/mcpTools.ts registers these tools, so a static import would be a cycle.
      const { readDocumentText } = await import("../mcpTools");
      const text = await readDocumentText(document);
      return { id: document.id, name: document.name, mimeType: document.mime_type, sizeBytes: document.size_bytes, hostKind, hostId: id, text };
    }
  })
];
