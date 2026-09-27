# Nook implementation tracker

## Workspace apps roadmap (Home, Files, shared Bin)

Implementation plan: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) · [API contracts](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md)

### Wave 1 — Mobile notes navigation (released v0.2.2, deployed at `0efb975`)

- [x] Mobile browser Back/Forward between folders, note list, and editor
- [x] Clean up empty new notes during mobile Back
- [x] Version bump and deploy (running container reports `APP_VERSION=0.2.2`, `GIT_SHA=0efb975`)

### Wave 2 — Authenticated Home app selector (released v0.2.3, deployed at `6bfe982`)

- [x] Home with separate Notes and Files apps plus shared Bin cards; placeholders for Files/Bin (`cb59b6a`)
- [x] Independent review of `cb59b6a` against the DEVELOPMENT_PLAN §4 checklist (2026-09-25)
  - [x] G2.1 (blocking gate) — **confirmed gap, fixed** in `7a8319d` and `963f9aa`. Before the fix, the brand button and mobile Back to Home did not publish a changed draft (only the 900 ms autosave ran, and its errors were invisible on Home) and left blank new notes behind. Leaving Notes now runs the shared `finalizeOpenNote` sequence also used by note/folder switches: remove a blank never-published note, otherwise save and publish the changed draft. The note stays selected and is reloaded after publishing (a deliberate deviation from `publish(false)`: without the reload, the stale draft revision made the next save or switch fail with 409). On failure, Notes stays open with a toast and the draft kept; on mobile, the Notes history entry is pushed back. The editor is read-only while leaving. Browser QA on isolated data passed on desktop and at 390 px.
  - [x] G2.2 (blocking gate) — **confirmed gap, fixed** in `611bf88`. Home and the Files/Bin placeholders now have an Account group (Settings, Sign out) that drives the single App-owned settings dialog, scrim, and toast. `TOTP_POLICY=required` users without a factor still bypass Home and get Settings forced open (verified against an isolated server).
  - [x] Popstate routing: history entries without an app-shell section now resolve to Notes. Back/Forward across Home ⇄ Notes (folders/list/editor) ⇄ Files/Bin works with no trap (verified at 390 px).
  - [x] Reload lands on Home; Notes still resumes its last folder and note — intended, no issue.
  - [x] Desktop pushes no history for app switches (D18) — confirmed, no issue.
  - [x] Accessibility: cards and account actions are buttons with accessible names and the global focus ring; mobile account actions are 40 px icon buttons with visually hidden labels; reduced motion is honored — no issue.
  - [x] "Coming next / Preview" copy accepted for v0.2.3.
  - [x] Tests added: `tests/noteFinalization.test.ts`, `tests/appShell.test.tsx`, legacy-entry cases in `tests/appShellNavigation.test.ts`.
  - Accepted low risks (not blocking): the settings scrim closes without the one-time MCP key confirmation (pre-existing in Notes, now also on Home); a Back/Forward pressed during an in-flight leave can leave history one entry out of step; clicking the brand button while a note switch is already running does nothing; Sign out from the Notes sidebar still cancels a pending autosave (pre-existing).
- [x] Fix confirmed findings (`7a8319d`, `611bf88`, `963f9aa`)
- [x] Second independent review of `cb59b6a..bd754d4` plus recovery QA (2026-09-25, fresh session)
  - [x] **Medium, fixed** in `921fe28`: Tiptap `setEditable` emits an update by default, so mounting or locking the editor reported normalised Markdown as a user change. Reproduced on an isolated instance: a note authored through the API with `* item` bullets gained a draft on open and an unwanted version on leaving for Home. Fixed with `emitUpdate=false`; re-verified (version 1 and no draft after open + leave; a typed edit still publishes version 2).
  - [x] **Medium/low, fixed** in `921fe28`: Publish, Discard, Delete, and the mobile actions menu are disabled while the leave finalization runs.
  - [x] Verified on isolated desktop QA: leaving Notes publishes a new note (v1), publishes an edit of a published note (v2), and removes a blank new note; Settings opens and closes from Home and the Files placeholder; Sign out is present on Home, Files, and Bin.
  - [x] Verified at 390 px: Home → Notes folders → list → editor, then Back unwinds editor → list → folders → Home (publishing the edit on the way, v3), Forward re-enters Notes, Back from Home leaves to the previous history entry; Files placeholder pushes one entry and Back returns Home. No loops.
  - Accepted low risks (not blocking, recorded by the reviewer): a failed reload after a successful publish shows a "could not save" toast; a lasting 409 blocks leaving Notes until reload (same as note switches); history can drift by one entry during a concurrent leave/restore.
  - Gates: `bun run typecheck`, `bun test` (25 pass), `git diff --check`, tracked-file secret/personal-data scan, `docker build --target verify`, `docker compose build` all pass at `921fe28`.
- [x] Released v0.2.3: bump `6bfe982`, pushed to `origin/main`, deployed with Docker Compose; container healthy on port 2026 and `/api/about` reports `0.2.3` / `6bfe9827ae29e3c6707f9c0c413d95f591baea0d` (2026-09-25)

### Wave 2b — URL routing for every app, view, and item (released v0.2.4, deployed at `4b8bf3e`)

Operator request (2026-09-25): every module, page, note, file, and view gets its own URL instead of everything living at `/`. Shipped before the Bin and Files UIs so they are built on real routes. See DEVELOPMENT_PLAN §4b.

