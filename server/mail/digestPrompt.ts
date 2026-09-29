import { z } from "zod";
import { audit, db, now } from "../db";
import { isValidTimeZone } from "../calendar/recurrence";
import { mailEnabled } from "../mail";
import { readEmailPrefs, writeEmailPrefs } from "./prefs";

/**
 * The one-time Today prompt for the email digest (D248, outbound email §B.1): "Get a morning summary
 * by email?". Shown only when email is on for this Nook and for the person, their address is
 * verified, their account is at least 7 days old, the digest is still off, and they have neither
 * dismissed the prompt nor chosen a cadence (recorded in `email_prefs.digest_prompt_at`, migration 035).
 */

/** The prompt appears once the account is this old (D248: "after 7 days"). */
export const DIGEST_PROMPT_AFTER_MS = 7 * 86_400_000;

export const digestPromptSchema = z.object({
  choice: z.enum(["daily", "weekly", "dismiss"]),
  /** The browser's zone, used only when the person has never saved email settings (so the digest lands at 08:00 their time). */
  tz: z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone").optional()
}).strict();

function promptSettled(userId: string) {
  const row = db.query("SELECT digest_prompt_at FROM email_prefs WHERE user_id = ?").get(userId) as { digest_prompt_at: string | null } | null;
  return row?.digest_prompt_at != null;
}

/** Whether Today shows the digest prompt to this person now. */
export function digestPromptVisible(userId: string, nowMs = Date.now()) {
  if (!mailEnabled()) return false;
  const user = db.query("SELECT email_verified_at, created_at FROM users WHERE id = ?").get(userId) as { email_verified_at: string | null; created_at: string } | null;
  if (!user || user.email_verified_at === null) return false;
  if (nowMs - Date.parse(user.created_at) < DIGEST_PROMPT_AFTER_MS) return false;
  const prefs = readEmailPrefs(userId);
  if (!prefs.enabled || prefs.digest !== "off") return false;
  return !promptSettled(userId);
}

/**
 * Records that the prompt is settled (dismissed, or a cadence chosen anywhere). Creates the prefs row
 * with its defaults when there is none, as an unsubscribe link does. Idempotent: the first time wins.
 */
export function markDigestPromptSettled(userId: string, at = now()) {
  const updated = db.query("UPDATE email_prefs SET digest_prompt_at = COALESCE(digest_prompt_at, ?) WHERE user_id = ?").run(at, userId).changes;
  if (!updated) db.query("INSERT OR IGNORE INTO email_prefs (user_id, updated_at, digest_prompt_at) VALUES (?, ?, ?)").run(userId, at, at);
}

/** The card's answer: turn the digest on at the saved time (08:00 by default), or dismiss the card. */
export function answerDigestPrompt(userId: string, input: z.infer<typeof digestPromptSchema>, nowMs = Date.now()) {
  if (input.choice === "dismiss") {
    db.transaction(() => {
      markDigestPromptSettled(userId);
      audit(userId, null, "mail.digest_prompt", { choice: "dismiss" });
    })();
    return { ok: true as const, prefs: readEmailPrefs(userId) };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readEmailPrefs(userId);
    const result = writeEmailPrefs(userId, {
      enabled: current.enabled,
      categories: current.categories,
      digest: input.choice,
      digestLocalTime: current.digestLocalTime,
      quietHours: current.quietStart !== null && current.quietEnd !== null ? { start: current.quietStart, end: current.quietEnd } : null,
      tz: current.revision === 0 && input.tz ? input.tz : current.tz,
      revision: current.revision
    }, nowMs);
    if (result.ok) {
      audit(userId, null, "mail.digest_prompt", { choice: input.choice });
      return { ok: true as const, prefs: result.prefs };
    }
  }
  return { ok: false as const, prefs: readEmailPrefs(userId) };
}
