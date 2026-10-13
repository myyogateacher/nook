import { audit, db, now, type DocumentRow } from "../db";
import { readableDocumentPredicate } from "../documentAccess";
import { purgeAfterFrom } from "../bin";
import { sourceAccessChangedHook } from "../knowledge/hooks";
import { HOSTS, type HostKind, type HostSpec, type LinkRow } from "./hosts";
import { linkChanged, recordRemovedLink } from "./undoTickets";

/**
 * The attachment service (uploads everywhere plan D390–D396, D408, D409, T340–T342, T351): the
 * per-person Attachments system folder, the generic link table, and the lifecycle rules. Module
 * slices (U1–U7) call these functions; they never write `attachment_links` or `folders.system_kind`
 * themselves.
 */

export const ATTACHMENTS_FOLDER_KIND = "attachments";
export const ATTACHMENTS_FOLDER_NAME = "Attachments";

export class AttachmentError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AttachmentError";
  }
  get body() {
    return { error: this.message, code: this.code, ...this.details };
  }
}

// ------------------------------------------------------------------------------ the system folder

export const SYSTEM_FOLDER_MESSAGE = "The Attachments folder is managed by Nook: it cannot be shared, renamed, moved, or deleted, and nothing can be created or moved into it";
export const SYSTEM_FOLDER_BODY = { error: SYSTEM_FOLDER_MESSAGE, code: "SYSTEM_FOLDER" } as const;

/** The folder's system kind (`attachments`), or null for an ordinary folder or none. */
export function systemFolderKind(folderId: string | null | undefined): string | null {
  if (!folderId) return null;
  return (db.query("SELECT system_kind FROM folders WHERE id = ?").get(folderId) as { system_kind: string | null } | null)?.system_kind ?? null;
}

export const isSystemFolder = (folderId: string | null | undefined) => systemFolderKind(folderId) !== null;

/** Throws 400 SYSTEM_FOLDER when `folderId` is a system folder (T342). */
export function refuseSystemFolder(folderId: string | null | undefined) {
  if (isSystemFolder(folderId)) throw new AttachmentError(400, "SYSTEM_FOLDER", SYSTEM_FOLDER_MESSAGE);
}

/** Whether `error` is the 046 trigger's refusal (the database backstop behind the route checks). */
export const isSystemFolderError = (error: unknown) => error instanceof Error && /\bSYSTEM_FOLDER\b/.test(error.message) && !(error instanceof AttachmentError);

/**
 * The name a new system folder gets: "Attachments", or "Attachments (Nook)" when the person already
 * has an ordinary root folder called "Attachments" (any case; review L1), so the two never look alike.
 */
function systemFolderName(userId: string, kind: string) {
  const base = kind === ATTACHMENTS_FOLDER_KIND ? ATTACHMENTS_FOLDER_NAME : kind;
  const taken = db.query("SELECT 1 FROM folders WHERE owner_id = ? AND parent_id IS NULL AND system_kind IS NULL AND name = ? COLLATE NOCASE").get(userId, base);
  return taken ? `${base} (Nook)` : base;
}

/**
 * The person's system folder of `kind`, created on first use (D391): "Attachments", at the root,
 * private. Concurrent first uses share one folder (the partial unique index decides).
 */
export function ensureSystemFolder(userId: string, kind: string = ATTACHMENTS_FOLDER_KIND): string {
  const existing = db.query("SELECT id FROM folders WHERE owner_id = ? AND system_kind = ?").get(userId, kind) as { id: string } | null;
  if (existing) return existing.id;
  return db.transaction(() => {
    const id = crypto.randomUUID();
    const timestamp = now();
    const inserted = db.query("INSERT OR IGNORE INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES (?, ?, NULL, ?, ?, ?, ?)")
      .run(id, userId, systemFolderName(userId, kind), timestamp, timestamp, kind);
    if (inserted.changes === 1) audit(userId, null, "folder.create", { folderId: id, systemKind: kind });
    return (db.query("SELECT id FROM folders WHERE owner_id = ? AND system_kind = ?").get(userId, kind) as { id: string }).id;
  })();
}

