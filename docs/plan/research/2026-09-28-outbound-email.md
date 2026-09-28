# Outbound email across modules — research and plan

**Date:** 2026-09-28 · **Status:** research + plan, nothing built · **Author:** research agent for the director

**Operator request (TODO.md, verbatim):** "any email that should go out from different modules, workflows, actions, drive and develop. email should look good, modern, and fit the overall product ui. include backlink to the contextual place in webapp as needed."

**Numbering.** Migration **026** (023 whiteboard, 024 vault, 025 access management). Threat rows **T220–T239** (T200–T219 go to the access-management plan). Decisions here are local ids **D231–D260**; the director assigns D numbers at merge.

**What exists today (read for this plan):**

- `server/mail.ts` (D93). A `sendMail(message, {purpose, senderId})` wrapper over `resend@6.30.0`. It never throws and returns `sent | not_configured | rate_limited | failed`. Limits are in memory: 20/h per sender, 5/h per recipient, 200/day per instance, with a 10 s timeout. Logs hold a purpose, a 12-hex recipient hash, and the provider id. It has a `setMailTransportForTests` hook and `escapeHtml`. The idempotency key is a fresh `randomUUID()` on every call, so it gives no protection across retries (see §D).
- `server/team/inviteEmail.ts` is the only template. It is a light card (`#f6f6f7` page, white card, gold `#f6c453` button), with no images, no tracking, a single fragment link `/register#invite=…`, one-line names capped at 80 characters, and expiry in UTC.
- `server/calendar/reminders.ts` has a 30 s single-flight dispatcher with claim → re-check access at fire time → durable `notifications` row → advance, all in one transaction. It has L1 hourly deferral, `onNotification`/`emitNotifications` listeners (push hooks in there), and `notificationHref` built from ids only (T68).
- `server/inbox/service.ts`: a proposals notification coalesces per key for 15 min (`NOTIFY_COALESCE_MS`). `user_preferences.proposal_push` is the opt-in for push.
- `server/preferences.ts` has `user_preferences` with a CAS `revision`. It holds only `disabled_modules` and `proposal_push`, plus the stated rule: preferences hide UI, never access (T97).
- The Settings dialog has sections `security | modules | mcp | notifications | about`. **Settings has no URL.** `NotificationSettings.tsx` covers push devices plus "Push new proposals".
- Auth: there is **no password change, no password reset, no email verification, and no device/session metadata** (sessions have `created_at`/`last_seen_at` only, with no UA or IP). Recovery is the host CLIs `server/team-admin.ts` and `server/reset-totp.ts`.
- Tasks has `card_assignees` (multi), `card_comments`, `due_on` (a date), sprints, and column WIP. **@mentions do not exist.** Sharing is via `note_shares`, `folder_shares`, `document_shares`, `board_members`, `calendar_members`, `collection_members`, and each has a `*.sharing_changed` audit.
- The Resend SDK ships `webhooks.verify({payload, headers, webhookSecret})` over `standardwebhooks@1.1.1` (Svix headers `svix-id`, `svix-timestamp`, `svix-signature`). Event types include `email.bounced`, `email.complained`, `email.suppressed`, `email.failed`, and `email.delivery_delayed`.
- The app's tokens (`src/styles.css`) are bg `#09090a`, panel `#111113`, raised `#18181b`, border `#29292d`, muted `#929299`, text `#f5f5f4`, gold `#f6c453`, gold-strong `#ffd369`, gold-dim `#5a4315`, red `#fb7185`. The font is Inter with a system stack, and button text on gold is `#281f0b`. The mark (`public/icons/nook.svg`) is a gold folded page `#f7c948` with a `#7a5b00` fold and `#3a2d00` lines on `#111113`.

---

## A. Catalogue of every email Nook should send

### A.1 Classes (drive preferences, unsubscribe, and caps)

| Class | Meaning | Can the user turn it off? | Unsubscribe link / header | Quiet hours | Counts toward per-user activity cap |
| --- | --- | --- | --- | --- | --- |
| **security** | About the account's own safety or access | **No** (always on) | No | Ignored (sent at once) | No (separate cap) |
| **account** | Flows the user started: invite, verify, reset, test mail | No (the user asked for it) | No | Ignored | No |
| **activity** | Someone else did something that involves you | Yes, per category | Yes (one-click, per category) | Held until quiet hours end | Yes |
| **reminders** | Your own calendar reminders and due dates, by email | Yes | Yes | **Not held** by default (a reminder is time-bound; D242) | Yes |
| **digest** | Scheduled summary | Yes (cadence off) | Yes | Scheduled outside quiet hours by construction | Yes (1 per period) |

Activity categories (the toggles in §B): `assignments`, `comments`, `sharing`, `proposals`, `sprints`, `bin`. D231: there are six categories, not one per event. Fewer switches are easier to understand, and mute-per-board comes later for finer control.

### A.2 The catalogue

Columns: **R** = recipient; **When** = timing/batching; **Class**; **Link** = the deep link (always `APP_ORIGIN` + path built from ids); **Data** = what the template needs (resolved at send time, §D.6). **Rank** = value order within v1 and later.

#### Account and security (Team, auth)

