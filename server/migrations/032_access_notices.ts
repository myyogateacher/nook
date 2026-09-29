import type { Migration } from "./types";

/**
 * Bell notices for access changes (Wave 33, access plan §C.11, D268): "an admin removed someone's
 * access to your item" for the item's owner, "added to or removed from a group" for the member,
 * and "an admin revoked your key". The calendar `notifications` table cannot hold them: its `kind`
 * CHECK (021) is fixed to reminders and proposals, and an append-only migration cannot widen it
 * (the same reason as `access_events`, G13). So the bell reads a second, additive table.
 *
 * Ids and counts only (T204, T215): the text is built when the recipient reads the bell, so an
 * item's title appears only to someone who can open it, and a renamed item shows its new name.
 * `kind` is an open vocabulary validated in code. Rows are swept after 30 days like reminders.
 *
 * Needs 001 (users). Transactional and filesystem-free.
 */
export const accessNoticesMigration: Migration = {
  id: 32,
  name: "access_notices",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS access_notices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        resource_kind TEXT CHECK (resource_kind IS NULL OR length(resource_kind) <= 20),
        resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 64),
        group_id TEXT CHECK (group_id IS NULL OR length(group_id) <= 64),
        key_id TEXT CHECK (key_id IS NULL OR length(key_id) <= 64),
        count INTEGER CHECK (count IS NULL OR count >= 0),
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS access_notices_user ON access_notices(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS access_notices_unread ON access_notices(user_id) WHERE read_at IS NULL;
    `);
  }
};