/** The person's Attachments folder id, or null when they have none yet (never creates it). */
export const attachmentsFolderOf = (userId: string) =>
  (db.query("SELECT id FROM folders WHERE owner_id = ? AND system_kind = ?").get(userId, ATTACHMENTS_FOLDER_KIND) as { id: string } | null)?.id ?? null;

// ------------------------------------------------------------------------------ host reads

const ctx = { documentReadable: (alias: string) => readableDocumentPredicate.replace(/\bd\./g, `${alias}.`) };

/** Whether the live host is readable by `userId` right now (the registry's SQL, checked fresh). */
export function hostReadable(kind: HostKind, hostId: string, userId: string) {
  return Boolean(db.query(`SELECT 1 AS ok WHERE ${HOSTS[kind].readableSql("$hostId", ctx)}`).get({ hostId, userId }));
}

function requireReadableHost(spec: HostSpec, hostId: string, userId: string) {
  if (!hostReadable(spec.kind, hostId, userId)) throw new AttachmentError(404, "NOT_FOUND", `${spec.noun[0]!.toUpperCase()}${spec.noun.slice(1)} not found`);
}

const LINK_SELECT: Record<HostSpec["store"], string> = {
  attachment_links: "SELECT host_kind, host_id, document_id, part_id, position, linked_by, created_at FROM attachment_links WHERE host_kind = $kind AND host_id = $hostId",
  card_attachments: "SELECT 'card' AS host_kind, card_id AS host_id, document_id, comment_id AS part_id, 0 AS position, linked_by, created_at FROM card_attachments WHERE card_id = $hostId AND $kind = 'card'",
  collection_row_attachments: "SELECT 'row' AS host_kind, row_id AS host_id, document_id, field_id AS part_id, 0 AS position, linked_by, created_at FROM collection_row_attachments WHERE row_id = $hostId AND $kind = 'row'"
};

/** Every link of one host, oldest first (no access check). */
export function hostLinks(kind: HostKind, hostId: string): LinkRow[] {
  return db.query(`${LINK_SELECT[HOSTS[kind].store]} ORDER BY position, created_at, document_id`).all({ kind, hostId }) as LinkRow[];
}

export type AttachmentView =
  | { documentId: string; removed: false; name: string; mimeType: string; previewKind: string; sizeBytes: number; partId: string | null; position: number; linkedAt: string; isOwner: boolean; inAttachmentsFolder: boolean }
  /** D409, T351: a linked file that is in its owner's Bin; hosts show "File removed" until it is restored. */
  | { documentId: string; removed: true; partId: string | null; position: number; linkedAt: string };

/**
 * The attachments of a host as `userId` sees them (404 when they cannot read the host, T340). Files
 * in the Bin come back as `removed` with no name; purged ones are gone with their link (FK cascade).
 */
export function listAttachments(kind: HostKind, hostId: string, userId: string): AttachmentView[] {
  const spec = HOSTS[kind];
  requireReadableHost(spec, hostId, userId);
  const links = hostLinks(kind, hostId);
  if (!links.length) return [];
  const marks = links.map((_, index) => `$d${index}`).join(",");
  const params = Object.fromEntries(links.map((link, index) => [`d${index}`, link.document_id]));
  const documents = new Map((db.query(`SELECT d.id, d.owner_id, d.name, d.mime_type, d.preview_kind, d.size_bytes, d.deleted_at, f.system_kind
    FROM documents d LEFT JOIN folders f ON f.id = d.folder_id WHERE d.id IN (${marks})`).all(params) as Array<{ id: string; owner_id: string; name: string; mime_type: string; preview_kind: string; size_bytes: number; deleted_at: string | null; system_kind: string | null }>)
    .map((row) => [row.id, row]));
  return links.flatMap((link): AttachmentView[] => {
    const document = documents.get(link.document_id);
    if (!document) return [];
    if (document.deleted_at) return [{ documentId: link.document_id, removed: true, partId: link.part_id, position: link.position, linkedAt: link.created_at }];
    return [{
      documentId: document.id, removed: false, name: document.name, mimeType: document.mime_type, previewKind: document.preview_kind, sizeBytes: document.size_bytes,
      partId: link.part_id, position: link.position, linkedAt: link.created_at, isOwner: document.owner_id === userId, inAttachmentsFolder: document.system_kind === ATTACHMENTS_FOLDER_KIND
    }];
  });
}

