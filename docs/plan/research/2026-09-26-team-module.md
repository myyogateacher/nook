# Research: Team module (users, roles, blocking)

Date: 2026-09-26. Status: **research and proposal only**. Nothing here is scheduled until the operator picks it. Base: `main` at `29793f7` (v0.7.0 released, migrations 1–14).

Operator requirements:

1. A **Team** module listing every user registered on the platform.
2. Role-based access with exactly four roles: **admin, member, viewer, guest**.
3. Block and unblock a user from the platform.

This follows the structure of `docs/plan/WAVES_7-9.md` and `docs/plan/WAVES_10-12.md`: current state, decisions (numbered from **D71**, since D70 is the last one in WAVES_10-12; note that DEVELOPMENT_PLAN.md §3 now also uses D51 and D52 for the 2026-09-26 Select and Modules rules, which collide with WAVES_10-12 D51 and D52, so the director may want to renumber those two), schema, API, UI and history, MCP, threat rows (from **T77**, since T76 is the last one in THREAT_MODEL.md), waves, tests, and open questions. It keeps the binding rules in `DEVELOPMENT_PLAN.md` (lines 16–26): works at 390 px first with Back/Forward parity, MCP coverage for each module, parallel waves on separate modules, append-only migrations, and placeholders instead of real values.

---

## 1. Current state

### 1.1 How users are created

- `POST /api/auth/register` (`server/index.ts:215-245`). While the `users` table is empty, registration is always allowed. After that, `ALLOW_REGISTRATION=true` is required (`server/config.ts:72`, checked at `index.ts:217` and again inside the insert transaction at `index.ts:227-228`, so two concurrent "first" registrations cannot both get through). There is a global limit of 10 registrations a minute (`index.ts:218`).
- `ALLOWED_EMAILS` (`config.ts:30-35`, `isEmailAllowed` at `config.ts:89`) is an allowlist enforced at registration (`index.ts:220`), at login (`index.ts:250`), on **every request** (`auth.ts:64-69`, which also deletes the session and revokes push), for MCP keys (`mcp.ts:123`), and for calendar feeds (`calendar/feeds.ts:157`).
- A new user gets a Default folder (`index.ts:231`, `db.ts:80-96`) and an immediate session. The first user is not special in any way. They are simply the first row.
- `docs/OPERATIONS.md:16` tells operators to turn `ALLOW_REGISTRATION` on only briefly while adding trusted users. There are no invites.

### 1.2 Is there an admin concept?

**No.** `users` (`migrations/001_initial.ts:8`) has `id, email, display_name, password_hash, created_at, disabled_at`, and migrations 003/004 add the TOTP columns (`db.ts:24-35`). There is no role column, and no route checks privilege beyond ownership. The only administrative action is a **host CLI**: `bun server/reset-totp.ts user@example.com` (`server/reset-totp.ts`, documented at `docs/OPERATIONS.md:28-31`). It clears TOTP, deletes sessions, revokes push, and audits `auth.totp_admin_reset`. The "administrator" is whoever holds a shell on the host. That is the model a Team CLI should copy for recovery.

### 1.3 `disabled_at` already works as a block flag

`users.disabled_at` has existed since migration 001, but **no route or CLI sets it**. Only tests set it (`tests/push.test.ts:306`, `tests/tasksDates.test.ts:77`, `tests/calendarFeeds.test.ts:251`). It is nevertheless honoured almost everywhere:

| Path | Where | Effect of `disabled_at IS NOT NULL` |
| --- | --- | --- |
| Session auth | `auth.ts:55-59` (JOIN users … `u.disabled_at IS NULL`) | Every cookie request gets 401. The session row stays but is dead. |
| Login | `index.ts:251` | Returns the generic "Invalid email or password" (401). There is no clear message. |
| MCP bearer auth | `mcp.ts:118-122` | 401 "Invalid or revoked API key" |
| MCP per-call re-check | `mcpTools.ts:35-44` (`loadLiveKey`), `runTool` at `:50-52` | `SCOPE_REQUIRED` "no longer active" |
| Calendar feeds | `calendar/feeds.ts:155-157` | Uniform 404 |
| Push delivery | `calendar/push.ts:333-336` | Subscriptions deleted on the next send |
| Share pickers | `index.ts:454` (`GET /api/users`), share validation at `index.ts:518`, `:780`, `documents.ts:474`, `tasks/service.ts:193`, `collections/service.ts:239`, `calendar/service.ts:182` | Disabled users cannot be picked or added |
| Task assignees | `tasks/service.ts:376-386` | Not assignable, and left out of the readers list |
| TOTP and key routes | `index.ts:319, 350, 358, 376, 401, 421, 437` | Treated as signed out |

**What sets it today: nothing.** A search of `server/`, `scripts/`, and `src/` finds no `UPDATE users SET disabled_at` outside tests. No migration writes it, `server/reset-totp.ts` only *reads* it (line 10), and there is no admin route. Nobody set it on purpose: the column was reserved in 001 and every later module (for example `requireAssignableUser`, `tasks/service.ts:384-389`, and `listBoardReaders`, `tasks/service.ts:374-381`) copied the `disabled_at IS NULL` filter. On a production database it should be NULL for every row, unless someone ran manual SQL. The migration handles that case anyway (§3.3).

**Conclusion:** most of "block" is already built. The Team module needs a way to *set* this flag and the side effects around it, not a new enforcement path. The recommendation (D74) is to reuse `disabled_at` as the block timestamp rather than add a parallel `blocked_at` that every one of those sites would also have to check.

Reuse compared with a separate `blocked_at`:

| | Reuse `disabled_at` (recommended) | Add `blocked_at` |
| --- | --- | --- |
| Enforcement sites to change | 0 (about 25 already filter on it) | Every site in the table above, plus every future module |
| Risk of a bypass | None added | Any site that was missed lets a blocked user in (sessions, MCP, feeds, pickers) |
| Meaning | "Account cannot be used." Blocking is the only way to set it. | Two flags with overlapping meaning ("disabled" versus "blocked"), and no product use for the difference |
| Naming | The column name stays `disabled_at`. API and UI say `blockedAt` and "Blocked", and `db.ts` documents the alias. | Clearer column name |

If a future feature needs a *different* inactive state, such as self-deactivation or a pending invite, add a `status` column then. Do not overload `disabled_at`.

Gaps a block must close:

- Session rows are not deleted, so they revive on unblock.
- Push subscriptions are revoked lazily, only on the next send.
- Login gives no clear message.
- Nothing records who blocked the user or why.
- The reminders dispatcher (`server/calendar/reminders.ts`) keeps writing in-app notifications for a disabled user. This is harmless because they cannot read them, but it is wasteful.
- An in-flight upload passed `requireAuth` before the block and commits afterwards (`documents.ts:285-297`).

### 1.4 Sessions and MCP keys

