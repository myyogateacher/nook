import { db } from "../db";
import type { Role } from "../team/roles";
import { groupLevels } from "./groups";

/**
 * The item level ladder (access plan D266, §C.2, §D.3): `view < comment < edit < manage < owner`.
 * Allow-only: the highest applicable grant wins (direct share, group, or the `all_users` audience),
 * always capped by the Team role (a role is a ceiling, never a grant, D71). Viewers and guests read
 * at most (`comment` stays member-only, O-A3). Owners stay `owner` whatever their role; their writes
 * are refused by the write gate and the services' `canWriteContent` checks, not by hiding ownership.
 */

export const LEVELS = ["view", "comment", "edit", "manage"] as const;
export type Level = typeof LEVELS[number];
export type ItemLevel = "none" | Level | "owner";

export const LEVEL_RANK: Record<ItemLevel, number> = { none: 0, view: 1, comment: 2, edit: 3, manage: 4, owner: 5 };

export const isLevel = (value: unknown): value is Level => typeof value === "string" && (LEVELS as readonly string[]).includes(value);

/** The kinds with an Access sheet (§C.7); `group_grants.resource_kind` minus the vault. */
export const ACCESS_KINDS = ["note", "folder", "document", "board", "task_view", "collection", "calendar"] as const;
export type AccessKind = typeof ACCESS_KINDS[number];

/** The levels each kind offers to people and groups (§D.3). Files and task views stay view-only (D275). */
export const KIND_LEVELS: Record<AccessKind, readonly Level[]> = {
  note: ["view", "edit"],
  folder: ["view", "edit"],
  document: ["view"],
  board: ["view", "comment", "edit", "manage"],
  task_view: ["view"],
  collection: ["view", "edit", "manage"],
  calendar: ["view", "edit", "manage"]
};

/** The levels an `all_users` audience may hold (`boards.share_role`, collections and calendars `share_role`). */
export const AUDIENCE_LEVELS: Partial<Record<AccessKind, readonly Level[]>> = {
  board: ["view", "comment", "edit"],
  collection: ["view", "edit"],
  calendar: ["view", "edit"]
};

/** The level a person gets when first added without one: today's behaviour per module (§D.3). */
export function defaultLevel(kind: AccessKind, audienceLevel: Level | null = null): Level {
  if (kind === "board") return "edit"; // D38: every board member edits cards
  if ((kind === "collection" || kind === "calendar") && audienceLevel) return audienceLevel === "edit" ? "edit" : "view";
  return "view";
}

export const atLeast = (level: ItemLevel, needed: ItemLevel) => LEVEL_RANK[level] >= LEVEL_RANK[needed];

export function maxLevel(...levels: Array<ItemLevel | null | undefined>): ItemLevel {
  let best: ItemLevel = "none";
  for (const level of levels) if (level && LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  return best;
}

/** The most a role may do on an item it does not own (D266, O-A3). Unknown accounts get nothing. */
export function roleCap(role: Role | null): ItemLevel {
  if (role === "admin" || role === "member") return "manage";
  if (role === "viewer" || role === "guest") return "view";
  return "none";
}

/** `level` capped by the role; `owner` is never capped (see the file comment). */
export function capByRole(level: ItemLevel, role: Role | null): ItemLevel {
  if (level === "owner" || level === "none") return role === null ? "none" : level;
  const cap = roleCap(role);
  return LEVEL_RANK[level] <= LEVEL_RANK[cap] ? level : cap;
}

/** Collections and calendars keep their 012/013 `share_role` words; the ladder uses `view`/`edit`. */
export type ShareRoleWord = "viewer" | "editor";
export const shareRoleToLevel = (role: ShareRoleWord): Level => role === "editor" ? "edit" : "view";
export const levelToShareRole = (level: Level): ShareRoleWord => level === "view" || level === "comment" ? "viewer" : "editor";

/** The old `role` word an API response keeps next to the new `level` (owner, editor, viewer). */
export function roleWord(level: ItemLevel): "owner" | ShareRoleWord {
  if (level === "owner") return "owner";
  return LEVEL_RANK[level] >= LEVEL_RANK.edit ? "editor" : "viewer";
}

const roleQuery = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL");
const userRoleNow = (userId: string) => (roleQuery.get(userId) as { role: Role } | null)?.role ?? null;

/** One direct share row's level, or null (the per-module member tables all have `user_id` and `level`). */
function directLevel(table: string, column: string, id: string, userId: string): Level | null {
  const row = db.query(`SELECT level FROM ${table} WHERE ${column} = ? AND user_id = ?`).get(id, userId) as { level: string } | null;
  return row && isLevel(row.level) ? row.level : null;
}

export type AudienceSource = {
  kind: AccessKind;
  id: string;
  ownerId: string;
  visibility: "private" | "selected" | "all_users";
  /** The `all_users` level; notes, folders, files, and views read only. */
  audienceLevel: Level;
  memberTable: string;
  memberColumn: string;
};

/**
 * The live level of `userId` on one item from its audience (itemLevel per module, §C.9): the owner,
 * everyone but guests at the audience level for `all_users`, or the best of the direct share and the
 * group grants for `selected` (group grants apply only under `selected`, so a private item never
 * leaks through an old group row). Read fresh on every call; nothing is cached (T202).
 */
export function audienceLevel(source: AudienceSource, userId: string): ItemLevel {
  if (source.ownerId === userId) return userRoleNow(userId) === null ? "none" : "owner";
  const role = userRoleNow(userId);
  if (role === null) return "none";
  let best: ItemLevel = "none";
  if (source.visibility === "all_users" && role !== "guest") best = source.audienceLevel;
  else if (source.visibility === "selected") best = maxLevel(directLevel(source.memberTable, source.memberColumn, source.id, userId), ...groupLevels(source.kind, source.id, userId));
  return capByRole(best, role);
}

/** `CASE` rank of a level column, for SQL that compares levels. */
export const levelRankSql = (column: string) => `(CASE ${column} WHEN 'view' THEN 1 WHEN 'comment' THEN 2 WHEN 'edit' THEN 3 WHEN 'manage' THEN 4 ELSE 0 END)`;

/** The SQL list of levels at or above `needed`, for `level IN (…)`. */
export const levelsFrom = (needed: Level) => LEVELS.filter((level) => LEVEL_RANK[level] >= LEVEL_RANK[needed]);
export const levelListSql = (levels: readonly Level[]) => levels.map((level) => `'${level}'`).join(",");
