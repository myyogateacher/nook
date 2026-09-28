import { audit, db, now, withProposalAuditContext } from "../db";
import { emitNotifications } from "../calendar/reminders";
import { consumeMcpLimits } from "../mcpRateLimit";
import { hasScope } from "../mcpScopes";
import { McpToolError, type McpErrorCode, type McpKeyContext } from "../mcpToolKit";
import { canWriteContent } from "../team/userRole";
import { DraftActionError, rejectAgentDraft, type RejectDraftOutcome } from "../noteDrafts";
import { isProposalKind, PROPOSAL_KIND_DEFS, type ProposalKind, type ProposalPreview, type ProposalRef, type StoredProposal } from "./kinds";
import { PROPOSAL_EXPIRE_MS, rejectEffectFor, type NoteDraftPayload, type ProposalBaseRow, type RejectEffect } from "./noteDraftProposals";
import { cleanLine, cleanText } from "./text";

/**
 * The proposal primitive (docs/plan/research/2026-09-28-agent-inbox-routines.md §4, D146–D159).
 *
 * An MCP key submits; only the key's owner reviews (D147). Approve runs the kind's MCP write tool
 * as the approver, inside `{via: "proposal", proposalId, keyId}` (D146): a proposal never applies
 * itself, and nothing here is reachable from MCP except submit, list-own, and withdraw. Statuses:
 * pending → applying → applied | failed {code}; pending → rejected | expired | superseded |
 * withdrawn. Every status other than pending (and the short-lived applying) is terminal.
 */

export const PENDING_CEILING = 500;
export const BULK_MAX = 50;
export const SUBMIT_BATCH_MAX = 20;
export const MAX_PAYLOAD_BYTES = 65_536;
export const TITLE_MAX = 120;
export const RATIONALE_MAX = 1000;
export const REJECT_REASON_MAX = 200;
export const COUNT_CAP = 100;
/** A proposal stuck in `applying` this long (a crash between claim and write) fails as INTERRUPTED (T129). */
export const APPLYING_TIMEOUT_MS = 10 * 60_000;
/** Resolved proposals are deleted this long after they resolve (D156); audit rows stay. */
export const RESOLVED_RETENTION_MS = 90 * 86_400_000;
/** Proposal bursts from one key coalesce into one unread notification for this long (D159). */
export const NOTIFY_COALESCE_MS = 15 * 60_000;

export type ProposalStatus = "pending" | "applying" | "applied" | "rejected" | "expired" | "failed" | "superseded" | "withdrawn";

export class InboxError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly code?: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "InboxError";
  }

  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...this.extra };
  }
}

type ProposalRow = {
  id: string; owner_id: string; key_id: string | null; key_name: string; routine_id: string | null; run_id: string | null;
  kind: ProposalKind; target_type: string; target_id: string; title: string; rationale: string | null; payload: string;
  status: ProposalStatus; result_code: string | null; result_ref: string | null; reject_reason: string | null;
  reviewed_by: string | null; created_at: string; expires_at: string; resolved_at: string | null; claimed_at: string | null;
} & ProposalBaseRow;

const stored = (row: ProposalRow): StoredProposal => ({ kind: row.kind, payload: JSON.parse(row.payload) as Record<string, unknown>, key_id: row.key_id, key_name: row.key_name, target_id: row.target_id });
const parseRef = (value: string | null): ProposalRef | null => {
  if (!value) return null;
  try { return JSON.parse(value) as ProposalRef; } catch { return null; }
};

// --- Submit (MCP) -------------------------------------------------------------

export type SubmitItem = { kind: string; title: string; rationale?: string; payload: unknown };
export type SubmitOutcome = { proposalId: string; status: "pending"; expiresAt: string } | { error: string; code: McpErrorCode; details?: unknown };

const pendingCount = db.query("SELECT COUNT(*) AS count FROM (SELECT 1 FROM proposals WHERE owner_id = ? AND status = 'pending' LIMIT ?)");

