# Nook

**A private, self-hosted workspace for a household or a small trusted team: notes, files, tasks, calendars, forms, time, goals, contacts, bookings, reports, and AI chat in one Docker container.**

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

- **Boards** with drag and drop, columns with To do / In progress / Done states, **WIP limits**, and a short **board code**: every card gets a key like `WEB-12` and a short link (`/tasks/WEB-12`) that keeps working after a rename or a move.
- **Cards** with start and due dates (with optional times), multiple assignees, colour **tags**, a **priority** (urgent, high, medium, low), **flags** (blocked, needs review, on hold), **estimates** in points or hours, **relations** (depends on, relates to, duplicates), comments with reactions and @mentions, attachments, and an **activity history** of every change. Cards move between boards.
- **Views**: columns, a sortable table, a grouped list, a calendar with drag-to-reschedule, and a **Timeline** (Gantt) with drag-to-reschedule bars. A filter bar keeps its state in the URL; lanes can be grouped by assignee, tag, or sprint; a board's owner can pin views for everyone.
- **Hierarchy and sprints**: Task › Subtask, Epic › Story › Subtask, or your own level names; plan, start, and complete sprints with carry-over.
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

### Whiteboards

Sketches, diagrams, and floor plans with the Excalidraw editor, saved as `.excalidraw` files in your Files folders. Boards save as you draw (a conflict between two devices never overwrites silently), work offline for a moment, pinch-zoom on phones, export PNG and SVG, and share view-only through the same Access sheet as files. Place pictures from Files (or upload, drop, or paste them; they are stored as files and shown only to people who can open them), link shapes to notes, files, cards, boards, and events, restore earlier versions from History, duplicate boards, import `.excalidraw` files, show a board as a card in a note, and find boards by their text in search. The editor loads only when you open a board and makes no requests outside your Nook.

### Workspace modules

Seven modules built on shared foundations (people, links between items, comments, activity, schedules, and public pages), each with its own sections in the sidebar, search, MCP tools, and Bin support:

- **Forms & Polls**: every question type, logic, quick polls with live results, find-a-time polls that create an event, results with charts and CSV, and public forms.
- **Time**: a one-click timer in the sidebar and on cards, manual entries, a keyboard timesheet with weekly approval, projects with rates and budgets, and reports.
- **Goals**: company, team, and personal OKRs whose key results update from tasks, time, deals, forms, and standups, with check-ins and tree, list, and timeline views.
- **Standups**: standup, retro, and pulse templates on schedules in each person's time zone, with a feed and insights.
- **Contacts**: people, companies, and deals on pipelines with a drag board, CSV import with duplicate merge, interactions, and follow-ups.
- **Bookings**: booking types, availability, busy time from your calendars, and public booking pages with confirmation mail.
- **Townhall**: named or anonymous Q&A with upvotes and moderation, live polls, word clouds, a presenter view, and a public audience link.

They connect: standup answers update goals, form responses can create deals, finished tasks log on contacts, and time shows on goals, deals, and bookings. Public pages (`/p/…`) are on by default and each can be turned off by an admin.

<p align="center">
  <img src="docs/images/goals-dark.png" alt="Goals with key results and check-ins" width="49%" />
  <img src="docs/images/contacts-deals-dark.png" alt="Contacts deals on a pipeline board" width="49%" />
</p>

### Reports

Analytics reports over **ClickHouse**: an admin adds a data source with an allowlist of tables, and the AI writes SQL and charts from your docs (notes, files, PDFs, or docs behind a tool server), checking its numbers by running queries. Every query is a single guarded read-only `SELECT`; reports have filters, saved views, refresh schedules, versions, folders, and sharing. A **This workspace** source reports on Nook's own modules, computed with each reader's access.

### Chat and AI

- **Chat** with **agents** you make in Settings → Agents (a prompt, a model, and a step limit) on **model providers an admin configures** (OpenAI-compatible, Anthropic, or Voyage AI). Replies render Markdown and images; you can attach pictures for vision models. Every message goes to that provider.
- **Tools**: agents can use Nook itself and outside MCP tool servers, with an audit log.
- **Knowledge bases**: notes and files indexed with embeddings from a provider or a local model, for agents to search.
- **Inbox and routines**: changes agents propose (drafts, cards, time, goal check-ins) wait in the Inbox for your approval, and routines run agents on a schedule.

### Vault

Team secrets per environment (dev, staging, prod, or your own): values, logins, and notes with encrypted comments, a secrets × environments grid on a computer and one environment's cards on a phone, reveal that hides again after 30 seconds, copy that clears the clipboard, a password generator, 20 versions per value, and the Bin. Vaults are shared with people or groups at a level per environment; **protected** environments (prod) ask you to confirm it's you before revealing. Vault keys give scripts, CI, and AI clients access to chosen vaults and environments. **Encrypted at rest; anyone with the server and its key can read every secret**, so it is for your services' credentials, not a personal password manager. Off until `VAULT_ENCRYPTION_KEY` is set; see [docs/OPERATIONS.md](docs/OPERATIONS.md#vault).

### Team