/**
 * One live document linked to a live host `userId` can read, or null (MCP read_attachment_text and the
 * host slices' own reads). Missing, unlinked, binned, and unreadable look the same.
 */
export function readableAttachment(kind: HostKind, hostId: string, documentId: string, userId: string): DocumentRow | null {
  if (!hostReadable(kind, hostId, userId)) return null;
  if (!hostLinks(kind, hostId).some((link) => link.document_id === documentId)) return null;
  return db.query("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL").get(documentId) as DocumentRow | null;
}

// ------------------------------------------------------------------------------ linking

const LINK_ANYWHERE = `(EXISTS (SELECT 1 FROM attachment_links xl WHERE xl.document_id = d.id)
  OR EXISTS (SELECT 1 FROM card_attachments xc WHERE xc.document_id = d.id)
  OR EXISTS (SELECT 1 FROM collection_row_attachments xr WHERE xr.document_id = d.id))`;

/** How many links a document has, in every link table. */
export function documentLinkCount(documentId: string) {
  return (db.query(`SELECT (SELECT COUNT(*) FROM attachment_links WHERE document_id = $id)
    + (SELECT COUNT(*) FROM card_attachments WHERE document_id = $id)
    + (SELECT COUNT(*) FROM collection_row_attachments WHERE document_id = $id) AS count`).get({ id: documentId }) as { count: number }).count;
}

/** An owned, live Files document (T341, D396): the only kind of document anyone may link. Whiteboards are not attachable. */
function linkableDocument(documentId: string, userId: string) {
  const row = db.query(`SELECT d.*, f.system_kind FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
    WHERE d.id = ? AND d.owner_id = ? AND d.deleted_at IS NULL AND d.purpose = 'file' AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)`)
    .get(documentId, userId) as (DocumentRow & { system_kind: string | null }) | null;
  return row;
}

export type LinkInput = {
  documentId: string;
  partId?: string | null;
  /**
   * The person confirmed that the host's audience will be able to open a file from Files (D396, Q2).
   * Not needed for a file in their Attachments folder, which exists only to be attached.
   */
  confirmed?: boolean;
};

/**
 * Links one of `userId`'s own documents to a declared host (POST /api/attachments, U1, U5). Refuses:
 * a host they cannot read (404) or not write (403 READ_ONLY); a document they do not own, or that is
 * binned, attachment-purpose, or a whiteboard (404, the same as missing, T341); a part on a host
 * without parts (400); a Files item outside the Attachments folder without `confirmed` (409
 * CONFIRM_REQUIRED, D396); the per-host cap (409 LIMIT_REACHED). Linking twice is idempotent.
 */
export function linkAttachment(userId: string, kind: HostKind, hostId: string, input: LinkInput) {
  const spec = HOSTS[kind];
  if (spec.linking !== "declared" || !spec.canLink) {
    throw new AttachmentError(409, spec.linking === "derived" ? "LINKS_DERIVED" : "HOST_MANAGED", spec.linking === "derived"
      ? `A ${spec.noun}'s attachments follow its content; add the file to the ${spec.noun} instead`
      : `Attach files to a ${spec.noun} from the ${spec.noun} itself`);
  }
  const partId = input.partId ?? null;
  if (partId !== null && !spec.hasParts) throw new AttachmentError(400, "INVALID", `A ${spec.noun} has no parts to attach to`);
  return db.transaction(() => {
    const refusal = spec.canLink!(userId, hostId, partId);
    if (refusal) throw new AttachmentError(refusal.status, refusal.code, refusal.message);
    const document = linkableDocument(input.documentId, userId);
    if (!document) throw new AttachmentError(404, "NOT_FOUND", "File not found");
    const existing = db.query("SELECT 1 FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?").get(kind, hostId, document.id);
    if (existing) return { documentId: document.id, created: false };
    if (document.system_kind !== ATTACHMENTS_FOLDER_KIND && input.confirmed !== true) {
      throw new AttachmentError(409, "CONFIRM_REQUIRED", `People who can open this ${spec.noun} will be able to open ${document.name}`, { documentName: document.name });
    }
    const count = (db.query("SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS last FROM attachment_links WHERE host_kind = ? AND host_id = ?").get(kind, hostId) as { count: number; last: number });
    if (count.count >= spec.caps.perHost) throw new AttachmentError(409, "LIMIT_REACHED", `A ${spec.noun} can have up to ${spec.caps.perHost} files`, { limit: spec.caps.perHost });
    db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, part_id, position, linked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(kind, hostId, document.id, partId, count.last + 1, userId, now());
    linkChanged(kind, hostId, document.id);
    audit(userId, null, "attachment.link", { hostKind: kind, hostId, documentId: document.id, ...(document.system_kind === ATTACHMENTS_FOLDER_KIND ? {} : { fromFiles: true }) });
    return { documentId: document.id, created: true };
  })();
}