- Sessions are opaque cookie tokens stored as a SHA-256 hash (`auth.ts:26-42`). They have a CSRF token per session, `SameSite=Strict`, and `SESSION_DAYS` expiry. `requireAuth` does **one indexed JOIN per request** plus a `last_seen_at` UPDATE (`auth.ts:55-73`). Adding `u.role` to that SELECT costs nothing extra.
- MCP keys (`migrations/005`, scopes in `010`) belong to a user (`user_id` FK, `ON DELETE CASCADE`). Scopes are fixed at creation (`mcp.ts:24-42`, `mcpScopes.ts`), and each user can hold up to 10 live keys (`index.ts:333-334`). Creating a key needs the password plus TOTP (`index.ts:316-332`); this is the precedent for re-authenticating before sensitive Team actions. `runTool` re-reads the key from the database on every call (`mcpTools.ts:50-60`), so a role filter placed in `loadLiveKey` takes effect immediately.
- `/mcp` sits **outside** `/api/*`, so no `/api` middleware (CSRF, TOTP gate, or a future role gate) runs for it. Role limits for MCP must therefore be applied in `mcp.ts` and `mcpTools.ts` themselves.
- There are no WebSocket or SSE channels. A grep of `server/` and `src/` for `EventSource|WebSocket|text/event-stream` finds nothing. The service worker fetches notifications with the session cookie (`public/sw.js`), so deleting the session cuts it off.

### 1.5 Existing cross-user visibility (per module)

Every module uses the same three-level audience: `private | selected | all_users`. **`all_users` means every account that can sign in**; the copy says "everyone signed in" (`docs/USING.md:52, 93, 100, 120`).

| Module | Predicate | `all_users` sites | What a reader can do |
| --- | --- | --- | --- |
| Notes and folders | `readableNotePredicate`, `listReadableFolders` (`server/access.ts:9-51`). Inline copies: `GET /api/notes` (`index.ts:537-561`), MCP `listNotesQuery` (`mcpTools.ts:74-91`), search (`searchRoutes.ts:59`), Today (`today/providers.ts:78`) | 3 + 4 + 2 + 1 + 1 | Read only. Only the owner mutates (DEVELOPMENT_PLAN D2). |
| Files | `server/documentAccess.ts:30-152` (folder inheritance plus override; attachments via board or collection) | 4 | Read, preview, download |
| Tasks | `readableBoardPredicate` (`tasks/access.ts:24-27`) | 3 | **Readers edit cards** (D38: create, move, comment, bin). Only the owner manages the board. |
| Collections | `readableCollectionPredicate` / `editableCollectionPredicate` (`collections/access.ts:30-36`) | 3 | `share_role` of `viewer` or `editor` applies to the whole audience (D54) |
| Calendar | `calendarAudiencePredicate` (`calendar/access.ts:59-60`) | 3 | `share_role` of `viewer` or `editor` (D54). Reminders are personal. Feeds are per user and per calendar. |
| Bin | owner-only (`server/bin.ts`) | — | Only the owner lists, restores, and purges |
| Today, search, notifications | Built on the predicates above; notifications are per user | — | Read |

Two facts shape the role design:

- **Collections and Calendar already use the word "viewer"** as a per-item share role (D54). A platform role called "viewer" will sit next to it. §2.4 defines how the two combine, and the UI copy must keep them apart.
- There are **no admin overrides**. No code path lets anyone read another user's private content. The proposal keeps it that way (D73).

---

## 2. Role semantics

### 2.1 Decisions

| # | Decision | Why |
| --- | --- | --- |
| D71 | Four **platform roles** stored on `users.role`: `admin`, `member`, `viewer`, `guest`. A role is a **ceiling** on what the per-item sharing already grants. It never grants access to content by itself. | Keeps one ACL system. Roles only take capabilities away, apart from Team management. |
| D72 | **admin** = member plus the Team module (roles, block and unblock, sign-out-everywhere for others, the activity log). **member** = today's behaviour, unchanged. **viewer** = read-only: signs in and reads everything shared with them, including `all_users`, but creates, edits, shares, and uploads nothing. **guest** = read-only **and** excluded from `all_users` audiences, so they see only items shared with them *by name* (`selected`). | A guest in a self-hosted, single-tenant app is an outsider (a contractor or relative) who should see exactly what was handed to them. A viewer is a trusted insider who only reads. |
| D73 | **Admin never bypasses item ACLs.** There is no "view as", no reading of others' private notes or files, and no impersonation. Admins see metadata only: name, email, role, status, created, last seen, TOTP on or off, live MCP key count, and storage bytes. | Keeps the "only owners and recipients read content" invariant (THREAT_MODEL T5) that every module is tested against. |
| D74 | **Block reuses `users.disabled_at`** (the API calls it `blockedAt`). Migration 015 adds `blocked_by` and `block_reason`. It does not add a second flag. | More than 20 enforcement sites already check `disabled_at` (§1.3). A second column would need every one of them changed, and any site that was missed would be a bypass. |
| D75 | Viewers and guests keep **personal, non-content** writes: sign out, TOTP management, mark notifications read, push subscriptions, their own reminders on events they can read, revoking their own MCP keys, and the Collections `query` POST (a read). Everything else under `/api` that is not GET or HEAD gets 403 `ROLE_READ_ONLY` through a **default-deny write gate** (§5.2). | New routes in later waves are read-only for these roles automatically, with no per-route work. |

### 2.2 Permission matrix

✔ = allowed, ✘ = refused (403 `ROLE_READ_ONLY`, or the control is hidden), R = read only. "Shared" means reachable through the module's existing predicate.

| Module / action | admin | member | viewer | guest |
| --- | --- | --- | --- | --- |
| **Notes:** read own | ✔ | ✔ | R (legacy own notes) | R (legacy own notes) |
| Notes: read shared (`selected`) | ✔ | ✔ | ✔ | ✔ |
| Notes: read `all_users` | ✔ | ✔ | ✔ | ✘ (filtered out) |
| Notes: create, draft, publish, restore version, share, delete | ✔ | ✔ | ✘ | ✘ |
| **Folders:** create, rename, share, delete | ✔ | ✔ | ✘ | ✘ |
| **Files:** upload | ✔ | ✔ | ✘ | ✘ |
| Files: preview and download shared | ✔ | ✔ | ✔ (`all_users` too) | ✔ (`selected` only) |
| Files: rename, move, share, delete | ✔ own | ✔ own | ✘ | ✘ |
| **Bin:** list own | ✔ | ✔ | R | R |
| Bin: restore, delete forever, empty | ✔ own | ✔ own | ✘ (**operator decision O3**) | ✘ |
| **Search** (notes, rows) | ✔ | ✔ | ✔ readable | ✔ readable (no `all_users`) |
| **Tasks:** read boards | ✔ | ✔ | ✔ | ✔ (`selected` only) |
| Tasks: create, move, comment on, or bin cards as a board reader (D38) | ✔ | ✔ | ✘ | ✘ |
| Tasks: create boards, columns, sharing | ✔ | ✔ | ✘ | ✘ |
| Tasks: be picked as an assignee | ✔ | ✔ | ✔ (can read the board) | ✔ (named member only) |
| **Collections:** read, query, export CSV | ✔ | ✔ | ✔ | ✔ (`selected` only) |
| Collections: row writes when `share_role=editor` | ✔ | ✔ | ✘ (capped to viewer) | ✘ |
| Collections: create, schema, views, import, sharing | ✔ | ✔ | ✘ | ✘ |
| **Calendar:** read events | ✔ | ✔ | ✔ | ✔ (`selected` only) |
| Calendar: event writes when `share_role=editor` | ✔ | ✔ | ✘ (capped) | ✘ |
| Calendar: own reminders on readable events | ✔ | ✔ | ✔ | ✔ (**O4**) |
| Calendar: iCalendar feed tokens | ✔ | ✔ | ✘ (**O5**) | ✘ |
| **Today** | ✔ | ✔ | ✔ (sections follow the predicates) | ✔ (same) |
| **Notifications, push devices** | ✔ | ✔ | ✔ | ✔ |
| **MCP keys:** create | any scope, plus `team:read` | any current scope | read scopes only | ✘ (**O6**) |
| MCP keys: revoke own | ✔ | ✔ | ✔ | ✔ |
| **Settings:** TOTP, sign out | ✔ | ✔ | ✔ | ✔ |
| **Team:** see the list (name and role) | ✔ plus email, status, and metadata | ✔ | ✔ | ✘ (404; **O7**) |
| Team: change roles, block and unblock, sign a user out everywhere, activity log | ✔ | ✘ | ✘ | ✘ |
| Share pickers (`GET /api/users`) | ✔ | ✔ | ✘ (cannot share) | ✘ |

