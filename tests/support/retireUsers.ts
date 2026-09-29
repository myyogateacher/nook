import { afterAll, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { db } from "./harness";

/**
 * The whole suite shares one database, and Team lists stop at 500 accounts with active ones first
 * (`TEAM_LIST_LIMIT`). A file that creates many accounts can push another file's fresh account off
 * that list. Call this at the top of such a file: every account the file created is blocked when
 * the file ends (blocked accounts sort last).
 *
 * It never leaves the database without an active admin for later files: members and others go
 * first; an admin the file created is blocked only while another active admin remains, and the
 * `users_keep_one_admin` trigger backs that up. `retireCreatedUsers` is the testable core.
 */
export function retireCreatedUsers(database: Pick<Database, "query">, firstRowid: number, at = new Date().toISOString()) {
  const created = database.query("SELECT id, role FROM users WHERE rowid > ? AND disabled_at IS NULL ORDER BY role = 'admin', rowid").all(firstRowid) as Array<{ id: string; role: string }>;
  const activeAdmins = () => (database.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL").get() as { count: number }).count;
  let blocked = 0;
  for (const user of created) {
    if (user.role === "admin" && activeAdmins() <= 1) continue;
    try {
      database.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(at, user.id);
      blocked += 1;
    } catch {
      // LAST_ADMIN: the trigger keeps one active admin whatever this code thinks.
    }
  }
  return { blocked, activeAdmins: activeAdmins() };
}

export function retireUsersAfterFile() {
  let firstRowid = 0;
  beforeAll(() => {
    firstRowid = (db.query("SELECT COALESCE(MAX(rowid), 0) AS id FROM users").get() as { id: number }).id;
  });
  afterAll(() => {
    const result = retireCreatedUsers(db, firstRowid);
    if (result.activeAdmins < 1) throw new Error("retireUsersAfterFile left no active admin");
  });
}
