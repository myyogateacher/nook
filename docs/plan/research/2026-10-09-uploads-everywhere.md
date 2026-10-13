# Uploads everywhere: one attachment model for every module

**Status:** research and plan, 2026-10-09, against v0.34.0 (`ba52881`). Operator decisions recorded in §9 (2026-10-09). **U0 built** on branch `uploads-u0` (§10 lists its APIs for U1–U7). The operator asked to "research all places that user would like to upload file and where we support that, and if its missing implement that". This doc covers the research and the plan. The implementation runs later, in separate agents, one slice each (§6).

**Numbering.** Other plans are being written in parallel, so this plan takes its own blocks: decisions **D390–D409** and threats **T340–T352**. Whoever merges the plans renumbers if the blocks collide. Migration ids are reserved: the S3 storage backend (branch `s3-storage`) takes **045**, this plan takes **046** and, if a second one is needed, **047**. The Messages migration moves after them, to 048.

**Rules this plan follows:**
- Mobile first, with Back/Forward parity at 390 px (D21; the history dialog guard, D18).
- Custom controls only, never native `<select>` or browser dialogs (D91).
- MCP tools for every module (D70).
- Append-only migrations that run inside the runner's transaction.
- UUID-only object storage (D4).
- SVG and HTML are never rendered inline (D6, D7).
- 404 for anything missing or forbidden.
- No new runtime dependency without a strong case (D20).

---

## 0. Summary

1. **Uploads exist in five places today:** Files, Notes (images only), Tasks (cards, card descriptions, comments), Collections (a `file` field), and Whiteboards (pictures). All of them go through **one pipeline**: `POST /api/files`, or `storeRawUpload` for MCP. That pipeline handles sniffing, quota, staging, fsync, and commit, and writes to **one byte store**, `DATA_DIR/documents/objects/<uuid>`. So the S3 layer already covers every user upload, **as long as nothing new bypasses `server/documentStorage.ts`.** Three other byte stores sit outside it: avatars (`DATA_DIR/avatars`), chat tool images (`chat_image_blobs`, BLOBs in SQLite), and whiteboard thumbnails (`whiteboards.thumb_png`, in SQLite). §2.3 hands these to the S3 agent.
2. **Access models differ by module.** Card and row attachments are hidden documents (`purpose = task_attachment | collection_attachment`), and the parent item's access covers them through live link predicates (D43, D58). Note and whiteboard pictures are ordinary Files items in the item's folder, and readers see them **only if they can open the file itself** (T165). A note shared directly (`sharing_override = 1`) whose folder is not shared therefore shows **broken images** to its recipients. That is today's most visible defect (G1).
3. **The biggest gaps, by value:**
   - G1: note images break for direct recipients, and notes cannot hold non-image files.
   - G2: calendar events have no attachments.
   - G3: the chat composer cannot attach files.
   - G4: there is no camera, paste, or drag-drop in the task and row attach flows, and no "pick from Files".
   - G5: comments cannot carry files without text, or take a pasted screenshot.
   - G6: there is no MCP read of attachment content.
   - G7: people cannot upload their own profile picture.

   §3 has the full ranked list.
