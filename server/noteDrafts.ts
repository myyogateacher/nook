import { editableNote, ownedNote } from "./access";
import { purgeAfterFrom, purgeLocked } from "./bin";
import { audit, db, ensureDefaultFolder, now, type NoteRow } from "./db";
import { config } from "./config";
import { recordNoteDraftProposal, rejectEffectFor, resolveNoteDraftProposals, type DraftBase, type ProposalBaseRow, type RejectEffect } from "./inbox/noteDraftProposals";
import { indexNote, unindexNote } from "./searchIndex";
import { checksum, storage, withNoteLock } from "./storage";
import { deriveNoteTitle } from "./validation";

/**
 * Draft writes shared by the HTTP routes and the MCP tools, so both keep the
 * same revision CAS, title derivation, and same-transaction search index sync
 * (docs/plan/WAVES_7-9.md §2.2, §4.2).
 */

export function hasDraftDelta(note: Pick<NoteRow, "id" | "current_version">, draftChecksum: string) {
  if (note.current_version === 0) return draftChecksum !== checksum("");
  const published = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?")
    .get(note.id, note.current_version) as { checksum: string } | null;
  if (!published) throw new Error("Published version metadata is missing");
  return draftChecksum !== published.checksum;
}

export type DraftWriteResult = { revision: number; title: string; hasDelta: boolean; savedAt: string; proposalId?: string };

/**
 * Writes `markdown` as the draft of `note` (the owner's, or an editor's since Wave 32, D274: one
 * shared draft per note, CAS on draft_revision), which must have been read under the note lock. The caller has already compared the expected revision
 * with `note.draft_revision`; the UPDATE re-checks it, so a lost race returns
 * null and nothing is indexed.
 *
 * `mcpKeyId` records the MCP key that wrote the draft (the "Draft by <key>"
 * badge). Human writes pass undefined and leave any earlier value alone:
 * the draft still holds that key's text until it is published or discarded.
 */
export async function writeDraftLocked(note: NoteRow, userId: string, markdown: string, mcpKeyId?: string): Promise<DraftWriteResult | null> {
  const nextRevision = (note.draft_revision ?? 0) + 1;
  const title = deriveNoteTitle(markdown);
  // An agent's write records the draft it replaces, so rejecting it can give that draft back (H1).
  const base = mcpKeyId === undefined ? null : await draftBase(note);
  await storage.writeDraft(note.id, markdown);
  const draftChecksum = checksum(markdown);
  const savedAt = now();
  let proposalId: string | undefined;
  const saved = db.transaction(() => {
    const result = mcpKeyId === undefined
      ? db.query("UPDATE notes SET title = ?, draft_revision = ?, draft_checksum = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND draft_revision IS ?")
        .run(title, nextRevision, draftChecksum, savedAt, note.id, note.owner_id, note.draft_revision)
      : db.query("UPDATE notes SET title = ?, draft_revision = ?, draft_checksum = ?, draft_mcp_key_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND draft_revision IS ?")
        .run(title, nextRevision, draftChecksum, mcpKeyId, savedAt, note.id, note.owner_id, note.draft_revision);
    if (result.changes !== 1) return false;
    indexNote(note.id, "draft", title, markdown, draftChecksum);
    // An agent's draft is its pending note_draft proposal in the inbox (D149); human saves leave it.
    if (mcpKeyId !== undefined) proposalId = recordNoteDraftProposal({ ownerId: userId, noteId: note.id, keyId: mcpKeyId, revision: nextRevision, created: note.current_version === 0, title, base: base! });
    return true;
  })();
  if (!saved) return null;
  return { revision: nextRevision, title, hasDelta: hasDraftDelta(note, draftChecksum), savedAt, ...(proposalId ? { proposalId } : {}) };
}

/**
 * The draft of `note` as it is before a write: its revision, exact text, and the key that wrote
 * it. The text is kept only when it passes the checksum and fits the draft size limit; otherwise
 * it is null and a reject keeps whatever draft is there. Call under the note lock.
 */
