# Nook plan: Team invites (W18), MCP write coverage (W19), Emoji reactions (W20)

Planned 2026-09-28 against `main` at `30fcd2f` (production v0.9.3). Three small waves. Each ships backend and UI together and can be released on its own. Read `DEVELOPMENT_PLAN.md` (rules, §12 gates), `docs/plan/WAVES_7-9.md` §4 (MCP conventions), and `docs/plan/research/2026-09-26-team-module.md` §8 and §11 before starting.

**Numbering.** Decisions use **D161–D190** and threat rows **T136–T153**. D145 is the highest decision in the docs today (API_CONTRACTS, task hierarchy research). The last row in THREAT_MODEL.md is T122, and the hierarchy research reserved up to T124. The Agent-inbox plan is being written in parallel and may pick the same numbers. If it does, the director renumbers one of the two plans at merge.
**Migrations.** W18 = **`018_team_invites`** (reserved since the Team plan §11). W19 has **no migration**. W20 = **`022_reactions`**. 021 belongs to the Agent-inbox plan, so this plan does not use it. `runMigrations` already applies missing lower ids after higher ones, so a database that has 019/020 still gets 018 when it lands.
**Wave name.** TODO.md calls invites "Wave 16 (Team C)". It ships as **Wave 18**, and TODO.md is updated in the W18 docs commit.

## 0. What the code does today (verified)

| Fact | Where |
| --- | --- |
| Register checks `ALLOW_REGISTRATION` twice (before parsing, and again in the insert transaction), then `isEmailAllowed`. It takes the role from `config.signupRole` (default `guest`), or `admin` when no active admin exists. `registerSchema` is `.strict()` (email, displayName, password). | `server/index.ts:190-237`, `server/validation.ts:9` |
| No `/register` route. Register is a toggle on the login card (`registering` state). | `src/App.tsx:110-187`, `src/router.ts` |
| `team_events.action` has a CHECK constraint (`role_change, block, unblock, sessions_revoked, bootstrap_admin`), `target_user_id NOT NULL`, and append-only triggers. | `server/migrations/017_team_roles.ts` |
| `/api/team/` is self-gated in the role write gate. `GET /api/team/:userId` answers 404 for a non-UUID. | `server/team/writeGate.ts`, `server/team/routes.ts` |
| **There is no `publish_note_draft` MCP tool.** Publishing lives inline in `POST /api/notes/:id/publish`. The CAS is optional for web clients but required when the draft was written by MCP (`draft_mcp_key_id`). The `notes:write-draft` help text promises "never publishes". | `server/index.ts:664-701`, `src/mcpPermissions.ts` |
| Help text for the other write scopes: `tasks:write`, "never deletes"; `calendar:write`, "never deletes"; `collections:write`, "never deletes, and never changes fields or sharing". There is **no `files:write` scope**. | `src/mcpPermissions.ts`, `server/mcpScopes.ts` |
| `MCP_READ_SCOPES` = every scope that has no `IMPLIED_READ_SCOPE` entry. Viewers get exactly these, so a new write scope without an implied read would be handed to viewers. | `server/team/roles.ts` |
| `McpToolSpec.scopes` is any-of, and there is one `dailyBucket`. `runTool` re-checks scopes and `canWriteContent`. The per-module tool files wrap handlers in `withAuditContext({via:"mcp", keyId})`. | `server/mcpToolKit.ts`, `server/mcpTools.ts:56-78` |
| Bin restore predicates already implement "owner, or binned by me with write access" for cards (`cardAccess`), events (`restorableRow`), and rows. Notes and documents are owner-only. | `server/tasks/bin.ts:94`, `server/calendar/calendarBin.ts`, `server/collections/bin.ts:140-149`, `server/bin.ts` |
| Uploads accept only multipart on `POST /api/files`, the single multipart exception in `requireMutationSafety`. The path streams through busboy to staging with Content-Length required, a 3-slot per-user limit, quota and disk checks, sniffing, a UUID `Idempotency-Key`, and a commit re-check that the owner is not blocked (T80). | `server/documents.ts:215-313`, `server/auth.ts:78-95` |
| `linkAttachments` accepts only live `purpose='task_attachment'` documents that the caller owns (T41). | `server/tasks/attachments.ts:48` |
| Card comments are hard-deleted and cascade from `cards`. `get_card` returns the latest comments. | `server/migrations/009_task_boards.ts:47`, `server/tasks/mcpTools.ts:292` |
| `audit_log` has no index besides the primary key. | `server/migrations/001_initial.ts:15` |

---

## 1. Wave 18: Team invites (Team C, v0.10.0, migration 018)

### 1.1 Goals

An admin creates a single-use invite link with a fixed role and sends it through any channel. The recipient opens `/register?invite=<token>` and creates an account even when `ALLOW_REGISTRATION=false`. `ALLOWED_EMAILS` still applies. Admins list, copy (right after creation only), and revoke invites on `/team`. Out of scope: email delivery, admin invites, bulk invites, and re-showing a token.

### 1.2 Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D161 | Token = 32 random bytes, base64url (43 chars). Only `sha256(token)` (hex) and a 6-char `token_prefix` are stored. The link is `<origin>/register?invite=<token>`. The SPA reads the token once, keeps it in memory, and immediately `history.replaceState`s the URL to `/register`, so the token leaves the address bar and history. | Same pattern as MCP keys and feeds (T64). `Referrer-Policy: no-referrer` is already global. The server does not log request lines. |
| D162 | A valid invite bypasses **only** `ALLOW_REGISTRATION`. `isEmailAllowed` is still checked at registration (and on every request afterwards, `auth.ts`). An email-bound invite requires an exact case-insensitive match. An invite works only while its creator is an **active admin**: the JOIN checks `role='admin' AND disabled_at IS NULL` at use time. | O15 default. A demoted or blocked admin's outstanding links die with their privilege. |
| D163 | The role is fixed by the invite: `member`, `viewer`, or `guest`. The DB CHECK excludes `admin`. The register body cannot name a role (the schema stays strict and adds only `inviteToken`). The first-user and no-active-admin bootstrap rules run **before** the invite branch and override it (an empty instance has no admin to create invites anyway). | D81. Admins are promoted after sign-up. |
| D164 | Limits: at most **20 live invites per instance** (unused, unrevoked, unexpired), **10 creations per hour per admin** (in memory, like the Team write limit), expiry 1–7 days (default 7, DB CHECK ≤ 7 days), and single use through a guarded `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > $now` inside the user-insert transaction. | D81. A lost race gets `INVITE_INVALID` and the user is not created. |
| D165 | The invite lifecycle is recorded in `team_invites` itself (`created_by`, `used_by`, `revoked_by`, and timestamps) and in `audit_log` (`team.invite_create`, `team.invite_revoke`, `team.invite_accept`, with `{inviteId, role}` only, never the token or email). `team_events` is **not** extended: its action CHECK and append-only triggers would force a table rebuild of an audit table. Team Activity (admin detail) shows "Joined with an invite from <admin>, as <role>", derived from `team_invites.used_by`. | Keeps T83 intact. Admins still see the full history. |
| D166 | Pre-auth preview: `POST /api/auth/invite` with `{token}` (the token goes in the body, never in a query). It returns `{role, emailHint, expiresAt, inviterName}`. `emailHint` is masked, e.g. `p•••@example.com`. Errors are `410 INVITE_EXPIRED` or, for anything else (unknown, used, revoked, creator no longer admin), `404 INVITE_INVALID`. A global rate limit of 30 a minute plus `register:global` applies. | Guessing a 256-bit token is infeasible, so telling "expired" apart only helps the real holder. |
| D167 | UI routes: `/team/invites` (parsed before the `:userId` rule) and pre-auth `/register`. On desktop the invites panel sits in the Team detail pane. At ≤760 px it is a full panel, like member detail. Dialogs push no history entry and use `useHistoryDialogGuard`, so Back closes them first. | History parity rule. Team §6 pattern. |
| D168 | MCP gets `list_invites` under `team:read` (admin-only scope) with no create or revoke tool. The output never includes the token, prefix, email, or admin note. | D79 and O12: no emails in MCP, and an injected agent cannot mint accounts. |
| D169 | The sweeper deletes invites 90 days after they died (used, revoked, or expired). Live invites are never swept. | Bounded table. A dead invite's hash is harmless, so there is no hurry. |

