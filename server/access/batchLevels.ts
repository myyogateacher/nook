import { db } from "../db";
import type { Role } from "../team/roles";
import type { GroupGrantKind } from "./groups";
import { capByRole, isLevel, maxLevel, type AudienceSource, type ItemLevel, type Level } from "./levels";

/**
 * `audienceLevel` for a whole page of items in a constant number of queries (C10, review L6): the
 * caller's role once, every direct share row of the page in one query, and every group grant of the
 * page in one more, instead of three queries per item. The rules are audienceLevel's, unchanged:
 * the owner (unless the account is gone), everyone but guests at the audience level for `all_users`,
 * the best of the direct share and the groups for `selected`, always capped by the Team role.
 * All sources must share one kind and member table (one module's list).
 */

export function audienceLevels(sources: readonly AudienceSource[], userId: string): Map<string, ItemLevel> {
  const levels = new Map<string, ItemLevel>();
  if (!sources.length) return levels;
  const { kind, memberTable, memberColumn } = sources[0]!;
  if (sources.some((source) => source.kind !== kind || source.memberTable !== memberTable || source.memberColumn !== memberColumn)) {
    throw new Error("audienceLevels takes the items of one kind");
  }
  const account = db.query("SELECT role, kind FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: Role; kind: string } | null;
  const role = account?.role ?? null;
  // Integrations (D287) are never part of an `all_users` audience.
  const audienceAll = role !== null && role !== "guest" && account?.kind === "person";
  const selected = sources.filter((source) => source.ownerId !== userId && source.visibility === "selected").map((source) => source.id);
  const direct = new Map<string, Level>();
  const groups = new Map<string, Level[]>();
  if (role !== null && selected.length) {
    const ids = JSON.stringify(selected);
    // The table and column names come from the module's own constants, never from input.
    for (const row of db.query(`SELECT ${memberColumn} AS id, level FROM ${memberTable} WHERE user_id = ? AND ${memberColumn} IN (SELECT value FROM json_each(?))`)
      .all(userId, ids) as Array<{ id: string; level: string }>) {
      if (isLevel(row.level)) direct.set(row.id, row.level);
    }
    for (const row of db.query(`SELECT gg.resource_id AS id, gg.level FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id
        WHERE gg.resource_kind = ? AND gm.user_id = ? AND gg.env_id IS NULL AND gg.resource_id IN (SELECT value FROM json_each(?))`)
      .all(kind as GroupGrantKind, userId, ids) as Array<{ id: string; level: Level }>) {
      groups.set(row.id, [...groups.get(row.id) ?? [], row.level]);
    }
  }
  for (const source of sources) {
    if (source.ownerId === userId) { levels.set(source.id, role === null ? "none" : "owner"); continue; }
    if (role === null) { levels.set(source.id, "none"); continue; }
    let best: ItemLevel = "none";
    if (source.visibility === "all_users" && audienceAll) best = source.audienceLevel;
    else if (source.visibility === "selected") best = maxLevel(direct.get(source.id), ...groups.get(source.id) ?? []);
    levels.set(source.id, capByRole(best, role));
  }
  return levels;
}
