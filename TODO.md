# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-13):** production runs **v0.37.0** (durable attachment Undo, event Undo after Save, avatar revalidation). Released migrations are immutable: **001–049** (045 unused).

## In flight

- [ ] Analytics reports ([plan](docs/plan/WAVES_45-48_REPORTS.md)): waves 45, 46 (doc fetch, generation; migration 051) and 47 (viewer, refresh, scheduler) integrated on `reports-integration` with v0.37.0 merged in; needs QA with a real ClickHouse via `CLICKHOUSE_TEST_URL`. Then wave 48 (instructions, MCP, sharing; migration 052 reserved; the Messages module takes 053).
  - [ ] Wave 45 leftovers: `format()` the string function is refused with the table function; tree-check errors that name a qualified column (`t.col`) are shown generically.
- [ ] The stopped `test-infra` agent's partial work (fixed test ports, load-tolerant timeouts) is unmerged on its branch.

## Known LOW leftovers

- [ ] Several test files use fixed fake-provider ports (24xxx) that collide when lanes run tests in parallel (`agentsExternalFixes`, `agentsTools`, `agentsExternalReview`, `agentsExternal`, `agentsReview`, `knowledgeFixes`); give them per-run ports.
- [ ] Docker verify under host load: 5 s server-test timeouts flake (seen on "collection sharing > role matrix", "POST /api/tasks/query: access", `vaultCanary`); raise those timeouts or make them load-tolerant.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
