# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-15).**
- **v0.38.0** is released (tag and GitHub release on 2026-10-15). It adds the analytics reports module.
- Migrations:
  - **001–059** are released and immutable (045 and 054 unused; 054 is reserved for Messages).
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] (Lane FTS) Files full-text index (migration 060, approved 2026-10-15): a `document_fts` index over Files text and Markdown documents, so "Pick from Nook" (K4, today a bounded scan of `GET /api/reports/nook-files`) and Files search become one ranked query, with access exactly as `read_document_text`.
- [ ] (Lane P1) Forward after Back past a page (D480) does not reopen Inspect yet, because it has no `layerKey` or `useLayerOpener`. v0.38.0 is out, so this can be done now.
- [ ] Report organization at scale ([plan](docs/plan/REPORTS_ORG.md), Tableau-style; replaces "readers' own placement"; the D460 `group_grants` fold becomes optional cleanup). Phase 2 follows the operator's simple model; all its questions are settled.
  - [ ] (Lane P1) Phase 1 (061): favorites (★, a Favorites nav entry), filters (owner, status, data source, schedule), search and keyset pagination for hundreds of reports, MCP star tools.
  - [ ] Phase 2 (062): simple permissions (operator decision, 2026-10-15). Folders are only for grouping and never grant access. A report can have several owners, and an owner or an admin can make others owners. An owner can change the report's folder, its sharing and its other permissions. A report always keeps at least one owner. Folders are one workspace-wide tree. Any member can create a folder; only admins can rename, move, reorder or delete one.
  - [ ] Phase 3 (064, optional): report Lists. A report can sit in many lists, and a list never grants access.

## Known LOW leftovers

- [ ] (Lane FTS) `tests/inboxApp.test.tsx` "Inbox copy" fails late in the evening IST (seen 23:25 on 2026-10-14: `expiresText` of now + 13.5 days read "expires in 13 days"). It is probably a local-midnight boundary in the day count, not the rounding the test means to check.
- [ ] (Lane FTS) `tests/reportsScheduler.test.ts` "at most two scheduled refreshes run at once" failed once in a full-suite run (lane L, 2026-10-14) and passes on its own (3/3). It is probably timing under load.
- [ ] (Lane FTS) Lane worktrees without `node_modules` cannot run the `vite build` gate: the Excalidraw fonts copy reads `node_modules/…/fonts` relative to the working directory, so the build fails at writeBundle after emitting `dist`. Lane L was not allowed to install or link `node_modules` in its worktree.
- [ ] (Lane FTS) `tests/restV1.test.ts` "agents" fails in some full-suite runs but passes on its own (7/7) and in lane G's six proof runs. It is probably order-dependent shared state: agents, providers, or keys left behind by an earlier file.

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