### 1.3 Migration `server/migrations/018_team_invites.ts`

```sql
CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  token_prefix TEXT NOT NULL CHECK (length(token_prefix) = 6),
  email TEXT COLLATE NOCASE CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  role TEXT NOT NULL CHECK (role IN ('member','viewer','guest')),
  note TEXT CHECK (note IS NULL OR length(note) <= 80),           -- admin-only label ("For the design contractor")
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) > julianday(created_at)
                                  AND julianday(expires_at) - julianday(created_at) <= 7.0001),
  used_at TEXT, used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT, revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (used_at IS NULL OR revoked_at IS NULL),
  CHECK (used_by IS NULL OR used_at IS NOT NULL)                   -- used_by may later be nulled by user deletion
);
CREATE INDEX idx_team_invites_live ON team_invites(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_team_invites_created ON team_invites(created_at DESC);
CREATE INDEX idx_team_invites_used_by ON team_invites(used_by) WHERE used_by IS NOT NULL;
```

Add `TeamInviteRow` to `server/db.ts`. Migration tests: a fresh DB, and a v0.9.3-shaped DB (ids 1–17, 19, 20) that then gets 18, asserting `registeredMigrationIds` `[1..20]`. CHECKs: an admin role is refused, and 8-day expiry is refused.

### 1.4 API deltas (API_CONTRACTS.md § Team, new "Invites" subsection)

`TeamInvite` = `{ id, tokenPrefix, role, email, note, status: "live"|"used"|"expired"|"revoked", createdAt, expiresAt, createdBy: {id, displayName}|null, usedBy: {id, displayName}|null, usedAt, revokedAt }`. Admins only.

| Method and path | Who | Body / response and errors |
| --- | --- | --- |
| `GET /api/team/invites` | admin (guest 404, others 403 `ADMIN_ONLY`) | `{ invites: TeamInvite[], liveCount, liveLimit: 20 }`: all live invites plus the latest 100 others, newest first |
| `POST /api/team/invites` | admin | `{ role, email?, expiresInDays?: 1..7, note? }` → 201 `{ invite, token, url }`. The token is shown only in this response. Errors: 409 `INVITE_LIMIT` (20 live), 429 `RATE_LIMITED` (10/h), 400 `EMAIL_NOT_ALLOWED` (a bound email fails `isEmailAllowed`), 409 `ACCOUNT_EXISTS` (a bound email already registered; admins see emails anyway, so nothing leaks) |
| `POST /api/team/invites/:id/revoke` | admin | `{}` → `{ invite }`. 409 `INVITE_NOT_LIVE` when used, expired, or already revoked (idempotent for revoked: 200) |
| `POST /api/auth/invite` | anyone (pre-auth, like register: Origin + JSON checks, no session) | `{ token }` → `{ role, emailHint, expiresAt, inviterName }`, 404 `INVITE_INVALID`, 410 `INVITE_EXPIRED`, 429 |
| `POST /api/auth/register` | anyone | Adds optional `inviteToken`. With a token: skip both `ALLOW_REGISTRATION` checks, enforce `isEmailAllowed`, then 403 `INVITE_EMAIL_MISMATCH` for a bound email, 404 `INVITE_INVALID` or 410 `INVITE_EXPIRED` (also on a lost single-use race), otherwise the account is created with the invite's role. Without a token: unchanged. |

Implementation notes: create `server/team/invites.ts` (service plus a pure `inviteStatus(row, now)`). Register the invites routes **before** `/api/team/:userId`. The register branch lives in `server/index.ts`, but the claim (`claimInvite(tokenHash, userId, email, now)`) sits in the service and runs inside the existing insert transaction. `role` is computed as `bootstrap ? "admin" : invite ? invite.role : config.signupRole`.

### 1.4a Register branch (sketch, `server/index.ts` + `server/team/invites.ts`)

```text
POST /api/auth/register
  body = registerSchema.extend({ inviteToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict()
  if !inviteToken and !allowRegistration and userCount > 0 → 403 (unchanged)
  rateLimited("register:global", 10) → 429
  !isEmailAllowed(email) → 403
  tx:
    count = users; bootstrap = count == 0 || !hasActiveAdmin()
    if inviteToken and !bootstrap:
      invite = SELECT i.* FROM team_invites i JOIN users a ON a.id = i.created_by
               WHERE i.token_hash = sha256(token) AND a.role = 'admin' AND a.disabled_at IS NULL
      none / used / revoked            → throw 404 INVITE_INVALID
      expires_at <= now                → throw 410 INVITE_EXPIRED
      invite.email and != email NOCASE → throw 403 INVITE_EMAIL_MISMATCH
    elif !inviteToken and !allowRegistration and count > 0 → throw 403
    role = bootstrap ? "admin" : invite ? invite.role : config.signupRole
    INSERT users …; ensureDefaultFolder
    if invite: UPDATE team_invites SET used_at = now, used_by = id WHERE id = ? AND used_at IS NULL
               AND revoked_at IS NULL AND expires_at > now → changes != 1 ⇒ throw 404 INVITE_INVALID
  audit auth.register; audit team.invite_accept {inviteId, role}
```

An invalid token on an instance with registration open is **not** silently ignored: the call fails, so a person who expected a Viewer invite never ends up with the `SIGNUP_ROLE` by accident.

### 1.5 MCP delta

`list_invites({ status?: "live"|"all" })` under `team:read`, read-only, `call` bucket. It returns `[{ id, role, status, createdAt, expiresAt, createdBy: displayName, usedBy: displayName|null }]`. Add it to `server/team/mcpTools.ts`, docs/USING.md, and the API_CONTRACTS MCP table.

### 1.6 UI (desktop and 390 px)

- **Team list pane** (admins only): a row "Invites · 3 live" pinned above the member list (≥44 px), which navigates to `/team/invites`. `src/router.ts` gains `{ app: "team", userId: null, invites: true }` with `parseRoute("/team/invites")` and a round-trip test.
- **Invites panel** (`src/team/TeamInvites.tsx`): a list of cards showing role chip, status, email or note, expiry ("in 6 days"), and created by. Live rows have **Revoke**, which opens a confirm dialog. Used rows link to the member (`/team/:id`). Empty state: "No invites yet. Create a link to add someone without opening registration." The **New invite** button is disabled at 20 live, with a hint.
- **Create dialog**: a **Role** custom `Select` (D91: Member, Viewer, Guest, each with a one-line description from `teamRoles.ts`; default = `SIGNUP_ROLE` mirror, i.e. Guest), an **Expires** custom `Select` (1 day, 3 days, 7 days; default 7), an optional **Email** field ("Only this address can use the link"), and an optional **Label**. Submitting switches the dialog to the **shown-once** state: a read-only link field, **Copy link** (Clipboard API, with a select-all fallback), and the warning "This link is shown once. Anyone with it can create a <role> account until <date>." Closing the dialog drops the token from state.
- **Register screen** (`/register`, `src/auth/InviteRegister.tsx` or an invite mode of the existing auth card): it calls `POST /api/auth/invite` and then shows "Asha invited you to Nook as a **Viewer**", the expiry, and the email hint. A bound email is prefilled but still editable, and the server enforces it. The expired and invalid states show "Ask your admin for a new link" plus a **Sign in** link. An already signed-in visitor gets "You're signed in as X. Sign out to use this invite." After success the app lands on Today, as a normal register does.
- **History parity**: Today → `/team` → `/team/invites` → create dialog. Back closes the dialog, then returns to the list, then to Today. Forward reopens the invites panel. `/register` at depth 0: Back leaves the site (it is the first entry, pre-auth). After registering, `replace` goes to `/`.
- 44 px targets, focus returns to the trigger, and the copy button announces "Link copied" (`aria-live`).

