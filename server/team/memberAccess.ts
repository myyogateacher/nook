import { audit, db, now } from "../db";
import { adminRevokeKey, listApiKeys, listInventory } from "../apiKeys";
import { folderLevel } from "../access";
import { itemLevel, presentItem, readabilityChecker } from "../access/effective";
import { recordAccessEvent } from "../access/events";
import { openCursor, openItemHandle, sealCursor, sealItemHandle } from "../access/handles";
import { ACCESS_KINDS, KIND_LEVELS, LEVEL_RANK, isLevel, type AccessKind, type ItemLevel, type Level } from "../access/levels";
import { notifyAccess } from "../access/notices";
import { SHARE_TABLES } from "../access/shares";
import { pauseRoutinesOf } from "../inbox/routineHooks";
import { AUDIENCE_ALL_USERS, type Role } from "./roles";

/**
 * The member access page (access plan §C.6, D268, D269, T204, T214, T218): everything one person
 * can reach, per item kind, and the admin's reductions on it.
 *
 * - Reads come from each module's own share table and `group_grants ⨝ group_members` (the two
 *   halves of `access_grants_v`), one indexed query per kind, paged at 200 (T218). Audience-wide
 *   (`all_users`) items are counts only.
 * - Titles are shown only when the viewing admin can open the item themselves (D73, D269); every
 *   other row is "Board owned by Carol", without an id. Each row the admin may act on carries an
 *   opaque sealed handle instead of the item id (server/access/handles.ts), and paging cursors are
 *   sealed too, so no raw id of an unreadable item ever leaves the server.
 * - Admin actions are reductions only (D268): remove a direct share, lower its level, remove the
 *   person from a group, revoke keys, and Reset access. Nothing here can add or raise a grant.
 *   Every action writes `access_events` and `audit_log` (ids and counts only) and puts a bell
 *   notice with the item's owner (§C.11).
 * - The person themself sees the same page read-only at Settings → My access (`/api/me/access`).
 */

export const ACCESS_PAGE = 200;

export class MemberAccessError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) {
    super(message);
    this.name = "MemberAccessError";
  }
}

const gone = () => new MemberAccessError(404, "NOT_FOUND", "This access is already gone. The page now shows the latest.");

type Person = { id: string; display_name: string; role: Role; disabled_at: string | null };
const personQuery = db.query("SELECT id, display_name, role, disabled_at FROM users WHERE id = ?");
function person(userId: string) {
  const row = personQuery.get(userId) as Person | null;
  if (!row) throw new MemberAccessError(404, "NOT_FOUND", "Team member not found");
  return row;
}

/** Which module each kind belongs to on the page. */
export const KIND_MODULE: Record<AccessKind, "notes" | "files" | "tasks" | "collections" | "calendar"> = {
  note: "notes", folder: "notes", document: "files", board: "tasks", task_view: "tasks", collection: "collections", calendar: "calendar"
};

/** Items shared with everyone signed in that `$userId` does not own (never guests: AUDIENCE_ALL_USERS). */
const AUDIENCE_COUNTS: Record<AccessKind, string> = {
  note: `SELECT COUNT(*) AS count FROM notes n LEFT JOIN folders f ON f.id = n.folder_id WHERE n.deleted_at IS NULL AND n.owner_id <> $userId
    AND ((n.sharing_override = 1 AND n.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (n.sharing_override = 0 AND f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}))`,
  folder: `SELECT COUNT(*) AS count FROM folders f WHERE f.owner_id <> $userId AND f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}`,
  document: `SELECT COUNT(*) AS count FROM documents d LEFT JOIN folders f ON f.id = d.folder_id WHERE d.deleted_at IS NULL AND d.purpose = 'file' AND d.owner_id <> $userId
    AND ((d.sharing_override = 1 AND d.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) OR (d.sharing_override = 0 AND f.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}))`,
  board: `SELECT COUNT(*) AS count FROM boards b WHERE b.deleted_at IS NULL AND b.owner_id <> $userId AND b.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}`,
  task_view: `SELECT COUNT(*) AS count FROM task_views v JOIN users o ON o.id = v.owner_id WHERE o.disabled_at IS NULL AND v.owner_id <> $userId AND v.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}`,
  collection: `SELECT COUNT(*) AS count FROM collections c WHERE c.deleted_at IS NULL AND c.owner_id <> $userId AND c.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}`,
  calendar: `SELECT COUNT(*) AS count FROM calendars k WHERE k.deleted_at IS NULL AND k.owner_id <> $userId AND k.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}`
};

