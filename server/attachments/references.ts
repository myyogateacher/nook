import { db, now } from "../db";
import { openObjectForRead } from "../documentStorage";
import { checksum, storage } from "../storage";

/**
 * "Is this file still referenced somewhere?" for the orphan sweep (review M3). An Attachments-folder
 * file nothing links may still be referenced by content that has not derived links yet: a note draft
 * (links are derived only on publish, D408), an older published version a restore would bring back,
 * or a whiteboard scene or snapshot. The sweep never bins such a file.
 *
 * **The reference index** (migration 048, v0.35.0 review L2). Each stored piece of content is
 * immutable under its source key (`draft:<noteId>:<checksum>`, `version:<noteId>:<n>`,
 * `object:<objectId>`), so the UUIDs it contains are recorded once:
 * - writers record their own content as they commit (`recordDraftReferences`, `recordVersionReferences`,
 *   `recordObjectReferences`: draft saves, publishes, board saves);
 * - the sweep, only when it has candidates, lists the sources that exist now (database rows only),
 *   reads just the ones the index has not seen (content from before 048, or a writer that did not
 *   record), and drops sources that are gone. A steady-state run reads no content at all, so no S3
 *   GET either.
 * Any reference counts, whoever wrote it (deliberately wider than "the owner's": keeping a file costs
 * only quota; binning a referenced one breaks a page). The sweep re-checks the index inside the bin
 * transaction (`isReferencedNow`), so a draft saved after the scan still keeps its file.
 *
 * Further content kinds (Messages, say) register their own checker with
 * `registerAttachmentReferenceChecker`; those run after the index, only on the remaining candidates.
 */

/** Returns the subset of `candidates` (lower-case document ids) that `content` references. */
export type ReferenceChecker = (candidates: ReadonlySet<string>) => Promise<Set<string>>;

const checkers = new Map<string, ReferenceChecker>();