const DELETE_LINK: Record<HostSpec["store"], string> = {
  attachment_links: "DELETE FROM attachment_links WHERE host_kind = $kind AND host_id = $hostId AND document_id = $documentId",
  card_attachments: "DELETE FROM card_attachments WHERE card_id = $hostId AND document_id = $documentId AND $kind = 'card'",
  collection_row_attachments: "DELETE FROM collection_row_attachments WHERE row_id = $hostId AND document_id = $documentId AND $kind = 'row'"
};

/**
 * Removes a link (DELETE /api/attachments/…).
 *
 * - **The file's owner** may always withdraw their own document from any host, of every kind,
 *   whatever their access to the host is now (review M1: a host they lost edit or read access to,
 *   or a team role lowered to viewer). Nothing about the host is checked or told: when they can no
 *   longer read the host the answer is `{}` (the route sends `{ ok: true }` only).
 * - Anyone else needs a **declared** host's `canUnlink` (events: the linker or a calendar manager
 *   while they can edit; chat messages: the chat's owner); derived and module hosts refuse.
 *
 * The last link of an Attachments-folder document moves it to its owner's Bin (D395); a Files item
 * someone linked is never binned by link changes. Unknown links answer 404.
 */
export function unlinkAttachment(userId: string, kind: HostKind, hostId: string, documentId: string): { documentBinned?: boolean } {
  const spec = HOSTS[kind];
  const ownerId = (db.query("SELECT owner_id FROM documents WHERE id = ? AND purge_started_at IS NULL").get(documentId) as { owner_id: string } | null)?.owner_id ?? null;
  if (ownerId !== null && ownerId === userId) {
    const outcome = db.transaction(() => {
      const before = hostLinks(kind, hostId).find((link) => link.document_id === documentId);
      const removed = db.query(DELETE_LINK[spec.store]).run({ kind, hostId, documentId }).changes;
      if (!removed) throw new AttachmentError(404, "NOT_FOUND", "Attachment not found");
      linkChanged(kind, hostId, documentId);
      audit(userId, null, "attachment.unlink", { hostKind: kind, hostId, documentId, asOwner: true });
      const documentBinned = binIfOrphanedAttachment(documentId, userId, { notify: false });
      // The Undo record commits with the removal (undoTickets.ts).
      if (before) rememberRemoval(userId, before, documentBinned);
      return { documentBinned };
    })();
    if (outcome.documentBinned) sourceAccessChangedHook({ kind: "document", ids: [documentId] });
    return hostReadable(kind, hostId, userId) ? outcome : {};
  }
  if (spec.linking !== "declared" || !spec.canUnlink) {
    throw new AttachmentError(409, spec.linking === "derived" ? "LINKS_DERIVED" : "HOST_MANAGED", `Remove files from the ${spec.noun} itself`);
  }
  const outcome = db.transaction(() => {
    if (!hostReadable(kind, hostId, userId)) throw new AttachmentError(404, "NOT_FOUND", "Not found");
    const link = db.query("SELECT host_kind, host_id, document_id, part_id, position, linked_by, created_at FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?")
      .get(kind, hostId, documentId) as LinkRow | null;
    if (!link) throw new AttachmentError(404, "NOT_FOUND", "Attachment not found");
    if (!spec.canUnlink!(userId, hostId, link, ownerId ?? "")) throw new AttachmentError(403, "READ_ONLY", "You cannot remove this file");
    db.query("DELETE FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?").run(kind, hostId, documentId);
    linkChanged(kind, hostId, documentId);
    audit(userId, null, "attachment.unlink", { hostKind: kind, hostId, documentId });
    const documentBinned = binIfOrphanedAttachment(documentId, userId, { notify: false });
    // The Undo record commits with the removal (undoTickets.ts).
    rememberRemoval(userId, link, documentBinned);
    return { documentBinned };
  })();
  if (outcome.documentBinned) sourceAccessChangedHook({ kind: "document", ids: [documentId] });
  return { documentBinned: outcome.documentBinned };
}