Notes on the matrix:

- **Legacy own content.** When a member is demoted to viewer or guest, the items they own stay owned and readable by them and stay shared as before. They cannot edit them until they are promoted again. This is the least surprising outcome, and no data moves.
- **Being shared with.** Owners can still share with viewers and guests by name. The share picker lists them with a role hint ("Guest") so an owner knows the recipient will only read.
- **`all_users` for guests** is enforced in SQL (§5.3), not in the UI.

### 2.3 Why these definitions

- **Guest vs viewer** separates "outsider" from "read-only insider". Without the `all_users` exclusion, a guest would be identical to a viewer, and every "everyone signed in" note would leak to outsiders.
- **Member** is unchanged, so existing installs behave the same after migration.
- **Admin** manages accounts, not content. Quotas stay global (`USER_STORAGE_QUOTA_BYTES`). Per-user quotas are listed as future work, because DEVELOPMENT_PLAN.md:696 marks "admin quota UI" as out of scope.

### 2.4 Platform role × item share role

The effective permission on an item is `min(platform ceiling, item grant)`:

- A viewer or guest on a Collection or Calendar with `share_role=editor` acts as a **viewer of that item**. `requireEditable*` refuses them with `READ_ONLY`, the same code the UI already handles (THREAT_MODEL T57).
- A viewer or guest who is a board reader cannot write cards. The board shows the same "View only" chip as Collections viewers.
- UI copy: the platform role is labelled "Team role: Viewer" and the item role "View only" or "Can edit rows", which is today's copy. Never use a bare "Viewer" for both.

### 2.5 Operator decisions for §2 (recommended default in bold)

- **O1** Guests excluded from `all_users`: **yes**. The alternative is guest = viewer, which would make the role redundant.
- **O2** Viewers read `all_users` content: **yes**.
- **O3** Viewers and guests can restore or purge their own Bin items: **no**. Items then age out after 30 days unless an admin promotes the user. Alternative: allow restore only.
- **O4** Guests can set reminders on events shared with them: **yes** (personal only).
- **O5** Viewers can create feed tokens for calendars they can read: **no**, because a feed token exposes calendar data without a session (T70). Alternative: viewers may create `busy` feeds only.
- **O6** Guests can create read-only MCP keys: **no**.
- **O7** Guests can see the Team list: **no**. Members and viewers see names and roles only, never emails.

---

## 3. Bootstrapping and admin safeguards

### 3.1 Choosing the first admin

| Option | Pros | Cons |
| --- | --- | --- |
| **First registered user becomes admin** (inside the register transaction when `currentCount === 0`, `index.ts:227`) | No configuration. Matches today's "first account is always allowed" rule (`OPERATIONS.md:16`). | Whoever registers first on a freshly exposed instance becomes admin. The same risk already exists today for "first account". |
| `ADMIN_EMAILS` env var | Declarative | A second source of truth next to the DB. Removing an email would not demote the account, and editing it means a redeploy. Env values must stay out of tracked files anyway. |
| CLI only | Explicit | A fresh install has no admin until someone runs `docker compose exec`. |

**Recommendation (D76):** the first registered user becomes admin. Add a **CLI for recovery**, modelled on `server/reset-totp.ts`:

```text
docker compose exec app bun server/team-admin.ts set-role user@example.com admin
docker compose exec app bun server/team-admin.ts unblock user@example.com
docker compose exec app bun server/team-admin.ts list
```

The CLI writes `team_events` rows with `via = 'cli'` and `actor_id = NULL`. It is the documented way out of lockouts: the last admin forgot their password, was removed from `ALLOWED_EMAILS`, or two admins blocked each other.

### 3.2 Always at least one active admin

"Active admin" means `role = 'admin' AND disabled_at IS NULL`. It is enforced at three layers:

1. **Service:** every role change and block runs inside a single `db.transaction` (`bun:sqlite` transactions are synchronous and SQLite serialises writers) that counts active admins, excluding the target, and refuses with 409 `LAST_ADMIN`.
2. **Database trigger** in migration 015 as a second guard, so that no future code path, including the CLI, can leave zero active admins:

   ```sql
   CREATE TRIGGER users_keep_one_admin BEFORE UPDATE OF role, disabled_at ON users
   WHEN OLD.role = 'admin' AND OLD.disabled_at IS NULL
     AND (NEW.role <> 'admin' OR NEW.disabled_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND role = 'admin' AND disabled_at IS NULL)
   BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;
   ```

   A matching `BEFORE DELETE` trigger is included too. User deletion does not exist today, but tests delete rows.

3. **UI:** actions that would break the rule are disabled, with the reason shown ("Nook needs at least one admin").

Caveat: `ALLOWED_EMAILS` is environment state, and the database cannot see it. If the only admin's email is removed from the allowlist, the instance has an admin who cannot sign in. The Team list shows a warning badge on admins whose email is not allowed (the server computes `isEmailAllowed`, and the boolean goes to admins only). The CLI is the recovery path.

### 3.3 Migration for existing installs

- Every existing user becomes `member`. This is today's behaviour, so nothing is lost.
- The **oldest enabled user** (`ORDER BY created_at, id LIMIT 1`) becomes `admin`. On every real install this is the account that bootstrapped it. A `team_events` row records it with `via = 'migration'`.
- Users already disabled (possible only through manual SQL) stay disabled with `blocked_by = NULL`. The UI shows them as "Blocked (before Team)".
- An empty database gets no admin; the first registration becomes admin (D76).
- Release notes must say: "The oldest account is now the admin. Change it with the CLI if that is wrong." This is operator decision **O8**.

---

## 4. Blocking

### 4.1 Semantics (D77)

`POST /api/team/:userId/block` with `{ reason?: string ≤ 200 }` runs one transaction:

1. `UPDATE users SET disabled_at = now, blocked_by = :actor, block_reason = :reason WHERE id = :target AND disabled_at IS NULL`, then check that exactly one row changed. The last-admin trigger guards this step.
2. `DELETE FROM sessions WHERE user_id = :target`. The user is signed out everywhere at once, and the cookie gets 401 on the next request. Deleting the rows (rather than relying on the JOIN) means an unblock does **not** revive old sessions.
3. `revokeUserPushSubscriptions(target, "user_blocked")` (`calendar/push.ts:327`) deletes their devices' subscriptions now instead of on the next send.
4. `team_events` row `block` and `audit_log` event `team.user_blocked` (ids only, T21).