### 1.7 Threat rows (append to THREAT_MODEL.md as "Team invites (Wave 18)")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T136 | **Invite token leakage** (chat logs, screenshots, browser history, proxy logs, Referer) | Shown once, only the hash stored, ≤7 days, single use, revocable, dead when its creator stops being an active admin. Optional email binding. `no-referrer` globally. The SPA strips the query with `replaceState`. The preview and claim take the token in a POST body. Audit rows never contain it. Accepted: a reverse proxy in front of Nook may log the first GET's query string. The operator documents this, and binding by email limits the damage. | Required (proxy logs accepted) |
| T137 | **Invite enumeration or brute force** | 256-bit tokens. `INVITE_INVALID` is the same for unknown, used, and revoked. A global limit of 30 a minute on preview and the existing 10 a minute on register. Constant-time hash lookup by unique index (no prefix search). | Required |
| T138 | **Role fixing or escalation via invites** (an admin invite, changing the role after creation, a role in the register body) | DB CHECK excludes `admin`. `role` is immutable (no update route). `registerSchema` stays strict (role rejected). Bootstrap rules run first. Tests for each. | Required |
| T139 | **Bypassing the allowlist or policy** (invite used by a non-allowlisted email, or after `ALLOWED_EMAILS` changes) | `isEmailAllowed` checked at claim time and on every request (`auth.ts`). A bound email must match. The invite bypasses only `ALLOW_REGISTRATION`. | Required |
| T140 | **Invite spam or mass account creation** by a compromised admin session | 20 live, 10 an hour per admin, audit rows, Team list "New" tag (D80). MCP cannot create invites (D168). CSRF, Origin, and SameSite are enforced on `/api/team/*`. | Required |
| T141 | **Double use of an invite** (two browsers at once) | The claim is a single guarded UPDATE in the user-insert transaction, and `changes !== 1` rolls back the user. | Required |

### 1.8 Test rows (TEST_PLAN.md "Wave 18: Team invites")

| Area | Test |
| --- | --- |
| Migration | Fresh and v0.9.3-shaped DBs (17, 19, 20 applied, then 18). Admin-role and >7-day CHECKs abort. Assertion `[1..20]`. |
| Create | Admin creates → token returned once; `GET` never returns it. Member/viewer → 403 `ADMIN_ONLY`; guest → 404. 21st live → `INVITE_LIMIT`. 11th in an hour → 429. Bound email not on `ALLOWED_EMAILS` → `EMAIL_NOT_ALLOWED`. Existing email → `ACCOUNT_EXISTS`. |
| Register | `ALLOW_REGISTRATION=false` + valid invite → 201 with the invite role and one `team.invite_accept` audit row. Same invite again → `INVITE_INVALID`. Expired → 410. Revoked → 404. Creator demoted or blocked → 404. Email mismatch → 403. Non-allowlisted email → 403. `role:"admin"` in the body → 400. Concurrent double claim → exactly one user. Empty instance + token → admin (bootstrap wins). |
| Preview | Token in body only; a GET with a query is not a route. Masked email hint. 31st call in a minute → 429. |
| Revoke | Live → revoked, and the link then fails. Used → 409 `INVITE_NOT_LIVE`. |
| Audit | No token, hash, or email in `audit_log.metadata_json` (grep after the suite). `team_events` unchanged. |
| MCP | `list_invites` hidden without `team:read`. A demoted admin's key gets `SCOPE_REQUIRED`. The output has no email, prefix, or note. |
| Sweeper | Dead for 91 days → deleted. Live → kept. |
| UI | Router `/team/invites` round trip. Create dialog Selects with keyboard and touch. The shown-once state clears on close. `/register?invite=` strips the query. Back/Forward matrix (§1.6) at 390 px and desktop. `noNativeSelect.test.ts` passes. |

### 1.9a Files touched

`server/migrations/018_team_invites.ts`, `server/migrations/index.ts`, `server/db.ts`, `server/team/invites.ts` (new), `server/team/routes.ts`, `server/team/mcpTools.ts`, `server/index.ts` (register and preview), `server/validation.ts`, `server/sweeper.ts`, `src/router.ts`, `src/team/TeamApp.tsx`, `src/team/TeamInvites.tsx` (new), `src/team/teamApi.ts`, `src/App.tsx` (auth card invite mode, `/register` pre-auth handling), tests `teamInvites.test.ts`, `teamInvitesClient.test.tsx`, `router.test.ts`, `migrations.test.ts`, `writeGate.test.ts` (route enumeration picks up the new team routes as self-gated).

**Gate:** all tests, typecheck, build, Docker verify; a manual matrix at 390 px and desktop (create, copy, open in a private window, register, revoke, and the expired state by editing `expires_at` on the QA instance); backup before deploy; `schema_migrations` shows 18.

### 1.9 Commits (S/M, 1–2 sessions)

1. `feat: add team invites migration 018`
2. `feat: create, list, and revoke team invites` (service, routes, limits, sweeper)
3. `feat: register with an invite link` (preview, register branch, claim)
4. `feat: add invites to the Team app` (route, panel, create dialog, copy once)
5. `feat: add the invite register screen`
6. `feat: add list_invites to MCP team tools`
7. `docs: document team invites` (API_CONTRACTS, THREAT_MODEL T136–T141, TEST_PLAN, USING "Inviting people", OPERATIONS note on proxy logs, TODO)

---

## 2. Wave 19: MCP write coverage (v0.11.0, no migration)

### 2.1 Goals

Agents can finish work they start: publish a draft they wrote, organise folders and files, keep boards tidy (Bin/restore, tags, WIP, sprints, attachments), bin and restore events and rows, create collections, and store files. Every write is reversible (the Bin, or another update). Every write is attributed to the key owner and audited `{via:"mcp", keyId}`. **Never over MCP:** hard delete or purge, emptying the Bin, sharing changes, role or team changes, and key management. A test enumerates `mcpToolSpecs` names against the forbidden verbs `purge|empty|share|role|block|delete_forever|invite|key` (D180).

