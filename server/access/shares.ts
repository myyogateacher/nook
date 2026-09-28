import { db, now } from "../db";
import { readPolicies } from "../team/policies";
import { isLevel, type AccessKind, type Level } from "./levels";

/**
 * Direct share rows with levels (D272), shared by the Access sheet's `PUT …/access` and the older
 * `PUT …/sharing` routes. Every per-module member table has `user_id`, `created_at`, and (except
 * task views, which are view-only) `level`.
 */

export type ShareTable = { table: string; column: string; hasLevel: boolean };

export const SHARE_TABLES: Record<AccessKind, ShareTable> = {
  note: { table: "note_shares", column: "note_id", hasLevel: true },
  folder: { table: "folder_shares", column: "folder_id", hasLevel: true },
  document: { table: "document_shares", column: "document_id", hasLevel: true },
  board: { table: "board_members", column: "board_id", hasLevel: true },
  task_view: { table: "task_view_members", column: "view_id", hasLevel: false },
  collection: { table: "collection_members", column: "collection_id", hasLevel: true },
  calendar: { table: "calendar_members", column: "calendar_id", hasLevel: true }
};

/** The direct shares of one item: user id → level (`view` for tables without a level). */
export function directShares(kind: AccessKind, id: string): Map<string, Level> {
  const { table, column, hasLevel } = SHARE_TABLES[kind];
  const rows = db.query(`SELECT user_id, ${hasLevel ? "level" : "'view' AS level"} FROM ${table} WHERE ${column} = ?`).all(id) as Array<{ user_id: string; level: string }>;
  return new Map(rows.map((row) => [row.user_id, isLevel(row.level) ? row.level : "view"]));
}

/** Replaces the direct shares of one item. Call inside the caller's transaction. */
export function writeDirectShares(kind: AccessKind, id: string, entries: ReadonlyArray<{ userId: string; level: Level }>) {
  const { table, column, hasLevel } = SHARE_TABLES[kind];
  db.query(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
  const timestamp = now();
  const insert = hasLevel
    ? db.query(`INSERT INTO ${table} (${column}, user_id, created_at, level) VALUES (?, ?, ?, ?)`)
    : db.query(`INSERT INTO ${table} (${column}, user_id, created_at) VALUES (?, ?, ?)`);
  for (const entry of entries) {
    if (hasLevel) insert.run(id, entry.userId, timestamp, entry.level);
    else insert.run(id, entry.userId, timestamp);
  }
}

/**
 * The levels the older `PUT …/sharing` routes write (§C.5: "maps userIds to people at the module's
 * default level and leaves group grants untouched"). People already shared with keep their level,
 * so an old client never lowers or raises anyone; new people get `fallback`. `force` sets every
 * level except `manage` (collections and calendars, whose old route carries one audience-wide role).
 */
export function legacyShareLevels(kind: AccessKind, id: string, userIds: readonly string[], fallback: Level, force = false) {
  const current = directShares(kind, id);
  return userIds.map((userId) => {
    const existing = current.get(userId);
    const level: Level = existing === "manage" ? "manage" : force ? fallback : existing ?? fallback;
    return { userId, level };
  });
}

/**
 * Whether sharing with these people and groups would reach a guest while the `share_with_guests`
 * policy is off (D.2, T213): answered 400 GUEST_SHARE_DISABLED by every sharing route.
 */
export function guestShareBlocked(userIds: readonly string[], groupIds: readonly string[] = []) {
  if (readPolicies().shareWithGuests) return false;
  if (userIds.length) {
    const placeholders = userIds.map(() => "?").join(",");
    if (db.query(`SELECT 1 FROM users WHERE role = 'guest' AND id IN (${placeholders}) LIMIT 1`).get(...userIds)) return true;
  }
  if (groupIds.length) {
    const placeholders = groupIds.map(() => "?").join(",");
    if (db.query(`SELECT 1 FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE u.role = 'guest' AND gm.group_id IN (${placeholders}) LIMIT 1`).get(...groupIds)) return true;
  }
  return false;
}

export const GUEST_SHARE_DISABLED = { error: "Sharing with guests is turned off for this Nook", code: "GUEST_SHARE_DISABLED" } as const;