- [x] Route table and client router (`src/router.ts`, `dbdf321`): `/` Home, `/notes`, `/notes/folder/:folderId`, `/notes/shared`, `/notes/:noteId`, `/files`, `/files/folder/:folderId`, `/files/:documentId`, `/bin`; unknown paths fall back to Home; ids are validated and lowercased (`521e39e`)
- [x] Desktop and mobile both push real history entries (`aa7f5d5`); the mobile panel hint and app section ride along as history state with a `mynotes.depth` counter (`f0a84a3`) so in-app Back never leaves the site from a first entry
- [x] Deep links resume the right note/folder, including shared notes under Shared (`8d07456`); missing ids fall back to `/notes` with a toast; login keeps the requested URL in memory only
- [x] Leaving a note by any route change runs `finalizeOpenNote`; failures keep the URL on the note; the editor is locked during every switch (`d5cfe58`) and a failed note load recovers to the list (`b6200cf`)
- [x] A failed first workspace load retries on the next route change (`81c548c`)
- [x] Server unchanged: production SPA fallback covers every route (verified `/notes/<uuid>` → 200 while logged out; `/api/*` still 401/404 JSON)
- [x] Tests: `tests/router.test.ts`, `tests/notesRoute.test.ts`, depth and startup-state helpers in `tests/appShellNavigation.test.ts` (39 tests)
- [x] Two independent reviews (fresh sessions). Fixed: first-load failure freezing Back/Forward, keystrokes lost during history-driven switches, shared deep links, uppercase ids, and a failed note load leaving the editor locked. Accepted low risks: Back pressed mid-switch truncates the Forward stack; pre-upgrade tabs' history entries read as Home; the login page ignores Back/Forward; only ids (not `/NOTES`) are case-normalised; overlapping retries after a two-factor change settle harmlessly.
- [x] Director QA on isolated data, desktop and 390 px: Home ⇄ Notes ⇄ folder ⇄ note with Back/Forward; reload on `/files/folder/:id` and `/bin`; unknown path → `/`; logged-out deep link → login → note; blank new note removed on Back with no dead target; edits published on click and history switches with the editor locked meanwhile.
- [x] Released v0.2.4: bump `4b8bf3e`, pushed to `origin/main`, deployed with Docker Compose; container healthy on port 2026, `/api/about` reports `0.2.4` / `4b8bf3e98421e3f6d4cbecc062352dc1cfad69f0`, `/notes/<id>` and `/bin` serve the SPA, `/api/*` unchanged (2026-09-25)

### Hotfix v0.2.5 — Clear way back to Home (released, deployed at `1f86d83`)

- [x] Operator feedback (2026-09-25): the MyNotes wordmark was the only way back from Notes and the Home header read "MyNotes". Added a labelled Home row to the Notes folder nav (desktop + mobile), a wordmark tooltip, per-app header labels (MyNotes eyebrow over Home/Notes/Files/Bin), and route-aware browser tab titles (`ce58a40`, cherry-picked as `9c76d32` onto the v0.2.4 line so the unreviewed Wave 3 backend stayed out of the deploy)
- [x] Released from branch `release/0.2.5` (`1f86d83`), merged back into main (`f9aa328`); container healthy, `/api/about` reports `0.2.5` / `1f86d83053cb48ca8494b5e89792ee40a131d582`

### Wave 3 — Secure documents backend (released v0.3.0 ahead of Wave 4, deployed at `4e98d8f`)

- [x] **Released v0.3.0 (2026-09-25):** bump `4e98d8f`, pushed to `origin/main`; forced full-data backup taken first (`scripts/backup.sh --force`); deployed with Docker Compose on Bun 1.4.2; container healthy, `/api/about` reports `0.3.0` / `4e98d8f8ee509024360906f4b775fb67481865c8`, `schema_migrations` = 1–6, `documents`/`document_shares` tables present, `/data/documents/{objects,.staging}` at 0700, `/files` serves the SPA, `/api/files` unauthenticated → 401. Scope: Files backend, minimal Files app, editor images/tables/PDF. Files delete UI still waits for the Bin (D19); `DELETE /api/files/:id` only soft-deletes, so nothing is lost before Wave 4.

Operator direction (2026-09-25): build backend and frontend together so each stage is visible. Wave 3 therefore also ships a **minimal Files slice** in the Files app (upload with progress, list, preview/download, routed through `/files` and `/files/folder/:id`). Rename, move, share, and delete UI wait for Wave 5 so nothing can be deleted before the Bin exists (D19).

- [x] Bounded JSON and MCP request bodies independent of `Content-Length`
- [x] Migration `006_documents` (documents, document_shares, bin columns, upload idempotency key)
- [x] UUID-only private disk storage (`documents/objects`, `documents/.staging`) with confinement, locks, and sweeper
- [x] Magic-byte MIME sniffing and safe preview allowlist
- [x] Bounded streamed multipart uploads (busboy, per-file cap, quota, free-disk floor, concurrency, idempotency)
- [x] List, metadata, rename, move, sharing (folder inheritance + document precedence), and soft-delete APIs
- [x] Authenticated content responses with strict headers, single Range, If-Range, and HEAD
- [x] Upload env vars, Compose pass-through, and backup staging exclusion
- [x] Wave tests (118 across 16 files), independent security review (no high/critical; three race tests, a teardown guard, and a contract row added in `cbf73f5`, `2397a78`, `3c9db1e`)
- [x] Container base image moved to Bun 1.4.2 (`4e040c3`): Bun 1.2.22 buffered an 800 MiB upload to 1.67 GB RSS. In-container check on the production image (2026-09-25): 600 MB upload at 150 MB/s, RSS baseline 64 MB → peak 89 MB, staging empty afterwards, `Range` 206 and the exact content headers confirmed.
- Accepted low findings: content responses omit HSTS/Permissions-Policy (contract-conformant); streamed 200/206 bodies are chunked without Content-Length (Bun); huge chunked non-file bodies get Bun's bare 413; upload slots are per user only; a few invisible characters beyond the plan's list survive name sanitising.

### Wave 3c — Note editor: inline images, tables, PDF export (operator request 2026-09-25, ships with v0.3.0 or the next release)

