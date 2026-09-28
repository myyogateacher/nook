import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listReadableFolders, ownedNote, readableNote, readableNotePredicate } from "./access";
import { config } from "./config";
import { audit, db, type DocumentRow, type NoteRow } from "./db";
import { listableDocument, listableDocumentSummary, listReadableDocuments } from "./documentAccess";
import { DocumentIntegrityError, openObjectForRead } from "./documentStorage";
import { consumeMcpLimits, type McpLimitBucket } from "./mcpRateLimit";
import { hasAllScopes, hasAnyScope, parseStoredScopes } from "./mcpScopes";
import { MAX_QUERY_LENGTH } from "./search";
import { searchPublishedNotes } from "./searchRoutes";
import { createDraftNote, writeDraftLocked } from "./noteDrafts";
import { noteManageTools } from "./mcpNoteTools";
import { fileWriteTools } from "./mcpFileTools";
import { rememberSeenDraft } from "./mcpSeenDrafts";
import { checksum, storage, withNoteLock } from "./storage";
import { defineTool, errorResult, McpToolError, notFound, textResult, type McpKeyContext, type McpToolSpec, type ToolResult } from "./mcpToolKit";
import { taskTools } from "./tasks/mcpTools";
import { todayTools } from "./today/mcpTools";
import { calendarTools } from "./calendar/mcpTools";
import { collectionTools } from "./collections/mcpTools";
import { teamTools } from "./team/mcpTools";
import { inboxTools } from "./inbox/mcpTools";
import { countRunToolCall } from "./inbox/routineHooks";
import { effectiveMcpScopes, type Role } from "./team/roles";
import { canWriteContent } from "./team/userRole";

/**
 * MCP tools (docs/plan/WAVES_7-9.md §4.2, D36–D37).
 *
 * Every tool declares the scopes that allow it (any one of them). A tool is
 * registered only when the key holds one of them, and its handler checks the
 * key again, freshly from the database, before doing anything. Tools run the
 * same services as the HTTP routes, as the key's owner. Failures come back as
 * `isError` results whose text is `{error, code}`; not found, not readable, and
 * binned look the same.
 */

export { defineTool, errorResult, McpToolError, notFound, textResult } from "./mcpToolKit";
export type { McpErrorCode, McpKeyContext, McpToolSpec } from "./mcpToolKit";

const liveKey = db.query(`
  SELECT k.id, k.user_id, k.name, k.scopes, u.role FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
  WHERE k.id = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
`);

/**
 * The key as stored now, or null once it is revoked or its user is disabled. Its scopes are the
 * effective ones: stored scopes narrowed to what the holder's current role allows (T81).
 */
export function loadLiveKey(keyId: string): McpKeyContext | null {
  const row = liveKey.get(keyId) as { id: string; user_id: string; name: string; scopes: string; role: Role } | null;
  return row ? { keyId: row.id, userId: row.user_id, name: row.name, scopes: effectiveMcpScopes(parseStoredScopes(row.scopes), row.role) } : null;
}

/**
 * Runs one tool for a key: re-checks the key and its scope, charges the
 * per-key limits, and maps errors to `{error, code}` results.
 */
export async function runTool(spec: McpToolSpec, args: unknown, keyId: string): Promise<ToolResult> {
  const key = loadLiveKey(keyId);
  if (!key) return errorResult("SCOPE_REQUIRED", "This API key is no longer active");
  if (!hasAnyScope(key.scopes, spec.scopes)) {
    return errorResult("SCOPE_REQUIRED", `This API key does not have the ${spec.scopes.join(" or ")} scope`);
  }
  if (!hasAllScopes(key.scopes, spec.alsoRequires)) {
    return errorResult("SCOPE_REQUIRED", `This API key also needs the ${spec.alsoRequires!.join(" and ")} scope`);
  }
  // Defence in depth (§5.4): effective scopes already drop write scopes for read-only team roles,
  // and a write tool still re-checks the holder's role before any service runs.
  if (spec.write && !canWriteContent(key.userId)) return errorResult("READ_ONLY", "Your team role is read-only");
  const buckets: McpLimitBucket[] = ["call"];
  if (spec.write) buckets.push("write");
  if (spec.dailyBucket) buckets.push(spec.dailyBucket);
  if (spec.buckets) buckets.push(...spec.buckets);
  const retryAfter = consumeMcpLimits({ keyId: key.keyId, userId: key.userId }, buckets);
  if (retryAfter) return errorResult("RATE_LIMITED", "Too many requests for this API key. Try again later.", { retryAfterSeconds: retryAfter });
  // Agent inbox D160: an admitted call counts toward the key's open routine run, if it has one.
  countRunToolCall(key.keyId);
  try {
    const parsed = spec.inputSchema.safeParse(args ?? {});
    if (!parsed.success) return errorResult("INVALID", "Invalid arguments", { details: parsed.error.issues.map((issue) => issue.message) });
    return textResult(await spec.handler(parsed.data, key));
  } catch (error) {
    if (error instanceof McpToolError) return errorResult(error.code, error.message, error.details);
    console.error(`MCP tool ${spec.name} failed`, error instanceof Error ? error.name : "Unknown error");
    return errorResult("INTERNAL", "Something went wrong");
  }
}

