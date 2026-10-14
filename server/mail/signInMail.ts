import { db } from "../db";
import { mailEnabled } from "../mail";
import { enqueueMail, type Payload } from "./outbox";
import type { Recipient, Resolution } from "./resolve";
import { logger } from "../log";

const slog = logger("mail");

/**
 * The outbound email plan's two "later" mails (§A.2 #9 and #14, §A.3), as built.
 *
 * - **New sign-in** (`security.new_sign_in`, security class): a sign-in from a device the account
 *   has no record of (server/signInDevices.ts). Security mail cannot be switched off, but unlike the
 *   other security mail it goes to **verified addresses only** (an unverified address on an open
 *   instance may not be the account holder's, and sign-ins are frequent). At most one per account per
 *   10 minutes: a sign-in while one is queued joins it, and the next one waits until 10 minutes after
 *   the last. The payload holds the device's family codes, the method code, and the time; no address.
 * - **Welcome** (`account.welcome`, account class, one-off, D232): queued by the account's first
 *   sign-in (the one registration or invite acceptance makes), sent a minute later so the
 *   verification mail is not overtaken. Only while email is on and the address is verified; an
 *   unverified address waits and is queued when it is verified (within 7 days). `users.welcome_mail`
 *   records the step, so it is queued at most once; accounts from before migration 044 have NULL and
 *   never get it. The outbox row survives a restart.
 */

export const NEW_SIGN_IN_GAP_MS = 10 * 60_000;
export const WELCOME_DELAY_MS = 60_000;
/** An address verified later than this after registration gets no welcome. */
export const WELCOME_WAIT_MS = 7 * 86_400_000;
const SIGN_IN_LIST_MAX = 10;

function safely(label: string, run: () => void) {
  try {
    run();
  } catch (error) {
    slog.error(`Mail enqueue failed: purpose=${label}`, error);
  }
}

export type SignInEntry = { browser: string; os: string; method: string; at: string };

const verified = (userId: string) => (db.query("SELECT email_verified_at FROM users WHERE id = ? AND kind = 'person'").get(userId) as { email_verified_at: string | null } | null)?.email_verified_at != null;

/** #9: queues (or joins) the "New sign-in" mail. Call after the sign-in's device row is written. */
export function mailNewSignIn(userId: string, entry: SignInEntry, nowMs = Date.now()) {
  let done = false;
  safely("security.new_sign_in", () => {
    if (!verified(userId)) return;
    const last = db.query(`SELECT MAX(COALESCE(sent_at, created_at)) AS at FROM mail_outbox
        WHERE user_id = ? AND template = 'security.new_sign_in' AND status <> 'queued'`).get(userId) as { at: string | null };
    done = enqueueMail({
      userId, template: "security.new_sign_in", payload: { signIns: [entry], total: 1 }, nowMs,
      coalesceKey: `security.new_sign_in:${userId}`,
      notBeforeMs: last.at ? Date.parse(last.at) + NEW_SIGN_IN_GAP_MS : 0,
      merge: (queued: Payload, incoming: Payload) => ({
        signIns: [...(Array.isArray(queued.signIns) ? queued.signIns : []), ...(Array.isArray(incoming.signIns) ? incoming.signIns : [])].slice(-SIGN_IN_LIST_MAX),
        total: (typeof queued.total === "number" ? queued.total : 1) + 1
      })
    }) !== null;
  });
  return done;
}

/** Queues the welcome mail a minute from now and records it; false when nothing was queued. */
function queueWelcome(userId: string, nowMs: number) {
  const id = enqueueMail({ userId, template: "account.welcome", payload: {}, notBeforeMs: nowMs + WELCOME_DELAY_MS, nowMs });
  db.query("UPDATE users SET welcome_mail = ? WHERE id = ?").run(id ? "queued" : "skipped", userId);
  return id !== null;
}

/**
 * #14 on every sign-in: only an account in `pending` (made by registration or an invite since
 * migration 044) moves on, so this is a no-op after the first sign-in.
 */
export function startWelcomeMail(userId: string, nowMs = Date.now()) {
  safely("account.welcome", () => {
    db.transaction(() => {
      const row = db.query("SELECT welcome_mail, email_verified_at FROM users WHERE id = ? AND kind = 'person'").get(userId) as { welcome_mail: string | null; email_verified_at: string | null } | null;
      if (!row || row.welcome_mail !== "pending") return;
      if (!mailEnabled()) {
        db.query("UPDATE users SET welcome_mail = 'skipped' WHERE id = ?").run(userId);
        return;
      }
      if (row.email_verified_at === null) {
        db.query("UPDATE users SET welcome_mail = 'waiting' WHERE id = ?").run(userId);
        return;
      }
      queueWelcome(userId, nowMs);
    })();
  });
}

/** #14 when an address is verified: a welcome that was waiting for it is queued (within 7 days of registration). */
export function releaseWelcomeMail(userId: string, nowMs = Date.now()) {
  safely("account.welcome", () => {
    db.transaction(() => {
      const row = db.query("SELECT welcome_mail, created_at FROM users WHERE id = ? AND kind = 'person'").get(userId) as { welcome_mail: string | null; created_at: string } | null;
      if (!row || row.welcome_mail !== "waiting") return;
      if (!mailEnabled() || nowMs - Date.parse(row.created_at) > WELCOME_WAIT_MS) {
        db.query("UPDATE users SET welcome_mail = 'skipped' WHERE id = ?").run(userId);
        return;
      }
      queueWelcome(userId, nowMs);
    })();
  });
}

// --- Send-time resolution -------------------------------------------------------------------------

const unverified = (recipient: Recipient) => !verified(recipient.id);

export function resolveNewSignIn(payload: Record<string, unknown>, recipient: Recipient): Resolution {
  // Security mail to unverified addresses goes out (D245), but this one does not (see above).
  if (unverified(recipient)) return { skip: "unverified" };
  const signIns = (Array.isArray(payload.signIns) ? payload.signIns : []).flatMap((item): SignInEntry[] => {
    if (!item || typeof item !== "object") return [];
    const { browser, os, method, at } = item as Record<string, unknown>;
    return typeof browser === "string" && typeof os === "string" && typeof method === "string" && typeof at === "string" && !Number.isNaN(Date.parse(at))
      ? [{ browser, os, method, at }] : [];
  });
  if (!signIns.length) return { skip: "empty" };
  const total = typeof payload.total === "number" && payload.total >= signIns.length ? payload.total : signIns.length;
  return { data: { signIns: signIns.reverse(), total } };
}

export function resolveWelcome(recipient: Recipient): Resolution {
  if (unverified(recipient)) return { skip: "unverified" };
  return { data: { displayName: recipient.displayName, role: recipient.role } };
}
