import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listReadableFolders, ownedNote, readableNote, readableNotePredicate } from "./access";
import { config } from "./config";
import { audit, db, withSurfaceAuditContext, type DocumentRow, type NoteRow } from "./db";
import { listableDocument, listableDocumentSummary, listReadableDocuments } from "./documentAccess";
import { DocumentIntegrityError, openObjectForRead } from "./documentStorage";
import { consumeMcpLimits, type McpLimitBucket } from "./mcpRateLimit";
import { hasAllScopes, hasAnyScope, hasScope, type McpScope } from "./mcpScopes";
import { countKeyUsage, isKeyDenial, resolveKeyActor } from "./apiKeys";
import { grantsForScopes, scopeReach, selectionHas, type ScopeReach } from "./keyGrants";
import { anchorsOf, keyFilter, keyReach, keyReachAny, reachCanCover, reachCovers, type ItemKind } from "./keyResources";
import { MAX_QUERY_LENGTH } from "./search";
import { searchPublishedNotes } from "./searchRoutes";
import { createDraftNote, writeDraftLocked } from "./noteDrafts";
import { noteManageTools } from "./mcpNoteTools";
import { fileWriteTools } from "./mcpFileTools";
import { rememberSeenDraft } from "./mcpSeenDrafts";
import { checksum, storage, withNoteLock } from "./storage";
import { defineTool, errorResult, issueDetails, McpToolError, notFound, textResult, type McpKeyContext, type McpToolSpec, type ToolResult } from "./mcpToolKit";
import { taskTools } from "./tasks/mcpTools";
import { todayTools } from "./today/mcpTools";
import { calendarTools } from "./calendar/mcpTools";
import { collectionTools } from "./collections/mcpTools";
import { teamTools } from "./team/mcpTools";
import { inboxTools } from "./inbox/mcpTools";
import { whiteboardTools } from "./whiteboards/mcpTools";
import { countRunToolCall } from "./inbox/routineHooks";
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

/**
 * The key as it stands now (Nook keys, access plan D263), or null once it is revoked, expired, past
 * its rotation grace, its holder blocked, or team policy blocks it. Scopes and grants are the
 * effective ones: grants ∩ the holder's current role ∩ policy, recomputed on every call (T81).
 */
export function loadLiveKey(keyId: string, surface: KeySurface = "mcp"): McpKeyContext | null {
  const actor = resolveKeyActor(keyId, surface);
  return isKeyDenial(actor) ? null : actor;
}

/** Where a tool call came from: the MCP endpoint or `/api/v1/tools/:name` (Wave 34). */
export type KeySurface = "mcp" | "rest";

/**
 * How the key reaches a tool (D281): null when it cannot use it at all; otherwise the reach over
 * the tool's scopes (any one of them) and over each `alsoRequires` scope.
 */
type ToolReach = { reach: ScopeReach; also: ScopeReach[] };

function reachOf(spec: McpToolSpec, key: McpKeyContext): ToolReach | null {
  if (!hasAnyScope(key.scopes, spec.scopes) || !hasAllScopes(key.scopes, spec.alsoRequires)) return null;
  const reach = keyReachAny(key, spec.scopes.filter((scope) => hasScope(key.scopes, scope)));
  const also = (spec.alsoRequires ?? []).map((scope) => keyReach(key, scope));
  if (reach === null || also.some((item) => item === null)) return null;
  return { reach, also };
}

const coversEverything = (reach: ToolReach) => reach.reach === "all" && reach.also.every((item) => item === "all");

/**
 * Whether a key whose grants name chosen items may see `spec` (D281): `global` tools never; tools
 * acting on named items only when the key's items could hold them (a key over chosen boards never
 * sees note tools); list, derived, and own tools always (they filter what they return).
 */
function toolFits(spec: McpToolSpec, reach: ToolReach) {
  if (coversEverything(reach)) return true;
  if (spec.access.mode === "global") return false;
  if (spec.access.mode !== "items") return true;
  return (spec.access.items ?? []).filter((item) => item.ifAbsent !== "allow")
    .every((item) => [reach.reach, ...reach.also].every((each) => reachCanCover(each, item.kind)));
}

