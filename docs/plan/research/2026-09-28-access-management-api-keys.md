# Access management and API keys across modules: research and plan (2026-09-28)

**Operator request (TODO.md, verbatim):** "1. which modules need separate api key management, and updates to apis to enable granular role based usage and access management. access management could be driven in individual modules optional, but also should be able to drive it centrally via the teams module."

**Status:** Wave 31 (Access A: Nook keys, policies, the key inventory, migration 025) is built; Waves 32–34 are planned. Reserved: migration **025** (023 whiteboard and 024 vault are reserved; 018–022 exist or are merging), decisions **D261–D288**, threat rows **T200–T218** (the vault plan holds T180–T199 and D211–D230). The proposed wave numbers are **28–31** ("Access A–D"). TODO.md marks this work as a priority ahead of Waves 23–27, so the director may schedule it first and renumber.

**Rules this plan follows** (DEVELOPMENT_PLAN.md and the standing rules): append-only migrations with ids assigned up front; 404 for anything missing or forbidden; admins never bypass item ACLs (D73); a Team role is a ceiling and never a grant (D71); default-deny write gate (D75); effective key rights recomputed on every call (T81); custom Select/Combobox only (D91); mobile first with Back/Forward parity at 390 px; MCP tools for every module (D70); JSON only, bounded bodies; every wave releasable with backend and UI together; no new runtime dependency.

---

## 0. Summary of the proposal

1. **Which modules need separate API-key management? None needs its own key *system*.** One unified **Nook key** model replaces the per-module thinking: a key has an owner, an expiry, the surfaces it may use (MCP, REST, or both), and a **grant set** of `{module, permission, resource selector, env?}` rows. Its effective rights are **grants ∩ the owner's live access (Team role cap, item sharing, groups) ∩ org policy**, computed on every call. The **Vault** is the one module that needs a separate **key kind** (`nkv_`, vault grants only, never mixed with other modules; D221 stays). It lives in the same table, inventory, and UI, so the vault plan's separate `vault_api_keys` table is folded in before Wave 25 builds it. Calendar feed URLs and invite links remain capability tokens, because iCalendar clients cannot send a Bearer header. They are listed in the same central inventory.
2. **Module-level management stays in each module's share sheet**, which becomes one shared **Access sheet** (people *and* groups, each with a level). Per-person levels replace the audience-wide `share_role` where that matters. Boards gain viewer/commenter/editor/**manager**, Collections and Calendars gain **manager**, and Notes gain **editor** (draft and publish, never share or delete). Files stay view-only in v1. Folder sharing still does **not** cascade; §D.4 revisits the question and keeps that rule.
3. **Central management through Team:** **groups** (admin-managed; owners share with a group, and admins decide who is in it), a **member access page** (everything a person can reach, per module, with revoke and "reset access"), a **key inventory** across users with revoke, **org policies** (maximum key lifetime, require expiry, which modules each role may put in keys, MCP/REST per role, members creating groups), **templates** (role plus groups, applied on invite), and an **access audit** view. Admins still cannot *grant* access to content they do not own. Central granting always goes through group membership, which owners opted into when they shared with the group (D267).
4. **API:** one vocabulary (`view < comment < edit < manage < owner` for items; `read`, `comment`, `write`, plus the named restricted writes `draft`, `publish`, `bin` for keys; `admin` only as a Team role). Each item gets `GET/PUT /api/<module>/…/:id/access` (users and groups with levels) next to the existing `/sharing` routes, which stay as a compatibility subset. New routes: `GET /api/team/members/:id/access`, `/api/keys` CRUD with rotate, `/api/team/keys`, `/api/team/policies`, `/api/team/groups`, and a **REST surface `/api/v1/tools/:name`** that runs exactly the MCP tool specs (same scopes, resource filters, limits, and audit), plus `GET /api/v1/me`.
5. **Build first:** Access A (Wave 28), the unified keys with expiry, rotation, the admin key inventory, and policies. It is the smallest piece that makes key management central, and it is the base the vault's `nkv_` keys and resource-scoped keys need. Groups and the Access sheet (B) follow, then the Team member access page (C), then resource-scoped keys and REST (D).

---

## A. Inventory: today's access surfaces (verified in code, 2026-09-28)

### A.1 Session identity and Team roles

| Surface | Where | What it does |
| --- | --- | --- |
| Platform role `users.role` ∈ admin/member/viewer/guest | `server/team/roles.ts` `CAPABILITIES`, `can()` | A coarse ceiling. `content.write`, `sharing.write`, `files.upload`, `feeds.create`, and `mcp.key.create` for member+ (viewers keep `mcp.key.create` for read scopes); `team.manage` admin only. |
| Default-deny write gate | `server/team/writeGate.ts` `ROLE_READ_ONLY_ALLOWED_WRITES` | Viewers and guests get 403 `ROLE_READ_ONLY` on every non-GET `/api/*` except the allowlist. `/api/team/` is self-gated. |
| Guest audience exclusion | `AUDIENCE_ALL_USERS` fragment; grep guard test | Guests never match `all_users`. |
| Block | `users.disabled_at`, `team_events` (append-only; `action` CHECK list fixed in 017) | Kills sessions and pauses keys and feeds. |
| Invites (Wave 18) | `team_invites`, `server/team/invites.ts` | Single-use link with a fixed role; admins list and revoke. No groups or presets. |

### A.2 Per-item sharing, by module

| Module | Audience | Per-person level? | What a recipient can do | Tables |
| --- | --- | --- | --- | --- |
| Notes | private / selected / all_users, note override or inherit from the **immediate** folder | No | Read only (D2) | `note_shares`, `folder_shares` |
| Folders | same | No | See the folder and what inherits it; **no cascade** to subfolders | `folder_shares` |
| Files | same as notes (override or inherit); attachments reachable through a card or row link | No | Preview and download | `document_shares` |
| Task boards | private / selected / all_users | No: **every reader edits cards** (D38) | Create, move, comment, bin cards. Structure (columns, tags, WIP, sprints, sharing) is **owner only** | `board_members` |
| Task views (17C) | same | No | Read the saved query | `task_view_members` |
| Collections | same, plus `share_role` viewer/editor **for the whole audience** (D54) | No | Rows when editor; schema, views, import, and sharing are owner only | `collection_members` |
| Calendars | same, plus audience-wide `share_role` | No | Events when editor; reminders personal | `calendar_members` |
| Whiteboards (planned, 023) | via Files documents | No | View only (D195) | `document_shares` |
| Vault (planned, 024) | vault owner/member; per-environment none/read/write/admin | **Yes** (the only one) | D214–D216 | `vault_env_access` |
| Inbox and routines | private per user | n/a | n/a | `routines`, `proposals` |
| Bin | owner only | n/a | n/a | — |

Five near-identical share panels exist on the client (`src/files/FileSharePanel.tsx`, `src/tasks/BoardSharePanel.tsx`, `src/tasks/views/ViewSharePanel.tsx`, `src/collections/CollectionSharePanel.tsx`, `src/calendar/CalendarsDialog.tsx`, plus the notes panel in `src/App.tsx`), and five `GET/PUT …/sharing` route pairs (`server/index.ts:511,520,725,734`, `server/documents.ts:457,466`, `server/tasks/routes.ts:231,236`, `server/collections/routes.ts:129,134`, `server/calendar/routes.ts:138,143`). All take `{visibility, userIds ≤ 100}` and replace the member rows. Last write wins, with no CAS.

### A.3 Programmatic access

| Surface | Where | Model |
| --- | --- | --- |
| MCP keys `mynotes_…` | `mcp_api_keys` (005, 010), `server/mcp.ts`, `server/mcpScopes.ts` | Owner, name, prefix, SHA-256 hash, `scopes` JSON fixed at creation, `last_used_at`, `revoked_at`. **No expiry.** At most 10 live keys. Creation needs password plus TOTP. Effective scopes = stored ∩ `mcpScopesForRole(role)` on every request (`effectiveMcpScopes`) and every tool call (`loadLiveKey` in `runTool`). |
| Scopes | `MCP_SCOPES` | notes:read, notes:write-draft, files:read, tasks:read/write, today:read, calendar:read/write, collections:read/write, team:read (admin only), inbox:read/write (member only, D152). Wave 19 (building) adds notes:publish, files:write, bin:write, and an explicit `MCP_WRITE_SCOPES` list (D170–D172). Whiteboards plans whiteboards:read/write. |
| Limits | `server/mcpRateLimit.ts` | In-memory fixed windows, per key and per user: 120 calls and 30 writes a minute, plus daily buckets. Not configurable per key. |
| Audit | `withAuditContext({via:"mcp", keyId})`, `audit_log.metadata_json` | Writes carry `via` and `keyId`; reads are not logged. |
| Calendar feeds | `calendar_feeds` (per user and calendar, `busy`/`full`, hashed token) | A capability URL for iCalendar clients. |
| Vault keys `nkv_` (planned) | vault plan §5 and §7 | Separate table; grants (vault, env or all, level) ∩ the creator's live access ∩ role cap; expiry 90 days by default, 365 at most; REST `/api/v1/vault/*` plus MCP vault tools only. |
| Admin view of keys | `server/team/service.ts:67` | **Only a live-key count per user.** |

### A.4 Gaps

