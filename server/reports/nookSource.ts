import { config } from "../config";
import { logger, shortId } from "../log";
import type { CatalogTool } from "../../shared/agents";
import type { DocServerChoice } from "../../shared/reportsGenerate";
import { parseNookRef, type NookDocRef } from "../../shared/nookDocRef";
import { REPORT_LIMITS } from "../../shared/reports";
import type { McpCallOutcome } from "../agents/mcpClient";
import type { BrowseSource } from "./docBrowse";
import { ReportError } from "./errors";

const slog = logger("reports");

/**
 * Nook as a built-in doc source (B4): a report's doc may be a note, a Files text document, or a Files
 * PDF's text layer (D511) in this workspace. The source has the fixed id `nook`, is listed first as "<APP_NAME> (this workspace)",
 * needs no sync, and is not a row in `agent_tool_servers` (`reports.doc_source = 'nook'`,
 * `doc_server_id` NULL).
 *
 * - **Refs**: a link on one of this instance's origins (APP_ORIGIN, APP_ORIGINS) to a note or a Files
 *   item, in any shape the router or the API produces, or a bare id (shared/nookDocRef.ts).
 * - **Access**: always the report OWNER's, live: a note they can read now with a published version
 *   (never a draft, never one in the Bin), a Files text document or PDF they can list. Anything else is
 *   NOT_FOUND with one message, so a link never tells whether something exists.
 * - **Reading** uses the same service functions as the `read_note` and `read_document_text` MCP tools
 *   (`readDocumentTextLayer` with PDFs on, D510: the PDF worker and its 16 MiB, 300-page, 15 s caps; a
 *   scan, a password, or a damaged PDF is DOC_FETCH with the reason); snapshots, "Doc changed", and
 *   Check doc work as for a tool server. A PDF's text is the doc's markdown as it comes (pages joined
 *   by a blank line).
 * - **Browse tools** (B3) for this source: `search_notes`, `read_note`, `read_document_text`, always
 *   Auto, run as the owner.
 */

export const NOOK_SOURCE_ID = "nook";
export const NOOK_TOOLS = ["read_note", "read_document_text", "search_notes"] as const;

export const nookSourceName = () => `${config.appName} (this workspace)`;
/** This instance's origins: a link on any of them is a ref into Nook. */
export const nookOrigins = (): string[] => [...new Set([config.appOrigin, ...config.appOrigins])];

const notFound = () => new ReportError(404, "NOT_FOUND", `There is no published note, text file, or PDF at that link in ${config.appName} that you can read`);

/** The ref a doc link names in this Nook (NOT_FOUND when it is not one). */
export function nookRefOf(ref: string): NookDocRef {
  const parsed = parseNookRef(ref, nookOrigins());
  if (!parsed) throw new ReportError(400, "INVALID", `That is not a link to a note or a file in ${config.appName}`);
  return parsed;
}

type Read = { kind: "note" | "file"; id: string; title: string | null; markdown: string };

/** Reads a note (published, readable by `ownerId` now) or a Files text document or PDF (listable by them), as the MCP tools do. */
export async function readNookItem(ownerId: string, ref: NookDocRef): Promise<Read> {
  const { readableNote } = await import("../access");
  const { listableDocument } = await import("../documentAccess");
  const { readDocumentTextLayer, readPublishedMarkdown, MCP_MAX_TEXT_BYTES } = await import("../mcpTools");
  const { PDF_TEXT_LIMITS } = await import("../pdfText");
  if (ref.kind !== "file") {
    const note = readableNote(ref.id, ownerId);
    if (note && note.current_version >= 1) {
      const { title, markdown } = await readPublishedMarkdown(note.id, note.current_version);
      return { kind: "note", id: note.id, title: title || null, markdown };
    }
    if (ref.kind === "note") throw notFound();
  }
  const document = listableDocument(ref.id, ownerId);
  if (!document) throw notFound();
  try {
    // The doc keeps at most docBytes * 2 characters (fetchNookDoc), so the worker stops there too.
    const { text } = await readDocumentTextLayer(document, { pdf: true, pdfMaxChars: REPORT_LIMITS.docBytes * 2 });
    return { kind: "file", id: document.id, title: document.name, markdown: text };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const pdf = document.preview_kind === "pdf";
    // A PDF's own reason (a scan, a password, a damaged file, the time cap, a busy reader) is the message.
    if (pdf && (code === "NOT_TEXT" || code === "TOO_LARGE" || code === "RATE_LIMITED") && error instanceof Error) {
      throw new ReportError(502, "DOC_FETCH", error.message);
    }
    if (code === "NOT_TEXT") throw new ReportError(502, "DOC_FETCH", `That file is not text or a PDF; ${config.appName} reads notes, text files (.md, .txt, .csv, .json), and PDFs with a text layer`);
    if (code === "TOO_LARGE") throw new ReportError(502, "DOC_FETCH", `That file is too large to read as a doc (at most ${MCP_MAX_TEXT_BYTES / 1024 / 1024} MB for a text file, ${PDF_TEXT_LIMITS.maxBytes / 1024 / 1024} MB for a PDF)`);
    throw new ReportError(502, "DOC_FETCH", "The file could not be read");
  }
}