const ITEM_LABELS: Record<ItemKind, string> = {
  note: "Note", folder: "Folder", document: "File", whiteboard: "Whiteboard", board: "Board", card: "Card", column: "Column", sprint: "Sprint",
  task_view: "View", collection: "Collection", row: "Row", calendar: "Calendar", event: "Event", routine: "Routine", run: "Run"
};

/**
 * The declared items a call names, each checked against the key's chosen items (T203). Missing,
 * unreadable, and outside the grant are the same NOT_FOUND, and the error never names the item.
 */
function checkNamedItems(spec: McpToolSpec, reach: ToolReach, args: Record<string, unknown>) {
  if (coversEverything(reach) || spec.access.mode === "own" || spec.access.mode === "global") return;
  for (const item of spec.access.items ?? []) {
    const value = args[item.arg];
    const values = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
    if (!values.length) {
      if (item.ifAbsent === "allow") continue;
      throw new McpToolError("INVALID", `This API key covers only chosen items: pass ${item.arg}`);
    }
    for (const entry of values) {
      const anchors = typeof entry === "string" ? anchorsOf(item.kind, entry) : null;
      if (![reach.reach, ...reach.also].every((each) => reachCovers(each, anchors))) throw notFound(ITEM_LABELS[item.kind]);
    }
  }
}

/**
 * Runs one tool for a key on a surface (MCP or REST, the same path, Wave 34): re-checks the key,
 * its grants, surface, and policy; checks the items the call names; charges the per-key limits
 * (per surface); and maps errors to `{error, code}` results.
 */
export async function runTool(spec: McpToolSpec, args: unknown, keyId: string, surface: KeySurface = "mcp"): Promise<ToolResult> {
  const actor = resolveKeyActor(keyId, surface);
  if (isKeyDenial(actor)) {
    // Counted once, on the surface that was refused (review S5).
    countKeyUsage(keyId, "denied", surface);
    return actor.code === "KEY_POLICY" ? errorResult("KEY_POLICY", actor.message) : errorResult("SCOPE_REQUIRED", actor.message);
  }
  const key: McpKeyContext = actor;
  if (!hasAnyScope(key.scopes, spec.scopes)) {
    countKeyUsage(key.keyId, "denied", surface);
    return errorResult("SCOPE_REQUIRED", `This API key does not have the ${spec.scopes.join(" or ")} scope`);
  }
  if (!hasAllScopes(key.scopes, spec.alsoRequires)) {
    countKeyUsage(key.keyId, "denied", surface);
    return errorResult("SCOPE_REQUIRED", `This API key also needs the ${spec.alsoRequires!.join(" and ")} scope`);
  }
  const reach = reachOf(spec, key);
  if (!reach || !toolFits(spec, reach)) {
    countKeyUsage(key.keyId, "denied", surface);
    return errorResult("SCOPE_REQUIRED", "This API key covers only chosen items, and this tool is not available to it");
  }
  // Defence in depth (§5.4): effective scopes already drop write scopes for read-only team roles,
  // and a write tool still re-checks the holder's role before any service runs.
  if (spec.write && !canWriteContent(key.userId)) return errorResult("READ_ONLY", "Your team role is read-only");
  const buckets: McpLimitBucket[] = ["call"];
  if (spec.write) buckets.push("write");
  if (spec.dailyBucket) buckets.push(spec.dailyBucket);
  if (spec.buckets) buckets.push(...spec.buckets);
  const retryAfter = consumeMcpLimits({ keyId: key.keyId, userId: key.userId, limits: actor.limits, surface }, buckets);
  if (retryAfter) {
    countKeyUsage(key.keyId, "denied", surface);
    return errorResult("RATE_LIMITED", "Too many requests for this API key. Try again later.", { retryAfterSeconds: retryAfter });
  }
  countKeyUsage(key.keyId, spec.write ? "write" : "call", surface);
  // Agent inbox D160: an admitted call counts toward the key's open routine run, if it has one.
  countRunToolCall(key.keyId);
  try {
    // Named items first, on the raw arguments: an item outside the key's grant is NOT_FOUND
    // whatever else the call gets wrong, so validation errors never tell it apart (T205).
    checkNamedItems(spec, reach, args && typeof args === "object" ? args as Record<string, unknown> : {});
    const parsed = spec.inputSchema.safeParse(args ?? {});
    // Each detail names its argument (review Q4): "cardId: Invalid UUID".
    if (!parsed.success) return errorResult("INVALID", "Invalid arguments", { details: issueDetails(parsed.error.issues) });
    // Handlers read chosen items from `grants` (keyReach, keyFilter). `scopes` keeps only the
    // scopes the key holds over every item, so any older path that reads scopes alone stays closed
    // for a scope limited to chosen items (T203).
    const handlerKey: McpKeyContext = { ...(key.grants?.every((grant) => grant.resourceKind === null) ? key : { ...key, scopes: wholeModuleScopes(key) }), surface };
    const result = await withSurfaceAuditContext(surface === "rest" ? { via: "rest" } : null, () => spec.handler(parsed.data, handlerKey));
    return textResult(result);
  } catch (error) {
    if (error instanceof McpToolError) return errorResult(error.code, error.message, error.details);
    console.error(`MCP tool ${spec.name} failed`, error instanceof Error ? error.name : "Unknown error");
    return errorResult("INTERNAL", "Something went wrong");
  }
}

