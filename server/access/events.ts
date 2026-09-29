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
  | "account.google_unlinked";

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