- Roles: **admin**, **member**, **viewer** (reads what is shared with them or with everyone, changes nothing), and **guest** (reads only what is shared with them by name). Read-only roles are enforced on the server, not just hidden in the app.
- Admins block and unblock accounts, sign them out everywhere, and see activity. Admins never see anyone's private content.
- New accounts get `SIGNUP_ROLE` (default `guest`). A host CLI (`server/team-admin.ts`) recovers from a lockout.
- **Sign in with Google** (optional): `AUTH_METHODS=password|google|both` chooses the methods, enforced on the server. Google accounts are created automatically when registration would allow it (the first account, an invite, or open registration), `GOOGLE_ALLOWED_DOMAINS` limits them to your company domains, two-factor still applies, and Google profile pictures replace the letter avatars (downloaded and served by Nook itself). Setup: [docs/OPERATIONS.md](docs/OPERATIONS.md#google-sign-in).
- **Behind a reverse proxy or Tailscale Serve**, set `TRUSTED_PROXY_HOPS=1` (and `TRUSTED_PROXY_ADDRESSES` to the proxy's own address, so nobody reaching the port directly can choose an address) so rate limits count each visitor separately (see [docs/OPERATIONS.md](docs/OPERATIONS.md#rate-limits-and-reverse-proxies)).
- **Central access**: Team → a member → **Access** shows everything a person can open, per module and through what (direct, a group, or everyone), with titles hidden for items the admin cannot open. Admins can only take access away (remove, lower, leave a group, revoke keys, or **Reset access**), each confirmed, logged in **Team → Access activity**, and announced on the owner's bell. **Team → Templates** gives invites a role and groups. Everyone but guests sees their own in **Settings → My access**.

### Everywhere

- **Sidebar and ⌘K**: one collapsible sidebar on every app with each app's sections, folder trees, pinning, and a layout that follows you across devices; **⌘K** (Ctrl+K) searches every app as you type and runs commands, and **?** shows the shortcuts.
- **@mentions** in comments, descriptions, notes, and answers notify the people who can read the item, on the bell, by push, and by email.
- **Attachments everywhere**: events, cards, comments, rows, notes, whiteboards, and chat take files (Take photo on phones, Choose files, or From Files); they live in your private **Files › Attachments** folder, photo locations are removed, and removing one offers Undo.
- **Friendly URLs**: boards, cards, notes, files, whiteboards, collections, and reports have short, readable links; sensitive items keep opaque ones.
- **Shared Bin**: deleted items from every app wait 30 days with their history and sharing, with Undo right after a delete and **Settings → Bin** for the rest.
- **Settings → Modules**: turn apps on or off for your account on every device. Nothing is deleted and sharing is unchanged.
- **Mobile first**: every app, item, and view has its own URL, phones get focused single-column screens, and browser Back and Forward work everywhere (Back closes an open dialog or sheet first).
- **MCP server and REST API**: Streamable HTTP for trusted AI clients and `/api/v1` for scripts, with revocable keys scoped per module and down to chosen items and IP addresses. Agents write drafts and proposals; publishing stays with you.
- **Storage**: files on local disk or in an S3-compatible bucket (`STORAGE_BACKEND=s3`), with per-file limits, per-user quotas, and a free-disk floor.

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
- Online backups while Nook runs (a consistent SQLite snapshot and the data directory, checked by SHA-256, including S3-stored files), kept on disk or in S3, optional Litestream point-in-time replication, one-command restore, and restore drills (Settings → Backups).
- Confirming it's you (password, Google, or two-factor) before sensitive actions such as API keys, protected vault values, and two-factor changes.

Nook is designed for one host on a trusted network. Prefer HTTPS through Tailscale Serve or a reverse proxy.

## Quick start

You need Git, Docker Engine, and Docker Compose.

```sh
git clone https://github.com/pankajsoni19/nook.git && cd nook
cp .env.example .env            # set ALLOWED_EMAILS, TOTP_POLICY, APP_ORIGINS as needed
sudo mkdir -p /srv/mynotes && sudo chown 1000:1000 /srv/mynotes   # or set MYNOTES_DATA_DIR
APP_VERSION=0.48.1 GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
curl http://localhost:2026/api/health   # then open http://localhost:2026 and create the first account (the admin)
```

Later registrations stay disabled unless you set `ALLOW_REGISTRATION=true`. `APP_NAME=Acme Notes` renames the app in titles, link previews, the installed app, and mail. Every environment variable (email, push, limits) is listed in [docs/OPERATIONS.md](docs/OPERATIONS.md#configuration). Internal identifiers such as `mynotes.sqlite`, the `mynotes` container, `MYNOTES_DATA_DIR`, and the `mynotes-*` backup archives keep the original prefix for compatibility.

## Upgrading

Back up first (`./scripts/backup.sh --force`), pull, rebuild, and let migrations run on the first boot. Release-specific steps are in [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## What's new

Release notes for every version are in [CHANGELOG.md](CHANGELOG.md) and on the [docs site](https://pankajsoni19.github.io/nook/releases.html). Latest (v0.48.1, a fix release on v0.48.0):

- **Seven new workspace modules**: Forms & Polls, Time, Goals, Standups, Contacts, Bookings and Townhall, wired together and into Reports.
- **A left sidebar on every app** with sections, folders, pinning, ⌘K search across every app, and @mentions with notifications.
- **Tasks**: card keys and short links, moving cards between boards, start dates, estimates, priority, activity history and a Timeline view. 32 migrations; back up first.

## Documentation

- [Documentation site](https://pankajsoni19.github.io/nook/): every app, configuration, security, backups, and upgrades.
- [docs/USING.md](docs/USING.md): the user guide for every app and module, the sidebar, the Bin, Team, Chat, and MCP keys.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): configuration reference, storage, backup and restore, upgrades, and development setup.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the server, storage, and client fit together.
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md), [docs/plan/](docs/plan/), and [TODO.md](TODO.md): plan, API contracts, threat model, and tracker.

Built by [Pankaj Soni](https://github.com/pankajsoni19).