async function draftBase(note: NoteRow): Promise<DraftBase> {
  if (note.draft_revision === null) return { state: "none" };
  let markdown: string | null = null;
  try {
    const text = await storage.readDraft(note.id);
    if (note.draft_checksum && checksum(text) === note.draft_checksum && Buffer.byteLength(text, "utf8") <= config.maxMarkdownBytes) markdown = text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { state: "draft", revision: note.draft_revision, markdown, keyId: note.draft_mcp_key_id };
}

/**
 * Creates a never-published note whose draft is `markdown`, in `folderId` (the
 * caller checked ownership) or the owner's Default folder. The draft is
 * indexed in the insert's transaction. Audited as `note.create`, or as
 * `mcp.note_create` with the key when an MCP key created it.
 */
export async function createDraftNote(userId: string, folderId: string | null, markdown: string, mcp?: { keyId: string }) {
  const id = crypto.randomUUID();
  const timestamp = now();
  const title = markdown === "" ? "New note" : deriveNoteTitle(markdown);
  const targetFolderId = folderId ?? ensureDefaultFolder(userId);
  const draftChecksum = checksum(markdown);
  await storage.writeDraft(id, markdown);
  let proposalId: string | undefined;
  db.transaction(() => {
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, draft_revision, draft_checksum, draft_mcp_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
      .run(id, userId, targetFolderId, title, draftChecksum, mcp?.keyId ?? null, timestamp, timestamp);
    if (markdown !== "") indexNote(id, "draft", title, markdown, draftChecksum);
    if (mcp) {
      audit(userId, id, "mcp.note_create", { via: "mcp", keyId: mcp.keyId });
      proposalId = recordNoteDraftProposal({ ownerId: userId, noteId: id, keyId: mcp.keyId, revision: 1, created: true, title, base: { state: "none" } });
    } else {
      audit(userId, id, "note.create");
    }
  })();
  return { id, title, folderId: targetFolderId, revision: 1, ...(proposalId ? { proposalId } : {}) };
}

/** Error class and errno code for logs. Messages can carry paths, so they are never logged. */
function errorClass(error: unknown) {
  if (!(error instanceof Error)) return "Unknown error";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? `${error.name} (${code})` : error.name;
}

/**
 * A note is blank when it was never published and has no draft, or only a
 * whitespace draft (the client's `markdown.trim() === ""` check). The draft is
 * read, not inferred from its checksum. Call under the note lock.
 */
export async function isBlankNote(note: NoteRow) {
  if (note.current_version !== 0) return false;
  if (note.draft_revision === null) return true;
  try {
    return (await storage.readDraft(note.id)).trim() === "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Moves a live note to the Bin for 30 days. Drafts, versions, files, and shares are kept. Call under the note lock. */
export function moveNoteToBin(note: NoteRow, userId: string) {
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  db.transaction(() => {
    const result = db.query("UPDATE notes SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
      .run(deletedAt.toISOString(), userId, purgeAfter, note.id, userId);
    if (result.changes !== 1) throw new Error("Concurrent note update detected");
    audit(userId, note.id, "note.delete");
  })();
  return { ok: true as const, purgeAfter };
}

/** D12: blank never-published notes skip the Bin and are purged at once. Call under the note lock. */
export async function purgeBlankNote(note: NoteRow, userId: string) {
  const timestamp = now();
  const result = db.query("UPDATE notes SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
    .run(timestamp, userId, timestamp, note.id, userId);
  if (result.changes !== 1) throw new Error("Concurrent note update detected");
  const outcome = await purgeLocked("note", note.id, { reason: "blank", actorId: userId, ownerId: userId });
  // A pending purge is already unreadable; the sweeper finishes removing it.
  return outcome === "pending" ? { ok: true as const, purged: true as const, pending: true as const } : { ok: true as const, purged: true as const };
}

/** A refused draft publish or discard, with the HTTP status and body the notes routes answer. */
export class DraftActionError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly body: Record<string, unknown>) {
    super(message);
    this.name = "DraftActionError";
  }
}

/**
 * Publishes the owner's draft of `noteId` as the next version (docs/plan/WAVES_7-9.md §2.2). The
 * caller publishes the draft revision it last saw (T38): without `revision`, an older client may
 * still publish its own draft, but never one an MCP key wrote. Shared by POST
 * /api/notes/:id/publish, an approved note_draft proposal (agent inbox D149), and MCP
 * publish_note_draft (Wave 19), whose `verify` checks the key's seen-revision ledger under the note
 * lock, after the draft exists and before the revision compare (D173).
 */
export async function publishDraft(userId: string, noteId: string, revision: number | undefined, options: { verify?: (note: NoteRow) => void; allowEditors?: boolean } = {}) {
  return withNoteLock(noteId, async () => {
    // POST /api/notes/:id/publish lets editors publish too (D274); the version is authored by them.
    const note = options.allowEditors ? editableNote(noteId, userId) : ownedNote(noteId, userId);
    if (!note) throw new DraftActionError(404, "Note not found", { error: "Note not found" });
    if (note.draft_revision === null) throw new DraftActionError(409, "There is no draft to publish", { error: "There is no draft to publish", code: "NO_DRAFT" });
    options.verify?.(note);
    if (revision === undefined && note.draft_mcp_key_id !== null) {
      throw new DraftActionError(400, "Invalid request", { error: "Invalid request", details: ["revision is required to publish a draft written through MCP"] });
    }
    if (revision !== undefined && revision !== note.draft_revision) {
      throw new DraftActionError(409, "Draft changed since you last saw it", { error: "Draft changed since you last saw it", code: "DRAFT_CHANGED", currentRevision: note.draft_revision });
    }
    const markdown = await storage.readDraft(noteId);
    if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) throw new Error("Draft content failed integrity verification");
    if (!hasDraftDelta(note, note.draft_checksum)) throw new DraftActionError(409, "Draft matches the published version", { error: "Draft matches the published version", code: "NO_CHANGES" });
    const nextVersion = note.current_version + 1;
    const stagedMetadata = db.query("SELECT id FROM note_versions WHERE note_id = ? AND version_number = ?").get(noteId, nextVersion);
    if (stagedMetadata) throw new Error("Next version is already committed");
    await storage.stageVersion(noteId, nextVersion, markdown, true);
    const timestamp = now();
    const versionId = crypto.randomUUID();
    db.transaction(() => {
      db.query("INSERT INTO note_versions (id, note_id, version_number, title, checksum, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(versionId, noteId, nextVersion, note.title, checksum(markdown), userId, timestamp);
      const updated = db.query("UPDATE notes SET current_version = ?, draft_revision = NULL, draft_checksum = NULL, draft_mcp_key_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND current_version = ? AND draft_revision = ?")
        .run(nextVersion, timestamp, noteId, note.owner_id, note.current_version, note.draft_revision);
      if (updated.changes !== 1) throw new Error("Concurrent note update detected");
      indexNote(noteId, "published", note.title, markdown, note.draft_checksum!);
      unindexNote(noteId, "draft");
      resolveNoteDraftProposals(noteId, { kind: "published", revision: note.draft_revision!, userId });
    })();
    await storage.finalizePublished(noteId, markdown).catch((error) => console.error(`Could not refresh current Markdown mirror for note ${noteId}`, errorClass(error)));
    audit(userId, noteId, "note.publish", { version: nextVersion, ...(note.owner_id !== userId ? { editor: true } : {}) });
    return { version: nextVersion, publishedAt: timestamp };
  });
}

/**
 * Discards the owner's draft of `noteId`. A never-published note is deleted instead: a blank one is
 * purged, anything with content moves to the Bin with its draft intact. `expectedRevision` (a
 * rejected note_draft proposal) discards only while the draft is still that revision; otherwise
 * nothing changes and `{kept: true}` is returned.
 */
export async function discardDraft(userId: string, noteId: string, expectedRevision?: number) {
  return withNoteLock(noteId, async () => {
    const note = ownedNote(noteId, userId);
    if (!note) throw new DraftActionError(404, "Note not found", { error: "Note not found" });
    if (expectedRevision !== undefined && note.draft_revision !== expectedRevision) return { ok: true as const, kept: true as const };
    if (note.current_version === 0) {
      if (await isBlankNote(note)) {
        const purged = await purgeBlankNote(note, userId);
        db.transaction(() => resolveNoteDraftProposals(noteId, { kind: "discarded", userId }))();
        return purged;
      }
      const binned = moveNoteToBin(note, userId);
      db.transaction(() => resolveNoteDraftProposals(noteId, { kind: "discarded", userId }))();
      return { ...binned, binned: true as const };
    }
    await discardPublishedDraftLocked(note, userId);
    return { ok: true as const };
  });
}

/** Drops the draft of a published note, back to its current version. Call under the note lock. */
async function discardPublishedDraftLocked(note: NoteRow, userId: string) {
  const versionTitle = db.query("SELECT title FROM note_versions WHERE note_id = ? AND version_number = ?").get(note.id, note.current_version) as { title: string } | null;
  db.transaction(() => {
    db.query("UPDATE notes SET title = ?, draft_revision = NULL, draft_checksum = NULL, draft_mcp_key_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ?")
      .run(versionTitle?.title ?? note.title, now(), note.id, userId);
    unindexNote(note.id, "draft");
    resolveNoteDraftProposals(note.id, { kind: "discarded", userId });
  })();
  await storage.discardDraft(note.id).catch((error) => console.error(`Could not remove discarded draft for note ${note.id}`, errorClass(error)));
  audit(userId, note.id, "draft.discard");
}

export type RejectDraftOutcome = "restored" | "discarded" | "kept";

/**
 * Undoes an agent's draft write when its note_draft proposal is rejected (review H1). Decided under
 * the note lock by `rejectEffectFor`: while the draft is still the agent's `revision`, the draft
 * from before the agent's write is written back as a new revision (with the key that wrote it, if
 * any; audited `inbox.draft_restored`), or a published note with no earlier draft drops the
 * agent's draft. Otherwise nothing changes: a never-published note is never binned here, and a
 * draft someone edited since stays as it is.
 */
export async function rejectAgentDraft(userId: string, noteId: string, input: { proposalId: string; revision: number; base: ProposalBaseRow }): Promise<RejectDraftOutcome> {
  return withNoteLock(noteId, async () => {
    const note = ownedNote(noteId, userId);
    const effect: RejectEffect = rejectEffectFor(note, input.revision, input.base, true);
    if (!note || effect === "keep") return "kept";
    if (effect === "discard") {
      await discardPublishedDraftLocked(note, userId);
      return "discarded";
    }
    const saved = await writeDraftLocked(note, userId, input.base.base_draft_markdown!);
    if (!saved) return "kept";
    db.query("UPDATE notes SET draft_mcp_key_id = (SELECT id FROM mcp_api_keys WHERE id = ?) WHERE id = ? AND draft_revision = ?")
      .run(input.base.base_draft_key_id, noteId, saved.revision);
    audit(userId, noteId, "inbox.draft_restored", { proposalId: input.proposalId, revision: saved.revision, fromRevision: input.base.base_draft_revision });
    return "restored";
  });
}
