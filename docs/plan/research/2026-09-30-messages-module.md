# Nook: Messages module (Slack-like channels, DMs, threads, webhooks)

*2026-09-30. Research and plan only; no code has changed. TODO.md named the target file `2026-09-27-messages-module.md` (the date the operator queued it); this doc carries the date the research ran. The operator's requirement list (TODO.md, "Messages module") is the brief, and every item in it gets a decision below.*

**Numbering.** Decisions **D301–D340**, threat rows **T280–T299**, open decisions **M-O1…**. D300 (Wave 35, Google sign-in) and T276 are the highest numbers in the docs today; T277–T279 are left as a gap for late additions to other plans. Migration **`036_messages`** (035 is the latest registered; 031 stays reserved for a parallel wave). The four waves are called **MSG-A … MSG-D** until the director gives them numbers (proposed 36–39).

**Rules this plan follows** (DEVELOPMENT_PLAN.md and the standing rules): mobile first with Back/Forward parity at 390 px (D21, the `historyDialogs` guard); custom Select/Combobox only (D91); a Modules row (D92); MCP tools for every module (D70), under the Nook key model (D261–D288); admins never read content they were not given (D73); a Team role is a ceiling, never a grant (D71); default-deny write gate (D75); 404 for missing or forbidden; append-only migrations; strict CSP (`default-src 'self'; connect-src 'self'; img-src 'self' data:`) and **no outside request from the browser**; no new runtime dependency without a strong case (D20); every wave ships backend and a runnable UI slice together.

---

## 0. Summary

