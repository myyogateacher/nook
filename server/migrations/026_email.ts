import { addColumn, type Migration } from "./types";

/**
 * Outbound email (docs/plan/research/2026-09-28-outbound-email.md §B.3, D231–D260). One step for the
 * whole email schema, including tables Waves 29–30 fill:
 *
 * - `users.email_verified_at` (D244). Backfill: the bootstrap admin (the `team.bootstrap_admin` audit,
 *   else the oldest admin) and every account that joined through an email-bound invite are verified;
 *   everyone else is unverified and gets only verify and security mail until they verify.
 * - `email_prefs`: per-user switches (no row = defaults, like `user_preferences`), with a CAS revision.
 * - `mail_outbox`: one row per mail, written in the action's transaction. It holds ids and counts
 *   only (never rendered HTML, never a credential token); `idempotency_key` is sent to the provider
 *   and is stable across retries (D.2).
 * - `mail_suppressions`, `mail_webhook_events` (Wave 29 webhooks), `auth_tokens` (verify now,
 *   password reset in Wave 30), `email_mutes` (Wave 29, D256), and `reminders.channels` (Wave 29).
 *
 * Needs 001 (users), 013 (reminders), 017 (roles), and 018 (team_invites); independent of 023–025
 * and 027. Transactional and filesystem-free.
 */
export const emailMigration: Migration = {
  id: 26,
  name: "email",
  up(db) {
    addColumn(db, "users", "email_verified_at", "TEXT");
    db.exec(`
      CREATE TABLE email_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        categories TEXT NOT NULL DEFAULT '{"assignments":1,"comments":1,"sharing":1,"proposals":1,"sprints":0,"bin":0,"reminders":1}'
          CHECK (json_valid(categories) AND json_type(categories) = 'object' AND length(categories) <= 512),
        digest TEXT NOT NULL DEFAULT 'off' CHECK (digest IN ('off','daily','weekly')),
        digest_local_time TEXT NOT NULL DEFAULT '08:00' CHECK (digest_local_time GLOB '[0-2][0-9]:[0-5][0-9]'),
        quiet_start TEXT CHECK (quiet_start IS NULL OR quiet_start GLOB '[0-2][0-9]:[0-5][0-9]'),
        quiet_end TEXT CHECK (quiet_end IS NULL OR quiet_end GLOB '[0-2][0-9]:[0-5][0-9]'),
        tz TEXT NOT NULL DEFAULT 'UTC' CHECK (length(tz) BETWEEN 1 AND 64),
        next_digest_at TEXT,
        last_digest_at TEXT,
        unsub_epoch INTEGER NOT NULL DEFAULT 0 CHECK (unsub_epoch >= 0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL,
        CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
      );

      CREATE TABLE mail_outbox (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        to_hash TEXT NOT NULL CHECK (length(to_hash) = 12),
        to_address TEXT CHECK (to_address IS NULL OR length(to_address) <= 254),
        template TEXT NOT NULL CHECK (length(template) BETWEEN 1 AND 40),
        class TEXT NOT NULL CHECK (class IN ('security','account','activity','reminders','digest')),
        category TEXT CHECK (category IS NULL OR length(category) <= 20),
        coalesce_key TEXT CHECK (coalesce_key IS NULL OR length(coalesce_key) <= 120),
        payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed','skipped','dead')),
        skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) <= 40),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        not_before TEXT NOT NULL,
        claimed_at TEXT,
        provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) <= 64),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
        created_at TEXT NOT NULL,
        sent_at TEXT,
        CHECK (user_id IS NOT NULL OR to_address IS NOT NULL OR status NOT IN ('queued','sending'))
      );
      CREATE INDEX idx_outbox_due ON mail_outbox(not_before) WHERE status = 'queued';
      CREATE INDEX idx_outbox_coalesce ON mail_outbox(coalesce_key) WHERE status = 'queued' AND coalesce_key IS NOT NULL;
      CREATE INDEX idx_outbox_user ON mail_outbox(user_id, created_at);
      CREATE INDEX idx_outbox_created ON mail_outbox(created_at DESC);
      CREATE INDEX idx_outbox_sent ON mail_outbox(sent_at) WHERE sent_at IS NOT NULL;

      CREATE TABLE mail_suppressions (
        address_hash TEXT PRIMARY KEY CHECK (length(address_hash) = 64),
        reason TEXT NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
        provider_event_id TEXT CHECK (provider_event_id IS NULL OR length(provider_event_id) <= 100),
        created_at TEXT NOT NULL
      );

      CREATE TABLE auth_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','password_reset')),
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        email_at_issue TEXT NOT NULL COLLATE NOCASE CHECK (length(email_at_issue) BETWEEN 3 AND 254),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, purpose, created_at);

      CREATE TABLE mail_webhook_events (
        svix_id TEXT PRIMARY KEY CHECK (length(svix_id) BETWEEN 1 AND 100),
        received_at TEXT NOT NULL
      );

      CREATE TABLE email_mutes (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('board','calendar','collection')),
        target_id TEXT NOT NULL CHECK (length(target_id) = 36),
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, target_type, target_id)
      ) WITHOUT ROWID;
    `);
    addColumn(db, "reminders", "channels", "TEXT NOT NULL DEFAULT 'push' CHECK (channels IN ('push','email','push_email'))");

    // Backfill (D244). The invite link proved control of the inbox; so did setting up the instance.
    const at = new Date().toISOString();
    db.query(`UPDATE users SET email_verified_at = ? WHERE email_verified_at IS NULL AND id IN (
        SELECT used_by FROM team_invites WHERE used_by IS NOT NULL AND email IS NOT NULL AND lower(email) = lower(users.email))`).run(at);
    const bootstrap = db.query("SELECT actor_id AS id FROM audit_log WHERE event_type = 'team.bootstrap_admin' AND actor_id IS NOT NULL ORDER BY created_at LIMIT 1").get() as { id: string } | null
      ?? db.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1").get() as { id: string } | null;
    if (bootstrap) db.query("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL").run(at, bootstrap.id);
  }
};
