# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-14).**
- Production runs **v0.37.0**.
- `main` carries the analytics reports module and is being released as **v0.38.0**.
- Migrations:
  - **001–049** are released and immutable (045 unused).
  - **050–053 and 055–059** are new in v0.38.0.
  - **054** is reserved for Messages.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] Release v0.38.0. Update the `release-0.38.0` branch to current `main`, extend CHANGELOG and the upgrade notes to cover 058–059, run the gates, then merge, tag, push, publish the GitHub release, and rebuild the local Docker image.
- [ ] (Lane K) "Pick from Nook" (B4): search the text of Files documents, not only their names (`GET /api/files`, newest 500).
- [ ] Metric catalog: Check doc does not re-extract the catalog when a linked page changes. It names the changed page, not the changed metrics. A non-Nook doc server's linked pages reach the catalog only after a run has read them.
- [ ] Forward after Back past a page (D480) does not reopen Inspect yet, because it has no `layerKey` or `useLayerOpener`. Do this after v0.38.0 merges, since that release adds Inspect's reopen.
- [ ] Versions: after Back from a version's read-only view, Forward does not reopen it (found in v0.38.0 QA; D480 `layerKey` for the view).
- [ ] Report folders: a reader's own placement of reports shared with them. Today they stay under Shared with me.
- [ ] Report shares live in `report_members` and `report_group_shares` (D460). Fold them into `group_grants` (resource kind `report`) at its next CHECK rebuild, together with the Access sheet.

## Known LOW leftovers

- [ ] `tests/restV1.test.ts` "agents" fails in some full-suite runs but passes on its own (7/7) and in lane G's six proof runs. It is probably order-dependent shared state: agents, providers, or keys left behind by an earlier file.

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
  - The Docker verify image has no `docs/` and no `git`, so guard with `test.skipIf` / `Bun.which`.
  - Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests, and `cpuTime.ts` for work budgets.
- **TODO.md.** Remove an item in the same commit that ships it.
