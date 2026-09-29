import { db, type DocumentRow } from "./db";
import { readableBoardPredicate } from "./tasks/access";
import type { PreviewKind } from "./mimeSniff";
import { readableCollectionPredicate } from "./collections/access";
import { AUDIENCE_ALL_USERS } from "./team/roles";
import { groupGrantExists } from "./access/groups";

export type Visibility = "private" | "selected" | "all_users";

/** The only document shape returned by the API. Never includes sha256, upload_key, paths, or deletion columns. */
export type DocumentSummary = {
  id: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  folder_id: string | null;
  name: string;
  mime_type: string;
  preview_kind: PreviewKind;
  size_bytes: number;
  visibility: Visibility;
  sharing_override: 0 | 1;
  /** A whiteboard is a Files document with a `whiteboards` row (Wave 23, D192). */
  kind: "file" | "whiteboard";
  created_at: string;
  updated_at: string;
};

/**
 * Summary columns as seen by `$userId`. Recipients get `folder_id` only when
 * the folder itself is visible to them (the GET /api/notes rule) and always
 * `sharing_override = 0`. `visibility` is the effective audience.
 */
export const documentSummarySelect = `
  SELECT d.id, d.owner_id, u.display_name AS owner_name,
         CASE WHEN d.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
         CASE WHEN d.owner_id = $userId OR (d.sharing_override = 0 AND (
           (f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (f.visibility = 'selected' AND (EXISTS (
             SELECT 1 FROM folder_shares fs WHERE fs.folder_id = f.id AND fs.user_id = $userId
           ) OR ${groupGrantExists("folder", "f.id")}))
         )) THEN d.folder_id ELSE NULL END AS folder_id,
         d.name, d.mime_type, d.preview_kind, d.size_bytes,
         CASE WHEN d.sharing_override = 0 THEN COALESCE(f.visibility, 'private') ELSE d.visibility END AS visibility,
         CASE WHEN d.owner_id = $userId THEN d.sharing_override ELSE 0 END AS sharing_override,
         CASE WHEN EXISTS (SELECT 1 FROM whiteboards wk WHERE wk.document_id = d.id) THEN 'whiteboard' ELSE 'file' END AS kind,
         d.created_at, d.updated_at
  FROM documents d JOIN users u ON u.id = d.owner_id LEFT JOIN folders f ON f.id = d.folder_id
`;

/** Summary of a live document owned by `userId`, or null. */
export function ownedDocumentSummary(documentId: string, userId: string) {
  return db.query(`${documentSummarySelect} WHERE d.id = $documentId AND d.owner_id = $userId AND d.deleted_at IS NULL`)
    .get({ documentId, userId }) as DocumentSummary | null;
}

/**
 * Documents readable by `$userId`. Mirrors the notes predicate exactly: the
 * owner; or a document-level override (all users, or selected with a share
 * row); or, when inheriting, the immediate folder's visibility and shares.
 * Folder sharing does not cascade to subfolders. Binned rows never match.
 * Sharing and folder access apply to Files documents only: an attachment is
 * readable by its owner and through its card and row links (below), nothing else.
 */
export const readableDocumentPredicate = `
  d.deleted_at IS NULL AND (
    d.owner_id = $userId
    OR (d.purpose = 'file' AND d.sharing_override = 1 AND ((d.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (d.visibility = 'selected' AND (EXISTS (
      SELECT 1 FROM document_shares s WHERE s.document_id = d.id AND s.user_id = $userId
    ) OR ${groupGrantExists("document", "d.id")}))))
    OR (d.purpose = 'file' AND d.sharing_override = 0 AND EXISTS (
      SELECT 1 FROM folders rf WHERE rf.id = d.folder_id AND (
        (rf.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (rf.visibility = 'selected' AND (EXISTS (
          SELECT 1 FROM folder_shares rfs WHERE rfs.folder_id = rf.id AND rfs.user_id = $userId
        ) OR ${groupGrantExists("folder", "rf.id")}))
      )
    ))
  )
`;

/**
 * D43: a live document linked to a live card on a board `$userId` can read. OR-ed into the single
 * document reads below and never into lists, so attachments stay out of Files and access ends the
 * moment the membership, the card, the board, or the link does (T40).
 */
