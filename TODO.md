# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-15).**
- **v0.41.0** is released (tag and GitHub release, 2026-10-15): PDF text in the Files index, `search_documents`, console parameters, option search, Settings → Report owners. v0.40.0 brought interactive report parameters.
- Migrations: **001–063** are released and immutable (045 and 054 unused; 054 is reserved for Messages). Next free: **064**.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] Report organization at scale ([plan](docs/plan/REPORTS_ORG.md), Tableau-style; replaces "readers' own placement"; the D460 `group_grants` fold becomes optional cleanup). Phases 1 and 2 shipped.
  - [ ] Phase 3 (064, optional): report Lists. A report can sit in many lists, and a list never grants access.

- [ ] Reports: measure chart-kind choice with a real model (left from the chart-kinds lane, D488): run `scripts/reportEval.ts` with `REPORT_EVAL_*` set on the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) and compare against a run with the shape line and the kind check off; only the scripted golden/trap runs were done.

- [ ] Reports parameters, left from lane PARAMS (D489, migration 063):
  - [ ] Measure parameter adoption with a real model (`scripts/reportEval.ts` with `REPORT_EVAL_*`): a doc that names a window or a dimension should get a date range or filter; only the scripted provider was run.

## Known LOW leftovers

- [ ] Report option search (D491) has no MCP tool: an agent passing a select value past the first 200 to `get_report`/`refresh_report` must already know it (the run checks it against ClickHouse); a `search_report_options` tool would let it look one up.

- [ ] Settings → Report owners leftover (lane ORG, D500):
  - [ ] Each list shows the 200 most recently changed (a title search finds the rest); no paging. Both lists check every live report (admins only; not measured past a few hundred); measure at 50,000 and page by cursor if needed.

- [ ] PDF text leftovers (lanes FILES and PDF, D496, D510–D514):
  - [ ] The PDF worker has no heap cap: Bun 1.4.2 ignores Worker `resourceLimits` (D513). It runs `smol`, bounded by 16 MiB, 300 pages, 15 s, one at a time. Set a heap limit if Bun gains one.
  - [ ] Before the Files index's first backfill after boot, "Pick from Nook" matches PDFs by name only and can offer a scan (picking it gives the "no text layer" error); the indexed search never does (D512).
  - Recorded non-goal: OCR for scanned PDFs (D514). Every usable engine is native (tesseract) or a large WASM bundle with language data; a scan says "no text layer (scanned?)" instead.
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
