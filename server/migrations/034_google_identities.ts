import { addColumn, type Migration } from "./types";

/**
 * Google sign-in (Wave 35, docs/plan/WAVE_35_GOOGLE_SIGNIN.md §2, D291–D299).
 *
 * - `google_identities`: one Google account (`subject` = the ID token's `sub`) per Nook account and
 *   one Nook account per `sub`. `email` is the verified address when it was linked; `picture_url`
 *   the profile picture Google last reported. Google's tokens are never stored.
 * - `google_auth_flows`: the server half of a sign-in round trip, keyed by the SHA-256 of the
 *   browser's flow cookie; single use, 10 minutes, swept hourly.
 * - `users.avatar_id`: the UUID of the stored avatar file (`DATA_DIR/avatars/<id>`), NULL when none.
 * - `sessions.reauth_at`: when this session last confirmed the account with Google (D297).
 * - `users.google_link_allowed_until`: an admin allowed the next Google sign-in with this account's
 *   address to link it (one time, 24 hours); NULL otherwise.
 * - `google_auth_flows.client_hash`: the hashed client address, to cap live flows per client.
 *
 * Needs only 001 (users, sessions). Independent of 030–033 (parallel waves). Filesystem-free.
 */
function apply034(db: Parameters<Migration["up"]>[0]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS google_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        subject TEXT NOT NULL UNIQUE CHECK (length(subject) BETWEEN 1 AND 255),
        email TEXT NOT NULL,
        picture_url TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS google_auth_flows (
        id TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL,
        nonce TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        intent TEXT NOT NULL CHECK (intent IN ('signin', 'invite', 'link', 'reauth')),
        stage TEXT NOT NULL DEFAULT 'authorize' CHECK (stage IN ('prepared', 'authorize', 'second_factor')),
        return_to TEXT NOT NULL,
        invite_hash TEXT,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
    `);
    // Every column is added only when missing (S6: no boot-time repair; a scratch database that ran
    // an earlier shape of 034 on the Wave 35 branch is recreated).
    addColumn(db, "google_auth_flows", "client_hash", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS google_auth_flows_expiry ON google_auth_flows(expires_at);
      CREATE INDEX IF NOT EXISTS google_auth_flows_client ON google_auth_flows(client_hash, expires_at);
    `);
    addColumn(db, "users", "avatar_id", "TEXT");
    addColumn(db, "sessions", "reauth_at", "TEXT");
    // An admin's one-time, 24-hour permission for the next Google sign-in with this address to link,
    // or (on a linked account) to re-link a recreated Google account.
    addColumn(db, "users", "google_link_allowed_until", "TEXT");
    // When an admin reset the account (N2c): shown once at the next sign-in, cleared when read.
    addColumn(db, "users", "google_reset_notice_at", "TEXT");
    addColumn(db, "users", "google_reset_notice_json", "TEXT");
    // A re-linking allowance also removes the password and two-factor at the re-link (S1), 1 or 0.
    addColumn(db, "users", "google_relink_remove_credentials", "INTEGER");
    // The last Google sign-in that could not link this account, for the admin (Q1): when, and why.
    addColumn(db, "users", "google_last_refusal_at", "TEXT");
    addColumn(db, "users", "google_last_refusal_reason", "TEXT");
}

export const googleIdentitiesMigration: Migration = {
  id: 34,
  name: "google_identities",
  up: apply034
};
