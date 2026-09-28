import type { Migration } from "./types";

/**
 * Outbound email, second release (Wave 29, docs/plan/research/2026-09-28-outbound-email.md §B.4,
 * §A.2 #28). Migration 026 already holds the prefs, outbox, suppressions, webhook replay guard,
 * mutes, and `reminders.channels`; two things it could not hold:
 *
 * - `mail_soft_bounces`: a counter per address hash for transient (soft) bounces. Three within
 *   seven days suppress non-security mail until `suppressed_until` (three days later); it then
 *   clears itself, and the owner can clear it at once with "Try again". Hard bounces and
 *   complaints stay in `mail_suppressions`.
 * - `mail_share_log`: who was newly shared what, by whom and when (ids only). The share tables
 *   rewrite their rows on every save, so their `created_at` cannot say what is new since the last
 *   digest; this log can. The sweeper keeps 30 days.
 *
 * Needs 001 (users) only. Transactional and filesystem-free. 023–025 belong to other plans.
 */
export const emailDigestsMigration: Migration = {
  id: 28,
  name: "email_digests",
  up(db) {
    db.exec(`
      CREATE TABLE mail_soft_bounces (
        address_hash TEXT PRIMARY KEY CHECK (length(address_hash) = 64),
        count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        suppressed_until TEXT
      ) WITHOUT ROWID;

      CREATE TABLE mail_share_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('note','folder','file','board','calendar','collection','view')),
        item_id TEXT NOT NULL CHECK (length(item_id) = 36),
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_mail_share_log_user ON mail_share_log(user_id, created_at);
    `);
  }
};