/** Registers (or replaces) a named checker; returns the unregister function. */
export function registerAttachmentReferenceChecker(name: string, checker: ReferenceChecker) {
  checkers.set(name, checker);
  return () => { if (checkers.get(name) === checker) checkers.delete(name); };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Every distinct UUID in `text`, lower-case (any mention counts, as the substring check before 048 did). */
export function uuidsIn(text: string) {
  return new Set(text.toLowerCase().match(UUID) ?? []);
}

const draftSource = (noteId: string, draftChecksum: string) => `draft:${noteId}:${draftChecksum}`;
const versionSource = (noteId: string, version: number) => `version:${noteId}:${version}`;
const objectSource = (objectId: string) => `object:${objectId}`;

/** Records one source's references (idempotent). Runs inside the caller's transaction when there is one. */
function record(source: string, text: string) {
  db.transaction(() => {
    if (db.query("INSERT OR IGNORE INTO content_reference_sources (source, scanned_at) VALUES (?, ?)").run(source, now()).changes !== 1) return;
    const insert = db.query("INSERT OR IGNORE INTO content_references (source, document_id) VALUES (?, ?)");
    for (const id of uuidsIn(text)) insert.run(source, id);
  })();
}

export const recordDraftReferences = (noteId: string, draftChecksum: string, markdown: string) => record(draftSource(noteId, draftChecksum), markdown);
export const recordVersionReferences = (noteId: string, version: number, markdown: string) => record(versionSource(noteId, version), markdown);
export const recordObjectReferences = (objectId: string, bytes: Uint8Array) => record(objectSource(objectId), new TextDecoder().decode(bytes));

/** `checksum`: the content's recorded sha256, when it has one; a mismatch (a write in flight) is a doubt, never recorded. */
type Source = { source: string; read: () => Promise<string>; checksum?: string };

/** The content that exists now, from database rows only (no content is read here). */
function currentSources(): Source[] {
  const sources: Source[] = [];
  const drafts = db.query("SELECT id, draft_checksum FROM notes WHERE draft_revision IS NOT NULL AND draft_checksum IS NOT NULL").all() as Array<{ id: string; draft_checksum: string }>;
  for (const note of drafts) sources.push({ source: draftSource(note.id, note.draft_checksum), read: () => storage.readDraft(note.id), checksum: note.draft_checksum });
  const versions = db.query("SELECT note_id, version_number, checksum FROM note_versions").all() as Array<{ note_id: string; version_number: number; checksum: string }>;
  for (const version of versions) {
    sources.push({ source: versionSource(version.note_id, version.version_number), read: () => storage.readVersion(version.note_id, version.version_number), checksum: version.checksum });
  }
  const objects = db.query(`SELECT w.object_id, d.size_bytes FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE d.purge_started_at IS NULL
    UNION ALL SELECT s.object_id, s.size_bytes FROM whiteboard_snapshots s`).all() as Array<{ object_id: string; size_bytes: number }>;
  for (const object of objects) {
    sources.push({ source: objectSource(object.object_id), read: async () => new TextDecoder().decode(await (await openObjectForRead(object.object_id, object.size_bytes)).bytes()) });
  }
  return sources;
}

/** Content that is simply not there (a draft file removed, an object gone) references nothing; anything else is a doubt. */
const isMissing = (error: unknown) => {
  const failure = error as { code?: unknown; reason?: unknown } | null;
  return failure?.code === "ENOENT" || failure?.reason === "missing";
};

/** What the last refresh did (tests and the L2 measurement). */
export const referenceIndexStats = { sourcesRead: 0, sourcesDropped: 0, sourcesKnown: 0 };

/**
 * Brings the index up to date: scans sources it has not seen, drops sources that no longer exist.
 * Returns the ids found in content that could not be recorded this run (a draft being written).
 * Throws when some content could not be read (the sweep then keeps every candidate).
 */
export async function refreshReferenceIndex() {
  const sources = currentSources();
  const known = new Set((db.query("SELECT source FROM content_reference_sources").all() as Array<{ source: string }>).map((row) => row.source));
  const unrecorded = new Set<string>();
  let read = 0;
  let doubt: unknown = null;
  for (const item of sources) {
    if (known.has(item.source)) continue;
    let text = "";
    try {
      text = await item.read();
      // A write in flight (or a damaged file): its ids count for this run, but nothing is recorded.
      if (item.checksum !== undefined && checksum(text) !== item.checksum) { for (const id of uuidsIn(text)) unrecorded.add(id); continue; }
    } catch (error) {
      if (!isMissing(error)) { doubt = error; continue; }
    }
    read += 1;
    record(item.source, text);
  }
  const current = new Set(sources.map((item) => item.source));
  const stale = [...known].filter((source) => !current.has(source));
  const dropReferences = db.query("DELETE FROM content_references WHERE source = ?");
  const dropSource = db.query("DELETE FROM content_reference_sources WHERE source = ?");
  db.transaction(() => { for (const source of stale) { dropReferences.run(source); dropSource.run(source); } })();
  Object.assign(referenceIndexStats, { sourcesRead: read, sourcesDropped: stale.length, sourcesKnown: current.size });
  if (doubt) throw doubt;
  return unrecorded;
}

/** Whether the index records any reference to the document now (call inside the bin transaction). */
export const isReferencedNow = (documentId: string) =>
  Boolean(db.query("SELECT 1 FROM content_references WHERE document_id = ? LIMIT 1").get(documentId.toLowerCase()));

/** Test hook: empty the index, so the next sweep scans every source again. */
export function resetReferenceCacheForTests() {
  db.exec("DELETE FROM content_references; DELETE FROM content_reference_sources;");
}

/** The subset of `documentIds` some stored content still references. A failing read or checker keeps everything (never bins on doubt). */
export async function referencedDocuments(documentIds: readonly string[]): Promise<Set<string>> {
  const candidates = [...new Set(documentIds.map((value) => value.toLowerCase()))];
  if (!candidates.length) return new Set();
  let unrecorded: Set<string>;
  try {
    unrecorded = await refreshReferenceIndex();
  } catch {
    return new Set(candidates);
  }
  const referenced = new Set((db.query("SELECT DISTINCT document_id FROM content_references WHERE document_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(candidates)) as Array<{ document_id: string }>).map((row) => row.document_id));
  for (const id of candidates) if (unrecorded.has(id)) referenced.add(id);
  for (const id of await registeredReferences(candidates.filter((value) => !referenced.has(value)))) referenced.add(id);
  return referenced;
}

/** The subset of `documentIds` the registered extra checkers find referenced; a failing checker keeps everything left. */
export async function registeredReferences(documentIds: readonly string[]): Promise<Set<string>> {
  const candidates = documentIds.map((value) => value.toLowerCase());
  const referenced = new Set<string>();
  for (const checker of checkers.values()) {
    const open = new Set(candidates.filter((id) => !referenced.has(id)));
    if (!open.size) break;
    let hits: Set<string>;
    try {
      hits = await checker(open);
    } catch {
      for (const id of open) referenced.add(id);
      break;
    }
    for (const id of hits) referenced.add(id);
  }
  return referenced;
}