/**
 * Submits one proposal for the key's owner. Checks, in order: the kind's module scope (D151), the
 * 500 pending ceiling (D155), the daily `proposal_write` buckets, the title, and then the kind's
 * own payload validation and target read check (NOT_FOUND, the same as missing; T126).
 */
export async function submitProposal(key: McpKeyContext, item: SubmitItem, timestamp = new Date()): Promise<{ proposalId: string; status: "pending"; expiresAt: string }> {
  if (!isProposalKind(item.kind)) throw new McpToolError("INVALID", "Unknown proposal kind");
  const kind = PROPOSAL_KIND_DEFS[item.kind];
  if (!hasScope(key.scopes, kind.scope)) throw new McpToolError("SCOPE_REQUIRED", `This API key needs the ${kind.scope} scope to suggest ${item.kind} changes`);
  if (!canWriteContent(key.userId)) throw new McpToolError("READ_ONLY", "Your team role is read-only");
  if ((pendingCount.get(key.userId, PENDING_CEILING) as { count: number }).count >= PENDING_CEILING) {
    throw new McpToolError("LIMIT_REACHED", `The inbox already holds ${PENDING_CEILING} pending proposals. Ask the user to review them first.`);
  }
  const retryAfter = consumeMcpLimits({ keyId: key.keyId, userId: key.userId }, ["proposal_write"], timestamp.getTime());
  if (retryAfter) throw new McpToolError("RATE_LIMITED", "Too many proposals from this key today. Try again later.", { retryAfterSeconds: retryAfter });
  const title = cleanLine(item.title ?? "");
  if (!title || title.length > TITLE_MAX) throw new McpToolError("INVALID", `title must be 1 to ${TITLE_MAX} characters`);
  const rationale = item.rationale === undefined ? null : cleanText(item.rationale) || null;
  if (rationale && rationale.length > RATIONALE_MAX) throw new McpToolError("INVALID", `rationale must be at most ${RATIONALE_MAX} characters`);
  if (Buffer.byteLength(JSON.stringify(item.payload ?? null), "utf8") > MAX_PAYLOAD_BYTES) throw new McpToolError("TOO_LARGE", "A proposal payload is limited to 64 KiB of JSON");

  const result = await kind.submit(key, item.payload);
  const payload = JSON.stringify(result.payload);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) throw new McpToolError("TOO_LARGE", "A proposal payload is limited to 64 KiB of JSON");
  const createdAt = timestamp.toISOString();
  const expiresAt = new Date(timestamp.getTime() + PROPOSAL_EXPIRE_MS).toISOString();
  if (result.proposalId) {
    // A note draft recorded its own proposal row when it was written (D149); give it the agent's words.
    db.query("UPDATE proposals SET title = ?, rationale = ? WHERE id = ? AND owner_id = ?").run(title, rationale, result.proposalId, key.userId);
    audit(key.userId, null, "proposal.submitted", { keyId: key.keyId, kind: item.kind, runId: null, proposalId: result.proposalId });
    const row = db.query("SELECT expires_at FROM proposals WHERE id = ?").get(result.proposalId) as { expires_at: string };
    return { proposalId: result.proposalId, status: "pending", expiresAt: row.expires_at };
  }
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, rationale, payload, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, key.userId, key.keyId, key.name.slice(0, 120) || "MCP key", item.kind, result.targetType, result.targetId, title, rationale, payload, createdAt, expiresAt);
    audit(key.userId, null, "proposal.submitted", { keyId: key.keyId, kind: item.kind, runId: null, proposalId: id });
  })();
  return { proposalId: id, status: "pending", expiresAt };
}

