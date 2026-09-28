import { audit, db } from "./db";
import { revokeUserPushSubscriptions } from "./calendar/push";
import { mailTwoFactor } from "./mail/triggers";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: bun server/reset-totp.ts user@example.com");
  process.exit(2);
}

const user = db.query("SELECT id FROM users WHERE email = ? COLLATE NOCASE AND disabled_at IS NULL").get(email) as { id: string } | null;
if (!user) {
  console.error("No active account exists for that email address.");
  process.exit(1);
}

db.transaction(() => {
  db.query("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_counter = NULL, totp_recovery_codes = NULL WHERE id = ?").run(user.id);
  db.query("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  revokeUserPushSubscriptions(user.id, "sessions_revoked");
  audit(user.id, null, "auth.totp_admin_reset");
  // Security mail (outbound email #6); the running server's dispatcher sends it.
  mailTwoFactor(user.id, "admin_reset");
})();

console.log("Two-factor authentication was reset and all sessions were revoked. The user must enroll again at next sign-in.");
