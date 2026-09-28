# Architecture

This document describes how Nook (formerly MyNotes) is built. For using the apps see [USING.md](USING.md); for running a server see [OPERATIONS.md](OPERATIONS.md). Internal identifiers keep the original `mynotes` prefix for compatibility with existing deployments and browsers: the `mynotes.sqlite` database, the `mynotes_session` cookie, the `mynotes` container, `MYNOTES_DATA_DIR` and its `/srv/mynotes` default, `mynotes:*` localStorage keys, `mynotes.*` history-state keys, `application/x-mynotes-*` drag types, the `mynotes_` API key prefix, and the `mynotes-*` backup archives.

## Runtime

One Bun process runs a Hono app that serves the built React SPA, the `/api` JSON API, document uploads and content, and the `/mcp` endpoint. SQLite uses WAL mode. All note content is read and written through a storage service that validates UUIDs, uses fixed derived paths, and performs atomic file replacement. Uploaded documents use a second, UUID-only store beside the notes (see [Documents](#documents)).

Upload slots, per-resource locks (`withResourceLock`, keyed `note:<id>` and `document:<id>`), the auth rate limiter, and the sweeper all live in process memory, so exactly one instance may use a data directory.

Request bodies are bounded in two layers. Bun's `maxRequestBodySize` is `max(MAX_UPLOAD_BYTES, 2_100_000) + 1 MiB`, which admits uploads. JSON and MCP bodies are read through `readBoundedBody`, which aborts with 413 as soon as more than 2.1 MB arrive, whether or not a `Content-Length` was sent.

## Identity and authorization

Passwords use Bun's asynchronous Argon2id implementation. A random opaque session token is stored only as a SHA-256 hash in SQLite and sent in an `HttpOnly`, `SameSite=Strict` cookie. Mutations require a same-origin request, JSON content type, and an authenticated session.

TOTP two-factor authentication is compatible with Google Authenticator (`SHA-1`, 6 digits, 30-second period). Secrets and revealable one-time recovery codes are encrypted at rest with AES-256-GCM using purpose-separated authenticated encryption and a key supplied outside the database through `.env`. Recovery-code viewing or regeneration requires password plus a fresh TOTP code. Accepted counters and recovery-code consumption are atomically persisted so credentials cannot be replayed. When TOTP is required, authenticated users without an enrolled factor can access only enrollment, session-status, and logout endpoints. Enabling or disabling a factor revokes every other session.

Database changes live in ordered files under `server/migrations`. Startup runs each pending migration in a SQLite transaction and records it in `schema_migrations` before routes are served. Released migrations are append-only:

| Id | Name | Adds |
| --- | --- | --- |
| 001 | `initial` | users, sessions, folders, folder and note shares, notes with visibility, note versions, audit log |
| 002 | `folder-sharing-and-defaults` | folder visibility, one Default folder per user, note `sharing_override` |
| 003 | `totp` | encrypted TOTP secrets and accepted-counter tracking |
| 004 | `totp-recovery-codes` | encrypted one-time recovery codes |
| 005 | `mcp-api-keys` | hashed MCP API keys with prefix, name, and revocation |
| 006 | `documents` | `documents` and `document_shares`, Bin columns on documents, per-owner `upload_key` for idempotency |
| 007 | `bin` | `deleted_by`, `purge_after`, `purge_started_at` on notes and Bin indexes; backfills previously soft-deleted notes (published ones get 30 days from the upgrade, never-published ones are due at once) |
| 008 | `note_search` | `note_search_rows` and the `note_fts` FTS5 table with its cascade trigger (backfilled at boot) |
| 009 | `task_boards` | boards, members, columns, cards, comments, card attachments, and `documents.purpose` |
| 010 | `mcp_key_scopes` | `mcp_api_keys.scopes` (JSON; existing keys read `["notes:read"]`) and `notes.draft_mcp_key_id` |
| 011 | `task_dates` | `cards.due_on`, `cards.assignee_id`, and `board_columns.is_done` (backfilled for Done columns), with their indexes |
| 012 | `collections` | collections, members, rows (values JSON, revision, one-step undo), saved views, row attachment links, and the row search mapping and FTS tables (see [Collections](#collections)) |
| 013 | `calendar` | calendars, members, events (local time plus IANA zone, or dates; JSON recurrence), event links, reminders, notifications, push subscriptions, and feed tokens (see [Calendar](#calendar)) |
| 014 | `event_next_occurrence` | a cheap "anything in this range?" bound per event for the calendar range API |
| 017 | `team_roles` | `users.role` (admin, member, viewer, guest), `blocked_by`, `block_reason`, the append-only `team_events` log, and the last-active-admin triggers; backfills the oldest enabled account as admin (see [Team](#team)). Ids 015 and 016 are reserved for Wave 13. |
| 018 | `team_invites` | single-use invite links: the token's SHA-256 and a 6-character prefix, an optional email binding (`COLLATE NOCASE`), a role CHECKed to member, viewer, or guest, an expiry of at most 7 days, and `used_*` / `revoked_*`; applied after 019 and 020 on existing installs (see [Team](#team)). |
| 022 | `reactions` | the generic `reactions` table (kind, target, user, emoji key), its per-user index, and the cleanup trigger on `card_comments` (Wave 20; see Tasks) |

Notes and documents share one folder tree and one access rule. An item is readable when it is live (`deleted_at IS NULL`) and one of these holds:

1. the caller owns it;
2. it has its own sharing (`sharing_override = 1`) and its visibility is `all_users`, or a note/document share row names the caller; or
3. it inherits (`sharing_override = 0`) and its **immediate** folder is `all_users` or shared with the caller. Folder sharing does not cascade to subfolders.

Every account has a platform **team role** on `users.role` (migration 017, [Team](#team)). `requireAuth` reads it with the session on every request (no cache) and puts it on `c.get("user")`. In Wave 14 only admins differ: they manage the team. A role never grants access to content; the rules below are unchanged for every role.

Only owners may edit, publish, restore, move, rename, delete, purge, or change sharing; recipients are read-only. Uploads and moves must target a folder the caller owns. Missing, forbidden, and binned items all answer 404. Recipients never see a shared folder's parent, and a document's `folder_id` is masked for them unless that folder is itself visible. The predicate lives in `server/access.ts` (notes), `server/documentAccess.ts` (documents), the `GET /api/notes` query, and `server/mcpTools.ts`.

## Draft and version state machine

```text
published ── first edit ──> draft ── publish ──> published (new immutable version)
    ^                         │
    └──── discard draft ─────┘

historical version ── restore ──> draft (never rewrites history)
```

`current.md` is a convenience mirror of the newest published version; authenticated reads use the immutable version file indexed by SQLite. `draft.md` exists only while a draft is active. All note mutations are serialized by note ID. Publishing writes the next version with exclusive-create semantics, commits version metadata with compare-and-swap state checks, then refreshes `current.md` and removes the draft. A retry can safely reuse an identical staged snapshot after interruption.

Deleting a note that was never published and whose draft is blank purges it at once. Any other deleted note, and every deleted document, goes to the Bin.

<a id="documents"></a>
## Documents

### Storage

```text
<DATA_DIR>/documents/
├── objects/<document-id>          committed bytes, 0600, no extension
└── .staging/<document-id>.part    in-flight uploads, 0600
```

The user's filename lives only in SQLite (`documents.name`), after sanitising: NFC normalisation, removal of control, bidi, and zero-width characters, trimming of edge dots and spaces, and a 255-byte limit that keeps a short extension. Paths are built only from server-generated UUIDs, confined to `DATA_DIR`, and opened with `O_NOFOLLOW`; staging files are created with `O_EXCL`. Rename and move change metadata only. Duplicate names in a folder are allowed.

### Upload pipeline

`POST /api/files?folderId=<uuid>` is the only route that accepts `multipart/form-data`; it still needs the allowed `Origin` and the `X-CSRF-Token` header.

1. Check that the target folder is owned by the caller (Default when omitted).
2. With an `Idempotency-Key` (a UUID, scoped per owner), a stored upload with the same key is replayed as 200 `idempotentReplay`; if that document is now in the Bin the answer is 409 `IDEMPOTENCY_KEY_USED`.
3. A declared `Content-Length` above `MAX_UPLOAD_BYTES` + 64 KiB is refused with 413 before reading. Chunked bodies without a length are accepted and bounded while streaming.
4. Take one of 3 per-user upload slots (429 otherwise), reserve the expected size against `USER_STORAGE_QUOTA_BYTES` (live plus binned bytes plus other in-flight reservations; 507 `QUOTA_EXCEEDED`), and check `statfs` free space against `MIN_FREE_DISK_BYTES` (507 `DISK_FULL`).
5. Stream the body through busboy into `.staging/<id>.part`, hashing with SHA-256 and keeping only the first 4100 bytes in memory. Limits: exactly one file part named `file`, no fields, at most 20 header pairs. Busboy's `parts` limit is 2 and its `fileSize` limit is `MAX_UPLOAD_BYTES + 1`, because busboy flags a part that *reaches* either limit; reaching them is treated as an extra part or an oversized file (400 or 413). Writes are awaited, so the socket is read only as fast as the disk accepts data.
6. Sniff the type, fsync, rename into `objects/`, and fsync both directories.
7. In one transaction, re-check idempotency, folder ownership, and the quota, then insert the row and audit `document.upload` (size and type, never the name). A failure removes the object; staging is discarded in `finally`.

### MIME sniffing and previews

`server/mimeSniff.ts` classifies from magic bytes only; the client's declared type is never an input.

| `preview_kind` | Detected from | Stored `mime_type` |
| --- | --- | --- |
| `image` | PNG, JPEG, GIF, WebP signatures | `image/png`, `image/jpeg`, `image/gif`, `image/webp` |
| `pdf` | `%PDF-` | `application/pdf` |
| `audio` | ID3, MPEG frame with `.mp3`, `OggS`, RIFF/WAVE, `ftyp` brand `M4A ` | `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/mp4` |
| `video` | `ftyp` MP4 brands, EBML with `webm` | `video/mp4`, `video/webm` |
| `text` | extension `.txt .md .markdown .csv .tsv .log .json` **and** valid UTF-8 with no NUL in the sample | `text/plain; charset=utf-8` |
| `none` | anything else, including SVG, HTML, XML, scripts, Office files, archives | `application/octet-stream` |

The UI renders images in `<img>`, opens PDFs in a new top-level tab (never framed), reads text with `Range: bytes=0-1048575` into a `<pre>` as React text nodes, and uses native audio/video players. `none` is download-only. Rename never changes the kind.

### Content responses

`GET` and `HEAD /api/files/:id/content?disposition=inline|attachment` (default `attachment`) is readable by any reader of the document. Inline is honoured only when `preview_kind ≠ none`; otherwise the response is `application/octet-stream` with `attachment`. `Content-Disposition` carries an ASCII fallback with CR, LF, quotes, backslashes, and controls stripped, plus a percent-encoded UTF-8 `filename*`.

The global `secureHeaders` middleware is skipped for exactly this route, which sets its own headers on every response, including errors from earlier middleware: `Content-Security-Policy: default-src 'none'; sandbox` (inline PDF gets `default-src 'none'; frame-ancestors 'none'` so browsers can render it), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: private, no-store`. The strong `ETag` is the SHA-256.

A single `bytes` range (`a-b`, `a-`, `-n`) returns 206 with `Content-Range`; multiple ranges, other units, and malformed values return the full 200; an unsatisfiable range returns 416 with `bytes */size`; an `If-Range` that is not the current ETag returns 200. The object is opened with `O_NOFOLLOW` and its size checked with `fstat` (500 on an integrity failure, logging only the error class and id); the body streams from the file handle, which closes on end, error, or client abort. Streamed bodies are sent chunked. Downloads are not audited.

## Bin

Deleting moves a note or document to the owner's Bin: `deleted_at`, `deleted_by`, and `purge_after = deleted_at + 30 days` are set. Files, versions, and share rows are kept, and every read path (lists, content, versions, sharing, MCP) requires `deleted_at IS NULL`. Retention is a constant (`BIN_RETENTION_MS`).

```text
live ── delete ──> binned ── restore (CAS, no purge started) ──> live
                     │
                     ├── delete forever / Empty Bin / purge_after passed
                     v
                 tombstoned (purge_started_at set: unreadable, unrestorable)
                     │  remove bytes (ENOENT = success; any other error → stays here)
                     v
                 row deleted (cascades versions and shares), audited `<type>.purge`
```

Every step runs under the item's resource lock and is idempotent. Restore is a compare-and-swap that refuses rows with `purge_started_at` set (409 `PURGING`) and returns the item to its original folder if the owner still has it, otherwise to the owner's Default folder, reporting the new effective visibility. Purge audit reasons are `user`, `blank`, `retention`, or `resumed` (a purge the sweeper finished after an interruption; the original reason is not stored).

### Sweeper

`server/sweeper.ts` runs once at boot (without delaying startup) and hourly; overlapping calls share the run in flight.

1. Remove staging files older than one hour, and at boot every staging file older than the process.
2. Remove files in `objects/` older than one hour that have no `documents` row in any state. At boot, also log how many stored documents are missing or have the wrong size.
3. Per table (notes, documents): resume up to 50 tombstoned purges, then purge up to 100 items whose `purge_after` has passed, re-checking retention under the lock so an item restored and deleted again mid-run survives. The two budgets are separate, so repeatedly failing tombstones never starve due items; the rest waits for the next run.

Bin purges run even when the file sweep fails. Logs carry counts only.

- **Notifications (Wave 12):** calendar notifications and fired standalone reminders older than 30 days are removed (`sweepNotifications`).
- **Task attachments never linked (Wave 9 review fix):** uploads with `purpose = 'task_attachment'` that have no `card_attachments` row after 24 hours are moved to the uploader's Bin, 100 per run, audited with reason `attachment_never_linked` and no actor.

## Search

Full-text search over notes (WAVES_7-9.md §2) uses an SQLite FTS5 table that stores its text, so `snippet()` and `highlight()` work (migration 008):

- `note_search_rows`: one row per `(note_id, kind)`, `kind` being `published` or `draft`, with the `source_checksum` of the text it was built from. `ON DELETE CASCADE` from `notes`.
- `note_fts(title, body)`: rowid = `note_search_rows.id`, tokenizer `unicode61 remove_diacritics 2` (case- and accent-folding) with prefix indexes of 2 and 3 characters. An `AFTER DELETE` trigger on `note_search_rows` removes the FTS row, so purging a note clears its index through the cascade.

**Text.** `server/search.ts` holds the pure helpers. `searchText()` projects Markdown to plain text: headings, paragraphs, link text, image alt text, table cells, and code are kept; URLs, HTML tags, and markup are dropped, as are control characters (the highlight markers are C0 controls). The title line is kept out of the body so snippets do not repeat it.

**Sync.** `server/searchIndex.ts` writes inside the same transaction as the notes change: a draft save indexes the draft (an empty one is unindexed), publish indexes the new version and removes the draft row, discarding a draft removes it, and restoring a version indexes the restored draft. The Bin changes nothing (search filters on `deleted_at`), and purge cascades. Index text always comes from `draft.md` or the version file after its checksum was verified, never from the `current.md` mirror.

**Reconcile.** At boot, after the mirror reconcile, `reconcileSearchIndex()` removes orphan FTS and mapping rows and rows whose source is gone, then reindexes every published version and draft whose row is missing or whose `source_checksum` differs from the database checksum (under the note lock), and finally runs FTS `optimize`. A file that fails its checksum is left out and counted as unreadable. Logs carry counts only. Changing `searchText()` does not trigger a rebuild by itself; delete the rows (`DELETE FROM note_search_rows`) to force one on the next boot.

**Query.** `buildFtsQuery()` never passes user input through as FTS syntax: it applies NFKC and lowercase, keeps up to 4 quoted phrases, splits the rest into up to 8 words of 2–64 letters, numbers, or combining marks, quotes each one, and joins them with spaces (implicit AND). The last word gets a prefix `*` unless the query ends in a space or punctuation. Combining marks count as word characters so Indic scripts are not split at vowel signs.

**API.** `GET /api/search` (`server/searchRoutes.ts`) joins `note_fts MATCH` to `notes` and applies the live access rule before `LIMIT`: the draft row only for its owner, and the published row only when `current_version > 0`, the caller is not the owner with a draft (who gets the draft, as `GET /api/notes/:id` does), and `readableNotePredicate` from `server/access.ts` holds. Binned notes never match. Results are ordered by `bm25(note_fts, 8.0, 1.0)` then `updated_at`, `folder_id` is masked as in `GET /api/notes`, highlights return as `{text, hit}` segments (never HTML), and scores are never returned. A per-user in-memory limiter allows 20 searches per 10 seconds. BM25 statistics are computed across every user's rows; only the order they produce is exposed.

**UI.** `src/search/` provides `useNoteSearch` (300 ms debounce, starts at 2 characters, aborts the previous request, re-runs only when notes are added, removed, or moved, not on autosave refreshes, and keeps results on screen meanwhile) and `SearchResults` (a listbox driven from the search input with `aria-activedescendant`). While a request is in flight or failed, the note list falls back to the instant title filter.

## Task Boards

Kanban boards (WAVES_7-9.md §3 with the director's §7 review), migration 009: `boards`, `board_members`, `board_columns`, `cards`, `card_comments`, `card_attachments`, and `documents.purpose` (`file`, `task_attachment`, `collection_attachment`). Code lives in `server/tasks/`:

- `access.ts`: `readableBoardPredicate` (owner, `all_users`, or a member row on a `selected` board; never a binned board) and the readable column and card lookups that join every id to its board.
- `service.ts`: boards, sharing, columns, and cards. `routes.ts` is a thin JSON adapter, so Wave 8 MCP tools can call the same functions.
- `boardOrder.ts`: pure ordering. The server computes `position REAL` from an anchor: the neighbours' midpoint, last + 1024 at the bottom, or half the first at the top, and renumbers the column (or the column list) to 1024, 2048, … when a gap would drop below 1e-6. Clients never send positions.
- `comments.ts`, `attachments.ts`, `bin.ts`: comments, attachment links, and the Bin adapters.
- Reactions (Wave 20, migration 022) live in `server/reactions/`: one generic `reactions` table keyed by `(target_kind, target_id, user_id, emoji)`, a code-level kind registry (`targets.ts`, v1 `card_comment`; a later module registers its own kind and cleanup trigger), the service with aggregates and the 60-a-minute limit, and the routes. The 12 emoji keys are in `shared/reactions.ts`. `comments.ts` embeds the aggregates in every comment payload.

**Roles (D38, D39).** Readers of a board create, edit, move, comment on, and bin cards and attach their own files. The owner alone renames the board, manages columns and sharing, deletes it, and purges. Non-readers get 404; readers calling an owner-only action get 403 `OWNER_ONLY`.

**Concurrency.** Every write to a board runs under `withResourceLock("board:<id>")` and re-checks access inside the lock. Card edits compare-and-swap on `revision` (409 `CARD_CHANGED` returns the current card); moves take an `afterCardId` that must be a live card in the target column, or 409 `STALE_POSITION` returns that column's order.

**Attachments.** An attachment is a document uploaded with `POST /api/files?purpose=task_attachment`: owned by the uploader, `folder_id = NULL`, never listed in Files, counted in the quota. Linking needs a live attachment the caller owns (and, for a comment, the caller's own comment). `readableDocument` and `readableDocumentSummary` also admit readers of a board whose live card links the live document; lists never do. When a document loses its last link (unlink, comment delete, card or board purge) it moves to its uploader's Bin with `deleted_by` = the actor. Restoring such a document turns it into a Files item in the owner's folder or Default.

**Bin (D41).** Deleting a card or board sets its Bin columns. A binned board is listed for its owner; a binned card for the board owner and for its deleter while they can still open the board. Restore is a compare-and-swap under the board lock: a card returns to the bottom of its column, or of the first column when that is gone, and a card on a binned board is refused with 409 `BOARD_IN_BIN`. Purge (owner, Empty Bin, or the sweeper after 30 days) tombstones and deletes the row in one transaction, since there are no bytes; cascades remove columns, cards, comments, members, and links.

**Audit.** `task.board_*`, `task.column_*`, `task.card_*`, `task.comment_*`, and `task.attachment_*` events record ids only.

## Today

`GET /api/today?tz=` (server/today/) composes **sections** from providers registered with `registerTodayProvider(name, {href, load, mcpScope?, available?})`. A provider may only call its module's own predicate or list function: `readableBoardPredicate` for tasks (live cards, columns with `is_done = 0`), `readableNotePredicate` for notes, `recentListableDocuments` (the Files list predicate, `purpose = 'file'`) for files, `listBin` for the Bin, and `storageUsage` (the quota's own sum) for storage. Each fetches at most 11 rows and returns ten plus `more`, ids and titles only. Providers run independently; one that throws errors only its own section. A module that is not installed registers nothing, so its section is absent (Calendar's `upcoming` and Collections add theirs from their own code). Requests are limited to 30 a minute per user in memory, and `tz` must be an IANA zone known to `Intl` (aliases browsers still report, such as `Asia/Calcutta`, are accepted as sent). Recipients see a shared note only once it is published, with its published title and time.

The client (src/today/) renders `TodayHome` at `/` in place of the old card grid. Its launcher list (`TODAY_APPS`) and section copy (`TODAY_SECTIONS`) are plain lists later modules extend. Links push their route with `mynotes.depth + 1` through `navigate`, so Back returns to Today; the Customize dialog pushes nothing and registers the history dialog guard. Hidden sections are stored in `localStorage` under `mynotes:today:hidden:<userId>`.

Migration 011 adds `cards.due_on` (a `YYYY-MM-DD` GLOB CHECK; real dates are checked by the API), `cards.assignee_id` (a board reader, checked by the API), and `board_columns.is_done` (backfilled for columns named Done), plus indexes for due, assignee, and creator lookups.

## API surface

All `/api` routes except health, about, login, register, and the calendar feed need a session. The feed (`GET`/`HEAD` of exactly `/api/calendars/<uuid>/feed.ics`, matched by `isFeedRequest` in `server/calendar/feeds.ts`) authenticates with its own token and skips both the session and the TOTP middleware. Mutations need an allowed `Origin`, `X-CSRF-Token`, and a JSON body (except the upload). With `TOTP_POLICY=required`, a user without a factor can reach only logout and the TOTP status, setup, and enable routes.

- **Public:** `GET /api/health`, `GET /api/about`, `POST /api/auth/register`, `POST /api/auth/login`
- **Session:** `GET /api/auth/me`, `POST /api/auth/logout`
- **TOTP:** `GET /api/auth/totp/status`, `POST /api/auth/totp/setup`, `POST /api/auth/totp/enable`, `DELETE /api/auth/totp`
- **Recovery codes:** `POST /api/auth/totp/recovery-codes` (view; password and fresh TOTP code), `POST /api/auth/totp/recovery-codes/regenerate`
- **MCP keys:** `GET /api/mcp/keys`, `POST /api/mcp/keys` (password plus a TOTP or recovery code when enrolled, and optional `scopes`; the plaintext key is returned once), `DELETE /api/mcp/keys/:id`
- **Users:** `GET /api/users`
- **Folders:** `GET/POST /api/folders`, `PATCH/DELETE /api/folders/:id`, `GET/PUT /api/folders/:id/sharing`
- **Notes:** `GET/POST /api/notes`, `GET/PATCH/DELETE /api/notes/:id`, `PUT/DELETE /api/notes/:id/draft`, `POST /api/notes/:id/publish`, `GET /api/notes/:id/versions`, `GET /api/notes/:id/versions/:version`, `POST /api/notes/:id/versions/:version/restore`, `GET/PUT /api/notes/:id/sharing`
- **Files:** `POST /api/files?folderId=` (multipart upload), `GET /api/files?folderId=`, `GET/PATCH/DELETE /api/files/:id`, `GET/HEAD /api/files/:id/content`, `GET/PUT /api/files/:id/sharing`
- **Files** also accept `?purpose=task_attachment` on upload (no folder; readable to a board only once linked to a card).
- **Tasks:** `GET/POST /api/tasks/boards`, `GET/PATCH/DELETE /api/tasks/boards/:id`, `GET/PUT /api/tasks/boards/:id/sharing`, `POST /api/tasks/boards/:id/columns`, `PATCH/DELETE /api/tasks/columns/:id`, `POST /api/tasks/boards/:id/cards`, `GET/PATCH/DELETE /api/tasks/cards/:id`, `POST /api/tasks/cards/:id/move`, `GET/POST /api/tasks/cards/:id/comments`, `PATCH/DELETE /api/tasks/comments/:id`, `POST /api/tasks/cards/:id/attachments`, `DELETE /api/tasks/cards/:id/attachments/:documentId`
- **Calendar:** `GET/POST /api/calendars`, `PATCH/DELETE /api/calendars/:id`, `GET/PUT /api/calendars/:id/sharing`, `POST /api/calendars/:id/events`, `GET /api/events?from&to&tz&calendars&include=tasks`, `GET/PATCH/DELETE /api/events/:id`, `POST /api/events/:id/undo`, `POST /api/events/:id/exdates`, `POST/DELETE /api/events/:id/links`
- **Reminders and notifications:** `GET/POST /api/reminders`, `DELETE /api/reminders/:id`, `GET /api/notifications`, `POST /api/notifications/read`
- **Web Push:** `GET /api/push/config`, `GET/POST/DELETE /api/push/subscriptions`, `POST /api/push/test`
- **Calendar feeds:** `GET/POST /api/calendars/:id/feeds`, `DELETE /api/feeds/:id`, and the token-authenticated `GET /api/calendars/:id/feed.ics?token=`
- **Bin:** `GET /api/bin?type=note|document|card|board|collection|collection_row|calendar|event`, `POST /api/bin/:type/:id/restore`, `DELETE /api/bin/:type/:id`, `DELETE /api/bin`
- **Search:** `GET /api/search?q=&scope=notes&folder=all|shared|<uuid>&limit=20`
- **MCP:** `/mcp` (outside `/api`): Streamable HTTP with a `Bearer` API key, `Host` and `Origin` checks, a failed-auth rate limit, and bounded bodies. Tools are registered per key scope; see [MCP](#mcp).

Any other `/api` path returns a JSON 404. In production every other path serves the SPA's `index.html`. Request and response shapes for Files, Bin, Search, and Tasks are in [docs/plan/API_CONTRACTS.md](plan/API_CONTRACTS.md).

<a id="mcp"></a>
## MCP

`server/mcp.ts` owns keys and the transport. It checks `Host` and `Origin`, authenticates the bearer token (SHA-256 lookup; revoked keys and disabled users are refused), caps concurrent requests at 24, bounds the body, and builds a fresh `McpServer` per request with the key's context (`keyId`, owner, name, scopes) in `authInfo`.

Each request, and each tool call through `loadLiveKey`, uses the key's **effective scopes**: the stored scopes narrowed to what the holder's current team role allows (`effectiveMcpScopes` in `server/team/roles.ts`), so an admin who is demoted loses `team:read` on the next call without the key row changing.

`server/mcpTools.ts` holds every tool as a spec: a name, the scopes that allow it (any one), whether it writes, an optional daily bucket, a Zod input schema, and a handler. `registerMcpTools` registers only the specs the key's scopes allow. `runTool` wraps every handler: it reloads the key from the database and re-checks the scope, charges the per-key limits in `server/mcpRateLimit.ts` (all buckets or none), validates the arguments, and maps `McpToolError` to `isError` results with `{error, code}`. The scope vocabulary and the write-implies-read rule are pure functions in `server/mcpScopes.ts`, mirrored for Settings in `src/mcpPermissions.ts`.

Tools reuse the HTTP services as the key's owner:

- notes: `readableNote`/`ownedNote`, `listReadableFolders`, and `searchPublishedNotes` (published rows only, plain snippets);
- draft writes: `createDraftNote` and `writeDraftLocked` in `server/noteDrafts.ts`, the same revision CAS, title derivation, and same-transaction index sync as `PUT /api/notes/:id/draft`, under the note lock;
- files: the Files list predicate (`listReadableDocuments`, `listableDocument*`), never `readableDocument*`, which later modules widen for attachments.

An MCP write sets `notes.draft_mcp_key_id`; publish, discard, and restore-to-draft clear it. The editor shows "Draft by <key>" from `draftMcpKeyName`, and the list from `draft_mcp_key_name`. Leaving a note auto-publishes only when the user typed in it this session and no MCP key wrote the draft (`shouldAutoPublish` in `src/noteFinalization.ts`), so an agent's draft always waits for an explicit Publish. Publish sends the draft revision the editor last saw; a newer revision (409 `DRAFT_CHANGED`) reloads the note instead of publishing it.

Module tools live next to their module: `server/tasks/mcpTools.ts`, `server/calendar/mcpTools.ts`, `server/collections/mcpTools.ts`, and `server/today/mcpTools.ts`. Task tools They validate with the `/api/tasks` route schemas, call the same service functions as the routes, map `TaskError` to `{error, code}` (`NOT_FOUND`, `STALE_POSITION`, `LIMIT_REACHED`, …), and run inside `withAuditContext({via: "mcp", keyId})` (`server/db.ts`), which merges those fields into the services' usual `task.*` audit events. Calendar and collection tools work the same way: they validate with the route schemas, pass the key id to `createEvent`/`patchEvent`/`createReminder` and `createRow`/`patchRow` (which set `updated_via_key_id` and `created_via_key_id`), and map `CalendarError`/`ReminderError` and `CollectionError` to `READ_ONLY`, `EVENT_CHANGED`, `ROW_CHANGED`, and the other codes. Collection tools translate between field names and ids and between option labels and ids at the edge, so agents never handle `f_…` ids unless they want to. Daily buckets: `create_note`, `task_write`, `event_write`, `reminder_write`, and `row_write`, per key and per user. Today sections declare the module scope `get_today` needs through `mcpScope` on their provider.

To add a module's tools (the later scopes in WAVES_10-12 D70): add its scope pair to `MCP_SCOPES` and `IMPLIED_READ_SCOPE` if it is new, write specs with `defineTool` from `server/mcpToolKit.ts` in the module, and spread them into `mcpToolSpecs`. Writes set `write: true` (and a `dailyBucket` when capped), audit `{via: "mcp", keyId}`, use revision CAS, and never delete.

## Collections

Typed tables (WAVES_10-12.md §3), in `server/collections/` with routes under `/api/collections` (API_CONTRACTS.md § Collections). Migration 012 adds:

| Table | Holds |
| --- | --- |
| `collections` | owner, name, icon, `schema_json` (≤ 64 KiB) and `schema_version`, `visibility` and one audience `share_role` (`viewer`/`editor`), Bin columns |
| `collection_members` | recipients of a `selected` collection |
| `collection_rows` | `values_json` keyed by field id (≤ 16 KiB), `position`, `revision`, and the one-step undo pair `prev_values_json`/`prev_revision`; `updated_via_key_id` marks the last change as made through an MCP key (shown as "Changed by <key>" with Undo in the row panel); Bin columns |
| `collection_views` | saved views: name and `config_json` (sort, filters, hidden fields; ≤ 8 KiB) |
| `collection_row_attachments` | `(row_id, document_id, field_id, linked_by)` links to documents |
| `collection_row_search`, `collection_row_fts` | the row search index (below) |

**Modules.** `schema.ts` is pure: strict zod field input (no prototype keys), server-generated ids (`f_` + 8, `o_` + 6), the allowed type changes (text ↔ url, select → multi_select), strict value validation for writes, and lenient `readValues` for reads, which projects stored values onto the current schema so removed fields and options read as empty and drop out on the next write. `templates.ts` holds the five built-in templates as static data. `access.ts` holds `readableCollectionPredicate` and `editableCollectionPredicate` and joins every path id (row, view) to its collection. `service.ts` holds every operation (routes are thin adapters, and the MCP tools in `mcpTools.ts` call the same functions); writes run under the `collection:<id>` resource lock and audit ids and counts only. `bin.ts` registers collections and rows as Bin providers (`registerBinProvider` in `server/bin.ts`), `search.ts` the index, `csv.ts` the in-house RFC 4180 parser and writer, `importExport.ts` import and export, and `sweep.ts` the never-linked attachment sweep.

**Query builder.** `query.ts` compiles `{ sort ≤ 3, filters ≤ 10, q }` against the schema: each field type has an enumerated operator list, field ids must exist in the schema (strict for requests, lenient for saved views whose fields were removed since), and every value and JSON path is bound (`json_extract(r.values_json, ?)` with `$.f_…`). Wrong JSON types never match comparisons and sort with the empty values. Paging is an opaque offset cursor bound to a hash of the spec and to `schema_version` (409 `SCHEMA_CHANGED` after a field change). There are no generated columns; the 10,000-row cap bounds a scan.

**Concurrency.** Row writes use a compare-and-swap on `revision` (409 `ROW_CHANGED` with the current row). A patch keeps the previous values for one undo. Schema changes use a CAS on `schema_version`; rows are never rewritten.

**Attachments.** Uploads with `?purpose=collection_attachment` have `folder_id = NULL` and never appear in Files lists; Files routes (rename, move, sharing) refuse them, and folder or sharing access never applies to them. `readableDocument*` (only) also admits readers of a live row in a live collection that links the document, so unsharing, binning, and unlinking take effect at once. Losing the last link, a purge, or 24 hours without any link moves a `collection_attachment` upload to its uploader's Bin.

**Search index.** `collection_row_search` maps an FTS rowid to a row with the `source_revision` and `schema_version` it was built from (`ON DELETE CASCADE` from rows; a trigger removes the FTS row). The title is the primary field and the body the other text, url, number, and date values and option labels; note titles and file names are never indexed. Rows are indexed in the transaction that writes them, a schema change reindexes its collection in the schema transaction, and boot runs `reconcileCollectionSearchIndex()` after the notes reconcile to rebuild missing or stale entries and drop orphans. `GET /api/search?scope=collections` applies the collection access rule inside the query, before `LIMIT`, and returns segments as notes search does.

**Bin.** Collections are listed for their owner; rows for the collection owner and their deleter, who may restore while they can still edit (a row in a binned collection returns `PARENT_IN_BIN`). Only the owner purges. A purge is one SQLite transaction; the sweeper and Empty Bin include both types.

## Calendar

Calendars, events, reminders, notifications, and Web Push (WAVES_10-12.md §4), in `server/calendar/` with routes under `/api/calendars`, `/api/events`, `/api/reminders`, `/api/notifications`, and `/api/push` (API_CONTRACTS.md § Calendar). Migration 013 adds `calendars` and `calendar_members` (one audience `share_role`), `events` (Bin columns, revision, one-step undo), `event_links`, `reminders`, `notifications`, `push_subscriptions`, and `calendar_feeds`.

**Modules.** `recurrence.ts` is the pure zoned-time and recurrence expander. `access.ts` holds the readable, editable, and writer predicates. `service.ts` holds calendars, events, occurrence ranges, and `listUpcoming` (Today's `upcoming` section, registered in `server/today/providers.ts` with `mcpScope: "calendar:read"`). `ics.ts` is the pure RFC 5545 writer (escaping, 75-octet folding, `RRULE`/`EXDATE`), and `feeds.ts` the feed tokens, their routes, the per-token hourly limit, and `isFeedRequest`. `mcpTools.ts` holds the calendar MCP tools. `links.ts` resolves link targets per viewer through each module's own check (`readableNote`, `readableCard`, `readableRow`). `tasksOverlay.ts` lists due cards for `include=tasks` with `readableBoardPredicate`. `calendarBin.ts` registers calendars and events as Bin providers (`registerBinProvider`, like Collections). `reminders.ts` schedules reminders and runs the dispatcher (a 30 s `unref` single-flight tick started after the sweeper) that writes notifications; `push.ts` keeps VAPID keys under the data directory (created by `initPush()` at boot; a failure leaves reminders in-app only) and sends payload-less pushes to allowed push-service hosts.

**Feeds.** A feed token (`nookfeed_` + 32 random bytes, base64url) is stored in `calendar_feeds` as its SHA-256 hash with a 13-character prefix for display, per (calendar, creator, `busy|full`), at most 5 live per user per calendar. A fetch looks the hash up, re-checks the creator (enabled, on the allowlist) and `readableCalendar` for them, writes `last_used_at` at most every 10 minutes, and renders at most 5000 events; any failure is one uniform 404. The per-token 60-an-hour window is in memory, keyed by the hash. The token never reaches logs or the audit log.

**Client.** `src/calendar/` (agenda, month, event sheet and view, calendars dialog, and the Feed dialog `FeedDialog.tsx`), `src/calendarRoute.ts` and `src/calendarNavigation.ts` (routes and history hints), and `src/notifications/` (the bell rendered by `AccountActions` inside `NotificationsContext`, `/notifications`, and the Settings → Notifications device switch). `public/sw.js` is the service worker, served with `Cache-Control: no-cache`; sign-out calls `forgetThisDevice()` to drop this browser's subscription.

<a id="team"></a>
## Team

Accounts, roles, and blocking (Wave 14; plan of record `docs/plan/research/2026-09-26-team-module.md`), in `server/team/` with routes under `/api/team` (API_CONTRACTS.md § Team):

- `roles.ts` is pure: the four roles, the roles assignable this release (admin, member), `can(role, capability)`, `mcpScopesForRole`, and `effectiveMcpScopes`. `src/team/teamRoles.ts` mirrors it for the client.
- `service.ts` lists members (admins get account metadata; everyone else names, roles, and status), reads the activity log, and runs every write in one transaction: role changes with a compare-and-swap on the expected role, blocks, unblocks, and sign-out-everywhere. Each write records one `team_events` row and one `audit_log` row with ids and roles only. The service refuses to leave no active admin (`LAST_ADMIN`), and the migration's triggers refuse it in SQL too.
- `routes.ts` answers guests with 404, refuses writes from non-admins (403), rate-limits admins to 30 writes a minute, and asks for the password (plus a fresh second factor when enabled, `server/reauth.ts`) before granting or removing admin or blocking an admin.
- `mcpTools.ts` holds the read-only `team:read` tools.
- `invites.ts` (Wave 18) creates, lists, revokes, and claims invites. A link is `/register#invite=<token>`: the token is in the fragment, read and stripped by `src/auth/inviteLink.ts`, and posted in JSON bodies only. The register handler in `server/index.ts` checks the invite (creator still an active admin) before the account lookup and claims it with one guarded UPDATE in the user-insert transaction. Dead invites are swept after 90 days. `inviteEmail.ts` is the invite message for `server/mail.ts`, the generic Resend wrapper (rate limits, a 10 s timeout, hashed-recipient logs, a test transport).
- `server/team-admin.ts` is the host CLI (`list`, `set-role`, `unblock`) for lockouts; it calls the same service with no actor and `via = 'cli'`.

**Block** reuses `users.disabled_at`, which every session, MCP, feed, picker, and assignee check already honours. The block transaction also deletes the account's sessions and push subscriptions. Sign-in answers 403 `ACCOUNT_BLOCKED` only after the right password; the document upload commit re-checks the owner inside its transaction; the reminders dispatcher skips blocked accounts. The first account registered on an empty database is made admin inside the register transaction.

The client (`src/team/`) is one app with a list at `/team` and a member page at `/team/:userId`. The role picker is the shared 13A `src/ui/Select.tsx` (a listbox popup on desktop, a bottom sheet at phone width, keyboard and type-ahead; D91), and every confirmation registers through `src/ui/useHistoryDialogGuard.ts`, which wraps the dialog guard in `src/historyDialogs.ts`. Team is a row in Settings → Modules: off hides the Team button and redirects `/team` Home, guests never see the row, and admins keep Settings → Manage team, which passes the route gate for that visit. The Team button in the account row comes from `TeamNavContext` in `src/AppShell.tsx`, so apps do not wire it themselves.

## UI

### Apps

After sign-in, Today (`src/today/TodayHome.tsx`) launches Notes, Files, Tasks, Collections, and Calendar, with the Bin and the notification bell in its account row. Notes uses a collapsible folder rail, note list, and editor; Files a folder rail, file list, upload queue, and preview/details pane; Tasks (`src/tasks/`) a board list and a board of 280 px columns with drag and drop (`application/x-mynotes-card`, a UUID only), Alt+Arrow moves, and a card dialog; the Bin a single list. At 760 px and below each app becomes a sequence of full-width panels (Notes: folders → list → editor; Files: folders → files → preview); a board shows one column at a time on an x-mandatory scroll-snap track synced to a sticky tab strip.

Tiptap provides an Outline-like block editor with Markdown serialization, keyboard shortcuts, a bubble toolbar, and `/` commands. `/image` and paste/drop upload PNG, JPEG, GIF, or WebP through `POST /api/files` into the note's folder and embed `/api/files/<id>/content?disposition=inline`; the image is kept only if the server's sniffed kind agrees, and image sources other than this app's content URLs are dropped. Images therefore follow the folder's sharing, not a note-level override. `/table` uses the Tiptap table extensions and round-trips GitHub-flavoured pipe tables. Download as PDF uses print CSS and `window.print()`.

### URL routing and history

`src/router.ts` maps paths to routes with pure `parseRoute`/`formatRoute`: `/`, `/notes`, `/notes/folder/:id`, `/notes/shared`, `/notes/:noteId`, the same shapes under `/files`, `/tasks`, `/tasks/:boardId`, `/tasks/:boardId/card/:cardId`, `/collections`, `/collections/:c`, `/collections/:c/view/:v`, `/collections/:c/row/:r`, `/calendar`, `/calendar/month/:yyyy-mm`, `/calendar/event/:eventId`, `/notifications`, `/bin`, `/team`, and `/team/:userId`. Unknown paths resolve to Home; ids must be UUIDs and are lowercased. `navigate()` pushes (or replaces) a real history entry on desktop and mobile, and `popstate` re-parses `location.pathname`.

History state layers hints over the URL:

- `mynotes.app-shell`: the app section, tied to the user id.
- `mynotes.mobile-navigation` and `mynotes.files-navigation`: the phone panel (and, for Files, the folder a file was opened from), so Back steps between panels.
- `mynotes.notes-search`: the Notes search query and scope an entry showed, tied to the user id. The query never enters the URL. On phones the first search from a list entry pushes one same-URL entry, and later edits replace it, so Back from a note returns to the results and Back from the results closes the search. Every Notes entry written while a search is active carries it, and entering an entry without it clears the search.
- `mynotes.tasks-navigation`: the column a board showed on a phone, tied to the user and board and updated with `replaceState`, so swiping adds no entries and Back/Forward return to the same column. A card is a view with its own entry (Back closes it); the dialogs inside it push nothing.
- `mynotes.collections-navigation`: on a Collections row entry, the saved view the row was opened over (the row URL names only the row), so reload and Forward redraw the right table behind the row. `mynotes.collections-search` keeps the row search query on the Collections list entry.
- `mynotes.depth`: how many entries the app has pushed below the current one. In-app Back calls `history.back()` only when depth > 0, otherwise it changes the panel in place, so it never leaves the site from a first entry.

Leaving a note by any route change runs `finalizeOpenNote` (remove a blank never-published note, or save and publish a changed draft) with the editor locked; on failure the URL stays on the note. Deep links resume the named note or file; unreadable ids fall back to the list with a toast. A signed-out deep link is kept in memory through login. A failed first workspace load retries on the next route change.

Dialogs and sheets push no history. While one is open, the app registers a guard (`src/historyDialogs.ts`; guards form a stack, newest asked first, so shared chrome such as the notification bell and nested Tasks dialogs each register their own): the first `popstate` handler to see a Back or Forward closes the dialog and undoes the move with `history.go(±1)`, chosen by comparing `mynotes.depth` of the two entries, and the popstate that causes is ignored once.