// ---------------------------------------------------------------- notes:read

const listNotesQuery = db.query(`
  SELECT n.id, v.title, n.current_version, n.updated_at, u.display_name AS owner_name,
         CASE WHEN n.owner_id = $userId THEN 1 ELSE 0 END AS is_owner
  FROM notes n JOIN users u ON u.id = n.owner_id
  JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version
  WHERE n.deleted_at IS NULL AND n.current_version > 0 AND ${readableNotePredicate}
  ORDER BY n.updated_at DESC LIMIT 200
`);

/** Reads a published version after checking it against its recorded checksum. */
export async function readPublishedMarkdown(noteId: string, version: number) {
  const metadata = db.query("SELECT title, checksum FROM note_versions WHERE note_id = ? AND version_number = ?")
    .get(noteId, version) as { title: string; checksum: string } | null;
  if (!metadata) throw new McpToolError("INTERNAL", "Published version metadata is missing");
  const markdown = await storage.readVersion(noteId, version);
  if (checksum(markdown) !== metadata.checksum) throw new McpToolError("INTERNAL", "Note content failed integrity verification");
  return { title: metadata.title, markdown };
}

const noteReadTools: McpToolSpec[] = [
  defineTool({
    name: "list_notes",
    title: "List notes",
    description: "List the published notes the authenticated Nook user can read. Draft content is never returned.",
    scopes: ["notes:read"],
    write: false,
    inputSchema: z.object({ query: z.string().max(120).optional().describe("Optional case-insensitive title filter") }),
    handler: ({ query }, key) => {
      const search = query?.trim().toLowerCase() ?? "";
      const notes = listNotesQuery.all({ userId: key.userId }) as Array<Record<string, unknown> & { title: string }>;
      return { notes: search ? notes.filter((note) => note.title.toLowerCase().includes(search)) : notes };
    }
  }),
  defineTool({
    name: "read_note",
    title: "Read a note",
    description: "Read the latest published Markdown for a note visible to the authenticated Nook user.",
    scopes: ["notes:read"],
    write: false,
    inputSchema: z.object({ noteId: z.string().uuid() }),
    handler: async ({ noteId }, key) => {
      const note = readableNote(noteId, key.userId);
      if (!note || note.current_version < 1) throw new McpToolError("NOT_FOUND", "Note not found or not published");
      const { title, markdown } = await readPublishedMarkdown(noteId, note.current_version);
      return { id: note.id, title, version: note.current_version, markdown };
    }
  }),
  defineTool({
    name: "search_notes",
    title: "Search notes",
    description: "Full-text search over the published text of notes the user can read. Drafts are never searched. Snippets are plain text.",
    scopes: ["notes:read"],
    write: false,
    inputSchema: z.object({
      query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Words to find; quote a phrase with double quotes"),
      folderId: z.string().uuid().optional().describe("Only notes in this folder"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum results, 1 to 20 (default 10)")
    }),
    handler: ({ query, folderId, limit }, key) => searchPublishedNotes(key.userId, query, { folderId: folderId ?? null, limit: limit ?? 10 })
  }),
  defineTool({
    name: "list_folders",
    title: "List folders",
    description: "List the folders the user owns or that are shared with them, as the Nook web app shows them.",
    scopes: ["notes:read", "files:read"],
    write: false,
    inputSchema: z.object({}),
    handler: (_args, key) => ({ folders: listReadableFolders(key.userId) })
  })
];

// --------------------------------------------------------- notes:write-draft

const noteUrl = (noteId: string) => `${config.appOrigin}/notes/${noteId}`;

function assertMarkdownSize(markdown: string) {
  if (Buffer.byteLength(markdown, "utf8") > config.maxMarkdownBytes) {
    throw new McpToolError("TOO_LARGE", `Notes are limited to ${config.maxMarkdownBytes} bytes of Markdown`);
  }
}

/** The owner's draft if one exists, otherwise the published text (or "" for a never-published note), checksum-verified. */
async function currentOwnerText(note: NoteRow) {
  if (note.draft_revision !== null) {
    const markdown = await storage.readDraft(note.id);
    if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) throw new McpToolError("INTERNAL", "Draft content failed integrity verification");
    return markdown;
  }
  if (note.current_version < 1) return "";
  return (await readPublishedMarkdown(note.id, note.current_version)).markdown;
}

