# Whiteboard module: canvases stored as Files documents

**Status:** research and plan, 2026-09-28. Nothing here is built yet. This is the "next in line" backlog item from [2026-09-25-new-modules.md](2026-09-25-new-modules.md): the row there said `.excalidraw` JSON stored as a Files document, lazy-loaded, Excalidraw (MIT) only because tldraw is not open source, no real-time collaboration, and weak on phones.

**Numbering.** Other plans are being written in parallel and will also continue the numbering, so this plan takes its own blocks: decisions **D191–D210**, threats **T160–T172**, and migration **`023_whiteboards`** (018, 021, and 022 belong to the parallel plans). Whoever merges the plans renumbers if the blocks collide. The two waves are called **WB-A** and **WB-B** until the director gives them wave numbers.

**Rules this plan follows** (from DEVELOPMENT_PLAN.md and the operator's standing rules): mobile first, with Back/Forward parity at 390 px (D21, historyDialogs D18); custom dropdowns only (D91); a Modules row (D92); MCP tools for every module (D70 scope pairs); append-only migrations; UUID-only object storage (D4); no inline rendering of SVG or HTML (D6, D7); a strict sandboxed CSP on served content (§7.2); one owner, recipients read (D2); 404 for anything missing or forbidden; no new runtime dependency without a strong case (D20).

---

## 1. Summary of the recommendation

1. **Embed Excalidraw** (`@excalidraw/excalidraw`, MIT, exact-pinned) as a **lazily loaded route chunk**. This is option (a). It is the one deliberate new runtime dependency, and it has to pass a **spike gate (§4)** before any feature code lands. If it fails the gate, fall back to option (b), the in-house canvas (§3.2), which is already scoped.
2. **A whiteboard is a Files document**: `purpose = 'file'`, MIME `application/vnd.excalidraw+json`, name ending in `.excalidraw`, `preview_kind = 'none'`. A `whiteboards` side row holds the revision, the current object id, counts, and the thumbnail. Sharing, move, rename, delete, the Bin, and quota all come from Files unchanged. No table rebuild is needed for the `purpose` CHECK.
3. **Scene bytes change through a copy-on-write object per save**, under the note-style **revision CAS**. There is no draft or publish step: autosave is the saved state. The owner edits. Recipients get Excalidraw's view mode.
4. **The server validates every scene** against a bounded allowlist schema (§7). It never renders anything. Thumbnails are PNGs the client generates, capped at 128 KiB and kept in the database. PNG and SVG export happen in the client, and the SVG is a download only.
5. **History parity:** opening a board pushes `/whiteboards/:id`. Back leaves the canvas after flushing the save. Undo and redo never touch browser history. Nook sheets and Excalidraw's own menus close on Back first.
6. **MCP:** `whiteboards:read` (list, and read text and elements as bounded JSON) and `whiteboards:write`, which only creates an empty board.
7. **Two waves:** WB-A covers storage, the API, list, canvas, sharing, the Bin, Today, the module, MCP, and search indexing. WB-B covers images from Files, links from shapes, the embed-in-note card, snapshots, duplicate and import, SVG export, and the search facet.

---

## 2. What the market does (UX reference)

| Product | Model | What we borrow | What we avoid |
| --- | --- | --- | --- |
| **Excalidraw** [1][2] | Hand-drawn look. One scene JSON (`type: "excalidraw"`, `elements[]`, `appState`, `files{}`). Local-first, with optional collaboration. | The component itself, the `.excalidraw` file format (opens on excalidraw.com and in the Obsidian Excalidraw plugin), view mode for readers, and its phone layout (bottom toolbar). | The CDN font loading, the library browser, collaboration, and embeddables (iframes). |
| **tldraw** [3] | Polished SDK. **Not open source.** Production use needs a licence key: Trial is 100 days and pings tldraw's servers, Hobby is non-commercial and shows a "made with tldraw" watermark, Commercial is priced by quote. | Nothing. Its UX (sticky notes, arrows that snap to shapes) is only a reference. | The dependency, on licence grounds. |
| **Obsidian Canvas / JSON Canvas 1.0** [4][5] | An open spec (MIT). `nodes[]` of type `text` (Markdown), `file`, `link`, and `group`; `edges[]` with `fromNode`, `toNode`, sides, ends, and labels; colours are hex or presets 1–6. | Its node types map neatly onto Nook: text becomes a sticky, file becomes a Nook file or note, link stays a link. This is the target if we build in-house, or for a later export. | Its lack of shapes and freehand: a pure JSON Canvas board is a cards-and-arrows board, not a sketching tool. |
| **draw.io / diagrams.net embed** [6] | An iframe to `embed.diagrams.net` talking over `postMessage`. Self-hosting means a separate large static app. | Nothing. | A third-party iframe breaks `frame-src 'self'`, offline use, and our privacy posture. Self-hosting doubles the surface. |
| **Miro / FigJam** | Infinite canvas, sticky notes, stamps, templates, cursors. | The list idiom (thumbnail grid, recently edited), stickies as the main object, a left tool rail on desktop, a bottom sheet on phones. | Real-time cursors and presence, which are out of scope (D209). |

---

## 3. Options and the dependency decision

### 3.1 Option (a): embed Excalidraw (recommended, gated)

**Licence and size findings** (verified 2026-09-28):

| Fact | Value | Source |
| --- | --- | --- |
| Latest version | **0.18.1** (0.18.0 released 2025-03-11) | npm registry [7], release notes [8] |
| Licence | **MIT** | npm registry [7], repo LICENSE [1] |
| Peer dependencies | react and react-dom `^17 \|\| ^18 \|\| ^19`. **React 19 is supported.** | npm registry [7] |
| Bundled runtime dependencies | 31 (bundled into the package's ESM build), including jotai, roughjs, perfect-freehand, pako, pica, radix popover/tabs, @braintree/sanitize-url, and **@excalidraw/mermaid-to-excalidraw**, which pulls in mermaid (about 1 MB), elkjs (1.45 MB), and cytoscape | npm registry [7], Bundlephobia [9] |
| Main bundle | **1.12 MB minified, about 353 KB gzip**. Mermaid and locale chunks are loaded lazily. | Bundlephobia [9] |
| Font-subsetting chunks (SVG export only) | About **750 KB gzip**, lazily loaded. They use **WebAssembly** (harfbuzzjs and a woff2 codec). | PR #8384 [10] |
| Unpacked package | 46.8 MB and 1,029 files (dev and prod builds plus fonts). This is a disk cost, not a download cost. | npm registry [7] |
| Fonts | Loaded **from the esm.run CDN by default**. To self-host, copy `dist/prod/fonts` and set `window.EXCALIDRAW_ASSET_PATH`. | release notes [8], install docs [11] |
| Telemetry | The excalidraw.com **app** loads Simple Analytics (`VITE_APP_ENABLE_TRACKING`). Nothing in the package docs says the component phones home. **To be confirmed in the spike** with a network capture. | issue #8280 [12], install docs [11] |
| CSP | Needs `style-src 'unsafe-inline'`, which Nook already allows. Any WebAssembly needs `'wasm-unsafe-eval'`, which Nook **does not** allow and will not add. | issue #7657 [13], MDN script-src [14] |
| UI options | `UIOptions.canvasActions.{loadScene, saveToActiveFile, export, saveAsImage, clearCanvas, toggleTheme, changeViewBackgroundColor}` and `UIOptions.tools.image` | docs [15] |
| Export API | `exportToBlob` (canvas `toBlob`, PNG, no WebAssembly) and `exportToSvg`. No option to skip font inlining is documented. | docs [16] |

**For Excalidraw:**
- A mature editor: touch, pen, pinch zoom, a phone layout, arrows that bind to shapes, text in containers, frames, undo and redo, and PNG and SVG export.
- The native `.excalidraw` format is interoperable.
- It works offline, and there is no licence key.
- The effort is **M** instead of **L+**.

**Against Excalidraw:**
- The chunk is heavy. Measured in the spike, the budget is about 450 KB gzip JS for the first canvas load, excluding fonts.
- The package bundles a big dependency tree, which is a supply-chain surface.
- Its UI is not Nook's: Excalidraw's own popovers are not D91 components.
- SVG export may need WebAssembly (T163).
- Upstream releases are infrequent (0.18.1 is still the latest).
- The toolbar sits along the top on desktop and cannot be moved to a left rail without fragile CSS.

**The strong case (D20 bar):** the alternative is months of in-house work on hit-testing, text editing on a canvas, arrow binding, touch gestures, and export, which the operator's plan does not budget. The chunk only loads on `/whiteboards/:id`, so nobody who never opens a board pays for it.

### 3.2 Option (b): an in-house canvas (fallback, fully scoped)

- **Scope:** stickies (Markdown text), rectangles, ellipses, arrows and connectors bound to node sides, text, freehand, and Nook cards (note, file, task, board) as nodes. It would be an SVG render layer for up to about 2,000 nodes. The **JSON Canvas 1.0** format would get a `nook` extension object (`shape`, `points` for freehand, `ref` for Nook items).
- **Cost:** about 3,500–4,500 lines across the canvas, gestures, selection, text editing, undo stack, and export, plus perhaps `perfect-freehand` (MIT, a few KB) for ink. The chunk is about 40–60 KB gzip. That is **L**, three waves to reach Excalidraw's parity on the basics.
- **Gains:** Nook styling, D91 menus, Markdown stickies, native Nook cards, no CSP questions, and a small chunk.
- **Losses:** time, polish on phones, and interoperability with Excalidraw files (though JSON Canvas opens in Obsidian).

### 3.3 Option (c): a JSON Canvas renderer with an Excalidraw editor (rejected)

This means two formats, a lossy conversion on every save (Excalidraw shapes have no JSON Canvas equivalent), and two renderers to secure. **Rejected.** A one-way **JSON Canvas export** stays open as a later option (Q7).

### 3.4 Decision

**D191: option (a), gated by the spike in §4. If the gate fails, switch to option (b) and do not weaken the CSP.**

---

## 4. Spike gate S0 (first commit of WB-A, throwaway branch until it passes)

Add the exact-pinned `@excalidraw/excalidraw@0.18.1` and render it on a hidden dev route in the built app, served by the production server with the production CSP. Record every number below in the commit body.

| # | Criterion | Pass |
| --- | --- | --- |
| G1 | Network capture: open, draw, add text, export PNG, try SVG export, open help and the library | **Zero requests to anything but the app origin**. The fonts come from `/excalidraw/fonts/…`. |
| G2 | CSP console | **No CSP violations** on draw, text, or PNG export. SVG export either works or fails cleanly, with no hang, and the result decides D201. |
| G3 | Size | The first-load route chunk is **≤ 500 KB gzip** of JS (Excalidraw plus Nook glue). `dist/` grows by **≤ 25 MB** including fonts. The main app chunk grows by **< 5 KB**, which proves the route is lazy. |
| G4 | Phone (390×844, touch emulation, and a real phone if available) | Pinch zoom and two-finger pan act on the canvas, not the page. Drawing does not scroll the page. The bottom toolbar is usable. Browser Back leaves the route. |
| G5 | Build and toolchain | TypeScript 7 with `moduleResolution: "bundler"` builds. Vite 8 builds with `target es2022` (the 0.18 note). `docker build --target verify` is green. |
| G6 | Eval | No `unsafe-eval` violation anywhere, including the mermaid "text to diagram" dialog. If mermaid violates, hide that dialog (Q5). |

The spike also measures the CJK font set (Xiaolai). If it pushes G3 over the limit, leave it out and let the system CJK fallback render in the browser (Q6).

---

## 5. Decisions (D191–D210)

| # | Decision | Rationale |
| --- | --- | --- |
| D191 | **Excalidraw 0.18.1, exact-pinned**, loaded by `React.lazy(() => import("./whiteboards/WhiteboardCanvas"))`. This is the first lazy route chunk in the app. Every upgrade is its own `chore:` commit that re-runs S0 G1–G3 and the validator fixture tests (§12). | §3. Nobody who never opens a board downloads it. |
| D192 | **A whiteboard is a Files document**: `documents.purpose = 'file'`, `mime_type = 'application/vnd.excalidraw+json'` (Excalidraw's own MIME), `preview_kind = 'none'`, and a `name` that ends in `.excalidraw` (the UI hides the suffix). A `whiteboards` row (023) marks the kind. The upload sniffer never produces that MIME, so the only way to create a whiteboard is `POST /api/whiteboards`. | "Stored as files" is the brief. It reuses the ACL, folders, sharing, the Bin, quota, and Files listing unchanged. Keeping `purpose = 'file'` avoids rebuilding the `documents` table to extend its `purpose` CHECK, since SQLite cannot alter a CHECK. |
| D193 | **Copy-on-write scene objects.** Each save writes a new `documents/objects/<object-uuid>` through staging, `fsync`, and `rename`, then points `whiteboards.object_id` at it and mirrors `size_bytes` and `sha256` onto the documents row in one transaction. The old object is unlinked after the commit, unless it becomes a snapshot (D207). A plain uploaded file stays immutable (§14 is unchanged for it). | Readers never see a half-written file. The content route's ETag (`sha256`) changes by itself. Object names stay UUID-only (D4). |
| D194 | **No draft or publish step.** Autosave (debounced 1.5 s after the last change, and flushed on route leave and on `visibilitychange: hidden`) writes the scene with `PUT …/scene { baseRevision }`. A stale base gets 409 `REVISION_CONFLICT`, and the client offers **Reload theirs** or **Save mine as a copy**. Saving an identical scene (same sha256) is a 200 no-op. | Whiteboard users expect "always saved". The CAS mirrors notes (`draft_revision`). Only the owner writes, so conflicts only happen between the owner's own devices or tabs. |
| D195 | **Only the owner edits.** Recipients open the board with `viewModeEnabled` and see "View only · Owned by <name>". WB-B adds **Duplicate to my whiteboards** for them. | D2 parity. Collaborative writes stay out of scope (§14). |
| D196 | **Rename, move, share, and delete use the existing `/api/files/:id` endpoints** (PATCH, PUT sharing, DELETE). The whiteboard UI calls `filesApi`. Restoring and purging go through `/api/bin/document/:id`. There is no whiteboard-specific ACL. | One ACL (D3). Parity tests stay valid. |
| D197 | **Bounded server-side validation** of every scene write and import (§7), with zod (already a dependency). Validation strips deleted elements, allowlists element types and `appState` keys, bounds every string, number, array, and nesting depth, and rejects `files[*].dataURL`. The canonical JSON is what gets stored. | Stored scenes are untrusted input to every viewer's renderer, and to MCP clients (T160, T161). |
| D198 | **Images are references to Files documents only.** A scene's `files` map holds `{ id, mimeType, nookDocumentId }` with no `dataURL`. The client fetches `/api/files/:id/content?disposition=inline` (image allowlist only) **as the viewer** and hands Excalidraw a `data:` URL in memory. In WB-A the image tool is hidden (`UIOptions.tools.image = false`). | No base64 bloat, and quota stays honest. The board's ACL never widens access to an image (T165). |
| D199 | **Links:** `element.link` may be `https:`, `http:`, `mailto:`, or a Nook path (`/notes/<uuid>`, `/files/<uuid>`, `/tasks/<board>/card/<card>`, `/collections/…`, `/whiteboards/<uuid>`), at most 2,048 characters. `onLinkOpen` routes Nook paths through `src/router.ts` and opens external links with `noopener,noreferrer`. **Nothing is fetched or unfurled.** Element types `embeddable` and `iframe` are rejected, and `validateEmbeddable={false}`. | No SSRF, no tracking pixels, and `frame-src` stays at `'self'` (T163). |
| D200 | **Thumbnails are generated by the client** with `exportToBlob` (PNG, longest side at most 640 px), after a save and at most once every 60 s, and only by the owner. They are uploaded with `PUT /api/whiteboards/:id/thumbnail`, checked for PNG magic bytes and IHDR at most 2048×2048, capped at **128 KiB**, and stored as a BLOB on the `whiteboards` row. The server never renders or resizes anything. | The container has no headless browser, and §14 bans server-side processing. A DB BLOB needs no object lifecycle and purges with the row (T169). |
| D201 | **Export:** PNG (and "Copy as PNG") comes from `exportToBlob`. SVG comes from `exportToSvg` and is serialized to a Blob **downloaded as an attachment only**. Nook never renders an SVG inline and never uploads it. If S0 G2 shows that SVG export needs WebAssembly under the CSP and fails, SVG export is **omitted** rather than adding `'wasm-unsafe-eval'`. `exportEmbedScene` is off. | D7. The CSP is not weakened for an export format. |
| D202 | **History parity.** `/whiteboards/:id` is a real history entry. **Browser Back leaves the canvas.** Undo and redo live only on Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, and Ctrl+Y, plus the toolbar buttons, and never on history. While Excalidraw has `openDialog`, `openMenu`, `openPopup`, or `openSidebar` set, a `registerHistoryDialogGuard` guard clears them through `updateScene` and consumes that Back (the D18 pattern). Nook's own sheets (share, rename, move, export, board menu) use the same guard. Before leaving, the route awaits the flush (at most 3 s), then navigates. On failure it keeps the pending local copy (D210) and says so. | Operator rule: Back leaves, it does not undo. |
| D203 | **Fonts are self-hosted.** A small inline Vite plugin in `vite.config.ts` (no new dependency) copies `node_modules/@excalidraw/excalidraw/dist/prod/fonts` to `dist/excalidraw/fonts/`. The canvas module sets `window.EXCALIDRAW_ASSET_PATH = "/excalidraw/"` **before** its dynamic `import()`, so no inline script is needed. The production static handler serves `.woff2` as `font/woff2` with a long cache. The CSP stays `font-src 'self'`. | No CDN (T163). |
| D204 | **Search:** `whiteboard_search` and `whiteboard_fts` (023) follow the Collections pattern (D57). The index is updated in the same transaction as each save, from the board name plus the text (and `originalText`) of text elements and frame names, capped at 64 KiB. Results are filtered by the documents readable predicate at query time. Binned or purging boards are never returned. | Findable boards, and the search ACL matches reads (T171). |
| D205 | **MCP:** `whiteboards:read` gives `list_whiteboards` and `read_whiteboard` (text plus element summaries, bounded, labelled as untrusted data). `whiteboards:write` gives only `create_whiteboard` (empty, optionally in an owned folder). **No scene edits over MCP.** Viewers get `whiteboards:read` and guests get nothing, per `mcpScopesForRole`. | Agents can find and read boards and set one up. Letting an agent edit a canvas it cannot see is a poor fit, and a prompt-injection amplifier (T170). |
| D206 | **Module `whiteboards`** is added to `MODULE_IDS` (server and client), labelled "Whiteboards", with the lucide `PenTool` icon, a launcher tile, route app `whiteboards`, the Today section `whiteboardsRecent` ("Recent whiteboards"), and a search facet. The name is not "Boards", because Task Boards already uses it. | D92. |
| D207 | **Snapshots (WB-B).** When a save supersedes an object and the newest snapshot is at least 30 minutes old (or there is none), the old object is kept as a `whiteboard_snapshots` row instead of being unlinked. A board keeps at most **20**, and the oldest is dropped. Snapshots count against quota. "Restore" writes the old scene as a **new** revision, so nothing is lost. | Undo is only in memory, and this is the recovery story, like note versions. |
| D208 | **Embedding a board in a note (WB-B):** the Markdown is `[Name](/whiteboards/<uuid> "whiteboard")` alone in its paragraph. The link title is the marker, so it survives round trips and degrades to a plain link elsewhere. A Tiptap node renders it as a card showing the thumbnail from `/api/whiteboards/:id/thumbnail` (`img-src 'self'`), the name, and an "Open" button. A reader who cannot read the board sees "Whiteboard unavailable", with nothing leaked beyond what the note author wrote. | It reuses the D21 URLs. No new Markdown syntax. |
| D209 | **Out of scope:** real-time collaboration and presence; Excalidraw+ features and AI "text to diagram" backends; the public library browser (libraries.excalidraw.com); `#addLibrary` URLs; embeddables; server-side rendering; public links. | Privacy and surface. |
| D210 | **A pending local copy.** Unsaved scene JSON is mirrored (debounced 500 ms) to IndexedDB under `nook.whiteboard.pending.<userId>.<boardId>`, together with its `baseRevision`, and cleared on a successful save. When a board opens with a pending copy whose base equals the server revision, the copy is applied silently. When the base differs, the client offers "Restore unsaved changes (as a copy)". Every access is wrapped in try/catch, so the board still works in private mode. | A tab crash or offline moment on a phone should not cost a sketch. `keepalive` fetches are capped at 64 KiB, so a flush on `pagehide` cannot be relied on. |

---

## 6. Data model: migration `023_whiteboards`

`server/migrations/023_whiteboards.ts`. It is transactional and touches no files. The migrations assertion becomes `[1..23]` minus whatever the parallel plans have not landed yet. The director orders 018, 021, 022, and 023.

```sql
CREATE TABLE whiteboards (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  format        TEXT NOT NULL DEFAULT 'excalidraw' CHECK (format IN ('excalidraw')),
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  object_id     TEXT NOT NULL UNIQUE,                 -- current scene under documents/objects/
  element_count INTEGER NOT NULL DEFAULT 0 CHECK (element_count BETWEEN 0 AND 5000),
  text_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (text_bytes >= 0),
  thumb_png     BLOB CHECK (thumb_png IS NULL OR length(thumb_png) <= 131072),
  thumb_revision INTEGER,                              -- scene revision the thumbnail shows
  thumb_sha256  TEXT CHECK (thumb_sha256 IS NULL OR length(thumb_sha256) = 64),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE whiteboard_snapshots (                    -- used from WB-B (D207); created now so 023 is the only migration
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  object_id   TEXT NOT NULL UNIQUE,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at  TEXT NOT NULL,
  UNIQUE (document_id, revision)
);
CREATE INDEX idx_whiteboard_snapshots_doc ON whiteboard_snapshots(document_id, created_at DESC);
CREATE TABLE whiteboard_search (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE whiteboard_fts USING fts5(title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
CREATE TRIGGER whiteboard_search_ad AFTER DELETE ON whiteboard_search
  BEGIN DELETE FROM whiteboard_fts WHERE rowid = old.id; END;
```

**Invariants and code changes that go with 023:**

- `documents.size_bytes` and `sha256` always equal the current object's. `storedBytes()` adds `SUM(whiteboard_snapshots.size_bytes)` for the owner's boards. Thumbnails are not counted (at most 128 KiB each).
- **Sweeper** (`sweepDocumentFiles` `hasDocumentRow`): an object name is live when it matches `documents.id`, `whiteboards.object_id`, **or** `whiteboard_snapshots.object_id`. There is a unit test for each case (T166).
- **Content route** (`GET /api/files/:id/content`) for a whiteboard reads `object_id` and `size_bytes` in one query. On `DocumentIntegrityError("missing")` it re-reads once, to cover a save that landed in between. It stays download-only (`preview_kind 'none'`).
- **Purge (§9.3 step 2)** for a document with a `whiteboards` row: first remove `object_id` and every snapshot `object_id` (ENOENT counts as success), then `removeObject(document.id)`, which is ENOENT for boards. Step 3 cascades the rows away.
- **Reconcile:** `whiteboard_search` joins the note index's reconcile pass, rebuilding rows whose `source_sha256 ≠ documents.sha256`, with a budget per run.
- `DocumentSummary` gains `kind: "file" | "whiteboard"`, from `EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)`, for Files, the Bin, and search.

**Scene object format** (canonical JSON, UTF-8, which is what download returns):

```json
{ "type": "excalidraw", "version": 2, "source": "nook",
  "elements": [ … ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": { "<fileId>": { "id": "<fileId>", "mimeType": "image/png", "nookDocumentId": "<uuid>" } } }
```

This opens on excalidraw.com (images show as missing there, which is the privacy-correct result).

---

## 7. Scene validation (`server/whiteboards/scene.ts`, pure, zod)

| Limit | Value | On violation |
| --- | --- | --- |
| Request body (bounded reader, §6.3) | **4 MiB** (`WHITEBOARD_MAX_SCENE_BYTES`, a constant) | 413 `SCENE_TOO_LARGE` |
| JSON nesting depth | ≤ 8 | 400 `INVALID_SCENE` |
| `elements` (after stripping `isDeleted: true`) | ≤ **5,000** | 400 `TOO_MANY_ELEMENTS` |
| Element `type` | `rectangle`, `diamond`, `ellipse`, `arrow`, `line`, `freedraw`, `text`, `image`, `frame` | 400 `UNSUPPORTED_ELEMENT` (this covers `embeddable`, `iframe`, `magicframe`, and anything unknown) |
| `id`, `groupIds[]`, `frameId`, `containerId`, binding ids | `^[A-Za-z0-9_-]{1,64}$`, groups ≤ 32 per element | 400 |
| Numbers (`x`, `y`, `width`, `height`, `angle`, and so on) | finite, \|v\| ≤ 1e7 | 400 |
| `points` per linear or freedraw element | ≤ **10,000** pairs, **200,000** per scene | 400 `TOO_MANY_POINTS` |
| `text` and `originalText` | ≤ 20,000 characters each, **1 MiB** of text per scene, NUL and C0 controls stripped except `\n` and `\t` | 400 |
| Colours (`strokeColor`, `backgroundColor`, `viewBackgroundColor`) | `^#[0-9a-fA-F]{3,8}$` or `transparent` | 400 |
| `link` | D199 allowlist, ≤ 2,048 characters, parsed with `URL` (or the Nook path regex) | 400 `INVALID_LINK` |
| `customData` | a plain object, ≤ 1 KiB serialized, primitives only | dropped |
| Unknown element keys | allowed only if the value is a primitive or an array of ≤ 64 numbers, ≤ 48 keys per element, strings ≤ 256 | 400. This covers forward compatibility within the pinned version, and fixtures prove it (§12). |
| `appState` | allowlist: `viewBackgroundColor`, `gridSize`, `gridStep`, `gridModeEnabled` | other keys dropped (no scroll, zoom, collaborators, or theme) |
| `files` | ≤ 100 entries. Each is `{ id, mimeType ∈ image allowlist, nookDocumentId: uuid }`. **Any `dataURL` key** is rejected. | 400 `DATA_URL_NOT_ALLOWED` |
| `image` elements | `fileId` must be a key of `files`, and `status` is forced to `"saved"` | 400 |

The validator is pure, so the client runs it too: before saving (to fail fast) and **on load**, so a scene that somehow bypassed the server never reaches Excalidraw unbounded. The server does not check that referenced `nookDocumentId`s are readable when a scene is saved. Access is enforced per viewer when the image is fetched (D198). WB-B's insert flow only offers documents the owner can read.

---

## 8. API (to be added to API_CONTRACTS.md as "Whiteboards")

Every route needs a session. Mutations need CSRF and the owner (`ownedDocument` plus a `whiteboards` row), and anything missing or forbidden is 404. Viewers and guests are refused by the Wave 15 write gate automatically, because these are new non-GET routes. `Cache-Control: no-store` as for all of `/api`.

```ts
type WhiteboardSummary = DocumentSummary & {
  kind: "whiteboard"; revision: number; elementCount: number;
  hasThumbnail: boolean; thumbRevision: number | null; canEdit: boolean;
};
```

| Method and path | Who | Request | Response |
| --- | --- | --- | --- |
| `POST /api/whiteboards` | member+ | `{ name (1–200 characters, §6.4 rules), folderId? (owned) }`, `Idempotency-Key` header (stored as `upload_key`) | 201 `{ whiteboard: WhiteboardSummary }`. Creates the documents row, the whiteboards row, and an empty canonical scene object. Audit `whiteboard.create`. A replayed key returns the same board. 507 quota as for uploads. |
| `GET /api/whiteboards?folder=all\|shared\|<id>&sort=…` | reader | none | 200 `{ whiteboards: WhiteboardSummary[] }` (≤ 500, readable predicate, `purpose='file'`, joined to whiteboards) |
| `GET /api/whiteboards/:id` | reader | none | 200 `{ whiteboard, scene }` (canonical JSON), `ETag: "r<revision>"` |
| `PUT /api/whiteboards/:id/scene` | owner | `{ baseRevision, scene }` | 200 `{ revision, savedAt, sha256, sizeBytes, unchanged? }`. 409 `{ code: "REVISION_CONFLICT", revision }`. 413 or 400 per §7. 507 quota (delta). Runs under `withResourceLock(id)`. Audited as `whiteboard.save`, coalesced to at most one row per board per 10 minutes. |
| `PUT /api/whiteboards/:id/thumbnail?revision=n` | owner | raw `image/png` body ≤ 128 KiB | 204. It is ignored (still 204) when `n < thumb_revision` or `n > revision`. 415 for anything that is not a PNG. |
| `GET /api/whiteboards/:id/thumbnail` | reader | none | 200 `image/png`, with the content-route header set (`default-src 'none'; sandbox`, nosniff, CORP same-origin, `ETag` = thumb sha256, `Cache-Control: private, no-cache`). 404 when there is none. |
| `POST /api/whiteboards/:id/duplicate` (WB-B) | reader, member+ | `{ folderId? }` | 201 `{ whiteboard }`, owned by the caller, private, with only the images the caller can read kept |
| `POST /api/whiteboards/import` (WB-B) | member+ | `{ documentId }`: a readable Files document ≤ 4 MiB whose bytes parse as `.excalidraw` or JSON Canvas (Q7) | 201 `{ whiteboard }`. `files` entries with a `dataURL` are dropped, and their images become placeholders (Q4). |
| `GET /api/whiteboards/:id/snapshots` (WB-B) | owner | none | 200 `{ snapshots: [{ id, revision, createdAt, sizeBytes }] }` |
| `POST /api/whiteboards/:id/snapshots/:snapshotId/restore` (WB-B) | owner | `{ baseRevision }` | 200 as for a scene PUT (a new revision) |

**Existing routes that change:** `GET /api/files` and `GET /api/files/:id` include `kind`. `GET /api/files/:id/content` resolves `object_id` (§6). `GET /api/bin` rows include `kind`. `GET /api/search` accepts `type=whiteboard` and returns `{ type: "whiteboard", id, name, snippet, updatedAt }`. `PATCH`, `PUT sharing`, and `DELETE` under `/api/files/:id` work on boards unchanged. Rename keeps a trailing `.excalidraw` if the user drops it, since the list shows the name without the suffix anyway.

### 8.1 Save sequence (`PUT …/scene`, server)

1. **Read and validate.** Read the body with the bounded reader (4 MiB), then parse, validate, and canonicalize it (§7) **outside** the lock, and compute `sha256` and `size`.
2. **Load and check, under the lock.** Inside `withResourceLock(documentId)`, load the owned live board: `ownedDocument` plus the `whiteboards` row, requiring `purge_started_at IS NULL`. `baseRevision ≠ revision` returns 409. `sha256 = documents.sha256` returns 200 `{ unchanged: true, revision }`.
3. **Quota.** `storedBytes(owner) - size_bytes + size > quota` returns 507.
4. **Write the new object.** Pick a new `objectId = randomUUID()`. `createStagingFile(objectId)` (O_EXCL), write, `commitStaged(objectId)` (fsync, rename, directory fsync).
5. **Commit.** In one transaction:
   - `UPDATE whiteboards SET revision = revision + 1, object_id = ?, element_count = ?, text_bytes = ?, updated_at = ? WHERE document_id = ? AND revision = ?` (it must change 1 row)
   - `UPDATE documents SET size_bytes = ?, sha256 = ?, updated_at = ?`
   - reindex `whiteboard_search` and `whiteboard_fts`
   - if D207 applies, insert the superseded object as a `whiteboard_snapshots` row and drop the oldest past 20 (collecting their object ids)

   If the transaction fails, `removeObject(objectId)` and rethrow.
6. **Clean up after the commit.** `removeObject(oldObjectId)` unless it was kept, plus any snapshot objects that were dropped. ENOENT is fine. A crash here leaves orphans, which the sweeper removes after an hour (T166 keeps live ones safe).

### 8.2 Autosave state machine (client, `src/whiteboards/autosave.ts`, pure reducer)

`idle → dirty (onChange with a new getSceneVersion) → saving → idle | dirty (changed while saving) | conflict (409) | offline (network error or 5xx: retry with backoff 2 s → 30 s, pending copy kept) | rejected (400 or 413: toast with the reason, the local copy kept, no retry)`.

- Only one request is in flight at a time. A change during `saving` re-arms the debounce with the new base once the save returns.
- Thumbnails are queued after an `idle` transition when at least 60 s have passed since the last one.
- Route leave and `visibilitychange: hidden` flush immediately. `beforeunload` shows the browser prompt only while `dirty`, `saving`, or `offline`.

---

## 9. MCP

| Tool | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `list_whiteboards` | `whiteboards:read` | `{ folderId?, query? (FTS, ≤ 200 characters), limit? (1–50, default 20), cursor? }` | `{ whiteboards: [{ id, name, folderId?, owner, updatedAt, revision, elementCount, url: "/whiteboards/<id>" }], nextCursor? }` |
| `read_whiteboard` | `whiteboards:read` | `{ id, include?: "text" \| "elements" (default "text") }` | `{ id, name, revision, updatedAt, texts: [{ elementId, text, containerId?, frame? }] }`. With `elements`, it adds `elements: [{ id, type, x, y, width, height, text?, link?, from?, to?, frameId? }]` (≤ 1,000, `truncated` flag). The output is capped at 256 KiB. Never raw points or file bytes. |
| `create_whiteboard` | `whiteboards:write` | `{ name, folderId? }` | `{ id, url }`, audited as `mcp.whiteboard_create` with `keyId` |

`MCP_SCOPES` gains `whiteboards:read` and `whiteboards:write`, and `IMPLIED_READ_SCOPE` maps write to read. `mcpScopesForRole`: viewers get `whiteboards:read`, guests get nothing. The key-scope picker in Settings gets a Whiteboards row. Tool descriptions say that board text is user content and must be treated as data, not instructions (the existing convention). `files:read` `list_documents` will list boards as `application/vnd.excalidraw+json` documents, and `read_document_text` refuses them (`preview_kind 'none'`), which is acceptable.

---

## 10. UX

### 10.1 Routes (`src/router.ts`)

`{ app: "whiteboards"; folder: "all" | "shared" | string; boardId: string | null }`, parsed with the existing `parseCollection` helper. It covers `/whiteboards`, `/whiteboards/shared`, `/whiteboards/folder/:id`, and `/whiteboards/:id`. `src/whiteboardsRoute.ts` holds the module guard (D92: when the module is off, go Home with a hint). A Files row whose `kind === "whiteboard"` opens `/whiteboards/:id` instead of the preview pane. Its ⋯ menu adds "Open whiteboard", and "Download" still downloads the `.excalidraw` file.

### 10.2 `/whiteboards`, the list (Files list and grid idiom)

```
390 px                                   desktop (> 760 px)
┌──────────────────────────────┐   ┌────────────┬──────────────────────────────────────────┐
│ ‹ Today   Whiteboards    [+] │   │ ◧ Nook     │ All whiteboards · 12   [Grid|List] [Sort▾] [+ New]
│ [All] [Shared] [Folder ▾]    │   │ All        │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │
│ ┌──────────┐ ┌──────────┐    │   │ Shared     │ │ thumb  │ │ thumb  │ │ thumb  │ │  ▭ ✎   │ │
│ │  thumb   │ │  thumb   │    │   │ ─ Folders ─│ │        │ │        │ │        │ │ (none) │ │
│ │          │ │          │    │   │ Default    │ ├────────┤ ├────────┤ ├────────┤ ├────────┤ │
│ ├──────────┤ ├──────────┤    │   │ Projects 👥│ │Floor pl│ │Sprint r│ │Kitchen │ │Ideas   │ │
│ │Floor plan│ │Retro     │    │   │ Home       │ │2h · 👥 │ │Mon     │ │Sep 12  │ │Sep 3 ⋯ │ │
│ │2h ago  ⋯ │ │Mon · 👥 ⋯│    │   │ + New folder│ └────────┘ └────────┘ └────────┘ └────────┘ │
│ └──────────┘ └──────────┘    │   └────────────┴──────────────────────────────────────────┘
└──────────────────────────────┘
```

- A grid of 2 columns at 390 px, auto-fill 200 px cards on desktop, with a List toggle that reuses the Files row layout. Each card shows the thumbnail, or a placeholder icon when there is none. The name has an ellipsis. Below it: relative "edited", an owner badge when the board is not owned, and a sharing icon. The ⋯ sheet has Open, Rename, Move, Share, Download `.excalidraw`, and Delete (owner-only items hidden for recipients), plus "Duplicate" in WB-B.
- **New** opens a D91-style dialog with Name and an Owned folder picker (`src/ui/Combobox`). Create, then navigate to `/whiteboards/:id`.
- The folder filter is a custom `Select` (D91), never a native select.
- States: empty ("No whiteboards yet. Sketch a plan, a floor plan, or a retro.") with a New button, loading skeleton cards, error with retry.

### 10.3 `/whiteboards/:id`, the canvas

```
390 px (portrait)                         desktop
┌──────────────────────────────┐   ┌────┬──────────────────────────────────────────────┐
│ ‹  Floor plan    ✓ Saved  ⋯  │   │ ‹  │ Floor plan ▾   ✓ Saved · r14   [Share] [Export▾] ⋯
├──────────────────────────────┤   │ ☰  │        [ Excalidraw top toolbar: ✋ ▭ ◇ ○ → — ✎ A 🖼 ]      │
│                              │   │ ▦  │                                              │
│        (canvas: pinch,       │   │    │                (canvas)                      │
│         two-finger pan)      │   │ ── │                                              │
│                              │   │ Rec│                                              │
│                              │   │ ent│                                              │
│                              │   │ bds│                                   [− 100% +] │
├──────────────────────────────┤   │    │ [↶ ↷]                                        │
│ ↶ ↷ │ ✋ ▭ → ✎ A  ▸more       │   └────┴──────────────────────────────────────────────┘
└──────────────────────────────┘    left rail = Nook's collapsible "Recent whiteboards" rail
  Excalidraw's own phone toolbar      (Excalidraw's toolbar stays on top; it cannot move to a left rail)
```

- **The Nook header bar** (44 px, safe-area aware) has Back, the name (tap to rename, owner only), a save status (`Saving…`, `✓ Saved`, `Offline, kept on this device`, `Conflict`), and ⋯. On desktop it also shows Share and Export. On a phone, ⋯ opens a **bottom sheet** with Share, Export PNG, Export SVG (per D201), Download `.excalidraw`, Move, History (WB-B), and Delete.
- **Excalidraw props:** `theme="dark"`, `UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: true, toggleTheme: false }, tools: { image: WB_B } }}`, `validateEmbeddable={false}`, `onLinkOpen` (D199), `viewModeEnabled` for non-owners, `langCode="en"` (locale chunks stay lazy), and a `renderTopRightUI` that renders nothing, so no collaboration or library buttons appear.
- **Touch:** the canvas container has `touch-action: none` and `overscroll-behavior: contain`, and the route disables the pull-to-refresh area. The iOS edge swipe (system Back) still works and leaves the route, which is the intended behavior. The document never scrolls while the canvas is on screen.
- **A recipient** sees a banner at the top: "View only · Owned by Priya", plus "Duplicate" in WB-B.
- **Conflict** (409): a Nook dialog titled "This whiteboard changed on another device", with **Reload latest** (discards local changes after a confirm) and **Save mine as a copy** (creates a board with the local scene).

### 10.4 Share sheet

Reuse `src/files/FileSharePanel.tsx` as is: Inherit from folder, Private, Selected people (user picker), or Everyone here. The success toast shows the effective audience, as for files. On a phone it is a full-height bottom sheet under the dialog guard, so Back closes it. The copy adds "People you share with can view. Only you can edit." It also warns, for WB-B images: "Images show only for people who can open those files."

### 10.5 Embedding in a note (WB-B)

1. In the note editor, the `/` slash menu gets **Whiteboard**, which opens a picker sheet: search over readable boards (`GET /api/whiteboards`), plus **New whiteboard**, which creates one in the note's folder.
2. Choosing a board inserts the D208 node, and the card renders with its thumbnail.
3. Tapping **Open** navigates to `/whiteboards/:id` (a history push). Back returns to the note at the same scroll position.
4. On a board, the ⋯ menu's **Copy link** copies `/whiteboards/<id>`. Pasting that link alone on a line in a note turns it into a card, through a paste rule.

### 10.6 Links from shapes (WB-B)

Excalidraw's link editor gets a "Link to Nook item…" affordance, a sheet that searches notes, files, cards, and boards and writes the Nook path. Tapping a linked shape in view mode routes internally, as a history push.

### 10.7 Today, Modules, Files, Bin, search

- **Today:** a `whiteboardsRecent` section showing the 5 most recently edited readable boards, each with a thumbnail and relative time. The empty text is "no whiteboards yet". It gets a launcher tile.
- **Settings → Modules:** "Whiteboards: sketches, diagrams, and floor plans saved in your Files." Turning it off hides the launcher, route, Today section, search facet, and the Files "Open whiteboard" action. Boards still appear in Files as `.excalidraw` downloads, because the module toggle is not a boundary (T97).
- **Bin:** board rows carry the `PenTool` icon. Restore returns the board with its revision and snapshots.
- **Search** (WB-B facet UI): a "Whiteboards" chip. A result opens the board. There is no element deep link in v1 (Q9).

---

## 11. Threats (T160–T172, to be added to THREAT_MODEL.md)

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T160 | **A hostile scene** (huge, deeply nested, millions of points) exhausts server CPU or memory, or freezes viewers' browsers | The bounded body reader caps it at 4 MiB before parsing. §7 limits cover depth, elements, points, and text. The same pure validator runs client-side on load. Rejections are 400 or 413 and are never stored. | Required |
| T161 | **Stored XSS** through text, names, or links (`javascript:`, HTML in text) | Excalidraw draws text on a canvas. Nook shows names and snippets as React text nodes only. The D199 link allowlist is enforced on the server and again in `onLinkOpen`. Snippets use FTS `snippet()` with text-node rendering, as notes do. | Required |
| T162 | **SVG export as an injection vector** | The SVG is built in the client from validated data and downloaded as an attachment only. An exported SVG uploaded back into Files is `application/octet-stream`, download-only (D7). Nook never renders SVG inline. | Required |
| T163 | **Third-party requests and tracking** (CDN fonts, library browser, embeddables, remote image URLs, analytics) | Self-hosted fonts through `EXCALIDRAW_ASSET_PATH` (D203). `embeddable` and `iframe` are rejected, and `validateEmbeddable={false}`. The library UI and collaboration are hidden. The CSP stays at `connect-src 'self'`, `img-src 'self' data:`, and `frame-src` from `default-src 'self'`. The S0 G1 network gate is re-run on every upgrade. | Required |
| T164 | **data: URL smuggling and quota bypass** through the `files` map | `dataURL` is rejected. Images are Nook document references only, and their bytes count once, in Files. | Required |
| T165 | **Image ACL widening:** sharing a board exposes images the recipient could not otherwise read | The client fetches images as the viewer through `/api/files/:id/content`, and unreadable ones show a placeholder. No endpoint serves an image through the board's ACL. MCP returns ids only. | Required |
| T166 | **The sweeper deletes a live scene or snapshot object**, because orphan detection only knows `documents.id` | `hasDocumentRow` also checks `whiteboards.object_id` and `whiteboard_snapshots.object_id`. There is a test for each. The one-hour minimum age stays. | Required |
| T167 | **Lost updates** between the owner's tabs or devices | Revision CAS (409), conflict dialog, and the D210 pending copy. There is no silent last-writer-wins. | Required |
| T168 | **A recipient, viewer, or guest writes** a scene or thumbnail | `ownedDocument` is required on every mutation, and anything else returns 404. The Wave 15 write gate covers new routes. The client's view mode is UX only. | Required |
| T169 | **Thumbnail as a polyglot or oversized image** | Owner-only upload. PNG magic bytes and IHDR dimensions checked, ≤ 128 KiB. Served `image/png` with nosniff and `default-src 'none'; sandbox`. It is only ever used in `<img>`. | Required |
| T170 | **Prompt injection through board text** read over MCP | The output is bounded (256 KiB) and described as untrusted user content. The write scope can only create an empty board, and no MCP tool edits a scene. | Required |
| T171 | **Search leaks** a board's text to non-readers, or after it is binned | The FTS query joins the readable predicate on `documents`. `deleted_at IS NULL` and `purge_started_at IS NULL` are required. Purge cascades the index row. | Required |
| T172 | **Supply chain** through a large bundled dependency tree | Exact pin and a committed lockfile. The chunk only loads on the route. Each upgrade is its own commit that re-runs S0 and the fixture tests, with a `bun audit` or `npm audit` note in the commit body. The CSP bounds what compromised code can do (no eval, no third-party connects). | Required |

---

## 12. Tests (to be added to TEST_PLAN.md)

**WB-A**
- [ ] `tests/whiteboardScene.test.ts` (pure): valid fixtures pass. These are scenes exported from Excalidraw 0.18.1, kept in `tests/fixtures/whiteboards/`, and re-exported on every upgrade. Each §7 limit is rejected at limit+1 and accepted at the limit. `isDeleted` elements are stripped. `appState` extras are dropped. `dataURL` gives 400. `embeddable` and `iframe` give 400. Every link scheme is checked: `javascript:`, `data:`, `vbscript:`, and protocol-relative `//evil` are rejected, while the Nook paths are accepted. Unknown-key rules. Depth 9 is rejected. Canonical output is stable, so the same input gives the same sha256.
- [ ] `tests/whiteboards.test.ts` (server): create (with idempotency replay), list and read by owner, `selected` recipient, `all_users`, and folder inheritance (parity matrix with files). A non-reader gets 404. A PUT from a recipient gets 404, and from a viewer or guest 403 `ROLE_READ_ONLY`. CAS covers success, stale gives 409, and an identical scene gives `unchanged`. Quota delta gives 507. The object is copy-on-write: the old object is removed and the new one exists, and the documents `size_bytes` and `sha256` mirror it. The Files content route downloads the current bytes with `Content-Disposition: attachment` and the exact strict CSP.
- [ ] Sweeper: live `object_id` and snapshot objects survive, and a true orphan older than an hour is removed (T166). Purge removes current plus snapshot objects and the rows cascade. Restore from the Bin gives back the same revision.
- [ ] Thumbnail: a PNG is accepted. A JPEG, a PNG header over a GIF body, 128 KiB + 1, and a 4096 px IHDR are rejected. A stale revision is ignored. The GET headers are exact.
- [ ] Search: a text element is found by its owner and by a recipient, and not by a non-reader. It is gone after delete. The FTS row is removed after purge. Reconcile rebuilds a row whose sha drifted.
- [ ] MCP: scopes (`whiteboards:read` needed, write implies read, viewer read-only, guest none). `read_whiteboard` output bounds and truncation. `create_whiteboard` makes an empty private board in Default, and an unowned folder gives 404.
- [ ] `tests/router.test.ts`: `/whiteboards…` parse and format, with uppercase ids lowercased and malformed segments falling back to the list. `tests/modules.test.tsx`: the MODULE_IDS lists match.
- [ ] Client: the autosave reducer (pure) covers debounce, in-flight coalescing, 409 to the conflict state, offline to pending, and the pending-copy apply-or-offer rules (D210). The history guard closes Excalidraw's `openDialog` and `openMenu` before leaving.
- [ ] Browser QA (built app, production CSP, two accounts) at **390×844** and 1280×800. Create, draw, text, arrow, then Back. The list shows the new thumbnail, and Forward reopens the board at the same revision. Pinch zoom does not zoom the page. The share sheet closes on Back. A recipient gets view mode. Network capture: zero off-origin requests, and zero CSP violations.
- [ ] Real phone: system Back gesture, pinch, and a pencil or finger stroke near the screen edge.

**WB-B**
- [ ] Images: insert from Files. A recipient who cannot read the image sees a placeholder, and one who can sees it. Duplicate drops the images the caller cannot read.
- [ ] Embed card: Markdown round trip `[Name](/whiteboards/<id> "whiteboard")`. The paste rule. An unreadable board shows the placeholder. Open, then Back returns to the note.
- [ ] Snapshots: the 30-minute rule, the cap of 20, restore creating a new revision, and quota including snapshots.
- [ ] Import `.excalidraw` from Files: valid, `dataURL` stripped, oversized gives 413. JSON Canvas import if Q7 is accepted.
- [ ] SVG export (if D201 allows): downloaded, never shown in an `<img>` or iframe, and the CSP stays clean.

---

## 13. Wave split

| Wave | Contents | Migration | Main files | Size |
| --- | --- | --- | --- | --- |
| **WB-A: whiteboards on Files** | S0 spike gate. `023`. `server/whiteboards/{scene,service,routes,search,mcp}.ts`. The `documentStorage` copy-on-write writer. Sweeper, quota, purge, and content-route changes. `kind` on Files and Bin summaries. Create, list, read, save, and thumbnail routes. MCP `list_whiteboards`, `read_whiteboard`, `create_whiteboard`, and scopes. The search index (server) and search API `type=whiteboard`. The client: `src/whiteboards/{WhiteboardsApp,WhiteboardList,WhiteboardCanvas (lazy),autosave,pendingStore,historyGuard}.tsx`. The router, `whiteboardsRoute.ts`, module registry, launcher tile, Today `whiteboardsRecent`, Files "Open whiteboard". Share, rename, move, and delete through the Files API. PNG export and `.excalidraw` download. The Vite font-copy plugin. Docs: API_CONTRACTS, THREAT_MODEL, TEST_PLAN, ARCHITECTURE, README, site. | 023 | `package.json` and lockfile, `vite.config.ts`, `server/documents.ts`, `server/documentStorage.ts`, `server/bin.ts`, `server/sweeper.ts`, `server/mcpScopes.ts`, `server/mcpTools.ts`, `server/moduleIds.ts`, `server/searchRoutes.ts`, `src/router.ts`, `src/modules.ts`, `src/files/FilesApp.tsx`, `src/today/*` | **L** (2 sessions: server, then client). Suggested commits: `chore: add pinned excalidraw and self-hosted fonts (spike S0)`, `feat: add whiteboards migration 023`, `feat: add bounded whiteboard scene validator`, `feat: add whiteboard create, read, and CAS save API`, `feat: keep whiteboard objects through sweeper, quota, purge, and content`, `feat: index whiteboard text for search`, `feat: add whiteboard MCP tools and scopes`, `feat: add whiteboards list and module`, `feat: add lazy Excalidraw canvas with autosave and history parity`, `feat: add whiteboard thumbnails, share, and PNG export`, `docs: document whiteboards` |
| **WB-B: connected whiteboards** | Images from Files (D198 hydrate, insert picker, upload into the board's folder). Links from shapes (D199 Nook picker, internal routing). The note embed card (D208: Tiptap node, slash item, paste rule). Snapshots and the History sheet (D207). Duplicate and import `.excalidraw`. SVG export (if D201 allows). The search facet chip and result rendering. Bin icon polish. | none | `src/editor/extensions.ts`, `slash.ts`, `src/search/*`, `src/whiteboards/*`, `server/whiteboards/*` | **M** (1–2 sessions) |

Each wave keeps the QA instance running and ends with the §12 gates: typecheck, tests, build to a scratch outDir, `docker build --target verify`, browser QA at 390 px with Back/Forward parity, an independent review, and a `/security-review` (WB-A especially: the validator and object lifecycle).

---

## 14. Open decisions (with defaults)

| # | Question | Default |
| --- | --- | --- |
| Q1 | Excalidraw (a) or in-house (b)? | **(a)**, only if S0 passes. Otherwise (b), with JSON Canvas and a `nook` extension as the storage format. |
| Q2 | Do boards show in the Files list, or only in Whiteboards? | **Both.** Files shows them with the board icon and an "Open whiteboard" action. That is the "stored as files" promise, and it gives download and backup for free. |
| Q3 | Save policy: autosave only, or a draft and publish like notes? | **Autosave only** (D194), with snapshots (D207) as the history. |
| Q4 | Images in WB-A? | **No.** The tool is hidden in WB-A and ships in WB-B as Files references. Imported `dataURL` images become placeholders. Keeping them as new Files uploads is a later option. |
| Q5 | Keep Excalidraw's "Text to diagram" (mermaid) dialog? | **Keep it if S0 G6 is clean** (it is local-only). Hide it otherwise. |
| Q6 | Ship the CJK (Xiaolai) font? | **Only if S0 G3 stays under 25 MB.** Otherwise leave it out and rely on system fallback fonts. |
| Q7 | JSON Canvas import and export? | **Not in v1.** Revisit after WB-B, as a one-way export of text, stickies, and arrows. |
| Q8 | Scene size cap: 4 MiB and 5,000 elements? | **Yes**, as constants and not env. Raise them only on evidence. |
| Q9 | Search deep link to an element (`?element=`)? | **No** for v1. The board opens and Excalidraw's own search (Ctrl+F) does the rest. |
| Q10 | Should recipients be able to comment? | **No.** A later "board comments" feature could reuse `card_comments`-style rows. |
| Q11 | Should MCP get a limited write tool (for example "append sticky notes")? | **No** for v1 (D205). Revisit alongside the proposed MCP write-coverage wave. |
| Q12 | Keep Excalidraw's local shape library? | **Hidden** in v1. Persisting a per-user library in preferences is a later option. |
| Q13 | Should the route chunk be prefetched? | **No.** Load it on first navigation to `/whiteboards/:id` and show a skeleton meanwhile. Only the list prefetches it (`import()` on hover or focus of a card, desktop only). |

---

## 15. Sources

1. Excalidraw repository and MIT licence: https://github.com/excalidraw/excalidraw (LICENSE: https://github.com/excalidraw/excalidraw/blob/master/LICENSE)
2. Excalidraw file format discussion (from the 2026-09-25 report): https://github.com/excalidraw/excalidraw/discussions/9111
3. tldraw licence: https://tldraw.dev/community/license
4. JSON Canvas 1.0 spec: https://jsoncanvas.org/spec/1.0/
5. JSON Canvas repository (MIT): https://github.com/obsidianmd/jsoncanvas
6. draw.io embed mode: https://www.drawio.com/doc/faq/embed-mode
7. npm registry metadata for `@excalidraw/excalidraw` (version, licence, dependencies, unpacked size): https://registry.npmjs.org/@excalidraw/excalidraw/latest
8. Excalidraw v0.18.0 release notes (ESM, fonts from the esm.run CDN, self-hosting, `EXCALIDRAW_ASSET_PATH`, es2022): https://github.com/excalidraw/excalidraw/releases/tag/v0.18.0
9. Bundlephobia, `@excalidraw/excalidraw@0.18.0`: https://bundlephobia.com/package/@excalidraw/excalidraw
10. Font subsetting with WebAssembly (harfbuzzjs, woff2), about 750 KB gzip lazy chunks: https://github.com/excalidraw/excalidraw/pull/8384
11. Excalidraw installation docs (self-hosting fonts, container size): https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation
12. Excalidraw analytics issue (`VITE_APP_ENABLE_TRACKING`, Simple Analytics in the app): https://github.com/excalidraw/excalidraw/issues/8280
13. Excalidraw CSP and remote assets issue: https://github.com/excalidraw/excalidraw/issues/7657
14. MDN, CSP `script-src` and `'wasm-unsafe-eval'`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src
15. Excalidraw UIOptions: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/ui-options
16. Excalidraw export utilities: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export

---

## Director review (2026-09-28)

- **Numbering:** decisions renumbered to D191–D210 (the small-waves plan ends at D190). Threat rows T160–T172 stand.
- **Recommendation accepted: embed Excalidraw behind the spike gate.** The spike (zero off-origin requests with self-hosted fonts via an inline Vite plugin, no CSP/eval violations, route chunk ≤500 KB gzip and `dist/` growth ≤25 MB, canvas-only pinch zoom at 390 px, clean TS/Vite build, and a check that the package sends no analytics) runs first as its own commit in a worktree; if it fails, fall back to the scoped in-house JSON Canvas editor (option b) and re-plan.
- **Defaults accepted:** boards appear in the Files list too; autosave only (revision CAS, 409 → Reload latest / Save as copy); no images in the first wave; no JSON Canvas import/export in v1; CJK font only if the size budget allows; SVG export dropped rather than loosening CSP for WebAssembly.
- **Wave numbers:** WB-A = **Wave 23**, WB-B = **Wave 24**. Migration 023. Scheduling: the spike starts now; Wave 23 proper is scheduled once the operator picks between whiteboard and the password vault (or both) after the vault research lands.

### Spike result (2026-09-28): PASS with conditions → proceed with Excalidraw for Wave 23

`@excalidraw/excalidraw` 0.18.1 (MIT, React 19 OK). Commit `6cf81bd` on the spike worktree branch (parked until the operator schedules Wave 23). Gates: zero off-origin requests after the font plugin rewrites Excalidraw's esm.sh font fallback to same-origin (230 CSP-blocked requests without it); no CSP/eval violations for drawing, text, PNG export, help, library and Mermaid preview; route chunk 337.6 KB gzip (limit 500), `dist/` +20.9 MB (limit 25; Xiaolai CJK font is 12.7 MB of that); canvas-only pinch zoom at 390 px after `touch-action: pan-x pan-y` on Excalidraw overlays; typecheck/build/tests clean (1156). Exceptions: default SVG export loads a font-subsetting chunk that calls `Function(...)` (one blocked-eval report; no wasm instantiated) → Wave 23 exports SVG with `skipInliningFonts: true` or hides SVG export and the "Copy as SVG" menu item; image tools (WB-B) pull `pica`/`image-blob-reduce` with `WebAssembly.compile` → re-check CSP then. No active telemetry (tracking compiled out; built-in remote hosts never contacted and CSP-blocked anyway). Carry-overs listed in the spike report: keep the esm.sh rewrite, keep the overlay touch-action rule, consider dropping Xiaolai.

### Wave 23 build notes (2026-09-29, WB-A)

Built as planned, with these differences, each the conservative reading:

- **Migration 030**, not 023 (023 was taken); the tables are exactly §6.
- **Sharing** is the Wave 32 Access sheet for the `document` kind, not the older share panel (§10.4). Boards stay view-only for everyone but the owner (D195, D275).
- **Thumbnail upload** is JSON (`{ revision, png: base64 }`), because every write must be `application/json` (the only multipart exception is `POST /api/files`); the checks are §8's. Thumbnails revalidate with `Cache-Control: private, no-cache` and their hash as ETag.
- **Search** is `GET /api/search?scope=whiteboards` (the existing `scope` parameter), not `type=whiteboard`.
- **No `beforeunload` prompt**: the operator rule forbids native dialogs, so unsaved work is covered by the save on `visibilitychange`/`pagehide`, the leave flush, and the IndexedDB pending copy (D210).
- **Back** closes Excalidraw's overlays found in the DOM (main menu, dialogs, context menu, sidebar, popovers), because 0.18.1 does not keep every one of them in `appState`.
- **SVG export** is not offered; the build also disables "Copy to clipboard as SVG" (its font inlining calls `Function()`). **The shape library** trigger is hidden (Q12). **Dropped or pasted images** are removed before a save (no image tool until Wave 24).
- **Nook keys** accept chosen whiteboards (selector kind `whiteboard`); the `folder` selector for whiteboards waits for Wave 34's list filters.
- **The list** is a lazy chunk too (about 8 KB gzip), so the main bundle does not grow; the canvas chunk is about 342 KB gzip; `dist/` grows by about 20.9 MB (fonts 13.1 MB, Xiaolai kept). `@excalidraw/excalidraw` is a devDependency: only the client build needs it, so the production image's `node_modules` does not carry it.
