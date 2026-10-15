# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-15).**
- **v0.39.0** is released (tag and GitHub release, 2026-10-15): report organization (favorites, filters, several owners, a shared folder tree), Files full-text search, and new accounts default to member.
- Migrations:
  - **001–062** are released and immutable (045 and 054 unused; 054 is reserved for Messages).
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] Report organization at scale ([plan](docs/plan/REPORTS_ORG.md), Tableau-style; replaces "readers' own placement"; the D460 `group_grants` fold becomes optional cleanup). Phases 1 and 2 shipped.
  - [ ] Phase 3 (064, optional): report Lists. A report can sit in many lists, and a list never grants access.

- [ ] (Lane CK) Reports: wider choice of chart kinds (requested 2026-10-15; generated reports come out mostly bar and line). The prompt already teaches 17 kinds and a routing table, but the model defaults to bar and line. Fixes:
  - Every `run_sql` result carries a deterministic **data-shape advisor**: it reads column types, row counts, ordered/date dimensions, stage-like values, a target column, a 0–1 or percent range, and from/to pairs, then suggests the fitting kinds ("this looks like a funnel / cohort matrix / distribution").
  - The planner records each todo's intent, and the chosen kind must match it.
  - A soft design check, sent once: if most blocks are bar/line but the shapes fit other kinds, the AI is asked to reconsider.
  - Eval cases for kind selection (funnel, cohort heatmap, attainment, distribution, flow).
- [ ] (Lane PARAMS) Reports: **interactive parameters** (requested 2026-10-15): a date range and filters on the report page that re-run the report.
  - Spec v3 `parameters`: a date range (presets and custom; the default comes from the doc, e.g. last 30 days), single or multi-select dimension filters whose options come from a guarded query (e.g. distinct `route`), and number and text inputs.
  - Queries reference parameters through ClickHouse's typed query parameters `{name:Type}`, which are bound server-side and never string-pasted. The guard and the EXPLAIN check must accept them.
  - The control bar sits at the top of the report. Values live in the URL, so Back/Forward and shared links keep them. Results are cached per parameter set. The default set is what refresh and schedules use.
  - Inspect shows the bound values and the SQL as sent.
  - The generation and edit agents add parameters when the doc names time windows or dimensions ("by route", "last 30 days"), and Changes can add them ("add a route filter").
  - MCP: `get_report` and `refresh_report` accept parameter values.
  - Mobile: the controls fold into a filter sheet.

## Known LOW leftovers

- [ ] Files: when only file text matches, the header reads "0 of 4 files". Count the text hits, or say "No names match" (v0.39.0 QA).
- [ ] Reports phone nav: the Favorites entry in the folder switcher shows an archive icon instead of a star (v0.39.0 QA).

- [ ] Report organization phase 2 leftovers (062 shipped): an admin can manage the owners of a report they cannot read only over REST/MCP (`/api/reports/:id/owners`, `add_report_owner`); a Settings view listing reports whose owners are all blocked or guests would let them find one in the UI (a block hands such reports to an admin today, so it only matters for data from before 062 or a guest demotion with no admin left). The folder-subtree list may walk `reports_live_recent` instead of `reports_folder` now that folders are shared; fine at 2,000 reports, worth a check past ~50,000. Deleting a report folder stays app-only (no MCP tool), as before.

- [ ] Files full-text index leftovers (lane FTS, 060 shipped): an MCP/REST `search_documents` tool on the index (files:read, ranked, snippets) so agents and keys get Files content search; a Back/Forward check at 390 px for a file opened from the notes search Files facet and from "In file text"; PDF text is not indexed because `read_document_text` reads text files only.
- [ ] `tests/restV1.test.ts` parity: not reproduced in two full runs (lane FTS). The only cross-module read tool for its key is `get_today`, which lists other people's items shared with everyone that earlier files' background work can change between the MCP and REST calls; the check now brackets the REST call with two MCP reads. If it recurs, the failing tool name pins the shared state.

## Standing rules for agent briefs

- **Agents and lanes.** Subagents run on Opus 5.5 at medium effort. One writer works on `main` at a time. Any parallel lane uses its own worktree, with pre-assigned ports and migration ids, and merges back promptly. Releases are serial.
- **Visual QA.**
  - UI changes need screenshots at 1585, 1280, and 390 px, which the director reviews for squished or clipped buttons, overlaps, and wasted width.
  - A shared-style change must keep screens outside its module identical. Check with `scripts/buttonMetrics.ts` (diff plus lint).
- **Processes.** Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- **Scratch files.** Each agent keeps its scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`). Never delete or reuse another lane's files.
- **Browser QA.** Use your own `<lane>.localhost:<port>` origin and your own tab or profile, because the session cookie is shared across localhost ports.
- **Tests.**
  - Run with `bun --no-env-file test`.
  - Tests that spawn `bun` use `--no-env-file`.
  - The Docker verify image has no `docs/` and no `git`, so guard with `test.skipIf` / `Bun.which`.
  - Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests, and `cpuTime.ts` for work budgets.
- **TODO.md.** Remove an item in the same commit that ships it.
