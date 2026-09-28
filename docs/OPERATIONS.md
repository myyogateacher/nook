# Operating Nook

This guide is for whoever runs a Nook server: installation, configuration, storage, backups, and upgrades. For using the apps, see [USING.md](USING.md). The same material is published at [pankajsoni19.github.io/nook](https://pankajsoni19.github.io/nook/).

Internal identifiers keep the original `mynotes` prefix for compatibility with existing deployments: the `mynotes.sqlite` database, the `mynotes_session` cookie, the `mynotes` container name, the `MYNOTES_DATA_DIR` variable and its `/srv/mynotes` default, and the `mynotes-*.tar.gz` backup archives.

## Install

1. Clone the repository and copy `.env.example` to `.env` if you need to override the defaults.
2. Ensure `/srv/mynotes` exists and is writable by UID 1000, or set `MYNOTES_DATA_DIR` to another host directory.
3. Run `APP_VERSION=0.9.3 GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`.
4. Open `http://localhost:2026` and create the first account.

### Accounts

The first account can always be created from the login screen while the database is empty. Later registrations are disabled by default. To add people, an admin creates an invite link in **Team → Invites** (below); `ALLOW_REGISTRATION` can stay `false`. Setting it to `true` temporarily still works for trusted local users, but turn it off again. Set `ALLOWED_EMAILS` to a comma-separated allowlist; when present, only those addresses may register, sign in, or keep an existing session. "Everyone here" sharing includes all current and future registered users on that allowlist, except accounts with the guest team role.

### Invites instead of ALLOW_REGISTRATION

Admins add people with single-use invite links from **Team → Invites** (see [USING.md](USING.md#inviting-people)). Keep `ALLOW_REGISTRATION=false`: a valid invite bypasses only that switch. It fixes the team role (member, viewer, or guest), works once, lasts at most 7 days, and stops working when the admin who made it is no longer an active admin. `ALLOWED_EMAILS` still applies to invitees, and an invite bound to an address works only for that address. No environment change is needed.

The link carries its token in the URL fragment (`/register#invite=…`), which browsers never send to the server, so reverse-proxy access logs and `Referer` headers do not see it; the app removes it from the address bar on arrival. Treat a copied link like a password until it is used or expires, and revoke it if it went to the wrong place. Migration `018_team_invites` adds the table; back up before upgrading.

### Team admins and blocking

Every account has a team role: **admin**, **member**, **viewer** (reads what is shared with them or with everyone, changes nothing), or **guest** (reads only what is shared with them by name, never "Everyone here" items; no API keys). The first account created on an empty database is the admin. Accounts registered after it get `SIGNUP_ROLE`, which defaults to `guest`: a new account sees nothing until someone shares with it by name or an admin changes its role. Set `SIGNUP_ROLE=member` to keep the behaviour of earlier releases, or `viewer`; `admin` is refused at startup. When an existing install upgrades to the release with Team (migration 017), every account becomes a member and the **oldest enabled account becomes the admin**; change it with the command below if that is wrong. Admins manage roles, block and unblock accounts, and sign accounts out everywhere from the **Team** app. Nook always keeps at least one active admin: the last one cannot be demoted or blocked, in the app or in the database.

Blocking an account signs it out on every device at once and removes its push subscriptions. Its MCP keys and calendar feeds pause and resume when it is unblocked; its content stays where it is and stays shared as before. A blocked user who enters the right password is told the account is blocked; a wrong password still gets the usual error.

The host CLI is the way out of a lockout, for example when the only admin forgot their password or is no longer on `ALLOWED_EMAILS`. Each change is recorded in the Team activity log as made from the command line:

```sh
docker compose exec mynotes bun server/team-admin.ts list
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com admin
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com member
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com viewer
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com guest
docker compose exec mynotes bun server/team-admin.ts unblock user@example.com
```

A role change applies to the account's next request. `set-role` refuses to demote the last active admin; promote another account first.

**Upgrade note (migration 017).** On upgrade the oldest account becomes admin; fix with `docker compose exec mynotes bun server/team-admin.ts set-role <email> admin`. If every account was disabled when 017 ran, nobody is promoted and there is no active admin: the server logs a warning naming this command at every start until one exists. Unblock the account first (`docker compose exec mynotes bun server/team-admin.ts unblock <email>`), then run `set-role`. While there is no active admin and `ALLOW_REGISTRATION=true`, the next account registered becomes the admin (recorded in the Team activity log as a bootstrap), so keep registration off until the CLI has fixed it.

### Two-factor authentication

Generate a server-side encryption key and keep it only in `.env`:

```sh
openssl rand -base64 32
```

Set the output as `TOTP_ENCRYPTION_KEY`. Set `TOTP_POLICY=optional` to let each user choose, or `TOTP_POLICY=required` to force enrollment before notes can be accessed. Users enroll under **Settings → Security** by scanning the locally generated QR code with Google Authenticator and verifying one six-digit code. Sign-in uses the current six-digit number or one complete, one-time recovery code. TOTP secrets and recovery codes are encrypted in SQLite with AES-256-GCM; changing or losing the encryption key makes existing enrollments unusable.

If a user loses their authenticator, the local machine administrator can reset that factor. This revokes every session and forces fresh enrollment on the next password sign-in:

```sh
docker compose exec mynotes bun server/reset-totp.ts user@example.com
```

### LAN and Tailscale access

`APP_ORIGINS` is a comma-separated allowlist of exact browser origins. Keep localhost and add every trusted LAN or Tailscale HTTPS origin you use, including its port when non-standard:

```dotenv
APP_ORIGINS=http://localhost:2026,http://192.168.10.20:2026,https://your-device.your-tailnet.ts.net
```

Docker publishes port `2026` on all host interfaces for LAN access. Prefer Tailscale Serve or a TLS reverse proxy and keep `COOKIE_SECURE=true`. Direct plain-HTTP access such as `http://192.168.10.20:2026` requires `COOKIE_SECURE=false`; this is less safe for notes containing credentials, even on a trusted home network. Never use a wildcard origin.

### Email (Resend)

Nook can send email through [Resend](https://resend.com). Invites are the first use; the module (`server/mail.ts`) is generic so reminders and notifications can use it later. Email is **off** unless both variables are set; while it is off every "send" action says **Email is not configured** and the main action (creating the invite) still works.

1. Verify a sending domain in Resend and create an API key with sending access only.
2. In `.env`, set `RESEND_API_KEY` and `MAIL_FROM` (an address on that domain, or `Nook <nook@your-domain>`). Compose passes both through. Restart the container.
3. In the Resend dashboard, keep **click tracking off** for the domain. Tracked links would send the invite link through Resend's redirector. Nook's messages contain no images and no tracking of their own.

Limits: 5 messages an hour per recipient, 20 an hour per admin, 200 a day per instance, and a 10 second timeout per send. Logs show a hashed recipient and Resend's message id, never the address, subject, body, or key. A provider outage never blocks the main action; the admin can still copy the link. An invite email goes only to the address the invite is bound to.

## Configuration

Compose passes these variables from `.env` (see `.env.example`). Invalid values stop the server at startup with a message naming the variable.

| Variable | Default | Purpose and validation |
| --- | --- | --- |
| `MYNOTES_DATA_DIR` | `/srv/mynotes` | Host directory Compose mounts at `/data`. Must be writable by UID 1000. Used by Compose and `scripts/backup.sh`, not by the server. |
| `PORT` | `2026` | Port the server listens on inside the container. |
| `DATA_DIR` | `/data` | Data root inside the container. Leave unchanged under Compose. |
| `APP_ORIGIN` | `http://localhost:2026` | Primary browser origin; the fallback for `APP_ORIGINS`. |
| `APP_ORIGINS` | `APP_ORIGIN` | Comma-separated exact `http(s)` origins accepted for sign-in, mutations, and MCP host checks. Entries with a path, credentials, query, or fragment are rejected. |
| `COOKIE_SECURE` | `true` (Compose and production) | `true` or `false`. Plain-HTTP access needs `false`. |
| `ALLOW_REGISTRATION` | `false` | `true` allows additional accounts; the first account is always allowed on an empty database. Team invites work with `false` (see *Invites instead of ALLOW_REGISTRATION*). |
| `ALLOWED_EMAILS` | empty | Comma-separated allowlist for registration, sign-in, and existing sessions. Empty allows any address. |
| `SIGNUP_ROLE` | `guest` | Team role of accounts registered after the first: `guest`, `viewer`, or `member` (never `admin`). |
| `TOTP_POLICY` | `optional` | `optional` or `required`. |
| `TOTP_ENCRYPTION_KEY` | empty | Base64-encoded 32-byte key. Required when `TOTP_POLICY=required`. |
| `SESSION_DAYS` | `14` | Session lifetime in days, at least 1. |
| `MAX_MARKDOWN_BYTES` | `2000000` | Largest note body, at least 1024 bytes. |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | Largest single file. Integer from `1048576` (1 MiB) to `2147483648` (2 GiB). Bun's request body cap is this (or 2.1 MB, whichever is larger) plus 1 MiB; JSON bodies stay limited to 2.1 MB. |
| `USER_STORAGE_QUOTA_BYTES` | `10737418240` (10 GiB) | Document bytes per user, including documents in the Bin. Integer ≥ 0; `0` means unlimited. |
| `MIN_FREE_DISK_BYTES` | `1073741824` (1 GiB) | Uploads are refused when they would leave less free space than this on the data volume. Integer ≥ 0. |
| `PUSH_ENABLED` | `auto` | Web Push for calendar reminders: `auto` (on only when `APP_ORIGIN` is `https:`), `true`, or `false`. Browsers allow push only on a secure origin, so on `http://localhost` or a LAN address reminders appear in the bell and the notifications list only. |
| `PUSH_SUBJECT` | `APP_ORIGIN` | The VAPID contact push services may use: an `http(s)` URL or a `mailto:` address. |
| `PUSH_ENDPOINT_HOSTS` | empty | Extra push-service hosts, comma-separated (`push.example.com` or `*.push.example.com`), besides the built-in `*.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, and `*.notify.windows.com`. |
| `RESEND_API_KEY` | empty | Resend API key for outbound email (a single token without spaces). Email is on only when this and `MAIL_FROM` are both set. Never logged. |
| `MAIL_FROM` | empty | Sender, `nook@example.com` or `Nook <nook@example.com>`, on a domain verified in Resend. Anything else stops the server at startup. |
| `APP_VERSION` | `0.9.3` | Build metadata shown in Settings → About and reported by the MCP server. |
| `GIT_SHA` | `development` | Commit shown in Settings → About (first 40 characters). |

Fixed limits that are not configurable: 3 uploads in progress per user on the server (the app sends 2 at a time), 30-day Bin retention, 1 MiB text previews, 20 searches per 10 seconds per user, and an hourly sweeper.

## Storage

The container reads and writes `/data`, mapped by Compose to:

```text
/srv/mynotes
├── mynotes.sqlite (+ -wal, -shm)   metadata, accounts, sharing, version and search index
├── notes/<note-id>/
│   ├── current.md
│   ├── draft.md
│   └── versions/000001.md
├── documents/
│   ├── objects/<document-id>       uploaded file bytes, no extension
│   └── .staging/<document-id>.part uploads in progress (not backed up)
├── push/vapid.json                 Web Push signing keys (0600), created at first boot when push is on
└── backup/                         weekly archives (host backup script only)
```

Markdown files and documents are never exposed as static files; authenticated API handlers enforce access before reading them. File names live only in SQLite and are never used as paths. Uploads are streamed to `.staging` on the data volume (never to the container's small `/tmp`), and a sweeper removes abandoned staging files and orphaned objects at boot and hourly. A refused upload reports which limit applied. Notes and files in the Bin stay in place on disk until they are deleted forever.

The data directory is forced to mode `0700`; SQLite, WAL/SHM, and Markdown files use `0600`. The service refuses symlinked note directories and files.

**Single instance.** Only one Nook instance may use a data directory at a time: upload slots, per-document locks, rate limits, and the sweeper live in the process. Do not run a second container or a development server against the same directory.

**Web Push.** Pushes carry no content: a push only wakes the device, whose service worker then fetches unread notifications from Nook with the user's session, so push services see timing only. Outbound requests go only to allowlisted push-service hosts over https on port 443, never to IP literals or private addresses, with no redirects and a 5-second timeout. Each user may register 10 devices; a device is removed when the push service reports it gone (404 or 410) and paused after 5 failed deliveries. `push/vapid.json` is included in backups. If it is lost, a new key pair is created at the next boot and each device must enable push again in Settings → Notifications.

**EXIF and embedded metadata.** Nook stores uploaded files byte for byte and does not strip EXIF or other embedded metadata (for example GPS location or author) from images or PDFs. Tell users to remove it before uploading files they plan to share.

## Backup and restore

Run the host-side backup script once a week:

```sh
./scripts/backup.sh
```

It briefly stops a running app container so the SQLite database, Markdown files, and documents are captured at the same point in time, writes a verified gzip archive under `/srv/mynotes/backup` (or your configured data directory), keeps the newest five archives, and starts the app again. A second run within seven days is skipped; use `./scripts/backup.sh --force` only when you intentionally want an extra snapshot.

For unattended weekly execution, add this entry with `crontab -e` (Sunday at 03:00):

```cron
0 3 * * 0 cd /path/to/nook && ./scripts/backup.sh >> /srv/mynotes/backup/backup.log 2>&1
```

To restore, stop Nook, extract an archive into an empty data directory, point `MYNOTES_DATA_DIR` at that directory if it differs from the default, and start the service:

```sh
mkdir -p /srv/mynotes-restored
tar -xzf /srv/mynotes/backup/mynotes-YYYYMMDDTHHMMSSZ.tar.gz \
  -C /srv/mynotes-restored
MYNOTES_DATA_DIR=/srv/mynotes-restored docker compose up -d --build
```

The archive contains the data directory contents at its root, so no path rearrangement is required. Keep the same `.env` (in particular `TOTP_ENCRYPTION_KEY`) when starting the restored copy, and start only one instance per data directory.

- Archives include `documents/objects` but not `documents/.staging`. Archive size and the time the app is stopped grow with the stored files (gzip gains little on already-compressed media), and five archives multiply that disk use.
- Items in the Bin are included like live ones. A note or file deleted forever (or expired from the Bin) can survive in older archives for up to about five weeks, until those archives rotate out.
- The backup intentionally does not include `.env`. Store it securely alongside your backups, especially `TOTP_ENCRYPTION_KEY`, which is required to use restored TOTP enrollments.

## Upgrades

```sh
./scripts/backup.sh --force
git pull --ff-only
APP_VERSION=<release> GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps
curl http://localhost:2026/api/health
```

Every image carries immutable numbered migrations under `server/migrations`. They run transactionally and are recorded in SQLite's `schema_migrations` table before the HTTP server accepts requests. New schema changes are always added as a new migration; released migrations are never edited.

**Upgrading to 0.9.3:** no migration; no backup needed beyond your usual schedule. Pull, rebuild with `APP_VERSION=0.9.3`, and restart as above.

**Upgrading to 0.9.2:** no migration; no backup needed beyond your usual schedule. Pull, rebuild with `APP_VERSION=0.9.2`, and restart as above. Sprint defaults are saved in the board's existing structure settings; if you roll back to an older build, a board saved with sprint defaults shows as **Flat** there until you upgrade again.

**Upgrading to 0.9.1:** no migration; no backup needed beyond your usual schedule. Pull, rebuild with `APP_VERSION=0.9.1`, and restart as above.

**Upgrading to 0.9.0:** back up first (`./scripts/backup.sh --force`, as above). Migration 019 (task hierarchy and sprints: card parents and levels, board structures, and the sprint table) runs once on the first boot, before the server accepts requests, and cannot be undone except by restoring that backup. It backfills nothing: every existing board stays flat and every existing card stays a top-level card, so boards look the same until an owner picks a structure. This release also adds `SIGNUP_ROLE`: accounts registered from now on get the **guest** role by default (they read only what is shared with them by name, and cannot create API keys). To keep the earlier behaviour, set `SIGNUP_ROLE=member` in `.env` before starting the new image; `viewer` is also accepted and `admin` is refused at startup. Existing accounts keep their roles. Viewer and guest accounts are read-only on the server for every app and MCP key (see [Team admins and blocking](#team-admins-and-blocking)).

**Upgrading to 0.8.1:** back up first (`./scripts/backup.sh --force`, as above). Migration 020 (board column states and saved task views) runs once on the first boot, before the server accepts requests, and cannot be undone except by restoring that backup. It gives every board column a workflow state: done columns become done, each board's first column becomes to-do, and the rest become in progress.

**Upgrading to 0.8.0:** back up first (`./scripts/backup.sh --force`, as above). Migrations 015 (task card due times, assignees, WIP limits, tags, flags, and relations), 016 (per-account preferences for Settings → Modules), and 017 (team roles and blocking) run once on the first boot, before the server accepts requests, and cannot be undone except by restoring that backup. Migration 017 makes the **oldest enabled account the admin** and everyone else a member; if that is wrong, fix it with `docker compose exec mynotes bun server/team-admin.ts set-role <email> admin`, and keep `ALLOW_REGISTRATION=false` until an active admin exists (see [Team admins and blocking](#team-admins-and-blocking)).

**Upgrading to 0.5.0:** migration 008 adds the search index tables, and the first boot fills them from the notes on disk before the server accepts requests, logging only counts (`Search index: N indexed, …`). Later boots only repair rows that are missing or stale. The index stores a plain-text copy of each note's published version and draft inside `mynotes.sqlite`, so it lives on the same disk and in the same backups as the notes themselves.

**Upgrading from 0.3.0 or earlier:** notes deleted before this version (which the old interface described as permanent) reappear in the Bin for 30 days after the upgrade, then are deleted automatically. Never-published notes deleted before the upgrade are removed on the first sweep. Empty the Bin, or delete those items forever, if you do not want to keep them for that window.

## Development

Development runs on the host with Bun (Compose only defines the production `app` service):

```sh
bun install
DATA_DIR=./data APP_ORIGIN=http://localhost:5173 COOKIE_SECURE=false ALLOW_REGISTRATION=true bun run dev
bun run dev:client
```

`bun run dev` serves the API on port `2026` (stop the Docker container first, since it uses the same port) and restarts on changes. `bun run dev:client` starts Vite at `http://localhost:5173` and proxies `/api` to it. `./data` is ignored by Git. Run `bun run typecheck` and `bun test` before committing.
