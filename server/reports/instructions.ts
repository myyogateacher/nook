import { audit, db, now } from "../db";
import { INSTRUCTION_LIMITS, type InstructionsView, type ProposalView, type ReportInstruction } from "../../shared/reportsEdit";
import type { QueryResultView } from "../../shared/reportsView";
import { commentableReport, ownedReport, readableReport, reportLevel } from "./access";
import { cancelLiveEdit, instructionRow, liveEdits, startEdit, type InstructionRow, type StoredProposal } from "./edit";
import { ReportError } from "./errors";
import { changedQueryKeys, diffSpecs } from "./patch";
import { queryResults, runRow } from "./refresh";
import { parseSpec } from "./service";
import { commitSpec, refuseWhileRunning } from "./versions";

/**
 * Instructions to the edit agent (plan wave 48, D450, D453): a comment on the page or a block becomes a
 * `report_instructions` row, processed strictly FIFO and one at a time per report. The queue moves when
 * an instruction is added, when one settles (proposed and then applied or rejected, failed, cancelled),
 * and on a sweep every few seconds that picks up instructions a busy run lock left waiting. While a
 * proposal waits for review the queue waits too (052's one-active index), so the next instruction is
 * made against the spec the person accepted. The owner may turn on auto-apply: a proposal from the
 * owner's own instruction is then applied as soon as it is made.
 */

type Actor = { userId: string; role: string; keyId?: string | null };
type Row = InstructionRow & { author_name: string | null };

const SELECT = "SELECT i.*, u.display_name AS author_name FROM report_instructions i LEFT JOIN users u ON u.id = i.author_id";

function view(row: Row, userId: string): ReportInstruction {
  return {
    id: row.id, reportId: row.report_id, blockId: row.block_id, text: row.text, status: row.status as ReportInstruction["status"], position: row.position,
    authorName: row.author_name, isMine: row.author_id === userId, via: row.via, runId: row.run_id,
    // The run's live events are its author's (the SSE route checks it too).
    agentRunId: row.author_id === userId ? row.agent_run_id : null,
    summary: row.summary, error: row.error, appliedVersion: row.applied_version, autoApplied: row.auto_applied === 1,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, decidedAt: row.decided_at
  };
}

const ORDER = "ORDER BY CASE i.status WHEN 'queued' THEN 1 ELSE 0 END, CASE WHEN i.status = 'queued' THEN i.position END, i.created_at, i.rowid";

/** The thread (oldest first, the queue last in its order), the caller's rights, and auto-apply. */
export function listInstructions(reportId: string, userId: string, role: string): InstructionsView {
  const report = readableReport(reportId, userId);
  const level = reportLevel(report, userId);
  const rows = db.query(`${SELECT} WHERE i.report_id = ? ${ORDER} LIMIT 200`).all(reportId) as Row[];
  return {
    instructions: rows.map((row) => view(row, userId)),
    level,
    canComment: (level === "owner" || level === "comment") && role !== "viewer" && role !== "guest",
    canApply: level === "owner",
    autoApply: (db.query("SELECT auto_apply FROM reports WHERE id = ?").get(reportId) as { auto_apply: number }).auto_apply === 1
  };
}

export function getInstruction(reportId: string, instructionId: string, userId: string): ReportInstruction {
  readableReport(reportId, userId);
  const row = db.query(`${SELECT} WHERE i.id = ? AND i.report_id = ?`).get(instructionId, reportId) as Row | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  return view(row, userId);
}

