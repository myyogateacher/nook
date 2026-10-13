# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-08):** production runs **v0.34.0** (admin limits on knowledge-base embedding models and sizes). Released migrations are immutable: **001–044**.

## In flight

- [ ] **v0.35.0 — uploads everywhere + S3 storage.** All features on main (f42081e). Review and QA done; release blocked on fixes (both agents stopped at the usage limit on 2026-10-12; resume them or relaunch from their briefs): (1) branch `v035-fixes`: review MEDIUM 1 (editor-planted file refs in notes link on owner publish, plus the boot backfill), MEDIUM 2 (notes-only MCP key reads and shares any file; calendar/tasks MCP re-link), LOW restore unlinked attachment into Attachments, LOW sweep race and cost; migration 048 if needed. (2) branch `v035-client-fixes`: HIGH Files CSS order in the production build (binUndo chunk CSS before index CSS), HIGH multi-file paste or drop into a note keeps only the last, LOWs (picker folder name, Bin restore toast type, stale /files URL after binning, pinned footer in event editor at 390, native validation bubble on New API key), finish the scroll audit (Team, Vault, Collections, Settings). Then release, deploy, GitHub release. Operator to try Take photo on a real phone (QA instance).

## Known LOW leftovers

None open.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