/** Up to 20 items, validated and inserted one at a time with per-item results; one notification for the batch. */
export async function submitProposals(key: McpKeyContext, items: readonly SubmitItem[]) {
  const results: SubmitOutcome[] = [];
  for (const item of items) {
    try {
      results.push(await submitProposal(key, item));
    } catch (error) {
      if (error instanceof McpToolError) results.push({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      else {
        console.error("Proposal submit failed", error instanceof Error ? error.name : "Unknown error");
        results.push({ error: "Something went wrong", code: "INTERNAL" });
      }
    }
  }
  const created = results.filter((result) => "proposalId" in result).length;
  if (created) notifyProposals(key.userId, key.keyId, created);
  return { results, submitted: created };
}

/** This key's own proposals, newest first (T131): never another key's, and no payload echo. */
export function listKeyProposals(key: McpKeyContext, options: { status?: ProposalStatus; limit?: number } = {}) {
  const rows = db.query(`SELECT id, kind, title, status, result_code, reject_reason, created_at, expires_at, resolved_at FROM proposals
      WHERE key_id = $keyId AND owner_id = $userId AND ($status IS NULL OR status = $status) ORDER BY created_at DESC, rowid DESC LIMIT $limit`)
    .all({ keyId: key.keyId, userId: key.userId, status: options.status ?? null, limit: options.limit ?? 20 }) as Array<Record<string, string | null>>;
  return {
    proposals: rows.map((row) => ({
      id: row.id, kind: row.kind, title: row.title, status: row.status, resultCode: row.result_code, rejectReason: row.reject_reason,
      createdAt: row.created_at, expiresAt: row.expires_at, resolvedAt: row.resolved_at
    }))
  };
}

/** The key's own pending proposal becomes `withdrawn`. A note draft stays in the note (D156). */
export function withdrawProposal(key: McpKeyContext, proposalId: string) {
  const result = db.query("UPDATE proposals SET status = 'withdrawn', resolved_at = ? WHERE id = ? AND key_id = ? AND owner_id = ? AND status = 'pending'")
    .run(now(), proposalId.toLowerCase(), key.keyId, key.userId);
  if (result.changes !== 1) {
    const exists = db.query("SELECT status FROM proposals WHERE id = ? AND key_id = ? AND owner_id = ?").get(proposalId.toLowerCase(), key.keyId, key.userId) as { status: string } | null;
    if (!exists) throw new McpToolError("NOT_FOUND", "Proposal not found");
    throw new McpToolError("INVALID", `This proposal is already ${exists.status}`, { status: exists.status });
  }
  audit(key.userId, null, "proposal.withdrawn", { keyId: key.keyId, proposalId: proposalId.toLowerCase() });
  return { proposalId: proposalId.toLowerCase(), status: "withdrawn" as const };
}

// --- Notifications (D159) -----------------------------------------------------

/**
 * One unread `proposals` notification per key per 15 minutes: a new burst adds to its count. Its
 * title is built at read time from the key's name and the count, never from agent text (T127,
 * T135). Push goes through the usual payload-less path, only for users who opted in (O5).
 */
export function notifyProposals(ownerId: string, keyId: string, count: number, nowMs = Date.now()) {
  const timestamp = new Date(nowMs).toISOString();
  const created = db.transaction(() => {
    const open = db.query(`SELECT id FROM notifications WHERE user_id = ? AND kind = 'proposals' AND proposal_key_id = ? AND run_id IS NULL
        AND read_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1`).get(ownerId, keyId, new Date(nowMs - NOTIFY_COALESCE_MS).toISOString()) as { id: string } | null;
    if (open) {
      db.query("UPDATE notifications SET proposal_count = COALESCE(proposal_count, 0) + ? WHERE id = ?").run(count, open.id);
      return null;
    }
    const id = crypto.randomUUID();
    db.query("INSERT INTO notifications (id, user_id, kind, proposal_key_id, proposal_count, created_at) VALUES (?, ?, 'proposals', ?, ?, ?)").run(id, ownerId, keyId, count, timestamp);
    return id;
  })();
  if (created && proposalPushEnabled(ownerId)) emitNotifications([{ id: created, userId: ownerId }]);
  return created;
}

export function proposalPushEnabled(userId: string) {
  return (db.query("SELECT proposal_push FROM user_preferences WHERE user_id = ?").get(userId) as { proposal_push: number } | null)?.proposal_push === 1;
}

export function setProposalPush(userId: string, enabled: boolean) {
  const timestamp = now();
  db.transaction(() => {
    db.query("INSERT OR IGNORE INTO user_preferences (user_id, disabled_modules, revision, updated_at) VALUES (?, '[]', 1, ?)").run(userId, timestamp);
    db.query("UPDATE user_preferences SET proposal_push = ? WHERE user_id = ?").run(enabled ? 1 : 0, userId);
    audit(userId, null, "inbox.push_setting", { enabled });
  })();
  return { push: enabled };
}

// --- Reading (owner only, D147) ----------------------------------------------

export type ProposalSummary = {
  id: string; kind: ProposalKind; kindLabel: string; title: string; rationale: string | null; status: ProposalStatus;
  targetLabel: string; restricted: boolean; targetHref: string | null; digest: string; keyName: string;
  createdAt: string; expiresAt: string; resolvedAt: string | null; resultCode: string | null; rejectReason: string | null; ref: ProposalRef | null;
  /** A pending note_draft only: what rejecting it would do to the note now (review H1). */
  rejectEffect?: RejectEffect;
};

const noteState = db.query("SELECT draft_revision, current_version, deleted_at FROM notes WHERE id = ? AND owner_id = ?");

/** What rejecting this pending note_draft would do now, for the reject dialog's copy. */
function noteDraftRejectEffect(row: ProposalRow, viewerId: string): RejectEffect {
  const note = noteState.get(row.target_id, viewerId) as { draft_revision: number | null; current_version: number; deleted_at: string | null } | null;
  return rejectEffectFor(note, (stored(row).payload as unknown as NoteDraftPayload).revision, row, canWriteContent(viewerId));
}

function summary(row: ProposalRow, viewerId: string): ProposalSummary {
  const kind = PROPOSAL_KIND_DEFS[row.kind];
  const proposal = stored(row);
  let label: string | null = null;
  try { label = kind.targetLabel(viewerId, proposal); } catch { label = null; }
  return {
    id: row.id, kind: row.kind, kindLabel: kind.label, title: row.title, rationale: row.rationale, status: row.status,
    targetLabel: label ?? "restricted", restricted: label === null, targetHref: label === null ? null : kind.targetHref(proposal), digest: kind.digest(proposal.payload), keyName: row.key_name,
    createdAt: row.created_at, expiresAt: row.expires_at, resolvedAt: row.resolved_at, resultCode: row.result_code, rejectReason: row.reject_reason,
    ref: parseRef(row.result_ref),
    ...(row.kind === "note_draft" && row.status === "pending" ? { rejectEffect: noteDraftRejectEffect(row, viewerId) } : {})
  };
}

function ownedProposal(ownerId: string, proposalId: string) {
  const row = db.query("SELECT * FROM proposals WHERE id = ? AND owner_id = ?").get(proposalId.toLowerCase(), ownerId) as ProposalRow | null;
  if (!row) throw new InboxError(404, "Proposal not found");
  return row;
}

/** Rows tie on timestamps within one submit batch; rowid (insertion order) is submission order. */
type Cursor = { at: string; seq: number };
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (typeof parsed.at === "string" && Number.isSafeInteger(parsed.seq)) return parsed;
  } catch { /* fall through */ }
  throw new InboxError(400, "Invalid cursor", "INVALID_CURSOR");
}