const directCount = (kind: AccessKind, userId: string) =>
  (db.query(`SELECT COUNT(*) AS count FROM ${SHARE_TABLES[kind].table} WHERE user_id = ?`).get(userId) as { count: number }).count;
const groupCount = (kind: AccessKind, userId: string) =>
  (db.query(`SELECT COUNT(*) AS count FROM group_members gm JOIN group_grants gg ON gg.group_id = gm.group_id
    WHERE gm.user_id = ? AND gg.resource_kind = ? AND gg.env_id IS NULL`).get(userId, kind) as { count: number }).count;

/** Distinct items `userId` reaches on `kind` through a direct share or a group (one item shared both ways counts once). */
const itemCount = (kind: AccessKind, userId: string) => {
  const { table, column } = SHARE_TABLES[kind];
  return (db.query(`SELECT COUNT(*) AS count FROM (
      SELECT ${column} AS resource_id FROM ${table} WHERE user_id = $userId
      UNION
      SELECT gg.resource_id FROM group_members gm JOIN group_grants gg ON gg.group_id = gm.group_id
        WHERE gm.user_id = $userId AND gg.resource_kind = $kind AND gg.env_id IS NULL)`).get({ userId, kind }) as { count: number }).count;
};

/** What Reset access removes, counted (the confirm shows these before, the result after). */
export function resetCounts(userId: string) {
  let direct = 0;
  for (const kind of ACCESS_KINDS) direct += directCount(kind, userId);
  const count = (sql: string) => (db.query(sql).get(userId) as { count: number }).count;
  return {
    directShares: direct,
    groups: count("SELECT COUNT(*) AS count FROM group_members WHERE user_id = ?"),
    keys: count("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL"),
    feeds: count("SELECT COUNT(*) AS count FROM calendar_feeds WHERE user_id = ? AND revoked_at IS NULL"),
    routines: count("SELECT COUNT(*) AS count FROM routines WHERE owner_id = ? AND enabled = 1")
  };
}

type KeySummary = { id: string; name: string; prefix: string; state: string; surfaces: string; expiresAt: string | null; lastUsedAt: string | null; modules: string[] };

function keySummaries(viewerId: string, userId: string): KeySummary[] {
  const shape = (key: { id: string; name: string; prefix: string; state: string; surfaces: string; expiresAt: string | null; lastUsedAt: string | null; grants: Array<{ module: string }> }) => ({
    id: key.id, name: key.name, prefix: key.prefix, state: key.state, surfaces: key.surfaces, expiresAt: key.expiresAt, lastUsedAt: key.lastUsedAt,
    modules: [...new Set(key.grants.map((grant) => grant.module))]
  });
  if (viewerId === userId) return listApiKeys(userId).keys.filter((key) => key.revokedAt === null).map(shape);
  return listInventory({ owner: userId }).keys.map(shape);
}

function groupsOf(userId: string) {
  return (db.query(`SELECT g.id, g.name, gm.added_at, gm.added_by, a.display_name AS added_by_name,
      (SELECT COUNT(*) FROM group_grants gg WHERE gg.group_id = g.id) AS grant_count,
      (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count
    FROM group_members gm JOIN user_groups g ON g.id = gm.group_id LEFT JOIN users a ON a.id = gm.added_by
    WHERE gm.user_id = ? ORDER BY g.name COLLATE NOCASE, g.id`).all(userId) as Array<{ id: string; name: string; added_at: string; added_by: string | null; added_by_name: string | null; grant_count: number; member_count: number }>)
    .map((row) => ({
      id: row.id, name: row.name, grantCount: row.grant_count, memberCount: row.member_count, addedAt: row.added_at,
      addedBy: row.added_by && row.added_by_name !== null ? { id: row.added_by, displayName: row.added_by_name } : null,
      selfAdded: row.added_by === userId
    }));
}

