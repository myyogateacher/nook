# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-08):** production runs **v0.34.0** (admin limits on knowledge-base embedding models and sizes). Released migrations are immutable: **001–044**.

## In flight

- [ ] **v0.35.0 — uploads everywhere + S3 storage.** On main: U0 foundation (migration 046), U1 calendar events, U2 task cards and comments, U3 collections, U4 notes and whiteboards, U5 chat images, U6 Files, U7 profile pictures, S3 storage. In progress: U8 conversion of hidden card/row attachments (migration 047), toasts via the Sonner package, Google re-auth fix (a Google round trip alone confirms; audit of every re-auth flow). Then a combined review and release check, the release, and a GitHub release (operator request, 2026-10-09).

## Known LOW leftovers

None open.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
