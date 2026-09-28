import { db, type NoteRow } from "./db";
import { AUDIENCE_ALL_USERS } from "./team/roles";
import { groupGrantExists } from "./access/groups";

/**
 * Whether `$userId` may read note `n` (binned or not; callers add
 * `n.deleted_at IS NULL`): the owner; a note-level override (all users, or
 * selected with a share row); or, when inheriting, the immediate folder's
 * visibility and shares. Shared by readableNote and the search API.
 */
export const readableNotePredicate = `(
  n.owner_id = $userId OR (n.sharing_override = 1 AND (
    (n.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (n.visibility = 'selected' AND (EXISTS (
      SELECT 1 FROM note_shares s WHERE s.note_id = n.id AND s.user_id = $userId
    ) OR ${groupGrantExists("note", "n.id")}))
  )) OR (n.sharing_override = 0 AND EXISTS (
    SELECT 1 FROM folders f WHERE f.id = n.folder_id AND (
      (f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (f.visibility = 'selected' AND (EXISTS (
        SELECT 1 FROM folder_shares fs WHERE fs.folder_id = f.id AND fs.user_id = $userId
      ) OR ${groupGrantExists("folder", "f.id")}))
    )
  ))
)`;

/**
 * `n.folder_id` as `$userId` may see it (`f` is the note's folder, LEFT JOINed): the owner always,
 * a recipient only when the folder itself is visible to them. Shared by GET /api/notes and search.
 */
export const visibleNoteFolderIdExpression = `CASE WHEN n.owner_id = $userId OR (n.sharing_override = 0 AND (
  (f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR EXISTS (SELECT 1 FROM folder_shares fs WHERE fs.folder_id = f.id AND fs.user_id = $userId)
    OR (f.visibility = 'selected' AND ${groupGrantExists("folder", "f.id")})
)) THEN n.folder_id ELSE NULL END`;

const readableSql = `SELECT n.* FROM notes n WHERE n.id = $noteId AND n.deleted_at IS NULL AND ${readableNotePredicate}`;

export function readableNote(noteId: string, userId: string) {
  return db.query(readableSql).get({ noteId, userId }) as NoteRow | null;
}

/**
 * Folders `userId` can see, as GET /api/folders returns them: their own, and
 * folders shared with them directly or with all users. `parent_id` is only
 * shown to the owner.
 */
export function listReadableFolders(userId: string) {
  return db.query(`
    SELECT f.id, CASE WHEN f.owner_id = $userId THEN f.parent_id ELSE NULL END AS parent_id,
           f.name, f.is_default, f.visibility, f.created_at, f.updated_at,
           f.owner_id, u.display_name AS owner_name,
           CASE WHEN f.owner_id = $userId THEN 1 ELSE 0 END AS is_owner
    FROM folders f JOIN users u ON u.id = f.owner_id
    WHERE f.owner_id = $userId OR (f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (
      f.visibility = 'selected' AND (EXISTS (
        SELECT 1 FROM folder_shares fs WHERE fs.folder_id = f.id AND fs.user_id = $userId
      ) OR ${groupGrantExists("folder", "f.id")})
    )
    ORDER BY is_owner DESC, f.is_default DESC, f.name COLLATE NOCASE
  `).all({ userId }) as Array<{
    id: string; parent_id: string | null; name: string; is_default: number; visibility: string;
    created_at: string; updated_at: string; owner_id: string; owner_name: string; is_owner: 0 | 1;
  }>;
}

export function ownedNote(noteId: string, userId: string) {
  return db.query("SELECT * FROM notes WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(noteId, userId) as NoteRow | null;
}
