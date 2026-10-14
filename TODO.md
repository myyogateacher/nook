# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-14):** production runs **v0.37.0** (durable attachment Undo, event Undo after Save, avatar revalidation). Released migrations are immutable: **001–049** (045 unused). `main` is ahead of v0.37.0 with the analytics reports module (unreleased migrations **050–053, 055–057**; 054 is reserved for Messages). Development now happens directly on `main`, pushed as each change passes its gates.

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
  - "From a doc" says why it is unavailable; polled GETs log at debug.
  - The live step log and Runs group each step under its plan todo.
  - The doc tool picker explains Tool and "Link goes into" and why a tool is excluded (admins: "Allow … automatically"); the New report sheet scrolls under a bordered footer.
  - The AI may browse docs with the read-only tools the person ticks (056): a snapshot for each linked page, "Doc changed" names a linked page, ⋯ → Doc settings, and Provenance lists the pages.
  - Nook as a built-in doc source (056's `doc_source`): notes and Files text documents by link (every route shape, any instance origin) or "Pick from Nook", read with the owner's live access; a pasted link selects its source.

  - Agents and tool servers: tool servers sync on save, daily, and on first use. Agents get Nook's tools through an internal key (057; read scopes plus Inbox proposals; admin toggle and per-agent toggle).
  - Button lint (`scripts/buttonMetrics.ts lint`); the baseline is accepted for screens built before reports.

  Open:
  - [ ] (Lane R: READY on branch `release-0.38.0`, QA passed on real ClickHouse 26.6, 6 QA bugs fixed; WAITING for the operator to approve merge, tag and deploy) Release: version bump, CHANGELOG, a real-ClickHouse QA pass (`CLICKHOUSE_TEST_URL`, local `clickhouse/clickhouse-server:26.6`), the upgrade notes for 050–057 in OPERATIONS.
- [ ] Report folders, left from lane I: drag a folder in the nav to nest or reorder it (the server takes `parentId` and `position`; Notes has no folder drag to copy, so only rename/new subfolder/delete are in the ⋯ menu); a reader's own placement of reports shared with them (they stay under Shared with me); "From a doc" files the new report with a second request after generation starts (it stays Unfiled if that fails, with a warning).
- [ ] (Lane E, approved 2026-10-14) Generator reliability: reports that are well formed can still be wrong.
  - [x] E1 eval harness: `scripts/reportEval.ts` and 10 cases in `evals/reports/cases/` (FINAL and soft deletes, refund dates, IST days, join fan-out, funnel, percent as 0–1, linked-page metric, top route, cents, duplicate deliveries); scripted golden and trap specs; a CI subset replayed from recorded fixtures; `--compare`; OPERATIONS "Report generation eval".
  - [x] E2 result sanity checks (`server/reports/sanity.ts`): join fan-out (guarded key sample), KPI/breakdown reconciliation, coverage, units; one refusal per run, not a try; Runs step and audit `reports.generate.sanity`. The edit agent and manual edits do not run them yet.
  - [x] E3 ClickHouse error repair hints (`server/reports/repairHints.ts`): closest catalog names, casts, HAVING, GROUP BY, partition and sorting keys for limits, FINAL from the catalog engine; tested on captured 26.6 error texts.
  - [x] E4 metric catalog (058 `report_metric_catalogs`): extracted per doc snapshot with a forced tool, checked (table, FINAL, LIMIT 0), owner-editable versions in ⋯ → Metrics, todos carry `metricId`, SQL must use the metric's expression and filters, Doc changed names changed metrics.
  - [ ] E4 leftovers: metric definitions that live only on a linked doc page are not extracted; the catalog is not offered as an MCP tool; the edit agent is not checked against the catalog on submit (only told it in its prompt).
  - [x] E5 model fallback: Settings → AI "Fallback model for reports" (off by default); one retry on it after the report model used up its tries or nudges; block provenance records the model (Inspect → Provenance), Runs shows the model that ran last.
  - [ ] E5 leftovers: the edit agent has no fallback and does not stamp the model on the blocks it changes; Runs shows one model per run (the fallback's after a retry), not both.
- [ ] Forward after Back past a page (D480) does not yet reopen Inspect: it has no `layerKey`/`useLayerOpener` yet; it follows once v0.38.0 merges with its reopen. (The sheets inside Versions have theirs: lane J2.)
- [ ] Report shares live in `report_members`/`report_group_shares` (D460). Fold them into `group_grants` (resource kind `report`) at its next CHECK rebuild, with the Access sheet.
- [x] (Lane E, small) `server/reports/edit.ts`'s prompt still says "Use concat, not format()"; the string function `format()` is allowed now (only the table function is refused), so drop that sentence when next touching the file.

## Known LOW leftovers

- [x] Button lint baseline accepted for pre-reports screens; new findings fail QA.
- [ ] Doc browsing (B3): only page reads (`fetch`, `get_document`, `read_document`, `get_page`, `read_note`, `read_document_text`) are kept as pages; search and list answers are not, so "Doc changed" cannot notice a new page a search would now find. Check doc reads at most 16 pages.
- [ ] "Pick from Nook" (B4) finds Files by name only (`GET /api/files`, the newest 500); there is no full-text search over Files text documents yet.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort. One writer works on `main` at a time; any parallel lane uses its own worktree with pre-assigned ports and migration ids and merges back promptly. Releases are serial.
- UI changes need screenshots at 1585, 1280, and 390 px that the director reviews for squished or clipped buttons, overlaps, and wasted width. A shared-style change must keep screens outside its module identical: check with `scripts/buttonMetrics.ts`.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
