import { db, now } from "../db";
import { presentItem } from "./effective";
import { ACCESS_KINDS, type AccessKind } from "./levels";

/**
 * Bell notices about access (Wave 33, access plan §C.11, migration 032): the owner hears when an
 * admin removes or lowers someone's access to their item or resets someone's access (D268, T214),
 * a member hears when they are added to or removed from a group, and a key owner hears when an
 * admin revokes their key. Stored as ids and counts; the line is written when the recipient reads
 * the bell, through `presentItem`, so a title shows only to someone who can open the item (D269).
 * Nobody is notified about their own action. Email: none of these has a mail kind in the plan yet
 * (O-A13 leaves it to the digest), so the bell is the only channel.
 */

export type AccessNoticeKind = "share_removed" | "share_lowered" | "access_reset" | "access_reset_self" | "group_added" | "group_removed" | "key_revoked";

export type AccessNotice = {
  userId: string;
  kind: AccessNoticeKind;
  actorId: string | null;
  targetUserId?: string | null;
  resource?: { kind: AccessKind; id: string } | null;
  groupId?: string | null;
  keyId?: string | null;
  count?: number | null;
};

const insert = db.query(`INSERT INTO access_notices (id, user_id, kind, actor_id, target_user_id, resource_kind, resource_id, group_id, key_id, count, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Queues one bell notice; a notice to the actor about their own action is dropped. Call inside the action's transaction. */
export function notifyAccess(notice: AccessNotice, timestamp = now()) {
  if (notice.actorId !== null && notice.actorId === notice.userId) return false;
  insert.run(crypto.randomUUID(), notice.userId, notice.kind, notice.actorId, notice.targetUserId ?? null, notice.resource?.kind ?? null, notice.resource?.id ?? null,
    notice.groupId ?? null, notice.keyId ?? null, notice.count ?? null, timestamp);
  return true;
}

type NoticeRow = {
  id: string; kind: string; actor_name: string | null; target_name: string | null; resource_kind: string | null; resource_id: string | null;
  group_name: string | null; key_name: string | null; count: number | null; created_at: string; read_at: string | null;
};

/**
 * Access notices open the notifications list: the line already names the item and the person, and
 * the list is the one path every client follows safely (T68). Linking into each module's item is
 * left for when the bell learns module deep links.
 */
export const ACCESS_NOTICE_HREF = "/notifications";

const isAccessKind = (value: string | null): value is AccessKind => value !== null && (ACCESS_KINDS as readonly string[]).includes(value);

function line(row: NoticeRow, recipientId: string) {
  const actor = row.actor_name ?? "An admin";
  const target = row.target_name ?? "someone";
  const item = isAccessKind(row.resource_kind) && row.resource_id ? presentItem(row.resource_kind, row.resource_id, recipientId) : null;
  const itemText = item ? (item.titleHidden ? `a ${item.title.split(" owned by ")[0]!.toLowerCase()}` : `“${item.title}”`) : "an item that is gone";
  const group = row.group_name ? `“${row.group_name}”` : "a group that was deleted";
  switch (row.kind) {
    case "share_removed": return `${actor} removed ${target}'s access to ${itemText}`;
    case "share_lowered": return `${actor} lowered ${target}'s access to ${itemText} to Can view or less`;
    case "access_reset": return `${actor} reset ${target}'s access, including ${row.count ?? 0} of your items`;
    case "access_reset_self": return `${actor} reset your access: direct shares, groups, API keys, and calendar feeds`;
    case "group_added": return `${actor} added you to the group ${group}`;
    case "group_removed": return `${actor} removed you from the group ${group}`;
    case "key_revoked": return `${actor} revoked your API key${row.key_name ? ` “${row.key_name}”` : ""}`;
    default: return "Your access changed";
  }
}

export type AccessNoticeItem = { id: string; title: string; href: string; late: false; read: boolean; createdAt: string; occurrenceStart: null };

/** The newest `limit` notices for the bell, shaped like calendar notifications. */
export function listAccessNotices(userId: string, options: { unread: boolean; limit: number }): AccessNoticeItem[] {
  const rows = db.query(`SELECT n.id, n.kind, a.display_name AS actor_name, t.display_name AS target_name, n.resource_kind, n.resource_id,
      g.name AS group_name, k.name AS key_name, n.count, n.created_at, n.read_at
    FROM access_notices n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN users t ON t.id = n.target_user_id
      LEFT JOIN user_groups g ON g.id = n.group_id LEFT JOIN mcp_api_keys k ON k.id = n.key_id AND k.user_id = n.user_id
    WHERE n.user_id = $userId AND ($unread = 0 OR n.read_at IS NULL) ORDER BY n.created_at DESC, n.rowid DESC LIMIT $limit`)
    .all({ userId, unread: options.unread ? 1 : 0, limit: options.limit }) as NoticeRow[];
  return rows.map((row) => ({
    id: row.id, title: line(row, userId), href: ACCESS_NOTICE_HREF,
    late: false, read: row.read_at !== null, createdAt: row.created_at, occurrenceStart: null
  }));
}

export const unreadAccessNotices = (userId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM access_notices WHERE user_id = ? AND read_at IS NULL").get(userId) as { count: number }).count;

export function markAccessNoticesRead(userId: string, target: { ids: string[] } | { all: true }, timestamp: string) {
  return ("all" in target
    ? db.query("UPDATE access_notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(timestamp, userId)
    : db.query("UPDATE access_notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))").run(timestamp, userId, JSON.stringify(target.ids))).changes;
}

export const sweepAccessNotices = (cutoff: string) => db.query("DELETE FROM access_notices WHERE created_at < ?").run(cutoff).changes;
