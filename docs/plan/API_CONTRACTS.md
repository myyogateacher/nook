# API contracts: Files, content, Bin, Search, Tasks, Today, Preferences, MCP, Collections, Calendar, and Team

Companion to [DEVELOPMENT_PLAN.md](../../DEVELOPMENT_PLAN.md). Every endpoint lives under `/api` and inherits the existing middleware:

- a session cookie is required (401 otherwise)
- the `TOTP_POLICY=required` setup gate applies
- `Cache-Control: no-store`
- global security headers apply

Mutations (anything other than GET, HEAD, or OPTIONS) require:

- an allowed `Origin` (403)
- `X-CSRF-Token` (403)
- `Content-Type: application/json` (415). The single exception is `POST /api/files`, which requires `multipart/form-data`.

**Conventions**

- Errors are `{ "error": string, "code"?: string, "details"?: string[] }`. Zod failures return 400 `{ error: "Invalid request", details }`, as they do today.
- Ids are UUIDs, validated with `uuid.parse`. A malformed id returns 400.
- Missing, forbidden, and (for non-owners) binned items all return **404** with the same message.
- Timestamps are ISO-8601 UTC strings (`new Date().toISOString()`).
- Field casing follows existing responses: snake_case for DB-shaped rows, camelCase for computed flags.

## Types

```ts
type Visibility = "private" | "selected" | "all_users";
type PreviewKind = "image" | "pdf" | "text" | "audio" | "video" | "none";

type DocumentSummary = {
  id: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  folder_id: string | null;      // masked to null for recipients unless the folder itself is visible to them
  name: string;
  mime_type: string;
  preview_kind: PreviewKind;
  size_bytes: number;
  visibility: Visibility;        // effective: folder visibility when inheriting, else document visibility
  sharing_override: 0 | 1;       // only meaningful to owners; recipients receive 0
  created_at: string;
  updated_at: string;
};

type BinItem = {
  type: "note" | "document" | "card" | "board" | "collection" | "collection_row" | "calendar" | "event";   // collection types: Wave 11; calendar types: Wave 12
  id: string;
  title: string;                 // note title, document name, card title, or board name
  folder_id: string | null;      // original folder, null if it no longer exists
  folder_name: string | null;    // null → restore target is Default
  size_bytes: number | null;     // documents only
  deleted_at: string;
  purge_after: string;
  purging: boolean;              // purge_started_at IS NOT NULL
  board_id: string | null;       // cards: their board; boards: themselves; else null
  board_name: string | null;
  attachment: boolean;           // a document that was a card attachment (restores into Files)
  can_purge: boolean;            // false for a card, row, or event the caller deleted on someone else's board, collection, or calendar
};
```

`sha256`, `upload_key`, the storage path, and the deletion columns are **never** returned by list or metadata endpoints.

## Files

### Upload

`POST /api/files?folderId=<uuid>`. If `folderId` is omitted, the file goes to the caller's Default folder.

`purpose` (Wave 9, migration 009): every document has `documents.purpose` = `file` (default), `task_attachment`, or `collection_attachment` (reserved for Wave 11). The optional `?purpose=` parameter accepts `file` or `task_attachment`; anything else returns 400. A `task_attachment` upload takes no `folderId` (400 otherwise), is stored with `folder_id = NULL`, never appears in Files, counts toward the quota, and becomes readable to a board's readers only once linked to one of its cards (§ Tasks, Attachments).

The request body is `multipart/form-data` with **exactly one** part, named `file`. The part's `filename` parameter becomes the display name after sanitization (DEVELOPMENT_PLAN §6.4). The part's `Content-Type` is ignored for classification.

Optional headers:

- `Idempotency-Key: <uuid>`: the Files UI always sends one per queued file
- `Content-Length` is **required** (411 without it). Browsers send it for `FormData` and it enables the early 413

| Status | When | Body |
| --- | --- | --- |
| 201 | Stored | `{ document: DocumentSummary }` |
| 200 | `Idempotency-Key` already used by this user | `{ document: DocumentSummary, idempotentReplay: true }` |
| 400 | Not multipart, missing or extra parts, a field other than `file`, a malformed boundary, or an invalid `folderId`/`Idempotency-Key` | `{ error }` |
| 404 | Folder not found or not owned by the caller | `{ error: "Folder not found" }` |
| 409 | `Idempotency-Key` was already used by this user for a document that is now in the Bin. Clients treat this as final and do not retry. | `{ error, code: "IDEMPOTENCY_KEY_USED" }` |
| 408 | No body bytes arrived for 30 seconds (the upload stalled) | `{ error, code: "UPLOAD_TIMEOUT" }` |
| 411 | `Content-Length` is missing or not a valid integer. Browsers always send it for `FormData` and `File` bodies. | `{ error, code: "LENGTH_REQUIRED" }` |
| 413 | `Content-Length` or streamed bytes exceed `MAX_UPLOAD_BYTES` | `{ error, code: "FILE_TOO_LARGE", limitBytes }` |
| 415 | `Content-Type` is not `multipart/form-data` | `{ error }` |
| 429 | The user already has 3 uploads in flight | `{ error, code: "TOO_MANY_UPLOADS" }` |
| 507 | The quota would be exceeded, or free disk would fall below `MIN_FREE_DISK_BYTES` | `{ error, code: "QUOTA_EXCEEDED" \| "DISK_FULL" }` |

Audit: `document.upload { documentId, size, mimeType }`. The filename is never logged or audited.

> **Implementation notes (shipped in v0.3.0):**
> - The early 413 uses `Content-Length > MAX_UPLOAD_BYTES + 64 KiB` (multipart overhead). Streamed bytes are still checked against `MAX_UPLOAD_BYTES` exactly.
> - Requests without `Content-Length` (chunked) are accepted and bounded while streaming; the quota and free-disk checks then reserve `MAX_UPLOAD_BYTES` for the request.
> - busboy is configured with `parts: 2` and `fileSize: MAX_UPLOAD_BYTES + 1`, because it reports a limit when a count or size *reaches* it. Reaching two parts is treated as an extra part (400); a file part over the limit fails at once (413) instead of draining the body.
> - 409 `IDEMPOTENCY_KEY_USED` is also returned when a concurrent upload with the same key commits first and that document is binned before the replay is read.
> - A huge chunked body sent to a non-upload route is stopped by Bun's global `maxRequestBodySize` with a bare 413, not the JSON error shape.

### List

`GET /api/files?folderId=<uuid>` lists live documents the caller can read, ordered by `updated_at DESC`, with a limit of 500. The `folderId` filter matches `documents.folder_id`. Only `purpose = 'file'` documents are listed: attachments never appear in Files, not even for their uploader, and they are left out of `GET /api/bin?type=document` (they still count toward the storage quota).

200 → `{ documents: DocumentSummary[] }`

### Metadata

`GET /api/files/:id` → 200 `{ document: DocumentSummary }`, or 404.

### Rename and move

`PATCH /api/files/:id` with body `{ name?: string, folderId?: uuid | null }`. The schema is strict, and at least one key must be present. Owner only.

- `name` is sanitized with the upload rules. If it is empty or longer than 255 UTF-8 bytes after sanitizing, the response is 400. Preview kind and MIME type **do not** change on rename.
- `folderId` must be a folder owned by the caller (404 `Folder not found` otherwise). `null` moves the document to no folder: private unless it has an override, and shown under All.
- 200 → `{ document: DocumentSummary }` with the new effective `visibility`, so the UI can report it.
- Audit: `document.rename { documentId }`, `document.move { documentId, folderId }`.

### Sharing

This mirrors the notes endpoints exactly.

- `GET /api/files/:id/sharing` (owner only) → `{ visibility: "inherit" | Visibility, users: [{ id, display_name }] }`
- `PUT /api/files/:id/sharing` with body `{ visibility: "inherit" | "private" | "selected" | "all_users", userIds: uuid[] (max 100) }`
  - The same validation as `sharingSchema`: the owner cannot be a recipient, `selected` requires at least one user, and every user must exist and be enabled.
  - It replaces the rows in `document_shares`. `inherit` sets `sharing_override = 0`.
  - 200 `{ ok: true }`
  - Audit: `document.sharing_changed { documentId, visibility, recipientCount }`

### Delete (to Bin)

`DELETE /api/files/:id` (owner only, body `{}`):

- **Live document:** sets `deleted_at = now`, `deleted_by = caller`, and `purge_after = now + 30 days` → 200 `{ ok: true, purgeAfter }`.
- **Already binned (owner):** 200 `{ ok: true, alreadyDeleted: true, purgeAfter }`.
- **Missing or not owned:** 404.
- Audit: `document.delete { documentId }`.

**Non-file documents (Wave 9 review fix):** `PATCH /api/files/:id`, `GET`/`PUT /api/files/:id/sharing` return 404 for documents whose `purpose` is not `file`; `DELETE /api/files/:id` bins an attachment only when no card links it, otherwise 409 `{ code: "ATTACHMENT_LINKED" }`. Folder and sharing access apply only to `file` documents; attachments are readable solely through their board (Wave 9 §3.2).

<a id="content"></a>
### Content

`GET /api/files/:id/content?disposition=inline|attachment`, and `HEAD` on the same URL. Any reader may call it. The default disposition is `attachment`.

Response headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `inline` and `preview_kind ≠ none` → the stored `mime_type` (text → `text/plain; charset=utf-8`). Otherwise `application/octet-stream`. |
| `Content-Disposition` | `inline` only if requested **and** `preview_kind ≠ none`; otherwise `attachment`. The filename format is `filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded NFC name>`. For the ASCII fallback, replace non-ASCII characters with `_`, strip `"`, `\`, CR, LF, and control characters, and fall back to `download` if the result is empty. |
| `Content-Length` | Byte length of the body |
| `Accept-Ranges` | `bytes` |
| `ETag` | `"<sha256>"` (strong) |
| `Last-Modified` | `updated_at` in HTTP-date format |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` for every response except inline PDF, which gets `default-src 'none'; frame-ancestors 'none'` (see DEVELOPMENT_PLAN §7.2 verification). The global `secureHeaders` middleware overwrites headers after `next()`, so this route must be excluded from it and set these headers itself. |
| `X-Frame-Options`, `Referrer-Policy` | `DENY`, `no-referrer` (set by the route, since the global middleware is skipped here) |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `private, no-store` |

Range handling (RFC 9110):

- `Range: bytes=a-b`, `bytes=a-`, and `bytes=-n` are supported. If the range is satisfiable → **206** with `Content-Range: bytes start-end/size`. `end` is clamped to `size-1`.
- Multiple ranges (a comma in the header) → the range is ignored and the response is **200** with the full body.
- A malformed `Range` or a non-`bytes` unit → ignored, **200**.
- Unsatisfiable (`start ≥ size`, a suffix of 0, or any range on a 0-byte file) → **416** with `Content-Range: bytes */size` and an empty body.
- If `If-Range` is present and does not exactly equal the current ETag → the range is ignored, **200**. HTTP-date `If-Range` values are also treated as a mismatch.
- `HEAD` returns the same status and headers with no body.

Errors:

- 404 when the document is not readable
- 500 `{ error: "Something went wrong" }` on an integrity failure: missing object, size mismatch, or a symlink. The server logs the error class and document id and never the filename.

Downloads and previews are **not** audited individually, by design, to avoid noise.

Streaming: open the object with `O_NOFOLLOW` and verify it with `fstat`, then stream `start..end` from the fd, using a Node read stream converted with `Readable.toWeb`. The fd must close when the client aborts.

> **Implementation notes (shipped in v0.3.0):** Bun sends streamed 200/206 bodies with `Transfer-Encoding: chunked` rather than the `Content-Length` the route sets; HEAD, 416, and empty responses carry `Content-Length`. Content responses do not carry the global HSTS or Permissions-Policy headers, since the route replaces `secureHeaders`. Both were accepted in the Wave 3 review.

<a id="bin"></a>
## Bin

Every Bin endpoint is scoped to the caller's own items, plus binned cards they deleted (below). `:type` is `note`, `document`, `card`, `board`, `collection`, `collection_row`, `calendar`, or `event` (see [Calendar § Bin](#calendar-items-in-the-bin)); any other value returns 400.

**Cards and boards (Wave 9, D41).** A binned board is listed for its owner. A binned card is listed for the board owner and for the member who deleted it, while that member can still open the board. Either can restore the card; only the board owner deletes it forever (403 `OWNER_ONLY` for the deleter). Cards and boards have no bytes, so a purge never returns 202. Purging a card or board deletes its comments and links; a document that loses its last link moves to its uploader's Bin. A restored attachment document with no links becomes an ordinary Files item (`purpose = 'file'`) in its folder or Default.

**Card subtrees (sub-wave 17A, D129, D130, T114).** `DELETE /api/tasks/cards/:k` also bins the card's live children and grandchildren in the same transaction, tagged with the root (`cards.bin_root_id`), and answers `{ ok, purgeAfter, descendantCount }`. Only the root is a Bin item: it is listed with `descendant_count` (omitted when 0), and its descendants return 404 on restore and delete forever. Restoring the root restores exactly its group, each card in its old column (or the first one) at the bottom, in its old order, and the answer adds `descendantCount`. A descendant binned on its own first is its own root and keeps its entry; restored while its parent is still binned, it comes back without a parent and the answer says `detached: true` (a parent purged meanwhile was already cleared by `ON DELETE SET NULL`). Purging a root purges its group, by hand, by Empty Bin, and by the sweeper, which only picks roots. The live-card cap counts the whole group. Audit: `task.card_delete`, `task.card_restore`, and `task.card_purge` add `descendantCount` (and `detached`).

### List

`GET /api/bin?type=note|document|card|board` (the `type` filter is optional; `document` lists Files items only, while attachments appear in the unfiltered list) → 200 `{ items: BinItem[] }`, ordered by `deleted_at DESC`, with a limit of 500. Notes in the list: `deleted_at IS NOT NULL` (blank unpublished notes never enter the Bin; they are purged immediately).

### Restore

`POST /api/bin/:type/:id/restore` with body `{}`:

| Status | When | Body |
| --- | --- | --- |
| 200 | Restored | `{ ok: true, folderId, folderName, visibility }`: original folder, or Default when the original is gone or not owned. `visibility` is the new effective visibility, because a Default fallback can change it. |
| 200 | Already live (owner) | `{ ok: true, alreadyRestored: true, folderId, folderName }` |
| 200 | Card or board restored (or already live) | `{ ok: true, alreadyRestored?, boardId, boardName, columnId, columnName }`. A card returns to the bottom of its column, or of the first column when its column was deleted; `columnId`/`columnName` are null for boards. |
| 404 | Missing or not owned | `{ error }` |
| 409 | Purge in progress | `{ error, code: "PURGING" }` |
| 409 | A card whose board is in the Bin | `{ error, code: "BOARD_IN_BIN" }` |
| 409 | The board would exceed 1000 live cards, or the owner 50 live boards | `{ error, code: "LIMIT_REACHED" }` |

Restore is a compare-and-swap update under the resource lock. Share rows remain as they were, so the item's previous audience regains access. Audit: `note.restore` / `document.restore`.

### Delete forever

`DELETE /api/bin/:type/:id` with body `{}`:

| Status | When | Body |
| --- | --- | --- |
| 200 | Purged, or a purge was already in progress and has now finished | `{ ok: true }` |
| 202 | Purge started but byte removal failed; the sweeper will retry | `{ ok: true, pending: true }` |
| 403 | A card the caller deleted on a board they do not own | `{ error, code: "OWNER_ONLY" }` |
| 404 | No such binned item for this owner (including items already purged) | `{ error }` |
| 409 | The item is live (not in the Bin) | `{ error, code: "NOT_IN_BIN" }` |

Clients treat a 404 on a **retry** as success.

### Empty Bin

`DELETE /api/bin` with body `{}` → 200 `{ ok: true, purged: number, pending: number }`. Items are processed in batches. Failures stay marked for the sweeper. It includes the caller's binned boards and the binned cards on boards they own, never cards on other people's boards.

### Collections and rows (Wave 11, D68)

`:type` also accepts `collection` and `collection_row`, and `GET /api/bin?type=` takes either. Collection items come from a provider registered by `server/collections/bin.ts`; `BinItem` gains an optional `can_purge`.

| Type | Listed for | `title` / `folder_*` | Restore | Delete forever |
| --- | --- | --- | --- | --- |
| `collection` | its owner | name / null | owner; 409 `LIMIT_REACHED` at 100 live collections | owner |
| `collection_row` | the collection owner and whoever binned it | primary field / the collection's id and name | owner or deleter while they can still edit the collection (404 otherwise); 409 `PARENT_IN_BIN` while the collection is binned; 409 `LIMIT_REACHED` at 10,000 live rows | collection owner only (`can_purge: false` for others) |

A purge is one transaction (nothing lives outside SQLite) and cascades to rows, members, views, links, and search rows; documents it leaves unlinked with `purpose = 'collection_attachment'` move to the uploader's Bin. The sweeper purges collections and rows past `purge_after`, and Empty Bin purges the owner's collections and the binned rows of collections they own. Audit: `collection.restore`, `collection.purge { collectionId, reason, rowCount, binnedDocuments }`, `collection.row_restore`, `collection.row_purge`.

> **Implementation notes (shipped in v0.3.1):**
> - Purge audit events (`note.purge`, `document.purge`) record `reason`: `user`, `blank`, `retention`, or `resumed`. `resumed` marks a purge the sweeper finished after an interruption; the original reason is not stored.
> - The sweeper's Bin step has two separate budgets per table and run: up to 50 interrupted purges resumed, then up to 100 items past `purge_after`. Retention is re-checked under the lock, so an item restored and deleted again mid-run is not purged. Remaining items wait for the next hourly run.

## Search (Wave 7)

`GET /api/search?q=&scope=notes&folder=all|shared|<uuid>&limit=20` searches note titles and bodies ([WAVES_7-9.md](WAVES_7-9.md) §2).

| Parameter | Default | Rule |
| --- | --- | --- |
| `q` | `""` | At most 200 characters. It is never passed to FTS5 as syntax: it is NFKC-normalized and lowercased, up to 4 `"quoted phrases"` are kept, the rest is split into up to 8 words of 2–64 letters, numbers, or combining marks, and every word must match (implicit AND). The last word matches as a prefix unless `q` ends in a space or punctuation. A `q` with nothing searchable returns no results. |
| `scope` | `notes` | Only `notes` |
| `folder` | `all` | `all`, `shared` (notes owned by others), or a folder id. A folder id matches the masked `folder_id` below. |
| `limit` | `20` | Integer 1–50 |

```ts
type Segment = { text: string; hit: boolean };  // plain text, never HTML
type NoteSearchHit = {
  id: string;
  source: "published" | "draft";  // draft only for the owner, when a draft exists
  title: Segment[];                // highlighted title
  snippet: Segment[];              // body excerpt around the hits, "…" where cut
  folder_id: string | null;        // masked as in GET /api/notes
  owner_name: string;
  is_owner: 0 | 1;
  visibility: Visibility;          // effective, as in GET /api/notes
  updated_at: string;
};
```

| Status | When | Body |
| --- | --- | --- |
| 200 | Always, including no matches | `{ results: NoteSearchHit[], truncated: boolean }`, ordered by relevance (title matches weigh 8×) then `updated_at DESC`. `truncated` means more than `limit` notes matched. Scores are never returned. |
| 400 | Bad `scope`, `folder`, or `limit`, or `q` over 200 characters | `{ error: "Invalid request", details }` |
| 429 | More than 20 searches in 10 seconds by this user | `{ error, code: "RATE_LIMITED" }` with `Retry-After` in seconds |

Access is the live `GET /api/notes/:id` rule, applied in the query before `LIMIT`: a note's owner searches their draft when one exists and the published version otherwise; everyone else searches the published version of notes they can read. Binned notes never match; restoring one makes it searchable again, and purging removes its index rows. The index holds the published version and the owner's draft, built from checksum-verified files in the same transaction as each change.

### Collection rows (Wave 11)

`GET /api/search?scope=collections&q=&collection=all|<uuid>&limit=20` uses the same query builder, rate limit, limit bounds, and segments. `folder` is ignored; a `collection` that is neither `all` nor a UUID is 400.

```ts
type RowSearchHit = { rowId: string; collectionId: string; collectionName: string; title: Segment[]; snippet: Segment[]; updated_at: string };
```

→ 200 `{ results: RowSearchHit[], truncated }`. The live `readableCollection` rule is applied in the query before `LIMIT` (T60); binned rows and rows of binned collections never match. The title is the primary field; the body is the other text, url, number, and date values and chosen option labels. Note titles and file names are never indexed (T59). Rows are indexed in the transaction that writes them (`collection_row_search` + `collection_row_fts`), a schema change reindexes its collection, and boot reconciles entries whose `source_revision` or `schema_version` is stale.

## Tasks (Wave 9)

Task Boards ([WAVES_7-9.md](WAVES_7-9.md) §3). Every endpoint is under `/api/tasks`, takes and returns JSON, and inherits the global session, Origin, CSRF, `Content-Type: application/json`, and TOTP rules. Path ids are UUIDs (400 otherwise) and are always joined to a board the caller can read.

**Roles (D38, D39; levels since Wave 32).** A board's readers are its owner, its members and groups when `visibility = 'selected'`, and every user when `visibility = 'all_users'`. Readers at `edit` (every member before Wave 32, and the default) create, edit, move, and bin cards; `comment` comments and reacts; `view` reads; managers also rename the board and change its columns, tags, and sprints (see "Groups, levels, and item access"). Only the owner deletes it and uses the `/sharing` route. A caller who cannot read the board gets **404**; a reader below the level an endpoint needs gets **403** `{ error, code: "READ_ONLY" | "MANAGER_REQUIRED" | "OWNER_ONLY" }`. Binned boards are unreadable for everyone.

**Caps** (409 `{ error, code: "LIMIT_REACHED" }`): 50 live boards per owner, 20 columns per board, 1000 live cards per board.

```ts
type BoardSummary = {
  id: string; name: string;          // 1–120 characters, trimmed, no control characters
  owner_id: string; owner_name: string; is_owner: 0 | 1;
  visibility: Visibility;
  card_count: number;                // live cards
  created_at: string; updated_at: string;
};
type BoardColumn = {
  id: string; board_id: string; name: string /* 1–60 */; position: number;
  is_done: 0 | 1;                    // migration 011
  wip_limit: number | null;          // Wave 13 (D108): 1–1000, or null for no limit
  state: "todo" | "doing" | "done";  // migration 020 (D141); is_done = (state = "done")
  created_at: string; updated_at: string;
};
```