### 2.2 Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D170 | **Three new scopes** where the existing help text makes a promise the new tools would break: `notes:publish` ("Publish your notes' drafts", implies `notes:read`), `files:write` ("Upload, rename, and move your files and create folders; never shares or deletes", implies `files:read`), and `bin:write` ("Move items to the Bin and restore them; never deletes forever", no implied read). Existing keys never gain powers. Tools that are further create or update on content an existing write scope covers (tags, WIP limit, sprints, collection creation, attachment linking) stay in `tasks:write` or `collections:write`, and their help text is updated (see the open decisions). | `notes:write-draft` says "never publishes", and `tasks/calendar/collections:write` say "never deletes". Widening them silently would break the consent the operator gave. |
| D171 | **Write scopes become an explicit list** (`MCP_WRITE_SCOPES` in `server/mcpScopes.ts`, mirrored in `src/mcpPermissions.ts`). `MCP_READ_SCOPES` and `isWriteScope` stop deriving from `IMPLIED_READ_SCOPE`. Without this, `bin:write` (which implies no read) would count as a read scope and be handed to viewers (T144). | Fail-closed classification. |
| D172 | `McpToolSpec` gains `alsoRequires?: McpScope[]` (all-of, checked at registration and in `runTool`) and `buckets?: Bucket[]` (replacing the single `dailyBucket`). A Bin tool needs `bin:write` **and** the module's write scope. | A notes-only key with `bin:write` cannot bin cards. |
| D173 | **`publish_note_draft` requires a seen revision.** It extracts `publishDraftLocked(note, userId, {revision})` from the route into `server/noteDrafts.ts`, and the HTTP route calls it too. MCP adds a **per-key seen-revision ledger** (in memory, ≤500 notes per key, 1 h TTL). The ledger records `(noteId, revision, draft_checksum)` whenever `create_note`, `get_note_draft`, or `update_note_draft` returns a revision to that key. Publish succeeds only if `revision` equals the stored draft revision **and** the ledger has the same revision and checksum for this key. Otherwise it returns `DRAFT_NOT_SEEN` ("read it with get_note_draft first") or `DRAFT_CHANGED`. After a restart the agent must read the draft again. | Revisions are small integers and easy to guess, and the web CAS alone would let an agent publish a human's draft it never read. |
| D174 | **Bin over MCP is always soft.** `bin_note` moves even a blank never-published note to the Bin (it skips the D12 immediate purge). Restores reuse the HTTP predicates: notes by the owner only; cards, events, and rows by the owner or by whoever binned them with write access. There is no purge or empty tool. Daily caps: `bin_action` **50/key, 100/user a day** plus `bin_burst` **10/key a minute**. Restores count only against `write`. | Caps bound a prompt-injected sweep, and Undo makes it cheap to recover. |
| D175 | **Undo for MCP binning:** `GET /api/mcp/keys/:id/binned?window=1h|24h|7d` lists items the key binned that are still in the Bin, from `audit_log` rows with `actor_id = me`, one of the four `*.delete` event types, `json_extract(metadata_json,'$.keyId') = :id`, and `created_at >= since`, LIMIT 500. `POST /api/mcp/keys/:id/restore-binned {window}` restores each item through the normal services and returns `{restored, skipped: [{type,id,reason}]}`. The scan is unindexed, and the gate measures it against a 200k-row audit table (<500 ms). If the measurement fails, a later migration adds `idx_audit_log_actor_created` (see the open decisions). | No migration in this wave, and the audit already carries `keyId`. |
| D176 | **Upload over MCP. Recommendation: two paths, and no base64 binaries.** (a) `create_text_file({name, text ≤ 1 MiB UTF-8, folderId?, purpose?})` is inline JSON and covers the common agent output (Markdown, CSV, JSON). (b) Binaries use `begin_upload({name, sizeBytes, sha256, folderId?, purpose?})`, which returns a one-time ticket. The client then sends `PUT <origin>/mcp/uploads/<uploadId>` with **the same key** in `Authorization: Bearer`, `Content-Type: application/octet-stream`, `Content-Length = sizeBytes`, and the raw body. The body is streamed through the existing staging, sniff, quota, disk, and T80 commit path, with `upload_key = uploadId` so retries are idempotent. Finally `finish_upload({uploadId})` returns the committed document, or `UPLOAD_PENDING` / `UPLOAD_EXPIRED` / `HASH_MISMATCH`. Tickets live in memory: 15 minutes, single use, ≤3 open per key, bound to key and user. | MCP JSON-RPC is capped at 2.1 MB (`boundedRequest`) and buffered in memory. Base64 inflates by a third and would buffer whole files. A bearer-bound PUT keeps the token out of the URL (a leaked URL alone is useless) and reuses the audited streaming pipeline. Clients without HTTP ability still get (a). |
| D177 | `move_file` refuses a move that would change the file's **effective audience**. That happens when the file inherits (`sharing_override=0`) and the source and destination folders' visibility or share sets differ, and the refusal is `AUDIENCE_CHANGE`. `rename_file` is always allowed on owned files. Uploads and `create_folder` land private by default (Default folder, no cascade, D3). | "No sharing changes" also means none by side effect. |
| D178 | Sprint tools keep owner-only semantics (`ownedSprint`). `complete_sprint` requires the **active** sprint's id and an explicit `carryTo` (no default). Its description says it cannot be undone. It has its own `sprint_write` bucket (20/day). | Completion is the one irreversible write. It is included because the brief asks for it, with a CAS and a cap, and it is an open decision. |
| D179 | `link_attachment` links only a live `task_attachment` document the key owner uploaded (existing T41 rule), for example one from `create_text_file` or `begin_upload` with `purpose:"task_attachment"`. Files-app documents cannot be linked. | Linking a Files item onto a shared board would share it. |
| D180 | Hard rule list (in §2.1), enforced by a test over tool names and descriptions, plus a test that no MCP handler imports `purge*`, `emptyBin`, `putSharing`, or `setRole`. | Keeps the rule true as tools are added. |
| D181 | Error codes added to `McpErrorCode`: `NO_DRAFT`, `NO_CHANGES`, `DRAFT_NOT_SEEN`, `PURGING`, `PARENT_IN_BIN`, `AUDIENCE_CHANGE`, `NAME_TAKEN`, `SPRINT_ACTIVE`, `SPRINT_NOT_ACTIVE`, `NO_NEXT_SPRINT`, `UPLOAD_PENDING`, `UPLOAD_EXPIRED`, `HASH_MISMATCH`, `QUOTA_EXCEEDED`. Service errors map 1:1 from their HTTP codes. | The same vocabulary as HTTP, so agents can branch on it. |

### 2.3 Tools

All are `write: true` unless marked read. "B" = counts in `bin_action` + `bin_burst`.

| Tool | Scopes (any-of + alsoRequires) | Buckets | Behaviour |
| --- | --- | --- | --- |
| `publish_note_draft` | `notes:publish` | `note_publish` 50/key, 100/user a day | `{noteId, revision}`. Owned notes only, D173 ledger. Returns `{version, publishedAt, audience: "private"\|"shared", url}`. Clears `draft_mcp_key_id`. Audit `note.publish {via, keyId}`. |
| `get_note_draft` | now `notes:write-draft` **or** `notes:publish` | – | Unchanged output. Records the revision in the ledger. |
| `create_folder` | `notes:write-draft` or `files:write` | `structure_write` 100/day | `{name, parentId?}`. The parent must be owned. The new folder is private (no cascade). `NAME_TAKEN` for "Default". |
| `bin_note` / `restore_note` | `bin:write` + `notes:write-draft` | B / – | Owned notes. Bin: 30 days, sharing kept (D11). Restore: `restoreItem("note")`, original folder or Default (D14). |
| `bin_card` / `restore_card` | `bin:write` + `tasks:write` | B / – | `deleteCard` (descendants go too, D129) and `restoreTaskItem` (the owner or the binner). Returns `descendantCount`, and `detached` on restore. |
| `manage_tags` | `tasks:write` | `task_write` | `{boardId, action: "create"\|"rename"\|"recolour", tagId?, name?, color?}`. Any writer creates. Rename and recolour are owner-only (`OWNER_ONLY`). No delete. |
| `set_wip_limit` | `tasks:write` | `task_write` | `{columnId, wipLimit: 1..999 \| null}`. Board owner only (`patchColumn`). |
| `create_sprint` / `start_sprint` / `complete_sprint` | `tasks:write` | `sprint_write` 20/day | Owner only. `start_sprint` = `patchSprint {state:"active"}` (`SPRINT_ACTIVE` returns the active id). `complete_sprint {sprintId, carryTo: "next"\|"backlog"\|"new"\|<sprintId>}` (D178). |
| `link_attachment` | `tasks:write` | `task_write` | `{cardId, documentId, commentId?}` (D179). Idempotent. |
| `bin_event` / `restore_event` | `bin:write` + `calendar:write` | B / – | `deleteEvent` (writer) and `restoreCalendarItem("event")` (the owner or the binner). `PARENT_IN_BIN` when its calendar is binned. |
| `create_collection` | `collections:write` | `row_write` | `{name, icon?, templateId? \| fields?}` (exactly one of the two, `SCHEMA_LIMITS`, `hasPrototypeKeys` guard). Private. ≤100 per owner (`LIMIT_REACHED`). |
| `bin_row` / `restore_row` | `bin:write` + `collections:write` | B / – | `deleteRow` (editor) and collections Bin restore (the owner or the binner). |
| `create_text_file` | `files:write` | `file_write` 100/key, 200/user a day | D176(a). `purpose: "file"` (default, owned folder or Default) or `"task_attachment"`. NUL bytes or invalid UTF-8 → `INVALID`. |
| `begin_upload` / `finish_upload` | `files:write` | `file_write` on begin; `finish` read | D176(b). `sizeBytes ≤ MAX_UPLOAD_BYTES`. The quota is checked at begin (advisory) and again at commit. Bytes are also capped at 1 GiB per user a day (in memory). |
| `rename_file` / `move_file` | `files:write` | `structure_write` | Extract `patchDocument(userId, id, {name?, folderId?})` from the route (shared with HTTP). `move_file` applies D177. Owned `purpose='file'` documents only. |

