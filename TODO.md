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

- [ ] Report organization at scale ([plan](docs/plan/REPORTS_ORG.md), Tableau-style; replaces "readers' own placement"; the D460 `group_grants` fold becomes optional cleanup). Phase 2 follows the operator's simple model; all its questions are settled.
  - [ ] (Lane P2) Phase 2 (062): simple permissions (operator decision, 2026-10-15). Folders are only for grouping and never grant access. A report can have several owners, and an owner or an admin can make others owners. An owner can change the report's folder, its sharing and its other permissions. A report always keeps at least one owner. Folders are one workspace-wide tree. Any member can create a folder; only admins can rename, move, reorder or delete one.
  - [ ] Phase 3 (064, optional): report Lists. A report can sit in many lists, and a list never grants access.

## Known LOW leftovers

- [ ] Files full-text index leftovers (lane FTS, 060 shipped): an MCP/REST `search_documents` tool on the index (files:read, ranked, snippets) so agents and keys get Files content search; a Back/Forward check at 390 px for a file opened from the notes search Files facet and from "In file text"; PDF text is not indexed because `read_document_text` reads text files only.
- [ ] `tests/restV1.test.ts` parity: not reproduced in two full runs (lane FTS). The only cross-module read tool for its key is `get_today`, which lists other people's items shared with everyone that earlier files' background work can change between the MCP and REST calls; the check now brackets the REST call with two MCP reads. If it recurs, the failing tool name pins the shared state.

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
