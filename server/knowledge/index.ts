import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { checksum, storage } from "../storage";
import { DocumentIntegrityError, openObjectForRead } from "../documentStorage";
import { StorageUnavailableError } from "../objectStore";
import { CHUNKING, KNOWLEDGE_BOUNDS } from "../../shared/knowledge";
import { assertBudget, chargeUsage, secondsToMidnight } from "../agents/runs";
import { connectionFor, embeddingDefaults, knowledgePolicyOf, parseKnowledgePolicy } from "../agents/providers";
import { DEFAULT_KNOWLEDGE_POLICY, policyAllowsModel, policyMaxDims } from "../../shared/agents";
import { ProviderError } from "../agents/loop";
import { AgentError, agentsStatus } from "../agents/status";
import { chunkText, type Chunk, type ChunkFormat } from "./chunk";
import { embedTexts, takesDimensions, vectorToBlob } from "./embed";
import { canReadDocument, canReadNote, canReadSource, documentFormat, isKnowledgeFile, kbProvider, ownerIsActive, PROVIDER_REMOVED, refreshKbCounts, refreshKbStatus, type KbRow, type SourceRow } from "./service";
import { onGroupMembershipChanged, onKnowledgeProviderEvent, onNotePublished, onSourceAccessChanged, onUserUnblocked, type ProviderEvent, type SourceAccessChange } from "./hooks";
import { lastReindexAt, recordReindex, resetReindexLimitsForTests } from "./limits";

/**
 * The index pipeline (plan §9, D368, D369; Wave 44 "AC-E"): a background queue that never blocks a
 * request. A source is `pending` until the worker takes it (`indexing`), then `ready`, `error`, or
 * `unavailable`; those states live in SQLite, so the queue resumes after a restart (sources left
 * `indexing` go back to `pending` at boot).
 *
 * - **Round robin** (Wave 44 fixes, L3): the worker takes at most `knowledgeQueue.passSources`
 *   sources of one base per pass, then moves on to the next base, so one large base never starves
 *   the others.
 * - **Read as the owner** at index time: a note's current published version, a Files text document
 *   (checked against its stored SHA-256), or the pasted text. A note or file the owner can no longer
 *   read becomes `unavailable` and its chunks are removed (T320); the access hooks (M1) do that at
 *   once when a note or file is unshared, moved to the Bin, or purged.
 * - **A blocked owner** (M2) reads nothing: their bases are skipped by the worker and the sweep, and
 *   search skips them; an unblock queues them again.
 * - **The provider is pinned** (M3): the base's own provider, never the default. When it was removed,
 *   every source gets `PROVIDER_REMOVED` and nothing is sent. The content hash includes the
 *   provider's id and address, so pointing the provider somewhere else re-embeds every source.
 * - **Content hash:** `sha256(chunker version | provider id | provider URL | model | dimensions |
 *   format | the content's own checksum)`. A source whose hash is unchanged is not embedded again.
 * - **Budgets:** embedding tokens count toward the base owner's daily token budget (and the
 *   instance's), checked before every request; over budget, every waiting source of the base shows
 *   the pause (`pending` with the reason, QA LOW-3) and nothing is sent. The queue wakes at midnight
 *   UTC, or at once when an admin raises a budget. Usage is charged under the agent id `kb:<id>`.
 * - **Failures:** a provider or egress error marks the source `error` (the message is the redacted
 *   one) and keeps any chunks it had; Re-index or the next change tries again.
 * - **Triggers:** adding a source; publishing a note that is a source (debounced 60 s); the hourly
 *   sweep (`sweepKnowledge`); Re-index all (at most once an hour per base, L1, kept in SQLite since
 *   2026-10-08 so a restart does not forget it); Change embedding model (2026-10-08, the same hour).
 * - **Change embedding model** (2026-10-08, owner only): one transaction records the new provider,
 *   model, and size, marks every source `pending`, and replaces every chunk with a copy without its
 *   vector (chunks are never updated in place), so keyword search keeps working and no vector of the
 *   old model survives. Until every waiting source is embedded again search is keyword-only
 *   (`kbChangingModel`). A batch in flight for the old model is dropped before its next request and
 *   its result is never written.
 */

/** Timers and bounds, on an object so tests can shorten them. */
export const knowledgeTimers = { publishDebounceMs: 60_000, reindexCooldownMs: 3_600_000 };
/** Per pass of the worker, the sources of one base it indexes before moving on (L3); the sweep yields after each batch. */
export const knowledgeQueue = { passSources: 20, sweepBatch: 50 };

const queue = new Set<string>();
let worker: Promise<void> | null = null;
let idleWaiters: Array<() => void> = [];

