# Waves 45–48: Analytics reports (module `reports`)

Plan of record for the analytics reports module, condensed from the approved plan of 2026-10-12. **Ids corrected at kickoff (2026-10-13):** the migration is **050** (049 is reserved for the Messages module; **051** is reserved for wave 48's `report_instructions` and `report_versions`); decisions start at **D410**; threats start at **T355**.

## What it is

A person pastes a link to a document (Outline or another doc system, reached through that provider's MCP server configured as a Tool Server). The document describes ClickHouse analytics: table definitions, rules, and metric definitions. Nook's AI writes ClickHouse SQL, runs it, and builds a web report with charts. Refresh re-runs the saved SQL without the AI, on demand or on an optional cadence.

Operator decisions (2026-10-12): ClickHouse is a built-in data source (admin-configured, encrypted password); a report is a saved, refreshable spec; doc MCP auth is bearer / API key only; scheduling is possible in v1 and optional per report.

## Reuse

- MCP client: `server/agents/mcpClient.ts`, `server/agents/toolServers.ts` (Outline: `fetch {resource:"document", id}` returns markdown).
- Agent loop: `server/agents/loop.ts`, `runs.ts` (`capResultText`, budgets), `stream.ts` (SSE), `audit.ts`.
- Egress: `server/agents/egress.ts` `egressFetch` (private or http hosts only through `AGENT_ALLOWED_PRIVATE_HOSTS`).
- Secrets: `server/agents/secrets.ts`, owner `datasource` (wave 45).
- Cadences: `shared/routineSchedule.ts` and the next-due logic of `server/inbox/routines.ts`; the tick in `server/sweeper.ts`.
- Module template: collections and whiteboards (`server/<mod>/{routes,service,access,mcpTools}.ts`, `server/moduleIds.ts` ↔ `src/modules.ts`, `server/mcpScopes.ts`, `server/keyGrants.ts`, `server/bin.ts`, `src/<mod>Route.ts`, `src/router.ts`, `src/App.tsx`, `src/appShellNavigation.ts`, `src/historyDialogs.ts`).

Gaps: `loop.ts` needs `toolChoice` (wave 46); there is no chart library (wave 47 adds tree-shaken ECharts with the SVG renderer, lazily, options built by Nook from a validated spec, never by the model); `api_key_grants` needs a rebuild for its CHECK words (050 does it); there is no general inbox notifier (failed scheduled refreshes show a badge; inbox notices deferred).

## Data model: migration 050 (`reports`)

`report_datasources` (name, kind `clickhouse`, url, username, password_ct sealed, database, allowlist_json, max_rows ≤ 100,000, timeout_s ≤ 120, enabled, schema sync status), `report_schema_tables` with the FTS5 `report_schema_fts` (names, comments, column names and comments; trigger-maintained), `reports` (owner, title, data source, doc server/tool/ref/hash, spec_json, status `draft|ready|stale|error`, `visibility` for wave 48, Bin columns), `report_doc_snapshots` (sha256, title, markdown ≤ 512 KiB), `report_queries` (key, sql, purpose, columns, created_by), `report_runs` (kind `generate|refresh|edit`, trigger `user|schedule|mcp`, agent_run_id, status `running|succeeded|partial|failed|abandoned`, query_keys_json, lease_until; a partial unique index allows one running run per report), `report_results` (per run and query: sql, **sent_sql**, columns, rows capped at 2 MiB, truncated, **rows_read**, bytes_read, **ch_query_id**, ms, error, error_code), `report_schedules` (cadence, at_time, weekday, tz, next_due_at, enabled, fail_count). `api_key_grants` is rebuilt with module `reports` and resource kind `report` added to whatever words it holds (a Messages rebuild that ran first keeps its words). `shared/reports.ts` holds the spec vocabulary and is **frozen after wave 45**.

## Wave 45 (shipped on branch `reports-w45`): data source, SQL guard, schema catalog, report skeleton

- `server/reports/clickhouse.ts`: HTTP POST through `egressFetch`, `JSONCompact`, Basic auth, query id `nook-<run>-<key>`, 8 MiB response cap; settings `readonly=2`, `max_execution_time`, `max_result_rows` with `result_overflow_mode=break`, `max_memory_usage=2e9`, `max_rows_to_read`/`max_bytes_to_read`, `max_threads=4`, `max_query_size`, `cancel_http_readonly_queries_on_client_close=1`.
- `server/reports/sqlGuard.ts` + `runner.ts`: one statement; select class (SELECT / WITH) and metadata class (SHOW DATABASES, SHOW TABLES, SHOW CREATE TABLE, DESCRIBE, EXISTS, EXPLAIN PLAN|SYNTAX|ESTIMATE, and selects reading only `system.tables|columns|parts|dictionaries|data_skipping_indices`); banned INTO/OUTFILE/INFILE/SETTINGS/FORMAT and external or unbounded functions; wrap `SELECT * FROM (\n…\n) LIMIT max+1`; `EXPLAIN QUERY TREE` checks every table and table function against the allowlist.
- `server/reports/datasources.ts`: admin CRUD, Test connection (version, user, profile readonly, write grants, warnings), the allowlist preview.
- `server/reports/schemaCatalog.ts`: bulk sync from `system.tables` + `system.columns` (two round trips, filtered to the allowlist), FTS search, list, describe with lazy miss, SHOW/DESCRIBE fallback, sync on save, Re-sync, daily from the sweeper; `tablesNamedIn` for wave 46's doc-first seeding.
- `server/reports/schemaTools.ts`: `search_schema`, `list_tables`, `describe_tables`, `sample_rows`, `run_schema_query`, `estimate` as plain server functions (wave 46 wraps them as agent tools).
- Reports home (list, title filter, create a draft with a title and a data source, Bin), the report page (guarded manual SQL console, results table, Schema browser sheet), Settings → Report data sources (admins), MCP `list_reports` and `list_report_datasources` under `reports:read`.

## Wave 46: doc fetch and generation agent (parallel with 47)

`server/reports/docSource.ts` (deterministic, before the LLM; auto-pick `fetch`/`get_document`/`read_document`, Outline convention, `DOC_FETCH` / `MCP_AUTH`; a snapshot only when the hash changes; "Doc changed — regenerate?"). `server/reports/generate.ts` with `runLoop`: the system prompt carries the ClickHouse dialect and guard limits, the doc as untrusted `<document>` (≤ 60 KB), and the tables the doc names (doc-first seeding); tools are wave 45's schema tools plus `run_sql {sql, purpose}` (columns and ≤ 20 sample rows, 16 KB, audited) and `submit_report(spec)` (≤ 12 queries, ≤ 20 blocks, ≤ 12 steps). `loop.ts` gets `toolChoice` to force `submit_report` last. `specValidate.ts`: parse, every queryKey resolves, every query passes the guard and runs, columns exist, y numeric; two retries; one persisting transaction. UI: `NewReportSheet.tsx`, `GenerateProgress.tsx` (SSE). Note for 46: `agent_runs.via` allows only `chat|api|mcp`; a generation run needs a new word (a later migration) or runs as `api`.

## Wave 47: viewer, refresh, scheduler (parallel with 46)

Viewer (`ReportView.tsx`, lazy `charts.tsx`, `chartOption.ts`, `KpiTile.tsx`, `ResultTable.tsx`; one column at 390 px, two from 768 px). The "How was this built" inspect sheet with Query (saved SQL, sent SQL, purpose, query id, timings, rows read and returned, truncated, error), Data (rows, CSV), Mapping (block spec, mapped columns, the ECharts option), and Provenance tabs; each tab a history step. `refresh.ts` (no LLM, 409 `RUN_IN_PROGRESS`, two queries at a time, `succeeded|partial|failed`, stale blocks keep their last good result, leases and best-effort `KILL QUERY`, abandoned at boot). `scheduler.ts` (CADENCES with time and zone, claim due schedules with `UPDATE…RETURNING`, at most two refreshes server-wide, `next_due_at` advances on failure, auto-off after 5 failures, owner access re-checked, last 20 runs kept). Per-block refresh shares the one-run lock. `ScheduleSheet.tsx`.

## Wave 48: instructions, MCP, sharing (migration 051)

Comments on the page or a block become `report_instructions` rows processed FIFO, one at a time per report, sharing the run lock; the edit agent (`server/reports/edit.ts`) submits a patch (`add_block`, `update_block`, `remove_block`, `move_block`, `add_query`, `update_query`, `remove_query`) validated like a spec; proposals are reviewed (or auto-applied) and applying writes a `report_versions` row and stamps provenance. MCP: `reports:read` adds `get_report`, `get_report_run`, `get_report_block`; `reports:write` gets `create_report`, `refresh_report`, `set_report_schedule`, `add_report_instruction`, `update_report_query` (guarded); writes audited with `via:"mcp"`; deletes only through the Bin; **never ad-hoc `run_sql` over MCP**. View-only sharing with the collections pattern.

## Decisions (D410–D423)

| ID | Decision |
| --- | --- |
| D410 | The module id is `reports` (label Reports, launcher `/reports`, routes `/reports` and `/reports/:id`); guests never have it (`features.reports`, routes 404). Migration 050 creates every table waves 45–47 use; 051 is reserved for wave 48. |
| D411 | The SQL guard refuses what it cannot read the way ClickHouse does: `#` comments, nested `/*`, heredocs and `$`, `{}` parameters, backslashes outside strings and any backslash inside a quoted name (review H2), non-ASCII outside strings and quoted names, control characters, and more than one statement. Banned anywhere in a select: INTO, OUTFILE, INFILE, SETTINGS, a FORMAT clause, EXPLAIN/SHOW/DESCRIBE as subqueries, and functions by exact name or prefix (`url`, `file`, `input`, `mysql`, `postgresql`, `jdbc`, `odbc`, `merge`, `loop`, `dictionary`, `format`, `generateRandom`, `hostName`, `getMacro`, `hasColumnInTable`, `s3*`, `remote*`, `cluster*`, `hdfs*`, `azure*`, `iceberg*`, `deltaLake*`, `hudi*`, `dict*`, `joinGet*`, `sleep*`, `filesystem*`, `mergeTree*`, `executable*`, …), whether named bare or quoted. The string function `format()` is refused with the table function of that name (use `concat`). |
| D412 | Selects run as `SELECT * FROM (\n<statement without comments>\n) LIMIT max+1`. Before running, `EXPLAIN QUERY TREE` of the statement is the authority on which tables, table functions, and functions it reads; it runs with `result_overflow_mode=throw`, a 20,000-row and 8 MiB cap, and reaching either refuses the query (review H1); a ClickHouse without the analyzer fails closed; its errors are generic when they name anything off the allowlist (review M2). The lexer also checks comma-joined tables and `[GLOBAL] [NOT] IN <table>`. SHOW CREATE needs TABLE (review M1). The metadata class reads the five allowed system tables through subqueries filtered with `match(database || '.' || table, <allowlist RE2>)`, so joins and aggregates never see another table; SHOW DATABASES and SHOW TABLES rows are filtered after the read. |
| D413 | Allowlists are databases or `db.table` globs (`*`, `?`), case-sensitive, at most 100; `system` and `information_schema` can never match (a database glob that could, such as `*`, is refused). |
| D414 | Every query carries the per-query settings above. A user whose profile has `readonly=1` refuses them, so Test connection warns that the profile needs `readonly=2`. |
| D415 | A data source password is sealed with `server/agents/secrets.ts` under AGENT_SECRETS_KEY (owner `datasource`, AAD bound to the row), write-only (`hasPassword` only), never in the URL, audit, or logs; `agent-admin.ts rotate-key` and the startup check include data sources. |
| D416 | The schema catalog keeps at most 20,000 allowlisted tables per data source (500 on the SHOW/DESCRIBE path) and re-filters every read by the current allowlist. FTS ranks table names (×10) over table comments (×3) over columns (×1), an exact `table` or `db.table` first; every query term is quoted, so FTS operators are words. |
| D417 | The schema tools are plain server functions in wave 45: `sample_rows` reads at most 5 rows with `max_rows_to_read=100000` and `read_overflow_mode=break`; `run_schema_query` runs the metadata class only, 200 rows; `estimate` is `EXPLAIN ESTIMATE` of a select. |
| D418 | Wave 45 reports are private to their owner (missing and forbidden are the same 404). Search is title-only (`/api/search?scope=reports`, the list's filter): SQL, results, and docs are warehouse data and never searched. |
| D419 | Reports use the Bin (type `report`, folder "Reports"); purging cascades to snapshots, queries, runs, results, and the schedule, and 050's trigger removes key grants naming the report. |
| D420 | MCP in wave 45 is `list_reports` and `list_report_datasources` (names and default database only) under `reports:read`; `reports:write` exists as the pair's write half with no tools until wave 48; no scope ever runs ad-hoc SQL; neither tool is offered to chat agents (`NOOK_NEVER_TOOLS`). |
| D421 | At most two guarded queries run at a time per person and eight per server (429 `BUSY`); the console is audited with the query id and the statement's SHA-256, never its text. |
| D423 | Review fixes: a data source's stored password is cleared when its URL's host changes (unless a new one comes with the change); SHOW rows are filtered before the row cap; the Schema browser routes count against the query limit; the console has Cancel (abort plus `KILL QUERY`); `report_runs.doc_snapshot_id` and `BlockProvenance.docSnapshotId` record the doc a run used. `agent_runs.via` gets its `reports` word in 051, since 039's table is released. |
| D422 | Settings → Report data sources is an admin section of the Settings hub (`/settings/datasources`); saving a data source with an allowlist starts a schema sync in the background. |

## Threats (T355–T366)

See `docs/plan/THREAT_MODEL.md` § Analytics reports. T355 guard bypass by lexer ambiguity, T356 SSRF and file reads through SQL, T357 SSRF through the data source URL, T358 ClickHouse resource exhaustion, T359 credential leak, T360 a key as an open SQL proxy, T361 cross-user disclosure, T362 metadata of tables off the allowlist, T363 writes through a writable user, T364 a stale catalog after the allowlist narrows, T365 the grants rebuild, T366 the later waves' threats (prompt-injection exfiltration, chart option injection, a scheduled run under a stale owner).

## Execution

45 → (46 ∥ 47 in separate worktrees, sharing only the frozen `shared/reports.ts`) → 48. One implementer and one fresh reviewer per wave; releases one at a time; merges into `main` only after the operator's OK. QA instances run from the worktree on their own `reports.localhost` port with a scratch data dir.

## Verification

Integration tests that need a real ClickHouse are gated on `CLICKHOUSE_TEST_URL` (`tests/reportsClickhouseLive.test.ts`). QA scenarios (per wave): Test connection warns for a writer; ~1000 tables sync in seconds and search finds the doc's tables; generate and refresh; "doc changed" banner; a malicious doc asking for `url()`/`s3()` is refused; an hourly schedule on a fake clock; ClickHouse killed mid-refresh gives `partial` with a stale badge; the inspect panel matches the chart; per-block and whole refresh; queued instructions and version restore; Back/Forward through every sheet at 390 px; the MCP key scope matrix.