/** Keeps the removed link for the remover's Undo (undoTickets.ts, POST /api/attachments/relink). Call inside the removal's transaction. */
export function rememberRemoval(userId: string, link: LinkRow, binned: boolean) {
  recordRemovedLink(userId, link.host_kind as HostKind, link.host_id, link.document_id, { partId: link.part_id, position: link.position, linkedBy: link.linked_by, createdAt: link.created_at, binned });
}

/** A document a derived host could newly link: one of the actor's own live Files documents. */
export type LinkCandidate = { id: string; name: string; owner_id: string; system_kind: string | null };

/**
 * What a derived sync does with a referenced document the actor owns that is not linked yet
 * (v0.35.0 review, T350, T354): `link` it, `skip` it (reported in `skipped`), or ask the actor to
 * `confirm` first (reported in `confirm` and `skipped`; nothing is linked).
 */
export type LinkDecision = "link" | "skip" | "confirm";
export type LinkPolicy = (document: LinkCandidate) => LinkDecision;

export const inAttachmentsFolder = (document: Pick<LinkCandidate, "system_kind">) => document.system_kind === ATTACHMENTS_FOLDER_KIND;

/** The owner put every reference there themselves (a board only its owner saves): link all of them. */
export const linkOwnedPolicy: LinkPolicy = () => "link";
/** Someone other than the owner wrote the content (a guard: never today for boards): nothing new is linked. */
export const noNewLinksPolicy: LinkPolicy = () => "skip";
/** Content the owner did not author (a copy of someone else's board): their Attachments files only, never a Files item. */
export const attachmentsOnlyPolicy: LinkPolicy = (document) => inAttachmentsFolder(document) ? "link" : "skip";

/**
 * A person publishing (v0.35.0 review M1): their Attachments-folder files link silently (they exist
 * only to be attached); any other Files item needs their explicit confirm, listed in `confirmed`,
 * because an editor may have put the reference in the shared draft.
 */
export const personLinkPolicy = (confirmed: Iterable<string> = []): LinkPolicy => {
  const ids = new Set([...confirmed].map((id) => id.toLowerCase()));
  return (document) => inAttachmentsFolder(document) || ids.has(document.id) ? "link" : "confirm";
};

/** A precomputed set (the boot backfill decides asynchronously, before its transaction). */
export const allowListPolicy = (allowed: ReadonlySet<string>): LinkPolicy => (document) => allowed.has(document.id) ? "link" : "skip";

export type DerivedLinkPlan = {
  /** The documents the host will link, in reference order (kept and new). */
  wanted: string[];
  /** Referenced ids that will not be linked: someone else's, missing, binned, refused by the policy, past the cap. */
  skipped: string[];
  /** The actor's own referenced files in their Bin (review M3). */
  binned: string[];
  /** The actor's own files the policy wants confirmed first (not linked). */
  confirm: Array<{ documentId: string; name: string }>;
};

/**
 * What `syncDerivedLinks` would do, without writing (the publish route checks for files that need a
 * confirm before it stages a version). Read-only; call inside the host's lock.
 */
