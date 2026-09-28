/**
 * The per-key seen-revision ledger (docs/plan/WAVES_18-20_SMALL.md D173, T143). In memory: a
 * restart forgets it, and the agent then reads the draft again before publishing.
 *
 * Whenever create_note, get_note_draft, or update_note_draft returns a draft revision to a key, the
 * ledger records `(noteId, revision, draft checksum)` for that key. publish_note_draft succeeds only
 * for a revision this key was shown, so an agent cannot publish a draft it never read (revisions are
 * small integers and easy to guess) or one a person changed after it read it.
 */

export const SEEN_DRAFTS_PER_KEY = 500;
export const SEEN_DRAFT_TTL_MS = 3_600_000;

type Seen = { revision: number; checksum: string; at: number };
const ledger = new Map<string, Map<string, Seen>>();

function sweep(time: number) {
  for (const [keyId, notes] of ledger) {
    for (const [noteId, seen] of notes) if (time - seen.at > SEEN_DRAFT_TTL_MS) notes.delete(noteId);
    if (notes.size === 0) ledger.delete(keyId);
  }
}

/** Records that `keyId` was shown `revision` of the draft of `noteId`, whose checksum is `checksum`. */
export function rememberSeenDraft(keyId: string, noteId: string, revision: number, checksum: string, time = Date.now()) {
  if (ledger.size > 1000) sweep(time);
  let notes = ledger.get(keyId);
  if (!notes) {
    notes = new Map();
    ledger.set(keyId, notes);
  }
  // Re-inserting moves the note to the newest end, so the oldest entry is evicted first (LRU).
  notes.delete(noteId);
  notes.set(noteId, { revision, checksum, at: time });
  while (notes.size > SEEN_DRAFTS_PER_KEY) notes.delete(notes.keys().next().value!);
}

/** What `keyId` was last shown of the draft of `noteId`, or null (never, expired, or forgotten). */
export function seenDraft(keyId: string, noteId: string, time = Date.now()) {
  const seen = ledger.get(keyId)?.get(noteId);
  if (!seen) return null;
  if (time - seen.at > SEEN_DRAFT_TTL_MS) {
    ledger.get(keyId)!.delete(noteId);
    return null;
  }
  return { revision: seen.revision, checksum: seen.checksum };
}

export function forgetSeenDraft(keyId: string, noteId: string) {
  ledger.get(keyId)?.delete(noteId);
}

/** Test hook: what a restart does. */
export function resetSeenDrafts() {
  ledger.clear();
}
