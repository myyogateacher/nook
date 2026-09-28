import { addColumn, type Migration } from "./types";

/** Days a pending proposal waits for review when no routine sets its own expiry (D156). */
export const DEFAULT_PROPOSAL_EXPIRE_DAYS = 14;

/**
 * The agent inbox (docs/plan/research/2026-09-28-agent-inbox-routines.md §6, D146–D160).
 *
 * - `proposals` holds a change an outside agent asked for. It is reviewed by the key's owner and
 *   applied only through the web app (D146). `note_draft` rows point at a draft (`{noteId,
 *   revision, created}`); the Markdown stays in the draft file (D149).
 * - `routines` and `routine_runs` are created now so `proposals.run_id` has a real foreign key
 *   from day one; they stay unused until Wave 22 (O1).
 * - `notifications` gains a second source, kind `proposals` (D159). Existing rows are reminders.
 * - `user_preferences.proposal_push` is the per-user opt-in for proposal pushes (bell on, push off, O5).
 *
 * Backfill: every live note whose draft an MCP key wrote gets a pending `note_draft` proposal with
 * one timestamp for the whole migration, so Today's "Drafts from agents" retires with no gap (D158).
 * Transactional and filesystem-free. Needs 005 (keys), 010 (draft_mcp_key_id), 013 (notifications),
 * and 016 (preferences); independent of 017–020.
 */
export const agentInboxMigration: Migration = {
  id: 21,
  name: "agent_inbox",
  up(db) {
    db.exec(`
      CREATE TABLE routines (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        name_fold TEXT NOT NULL,
        instructions TEXT NOT NULL CHECK (length(CAST(instructions AS BLOB)) BETWEEN 1 AND 16384),
        output_kinds TEXT NOT NULL CHECK (json_valid(output_kinds) AND json_array_length(output_kinds) >= 1),
        targets TEXT CHECK (targets IS NULL OR json_valid(targets)),
        scope_hints TEXT CHECK (scope_hints IS NULL OR length(scope_hints) <= 500),
        cadence TEXT NOT NULL CHECK (cadence IN ('manual','hourly','daily','weekdays','weekly')),
        at_time TEXT CHECK (at_time IS NULL OR at_time GLOB '[0-2][0-9]:[0-5][0-9]'),
        weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
        tz TEXT NOT NULL,
        schedule_note TEXT CHECK (schedule_note IS NULL OR length(schedule_note) <= 120),
        max_proposals INTEGER NOT NULL DEFAULT 25 CHECK (max_proposals BETWEEN 1 AND 100),
        expire_days INTEGER NOT NULL DEFAULT 14 CHECK (expire_days BETWEEN 1 AND 30),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        next_due_at TEXT, last_run_at TEXT, last_run_status TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name_fold)
      );
      CREATE INDEX idx_routines_due ON routines(owner_id, next_due_at) WHERE enabled = 1 AND next_due_at IS NOT NULL;

      CREATE TABLE routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned')),
        slot_at TEXT,
        started_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, finished_at TEXT,
        tool_calls INTEGER NOT NULL DEFAULT 0, proposals_count INTEGER NOT NULL DEFAULT 0,
        capped INTEGER NOT NULL DEFAULT 0 CHECK (capped IN (0,1)),
        summary TEXT CHECK (summary IS NULL OR length(CAST(summary AS BLOB)) <= 4096),
        error TEXT CHECK (error IS NULL OR length(error) <= 500),
        client_label TEXT CHECK (client_label IS NULL OR length(client_label) <= 60)
      );
      CREATE UNIQUE INDEX idx_runs_one_running ON routine_runs(routine_id) WHERE status = 'running';
      CREATE INDEX idx_runs_key_running ON routine_runs(key_id) WHERE status = 'running';
      CREATE INDEX idx_runs_routine ON routine_runs(routine_id, started_at DESC);

      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL,
        key_name TEXT NOT NULL,
        routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES routine_runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('note_draft','card_create','card_update','card_comment',
                                           'event_create','event_update','row_create','row_update')),
        target_type TEXT NOT NULL CHECK (target_type IN ('note','folder','board','card','calendar','event','collection','row')),
        target_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        rationale TEXT CHECK (rationale IS NULL OR length(rationale) <= 1000),
        payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 65536),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending','applying','applied','rejected','expired','failed','superseded','withdrawn')),
        result_code TEXT, result_ref TEXT,
        reject_reason TEXT CHECK (reject_reason IS NULL OR length(reject_reason) <= 200),
        reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, claimed_at TEXT
      );
      CREATE INDEX idx_proposals_pending ON proposals(owner_id, created_at DESC) WHERE status = 'pending';
      CREATE INDEX idx_proposals_run ON proposals(run_id, created_at);
      CREATE INDEX idx_proposals_target ON proposals(target_type, target_id) WHERE status = 'pending';
      CREATE INDEX idx_proposals_expiry ON proposals(expires_at) WHERE status = 'pending';
      CREATE INDEX idx_proposals_key ON proposals(key_id, created_at DESC);
      CREATE INDEX idx_proposals_owner_resolved ON proposals(owner_id, resolved_at DESC) WHERE status <> 'pending';
    `);
    addColumn(db, "notifications", "kind", "TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder','proposals'))");
    addColumn(db, "notifications", "run_id", "TEXT REFERENCES routine_runs(id) ON DELETE SET NULL");
    addColumn(db, "notifications", "proposal_key_id", "TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL");
    addColumn(db, "notifications", "proposal_count", "INTEGER");
    addColumn(db, "user_preferences", "proposal_push", "INTEGER NOT NULL DEFAULT 0 CHECK (proposal_push IN (0,1))");

    const timestamp = new Date();
    const createdAt = timestamp.toISOString();
    const expiresAt = new Date(timestamp.getTime() + DEFAULT_PROPOSAL_EXPIRE_DAYS * 86_400_000).toISOString();
    const drafts = db.query(`
      SELECT n.id, n.owner_id, n.title, n.draft_revision, n.current_version, k.id AS key_id, k.name AS key_name
      FROM notes n JOIN mcp_api_keys k ON k.id = n.draft_mcp_key_id
      WHERE n.deleted_at IS NULL AND n.draft_revision IS NOT NULL
      ORDER BY n.updated_at, n.id
    `).all() as Array<{ id: string; owner_id: string; title: string; draft_revision: number; current_version: number; key_id: string; key_name: string }>;
    const insert = db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'note_draft', 'note', ?, ?, ?, ?, ?)`);
    for (const draft of drafts) {
      const title = draft.title.trim().slice(0, 120) || "Untitled";
      const payload = JSON.stringify({ noteId: draft.id, revision: draft.draft_revision, created: draft.current_version === 0 });
      insert.run(crypto.randomUUID(), draft.owner_id, draft.key_id, draft.key_name.slice(0, 120) || "MCP key", draft.id, title, payload, createdAt, expiresAt);
    }
  }
};