| # | Gap | Consequence |
| --- | --- | --- |
| G1 | **No per-resource scoping of keys.** A `tasks:write` key reaches every board the owner can reach. | Cannot give an agent "only the Ops board" (Linear and GitHub can [3][1]). |
| G2 | **No key inventory for admins**, only a count. No admin revoke apart from blocking the whole user. | No central incident response (GitHub's "Active tokens" page [2]). |
| G3 | **No expiry, no rotation.** Keys live forever. The vault plan invents expiry for its own table only. | Stale keys accumulate; rotation means creating a new key and remembering to revoke the old one. |
| G4 | **No org policies** (maximum lifetime, allowed modules per role, MCP off for a role). | GitHub-style governance [2] is impossible. |
| G5 | **No groups.** Every share is per person, up to 100 ids, per item. | Onboarding or offboarding a team means editing N items. |
| G6 | **No per-person levels** outside the vault. Collections and Calendar levels are audience-wide; boards have no read-only or comment-only members. | "Alice edits, Bob views" cannot be expressed. |
| G7 | **No "manager" role.** Board, collection, and calendar structure is owner-only. | The owner is a bottleneck; ownership transfer is the only workaround. |
| G8 | **No folder or space grants beyond one level**; no cascade (a deliberate rule). | Revisited in §D.4 (kept). |
| G9 | **No REST API for integrations.** MCP is the only programmatic surface (vault REST is planned). | CI jobs, n8n, and scripts must speak MCP. |
| G10 | **No per-key IP allowlist**, no per-key lower limits, no usage history (only `last_used_at`). | Leaked CI keys are usable from anywhere; there's no activity signal. |
| G11 | **No central "what can this person reach"** view. | Offboarding and reviews are guesswork. |
| G12 | **No integration identity** distinct from a person (bot or service account). | Keys die with their owner's account; owners cannot share an item "with the integration" (Notion's model [4]). |
| G13 | `team_events.action` is a fixed CHECK list (017). | New access events need a new table, because an append-only migration cannot rebuild it. |

---

## B. Research: how others model granular access and central administration

| Product | Token model | Resource scoping | Per-resource levels | Central admin | What Nook takes |
| --- | --- | --- | --- | --- | --- |
| **GitHub fine-grained PATs** [1][2] | Per user, a resource owner (user or org), expiry | "All repositories" or **selected repositories** | Per permission family: no access / read / write / admin | The org sets a **maximum lifetime** (default 366 days) and can require approval. Non-compliant tokens are **blocked, not revoked**. Owners list **Active tokens** and revoke in bulk; the holder is emailed. | The resource-plus-permission matrix; the owner ceiling ("cannot grant additional access"); policies enforced at call time; the admin inventory with revoke and notification. |
| **Linear** [3][5] | Personal API keys, plus OAuth apps with `actor=app` | A key can be **limited to specific teams** | Key permissions Read / Write / Admin / Create issues / Create comments | Workspace admins; private teams | The narrow "create only" and "comment only" permissions (Nook already has `write-draft`); team-level scoping as container selectors. |
| **Notion** [4][6] | Integration token (internal) or OAuth (public) | **The page is shared with the integration**; children inherit | Full access / Can edit / Can comment / Can view; "Can edit content" on databases (rows, not structure) | Workspace owners, permission **groups**, membership admins; the highest permission wins | Share-with-integration (D287, service accounts); the four-level ladder; "edit content, not structure" is exactly editor vs manager. |
| **Slack** [7][8] | Bot `xoxb`, user `xoxp`, app-level `xapp`; workflow tokens expire in 15 minutes | Channels the bot is a member of | Per-scope OAuth | Admins **approve or restrict apps and individual scopes**; org-wide policies | Bot identity that survives its installer (G12); admin allowlisting of modules and scopes per role. |
| **Infisical** [9] | Machine identities with short-lived access tokens | Per project, per environment | Roles | Central dashboard, expiry alerts | Identities as first-class principals; expiry alerts (email wave). |
| **Doppler** [10] | Service tokens | **One config** (project + environment) | Read by default, write opt-in | Tokens listed per config | Env selectors for vault grants; read as the default level. |
| **Bitwarden / Vaultwarden** [11] | — | Collections | View / View except passwords / Edit / **Manage collection** | Admins create **groups** and assign collections to groups | Group → container → level; "manage" as a distinct level. |
| **Nextcloud** [12][13] | Per-device **app passwords**, shown once, revocable per device | Shares to users and **groups**; group folders | Read, Write, Create, Delete, Share per user or group, inherited; **allow beats deny** | Admins create group folders and delegate management | Groups in share sheets; per-device keys; no deny rules (allow-only is simpler and safe). |

**Patterns extracted**

1. **Resource-scoped tokens with an owner ceiling** (GitHub, Linear, Doppler, vault plan): effective = token grants ∩ owner's access. Nook already does this for roles (T81); extend it to resources.
2. **A permission-per-resource matrix** instead of a flat scope list: rows are modules, columns are levels, and each row has "all" or selected resources.
3. **Org policies enforced at call time**: max expiry and allowed scopes. They block non-compliant tokens without deleting them, so tightening a policy is reversible.
4. **Central inventory plus revoke, and notify the owner.**
5. **Groups as the unit of central administration**; owners share with groups and admins manage membership (Bitwarden, Nextcloud, Notion).
6. **Separate "edit content" from "manage structure"** (Notion databases, Bitwarden Manage collection).
7. **An integration identity that is a principal you share with** (Notion connections, Slack bots, Infisical identities), rather than a person's key.
8. **Allow-only, highest level wins** (Notion, Nextcloud): no deny rules, so there is no precedence puzzle.

---

## C. Proposal for Nook

### C.1 Decisions