/**
 * The page head: the person, their groups, keys, feeds and routines, and per kind how many items
 * they reach directly, through groups, and through everyone-signed-in. Rows come per kind from
 * `accessItems`.
 */
export function accessSummary(viewerId: string, userId: string) {
  const target = person(userId);
  const counts = resetCounts(userId);
  return {
    member: { id: target.id, displayName: target.display_name, role: target.role, status: target.disabled_at === null ? "active" as const : "blocked" as const, isYou: target.id === viewerId },
    groups: groupsOf(userId),
    keys: keySummaries(viewerId, userId),
    feeds: { live: counts.feeds },
    routines: { enabled: counts.routines },
    kinds: ACCESS_KINDS.map((kind) => ({
      kind, module: KIND_MODULE[kind], items: itemCount(kind, userId), direct: directCount(kind, userId), group: groupCount(kind, userId),
      audience: target.role === "guest" ? 0 : (db.query(AUDIENCE_COUNTS[kind]).get({ userId }) as { count: number }).count
    })),
    resetCounts: counts,
    pageSize: ACCESS_PAGE
  };
}

type GrantRow = { via: "direct" | "group"; resource_id: string; level: string; group_id: string; group_name: string | null };

/** The person's live level on an item (folders without the viewer-wide folder list, T218). */
function liveLevel(kind: AccessKind, id: string, userId: string): ItemLevel {
  if (kind !== "folder") return itemLevel(kind, id, userId);
  return db.query("SELECT 1 FROM folders WHERE id = ?").get(id) ? folderLevel(id, userId) : "none";
}

/**
 * One page (200) of the grants `userId` holds on `kind`: direct share rows and group grants, ordered
 * by (via, item, group). `withHandles` (the admin page) seals a handle on each row; the self view
 * has none. `active` says whether the grant is in effect now (the item may be private, binned, or
 * the person blocked); the grant is listed either way, because Reset and Remove clean it up.
 */
export function accessItems(viewerId: string, userId: string, kind: AccessKind, cursorToken: string | undefined, withHandles: boolean) {
  person(userId);
  const cursor = cursorToken ? openCursor(cursorToken, viewerId, userId, kind) : null;
  if (cursorToken && !cursor) throw new MemberAccessError(400, "INVALID_CURSOR", "This page is out of date. Reload to see the latest.");
  const { table, column, hasLevel } = SHARE_TABLES[kind];
  const rows = db.query(`SELECT via, resource_id, level, group_id, group_name FROM (
      SELECT 'direct' AS via, s.${column} AS resource_id, ${hasLevel ? "s.level" : "'view'"} AS level, '' AS group_id, NULL AS group_name
        FROM ${table} s WHERE s.user_id = $userId
      UNION ALL
      SELECT 'group', gg.resource_id, gg.level, gg.group_id, g.name
        FROM group_members gm JOIN group_grants gg ON gg.group_id = gm.group_id JOIN user_groups g ON g.id = gg.group_id
        WHERE gm.user_id = $userId AND gg.resource_kind = $kind AND gg.env_id IS NULL
    ) WHERE ($cursorVia IS NULL OR (via, resource_id, group_id) > ($cursorVia, $cursorId, $cursorGroup))
    ORDER BY via, resource_id, group_id LIMIT $limit`)
    .all({ userId, kind, cursorVia: cursor?.via ?? null, cursorId: cursor?.id ?? "", cursorGroup: cursor?.groupId ?? "", limit: ACCESS_PAGE + 1 }) as GrantRow[];
  const page = rows.slice(0, ACCESS_PAGE);
  const readable = readabilityChecker(viewerId);
  const offered = KIND_LEVELS[kind];
  const items = page.flatMap((row) => {
    const item = presentItem(kind, row.resource_id, viewerId, readable);
    if (!item || !isLevel(row.level)) return [];
    const level = row.level;
    const via = row.via;
    const groupId = via === "group" ? row.group_id : null;
    return [{
      ...item,
      level,
      via,
      group: groupId ? { id: groupId, name: row.group_name ?? "" } : null,
      active: liveLevel(kind, row.resource_id, userId) !== "none",
      /** Levels an admin may lower a direct share to (D268: never up). */
      lowerTo: via === "direct" && hasLevel ? offered.filter((option) => LEVEL_RANK[option] < LEVEL_RANK[level]) : [],
      ...(withHandles ? { handle: sealItemHandle(viewerId, userId, { kind, id: row.resource_id, via, groupId }) } : {})
    }];
  });
  const last = page.at(-1);
  return {
    kind,
    items,
    nextCursor: rows.length > ACCESS_PAGE && last ? sealCursor(viewerId, userId, kind, { via: last.via, id: last.resource_id, groupId: last.group_id }) : null
  };
}