/** The tool a Nook doc is recorded with (`reports.doc_tool`): what read it. */
export const nookToolOf = (kind: Read["kind"]) => kind === "note" ? "read_note" : "read_document_text";

/** The built-in source as New report lists it: first, always synced, with its own read-only tools. */
export function nookChoice(): DocServerChoice {
  const tools = NOOK_TOOLS.map((name) => ({ name, title: null, args: name === "search_notes" ? ["query"] : name === "read_note" ? ["noteId"] : ["documentId"] }));
  return {
    id: NOOK_SOURCE_ID, name: nookSourceName(), status: "ok", synced: true, tools, pick: { tool: "read", arg: "id", outline: false },
    candidates: [], toolNames: [...NOOK_TOOLS], builtin: true, origins: nookOrigins(), host: null
  };
}

const catalog: CatalogTool[] = [
  { name: "read_note", title: "Read a note", description: "Reads the latest published Markdown of a note the report's owner can read, by its id (noteId).", inputSchema: { type: "object", required: ["noteId"], properties: { noteId: { type: "string", description: "The note's id (from a link /notes/<id>)" } } }, readOnly: true, openWorld: false, destructive: false, policy: "auto" },
  { name: "read_document_text", title: "Read a text file or PDF", description: "Reads a Files text document (.md, .txt, .csv, .json), or the text layer of a PDF, the report's owner can see, by its id (documentId).", inputSchema: { type: "object", required: ["documentId"], properties: { documentId: { type: "string", description: "The file's id (from a link /files/<id>)" } } }, readOnly: true, openWorld: false, destructive: false, policy: "auto" },
  { name: "search_notes", title: "Search notes", description: "Full-text search over the published notes the report's owner can read; returns ids, titles, and snippets.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 20 } } }, readOnly: true, openWorld: false, destructive: false, policy: "auto" }
];

/** Nook's catalog for the browse picker and checks: always these three, always Auto. */
export const nookCatalog = (): CatalogTool[] => catalog.map((tool) => ({ ...tool }));

const errorOutcome = (error: unknown): McpCallOutcome => ({ text: error instanceof ReportError ? error.message : "That could not be read", isError: true });

/** Nook as a browse source for one report: every call as its owner. */
export function nookBrowseSource(ownerId: string): BrowseSource {
  return {
    id: NOOK_SOURCE_ID,
    name: config.appName,
    tools: nookCatalog,
    call: async (tool, args): Promise<McpCallOutcome> => {
      try {
        if (tool === "search_notes") {
          const { searchPublishedNotes } = await import("../searchRoutes");
          const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
          if (!query.trim()) return { text: "query is required", isError: true };
          const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(20, Math.max(1, args.limit)) : 10;
          return { text: JSON.stringify(searchPublishedNotes(ownerId, query, { folderId: null, limit })), isError: false };
        }
        const id = String(tool === "read_note" ? args.noteId ?? "" : tool === "read_document_text" ? args.documentId ?? "" : "");
        if (!/^[0-9a-f-]{36}$/i.test(id)) return { text: "Give the id of a note or file", isError: true };
        const read = await readNookItem(ownerId, { kind: tool === "read_note" ? "note" : "file", id: id.toLowerCase() });
        return { text: JSON.stringify({ title: read.title, markdown: read.markdown }), isError: false };
      } catch (error) {
        slog.info("Nook doc tool refused", { tool, owner: shortId(ownerId), code: (error as { code?: string }).code ?? "INTERNAL" });
        return errorOutcome(error);
      }
    }
  };
}

/** The doc as docSource's FetchedDoc: its title, markdown cut at 512 KiB, hash, and size. */
export async function fetchNookDoc(ownerId: string, ref: string): Promise<{ title: string | null; markdown: string; kind: "note" | "file" }> {
  const started = performance.now();
  try {
    const read = await readNookItem(ownerId, nookRefOf(ref));
    slog.info("Doc fetched", { server: NOOK_SOURCE_ID, tool: nookToolOf(read.kind), bytes: Buffer.byteLength(read.markdown, "utf8"), ms: Math.round(performance.now() - started) });
    return { title: read.title, markdown: read.markdown.slice(0, REPORT_LIMITS.docBytes * 2), kind: read.kind };
  } catch (error) {
    slog.warn("Doc fetch failed", { server: NOOK_SOURCE_ID, code: (error as { code?: string }).code, ms: Math.round(performance.now() - started) });
    throw error;
  }
}
