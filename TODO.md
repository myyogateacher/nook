# Nook implementation tracker

**Current state (2026-09-27):** production runs **v0.9.3** at `45a47e9`. Every planned wave (1–17) has shipped: Notes, Files, shared Bin, URL routing, full-text search, Task Boards with views, filters, hierarchy, sprints and a Tasks home, MCP scopes across every module, Today, Collections, Calendar with reminders/push/feeds, Team roles (admin/member/viewer/guest) with blocking, Settings → Modules, custom dropdowns everywhere, and a feature-led README + docs site. Suite: 1156 tests, Docker verify green.

Release history and per-version notes live on the docs site ("What's new") and in `git log`; plans of record are in `DEVELOPMENT_PLAN.md`, `docs/plan/WAVE_13_TASK_CARD_UX.md`, `docs/plan/WAVES_7-9.md`, `docs/plan/WAVES_10-12.md`, and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

## Open

- [ ] Email: reminders and notification digests over the `server/mail.ts` (Resend) wrapper once Wave 18 lands it; per-user "email me" preference in Settings → Notifications.

- [ ] Wave 16 (Team C): invite links (`team_invites`, migration `018`), per `docs/plan/research/2026-09-26-team-module.md` §8 — unscheduled.
- [ ] MCP write-coverage wave: publish notes, bin/restore cards and events, file upload, tag and sprint management, collection creation — proposed, awaiting go-ahead.
- [ ] Real-device checks only the operator can run on the HTTPS origin: a push notification to a phone; a phone calendar feed subscription (TEST_PLAN manual rows).
- [ ] QA instance `nook-qa` (port 22126) holds throwaway `qa*-`/`rev*-` accounts and data only; rebuild from `main` before each QA round.

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
- [ ] UI/UX research: how Slack, Discord, Zulip, Mattermost, Element do it; best UX for Nook (mobile-first, history parity).

### Agentic chat module — TODO, research not yet started (pick up later)
- [ ] Layout: left nav (threads) + right chat pane, 2-column.
- [ ] Settings: configure MCP tool servers (streamable HTTP or stdio); OpenAI-compatible endpoint + API key + default model (default endpoint = OpenAI, default model `gpt-6-luna`); configurable per-agent model override and max steps.
- [ ] Create agents in Settings: system prompt + chosen MCP tools; chats run against an agent.
- [ ] External API key to call an agent from outside; API-key calls do NOT appear in chat threads but in a separate **Audit log** nav: input, number of steps, tool calls + results, output, timings per call.
- [ ] Chat UI: rich Markdown rendering (bullets, tables, links); private chats; share a chat with a user, all users, or make it public.
- [ ] FAQ knowledge base via text embeddings over text documents, exposed as an MCP tool selectable in the agent's tool picker.
- [ ] UI/UX research: how ChatGPT, Claude, Open WebUI, LibreChat, LobeChat, Dify lay out threads/settings/tool config; audit-log UX; best fit for Nook.

## Backlog — unscheduled

Research reports (2026-09-25): [feature enhancements](docs/plan/research/2026-09-25-feature-enhancements.md) · [new modules](docs/plan/research/2026-09-25-new-modules.md).

- [ ] Agent inbox and routines (M) — stored routines run by outside AI clients over MCP; results return as proposals to approve.
- [ ] Whiteboard/canvas stored as files — next in line if wanted. Rejected: password vault, scanning/OCR, photo gallery, transcription, RSS (reasons in the report), and Journal and Bookmarks/read-later (operator, 2026-09-28); chat is re-opened as the Messages research item above.
- [ ] Light theme / theme toggle (the app is dark-only; noted by QA).
- [ ] Nice-to-haves seen in QA: "+N"-only tag footer on very narrow cards; comment box pins late at 761–1099 px in the card drawer.

**Enhancements to existing modules (not chosen yet):** tags, wikilinks/backlinks, daily notes and templates, cross-note task list, Markdown export and Obsidian/Notion/Joplin import, passkeys, installable offline app with share target, web clipper, document OCR, encrypted vault notes.