| # | Decision | Why |
| --- | --- | --- |
| D261 | **One key model ("Nook keys")** in the existing `mcp_api_keys` table, extended in migration 025. Code names it `apiKeys`; the table is not renamed (append-only migrations, internal ids keep `mynotes`). | Keeps every foreign key (`routines.key_id`, `proposals.key_id`, `notes.draft_mcp_key_id`, `notifications.proposal_key_id`, `*.updated_via_key_id`) valid. |
| D262 | **Grants are rows** in `api_key_grants` `{module, permission, resource_kind?, resource_id?, env_id?}`, not a JSON column. NULL resource = every resource in the module, including future ones. Existing keys are **backfilled** with one grant per stored scope over "all", so no key gains or loses power. `scopes` stays written as a mirror for one release (rollback), then is ignored. | Indexed "which keys reach board X" (central page, purge cleanup); matches the vault plan's normalised grants; a JSON column cannot be queried cheaply. |
| D263 | **Effective right** for a key call on resource r = key live ∧ not expired ∧ not blocked by policy ∧ surface allowed ∧ scope ∈ `mcpScopesForRole(role)` ∩ `policyScopesForRole(role)` ∧ ∃ grant covering (module, permission, r) ∧ the owner's **live** level on r ≥ needed. Recomputed on every call; nothing cached across calls. | T81 extended to resources and policies (T201, T202). |
| D264 | **Key kinds:** `general` (prefix `mynotes_`, unchanged) and `vault` (prefix `nkv_`). A CHECK plus a trigger enforces that vault grants exist only on vault keys and vault keys hold only vault grants. The vault plan's `vault_api_keys` and `vault_api_key_grants` are **replaced** by these tables (amend it before Wave 25). | One inventory and one policy engine, while the vault keeps its separate blast radius (D221, T217). |
| D265 | **Keys never manage access.** No grant, tool, or REST route lets a key change sharing, groups, members, policies, or other keys. `manage` and `share` are not key permissions. | Prompt-injected agents cannot widen access (T200 family); matches the vault's D219. |
| D266 | **Item level ladder** `view < comment < edit < manage < owner`. Allow-only, and the highest applicable grant wins (direct, group, or audience), always capped by the Team role (viewer and guest → at most `view`; `comment` is allowed for viewers only if O-A3 says so). | Notion and Nextcloud semantics; no deny rules. |
| D267 | **Groups are admin-managed** (`team.manage`); members see group names and members in the share picker; guests see no groups. **Owners share with a group; admins control membership.** The Access sheet says so ("Admins decide who is in this group"). Admin self-adds are allowed but audited and highlighted (O-A1). | Central management without breaking D73. An admin never grants content directly, only membership in a group that owners chose to share with. |
| D268 | **Central actions on others' items are reductions only.** From the member access page an admin can remove a person's **direct** share or level on any item, remove them from groups, revoke their keys and feeds, and pause their routines. The admin cannot add grants to items they do not own. Every such action writes `access_events` and notifies the item owner. | The safe direction; offboarding is centralised. |
| D269 | **Redaction:** in admin aggregation views an item's title is shown only if the admin can read the item. Otherwise it shows "Board owned by Carol" plus id-free counts; the id appears only in the revoke action's opaque handle. | D73: titles are content (T204). |
| D270 | **Keep the per-module share tables**; add a `level` column to each member table and one generic `group_grants` table. A read-only SQL view `access_grants_v` (UNION ALL of every source) feeds the aggregation and `/access` GETs. Hot read predicates keep their direct, indexed `EXISTS` and gain one `OR EXISTS (group_grants ⨝ group_members)` branch. **Do not migrate to one polymorphic ACL table.** | Rewriting every predicate would put the 1,156-test share matrix and T5 at risk; the view gives central reads for free. |
| D271 | **Folder sharing still does not cascade** to subfolders (§D.4). A key's folder selector covers items **directly** in that folder. `includeSubfolders` is a later, key-only flag (O-A5). | Parity with the existing sharing rule; one predicate shape. |
| D272 | **Per-person levels:** boards viewer/commenter/editor/manager (member rows backfilled to `editor`, D38 preserved; a new `boards.share_role` defaults to `editor` for the `all_users` audience); collections and calendars viewer/editor/manager (rows backfilled from the item's `share_role`, which remains the `all_users` level); notes viewer/editor; files, task views, and whiteboards viewer only. | "Recommend per module" (operator); §D.3 has the table. |
| D273 | **Manager** (boards, collections, calendars): structure (columns, tags, WIP, sprints, schema, views, import, rename, colour) and sharing **up to editor**. Managers cannot grant `manage`, change the audience to or from `all_users`, delete the item, or remove the owner. | Removes the owner bottleneck without an escalation ladder (T207). |
| D274 | **Notes editor** writes the draft and publishes (a new version authored by them, CAS on `draft_revision`). Only the owner shares, moves, renames the folder, restores versions, or deletes. The Bin stays owner-only. | The operator's "add editor?": yes for notes, where versions make edits reversible. |
| D275 | **Files stay view-only** in v1 (no editor, no "contributor uploads into my folder"). | There is no in-place edit operation, and cross-owner uploads break quota and ownership (O-A4). |
| D276 | **Expiry:** new keys must have `expires_at` (default 90 days; the maximum comes from policy, default 365). Existing keys keep NULL and show "No expiry" in every inventory. Policy `require_expiry=on` (off by default for the first release, O-A6) then **blocks** them at call time with `KEY_POLICY`, without revoking them. | GitHub's model [2]; reversible tightening (T209). |
| D277 | **Rotation** = `POST /api/keys/:id/rotate` (re-authentication): a new token with the same name, grants, surfaces, and limits, and a new id linked by `rotated_from`. The old key gets `revoke_after = now + grace` (default 24 h, choices 0, 1 h, 24 h, 7 d). `routines.key_id` bindings move to the new key in the same transaction. | Zero-downtime rotation; grace is explicit and visible (T208). |
| D278 | **Narrowing without re-auth, widening only by rotate-or-new.** `PATCH /api/keys/:id` may remove grants, lower permissions, shorten expiry, add IP restrictions, lower limits, and rename. Anything that widens needs a new key (re-auth). | Safe edits are frictionless; widening keeps its consent step (T145). |
| D279 | **Surfaces per key:** `mcp`, `rest`, or `both` (default `mcp` for backfilled keys; the create form asks). | Least privilege per client type. |
| D280 | **REST `/api/v1`** = `GET /api/v1/me`, `GET /api/v1/tools`, `POST /api/v1/tools/:name` running **the same `McpToolSpec`** through `runTool` (scopes, resource policy, limits, audit `via:"rest"`), plus the vault's accepted resource routes under `/api/v1/vault/*`. Bearer only, JSON only, cookies ignored, no CORS headers, and the Host and Origin checks from `mcp.ts`. | Guaranteed MCP/REST parity with no second authorisation layer; resource-style REST can come later without new semantics. |
| D281 | **Resource policy on every tool:** `McpToolSpec.resource` is one of `{kind:'id', arg, resourceKind}`, `{kind:'list', resourceKind}` (the service receives a grant filter), `{kind:'create-in', arg, resourceKind}`, or `{kind:'global', filter}`. A tool **without** a declared policy, or `global` without a filter, is **hidden** from keys whose grant for that module is not "all". A test enumerates every tool. | Fail-closed resource scoping without touching every SQL predicate (T203). |
| D282 | **Per-key limits** may only be **lower** than `MCP_LIMITS` (`limits_json`); they are checked in `consumeMcpLimits` before the global buckets. Per-user buckets are unchanged. | T216. |
| D283 | **Usage counts:** `api_key_usage(key_id, day, calls, writes, denied)`, flushed from memory every 60 s and on shutdown (lossy by up to a minute). Shown as a 14-day sparkline in the key row and in the admin inventory. | "Last used" alone does not reveal abuse. |
| D284 | **IP allowlist** (≤ 10 CIDRs per key) ships **only with** a new `TRUSTED_PROXY_HOPS` config (default 0 = use the socket address). Until an operator sets it, the field is hidden (O-A7). | Spoofable `X-Forwarded-For` would make it theatre (T211). |
| D285 | **Org policies** in `team_settings` (key/value, CAS by revision, admin only): `key_max_days` (365), `key_default_days` (90), `key_require_expiry` (off, then on after one release), `keys_per_user` (10), `key_modules_by_role` (default: every module the role's scopes allow), `mcp_roles` (admin, member, viewer), `rest_roles` (admin, member), `groups_member_create` (off), `share_with_guests` (on). Checked at call time. | GitHub and Slack governance [2][8]. |
| D286 | **Templates** = `{name, role, groupIds[]}` applied when an invite is accepted, or on demand from the member page. They never grant items directly; they add group memberships. | "Ops: all boards editor" becomes an "Ops" group that board owners share with at editor. |
| D287 | **Service accounts** (Access D, optional): `users.kind = 'service'`, with no password, never able to sign in, created and blocked by admins, role member or viewer. Owners share items with them like a person (badge "Integration"), and keys belong to them. An admin holds their keys, which is D73-compatible because owners explicitly shared with the integration (T212). | Notion's share-with-integration model [4]; keys survive staff departures (G12). |
| D288 | **New append-only `access_events`** table for groups, levels, admin revokes, policies, templates, key admin actions, and rotation. `team_events` is left untouched (G13). | An append-only migration cannot widen the `team_events` CHECK. |

### C.2 Permission vocabulary (one table for the whole product)

| Word | Item meaning | Key meaning | Examples |
| --- | --- | --- | --- |
| `view` / `read` | See the item and its content | `<module>:read` | read note, list cards, reveal a vault value (plus the value flag) |
| `comment` | view plus add comments (boards today, Messages later) | `tasks:comment` (new, narrower than write) | `comment_on_card` |
| `edit` / `write` | Change content, not structure or sharing | `<module>:write` | cards, rows, events, note drafts plus publish (editor) |
| restricted writes | — | `notes:write-draft`, `notes:publish`, `files:write`, `bin:write`, `inbox:write` | Keep their Wave 19 and Wave 21 promises ("never publishes", "never deletes forever") |
| `manage` | edit plus structure plus share up to editor (D273) | **never on keys** (D265) | columns, schema, calendar colour, members |
| `owner` | everything, including delete, audience, and grant manage | never on keys | — |
| `admin` | **Team role only**: team management, never content (D73) | `team:read` (admin only) | — |

Key permission → MCP scope is a pure function (`scopeFor(module, permission)`), so `registerMcpTools` keeps working on scopes. New in 025: `tasks:comment`, which implies `tasks:read`, is a write scope, and is member-only for viewers unless O-A3 says otherwise.

### C.3 Which modules need what (the direct answer to the request)

| Module | Own key system? | Key grant permissions | Resource selectors | Item levels (Access sheet) | Notes |
| --- | --- | --- | --- | --- | --- |
| Notes | No | read, write-draft, publish | all, folder, note | view, edit (D274) | create needs `folder` or `all` |
| Files | No | read, write (W19) | all, folder, document | view | attachments stay reachable only through their card or row, and only if the key also has that board or collection |
| Tasks | No | read, comment, write | all, board, task_view (read) | view, comment, edit, manage | `bin:write` also needs `tasks:write` on the same board |
| Collections | No | read, write | all, collection | view, edit, manage | |
| Calendar | No | read, write | all, calendar | view, edit, manage | feeds remain capability URLs (inventoried) |
| Today | No | read | derived: each section is filtered by that module's grants | — | a section whose module has no grant is omitted |
| Search | No | read (per module) | derived | — | `search_notes` is filtered by notes grants |
| Inbox and routines | No | read, write | all, routine (a proposal kind also needs the target module's read grant **on that resource**) | — (private) | `routines.key_id` binding kept |
| Whiteboards (023) | No | read, write (create empty) | all, folder, whiteboard | view | |
| Team | No | read (admin only) | all | — | no team write over keys (D79) |
| Bin | No | `bin:write` | inherited from the module grant | — | |
| **Vault (024)** | **Separate kind** `nkv_` | read, write, create (+ `allowMcpValueReads`) | vault, vault+env | per-env none/read/write/admin (D214) | D221 wall; same table, inventory, and policies |
| Calendar feeds | Capability URL | — | calendar | — | listed in the inventory, revocable centrally |
| Future: Messages webhooks, agent chat | kind `general` | `messages:post` on a channel, `agents:run` on an agent | channel, agent | — | the grant model already fits |

### C.4 Unified keys: lifecycle and behaviour

- **Create** (`POST /api/keys`, password plus TOTP as today): `{name, description?, kind, surfaces, expiresInDays, grants[], limits?, ipAllowlist?, allowMcpValueReads? (vault)}`. Validation order, all checked **before** the password so that no code is consumed: role capability, policy (modules, surfaces, expiry cap, count), and every grant's resource readable by the creator at ≥ the granted level (otherwise the same 404 `RESOURCE_NOT_FOUND` for missing or unreadable, T205). At most 50 grants and 100 resource ids per key.
- **Use:** `mcp.ts` and the new `server/apiKeyAuth.ts` share one `authenticateKey(request, surface)`, which checks the hash, liveness, `revoke_after`, expiry, policy, surface, IP, and the owner's `disabled_at` and email allowlist. It returns a `KeyActor {keyId, userId, kind, grants, scopes}`. `runTool` re-loads it per call (unchanged pattern).
- **Resource filter:** `server/keyGrants.ts` exports `grantFilter(actor, module, resourceKind, column)`, which returns `{sql, params}`. Sessions get `{sql:'1', params:{}}`, and an "all" grant gets `'1'` too. Selected grants give `column IN (SELECT resource_id FROM api_key_grants WHERE key_id=$kid AND module=$m AND resource_kind=$rk AND permission IN (...))`, and no grant gives `'0'`. It is applied by list services and asserted by `id` tools via `assertGranted(actor, kind, id, needed)`, which throws the **same NOT_FOUND** as an unreadable item.
- **Rotate, narrow, revoke:** D277 and D278. An admin revoke (`POST /api/team/keys/:id/revoke {reason}`) sets `revoked_by` and `revoke_reason` and notifies the owner (bell now; email in the email wave).
- **Owner events:** demotion narrows at once (T81). A block pauses keys, as today. Losing a share makes the grant dead weight: it is still listed, marked "no current access", and grants nothing (T202). Purging a resource deletes its grant rows through triggers (T206).
- **Audit:** `audit_log` metadata gains `via: "mcp" | "rest"` and `keyId` for writes (existing), plus `key.use.denied` counters in usage (not per-row logs). `access_events` records `key.created`, `key.rotated`, `key.narrowed`, `key.revoked` (self, admin, or expiry), and `key.policy_blocked` (first time per day per key).

### C.5 Module-level optional access management (the Access sheet)

One component, `src/access/AccessSheet.tsx`, replaces the five panels. It is fed by `GET /api/<module>/…/:id/access` and saves with `PUT` plus `If-Match` (an ETag computed from the sorted grant rows, so there's no new revision column; a stale ETag gives 409 `ACCESS_CHANGED`). It is still optional: an item nobody shares stays private, and owners who never open the sheet see no change.

`GET …/access` (owner and managers; everyone else 404 or 403 `OWNER_ONLY` as today):

```ts
type ItemAccess = {
  etag: string;
  owner: { id: string; displayName: string };
  audience: "private" | "selected" | "all_users" | "inherit";   // inherit: notes and files only
  audienceLevel?: "view" | "edit";                                // collections, calendars, boards (the all_users level)
  people: Array<{ id: string; displayName: string; teamRole: Role; kind: "person" | "service"; level: Level; via: "direct" }>;
  groups: Array<{ id: string; name: string; memberCount: number; guestCount: number; level: Level }>;
  levels: Level[];                 // the levels this module offers (§D.3)
  yourLevel: Level;                // owner | manage
  keysWithAccess?: number;         // the caller's own keys that reach this item (owner only)
};
```

`PUT …/access` body `{audience, audienceLevel?, people: [{id, level}] ≤ 100, groups: [{id, level}] ≤ 20}`. The server validates that users are enabled and not the owner, groups exist, levels are offered, the manager cap holds (D273), and `selected` has at least one person or group. It replaces direct rows and group rows in one transaction and writes `access_events` `item.access_changed {kind, id, audience, peopleCount, groupCount}` (counts only). The old `PUT …/sharing` keeps working. It maps `userIds` to people at the module's default level and leaves group grants untouched.

### C.6 Central Team-driven management

- **Groups** (Team → Groups tab, admins): create, rename, describe, add or remove members (people and service accounts), and delete (which removes its grants after a confirm naming the count). Each group page lists the **items shared with it**, redacted per D269, and its member history.
- **Member access page** (`/team/:userId/access`, admins; the member themself sees their own at `/settings/access`): per module, what they reach (via direct, group, or all_users), at what level, which keys and feeds they hold, their routines, and their vault access. Actions per D268: remove a direct share, lower to view, remove from a group, revoke a key or feed, pause routines, and **Reset access** (all of those at once; it leaves owned items and all_users). Titles are redacted per D269.
- **Key inventory** (Team → Keys): every live key across users, filterable by owner, module, kind, surface, expiring < 14 days, no expiry, unused > 90 days, or blocked by policy. It shows prefix, name, owner, grant summary, created, last used, a 14-day sparkline, and expiry, with revoke and bulk revoke (reason required). Token material is never shown (T215).
- **Policies** (Team → Settings): D285, edited with custom Selects and number inputs, CAS by revision. It shows a live **impact preview** ("3 keys would be blocked") before saving.
- **Templates** (Team → Settings → Templates): name, role, groups. The invite form gains an optional template Select, and accepting the invite applies it in the registration transaction.
- **Access audit** (Team → Activity, extended): `access_events` merged with `team_events`, filterable by person, group, key, and action. Ids and counts only; titles are redacted per D269.

### C.7 API (additions to API_CONTRACTS.md)

| Endpoint | Who | Notes |
| --- | --- | --- |
| `GET /api/keys` | self | `ApiKey[]` with `grants`, `effectiveGrants` (each marked `active` or `inactive: role \| policy \| no-access`), `expiresAt`, `surfaces`, `usage14d` |
| `POST /api/keys` | self, re-auth | §C.4; 201 once with `token`. Errors: 400, 401, 403 `SCOPE_NOT_ALLOWED`/`KEY_POLICY`, 404 `RESOURCE_NOT_FOUND`, 409 key count |
| `PATCH /api/keys/:id` | self | narrowing only (D278); 400 `WIDENING_NOT_ALLOWED` |
| `POST /api/keys/:id/rotate` | self, re-auth | `{graceHours: 0\|1\|24\|168}` → new key and token |
| `DELETE /api/keys/:id` | self | immediate |
| `/api/mcp/keys` | self | alias for one release; creates `general`, `mcp`-surface keys over "all" |
| `GET /api/team/keys?owner&module&kind&state&cursor` | admin | metadata only |
| `POST /api/team/keys/:id/revoke` | admin | `{reason ≤ 200}`; notifies the owner |
| `GET/PUT /api/team/policies` | admin | `{policies, revision}`; `PUT` is CAS; `POST /api/team/policies/preview` gives the impact |
| `GET /api/groups` | member+ (share picker) | `[{id, name, memberCount, guestCount}]`; 403 for read-only roles (they cannot share, like `/api/users`) |
| `GET/POST /api/team/groups`, `GET/PATCH/DELETE /api/team/groups/:id`, `PUT /api/team/groups/:id/members` | admin | CAS by `revision`; ≤ 200 groups, ≤ 500 members each |
| `GET/PUT /api/notes/:id/access`, `/api/folders/:id/access`, `/api/files/:id/access`, `/api/tasks/boards/:b/access`, `/api/tasks/views/:v/access`, `/api/collections/:c/access`, `/api/calendars/:k/access` | owner, manager | §C.5 |
| `GET /api/team/members/:id/access?module&cursor` | admin; self through `/api/me/access` | aggregation from `access_grants_v`, paged at 200 per module |
| `DELETE /api/team/members/:id/access/:handle` | admin | `handle` = an opaque signed `{kind, id, via}`; reduction only (D268) |
| `POST /api/team/members/:id/access/reset` | admin | Reset access; returns counts |
| `GET/POST/PATCH/DELETE /api/team/templates` | admin | D286 |
| `GET /api/v1/me` | key | `{owner: {displayName}, keyName, kind, surfaces, expiresAt, grants: effective}` |
| `GET /api/v1/tools`, `POST /api/v1/tools/:name` | key with `rest` | D280. Status mapping: INVALID→400, SCOPE_REQUIRED/READ_ONLY/KEY_POLICY→403, NOT_FOUND→404, `*_CHANGED`/`LIMIT_REACHED`→409, RATE_LIMITED→429 with `Retry-After`, INTERNAL→500. The body is the tool's JSON result (not the text wrapper). |

**Write gate:** add `POST /api/keys`, `PATCH /api/keys/:id`, `POST /api/keys/:id/rotate`, and `DELETE /api/keys/:id` to `ROLE_READ_ONLY_ALLOWED_WRITES` (viewers keep read-only keys; the handler enforces the scopes). `/api/team/*` stays self-gated. `/api/v1/*` sits **outside** `/api/*` middleware (like `/mcp`). Its role limits come from `runTool` and `mcpScopesForRole`, and a test asserts that a viewer's REST key cannot run any write tool.

### C.8 Migration `025_access_management` (creates everything; later waves add behaviour)

```sql
-- keys (D261, D264, D276–D284)
ALTER TABLE mcp_api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','vault'));
ALTER TABLE mcp_api_keys ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 200);
ALTER TABLE mcp_api_keys ADD COLUMN surfaces TEXT NOT NULL DEFAULT 'mcp' CHECK (surfaces IN ('mcp','rest','both'));
ALTER TABLE mcp_api_keys ADD COLUMN expires_at TEXT;                 -- NULL only for pre-025 keys
ALTER TABLE mcp_api_keys ADD COLUMN revoke_after TEXT;               -- rotation grace
ALTER TABLE mcp_api_keys ADD COLUMN rotated_from TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL;
ALTER TABLE mcp_api_keys ADD COLUMN revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE mcp_api_keys ADD COLUMN revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200);
ALTER TABLE mcp_api_keys ADD COLUMN limits_json TEXT CHECK (limits_json IS NULL OR json_valid(limits_json));
ALTER TABLE mcp_api_keys ADD COLUMN ip_allowlist TEXT CHECK (ip_allowlist IS NULL OR json_valid(ip_allowlist));
ALTER TABLE mcp_api_keys ADD COLUMN allow_mcp_value_reads INTEGER NOT NULL DEFAULT 0 CHECK (allow_mcp_value_reads IN (0,1));
ALTER TABLE mcp_api_keys ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;  -- admin, for service accounts

CREATE TABLE api_key_grants (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
  module TEXT NOT NULL CHECK (module IN ('notes','files','tasks','today','calendar','collections','team','inbox','bin','whiteboards','vault')),
  permission TEXT NOT NULL CHECK (permission IN ('read','comment','write','draft','publish','create')),
  resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind IN
    ('folder','note','document','board','task_view','collection','calendar','routine','whiteboard','vault')),
  resource_id TEXT,
  env_id TEXT,                                                       -- vault only; NULL = every env
  created_at TEXT NOT NULL,
  CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
  CHECK (env_id IS NULL OR module = 'vault')
);
CREATE UNIQUE INDEX api_key_grant_unique ON api_key_grants(key_id, module, permission,
  COALESCE(resource_kind,'*'), COALESCE(resource_id,'*'), COALESCE(env_id,'*'));
CREATE INDEX api_key_grants_resource ON api_key_grants(resource_kind, resource_id) WHERE resource_id IS NOT NULL;
-- trigger api_key_grants_kind_wall: RAISE unless (module = 'vault') = (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)

CREATE TABLE api_key_usage (key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
  day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, writes INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)) WITHOUT ROWID;                         -- trimmed to 90 days by the sweeper

-- groups (D267)
CREATE TABLE user_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE group_members (group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL, PRIMARY KEY (group_id, user_id));
CREATE INDEX group_members_user ON group_members(user_id, group_id);
CREATE TABLE group_grants (resource_kind TEXT NOT NULL CHECK (resource_kind IN
    ('folder','note','document','board','task_view','collection','calendar','vault')),
  resource_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('view','comment','edit','manage')),
  env_id TEXT,                                                       -- vault groups (Wave 27 amendment)
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX group_grants_unique ON group_grants(resource_kind, resource_id, group_id, COALESCE(env_id,'*'));
CREATE INDEX group_grants_group ON group_grants(group_id);
-- AFTER DELETE triggers on notes, folders, documents, boards, task_views, collections, calendars (and vaults in 024's
-- successor) delete matching group_grants and api_key_grants rows (T206). Purge is a hard DELETE, so the Bin keeps them.

-- per-person levels (D272); the defaults preserve today's behaviour exactly
ALTER TABLE note_shares        ADD COLUMN level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit'));
ALTER TABLE folder_shares      ADD COLUMN level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit'));
ALTER TABLE document_shares    ADD COLUMN level TEXT NOT NULL DEFAULT 'view' CHECK (level = 'view');
ALTER TABLE board_members      ADD COLUMN level TEXT NOT NULL DEFAULT 'edit' CHECK (level IN ('view','comment','edit','manage'));
ALTER TABLE boards             ADD COLUMN share_role TEXT NOT NULL DEFAULT 'edit' CHECK (share_role IN ('view','comment','edit'));
ALTER TABLE collection_members ADD COLUMN level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit','manage'));
ALTER TABLE calendar_members   ADD COLUMN level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit','manage'));
UPDATE collection_members SET level = 'edit' WHERE (SELECT share_role FROM collections c WHERE c.id = collection_id) = 'editor';
UPDATE calendar_members   SET level = 'edit' WHERE (SELECT share_role FROM calendars k WHERE k.id = calendar_id) = 'editor';
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','service'));  -- D287

-- policies, templates, events (D285, D286, D288)
CREATE TABLE team_settings (key TEXT PRIMARY KEY CHECK (key IN ('key_max_days','key_default_days','key_require_expiry',
    'keys_per_user','key_modules_by_role','mcp_roles','rest_roles','groups_member_create','share_with_guests')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)), revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL);
CREATE TABLE access_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  role TEXT NOT NULL CHECK (role IN ('member','viewer','guest')), group_ids TEXT NOT NULL CHECK (json_valid(group_ids)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
ALTER TABLE team_invites ADD COLUMN template_id TEXT REFERENCES access_templates(id) ON DELETE SET NULL;
CREATE TABLE access_events (id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  via TEXT NOT NULL CHECK (via IN ('web','cli','mcp','rest','sweeper','migration')),
  action TEXT NOT NULL CHECK (length(action) <= 40),                 -- open vocabulary, validated in code
  target_user_id TEXT, group_id TEXT, key_id TEXT, resource_kind TEXT, resource_id TEXT,
  meta_json TEXT CHECK (meta_json IS NULL OR (json_valid(meta_json) AND length(meta_json) <= 2048)), created_at TEXT NOT NULL);
-- no-UPDATE/DELETE triggers as for team_events (T83); indexes on (target_user_id, created_at), (key_id), (group_id)

-- backfill (D262): one grant per stored scope over "all"
INSERT INTO api_key_grants (id, key_id, module, permission, created_at)
  SELECT lower(hex(randomblob(16))), k.id, <module(scope)>, <permission(scope)>, <T>
  FROM mcp_api_keys k, json_each(k.scopes);                           -- done in TS with scopeToGrant() and one timestamp

CREATE VIEW access_grants_v AS                                       -- read-only aggregation (D270)
  SELECT 'note' AS kind, note_id AS resource_id, user_id, level, 'direct' AS via, NULL AS group_id FROM note_shares
  UNION ALL SELECT 'folder', folder_id, user_id, level, 'direct', NULL FROM folder_shares
  UNION ALL SELECT 'document', document_id, user_id, level, 'direct', NULL FROM document_shares
  UNION ALL SELECT 'board', board_id, user_id, level, 'direct', NULL FROM board_members
  UNION ALL SELECT 'task_view', view_id, user_id, 'view', 'direct', NULL FROM task_view_members
  UNION ALL SELECT 'collection', collection_id, user_id, level, 'direct', NULL FROM collection_members
  UNION ALL SELECT 'calendar', calendar_id, user_id, level, 'direct', NULL FROM calendar_members
  UNION ALL SELECT g.resource_kind, g.resource_id, gm.user_id, g.level, 'group', g.group_id
    FROM group_grants g JOIN group_members gm ON gm.group_id = g.group_id;
```

Notes: every `ADD COLUMN` default reproduces today's behaviour, so 025 is a no-op for users until the waves ship UI. The collection and calendar `share_role` values stay `viewer`/`editor` (existing CHECK); only the new columns use `view`/`edit`, and `server/access/levels.ts` maps between them. Wave 21's `routines.key_id` is unaffected. Wave 19's new scopes map through `scopeToGrant`, so 025 must merge after Wave 19. **Backup before migrate** (release notes), as for 017 and 018.

### C.9 Predicate changes (Access B), shown for boards

```ts
// server/tasks/access.ts — the existing predicate plus one indexed branch; guests still never match all_users
export const readableBoardPredicate = `(
  b.deleted_at IS NULL AND (b.owner_id = $userId OR (b.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
    OR (b.visibility = 'selected' AND (
      EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $userId)
      OR ${groupGrantExists("board", "b.id")})))
)`;
// boardLevel(board, userId) = min(roleCap(role), max(owner?'owner', member.level, groupLevels…, all_users?share_role))
```

`groupGrantExists(kind, column)` is one shared fragment in `server/access/groups.ts`. A guard test (like the `AUDIENCE_ALL_USERS` grep) fails if a module's `selected` branch lacks it. Group grants apply only under `selected`, so a private item never leaks through an old group row. Levels are resolved in TS by `itemLevel()` per module, which replaces `collectionRole` and `calendarRole`. `editable*Predicate` become level-aware SQL (`… AND level IN ('edit','manage')`) with the role cap applied in TS, as today.

### C.10 Effective-rights algorithm (one function, `server/access/effective.ts`)

```ts
type Needed = { module: Module; permission: KeyPermission; resource?: { kind: ResourceKind; id: string }; envId?: string };

/** Sessions pass `key = null`. Every MCP tool call and REST call goes through this before its service runs. */
export function authorize(actor: { userId: string; role: Role; key: KeyActor | null }, needed: Needed): "ok" | DenyCode {
  if (actor.key) {
    const k = actor.key;
    if (k.revokedAt || (k.revokeAfter && k.revokeAfter <= now()) || (k.expiresAt && k.expiresAt <= now())) return "KEY_INACTIVE";
    const policy = currentPolicies();                                // cached 30 s, busted on PUT /api/team/policies
    if (!policy.allowsKey(k, actor.role)) return "KEY_POLICY";       // expiry cap, require-expiry, surfaces per role, modules per role
    const scope = scopeFor(needed.module, needed.permission);
    if (!mcpScopesForRole(actor.role).includes(scope)) return "SCOPE_REQUIRED";
    if (!k.grants.some((g) => covers(g, needed))) return needed.resource ? "NOT_FOUND" : "SCOPE_REQUIRED";
  }
  if (!needed.resource) return "ok";                                  // list tools apply grantFilter in SQL instead
  const level = itemLevel(needed.resource, actor.userId, actor.role); // live: owner, direct, group, audience; role-capped
  return level >= levelFor(needed.permission) ? "ok" : level === "none" ? "NOT_FOUND" : "READ_ONLY";
}
```

- `covers(g, n)`: same module; `g.permission` implies `n.permission` (write ⇒ read, comment ⇒ read, draft ⇒ read, publish ⇒ read); `g.resource_id` NULL, or equal to the resource, or equal to the resource's **container** (a card's board, a row's collection, an event's calendar, a note's or document's immediate folder); vault `env_id` NULL or equal.
- `itemLevel` is the per-module resolver built in Access B. Before Access B ships, it wraps today's `readable*` and `editable*` predicates, so Access A can land without the levels.
- The containers of a resource are looked up in one indexed query, joined to the same readable predicate, so a card id on a board the owner cannot read resolves to `none` (T203).

### C.11 Notifications and email hooks (consumed by the email wave, migration 026)

| Event | Recipient | Bell (this plan) | Email (026) |
| --- | --- | --- | --- |
| Key created, rotated | owner | ✔ | security mail |
| Key expires in 7 days, 1 day | owner | ✔ | ✔ |
| Key revoked by an admin, or blocked by policy | owner | ✔ | ✔ |
| Added to or removed from a group | member | ✔ | digest |
| Item shared with you (direct or new group grant) | recipient | ✔ (existing pattern) | digest |
| Admin removed someone's access to your item | item owner | ✔ | digest |

---

## D. Module-by-module notes

### D.1 What changes per module (server)

| Module | Access B change | Access D (key selectors) |
| --- | --- | --- |
| Notes | `readableNotePredicate` gains the group branch at note and folder level; `editableNote` = owner or level `edit`; publish by editor writes `note_versions.author_id = editor`; share, move, and delete stay `ownedNote` | `list_notes`/`search_notes` take `grantFilter('notes','note'|'folder')`; `create_note` requires `create-in` folder |
| Files | group branch in `readablePredicate` and `documentSummarySelect` | `list_documents` filter; attachment reads need the board/collection grant too |
| Tasks | levels on `board_members` and `share_role`; `comment` level may comment but not edit; manager passes the structure checks now written as "owner only" (`OWNER_ONLY` → `MANAGER_REQUIRED` only where D273 allows) | board selector on every card tool; `query_cards` across boards filtered |
| Collections | `collection_members.level`; manager = schema, views, import, sharing ≤ edit | collection selector |
| Calendar | `calendar_members.level`; manager = rename, colour, sharing ≤ edit; feeds need ≥ view (unchanged) | calendar selector; `create_reminder` needs a readable event in a granted calendar |
| Task views | group branch | read-only selector |
| Inbox | none | a proposal target must also pass the target module's grant (the D151 read scope **on that resource**) |
| Vault (Waves 25–27) | uses `group_grants` with `env_id` for group membership of vaults (amendment) | vault/env grants live in `api_key_grants` (D264) |

### D.2 Guests and groups

A guest in a group gets that group's items (a named share, D72's "shared by name"), capped at `view`. The picker shows "includes 2 guests". Policy `share_with_guests=off` refuses direct or group shares that would reach a guest (400 `GUEST_SHARE_DISABLED`) and hides guests from pickers.

### D.3 Levels offered per module

| Module | view | comment | edit | manage | Default for new people |
| --- | --- | --- | --- | --- | --- |
| Notes, folders | ✔ | — | ✔ (D274) | — | view |
| Files | ✔ | — | — (D275) | — | view |
| Boards | ✔ | ✔ | ✔ | ✔ | edit (D38) |
| Task views | ✔ | — | — | — | view |
| Collections | ✔ | — | ✔ | ✔ | the item's current `share_role` |
| Calendars | ✔ | — | ✔ | ✔ | same |
| Whiteboards | ✔ | — | — | — | view |

### D.4 Folder cascade (revisited)

A recursive grant would make every predicate a recursive CTE (or require a closure table kept in sync on moves), and it would change what existing shares expose the moment it shipped (a silent widening, T145 class). Notion inherits from parent pages [4] and Nextcloud from parent folders [13], but Nook's folders are shallow and owner-arranged. **Keep no cascade** (D271). Offer "Share folder and its subfolders" later as a **one-time bulk action** that writes explicit rows (O-A5), so what is shared is always visible per item.

---

## E. UX (390 px first; desktop is the same content in a side panel)

**Access sheet** (bottom sheet at 390 px; right side panel above 760 px; Back closes, D69 parity)

```text
┌ Access ─────────────────────────── ✕ ┐
│ Ops sprint board                      │
│ Who can open this                     │
│ ( ) Only me                           │
│ (•) People and groups I choose        │
│ ( ) Everyone signed in   [Can edit ▾] │  ← custom Select (audience level)
│                                       │
│ [ Add people or groups…          ]    │  ← Combobox: people (role hint), groups (count, "2 guests")
│                                       │
│ [G] Ops (6 people)         [Can edit ▾]│
│    Admins decide who is in this group │
│ ◯ Alice Rao · Member       [Manager ▾]│
│ ◯ Bob · Team role: Viewer  [Can view] │  ← capped, Select disabled with hint "Viewer role reads only"
│ [I] CI bot · Integration   [Can view ▾]│
│                                       │
│ 2 of your API keys can reach this ›   │  (owner only; opens Settings → Keys filtered)
│ [ Cancel ]                  [ Save ]  │
└───────────────────────────────────────┘
```

The level Select options come from §D.3, each with one line ("Can edit: cards, not columns or sharing"). The manager's own sheet hides "Manager" in the options and the audience radios (D273). Copy keeps "Team role: Viewer" apart from "Can view" (Team plan §2.4).

**Settings → API keys** (was "MCP server")

```text
API keys                                  [+ New key]
┌──────────────────────────────────────────────────┐
│ Claude Code · mynotes_Ab3f…  MCP                 │
│ Tasks: write on Ops board · Notes: read (all)    │
│ Expires in 12 days (!)  Last used 2 h ago ▁▃▂▅▁    │
│ [Rotate] [Edit] [Revoke]                         │
└──────────────────────────────────────────────────┘
New key (full-screen sheet at 390 px, steps)
 1 Name, description
 2 Where it's used: [MCP ▾] (MCP | REST | Both)
 3 Access  ← grant builder, one row per module
   Module [Tasks ▾]  Permission [Write ▾]  Applies to [Selected boards ▾] → Combobox multi-pick
   + Add module
   Summary: "Can create and move cards on 2 boards. Never deletes. Never shares."
 4 Expires [90 days ▾] (7, 30, 90, 180, 365 ≤ policy; "No expiry" only if policy allows)
 5 Advanced (collapsed): lower limits, allowed IPs (only if TRUSTED_PROXY_HOPS is set)
 6 Confirm with password + code → token shown once, [Copy]
```

The Permission Select only offers what the role and policy allow. Disabled options show why ("Admins only", "Your team role reads only", "Disabled by team policy").

**Team → member → Access** (admins)

```text
‹ Team   Alice Rao · Member                 [Reset access…]
Groups: Ops ✕  Design ✕   [+ Add to group ▾]
Keys (2) ›   Feeds (1) ›   Routines (3) ›
Tasks ▸ 7 boards
   Ops sprint · owned by Carol · Manager (direct)   [Lower ▾] [Remove]
   Board owned by Dan (title hidden) · Can edit (via Ops)  [Remove from Ops]
Notes ▸ 12 · Files ▸ 4 · Collections ▸ 2 · Calendar ▸ 3 · Vault ▸ 1
```

Rows paginate per module (200). "Reset access…" opens a confirm listing counts; it is a history dialog, so Back cancels it.

**Team → Keys** (inventory): a filter bar with custom Selects (Owner, Module, State), rows as in Settings plus the owner, bulk select, and "Revoke (reason)". **Team → Groups**: a list, then a group page (members Combobox, items shared with it, history). **Team → Settings → Policies**: a form with an impact preview line above Save.

---

## F. Threat rows (append to THREAT_MODEL.md as "Access management and keys (Waves 28–31)")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T200 | **Grant escalation through groups**: an admin adds themselves or an accomplice to a group to read content, eroding D73 | Owners opt in per item by sharing with a group, and the sheet says admins control membership. Every membership change goes to `access_events`. Self-adds are flagged in the group page and in the Access sheet ("added by themselves"). Group shares apply only under `selected`. O-A1 can forbid self-add. | Required |
| T201 | **A key broader than its owner** (grants on items they lost, or a level above theirs) | Effective = grants ∩ live level ∩ role cap ∩ policy on every call (D263). Creation validates readability. `effectiveGrants` marks inactive grants. | Required |
| T202 | **Stale access after demotion, unshare, or group removal** | Nothing is cached across calls; `loadLiveKey` recomputes. Sessions read predicates live. Tests: remove the share, then the next MCP and REST call gets 404. | Required |
| T203 | **Resource-selector bypass** through cross-module paths (attachments, event links, collection note/file fields, relations, search, Today, `query_cards`, inbox kinds) | `resource` policy on every tool (D281); an undeclared or `global` tool is hidden from selector-limited keys; cross-module reads need both grants; an enumeration test covers every tool. | Required |
| T204 | **Enumeration or leakage via `/access` and the admin aggregation** (titles or ids of items the viewer cannot read) | `/access` is owner or manager only, with the same 404 as today. Admin views redact titles (D269) and use opaque signed handles, never raw ids of unreadable items. | Required |
| T205 | **Existence probing through key creation** (granting on a guessed id) | The same 404 `RESOURCE_NOT_FOUND` for missing and unreadable; creation is rate-limited (5 per hour, as in the vault plan). | Required |
| T206 | **Orphaned polymorphic grants** re-attaching to a new object | UUIDs never reused; AFTER DELETE triggers on every resource table; a sweeper self-check counts orphans and logs ids only. | Required |
| T207 | **Manager escalation** (grant manage, change audience to all_users, remove the owner, delete) | D273 caps are enforced in the service; tests per module. | Required |
| T208 | **Rotation grace abuse**: a stolen old key keeps working | The grace is visible on the key row with a "Revoke now" control; the maximum is 7 days; the admin inventory filters "in grace". | Required |
| T209 | **Policy bypass** by pre-policy keys or a race at creation | Policies are checked on every call, not only at creation; `KEY_POLICY` code; impact preview. | Required |
| T210 | **REST confusion**: CSRF via cookies, CORS reads, or HTML responses | `/api/v1` ignores cookies, sends no CORS headers, requires Bearer, checks Host and Origin as `/mcp` does, and returns JSON with `no-store`. | Required |
| T211 | **IP allowlist spoofing** via `X-Forwarded-For` | D284: hidden unless `TRUSTED_PROXY_HOPS` is set; the right-most-hop rule; tests with forged headers. | Required |
| T212 | **Service-account keys held by an admin** read content shared with the bot | Sharing with an integration is explicit (badge, "Integration" in the picker); the account can never sign in; key actions are audited; blocking the service user kills its keys. | Required |
| T213 | **Group shares reaching guests** unexpectedly | Guest counts shown in the picker; `share_with_guests` policy; role cap `view`. | Required |
| T214 | **Admin revokes on others' items** used to sabotage | Reduction only, audited, the owner notified, and restorable by the owner re-sharing. | Accepted |
| T215 | **Key material in inventories or logs** | Prefix only; the hash is never returned; tokens appear once; log lines carry the key id only. | Required |
| T216 | **Per-key limits used to raise quotas** | Limits can only be lower (D282); per-user buckets unchanged. | Required |
| T217 | **Kind confusion**: a general key gains vault grants, or a vault key sees other tools | CHECK plus trigger wall; `registerMcpTools` branches on kind; tests. | Required |
| T218 | **DoS through aggregation** (member access page, inventory, `access_grants_v`) | Paging (200), per-module queries using indexes, admin only, and the Team write rate limit reused for bulk revoke. | Required |

---

## G. Test matrix (TEST_PLAN.md rows)

| Area | Cases |
| --- | --- |
| Migration 025 | Every existing key gets grants equal to its scopes over "all"; `tools/list` is identical before and after for a sample of keys; member levels are backfilled (boards `edit`, collection and calendar from `share_role`); defaults reproduce today's share matrix (re-run the Wave 7 and Team B matrices unchanged); triggers delete grants on purge; the kind wall refuses mixes. |
| Effective rights | Role × grant × item level × policy table-driven test per module: admin, member, viewer, guest × all / selected / none × owner / manage / edit / comment / view / none × policy allow or deny. Demotion, unshare, group removal, block, expiry, and grace end all take effect on the next call (T202). |
| Resource selectors | Every registered tool: a key with a selector on A cannot read, list, create in, or modify B (404 on id tools, absent from lists); undeclared tools hidden (T203); cross-module attachment and event-link paths; Today sections filtered; search filtered. |
| REST v1 | Parity: every tool gives the same result via MCP and REST; status mapping; cookies ignored; no CORS; Origin refusal; `mcp`-only keys get 403 on REST and vice versa; a viewer's REST key runs no write tool. |
| Keys lifecycle | Create validation order (no TOTP consumed on a policy failure); narrowing PATCH allowed, widening 400; rotate moves `routines.key_id`; grace honoured; admin revoke notifies; usage counters flush; per-key limits lower only. |
| Groups | Share with group → members read; guest in group capped at view; policy `share_with_guests=off`; removing a member revokes at once; deleting a group removes grants; self-add is flagged; the group branch guard test (every `selected` branch). |
| Levels | Per module per level: allowed and refused operations (§D.3); manager caps (T207); notes editor publishes with author = editor, cannot share or delete; comment level comments only. |
| Access sheet API | ETag CAS 409; `/sharing` compatibility; manager view hides manage and audience; 404 for non-readers; counts-only audit. |
| Central | Aggregation correctness vs `access_grants_v`; title redaction (T204); opaque handles; reset access counts; paging; policy impact preview equals the actual block count. |
| UI (`*.test.tsx`) | Access sheet at 390 px (Back closes, focus trap, custom Selects), grant builder disables options with reasons, key row states (expiring, no expiry, in grace, blocked by policy), Team member access redaction, history parity for every new dialog. |

---

## H. Waves (each releasable, backend and UI together; one QA instance rebuilt from `main` after each)

| Wave | Scope | Migration | Size | Release |
| --- | --- | --- | --- | --- |
| **28 · Access A: Nook keys, inventory, policies** (build first) | 025 in full (all tables and columns, no behaviour change beyond keys); `server/apiKeys.ts` (create, list, narrow, rotate, revoke) over grants with "all" selectors only; `authenticateKey` shared by `/mcp`; expiry and grace; per-key lower limits; usage counts; policies (`team_settings`) with impact preview; admin key inventory and revoke; `access_events`; Settings → API keys (grant builder with module and permission rows, "all" only); Team → Keys and Team → Settings → Policies; `/api/mcp/keys` alias; docs | 025 | **M/L** (3 sessions: schema and server, Settings UI, Team UI) | v0.12.0 |
| **29 · Access B: groups, levels, Access sheet** | Group tables live; Team → Groups (admin CRUD); `GET /api/groups`; group branch in every predicate plus guard test; per-person levels (§D.3) incl. board viewer/commenter/manager, collection and calendar manager, notes editor; `itemLevel()` per module; `GET/PUT …/access` for 7 kinds with ETag; `src/access/AccessSheet.tsx` replacing the five panels; `share_with_guests` policy | — | **L** (4 sessions: predicates and levels, notes editor, API, UI) | v0.13.0 |
| **30 · Access C: Team-driven central management** | `GET /api/team/members/:id/access` over `access_grants_v` with redaction and handles; admin reductions; Reset access; `/settings/access` for self; templates plus invite integration; access audit view in Team → Activity; owner notifications for admin actions | — | **M** (2 sessions) | v0.14.0 |
| **31 · Access D: resource-scoped keys and REST** | `resource` policy on every MCP tool; `grantFilter` in list services; selectors in the grant builder (Combobox of boards, collections, calendars, folders, notes, documents, views, routines); `/api/v1/me`, `/api/v1/tools[/:name]`; surfaces enforced; IP allowlist behind `TRUSTED_PROXY_HOPS`; optional service accounts (`users.kind='service'`, Team → Integrations) | — | **L** (3–4 sessions; service accounts may split into 31b) | v0.15.0 |

**Ordering constraints:** 025 merges after Wave 19 (the scope list) and Wave 22 (`routines.key_id` rotation). The vault waves (25–27) should start after Access A so that they build on unified keys, amending the vault plan §5 and §7 to drop `vault_api_keys`. Whiteboards (23–24) are independent; their scopes join `scopeToGrant`.

**Why A first:** it answers "which modules need separate key management" in product form (one Keys page, one inventory, the vault as a kind). It makes key management central immediately (inventory, revoke, policies). It is the smallest wave, and it removes the need for the vault's parallel key system. B then delivers "optional per-module management" and the group mechanism that C's central page acts on. D is the deepest refactor (every tool), and it is safest after the vocabulary and inventory exist.

---

## I. Open decisions (defaults in bold)

| # | Question | Default |
| --- | --- | --- |
| O-A1 | Can admins add themselves to groups? | **Yes, audited and flagged** (alternative: another admin must do it, which is impossible for single-admin installs) |
| O-A2 | Can members create groups? | **No** (policy `groups_member_create`, off) |
| O-A3 | May viewers hold `comment` on boards and `tasks:comment` keys? | **No** in v1 (read-only stays read-only; revisit with Messages) |
| O-A4 | Files "contributor" (upload into someone's shared folder)? | **No** (D275) |
| O-A5 | Folder cascade? | **No**; later a one-time "share subfolders too" bulk action, plus a key-only `includeSubfolders` flag |
| O-A6 | `key_require_expiry` on at first release? | **Off in v0.12.0, on in the next minor**, with release-note warning and inventory "No expiry" filter |
| O-A7 | IP allowlist | **Only with `TRUSTED_PROXY_HOPS`**; hidden otherwise |
| O-A8 | Default surfaces for new keys | **MCP**; REST opt-in; `rest_roles` = admin, member |
| O-A9 | Rename table `mcp_api_keys` → `api_keys`? | **No** (append-only, FKs, internal ids keep `mynotes`) |
| O-A10 | Migrate share tables into one ACL table? | **No** (D270: add levels, `group_grants`, and a view) |
| O-A11 | Service accounts in Access D? | **Yes, as 31b**, after resource scoping works |
| O-A12 | Resource-style REST (`GET /api/v1/boards/:id/cards`) | **Not in v1**; `/api/v1/tools/:name` gives parity; vault keeps its accepted resource routes |
| O-A13 | Notify owners by email about admin revokes and key expiry | **Bell now; email in the email wave** (migration 026) |
| O-A14 | Default expiry for new keys | **90 days**, maximum **365** (vault parity) |

---

---

## J. Files touched and commits per wave

**Access A (Wave 28).** New files: `server/migrations/025_access_management.ts`, `server/apiKeys.ts` (create, list, narrow, rotate, revoke, usage flush), `server/apiKeyAuth.ts` (`authenticateKey`), `server/keyGrants.ts` (`scopeToGrant`, `scopeFor`, `covers`, `grantFilter`; A uses "all" only), `server/team/policies.ts`, `server/team/keys.ts` (inventory, admin revoke), `server/access/events.ts`, `src/keys/{KeysSettings,KeyGrantBuilder,KeyRow}.tsx`, `src/team/{TeamKeys,TeamPolicies}.tsx`. Changed: `server/mcp.ts` (use `authenticateKey`), `server/mcpTools.ts` (`loadLiveKey` from grants, KEY_POLICY), `server/mcpRateLimit.ts` (per-key overrides), `server/index.ts` (routes, alias), `server/team/writeGate.ts` (allowlist), `server/team/service.ts` (member row: key count → key summary), `server/sweeper.ts` (grace end, usage trim, expiry notifications), `src/App.tsx` (Settings entry), `src/router.ts` (`/settings/keys`, `/team/keys`, `/team/settings`), `src/mcpPermissions.ts` (labels shared with the grant builder). Tests: `apiKeys.test.ts`, `keyPolicies.test.ts`, `teamKeys.test.ts`, `migration025.test.ts`, updated `mcpScopes.test.ts` and `writeGate.test.ts`.
Commits: `feat: add access management migration 025` · `feat: store MCP key scopes as grants` · `feat: add key expiry, rotation, and narrowing` · `feat: add team key policies` · `feat: add admin key inventory and revoke` · `feat: rebuild Settings API keys with grant builder` · `feat: add Team keys and policies pages` · `docs: document Nook keys and policies`.

**Access B (Wave 29).** New: `server/access/{groups,levels,itemAccess}.ts`, `server/team/groups.ts`, `src/access/{AccessSheet,PrincipalPicker,LevelSelect}.tsx`, `src/team/{TeamGroups,GroupPage}.tsx`. Changed: every `access.ts` and `server/access.ts`, `server/documentAccess.ts`, the five `…/sharing` handlers, the tasks, collections, and calendar services (manager checks), `server/noteDrafts.ts` and the publish route (editor), the five share panels (deleted after the switch). Tests: `groupGrants.test.ts` (guard plus matrix), `itemLevels.test.ts`, `accessApi.test.ts`, `accessSheet.test.tsx`, updated share-matrix and guest-audience tests.
Commits: `feat: add groups and team group management` · `feat: honour group grants in every access predicate` · `feat: add per-person share levels` · `feat: add board, collection, and calendar managers` · `feat: let note editors write and publish drafts` · `feat: add item access API with ETag` · `feat: replace share panels with the Access sheet` · `docs: document groups and levels`.

**Access C (Wave 30).** New: `server/team/memberAccess.ts` (aggregation, handles, reductions, reset), `server/team/templates.ts`, `src/team/{MemberAccess,Templates}.tsx`, `src/settings/MyAccess.tsx`. Changed: `server/team/invites.ts` (template on accept), `src/team/TeamApp.tsx` (tabs, activity filter). Commits: `feat: add member access aggregation` · `feat: add admin access reductions and reset` · `feat: add access templates to invites` · `feat: add access activity view` · `docs: document central access management`.

**Access D (Wave 31).** Changed: `server/mcpToolKit.ts` (`resource` on `McpToolSpec`), every module `mcpTools.ts`, list services (`grantFilter`), `server/today/providers.ts`, `server/searchRoutes.ts`; new `server/restV1.ts`, `src/keys/ResourcePicker.tsx`; optional `server/team/serviceAccounts.ts`, `src/team/Integrations.tsx`. Tests: `toolResourcePolicy.test.ts` (enumerates every tool), `restV1.test.ts` (parity), `keySelectors.test.ts`. Commits: `feat: declare resource policy on every MCP tool` · `feat: filter key tools by resource grants` · `feat: add REST v1 tool surface` · `feat: pick resources in the key grant builder` · `feat: add service accounts` · `docs: document REST v1 and scoped keys`.

**Gate for every wave:** all tests; a fresh-session `/security-review` focused on that wave's T-rows; the 390 px Back/Forward pass on every new dialog and route; MCP tools per module unchanged or extended as listed; release notes state exactly which powers moved (T145).

---

## K. Amendments to other plans (for the director to apply when this plan is accepted)

- **Vault plan (024, Waves 25–27):** replace `vault_api_keys` and `vault_api_key_grants` with `mcp_api_keys.kind='vault'` and `api_key_grants` (`module='vault'`, `resource_kind='vault'`, `env_id`, permission `read|write|create`). `allow_mcp_value_reads` is already added by 025. The key endpoints move to `/api/keys` with `kind:'vault'`, and the vault's `/api/vault/keys` becomes a filtered view. Group access to vaults uses `group_grants` with `env_id`. D217–D221 otherwise stand.
- **Agent inbox (Wave 21/22):** a proposal kind's check also runs `authorize()` with the target resource, so a key scoped to board A cannot propose changes on board B. Rotation moves `routines.key_id`.
- **Wave 19:** `notes:publish`, `files:write`, and `bin:write` map to permissions `publish`, `write`, and module `bin` in `scopeToGrant`. `alsoRequires` is preserved (a Bin tool needs a `bin` grant **and** the module's write grant on the same resource).
- **Whiteboards (023):** `whiteboards:read/write` map to module `whiteboards`; selector kinds `folder` and `whiteboard`.
- **Team plan:** the §2.2 matrix gains rows for groups (admin), policies (admin), key inventory (admin), and the own access page (all but guests). D73 is restated with D267 to D269.
- **Email research (026):** consume the events in §C.11.

## Sources

1. GitHub Docs, Managing your personal access tokens: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
2. GitHub Docs, Setting a personal access token policy for your organization: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization, and Reviewing and revoking personal access tokens in your organization: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/reviewing-and-revoking-personal-access-tokens-in-your-organization
3. Linear Docs, API and Webhooks: https://linear.app/docs/api-and-webhooks, and Security & Access: https://linear.app/docs/security-and-access
4. Notion Developers, Authorization: https://developers.notion.com/docs/authorization
5. Linear Developers, OAuth 2.0 authentication (scopes, `actor=app`): https://linear.app/developers/oauth-2-0-authentication
6. Notion Help, Sharing & permissions: https://www.notion.com/help/sharing-and-permissions
7. Slack Developer Docs, Tokens: https://docs.slack.dev/authentication/tokens
8. Slack Help, Manage app approval for your workspace: https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace, and Set organization-level policies for apps: https://slack.com/help/articles/360038559694-Set-organization-level-policies-for-apps
9. Infisical Docs, Machine identities: https://infisical.com/docs/documentation/platform/identities/machine-identities
10. Doppler Docs, Service tokens: https://docs.doppler.com/docs/service-tokens
11. Bitwarden Help, User types and access control: https://bitwarden.com/help/user-types-access-control/
12. Nextcloud user manual, Session management (device passwords): https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html
13. Nextcloud Group folders README (inherit, allow, deny; delegated management): https://github.com/nextcloud/groupfolders/blob/master/README.md

---

## Director review (2026-09-28)

- **Numbering:** decisions renumbered to **D261–D288** (the email plan holds D231–D260); threat rows T200–T218 stand. Migration 025.
- **Wave numbers:** Access A = **Wave 31**, B = **Wave 32**, C = **Wave 33**, D = **Wave 34** (the email plan holds Waves 28–30). Versions: v0.13.0 → v0.16.0 (email waves take v0.11.x–v0.12.x; exact numbers assigned at release).
- **Accepted:** one key model ("Nook keys") extending `mcp_api_keys` with a grants table; effective rights = grants ∩ owner's current access ∩ org policy, recomputed per call; existing keys migrated to "all" grants of their scopes; the vault uses the same table with a separate key kind `nkv_` and a DB check preventing mixed grants — **the vault plan (Waves 25–27) is amended accordingly: no separate `vault_api_keys` tables**; calendar feeds and invite links stay link tokens listed in the inventory; the shared Access sheet with the ladder view < comment < edit < manage < owner; boards gain viewer/commenter/editor/manager (existing members → editor); collections/calendars gain per-person levels + manager; notes gain editor (no share/delete); files stay view-only; folder sharing still does not cascade; per-module share tables keep their own level column plus one `group_grants` table and a read-only view for central pages; groups managed by admins; the member access page lets admins only remove or lower; titles hidden from admins who cannot read the item (D73 preserved); key inventory with revoke; org policies checked per call; templates applied on invite acceptance; `/api/keys` with narrow (no re-auth) / rotate (re-auth + grace) / revoke, `/api/mcp/keys` alias for one release; per-item `GET/PUT …/access` with a version check; `/api/v1/tools/:name` REST running the same tool definitions; every tool declares the items it touches (test-enforced).
- **Open-decision defaults accepted**, including admins may add themselves to groups but it is logged and flagged (O-A1).
- **Ordering:** Wave 31 starts after Waves 19 and 22 merge (migration 025 lands after them). Waves 28–30 (email) and 31–34 (access) may overlap in separate worktrees; both touch `server/index.ts` key routes and Settings — keep those edits additive.
