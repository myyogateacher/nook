import type { Migration } from "./types";

/**
 * Team invites (docs/plan/WAVES_18-20_SMALL.md §1.3, D161–D169). Id 018 was reserved by the Team
 * plan §11; it lands after 019 and 020 on existing installs, which `runMigrations` allows.
 *
 * - Only `sha256(token)` (hex) and a 6-character prefix are stored, never the token (D161, T136).
 * - `role` can never be `admin` (D163, T138): admins are promoted after sign-up.
 * - An invite lives at most 7 days (D164). The small tolerance absorbs rounding in `julianday`.
 * - `email` binds the invite to one address, compared case-insensitively (D162).
 * - The lifecycle (`created_by`, `used_*`, `revoked_*`) stays here, so `team_events` and its
 *   append-only triggers are untouched (D165, T83).
 */
export const teamInvitesMigration: Migration = {
  id: 18,
  name: "team_invites",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        token_prefix TEXT NOT NULL CHECK (length(token_prefix) = 6),
        email TEXT COLLATE NOCASE CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
        role TEXT NOT NULL CHECK (role IN ('member','viewer','guest')),
        note TEXT CHECK (note IS NULL OR length(note) <= 80),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL CHECK (
          julianday(expires_at) > julianday(created_at)
          AND julianday(expires_at) - julianday(created_at) <= 7.0001
        ),
        used_at TEXT,
        used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        revoked_at TEXT,
        revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        CHECK (used_at IS NULL OR revoked_at IS NULL),
        CHECK (used_by IS NULL OR used_at IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_team_invites_live ON team_invites(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_team_invites_created ON team_invites(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_invites_used_by ON team_invites(used_by) WHERE used_by IS NOT NULL;
    `);
  }
};