// ---------------------------------------------------------------- notes:read

const listNotesSql = (keyCondition: string) => `
  SELECT n.id, v.title, n.current_version, n.updated_at, u.display_name AS owner_name,
         CASE WHEN n.owner_id = $userId THEN 1 ELSE 0 END AS is_owner
  FROM notes n JOIN users u ON u.id = n.owner_id
  JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version
  WHERE n.deleted_at IS NULL AND n.current_version > 0 AND ${readableNotePredicate} AND ${keyCondition}
  ORDER BY n.updated_at DESC LIMIT 200
`;
const listNotesQuery = db.query(listNotesSql("1"));

/** Where a note sits, for a key limited to chosen notes or folders (Wave 34): the note itself or its immediate folder. */
export const NOTE_ANCHOR_COLUMNS = { note: "n.id", folder: "n.folder_id" } as const;
/** The same for Files documents (alias `d`). */
export const DOCUMENT_ANCHOR_COLUMNS = { document: "d.id", folder: "d.folder_id" } as const;

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
    access: { mode: "list", lists: ["note"] },
    write: false,
    inputSchema: z.object({ query: z.string().max(120).optional().describe("Optional case-insensitive title filter") }),
    handler: ({ query }, key) => {
      const search = query?.trim().toLowerCase() ?? "";
      // A key limited to chosen notes or folders is narrowed in SQL, before the LIMIT (T203).
      const scope = keyFilter(key, "notes:read", NOTE_ANCHOR_COLUMNS);
      const statement = scope.sql === "1" ? listNotesQuery : db.query(listNotesSql(scope.sql));
      const notes = statement.all({ ...scope.params, userId: key.userId }) as Array<Record<string, unknown> & { title: string }>;
      return { notes: search ? notes.filter((note) => note.title.toLowerCase().includes(search)) : notes };
    }
  }),
  defineTool({
    name: "read_note",
    title: "Read a note",
    description: "Read the latest published Markdown for a note visible to the authenticated Nook user.",
    scopes: ["notes:read"],
    access: { mode: "items", items: [{ arg: "noteId", kind: "note" }] },
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
    access: { mode: "list", lists: ["note"], items: [{ arg: "folderId", kind: "folder", ifAbsent: "allow" }] },
    write: false,
    inputSchema: z.object({
      query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Words to find; quote a phrase with double quotes"),
      folderId: z.string().uuid().optional().describe("Only notes in this folder"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum results, 1 to 20 (default 10)")
    }),
    handler: ({ query, folderId, limit }, key) => searchPublishedNotes(key.userId, query, { folderId: folderId ?? null, limit: limit ?? 10, keyScope: keyFilter(key, "notes:read", NOTE_ANCHOR_COLUMNS) })
  }),
  defineTool({
    name: "list_folders",
    title: "List folders",
    description: "List the folders the user owns or that are shared with them, as the Nook web app shows them.",
    scopes: ["notes:read", "files:read"],
    access: { mode: "list", lists: ["folder"] },
    write: false,
    inputSchema: z.object({}),
    handler: (_args, key) => {
      // Folders are listed whole (no LIMIT); a key limited to chosen folders sees only those.
      const reach = keyReachAny(key, ["notes:read", "files:read"]);
      const folders = listReadableFolders(key.userId);
      return { folders: reach === "all" ? folders : folders.filter((folder) => reach !== null && selectionHas(reach, "folder", folder.id)) };
    }
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
    access: { mode: "items", items: [{ arg: "folderId", kind: "folder" }] },
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
    access: { mode: "items", items: [{ arg: "noteId", kind: "note" }] },
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
    access: { mode: "items", items: [{ arg: "noteId", kind: "note" }] },
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
    access: { mode: "list", lists: ["document"], items: [{ arg: "folderId", kind: "folder", ifAbsent: "allow" }] },
    write: false,
    inputSchema: z.object({ folderId: z.string().uuid().optional().describe("Only files in this folder") }),
    handler: ({ folderId }, key) => ({ documents: listReadableDocuments(key.userId, folderId ?? null, keyFilter(key, "files:read", DOCUMENT_ANCHOR_COLUMNS)) })
  }),
  defineTool({
    name: "get_document_metadata",
    title: "Get file details",
    description: "Name, type, size, folder, owner, and sharing of one file the user can see in Nook Files.",
    scopes: ["files:read"],
    access: { mode: "items", items: [{ arg: "documentId", kind: "document" }] },
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
    access: { mode: "items", items: [{ arg: "documentId", kind: "document" }] },
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
  ...inboxTools,
  ...whiteboardTools
];

/** Whether a key holding `scopes` may see and call `spec`: any one of its scopes and all of alsoRequires (D172). */
export const toolAllowed = (spec: McpToolSpec, scopes: McpKeyContext["scopes"]) => hasAnyScope(scopes, spec.scopes) && hasAllScopes(scopes, spec.alsoRequires);

/** Whether `key` may see and call `spec` with its grants (scopes plus chosen items, D281). */
export function toolVisible(spec: McpToolSpec, key: McpKeyContext) {
  const reach = reachOf(spec, key);
  return reach !== null && toolFits(spec, reach);
}

/** The scopes the key holds over every resource of the module (not only chosen items). */
function wholeModuleScopes(key: McpKeyContext): McpScope[] {
  const grants = key.grants ?? grantsForScopes(key.scopes);
  return key.scopes.filter((scope) => scopeReach(grants, scope) === "all");
}

/** The tools a key may see now, in registration order (MCP tools/list and REST GET /api/v1/tools). */
export const visibleTools = (key: McpKeyContext) => mcpToolSpecs.filter((spec) => toolVisible(spec, key));

/** Registers the tools this key may use on a per-request server. */
export function registerMcpTools(server: McpServer, key: McpKeyContext) {
  for (const spec of visibleTools(key)) {
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: { readOnlyHint: !spec.write, destructiveHint: false, idempotentHint: !spec.write, openWorldHint: false }
    }, (args: unknown) => runTool(spec, args, key.keyId));
  }
}

/** Test hook: call a tool by name without the scope-based registration, to prove the handler re-check. */
export function invokeMcpToolForTests(name: string, args: unknown, keyId: string, surface: KeySurface = "mcp") {
  const spec = mcpToolSpecs.find((item) => item.name === name);
  if (!spec) throw new Error(`Unknown MCP tool ${name}`);
  return runTool(spec, args, keyId, surface);
}