Effects that follow from the existing JOINs, with no new code:

- **MCP keys:** refused at `mcp.ts:121` and `mcpTools.ts:37`. The key rows stay (**O9**, default: keep them, so unblocking restores them; the Team detail shows "3 MCP keys paused"). The stricter alternative is to revoke them on block.
- **Feeds:** a uniform 404 (`feeds.ts:156`). Token rows stay and resume on unblock.
- **Pickers and assignees:** the user drops out of share pickers and assignee lists. Existing share rows **to** them are kept and apply again on unblock.
- **Content they own stays** where it is and stays visible to its recipients (**O10**, default: keep). The data belongs to the team, and blocking is about access. The alternative, hiding a blocked owner's shared items, would need an owner-enabled check in every predicate from §1.5.

Login refusal: in `POST /api/auth/login` (`index.ts:247-277`), look the user up **without** the `disabled_at IS NULL` filter. After the password verifies, and before TOTP so no codes are consumed, a blocked user gets 403 `{ code: "ACCOUNT_BLOCKED", error: "This account has been blocked. Contact your Nook administrator." }`. A wrong password still gets the generic 401, so the block status is revealed only to someone who knows the password (T85). Do not show `block_reason` to the blocked user by default (**O11**).

In-flight work: an upload that authenticated before the block must fail at commit. Add a user-active check inside the upload transaction (`documents.ts:285`: `SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL`, otherwise throw 401 and remove the staged object). Other requests are short JSON calls; at most one in-flight request may complete after the block, which is accepted (T80). The reminders dispatcher skips disabled users (a `JOIN users … disabled_at IS NULL` in its due query).

### 4.2 Unblock

`POST /api/team/:userId/unblock` sets `disabled_at = NULL, blocked_by = NULL, block_reason = NULL` (checking that exactly one row changed) and writes a `team_events` `unblock` row. The user signs in again with their existing password and TOTP. Keys and feeds work again (under O9 and O10). Push must be re-enabled on each device (the subscriptions were deleted). Their role is unchanged.

### 4.3 Block vs delete

| | Block | Delete (not proposed) |
| --- | --- | --- |
| Reversible | Yes | No |
| Content | Kept, still owned, still shared | Would need an ownership transfer or a cascade. `users` FKs are `ON DELETE CASCADE` on folders, notes, documents, boards, and more (migration 001 onward), so a naive delete destroys shared data. |
| Scope | This proposal | Out of scope. DEVELOPMENT_PLAN.md:696 already excludes "user deletion flows". Revisit with a transfer-ownership design. |

### 4.4 Protections

- **Self:** an admin cannot block themselves (409 `SELF_ACTION`). An admin may demote themselves only if another active admin exists (`LAST_ADMIN`).
- **Admin targets:** blocking another admin is allowed only for admins (it is audited). Block and demote both require re-authentication when the target is an admin (§5.5).
- **Idempotent:** blocking a user who is already blocked returns 409 `ALREADY_BLOCKED`; unblocking an active user returns 409 `NOT_BLOCKED`.

---

## 5. Enforcement design

### 5.1 Module layout

A new `server/team/` directory, following the `server/tasks/` and `server/collections/` pattern:

- `server/team/roles.ts`: **pure**. `ROLES`, `type Role`, `can(role, capability)`, `mcpScopesForRole(role)`, `ROLE_READ_ONLY_ALLOWED_WRITES`, and the SQL fragment `AUDIENCE_ALL_USERS`. It is shared with the client the way `mcpScopes.ts` is mirrored in `src/mcpPermissions.ts`.
- `server/team/service.ts`: `listTeam`, `teamMember`, `setRole`, `blockUser`, `unblockUser`, `revokeSessions`, and `teamEvents`. Every write runs in one transaction with a CAS.
- `server/team/routes.ts`: `registerTeamRoutes(app)`.
- `server/team/mcpTools.ts`: the `team:read` tools.
- `server/team-admin.ts`: the CLI (§3.1).

`can()` capabilities are coarse and role-only. Item-level checks stay in each module's `access.ts`:

```ts
type Capability =
  | "content.write"      // anything that creates or changes owned or shared content
  | "sharing.write" | "files.upload" | "feeds.create"
  | "mcp.key.create" | "team.read" | "team.manage";
```

### 5.2 Hono hooks

1. `requireAuth` (`auth.ts:55-72`): add `u.role` to the existing SELECT and to `AppEnv.Variables.user` (`auth.ts:8-14`). There is no extra query. The block check stays the existing `u.disabled_at IS NULL`. **Recommendation: no cache.** The JOIN is already paid on every request, and a cache would delay revocation (T80).
2. **Role write gate:** a new middleware registered right after `requireMutationSafety` and the TOTP gate (`index.ts:296-312`):

   ```ts
   app.use("/api/*", (c, next) => {
     const role = c.get("user")?.role;
     if (!role || can(role, "content.write") || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
     if (isAllowedReadOnlyWrite(c.req.method, c.req.path)) return next();   // D75 allowlist, exact patterns
     return c.json({ error: "Your team role is read-only", code: "ROLE_READ_ONLY" }, 403);
   });
   ```

   Allowlist, with exact method and path patterns: `POST /api/auth/logout`, `POST /api/auth/totp/{setup,enable,recovery-codes,recovery-codes/regenerate}`, `DELETE /api/auth/totp`, `POST /api/notifications/read`, `POST|DELETE /api/push/subscriptions`, `POST /api/push/test`, `POST /api/reminders`, `DELETE /api/reminders/:id`, `POST /api/collections/:id/query`, `DELETE /api/mcp/keys/:id`, and `POST /api/mcp/keys` (the handler then limits scopes by role). A test lists every `app.post|put|patch|delete` route (there are 80 today, from a grep of `server/`) and asserts each one is either gated or on the allowlist (T87).
3. **Team routes** are wrapped in `requireCapability("team.manage")`, or `team.read` for the list. A guest gets **404**, following the house rule of "404, never 403 for existence".
4. **Services called outside `/api`:** MCP. `loadLiveKey` (`mcpTools.ts:35-44`) and `handleMcpRequest` (`mcp.ts:118-142`) also select `u.role` and compute `effectiveScopes = storedScopes ∩ mcpScopesForRole(role)`. `registerMcpTools` then registers only the effective tools, and `runTool` re-checks against them. This makes a demoted admin's `team:read` key, or a demoted member's `tasks:write` key, lose those tools on the very next call without touching the key row (T81).

### 5.3 `all_users` for guests (the one predicate change)

A single exported fragment in `server/team/roles.ts`:

```ts
/** True when $userId may be part of an `all_users` audience (D72: every role except guest). */
export const AUDIENCE_ALL_USERS = `(SELECT u_aud.role FROM users u_aud WHERE u_aud.id = $userId) <> 'guest'`;
```

Every `x.visibility = 'all_users'` becomes `(x.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})` at:

- `server/access.ts:11, 16, 41`
- `server/documentAccess.ts:34, 62, 67` and the remaining site
- `server/tasks/access.ts:25`, `server/collections/access.ts:31`, `server/calendar/access.ts:59`
- the inline copies at `server/index.ts:540, 554, 558`, `server/mcpTools.ts:81, 85`, and `server/searchRoutes.ts:59`
- `server/today/providers.ts`
- `listBoardReaders` (`tasks/service.ts:376`): an `all_users` board lists only non-guests

