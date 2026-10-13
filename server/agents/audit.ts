import { db, now } from "../db";
import { EXTERNAL_BOUNDS, RUN_STATUSES, type AgentApiUsage, type AuditFacets, type AuditRunDetail, type AuditRunSummary, type AuditStepView, type AuditVia, type RunStatus, type TokenUsage } from "../../shared/agents";
import { readAgentSettings } from "./settings";
import { AgentError } from "./status";

/**
 * The Audit log (Wave 42 "AC-C", plan §7.3, D365, D366, T317): every API and MCP run, written
 * here and never as a chat. `agent_runs` holds the metadata, `agent_audit_entries` the input and
 * output, `agent_audit_steps` the timeline (model calls and tool calls). Migration 040 makes them
 * append-only: a live run's row changes, a finished one never does, steps are never edited, and
 * the only deletes are this file's guarded retention sweep and the cascade of a deleted key.
 *
 * Readers (D73, D366):
 * - the key's owner (the run's `user_id`: keys run as their owner) reads everything of their runs;
 * - admins read the metadata of every run: agent, key name and prefix, owner, status, counts,
 *   tokens, timings, and tool names; never the input, output, arguments, results, or label;
 * - an agent's managers see counts per day (agentApiUsage), never runs.
 * Everyone else gets the 404. What leaves here never includes a provider key or a tool server's
 * credential: neither is ever written (the canary test checks every column).
 */

// ------------------------------------------------------------------------------------- writer

const cut = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let value = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (value.endsWith("�")) value = value.slice(0, -1);
  return { text: value, truncated: true };
};

export type AuditRunStart = {
  runId: string; via: AuditVia; agentId: string; agentRevision: number; promptSha256: string; preambleVersion: number;
  userId: string; keyId: string; providerId: string; model: string; clientAddress: string | null; label: string | null; input: string;
};