- [x] `/image` slash command plus paste and drop (`a4100cc`): uploads through `POST /api/files` into the note's folder and embeds `![alt](/api/files/<id>/content?disposition=inline)`; only PNG/JPEG/GIF/WebP, verified again against the server's sniffed kind; a mismatch deletes the upload and toasts. Limitation: image visibility follows the folder share, not the note override; removed images stay in Files.
- [x] `/table` with Tiptap table extensions pinned at 3.31.3 (`9c399e4`): 3×3 with header row, seven row/column/table actions in a floating toolbar, GFM pipe-table round trip (`tests/noteMarkdown.test.ts`), horizontal scroll on phones
- [x] "Download as PDF" in the editor toolbar and mobile actions menu via `@media print` rules and `window.print()` (`66c65c8`); the tab title carries the note title during printing and is restored after
- [x] Merged in `a98f427` (+ `b0ad1c3` duplicate-export fix). Director QA on the isolated instance: pasted PNG uploaded and embedded, saved in the draft Markdown; `/table` from the menu and from Enter, toolbar actions present, pipe table saved; PDF action calls print and restores the title.
- [x] Independent review (fresh session): one high (unescaped `|` in table cells corrupted rows on reload) and three mediums (multi-paragraph cells reloaded as literal `<br>`, Retry offered for final 409/413/415 upload errors, note-level shares cannot see folder-private images). Fixes for the first three are being applied before release. Accepted and documented: images embedded in a note inherit the **folder's** sharing, so a note shared more widely than its folder shows broken images to those readers (no data leaks); a fix belongs to a later note-attachments design. Low items (data: image sources rendering, print title fallback, silent upload cancel on browser Back, cancel/finish race, unknown preview_kind icon, image inserted at the cursor on completion) are fixed where cheap or accepted.
- [x] Released in v0.3.0 (see Wave 3 release line)

### Wave 4 — Shared 30-day Bin (released v0.3.1, deployed at `2e3825e`)

- [x] Implemented in `4706eca`, `4efb1d8`, `7f7e9ac`, `0b90ff5`, `aa6ce25`, `f2c76e9`; independent review (fresh session): releasable, no high/critical; medium (sweeper could purge an item restored and re-deleted mid-run) fixed in `0bbd139`; lows fixed in `1d1a1b7` (bounded resume budget), `78470d5` (resumed purges audited as `resumed`), `8aa9f5e` (sharing updates under the note lock, 404 for binned), `6b184b2` (editor locked during delete/discard), `f99d0aa` (Bin retry/Empty Bin copy). 170 tests.
- [x] Director QA on isolated data: note and file deletions land in the Bin with 30 days, confirm copy correct, Restore toast names the folder, Empty Bin confirms with the count and purges only the caller's items, empty state and disabled button, 390 px layout without undersized targets or horizontal scroll.
- [x] **Released v0.3.1 (2026-09-25):** bump `2e3825e`, pushed; forced backup taken; deployed on Bun 1.4.2; healthy; `/api/about` reports `0.3.1` / `2e3825e4eaada36f5e4a73fc578204587fbcdf5a`; `schema_migrations` = 1–7; legacy deleted published note backfilled with `purge_after`; first sweep purged 5 legacy blank unpublished notes, 0 pending.
- Accepted low: repeatedly failing purges are bounded per run (50 resumes + 100 due per table); Back with the mobile action sheet open closes the sheet and leaves the Bin (no sub-panels by design).

- [x] Migration `007_bin` with legacy soft-deleted note backfill
- [x] Notes and documents move to Bin; blank unpublished notes purge immediately
- [x] Idempotent, crash-safe restore/purge and hourly retention sweeper
- [x] Bin API and Bin app (desktop + mobile), Home Bin card live, updated delete copy
- [x] Wave tests, security review, pre-deploy backup, released as v0.3.1

### Wave 3b — Minimal Files app (ships in v0.3.0)

- [x] Files API client with XHR upload progress, error mapping (413 limit, 507 quota/disk, 429, 409 key reuse), and a pure upload queue with concurrency 2, cancel, retry with the same key (`c8c2d8c`)
- [x] Files workspace on `/files`, `/files/shared`, `/files/folder/:id`, `/files/:id`: folder rail, list with type/size/time/owner/share badges, upload queue panel with progress bars and live summary, preview pane per §7.2 (image inline, PDF in a new tab, text via 1 MiB Range with truncation notice, audio/video, everything else download-only), details, Download link; phone panels folders → files → preview with history hint `mynotes.files-navigation` (`f4320fb`, `ff694b8`)
- [x] Director QA on the isolated instance (Bun 1.4.2 backend): five uploads via the app's file input (PNG, 1.2 MB text, PDF, random binary, HTML) all reached 100 % with correct sizes; previews matched each kind; HEAD on every inline URL returned the contract headers (HTML/binary forced to `application/octet-stream; attachment`, PDF with `frame-ancestors 'none'`, others with `sandbox`); deep link to `/files` survived login; 390 px panels and Back work
- Deferred to Wave 5: rename, move, share, delete with Undo, New folder, OS drag-and-drop, sort/filter, keyboard shortcuts, mobile upload bottom sheet

### Wave 5 — Files UI (released v0.4.0, deployed at `5c42aa6`)

