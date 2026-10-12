import { db } from "../db";
import { openObjectForRead } from "../documentStorage";
import { storage } from "../storage";

/**
 * "Is this file still referenced somewhere?" for the orphan sweep (review M3). An Attachments-folder
 * file nothing links may still be referenced by content that has not derived links yet: a note draft
 * (links are derived only on publish, D408), an older published version a restore would bring back,
 * or a whiteboard scene or snapshot. The sweep never bins such a file.
 *
 * Built in here, so U4 and U4b need nothing for the sweep:
 * - notes: every draft and every stored published version, live or binned (through server/storage.ts);
 * - whiteboards: every current scene and snapshot object (through server/documentStorage.ts, so the
 *   S3 layer covers it).
 * Any reference counts, whoever wrote it (deliberately wider than "the owner's": keeping a file
 * costs only quota; binning a referenced one breaks a page).
 *
 * Further content kinds (Messages, say) register their own checker with
 * `registerAttachmentReferenceChecker`. Checks run only when the sweep has candidates (at most 100 a
 * run), and a file found referenced is not checked again for a day.
 */

/** Returns the subset of `candidates` (lower-case document ids) that `content` references. */
export type ReferenceChecker = (candidates: ReadonlySet<string>) => Promise<Set<string>>;

const checkers = new Map<string, ReferenceChecker>();

/** Registers (or replaces) a named checker; returns the unregister function. */
export function registerAttachmentReferenceChecker(name: string, checker: ReferenceChecker) {
  checkers.set(name, checker);
  return () => { if (checkers.get(name) === checker) checkers.delete(name); };
}

const found = (text: string, candidates: ReadonlySet<string>, into: Set<string>) => {
  const lower = text.toLowerCase();
  for (const id of candidates) if (!into.has(id) && lower.includes(id)) into.add(id);
};

/** Note drafts and every stored published version, of every note not being purged. */
export const noteReferences: ReferenceChecker = async (candidates) => {
  const hits = new Set<string>();
  const notes = db.query("SELECT id, draft_revision FROM notes").all() as Array<{ id: string; draft_revision: number | null }>;
  for (const note of notes) {
    if (hits.size === candidates.size) break;
    if (note.draft_revision !== null) {
      try { found(await storage.readDraft(note.id), candidates, hits); } catch { /* a missing draft file references nothing */ }
    }
    const versions = db.query("SELECT version_number FROM note_versions WHERE note_id = ?").all(note.id) as Array<{ version_number: number }>;
    for (const version of versions) {
      try { found(await storage.readVersion(note.id, version.version_number), candidates, hits); } catch { /* an unreadable version references nothing */ }
    }
  }
  return hits;
};

async function readObjectText(objectId: string, size: number) {
  return new TextDecoder().decode(await (await openObjectForRead(objectId, size)).bytes());
}

/** Whiteboard scenes (`nookDocumentId`) and snapshots. */
export const whiteboardReferences: ReferenceChecker = async (candidates) => {
  const hits = new Set<string>();
  const objects = db.query(`SELECT w.object_id, d.size_bytes FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE d.purge_started_at IS NULL
    UNION ALL SELECT s.object_id, s.size_bytes FROM whiteboard_snapshots s`).all() as Array<{ object_id: string; size_bytes: number }>;
  for (const object of objects) {
    if (hits.size === candidates.size) break;
    try { found(await readObjectText(object.object_id, object.size_bytes), candidates, hits); } catch { /* an unreadable object references nothing */ }
  }
  return hits;
};

registerAttachmentReferenceChecker("notes", noteReferences);
registerAttachmentReferenceChecker("whiteboards", whiteboardReferences);

/** Candidates found referenced recently: not checked again for a day (per process). */
const recentlyReferenced = new Map<string, number>();
export const REFERENCE_RECHECK_MS = 24 * 3_600_000;

/** Test hook: forget what was found referenced. */
export function resetReferenceCacheForTests() {
  recentlyReferenced.clear();
}

/** The subset of `documentIds` some registered content still references. A failing checker keeps everything (never bins on doubt). */
export async function referencedDocuments(documentIds: readonly string[], nowMs = Date.now()): Promise<Set<string>> {
  const referenced = new Set<string>();
  const pending = new Set<string>();
  for (const id of documentIds.map((value) => value.toLowerCase())) {
    const seen = recentlyReferenced.get(id);
    if (seen !== undefined && nowMs - seen < REFERENCE_RECHECK_MS) referenced.add(id);
    else pending.add(id);
  }
  if (!pending.size) return referenced;
  for (const checker of checkers.values()) {
    const open = new Set([...pending].filter((id) => !referenced.has(id)));
    if (!open.size) break;
    let hits: Set<string>;
    try {
      hits = await checker(open);
    } catch {
      for (const id of open) referenced.add(id);
      break;
    }
    for (const id of hits) {
      referenced.add(id);
      recentlyReferenced.set(id, nowMs);
    }
  }
  if (recentlyReferenced.size > 10_000) recentlyReferenced.clear();
  return referenced;
}
