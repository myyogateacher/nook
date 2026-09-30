# Nook development plan: Home, Files, and shared Bin

This is the handoff for the rest of the requested work. A new Claude Code session should be able to implement every remaining wave from this file and the linked specs without the original conversation.

| Document | Purpose |
| --- | --- |
| [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) (this file) | Baseline, decisions, design, ordered waves, gates, out of scope |
| [docs/plan/API_CONTRACTS.md](docs/plan/API_CONTRACTS.md) | Exact HTTP contracts for Files, content/Range, and Bin endpoints |
| [docs/plan/THREAT_MODEL.md](docs/plan/THREAT_MODEL.md) | Assets, trust boundaries, threats, and required mitigations |
| [docs/plan/TEST_PLAN.md](docs/plan/TEST_PLAN.md) | Automated and manual tests each wave must add or pass |
| [TODO.md](TODO.md) | Checklist that tracks wave status |
| [docs/plan/WAVES_7-9.md](docs/plan/WAVES_7-9.md) | Planned follow-on waves: full-text search, Task Boards, MCP scopes (added 2026-09-25) |
| [docs/plan/WAVES_10-12.md](docs/plan/WAVES_10-12.md) | Planned follow-on waves: Today dashboard, Collections, Calendar and reminders (added 2026-09-25) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current architecture. Update it when a wave ships. |

**Rules for implementers**

- Read this whole file before writing code. When the plan disagrees with the code, the code is the truth about *current* behavior. Update the plan in the same commit as any deliberate deviation.
- Never write `.env` values, credentials, private email allowlists, tokens, personal hostnames, or personal absolute paths into tracked files. Use placeholders such as `user@example.com`, `https://your-device.your-tailnet.ts.net`, and "the bind-mounted host data directory (`MYNOTES_DATA_DIR`)".
- Released migrations are append-only. Never edit `001`–`005`. Once `006` or `007` ships, never edit it either.
- Do not push, deploy, or tag without explicit operator approval for that specific action.
- Work through the waves with the sequential worker prompts and gates in §15, one step per fresh session.
- **Mobile-first with browser history parity (operator rule, 2026-09-25).** Every feature must work at 390 px with ≥44 px targets, and every view, panel, sheet, and item must be reachable and unwindable with the browser/OS Back and Forward (swipe): routes in `src/router.ts` via `navigate`, the `mynotes.depth` counter, panel hints in history state, and the dialog guard in `src/historyDialogs.ts`. Back never leaves the web app until the user is on Home at the first entry.
- **Parallel waves (operator request for speed, 2026-09-25).** Independent waves may be implemented at the same time, each in its own git worktree and branch on disjoint modules (`server/<module>/`, `src/<module>/`, its own migration id from the plans, tests); only minimal wiring lines (router table, App render/navigate, Home card, Bin types) are shared. The director merges branches into `main` in release order, a merge agent resolves conflicts, one reviewer runs per wave (overlapping the next implementation), container verification runs once per release, and QA is delegated. The single-writer rule now means one writer per checkout.
- **MCP coverage (operator rule, 2026-09-25).** Every module that stores data adds MCP tools under its own scope pair following the Wave 8 conventions (docs/plan/WAVES_7-9.md §4): tools registered per scope and re-checked in handlers, writes are create/update only (deletes go through the Bin or are omitted), audit `{via:"mcp", keyId}`, per-key rate limits.

---

## 1. Verified baseline (as of 2026-09-25)

These facts were checked against git and the running container when this plan was written. Re-check them before starting work (`git status`, `git log --oneline -5`, `git rev-list --left-right --count origin/main...HEAD`).

| Item | State |
| --- | --- |
| Branch | `main`. Before this docs commit the only uncommitted changes were these planning files. |
| `origin/main` | `0efb975 fix: clean up empty notes during mobile back` |
| Local `main` | One commit ahead of origin: `cb59b6a feat: add authenticated workspace home` (**Wave 2, local only, pending independent review**), plus this docs-only planning commit on top. Neither is pushed. |
| Tags | None exist. Releases are identified by version bump commits and `GIT_SHA` build metadata. |
| Package version | `0.2.2` (bumped in `8cfd9a1`; `0efb975` is a fix released under the same version) |
| Deployed service | Docker container `mynotes` is healthy and reports `APP_VERSION=0.2.2`, `GIT_SHA=0efb975` |
| Migrations | `001_initial` … `005_mcp_api_keys` were released at baseline. Since then: 006 documents, 007 bin, 008 note search (v0.5.0); 009 task boards, 010 MCP key scopes, 012 collections, 013 calendar are in flight (ids pre-assigned in docs/plan/WAVES_*.md); 011 task dates is next for Wave 10. |
| Tests | `tests/api.test.ts` (API/integration; asserts migration ids `[1,2,3,4,5]`), `tests/mobileNavigation.test.ts`, `tests/appShellNavigation.test.ts` |

### Wave history

- **Wave 1: done and deployed (v0.2.2 at `0efb975`).** Mobile browser Back/Forward between folders, note list, and editor (`src/mobileNavigation.ts`), plus empty-note cleanup during mobile Back.
- **Wave 2: implemented locally in `cb59b6a` and waiting for independent review and release.** This is the authenticated Home app selector (`src/AppShell.tsx`, `src/appShell.css`, `src/appShellNavigation.ts`, `tests/appShellNavigation.test.ts`, edits to `src/App.tsx`, and three TODO lines). Home shows three cards: **Notes** (live), **Files** (placeholder), and **Bin** (placeholder). The sidebar brand button returns to Home. Mobile history layers a `mynotes.app-shell` entry over the existing `mynotes.mobile-navigation` snapshot. Wave 2 is not pushed or deployed. **Status: pending independent review** (§4). Its review gates are open questions, not confirmed bugs.

### Current architecture relevant to this plan

