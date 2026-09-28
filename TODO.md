# Nook implementation tracker

**Current state (2026-09-27):** production runs **v0.9.3** at `45a47e9`. Every planned wave (1–17) has shipped: Notes, Files, shared Bin, URL routing, full-text search, Task Boards with views, filters, hierarchy, sprints and a Tasks home, MCP scopes across every module, Today, Collections, Calendar with reminders/push/feeds, Team roles (admin/member/viewer/guest) with blocking, Settings → Modules, custom dropdowns everywhere, and a feature-led README + docs site. Suite: 1156 tests, Docker verify green.

Release history and per-version notes live on the docs site ("What's new") and in `git log`; plans of record are in `DEVELOPMENT_PLAN.md`, `docs/plan/WAVE_13_TASK_CARD_UX.md`, `docs/plan/WAVES_7-9.md`, `docs/plan/WAVES_10-12.md`, and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

## In flight (2026-09-28)

Plans of record: [WAVES_18-20_SMALL.md](docs/plan/WAVES_18-20_SMALL.md) · [agent inbox & routines](docs/plan/research/2026-09-28-agent-inbox-routines.md) · [whiteboard](docs/plan/research/2026-09-28-whiteboard-module.md) · [password vault](docs/plan/research/2026-09-28-password-vault-module.md).

- [ ] Wave 18 Team invites + outbound email wrapper (Resend, D93) — merged. → v0.10.0 with Wave 20 (merged `b85b1d2`) and Wave 21 (merged `e33015a`) — review + QA in progress.
- [ ] Wave 21 Agent inbox: proposals — merged `e33015a`, ships in v0.10.0.
- [ ] Wave 19 MCP write coverage — implemented on `wave-19-mcp-writes` (21 tools, scopes `notes:publish`, `files:write`, `bin:write`, Review / Restore all); awaiting review, `/security-review` (T142–T149), and the real-client gate. → v0.11.0. Deferred: the Bin "via <key>" chip.
- [ ] Wave 22 Routines and runs — building. → v0.11.0.
- [ ] **Priority (operator, 2026-09-28):** access management & API keys, and outbound email — research running now, then waves. Migration ids 025 (access) and 026 (email prefs).
- [ ] Waves 23–24 Whiteboard (Excalidraw; spike passed, parked on its branch) and Waves 25–27 Password vault — after the two priority items; awaiting the operator's pick.
- [ ] Email consumers after Wave 18: Calendar reminders, notification digests, per-user "email me" preference (folded into the email research below).

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