| # | Email | Trigger | R | When | Class | Link | Data | Ship |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Team invite** (exists) | Admin creates an email-bound invite and picks "Send email" | Invitee address | Immediate, not queued behind others | account | `/register#invite=<token>` (fragment, never in logs/outbox body at rest; §D.5) | inviter display name, role, expiry | **v1**: port to the new template |
| 2 | **Your role changed** | `team.role_changed` | Target user | Immediate; coalesce 10 min (an admin toggling twice sends one mail with the final role; skip if final == original) | security | `/team/<self-id>` | old → new role, actor display name, role line (what it can do) | **v1** (rank 3) |
| 3 | **Your account was blocked** | `team.user_blocked` | Target user | Immediate | security | none (they cannot sign in); "Contact your admin" | actor display name, time. **Never the admin-only reason.** | **v1** (rank 5) |
| 4 | **Your account was unblocked** | `team.user_unblocked` | Target user | Immediate | security | `/` (sign in), "turn push on again" line | actor display name | **v1** (rank 6) |
| 5 | **New MCP API key created** | `mcp.key_created` | Key owner | Immediate | security | `/settings/mcp` (new route, §E.1) | key name, scopes summary ("Notes: read, write…"), time (in user tz), "Wasn't you? Revoke it" | **v1** (rank 2). High value: a stolen session that mints a key is the realistic takeover path. |
| 6 | **Two-factor turned on / off** | `auth.totp_enabled`, `auth.totp_disabled`, `auth.totp_admin_reset` (CLI) | User | Immediate | security | `/settings/security` | which change, time; for off/reset: "Turn it back on" | **v1** (rank 4) |
| 7 | **Recovery codes regenerated** / **a recovery code was used** | `auth.totp_recovery_regenerated`, `auth.recovery_code_used` | User | Immediate | security | `/settings/security` | codes remaining (count only) | **v1** (rank 7) with #6, same template |
| 8 | **All sessions signed out by an admin** | `team.sessions_revoked` | Target user | Immediate | security | `/` | actor display name | v1 (same template as #3/#4; cheap) |
| 9 | **New sign-in** | successful `auth.login` | User | — | security | — | — | **Later, not v1.** Nook stores no device/UA/IP (§A.3). |
| 10 | **Password changed** | — | — | — | security | — | — | **Blocked**: there is no password change route. Ships with the Wave C password flows (#11). |
| 11 | **Reset your password** | User submits `/forgot-password` | Verified address of an existing, unblocked account | Immediate; response identical whether or not the account exists | account | `/reset-password#token=<t>` (fragment) | expiry (30 min), "if not you, ignore" | **Wave C** (§F) |
| 12 | **Password was changed / reset** | reset completed, or (new) Settings → Security → Change password | User | Immediate | security | `/settings/security` | time, "all other sessions were signed out" | **Wave C** |
| 13 | **Verify your email** | Account registered through open registration (`ALLOW_REGISTRATION=true`), or the user changes address (future) | New address | Immediate | account | `/verify-email#token=<t>` | expiry (24 h) | **v1** (small, and it gates all other user mail; §A.4) |
| 14 | **Welcome to Nook** | First sign-in after registration or invite acceptance | New user | +1 min after registration (so an immediate "verify" is not overtaken) | account (one-off, no toggle; D232) | `/` (Today) | instance name, role line, 3 links: Today, Settings → Notifications, docs | **Later.** Low value on a small self-hosted team; the invite already explains Nook. |
| 15 | **Test email** | Settings → Notifications → "Send me a test email" | Self | Immediate; 3/h per user | account | `/settings/notifications` | none | **v1** |

#### Tasks

| # | Email | Trigger | R | When | Class/category | Link | Data | Ship |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | **Assigned to you** | A user is added to `card_assignees` by someone else (never self-assign; never on MCP writes by your own key) | New assignee | Coalesced: per recipient, all assignments within **10 min** → one mail ("Priya assigned you 3 cards on Launch") | activity/`assignments` | 1 card: `/tasks/<b>/card/<k>`; N cards on one board: `/tasks/my`; mixed: `/tasks/my` | board name, card titles (≤5 + "and 4 more"), due dates, actor names | **v1** (rank 1) |
| 17 | **New comment on your card** | `task.comment_create` on a card where the recipient is an assignee or the card's creator, and is not the author | Assignees + creator | Coalesced 10 min per (recipient, card): "3 new comments on 'Fix login'" | activity/`comments` | `/tasks/<b>/card/<k>` (D233: a later `#comment-<id>` anchor, when the card sheet can scroll to one) | card title, board, up to 3 comment excerpts (plain text, first 280 characters, Markdown stripped), authors | **v1** (rank 4) |
| 18 | **Mentioned in a comment** | — | — | — | activity/`comments` | — | — | **Dependency: mentions don't exist.** When `@mention` lands (Messages research also wants it), it reuses #17's template and coalescing, and a mention overrides a per-board mute. |
| 19 | **Due today / overdue** | Cards assigned to you with `due_on = today` or `< today` and not in a done column | Assignee | Not a separate mail: part of the **daily digest** (#28). D234: a standalone "due today" mail is noise when a digest exists. | digest | `/tasks/my?due=overdue` (whatever My work's filter query is) | card titles, boards, due dates | **Wave B** via digest |
| 20 | **Sprint started / completed** | `task.sprint_start`, `task.sprint_complete` | Board members with a role ≥ member who have ≥1 card in the sprint (not the whole board; D235) | Immediate; coalesce 10 min per board | activity/`sprints` | `/tasks/<b>/sprints` | sprint name, dates, counts (done/total, carried over), "your cards: 3 done, 1 carried over" | **Wave B** (rank low; off by default, D236) |
| 21 | **WIP limit exceeded** | `task.column_wip` breach | — | — | — | — | — | **Skip.** A WIP breach is a board-level visual cue; emailing it is noise and has no single owner. Revisit if boards gain owners. |

#### Calendar

| # | Email | Trigger | R | When | Class/category | Link | Data | Ship |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 22 | **Reminder by email** | Dispatcher fires a reminder that has `channel` including `email` (per-reminder choice, D237) | Reminder owner | At fire time; same claim/transaction; the outbox row is inserted in the notification transaction; late > 15 min → "(late)" in subject; > `MAX_LATENESS_MS` skipped (as today) | reminders | `/calendar/event/<id>` or `/notifications` for standalone | event title, start in reminder tz, location, calendar name | **Wave B** (rank 1 of Wave B) |
| 23 | **Event shared with you / calendar shared with you** | `calendar.sharing_changed` adds a member | New member | Coalesced 10 min | activity/`sharing` | `/calendar` (calendar) or `/calendar/event/<id>` | calendar name, actor, role (read/edit) | **v1** via the generic "shared with you" template (#25) |
| 24 | **Event changed / cancelled** | Time/place change or delete on an event in a calendar shared with you, by someone else, for an occurrence in the next 7 days | Calendar readers who **set a reminder on that event** (D238: a reminder is the signal that the user cares; everyone else sees it in the calendar) | Coalesced 10 min per event | reminders | `/calendar/event/<id>` (changed), `/calendar` (cancelled) | old → new time, title | **Wave B** |

#### Notes, Files, Collections (sharing)

| # | Email | Trigger | R | When | Class/category | Link | Data | Ship |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 25 | **Shared with you** (one template for note, folder, document, board, calendar, collection, task view) | `*.sharing_changed` where a user id is **added** to an explicit share list. `all_users` visibility changes send nothing (D239: broadcast mail to everyone for every public note is spam) | Newly added user | Coalesced **10 min** per recipient: "Priya shared 4 items with you" | activity/`sharing` | 1 item: `/notes/<id>`, `/files/<id>`, `/notes/folder/<id>`, `/tasks/<b>`, `/collections/<c>`, `/calendar`, `/tasks/views/<v>`; many: `/notes/shared` or the Today page | item kind + title, actor, access level | **v1** (rank 2) |
| 26 | **Collection row assigned** | — | — | — | — | — | — | **Skip**: there is no assignee concept on rows. |

#### Agent inbox, Bin, Today

| # | Email | Trigger | R | When | Class/category | Link | Data | Ship |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 27 | **Proposals awaiting you** | New pending proposals (MCP draft-awaiting-publish is now the `note_draft` proposal kind, so there is no separate draft mail) | Key owner | **Coalesced 60 min** per user (wider than the bell's 15 min per key: D240) and only if still pending at send time; at most 1 per 3 h | activity/`proposals` | `/inbox` (1 proposal: `/inbox/p/<id>`) | per key: key name + count; **no agent text** (T135 rule extends to mail); oldest expiry ("expires in 3 days") | **v1** (rank 3) |
| 28 | **Daily / weekly digest** ("Your day in Nook") | Scheduled at the user's `digest_local_time` in `digest_tz` | User | Daily or weekly (Monday); skipped when every section is empty (D241) | digest | each row links to its item; header button → `/` (Today) | sections reuse the Today providers: **Overdue & due today** (tasks assigned), **Upcoming** (events next 24 h / 7 d), **Proposals awaiting you** (count by key), **Shared with you since last digest**; later **Mentions** | **Wave B** (rank 2 of Wave B) |
| 29 | **Items leaving the Bin in 3 days** | Sweeper finds your Bin items with `deleted_at` between 27 and 28 days old | Deleter/owner | Once per item batch per day, via digest when the digest is on, else a standalone weekly mail | activity/`bin` (**off by default**) | `/bin` | count by kind, up to 5 titles | **Later** (optional; D243) |

### A.3 Assessments the brief asked for

- **New-device sign-in (#9).** Nook stores neither UA nor IP on sessions (`sessions` has only times). A "new sign-in" email without device info would say only "someone signed in", and it would fire on every login from every browser. That makes it noise, and people learn to ignore it. Doing it properly needs a `device_fingerprint` (a hashed coarse UA family + first-seen), a known-devices list in Settings → Security, and an "it wasn't me → sign out everywhere" action. That is an access-management concern, so it is **deferred to the access-management plan (T200–T219 range)**. This plan reserves only the template name `security.new_sign_in`.
- **Password changed (#10/#12).** Blocked on a feature that does not exist. Wave C adds **Settings → Security → Change password** (current password + TOTP when on; revokes other sessions) and the reset flow. Both send #12.
- **Welcome (#14).** Deferred: invites already explain Nook, and the operator runs a small team.
- **WIP breach (#21), row assigned (#26).** Skipped with reasons above.

### A.4 Email verification: recommended, small, in Wave A

Why: once Nook sends activity mail, open registration (`ALLOW_REGISTRATION=true` + empty `ALLOWED_EMAILS`) lets anyone register with a victim's address and make Nook send them mail. Password reset (Wave C) is only safe to a verified address.

Rules (D244):

- Add `users.email_verified_at` (migration 026). Backfill: the bootstrap admin (`team.bootstrap_admin` audit, or the oldest admin) and every user whose account came from an **email-bound** invite (`team_invites.email IS NOT NULL AND used_by = user`) are verified at migration time. Everyone else is unverified.
- Accepting an email-bound invite from now on sets `email_verified_at` (the invite link proved control of the inbox).
- **Unverified addresses receive only** the verification mail itself and security class mail. Security mail is still sent, because it protects the account holder and says nothing that is not already theirs. D245 default: send it; the alternative is to hold it too. They get **no** activity, reminders, digest, or reset mail.
- Settings → Notifications → Email shows "Verify your address to get email from Nook", with a **Send verification email** button (3/h).
- Token: 32 random bytes, base64url; stored as a SHA-256 hash with `purpose='verify_email'`, `user_id`, `email_at_issue`, and `expires_at` (+24 h); single use. The link is `/verify-email#token=…` (fragment, as invites do), and the page POSTs the token. Verification requires the address to still equal `email_at_issue`. It does not sign in or grant a session (the user must already be signed in, or it just marks verified and says "Sign in").

### A.5 Password reset: recommended for Wave C (security-sensitive)

Nook has none today; a forgotten password means asking an admin to run a CLI. That is fine for one operator, but the product now has invites and a team. Design (OWASP Forgot Password Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html):

- `POST /api/auth/password-reset/request {email}` always returns `202 {ok:true}` with the same body and a constant-time floor (a ~400 ms minimum plus jitter). The work (lookup, token, enqueue) runs after the response is committed, so timing does not reveal existence (T224).
- Mail goes only to an **existing, unblocked, verified** account. Blocked or unverified accounts get nothing and the same response.
- Token: 32 random bytes, SHA-256 at rest in `auth_tokens` (`purpose='password_reset'`), TTL **30 min**, single use. Issuing a new one invalidates older unused ones, and at most **3 requests/h per address hash** and **10/h per IP** (in memory, like login limits).
- Link: `APP_ORIGIN + /reset-password#token=…`. The link is built from `config.appOrigin`, **never from the Host header** (OWASP). The fragment keeps it out of server logs and Referer; the page sets `Referrer-Policy: no-referrer` and strips the fragment on load (as the invite page does).
- Completing the reset: `POST /api/auth/password-reset/complete {token, newPassword, totp?}`. **When TOTP is on, a TOTP or recovery code is required.** Reset replaces the password, not the second factor, so mail access alone cannot take over a 2FA account (T225). It revokes **all** sessions and does not sign the user in (OWASP: no auto-login). It sends security mail #12. It audits `auth.password_reset` and does **not** revoke MCP keys, though the mail links to them ("Review your API keys").
- Admins: keep the CLI. D246: an admin cannot trigger a reset mail for someone else in v1, since that would be an admin phishing surface.

---

## B. Preferences

### B.1 Settings → Notifications → Email (per user)

| Setting | Values | Default |
| --- | --- | --- |
| Email notifications (master) | on/off. Off stops activity, reminders, and digest; security + account mail still go | **on** once verified. D247: the default is on because mail is off instance-wide until the operator configures Resend, which is itself the opt-in. |
| Assignments | on/off | on |
| Comments on your cards | on/off | on |
| Shared with you | on/off | on |
| Proposals awaiting you | on/off | on |
| Sprints | on/off | **off** |
| Bin expiry | on/off | **off** |
| Reminders by email | on/off, plus the per-reminder channel in the reminder editor | on (the per-reminder default is push/bell only; email must be chosen per reminder, D237) |
| Digest | off / daily at HH:MM / weekly on Monday at HH:MM | **off** (D248: opt-in; one prompt card on Today after 7 days: "Get a morning summary by email?") |
| Quiet hours | off / from HH:MM to HH:MM (can wrap midnight) | off |
| Time zone | the browser's IANA zone, saved with every PUT; shown read-only with "Use this device's time zone" | saved on first visit |
| Security email | shown as "Always on", disabled switch with explanation | always on |

Later (D249): **mute a board / calendar / collection** from its own header menu ("Mute email from this board"). This is stored in `email_mutes (user_id, target_type, target_id)`. It applies to activity categories only, and a future @mention overrides it.

Semantics:
- Preferences gate **sending**, never access (the T97 principle holds).
- Quiet hours **hold** activity mail (the outbox `not_before` is moved to quiet-end in the user's tz). Coalescing continues while mail is held, so the user gets one mail at 08:00, not twenty. Reminders are not held (D242 default). Security and account mail are never held.
- The digest time must not fall inside quiet hours. The UI prevents it, and the server clamps it to quiet-end.

### B.2 Unsubscribe semantics

- Every **activity/reminders/digest** mail carries:
  - A body footer link: "Turn off *Shared with you* emails" → `APP_ORIGIN/mail/unsubscribe#t=<token>` (a page that shows what will be turned off, with a **Turn off** button that POSTs, and a "Manage all email settings" link).
  - Headers (RFC 8058):
    `List-Unsubscribe: <https://APP_ORIGIN/api/mail/unsubscribe?t=<token>>`
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
    A header URL cannot use a fragment, so the query holds the token. It is low-power (it can only turn one category off), so query placement is acceptable (T221).
- **POST `/api/mail/unsubscribe?t=…`** (no session, no CSRF: RFC 8058 POST from the mailbox provider). It verifies the token and sets that category (or the digest) off. It is idempotent and returns 200 with an empty body for valid and invalid tokens alike (no oracle). It is rate-limited to 30/min per IP.
- **GET** of either URL **never changes state**: link scanners and prefetchers (Outlook Safe Links, Gmail) fetch GETs. The GET on `/api/...` returns 405; the SPA page does the POST on click.
- The token is `base64url(v1 | user_id | category | issued_epoch | HMAC-SHA256(key, …)[0:16])`. The key is `mail-signing.key` in the data dir (32 bytes, 0600, created like the VAPID keys through `writePrivateFileAtomic`). Tokens never expire, and bumping `email_prefs.unsub_epoch` (on "Reset email links" or password reset) invalidates older ones. It carries no email address.
- **Never on security or account mail.** Those footers say "Security emails can't be turned off. They tell you about changes to your account."
- Gmail/Yahoo bulk-sender rules require one-click unsubscribe and honouring it within 2 days above ~5,000 mails/day (https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/, https://www.valimail.com/blog/one-click-unsubscribe/). Nook is far below that, but the headers are cheap and improve inbox placement.

### B.3 Migration 026 schema

```sql
-- 026_email.ts
ALTER TABLE users ADD COLUMN email_verified_at TEXT;          -- backfill: see §A.4

CREATE TABLE email_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  categories TEXT NOT NULL DEFAULT '{"assignments":1,"comments":1,"sharing":1,"proposals":1,"sprints":0,"bin":0,"reminders":1}'
    CHECK (json_valid(categories) AND json_type(categories) = 'object' AND length(categories) <= 512),
  digest TEXT NOT NULL DEFAULT 'off' CHECK (digest IN ('off','daily','weekly')),
  digest_local_time TEXT NOT NULL DEFAULT '08:00' CHECK (digest_local_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  quiet_start TEXT CHECK (quiet_start IS NULL OR quiet_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  quiet_end   TEXT CHECK (quiet_end   IS NULL OR quiet_end   GLOB '[0-2][0-9]:[0-5][0-9]'),
  tz TEXT NOT NULL DEFAULT 'UTC' CHECK (length(tz) <= 64),
  next_digest_at TEXT,                 -- UTC instant, recomputed on save and after each digest
  last_digest_at TEXT,
  unsub_epoch INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, -- CAS, as user_preferences
  updated_at TEXT NOT NULL,
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);
-- No row = defaults (as user_preferences). The row is created on first PUT.

CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL for invite-to-address mail
  to_hash TEXT NOT NULL CHECK (length(to_hash) = 12),    -- recipientHash; the address is resolved at send time
  to_address TEXT CHECK (to_address IS NULL OR length(to_address) <= 254), -- only for user_id IS NULL (invites)
  template TEXT NOT NULL CHECK (length(template) <= 40), -- 'tasks.assigned', 'security.api_key_created', …
  class TEXT NOT NULL CHECK (class IN ('security','account','activity','reminders','digest')),
  category TEXT,                                         -- activity category or NULL
  coalesce_key TEXT,                                     -- e.g. 'tasks.assigned:<user>' ; NULL = never coalesce
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384), -- ids + counts, never rendered HTML
  idempotency_key TEXT NOT NULL UNIQUE,                  -- sent to Resend; stable across retries
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed','skipped','dead')),
  skip_reason TEXT,                                      -- 'prefs_off','unverified','access_lost','empty','suppressed','cap'
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,                              -- coalescing window end / quiet-hours end / backoff
  claimed_at TEXT,
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) <= 64),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_outbox_due ON mail_outbox(not_before) WHERE status = 'queued';
CREATE INDEX idx_outbox_coalesce ON mail_outbox(coalesce_key) WHERE status = 'queued' AND coalesce_key IS NOT NULL;
CREATE INDEX idx_outbox_user ON mail_outbox(user_id, created_at);

CREATE TABLE mail_suppressions (            -- Wave B (webhooks); created in 026 so the schema is one step
  address_hash TEXT PRIMARY KEY CHECK (length(address_hash) = 64), -- full SHA-256 of the lowercased address
  reason TEXT NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
  provider_event_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE auth_tokens (                  -- verify_email (Wave A), password_reset (Wave C)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','password_reset')),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  email_at_issue TEXT NOT NULL COLLATE NOCASE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE mail_webhook_events (          -- replay guard for svix-id (Wave B)
  svix_id TEXT PRIMARY KEY, received_at TEXT NOT NULL
);

ALTER TABLE reminders ADD COLUMN channels TEXT NOT NULL DEFAULT 'push' CHECK (channels IN ('push','email','push_email')); -- Wave B uses it
```

Retention (the sweeper): `mail_outbox` rows that are `sent/skipped/suppressed` go after **30 days** and `dead`/`failed` after **90 days**. `payload` is nulled to `'{}'` when a row reaches a terminal state, so outbox history holds no titles. Invite `to_address` is nulled at terminal state. Used or expired `auth_tokens` go after 7 days, and `mail_webhook_events` after 7 days.

### B.4 Resend webhooks: accept in Wave B, not Wave A

- **Need:** without bounce/complaint handling, Nook keeps mailing dead addresses, which hurts domain reputation, and keeps mailing people who hit "spam", which Gmail punishes. Resend also keeps its own suppression list (`email.suppressed` event), so the damage is bounded even without webhooks. That is why this can wait for Wave B.
- **Cost:** a **public, unauthenticated** endpoint `POST /api/mail/webhooks/resend`. Nook is often reached through Tailscale, and a public endpoint may not be reachable at all. So it is **optional**: on only when `RESEND_WEBHOOK_SECRET` (the `whsec_…` form) is set.
- **Verification:** use the SDK's `resend.webhooks.verify({payload: rawBody, headers, webhookSecret})` (it wraps `standardwebhooks`, which is already in the lockfile as Resend's dependency, so there is no new top-level dep). It must see the **raw body** (read `c.req.text()` before any JSON parse; https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests). The timestamp tolerance is the library default (5 min). `svix-id` is stored in `mail_webhook_events` to drop replays, and the body cap is 64 KiB.
- **Handling:** `email.bounced` (hard bounce type only), `email.complained`, and `email.suppressed` insert into `mail_suppressions` (address hash), and mark the outbox row via `provider_id`. `email.delivery_delayed` is ignored. `email.failed` marks the row failed. Unknown types return 200 and are ignored. No payload content is logged or stored beyond the event id, type, and hash.
- A suppressed user sees a banner in Settings → Notifications: "Email to this address bounced; Nook stopped sending. **Try again**" (which deletes the suppression, 1/day).

---

## C. Design system for email

### C.1 Constraints (what clients actually do)

- **`<style>` support is partial.** Gmail supports `<style>` in `<head>` only, capped at 16 KB, and **non-Google accounts in the Gmail mobile apps get no `<style>` at all**. Outlook for Windows is buggy (https://www.caniemail.com/features/html-style/). → **Inline every style**; `<style>` is only a progressive enhancement (dark-mode overrides, mobile padding).
- **`prefers-color-scheme` reaches only ~42% of clients.** Gmail (partial), Apple Mail, and Outlook.com/iOS/Android support it; Outlook for Windows does not (https://www.caniemail.com/features/css-at-media-prefers-color-scheme/). Gmail and Outlook apps also **auto-invert** light emails in dark mode. → Design so that both a forced inversion and the native scheme look fine. Declare `<meta name="color-scheme" content="light dark">` and `<meta name="supported-color-schemes" content="light dark">`, plus `:root{color-scheme:light dark}`.
- **600 px max width**, a single column, and table layout (`role="presentation"`) for Outlook (Word engine). There is no flex, grid, `margin:auto` reliance, or background images without VML.
- **No JS, no forms, no web fonts that matter.** Inter via `<link>` works only in Apple Mail and some others, so the stack is `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` with no remote font load (and so no remote requests, keeping the "no remote content" invite promise).
- **Images:** many clients block remote images by default, and Gmail proxies them. SVG is **not** supported in Gmail or Outlook. → The brand mark is an **inline PNG as a CID attachment**? Resend supports attachments with `content_id`, but CID images show as attachments in some clients. Recommendation (D250): render the mark as a **table cell with a gold background and a bold "N"**, a "bulletproof logo" that needs no image, plus the wordmark "Nook" in text. Optionally a 48×48 PNG served from `APP_ORIGIN/icons/nook-192.png` with `alt="Nook"`; this is **off by default**, since a remote image is a fetch that tells the server the mail was opened (tracking-like, via Gmail's proxy only) and breaks on Tailscale-only origins.
- **Bulletproof button:** a table cell with a `bgcolor` + padded `<a>` (display:inline-block) and an MSO VML `v:roundrect` fallback in conditional comments, so Outlook for Windows shows a rounded gold button.
- **A plain-text alternative is mandatory**: every template renders `text` as a first-class output, not a stripped HTML. Links appear as bare URLs on their own line.
- **Preheader:** a hidden first `<div>` (display:none; max-height:0; overflow:hidden; mso-hide:all) with a one-line summary, followed by `&zwnj;&nbsp;` padding so clients do not pull body text into the preview.
- **Accessibility:** `lang="en"`, `<title>`, `role="article"` + `aria-roledescription="email"` on the wrapper. Contrast is ≥ 4.5:1 in both schemes, body is 16 px, the button is ≥ 44 px tall, and link text is meaningful (never "click here").

References for patterns: React Email templates and components (https://react.email/docs/introduction), Postmark's open-source transactional templates (https://github.com/ActiveCampaign/postmark-templates), and the notification mails of Linear/GitHub/Notion. Those are a compact header, one sentence of "who did what", a context card with the object, a single primary action, and a quiet footer with "why you got this" + settings. Linear and Notion notification mails are light-bodied with a small logo. GitHub's are nearly plain text. None rely on dark backgrounds, because inversion makes a dark-designed mail unpredictable.

### C.2 Nook's template (recommendation D251)

**Decision:** a **light-first body with a dark brand band** (header). The band is `#111113` with the gold mark and reads as Nook, the same dark and gold as the app. The body card stays light for reliability in every client and inversion mode. Native dark mode then (via `prefers-color-scheme`, where supported) turns the whole mail into the app's palette. This avoids the common failure of a dark-designed mail that Gmail inverts into mud, while still matching the product.

Tokens (email-safe hex, inlined):

| Token | Light (default, inline) | Dark (`@media (prefers-color-scheme: dark)` + `[data-ogsc]` for Outlook.com) | App source |
| --- | --- | --- | --- |
| page bg | `#f4f4f5` | `#09090a` | `--bg` |
| band bg | `#111113` | `#111113` | `--panel` |
| card bg | `#ffffff` | `#18181b` | `--panel-raised` |
| card border | `#e4e4e7` | `#29292d` | `--border` |
| text | `#18181b` | `#f5f5f4` | text |
| muted | `#52525b` (contrast 7.7:1 on white) | `#a1a1aa` | `--muted` adjusted for 4.5:1 |
| gold (button bg, accent) | `#f6c453` | `#f6c453` | `--yellow` |
| button text | `#281f0b` | `#281f0b` | primary-button |
| gold-dim (context bar) | `#fbe7b0` | `#5a4315` | `--yellow-dim` |
| danger (security headline icon/bar) | `#be123c` | `#fb7185` | `--red` |
| radius | card 12 px, button 10 px, band top 12 px | same | `.primary-button` 10 px |

Layout (600 px, one column):

```
┌──────────────────────────── page #f4f4f5 ────────────────────────────┐
│  [preheader hidden: "Priya assigned you ‘Fix login’ on Launch"]       │
│ ┌──────────────── band #111113, radius 12 12 0 0 ──────────────────┐ │
│ │  [■N] Nook          ·  <instance name, muted gold-dim>            │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────── card #fff, border #e4e4e7 ────────────────────────┐ │
│ │  EYEBROW (gold, 12px caps .12em):  TASKS · ASSIGNED               │ │
│ │  H1 22px/1.3 700:  Priya assigned you a card                      │ │
│ │  lead 16px muted: On the board Launch.                            │ │
│ │ ┌─ context block: 3px gold-left bar, bg #fafafa / #111113 ──────┐ │ │
│ │ │  Fix login redirect                       (15px 600, text)    │ │ │
│ │ │  Due Fri 3 Oct · Column In progress · 2 other assignees       │ │ │
│ │ └───────────────────────────────────────────────────────────────┘ │ │
│ │  [  Open card  ]   ← gold bulletproof button, 44px, 10px radius   │ │
│ │  or open: https://nook.example.ts.net/tasks/…/card/…  (13px muted)│ │
│ └───────────────────────────────────────────────────────────────────┘ │
│  footer 12px muted, centred:                                          │
│  You got this because you're assigned to cards on Nook (nook.example).│
│  Turn off assignment emails · Email settings                          │
│  Sent by Nook, a self-hosted workspace. No tracking.                  │
└───────────────────────────────────────────────────────────────────────┘
```

Security variant: the eyebrow is red "SECURITY", the context block has a red left bar, and the button is "Review in Settings". The fixed line is "If this wasn't you, sign in and turn off the key, or ask your admin." There is no unsubscribe link; instead the footer reads "Security emails can't be turned off."

Digest variant: the H1 is "Your day in Nook · Tue 30 Sep". Up to 4 section blocks, each with a small eyebrow and a list of rows (title as a link + a muted meta line; ≤5 rows per section + "and 3 more → Open Today"). There is one primary button, "Open Today".

Multiple items (coalesced): the context block becomes a list of ≤5 rows (each row links to its own item), "and N more", and the button goes to the aggregate page (`/tasks/my`, `/inbox`, `/notes/shared`).

Subject lines: sentence case, ≤ 70 chars, actor first, no emoji, no instance name in the subject (it is the From display name: `MAIL_FROM` like `Nook <nook@…>`). Examples: "Priya assigned you ‘Fix login redirect’", "3 new comments on ‘Fix login redirect’", "New API key “laptop” on your Nook account", "Your Nook role is now Viewer", "Key “laptop” suggested 4 changes", "Your day in Nook: 2 overdue, 3 events".

Instance name: new optional config `MAIL_INSTANCE_NAME` (default: the `APP_ORIGIN` host) appears in the band and footer, so people with two Nooks can tell them apart. It is validated as one line of ≤ 40 characters.

### C.3 Templating: hand-rolled TS, no new dependency (D252)

| Option | For | Against |
| --- | --- | --- |
| `react-email` / `@react-email/components` + `@react-email/render` | Good components (Button with MSO fallback, Preview, Tailwind), dev preview app, and `render(..., {plainText:true})` | A new dependency tree on the server (React + render + prettier/html-to-text transitive deps) in a Bun server that has no server-side React today. Its preview server is a separate Next.js app. React's escaping is good, but `dangerouslySetInnerHTML` is one keystroke away. The exact-pin policy (D93) means more to audit. |
| Hand-rolled | ~300 lines: `layout()`, `button()`, `contextBlock()`, `list()`, `footer()`, plus an `h` tagged template that escapes every interpolation by default | We must write the MSO button and dark-mode CSS ourselves (well-documented patterns) |

**Recommendation: hand-rolled.** It has ~12 templates, one layout, and zero dependencies, and it matches the codebase style (`inviteEmail.ts`). Structure:

```
server/mail/
  html.ts          // `html` tagged template: every ${} is escaped unless it is a SafeHtml returned by a component
  layout.ts        // layout({preheader, eyebrow, title, lead, body, action, footer, tone}) -> {html, text}
  components.ts    // button(href,label), context(rows), list(items), meta(parts) — each returns SafeHtml + text
  links.ts         // appLink(route) -> absolute URL from config.appOrigin; accepts only a typed Route or a known path builder
  templates/       // one file per template: (data) => {subject, preheader, html, text}
  registry.ts      // name -> {class, category, render, fixtures (for preview/tests)}
  outbox.ts        // enqueue(), coalesce, dispatcher tick (§D)
```

Rules: templates receive **resolved plain data** (strings, numbers, dates, ids). `html` escapes everything, and there is **no raw-HTML escape hatch** that accepts a string (`SafeHtml` can only be constructed inside `components.ts`). User-authored text (titles, comments, names, key names) goes through `cleanLine` (one line, 120 characters, strips control and bidi-override characters). Comments go through `stripMarkdown` → plain text → truncate 280. Agent text is **never** included (proposals list key name + count only).

**Dev preview (D253):** `GET /dev/mail/preview` (index) and `/dev/mail/preview/:template?scheme=light|dark&format=html|text`. It renders the registry's fixture data. It is registered **only when `NODE_ENV !== 'production'`**, and a test asserts the route is 404 in production config. It never sends. A `?send=1` option is deliberately absent; use Settings → "Send me a test email".

**Golden files:** `tests/mail/__golden__/<template>.html` and `.txt`, rendered from fixtures with a fixed clock and origin (`https://nook.test`). `bun test` compares, and `UPDATE_GOLDEN=1` rewrites them. Reviewers see diffs of real mail HTML in PRs.

---

## D. Delivery architecture

### D.1 Flow

```
module event (tx) ──► enqueueMail({user, template, data(ids), class, category, coalesceKey, windowMs})
                         │  inside the same DB transaction as the action when possible (atomic)
                         ▼
                   mail_outbox  (queued, not_before = now + window | quiet-end | now)
                         │
        30 s tick ◄──────┤  single-flight, unref'd timer, same pattern as runDispatch
                         ▼
   claim due rows (status=queued, not_before<=now, LIMIT 50) → status=sending, claimed_at
                         ▼
   per row: re-resolve at send time ── user blocked? prefs off? unverified? suppressed? access lost?
            │                            └─► skipped/suppressed (skip_reason)
            ▼
   render(template, freshData) → caps check (per-user/instance) → sendMail({..., idempotencyKey, headers})
            │ ok → sent + provider_id        │ rate_limited/cap → queued, not_before = window reset
            │ failed (5xx/timeout) → attempts++, backoff  │ 4xx validation → dead
```

- **Coalescing:** `enqueue` with a `coalesceKey` first looks for a `queued` row with the same key. If it finds one, it merges into it: the payload holds an id list (dedup, cap 50) and `not_before` is **not** extended past `first_created + windowMs` (a max wait, so a steady trickle cannot postpone mail forever). Default windows: assignments, comments, and sharing 10 min; proposals 60 min; role change 10 min; security 0 (not coalesced, except role change).
- **Transactions:** `enqueueMail` is a synchronous DB insert, so it can run inside the action's transaction (like `notifications` rows). The network send only happens in the tick. A crash never loses a mail and never sends one for a rolled-back action.
- **Tick:** `startMailDispatcher()` is started next to `startDispatcher()` in `server/index.ts`. On boot it releases `sending` claims older than 2 min back to `queued` (the idempotency key makes a resend safe). The digest scheduler runs in the same tick: users with `next_digest_at <= now` get a `digest` row enqueued and `next_digest_at` advanced (computed with the existing `zonedToUtc` from calendar recurrence).
- **Invites stay synchronous:** the admin wants immediate feedback ("Sent" / "Not configured"). The invite path calls the renderer + `sendMail` directly and records an outbox row with `status=sent|failed` for the email log (with `to_address` nulled immediately). D254.

### D.2 Caps (extend `mail.ts`)

Keep the existing in-memory limits as the provider-facing guard, and add durable caps computed from `mail_outbox`, so restarts do not reset them:

| Cap | Value | On breach |
| --- | --- | --- |
| Per user, activity + reminders | **12/hour, 60/day** | Hold (requeue at window reset); coalescing then merges more into the held mail |
| Per user, digest | 1 per period (enforced by `next_digest_at`) | — |
| Per user, security | 10/hour | Excess security mail is merged into one "Several security changes on your account" mail |
| Per recipient (all classes) | the existing 5/h is **too low** for users once activity mail exists → raise to **20/h**, keep 5/h for mail to non-users (invites) | Requeue |
| Per instance | 200/day → make it configurable `MAIL_DAILY_LIMIT` (default 500, 1–10 000). Resend free tier is 100/day and 3 000/month; the operator should set it to their plan | Activity is held first; security and account mail get a reserved 10% headroom |

`sendMail` gains `headers?: Record<string,string>` (for List-Unsubscribe) and `idempotencyKey?: string` (the outbox key). **Fix:** it currently generates a fresh UUID per call, so a retry after a timeout can double-send. The outbox passes `mail_outbox.idempotency_key` (= `outbox id`). Resend keeps idempotency keys for 24 h.

### D.3 Retries

- Retryable: timeout, network, provider 429/5xx. Backoff is `1 min, 5 min, 30 min, 2 h, 6 h` (+ ±20% jitter), and after 5 attempts the row is `dead`.
- Not retryable: provider 4xx validation (`validation_error`, `invalid_from_address`) → `dead` at once, plus one `console.error` with the code only.
- Stale mail: activity mail older than 24 h at send time is skipped as `stale` (a 2-day-old "assigned to you" is noise after an outage). Security mail is sent regardless, with "(delayed)" in the subject after 1 h.

### D.4 Admin visibility: Team → Email log (admins only)

`GET /api/team/mail-log?status=&template=&cursor=` returns id, created/sent time, template, class, status, attempts, error code, provider id, recipient **as display name if a user, else the hash**, and skip reason. It never returns an address, subject, or payload. A "Retry" action on `dead` rows re-queues once. The header shows counts for the last 24 h (sent/held/failed/dead) and the instance cap usage ("142 / 500 today"). Blocked when Email is not configured: "Email is not configured. See OPERATIONS → Email."

### D.5 Logging and PII

- Logs keep the existing format, `Mail sent: purpose=<template> recipient=<hash> id=<provider id>`, with no addresses, subjects, titles, or tokens.
- The outbox never stores rendered HTML. It stores `payload` with **ids and counts only** (e.g. `{cardIds:[…], actorId}`), and the template resolves titles at send time (§D.6). Exceptions: invite and reset/verify links contain credentials, so their tokens are **not** in the outbox. Invites are sent synchronously, and the verify/reset tokens are minted **at send time** inside the tick (the outbox holds only `auth_token_id`, and the raw token exists only in memory during render and send).
- Resend itself stores sent message bodies (dashboard, logs). That goes in OPERATIONS: credentials in mail (invite, reset, verify) are visible to anyone with Resend dashboard access. Keep that access to the operator, and keep **click tracking and open tracking off** (tracked links would route tokens through Resend's redirector, T220).

### D.6 Recompute at send time

The template's `resolve(payload, recipient)` re-runs the module's normal **read-access check as the recipient** (`readableEvent`, card/board membership, `documentAccess`, …) for each id. It drops items the recipient can no longer read and items that are binned. If nothing is left, the row is `skipped: access_lost`. Titles are fetched at that moment, not from enqueue time. This mirrors T67 for reminders and closes the "digest leaks titles after access loss" case (T226).

### D.7 Link safety

- Every URL in a mail comes from `appLink(route)` = `config.appOrigin` + `formatRoute(typedRoute)` (the SPA router's own formatter, moved or shared into `shared/`). Ids are validated with the router's `idPattern`, so no free-form path or query from user data reaches a URL (T223).
- No `?next=`/`?redirect=` parameters exist, and none are added. After sign-in the SPA returns to the path the user opened (same origin, parsed by `parseRoute`, which falls back to home), so there is no open redirect.
- `APP_ORIGIN` must be `https:` for mail to be enabled, **or** the operator sets `MAIL_ALLOW_HTTP_LINKS=true` (a LAN/Tailscale http origin). The startup warning says links in mail will be http. Mail on `http://localhost` is refused at startup when `RESEND_API_KEY` is set (links would be dead for recipients).
- `MAIL_FROM` validation already exists. Add a check that the display name contains no `@` or `<>` spoofing characters, and a startup warning when the MAIL_FROM domain differs from the APP_ORIGIN host's registrable domain (not an error: many operators use Tailscale hostnames).

### D.8 Threat rows (T220–T233)

| Id | Threat | Mitigation | Test |
| --- | --- | --- | --- |
| T220 | Credential links (invite, verify, reset) leak via logs, outbox, Referer, or provider click-tracking | Tokens are in fragments, never in the outbox or logs, and minted at send time. OPERATIONS requires click tracking off. The reset/verify pages send `Referrer-Policy: no-referrer` and strip the fragment | outbox rows for verify/reset contain no token; the log line regex has no token; the page strips the fragment |
| T221 | Unsubscribe token abuse (forged, or used to change other settings) | HMAC-signed, per user + category, and it can only turn one category **off**. GET is inert, POST is idempotent, the response is identical for valid and invalid tokens. The epoch bump revokes. It never applies to security mail | forged/mutated tokens do nothing; GET doesn't change state; a security-class template has no header |
| T222 | Phishing look-alike: attacker mail imitating Nook, or Nook mail content used to phish (a malicious card title "Your password expired, click here") | User text is escaped, one line, and length-capped. Titles appear inside a quoted context block, never as the H1. The button label is fixed per template. The only links are APP_ORIGIN. The footer says "Nook never asks for your password by email". DMARC/SPF/DKIM via the Resend domain setup (OPERATIONS) | escaping goldens with `<script>`, `"><a href=`, RTL override, and 10 kB titles |
| T223 | Open redirect or path injection via deep-link params | Links are built only from typed routes plus validated ids. No redirect params exist | a fuzz test that every template's links start with `APP_ORIGIN/` and parse back with `parseRoute` to the intended app |
| T224 | Account enumeration via reset or verification | Constant response + timing floor, work after the response, the same limits for unknown addresses, and no "no such account" copy | timing-insensitive equality of responses for existing, unknown, blocked, and unverified addresses |
| T225 | Mailbox compromise → account takeover via reset | Reset needs TOTP when enabled, has a 30 min TTL, is single use, revokes all sessions, and sends a security mail. Admin-initiated reset mail is not offered | reset without a TOTP code on a 2FA account fails |
| T226 | Digest or coalesced mail leaks titles of items the recipient lost access to between enqueue and send | Recompute at send time (§D.6). The payload holds ids only | revoke a share between enqueue and tick → the item is absent / the row is skipped |
| T227 | Mail bombing a victim via open registration or sharing spam | Verification gate for non-invited accounts. Per-user and per-recipient caps plus coalescing. Sharing mail only on explicit share, not `all_users` | 50 shares in a minute → 1 mail |
| T228 | HTML/header injection via display names, key names, or instance name | Every header value is `cleanLine`d (CR/LF stripped). `MAIL_INSTANCE_NAME` is validated at startup. Subjects are capped at 120 | CRLF in the name does not add headers |
| T229 | Forged or replayed Resend webhooks suppress a user's mail | Signature verified on the raw body, 5 min tolerance, svix-id dedup, the endpoint off unless a secret is set, and only suppression-type events are acted on. A user can clear their own suppression | a bad signature → 401 with no row; a replay → no-op |
| T230 | Blocked user keeps receiving activity mail with content | The tick skips activity/digest/reminders for `disabled_at IS NOT NULL` (as the reminders dispatcher does). Only #3/#4/#8 are sent | block, then enqueue → skipped |
| T231 | Mail to an address that changed (future email change) goes to the old owner | The address is resolved from `users.email` at send time. `auth_tokens.email_at_issue` must match | — |
| T232 | Dev preview route exposed in production | Registered only outside production. A test on the production config expects 404 | route test |
| T233 | Agent-authored text reaches mail (prompt-injection phishing through proposals) | Proposal mail carries key name + count only. The T135 rule is extended to mail in THREAT_MODEL | proposals mail golden contains no title or rationale |

---

## E. UX

### E.1 Settings deep links (new routes)

Mail must link to settings, and Settings today is a dialog without a URL. Add `/settings/:section` (`security | modules | mcp | notifications | about`). It opens Home (or the last app) with the Settings dialog at that section. Closing it replaces the URL with `/` (Home). Back from an opened `/settings/notifications` closes the dialog (the D69 behaviour). For history parity at 390 px: Back closes, and Forward reopens the dialog at the same section. A deep link while signed out goes to sign-in, then to the same `/settings/…` (the router already parses the path after sign-in). Router test rows are included in §F.

### E.2 Settings → Notifications (desktop, dialog content pane)

```
Notifications
  ┌ Push ─────────────────────────────────────── (existing section, unchanged) ┐
  └────────────────────────────────────────────────────────────────────────────┘
  ┌ Email ─────────────────────────────────────────────────────────────────────┐
  │ Email notifications                                            [ ●━ on ]   │
  │ Sent to priya@example.com · Verified ✓           [Send me a test email]    │
  │ ─────────────────────────────────────────────────────────────────────────  │
  │ WHAT TO EMAIL                                                              │
  │  Assigned to you             Someone assigns you a card        [ ●━ ]      │
  │  Comments on your cards      Grouped every 10 minutes          [ ●━ ]      │
  │  Shared with you             Notes, files, boards, calendars   [ ●━ ]      │
  │  Proposals awaiting you      At most one email an hour         [ ●━ ]      │
  │  Reminders by email          Choose per reminder in Calendar   [ ●━ ]      │
  │  Sprints                     Started and completed             [ ━○ ]      │
  │  Bin clean-up                3 days before items are removed   [ ━○ ]      │
  │  Security                    Always on                         [ ●━ ] (disabled) │
  │ ─────────────────────────────────────────────────────────────────────────  │
  │ SUMMARY                                                                    │
  │  Digest   [ Off ▾ | Daily | Weekly (Mondays) ]   at [ 08:00 ▾ ]            │
  │  Overdue and due-today cards, upcoming events, proposals, new shares.      │
  │ ─────────────────────────────────────────────────────────────────────────  │
  │ QUIET HOURS                                                   [ ━○ ]       │
  │  From [ 22:00 ▾ ] to [ 07:30 ▾ ]   Activity email waits until 07:30.       │
  │  Time zone: Europe/Berlin  (Use this device's time zone)                   │
  └────────────────────────────────────────────────────────────────────────────┘
```

States: **Email not configured** (the server has no Resend): the section shows one muted line, "Email is off on this Nook. Your admin can turn it on (OPERATIONS → Email)", with no switches. **Unverified:** a gold notice card "Verify priya@example.com to get email from Nook [Send verification email]", with switches disabled. **Suppressed:** a red notice "Email to this address bounced… [Try again]". **Saving:** CAS on `revision`, and a 409 shows "Your settings changed in another window" with Reload (as Modules does). The switches use the app's existing toggle and the custom dropdowns (TODO: "custom dropdowns everywhere").

Test email: the button disables for 20 s, then shows "Sent. Check your inbox (and spam)." / "Email is not configured" / "Too many test emails; try again in 1 hour" (3/h).

### E.3 390 px

```
┌──────────────────────────────┐
│ ‹ Settings     Notifications │
│ PUSH …                        │
│ EMAIL                         │
│ Email notifications    [●━]   │
│ priya@example.com ✓ Verified  │
│ [ Send me a test email      ] │  full-width secondary button, 44 px
│ WHAT TO EMAIL                 │
│ Assigned to you        [●━]   │  label 15 px, helper 13 px muted below
│ Someone assigns you a card    │
│ Comments on your cards [●━]   │
│ …                             │
│ SUMMARY                       │
│ Digest       [ Daily      ▾ ] │  stacked: select, then time
│ At           [ 08:00      ▾ ] │
│ QUIET HOURS            [━○]   │
│ From [22:00▾]  To [07:30▾]    │
│ Time zone Europe/Berlin       │
└──────────────────────────────┘
```

Rows are ≥ 44 px, and the whole row toggles. Back/Forward parity: the section is part of `/settings/notifications`, so Back closes Settings; there are no nested routes inside.

### E.4 Unsubscribe landing (`/mail/unsubscribe#t=…`, works signed out)

```
        [■N] Nook
  Turn off “Shared with you” emails?
  You'll still see shares in Nook. Security emails keep coming.
        [ Turn off ]     Manage all email settings →
  ───────────────
  Done state: “Shared with you emails are off. [Undo]”  (Undo = POST with the same token + on=1, 10 min)
```

### E.5 Team → Email log (admins; `/team/email`, a sibling of `/team/invites`)

Desktop: a table with the columns **When · Template · To · Status · Attempts · Provider id**. There are filter chips (All · Sent · Held · Failed · Dead), and the header strip reads "Today 142 / 500 · Held 3 · Dead 1". A row expands to show the skip reason / error code and **Retry** (dead only). At 390 px each row becomes a card (template + status pill on top, "To Priya · 10:42 · 2 attempts" below), with filters as a horizontal scroller. No subjects or addresses are shown. Empty state: "No email yet. Invites and notifications will appear here."

### E.6 Verify email and reset password flows

- **Verify:** the Settings button leads to the mail, which leads to `/verify-email#token` (the auth-card layout from `.auth-card`: brand mark, "Email verified", button "Open Nook"). Expired: "This link expired. Send a new one from Settings → Notifications."
- **Forgot password (Wave C):** the sign-in card gets a "Forgot password?" `inline-auth-switch`. That page has an email field and **Send reset link**, and always ends at "If an account with a verified address exists, we sent a link. It works for 30 minutes." `/reset-password#token` shows new password + confirm (the existing password field with visibility toggle) + a six-digit/recovery code field when the account has 2FA (the server tells the page, after the token checks out, only whether a code is needed). Success: "Password changed. All devices were signed out. [Sign in]".
- **Change password (Wave C)** in Settings → Security: current password, new password, confirm, and a TOTP code if on.

---

## F. Waves, sizes, tests, decisions

### F.1 Wave split

| Wave | Contents | Size |
| --- | --- | --- |
| **E1: Email foundation + first mails** (Wave 28 proposed; after 19/22, parallel-safe with 23–27 since it touches mail/, settings, and small hooks) | Migration **026** (all tables; `channels` column is unused until E2). `server/mail/{html,layout,components,links,registry,outbox}.ts`. The dispatcher tick with coalescing, caps, retries, stale skips, recompute at send time, and dead-letter. `mail.ts`: headers, a caller-supplied idempotency key, a configurable daily limit, recipient 20/h for users. Unsubscribe token, routes, and landing page. Email verification (§A.4). `/settings/:section` routes. Settings → Notifications → Email (all switches; digest select present but "Coming soon" disabled). Test email. Team → Email log. Templates: **invite (ported), assigned to you (#16), shared with you (#25), proposals awaiting you (#27), comment on your card (#17), security: new API key (#5), role changed (#2), 2FA on/off + recovery (#6/#7), blocked/unblocked/sessions revoked (#3/#4/#8), verify (#13), test (#15)**. Dev preview route and goldens. Docs: USING (Email section), OPERATIONS (MAIL_* vars, tracking off, dashboard visibility), API_CONTRACTS, THREAT_MODEL T220–T233, TEST_PLAN. MCP: **no MCP tools** (D255: email preferences are account settings and stay session-only, like push devices; a note in the MCP rules memo for this module). | **L** (2 sessions: server, then client) |
| **E2: Digests, reminders by email, webhooks** | The digest scheduler + template (Today providers reused server-side with the stored tz). Digest settings enabled. Reminders by email (per-reminder channel picker in the reminder editor; dispatcher enqueues in its transaction). Event changed/cancelled (#24). Sprint started/completed (#20). Bin expiry (#29, optional). Resend webhooks + suppression + the Settings banner. Per-board/calendar mute (`email_mutes`, **needs a migration**: take the next free id at the time, or fold it into 026 now as an empty table, D256 default: fold into 026). | **M–L** |
| **E3: Password flows** | Change password (Settings → Security), forgot/reset password (§A.5), password-changed mail (#12), reset rate limits, and `auth.password_reset`/`auth.password_changed` audits. `/security-review` before release. Optional new-sign-in mail if the access-management plan adds device records. | **M** |

The runnable-product rule holds: E1 pairs server and UI, with a QA instance using a fake transport that writes to `/dev/mail/outbox` in dev (a list of rendered mails), so QA can see mail without Resend.

### F.2 Test rows (TEST_PLAN additions)

| Area | Row |
| --- | --- |
| Golden | Each template × {light fixture} renders HTML and text identical to `__golden__`. Every HTML golden contains `<meta name="color-scheme" content="light dark">`, `@media (prefers-color-scheme: dark)`, a preheader, `role="presentation"` tables, and the MSO button conditional; width ≤ 600. |
| Text | Every template has non-empty `text` that holds the primary link on its own line and no HTML tags or entities. |
| Escaping | Titles/names with `<script>`, `"><img onerror>`, `&amp;`, CRLF, U+202E, and 10 kB length render escaped, single-line, and capped. The subject has no CR/LF. `SafeHtml` cannot be built from a string outside components (a type test plus a runtime test). |
| Links | Every `href` in every golden starts with `APP_ORIGIN/`. `parseRoute(path)` yields the expected app/ids. There are no query params except board queries and the unsubscribe token. Invite/verify/reset tokens appear only in fragments. |
| Unsubscribe | The header is present on activity/reminders/digest and absent on security/account. A valid POST turns only that category off. A forged, mutated, or other-user token has no effect with the same response. GET does not change state. The epoch bump invalidates. |
| Prefs | The master off skips activity but sends security. Category off skips. Unverified skips all but verify + security. Quiet hours move `not_before` to quiet-end in the user's tz (DST boundary cases, a wrap past midnight). Reminders are not held. CAS 409. |
| Coalescing | 5 assignments in 3 min → 1 mail listing 5. A steady trickle of one every 5 min is still sent by first+10 min (max wait). Different boards → one mail. Proposals: 60 min window, only if still pending (all approved before the send → skipped `empty`). |
| Caps | The 13th activity mail in an hour is held, not dropped, then merged. Security has its own cap. The instance cap reserves headroom for security. Caps survive a restart (durable count). |
| Retry | Timeout → attempt 2 after ~1 min with the **same idempotency key**. 5 failures → dead. 4xx validation → dead at once. A crash mid-send → claim released on boot and resent with the same key. |
| Recompute | A share revoked between enqueue and tick → item dropped / row skipped `access_lost`. A card binned → dropped. User blocked → activity skipped, blocked mail still sent. |
| Transaction | An action that rolls back leaves no outbox row. The reminder dispatcher inserts the email outbox row in the same transaction as the notification (E2). |
| Webhooks (E2) | A valid signature for bounce → suppression row. A bad signature → 401 and no row. A replayed svix-id → no-op. Endpoint 404 when no secret is set. Raw body used (whitespace-changed body fails). |
| Reset (E3) | Identical responses for existing/unknown/blocked/unverified. Token is single use, 30 min TTL, and a newer token invalidates older ones. 2FA required when on. All sessions revoked. No auto sign-in. Host header ignored for the link. Rate limits. |
| Routes | `/settings/notifications` opens the dialog. Back closes it and Forward reopens it at 390 px and desktop. `/team/email` is admin-only (member → 404-shaped). `/dev/mail/preview` 404 in production. |
| Logs | Across the suite, no log line contains `@`, a subject, or a token (extend the mail.test log capture). |

### F.3 Open decisions (with defaults)

| Id | Question | Default |
| --- | --- | --- |
| D236 | Sprints mail on by default? | Off |
| D237 | Reminder email per reminder, or a global "email all my reminders"? | Per reminder (the channel picker), plus the category switch as master |
| D238 | Event changed/cancelled: who gets it? | Only readers with a reminder on that event |
| D240 | Proposals mail window | 60 min, ≤ 1 per 3 h |
| D242 | Do quiet hours hold reminders? | No (the user set the time on purpose) |
| D245 | Security mail to unverified addresses? | Yes |
| D247 | Email master default on? | On (the operator configuring Resend is the instance opt-in) |
| D248 | Digest default | Off, with a one-time Today prompt |
| D250 | Remote logo image? | No: a text/table mark; optional `MAIL_LOGO_URL` later |
| D251 | Palette | Light body + dark brand band; full dark via `prefers-color-scheme` |
| D252 | react-email vs hand-rolled | Hand-rolled, no new dependency |
| D254 | Invites via outbox or sync? | Sync send, logged into the outbox as sent/failed |
| D255 | MCP tools for email prefs? | None (session-only account settings); record the per-module MCP decision in the wave notes |
| D256 | `email_mutes` in 026 now? | Yes, an empty table in 026 |
| D257 | Password reset at all? | Yes, Wave E3, 2FA-preserving |
| D258 | Welcome mail | Later |
| D259 | New-sign-in mail | Deferred to the access-management plan (needs device records) |
| D260 | `MAIL_DAILY_LIMIT` default | 500; OPERATIONS tells operators on Resend's free tier to set 100 |

### Sources

- Resend webhook verification (raw body, Svix headers, `webhooks.verify`): https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
- Caniemail `<style>` support (Gmail head-only, 16 KB, none for non-Google accounts in the mobile apps): https://www.caniemail.com/features/html-style/
- Caniemail `prefers-color-scheme` (~42% support): https://www.caniemail.com/features/css-at-media-prefers-color-scheme/
- One-click unsubscribe (RFC 8058) and Gmail/Yahoo sender rules: https://www.valimail.com/blog/one-click-unsubscribe/ , https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/ , https://www.rfc-editor.org/rfc/rfc8058
- OWASP Forgot Password Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- React Email: https://react.email/docs/introduction
- Postmark open-source templates (pattern reference): https://github.com/ActiveCampaign/postmark-templates

---

## Director review (2026-09-28)

- **Numbering:** local ids EM1–EM30 are now decisions **D231–D260**; threat rows T220–T233 stand. Migration 026.
- **Accepted:** the catalogue and first-release set (assigned to you; shared with you — one template for every module; proposals awaiting you with key name + count only; comments on your card; the security set: new MCP key, role change, 2FA and recovery codes, blocked/unblocked, signed out everywhere; verify + test emails; invite email moved onto the new template); email verification in the first release gating all non-security mail; password reset keeps two-factor; preferences (master switch, categories, digest off/daily/weekly at a local time, quiet hours with stored zone, signed one-click unsubscribe that only turns one category off after confirmation, never on security mail); List-Unsubscribe headers; outbox written in the same transaction as the action with a 30 s single-flight dispatcher, coalescing (10 min, max 60 min for proposals), durable caps, retries + dead letter, access re-checked at send time, tokens only in link fragments created at send time, links only to `APP_ORIGIN`, admin Email log at `/team/email`; the design (inline CSS, light body under the dark brand header band, gold button, plain-text alternative, hand-rolled TS templates with escaping by default, dev-only preview route, golden-file tests; `react-email` rejected); `/settings/:section` routes so emails can deep-link into Settings; `mail.ts` fixes (idempotency key = outbox row id; 20/h per user, 5/h for invites); new settings `MAIL_INSTANCE_NAME`, `MAIL_DAILY_LIMIT` (500 default; 100 on Resend free tier), `MAIL_ALLOW_HTTP_LINKS`, `RESEND_WEBHOOK_SECRET` (webhooks only when set, verified with Resend's bundled `webhooks.verify` on the raw body).
- **Defaults confirmed:** email on by default once Resend is configured (digest and sprint mails default off); no MCP tools for email preferences; invites keep sending immediately and are logged in the outbox.
- **Wave numbers:** E1 = **Wave 28** (foundation + first-release emails + verification + preferences), E2 = **Wave 29** (digests, reminders by email, webhooks/suppression, mutes), E3 = **Wave 30** (change/reset password with a security review). Wave 28 starts now in parallel with Waves 19/22; it must not touch server/inbox/** beyond enqueueing the proposals email through a small hook the inbox service exposes.