- **Runtime:** one Bun process runs Hono. `server/index.ts` holds all routes. `export default { port, hostname, fetch, maxRequestBodySize: 2_100_000 }`. The process serves the SPA from `dist` in production.
- **Security middleware** in `server/index.ts` and `server/auth.ts`:
  - `secureHeaders` applies a global CSP (`default-src 'self'`, `img-src 'self' data:`, `object-src 'none'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, and `no-referrer`.
  - `/api/*` responses get `Cache-Control: no-store`.
  - `requireAuth` uses the opaque `mynotes_session` cookie (HttpOnly, SameSite=Strict).
  - `requireMutationSafety` (registered on `/api/*` after `requireAuth`) rejects every authenticated non-GET/HEAD/OPTIONS `/api` request unless it has an allowed `Origin`, `Content-Type: application/json`, and a valid `X-CSRF-Token`. Login and register have their own Origin and JSON checks. `/mcp` is outside `/api` and uses bearer API keys.
  - When `TOTP_POLICY=required`, a TOTP-setup gate applies.
- **Body limits:** `parseJson()` checks only the `Content-Length` header (2.1 MB). The real cap on chunked bodies is Bun's global `maxRequestBodySize`.
- **Storage:** `server/storage.ts` validates UUIDs, confines paths to `DATA_DIR`, and rejects symlinks via `lstat`, `realpath`, and `O_NOFOLLOW`. Writes are atomic (temp file, fsync, rename, directory fsync) with files at `0600` and directories at `0700`. `withNoteLock` serializes work per note id. Layout: `notes/<uuid>/{current.md,draft.md,versions/000001.md}`.
- **ACL:**
  - Notes: owner OR (`sharing_override=1` and note visibility/`note_shares`) OR (`sharing_override=0` and the **immediate** folder's visibility/`folder_shares`).
  - The predicate is `readableNotePredicate` in `server/access.ts` (extracted in Wave 7); `GET /api/notes` still has an inline copy, and the MCP tools in `server/mcpTools.ts` use the shared one.
  - Recipients never see a shared folder's `parent_id`. Folder sharing does **not** cascade to subfolders.
  - Only owners mutate anything. Missing and forbidden both return 404.
- **Deletion today:**
  - `DELETE /api/notes/:id` sets `notes.deleted_at`. For never-published notes it also removes the note directory immediately.
  - `DELETE /api/notes/:id/draft` on a never-published note sets `deleted_at`, nulls `draft_revision`/`draft_checksum`, and removes `draft.md` (the note directory stays). The draft content is lost.
  - `POST /api/notes` writes an empty `draft.md` and stores `draft_checksum = checksum("")`.
  - There is no restore and no purge. Soft-deleted rows stay forever.
  - `DELETE /api/folders/:id` cascades subfolders (FK) and sets `notes.folder_id` to NULL (FK `ON DELETE SET NULL`).
- **Frontend:** `src/App.tsx` (~1180 lines) is the whole Notes app plus the auth, settings, history, and share panels. `src/api.ts` always sends JSON. Mobile breakpoint is `max-width: 760px` (`isMobileViewport`). History entries are pushed **only on mobile viewports**. Notes drag/drop uses the `application/x-mynotes-note` data type onto owned folders.
- **Ops:**
  - `compose.yaml` runs one non-root service with a read-only root, `/tmp` as a **64 MB tmpfs**, `cap_drop: ALL`, and `no-new-privileges`. `/data` is bind-mounted from `${MYNOTES_DATA_DIR:-/srv/mynotes}`.
  - `scripts/backup.sh` stops the app, tars the data directory (excluding `./backup`), verifies gzip, keeps 5 archives, and restarts.
  - The Dockerfile `verify` stage runs typecheck, tests, and build. The `production` target does **not** depend on `verify`.
- **Version string locations (update all of them on every bump):** `package.json`, `server/config.ts` (`appVersion` default), `Dockerfile` (`ARG APP_VERSION`), `compose.yaml` (`APP_VERSION` default), `README.md` (quick start), `site/index.html` (3 occurrences), and `src/App.tsx` (`appInfo` initial state).

### Known discrepancies to fix in the docs wave (not blockers)

_Both items below were resolved in Waves 4 and 6 (2026-09-25)._

- `README.md` → *Development* mentions `docker compose --profile dev up app-dev`, but `compose.yaml` defines no `app-dev` service or `dev` profile.
- The `docs/ARCHITECTURE.md` API list omits the MCP key endpoints, recovery-code endpoints, and `/mcp`.

---

## 2. Scope summary

The remaining requested work, in delivery order:

1. **Release Wave 2** (Home app selector with separate **Notes** and **Files** apps and a shared **Bin**) after independent review.
2. **Secure documents backend:**
   - migration `006`
   - UUID-only private disk storage
   - bounded, streamed multipart uploads
   - MIME sniffing and a safe preview allowlist
   - authenticated content responses with Range support
   - folder ACL inheritance with document-level sharing precedence (same semantics as notes)
   - rename, move, download, soft delete
3. **Shared Bin:** migration `007`, a 30-day restore/purge window for **both notes and documents**, and idempotent, failure-safe purge.
4. **Files UI:** desktop and mobile. Upload queue, preview, rename, download, move, share, delete; drag/drop upload and drag-to-folder move; a mobile Move sheet; mobile browser history.
5. **Ops and docs:** env vars, Compose, backup behavior, migrations, README/ARCHITECTURE/site.

---

## 3. Key decisions (binding unless explicitly revised)

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Files and Notes share the **same folder tree** (`folders` table). A folder can contain notes and documents. Each app lists only its own item type. | "Store supporting documents next to your note folders" (Home copy). No second ACL system. |
| D2 | A document has exactly one owner. Only the owner may upload into their folders, rename, move, share, delete, restore, or purge. Recipients get **read** access only: list, preview, download. | Matches the notes model. Collaborative writes are out of scope. |
| D3 | Document sharing uses the note semantics. By default a document **inherits the ACL of its immediate folder** (`sharing_override=0`). A document-level setting (`private`/`selected`/`all_users`, `sharing_override=1`) **takes precedence** over the folder. Folder sharing does **not** cascade to subfolders. | Consistent with the current notes implementation and UI. Recursive inheritance is out of scope. |
| D4 | On disk a document is stored only under its server-generated UUID: `documents/objects/<uuid>`. The user filename exists only in SQLite and is never used in a path. Rename and move change metadata only. | Removes path traversal, name collisions, and Unicode or case issues. |
| D5 | Uploads are `multipart/form-data` with exactly **one** file part per request. The body is **streamed** to a staging file on the data volume, with no whole-body buffering in memory. Size, part count, and header limits are enforced while streaming. The client queues multiple files. | Bounded memory. `/tmp` is a 64 MB tmpfs, so staging must live on `/data`. |
| D6 | The server stores **any** file type up to the limit. The **preview kind** comes from server-side magic-byte sniffing, never from the client MIME type or the extension alone. Only an allowlist is rendered inline. Everything else is download-only as `application/octet-stream` with `Content-Disposition: attachment`. | This is a file store. Safety comes from never rendering untrusted active content, not from rejecting uploads. |
| D7 | SVG, HTML, XML, JavaScript, Office files, archives, and executables are **never** previewed inline. | Stored XSS and polyglot risk. |
| D8 | PDF preview opens the authenticated inline URL in a **new top-level tab**. It is never embedded in an iframe, `<object>`, or `<embed>`. Global `frame-ancestors 'none'` and `X-Frame-Options: DENY` stay in force. | Keeps clickjacking and framing protections. No PDF.js dependency. |
| D9 | Text preview is fetched by the client with `Range: bytes=0-1048575` and rendered with React text nodes in a `<pre>`. It is never rendered as HTML or Markdown. | Zero HTML injection surface. |
| D10 | Content responses support a single byte range (`206`), `416` for unsatisfiable ranges, and `If-Range`. Multi-range requests are answered with a full `200`. | Enables media seeking and resumable downloads without multipart/byteranges complexity. |
| D11 | Deleting a note or document moves it to the **Bin** for exactly **30 days** (`purge_after = deleted_at + 30 days`, UTC). Items in the Bin are invisible to everyone except the owner's Bin view, including MCP. Their share rows are **retained**, so restore brings sharing back as it was. Retention is a constant, not configurable. | Requirement. Predictable restore. |
| D12 | Empty, never-published notes (the blank-note cleanup path) are **purged immediately** and never appear in the Bin. Any note with content, published or not, goes to the Bin. | Avoids a Bin full of blank notes while keeping unpublished drafts recoverable. |
| D13 | Purge is a tombstone state machine: set `purge_started_at` → remove files (ENOENT counts as success) → delete the row. Each step is idempotent. A sweeper resumes interrupted purges. Restore uses compare-and-swap and refuses rows with `purge_started_at` set. | Crash-safe. Content is never reachable after a purge begins. |
| D14 | Restore goes to the original folder if it still exists and is owned by the item owner. Otherwise it goes to the owner's Default folder. | Folders may have been deleted meanwhile. |
| D15 | Folder deletion semantics are **unchanged**: subfolders cascade, and contained notes and documents get `folder_id = NULL` through FK `SET NULL`. An item with a NULL folder is private unless it has an override, and it appears under "All". | Keeps the notes behavior. A separate folder-delete UX redesign is out of scope. |
| D16 | Duplicate filenames in a folder are allowed. The server never renames automatically. | No race conditions, and it matches common file-manager behavior. |
| D17 | **Superseded by Wave 8 (docs/plan/WAVES_7-9.md §4):** MCP keys carry scopes; notes get draft-only writes, documents get read-only text tools, task tools follow. Original: Documents are excluded from MCP in this scope. | MCP is read-only for notes. Exposing binaries needs its own design. |
| D18 | **Superseded by D21 (Wave 2b): history entries are now pushed on desktop and mobile.** Original text: Browser history entries are pushed only on mobile viewports, for all apps. This is unchanged from Wave 1 and Wave 2. On `popstate`, any open Files or Bin dialog closes before the panel snapshot is restored. | Parity with existing behavior. |
| D19 | Delivery order is Files backend (W3) → Bin (W4) → Files UI (W5). The Bin ships before the Files UI, so no user ever deletes a file without a working Bin. | Avoids a period where delete copy promises a restore that doesn't exist yet. |
| D21 | **(Added 2026-09-25, operator request.) Every app, view, and item gets its own URL** (`/`, `/notes`, `/notes/folder/:id`, `/notes/shared`, `/notes/:noteId`, `/files`, `/files/folder/:id`, `/files/:documentId`, `/bin`). Real history entries are pushed on desktop **and** mobile. This supersedes the mobile-only rule in D18 once Wave 2b ships; the mobile panel hint (`folders`/`list`/`editor`) stays as history state layered over the URL. No new dependency: a small in-house router (`src/router.ts`) over `history.pushState` and `popstate`. | Shareable and bookmarkable links, and later features (Files, Bin, MCP deep links) need addressable items. The production server already serves `dist/index.html` for every non-API path. |
| D91 | **(Added 2026-09-26, operator rule.) Every dropdown in the product is a custom, accessible UI component (`src/ui/Combobox`/`Select`, keyboard + touch + type-to-search where it lists more than a handful of items). Native `<select>` is not used in new work, and the existing native selects (Calendar calendars picker, Collections sort/filter/field editor/import/cells, Task card dialog, Event sheet) are migrated in Wave 13.** | Consistent look on phones and desktop; native selects render inconsistently across mobile browsers and cannot host search or multi-select. |
| D92 | **(Added 2026-09-26, operator request.) Settings gets a left-nav item "Modules" where each module (Notes, Files, Tasks, Collections, Calendar, Search, Bin, Team, …) can be turned on or off per user. All modules are on by default. Turning a module off hides it from the Today launcher, the header nav, routes (redirect to `/` with a hint), search facets, and Today sections; it never deletes data and the server keeps enforcing authorization independently of the toggle. Stored as a per-user preference (server side so it follows the account across devices).** | Lets each person keep the workspace focused. A hidden module must not become a security boundary. |
| D93 | **(Added 2026-09-28, operator decision.) Outbound email goes through the `resend` npm package** (exact-pinned). Configuration lives only in `.env`: `RESEND_API_KEY` and `MAIL_FROM` (display name + address). When either is unset, email is off and every send path degrades to an "Email is not configured" note. A single `server/mail.ts` wrapper (rate-limited, timeout-bounded, no addresses or secrets in logs, test transport in the suite) is the only place that talks to the provider; consumers: Team invites (Wave 18), then Calendar reminders and notification digests. | One provider, one config surface, no email logic scattered across modules. |
| D289 | **(Added 2026-09-29, Wave 35.) Google sign-in is a server-side OpenID Connect code flow with PKCE (S256), `state`, and `nonce`; the ID token is verified with WebCrypto against Google's JWKS; no new dependency; the redirect URI comes only from `APP_ORIGIN`.** Details: [docs/plan/WAVE_35_GOOGLE_SIGNIN.md](docs/plan/WAVE_35_GOOGLE_SIGNIN.md) §1. | Standard flow for a confidential client; no Host-header influence. |
| D290 | **(Wave 35.) `AUTH_METHODS` = `password` (default) \| `google` \| `both`; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` required with google (startup refuses otherwise); optional `GOOGLE_ALLOWED_DOMAINS`; `ALLOWED_EMAILS`, `ALLOW_REGISTRATION`, `SIGNUP_ROLE` apply to Google too.** | Upgrades behave as before. |
| D291 | **(Wave 35.) Google flow state is a server row keyed by the hash of an HttpOnly `SameSite=Lax` cookie token (10 min, single use), holding the state hash, nonce, PKCE verifier, intent, return path, and an invite hash.** | Google's return is a cross-site GET; the invite token never enters a URL. |
| D292 | **(Wave 35, revised after review.) Callback resolution: by `sub`; else link by email only when Nook verified the address and Google is authoritative for it (or an admin allowance is live), otherwise `link_required` with no change; else create only when registration would be allowed, through one shared `createAccount` helper.** | One path for every way in; `email_verified` alone does not prove ownership. |
| D293 | **(Wave 35, revised after review.) No automatic link or reset for never-verified accounts. An admin (Team → member, or `team-admin.ts allow-google-link [--reset]`) allows the next Google sign-in for 24 hours, optionally resetting the account first: credentials plus every share, member row, group grant, live invite, and routine. Linking from Settings needs re-authentication.** | Pre-hijacking without trusting the server to tell owner from squatter. |
| D294 | **(Wave 35.) Accounts without a password store the sentinel `!unusable:google`; `verifyPassword` rejects any `!` hash before hashing, on every path.** | No schema change; one choke point. |
| D295 | **(Wave 35.) The server enforces `AUTH_METHODS`: password routes answer 403 `PASSWORD_SIGNIN_DISABLED` in google mode, Google routes 404 `GOOGLE_SIGNIN_DISABLED` in password mode; `/api/about` reports `authMethods`. Host CLIs work in every mode.** | UI hiding is not a control. |
| D296 | **(Wave 35.) Google sign-in still asks for the Nook TOTP or recovery code before a session exists, with the password sign-in limits.** | Google is one factor. |
| D297 | **(Wave 35, revised after review.) Google re-authentication (prompt=login, max_age=0, auth_time within 5 minutes; bound to the session, 5 minutes) replaces the password only for accounts whose re-auth method is Google (no usable password, or AUTH_METHODS=google).** | Such accounts can still create keys and enable two-factor; password accounts keep the password. |
| D298 | **(Wave 35.) Invites accept Google: the token is posted once and kept server side, a bound invite needs the same Google email, the role comes from the invite, and the claim is in the creating transaction.** | Same guarantees as password registration. |
| D299 | **(Wave 35.) Google avatars are downloaded by the server (https, `*.googleusercontent.com`, 5 s, 1 MiB, PNG/JPEG/WebP by magic bytes), stored as `DATA_DIR/avatars/<uuid>`, and served same-origin at `/api/users/:id/avatar?v=` only to payloads that already show the name; one shared client `Avatar` falls back to letters.** | No hotlinking or CSP change. |
| D300 | **(Wave 35.) Sign-in renders the configured methods; return paths are validated same-origin paths; errors come back as `/login#error=<code>`; Settings → Security links and unlinks Google; CSP is unchanged.** | Mobile, Back/Forward, and D91 rules. |
| D20 | No new runtime dependency except **`busboy`** (exact-pinned, lockfile committed) for streaming multipart parsing. MIME sniffing is an in-house signature table. | Small, well-known parser. A hand-rolled multipart parser is riskier. |

---

## 4. Wave 2 release: independent review checklist

Wave 2 is already implemented in local commit `cb59b6a` and is **pending independent review**. Before releasing it, an independent reviewer (a fresh session or `/code-review high` on `origin/main..cb59b6a`) must check each item below and record a finding or "no issue" for each. The items are **review gates: checks to run, not confirmed bugs**. Nothing here has been reproduced yet.

Gates **G2.1** and **G2.2** are blocking: Wave 2 cannot be released until each has a recorded outcome (fixed, or accepted by the operator with a reason in `TODO.md`).

1. **G2.1 Draft finalization when leaving Notes for Home (blocking review gate).** Facts from the code: `selectNote`, `selectFolder`, `createNote`, and `restoreMobileHistory` run `removeEmptyNewNote()` and then `publish(false)` when `hasPublishableDelta` (which saves the draft first). `openHome()` does neither; it only pushes a history entry on mobile and sets `activeApp`. `App` stays mounted while Home is shown, so the 900 ms autosave timer in `App` is not cancelled by leaving Notes. The reviewer must determine, on desktop and mobile:
   - whether an edited draft is saved, and whether it should also be auto-published as it is when switching notes
   - whether a blank never-published note created just before leaving is left behind (and whether it is cleaned up later)
   - whether Back from Notes to Home on mobile (popstate with `section = "home"`) has the same behaviour as the brand button

   If the reviewer confirms a gap, the expected fix is to run the same `removeEmptyNewNote()` → `publish(false)` sequence (guarded by `switchingRef`) before switching away from Notes, in both `openHome()` and the popstate path. If it is not a gap, record why.

   **Outcome (2026-09-25):** confirmed and fixed. Leaving Notes uses the shared `finalizeOpenNote` helper but publishes with a reload (`publish(true)`), because the note stays selected and a stale draft revision would make the next save fail. See `TODO.md`.
2. **G2.2 Settings and sign-out reachable from Home (blocking review gate).** Facts from the code: `AppHome` and `AppPlaceholder` render no Settings or Sign-out control; both live in the Notes sidebar. After login every user lands on Home. The reviewer must confirm whether reaching account settings and signing out only through Notes is acceptable (operator decision), or add a small account menu (Settings, Sign out) to the Home and placeholder headers. Either way, verify that `TOTP_POLICY=required` users without an enrolled factor still bypass Home and land in the workspace with Settings open (`!session.totp.setupRequired` guards in `App`).
3. **Popstate routing.** `writeMobileHistory` pushes spread the prior state, so they inherit whatever `mynotes.app-shell` section the previous entry had. Entries created before Wave 2 have no section key and fall through to the notes snapshot handler even when `activeApp` is `home`. On a real mobile viewport, verify Back/Forward across Home ⇄ Notes (folders/list/editor) ⇄ Files/Bin placeholders, including Forward after Back.
4. **Reload always lands on Home.** The active app is not persisted. Confirm this is intended. Notes still resume their last folder and note through `localStorage`.
5. **Desktop** does not push history for app switches, so browser Back leaves the SPA. This is consistent with D18. Confirm.
6. **Accessibility.** Cards are real buttons. Check the focus order, the visible focus ring, the `aria-label` on the sidebar brand button, and reduced-motion behavior.
7. **Copy.** The Files and Bin cards say "Coming next / Preview". This is acceptable for v0.2.3. W4 and W5 replace it.
8. **Tests** cover only the history helpers. Add a test only if a review finding needs one.

**Release steps (after the review is addressed):**

1. Record the outcome of every item above in `TODO.md` (G2.1 and G2.2 must say fixed or operator-accepted). Commit any review fixes (`fix: …`).
2. Bump to `0.2.3` in every version location listed in §1 (`chore: bump version to 0.2.3`).
3. Run all gates (§12).
4. With operator approval, push `main`.
5. Deploy with `APP_VERSION=0.2.3 GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`.
6. Smoke test: login, Home, Notes, Back/Forward on a mobile viewport, `/api/about` version and SHA.
7. Update `TODO.md`.

There is no migration in Wave 2, so a pre-deploy backup is recommended but not required.

---

## 4b. Wave 2b: URL routing (v0.2.4, before Wave 3)

Added 2026-09-25 at the operator's request. Delivered as its own wave between the Wave 2 release and the Files backend, so that the Bin app (W4) and Files UI (W5) are built on routes rather than on `/` plus history state.

Scope:

1. `src/router.ts`: pure `parseRoute(pathname) → Route | null` and `formatRoute(route) → string` with unit tests. Routes: `home`, `notes` (`folder: "all" | "shared" | uuid`, `noteId: uuid | null`), `files` (same shape with `documentId`), `bin`. Unknown paths resolve to `home`; malformed ids are ignored, not thrown.
2. `App.tsx` navigates by pushing a URL (`navigate(route, { replace? })`) and reacts to `popstate` by parsing `location.pathname`. Desktop and mobile both push entries. The mobile panel (`folders`/`notes`/`editor`) remains a history-state hint layered over the URL through the existing helpers, so Wave 1 behaviour (Back between panels) is unchanged on phones.
3. Leaving a note through any URL change runs `finalizeOpenNote` first; on failure the URL is restored (`replaceState`) and the note stays open with a toast, mirroring the current `leaveNotes` contract.
4. Deep links: an unauthenticated visit to `/notes/<id>` shows login and then resumes that URL. Ids that are missing or not readable fall back to the containing list (`/notes`), never to an error page.
5. Server: no change beyond confirming that the production SPA fallback (`serveStatic({ path: "./dist/index.html" })`) covers the new paths and that `/api/*` keeps its JSON 404.
6. `localStorage` resume of the last folder/note applies only when the URL is `/notes` with no id.

Out of scope: history entries for dialogs (settings, share, history panels), and query-string state.

Gate: router unit tests, all existing tests, desktop + 390 px manual matrix (Home ⇄ each app ⇄ item, Back/Forward, reload on every route, deep link while logged out), then release v0.2.4.

**Outcome (2026-09-25):** implemented in `dbdf321`, `f0a84a3`, `aa7f5d5` with review fixes `521e39e`, `8d07456`, `81c548c`, `d5cfe58`, and the failed-load recovery fix `b6200cf`. Deviations from the sketch above: (a) the localStorage resume applies whenever the URL names no folder or note (so Home → Notes returns to the last note), and bare `/notes` is then rewritten to the resumed note; (b) a same-folder click keeps the open note; (c) a `mynotes.depth` counter in history state lets in-app Back decide between `history.back()` and a panel change without leaving the site; (d) a failed first load is retried on the next route change rather than blocking. Waves 4 and 5 must route Bin and Files views through `src/router.ts` and `navigate()`.

---

## 5. Data model

### 5.1 Migration `006_documents` (Wave 3)

File: `server/migrations/006_documents.ts`. Register it in `server/migrations/index.ts` and update the migration-id assertion in `tests/api.test.ts` to `[1,2,3,4,5,6]`. Migrations must not touch the filesystem.

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,                                   -- server-generated UUID; also the storage object name
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255), -- display name only; app enforces ≤255 UTF-8 bytes
  mime_type TEXT NOT NULL,                               -- sniffed canonical type, or application/octet-stream
  preview_kind TEXT NOT NULL CHECK (preview_kind IN ('image','pdf','text','audio','video','none')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),      -- lowercase hex, computed while streaming
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
  sharing_override INTEGER NOT NULL DEFAULT 0 CHECK (sharing_override IN (0,1)),
  upload_key TEXT,                                       -- client Idempotency-Key (UUID), optional
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purge_after TEXT,
  purge_started_at TEXT,
  CHECK ((deleted_at IS NULL AND purge_after IS NULL) OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL))
);
CREATE TABLE document_shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX idx_documents_owner_folder ON documents(owner_id, folder_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_folder_live ON documents(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_bin ON documents(owner_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_documents_purge ON documents(purge_after) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX idx_documents_upload_key ON documents(owner_id, upload_key) WHERE upload_key IS NOT NULL;
CREATE INDEX idx_document_shares_user ON document_shares(user_id, document_id);
```

Notes:

- The Bin columns exist from day one. In Wave 3 they are written only by `DELETE /api/files/:id`. The purge worker and restore arrive in Wave 4, in the same release as Wave 3 (§11).
- `users ON DELETE CASCADE` removes rows but not bytes. Orphaned objects are collected by the boot sweep (§6.5). There is no user-deletion flow today.
- Audit events for documents use `audit(actor, null, "document.*", { documentId, ... })`. `audit_log` has no `document_id` column, and one is not added.
- Add `DocumentRow` to `server/db.ts`.

### 5.2 Migration `007_bin` (Wave 4)

File: `server/migrations/007_bin.ts`. Update the test assertion to `[1..7]`.

```text
addColumn(notes, deleted_by,       "TEXT REFERENCES users(id) ON DELETE SET NULL")
addColumn(notes, purge_after,      "TEXT")
addColumn(notes, purge_started_at, "TEXT")
CREATE INDEX idx_notes_bin   ON notes(owner_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_notes_purge ON notes(purge_after)              WHERE deleted_at IS NOT NULL;
```

Backfill of legacy soft-deleted notes. Use one timestamp `T` captured in the migration.

- `deleted_at IS NOT NULL AND current_version > 0` → `purge_after = T + 30 days`, `deleted_by = owner_id`. This gives a grace period: legacy deletions become restorable for 30 days from upgrade, not from the original delete.
- `deleted_at IS NOT NULL AND current_version = 0` → `purge_after = T` (purged on the first sweep), `deleted_by = owner_id`. These never had published content. Their files were already removed or are empty drafts.

Add `deleted_by`, `purge_after`, and `purge_started_at` to `NoteRow`.

---

## 6. Storage design (Wave 3)

### 6.1 Layout

Everything lives under the bind-mounted host data directory, `/data` in the container:

```text
/data
├── mynotes.sqlite (+ -wal, -shm)
├── notes/<note-uuid>/…                 (unchanged)
├── documents/
│   ├── objects/<document-uuid>          file bytes, mode 0600, no extension
│   └── .staging/<document-uuid>.part    in-flight uploads, mode 0600
└── backup/                              (host backup script only)
```

Directories are `0700` and are created through the existing `ensureDirectory()` confinement and symlink checks. A flat `objects/` directory is fine at personal scale. Sharding is out of scope.

### 6.2 Module

Create `server/documentStorage.ts`. Reuse `withinDataRoot`, `ensureDirectory`, and `syncDirectory` by exporting them from `server/storage.ts`. Do not duplicate them. Generalize `withNoteLock` into `withResourceLock(key, op)` and keep `withNoteLock` as a thin wrapper, so notes and documents share one lock map with keys `note:<id>` and `document:<id>`.

API sketch:

- `createStagingFile(id) → { handle, path }` opens with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` at mode `0600`.
- `commitStaged(id)` fsyncs the file, renames `.staging/<id>.part` → `objects/<id>`, then fsyncs both directories. Rename is atomic because both paths are on the same filesystem.
- `discardStaged(id)` unlinks the staging file, ignoring ENOENT.
- `openObjectForRead(id, expectedSize) → { fd, size }` checks that the path is a regular non-symlink file (`lstat`), opens with `O_RDONLY|O_NOFOLLOW`, and verifies that `fstat.size === expectedSize`. A mismatch throws an integrity error.
- `removeObject(id)` unlinks and treats ENOENT as success.
- `sweep()` implements §6.5.

Every id passes the existing UUID regex before any path is built.

### 6.3 Upload pipeline

Endpoint: `POST /api/files?folderId=<uuid>`. Full contract in [API_CONTRACTS.md](docs/plan/API_CONTRACTS.md#upload).

1. **Middleware exception.** `requireMutationSafety` allows `multipart/form-data; boundary=…` **only** for `POST /api/files` (exact path). Origin and CSRF checks still apply. Every other route keeps the JSON-only rule, and a test must prove that multipart is rejected elsewhere with 415.
2. **Pre-checks before reading the body:**
   - The folder is owned by the caller. If it is absent, use `ensureDefaultFolder`.
   - If `Content-Length` is present and exceeds `MAX_UPLOAD_BYTES + 64 KiB`, return 413.
   - Acquire a per-user upload slot (max **3** concurrent; otherwise 429).
   - Check the quota: `used + reserved + (content-length ?? MAX_UPLOAD_BYTES) > USER_STORAGE_QUOTA_BYTES` → 507 with `code: "QUOTA_EXCEEDED"`. `used` counts live **and binned** documents that are not yet purged.
   - Check free space with `fs.promises.statfs(DATA_DIR)` (`bavail * bsize`): less than `MIN_FREE_DISK_BYTES + expected size` → 507 with `code: "DISK_FULL"`. `statfs` works in the local Bun 1.4.x; confirm it also works in the pinned container image (`oven/bun:1.2.22`) during the `docker build --target verify` gate.
3. **Streaming parse.** Pass `busboy({ headers, limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_UPLOAD_BYTES, headerPairs: 20, fieldNameSize: 100 }, defParamCharset: "utf8" })` a stream built with `Readable.fromWeb(c.req.raw.body)`. Reject (400) any extra part, a non-file field, or a field name other than `file`. On `limit` (truncated), abort, discard staging, and return 413.
4. **While streaming:**
   - write chunks to the staging handle, respecting backpressure
   - update a SHA-256 hasher and a byte counter
   - keep the first **4100 bytes** in memory for sniffing

   If the client aborts or the stream errors, discard staging and release the slot and reservation.
5. **Finish:**
   - fsync and close
   - sniff (§7.1)
   - sanitize the name (§6.4)
   - `commitStaged(id)`
   - in one DB transaction: re-check quota with `SUM(size_bytes)`, `INSERT` the documents row, and write the audit event `document.upload { documentId, size, mimeType }` (no filename)
   - if the transaction fails, `removeObject(id)` and rethrow
6. **Idempotency.** If an `Idempotency-Key: <uuid>` header is present and a row with `(owner_id, upload_key)` already exists, return that document with **200** without keeping the new bytes. This check runs before streaming, and again on a unique-constraint race, in which case the new object is removed and the existing row returned. The Files UI always sends a per-queued-file key, so retries after network failures never create duplicates.
7. **Always** release the slot and reservation in `finally`.

**Body-limit refactor (prerequisite, first W3 commit).** Raising Bun's `maxRequestBodySize` above today's 2.1 MB would remove the only real cap on chunked JSON bodies. Before raising it:

- Replace `parseJson()` with a bounded reader that consumes `request.body` and aborts with 413 past 2.1 MB, regardless of `Content-Length`.
- Apply the same bounded read to `/mcp` before `handleMcpRequest`, for example by cloning a bounded body into a new `Request`.

Add tests that send a chunked JSON body over 2.1 MB to a JSON route and to `/mcp` and expect 413 **from the bounded reader** (assert its JSON error body, not just the status). Bun's own cap must be above 2.1 MB in that test run, or the test passes for the wrong reason; see the harness limits in the test plan. Set Bun's cap to `max(MAX_UPLOAD_BYTES, 2_100_000) + 1 MiB` so a small upload limit never lowers the JSON limit.

**Verify during implementation:** confirm that Bun streams `request.body` for large uploads, rather than buffering. Upload a file near `MAX_UPLOAD_BYTES` and watch the process RSS (`docker stats` or `process.memoryUsage().rss` in a test). RSS growth must stay far below the file size. If Bun buffers, stop and redesign before continuing, for example by lowering the limit or chunking uploads.

### 6.4 Filename rules

The display name only.

- Apply Unicode NFC normalization.
- Remove C0/C1 control characters, U+007F, bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E/U+200F), and zero-width characters U+200B–U+200D and U+FEFF.
- Replace `/`, `\`, and `:` with `-`.
- Collapse whitespace and trim leading/trailing whitespace and dots.
- Reject an empty result, `.`, and `..`. On upload, fall back to `Untitled`. On rename, return 400.
- Truncate to 255 UTF-8 bytes on upload (preserving the extension when possible). Rename rejects names over 255 bytes with 400.

Use one shared function, `sanitizeDisplayName()`, in `server/validation.ts` with unit tests.

### 6.5 Sweeper (boot and hourly)

At boot, after migrations and `reconcilePublishedMirrors`, start the sweeper without awaiting it before the server starts listening. After that it runs hourly with `setInterval(...).unref()`. A single-flight guard prevents overlap. Each run:

1. Deletes `documents/.staging/*.part` older than 1 hour. At boot all of them can go, because nothing is in flight.
2. Deletes objects in `documents/objects/` whose name is a UUID, that are regular files, that have no `documents` row, and that are older than 1 hour. These are orphans from a crash between rename and insert, or from a user cascade.
3. **(Wave 4)** Resumes purges for rows with `purge_started_at IS NOT NULL`, then purges due rows (`deleted_at IS NOT NULL AND purge_after <= now`), in batches of 100 per run for notes and documents (§9.3).
4. Logs **counts only**: no names, no ids beyond what existing logs already include, and no content.

A live row whose object is missing is logged as an integrity error (a count at boot). The content endpoint returns 500 with a generic message for it.

---

## 7. MIME sniffing and preview allowlist (Wave 3)

### 7.1 Sniffer

Create `server/mimeSniff.ts`: a pure function `sniff(head: Uint8Array, name: string, totalSize: number) → { mimeType, previewKind }`. It is unit-tested and has no I/O.

| previewKind | mimeType | Signature (on the first bytes) | Extra condition |
| --- | --- | --- | --- |
| image | `image/png` | `89 50 4E 47 0D 0A 1A 0A` at 0 | none |
| image | `image/jpeg` | `FF D8 FF` at 0 | none |
| image | `image/gif` | `GIF87a` or `GIF89a` at 0 | none |
| image | `image/webp` | `RIFF` at 0 and `WEBP` at 8 | none |
| pdf | `application/pdf` | `%PDF-` at 0 | none |
| audio | `audio/mpeg` | `ID3` at 0, **or** frame sync `FF E0–FF` mask at 0 | frame-sync variant requires a `.mp3` extension |
| audio | `audio/ogg` | `OggS` at 0 | none |
| audio | `audio/wav` | `RIFF` at 0 and `WAVE` at 8 | none |
| video | `video/mp4` | `ftyp` at 4 with major brand in {`isom`,`iso2`,`mp41`,`mp42`,`avc1`,`M4V `,`M4A `,`dash`} | `M4A ` → `audio/mp4`, previewKind `audio` |
| video | `video/webm` | `1A 45 DF A3` at 0 and ASCII `webm` within the first 64 bytes | none |
| text | `text/plain; charset=utf-8` | none | extension in {`.txt`,`.md`,`.markdown`,`.csv`,`.tsv`,`.log`,`.json`}, the sample (up to 4100 bytes, ignoring a truncated trailing code point) is valid UTF-8 with **no NUL bytes**, and it is not an empty file |
| none | `application/octet-stream` | everything else | covers SVG, HTML, XML, JS, Office, archives, executables, HEIC/HEIF/TIFF/BMP/ICO, and unknown types |

The client-declared `Content-Type` of the part is ignored for classification. It may be logged at debug level only.

### 7.2 Rendering rules (Wave 5 UI, Wave 3 headers)

| previewKind | UI rendering | Inline allowed? |
| --- | --- | --- |
| image | `<img src="/api/files/:id/content?disposition=inline" alt={name}>` with `loading="lazy"`, contained in the preview pane. No blob URLs, because CSP `img-src` has no `blob:`. | yes |
| pdf | An "Open preview" button that opens the inline URL in a new tab (`target="_blank" rel="noopener noreferrer"`). Metadata plus a download button in the pane. | yes, as top-level navigation only |
| text | `fetch` with `Range: bytes=0-1048575`, decoded as UTF-8 and rendered as React text in `<pre>`. A notice appears when truncated (`size_bytes > 1 MiB`). | fetched, never navigated |
| audio / video | `<audio controls preload="metadata">` / `<video controls preload="metadata" playsInline>` pointing at the inline URL. Range makes seeking work. | yes |
| none | Icon plus metadata plus Download. There is no inline URL. The server forces `attachment` even if `disposition=inline` is requested. | no |

Content response headers (see [API_CONTRACTS.md § content](docs/plan/API_CONTRACTS.md#content)) must include:

- `X-Content-Type-Options: nosniff`
- `Content-Disposition` with an RFC 6266/5987 encoded filename
- `Cross-Origin-Resource-Policy: same-origin`
- `Cache-Control: private, no-store`
- a route-specific `Content-Security-Policy: default-src 'none'; sandbox` for every non-PDF response

For PDF, drop `sandbox`, because Chromium's viewer does not render in sandboxed documents. Use `default-src 'none'; frame-ancestors 'none'`, and verify that the built-in viewers in Chromium and Firefox still render. If one does not, record the minimal relaxation in this file and in the threat model.

**Known constraint (checked in the installed Hono 4.13.8):** `secureHeaders` calls `await next()` and then `ctx.res.headers.set(...)` for every configured header, so it **will overwrite** a route-specific `Content-Security-Policy` (and any other header it manages). Do not rely on setting the CSP inside the route. Instead, wrap the global middleware so it skips exactly `GET|HEAD /api/files/:id/content`, and have the content route set the full header set itself: its CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CORP, and Cache-Control. Add a test that asserts the exact CSP on a content response, and a test that the SPA and other `/api` responses still carry the global CSP.

---

## 8. Authorization (Waves 3–4)

- Create `server/documentAccess.ts` with `readableDocument(id, userId)` and `ownedDocument(id, userId, { includeDeleted })`. The readable predicate mirrors notes exactly:

  ```sql
  d.id = ? AND d.deleted_at IS NULL AND (
    d.owner_id = :user
    OR (d.sharing_override = 1 AND (d.visibility = 'all_users'
        OR (d.visibility = 'selected' AND EXISTS (SELECT 1 FROM document_shares s WHERE s.document_id = d.id AND s.user_id = :user))))
    OR (d.sharing_override = 0 AND EXISTS (SELECT 1 FROM folders f WHERE f.id = d.folder_id AND (
        f.visibility = 'all_users'
        OR (f.visibility = 'selected' AND EXISTS (SELECT 1 FROM folder_shares fs WHERE fs.folder_id = f.id AND fs.user_id = :user))))))
  ```

- List responses mask `folder_id` for recipients unless the folder itself is visible to them, which is the same rule as `GET /api/notes`. The effective `visibility` is `COALESCE(folder.visibility,'private')` when inheriting.
- Every mutation requires `ownedDocument`. Targets in move and upload must be folders **owned by the caller**, even if the caller can see another user's shared folder.
- Missing, forbidden, and binned (for non-owners) all return **404**. Never 403 for existence.
- Moving an inheriting document into a shared folder widens its audience immediately, and moving it out narrows it. The UI shows the new effective visibility in the success toast (parity with notes; this accepted risk is recorded in the threat model).
- Leave the notes ACL code untouched in these waves. Add a parity test that runs the same share matrix against notes and documents.

---

## 9. Shared Bin (Wave 4)

### 9.1 Semantics

- **Notes enter the Bin through:**
  - `DELETE /api/notes/:id`
  - `DELETE /api/notes/:id/draft` on a never-published note that has non-empty draft content

  Both set `deleted_at = now`, `deleted_by = caller`, and `purge_after = now + 30d` under `withNoteLock`. **Remove** the immediate `storage.deleteUnpublished` call for notes with content. On the draft route's Bin path, also **stop** nulling `draft_revision`/`draft_checksum` and **stop** calling `storage.discardDraft`; otherwise the binned note has no content to restore.
- **Immediate purge (D12):** a note is blank when `current_version = 0` and either there is no draft or the draft content (read with `storage.readDraft` under the lock) is empty after `trim()`. This matches the client's `markdown.trim() === ""` check in `removeEmptyNewNote()`, which depends on this path. Do not rely on `draft_checksum = checksum("")` alone, because a whitespace-only draft has a different checksum. Blank notes are purged synchronously (§9.3) and return `{ ok: true, purged: true }`.
- **Documents enter the Bin through** `DELETE /api/files/:id`, which already exists from W3.
- **Visibility:** every existing read path already filters `deleted_at IS NULL`. Keep it that way, and add tests for list, read, content, versions, sharing, and MCP.
- **Retained while binned:** share rows, versions, drafts, and bytes are all kept.
- **Restore** (owner only):
  - CAS `UPDATE … SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = now WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`
  - folder fallback per D14. Falling back to Default can change the effective audience of an inheriting item (Default may be shared), so the restore response and toast report the new effective visibility, as moves do.
  - audit `note.restore` / `document.restore`

  An already-live item returns 200 `{ alreadyRestored: true }`. An item with a purge in progress returns 409 `{ code: "PURGING" }`.
- **Delete forever** (owner only) runs §9.3 immediately. It is idempotent: a row already purging returns 200, and a missing row returns 404. The client treats 404 on a retry as done.
- **Empty Bin** runs §9.3 for each of the caller's binned items independently, in batches, and reports `{ ok: true, purged, pending }` (API_CONTRACTS is authoritative). Partial failures are retried by the sweeper, because `purge_started_at` stays set.

### 9.2 Bin API

`GET /api/bin`, `POST /api/bin/:type/:id/restore`, `DELETE /api/bin/:type/:id`, `DELETE /api/bin`. `:type ∈ {note, document}`. Contracts are in [API_CONTRACTS.md § Bin](docs/plan/API_CONTRACTS.md#bin).

### 9.3 Purge algorithm (idempotent, crash-safe)

The purge runs under `withResourceLock`.

1. `UPDATE <table> SET purge_started_at = COALESCE(purge_started_at, now) WHERE id = ? AND deleted_at IS NOT NULL` (plus `owner_id = ?` for user-initiated calls). 0 rows means the item is gone or live, so stop.
2. Remove bytes:
   - note → `rm -r notes/<id>` through the confinement helpers
   - document → `removeObject(id)`

   ENOENT is success. On any other error, leave the row with `purge_started_at` set and let the sweeper retry. Log the error class only.
3. In a transaction, `DELETE FROM <table> WHERE id = ? AND purge_started_at IS NOT NULL`. Cascades remove versions, shares, and the documents row. Audit `note.purge` / `document.purge` with metadata `{ noteId | documentId, reason: "user" | "retention" | "blank" }`. `audit_log.note_id` becomes NULL through the FK, so the id must also be in the metadata.

A row with `purge_started_at` set is **never** readable or restorable. Every read predicate already requires `deleted_at IS NULL`, and restore requires `purge_started_at IS NULL`.

### 9.4 Bin UI

`src/bin/BinApp.tsx`:

- **Layout:** a Home button and title. A list of the caller's binned items (notes and documents together), newest deletion first. Each row shows a type icon, title or name, original folder name (or "Default" when it will fall back), "Deleted <relative time>", "Deletes in N days", and the size for documents. A filter chip switches between **All / Notes / Files**.
- **Actions:**
  - **Restore.** Toast: "Restored to <folder>".
  - **Delete forever.** Confirm: "Permanently delete “name”? This can't be undone."
  - **Empty Bin.** Confirm with the count. Disabled when the Bin is empty.
- **States:** an empty state ("Nothing in the Bin. Deleted notes and files stay here for 30 days."), loading, error with retry, and a per-row pending state.
- **Mobile:** a single panel. Row actions go in a ⋯ action sheet. Only the app-level history entry is used (no sub-panels).
- **Copy updates:**
  - Home Bin card becomes live: "Restore deleted notes and files for 30 days".
  - Note delete confirm: "Move “title” to the Bin? You can restore it for 30 days."
  - Discard confirm for unpublished notes with content says the note moves to the Bin.

---

## 10. Files UI (Wave 5)

Build in new modules. Don't grow `src/App.tsx` further.

- `src/files/FilesApp.tsx`: top-level Files workspace. Owns its own state.
- `src/files/filesApi.ts`: upload with `XMLHttpRequest`, because `fetch` has no upload progress. Sends `X-CSRF-Token`, `Idempotency-Key`, and `?folderId=`. Also holds the typed wrappers for list, rename, move, share, and delete.
- `src/files/uploadQueue.ts`: a pure queue reducer (queued → uploading(progress) → done | failed(error) | canceled). Concurrency 2. Retry reuses the same idempotency key. Unit-tested.
- `src/files/FilePreview.tsx`, `src/files/MoveSheet.tsx`, `src/files/RenameDialog.tsx`, `src/files/FileSharePanel.tsx`. Reuse the notes sharing UI patterns and the user picker.
- `src/filesNavigation.ts`: mobile history, see §10.4.
- Shared pieces that already exist (folder list rendering, the share user picker, the `flash` toast) should be extracted from `App.tsx` **only if** the extraction is mechanical and covered by typecheck. Otherwise duplicate minimally and note the follow-up.
- Types go in `src/types.ts`: `DocumentSummary`, `BinItem`.

### 10.1 Desktop (> 760px)

- **Left rail** (collapsible, like Notes):
  - brand button → Home
  - **All files**
  - **Shared with me**
  - owned folders, with Default first
  - folders shared with the caller, with an owner badge
  - **New folder**

  Owned folders are drop targets for documents (`application/x-mynotes-document`), highlighted during a drag. Non-owned folders do not accept drops.
- **Middle column:**
  - header: folder name, item count, **Upload** button (hidden or disabled with a tooltip in non-owned folders and "Shared with me"), sort menu (Name A–Z/Z–A, Newest/Oldest modified, Largest/Smallest), client-side filter box
  - list rows: type icon, name (ellipsis with the full name in `title`), size (human readable), modified relative time, owner badge if not owned, sharing icon if the effective visibility is not private
  - rows are draggable only when owned
- **OS file drag and drop:** dragging files over the middle column shows an overlay, "Drop to upload to <folder>", or "You can only upload to your own folders" when the target is invalid. A drop enqueues every file. In **All files**, uploads go to Default.
- **Upload queue panel** (docked at the bottom of the middle column, collapsible): per-file name, progress bar (`role="progressbar"` with `aria-valuenow`), cancel, retry, and error text (413 shows the limit, 507 shows "Storage is full"). An `aria-live="polite"` summary reads "3 uploaded, 1 failed".
- **Right pane (preview and details):**
  - preview per §7.2
  - metadata: type, size, uploaded, modified, owner, folder, effective visibility
  - actions: **Download** (`<a href=…content?disposition=attachment download>`), **Open preview** (PDF), **Rename**, **Move**, **Share**, **Delete**. Mutating actions show only for owners.
- **Keyboard:** ↑/↓ moves the selection in the list, Enter opens the preview, F2 renames, Delete/Backspace deletes (with confirm). Focus returns to the row after a dialog closes.

### 10.2 Mobile (≤ 760px)

- **Panel stack** like Notes: `folders` → `files` → `preview`. Each header has a Back button that uses `history.back()` when a Files history entry exists, and otherwise falls back to the previous panel (the `mobileBack` pattern).
- **Upload** is a primary button in the `files` header. It opens `<input type="file" multiple>`. The queue shows as a bottom sheet while active.
- **Row tap** opens `preview`. A **⋯** button opens an action sheet: Download, Open preview (PDF), Rename, Move, Share, Delete.
- **Move** opens a full-screen `MoveSheet` that lists owned folders. The current folder is disabled. Confirming moves the document and shows the toast. No touch drag on mobile.
- Touch targets are at least 44 px. Respect `env(safe-area-inset-*)` like the existing mobile styles.

### 10.3 Rename, download, move, delete

- **Rename:** an in-app dialog (not `window.prompt`). It preselects the base name without the extension. It validates with the same rules as the server (§6.4), then calls `PATCH /api/files/:id { name }` and updates the list optimistically, rolling back on error.
- **Download:** a plain same-origin link. The server sets the filename. It works on mobile Safari and Chrome.
- **Move:** by drag (desktop) or `MoveSheet` (mobile/desktop menu), calling `PATCH /api/files/:id { folderId }`. The toast includes the new effective visibility, for example "Moved to Projects · shared with 2 people".
- **Delete:** confirm "Move “name” to the Bin? You can restore it for 30 days.", then `DELETE /api/files/:id` and a toast with an **Undo** action that calls `POST /api/bin/document/:id/restore`.
- **Home Files card** becomes live: "Upload, preview, and organize documents next to your notes."

### 10.4 Mobile history

`src/filesNavigation.ts` mirrors `src/mobileNavigation.ts`:

- key `mynotes.files-navigation`, version `1`, bound to `userId`
- snapshot `{ panel: "folders" | "files" | "preview", folder: string | "all" | "shared", documentId: string | null }`
- `createFilesHistoryState`, `readFilesHistorySnapshot` (strict validation, cross-user rejection), `sameFilesSnapshot`

Entries are layered with `createAppHistoryState(userId, "files", …)`, the same way Notes does it.

`App.tsx` popstate routing becomes:

1. read the app section
2. set the active app
3. dispatch to the owning app's snapshot handler (`notes` → `restoreMobileHistory`, `files` → the Files handler, `bin`/`home` → nothing)
4. close any open Files/Bin dialog before restoring (D18)

The Files handler must tolerate snapshots that point at deleted or inaccessible documents or folders, falling back to `files` / `"all"`.

Tests are in [TEST_PLAN.md](docs/plan/TEST_PLAN.md).

---

## 11. Ordered implementation waves

Each wave ends with the gates in §12. Commits are small and conventional (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), and each must typecheck and pass tests on its own.

### Wave 2: release Home (v0.2.3)

Follow §4.

### Wave 3: secure documents backend (no UI, released together with Wave 4)

Suggested commits:

1. `fix: bound JSON and MCP request bodies independently of Content-Length` (§6.3 refactor and tests)
2. `feat: add documents schema migration 006` (§5.1, `DocumentRow`, updated migration assertion)
3. `feat: add UUID-only document storage and sweeper` (§6.1, §6.2, §6.5 steps 1–2, the `withResourceLock` generalization, `sanitizeDisplayName`)
4. `feat: add magic-byte MIME sniffing and preview allowlist` (§7.1 with unit tests)
5. `feat: add streamed multipart document uploads` (§6.3: busboy pinned, middleware exception, quota/disk/concurrency limits, idempotency, config)
6. `feat: add document list, metadata, rename, move, sharing, and soft delete APIs` (§8)
7. `feat: serve authenticated document content with Range support` (§7.2 headers, Range, HEAD)
8. `chore: add upload limits to env, compose, and backup exclusions` (§13)

Exit criteria:

- every W3 row in the test plan passes
- the RSS streaming check is done and its result recorded in the commit body or PR notes
- an independent **security review** (§12) has no unresolved high or critical findings

### Wave 4: shared Bin (planned with Wave 3 as v0.3.0; actually released as v0.3.1 after Wave 3 shipped in v0.3.0)

Suggested commits:

1. `feat: add bin retention migration 007`
2. `feat: move deleted notes and documents to a 30-day bin` (§9.1 note path changes, D12 immediate purge)
3. `feat: add idempotent restore and purge with retention sweeper` (§9.3, sweeper step 3)
4. `feat: add bin API` (§9.2)
5. `feat: add shared Bin app` (§9.4, Home card live, note delete/discard copy)
6. `docs: document bin retention and documents storage`

Release **v0.3.0** after W4:

1. Take a backup first (`./scripts/backup.sh --force`) because migrations 006 and 007 run on boot.
2. Release notes must say that notes deleted before the upgrade (which the old UI described as permanent) now appear in the Bin for 30 days after the upgrade, then purge automatically.
3. After deploying, confirm that `schema_migrations` contains ids 6 and 7 and that `/api/about` shows the right version and SHA.
4. Smoke test: delete, restore, and purge a note. Upload, download, and delete a document through the API with a session cookie, or wait for W5.

### Wave 5: Files UI (v0.4.0)

Suggested commits:

1. `feat: add files API client and upload queue`
2. `feat: add desktop Files workspace with previews and actions`
3. `feat: add drag and drop upload and move for files`
4. `feat: add mobile Files panels, move sheet, and browser history`
5. `feat: enable Files on Home`
6. `docs: document Files workspace`

Exit criteria: desktop and mobile manual QA (test plan §M) plus an accessibility spot check (keyboard-only flow, screen reader labels).

### Wave 6: docs, site, and final audit (can ship with v0.4.0)

- README: Features, Storage layout, env vars, backup size and duration notes, Files/Bin usage. Fix the `app-dev` discrepancy by removing the reference or adding the profile.
- `docs/ARCHITECTURE.md`: documents, Bin state machine, full API list.
- `site/index.html`: Files/Bin sections and version strings.
- A final independent security audit across W3–W5. Run `/security-review` and a fresh-session review against the threat model.
- Mark everything done in `TODO.md`.

### Wave 37 — Settings hub (operator request, 2026-09-30)

Settings stops being a dialog over the app and becomes a page of its own, with Team inside it; the top bar is reordered. Client only: no route, contract, or migration changes on the server.

**Route scheme.** Settings is a route (`{ app: "settings", section }`), and Team keeps its `{ app: "team", … }` routes with new canonical URLs under the hub:

| Canonical URL | Screen | Aliases (still parsed, rewritten in place) |
| --- | --- | --- |
| `/settings` | The section list (phones); Security beside the nav (computers) | — |
| `/settings/security`, `/notifications`, `/access`, `/keys`, `/modules`, `/about` | An account section | `/settings/mcp` → `/settings/keys` |
| `/settings/team/members`, `/settings/team/members/:userId`, `…/:userId/access` | Team → Members, one member, their access | `/team`, `/settings/team`, `/team/:userId`, `/team/:userId/access` |
| `/settings/team/invites`, `/email`, `/keys`, `/policies`, `/templates`, `/activity` | Team admin sections | `/team/invites`, `/team/email`, … |
| `/settings/team/groups(/:groupId)`, `/settings/team/integrations(/:integrationId)` | Groups, one group; Integrations, one integration | `/team/groups(/:id)`, `/team/integrations(/:id)` |

`formatRoute` always writes the canonical URL, and the app already rewrites any non-Notes URL that differs (startup and every popstate) with `replaceState`, so an alias never leaves a second entry. Server links are unchanged (`/team/:id` in mail, `/settings/:section`, the Google `#google=…` returns): they are aliases. The Google return from Team → member now targets `/settings/team/members/:id`; the result is read before the first rewrite, and Settings' reader ignores `/settings/team/…`.

**What moved.**

- `SettingsDialog` (App.tsx) became `SettingsPage`, rendered for both the `settings` and `team` apps as one element (moving between them never remounts it). The shell is `src/settings/SettingsHub.tsx` (header, grouped nav, section header with avatar, name, role, and title); `src/settings/hubModel.ts` holds the pure parts (entries per role, selection, the phone back arrow). The fixed-position dialog, its scrim, Escape handling, title scope, and the settings-over history state are gone; the page names itself in the document title.
- `TeamApp` became `TeamSection` (same file), which renders inside the hub: Members keeps its list and details panes (`.split-layout`); every other section fills the hub's section scroller. Its admin rows moved into the hub nav; its header, Home, and account row are the hub's. The route comes from the hub (no own popstate listener).
- One leave guard for the page: a new key shown once in Settings → API keys or on an integration's page asks before a section switch, the back arrow, Home, Bin, sign-out, and Back/Forward (`useLeaveGuard`, then the move is repeated).
- "Manage team" and `openTeamViaSettings` are gone: admins keep Team in the hub with the Team module off, so admin Team routes pass the route gate; members and viewers follow the toggle; guests never see it.
- Top bar (`AccountActions`): Bin · Team · Settings · Inbox · bell · picture and name · Sign out (rightmost), one group, the same order on phones. Settings and Team are left out on the hub itself.

**Decisions.** The first Team entry is Members for every role that sees Team (the Team button opens it). On a computer the nav pushes an entry per section (Back walks the sections, then leaves Settings); `/settings` shows Security there. On a phone the list is the first screen; a section's back arrow is `history.back()` when the entry was pushed over `/settings`, otherwise the list replaces the section (deep links). Pages below a section (member, access, group, integration) keep their own back link and hide the hub's arrow. While two-factor setup is required, Settings → Security is the only screen (Sign out is its only action).

**Tests.** `tests/settingsHub.test.tsx` (routes and aliases both ways, nav per role, the 390 px history flow on a model history, the back arrow, the leave guard wiring); updated route, shell, scroll, and chrome tests; `docs/plan/qa/scroll-audit.mjs` covers every hub route (a hub check: the page does not scroll on a computer, the nav and section are bounded scrollers; Members adds the two-pane check), and its seeding waits out the per-admin team write limit.

---

## 12. Gates for every commit, audit, and release

**Per commit:**

- `bun run typecheck`
- `bun test`
- `git diff --check`
- no secrets or personal values in the diff: `git diff --cached | grep -nEi 'password=|secret|token=|@[a-z0-9.-]+\.(com|net|org)|ts\.net|/home/'`, then review each hit by hand
- lockfile committed whenever dependencies change, with versions pinned exactly (no `^`)

**Per wave:**

1. `bun run build`. The ignored `dist/` directory may contain root-owned files from an earlier container build, which makes Vite's output cleanup fail. Do not `sudo` or delete them; build to a scratch directory instead: `bunx vite build --outDir "$(mktemp -d)" --emptyOutDir`.
2. `docker build --target verify .` (runs typecheck, tests, and build in a clean image)
3. `docker compose build`
4. manual QA from the test plan for that wave
5. independent review (a fresh session or `/code-review high` over the wave's commit range)
6. for W3 and W4, also `/security-review`, checked against [THREAT_MODEL.md](docs/plan/THREAT_MODEL.md)

All high and critical findings must be fixed. Medium findings are either fixed or recorded with a rationale in `TODO.md`.

**Per release:**

1. version bump commit (every location in §1)
2. backup when migrations are included
3. operator approval to push and deploy
4. `APP_VERSION=<x.y.z> GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`
5. `docker ps` shows the container healthy
6. smoke test
7. update the TODO wave status with the released SHA

Tags are optional and only with operator approval.

---

## 13. Configuration, Docker, backups, migrations

New environment variables. Add them to `server/config.ts` with validation, to `.env.example` with defaults (no real values), to `compose.yaml` pass-through with the same defaults, and to the README table.

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | integer, 1 MiB to 2 GiB | Per-file cap. Bun `maxRequestBodySize` = `max(this, 2_100_000)` + 1 MiB. |
| `USER_STORAGE_QUOTA_BYTES` | `10737418240` (10 GiB) | integer ≥ 0; `0` = unlimited | Live plus binned document bytes per user |
| `MIN_FREE_DISK_BYTES` | `1073741824` (1 GiB) | integer ≥ 0 | Refuse uploads that would leave less free space than this |

Constants (not configurable): 3 concurrent uploads per user on the server (the Files client runs 2 at a time), 30-day Bin retention, 1 MiB text preview, 4100-byte sniff window, sweeper every hour with a budget of 50 resumed purges plus 100 due items per table per run.

- **Docker/Compose:** no new volumes. Staging lives under `/data/documents/.staging`, never under the 64 MB `/tmp` tmpfs. The root filesystem stays read-only. The healthcheck is unchanged. Only one app instance may use a data directory, because the locks and sweeper are in-process. Document this.
- **Backups:** `scripts/backup.sh` already includes `documents/`. Add `--exclude='./documents/.staging'`. Document that:
  - archive size and stop duration grow with stored files (gzip gains little on already-compressed media)
  - five weekly archives multiply disk use
  - purged items can survive in older archives for up to about five weeks

  Restore is unchanged: extract into an empty directory and point `MYNOTES_DATA_DIR` at it. The DB and objects are consistent because the app is stopped during backup.
- **Migrations:** `006` in W3, `007` in W4. Both are transactional and filesystem-free. Test with a fresh DB and with a copy of a v0.2.2-shaped DB. A test can create the tables through migrations 1–5, insert legacy soft-deleted notes, then run 6–7 and assert the backfill. Never modify a released migration.

---

## 14. Explicit out-of-scope decisions

These items are deliberately excluded. Revisit them only with operator approval.

- Folder upload or directory trees from the OS. Only individual files are supported, though several can be dropped at once.
- Multi-select and bulk actions (bulk move, bulk delete, bulk download or zip).
- Server-side thumbnails, image resizing, EXIF stripping, video or audio transcoding, and Office or HEIC conversion. There is no server-side content processing of any kind.
- Inline preview of SVG, HTML, Office documents, archives, and anything outside §7.1. In-app PDF rendering (PDF.js) or iframe embedding.
- Antivirus or malware scanning. Non-allowlisted files are download-only, and users are trusted accounts on an allowlist.
- Content deduplication, versioning of documents, and replacing a document's bytes in place. Upload a new file instead.
- Resumable or chunked uploads (tus and similar). A retry re-sends the whole file and the idempotency key prevents duplicates.
- Collaborative write access (recipients editing, uploading into, or deleting from others' folders).
- Recursive folder-sharing inheritance and folder-level Bin (deleting a folder does not move it to the Bin; D15).
- Configurable retention, per-folder quotas, admin quota UI, and user deletion flows.
- Public links, anonymous sharing, and signed URLs.
- Documents in MCP, and full-text search inside documents.
- Desktop browser-history integration for app, panel, or dialog changes. Dialogs don't get their own history entries on mobile.
- Encryption of document bytes at rest. This relies on host disk encryption, as notes do today.
- Multiple app replicas sharing one data directory.

---

## 15. Sequential prompts for Claude workers

Run these in order, **one fresh Claude Code session per step**, in this repository. Do not start a step until the previous step's gate is recorded as passed in `TODO.md`. Every prompt implicitly includes: "Read `DEVELOPMENT_PLAN.md` and the three `docs/plan/*` files first. Follow the §12 per-commit gates. Do not push, deploy, tag, or edit `.env`. Do not modify root-owned build artifacts (for example an existing `dist/`); if a step needs a clean build output, report it instead. Stop and report instead of guessing when the code contradicts the plan."

| Step | Prompt (paste into a fresh session) | Gate before the next step |
| --- | --- | --- |
| **S1 Wave 2 review** | "Independently review local commit `cb59b6a` (`origin/main..cb59b6a`) against DEVELOPMENT_PLAN §4. For every item, including blocking gates G2.1 (draft finalization when leaving Notes for Home) and G2.2 (Settings and sign-out from Home), record a finding with evidence or 'no issue'. Treat them as questions to verify, not known bugs. Reproduce on desktop and a ≤760 px viewport. Do not change code; write findings into `TODO.md` under Wave 2 and commit `docs: record Wave 2 review findings`." | Findings committed. G2.1 and G2.2 each have an outcome. Operator has decided on G2.2 if it needs a product call. |
| **S2 Wave 2 fixes** | "Fix the confirmed Wave 2 review findings recorded in `TODO.md`, one `fix:` commit each, adding a unit test for any extracted pure helper. Do not fix items recorded as 'no issue' or operator-accepted." Skip this step if there are no confirmed findings. | `bun run typecheck`, `bun test`, `git diff --check` pass. A second reviewer (or `/code-review high` on the fix commits) finds nothing high or critical. |
| **S3 Wave 2 release prep** | "Bump the version to 0.2.3 in every location listed in DEVELOPMENT_PLAN §1, run every §12 per-wave gate that does not need the operator, and report the results. Do not push or deploy." | Operator explicitly approves push and deploy. The operator (or a session given that approval) runs §4 release steps 4–7. |
| **S4 Wave 3, commit 1** | "Implement Wave 3 commit 1 (§6.3 body-limit refactor) with its tests. Nothing else." | Bounded-reader tests pass and prove the 413 comes from the reader, not Bun. |
| **S5 Wave 3, commits 2–8** | "Implement Wave 3 commits 2–8 from §11 in order, one commit each, with the W3 tests from TEST_PLAN. Record the RSS streaming measurement and the `statfs`-in-container check in the commit body. Stop after commit 8." Split across sessions if context runs short, resuming at the next unfinished commit. | Every W3 test-plan row passes. The secureHeaders exact-CSP test passes. |
| **S6 Wave 3 security review** | "Run `/security-review` and an independent review of the Wave 3 commit range against THREAT_MODEL.md. Record findings in `TODO.md`. Do not fix them in this session." | No unresolved high or critical findings (fix them in a follow-up session, then re-review). |
| **S7 Wave 4** | "Implement Wave 4 commits 1–6 from §11 with the W4 tests. Pay attention to §9.1: the draft-discard route must keep the draft on the Bin path, and blank detection uses the trimmed draft content." | W4 tests pass. `/security-review` over W3+W4 is clean. Manual QA §M items that apply to W4 pass. |
| **S8 v0.3.0 release** | "Prepare v0.3.0 per §11 (version bump, backup instructions, release notes including legacy deleted notes appearing in the Bin). Do not push or deploy." | Operator approves, takes the backup, and deploys. `schema_migrations` shows 6 and 7. |
| **S9 Wave 5** | "Implement Wave 5 commits 1–6 from §11 with the W5 unit tests. Keep new UI in `src/files/` and `src/bin/`; do not grow `src/App.tsx` beyond the routing changes in §10.4." | Desktop and mobile manual QA §M pass, plus the accessibility spot check. Independent review is clean. |
| **S10 Wave 6** | "Do Wave 6 from §11: README, ARCHITECTURE, and site updates, then a final `/security-review` plus a fresh-session audit across W3–W5 against THREAT_MODEL.md. Record results in `TODO.md`." | All high and critical findings fixed. Operator approves the v0.4.0 release. |