4. **Recommendation (D390): every attachment is a Files document.** New uploads made to attach something land in a per-user system folder called **Attachments** (`folders.system_kind = 'attachments'`, as the Messages plan's D335 already designed for "Message uploads"). One generic link table, **`attachment_links(host_kind, host_id, document_id, part_id)`**, holds the links, and a **host registry** in code (the reactions D182 pattern) gives each host kind its read and write predicate. A document is readable through its own Files sharing, **or** through a live link from a live host the viewer can read (T340). This generalises D43 and D58, and Messages can reuse it.
5. **Why not a new hidden `purpose`.** The `documents.purpose` CHECK was fixed in 009. Widening it means rebuilding `documents`, a parent table with about 10 cascading children, inside a runner that holds `foreign_keys = ON` in a transaction. In that state `DROP TABLE documents` would cascade-delete every share, link, and whiteboard row. Visible files avoid the rebuild. They also keep quota honest and the Bin simple, and they match Messages M-O7 ("Visible").
6. **Nine slices** (§6). **U0** is the serial foundation: migration 046, the registry, the access branch, the system folder, the shared client attach sheet, and MCP read tools. Eight slices then run in parallel on disjoint files: U1 events, U2 tasks, U3 collections, U4 notes, U5 chat, U6 Files, U7 avatars, and U8, the optional 047 legacy conversion.

---

## 1. Inventory: what exists today

### 1.1 The shared pipeline

| Concern | Today | Source |
| --- | --- | --- |
| Upload route | `POST /api/files?purpose=file\|task_attachment\|collection_attachment&folderId=`. Multipart, one file, `Idempotency-Key` (UUID) for safe retries. | `server/documents.ts:383` (`handleUpload`) |
| MCP upload | `create_text_file` (≤ 1 MiB UTF-8 inline), and `begin_upload` → `PUT /mcp/uploads/:id` → `finish_upload` (D176). Purposes `file` and `task_attachment` only. | `server/mcpFileTools.ts:142`, `server/mcpUploads.ts` |
| Shared commit | `commitReceived`: sniff, quota re-check, insert, audit. `storeRawUpload` handles streams. | `server/documents.ts:237–380` |
| Byte store | `DATA_DIR/documents/.staging/<uuid>.part` → fsync → rename to `objects/<uuid>`, mode 0600. The orphan sweeper removes objects with no row. | `server/documentStorage.ts` |
| Type check | Magic bytes only. The client's `Content-Type` is never trusted. Types recognised: PNG, JPEG, GIF, WebP, PDF, MP3, OGG, WAV, MP4/M4A, WebM, UTF-8 text for `.txt .md .markdown .csv .tsv .log .json`. Everything else is `application/octet-stream` with `preview_kind = none` and downloads only. | `server/mimeSniff.ts` |
| Size | `MAX_UPLOAD_BYTES`, default **100 MiB** (1 MiB–2 GiB). Three concurrent uploads per user, with byte reservations. | `server/config.ts:336`, `documents.ts:23` |
| Quota | `USER_STORAGE_QUOTA_BYTES`, default **10 GiB** (0 means unlimited). It counts every document the user owns, **binned or live**, plus whiteboard snapshots and thumbnails, plus distinct chat tool images. 507 `QUOTA_EXCEEDED`. A free-disk floor also applies. | `documents.ts:73` |
| Serving | `GET/HEAD /api/files/:id/content?disposition=inline\|attachment` with Range, ETag, `nosniff`, `default-src 'none'; sandbox` (PDFs get `frame-ancestors 'none'` instead), CORP same-origin, `private, no-store`. Inline is served only for previewable kinds. | `documents.ts:448–560` |
| Read access | `readableSinglePredicate` = Files sharing (owner, document override, folder) **OR** a link from a live card on a readable board (D43) **OR** a link from a live row in a readable collection (D58). It is used in single reads only, never in lists (T40, T58). | `server/documentAccess.ts:65–108` |
| Role gate | Viewers and guests cannot `POST /api/files`: the default-deny write gate (D75) applies, and there is no allowlist entry. | `server/team/writeGate.ts` |
| App CSP | `img-src 'self' data:`, `default-src 'self'`. `Permissions-Policy: camera=()` (this does **not** block `<input capture>`, which opens the system camera app). | `server/index.ts:128–146` |

### 1.2 Per surface

Legend for the "how" column:
- **U** picker upload
- **D** drag-drop
- **P** paste
- **F** pick from Files
- **C** camera on phone
- **✗** not supported

| Surface | How | Where the bytes go | Limits and types | Who can see it | MCP / REST | Bin | Quota |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Files app** | U, D (pane and folder rows), ✗P, ✗C (only through the OS chooser), no folder upload | `documents` (`purpose='file'`) in the chosen folder | 100 MiB; any type; two concurrent in the client queue (`uploadQueue.ts`) | Owner, folder sharing, or the document's own override (D2, D3) | `list_documents`, `get_document_metadata`, `read_document_text` (text only), `create_text_file`, `begin_upload`, `rename_file`, `move_file` (refuses `AUDIENCE_CHANGE`, D177) | 30 days, restorable | Counts |
| **Notes: images** | U (slash "Image"), D, P. ✗F (no "pick an existing picture"), ✗C | Ordinary Files item **in the note's folder** (`uploadNoteImage`) | PNG, JPEG, GIF, WebP only. The client checks, then deletes the file again if the server's sniff disagrees. | **Whoever can open the file.** Folder readers can. A directly shared note's recipients **cannot**, so the image is broken (G1). | A note's Markdown holds `/api/files/<id>/content`, and agents see the URL only | Image files outlive the note (they are Files items) | Counts |
| **Notes: other files** | ✗ | | | | | | |
| **Task card** | U (Attach button). ✗D on the dialog, ✗P, ✗F (D179 forbids linking Files items), ✗C | Hidden `task_attachment` document, `card_attachments(card_id, document_id, comment_id)` | 100 MiB, any type; **50 per card** | Board readers, live (D43, T40); only the owner links (T41) | `link_attachment` (after `begin_upload purpose=task_attachment`); `get_card` lists attachment **names** only | Last unlink, card purge, or board purge bins the document; never-linked uploads are binned after 24 h (`sweepUnlinkedAttachments`) | Counts (uploader) |
| **Card description** | P, D, U of images through the editor → card attachment shown inline | As above | PNG, JPEG, GIF, WebP inline; other sniffs stay attached as files | As above | As above | As above | Counts |
| **Card composer (new card)** | U plus description images; uploads are held until the card is created | As above | ≤ 50 | | | Discard bins the uploads (T100) | |
| **Task comments** | U only (Attach), ≤ **10 per comment**. ✗P, ✗D, ✗C. **The text body is required** (`card_comments.body` CHECK `length ≥ 1`; the client disables Comment when empty). No adding files when editing a comment. | Card attachment with `comment_id` | | Board readers | `comment_on_card` takes no files; an agent links with `link_attachment {commentId}` | Comment delete unlinks and bins | |
| **Subtasks** | Same as cards (a subtask is a card) | | | | | | |
| **Collections: `file` field** | U in the row panel (`Attachments.tsx`, with progress). ✗D, ✗P, ✗C. **✗F in the UI, although the server accepts the linker's own Files items** (`attachDocument`, `collections/service.ts:885`) | Hidden `collection_attachment` document or a Files item, `collection_row_attachments(row_id, document_id, field_id)` | **20 per row**; cells show names, no thumbnails | Collection readers, live (D58, T58) | **Refused:** "Files cannot be attached over MCP" (`collections/mcpTools.ts:109`); rows show names only | Last unlink bins `collection_attachment` uploads; undo restores them; 24 h never-linked sweep | Counts |
| **Collections: CSV import** | U (parsed in the client) | Rows, not a file | | | | | |
| **Calendar events** | ✗ (only `event_links` to a note, card, or row) | | Description is plain text ≤ 8 KiB | | | | |
| **Whiteboards: pictures** | U (into **the board's folder**), F (picker sheet of the viewer's images), P, D on the canvas. Import `.excalidraw`. | Files item; the scene keeps a `nookDocumentId` reference (D198) | PNG, JPEG, GIF, WebP | **Per viewer:** the canvas fetches each picture as the reader, and an unreadable picture shows as a placeholder (T165, and the picker says so) | `whiteboards:read` returns elements, not pictures | Pictures are independent Files items | Counts |
| **Inbox / proposals** | ✗. The proposal kinds (`note_draft`, `card_*`, `card_comment`, `event_*`, `row_*`) carry no files. | | | | | | |
| **Chat composer** | ✗. A message is `content: string`; the provider request is OpenAI-compatible `chat/completions` with text turns only (`agents/loop.ts:20`). | | | | Tool images from MCP tools go to `chat_image_blobs` (≤ 2 MiB, 4 per call, 12 per run) | Chat purge removes them | Counted (D370, M2) |
| **Knowledge sources** | F (a published note, or a text, Markdown, or CSV file from Files), or pasted text. ✗U directly | Source rows plus chunks | Text only | Base members | `knowledge` tools | `sourceAccessChangedHook` drops the passages | |
| **Vault** | ✗ file secrets. Item types are `value`, `login`, and `note` (031 CHECK). Import `.env`, `.json`, `.csv`, `.txt` is parsed in the client. | Encrypted in SQLite | | | | | |
| **Profile picture** | ✗ upload. It is copied from Google sign-in only (≤ 1 MiB PNG, JPEG, or WebP, sniffed). | `DATA_DIR/avatars/<uuid>`, **outside** `documentStorage` | | Wherever the name shows | | Replaced on change | Not counted |
| **Team / branding** | ✗ (`APP_NAME` only; no logo upload) | | | | | | |
| **Today** | ✗ (shows recent Files items) | | | | | | |
| **Messages (planned)** | Planned: F or U into a "Message uploads" system folder, ≤ 10 per message, `message_attachments` (D335) | Files | | Conversation members, live | | | Counts |

### 1.3 What the S3 agent should know

- Every user upload today ends in `documentStorage.createStagingFile` / `commitStaged` / `writeObject` / `openObjectForRead` / `removeObject` / `sweepDocumentFiles`. Whiteboard scenes and snapshots use the same objects namespace (D193). **This plan adds no new byte store.** Every slice must upload through `commitReceived` / `storeRawUpload`.
- These stores are outside that interface, and the S3 agent decides on each one:
  - `DATA_DIR/avatars/<uuid>` (`server/avatars.ts`). U7 adds user uploads here, so it should go through the storage interface under its own prefix.
  - `chat_image_blobs.bytes` and `whiteboards.thumb_png` are SQLite BLOBs. They are small, already backed up, and can stay.
  - Note Markdown (`DATA_DIR/notes/...`, `server/storage.ts`) is text, and is the S3 plan's own call.

---

## 2. Findings worth calling out

1. **Broken note images for direct recipients (bug-class).** `uploadNoteImage` stores the picture in the note's folder. `readableDocumentPredicate` gives the folder's audience access, but a note's `sharing_override` gives none. When a person shares one note with a colleague, the colleague sees broken `<img>` tags. Card description images do not have this bug, because they are card attachments.
2. **Whiteboards behave the same way, on purpose (T165).** The picker tells the user so. It is safe, but it surprises people. U4 extends the note fix to boards only if the operator agrees (Q4).
3. **Collections can already link Files items, but the UI never offers it.** Tasks forbid it (D179, "Linking a Files item onto a shared board would share it"). This is the same question answered two ways. T341 unifies it: the owner may link their own file, after an explicit confirmation.
4. **A restored attachment becomes a Files item.** `server/bin.ts:207`: restoring an unlinked task or row attachment sets `purpose = 'file'` in the Default folder. So the codebase already treats "an attachment is a file" as the fallback, which supports D390.
5. **Comments cannot be files-only.** A screenshot with no words is the commonest bug-report comment. The `card_comments.body` CHECK (`length ≥ 1`) cannot be relaxed without rebuilding a parent table (`card_attachments.comment_id` and `reactions` hang off it). D397 works around it.
6. **No camera anywhere.** On phones, a plain `<input type="file">` already offers "Take photo" in the iOS and Android chooser. A one-tap camera needs `accept="image/*" capture="environment"`. `Permissions-Policy: camera=()` does not affect the `capture` attribute; QA must confirm this on iOS Safari and Android Chrome.
7. **Phone photos carry EXIF GPS.** Attaching a camera photo to a shared card publishes where it was taken. Nothing strips it today (T349).
8. **Agents cannot read attachments.** `listableDocument*` excludes attachments by design, and card and row tools return names only. An agent asked to "summarise the spec attached to this card" cannot.

---

## 3. Gaps, ranked by value

Value combines how often people expect the surface, how bad the current workaround is, and the risk of fixing it.

| # | Gap | Who hits it | Current workaround | Value | Slice |
| --- | --- | --- | --- | --- | --- |
| G1 | **Note images break for direct recipients**; notes cannot hold non-image files (PDF, spreadsheets, zip) | Everyone who shares notes | Share the folder, or paste a Files link by hand | **Highest** (it is a defect) | U4 |
| G2 | **Calendar events have no attachments** (agenda, slides, tickets) | Meeting owners | Link a note, or paste a URL into the description | High | U1 |
| G3 | **Chat composer attachments** ("summarise this PDF", "what is in this screenshot") | Agent users | Upload to Files, add it to a knowledge base, then ask | High | U5 |
| G4 | **Task cards: drag-drop onto the dialog, paste, camera, pick from Files** | Board users, phone users | Download, then re-upload | High | U2 |
| G5 | **Comments: paste or drop a screenshot, a files-only comment, camera** | Board users | Type "see attached" | High | U2 |
| G6 | **MCP / REST: list and read attachment content** for cards, rows, events, and notes | Agent and automation users | None | Medium-high | U0 (generic), plus each host slice |
| G7 | **Collections: drag-drop, paste, camera, pick from Files, image thumbnails, MCP attach** | Collection users (inventory, CRM, receipts) | Upload one by one in the row panel | Medium | U3 |
| G8 | **Profile picture upload** (people without Google sign-in) | Every non-Google account | Initials | Medium | U7 |
| G9 | **Files app: paste to upload, a camera button, folder upload** | Files users | OS chooser | Medium-low | U6 |
| G10 | **Whiteboard pictures follow board sharing** (T165 today) | Board sharers | Share each picture | Medium-low (policy change) | U4b, behind Q4 |
| G11 | **Knowledge: "Upload a file" in Add source** | Base managers | Upload in Files first | Low | U5 (one button) |
| G12 | Inbox: agent proposals with attachments (`card_comment` with a file) | Agent users | Approve, then attach by hand | Low | Later |
| G13 | Vault file secrets (certificates, SSH keys, `.p12`) | Ops users | A `note` item holding PEM text | Low here; needs vault crypto | Deferred (Q8) |
| G14 | Messages | | | Planned | Messages adopts D390 (§4.8) |

---

## 4. Design recommendation

### 4.1 Decisions

| Id | Decision | Why |
| --- | --- | --- |
| D390 | **Every attachment is a `documents` row with `purpose = 'file'`**, uploaded through `POST /api/files` (or `storeRawUpload` for MCP) and served by `/api/files/:id/content`. No new byte store and no new content route. | The S3 layer covers it once. One sniff, quota, idempotency, and header path. |
| D391 | **The per-user "Attachments" system folder.** Migration 046 adds `folders.system_kind` (shape-checked text: NULL, or 1–32 characters of `[a-z_]`), with a partial unique index `(owner_id, system_kind)`. `ensureSystemFolder(userId, 'attachments')` creates it lazily, named "Attachments", at the root. Uploads made **to attach** (`POST /api/files?attachTo=<kind>`) land there. Messages later uses `system_kind = 'messages'` (D335) on the same column. | No `documents` rebuild (§0.5). People can find, download, and delete their uploads. Quota is visible. |
| D392 | **System folder rules.** The folder cannot be shared, renamed, deleted, or moved, and nothing can be created inside it. Files cannot upload into it directly, and files cannot be moved in. Files **can** be moved out: the owner keeps them as ordinary files, and they then leave the attachment lifecycle (D395). | A folder share would expose every attachment at once (T342). Moving out is the owner's own choice. |
| D393 | **One link table**, `attachment_links(host_kind, host_id, document_id → documents ON DELETE CASCADE, part_id, position, linked_by, created_at)`, PK `(host_kind, host_id, document_id)`, indexed on `document_id`. `part_id` is the comment, field, or message within the host. Migration 046 adds `AFTER DELETE` triggers on each host table (`events`, `notes`, `chat_messages`) that delete their links, so a purge, including an FK cascade, leaves no stale links. Card and row links stay in `card_attachments` and `collection_row_attachments` (no data move). The registry's `card` and `row` hosts read those tables. | One shape for new hosts. The existing, tested tables stay as they are. |
| D394 | **A host registry** (`server/attachments/hosts.ts`, the D182 pattern): `{ kind, readableSql(alias) /* uses $userId */, canLink(userId, hostId, partId), canUnlink(userId, link), lockKey(hostId), caps: { perHost, perPart }, publicSurfaces: false }`. `readableSinglePredicate` gains **one** generated branch: `EXISTS (SELECT 1 FROM attachment_links l WHERE l.document_id = d.id AND (<OR of each host's readable SQL>))`. **All host predicates live in U0** and are reviewed once. Slices only call the service. | Access is the security core: one place, one review, one matrix test. |
| D395 | **Lifecycle.** A document **in the Attachments folder** whose last link goes (unlink, comment delete, host purge) moves to its owner's Bin, as D42 does today. A document outside that folder (a Files item someone linked) is never binned by link changes. Two sweeper steps are generalised: uploads still unlinked after 24 h, and documents whose links all vanished through a host purge. Both handle Attachments-folder documents only, 100 per run. Binning a host keeps its links, so restoring the host brings them back. | One rule, and it matches what users see in tasks today. |
| D396 | **Linking an existing Files item** ("From Files") is allowed for **the item's owner only** (T41 generalised), after a confirmation in the D91 confirm dialog: "People who can open *‹host›* will be able to open *‹file›*." D179 is relaxed accordingly (Q2). Files the linker can read but does not own are never linkable. | Collections already allow it; tasks refused it to avoid sharing by side effect, and the confirmation makes the effect explicit (T147). |
| D397 | **Files-only comments.** When the text is empty and files are attached, the server stores the body `📎 <first name>` or `📎 N files`, so the CHECK holds. The client shows such a comment as files only. No rebuild. | The body CHECK cannot change without rebuilding a parent table. |
| D398 | **One client kit** in `src/ui/attachments/`. <br>• **`AttachSheet`**: a D91 bottom sheet at ≤ 760 px and a popover on desktop, guarded by `useHistoryDialogGuard` so Back closes it. It offers "Take photo" (phones only: `accept="image/*" capture="environment"`), "Choose files", and "From Files" (a picker that searches the caller's **own** Files items, the `PickerSheet` pattern from `src/whiteboards/NookPickers.tsx`). <br>• **`useFileDrop`** and **`usePasteFiles`** hooks, using the editor's rule: rich-text pastes stay text. <br>• **`AttachmentList`**: thumbnails, name, size, download, and remove. <br>• **`AttachmentPreview`**: a sheet that reuses `FilePreview`, guarded so Back closes it, instead of today's `target=_blank`. <br>• **`uploadForHost`**: XHR with progress, an Idempotency-Key, and abort. | One accessible widget set, and the same behaviour in every module. |
| D399 | **Previews and thumbnails.** Phase 1 has no server image processing (D20). Inline thumbnails are the original image, lazy-loaded, for sniffed PNG, JPEG, GIF, or WebP **≤ 8 MiB**. Larger images, and every other kind, show a kind icon. PDF, audio, video, and text open in `AttachmentPreview` through the existing content route and CSP. Phase 2 (Q5) adds client-generated 256 px WebP thumbnails, uploaded by the uploader's client as `document_thumbnails(document_id, bytes ≤ 64 KiB)` in 047, counted in the quota, and served with the thumbnail header set (`isContentRequest`). | Phones should not download 12 MB photos to draw a 48 px square, but phase 1 is acceptable at today's scale. |
| D400 | **Limits.** The global `MAX_UPLOAD_BYTES` and quota stay as they are. Per host: card 50 and comment 10 (unchanged), row 20 (unchanged), **event 20**, **note 100**, **chat message 5**, avatar 1 MiB. Three concurrent uploads per user (unchanged). Chat attachments sent to a model are further capped (D404). | Matches the existing caps; notes hold more because they are documents. |
| D401 | **EXIF.** Before upload, the client removes APP1 (EXIF/XMP) segments from JPEGs taken with "Take photo". For other JPEGs it removes them when the "Remove photo location" setting is on (default **on**). It does this by rewriting segments as a pure byte operation, with no re-encode and no dependency. The orientation tag is applied by rotating the preview with CSS `image-orientation: from-image`. The server never rewrites bytes, because the sha256 must match. | Location privacy on shared items (T349). |
| D402 | **MCP (D70).** <br>• Generic tools in U0: `list_attachments({hostKind, hostId})` and `read_attachment_text({documentId, hostKind, hostId})` (UTF-8 ≤ `MCP_MAX_TEXT_BYTES`). Each is gated by **the host module's read scope** plus the key's resource grants on the host, never by `files:read` alone. <br>• Attach tools in each slice: `attach_file_to_event`, `attach_file_to_row` (lifting the `collections/mcpTools.ts:109` refusal), and `link_attachment` for cards (kept). Each takes a `documentId` from `create_text_file` or `begin_upload` with the new `purpose: "attachment"` alias, which lands in the Attachments folder. <br>• No base64 binaries (D176). Every attach is audited and uses the module's write bucket. | Agents can read and attach, never share by side effect. |
| D403 | **REST parity** comes free: `/api/v1/tools/:name` runs the same tool definitions (Wave 34). | |
| D404 | **Chat attachments.** <br>• Text kinds (the sniff's `text` kind, plus PDF **only if** a text extractor exists; it does not today, so PDF is refused with `NOT_TEXT`) are sent to the model as a fenced user-turn block, ≤ 64 KiB per file and ≤ 128 KiB per message. <br>• Images (PNG, JPEG, GIF, WebP ≤ 5 MiB) are sent as `image_url` data parts **only when the agent's model is marked vision-capable** by the admin. Otherwise the composer refuses images, saying why. <br>• The disclosure line under the composer names the provider. The provider knowledge policy applies. | The provider sees the content, so the user must know. |
| D405 | **Search.** No content indexing in this plan. A host's own FTS may add attachment **names** where it already indexes text (card search, row FTS, event search). File content search is a separate project. | Bounded scope. |
| D406 | **Viewer and guest roles.** No uploads (the D75 write gate, unchanged). They can open attachments on hosts they can read. | |
| D407 | **Public surfaces carry no bytes.** Public chat links, ICS feeds, mail, push, digests, and webhooks show attachment **names at most**, never a content URL that would work without a session. | T343. |
| D408 | **Note links are derived, not declared.** On every **publish** (and on MCP `create_note` or `publish_note_draft`), the server parses the published Markdown for `/api/files/<uuid>/content` images and `/files/<uuid>` file chips. It then sets the note's `attachment_links` to the referenced documents **that the publisher owns**, capped at 100. Drafts grant nothing. A referenced file the publisher does not own stays per-viewer, as today. | A reader of a published note sees what the author put in it, and an editor cannot grant other people's files. |
| D409 | **Delete from Files.** Deleting a linked Attachments-folder file **from Files** is allowed after a confirmation that lists where it is used ("Used on 2 cards and 1 event"). It replaces today's `ATTACHMENT_LINKED` 409 for these documents. Hosts then show "File removed" until a restore. | Files is the place people go to free space, and refusing there is a dead end. |

### 4.2 Access rules (threat rows, continuing THREAT_MODEL)

| Id | Threat | Mitigation | Links |
| --- | --- | --- | --- |
| T340 | **An attachment stays readable after access to its host ends** (unshare, removal, Bin, link removed) | Access is a live predicate in `readableDocument*` only, never in lists. It requires a live link, a live host (`deleted_at IS NULL`), and the viewer's level ≥ `view` on the host (`server/access/levels.ts`). Responses are `private, no-store`. A matrix test covers {owner, editor, viewer, removed, guest} × {card, row, event, note, chat message} × {session, key, MCP}. | Generalises T40, T58; D43, D58 |
| T341 | **Linking someone else's file** to expose it through a host | `canLink` requires `documents.owner_id = caller` **and** link permission on the host (cards: `edit`; comments: comment author; events: `edit`; notes: publisher; chat: the message author). Re-linking is idempotent for the owner only (no probing). | T41, D179 (relaxed by D396), T147 |
| T342 | **A system folder shared wholesale** | The share, rename, delete, move-into, and upload-into routes refuse `system_kind` folders (400 `SYSTEM_FOLDER`). A test enumerates the folder and document mutation routes. | D392 |
| T343 | **Attachment bytes on public or unauthenticated surfaces** | No content URL in public chat shares, ICS, mail, push, or webhook payloads; names only. The content route still requires a session or never accepts a key. | D407; T304 (chat images) |
| T344 | **Active content served inline** (SVG, HTML, polyglots) | Unchanged: sniff decides `preview_kind`, inline only for previewable kinds, `nosniff`, sandbox CSP, CORP same-origin. Thumbnails (phase 2) are WebP from the client, re-sniffed on upload, and refused unless they sniff as WebP. | D6, D7, §7.1; T169 |
| T345 | **Agents read attachments past their grants** | Generic tools need the host module's read scope **and** a key grant on the host (the `keyFilter` pattern). A `files:read`-only key gets no attachment reach beyond the owner's own Files listing. | D70, D280 |
| T346 | **Chat attachments sent to an unexpected provider** | Content goes only to the chat's agent provider, under the provider knowledge policy, with a visible disclosure. It is never sent to tool servers. Images go only to vision-flagged models. | D404 |
| T347 | **Upload flooding** (disk, quota, sweeper load) | Existing per-user concurrency, size, quota, and free-disk floor, plus the per-host caps (D400). MCP attach tools use module write buckets. The never-linked sweep runs at 24 h. | D176 |
| T348 | **Stale links after host purge** | The `AFTER DELETE` triggers on host tables (046), and a periodic check that deletes `attachment_links` rows whose host row is gone (for hosts without a trigger). | D393 |
| T349 | **Location leaks from phone photos** | EXIF/XMP stripped in the client (D401). The documentation states the server keeps the bytes as uploaded. | |
| T350 | **Note link derivation used to grant other people's files** | Only documents owned by the publisher are linked. Drafts never derive links. A cap of 100. | D408 |
| T351 | **Deleting from Files breaks hosts silently** | A confirmation lists the uses (D409). Hosts render "File removed". Restore relinks it for free, because links survive the Bin. | |
| T352 | **Malware distribution through attachments** | No antivirus scanning (no daemon, D20). Bytes download only as `attachment` unless previewable. A virus-scan hook is an open question (Q7). | |

### 4.3 Mobile and history (D21, D18)

- At 390 px, "Attach" always opens `AttachSheet` (bottom sheet, D91). Back closes it, and Forward does not reopen it. The sheet pushes no route, and the history guard (`src/ui/useHistoryDialogGuard.ts`) handles Back.
- "Take photo" appears only when `matchMedia('(pointer: coarse)')` matches. QA checks iOS Safari (sheet → camera → photo returns to the sheet) and Android Chrome.
- `AttachmentPreview` is a guarded sheet as well, not a new tab. Download stays a plain link.
- The upload progress row is sticky at the bottom of the sheet. Leaving the host with uploads in flight asks first (`useLeaveGuard`).
- Drag-drop is desktop only. Paste works on both (iOS supports pasting images into a focused composer).

### 4.4 Bin and purge

- Host binned: its links stay, readers lose access (live predicate), and the owner's Files still show the file.
- Host restored: access returns.
- Host purged: triggers or existing code delete the links, and the sweeper bins orphaned Attachments-folder files 30 days ahead of their purge.
- A file binned from Files: links stay, and hosts show "File removed". A restore brings it back, into the Attachments folder (unlike `bin.ts:207` today, which uses Default for legacy hidden purposes).

### 4.5 Quota

No change to the formula. Attachment documents count once, against the **uploader**, whichever host shows them, which is today's rule. Phase 2 thumbnails count too. The Today storage card links to Files › Attachments, sorted by size, so people can free space.

### 4.6 CSP

No change. Images load from `/api/files/:id/content` (`img-src 'self'`). Media and PDF previews use the existing `FilePreview` paths. Camera capture needs no `Permissions-Policy` change. Data URLs are not used for attachments.

### 4.7 Type sniffing and safety

`server/mimeSniff.ts` stays the single authority. Each host's "images inline" decision uses `preview_kind === 'image'` and the four inline MIME types (`isInsertableImageType`). Avatars keep `sniffAvatar`. Chat uploads reuse `imageTypeOf` (`server/agents/images.ts`). No extension allowlist is added: any file can be attached, and only previews depend on the sniff.

### 4.8 Messages

D335 should adopt this plan: `folders.system_kind = 'messages'`, or the shared `'attachments'` folder (Q6), and `attachment_links(host_kind='message', host_id=message_id)` instead of a dedicated `message_attachments` table. The access branch then comes from the registry.

---

## 5. Data model: migration `046_attachments`

Filesystem-free and idempotent. It needs 001, 006, 013, 039.

```sql
ALTER TABLE folders ADD COLUMN system_kind TEXT
  CHECK (system_kind IS NULL OR (length(system_kind) BETWEEN 1 AND 32 AND system_kind NOT GLOB '*[^a-z_]*'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_system_kind ON folders(owner_id, system_kind) WHERE system_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachment_links (
  host_kind TEXT NOT NULL CHECK (length(host_kind) BETWEEN 1 AND 32 AND host_kind NOT GLOB '*[^a-z_]*'),
  host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 64),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  part_id TEXT CHECK (part_id IS NULL OR length(part_id) <= 64),
  position INTEGER NOT NULL DEFAULT 0,
  linked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host_kind, host_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_attachment_links_document ON attachment_links(document_id);
CREATE INDEX IF NOT EXISTS idx_attachment_links_part ON attachment_links(host_kind, part_id) WHERE part_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS events_attachment_links_ad AFTER DELETE ON events
  BEGIN DELETE FROM attachment_links WHERE host_kind = 'event' AND host_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS notes_attachment_links_ad AFTER DELETE ON notes
  BEGIN DELETE FROM attachment_links WHERE host_kind = 'note' AND host_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS chat_messages_attachment_links_ad AFTER DELETE ON chat_messages
  BEGIN DELETE FROM attachment_links WHERE host_kind = 'chat_message' AND host_id = OLD.id; END;
```

The shape checks on `host_kind` and `system_kind`, rather than enums, let Messages and later hosts register in code with no rebuild (the D182 lesson). Triggers fire on FK cascades too, so a calendar purge (which cascades `events`) cleans up its links.

**047 (optional).** Two candidates, and either or both may be taken:
- (a) The `document_thumbnails` table for phase-2 thumbnails (Q5).
- (b) The legacy conversion (U8, Q3): `UPDATE documents SET purpose = 'file', folder_id = <owner's Attachments folder>` for live and binned `task_attachment` and `collection_attachment` documents. This creates each owner's system folder in SQL. The `purpose` CHECK already allows `'file'`, so no rebuild is needed. The link tables are unchanged.

---

## 6. Slices

**Order.** U0 lands first, alone. After it, U1–U7 run in parallel. Their file sets are disjoint: each owns its module's server and client files and only **calls** `server/attachments/*` and `src/ui/attachments/*`. U8 runs after U2 and U3. If a slice finds it must change a U0 file, it stops and reports.

### U0: the foundation (serial)

| | |
| --- | --- |
| **Files** | New `server/migrations/046_attachments.ts` (+ `index.ts` registration). New `server/attachments/{hosts.ts, service.ts, routes.ts, mcpTools.ts, sweep.ts}`. Edits to `server/documentAccess.ts` (the generated registry branch), `server/documents.ts` (`?attachTo=` → Attachments folder; D409 delete with usage; `SYSTEM_FOLDER` refusals), `server/folders.ts` (system folder refusals), `server/bin.ts` (restore into the Attachments folder; the note purge path), `server/sweeper.ts` (generalised steps), `server/mcpFileTools.ts` (`purpose: "attachment"`), `server/mcpTools.ts` (register the tool group), `server/index.ts` (routes). New `src/ui/attachments/{AttachSheet.tsx, AttachmentList.tsx, AttachmentPreview.tsx, useFileDrop.ts, usePasteFiles.ts, uploadForHost.ts, exif.ts, attachments.css}`. Edit `src/files/FilesApp.tsx`: the system folder badge, no Share/Rename/Delete on it, the usage dialog on delete. |
| **Host predicates** | `card` and `row` adapt the existing D43 and D58 SQL. `event` (calendar `view` or above), `note` (`readableNotePredicate`, published only), and `chat_message` (`readableChat`'s SQL: owner or shared, never public links) are written here with their slices' `canLink` rules. |
| **API** | `GET /api/attachments/:hostKind/:hostId`. `POST /api/attachments/:hostKind/:hostId {documentId, partId?}`. `DELETE /api/attachments/:hostKind/:hostId/:documentId`. `GET /api/files/:id/usage` (owner only: the hosts the owner can read, others counted). |
| **Migration** | **046** |
| **Tests** | `tests/attachmentsAccess.test.ts`: the T340 matrix with generated cases, 404 parity, binned host, removed member, key vs session. `tests/attachmentsLifecycle.test.ts`: last unlink → Bin only in the Attachments folder; moved-out files never binned; triggers on purge; 24 h sweep; restore lands in the Attachments folder. `tests/systemFolder.test.ts`: T342 refusals enumerated over routes. `tests/attachmentsMcp.test.ts`: scope and grant gating, `read_attachment_text`, `purpose: "attachment"`. A migration test (046 idempotent, triggers present). Client unit tests: `exif.test.ts` (APP1 removed, image intact, non-JPEG untouched) and `usePasteFiles` (rich-text paste ignored). |
| **QA** | Own origin per the QA memory. On desktop and at 390 px: Files shows "Attachments" with a lock badge, and Share, Rename, Delete, and drop-into are refused. Deleting a linked file shows the usage dialog. Run the MCP tools through REST `/api/v1/tools`. |

### U1: calendar events (G2)

| | |
| --- | --- |
| **Files** | `server/calendar/{service.ts, routes.ts, mcpTools.ts, calendarBin.ts}`, `src/calendar/{EventSheet.tsx, EventView.tsx, calendarApi.ts, calendar.css}`. |
| **Behaviour** | An Attachments section in the event view and sheet, using `AttachSheet` and `AttachmentList`. Editors attach, and the linker or calendar owner removes. Attachments sit on the series, not per occurrence. The event payload carries `attachment_count`, and the full list comes on open. ICS export has no `ATTACH` lines (D407). |
| **MCP** | `get_event` returns attachment names and ids, plus `attach_file_to_event` (`calendar:write`). |
| **Migration** | None (046 covers it). |
| **Tests** | `tests/calendarAttachments.test.ts`: link and unlink permissions by level (view reads, edit links); recurring event; event bin and restore; calendar purge leaves no links; ICS contains no URL. |
| **QA** | Create an event and attach a PDF and a photo (phone camera at 390 px). A shared viewer opens the preview. Unshare, and the content URL returns 404. Back closes the sheet and the preview. |

### U2: tasks, cards, and comments (G4, G5)

| | |
| --- | --- |
| **Files** | `src/tasks/{CardDialog.tsx, CardComposer.tsx, tasksApi.ts, taskActions.ts, tasks.css}`, `server/tasks/{attachments.ts, comments.ts, routes.ts, mcpTools.ts}`. |
| **Behaviour** | <br>• Drag-drop onto the whole card dialog attaches to the card. <br>• Paste or drop into the comment composer stages the files for the comment. <br>• The Attach buttons become `AttachSheet`: camera, choose, and From Files (D396, behind Q2). <br>• `linkAttachments` accepts owned Files items, plus Attachments-folder uploads with `?attachTo=card`. <br>• Files-only comments (D397). <br>• Adding files to your own comment while editing it (≤ 10). <br>• `AttachmentPreview` replaces `target=_blank`. |
| **MCP** | `comment_on_card` gains `attachmentIds` (≤ 10, the caller's own). `link_attachment` accepts Attachments-folder and owned Files documents. `get_card` returns ids as well as names. |
| **Migration** | None. |
| **Tests** | Extend `tests/tasksAttachments.test.ts`: files-only comment body; owned Files item link with T341 refusal for someone else's file; a comment edit adds files; caps. Client tests: the `taskActions` helpers. |
| **QA** | Paste a screenshot into a comment and post with no text. Drop three files on the dialog. Take a camera photo at 390 px, and confirm EXIF location is gone (check with an EXIF viewer). Back closes the sheet, then the card. |

### U3: collections (G7)

| | |
| --- | --- |
| **Files** | `src/collections/{Attachments.tsx, cells.tsx, CollectionCards.tsx, RowPanel.tsx, collectionsApi.ts, collections.css}`, `server/collections/{service.ts, mcpTools.ts}`. |
| **Behaviour** | `AttachSheet` in the row panel (camera, choose, From Files: the server already accepts it). Drop onto the row panel. Image thumbnails in the `file` cell (first image) and on the board-view card cover. New uploads use `?attachTo=row`. |
| **MCP** | `attach_file_to_row({rowId, field, documentId})` (`collections:write`) replaces the refusal at `mcpTools.ts:109`. Row reads return `{id, name}` for file fields. |
| **Migration** | None. |
| **Tests** | Extend `tests/collectionsAttachments.test.ts`: the MCP attach path, cap 20, undo with Attachments-folder documents. |
| **QA** | A receipts collection: photograph three receipts at 390 px, see the thumbnails in table and cards, and Back closes each sheet. |

### U4: notes (G1); U4b: whiteboards (G10, behind Q4)

| | |
| --- | --- |
| **Files** | `src/editor/{NoteEditor.tsx, imageUpload.ts, imageInsert.ts, extensions.ts, slash.ts, editor.css}` and a new `src/editor/fileChip.ts` (an atom node serialised as `[📎 name](/files/<uuid>)`). On the server: the publish path (`server/noteDrafts.ts` `publishDraft`, which both the route at `server/index.ts:798` and MCP `publish_note_draft` call) plus a new `server/attachments/noteLinks.ts` (Markdown → owned document ids, D408). *Coordination: `noteLinks.ts` is a new file under `server/attachments/`; U0 leaves a stub for it.* |
| **Behaviour** | <br>• Images and files picked, pasted, or dropped into a note upload with `?attachTo=note` into the Attachments folder (no longer the note's folder). <br>• Non-images insert a file chip. <br>• The slash menu gets "File" and "From Files". <br>• On publish, links are derived. <br>• Existing notes are backfilled lazily: links are derived on the next publish, and a boot reconcile (the D34 pattern) derives links for every published note **once**, linking only the owner's own documents. |
| **MCP** | `read_note` returns `attachments: [{id, name, mimeType}]`. `create_note` and `publish_note_draft` derive links. `read_attachment_text` with `hostKind: 'note'` works. |
| **Migration** | None (046). |
| **Tests** | `tests/noteAttachments.test.ts`: a direct recipient can open the image (the regression for G1); a draft grants nothing; an editor's own file is linked when that editor publishes; another person's file is not linked; unpublish, bin, and purge; the reconcile is idempotent. Editor unit tests for the chip's Markdown round trip. |
| **QA** | Share one note directly with a second user on a second origin: the images show. Attach a PDF chip and open it in the preview. Back closes the preview. |
| **U4b** | `server/whiteboards/service.ts` derives `host_kind='whiteboard'` links from the scene's `nookDocumentId`s that the owner owns, on save. `src/whiteboards/NookPickers.tsx` updates its hint text. The T165 row changes. It needs a `whiteboard` host predicate added to U0's registry (a small follow-up PR to U0's file, after U0 merges). |

### U5: chat composer (G3, G11)

| | |
| --- | --- |
| **Files** | `src/chat/{ChatApp.tsx, chatApi.ts, chat.css, KnowledgeSettings.tsx, AgentsSettings.tsx}`, `server/agents/{chats.ts, loop.ts, routes.ts, settings.ts}`, `shared/agents.ts`. |
| **Behaviour** | The paperclip opens `AttachSheet`; paste and drop work too; ≤ 5 per message. The user message stores links (`host_kind='chat_message'`). The run builds text blocks and, for vision-flagged models, `image_url` parts (D404). The disclosure line names the provider. Forks and copies (`forkChat`) copy **links** only when the forker owns the document. Public chat links show names only. The knowledge "Add source" picker gets an "Upload" button (into Files, then added). |
| **Vision flag** | It is stored in the existing agent or provider settings JSON if it has room; **if a column is needed, it takes 047** and U8 moves to a later id. |
| **MCP** | Agents API (`/api/v1/agents/*`): `attachmentIds` on run requests, owner-owned only. |
| **Tests** | `tests/chatAttachments.test.ts`: provider request body contains the text block and the image part only when flagged; size caps; shared chat reader access; public link denial; fork rules. |
| **QA** | Attach a CSV and ask for a summary, using a local mock provider through `AGENT_ALLOWED_PRIVATE_HOSTS` on the QA origin. Paste a screenshot into a vision model. Back closes the sheet at 390 px. |

### U6: Files app polish (G9)

| | |
| --- | --- |
| **Files** | `src/files/{FilesApp.tsx, uploadQueue.ts, filesApi.ts, files.css}`. |
| **Behaviour** | Paste to upload (a screenshot into the current folder). A "Take photo" item in the upload menu on phones. Optionally, folder upload (`webkitdirectory`), flattened into the current folder with name de-duplication. The Attachments folder sorts last and shows a size sort. |
| **Migration and server** | None. |
| **Tests** | `uploadQueue.test.ts` (paste source); a component test for the paste handler ignoring text. |
| **QA** | Paste a screenshot on desktop. Take a photo at 390 px. Back behaviour on the menu sheet. |

### U7: profile pictures (G8)

| | |
| --- | --- |
| **Files** | `server/avatars.ts` (a `PUT /api/me/avatar` multipart route ≤ 1 MiB, `sniffAvatar`, a new UUID per change, and `DELETE`), `src/settings/` account screen (the avatar editor: pick or camera, a square crop, and a 256 px resize on a canvas in the client), and `src/ui/selfAvatar.ts`. |
| **Rules** | Allowed for every role, including viewers and guests (a personal, non-content write; one `writeGate.ts` allowlist entry, the only shared-file touch, as a one-line PR). Google sync never overwrites an uploaded picture unless the user chooses that. |
| **S3** | It goes through the storage interface under an `avatars/` prefix if the S3 branch exposes one (coordinate). |
| **Migration** | None (`users.avatar_id` exists, 034). |
| **Tests** | `tests/avatarsUpload.test.ts`: SVG and GIF refused; the size cap; the old URL returns 404 after a change; a viewer is allowed; the write-gate test updated. |
| **QA** | Upload from the phone camera at 390 px. The picture appears in Team, comments, and settings. Back closes the crop sheet. |

### U8: legacy conversion (optional, after U2 and U3; 047, behind Q3)

Converts existing `task_attachment` and `collection_attachment` documents into Attachments-folder Files items. It keeps `card_attachments` and `collection_row_attachments`, simplifies `bin.ts` restore, and removes the `purpose` branches in `documentAccess.ts`, `documents.ts:703–707`, and the two sweepers (folded into U0's generic sweep). The tests are the existing attachment tests, unchanged in behaviour, plus a migration test with binned and live rows.

**Built (branch `uploads-u8`).** `server/migrations/047_legacy_attachments.ts`: creates each legacy uploader's Attachments folder in SQL (the `ensureSystemFolder` naming, "Attachments (Nook)" beside an ordinary root "Attachments" in any case), removes share rows and group grants on legacy documents (they granted nothing), then one `UPDATE documents SET purpose = 'file', sharing_override = 0, visibility = 'private', folder_id = <owner's Attachments folder>` over live, binned, and purging legacy rows. No rebuild; bytes, object keys, sizes, owners, timestamps, Bin state, and links unchanged; idempotent. Code: `?purpose=task_attachment|collection_attachment` (web) and MCP `purpose: "task_attachment"` now mean an Attachments upload; the `DELETE /api/files/:id` 409 `ATTACHMENT_LINKED` is gone (D409); the legacy branches in `tasks/attachments.ts`, `collections/service.ts`, `bin.ts` restore, `mcpFileTools.ts`, and `documentAccess.ts` (the sharing branches' `purpose` guard) are removed; the two legacy sweeps (`sweepUnlinkedAttachments`, `server/collections/sweep.ts`) are folded into U0's. The module rule "a fresh upload is on one card only" (`ATTACHMENT_LINKED` from card create and files-only comments) is U2's and stays. The Bin's `attachment*` fields stay in the API, always false/null. Tests: `tests/legacyAttachmentsMigration.test.ts` (v0.34.0 database; before/after read and Files-list matrices per person) plus the updated attachment suites.

### Parallel safety

| Shared file | Owner | Others |
| --- | --- | --- |
| `server/documentAccess.ts`, `server/documents.ts`, `server/bin.ts`, `server/sweeper.ts`, `server/attachments/hosts.ts` | U0 (U8 later) | Read only |
| `server/mcpTools.ts` tool list | U0 adds the attachment group | Module slices edit only their own `mcpTools.ts` |
| `server/team/writeGate.ts` | U7 (one line) | |
| `src/ui/attachments/*` | U0 | Import only. Bugs go back to U0's owner. |

---

## 7. Test plan rows (TEST_PLAN)

1. **T340 matrix**, generated from the registry: every host × every principal × session, key, and MCP gives 200 or 404 on `/api/files/:id`, `/content`, `list_attachments`, and `read_attachment_text`.
2. **Lifecycle:** unlink, comment delete, host bin, restore, and purge, plus the 24 h sweep, only touch Attachments-folder documents.
3. **System folder:** every folder and document mutation route refuses `SYSTEM_FOLDER`, except moving a file out.
4. **Public surfaces:** ICS, public chat, and mail templates never contain `/api/files/`.
5. **EXIF:** stripped on camera uploads; byte-identical for PNG.
6. **History:** at 390 px, for each host, Attach → sheet → Back closes the sheet, Back again leaves the host, and Forward returns to the host with the sheet closed.
7. **Quota:** an attachment counts once against the uploader, whatever the number of links.

---

## 8. Open questions for the operator (defaults in bold)

| # | Question | Recommended default |
| --- | --- | --- |
| Q1 | Should new attachments be **visible in Files** (an "Attachments" system folder, D390–D392), or hidden like today's task and row attachments? Hidden needs a `documents` rebuild, which the transactional, FK-on runner cannot do safely. | **Visible**, in one "Attachments" folder (consistent with Messages M-O7). |
| Q2 | May people attach **their own existing Files items** to cards (relaxing D179), with a confirmation that the host's audience will be able to open it? | **Yes, owner only, with the confirmation** (Collections already allows it). |
| Q3 | Convert existing hidden task and row attachments into the Attachments folder (U8, 047)? | **Yes, after U2 and U3 ship**, so there is one model. Skip it if the operator wants zero data change this cycle. |
| Q4 | Should **whiteboard pictures follow board sharing** like notes (changing T165), for pictures the board owner owns? | **Yes, as U4b**, after U4 proves the derived-link pattern. |
| Q5 | Phase-2 thumbnails (client-generated WebP, `document_thumbnails`, 047)? | **Later.** Phase 1 uses lazy originals ≤ 8 MiB, and thumbnails follow if phones feel slow. |
| Q6 | Should Messages share the one "Attachments" folder or keep its own "Message uploads"? | **Share "Attachments"**, with `host_kind='message'` links. |
| Q7 | Add a virus-scan hook (for example, an optional ClamAV `clamd` socket set by `AV_SOCKET`) on upload? | **No for now.** Downloads are `attachment` and `nosniff`. Revisit if Nook is used with outside guests. |
| Q8 | Vault file secrets (certificates, keys) as an encrypted `file` item type ≤ 64 KiB? | **Defer.** It needs a vault migration and crypto review. A `note` item holding PEM text covers most cases. |
| Q9 | Strip photo location (EXIF) from every JPEG attachment, not only camera shots? | **Yes, on by default,** with a per-user setting to keep it. |
| Q10 | Chat: allow images only for vision-flagged models, and refuse PDFs until a text extractor exists? | **Yes.** PDF text extraction would need a dependency (D20) and gets its own decision. |
| Q11 | Per-host caps: events 20, notes 100, chat 5 per message? | **Yes.** |
| Q12 | Should files-only comments get a generated body (`📎 name`), or should we wait for a `card_comments` rebuild? | **Generated body** (D397). |

---

## 9. Decision log

**Operator decisions, 2026-10-09 (binding).**

| # | Decision | Effect on this plan |
| --- | --- | --- |
| Q1 | **Visible.** Every attachment is a normal Files document in a per-person "Attachments" system folder (`folders.system_kind = 'attachments'`), visible in Files and counted toward the quota. | D390–D392 as written. |
| Q2 | **Yes.** People may attach a file they **own** from Files to cards, events, rows, and notes, after a short confirm in the app's dialog (D91). | D396. **Relaxes D179** (`docs/plan/WAVES_18-20_SMALL.md`, annotated); U2 changes `link_attachment`. The server enforces the confirm: a Files item outside the Attachments folder needs `confirmed: true` (409 `CONFIRM_REQUIRED` otherwise). |
| Q4 | **Yes.** Whiteboard pictures follow board sharing. | **Changes T165** (THREAT_MODEL annotated). The `whiteboard` host and its access rule are in the U0 registry (§10); U4b derives the links on save and updates the picker hint. |
| Q10 | Chat composer: images go only to models an admin marks vision-capable; PDFs and other files are refused for now; up to 5 per message. | U5. The `chat_message` host cap is 5 in U0. |
| Q3 | Default accepted: convert hidden task and row attachments later, in U8, with migration 047. | U8. |
| Q5 | Default accepted: thumbnails generated in the browser, later. | Phase 2 (047 candidate (a)). U0's list draws originals ≤ 8 MiB. |
| Q6 | Default accepted: Messages shares the Attachments folder. | Messages uses `host_kind = 'message'`; it registers in hosts.ts. |
| Q7 | Default accepted: no virus-scan hook. | T352 accepted. |
| Q8 | Default accepted: vault file secrets deferred. | — |
| Q9 | Default accepted: strip location (EXIF GPS) from every JPEG upload by default. | D401 as built: the kit rewrites every JPEG it uploads (not only camera shots) unless the caller passes `keepLocation`. A per-person "keep location" setting is not built (no UI asked for it in U0). The server never rewrites bytes (an upload's SHA-256 must match), so MCP, REST, and Files-app uploads keep their metadata; USING and OPERATIONS say so. |
| Q11 | Default accepted: caps of 20 per event, 100 per note, 5 per chat message. | Registry caps (cards 50/10 and rows 20 unchanged). |
| Q12 | Default accepted: a generated body for files-only comments. | D397, U2. |

**U0 build notes (2026-10-09), where the build differs from or adds to §4–§6:**

- **System-folder guards in 046.** Besides the designed objects, 046 adds triggers that refuse folder shares, folder group grants, a non-private visibility, renames, moves, subfolders, notes, and whiteboards in a system folder, and any change of `system_kind` after creation. The routes refuse first with 400 `SYSTEM_FOLDER`; the triggers hold the rule for every other path (the app's error handler and MCP map them to the same answer). 046 also adds `whiteboards_attachment_links_ad` for U4b.
- **`GET /api/folders` hides system folders** unless `?include=system` (Files asks for it). Notes, Whiteboards, Routines, and the key pickers therefore need no change. MCP `list_folders` lists it with `system_kind`.
- **Restore.** A binned Attachments-folder file comes back to the Attachments folder while something links it, and otherwise to Default as an ordinary file, so the orphan sweep never bins it again (§4.4 said "into the Attachments folder" unconditionally).
- **Derived links never bin.** `syncDerivedLinks` removes links that are no longer referenced but does not bin the file (an older note version may still show it); the hourly orphan sweep handles files nothing links.
- **Generic MCP tools** are declared `list` mode over the host containers with `listsNeedReach`, so a key whose chosen items hold no host container (only knowledge bases) is not offered them; each call checks the host module's scope and the key's grant on the host. They are classified "never" for agents in chats (`NOOK_NEVER_TOOLS`) until the bridge maps a multi-module tool to the module of the item it is called on.
- **Chat messages** are readable by someone the chat is shared with only when the message is on the branch on screen (a bounded recursive walk from `active_leaf_id`, review L5).
- **Not built in U0:** the "keep photo location" per-person setting (Q9 says "by default"; the kit has the switch); `useLeaveGuard` wiring is the host slice's (the kit exposes abort signals).

---

## 10. U0 as built: the APIs for U1–U7

Branch `uploads-u0`. Slices **call** these and never edit them; a bug or a missing hook goes back to U0's owner (§6 "Parallel safety").

### Server (`server/attachments/`)

| File | What it gives slices |
| --- | --- |
| `hosts.ts` | `HOST_KINDS` (`event`, `note`, `chat_message`, `whiteboard`, `card`, `row`), `HOSTS[kind]` (`noun`, `store`, `linking: "declared" \| "derived" \| "module"`, `readScope`, `itemKind`, `caps`, `hasParts`, `readableSql`, `ownerOf`, `title`, `canLink`, `canUnlink`), `isHostKind`. The access rule of every host lives here (T340); `attachmentLinkReadBranch` is the one branch `documentAccess.ts` adds. |
| `service.ts` | `ensureSystemFolder(userId)` → folder id; `attachmentsFolderOf(userId)`; `isSystemFolder(folderId)`, `refuseSystemFolder(folderId)` (throws 400 `SYSTEM_FOLDER`), `SYSTEM_FOLDER_BODY`; `hostReadable(kind, hostId, userId)`; `hostLinks(kind, hostId)`; `listAttachments(kind, hostId, userId)` → `AttachmentView[]` (404 `AttachmentError` when unreadable); `readableAttachment(kind, hostId, documentId, userId)` → `DocumentRow \| null`; `linkAttachment(userId, kind, hostId, { documentId, partId?, confirmed? })` (declared hosts); `unlinkAttachment(userId, kind, hostId, documentId)` → `{ documentBinned }`; `syncDerivedLinks(kind, hostId, actorId, documentIds)` → `{ linked, unlinked, skipped }` (notes, whiteboards; call inside the host's own lock); `binIfOrphanedAttachment(documentId)` (call inside your transaction after removing a link, e.g. a comment or host delete); `documentLinkCount(documentId)`; `documentUsage(documentId, ownerId)`; `AttachmentError` (`status`, `code`, `body`). |
| `routes.ts` | `GET/POST /api/attachments/:hostKind/:hostId`, `DELETE /api/attachments/:hostKind/:hostId/:documentId`, `GET /api/files/:id/usage` (API_CONTRACTS § Attachments everywhere). |
| `sweep.ts` | Hourly: stale links and never-linked Attachments-folder files older than a day. Nothing for slices to call. |
| `mcpTools.ts` | `list_attachments`, `read_attachment_text`. Slices add their attach tools (`attach_file_to_event`, `attach_file_to_row`, U2's `link_attachment`) in their own `mcpTools.ts`, taking a `documentId` from `create_text_file` / `begin_upload` with `purpose: "attachment"`, and calling `linkAttachment` (or their module's link function for cards and rows). |
| `noteLinks.ts` | `referencedDocumentIds(markdown)` (`/api/files/<id>/content` images and `/files/<id>` chips). U4 calls `syncDerivedLinks("note", noteId, publisherId, referencedDocumentIds(published))` from `publishDraft`. |

Uploads: `POST /api/files?attachTo=<kind>` (web) or `purpose: "attachment"` (MCP) put the file in the uploader's Attachments folder as `purpose = 'file'`. Cards and rows keep `card_attachments` and `collection_row_attachments`; U2 and U3 extend their own link paths to accept the caller's own Attachments-folder and (confirmed) Files documents, and should call `binIfOrphanedAttachment` where they bin legacy attachments today.

Per slice: **U1** wires events through the generic routes (declared host; editors link, the linker, file owner, or calendar owner/manager unlinks). **U4** wires `noteLinks.ts` into publish plus the boot reconcile. **U4b** calls `syncDerivedLinks("whiteboard", boardId, boardOwnerId, ids)` on save, with the board's owner as the actor (L4). **U5** links user messages through `linkAttachment(userId, "chat_message", messageId, …)` at send time (cap 5). Messages registers `message` in hosts.ts (a reviewed change to U0's file).

### Client (`src/ui/attachments/`, import from `src/ui/attachments/index.ts`)

| Export | Use |
| --- | --- |
| `<AttachSheet hostNoun onClose onFiles onPickDocument? accept? multiple? camera? disabledReason? closeOnPick? children?>` | The one attach sheet: **Take photo** (`accept="image/*" capture="environment"`, shown on `(pointer: coarse)` unless `camera` says otherwise), **Choose files**, **From Files** (only when `onPickDocument` is given: the caller's own files; outside the Attachments folder it asks the D91 confirm first and hands back `{ confirmed: true }`). A bottom sheet at ≤ 760 px, one history layer (Back closes it; the picker and its confirm are layers above it). Put progress rows in `children`. |
| `<AttachmentList items onOpen? onRemove? canRemove? label?>` | Thumbnails (originals ≤ 8 MiB, PNG/JPEG/GIF/WebP), name, size, Download, Remove; "File removed" rows. |
| `<AttachmentPreview documentId name onClose>` | The Files preview stage in a guarded sheet (Back closes it), with Download. |
| `useFileDrop(onFiles, { enabled })` → `{ dragging, bind }` | Desktop drag-drop of system files onto a host. |
| `usePasteFiles(ref, onFiles, { enabled })`, `pastedFiles(clipboardData)` | Paste with the editor's rule: rich text stays text. |
| `uploadForHost(file, kind, { onProgress, signal, idempotencyKey, keepLocation })` | XHR upload to `?attachTo=` with progress and abort; strips JPEG location first (Q9). |
| `listHostAttachments`, `linkToHost(kind, hostId, documentId, { partId, confirmed })`, `unlinkFromHost`, `fileUsage`, `usageSummary` | The generic routes. |
| `stripImageLocation(file)`, `stripJpegMetadata(bytes)` | The EXIF rewrite, if a slice uploads some other way. |

History: the sheet, the From Files picker, its confirm, and the preview are history layers (`useHistoryDialogGuard`), so Back closes the innermost first and Forward reopens nothing. They rely on the host app's `popstate` listener calling `popStateClosedDialog(event)` first, as every Nook app already does. U0's live QA drove the kit from a QA-only harness page (not shipped) at 1280 and 390 px.

Files (`src/files/`): the Attachments folder shows with a lock, is never a move or drop target, takes no direct uploads, and the delete confirm names the uses (D409).

### Review fixes (2026-10-09, after the independent U0 review; slices branched from 79241a3 merge these)

API changes, all additive except where marked:

| Item | Change | What slices do |
| --- | --- | --- |
| M1 | `unlinkAttachment(userId, kind, hostId, documentId)` and `DELETE /api/attachments/…`: **the file's owner may always withdraw it**, from every host kind (cards and rows included, straight from `card_attachments` / `collection_row_attachments`), whatever their access to the host now. The owner path is checked first; when the owner cannot read the host the result is `{}` (the route answers `{ ok: true }`). Return type is now `{ documentBinned?: boolean }`. The role write gate allows this one DELETE for viewers and guests; the service then allows only the owner path. Non-owners are unchanged. | U2/U3: your own detach routes may keep their rules for non-owners; the generic route already covers owners. Clients: `unlinkFromHost` may return no `documentBinned`. |
| M1 | `documentUsage` / `GET /api/files/:id/usage` gain `hidden: Array<{ hostKind, hostId }>` (registered hosts the owner cannot open, by id only). Files' delete confirm offers "Remove from places you can't open" (`src/files/DeleteFileDialog.tsx`). | U6: keep the dialog. |
| M2 | `stripImageLocation` now also strips PNG `eXIf`/XMP and WebP `EXIF`/`XMP `, drops everything after a JPEG's primary EOI (MPF images, motion-photo MP4), skips stray bytes, caps at `STRIP_MAX_BYTES` (64 MiB; larger files pass unchanged), and for an unwalkable JPEG that still holds EXIF/XMP re-encodes through a canvas or **throws `LocationStripError`** (so `uploadForHost` rejects with a readable message). HEIC is not stripped. New exports: `stripPngMetadata`, `stripWebpMetadata`, `LocationStripError`, `STRIP_MAX_BYTES`. | Show the rejection message like any upload error; `keepLocation` bypasses. |
| M3 | The orphan sweep keeps Attachments-folder files that **any note draft, any stored published version (live or binned notes), any whiteboard scene or snapshot**, or a registered checker references (`server/attachments/references.ts`: built-in `noteReferences` and `whiteboardReferences`, plus `registerAttachmentReferenceChecker(name, checker)`). A failing checker keeps everything. `sweepOrphanedAttachments` and `sweepAttachments` are now **async** (changed). | **U4 needs nothing for the sweep.** Messages or other content kinds register a checker. |
| M3 | `syncDerivedLinks` returns `binned: string[]` too: the actor's own referenced files that are in their Bin (also listed in `skipped`). | **U4:** show those as broken images or chips with a Restore action (`POST /api/bin/document/:id/restore`); the next publish links them. |
| L1 | The system folder is named "Attachments (Nook)" when the person already has an ordinary root folder named "Attachments" (any case). | Never match the folder by name; use `system_kind`. |
| L2 | MCP `purpose: "attachment"` says it is only useful with a module tool that attaches files over MCP. | U1/U2/U3: name your attach tool in that description when it ships. |
| L3 | Boot self-check: the sweeper's boot run logs `Attachment self-check: migration 046 triggers are missing (…)` when any of `ATTACHMENT_TRIGGERS` is gone (the grant self-check's pattern: loud, not fatal). | — |
| L4 | **U4b:** call `syncDerivedLinks("whiteboard", boardId, boardOwnerId, ids)` with the **board's owner** as the actor (not the saving editor), so only the owner's pictures ever follow board sharing (Q4). | U4b. |

### U4 and U4b as built (branch `uploads-u4`)

- **Notes.** `publishDraft` calls `syncNoteLinks` (`server/noteAttachments.ts`) in its transaction; the response adds `skippedAttachments` and `binnedAttachments`. Files are `[📎 name](/files/<uuid>)` cards (`src/editor/fileChip.tsx`), images stay `![alt](/api/files/<uuid>/content…)`. The editor takes any file (`attachHost="note"`): the attach sheet (`/file`), From Files (`/from files`), paste, drop; uploads use `?attachTo=note`; cards open `AttachmentPreview`. Card descriptions keep their own image upload (no `attachHost`).
- **Existing notes:** backfilled once at boot (owner's own documents, `attachment.backfill` audit marker), not lazily, so G1 is fixed for every existing note without a republish. Later publishes keep links in step.
- **Binned own files (M3):** after a publish the app offers Restore; `POST /api/notes/:id/attachments/sync` then re-derives the links (caller's own files) without a new version.
- **Whiteboards:** `saveScene` and `createWhiteboard` derive links with the board owner as actor (L4); boards backfilled once at boot; canvas uploads use `?attachTo=whiteboard`; the Insert image picker has Take photo on touch devices and the new hint.
- **MCP:** `read_note` and `read_whiteboard` return `attachments`; `publish_note_draft` returns `skippedAttachments` / `binnedAttachments`.

### v0.35.0 security review fixes (branch `v035-fixes`)

The principle: a person's file becomes readable through a note or a whiteboard only when that person put it there or explicitly confirmed it; an editor never grants other people's files (T350); a key never widens a file's reach beyond what its grants cover (T354).

- **M1, publish.** Derived links take a policy (`LinkPolicy` in `server/attachments/service.ts`). A person publishing links their own Attachments-folder files silently; any other of their Files items that would become newly linked answers 409 `CONFIRM_REQUIRED` `{ files, audience }` and publishes nothing, until the publish lists the ids in `confirmAttachments` (the app asks with `useConfirm`; ids confirmed in the From Files picker for that note are sent up front; leaving a note never asks, it stays a draft). An approved `note_draft` proposal is the owner's publish and asks the same way (it stays pending; bulk approval leaves it pending). Already-linked files stay.
- **M1, boot backfill rule.** Pre-0.35 pasted note images were ordinary Files uploads (`purpose = 'file'`, in the note's folder or Default, an Idempotency-Key like any upload, a plain `document.upload` audit row): nothing marks them as note uploads. So the backfill links, for the note owner's documents its current version references, only (a) files in the owner's Attachments folder, or (b) other files whose **first referencing stored version was authored by the owner** (`note_versions.author_id`, NOT NULL since 001). A reference an editor introduced is withheld (the owner's next publish asks); an unreadable older version withholds what it might have introduced.
- **M1, whiteboards.** The board owner stays the actor. The owner's own save links every picture of theirs (only the owner saves, so they placed each one); any other saver links nothing new (a guard); a copy of someone else's board links only the copier's Attachments-folder pictures; a key follows M2. Import keeps the owner policy.
- **M2, keys.** `server/attachments/keyLinks.ts`: a key links or derives only an Attachments-folder file not already linked to a host outside its reach (`keyReachesHost`: the host module's read scope and grant, and the owner can open it), unless its `files:read` covers the file; never a confirm, the rest is `skippedAttachments`. Used by `publish_note_draft`, `create_whiteboard`, `attach_file_to_event`, `link_attachment`, `comment_on_card` attachmentIds; `attach_file_to_row` keeps its stricter "nothing outside this collection" through the same `linkedElsewhere` helper. `list_attachments`, `read_attachment_text`, and `read_note` show the owner's own files on the same terms.
- **L1.** A binned Attachments-folder file restores to Attachments, linked or not (never Default); the restore sets `updated_at`, so the 24 h sweep grace covers it. `restore_folder_name` follows.
- **L2.** Migration 048 (`content_reference_sources`, `content_references`): writers record the UUIDs their content mentions (draft saves, version restore to draft, publishes, board saves); the sweep runs only when an unlinked candidate exists, reads only sources the index has not seen, drops gone sources, then selects candidates with the index in SQL and re-checks each in the bin transaction (row `updated_at` unchanged, no reference recorded). Measured with 150 notes × 3 versions and 30 boards, S3 storage, three sweeps with one candidate each: before 450 note reads plus 30 S3 GETs per run (~150 ms); after 0 reads (2–8 ms). After the upgrade the first sweep with a candidate reads everything once.