// ------------------------------------------------------------------------------ reductions (D268)

const ownerOf = (kind: AccessKind, id: string) => {
  const tables: Record<AccessKind, string> = { note: "notes", folder: "folders", document: "documents", board: "boards", task_view: "task_views", collection: "collections", calendar: "calendars" };
  return (db.query(`SELECT owner_id FROM ${tables[kind]} WHERE id = ?`).get(id) as { owner_id: string } | null)?.owner_id ?? null;
};

const isAccessKind = (value: string): value is AccessKind => (ACCESS_KINDS as readonly string[]).includes(value);

function openHandle(actorId: string, userId: string, token: string) {
  const handle = openItemHandle(token, actorId, userId);
  if (!handle || !isAccessKind(handle.kind)) throw new MemberAccessError(404, "NOT_FOUND", "This row is out of date. Reload the page.");
  return { ...handle, kind: handle.kind as AccessKind };
}

/**
 * `DELETE …/access/:handle`: removes the person's direct share on the item, or (for a row reached
 * through a group) removes them from that group. Reduction only; the owner hears about it.
 */
export function removeAccess(actorId: string, userId: string, token: string) {
  person(userId);
  const handle = openHandle(actorId, userId, token);
  if (handle.via === "group") return { removed: "group" as const, ...removeFromGroup(actorId, userId, handle.groupId ?? "") };
  const { table, column, hasLevel } = SHARE_TABLES[handle.kind];
  return db.transaction(() => {
    const row = db.query(`SELECT ${hasLevel ? "level" : "'view' AS level"} FROM ${table} WHERE ${column} = ? AND user_id = ?`).get(handle.id, userId) as { level: string } | null;
    if (!row) throw gone();
    db.query(`DELETE FROM ${table} WHERE ${column} = ? AND user_id = ?`).run(handle.id, userId);
    const timestamp = now();
    const ownerId = ownerOf(handle.kind, handle.id);
    recordAccessEvent({ actorId, via: "web", action: "access.share_removed", targetUserId: userId, resource: { kind: handle.kind, id: handle.id }, meta: { level: row.level } }, timestamp);
    audit(actorId, null, "team.access_removed", { targetId: userId, kind: handle.kind });
    if (ownerId) notifyAccess({ userId: ownerId, kind: "share_removed", actorId, targetUserId: userId, resource: { kind: handle.kind, id: handle.id } }, timestamp);
    return { removed: "share" as const, kind: handle.kind };
  })();
}

/** `PATCH …/access/:handle {level}`: lowers a direct share. Only to a level the kind offers and strictly below the current one. */
export function lowerAccess(actorId: string, userId: string, token: string, level: Level) {
  person(userId);
  const handle = openHandle(actorId, userId, token);
  const { table, column, hasLevel } = SHARE_TABLES[handle.kind];
  if (handle.via !== "direct" || !hasLevel) throw new MemberAccessError(400, "NOT_LOWERABLE", "Only a direct share with a level can be lowered");
  if (!KIND_LEVELS[handle.kind].includes(level)) throw new MemberAccessError(400, "LEVEL_NOT_OFFERED", "That level is not offered here");
  return db.transaction(() => {
    const row = db.query(`SELECT level FROM ${table} WHERE ${column} = ? AND user_id = ?`).get(handle.id, userId) as { level: string } | null;
    if (!row || !isLevel(row.level)) throw gone();
    // D268: reductions only. The same level or higher is refused, whatever the client sent.
    if (LEVEL_RANK[level] >= LEVEL_RANK[row.level]) throw new MemberAccessError(400, "NOT_A_REDUCTION", "Admins can only lower access, never raise it");
    const changed = db.query(`UPDATE ${table} SET level = ? WHERE ${column} = ? AND user_id = ? AND level = ?`).run(level, handle.id, userId, row.level).changes;
    if (!changed) throw gone();
    const timestamp = now();
    const ownerId = ownerOf(handle.kind, handle.id);
    recordAccessEvent({ actorId, via: "web", action: "access.share_lowered", targetUserId: userId, resource: { kind: handle.kind, id: handle.id }, meta: { from: row.level, to: level } }, timestamp);
    audit(actorId, null, "team.access_lowered", { targetId: userId, kind: handle.kind, from: row.level, to: level });
    if (ownerId) notifyAccess({ userId: ownerId, kind: "share_lowered", actorId, targetUserId: userId, resource: { kind: handle.kind, id: handle.id } }, timestamp);
    return { lowered: true as const, kind: handle.kind, from: row.level, to: level };
  })();
}

