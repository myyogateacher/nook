# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-08):** production runs **v0.34.0** (admin limits on knowledge-base embedding models and sizes). Released migrations are immutable: **001–044**.

## In flight

- [ ] **v0.35.0 — uploads everywhere + S3 storage.** On main: U0–U8 (migrations 046, 047), S3 storage, toasts via the Sonner package. In progress: Google re-auth fix (Google alone confirms, except two-factor actions, which also need the TOTP or a recovery code; audit of every re-auth flow), Bin restore label + Undo on every move to the Bin, whiteboard thumbnails with pictures. Then a combined review and release check, the release, and a GitHub release (operator request, 2026-10-09). Operator to try Take photo on a real phone (QA instance) before or after release.

## Known LOW leftovers

None open.

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
