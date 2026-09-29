import { db, now } from "../db";

/**
 * The access activity log (docs/plan/research/2026-09-28-access-management-api-keys.md D288):
 * append-only `access_events`, ids and counts only (never titles, token material, or reasons
 * beyond their length, T215). `team_events` keeps its fixed vocabulary; everything about keys,
 * policies, and later groups lands here.
 */

export type AccessVia = "web" | "cli" | "mcp" | "rest" | "sweeper" | "migration";

/** The open vocabulary, validated here rather than by a CHECK (G13). */
export type AccessAction =
  | "key.created"
  | "key.narrowed"
  | "key.rotated"
  | "key.revoked"
  | "key.grace_ended"
  | "key.policy_blocked"
  | "policy.changed"
  // Groups and item access (Wave 32, D267, D270).
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "group.member_added"
  | "group.member_removed"
  | "item.access_changed"
  // Google sign-in (Wave 35): an admin's link allowance, the account reset before it, and unlinking.
  | "account.google_allowed"
  | "account.google_reset"
  | "account.google_unlinked"
  | "account.google_relinked"
  // Central management (Wave 33, D268, D286): admin reductions, Reset access, and templates.
  | "access.share_removed"
  | "access.share_lowered"
  | "access.reset"
  | "template.created"
  | "template.updated"
  | "template.deleted"
  | "template.applied";

export type AccessEvent = {
  actorId: string | null;
  via: AccessVia;
  action: AccessAction;
  targetUserId?: string | null;
  keyId?: string | null;
  groupId?: string | null;
  resource?: { kind: string; id: string } | null;
  meta?: Record<string, unknown> | null;
};

