import { db } from "../db";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { groupGrantExists } from "../access/groups";
import { audienceLevel, roleWord, shareRoleToLevel, type ItemLevel } from "../access/levels";
import { audienceLevels } from "../access/batchLevels";
import { canWriteContent } from "../team/userRole";

export type CollectionVisibility = "private" | "selected" | "all_users";
export type ShareRole = "viewer" | "editor";
export type CollectionRole = "owner" | ShareRole;

export type CollectionRecord = {
  id: string;
  owner_id: string;
  name: string;
  icon: string;
  schema_json: string;
  schema_version: number;
  visibility: CollectionVisibility;
  share_role: ShareRole;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

/**
 * Whether `$userId` may read live collection `c` (WAVES_10-12.md §3.2): the
 * owner, everyone for `all_users`, or a member row for `selected`. Binned
 * collections never match. Also OR-ed into readableDocument* for attachments.
 */
export const readableCollectionPredicate = `(
  c.deleted_at IS NULL AND (c.owner_id = $userId OR (c.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
    OR (c.visibility = 'selected' AND (EXISTS (SELECT 1 FROM collection_members m WHERE m.collection_id = c.id AND m.user_id = $userId)
      OR ${groupGrantExists("collection", "c.id")})))
)`;

/**
 * Readers who may write rows (D54, D272): the owner; everyone on an `all_users` collection whose
 * audience role is editor; or, for `selected`, a member or group at `edit` or `manage`. The Team
 * role cap is applied in TS (requireEditable*), as before.
 */
export const editableCollectionPredicate = `(${readableCollectionPredicate} AND (c.owner_id = $userId
  OR (c.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS} AND c.share_role = 'editor')
  OR (c.visibility = 'selected' AND (EXISTS (SELECT 1 FROM collection_members em WHERE em.collection_id = c.id AND em.user_id = $userId AND em.level IN ('edit','manage'))
    OR ${groupGrantExists("collection", "c.id", "$userId", ["edit", "manage"])}))))`;

export function readableCollection(collectionId: string, userId: string) {
  return db.query(`SELECT c.* FROM collections c WHERE c.id = $collectionId AND ${readableCollectionPredicate}`).get({ collectionId, userId }) as CollectionRecord | null;
}

type LevelSource = Pick<CollectionRecord, "id" | "owner_id" | "share_role" | "visibility"> & { deleted_at?: string | null };

/**
 * The caller's level on the collection (§D.3, D272): owner; for `selected` the best of their member
 * row and groups; for `all_users` the audience role; always capped by the Team role (a viewer or
 * guest shared with as an editor reads). `none` for a binned or unreadable collection.
 */
export function collectionLevel(collection: LevelSource, userId: string): ItemLevel {
  if (collection.deleted_at) return "none";
  return audienceLevel({ kind: "collection", id: collection.id, ownerId: collection.owner_id, visibility: collection.visibility, audienceLevel: shareRoleToLevel(collection.share_role), memberTable: "collection_members", memberColumn: "collection_id" }, userId);
}

/**
 * The caller's role word, kept for API compatibility next to `level`: owner, editor (edit or
 * manage), or viewer. Owners stay `owner` (their writes are refused by the write gate and by
 * requireEditable*, not by hiding ownership).
 */
export function collectionRole(collection: LevelSource, userId: string): CollectionRole {
  return collectionRoleFor(collectionLevel(collection, userId), () => canWriteContent(userId));
}

/** collectionRole from a level already known, asking the Team role only when it matters. */
export function collectionRoleFor(level: ItemLevel, canWrite: () => boolean): CollectionRole {
  const word = roleWord(level);
  return word === "owner" || canWrite() ? word : "viewer";
}

/** collectionLevel for a page of live collections in a constant number of queries (C10); same results, by id. */
export function collectionLevels(collections: ReadonlyArray<Pick<CollectionRecord, "id" | "owner_id" | "share_role" | "visibility">>, userId: string) {
  return audienceLevels(collections.map((collection) => ({ kind: "collection" as const, id: collection.id, ownerId: collection.owner_id, visibility: collection.visibility, audienceLevel: shareRoleToLevel(collection.share_role), memberTable: "collection_members", memberColumn: "collection_id" })), userId);
}

export type RowRecord = {
  id: string;
  collection_id: string;
  position: number;
  values_json: string;
  prev_values_json: string | null;
  revision: number;
  prev_revision: number | null;
  updated_via_key_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

/** A live row in a collection the caller can read. Path ids are always joined to their collection (T52). */
export function readableRow(rowId: string, userId: string) {
  const row = db.query(`SELECT r.* FROM collection_rows r JOIN collections c ON c.id = r.collection_id
    WHERE r.id = $rowId AND r.deleted_at IS NULL AND ${readableCollectionPredicate}`).get({ rowId, userId }) as RowRecord | null;
  if (!row) return null;
  return { row, collection: readableCollection(row.collection_id, userId)! };
}

export type ViewRecord = {
  id: string;
  collection_id: string;
  name: string;
  kind: "table" | "board";
  config_json: string;
  position: number;
  created_at: string;
  updated_at: string;
};

/** A saved view of a collection the caller can read. */
export function readableView(viewId: string, userId: string) {
  const view = db.query(`SELECT v.* FROM collection_views v JOIN collections c ON c.id = v.collection_id
    WHERE v.id = $viewId AND ${readableCollectionPredicate}`).get({ viewId, userId }) as ViewRecord | null;
  if (!view) return null;
  return { view, collection: readableCollection(view.collection_id, userId)! };
}