export function planDerivedLinks(kind: HostKind, hostId: string, actorId: string, documentIds: readonly string[], policy: LinkPolicy = linkOwnedPolicy): DerivedLinkPlan {
  const spec = HOSTS[kind];
  const current = new Set(hostLinks(kind, hostId).map((link) => link.document_id));
  const plan: DerivedLinkPlan = { wanted: [], skipped: [], binned: [], confirm: [] };
  const binnedOwned = db.query("SELECT 1 FROM documents WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL");
  for (const raw of documentIds) {
    const id = raw.toLowerCase();
    if (plan.wanted.includes(id) || plan.skipped.includes(id)) continue;
    if (plan.wanted.length >= spec.caps.perHost) { plan.skipped.push(id); continue; }
    if (current.has(id)) { plan.wanted.push(id); continue; }
    const document = linkableDocument(id, actorId);
    const decision = document ? policy(document) : "skip";
    if (decision === "link") { plan.wanted.push(id); continue; }
    plan.skipped.push(id);
    if (decision === "confirm") plan.confirm.push({ documentId: id, name: document!.name });
    else if (!document && binnedOwned.get(id, actorId)) plan.binned.push(id);
  }
  return plan;
}

/**
 * Sets a derived host's links (notes on publish, D408; whiteboards on save, U4b). The new set is the
 * referenced documents that are already linked, plus those the actor OWNS (live Files documents, not
 * whiteboards) that `policy` allows, capped at the host's limit in reference order. Nobody's file is
 * ever linked by someone else (T350), and a policy decides which of the actor's own files may join
 * silently (T350, T354: a person's Files items need their confirm; a key's reach limits it). Links
 * that are no longer referenced are removed; documents are never binned here (an older version may
 * still show them), the sweeper handles orphans. `binned` lists the actor's own referenced files
 * that are in their Bin (review M3: show them broken, offer Restore); `confirm` lists the files the
 * policy wanted confirmed (not linked). Call inside the host's own lock; returns what changed.
 */
export function syncDerivedLinks(kind: HostKind, hostId: string, actorId: string, documentIds: readonly string[], policy: LinkPolicy = linkOwnedPolicy) {
  const spec = HOSTS[kind];
  if (spec.linking !== "derived") throw new AttachmentError(409, "HOST_MANAGED", `A ${spec.noun}'s links are not derived`);
  return db.transaction(() => {
    const current = new Set(hostLinks(kind, hostId).map((link) => link.document_id));
    const { wanted, skipped, binned, confirm } = planDerivedLinks(kind, hostId, actorId, documentIds, policy);
    const unlinked = [...current].filter((id) => !wanted.includes(id));
    for (const id of unlinked) {
      db.query("DELETE FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?").run(kind, hostId, id);
      linkChanged(kind, hostId, id);
    }
    const linked: string[] = [];
    const timestamp = now();
    wanted.forEach((id, position) => {
      if (current.has(id)) {
        db.query("UPDATE attachment_links SET position = ? WHERE host_kind = ? AND host_id = ? AND document_id = ?").run(position, kind, hostId, id);
        return;
      }
      db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, part_id, position, linked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(kind, hostId, id, null, position, actorId, timestamp);
      linkChanged(kind, hostId, id);
      linked.push(id);
    });
    if (linked.length || unlinked.length) audit(actorId, kind === "note" ? hostId : null, "attachment.sync", { hostKind: kind, hostId, linked: linked.length, unlinked: unlinked.length });
    return { linked, unlinked, skipped, binned, confirm };
  })();
}

// ------------------------------------------------------------------------------ Undo of a removal

/** A document an Undo would put back (POST /api/attachments/relink). */
type RelinkCandidate = { id: string; owner_id: string; name: string; purpose: string; deleted_at: string | null; purge_started_at: string | null; system_kind: string | null; whiteboard: number };

export type RelinkDocument = { id: string; name: string; restore: boolean; fromFiles: boolean };

/**
 * Whether `userId` may put `documentId` back on a host after removing it (the Undo of a removal),
 * under the same rules as linking it (T341, D395, D396). `removed` is the server's own record of the
 * removal (undoTickets.ts), never anything the client claims.
 *
 * - **Their own file**: a live Files document (not a whiteboard). One in their Attachments folder that
 *   is in their Bin comes back out of it (`restore`; they may always restore their own file). A Files
 *   item from elsewhere in their Bin was deleted on purpose (an unlink never bins it): 409 IN_BIN. A
 *   Files item outside the Attachments folder needs the D396 confirm, which only a removal record
 *   proves was given: without one, 409 CONFIRM_REQUIRED, as POST /api/attachments answers.
 * - **Someone else's file**: only when this person removed that exact link moments ago (the record):
 *   Undo restores the link its owner made and never makes a new one. Without a record it is the
 *   same 404 as a missing file (nobody probes other people's files). A file in its owner's Bin
 *   cannot come back (only its owner may restore it): 409 IN_OWNERS_BIN.
 */