export type ProposalGroup = {
  routine: { id: string; name: string } | null;
  run: { id: string; startedAt: string; summary: string | null; status: string; capped: boolean } | null;
  key: { name: string } | null;
  items: ProposalSummary[];
};

/**
 * The inbox: pending proposals (or resolved ones, newest resolved first), one page of at most 50,
 * grouped by run, else by key (Wave 21 has no runs yet). Groups are ordered by their newest item;
 * items inside a group are in submission order, for top-to-bottom review.
 */
export function listInbox(ownerId: string, options: { status: "pending" | "resolved"; group: "run" | "none"; cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
  const cursor = decodeCursor(options.cursor);
  const pending = options.status === "pending";
  const order = pending ? "created_at" : "resolved_at";
  const rows = db.query(`SELECT *, rowid AS seq FROM proposals WHERE owner_id = $ownerId
      AND ${pending ? "status = 'pending'" : "status NOT IN ('pending', 'applying')"}
      AND ($at IS NULL OR ${order} < $at OR (${order} = $at AND rowid < $seq))
      ORDER BY ${order} DESC, rowid DESC LIMIT $limit`)
    .all({ ownerId, at: cursor?.at ?? null, seq: cursor?.seq ?? 0, limit: limit + 1 }) as Array<ProposalRow & { seq: number }>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ at: (pending ? last.created_at : last.resolved_at) ?? last.created_at, seq: last.seq }) : null;
  const groups: ProposalGroup[] = [];
  const byKey = new Map<string, ProposalGroup>();
  for (const row of page) {
    const groupKey = options.group === "none" ? "all" : row.run_id ? `run:${row.run_id}` : `key:${row.key_id ?? row.key_name}`;
    let group = byKey.get(groupKey);
    if (!group) {
      group = { routine: null, run: null, key: options.group === "none" ? null : { name: row.key_name }, items: [] };
      byKey.set(groupKey, group);
      groups.push(group);
    }
    group.items.push(summary(row, ownerId));
  }
  if (pending) for (const group of groups) group.items.reverse();
  return { groups, nextCursor };
}