/** Adds an instruction at the end of the queue and kicks the queue. */
export function addInstruction(actor: Actor, reportId: string, input: { text: string; blockId?: string | null }): ReportInstruction {
  const { row: report } = commentableReport(reportId, actor.userId);
  if (actor.role === "viewer" || actor.role === "guest") throw new ReportError(403, "ROLE_READ_ONLY", "Your role cannot ask for changes");
  const text = input.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, INSTRUCTION_LIMITS.text);
  if (!text) throw new ReportError(400, "INVALID", "Write what to change");
  const blockId = input.blockId ?? null;
  if (blockId && !parseSpec(report.spec_json).blocks.some((block) => block.id === blockId)) throw new ReportError(404, "NOT_FOUND", "That block is not in the report");
  const queued = (db.query("SELECT COUNT(*) AS count FROM report_instructions WHERE report_id = ? AND status = 'queued'").get(reportId) as { count: number }).count;
  if (queued >= INSTRUCTION_LIMITS.queued) throw new ReportError(429, "LIMIT_REACHED", `At most ${INSTRUCTION_LIMITS.queued} instructions can wait at once`);
  const id = crypto.randomUUID();
  const at = now();
  const position = ((db.query("SELECT max(position) AS position FROM report_instructions WHERE report_id = ?").get(reportId) as { position: number | null }).position ?? 0) + 1;
  db.query(`INSERT INTO report_instructions (id, report_id, block_id, text, author_id, via, key_id, status, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, reportId, blockId, text, actor.userId, actor.keyId ? "mcp" : "web", actor.keyId ?? null, position, at, at);
  // Never the text (T380: it is the person's words, and it may quote warehouse data).
  audit(actor.userId, null, "reports.instruction.add", { reportId, instructionId: id, blockId, chars: text.length, ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, id, actor.userId);
}

/** Reorders the queued instructions (the owner): `ids` in their new order; others keep theirs after them. */
export function reorderInstructions(userId: string, reportId: string, ids: readonly string[]): InstructionsView {
  ownedReport(reportId, userId);
  db.transaction(() => {
    const queued = (db.query("SELECT id FROM report_instructions WHERE report_id = ? AND status = 'queued' ORDER BY position, rowid").all(reportId) as Array<{ id: string }>).map((row) => row.id);
    const wanted = ids.filter((id) => queued.includes(id));
    const order = [...new Set([...wanted, ...queued])];
    const base = (db.query("SELECT max(position) AS position FROM report_instructions WHERE report_id = ?").get(reportId) as { position: number | null }).position ?? 0;
    order.forEach((id, index) => db.query("UPDATE report_instructions SET position = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(base + 1 + index, now(), id));
  })();
  audit(userId, null, "reports.instruction.reorder", { reportId, count: ids.length });
  const role = (db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | null)?.role ?? "member";
  return listInstructions(reportId, userId, role);
}

/** Cancels a queued or running instruction (its author or the owner). */
export function cancelInstruction(userId: string, reportId: string, instructionId: string, via: { keyId?: string } = {}): ReportInstruction {
  const report = readableReport(reportId, userId);
  const row = instructionRow(instructionId);
  if (!row || row.report_id !== reportId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  if (row.author_id !== userId && report.owner_id !== userId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  if (row.status === "queued") {
    const at = now();
    db.query("UPDATE report_instructions SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(at, at, instructionId);
  } else if (row.status === "running") {
    if (!cancelLiveEdit(instructionId)) {
      const at = now();
      db.query("UPDATE report_instructions SET status = 'cancelled', error = 'Cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(at, at, instructionId);
      if (row.run_id) db.query("UPDATE report_runs SET status = 'failed', error = 'Cancelled', finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'").run(at, row.run_id);
    }
  } else throw new ReportError(409, "INVALID", row.status === "proposed" ? "Reject the proposal instead" : "This instruction has already finished");
  audit(userId, null, "reports.instruction.cancel", { reportId, instructionId, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, instructionId, userId);
}

// ----------------------------------------------------------------------------------- proposals

function storedProposal(row: InstructionRow): StoredProposal {
  if (row.status !== "proposed" || !row.proposal_json) throw new ReportError(409, "INVALID", "This instruction has no proposal to review");
  return JSON.parse(row.proposal_json) as StoredProposal;
}

function proposedRow(reportId: string, instructionId: string): InstructionRow {
  const row = instructionRow(instructionId);
  if (!row || row.report_id !== reportId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  return row;
}

/** The proposal as the review shows it (anyone who can read the report). */
export function proposalView(reportId: string, instructionId: string, userId: string): ProposalView {
  const report = readableReport(reportId, userId);
  const row = proposedRow(reportId, instructionId);
  const proposal = storedProposal(row);
  const current = parseSpec(report.spec_json);
  const diff = diffSpecs(current, proposal.spec);
  const currentResults = queryResults(reportId, current);
  const byKey = new Map(currentResults.map((item) => [item.queryKey, item]));
  const results: QueryResultView[] = proposal.spec.queries.map((query) => {
    const fresh = proposal.results[query.key];
    if (fresh) {
      return {
        queryKey: query.key, failed: null, stale: false,
        result: { runId: row.run_id ?? "", queryKey: query.key, sql: query.sql, sentSql: fresh.sentSql, columns: fresh.columns, rows: fresh.rows, rowCount: fresh.rows.length, truncated: fresh.truncated, rowsRead: fresh.rowsRead, bytesRead: fresh.bytesRead, chQueryId: fresh.chQueryId, ms: fresh.ms, error: null, errorCode: null, createdAt: row.finished_at ?? row.updated_at }
      };
    }
    return byKey.get(query.key) ?? { queryKey: query.key, result: null, failed: null, stale: false };
  });
  return { instructionId, spec: proposal.spec, blocks: diff.blocks, queries: diff.queries, results, currentResults, summary: proposal.summary, outOfDate: row.base_revision !== report.revision };
}

/**
 * Apply (the owner; also auto-apply): the proposed spec becomes a new version, its touched blocks
 * stamped `{runId, instructionId, version}`, its new results saved under the edit run. A report that
 * changed since the agent started answers 409 REVISION_CONFLICT (reject it, or ask again).
 */
export function applyProposal(userId: string, reportId: string, instructionId: string, options: { auto?: boolean; keyId?: string } = {}): ReportInstruction {
  ownedReport(reportId, userId);
  const row = proposedRow(reportId, instructionId);
  const proposal = storedProposal(row);
  refuseWhileRunning(reportId);
  const current = parseSpec((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json);
  const diff = diffSpecs(current, proposal.spec);
  const stamp = new Set(diff.blocks.filter((change) => change.change === "added" || change.change === "updated").map((change) => change.blockId));
  const changed = changedQueryKeys(diff);
  // The results need their run; one pruned since (wave 47 keeps 20) is recorded again, finished.
  let runId = row.run_id && runRow(row.run_id) ? row.run_id : null;
  if (!runId) {
    runId = crypto.randomUUID();
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, created_by, started_at, finished_at) VALUES (?, ?, 'edit', ?, 'succeeded', ?, ?, ?)")
      .run(runId, reportId, row.via === "mcp" ? "mcp" : "user", userId, row.started_at ?? now(), row.finished_at ?? now());
  }
  const results = new Map(Object.entries(proposal.results).filter(([key]) => changed.has(key)));
  const saved = db.transaction(() => {
    const committed = commitSpec({
      reportId, userId, spec: proposal.spec, source: "edit", expectedRevision: row.base_revision ?? undefined, instructionId, stamp, runId,
      docSnapshotId: proposal.docSnapshotId, results, note: row.summary
    });
    const at = now();
    const marked = db.query("UPDATE report_instructions SET status = 'applied', applied_version = ?, auto_applied = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .run(committed.version, options.auto ? 1 : 0, userId, at, at, instructionId);
    if (marked.changes !== 1) throw new ReportError(409, "INVALID", "This proposal was already decided");
    return committed;
  })();
  audit(userId, null, "reports.instruction.apply", { reportId, instructionId, version: saved.version, auto: Boolean(options.auto), blocks: stamp.size, queries: results.size, ...(options.keyId ? { via: "mcp", keyId: options.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, instructionId, userId);
}

/** Reject (the owner, or the instruction's author): the spec stays as it is; the queue moves on. */
export function rejectProposal(userId: string, reportId: string, instructionId: string, via: { keyId?: string } = {}): ReportInstruction {
  const report = readableReport(reportId, userId);
  const row = proposedRow(reportId, instructionId);
  if (report.owner_id !== userId && row.author_id !== userId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  storedProposal(row);
  const at = now();
  const marked = db.query("UPDATE report_instructions SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'").run(userId, at, at, instructionId);
  if (marked.changes !== 1) throw new ReportError(409, "INVALID", "This proposal was already decided");
  audit(userId, null, "reports.instruction.reject", { reportId, instructionId, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, instructionId, userId);
}

/** The owner's auto-apply switch. */
export function setAutoApply(userId: string, reportId: string, on: boolean): { autoApply: boolean } {
  ownedReport(reportId, userId);
  db.query("UPDATE reports SET auto_apply = ? WHERE id = ?").run(on ? 1 : 0, reportId);
  audit(userId, null, "reports.instruction.auto_apply", { reportId, on });
  return { autoApply: on };
}

// --------------------------------------------------------------------------------------- the queue

const kicking = new Set<string>();

/** After an instruction settles: auto-apply a proposal when the owner asked for it, then move the queue. */
function settled(row: InstructionRow) {
  if (row.status === "proposed") {
    const report = db.query("SELECT owner_id, auto_apply FROM reports WHERE id = ? AND deleted_at IS NULL").get(row.report_id) as { owner_id: string; auto_apply: number } | null;
    // Only the owner's own instructions apply themselves (D453): a commenter's always waits for review.
    if (report?.auto_apply === 1 && row.author_id === report.owner_id) {
      try {
        applyProposal(report.owner_id, row.report_id, row.id, { auto: true, keyId: row.key_id ?? undefined });
        return;
      } catch (error) {
        // Left proposed for the owner to look at (a refresh started meanwhile, or the report changed).
        audit(report.owner_id, null, "reports.instruction.auto_apply_failed", { reportId: row.report_id, instructionId: row.id, code: error instanceof ReportError ? error.code : "INTERNAL" });
      }
    }
    return;
  }
  kick(row.report_id);
}

/**
 * Moves a report's queue: when nothing runs or waits for review, the head instruction starts. A run
 * lock held by a refresh or generation leaves it queued for the sweep.
 */
export function kick(reportId: string) {
  if (kicking.has(reportId)) return;
  kicking.add(reportId);
  try {
    for (let guard = 0; guard < INSTRUCTION_LIMITS.queued + 1; guard += 1) {
      const live = db.query("SELECT 1 FROM reports WHERE id = ? AND deleted_at IS NULL").get(reportId);
      if (!live) return;
      if (db.query("SELECT 1 FROM report_instructions WHERE report_id = ? AND status IN ('running','proposed')").get(reportId)) return;
      const head = db.query("SELECT id FROM report_instructions WHERE report_id = ? AND status = 'queued' ORDER BY position, rowid LIMIT 1").get(reportId) as { id: string } | null;
      if (!head) return;
      if (startEdit(head.id, { settled })) return;
      // Not started: still queued (the lock is busy: wait), or failed at once (try the next one).
      if (instructionRow(head.id)?.status === "queued") return;
    }
  } finally {
    kicking.delete(reportId);
  }
}

/**
 * The sweep (every few seconds): instructions left `running` without a live edit (their run was
 * abandoned) fail, and every report with a queued head and nothing active is kicked.
 */
export function sweepInstructions(): number {
  const liveIds = new Set(liveEdits().map((entry) => entry.instructionId));
  const stuck = db.query(`SELECT i.id, i.run_id FROM report_instructions i LEFT JOIN report_runs r ON r.id = i.run_id
    WHERE i.status = 'running' AND (r.id IS NULL OR r.status <> 'running')`).all() as Array<{ id: string; run_id: string | null }>;
  const at = now();
  for (const row of stuck) {
    if (liveIds.has(row.id)) continue;
    db.query("UPDATE report_instructions SET status = 'failed', error = 'The edit stopped before it finished', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(at, at, row.id);
  }
  const waiting = db.query(`SELECT DISTINCT i.report_id FROM report_instructions i JOIN reports r ON r.id = i.report_id AND r.deleted_at IS NULL
    WHERE i.status = 'queued' AND NOT EXISTS (SELECT 1 FROM report_instructions a WHERE a.report_id = i.report_id AND a.status IN ('running','proposed'))`).all() as Array<{ report_id: string }>;
  for (const { report_id } of waiting) {
    try { kick(report_id); } catch (error) { console.error("Reports: an instruction queue could not move", error instanceof Error ? error.name : "Error"); }
  }
  return waiting.length;
}

/** Boot: instructions a stopped server left running fail (their runs are abandoned by wave 47's boot pass). */
export function failInstructionsAtBoot(): number {
  const at = now();
  return db.query("UPDATE report_instructions SET status = 'failed', error = 'The server restarted during the edit', finished_at = ?, updated_at = ? WHERE status = 'running'").run(at, at).changes;
}

export const INSTRUCTION_SWEEP_MS = 5_000;
let timer: ReturnType<typeof setInterval> | null = null;
export function startInstructionSweep() {
  if (timer) return;
  timer = setInterval(() => {
    try { sweepInstructions(); } catch (error) { console.error("Reports: the instruction sweep failed", error instanceof Error ? error.name : "Error"); }
  }, INSTRUCTION_SWEEP_MS);
  (timer as { unref?: () => void }).unref?.();
}

