import { db } from "../db";
import type { AccessKind, Level } from "./levels";

/**
 * The group branch of every access predicate (access plan D270, §C.9). Owners share an item with a
 * group at a level (`group_grants`); admins decide who is in it (`group_members`, D267). A grant
 * counts only under the item's `selected` audience, which each predicate enforces around this
 * fragment, so a private item never leaks through an old group row. tests/groupGrants.test.ts fails
 * when a `selected` branch lacks it.
 */

export type GroupGrantKind = AccessKind | "vault";

/**
 * `EXISTS` a group grant on `kind`/`column` for the user `userExpression` names (default `$userId`),
 * optionally at one of `levels`. Uses `group_grants_unique` (resource) and `group_members` PK.
 */
export function groupGrantExists(kind: GroupGrantKind, column: string, userExpression = "$userId", levels?: readonly Level[]) {
  const levelFilter = levels ? ` AND gg.level IN (${levels.map((level) => `'${level}'`).join(",")})` : "";
  return `EXISTS (SELECT 1 FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id
    WHERE gg.resource_kind = '${kind}' AND gg.resource_id = ${column} AND gm.user_id = ${userExpression}${levelFilter})`;
}

const levelsQuery = db.query(`SELECT gg.level FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id
  WHERE gg.resource_kind = ? AND gg.resource_id = ? AND gm.user_id = ? AND gg.env_id IS NULL`);

/** Every level `userId` holds on one item through their groups (none when they are in no granted group). */
export function groupLevels(kind: GroupGrantKind, id: string, userId: string): Level[] {
  return (levelsQuery.all(kind, id, userId) as Array<{ level: Level }>).map((row) => row.level);
}

/** The users a group grant on an item reaches (for mail and audience comparisons), ids only. */
export function groupGrantUserIds(kind: GroupGrantKind, id: string): string[] {
  return (db.query(`SELECT DISTINCT gm.user_id FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id
    WHERE gg.resource_kind = ? AND gg.resource_id = ? ORDER BY gm.user_id`).all(kind, id) as Array<{ user_id: string }>).map((row) => row.user_id);
}

/** The group ids granted on an item, sorted (the file-move audience comparison). */
export function groupGrantIds(kind: GroupGrantKind, id: string): string[] {
  return (db.query("SELECT group_id FROM group_grants WHERE resource_kind = ? AND resource_id = ? ORDER BY group_id").all(kind, id) as Array<{ group_id: string }>)
    .map((row) => row.group_id);
}
