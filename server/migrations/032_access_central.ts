import { addColumn, type Migration } from "./types";

/**
 * Central access management (Wave 33, access plan §C.6, §C.11, D268, D286, D288). Additive only:
 *
 * - `access_notices`: bell lines about access ("an admin removed someone's access to your item",
 *   group additions and removals, admin key revokes). The calendar `notifications.kind` CHECK (021)
 *   is fixed to reminders and proposals, and an append-only migration cannot widen it (the same
 *   reason as `access_events`, G13), so the bell reads a second table. Ids, counts, and a level
 *   word only (T204, T215): the text is built when the recipient reads the bell, so an item's title
 *   appears only to someone who can open it. `kind` is an open vocabulary validated in code.
 * - `team_invites` gains a snapshot of its access template (D286): the group ids, name, and
 *   revision at the moment the invite was created. Acceptance applies the snapshot, so editing
 *   the template later never changes an invite already sent. `template_id` (025, ON DELETE SET
 *   NULL) still says whether the template exists: once it is deleted the invite keeps its role and
 *   adds no groups.
 * - `access_events(actor_id, created_at)`: Team → Access activity filters by person as actor or
 *   target; 025 indexed only the target.
 *
 * Needs 001, 018, and 025. Transactional and filesystem-free.
 */
export const accessCentralMigration: Migration = {
  id: 32,
  name: "access_central",
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
        level TEXT CHECK (level IS NULL OR level IN ('view','comment','edit','manage')),
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS access_notices_user ON access_notices(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS access_notices_unread ON access_notices(user_id) WHERE read_at IS NULL;
      CREATE INDEX IF NOT EXISTS access_events_actor ON access_events(actor_id, created_at DESC);
    `);
    addColumn(db, "team_invites", "template_group_ids", "TEXT CHECK (template_group_ids IS NULL OR (json_valid(template_group_ids) AND json_type(template_group_ids) = 'array'))");
    addColumn(db, "team_invites", "template_name", "TEXT CHECK (template_name IS NULL OR length(template_name) BETWEEN 1 AND 60)");
    addColumn(db, "team_invites", "template_revision", "INTEGER CHECK (template_revision IS NULL OR template_revision >= 1)");
  }
};