/** One proposal with its preview, resolved for the viewer now (never stored, §4.2). */
export async function getProposal(ownerId: string, proposalId: string) {
  const row = ownedProposal(ownerId, proposalId);
  let preview: ProposalPreview;
  try {
    preview = await PROPOSAL_KIND_DEFS[row.kind].preview(ownerId, stored(row));
  } catch (error) {
    if (!(error instanceof McpToolError)) console.error("Proposal preview failed", error instanceof Error ? error.name : "Unknown error");
    preview = { restricted: true };
  }
  const position = row.status === "pending" ? pendingPosition(ownerId, row) : null;
  return { proposal: { ...summary(row, ownerId), preview, ...(position ? { position } : {}) } };
}

/** "2 of 4" within the proposal's group (same run, else same key), in submission order. */
function pendingPosition(ownerId: string, row: ProposalRow) {
  const siblings = db.query(`SELECT id FROM proposals WHERE owner_id = ? AND status = 'pending' AND ${row.run_id ? "run_id = ?" : "run_id IS NULL AND key_id IS ?"}
      ORDER BY created_at, rowid LIMIT 500`).all(ownerId, row.run_id ?? row.key_id) as Array<{ id: string }>;
  const index = siblings.findIndex((item) => item.id === row.id);
  return index < 0 ? null : { index: index + 1, of: siblings.length, nextId: siblings[index + 1]?.id ?? siblings[index - 1]?.id ?? null };
}

/** The account-row badge (T51): bounded like the Bin badge, never a full COUNT. */
export function countPending(ownerId: string) {
  return { pending: (pendingCount.get(ownerId, COUNT_CAP) as { count: number }).count };
}

// --- Approve and reject (web only, D146) --------------------------------------

export type ApproveOutcome = { id: string; status: "applied"; ref: ProposalRef } | { id: string; status: "failed"; code: string; error: string };

