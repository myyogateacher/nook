import { audit, db, now } from "../db";
import { readableBoard } from "../tasks/access";
import { readableCalendar } from "../calendar/access";
import { readableCollection } from "../collections/access";

/**
 * Per-board, per-calendar, and per-collection "Mute emails" (docs/plan/research/2026-09-28-
 * outbound-email.md §B.1 D249, D256). A mute is the user's own switch, set from the item's settings
 * sheet or Settings → Email. It applies to activity about that item (assignments, comments,
 * sprints, event changes) and never to security or account mail, the digest, or a reminder the
 * user set themselves. Like every email preference it gates sending only, never access (T97).
 * Triggers skip muted items when they enqueue, and the resolver drops them again at send time, so a
 * mute set while a mail waits still holds.
 */

export const MUTE_TYPES = ["board", "calendar", "collection"] as const;
export type MuteType = typeof MUTE_TYPES[number];
export const MAX_MUTES = 500;

export const isMuteType = (value: string): value is MuteType => (MUTE_TYPES as readonly string[]).includes(value);

export function isMuted(userId: string, type: MuteType, targetId: string) {
  return db.query("SELECT 1 FROM email_mutes WHERE user_id = ? AND target_type = ? AND target_id = ?").get(userId, type, targetId) !== null;
}

/** The target's name when the user can read it (a mute is only offered, and listed, for readable items). */
function readableName(userId: string, type: MuteType, targetId: string) {
  switch (type) {
    case "board": return readableBoard(targetId, userId)?.name ?? null;
    case "calendar": return readableCalendar(targetId, userId)?.name ?? null;
    case "collection": return readableCollection(targetId, userId)?.name ?? null;
  }
}

export type MuteSummary = { targetType: MuteType; targetId: string; name: string; createdAt: string };

/** The user's mutes on items they can still read, newest first (names resolved now). */
export function listMutes(userId: string): { mutes: MuteSummary[] } {
  const rows = db.query("SELECT target_type, target_id, created_at FROM email_mutes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, MAX_MUTES) as Array<{ target_type: MuteType; target_id: string; created_at: string }>;
  const mutes = rows.flatMap((row) => {
    const name = readableName(userId, row.target_type, row.target_id);
    return name === null ? [] : [{ targetType: row.target_type, targetId: row.target_id, name, createdAt: row.created_at }];
  });
  return { mutes };
}

export class MuteError extends Error {
  constructor(public status: 404 | 409, message: string, public code: string) {
    super(message);
  }
}

/** Mutes an item the user can read. Idempotent. */
export function muteTarget(userId: string, type: MuteType, targetId: string) {
  if (readableName(userId, type, targetId) === null) throw new MuteError(404, "Not found", "NOT_FOUND");
  db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM email_mutes WHERE user_id = ?").get(userId) as { count: number }).count;
    if (!isMuted(userId, type, targetId) && count >= MAX_MUTES) throw new MuteError(409, `You can mute at most ${MAX_MUTES} items`, "LIMIT_REACHED");
    const inserted = db.query("INSERT OR IGNORE INTO email_mutes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)").run(userId, type, targetId, now()).changes;
    if (inserted) audit(userId, null, "mail.mute", { targetType: type, targetId });
  })();
  return { muted: true as const };
}

/** Unmutes. Idempotent, and works for an item the user can no longer read (clean-up). */
export function unmuteTarget(userId: string, type: MuteType, targetId: string) {
  const removed = db.query("DELETE FROM email_mutes WHERE user_id = ? AND target_type = ? AND target_id = ?").run(userId, type, targetId).changes;
  if (removed) audit(userId, null, "mail.unmute", { targetType: type, targetId });
  return { muted: false as const };
}
