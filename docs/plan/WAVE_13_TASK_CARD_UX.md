# Nook plan: Wave 13 (task cards, board views, custom dropdowns, and Modules)

This plan extends [DEVELOPMENT_PLAN.md](../../DEVELOPMENT_PLAN.md) and follows its rules. It also follows the conventions in [WAVES_7-9.md](WAVES_7-9.md) §7 and [WAVES_10-12.md](WAVES_10-12.md) §8: `documents.purpose`, no hidden folders, attachments go to the Bin, contracts are updated in the same commit, D69 history parity, and D70 MCP coverage.

It implements the operator requests of 2026-09-26 (`TODO.md` → "Wave 13") and two rules in DEVELOPMENT_PLAN §3:

- **D91**, the custom dropdown rule
- **D92**, the Modules toggle rule

Plan-level facts:

- **Baseline.** v0.7.x. Migrations 001–014 are released and never edited (the list is in `server/migrations/index.ts:16`).
- **Migration ids.** This plan uses **`015_task_card_ux`** and **`016_user_preferences`**. Card hierarchy (parent/child, sprints) is a separate later wave with migration **019**. The Team plan takes its own ids. If merge order forces a renumber, only the file name, the `id`, and the `tests/migrations.test.ts` assertion change.
- **Numbering.** This plan's decisions are **D100–D115**, clear of D91 and D92 and of the Team and hierarchy plans. Threat rows continue after T76 (WAVES_10-12 §5), starting at **T90**.
- **Length.** The plan is longer than the brief's 600 lines because the operator added tags, flags, views, and filters (scope 7–10) after the brief.

## 0. Goals and non-goals

**Goals.** The operator's intent for each item, in order:

1. **Full-screen card composer.** *Add card* opens it full screen at ≤760 px and as a large modal on desktop. It covers title, column, description, due date and time, assignees, tags, flags, relations, and attachments, and creates the card in **one request**.
2. **Optional due time** next to the due date.
3. **Multiple assignees**, chosen in a custom type-to-search dropdown with chips.
4. **Expand to a full page.** The card dialog gets an **Expand** control that opens the card as a **full page** with its own URL and history entry.
5. **Typed card relations**, which are not structural: related to, depends on, needed by, duplicates, and duplicated by. A relation can link cards on different boards.
6. **Custom dropdowns.** The **Calendar calendars picker** becomes a custom dropdown. Under D91 this covers **all 15 native `<select>` elements**, built on one shared component in `src/ui/`.
7. **WIP limit per column**, enforced by the server.
8. **Tags and flags.** Tags are board-scoped, free-form, and coloured. Flags come from a small fixed set.
9. **A richer card face.** Each card in a lane shows its title, a two-line description excerpt, assignees, due date and time, tags, and flags, and stays compact at 390 px.
10. **Four board views** (columns, table, grouped list, and calendar), plus a **Linear-style filter bar**. The view, grouping, sort, calendar month, and filters all live in the URL. The calendar view places cards by due date and time on a month grid or agenda, lets you drag a card to another day to change its due date, and holds cards without a due date in an "Unscheduled" tray.
11. **Settings → Modules** (D92): per-user on/off switches, stored on the server.

**Non-goals**