It is a primary-key lookup, and SQLite evaluates the uncorrelated scalar subquery once per statement. A **guard test** greps `server/**/*.ts` (excluding migrations and type unions) for `visibility = 'all_users'` not followed by `AUDIENCE_ALL_USERS`, and fails on any hit, so a new module cannot forget it. The Wave 7 share matrix (`tests/api.test.ts`, the Files and notes parity tests) gains a guest column. A good follow-up while doing this: fold the inline note predicates in `index.ts:537-561` and `mcpTools.ts:74-91` into `readableNotePredicate`, which DEVELOPMENT_PLAN already notes as outstanding.

### 5.4 Existing access modules

Add no role logic to `documentAccess.ts`, `tasks/access.ts`, `collections/access.ts`, or `calendar/access.ts` beyond §5.3. Write refusals come from the gate (§5.2) for HTTP and from scope filtering (§5.2.4) for MCP. As defence in depth for MCP write services, `requireEditableCollection` (`collections/service.ts:79`) and its calendar and task equivalents also check `can(role, "content.write")`. They read the role from a small `userRole(userId)` helper, so an MCP write by a viewer fails even if a scope bug slipped through.

### 5.5 Team writes: CAS and re-authentication

- `PUT /api/team/:userId/role` takes `{ role, expectedRole }` and runs `UPDATE users SET role = ? WHERE id = ? AND role = ?`. If no row changed, it returns 409 `ROLE_CHANGED` with `currentRole`. This removes the lost-update race when two admins act at once (T79).
- Promoting to admin, demoting an admin, and blocking an admin require `password` plus `totpCode` or `recoveryCode` when TOTP is enabled, verified with the same helpers as MCP key creation (`index.ts:319-332`). Other Team writes rely on the session plus CSRF, since the global `requireMutationSafety` already covers `/api/team/*` (T82).
- Rate limit: 30 Team writes a minute per admin, using the `rateLimited` pattern at `index.ts:200-213`.

### 5.6 Migration `015_team_roles`

New file `server/migrations/015_team_roles.ts`. Migrations 001–014 are untouched. Register it in `server/migrations/index.ts:97` and update the assertion at `tests/searchIndex.test.ts:142` to `[1..15]`.

```sql
-- via addColumn() (migrations/types.ts:9-12)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('admin','member','viewer','guest'));
ALTER TABLE users ADD COLUMN blocked_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN block_reason TEXT CHECK (block_reason IS NULL OR length(block_reason) <= 200);
-- disabled_at (001) is the block timestamp (D74).

CREATE INDEX idx_users_role_active ON users(role) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);   -- block deletes by user

CREATE TABLE team_events (
  id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,          -- NULL for cli/migration/bootstrap
  via TEXT NOT NULL CHECK (via IN ('web','cli','migration','bootstrap','mcp')),
  action TEXT NOT NULL CHECK (action IN ('role_change','block','unblock','sessions_revoked','bootstrap_admin')),
  from_role TEXT, to_role TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_team_events_target ON team_events(target_user_id, created_at DESC);
CREATE INDEX idx_team_events_created ON team_events(created_at DESC);

-- append-only (T83)
CREATE TRIGGER team_events_no_update BEFORE UPDATE ON team_events BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER team_events_no_delete BEFORE DELETE ON team_events
  WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.target_user_id) BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

-- last admin (§3.2): users_keep_one_admin (UPDATE) and users_keep_one_admin_delete (DELETE)

-- backfill (§3.3)
UPDATE users SET role = 'admin'
  WHERE id = (SELECT id FROM users WHERE disabled_at IS NULL ORDER BY created_at, id LIMIT 1);
INSERT INTO team_events (id, target_user_id, actor_id, via, action, from_role, to_role, created_at)
  SELECT <uuid>, id, NULL, 'migration', 'bootstrap_admin', 'member', 'admin', <now> FROM users WHERE role = 'admin';
```

Notes:

- `ADD COLUMN … REFERENCES` is legal in SQLite when the default is NULL.
- The `team_events` delete trigger still lets the `ON DELETE CASCADE` from `users` run (a user row deleted in tests), because by then the target no longer exists.
- UUIDs are generated in TypeScript, not SQL.
- `UserRow` (`db.ts:24-35`) gains `role`, `blocked_by`, and `block_reason`.
- Test the migration against a v0.7.0-shaped database, as `tests/calendarMigration.test.ts` does: zero, one, and three users, and one pre-disabled user.

`team:read` needs no migration. Scopes are a JSON column (010), and unknown values are dropped (`mcpScopes.ts:42-51`).

---

## 6. Team UI

### 6.1 Routes (`src/router.ts`)

| URL | Route | Notes |
| --- | --- | --- |
| `/team` | `{ app: "team"; userId: null }` | The list. Filter chips (All, Admins, Members, Viewers, Guests, Blocked) live in component state, with the chip as a history hint like the Files panel hint (DEVELOPMENT_PLAN D21), never in the URL. |
| `/team/:userId` | `{ app: "team"; userId }` | Detail. Uses `isRouteId`, lower-cased. A malformed id opens the list, matching `parseTasks` (`router.ts:32-38`). |

Also:

- `AppSection` (`src/appShellNavigation.ts:3`) gains `"team"`, and the `readAppHistorySection` whitelist (line 27) gains it too.
- `formatRoute` and `parseRoute` get the new cases, with `tests/router.test.ts` rows.
- `App.tsx` gets one render branch next to `BinApp` (`App.tsx:1503-1509`).
- `TODAY_APPS`' `section` type (`src/today/todayApps.ts:4`) excludes `"team"`.

### 6.2 Placement: recommend the utility row, like the Bin

| Option | Verdict |
| --- | --- |
| Today launcher card (`TODAY_APPS`) | No. D50 keeps the launcher for daily workspace apps, and the Bin was moved out of it for the same reason. Team is occasional. |
| **Utility row (`AccountActions`, `src/AppShell.tsx:16-25`)**, as a "Team" button (`Users` icon) next to Settings and Bin | **Recommended (D78).** It already appears on Today and in every app header and is 44 px ready. It shows for admin, member, and viewer and is hidden for guests. Admins see a count badge of blocked users (0 hides it), loaded lazily like `useBinCount` (`AppShell.tsx:31-40`). |
| Inside Settings | Also add a "Manage team" link in the Settings dialog for admins (`App.tsx:397`), because operators look there. It navigates to `/team` after closing the dialog. |

**Settings → Modules (D92).** Team is one row in the per-user Modules list (Notes, Files, Tasks, Collections, Calendar, Search, Bin, **Team**), on by default.

- Turning it off hides the Team button in the utility row and redirects `/team` to `/` with the D92 hint. The server keeps answering `/api/team` by role regardless of the toggle, because D52 says a hidden module is not a security boundary.
- **Admins:** the Settings "Manage team" link stays visible even when Team is hidden, so an admin cannot lose the only way to manage accounts. The Modules row shows the note "You are an admin: Team stays available from Settings".
- **Guests:** Team is not listed in their Modules list, since they have no access to it.
- **Read-only roles:** a module a role cannot use at all (none today; guests keep read access everywhere) would be hidden from Modules. It would not appear as a disabled toggle.
- **Admins forcing modules on or off for others: not in v1 (D82).** That would turn a personal preference into an entitlement system that overlaps with roles and contradicts D52's "UI preference, not a security boundary". Roles are the enforcement mechanism. If the operator wants workspace-wide module policy later, design it as a server-enforced capability per role, not as a pushed preference.

