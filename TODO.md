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
  - [ ] (Lane R, prep on branch `release-0.38.0`; merge, tag and deploy wait for approval) Release: version bump, CHANGELOG, a real-ClickHouse QA pass (`CLICKHOUSE_TEST_URL`, local `clickhouse/clickhouse-server:26.6`), the upgrade notes for 050–057 in OPERATIONS.
- [ ] (Lane E, approved 2026-10-14) Generator reliability, in order: E1 an eval harness (docs, seeded real ClickHouse data, expected numbers, `--compare`); E2 sanity checks on results; E3 repair hints for ClickHouse errors; E4 a metric catalog from the doc; E5 an optional model fallback. Original proposal: an eval set of docs, fixture data and expected numbers; a metric catalog extracted from the doc; sanity checks on results (join fan-out, totals that reconcile, coverage, units); repair hints for ClickHouse errors; a model fallback.
- [ ] Report shares live in `report_members`/`report_group_shares` (D460). Fold them into `group_grants` (resource kind `report`) at its next CHECK rebuild, with the Access sheet.
- [ ] (UI fix, in progress) Two problems that predate this thread: the Settings page title (e.g. "AI") shows the yellow focus ring after navigation, on every Settings section; and in Settings → AI → Model providers the DEFAULT badge sits under the provider name instead of beside it.
- [ ] (Lane F) Reports test gap: a click test that Inspect → "Open in console" fills in the block's SQL (today the test only checks that the button renders).
- [ ] (Lane F) Tool-server sync stores `readOnlyHint: false` the same as "not annotated", so the reports browse list hides write tools by `destructiveHint` and name only. Store the raw hint at sync (`server/agents/toolServers.ts`) and use it in `isReadLikeTool`.
- [ ] (Lane F) Wave 45 leftovers: `format()` the string function is refused along with the table function; tree-check errors that name a qualified column (`t.col`) are shown generically.
- [ ] (Lane H) App-wide sheets: Forward does not reopen a second-level sheet (one reopen slot in `useHistoryDialogGuard`, D18).

## Known LOW leftovers

- [x] Button lint baseline accepted for pre-reports screens; new findings fail QA.
- [ ] (Lane F) Lane B: when the reports doc-servers listing calls `ensureSynced` (C1), `tests/docSource.test.ts` must keep its server never-synced on a name that resolves fast (or give it `tools_synced_at`), or the lazy sync waits on DNS for `docs.example.test`.
- [ ] Doc browsing (B3): only page reads (`fetch`, `get_document`, `read_document`, `get_page`, `read_note`, `read_document_text`) are kept as pages; search and list answers are not, so "Doc changed" cannot notice a new page a search would now find. Check doc reads at most 16 pages.
- [ ] "Pick from Nook" (B4) finds Files by name only (`GET /api/files`, the newest 500); there is no full-text search over Files text documents yet.
- [ ] (Lane G) Several test files use fixed fake-provider ports (24xxx) that collide when lanes run tests in parallel (`agentsExternalFixes`, `agentsTools`, `agentsExternalReview`, `agentsExternal`, `agentsReview`, `knowledgeFixes`); give them per-run ports.
- [ ] (Lane G) Docker verify under host load: 5 s server-test timeouts flake (seen on "collection sharing > role matrix", "POST /api/tasks/query: access", `vaultCanary`); raise those timeouts or make them load-tolerant.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort. One writer works on `main` at a time; any parallel lane uses its own worktree with pre-assigned ports and migration ids and merges back promptly. Releases are serial.
- UI changes need screenshots at 1585, 1280, and 390 px that the director reviews for squished or clipped buttons, overlaps, and wasted width. A shared-style change must keep screens outside its module identical: check with `scripts/buttonMetrics.ts`.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
