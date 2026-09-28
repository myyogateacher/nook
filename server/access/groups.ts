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

const RESOURCE_TABLES: Record<string, string> = {
  note: "notes", folder: "folders", document: "documents", board: "boards", task_view: "task_views", collection: "collections", calendar: "calendars", routine: "routines"
};

/**
 * T206 self-check (the sweeper, hourly): grant rows whose item no longer exists. The purge triggers
 * of migration 025 should leave none; any found are reported by kind with at most five resource ids
 * (never titles) and left in place for an operator to look at. Vault grants wait for the vault waves.
 */
export function orphanGrantReport() {
  const found: Array<{ source: "group_grants" | "api_key_grants"; kind: string; count: number; sample: string[] }> = [];
  for (const [kind, table] of Object.entries(RESOURCE_TABLES)) {
    for (const source of ["group_grants", "api_key_grants"] as const) {
      if (source === "group_grants" && kind === "routine") continue;
      const rows = db.query(`SELECT g.resource_id FROM ${source} g WHERE g.resource_kind = ? AND g.resource_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = g.resource_id) LIMIT 1000`).all(kind) as Array<{ resource_id: string }>;
      if (rows.length) found.push({ source, kind, count: rows.length, sample: rows.slice(0, 5).map((row) => row.resource_id) });
    }
  }
  return found;
}