const attachedToReadableCard = `(
  d.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM card_attachments ca JOIN cards c ON c.id = ca.card_id AND c.deleted_at IS NULL
    JOIN boards b ON b.id = c.board_id
    WHERE ca.document_id = d.id AND ${readableBoardPredicate}
  )
)`;

/**
 * A document linked to a live row of a collection `$userId` can read
 * (WAVES_10-12.md §3.2, D58). OR-ed into readableDocument* only, never into
 * lists: attachments stay out of Files, and access ends with the link, the
 * row, the collection, or the share (T58).
 */
const collectionAttachmentPredicate = `EXISTS (
  SELECT 1 FROM collection_row_attachments a
  JOIN collection_rows r ON r.id = a.row_id AND r.deleted_at IS NULL
  JOIN collections c ON c.id = r.collection_id
  WHERE a.document_id = d.id AND ${readableCollectionPredicate}
)`;
const readablePredicate = readableDocumentPredicate;
/** Readable by `$userId`: its own sharing, a readable card it is attached to, or a readable collection row (exported for batch checks, C10b). */
export const readableSinglePredicate = `(${readablePredicate} OR ${attachedToReadableCard} OR (d.deleted_at IS NULL AND ${collectionAttachmentPredicate}))`;

export function readableDocument(documentId: string, userId: string) {
  return db.query(`SELECT d.* FROM documents d WHERE d.id = $documentId AND ${readableSinglePredicate}`).get({ documentId, userId }) as DocumentRow | null;
}

export function readableDocumentSummary(documentId: string, userId: string) {
  return db.query(`${documentSummarySelect} WHERE d.id = $documentId AND ${readableSinglePredicate}`).get({ documentId, userId }) as DocumentSummary | null;
}

/**
 * The Files list. Only `purpose = 'file'` documents are listed: task and
 * collection attachments never appear in Files (WAVES_7-9.md §7), even for
 * their uploader.
 */
export function listReadableDocuments(userId: string, folderId: string | null) {
  return db.query(`${documentSummarySelect} WHERE ${readablePredicate} AND d.purpose = 'file' AND ($folderId IS NULL OR d.folder_id = $folderId) ORDER BY d.updated_at DESC LIMIT 500`)
    .all({ userId, folderId }) as DocumentSummary[];
}

/**
 * One document under the Files list predicate: readable through ownership or
 * sharing, and `purpose = 'file'`. MCP uses this, never readableDocument*, so
 * attachments reachable only through another module (task cards) stay out.
 */
export function listableDocumentSummary(documentId: string, userId: string) {
  return db.query(`${documentSummarySelect} WHERE d.id = $documentId AND ${readablePredicate} AND d.purpose = 'file'`)
    .get({ documentId, userId }) as DocumentSummary | null;
}

/**
 * The newest Files items `userId` can list, under the Files list predicate
 * (Today's `files` section, WAVES_10-12.md D51). `limit` is small and fixed.
 */
export function recentListableDocuments(userId: string, limit: number) {
  return db.query(`${documentSummarySelect} WHERE ${readablePredicate} AND d.purpose = 'file' ORDER BY d.updated_at DESC, d.id LIMIT $limit`)
    .all({ userId, limit }) as DocumentSummary[];
}

/** The full row for listableDocumentSummary's predicate; for server-side reads only (never returned). */
export function listableDocument(documentId: string, userId: string) {
  return db.query(`SELECT d.* FROM documents d WHERE d.id = $documentId AND ${readablePredicate} AND d.purpose = 'file'`)
    .get({ documentId, userId }) as DocumentRow | null;
}

/** A document owned by `userId`. Binned rows are included only on request; rows being purged never are. */
export function ownedDocument(documentId: string, userId: string, options: { includeDeleted?: boolean } = {}) {
  const deletedFilter = options.includeDeleted ? "purge_started_at IS NULL" : "deleted_at IS NULL";
  return db.query(`SELECT * FROM documents WHERE id = ? AND owner_id = ? AND ${deletedFilter}`).get(documentId, userId) as DocumentRow | null;
}

/** An owned Files document (`purpose = 'file'`): rename, move, and sharing never apply to attachments. */
export function ownedFileDocument(documentId: string, userId: string) {
  const document = ownedDocument(documentId, userId);
  return document && document.purpose === "file" ? document : null;
}
