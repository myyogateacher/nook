import type { Migration } from "./types";

/**
 * Analytics reports, Wave 48 (docs/plan/WAVES_45-48_REPORTS.md, D450–D459): instructions to the edit
 * agent, spec versions, and view-only sharing.
 *
 * - `report_instructions`: one row per comment on a page or a block, processed FIFO per report
 *   (`position`). A partial unique index allows one `running` or `proposed` instruction per report, so
 *   the queue waits while a proposal is reviewed and two edits never overlap. The proposal (the
 *   proposed spec and the results of its added or changed queries) is kept in `proposal_json`.
 * - `report_versions`: every spec a report has had, numbered per report. Wave 48's own writes (apply,
 *   restore, manual edits) insert their row in the transaction that changes `reports.spec_json`; a
 *   generation's spec is recorded (as `generate`) before the next change and before a regeneration
 *   starts (server/reports/versions.ts ensureVersionRecorded), so regenerating never loses the spec it
 *   replaces. No trigger: the spec's writers count changed rows. Existing reports with blocks get an
 *   `initial` version here.
 * - `reports.auto_apply`: the owner's "apply edits without review" switch (their own instructions only).
 * - `report_members` and `report_group_shares`: view-only sharing, `view` or `comment`, read under
 *   `reports.visibility = 'selected'` (050 added the column). They are the report's own tables rather
 *   than rows in `group_grants`, whose CHECK list would need a rebuild under its `access_grants_v` view.
 *
 * Needs 025 (user_groups), 050, and 051. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportInstructionsMigration: Migration = {
  id: 52,
  name: "report_instructions",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_instructions (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        block_id TEXT CHECK (block_id IS NULL OR length(block_id) BETWEEN 1 AND 40),
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        via TEXT NOT NULL DEFAULT 'web' CHECK (via IN ('web','mcp')),
        key_id TEXT CHECK (key_id IS NULL OR length(key_id) <= 64),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','proposed','applied','rejected','failed','cancelled')),
        position INTEGER NOT NULL,
        run_id TEXT REFERENCES report_runs(id) ON DELETE SET NULL,
        agent_run_id TEXT CHECK (agent_run_id IS NULL OR length(agent_run_id) <= 64),
        base_revision INTEGER,
        proposal_json TEXT CHECK (proposal_json IS NULL OR (json_valid(proposal_json) AND length(proposal_json) <= 16777216)),
        summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
        error TEXT CHECK (error IS NULL OR length(error) <= 1000),
        applied_version INTEGER,
        auto_applied INTEGER NOT NULL DEFAULT 0 CHECK (auto_applied IN (0,1)),
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        decided_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_instructions_queue ON report_instructions(report_id, status, position);
      -- One instruction at a time per report: the queue waits while one runs or its proposal is reviewed.
      CREATE UNIQUE INDEX IF NOT EXISTS report_instructions_one_active ON report_instructions(report_id) WHERE status IN ('running','proposed');

      CREATE TABLE IF NOT EXISTS report_versions (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND length(spec_json) <= 524288),
        source TEXT NOT NULL CHECK (source IN ('initial','generate','edit','restore','manual')),
        instruction_id TEXT REFERENCES report_instructions(id) ON DELETE SET NULL,
        restored_from INTEGER,
        run_id TEXT CHECK (run_id IS NULL OR length(run_id) <= 64),
        note TEXT CHECK (note IS NULL OR length(note) <= 300),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (report_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS report_members (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','comment')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (report_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_members_user ON report_members(user_id, report_id);

      CREATE TABLE IF NOT EXISTS report_group_shares (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','comment')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (report_id, group_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_group_shares_group ON report_group_shares(group_id, report_id);

    `);
    const columns = (db.query("PRAGMA table_info(reports)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes("auto_apply")) db.exec("ALTER TABLE reports ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply IN (0,1))");
    // Every report that already has a spec starts its history with it.
    db.exec(`INSERT OR IGNORE INTO report_versions (report_id, version, spec_json, source, created_by, created_at)
      SELECT r.id, max(1, COALESCE((SELECT max(CAST(json_extract(b.value, '$.provenance.version') AS INTEGER)) FROM json_each(r.spec_json, '$.blocks') b), 1)),
        r.spec_json, 'initial', r.owner_id, r.updated_at
      FROM reports r WHERE json_array_length(r.spec_json, '$.blocks') > 0 AND NOT EXISTS (SELECT 1 FROM report_versions v WHERE v.report_id = r.id)`);
  }
};
