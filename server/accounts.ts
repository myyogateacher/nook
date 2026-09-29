import { config } from "./config";
import { audit, db, ensureDefaultFolder, now, type UserRow } from "./db";
import { claimInvite, inviteForRegistration } from "./team/invites";
import { hasActiveAdmin, recordBootstrapAdmin } from "./team/service";
import { applyInviteTemplate } from "./team/templates";

/**
 * Account creation shared by password registration and Google sign-in (Wave 35, D292), so the role,
 * the first-admin bootstrap, the invite claim, and the Default folder cannot drift between them.
 */

/** Registration is closed for this address (no open registration, no usable invite, not the first account). */
export class RegistrationClosedError extends Error {
  constructor() {
    super("Registration is disabled");
    this.name = "RegistrationClosedError";
  }
}

export type CreateAccountInput = {
  email: string;
  displayName: string;
  /** An argon2id hash, or UNUSABLE_PASSWORD (server/passwords.ts) for a Google-created account. */
  passwordHash: string;
  inviteHash: string | null;
  /** Google verified the address (D292); a bound invite verifies it too (D244). */
  emailVerified: boolean;
  /** Runs inside the creating transaction, after the user row exists (Google adds its identity). */
  afterInsert?: (userId: string, timestamp: string) => void;
};

/**
 * Creates the account in one transaction and returns its id and role. Throws RegistrationClosedError,
 * InviteError (invalid, expired, mismatched, or a lost claim race), or a SQLite constraint error when
 * the email is taken meanwhile; nothing is kept on any of them.
 */
export function createAccount(input: CreateAccountInput) {
  const id = crypto.randomUUID();
  let role: UserRow["role"] = "member";
  db.transaction(() => {
    const currentCount = (db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    const timestamp = now();
    // An empty instance ignores any token: its first account is the admin (D163). Otherwise the
    // invite is re-checked here, in the transaction that claims it.
    const invite = input.inviteHash && currentCount > 0 ? inviteForRegistration(input.inviteHash, input.email, timestamp) : null;
    if (!invite && !config.allowRegistration && currentCount > 0) throw new RegistrationClosedError();
    // D76: the first account on an empty instance is the admin, and so is an account registered
    // while no active admin exists (an upgrade where every account was disabled, so migration 017
    // had nobody to promote). The check and the insert share this transaction, so two concurrent
    // registrations cannot both become admin. A usable invite implies an active admin (D162).
    role = currentCount === 0 || !hasActiveAdmin() ? "admin" : invite ? invite.role : config.signupRole;
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.email, input.displayName, input.passwordHash, timestamp, role);
    if (role === "admin") recordBootstrapAdmin(id, timestamp);
    ensureDefaultFolder(id);
    if (invite) {
      // Single use (T141): a lost race throws INVITE_INVALID and rolls the new account back.
      claimInvite(invite.id, id, timestamp);
      audit(id, null, "team.invite_accept", { inviteId: invite.id, role });
      // D286 (Wave 33): the groups the invite's access template had when the invite was created, in
      // this same transaction (a template deleted since leaves template_id NULL: the role only).
      applyInviteTemplate(invite, id, timestamp);
    }
    // An invite bound to this address proved control of the inbox (D244), and so did Google (D292).
    if (input.emailVerified || invite?.email) db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(timestamp, id);
    input.afterInsert?.(id, timestamp);
  })();
  return { id, role };
}

/** Whether a new account could be created now for `email` without an invite (bootstrap or open registration). */
export function openRegistrationFor() {
  return config.allowRegistration || !db.query("SELECT 1 FROM users LIMIT 1").get();
}