/** The run's row and its input, in one transaction, before the provider is called. */
export function insertAuditRun(start: AuditRunStart) {
  const queuedAt = now();
  const purgeAfter = new Date(Date.parse(queuedAt) + readAgentSettings().auditRetentionDays * 86_400_000).toISOString();
  db.transaction(() => {
    db.query(`INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, chat_id, user_id, key_id, provider_id, model, status, client_address, label, queued_at, purge_after)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(start.runId, start.via, start.agentId, start.agentRevision, start.promptSha256, start.preambleVersion,
      start.userId, start.keyId, start.providerId, start.model, start.clientAddress, start.label, queuedAt, purgeAfter);
    db.query("INSERT INTO agent_audit_entries (run_id, input_text, output_text) VALUES (?, ?, NULL)").run(start.runId, start.input.slice(0, 131_072));
  })();
  return queuedAt;
}

export type AuditStepInput =
  | { kind: "model"; text: string; toolCalls: Array<{ name: string; arguments: string }>; usage: TokenUsage; durationMs: number }
  | { kind: "tool"; serverId: string | null; tool: string; args: string; result: string; ok: boolean; durationMs: number };

/** Appends one step (never edited afterwards). */
export function insertAuditStep(runId: string, seq: number, step: AuditStepInput) {
  if (step.kind === "model") {
    const text = cut(step.text, EXTERNAL_BOUNDS.stepTextBytes);
    const calls = step.toolCalls.length ? cut(JSON.stringify(step.toolCalls), EXTERNAL_BOUNDS.stepTextBytes) : null;
    db.query(`INSERT INTO agent_audit_steps (run_id, seq, kind, server_id, tool_name, text, args_json, result_text, truncated, ok, prompt_tokens, completion_tokens, duration_ms)
      VALUES (?, ?, 'model', NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?, ?)`).run(runId, seq, text.text, calls?.text ?? null, text.truncated || calls?.truncated ? 1 : 0, step.usage.promptTokens, step.usage.completionTokens, Math.max(0, Math.round(step.durationMs)));
    return;
  }
  const args = cut(step.args, EXTERNAL_BOUNDS.stepTextBytes);
  const result = cut(step.result, EXTERNAL_BOUNDS.stepTextBytes);
  db.query(`INSERT INTO agent_audit_steps (run_id, seq, kind, server_id, tool_name, text, args_json, result_text, truncated, ok, prompt_tokens, completion_tokens, duration_ms)
    VALUES (?, ?, 'tool', ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`).run(runId, seq, step.serverId, step.tool.slice(0, 128), args.text, result.text, args.truncated || result.truncated ? 1 : 0, step.ok ? 1 : 0, Math.max(0, Math.round(step.durationMs)));
}

export const markAuditStarted = (runId: string) => db.query("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ? AND finished_at IS NULL").run(now(), runId);
export const markAuditFirstToken = (runId: string) => db.query("UPDATE agent_runs SET first_token_at = ? WHERE id = ? AND finished_at IS NULL AND first_token_at IS NULL").run(now(), runId);

/** The output and the final row, in one transaction; after this the run is frozen (migration 040). */
export function finishAuditRun(runId: string, end: { status: RunStatus; errorCode: string | null; steps: number; toolCalls: number; usage: TokenUsage; output: string }) {
  const finishedAt = now();
  db.transaction(() => {
    db.query("UPDATE agent_audit_entries SET output_text = ? WHERE run_id = ? AND output_text IS NULL").run(end.output.slice(0, 262_144), runId);
    db.query(`UPDATE agent_runs SET status = ?, error_code = ?, steps = ?, tool_calls = ?, prompt_tokens = ?, completion_tokens = ?, tokens_estimated = ?, finished_at = ?
      WHERE id = ? AND finished_at IS NULL`).run(end.status, end.errorCode, end.steps, end.toolCalls, end.usage.promptTokens, end.usage.completionTokens, end.usage.estimated ? 1 : 0, finishedAt, runId);
  })();
  return finishedAt;
}

// ------------------------------------------------------------------------------------- readers

export type AuditViewer = { userId: string; role: string };

type RunRow = {
  id: string; via: AuditVia; agent_id: string; agent_revision: number; preamble_version: number; user_id: string; key_id: string | null; model: string;
  status: RunStatus; error_code: string | null; steps: number; tool_calls: number; prompt_tokens: number; completion_tokens: number; tokens_estimated: number;
  client_address: string | null; label: string | null; queued_at: string; started_at: string | null; first_token_at: string | null; finished_at: string | null; purge_after: string | null;
  agent_name: string | null; key_name: string | null; key_prefix: string | null; owner_name: string | null;
};

const RUN_SELECT = `SELECT r.id, r.via, r.agent_id, r.agent_revision, r.preamble_version, r.user_id, r.key_id, r.model, r.status, r.error_code, r.steps, r.tool_calls,
  r.prompt_tokens, r.completion_tokens, r.tokens_estimated, r.client_address, r.label, r.queued_at, r.started_at, r.first_token_at, r.finished_at, r.purge_after,
  a.name AS agent_name, k.name AS key_name, k.key_prefix AS key_prefix, u.display_name AS owner_name
  FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN mcp_api_keys k ON k.id = r.key_id LEFT JOIN users u ON u.id = r.user_id`;

const isAdmin = (viewer: AuditViewer) => viewer.role === "admin";

function summaryOf(row: RunRow, viewer: AuditViewer): AuditRunSummary {
  const full = row.user_id === viewer.userId;
  const durationMs = row.finished_at ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.queued_at)) : null;
  return {
    id: row.id, via: row.via, agentId: row.agent_id, agentName: row.via === "reports" ? "Reports" : row.agent_name, key: row.key_id ? { id: row.key_id, name: row.key_name ?? "", prefix: row.key_prefix ?? "" } : null,
    owner: { id: row.user_id, displayName: row.owner_name }, status: row.status, errorCode: row.error_code, model: row.model,
    steps: row.steps, toolCalls: row.tool_calls, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, estimated: row.tokens_estimated === 1,
    queuedAt: row.queued_at, startedAt: row.started_at, firstTokenAt: row.first_token_at, finishedAt: row.finished_at, durationMs,
    label: full ? row.label : null, full
  };
}

export type AuditFilter = { keyId?: string | null; agentId?: string | null; status?: string | null; from?: string | null; to?: string | null; cursor?: string | null; ownerId?: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_GROUPS: Record<string, readonly RunStatus[]> = {
  ok: ["ok"], failed: ["error", "timeout", "budget", "interrupted"], cancelled: ["cancelled"], step_limit: ["step_limit"], running: ["queued", "running"]
};

/** The WHERE clause for a reader and filter; `ownOnly` keeps the reader's own runs (export, non-admins). */
function whereFor(viewer: AuditViewer, filter: AuditFilter, ownOnly: boolean) {
  const terms = ["r.via <> 'chat'"];
  const params: Record<string, string> = {};
  if (ownOnly || !isAdmin(viewer)) { terms.push("r.user_id = $viewer"); params.viewer = viewer.userId; }
  else if (filter.ownerId) { terms.push("r.user_id = $owner"); params.owner = filter.ownerId; }
  if (filter.keyId) { terms.push("r.key_id = $key"); params.key = filter.keyId; }
  if (filter.agentId) { terms.push("r.agent_id = $agent"); params.agent = filter.agentId; }
  if (filter.status) {
    const statuses = STATUS_GROUPS[filter.status] ?? ((RUN_STATUSES as readonly string[]).includes(filter.status) ? [filter.status] : null);
    if (!statuses) throw new AgentError(400, "INVALID", "Unknown status filter", { field: "status" });
    terms.push(`r.status IN (${statuses.map((status) => `'${status}'`).join(",")})`);
  }
  if (filter.from) {
    if (!DAY.test(filter.from)) throw new AgentError(400, "INVALID", "from must be YYYY-MM-DD", { field: "from" });
    terms.push("r.queued_at >= $from"); params.from = `${filter.from}T00:00:00.000Z`;
  }
  if (filter.to) {
    if (!DAY.test(filter.to)) throw new AgentError(400, "INVALID", "to must be YYYY-MM-DD", { field: "to" });
    terms.push("r.queued_at < $to"); params.to = new Date(Date.parse(`${filter.to}T00:00:00.000Z`) + 86_400_000).toISOString();
  }
  return { sql: terms.join(" AND "), params };
}

/** One page of the Audit log, newest first (cursor = `queuedAt|id` of the last row). */
export function listAuditRuns(viewer: AuditViewer, filter: AuditFilter): { runs: AuditRunSummary[]; nextCursor: string | null } {
  const where = whereFor(viewer, filter, false);
  let sql = where.sql;
  const params = { ...where.params };
  if (filter.cursor) {
    const [at, id] = filter.cursor.split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new AgentError(400, "INVALID", "Invalid cursor", { field: "cursor" });
    sql += " AND (r.queued_at < $cursorAt OR (r.queued_at = $cursorAt AND r.id < $cursorId))";
    params.cursorAt = at;
    params.cursorId = id;
  }
  const rows = db.query(`${RUN_SELECT} WHERE ${sql} ORDER BY r.queued_at DESC, r.id DESC LIMIT ${EXTERNAL_BOUNDS.page + 1}`).all(params) as RunRow[];
  const page = rows.slice(0, EXTERNAL_BOUNDS.page);
  const last = page.at(-1);
  return { runs: page.map((row) => summaryOf(row, viewer)), nextCursor: rows.length > EXTERNAL_BOUNDS.page && last ? `${last.queued_at}|${last.id}` : null };
}

type StepRow = { seq: number; kind: "model" | "tool"; server_id: string | null; server_slug: string | null; tool_name: string | null; text: string | null; args_json: string | null; result_text: string | null; truncated: number; ok: number | null; prompt_tokens: number | null; completion_tokens: number | null; duration_ms: number };

function detailOf(row: RunRow, viewer: AuditViewer): AuditRunDetail {
  const summary = summaryOf(row, viewer);
  const full = summary.full;
  const steps = db.query(`SELECT s.seq, s.kind, s.server_id, t.slug AS server_slug, s.tool_name, s.text, s.args_json, s.result_text, s.truncated, s.ok, s.prompt_tokens, s.completion_tokens, s.duration_ms
    FROM agent_audit_steps s LEFT JOIN agent_tool_servers t ON t.id = s.server_id WHERE s.run_id = ? ORDER BY s.seq`).all(row.id) as StepRow[];
  const entry = full ? db.query("SELECT input_text, output_text FROM agent_audit_entries WHERE run_id = ?").get(row.id) as { input_text: string; output_text: string | null } | null : null;
  const timeline: AuditStepView[] = steps.map((step) => ({
    seq: step.seq, kind: step.kind, server: step.kind === "tool" ? step.server_slug ?? (step.server_id ? "(removed server)" : step.tool_name === "search_knowledge" ? "knowledge" : "nook") : null, tool: step.tool_name,
    ok: step.ok === null ? null : step.ok === 1, truncated: step.truncated === 1, durationMs: step.duration_ms, promptTokens: step.prompt_tokens, completionTokens: step.completion_tokens,
    // Content for the key's owner only (D73, D366).
    text: full ? step.text : null, args: full ? step.args_json : null, result: full ? step.result_text : null
  }));
  return {
    ...summary, input: entry?.input_text ?? null, output: entry?.output_text ?? null, timeline,
    toolNames: [...new Set(steps.filter((step) => step.kind === "tool" && step.tool_name).map((step) => step.tool_name!))],
    agentRevision: row.agent_revision, preambleVersion: row.preamble_version, clientAddress: full ? row.client_address : null, purgeAfter: row.purge_after
  };
}

/** One run for its key's owner (in full) or an admin (metadata); anyone else gets the 404. */
export function auditRunDetail(viewer: AuditViewer, runId: string): AuditRunDetail {
  const row = db.query(`${RUN_SELECT} WHERE r.id = ? AND r.via <> 'chat'`).get(runId) as RunRow | null;
  if (!row || (row.user_id !== viewer.userId && !isAdmin(viewer))) throw new AgentError(404, "NOT_FOUND", "Not found");
  return detailOf(row, viewer);
}

/**
 * The JSON export (plan §7.3): the reader's own runs only, in full, one run or up to 1,000 matching
 * the filter. An admin's export holds their own runs too; others' content is never exported.
 */
export function exportAuditRuns(viewer: AuditViewer, filter: AuditFilter & { runId?: string | null }) {
  let rows: RunRow[];
  if (filter.runId) {
    const row = db.query(`${RUN_SELECT} WHERE r.id = ? AND r.via <> 'chat' AND r.user_id = ?`).get(filter.runId, viewer.userId) as RunRow | null;
    if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
    rows = [row];
  } else {
    const where = whereFor(viewer, filter, true);
    rows = db.query(`${RUN_SELECT} WHERE ${where.sql} ORDER BY r.queued_at DESC, r.id DESC LIMIT ${EXTERNAL_BOUNDS.exportMax + 1}`).all(where.params) as RunRow[];
  }
  const truncated = rows.length > EXTERNAL_BOUNDS.exportMax;
  return { exportedAt: now(), count: Math.min(rows.length, EXTERNAL_BOUNDS.exportMax), truncated, runs: rows.slice(0, EXTERNAL_BOUNDS.exportMax).map((row) => detailOf(row, viewer)) };
}

/**
 * The filter sheet's choices (QA M3), independent of the runs loaded so far: the reader's own keys
 * that hold "Run agents" or have runs (revoked ones too, their runs stay) and the reader's own
 * agents (plus agents of their runs that went to the Bin or were purged). Admins also get the key
 * name and prefix (with the owner's name) and the agent name of every run they can see, as metadata
 * only. At most 500 of each.
 */
export function auditFacets(viewer: AuditViewer): AuditFacets {
  const keys = new Map<string, AuditFacets["keys"][number]>();
  const agents = new Map<string, AuditFacets["agents"][number]>();
  const ownKeys = db.query(`SELECT k.id, k.name, k.key_prefix FROM mcp_api_keys k WHERE k.user_id = $user AND k.kind = 'general'
      AND (EXISTS (SELECT 1 FROM api_key_grants g WHERE g.key_id = k.id AND g.module = 'agents' AND g.permission = 'run')
        OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.key_id = k.id AND r.via <> 'chat'))
    ORDER BY k.name COLLATE NOCASE LIMIT 500`).all({ user: viewer.userId }) as Array<{ id: string; name: string; key_prefix: string }>;
  for (const key of ownKeys) keys.set(key.id, { id: key.id, name: key.name, prefix: key.key_prefix, own: true, ownerName: null });
  const ownAgents = db.query(`SELECT id, name FROM agents WHERE owner_id = $user AND deleted_at IS NULL
    UNION SELECT r.agent_id AS id, a.name FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.user_id = $user AND r.via <> 'chat'
    LIMIT 500`).all({ user: viewer.userId }) as Array<{ id: string; name: string | null }>;
  for (const agent of ownAgents) agents.set(agent.id, { id: agent.id, name: agent.name, own: true });
  if (isAdmin(viewer)) {
    const runKeys = db.query(`SELECT DISTINCT r.key_id AS id, k.name, k.key_prefix, u.display_name FROM agent_runs r JOIN mcp_api_keys k ON k.id = r.key_id LEFT JOIN users u ON u.id = r.user_id
      WHERE r.via <> 'chat' AND r.user_id <> $user LIMIT 500`).all({ user: viewer.userId }) as Array<{ id: string; name: string; key_prefix: string; display_name: string | null }>;
    for (const key of runKeys) if (!keys.has(key.id)) keys.set(key.id, { id: key.id, name: key.name, prefix: key.key_prefix, own: false, ownerName: key.display_name });
    const runAgents = db.query(`SELECT DISTINCT r.agent_id AS id, a.name FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.via <> 'chat' AND r.user_id <> $user LIMIT 500`)
      .all({ user: viewer.userId }) as Array<{ id: string; name: string | null }>;
    for (const agent of runAgents) if (!agents.has(agent.id)) agents.set(agent.id, { id: agent.id, name: agent.name, own: false });
  }
  const byName = <T extends { name: string | null }>(a: T, b: T) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" });
  return { keys: [...keys.values()].sort(byName), agents: [...agents.values()].sort(byName) };
}

/** Whether the Audit log nav shows (plan §13.2): admins, and anyone who holds or held an `agents:run` key or has runs. */
export function auditVisibleTo(viewer: AuditViewer) {
  if (isAdmin(viewer)) return true;
  return db.query(`SELECT 1 FROM api_key_grants g JOIN mcp_api_keys k ON k.id = g.key_id WHERE k.user_id = $user AND g.module = 'agents' AND g.permission = 'run'
    UNION ALL SELECT 1 FROM agent_runs WHERE user_id = $user AND via <> 'chat' LIMIT 1`).get({ user: viewer.userId }) !== null;
}

/** An agent's API and MCP runs per day for its managers (D366): counts and tokens, never content. */
export function agentApiUsage(agentId: string, days = 30): AgentApiUsage {
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = db.query(`SELECT substr(queued_at, 1, 10) AS day, COUNT(*) AS runs, SUM(CASE WHEN status IN ('error','timeout','budget','interrupted') THEN 1 ELSE 0 END) AS errors,
      SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
    FROM agent_runs WHERE agent_id = ? AND via <> 'chat' AND queued_at >= ? GROUP BY day ORDER BY day DESC`).all(agentId, `${from}T00:00:00.000Z`) as Array<{ day: string; runs: number; errors: number; prompt_tokens: number; completion_tokens: number }>;
  const list = rows.map((row) => ({ day: row.day, runs: row.runs, errors: row.errors, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens }));
  const totals = list.reduce((sum, row) => ({ runs: sum.runs + row.runs, errors: sum.errors + row.errors, promptTokens: sum.promptTokens + row.promptTokens, completionTokens: sum.completionTokens + row.completionTokens }), { runs: 0, errors: 0, promptTokens: 0, completionTokens: 0 });
  return { days: list, totals };
}

// ------------------------------------------------------------------------------------- retention

export const RETENTION_BATCH = 500;
const MAX_BATCHES = 40;

/**
 * Retention (plan §7.3, D366): deletes API and MCP runs queued before now − the retention days,
 * in batches of 500, each inside the guard row the triggers check (and never anything younger than
 * 7 days, whatever the cutoff). Steps and entries go with their runs by cascade. Returns the count.
 */
export function sweepAgentAudit(nowMs = Date.now()): number {
  const days = readAgentSettings().auditRetentionDays;
  // Never past the trigger's own clock (the vault events' rule): a cutoff in the future would be refused.
  const cutoff = new Date(Math.min(nowMs, Date.now()) - days * 86_400_000).toISOString();
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const removed = db.transaction(() => {
      db.query("INSERT INTO agent_retention_guard (id, cutoff) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET cutoff = excluded.cutoff").run(cutoff);
      try {
        // Counted by id: `changes` would also count the cascaded entry and step rows.
        const ids = (db.query(`SELECT id FROM agent_runs WHERE via <> 'chat' AND queued_at < ? ORDER BY queued_at LIMIT ${RETENTION_BATCH}`).all(cutoff) as Array<{ id: string }>).map((row) => row.id);
        if (ids.length) db.query("DELETE FROM agent_runs WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
        return ids.length;
      } finally {
        db.query("DELETE FROM agent_retention_guard").run();
      }
    })();
    total += removed;
    if (removed < RETENTION_BATCH) break;
  }
  return total;
}
