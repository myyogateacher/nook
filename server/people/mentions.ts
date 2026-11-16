import { db } from "../db";
import { avatarUrlFor } from "../avatars";
import { can, type Role } from "../team/roles";
import { readPolicies } from "../team/policies";
import { workKindAdapter } from "../links/adapters";
import { MENTIONABLE_LIMIT_DEFAULT, MENTIONABLE_LIMIT_MAX, MENTION_QUERY_MAX, type MentionCandidate } from "../../shared/itemActivity";
import type { WorkKind } from "../../shared/workRefs";

/**
 * Who can be @mentioned on an item (docs/plan/MENTIONS.md §4, D1323, D1324, T660, T661):
 *
 * - the caller must be able to read the item (null otherwise: the route answers 404, T501);
 * - active people only (never integrations or blocked accounts), never the caller;
 * - readers of the item first, then names that start with the query, then by name;
 * - callers with `team.read` (members, admins, viewers: they see the whole Team) also get the people
 *   who cannot read the item, `canRead: false`, which the picker greys out; guests get readers only;
 * - guests who cannot read it are left out while the `share_with_guests` policy is off.
 *
 * Emails are never returned. A mention never shares the item.
 */

/** How many name matches are checked for access per lookup (the level check runs per person). */
const SCAN_MAX = 200;

export function mentionCandidates(viewer: { id: string; role: Role }, kind: WorkKind, itemId: string, options: { q?: string; limit?: number } = {}): MentionCandidate[] | null {
  const adapter = workKindAdapter(kind);
  if (!adapter || adapter.level(itemId, { userId: viewer.id }) === "none") return null;
  const q = (options.q ?? "").trim().toLowerCase().slice(0, MENTION_QUERY_MAX);
  const limit = Math.min(Math.max(1, options.limit ?? MENTIONABLE_LIMIT_DEFAULT), MENTIONABLE_LIMIT_MAX);
  const rows = db.query(`SELECT id, display_name, role, avatar_id FROM users WHERE kind = 'person' AND disabled_at IS NULL AND id <> $viewer
      AND ($q = '' OR instr(lower(display_name), $q) > 0)
    ORDER BY CASE WHEN $q <> '' AND substr(lower(display_name), 1, length($q)) = $q THEN 0 ELSE 1 END, display_name COLLATE NOCASE, id LIMIT ${SCAN_MAX}`)
    .all({ viewer: viewer.id, q }) as Array<{ id: string; display_name: string; role: Role; avatar_id: string | null }>;
  const seesTeam = can(viewer.role, "team.read");
  const guestsShown = readPolicies().shareWithGuests;
  const readers: MentionCandidate[] = [];
  const others: MentionCandidate[] = [];
  for (const row of rows) {
    const canRead = adapter.level(itemId, { userId: row.id }) !== "none";
    if (!canRead && (!seesTeam || (row.role === "guest" && !guestsShown))) continue;
    (canRead ? readers : others).push({ id: row.id, displayName: row.display_name, avatarUrl: avatarUrlFor(row.id, row.avatar_id), canRead });
    if (readers.length >= limit) break;
  }
  return [...readers, ...others].slice(0, limit);
}

/** 120 lookups a minute per person (as the board readers' picker): the picker asks as the person types. */
const WINDOW_MS = 60_000;
const PER_WINDOW = 120;
const windows = new Map<string, { start: number; count: number }>();

/** Seconds to wait, or 0 when the lookup may go ahead. */
export function mentionLookupRetryAfter(userId: string, time = Date.now()) {
  const current = windows.get(userId);
  if (!current || time - current.start >= WINDOW_MS) {
    if (windows.size > 5_000) windows.clear();
    windows.set(userId, { start: time, count: 1 });
    return 0;
  }
  current.count += 1;
  return current.count > PER_WINDOW ? Math.ceil((current.start + WINDOW_MS - time) / 1000) : 0;
}