Positions are computed by the server (D40) and never accepted from clients: a new item goes to the midpoint of its neighbours, to last + 1024 at the bottom, or to half the first position at the top. When a gap would drop below 1e-6, the whole column (or the board's column list) is renumbered to 1024, 2048, … and the response says `renormalized: true`. Ordering changes run under the `board:<id>` lock.

### Boards

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /boards` | any | 200 `{ boards: BoardSummary[] }`: owned boards first, then shared ones, each by name (limit 500) | |
| `POST /boards { name, template?, tz? }` | any | 201 `{ board, columns }`. Without `template` (or `kanban`): To do, Doing, Done at 1024, 2048, 3072. `template` (17A, D136) is one of `kanban`, `todo`, `checklist`, `scrum`, `epics`, `triage`, `content` (`shared/boardStructure.ts` `TEMPLATES`): it sets the columns with their states, the structure, and for `triage` the tags Bug and Regression; no template creates cards (the Scrum sprint is 17B). Audit `task.board_create` adds `template` when not `kanban` | 400 (an unknown template or `tz`), 409 `LIMIT_REACHED` |
| `GET /boards/:b` | reader | 200 `{ board, columns, cards: BoardCard[], users: Record<userId, { display_name, can_read }>, tags: BoardTag[] }` (columns and cards by position, tags by name). Wave 13 adds `tags`, and each card adds `relation_count` and `open_blockers` for this viewer (§ Relations). **v0.9.0 (D113 trim):** `BoardCard` is `CardSummary & RelationCounts` without `board_id`, `assignees`, `assignee_id`, and `assignee_name`, plus `assignee_ids: string[]` (assignment order); `users` names every assignee on the board once, with `can_read` for this board. `GET /cards/:k`, the card write responses, and MCP keep `assignees[]` objects. | 404 |
| `PATCH /boards/:b { name }` | owner | 200 `{ board }` | 400, 403, 404 |
| `DELETE /boards/:b` | owner | 200 `{ ok: true, purgeAfter }`: the board moves to the Bin for 30 days | 403, 404 |

The board and its cards stay together in the Bin; see § Bin for restore and purge. Audit: `task.board_restore`, `task.card_restore`, `task.board_purge`, `task.card_purge { reason: "user" | "retention" }`.

### Sharing

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /boards/:b/sharing` | owner | 200 `{ visibility, users: [{ id, display_name }] }` | 403, 404 |
| `PUT /boards/:b/sharing { visibility: "private" \| "selected" \| "all_users", userIds ≤ 100 }` | owner | 200 `{ ok: true }` | 400, 403, 404 |

Same rules as folder sharing: the owner cannot be a recipient (400), `selected` needs at least one user (400), every user must exist and be enabled (400), and member rows are kept only for `selected`. Removing a member revokes access at once.

### Columns

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /boards/:b/columns { name, afterColumnId? }` | owner | 201 `{ column, columns }`. Omitted `afterColumnId` appends; `null` puts the column first. | 400, 403, 404 (board, or an anchor not on this board), 409 `LIMIT_REACHED` |
| `PATCH /columns/:c { name?, afterColumnId?, isDone?, state?, wipLimit? }` | owner | 200 `{ column, columns, renormalized? }`. Columns carry `is_done: 0 \| 1` (migration 011); a new board's Done column starts at 1. `wipLimit` is an integer 1–1000 or `null` (Wave 13, D108) and may be set below the current count. | 400 (no field, after itself, or a bad limit), 403, 404 |
| `DELETE /columns/:c` | owner | 200 `{ ok: true, columns }` | 403, 404, 409 `COLUMN_NOT_EMPTY` (with `cardCount`) or `LAST_COLUMN` |

Binned cards do not block deleting their column; they keep `column_id = NULL` and restore to the first column.

**WIP limits (Wave 13, D108, T96).** A hard block, checked under the `board:<id>` lock for REST and MCP: creating a card in a column, or moving one in **from another column**, returns 409 `{ error, code: "COLUMN_FULL", columnId, wipLimit, cardCount }` when the column already holds `wipLimit` or more live cards. Moving within a column and moving out are always allowed, and a Bin restore never fails because of a limit (it may put the column over it). Audit: `task.column_wip { boardId, columnId, wipLimit }`.

### Cards

```ts
type CardSummary = {
  id: string; board_id: string; column_id: string; position: number;
  title: string;                     // 1–200 characters, trimmed, no control characters
  has_description: 0 | 1;            // the board view never carries descriptions
  description_excerpt: string;       // Wave 13 (D111): plain text of the description, at most 160 characters (code points), '' without one
  revision: number;                  // starts at 1, +1 on every title/description edit
  created_by: string | null; creator_name: string | null;
  due_on: string | null;             // YYYY-MM-DD (migration 011); the civil date in due_tz when a time is set
  due_time: string | null;           // Wave 13 (D100): "HH:MM" in due_tz, or null
  due_tz: string | null;             // the IANA zone the setter's browser sent (D101), set exactly when due_time is
  due_at: string | null;             // computed UTC instant (ISO) when due_time is set
  assignees: CardAssignee[];         // Wave 13 (D102): at most 20, in assignment order
  assignee_id: string | null;        // DEPRECATED (D103): assignees[0].id; gone from GET /boards/:b in v0.9.0 (D113 trim)
  assignee_name: string | null;      // DEPRECATED (D103): assignees[0].display_name; same
  tag_ids: string[];                 // Wave 13 (D109): at most 10 tags of this board, in tagging order; resolve against the board's `tags`
  flags: Flag[];                     // Wave 13 (D110): in the fixed order below
  comment_count: number; attachment_count: number;
  created_at: string; updated_at: string;
};
type CardAssignee = { id: string; display_name: string; can_read: 0 | 1 };  // 0: lost board access or disabled ("Former member", T93)
type CardDetail = CardSummary & { description: string };  // Markdown, at most 65,536 UTF-8 bytes
type Flag = "urgent" | "blocked" | "needs_review" | "on_hold";              // Wave 13 (D110), in this order
type BoardTag = { id: string; board_id: string; name: string; color: OptionColor; card_count: number };  // color: the Collections option palette; card_count: live cards carrying it
```

**Due time (Wave 13, D100–D101).** A card may carry a wall time next to its date. The client sends `dueTime` (`HH:MM`, 00:00–23:59) with `dueTz` (`Intl.DateTimeFormat().resolvedOptions().timeZone`); the server checks the zone with `isValidTimeZone` (browser aliases included), stores it as sent, and never converts it. `due_at` comes from `zonedToUtc`: a time inside a DST gap moves forward, and the earlier instant wins in an overlap. Rules (400 otherwise): a time needs a date and a zone; `dueTz` only comes with `dueTime`; `dueTime: null` clears the time and zone; changing only `dueOn` keeps the wall time and zone; `dueOn: null` also clears the time.

**Description excerpt (Wave 13, D111).** `description_excerpt` is derived on the server with the search index's `searchText` (Markdown to plain text, as MCP's `description_preview`), whitespace collapsed, and cut to 160 code points with a trailing `…`. It is written with every description write (create and `PATCH`); a patch without `description` leaves it alone. Cards written before migration 015 are filled at boot by `reconcileCardExcerpts()` (live and binned cards whose description is not empty). Clients render it as text.

**Assignees (Wave 13, D102–D103).** Assignees live in `card_assignees` (migration 015). `cards.assignee_id` is a legacy mirror of the first assignee, rewritten in the same transaction, for a rollback to v0.7.x only. Every user being **added** must be enabled and able to read the board (400 `ASSIGNEE_NOT_MEMBER`); a former member already on the card may stay until any reader removes them. Assigning never grants access.

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /boards/:b/readers?q=&limit=` | reader | 200 `{ users: { id, displayName }[], truncated }`: everyone who can open the board (owner plus members, or every enabled user on an `all_users` board), display names only, for the assignee picker. Without `q`: at most 200 by name. With `q` (1–64 characters): a case-insensitive `instr` match on the display name (no wildcards), at most `limit` (1–50, default 20; `limit` needs `q`) | 400, 404, 429 `RATE_LIMITED` with `Retry-After` (60 a minute per user, T92) |
| `POST /boards/:b/cards { columnId, title, description?, dueOn?, dueTime?, dueTz?, assigneeIds? (≤ 20), tagIds? (≤ 10), flags?, relations?: { targetCardId, type: RelationType }[] (≤ 50), attachmentIds? (≤ 50), afterCardId? }` | reader | 201 `{ card: CardDetail, renormalized? }`. Omitted `afterCardId` = bottom, `null` = top. The composer's one call: assignees, tags, flags, relations (seen from the new card, each audited `task.relation_create`, same rules as `POST /cards/:k/relations`: readable target, one per pair, 50 per card, no revision change on the target), and attachments (the caller's own `task_attachment` uploads that no card links yet, each audited `task.attachment_link`) are written in one transaction. `COLUMN_FULL` is checked first, and any refusal writes nothing. | 400 (including `ASSIGNEE_NOT_MEMBER`, more than 10 tags, an unknown or repeated flag, an unknown relation type, the same `targetCardId` twice in `relations`, or extra keys), 404 (board, a column not on this board, a tag not on this board, a relation target that is missing, binned, or unreadable, or a file that is not the caller's live attachment upload), 409 `COLUMN_FULL`, `STALE_POSITION`, `LIMIT_REACHED`, or `ATTACHMENT_LINKED` (the file is already on a card) |
| `GET /cards/:k` | reader | 200 `{ card: CardDetail, comments: CardComment[], hasMoreComments, attachments: CardAttachment[], relations: CardRelation[] }`: the newest 50 comments in chronological order, every live attachment, and the card's relations as this viewer sees them, newest first (at most 50, § Relations) | 404 |
| `PATCH /cards/:k { title?, description?, dueOn?, dueTime?, dueTz?, assigneeIds?, assigneeId?, tagIds?, flags?, revision }` | reader | 200 `{ card }` with `revision + 1`, exactly once however many fields change (one transaction). `dueOn` is a real date `YYYY-MM-DD` (1900–2999) or `null`; `dueTime`/`dueTz` follow the due-time rules above; `assigneeIds` (≤ 20 after deduplication) replaces the whole set and `[]` clears it; the legacy `assigneeId` (a user or `null`) means `[id]` or `[]` (D103) and is refused on a card that has more than one assignee (409 `ASSIGNEES_MULTIPLE`) rather than dropping the others; `tagIds` (≤ 10 after deduplication) and `flags` each replace the whole set, and `[]` clears it; omitted fields are unchanged | 400 (including `ASSIGNEE_NOT_MEMBER` when a new assignee is disabled or cannot read the board, `assigneeId` sent together with `assigneeIds`, more than 10 tags, and an unknown or repeated flag), 404 (the card, or a tag not on the card's board), 409 `{ code: "CARD_CHANGED", card }` (the current card, every field) when `revision` is not the stored one, 409 `{ code: "ASSIGNEES_MULTIPLE", assignees }` (the current assignees) when the legacy `assigneeId` is sent for a card with several assignees; send `assigneeIds` instead |
| `POST /cards/:k/move { columnId, afterCardId }` | reader | 200 `{ card, renormalized?, positions? }`. `afterCardId: null` = top. `positions` lists `{ id, position }` for the whole target column after a renumber. | 400, 404 (card, or a column not on the card's board), 409 `STALE_POSITION`, or `COLUMN_FULL` when moving in from another column |
| `DELETE /cards/:k` | reader | 200 `{ ok: true, purgeAfter }`: the card moves to the Bin and keeps its column | 404 |

- **Stale positions.** `afterCardId` must be another live card in the target column. Otherwise (binned, in another column or board, the moved card itself, or unknown) the response is 409 `{ error, code: "STALE_POSITION", columnId, order: string[] }`, where `order` is the target column's live card ids in their current order.
- **Moves** stay on the card's board and do not change `revision`, so an open editor can still save.
- Binned cards and cards on binned boards return 404 on every card route. They are restored through `POST /api/bin/card/:id/restore` (§ Bin).

### Relations (Wave 13, D104–D107)

Typed, non-structural links between two cards, on the same board or on different boards. Three kinds are stored in `card_relations` (migration 015): `relates` (symmetric, stored with `source < target`), `blocks` (source is needed before target), and `duplicates`. The API shows five types, always **from the card in the path**:

| Type sent or shown from card X toward Y | Stored `(source, target, kind)` | How Y shows it |
| --- | --- | --- |
| `relates_to` | `(min, max, relates)` | `relates_to` |
| `needed_by` (X blocks Y) | `(X, Y, blocks)` | `depends_on` |
| `depends_on` (Y blocks X) | `(Y, X, blocks)` | `needed_by` |
| `duplicates` | `(X, Y, duplicates)` | `duplicated_by` |
| `duplicated_by` | `(Y, X, duplicates)` | `duplicates` |

There is one relation per unordered pair, whatever its kind. There is no parent or sprint kind (the hierarchy wave adds `cards.parent_card_id`).

```ts
type RelationType = "relates_to" | "depends_on" | "needed_by" | "duplicates" | "duplicated_by";
type CardRelation =
  | { id: string; type: RelationType; restricted: false; created_at: string; creator_name: string | null;
      card: { id: string; board_id: string; board_name: string; title: string; column_name: string | null; is_done: 0 | 1; due_on: string | null } }
  | { id: string; type: RelationType; restricted: true; created_at: string };   // nothing else (T90)
type RelationCounts = {
  relation_count: number;   // relations visible to this viewer: restricted rows count, hidden binned ones do not
  open_blockers: number;    // readable, live depends_on cards not in a done column
};
```

**Per-viewer resolution (D105, T90).** Each relation resolves for the caller on every read:

- the other card is live and on a board the caller can read: `restricted: false` with the card's fields
- the caller is not in the other board's audience (owner, members, or everyone on `all_users`): `restricted: true` with only `id`, `type`, `restricted`, and `created_at` (no card id, title, board, or creator), whether or not that card or board is binned, so binning is never disclosed
- the caller is in the audience but the other card or its board is in the Bin: **hidden**, and back when it is restored (binning never removes relation rows). Purging a card or board deletes its relations (cascade)

Links never grant access. Relations are **edges** (D107): they have their own endpoints and never change either card's `revision` or `updated_at`, so linking from another board never raises `CARD_CHANGED` for someone editing the card.

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /cards/:k/relations { type, cardId }` | reader of both cards | 201 `{ relation: CardRelation }`, seen from `k`. Runs under `k`'s board lock | 400 (a relation to itself, an unknown type, extra keys), 404 (`k` or `cardId` missing, binned, or unreadable; all look the same), 409 `{ code: "RELATION_EXISTS", relation }` (the existing relation seen from `k`, in either direction and of any kind; checked only after both cards are readable) or `LIMIT_REACHED` (50 relations per card, on either end) |
| `DELETE /cards/:k/relations/:r` | reader of `k` | 200 `{ ok: true }`. `k` must be one end of `r`; a restricted relation may be removed, since it is metadata on the caller's own card | 404 (`k`, or `r` not a relation of `k`) |
| `GET /cards/search?q=&boardId?&excludeCardId?&limit?` | any | 200 `{ results: { id, board_id, board_name, title, column_name, is_done }[], truncated }` for the relation picker (D106): live cards on live boards the caller can read whose title contains `q` (trimmed, 1–100 characters), case-insensitive `instr` (so `%` and `_` are literal), at most `limit` (1–20, default 20). Order: cards on `boardId` first (a hint only, never a filter or an access check), then titles starting with `q`, then `updated_at DESC`. `excludeCardId` drops the card being edited. Titles only, never descriptions | 400, 429 `RATE_LIMITED` with `Retry-After` (20 per 10 s per user, the `/api/search` window in its own bucket, T95) |

`GET /cards/search` belongs to Tasks, not to `/api/search`; it keeps working when the Search module is hidden (D92).

### Tags and flags (Wave 13, D109, D110, T101)

Tags belong to one board: at most 100 per board (409 `LIMIT_REACHED`), names of 1–40 characters (trimmed, no control or bidi characters) unique ignoring case, and a colour from the Collections option palette (`gray`, the default, `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`). **Any reader creates a tag**; **only the owner** renames, recolours, or deletes one. A card carries at most 10 tags, each of its **own** board: a tag id from any other board is 404 `Tag not found`, even for a user who reads both boards, exactly like an unknown id. Flags are the fixed set `urgent`, `blocked`, `needs_review`, `on_hold`, each at most once; `blocked` is a manual flag, separate from the relation-derived blocker count (13D). Tags and flags are card **fields** (D107): they change through `PATCH /cards/:k` with the revision compare-and-swap, and `CARD_CHANGED` carries them.

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /boards/:b/tags { name, color? }` | reader | 201 `{ tag: BoardTag }`. Without `color` the tag takes the first palette colour (grey excluded) no tag of the board uses yet, looking from the slot the board's tag count points at, so a board cycles through the palette (operator QA 0.9.1) | 400, 404, 409 `{ code: "TAG_EXISTS", tag }` (a name that matches ignoring case, with the existing tag so a picker can use it; checked before the cap) or `LIMIT_REACHED` |
| `PATCH /tags/:t { name?, color? }` | owner | 200 `{ tag: BoardTag }`. Renaming to another case of its own name is allowed | 400 (no field), 403 `OWNER_ONLY`, 404 (unknown, or a board the caller cannot read), 409 `TAG_EXISTS` |
| `DELETE /tags/:t` | owner | 200 `{ ok: true, removedFrom }`: the tag is deleted with no Bin and unlinked from every card, binned ones included (`removedFrom` counts them all). No card's `revision` changes | 403 `OWNER_ONLY`, 404 |

A binned card keeps its tags and flags; a restore brings back the tags that still exist. Audit (ids only): `task.tag_create { boardId, tagId }`, `task.tag_update { boardId, tagId, renamed?, color? }`, `task.tag_delete { boardId, tagId, removedFrom }`; `task.card_update` and `task.card_create` add `tagsAdded`, `tagsRemoved`, and the resulting `flags` when those fields are sent.

### Comments

```ts
type CardComment = {
  id: string; card_id: string;
  author_id: string | null; author_name: string | null;  // null once the author's account is deleted
  is_author: 0 | 1;
  body: string;                        // plain text, 1–16,384 UTF-8 bytes, not only whitespace
  created_at: string; edited_at: string | null;
  reactions: ReactionAggregate[];      // Wave 20, § Reactions; [] when none
};
```

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /cards/:k/comments?before=<commentId>&limit=1–50` | reader | 200 `{ comments, hasMore }`: the `limit` comments before `before` (or the newest), in chronological order | 400, 404 (card, or `before` not a comment of this card) |
| `POST /cards/:k/comments { body, attachmentIds? }` | reader | 201 `{ comment }`. The author is always the session user. `attachmentIds` (≤ 10) are linked through the comment, with the linking rules below. | 400, 404 (card, or a file that is not the caller's live attachment), 409 `LIMIT_REACHED` (500 comments per card, 10 attachments per comment, 50 per card) |
| `PATCH /comments/:m { body }` | author | 200 `{ comment }` with `edited_at` set | 400, 403 `AUTHOR_ONLY`, 404 |
| `DELETE /comments/:m` | author or board owner | 200 `{ ok: true }`. Comments are deleted outright, not binned; links made through the comment go with it. | 403 `AUTHOR_ONLY`, 404 |

Comments on binned cards, binned boards, or boards the caller can no longer read return 404.

### Reactions (Wave 20, D182–D190, migration 022)

People who may comment may react to a comment with one of 12 fixed emoji. Keys, not glyphs, are stored and sent (`shared/reactions.ts`): `thumbs_up` 👍, `thumbs_down` 👎, `heart` ❤️, `laugh` 😂, `tada` 🎉, `eyes` 👀, `rocket` 🚀, `check` ✅, `fire` 🔥, `thinking` 🤔, `pray` 🙏, `sad` 😢.

```ts
type ReactionAggregate = {
  emoji: ReactionKey;   // one of the 12 keys
  count: number;        // everyone who reacted with it (blocked accounts are not counted while blocked)
  reacted: boolean;     // the caller is one of them
  names: string[];      // the other people (never the caller), oldest first, at most 10
  more: number;         // the other people beyond those 10: count = names.length + more + (reacted ? 1 : 0)
};
```

Each comment's `reactions` is ordered by the first reaction's time and comes from one grouped query per comment page (at most 50), in `GET /cards/:k`, `GET /cards/:k/comments`, and the comment create and edit responses.

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `PUT /comments/:m/reactions/:emoji` | a reader of the card whose role may write content | 200 `{ reactions: ReactionAggregate[] }` for that comment. Idempotent: already reacted is still 200 with no change. | 400 `INVALID_EMOJI`, 403 `ROLE_READ_ONLY` (viewers and guests, the write gate), 404 (unknown, unreadable, or on a binned card or board), 429 `RATE_LIMITED` with `Retry-After` |
| `DELETE /comments/:m/reactions/:emoji` | same | 200 `{ reactions }`. Idempotent: absent is still 200. | same |
| `PUT` and `DELETE /api/reactions/:kind/:targetId/:emoji` | same, per kind | The generic form of the two above; v1 registers only `card_comment` (`server/reactions/targets.ts`). | 404 for an unknown or malformed kind or id, otherwise as above |

The body is empty; the session, Origin, JSON `Content-Type`, CSRF, TOTP, and role gates still apply. The UI "toggle" chooses the verb from the chip's current state, so a retry or a double tap never flips twice. Writes are limited to 60 a minute per user (in memory). Reactions are not audited, create no notifications, are not searchable, and never change the card's `revision` or `updated_at`. Deleting a comment, or purging its card or board, deletes its reactions (a trigger on `card_comments`); a binned card's reactions are hidden until it is restored. A later module adds its own kind with `registerReactionTarget` and a cleanup trigger, with no change to the table.

### Attachments

```ts
type CardAttachment = {
  document_id: string; card_id: string;
  comment_id: string | null;           // set when linked through a comment
  linked_by: string | null; linker_name: string | null;
  name: string; mime_type: string; preview_kind: PreviewKind; size_bytes: number;
  created_at: string;                   // when it was linked
};
```

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /cards/:k/attachments { documentId, commentId? }` | reader | 201 `{ attachment }`, or 200 when this owner already linked it | 400, 404 (card; a document that is not a live `task_attachment` owned by the caller; a comment that is not the caller's own on this card), 409 `LIMIT_REACHED` (50 per card, 10 per comment) |
| `DELETE /cards/:k/attachments/:d` | linker or board owner | 200 `{ ok: true, movedToBin }` | 403 `LINKER_ONLY`, 404 |

- **Reading (D43).** `GET /api/files/:id` and `/content` also admit a caller when the live document is linked to a live card on a board they can read. This never applies to lists. Access ends the moment the member is removed, the card or board is binned, the comment is deleted, or the link is removed.
- **Lifecycle (director review §7).** Unlinking never deletes the file directly. When a document loses its last link (unlink, comment deleted, card or board purged), it moves to its uploader's Bin with `deleted_by` = the actor, and purges 30 days later. Binning a card keeps its links, so restoring the card brings its attachments back.
- **Discard and never linked (Wave 13, §5.6, T100).** A client that uploaded files it will not attach (the composer's "Don't attach", a cancelled comment) discards each with `DELETE /api/files/:id`: only the uploader can, anyone else gets the same 404 as a missing id, and a linked file is 409 `ATTACHMENT_LINKED`. The file moves to the uploader's Bin (`document.delete { documentId }`), and restoring it there makes it an ordinary Files item. Anything the client leaves behind is caught by the hourly sweeper: a live `task_attachment` with no `card_attachments` row that is more than 24 hours old moves to its uploader's Bin (100 per run, `deleted_by = NULL`, audit `document.delete { documentId, reason: "attachment_never_linked" }`).
- Inline images in a description use the same content URL, `/api/files/:id/content?disposition=inline`.

**Audit** (ids only, never names or text): `task.board_create`, `task.board_rename`, `task.board_delete`, `task.board_sharing_changed { boardId, visibility, recipientCount }`, `task.column_create`, `task.column_rename`, `task.column_move`, `task.column_delete`, `task.column_wip { wipLimit }`, `task.card_create { assigneesAdded? }`, `task.card_update { dueOn?, dueTime?: "set" | "cleared", assigneeId?, assigneesAdded?, assigneesRemoved? }` (counts, not ids), `task.card_move { boardId, cardId, columnId }`, `task.card_delete`, and `task.comment_create` / `task.comment_update` / `task.comment_delete { boardId, cardId, commentId }`, `task.attachment_link` / `task.attachment_unlink { boardId, cardId, documentId, commentId? }`, `task.relation_create` / `task.relation_delete { boardId, cardId, relationId, kind }` (`boardId` and `cardId` are the path card's, `kind` the stored kind), and `document.delete { documentId, reason: "attachment_unlinked" }` when an unlinked file moves to the Bin, each with `{ boardId, columnId?, cardId? }`.
### Hierarchy (sub-wave 17A, D120–D135, migration 019)

Cards form a tree of at most three levels on one board. `level` 0 is the top ("Epic"), 1 sits under it, 2 under that; the names come from the board's structure (§ Board structure). A card's parent is optional at and above the board's work level (an orphan story is fine), but **required below it**: a subtask is created, reparented, or re-levelled only under a parent (400 `PARENT_REQUIRED`, operator QA 0.9.1). The one exception is a subtask restored while its parent is in the Bin, which comes back detached (D130): it stays readable and editable, and the next placement change must name a parent or move it to the work level. When set, the parent is a **live card on the same board exactly one level up** (D121). Levels strictly increase downward, so a cycle is impossible and no ancestor walk is ever needed (T110); two triggers in 019 refuse any write that would break the rule, as a backstop to the service.

```ts
type CardSummary = /* … */ & {
  parent_card_id: string | null;     // same board, one level up (D121)
  level: 0 | 1 | 2;                  // below the board's level count
  child_count: number;               // live direct children
  done_child_count: number;          // of those, in a done column (D125)
};
type ChildCard = { id; title; level; column_id; column_name; is_done: 0 | 1; position; due_on; child_count; done_child_count };
// GET /cards/:k adds, on the card:
type CardHierarchy = {
  parent: { id; title; level } | null;
  ancestors: { id; title; level }[];  // root first, at most 2 (the breadcrumb)
  children: ChildCard[];              // live direct children by column position, then card position, at most 100
};
```

| Endpoint | Who | Change | Errors |
| --- | --- | --- | --- |
| `POST /boards/:b/cards` | reader | adds `parentId?: uuid \| null` and `level?: 0–2`. The level defaults to the parent's plus one, else the board's work level. | 400 `PARENT_INVALID` (unknown, another board, binned, the card itself, or not one level up: always the same code and message, T113), 400 `LEVEL_INVALID` (at or past the board's level count), 400 `PARENT_REQUIRED { level }` (a level below the work level with no parent; the message reads "Pick the task this subtask belongs to, or make it a task"), 409 `LIMIT_REACHED` (the parent has 100 live children) |
| `PATCH /cards/:k` | reader | adds `parentId?: uuid \| null` (reparent, D128) and `level?: 0–2` ("Change level"), under the revision CAS like every field (`revision + 1`). Without `level` the card keeps its level, so a new parent must be one level up; send both to move a card to another level. A card with live children cannot change level; children that were binned on their own are detached, so they restore without a parent (D130). Detaching a subtask (`parentId: null`) or moving a card below the work level without a parent is 400 `PARENT_REQUIRED`; send `{ level: workLevel, parentId: null }` to make it a work-level card instead. A PATCH that sends neither `parentId` nor `level` never checks the parent, so a detached subtask keeps working. | as above, plus 409 `HAS_CHILDREN { childCount }` and 409 `CARD_CHANGED` |
| `GET /cards/:k/children` | reader | `{ children: ChildCard[] }` | 404 |

- **Roll-ups (D125, D134).** `child_count` and `done_child_count` count a card's live direct children and those in an `is_done` column. `GET /boards/:b` and MCP `list_cards` compute them with one grouped query per board, never a per-card subquery; the board payload has every live card at every level, so a client can also derive them locally. A parent never moves on its own when its children do.
- **Audit** (ids only): `task.card_create` adds `parentId` and `level` when set; `task.card_reparent { boardId, cardId, parentId }`; `task.card_level { boardId, cardId, level }`.
- **WIP limits** count every card in a column, whatever its level (§8, Q7).
- There is no endpoint that changes a card's board, so a parent never ends up on another board (T112).

### Board structure (sub-wave 17A, D122, D123, T120)

```ts
type BoardStructure = {
  levels: { name: string; plural: string }[];   // 1–3, top first; names 1–24 characters, trimmed, no control characters
  workLevel: number;                              // 0 … levels.length − 1: where new cards are created and what columns show
  sprints: boolean;                               // "Sprint ›" is the outer grouping (17B); never a card level
  sprintDefaults?: {                              // optional (2026-09-27): what a new sprint starts with on this board
    days: number;                                 // 1–60, start and end included
    start: "next" | "today" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";  // the day after the previous open sprint ends (else today), today, or that weekday on or after "next"
    name?: string;                                // 1–40 characters with exactly one "{n}" ("Sprint {n}"), trimmed, no control characters; absent: follow the latest sprint's name
  };
};
```

`BoardSummary` adds `structure` (every board starts Flat: `{ levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false }`). Presets (`shared/boardStructure.ts`): Flat, Task › Subtask, Sprint › Task, Sprint › Task › Subtask, Epic › Story › Subtask (work level Story); anything else is Custom. `sprintDefaults` never changes the preset. It lives in `boards.structure_json` (no migration; the largest structure with defaults stays under the 1024-character CHECK). The Scrum template sets `{ days: 14, start: "next", name: "Sprint {n}" }`; a board without defaults suggests a sprint as long as the latest one, named after it. `{n}` is one more than the highest number any of the board's sprints has in that pattern, skipping names in use. The defaults only suggest: `POST /boards/:b/sprints` still takes explicit dates.

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `PATCH /boards/:b { name?, structure? }` | owner | 200 `{ board }`; at least one field. A `structure` without the `sprintDefaults` key keeps the stored defaults (so a levels-only save never drops them); `sprintDefaults: null` clears them | 400 (an invalid structure, with `details`), 403, 404, 409 `LEVEL_IN_USE { level, cardCount, binnedCount, levels: [{ level, name, cardCount }] }` (a card, live or in the Bin, sits at a level being removed), 409 `SPRINTS_IN_USE` (sprints turned off while sprints are open, or the work level moved while cards carry a sprint) |

Audit: `task.board_structure { boardId, levels, workLevel, sprints }` (counts only, no names).

### Sprints (sub-wave 17B, D124, D131, D132, D135, T118)

A sprint is its own entity (`board_sprints`, migration 019), never a card level. A board with `structure.sprints` has any number of sprints; **at most one is active** (a partial unique index). Only **work-level** cards store a sprint; a card below the work level has its parent's sprint (derived on every read, never stored), and a card above it has none. Sprint management is **owner-only** (D132); any reader plans cards into sprints, since that is a card field.

```ts
type SprintSummary = {
  id; board_id; name: string /* 1–60 */; goal: string /* ≤ 500 */;
  start_on: string | null; end_on: string | null;            // YYYY-MM-DD, start ≤ end
  state: "planned" | "active" | "completed";                  // stored as planned/active/closed
  is_active: boolean; position: number; completed_at: string | null;
  card_count: number; done_count: number;                     // live cards stored in it (work level), and those in a done column
  created_at; updated_at;
};
type CardSummary = /* … */ & { sprint_id: string | null };   // stored (work level) or inherited (below), null above and in the backlog
```

`GET /boards/:b` adds `sprints: SprintSummary[]`: every open sprint (the active one first, then planned by position) plus the five latest completed ones (`[]` on a board that never had sprints).

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /boards/:b/sprints?state=&cursor=&limit=` | reader | 200 `{ sprints, nextCursor }`. Without `state`: every open sprint, then completed ones newest first, paged (`limit` 1–100, default 20). `state=planned\|active\|completed` narrows it; `cursor` continues the completed pages. | 400 (`state`, `limit`, `CURSOR_INVALID`), 404 |
| `POST /boards/:b/sprints { name, goal?, startOn?, endOn? }` | owner | 201 `{ sprint }`, planned, at the end | 400, 403, 404, 409 `SPRINTS_OFF` (the board plans no sprints), 409 `LIMIT_REACHED` (50 planned or active) |
| `PATCH /sprints/:s { name?, goal?, startOn?, endOn?, afterSprintId?, state?: "active" }` | owner | 200 `{ sprint }`. `afterSprintId` (null = first) reorders an open sprint; `state: "active"` starts a planned sprint | 400 (end before start, anything but `active`), 403, 404, 409 `SPRINT_ACTIVE { activeSprintId }`, 409 `SPRINT_COMPLETED` |
| `DELETE /sprints/:s` | owner | 200 `{ ok }`; only a planned sprint no live card is planned in (binned cards in it fall back to no sprint) | 403, 404, 409 `SPRINT_NOT_PLANNED`, 409 `SPRINT_NOT_EMPTY { cardCount }` |
| `POST /sprints/:s/complete { carryTo, name?, startOn?, endOn? }` | owner | 200 `{ sprint, carried, doneCount, target, created }`. Completes the active sprint with carry-over in one transaction under the board lock (D131, T118): its live cards outside a done column at that moment move to `carryTo` with `revision + 1`; cards in a done column stay with the completed sprint; subtasks follow their parent. `carryTo`: `next` (the first planned sprint), `backlog` (no sprint), `new` (a sprint created in the same call: `name` defaults to the board's name pattern, else the next number, "Sprint 13"; the dates to the board's default length, else this one's, from today, moved to the default start weekday when one is set), or a planned sprint's id. `name`, `startOn`, and `endOn` go only with `new`. `target` is the destination sprint (null for the backlog). | 400, 403, 404 (a sprint that is not a planned sprint of this board), 409 `SPRINT_NOT_ACTIVE`, 409 `NO_NEXT_SPRINT`, 409 `LIMIT_REACHED` (`new` at 50 open) |
| `POST /boards/:b/cards` | reader | adds `sprintId?: uuid \| null`; `null` files the card in the backlog. **Omitted**, a card at the work level of a board with sprints on joins the board's active sprint when there is one (v0.11.0 Friction 3: routines and MCP clients rarely pass it), else the backlog; below the work level nothing is stored. The app always sends it (the Backlog stays reachable through the sprint switcher) | 400 `SPRINTS_OFF`, 400 `SPRINT_LEVEL` (below or above the work level), 404 (a sprint of another board or unknown), 409 `SPRINT_COMPLETED` |
| `PATCH /cards/:k` | reader | adds `sprintId?: uuid \| null` under the revision CAS (`revision + 1`); `null` puts the card in the backlog. A "Change level" away from the work level clears the stored sprint. | as above, plus 409 `CARD_CHANGED` |

- A sprint id is joined to its board: a sprint of a board the caller cannot read is 404, whatever the action.
- `PATCH /boards/:b` refuses `sprints: false` while sprints are open, and a work-level change while cards carry a sprint (409 `SPRINTS_IN_USE`, § Board structure).
- The **Scrum sprint board** template (`POST /boards { template: "scrum" }`) also creates a planned "Sprint 1" for two weeks (its `sprintDefaults.days`) from today in `tz` (the creator's IANA zone, as the web app sends), else UTC. Completing a sprint into a new one (`carryTo: "new"`) dates it from today, as long as the completed one, never after an end date that has not come yet; completed on its last day, it starts tomorrow.
- **The board page** keeps the sprint on screen in its URL as `?sprint=backlog|all|<id>`, beside `view`, `group`, and `sort` (absent = the current sprint: the active one, else the backlog), and carries it through card routes. It scopes every view with one more `sprint:` term (§ Filter grammar); the filter bar keeps only the viewer's own terms. Picking a sprint pushes a history entry (a committed choice, like the view switch).
- **Audit** (ids only): `task.sprint_create { boardId, sprintId }`, `task.sprint_update { boardId, sprintId, fields }`, `task.sprint_start`, `task.sprint_delete`, `task.sprint_complete { boardId, sprintId, carried, doneCount, carryTo: "next" | "backlog" | "new" | "sprint", targetSprintId? }` (a `new` target is also a `task.sprint_create`); `task.card_create` and `task.card_update` add `sprintId` when it is set or changes. Carried cards get no per-card audit row: the completion row counts them.

### Filter grammar (sub-wave 17C, D137, D140–D145)

One grammar for the board filter bar (13E), cross-board queries, saved views, URLs, and MCP. It lives in `shared/taskQuery.ts`, a pure module that the server and the client both import (research 2026-09-26 §10.3, Q10). A query is terms separated by spaces: **terms AND together**, the **values of one term OR together**, and a leading `-` negates a term.

```text
assignee:me state:todo,doing due:overdue,week
board:<uuid> column:<uuid> -tag:"Needs design",none flag:blocked "invoice"
```

| Key | Values | Meaning |
| --- | --- | --- |
| `board` | uuid | the card's board. A board the caller cannot read matches nothing (never an error) |
| `state` | `todo`, `doing`, `done` | the column's normalized state (migration 020) |
| `column` | uuid | only with exactly one positive `board:` value (or on a board page), else 400 `FILTER_SCOPE` |
| `assignee` | `me`, `none`, uuid | any assignee matches; `none` = no assignees |
| `creator` | `me`, uuid | who created the card |
| `tag` | `none`, uuid, or a name (1–40) | names match board tags case-insensitively, so one name works across boards |
| `flag` | `urgent`, `blocked`, `needs_review`, `on_hold`, `none` | the manual card flags |
| `due` | `overdue`, `today`, `week`, `next-week`, `none`, `YYYY-MM-DD`, `<YYYY-MM-DD`, `>YYYY-MM-DD` | relative values use the caller's `tz`; `week` is today plus six days, `next-week` the seven after; `overdue` is a date before today, or a timed card due today whose wall time has passed. `before:D`/`after:D` are accepted as `<D`/`>D` |
| `parent` | `none`, uuid | the card's parent (17A); `none` = no parent. Parents are on the same board, so another board's card matches nothing |
| `level` | `work`, `0`, `1`, `2` | the card's level (17A); `work` is each board's own work level |
| `sprint` | `current`, `next`, `none` (`backlog` is read as `none`), uuid | the card's sprint (17B): stored on the work level, the parent's below it, none above it. `current` is each card's own board's active sprint and `next` its first planned one (so they work across boards); a sprint of another board matches nothing |
| `has` | `relation`, `blocked`, `subtasks` | any visible relation; an open `depends_on` blocker; at least one live child (17A) |
| text | `"quoted phrase"` or a bare word | the title or the description excerpt contains it (case-insensitive `instr`, no wildcards) |

- **No reserved keys remain.** `parent:`, `level:`, and `has:subtasks` shipped with 17A and `sprint:` with 17B, in the board's in-memory matcher (`matchesQuery`) and the cross-board compiler alike (`tests/taskQueryParity.test.ts`). `FILTER_UNSUPPORTED` stays in the error vocabulary for keys a later wave reserves.
- **Canonical form.** `format` orders terms by key (`board state column assignee creator tag flag due sprint parent level has text`, positive before negated), dedupes and sorts values, lowercases ids and keywords, and always quotes text. URLs (`?q=`), `task_views.query`, and MCP carry the canonical form.
- **Limits.** At most 2000 characters, 20 terms, 20 values per term, 100 characters per text term. No control or bidi characters.
- **Errors.** `{ code: "FILTER_INVALID" | "FILTER_UNSUPPORTED" | "FILTER_SCOPE", message, position }`, where `position` is the character offset.
- **One grammar with the Wave 13 structured filter.** The same module holds 13C's `CardFilter` and board pipeline (`queryCards`, `sortCards`, used by the client and mirrored by `list_cards` in `server/tasks/cardQuery.ts`). `queryFromCardFilter` gives a structured filter its canonical text, and `cardFilterFromQuery` turns a board-scoped query back into a `CardFilter`, or `null` when it uses what the board pipeline does not model (negation, `board:`, `state:`, `creator:`, `has:`, tag names, relative due windows, repeated keys); those run on the server. `tests/taskQueryParity.test.ts` checks that the three paths agree.
- **URL codec.** `?q=` carries the canonical grammar and is the only filter parameter written. Decoding is lenient (bad terms and values are dropped) and still reads the Wave 13 per-key parameters (`assignee`, `tag`, `flag`, `due`, `column`, `rel=any|blocked|none`, plus `board` and `state`), so older links keep working. Other parameters (`view`, `layout`, `group`, `sort`, and the board's `sprint`, 17B) are left alone.

### Cross-board card query (sub-wave 17C, D144)

`POST /api/tasks/query` is a read sent as POST (like the Collections query). Any signed-in user; the usual session, Origin, and CSRF rules apply.

| Body | Result | Errors |
| --- | --- | --- |
| `{ q?: string (grammar, ≤ 2000, default ""), sort?: "due" \| "updated" \| "created" \| "title" \| "board" (default due), group?: "none" \| "board" \| "state" \| "due", cursor?, limit?: 1–100 (default 50), tz?: IANA (default UTC) }` (no other keys) | `{ query, cards: QueriedCard[], nextCursor: string \| null, total?, refs? }` | 400 `FILTER_INVALID` / `FILTER_UNSUPPORTED` / `FILTER_SCOPE` `{ position }`, 400 `CURSOR_INVALID`, 400 (body), 429 `RATE_LIMITED` with `Retry-After` (30 per 10 s per user) |

```ts
type QueriedCard = {
  id; board_id; board_name; column_id; column_name; column_state: "todo" | "doing" | "done"; is_done: 0 | 1;
  position; title; description_excerpt; revision; created_by; creator_name;
  due_on; due_time; due_tz; due_at;                  // as on the board (Wave 13)
  assignees: CardAssignee[];                         // with can_read, as on the board
  tags: { id; name; color }[]; flags: Flag[];        // flags in the fixed order
  created_at; updated_at;
  parent_card_id; level; parent_title: string | null;  // 17A: the parent on the same board (D138); null when none or binned
  sprint_id: string | null; sprint_name: string | null;  // 17B: the card's sprint (inherited below the work level) and its name
};
type QueryRefs = {                                   // first page only: what the query's ids mean to this caller (T116)
  boards:  ({ id; name } | { id; restricted: true })[];
  columns: ({ id; name; board_id } | { id; restricted: true })[];
  tags:    ({ id; name; color; board_id } | { id; restricted: true })[];
  users:   ({ id; display_name } | { id; unknown: true })[];   // the exposure of GET /api/users
};
```

- **Column state.** `state:` and `column_state` read `board_columns.state` (migration 020).
- **Access.** Only live cards on live boards the caller can read (`readableBoardPredicate`), ANDed before any filter, sort, or limit. A board, column, or tag id the caller cannot read matches nothing and resolves as `restricted`, exactly like an id that does not exist.
- **Order and paging.** Keyset pagination on the group key, then the sort key, then the card id. `due` sorts by date then time with undated cards last; `updated` and `created` are newest first; `title` is case-insensitive; `board` is board name, column position, card position. `group` orders by the group first (board name; state todo → doing → done; due bucket overdue → today → this week → later → none), so a group is one contiguous run across pages; assignee and tag grouping are done by the client within the loaded cards. `nextCursor` is opaque and only continues the same canonical query, sort, and group (and, for date-relative queries, the same zone and date) for the same user: it is signed (HMAC-SHA256 over the user id and the payload, keyed by a per-process secret), so another user's cursor, a tampered one, or one from before a restart is `CURSOR_INVALID` too.
- **`total`** is on the first page only, when at most 1000 cards match. `refs` is on the first page only.
- **Relations** (`has:`) follow the per-viewer relation rules (WAVE_13 D105): a relation to a card the caller cannot read counts, one to a readable binned card does not. `has:blocked` counts only readable, live `depends_on` cards outside a done column.
- **Text** uses ASCII case folding (SQLite `lower`), as the Collections query does; accented capitals and accents do not fold here, while the board pipeline and `list_cards` fold accents in JavaScript. Keyset paging needs the match in SQL, so the cross-board query keeps the SQL match.

### Saved views (sub-wave 17C, D140, migration 020)

A view stores a **question, not an answer**: a name, a canonical filter, and display options. Running it always runs the stored filter **as the viewer**, through the same code as `POST /api/tasks/query`, so sharing a view never shows anyone cards from boards they cannot read (T115). Views are configuration, not content: they are not Bin items.

```ts
type TaskView = {
  id; name /* 1–80, trimmed, no control characters */; owner_id; owner_name; is_owner: 0 | 1;
  visibility: "private" | "selected" | "all_users";
  query: string;                                   // canonical grammar
  display: { layout: "list" | "table" | "board"; group: "none" | "board" | "state" | "due" | "assignee" | "tag";
             sort: "due" | "updated" | "created" | "title" | "board";
             fields?: ("board" | "column" | "state" | "assignees" | "due" | "tags" | "flags" | "updated")[] };
  position: number; revision: number; created_at; updated_at;
};
```

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /views` | any | `{ mine, shared, everyone, truncated }`: the caller's views by position; views shared with them (`selected`) and `all_users` views of others, by name, at most 200 each | — |
| `POST /views { name, query, display? }` | any | 201 `{ view }`, private, at the end of the caller's list. `query` is stored canonical; `display` defaults to list, no group, sort by due | 400 (body, `FILTER_*` with `position`), 409 `LIMIT_REACHED` (50 per owner) |
| `GET /views/:v` | reader | `{ view }` | 404 |
| `PATCH /views/:v { name?, query?, display?, afterViewId?, revision }` | owner | `{ view }` with `revision + 1`. `display` merges into the stored one; `afterViewId` reorders among the owner's views (`null` = first) | 400, 403 `OWNER_ONLY`, 404 (view or anchor), 409 `VIEW_CHANGED` with the current `view` |
| `DELETE /views/:v` | owner | `{ ok: true }` (the client offers Undo by re-creating the same body) | 403, 404 |
| `GET /views/:v/sharing` / `PUT /views/:v/sharing { visibility, userIds ≤ 100 }` | owner | `{ visibility, users: { id, display_name }[] }` / `{ ok: true }`, as board sharing; `PUT` bumps the view's `revision`, so a PATCH with the old one is 409 `VIEW_CHANGED` | 400 (owner as recipient, `selected` without users, unknown or disabled users), 403, 404 |
| `POST /views/:v/duplicate` | reader | 201 `{ view }`: a private copy owned by the caller, named "… (copy)" | 404, 409 `LIMIT_REACHED` |
| `GET /views/:v/cards?cursor&limit&tz` | reader | `{ view, query, cards, nextCursor, total?, refs? }`: the stored filter run as the caller with the view's sort and server-side group (`board`, `state`, `due`; `assignee` and `tag` group on the client) | 400, 404, 429 (shares the query limit) |

- **Readers** are the owner, members for `selected`, and everyone for `all_users`, while the owner is enabled; a disabled owner's views disappear for everyone else. Anyone else gets 404, the same as a missing view. Only the owner edits, reorders, shares, or deletes (403 `OWNER_ONLY`); recipients duplicate instead (§13 Q13).
- **Audit** (ids only): `task.view_create { viewId, sourceViewId? }`, `task.view_update { viewId, renamed?, query?, display?, moved? }`, `task.view_delete`, `task.view_sharing_changed { viewId, visibility, recipientCount }`.

### Column state (sub-wave 17C, D141, migration 020)

Every column has `state: "todo" | "doing" | "done"`, a shared vocabulary across boards for `state:` filters and board lanes. `is_done` stays, and always equals `state = "done"` (T121): the service writes both in one statement.

- The 020 backfill: a done column is `done`; otherwise a board's first column is `todo` and the rest `doing`. New boards get `todo`, `doing`, `done`; a new column is `doing`.
- `PATCH /columns/:c { state? }` (owner) sets the state and `is_done` together. `isDone: true` sets `done`; `isDone: false` on a done column sets `todo` for the board's first column and `doing` otherwise. `isDone` and `state` that disagree are 400. Audit `task.column_state { boardId, columnId, state }` (and `task.column_done` when `isDone` was sent).

## Today (Wave 10)

`GET /api/today?tz=<IANA>&sections=<a,b>?` returns 200 `{ generatedAt, date, sections }`. `date` is today in `tz`. `sections` maps each installed section, in order, to `{ items, more, href }` (at most ten items; `more` when there are more; `href` is the owning app's list). A section whose provider failed is `{ items: [], more: false, href, error }`; the others still load. Sections of modules that are not installed are absent. There are no counts, bodies, or caching. `sections=` limits the response to those names (the per-section Retry).

| Section | Items |
| --- | --- |
| `tasksDue` | `{ cardId, boardId, boardName, title, parentTitle, dueOn, dueTime, dueTz, dueAt, overdue }` (`parentTitle`, 17A: the live parent on the same board, else null): live cards on readable boards, not in a done column, `due_on ≤ date + 7`, soonest first (by `due_on`, then timed cards by wall time, then date-only ones; approximate across zones). A timed card (Wave 13) is `overdue` once `now > dueAt`, a date-only one once `due_on < date` |
| `tasksMine` | as `tasksDue` plus `reason: "assigned" \| "created"`: open cards the caller is one of the assignees of (`card_assignees`, Wave 13) or created |
| `notesRecent` | `{ id, title, owner_name, is_owner, updated_at }`: readable notes; others' notes only once published, with the published title and time |
| `drafts` | `{ id, title, updated_at, neverPublished }`: the caller's notes whose draft differs from the published version, not written by an MCP key |
| `agentDrafts` | `{ id, title, keyName, updated_at }`: the caller's drafts written by an MCP key |
| `files` | `{ id, name, mime_type, preview_kind, size_bytes, owner_name, is_owner, updated_at }`: the Files list, newest first |
| `collectionsRecent` | `{ rowId, collectionId, collectionName, title, updated_at, changedByKey }`: live rows in readable collections, most recently edited first; titles only (`listRecentRows` in `server/collections/service.ts`, which scans only the ten-plus-one most recently updated readable collections, since every row write touches its collection's `updated_at`) |
| `binSoon` | `{ type, id, title, purge_after }`: the caller's Bin items purged within three days |
| `upcoming` | `{ eventId, calendarId, title, start, end, allDay, date }`: occurrences on readable calendars over the next seven local days, not yet ended (Calendar, Wave 12; see § Calendar) |
| `storage` | one item `{ usedBytes, binnedBytes, quotaBytes }`: bytes counted against the quota (live and binned), the binned part, and the quota (`null` = unlimited) |

Errors: 400 when `tz` is not an IANA zone `Intl` accepts (list entries and the aliases browsers still report) or `sections` names an unknown section; 429 `RATE_LIMITED` with `Retry-After` above 30 requests a minute per user.

## Preferences (Wave 13, D92, D114)

Per-user settings that follow the account across devices. Today they hold only the modules the user turned off in **Settings → Modules** (migration 016, `server/preferences.ts`).

```ts
type ModuleId = "notes" | "files" | "tasks" | "collections" | "calendar" | "search" | "bin" | "notifications" | "team";
type Preferences = { disabledModules: ModuleId[]; revision: number; updatedAt: string | null };
```

- **A hidden module is not a security boundary (T97).** Preferences only hide UI in the web app. Every API route, ACL, MCP tool, calendar feed, reminder, and push keeps working for a module that is turned off, and keeps enforcing its own access rules. MCP never reads preferences, and there is no MCP tool to change them.
- `team` is reserved for Wave 14. Home and Settings are not modules and cannot be turned off.
- A user without a row has every module on: `{ disabledModules: [], revision: 0, updatedAt: null }`. Modules added later start on.
- `disabledModules` is returned unique and in the order above. Ids the server no longer knows are dropped on read.

| Endpoint | Body | Returns | Errors |
| --- | --- | --- | --- |
| `GET /api/preferences` | | 200 `{ preferences }` | |
| `PUT /api/preferences` | `{ disabledModules: ModuleId[], revision }` (strict; unique known ids, at most one per module; `revision` is the one last read, `0` before the first save) | 200 `{ preferences }` with `revision` + 1 (the first save creates revision 1) | 400 for an unknown or repeated id, a missing or negative `revision`, or an extra key. 409 `PREFERENCES_CHANGED` with the current `preferences` when `revision` is stale (compare-and-swap, one writer wins) |

`GET /api/auth/me` adds `preferences: Preferences`, so the app knows which modules to show before its first render. It is served before the TOTP setup gate, like the rest of `/auth/me`; `/api/preferences` is behind it. Each successful PUT is audited as `preferences.update { disabledModules, revision }` (module ids only).

## MCP keys and tools (Wave 8)

### Keys

| Endpoint | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/mcp/keys` | | 200 `{ keys: (McpKey & { effectiveScopes: McpScope[]; binnedToday: number })[] }` (active keys, newest first). `effectiveScopes` are the stored `scopes` narrowed to the owner's current role, so Settings shows a demoted admin's `team:read` as "(admins only, inactive)". `binnedToday` (Wave 19) counts the key's MCP bins in the last 24 hours | |
| `GET /api/mcp/keys/:id/binned?window=1h\|24h\|7d` (Wave 19, D175) | | 200 `{ items: { type: "note" \| "card" \| "event" \| "collection_row", id, title, binnedAt, restorable }[], truncated }`: what the key moved to the Bin in the window (default 24h) and is still in the caller's Bin from that binning, newest first, from `audit_log` rows with the key's `keyId` (at most 500) | 400 (bad window), 404 (not the caller's key) |
| `POST /api/mcp/keys/:id/restore-binned` (Wave 19) | `{ window: "1h" \| "24h" \| "7d" }` | 200 `{ restored: number, skipped: { type, id, reason }[] }`: each item restored through the normal Bin services (the usual owner/binner predicates); `reason` is `not_in_bin`, `parent_in_bin`, `board_in_bin`, `purging`, `limit`, `limit_reached`, or `not_found`. Audited `mcp.key_restore_binned` | 400, 403 `ROLE_READ_ONLY` (write gate), 404 |
| `POST /api/mcp/keys` (alias of `POST /api/keys` for one release since Wave 31) | `{ name, password, totpCode? \| recoveryCode?, scopes? }` | 201 `{ key: McpKey & { token, userId, prefix, createdAt } }`; the token is shown once | 400 (bad name or scopes), 401 (password or second factor), 403 `SCOPE_NOT_ALLOWED` (a scope the caller's team role cannot hold, checked before the password; Wave 14), 409 (10 active keys) |
| `DELETE /api/mcp/keys/:id` | `{}` | 200 `{ ok: true }` | 404 |

```ts
type McpScope = "notes:read" | "notes:write-draft" | "notes:publish" | "files:read" | "files:write" | "tasks:read" | "tasks:write" | "today:read"
  | "calendar:read" | "calendar:write" | "collections:read" | "collections:write" | "bin:write" | "team:read"
  | "inbox:read" | "inbox:write";
type McpKey = { id: string; name: string; key_prefix: string; scopes: McpScope[]; created_at: string; last_used_at: string | null };
```

- `scopes`: unique values (at most one per defined scope), default `["notes:read"]`. A write scope adds its read scope (`notes:write-draft` and `notes:publish` → `notes:read`, `files:write` → `files:read`, `tasks:write` → `tasks:read`, `calendar:write` → `calendar:read`, `collections:write` → `collections:read`, `inbox:write` → `inbox:read`); `bin:write` adds none. Scopes are returned in the order above and cannot be changed later; create a new key instead.
- **Write scopes (Wave 19, D171)** are an explicit list (`MCP_WRITE_SCOPES` in `server/mcpScopes.ts`, mirrored in `src/mcpPermissions.ts`): `notes:write-draft`, `notes:publish`, `files:write`, `tasks:write`, `calendar:write`, `collections:write`, `bin:write`, `inbox:write`. Every other scope is a read scope. Viewers may hold read scopes only, so `POST /api/mcp/keys` answers 403 `SCOPE_NOT_ALLOWED` to a viewer asking for any write scope, the three Wave 19 scopes included.
- A tool may also declare `alsoRequires` (all-of, D172): every `bin_*`/`restore_*` tool needs `bin:write` **and** the module's write scope, so `bin:write` alone lists no tools.
- Keys created before migration 010 have `["notes:read"]`.
- The audit row `mcp.key_created` records `{ keyId, name, scopes }`.

### Tools

`/mcp` (outside `/api`) speaks Streamable HTTP with `Authorization: Bearer <token>`; transport, key format, Host/Origin checks, and body limits are unchanged. `tools/list` returns only the tools the key's scopes allow, and each handler checks the key again. Tools run as the key's owner.

| Tool | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `list_notes` | notes:read | `{ query? }` title filter | `{ notes }`: published notes the owner can read |
| `read_note` | notes:read | `{ noteId }` | `{ id, title, version, markdown }` of the published version |
| `search_notes` | notes:read | `{ query (1–200), folderId?, limit? (1–20, default 10) }` | `{ results: { id, title, snippet, version, folder_id, owner_name, is_owner, updated_at }[], truncated }`. Published text only (never drafts, not even the owner's); the title comes from the published version; snippets are plain text; query rules and live access as in `GET /api/search` |
| `list_folders` | notes:read or files:read | `{}` | `{ folders }` as `GET /api/folders` |
| `create_note` | notes:write-draft | `{ markdown (not blank), folderId? }` | `{ noteId, revision: 1, title, folderId, url }`: a never-published note whose draft is `markdown`, in an owned folder (default: Default) |
| `get_note_draft` | notes:write-draft | `{ noteId }` (owned) | `{ noteId, revision, hasDraft, markdown, publishedVersion, url }`. Without a draft, `revision` is null and `markdown` is the published text |
| `update_note_draft` | notes:write-draft | `{ noteId, markdown, baseRevision: number \| null, mode: "replace" \| "append" }` | `{ noteId, revision, title, hasDelta, url }`. Append adds `markdown` as a new paragraph. Never publishes or creates a version |
| `list_documents` | files:read | `{ folderId? }` | `{ documents: DocumentSummary[] }` as `GET /api/files` |
| `get_document_metadata` | files:read | `{ documentId }` | `{ document: DocumentSummary }` under the Files list predicate |
| `read_document_text` | files:read | `{ documentId }` | `{ id, name, mimeType, sizeBytes, text }` for `preview_kind = 'text'` up to 1 MiB, strict UTF-8 |

| `list_boards` | tasks:read | `{}` | `{ boards }` as `GET /api/tasks/boards` |
| `list_cards` | tasks:read | `{ boardId, columnId?, assigneeIds?, tags?, flags?, dueBefore?, dueAfter?, dueNone?, text? }` | `{ board: { id, name, owner_name, is_owner }, columns: { id, name, position, wip_limit }[], tags: { id, name, color }[], cards: { id, column_id, column_name, position, title, description_preview, revision, creator_name, description_excerpt, due_on, due_time, due_tz, due_at, assignees: string[], assignee_name, tags: string[], flags, comment_count, relation_count, open_blockers, attachments: string[], updated_at }[] }`. `assignees` and `tags` are names in assignment and tagging order (Wave 13); `assignee_name` is the first assignee. `relation_count` and `open_blockers` are computed for the key's owner as in `GET /api/tasks/boards/:b` (13D). `description_preview` is plain text, at most 280 characters; `attachments` are file names only. A `columnId` not on the board is `NOT_FOUND`. **Filters (Wave 13C, D113)** run on the server with bound SQL (`server/tasks/cardQuery.ts`) and mean what the client's `shared/taskQuery.ts` means: values inside one filter are OR-ed and filters are AND-ed. `assigneeIds` (≤ 30): user ids, `"me"` (the key's user), or `"none"` (unassigned); `tags` (≤ 30): names in any case or ids of this board's tags, or `"none"` (untagged), where an unknown tag is `INVALID` with `reason: "UNKNOWN_TAG"`, the unknown `tags`, and the board's `known` names; `flags`: the fixed set or `"none"`; `dueBefore`/`dueAfter`: real dates, exclusive, AND-ed into one range over dated cards (the card's own civil `due_on`); `dueNone: true` adds cards without a date (alone: only those); `text` (1–100): a substring of the title or `description_excerpt`, ignoring case and accents, with no wildcards. The listing keeps the board order |
| `get_card` | tasks:read | `{ cardId }` | `{ card: { id, board_id, board_name, column_id, column_name, title, description, revision, creator_name, description_excerpt, due_on, due_time, due_tz, due_at, assignees: string[], assignee_name, tags: string[], flags, created_at, updated_at }, comments (latest 50, each with `reactions: [{ emoji, glyph, count, reacted }]` and no names, Wave 20), hasMoreComments, attachments: string[], relations: McpRelation[] }`. There is no reaction write tool. `description` is plain text; `relations` resolve for the key's owner exactly as `GET /api/tasks/cards/:k` does, newest first (13D) |
| `list_children` | tasks:read | `{ cardId }` | `{ children: { id, title, level, level_name, column_id, column_name, is_done, due_on, child_count, done_child_count }[] }`: live direct children by column, then position, at most 100, always on the card's own board. `NOT_FOUND` for a card the owner cannot read (17A, D139) |
| `search_cards` | tasks:read | `{ query (1–100, trimmed), boardId?, limit? (1–20, default 20) }` | `{ results: { id, board_id, board_name, title, column_name, is_done }[], truncated }` as `GET /api/tasks/cards/search`: titles only, live cards on boards the owner can read, `boardId` first (a hint). Not rate-limited beyond the per-key call limits (13D) |
| (hierarchy, 17A) | | | Every card `list_cards`, `get_card`, `create_card`, and `update_card` return adds `parent_id`, `level`, `level_name`, `child_count`, and `done_child_count`; `list_cards`'s `board` adds `levels` (names, top first) and `work_level`; `get_card` adds `card.parent_title` and `children` (as `list_children`); `query_cards` cards add `parent_id`, `parent_title`, and `level`, and its filter takes `parent:`, `level:`, and `has:subtasks`. `create_card` and `update_card` take `parentId` and `level` with the REST rules (§ Hierarchy): an invalid parent is `INVALID` with `reason: "PARENT_INVALID"`, a level change on a card with children `INVALID` with `reason: "HAS_CHILDREN"` and `childCount`; audited like the REST writes with `{ via: "mcp", keyId }` in the `task_write` bucket. No structure or sprint tools (D139, T119) |
| `list_sprints` (17B) | `tasks:read` | read | `{ boardId, state?: "planned" \| "active" \| "completed", cursor? }` → `{ sprints: { id, name, goal, state, is_active, start_on, end_on, completed_at, card_count, done_count }[], nextCursor }`: the active sprint, planned ones in order, then completed ones newest first (20 a page); `NOT_FOUND` for a board the user cannot read. Every card `list_cards`, `get_card`, `create_card`, and `update_card` return adds `sprint_id` (inherited below the work level) and `sprint_name`; `list_cards` takes `sprint: "current" \| "next" \| "none" \| <sprintId>` and its `board` adds `sprints_enabled` and, when set, `sprint_defaults: { days, start, name_pattern }` (read-only; the owner changes them in the app); `query_cards` cards add `sprint_id` and `sprint_name`, and its filter takes `sprint:`. `create_card` and `update_card` take `sprintId` (nullable) with the REST rules (§ Sprints; an omitted `sprintId` on `create_card`, or on a `card_create` proposal when it is approved, puts a work-level card in the active sprint, `null` in the backlog): below the work level `INVALID` with `reason: "SPRINT_LEVEL"`, a completed sprint `INVALID` with `reason: "SPRINT_COMPLETED"`, an unknown or other board's sprint `NOT_FOUND`; audited with `{ via: "mcp", keyId }` in the `task_write` bucket. Wave 19 adds owner-only `create_sprint` and `start_sprint`; there is still no complete or delete tool: completing a sprint stays with a person |
| `list_views` | tasks:read | `{}` | `{ views: { id, name, owner_name, is_owner, visibility, query }[] }`: the owner's views, views shared with them, and `all_users` views, as `GET /api/tasks/views` (17C) |
| `query_cards` | tasks:read | `{ viewId? \| filter? (grammar, ≤ 2000), sort?, group? (with filter only), cursor?, limit? (1–50, default 50), tz? (IANA, default UTC) }`, exactly one of `viewId` and `filter` | `{ view?: { id, name, owner_name }, query, cards: { id, board_id, board_name, column_id, column_name, state, title, description_excerpt, revision, creator_name, due_on, due_time, due_tz, due_at, assignees: string[], assignee_name, tags: string[], flags, updated_at }[], nextCursor, total?, refs? }`. The same service as `POST /api/tasks/query` and `GET /api/tasks/views/:v/cards`, as the key's owner: a view or filter never reaches a board they cannot read, and such ids resolve as `restricted` in `refs`. Grammar errors are `INVALID` with `reason` (`FILTER_INVALID`, `FILTER_UNSUPPORTED`, `FILTER_SCOPE`, `CURSOR_INVALID`) and `position`; a view the owner cannot read is `NOT_FOUND`. Read bucket only, not audited, no REST query limit; there are no view write tools (17C, D145) |
| `create_card` | tasks:write | `{ boardId, columnId, title, description?, dueOn?, dueTime?, dueTz?, assigneeIds? (≤ 20), tags? (≤ 10), flags?, parentId?, level?, afterCardId? }` | `{ card: { id, board_id, column_id, title, revision, description_excerpt, due_on, due_time, due_tz, due_at, assignees: string[], assignee_name, tags: string[], flags } }`. `afterCardId` omitted = bottom, `null` = top. Same validation as `POST /api/tasks/boards/:b/cards`; a full column is `COLUMN_FULL`. `tags` are **existing** tags of the board by name (any case) or id; an unknown one is `INVALID` with `reason: "UNKNOWN_TAG"` and nothing is written (MCP never creates tags) |
| `update_card` | tasks:write | `{ cardId, baseRevision, title?, dueOn?, dueTime?, dueTz?, assigneeIds?, tags?, flags?, parentId? (uuid or null), level? }` (no other keys) | `{ card }` as `create_card` returns it, with `revision + 1`. Same validation as `PATCH /api/tasks/cards/:k`: `dueOn: null` clears the date and time, `dueTime: null` only the time, `assigneeIds`, `tags` (existing tags of the card's board, by name or id, as for `create_card`), and `flags` each replace the set, and `[]` clears it. **Never changes the description** (a `description` key is `INVALID`, §11 Q8). `CARD_CHANGED` with `currentRevision` when `baseRevision` is stale. Wave 13 |
| `move_card` | tasks:write | `{ cardId, columnId, afterCardId? }` | `{ card: { id, column_id, position } }`. Same board only; `afterCardId` omitted = bottom, `null` = top; moving into another column at its WIP limit is `COLUMN_FULL` |
| `link_cards` | tasks:write | `{ cardId, targetCardId, type: RelationType }` (no other keys) | `{ relation: McpRelation }` seen from `cardId`. Same service as `POST /api/tasks/cards/:k/relations`: both cards must be readable (`NOT_FOUND` otherwise, identical to a missing id), one relation per pair (`RELATION_EXISTS` with the existing `relation`), 50 per card (`LIMIT_REACHED`); never changes either card's revision. There is no unlink tool (13D) |
| `comment_on_card` | tasks:write | `{ cardId, body }` | `{ comment: { id, card_id, created_at } }`, authored by the key's owner |
| `get_today` | today:read | `{ tz? }` (IANA, default UTC) | The `GET /api/today` body, titles and ids only, with only the sections the key may read (T74): task sections need `tasks:read`, `notesRecent`/`drafts`/`agentDrafts` need `notes:read`, `files` needs `files:read`, `collectionsRecent` needs `collections:read`, `upcoming` needs `calendar:read`; `binSoon` and `storage` need `today:read` alone, and `binSoon` keeps only item types the key may read (notes: `notes:read`, documents: `files:read`, cards and boards: `tasks:read`, collections and rows: `collections:read`, calendars and events: `calendar:read`). It shares the 30-a-minute per-user Today limit (`RATE_LIMITED` with `retryAfterSeconds`). `list_cards` and `get_card` also return `due_on` and `assignee_name` |
| `list_calendars` | calendar:read | `{}` | `{ calendars: { id, name, role, color, ownerName }[] }` as `GET /api/calendars` (a first call creates "Personal", as there) |
| `list_events` | calendar:read | `{ from, to, calendarIds? (≤ 50), tz? }` (dates, `to` exclusive, at most 100 days) | `{ occurrences: { eventId, calendarId, title, location, start, end, allDay, recurring, date }[], truncated }` as `GET /api/events` |
| `get_event` | calendar:read | `{ eventId }` | `{ event: { id, calendarId, calendarName, title, description, location, allDay, start, end, tz, durationMinutes, repeat, exdates, updatedAt }, revision, role, links, url }`. `description` is plain text; `links` are `{ targetType, targetId, title }` or `{ targetType, restricted: true }` (the owner cannot read the target, or the key lacks its module's read grant or has it only for other boards or collections, T203) |
| `create_event` | calendar:write | `{ calendarId, title, allDay, start, end?, durationMinutes?, tz?, repeat?, description?, location? }` | `{ eventId, revision: 1, url }`. All-day: `start`/`end` are dates (`end` exclusive, default the next day). Timed: `start` is local `yyyy-mm-ddTHH:MM` in `tz`, with `durationMinutes` or a local `end`. Editor role; validated by the `POST /api/calendars/:k/events` schema |
| `update_event` | calendar:write | `{ eventId, baseRevision, title?, allDay?, start?, end?, durationMinutes?, tz?, repeat?, description?, location? }` | `{ eventId, revision, url }` or `EVENT_CHANGED` with `currentRevision`. Undoable in the app |
| `create_reminder` | calendar:write | `{ eventId, offsetMinutes, tz? }` or `{ title, fireAt, tz? }` (`tz` default UTC) | `{ reminderId, nextFireAt, eventId }`, always for the key's owner; viewers may set reminders on events they can read |
| `list_collections` | collections:read | `{}` | `{ collections: { id, name, role, rowCount, ownerName, fields: { id, name, type, required?, unit?, decimals?, options?: { id, label }[] }[] }[] }` |
| `query_rows` | collections:read | `{ collectionId, filters?: { field, op, value? }[] (≤ 10), sort?: { field, direction? }[] (≤ 3), q?, limit? (1–50, default 20), cursor? }` | `{ rows: McpRow[], total, nextCursor }`. `field` is a field name or id; select values may be labels. Operators and cursors as `POST /api/collections/:c/query` |
| `get_row` | collections:read | `{ rowId }` | `{ row: McpRow, revision, role, collectionName }` |
| `create_row` | collections:write | `{ collectionId, values }` | `{ rowId, revision: 1, url }`. Editor role; the row goes at the bottom |
| `update_row` | collections:write | `{ rowId, values, baseRevision }` | `{ rowId, revision, url }` or `ROW_CHANGED` with `currentRevision`. Values merge; `null` clears a field |

**Wave 19 write tools** (WAVES_18-20_SMALL.md §2.3). "+ bin:write" means the tool also requires `bin:write` (all-of, D172); `bin:write` alone lists none of them. All are writes (the per-minute `write` bucket) except `finish_upload`. Bin tools never purge; there is no purge, empty-Bin, sharing, role, key, or sprint-completion tool (`tests/mcpRules.test.ts`).

| Tool | Scope | Bucket | Arguments | Result |
| --- | --- | --- | --- | --- |
| `publish_note_draft` | notes:publish | `note_publish` | `{ noteId, revision }` (owned) | `{ noteId, version, publishedAt, audience: "private" \| "shared", url }`. The revision must be one this key was shown by `create_note`, `get_note_draft`, or `update_note_draft` (the D173 ledger: `DRAFT_NOT_SEEN` otherwise, also after a restart); a draft changed since is `DRAFT_CHANGED`; `NO_DRAFT`, `NO_CHANGES`. Runs `publishDraft` (the HTTP route's service); clears `draft_mcp_key_id`; audited `note.publish { version, via, keyId }` |
| `get_note_draft` | notes:write-draft **or** notes:publish | – | unchanged | unchanged; records the returned revision in the key's ledger |
| `create_folder` | notes:write-draft or files:write | `structure_write` | `{ name, parentId? }` | `{ folder: { id, parent_id, name, created_at, updated_at } }`, always private (no cascade). `NAME_TAKEN` for Default; a parent not owned is `NOT_FOUND`. Shares `createFolder` with `POST /api/folders`; audited `folder.create` |
| `bin_note` / `restore_note` | notes:write-draft + bin:write | `bin_action` + `bin_burst` / – | `{ noteId }` (owned) | `{ noteId, binned: true, purgeAfter }` (a blank note is binned too, never purged) / `{ noteId, restored: true, alreadyRestored?, folderId, folderName, visibility, url }`; `PURGING` |
| `bin_card` / `restore_card` | tasks:write + bin:write | `bin_action` + `bin_burst` / – | `{ cardId }` | `{ cardId, binned: true, purgeAfter, descendantCount }` / `{ cardId, restored: true, alreadyRestored?, boardId, columnId, columnName, descendantCount?, detached? }`; restore by the board owner or the binner; `PARENT_IN_BIN` (board binned), `LIMIT_REACHED`, `PURGING` |
| `manage_tags` | tasks:write | `task_write` | `{ boardId, action: "create" \| "rename" \| "recolour", tagId?, name?, color? }` | `{ tag: { id, name, color } }`. Any reader creates (`NAME_TAKEN` for an existing name in any case); rename and recolour are owner-only (`OWNER_ONLY`) and change only their own field; a tag of another board is `NOT_FOUND`. No delete |
| `set_wip_limit` | tasks:write | `task_write` | `{ columnId, wipLimit: 1–1000 \| null }` | `{ column: { id, name, wip_limit } }`; owner only |
| `create_sprint` | tasks:write | `sprint_write` | `{ boardId, name, goal?, startOn?, endOn? }` | `{ sprint: { id, name, goal, state, start_on, end_on } }`; owner only; `INVALID` with `reason: "SPRINTS_OFF"`. An omitted `startOn` is today (UTC) and an omitted `endOn` is the board's default sprint length after the start (`sprintDefaults.days`, else 14), so a sprint an agent starts has dates (v0.11.0 1l); `null` keeps a date empty |
| `start_sprint` | tasks:write | `sprint_write` | `{ sprintId }` | `{ sprint: { id, name, state, is_active, start_on, end_on } }`; owner only; `SPRINT_ACTIVE` with `activeSprintId`. There is no `complete_sprint` (director review) |
| `link_attachment` | tasks:write | `task_write` | `{ cardId, documentId, commentId? }` | `{ attachment: { cardId, documentId, name, commentId }, alreadyLinked }`. Only the caller's own live `task_attachment` documents (T41); a Files document is `NOT_FOUND`. Idempotent |
| `bin_event` / `restore_event` | calendar:write + bin:write | `bin_action` + `bin_burst` / – | `{ eventId }` | `{ eventId, binned: true, purgeAfter }` / `{ eventId, restored: true, alreadyRestored?, calendarId, url }`; `PARENT_IN_BIN` when its calendar is binned |
| `create_collection` | collections:write | `row_write` | `{ name, icon?, templateId? \| fields? }` (exactly one) | `{ collectionId, name, fields: { id, name, type }[], url }`, private; the route schema (`__proto__` refused), `SCHEMA_LIMITS`, and 100 per owner (`LIMIT_REACHED`) |
| `bin_row` / `restore_row` | collections:write + bin:write | `bin_action` + `bin_burst` / – | `{ rowId }` | `{ rowId, binned: true, purgeAfter }` / `{ rowId, restored: true, alreadyRestored?, collectionId, url }`; `PARENT_IN_BIN` |
| `create_text_file` | files:write | `file_write` | `{ name, text (≤ 1 MiB UTF-8), folderId?, purpose?: "file" \| "task_attachment" }` | `{ document: DocumentSummary }`. NUL or a lone surrogate is `INVALID`; larger is `TOO_LARGE`; `QUOTA_EXCEEDED`. Through the upload pipeline (sniffing, quota, audit `document.upload` with the key) |
| `begin_upload` | files:write | `file_write` | `{ name, sizeBytes (≤ MAX_UPLOAD_BYTES), sha256 (hex), folderId?, purpose? }` | `{ uploadId, uploadUrl, method: "PUT", headers: { Content-Type, Content-Length }, expiresAt }`. 15 minutes, single use, ≤ 3 open per key (`LIMIT_REACHED`); quota checked now (advisory) and at commit; 1 GiB per user a day (`RATE_LIMITED`) |
| `finish_upload` | files:write | read | `{ uploadId }` | `{ document: DocumentSummary }` once, or `UPLOAD_PENDING`, `UPLOAD_EXPIRED`, `HASH_MISMATCH`; another key's upload is `NOT_FOUND` |
| `rename_file` | files:write | `structure_write` | `{ documentId, name }` (owned Files document) | `{ document }`; shares `patchDocument` with `PATCH /api/files/:id` |
| `move_file` | files:write | `structure_write` | `{ documentId, folderId }` (owned) | `{ document }`, or `AUDIENCE_CHANGE` when the file inherits its folder's sharing and the two folders' audiences (visibility and recipients) differ (D177); a file with its own sharing moves freely |

**`PUT /mcp/uploads/:uploadId`** (Wave 19, D176; outside `/api`, no cookie or CSRF): the `/mcp` Host and Origin checks, `Authorization: Bearer` with the key that called `begin_upload` (with `files:write` effective and a write role), `Content-Type: application/octet-stream`, and `Content-Length` equal to `sizeBytes`. The raw body streams through the web upload's pipeline (`storeRawUpload` → `commitReceived` in `server/documents.ts`) with the ticket id as the idempotency key. Answers 201 `{ document }`, 200 `{ document, idempotentReplay: true }` on a retry, 400 (`SIZE_MISMATCH`, `HASH_MISMATCH` — the ticket then fails — or a wrong type), 401 (invalid key, or the owner blocked), 403 `SCOPE_REQUIRED`, 404 (unknown, another key's, or `UPLOAD_EXPIRED`), 408 `UPLOAD_TIMEOUT`, 409 (in progress or failed), 411 `LENGTH_REQUIRED`, 413, 429 `TOO_MANY_UPLOADS`, 507 `QUOTA_EXCEEDED` / `DISK_FULL`.

Task tools call the `/api/tasks` services as the key's owner, so the W9 rules apply unchanged: any board reader (owner, member, everyone on an `all_users` board) may create, update, move, and comment; a board the user cannot read, and every id on it, is `NOT_FOUND`, identical to a missing id. There are no tools that edit descriptions or delete cards, or that change columns (other than their WIP limit, owner only), sharing, or boards; binning needs `bin:write` too (Wave 19). `ASSIGNEE_NOT_MEMBER` and the due-time rules are `INVALID` (with `reason` when the service gave a code). A stale `afterCardId` returns `STALE_POSITION` with `columnId` and the column's current `order`; `LIMIT_REACHED` passes through the board and relation caps. There is no tool to unlink cards. Task writes are audited through the usual `task.card_create`, `task.card_update`, `task.card_move`, `task.comment_create`, and `task.relation_create` events with `{ via: "mcp", keyId }` added.

```ts
// Relations as agents see them, from the card they asked about (T90).
type McpRelation =
  | { type: RelationType; cardId: string; title: string; boardName: string; columnName: string | null; isDone: boolean }
  | { type: RelationType; restricted: true };   // a card the key's owner cannot read, or the key may not (below): nothing else
```

**Foreign items and key grants (T203).** Anything a tool shows about an item other than the one the call names (a relation's other card, an event link's target, a collection `note` field's note) needs the key to hold that target's module read grant (`tasks:read`, `calendar:read`, `collections:read`, `notes:read`; a write grant implies it), and, when that grant names chosen boards or collections, the target must lie inside one of them. Otherwise the item comes back in the module's usual restricted shape (`{ type, restricted: true }` for relations, `{ targetType, restricted: true }` for event links, `{ restricted: true }` for note fields): no id, title, board, column, or done flag. The shape is identical to "the key's owner cannot read it", so it discloses nothing about which check failed. `create_row` and `update_row` pointing a `note` field at a note the key may not read are `NOT_FOUND`, like a missing note; clearing the field is always allowed. Proposal approvals run as the approving person, so the key's grants do not narrow them (`server/keyReach.ts`).

Calendar tools call the `/api/calendars`, `/api/events`, and `/api/reminders` services, and collection tools the `/api/collections` services, as the key's owner (D70, T72–T75). Readers read; only the owner and editors write (a viewer gets `READ_ONLY`); anything the user cannot read, including binned items, is `NOT_FOUND`. Writes are create and update only: there are no delete, exdate, share, feed, schema, view, attachment, or import tools. Every write sets `updated_via_key_id` (the event view's and row panel's "Changed by <key>", with Undo), is audited through the usual `event.create`, `event.update`, `reminder.create`, `collection.row_create`, and `collection.row_update` events with `{ via: "mcp", keyId }` added, and counts against the daily buckets below. A person's own edit or undo clears the key mark.

```ts
// Rows as agents see them: keyed by field name.
type McpRow = {
  id: string; collectionId: string; title: string;
  values: Record<string, string | number | boolean | string[]   // select → label, multi_select → labels, file → attachment names
    | { noteId: string; title: string } | { restricted: true }>;  // note fields; restricted without notes:read too (T203)
  revision: number; updatedAt: string; updatedBy: string | null;
  changedByKey: string | null;   // the key's name when the last change came through MCP
  url: string;                   // <origin>/collections/<c>/row/<r>
};
```

Collection `values` are keyed by field name (or id), with select options as labels (case-insensitive) or ids; unknown fields and file fields are `INVALID` with `fieldErrors` keyed by name, and the service's strict validation (types, required fields, readable note links, 16 KiB) applies unchanged. Field names `__proto__`, `constructor`, and `prototype` are refused by schema validation (400 `INVALID_SCHEMA`), since name-keyed inputs drop or refuse such keys; a collection that already has one still presents it as an ordinary key (row `values` objects have no prototype), and agents write it by field id.

Errors are tool results with `isError: true` whose text is `{ error, code, ...details }`:

| Code | When |
| --- | --- |
| `NOT_FOUND` | Missing, not readable, not owned (draft tools), binned, or not a Files document; all look the same |
| `INVALID` | Arguments fail validation (the transport may also reject them before the tool runs) |
| `SCOPE_REQUIRED` | The key lacks the tool's scope, or was revoked meanwhile |
| `RATE_LIMITED` | Per key: 120 calls and 30 writes per minute; per day 200 `create_note`, 500 task writes, 200 event writes (`create_event`, `update_event`), 100 `create_reminder`, and 500 row writes (`create_row`, `update_row`). Per user across keys: 1000 calls and 60 writes per minute; per day 400 `create_note`, 1000 task writes, 400 event writes, 200 reminders, and 1000 row writes. Wave 19, per key (per user): `note_publish` 50 (100) a day, `bin_action` 50 (100) a day, `bin_burst` 10 (20) a minute, `sprint_write` 20 (40), `structure_write` 100 (200), and `file_write` 100 (200) a day. Includes `retryAfterSeconds` |
| `DRAFT_CHANGED` | `baseRevision` is not the current draft revision. Includes `currentRevision` |
| `STALE_POSITION` | `afterCardId` is not a live card in the target column. Includes `columnId` and the column's current `order` |
| `LIMIT_REACHED` | A module cap (cards per board, comments per card, events per calendar, reminders per event, rows per collection) |
| `READ_ONLY` | A viewer called a write tool on a calendar or collection shared read-only |
| `EVENT_CHANGED` | `update_event`'s `baseRevision` is not the event's revision. Includes `currentRevision` |
| `CARD_CHANGED` | `update_card`'s `baseRevision` is not the card's revision. Includes `currentRevision` only |
| `COLUMN_FULL` | `create_card` or `move_card` (from another column) into a column at its WIP limit. Includes `columnId`, `wipLimit`, and `cardCount` |
| `RELATION_EXISTS` | `link_cards` on two cards that already have a relation (either direction, any type). Includes the existing `relation` seen from `cardId` |
| `ROW_CHANGED` | `update_row`'s `baseRevision` is not the row's revision. Includes `currentRevision` |
| `REMINDER_EXISTS` | The key's owner already has a reminder at that offset on the event |
| `SCHEMA_CHANGED` | A `query_rows` cursor was issued before the collection's fields changed; start again without it |
| `NOT_TEXT` | Not a text file, or not valid UTF-8 |
| `TOO_LARGE` | Text file over 1 MiB, or Markdown over `MAX_MARKDOWN_BYTES` |
| `NO_DRAFT`, `NO_CHANGES` | `publish_note_draft`: there is no draft, or it matches the published version |
| `DRAFT_NOT_SEEN` | `publish_note_draft`: this key was not shown that revision (read it with `get_note_draft`) |
| `PURGING` | The item is being permanently deleted |
| `PARENT_IN_BIN` | A restore whose board, calendar, or collection is itself in the Bin |
| `AUDIENCE_CHANGE` | `move_file` would change who can see the file |
| `NAME_TAKEN` | `create_folder` "Default", or `manage_tags` with a name that exists |
| `SPRINT_ACTIVE` | `start_sprint` while another sprint is active. Includes `activeSprintId` |
| `UPLOAD_PENDING`, `UPLOAD_EXPIRED`, `HASH_MISMATCH` | `finish_upload` states |
| `QUOTA_EXCEEDED` | The storage quota (or free disk) cannot fit the file |
| `INTERNAL` | Integrity or server failure |

Note writes are audited as `mcp.note_create` and `mcp.note_draft_update` (`{ via: "mcp", keyId, mode?, revision? }`), task writes as their usual `task.*` events with `{ via: "mcp", keyId }` added; reads are not audited.

### Note fields for MCP drafts

- `GET /api/notes` rows gain `draft_mcp_key_name: string | null` (owner only, while a draft exists).
- `GET /api/notes/:id` gains `draftMcpKeyName: string | null` (owner only); `draft_mcp_key_id` is never returned.
- `POST /api/notes/:id/publish` takes `{ revision }`, the draft revision the client last saw; the app always sends it. A different revision returns 409 `{ code: "DRAFT_CHANGED", currentRevision }` and publishes nothing. Omitting it is allowed only when no MCP key wrote the draft (older clients); otherwise 400.
- Publishing, discarding the draft, and restoring a version to the draft clear `notes.draft_mcp_key_id`. A human autosave keeps it, because the draft still holds the key's text.

## Collections (Wave 11)

Typed tables ([WAVES_10-12.md](WAVES_10-12.md) §3). Every endpoint is under `/api/collections`, takes and returns JSON (except CSV export), and inherits the global session, Origin, CSRF, `Content-Type: application/json`, and TOTP rules. Path ids are UUIDs (400 otherwise). Request bodies containing `__proto__`, `constructor`, or `prototype` keys at any depth are rejected with 400.

### Schema

```ts
type FieldType = "text" | "number" | "date" | "checkbox" | "select" | "multi_select" | "url" | "note" | "file";
type SelectOption = { id: string /* o_[a-z0-9]{6} */; label: string /* 1–60, unique per field, case-insensitive */; color: "gray" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" };
type FieldDefinition = {
  id: string;                          // f_[a-z0-9]{8}, generated by the server
  name: string;                        // 1–60 characters, unique case-insensitive
  type: FieldType;
  required?: true;                     // never on file fields
  number?: { decimals: number /* 0–6 */; unit: string /* ≤ 8 */ };   // number fields only
  options?: SelectOption[];            // select and multi_select only, ≤ 100
};
type CollectionSchema = { fields: FieldDefinition[] };   // 1–50 fields; fields[0] is text (the primary field, the row title); ≤ 65,536 bytes
type FieldInput = Omit<FieldDefinition, "id" | "options" | "required"> & { id?: string; required?: boolean; options?: Array<{ id?: string; label: string; color?: string }> };
```

- Ids are assigned by the server. An input `id` must name a field (or option) that already exists; fields and options without one are new.
- Allowed type changes: text ↔ url and select → multi_select. Anything else is 400 `INCOMPATIBLE_TYPE_CHANGE`; other schema errors are 400 `INVALID_SCHEMA`.

**Values** are keyed by field id. Writes are strict (400 `INVALID_VALUES { fieldErrors: { [fieldId]: message } }`); reads are lenient (values of removed fields or options, or of a now-incompatible type, read as empty and are dropped on the next write). `null` or an empty value clears a field.

| Type | Stored value |
| --- | --- |
| `text` | string ≤ 4000 characters: NFC, CRLF → LF, controls (other than tab and newline) and bidi overrides stripped, trimmed |
| `number` | finite JSON number |
| `date` | `YYYY-MM-DD`, a real calendar date |
| `checkbox` | `true` (false clears) |
| `select` | one option id |
| `multi_select` | ≤ 20 distinct option ids |
| `url` | `http:` or `https:` URL, ≤ 2048 characters |
| `note` | a note uuid the writer can read at write time |
| `file` | never stored; derived from attachment links |

A row's values JSON is at most 16,384 bytes. Required fields must be set on create and cannot be cleared.

**Templates** (`GET /templates`): `inventory`, `subscriptions`, `expenses`, `recipes`, `contacts`. A template's fields are copied into the new collection with fresh ids.

### Roles

A collection's readers are its owner, its members and groups when `visibility = 'selected'`, and every user when `visibility = 'all_users'`. Since Wave 32 each member and group has its own level (view, edit, manage), and `share_role` (`viewer` or `editor`, D54) is the level of the `all_users` audience; editors create, edit, undo, and bin rows, and managers edit the name, icon, schema, and views (see "Groups, levels, and item access"). Only the owner uses the `/sharing` route and deletes. A caller who cannot read the collection gets **404** on every route (path ids are always joined to their collection); a viewer writing a row gets **403** `READ_ONLY`; a non-manager changing the structure gets **403** `MANAGER_REQUIRED`, and a non-owner calling an owner-only route **403** `OWNER_ONLY`. Binned collections and rows are unreadable for everyone.

**Caps** (409 `LIMIT_REACHED`): 100 live collections per owner, 10,000 live rows per collection, 20 views per collection, 20 attachments per row.

```ts
type CollectionSummary = {
  id: string; name: string /* 1–120 */; icon: string /* [a-z0-9-]{1,32} */;
  owner_id: string; owner_name: string; is_owner: 0 | 1;
  role: "owner" | "editor" | "viewer";
  visibility: Visibility; share_role: "viewer" | "editor";
  row_count: number; field_count: number; template_id: string | null;
  created_at: string; updated_at: string;
};
type CollectionDetail = CollectionSummary & { fields: FieldDefinition[]; schema_version: number };
type NoteLink = { id: string; title: string } | { id: string; restricted: true };
type RowSummary = {
  id: string; collection_id: string; position: number;
  title: string;                          // the primary field's text
  values: Record<string, FieldValue>;     // lenient read against the current schema
  links: Record<string, NoteLink>;        // note fields, resolved for the caller (never an unreadable title)
  revision: number; can_undo: boolean;
  created_by: string | null; created_by_name: string | null; updated_by_name: string | null;
  updated_via_key_id: string | null;      // set by MCP writes (Stage E); cleared by a person's edit or undo
  updated_via_key_name: string | null;    // that key's name while it exists ("Changed by <key>")
  created_at: string; updated_at: string;
};
```

### Collections and rows

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /` | any | 200 `{ collections: CollectionSummary[] }`: owned first, then shared, each by name (limit 500) | |
| `GET /templates` | any | 200 `{ templates: [{ id, name, icon, description, fields: [{ name, type }] }] }` | |
| `POST / { name, icon?, templateId?, fields? }` | any | 201 `{ collection: CollectionDetail }`. Neither `templateId` nor `fields` gives Name + Notes. | 400 (`INVALID_SCHEMA`, unknown template, both given), 409 `LIMIT_REACHED` |
| `GET /:c` | reader | 200 `{ collection, role, views }` | 404 |
| `PATCH /:c { name?, icon? }` | owner | 200 `{ collection }` | 400, 403, 404 |
| `DELETE /:c` | owner | 200 `{ ok: true, purgeAfter }`: to the Bin with its rows | 403, 404 |
| `PUT /:c/schema { fields: FieldInput[], schemaVersion }` | owner | 200 `{ collection }` with `schema_version + 1` | 400 `INVALID_SCHEMA` / `INCOMPATIBLE_TYPE_CHANGE`, 403, 404, 409 `{ code: "SCHEMA_CHANGED", collection }` |
| `POST /:c/query { viewId?, sort?, filters?, q?, cursor?, limit? }` | reader | 200 `{ rows: RowSummary[], nextCursor: string \| null, schemaVersion, total }` | 400 `INVALID_QUERY` / `INVALID_CURSOR`, 404, 409 `SCHEMA_CHANGED` |
| `POST /:c/rows { values, afterRowId? }` | editor | 201 `{ row }`. Omitted `afterRowId` = bottom, `null` = top. | 400 `INVALID_VALUES`, 403 `READ_ONLY`, 404 (collection, or an anchor not in it), 409 `LIMIT_REACHED` |
| `GET /rows/:r` | reader | 200 `{ row, role, schemaVersion }` | 404 |
| `PATCH /rows/:r { values, revision }` | editor | 200 `{ row }`: `values` is merged; `revision + 1`; the previous values are kept for undo | 400, 403, 404, 409 `{ code: "ROW_CHANGED", row }` |
| `POST /rows/:r/undo { revision }` | editor | 200 `{ row }`: the previous values, projected onto the current schema; undo is one step | 403, 404, 409 `ROW_CHANGED` or `NOTHING_TO_UNDO`. An undo of an attach or unlink follows those routes' rules for the caller: every link it puts back must be to a document the caller owns, and every link it removes must be the caller's own unless the caller owns the collection; otherwise the whole undo is refused with 403 `{ code: "NOT_LINKER", documentIds }` and nothing changes |
| `DELETE /rows/:r` | editor | 200 `{ ok: true, purgeAfter }`: to the Bin | 403, 404 |

### Saved views

```ts
type ViewConfig = { sort?: SortSpec[] /* ≤ 3 */; filters?: FilterSpec[] /* ≤ 10 */; hiddenFieldIds?: string[] /* never the primary field */ };
type CollectionView = { id: string; collection_id: string; name: string /* 1–60 */; kind: "table"; config: ViewConfig; position: number; created_at: string; updated_at: string };
```

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /:c/views { name, kind?: "table", config }` | owner | 201 `{ view }` (appended) | 400 `INVALID_QUERY` (config does not compile against the schema, unknown hidden field) or over 8 KiB, 403, 404, 409 `LIMIT_REACHED` (20) |
| `PATCH /views/:v { name?, config? }` | owner | 200 `{ view }` | 400, 403, 404 |
| `DELETE /views/:v` | owner | 200 `{ ok: true }` | 403, 404 |

Views are listed by `GET /:c` for every reader and used through `POST /:c/query { viewId }`; a view id from another collection is 404. `q` is never stored. `kind: "board"` is reserved. Audit: `collection.view_create`, `collection.view_update`, `collection.view_delete` with `{ collectionId, viewId }`.

### Row attachments

`file` values are derived from links (D58): `RowSummary.files` is `{ [fieldId]: AttachmentSummary[] }` with `AttachmentSummary = { id, name, mime_type, preview_kind, size_bytes, linked_by, created_at }`, live documents only. Uploads for rows use `POST /api/files?purpose=collection_attachment` (no `folderId`, 400 otherwise): the document is stored with `folder_id = NULL`, counts against the uploader's quota, and never appears in `GET /api/files`, folder counts, or the Files Bin filter.

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /rows/:r/attachments { documentId, fieldId }` | editor that owns the document | 201 `{ row }` | 400 (not a file field), 403 `READ_ONLY`, 404 (row, or a document that is not the caller's live `file` or `collection_attachment` document), 409 `ALREADY_ATTACHED` / `LIMIT_REACHED` (20 per row) |
| `DELETE /rows/:r/attachments/:d` | editor who linked it, or the owner | 200 `{ row, documentBinned }` | 403 `READ_ONLY` / `NOT_LINKER`, 404 |

- **Access.** A linked document is readable (`GET /api/files/:id`, `/content`) by anyone who can read a live row that links it in a live collection; the check is live, so unsharing, binning the row or collection, or unlinking ends access at once (T58). This path is OR-ed into `readableDocument*` only, never into lists.
- **Files routes.** Rename, move, and sharing (`PATCH /api/files/:id`, `GET|PUT /api/files/:id/sharing`) are 404 for any document whose `purpose` is not `file`, and sharing rows or folder access never apply to such documents. `DELETE /api/files/:id` on a row attachment that a row still links is 409 `ATTACHMENT_LINKED`.
- **Never linked.** The hourly sweeper moves `collection_attachment` uploads with no row link that are older than 24 hours to the uploader's Bin (100 per run, `deleted_by = NULL`, audit reason `attachment_never_linked`).
- **Lifecycle.** When the last link to a `collection_attachment` document is removed (unlink, or a row or collection purge), the document moves to the uploader's Bin (`deleted_by` = actor). Files items that were linked are never binned. Restoring an attachment from the Bin keeps `folder_id = NULL`.
- **Notes** in `note` fields never grant access: a note the caller cannot read resolves as `{ id, restricted: true }` (T59).
- Audit: `collection.row_attach` and `collection.row_detach` with `{ collectionId, rowId, documentId }`; a binned upload adds `document.delete { documentId, reason: "attachment_unlinked" }`.

### CSV import and export

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `POST /:c/import { csv, mapping?, dryRun }` | editor | dry run: 200 `{ dryRun: true, header, total, valid, errorCount, errors ≤ 50, mapping, preview ≤ 20, wouldExceedLimit }`; import: 200 `{ inserted }` | 400 `INVALID_CSV` (with `line`) / `INVALID_MAPPING` / `IMPORT_INVALID { errorCount, errors }`, 403 `READ_ONLY`, 404, 409 `LIMIT_REACHED`, 413 `IMPORT_TOO_LARGE`, 429 `RATE_LIMITED` |
| `GET /:c/export.csv?viewId=` | reader | 200 `text/csv; charset=utf-8`, `Content-Disposition: attachment`, `no-store` | 400 (bad `viewId`), 404 (collection, or a view of another collection) |

- **Import** (D59, T56). `csv` is the file's text inside JSON, at most 2,000,000 UTF-8 bytes; the first record is the header, then at most 5000 rows of at most 50 columns (in-house RFC 4180 parser: quotes, doubled quotes, embedded line breaks, CRLF/LF/CR, BOM stripped, empty records skipped). `mapping` has one entry per header column: a field id or `null` to skip; without it, columns map to fields with the same name (case-insensitive). File fields cannot be mapped. Cells convert per type (numbers may use `,` separators; checkboxes accept yes/no/true/false/1/0/x; options match by label or id, several separated by `;`; notes by id and must be readable), then pass the same strict validation as `POST /rows`. `errors[].row` counts data rows from 1. A real import inserts every row in one transaction, indexed for search, or nothing; imports count five per minute per user, dry runs included. Audit: `collection.import { collectionId, count }`.
- **Export** (T55). The rows `POST /:c/query { viewId }` returns (all pages, in order) and the view's shown fields, as UTF-8 with a BOM and CRLF. Text cells (names, text, url, option labels, note titles, file names) that start with `=`, `+`, `-`, `@`, tab, or CR get a leading `'`; numbers, dates, and checkboxes are written as-is. Note titles follow the caller's access (empty when unreadable). Importing an export removes the added `'`. Audit: `collection.export { collectionId, count }`.

### Collection sharing

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /:c/sharing` | owner | 200 `{ visibility, role: "viewer" \| "editor", users: [{ id, display_name }] }` | 403 `OWNER_ONLY`, 404 |
| `PUT /:c/sharing { visibility: "private" \| "selected" \| "all_users", userIds ≤ 100, role? = "viewer" }` | owner | 200 `{ ok: true }` | 400, 403, 404 |

Same rules as board sharing: the owner cannot be a recipient (400), `selected` needs at least one user (400), every user must exist and be enabled (400), and member rows are kept only for `selected`. `role` applies to the whole audience (D54). Removing someone revokes access to the collection, its rows, its search hits, and its row attachments at once. Audit: `collection.sharing_changed { collectionId, visibility, role, recipientCount }`.

**Query** (D56, T54). `sort` ≤ 3 `{ fieldId, direction: "asc" | "desc" }` (text, url, number, date, checkbox, and select fields; select sorts by option order; empty values last); `filters` ≤ 10 `{ fieldId, op, value? }`, AND-ed; `q` ≤ 200 characters matches any text or url field (case-insensitive substring); `limit` 1–100 (default 50). Field ids are checked against the schema, operators are enumerated, and JSON paths are bound as parameters. With `viewId`, the view's sort and filters apply unless the request gives its own; view clauses that name removed fields are dropped.

| Types | Operators and `value` |
| --- | --- |
| text, url | `contains` / `equals` (non-empty string), `empty`, `not_empty` |
| number, date | `eq`, `lt`, `lte`, `gt`, `gte` (a number, or `YYYY-MM-DD`), `empty` |
| checkbox | `is` (boolean) |
| select | `is`, `is_not` (an option id), `in` (1–20 option ids) |
| multi_select | `has_any`, `has_all` (1–20 option ids) |
| note, file | `empty`, `not_empty` |

`nextCursor` is opaque: an offset bound to the spec and to `schema_version`. A cursor from another spec is 400 `INVALID_CURSOR`; after a schema change it is 409 `SCHEMA_CHANGED`. Offsets stop at 10,000.

**Audit** (ids and counts only, never values or names): `collection.create { collectionId, fieldCount, templateId? }`, `collection.update`, `collection.delete`, `collection.schema_update { collectionId, fieldCount }`, `collection.row_create`, `collection.row_update { collectionId, rowId, fieldCount }`, `collection.row_undo`, `collection.row_delete`.
## Calendar (Wave 12)

Calendars, events, links, reminders, notifications, Web Push, and iCalendar feeds ([WAVES_10-12.md](WAVES_10-12.md) §4, D54, D61–D66). JSON only, except the feed itself.

**Roles (D54).** The owner does everything. Everyone the calendar is shared with (`visibility` `selected` with a member row, or `all_users`) gets the calendar's single audience role `share_role`: `viewer` reads, `editor` also creates, edits, undoes, skips dates on, links, and bins events. Only the owner renames, recolours, shares, or bins the calendar.

| Caller | Response |
| --- | --- |
| Cannot read the calendar (stranger, removed member, binned calendar) | **404** |
| Viewer calling an event write | 403 `{ code: "READ_ONLY" }` |
| Viewer or editor calling an owner-only action | 403 `{ code: "OWNER_ONLY" }` |

```ts
type CalendarColor = "blue" | "green" | "amber" | "red" | "violet" | "slate";
type CalendarSummary = {
  id: string; owner_id: string; owner_name: string; is_owner: 0 | 1;
  role: "owner" | "editor" | "viewer";
  name: string; color: CalendarColor; visibility: Visibility; share_role: "viewer" | "editor";
  created_at: string; updated_at: string;
};
type RepeatRule = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;                 // 1–99, default 1
  byDay?: ("MO"|"TU"|"WE"|"TH"|"FR"|"SA"|"SU")[];  // weekly only; must include the start's weekday
  until?: string;                   // yyyy-mm-dd, inclusive, local to the event
  count?: number;                   // 1–730; not with until
};
type EventDetail = {
  id: string; calendar_id: string; title: string; description: string; location: string;
  all_day: boolean;
  start_date: string | null; end_date: string | null;          // all-day: yyyy-mm-dd, end exclusive
  start_local: string | null; tz: string | null; duration_minutes: number | null;  // timed: yyyy-mm-ddTHH:MM, IANA zone, 1–10080
  repeat: RepeatRule | null; exdates: string[];                // skipped local start dates, ≤ 200
  revision: number; canUndo: boolean; changedByKey: boolean; changedByKeyName: string | null;  // MCP key behind the last change
  created_by_name: string | null; updated_by_name: string | null; created_at: string; updated_at: string;
};
type EventLink = { targetType: "note" | "card" | "collection_row"; targetId: string; title: string | null; restricted: boolean };
type EventResponse = { event: EventDetail; calendar: CalendarSummary; role: CalendarSummary["role"]; links: EventLink[] };
type Occurrence = {
  eventId: string; calendarId: string; title: string; location: string; color: CalendarColor;
  allDay: boolean;
  date: string;                     // local start date of the occurrence (what an exdate names)
  start: string; end: string;       // timed: UTC ISO instants; all-day: yyyy-mm-dd, end exclusive
  recurring: boolean;
};
```

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/calendars` | any | 200 `{ calendars: CalendarSummary[] }`, owned first. A user who has never had a calendar gets "Personal" (blue) on this call. | — |
| `POST /api/calendars {name, color?}` | any | 201 `{ calendar }` | 400; 409 `LIMIT_REACHED` (20 live calendars per owner) |
| `PATCH /api/calendars/:k {name?, color?}` | owner | 200 `{ calendar }` | 400, 403, 404 |
| `DELETE /api/calendars/:k` (to the Bin) | owner | 200 `{ ok, purgeAfter }` | 403, 404 |
| `GET /api/calendars/:k/sharing` | owner | 200 `{ visibility, shareRole, users: [{ id, display_name }] }` | 403, 404 |
| `PUT /api/calendars/:k/sharing {visibility, shareRole?, userIds≤100}` | owner | 200 `{ ok }`. Same rules as folder sharing: the owner is never a recipient, `selected` needs at least one enabled user. | 400, 403, 404 |
| `POST /api/calendars/:k/events` | editor | 201 `EventResponse` | 400, 403, 404; 409 `LIMIT_REACHED` (20k live events per calendar) |
| `GET /api/events?from&to&tz&calendars&include=tasks` | reader | 200 `{ occurrences: Occurrence[], truncated, tasks? }` | 400 |
| `GET /api/events/:e` | reader | 200 `EventResponse` | 404 |
| `PATCH /api/events/:e {…fields, revision}` | editor | 200 `EventResponse` | 400, 403, 404, 409 `EVENT_CHANGED` |
| `POST /api/events/:e/undo {revision}` | editor | 200 `EventResponse` | 403, 404, 409 `EVENT_CHANGED` or `NOTHING_TO_UNDO` |
| `POST /api/events/:e/exdates {date, revision?}` | editor | 200 `EventResponse` (idempotent) | 400 (not a repeating event, or not an occurrence date), 403, 404, 409 |
| `DELETE /api/events/:e` (to the Bin) | editor | 200 `{ ok, purgeAfter }` | 403, 404 |
| `POST /api/events/:e/links {targetType, targetId}` | editor | 201 `{ link }`, or 200 if already linked | 400, 403, 404 (target not readable by the linker); 409 `LIMIT_REACHED` (50 links) |
| `DELETE /api/events/:e/links {targetType, targetId}` | editor | 200 `{ ok }` | 403, 404 |

**Event bodies.** Create takes `{ title (1–200), description? (≤ 8 KiB, line breaks kept), location? (≤ 200), allDay, startDate+endDate | startLocal+tz+durationMinutes, repeat? }`. Titles, names, and locations reject control and bidi-override characters. Dates must be real (no 2026-02-30) and zones must be accepted by `Intl` (T71). PATCH takes any subset plus `revision`; timing fields are merged with the stored ones and validated together, and switching `allDay` needs the other mode's fields. Every successful change (PATCH, exdate) keeps the previous values for **one-step undo** (D61); undo itself cannot be undone. A stale `revision` returns 409 `{ code: "EVENT_CHANGED", revision, event }` with the current event.

**Range listing.** `from` and `to` are whole local days (`yyyy-mm-dd`, `to` exclusive) in the viewer's zone `tz` (default `UTC`), at most **100 days** apart (400 otherwise). Occurrences are expanded server-side: timed occurrences keep their wall time in the event's zone across DST (a gap shifts forward, an overlap takes the earlier instant); monthly repeats use the start's day of the month and skip months without it. An occurrence that started before `from` but overlaps the range is included. At most **1000** occurrences are returned per request; `truncated` is true when more existed (T66). `calendars` is an optional comma-separated list of up to 50 calendar ids; ids the caller cannot read are ignored.

**Tasks due (D67).** `include=tasks` (the only accepted value; anything else is 400) adds `tasks: [{ cardId, boardId, boardName, title, parentTitle, dueOn, dueTime, dueTz, dueAt, date }]` (`parentTitle`, 17A: the live parent on the same board, else null): live cards that fall in `[from, to)` for the viewer, on boards the caller can read (the Task Boards predicate), in columns not marked done, at most 200, ordered by `date` (date-only cards first, then timed ones by instant). A date-only card falls on its `due_on`; a card with a due time (Wave 13, §5.2) falls on the viewer-local day of its exact instant `dueAt` in `tz`, which `date` carries, so a card due 23:30 in UTC+14 shows a day earlier to a UTC−12 viewer. The query widens `[from, to)` by two days on each side (zones span 26 hours), but narrows in SQL before any limit: date-only cards must have `due_on` in `[from, to)`, and timed cards a wall time within 14 hours of the viewer's range; the exact instant check follows, so busy days just outside the range never push in-range cards out (at most 5000 rows are read before that check). The overlay is read-only and filters boards with `readableBoardPredicate` from `server/tasks/access.ts`. `cards.due_on` and `board_columns.is_done` come from migration 011, which always runs before 013. Without `include`, the key is absent.

**Links.** The linker must be able to read the target, and an unreadable target returns the same 404 as a missing one. Links are resolved per viewer on every read: the title when the viewer can read the target, otherwise `{ title: null, restricted: true }` (T59). Links never grant access. `note` targets use the live note ACL, `card` targets the Tasks board ACL (`readableCard`; the card's title), and `collection_row` targets the Collections ACL (`readableRow`; the row's primary field), each registered in `server/calendar/links.ts`.

**Audit.** `calendar.create`, `calendar.update`, `calendar.delete`, `calendar.sharing_changed { calendarId, visibility, shareRole, recipientCount }`, `event.create { eventId, calendarId }`, `event.update`, `event.undo`, `event.exdate`, `event.delete { eventId }`, `event.link` / `event.unlink { eventId, targetType, targetId }`. Ids only: titles, descriptions, and locations are never audited.

### Reminders and notifications (Wave 12 stage B)

Reminders are private to whoever set them (D64): every endpoint is scoped to the caller, and anyone who can read an event (viewers included) may set their own reminders on it.

```ts
type Reminder = { id: string; eventId: string | null; offsetMinutes: number | null; title: string | null; tz: string; nextFireAt: string | null; lastFiredAt: string | null; createdAt: string };
type NotificationItem = { id: string; title: string; href: string; late: boolean; read: boolean; createdAt: string; occurrenceStart: string | null };
```

| Endpoint | Success | Errors |
| --- | --- | --- |
| `GET /api/reminders?eventId` | 200 `{ reminders: Reminder[] }`: the caller's event reminders and upcoming standalone ones | 400 (malformed `eventId`) |
| `POST /api/reminders {eventId, offsetMinutes, tz}` | 201 `{ reminder }` | 400; 404 (event not readable); 409 `REMINDER_EXISTS` (same offset) or `LIMIT_REACHED` (10 per event per user) |
| `POST /api/reminders {title, fireAt, tz}` | 201 `{ reminder }` | 400 (`fireAt` is a real local `yyyy-mm-ddTHH:MM` in `tz`, in the future); 409 `LIMIT_REACHED` (500 upcoming standalone per user) |
| `DELETE /api/reminders/:id` | 200 `{ ok }` | 404 (missing or someone else's) |
| `GET /api/notifications?unread=1&limit` | 200 `{ items: NotificationItem[], unreadCount }`, newest first, `limit` 1–50 (default 20) | 400 |
| `POST /api/notifications/read {ids: uuid[1..100]} \| {all: true}` | 200 `{ ok, updated }`; ids that are not the caller's are ignored | 400 |

- `offsetMinutes` is how long before each occurrence starts the reminder fires (−1440 to 40320; negative is after the start). Timed events use their own zone; all-day events start at midnight in the reminder's `tz`, so 09:00 on the day is −540. A single event in the past has no upcoming time (400).
- **Dispatcher.** Every 30 s (an `unref` timer, one tick at a time, at most 200 reminders per tick) each due reminder is claimed, re-checked, written as a durable `notifications` row, and advanced to its next occurrence in one transaction. A reminder missed while the server was down fires once, `late: true`, when under 24 h late, and is skipped when later; either way it advances past now, so misses never pile up. At most 60 notifications per user per hour are written; the rest are dropped.
- **Access (T67).** At fire time the dispatcher re-checks that the user is still in the calendar's audience and deletes the reminder otherwise (audited `reminder.removed_access_lost`). A binned event or calendar pauses its reminders (`nextFireAt: null`); restoring it, editing the event's timing, undo, or skipping a date reschedules them.
- **Titles and links.** Titles are resolved when listed: the event's current title while the caller can read it, otherwise "An event you can no longer open"; a standalone reminder's own title. `href` is `/calendar/event/<id>` built from a validated event id, or `/notifications` (T68).
- **Retention.** The hourly sweeper deletes notifications after 30 days, and fired standalone reminders 30 days after they fired.
- **Audit.** `reminder.create { reminderId, eventId? }`, `reminder.delete { reminderId }`: ids only.
- **Today.** `listUpcoming(userId, tz, days)` in `server/calendar/service.ts` backs the `upcoming` section (registered in `server/today/providers.ts`, between `binSoon` and `storage`): unfinished occurrences through the next 7 local days, at most 10 with `more`, as `{ eventId, calendarId, title, start, end, allDay, date }`. `get_today` includes it, and calendar and event items in `binSoon`, only for keys that also hold `calendar:read` (T74).

### Web Push (Wave 12 stage C)

Payload-less Web Push (D65, T62, T63). A push has an empty body: it only wakes the device, and the service worker fetches `GET /api/notifications?unread=1` with the session cookie, so push services see timing only.

| Endpoint | Success | Errors |
| --- | --- | --- |
| `GET /api/push/config` | 200 `{ enabled: true, publicKey }` (base64url P-256 point) or `{ enabled: false, reason: "insecure_origin" \| "disabled" }` | — |
| `GET /api/push/subscriptions` | 200 `{ subscriptions: [{ id, label, createdAt, lastSuccessAt, disabled }] }` (endpoints are never returned) | — |
| `POST /api/push/subscriptions {endpoint, expirationTime?, keys: {p256dh, auth}, label?}` | 201 `{ subscription }`; 200 when the caller already has this endpoint (keys refreshed, failures cleared) | 400 `ENDPOINT_NOT_ALLOWED`; 409 `PUSH_DISABLED` or `LIMIT_REACHED` (10 per user) |
| `DELETE /api/push/subscriptions {id} \| {endpoint}` | 200 `{ ok }` | 404 (missing or someone else's) |
| `POST /api/push/test` | 200 `{ ok, sent, failed }` | 409 `PUSH_DISABLED`; 429 `RATE_LIMITED` with `Retry-After` (5 per hour per user) |

- **Enabled.** `PUSH_ENABLED=auto` turns push on only when `APP_ORIGIN` is `https:`; `true` forces it on and `false` off. When on, a VAPID ES256 key pair is created at first boot in `DATA_DIR/push/vapid.json` (0600, written atomically).
- **Endpoints.** `https:` on port 443, no credentials, not an IP literal, and a host on the allowlist (`*.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`, plus `PUSH_ENDPOINT_HOSTS`). Every address the host resolves to must be public (no private, loopback, link-local, CGNAT, or multicast ranges); this is checked when subscribing and again before each delivery. An endpoint is owned by one account: subscribing it from another account moves it.
- **Delivery.** After each dispatcher tick commits, every user who got a notification gets one push per device: `POST` with no body, `TTL: 3600`, `Urgency: normal`, and `Authorization: vapid t=<JWT>, k=<publicKey>` (claims `aud` = the endpoint's origin, `exp` = 12 h, `sub` = `PUSH_SUBJECT`). Redirects are not followed and requests time out after 5 s. 404 or 410 deletes the subscription; any other failure (including a redirect) counts, and 5 consecutive failures disable it until the device subscribes again.
- **Audit.** `push.subscribe { subscriptionId }`, `push.unsubscribe`. Endpoints and keys are never logged or audited.

<a id="calendar-feeds"></a>
### iCalendar feeds (Wave 12 stage D)

Read-only subscription links for phone and desktop calendars (D66, T64, T65, T70). A reader of a calendar (owner, editor, or viewer) creates up to **5** live links per calendar, each `busy` (times only, every event titled "Busy", and the calendar named "Busy") or `full` (titles, locations, and descriptions). The token is returned once and stored only as its SHA-256 hash plus a 13-character display prefix (`nookfeed_` and four characters).

```ts
type CalendarFeed = { id: string; calendarId: string; prefix: string; detail: "busy" | "full"; createdAt: string; lastUsedAt: string | null };
```

| Endpoint | Who | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/calendars/:k/feeds` | reader | 200 `{ feeds: CalendarFeed[] }`: the caller's own live links for this calendar, newest first | 404 |
| `POST /api/calendars/:k/feeds {detail}` | reader | 201 `{ feed, token, url }`; `url` is `<origin>/api/calendars/:k/feed.ics?token=<token>` on the request's origin when it is one of `APP_ORIGINS`, else `APP_ORIGIN` | 400; 404; 409 `LIMIT_REACHED` (5 live links per user per calendar) |
| `DELETE /api/feeds/:f` | the link's creator | 200 `{ ok }`; the link stops working at once | 404 (unknown, revoked, or someone else's) |
| `GET /api/calendars/:k/feed.ics?token=` | the token | 200 `text/calendar; charset=utf-8` | 404 for every failure; 429 with `Retry-After` above 60 fetches per hour per live token, and for failures past 30 per minute from one client address (live tokens from that address still work). Unknown tokens never get a per-token entry; both limiters are capped and evict the least recently used entry |

- **Authentication.** The feed route is the only `/api` path outside the session and TOTP middleware. `isFeedRequest` in `server/calendar/feeds.ts` exempts exactly `GET` or `HEAD` of `/api/calendars/<uuid>/feed.ics`; every other method, and any other path, still needs a session. Tokens are created from a signed-in (and, under `TOTP_POLICY=required`, gated) session.
- **Live access.** Every fetch re-checks that the token's creator is enabled, still allowed by `ALLOWED_EMAILS`, and can still read the calendar. A malformed, unknown, or revoked token, a token for another calendar, a binned calendar, and a creator who lost access all return the same `404 {"error":"Not found"}`.
- **Output (RFC 5545).** `VERSION:2.0`, `PRODID:-//Nook//Calendar feed//EN`, `METHOD:PUBLISH`, `X-WR-CALNAME`; one `VEVENT` per live event with `UID:<event id>@nook`, `DTSTAMP`, timed `DTSTART;TZID=<zone>:<local>` plus `DURATION:PT<n>M` or all-day `DTSTART;VALUE=DATE`/`DTEND;VALUE=DATE`, `RRULE` (`FREQ`, `INTERVAL`, `WKST=MO` and `BYDAY` for weekly, `COUNT`, or `UNTIL` as a date for all-day events and as the last second of the until day in UTC for timed ones), and `EXDATE` in the same form as the start. No `VTIMEZONE` blocks. `SUMMARY`, `LOCATION`, and `DESCRIPTION` are escaped (`\\`, `\;`, `\,`, and every CR, LF, CRLF, U+2028, or U+2029 as `\n`; other control characters dropped); lines are folded at 75 octets without splitting a UTF-8 sequence, with CRLF endings. At most 5000 events, most recent series first.
- **Headers.** `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and the global CSP unchanged. No cookie is set.
- **Bookkeeping.** `last_used_at` is written at most every 10 minutes. The token is never logged or audited; `calendar.feed_created` and `calendar.feed_revoked` record `{ feedId, calendarId }` only. Purging a calendar deletes its links.

<a id="calendar-items-in-the-bin"></a>
### Calendar items in the Bin (D68)

`DELETE /api/calendars/:k` and `DELETE /api/events/:e` move items to the shared Bin through Bin providers registered by `server/calendar/calendarBin.ts` (like Collections), with the same columns (`board_*` and `attachment*` null/false), 30-day retention, tombstone, and compare-and-swap restore as notes and documents (no bytes to remove).

| Item | Listed for | Restore | Delete forever |
| --- | --- | --- | --- |
| `calendar` (`folder_id`/`folder_name` null) | its owner | owner | owner; cascades to its events, members, links, reminders, and feeds |
| `event` (`folder_id`/`folder_name` = its calendar) | the calendar's owner, and whoever deleted it while they can still edit the calendar (`can_purge: false` for them) | the same two | the calendar's owner only (404 for anyone else) |

- A binned calendar hides all of its events; they are not listed one by one and come back with it.
- Restore responses for these types are `{ ok: true, calendarId, calendarName }` (plus `alreadyRestored: true` for a live item). Restoring an event whose calendar is in the Bin returns 409 `{ code: "PARENT_IN_BIN" }`; restoring a calendar when the owner already has 20 live ones returns 409 `{ code: "LIMIT_REACHED" }`. A purge in progress returns 409 `PURGING`, as for other types.
- `GET /api/bin?type=calendar|event` filters; the Bin app's Calendar chip shows both.
- Empty Bin purges the caller's binned calendars and the binned events on calendars they own; events they deleted on someone else's calendar stay for that owner.
- The hourly sweeper resumes tombstones and purges expired calendars and events with the same per-table budgets (events first).
- Audit: `calendar.restore { calendarId }`, `event.restore { eventId, calendarId }`, `calendar.purge { calendarId, reason }`, `event.purge { eventId, reason }` with `reason` `user`, `retention`, or `resumed`.

## Team (Wave 14)

Plan of record: [research/2026-09-26-team-module.md](research/2026-09-26-team-module.md) (§11 overrides the earlier text). Migration `017_team_roles`.

**Roles.** `users.role` is `admin | member | viewer | guest` (D71). All four are assignable since Wave 15 (see *Viewer and guest enforcement* below). The first account registered on an empty database is `admin` (D76, inside the register transaction), and so is one registered while no active admin exists (`role = 'admin' AND disabled_at IS NULL`), with a `team_events` row `via = 'bootstrap'`; every later registration gets `SIGNUP_ROLE` (`guest` by default, or `viewer` or `member`; never `admin`, D80), or the role of the invite it used (see *Invites* below); the server also logs a warning at boot in that state. On upgrade every account becomes `member` and the oldest enabled one `admin` (O8). `role` is returned on `user` by `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/auth/me`; no request body accepts it except the Team role route.

**Always one active admin.** "Active admin" means `role = 'admin' AND disabled_at IS NULL`. Every write that would leave none returns 409 `LAST_ADMIN`; the `users_keep_one_admin` triggers refuse it in SQL too (T78).

**Block.** Blocking reuses `users.disabled_at` (D74), shown as `blockedAt`. Sign-in for a blocked account returns 403 `{ code: "ACCOUNT_BLOCKED", error: "This account has been blocked. Contact your Nook administrator." }` only after the right password and before any second factor is checked; a wrong password still gets the generic 401. The block reason is never shown to the blocked user (O11).

### Types

```ts
type TeamRole = "admin" | "member" | "viewer" | "guest";
type TeamMember = {
  id: string; displayName: string; role: TeamRole; status: "active" | "blocked"; createdAt: string; isYou: boolean;
  // Admins only (T85): absent for everyone else.
  email?: string; lastSeenAt?: string | null; blockedAt?: string | null;
  blockedBy?: { id: string; displayName: string } | null; blockReason?: string | null;
  totpEnabled?: boolean; mcpKeys?: { live: number }; storageBytes?: number; emailAllowed?: boolean;
};
type TeamEvent = {
  id: string; action: "role_change" | "block" | "unblock" | "sessions_revoked" | "bootstrap_admin";
  via: "web" | "cli" | "migration" | "bootstrap" | "mcp"; fromRole: TeamRole | null; toRole: TeamRole | null;
  reason: string | null; createdAt: string; actor: { id: string; displayName: string } | null;
};
```

`lastSeenAt` is the latest `last_seen_at` of the account's live sessions (null once they are gone). `blockedBy` is null for accounts disabled before migration 017 ("Blocked (before Team)"). `emailAllowed` is false when the address is no longer on `ALLOWED_EMAILS`, so the account cannot sign in. `storageBytes` is the quota sum (live and binned documents).

### Endpoints

Guests get **404** on every Team route. Members and viewers read; every write needs `admin` (403 `ADMIN_ONLY` otherwise). Writes count against 30 a minute per admin (429 `RATE_LIMITED`). A malformed or unknown `:userId` is 404. Bodies are strict JSON (extra fields are 400).

| Endpoint | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/team` | | 200 `{ me: { id, role }, users: TeamMember[] }`, active before blocked, then admin, member, viewer, guest, then name; at most 500 | 404 (guest) |
| `GET /api/team/:userId` | | 200 `{ member: TeamMember & { events?: TeamEvent[] } }`; `events` (latest 50) for admins only | 404 |
| `PUT /api/team/:userId/role` | `{ role, expectedRole }` (strict: any other field → 400) | 200 `{ changed, role, member }`; `changed: false` when `role` equals the current role (no event) | 409 `ROLE_CHANGED` `{ currentRole }` (compare-and-swap on `expectedRole`, T79), `LAST_ADMIN` |
| `POST /api/team/:userId/block` | `{ reason?: string ≤ 200 }` (strict: any other field → 400) | 200 `{ blockedAt, sessionsRevoked, mcpKeysPaused, member }` | 409 `SELF_ACTION`, `ALREADY_BLOCKED`, `LAST_ADMIN`, `ROLE_CHANGED` |
| `POST /api/team/:userId/unblock` | `{}` | 200 `{ ok: true, member }` | 409 `NOT_BLOCKED` |
| `POST /api/team/:userId/sessions/revoke` | `{}` | 200 `{ sessionsRevoked, member }` | 409 `SELF_ACTION` (use Sign out) |

- **No re-authentication.** Team writes rely on the signed-in session, CSRF (Origin + `X-CSRF-Token`, JSON only), SameSite=Strict cookies, and the admin capability. The password + second-factor re-check was removed by operator decision on 2026-09-27 (it created friction). The residual risk is recorded in THREAT_MODEL T77/T82.
- **Role change** runs `UPDATE users SET role = ? WHERE id = ? AND role = ?`. It takes effect on the target's next request (the role is read on every request, no cache). An admin may demote themselves while another active admin exists.
- **Block** runs one transaction: set `disabled_at`, `blocked_by`, `block_reason`; delete every session of the account (an unblock does not revive them); delete its push subscriptions. MCP keys and calendar feed tokens are kept and pause (their existing `disabled_at` checks), then resume on unblock (O9). Content the account owns stays where it is and stays shared (O10). The account drops out of share pickers and assignee lists. An upload that passed `requireAuth` before the block fails at commit with 401 and its staged object is removed; the reminders dispatcher skips blocked accounts (their reminders stay due and fire after an unblock). Upload slots are per request in memory and are released as those requests fail; there are no persistent upload reservations.
- **Unblock** clears the three columns. The account signs in again with its existing password and second factor; push must be re-enabled per device; the role is unchanged.
- **Audit and activity** (T83): each write adds one `team_events` row (append-only through triggers) and one `audit_log` row with ids and roles only: `team.role_changed { targetId, fromRole, toRole, via }`, `team.user_blocked { targetId, sessions, via }`, `team.user_unblocked { targetId, via }`, `team.sessions_revoked { targetId, sessions, via }`, `team.bootstrap_admin { targetId }`, and . The block reason lives only in `users.block_reason` and the `block` event. Blocked sign-in attempts are audited as `auth.login_blocked`.

### Invites (Wave 18)

Plan of record: [WAVES_18-20_SMALL.md](WAVES_18-20_SMALL.md) §1 and its Director review. Migration `018_team_invites`. Decisions D161–D169.

An admin creates a **single-use link with a fixed team role** (`member`, `viewer`, or `guest`; never `admin`, which the migration's CHECK also refuses). The link is `<origin>/register#invite=<token>`: the token sits in the URL **fragment**, which browsers never send to the server, so it stays out of access logs, proxies, and `Referer`. The SPA reads it once, strips it from the address bar with `history.replaceState`, and posts it in JSON bodies only. The token is 32 random bytes in base64url (43 characters); only its SHA-256 and a 6-character prefix are stored, and it is returned once, by the create call.

```ts
type TeamInvite = {
  id: string; tokenPrefix: string; role: "member" | "viewer" | "guest";
  email: string | null;          // bound address: only it can register with the link
  note: string | null;           // admin-only label, at most 80 characters
  status: "live" | "used" | "expired" | "revoked";
  createdAt: string; expiresAt: string;
  createdBy: { id: string; displayName: string } | null;
  usedBy: { id: string; displayName: string } | null;
  usedAt: string | null; revokedAt: string | null;
};
type MailOutcome = { sent: true; id: string } | { sent: false; reason: "not_configured" | "rate_limited" | "failed" };
```

An invite is **usable** only while it is unused, unrevoked, unexpired, and its creator is still an **active admin** (`role = 'admin' AND disabled_at IS NULL`, checked at use time): a demoted or blocked admin's links stop working, and work again if the privilege is restored.

| Endpoint | Who | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/team/invites` | admin | | 200 `{ invites: TeamInvite[], liveCount, liveLimit: 20, emailEnabled }`: every live invite plus the latest 100 others, newest first | 404 (guest), 403 `ADMIN_ONLY` |
| `POST /api/team/invites` | admin | `{ role, email?, expiresInDays?: 1..7 (default 7), note?, sendEmail? }` (strict) | 201 `{ invite, token, url, email?: MailOutcome }`; `email` only with `sendEmail` | 400 `EMAIL_NOT_ALLOWED` (bound email not on `ALLOWED_EMAILS`), 400 `EMAIL_REQUIRED` (`sendEmail` without `email`), 409 `ACCOUNT_EXISTS`, 409 `INVITE_LIMIT` (20 live on the instance), 429 `RATE_LIMITED` (10 creations an hour per admin) |
| `POST /api/team/invites/:inviteId/revoke` | admin | `{}` | 200 `{ invite }`; repeating on a revoked invite answers the same | 404, 409 `INVITE_NOT_LIVE` (used or expired) |
| `POST /api/team/invites/:inviteId/email` | admin | `{}` | 200 `{ invite, email: MailOutcome }`. A fresh token is mailed to the bound address; once the mail is accepted it replaces the old one, so the earlier link stops working. The new token is never returned. | 400 `EMAIL_REQUIRED` (no bound email), 404, 409 `INVITE_NOT_LIVE` |
| `POST /api/auth/invite` | anyone (pre-auth: Origin and JSON checks, no session) | `{ token }` | 200 `{ role, emailHint, expiresAt, inviterName }`; `emailHint` is masked (`p•••@example.com`) or null | 400 (malformed), 404 `INVITE_INVALID` (unknown, used, revoked, or creator no longer an active admin), 410 `INVITE_EXPIRED`, 429 (30 a minute, instance-wide) |

The invite writes also count against the 30 Team writes a minute per admin. `/api/team/invites` is matched before `/api/team/:userId`.

**Register with an invite.** `POST /api/auth/register` accepts an optional `inviteToken` (the body stays strict, so `role` is still refused with 400). With a token:

- the body is read before the `ALLOW_REGISTRATION` check, and a usable invite **bypasses only** `ALLOW_REGISTRATION`; `ALLOWED_EMAILS` still applies (403);
- the invite is checked before the "account exists" lookup, so a made-up token cannot probe which emails are registered;
- a bound email must match case-insensitively (403 `INVITE_EMAIL_MISMATCH`);
- 404 `INVITE_INVALID` or 410 `INVITE_EXPIRED` otherwise. An invalid token is **never silently ignored**, even while registration is open;
- the account gets the invite's role, and the invite is claimed inside the user-insert transaction by one guarded `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now`; a lost race rolls the new account back and answers `INVITE_INVALID` (T141);
- an **empty instance ignores the token**: its first account is the admin (D76, D163). On an instance whose accounts exist but have no active admin, no invite is usable (its creator is not an active admin), so the call fails instead of creating an admin.

**Audit.** `team.invite_create`, `team.invite_revoke`, `team.invite_accept` (actor: the new account), and `team.invite_emailed`, each with `{ inviteId, role }` only: never the token, its hash, or an email. `team_events` is unchanged; the admin member detail gets `joinedWithInvite: { role, usedAt, invitedBy } | null`, derived from `team_invites.used_by`, shown in Activity as "Joined with an invite from <admin>, as <role>".

**Sweeper.** Invites dead (used, revoked, or expired) for 90 days are deleted hourly. Live invites are never swept.

**Email.** `sendEmail` and the email route go through `server/mail.ts` (Resend, see OPERATIONS.md "Email (Resend)"). Mail goes only to the invite's bound address. When email is off (`RESEND_API_KEY` or `MAIL_FROM` unset) the invite is still created and the outcome is `{ sent: false, reason: "not_configured" }`; the UI shows "Email is not configured". The message is plain text plus minimal inline-styled HTML with the link, the role, the expiry (UTC), and the inviter's display name; no images, remote content, or tracking.

### Host CLI

`bun server/team-admin.ts list | set-role <email> admin|member|viewer|guest | unblock <email>` (in Docker: `docker compose exec mynotes bun server/team-admin.ts …`). It runs the same service functions with no actor and `via = 'cli'`, so the last-admin rule applies; exit codes are 0 (done), 1 (refused or unknown account, with the error code), and 2 (usage).

### MCP (`team:read`)

`team:read` is admin-only: `POST /api/mcp/keys` refuses it for other roles with 403 `SCOPE_NOT_ALLOWED`, and a key's **effective scopes** are its stored scopes narrowed to what the holder's current role allows, computed on every `/mcp` request and every tool call (`effectiveMcpScopes`, T81). A demoted admin's key loses the Team tools on its next call (hidden from `tools/list`, `SCOPE_REQUIRED` from a direct call) and gets them back if the role is restored. No write tools exist (D79). Output never includes emails or block reasons (O12).

| Tool | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `list_team_members` | team:read | `{ role?, status?: "active" \| "blocked" }` | `{ members: [{ id, displayName, role, status, createdAt, lastSeenAt }] }` |
| `get_team_member` | team:read | `{ userId }` | the same fields plus `blockedAt` and `events` (latest 20: `{ action, fromRole, toRole, createdAt, actor }` with the actor's display name) |
| `list_invites` | team:read | `{ status?: "live" \| "all" }` (default all) | `{ liveCount, liveLimit, invites: [{ id, role, status, createdAt, expiresAt, createdBy, usedBy }] }` with display names; never a token, prefix, email, or label. There is no create, revoke, or email tool (D168). |

## Viewer and guest enforcement (Wave 15)

Plan of record: [research/2026-09-26-team-module.md](research/2026-09-26-team-module.md) §2.2, §5.2–§5.4, §8, and the 17C note in [research/2026-09-26-task-hierarchy-workflows.md](research/2026-09-26-task-hierarchy-workflows.md) (Q12). No migration.

**Audience.** `all_users` ("Everyone here") means every account except guests. Every SQL comparison `x.visibility = 'all_users'` is ANDed with `AUDIENCE_ALL_USERS` (`server/team/roles.ts`): notes, folders, files, search, boards and their cards, card relations, the task query, task views, board readers and assignees, collections, calendars and events, Today, feeds, and MCP. A guest therefore reads only their own items and items shared with them by name (`selected`); a viewer reads `all_users` too. A role change applies on the next request (T84).

**Write gate.** For viewers and guests every `/api` request other than GET, HEAD, or OPTIONS is refused with 403 `{ error: "Your team role is read-only", code: "ROLE_READ_ONLY" }` unless it is on this exact allowlist (`ROLE_READ_ONLY_ALLOWED_WRITES` in `server/team/writeGate.ts`; `:param` is one path segment):

| Method and path | Who | Why |
| --- | --- | --- |
| `POST /api/auth/logout` | both | sign out |
| `POST /api/auth/totp/setup`, `POST /api/auth/totp/enable`, `POST /api/auth/totp/recovery-codes`, `POST /api/auth/totp/recovery-codes/regenerate`, `DELETE /api/auth/totp` | both | own two-factor |
| `POST /api/notifications/read` | both | own notifications |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions`, `POST /api/push/test` | both | own push devices |
| `POST /api/reminders`, `DELETE /api/reminders/:reminderId` | both | own reminders on readable events (O4) |
| `PUT /api/preferences` | both | own Modules preference |
| `POST /api/mcp/keys`, `DELETE /api/mcp/keys/:id` | both | own keys; creation is then limited by role (below) |
| `POST /api/collections/:collectionId/query` | both | a read sent as POST |
| `POST /api/tasks/query` | both | a read sent as POST; a **guest's** `q` must contain a plain `assignee:me` term (not negated, the only value), otherwise 403 `ROLE_READ_ONLY` |
| `POST /api/inbox/proposals/:id/reject`, `POST /api/inbox/proposals/bulk`, `PUT /api/inbox/settings` | viewer | clear own proposals and the own proposal push setting (Wave 21, D152); bulk `approve` is refused by the handler with 403 `ROLE_READ_ONLY` |
| `POST /api/tasks/views`, `PATCH /api/tasks/views/:viewId`, `DELETE /api/tasks/views/:viewId`, `POST /api/tasks/views/:viewId/duplicate` | viewer | own private views; `PUT /api/tasks/views/:viewId/sharing` stays refused |

`/api/team/*` answers for itself (guests 404, others 403 `ADMIN_ONLY` on writes). Login and register have no session and are unaffected. Everything else, including every route added later, is refused: note drafts, publish, version restore, sharing, folders, uploads and file changes, Bin restore, purge, and empty (O3), cards, comments, boards, columns, tags, collections, rows, imports, schema, calendars, events, links, and feed tokens (O5). `GET /api/tasks/views/:viewId/cards` is a read. `tests/writeGate.test.ts` enumerates every mutating route in `server/` and checks each one for both roles (T87).

**Share roles** (§2.4): a viewer or guest on a collection or calendar shared with `share_role = "editor"` gets `role: "viewer"` in every response and is refused writes with `READ_ONLY` by the services, which also refuse a read-only role on items it owns. Read-only roles are not given a Personal calendar on first list.

**Share picker.** `GET /api/users` is 403 `ROLE_READ_ONLY` for viewers and guests (they cannot share). For others each entry gains `role`, so pickers can show "Guest" or "Viewer" next to recipients who will only read.

**MCP.** `mcpScopesForRole`: admin every scope; member every scope but `team:read`; viewer the read scopes only (`notes:read`, `files:read`, `tasks:read`, `today:read`, `calendar:read`, `collections:read`); guest none. Effective scopes are recomputed on every request and tool call (T81), so a demoted member's write key loses its write tools at once and a guest's key has no tools at all. `POST /api/mcp/keys` refuses guests with 403 `ROLE_READ_ONLY` and a viewer asking for a write scope with 403 `SCOPE_NOT_ALLOWED`. Write tools also re-check the holder's role before running (`READ_ONLY`).

**Sign-up role.** `SIGNUP_ROLE` (env, validated at startup: `guest | viewer | member`, default `guest`) is the role of accounts registered after the first (D80, O14).

## Inbox (Wave 21)

Plan of record: [research/2026-09-28-agent-inbox-routines.md](research/2026-09-28-agent-inbox-routines.md) (Wave A; D146–D160 and the director review). Migration `021_agent_inbox` creates `proposals`, `routines`, and `routine_runs` (the last two used from Wave 22, below), adds `notifications.kind | run_id | proposal_key_id | proposal_count`, adds `user_preferences.proposal_push`, and backfills every live MCP-written note draft as a pending `note_draft` proposal.

A **proposal** is a change an MCP key suggests. Only the key's owner sees and reviews it (D147); anyone else gets 404, admins included. It applies only through `approve` below, under a signed-in session that passed CSRF and the TOTP gate; there is no MCP approve tool and no auto-apply (D146).

**Kinds** (D150) mirror the MCP write tools one to one; the payload is that tool's arguments:

| Kind | Payload | Module scope the key also needs | Applied by |
| --- | --- | --- | --- |
| `card_create` | `create_card` arguments | `tasks:read` | `create_card` as the approver |
| `card_update` | `update_card` arguments (with `baseRevision`) | `tasks:read` | `update_card` as the approver (`CARD_CHANGED` fails) |
| `card_comment` | `comment_on_card` arguments (body ≤ 8 KiB) | `tasks:read` | `comment_on_card` as the approver |
| `event_create` | `create_event` arguments | `calendar:read` | `create_event` as the approver |
| `event_update` | `update_event` arguments (with `baseRevision`) | `calendar:read` | `update_event` as the approver (`EVENT_CHANGED` fails) |
| `row_create` | `create_row` arguments | `collections:read` | `create_row` as the approver |
| `row_update` | `update_row` arguments (with `baseRevision`) | `collections:read` | `update_row` as the approver (`ROW_CHANGED`, `SCHEMA_CHANGED` fail) |
| `note_draft` | `{ noteId?, folderId?, markdown, mode?: "replace" \| "append", baseRevision? }` | `notes:write-draft` | publish of exactly the recorded draft revision (`DRAFT_CHANGED` fails) |

**Double validation** (D148): at submit the tool's own input schema validates the payload and the target must be readable by the owner (`NOT_FOUND`, the same as missing); at approve the tool's handler runs again through the module's service as the **approver** (ACL, role, CAS, caps). A refusal makes the proposal `failed` with the service's code and nothing is applied. The service's own audit event carries `{ via: "proposal", proposalId, keyId }`; calendar and collection writes set `updated_via_key_id` to the proposal's key, so "Changed by key" still names the agent.

A `note_draft` proposal is a pointer `{ noteId, revision, created }` (D149): submitting writes the draft at once (as `update_note_draft`/`create_note` do), and plain `update_note_draft` and `create_note` record the same proposal. A newer MCP draft on the note supersedes the older proposal. Publishing in the editor resolves it (`applied` `PUBLISHED_IN_EDITOR` when it published that revision, else `superseded` `DRAFT_CHANGED`); discarding rejects it (`DISCARDED_IN_EDITOR`); restoring a version supersedes it (`VERSION_RESTORED`).

**Statuses:** `pending`, `applying` (claimed by an approve in progress), `applied`, `rejected`, `expired`, `failed`, `superseded`, `withdrawn`. Every status but `pending` and `applying` is final.

### Types

```ts
type ProposalSummary = {
  id: string; kind: ProposalKind; kindLabel: string;
  title: string;            // agent text (≤ 120, controls, bidi, and zero-width characters stripped): render as text only
  rationale: string | null; // agent text (≤ 1000, newlines kept): render as text only
  status: ProposalStatus;
  targetLabel: string;      // Nook's own name for the target, resolved for the viewer now, or "restricted"
  restricted: boolean; targetHref: string | null; // ids only; null when restricted
  digest: string; keyName: string;
  createdAt: string; expiresAt: string; resolvedAt: string | null;
  resultCode: string | null; rejectReason: string | null;
  ref: { type: "note" | "card" | "event" | "row"; id: string; href: string } | null; // what an approve produced
  rejectEffect?: "restore" | "discard" | "keep"; // pending note_draft only: what a reject would do to the draft now
};
type ProposalPreview =
  | { restricted: true }
  | { fields: Array<{ name: string; before: string | null; after: string | null }> }
  // base: what the agent's changes are measured against ("Changes by the agent"): the draft recorded just
  // before the agent wrote (baseKind "draft", migration 027), else the published version ("published").
  | { markdown: { published: string; base: string; baseKind: "draft" | "published"; draft: string; draftChanged: boolean } };
```

### Endpoints

Guests get **404** on every Inbox route (and the write gate refuses their writes). Read-only roles may reject (allowlisted above) but not approve.

| Endpoint | Body / query | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/inbox/proposals` | `status=pending\|resolved` (default pending), `group=run\|none`, `cursor`, `limit ≤ 50` | 200 `{ groups: [{ routine: null, run: null, key: { name } \| null, items: ProposalSummary[] }], nextCursor }`. Pending: newest group first, items in submission order. Resolved: newest resolved first | 400 (bad query or cursor) |
| `GET /api/inbox/proposals/:id` | | 200 `{ proposal: ProposalSummary & { preview, position?: { index, of, nextId } } }`; the preview is computed now, for the viewer, never stored | 404 |
| `POST /api/inbox/proposals/:id/approve` | `{}` | 200 `{ id, status: "applied", ref }` | 409 `{ status: "failed", code }` (nothing applied); 409 `NOT_PENDING` `{ status }`; 409 `KEY_REVOKED` `{ status: "superseded" }` (the suggesting key was revoked; revoking a key supersedes its pending proposals with `result_code` KEY_REVOKED, and note drafts stay in their notes); 409 `EXPIRED` `{ status: "expired" }` (past `expiresAt`, marked expired at once, before the hourly sweep); 403 `ROLE_READ_ONLY`; 404 |
| `POST /api/inbox/proposals/:id/reject` | `{ reason?: string }` (the user's words, cleaned and cut to 200; the agent can read it) | 200 `{ id, status: "rejected", draft?, draftDiscarded? }`. A `note_draft` acts only while the draft is still the proposed revision and the user may write: `draft: "restored"` writes back the draft from before the agent's write as a new revision (audited `inbox.draft_restored`); `"discarded"` drops the agent's draft of a published note that had none; otherwise `"kept"` (a never-published note is never binned by a reject; a draft edited since is left alone). `draftDiscarded` is `draft === "discarded"` | 409 `NOT_PENDING`; 404 |
| `POST /api/inbox/proposals/bulk` | `{ action: "approve" \| "reject", ids: uuid[1..50] }` or `{ action, runId }`, `reason?` | 200 `{ results: [{ id, status, code?, ref?, error? }] }`, applied **one at a time in submission order**, never all-or-nothing; unknown ids are `not_found` | 400; 403 `ROLE_READ_ONLY` (approve by a read-only role) |
| `GET /api/inbox/count` | | 200 `{ pending }`, at most 100 (`SELECT 1 … LIMIT 100`, T51) | |
| `GET /api/inbox/settings`, `PUT /api/inbox/settings` | `{ push: boolean }` | 200 `{ push }`: whether new-proposal notifications are also pushed (off by default, O5) | 400 |

Approve claims the row `pending → applying` before the service runs, so a double click or a second tab gets `NOT_PENDING`; an unexpected error releases the claim, and a crash leaves `applying`, which the sweeper fails as `INTERRUPTED` after 10 minutes (T129).

**Sweeper** (hourly, D156): pending proposals past `expires_at` (14 days) become `expired` (their targets are untouched; an expired note draft keeps its draft and badge), and resolved proposals are deleted 90 days after they resolved. Audit rows stay.

**Notifications** (D159): a successful `submit_proposals` adds `N` to the key's unread `proposals` notification from the last 15 minutes, or creates one. `GET /api/notifications` lists it as `{ title: "Key “<key name>” suggested N changes", href: "/inbox" }`, built at read time from the key name and the count only, never agent text (T127, T135). It is pushed (payload-less, as reminders) only when the user turned on `push`.

**Today** (D158): the `proposals` section ("Proposals awaiting you", Today group) lists the owner's pending proposals `{ id, kind, kindLabel, title, keyName, created_at, expires_at }`, ten plus `more` from an eleven-row fetch, `href: "/inbox"`. The `agentDrafts` section is no longer returned. `get_today` includes `proposals` for keys with `inbox:read`, listing only that key's own proposals.

**Audit:** `proposal.submitted { keyId, kind, runId, proposalId }`, `proposal.applied { proposalId, kind, keyId }` (plus the service's event with `via: "proposal"`), `proposal.failed { proposalId, kind, keyId, code }`, `proposal.rejected`, `proposal.withdrawn`, `proposal.expired { count }`, `inbox.push_setting { enabled }`. No titles, payloads, or reasons.

### MCP (`inbox:read`, `inbox:write`)

`inbox:write` implies `inbox:read`. Both are member-only: `mcpScopesForRole` leaves them out for viewers and guests (D152). Neither can approve anything (T125).

| Tool | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `submit_proposals` | inbox:write (+ each kind's module scope) | `{ proposals: [{ kind, title, rationale?, payload }] }`, 1–20 | `{ results: [{ proposalId, status: "pending", expiresAt } \| { error, code, details? }], submitted }`, validated and saved per item. Codes: `INVALID`, `NOT_FOUND`, `SCOPE_REQUIRED`, `READ_ONLY`, `LIMIT_REACHED` (500 pending), `RATE_LIMITED` (`retryAfterSeconds`), `TOO_LARGE` (payload > 64 KiB), `DRAFT_CHANGED` |
| `list_my_proposals` | inbox:read | `{ status?, limit ≤ 50 }` | `{ proposals: [{ id, kind, title, status, resultCode, rejectReason, createdAt, expiresAt, resolvedAt }] }`, this key's own only (T131) |
| `withdraw_proposal` | inbox:write | `{ proposalId }` | `{ proposalId, status: "withdrawn" }`; `NOT_FOUND` for another key's; `INVALID` once resolved |

**Limits:** every item costs one `proposal_write` (200 a day per key, 400 per user); the call costs one `write`. At most 500 pending proposals per user. Payloads are at most 64 KiB of JSON.

## Inbox routines (Wave 22)

Plan of record: the same research doc, §5, §7.2, §8 (Wave B; D152–D155, D159, D160). No new migration: `routines` and `routine_runs` come from `021_agent_inbox`.

A **routine** is a user's stored prompt for an outside agent. Nook never runs it: a client asks what is due, starts a run, submits proposals into it, and finishes it. Every proposal still waits for the owner (D146). Routines are private to their owner (404 for anyone else, admins included); only members and admins create or change them, and a demotion to viewer or guest pauses them (D152).

### Types

```ts
type Routine = {
  id: string; name: string;            // 1–80, unique per owner case-folded
  instructions: string;                // 1 B–16 KiB, the prompt the client runs
  outputKinds: ProposalKind[];         // non-empty; submit refuses other kinds (KIND_NOT_ALLOWED)
  targets: { boardIds?, calendarIds?, collectionIds?, folderIds?: string[] } | null; // ≤ 20 each; readable (folders: owned) when saved
  scopeHints: string | null;           // ≤ 500, guidance only
  cadence: "manual" | "hourly" | "daily" | "weekdays" | "weekly";
  atTime: string | null;               // HH:MM (hourly uses the minute); null for manual
  weekday: number | null;              // 0 Sunday … 6 Saturday, weekly only
  tz: string; scheduleNote: string | null; scheduleText: string; // "Mondays at 08:00"
  keyId: string | null; keyName: string | null; keyRevoked: boolean; // bound key, or any of the owner's keys
  maxProposals: number;                // per run, 1–100, default 25
  expireDays: number;                  // 1–30, default 14, for this routine's proposals
  enabled: boolean; nextDueAt: string | null; due: boolean;
  lastRunAt: string | null; lastRunStatus: RunStatus | null;
  running: { id, startedAt, leaseExpiresAt } | null;
  revision: number; createdAt: string; updatedAt: string;
};
type RunStatus = "running" | "succeeded" | "failed" | "abandoned";
type RunSummary = {
  id, routineId, routineName, status, startedAt, finishedAt, leaseExpiresAt, durationMs,
  toolCalls: number;   // counted by Nook (D160), never reported by the client
  proposals: number; capped: boolean;
  summary: string | null; error: string | null; // agent text: render as text only
  clientLabel: string | null; keyName: string | null;
};
```

**Schedule** (D153): wall-clock slots in `tz`. A new or rescheduled routine is due from its current period's slot (a daily 08:00 routine created at 10:00 is due at once). A resumed one is too, unless a run (not an abandoned one) already took that slot: then it is due at the first slot after max(that slot, now), so pausing and resuming never makes today's run due again. `finish_run` advances `nextDueAt` to the first slot after both the run's slot and now, so a late run does not drift and missed slots do not pile up. A DST gap moves the slot forward by the gap; a repeated hour uses the earlier instant. `manual` is never due but can still be started.

### Endpoints

| Endpoint | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/inbox/routines` | | 200 `{ routines: Routine[] }` by name | |
| `POST /api/inbox/routines` | `RoutineInput` (the fields above without server-maintained ones; `atTime`, `weekday`, `targets`, `scopeHints`, `scheduleNote`, `keyId`, `maxProposals`, `expireDays`, `enabled` optional) | 200 `{ routine }` | 400 `INVALID`, `INVALID_SCHEDULE`, `INVALID_TIME_ZONE`, `LIMIT_REACHED` (50 per user); 404 `KEY_NOT_FOUND`, `NOT_FOUND` `{ id }` (an unreadable pin); 409 `NAME_TAKEN`; 403 `ROLE_READ_ONLY` |
| `GET /api/inbox/routines/:id` | | 200 `{ routine }` | 404 |
| `PATCH /api/inbox/routines/:id` | any `RoutineInput` fields plus `revision` | 200 `{ routine }` (revision + 1) | as POST; 409 `ROUTINE_CHANGED` `{ revision }` |
| `DELETE /api/inbox/routines/:id` | | 200 `{ deleted: true }`: a hard delete; runs cascade; its proposals stay, grouped under their key | 404 |
| `POST /api/inbox/routines/:id/pause`, `…/resume` | `{}` | 200 `{ routine }` | 404; 403 `ROLE_READ_ONLY` |
| `GET /api/inbox/routines/:id/runs` | | 200 `{ runs: RunSummary[] }`, the last 50, newest first | 404 |
| `GET /api/inbox/runs/:id` | | 200 `{ run: RunSummary, proposals: ProposalSummary[] }` | 404 |

`GET /api/inbox/proposals?group=run` now fills `routine: { id, name }` and `run: { id, startedAt, summary, status, capped }` for proposals made in a run, one group per run. `POST /api/inbox/proposals/bulk` with `runId` approves or rejects that run's pending proposals.

**Notifications** (D159): proposals submitted in a run do not notify at submit. `finish_run` (or the sweep abandoning a run) adds one `proposals` notification with the run's count, listed as `"<routine name> suggested N changes"`; the title uses the user's routine name and the count only.

**Sweeper** (hourly, and lazily per owner before routine reads and run starts): a `running` run past `lease_expires_at` becomes `abandoned` (`finished_at` = the lease end); the routine keeps its `next_due_at`, so it stays due, and the run's proposals stay pending. Finished runs are deleted after 180 days.

**Audit:** `routine.created { routineId, cadence, kinds, keyBound }`, `routine.updated | paused | resumed { routineId, scheduleChanged }`, `routine.deleted`, `routine.run_started { routineId, runId, keyId }`, `routine.run_finished { routineId, runId, status, proposals, toolCalls }`, `routine.run_abandoned`. No names, instructions, or summaries.

### MCP

| Tool | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `list_routines` | inbox:read | `{}` | `{ routines: [{ routineId, name, schedule, scheduleNote, enabled, nextDueAt, due, runsAvailable, lastRun }] }`: unbound routines and ones bound to this key; no instructions |
| `list_due_routines` | inbox:read | `{}` | `{ routines: [{ routineId, name, dueAt, schedule, scheduleNote, runsAvailable }] }`: enabled, due now, visible to this key, oldest due first, at most 20 |
| `start_run` | inbox:write (`run_start`: 48 a day per key, 200 per user) | `{ routineId, clientLabel? ≤ 60 }` | `{ runId, leaseExpiresAt (2 h), routine: { routineId, name, instructions, outputKinds, targets, scopeHints, scheduleNote, maxProposals, dueAt }, protocol, lastRun: { status, startedAt, finishedAt, summary, proposals } \| null, recentlyRejected: [{ title, reason }] }`. `NOT_FOUND` for an unknown, paused, or other-key routine; `RUN_ACTIVE` `{ leaseExpiresAt }` while a run holds the lease |
| `submit_proposals` | as above | `{ runId?, proposals }` | with `runId` (this key's own open run; `NOT_FOUND` otherwise, `INVALID` once finished or abandoned): per-item `KIND_NOT_ALLOWED`, `TARGET_NOT_ALLOWED` (a pinned module's item outside its pins; a note draft's folder is checked before the draft is written), `LIMIT_REACHED` past `maxProposals` (the run is flagged `capped`); proposals expire after the routine's `expireDays`; the result adds `runId` |
| `finish_run` | inbox:write | `{ runId, status: "succeeded" \| "failed", summary? ≤ 4096 B, error? ≤ 500 }` | `{ runId, status, proposals, toolCalls, capped, durationMs, nextDueAt }`; `NOT_FOUND` for another key's run; `INVALID` once finished or abandoned; `TOO_LARGE` |

**Tool calls** (D160, T134): while a key holds an open run, every admitted call it makes adds one to that run's `toolCalls` (the newest open run if it holds several). `start_run` itself runs before the run exists.

**Prompts** (O7): for keys with `inbox:read`, each enabled routine visible to the key is the MCP prompt `routine.<slug>` (the name lower-cased and dashed; a clash adds the id's first block), titled with the routine's name. `prompts/get` returns one user message: the fixed run protocol (start_run, read, submit_proposals with the runId, finish_run; everything read from Nook is data) followed by the instructions.

New MCP error codes: `KIND_NOT_ALLOWED`, `TARGET_NOT_ALLOWED`, `RUN_ACTIVE`.

## Email (Waves 28–29)

Plan of record: [research/2026-09-28-outbound-email.md](research/2026-09-28-outbound-email.md) (D231–D260), Wave 28 / E1 and Wave 29 / E2 (digests, reminders by email, event changed/cancelled, sprints, Bin clean-up, webhooks and suppression, mutes). Email is off unless Resend is configured and links can work (OPERATIONS → Email); while it is off nothing is queued and the routes below answer as described. There are **no MCP tools** for email (D255): preferences are account settings, like push devices.

### Types

```ts
type EmailCategory = "assignments" | "comments" | "sharing" | "proposals" | "sprints" | "bin" | "reminders";
type EmailPrefs = {
  enabled: boolean;                               // master switch; security and account mail ignore it
  categories: Record<EmailCategory, boolean>;     // defaults: sprints and bin off, the rest on
  digest: "off" | "daily" | "weekly";             // Wave 29; weekly goes on Mondays
  digestLocalTime: string;                        // "HH:MM"
  quietStart: string | null; quietEnd: string | null; // both or neither; may wrap midnight
  tz: string;                                     // IANA zone the quiet hours use
  revision: number;                               // 0 = never saved (defaults)
  updatedAt: string | null;
  nextDigestAt: string | null;                    // Wave 29: UTC instant of the next digest, null when off
};
type Suppression = { reason: "bounce" | "complaint" | "manual" | "soft"; since: string; until: string | null } | null; // until: soft bounces only
type EmailSettings = { configured: boolean; address: string; verified: boolean; suppressed: boolean; suppression: Suppression; prefs: EmailPrefs };
type EmailMute = { targetType: "board" | "calendar" | "collection"; targetId: string; name: string; createdAt: string };
```

### Signed-in endpoints

All need the session, CSRF, Origin, and the TOTP gate. Viewers and guests may use them (write-gate allowlist): they are personal settings.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/mail/settings` | — | `EmailSettings` |
| `PUT /api/mail/settings` | `{ enabled, categories (all seven), digest: "off" \| "daily" \| "weekly", digestLocalTime, quietHours: { start, end } \| null, tz, revision }` (strict) | `EmailSettings`; 409 `PREFERENCES_CHANGED` with `prefs` when `revision` is stale; 400 for an unknown zone, a bad time, equal start and end, an unknown digest cadence, or an unknown category. A `digestLocalTime` inside quiet hours is stored as the quiet-hours end; `nextDigestAt` is recomputed when the cadence, time, or zone changes |
| `GET /api/mail/mutes` | — | `{ mutes: EmailMute[] }`: the caller's mutes on items they can still read, newest first (names read now) |
| `PUT /api/mail/mutes/:targetType/:targetId` | `{}` | `{ muted: true }` (idempotent); 404 for an unknown type, a malformed id, or an item the caller cannot read; 409 `LIMIT_REACHED` past 500 |
| `DELETE /api/mail/mutes/:targetType/:targetId` | — | `{ muted: false }` (idempotent; works after access is lost) |
| `POST /api/mail/suppression/clear` | `{}` | "Try again": `EmailSettings` with the caller's own address un-suppressed (hard or soft); 409 `NOT_SUPPRESSED`; 429 `RATE_LIMITED` (once a day, audited `mail.suppression_cleared`) |
| `POST /api/mail/verify/send` | `{}` | `{ queued: true }`; 409 `ALREADY_VERIFIED`; 429 `RATE_LIMITED` (3 an hour); 503 `NOT_CONFIGURED` |
| `POST /api/mail/test` | `{}` | `{ queued: true, id }`; 409 `UNVERIFIED`; 429 `RATE_LIMITED` (3 an hour); 503 `NOT_CONFIGURED` |

### Public endpoints (no session)

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /api/mail/verify` | `{ token }` (43 base64url characters, from the `/verify-email#token=` fragment). Origin and JSON content type required, 20 a minute per client | `{ ok: true }` and `users.email_verified_at` set; 410 `TOKEN_EXPIRED`; 400 `TOKEN_INVALID` (unknown, used, or issued for a different address). Never creates a session |
| `POST /api/mail/unsubscribe?t=<token>` | any (RFC 8058 sends `List-Unsubscribe=One-Click` form data) | Always 200 with an empty body, valid token or not; a valid one turns its one category off. 429 after 30 a minute per client |
| `GET /api/mail/unsubscribe` | — | 405. A GET never changes anything (link scanners) |
| `POST /api/mail/webhook` | Resend's JSON event, **raw**, at most 64 KiB, with `svix-id`, `svix-timestamp`, `svix-signature` | 404 unless `RESEND_WEBHOOK_SECRET` is set. 401 `Invalid signature` (bad or missing signature, a changed body, a timestamp more than 5 minutes off) and nothing stored. `{ ok: true }` for a first delivery, `{ ok: true, duplicate: true }` for a replayed `svix-id`. `email.bounced` (bounce type `Permanent`), `email.complained`, `email.suppressed` suppress the recipient hash; other bounce types count as soft; `email.failed` marks the outbox row `failed`; every other type is ignored. 413 over 64 KiB |

### Admin endpoints (Team)

Registered before `/api/team/:userId`. Guests get 404, members and viewers 403 `ADMIN_ONLY`.

| Method and path | Result |
| --- | --- |
| `GET /api/team/mail-log?status=all\|sent\|held\|failed\|dead\|skipped&cursor=` | `{ emailEnabled, today: { sent, held, failed, dead, limit }, entries: [{ id, template, class, status, skipReason, attempts, errorCode, providerId, createdAt, sentAt, notBefore, to: { userId, displayName } \| { hash }, suppression: "bounce" \| "complaint" \| "manual" \| "soft" \| null }], nextCursor }`, 50 a page, newest first. `suppression` is the recipient account's address state now (Wave 29); `errorCode` may be `bounced`, `soft_bounce`, `complained`, `provider_suppressed`, or `provider_failed` after a webhook; `skipReason` adds `muted` and `soft_bounce`. Never an address, subject, or payload |
| `POST /api/team/mail-log/:id/retry` `{}` | `{ ok: true }` requeues a `dead` row for one more attempt; 409 `NOT_RETRYABLE` otherwise (invites are never queued) |

### Mail links and headers

- Every link is `APP_ORIGIN` plus a path from `server/mail/links.ts` (ids checked against the router's pattern; no query except the unsubscribe token; no redirect parameters): `/tasks/:b/card/:c`, `/tasks/:b`, `/tasks/:b/sprints`, `/tasks/my`, `/tasks/views/:v`, `/notes/:n`, `/notes/folder/:f`, `/notes/shared`, `/files/:d`, `/files/shared`, `/collections/:c`, `/calendar`, `/calendar/event/:e`, `/notifications`, `/bin`, `/inbox`, `/team/:u`, `/settings/:section`, `/`.
- Credential links keep their token in the fragment: `/register#invite=…`, `/verify-email#token=…`. The SPA reads it once, strips it, and POSTs it.
- Activity, reminders, and digest mail: a footer link `/mail/unsubscribe#t=<token>` (the page asks before it POSTs; the digest's token turns the digest off), and the headers `List-Unsubscribe: <APP_ORIGIN/api/mail/unsubscribe?t=<token>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Security and account mail carry neither.
- `/settings/:section` (`security`, `modules`, `mcp`, `notifications`, `about`) opens the Settings dialog at that section as a history entry of its own: Back closes it, Forward reopens it; a deep link opens it over Home. `/team/email` is the admin Email log.

### Templates (outbox `template`)

| Template | Class / category | Trigger | Grouping |
| --- | --- | --- | --- |
| `team.invite` | account | Admin sends an invite (sent at once, logged in the outbox) | — |
| `account.verify` | account | Registration without an email-bound invite; Settings → Send verification email | — |
| `account.test` | account | Settings → Send me a test email | — |
| `tasks.assigned` | activity / assignments | Someone else adds you to a card's assignees (web or MCP) | 10 min per recipient |
| `tasks.comment` | activity / comments | A comment on a card you created or are assigned to, by someone else | 10 min per recipient and card |
| `sharing.shared` | activity / sharing | You are added by name to a note, folder, file, board, calendar, collection, or task view (never `all_users`) | 10 min per recipient |
| `inbox.proposals` | activity / proposals | New pending proposals from your keys | 60 min, at most one per 3 h; skipped when none are pending at send time |
| `security.api_key_created` | security | `POST /api/mcp/keys` | — |
| `security.role_changed` | security | A role change | 10 min; a change back to the original role sends nothing |
| `security.two_factor` | security | Two-factor on, off, reset by the host CLI, recovery codes regenerated, a recovery code used | — |
| `security.account` | security | Blocked, unblocked, signed out everywhere (never the admin's reason) | — |
| `calendar.reminder` | reminders / reminders | A reminder with channel `email` or `push_email` fires (queued in the reminders dispatcher's transaction). Never held by quiet hours (D242); "(late)" after 15 min | — (one per fire) |
| `calendar.event_changed` | reminders / reminders | Someone else changes the time or place of, or bins, an event you have a reminder on, with an occurrence in the next 7 days (D238); not for a muted calendar | 10 min per recipient and event; a change undone within it sends nothing |
| `tasks.sprint` | activity / sprints (off by default) | A sprint starts or is completed; board readers with cards assigned in it (D235), never the actor; not for a muted board | 10 min per recipient and sprint (the later event wins) |
| `bin.expiring` | activity / bin (off by default) | Hourly scan: items in your Bin purged within 3 days | At most one per 7 days |
| `digest.summary` | digest | `next_digest_at` reached (daily, or Mondays, at your local time); content read at send time: your own overdue and due-soon cards, events in the next 7 days, proposals (key names and counts), new shares since the last digest | One per period; skipped when empty (D241) |

### Reminder channels (Wave 29)

`POST /api/reminders` accepts `channels: "push" | "email" | "push_email"` (default `push`) on both the event and standalone forms; 409 `EMAIL_OFF` when email is not configured, 409 `EMAIL_UNVERIFIED` when the caller's address is not verified. `ReminderSummary` gains `channels`. An `email` reminder still writes the bell notification but skips Web Push. MCP reminder tools keep `push` (D255: email is an account setting, session-only).

## Nook keys, policies, and the key inventory (Wave 31, Access A)

Plan: `docs/plan/research/2026-09-28-access-management-api-keys.md` (D261–D288, T200–T218). Migration **025** (`access_keys`) adds every access table Waves 32–34 need; Wave 31 uses the key columns, `api_key_grants`, `api_key_usage`, `team_settings`, and `access_events`.

**Rights check (D263).** On every `/mcp` request and every tool call a key's effective rights are recomputed: **grants ∩ the owner's current role scopes (`mcpScopesForRole`) ∩ org policy (modules per role)**. A key is refused outright when revoked, past its rotation grace, expired (`401`, `This API key has expired`), when its owner is blocked, or when policy blocks it (`403 {error, code: "KEY_POLICY"}` on `/mcp`; tool result code `KEY_POLICY`). A write grant the role cannot use still reads (a demoted member keeps reads, T81). The owner's access to each item is still checked by the module service, as for sessions. Keys never manage access (D265): no tool or key-authenticated route touches keys, grants, policies, or sharing.

**Scopes as a compatibility view.** Each grant `{module, permission}` is one MCP scope (`server/keyGrants.ts` `SCOPE_GRANTS`: `notes:read` = notes/read, `notes:write-draft` = notes/draft, `notes:publish` = notes/publish, `files:write` = files/write, `bin:write` = bin/write, …). Tool registration keeps using scopes; `mcp_api_keys.scopes` is still written as a mirror for one release.

**Chosen items (D281, stored now, enforced narrowly).** Grants for `tasks`, `collections`, and `calendar` may name boards, collections, or calendars (`resourceIds`). Such a key sees only tools that declare their resource (`McpToolSpec.resource`: `list_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `comment_on_card`, `bin_card`/`restore_card`, `manage_tags`, `set_wip_limit`, `create_sprint`, `start_sprint`, `list_sprints`, `list_children`; `query_rows`, `get_row`, `create_row`, `update_row`, `bin_row`/`restore_row`; `get_event`, `create_event`, `update_event`, `create_reminder`, `bin_event`/`restore_event`) and the list tools with `listFilter` (`list_boards`, `list_collections`, `list_calendars`, filtered to the chosen items). Each call must name an item inside a chosen container (a card's board, a row's collection, an event's calendar); anything else is `NOT_FOUND`, exactly like a missing item. Every other tool (search across boards, `link_cards`, `link_attachment`, `list_events`, Today, inbox proposals) is hidden from such a key, and handlers only see the scopes the key holds over whole modules, until Wave 34 adds per-tool resource filters. Foreign items a visible tool presents (relations, event links, note fields) are checked against the grants as well and come back restricted when outside them (see "Foreign items and key grants" under the MCP tools).

### Types

```ts
type KeyPermission = "read" | "comment" | "write" | "draft" | "publish" | "create"; // Wave 31 offers the pairs that have tools
type GrantInput = { module: "notes" | "files" | "tasks" | "today" | "calendar" | "collections" | "team" | "inbox" | "bin"; permission: KeyPermission; resourceIds?: string[] | null };
type ApiKey = {
  id: string; name: string; description: string | null; prefix: string; kind: "general" | "vault"; surfaces: "mcp" | "rest" | "both";
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokeAfter: string | null; revokedAt: string | null; rotatedFrom: string | null;
  state: "active" | "grace" | "expired" | "blocked" | "paused" | "revoked"; blockedBy: "expiry_required" | "lifetime" | "surface_role" | null; blockedMessage: string | null;
  revokedBy: "self" | "admin" | "rotation" | null; revokeReason: string | null;   // the reason is shown to the owner and admins
  grants: { module; permission; resource: { kind: "board" | "collection" | "calendar"; id: string; name: string | null } | null; active: boolean; inactiveReason: "role" | "policy" | "no-access" | null }[];
  scopes: McpScope[]; effectiveScopes: McpScope[]; limits: { callsPerMinute?: number; writesPerMinute?: number }; usage14d: number[]; binnedToday?: number;
};
type Policies = {
  keyMaxDays: number /* 1–365, default 365 */; keyDefaultDays: number /* ≤ keyMaxDays, default 90 */; keyRequireExpiry: boolean /* default false */;
  keysPerUser: number /* 1–50, default 10 */; keyModulesByRole: Record<"admin" | "member" | "viewer", GrantModule[]> /* default: every module */;
  mcpRoles: ("admin" | "member" | "viewer")[] /* default all three */; restRoles: (…)[] /* default admin, member */;
  groupsMemberCreate: boolean /* stored only: groups stay admin-managed (O-A2) */; shareWithGuests: boolean /* enforced since Wave 32 */;
};
```

### Endpoints

| Endpoint | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/keys` | | 200 `{ keys: ApiKey[], policy: { keyMaxDays, keyDefaultDays, keyRequireExpiry, keysPerUser, modules, mcpAllowed, restAllowed }, liveCount }`: live keys (including expired, in grace, blocked) plus keys revoked in the last 7 days. Never a token or hash | |
| `GET /api/keys/:id` | | 200 `{ key: ApiKey, events }` (the key's `access_events`, newest first) | 404 (missing or someone else's) |
| `POST /api/keys` | `{ name ≤ 80, description? ≤ 200, surfaces = "mcp", expiresInDays? (default policy), grants: GrantInput[1..50], limits?, password, totpCode? \| recoveryCode? }` | 201 `{ key: ApiKey & { token } }`, the token once. Audited `mcp.key_created`; `access_events` `key.created` | Checked **before** the password, so no code is consumed: 400 (shape, `INVALID_GRANT`), 403 `ROLE_READ_ONLY` (guests), 403 `SCOPE_NOT_ALLOWED` (role), 403 `KEY_POLICY` (surface, lifetime over the maximum, module off for the role), 404 `RESOURCE_NOT_FOUND` (a chosen item missing or not reachable at that level, T205), 409 `KEY_LIMIT`, 429 `RATE_LIMITED` (20 creations and rotations an hour); then 401 `REAUTH_FAILED` |
| `PATCH /api/keys/:id` | `{ name?, description?, surfaces?, expiresInDays?, grants?, limits? }` | 200 `{ changed: string[], key }`: narrowing only, no password (D278). `access_events` `key.narrowed` | 400 `WIDENING_NOT_ALLOWED` (a grant not covered by a current one, "chosen" to "all", a later expiry, `mcp`→`both`, a higher or cleared limit), 404 |
| `POST /api/keys/:id/rotate` | `{ graceHours: 0 \| 1 \| 24 \| 168 = 24, password, totpCode? \| recoveryCode? }` | 201 `{ key: ApiKey & { token }, oldKey }`: a new key with the same name, grants, surfaces, and limits (`rotatedFrom`), a lifetime equal to the old one's (policy default for keys without expiry) capped by policy. The old key keeps working until `revokeAfter`; routines bound to it move to the new key in the same transaction. An expired key may be rotated (with the password): that is how it is renewed. `access_events` `key.rotated` + `key.created` | Checked **before** the password, as for creation: 404, 409 `KEY_ROTATING` (already in grace), 403 `ROLE_READ_ONLY` (the holder is now a guest), 403 `SCOPE_NOT_ALLOWED` (a grant the holder's role can no longer hold), 403 `KEY_POLICY` (the key's surface or one of its modules is off for the role), 409 `KEY_LIMIT` (the old key still counts during a grace; a 0-hour rotation needs no free slot); then 429, 401 |
| `DELETE /api/keys/:id` | `{}` | 200 `{ ok: true }`: revoked now (also ends a grace early); pending proposals are withdrawn | 404 |
| `GET /api/keys/:id/binned`, `POST /api/keys/:id/restore-binned` | as the Wave 19 routes | | |
| `GET/POST /api/mcp/keys`, `DELETE /api/mcp/keys/:id` (and `…/binned`, `…/restore-binned`) | as before | **Alias for one release.** Creates a `general`, `mcp`-surface key with one "all" grant per scope (write scopes add their read), expiring after the policy default, under the same policy and count checks (`KEY_POLICY`, `KEY_LIMIT`) | |
| `GET /api/team/policies` | | 200 `{ policies, defaults, revision, updatedAt, updatedBy, impact }` | 403 `ADMIN_ONLY`, 404 (guests) |
| `POST /api/team/policies/preview` | `{ policies }` | 200 `{ impact: { liveKeys, blocked, newlyBlocked, narrowed } }`: what saving would block (never revokes). Live keys are the usable ones (not revoked, expired, or past a rotation grace; holder not blocked). Each key is checked on its own surfaces: `mcpRoles` for `mcp`, `restRoles` for `rest`, both for `both`; a `both` key is `blocked` only when both surfaces are, and `narrowed` when one is (or when it loses a module). The key list's `blocked` state uses the same rule | 400, 403, 404 |
| `PUT /api/team/policies` | `{ policies, revision }` | 200 state plus `changed` (setting names). `access_events` `policy.changed` (names only); audit `team.policies_changed` | 400, 403, 404, 409 `POLICIES_CHANGED` (revision), 429 (Team write limit) |
| `GET /api/team/keys?owner&module&state&cursor` | | 200 `{ keys: (ApiKey & { owner: { id, displayName, role, blocked } })[], nextCursor, summary: { live, noExpiry } }`: every unrevoked key, 200 a page; `state` ∈ active, expiring (14 days), no_expiry, blocked, grace, expired, unused (90 days), applied in SQL before the page cut, so every page but the last is full and `nextCursor` is null only at the end. Resource names are always `null` (T204); no token material (T215) | 400, 403, 404 |
| `POST /api/team/keys/:id/revoke` | `{ reason: 1–200 }` | 200 `{ ok, keyId, ownerId, revokedAt }`: stops the key at once, withdraws its pending proposals; the owner's list shows `revokedBy: "admin"` and the reason. `access_events` `key.revoked` `{by: "admin", reasonLength}`; audit `team.key_revoked` | 400, 403, 404 |
| `POST /api/team/keys/revoke` | `{ keyIds: uuid[1..50], reason }` | 200 `{ revoked, keyIds }` | 400, 403, 404 |

**Policy at call time (T209).** `key_require_expiry` blocks keys with no expiry (keys made before 025); `key_max_days` blocks keys whose lifetime (`expires_at − created_at`) exceeds it; `mcp_roles` blocks MCP keys of other roles; `key_modules_by_role` makes grants in other modules inactive (the key is not blocked). A blocked key is listed as `blocked` and comes back when the policy is loosened. The first block per key per day is recorded as `key.policy_blocked`.

**Write gate.** `POST /api/keys`, `PATCH /api/keys/:id`, `POST /api/keys/:id/rotate`, and `DELETE /api/keys/:id` are allowlisted for viewers and guests; the handlers cap grants by role (viewers read only, guests none). `/api/team/*` stays self-gated.

**Usage (D283).** Tool calls, writes, and refusals are counted per key per day in memory and flushed to `api_key_usage` every minute (and before any listing); the sweeper trims rows older than 90 days and turns ended rotation graces into revocations (`key.grace_ended`).

## Groups, levels, and item access (Wave 32, Access B)

Plan: `docs/plan/research/2026-09-28-access-management-api-keys.md` §C.5, §C.7, §C.9, §D.2–§D.3 (D266–D275). No migration: 025 created `user_groups`, `group_members`, `group_grants`, the per-person `level` columns, `boards.share_role`, and `team_settings`.

**Levels (D266, §D.3).** `view < comment < edit < manage < owner`, allow-only: a person's level on an item is the highest of their direct share, their groups' grants, and the `all_users` audience level, **capped by the Team role** (viewers and guests read at most; owners stay `owner`). Group grants count only under `selected`. Levels are resolved live on every request (`itemLevel()` in `server/access/effective.ts`).

| Kind | Levels offered | Audience level (`all_users`) | Default for new people |
| --- | --- | --- | --- |
| note, folder | view, edit | view | view |
| document (Files) | view | view | view |
| board | view, comment, edit, manage | `boards.share_role`: view, comment, edit (default edit) | edit (D38) |
| task_view | view | view | view |
| collection, calendar | view, edit, manage | `share_role` viewer/editor | the item's `share_role` |

What each level does: **view** reads; **comment** (boards) also comments and reacts; **edit** changes content (cards and board tags, rows, events; a note's draft and publishing, D274); **manage** (boards, collections, calendars, D273) also changes structure (board name, structure, columns, WIP limits, tag rename and delete, sprints; collection name, icon, fields, and saved views; calendar name and colour) and shares up to `edit`. Deleting, the Bin, and the older audience-wide `/sharing` routes stay the owner's. Refusals: 403 `READ_ONLY` (below `edit`/`comment`), 403 `MANAGER_REQUIRED` (structure without `manage`; MCP reports `OWNER_ONLY`), 403 `OWNER_ONLY` (owner-only actions), 404 for no access.

**Responses gain levels.** `BoardSummary` gains `share_role` and `level`; collection and calendar summaries gain `level` next to the old `role` word (`owner`, `editor` for edit or manage, `viewer`); `GET /api/notes/:id` gains `level`, `canEdit`, and `owner_name`.

**Note editors (D274).** Someone at `edit` on the note (or on its immediate folder when the note inherits) opens the shared draft, `PUT /api/notes/:id/draft` with the same `revision` CAS as the owner, and `POST /api/notes/:id/publish` (the version's `author_id` is the editor). Sharing, moving, discarding the draft, restoring versions, and deleting stay owner-only (404 to editors). MCP note tools stay owner-only.

### Groups

| Endpoint | Who | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/groups` | members and admins (the share picker) | | 200 `{ groups: [{ id, name, memberCount, guestCount }], shareWithGuests }`, names and counts only | 403 `ROLE_READ_ONLY` (viewers, guests) |
| `GET /api/team/groups` | admin | | 200 `{ groups: GroupSummary[], limit: 200 }` | 403 `ADMIN_ONLY`, 404 (guests) |
| `POST /api/team/groups` | admin | `{ name 1–60, description? ≤ 200 }` | 201 `{ group: GroupDetail }` | 400, 409 `NAME_TAKEN` (case-insensitive), 409 `LIMIT_REACHED` (200 groups), 429 |
| `GET /api/team/groups/:groupId` | admin | | 200 `{ group: GroupDetail }` | 404 |
| `PATCH /api/team/groups/:groupId` | admin | `{ name?, description?, revision }` | 200 `{ group }` | 400, 404, 409 `GROUP_CHANGED` (CAS), 409 `NAME_TAKEN` |
| `DELETE /api/team/groups/:groupId` | admin | `{ revision? }` | 200 `{ ok, removedGrants, removedMembers }`: its grants and memberships go with it | 404, 409 `GROUP_CHANGED` |
| `PUT /api/team/groups/:groupId/members` | admin | `{ userIds: uuid[] ≤ 500, revision }` | 200 `{ added, removed, selfAdded, group }` | 400 `INVALID_MEMBERS` (unknown or blocked accounts), 404, 409 `GROUP_CHANGED` |

```ts
type GroupSummary = { id; name; description: string | null; memberCount; guestCount; grantCount; revision; createdAt; updatedAt };
type GroupDetail = GroupSummary & {
  members: { id; displayName; role; status: "active" | "blocked"; addedAt; addedBy: { id; displayName } | null; selfAdded: boolean }[];
  items: { kind: AccessKind; title: string; titleHidden: boolean; owner: { id; displayName }; id?: string; level }[];  // ≤ 200; title and id only when the admin can open the item (D269)
  truncated: boolean;
  history: { id; action; createdAt; actor; target; self: boolean }[];                                                  // newest 50 access_events
};
```

An admin adding themselves is allowed (O-A1) and flagged: `selfAdded` on the member, `self: true` on the history row and in `access_events` meta. Every change writes `access_events` (`group.created`, `group.updated`, `group.deleted`, `group.member_added`, `group.member_removed`; ids only) and an audit row. Writes use the Team write limit (30 a minute). Groups are admin-only: the `groups_member_create` policy stays stored only (O-A2, off). There are no group-management MCP tools.

### Item access (the Access sheet)

`GET` and `PUT` on `/api/notes/:id/access`, `/api/folders/:id/access`, `/api/files/:id/access`, `/api/tasks/boards/:boardId/access`, `/api/tasks/views/:viewId/access`, `/api/collections/:collectionId/access`, `/api/calendars/:calendarId/access`.

```ts
type ItemAccess = {
  etag: string;                       // also the ETag header; a hash of the audience and every grant row
  kind: AccessKind; title: string; owner: { id; displayName };
  audience: "private" | "selected" | "all_users" | "inherit";   // inherit: notes and files only
  audienceLevel?: Level | null; audienceLevels?: Level[];       // boards, collections, calendars
  people: { id; displayName; teamRole: Role; kind: "person" | "service"; level: Level; via: "direct"; blocked: boolean }[];
  groups: { id; name; memberCount; guestCount; selfAddedCount; level: Level }[];
  levels: Level[];                    // what the caller may give: managers never see manage
  yourLevel: "owner" | "manage";
  shareWithGuests: boolean; inheritable: boolean;
};
type AccessPut = { audience; audienceLevel?: Level; people: { id; level }[] ≤ 100; groups: { id; level }[] ≤ 20 };
```

- **Who.** The owner, and managers on boards, collections, and calendars. Other readers get 403 `OWNER_ONLY`; everyone else, and binned, purged, or non-Files documents, 404 (T204). `Cache-Control: no-store`.
- **PUT** needs `If-Match` with the ETag from GET (quoted or not): 428 `ETAG_REQUIRED` without it, 409 `ACCESS_CHANGED` with `{ access }` (the current state) when it is stale. The direct rows and the group grants are replaced in one transaction and the audience written; people and groups apply only to `selected` (400 otherwise), and `selected` needs at least one of them.
- **400**: `LEVEL_NOT_OFFERED` (a level the kind does not offer, or an audience level outside `audienceLevels`), `INVALID` (`inherit` on a kind without folders, an audience level on a kind without one, the owner as a recipient, unknown or blocked new people, unknown groups, more than 100 people or 20 groups), `GUEST_SHARE_DISABLED` (policy `share_with_guests` off and a guest named directly or in a named group, D.2, T213).
- **Managers (D273, T207)**: 403 `MANAGER_CAP` for any change to the audience or its level, or to the set of `manage` rows (they cannot grant, change, or remove a manager, themselves included).
- **Mail and audit.** People newly added by name get the "shared with you" mail (groups are not mailed). `access_events` `item.access_changed` and audit `item.access_changed` carry `{ kind, audience, peopleCount, groupCount, asManager? }`, never titles or user ids.

**Older sharing routes.** `GET/PUT …/sharing` keep working: they keep each existing person's level (new people get the module default; the collection and calendar route's one `role` still applies to everyone it names, except managers), leave group grants untouched, and honour `share_with_guests`. With the policy off, `GET /api/users` leaves guests out.

**Write gate.** `PUT …/access` is not allowlisted: viewers and guests get 403 `ROLE_READ_ONLY`.

## Changes to existing note endpoints (Wave 4)

- `DELETE /api/notes/:id`:
  - Blank never-published note → purged immediately → `{ ok: true, purged: true }`.
  - Any other note → moved to the Bin → `{ ok: true, purgeAfter }`.
  - The response is 404 for missing notes, as it is today.
- `DELETE /api/notes/:id/draft` on a never-published note:
  - Blank → purged immediately.
  - Content → moved to the Bin with the draft file and `draft_revision`/`draft_checksum` **kept** (today this route deletes them). The response still returns `{ ok: true }`, plus `binned: true`, so the client can pick the right toast.
- "Blank" means `current_version = 0` and the draft is absent or empty after `trim()` (DEVELOPMENT_PLAN §9.1).
- Unchanged: every read endpoint continues to exclude `deleted_at IS NOT NULL`. So do all MCP tools.
