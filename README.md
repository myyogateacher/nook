# Nook

**A private, self-hosted workspace for a household or a small trusted team: notes, files, tasks, collections, and calendars in one small Docker container.**

Everything stays on storage you control. Notes are portable Markdown files with immutable version history, files keep their bytes, and nothing is shared until you share it. Built with Bun, Hono, SQLite, React, and Tiptap.

Documentation: [pankajsoni19.github.io/nook](https://pankajsoni19.github.io/nook/)

<p align="center">
  <img src="docs/images/hero-dark.png" alt="Nook task board in sprint view with a phone showing the Today dashboard" width="1200" />
</p>

## Features

### Today

The home screen shows what needs you now: cards due soon and assigned to you, recent and unpublished notes, drafts written by agents, recent files and collection rows, upcoming events, items leaving the Bin, and your storage use. Sections can be hidden per account.

### Notes

- Markdown editor with slash commands, checklists, code blocks, quotes, pasted or dropped images, and tables.
- Drafts save automatically; **Publish** records an immutable version you can diff and restore.
- **Download as PDF**, folders, and sharing by note or folder.
- Full-text search across titles and bodies: accent- and case-insensitive, prefix and phrase matching, and it never shows what you cannot read.

### Files

- Upload with progress, cancel, and retry; list or thumbnail grid; rename, move, and share in the same folders as notes.
- Inline previews for images, PDFs, text, audio, and video. Types are detected from the file's bytes, and unsafe types (SVG, HTML) are download-only.
- Per-file size limit, per-user quota, and a free-disk floor.

### Tasks

- **Boards** with drag and drop, columns with To do / In progress / Done states, and **WIP limits**.
- **Cards** with due dates and times, multiple assignees, colour **tags**, **flags** (urgent, blocked, needs review, on hold), **relations** (depends on, relates to, duplicates), comments, and attachments.
- A full-screen **card composer** that sets everything in one step, and a full-page card view.
- **Views**: columns, a sortable table, a grouped list, and a calendar with drag-to-reschedule. A filter bar (assignee, tag, flag, due, column, level, sprint, relations) keeps its state in the URL, so filtered views are shareable links.
- **Hierarchy**: Task › Subtask, Epic › Story › Subtask, or your own level names, with subtask checklists, progress, and parent chips.
- **Sprints**: plan, start, and complete sprints, with a sprint switcher, a progress strip, and a carry-over choice for unfinished cards.
- **Templates**: Simple kanban, Personal to-do, Task checklist, Scrum sprint board, Epic › Story › Subtask, Bug triage, and Content pipeline.
- **Tasks home**: **My work** lists everything assigned to you across boards; **saved views** keep a cross-board filter and layout, shared privately, with chosen people, or with everyone, and always evaluated as the viewer.

<p align="center">
  <img src="docs/images/tasks-card-dark.png" alt="A task card with assignees, tags, flags, sprint, and a subtask checklist" width="49%" />
  <img src="docs/images/tasks-table-dark.png" alt="A task board in table view with subtasks nested under their task" width="49%" />
</p>

### Collections

Typed tables for inventories, subscriptions, expenses, recipes, or contacts: text, number, date, checkbox, select, link, note, and file fields; inline editing; sort, filter, and saved views; one-step undo; CSV import and export; and sharing as view-only or can-edit.

### Calendar

Calendars with agenda and month views, repeating events, links to notes, cards, and rows, due cards overlaid on the calendar, and sharing as view-only or can-edit. Reminders arrive in the notification bell and as Web Push on HTTPS, and revocable iCalendar feed links (busy-only or full details) let other calendar apps subscribe.

### Team

- Roles: **admin**, **member**, **viewer** (reads what is shared with them or with everyone, changes nothing), and **guest** (reads only what is shared with them by name). Read-only roles are enforced on the server, not just hidden in the app.
- Admins block and unblock accounts, sign them out everywhere, and see activity. Admins never see anyone's private content.
- New accounts get `SIGNUP_ROLE` (default `guest`). A host CLI (`server/team-admin.ts`) recovers from a lockout.
- **Sign in with Google** (optional): `AUTH_METHODS=password|google|both` chooses the methods, enforced on the server. Google accounts are created automatically when registration would allow it (the first account, an invite, or open registration), `GOOGLE_ALLOWED_DOMAINS` limits them to your company domains, two-factor still applies, and Google profile pictures replace the letter avatars (downloaded and served by Nook itself). Setup: [docs/OPERATIONS.md](docs/OPERATIONS.md#google-sign-in).
- **Behind a reverse proxy or Tailscale Serve**, set `TRUSTED_PROXY_HOPS=1` so rate limits count each visitor separately (see [docs/OPERATIONS.md](docs/OPERATIONS.md#rate-limits-and-reverse-proxies)).
- **Central access**: Team → a member → **Access** shows everything a person can open, per module and through what (direct, a group, or everyone), with titles hidden for items the admin cannot open. Admins can only take access away (remove, lower, leave a group, revoke keys, or **Reset access**), each confirmed, logged in **Team → Access activity**, and announced on the owner's bell. **Team → Templates** gives invites a role and groups. Everyone but guests sees their own in **Settings → My access**.

### Everywhere

- **Shared Bin**: deleted notes, files, cards, boards, collections, rows, calendars, and events wait 30 days with their history and sharing, then are removed for good. A card moves to the Bin with its subtasks.
- **Settings → Modules**: turn apps on or off for your account on every device. Nothing is deleted and sharing is unchanged.
- **Mobile first**: every app, item, and view has its own URL, phones get focused single-column screens, and browser Back and Forward work everywhere (Back closes an open dialog or sheet first).
- **MCP server**: a Streamable HTTP endpoint for trusted AI clients with revocable API keys and per-key permissions across notes (read, write drafts), files (read), tasks (read, write), collections (read, write), calendar (read, write), Today, and team (admins). Agents write drafts; publishing always stays with you.

<p align="center">
  <img src="docs/images/notes-editor-dark.png" alt="The Notes editor with a folder rail, note list, checklist, and table" width="49%" />
  <img src="docs/images/calendar-dark.png" alt="The Calendar month view with repeating events and due cards" width="49%" />
</p>

## Security

- Argon2id passwords, opaque HttpOnly SameSite session cookies, CSRF tokens, a strict Content Security Policy, and an exact browser-origin allowlist.
- Optional or required TOTP two-factor authentication; secrets and recovery codes are encrypted with AES-256-GCM.
- Private by default: the server authorises every read, and search, previews, Today, feeds, and MCP only see what the user may open.
- Hashed API keys and feed tokens, rate limits on sign-in, search, and MCP, and payload-less Web Push to allowlisted push services only.
- A hardened container: non-root user, read-only root filesystem, dropped capabilities, and `no-new-privileges`.
- Verified weekly backups with five-archive retention (`scripts/backup.sh`).

Nook is designed for one host on a trusted network. Prefer HTTPS through Tailscale Serve or a reverse proxy.

## Quick start

You need Git, Docker Engine, and Docker Compose.

```sh
git clone https://github.com/pankajsoni19/nook.git && cd nook
cp .env.example .env            # set ALLOWED_EMAILS, TOTP_POLICY, APP_ORIGINS as needed
sudo mkdir -p /srv/mynotes && sudo chown 1000:1000 /srv/mynotes   # or set MYNOTES_DATA_DIR
APP_VERSION=0.15.0 GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
curl http://localhost:2026/api/health   # then open http://localhost:2026 and create the first account (the admin)
```

Later registrations stay disabled unless you set `ALLOW_REGISTRATION=true`. Internal identifiers such as `mynotes.sqlite`, the `mynotes` container, `MYNOTES_DATA_DIR`, and the `mynotes-*` backup archives keep the original prefix for compatibility.

## Upgrading

Back up first (`./scripts/backup.sh --force`), pull, rebuild, and let migrations run on the first boot. Release-specific steps are in [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new in v0.15.0

- **Sign in with Google**: the sign-in, register, and invite pages offer **Continue with Google**. A Google address with no account gets one automatically when registration would allow it: open registration, a valid invite, or the first account on an empty instance (which becomes the admin). Accounts with two-factor on still enter their Nook code after Google. `ALLOWED_EMAILS` and blocking apply as for passwords.
- **Sign-in methods**: `AUTH_METHODS` is `password` (the default), `google`, or `both`, enforced on the server. `password` turns Google sign-in off; `google` turns off password sign-in, registration with a password, forgot and reset password, and password change. Upgrading changes nothing until you set it.
- **New settings**: `AUTH_METHODS` (default `password`), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (empty; both required for `google` or `both`, or the server refuses to start), `GOOGLE_ALLOWED_DOMAINS` (empty; optional list of email domains allowed to use Google sign-in; it does not restrict password registration), and `TRUSTED_PROXY_HOPS` (0 to 5, default `0`; the number of reverse proxies in front of Nook).
- **Profile pictures**: a Google user's picture replaces the letter in the header, Settings, Team, the Access sheet, card assignees and the assignee picker, and comment authors. The server downloads it at sign-in and serves it from your Nook, so browsers never contact Google and the content security policy is unchanged. Without a picture, or if it fails to load, the letter is shown. Pictures are stored in the data directory (`avatars/`) and included in backups.
- **Linking existing accounts**: a Google sign-in links automatically only to an account whose address Nook has verified, and only when Google is authoritative for that address (a Gmail address, or a Google Workspace account on the address's own domain). Otherwise nothing about the account changes and the person is told what to do. Password users link in **Settings → Security → Link Google** after confirming their password. An admin can allow a link from **Team** (once, within 24 hours), optionally resetting the account first, and can allow re-linking when someone recreated their Google account. The host command line does the same: `allow-google-link <email> [--reset | --keep-credentials]` and `unlink-google <email>`.
- **New admin powers**: **Allow Google sign-in**; **Reset account for Google sign-in** (signs the account out everywhere, revokes its API keys and calendar feed links, removes its password and two-factor, makes everything it owns private and removes its shares, revokes its open invites, and pauses its routines; content is kept), offered in the app only for accounts whose address was never verified and never for admins or accounts that were admins in the last 24 hours; **Allow re-linking** (when the new Google account signs in, the previous holder's sessions, API keys, calendar feed links, and unused password-reset links end, and by default the password and two-factor too); and **Unlink** (the member is signed out everywhere). Each asks for your own password (or a Google confirmation) and two-factor code, is recorded in **Team → Access activity**, and tells the member on the bell and, with email on, by security mail; a reset is also shown at their next sign-in.
- **Accounts without a password**: people who sign in only with Google are asked to **Confirm with Google** where others give their password (new API key, rotate, two-factor setup); it needs a fresh Google sign-in.
- **Rate limits**: password sign-in, account creation, and invite preview are now also limited per client address (20, 5, and 10 a minute), in addition to the per-email and instance-wide limits. Behind a reverse proxy set `TRUSTED_PROXY_HOPS` so each visitor counts alone.
- **Fixes**: after turning on two-factor, Settings now stays open on the recovery codes (**Copy all**, **Download**, **I saved them**); before, they disappeared at once. No new MCP tools for sign-in or Google accounts, and API keys are unaffected.
- Migration 034 runs on the first boot, so back up first. Nothing changes for sign-in until you set `AUTH_METHODS`; see [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades) for the Google Cloud setup and reverse-proxy advice.

## What's new in v0.14.0

- **Member access**: admins open **Team → a member → Access** to see everything that person can reach, per kind, one row per item with each way they reach it (shared directly or through a group), plus how many items are shared with everyone signed in, their groups, and their API keys. Items the admin cannot open are shown without their title, as "Board owned by" and the owner's name.
- **Reduce only**: from that page admins can lower a level, remove a direct share, or take the person out of a group. Each change asks for confirmation, is recorded, and tells the item's owner or the person on the bell. Nothing on the page grants or raises access.
- **Reset access**: removes a person's direct shares and group memberships, revokes their API keys and calendar feeds, and pauses their routines, with counts shown before and after. Items the person owns are untouched. It is not offered on your own account.
- **My access**: **Settings → My access** (`/settings/access`) shows, read-only, what you can reach and through what. Guests do not have it.
- **Access templates**: **Team → Templates** holds a role and groups. Pick one on an invite and the new account joins those groups when it registers. An invite keeps the template as it was when the invite was made, so later edits do not change invites already sent; deleting a template leaves its invites working with their role and no groups. Applying a template to an existing member adds its groups and never changes their role. With sharing with guests off, a guest skips groups that have items shared with them.
- **Access activity**: **Team → Access activity** shows who changed whose access, filtered by person, group, key, and kind of change.
- **Bell**: the bell now tells you when you are added to or removed from a group, when an admin lowers, removes, or resets access (to your items, or yours), and when an admin revokes your API key. The Access sheet tells an owner how many of their API keys can reach the item.
- **Fixes**: the New group dialog focuses the name and checks it inline; wording fixes. No new MCP tools, and API keys cannot manage access.
- Migration 032 runs on the first boot, so back up first. Admins gain new powers to see and reduce access; see [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new in v0.13.0

- **Passwords**: change your password in **Settings → Security** with your current password, plus a two-factor code when you use one; your other devices are signed out. With email on, **Forgot password?** on the sign-in page mails a single-use link that works for 30 minutes, and a security email says when a password was changed or reset. With email off there is no self-service reset and the links are hidden. Settings also says when two-factor cannot be set up because this Nook has no TOTP key.
- **Groups**: admins create groups in **Team → Groups** (`/team/groups`) and decide who is in them; owners share items with a group, and its members follow as people join or leave.
- **Levels**: each person or group gets a level: **Can view**, **Can comment** (boards), **Can edit**, or **Manager** (boards, collections, and calendars). People who can edit a note write its draft and publish it. Files and task views stay view-only for other people.
- **One Access sheet**: the **Share** button on notes, folders, files, boards, task views, collections, and calendars opens the same Access sheet. It warns before a change of audience drops people, and asks before discarding unsaved changes.
- **Sharing with guests**: **Team → Policies** has a switch for sharing with guests. While it is off, new shares that would reach a guest are refused, whether directly, through a group, by adding a guest to a group that already has shares, or by changing such a member to the guest role. What is already shared stays until its owner changes it, and can be lowered or removed but not raised.
- **Fixes**: viewers, commenters, and guests no longer see card actions they cannot use. On a page loaded directly, Back closes an open dialog at every width; dropdowns and pickers are their own Back step; Board settings and the Calendars sheet stay open under the dialogs they open. New Notes folders and links use the app's own name dialog instead of browser prompts. A routine's "due" state now follows the same clock as its next run time.
- **API keys**: structure tools on boards (rename and recolour tags, WIP limits, create and start sprints) work through a key only for the board's owner; a manager's key is refused. Creating a board tag now needs the edit level. No new MCP tools.
- Migration 029 runs on the first boot, so back up first. Some owner powers move to managers; see [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new in v0.12.0

- **API keys**: Settings → API keys replaces Settings → MCP. Build a key one permission at a time (module, permission, and all or chosen boards, collections, or calendars) with an expiry within your team's policy. The token is shown once. Edits only narrow a key (rename, remove permissions, lower Write to Read, choose fewer items, bring the expiry closer); **Rotate** issues a new secret and lets the old one stop now or keep working for 1 hour, 24 hours, or 7 days. Each key shows its 14-day usage. A key limited to chosen items sees nothing outside them, including through relations, event links, and collection note fields. Existing MCP keys keep exactly the reach they had.
- **Team keys and policies**: **Team → Keys** (`/team/keys`) lists every live key for admins, never its secret, with **Revoke** and a reason the owner sees. **Team → Policies** (`/team/policies`) sets the longest and default key lifetime, keys per person, and which surfaces and modules each role's keys may use, with a preview of how many keys a change would block.
- **Email digests, reminders, and mutes**: a daily or weekly digest at your local time; calendar reminders by notification, email, or both; an email when an event you set a reminder on is changed or cancelled; optional sprint started and completed and Bin clean-up emails (off by default); and **Mute emails** per board or calendar, listed under **Muted** in Settings → Notifications → Email.
- **Bounces and complaints**: an optional Resend webhook (`RESEND_WEBHOOK_SECRET`) stops mail to addresses that bounce or report spam, with **Try again** once a day in Settings, and **Team → Email log** tags recipients whose mail is held back.
- **Fixes**: focus returns to the opener when Calendar and API keys dialogs close, phone Forward reopens a sheet that Back closed with no dead history step, deleting a note confirms in the app's own dialog, the header Bin badge refreshes after a restore or delete, reminder rows say how each reminder is sent, and mail subjects stay within their length cap after defanging.
- Migrations 025 and 028 run on the first boot, so back up first. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new in v0.11.0

- **MCP write coverage**: three new opt-in scopes. `notes:publish` lets an agent publish a note draft it has read, `files:write` lets it upload files, store text files, create folders, and rename or move files, and `bin:write` lets it move items to the Bin and restore them (never forever). Existing keys gain nothing. Settings → MCP has a **Review** dialog per key listing what it binned, with **Restore all** for that key.
- **Routines and runs**: scheduled routines, at `/inbox/routines`, that your MCP agents run on a cadence. Each run is listed in its history with the proposals it made; pause and resume a routine at any time. Routine proposals reach the Inbox and, when email is on, your email.
- **Outbound email**: Resend via `RESEND_API_KEY` and `MAIL_FROM`, off unless both are set. Verified addresses, per-user email settings in Settings → Notifications → Email, one-click unsubscribe pages, and **Team → Email log** for admins. Templates cover invites, security notices, assignments, comments, shares, and proposals. Links in mail point only to `APP_ORIGIN`.
- **Fixes**: steadier ordering for rows created in the same millisecond, React 19 handler bugs, History and Back layering for dialogs and sheets, the phone Settings tab strip scrolls to the active section, 44 px phone targets, new cards go into the active sprint when none is given, note-draft proposals are compared with the draft the agent built on, a resumed routine does not re-run a slot that already ran, MCP `create_sprint` dates sprints by default, and an open note refreshes when its draft is published from the Inbox.
- Migration 026 runs on the first boot, so back up first. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new in v0.10.0

- **Team invites**: admins create single-use invite links at `/team/invites`, optionally bound to one email address, with a fixed role. When email is configured, Nook sends the invite by email.
- **Outbound email** through Resend, off unless `RESEND_API_KEY` and `MAIL_FROM` are both set.
- **Emoji reactions** on card comments.
- **Agent inbox**: MCP keys with `inbox:read`/`inbox:write` propose changes instead of making them; you approve or reject each one in the app only, with a diff. Bulk approve, **Proposals awaiting you** on Today, an Inbox button with a badge, and opt-in push.
- **Review fixes**: rejecting a draft proposal restores your own draft; proposals from a revoked key are superseded; expiry is enforced on approve.
- **QA fixes**: the Settings → MCP checkbox no longer crashes, an app-wide error card replaces a blank page, phones show the page name, a chip marks stale proposals, and bulk approve names the proposals that failed.
- Migrations 018, 021, 022, and 027 run on the first boot, so back up first. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new in v0.9.3

- **The task card opens as a drawer on desktop**: a full-height panel on the right, with the fields column on the left, the description and comments on the right, and the comment box pinned at the bottom. Phones are unchanged.
- **The card composer stays a centred dialog**, so creating a card works as before. No migration in this release.

## What's new in v0.9.2

- **Today** is grouped into **Today**, **Recent work**, and **Housekeeping**, and empty sections fold away.
- **Tags** get distinct colours, and creating one is easy to find: the list opens on focus, with a **Create** row and **+ New tag**.
- **Due** is a picker with **Apply** and **Cancel** and quick picks; lane cards are tidier, and the card dialog is wider, with two columns on large screens.
- **Subtasks always belong to a task**: the parent field offers **Choose a task…**, and **Make it a task** turns a subtask into a task.
- **Sprint defaults per board** (duration, start rule, name pattern), **New sprint** from the header switcher, a dedicated **Sprints** page, and a prompt when no sprint is active.
- **Team** role changes and blocking no longer ask for your password; the session, CSRF check, and audit log still apply. Long dropdown lists scroll again. No migration in this release.

## What's new in v0.9.1

- **Card descriptions size to their text** in the card dialog and the full-page card, growing as you type and scrolling past 60% of the screen.
- **Calendar month**: click an empty part of a day (or its **+**) to add an event on it; on a phone, tap the day, then **New event on <date>**.
- **Copy link** on cards (the card header and a board card's ⋯ **More actions**), without the view or filters, plus even spacing on the Tasks home. No migration in this release.

## What's new in v0.9.0

- **Viewer and guest roles** with read-only enforcement on the server; `SIGNUP_ROLE` (default `guest`) sets the role of new accounts.
- **Task hierarchy and sprints**: subtasks, epics and stories, hierarchy templates, sprint planning, and a lighter board payload.
- **Tasks home** with My work and saved cross-board views. Migration 019 runs on the first boot, so back up first.
- **Review and QA fixes**: read-only roles can edit only their private views (with a Make private option for shared ones), Columns view says how many epics it hides with a Show all levels switch, focus moves into sheets and dialogs, and 44 px phone targets.

Earlier releases: [release notes](https://pankajsoni19.github.io/nook/#whats-new).

## Documentation

- [Documentation site](https://pankajsoni19.github.io/nook/): every app, configuration, security, backups, and upgrades.
- [docs/USING.md](docs/USING.md): the user guide for every app, the Bin, Team, Modules, and MCP keys.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): configuration reference, storage, backup and restore, upgrades, and development setup.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the server, storage, and client fit together.
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md), [docs/plan/](docs/plan/), and [TODO.md](TODO.md): plan, API contracts, threat model, and tracker.

Built by [Pankaj Soni](https://github.com/pankajsoni19).