1. **Pick it**, as a team chat that lives next to Notes, Tasks, and the agent tools, not as a Slack replacement for large organisations. Scale target: one instance, ≤ 200 people, ≤ 2,000 channels, ≤ 5 million messages, ≤ 500 concurrent browser connections.
2. **Model: Slack's** (D301). Conversations are `public` and `private` channels, 1:1 `dm`, and unnamed `group_dm` (2–9 others). A group DM or DM converts **in place** into a private channel. Threads are **one level deep** under a root message (Slack, Element MSC3440), with "also send to channel". Zulip's mandatory topics are rejected as too foreign for the audience; Discord's server/role model is rejected as too heavy.
3. **Realtime: one Server-Sent Events stream per tab** (`GET /api/events`), with every write through ordinary JSON `POST`s (D310). SSE keeps the session cookie, CSRF, write gate, role gate, rate limits, and audit on the one HTTP path that already has them. It resumes with `Last-Event-ID` against a 72-hour event log, and needs no proxy upgrade and no change to `connect-src`. WebSocket is rejected for v1 (§3).
4. **Storage:** messages live in SQLite with a global integer `seq` for ordering and keyset pages (D305). Search is **FTS5** (`unicode61 remove_diacritics 2`, like notes) with `in:`, `from:`, `has:`, `before:`/`after:`, and `is:thread` filters (D318).
5. **Access predicate = channel membership** (D302). Public channels are readable and joinable by admins and members (never guests). Private channels and DMs are readable only by their members, and **admins never read them** (D73): the channel directory shows admins nothing about private channels except a count.
6. **Notes tab:** notes are bound to a channel through `channel_notes`. Channel members get the note **editor** level (D274) by default, through one new branch in `readableNotePredicate` (D315).
7. **Mentions:** `@person`, `@channel`, and `#channel` are stored as Markdown links with a title marker (`[@Priya](/team/<uuid> "mention")`), the trick D208 used for whiteboards (D316). They drive the bell, payload-less Web Push, and the email outbox, under per-person preferences, per-channel levels, keywords, and quiet hours (D319–D322).
8. **Reactions** reuse the Wave 20 `reactions` table with target kind `message`. The quick row keeps the curated 12. A **full emoji picker** (Emoji 15.1, about 1,900 base emoji, native font, self-hosted data chunk estimated at about 45 KB gzip) stores **stable `[a-z_]` keys** from a frozen generated registry, so the existing table CHECK holds with no rebuild (D323–D325).
9. **Webhooks:** incoming through a **Nook key** with `messages:post` on a channel (the access plan's model), or a per-channel **webhook URL token** for tools that only speak "Slack webhook". Outgoing webhooks are signed with **Standard Webhooks** (HMAC-SHA256), retried with backoff from a durable outbox, and may answer synchronously with a reply. Payloads use a bounded **`nook.blocks/v1`** component schema that accepts a documented Slack Block Kit subset (D326–D331).
10. **Link unfurl** is a server-side registry of unfurlers (`nook` internal, `opengraph` generic, room for per-site plugins), fetched with SSRF protections, size and time caps, a 24-hour cache, and images re-served same-origin. The browser never contacts the linked site (D332–D334).
11. **MCP:** `messages:read` (list, read, thread, search) and `messages:post` (post, reply). Nothing destructive, and no membership tools (D336).
12. **Four waves** (MSG-A–D, about 12–14 sessions in total): A is channels, messages, threads, the SSE stream, curated reactions, and MCP read/post; B is DMs, mentions, notifications, search, pins, archive, forward, and attachments; C is the Notes tab, the full emoji picker, and unfurl; D is webhooks and blocks.

---

## 1. Operator requirements → decisions

| # | Requirement (TODO.md) | Decision |
|---|---|---|
| R1 | Public/private channels; 1:1 and group DMs without a name, convertible into a channel; permalink + channel id | D301, D303, D304; routes in §10 |
| R2 | Threaded replies; sent time only (no read or delivery receipts) | D306, D309 |
| R3 | Copy/forward any message or thread to another conversation | D312 |
| R4 | Pin messages; archive a channel; add/remove members | D307, D308, D302 |
| R5 | Messages tab + Notes tab per channel (notes bound to the channel) | D315 |
| R6 | @mentions in messages and channel notes; #channel mentions | D316, D317 |
| R7 | Rich Markdown bubbles (bullets, tables, links) for agent output | D313, D314 |
| R8 | Message search across channels (text, sender, channel…) | D318 |
| R9 | Incoming/outgoing webhooks; incoming messages as reusable component JSON (Block-Kit-like) | D326–D331 |
| R10 | Per-person configurable notifications | D319–D322 |
| R11 | Link unfurl, hookable per site | D332–D334 |
| R12 | Quick-reaction row + complete emoji picker with search; reuse the `reactions` registry (`message` kind), counts/names semantics | D323–D325 |
| R13 | UI/UX research of Slack, Discord, Zulip, Mattermost, Element; best UX for Nook (mobile first, history parity) | §2, §11 |

---

## 2. Prior art

| Product | Model | Nook copies | Nook rejects |
|---|---|---|---|
| **Slack** [1][2][3][4][5][6] | Workspace → channels (public/private), DMs, group DMs (convertible to private channels), one-level threads with "also send to channel", canvases as channel tabs [5], Block Kit components [3], app unfurls via `link_shared` + `chat.unfurl` [4], incoming webhooks per channel, Events API with 3 s timeout and 3 retries [6], multi- and single-channel guests [7], 40,000-character truncation [2] | The whole conversation model; thread pane on the right; "Threads" and "Mentions" views; channel tabs (Messages, Notes); Block Kit **subset** as an accepted input shape; unfurl as a registry; guests only in channels they are added to; incoming webhook URLs | Huddles, presence dots, read receipts, Workflow Builder, Slack Connect, per-seat guest billing, app marketplace, interactive modals (v1) |
| **Discord** [8] | Servers → categories → channels; roles with permission overwrites; threads that auto-archive after 1 h–7 days; forum channels (every post a thread) | Reactions as a strong, fast gesture; message hover toolbar; "Jump to present" when scrolled back | Server/role permission matrix (Nook has one ACL: membership); auto-archiving threads; 2,000-character limit; forum channel type (v1) |
| **Zulip** [9] | Channels ("streams") + **mandatory topics** per message; topic-based unread and email-style catch-up | Server-side filtering before events are sent; narrow-by-sender/channel search operators (`sender:`, `channel:`); per-topic muting idea → Nook per-thread follow/unfollow | Mandatory topics for every message: the operator asked for Slack-like; it doubles composer friction on phones |
| **Mattermost** [10][11] | Slack-like, self-hosted; incoming webhooks **Slack-compatible** (`text`, `attachments`); outgoing webhooks with channel and/or **trigger words**, synchronous response posted as a comment; outgoing limited to public channels | Slack-compatible incoming payloads; outgoing trigger words; synchronous JSON response posted as a reply; per-channel webhooks created by channel managers | Outgoing webhooks limited to public channels (Nook allows private with a visible banner, D329); plugin framework |
| **Element / Matrix** [12] | Rooms with E2EE; threads via `m.thread` (MSC3440), one level deep; thread list per room; reactions as relations | One-level threads with a per-room thread list; thread panel kept separate from the main timeline | Federation and E2EE (Nook is one self-hosted server; key management is out of scope); arbitrary-depth reply trees (MSC2836) |

**UX conclusions for Nook.** A three-pane desktop (sidebar · timeline · thread/details) and a three-level stack on phones (conversation list → timeline → thread), each level a real route. The composer is always visible at the bottom; the hover toolbar becomes a long-press action sheet at 390 px. Unread is private (bold channel, mention badge), never a receipt.

---

## 3. Realtime transport inside one Bun process

Today nothing in Nook is realtime: the bell polls every 60 s (`src/notifications/NotificationBell.tsx`), and mail and reminder dispatchers are server ticks.

| | **SSE** (`EventSource`) [13][14][15] | **WebSocket** (Bun native, `hono/bun` upgrade) | Long polling |
|---|---|---|---|
| Direction | Server → client; writes stay plain `POST`s | Both | Server → client |
| Auth | Same session cookie, same `requireAuth` middleware | Cookie on the upgrade only; **Origin must be checked by hand** (cross-site WebSocket hijacking); CSRF token has no place | Same as REST |
| Write path | Unchanged: CSRF, write gate, role gate, rate limits, audit | Needs a second dispatcher that re-implements every gate, or writes stay REST anyway | Unchanged |
| Resume | Built in: `id:` + `Last-Event-ID` on reconnect, `retry:` hint | Hand-written | Cursor per request |
| CSP | `connect-src 'self'` | `'self'` matches same-host `ws/wss` only under CSP3 [16]; older engines need explicit `wss:` | `'self'` |
| Proxies | Plain HTTP; needs `X-Accel-Buffering: no` / proxy buffering off | Needs `Upgrade` passthrough in Caddy/nginx/Tailscale Serve configs | Plain |
| Bun specifics | Default `idleTimeout` is 10 s: call `server.timeout(req, 0)` for the stream (TCP listeners; broken on unix sockets [14]) plus a heartbeat | `idleTimeout` per socket; pub/sub topics built in | None |
| Connection budget | HTTP/1.1 allows 6 per origin **across tabs**; HTTP/2 multiplexes | Not subject to the 6 limit | Same as SSE |

**D310 (recommendation): SSE.** Nook's writes are already a hardened REST pipeline; chat needs only fan-out. Typing indicators and presence, the only features that want client → server streaming, are out of scope (D309).

**Design.**
- `GET /api/events` (generic, so the bell and other modules can move off polling later) uses Hono `streamSSE` [15]. It calls `server.timeout(req, 0)`, writes `retry: 3000`, and sends a comment heartbeat every 25 s. The response carries `Cache-Control: no-store` and `X-Accel-Buffering: no`.
- **Hub:** an in-memory `Map<userId, Set<Stream>>`. After a write commits, the service appends one row to `message_events` (an integer id) and publishes it to the connected members of that channel. The fan-out re-checks nothing per event beyond the membership snapshot, which is refreshed on every membership change (T283).
- **Resume:** the client's `EventSource` sends `Last-Event-ID`; the server replays events with a larger id **for channels the user can read now**, at most 1,000. Past that, or when the id is older than the 72-hour log, it sends one `event: reset`, and the client refetches unread counts and the open timeline.
- **Caps:** 8 streams per user (the oldest is closed with `event: replaced`), 500 per instance (`MESSAGES_MAX_STREAMS`), 503 beyond it. The client then falls back to polling `GET /api/messages/unread` every 30 s.
- **Mobile background:** browsers freeze hidden pages [17]. The client closes the stream on `pagehide` and `freeze`, and reopens it on `visibilitychange: visible`, `resume`, and `pageshow`, with `Last-Event-ID` restored from memory or `sessionStorage`. While closed, Web Push (payload-less, the existing D65 path) is the delivery channel for DMs and mentions. On iOS, Web Push works only for Home Screen web apps [18], which the Settings copy says.
- **Multiple tabs:** each tab holds one stream. OPERATIONS recommends HTTP/2 at the reverse proxy; on HTTP/1.1 more than about five tabs starve other requests. A BroadcastChannel leader tab is M-O9.
- **Event types:** `message.created`, `message.updated`, `message.deleted`, `thread.updated` (reply count and participants), `reaction.changed`, `pin.changed`, `channel.updated`, `member.changed`, `read.updated` (the user's own other devices), `unfurl.ready`, `unread` (counts), `reset`. A payload carries ids plus the render fields the member already may read; per-viewer fields (`reacted`) are recomputed by the client.

---

## 4. Decisions (D301–D340)

| # | Decision | Rationale |
|---|---|---|
| D301 | **Conversation kinds:** `public`, `private`, `dm` (exactly 2 people, unique per pair, no name), `group_dm` (3–10 people, no name, fixed membership). One table, `channels`, with a `kind` column. A 1:1 DM with yourself is allowed ("notes to self", Slack parity). | R1; one predicate, one timeline, one search. |
| D302 | **Membership is the access predicate.** `channel_members(channel_id, user_id, role owner/manager/member)`. Public channels: readable and joinable by admins and members; guests only when added by name. Private channels and DMs: members only. Any member may add people to a private channel unless the channel sets `managers_add_only`; only managers remove others; anyone may leave, except the last owner of a private channel (409 `LAST_OWNER`). Groups (D267) are **not** channel principals: "Add group" is a one-time bulk add of its current members, so membership stays per person and visible. | Mirrors the item ACL rule (one visible list), avoids a `group_grants` rebuild, and keeps D73 simple. |
| D303 | **Conversion:** a `dm` or `group_dm` converts **in place** into a `private` channel (any member; a name is required; history kept; membership becomes editable; the unique-pair index releases the pair). Channels never convert back. Public ↔ private: owners only; private → public shows "Everyone on the team will be able to read the full history." | R1; Slack's group-DM conversion without losing history. |
| D304 | **Identity and permalinks:** every conversation and message has a UUID. Permalink `/messages/c/<channelId>/m/<messageId>`; thread `/messages/c/<channelId>/t/<rootId>`. A permalink to something unreadable renders the same "Not available" as a missing one (404 parity). Channel names are `[a-z0-9-_]`, 1–80 characters, unique among live channels (`#general` style); DMs show the other people's names. | R1; stable links survive renames. |
| D305 | **Storage:** `messages(id, seq INTEGER UNIQUE, channel_id, thread_root_id, author_kind user/webhook/system, author_user_id, webhook_id, via_key_id, body_md ≤ 40,000 chars, blocks_json ≤ 64 KiB, edited_at, deleted_at, …)`. `seq` comes from a single-row counter bumped in the write transaction, so it is strictly increasing across the instance. Timelines page by keyset on `(channel_id, thread_root_id IS NULL, seq)`, 50 per page (at most 100), with `before`, `after`, and `around` (permalinks) cursors. | R7; Slack's 40,000 truncation limit as a hard cap [2]; keyset pages stay O(log n) at millions of rows. |
| D306 | **Threads:** one level. A reply has `thread_root_id`; replies to replies are refused (400). The root keeps `reply_count`, `last_reply_at`, and up to 5 recent participant ids, updated in the reply's transaction. "Also send to channel" writes the reply with `broadcast = 1`, so it also appears in the channel timeline. Repliers, the root author, and people mentioned in a thread **follow** it (`thread_follows`); anyone can follow or unfollow. | R2; Slack and Element [12]. |
| D307 | **Pins:** `message_pins`, at most 100 per channel; any member who can post may pin or unpin (Slack default); pins panel in channel details; pinning a thread reply is allowed. | R4. |
| D308 | **Archive:** managers archive; an archived channel is read-only (no posts, reactions, pins, joins, or webhook deliveries), stays searchable and linkable, and can be unarchived by managers. **Delete** is owner-only and moves the channel to the Bin (30 days, D11, type `channel`); purge deletes messages, reactions (trigger), pins, events, FTS rows, and unfurl links. DMs cannot be archived or deleted, only hidden from one's own sidebar. | R4; mistakes are recoverable; DMs belong to both people. |
| D309 | **Sent time only.** Messages show sent time (and "edited"). **No read receipts, delivery receipts, typing indicators, or presence**, to anyone, including admins. Each member's `last_read_seq` exists only to compute *their own* unread counts and is never returned for another person. | R2 and privacy; nothing to leak. |
| D310 | **Realtime: SSE + REST writes** (§3). | §3. |
| D311 | **Edit and delete:** authors edit their own messages at any time (`edited_at` shown; no edit history is kept or shown). Authors delete their own; channel managers delete anyone's in their channel. Delete wipes `body_md`, `blocks_json`, attachments links, reactions, pins, and unfurls in the same transaction and keeps a tombstone ("This message was deleted") when it has replies, otherwise the row is removed. Webhook and MCP messages can be deleted by the webhook's creator or a manager. No Bin for single messages. | Slack semantics; a wipe is what users expect from "delete". |
| D312 | **Copy and forward:** "Copy text" (Markdown), "Copy link" (permalink). **Forward** a message or a whole thread to up to 10 conversations the forwarder can post in, with an optional comment. A forward is a new message whose `forward_json` holds a **snapshot** (author name, source channel name only if the recipient conversation's members can all read it, time, body, blocks; a thread forwards the root plus up to 100 replies, 256 KiB cap). Attachments travel only when the forwarder uploaded them; otherwise they show "File not shared". | R3; recipients may lack access to the source, so a live embed would either leak or break. |
| D313 | **Markdown rendering without HTML:** the client renders `body_md` with `marked`'s **lexer** (already in the tree through `@tiptap/markdown`; promoted to a direct exact-pinned dependency) into React elements: paragraphs, emphasis, code spans and blocks, lists and task lists, block quotes, tables (horizontal scroll inside the bubble), links, and headings (demoted to bold lines). Raw HTML tokens render as text. No `dangerouslySetInnerHTML`. Links: `http`, `https`, `mailto`, and Nook paths only; external ones open with `noopener noreferrer`; images in Markdown render as links (CSP `img-src 'self' data:`). | R7; a ProseMirror view per bubble is too heavy for 200-row timelines; no new parser. |
| D314 | **Composer:** a small Tiptap editor (StarterKit subset, link, table-free) serialising to Markdown through `@tiptap/markdown`, with `@`, `#`, and `:` suggestion menus built on the existing `@tiptap/suggestion` (the slash-menu pattern in `src/editor/slash.ts`). Enter sends and Shift+Enter breaks on desktop; on touch devices Enter breaks and the Send button sends. A per-conversation draft is kept in `localStorage` (try/catch; lost silently in private mode). Paste of more than 4,000 characters offers "Send as a note" (creates a channel note, D315). | No new dependency; agents post long output. |
| D315 | **Notes tab:** `channel_notes(channel_id, note_id, added_by, position)`. "New note" in the tab creates a normal note owned by its creator (in their default folder) and binds it. Readability gains one branch in `readableNotePredicate`: `OR EXISTS (channel_notes ⨝ live channel ⨝ channel_members)` (plus public channels for non-guests), and the level for that path is `edit` (D274: draft and publish, never share, move, or delete) unless the channel sets `notes_members_edit = 0` (then `view`). Unbinding a note (its owner or a manager) removes the access path. Binned notes vanish from the tab. A guard test, like the `AUDIENCE_ALL_USERS` grep, asserts the branch exists in every note read predicate (search, MCP, Today). | R5; notes stay notes (versions, Bin, search), with the channel as a second audience, like Slack channel canvases [5]. |
| D316 | **Mention syntax:** `[@Display Name](/team/<uuid> "mention")`, `[@channel](/messages/c/<uuid> "mention-channel")`, `[#name](/messages/c/<uuid> "channel")`. The server extracts them from the Markdown AST on write (at most 50 per message), and stores `message_mentions(message_id, user_id, kind user/channel/keyword)`. The label is re-rendered from the id at display time, so renames apply. A `#channel` link to a conversation the reader cannot read renders as "#private-channel" with no name; `@person` for someone outside the channel still renders the name (names are team-visible) and offers "Add to channel?" to the author, not an automatic add. | R6; survives Markdown round trips; degrades to a link elsewhere (the D208 technique). |
| D317 | **`@channel`** notifies every member; it is allowed for anyone in conversations of ≤ 30 members and for managers only above that (per-channel override). There is no `@here` (no presence, D309). Webhooks and MCP keys cannot use `@channel` unless the channel allows `bots_mention_channel` (off by default). In **channel notes**, publishing a version with new mentions notifies those people **if they can read the note**; unreadable mentions show the author "Priya can't open this note". | R6; stops broadcast spam from agents (T290). |
| D318 | **Search:** `message_fts` FTS5 (`unicode61 remove_diacritics 2`, `prefix='2 3'`), rowid = `seq`, built from Markdown projected to plain text plus text from blocks, in the write transaction; edits replace, deletes remove. Operators: `in:#channel`, `in:@person` (DM), `from:@person`, `from:bot`, `has:link`, `has:file`, `has:pin`, `is:thread`, `before:YYYY-MM-DD`, `after:`, `during:`. The ACL join is `channel_members` (plus live public channels for non-guests), applied **inside** the FTS query, never after a LIMIT. Results carry a snippet, channel, author, time, and permalink; `GET /api/search` gains a **Messages** facet (Collections D57 pattern). 20 searches per 10 s per user (the search bucket). | R8; one engine, one ACL shape. |
| D319 | **Notification levels** per person per conversation: `all`, `mentions` (default for channels), `none`; plus **mute** (no badge, no push, still unread). DMs and group DMs default to `all`. Thread follows notify on new replies (default on). Up to 10 **keywords** per person (case-insensitive whole-word match) count as mentions. | R10; Slack's model. |
| D320 | **Bell:** mentions, DM messages, keyword hits, and followed-thread replies go to a new `message_notices` table that the bell reads as a third source (the 032 pattern; `notifications.kind` cannot widen). One notice per (user, conversation or thread) is **coalesced** while unread ("5 new messages from Sam in #ops"). Opening the conversation marks its notices read. Text is built at read time from ids, so a message deleted or a channel left meanwhile shows nothing. | Reuses the bell; no leaks after access loss (T226 pattern). |
| D321 | **Push:** the existing payload-less Web Push (D65) fires for a new notice when the person has no **visible** stream open (a stream counts as visible after a client `visible` ping within 60 s), subject to quiet hours. The service worker fetches `/api/notifications?unread=1`, which now includes message notices, and shows "Sam in #ops" with the text only if the per-person setting "Show message text in notifications" is on (default **off**, M-O6). | Push services never see content; lock screens optional. |
| D322 | **Email:** a `messages` category in `email_prefs.categories` (open JSON; default on) sends `messages.unread` **only for notices still unread 30 minutes later** (outbox `not_before`), coalesced per recipient per hour, re-checked at send (read, left, deleted → `skipped`), never for `@channel` in channels over 30 members, and held until quiet hours end. **Quiet hours** reuse `email_prefs.quiet_start/end/tz` for both push and mail, so there is one "Do not disturb" in Settings → Notifications. A DND toggle ("Pause for 1 h / until tomorrow") writes a `dnd_until`. | R10; reuses the outbox, templates, suppression, and unsubscribe (D231–D260). |
| D323 | **Reactions reuse `reactions`** with `registerReactionTarget({kind: "message"})`: readable = the message is live in a conversation the caller can read; writable = the caller can post there (D338) and it is not archived. Cleanup trigger `reactions_message_cleanup AFTER DELETE ON messages` (in 036). Aggregates are embedded in every message page (the D186 GROUP BY), with the same counts, `reacted`, `names ≤ 10`, and `more` semantics. Limits: 20 distinct emoji per message, and the existing 60 writes per minute per user. Reactions create no notices (D190 parity), except an optional per-person "Reactions to my messages" bell item (default off). | R12; no table change. |
| D324 | **Emoji keys:** a build-time script (`scripts/emoji-registry.ts`, devDependency `emojibase-data`, MIT) generates `shared/emojiRegistry.json`: for each base emoji of Emoji ≤ 15.1, a stable key from its CLDR short name folded to `[a-z_]` (digits spelled out, `keycap_one`; ≤ 24 characters, truncated with a letter-only disambiguator on collision), plus glyph, group, and search keywords. The registry is **append-only** (a test fails if a key disappears or changes glyph). The 12 curated keys stay as they are (aliases for their glyphs). `ReactionTarget` gains `emojiSet: "curated" | "full"`: `card_comment` stays curated, `message` is full. | The existing CHECK (`[a-z_]`, 1–24) holds, so no table rebuild; glyphs can change without data migration (D183 idea). |
| D325 | **Picker:** a lazy chunk (`src/messages/emoji/`) loaded on first open: the registry JSON (about 1,900 entries; estimated at about 45 KB gzip, to be measured in MSG-C; budget ≤ 80 KB) and an in-house picker (search by name and keyword, groups, recent and frequent per user in `user_preferences`, skin-tone preference for the **composer only**; reactions use the base glyph). Rendered with the system emoji font; no sprites, no CDN, no `emoji-picker-element` (its default data source is a CDN and it needs IndexedDB [19]). Emoji newer than 15.1 are left out so older phones do not show boxes (M-O8). | R12; self-hosted, CSP-clean, small. |
| D326 | **Incoming, preferred path: Nook keys.** A `general` key with grant `{module: "messages", permission: "post", resource_kind: "channel", resource_id}` (surface `rest`) calls `POST /api/v1/messages/channels/:id/messages` or the `post_message` tool through `/api/v1/tools/post_message` (D280). The message's author is the **key owner**, badged "via <key name>". Effective right = grant ∩ owner's live membership and ability to post ∩ policy (D263). | The access plan's model: one key system, one inventory. |
| D327 | **Incoming, compatible path: webhook URLs.** A channel manager creates an **incoming webhook** (name, optional avatar initial) and receives `https://<APP_ORIGIN>/hooks/messages/<token>` once (32 random bytes, SHA-256 stored, prefix shown, listed in the central key inventory as a capability token like calendar feeds). It accepts Slack-shaped JSON or `payload=` form bodies (Mattermost compatibility [11]), 64 KiB cap, 60 posts per minute per webhook. Messages appear as author kind `webhook`: the webhook's name with a **BOT** badge and "added by <creator>"; a `username` override may change only the text before the badge. The webhook stops when its creator leaves the channel, is blocked, or loses the ability to post. Off per instance with `MESSAGES_INCOMING_WEBHOOKS=false`. | Grafana, Alertmanager, CI actions, and Uptime monitors only speak "Slack webhook URL"; the badge prevents impersonation (T289). |
| D328 | **Component JSON `nook.blocks/v1`** (zod, `shared/messageBlocks.ts`): at most 50 blocks, 64 KiB. Blocks: `header` (plain ≤ 150), `section` (Markdown ≤ 3,000, `fields` ≤ 10 × ≤ 2,000, optional `accessory` button), `divider`, `context` (≤ 10 Markdown or image-ref elements), `table` (≤ 20 columns × 100 rows, Markdown cells ≤ 500) [3], `code` (`language`, text ≤ 20,000), `list` (≤ 50 Markdown items, ordered or not), `image` (`documentId` of a Nook file the poster owns, or an `https` URL fetched through the unfurl image proxy, D333; `alt` required), `actions` (≤ 5 buttons: `url` buttons, or `action` buttons with `action_id` ≤ 64 and `value` ≤ 2,000 delivered to the originating outgoing webhook as `block_action`). **Slack input mapping:** `section`, `header`, `divider`, `context`, `image`, `table`, `rich_text` (flattened to Markdown), and legacy `attachments` (colour bar, title, text, fields) map in; `mrkdwn` is translated (`*bold*` → `**bold**`, `<url|text>` → `[text](url)`, `<@U…>` dropped to text); anything else is dropped and counted ("2 unsupported blocks"). `text` is required as the fallback shown in notifications, search, and MCP. | R9; renderable safely with React only; Slack payloads keep working. |
| D329 | **Outgoing webhooks:** created by channel managers (members and admins only, never keys, D265) with a destination URL, events (`message.created` for all, or only messages that start with **trigger words** (Mattermost [10]) or mention the webhook by `@name`, `reaction.changed`, `block_action`), and a secret shown once. Allowed in private channels, where every member sees a banner "Messages here are sent to <host>". The destination must be `https` (or `http` only for hosts in `MESSAGES_WEBHOOK_ALLOWED_HOSTS`), must resolve to public addresses **unless** the host or CIDR is listed in that admin allowlist (agents on the same host or tailnet are the main use), no credentials in the URL, ports 443/80/8443 or allowlisted. | R9; agents reply in chat; private-network targets are opt-in by the operator. |
| D330 | **Delivery:** a durable outbox `message_webhook_deliveries` written in the triggering transaction, dispatched by a tick (the mail dispatcher pattern). Signed with **Standard Webhooks** [20]: headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`. Body: `{type, channel {id, name, kind}, message {id, seq, permalink, author, text, blocks?, threadRootId?}, action?}`; a private channel's name is included (the manager chose the destination). Timeout 5 s; redirects not followed; responses read up to 64 KiB. **Retries** at 30 s, 2 min, 10 min, 1 h, and 6 h (6 attempts) on network errors, timeouts, 408, 429 (honouring `Retry-After` ≤ 6 h), and 5xx; other 4xx fail at once; 410 disables the webhook. After 20 consecutive failed deliveries the webhook pauses and its creator gets a bell notice and a security-class mail. Delivery rows are kept 7 days (status and codes only). At most 4 concurrent deliveries per instance, 1 per webhook, in order. | Slack's 3 s / 3 retries is too tight for agents [6]; the backoff covers a restart. |
| D331 | **Synchronous reply:** a 2xx response with `Content-Type: application/json` and `{text, blocks?, response_type: "thread" \| "channel"}` within the 5 s window is posted as the webhook bot (`thread` replies to the triggering message; default). Slower agents post later with a Nook key or an incoming webhook. Replies count toward the webhook's 60 per minute. A bot's own messages never trigger outgoing webhooks (loop guard), and a message may trigger at most 5 webhooks. | Mattermost's `response_type` [10]; no bot loops (T291). |
| D332 | **Unfurl registry:** `server/messages/unfurl/registry.ts` exports `registerUnfurler({id, priority, match(url): boolean, unfurl(url, ctx): Promise<UnfurlCard \| null>})`. Built-ins: **`nook`** (Nook URLs: notes, files, cards, collections rows, events, whiteboards, channels, messages) resolved **per viewer at render time** with that viewer's ACL, never cached across users; **`opengraph`** (generic HTML `<head>`: `og:*`, `twitter:*`, `<title>`, `description`, oEmbed discovery link [21][22] followed only for allowlisted providers). Per-site unfurlers (for example a self-hosted Gitea or a CI server) are later files that register themselves; the registry is code, not configuration. `UnfurlCard = {siteName, title, description, imageId?, url}` with strict length caps. At most 3 unfurls per message; the author (and managers) can remove a preview; `<url>` in angle brackets suppresses it. | R11: hookable; internal links never leak through a shared cache (T288). |
| D333 | **Unfurl fetching (server only):** `http`/`https` only, ports 80/443, no credentials, IDN in punycode; DNS resolved and **every** address checked against private, loopback, link-local, CGNAT, multicast, and metadata ranges (`isPrivateAddress` from `server/calendar/push.ts`), re-resolved right before the request with the push.ts L2 check, and again on each of at most 3 redirects. Timeout 4 s total; reads at most 512 KiB and stops at `</head>`; only `text/html` or `application/xhtml+xml`; `User-Agent: NookUnfurl/1 (+<APP_ORIGIN>)`; no cookies. The image (`og:image`) is fetched with the same rules, ≤ 1 MiB, sniffed as PNG, JPEG, WebP, or GIF (first frame not decoded; served as is), stored under `DATA_DIR/unfurl/<uuid>`, and served at `/api/messages/unfurl-images/<uuid>` with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Cache `link_unfurls` by URL hash: success 24 h, failure 1 h; images garbage-collected with their cache row. Concurrency 4 per instance; 30 new URLs per minute per user. `MESSAGES_UNFURL=off \| allowlist \| public` (default **public**, M-O4) with `MESSAGES_UNFURL_ALLOWED_HOSTS` and `MESSAGES_UNFURL_DENIED_HOSTS`; an optional `MESSAGES_UNFURL_PROXY` sends all unfurl traffic through an egress proxy for strict deployments. | OWASP SSRF guidance [23]; the browser loads only same-origin bytes; a residual DNS-rebinding window is documented (T287). |
| D334 | **Unfurl timing:** the message is saved and fanned out first; unfurls run after commit and arrive as `unfurl.ready`. Unfurls of messages in private channels and DMs are cached like any other URL (the cache holds only public page metadata), but an unfurl is **never** fetched for a URL the author put inside a code span or block. | Posting never waits on the network. |
| D335 | **Attachments via Files:** uploads use the existing upload pipeline into the poster's Files under an auto-created folder "Message uploads" (a `folders.system_kind = 'messages'` marker; it can be renamed but not deleted while non-empty). `message_attachments(message_id, document_id, position)` links at most 10 per message. A member of the conversation can read a linked document through a new `readableDocument*` branch (the card attachment pattern), which ends when the link, the message, or their membership ends. Deleting the document in Files leaves "File removed" in the message. Viewers and guests cannot upload (`files.upload`). | R-implicit; no `documents.purpose` rebuild (its CHECK is fixed since 009); quota honest; uploaders can find and delete their files (M-O7 covers hiding them). |
| D336 | **MCP and REST:** scopes `messages:read` (`list_channels`, `get_channel`, `read_messages`, `read_thread`, `search_messages`, `get_message`) and `messages:post` (`post_message`, `reply_in_thread`). No edit, delete, pin, archive, join, leave, add, remove, create-channel, open-DM, reaction, or webhook tools. Keys act only inside conversations the owner is a member of; `list_channels` returns only those. Tool outputs are bounded (100 messages, 256 KiB), carry `{author, authorKind, via}` so agents can tell humans from bots, and are labelled untrusted content (T35 wording). REST parity through `/api/v1/tools/:name` (D280). Guests get no scopes; viewers `messages:read` (and `messages:post` only if M-O1 is accepted). | R-brief: read/list/post only; nothing destructive; no membership tools. |
| D337 | **Admins and D73:** admins see public channels like members. For private channels and DMs they see only counts (per person on the member access page: "In 4 private conversations"), can **remove a blocked or departing person** from all conversations at once (a reduction, D268), and can delete a public channel after archiving it. They cannot read, search, export, join, or list names of private conversations. There is **no compliance export** (M-O10). | D73, D268, D269. |
| D338 | **Who may post:** a new capability `messages.post`. Default roles: admin and member (plus viewer and guest per M-O1). Posting also needs membership, a live non-archived conversation, and not being blocked. Creating channels needs `content.write` (members and admins); guests never see the public directory and can only start DMs with people who share a conversation with them. | D71 ceiling; one explicit write-gate allowlist entry per posting route if M-O1 is accepted. |
| D339 | **Module:** `messages` in `MODULE_IDS` (server and client), label "Messages", lucide `MessagesSquare` icon, launcher tile, Today section "Unread messages" (counts and up to 5 conversations, no text), Search facet, Settings → Notifications gains a Messages block. Off in Settings → Modules hides the UI only; the server keeps enforcing (D92). | D92. |
| D340 | **Out of scope for v1:** presence, typing, read receipts, huddles or calls, E2EE, federation, Slack Connect, custom emoji uploads, message scheduling, reminders on messages ("remind me" can create a Calendar reminder later), polls, slash commands, bots with their own accounts (service accounts D287 cover this later), retention policies (M-O5), and interactive modals. | Scope and surface. |

---

## 5. Data model: migration `036_messages`

One migration, transactional, filesystem-free. It needs 001, 006, 007, 016, 022, 025, and 026. UUID ids, ISO timestamps. `contentless_delete` FTS5 tables need SQLite ≥ 3.43; Bun 1.4's bundled SQLite is newer, and a startup assertion checks `sqlite_version()` [24]. SQLite accepts the forward reference from `messages.webhook_id` to `message_webhooks` (foreign keys are resolved at write time); the migration creates `message_webhooks` first anyway.

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('public','private','dm','group_dm')),
  name TEXT CHECK ((kind IN ('dm','group_dm')) = (name IS NULL) AND (name IS NULL OR (length(name) BETWEEN 1 AND 80 AND name NOT GLOB '*[^a-z0-9_-]*'))),
  topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 250),
  purpose TEXT NOT NULL DEFAULT '' CHECK (length(purpose) <= 500),
  dm_key TEXT UNIQUE,                                   -- 'a:b' sorted user ids for kind='dm'; NULL otherwise (D301)
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings) AND length(settings) <= 2048),
      -- managers_add_only, notes_members_edit, channel_mention_limit, bots_mention_channel
  last_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT, archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT, purge_after TEXT, purge_started_at TEXT,
  CHECK (kind = 'dm' OR dm_key IS NULL)
);
CREATE UNIQUE INDEX channels_name ON channels(name) WHERE name IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','manager','member')),
  notify TEXT NOT NULL DEFAULT 'default' CHECK (notify IN ('default','all','mentions','none')),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),     -- DMs hidden from one's sidebar (D308)
  last_read_seq INTEGER NOT NULL DEFAULT 0,                      -- never returned for others (D309)
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL, joined_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
) WITHOUT ROWID;
CREATE INDEX channel_members_user ON channel_members(user_id, channel_id);
CREATE TABLE message_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);   -- D305
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  broadcast INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0,1)),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','webhook','system')),
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  webhook_id TEXT REFERENCES message_webhooks(id) ON DELETE SET NULL,
  via_key_id TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL,
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 80),   -- webhook username override
  body_md TEXT NOT NULL DEFAULT '' CHECK (length(body_md) <= 40000),
  blocks_json TEXT CHECK (blocks_json IS NULL OR (json_valid(blocks_json) AND length(blocks_json) <= 65536)),
  forward_json TEXT CHECK (forward_json IS NULL OR (json_valid(forward_json) AND length(forward_json) <= 262144)),
  reply_count INTEGER NOT NULL DEFAULT 0, last_reply_at TEXT, reply_user_ids TEXT,
  created_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT
);
CREATE INDEX messages_timeline ON messages(channel_id, seq) WHERE thread_root_id IS NULL OR broadcast = 1;
CREATE INDEX messages_thread ON messages(thread_root_id, seq) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_author ON messages(author_user_id, seq);
CREATE TABLE thread_follows (
  root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following INTEGER NOT NULL DEFAULT 1, last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (root_id, user_id)
) WITHOUT ROWID;
CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user','channel','keyword')),
  PRIMARY KEY (message_id, user_id)
) WITHOUT ROWID;
CREATE INDEX message_mentions_user ON message_mentions(user_id, message_id);
CREATE TABLE message_pins (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (channel_id, message_id)) WITHOUT ROWID;
CREATE TABLE message_attachments (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, position INTEGER NOT NULL,
  PRIMARY KEY (message_id, document_id)) WITHOUT ROWID;
CREATE INDEX message_attachments_doc ON message_attachments(document_id);
CREATE TABLE channel_notes (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (channel_id, note_id)) WITHOUT ROWID;
CREATE INDEX channel_notes_note ON channel_notes(note_id, channel_id);
CREATE TABLE message_notices (                                  -- D320; ids and counts only
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  root_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mention','dm','keyword','thread','channel_mention','note_mention','reaction')),
  first_message_id TEXT, last_message_id TEXT, count INTEGER NOT NULL DEFAULT 1, actor_ids TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, read_at TEXT, pushed_at TEXT, mailed_at TEXT
);
CREATE UNIQUE INDEX message_notices_open ON message_notices(user_id, channel_id, COALESCE(root_id,''), kind) WHERE read_at IS NULL;
CREATE TABLE message_notify_prefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel_default TEXT NOT NULL DEFAULT 'mentions' CHECK (channel_default IN ('all','mentions','none')),
  thread_replies INTEGER NOT NULL DEFAULT 1, reactions INTEGER NOT NULL DEFAULT 0, show_text INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords) AND length(keywords) <= 1024),
  dnd_until TEXT, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE message_events (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, kind TEXT NOT NULL,
  message_id TEXT, user_id TEXT, created_at TEXT NOT NULL);         -- 72 h resume log (§3); swept hourly
CREATE INDEX message_events_channel ON message_events(channel_id, id);
CREATE TABLE message_webhooks (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  token_hash TEXT UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 64), token_prefix TEXT,   -- incoming
  url TEXT CHECK (url IS NULL OR length(url) <= 2048), secret_ct TEXT,                              -- outgoing (encrypted)
  events TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events)), trigger_words TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(trigger_words)),
  failure_streak INTEGER NOT NULL DEFAULT 0, paused_at TEXT, last_used_at TEXT,
  created_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((direction = 'incoming') = (token_hash IS NOT NULL)), CHECK ((direction = 'outgoing') = (url IS NOT NULL))
);
CREATE TABLE message_webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES message_webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, payload TEXT NOT NULL CHECK (length(payload) <= 131072),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_status INTEGER, error_code TEXT, created_at TEXT NOT NULL);
CREATE INDEX message_webhook_deliveries_due ON message_webhook_deliveries(next_at) WHERE status = 'queued';
CREATE TABLE link_unfurls (url_hash TEXT PRIMARY KEY CHECK (length(url_hash) = 64), url TEXT NOT NULL CHECK (length(url) <= 2048),
  unfurler TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('ok','none','failed')),
  card_json TEXT CHECK (card_json IS NULL OR (json_valid(card_json) AND length(card_json) <= 4096)),
  image_id TEXT, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE message_unfurls (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url_hash TEXT NOT NULL, position INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, url_hash)) WITHOUT ROWID;
CREATE VIRTUAL TABLE message_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2', prefix='2 3',
  content='', contentless_delete=1);                                -- rowid = messages.seq (D318)
CREATE TRIGGER reactions_message_cleanup AFTER DELETE ON messages
  BEGIN DELETE FROM reactions WHERE target_kind = 'message' AND target_id = OLD.id; END;
CREATE TRIGGER message_fts_cleanup AFTER DELETE ON messages
  BEGIN DELETE FROM message_fts WHERE rowid = OLD.seq; END;
-- folders.system_kind (D335)
ALTER TABLE folders ADD COLUMN system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('messages'));
```

**`api_key_grants` rebuild (required).** 025 fixed `module`, `permission`, and `resource_kind` with CHECK lists that lack `messages`, `post`, and `channel`, and SQLite cannot alter a CHECK. 036 therefore rebuilds that one table by the documented 12-step procedure: create `api_key_grants_new` with the lists widened (`module` + `'messages'`, `permission` + `'post'`, `resource_kind` + `'channel'`), copy every row, drop, rename, and recreate the unique index, the resource index, and both kind-wall triggers verbatim. The table is small (≤ 50 grants per key), so this runs in milliseconds. A test compares `sqlite_master` for the recreated index and trigger SQL before and after. The same rebuild is the moment to add future modules' words; the director decides whether to widen further (agent chat's `agents`, `run`).

**Other code with 036:** the `documents` readable predicate gains the `message_attachments` branch; `readableNotePredicate` gains the channel branch (D315); the Bin gains the `channel` provider; the sweeper prunes `message_events` older than 72 h, `message_webhook_deliveries` older than 7 days, and expired `link_unfurls` with their image files (and orphan files under `DATA_DIR/unfurl/`); user block and account removal delete that user's incoming webhooks' tokens and pause their outgoing webhooks.

---

## 6. Behaviour

### 6.1 The access predicate (`server/messages/access.ts`, single source)

- `readableChannelPredicate` (SQL, `c` alias): `c.deleted_at IS NULL AND (EXISTS (channel_members m WHERE m.channel_id = c.id AND m.user_id = $userId) OR (c.kind = 'public' AND <caller is not a guest>))`. Every list, read, search, event replay, notice text, MCP tool, unfurl (`nook` unfurler), and attachment branch uses it.
- `channelLevel(channel, user)` returns `none | read | post | manage | owner`: members `post` (capped by the Team role, D338), managers `manage`, owners `owner`; non-member readers of a public channel `read` (and `join`). An archived channel caps everyone at `read` except unarchive for managers.
- Keys: `messages:read` / `messages:post` grants ∩ `channelLevel` of the owner ∩ membership (non-member public reading is not offered to keys, so a key sees exactly the owner's sidebar).
- Missing and forbidden look the same (404). A readable channel where posting is refused gives 403 `CHANNEL_READ_ONLY` (archived) or `ROLE_READ_ONLY`.

### 6.2 Posting

`POST /api/messages/channels/:id/messages {clientId, markdown, blocks?, threadRootId?, broadcast?, attachmentIds?}`. `clientId` (UUID) makes retries idempotent for 24 h (the client's optimistic bubble keeps it). In one transaction: level check, bump `message_seq`, insert, FTS row, mentions, thread counters and follows, notices, `message_events`, webhook deliveries, and `channels.last_seq`. After commit: fan-out, then unfurls. Limits: 30 messages per minute per user and 10 per 10 s per conversation per user; 1,000 per day per key.

### 6.3 Unread

Channel unread = `channels.last_seq > member.last_read_seq` restricted to timeline messages by others; the count shown is mentions (from notices), capped at "99+". `POST …/read {seq}` only moves forward and fans `read.updated` to the user's other streams. "Mark unread from here" moves it back (the one backward move).

### 6.4 Mentions → notices → push and email

A mention (or DM, keyword, followed-thread reply) upserts the open `message_notices` row for (user, conversation, thread, kind), skipping the author, people who have muted the conversation (except direct `@person`), and people whose level cannot read. Push rules (D321): no visible stream, not in DND or quiet hours, the conversation's level allows it. Email rules (D322). Everything re-checks access at delivery.

### 6.5 Membership changes

Leaving or removal deletes the member row, closes follows and notices for that conversation, and pushes `member.changed` so the client drops the timeline. Access to channel notes and attachments ends in the same transaction (predicate-driven; nothing to revoke). Joining a public channel shows the full history.

---

## 7. API (session base `/api/messages`)

JSON only, bounded bodies (the 2.1 MB reader; message bodies are smaller by schema), `Cache-Control: no-store`, global Origin/CSRF/TOTP/role gates.

| Op | Method and path | Needs | Notes |
|---|---|---|---|
| Sidebar | `GET /conversations` | session | my conversations with unread and mention counts, kind, name or DM people, muted, hidden |
| Directory | `GET /channels?q=&cursor=` | not guest | public channels (name, topic, member count, joined) |
| Create channel | `POST /channels` | `content.write` | `{kind: public\|private, name, topic?, purpose?, memberIds ≤ 100}` |
| Open DM | `POST /dms` | `messages.post` | `{userIds: 1–9}` → existing `dm`/`group_dm` or a new one (guest rule D338) |
| Get / update | `GET`, `PATCH /channels/:id` | read / manage | `{name?, topic?, purpose?, settings?, expectedRevision}` |
| Convert | `POST /channels/:id/convert` | member (dm, group_dm) / owner (public↔private) | `{kind, name?}` |
| Archive / unarchive | `POST /channels/:id/archive`, `/unarchive` | manage | |
| Delete | `DELETE /channels/:id` | owner | → Bin (`channel`) |
| Members | `GET /channels/:id/members`, `PUT /channels/:id/members/:userId {role?}`, `DELETE …/members/:userId`, `POST /channels/:id/members {userIds ≤ 100, groupId?}`, `POST /channels/:id/join`, `POST /channels/:id/leave` | per D302 | group add expands to people once |
| Messages | `GET /channels/:id/messages?before=&after=&around=&limit=` | read | 50 per page, reactions, attachments, unfurls, thread summaries |
| Thread | `GET /messages/:id/thread?after=` | read | root plus replies |
| Post | `POST /channels/:id/messages` | post | §6.2 |
| Edit / delete | `PATCH`, `DELETE /messages/:id` | author / manager (D311) | `{markdown, blocks?}` |
| Forward | `POST /messages/:id/forward` | read source + post targets | `{targets ≤ 10, comment?, thread?: bool}` |
| Pins | `PUT`, `DELETE /messages/:id/pin`; `GET /channels/:id/pins` | post / read | |
| Follow | `PUT`, `DELETE /messages/:id/follow` | read | |
| Read state | `POST /channels/:id/read {seq}`; `POST /threads/:rootId/read {seq}` | member | |
| Notify prefs | `GET`, `PUT /prefs` (global), `PATCH /channels/:id/membership {notify?, muted?, hidden?}` | self | CAS by revision |
| Views | `GET /threads`, `GET /mentions`, `GET /search?q=` | session | followed threads with unread; my mentions; D318 |
| Unfurl remove | `DELETE /messages/:id/unfurls/:hash` | author / manager | |
| Notes tab | `GET /channels/:id/notes`, `POST /channels/:id/notes {noteId? \| title?}`, `DELETE /channels/:id/notes/:noteId`, `PUT /channels/:id/notes/order` | read / post / owner-of-note or manage | creates or binds (D315) |
| Webhooks | `GET`, `POST /channels/:id/webhooks`, `PATCH`, `DELETE /webhooks/:id`, `POST /webhooks/:id/rotate`, `GET /webhooks/:id/deliveries` | manage; members and admins only; session only | token or secret shown once |
| Reactions | existing `PUT`, `DELETE /api/reactions/message/:id/:emoji` | post (D323) | |
| Events | `GET /api/events` | session | SSE (§3) |
| Incoming hook | `POST /hooks/messages/:token` | the token | no session, no CSRF; 64 KiB; Slack/Mattermost shapes; 200 `ok` text (Slack parity) |
| Key REST | `POST /api/v1/messages/channels/:id/messages`, `GET /api/v1/messages/channels`, and `/api/v1/tools/*` | Nook key | D326 |

---

## 8. MCP tools

| Tool | Scope | Notes |
|---|---|---|
| `list_channels({kind?, query?})` | `messages:read` | conversations the key owner is in: id, kind, name or people, topic, unread count |
| `get_channel(channelId)` | `messages:read` | metadata, member names (≤ 100), pins (ids and 200-character excerpts) |
| `read_messages(channelId, before?, after?, limit ≤ 100)` | `messages:read` | Markdown, block fallback text, author and author kind, `via`, time, permalink, thread summary, reactions `{emoji, glyph, count}` (no names) |
| `read_thread(messageId, after?)` | `messages:read` | root plus replies (≤ 200) |
| `get_message(permalink \| messageId)` | `messages:read` | one message with context of 5 before and after |
| `search_messages(query, channelId?, from?, before?, after?, limit ≤ 50)` | `messages:read` | D318 operators as arguments; snippets |
| `post_message(channelId, markdown, blocks?)` | `messages:post` | as the owner, badged "via <key>"; `@channel` refused unless allowed (D317) |
| `reply_in_thread(messageId, markdown, blocks?, broadcast?)` | `messages:post` | |

Resource policy (D281): every tool declares `{kind: 'id', resourceKind: 'channel'}` or `{kind: 'list', resourceKind: 'channel'}`. Descriptions say that message content is written by people and bots and is untrusted, and that posted text is visible to every member.

---

## 9. Backup, restore, and operations

- **Everything is in SQLite** except attachments (Files objects, already backed up) and unfurl images (`DATA_DIR/unfurl/`, a cache: excluded from backups; rebuilt on demand). The outgoing-webhook secret key file `DATA_DIR/messages-webhook.key` (AES-256-GCM, the `totp.ts` envelope) is created on first use and **is** in the data directory backup; without it, outgoing webhooks need new secrets (the UI offers Rotate).
- **Growth:** about 1 KB per message with FTS; 5 million messages ≈ 5–7 GB. OPERATIONS gains a Messages section: sizing, `VACUUM` guidance, HTTP/2 at the proxy, proxy buffering off for `/api/events` (Caddy flushes SSE by default; nginx needs `proxy_buffering off`), and the unix-socket caveat for `server.timeout` [14].
- **Config:** `MESSAGES_MAX_STREAMS` (500), `MESSAGES_UNFURL` (`public`), `MESSAGES_UNFURL_ALLOWED_HOSTS`, `MESSAGES_UNFURL_DENIED_HOSTS`, `MESSAGES_UNFURL_PROXY`, `MESSAGES_INCOMING_WEBHOOKS` (true), `MESSAGES_WEBHOOK_ALLOWED_HOSTS` (empty). `compose.yaml` and `.env.example` gain empty defaults; the README table gains rows.
- **Restore:** SSE clients see `reset` (event ids from the old database are unknown) and refetch.
- **Upgrade to 036:** back up first; the `api_key_grants` rebuild is the only non-additive step, and it is covered by a row-count and schema test.

---

## 10. Threat rows (continue THREAT_MODEL; block T280–T299)

Trust boundaries added: (9) the SSE hub ⇄ membership; (10) inbound webhook tokens and outbound webhook destinations ⇄ the internet and the operator's private network; (11) the unfurl fetcher ⇄ arbitrary URLs.

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T280 | **Private conversation read by a non-member** (IDOR on channel, message, thread, permalink, attachment, pin, note, search, MCP) | One predicate (§6.1) used everywhere; 404 parity; a matrix test over 4 Team roles × kind × member/non-member/removed/blocked × session/key/MCP over every route and tool; a guard test fails if a `messages` query lacks the predicate fragment. | Required |
| T281 | **Admin reads private channels or DMs** (D73) | No admin bypass in the predicate; admin views show counts only (D337); no export; tests as an admin non-member. | Required |
| T282 | **Guest reaches the public directory or a public channel** | Guest branch excluded from the public clause (the `AUDIENCE_ALL_USERS` rule); guest audience test extended to every Messages route, the directory, search, and events. | Required |
| T283 | **Event stream leaks after removal** (a removed member keeps receiving events; replay across a membership change) | Hub membership snapshot updated in the membership transaction; replay filters by current membership; `member.changed` closes the timeline; a removed user's streams get `reset`. Tests: remove, then post, and assert no event; reconnect with an old `Last-Event-ID` after removal. | Required |
| T284 | **Cross-site WebSocket/stream hijacking or CSRF on writes** | No WebSocket; `/api/events` is a same-origin GET with the session cookie (`SameSite=Strict` per existing cookie policy); writes keep Origin, JSON Content-Type, and `X-CSRF-Token`. | Required |
| T285 | **XSS through Markdown, blocks, forwards, or unfurl cards** | React-only rendering (D313); no HTML path; link schemes allowlisted; blocks validated by zod and rendered by fixed components; unfurl text capped and rendered as text; images only same-origin with sandbox CSP. Fuzz tests with `<script>`, `javascript:`, `data:`, bidi overrides, and 40,000-character bodies. | Required |
| T286 | **SSRF through unfurl or outgoing webhooks** (metadata endpoints, localhost admin panels, the Nook host itself, redirects, IPv6 and decimal IP forms, DNS rebinding) | D333 and D329: scheme and port allowlist, every resolved address checked, re-resolve before the request, redirects re-validated (unfurl ≤ 3, webhooks none), no credentials, 4–5 s timeouts, size caps; private destinations only through the operator's allowlist; optional egress proxy. Tests with `127.0.0.1`, `[::1]`, `169.254.169.254`, `0x7f000001`, `localhost.` and a rebinding stub. | Required |
| T287 | **DNS rebinding window between check and connect** (Bun `fetch` cannot pin an address) | The push.ts L2 double-resolve narrows it; unfurl responses cannot reach the browser except as capped text and a sniffed image; `MESSAGES_UNFURL_PROXY` for strict sites. Residual documented. | Accepted (residual documented) |
| T288 | **Unfurl cache leaks private Nook content across users** | The `nook` unfurler is never cached and runs per viewer with that viewer's ACL (D332); the shared cache holds only external public metadata; test: two users, one without access, same link. | Required |
| T289 | **Bot impersonation** (a webhook posting as "Priya" or "Admin") | Webhook and key messages always show the BOT or "via <key>" badge and the creator; `display_name` cannot equal a team member's display name (case-folded) and cannot contain the badge text; no avatar URLs. | Required |
| T290 | **Notification spam or mail bombing** (agents using `@channel`, keyword storms, many DMs) | D317 limits; bots blocked from `@channel` by default; coalesced notices; email only after 30 min unread, one per hour per recipient, and the outbox's durable caps (T227); per-key daily post caps. | Required |
| T291 | **Webhook loops and amplification** (an outgoing webhook's reply triggering itself or another bot) | Bot messages never trigger outgoing webhooks; ≤ 5 webhooks per message; per-webhook 60/min; synchronous replies counted. | Required |
| T292 | **Webhook token or secret theft** (URLs in CI logs; secrets in the database) | Incoming tokens hashed, shown once, prefix listed in the central inventory, rotatable, revoked with the creator's access; outgoing secrets encrypted at rest with a separate key file; Standard Webhooks signatures with a 5-minute timestamp window and `webhook-id` for receiver-side replay protection. | Required |
| T293 | **Forged incoming requests or body abuse** (huge payloads, deep JSON, form bodies) | 64 KiB bounded reader; depth ≤ 8; zod; `payload=` parsed with the same bounds; invalid tokens counted in the `recordInvalidAuth` bucket; constant-time token lookup by hash. | Required |
| T294 | **Prompt injection via messages into agents** (MCP reads of channels containing hostile text) | Tool outputs labelled untrusted with author kind; keys only reach the owner's conversations; `messages:post` cannot delete, edit, manage membership, or use `@channel`; posts badged and rate-limited. Residual: an agent may still be misled into posting misleading text. | Required (residual documented) |
| T295 | **Metadata leakage** (private channel names via `#` mentions, forwards, search counts, the directory, notices, email subjects) | `#private-channel` placeholder for non-members; forward snapshots omit source names unless all recipients can read the source; search counts only from readable rows; email subjects carry only "New messages in Nook" plus the channel name when the recipient is a member. | Required |
| T296 | **Attachment access widening** (forwarding or re-linking someone else's file to a new audience) | Only the uploader can attach or forward a document (D312, D335); access is predicate-derived and ends with the link or membership; tests. | Required |
| T297 | **Denial of service** (stream exhaustion, huge channels, event replay storms, FTS abuse) | Stream caps (per user and instance), replay cap 1,000 then `reset`, post rate limits, search bucket, 50/100 page caps, body caps, unfurl concurrency 4. | Required |
| T298 | **Read-state or activity inference** (last-read positions, "seen" hints, presence) | No receipts, presence, or typing (D309); `last_read_seq` returned only to its owner; tests assert other members' read state never appears in any payload. | Required |
| T299 | **Deleted content survives** (edits, deletes, purged channels in FTS, unfurls, notices, webhook delivery rows, backups) | Delete wipes body, blocks, FTS, reactions, pins, unfurls, attachment links in one transaction; notices re-read at display; delivery rows pruned after 7 days; FTS `contentless_delete`; `secure_delete` (V-O7) helps; backups documented (T18 parity). | Required |

---

## 11. UI

**Routes** (in-house router, real history on desktop and mobile):
`/messages` (sidebar; the last conversation opens on desktop) · `/messages/c/:channelId` · `/messages/c/:channelId/m/:messageId` (permalink: scrolls and highlights; Back returns to where the link was clicked) · `/messages/c/:channelId/t/:rootId` (thread) · `/messages/c/:channelId/notes` · `/messages/c/:channelId/notes/:noteId` · `/messages/c/:channelId/details` (members, pins, webhooks, settings) · `/messages/threads` · `/messages/mentions` · `/messages/search?q=` · `/messages/browse` (public directory) · `/messages/new` (new message/DM picker).

**Desktop (> 760 px).** Three panes. **Sidebar** (resizable 220–360 px): Threads, Mentions, then Channels (unread bold, mention badges, muted greyed) and Direct messages (people's avatars or initials), each section collapsible; "+" opens New channel or New message. **Timeline:** header with name, topic, member count, **Messages | Notes** tabs, pins button, details button, search-in-channel. Messages group by author within 5 minutes; day dividers; a "New messages" line at the first unread; "Jump to present" when scrolled back. Hover toolbar: quick reactions (3 recent), emoji picker, reply in thread, forward, pin, copy link, ⋯ (edit, delete, copy text, mark unread). Thread summaries under roots ("4 replies · last 2 h ago" with participant initials). The composer has a formatting toggle row, attach (Files picker or upload), emoji, mention; drafts per conversation. **Right pane:** the open thread or details; closing it pops its route.

**Phone (≤ 760 px, 390 px target).** A stack of routes, each a history entry: **conversation list** (search field, Threads and Mentions chips, Channels, DMs) → **timeline** (header with Back arrow, name, tabs Messages | Notes as a segmented control, ⋯ for details) → **thread** (full screen). Long-press on a bubble opens an **action sheet** (quick reaction row of the curated 12 with "More…" for the full picker, reply in thread, forward, pin, copy text, copy link, edit, delete); the sheet and the emoji picker use `useHistoryDialogGuard`, so **Back closes the sheet first**, then the thread, then the timeline. The composer stays pinned above the keyboard (`visualViewport` resize), with 44 px targets; Send is a button. Tables in bubbles scroll horizontally inside the bubble; the page never scrolls sideways. Pull to load older messages; scroll position per conversation is kept in history state, so Back and Forward restore it.

**Notes tab.** A list of bound notes (title, last editor, updated), "New note" and "Add existing note" (Combobox of notes the user owns). Opening one pushes `/messages/c/:id/notes/:noteId` and shows the normal NoteEditor (draft/publish, D274) inside the channel frame; Back returns to the list.

**Details.** Members (with role Select for managers, remove, "Add people" Combobox, "Add group" bulk add), pins, notification level Select (All, Mentions, Nothing) and Mute, channel settings (managers), webhooks (managers: create incoming → shows URL once with Copy; create outgoing → URL, events multi-Select, trigger words, secret once; delivery log with status codes), Archive, Convert, Leave.

**Settings → Notifications → Messages:** default channel level, thread replies, reactions to my messages, show text in push, keywords (chips, ≤ 10), DND pause, and a pointer to quiet hours (shared with email). Every picker is `src/ui/Select` or `Combobox` (D91).

**Accessibility:** the timeline is a `role="log"` with `aria-live="polite"` only for messages arriving at the bottom; each message has an accessible name "Sam, 10:42, <first 80 characters>"; reactions are toggle buttons with `aria-pressed` and labels "Thumbs up, 3 people, including you".

---

## 12. Pick or don't pick

**Recommendation: pick**, in the four waves below. What to weigh:
1. **Value:** a shared place for people and agents next to the content they discuss. Agent output lands in channels as rendered Markdown and components; Notes tabs keep decisions next to the chat; MCP and webhooks make Nook a hub for self-hosted automation (CI, monitoring, the agent inbox).
2. **Cost:** the largest module after Tasks (about 12–14 sessions). It adds the first long-lived connections, the first server fetches of arbitrary URLs (unfurl), and the first outbound calls to user-chosen hosts (outgoing webhooks). Each is behind a switch.
3. **Privacy posture:** no receipts, presence, or typing; admins cannot read private conversations; the browser never contacts third parties. Unfurl fetches reveal the server's address to linked sites (M-O4).
4. **It is not Slack at scale:** a single process with an in-memory hub, SQLite, and ~500 streams. For hundreds of concurrent users or E2EE, run Matrix/Element or Mattermost instead.

**Don't pick** if the team already lives in another chat tool and only needs notifications there; then build only outgoing notifications to Slack/Mattermost-compatible webhooks from existing modules (about one wave).

---

## 13. Waves

| Wave | Backend | UI slice (runnable) | MCP | Size |
|---|---|---|---|---|
| **MSG-A (36): channels and timeline** | Migration 036 (all tables, the `api_key_grants` rebuild); `server/messages/{access,service,routes,events,hub,bin}.ts`; public/private channels, membership, join/leave, post, edit, delete, threads, follows; unread; `/api/events` SSE with resume, heartbeat, caps; reaction target `message` (curated set); `clientId` idempotency; Bin provider; module `messages` | Sidebar, directory, create channel, timeline with Markdown bubbles (`marked` lexer → React), composer (Tiptap Markdown), thread pane and 390 px thread route, hover toolbar and long-press sheet, curated reactions, permalinks, unread line, Back/Forward parity | `messages:read` (list, read, thread, get), `messages:post` (post, reply) | **L** (4 sessions) |
| **MSG-B (37): DMs, mentions, notifications, search** | DMs and group DMs, conversion; mentions and `#` links (D316–D317); `message_notices`, bell source, push rules, `messages.unread` mail template and category, quiet hours and DND, keywords; FTS indexing and operators, Search facet; pins; archive; forward; attachments via Files (D335) | New message picker, DM list, mention and channel suggestion menus, Threads and Mentions views, notification settings and per-channel levels, search page and in-channel search, pins panel, forward sheet, attachment upload and previews | `search_messages` | **L** (4 sessions) |
| **MSG-C (38): Notes tab, emoji, unfurl** | `channel_notes` and the note predicate branch (guard test); mentions inside notes on publish; emoji registry generator and full-set keys (`emojiSet`); unfurl registry, `nook` and `opengraph` unfurlers, fetcher with SSRF checks, image proxy, cache and sweeper | Notes tab (list, create, bind, NoteEditor route), mention node in notes, full emoji picker chunk (search, groups, recents, skin tone for composer), unfurl cards with remove | Channel notes readable through existing note tools (predicate) | **M–L** (3 sessions) |
| **MSG-D (39): webhooks and blocks** | `nook.blocks/v1` schema and Slack mapping; incoming webhook URLs; Nook key REST post route; outgoing webhooks with Standard Webhooks signing, outbox, retries, pause, synchronous replies, `block_action`; secret key file; central inventory rows for webhook tokens | Block renderer (header, section, fields, context, table, code, list, image, actions), webhook management in details, delivery log, private-channel banner | `blocks` argument on post tools | **L** (3 sessions) + **`/security-review` and an external review of the unfurl fetcher and webhooks before release** |

Each wave releases with its UI slice, keeps a QA instance running, and passes the 390 px Back/Forward checklist.

---

## 14. Test rows (TEST_PLAN)

1. **Migration 036:** fresh DB and a v0.18.0-shaped copy; the `api_key_grants` rebuild keeps every row, index SQL, and both kind-wall triggers; the new CHECK words accept `messages`/`post`/`channel` and still refuse unknown words; `dm_key` uniqueness; name uniqueness among live channels; cleanup triggers remove reactions and FTS rows on message delete and on channel purge cascade.
2. **Access matrix (T280–T282):** 4 roles × public/private/dm/group_dm × member/non-member/removed/blocked × session/key/MCP over every route and tool; admins non-members get 404 on private conversations and see counts only; guests never see the directory.
3. **Posting:** idempotent `clientId`; seq strictly increasing under concurrent posts; thread depth refused; broadcast replies appear in both views; body and block caps; rate limits with `Retry-After`; archived channels refuse posts, reactions, pins.
4. **SSE (T283, T297):** events arrive for members only; `Last-Event-ID` replay filtered by current membership; old ids → `reset`; the per-user cap closes the oldest with `replaced`; heartbeat keeps the stream past Bun's idle timeout; removal stops events at once; the 503 fallback path polls.
5. **Unread and privacy (T298):** read positions move forward only (except mark-unread); no payload contains another person's read state; no typing or presence endpoint exists.
6. **Mentions and notifications:** extraction from Markdown AST (links in code are ignored); `@channel` limits; bots blocked; mute and levels; coalescing; push only without a visible stream and outside quiet hours; email after 30 min unread, skipped when read, left, or deleted; unsubscribe for the `messages` category works.
7. **Search:** operators; ACL inside the FTS query (a private channel's hit never counts); edits reindex; deletes vanish; diacritics; prefix; the global facet.
8. **Notes tab:** members read and edit bound notes (D274 limits: no share, move, delete); unbinding and leaving end access; the guard test fails when a note predicate lacks the branch; binned notes are hidden.
9. **Reactions and emoji:** `message` target uses the full set, `card_comment` stays curated; registry append-only test; keys match `[a-z_]{1,24}`; 20 distinct emoji cap; aggregates carry names ≤ 10 and `more`.
10. **Webhooks (T289–T293):** incoming token hashing, prefix, rotation, revocation with the creator's access; Slack and Mattermost payload shapes (JSON and `payload=`); unsupported blocks counted; display-name impersonation refused; outgoing signatures verify with the reference `standardwebhooks` library; retries on the schedule; 410 disables; 20 failures pause; synchronous replies; loop guard; private destinations refused unless allowlisted.
11. **Unfurl (T285–T288):** SSRF vectors (loopback, link-local, metadata, IPv6, decimal, trailing dot, redirects to private, rebinding stub); size and time caps; only `<head>` parsed; image sniffing and sandbox CSP; the `nook` unfurler per viewer; cache TTLs; code spans not unfurled; `off`/`allowlist` modes.
12. **Rendering (T285):** fuzz Markdown and blocks against XSS vectors; raw HTML shown as text; tables scroll inside the bubble at 390 px; no `dangerouslySetInnerHTML` in `src/messages` (grep guard).
13. **UI at 390 px:** list → timeline → thread → action sheet → Back closes the sheet, then the thread, then the timeline; Forward restores each with scroll position; permalink entry and Back; Notes tab route; emoji picker closes on Back; no native `<select>`.
14. **Delete and purge (T299):** a deleted message leaves no text in FTS, notices, unfurls, pins, attachments, or events; channel purge from the Bin removes everything and resumes after a crash (tombstone first).

---

## 15. Open decisions (defaults in bold)

| # | Question | Default |
|---|---|---|
| M-O1 | May **viewers and guests post**, reply, and react in conversations they belong to (a `messages.post` capability and write-gate allowlist entries), or stay read-only as everywhere else? | **Yes for both, only in conversations they are members of; no channel creation, uploads, or note edits.** Chat without posting is not useful, and the membership list already limits reach. |
| M-O2 | Channel notes: members edit by default, or view by default? | **Edit** (D274 editor), switchable per channel |
| M-O3 | Incoming webhook URLs (capability tokens) in addition to Nook keys | **Yes**, per-instance switch `MESSAGES_INCOMING_WEBHOOKS` on |
| M-O4 | Unfurl mode | **`public`** (any public site, SSRF checks, private ranges refused); `allowlist` and `off` available |
| M-O5 | Message retention (auto-delete after N days, per channel or instance) | **None** in v1 (keep forever); revisit with the growth numbers |
| M-O6 | Show message text in push notifications | **Off** per person (lock screens) |
| M-O7 | Message uploads visible in the uploader's Files ("Message uploads" folder), or hidden (needs a `documents` rebuild to add a purpose) | **Visible** in Files |
| M-O8 | Emoji version cut-off for the picker | **Emoji 15.1** (older phones render it); raise yearly |
| M-O9 | One stream per browser (BroadcastChannel leader tab) instead of per tab | **Per tab** in v1; OPERATIONS recommends HTTP/2 |
| M-O10 | Compliance export of private conversations for admins | **No** (D73) |
| M-O11 | Opening a DM over MCP (`send_direct_message`) | **No** in v1: posting only to existing conversations |
| M-O12 | `@channel` threshold | **30 members** (managers only above), per-channel override |
| M-O13 | Typing indicators later (a throttled `POST` fanned out over SSE) | **Not planned**; revisit after MSG-D |

---

## Sources

1. Slack, converting a group DM to a private channel (history kept, cannot be undone, more than nine people): https://slack.com/help/articles/217555437-Convert-a-group-direct-message-to-a-private-channel
2. Slack `chat.postMessage` (4,000 recommended, 40,000 truncation): https://api.slack.com/methods/chat.postMessage ; https://docs.slack.dev/changelog/2018-truncating-really-long-messages/
3. Slack Block Kit: https://api.slack.com/block-kit ; table block: https://docs.slack.dev/reference/block-kit/blocks/table-block/ ; rich text block: https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/
4. Slack unfurling links in messages: https://docs.slack.dev/messaging/unfurling-links-in-messages/
5. Slack canvases in channel tabs: https://slack.com/help/articles/203950418-Use-a-canvas-in-Slack ; https://slack.com/help/articles/21290478840979-Feature-change-notice--Channel-canvases
6. Slack Events API (3 s timeout, retries): https://docs.slack.dev/apis/events-api/
7. Slack guest roles: https://slack.com/help/articles/202518103-Understand-guest-roles-in-Slack
8. Discord threads: https://docs.discord.com/developers/topics/threads
9. Zulip topics: https://zulip.com/help/introduction-to-topics ; https://zulip.com/why-zulip/
10. Mattermost outgoing webhooks: https://developers.mattermost.com/integrate/webhooks/outgoing/
11. Mattermost incoming webhooks (Slack compatible): https://developers.mattermost.com/integrate/webhooks/incoming/
12. Matrix MSC3440 threading via `m.thread`: https://github.com/matrix-org/matrix-spec-proposals/pull/3440 ; Element threads: https://github.com/element-hq/element-meta/issues/3
13. WHATWG HTML, server-sent events (`Last-Event-ID`, `retry`): https://html.spec.whatwg.org/multipage/server-sent-events.html
14. Bun server (`idleTimeout`, `server.timeout`): https://bun.com/docs/runtime/http/server ; SSE guide: https://bun.com/docs/guides/http/sse ; unix-socket caveat: https://github.com/oven-sh/bun/issues/43816
15. Hono streaming helper (`streamSSE`): https://hono.dev/docs/helpers/streaming
16. CSP `connect-src` and WebSockets under `'self'`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src ; https://github.com/w3c/webappsec-csp/issues/7
17. Page Lifecycle API (freeze, resume): https://developer.chrome.com/docs/web-platform/page-lifecycle-api
18. Web Push for Home Screen web apps on iOS 16.4: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
19. emoji-picker-element (CDN data source, IndexedDB, bundle size): https://github.com/nolanlawson/emoji-picker-element ; Emojibase datasets: https://emojibase.dev/docs/datasets/ ; https://github.com/milesj/emojibase
20. Standard Webhooks specification: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
21. oEmbed: https://oembed.com/
22. Open Graph protocol: https://ogp.me/
23. OWASP SSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
24. SQLite FTS5 (tokenizers, contentless-delete tables): https://sqlite.org/fts5.html