/**
 * Removes the person from one group (the group's revision moves, so an open group page reloads).
 * The member hears about it; owners who shared with the group do not (their share still stands,
 * and membership is what admins manage, D267).
 */
export function removeFromGroup(actorId: string, userId: string, groupId: string) {
  return db.transaction(() => {
    const removed = db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId).changes;
    if (!removed) throw gone();
    const timestamp = now();
    db.query("UPDATE user_groups SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, groupId);
    recordAccessEvent({ actorId, via: "web", action: "group.member_removed", groupId, targetUserId: userId, meta: { from: "member_access", ...(userId === actorId ? { self: true } : {}) } }, timestamp);
    audit(actorId, null, "group.members_changed", { groupId, added: 0, removed: 1, selfAdded: false });
    notifyAccess({ userId, kind: "group_removed", actorId, groupId }, timestamp);
    return { groupId };
  })();
}

/**
 * Reset access (§C.6): removes every direct share and group membership, revokes every live key and
 * calendar feed, and pauses routines, in one transaction. Owned items and everyone-signed-in
 * audiences are left alone. Each owner hears once, with the count of their items; the person
 * hears once. Returns the counts removed and what remains (all zeros unless something raced).
 */
export function resetAccess(actorId: string, userId: string) {
  const target = person(userId);
  if (target.id === actorId) throw new MemberAccessError(400, "SELF_ACTION", "You cannot reset your own access. Ask another admin.");
  return db.transaction(() => {
    const before = resetCounts(userId);
    const timestamp = now();
    const perOwner = new Map<string, number>();
    for (const kind of ACCESS_KINDS) {
      const { table, column } = SHARE_TABLES[kind];
      const rows = db.query(`SELECT ${column} AS id FROM ${table} WHERE user_id = ?`).all(userId) as Array<{ id: string }>;
      for (const row of rows) {
        const ownerId = ownerOf(kind, row.id);
        if (ownerId) perOwner.set(ownerId, (perOwner.get(ownerId) ?? 0) + 1);
      }
      db.query(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    const groups = db.query("SELECT group_id FROM group_members WHERE user_id = ?").all(userId) as Array<{ group_id: string }>;
    for (const { group_id: groupId } of groups) {
      db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
      db.query("UPDATE user_groups SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, groupId);
      recordAccessEvent({ actorId, via: "web", action: "group.member_removed", groupId, targetUserId: userId, meta: { from: "reset" } }, timestamp);
    }
    const keys = db.query("SELECT id FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").all(userId) as Array<{ id: string }>;
    for (const key of keys) adminRevokeKey(actorId, key.id, "Access reset by an admin", { notify: false, meta: { reset: true } });
    const feeds = db.query("UPDATE calendar_feeds SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(timestamp, userId).changes;
    const routines = pauseRoutinesOf(userId);
    const removed = { ...before, feeds, routines };
    recordAccessEvent({ actorId, via: "web", action: "access.reset", targetUserId: userId, meta: removed }, timestamp);
    audit(actorId, null, "team.access_reset", { targetId: userId, ...removed });
    for (const [ownerId, count] of perOwner) notifyAccess({ userId: ownerId, kind: "access_reset", actorId, targetUserId: userId, count }, timestamp);
    notifyAccess({ userId, kind: "access_reset_self", actorId }, timestamp);
    return { removed, remaining: resetCounts(userId) };
  })();
}
