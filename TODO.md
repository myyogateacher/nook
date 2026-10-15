# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-15).**
- **v0.42.0** is released (tag and GitHub release, 2026-10-15): PDFs as report docs and in `read_attachment_text`, `search_report_options`, Report owners paging. v0.41.0 brought PDF text in Files, `search_documents`, console parameters and Settings → Report owners.
- Migrations: **001–063** are released and immutable (045 and 054 unused; 054 is reserved for Messages). Next free: **064**.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] Report organization at scale ([plan](docs/plan/REPORTS_ORG.md), Tableau-style; replaces "readers' own placement"; the D460 `group_grants` fold becomes optional cleanup). Phases 1 and 2 shipped.
  - [ ] Phase 3 (064, optional): report Lists. A report can sit in many lists, and a list never grants access.

- [ ] Reports: measure chart-kind choice with a real model (left from the chart-kinds lane, D488): run `scripts/reportEval.ts` with `REPORT_EVAL_*` set on the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) and compare against a run with the shape line and the kind check off; only the scripted golden/trap runs were done.

- [ ] Reports parameters, left from lane PARAMS (D489, migration 063):
  - [ ] Measure parameter adoption with a real model (`scripts/reportEval.ts` with `REPORT_EVAL_*`): a doc that names a window or a dimension should get a date range or filter; only the scripted provider was run.

## Known LOW leftovers

- [ ] Settings → Report owners past 50,000 reports (lane REP2, D506): **You can't open** walks every live report for its count (42 ms of CPU at 50,000, 166 ms at 200,000; later pages 2 ms), and the unmanaged list's check for reports with no owner rows costs two index counts (about 5 ms at 50,000, 20 ms at 200,000). A blocked person who co-owns a third of all reports makes every unmanaged page check them (50 ms at 50,000, 205 ms at 200,000). If a deployment gets there: count the admin's readable set from its parts, or cache the count per list for a minute.
  - Forward back into the section reopens a report's Owners sheet titled "Report" when that report is past the first page (the title comes from the list, which loads its first page; the owners API has no title). Small: carry the title in the owners answer for admins, or look it up by id.

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