const insert = db.query(`INSERT INTO access_events (id, actor_id, via, action, target_user_id, group_id, key_id, resource_kind, resource_id, meta_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function recordAccessEvent(event: AccessEvent, timestamp = now()) {
  const meta = event.meta && Object.keys(event.meta).length ? JSON.stringify(event.meta) : null;
  insert.run(crypto.randomUUID(), event.actorId, event.via, event.action, event.targetUserId ?? null, event.groupId ?? null, event.keyId ?? null,
    event.resource?.kind ?? null, event.resource?.id ?? null, meta && meta.length <= 2048 ? meta : null, timestamp);
}

export type AccessEventRow = {
  id: string; action: string; via: string; createdAt: string; keyId: string | null; targetUserId: string | null;
  actor: { id: string; displayName: string } | null; meta: Record<string, unknown> | null;
};

/** The latest events about one key, newest first (the key's history in Settings and Team → Keys). */
export function keyEvents(keyId: string, limit = 20): AccessEventRow[] {
  const rows = db.query(`SELECT e.id, e.action, e.via, e.created_at, e.key_id, e.target_user_id, e.meta_json, e.actor_id, u.display_name AS actor_name
    FROM access_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.key_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`)
    .all(keyId, limit) as Array<{ id: string; action: string; via: string; created_at: string; key_id: string | null; target_user_id: string | null; meta_json: string | null; actor_id: string | null; actor_name: string | null }>;
  return rows.map((row) => ({
    id: row.id, action: row.action, via: row.via, createdAt: row.created_at, keyId: row.key_id, targetUserId: row.target_user_id,
    actor: row.actor_id && row.actor_name !== null ? { id: row.actor_id, displayName: row.actor_name } : null,
    meta: row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : null
  }));
}

// ------------------------------------------------------------------ Team → Access activity (Wave 33)

/** The action families the activity view filters by (§C.6: person, group, key, and action). */
export const ACTIVITY_CATEGORIES = ["keys", "groups", "items", "policies", "templates", "accounts"] as const;
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number];
const CATEGORY_SQL: Record<ActivityCategory, string> = {
  keys: "e.action LIKE 'key.%'",
  groups: "e.action LIKE 'group.%'",
  items: "(e.action LIKE 'item.%' OR e.action LIKE 'access.%')",
  policies: "e.action LIKE 'policy.%'",
  templates: "e.action LIKE 'template.%'",
  accounts: "e.action LIKE 'account.%'"
};
export const ACTIVITY_PAGE = 50;

export type ActivityFilter = { userId?: string; groupId?: string; keyId?: string; category?: ActivityCategory; cursor?: string };

type ActivityRow = {
  id: string; seq: number; action: string; via: string; created_at: string; meta_json: string | null;
  actor_id: string | null; actor_name: string | null; target_user_id: string | null; target_name: string | null;
  group_id: string | null; group_name: string | null; key_id: string | null; key_name: string | null; key_prefix: string | null;
  resource_kind: string | null; resource_id: string | null;
};

/** Counts, flags, and short words only: anything named like an id, or holding one, is dropped (T204). */
function safeMeta(json: string | null) {
  if (!json) return null;
  const meta = JSON.parse(json) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const idLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
  for (const [key, value] of Object.entries(meta)) {
    if (/ids?$/i.test(key) || /From$/.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") kept[key] = value;
    else if (typeof value === "string" && value.length <= 60 && !idLike(value)) kept[key] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length <= 60 && !idLike(entry))) kept[key] = value.slice(0, 20);
  }
  return Object.keys(kept).length ? kept : null;
}

const encodeCursor = (row: { created_at: string; seq: number }) => Buffer.from(JSON.stringify([row.created_at, row.seq])).toString("base64url");

function decodeCursor(cursor: string | undefined): [string, number] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return Array.isArray(value) && typeof value[0] === "string" && Number.isInteger(value[1]) ? [value[0], value[1] as number] : null;
  } catch {
    return null;
  }
}

/**
 * Team → Access activity (§C.6, D288): `access_events` newest first, 50 a page, filtered by person
 * (actor or target), group, key, or action family. Ids and counts only; an item is shown through
 * `present` (the viewer's redaction, D269), so its title and id appear only when the viewer can
 * open it. Group and key names are metadata admins already manage.
 */
export function listAccessActivity(filter: ActivityFilter, present: (kind: string, id: string) => unknown) {
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: ACTIVITY_PAGE + 1 };
  if (filter.userId) { where.push("(e.target_user_id = $userId OR e.actor_id = $userId)"); params.userId = filter.userId; }
  if (filter.groupId) { where.push("e.group_id = $groupId"); params.groupId = filter.groupId; }
  if (filter.keyId) { where.push("e.key_id = $keyId"); params.keyId = filter.keyId; }
  if (filter.category) where.push(CATEGORY_SQL[filter.category]);
  const cursor = decodeCursor(filter.cursor);
  if (cursor) {
    where.push("(e.created_at < $cursorAt OR (e.created_at = $cursorAt AND e.rowid < $cursorSeq))");
    params.cursorAt = cursor[0];
    params.cursorSeq = cursor[1];
  }
  const rows = db.query(`SELECT e.id, e.rowid AS seq, e.action, e.via, e.created_at, e.meta_json, e.actor_id, a.display_name AS actor_name,
      e.target_user_id, t.display_name AS target_name, e.group_id, g.name AS group_name, e.key_id, k.name AS key_name, k.key_prefix,
      e.resource_kind, e.resource_id
    FROM access_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users t ON t.id = e.target_user_id
      LEFT JOIN user_groups g ON g.id = e.group_id LEFT JOIN mcp_api_keys k ON k.id = e.key_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.created_at DESC, e.rowid DESC LIMIT $limit`).all(params) as ActivityRow[];
  const page = rows.slice(0, ACTIVITY_PAGE);
  return {
    events: page.map((row) => ({
      id: row.id, action: row.action, via: row.via, createdAt: row.created_at,
      actor: row.actor_id && row.actor_name !== null ? { id: row.actor_id, displayName: row.actor_name } : null,
      target: row.target_user_id && row.target_name !== null ? { id: row.target_user_id, displayName: row.target_name } : null,
      group: row.group_id ? { id: row.group_id, name: row.group_name } : null,
      key: row.key_id ? { id: row.key_id, name: row.key_name, prefix: row.key_prefix } : null,
      item: row.resource_kind && row.resource_id ? present(row.resource_kind, row.resource_id) : null,
      meta: safeMeta(row.meta_json)
    })),
    nextCursor: rows.length > ACTIVITY_PAGE ? encodeCursor(page.at(-1)!) : null
  };
}
