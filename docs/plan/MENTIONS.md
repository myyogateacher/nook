# @mentions across Nook: plan

Status: **phase A built** (branch `feat/mentions`; no migration). Phases B and C are next (§11). Decisions D1320–D1336 (§12; D1337–D1339 spare). Migrations: none needed for phases A and B (ids 140–149 are reserved for this lane if phase C needs one). Threat rows T660–T664.

## 1. What exists today (surveyed on upstream/main 46b6368d)

- **Format and server side, generic comments only.** `shared/itemActivity.ts` defines `MENTION_PATTERN` (`@[Name](user:<uuid>)`), `mentionMarkdown(name, id)` and `mentionedUserIds(markdown)`. `server/activity/comments.ts` (`item_comments`, D805) notifies each mentioned person who can read the item (`notify()` topic `core.mention`, dedupe key `mention:<kind>:<id>`), skips the author, and on an edit only notifies ids that were not in the old body. The MCP tool `comment_on_item` documents the syntax.
- **No picker and no chip.** `src/ui/activity/ItemTimeline.tsx` (goals, deals, contacts, companies, standup responses, bookings, form responses, townhall) draws a comment body as a plain `<p>`, so a mention shows as raw `@[Ana](user:…)`, and there is no way to insert one except typing the syntax. WAVE_35 Q7 says it outright: "Nook has no @-mention picker".
- **Tasks have nothing.** Card comments (`card_comments`, server/tasks/comments.ts) and card descriptions (`cards.description`, Markdown edited in the Tiptap `NoteEditor`) do not parse mentions, do not notify, and the tasks module cannot call `notify()` (it accepts the seven workspace modules only).

### Where people write text

| Surface | Storage | Editor | Readers | Mentions? |
|---|---|---|---|---|
| Card comment (new, edit) | `card_comments.body`, Markdown-ish plain text | `<textarea>` in CardDialog | board readers | **Phase A** |
| Card description | `cards.description`, Markdown | Tiptap `NoteEditor` (`@tiptap/markdown`) | board readers | **Phase A** |
| Generic item comments + replies (goals, deals, contacts, companies, standup answers, bookings, form responses, townhall) | `item_comments.body_md` | `<textarea>` in ItemTimeline | the item's adapter `level()` | **Phase A** (server existed; picker + chips are new) |
| Notes body | note versions, Markdown | Tiptap `NoteEditor` | note readers | Phase B (notify on **publish**, not on every draft save) |
| Standup answers | `checkin_responses` answers, plain text | `QuestionInput` textarea | round readers | Phase B |
| Contact interactions (notes, calls, meetings) | `contact_interactions.body` | textarea in crm RecordPage / Sheets | book readers | Phase B |
| Goal description, goal check-in note | goals tables | textareas in goals/sheets.tsx | goal readers | Phase B |
| Calendar event notes | `events.description` | textarea | calendar readers | Later (event attendees already get mail) |
| Agent chat | chat messages | ChatApp | the chat's owner | **Excluded** (D1336) |
| Whiteboards | Excalidraw scene | Excalidraw | board readers | **Excluded** (D1336) |
| Form questions / public answers, townhall public questions, booking messages | public or outsider text | various | outsiders | **Excluded** (D1336) |

## 2. Storage format (D1320)

One format everywhere: the existing `@[Display Name](user:<uuid>)` (`MENTION_PATTERN`). It is Markdown-shaped (a link with a `user:` scheme), so it survives exports, Version history, MCP and copy-paste, and it reads acceptably as raw text ("@[Ana Silva](user:…)"). The name is a snapshot taken when the mention was inserted; the chip shows the snapshot (a rename does not rewrite old text). `[`, `]` and newlines are stripped from the name (`mentionMarkdown`).

- **Textareas** (card comments, item comments): the picker inserts the literal Markdown into the text followed by a space. The text stays what the server stores.
- **Tiptap** (card description; notes in phase B): an inline atom node `mention` with attrs `{ id, label }` (src/editor/mention.ts). Its Markdown tokenizer is an inline `marked` extension matching `MENTION_PATTERN` at the cursor; `renderMarkdown` writes `mentionMarkdown(label, id)`. It is part of `noteContentExtensions()` so read-only renders (the card description view, notes) draw chips too, and the serializer tests can run without a DOM. The `@` suggestion (the picker) is added only when the host passes a `mentionTarget`.