/** Appends as a new paragraph block. */
export function appendMarkdown(base: string, addition: string) {
  if (base.trim() === "") return addition;
  return `${base.replace(/\s+$/, "")}\n\n${addition}`;
}

const nonBlankMarkdown = z.string().refine((value) => value.trim() !== "", "markdown must not be blank");

const noteWriteTools: McpToolSpec[] = [
  defineTool({
    name: "create_note",
    title: "Create a draft note",
    description: "Create a new note whose content is an unpublished draft. A person must open it in Nook and publish it. Returns the note id, draft revision, and a link.",
    scopes: ["notes:write-draft"],
    write: true,
    dailyBucket: "create_note",
    inputSchema: z.object({
      markdown: nonBlankMarkdown.describe("The note's Markdown; the first line becomes its title"),
      folderId: z.string().uuid().optional().describe("A folder the user owns; defaults to their Default folder")
    }),
    handler: async ({ markdown, folderId }, key) => {
      assertMarkdownSize(markdown);
      if (folderId && !db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(folderId, key.userId)) throw notFound("Folder");
      const created = await createDraftNote(key.userId, folderId ?? null, markdown, { keyId: key.keyId });
      rememberSeenDraft(key.keyId, created.id, created.revision, checksum(markdown));
      return { noteId: created.id, revision: created.revision, title: created.title, folderId: created.folderId, url: noteUrl(created.id) };
    }
  }),
  defineTool({
    name: "get_note_draft",
    title: "Get a note's draft",
    description: "Read the current draft of a note the user owns, with the revision to pass to update_note_draft or publish_note_draft. When there is no draft, returns the published text and a null revision.",
    scopes: ["notes:write-draft", "notes:publish"],
    write: false,
    inputSchema: z.object({ noteId: z.string().uuid() }),
    handler: async ({ noteId }, key) => withNoteLock(noteId, async () => {
      const note = ownedNote(noteId, key.userId);
      if (!note) throw notFound();
      const markdown = await currentOwnerText(note);
      // The revision this key was shown, for publish_note_draft (D173). The checksum was verified above.
      if (note.draft_revision !== null && note.draft_checksum) rememberSeenDraft(key.keyId, noteId, note.draft_revision, note.draft_checksum);
      return {
        noteId,
        revision: note.draft_revision,
        hasDraft: note.draft_revision !== null,
        markdown,
        publishedVersion: note.current_version,
        url: noteUrl(noteId)
      };
    })
  }),
  defineTool({
    name: "update_note_draft",
    title: "Update a note's draft",
    description: "Replace or append to the draft of a note the user owns. Never publishes and never creates a version. baseRevision must be the revision from get_note_draft (null when there was no draft); if the draft changed since, the call fails with DRAFT_CHANGED.",
    scopes: ["notes:write-draft"],
    write: true,
    inputSchema: z.object({
      noteId: z.string().uuid(),
      markdown: z.string().describe("Markdown to write, or to append as a new paragraph"),
      baseRevision: z.number().int().nonnegative().nullable(),
      mode: z.enum(["replace", "append"]).default("replace")
    }),
    handler: async ({ noteId, markdown, baseRevision, mode }, key) => {
      assertMarkdownSize(markdown);
      return withNoteLock(noteId, async () => {
        const note = ownedNote(noteId, key.userId);
        if (!note) throw notFound();
        const changed = () => new McpToolError("DRAFT_CHANGED", "The draft changed since baseRevision. Read it again with get_note_draft.", { currentRevision: note.draft_revision });
        if (baseRevision !== note.draft_revision) throw changed();
        const next = mode === "append" ? appendMarkdown(await currentOwnerText(note), markdown) : markdown;
        assertMarkdownSize(next);
        const saved = await writeDraftLocked(note, key.userId, next, key.keyId);
        if (!saved) throw changed();
        audit(key.userId, noteId, "mcp.note_draft_update", { via: "mcp", keyId: key.keyId, mode, revision: saved.revision });
        rememberSeenDraft(key.keyId, noteId, saved.revision, checksum(next));
        return { noteId, revision: saved.revision, title: saved.title, hasDelta: saved.hasDelta, url: noteUrl(noteId) };
      });
    }
  })
];