`PUT /mcp/uploads/:uploadId` (in `server/mcpUploads.ts`) sits next to `app.all("/mcp")`, outside `/api` (no cookie, no CSRF). It uses the same Host/Origin checks as `handleMcpRequest`, the bearer key lookup (live, not blocked, email allowed, `files:write` effective), and a ticket match on `keyId`. Then it applies the shared per-user upload slot and the `activeRequests` cap. It answers 201 `{document}`, or 200 `{document, idempotentReplay: true}` on a retry (the web upload's replay contract), and otherwise 400/401/404/408/411/413/507 with the web upload's codes. To make this possible, refactor `handleUpload` into `receiveMultipart` / `receiveRaw` → `commitUpload(userId, stagedId, meta)` so both entry points share quota, disk, sniff, block re-check, and idempotency.

### 2.3a Ledger and ticket sketches

```text
seenDrafts: Map<keyId, LRU<noteId, {revision, checksum, at}>>   // ≤500 per key, TTL 1 h, swept like MCP windows
  remember(key, note)  after create_note / get_note_draft / update_note_draft return
  publish_note_draft({noteId, revision}):
    withNoteLock: note = ownedNote(noteId, key.userId) ?? NOT_FOUND
      note.draft_revision === null                 → NO_DRAFT
      seen = seenDrafts[key][noteId]; !seen || seen.revision !== revision || seen.checksum !== note.draft_checksum → DRAFT_NOT_SEEN
      revision !== note.draft_revision             → DRAFT_CHANGED
      publishDraftLocked(note, userId, {revision}) → NO_CHANGES when !hasDraftDelta
      forget(key, noteId)

uploadTickets: Map<uploadId, {keyId, userId, name, sizeBytes, sha256, folderId|null, purpose, expiresAt, state}>
  begin_upload: ≤3 open for the key → LIMIT_REACHED; folder owned (purpose file) → else NOT_FOUND;
                quota pre-check → QUOTA_EXCEEDED; return {uploadId, uploadUrl, method:"PUT", headers:{Content-Type, Content-Length}, expiresAt}
  PUT /mcp/uploads/:id: bearer → key; ticket.keyId === key.id else 404; state pending; Content-Length === sizeBytes else 400;
                receiveRaw → staging (sha256 while streaming) → mismatch ⇒ discard + state failed(HASH_MISMATCH);
                commitUpload(userId, staged, {name, folderId, purpose, uploadKey: uploadId}) → state committed(documentId)
  finish_upload: committed → {document}; pending → UPLOAD_PENDING; expired → UPLOAD_EXPIRED; failed → its code; then delete the ticket
```

Tool descriptions matter because agents read them. Each Bin tool says "moves to the Bin for 30 days; the person can restore it". `publish_note_draft` says "makes the draft the note's published text, visible to everyone the note is shared with; call get_note_draft first and pass its revision". `complete_sprint` says "cannot be undone". `move_file` says "refuses moves that would change who can see the file".

### 2.3b Rate buckets (added to `server/mcpRateLimit.ts`)

| Bucket | Per key | Per user | Window |
| --- | --- | --- | --- |
| `note_publish` | 50 | 100 | day |
| `bin_action` | 50 | 100 | day |
| `bin_burst` | 10 | 20 | minute |
| `sprint_write` | 20 | 40 | day |
| `structure_write` (folders, rename/move file) | 100 | 200 | day |
| `file_write` (text files, upload tickets) | 100 | 200 | day |

The existing `call` (120/min) and `write` (30/min) buckets apply on top, and `task_write` / `row_write` cover tags, WIP, attachments, and collections. The upload byte budget (1 GiB per user a day) is a separate in-memory counter, charged at commit.

### 2.4 API deltas (API_CONTRACTS.md)

- `MCP_SCOPES` + the three scopes. `POST /api/mcp/keys` accepts them. Viewers get `SCOPE_NOT_ALLOWED` for all three (write scopes).
- `GET /api/mcp/keys/:id/binned?window=` → `{ items: [{type, id, title, binnedAt, restorable: boolean}], truncated }`. `POST /api/mcp/keys/:id/restore-binned {window}` → `{ restored, skipped }`. Both are the key owner's only (404 otherwise), and the POST sits under the usual mutation safety. Read-only roles get `ROLE_READ_ONLY` from the gate.
- `POST /api/notes/:id/publish`: behaviour unchanged (the logic moves to `noteDrafts.ts`).
- `PUT /mcp/uploads/:uploadId`: as above.

### 2.5 UI (desktop and 390 px)

- **Settings → MCP server → Permissions**: three new checkboxes with help lines. "Publish notes" gets an extra warning line: "An agent can make its drafts visible to everyone the note is shared with." Checking one locks its implied read, as today. Key chips show the new scopes.
- **Key row**: when the key binned anything in the last 24 h, a line reads "Moved 7 items to the Bin today · **Review**". Review opens a dialog (history guard) with a **Window** custom `Select` (Last hour, 24 hours, 7 days), the item list (type icon, title, time), **Restore all**, and a secondary **Revoke this key**. At 390 px it is a full-height sheet with 44 px rows.
- **Bin app**: items binned through a key show a "via <key name>" chip, taken from the same audit lookup batched per list load (≤500 items).
- **Notes**: the existing "Draft by <key>" badge clears on MCP publish. The version history shows the key owner as author (no change).
- History parity: Settings → Review dialog. Back closes the dialog before leaving Settings.

### 2.6 Threat rows (append as "MCP write coverage (Wave 19)")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T142 | **Prompt-injected mass binning** ("clean up: bin every card") | A separate opt-in `bin:write` scope, all-of with the module write scope, 10 a minute and 50 a day per key (100 per user), restores exempt from the cap, the per-key "Review and Restore all" Undo, "via key" chips in the Bin, 30-day retention, no purge or empty tool. | Required |
| T143 | **Publishing unseen or changed content** (a blind publish of a human's draft, a race with a human edit) | `notes:publish` opt-in with a warning. The D173 seen-revision ledger (revision + checksum returned to *this* key). The route CAS `WHERE draft_revision = ?` in the publish transaction. A daily cap of 50. Audit carries keyId. | Required |
| T144 | **Scope classification drift** (a new write scope treated as read, so viewers hold it) | The explicit `MCP_WRITE_SCOPES` list (D171) and a test that every scope is classified exactly once. A viewer key creation with any write scope → 403. `mcpScopesForRole("viewer")` snapshot test. | Required |
| T145 | **Silent power growth of existing keys** | New powers come only through new scopes. Additions to existing write scopes (tags, WIP, sprints, collection creation) are listed in the release notes, and the Settings help text changes in the same commit. | Required |
| T146 | **Upload ticket abuse** (a leaked upload URL, replay, oversize, slow body, bypassing quota) | The ticket needs the same bearer key. Single use, 15 min, ≤3 open. Content-Length is required and must equal `sizeBytes`. SHA-256 verified before commit. Quota, disk, T80, and idle watchdog are the web pipeline's. Sniffing ignores the client type. Previews follow the D6/D7 allowlist. | Required |
| T147 | **Sharing by side effect** (moving an inheriting file into a shared folder, linking a Files item onto a shared board) | D177 `AUDIENCE_CHANGE`. D179 accepts only `task_attachment` documents. New folders and uploads are private by default. | Required |
| T148 | **Restoring or binning another person's items** | Existing predicates (the owner, or the binner with write access). Missing, forbidden, and binned all look the same (`NOT_FOUND`). Tests cover the share matrix for member, viewer, and guest keys. | Required |
| T149 | **Irreversible sprint completion by an agent** | Owner only, the active sprint's id required (CAS), explicit `carryTo`, 20 a day, the description says it is irreversible, audited. | Accepted (documented) |

### 2.7 Test rows (TEST_PLAN.md "Wave 19")

| Area | Test |
| --- | --- |
| Scopes | Each new tool is hidden from and rejects keys without its any-of **and** all-of scopes. `bin:write` alone lists no Bin tools. A viewer can hold none of the three. Every scope is classified once (D171). Existing keys' `tools/list` is unchanged apart from the new tools under their existing write scopes. |
| Publish | Without a prior `get_note_draft` → `DRAFT_NOT_SEEN`. A guessed revision → `DRAFT_NOT_SEEN`. A human edit after the read → `DRAFT_CHANGED`. The happy path creates a version, clears the badge, updates the index, and writes an audit row with keyId. Shared or binned notes → `NOT_FOUND`. A restart clears the ledger. The HTTP publish tests still pass. |
| Bin | `bin_note` on a blank draft → in the Bin, not purged. Card with children → the tree is binned and restored. Event in a binned calendar → `PARENT_IN_BIN`. The 11th bin in a minute and the 51st in a day → `RATE_LIMITED`, while restores still succeed. A reader who did not bin → `NOT_FOUND` on restore. |
| Undo | Bin 5 items through a key, then `restore-binned` → 5 restored, and an item already restored is skipped. A 200k-row audit table answers in <500 ms (perf test, skipped in CI if slow hardware; recorded at the gate). |
| Tasks | Tags: create as a writer, rename or recolour as a non-owner → `OWNER_ONLY`. WIP limit owner only. Sprints: start while one is active → `SPRINT_ACTIVE`. Complete a non-active sprint → `SPRINT_NOT_ACTIVE`. `carryTo: next` without a planned sprint → `NO_NEXT_SPRINT`. `link_attachment` with a Files document → `NOT_FOUND`. |
| Collections | Template and fields both given → `INVALID`. `__proto__` field → `INVALID`. The 101st collection → `LIMIT_REACHED`. The new collection is private. |
| Files | `create_text_file` stores with `preview_kind:text`; a NUL byte → `INVALID`. Upload ticket: wrong key → 401; a second PUT → idempotent replay; Content-Length mismatch → 400; hash mismatch → `HASH_MISMATCH` with staging discarded; expired → `UPLOAD_EXPIRED`; quota → 507; owner blocked mid-upload → 401 and nothing committed. `move_file` from a private to a shared folder while inheriting → `AUDIENCE_CHANGE`; with an override → allowed. |
| Rules | The D180 name, description, and import guards. |
| UI | Settings checkboxes and locks. The Review dialog with its Select at 390 px. Back closes the dialog. The Bin "via key" chip. |

### 2.7a Files touched and gate

`server/mcpScopes.ts`, `server/mcpToolKit.ts`, `server/mcpTools.ts` (notes, files, folder tools, ledger), `server/mcpRateLimit.ts`, `server/mcpUploads.ts` (new), `server/mcp.ts` (export the key lookup for the PUT route), `server/documents.ts` (upload split, `patchDocument`), `server/noteDrafts.ts` (`publishDraftLocked`), `server/index.ts` (publish route calls the service, mounts `PUT /mcp/uploads/:id`, key binned endpoints), `server/team/roles.ts` (explicit write list), `server/tasks/mcpTools.ts`, `server/calendar/mcpTools.ts`, `server/collections/mcpTools.ts`, `src/mcpPermissions.ts`, `src/McpKeyScopes.tsx`, `src/App.tsx` (key row review), `src/bin/BinApp.tsx` (via-key chip), plus tests `mcpWrites.test.ts`, `mcpUploads.test.ts`, `mcpPublish.test.ts`, `mcpBinUndo.test.ts`, and updates to `mcpScopes.test.ts`, `mcpPermissions.test.ts`, `mcpKeyScopes.test.tsx`, `writeGate.test.ts`.

**Gate:** all tests; a fresh-session `/security-review` focused on T142–T149; a manual run with a real MCP client (Claude Code) covering publish after a read, ten bins then Undo, and a 20 MB upload through the ticket with `curl`; release notes list the new scopes (T145).

### 2.8 Commits (M/L, 3 sessions; each commit leaves the product runnable)

1. `refactor: share draft publish and file patch services with MCP` (`publishDraftLocked`, `patchDocument`, the upload commit split)
2. `feat: add notes:publish, files:write, and bin:write scopes` (explicit write list, `alsoRequires`, `buckets`, the Settings checkboxes)
3. `feat: publish drafts over MCP with a seen revision`
4. `feat: bin and restore notes, cards, events, and rows over MCP`
5. `feat: manage tags, WIP limits, sprints, and attachments over MCP`
6. `feat: create collections and folders over MCP`
7. `feat: store text files and ticketed uploads over MCP`
8. `feat: review and undo what an MCP key binned` (endpoints, Settings dialog, Bin chip)
9. `docs: document MCP write coverage` (USING "What agents can change", API_CONTRACTS, THREAT_MODEL T142–T149, TEST_PLAN, TODO)

---

## 3. Wave 20: Emoji reactions (v0.12.0, migration 022)

### 3.1 Goals

People react to **task card comments** with a small curated set of emoji. Each reaction chip shows its count and whether you reacted, and one tap toggles it. The table and the service are generic, so the Messages module later registers `message` as a target kind with no schema change. Card descriptions are **not** in v1 (the recommendation): a description is a living document, and a reaction on it goes stale as the description changes.

### 3.2 Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D182 | One generic `reactions` table. Target kinds are registered in code (`server/reactions/targets.ts`: `{ kind, readable(targetId, userId), writable(targetId, userId), boardLockKey? }`). v1 registers only `card_comment`. The DB constrains `target_kind` by shape, not by an enum. | Messages can reuse it with no table rebuild. |
| D183 | A **curated set of 12**, stored as stable keys: `thumbs_up 👍, thumbs_down 👎, heart ❤️, laugh 😂, tada 🎉, eyes 👀, rocket 🚀, check ✅, fire 🔥, thinking 🤔, pray 🙏, sad 😢` (`shared/reactions.ts`, used by both server and client). Anything else → 400. | No Unicode normalisation or ZWJ issues, and a glyph can be swapped without data migration. |
| D184 | The API is **idempotent set-state**: `PUT` adds, `DELETE` removes. The UI "toggle" picks the verb from the current `reacted` state. A double tap or a retry never flips twice. | "Toggle" semantics without the retry hazard. |
| D185 | Whoever may **comment** may react: a board reader with the `content.write` role. Viewers and guests see reactions but cannot add them (write gate default-deny, no allowlist entry). Reacting to a comment on a binned card → 404. | Matches comments. See the open decisions for viewers. |
| D186 | Aggregates are embedded in every comment payload (`listComments`, `createComment`, `get_card`): `reactions: [{emoji, count, reacted, names: string[≤10], more}]`, ordered by the first reaction's time. The aggregates are computed in one GROUP BY per page (≤50 comments). | No extra round trip. Bounded. |
| D187 | Cleanup: an `AFTER DELETE ON card_comments` trigger deletes the comment's reactions. This covers comment deletion and the FK cascade from card or board purge (SQLite fires triggers for cascade deletes, and a test proves it). `user_id … ON DELETE CASCADE`. A binned card's reactions stay hidden until restore. Each future kind adds its own trigger. | One rule for every delete path. No orphan rows. |
| D188 | Limits: 60 reaction writes a minute per user (in memory, `429 RATE_LIMITED`). By construction ≤12 per user per target. No per-target cap beyond readers × 12. | Stops scripted spam. The set bounds storage. |
| D189 | MCP: read-only exposure. `get_card` comments gain `reactions: [{emoji, glyph, count, reacted}]` (no names, to keep the output small). There is no MCP reaction write in v1. | The brief asked for read exposure only. A write is easy to add later under `tasks:write`. |
| D190 | Reactions create no notifications and do not bump `cards.updated_at` or the card `revision`. They are not searchable and do not appear on Today. | Keeps reactions lightweight, and editors never get `CARD_CHANGED` because of a 👍. |

### 3.3 Migration `server/migrations/022_reactions.ts`

```sql
CREATE TABLE reactions (
  target_kind TEXT NOT NULL CHECK (length(target_kind) BETWEEN 1 AND 32 AND target_kind NOT GLOB '*[^a-z_]*'),
  target_id TEXT NOT NULL CHECK (length(target_id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 24 AND emoji NOT GLOB '*[^a-z_]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id, user_id, emoji)
) WITHOUT ROWID;
CREATE INDEX idx_reactions_user ON reactions(user_id, created_at DESC);
CREATE TRIGGER reactions_card_comment_cleanup AFTER DELETE ON card_comments
BEGIN DELETE FROM reactions WHERE target_kind = 'card_comment' AND target_id = OLD.id; END;
```

The primary key gives the UNIQUE (user, target, emoji) rule and the per-target aggregate scan. The assertion then includes 22 (and 21 if the Agent-inbox wave has merged, since gaps are tolerated).

### 3.4 API deltas (API_CONTRACTS.md § Tasks → Comments, plus a generic "Reactions" section)

| Method and path | Who | Response and errors |
| --- | --- | --- |
| `PUT /api/reactions/:kind/:targetId/:emoji` | A writer on the target (D185) | 200 `{ reactions: Aggregate[] }` for that target (idempotent: already reacted → 200). 404 for an unknown kind, an unreadable target, or a binned card. 400 `INVALID_EMOJI`. 429. 403 `ROLE_READ_ONLY` (gate). |
| `DELETE /api/reactions/:kind/:targetId/:emoji` | same | 200 `{ reactions }` (idempotent). |
| `GET /api/tasks/cards/:id/comments` and comment create/edit | unchanged callers | Each comment gains `reactions` (D186). |

The route body is empty, and the JSON Content-Type and CSRF rules still apply. The service (`server/reactions/service.ts`) takes the board lock only to re-check readability, and writes with `INSERT OR IGNORE` / `DELETE`. Audit is skipped for reactions (high volume, low value). The write is attributable through the row itself.

### 3.4a Aggregate query (per comment page)

```sql
SELECT r.target_id, r.emoji, COUNT(*) AS count,
       MAX(r.user_id = $userId) AS reacted,
       MIN(r.created_at) AS first_at,
       json_group_array(u.display_name) AS names          -- trimmed to 10 in code, `more` = count - 10
FROM reactions r JOIN users u ON u.id = r.user_id AND u.disabled_at IS NULL
WHERE r.target_kind = 'card_comment' AND r.target_id IN (SELECT value FROM json_each($commentIds))
GROUP BY r.target_id, r.emoji ORDER BY r.target_id, first_at;
```

Reactions of blocked accounts are kept but not counted or named while the account is blocked, matching the pickers' exclusion of blocked users. Unblocking brings them back.

### 3.5 UI (`src/tasks/CommentReactions.tsx`, `src/ui/ReactionPicker.tsx`)

- Under each comment body there is a row of chips, each showing the glyph and the count. `aria-pressed` reflects "you reacted", and `aria-label` reads "👍 3: Asha, Ben, and you. Press to remove yours." Chips have `min-height: 44px` via padding (the glyph is 18 px). Chips wrap and the row never scrolls horizontally at 390 px. The **Add reaction** button (smiley-plus icon, 44×44) sits last in the row, and on desktop it only appears on comment hover or focus when no reactions exist.
- **Picker**: a custom popover (D91 family) with a 4×3 grid of 44 px buttons, placed with `popoverPosition.ts` and keyboard-navigable through `listNavigation.ts` (arrows, Home/End, Enter, Escape returns focus). At ≤760 px it opens as a bottom sheet with `useHistoryDialogGuard`, so **Back closes the sheet** and never the card. The sheet header lists the current reactions with names (the mobile answer to hover tooltips).
- Optimistic update with rollback and a toast on error. Rate-limit toast: "Slow down a little."
- Read-only roles see chips as static (no button role), and the picker is hidden (`roleChrome` pattern).
- The same component renders in `CardDialog` and `CardPage` (full page).
- History: card drawer → picker sheet. Back closes the sheet, then the card, then returns to the board. Forward reopens the card, never the picker (dialogs push no entry).

### 3.6 Threat rows (append as "Reactions (Wave 20)")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T150 | **Reaction spam or storage abuse** | A fixed 12-key set, a PK that allows one row per user × target × emoji, 60 writes a minute per user, the write gate for read-only roles, and no notifications (nothing to amplify). | Required |
| T151 | **Reacting to or probing unreadable targets** (a private board's comment id, a binned card) | Every write re-checks `readable` and `writable` through the kind registry. Missing, forbidden, and binned all give 404. Aggregates are only ever embedded in payloads the caller can already read. | Required |
| T152 | **Orphaned reactions revealing activity** after a comment or card purge | The D187 trigger plus the user cascade. Tests purge a card and a board and assert zero rows remain. | Required |
| T153 | **Injection through emoji or names** | Keys are validated server side, glyphs come from the shared table, and names render as React text. The DB GLOB CHECKs reject anything outside `[a-z_]`. | Required |

### 3.7 Test rows (TEST_PLAN.md "Wave 20")

| Area | Test |
| --- | --- |
| Migration | Assertion includes 22. The PK refuses a duplicate. The GLOB CHECK refuses `👍` and `Thumbs`. The trigger fires on direct comment delete **and** on the card-purge cascade. |
| API | PUT twice → one row, 200. DELETE when absent → 200. Unknown emoji → 400. Unknown kind → 404. A card on a private board → 404. A binned card → 404, and after restore the reactions reappear. Viewer and guest → 403. The 61st write in a minute → 429. |
| Aggregates | Counts, `reacted`, names ≤10 with `more`, ordering by first reaction. One query per comment page (query-count test). `cards.revision` unchanged. |
| MCP | `get_card` comments carry `reactions` without names. No reaction tool exists. |
| UI | Chips: `aria-pressed`, 44 px, wrapping at 390 px. Picker keyboard nav and Escape focus return. At 390 px Back closes the sheet before the card. Read-only chrome. `noNativeSelect.test.ts` passes. |

### 3.7a Files touched and gate

`server/migrations/022_reactions.ts`, `server/migrations/index.ts`, `shared/reactions.ts` (new: keys, glyphs, labels), `server/reactions/{targets,service,routes}.ts` (new), `server/tasks/comments.ts` (embed aggregates), `server/tasks/mcpTools.ts` (`get_card`), `server/index.ts` (register routes), `src/tasks/CommentReactions.tsx`, `src/ui/ReactionPicker.tsx`, `src/tasks/CardDialog.tsx`, `src/tasks/CardPage.tsx`, `src/tasks/tasksApi.ts`, `src/tasks/tasks.css`, tests `reactions.test.ts`, `reactionsUi.test.tsx`, `migrations.test.ts`, `mcpTasks.test.ts`, `writeGate.test.ts`.

**Gate:** all tests; a 390 px pass on a real phone for the picker sheet and chip wrapping; backup before deploy; `schema_migrations` shows 22.

### 3.8 Commits (S, 1 session)

1. `feat: add reactions migration 022`
2. `feat: react to card comments` (registry, service, routes, aggregates, rate limit, MCP `get_card`)
3. `feat: show and pick reactions on card comments` (chips, picker popover and sheet)
4. `docs: document reactions` (API_CONTRACTS, THREAT_MODEL T150–T153, TEST_PLAN, USING, TODO: close the "emoji reactions?" backlog item)

---

## 4. Release order and versions

| Order | Wave | Version | Migration | Why this order |
| --- | --- | --- | --- | --- |
| 1 | W18 Team invites | **v0.10.0** | 018 | It is the oldest open item. It touches `server/team/**`, `src/team/**`, and the register handler, and it closes the "toggle `ALLOW_REGISTRATION`" workaround. Back up before deploying (migration). |
| 2 | W19 MCP write coverage | **v0.11.0** | none | It touches every module's `mcpTools.ts`, `mcpToolKit.ts`, `mcpScopes.ts`, `documents.ts`, and `index.ts` (publish). Merging after W18 avoids two waves editing `server/team/mcpTools.ts` and `index.ts` at once. |
| 3 | W20 Reactions | **v0.12.0** | 022 | Small and self-contained. It can be **implemented in parallel** with W19 in its own worktree (`server/reactions/**`, `src/tasks/CommentReactions.tsx`, `src/ui/ReactionPicker.tsx`). Its only overlaps are `server/tasks/mcpTools.ts` (the `get_card` shape) and `server/tasks/comments.ts`, which the merge agent resolves. Back up before deploying. |

W18 and W20 can also run in parallel, because they have disjoint modules. The director merges in the order above. One reviewer per wave, container verification once per release, QA on `nook-qa` rebuilt from `main`. Release notes for v0.11.0 must list the three new scopes and the additions to `tasks:write` and `collections:write` (T145).

## 5. Size

| Wave | Size | Sessions | New tests (approx.) |
| --- | --- | --- | --- |
| W18 | S/M | 1–2 | 35 |
| W19 | M/L | 3 | 70 |
| W20 | S | 1 | 25 |

## 5a. Docs each wave updates

| Doc | W18 | W19 | W20 |
| --- | --- | --- | --- |
| `docs/USING.md` | "Inviting people" (create, copy once, revoke, what the invitee sees, the allowlist still applies) | "What agents can change" table (tool → effect → how to undo), the three new permissions, and Review/Restore all | "Reactions" (who can react, the 12 emoji, no notifications) |
| `docs/plan/API_CONTRACTS.md` | Team → Invites; register `inviteToken`; `POST /api/auth/invite` | MCP tools table, scopes, buckets, error codes, upload PUT, key binned endpoints | Reactions section; comment payload `reactions` |
| `docs/plan/THREAT_MODEL.md` | T136–T141 | T142–T149 | T150–T153 |
| `docs/plan/TEST_PLAN.md` | §1.8 rows | §2.7 rows | §3.7 rows |
| `docs/OPERATIONS.md` | Proxy access logs may hold the first invite GET (T136); invites need no env change | None | None |
| `docs/ARCHITECTURE.md` | `team_invites` | MCP upload route, ledger | `reactions` and the kind registry |
| `TODO.md` | Close "Wave 16 (Team C)" | Close "MCP write-coverage wave" | Close "emoji reactions?" |
| Site "What's new" | v0.10.0 | v0.11.0 | v0.12.0 |

## 6. Open decisions (defaults apply unless the operator overrides)

| # | Question | Default |
| --- | --- | --- |
| Q1 | Invite link form: `?invite=` (as briefed) or `#invite=` (never reaches the server or proxies)? | **`?invite=` with an immediate `replaceState`.** Switching later is a one-line change in the SPA and the link builder. |
| Q2 | Extend `team_events` (a table rebuild in 018) to carry invite actions? | **No** (D165). Derive them from `team_invites`. |
| Q3 | Live-invite cap per instance or per admin? | **Per instance, 20.** |
| Q4 | Default role in the create dialog? | **Guest**, mirroring `SIGNUP_ROLE`. |
| Q5 | Add bins or restores for Files documents (`bin_file`) in W19? | **No.** Attachment links make it subtle (`ATTACHMENT_LINKED`). Revisit with demand. |
| Q6 | Keep `complete_sprint` over MCP (irreversible)? | **Yes**, with the D178 CAS and cap. Drop it if the operator prefers strict reversibility. |
| Q7 | Put tags, WIP, and sprints under a new `tasks:manage` scope instead of `tasks:write`? | **No**: the same module, create/update only, and owner-only where it matters. Called out in the release notes (T145). |
| Q8 | Restrict `publish_note_draft` to notes whose audience is only the owner? | **No.** The publish is allowed and the result reports `audience`. The Settings warning names the risk. |
| Q9 | Ship the ticketed binary upload or only `create_text_file`? | **Both** (D176). If W19 runs long, the ticket path moves to a follow-up patch and text files ship first. |
| Q10 | Add `idx_audit_log_actor_created` if the Undo scan misses 500 ms? | **Only if measured slow.** It then takes the next free migration id after 022 at that time. |
| Q11 | Let viewers react (an allowlist entry in the write gate)? | **No** in v1, consistent with comments. It is a one-line allowlist change. |
| Q12 | Reactions on card descriptions? | **No** in v1 (§3.1). |
| Q13 | Numbering collision with the parallel Agent-inbox plan (D161+, T136+)? | The director renumbers whichever plan merges second. |

## 7. Out of scope

Email delivery of invites; admin invites; bulk or CSV invites; MCP invite creation. MCP hard deletes, purge, empty Bin, sharing, roles, team writes, and key management. Files Bin tools. Folder rename or move over MCP. A full emoji keyboard, custom emoji, reaction notifications, and reactions outside card comments (Messages will add its kind when it ships).

---

## Director review (2026-09-28)

Accepted as the plan of record with these rulings:

- **Numbering:** decisions renumbered to D161–D190 and threat rows to T136–T153 (the Agent-inbox plan holds D146–D160 and T125–T135).
- **Wave 18 invites:** use the URL **fragment** (`/register#invite=<token>`) rather than `?invite=`, so the token never reaches server logs or referrers; the client posts it in the JSON body. All other defaults accepted (bypasses only `ALLOW_REGISTRATION`; honours `ALLOWED_EMAILS` and an email binding; role fixed member|viewer|guest; 20 live, 10/h per admin; creator must still be an active admin; `list_invites` read-only; history from `team_invites` + audit).
- **Wave 19 MCP writes:** `complete_sprint` is **dropped** from MCP (irreversible). Keep `create_sprint`/`start_sprint`. Tags, WIP limits and sprints stay under `tasks:write`. New opt-in scopes `notes:publish`, `files:write`, `bin:write` accepted; explicit write-scope list for the viewer filter accepted; publish requires a revision this key has been shown; Bin caps 10/min and 50/day per key; the two-step `begin_upload` → `PUT /mcp/uploads/:id` → `finish_upload` path and `create_text_file` ≤1 MiB accepted; base64 binaries rejected.
- **Wave 20 reactions:** comments only in v1, 12 curated emoji, idempotent PUT/DELETE, registered target kinds for reuse by Messages; accepted.
- **Order and versions:** Wave 18 → v0.10.0 (backup: migration 018); Wave 20 → with v0.10.0 if ready (migration 022); Wave 19 → v0.11.0; Wave 21 (Agent inbox) → v0.12.0 (migration 021). Wave 19 starts after Wave 21 merges so the MCP scope files change once.