export function relinkableDocument(documentId: string, userId: string, removed: { binned: boolean } | null): RelinkDocument {
  const document = db.query(`SELECT d.id, d.owner_id, d.name, d.purpose, d.deleted_at, d.purge_started_at, f.system_kind,
      EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id) AS whiteboard
    FROM documents d LEFT JOIN folders f ON f.id = d.folder_id WHERE d.id = ?`).get(documentId.toLowerCase()) as RelinkCandidate | null;
  if (!document || document.purge_started_at !== null || document.purpose !== "file" || document.whiteboard === 1) throw new AttachmentError(404, "NOT_FOUND", "File not found");
  const attachment = document.system_kind === ATTACHMENTS_FOLDER_KIND;
  if (document.owner_id !== userId) {
    if (!removed) throw new AttachmentError(404, "NOT_FOUND", "File not found");
    if (document.deleted_at !== null) throw new AttachmentError(409, "IN_OWNERS_BIN", "This file is in its owner's Bin. Only they can restore it.");
    return { id: document.id, name: document.name, restore: false, fromFiles: !attachment };
  }
  // In the Bin for another reason than this removal (deleted from Files on purpose): the Bin's to restore.
  if (document.deleted_at !== null && (!attachment || (removed && !removed.binned))) {
    throw new AttachmentError(409, "IN_BIN", `${document.name} is in your Bin. Restore it from the Bin first.`, { documentName: document.name });
  }
  if (!attachment && !removed) {
    throw new AttachmentError(409, "CONFIRM_REQUIRED", `Attach ${document.name} again from Files`, { documentName: document.name });
  }
  return { id: document.id, name: document.name, restore: document.deleted_at !== null, fromFiles: !attachment };
}

/**
 * Takes the caller's own Attachments-folder file out of their Bin for an Undo (inside the caller's
 * transaction; the Bin's restore rule, owner only, for a file that goes back to its own folder,
 * restoreKeptFolder). Returns whether it restored; tell knowledge bases after the commit.
 */
export function restoreForRelink(documentId: string, userId: string) {
  const restored = db.query(`UPDATE documents SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?
    WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL
      AND folder_id IN (SELECT id FROM folders WHERE owner_id = ? AND system_kind = '${ATTACHMENTS_FOLDER_KIND}')`).run(now(), documentId, userId, userId).changes === 1;
  if (restored) audit(userId, null, "document.restore", { documentId, reason: "attachment_undo" });
  return restored;
}

export type RelinkOutcome = { relinked: boolean; restored: boolean };
export type RemovalRecord = { partId: string | null; position: number; linkedBy: string | null; createdAt: string; binned: boolean };

/**
 * The Undo of a removal on a declared host (events, chat messages): the host's own link rule
 * (`canLink`: a stranger gets 404, someone who can only read it 403 READ_ONLY), the document rule
 * above, the per-host cap, then the link back at its old position (or at the end without a record).
 * Linking what is already linked changes nothing (idempotent).
 */
