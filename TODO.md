# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-14):** production runs **v0.37.0** (durable attachment Undo, event Undo after Save, avatar revalidation). Released migrations are immutable: **001–049** (045 unused). `main` is ahead of v0.37.0 with the analytics reports module (unreleased migrations **050–053, 055**; 054 is reserved for Messages, 056 for doc browsing). Development now happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] Analytics reports ([plan](docs/plan/WAVES_45-48_REPORTS.md), [theme](docs/plan/REPORT_THEME.md)). On `main`:
  - Waves 45–48b.
  - Chart kinds round 2.
  - Structured logs (`LOG_LEVEL`, `LOG_FORMAT`).
  - The guard reads ClickHouse 26.6 query trees (FINAL).
  - Runs history.
  - Long docs and the planner (055).
  - Auto titles.
  - Wider panels and dialogs; Share copies the link; the SQL console moves to ⋯ and Inspect → "Open in console" (an empty report keeps it, with "Generate from a doc" and "Ask for a chart").

  Next on `main`. Three parallel lanes each push to `main` when their gates pass. Lane A works in the main checkout; lanes B and C work in their own worktrees.
  - [ ] (B) "From a doc": a clear reason when it is unavailable; quieter polling logs (2xx GET polls at debug).
  - [ ] (B) The doc tool picker explains Tool and "Link goes into"; it says why a tool is excluded (unsynced, or a policy that is not Auto), with an admin "Allow automatically"; New report dialog layout fixes.
  - [ ] (C) Tool servers sync on add and on connection changes, again daily, and lazily on first use.
  - [ ] (B) The AI may browse docs with the read-only tools the user ticks (056): a snapshot for each page, and "Doc changed" covers linked pages.
  - [ ] (B) Nook as a built-in doc source: notes and Files by link or picker, read with the owner's access.
  - [ ] (C) Agents get Nook's tools through an auto-provisioned internal key: read scopes plus `inbox:write`, proposals only. Admin toggle and per-agent toggle; migration 057 if needed.
  - [ ] (C) Button lint in `scripts/buttonMetrics.ts`. It flags overflowing, wrapped or clipped labels, side padding under 12 px, targets under 44 px on phones, and text buttons under 64 px wide.
  - [ ] (A) The live step log grouped under its plan todos.
  - [ ] Release: version bump, CHANGELOG, a real-ClickHouse QA pass (`CLICKHOUSE_TEST_URL`, local `clickhouse/clickhouse-server:26.6`), the upgrade notes for 050–055 in OPERATIONS.
- [ ] Generator reliability, proposed and not started: an eval set of docs, fixture data and expected numbers; a metric catalog extracted from the doc; sanity checks on results (join fan-out, totals that reconcile, coverage, units); repair hints for ClickHouse errors; a model fallback.
- [ ] Report shares live in `report_members`/`report_group_shares` (D460). Fold them into `group_grants` (resource kind `report`) at its next CHECK rebuild, with the Access sheet.
- [ ] Wave 45 leftovers: `format()` the string function is refused along with the table function; tree-check errors that name a qualified column (`t.col`) are shown generically.
- [ ] App-wide sheets: Forward does not reopen a second-level sheet (one reopen slot in `useHistoryDialogGuard`, D18).
- [ ] The stopped `test-infra` agent's partial work (fixed test ports, load-tolerant timeouts) is unmerged on its branch.

## Known LOW leftovers

- [ ] Several test files use fixed fake-provider ports (24xxx) that collide when lanes run tests in parallel (`agentsExternalFixes`, `agentsTools`, `agentsExternalReview`, `agentsExternal`, `agentsReview`, `knowledgeFixes`); give them per-run ports.
- [ ] Docker verify under host load: 5 s server-test timeouts flake (seen on "collection sharing > role matrix", "POST /api/tasks/query: access", `vaultCanary`); raise those timeouts or make them load-tolerant.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort. One writer works on `main` at a time; any parallel lane uses its own worktree with pre-assigned ports and migration ids and merges back promptly. Releases are serial.
- UI changes need screenshots at 1585, 1280, and 390 px that the director reviews for squished or clipped buttons, overlaps, and wasted width. A shared-style change must keep screens outside its module identical: check with `scripts/buttonMetrics.ts`.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
