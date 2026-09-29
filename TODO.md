# Nook implementation tracker

**Current state (2026-09-28):** production runs **v0.12.0** at `da7a819` (API keys with grants, expiry, rotation and policies; Team → Keys/Policies; email digests, reminders by email, mutes, Resend webhooks; review + QA fixes; migrations 025/028; 1600 tests). Every planned wave (1–17) has shipped: Notes, Files, shared Bin, URL routing, full-text search, Task Boards with views, filters, hierarchy, sprints and a Tasks home, MCP scopes across every module, Today, Collections, Calendar with reminders/push/feeds, Team roles (admin/member/viewer/guest) with blocking, Settings → Modules, custom dropdowns everywhere, and a feature-led README + docs site. Suite: 1156 tests, Docker verify green.

Release history and per-version notes live on the docs site ("What's new") and in `git log`; plans of record are in `DEVELOPMENT_PLAN.md`, `docs/plan/WAVE_13_TASK_CARD_UX.md`, `docs/plan/WAVES_7-9.md`, `docs/plan/WAVES_10-12.md`, and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

## In flight (2026-09-28)

Plans of record: [WAVES_18-20_SMALL.md](docs/plan/WAVES_18-20_SMALL.md) · [agent inbox & routines](docs/plan/research/2026-09-28-agent-inbox-routines.md) · [whiteboard](docs/plan/research/2026-09-28-whiteboard-module.md) · [password vault](docs/plan/research/2026-09-28-password-vault-module.md).

