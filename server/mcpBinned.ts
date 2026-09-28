import { listBin, restoreItem } from "./bin";
import { audit, db } from "./db";
import { restoreTaskItem } from "./tasks/bin";

/**
 * "Review / Restore all" for one MCP key (docs/plan/WAVES_18-20_SMALL.md D175, T142): what the key
 * moved to the Bin that is still there, found from the audit log (every bin tool's `*.delete` row
 * carries `{via: "mcp", keyId}`), and a bulk restore through the normal services, so the usual
 * predicates (notes: the owner; cards, events, rows: the owner or whoever binned them) still apply.
 *
 * The scan is unindexed (no migration this wave): actor, type, and window narrow it, and
 * tests/mcpBinUndo.test.ts measures it against a 200k-row audit table (MYNOTES_PERF=1).
 */

export const BINNED_WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;
export type BinnedWindow = keyof typeof BINNED_WINDOWS;
export const isBinnedWindow = (value: unknown): value is BinnedWindow => typeof value === "string" && Object.hasOwn(BINNED_WINDOWS, value);
export const BINNED_LIMIT = 500;

const BIN_EVENTS = { "note.delete": "note", "task.card_delete": "card", "event.delete": "event", "collection.row_delete": "collection_row" } as const;
type BinnedType = typeof BIN_EVENTS[keyof typeof BIN_EVENTS];
const EVENT_TYPES = JSON.stringify(Object.keys(BIN_EVENTS));
/** An item binned again later by someone else is not this key's to undo. */
const SAME_BINNING_MS = 60_000;

export type BinnedItem = { type: BinnedType; id: string; title: string; binnedAt: string; restorable: boolean };
type Entry = BinnedItem & { inBin: boolean };

const ownsKey = (userId: string, keyId: string) => Boolean(db.query("SELECT 1 FROM mcp_api_keys WHERE id = ? AND user_id = ?").get(keyId, userId));

export const binnedAuditQuery = db.query(`
  SELECT note_id, event_type, metadata_json, created_at FROM audit_log
  WHERE actor_id = $userId AND event_type IN (SELECT value FROM json_each($types))
    AND created_at >= $since AND json_extract(metadata_json, '$.keyId') = $keyId
  ORDER BY created_at DESC LIMIT $limit
`);

function itemId(type: BinnedType, noteId: string | null, metadata: Record<string, unknown>) {
  const value = type === "note" ? noteId : type === "card" ? metadata.cardId : type === "event" ? metadata.eventId : metadata.rowId;
  return typeof value === "string" ? value : null;
}

/** Every item the key binned in the window, newest first, marked with whether that binning is still in the caller's Bin. */
function keyBinnedEntries(userId: string, keyId: string, window: BinnedWindow, time: number) {
  const since = new Date(time - BINNED_WINDOWS[window]).toISOString();
  const rows = binnedAuditQuery.all({ userId, keyId, since, types: EVENT_TYPES, limit: BINNED_LIMIT }) as
    Array<{ note_id: string | null; event_type: keyof typeof BIN_EVENTS; metadata_json: string | null; created_at: string }>;
  const inBin = new Map(listBin(userId, null).map((item) => [`${item.type}:${item.id}`, item]));
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const row of rows) {
    const type = BIN_EVENTS[row.event_type];
    const id = itemId(type, row.note_id, row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : {});
    if (!id || seen.has(`${type}:${id}`)) continue;
    seen.add(`${type}:${id}`);
    const binned = inBin.get(`${type}:${id}`);
    const still = binned !== undefined && Math.abs(Date.parse(binned.deleted_at) - Date.parse(row.created_at)) <= SAME_BINNING_MS;
    entries.push({ type, id, title: still ? binned.title : "", binnedAt: row.created_at, restorable: still && !binned.purging, inBin: still });
  }
  return { entries, truncated: rows.length === BINNED_LIMIT };
}

/** The key's binned items still in the caller's Bin, newest first; null when the key is not theirs. */
export function listKeyBinned(userId: string, keyId: string, window: BinnedWindow, time = Date.now()) {
  if (!ownsKey(userId, keyId)) return null;
  const { entries, truncated } = keyBinnedEntries(userId, keyId, window, time);
  return { items: entries.filter((entry) => entry.inBin).map(({ inBin: _inBin, ...item }): BinnedItem => item), truncated };
}

/** How many items each of the caller's keys binned since `since` (the Settings key row line). */
export function binnedCountsByKey(userId: string, since: string) {
  const rows = db.query(`SELECT json_extract(metadata_json, '$.keyId') AS key_id, COUNT(*) AS count FROM audit_log
    WHERE actor_id = ? AND event_type IN (SELECT value FROM json_each(?)) AND created_at >= ? AND json_extract(metadata_json, '$.via') = 'mcp'
    GROUP BY key_id`).all(userId, EVENT_TYPES, since) as Array<{ key_id: string | null; count: number }>;
  return new Map(rows.filter((row) => row.key_id).map((row) => [row.key_id!, row.count]));
}

async function restoreOne(item: BinnedItem, userId: string) {
  if (item.type === "card") {
    const outcome = await restoreTaskItem("card", item.id, userId);
    return outcome.status === "restored" || outcome.status === "already_restored" ? null : outcome.status;
  }
  const outcome = await restoreItem(item.type, item.id, userId);
  return outcome.status === "restored" || outcome.status === "already_restored" || outcome.status === "calendar_restored" ? null : outcome.status;
}

/** Restores everything the key binned in the window through the normal services; items no longer in the Bin are skipped. */
export async function restoreKeyBinned(userId: string, keyId: string, window: BinnedWindow) {
  if (!ownsKey(userId, keyId)) return null;
  const { entries } = keyBinnedEntries(userId, keyId, window, Date.now());
  let restored = 0;
  const skipped: Array<{ type: BinnedType; id: string; reason: string }> = [];
  // Oldest first, so a parent binned before its child comes back first.
  for (const entry of [...entries].reverse()) {
    const reason = entry.inBin ? await restoreOne(entry, userId) : "not_in_bin";
    if (reason) skipped.push({ type: entry.type, id: entry.id, reason });
    else restored += 1;
  }
  audit(userId, null, "mcp.key_restore_binned", { keyId, window, restored, skipped: skipped.length });
  return { restored, skipped };
}
