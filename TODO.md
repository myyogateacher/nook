# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site's [release notes](https://pankajsoni19.github.io/nook/releases.html), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md), [workspace modules](docs/plan/WORKSPACE_MODULES.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-11-16).**
- **v0.47.0** (2026-10-24) is the latest release. Everything since is in `CHANGELOG.md` under Unreleased: the seven workspace modules (Forms, Time, Goals, Standups, Contacts, Bookings, Townhall; the product owner answered the plan's §G questions and every wave shipped), the left navigation, task priority, @mentions, and the bake fixes.
- Migrations: **001–078** are released and immutable (045, 054, 067, 070, 071, 072, 075 unused; 054 reserved for Messages). **079–123** and **160** are in Unreleased code; parallel lanes take id blocks (160–164 is one), so check `server/migrations/` and `server/migrations/workspace/index.ts` before picking one.
- Development lands on `main` through pull requests, each after its gates pass.

## Leftovers (lane W3-WIRE, D1049)

- [ ] `scripts/workspaceAgentEval.ts` (scripted provider: log time from a summary, check in on a goal, update a deal, answer a standup, all as proposals) and its real-model run.
- [ ] A time-entry change hook for the Goals `time` source (it refreshes on reads and the 5-minute sweep today).
- [ ] Standup answer suggestions from the calendar (D936, deferred by D1194): the answer sheet suggests cards you finished, logged time on, or have due, and last round's plan, but not the day's events from your calendars (Time's "From your day" query, D890, could be shared).

## Waiting on the operator

- [ ] **Real-model check of chat agents on data sources** (lane AGENTSQL, D592): only the scripted provider has called the data tools. On a host with a working model, give an agent a data source (Settings → Report data sources → Chat agents may use this data source) and check that it searches before it queries, aggregates in SQL rather than paging raw rows, and summarizes instead of repeating the table.

- [ ] **Real-model eval of report generation** (D488 chart kinds, D489 parameters): only the scripted provider has run. Run `bun --no-env-file scripts/reportEval.ts --clickhouse <test ClickHouse>` on a host whose Nook has a working model provider (it falls back to Settings → AI; the local instance's OpenAI key is a placeholder), or set `REPORT_EVAL_*`, or regenerate reports on the VM (docs/OPERATIONS.md "Report generation eval"). Check: the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) get fitting chart kinds, and a doc that names a window or a dimension gets a date range or filter. Tune the prompts from the scores.

## Small fixes (lane SMALL)

- [ ] Inspect → "From the doc" (D518) needs the plan todo's `docRef` (`d2`); the scripted QA provider never sets it, so only a real model's runs show it. Check after the real-model eval.

## Leftovers (lane CLAUDE)

- [ ] Claude, checked only against a fake (lane CLAUDE, D539): on the VM, confirm Anthropic accepts `x-api-key` and `Authorization: Bearer` together on `/v1/chat/completions` and `/v1/models`, and Test tool calling reads "Tool calling works (auto)"; keys not scoped to a workspace also need `anthropic-workspace-id`, which Nook cannot send yet.

## Leftovers (lane FILT3)

- [ ] D567's plain `col BETWEEN {id_min} AND {id_max}`, already in agent-written reports, drops NULL and NaN rows even at Any (D675 proved it on 26.6); the prompts now show the guarded form, but stored reports keep theirs until regenerated or edited.
- [ ] **Show the block** (D674) was checked in headless Chrome (scrolls, focuses the block); try it with a screen reader and in a real phone browser.
- [ ] D679 only sees a date range written with a zone (`toDate(col, '<zone>')`). One added while the report's and the data source's zones agreed is written `toDate(col)`; if the schedule's zone later differs from the data source's, nothing flags it. Detecting it needs the column's zone (catalog type, or the source's `timezone()`) per condition.

## Leftovers (lane VIEWS2; plan in docs/plan/TASK_VIEWS.md)

- [ ] Cross-board swimlane rows (D665) are built from the loaded cards (200 a page), so a row's count is of loaded cards, not the whole match as lane counts are; a server row count (`rowCounts`, like `laneCounts`) would make them true.
- [ ] **Reorder pinned views…** (D667) is in a pinned view's ⋯, so a manager opens one pinned view first; the board's **View** picker could offer it from All cards too.
- [ ] On phones a swimlane page shows only the rows that have cards in that column, so its **+** reaches only those rows (New card covers the rest).

## Leftovers (lane LOCALEMB)

- [ ] Local embeddings (D544–D546) are checked against the real model only by the opt-in `LOCAL_EMBEDDINGS_MODEL_TEST=1 bun --no-env-file test tests/localEmbeddingsModel.test.ts` (and once in the image, by hand); the Docker verify stage has no model files. Run it on the VM after the 0.44.0 image lands, and index a real base there to see the CPU per passage on its cores.
- [ ] The English variant (bge-small-en-v1.5, D686) is checked against the real model by the same opt-in test (its English block, `LOCAL_EMBEDDINGS_ENGLISH_DIR`) for ranking, determinism, and windows, but against no independent reference vectors (no transformers.js or Python ONNX Runtime on the lane host); on the VM, build with `LOCAL_EMBEDDINGS_MODEL=all`, run the opt-in test in the image, and compare a few vectors with sentence-transformers' `BAAI/bge-small-en-v1.5` (CLS, normalized) to four decimals.


## Leftovers (lane BACKUP)

- [ ] Litestream and the S3 archive path are proven against the fake S3 only (tests/litestream.test.ts runs the real 0.5.17 binary when `LITESTREAM_TEST_BIN` is set). On the VM after the 0.45.0 image: set `BACKUP_TARGET`, `LITESTREAM_ENABLED=true`, check Settings → Backups reads "Replicating" with no sync errors, and run `restore-drill` and `restore-drill --from litestream` against the real bucket (R2/AWS: path-style, region `auto`, multipart, and `BACKUP_S3_SSE=required`).
- [ ] `BACKUP_S3_OBJECTS=copy` (D687) is proven against the fake S3 only (objects of a few MiB); on the VM, with a copy of the real bucket's size, time one run and the drill, and check the disk estimate against the archive's size.

## Watch (no work unless it shows up)
- Reports "Runs panel" client test failed once under full-suite load after lane CAP's rebase (passed alone, 40/40). If it recurs, give it a clock or CPU-time budget.

- Chat and agent-editor buttons the lint flags (a reply's Edit / Copy / Regenerate, the chat row, the Agents / Audit log / Settings links, the "Used N tools" toggle, the agent chip, Back and More at 390; the agent editor's emoji trigger, Save width, and Agents back link): **intentional existing design** (operator, 2026-10-22: screens built earlier stay exactly as they are). Not to be changed; add them to scripts/buttonLint.allow.json if the lint's screens ever open a chat.

- Settings → Report owners past 50,000 reports: "You can't open" counts every live report on its first page (166 ms at 200,000); a blocked co-owner of a third of all reports slows the unmanaged list (205 ms at 200,000). Fix then: count the readable set from its parts, or cache the count for a minute (D506).
- PDF worker memory: Bun 1.4.2 ignores Worker `resourceLimits` (D513); bounded by 16 MiB, 300 pages, 15 s, one at a time. Add a heap limit if Bun gains one.
- `tests/restV1.test.ts` parity flake: not reproduced since lane FTS bracketed the REST call with two MCP reads; if it recurs, the failing tool name pins the shared state.

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
  - The Docker verify image has no `docs/` and no `git`, so guard with `test.skipIf` / `Bun.which`. It does copy `scripts/` and `evals/`; a test that imports another repo folder needs that folder added to the Dockerfile's `verify` stage.
  - Run `docker build --target verify -t nook-verify-<lane> .` before a release (it must pass; remove the image after).
  - Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests, and `cpuTime.ts` for work budgets.
- **TODO.md.** Remove an item in the same commit that ships it.
- **Docs site (`site/`, GitHub Pages).** `index.html` is features first: a new app or module gets a section under "Using Nook" and a nav entry (`tests/docsSite.test.ts` checks every module); operator setup goes under Self-hosting or Operations.
- **Release notes on a release.** With the version bump: `CHANGELOG.md` gets the full entry and README's "What's new" its three bullets. On the docs site, add a `<section id="whats-new-X-Y-Z">` at the top of `site/releases.html` (and its link at the top of that page's "Release notes" nav), replace the `#whats-new` box on `site/index.html` with the same short notes (keep its "All release notes" link and id), and bump the `v…` badges, the footers, the "What's new in v…" nav entry, and the hero's "New in" pill. Upgrade steps go in `docs/OPERATIONS.md` and the Upgrading section. `bun --no-env-file test tests/docsSite.test.ts` checks that the two pages agree with `package.json`.