const locks = new Map<string, Promise<unknown>>();
/** Serializes approve and reject of one proposal in this process (a double click, two tabs; T129). */
async function withProposalLock<T>(proposalId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(proposalId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  locks.set(proposalId, current);
  try {
    return await current;
  } finally {
    if (locks.get(proposalId) === current) locks.delete(proposalId);
  }
}

const revokedKey = db.query("SELECT 1 FROM mcp_api_keys WHERE id = ? AND revoked_at IS NOT NULL");
const keyRevoked = (keyId: string) => revokedKey.get(keyId) !== null;

const notPending = (row: Pick<ProposalRow, "status">) => new InboxError(409, `This proposal is already ${row.status}`, "NOT_PENDING", { status: row.status });

/**
 * Applies a pending proposal as `approverId` (its owner). The row is claimed `pending → applying`
 * first, so a second approve gets NOT_PENDING; the kind's write tool then runs through the module's
 * service with the proposal's provenance. A refusal (a moved revision, a lost ACL, a full column, a
 * binned target) makes it `failed` with the code and nothing applied (D148). An unexpected error
 * releases the claim; a crash leaves `applying`, which the sweeper fails as INTERRUPTED.
 */
export async function approveProposal(approverId: string, proposalId: string): Promise<ApproveOutcome> {
  const id = proposalId.toLowerCase();
  return withProposalLock(id, async () => {
    const row = ownedProposal(approverId, id);
    if (!canWriteContent(approverId)) throw new InboxError(403, "Your team role is read-only", "ROLE_READ_ONLY");
    if (row.status !== "pending") throw notPending(row);
    const timestamp = now();
    if (row.key_id && keyRevoked(row.key_id)) {
      // Revoking a key supersedes its pending proposals; this catches any left pending (M1).
      db.query("UPDATE proposals SET status = 'superseded', result_code = 'KEY_REVOKED', resolved_at = ?, base_draft_markdown = NULL WHERE id = ? AND status = 'pending'").run(timestamp, id);
      throw new InboxError(409, "The key that suggested this change was revoked", "KEY_REVOKED", { status: "superseded" });
    }
    const claimed =db.query("UPDATE proposals SET status = 'applying', claimed_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'").run(timestamp, id, approverId);
    if (claimed.changes !== 1) throw notPending(ownedProposal(approverId, id));
    const kind = PROPOSAL_KIND_DEFS[row.kind];
    try {
      const ref = await withProposalAuditContext({ via: "proposal", proposalId: id, keyId: row.key_id }, () => kind.apply(approverId, stored(row)));
      db.transaction(() => {
        db.query("UPDATE proposals SET status = 'applied', result_ref = ?, result_code = NULL, reviewed_by = ?, resolved_at = ? WHERE id = ? AND status = 'applying'")
          .run(JSON.stringify(ref), approverId, now(), id);
        audit(approverId, null, "proposal.applied", { proposalId: id, kind: row.kind, keyId: row.key_id });
      })();
      return { id, status: "applied", ref };
    } catch (error) {
      if (error instanceof McpToolError) {
        db.transaction(() => {
          db.query("UPDATE proposals SET status = 'failed', result_code = ?, reviewed_by = ?, resolved_at = ? WHERE id = ? AND status = 'applying'")
            .run(error.code, approverId, now(), id);
          audit(approverId, null, "proposal.failed", { proposalId: id, kind: row.kind, keyId: row.key_id, code: error.code });
        })();
        return { id, status: "failed", code: error.code, error: error.message };
      }
      db.query("UPDATE proposals SET status = 'pending', claimed_at = NULL WHERE id = ? AND status = 'applying'").run(id);
      throw error;
    }
  });
}

/**
 * Rejects a pending proposal with the owner's optional reason (kept for the agent, §4.3). Viewers
 * keep reject (allowlisted, D152). A note_draft undoes the agent's write only while the draft is
 * still the proposed revision and the owner may still write (T130, review H1): the draft from
 * before the agent's write is restored (`draft: "restored"`), or a published note that had none
 * drops the agent's draft (`"discarded"`). Otherwise the draft stays (`"kept"`): a never-published
 * note is never binned by a reject, and a draft someone edited since is left alone.
 */
export async function rejectProposal(userId: string, proposalId: string, reason?: string) {
  const id = proposalId.toLowerCase();
  const cleanReason = reason === undefined ? null : cleanLine(reason).slice(0, REJECT_REASON_MAX) || null;
  return withProposalLock(id, async () => {
    const row = ownedProposal(userId, id);
    if (row.status !== "pending") throw notPending(row);
    const result = db.query("UPDATE proposals SET status = 'rejected', reject_reason = ?, reviewed_by = ?, resolved_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'")
      .run(cleanReason, userId, now(), id, userId);
    if (result.changes !== 1) throw notPending(ownedProposal(userId, id));
    audit(userId, null, "proposal.rejected", { proposalId: id, kind: row.kind, keyId: row.key_id });
    let draft: RejectDraftOutcome = "kept";
    if (row.kind === "note_draft" && canWriteContent(userId)) {
      const { noteId, revision } = stored(row).payload as unknown as NoteDraftPayload;
      try {
        draft = await rejectAgentDraft(userId, noteId, { proposalId: id, revision, base: row });
      } catch (error) {
        if (!(error instanceof DraftActionError)) throw error;
      }
    }
    if (row.base_draft_markdown !== null) db.query("UPDATE proposals SET base_draft_markdown = NULL WHERE id = ?").run(id);
    return { id, status: "rejected" as const, ...(row.kind === "note_draft" ? { draft, draftDiscarded: draft === "discarded" } : {}) };
  });
}

export type BulkResult = { id: string; status: string; code?: string; ref?: ProposalRef; error?: string };

/**
 * Bulk approve or reject, up to 50 of the owner's proposals, applied one at a time in submission
 * order with per-item results (§4.3); never all-or-nothing.
 */
export async function bulkProposals(userId: string, input: { action: "approve" | "reject"; ids: string[]; reason?: string }) {
  if (input.action === "approve" && !canWriteContent(userId)) throw new InboxError(403, "Your team role is read-only", "ROLE_READ_ONLY");
  const unique = [...new Set(input.ids.map((id) => id.toLowerCase()))];
  const rows = db.query("SELECT id, created_at FROM proposals WHERE owner_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid")
    .all(userId, JSON.stringify(unique)) as Array<{ id: string }>;
  const known = new Set(rows.map((row) => row.id));
  const results: BulkResult[] = unique.filter((id) => !known.has(id)).map((id) => ({ id, status: "not_found", code: "NOT_FOUND" }));
  for (const { id } of rows) {
    try {
      if (input.action === "approve") {
        const outcome = await approveProposal(userId, id);
        results.push(outcome.status === "applied" ? { id, status: "applied", ref: outcome.ref } : { id, status: "failed", code: outcome.code, error: outcome.error });
      } else {
        await rejectProposal(userId, id, input.reason);
        results.push({ id, status: "rejected" });
      }
    } catch (error) {
      if (error instanceof InboxError) results.push({ id, status: (error.extra.status as string | undefined) ?? "error", code: error.code ?? "ERROR", error: error.message });
      else {
        console.error("Bulk proposal action failed", error instanceof Error ? error.name : "Unknown error");
        results.push({ id, status: "error", code: "INTERNAL", error: "Something went wrong" });
      }
    }
  }
  const order = new Map(unique.map((id, index) => [id, index]));
  return { results: input.action === "approve" ? results : results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) };
}

