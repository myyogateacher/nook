# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-13):** production runs **v0.36.0** (attachment Undo, upload progress, admin avatar removal, app form messages). Released migrations are immutable: **001–048** (045 unused).

## In flight

- [ ] v0.37.0: the six v0.36.0 leftovers (three agents, 2026-10-13: test ports and timeouts; durable Undo records in migration 049 plus event Undo after Save; avatar caching plus the Team UI test). Then a short review and the release.

## Known LOW leftovers

- [ ] Several test files use fixed fake-provider ports (24xxx) that collide when lanes run tests in parallel (`agentsExternalFixes`, `agentsTools`, `agentsExternalReview`, `agentsExternal`, `agentsReview`, `knowledgeFixes`); give them per-run ports.
- [ ] Docker verify under host load: 5 s server-test timeouts flake (seen on "collection sharing > role matrix", "POST /api/tasks/query: access", `vaultCanary`); raise those timeouts or make them load-tolerant.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
