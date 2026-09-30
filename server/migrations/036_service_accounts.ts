import { addColumn, type Migration } from "./types";

/**
 * Service accounts (Wave 36, D287, T212): `users.kind` already exists (025). This adds what the
 * database itself should refuse, so no code path (web, CLI, a future route) can get around it:
 *
 * - `users.description`: the admin's optional note on an integration (≤ 200 characters).
 * - `users.retired_at`: set when a deleted integration is kept for attribution (it made content, or
 *   it ever had a key, whose usage history stays). Only an integration, only a blocked one, and
 *   final: `users_retired_final` refuses clearing it or lifting the block, so no path revives it.
 * - `users_kind_fixed`: a person never becomes an integration, nor the reverse.
 * - `users_service_role` (insert and update): an integration is a member or a viewer, never an
 *   admin or a guest.
 * - `sessions_person_only` (insert, and `_move` on a change of `user_id`): no session row can be
 *   written for or moved onto an integration, so it can never hold a cookie, whatever path is tried.
 * - `google_identities_person_only` (insert, and `_move`): no Google identity is linked to an
 *   integration.
 *
 * Needs 001, 017, 025, and 034. Transactional and filesystem-free; re-running changes nothing.
 */
export const serviceAccountsMigration: Migration = {
  id: 36,
  name: "service_accounts",
  up(db) {
    addColumn(db, "users", "description", "TEXT CHECK (description IS NULL OR length(description) <= 200)");
    addColumn(db, "users", "retired_at", "TEXT CHECK (retired_at IS NULL OR (kind = 'service' AND disabled_at IS NOT NULL))");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS users_kind_fixed BEFORE UPDATE OF kind ON users
      WHEN NEW.kind <> OLD.kind
      BEGIN SELECT RAISE(ABORT, 'KIND_FIXED'); END;

      CREATE TRIGGER IF NOT EXISTS users_service_role_insert BEFORE INSERT ON users
      WHEN NEW.kind = 'service' AND NEW.role NOT IN ('member', 'viewer')
      BEGIN SELECT RAISE(ABORT, 'SERVICE_ROLE'); END;

      CREATE TRIGGER IF NOT EXISTS users_service_role_update BEFORE UPDATE OF role ON users
      WHEN NEW.kind = 'service' AND NEW.role NOT IN ('member', 'viewer')
      BEGIN SELECT RAISE(ABORT, 'SERVICE_ROLE'); END;

      CREATE TRIGGER IF NOT EXISTS sessions_person_only BEFORE INSERT ON sessions
      WHEN (SELECT kind FROM users WHERE id = NEW.user_id) = 'service'
      BEGIN SELECT RAISE(ABORT, 'SERVICE_NO_SESSION'); END;

      CREATE TRIGGER IF NOT EXISTS google_identities_person_only BEFORE INSERT ON google_identities
      WHEN (SELECT kind FROM users WHERE id = NEW.user_id) = 'service'
      BEGIN SELECT RAISE(ABORT, 'SERVICE_NO_GOOGLE'); END;

      CREATE TRIGGER IF NOT EXISTS sessions_person_only_move BEFORE UPDATE OF user_id ON sessions
      WHEN (SELECT kind FROM users WHERE id = NEW.user_id) = 'service'
      BEGIN SELECT RAISE(ABORT, 'SERVICE_NO_SESSION'); END;

      CREATE TRIGGER IF NOT EXISTS google_identities_person_only_move BEFORE UPDATE OF user_id ON google_identities
      WHEN (SELECT kind FROM users WHERE id = NEW.user_id) = 'service'
      BEGIN SELECT RAISE(ABORT, 'SERVICE_NO_GOOGLE'); END;

      CREATE TRIGGER IF NOT EXISTS users_retired_final BEFORE UPDATE OF retired_at, disabled_at ON users
      WHEN OLD.retired_at IS NOT NULL AND (NEW.retired_at IS NULL OR NEW.retired_at <> OLD.retired_at OR NEW.disabled_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'RETIRED'); END;
    `);
  }
};