export function relinkDeclared(userId: string, kind: HostKind, hostId: string, documentId: string, removal: () => RemovalRecord | null): RelinkOutcome {
  const spec = HOSTS[kind];
  if (spec.linking !== "declared" || !spec.canLink) throw new AttachmentError(409, "HOST_MANAGED", `Files on a ${spec.noun} cannot be put back this way`);
  const outcome = db.transaction((): RelinkOutcome => {
    const refusal = spec.canLink!(userId, hostId, null);
    if (refusal) throw new AttachmentError(refusal.status, refusal.code, refusal.message);
    if (db.query("SELECT 1 FROM attachment_links WHERE host_kind = ? AND host_id = ? AND document_id = ?").get(kind, hostId, documentId)) return { relinked: false, restored: false };
    const removed = removal();
    const document = relinkableDocument(documentId, userId, removed);
    const count = db.query("SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS last FROM attachment_links WHERE host_kind = ? AND host_id = ?").get(kind, hostId) as { count: number; last: number };
    if (count.count >= spec.caps.perHost) throw new AttachmentError(409, "LIMIT_REACHED", `A ${spec.noun} can have up to ${spec.caps.perHost} files`, { limit: spec.caps.perHost });
    const restored = document.restore && restoreForRelink(document.id, userId);
    if (document.restore && !restored) throw new AttachmentError(409, "PURGING", "This file is being deleted from the Bin");
    db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, part_id, position, linked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(kind, hostId, document.id, removed?.partId ?? null, removed ? removed.position : count.last + 1, removed?.linkedBy ?? userId, removed?.createdAt ?? now());
    linkChanged(kind, hostId, document.id);
    audit(userId, null, "attachment.relink", { hostKind: kind, hostId, documentId: document.id, ...(restored ? { restored: true } : {}) });
    return { relinked: true, restored };
  })();
  if (outcome.restored) sourceAccessChangedHook({ kind: "document", ids: [documentId] });
  return outcome;
}

// ------------------------------------------------------------------------------ lifecycle

/**
 * D395: moves a live document in its owner's Attachments folder to their Bin when nothing links it
 * any more. Documents anywhere else (a Files item someone linked, or one moved out) are never binned
 * by link changes. Call inside the caller's transaction; returns whether it binned.
 */
export function binIfOrphanedAttachment(documentId: string, actorId: string | null = null, options: { notify?: boolean } = {}) {
  const row = db.query(`SELECT d.id, d.owner_id FROM documents d JOIN folders f ON f.id = d.folder_id AND f.system_kind = '${ATTACHMENTS_FOLDER_KIND}'
    WHERE d.id = ? AND d.deleted_at IS NULL AND d.purge_started_at IS NULL AND NOT ${LINK_ANYWHERE}`).get(documentId) as { id: string; owner_id: string } | null;
  if (!row) return false;
  const deletedAt = new Date();
  const changed = db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL")
    .run(deletedAt.toISOString(), row.owner_id, purgeAfterFrom(deletedAt), row.id).changes === 1;
  if (changed) audit(actorId ?? row.owner_id, null, "document.delete", { documentId: row.id, reason: "attachment_unlinked" });
  if (changed && options.notify !== false) sourceAccessChangedHook({ kind: "document", ids: [row.id] });
  return changed;
}

/**
 * "Where is this file used?" for its owner (D409, T351): the hosts the owner can read, by kind, with
 * a title, and the others (hosts the owner cannot open, such as a card on a board that stopped being
 * shared with them) by kind and id only. 404 for anyone but the owner.
 */
export function documentUsage(documentId: string, ownerId: string) {
  const owned = db.query("SELECT id FROM documents WHERE id = ? AND owner_id = ? AND purge_started_at IS NULL").get(documentId, ownerId);
  if (!owned) throw new AttachmentError(404, "NOT_FOUND", "File not found");
  const links = db.query(`SELECT host_kind, host_id FROM attachment_links WHERE document_id = $id
    UNION ALL SELECT 'card', card_id FROM card_attachments WHERE document_id = $id
    UNION ALL SELECT 'row', row_id FROM collection_row_attachments WHERE document_id = $id`).all({ id: documentId }) as Array<{ host_kind: string; host_id: string }>;
  const uses: Array<{ hostKind: HostKind; hostId: string; title: string | null }> = [];
  // Review M1: the places the owner can no longer open, by id only (no title), so Files can offer
  // "Remove from places you can't open" (the owner may always unlink their own file).
  const hidden: Array<{ hostKind: HostKind; hostId: string }> = [];
  let hiddenCount = 0;
  for (const link of links) {
    const spec = (HOSTS as Record<string, HostSpec | undefined>)[link.host_kind];
    if (spec && hostReadable(spec.kind, link.host_id, ownerId)) uses.push({ hostKind: spec.kind, hostId: link.host_id, title: spec.title(link.host_id) });
    else {
      hiddenCount += 1;
      if (spec) hidden.push({ hostKind: spec.kind, hostId: link.host_id });
    }
  }
  return { uses, hidden, hiddenCount, total: links.length };
}