**Custom Select (D91).** The role picker in the Team detail is the shared custom `src/ui/Select` (a sheet at 390 px, a popover on desktop, keyboard and touch), never a native `<select>`. Each option shows the role name and its one-line description. The Team list's role and status filter uses the same component or chips. The Team button, the Select sheet, and the confirmation dialogs all go through the history dialog guard.

### 6.3 Layout (390 px first)

- **List:** one card per user: an initial avatar, display name, a "You" tag, a role chip, and a status chip (Blocked, "Not on allowlist" for admins only). Cards are sorted by status, then role, then name. There is a search box (client-side filter; the server returns at most 500 users). Every target is at least 44 px. Admins also see email and last seen as secondary text. Members and viewers see name and role only.
- **Detail** (`/team/:userId`):
  - A header with name, email (admins only), and status.
  - A **Role** custom Select (D91) with four options, each with a one-line description taken from the matrix.
  - "Sign out everywhere", "Block user" (destructive), or "Unblock".
  - An **Activity** list: the last 50 `team_events` for the user ("Role changed from Member to Viewer by <admin>, 2 days ago").
  - Metadata: created, last seen (`MAX(sessions.last_seen_at)`), TOTP on or off, paused or live MCP key count, and storage used (reusing the quota sum).
  - Non-admins see only name, role, and "Member since".
- **Desktop (>760 px):** two panes, list on the left and detail on the right. The same URLs apply.
- **Dialogs** (block confirmation with an optional reason, role change confirmation, re-authentication for admin-affecting changes) register through `registerHistoryDialogGuard` (`src/historyDialogs.ts:30-37`) and get the depth-0 sentinel on phones. Back closes the dialog first, then detail → list → Today, and never leaves Nook before Today at depth 0 (DEVELOPMENT_PLAN rule, line 24).
- **Role-aware chrome elsewhere (Wave B):** `/api/auth/me` returns `role` (`index.ts:280-286`), and apps hide create, upload, share, and edit controls for viewers and guests. They show a "Read-only access" banner with "Ask an admin for Member access". The server remains the enforcement point.
- **Blocked sign-in:** the login form shows the `ACCOUNT_BLOCKED` message instead of "Invalid email or password".

### 6.4 HTTP API (`/api/team`, JSON)

| Method and path | Who | Body / response |
| --- | --- | --- |
| `GET /api/team` | admin, member, viewer | `{ me: {id, role}, users: TeamMember[] }` with at most 500 users. Admin-only fields are left out for others. |
| `GET /api/team/:userId` | same | `TeamMember` plus `events` (admins only) |
| `PUT /api/team/:userId/role` | admin | `{ role, expectedRole, password?, totpCode?, recoveryCode? }`. Errors: 409 `ROLE_CHANGED`, `LAST_ADMIN`, `SELF_ACTION`; 401 `REAUTH_REQUIRED` |
| `POST /api/team/:userId/block` | admin | `{ reason?, password?, totpCode? }` (re-auth only when the target is an admin). Error: 409 `ALREADY_BLOCKED` |
| `POST /api/team/:userId/unblock` | admin | Error: 409 `NOT_BLOCKED` |
| `POST /api/team/:userId/sessions/revoke` | admin | Signs the user out everywhere without blocking them |

`TeamMember` = `{ id, displayName, role, status: "active" | "blocked", createdAt, isYou }`. Admins also get `email, lastSeenAt, blockedAt, blockedBy, blockReason, totpEnabled, mcpKeys: {live}, storageBytes, emailAllowed`. Add the contract to API_CONTRACTS.md in the same commits (WAVES_7-9 §7 item 4).

---

## 7. MCP coverage

Following the operator rule (DEVELOPMENT_PLAN line 26) and the Wave 8 conventions:

- **New scope `team:read`** in `MCP_SCOPES` (`server/mcpScopes.ts:9-12`) and `src/mcpPermissions.ts`, with the label "Read team: names, roles, and status of accounts". It is **offered in Settings only to admins**. `POST /api/mcp/keys` refuses it for other roles with 403 `SCOPE_NOT_ALLOWED`, and `mcpScopesForRole` removes it at request time if the holder is later demoted (§5.2.4).
- **Tools** (registered only when the effective scopes include `team:read`, and re-checked in `runTool`):
  - `list_team_members({ role?, status? })` returns `[{ id, displayName, role, status, createdAt, lastSeenAt }]`.
  - `get_team_member({ userId })` returns the same plus `blockedAt` and the last 20 `team_events` (action, roles, date, actor display name). **No emails** by default (**O12**), because MCP output goes to an external AI client (T21, T35).
- **Limits:** the usual `call` bucket (120 a minute per key, `mcpRateLimit.ts:18`). No new daily bucket.
- **Write tools: recommend none (D79).** Keep `team:write` reserved and unimplemented. Reasons:
  - Role and block changes are rare and high-impact, and a single prompt-injected instruction ("block every admin") would be disastrous (T35).
  - The web flow requires re-authentication for admin-affecting changes, and an MCP key cannot re-authenticate.
  - The existing MCP rule is "create and update only, reversible". A block is reversible, but its side effects (deleted sessions and push subscriptions) are not.

  If the operator wants it anyway (**O13**), use `team:write` with `set_member_role` (never to or from admin, never self), `block_member` and `unblock_member` (never admins, never self), a daily cap of 20 per user, audit `{via: "mcp", keyId}`, and `team_events.via = 'mcp'`.
- **Role filter for all other scopes:** viewers keep read scopes only, and guests get none (§2.2). This lives in `mcpScopesForRole` and is tested in `tests/mcpScopes.test.ts`.

---

## 8. Invitations and registration

Today there are two levers: `ALLOW_REGISTRATION` (all or nothing) and `ALLOWED_EMAILS` (the allowlist). Both are env values, which is right for infrastructure policy but awkward for an admin.

- **Default role for new sign-ups (D80): `guest`**, configurable via a new env `SIGNUP_ROLE` (`guest | viewer | member`, never `admin`, validated in `config.ts` like `TOTP_POLICY`). A new account then sees nothing until an admin promotes it or someone shares with it by name. The first user is always admin (D76). Admins see new guests at the top of the Team list with a "New" tag for 7 days. This is operator decision **O14**. A member default would keep pre-Team behaviour for installs that leave registration open.
- **`ALLOW_REGISTRATION` stays authoritative.** Do not add a DB switch that fights the env var. An admin's in-app control is invites.
- **Invites (Wave C, optional, D81):** `team_invites(id, token_hash UNIQUE, token_prefix, email NULL COLLATE NOCASE, role CHECK IN ('member','viewer','guest'), created_by, created_at, expires_at ≤ 7 days, used_at, used_by, revoked_at)`.
  - An admin creates a link shown once (`/register?invite=<token>`, 256-bit, stored as a SHA-256 hash, the same pattern as feeds in T64).
  - Registering with a valid unused invite works even when `ALLOW_REGISTRATION=false`, but **still** honours `ALLOWED_EMAILS` (**O15**, default: honour it) and the invite's email if one is set.
  - The invite fixes the role. Admin invites are not supported: promote after sign-up with re-authentication.
  - Limits: 20 live invites, 10 creations an hour per admin, single use, revocable, and audited without the token.