// --- Sweeper (D156) -----------------------------------------------------------

/**
 * Hourly: pending proposals past `expires_at` expire (their targets are untouched: an expired
 * note_draft keeps its draft and badge); `applying` claims older than 10 minutes fail as
 * INTERRUPTED; resolved proposals are deleted 90 days after they resolved. Audits counts only.
 */
export function sweepProposals(nowMs = Date.now()) {
  const timestamp = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const expiring = db.query("SELECT owner_id, COUNT(*) AS count FROM proposals WHERE status = 'pending' AND expires_at <= ? GROUP BY owner_id").all(timestamp) as Array<{ owner_id: string; count: number }>;
    const expired = db.query("UPDATE proposals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?").run(timestamp, timestamp).changes;
    for (const { owner_id: ownerId, count } of expiring) audit(ownerId, null, "proposal.expired", { count });
    const interrupted = db.query("UPDATE proposals SET status = 'failed', result_code = 'INTERRUPTED', resolved_at = ? WHERE status = 'applying' AND claimed_at <= ?")
      .run(timestamp, new Date(nowMs - APPLYING_TIMEOUT_MS).toISOString()).changes;
    const purged = db.query("DELETE FROM proposals WHERE status NOT IN ('pending', 'applying') AND resolved_at <= ?").run(new Date(nowMs - RESOLVED_RETENTION_MS).toISOString()).changes;
    // A resolved note_draft no longer needs the draft text it could have restored (H1).
    db.query("UPDATE proposals SET base_draft_markdown = NULL WHERE status NOT IN ('pending', 'applying') AND base_draft_markdown IS NOT NULL").run();
    return { expired, interrupted, purged };
  })();
}
