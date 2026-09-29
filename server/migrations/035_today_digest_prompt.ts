import { addColumn, type Migration } from "./types";

/**
 * The Today digest prompt (D248, outbound email §B.1): the digest is off by default, and Today asks
 * once, "Get a morning summary by email?". `email_prefs.digest_prompt_at` records when that was
 * settled: the person dismissed the card, or chose a cadence (from the card or in Settings). It is
 * not a setting the person edits, so it takes no part in the prefs' compare-and-swap revision.
 *
 * The email prefs row, not `user_preferences`, holds it: the prompt is about the digest, and email
 * prefs already create their row on demand (an unsubscribe link does). Needs 026 only; 030–034
 * belong to parallel waves. Transactional and filesystem-free; re-running changes nothing.
 */
export const todayDigestPromptMigration: Migration = {
  id: 35,
  name: "today_digest_prompt",
  up(db) {
    addColumn(db, "email_prefs", "digest_prompt_at", "TEXT");
  }
};