- **Build invites later.** Wave A and B deliver the three stated requirements. Invites are a convenience, since the current workaround (toggle `ALLOW_REGISTRATION` briefly) exists and is documented.

---

## 9. Threat model additions (append to THREAT_MODEL.md as "Team (waves Team A–C)")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T77 | **Privilege escalation:** self-promotion, mass-assigning `role` through another route, a member calling Team routes | Only `/api/team/:id/role` writes `role`. The zod enum is strict and no other schema accepts `role`. `team.manage` capability. Re-authentication to grant or remove admin. Tests: member or viewer on every Team route (403), guest (404), and `role` in register or login bodies ignored. | Required |
| T78 | **Admin lockout:** the last admin is demoted, blocked, or (later) deleted | Service count inside the transaction, plus the `users_keep_one_admin` UPDATE and DELETE triggers (`LAST_ADMIN`), a UI guard, and the CLI (`server/team-admin.ts`) for recovery. A warning when an admin's email is not on `ALLOWED_EMAILS`. | Required |
| T79 | **Role-change races:** two admins acting at once; a request authenticated just before a demotion | CAS on `expectedRole` (`ROLE_CHANGED`) and single-statement guarded UPDATEs. The role is read fresh per request, not cached. Accepted: one in-flight request that passed `requireAuth` before the change may finish. | Required (race window accepted) |
| T80 | **A blocked user keeps access** through a live session, an in-flight upload, the service worker, or push | Sessions deleted in the block transaction. `requireAuth` JOIN on `disabled_at`. Upload commit re-checks the user inside its transaction (`documents.ts:285`). Push subscriptions deleted at once. No WebSocket or SSE exists. The service worker's notification fetch then gets 401. The reminders dispatcher skips disabled users. | Required |
| T81 | **An MCP key outlives a demotion or block** (for example, an ex-admin's `team:read` or an ex-member's `tasks:write`) | Effective scopes = stored ∩ `mcpScopesForRole(role)`, computed in `handleMcpRequest` and `loadLiveKey` on every request and tool call. Blocked users are refused by the existing JOIN. Tests: demote, then the next call gets `SCOPE_REQUIRED` and the tool is hidden in `tools/list`. | Required |
| T82 | **CSRF or clickjacking on role and block changes** | `/api/team/*` sits under `requireMutationSafety` (Origin, JSON, `X-CSRF-Token`), with SameSite=Strict, `frame-ancestors 'none'`, and re-authentication for admin-affecting changes. Tests: missing token, wrong Origin, and form-encoded bodies refused. | Required |
| T83 | **Audit tampering or loss** | `team_events` is append-only through triggers, with no API to edit or delete it. `audit_log` mirrors each event (ids only). Accepted: someone with host or DB file access can still rewrite SQLite. This is the same trust boundary as backups (T18). | Required (host access accepted) |
| T84 | **A guest reaches `all_users` content** through a predicate that was missed | The single `AUDIENCE_ALL_USERS` fragment, a grep guard test over `server/**` for bare `visibility = 'all_users'`, and a guest column in every share-matrix and parity test (notes, files, tasks, collections, calendar, search, Today, MCP). | Required |
| T85 | **Account enumeration or PII disclosure** through Team or login | Guests get 404 on `/api/team`. Non-admins see only name and role. Emails and metadata go to admins only. MCP returns no emails. `ACCOUNT_BLOCKED` is only revealed after a correct password, the login rate limit still applies, and `block_reason` is not shown to the blocked user. | Required |
| T86 | **Admin abuse or overreach:** reading private content, silent changes | Admins get no content access (D73) and cannot impersonate. Every change is visible to all admins in Activity, and the target sees their own role in Settings. Accepted: an admin can block or demote other admins (re-authenticated and audited). | Accepted (documented) |
| T87 | **A viewer or guest writes through an unguarded route** (a new module, a POST that should be a read) | Default-deny write gate with an exact allowlist (D75). A route-enumeration test fails CI if a mutating route is neither gated nor allowlisted. Service-level `can()` checks in the MCP write paths. | Required |
| T88 | **A blocked user's tokens resume unexpectedly on unblock** (MCP keys, feeds) | Documented behaviour (O9, O10). The Team detail lists paused keys and feeds before unblocking, and an admin can revoke them. The stricter option (revoke on block) is a one-line change. | Accepted (documented) |

---

## 10. Waves, tests, and open questions

The Team module touches shared chokepoints (`auth.ts`, the predicates, `mcp.ts`), so it should run **after** the in-flight work merges, not in parallel with a wave that edits those files. **Migration id:** `015` is the next free id today, but queued Wave 13 (Task card UX: WIP limits, due times, multiple assignees, card relations, and the D52 Modules preference stored server side) will very likely need a migration too. Whichever wave merges first takes `015`, and the other renumbers before merging (ids are assigned at merge, and released ids are never edited). **Wave numbers:** "Wave 13" is already taken by Task card UX in TODO.md, so these are called Team A, B, and C until the director assigns numbers. Each wave ships backend and UI together (per the "runnable product each stage" rule) and can be released on its own.

### Team A: Team, admin, block (v0.8.0 or the next minor, size M, 2–3 sessions)

1. Migration `015_team_roles` (the full schema including `team_events` and the triggers, even though viewer and guest are not yet selectable), the `UserRow` update, `server/team/roles.ts`, and the migration tests.
2. `requireAuth` carries `role`. First registrant becomes admin (D76). `server/team-admin.ts` CLI. OPERATIONS.md section.
3. `/api/team` routes: list, detail, role (admin and member only in this wave), block and unblock, revoke sessions, re-authentication, login `ACCOUNT_BLOCKED`, upload commit re-check, dispatcher skip.
4. UI: `/team` and `/team/:userId` routes, the utility-row button, the Settings link, list and detail, dialogs with the history guard, the blocked-login message, and 390 px QA.
5. MCP: the `team:read` scope (admin-only), the two tools, and `mcpScopesForRole` (admin vs everyone else).
6. Docs: API_CONTRACTS, THREAT_MODEL (T77–T83, T85, T86, T88), TEST_PLAN, USING, ARCHITECTURE.

The operator can then see the Team list, promote a second admin, and block and unblock an account.

### Team B: viewer and guest enforcement (v0.8.1 or v0.9.0, size M/L, 3 sessions)

1. `AUDIENCE_ALL_USERS` across every site in §5.3, the guard test, and a guest column in the share matrices. Fold the inline note predicates into `readableNotePredicate`.
2. The default-deny write gate plus allowlist, the route-enumeration test, the `min()` cap for share roles, and service-level `can()` checks in the MCP write paths.
3. MCP role filter for viewer (read only) and guest (none). Key creation scope rules. Settings scope list by role.
4. `SIGNUP_ROLE` (default guest), `/api/auth/me` role, and role-aware chrome in Notes, Files, Tasks, Collections, and Calendar (hidden controls, read-only banner). Role hints in share pickers.
5. Enable the Viewer and Guest options in the Team role Select. Delegated QA with four users (one per role) on desktop and at 390 px.

The operator can then assign all four roles and check that each behaves as the matrix says.

### Team C (optional): invites (v0.9.x, size S/M, 1–2 sessions)

