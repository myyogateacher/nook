# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-08):** production runs **v0.34.0** (admin limits on knowledge-base embedding models and sizes). Released migrations are immutable: **001–044**.

## In flight

- [ ] **v0.35.0 — uploads everywhere + S3 storage.** All features on main (U0–U8 with migrations 046 and 047, S3 storage, Sonner toasts, whiteboard thumbnails with pictures, Bin restore label + Undo, Google re-auth fix). In progress: combined security review and release QA (gates, S3 suite, upgrade from v0.34.0, scroll audit). Then the release and the GitHub release. Operator to try Take photo on a real phone (QA instance).

## Known LOW leftovers

None open.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