// ---------------------------------------------------------------- files:read

export const MCP_MAX_TEXT_BYTES = 1_048_576;

async function readDocumentText(document: DocumentRow) {
  if (document.preview_kind !== "text") throw new McpToolError("NOT_TEXT", "Only text files can be read. This file is not text.");
  if (document.size_bytes > MCP_MAX_TEXT_BYTES) throw new McpToolError("TOO_LARGE", `Text files larger than ${MCP_MAX_TEXT_BYTES} bytes cannot be read over MCP`);
  let bytes: Uint8Array;
  try {
    const { handle } = await openObjectForRead(document.id, document.size_bytes);
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof DocumentIntegrityError) throw new McpToolError("INTERNAL", "File content failed integrity verification");
    throw error;
  }
  if (bytes.byteLength !== document.size_bytes || createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
    throw new McpToolError("INTERNAL", "File content failed integrity verification");
  }
  if (bytes.includes(0)) throw new McpToolError("NOT_TEXT", "This file is not valid UTF-8 text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new McpToolError("NOT_TEXT", "This file is not valid UTF-8 text");
  }
}

const fileTools: McpToolSpec[] = [
  defineTool({
    name: "list_documents",
    title: "List files",
    description: "List the files (documents) the user can see in Nook Files, newest first. Metadata only.",
    scopes: ["files:read"],
    write: false,
    inputSchema: z.object({ folderId: z.string().uuid().optional().describe("Only files in this folder") }),
    handler: ({ folderId }, key) => ({ documents: listReadableDocuments(key.userId, folderId ?? null) })
  }),
  defineTool({
    name: "get_document_metadata",
    title: "Get file details",
    description: "Name, type, size, folder, owner, and sharing of one file the user can see in Nook Files.",
    scopes: ["files:read"],
    write: false,
    inputSchema: z.object({ documentId: z.string().uuid() }),
    handler: ({ documentId }, key) => {
      const document = listableDocumentSummary(documentId, key.userId);
      if (!document) throw notFound("File");
      return { document };
    }
  }),
  defineTool({
    name: "read_document_text",
    title: "Read a text file",
    description: `Read a text file (such as .txt, .md, .csv, or .json) up to ${MCP_MAX_TEXT_BYTES} bytes as UTF-8. Other files return NOT_TEXT or TOO_LARGE.`,
    scopes: ["files:read"],
    write: false,
    inputSchema: z.object({ documentId: z.string().uuid() }),
    handler: async ({ documentId }, key) => {
      const document = listableDocument(documentId, key.userId);
      if (!document) throw notFound("File");
      const text = await readDocumentText(document);
      return { id: document.id, name: document.name, mimeType: document.mime_type, sizeBytes: document.size_bytes, text };
    }
  })
];

/**
 * Every tool group. A module adds its tools as one spread here, built with
 * defineTool from server/mcpToolKit.ts (task tools: server/tasks/mcpTools.ts).
 */
export const mcpToolSpecs: readonly McpToolSpec[] = [
  ...noteReadTools,
  ...noteWriteTools,
  ...noteManageTools,
  ...fileTools,
  ...fileWriteTools,
  ...taskTools,
  ...calendarTools,
  ...collectionTools,
  ...todayTools,
  ...teamTools,
  ...inboxTools
];

/** Whether a key holding `scopes` may see and call `spec`: any one of its scopes and all of alsoRequires (D172). */
export const toolAllowed = (spec: McpToolSpec, scopes: McpKeyContext["scopes"]) => hasAnyScope(scopes, spec.scopes) && hasAllScopes(scopes, spec.alsoRequires);

/** Registers the tools this key may use on a per-request server. */
export function registerMcpTools(server: McpServer, key: McpKeyContext) {
  for (const spec of mcpToolSpecs) {
    if (!toolAllowed(spec, key.scopes)) continue;
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: { readOnlyHint: !spec.write, destructiveHint: false, idempotentHint: !spec.write, openWorldHint: false }
    }, (args: unknown) => runTool(spec, args, key.keyId));
  }
}

/** Test hook: call a tool by name without the scope-based registration, to prove the handler re-check. */
export function invokeMcpToolForTests(name: string, args: unknown, keyId: string) {
  const spec = mcpToolSpecs.find((item) => item.name === name);
  if (!spec) throw new Error(`Unknown MCP tool ${name}`);
  return runTool(spec, args, keyId);
}