- **Hierarchy and sprints.** Parent/child cards and sprints belong to the later hierarchy wave (migration 019). §4.6 and §4.7 leave room for its `parent` and `sprint` dimensions.
- **Other card features.** Notifications to assignees, activity history, realtime updates, recurring cards, cross-board moves, soft WIP limits, and saved views are out of scope.
- **Search.** There is no full-text search of cards. The relation picker uses a bounded title match (D106).
- **Security.** Modules do not provide access control. A hidden module is **not** a security boundary (D92, T97).
- **Open question, not planned.** The operator wrote "/collections page has list of collection" without a request. It is recorded as §11 Q1 for clarification.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D100 | **Due time is stored as `due_time TEXT 'HH:MM'` + `due_tz TEXT` (IANA).** `due_on` stays the civil date in `due_tz`. The two columns are both NULL or both set, and a time requires a date. | This is the timed-event convention (D63: `events.start_local` + `tz`, `server/migrations/013_calendar.ts:39-49`), which is correct across DST. Every `due_on` consumer keeps working unchanged: Today, the calendar overlay, `idx_cards_due`, MCP `due_on`, and `dueStatus`. |
| D101 | **The client sends `dueTz`** as `Intl.DateTimeFormat().resolvedOptions().timeZone` when it sets a time. The server checks it with `isValidTimeZone` (`server/calendar/recurrence.ts:118`), stores it as sent, and never converts it. The instant is derived with `zonedToUtc` (`recurrence.ts:144`), which moves DST-gap times forward. | This follows the events rule: the server stores what the client sends. |
| D102 | **Assignees move to a `card_assignees` join table**, capped at 20 per card. Each assignee must be able to read the board (`requireAssignableUser`, `server/tasks/service.ts:385`). Migration 015 copies `cards.assignee_id` into the join table. `cards.assignee_id` is kept as a **legacy mirror** of the first assignee, used only for a rollback to v0.7.x. | Nothing is lost, and old code still shows one assignee after a rollback. The column cannot simply be dropped: `DROP COLUMN` refuses a column with a foreign key. |
| D103 | **Backwards compatibility.** `PATCH /cards/:k` still accepts `assigneeId`, mapped to `[id]` or `[]`. Responses keep `assignee_id` and `assignee_name` (the first assignee) for one release, alongside `assignees[]`. Sending `assigneeId` together with `assigneeIds` returns 400. | The Wave 10 client, MCP `assignee_name`, and the existing tests keep working. |
| D104 | **Relations are not structural.** Three kinds are stored: `relates` (symmetric, stored with `source < target`), `blocks` (source is needed before target), and `duplicates`. The API shows five types from the viewed card's side: `relates_to`, `depends_on`, `needed_by`, `duplicates`, and `duplicated_by`. There is **one relation per unordered pair**. The model has **no parent or sprint kind**; the hierarchy wave adds `cards.parent_card_id` (migration 019) instead of reusing relations. | Relations stay small and clear, with no cycle rules. Hierarchy needs different constraints (one parent, ordering, rollups). |
| D105 | **Reading relations across boards.** Creating a relation requires read access to both cards. On read, each relation resolves per viewer, like event links (`server/calendar/links.ts:95`): <br>• a card the viewer can read shows `{card:{…}}` <br>• a card the viewer cannot read shows `{restricted:true}`, with no id, title, or board <br>• a readable card that is binned is **hidden** until it is restored <br>• an unreadable card reads as restricted whether or not it is binned, so binning is never disclosed <br>A purge cascades. | Links never grant access (T90). |
| D106 | **Card search** for pickers: `GET /api/tasks/cards/search?q=`. It is a case-insensitive `instr` match on titles (no LIKE wildcards) over live cards on readable boards, returning at most 20, and is rate-limited like `/api/search`. | The data is small (at most 50 boards × 1000 cards per owner), the readable predicate is applied before `LIMIT`, and it needs no FTS. |
| D107 | **Field or edge.** Fields change `revision` and use the `PATCH` compare-and-swap: title, description, due date and time, assignees, tags, flags. Edges have their own endpoints and never change either card's `revision`: relations, comments, attachments. | A link made from another board must not raise a false `CARD_CHANGED` for someone editing the card. |
| D108 | **WIP limit.** `board_columns.wip_limit` is NULL or 1–1000, and only the **owner** sets it (columns are the owner's workflow under D38). It is a **hard block**: creating a card in a column, or moving one in from another column, returns 409 `COLUMN_FULL` at or over the limit. Moving within a column, moving out, and Bin restore are always allowed; a restore never fails because of a limit. A limit may be set below the current count. | It is one check under the existing `board:<id>` lock. A soft mode would need a second column plus its own UI and tests. |
| D109 | **Tags** are board-scoped (`board_tags`, at most 100 per board, unique case-insensitive names of 1–40 characters) and use the `OPTION_COLORS` palette (`server/collections/schema.ts:17`). A card has at most 10. **Any reader can create a tag** while tagging a card. **Only the owner** renames, recolours, or deletes one; deleting unlinks it from every card, with no Bin. | Labels are created in passing, as in Linear. Changing a shared vocabulary stays with the owner, consistent with columns (D38). |
| D110 | **Flags** are a fixed set: `urgent`, `blocked`, `needs_review`, `on_hold` (*superseded in part by [TASK_PRIORITY.md](TASK_PRIORITY.md) D1310–D1313: Urgent became a card priority, migration 123; the flags are now `blocked`, `needs_review`, `on_hold`*). They are stored in a `card_flags` leaf table whose CHECK lists the set. `blocked` is a manual flag, separate from the computed `open_blockers` of `depends_on` relations. | The set is small and filterable. A leaf table can be rebuilt cheaply to extend the set, unlike `cards`. |
| D111 | **Description excerpt.** `cards.description_excerpt` holds plain text of at most 160 characters, derived with `searchText` (as MCP's `preview` does, `server/tasks/mcpTools.ts:57`). The service writes it on every description write. `reconcileCardExcerpts()` fills in existing cards at boot, and migration 015 only adds the column (the D34 pattern). | The board payload never reads descriptions of up to 64 KiB. |
| D112 | **Board presentation state lives in the URL query.** The card path stays the same, and the query carries `view`, `group`, `sort`, and the filters: `/tasks/:b?view=table&sort=due&assignee=me&tag=<id>`. The card routes carry the query forward (`/tasks/:b/card/:k?…`), so closing a card returns to the same view. Changing the view **pushes** a history entry; editing filters or sort **replaces** the current one (text input is debounced by 300 ms). | Paths identify resources and the query holds parameters. Collections' `/view/:v` names saved server objects; board views are not saved. Back steps through views and cards, not through every chip. |
| D115 | **Board calendar view** (`view=calendar`) shows **due dates of this board's cards**, not the linked Calendar events (`server/calendar/links.ts`). Those stay in Calendar, and the copy says so. The view reuses the Calendar module's grid through a small refactor into presentational components in `src/ui/calendarGrid/` (§4.5a). Dragging a card to a day sends `PATCH {dueOn, revision}`: the date shifts by the day delta and the wall time and zone are kept. Dropping it on Unscheduled sends `dueOn: null`. Filters apply. Paging through months **replaces** the history entry, as Calendar does (`src/calendar/CalendarApp.tsx:442`). | One grid implementation. `MonthView` and `AgendaView` fetch their own occurrences today, so they cannot take cards without the refactor. Keeping the wall time avoids moving a card across zones by accident. |
| D113 | **Client-side filtering, grouping, and sorting.** `GET /boards/:b` already returns every live card (at most 1000). **Switch to server-side filtering** if the card cap rises above 2000 or the board JSON exceeds 1 MB at p95; measure this in 13C. MCP `list_cards` filters on the server with bound SQL. A parity test checks both paths give the same answer. | One round trip, instant chip edits, and no new query endpoint for a bounded data set. |
| D114 | **Shared components.** <br>• **Dropdowns (D91):** `Select` and `Combobox` in `src/ui/`, built in-house with no new dependency. At ≤760 px the popup is a bottom sheet guarded by the history dialog guard. <br>• **Modules (D92):** a `user_preferences.disabled_modules` JSON array (migration 016), so modules are on by default and new ones start on. It is read through `GET /api/auth/me` and written with a revision compare-and-swap. The server, MCP, and data are unaffected. <br>• **MCP (D70):** create and update only, audited, in the `task_write` bucket (`server/mcpRateLimit.ts:23`). | One accessible widget set; preferences that follow the account; one agent surface. |

**D113 note: board payload measured in 13C (2026-09-26, Bun 1.4.2, loopback, `tests/tasksBoardPayload.test.ts`).** The plan's worst case: 1000 live cards, each with 3 assignees, 3 tags, 2 flags, a due time (dates spread over three months), and a 160-character excerpt, against the same 1000 cards with no Wave 13 data.

| Fixture | `GET /boards/:b` JSON | gzip (not enabled on the server) | Median response (7 runs) |
| --- | --- | --- | --- |
| Every Wave 13 field, ~45-character display names | **1,392,677 B** | ~50 KB | 36–42 ms |
| Every Wave 13 field, ~8-character display names | **1,249,640 B** | ~47 KB | 34–40 ms |
| No Wave 13 data (the v0.7-like shape) | 612,616–649,653 B | | 8–12 ms |

- **Result: over both thresholds in the worst case.** The JSON exceeds the 1 MB target by 25–39 %, and the response is about 4× the bare board, not within 1.5×. The gzip figure flatters, because the fixture repeats itself; real boards compress less.
- **Where the bytes go, per card** (about 1,250–1,390 B): `assignees` 270–340 (three objects with id and display name), the deprecated `assignee_id` and `assignee_name` 80–117 (D103, kept through v0.8.x), `description_excerpt` 185, `tag_ids` 129, and four UUIDs (`id`, `board_id`, `column_id`, `created_by`) about 200.
- **Where the time goes:** the card select about 4 ms, the grouped assignee, tag, and flag queries 3–7 ms each, and `due_at` about 15 µs per timed card (Intl offset lookups). 13C memoizes `due_at` per distinct date, time, and zone within one board load, which took the same-date fixture from about 50 ms to about 40 ms.
- **Director decision needed** (not changed in 13C, because each option changes a contract that 13B's UI reads). The cheapest cuts are: drop the deprecated `assignee_id`/`assignee_name` early (§11 Q2); send assignees as ids plus one board-level `users` map; drop the per-card `board_id`; and enable gzip for JSON. By the per-card figures above, the first two together bring this fixture to about 1.03–1.07 MB, and dropping `board_id` as well to about 1 MB (estimates, not measured). The D113 fallback, server-side filtering, does not shrink an unfiltered board load. The test pins a 1.5 MB ceiling as a regression guard until this is decided.

## 2. Data model

### 2.1 `server/migrations/015_task_card_ux.ts` (assertion `[1..15]`)

The migration uses `addColumn` from `server/migrations/types.ts`, as `011_task_dates.ts:14-16` does. It is transactional and touches no files.

```sql
-- Due time (D100). ADD COLUMN CHECKs can reference sibling columns; existing rows are NULL.
addColumn(cards, due_tz,   "TEXT CHECK (due_tz IS NULL OR length(due_tz) BETWEEN 1 AND 64)")
addColumn(cards, due_time, "TEXT CHECK ((due_time IS NULL AND due_tz IS NULL)
  OR (due_time IS NOT NULL AND due_tz IS NOT NULL AND due_on IS NOT NULL
      AND due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND due_time <= '23:59'))")
-- Excerpt (D111); filled by the service and by the boot reconcile.
addColumn(cards, description_excerpt, "TEXT NOT NULL DEFAULT '' CHECK (length(description_excerpt) <= 160)")
-- WIP limit (D108).
addColumn(board_columns, wip_limit, "INTEGER CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 1000)")

-- Assignees (D102), with a lossless backfill that includes binned cards.
CREATE TABLE card_assignees (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (card_id, user_id));
CREATE INDEX idx_card_assignees_user ON card_assignees(user_id, card_id);
INSERT INTO card_assignees (card_id, user_id, assigned_by, created_at)
  SELECT id, assignee_id, NULL, updated_at FROM cards WHERE assignee_id IS NOT NULL;
DROP INDEX IF EXISTS idx_cards_assignee;   -- 011; nothing reads assignee_id after 015

-- Relations (D104, D105): non-structural only.
CREATE TABLE card_relations (
  id TEXT PRIMARY KEY,
  source_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  target_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('relates','blocks','duplicates')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL,
  CHECK (source_card_id <> target_card_id),
  CHECK (kind <> 'relates' OR source_card_id < target_card_id));
CREATE UNIQUE INDEX idx_card_relations_pair ON card_relations(min(source_card_id, target_card_id), max(source_card_id, target_card_id));
CREATE INDEX idx_card_relations_source ON card_relations(source_card_id);
CREATE INDEX idx_card_relations_target ON card_relations(target_card_id);

-- Tags (D109) and flags (D110).
CREATE TABLE board_tags (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color TEXT NOT NULL DEFAULT 'gray' CHECK (color IN ('gray','red','orange','yellow','green','teal','blue','purple','pink')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX idx_board_tags_name ON board_tags(board_id, name COLLATE NOCASE);
CREATE TABLE card_tags (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES board_tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (card_id, tag_id));
CREATE INDEX idx_card_tags_tag ON card_tags(tag_id, card_id);
CREATE TABLE card_flags (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  flag TEXT NOT NULL CHECK (flag IN ('urgent','blocked','needs_review','on_hold')),
  created_at TEXT NOT NULL, PRIMARY KEY (card_id, flag));
CREATE INDEX idx_card_flags_flag ON card_flags(flag, card_id);
```

**Constraints the schema cannot express.** SQLite cannot enforce these in a CHECK, so the service enforces them and tests cover them:

- A tag on a card must belong to the card's own board. This is the T39 pattern for ids in a request body.
- A card has at most 10 tags.
- A card has at most 20 assignees.

**Checks and fallbacks.**

- **Migration test.** `tests/migrations.test.ts` upgrades a database shaped like 014. It covers:
  - cards that are assigned, unassigned, or binned, and an assignee who was later disabled
  - exactly one `card_assignees` row for each non-NULL `assignee_id`, with `assignee_id` left unchanged
  - CHECK refusals: a time without a date, `24:00`, a time without a zone, a self relation, a reversed `relates`, a duplicate pair in either order, an unknown flag, an unknown colour, and a duplicate tag name that differs only in case
  - cascades on card purge, board purge, tag delete, and user delete
- **Verify on Bun's SQLite (3.53).** Two features need a check in 13B commit 1: the multi-argument `min()`/`max()` expression index, and a column CHECK that refers to a sibling column in `ADD COLUMN`. If either fails, fall back to a `pair_key TEXT NOT NULL UNIQUE` column filled by the service, and to a check in the service.

**Rollback.** Take a backup before deploying. The v0.7.x code ignores the new tables and columns. It reads `assignee_id`, which the mirror keeps as the first assignee, so a rollback hides the extra data but loses none. A real rollback means restoring the backup; a migration is never reversed in place.

**Mirror update.** The mirror is updated in the same transaction as every change to assignees:

```sql
UPDATE cards SET assignee_id = (SELECT user_id FROM card_assignees WHERE card_id = ? ORDER BY created_at, user_id LIMIT 1)
```

### 2.2 `server/migrations/016_user_preferences.ts` (assertion `[1..16]`)

```sql
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  disabled_modules TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(disabled_modules) AND json_type(disabled_modules) = 'array' AND length(disabled_modules) <= 512),
  revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
```

There is no backfill: a missing row means every module is on. The table has its own migration so the Modules sub-wave (13F) can merge before or after the task work.

## 3. API contract deltas (`docs/plan/API_CONTRACTS.md` § Tasks, updated in the same commits)

### 3.1 Types

```ts
type Flag = "urgent" | "blocked" | "needs_review" | "on_hold";
type BoardTag = { id: string; board_id: string; name: string; color: OptionColor; card_count: number };
type CardAssignee = { id: string; display_name: string; can_read: 0 | 1 };   // 0 = lost board access ("Former member")
type CardSummary = /* existing */ & {
  description_excerpt: string;     // plain text, ≤ 160 chars (D111)
  due_time: string | null;         // "HH:MM" in due_tz
  due_tz: string | null;
  due_at: string | null;           // computed UTC instant when due_time is set
  assignees: CardAssignee[];       // ≤ 20, in assignment order
  tag_ids: string[];               // ≤ 10; resolve against board.tags
  flags: Flag[];                   // in the fixed order above
  relation_count: number;          // visible to this viewer (restricted rows count, hidden binned ones do not)
  open_blockers: number;           // readable, live depends_on targets not in a done column
  assignee_id: string | null;      // DEPRECATED (D103): assignees[0]
  assignee_name: string | null;    // DEPRECATED
};
type BoardColumn = /* existing */ & { wip_limit: number | null };
type BoardDetail = { board; columns: BoardColumn[]; cards: CardSummary[]; tags: BoardTag[] };  // GET /boards/:b
type RelationType = "relates_to" | "depends_on" | "needed_by" | "duplicates" | "duplicated_by";
type CardRelation =
  | { id: string; type: RelationType; restricted: false; created_at: string; creator_name: string | null;
      card: { id: string; board_id: string; board_name: string; title: string; column_name: string; is_done: 0 | 1; due_on: string | null } }
  | { id: string; type: RelationType; restricted: true; created_at: string };   // nothing else (T90)
```

The board load stays one query per concern. Assignees, tags, flags, relation counts, and blocker counts each come from one grouped query over the board's live cards. None of them adds a per-card subquery to `cardSelect` (`server/tasks/service.ts:98-107`).

### 3.2 Endpoints

| Endpoint | Who | Change | Errors |
| --- | --- | --- | --- |
| `POST /boards/:b/cards` | reader | The body adds `dueTime?`, `dueTz?`, `assigneeIds? (≤20)`, `tagIds? (≤10)`, `flags?`, `relations?: {type, cardId}[] (≤20)`, and `attachmentIds? (≤50)`. Everything is validated and written in **one transaction** under the board lock (`createCard`, `service.ts:340`), using `linkAttachments` (`server/tasks/attachments.ts:47`) and the §3.3 rules. Returns 201 `{card, relations, attachments, renormalized?}`. | 400: `ASSIGNEE_NOT_MEMBER`, a time without a date or zone, a bad zone, an unknown flag. <br>404: the column, a relation target, a tag not on this board, or a file (all look the same). <br>409: `COLUMN_FULL {columnId, wipLimit, cardCount}`, `LIMIT_REACHED`, `STALE_POSITION`. |
| `PATCH /cards/:k` | reader | Adds `dueTime`, `dueTz`, `assigneeIds`, `tagIds`, and `flags`. Each list replaces the whole set, and `[]` clears it. `assigneeId` is still accepted (D103). `dueOn: null` also clears the time. All fields and the `revision` compare-and-swap apply in one transaction (`patchCard`, `service.ts:397`), and `revision` goes up by exactly 1. `CARD_CHANGED` returns the full current card. | 400 as above, plus `assigneeId` together with `assigneeIds`. 404. 409 `CARD_CHANGED`. |
| `GET /boards/:b` | reader | Adds `tags` and the new card fields. | unchanged |
| `GET /boards/:b/readers?q=&limit=` | reader | Adds `q` (1–64 characters, `instr` on `display_name`) and `limit` (1–50, default 20 when `q` is given). Without `q` it behaves as today (at most 200 users, `service.ts:374`). Adds `truncated`. Returns display names only. | 400, 404, 429 (60 per minute per user) |
| `POST /boards/:b/tags {name, color?}` | reader | 201 `{tag}` | 400, 404, 409 `TAG_EXISTS {tag}` (a case-insensitive match), `LIMIT_REACHED` (100) |
| `PATCH /tags/:t {name?, color?}` / `DELETE /tags/:t` | owner | 200 `{tag}` / `{ok, removedFrom}` | 400, 403 `OWNER_ONLY`, 404, 409 `TAG_EXISTS` |
| `GET /cards/:k` | reader | Adds `relations: CardRelation[]` (at most 50, newest first). | 404 |
| `POST /cards/:k/relations {type, cardId}` | reader of both cards | 201 `{relation}`, seen from `k` | 400 (a relation to itself), 404 (either card is missing, binned, or unreadable), 409 `RELATION_EXISTS {relation}` or `LIMIT_REACHED` (50 per card) |
| `DELETE /cards/:k/relations/:r` | reader of `k` | 200. `k` must be one end of `r`. A restricted relation may be removed, because it is metadata on the caller's own card. | 404 |
| `GET /cards/search?q=&boardId?&excludeCardId?&limit?` | any | 200 `{results: {id, board_id, board_name, title, column_name, is_done}[], truncated}`. `q` is 1–100 characters, `limit` 1–20. Order: the current board first, then prefix matches, then `updated_at DESC`. | 400, 429 (20 per 10 s, the limiter in `server/searchRoutes.ts:183`) |
| `PATCH /columns/:c` | owner | Adds `wipLimit: 1..1000 \| null` (`columnPatchSchema`, `server/tasks/routes.ts:37`) | 400, 403, 404 |
| `POST /cards/:k/move` | reader | A move into a full column from another column returns `COLUMN_FULL`. | + `COLUMN_FULL` |
| `POST /api/bin/card/:id/restore` | as now | Ignores `wip_limit`. Keeps tags whose `board_tags` row still exists. | unchanged |

**Validation.** `dueTime` must match `/^([01]\d|2[0-3]):[0-5]\d$/`, and `dueTz` must pass `isValidTimeZone`, which also accepts browser aliases. Id lists are UUIDs and are deduplicated. `flags` must be unique values from the set. Tag names follow the `label()` rules in `routes.ts:28-29`: trimmed, with no control or bidi characters.

**Audit (ids only).**

- `task.card_update` adds counts: `{assigneesAdded, assigneesRemoved, tagsAdded, tagsRemoved, flags}`, and `dueTime: set|cleared`.
- New events: `task.relation_create {boardId, cardId, relationId, kind}`, `task.relation_delete`, `task.tag_create`, `task.tag_update`, `task.tag_delete {boardId, tagId, removedFrom}`, and `task.column_wip`.
- MCP calls add `{via:"mcp", keyId}` to each event.

### 3.3 Relation normalization (pure, in `server/tasks/relations.ts`)

| Type seen from card X toward card Y | Stored `(source, target, kind)` | How Y sees it |
| --- | --- | --- |
| `relates_to` | `(min, max, relates)` | `relates_to` |
| `needed_by` (X blocks Y) | `(X, Y, blocks)` | `depends_on` |
| `depends_on` (Y blocks X) | `(Y, X, blocks)` | `needed_by` |
| `duplicates` | `(X, Y, duplicates)` | `duplicated_by` |
| `duplicated_by` | `(Y, X, duplicates)` | `duplicates` |

- **Locking.** Creating a relation takes only X's board lock. The unique pair index resolves races: the second writer gets `RELATION_EXISTS`.
- **No existence oracle.** Read access to Y is checked with `readableCard` (`server/tasks/access.ts:63`) inside the transaction. A 404 for Y looks exactly like a missing id, and `RELATION_EXISTS` is only evaluated after both cards are known to be readable.

## 4. Frontend design

### 4.1 Shared dropdowns (`src/ui/`, D91 and D114)

**Files:**

- `src/ui/Select.tsx` and `src/ui/Combobox.tsx`
- `src/ui/Listbox.tsx`: the popup, or the bottom sheet on phones
- `src/ui/listNavigation.ts`: a pure reducer for keys, type-ahead, and the active option
- `src/ui/popoverPosition.ts`: pure placement and flipping
- `src/ui/ui.css`
- `src/ui/useHistoryDialogGuard.ts`, moved from `src/tasks/`, which keeps a one-line re-export.

```ts
type Option<V extends string = string> = { value: V; label: string; description?: string; swatch?: string; icon?: ReactNode; disabled?: boolean; group?: string };
type SelectProps<V extends string> = {
  value: V | null; onChange: (value: V) => void; options: Option<V>[];
  label?: string; labelledBy?: string; placeholder?: string; disabled?: boolean;
  variant?: "field" | "compact" | "cell" | "chip";   // chip = filter-bar trigger
  searchable?: boolean | "auto";                      // "auto": a search box above 8 options
  id?: string; autoFocus?: boolean;
};
type ComboboxProps<V extends string> = {
  multiple?: boolean; value: V[]; onChange: (value: V[]) => void;
  options?: Option<V>[];                                                       // sync, filtered on the client
  loadOptions?: (query: string, signal: AbortSignal) => Promise<Option<V>[]>;  // async, 200 ms debounce, aborts the previous request
  selectedOptions?: Option<V>[];                       // labels for chips not in the loaded options
  onCreate?: (label: string) => Promise<Option<V>>;    // "Create tag “x”" row (tags only)
  maxSelected?: number; label: string; placeholder?: string; emptyText?: string; disabled?: boolean;
};
```

**ARIA** (following the APG combobox patterns):

- `Select` is a `button` with `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`, and `aria-activedescendant`.
- `Combobox` is an `input` with `role="combobox"` and `aria-autocomplete="list"`, and sets `aria-multiselectable` when `multiple`.
- Chips are "Remove <name>" buttons.
- A polite live region announces result counts and additions.

**Keyboard:**

- Alt+↓ or ↓ opens the list.
- ↑/↓, Home/End, and PageUp/PageDown move through it; Enter or Space selects.
- `Select` supports type-ahead. `Combobox` filters as you type, and Backspace in an empty input removes the last chip.
- Tab commits the choice and moves on.
- **Escape** closes the popup and calls `preventDefault` and `stopPropagation`. The window-level Escape handler in `CardDialog` (`src/tasks/CardDialog.tsx:131-139`) already skips events with `defaultPrevented`, and `ModalDialog` gets the same check.

**Desktop rendering.** The popup renders inside its owner's subtree, not in a portal, so `trapTabKey` (`src/files/Dialog.tsx:7`) and `aria-modal` keep working. It uses `position: fixed` with coordinates from `getBoundingClientRect`, so it escapes overflow clipping in grids.

**Gotcha.** `.task-card-dialog` uses `transform: translate(-50%,-50%)` (`src/tasks/tasks.css:119`), and a transform becomes the containing block for fixed-position children. 13A replaces the transform with grid centering. `popoverPosition` is still tested inside a transformed container.

**Phone rendering (≤760 px).** The popup becomes a bottom sheet:

- 44 px rows, a sticky search field, and safe-area padding
- it registers `useHistoryDialogGuard`, so **Back closes only the sheet** (D69)
- at depth 0 it gets its sentinel from `acquireDialogSentinel` (`src/historyDialogs.ts:277`)

**Labels** are React text nodes (T98).

### 4.2 Migrating the native selects (D91)

| # | File:line | What it selects | Target | Special needs |
| --- | --- | --- | --- | --- |
| 1 | `src/calendar/EventSheet.tsx:34` | **The calendar for a new event** (the operator's "calendars dropdown") | `Select` with a colour swatch and the owner in the description | It sits in a `ModalDialog` sheet. |
| 2 | `src/calendar/EventSheet.tsx:125` | Repeat frequency | `Select` | Uses `autoFocus`, and the labels change dynamically. |
| 3–4 | `src/calendar/CalendarsDialog.tsx:79`, `:102` | Calendar colour | `Select variant="compact"` with swatches | Targets stay 44 px at 390 px. The sheet opens over the Calendars sheet, and the guard stack closes the innermost one first. |
| 5–8 | `src/collections/SortFilterSheet.tsx:46`, `:49`, `:65`, `:68` | Sort field and direction, filter field and operator | `Select`; the field selects get auto search | Up to 10 filters stacked in one sheet. |
| 9–10 | `src/collections/SortFilterSheet.tsx:111`, `:117` | Filter value (checkbox, select) | `Select` with option colours | The `in` operator can move to `Combobox multiple`; this is optional. |
| 11 | `src/collections/cells.tsx:36` | A `select` field in a grid cell or the row panel | `Select variant="cell"` | **Editing inside a cell:** fixed positioning with flipping in a grid that scrolls both ways; Enter opens, Escape returns focus to the cell; the save must not trigger the grid's navigation keys; "—" becomes "Clear"; the panel variant uses 44 px rows. |
| 12 | `src/collections/ImportDialog.tsx:97` | Maps a CSV column to a field | `Select` with "Skip" first | Flips up near the bottom of the dialog. |
| 13–14 | `src/collections/FieldEditor.tsx:55`, `:73` | Field type, option colour | `Select` and `Select variant="compact"` | Keeps the disabled state when only one choice exists. The option colour select gets an `aria-label`. |
| 15 | `src/tasks/CardDialog.tsx:504` | Assignee | `Combobox multiple` (13B) | See §4.3. |

13A adds `tests/noNativeSelect.test.ts`, which fails on any `<select` in `src/**/*.tsx` outside `src/ui/`. It allowlists `CardDialog.tsx` until 13B.

### 4.3 Card fields, composer, and full page (`src/tasks/`)

**`CardFields.tsx`** is new and is used by the composer, the dialog, and the full page. It holds:

- **Column:** a `Select`, in the composer only.
- **Due:** a date input, plus a time input that only appears after "Add time". It shows `17:00`. When the card's zone differs from the viewer's, it adds the zone and the viewer's local time: "17:00 Europe/Berlin (20:30 your time)".
- **Assignees:** an `AssigneePicker` built on `Combobox multiple`, with `loadOptions` calling `readers?q=`. "Former member" chips can only be removed.
- **Tags:** a `TagPicker` built on `Combobox multiple`. Its options are the board's tags, and `onCreate` calls `POST /boards/:b/tags`.
- **Flags:** four toggle chips, each with an icon and `aria-pressed`.

In the dialog each field commits through the existing `saveDetails` compare-and-swap (`CardDialog.tsx:189`). List fields commit when the popup closes, not on every chip. A `CARD_CHANGED` reloads the card, as today.

**`RelationsSection.tsx`** lists relations grouped by type:

- A readable relation links to its card's route.
- A restricted relation shows "Restricted card" and can be removed.
- "Add relation" offers a type `Select` and a card `Combobox` backed by `/cards/search`, which excludes the card itself and cards already linked.
- When the card has open blockers, a chip reads "Blocked by N open cards".

**`CardComposer.tsx`** is a guarded dialog, not a route (D69).

- **Opening.** It opens from "+ Add card" in `BoardColumnView`, which replaces the quick-add at `src/tasks/BoardColumnView.tsx:155-172` (§11 Q4). It also opens from "New card" in the header of every view. The default column is the first one that is not a done column.
- **Layout.** Full screen at ≤760 px, reusing `tasks.css:162-171`. On desktop it is `min(960px, 100vw - 32px)` wide.
- **Fields.** Title (autofocused), `CardFields`, the description in an editable `NoteEditor` (D44), relations staged locally, and attachments. Attachments upload immediately with `?purpose=task_attachment` and are linked by the create request.
- **Actions.** Create (Ctrl/⌘+Enter), Create and open (pushes the card's route), and Create another.
- **Errors** appear inline next to the field they concern: `COLUMN_FULL`, `LIMIT_REACHED`, or a 404 for one relation or tag.
- **Discarding.** A dirty form asks "Discard this card?" on Close, Escape, and Back. After confirming, the client moves uploaded files to the Bin with `DELETE /api/files/:id`. If that endpoint refuses task attachments, 13D adds `POST /api/tasks/attachments/discard {documentIds}`, limited to the caller's own unlinked files. The sweeper in §5.6 is the safety net.

**The card dialog** gets an **Expand** button (`Maximize2`, "Open as page") next to Move and Delete (`CardDialog.tsx:452-454`). It also gets a `layout: "dialog" | "page"` prop. The page layout has no scrim, no `aria-modal`, and no focus trap. Above 1024 px it uses two columns: description and comments on the left, fields, relations, and attachments on the right. At 390 px it is a single column. It has Collapse and Close buttons.

### 4.4 Lane card face (`BoardColumnView.tsx`)

At 390 px a card is at most about 132 px tall. From top to bottom:

1. **Flags**, shown as icons with `aria-label`s: urgent is red, blocked is amber, needs review is blue, on hold is grey.
2. **Title**, clamped to 2 lines.
3. **Excerpt**, clamped to 2 lines in muted 0.8rem text, shown only when `description_excerpt` is non-empty.
4. **Meta row**, one line:
   - the due chip ("Tue 17:00", toned by `dueStatus` from `src/tasks/taskActions.ts:97`)
   - up to 3 tag chips, then "+N"
   - comment, attachment, and relation counts
   - assignee initials on the right: up to 3 overlapping 24 px avatars, then "+N"

Desktop cards use the same layout in a 280 px column.

The card's accessible name reads everything in order, for example: "Fix login, urgent, due Tuesday 17:00, tags Backend, assigned to Asha and Ben".

Column headers show the WIP count `n / limit`, with an over-limit style and a label such as "4 of 3 cards, over the limit". During a drag, a full column refuses the drop and shows a hint. The Move sheet (`MoveCardSheet.tsx`) disables full columns. The column menu gains "Set WIP limit…", for the owner only.

### 4.5 Board views (D112, D113)

| View | Layout | 390 px |
| --- | --- | --- |
| `board` (default, current) | Lanes with drag and drop | One lane at a time, as now |
| `table` | A `<table>` with sortable headers (`aria-sort`): Title, Column, Assignees, Due, Tags, Flags, Created, Updated. Rows are 44 px, and Enter or a tap opens the card. | A horizontally scrollable `role="region"` (`tabindex=0`, labelled) with a sticky Title column. The page itself never scrolls sideways. |
| `list` | Grouped sections (`<h3>` with a count), collapsible. Groups by `column`, `assignee`, `tag`, `flag`, or `due` (Overdue, Today, This week, Later, No date). A card with two assignees or tags appears in each of its groups, marked "also in …". | Full-width rows, 44 px targets |
| `calendar` (D115) | Month grid (default) or agenda (`cal=agenda`), with an **Unscheduled** tray on the right holding cards with no `due_on`. Month cells show compact card chips (flag dot, time, title); "+N more" opens the day. Chips from done columns are muted. | The compact month grid plus the selected day's list below it, as in Calendar. Unscheduled is a "Unscheduled (N)" button that opens a guarded sheet. There is no touch drag: the card's ⋯ menu offers "Set due date…". |

- **Switching views.** Three icon buttons in the board header form a `role="radiogroup"` labelled "View". Each switch **pushes** a history entry.
- **Drag and drop** only works in the `board` view. The other views use ⋯ → Move to….
- **One pipeline for all views.** `src/tasks/boardQuery.ts` is pure: `applyBoardQuery(detail, query) → {cards, groups}`. The same function serves every view and is unit-tested.
- **Registries, ready for hierarchy.** Grouping and filtering run through two registries:
  - `GROUP_DIMENSIONS: Record<string, {label, keysFor(card, board): string[], labelFor(key, board), order(keys)}>`
  - `FILTER_FIELDS: Record<string, {label, operators, optionsFor(board), match(card, values, board), encode, decode}>`

  The hierarchy wave (migration 019) adds `parent` and `sprint` entries to both, and `cards.parent_card_id` appears in `CardSummary`. The router, the filter bar, and the views need no rework.

### 4.5a Board calendar view (D115)

**Refactor, done first in 13E.** `MonthView.tsx` (`src/calendar/MonthView.tsx:8-40`) and `AgendaView.tsx` (`:7-28`) each fetch `listOccurrences` themselves, so they cannot render cards yet. 13E moves the presentational parts into `src/ui/calendarGrid/`. The Calendar views keep their own data loading.

- **`MonthGrid.tsx`:** `{month, today, selectedDay, compact, renderDay(day) → ReactNode, onSelectDay, onShiftMonth, onToday, onDropOnDay?(day, payload)}`. It uses `monthGridDays` (`src/calendarRoute.ts:54`), and `monthHeading` and `dayHeading` (`src/calendar/calendarFormat.ts:72-80`).
- **`AgendaList.tsx`:** `{days: {day, items}[], today, renderItem}`.

`MonthView` and `AgendaView` then become thin data containers over these two components. Their behaviour does not change, and `tests/calendarRoute.test.tsx` plus the Calendar UI tests must pass unchanged.

**Placement (pure, in `src/tasks/boardCalendar.ts`).**

- A card with only a date goes on its `due_on` day.
- A card with a time goes on the **viewer-local** date of `due_at` and shows the viewer-local time. The "(20:30 your time)" label rule from §4.3 applies in the chip's tooltip and accessible name.
- A card without a `due_on` goes into Unscheduled.
- The query pipeline (`applyBoardQuery`) runs **first**, so filters apply to every placement. The `group` parameter does not apply to this view.

**Drag and keyboard.**

- **Desktop drag.** Cards drag with the existing `application/x-mynotes-card` payload onto a day cell or onto the tray.
  - A drop on a day computes `delta = dropDay − displayedDay` and sends `PATCH /cards/:k {dueOn: due_on + delta, revision}`. `due_time` and `due_tz` are unchanged.
  - A drop on the tray sends `{dueOn: null}`, which also clears the time.
  - The chip moves optimistically. On `CARD_CHANGED` it rolls back, the board reloads, and the toast reads "Someone else changed this card. It was reloaded."
- **Keyboard.** A focused chip moves with Alt+←/→ (one day) and Alt+↑/↓ (one week), mirroring the board's Alt+Arrow. The move is announced politely: "Due Thursday 3 October".
- **Everywhere.** The ⋯ menu offers "Set due date…", which opens a guarded date dialog.
- **WIP.** Changing a due date is not a column move, so WIP limits do not apply.

**Copy.** The header subtitle reads: "Due dates of cards on this board. Events linked to cards are in Calendar." An empty month names it: "No cards are due in October 2026." (only the month's own days count; the grid's days of the months either side may still show dots). Without the Calendar module the subtitle drops its second sentence. Unscheduled has the heading "Unscheduled" and the help line "Cards without a due date. Drag one onto a day to schedule it."

**Relation to the Calendar module.**

- Calendar's cross-board "Tasks due" overlay (D67, `server/calendar/tasksOverlay.ts`) is unchanged and read-only.
- The board calendar view is per board, editable, and shows **no** events, including events linked to cards.
- The card dialog still lists linked events where it already does.

### 4.6 Filter bar (Linear-style, D112)

Filters render as a row of removable chips, for example "Assignee is Asha, me ×", "Tag is Backend ×", or "Due before Oct 1 ×". After the chips come a "+ Filter" `Select variant="chip"` and a text box ("Filter cards").

Choosing "+ Filter" is a two-step popup: pick a field (`FILTER_FIELDS`), then its values (a `Combobox multiple`, or a date for due). Values within one field are OR-ed, and different fields are AND-ed, as in Linear. A "Clear" button removes everything.

| Field | Query key | Values |
| --- | --- | --- |
| Assignee | `assignee` | a user uuid, `me`, `none` (repeatable) |
| Tag | `tag` | a tag uuid, `none` |
| Flag | `flag` | the four flag values, `none` |
| Due | `due` | `overdue`, `today`, `week`, `none`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD` |
| Column | `column` | a column uuid |
| Relation | `rel` | `any`, `blocked` (open blockers > 0), `none` |
| Text | `q` | 1–100 characters, matched against the title and excerpt, case- and accent-folded |
| View, group, sort | `view`, `group`, `sort` | `board\|table\|list\|calendar`; a dimension id; `field:asc\|desc` |
| Calendar layout and month | `cal`, `month` | `month\|agenda` (default `month`); `YYYY-MM`, checked with `isRouteMonth` (`src/router.ts:54`). When absent, it defaults to the current month. |

**URL codec** (`src/tasks/boardUrl.ts`, pure). Decoding is strict:

- unknown keys and invalid values are dropped
- ids must be UUIDs
- at most 30 filter values in total

Encoding is canonical: keys in a fixed order and values sorted, so `sameRoute` is stable. Ids of tags or users that no longer exist are kept in the URL but render as "Unknown tag", which the user can remove.

**Router changes** (`src/router.ts`):

- The `Route` type at `:7` gains `query?: BoardQuery` and `full?: boolean`.
- `parseRoute(pathname, search = "")` parses the query only for tasks. `formatRoute` at `:98-102` appends `/full` and the canonical query.
- Every caller must pass `location.search`: `TasksApp.tsx:31` and `:60`, the `popstate` and initial load in `App.tsx`, and the helpers in `tasksRoute.ts`.
- Other apps are unaffected.
- The notes search decision (WAVES_7-9 §7.3, "the query never goes in the URL") stays as it is for notes. The board text filter is shareable at the operator's request (§11 Q11).

**History.** Filter and sort edits call `navigate(route, {replace: true})`; the text box is debounced by 300 ms. View switches and opening a card push a new entry. Back from a card restores the view and filters exactly, because the card's URL carries the query.

### 4.7 History table (D69, checked at 390 px and on desktop)

| From | Action | History effect | Back from there |
| --- | --- | --- | --- |
| Board (any view) | Open card | push `/card/:k?…` (`src/tasks/TasksApp.tsx:82-85`) | the same view and filters |
| Board | Switch view | push `?view=…` | the previous view |
| Board | Edit filter, sort, or text | replace | the entry before the board |
| Card dialog | **Expand** | push `/card/:k/full?…` with the `mynotes.tasks.fromDialog` hint | the dialog |
| Full page | **Collapse** | `history.back()` if the entry has the hint and depth > 0; otherwise replace with `/card/:k` | as for the dialog |
| Full page | **Close** | `history.go(-2)` if the entry has the hint and depth ≥ 2; otherwise replace with the board | as for the board |
| Deep link to `/full` at depth 0 | in-app Back | `tasksBackAction` (`src/tasksRoute.ts`) steps full → dialog → board → list → Home by replacing | never leaves Nook |
| Board | + Add card or New card | composer, **no entry**; on phones a sentinel at depth 0 | "Discard?" first if dirty, then closes |
| Calendar view | Previous or next month, or Today | replace `month=` (as `CalendarApp.tsx:442`) | the entry before the board |
| Calendar view (≤760 px) | Unscheduled (N), or Set due date… | guarded sheet or dialog, **no entry** | closes it |
| Anywhere | Dropdown sheet (≤760 px) or filter popup | no entry | closes the sheet only |
| Composer or dialog | Create and open, or a relation link | push the card; from a sentinel, `takeDialogSentinelEntry` replaces it | the board, or the source card |

At ≤760 px the dialog is already full screen, so the Expand button is hidden there (§11 Q6). The `/full` URL still works on phones.

### 4.8 Modules (D92, D114)

- **Registry.** `src/modules.ts` defines `MODULES: {id, label, icon, routeApp?, launcher?, todaySections[], headerItem?}[]` for `notes`, `files`, `tasks`, `collections`, `calendar`, `search`, `bin`, and `notifications`; the Team plan adds `team`. `TODAY_APPS` (`src/today/todayApps.ts:11`) is derived from it.
- **Settings.** `SettingsDialog` (`src/App.tsx:265`) adds `"modules"` to its section union (`:266`, `:282`) and a nav button to the nav at `:403`. Each row has an icon, a name, one line of help, and a 44 px `role="switch"`. A change saves immediately with its revision; a 409 reloads the preferences.
- **Gating (client only).**
  - The Today launcher and Today sections are filtered, and `GET /api/today` is called with `sections=` so hidden providers never run.
  - `AccountActions` hides Bin and the bell.
  - Turning Search off hides the search box and Ctrl/⌘+K.
  - A disabled route is replaced with `/` and a toast: "Tasks is turned off. Turn it on in Settings → Modules." This covers deep links too.
  - Home and Settings cannot be turned off.
- **UI-only toggles (§11 Q7).** With Bin off, deletes still go to the Bin. With Notifications off, reminders and push still work. MCP ignores preferences entirely.

## 5. Integration points

### 5.1 Today (`server/today/providers.ts:29-57`)

- `taskSelect` adds `due_time` and `due_tz`, and items gain `dueTime`, `dueTz`, and `dueAt`.
- Order: `k.due_on, k.due_time IS NULL, k.due_time`. This is approximate across zones, which is accepted.
- A card with a time is overdue once `now > dueAt`.
- `tasksMine` uses `EXISTS (SELECT 1 FROM card_assignees ca WHERE ca.card_id = k.id AND ca.user_id = $userId)`.
- In the UI, `taskRow` (`src/today/todaySections.ts:32`) shows "Today 17:00".
- `get_today` gains the same fields.
- Tags and flags do not appear in Today. §11 Q9 asks whether urgent cards should float to the top.

### 5.2 Calendar

- **Overlay.** The tasks-due overlay (`server/calendar/tasksOverlay.ts:25-40`) selects `due_time` and `due_tz`, widens its query range by ±1 day, and then keeps rows whose **viewer-local** date falls in `[from, to)`. This way a card with a time lands on the correct day for the viewer.
- **Views.** Agenda and Month show timed cards at the viewer's local time.
- **Links.** Event links to cards (`server/calendar/links.ts:74`) are unchanged.
- **Picker.** The calendar picker migrates in 13A (§4.2, rows 1–4).

### 5.3 Search

`GET /api/tasks/cards/search` belongs to the Tasks module and has no scope in `/api/search`. Notes and collections search are unchanged. The board text filter runs on the client. When Search is hidden (D92), the card and relation pickers keep working, because they are part of Tasks.

### 5.4 Bin (`server/tasks/bin.ts`)

- **Binning a card** keeps its assignees, tags, flags, and relations. The other card's view hides the relation (D105).
- **Restore** brings everything back. It ignores `wip_limit`, and it drops tags that were deleted in the meantime; those went through the tag cascade.
- **Purging** a card or a board cascades every new table (`PRAGMA foreign_keys = ON`, `server/db.ts:13`).
- `BinItem` is unchanged.

### 5.5 MCP (`server/tasks/mcpTools.ts`, D114)

| Tool | Scope | Delta |
| --- | --- | --- |
| `list_cards` | tasks:read | New **server-side filters**: `assigneeIds?` (plus `"me"`), `tags?` (names or ids), `flags?`, `dueBefore?`, `dueAfter?`, `dueNone?`, `text?`, `columnId?`. Cards gain `description_excerpt`, `due_time`, `due_tz`, `assignees: string[]`, `tags: string[]`, `flags`, `relation_count`, and `open_blockers`. The response adds `tags: {id, name, color}[]` and a `wip_limit` on each column. `assignee_name` stays. `listedCard` is at `mcpTools.ts:66-82`. |
| `get_card` | tasks:read | Same card fields, plus `relations: ({type, cardId, title, boardName} \| {type, restricted:true})[]` (`:116-148`) |
| `search_cards` (new) | tasks:read | `{query, boardId?, limit ≤ 20}` → `{results, truncated}` |
| `create_card` | tasks:write | Adds `dueTime?`, `dueTz?`, `assigneeIds?`, `tags?` (existing tags by name or id only; an unknown tag is `INVALID`), and `flags?`, validated by `cardCreateSchema` (`:149-171`) |
| `update_card` (new) | tasks:write | `{cardId, baseRevision, title?, dueOn?, dueTime?, dueTz?, assigneeIds?, tags?, flags?}` → `{card}`, or `CARD_CHANGED` with `currentRevision`. It never changes the description (§11 Q8). |
| `link_cards` (new) | tasks:write | `{cardId, targetCardId, type}` → `{relation}`, or `RELATION_EXISTS` / `NOT_FOUND` |

**Implementation.** The server filters live in `server/tasks/cardQuery.ts`, which binds every parameter and uses the readable predicate. A parity test runs the same fixture through the client's `applyBoardQuery` and through `list_cards` and expects the same card ids.

**Error codes.** `McpErrorCode` (`server/mcpToolKit.ts:14`) and `taskErrorToMcp` (`mcpTools.ts:27-36`) gain `COLUMN_FULL` (with the counts) and `RELATION_EXISTS`. `ASSIGNEE_NOT_MEMBER` maps to `INVALID` with `details`.

**Not exposed.** There are no MCP tools to unlink cards, create or delete tags, change WIP limits, or change preferences.

### 5.6 Sweeper

The hourly sweeper (`server/sweeper.ts`) moves a document to its owner's Bin when all of these hold:

- it is a live `purpose='task_attachment'` document
- no `card_attachments` row links it
- it is more than 24 hours old

Each move is audited as `document.delete {reason:"attachment_unlinked"}`. This also covers the files left over today by "Don't attach" (`CardDialog.tsx:591`).

## 6. Threat model rows (append as "Task cards, views, and Modules (Wave 13)")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T90 | **A relation leaks a card from a board the viewer cannot read** | Each relation resolves per viewer through `readableCard`. Restricted rows carry only `{id, type, restricted, created_at}`: no card id, title, board, or creator. A binned card the viewer can read is hidden, and an unreadable one shows as restricted whether it is binned or not. `open_blockers` counts only readable blockers. Tests cover the share matrix over REST and MCP. | Required |
| T91 | **Creating a relation as an existence oracle or IDOR** | Linking needs read access to both cards. Unknown, binned, and unreadable targets all get the same 404. `RELATION_EXISTS` is checked only after readability. On `DELETE`, `k` must be one end of `r`. | Required |
| T92 | **Enumerating users through the assignee picker** | Only readers of the board are listed, by display name only. `q` is at most 64 characters and `limit` at most 50, with a limit of 60 requests per minute. An `all_users` board exposes the same set as `GET /api/users` (`server/index.ts:452`). Assigning someone never grants access. | Required |
| T93 | **Assignees who lose access** keep their names on the card | They show as `can_read: 0` ("Former member"). Today re-checks `readableBoard` for them, and any reader can remove them. | Accepted |
| T94 | **Time zone confusion or abuse** | The zone is stored with the time. `isValidTimeZone` checks it, and a strict `HH:MM` pattern checks the time. The UI shows the zone when it differs from the viewer's. `zonedToUtc` handles DST gaps and folds. The calendar filters by the viewer's local date. Tests cover UTC+14, UTC−12, and both DST changes. Extends T71. | Required |
| T95 | **Card search as a leak or DoS** | The readable predicate runs before `LIMIT`. `instr` avoids wildcard injection. `q` is at most 100 characters, results at most 20, with 20 requests per 10 s. Only titles are returned. | Required |
| T96 | **Bypassing the WIP limit, or vandalising it** | The limit is enforced on the server under the board lock for REST and MCP. Only the owner can set it, and changes are audited. Restore bypasses the limit on purpose, and this is documented. | Required |
| T97 | **The Modules toggle mistaken for access control** | Toggles only hide UI. Routes, ACLs, MCP, feeds, and push are unchanged. Tests show that a disabled module's API still works and still enforces its ACL. Preferences accept only known ids, at most 512 bytes, with a compare-and-swap. | Required |
| T98 | **XSS or focus escape through dropdown labels** (names of calendars, boards, cards, users, and tags) | Labels render as React text. Popups stay inside the dialog subtree, and Escape is consumed by the popup. | Required |
| T99 | **MCP vandalism through `update_card` or `link_cards`** | Compare-and-swap on the revision, no description edits, no unlink or delete, the `task_write` daily buckets, and audit entries with `{via, keyId}`. Extends T36 and T73. | Required |
| T100 | **Orphaned attachments filling the quota** | The client bins them on discard, and the sweeper bins any unlinked attachment older than 24 hours (§5.6). | Required |
| T101 | **IDOR or vandalism with tags**: tagging a card with another board's tag, or creating tags in bulk | `tagIds` must belong to the card's board, and a foreign id gets 404. Caps: 100 tags per board and 10 per card. Names follow the label rules (no control or bidi characters). Only the owner renames or deletes. Tag creation is audited. | Required |
| T102 | **Filter state in the URL** leaks through history, sharing, or a Referer header, or a crafted URL crashes the view | Only ids and the user's own text go in the URL, and `Referrer-Policy: no-referrer` applies. A shared link still needs board access, because unreadable boards return 404. The codec is strict: UUIDs only, at most 30 values, `q` at most 100 characters, `month` must pass `isRouteMonth`, and unknown keys are dropped. Values are rendered as text. | Required |
| T76 (extended) | **Loops between dialog, page, and view, or leaving the app** | The §4.7 table, the `fromDialog` hint, filter edits and calendar month paging that replace instead of push, guarded sheets, and the 390 px QA rows | Required |

## 7. Test plan rows (append as "Wave 13")

### Unit tests (no server)

**Dropdowns**

- `tests/uiListNavigation.test.ts`: arrow keys, Home/End, and PageUp/PageDown skip disabled options; type-ahead wraps and cycles; the multi reducer handles add, remove, Backspace, and `maxSelected`; `popoverPosition` flips, including inside a transformed container.
- `tests/uiSelect.test.tsx` and `tests/uiCombobox.test.tsx`:
  - the ARIA attributes
  - Escape calls `preventDefault` and leaves the host dialog open
  - async debounce and abort
  - `selectedOptions`
  - `onCreate`
  - a label containing `<img onerror>` renders as text
  - the phone sheet registers the guard
- `tests/noNativeSelect.test.ts`: no native select outside `src/ui/`.

**Tasks**

- `tests/taskRelations.test.ts`: the §3.3 table round-trips, both perspectives are inverses, and `relates` is stored in canonical order.
- `tests/tasksDueTime.test.ts`:
  - `HH:MM` validation
  - `dueAt` in UTC+14 and UTC−12
  - Berlin and New York across both DST changes
  - overdue for cards with and without a time
  - the "your time" label

**Board views and routing**

- `tests/boardQuery.test.ts`:
  - each filter field and operator
  - OR within a field, AND across fields
  - `me` and `none`
  - the due buckets across midnight
  - text matching with case and accent folding
  - each grouping dimension, including a card with several assignees or tags appearing in each group
  - stable sort with tie-breaks
  - a stub registry entry named `parent` plugs in without code changes (hierarchy readiness)
- `tests/boardCalendar.test.ts`:
  - placement of date-only cards, and of timed cards whose viewer-local date differs from `due_on` (UTC+14 card, UTC−12 viewer)
  - the Unscheduled bucket
  - filters applied before placement
  - the drop delta preserves the time and zone
  - a tray drop clears date and time
  - Alt+Arrow targets
- `tests/calendarGrid.test.tsx`:
  - `MonthGrid` and `AgendaList` render the given items
  - `MonthView` and `AgendaView` still render occurrences and the tasks overlay unchanged (regression)
- `tests/boardUrl.test.ts`:
  - the codec round-trips and is canonical
  - invalid values are dropped
  - at most 30 values
  - `q` is capped
  - unknown keys are ignored
- `tests/tasksRoute.test.ts` and `tests/router.test.ts`:
  - `/card/:k/full` and the query round-trip
  - malformed input falls back to the board
  - other apps ignore `search`
  - Back goes full → dialog → board → list → Home, with and without the hint
- `tests/modules.test.ts`:
  - the registry filters the launcher, sections, and header
  - unknown ids are ignored
  - a disabled route redirects

### API tests

Files: `tests/tasksCardUx.test.ts`, `tests/tasksRelations.test.ts`, `tests/tasksTags.test.ts`, `tests/preferences.test.ts`, and `tests/migrations.test.ts`.

**Migrations**

- 015 on a 014 fixture:
  - the backfill is exact and the mirror is kept
  - the CHECK constraints hold
  - the cascades work
  - the boot reconcile fills in `description_excerpt`
- 016:
  - the defaults
  - the CHECK constraints
  - the cascade

**Card creation and editing**

- The composer's single create call:
  - one invalid part (an assignee, a relation, a tag, or a file) rolls back the whole card
  - `COLUMN_FULL`
  - `LIMIT_REACHED`
- Assignees:
  - set, replace, and clear
  - `ASSIGNEE_NOT_MEMBER`
  - the legacy `assigneeId`, and 400 when it is sent together with `assigneeIds`
  - `CARD_CHANGED` carries every field
  - a multi-field patch raises `revision` by exactly 1
  - `readers?q=`: only readers, the cap, and the rate limit
- Due time:
  - set and clear
  - clearing the date also clears the time
  - 400 without a zone, and for a bad zone, `24:00`, or `9:5`
- Tags and flags:
  - create with a case-insensitive `TAG_EXISTS`
  - any reader can create a tag
  - only the owner can rename or delete (`OWNER_ONLY`)
  - deleting a tag unlinks it from every card
  - a tag from another board gets 404, even for a user who can read both boards
  - caps of 10 per card and 100 per board
  - flags accept only the fixed set
  - the excerpt is updated when the description changes

**Relations across the share matrix** (owner, member, stranger, `all_users`, two boards)

- read access to both cards is required, and an unreadable card gets a 404 identical to an unknown id
- `RELATION_EXISTS` in both directions
- restricted rows carry no card fields
- a binned card the viewer can read is hidden and comes back after restore
- revoking access turns the row restricted at once
- purge cascades
- the cap of 50 per card
- deleting `r` through an unrelated `k` gets 404
- the revision stays unchanged

**Search, WIP, and integrations**

- Card search:
  - results are a subset of what the viewer can read (parity with `GET /boards/:b`)
  - `%` and `_` are matched literally
  - 429
- WIP:
  - only the owner can set it
  - creating in, or moving across into, a full column returns 409 with the counts
  - moves within a column, moves out, and restores still succeed
  - parallel create and move stay within the limit
- Today and calendar:
  - `tasksMine` through the join table
  - ordering by time, and overdue for timed cards
  - the overlay puts a card due at 23:30 in UTC+14 on the correct local day for a UTC−12 viewer
- Board payload: 1000 cards with 3 assignees, 3 tags, and a 160-character excerpt each stays under 1 MB and within 1.5× of today's response time (the D113 threshold).
- Preferences:
  - defaults
  - compare-and-swap (`PREFERENCES_CHANGED`)
  - unknown ids get 400
  - `/api/auth/me` includes them
  - a disabled module's API still works

### MCP (`tests/mcpTasks.test.ts`)

- The new tools are hidden from keys without the scope and are re-checked in the handler.
- `list_cards` filters (every field, plus `me`) return the same card ids as `applyBoardQuery` on the same fixture.
- `update_card`:
  - `CARD_CHANGED`
  - refuses a description
  - edits tags, flags, and assignees
- `link_cards` returns `RELATION_EXISTS` or `NOT_FOUND`.
- `create_card` and `move_card` return `COLUMN_FULL`.
- `create_card` with an unknown tag returns `INVALID`.
- Restricted relations carry no data.
- The audit entry records `via:"mcp"`, and the calls count against the `task_write` bucket.

### Browser checks (manual QA at 390×844 and on desktop, with two users)

**Composer**

- Full screen on the phone, with the date, "Add time", and zone label.
- Assignee and tag chips added by touch with type-ahead, including creating a tag.
- Flags, a relation to another board, an attachment, then Create and Create and open.
- Back with a dirty form asks first and never leaves Nook at depth 0, and the uploaded file lands in the Bin.

**Card face**

- Title, 2-line excerpt, due time, tags "+N", and flags without overflowing at 390 px.
- A screen reader reads the card's name as specified.

**Calendar view**

- Due and timed cards sit on the right days, Unscheduled holds the rest, and the header copy says linked events are in Calendar.
- Dragging a card to a day changes its due date and keeps its time. A second user editing the same card causes a rollback and a reload toast.
- Dragging a card to the tray unschedules it.
- Alt+Arrow moves a card by a day or a week.
- Month paging replaces the history entry: Back leaves the board and does not step through months.
- At 390 px: the compact grid with the day list, a guarded Unscheduled sheet that Back closes, and "Set due date…" instead of drag.
- Filters apply in this view.

**Views, filters, and history**

- View switches push history entries: Back returns to the previous view.
- Filter chips replace the entry: the URL updates and Back skips the chip edits.
- Reloading keeps the filters, and a shared URL opens the same view for a member.
- A stranger opening that URL gets "Board not found".
- The table scrolls sideways inside its region only, with a sticky title and sorting by keyboard.
- The list groups by each dimension.

**Dropdown sheets**

- Rows are 44 px and filtering works.
- Back closes only the sheet.
- Every §4.2 row works with the keyboard alone and with touch.
- Nothing causes horizontal scrolling at 390 px.

**Expand and full page (desktop)**

- Expand pushes an entry, and Collapse and Back return to the dialog.
- Close goes to the board, and Back from the board goes to the list.
- Reload on `/full` works.
- A deep link to `/full` on the phone never leaves Nook when going Back, and Forward still works.

**WIP**

- The header shows `n / limit`, drops into a full column are refused, and the Move sheet disables full columns.
- A member sees the limit but cannot set it.

**Relations and Modules**

- A second user without access to the other board sees "Restricted card".
- Turning Tasks off hides it in the launcher and in Today, and redirects `/tasks`. The change syncs to a second browser, and turning it back on restores everything.

## 8. Wave split (each sub-wave ships backend and UI together and can be released on its own)

| Sub-wave | Content | Migration | Files | Parallel | Size |
| --- | --- | --- | --- | --- | --- |
| **13A Dropdowns** | `src/ui/` components; move the guard hook; migrate §4.2 rows 1–14; `noNativeSelect` test | none | `src/ui/*`, `src/calendar/*`, `src/collections/*`, `src/files/Dialog.tsx`, the re-export in `src/tasks/useHistoryDialogGuard.ts` | **Yes**, alongside 13F and the server part of 13B | M, 2 sessions |
| **13B Card fields** | Migration 015 (the **whole** task schema); multiple assignees; due time; WIP limits; API, Today, calendar overlay, and MCP changes (`create_card`, `update_card`, list fields, `COLUMN_FULL`); `CardFields` in the dialog (row 15); WIP UI | 015 | `server/tasks/{service,routes,mcpTools}.ts`, `server/today/providers.ts`, `server/calendar/tasksOverlay.ts`, `server/mcpToolKit.ts`, `src/tasks/{CardDialog,CardFields,BoardColumnView,MoveCardSheet,tasksApi}.tsx`, `src/today/todaySections.ts`, calendar views | Server side runs alongside 13A. The UI commit waits for 13A to merge. | M/L, 2–3 sessions |
| **13C Tags, flags, card face** | Tags API; flags; excerpt with boot reconcile; tag and flag pickers; the new lane card face; `list_cards` filters in MCP and `server/tasks/cardQuery.ts` | none (uses 015) | `server/tasks/{tags,cardQuery}.ts` (new), plus `service.ts`, `routes.ts`, and `mcpTools.ts`; `src/tasks/{TagPicker,CardFace}.tsx`, `BoardColumnView.tsx` | After 13B. Can run alongside 13D; they share only `routes.ts`, `mcpTools.ts`, and `CardFields.tsx`, and the merge agent resolves those. | M, 2 sessions |
| **13D Relations, composer, full page** | Relations API; card search; `link_cards` and `search_cards`; `RelationsSection`; `CardComposer`; discard of attachments plus the sweeper step; the `/full` route and page layout | none | `server/tasks/relations.ts` (new), `server/sweeper.ts`, `src/tasks/{RelationsSection,CardComposer}.tsx`, `CardDialog.tsx`, the `/full` part of `src/router.ts`, `src/tasksRoute.ts` | After 13B, alongside 13C | L, 3 sessions |
| **13E Board views and filter bar** | Router support for the query and URL codec; pure `boardQuery` with its registries; table, list, and **calendar** views (with the `src/ui/calendarGrid/` refactor); filter bar; view switch; history rules | none | `src/router.ts`, `src/tasks/{boardQuery,boardUrl,boardCalendar,BoardTable,BoardList*,BoardCalendar,FilterBar}.tsx`, `src/ui/calendarGrid/*`, `src/calendar/{MonthView,AgendaView}.tsx`, `TasksApp.tsx`, `BoardView.tsx`, `App.tsx` (passes `location.search`) | The router, codec, table, and grid refactor can start after 13A; the grid refactor touches files 13A leaves alone. The tag and flag dimensions land after 13C. Coordinate `src/router.ts` with 13D (the `/full` change is small). | L, 4 sessions |
| **13F Modules** | Migration 016; preferences API and `/api/auth/me`; `src/modules.ts`; Settings → Modules; gating | 016 | `server/preferences.ts` (new), `server/index.ts`, `src/modules.ts`, `src/App.tsx` (Settings and the route gate), `src/today/*`, `src/AppShell.tsx` | **Yes**, from the start | S/M, 1–2 sessions |

**Commits.** Each is small, typechecks and passes tests on its own, and updates the contract, threat, and test docs in the same commit.

- **13A**
  1. `feat: add shared Select and Combobox components`
  2. `refactor: move the history dialog guard hook to src/ui`
  3. `feat: use custom dropdowns in Calendar`
  4. `feat: use custom dropdowns in Collections sheets and editors`
  5. `feat: use a custom dropdown in collection cells`
  6. `test: forbid native selects outside src/ui`
- **13B**
  1. `feat: add task card UX migration 015`
  2. `feat: support multiple card assignees with legacy assigneeId`
  3. `feat: add optional due time with time zone to cards`
  4. `feat: add owner-set WIP limits to columns`
  5. `feat: show due times and assignees in Today and the calendar overlay`
  6. `feat: extend MCP task tools with due time, assignees, and update_card`
  7. `feat: edit due time and assignees in the card dialog`
  8. `feat: show and enforce WIP limits on the board`
- **13C**
  1. `feat: add board tags and card flags API`
  2. `feat: derive card description excerpts`
  3. `feat: filter cards and return tags and flags in MCP task tools`
  4. `feat: pick tags and flags on cards`
  5. `feat: show excerpt, assignees, due time, tags, and flags on lane cards`
- **13D**
  1. `feat: add typed card relations API and card search`
  2. `feat: add link_cards and search_cards MCP tools`
  3. `feat: show and edit card relations`
  4. `feat: create cards with every detail in a full-screen composer`
  5. `feat: bin unlinked task attachments`
  6. `feat: open a card as a full page with history parity`
- **13E**
  1. `feat: carry board view and filters in the Tasks URL query`
  2. `feat: add board query pipeline with group and filter registries`
  3. `feat: add table and grouped list board views`
  4. `feat: add Linear-style board filter bar`
  5. `refactor: extract presentational month grid and agenda list to src/ui`
  6. `feat: add board calendar view with due-date drag and Unscheduled tray`
- **13F**
  1. `feat: add user preferences migration 016 and API`
  2. `feat: turn modules on or off in Settings`
  3. `feat: hide disabled modules from launcher, header, routes, and Today`
- **Docs:** `docs: document Wave 13` (ARCHITECTURE and README).

**Releases.**

| Release | Contents | Backup needed |
| --- | --- | --- |
| v0.8.0 | 13A + 13F | yes: migration 016 |
| v0.8.1 | 13B | yes: migration 015 |
| v0.8.2 | 13C + 13D | no |
| v0.8.3 | 13E | no |

For every sub-wave: one independent review, QA delegated, and a QA instance kept running. Run `/security-review` after 13B, 13D (relations), and 13E (the URL codec). Verify the container once per release.

**Estimate.** About 14–16 worker sessions, and about 5–6 days of wall time with three worktrees running in parallel.

## 9. Out of scope

- **Hierarchy wave (migration 019):** `parent_card_id`, sprints, and the "group by parent" and "group by sprint" dimensions. The registries in §4.5 are ready for them.
- Saved or shared views stored on the server.
- Notifications on assignment.
- Dependency graphs.
- Card full-text search.
- Soft WIP limits and per-assignee WIP limits.
- Tags shared across boards.
- MCP tools for tags, WIP limits, and preferences.
- Syncing Modules settings to push or reminders.

## 10. Risks

- **Popup positioning.** Popups can be mispositioned inside transformed containers (§4.1). The container is un-transformed, and a unit test covers it.
- **Board payload growth.** New fields make the board response larger. Grouped queries and the excerpt column keep it bounded, and the D113 measurement decides when to move filtering to the server.
- **SQLite features.** Expression indexes and sibling CHECK constraints need to be verified in 13B commit 1 (fallbacks in §2.1).
- **Router changes and parallel waves.** The router change in 13E touches every call site of `parseRoute`. Land it as a single commit, and add a unit test that fails when `location.search` is not passed through. Coordinate with the `/full` change in 13D.
- **Merge conflicts in `CardDialog.tsx`.** 13B, 13C, and 13D all edit it. The fields move into `CardFields.tsx` in 13B, which keeps the later diffs small.

## 11. Open decisions (the default applies unless the operator overrides it)

| # | Question | Recommended default |
| --- | --- | --- |
| Q1 | "/collections page has list of collection": an observation or a request? | **Ask the operator.** Nothing is planned. |
| Q2 | When does the `cards.assignee_id` mirror and the deprecated response fields go away? | Keep both through v0.8.x. Remove the fields in the next release after that. Keep the column itself, because dropping it would mean rebuilding the table. |
| Q3 | Should relations include parent/child? | **No.** The hierarchy wave (migration 019) adds `parent_card_id`. |
| Q4 | Keep the inline quick-add on desktop? | **Replace it with the composer everywhere.** Ctrl/⌘+Enter keeps adding cards fast. |
| Q5 | Soft WIP limits? | **Hard only** (D108). |
| Q6 | Show Expand on phones? | **Hide it at ≤760 px**, where the dialog is already full screen. The `/full` links still work. |
| Q7 | What does turning Bin or Notifications off do? | **Hide the UI only.** Deleting still moves items to the Bin, and reminders and push still fire. The help text says so. |
| Q8 | May MCP `update_card` change the description? | **No.** Descriptions have no one-step undo. |
| Q9 | Should urgent-flagged cards sort first in Today? | **No** for Wave 13. Revisit with the hierarchy wave. |
| Q10 | Who can create tags, and who manages them? | **Any reader creates. The owner renames, recolours, and deletes** (D109). |
| Q11 | Should the text filter `q` go in the URL? | **Yes**, because the operator wants shareable filters (T102). Notes search keeps its query out of the URL. |
| Q12 | Should filter edits push or replace history entries? | **Replace.** Switching the view or opening a card pushes. |
| Q13 | Where does the due time zone come from? | **The setter's browser** (D101). A per-board zone is not planned. |
| Q14 | Migration ids if the Team plan merges first? | Keep 015 and 016 unless the director renumbers them in merge order. Hierarchy stays at 019. |
| Q15 | Should the flag set be extended? | **Keep the four flags.** Extending it means rebuilding `card_flags`, which is a cheap leaf table. |
| Q16 | Should the board calendar view also show events linked to its cards? | **No** (D115). It shows due dates only, and linked events stay in Calendar. Revisit if the operator asks for a combined view. |
| Q17 | Should dragging a timed card keep its time or set it to the drop slot? | **Keep the time and zone, and shift only the date.** There are no time slots in the month grid. |

## 12. Director review (2026-09-26)

Accepted as the plan of record with these rulings:

- **All Q2–Q17 defaults are accepted.** Q1 is resolved: the operator wanted the board list's inline edit / share / delete actions on `/collections`, which shipped separately (merge `fdac35c`).
- **Threat rows are T90–T102** (renumbered here; the Team plan holds T77–T88). T76 keeps its extension.
- **Migration ids are fixed:** 015 task schema, 016 user preferences, 017 Team, 018 invites, 019 hierarchy, 020 saved cross-board views. `registeredMigrationIds` may see gaps during development; releases are contiguous.
- **Parallel start now:** 13A (dropdowns), 13F (Modules), and the server half of 13B run in three worktrees at once, alongside Wave 14 (Team). 13B UI, then 13C ∥ 13D, then 13E follow as the plan states. Wave 14 does not touch `src/tasks/**`, `src/calendar/**`, `src/collections/**`; 13F and Wave 14 both touch `src/App.tsx` Settings — keep those edits additive and the merge agent resolves them.
- **Releases:** v0.8.0 = 13A + 13F + collections list actions (+ Wave 14 if ready and reviewed); v0.8.1 = 13B; v0.8.2 = 13C + 13D; v0.8.3 = 13E. Each with an independent review and delegated QA; backups before 015/016/017.
- **The description-orphan fix** ("Don't attach" leaves uploads behind) may ship in 13B's server half if cheap, otherwise stays in 13D as planned.
- **SQLite feature checks** (expression index with multi-arg `min()/max()`, sibling-column CHECK) are the first commit of 13B; use the documented fallbacks if they fail on Bun's SQLite.

- **D113 payload ruling (2026-09-26, after 13C measurement):** the 1000-card worst-case board JSON is 1.25–1.39 MB, above the 1 MB target. Accepted for v0.8.x under the 1.5 MB test ceiling. 13E trims it: assignees as ids plus one board-level `users` map, drop per-card `board_id`, and remove the deprecated `assignee_id`/`assignee_name` fields in the release after v0.8.x (Q2). gzip is not enabled (no compression middleware today); revisit only if the trims are not enough.
  - **Done in v0.9.0 (2026-09-27):** `GET /boards/:b` sends `assignee_ids` per card plus one `users` map `{ id: { display_name, can_read } }`, and no per-card `board_id`, `assignee_id`, or `assignee_name`; `GET /cards/:k`, card write responses, and MCP keep `assignees[]`. The fixture (with the 17A/17B hierarchy and sprint fields) went from 1.52 MB to 1.15 MB (1.11 MB with short names); the test ceiling is now 1.2 MB. Still above the 1 MB target; gzip remains the next lever.

## 13. Card start dates (lane START, 2026-11-13; migration 080)

Operator request: cards get a start date with an optional time, mirroring the due date. Decisions **D720–D724** (renumbered from D710–D714 at integration; D710–D716 are the board short codes lane's, TASK_KEYS.md), migration **080** (`card_start_dates`; 064 and 065 were taken, 079 is left to that lane).

- **D720 — The start mirrors the due date.** `cards.start_on`, `start_time`, `start_tz` have the due columns' shapes and CHECKs (011, 015) and `start_at` is derived like `due_at` (`zonedToUtc`). `startOn`/`startTime`/`startTz` on `POST /boards/:b/cards`, `PATCH /cards/:k`, and MCP `create_card`/`update_card` follow every due-time rule (`resolveStart` runs `resolveDue` over the start columns); the audit's `task.card_update` gains `startOn` and `startTime: "set" | "cleared"`. Every card response, `POST /api/tasks/query`, `list_cards`, `get_card`, and `query_cards` carry the four fields; the board payload sends them only on a card with a start (the D113 trim). In the card dialog and page, **Start** sits before **Due** and is the same picker (`DuePicker kind="start"`); read-only roles see it as text. The composer has no Start field (set it after creating).
- **D721 — The start is on or before the due date** (400 `START_AFTER_DUE`; MCP `INVALID` with that `reason`). With both times set the instants compare, so zones never matter (11:30 New York is after 17:00 Berlin the same day). Otherwise the civil dates compare and a date-only side means its whole day: a start at 23:59 on a date-only due day is fine, a date-only start on a timed due day too. Checked on create and whenever a patch changes either side, against the other side as saved; a start without a due date (or the reverse) never conflicts. The picker refuses a start date after the due date (or a due date before the start) before Apply; same-day times are left to the server.
- **D722 — `start:` filter and `start` sort.** The grammar's `start:` takes `due:`'s windows and dates but `overdue` (`today`, `week`, `next-week`, `none`, `YYYY-MM-DD`, `<…`, `>…`) over the civil `start_on`, in the cross-board compiler and the board's in-memory matcher; the filter bar offers **Start** next to Due. `sort: "start"` (query, views, MCP): earliest first, timed before date-only that day, unstarted last. `idx_cards_start` mirrors `idx_cards_due`. MCP `list_cards` has no start filter (its structured `due*` filters stay due-only).
- **D723 — A range on card faces.** Where the due chip was (lane cards, list, table, cross-board results), a card with a start shows "Nov 12 → Nov 15" (each side as the due chip words it, times in the viewer's zone: "Today 09:00 → Nov 15"), toned by the due date; a start alone shows "Nov 12 →". Done cards show none, as before.
- **D724 — The board calendar spans the range.** A card with a start before its due day also shows on each day from its start through the day before its due day, as a quieter dashed chip, clipped to the grid's six weeks; it still counts, sorts, and moves by its due day, and the agenda lists it on its due day only. A drag or Alt+Arrow moves the whole range (the start shifts by as many days, one PATCH); **Set due date…** changes only the due date. A card with only a start stays Unscheduled.
- **Unchanged:** Today, the email digest, the Calendar "Tasks due" overlay, due lanes and groups, and the subtask list (`list_children`) still read only the due date.
