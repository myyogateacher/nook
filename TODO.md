# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-13):** production runs **v0.35.0** (uploads everywhere, optional S3 storage, profile pictures, Sonner toasts with Undo, Google re-auth fix). Released migrations are immutable: **001–048** (045 unused).

## In flight

Nothing. Next cycle to be chosen by the operator.

## Known LOW leftovers

- [ ] Operator: try Take photo on a real iOS/Android phone (event, card, profile picture).
- [ ] Security forms in `src/App.tsx` (two-factor off, regenerate recovery codes) still use native `required`; switch to `noValidate` with app messages like the key forms.
- [ ] Scroll audit not covered: Google/TOTP re-auth dialogs, Vault protect/history/transfer, Collections row panel, Calendar/Vault/Collections dialogs at 1280.
- [ ] Undo for removing an attachment (needs restore and re-link into Attachments).
- [ ] Note uploads show progress as toasts, not a progress row; leaving a note mid-upload aborts without asking.
- [ ] Whiteboard "Save as copy" thumbnail is drawn without pictures.
- [ ] Admins cannot remove someone else's profile picture; others see a new picture only after reload.
- [ ] Google re-auth not yet tried against real Google (production runs `AUTH_METHODS=password`).

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Each agent keeps scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`); never delete or reuse another lane's files.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