/** Queues a base for the worker (no-op while the module is off: its sources stay pending). */
export function scheduleKnowledge(kbId: string) {
  if (!agentsStatus().enabled) return;
  queue.add(kbId);
  worker ??= (async () => {
    try {
      while (queue.size > 0) {
        const next = queue.values().next().value as string;
        queue.delete(next);
        try {
          // More left: back to the end of the queue (round robin, L3).
          if (await indexBase(next)) queue.add(next);
        } catch (error) {
          console.error("Knowledge indexing failed", error instanceof Error ? error.name : "Unknown error");
        }
      }
    } finally {
      worker = null;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  })();
}

/** Resolves once the queue is empty (tests, and the smoke). */
export function whenKnowledgeIdle(): Promise<void> {
  if (!worker && queue.size === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

const liveKb = (id: string) => db.query("SELECT * FROM knowledge_bases WHERE id = ? AND deleted_at IS NULL").get(id) as KbRow | null;

/** The live bases with sources waiting whose owners are active (the worker's work list). */
const basesWithWork = () => (db.query(`SELECT DISTINCT s.kb_id FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL
  JOIN users u ON u.id = k.owner_id AND u.disabled_at IS NULL WHERE s.status = 'pending'`).all() as Array<{ kb_id: string }>).map((row) => row.kb_id);

/** One pass over a base: at most `passSources` sources. True when it has more waiting (it goes back in the queue). */
async function indexBase(kbId: string): Promise<boolean> {
  const skipped = new Set<string>();
  let done = 0;
  let more = false;
  for (;;) {
    const kb = liveKb(kbId);
    if (!kb) return false;
    // M2: a blocked owner's base waits, untouched, until the unblock queues it again.
    if (!ownerIsActive(kb.owner_id)) return false;
    const rows = (db.query("SELECT * FROM kb_sources WHERE kb_id = ? AND status = 'pending' ORDER BY COALESCE(created_at, ''), rowid LIMIT 50").all(kbId) as SourceRow[]).filter((row) => !skipped.has(row.id));
    const source = rows[0];
    if (!source) break;
    if (done >= knowledgeQueue.passSources) {
      more = true;
      break;
    }
    const outcome = await indexSource(kb, source);
    done += 1;
    if (outcome === "paused") {
      pauseBase(kbId, pauseMessage);
      refreshKbStatus(kbId);
      return false;
    }
    if (outcome === "requeued") skipped.add(source.id);
  }
  refreshKbStatus(kbId);
  // A source marked again while it was embedded (a new publish) runs in the next pass.
  return more || skipped.size > 0;
}

const pauseMessage = "Paused: the daily token budget is used up; indexing resumes after midnight UTC";

/** Over budget (QA LOW-3): every waiting source of the base says why, and the queue wakes at midnight UTC. */
function pauseBase(kbId: string, message: string) {
  db.query("UPDATE kb_sources SET error = ? WHERE kb_id = ? AND status = 'pending'").run(message, kbId);
  scheduleBudgetWake();
}

let budgetWake: ReturnType<typeof setTimeout> | null = null;

/** One timer to just after midnight UTC, when the daily budgets reset; then every base with waiting sources is queued. */
function scheduleBudgetWake() {
  if (budgetWake) return;
  budgetWake = setTimeout(() => {
    budgetWake = null;
    try {
      wakeKnowledge();
    } catch (error) {
      console.error("Knowledge wake-up failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, secondsToMidnight() * 1000 + 5_000);
  budgetWake.unref?.();
}

/** Queues every live base with waiting sources (midnight UTC, a raised budget, an unblock). */
export function wakeKnowledge() {
  const bases = basesWithWork();
  for (const kbId of bases) scheduleKnowledge(kbId);
  return bases.length;
}

/** Test hook: whether the midnight wake-up is set. */
export const budgetWakeScheduled = () => budgetWake !== null;

/** What a source's text is, as the owner reads it now; null when the owner cannot read it. */
type Content = { text: string; format: ChunkFormat; fingerprint: string; title: string; bytes: number };

class SourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** The cheap half: whether the owner can read it and the content's own checksum, from SQLite alone (the sweep uses this). */
export function sourceFingerprint(ownerId: string, source: Pick<SourceRow, "kind" | "ref_id" | "text">): { fingerprint: string; format: ChunkFormat; title: string | null } | null {
  if (source.kind === "text") return { fingerprint: checksum(source.text ?? ""), format: "markdown", title: null };
  if (!source.ref_id) return null;
  if (source.kind === "note") {
    if (!canReadNote(ownerId, source.ref_id)) return null;
    const row = db.query("SELECT v.checksum, v.title FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version WHERE n.id = ?").get(source.ref_id) as { checksum: string; title: string } | null;
    return row ? { fingerprint: row.checksum, format: "markdown", title: row.title || "Untitled" } : null;
  }
  if (!canReadDocument(ownerId, source.ref_id)) return null;
  const row = db.query("SELECT sha256, mime_type, name FROM documents WHERE id = ?").get(source.ref_id) as { sha256: string; mime_type: string; name: string } | null;
  if (!row) return null;
  return { fingerprint: row.sha256, format: documentFormat(row.mime_type, row.name), title: row.name };
}

/** The content hash (M3: the provider's id and address are part of it, so a provider pointed elsewhere re-embeds). */
export const contentHash = (kb: Pick<KbRow, "provider_id" | "embedding_model" | "dims">, providerUrl: string | null, format: ChunkFormat, fingerprint: string) =>
  createHash("sha256").update(`v${CHUNKING.version}|${kb.provider_id ?? ""}|${providerUrl ?? ""}|${kb.embedding_model}|${kb.dims}|${format}|${fingerprint}`).digest("hex");

/** The whole content, read as the owner (null: the owner cannot read it now). */
async function readContent(kb: KbRow, source: SourceRow): Promise<Content | null> {
  const seen = sourceFingerprint(kb.owner_id, source);
  if (!seen) return null;
  if (source.kind === "text") {
    const text = source.text ?? "";
    return { text, format: "markdown", fingerprint: seen.fingerprint, title: source.title, bytes: Buffer.byteLength(text, "utf8") };
  }
  if (source.kind === "note") {
    const row = db.query("SELECT n.current_version, v.checksum, v.title FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version WHERE n.id = ?").get(source.ref_id!) as { current_version: number; checksum: string; title: string };
    const markdown = await storage.readVersion(source.ref_id!, row.current_version);
    if (checksum(markdown) !== row.checksum) throw new SourceError("INTEGRITY", "The note's stored text failed its integrity check");
    return { text: markdown, format: "markdown", fingerprint: row.checksum, title: row.title || "Untitled", bytes: Buffer.byteLength(markdown, "utf8") };
  }
  const document = db.query("SELECT id, name, mime_type, size_bytes, sha256 FROM documents WHERE id = ?").get(source.ref_id!) as { id: string; name: string; mime_type: string; size_bytes: number; sha256: string };
  if (!isKnowledgeFile(document.mime_type, document.name)) throw new SourceError("UNSUPPORTED_TYPE", "Only text (.txt), Markdown (.md), and CSV (.csv) files can be knowledge sources");
  if (document.size_bytes > KNOWLEDGE_BOUNDS.documentBytes) throw new SourceError("TOO_LARGE", "The file is larger than 1 MiB");
  let bytes: Uint8Array;
  try {
    bytes = await (await openObjectForRead(document.id, document.size_bytes)).bytes();
  } catch (error) {
    if (error instanceof DocumentIntegrityError) throw new SourceError("INTEGRITY", "The file's stored content failed its integrity check");
    if (error instanceof StorageUnavailableError) throw new SourceError("STORAGE_UNAVAILABLE", "File storage was unavailable; re-index this source later");
    throw error;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== document.sha256) throw new SourceError("INTEGRITY", "The file's stored content failed its integrity check");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SourceError("NOT_TEXT", "The file is not valid UTF-8 text"); }
  return { text, format: documentFormat(document.mime_type, document.name), fingerprint: document.sha256, title: document.name, bytes: document.size_bytes };
}

/** The input a chunk is embedded as: its heading path, then its text (the heading helps a short answer match its topic). */
export const embeddingInput = (chunk: Chunk) => chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text;

const setState = (sourceId: string, status: string, error: string | null, from: string = "indexing") =>
  db.query("UPDATE kb_sources SET status = ?, error = ? WHERE id = ? AND status = ?").run(status, error, sourceId, from).changes > 0;

/** One source: read, hash, chunk, embed, and swap its chunks in one transaction. */
async function indexSource(kb: KbRow, source: SourceRow): Promise<"done" | "paused" | "requeued"> {
  if (!db.query("UPDATE kb_sources SET status = 'indexing' WHERE id = ? AND status = 'pending'").run(source.id).changes) return "requeued";
  let content: Content | null;
  try {
    content = await readContent(kb, source);
  } catch (error) {
    const message = error instanceof SourceError ? error.message : "The source could not be read";
    if (!(error instanceof SourceError)) console.error("Knowledge source could not be read", error instanceof Error ? error.name : "Unknown error");
    setState(source.id, "error", message);
    return "done";
  }
  if (!content) {
    markUnavailable(kb.id, source.id);
    return "done";
  }
  // M3: the base's own provider or nothing (never the current default).
  const provider = kbProvider(kb);
  if (!provider) {
    setState(source.id, "error", PROVIDER_REMOVED);
    return "done";
  }
  const hash = contentHash(kb, provider.base_url, content.format, content.fingerprint);
  if (hash === source.content_hash && source.indexed_at !== null) {
    // Unchanged: nothing is embedded again (the sweep and the publish hook mark sources freely).
    db.query("UPDATE kb_sources SET status = 'ready', error = NULL, title = ? WHERE id = ? AND status = 'indexing'").run(content.title.slice(0, 255), source.id);
    return "done";
  }
  const chunks = chunkText(content.text, content.format);
  const others = (db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND source_id <> ?").get(kb.id, source.id) as { count: number }).count;
  if (others + chunks.length > KNOWLEDGE_BOUNDS.chunks) {
    setState(source.id, "error", `This source would take the knowledge base past ${KNOWLEDGE_BOUNDS.chunks.toLocaleString("en-US")} chunks`);
    return "done";
  }
  let vectors: Float32Array[] = [];
  let tokens = 0;
  let dims = kb.dims;
  // 2026-10-08: a model that takes no `dimensions` answers in its own size; a base with no vectors yet
  // (new, or just moved to another model) adopts it. Vectors of another size are never stored beside them.
  const vectored = vectoredChunks(kb.id, source.id);
  if (chunks.length > 0) {
    try {
      const connection = connectionFor(provider.id, null);
      const requested = takesDimensions(kb.embedding_model) || vectored > 0 ? kb.dims : null;
      const result = await embedTexts(connection, kb.embedding_model, requested, chunks.map(embeddingInput), {
        // Before every request (T314): over the owner's or the instance's budget nothing is sent.
        // 2026-10-08: nor when the base moved to another model meanwhile (no call to the old provider after a change).
        beforeBatch: () => { if (modelChanged(kb)) throw new SourceError("MODEL_CHANGED", "The embedding model changed"); assertBudget(kb.owner_id); },
        afterBatch: (used, batch) => {
          chargeUsage(kb.owner_id, `kb:${kb.id}`, { promptTokens: used, completionTokens: 0, estimated: false }, 0);
          // 2026-10-08: a model that answers in its own size larger than the admin's limit for this
          // provider is stopped at its first answer (no further batch). A size the base already has
          // (grandfathered, made before the limit) is not refused.
          const native = batch[0]?.length ?? 0;
          if (requested === null && native !== kb.dims) {
            const cap = policyMaxDims(knowledgePolicyOf(provider.id) ?? DEFAULT_KNOWLEDGE_POLICY);
            if (native > cap) throw new SourceError("DIMS_TOO_LARGE", nativeTooLarge(kb.embedding_model, native, cap));
          }
        }
      });
      vectors = result.vectors;
      tokens = result.tokens;
      dims = vectors[0]?.length ?? dims;
      if (dims < 64 || dims > 3072) throw new ProviderError("PROVIDER_ERROR", `The model returned ${dims} dimensions; 64 to 3072 are supported`);
    } catch (error) {
      // The base moved to another model: the change already marked this source pending again.
      if (error instanceof SourceError && error.code === "MODEL_CHANGED") return "requeued";
      // Every waiting source of the base would get the same answer: all go to error at once, with no further call.
      if (error instanceof SourceError && error.code === "DIMS_TOO_LARGE") {
        setState(source.id, "error", error.message);
        db.query("UPDATE kb_sources SET status = 'error', error = ? WHERE kb_id = ? AND status = 'pending'").run(error.message, kb.id);
        return "done";
      }
      if (error instanceof AgentError && error.code === "BUDGET_EXCEEDED") {
        setState(source.id, "pending", pauseMessage);
        return "paused";
      }
      const message = error instanceof ProviderError || error instanceof AgentError ? error.message : "The embeddings could not be made";
      if (!(error instanceof ProviderError) && !(error instanceof AgentError)) console.error("Knowledge embedding failed", error instanceof Error ? error.name : "Unknown error");
      setState(source.id, "error", message.slice(0, 200));
      return "done";
    }
  }
  const stored = db.transaction(() => {
    // The base may have been binned, the source removed, or marked again (a new publish) while the
    // provider answered: then nothing is written and the queue takes it again.
    const live = liveKb(kb.id);
    if (!live || modelChanged(kb, live)) return false;
    // Never two sizes in one base: a model that answered in another size than the vectors already stored is an error.
    if (dims !== kb.dims && vectoredChunks(kb.id, source.id) > 0) {
      setState(source.id, "error", `The model returned ${dims} dimensions; this knowledge base's vectors have ${kb.dims}`);
      return false;
    }
    const finished = db.query("UPDATE kb_sources SET status = 'ready', error = NULL, content_hash = ?, indexed_at = ?, chunk_count = ?, title = ?, bytes = ? WHERE id = ? AND status = 'indexing'")
      .run(hash, now(), chunks.length, content.title.slice(0, 255), content.bytes, source.id).changes;
    if (!finished) return false;
    if (dims !== kb.dims) db.query("UPDATE knowledge_bases SET dims = ? WHERE id = ?").run(dims, kb.id);
    db.query("DELETE FROM kb_chunks WHERE source_id = ?").run(source.id);
    const insert = db.query("INSERT INTO kb_chunks (kb_id, source_id, ord, heading, text, embedding) VALUES (?, ?, ?, ?, ?, ?)");
    chunks.forEach((chunk, ord) => insert.run(kb.id, source.id, ord, chunk.heading, chunk.text, vectorToBlob(vectors[ord]!)));
    refreshKbCounts(kb.id);
    return true;
  })();
  if (stored) audit(kb.owner_id, null, "knowledge.source.indexed", { kbId: kb.id, sourceId: source.id, chunks: chunks.length, tokens });
  return stored ? "done" : "requeued";
}

/** The owner can no longer read the source (T320): its chunks go, and it says so. A purged note or file also loses its title. */
function markUnavailable(kbId: string, sourceId: string, purgedTitle?: string) {
  db.transaction(() => {
    db.query("UPDATE kb_sources SET status = 'unavailable', error = NULL, content_hash = NULL, chunk_count = 0, title = COALESCE(?, title) WHERE id = ?").run(purgedTitle ?? null, sourceId);
    const removed = db.query("DELETE FROM kb_chunks WHERE source_id = ?").run(sourceId).changes;
    if (removed) refreshKbCounts(kbId);
    else refreshKbStatus(kbId);
  })();
}

// ------------------------------------------------------------------------------ Re-index all (L1: once an hour)

/**
 * L1, kept in SQLite since 2026-10-08 (`agent_rate_limits`, bucket `kb_reindex:<id>`): Re-index all
 * and Change embedding model share one hour per base, for everyone (owner included), across restarts.
 */
function assertReindexAllowed(kb: Pick<KbRow, "id">, at: number) {
  const last = lastReindexAt(kb.id);
  if (last !== null && at - last < knowledgeTimers.reindexCooldownMs && at >= last) {
    const retryAfterSeconds = Math.max(1, Math.ceil((last + knowledgeTimers.reindexCooldownMs - at) / 1000));
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    throw new AgentError(429, "REINDEX_RATE_LIMITED", `This knowledge base was re-indexed or changed model less than an hour ago. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, { retryAfterSeconds });
  }
}

/** Re-index all (manage): every source is embedded again, whatever its hash. At most once an hour per base, for everyone (owner included). */
export function reindexAll(actor: { userId: string }, kb: KbRow) {
  const at = Date.now();
  assertReindexAllowed(kb, at);
  recordReindex(kb.id, at);
  const changed = db.query("UPDATE kb_sources SET status = 'pending', error = NULL, content_hash = NULL WHERE kb_id = ? AND status <> 'indexing'").run(kb.id).changes;
  // A source being embedded right now finishes, then runs again with the hash cleared.
  db.query("UPDATE kb_sources SET content_hash = NULL WHERE kb_id = ? AND status = 'indexing'").run(kb.id);
  refreshKbStatus(kb.id);
  audit(actor.userId, null, "knowledge.reindex", { kbId: kb.id, sources: changed, ...(kb.owner_id !== actor.userId ? { asManager: true } : {}) });
  scheduleKnowledge(kb.id);
  return { ok: true as const, sources: changed };
}

// ------------------------------------------------------------------------------ Change embedding model (2026-10-08)

/** Chunks of the base, other than `exceptSource`'s, that carry a vector. */
const vectoredChunks = (kbId: string, exceptSource: string) =>
  (db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND source_id <> ? AND length(embedding) > 0").get(kbId, exceptSource) as { count: number }).count;

/** Whether the base's provider or model changed since `kb` was read (its in-flight work is then dropped). */
function modelChanged(kb: Pick<KbRow, "id" | "provider_id" | "embedding_model" | "dims">, live: Pick<KbRow, "provider_id" | "embedding_model" | "dims"> | null = liveKb(kb.id)) {
  return !live || live.provider_id !== kb.provider_id || live.embedding_model !== kb.embedding_model || live.dims !== kb.dims;
}

export type ModelChangeInput = { providerId: string; model: string; dims?: number | null };

/** A source's error when a model's own size is over the admin's limit (2026-10-08). */
export const nativeTooLarge = (model: string, dims: number, cap: number) =>
  `${model} answers in ${dims.toLocaleString("en-US")} dimensions; an admin allows at most ${cap.toLocaleString("en-US")} with this provider. Choose another model with Change embedding model.`;

/**
 * Change embedding model (owner only; the way out of "provider removed" too). Every source is
 * embedded again at the owner's token cost, under the usual budget and pause rules, and search is
 * keyword-only until that finishes. One transaction: the new provider, model, and size; every
 * source but the unavailable ones `pending` (errors included, so a removed provider's base
 * recovers); every chunk replaced by a copy without its vector. Counts as the hour's Re-index (the
 * same bucket), except when the base's provider was removed: that base has nothing to protect and
 * must not wait an hour to recover.
 */
export function changeEmbeddingModel(actor: { userId: string }, kb: KbRow, input: ModelChangeInput) {
  const provider = db.query("SELECT id, embedding_model, embedding_dims, compat_json FROM agent_providers WHERE id = ?").get(input.providerId.toLowerCase()) as { id: string; embedding_model: string | null; embedding_dims: number | null; compat_json: string } | null;
  if (!provider) throw new AgentError(400, "INVALID", "That provider was not found", { field: "providerId" });
  const model = input.model.trim();
  // 2026-10-08: the admin's knowledge policy for the chosen provider (Settings → AI → Model providers).
  const policy = parseKnowledgePolicy(provider.compat_json);
  if (!policy.enabled) throw new AgentError(400, "PROVIDER_NOT_ALLOWED", "An admin does not allow this provider for knowledge bases", { field: "providerId" });
  if (!policyAllowsModel(policy, model)) throw new AgentError(400, "MODEL_NOT_ALLOWED", `An admin allows only these embedding models with this provider: ${policy.models!.join(", ")}`, { field: "model", allowed: policy.models });
  const cap = policyMaxDims(policy);
  if (input.dims != null && input.dims > cap) throw new AgentError(400, "DIMS_TOO_LARGE", `An admin allows at most ${cap.toLocaleString("en-US")} dimensions with this provider`, { field: "dims", maxDims: cap });
  const dims = takesDimensions(model)
    ? input.dims ?? embeddingDefaults(provider, policy).dims
    // A model that takes no `dimensions` answers in its own size; the base adopts it at the first answer
    // (a size over the limit then puts the sources in error). The stored size stays within the limit.
    : Math.min(input.dims ?? kb.dims, cap);
  if (provider.id === kb.provider_id && model === kb.embedding_model && dims === kb.dims) throw new AgentError(409, "UNCHANGED", "The knowledge base already uses this provider, model, and size");
  const at = Date.now();
  const providerRemoved = kbProvider(kb) === null;
  if (!providerRemoved) assertReindexAllowed(kb, at);
  const result = db.transaction(() => {
    const live = liveKb(kb.id);
    if (!live || modelChanged(kb, live)) throw new AgentError(409, "KB_CHANGED", "This knowledge base changed meanwhile; reload and try again");
    db.query("UPDATE knowledge_bases SET provider_id = ?, embedding_model = ?, dims = ?, updated_at = ? WHERE id = ?").run(provider.id, model, dims, now(), kb.id);
    const sources = db.query("UPDATE kb_sources SET status = 'pending', error = NULL, content_hash = NULL WHERE kb_id = ? AND status <> 'unavailable'").run(kb.id).changes;
    // Chunks are replaced, never updated (042's trigger): copies without a vector keep keyword search, then the originals go.
    const last = (db.query("SELECT COALESCE(MAX(id), 0) AS id FROM kb_chunks").get() as { id: number }).id;
    db.query(`INSERT INTO kb_chunks (kb_id, source_id, ord, heading, text, embedding) SELECT kb_id, source_id, ord, heading, text, X'' FROM kb_chunks WHERE kb_id = ? AND id <= ? ORDER BY id`).run(kb.id, last);
    // Counted first: `.changes` of the DELETE would include the FTS trigger's writes.
    const dropped = (db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND id <= ?").get(kb.id, last) as { count: number }).count;
    db.query("DELETE FROM kb_chunks WHERE kb_id = ? AND id <= ?").run(kb.id, last);
    refreshKbCounts(kb.id);
    recordReindex(kb.id, at);
    audit(actor.userId, null, "knowledge.model_change", { kbId: kb.id, providerId: provider.id, model, dims, sources, vectorsDropped: dropped, ...(providerRemoved ? { providerWasRemoved: true } : {}) });
    return { ok: true as const, sources };
  })();

  scheduleKnowledge(kb.id);
  return result;
}

// ------------------------------------------------------------------------------ the publish hook

const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** A note that is a source was published: after 60 s of quiet, its sources are checked again. */
export function notePublished(noteId: string) {
  if (!db.query("SELECT 1 FROM kb_sources WHERE kind = 'note' AND ref_id = ? LIMIT 1").get(noteId)) return;
  clearTimeout(publishTimers.get(noteId));
  const timer = setTimeout(() => {
    publishTimers.delete(noteId);
    try {
      markNoteSourcesPending(noteId);
    } catch (error) {
      console.error("Knowledge publish hook failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, knowledgeTimers.publishDebounceMs);
  timer.unref?.();
  publishTimers.set(noteId, timer);
}
onNotePublished(notePublished);

function markNoteSourcesPending(noteId: string) {
  const rows = db.query(`SELECT s.id, s.kb_id, s.status FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL WHERE s.kind = 'note' AND s.ref_id = ?`).all(noteId) as Array<{ id: string; kb_id: string; status: string }>;
  for (const row of rows) {
    // A source being embedded right now is marked too: its result is then dropped and it runs again.
    db.query("UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = ?").run(row.id);
    refreshKbStatus(row.kb_id);
    scheduleKnowledge(row.kb_id);
  }
}

// ------------------------------------------------------------------------------ access hooks (M1)

type RecheckRow = SourceRow & { owner_id: string; kb_deleted: string | null };

/**
 * Who can read some notes or files changed (their sharing, the Bin, a restore, or a purge): each
 * source over them, in every base (binned ones too, so a purge leaves no text anywhere), is checked
 * against what its base's owner can read now. Unreadable: `unavailable`, chunks removed at once.
 * Readable again: `pending`. A purge also replaces the source's title. Bases of a blocked owner are
 * left as they are (M2), except for a purge.
 */
export function recheckKnowledgeSources(change: SourceAccessChange, owners?: ReadonlySet<string>) {
  const ids = JSON.stringify(change.ids.map((id) => id.toLowerCase()));
  const select = "SELECT s.*, k.owner_id, k.deleted_at AS kb_deleted FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id";
  const rows = change.kind === "folder"
    ? db.query(`${select} WHERE (s.kind = 'note' AND s.ref_id IN (SELECT id FROM notes WHERE folder_id IN (SELECT value FROM json_each($ids))))
        OR (s.kind = 'document' AND s.ref_id IN (SELECT id FROM documents WHERE folder_id IN (SELECT value FROM json_each($ids))))`).all({ ids }) as RecheckRow[]
    : db.query(`${select} WHERE s.kind = $kind AND s.ref_id IN (SELECT value FROM json_each($ids))`).all({ kind: change.kind, ids }) as RecheckRow[];
  const purged = change.kind !== "folder" && change.purged === true;
  let unavailable = 0;
  const queued = new Set<string>();
  for (const row of rows) {
    if (owners && !owners.has(row.owner_id)) continue;
    if (purged) {
      markUnavailable(row.kb_id, row.id, row.kind === "note" ? "Deleted note" : "Deleted file");
      unavailable += 1;
      continue;
    }
    if (!ownerIsActive(row.owner_id)) continue;
    const readable = canReadSource(row.owner_id, row.kind, row.ref_id);
    if (!readable && row.status !== "unavailable") {
      markUnavailable(row.kb_id, row.id);
      unavailable += 1;
    } else if (readable && row.status === "unavailable") {
      db.query("UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = ? AND status = 'unavailable'").run(row.id);
      refreshKbStatus(row.kb_id);
      if (row.kb_deleted === null) queued.add(row.kb_id);
    }
  }
  for (const kbId of queued) scheduleKnowledge(kbId);
  return { unavailable, pending: queued.size };
}
onSourceAccessChanged((change) => { recheckKnowledgeSources(change); });

/**
 * 2026-10-08: people joined or left a group (or it was deleted). Every note and file source of the
 * bases they own is checked against what they can read now, at once: unreadable → `unavailable`
 * (chunks removed), readable again → `pending`. Bases of blocked owners are left alone (M2).
 */
export function recheckOwnersSources(ownerIds: readonly string[]) {
  if (ownerIds.length === 0) return { unavailable: 0, pending: 0 };
  const rows = db.query(`SELECT s.kind, s.ref_id FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id
    WHERE k.owner_id IN (SELECT value FROM json_each(?)) AND s.kind IN ('note','document')`).all(JSON.stringify(ownerIds)) as Array<{ kind: "note" | "document"; ref_id: string }>;
  let unavailable = 0;
  let pending = 0;
  for (const kind of ["note", "document"] as const) {
    const ids = [...new Set(rows.filter((row) => row.kind === kind).map((row) => row.ref_id))];
    if (!ids.length) continue;
    const outcome = recheckKnowledgeSources({ kind, ids }, new Set(ownerIds));
    unavailable += outcome.unavailable;
    pending += outcome.pending;
  }
  return { unavailable, pending };
}
onGroupMembershipChanged((userIds) => { recheckOwnersSources(userIds); });

/** Search found hits from sources their owner can no longer read (M1): marked later, never in the search's way. */
export function recheckLater(stale: ReadonlyArray<{ kind: "note" | "document"; refId: string }>) {
  if (stale.length === 0) return;
  const timer = setTimeout(() => {
    try {
      for (const kind of ["note", "document"] as const) {
        const ids = [...new Set(stale.filter((item) => item.kind === kind).map((item) => item.refId))];
        if (ids.length) recheckKnowledgeSources({ kind, ids });
      }
    } catch (error) {
      console.error("Knowledge recheck failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, 0);
  timer.unref?.();
}

// M2: an unblocked owner's bases resume.
onUserUnblocked((userId) => {
  const bases = db.query(`SELECT DISTINCT s.kb_id FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL WHERE k.owner_id = ? AND s.status = 'pending'`).all(userId) as Array<{ kb_id: string }>;
  for (const { kb_id } of bases) scheduleKnowledge(kb_id);
});

/**
 * M3 and LOW-3: a provider removed fails its bases closed (every source not `unavailable` gets the
 * error; chunks stay for keyword search); a provider pointed at another address re-embeds its bases
 * (the hash includes the address); a raised budget wakes the queue.
 */
export function onProviderEvent(event: ProviderEvent) {
  if (event.kind === "budget") {
    wakeKnowledge();
    return;
  }
  if (event.kind === "removed") {
    const bases = db.query("SELECT id FROM knowledge_bases k WHERE NOT EXISTS (SELECT 1 FROM agent_providers p WHERE p.id = k.provider_id)").all() as Array<{ id: string }>;
    for (const { id } of bases) {
      db.query("UPDATE kb_sources SET status = 'error', error = ? WHERE kb_id = ? AND status IN ('pending','indexing','ready')").run(PROVIDER_REMOVED, id);
      refreshKbStatus(id);
    }
    return;
  }
  const bases = db.query("SELECT id FROM knowledge_bases WHERE provider_id = ? AND deleted_at IS NULL").all(event.providerId) as Array<{ id: string }>;
  for (const { id } of bases) {
    db.query("UPDATE kb_sources SET status = 'pending', error = NULL WHERE kb_id = ? AND status <> 'unavailable'").run(id);
    refreshKbStatus(id);
    scheduleKnowledge(id);
  }
}
onKnowledgeProviderEvent(onProviderEvent);

// ------------------------------------------------------------------------------ boot and the sweep

/** Boot: sources a previous process left `indexing` go back to `pending`, and every base with work is queued. */
export function resumeKnowledgeIndexing(log: (line: string) => void = (line) => console.log(line)) {
  const reset = db.query("UPDATE kb_sources SET status = 'pending' WHERE status = 'indexing'").run().changes;
  const bases = wakeKnowledge();
  if (reset || bases) log(`Knowledge: ${bases} ${bases === 1 ? "base has" : "bases have"} sources waiting to be indexed${reset ? ` (${reset} interrupted)` : ""}.`);
  return { reset, bases };
}

const yieldToRequests = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/**
 * The hourly check (plan §9): every note and file source of a live base whose owner is active (M2)
 * is compared, from SQLite alone, against what the owner can read now. Unreadable → `unavailable`
 * (chunks removed; `pending` sources too, M1); a changed checksum (or one that came back) →
 * `pending`; a base whose provider was removed → `error` (M3); then every base with pending work is
 * queued. A source in `error` is only checked for readability: it runs again on Re-index all, on a
 * publish of its note, or when it is removed and added again, never every hour on its own. The
 * sweep yields to requests after every `sweepBatch` sources (L3).
 */
export async function sweepKnowledge() {
  const rows = db.query(`SELECT s.*, k.owner_id, k.provider_id, k.embedding_model, k.dims, p.base_url AS provider_url FROM kb_sources s
      JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL JOIN users u ON u.id = k.owner_id AND u.disabled_at IS NULL
      LEFT JOIN agent_providers p ON p.id = k.provider_id
    WHERE s.status IN ('pending','ready','error','unavailable') AND s.kind IN ('note','document') ORDER BY s.rowid`).all() as Array<SourceRow & { owner_id: string; provider_id: string | null; embedding_model: string; dims: number; provider_url: string | null }>;
  let unavailable = 0;
  let changed = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && index % knowledgeQueue.sweepBatch === 0) await yieldToRequests();
    // The row may have moved meanwhile (a hook, the worker): act only on its current state.
    const current = db.query("SELECT status FROM kb_sources WHERE id = ?").get(row.id) as { status: string } | null;
    if (!current || current.status !== row.status) continue;
    const seen = sourceFingerprint(row.owner_id, row);
    if (!seen) {
      if (row.status !== "unavailable") {
        markUnavailable(row.kb_id, row.id);
        unavailable += 1;
      }
      continue;
    }
    if (row.status === "pending") continue;
    if (row.provider_url === null) {
      if (row.status !== "error" && row.status !== "unavailable" && setState(row.id, "error", PROVIDER_REMOVED, row.status)) refreshKbStatus(row.kb_id);
      continue;
    }
    if (contentHash(row, row.provider_url, seen.format, seen.fingerprint) !== row.content_hash && row.status !== "error") {
      if (db.query("UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = ? AND status = ?").run(row.id, row.status).changes) changed += 1;
    }
  }
  const bases = basesWithWork();
  for (const kbId of bases) {
    refreshKbStatus(kbId);
    scheduleKnowledge(kbId);
  }
  return { unavailable, changed, queued: bases.length };
}

/** Test hook: forget pending publish timers, Re-index all's hour, and the midnight wake-up. */
export function resetKnowledgeTimersForTests() {
  for (const timer of publishTimers.values()) clearTimeout(timer);
  publishTimers.clear();
  resetReindexLimitsForTests();
  if (budgetWake) clearTimeout(budgetWake);
  budgetWake = null;
}
