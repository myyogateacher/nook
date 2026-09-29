import { afterAll, beforeAll } from "bun:test";
import { db } from "./harness";

/**
 * The whole suite shares one database, and Team lists stop at 500 accounts with active ones first
 * (`TEAM_LIST_LIMIT`). A file that creates many accounts can push another file's fresh account off
 * that list. Call this at the top of such a file: every account the file created is blocked when
 * the file ends (blocked accounts sort last), one at a time so the keep-one-admin rule is honoured.
 */
export function retireUsersAfterFile() {
  let firstRowid = 0;
  beforeAll(() => {
    firstRowid = (db.query("SELECT COALESCE(MAX(rowid), 0) AS id FROM users").get() as { id: number }).id;
  });
  afterAll(() => {
    const created = db.query("SELECT id FROM users WHERE rowid > ? AND disabled_at IS NULL").all(firstRowid) as Array<{ id: string }>;
    const at = new Date().toISOString();
    for (const { id } of created) {
      try {
        db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(at, id);
      } catch {
        // The last active admin stays active (users_keep_one_admin).
      }
    }
  });
}