## 3. The picker (D1321, D1322)

- Typing `@` at the start of the text or after whitespace or `(` opens a popover listing people; the text after `@` (up to 40 characters, no newline; spaces allowed so "Ana Si" works) filters it. A space with no matches closes it, so "email me @ 5" does not trap the keyboard.
- **Keys**: ↑/↓ move (wrapping, skipping unavailable rows), Enter or Tab insert, Escape closes the popover only (it never closes the dialog behind it, and ⌘Enter still sends). The mouse works too (`mousedown` so the textarea keeps focus). No native `<select>`.
- **ARIA**: the textarea or editor gets `aria-expanded`, `aria-controls`, `aria-activedescendant`; the popover is a `listbox` of `option`s with `aria-disabled` on unavailable people.
- **Rows**: avatar (picture when they have one), name, and for someone who cannot read the item a muted second line "Can't see this card" (the item's kind word) and no hover highlight.
- **Layout**: the popover sits under the field (or above when there is no room below), 280 px wide, clamped to the viewport; at 390 px it is full width minus 24 px. It shows at most 8 rows.
- One component serves both editors: `MentionList` (presentational, React) + `mentionModel.ts` (pure: the trigger query at the caret, insertion, keyboard moves, which rows are selectable). `MentionTextarea` wraps a `<textarea>`; Tiptap renders `MentionList` through `ReactRenderer` from `@tiptap/suggestion`.

## 4. Who can be mentioned (D1323, D1324)

`GET /api/people/mentionable?kind=<workKind>&id=<itemId>&q=<text>&limit=<1–20>`:

- 404 unless the caller can read the item (the work kind adapter's `level()`), the same NOT_FOUND as a missing item (T501).
- Candidates are active **people** (never integrations, never blocked accounts), matched case-insensitively on the display name, never the caller.
- Each row is `{ id, displayName, avatarUrl, canRead }`, readers first, then names that start with the query, then by name.
- **Members, admins and viewers** (who have `team.read` and so can see the whole Team already) also get non-readers, marked `canRead: false`. The picker shows them greyed and **unselectable**, with "Can't see this card". Mentioning never shares the item (D1324): to bring someone in, share the board first.
- **Guests** (no `team.read`) get readers only. They learn no names they could not already see through the item's assignee or access lists (T660).
- Guests that cannot read the item are left out while the `share_with_guests` policy is off, as in the share picker.
- Rate limit: 120 lookups a minute per person (as the board readers' picker), 429 with `Retry-After` beyond.

## 5. Notifications (D1325–D1328)

- **Who**: each mentioned person who can read the item at write time, minus the author. Someone mentioned who cannot read gets nothing, and the text keeps their mention (it renders as a chip for readers).
- **Only new mentions**: on an edit (a comment edit, a description save), only ids that were not in the previous text are notified. Removing and re-adding a mention in a later save notifies again (it is a new mention). On a description, "previous" is the stored description before the save.
- **At most 20 people notified per write** (D1327); a body naming more is saved, and the first 20 readers in order are notified. Combined with the per-item dedupe key, a burst of edits leaves one unread row per person per item: `notify()` updates the unread row with the same `dedupeKey` (`mention:<kind>:<id>`).
- **Where it shows**: the bell and the Notifications page (`kind = 'module'`, topic `core.mention`), and Web Push, through the existing `notify()` plumbing. `notify()` now also accepts the core module ids `tasks` and `notes` (D1325), so a card mention is a "Tasks" notification titled "Ana mentioned you on a card" / "… in a card description", with the card's href.
- **Email** (phase C, D1328): a `mentions` mail category (on by default, in Settings → Notifications → Email), template `core.mention` coalescing per recipient within the activity window. The category list is JSON in `email_prefs.categories`, so no migration. Until then, a card's assignees and creator already get the "New comment on your card" mail.

## 6. Rendering (D1329)

- **`MentionChip`**: a pill with the person's initial avatar and `@Name`. It is a button for people with Team access, opening the person's profile in Team (`/settings/team/members/<id>`); for guests it is plain text. Its tooltip says "Open Ana Silva's profile".
- **`MentionText`** splits a plain-text body on `MENTION_PATTERN` into text and chips, keeping line breaks. It is used for card comments and ItemTimeline comments.
- **Tiptap** draws the `mention` node with the same CSS (`.mention-chip`), read-only and while editing. A chip is an atom: Backspace removes it whole.
- The chip shows the name snapshot from the text. A chip never reveals whether its person can read the item (T661).

## 7. Privacy and threats (T660–T664)

| Id | Threat | Mitigation |
|---|---|---|
| T660 | **Name leak through the picker**: a guest (or anyone) enumerates member names by querying the mentionable endpoint on an item they can read | Guests get readers only (names they already see in the assignee and access lists); members already see the whole Team. The caller must be able to read the item (404 otherwise), the endpoint is rate-limited (120/min), and it returns at most 20 rows per query. Emails are never returned. |
| T661 | **Access leak through `canRead`**: learning who can read an item | Only callers who can read the item ask, and only members (who can open the item's sharing list or its board readers anyway) see `canRead: false` rows. Guests never see non-readers. Rendered chips never show it. |
| T662 | **Notification leaks item content to a non-reader**, or mention spam | Only people who can read the item at write time are notified. The title holds the author's name and the item's kind word only, never the text, and the href is the item's own relative path (T509). Self-mentions are skipped, at most 20 people are notified per write, an edit notifies only new ids, and there is one unread row per person per item (dedupe key). |
| T663 | **Forged mention markup** (a name that is not the person's, a crafted id, script in the name) | The id decides who is notified. The name is display text only: rendered as React text or a Tiptap attribute, never HTML. `MENTION_PATTERN` accepts UUIDs only and names of at most 120 characters with no `]` or newline. A chip for an unknown id still shows the snapshot name, links only to the Team route (404 there for a bad id), and never loads anything. |
| T664 | **Mentioning to share**: someone expects a mention to give access | It never does (D1324): the picker greys out non-readers, and the docs say to share the board first. The MCP tool returns `canRead` so an agent can tell. |

## 8. MCP (D1330, D1331)

- `comment_on_card`, `update_card` (description), `create_card` (description) and `comment_on_item` accept the format and notify the same way (the services do it, not the tools). Their descriptions say how to write a mention.
- **New tool `find_people_to_mention`** (cross-module, read): `{ item: {kind, id} | {ref}, query?, limit? }` returns `{ people: [{ id, name, canRead, mention }] }`, where `mention` is the ready-made `@[Name](user:<id>)` text. It follows the same rules as the endpoint (guests: readers only). It needs the read scope of the item's module and the key's chosen items (T205), and it is offered to keys with any tasks, notes, or workspace read scope. Tool names never contain delete/remove.
- `get_card` keeps returning the plain-text description; mentions there read `@Name`.

## 9. Activity (D1332)

- A card records `mentioned` (`item`: the person, as a snapshot) once per newly notified reader, from a comment or the description, in the same transaction. The history reads "Priya mentioned Ana Silva".
- Generic items already record `commented`. Their mentions are visible in the comment itself, so no extra kind is needed.
- The person mentioned sees "Priya mentioned you on a card" in the bell (§5).

## 10. Mentions filter (D1333)

The Notifications page gets an **All · Mentions** switch. Mentions asks `GET /api/notifications?topic=core.mention`, which returns module rows with that topic only (access notices are left out). The bell stays as it is.

## 11. Phased rollout

- **Phase A (this branch)**: `mentionModel`, `MentionList`, `MentionTextarea`, `MentionChip`/`MentionText`, the Tiptap `mention` node + suggestion. Wired into card comments (new + edit), card description, ItemTimeline (new, edit, reply). Server: the `GET /api/people/mentionable` endpoint, `notifyMentions` shared by item comments and cards, card comment create/edit + card create/update description notify new readers, the `mentioned` card activity, `notify()` accepting `tasks`/`notes`. MCP: `find_people_to_mention`, plus tool descriptions. Docs: CHANGELOG, API_CONTRACTS, THREAT_MODEL T660–T664, USING.
- **Phase B**: notes body (picker in the note editor; notify readers of the note on **publish**, comparing against the previous published version), standup answers (QuestionInput long text), contact interaction notes and goal check-in notes (MentionTextarea + MentionText where they render), and the Notifications Mentions filter if not done in A.
- **Phase C**: `mentions` email category and template. Chips get pictures through a batched `/api/people/resolve`. Optionally "mentioned you" in Today.

## 12. Decisions

| Id | Decision |
|---|---|
| D1320 | One storage format: `@[Name](user:<uuid>)` (the existing `MENTION_PATTERN`) in textareas and as the Markdown of the Tiptap `mention` node. The name is a snapshot. |
| D1321 | The picker opens on `@` at the start or after whitespace or `(`. The query allows spaces, up to 40 characters, and closes on a space with no matches. ↑/↓/Enter/Tab/Escape, mouse; Escape closes only the popover. |
| D1322 | One picker model (`mentionModel.ts`) and one list (`MentionList`) for textareas and Tiptap (via `ReactRenderer`). At most 8 rows. |
| D1323 | `GET /api/people/mentionable?kind&id&q&limit`: the caller must read the item; people only; readers first. Members, admins and viewers also get non-readers (`canRead: false`); guests get readers only. |
| D1324 | A mention never shares. Non-readers are greyed and unselectable ("Can't see this card"); they are never notified. |
| D1325 | `notify()` accepts the core modules `tasks` and `notes` besides the seven workspace modules. Card mentions use module `tasks`, topic `core.mention`. |
| D1326 | Only newly added mentions notify (compared with the stored text before the write); no self-notify; readers at write time only. |
| D1327 | At most 20 people notified per write; one unread row per person per item via `dedupeKey mention:<kind>:<id>`. |
| D1328 | Email for mentions is phase C (a `mentions` category in the categories JSON, no migration). |
| D1329 | `MentionChip`: initial avatar + `@Name`, a button to the person's Team profile for people with `team.read`, text for guests. `MentionText` renders plain bodies. |
| D1330 | MCP: the write tools accept the format (the services notify). The new read tool `find_people_to_mention` returns ids, `canRead`, and the ready-made mention text. |
| D1331 | `find_people_to_mention` lives with the cross-module tools and is offered to keys holding any tasks, notes, or workspace read scope; each call checks the item's own module scope. |
| D1332 | Card history kind `mentioned` (`item` = the person), one per newly notified reader. |
| D1333 | The Notifications page gets an All · Mentions switch backed by `?topic=core.mention`. |
| D1334 | The description notifies on save (the description is saved explicitly, not autosaved), with "previous" being the stored description. |
| D1335 | Notes notify on publish, not on draft saves (phase B). |
| D1336 | Agent chat, whiteboards, public forms, townhall public questions and booking messages get no mentions: an agent is not a person to notify, and outsiders' text must not page members. |

## 13. As built (phase A)

- **Server**: `server/activity/mentions.ts` (`notifyMentions`, `mentionReaders`, shared by item comments and cards), `server/tasks/activity.ts` `recordCardMentions` (card comments create/edit, card create/description save), `server/people/mentions.ts` + `GET /api/people/mentionable`, `?topic=` on `GET /api/notifications`, `notify()` core modules, the card history kind `mentioned`, MCP `find_people_to_mention`.
- **Client**: `src/ui/mentions/` (`mentionModel.ts`, `mentionsApi.ts`, `Mentions.tsx` with `MentionList`/`MentionChip`/`MentionText`, `MentionTextarea.tsx`, `mentions.css`), `src/editor/mention.tsx` (the `mention` node and `MentionSuggestion`), wired into CardDialog (comment composer, comment edit, description) and ItemTimeline (comment, edit, reply). Notifications page: All · Mentions.
- **Found while building**:
  - A card's comment and description mentions share one unread row per person (`mention:card:<id>`): the newest title wins ("… in a card description"). This is by design (D1327).
  - Bold or italic around a mention is not kept: the node is an atom and its Markdown carries no marks.
  - The new-card composer (no card id yet) has no picker. Mentions typed as text there still notify when the card is created.
  - Tiptap's suggestion mounts its popover absolutely in `<body>`: it needs `z-index` (`.mention-popover-host`) above the card dialog, and an `onPosition` clamp keeps it 12 px from the viewport's sides on phones.
- **Next (phase B)**: notes body (notify on publish against the previous published version, D1335); standup answers (`QuestionInput` long text); contact interaction notes and goal check-in notes (`MentionTextarea` + `MentionText` where they render); `mentionTarget` for the new-card composer once the card exists. **Phase C**: the `mentions` email category and template (D1328), and picture chips via `/api/people/resolve`.