`team_invites` (the migration id after Team A's), invite links in Team (create, copy once, revoke, list), the register path, rate limits, T-rows for invite token leakage, and an MCP `list_invites` tool under `team:read` (no create).

### Test plan rows (add to TEST_PLAN.md)

| Area | Test |
| --- | --- |
| Migration | v0.7.0-shaped DB with 0, 1, and 3 users plus 1 pre-disabled user: roles backfilled, oldest enabled user is admin, one `bootstrap_admin` event, assertion `[1..15]` |
| Bootstrap | First register → admin, second (with `ALLOW_REGISTRATION`) → `SIGNUP_ROLE`. Concurrent first registrations: one admin. |
| Last admin | Demoting, blocking, or deleting the only active admin → `LAST_ADMIN` (service **and** direct SQL hits the trigger). Two admins: one may demote self. |
| CAS | Stale `expectedRole` → 409 `ROLE_CHANGED` with `currentRole` |
| Re-auth | Promote or demote admin without a password or with a wrong TOTP → 401 `REAUTH_REQUIRED`. Recovery code accepted. |
| Block | Sessions deleted (next request 401), push subscriptions deleted, MCP call → 401, feed → 404, login with the right password → 403 `ACCOUNT_BLOCKED`, wrong password → generic 401, pickers exclude the user, owned shared content still readable by recipients (O10) |
| Upload race | Block during a streaming upload → commit refused, staged object removed, quota unchanged |
| Unblock | Old sessions stay dead, sign-in works, keys and feeds resume (O9), role unchanged |
| Authorization | member or viewer → 403 on every Team write, guest → 404 on every Team route, no email for non-admins |
| Guest ACL | Guest cannot read `all_users` notes, folders, files, boards, collections, calendars, search results, Today items, or MCP results, but can read `selected` shares. Guard grep test. |
| Write gate | Every mutating route (enumerated) is 403 `ROLE_READ_ONLY` for viewer and guest except the allowlist. Viewer on an editor collection gets `READ_ONLY`. Board reader viewer cannot create a card. |
| MCP | `team:read` refused at key creation for a non-admin. Admin demoted → the next `tools/list` hides the Team tools and a direct call gets `SCOPE_REQUIRED`. Viewer key keeps only read tools. Guest cannot create keys. |
| Audit | `team_events` UPDATE and DELETE abort. Every Team write adds exactly one event and one `audit_log` row with no reason text or email in `metadata_json`. |
| UI and history | `/team` → `/team/:id` → block dialog. Back closes the dialog, then returns to the list, then to Today. Forward reopens detail. Depth-0 deep link to `/team/:id` on a phone: Back from the dialog stays in Nook. 44 px targets at 390 px. |
| Router | `parseRoute("/team")`, `/team/<UUID uppercase>`, `/team/garbage` → list, round-trip `formatRoute` |

### Open questions for the operator

Defaults apply unless overridden.

- O1–O7 (§2.5): role details. The defaults: guests excluded from `all_users`, viewers read `all_users`, no Bin actions for read-only roles, guest reminders allowed, no feeds or MCP keys for guests, no feeds for viewers, Team list hidden from guests.
- **O8** Oldest enabled account becomes admin on upgrade: **yes**. The CLI fixes it if that is wrong.
- **O9** MCP keys and feeds on block: **pause (kept, inert)**, resuming on unblock. The alternative is revoke.
- **O10** A blocked user's shared content stays visible to its recipients: **yes**.
- **O11** Show `block_reason` to the blocked user at login: **no**.
- **O12** Emails in MCP Team output: **no**.
- **O13** MCP Team write tools: **none**.
- **O14** Default sign-up role: **guest** (`SIGNUP_ROLE`).
- **O15** Invites still honour `ALLOWED_EMAILS`: **yes**. Build invites at all: **later (Team C)**.
- **O16** Per-user storage quotas set by admins: **out of scope for now**. `USER_STORAGE_QUOTA_BYTES` stays global, and Team only *shows* usage.
- **O17** Account deletion or ownership transfer: **out of scope**. Block covers the requirement (DEVELOPMENT_PLAN.md:696).
- **O18** Version and wave numbering: Team A ships as **the next minor after Wave 13** (wave numbers 14A–C if the director keeps the numeric scheme). Team B is a patch release if small, otherwise the following minor.
- **O19** Admins force modules on or off for other users (D92 Modules): **not in v1** (D82). Admins keep a Settings path to Team even with the module hidden.

---

## 11. Director review (2026-09-26)

Accepted as the plan of record with these rulings. Implementers follow this section where it differs from the text above.

- **All O1–O19 defaults are accepted** as written (guests excluded from `all_users`; no Bin actions, feeds, or MCP keys for read-only roles; oldest enabled account becomes admin on upgrade; keys and feeds pause on block; blocked owners' shared content stays visible; no emails and no write tools in MCP; sign-up default `guest`; invites later; quotas and deletion out of scope; admins cannot force modules for others).
- **Wave numbers:** Team A = **Wave 14**, Team B = **Wave 15**, Team C = **Wave 16** (unscheduled). Wave 14 ships as the minor after Wave 13 unless it is ready first, in which case it takes the next minor and Wave 13 follows.
- **Migration ids are assigned now, not at merge**, so parallel worktrees never collide: Wave 13 tasks schema = `015`, Wave 13 user preferences (Modules toggle) = `016`, Wave 14 `team_roles` = **`017`**, Wave 16 invites = `018`. `registeredMigrationIds` must accept gaps during development; the sequence is contiguous by release time because 015 and 016 merge before or with 017.
- **Parallelism:** Wave 14 runs in its own worktree **alongside** Wave 13, contrary to §10's "after". The shared touch points are known and small: `src/App.tsx` (Settings link, Modules row), `src/router.ts` (routes), `server/mcpScopes.ts` + `src/mcpPermissions.ts` (new scope), `server/migrations` (distinct ids). The merge agent resolves them; Wave 14 does not touch `server/tasks/**`, `src/tasks/**`, `src/calendar/**`, `src/collections/**`, and Wave 13 does not touch `server/auth.ts`, `server/team/**`, `src/team/**`.
- **Utility-row placement** (next to Bin) and the Settings "Manage team" link are approved. Team is a row in Settings → Modules for admins, members, and viewers; guests never see Team.
- **Role picker** and every other dropdown in Team use the shared custom Select (D91). If the Wave 13 shared component has not merged yet when Wave 14 needs it, Wave 14 builds `src/ui/Select.tsx` with the API described in `docs/plan/WAVE_13_TASK_CARD_UX.md` and the merge agent de-duplicates.
- **Block also revokes the target's active upload slots and idempotency reservations** if such state exists in `server/documents.ts`, in the same transaction, so a staged upload cannot commit after a block (tightens T80).
- **CLI name:** `server/team-admin.ts`, documented in `docs/OPERATIONS.md` with the `docker compose exec mynotes …` form (the Compose service is `mynotes`).
- **Release notes** for Wave 14 must state the oldest-account-becomes-admin rule and the CLI fix, per O8.
- **(2026-09-27, operator decision.)** The password + second-factor re-check for role changes and blocks (§5.5, T77/T82) is **removed**: a signed-in admin confirms in a dialog and the write relies on session + CSRF + SameSite + admin capability + CAS + audit. Operator wording: "remove the Team password re-check, not required, creates friction in product use."
