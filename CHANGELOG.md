# Changelog

Release notes for Nook, newest first. Upgrade steps for each release are in [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.35.0 — 2026-10-13

- **Attach files almost everywhere**: calendar events, task cards and comments, collection rows, notes (`/file`, `/from files`, paste, drop; non-images become file cards), whiteboards, and chat (pictures go to vision models). Take photo on phones, Choose files, or From Files (with a confirm naming who will see it). Photo locations are removed from JPEG, PNG and WebP before upload.
- **Files › Attachments**: every attachment is an ordinary file in your own private Attachments folder, so it counts toward your storage, shows in Files, and goes to the Bin like anything else. Card and row attachments from earlier versions move there on upgrade, with the same people able to open them.
- **Shared notes show their pictures**: people a note is shared with directly can now open its pictures and files. Publishing a note that would share a file from elsewhere in Files asks you first; an editor can never share your files for you.
- **Profile pictures**: upload, take a photo, or drag one in; crop it square; remove it, or go back to your Google picture. Saved at most 512 px with no location data.
- **S3 storage (optional)**: `STORAGE_BACKEND=s3` keeps file bytes in an S3 or S3-compatible bucket through Bun's built-in client, with `storage-admin migrate`, `verify --hash` and `reclaim`. SQLite stays on disk.
- **Toasts**: notices now use Sonner, typed as success, info, warning or error. Errors stay until closed. **Undo** after moving something to the Bin in every module that uses the Bin, and the Bin's restore label always names where an item really goes.
- **Whiteboard thumbnails show pictures** the board's owner placed.
- **Confirming with Google works**: Google never re-asks for a password, so the old check always failed. A Google round trip for your linked account now confirms API keys, the vault, and password changes. Turning two-factor off, recovery codes, and unlinking Google also need your authenticator or a recovery code; a recovery code now works where the authenticator code did.
- **Keys stay inside their grants**: an MCP or API key can only link files its grants already cover.
- Migrations 046, 047 and 048 run on the first boot; back up first. See [Upgrading to 0.35.0](docs/OPERATIONS.md#upgrades).

## v0.34.0 — 2026-10-08

- **Admin limits for knowledge-base embeddings**: in **Settings → AI → Model providers**, each provider has a **Knowledge bases** section. An admin chooses whether knowledge bases may use the provider, allows any embedding model or only listed ones, and sets the largest size (64 to 3,072 dimensions).
- **Enforced everywhere**: Change embedding model offers only allowed choices and the server refuses others; a new base takes the first allowed model and caps its size; a model that answers larger than the limit stops with an error after one call.
- **Existing bases keep working**: a base already above a newly set limit keeps searching and indexing at its size, is never re-embedded on its own, and says the admin's limit is now lower.
- No migration and no new settings.

## v0.33.0 — 2026-10-08

- **Change a knowledge base's embedding model**: the owner can move a base to another provider, model, or size. Every source is embedded again at the owner's token cost; search is keyword-only until it finishes, and old vectors are deleted at once, so two models are never mixed. It counts as that hour's Re-index, except when the base's provider was removed, where it is the way back to full search.
- **Passage previews**: expand a source on a knowledge base to see each passage's heading and first 300 characters, 20 at a time. Only the owner and managers who can read that source see them.
- **Team → Groups** lists the knowledge bases, agents, and chats shared with a group, with titles only where the admin can open the item.
- **Search limit for keys**: `search_knowledge` through API and MCP keys is limited to 60 a minute and 2,000 a day per key. Re-index all's once-an-hour limit now survives restarts.
- **Group changes take effect at once**: joining or leaving a group re-checks the knowledge sources that depended on it immediately.
- **Chat is off for your role**: when your role can't chat, Chat says so instead of "not available on this server", and shared-chat notifications no longer link to a chat you can't open.
- **Fairer charging and clearer pushes**: in multi-step agent runs, text past the stored reply is no longer charged; push notifications say what kind of notice they are instead of always "Calendar reminder".
- No migration and no new settings.

## v0.32.0 — 2026-10-07

- **Notifications open what they are about**: a removed or lowered share opens that note, folder, file, board, collection, agent, chat, or knowledge base; one Inbox proposal opens that proposal; group, key, sign-in, and Google notices open the right Settings page. Links are built from ids only, and an item you can no longer open shows its list instead. A click in the bell on the first page you opened is no longer undone.
- **Feed links and routines in access pages**: on a member's access page an admin can **Revoke** a calendar feed link and **Pause** a routine (only the owner resumes it); both are recorded in Access activity and tell the member on the bell. **Settings → My access** lists your own feed links and routines with Revoke and Pause/Resume; viewers can revoke their own feed links.
- **Phones**: Tasks and Collections headers take two rows instead of three, with the view switch, filters, and actions in one row that scrolls sideways; the whiteboard load-error buttons are full-size.
- **Settings polish**: each Settings → AI tab has its own browser title and the phone back arrow steps over tabs; Chat policy labels sit right above their controls; no stray focus ring on headings after a click or link; duplicated section headings removed; integration pages no longer say "Google sign-in is linked".
- **Chat**: a Nook key hidden in a tool-server credential (Basic auth, base64, URL-encoded) is refused; "Load image" explains a refused (non-https) link without a request; a reply cut for length is charged only for the text kept; "Chat is off for your role" says why an answer stopped; busy responses carry `Retry-After`; resuming a finished reply ends cleanly; headless Chrome shows as Chrome in Recognised devices.
- No migration and no new settings.

## v0.31.0 — 2026-10-07

- **Formatted agent replies**: headings, bullet and numbered lists (they show again), task lists, tables with a header row that scroll inside the bubble on phones, block quotes, code with Copy, strikethrough, footnotes, and links, in chats, shared chats, public links, and the Audit log. Your own messages stay plain text.
- **Images in replies**: pictures from your Nook files and images embedded in the reply show in the bubble; tap one to view it larger. An outside picture shows as a card with its site and **Load image**: Nook fetches it for you only from a public https address, checks that it is a real image (PNG, JPEG, GIF, or WebP, up to 5 MiB, never SVG), and loading it sends its address to that site. Public chat links never load outside pictures.
- **Pictures from tools**: images an MCP tool returns now show in the tool's details instead of being dropped; each is stored once and counts toward the chat owner's storage.
- **Pick a provider per agent**: the agent editor has a **Provider** choice (Default, or any provider an admin added) and model suggestions from that provider; the agent list shows the provider and the model in use.
- **New sign-in alerts**: an email and a bell notice when your account signs in from a browser it hasn't seen before, with the time, the browser, and how you signed in. **Settings → Security → Recognised devices** lists your browsers and lets you forget them. Nook stores a hashed browser cookie and a browser/OS label, never your IP address. Existing accounts quietly record their first browser after the upgrade.
- **Welcome email** for new accounts, once, about a minute after their first sign-in, using your `APP_NAME`.
- **Fixes**: in a new chat the message box sits at the bottom and the chat header spans the full width; vault rate limits report an exact `Retry-After`, group grants are named in vault Activity, and the daily volume alert shows once.
- Migrations 043 and 044 run on the first boot, so back up first. No new settings. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.30.0 — 2026-10-07

- **Knowledge bases**: in **Settings → Knowledge**, gather published notes, text, Markdown, or CSV files from Files, and pasted text into a base. Nook indexes them in the background and keeps them current when a note is republished. **Try it** shows the best passages with where they came from (for example "Billing › Refunds").
- **Agents that know your material**: tick a base in an agent's **Knowledge** tools and the agent searches it while answering; the chat shows **Searched knowledge** with the passages it used. Search combines meaning and keywords, and falls back to keywords when the provider is unavailable or the budget is spent.
- **Sharing**: share a base at **Can view** (search it) or **Manager** (also add sources, rename, re-index, and attach it to agents). Attaching a base to an agent needs manage. People who can't open a source note see its passages without its title.
- **Always current access**: a note or file that is unshared, moved to the Bin, or deleted stops appearing in search at once, and a blocked owner's bases stop answering. If a base's embedding provider is removed, the base switches to keyword search and says so; Nook never sends its text to another provider.
- **API keys**: Chat → Read can be limited to chosen knowledge bases, giving a key that can only `search_knowledge` over MCP or `/api/v1/tools`.
- **Fixes**: the Add source sheet scrolls with its buttons always in view; dialog footers no longer let rows show beneath them.
- Migration 042 runs on the first boot, so back up first. No new settings. Indexing sends each source's text to your default AI provider's embeddings endpoint, and each search sends the query. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.29.0 — 2026-10-06

- **Share agents and chats**: share an agent or a chat with people, groups, or everyone signed in, at **Can view** or **Manager**, from the Access sheet. People you share a chat with read it live: new messages, renames, and unshares reach their open page at once, and **Continue as a copy** starts their own chat. A shared agent always runs with the runner's own access, never the owner's. Optional **public chat links** (a read-only snapshot anyone with the link can open) stay off until an admin allows them in Settings → AI.
- **Tabbed settings pages**: Settings → AI has **Model providers**, **Tool servers**, and **Chat policy** tabs, and Settings → API keys has **General**, **Vault**, and **Agents** tabs, each with its own address, a count, and New key starting from the tab you are on. Browser Back and Forward move between tabs.
- **Vault**: saving, importing, clearing, or restoring values in a protected environment no longer asks for your password; seeing, copying, or exporting values still does. Saving a new value keeps the value's comment unless you type a new one.
- **Agents**: an emoji picker (search, recently used, remove) when creating or editing an agent. The empty Chat screen has a proper **Create an agent** button, and admins without a model provider get a link to add one.
- **Consistent look**: every New/Add button in Settings is the same size; text boxes, multi-line boxes, and dropdowns share one border, one focus ring, and one font; dialog labels and footer buttons match everywhere.
- **Fixes**: long dialogs (Add provider, Add tool server, New API key, Link Nook key) scroll with their buttons always visible, including on short laptop screens; short dialogs on phones no longer stretch; icons no longer drop above button labels (the vault generator's **Again**, **Sync tools**); Vault settings is wider; idle live updates no longer drop every 12 seconds.
- Migration 041 runs on the first boot, so back up first. No new settings. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.28.0 — 2026-10-06

- **Run agents from scripts and CI**: create an API key in Settings → API keys with **Chat → Run agents** (on all your agents or chosen ones) and call `POST /api/v1/agents/<id>/runs` with `{"input": "…"}` or a short `messages` conversation; add `"stream": true` for server-sent events. `GET /api/v1/agents` lists what the key may run (never the system prompt). MCP clients get `run_agent` and `list_agents`. These runs never create chats.
- **Only safe tools run unattended**: API runs use only tools set to run on their own; anything that would ask first is never offered, and Nook writes stay Inbox proposals.
- **Audit log** (Chat → Audit log): every API and MCP run with its input, steps, tool calls and results, output, tokens and timings, filterable by key, agent, status and date (filters live in the address), exportable as JSON. Admins see metadata only, never content. Kept 30 days by default (`AGENT_AUDIT_RETENTION_DAYS`, 7–365); records cannot be edited.
- **Limits per key**: 2 runs at a time, 20 a minute, 500 a day, plus your own and the instance's run slots and token budgets. A revoked key stops a run within about 2 seconds, even mid-answer; cancelled and stopped runs are charged for what they used.
- **No agent loops**: `run_agent` is refused inside a run, tool servers may not hold Nook keys, keys linked to an agent cannot run agents, and Nook marks outbound tool calls so a server that forwards the mark is refused calling back.
- Migration 040 runs on the first boot, so back up first. New optional setting: `AGENT_AUDIT_RETENTION_DAYS`. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.27.0 — 2026-10-06

- **Tools for agents**: an admin adds MCP tool servers in **Settings → AI → Tool servers** (a Streamable HTTP URL and an optional credential stored encrypted), syncs their tools, and sets each tool's policy: runs on its own, asks first, or off. Anyone allowed picks tools for their agents in **Settings → Agents**.
- **Nook's own tools, through your key**: link one of your own API keys to an agent and pick Nook tools (notes, tasks, collections, calendar…). They run only with that key's permissions, never your full account, and stop at once if the key is revoked, expires, or loses a permission.
- **You stay in charge**: any tool that can change something shows a card in the chat (**Allow once** or **Deny**); unanswered cards expire after 15 minutes. Nook writes become **Inbox proposals** by default, so nothing changes until you approve. Each card is tied to the exact call you saw, and a server or policy that changes while a card waits stops the call.
- **Tool results are treated as untrusted**: fenced and cut to a size cap before the model sees them; the chat shows what was called and what came back.
- **Safe connections to tool servers**: the same rules as model providers (https, private addresses refused unless listed, no redirects, size and time limits, the address pinned), checked when a server is saved and on every call.
- **Local tool programs (stdio)** stay off unless the host sets `AGENT_MCP_STDIO=on` with `AGENT_MCP_STDIO_FILE`; turning them on gives those programs full trust (they can read Nook's keys and data). A separate HTTP bridge container is the recommended way.
- No migration. New optional settings: `AGENT_MCP_STDIO`, `AGENT_MCP_STDIO_FILE`. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.26.0 — 2026-10-06

- **Chat (first slice)**: chat with your own agents through any OpenAI-compatible model provider. An admin adds a provider in **Settings → AI** (base URL, API key, default model; the key is stored encrypted and never shown again, only its last characters) and sets who may chat and daily token budgets. Anyone allowed creates agents in **Settings → Agents** (a system prompt, an optional model, and a step limit) and chats with them in the new **Chat** app: replies stream in as they are written, **Stop** keeps what arrived, **Regenerate** and **Edit** keep every version with a 2 / 3 switcher, chats are searchable, pinnable, renamable, and go to the Bin. Two columns on a computer; list and chat screens with working Back on a phone.
- **Safe rendering**: replies are Markdown (tables, code with Copy, lists) built without HTML strings; images are never loaded, and outside links open through a sheet that shows the full address.
- **The first outbound connection Nook makes**: only to the providers an admin configures, https only (plain http only for hosts listed in `AGENT_ALLOWED_PRIVATE_HOSTS`), private and loopback addresses refused unless listed, no redirects, size and time limits, the address pinned between the check and the connection, and no cookies or Nook headers sent.
- **Private in this release**: agents and chats are their owner's alone; tools, the external API and Audit log, sharing, and knowledge bases follow in the next releases.
- **For developers using MCP**: `list_agents`, `list_chats`, and `get_chat` for keys with the new `agents:read` permission (your own agents and chats only).
- **New settings**: `AGENT_SECRETS_KEY` (or `AGENT_SECRETS_KEY_FILE`; Chat is off without it), `AGENT_ALLOWED_PRIVATE_HOSTS`, `AGENT_MAX_CONCURRENT_RUNS`, `AGENT_RUN_TIMEOUT_S`. `bun server/agent-admin.ts verify-key | rotate-key` checks and rotates the key.
- Migration 039 runs on the first boot, so back up first: it adds the Chat tables and rebuilds the API key grants table once so keys can be granted Chat (and, later, Messages) permissions; every existing key and grant is kept exactly. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.25.0 — 2026-10-05

- **Your own app name**: set `APP_NAME` (for example `APP_NAME=Acme Notes`) and the name appears in every tab title, in link previews when you share a URL, in the installed app's name, in email subjects and the sender name, in the two-factor issuer, and across the app's own screens. Leave it unset to keep "Nook". Internal ids and key prefixes never change.
- **Bin inside Settings**: the Bin is a Settings section now (Workspace → Bin, with its item count). Old `/bin` links still open it. Guests, who can delete nothing, don't see it.
- **A slimmer top bar**: Settings · Inbox · bell · your name · Sign out. The Bin and Team buttons are gone (both live in Settings); admins see the blocked-account count on Settings → Team → Members instead.
- **Fixes**: browser Forward onto a hidden entry after turning a module off no longer leaves the address and the screen out of step (the app's history listener was being re-registered on every render); the Bin is fetched once when opened.
- No migration. `APP_NAME` is the only new setting. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.24.0 — 2026-09-30

- **Vault API keys (`nkv_`)**: a separate kind of API key for scripts, CI, and AI clients that reach only the Vault. Create one in Settings → API keys with **Kind: Vault key**, choosing vaults and environments you can reach yourself, at read or write. A vault key never reaches other modules, and a general key never reaches the Vault, at the API and in the database. Its rights are always your rights at that moment: lose access, and the key loses it too; blocked, and the key stops.
- **Protected environments over keys**: "every environment" never includes a protected one. A key reaches a protected environment only when the grant names it and the key was created with **Allow protected environments** (your password and code at creation stand in for the re-auth window). Protect an environment later and every key that did not name it loses it.
- **REST**: `GET /api/v1/vault/vaults`, secrets, values (`GET`/`PUT` with `expectedVersion`), and version metadata, Bearer only, JSON only, `no-store`. **MCP**: vault keys see only the vault tools (`list_vaults`, `read_vault`, `list_secrets`, `read_secret`, `write_secret_value`, `create_secret`); values go to an MCP client only when the key has **Allow MCP clients to read values** on, and the dialog suggests MCP-only surfaces for such keys.
- **Limits and alerts**: per key, 20 reads a minute and 1,000 an hour, 10 writes a minute and 200 a day, 60 values an hour over MCP, never charged to you. A key that hits a limit, or reads more than 500 values in a day, shows in your bell and in the vault's Activity, once a day.
- **Where keys show**: the vault's Access page lists **Keys with access** (owners see each key; other members see the count and their own), Activity shows `key:<name>` actors with an "API keys" filter, and Team → Keys has a Kind filter that shows vault keys as counts only, never vault names. Members who don't manage access get a read-only Access page.
- **Independent review**: the whole Vault (v0.20.0–v0.24.0) had an independent security review before this release; no HIGH finding, and every MEDIUM was fixed.
- Migration 038 runs on the first boot, so back up first: it only adds (a protected-access flag on keys, a per-environment protected mark on grants, key names on vault events, an index, and triggers that keep vault grants on vault keys). See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.23.0 — 2026-09-30

- **Settings is a full page**: a left nav with an Account group (Security, Notifications, My access, API keys, Modules, About) and a Team group (Members, Invites, Groups, Integrations, Keys, Policies, Templates, Access activity, Email log), each section filling the rest of the screen and scrolling on its own. Team lives inside Settings now; the old `/team/...` links still work and open the same screens. On a phone, Settings opens as a list; a section opens on its own screen with a back arrow, and browser Back returns to the list, then to where you were.
- **Top bar order**: Bin · Team · Settings · Inbox · bell · your name · Sign out, with Sign out as the rightmost action on every screen.
- **Leaving with a new key on screen** asks first everywhere: switching section, the back arrow, Home, Bin, Inbox, the bell, Sign out, and browser Back or Forward.
- No migration and no new settings. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.22.0 — 2026-09-30

- **Shared vaults**: a vault's owner shares it with people and groups per environment at none, read, write, or admin (viewers read at most; guests and integrations never). The Access page is a people × environments grid on a computer and cards on a phone, with a leave guard for unsaved changes. Owners can hand a vault over in one save, and a vault always keeps one owner. Admins who are not members still see nothing: not the name, not the activity.
- **Protected environments**: `prod` is protected by default. Revealing, editing, exporting, or reading the history of a protected environment asks for your password (and code) again, once per 15 minutes per session; a stolen session cookie cannot read it.
- **Import and export**: `.env`, JSON, and CSV, with a preview of what will be created, updated, or skipped; exports are limited to ten an hour, recorded in Activity, and CSV cells that look like formulas are neutralised.
- **Data-key rotation**: whenever anyone loses read on an environment (removed from the vault, from a group, blocked, or demoted to guest), the vault's data key is rotated in the background and the owners get a bell notice to rotate the real credentials upstream, with "Show what they read". Rotate on demand from the vault's settings.
- **Activity and history**: an Activity page per vault (who did what, counts, never values), a version-history dialog with Show and Restore, a tag filter, "Shared with me" on the vault list, and a 64 MiB storage quota per vault creator.
- **For developers using MCP**: still no vault tools; `nkv_` keys, REST, and MCP tools come in the next release.
- Migration 037 runs on the first boot, so back up first: it only adds (a re-auth timestamp on sessions, the vault's stored bytes, two columns on vault events, and a trigger that keeps integrations out of vaults). See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.21.0 — 2026-09-30

- **Connected whiteboards**: pictures from Files on the canvas (insert from your files, upload, or drop; a shared board never shares its pictures, so viewers need the file shared too), links from any shape to a note, card, row, file, or board (or an outside link, opened only after a confirm), a **whiteboard card in a note** (type `/whiteboard`; readers without access to the board see only "Whiteboard unavailable", and the note's Markdown never carries the board's name), **History** with previews and Restore (editing is blocked while a restore runs; nothing drawn meanwhile is lost), **Duplicate**, **Import** of `.excalidraw` files (pictures embedded in the file become Files in the board's folder), SVG export, and whiteboards in the search screen.
- **Never unsavable**: if a picture's file is unshared or deleted, the board takes it off with a message and saves; the half-hourly snapshot is skipped rather than refusing a save when storage is full; a restored version drops pictures you can no longer open.
- **Phones**: tapping a shape's link icon works for outside links too; History, pickers, and confirms close with Back.
- **For developers using MCP**: no new tools; `read_whiteboard` now returns picture references as document ids.
- No migration in this release. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.20.0 — 2026-09-30

- **Vault (first release)**: a new app for your services' secrets, with environments (dev, staging, prod, or your own). Each secret holds one value per environment, with an encrypted comment, twenty kept versions, and the Bin. On a computer it is a secrets × environments grid; on a phone, one environment's cards, picked with the app's own selector and kept in the URL. Values stay masked until you press **Reveal** and hide again after 30 seconds, when the tab is hidden, or when the dialog closes; **Copy** clears the clipboard after 30 seconds unless you copied something else since. The editor masks the value too, with a Show toggle. A generator makes passwords, hex and base64url tokens, and six-word passphrases in the browser. Saving into several environments at once checks every environment's version, so nobody's newer value is overwritten silently.
- **Honest labelling**: **encrypted at rest; anyone with the server and its key can read every secret.** The Vault is for your services' credentials, not a replacement for a personal password manager. Values and comments are encrypted with AES-256-GCM under a per-vault data key wrapped by `VAULT_ENCRYPTION_KEY`; names and tags are plain so you can search them.
- **Off until you set a key**: set `VAULT_ENCRYPTION_KEY` (`openssl rand -base64 32`, different from `TOTP_ENCRYPTION_KEY`) or `VAULT_ENCRYPTION_KEY_FILE` (a file outside the data directory, so backups never contain it). Without it, members see nothing and admins see a "not configured" screen. `bun server/vault-admin.ts verify-key` checks the key; `rotate-kek` re-wraps the data keys under a new key read from a file, refuses while a server is running, and prints fingerprints, never the key. See [docs/OPERATIONS.md](docs/OPERATIONS.md#vault).
- **In this release each vault is its owner's alone**: another member, a viewer, a guest, or an admin who does not own it gets "not found" everywhere. Sharing with people per environment, import and export, `nkv_` API keys, and MCP tools come in the next two releases.
- **Also**: SQLite now runs with `secure_delete` on for every module, so deleted rows are overwritten instead of lingering; the server writes a `server.heartbeat` file in the data directory while it runs.
- **For developers using MCP**: no new tools; no key can reach the Vault yet.
- Migration 031 runs on the first boot, so back up first. It only adds tables; its number is lower than 032–036, which your instance already applied (expected: each migration runs by its own number). See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.19.0 — 2026-09-30

- **Integrations (service accounts)**: admins can set up accounts for AI clients and scripts that act as themselves rather than as a person: a CI job that posts results, a bot that files cards, an agent that reads a shared folder. **Team → Integrations** creates one with a name and a role (member or viewer), and admins create, rotate, narrow, and revoke its API keys there, with their own password. An integration **never signs in**: every sign-in path (password, reset, invite, Google) refuses it, and it gets no email or bell notifications.
- **Reach only what is shared with it by name**: an integration is never part of "everyone signed in" and cannot join a group, so its keys reach only the notes, files, boards, collections, calendars, and whiteboards owners share with it explicitly from the Access sheet, where it appears under **Integrations** with a robot icon and an **Integration** badge. Because admins hold its keys, the sheet says so: *Admins hold its keys and can read what you share with it.* Admins still never read anything that was not shared with the integration.
- **Attribution**: cards, comments, note versions, and whiteboards created through an integration's key show its name with the badge. Team → Keys lists the keys with the integration as owner. `GET /api/v1/me` reports `owner.kind: "service"` for such keys.
- **Blocking and deleting**: block pauses its keys at once; delete revokes them and removes the account when it never had a key and created nothing, otherwise keeps it as **Deleted (kept for attribution)**, which can never be unblocked or re-keyed.
- **Leaving with a new key on screen** now asks first on the integration's page too, including browser Back on phones.
- **For developers using MCP**: no new tools; there are no tools that create or manage integrations or their keys.
- Migration 036 runs on the first boot, so back up first. It only adds (a description and a retired marker on accounts, and database triggers that keep integrations out of sessions and Google sign-in). Nothing about existing people or keys changes. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.18.0 — 2026-09-30

- **Keys limited to chosen items in every module**: an API key can now be limited to chosen folders and notes, folders and files, boards and saved views (only views you own, read only), collections, calendars, routines, and whiteboards. Every tool checks each item it touches: anything outside the key's choice answers "not found" as if it did not exist, and lists, search, Today, and counts include only the chosen items.
- **A REST API for keys**: scripts and CI jobs can call the same tools as MCP over plain HTTPS: `GET /api/v1/me` (what the key can do), `GET /api/v1/tools` (the tools it may call, with their input schemas), and `POST /api/v1/tools/<name>` with a JSON body of the tool's arguments. The tools, arguments, results, limits, and rules are the same as over MCP. Send the key only as `Authorization: Bearer <key>`; a key in a URL is refused. Every error has a stable `code` (`AUTH_REQUIRED`, `KEY_INVALID`, `KEY_POLICY`, `IP_NOT_ALLOWED`, `KEY_IN_URL`, `NOT_FOUND`, `RATE_LIMITED`, and for file uploads `UPLOAD_NOT_FOUND`, `UPLOAD_CONFLICT`, and `UPLOAD_FAILED`; see [docs/USING.md](docs/USING.md#the-rest-api)). For example:

  ```sh
  curl -s -X POST "https://<your nook>/api/v1/tools/list_boards" \
    -H "Authorization: Bearer <YOUR_API_KEY>" -H "Content-Type: application/json" -d '{}'
  ```
- **Where a key is used**: each key says whether it works over MCP (the default), REST, or both. Editing a key can only narrow this, without a password; to widen it, rotate the key or create a new one. Per-minute limits and "last used" are kept for each surface, so a busy script does not slow your AI client down. Admins decide which team roles may use REST and MCP in **Team → Policies** (REST: admins and members by default).
- **Address limits for keys**: a key can be limited to up to ten IPv4 or IPv6 addresses or ranges. This is offered only when the server sits behind a reverse proxy it trusts (`TRUSTED_PROXY_HOPS` of 1 or more). A refused call shows on the owner's key row ("Last refused …") and in its **Recent activity** section, with a shortened address; admins see it in Team → Access activity, without the address.
- **Rotating can change access**: because rotating asks for your password, it can now also change the new key's access, where it is used, and its allowed addresses, including widening them. **Edit** still only narrows, for example from all boards to chosen ones.
- **New optional setting `TRUSTED_PROXY_ADDRESSES`**: the addresses or ranges your reverse proxy connects from. When set, forwarding headers are read only from those proxies. Set it as soon as `TRUSTED_PROXY_HOPS` is 1 or more; otherwise Nook logs a warning at startup and the app port must be reachable only through the proxy (for example `"127.0.0.1:2026:2026"` in `compose.yaml`).
- **Small fixes**: on a computer the Team pages and the Inbox scroll the list and the details separately; the Home header stays in place while Today scrolls; member pages no longer log a console error while Google sign-in is off; Back after deleting a note or file from its list no longer takes an extra step; the **Publish version** button is larger on phones; End, Home, PageDown, and PageUp scroll the Files list and long notes; an open Access sheet stops offering guests once sharing with guests is turned off; and Access activity lines read as sentences.
- **For developers using MCP**: there are no new tools, and no tool on either surface deletes forever, shares, or manages keys. Invalid arguments now name the argument on every tool (`"cardId: Invalid UUID"`), the `Bearer` scheme is accepted in any letter case, and every key that does not authenticate (mistyped, expired, rotated, or revoked) answers the one code `KEY_INVALID`; the reason is shown only to the key's owner.
- **Not in this release**: service accounts.
- Migration 033 runs on the first boot, so back up first. Existing keys are unchanged: they stay MCP-only with no address limit, and REST is off on new keys until chosen. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.17.0 — 2026-09-30

- **Whiteboards**: a new app for sketches, diagrams, and floor plans, built on the Excalidraw editor: shapes, arrows, lines, freehand drawing, text, colours, undo and redo, and Mermaid diagrams turned into shapes. The editor ships inside Nook and runs entirely from your own server: it makes no requests to other sites, its fonts are included, and the content security policy is unchanged. A browser downloads it only when someone opens a board.
- **Boards live in Files**: each board is a `.excalidraw` file in one of your folders and appears in the Files list with its own icon. You can rename it, move it to another folder, download the `.excalidraw` file, export a PNG, or delete it to the Bin and restore it from there. Boards count toward your storage.
- **Saving**: changes save by themselves, at the latest every 5 seconds while you keep drawing. When the connection drops, a copy of your unsaved work is kept on the device and sent when the connection returns, even if you do not reopen the board. Leaving the page right after drawing keeps the change.
- **Two devices**: if a board changed on another device, Nook asks whether to **Reload latest** or **Save mine as a copy**; nothing is overwritten silently.
- **Safety net**: when a save empties a board, or leaves a board of 10 or more shapes with fewer than half of them, the version before is kept (the newest five per board), and the owner can bring it back with **Restore previous version**.
- **Sharing**: share a board with people and groups through the Access sheet. Only the owner edits; everyone else gets a view-only canvas with a banner naming the owner.
- **Search**: board names and the text on boards are indexed. For now you can search them through the web API and the MCP tool `list_whiteboards`; the Search screen in the app does not show whiteboards yet.
- **Around the app**: Settings → Modules has a Whiteboards row (on by default), Today lists recent whiteboards, and on phones pinching zooms the canvas, not the page.
- **API keys and MCP**: two new key permissions, **Read whiteboards** and **Create whiteboards**, and a key can be limited to chosen boards. New MCP tools `list_whiteboards`, `read_whiteboard`, and `create_whiteboard`; no tool edits, deletes, or shares a board. Existing keys gain nothing.
- **Not in this release**: images on the canvas, links from shapes to Nook items, embedding a board in a note, a full version history, importing `.excalidraw` files as boards, SVG export, and a whiteboards filter in the Search screen.
- Migration 030 runs on the first boot, so back up first. The Docker image grows by about 26 MB. No new settings; if you ever changed the key modules in **Team → Policies**, tick Whiteboards there before keys can use it. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.16.0 — 2026-09-30

- **Long pages scroll again (fix)**: Team pages (members, Policies, Keys, Access activity, Groups, Templates, Invites, a member's Access page, the email log), the Bin, Inbox, Routines, Notifications, the Calendar month on a computer, the Files list and grid on phones, and the sign-in pages on a phone held sideways could not be scrolled with the mouse wheel, touch, or the keyboard, so controls below the first screen (for example **Save policies**) could only be reached with the Tab key. They all scroll now.
- **Faster loading**: the app's files are now cached by the browser and sent compressed. Files whose names change with each release are kept for a year; the app page, the service worker, and the manifest are checked on every load, so a new release is picked up at once. In our measurement, loading Home the first time dropped from about 1.9 MB to about 0.42 MB, and a reload from about 1.9 MB to under 1 KB. Nothing to configure.
- **No more browser pop-ups**: every confirmation (an API key you have not saved yet, discarding a draft, **Delete forever** and **Empty Bin**, leaving Files during an upload, turning off two-factor, new recovery codes) uses Nook's own dialog, which fits on phones and closes with the Back button. Leaving Files with the browser's Back button during an upload now asks first.
- **API keys**: creating or rotating a key offers **No expiry**, unless the team policy requires an expiry, in which case the choice is disabled and says why. While that policy is on, a key without an expiry is blocked (not revoked), and its row says "Rotate it to give it one." The API keys page is now **Settings → API keys** at `/settings/keys`; old `/settings/mcp` links still open it.
- **Notes**: **Move to folder…** moves the open note, on a computer (toolbar) and on a phone (the ⋯ menu).
- **Today**: Today asks once whether you want the morning email digest (**Every morning**, **Mondays only**, or **No thanks**). It appears only when email is on, your address is verified, your account is at least a week old, the digest is off, and you have not answered before.
- **Calendar and Files**: a muted calendar says **Muted** in words, not only with an icon; the Calendar header has a **Bin** button like the other apps; the Files list/grid toggle is larger on phones.
- **Access**: after sharing with a guest is refused, the Access sheet marks the guest rows that were kept right away; notices and invites word deleted groups and invite templates more clearly; the key filter in **Team → Access activity** shows the owner of keys that are no longer live.
- **Smaller fixes**: Back no longer repeats a step after you delete the note or file you were viewing; lists of boards, collections, and calendars need fewer database queries; a request for a missing file with an extension (such as `/favicon.ico`) now answers 404 instead of the app page; `/robots.txt` asks search engines not to index Nook; and if the app fails to load, a short message suggests reloading instead of an empty page.
- Migration 035 runs on the first boot, so back up first. No new settings and no new MCP tools; see [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.15.0 — 2026-09-29

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

## v0.14.0 — 2026-09-29

- **Member access**: admins open **Team → a member → Access** to see everything that person can reach, per kind, one row per item with each way they reach it (shared directly or through a group), plus how many items are shared with everyone signed in, their groups, and their API keys. Items the admin cannot open are shown without their title, as "Board owned by" and the owner's name.
- **Reduce only**: from that page admins can lower a level, remove a direct share, or take the person out of a group. Each change asks for confirmation, is recorded, and tells the item's owner or the person on the bell. Nothing on the page grants or raises access.
- **Reset access**: removes a person's direct shares and group memberships, revokes their API keys and calendar feeds, and pauses their routines, with counts shown before and after. Items the person owns are untouched. It is not offered on your own account.
- **My access**: **Settings → My access** (`/settings/access`) shows, read-only, what you can reach and through what. Guests do not have it.
- **Access templates**: **Team → Templates** holds a role and groups. Pick one on an invite and the new account joins those groups when it registers. An invite keeps the template as it was when the invite was made, so later edits do not change invites already sent; deleting a template leaves its invites working with their role and no groups. Applying a template to an existing member adds its groups and never changes their role. With sharing with guests off, a guest skips groups that have items shared with them.
- **Access activity**: **Team → Access activity** shows who changed whose access, filtered by person, group, key, and kind of change.
- **Bell**: the bell now tells you when you are added to or removed from a group, when an admin lowers, removes, or resets access (to your items, or yours), and when an admin revokes your API key. The Access sheet tells an owner how many of their API keys can reach the item.
- **Fixes**: the New group dialog focuses the name and checks it inline; wording fixes. No new MCP tools, and API keys cannot manage access.
- Migration 032 runs on the first boot, so back up first. Admins gain new powers to see and reduce access; see [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.13.0 — 2026-09-29

- **Passwords**: change your password in **Settings → Security** with your current password, plus a two-factor code when you use one; your other devices are signed out. With email on, **Forgot password?** on the sign-in page mails a single-use link that works for 30 minutes, and a security email says when a password was changed or reset. With email off there is no self-service reset and the links are hidden. Settings also says when two-factor cannot be set up because this Nook has no TOTP key.
- **Groups**: admins create groups in **Team → Groups** (`/team/groups`) and decide who is in them; owners share items with a group, and its members follow as people join or leave.
- **Levels**: each person or group gets a level: **Can view**, **Can comment** (boards), **Can edit**, or **Manager** (boards, collections, and calendars). People who can edit a note write its draft and publish it. Files and task views stay view-only for other people.
- **One Access sheet**: the **Share** button on notes, folders, files, boards, task views, collections, and calendars opens the same Access sheet. It warns before a change of audience drops people, and asks before discarding unsaved changes.
- **Sharing with guests**: **Team → Policies** has a switch for sharing with guests. While it is off, new shares that would reach a guest are refused, whether directly, through a group, by adding a guest to a group that already has shares, or by changing such a member to the guest role. What is already shared stays until its owner changes it, and can be lowered or removed but not raised.
- **Fixes**: viewers, commenters, and guests no longer see card actions they cannot use. On a page loaded directly, Back closes an open dialog at every width; dropdowns and pickers are their own Back step; Board settings and the Calendars sheet stay open under the dialogs they open. New Notes folders and links use the app's own name dialog instead of browser prompts. A routine's "due" state now follows the same clock as its next run time.
- **API keys**: structure tools on boards (rename and recolour tags, WIP limits, create and start sprints) work through a key only for the board's owner; a manager's key is refused. Creating a board tag now needs the edit level. No new MCP tools.
- Migration 029 runs on the first boot, so back up first. Some owner powers move to managers; see [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.12.0 — 2026-09-28

- **API keys**: Settings → API keys replaces Settings → MCP. Build a key one permission at a time (module, permission, and all or chosen boards, collections, or calendars) with an expiry within your team's policy. The token is shown once. Edits only narrow a key (rename, remove permissions, lower Write to Read, choose fewer items, bring the expiry closer); **Rotate** issues a new secret and lets the old one stop now or keep working for 1 hour, 24 hours, or 7 days. Each key shows its 14-day usage. A key limited to chosen items sees nothing outside them, including through relations, event links, and collection note fields. Existing MCP keys keep exactly the reach they had.
- **Team keys and policies**: **Team → Keys** (`/team/keys`) lists every live key for admins, never its secret, with **Revoke** and a reason the owner sees. **Team → Policies** (`/team/policies`) sets the longest and default key lifetime, keys per person, and which surfaces and modules each role's keys may use, with a preview of how many keys a change would block.
- **Email digests, reminders, and mutes**: a daily or weekly digest at your local time; calendar reminders by notification, email, or both; an email when an event you set a reminder on is changed or cancelled; optional sprint started and completed and Bin clean-up emails (off by default); and **Mute emails** per board or calendar, listed under **Muted** in Settings → Notifications → Email.
- **Bounces and complaints**: an optional Resend webhook (`RESEND_WEBHOOK_SECRET`) stops mail to addresses that bounce or report spam, with **Try again** once a day in Settings, and **Team → Email log** tags recipients whose mail is held back.
- **Fixes**: focus returns to the opener when Calendar and API keys dialogs close, phone Forward reopens a sheet that Back closed with no dead history step, deleting a note confirms in the app's own dialog, the header Bin badge refreshes after a restore or delete, reminder rows say how each reminder is sent, and mail subjects stay within their length cap after defanging.
- Migrations 025 and 028 run on the first boot, so back up first. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.11.0 — 2026-09-28

- **MCP write coverage**: three new opt-in scopes. `notes:publish` lets an agent publish a note draft it has read, `files:write` lets it upload files, store text files, create folders, and rename or move files, and `bin:write` lets it move items to the Bin and restore them (never forever). Existing keys gain nothing. Settings → MCP has a **Review** dialog per key listing what it binned, with **Restore all** for that key.
- **Routines and runs**: scheduled routines, at `/inbox/routines`, that your MCP agents run on a cadence. Each run is listed in its history with the proposals it made; pause and resume a routine at any time. Routine proposals reach the Inbox and, when email is on, your email.
- **Outbound email**: Resend via `RESEND_API_KEY` and `MAIL_FROM`, off unless both are set. Verified addresses, per-user email settings in Settings → Notifications → Email, one-click unsubscribe pages, and **Team → Email log** for admins. Templates cover invites, security notices, assignments, comments, shares, and proposals. Links in mail point only to `APP_ORIGIN`.
- **Fixes**: steadier ordering for rows created in the same millisecond, React 19 handler bugs, History and Back layering for dialogs and sheets, the phone Settings tab strip scrolls to the active section, 44 px phone targets, new cards go into the active sprint when none is given, note-draft proposals are compared with the draft the agent built on, a resumed routine does not re-run a slot that already ran, MCP `create_sprint` dates sprints by default, and an open note refreshes when its draft is published from the Inbox.
- Migration 026 runs on the first boot, so back up first. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.10.0 — 2026-09-28

- **Team invites**: admins create single-use invite links at `/team/invites`, optionally bound to one email address, with a fixed role. When email is configured, Nook sends the invite by email.
- **Outbound email** through Resend, off unless `RESEND_API_KEY` and `MAIL_FROM` are both set.
- **Emoji reactions** on card comments.
- **Agent inbox**: MCP keys with `inbox:read`/`inbox:write` propose changes instead of making them; you approve or reject each one in the app only, with a diff. Bulk approve, **Proposals awaiting you** on Today, an Inbox button with a badge, and opt-in push.
- **Review fixes**: rejecting a draft proposal restores your own draft; proposals from a revoked key are superseded; expiry is enforced on approve.
- **QA fixes**: the Settings → MCP checkbox no longer crashes, an app-wide error card replaces a blank page, phones show the page name, a chip marks stale proposals, and bulk approve names the proposals that failed.
- Migrations 018, 021, 022, and 027 run on the first boot, so back up first. See [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades).

## v0.9.3 — 2026-09-27

- **The task card opens as a drawer on desktop**: a full-height panel on the right, with the fields column on the left, the description and comments on the right, and the comment box pinned at the bottom. Phones are unchanged.
- **The card composer stays a centred dialog**, so creating a card works as before. No migration in this release.

## v0.9.2 — 2026-09-27

- **Today** is grouped into **Today**, **Recent work**, and **Housekeeping**, and empty sections fold away.
- **Tags** get distinct colours, and creating one is easy to find: the list opens on focus, with a **Create** row and **+ New tag**.
- **Due** is a picker with **Apply** and **Cancel** and quick picks; lane cards are tidier, and the card dialog is wider, with two columns on large screens.
- **Subtasks always belong to a task**: the parent field offers **Choose a task…**, and **Make it a task** turns a subtask into a task.
- **Sprint defaults per board** (duration, start rule, name pattern), **New sprint** from the header switcher, a dedicated **Sprints** page, and a prompt when no sprint is active.
- **Team** role changes and blocking no longer ask for your password; the session, CSRF check, and audit log still apply. Long dropdown lists scroll again. No migration in this release.

## v0.9.1 — 2026-09-27

- **Card descriptions size to their text** in the card dialog and the full-page card, growing as you type and scrolling past 60% of the screen.
- **Calendar month**: click an empty part of a day (or its **+**) to add an event on it; on a phone, tap the day, then **New event on <date>**.
- **Copy link** on cards (the card header and a board card's ⋯ **More actions**), without the view or filters, plus even spacing on the Tasks home. No migration in this release.

## v0.9.0 — 2026-09-27

- **Viewer and guest roles** with read-only enforcement on the server; `SIGNUP_ROLE` (default `guest`) sets the role of new accounts.
- **Task hierarchy and sprints**: subtasks, epics and stories, hierarchy templates, sprint planning, and a lighter board payload.
- **Tasks home** with My work and saved cross-board views. Migration 019 runs on the first boot, so back up first.
- **Review and QA fixes**: read-only roles can edit only their private views (with a Make private option for shared ones), Columns view says how many epics it hides with a Show all levels switch, focus moves into sheets and dialogs, and 44 px phone targets.

Earlier releases: [release notes](https://pankajsoni19.github.io/nook/#whats-new).
