import * as z from "zod/v4";
import { ownedNote } from "./access";
import { restoreItem } from "./bin";
import { config } from "./config";
import { db, withAuditContext } from "./db";
import { createFolder, FolderError } from "./folders";
import { forgetSeenDraft, seenDraft } from "./mcpSeenDrafts";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, notFound, restoreResult, type McpErrorCode, type McpKeyContext, type McpToolSpec } from "./mcpToolKit";
import { DraftActionError, moveNoteToBin, publishDraft } from "./noteDrafts";
import { withNoteLock } from "./storage";
import { folderSchema } from "./validation";

/**
 * Wave 19 note and folder writes over MCP (docs/plan/WAVES_18-20_SMALL.md §2.3): publish a draft
 * this key has read (notes:publish, D173), create a private folder, and bin or restore an owned note
 * (bin:write together with notes:write-draft, D174). Every write runs as the key's owner through the
 * same services as the HTTP routes and is audited with `{via: "mcp", keyId}`.
 */

const uuid = z.string().uuid();
const noteUrl = (noteId: string) => `${config.appOrigin}/notes/${noteId}`;
const viaKey = <T>(key: McpKeyContext, operation: () => T) => withAuditContext({ via: "mcp", keyId: key.keyId }, operation);

/** Who can read the note now: its own sharing when it overrides its folder, else its folder's. */
function noteAudience(noteId: string): "private" | "shared" {
  const row = db.query(`SELECT CASE WHEN n.sharing_override = 1 THEN n.visibility ELSE COALESCE(f.visibility, 'private') END AS visibility
    FROM notes n LEFT JOIN folders f ON f.id = n.folder_id WHERE n.id = ?`).get(noteId) as { visibility: string } | null;
  return row && row.visibility !== "private" ? "shared" : "private";
}

function draftActionToMcp(error: DraftActionError) {
  const code = typeof error.body.code === "string" ? error.body.code : undefined;
  const known: Partial<Record<string, McpErrorCode>> = { NO_DRAFT: "NO_DRAFT", NO_CHANGES: "NO_CHANGES", DRAFT_CHANGED: "DRAFT_CHANGED" };
  const mapped = (code ? known[code] : undefined) ?? (error.status === 404 ? "NOT_FOUND" : "INVALID");
  return new McpToolError(mapped, error.message, typeof error.body.currentRevision === "number" ? { currentRevision: error.body.currentRevision } : undefined);
}

export const noteManageTools: McpToolSpec[] = [
  defineTool({
    name: "publish_note_draft",
    title: "Publish a note's draft",
    description: "Makes the draft the note's published text (a new version), visible to everyone the note is shared with. Only for notes the user owns. Call get_note_draft first and pass its revision: a revision this key was not shown fails with DRAFT_NOT_SEEN, and a draft that changed since you read it fails with DRAFT_CHANGED. Returns the new version and whether the note is private or shared.",
    scopes: ["notes:publish"],
    write: true,
    buckets: ["note_publish"],
    inputSchema: z.object({ noteId: uuid, revision: z.number().int().min(1).describe("The revision get_note_draft returned") }).strict(),
    handler: async ({ noteId, revision }, key) => {
      try {
        const published = await viaKey(key, () => publishDraft(key.userId, noteId, revision, {
          verify: (note) => {
            const seen = seenDraft(key.keyId, noteId);
            if (!seen || seen.revision !== revision) {
              throw new McpToolError("DRAFT_NOT_SEEN", "This key has not read this revision of the draft. Read it with get_note_draft first.");
            }
            if (note.draft_revision !== revision || note.draft_checksum !== seen.checksum) {
              throw new McpToolError("DRAFT_CHANGED", "The draft changed since this key read it. Read it again with get_note_draft.", { currentRevision: note.draft_revision });
            }
          }
        }));
        forgetSeenDraft(key.keyId, noteId);
        return { noteId, version: published.version, publishedAt: published.publishedAt, audience: noteAudience(noteId), url: noteUrl(noteId) };
      } catch (error) {
        if (error instanceof DraftActionError) throw draftActionToMcp(error);
        throw error;
      }
    }
  }),
  defineTool({
    name: "create_folder",
    title: "Create a folder",
    description: "Create a folder the user owns, at the top level or inside a folder they own. The new folder is private: it never takes its parent's sharing. \"Default\" is taken (NAME_TAKEN).",
    scopes: ["notes:write-draft", "files:write"],
    write: true,
    buckets: ["structure_write"],
    inputSchema: z.object({ name: z.string().min(1).max(120), parentId: uuid.optional().describe("A folder the user owns") }).strict(),
    handler: ({ name, parentId }, key) => {
      const parsed = folderSchema.safeParse({ name, parentId });
      if (!parsed.success) throw new McpToolError("INVALID", "Invalid arguments", { details: parsed.error.issues.map((issue) => issue.message) });
      try {
        return { folder: viaKey(key, () => createFolder(key.userId, parsed.data.name, parsed.data.parentId ?? null)) };
      } catch (error) {
        if (error instanceof FolderError) throw error.code === "NAME_TAKEN" ? new McpToolError("NAME_TAKEN", error.message) : notFound("Folder");
        throw error;
      }
    }
  }),
  defineTool({
    name: "bin_note",
    title: "Move a note to the Bin",
    description: `Move a note the user owns to the Bin, with its drafts, versions, and sharing. ${BIN_DESCRIPTION} Restore it with restore_note.`,
    scopes: ["notes:write-draft"],
    alsoRequires: ["bin:write"],
    write: true,
    buckets: BIN_BUCKETS,
    inputSchema: z.object({ noteId: uuid }).strict(),
    handler: ({ noteId }, key) => viaKey(key, () => withNoteLock(noteId, async () => {
      const note = ownedNote(noteId, key.userId);
      if (!note) throw notFound();
      // Always the Bin, even for a blank never-published note (no D12 purge over MCP, D174).
      const { purgeAfter } = moveNoteToBin(note, key.userId);
      forgetSeenDraft(key.keyId, noteId);
      return { noteId, binned: true, purgeAfter };
    }))
  }),
  defineTool({
    name: "restore_note",
    title: "Restore a note from the Bin",
    description: "Restore a note the user owns from the Bin to its folder (or Default when that folder is gone). Its earlier sharing applies again.",
    scopes: ["notes:write-draft"],
    alsoRequires: ["bin:write"],
    write: true,
    inputSchema: z.object({ noteId: uuid }).strict(),
    handler: async ({ noteId }, key) => ({ noteId, ...restoreResult(await viaKey(key, () => restoreItem("note", noteId, key.userId)), "Note"), url: noteUrl(noteId) })
  })
];