- [x] Implemented in `0d48272` (rename/move/share/delete with Undo), `72313ae` (New folder, sort, filter), `a374264` (OS drop upload, drag-to-folder), `e5cbb0d` (mobile action sheet, Move sheet, upload bottom sheet, Back closes dialogs via `src/historyDialogs.ts`), `2b1a5d3` (Home copy, empty/error states, live region, labels). 189 tests; Docker verify passes.
- [x] Director QA on isolated data: action sheet → Delete → Bin confirm copy → "Moved to the Bin" toast → Undo → "Restored to Default" and the row returns; Rename preselects the base name, shows "Will be saved as “report- final”" for a colon, and saves; New folder dialog creates and opens the folder; Move sheet disables the current folder, confirm reads "Move to Projects", toast "Moved to Projects · private", folder updated; 390 px: ⋯ opens a sheet with 44–48 px rows, browser Back closes it and stays on Files.
- [x] Independent review (fresh session): releasable, no high; mediums fixed in `24ec4ba` (Forward/Back with a dialog open undone via `history.go`), `7f97157` (shortcuts resolve the ⋯ button's own row); lows in `590c644` (focus trap, focus return), `b6e07c0` (unlisted files, Undo refresh error, 44 px Clear). 193 tests.
- [x] **Released v0.4.0 (2026-09-25):** bump `5c42aa6`, pushed; forced backup taken; deployed; healthy; `/api/about` reports `0.4.0` / `5c42aa630890222a9adec3365bfb34b61d699f7d`.

- [x] Files API client and upload queue with progress, cancel, and retry
- [x] Desktop Files workspace: folders, list, preview/details, rename, download, move, share, delete with Undo
- [x] Drag and drop upload from OS and drag-to-folder move
- [x] Mobile panels, action sheet, Move sheet, and browser history
- [x] Home Files card live; desktop/mobile manual QA and accessibility check; released v0.4.0

### Wave 7 — Full-text search (in progress, target v0.5.0)

- [x] Implemented in `2ec8129` (migration 008), `f7fcdb1` (projection + query builder), `2692068` (transactional index + boot reconcile), `b399cf0` (ACL-safe API with 429), `35defa8` (full-text Notes search UI with keyboard, live region, mobile history hint), `601c88b` (docs). FTS5 confirmed in Bun 1.4.2 and the pinned image. 224 tests at the wave's end; Docker verify passes on the merged tree.
- [x] Deviations: threat rows numbered T29–T32 (T28 was taken); Indic combining marks count as word characters; title kept out of the body index; folder filter matches the masked folder id.
- [x] Independent review (fresh session, live probing): injection, ACL parity, highlight safety, transactional sync, rate limit, UI, and Notes regressions all pass. **High:** `searchText` regexes quadratic on bracket-heavy lines (2 MB draft could stall the server for hours) — fix in progress. Lows: 300 ms debounce and no re-search on autosave; clear the search hint on sign-out; opening a draft from a search hit and leaving publishes it (existing finalize behaviour; **must change before Wave 9 MCP draft writes: publish only on session edits or explicit Publish**).
- [x] Director QA on the isolated instance: highlighted results with live count; injection attempts neutralised.
- [x] Fixes `0b6e07a` (linear single-pass text extraction; 2 MB pathological inputs in ~7 ms), `bc479fb` (bounded title derivation), `2fe1dc9` (300 ms debounce, no re-search on autosave), `5857d9b` (hint cleared on sign-out). 233 tests.
- [x] **Released v0.5.0 (2026-09-25)** with the Files views and the Nook rebrand: bump `150134b`; see the Rebrand section.

### Wave 5b — Files views and header polish (operator feedback 2026-09-25, in progress)

- [x] List and thumbnail (grid) views in Files with a persisted toggle; image tiles use the inline content URL
- [x] Files list takes the full width until a file is selected; the preview/details pane opens on selection with a Close control, URL-driven (`/files/:id`)
- [x] App headers show only the icon plus the app name (the "MYNOTES" eyebrow read as "Notes"); product name stays on the login page and in the tab title
- [x] Implemented on branch `files-views` (`59fe67f` list/grid, `e1c6b26` selection-driven preview pane, `011a49c` header), merged in `main`; independent review: releasable, lows only (thumbnails load full images; Close leaves two identical entries in history). Director QA: grid with lazy thumbnails, per-user persistence, pane on select with URL, Close returns the folder route.
- [x] Released in v0.5.0

### Rebrand — MyNotes → Nook (operator decision 2026-09-25, queued behind the in-flight waves)

The product is a private workspace (Notes, Files, Bin, Tasks next), so "MyNotes" as the product name caused confusion with the Notes app. New name: **Nook**. Scope: display name and repository only. The GitHub repo is already `pankajsoni19/nook` (Pages at `https://pankajsoni19.github.io/nook/`); the local remote is updated. Internal identifiers stay unchanged for compatibility: cookie `mynotes_session`, `mynotes.sqlite`, compose service/container `mynotes`, `/srv/mynotes` default, `mynotes:*` localStorage and `mynotes.*` history keys, the backup archive prefix.

- [x] Rename in UI (wordmark, Home greeting, tab titles, login page, settings/about), `index.html`, `package.json` name, MCP server name/instructions, README, site (copy, links, GitHub URL), docs/ARCHITECTURE and plan docs (links only; historical text may keep "MyNotes"), `.github/workflows/pages.yml` if it names the repo, social preview alt text; regenerate `public/social-preview.png` wordmark if feasible without new binaries in a review-unfriendly way (otherwise flag)
- [x] README rewritten as a concise overview (what Nook is, quick start, links) that points to the site and `docs/` for details (operator request 2026-09-25)
- [x] Site (`site/index.html`, published at https://pankajsoni19.github.io/nook/) becomes the full documentation: rebranded, covering Home and URLs, Notes editor features, Files list/grid views and actions, Bin, full-text search, MCP, configuration, storage, backups
- [x] Rebrand implemented on branch `rebrand-nook` (`519426b` app strings + MCP name + TOTP issuer for new enrolments, `4c128d1` concise README + docs/USING.md + docs/OPERATIONS.md, `fdc9883` site, `bccade6` plan/architecture headers), merged into main; kept the `mynotes_` API-key prefix and the TOTP encryption label for compatibility. Social preview candidate awaiting operator approval (not committed).
- [x] Released v0.5.0: pushed, forced backup, deployed; see the smoke-test line below

### Wave 6 — Documentation and final audit (complete, v0.4.1)

- [x] README, ARCHITECTURE, and site docs for Files/Bin, editor features, URLs, env vars, backup sizing (`8259794`, `8e1aa18`, `42d5300`, `eff0971`); the `app-dev` reference was already removed in Wave 4
- [x] Final independent security audit across Waves 3–5 (fresh session, live probing of a scratch server, 2026-09-25): every Required threat row confirmed except **T10/T12 GAP (high)**: a streamed `POST /api/files` with no `Content-Length` past Bun's body cap left the handler waiting with an open staging handle; the later GC close crashed the process. Hotfix in progress (411 without Content-Length, inactivity watchdog, explicit handle close, regression tests). Lows: error logs include `error.message` (fix in the same batch); Compose has no mem/pids limits and publishes 2026 on all interfaces (documented, accepted for LAN use); files may be moved to no folder (accepted, narrows access only). PDF-without-sandbox added to the threat model's residual risks.
- [x] Hotfix `5ce3bc4` (411 without Content-Length, 30 s inactivity watchdog with 408, explicit staging-handle close; three real-server regression tests; the reproduction script no longer crashes a scratch server) and `479d58a` (error logs print class and errno, not messages). 196 tests.
- [x] **Released v0.4.1 (2026-09-25):** bump `d1fdb31`, pushed, deployed (no migration, no backup needed); healthy; `/api/about` reports `0.4.1` / `d1fdb31bb3ecededc5123fd61893bff18711eb3b`. **Wave 6 complete.**

## Released v0.9.3 (2026-09-27) — Card drawer

Release SHA `45a47e9`; pushed; Docker verify 1156 pass; no migration; deployed; healthy; `/api/about` reports `0.9.3`. Contents: on desktop the task card opens as a full-height right-side drawer (fields column left, description + comments right, comment box pinned at the bottom, slide-in without a resting transform); phones and the composer unchanged. **Note:** at 761–1099 px the comment box pins only once the Comments section is in view (single-column layout).

## Released v0.9.2 (2026-09-27) — Operator feedback round: Today groups, tags, due picker, sprints, dialogs

Release SHA `4ff84ae`; pushed; Docker verify 1155 pass; no migration; deployed; healthy; `/api/about` reports `0.9.2`. Contents: Today regrouped (Today / Recent work / Housekeeping, folded empties, own cards ranked first in Due soon); tags auto-coloured + discoverable creation (+ New tag, Create row, list opens on focus); Due picker with Apply/Cancel + quick picks; lane card 3-row face with whole tag chips + "+N"; card dialog 1240 px two-column at ≥1280; subtasks require a parent below the work level (Choose a task…, Make it a task, detached notice); sprint defaults per board, New sprint from the switcher (Create and start = today), Sprints page `/tasks/:b/sprints`, no-active-sprint prompt; Calendar event sheet 880 px two-column; Remind me disables passed options / explains past events; Team role/block actions without password re-check (operator decision; T77/T82 updated); 44 px phone targets; dropdown long-list scroll fix; description Edit focuses the editor. **Open:** MCP write-coverage wave (proposed); Wave 16 invites; real-device push/feed checks; QA-instance throwaway accounts; possible sparse "+N"-only tag footer on very narrow cards.

## Released v0.9.1 (2026-09-27) — UI fixes from operator feedback

Release SHA `66115b1`; pushed; Docker verify 1099 pass; no migration (no backup taken); deployed; healthy; `/api/about` reports `0.9.1`. Contents: card description box sizes to its text (read + edit, max 60vh then scrolls); Tasks home spacing rhythm and no duplicate "New view"; click an empty day in the Calendar month to add an event (hover "+", day-panel action on phones); Copy link on cards (header + ⋯ "More actions"); ⋯ renamed to "More actions". **Open:** MCP write-coverage wave (publish, bin/restore, upload, tags/sprints, collections) — proposed, awaiting operator go-ahead; Wave 16 invites; real-device push/feed checks.

## Released v0.9.0 (2026-09-27) — Viewer/guest roles, task hierarchy, sprints, Tasks home and saved views

Release SHA `1fc4b7d`; pushed; Docker verify 1087 pass; forced backup before deploy; deployed; healthy; `/api/about` reports `0.9.0`; migration 019 applied on first boot. Contents: Wave 15 (viewer/guest enforcement, write gate over 100 mutating routes, guest audience exclusion + grep guard, MCP scopes by role, `SIGNUP_ROLE`), 17A hierarchy (migration 019, presets, templates, subtasks, roll-ups, Bin subtree cascade), 17B sprints, 17C Tasks home / My work / saved views + column state, D113 payload trim (1.15 MB worst case), closing docs pass (feature-led README, 13 screenshots, site + guides), review fixes (2 MEDIUM + 7 LOW) and delegated-QA fixes (6 + polish). Independent review: no HIGH. **Open:** real-device push/feed checks (operator); Wave 16 invites (unscheduled); QA-instance leftovers are throwaway accounts only.

## Released v0.8.1 (2026-09-27) — Board views, filter bar, composer, tags/flags/relations UI, saved views API

Release SHA `598fb1e`; pushed; Docker verify 968 pass; forced backup before deploy; deployed; healthy; `/api/about` reports `0.8.1`; migration 020 applied on first boot. Contents: 13C UI, 13D UI, 13E (column/table/grouped/calendar views, FilterBar on the shared grammar, URL state), 17C server (cross-board query, saved views, column state, MCP `list_views`/`query_cards`), test-reliability hardening, review fixes (composer Back handover, MCP query rate limit, signed cursors, view revision on sharing), delegated-QA fixes (8 bugs + polish). Independent review: no HIGH. **Next:** v0.9.0 = Wave 15 viewer/guest + 17A hierarchy + 17B sprints + 17C UI Tasks home + D113 payload trim, with review + delegated QA.

## Released v0.8.0 (2026-09-26) — Team, Modules, custom dropdowns, task card fields and APIs

Release SHA `bea1e75`; pushed; Docker verify 796 pass; forced backup taken before deploy; deployed; healthy; `/api/about` reports `0.8.0`; `/`, `/team`, `/tasks`, `/collections`, `/calendar`, `/bin`, `/notifications`, manifest, icons, `/sw.js` serve; migrations 015–017 applied on first boot (no "no active admin" boot warning). Contents: Wave 14 Team A (roles admin/member, first-admin bootstrap, block/unblock, `/team`, `team:read` MCP, CLI), 13F Settings → Modules (migration 016), 13A shared dropdowns (14 native selects migrated), 13B server + UI (migration 015: due time, multiple assignees, WIP limits), 13C server (tags, flags, excerpts, filters, `shared/taskQuery.ts`), 13D server (relations, card search, MCP `link_cards`/`search_cards`), one-call card create, collections list actions, app icon PNGs, two independent reviews (no HIGH; 2+1 MEDIUM and 7 LOW fixed). **Open:** 13C UI, 13D UI, 13E, 17C server are complete on branches and merge next toward v0.8.1 / v0.9.0; flaky single-test failure seen in three full runs (hunt queued); real-device push/feed checks; closing docs pass (README features + screenshots).

## Released v0.7.0 (2026-09-26) — Today, Collections, Calendar, feeds, MCP scopes

Bump `80e4892`; release SHA `1cd2eb24753d239828ee5144889c7e44222a63c9`; pushed; forced backup taken; deployed; healthy; `/api/about` reports `0.7.0`; `schema_migrations` = 1–14; `/`, `/collections`, `/calendar`, `/notifications`, `/tasks` serve the SPA; `/sw.js` (`text/javascript`, no-cache) and `/manifest.webmanifest` served; push config gated by auth. Contents: Wave 10 Today (+ review fixes), Wave 11 Collections (+ review fixes, Stage E MCP tools), Wave 12 Calendar A–D (+ review fixes incl. migration 014, feeds, MCP tools, push with bounded DNS), QA polish, undo-link permission fix (`7369476`), bounded feed limiter (`227b43f`), null-prototype MCP rows + hazardous field names rejected (`a336bb7`), dialog sentinel robustness (`1cd2eb2`). 612 tests; Docker verify passes. **Open:** PNG app icons for the manifest (awaiting operator approval of the rendered candidate; `/icons/nook-*.png` 404 until then); real-device push and feed subscription checks on the HTTPS origin (TEST_PLAN manual rows).

## Waves in flight (parallel, 2026-09-25)

| Wave | Where | Status |
| --- | --- | --- |
| 9 Task Boards | `main` | **Done, reviewed** (A–D `cc7faa3`…`af44ddc`; review at `e7f911e`: releasable, no high; mediums fixed in `4b22474` never-linked attachments swept to the Bin after 24 h, `e80f253` Files routes refuse non-file documents and sharing/folder access no longer applies to attachments; lows `b9a69a9`, `2ea6399`, `9b23729`, `2251618`). Task tools merged `3c0a6c1`. 357 tests. Delegated QA (two users, desktop + 390 px): 12/13 pass, no hard failures; MCP scopes verified by the director (write key lists 7 tools, read key 4; `create_note` creates a draft with a "Draft by <key>" badge, leaving keeps it a draft, Publish makes v1 and clears the badge; read key cannot create). Polish fixed in `9c117e0`, `100190e`, `469d43c` (360 tests). **Released v0.6.0 (2026-09-25):** bump `514201a`, pushed, forced backup, deployed; healthy; `/api/about` reports `0.6.0` / `514201aa039bb9323d6c023dcda4753004903edf`; `schema_migrations` = 1–10; `/tasks` serves the SPA. |
| 8 MCP scopes | merged `e7f911e` | **Done, reviewed** (`9791188`…`633bffa` + review fixes `65a5b77` publish requires the seen draft revision, `29366d6` no auto-publish of MCP drafts, `1b41d5c` per-user limits across keys; 266 tests). Review: releasable after the fixes. Task tools done on `wave8-task-tools` (`db0a226`, 348 tests: list_boards/list_cards/get_card/create_card/move_card/comment_on_card, per-user 1000 task writes/day, Settings offers the task scopes); awaiting merge. |
| 12 Calendar | branch `wave12-calendar` | Stage A done (`7843911`…`d65b871`, 292 tests on the branch: migration 013, recurrence, calendar/event/sharing APIs, agenda/month/event routes, links with a resolver registry, Bin parity, 390 px verified by the implementer). Stage B done (`93ad88f` reminders + dispatcher + notifications API, `ef6c862` bell + `/notifications` + `listUpcoming`; 310 tests on the branch). Stage C done (`3262132` VAPID + payload-less push with endpoint allowlist and private-address rejection, `8d3bfd2` service worker + device settings + manifest; 328 tests on the branch; PNG icons pending operator approval). **Merged into main `4cf555f`** by a merge agent (Bin providers for calendar/event, tasks overlay via `readableBoardPredicate`, card/row link resolvers, Today `upcoming` session-only, single dialog guard stack, bell in AccountActions; 559 tests). Independent review of the merged tree (live probes incl. push with stubbed endpoints): releasable, no high; medium (recurrence expansion cost unbounded per request: 20k pathological events ≈ 200 ms per reader) and lows (rate-limited reminders dropped, IPv6-mapped private ranges, cap keeps wrong occurrences, two 40 px targets, sw click fallback, delivery concurrency, dirty-sheet discard on unknown Back direction, subscriptions outlive disabled users) being fixed on branch `calendar-review-fixes` (adds migration 014 `next_occurrence_utc`). Stage D + MCP tools done on main: `0d72094` revocable iCalendar feeds (busy/full, uniform 404, per-token limit), `5dceca0` MCP calendar tools + `calendar:read|write`, `3822226` MCP collection tools + `collections:read|write` (+ `collectionsRecent` Today section), `0c85e51` docs; 589 tests. QA polish merged `d3705b4` (598 tests). Review of feeds + tools in progress. Version note: this batch ships as **v0.7.0** (Today + Collections + Calendar core) rather than the plan's v0.8/0.9/0.10 split; later waves continue from there. |
| 11 Collections | branch `wave11-collections` | Stages A–D done (`489fd7f`…`96c8a3f`: migration 012, schema/templates, parameterised query API, desktop table + mobile cards/row panel, viewer/editor sharing, saved views, attachments, Bin via a provider registry, row search, CSV import/export, Files-route rule + never-linked sweep, docs; 356 tests on the branch). Independent review (live probes): releasable, no high; mediums to fix at merge: a saved view cannot be re-sorted after a filter field is removed (`service.ts` strict clause check), and a restored attachment with no links comes back as a hidden orphan (use main's linked-attachment restore rule); lows: deleter still sees a binned row title after unshare, undo skips `required`/note-link re-checks, three sub-44 px targets, reconcile loads all stale ids, `BIN_TYPES` accepts unregistered providers. Reviewer supplied a per-file merge resolution table. **Merged into main `66dbb83`** with fixes `f7726b2` (stale view filters), `df8245b` (deleter listing needs edit access), `e9d9004` (undo re-validates), `47f16c6` (44 px), `3b62676` (unregistered Bin types → 400), `7fd6db2` (batched reconcile); 461 tests. No Collections Today section until a `collections:read` scope exists (Stage E). |
| 10 Today | `main` | **Done** (`ec2ba9e`…`b142fff`: migration 011, due dates/assignees/done columns + `/readers`, `GET /api/today` with providers and `registerTodayProvider`, Today replaces the Home grid with a launcher row, Customize dialog, `get_today` + `today:read`; 384 tests). Independent review: releasable; fixes `27cbad6` (binSoon filtered by the key's module scopes), `2e87032` (direct soonest-to-purge query), `d65fd04` (shared Today rate limit for `get_today`), `1b242b3` (due date saves on commit; detail conflicts shown), `ddfd30f` (bounded refetch). Delegated QA (Today + Collections, two users, desktop + 390 px): 14/14 pass; polish on branch `qa-polish-070` (row-attachment Bin label, dialog guard at depth 0 on mobile, URL error text, Enter in quick-add, checkbox target, section overlap, import button copy, attachment undo). |
| Bin placement | merged `bbd14a6` | Done (`00e0999`, `46818e2`): Bin removed from the Home grid, utility-row button with a count badge, Bin entry in the Notes and Files sidebar footers; `/bin` unchanged. |

Merged so far: 9, 8, Bin placement, 10 (+ review fixes `27cbad6`…`ddfd30f`), 11, 12 A–C (main `4cf555f`, 559 tests, Docker verify passes). Next: Calendar review + QA → release v0.7.0 (Today + Collections + Calendar core); feeds + MCP calendar/collections tools → v0.7.1. Each gets one independent review; QA is delegated; container verification once per release.

## Queued (operator requests 2026-09-26)

### Team module — plan of record: `docs/plan/research/2026-09-26-team-module.md` (§11 director review)
- [ ] Wave 14 (Team A): roles + admin + block/unblock, `/team` UI, `team:read` MCP scope, CLI `server/team-admin.ts`, migration `017`. Runs in parallel with Wave 13.
  - Implemented on branch `worktree-agent-a29e87677383eea66` (migration 017, `server/team/`, `src/team/`, `src/ui/Select.tsx`, CLI, docs; headless Chrome QA at 390 px and desktop). Pending independent review, merge after Wave 13's 015/016, and the release note for O8 (oldest account becomes admin; CLI fix). Settings → Modules (D92) Team row waits for Wave 13's Modules pane.
- [ ] Wave 15 (Team B): viewer and guest enforcement (write gate, `AUDIENCE_ALL_USERS`, MCP role filter, `SIGNUP_ROLE`, role-aware chrome).
- [ ] Wave 16 (Team C, unscheduled): invites, migration `018`.

### Wave 17 — Task hierarchy, sprints, Tasks home and views — plan of record: `docs/plan/research/2026-09-26-task-hierarchy-workflows.md` (§14 director review)
- [ ] 17A Hierarchy (migration 019): parent/level (max 3), board structure presets (Flat, Task › Subtask, Sprint › Task, Sprint › Task › Subtask, Epic › Story › Subtask, custom), subtasks section, roll-ups, Bin subtree cascade, templates, MCP fields. After 13A + 13B merge.
- [ ] 17B Sprints: board_sprints entity, one active per board, close with carry-over, switcher + progress strip, MCP sprint tools. After 17A.
- [ ] 17C Tasks home and views (migration 020): `/tasks` segments Boards / My work / Views, shared column state todo/doing/done, shared filter grammar (`shared/taskQuery.ts`), paged cross-board query, saved views private/selected/everyone (never widen access), MCP `list_views` / `query_cards`. Server half may start after 13B-server merges.

### Wave 13 — Task card UX, board views, dropdowns, Modules — plan of record: `docs/plan/WAVE_13_TASK_CARD_UX.md` (§12 director review). v0.8.0 shipped 13A, 13B, 13C/13D server, 13F, Wave 14. Merged after: 13C UI `1e34a5d`, 13D UI `ba2a03b`, 17C server `ca53482` (905 tests). 13E merged `ed2b663` (945 tests) — Wave 13 complete on main. Test-reliability hardening `96a3ce2`. v0.8.1 released `598fb1e`. v0.9.0 candidate on main `64b7c5c` (1062 tests, Docker verify pass): Wave 15 `6d75845`, 17C UI `9d4a8c3` + role gating `4ae13ed`, 17A + 17B `0811b17`, payload trim `64b7c5c` (1000-card board 1.15 MB). Independent review + delegated QA in progress; closing docs pass (README features + screenshots) started in parallel.
- [ ] Column WIP limit: each board column/lane gets an optional max card count (default: no limit). Shown as `n / limit` in the column header, warns or blocks moves that would exceed it (kanban + agile).
- [ ] Card tags and flags: cards get tags (free-form, board-scoped, coloured) and flags (fixed set, e.g. blocked, urgent, needs review) in create, edit, list, and MCP tools.
- [ ] Lane card face shows title, description excerpt, assignees, due date + due time if present, tags, flags.
- [ ] Board views: column (current swimlanes), table (all fields, sortable columns), grouped list, and **calendar** (cards by due date, reusing the Calendar module's month/agenda components; drag to reschedule) (group by column/assignee/tag/due). Switch via icons in the board header; view is part of the URL.
- [ ] Linear-style filter bar: compose filters on assignee, tag, flag, due, column, relation; filters live in the URL query so they survive Back/Forward and sharing.
- [ ] Rule D91: every dropdown is a custom component; migrate all 15 existing native `<select>` usages (7 files under `src/`).
- [ ] Settings → new left-nav item "Modules": per-user on/off toggle for every module, all on by default (D92). Hidden modules leave the launcher, nav, routes, and Today; data and server authorization untouched.
- [ ] Add-card flow opens a full-screen dialog so every detail can be entered at once.
- [ ] Optional due time alongside the due date.
- [ ] Assignee picker: custom dropdown with type-to-search, multiple assignees per card.
- [ ] Card dialog gets an expand control that opens the card as a full page (`/tasks/:board/card/:key` full view).
- [ ] Card relations: link cards with typed relations (related, depends on, needed by, …).
- [ ] Calendar: the calendars dropdown becomes a custom picker instead of a native `<select>`.
- [x] `/collections` list: inline rename / share / Move to Bin actions like the board list (merged `fdac35c`, ships in v0.8.0). (observation or change request?).

### Closing docs pass (after Waves 13, 14, 17 ship)
- [x] Rewrite `README.md` to lead with features (Today, Notes, Files, Tasks with views/hierarchy/sprints, Collections, Calendar + reminders, Search, Team, MCP, Modules), concise, details on the docs site.
- [x] Replace `docs/images/dashboard-dark.png` with fresh screenshots of the current product (Today dashboard + a task board; dark and light if cheap), taken from an isolated QA instance with seeded placeholder data only — never real user data.
- [x] Refresh `site/index.html` and `docs/USING.md` for every feature shipped in v0.8–v0.9.

## Backlog — candidate modules and enhancements (for later picking)

Research reports (2026-09-25): [feature enhancements](docs/plan/research/2026-09-25-feature-enhancements.md) · [new modules](docs/plan/research/2026-09-25-new-modules.md). Nothing here is scheduled until the operator picks it.

**Chosen and planned (Waves 7 → 9 → 8, [docs/plan/WAVES_7-9.md](docs/plan/WAVES_7-9.md), director-reviewed with four required changes):** full-text search in notes (v0.5.0); Task Boards module with sharing, draggable cards, comments, attachments (v0.6.0, four runnable stages); MCP coverage across notes, files, and tasks with per-key scopes and draft-only writes (v0.7.0). Start after Wave 6.

**New standalone modules, ranked by value for effort (operator: "look good, keep for later"):**
- [ ] Today dashboard (S/M) — **chosen 2026-09-25, planned as Wave 10 in [docs/plan/WAVES_10-12.md](docs/plan/WAVES_10-12.md)** — read-only home pulling due tasks, recent notes/files, Bin warnings; natural mobile landing page
- [ ] Journal (S) — note engine plus date key, mood, prompts, streaks; habits fold in
- [ ] Agent inbox and routines (M) — stored routines run by outside AI clients over MCP; results return as proposals to approve
- [ ] Bookmarks and read-later (M) — snapshots stored through Files, never rendered as HTML; fetching off by default with strict server-request protections
- [ ] Calendar and reminders (M, staged) — **chosen 2026-09-25, planned as Wave 12 in [docs/plan/WAVES_10-12.md](docs/plan/WAVES_10-12.md)** — events, Web Push reminders on HTTPS origins, read-only iCalendar feed; CalDAV out of scope
- [ ] Collections (L) — **chosen 2026-09-25, planned as Wave 11 in [docs/plan/WAVES_10-12.md](docs/plan/WAVES_10-12.md)** — generic typed tables with templates (inventory, recipes, subscriptions, expenses, contacts-lite); see the report for downsides
- Next in line if wanted: whiteboard/canvas stored as files. Rejected for now: password vault, scanning/OCR, photo gallery, transcription, chat, RSS (reasons in the report).

**Enhancements to existing modules (not chosen yet):** tags, wikilinks/backlinks, daily notes and templates, cross-note task list, Markdown export and Obsidian/Notion/Joplin import, passkeys, installable offline app with share target, web clipper, document OCR, encrypted vault notes.

## Foundation

- [x] Initialize Git repository
- [x] Define architecture, disk layout, API, and security model
- [x] Scaffold Bun + React + TypeScript + Tailwind project
- [x] Pin dependency versions and commit lockfile

## Backend

- [x] SQLite schema with WAL, foreign keys, and indexes
- [x] Safe atomic Markdown storage primitives
- [x] Argon2id password and opaque cookie-session foundation
- [x] Authentication and registration API
- [x] Folder API
- [x] Notes, drafts, publish, version history, and restore API
- [x] Sharing with selected users and all authenticated users
- [x] Audit log and health endpoint
- [x] Authenticated read-only Streamable HTTP MCP server with revocable API keys
- [x] API tests for authorization, CSRF, sharing, concurrency, permissions, recovery, and symlink safety

## Frontend

- [x] Minimal login / registration landing page
- [x] Wide account settings dialog with responsive security navigation
- [x] Google Authenticator-compatible encrypted TOTP enrollment and login challenge
- [x] Encrypted, one-time TOTP recovery codes with secure reveal and regeneration
- [x] Clear distinction between setup keys, six-digit codes, and recovery codes
- [x] Responsive three-pane macOS Notes-inspired dashboard
- [x] Collapsible folder navigation and note list
- [x] Clear Settings control, Security/About navigation, version, and Git build metadata
- [x] Delete controls, six-way note sorting, and all-notes default/resume behavior
- [x] Outline-like Tiptap editor with bubble toolbar and `/` commands
- [x] Visible ordered/bullet markers, underlined links, and aligned checklist rows
- [x] Debounced draft autosave and explicit publish/discard controls
- [x] Auto-publish changed drafts when switching notes
- [x] Remove never-published blank notes when switching away
- [x] Hide publish controls when draft content matches the published version
- [x] Derive note titles from the first Markdown line
- [x] Default folder assignment and drag-to-folder organization
- [x] Folder sharing with note-level permission precedence
- [x] Version history, content view, diff, and restore
- [x] User picker and private/selected/all-users sharing controls
- [x] Loading, empty, error, and conflict states
- [x] Open Graph/Twitter landing metadata and reusable 1280×640 social preview image
- [x] Responsive MCP settings, API-key management, and copyable client configuration
- [x] Obvious collapsed-sidebar reopen control with keyboard/touch support
- [x] Mobile browser Back/Forward navigation between folders, note list, and editor

## Container and operations

- [x] Multi-stage non-root Dockerfile
- [x] Docker Compose bind mount configurable via `MYNOTES_DATA_DIR` (portable default: `/srv/mynotes`)
- [x] Health check and port `2026`
- [x] Production dependency/build verification
- [x] Deploy locally with Docker Compose
- [x] Weekly full-data gzip backup with five-snapshot retention and direct restore layout
- [x] Numbered transactional SQLite migrations that run automatically at server boot
- [x] Public GitHub Pages documentation with search, responsive navigation, and complete self-hosting reference

## Quality gates

- [x] Typecheck and production build
- [x] Desktop browser interaction QA
- [x] Mobile viewport responsiveness QA
- [x] Independent security audit A
- [x] Independent security audit B
- [x] Address all high/critical audit findings
- [x] Final smoke test against deployed service
- [x] Commit all completed milestones