- [x] Waves 18, 20, 21 — released in **v0.10.0** (`4479949`).
- [x] Waves 19, 22, 28 — released in **v0.11.0** (`8858c23`, migration 026, backup taken before deploy).
- [x] Waves 29 and 31 — released in **v0.12.0** (`da7a819`, migrations 025/028, backup taken before deploy). Review HIGH (chosen-item keys leaked foreign titles via relations/links/note fields) fixed pre-release.
- [ ] **v0.13.0 release candidate (2026-09-29):** Waves 30 + 32 on main at `76882be` (migration 029), running on `nook-qa` as 0.13.0-rc3. Done: independent review (no HIGH; fixes merged at `4159de6`), end-user QA (pass with issues; 4 MEDIUM, 8 LOW), fix passes A (history guard holds on landing entries at every width, dropdowns are Back layers, no native prompts, password pages), B (guest rule applies only to what a save adds or raises, read-only users get no card actions, unsaved-changes guards, labels) and C (Board settings and the Calendars sheet stay under the dialogs they open). Migration 029 rehearsed on a v0.12.0-shaped database. Director decisions: the guest policy is a write-time refusal and is not retroactive; manager powers stay off API keys (D265, T145). **Open before release:** `tests/routines.test.ts` "pause, then resume after today's run" fails since 2026-09-29 08:00 UTC because of the calendar date (fix agent D, which also hunts other date- and order-dependent tests); verification QA of rc3. Then: release commit, Docker verify, backup (029), deploy; release notes state the powers that moved to managers.
- [ ] **Operator pick (2026-09-29): drive everything.** Order: v0.13.0 → Wave 35 (Google sign-in) → Wave 33 (Access C) → Wave 23 (Whiteboard A) → Wave 34 (Access D) and Wave 24 (Whiteboard B) → Waves 25–27 Password vault (independent review before the Wave 27 release). Migration ids: whiteboards **030**, vault **031**, Wave 33 **032** (`access_central`: access notices, invite template snapshot, actor index), 033 reserved for Wave 34, Google sign-in **034**. State: **Wave 33** built on `wave33-access-c` (`17ed8a2`), reviewed (no HIGH; M1 template snapshot and 5 LOW fixed), QA passed with issues (fixed), merged with main `be45253`, running on `nook-qa-w33` (port 22127); next: merge after v0.13.0, gates, release. **Wave 23** built on `wave23-whiteboards` (`ee00dcd`), running on `nook-qa-w23` (port 22128); review found HIGH H1 (a read could label an older scene with a newer revision, allowing a silent overwrite) plus M1 and 12 LOW: fixes in progress; end-user QA to rerun on the fixed build.
- [ ] **Wave 35 — Google sign-in (operator request, 2026-09-29):** OpenID Connect sign-in with automatic account creation, avatars saved from Google and shown in place of the letter placeholders (downloaded by the server and served same-origin, CSP unchanged), env `AUTH_METHODS` = `password` | `google` | `both` (default `password`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_ALLOWED_DOMAINS`; migration **034**; decisions D289–D300, threats T250–T262; plan `docs/plan/WAVE_35_GOOGLE_SIGNIN.md` on the branch `wave35-google-signin`. Built; security review: token validation, flow binding, redirects, 2FA, method enforcement and avatar fetch all held; **HIGH-1** (the automatic reset on linking to an unverified account left the squatter's sharing in place, and with email off it would have reset every legitimate account) plus 3 MEDIUM, 10 LOW. **Redesign (director):** no automatic link to a never-verified account and no automatic reset; link from Settings after password sign-in, or admin approval in Team (24 h, single use, optional full reset that also removes sharing), or host CLI; link by email only where Google is authoritative for the address; Google re-authentication only for accounts without a usable password and with a fresh Google sign-in. Fixes in progress; a second security review and end-user QA follow. No real Google round trip can be tested by agents: the first real sign-in is the operator's.
- [ ] Carry-overs (operator 2026-09-29: drive as seen fit; one agent after v0.13.0): "No expiry" key option, bell notification on admin key revoke, settings URL still `/settings/mcp`, Today one-time digest prompt (D248), `RESEND_WEBHOOK_SECRET` row missing from the site env table, remaining native `window.confirm` calls (API key not saved, disable 2FA, recovery codes, discard draft, Empty bin, leaving during uploads), muted calendar shown only by icon, Files list/grid toggle 40 px on phones, perf test 150 ms budget, Calendar header Bin button, N+1 level lookups in board/collection/calendar lists and the group items page (review L6).

- [ ] Standing rule for agent briefs (2026-09-29): never stop processes by name or pattern; the production and QA containers run `bun server/index.ts` as the same host user (an agent's `pkill` matched both; the kills were refused). Agents stop only their own processes by recorded pid.

- [ ] Reliability: two flakes seen once each in full runs — `tests/teamMcp.test.ts` list_invites ordering (same-millisecond invites) and `tests/reactions.test.ts` "one aggregate query per page"; hunt after v0.11.0.

## Research queue — after Waves 18–22 ship (operator, 2026-09-28): research, then drive development

### Access management and API keys across modules
- [ ] Research which modules need their own API-key management (today: MCP keys with scopes; vault keys `nkv_` planned in Wave 27) and which API updates are needed for granular role-based usage and access management per module (notes, files, tasks/boards, collections, calendar, inbox/routines, whiteboards, vault).
- [ ] Design: access management may be driven **inside each module** (optional, per item/space) but must also be drivable **centrally from the Team module** (per user: what they can reach in every module, key inventory and revocation, role templates). One consistent permission vocabulary, audit, and MCP/REST parity.
- [ ] Then plan waves and build.

### Outbound email across modules
- [ ] Research every email that should go out from modules, workflows and actions (invites, reminders, mentions/assignments, proposals awaiting approval, shared-with-you, sprint completed, digest, security events such as new API key / blocked account / new device), with per-user preferences and quiet hours.
- [ ] Email design: modern, looks good, fits the product UI (dark-friendly, brand mark, plain-text alternative), one shared template system over the `server/mail.ts` Resend wrapper (D93), each mail with a contextual deep link back into the web app (`/tasks/:b/card/:k`, `/inbox`, `/team/invites`, …).
- [ ] Then plan waves and build.

## Research queue (operator, 2026-09-27) — research only when picked

### Messages module (Slack-like) — TODO, research not yet run (target doc `docs/plan/research/2026-09-27-messages-module.md`)
- [ ] Public/private channels; 1:1 and group DMs without a channel name, convertible into a channel; permalink + channel id.
- [ ] Threaded replies; sent time only (no read/delivery receipts); copy/forward any message or thread to another chat/group/channel; pin messages; archive a channel; add/remove members.
- [ ] Each channel: Messages tab + Notes tab (notes bound to the channel); @mentions of people in messages and channel notes; #channel mentions.
- [ ] Rich Markdown message bubbles (bullets, tables, links) for agent output; message search across channels (text, sender, channel…).
- [ ] Incoming/outgoing webhooks for external agents; incoming messages as reusable component JSON (Block-Kit-like).
- [ ] Per-person configurable notifications.
- [ ] Link unfurl when the URL supports it, as a hookable module so per-site unfurlers can be added later.
- [ ] Reactions on messages: a quick-reaction row (the curated set) AND a complete emoji set picker with search; reuse the Wave 20 `reactions` registry (`message` target kind) and its counts/names semantics.
- [ ] UI/UX research: how Slack, Discord, Zulip, Mattermost, Element do it; best UX for Nook (mobile-first, history parity).

### Agentic chat module — TODO, research not yet started (pick up later)
- [ ] Layout: left nav (threads) + right chat pane, 2-column.
- [ ] Settings: configure MCP tool servers (streamable HTTP or stdio); OpenAI-compatible endpoint + API key + default model (default endpoint = OpenAI, default model `gpt-6-luna`); configurable per-agent model override and max steps.
- [ ] Create agents in Settings: system prompt + chosen MCP tools; chats run against an agent.
- [ ] External API key to call an agent from outside; API-key calls do NOT appear in chat threads but in a separate **Audit log** nav: input, number of steps, tool calls + results, output, timings per call.
- [ ] Chat UI: rich Markdown rendering (bullets, tables, links); private chats; share a chat with a user, all users, or make it public.
- [ ] FAQ knowledge base via text embeddings over text documents, exposed as an MCP tool selectable in the agent's tool picker.
- [ ] UI/UX research: how ChatGPT, Claude, Open WebUI, LibreChat, LobeChat, Dify lay out threads/settings/tool config; audit-log UX; best fit for Nook.
