# Workspace modules: Forms & Polls, Time, Goals, Check-ins, CRM, Bookings

Source of truth for six new modules and the shared foundations under them. It is the brief for the build agents (Wave 1 foundations, Wave 2 module lanes, Wave 3 wiring). Read §0 and §F first, then your lane's §D section, §B (the primitives you must use, not rebuild), and §E (design).

**Contents:** [0 Ranges](#0-ranges-names-and-conventions) · [A Research and scope](#a-research-summary-and-committed-scope) · [B Shared primitives](#b-cohesion-architecture-shared-primitives) · [C Integration matrix](#c-cross-module-integration-matrix) · [D Per-module specs](#d-per-module-specifications) (D.0 Foundation, D.1 Forms, D.2 Time, D.3 Goals, D.4 Check-ins, D.5 CRM, D.6 Bookings, D.7 Townhall, D.8 Wave 3) · [E Design](#e-design-and-ux-guidelines) · [F Build plan](#f-build-plan) · [G Open questions](#g-open-questions-for-the-product-owner) · [H Risks](#h-risks)

Base: branch `feat/workspace-modules`, cut from `feat/tasks-keys-dates-estimates-activity` (PR #3: card keys, move between boards, start dates, estimates, card activity, Timeline view). Migrations on that base end at **082**; decisions at **D769**; threats at **T462**. **Reserved for the parallel friendly-URLs lane on PR #3's branch: migrations 083–084, decisions D770–D789, threats T490–T499** ("friendly URLs (D770–D789)": human slug + stable short id; this plan follows that convention, §B.4.4).

## 0. Ranges, names, and conventions

| Block | Lane | Migrations | Decisions | Threats | Module id | Routes | MCP scopes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Foundation (server) | W1-CORE | **085–089** | **D800–D829** | **T500–T514** | — | `/p/*` shell, `/api/links`, `/api/datasets` | — (pre-registers all below) |
| Foundation (UI) | W1-UI | none | **D830–D839** | — | — | — | — |
| Forms & Polls | FORMS | **090–092** | **D840–D869** | **T515–T529** | `forms` | `/forms/<slug>-<sid>`, `/p/f/:token` | `forms:read`, `forms:write` |
| Time tracking | TIME | **093–095** | **D870–D899** | **T530–T539** | `time` | `/time` | `time:read`, `time:write` |
| Goals / OKRs | GOALS | **096–098** | **D900–D929** | **T540–T549** | `goals` | `/goals/<slug>-<sid>` | `goals:read`, `goals:write` |
| Check-ins (standups) | CHECKINS | **099–101** | **D930–D959** | **T550–T559** | `checkins` | `/checkins/<slug>-<sid>` | `checkins:read`, `checkins:write` |
| CRM | CRM | **102–105** | **D960–D999** | **T560–T574** | `crm` | `/crm/contacts/<slug>-<sid>` … | `crm:read`, `crm:write` |
| Bookings | BOOK | **106–109** | **D1000–D1039** | **T575–T594** | `bookings` | `/bookings`, `/p/book/*` | `bookings:read`, `bookings:write` |
| Wiring | W3-WIRE | **110–112** | **D1040–D1059** | **T595–T599** | — | — | — |
| Workspace data in Reports | W3-REPORTS | **113–114** | **D1060–D1069** | **T600–T609** | — | — | — |
| Townhall (§G.1) | TOWNHALL | **115–117** | **D1070–D1099** | **T610–T619** | `townhall` | `/townhall/<slug>-<sid>`, `/p/t/:token` | `townhall:read`, `townhall:write` |

Rules that apply to every lane:

- Migrations are append-only and transactional, one file per id (`server/migrations/NNN_name.ts`), each listed in the lane's own registry file (`server/migrations/workspace/<module>.ts`, §B.1). Ids inside a block ascend, and the blocks are concatenated in id order, so the runner's ascending check holds however the lanes merge (a dev database that applied a later block first simply applies the earlier one on its next start); a lane that needs fewer leaves the rest unused (gaps are normal, see 045/054). Nothing is released until Wave 3 integrates, so no renumbering is expected; if one is, the integrator renumbers (as lane ACTIVITY's 067 → 081).
- Decision ids are cited in code comments and docs the way the repo already does (`D713`). A lane writes its decisions into its own section of this file (§D.x "Decisions as built") when it merges; it never edits another lane's section.
- Every write goes through a service function that runs inside one transaction with audit and item activity, so web, MCP, REST v1, agents, and approved proposals behave the same (the D742 pattern).
- Every list is keyset-paged, every text column has a length CHECK, every JSON column `json_valid` plus a byte cap, ids are UUIDv7 (time-ordered) unless stated.
- Tests run with `bun --no-env-file test`; Visual QA at 1585, 1280, 390 px (TODO.md "Standing rules for agent briefs").
- Plain words in the UI: "Forms", "Time", "Goals", "Check-ins", "CRM", "Bookings". Settings → Modules lists them; each can be turned off (not a boundary, T97).

Glossary: **item** = any addressable thing (card, note, form, goal…); **container** = the item that carries sharing (board, calendar, form, goal, contact book…); **WorkRef** = `{ kind, id }` naming an item across modules (§B.4); **PersonRef** = a team user or a contact (§B.3); **question set** = a versioned list of questions (§B.2).

---

## A. Research summary and committed scope

Research is from product knowledge of the leading tools as of late 2026; it informs the scope, it is not a feature-parity promise. Each module lists what leaders share (table stakes), what differentiates, what v1 commits to, and what is explicitly out.

### A.1 Polls & Forms

**Leaders:** Slack Polly / Simple Poll (in-chat polls), Doodle / Rallly (find a time), Google Forms, Microsoft Forms, Typeform, Tally, Formbricks.

**Shared by leaders (table stakes):**
- Question types: short/long text, single/multiple choice, dropdown, rating/stars, linear scale, NPS (0–10), date/time, number, email/phone/URL, yes/no, file upload, matrix/grid, ranking; section breaks and statements.
- Required/optional, validation (length, number range, regex for text), "other" option, shuffled options.
- Conditional logic (show/skip question or section based on earlier answers), jump to section, custom end screen.
- Sharing by link; restrict to the organization; one response per person; anonymous mode; close at a date or after N responses.
- Results: per-question summary charts, individual responses, CSV export, notifications on response.
- Polls: one question, quick create in context (chat/doc), anonymous or named votes, live or hidden-until-closed results, multiple votes, close manually or on a schedule.
- Find-a-time (Doodle/Rallly): proposed slots, yes / if-need-be / no per slot, participants' time zones, organizer picks the final slot and books it.

**Differentiators:** Typeform's one-question-per-screen conversational layout; Tally's document-like editor (type `/` to insert a question) and generous free tier; Formbricks' in-product surveys and open-source self-hosting; hidden fields / URL prefill; calculated scores (quizzes); partial responses; webhooks/integrations that route responses (create a ticket, add to CRM); Microsoft Forms' quiz mode; theming.

**v1 scope (committed):**
- One module, **Forms**, with three kinds: `form` (multi-question form or survey), `poll` (one question, embeddable, live results), `time_poll` (find a time).
- All question types in §B.2 (except signature/payment), required, validation, "Other", shuffle, sections, show-if logic and jump-to-section, end screens, hidden fields prefilled from the URL, scoring (sum of option scores, shown to the owner only).
- A Tally-like editor: a column of question blocks, `/` to insert, drag to reorder, live preview pane on desktop; one-question-per-screen display mode (Typeform-like) as a form setting.
- Audiences: workspace members, chosen people/groups, or **anyone with a public link** (admin policy, off by default).
- One response per person (signed-in), per browser (public, best-effort), or unlimited; allow editing a submitted response (signed-in only); anonymous mode (identity never stored).
- Close at a date, after N responses, or manually; reopen.
- Results: summary per question (bar/pie/NPS gauge/rating distribution/word list), individual responses with prev/next, filters by answer, CSV export, per-response delete.
- **Response actions** (routing): create a task card on a board, create or update a CRM contact (and optional deal), notify people. Configured per form.
- Polls: create from a note (`/poll`), a card comment, a Today quick action, or MCP; embed in notes and card descriptions; anonymous or named; single or multi-vote; results live / after voting / after close; close at a time.
- Time polls: propose slots from a calendar picker (with your busy times shown), participants vote yes/maybe/no in their own zone, organizer finalizes → calendar event with participants invited by email (internal) and a link card for outside people.
- Theming: accent color and cover image within the Nook palette (§E), light card on the public page (§E.6).

**Out of scope (v1):** payments, e-signatures, quizzes with auto-grading shown to respondents, partial-response saving for public respondents, file upload on public forms (members only in v1, T521), webhooks to outside URLs, custom domains, custom CSS, multi-language forms, A/B testing, in-product (embedded on outside websites) widget, response piping into question text beyond the respondent's own earlier answers, CAPTCHA services (we use our own anti-abuse, §B.8).

### A.2 Time tracking

**Leaders:** Toggl Track, Harvest, Clockify, Jira worklogs (plus Tempo).

**Shared:** one running timer per person, start/stop from anywhere (browser extension, task), manual entries, duration parsing (`1h30`, `1.5h`, `90m`), week timesheet grid, projects and clients, billable flag and rates, tags, entry descriptions, summary/detailed reports grouped by project/client/person/tag with date ranges, CSV export, rounding in reports, editing past entries, team view for managers.

**Differentiators:** Harvest's invoicing, budgets, and timesheet approvals; Toggl's calendar view (drag to create, calendar events as suggestions) and idle detection; Clockify's free unlimited users, kiosk, scheduling; Jira's per-issue worklogs with "original/remaining estimate" and time on the issue itself; Tempo's capacity planning.

**v1 scope:**
- A global **timer chip** in the top bar (start, stop, switch, edit running description, attach to a card), one running timer per person, survives reloads and devices (server-side).
- Start a timer from a card (card header ▶, card face hover, `t` on a focused card) and from a goal, contact, deal, or booking.
- Manual entries with the duration parser; edit start/end; split; duplicate; "continue" (start again with the same fields).
- **Week timesheet** (rows = project × work item, columns = days, type durations in cells), **Day calendar view** (entries as blocks beside your calendar events; "Log this event" one click; drag to create/resize).
- Projects (with an optional client = CRM company), billable default, hourly rates (project rate, member rate override), budgets in hours or money with progress, project linked to a board (entries on its cards default to it).
- Tags (per workspace, free text, up to 5 per entry).
- Card integration: card **Time** section (logged total, per-person worklog, progress vs estimate when the board estimates in hours), logged totals on card faces (optional), Timeline bars show logged vs estimate.
- Reports: Summary (grouped by project, client, person, card, tag, day/week/month) and Detailed (entries), billable amounts, rounding (none/6/15/30 min, report-time only), CSV export, saved filters. Feeds Reports and Goals (§B.10, §C).
- Timesheet **approval (light)**: a project manager can lock a person's week (approved entries become read-only for the author; manager can unlock).
- Reminders: optional "you have no time logged today" nudge and "timer running for 8h" alert.

**Out of scope (v1):** invoices, expenses, idle detection, browser extension and desktop apps, GPS/kiosk, capacity planning and scheduling, payroll exports, currency conversion, multiple currencies inside one project, screenshots/activity monitoring (never).

### A.3 Goals / OKRs

**Leaders:** Lattice Goals, Perdoo, Linear Projects & Initiatives, Asana Goals, Weekdone.

**Shared:** objectives with measurable key results (start → target, current), owners, time periods (quarters), company/team/individual levels, parent/child alignment tree, progress roll-up, status/health (on track / at risk / off track), regular check-ins with a note and confidence, progress history chart, linking work (projects/tasks) to goals, goal list filters by period/owner/team, visibility controls.

**Differentiators:** Perdoo's distinction of KPIs (health metrics, ongoing) vs OKRs (change) and strategy map; Asana/Linear automatic progress from linked projects/tasks; Lattice ties goals to reviews and 1:1s; Weekdone's weekly PPP check-in tie-in; Linear's initiatives grouping projects with health updates.

**v1 scope:**
- **Goals** (objectives) with **key results**; goals nest (parent goal) for alignment; levels via an optional team (user group) or person; **periods** (workspace-defined, e.g. "Q1 2027") plus custom start/due dates.
- Key result kinds: number, percent, currency, yes/no, milestone checklist; direction increase/decrease/stay-above/stay-below; weights.
- **Automatic progress sources** (D900s, §D.3): tasks (done/total cards of a board, saved view, tag, or epic; or estimate points done/total), time logged (hours on a time project or card set), CRM (won deal value or count in a pipeline in the period, open pipeline value), Forms (response count, average rating, NPS of a question), Check-ins (average of a numeric/rating question), child goals (weighted average). Manual stays available.
- **Check-ins**: value update + health + confidence (1–10) + note; scheduled reminders to owners (weekly by default); history chart; activity timeline and comments.
- KPI goals: a goal of kind `kpi` with a KR that must stay within bounds and has no end date (Perdoo's KPI idea, kept small).
- Views: **Tree** (alignment), **List** (grouped by period/owner/team, sortable), **Timeline** (bars by period, reusing Tasks Timeline styles), **My goals**. Goal page with KRs, linked work (cards with their status, boards, deals, forms), check-in history, comments.
- Linking: a card, board, sprint, or deal can "contribute to" a goal (work link), shown on the card ("Goal: Grow MRR 20%").
- Close a period: snapshot final scores, mark achieved/missed, optional carry-over.

**Out of scope (v1):** performance reviews, 1:1s, compensation, strategy maps/canvas, OKR scoring rubrics beyond 0–1.0 and percent, goal templates marketplace, cascading auto-creation of child goals, approval workflows for goals.

### A.4 Standups / check-ins

**Leaders:** Geekbot, Range, Standuply, Status Hero, 15Five.

**Shared:** scheduled asynchronous check-ins per team (daily standup, weekly retro/check-in), custom questions, delivery at each participant's local time on chosen weekdays, reminders and a deadline, a report feed of answers grouped by day, "same as yesterday" / prefilled answers, blockers highlighted, skip/out-of-office, participation stats and streaks, reactions and threaded comments on answers, digest emails, mood/pulse questions, anonymous pulse surveys (15Five/Geekbot).

**Differentiators:** Range pulls in work activity (tickets moved, PRs) to prefill "what I did"; Status Hero ties to goals and activity; 15Five's weekly check-in with "high five" and manager review; Standuply's video/voice answers; Geekbot's broadcast to channels and AI summaries.

**v1 scope:**
- **Check-ins** with templates: Daily standup, Weekly check-in (Weekdone PPP: progress/plans/problems), Retro, Pulse (anonymous mood + one question), Custom. Questions from the shared engine (§B.2), with roles: `done`, `plan`, `blockers`, `mood`, `goal_update`.
- Schedule: weekdays + local time, per-participant zone (or fixed zone), deadline after N hours, reminder before deadline; holidays/OOO skip per participant (pause until a date).
- Participants (people and groups) and viewers (access model). Answer in-app (a focused sheet, one question per step on phones), from Today ("Check-in due"), from a notification, or via MCP (`answer_checkin`, so an agent or script can answer for its owner).
- **Range-like prefill**: "What did you do" suggests the cards you moved to done, commented on, or logged time on since your last answer (pick to include as card chips); "Plan" suggests your cards due/started today and yesterday's plan.
- **Blockers**: the blockers answer can reference cards (`MYT-12` or picker); those cards get a "Blocked (check-in)" flag + link; blockers are listed at the top of the round.
- **Goal updates**: an optional question lets participants check in on their key results inline (writes goal check-ins).
- Round report: answers grouped by person (or by question), reactions, comment threads, participation (answered/late/skipped/out), mood trend; streaks per person.
- Digest: when a round closes, followers get a summary (inbox notification + optional email); optional "Post to a note" (appends the round to a chosen note as a published version) — Wave 3.
- Pulse: anonymous, aggregated only (minimum 3 answers before results show, T553).

**Out of scope (v1):** video/voice answers, Slack/Teams delivery, AI summaries (Wave 3+ via agents, optional), manager review workflows and 1:1 agendas, public check-ins.

### A.5 CRM-lite / contacts

**Leaders:** Attio, Twenty, Folk, HubSpot (free CRM), Pipedrive.

**Shared:** contacts (people) and companies with standard fields and custom fields; dedupe by email/domain; lists/segments and saved views (table, kanban); deals in pipelines with stages, value, expected close, probability, owner; activity timeline per record (notes, calls, meetings, emails, tasks); follow-up reminders; CSV import/export with field mapping; search; relationships (contact ↔ company ↔ deal); team sharing; reporting (pipeline value, won/lost, conversion by stage).

**Differentiators:** Attio/Twenty's flexible data model (custom objects, relations, spreadsheet-like views), Folk's lightweight relationship-centric lists and enrichment, HubSpot's marketing/email tracking and forms, Pipedrive's activity-driven sales flow ("next activity" on every deal, rotting deals), email/calendar sync with automatic interaction capture.

**v1 scope:**
- **Contact books** (the sharing container; e.g. "Sales", "Hiring", "Personal") holding **contacts** and **companies**, with built-in fields and book-level custom fields reusing the Collections field engine (text, number, date, checkbox, select, multi-select, URL) plus `person` (team member) and `contact` relations.
- Dedupe: unique email per book, company by domain; "possible duplicate" banner; merge two contacts/companies.
- **Pipelines** with stages (open/won/lost, probability), **deals** (value, currency, expected close, owner, contacts, company, next step + date), a **deal board** (kanban with drag between stages, stage totals and weighted totals) and table; rotting indicator (no activity for N days per stage).
- **Interactions**: log note, call, meeting, email, message on a contact/company/deal with a date; bookings and form responses add interactions automatically; record timeline = interactions + activity + linked items (cards, events, bookings, responses, time).
- **Follow-ups**: "Remind me" on any record (inbox notification at a time) or "Create task" (card on a chosen board, linked).
- Lists (static) and saved views with filters (field, stage, owner, tags, last interaction), table and board views; CSV import with mapping and dedupe preview; CSV export; vCard export of a contact.
- Reports datasets: pipeline by stage, won/lost over time, deal velocity, interactions per owner.

**Out of scope (v1):** email sync/sending from the CRM (mailboxes), email tracking, enrichment from outside services, marketing campaigns/sequences, quotes/products/line items, custom objects beyond contacts/companies/deals, multi-currency conversion, lead scoring, territory rules, phone dialer.

### A.6 Bookings

**Leaders:** Cal.com, Calendly, SavvyCal, Google Calendar appointment schedules.

**Shared:** a public booking page per person with event types (title, duration(s), location, description), weekly availability with date overrides, time-zone-aware slots, buffers before/after, minimum notice, booking window, daily limits, conflict checking against calendars, intake questions, confirmation and reminder emails with calendar invites (ICS), reschedule/cancel links, team scheduling (round-robin, collective), one-off/secret links, manual approval option.

**Differentiators:** SavvyCal's overlay of the booker's calendar and ranked availability; Cal.com's open source, workflows, routing forms, seats; Calendly's routing and integrations; Google's built-in simplicity tied to the calendar; payments for paid sessions.

**v1 scope:**
- **Booking profile** per person (`/p/book/<handle>`), **booking types** (title, slug, durations, location: in person / phone / video link / custom / ask the booker, description, color, intake questions from §B.2).
- **Availability schedules** (weekly hours per day, multiple ranges, zone) with date overrides and holidays; per-type schedule choice.
- Conflict checking against chosen Nook calendars (including recurring events; all-day events optional); buffers, minimum notice, max days ahead, slot interval, daily/weekly limits.
- **Team types**: round-robin (least recently booked, with priority and availability), collective (all hosts free).
- Confirmation: automatic or manual approval (pending → host approves/declines).
- On booking: create the event in the host's chosen calendar (with the booker and answers), **upsert the booker as a contact** in the chosen contact book and log a meeting interaction, optionally create a card (e.g. "Prepare for call with Ana"), notify host(s); email the booker a confirmation with ICS and a manage link (reschedule / cancel), plus reminders (24 h, 1 h configurable).
- Secret one-off links (single use or expiring) for a type; internal booking ("Book time with Priya" from Team/contact pages).
- Bookings list (upcoming, pending, past, cancelled), no-show marking, host-side reschedule/cancel with message.
- Anti-abuse (§B.8): rate limits, per-email caps, optional email verification before confirming, honeypot, minimum fill time.

**Out of scope (v1):** syncing outside calendars (Google/Outlook busy times) — see open question Q1; generating video links (Zoom/Meet APIs); payments; seats/group events; routing forms (Wave 3+ via Forms → booking link); SMS reminders; embedding the booking widget on outside sites (link only); custom domains.

---

## B. Cohesion architecture: shared primitives

Six modules must read as one product. The rule: **if two modules need it, Wave 1 builds it once** and lanes only register into it. Each primitive lists its owner (W1-CORE or W1-UI), its files, and what lanes call.

### B.1 Module registries (lanes add files, they don't edit shared ones)

Today a module touches ~15 shared files (server/index.ts route list, mcpTools.ts spread, mcpScopes.ts, keyGrants.ts, keyResources.ts, moduleIds.ts, src/modules.ts, src/router.ts, src/App.tsx, appShellNavigation.ts, todayApps.ts, searchRoutes.ts, bin.ts types, sweeper.ts, mail/registry.ts). Six parallel lanes editing them would conflict constantly. Wave 1 therefore does two things.

**1. Pre-register every word** the six modules need in the shared vocabularies, once (D800):
- `server/moduleIds.ts` and `src/modules.ts` `MODULE_IDS`: `forms`, `time`, `goals`, `checkins`, `crm`, `bookings` (Settings order after `reports`).
- `server/mcpScopes.ts`: the twelve scopes in §0, implied reads, write classification. `server/keyGrants.ts`: `GRANT_MODULES`, `SCOPE_GRANTS`, `RESOURCE_KINDS` (`form`, `time_project`, `goal`, `checkin`, `contact_book`, `booking_type`). `server/team/roles.ts` role filters: guests get `forms:read`/`forms:write` (responding only) and `checkins:read`/`checkins:write` (answering only), nothing else new; viewers get reads only.
- Migration **085** rebuilds the CHECK-listed tables once with every new word (§D.0): `api_key_grants`, `proposals`, `notifications`, `team_settings`, and recreates `access_grants_v`.

**2. Registries** lanes call from their own folder (W1-CORE unless marked UI):

| Registry | File | Lane calls | Replaces editing |
| --- | --- | --- | --- |
| Server module entry | `server/workspaceModules.ts` imports `server/{forms,time,goals,checkins,crm,bookings}/index.ts` (W1 creates each as an empty stub); server/index.ts calls `mountWorkspaceModules(app)` once | lane fills its own `index.ts`: `registerWorkspaceModule({ id, routes(app), publicRoutes(app), mcpTools, binProviders, todayProviders, searchScopes, datasets, workKinds, itemKinds, scheduleHandlers, progressSources, mailTemplates, proposalKinds, agentTools, digestSections })` | server/index.ts, mcpTools.ts, sweeper.ts, searchRoutes.ts |
| Migrations | `server/migrations/workspace/index.ts` concatenates `foundation.ts`, `forms.ts`, `time.ts`, `goals.ts`, `checkins.ts`, `crm.ts`, `bookings.ts`, `wiring.ts`, `reportsWorkspace.ts` (each `Migration[]`, `[]` at first except foundation) | lane appends to its own file | migrations/index.ts (W1 adds one spread line) |
| MCP tools | `server/mcpRegistry.ts` `registeredToolSpecs()` spread into `mcpToolSpecs` | via `registerWorkspaceModule({ mcpTools })` | mcpTools.ts |
| Item kinds (key grants) | `server/keyResources.ts` gains `registerItemKind(kind, lookup, anchorKinds)` | lane registers `form`, `response`, `goal`, … | keyResources.ts LOOKUPS |
| Agent allowlist | `server/agents/nookBridge.ts` gains `registerAgentTools(allowed, never)` | lane classifies its tools | nookBridge.ts sets |
| Proposal kinds | `server/inbox/kinds.ts` gains `registerProposalKind(kind, def)` (words pre-allowed by 085) | lanes register `time_log`, `goal_checkin`, … | kinds.ts |
| Bin types | `ProvidedBinType` widened by W1; `registerBinProvider` exists | lane registers | bin.ts |
| Today sections | `registerTodayProvider` exists | lane registers | — |
| Search | `server/searchRegistry.ts` `registerSearchScope(scope, fn)`; `/api/search` consults it; new `scope=all` | lane registers | searchRoutes.ts |
| Mail templates | `server/mail/registry.ts` gains `registerMailTemplate(name, def)` | lane registers `bookings.confirmed`, … | TEMPLATES object |
| Schedules, datasets, work kinds, progress sources | §B.6, §B.10, §B.4, §D.3 | lane registers | — |
| Client module (UI) | `src/workspaceModules/index.ts` imports `src/{forms,time,goals,checkins,crm,bookings}/module.tsx` (W1-UI stubs, `ready: false`) | lane fills `module.tsx`: `{ id, label, icon, description, ready, app (lazy), parseRoute(segments, search), formatRoute(route), launcher, todaySections, quickActions, topBarItem?, settingsSections?, workKindRenderers, embedRenderers, activityRenderers, searchRenderer }` | src/modules.ts, router.ts, App.tsx, appShellNavigation.ts, todayApps.ts |

`src/modules.ts` spreads `WORKSPACE_MODULE_DEFS` into `MODULES` with `planned: !def.ready`, so a module stays hidden until its lane flips `ready: true` in its own file. `router.ts` gets one generic route shape (`{ app: <moduleId>; path: string[]; search }` delegated to the module's `parseRoute`/`formatRoute`), App.tsx one generic lazy render branch with the standard props (`account`, `role`, `navigate`, `flash`, `onHome`), `AppSection` gains the six ids. What a lane still must touch in shared files is listed per lane in §F.3 as **append-only**, one line each.

### B.2 The question engine (Forms, Polls, Time polls, Check-ins, Booking intake)

One engine defines questions, validates answers, evaluates logic, stores responses, aggregates results. Owner: W1-CORE (`shared/questions/*`, `server/questions/*`) and W1-UI (`src/ui/questions/*`).

**Question set** (`shared/questions/types.ts`): `{ version: 1, questions: Question[], sections: Section[], logic: LogicRule[], endings: Ending[] }`, at most 200 questions, 256 KiB JSON.

```ts
type Question = {
  id: string;            // stable 8-char id, never reused inside a host's sets
  type: QuestionType;
  title: string;         // ≤ 500, inline **bold**/_italic_/links only
  help?: string;         // ≤ 1000
  required?: boolean;
  sectionId?: string;
  role?: "done" | "plan" | "blockers" | "mood" | "goal_update"
       | "contact_name" | "contact_email" | "contact_phone" | "company";   // what other modules read
  options?: Array<{ id: string; label: string; score?: number; color?: string }>; // ≤ 200
  allowOther?: boolean; shuffle?: boolean; minSelect?: number; maxSelect?: number;
  validation?: { minLength?: number; maxLength?: number; min?: number; max?: number; step?: number;
                 pattern?: "email" | "url" | "phone" | "integer" };
  scale?: { min: 0 | 1; max: number; minLabel?: string; maxLabel?: string; icon?: "number" | "star" | "heart" | "emoji" };
  matrix?: { rows: Array<{ id: string; label: string }>; columns: Array<{ id: string; label: string }>; multiple?: boolean };
  slots?: Array<{ id: string; start: string; end: string }>;   // time_slots, UTC ISO, ≤ 100
  allowMaybe?: boolean;                                        // time_slots
  hiddenKey?: string;                                          // hidden: URL parameter name
  prefill?: "last_answer" | "suggest_cards_done" | "suggest_cards_planned"; // check-ins (§D.4)
};
```

**Types** (`QUESTION_TYPES`, table-driven like `CARD_ACTIVITY_KINDS`: a type is one row in shared, one renderer, one aggregator; adding a type later needs no migration):

| Type | Answer value | Aggregation | Public pages |
| --- | --- | --- | --- |
| `short_text`, `long_text` | string (≤ 500 / 10 000) | count, latest list, top words | yes |
| `single_choice`, `dropdown`, `yes_no` | option id (or `other` + text) | counts, % | yes |
| `multi_choice` | option ids | counts, % of respondents | yes |
| `ranking` | ordered option ids | average rank, Borda | yes |
| `rating` (stars/hearts/emoji), `scale` (linear) | integer | distribution, mean, median | yes |
| `nps` | integer 0–10 | promoters/passives/detractors, score | yes |
| `number` | number | min/max/mean/sum, histogram | yes |
| `email`, `phone`, `url` | normalized string | count | yes |
| `date`, `time`, `datetime` | ISO (+ tz) | histogram over time | yes |
| `matrix` | `{ rowId: colId \| colId[] }` | per-row counts (heatmap) | yes |
| `time_slots` | `{ slotId: "yes" \| "maybe" \| "no" }` | yes/maybe per slot, best slot | yes |
| `contact` | `{ name, email?, phone?, company? }` | count | yes |
| `hidden` | string from a URL parameter | counts | yes |
| `file` | document ids (≤ 5, via attachments) | count | **members only** (T516) |
| `person` | user ids | counts | members only |
| `card` | card ids (work refs, keys accepted) | counts | members only |
| `statement` | — (display only) | — | yes |

**Logic** (`shared/questions/logic.ts`): `LogicRule = { id, when: { all | any: Condition[] }, then: { show: id[] } | { hide: id[] } | { jumpTo: sectionId | endingId } }`, `Condition = { questionId, op: "answered" | "not_answered" | "eq" | "neq" | "includes" | "gt" | "lt" | "between", value? }`. Pure; runs on the client (live) and the server (authoritative: answers to hidden questions are dropped; `required` applies to visible questions only). Jumps go forward only (no cycles), checked at save.

**Validation**: `validateAnswers(set, answers, { audience: "public" | "member" })` → per-question errors; members-only types are refused on public submissions.

**Scoring**: `score = Σ option.score` (+ numeric answers flagged `scored`), stored on the response, shown to result readers only.

**Storage** (migration 087): `question_sets` (immutable versions per host), `responses`, `response_answers` (one normalized row per answered value so SQL aggregates directly: choices one row per option, numbers in `value_num`, text in `value_text`). Hosts (`host_kind`): `form`, `checkin`, `booking_type`. A response pins the set version it answered, so editing a live form never corrupts old answers; summaries map by option id (renamed labels show the current label; deleted options show "Removed option").

**Server API** (`server/questions/service.ts`): `saveDraftSet(host, set)`, `publishSet(host)` → version, `currentSet(host)`, `submitResponse({ host, version, subject?, respondent, answers, meta })`, `updateResponse`, `deleteResponse` (undo ticket), `summarize(host, filter)`, `responsesPage(host, filter, cursor)`, `exportCsv(host, filter)` (formula-injection-safe: cells starting with `= + - @` get a leading `'`, T514).

**UI** (W1-UI, `src/ui/questions/`): `<QuestionSetEditor>` (block list, `/` to insert, drag to reorder, per-type settings panel, logic sheet, preview toggle, keyboard: ⌘↑/↓ move, ⌘D duplicate, Backspace on empty title deletes), `<QuestionRenderer mode="page" | "stepper">` (every type; Enter = next, 1–9 pick a choice, arrows on scales), `<ResponseViewer>` (one response, prev/next, J/K), `<QuestionSummary>` (per-type chart via the Reports chart wrapper, §B.10).

### B.3 People: team users, contacts, companies

Two kinds of people, one way to show and pick them.

- **Team users**: `users` rows (people; integrations and service accounts excluded from pickers). Unchanged.
- **Contacts**: external people in a **contact book**. **W1-CORE owns the core tables** (migration 088: `contact_books`, `contacts`, `contact_channels`, `companies`) because Bookings, Forms, and Time write them in Wave 2; CRM owns the UI and everything else (custom-field UI, pipelines, deals, interactions, lists).
- **PersonRef** (`shared/people.ts`): `{ kind: "user"; id } | { kind: "contact"; id } | { kind: "guest"; name; email }` (a guest is an unsaved outsider: a time-poll voter, a booker before upsert).
- **Upsert by email** (`server/people/contacts.ts` `upsertContactByEmail(bookId, { email, name?, phone?, company? }, { source, sourceRef, actor })`): finds by normalized email in the book, else creates; fills only empty fields, never overwrites a human edit (D806); links or creates the company by email domain when the book's "Link companies by domain" setting is on and the domain is not free-mail (`shared/freeMailDomains.ts`). Returns `{ contactId, created }`. Used by Bookings, form actions, MCP, CSV import.
- **Clients for Time** are CRM **companies** (`time_projects.company_id`). With CRM off, Time shows a plain "Client" picker over the same table, in each owner's hidden system book "Clients" (D807), so Time never depends on CRM's UI.
- **UI** (W1-UI): `<PersonChip person>` (avatar/initials, name, contact badge, "Former member", "A contact" when the book is unreadable), `<PersonPicker allow={["user","group","contact"]} bookIds?>` (searches users, groups, readable contacts; inline "Add contact" when allowed), `<CompanyChip>`.
- **Access**: a contact is readable by readers of its book; a contact chip on an item you can read but whose book you cannot shows "A contact" without details (T503).

### B.4 Work links and references

#### B.4.1 Model

`work_links` (086): `(id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at)`, unique `(a_kind, a_id, b_kind, b_id, relation)`, index `(b_kind, b_id)`. Relations: `relates`, `contributes` (work → goal), `tracks` (time entry → work), `source` (created-from: card ← response, contact ← booking), `blocks` (check-in blocker → card), `mentions` (auto from text). Display direction: "MYT-12 contributes to *Grow MRR*".

Existing link tables stay authoritative for what they cover (card relations, `event_links`, `attachment_links`, card hierarchy); the **resolver** reads them too, so a card's **Linked** panel lists everything. New modules write only `work_links`.

#### B.4.2 Kinds and adapters

`shared/workRefs.ts` `WORK_KINDS`: existing `card`, `board`, `sprint`, `note`, `document`, `whiteboard`, `event`, `calendar`, `collection`, `row`, `report`; new `form`, `response`, `time_entry`, `time_project`, `goal`, `key_result`, `checkin`, `checkin_round`, `contact`, `company`, `deal`, `booking`, `booking_type`. Server adapters (`registerWorkKind`; W1 registers the existing kinds, lanes their own):

```ts
type WorkKindAdapter = {
  kind: WorkKind;
  resolve(ids: string[], viewer: Viewer): Map<string, WorkSummary | null>; // null: unreadable or gone
  level(id: string, viewer: Viewer): ItemLevel;                            // for link rules
  itemKind?: ItemKind;                                                     // for key grants
};
type WorkSummary = { kind; id; shortId?; key?; title; subtitle?; href; icon; status?: { label; tone }; progress?: number; due?: string };
```

#### B.4.3 Rules

- Creating a link needs **edit on side A** and **read on side B**; removing needs edit on either side (card relations' rule, T90).
- A link whose other side the viewer cannot read shows "An item you can't open" with the kind icon only (T501); chosen-item keys see only links with both sides reachable (T203).
- Purge: each lane's migration adds `AFTER DELETE` triggers removing `work_links` rows of its kinds (the `attachment_links` pattern); W1 adds them for existing tables. The Bin keeps links (they come back on restore).
- Every link change writes item activity on both sides (`linked`/`unlinked`; cards via `recordCardItems`).

#### B.4.4 URLs, text refs, embeds

- **URLs follow friendly URLs (D770–D789)**, the shared convention from the parallel lane: a cosmetic human slug plus a stable short id, e.g. `/goals/grow-mrr-20-k7f3q2`, `/crm/contacts/ana-silva-9xk2mm`, `/crm/deals/acme-renewal-3jd8ka`, `/forms/onboarding-survey-a1b2c3`, `/checkins/daily-standup-pp81ze`, `/bookings/types/intro-call-q2w3e4`, `/time/projects/acme-website-r5t6y7`. The short id is authoritative; a wrong or stale slug, or an old UUID URL, resolves and is corrected with `history.replaceState`. Every new top-level table has `short_id` (unique, generated by that lane's helper). If the helper is not merged when Wave 1 starts, W1-CORE vendors the same spec in `shared/shortIds.ts` and W3-WIRE dedupes. Public pages use tokens or handles, never short ids (§B.8).
- **Text refs**: `parseWorkRef(text, origins)` accepts card keys (`MYT-12`), any in-app URL of a registered kind (friendly or UUID), and `kind:id`. Notes, card descriptions/comments, check-in answers, and item comments render recognized refs as chips (client) and record `mentions` links (server, on publish/save; a cache like `content_references`).
- **Embeds** (`shared/embeds.ts`, generalizing the whiteboard embed D208): a line `[<Neutral word>](<path> "nook-embed")` renders a live card. v1 kinds: poll (vote inline), form ("Respond"), time poll, goal (progress), booking type (link card). The link text is always the neutral word ("Poll", "Form", "Goal") so readers never learn a title they cannot open (QA H1 precedent). The note editor's `/` menu and the card description editor get "Poll", "Form", "Goal", "Booking link".

### B.5 Item activity, comments, reactions

- **`item_activity`** (086) generalizes `card_activity` (D740–D746) for new modules: `(id, item_kind, item_id, container_kind, container_id, actor_id, actor_label, via, kind, payload, created_at)`. `shared/itemActivity.ts` holds kinds per module (`registerActivityKinds(module, { kind: { shape, coalesce } })`), snapshot-label payloads, 2-minute coalescing, keyset pages, redaction. Service `recordItemActivity` / `recordItemChange` inside the write's transaction. Cards keep `card_activity` unchanged.
- **`item_comments`** (086): `(id, item_kind, item_id, parent_id, author_id, body_md ≤ 20 000, created_at, updated_at, deleted_at)`, one level of threading, @mentions notify, reactions via the existing `reactions` table (`target_kind = 'item_comment'`; its CHECK is a glob, no migration), files via `attachment_links` (`host_kind = 'item_comment'`). Used by goals, deals, contacts, companies, check-in responses, bookings (internal notes), form responses.
- **UI** (W1-UI): `<ItemTimeline kind id>` = comments and activity interleaved with the D746 controls; modules register renderers (`activityRenderers`, typed so a registered kind must have one).

### B.6 Schedules and reminders engine

One dispatcher for everything that fires on a clock: check-in rounds (open, remind, close), form/poll auto-close, goal check-in reminders, booking reminders and pending expiry, long-running timer alerts, period closes.

- **`schedules`** (089): `(id, purpose, owner_kind, owner_id, user_id, rule_json, tz, next_fire_at, claimed_at, last_fired_at, payload_json, enabled, created_at, updated_at)`. `rule_json` is `{ once: iso }`, `{ cadence }` (`shared/routineSchedule.ts` cadences extended with `weekdays: number[]` and `everyNWeeks`), or `{ rrule }` (`shared/calendarRecurrence.ts`). DST behavior is those helpers'.
- **`schedule_fires`**: `(schedule_id, fire_at, status, finished_at)`, primary key `(schedule_id, fire_at)`: at most once per occurrence, even across a crash (claim → insert fire row → handler in its own transaction → done).
- **Dispatcher** (`server/schedules/dispatcher.ts`): 30 s tick and batch 200 (reminders' constants), per-purpose lateness (`skipIfLateMs`), paused during a backup (as the sweeper), `registerScheduleHandler(purpose, { run(schedule, fireAt), skipIfLateMs })`. Purposes are namespaced (`checkins.open`, `bookings.remind`, …). Service API: `upsertSchedule(owner, purpose, rule, payload)`, `cancelSchedules(owner, purpose?)`, `nextFires(rule, from, n)` (UI previews "Next: Mon 09:00, Tue 09:00").
- Lanes never add their own `setInterval`.

### B.7 Notifications, email, push, inbox

- 085 widens `notifications.kind` with `module` and adds `module`, `topic`, `title` (≤ 200), `body` (≤ 500), `href`, `item_kind`, `item_id`, `actor_id`, `dedupe_key` (unique per user while unread). `server/notify/index.ts`: `notify({ userIds, module, topic, title, body?, href, item?, actor?, dedupeKey?, push = true, email?: { template, payload, coalesceKey? } })` writes the row, sends push, and enqueues mail when the user's prefs allow the topic. The bell and Notifications page render module rows with the module icon (W1-UI).
- **Email prefs**: `email_prefs.categories` gains `forms`, `time`, `goals`, `checkins`, `crm`, `bookings` (JSON keys within the 512-byte CHECK; no schema change). Settings → Notifications lists one row per enabled module.
- **External recipients** (bookers, time-poll guests): `enqueueExternalMail({ to, template, payload, itemRef })` (W1-CORE) uses `mail_outbox.to_address`, honors `mail_suppressions`, caps per address (10/hour, 50/day) and per item, never includes internal ids, adds a "stop emails about this booking" link. With mail not configured it returns `null` and callers show "No email will be sent".
- **Inbox proposals**: lanes register `time_log`, `goal_checkin`, `contact_create`, `contact_update`, `deal_create`, `deal_update`, `interaction_log`, `checkin_answer`, `form_create` (words pre-allowed by 085).
- **Digest**: `registerDigestSection` (W1-CORE) on `server/mail/digest.ts` for "Check-ins you missed", "Goals needing a check-in", "Today's bookings", "Follow-ups due".

### B.8 Public pages, links, anti-abuse

- **`public_links`** (089): `(id, kind, item_id, token_hash UNIQUE, token_prefix, created_by, created_at, expires_at, max_uses, use_count, revoked_at, last_used_at, settings_json)`; kinds `form`, `booking_type` (secret one-off links), `booking_manage` (per booking, for the booker), `time_poll_guest`. Tokens are 32 random bytes base64url (43 chars), shown once, SHA-256 stored (D362/D66 pattern). Booking **profiles** use a public handle (`/p/book/<handle>/<slug>`) because they are meant to be shared; secret links use tokens.
- **Policies** (`team_settings`, 085): `public_forms` and `public_booking_pages`, **off** by default; members and admins create public links when on. Turning one off makes its public routes 404 at once and keeps the rows (D362 behavior).
- **Routes**: pages under `/p/…`, JSON under `/api/public/…`. One middleware (`server/public/middleware.ts`, generalized from `server/agents/publicRoutes.ts`): strict CSP (`form-action 'self'`, `frame-ancestors 'none'`), `no-store`, `noindex`, `no-referrer`, no session cookie read or set, CSRF via a signed per-render nonce, one uniform 404 for unknown/revoked/expired/policy-off/binned/closed-by-module.
- **Limits** (`server/public/limits.ts`): per IP (page GET 120/min; submit 10/min, 60/hour), per link (default 300 submissions/hour), per booker email (3 upcoming per type), per-module pause switch. In-memory buckets (single replica, as today) plus durable per-link counters.
- **Bot defenses without third parties**: honeypot field; minimum fill time (signed render timestamp: 3 s forms, 5 s bookings); single-use signed nonce (no replay); 64 KiB body cap; optional **email verification** for public forms and bookings (6-digit code or link to the given address before the submission counts, T577). IPs are stored only as salted hashes in `public_submissions_log`, kept 30 days.
- **Client**: `src/main.tsx` sends `/p/*` to a lazy `src/public/PublicApp.tsx` before any session code (the `/share/c/` pattern). `<PublicPageShell>` (W1-UI): light card on a neutral background (§E.6), workspace name/logo from branding, "Powered by <app name>", 375 px first.

### B.9 Access and sharing

- Six new **AccessKinds**, levels `view < comment < edit < manage`, owner above: `form`, `time_project`, `goal`, `checkin`, `contact_book`, `booking_type`.
- **One generic member table and one generic group-grant table** for them (085): `item_members(item_kind, item_id, user_id, level, created_at)` and `item_group_grants(item_kind, item_id, group_id, level, granted_by, created_at)` (D803: one rebuild of `access_grants_v` now instead of one per lane; reports took their own tables for the same reason, 052). `server/access/shares.ts` `SHARE_TABLES` gains a discriminator (`kindColumn: "item_kind"`); `effective.ts`, `itemAccess.ts`, Settings → Team → Access, and the Access sheet handle the new kinds.
- Each container has `owner_id`, `visibility` (`private` | `selected` | `all_users`), `share_role` (audience level), like calendars and collections.
- **Responding is not access**: who may answer a form or check-in, or book a type, is a separate `audience`, so "everyone can answer, only HR sees results" is one setting.
- Roles: guests respond to forms/polls shared with them and answer check-ins they take part in; no CRM, Time projects, Bookings admin; Goals read-only if shared. Viewers read.
- Chosen-item keys: containers are `RESOURCE_KINDS`; contents anchor on them via `registerItemKind`: `response → form`, `time_entry → time_project` (entries without a project anchor on nothing: whole-module keys only, T531), `key_result → goal`, `checkin_round → checkin`, `contact | company | deal | interaction → contact_book`, `booking → booking_type`.

### B.10 Datasets: module Insights and Reports

Reports run guarded SQL on **ClickHouse data sources only**; Nook's own SQLite data is not reachable there. Plan:

- **Wave 1: dataset registry** (`server/datasets/registry.ts`, `shared/datasets.ts`). A dataset: `{ id, module, label, description, columns: [{ name, type: "string"|"number"|"date"|"datetime"|"bool"|"money"|"duration", label, dimension?, measures?: ("sum"|"avg"|"count"|"min"|"max"|"count_distinct")[] }], timeColumn, from: SQL, scope(viewer): { sql, params } }`. A **structured query** `{ dataset, measures, dimensions, filters, timeRange, timeBucket: "day"|"week"|"month"|"quarter", sort, limit ≤ 1000 }` compiles to parameterized SQLite with the viewer's access predicate always ANDed in. No free SQL. `POST /api/datasets/query`; MCP `list_datasets` / `query_dataset` (the module's read scope; chosen-item keys narrow via `keyFilter`).
- **Module Insights**: each module has an **Insights** tab of preset queries rendered with `<InsightChart>` / `<KpiTile>` (W1-UI wraps Reports' `charts.tsx`, `chartOption.ts`, `KpiTile.tsx`; theme `shared/reportTheme.ts`).
- **Datasets** (lanes register): `forms.responses`, `forms.answers`; `time.entries`; `goals.key_results`, `goals.kr_values`, `goals.checkins`; `checkins.answers`, `checkins.participation`; `crm.deals`, `crm.deal_stage_changes`, `crm.interactions`, `crm.contacts`; `bookings.bookings`; W1 adds `tasks.cards` and `tasks.card_events` (done-over-time from `card_activity`).
- **Wave 3 (W3-REPORTS): "This workspace" data source** in Reports (§D.8, open question Q3): a data source kind `workspace` whose queries are structured dataset queries stored as JSON instead of SQL, so charts, filters, parameters, schedules, and generation work unchanged.

### B.11 Today / Home

Modules register Today sections, launcher tiles, and **Quick actions** (a new Today row from W1-UI: "Start timer", "New poll", "Log a call", "Copy booking link", "Answer check-in", "Check in on a goal").

| Module | Today sections |
| --- | --- |
| Forms | `formsResponses` (your open forms with new responses), `pollsToVote` (polls shared with you, not voted) |
| Time | `timeToday` (today's total, running timer, "nothing logged yet") |
| Goals | `goalsCheckin` (your goals due a check-in), `goalsAtRisk` |
| Check-ins | `checkinsDue` (rounds open for you) |
| CRM | `crmFollowups` (follow-ups due, deals whose next step is today or rotting) |
| Bookings | `bookingsToday` (today's and tomorrow's, pending approvals) |

### B.12 Search

`registerSearchScope` (W1-CORE) and Ctrl/⌘+K: a new **All** scope (default when opened from the top bar) fans out to every registered scope the user has and merges the top 5 per scope under headers. FTS5 per module, lane-owned (`<module>_fts`, unicode61 remove_diacritics 2 as `collection_row_fts`): form titles/descriptions/question titles; goal titles/descriptions/KR titles; contact names/emails, company names/domains, deal titles, interaction bodies; check-in answers (readers of the round only); booker names/emails and type titles; time entry descriptions. Card keys and short ids resolve directly.

### B.13 Bin, purge, retention

- To the Bin (30 days) via `registerBinProvider`: `form`, `goal`, `checkin`, `contact_book`, `contact`, `company`, `deal`, `time_project`, `booking_type` (words pre-added by W1).
- Fine-grained records are deleted at once with an **Undo** toast (10 s) and an audit row: time entries, responses, interactions, item comments, key results. W1 generalizes `server/attachments/undoTickets.ts` into `server/undo.ts` (capture row(s) → ticket → restore).
- Purge deletes children by FK cascade and removes `work_links`, `item_activity`, `item_comments`, `item_members`, `item_group_grants`, `schedules`, `public_links`, `attachment_links`, reactions through triggers each lane adds. Each lane has a test asserting no orphans after purge (`tests/support/orphans.ts`, W1).
- Bookings are never binned (history); cancelling keeps them. `public_submissions_log` expires after 30 days.

### B.14 Audit

Every write: `audit(actorId, null, "<module>.<event>", metadata)` with ids only (never answer text, contact details, tokens; T505); surface from `auditVia()`. Public submissions audit with actor `null`, `via: "public"`, and the link id. Event names are listed per lane in §D.

### B.15 MCP toolkit advancements

- **One shape for every module**: `list_<things>` (filters, `cursor`, `limit ≤ 100` → `{ items, nextCursor }`), `get_<thing>` (id, short id, URL, or key), `create_<thing>`, `update_<thing>` (partial; optional `expectedRevision` → `CONFLICT`), `delete_<thing>` (Bin where Bin-able; also needs `bin:write`, D172), `search_<module>`, and `bulk_<verb>_<things>` where volume is normal (time entries, contacts, deals): ≤ 100 items, all-or-nothing, `dryRun: true` returns the plan.
- **Cross-module tools** (W1-CORE, `server/mcpWorkTools.ts`): `resolve_ref`, `link_items`, `unlink_items`, `list_links`, `search_workspace`, `list_datasets`, `query_dataset`, `get_item_activity`, `comment_on_item`, `list_item_comments`. Scopes: the read/write scope of the module that owns the item(s) named.
- **Metadata**: `defineTool` gains MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`; defaults from `write`) and an optional `outputSchema` returned as `structuredContent` (W1), adopted by all new tools.
- **Resources**: `nook://<kind>/<id>` templates (`registerMcpResource`, W1) for forms, goals, contacts, deals, check-in rounds, bookings, and existing cards/notes, read through the same adapters and checks as `get_*`.
- **Prompts**: `weekly_goal_review`, `standup_summary`, `pipeline_review`, `timesheet_fill` (suggest entries from calendar events and card activity), registered like `registerRoutinePrompts`.
- **REST v1** exposes every new tool automatically, as today.
- **Chat agents** (`nookBridge`): reads allowed; writes as proposals for registered kinds or directly where the agent's mode allows (D353/D359). Never: creating public links, cancelling bookings, bulk deletes, sharing changes, submitting public responses.

### B.16 Units: durations, money, dates

- `shared/duration.ts` (W1): parse `1h30`, `1h 30m`, `1.5h`, `90m`, `1:30`, `45` (minutes; a preference can make bare numbers hours) → seconds; format `1h 30m` or `1:30` (preference); rounding (6/15/30 min, up or nearest).
- `shared/money.ts` (W1): integer minor units + ISO 4217 code, `Intl.NumberFormat`, no conversion. Workspace default currency `team_settings.default_currency` (085), admins edit it in Settings → Workspace.
- Dates: local `yyyy-mm-dd`, instants UTC ISO, IANA zones, `shared/calendarRecurrence.ts` zoned helpers. A `week_start` user preference (W1, default Monday) drives timesheets, check-in schedules, and Insights weeks.

---

## C. Cross-module integration matrix

Rows are flows a person can do end to end. "Lane" is who builds it; **W2** flows are inside one module lane (using foundations only), **W3** flows need two finished modules and belong to W3-WIRE.

| # | Flow | What happens | Primitives | Lane |
| --- | --- | --- | --- | --- |
| C1 | **Booking → contact + event + card** | A public booking creates the event in the host's calendar (booker as attendee text, answers in the description, link back to the booking), upserts the booker as a contact in the type's book, logs a `meeting` interaction, optionally creates a prep card on a chosen board/column ("Prepare: Intro call with Ana Silva"), links all four, notifies the host, emails the booker ICS + manage link. | B.3 upsert, B.4 links, B.6 reminders, B.7 external mail | BOOK (contact upsert + event + card use foundation and existing services; no CRM lane code needed) |
| C2 | **Form response → card (intake)** | A form action "Create a card" maps answers to title/description/due/assignee/tags/estimate (template with `{{question}}` tokens), puts it on a board/column, links response ↔ card (`source`), attaches uploaded files. | B.2, B.4 | FORMS |
| C3 | **Form response → contact / deal** | Action "Add to CRM": upsert contact by the `contact_email` role answer into a book; optional "Create deal" in a pipeline/stage with value from a number answer; interaction `form` logged. | B.3 | FORMS (contact via foundation), deal part W3 (needs CRM deals) |
| C4 | **Check-in blockers → cards** | A blockers answer referencing `MYT-12` (or picked) links the answer to the card (`blocks`), sets the card's flag "Blocked" with activity "flagged as blocked in *Daily standup*"; clearing next round offers "Unblock MYT-12". | B.4, card flags | CHECKINS |
| C5 | **Check-in → goal updates** | A `goal_update` question shows the participant's KRs; values typed there write goal check-ins (as the participant). | B.2 roles | W3 (needs GOALS) |
| C6 | **Check-in prefill from work** | "What did you do" suggests cards you moved to done, commented on, or logged time on since your last answer; "Plan" suggests cards due/starting today. | card_activity, time entries | CHECKINS (cards), W3 adds time |
| C7 | **KR auto-progress from tasks** | KR source `tasks`: done/total cards (or points) of a board, saved view, tag, epic, or sprint, recomputed on card changes (debounced) and hourly. | progress sources | GOALS |
| C8 | **KR from time logged** | KR source `time`: hours on a time project / card set / tag in the KR's period. | progress sources | TIME registers the source (own file) |
| C9 | **KR from CRM** | KR sources `crm_won_value`, `crm_won_count`, `crm_pipeline_value` for a pipeline in the period. | progress sources | CRM registers the source |
| C10 | **KR from forms / check-ins** | `form_metric` (responses count, average of a rating/scale/number question, NPS) and `checkin_metric` (average of a rating question, participation rate). | progress sources | FORMS and CHECKINS register |
| C11 | **KR from child goals** | Weighted average of children's progress. | — | GOALS |
| C12 | **Time from card timer** | ▶ on a card starts the timer linked to the card (`tracks`), project from the board's linked project; card Time section and face show totals; card activity "logged 1h 30m". | B.4, card_activity kind `time_logged` (new row in shared/cardActivity.ts, W1) | TIME |
| C13 | **Time from calendar** | Day view shows events beside entries; "Log this event" creates an entry with the event's time and title, linked to the event. | event service | TIME |
| C14 | **Time on Timeline and estimates** | Board Timeline bars show a logged-vs-estimate fill for hours boards; card dialog shows "3h 20m of 5h". | estimates (D750) | TIME (adds to Tasks via a registered card-section slot, §F.3) |
| C15 | **Time for contacts/deals/bookings** | Timer and entries can track a contact, company, deal, or booking; client = company (billable reports per client). | B.3, B.4 | TIME (generic work refs), W3 adds CRM record panels |
| C16 | **Deals as a board** | Deal board uses the shared `<KanbanBoard>` (same visual language and pointer drag as Tasks boards: column headers with totals, WIP-style stage limits off), card faces with value, contact chip, next step date, rotting dot. | W1-UI kanban | CRM |
| C17 | **Deals ↔ tasks** | "Create task" on a deal/contact makes a linked card; the card shows the deal chip; finishing it logs an interaction "Task done". | B.4 | CRM |
| C18 | **Polls embedded** | `/poll` in a note or card description creates a poll and inserts an embed; readers vote inline; a card comment can contain a poll too. Agent chat: an agent can create a poll via MCP and post its link. | B.4.4 embeds | FORMS (embed renderer) + W1-UI (editor slash hook) |
| C19 | **Time poll → event** | Finalizing a time poll creates a calendar event in the organizer's chosen calendar with the chosen slot, invitees as workspace attendees (reminders) and emailed guests (ICS). | calendar service, B.7 | FORMS |
| C20 | **Booking ↔ CRM record** | Contact/company/deal pages list bookings; "Send booking link" copies a link prefilled with the contact's name/email (hidden fields). | B.4 | W3 |
| C21 | **Form respondents → contacts** | Public form responses with an email can be saved to a book (C3) and appear on the contact timeline. | B.3 | FORMS + W3 timeline |
| C22 | **Goals on cards/boards** | Card and board "Contributes to goal" field; goal page lists linked work with status; board header chip shows its goal. | B.4 | GOALS (goal side, link picker), W3 (card dialog field) |
| C23 | **Standup digest → note** | Closing a round can append it to a chosen note (published version) and post a summary notification. | notes service | W3 |
| C24 | **AI agents across modules** | One key with `time:write goals:write crm:write checkins:write` can: log time from a summary, check in on goals, update a deal after a call, answer standup, create a poll; agents work through proposals unless allowed. | B.15 | each lane + W3 eval script |
| C25 | **Reports on workspace data** | "This workspace" data source: time by client, pipeline by stage, NPS over time, goal progress, standup participation, bookings per week. | B.10 | W3-REPORTS |
| C26 | **Today & digest** | All §B.11 sections, quick actions, digest sections. | B.11, B.7 | each lane |
| C27 | **Global search** | All scope finds a contact, a goal, a form, a booking, a time entry from one box. | B.12 | each lane |

---

## D. Per-module specifications

Common to every module unless stated: tables carry `created_at`, `updated_at` (ISO UTC); containers and Bin-able records carry `deleted_at`, `deleted_by`, `purge_after` (the `${BIN}` columns of 012/013) and `revision INTEGER NOT NULL DEFAULT 1`; `short_id` is `TEXT NOT NULL UNIQUE CHECK (length(short_id) BETWEEN 6 AND 12)` per friendly URLs (D770–D789). Names ≤ 120, titles ≤ 200, descriptions ≤ 20 000 bytes unless stated. HTTP is JSON under `/api`, errors `{ error, code }` as everywhere (`NOT_FOUND` for unreadable, never 403 for existence, T90 pattern). `:id` path params accept the UUID or the short id.

### D.0 Foundation (W1-CORE, W1-UI)

**Decisions D800–D829 (core), D830–D839 (UI)**, threats **T500–T514**. Key decisions:

- **D800** Pre-register all module words and scopes (§B.1); modules stay hidden (`planned`) until their lane sets `ready`.
- **D801** Registries over shared edits (§B.1); `server/workspaceModules.ts` and `src/workspaceModules/index.ts` are the only import points.
- **D802** One question engine with versioned sets and normalized answers (§B.2).
- **D803** Generic `item_members` / `item_group_grants` for the six new access kinds (§B.9).
- **D804** `work_links` for new links; existing link tables stay and are read by the resolver (§B.4).
- **D805** `item_activity` and `item_comments` generalize card activity and comments for new modules; cards unchanged (§B.5).
- **D806** Upsert-by-email fills empty fields only; never overwrites human edits (§B.3).
- **D807** Contact tables are foundation; each user has a hidden system book "Clients" created lazily for Time when CRM is off (§B.3).
- **D808** One schedules engine with at-most-once fires (§B.6).
- **D809** `notify()` for module notifications; module email categories (§B.7).
- **D810** Public pages under `/p/`, tokens hashed, policies off by default, in-house anti-abuse (§B.8).
- **D811** Datasets with structured queries only, viewer predicate always applied (§B.10).
- **D812** URLs follow friendly URLs (D770–D789) (§B.4.4).
- **D813** Fine-grained deletes are immediate with undo tickets; containers use the Bin (§B.13).
- **D814** MCP tool annotations, output schemas, resources, consistent CRUD/bulk shapes (§B.15).
- **D830** Shared UI components (§E.3) live in `src/ui/` and are the only implementation of each pattern.
- **D831** Public pages render light (§E.6); the app stays dark.

**Migrations:**

| Id | Name | Contents |
| --- | --- | --- |
| **085** | `workspace_words` | 12-step rebuilds (the 039 `api_key_grants` pattern) of `api_key_grants` (modules `forms,time,goals,checkins,crm,bookings`; resource kinds `form,time_project,goal,checkin,contact_book,booking_type`), `proposals` (kinds `time_log,goal_checkin,contact_create,contact_update,deal_create,deal_update,interaction_log,checkin_answer,form_create`; target types `form,time_project,time_entry,goal,key_result,checkin,checkin_round,contact_book,contact,company,deal`), `notifications` (kind `module` + new columns §B.7; index `(user_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL` unique), `team_settings` (keys `public_forms`, `public_booking_pages`, `default_currency`); creates `item_members`, `item_group_grants` (+ indexes `(user_id, item_kind)`, `(group_id)`, `(item_kind, item_id)`); recreates `access_grants_v` with both unioned in; adds `grant cleanup` triggers for user/group deletion. |
| **086** | `work_links` | `work_links`, `item_activity` (index `(item_kind, item_id, created_at, id)`), `item_comments` (index `(item_kind, item_id, created_at)`), purge triggers on existing tables (cards, notes, documents, events, collection_rows, boards, calendars, collections, whiteboards, reports) deleting their `work_links` rows; `card_activity` needs no change (kind is free text; `time_logged`, `goal_linked`, `blocked_by_checkin` are new rows in shared/cardActivity.ts). |
| **087** | `questions` | `question_sets(id, host_kind CHECK IN ('form','checkin','booking_type'), host_id, version INTEGER, status CHECK IN ('draft','published'), set_json CHECK json_valid AND ≤ 262144 bytes, created_by, created_at, UNIQUE(host_kind, host_id, version))`, partial unique index one draft per host; `responses(id, host_kind, host_id, set_version, subject_kind NULL, subject_id NULL, respondent_kind CHECK IN ('user','contact','guest','anonymous'), respondent_user_id NULL REFERENCES users ON DELETE SET NULL, respondent_contact_id NULL, respondent_name ≤ 120 NULL, respondent_email ≤ 254 NULL, dedupe_hash NULL CHECK length = 64, status CHECK IN ('submitted','pending_verification'), score REAL NULL, meta_json ≤ 4096, submitted_at, updated_at, revision)`, indexes `(host_kind, host_id, submitted_at DESC, id)`, `(respondent_user_id, host_kind)`, unique `(host_kind, host_id, respondent_user_id) WHERE …one-per-person…` is enforced in service (forms vary); `response_answers(response_id REFERENCES responses ON DELETE CASCADE, question_id, ord INTEGER, option_id NULL, value_text NULL ≤ 10000, value_num NULL, value_json NULL ≤ 16384, PRIMARY KEY (response_id, question_id, ord))`, index `(question_id, option_id)`. |
| **088** | `people` | `contact_books(id, short_id, owner_id, name, color, system_kind NULL CHECK IN ('clients'), visibility, share_role, settings_json ≤ 8192 (link companies by domain, lifecycle options, rotting days), fields_json ≤ 65536 (custom fields, Collections field engine), BIN, revision)`; `companies(id, short_id, book_id REFERENCES contact_books ON DELETE CASCADE, name, domain NULL lower-case ≤ 253, website NULL, description, owner_id NULL, custom_json ≤ 16384, tags_json ≤ 2048, source CHECK IN ('manual','import','booking','form','mcp','email_domain'), last_interaction_at NULL, BIN, revision)` unique `(book_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL`; `contacts(id, short_id, book_id, first_name ≤ 80, last_name ≤ 80, display_name ≤ 160 NOT NULL, company_id NULL REFERENCES companies ON DELETE SET NULL, job_title ≤ 120, owner_id NULL, lifecycle ≤ 40 NULL, tz NULL, location ≤ 200, avatar_document_id NULL, custom_json, tags_json, source, source_ref ≤ 80, last_interaction_at, BIN, revision)`, indexes `(book_id, display_name)`, `(company_id)`; `contact_channels(id, book_id, contact_id REFERENCES contacts ON DELETE CASCADE, kind CHECK IN ('email','phone','url','social'), value ≤ 254, value_norm ≤ 254, label ≤ 40, is_primary, position)` unique `(book_id, value_norm) WHERE kind = 'email'`; triggers keep `work_links`/`item_members` clean on purge. |
| **089** | `schedules_public` | `schedules`, `schedule_fires` (§B.6; index `(next_fire_at) WHERE enabled = 1 AND claimed_at IS NULL`, `(owner_kind, owner_id, purpose)`); `public_links` (§B.8; index `(kind, item_id) WHERE revoked_at IS NULL`); `public_submissions_log(id, link_id NULL, kind, item_id, ip_hash CHECK length = 64, email_hash NULL, outcome CHECK IN ('accepted','rate_limited','honeypot','too_fast','replay','invalid','verification_sent'), created_at)` index `(created_at)`; `public_verifications(id, kind, item_id, email_hash, code_hash, payload_json ≤ 65536, attempts, expires_at, created_at)`; `user_preferences` gains nothing (week start, duration format go into the existing prefs JSON — check its 512-byte cap; if exceeded use a new `user_ui_prefs` row). |

**Files W1-CORE creates** (exclusive): `server/workspaceModules.ts`, `server/{forms,time,goals,checkins,crm,bookings}/index.ts` (stubs only), `server/migrations/workspace/*` (+ `085_…`–`089_…`), `server/mcpRegistry.ts`, `server/mcpWorkTools.ts`, `server/searchRegistry.ts`, `server/questions/*`, `server/people/*`, `server/links/*` (`service.ts`, `resolver.ts`, `adapters.ts` for existing kinds, `routes.ts`), `server/activity/*` (item activity + comments + routes), `server/schedules/*`, `server/notify/*`, `server/public/*` (middleware, limits, nonce, verification, links service), `server/datasets/*` (+ `tasks.cards` datasets), `server/undo.ts`, `server/goalsProgress.ts` (progress-source registry), `shared/tones.ts`, `shared/questions/*`, `shared/people.ts`, `shared/workRefs.ts`, `shared/embeds.ts`, `shared/itemActivity.ts`, `shared/datasets.ts`, `shared/duration.ts`, `shared/money.ts`, `shared/freeMailDomains.ts`, `shared/shortIds.ts` (only if the friendly-URL helper is absent). Edits (W1 only): `server/index.ts`, `server/mcpTools.ts`, `server/mcpScopes.ts`, `server/keyGrants.ts`, `server/keyResources.ts`, `server/moduleIds.ts`, `server/team/roles.ts`, `server/team/policies.ts`, `server/access/{levels,shares,effective,itemAccess}.ts`, `server/bin.ts`, `server/searchRoutes.ts`, `server/mail/{registry,digest,outbox}.ts`, `server/calendar/reminders.ts` (notification listing of `module` rows), `server/inbox/kinds.ts`, `server/agents/nookBridge.ts`, `server/mcpToolKit.ts`, `server/sweeper.ts` (schedules + public log retention), `shared/cardActivity.ts` (+ `time_logged`, `goal_linked`, `goal_unlinked`, `blocked_by_checkin` kinds and renderers), `server/migrations/index.ts`.

**Files W1-UI creates** (exclusive): `src/workspaceModules/*`, `src/{forms,time,goals,checkins,crm,bookings}/module.tsx` (stubs), `src/public/*` (`PublicApp`, `PublicPageShell`, `public.css`), `src/ui/questions/*`, `src/ui/people/*` (`PersonChip`, `PersonPicker`, `CompanyChip`), `src/ui/links/*` (`WorkRefChip`, `LinkedItemsPanel`, `LinkPicker`), `src/ui/activity/ItemTimeline.tsx`, `src/ui/kanban/*` (`KanbanBoard`, pointer drag ported from Tasks' approach with `scripts/dragSmoke.ts` coverage), `src/ui/progress/*` (`ProgressBar`, `ProgressRing`, `HealthChip`), `src/ui/time/*` (`DurationInput`, `DurationChip`, `TimerChip` shell), `src/ui/schedule/SchedulePicker.tsx`, `src/ui/money/MoneyInput.tsx`, `src/ui/insights/*` (`InsightChart`, `KpiTile` wrappers), `src/ui/ModuleHome.tsx` (module home scaffold §E.2), `src/ui/EmptyState.tsx` (if absent), `src/ui/cardSlots.ts` (registries for card dialog sections, card face badges, card header actions). Edits (W1-UI only): `src/modules.ts`, `src/router.ts`, `src/App.tsx`, `src/appShellNavigation.ts`, `src/main.tsx`, `src/AppShell.tsx` (top-bar slot for module items like the timer), `src/today/*` (quick actions row, generic module sections), `src/tasks/CardDialog.tsx` + `CardPage.tsx` + `CardFace.tsx` (render `cardSlots` registrations), `src/editor/slash.ts` + `src/editor/extensions.ts` (generic embed node + registered slash items), `src/notifications/*` (module rows), `src/settings/*` (Settings → Notifications module rows, Settings → Workspace currency/week start, Policies toggles).

**HTTP (foundation):**

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/links?kind=&id=` | — | `{ links: [{ id, relation, direction, other: WorkSummary \| { kind, hidden: true } }] }` |
| POST | `/api/links` | `{ a: WorkRef, b: WorkRef \| { ref: string }, relation }` | `{ link }` (409 `EXISTS`) |
| DELETE | `/api/links/:linkId` | — | 204 |
| GET | `/api/refs/resolve?ref=` | — | `{ summary: WorkSummary }` or 404 |
| GET | `/api/items/:kind/:id/activity?order=&cursor=` | — | `{ entries, nextCursor }` |
| GET/POST | `/api/items/:kind/:id/comments` | `{ body, parentId? }` | comment list / created |
| PATCH/DELETE | `/api/items/:kind/:id/comments/:cid` | `{ body }` | — |
| GET | `/api/people/search?q=&allow=user,group,contact&book=` | — | `{ people: PersonSummary[] }` |
| GET | `/api/datasets` | — | `{ datasets }` (readable modules only) |
| POST | `/api/datasets/query` | structured query | `{ columns, rows, truncated }` |
| GET | `/api/search?scope=all&q=` | — | `{ sections: [{ scope, results, truncated }] }` |
| POST | `/api/undo/:ticket` | — | restores the captured rows |

**MCP (foundation):** `resolve_ref`, `link_items`, `unlink_items`, `list_links`, `search_workspace`, `list_datasets`, `query_dataset`, `get_item_activity`, `comment_on_item`, `list_item_comments`; resources `nook://card/<key>`, `nook://note/<id>`.

**Threats (foundation):** T500 a registry lets a module's route skip the session/CSRF middleware → `mountWorkspaceModules` mounts under the same app after the guards; public routes only via `publicRoutes` under `/p` and `/api/public`, test enumerates. T501 links leak titles across access → resolver null-redaction, test per kind. T502 dataset query bypasses access → compiled SQL always ANDs `scope(viewer)`, structured input only, fuzz test. T503 contact details leak via chips. T504 schedule handler runs twice → `schedule_fires` PK. T505 audit leaks PII. T506 public endpoint abuse/DoS → §B.8 limits. T507 public token guessing/timing → 32-byte tokens, hash lookup, uniform 404. T508 external mail used to spam arbitrary addresses → per-address and per-item caps, only addresses a booker/guest typed for their own booking/vote, verification option. T509 notification `href` injection → hrefs built server-side from kinds, relative paths only. T510 `access_grants_v` rebuild loses grants → migration test compares counts before/after. T511 generic member table allows cross-kind confusion → every query filters `item_kind`, composite PK. T512 undo ticket replay restores data another user deleted later → tickets bound to actor, 10-minute expiry, revision check. T513 embeds reveal titles → neutral text (§B.4.4). T514 CSV formula injection in exports.

**Tests (foundation):** `tests/workspaceRegistry.test.ts` (stubs mount, hidden while not ready, routes behind auth), `tests/workspaceMigrations.test.ts` (085–089 on a copy of a 082 DB with data: grants/proposals/notifications preserved, CHECKs accept new words, view counts equal), `tests/questions*.test.ts` (every type: validate/aggregate; logic; versions; CSV), `tests/workLinks.test.ts`, `tests/itemActivity.test.ts`, `tests/schedules.test.ts` (clock, DST, crash between claim and finish, lateness), `tests/notify.test.ts`, `tests/publicPages.test.ts` (headers, 404 uniformity, limits, honeypot, too-fast, replay, verification), `tests/datasets.test.ts` (access predicate, buckets, limits), `tests/peopleUpsert.test.ts`, `tests/mcpWorkTools.test.ts`, `tests/duration.test.ts`, `tests/money.test.ts`, client `tests/questionEditor.test.tsx`, `tests/questionRenderer.test.tsx`, `tests/kanban.test.tsx`, `tests/workspaceRoutes.test.tsx`, plus `scripts/dragSmoke.ts` case for `<KanbanBoard>`.

#### Decisions as built (W1-CORE, branch `w1-core`)

The foundation APIs are the §F.2 names; the import points are `server/workspaceModules.ts` (registerWorkspaceModule), `server/questions/service.ts`, `server/people/contacts.ts`, `server/links/service.ts`, `server/activity/{service,comments}.ts`, `server/schedules/service.ts`, `server/notify/index.ts`, `server/public/index.ts`, `server/datasets/routes.ts` (re-exports the registry), `server/goalsProgress.ts`, `server/undo.ts`, `server/access/workspaceItems.ts`, `server/mcpRegistry.ts`, `server/mcpToolKit.ts`. Differences from the plan text, and choices it left open:

| # | Decision |
| --- | --- |
| D815 | **Routes added after start.** Hono builds its matcher on the first request, so module routes and public routes are served by two small dispatchers (`server/dynamicRoutes.ts`): one mounted after every session, CSRF, two-factor, and role-write guard (module routes), one before them behind the strict public headers (`/p/*`, `/api/public/*`). The routers only accept `/api/…` (not `/api/public/…`) and `/p/…` / `/api/public/…` respectively (T500). `WorkspaceModuleDef.routes(router)` gets `get/post/put/patch/delete` instead of the Hono app. |
| D816 | **Townhall is the seventh module**: id `townhall`, scopes `townhall:read/write`, container and resource kind `townhall_session`, contents `townhall_question`, Bin type, proposal kind `townhall_question`, question host `townhall_session`, public link kind `townhall_session`, migration file `server/migrations/workspace/townhall.ts` (115–117). |
| D817 | **Guests hold no keys** (O6 kept: `mcpScopesForRole("guest")` stays empty). Guests answering forms, standups, and townhalls is a module's `readOnlyWrites` entry (`registerReadOnlyWrite`, server/team/writeGate.ts); the handler still checks who may answer. Viewers get the seven read scopes. |
| D818 | **Contacts and Standups** (§G.1 Q7): user-facing labels and paths `/contacts/…` (contacts `/contacts/<slug>-<sid>`, companies `/contacts/companies/…`, deals `/contacts/deals/…`) and `/standups/…`; ids stay `crm` and `checkins`. `shared/workspaceModules.ts` `WORKSPACE_MODULE_LABELS` and `shared/workRefs.ts` `WORK_KIND_PATHS` carry them. |
| D819 | **Public pages on by default** (§G.1 Q2) with `team_settings` keys read by `server/workspaceSettings.ts`, a separate `GET/PUT /api/workspace/settings` (admins write; partial body plus revision CAS) so the Policies PUT schema is unchanged. Per-person units (week start, duration format, bare numbers) are `GET/PUT /api/preferences/units` in `user_ui_prefs` (089), because `user_preferences.disabled_modules` is an array. |
| D820 | **Cross-module MCP tools** are offered to keys holding a workspace module scope (any one), so keys of the older modules keep exactly their tool lists; every call still checks the named item's own module scope and the key's chosen items (`tasks:read` for a card). Search and datasets are `global` (hidden from chosen-item keys). |
| D821 | **Module email categories** are on by default and optional in `PUT /api/mail/settings` (a missing one keeps its stored value), so the current Settings page keeps saving. |
| D822 | **Outside mail** rows keep the item in a unique `coalesce_key` (`x:<kind>:<id>:<n>`) for the per-item cap after the payload is cleared; "Stop emails about this" links are signed tokens of an address hash and an item keyed hash (no cipher, no id), recorded in `external_mail_stops`. The dispatcher sends registered templates to users and to outside addresses. |
| D822a | **Verification codes have their own per-item cap** (audit fix): `public.verification` mail counts under `x:v_<kind>:<item>:` with a cap of what the item's public links accept in a day (`LINK_SUBMISSIONS_PER_HOUR` × 24 = 7,200), not the item's shared 30-a-day outside cap, so strangers asking for codes can neither stop other people's codes nor use up the item's other outside mail (exhaustion DoS). The per-address caps (10 an hour, 50 a day) still bound mail to any one address; `enqueueExternalMail` takes an optional `cap: { ref, perDay }`. |
| D822b | **"Stop emails about this" is a POST** (audit fix): opening a link never changes anything, since mail scanners open every link. The footer links to the public page `/p/mail-stop/<token>` (public shell, `src/public/MailStopPage.tsx`) whose "Stop emails" button POSTs `/api/public/mail-stop/<token>`; outside mail carries RFC 8058 `List-Unsubscribe: <…/api/public/mail-stop/<token>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` for one-click. The POST answers 200 with an empty body for any token (no oracle) and is page-limited per address; the old `GET /api/public/mail-stop/<token>` in mail already sent redirects (303) to the page. |
| D823 | **Undo tickets** live in memory (10 minutes, bound to the deleter, single use) and restore by re-insert, or by update for soft deletes (a comment with replies); a primary-key or foreign-key clash is 409 `UNDO_CONFLICT`. |
| D824 | **Link activity** names the other side by its kind word ("Goal", "Note"), never its title; cards record `goal_linked`/`goal_unlinked` or `relation_added`/`relation_removed`, workspace kinds `linked`/`unlinked`; the older modules' other kinds record nothing. |
| D825 | **Friendly URLs reused** (§G.1): new tables take `shared/friendlyUrls.ts` short ids (10 characters; 088 fills them by default with 083's expression); no `shared/shortIds.ts`. `GET /api/links/:kind/:ref` (D775) is unchanged; workspace kinds resolve through their work kind adapter (`lookup`) and `GET /api/refs/resolve`. |
| D826 | **Datasets** bucket in the asked zone by its offset at query time (a DST change inside the range can shift one bucket edge by an hour); filters, names, and functions come from the dataset's tables, values are bound. Tasks datasets are open to guests (the board predicate decides). |
| D827 | **notify()** writes rows inside the caller's transaction and wakes devices after it (microtask, payload-less push as every Nook push); module rows join the bell list with `module`, `topic`, `body`, `item`, `actor`. |
| D828 | **Schedule handlers** run once per occurrence, synchronously inside their own transaction (an async handler opens its own); a failure is recorded on the fire row and the occurrence is not retried. Missed occurrences after downtime run once, then the schedule moves on from now. |
| D829 | **089 drafts are dev-only**: databases that applied an earlier draft of 089 during Wave 1 (before `public_nonces` and the hashed `external_mail_stops`) are repaired by `DELETE FROM schema_migrations WHERE id = 89; DROP TABLE IF EXISTS external_mail_stops;` and a restart; nothing released ever had 085–089. |

**Decisions as built (W1-UI, D830–D839):**

- **D830** Shared UI lives in `src/ui/` (one implementation each): `EmptyState`, `MoreMenu`, `ModuleHome`, `moduleKeys` (`useModuleShortcuts`), `progress/Progress` (`ProgressBar`, `ProgressRing`, `HealthChip`, `GoalHealthChip`), `time/Duration` (`DurationInput`, `DurationChip`, `TimerChip`), `money/Money` (`MoneyInput`, `MoneyText`), `schedule/SchedulePicker`, `people/People` (`PersonChip`, `PersonPicker`, `CompanyChip`), `links/WorkLinks` (`WorkRefChip`, `LinkedItemsPanel`, `LinkPicker`), `activity/ItemTimeline`, `kanban/KanbanBoard`, `insights/Insights` (`KpiTile`, `KpiRow`, `InsightChart`), `embeds/EmbedCard`, `questions/*`, `live/*`, `units.ts` (`useUnitPreferences`, `useWorkspaceSettings`), `workspaceApi.ts` (the foundation endpoints). New classes only (`ui-*`, workspace.css, questions.css, live.css), so existing screens are unchanged (buttonMetrics diff empty but the instance's origin).
- **D831** Public pages: `src/main.tsx` sends `/p/*` to the lazy `src/public/PublicApp.tsx` (no session code); modules register pages with `publicPages: [{ prefix, component }]`; unmatched paths are the one `PublicNotFound`. `PublicPageShell` (width `form` 640 / `booking` 880, workspace name/logo, "Powered by"); dark follows `prefers-color-scheme`. **Deviation:** `#b8860b` is 3.25:1 on white, so it is used for borders, focus, and fills only; text and filled buttons use `#8a6408` (5.4:1). `src/public/publicTheme.ts` holds the tokens; tests check every pair. A module accent (`#rrggbb`) is used only when it keeps 4.5:1 (text) / 3:1 (decoration).
- **D832** `src/workspaceModules/` (`types.ts`, `registry.ts`, `index.ts`, `WorkspaceModuleHost.tsx`): `WorkspaceClientModule` as §B.1, plus `segment` (the URL's first segment: `contacts` for `crm`, `standups` for `checkins`, from `WORKSPACE_MODULE_LABELS`), `cardSections`/`cardFaceBadges`/`cardHeaderActions`/`timelineDecorations`, `slashItems`, `notificationTopics`, `shortcuts`, `publicPages`. Ids and labels come from `shared/workspaceModules.ts`. Seven stubs (`townhall` included), `ready: false`; `src/modules.ts` spreads them (`planned: !ready`, `routeApps: [id]`, launcher at `/<segment>`); guests never get Time, Contacts, or Bookings in Settings.
- **D833** One route shape `{ app: <moduleId>, path: string[], search: string, pending? }` (router.ts); only a ready module's segment parses (anything else is Home). `formatRoute` uses the module's `formatRoute` or `/<segment>/<path>`; `locationUrl` keeps a module URL's query. `friendlyWorkspaceItem(kind, segment, url)` resolves friendly segments with `routeNames`/`FriendlyLinkGate` (D773). App.tsx has one branch, `WorkspaceModuleHost` (gate + Suspense + the module's lazy app with `route`, `navigate`, `onOpenPath`, account props); `AppSection` gains the ids; `TopBarItems` renders module header items in the account row.
- **D834** `src/ui/cardSlots.ts` (`registerCardSection` side/main with `order`, `registerCardFaceBadge`, `registerCardHeaderAction`, `registerTimelineDecoration`), rendered by `src/ui/CardSlotOutlets.tsx` in CardDialog (side under Relations, main above Comments, header before Move), CardFace (footer, only when a badge exists), and BoardTimeline bars; hidden while the module is off; a throwing slot is dropped.
- **D835** `src/editor/moduleEmbedRegistry.ts` (`registerEmbedKind({ kind: EmbedKind, match?, component })`, `registerSlashItem`) and the `ModuleEmbed` node (`src/editor/moduleEmbed.tsx`, in `noteContentExtensions`): a `[<word>](<path> "nook-embed")` line becomes a card only when a registered kind claims it (by the shared neutral word, or by path when the text is a title); the Markdown always writes the neutral word (T513). Slash items follow the built-in ones (menu cap 24).
- **D836** Today: `registerTodayRenderer(name, def)` (module `todaySections`, with an optional `render` component) and a Quick actions row (`QuickActions`, by role and module state) that renders nothing until a module registers one. Settings → Workspace (`src/settings/WorkspaceSettings.tsx`): each person's units (week start, duration format, bare numbers; `/api/preferences/units`) and, for admins, currency and the public forms / booking pages policies (`/api/workspace/settings`); listed in the hub once a module ships. Settings → Notifications → Email gains one row per shipped module (its category).
- **D837** `ModuleHome`: header (Home, module name, account row), title row (icon, h1, one primary action bound to `n`, ⋯), tab strip (`aria-current`, `centerActiveTab`), filter row (chips + search bound to `/`), content, and an optional detail pane at ≥ 1280. At 375 px: title row, tabs, filters, then the search on its own line; nothing hidden.
- **D838** Units: durations, money, and schedules read `shared/duration.ts`, `shared/money.ts`, `shared/schedules.ts` (`nextFires` previews in the viewer's zone). Tones are `shared/tones.ts` (`success`, `warning`, `danger`, `info`, `neutral`, `accent`), mapped to `--tone-*` in workspace.css, always with an icon and words.
- **D839** Questions (`QuestionSetEditor`, `QuestionRenderer` page/stepper and app/public, `ResponseViewer`, `QuestionSummary`, `ResultBars`), Townhall widgets (`LivePoll`, `WordCloud`, `RatingWidget` with `presenter` sizes, `QaList` with moderation, `PresenterView`), `KanbanBoard` (pointer drag after 6 px, Alt+arrows, phone stage strip), `ItemTimeline` (comments + activity, D746 controls). A component gallery (`/__gallery`, `?c=<name>`) exists only in builds made with `VITE_UI_GALLERY=1`.

### D.1 Forms & Polls (lane FORMS, module `forms`)

**Decisions D840–D869**, threats **T515–T529**, migrations **090–092**.

Key decisions:
- **D840** One module, three kinds (`form`, `poll`, `time_poll`), one table; a poll is a form with exactly one choice question and poll-specific display.
- **D841** Editing a published form saves a draft set; **Publish changes** creates a new version; responses pin their version (§B.2).
- **D842** Audience (who answers) is separate from access (who sees results/edits) (§B.9).
- **D843** Anonymous forms store no respondent identity at all (no user id, no email, no IP hash beyond the 30-day abuse log); one-per-person on an anonymous form uses a keyed HMAC of the user id that cannot be reversed to the user from the stored row (T518 discusses the residual risk: the server holds the key).
- **D844** Poll results visibility: `live`, `after_vote`, `after_close`, `owner_only`; named votes show voter chips only to those who can see results.
- **D845** Response actions run inside the submission's transaction where local (card, contact), and are retried by a schedule if they fail (action log row with status), never blocking the respondent.
- **D846** Time polls store slots in UTC and render in each viewer's zone; finalizing is owner/editor only.

**Tables:**

```
090 forms
forms(id, short_id, owner_id, kind CHECK IN ('form','poll','time_poll'), title ≤ 200, description_md ≤ 20000,
  status CHECK IN ('draft','open','closed'), audience CHECK IN ('workspace','selected','public'),
  audience_json ≤ 8192 (user/group ids for 'selected'), anonymous 0/1, limit_per CHECK IN ('none','person','browser'),
  allow_edit 0/1, results_visibility CHECK IN ('owner_only','live','after_vote','after_close'),
  display CHECK IN ('page','stepper'), opens_at NULL, closes_at NULL, max_responses NULL CHECK 1..100000,
  verify_email 0/1, theme_json ≤ 2048 (accent from the §E palette, cover document id),
  ending_json ≤ 8192, settings_json ≤ 8192 (notify on response, show progress bar, confirmation copy),
  calendar_id NULL (time_poll target), finalized_slot_id NULL, finalized_event_id NULL,
  response_count INTEGER NOT NULL DEFAULT 0, last_response_at NULL,
  visibility, share_role, BIN, revision, created_at, updated_at, closed_at NULL)
  idx (owner_id, deleted_at), (status, closes_at)
form_actions(id, form_id → forms CASCADE, kind CHECK IN ('create_card','save_contact','create_deal','notify'),
  config_json ≤ 16384, enabled, position, created_by, created_at, updated_at)
form_action_runs(id, action_id → form_actions CASCADE, response_id → responses CASCADE, status CHECK IN ('done','failed','pending'),
  result_ref ≤ 120 NULL, error ≤ 500 NULL, attempts, created_at, updated_at)  idx (status) WHERE status <> 'done'
form_visits(form_id, day, views, starts, submits, PRIMARY KEY(form_id, day))   -- completion funnel, no PII
091 forms_fts  forms_fts(title, body) + triggers; purge triggers (work_links, item_members, item_group_grants, public_links, schedules, question_sets, responses for host_kind='form')
092 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/forms?kind=&status=&owner=me&cursor=` | list readable (results level) + forms you can answer (`canRespond`) |
| POST | `/api/forms` | `{ kind, title, questions?, template? }` → form with draft set |
| GET/PATCH | `/api/forms/:id` | settings; PATCH `{ title?, status?, audience?, … , expectedRevision }` |
| GET/PUT | `/api/forms/:id/draft` | the draft question set |
| POST | `/api/forms/:id/publish` | draft → new version (validates logic) |
| POST | `/api/forms/:id/duplicate` | |
| GET | `/api/forms/:id/respond` | for respondents: current published set + your existing response |
| POST | `/api/forms/:id/responses` | submit (members); PUT `/responses/:rid` to edit when allowed |
| GET | `/api/forms/:id/responses?filter=&cursor=` | result readers |
| GET/DELETE | `/api/forms/:id/responses/:rid` | DELETE → undo ticket |
| GET | `/api/forms/:id/summary?filter=` | per-question aggregates, funnel |
| GET | `/api/forms/:id/export.csv` | |
| GET/POST/PATCH/DELETE | `/api/forms/:id/actions[/:aid]` | response actions |
| POST | `/api/forms/:id/finalize` | time poll: `{ slotId, calendarId, inviteUserIds, emailGuests }` → event |
| POST/DELETE | `/api/forms/:id/public-link` | create/rotate/revoke (policy `public_forms`) |
| GET | `/api/public/forms/:token` | public definition (no internal ids beyond question/option ids) + render nonce |
| POST | `/api/public/forms/:token/responses` | public submit (§B.8 checks) |
| POST | `/api/public/forms/:token/verify` | email code |
| GET | `/api/public/forms/:token/results` | poll/time-poll results when visibility allows |

**MCP** (`forms:read` / `forms:write`): `list_forms`, `get_form` (with questions), `create_form` (`{ kind, title, questions: Question[] }`, validated), `update_form` (settings), `update_form_questions` (replace draft; `publish: true` to publish), `set_form_status`, `list_responses`, `get_response`, `get_form_summary`, `export_responses` (CSV text ≤ 1 MiB), `submit_response` (as the key owner; members-audience forms only), `create_poll` (`{ question, options, multiple?, anonymous?, closesAt?, embedIn?: WorkRef }`), `vote_poll`, `create_time_poll` (`{ title, slots, participants }`), `finalize_time_poll`, `delete_form` (Bin; + `bin:write`). Agents: reads + `create_poll`, `vote_poll`, `submit_response` allowed; `create_form` as proposal `form_create`; never public links.

**UI:**
- **Forms home** (`/forms`): ModuleHome (§E.2) with tabs **My forms**, **Shared with me**, **To answer**; list rows: kind icon, title, status chip, responses count + sparkline, last response, owner chip; New ▾ (Form, Poll, Find a time, From template: Feedback, Event registration, Intake request, NPS, Job application, Quick poll).
- **Form editor** (`/forms/<slug>-<sid>/edit`): left `<QuestionSetEditor>`, right live preview (desktop ≥ 1280); top bar: title, status, **Preview**, **Share** (sheet: audience, public link with QR via `qrcode`, embed snippet for notes), **Publish changes** when the draft differs; Settings sheet (limits, closing, results visibility, display mode, theme, ending, verification); **Actions** tab.
- **Results** (`/forms/<slug>-<sid>/results`): Summary (per-question `<QuestionSummary>`, funnel views→starts→submits, filter bar "where Q is A"), Responses (table with column picker; open one in `<ResponseViewer>`; comments per response via ItemTimeline), Export.
- **Respond** (`/forms/<slug>-<sid>`): in-app renderer, same look as public but dark.
- **Poll**: compact card (question, options with bars, vote button, "N votes · closes in 2h"); embeds render the same card.
- **Time poll**: grid (slots as columns grouped by day, participants as rows; yes ✓ / maybe (✓) / no; best slot highlighted); mobile: list of slots with three-state toggles; finalize sheet.
- **Public page** `/p/f/<token>`: PublicPageShell; stepper or page mode; progress bar; validation inline; ending screen; poll results if allowed.
- Mobile 375: editor becomes single column with a bottom "+ Add question" bar; question settings open as a sheet.

**Notifications:** owner/followers on new responses (coalesced 15 min: "5 new responses to *Onboarding survey*"), poll closed (voters), time poll finalized (participants + guests by email), form closing in 24 h (owner).

**Schedules:** `forms.open` (opens_at), `forms.close` (closes_at), `forms.actions_retry`.

**Reports datasets:** `forms.responses` (form, kind, submitted_at, respondent kind, score), `forms.answers` (form, question, option, value_num, value_text truncated, submitted_at).

**Search:** forms (title, description, question titles); responses are not indexed globally (results readers search inside a form, T519).

**Bin:** `form` (with its responses, sets, actions); purge cascades.

**Audit:** `forms.create`, `forms.update`, `forms.publish`, `forms.status`, `forms.public_link`, `forms.response_submit` (no answers), `forms.response_delete`, `forms.export`, `forms.action_run`, `forms.finalize`.

**Threats:** T515 public submissions spam → §B.8. T516 public file upload abuse → members-only `file` type. T517 response data exposure to people with edit but not results access → results need `view` level on the form (respondents never get it unless `results_visibility` grants aggregate-only views; aggregates exclude text answers). T518 anonymous deanonymization by timing/small n → no timestamps finer than the day on anonymous responses shown to readers, aggregates only below 3 responses for anonymous text answers. T519 search leak of answers. T520 action templates inject Markdown/links into cards → answers are escaped in templates; links are autolinked only for `url` answers. T521 time-poll guest emails used for spam → only participants' own emails, capped (§B.7). T522 poll vote stuffing by members via MCP → one vote per user, MCP rate limits. T523 hidden fields used to impersonate (e.g. `email=ceo@`) → hidden values are labelled as unverified and never used for upsert unless `verify_email`.

**Acceptance (browser):** create a form with 8 types incl. logic and a section jump; publish; answer as another member on a phone at 375 px; change a question and publish v2; old response still renders; summary charts correct; filter; CSV opens in a spreadsheet with no formula execution; public link (policy on) submits from a private window; honeypot and too-fast are refused; action creates a card on a board with mapped fields and a contact in a book; poll created from `/poll` in a note, voted inline by two users, results hidden until vote; time poll with 6 slots across two zones, finalize → event appears in the calendar with reminders.
**Acceptance (MCP):** `create_form` with questions → `get_form` → `submit_response` (second key) → `get_form_summary`; `create_poll` with `embedIn: note` → note shows embed; `finalize_time_poll`; chosen-item key limited to one form cannot list others (NOT_FOUND).
**Tests:** `tests/forms*.test.ts` (service, routes, public, actions, time poll, MCP, bin/purge orphans), `tests/formsClient.test.tsx` (editor, renderer, results, poll card, time-poll grid).

#### Decisions as built (lane FORMS, branch `lane-forms`)

Server in `server/forms/` (service, actions, notifications, finalize, public, routes, mcp, registry, index), client in `src/forms/`, shared words in `shared/forms.ts` and `shared/formsActivity.ts`, migrations 090 (`forms`, `form_actions`, `form_action_runs`, `form_visits`, purge trigger) and 091 (`forms_fts`); 092 unused. Differences from the plan text, and choices it left open:

| # | Decision |
| --- | --- |
| D847 | **Drafts are invisible to their audience.** A form in `draft` is reachable only by its readers (owner, shared people); the audience (`workspace`, `selected`, `public`) sees it once published. Polls and time polls are created published and open; forms open on first **Publish**. |
| D848 | **Who answers vs who reads** (D842 as built): `audience` = `workspace` (members and admins, not guests) \| `selected` (`audience_json` users and groups) \| `public` (workspace plus anyone with the public link); anyone with a level on the form may also answer. Results need `view` via the generic `/api/access/form/:id`. Changing who answers is owner/manager only; leaving `public` revokes the link; making a link sets `public`. Your own forms never appear in "To answer". |
| D849 | **One per person** is enforced in the service: named responses by `respondent_user_id`, anonymous ones by the keyed `dedupe_hash` (D843), public ones by a keyed hash of a random per-browser id (`limit_per = browser`, best effort). A named poll or time poll **replaces** the earlier vote (and `DELETE /vote` removes it); an anonymous one keeps the first; a form replaces only with "People can edit their response" and the response id. |
| D850 | **Anonymous forms** keep no identity, show the day only to readers, CSV, and datasets, hide text summaries below 3 responses (T518), record no per-response activity, cannot turn anonymity off once responses exist, and cannot allow editing. |
| D851 | **Closing** (`closes_at`) and the owner's 24-hour notice are schedules (`forms.close`, `forms.closing`); `opens_at` is checked at answer time (no schedule needed); reaching `max_responses` closes the form in the submitting transaction; reopening clears a passed close date or a reached limit. `forms.open` from the plan is not needed. |
| D852 | **Response actions run after commit** (D845): one `form_action_runs` row per action and response, run as the person who set the action up (re-checked against the board or book), retried by `forms.actions_retry` five times, five minutes apart, and by **Retry** in the Actions tab. `create_card` uses Tasks' `createCard` (async board lock, so not inside the response's transaction) and links card → response (`source`); `save_contact` uses `upsertContactByEmail` (source `form`) and links contact → response when the contact kind has an adapter; `create_deal` answers `NOT_AVAILABLE` until CRM deals (W3). |
| D853 | **Card templates**: `{{Question title}}`, `{{questionId}}`, `{{answers}}`; titles plain text, descriptions Markdown with every answer escaped and only http(s) `url` answers autolinked, plus a link back to the response (T520). |
| D854 | **Public pages** (`/p/f/<token>`, `/api/public/forms/<token>`, `…/responses`, `…/verify`, `…/results`, `…/visit`) open while the link is live, the policy allows public forms, and the form is live, `public`, and not a draft. **Deviation:** a *closed* form still opens and says it is closed (and shows results that are public after close) instead of the uniform 404, so "results after close" works for outside voters; unknown, revoked, policy-off, binned, and draft stay the uniform 404. The public definition drops roles and members-only questions. Public guest identity is the typed name (time polls require it) or the `contact_name` answer, email from the email answer; hidden fields are never identity (T523). Email verification validates the answers first, then holds them (`startEmailVerification`). |
| D855 | **Time polls**: one `time_slots` question (UTC, D846), shown in the viewer's zone; the in-app and public grid lists named participants (public: names as typed, never emails); finalizing (editors) creates a timed event in a writable calendar in the organizer's zone, links event → form (`source`), closes the poll, notifies participants and chosen people, and emails outside voters who left an email once (`forms.time_final`, outside-mail caps). Calendar has no attendees, so invitees are notified rather than added (W3 may add attendees); no ICS attachment in v1. |
| D856 | **Notifications**: `forms.response` (owner and edit/manage members; one unread row per form that updates, email `forms.responses` at most every 15 minutes), `forms.vote` (no email), `forms.closed` (named voters), `forms.closing` (owner), `forms.finalized`, `forms.action` (notify action). |
| D857 | **MCP names follow the repo's rule** that no tool name contains `delete` (D265): `bin_form` (+ `bin:write`, Bin buckets), `drop_response`, `bulk_drop_responses` instead of the plan's `delete_*`. Extra tools: `search_forms`, `duplicate_form`. `create_poll` returns `embedMarkdown` and, with `embedIn: { kind: "note" }`, appends it to the owner's note draft (an agent draft, never published). Agents get reads, `submit_response`, `create_poll`, `vote_poll`; everything else is never offered. **Deviation:** `create_form` is not a `form_create` proposal yet (agents never get it). *(Superseded by D1047: `form_create` is registered and `create_form` is offered to agents through it.)* |
| D858 | **Work kinds** `form` and `response` (response level = form level); key-grant anchors resolve a form's short id or URL to its id, and a response to its form. Item activity kinds: `title`, `audience`, `status`, `published`, `public_link`, `finalized`, `submitted` (labels only). Undo kind `response` recounts the form on restore (a Standups lane registering the same undo kind would need to merge the hook). |
| D859 | **Datasets** `forms.responses` and `forms.answers` scope to forms the viewer reads results of; anonymous rows carry the day only. Insights tab: KPIs, responses per week/month, most answered, by kind, share through public links. Goals progress source `form_metric` (responses, average of a numeric question, NPS) computed as the KR owner. |
| D860 | **Client**: the home and every form page use `ModuleHome` (a form page's tabs are Respond/Vote, Edit, Results); the editor is the shared `QuestionSetEditor` with autosave (700 ms) and explicit **Publish changes**, plus the module's Sections and endings panel (the shared editor has no section or ending UI), a live preview in the detail pane at ≥ 1280, and Settings / Sharing / Actions panels instead of sheets. Results use the shared `QuestionSummary`, `ResponseViewer`, `ItemTimeline`, `InsightChart`, `KpiTile`; polls use W1-UI's `LivePoll`. Embeds (`poll`, `time_poll`, `form`) are a lazy chunk; `/poll` creates a poll in a small dialog and `/form` picks one of your forms. |
| D861 | **Deviation (shared UI gap):** the Access sheet (`src/access/AccessSheet.tsx`) does not know workspace kinds, so "Who sees results" in Sharing is a compact editor over `/api/access/form/:id` (audience, level, people and groups) in `src/forms/FormEditor.tsx`; W1-UI should generalize the sheet and Forms should switch to it. |
| D862 | **Shared tests touched (append-only in spirit):** `tests/toolResourcePolicy.test.ts` resets the per-user MCP minute per tool (every module's write tools together passed the 60/min user limit); `tests/workspaceRegistry.test.ts`, `tests/workspaceRoutes.test.tsx`, `tests/workspaceUi.test.tsx` now treat Forms as shipped. |
| D863 | **"Confirm email" needs mail** (audit fix, as bookings do): with mail off no code can be sent, so a public submission is not held; it counts at once without `meta.verified`, the public page asks for no code, and Settings → Responding says why under the toggle (`FormDetail.mailEnabled`). The setting is kept, so it applies again once mail is set up. |
| D864 | **Hidden fields never identify a public respondent** (audit fix, T523 as built): response actions (save contact, create deal) use a hidden question's value only for a member's own (non-public) submission; a public submission ignores it, verified or not, and a verified one uses the address that confirmed the code (the response's respondent email) for the contact. The public respondent's name and email are taken from visible questions only. |
| D865 | **Create a deal is made once** (audit fix to D1045): the deal, its `source` link to the response, and `deal:<id>` on the run's `result_ref` commit in one transaction, so a link that fails rolls the deal back and the run fails cleanly instead of leaving an unlinked deal a retry would duplicate. A retry first looks up the deal named on the run, then (runs from before) the source link. |

### D.2 Time tracking (lane TIME, module `time`)

**Decisions D870–D899**, threats **T530–T539**, migrations **093–095**.

Key decisions:
- **D870** One running timer per person (partial unique index); starting a new one stops the old at the same instant.
- **D871** Entries store `started_at` + `duration_s` (+ `ended_at` when stopped); running entries have `ended_at NULL` and duration computed live; max entry 24 h (longer is split by the UI on save).
- **D872** Visibility: your own entries always; a project's entries to its `edit`+ members; an entry linked to a card is visible (description, person, duration) to the card's readers (Jira worklog behavior), unless the project is "private time" (`settings.private_entries`), in which case card readers see totals only.
- **D873** Rates and billable amounts are visible to project `manage` and the entry's author only; others see hours.
- **D874** Approval locks weeks per person per project; locked entries are read-only for the author; managers can unlock (audited).
- **D875** Rounding is applied in reports only, never to stored entries.
- **D876** Client = CRM company (§B.3); project ↔ board link sets the default project for cards on that board.

**Tables:**

```
093 time
time_projects(id, short_id, owner_id, name ≤ 120, code ≤ 12 NULL, color, company_id NULL → companies SET NULL,
  board_id NULL → boards SET NULL, billable_default 0/1, rate_minor NULL ≥ 0, currency CHECK length 3,
  budget_kind CHECK IN ('none','hours','money'), budget_value NULL ≥ 0, budget_period CHECK IN ('total','monthly'),
  settings_json ≤ 4096 (private_entries, require_description, require_link), archived_at NULL,
  visibility, share_role, BIN, revision, created_at, updated_at)  unique (board_id) WHERE board_id IS NOT NULL AND deleted_at IS NULL
time_member_rates(project_id → time_projects CASCADE, user_id → users CASCADE, rate_minor, PRIMARY KEY(project_id,user_id))
time_entries(id, user_id → users CASCADE, project_id NULL → time_projects SET NULL, description ≤ 500,
  started_at NOT NULL, ended_at NULL, duration_s NULL CHECK 0..86400, tz,
  billable 0/1, rate_minor NULL, currency NULL, tags_json ≤ 512,
  target_kind NULL, target_id NULL (primary work ref: card/goal/contact/company/deal/booking/event),
  source CHECK IN ('timer','manual','calendar','import','mcp','proposal'), locked_at NULL, locked_by NULL,
  revision, created_at, updated_at,
  CHECK ((ended_at IS NULL) = (duration_s IS NULL)))
  unique (user_id) WHERE ended_at IS NULL           -- one running timer
  idx (user_id, started_at DESC), (project_id, started_at), (target_kind, target_id, started_at)
time_tags(owner_scope='workspace', name ≤ 40 UNIQUE COLLATE NOCASE, color, created_at)
time_approvals(id, project_id → time_projects CASCADE, user_id, week_start DATE, status CHECK IN ('submitted','approved','rejected'),
  note ≤ 500, decided_by NULL, decided_at NULL, created_at, UNIQUE(project_id,user_id,week_start))
094 time_fts + purge triggers (work_links for time_entry/time_project, item_members, schedules) + card purge trigger clearing target refs
095 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/time/timer` | running entry or null |
| POST | `/api/time/timer/start` | `{ description?, projectId?, target?: WorkRef, billable?, tags? }` → stops previous |
| POST | `/api/time/timer/stop` | `{ at? }` |
| GET | `/api/time/entries?from=&to=&user=me\|id&project=&target=&cursor=` | |
| POST | `/api/time/entries` | `{ startedAt, duration \| endedAt, … }` (duration string accepted) |
| PATCH/DELETE | `/api/time/entries/:id` | DELETE → undo ticket |
| POST | `/api/time/entries/bulk` | `{ op: "create"\|"update"\|"delete", items, dryRun? }` |
| GET | `/api/time/timesheet?week=` | grid rows/cells for the user |
| PUT | `/api/time/timesheet/cell` | `{ week, row: { projectId, target? }, day, duration }` (creates/adjusts one entry per cell) |
| GET | `/api/time/summary?from=&to=&groupBy=project,user,target,tag,day&filters…&rounding=` | |
| GET | `/api/time/export.csv?…` | |
| CRUD | `/api/time/projects[/:id]` | + `/rates`, `/budget` |
| POST | `/api/time/approvals` | submit week; PATCH `/:id` approve/reject; POST `/unlock` |
| GET | `/api/time/targets/:kind/:id` | totals + entries for a card/goal/contact/… (card Time section) |
| GET | `/api/time/suggestions?date=` | calendar events and card activity of the day not yet logged |

**MCP** (`time:read` / `time:write`): `get_running_timer`, `start_timer`, `stop_timer`, `log_time` (`{ duration | start/end, description, project, target (key/URL ok), billable?, tags? }`), `list_time_entries`, `update_time_entry`, `delete_time_entry`, `bulk_log_time` (dryRun), `time_summary` (`groupBy`, range, filters → rows with seconds and amount when allowed), `list_time_projects`, `create_time_project`, `update_time_project`, `get_time_for_item` (card/goal/contact), `suggest_time_entries` (from calendar and activity; read-only). Agents: reads; `log_time` as proposal `time_log` (or direct when allowed); never approvals.

**UI:**
- **Timer chip** in the top bar (AppShell slot, W1-UI): idle "▶ Start timer"; running "● 1:23:45 · MYT-12 Fix login" with stop; click opens a popover (description, project, work item `LinkPicker`, billable, tags, start time edit, recent entries to continue). Keyboard: `⌥T` start/stop globally. Mobile: chip collapses to a dot + time in the header, tap opens a bottom sheet.
- **Time home** (`/time`): tabs **Timer** (today list grouped by day, Toggl-like rows, inline edit, continue ▶, totals per day/week), **Timesheet** (week grid; type `1:30` in cells; row add picker; week totals; submit for approval), **Calendar** (day/week; entries as blocks; calendar events as ghost blocks with "Log"; drag to create/resize; uses `src/ui/calendarGrid`), **Reports** (Insights: summary with group-by chips, bar by day, donut by project, table, rounding, billable toggle, CSV), **Projects** (list with budget progress bars; project page: members & rates, budget, linked board, client, entries).
- **Card dialog Time section** (registered card slot): "▶ Start" button, logged total vs estimate ("3h 20m of 5h", ProgressBar), worklog list (person, date, duration, description), "Log time" inline (`DurationInput`). Card face badge "⏱ 3h 20m" (board setting "Show time on cards").
- **Timeline** (board): logged-vs-estimate fill on bars for hours boards (registered timeline decoration hook in W1-UI's card slots).
- Mobile 375: Timer tab first; timesheet becomes a day-by-day list with a week strip on top ("two rows, nothing hidden").

**Notifications:** timer running > 8 h (author, once), weekly "submit your timesheet" (opt-in per project), approval decided, budget at 80/100% (project managers).
**Schedules:** `time.long_timer` (per running entry), `time.budget_check` (daily), `time.timesheet_reminder` (weekly, opt-in).
**Datasets:** `time.entries` (user, project, client, target kind/id/key, date, seconds, billable, amount_minor (only for allowed viewers; null otherwise), tags).
**Progress source (Goals):** `time` — seconds in the KR period over a project / board's cards / tag / user set, as hours.
**Search:** entry descriptions (own and visible), projects.
**Bin:** `time_project` (entries keep `project_id` until purge, then SET NULL; T533 discussion: purge keeps entries as personal).
**Audit:** `time.entry_create|update|delete`, `time.timer_start|stop`, `time.project_*`, `time.rate_change`, `time.approval_*`, `time.export`.
**Threats:** T530 rate/amount leakage → D873 server-side redaction, dataset column nulled. T531 chosen-item keys and project-less entries → whole-module only. T532 editing others' entries → only `manage` on the entry's project; never across projects. T533 locked-week bypass via MCP/bulk → service-level lock check. T534 timer state race across devices → unique index + transaction; client re-fetches on focus. T535 card readers learning private project time → D872 setting.

**Acceptance (browser):** start the timer from a card (`MYT-12`), reload, switch device (second browser), stop; entry shows on the card and the Timer tab; manual `1h30` entry; timesheet cell edit; calendar "Log this event"; project with client (company) and rate; billable summary by client with 15-min rounding; CSV; budget bar; approval locks the week; hours-estimate board shows logged-vs-estimate on the card and Timeline; 375 px header chip and timesheet day list.
**Acceptance (MCP):** `start_timer` with `target: "MYT-12"` → `get_running_timer` → `stop_timer` → `time_summary groupBy=target`; `bulk_log_time dryRun` then real; agent proposal `time_log` approved in Inbox.
**Tests:** `tests/time*.test.ts` (timer uniqueness and race, duration parse, visibility D872/D873, approvals, summary math with rounding and zones/DST weeks, CSV, MCP, purge), `tests/timeClient.test.tsx` (chip, popover, timesheet keyboard, card section).

#### Decisions as built (TIME, branch `lane-time`)

Code: `server/time/` (`access.ts` visibility and rights, `service.ts` timer and entries, `projects.ts` projects/clients/rates/approvals, `reports.ts` timesheet/summary/CSV/item totals/suggestions, `routes.ts`, `mcpTools.ts`, `registrations.ts`, `index.ts`), `src/time/` (`module.tsx`, `TimeApp.tsx`, tabs, `TimerBar.tsx`, `CardTime.tsx`, `TodayTime.tsx`, `timerStore.ts`, `time.css`), `shared/time.ts`; migrations 093 (tables) and 094 (entry FTS and purge triggers); 095 unused. D870–D876 hold as written. Choices the plan left open, and differences:

| # | Decision |
| --- | --- |
| D877 | **Personal entries.** `project_id` is optional: an entry without a project is the author's own (visible to them, and to card readers through its card). Guests must name a project they are a member of (`PROJECT_REQUIRED`). Archived projects take no new time (`PROJECT_ARCHIVED`). |
| D878 | **The tracked item is a column**, `target_kind`/`target_id` (card, goal, key result, contact, company, deal, booking, event; resolved through the work kind adapters, keys and URLs accepted), not a `work_links` row: a card's Linked panel stays about relations, and the card's history gets `time_logged` (the entry and its duration) when time is logged, stopped, or re-timed on it. A purged card clears the target (094 trigger). |
| D879 | **Timer edges.** A timer may start up to 24 h in the past; stopping one past 24 h splits it into consecutive entries of at most 24 h (no time is lost, D871's cap holds). Manual entries over 24 h are refused (`TOO_LONG`). Clients re-read the timer on focus, visibility, and a BroadcastChannel message (T534). |
| D880 | **Timesheet cells** set a total: the cell's own entry (source `timesheet`, started 09:00 local) absorbs the difference; lowering below what timer or manual entries hold is refused (`CELL_HAS_DETAILS`, "change them in the Timer list"); clearing a cell deletes all its entries with one undo ticket. `carry=1` keeps last week's rows with zeros ("Copy last week"). |
| D881 | **Summaries** are computed from the visible entries (at most 50,000 per request, `TOO_LARGE` beyond), up to two group levels; rounding (6/15/30, nearest or up) applies **per entry** at report time and amounts are computed on the rounded time; an entry counts under each of its tags. |
| D882 | **Money**: rates are copied onto billable entries when written (the person's rate on the project, else the project's), so later rate changes never reprice history; amounts in more than one currency are left out of totals (`mixedCurrency`), never converted. A project's currency is the workspace currency when it is made, editable per project (§G.1 Q6). |
| D883 | **Clients** are companies (088): any company in a book the person can read, or a new one in their own hidden Clients book (D807). The client's name is part of the project for every project reader (joined, not through the book), never the book or its contacts (T538). |
| D884 | **Budgets** (hours or money, total or monthly) are checked on every write instead of a daily `time.budget_check` schedule: crossing 80% and 100% notifies the project's managers once per period (dedupe key per project, period, and threshold). |
| D885 | **Reminders** (`time_user_settings`): "no time logged today" on chosen weekdays at a chosen time in the person's zone (`time.daily_reminder`, owner `time_user`), off by default; the long-timer alert after N hours (default 8, 0 off) is one `time.long_timer` schedule per running entry, cancelled on stop. Both are bell and push notifications (no email template). The weekly "submit your timesheet" reminder is not built. |
| D886 | **MCP names**: `discard_time_entry` instead of `delete_time_entry`, because no tool name may say "delete" (D265, `tests/toolResourcePolicy.test.ts`); it is annotated destructive. Chat agents get the reads and `log_time` (as the `time_log` proposal unless their mode allows writes); timers, edits, removal, bulk, and projects are never offered to agents. `start_timer`/`log_time` need `projectId` from a key limited to chosen projects (T531). |
| D887 | **Guests** write through Time's own `readOnlyWrites` (timer, entries, split, timesheet cell, week submit, reminders); the service allows them only on projects where they hold any level (guests are capped at view), §G.1 Q8. Project create and edit are members' and admins'. |
| D888 | **Card slots**: the Time section (side area; logged against the estimate on hours boards, Start/Stop, inline Log time to the board's linked project, the worklog), a ▶/■ header action, a face badge once time is logged (no board setting: a card without time shows nothing), and a Timeline band along the bar's bottom edge for logged/estimate on hours boards. Faces and bars batch their ids into one `GET /api/time/cards` per frame. |
| D889 | **Phones**: the header's running chip is the dot and `H:MM` in one 44–50 px button that opens the timer sheet (which has Stop), so the account row stays one line at 375 px; the timesheet is a day strip and a list of rows for the chosen day; sheets render full screen. The timer sheet is portaled to the body (the sticky header's backdrop filter would contain a fixed sheet). |
| D890 | **No calendar view in v1**: the Timer tab's "From your day" lists the day's events on your own calendars and the cards you changed that day that have no time yet; "Log" logs an event in one click with its time and title (C13), and a card opens the log sheet prefilled. Drag-to-create blocks are not built. |
| D891 | **Project sharing** is the project page's Team panel over the generic `/api/access/time_project/:id` (audience, people and levels, rates for managers), since the Access sheet does not list the workspace kinds yet. |
| D892 | **Work kinds** `time_project` (href `/time/projects/<slug>-<shortid>`) and `time_entry` (href `/time?entry=<id>`, which opens the entry); search scope `time` (entry descriptions by FTS, projects by name). |
| D893 | **Foundation tests** `tests/workspaceRoutes.test.tsx` and `tests/workspaceRegistry.test.ts` now set aside modules whose lanes shipped (ready) instead of expecting all seven to be stubs, and `tests/todayLayout.test.tsx` checks the built-in sections only; other lanes' merges need the same generic rule, not per-module edits. **Foundation fix:** `registerTodayRenderer` (src/today/todaySections.ts) appended a module's section at the end of the order, against its own comment and the group order; it now inserts after the last section of its group. |
| D894 | **The card face badge registers when the header chip first mounts** (the signed-in shell), not at import: the face renders a footer line as soon as any badge is registered, so cards rendered outside the shell (tests, embeds) stay exactly as before. The other card slots register at import as usual. |

### D.3 Goals / OKRs (lane GOALS, module `goals`)

**Decisions D900–D929**, threats **T540–T549**, migrations **096–098**.

Key decisions:
- **D900** Goal → key results; goals nest via `parent_id` (alignment), no access inheritance (each goal has its own access, as D15 for folders); the roll-up is computed once server-side over all children (true progress, the same number for every viewer); a child the viewer cannot open appears as "A goal you can't open" with its progress only (T541 accepts that progress leak; open question Q4).
- **D901** Progress 0–1 per KR: `(current − start) / (target − start)` clamped (decrease KRs invert; `stay_above/below` are 1 when within bound else 0; boolean 0/1; milestones = done/total). Goal progress = weighted mean of KRs, or of children when it has no KRs.
- **D902** Health is set by the owner at check-in (`on_track`, `at_risk`, `off_track`); a suggested health is computed from progress vs elapsed time (shown, not stored).
- **D903** Auto sources recompute on change events (debounced 60 s per KR, via a schedule `goals.recompute`) and hourly; each recompute that changes the value writes a `kr_values` point (at most one per KR per hour; daily compaction keeps the last per day after 30 days).
- **D904** Periods are workspace-wide (admins and members create); goals may also have custom dates.
- **D905** Closing a goal snapshots final progress and state (`achieved`, `missed`, `dropped`, `carried_over` → a copy in the next period linked by `source`).
- **D906** Progress sources are a registry (`registerProgressSource(kind, { label, configSchema, compute(config, period, viewerless) })`); compute runs as the KR owner's access (T540): sources only count items the KR owner can read.

**Tables:**

```
096 goals
goal_periods(id, name ≤ 60, starts_on DATE, ends_on DATE, created_by, created_at, archived_at NULL, CHECK (ends_on > starts_on))
goals(id, short_id, owner_id, parent_id NULL → goals SET NULL, period_id NULL → goal_periods SET NULL,
  title ≤ 200, description_md ≤ 20000, kind CHECK IN ('objective','kpi'), group_id NULL → user_groups SET NULL (team),
  start_on NULL, due_on NULL, state CHECK IN ('draft','active','achieved','missed','dropped','carried_over'),
  health CHECK IN ('none','on_track','at_risk','off_track') DEFAULT 'none', progress REAL CHECK 0..1,
  progress_mode CHECK IN ('key_results','children','manual'), checkin_cadence CHECK IN ('none','weekly','biweekly','monthly'),
  last_checkin_at NULL, closed_at NULL, final_progress NULL, position REAL, color,
  visibility DEFAULT 'all_users', share_role DEFAULT 'viewer', BIN, revision, created_at, updated_at)
  idx (period_id, parent_id), (owner_id), (group_id)
key_results(id, goal_id → goals CASCADE, title ≤ 200, owner_id NULL, metric CHECK IN ('number','percent','currency','boolean','milestones'),
  direction CHECK IN ('increase','decrease','stay_above','stay_below'), start_value REAL, target_value REAL, current_value REAL,
  unit ≤ 16, currency NULL, weight REAL DEFAULT 1 CHECK > 0, source_kind ≤ 32 DEFAULT 'manual', source_json ≤ 8192,
  source_error ≤ 300 NULL, auto_updated_at NULL, progress REAL, position REAL, revision, created_at, updated_at)
kr_milestones(id, kr_id → key_results CASCADE, title ≤ 200, done_at NULL, position)
kr_values(kr_id → key_results CASCADE, at, value REAL, progress REAL, source CHECK IN ('checkin','auto','edit'), PRIMARY KEY(kr_id, at))
goal_checkins(id, goal_id → goals CASCADE, author_id, health, confidence INTEGER NULL CHECK 1..10, note_md ≤ 10000,
  values_json ≤ 8192 ({krId: value}), via, created_at)  idx (goal_id, created_at DESC)
097 goals_fts + purge triggers (work_links, item_members, item_group_grants, item_activity, item_comments, schedules)
098 (spare)
```

**Progress sources** (v1): `manual`; `tasks` (`{ scope: board | view | tag | epic | sprint, id, measure: "cards" | "points" | "hours_estimate", doneMeans: "done_columns" }`); `goal_children`; registered by other lanes in their own folders: `time` (TIME), `crm_won_value`, `crm_won_count`, `crm_pipeline_value` (CRM), `form_responses`, `form_average`, `form_nps` (FORMS), `checkin_average`, `checkin_participation` (CHECKINS).

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/goals?period=&owner=&group=&parent=&state=&view=tree\|list&cursor=` | |
| POST | `/api/goals` | `{ title, parentId?, periodId?, keyResults? }` |
| GET/PATCH/DELETE | `/api/goals/:id` | |
| POST | `/api/goals/:id/key-results`; PATCH/DELETE `/api/key-results/:id` | KR CRUD, `source` config validated by its source |
| POST | `/api/key-results/:id/preview-source` | compute without saving (editor preview) |
| POST | `/api/goals/:id/checkins` | `{ health, confidence?, note?, values: {krId: value} }` |
| GET | `/api/goals/:id/checkins?cursor=` · `/api/key-results/:id/values?from=&to=` | history chart |
| POST | `/api/goals/:id/close` | `{ state, carryOver?: { periodId } }` |
| CRUD | `/api/goal-periods` | |
| GET | `/api/goals/:id/work` | linked work with status (resolver) |

**MCP** (`goals:read` / `goals:write`): `list_goals` (filters, tree flag), `get_goal` (KRs, children summary, linked work, last check-in), `create_goal`, `update_goal`, `add_key_result`, `update_key_result` (incl. source), `delete_key_result`, `check_in_goal` (`{ goal, health, confidence?, note?, values }`), `list_goal_checkins`, `close_goal`, `list_goal_periods`, `create_goal_period`, `delete_goal` (Bin). Linking work via `link_items` (relation `contributes`). Agents: reads; `check_in_goal` as proposal `goal_checkin`; prompt `weekly_goal_review`.

**UI:**
- **Goals home** (`/goals`): period switcher (current period default), view switch **Tree** | **List** | **Timeline** | **Mine**, filters (owner, team, health, state). Rows: health dot, title, owner chip, team chip, `ProgressBar` with %, KR count, last check-in age ("3 days ago", red when overdue). Tree: indented with expand/collapse, roll-up shown.
- **Goal page** (`/goals/<slug>-<sid>`): header (title, health chip, period/dates, owner, team, ProgressRing), KRs list (each: title, `start → current → target` with unit, progress bar, source badge "Auto · Tasks: Roadmap done cards", edit inline for manual), **Check in** button (sheet: per-KR value inputs prefilled, health segmented control, confidence slider, note), **Progress** chart (line of kr_values and goal progress vs ideal line), **Work** (linked cards/boards/deals/forms with status; "Link work" picker), **Children**, **Timeline** (ItemTimeline: check-ins, changes, comments).
- **Card dialog** "Goal" field (W3 slot) and board header goal chip.
- Mobile 375: list view default; KR rows stack value over bar; check-in sheet full-screen.

**Notifications:** check-in due (owner, by cadence), goal health changed to at risk/off track (followers: members with comment+ and parent owner), KR auto-source failing (owner), period ending in 7 days (owners of open goals).
**Schedules:** `goals.checkin_reminder` (per goal cadence), `goals.recompute` (debounced per KR, plus hourly sweep), `goals.period_end`.
**Datasets:** `goals.key_results` (goal, period, owner, team, progress, current, target, health), `goals.kr_values` (time series), `goals.checkins` (goal, author, health, confidence, at).
**Search:** goals and KR titles.
**Bin:** `goal` (with KRs, check-ins); children are detached (parent SET NULL) only on purge.
**Audit:** `goals.create|update|delete|close`, `goals.kr_*`, `goals.checkin`, `goals.period_*`.
**Threats:** T540 auto source counts items the viewer can't read → sources run as the KR owner and expose only a number and the source's description; source config naming a board the owner can't read is refused. T541 roll-up leaks hidden child progress (accepted, Q4). T542 check-in spoofing via MCP for goals you can't edit → edit level required. T543 recompute DoS (huge boards) → bounded COUNT queries with indexes, debounce, 2 s budget per KR, `source_error` on timeout.

**Acceptance (browser):** create period Q1, company goal with two KRs (manual number, tasks-auto on a board's done cards), child team goal; move a card to done → KR progress updates within ~1 min; check in with health and note; chart shows points; link a card (card shows the goal chip via W3; in W2 the goal page lists the card); close period with carry-over; tree and list at 375 px.
**Acceptance (MCP):** `create_goal` with KRs → `link_items(card→goal, contributes)` → card done → `get_goal` shows new progress → `check_in_goal`.
**Tests:** `tests/goals*.test.ts` (progress math all metrics/directions, roll-up, sources tasks/children, recompute debounce and budget, access of sources, check-ins, close/carry-over, MCP, purge), `tests/goalsClient.test.tsx`.

#### Decisions as built (GOALS, branch `lane-goals`)

Files: `server/goals/` (`index.ts` registrations, `service.ts`, `access.ts`, `sources.ts`, `routes.ts`, `mcp.ts`, `schemas.ts`), `shared/goals.ts` (words and progress math), `shared/goalsActivity.ts`, `src/goals/` (`module.tsx`, `GoalsApp.tsx`, `GoalPage.tsx`, `sheets.tsx`, `GoalInsights.tsx`, `GoalCardSection.tsx`, `activity.tsx`, `goalsApi.ts`, `goals.css`), migrations 096 (`goals`) and 097 (`goals_search`); 098 unused. D900–D906 hold as written; differences and choices:

| # | Decision |
| --- | --- |
| D907 | **Contributors** are `goal_contributors` rows (096): people who work on a goal besides its owner. They hold `edit` on it (capped by their Team role, so a viewer contributor still only reads), are listed on the goal, get its check-in reminders and health alerts, and see a private goal they contribute to. Sharing is otherwise the generic container (`item_members`, `item_group_grants`, `/api/access/goal/:id`). |
| D908 | **Recompute without a Tasks hook.** Lanes may not edit `server/tasks`, and there is no card-change event, so auto KRs recompute (1) when a goal is read through `GET /api/goals/:id` or `get_goal` and its last compute is older than 60 s (the debounce), (2) from one module schedule `goals.sweep` (`everyMinutes: 5`, the engine's minimum) that refreshes auto KRs not computed for 15 minutes, oldest first, 200 a run, and (3) when a source is saved. The sweep row is created on first use (the first `/api/goals` list, goal, or auto KR of the process), since a module has no boot hook. Auto history points are one per KR per hour (the hour-floored `kr_values.at`). Daily compaction after 30 days is not built (rows are small; listed as unfinished). |
| D909 | **Check-in reminders**: one `goals.checkin_reminder` schedule per open goal, Mondays 09:00 **UTC**, every 1, 2, or 4 weeks (monthly is every 4 weeks); it notifies the owner and contributors only when the goal is due within a day (`checkinDue`), deduplicated per goal while unread. Closed, draft, and binned goals have none. Per-person zones are a W3 follow-up. |
| D910 | **Closing a period** (`POST /api/goal-periods/:id/close`) closes every open goal in it the actor can edit by its score: achieved at 70% or more, else carried over (to `carryOverTo`) or missed; goals the actor cannot edit are counted as skipped and stay open; the period is archived (reopen from the Periods sheet). |
| D911 | **Carry-over** makes a new active goal in the target period with the same owner, parent, team, sharing, contributors, and key results (current values kept, so it starts where it ended), linked back by a `work_links` row (`new goal` *source* `old goal`, "was created from"). |
| D912 | **The `tasks` source** (`server/goals/sources.ts`): scopes `board`, `view` (a saved view's stored filter), `filter` (Tasks filter words, compiled by `compileTaskQuery` as the owner), `sprint`, `tag`, `epic` (sub-cards two levels down); measures `cards`, `points`, `hours` (estimates on boards whose estimate kind matches, as readers see them, D752). Done = a done column, or archived after being done; total leaves out cards archived undone. The source's total becomes the KR's target (start 0) for number and currency KRs; a percent KR stores done ÷ total × 100. |
| D913 | **Source checks (T540)**: a config is parsed by its source's schema and must compute both **as the KR's owner and as the editor**, so nobody can point a KR at a board one of them cannot read. `POST /api/goals/:id/preview-source` previews a config (a new KR has no id, so the preview hangs off the goal). Every compute is one bounded SUM; one over 2 s records `source_error` (T543). |
| D914 | **A missing source** (its module off or not installed, or the owner lost access) keeps the last value, records `source_error`, shows "not available" on the KR, and notifies the owner once (`goals.source_failing`, deduplicated). Turning the module back on resumes it at the next read or sweep. |
| D915 | **MCP names**: the tool policy (`tests/toolResourcePolicy.test.ts`, D265) forbids "key" and "delete" in tool names, so key results are `add_kr` and `update_kr`, and `delete_goal` is `bin_goal` (needs `bin:write` too). `delete_key_result` is not offered: `tests/mcpRules.test.ts` allows no removal over MCP but the Bin, so removing a key result (with its 10-minute Undo) stays in the app. Added: `list_goal_sources`, `get_goal_tree`. `check_in_goal` is offered to chat agents directly (per their mode); the `goal_checkin` proposal kind is not registered yet. *(Superseded by D1047: `goal_checkin` is registered.)* |
| D916 | **Roll-up as built (§G.1 Q4)**: the stored progress is owner-computed over every live, not-dropped child (closed children count their final progress); lists, the tree, and the goal page show only children the viewer can open plus `hiddenChildCount` ("+ 1 aligned goal you can't open"); when a goal's progress comes from children and some are hidden, the goal page says "Progress includes N aligned goals you can't open". |
| D917 | **Sharing in the UI**: the shared Access sheet (`src/access`) does not know the workspace kinds yet, so the goal editor offers audience presets (everyone signed in can view, comment, or edit; or only the owner and contributors) through `PATCH /api/goals/:id` (owner or manager). People and group grants work through `/api/access/goal/:id`; wiring the sheet is W3. |
| D918 | **Cards**: the card dialog gets a side section "Goals" (card slot, `task-card-section` frame) with the goals the card contributes to (chips with progress and health, remove) and "Add to goal"; no card-face badge (it would cost one request per card on a board). |
| D919 | **Goal URLs** `/goals/<slug>-<shortid>`: the goal page loads by short id (`GET /api/goals/:id` takes either) and replaces a stale slug in place; `routeNames`/`FriendlyLinkGate` are not used (their kinds exclude workspace items). |
| D920 | **Suggested health**: progress against elapsed time — within 10 points of the ideal line on track, within 25 at risk, else off track; none before 5% of the time or for KPIs; shown, never stored (D902). |
| D921 | **Insights** (`?view=insights`): KPI tiles (open goals, average progress, share on track, check-ins in 30 days) and charts (goals by health, check-ins per week, average progress by owner, average confidence per week) from `goals.key_results` and `goals.checkins`, scoped to the chosen period. |
| D922 | **Home views** Tree, List, Timeline, Mine, Insights in the URL (`?view=`, `?period=`); j/k, Enter, ←/→ fold, `n` new, `/` search; on the goal page `c` check in, `e` edit, `k` add a key result. At 375 px the toolbar is two rows (period, health, Closed chips, then search), rows stack title over progress, and sheets are full screen. |
| D923 | **Today sections in the Today group** (integration, Wave 2): while `registerTodayRenderer` appended a module's sections to the end of the default order, `goalsCheckin` and `goalsAtRisk` sat in Housekeeping so `tests/todayLayout.test.tsx` (order follows the groups) held. The Wave 2 integration kept one `registerTodayRenderer` that slots a section after the last section of its group (the fix CHECKINS, BOOK, and TIME each made, D1028, D893), so both moved to the Today group. Shipping Goals also changed hard-coded module lists in Wave 1 tests; the integration made those tests generic (they check the built-in modules, sections, and entries and ignore any shipped workspace module), so later lanes need no edits there. |
| D924 | **A percent KR fed by a count compares stored with stored** (audit fix): a percent KR whose source gives a count and its target stores the share; the refresh compares that share (not the raw count) with the stored value, so an unchanged source records no history row, recomputes no goal, and counts no change. |

### D.4 Check-ins / standups (lane CHECKINS, module `checkins`)

**Decisions D930–D959**, threats **T550–T559**, migrations **099–101**.

Key decisions:
- **D930** A check-in is a container (access kind `checkin`) with a question set (§B.2), a schedule, participants, and rounds; each round is one date in the check-in's cadence.
- **D931** Rounds open per participant at their local time (`participant` zone mode) or at one fixed time (`fixed`); a round's date is the cadence date, so a participant in Tokyo and one in Lisbon answer the same "Tue 14 Jan" round.
- **D932** Participation states: `pending`, `answered`, `late` (after deadline), `skipped` (participant chose), `out` (paused/OOO). Streak = consecutive scheduled rounds answered (out rounds don't break it).
- **D933** Answers are editable until the round closes (+ 24 h); edits keep history in item_activity.
- **D934** Anonymous (pulse) check-ins store responses as `anonymous` with no user link; per-person participation is tracked separately in `checkin_round_participants` (who answered, not what) and results show only when ≥ 3 answered (T553).
- **D935** Blockers: answers to a `blockers` question are scanned for work refs on save; each ref creates a `blocks` link and sets the card flag "Blocked" (with card activity) if the author can edit the card; otherwise only the link is recorded.
- **D936** Prefill suggestions are computed on open from the participant's own card activity, time entries (W3), and calendar; nothing is posted without the participant's confirmation. **As built:** cards you moved to done, cards you logged time on, cards assigned to you that are doing or due, and last round's plan and blockers. **Deferred (D1194):** calendar events as suggestions are not built (TODO.md).

**Tables:**

```
099 checkins
checkins(id, short_id, owner_id, name ≤ 120, template CHECK IN ('standup','weekly','retro','pulse','custom'),
  description_md ≤ 4000, anonymous 0/1, status CHECK IN ('active','paused'),
  schedule_json ≤ 2048 ({ weekdays: [1..5], time: "09:30", zoneMode: "participant"|"fixed", tz, everyNWeeks }),
  deadline_minutes INTEGER CHECK 30..10080, reminder_minutes_before INTEGER NULL,
  summary_json ≤ 4096 ({ notifyFollowers, email, noteId? }), audience CHECK IN ('participants'),
  visibility DEFAULT 'selected', share_role DEFAULT 'viewer', BIN, revision, created_at, updated_at)
checkin_participants(checkin_id → checkins CASCADE, user_id → users CASCADE, tz NULL, paused_until DATE NULL,
  joined_at, via_group_id NULL, PRIMARY KEY(checkin_id, user_id))
checkin_rounds(id, checkin_id → checkins CASCADE, round_date DATE, opens_at, closes_at, status CHECK IN ('scheduled','open','closed'),
  answered_count, participant_count, summary_md ≤ 20000 NULL, created_at, UNIQUE(checkin_id, round_date))
checkin_round_participants(round_id → checkin_rounds CASCADE, user_id → users CASCADE, status CHECK IN ('pending','answered','late','skipped','out'),
  opens_at, reminded_at NULL, answered_at NULL, response_id NULL (NULL for anonymous), PRIMARY KEY(round_id, user_id))
  idx (user_id, status)
100 checkins_fts (answers text for readers) + purge triggers (responses host 'checkin', work_links, item_members, item_group_grants, schedules, item_comments)
101 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/checkins?mine=participant\|viewer&cursor=` | |
| POST | `/api/checkins` | `{ name, template, participants, schedule }` (template seeds the question set) |
| GET/PATCH/DELETE | `/api/checkins/:id` | settings, schedule (reschedules future rounds) |
| GET/PUT | `/api/checkins/:id/questions` | draft set; `POST …/publish` |
| PUT | `/api/checkins/:id/participants` | people and groups; `PATCH …/participants/me` `{ pausedUntil?, tz? }` |
| GET | `/api/checkins/:id/rounds?cursor=` | round list with participation |
| GET | `/api/checkin-rounds/:rid` | answers grouped by person (or question), blockers on top |
| GET | `/api/checkin-rounds/:rid/me` | your form + prefill suggestions |
| POST/PUT | `/api/checkin-rounds/:rid/answer` | submit/edit; `POST …/skip` |
| GET | `/api/checkins/due` | rounds open for you (Today) |
| GET | `/api/checkins/:id/stats?from=&to=` | participation, streaks, mood trend |

**MCP** (`checkins:read` / `checkins:write`): `list_checkins`, `get_checkin`, `list_checkin_rounds`, `get_checkin_round` (answers the key may read), `get_due_checkins`, `answer_checkin` (`{ round | checkin+date, answers }`, as the key owner), `skip_checkin`, `create_checkin`, `update_checkin`, `set_checkin_participants`, `checkin_stats`, `delete_checkin` (Bin). Prompt `standup_summary` (summarize a round, list blockers). Agents: reads; `answer_checkin` as proposal `checkin_answer` (the person approves before it posts).

**UI:**
- **Check-ins home** (`/checkins`): **Due now** strip (cards with "Answer"), **My check-ins** list (name, cadence "Weekdays 09:30 · your time", participants avatars, your streak 🔥 n, last round participation ring).
- **Answer sheet** (from anywhere): stepper on phones, page on desktop; question roles get smart inputs: `done` with "Suggestions" chips (cards you finished/moved, click to add as `MYT-12` chips), `plan` prefilled from yesterday's plan and today's due cards, `blockers` with card picker and "No blockers" one-tap, `mood` as emoji scale, `goal_update` (W3) as KR rows. "Same as last time" button per text question.
- **Round view** (`/checkins/<slug>-<sid>/<date>`): header with date switcher (‹ ›), participation bar (answered/late/skipped/out avatars), **Blockers** panel, answers by person (cards with avatar, time, answers, reactions, comment thread) or by question toggle; mood summary.
- **Insights**: participation over time, streaks table, mood trend (pulse: aggregates only).
- **Settings**: questions (QuestionSetEditor with roles), schedule (`SchedulePicker`: weekdays, time, zone mode, deadline, reminder, preview of next 5 fires), participants (PersonPicker with groups), viewers (Access sheet), summary options.
- Mobile 375: due cards first; answer sheet full screen with progress dots; round view single column.

**Notifications:** round open (participant, push + inbox; email only if opted), reminder before deadline (pending participants), round summary (followers/viewers who opted), mention in a comment, your blocker was linked to a card (card assignees).
**Schedules:** `checkins.open` (per participant per round, or per round in fixed mode), `checkins.remind`, `checkins.close`.
**Datasets:** `checkins.participation` (checkin, round date, user (null for anonymous checkins), status, answered_at lateness minutes), `checkins.answers` (checkin, round date, question, numeric value / option; text excluded for anonymous).
**Progress sources:** `checkin_average` (a rating/scale question over the period), `checkin_participation` (rate).
**Search:** answers (readers of the round only; anonymous excluded).
**Bin:** `checkin` (with rounds and responses).
**Audit:** `checkins.create|update|delete`, `checkins.participants`, `checkins.answer` (no text), `checkins.skip`, `checkins.questions_publish`.
**Threats:** T550 participants reading others' answers without view → participants get `view` by default (configurable "participants see only their own answers" for 1:1-style check-ins). T551 MCP `answer_checkin` impersonation → only as the key owner, only rounds they participate in. T552 schedule storms with many participants × zones → one schedule per (checkin, participant) with weekday cadence, batch dispatcher. T553 anonymous small-n deanonymization → ≥ 3 threshold, no per-answer timestamps, order shuffled. T554 blocker scanning sets flags on cards the author can't edit → link only (D935).

**Acceptance (browser):** create a Daily standup for a group (3 people, two zones) at 09:30 weekdays; with the test clock, rounds open per zone; answer with suggested cards; blockers referencing `MYT-12` flag the card; second person comments and reacts; third skips; round closes and followers get a summary; pulse check-in hides results until 3 answers; 375 px answer flow.
**Acceptance (MCP):** `get_due_checkins` → `answer_checkin` → `get_checkin_round` shows the answer; agent proposal flow; `checkin_stats`.
**Tests:** `tests/checkins*.test.ts` (round generation across zones and DST, states/streaks, prefill queries, blockers linking/flags, anonymous threshold, MCP, purge), `tests/checkinsClient.test.tsx`.

#### Decisions as built (CHECKINS, branch `lane-checkins`)

Server `server/checkins/` (store, service, rounds, views, routes, mcp, registrations, goalUpdates), client `src/checkins/`, shared `shared/checkins.ts`, migrations 099 (tables, purge triggers) and 100 (answer FTS); 101 unused. User-facing name **Standups** at `/standups/<slug>-<sid>` (D818); ids, scopes, tables, and MCP tool names keep `checkin`.

| # | Decision |
| --- | --- |
| D937 | **Groups as participants**: `checkin_participant_groups` holds the chosen groups; their members are rows of `checkin_participants` with `via_group_id`, re-synced when participants change and before every round. A person chosen directly and through a group is a direct row. |
| D938 | **Taking part is reading**: a participant's level on the standup is the container's, raised to `comment` and capped by their Team role (guests and viewers read and answer, never comment or react). `private_answers` limits answers (round view, feed, search, datasets) to their author and managers (T550). Visibility defaults to `selected` with no rows: owner plus participants. |
| D939 | **One drive schedule per standup** (deviation from "one schedule per participant" and the three purposes): `checkins.drive`, a `{ once }` rule at the standup's next event (a participant's open time in their zone, a reminder, a round's close). Its handler does every due event at once and re-arms by replacing the schedule (cancel + upsert, a new id), because the dispatcher's own advance after a handler would overwrite the fired row's `next_fire_at`. One row however many people and zones (T552); at most once holds because each re-armed occurrence is strictly later. The fire history of a replaced schedule goes with it. |
| D940 | **Manual rounds**: editors start today's round now (`POST /api/checkins/:id/rounds`, everyone opens at once; 409 `ROUND_EXISTS` when today's has run), close a round early (summary goes out), and nudge people still pending (at most once an hour each). |
| D941 | **Answers as items**: a round's answers are addressed as `checkin_round` items by their response id (the `response` kind belongs to Forms): comments use the generic `/api/items/checkin_round/<responseId>/comments`, links (`mentions`, `blocks`) start from it, and the adapter resolves it to its round. Reactions use the reaction target `checkin_answer`. Anonymous answers are never items. |
| D942 | **Anonymous (pulse)** standups store `anonymous` responses with a keyed hash of round and person (`dedupe_hash`), so a person can edit theirs while nothing links the row to them; participation rows keep no response id. No names, times, comments, reactions, refs, search, or feed; answers show (in an order unrelated to time) from three answers on, mood likewise; the answers dataset excludes rounds below three (T553). Anonymity is fixed at creation. |
| D943 | **Blockers** (C4): card refs in `blockers` answers (keys, links, `card` answers) the author can read become `checkin_blockers` rows and `blocks` links from the answer; the card gets the Blocked flag with card history `blocked_by_checkin` (the standup's name) only when the author can edit it (T554). Its assignees are notified with a neutral title. Editing a blocker away removes the link, not the flag; the next answer sheet offers **Unblock** for cards still flagged. |
| D944 | **Late and grace**: after a person's own deadline an answer is `late`; answers are accepted and editable until 24 hours after the round closes (D933). Edits record `answer_edited` activity (no text). |
| D945 | **Goal updates without Goals**: a `goal_update` question is stored as text (goal links in it become `mentions`); `registerStandupGoalUpdater` (server/checkins/goalUpdates.ts) lets Goals write check-ins inside the answer's transaction later (W3). Absent, nothing else happens. |
| D946 | **Zones**: in "each person's zone" mode a participant's zone follows their browser (`PUT /api/checkin-participation/timezone`, sent once per app load) until they choose one (`PATCH …/participants/me`); fixed mode uses the standup's zone. A round's date is the cadence date in the zone that reaches it first (D931). |
| D947 | **Summaries are structured** (no model): closing a round stores a one-line summary ("3 of 4 answered · 1 blocker · mood 3.8"), notifies the owner and participants (each can opt out or in, `checkin_subscriptions`), and emails `checkins.summary` when the standup asks. The MCP prompt `standup_summary` became the tool `summarize_checkin_round` (the foundation has no prompt registry). |
| D948 | **Which occurrences open**: only those after the standup was created, and a missed one (downtime) only while its round would still be open. Pausing a standup stops new rounds; a person's pause (`paused_until`) marks their rounds `out`. |
| D949 | **Who else can read it**: the shared Access sheet does not take workspace kinds yet, so Settings offers "Participants / Everyone in the workspace" through the generic `/api/access/checkin/:id`; finer sharing is that endpoint's (W3 can wire the sheet). |
| D950 | **Datasets** `checkins.participation` (column `state`, not `status`: the compiler groups by alias and `status` is ambiguous across the joined tables) and `checkins.answers` (numbers and choices only, question title and role from the pinned set). Progress sources `checkin_average` and `checkin_participation`. |
| D951 | **Friendly ids everywhere**: every `:id` takes the UUID, the short id, or the whole segment (`daily-standup-9bpbp3sood`); the app corrects a stale slug with a replace. |
| D953 | **MCP Bin tools follow the repo's names**: `bin_checkin` and `restore_checkin` (with `bin:write`) instead of the plan's `delete_checkin` (the MCP rules refuse `delete` in a tool name). |
| D954 | **Today order fix (foundation, one function)**: `registerTodayRenderer` now inserts a module's section after the last section of its group, as its comment always said; it appended at the end, which broke the group order once a module shipped. |
| D955 | **The note digest publishes inside its own lock** (audit fix to D1044): `appendRoundToNote` writes the round onto the published text and publishes it in the same note lock, at the draft revision its own write returned (`publishDraftLocked`, split out of `publishDraft`), so a draft someone saves right after can never be published with it as the standup's owner; that editor's draft stays theirs. |
| D956 | **The digest writes as the person who chose the note** (audit fix to D1044): choosing a summary note records who chose it (`summary_json.noteSetBy`, never returned by the API; cleared with the note), since they were the one checked against the note. At write time they must still edit both the note and the standup; otherwise nothing is written, the person is notified ("… could not be added to its note"), and the attempt is audited (`checkins.summary_note_denied`). Settings saved before this fall back to the owner. |
| D952 | **Foundation tests count shipped modules**: `tests/workspaceRegistry.test.ts` and `tests/workspaceRoutes.test.tsx` keep a `SHIPPED` set (each lane adds its id when it sets `ready: true`) instead of expecting every stub hidden; the built-in lists in tests of Settings (the Workspace entry appears once a module ships, D836), the launcher, Today, `/api/today`, and the reaction registry filter out or name the shipped module's additions. |


### D.5 CRM (lane CRM, module `crm`)

**Decisions D960–D999**, threats **T560–T574**, migrations **102–105**. Builds on the foundation people tables (088).

Key decisions:
- **D960** Dedicated tables, not Collections rows: contacts need identity (dedupe by email, upsert from bookings/forms), relations (company, deals), and typed queries for pipelines; Collections stays the generic tables module. CRM **reuses Collections' field engine** (`server/collections/schema.ts` field types and validation, the table cell editors) for custom fields stored in `custom_json`, adding two field types `person` and `contact` in the engine (shared code, D961).
- **D961** Collections field engine gains `person` and `contact` types (CRM lane edits `server/collections/schema.ts` append-only: new rows in `FIELD_TYPES` and their validators; Collections UI shows them read-only until W3 adds editors there).
- **D962** Pipelines belong to a contact book; stages have kind `open | won | lost` and probability; a deal's status derives from its stage kind; won/lost stamp `closed_at`.
- **D963** Interactions are first-class rows linked to any number of contacts/companies/deals; automatic interactions (booking, form, task done) carry `source` and are editable.
- **D964** Rotting: a deal is rotting when its last interaction/stage change is older than the stage's `rot_days` (book default 14).
- **D965** Merge keeps the target's non-empty fields, unions channels/tags/links/interactions, rewrites references (deals, bookings, responses, time targets) in one transaction, and records `merged_from` in activity.
- **D966** CSV import is two-step: upload → preview with mapping, dedupe decisions (create / update existing / skip) → commit as one job (≤ 10 000 rows, chunked transactions with progress, undo by job id within 24 h).

**Tables:**

```
102 crm
pipelines(id, book_id → contact_books CASCADE, name ≤ 80, currency, position, created_at, updated_at, deleted_at NULL)
pipeline_stages(id, pipeline_id → pipelines CASCADE, name ≤ 60, kind CHECK IN ('open','won','lost'), probability INTEGER CHECK 0..100,
  rot_days INTEGER NULL CHECK 1..365, color, position)
deals(id, short_id, book_id → contact_books CASCADE, pipeline_id → pipelines CASCADE, stage_id → pipeline_stages,
  title ≤ 200, value_minor INTEGER NULL ≥ 0, currency, expected_close_on DATE NULL, owner_id NULL,
  company_id NULL → companies SET NULL, next_step ≤ 200 NULL, next_step_on DATE NULL,
  status CHECK IN ('open','won','lost'), closed_at NULL, lost_reason ≤ 200 NULL, stage_entered_at,
  last_activity_at, position REAL, custom_json ≤ 16384, tags_json ≤ 2048, BIN, revision, created_at, updated_at)
  idx (pipeline_id, stage_id, position) WHERE deleted_at IS NULL, (owner_id, status), (expected_close_on)
deal_contacts(deal_id → deals CASCADE, contact_id → contacts CASCADE, role ≤ 40, PRIMARY KEY(deal_id, contact_id))
deal_stage_changes(id, deal_id → deals CASCADE, from_stage_id NULL, to_stage_id, value_minor, actor_id, at)  -- velocity/funnel dataset
interactions(id, book_id → contact_books CASCADE, kind CHECK IN ('note','call','meeting','email','message','task','booking','form','other'),
  direction CHECK IN ('in','out','none'), occurred_at, duration_s NULL, title ≤ 200, body_md ≤ 20000, author_id NULL,
  source CHECK IN ('manual','booking','form','task','import','mcp'), source_ref ≤ 80 NULL, created_at, updated_at)
interaction_subjects(interaction_id → interactions CASCADE, subject_kind CHECK IN ('contact','company','deal'), subject_id,
  PRIMARY KEY(interaction_id, subject_kind, subject_id))  idx (subject_kind, subject_id)
crm_lists(id, short_id, book_id, name ≤ 80, entity CHECK IN ('contact','company','deal'), created_by, created_at, updated_at, deleted_at NULL)
crm_list_members(list_id → crm_lists CASCADE, item_id, added_by, added_at, PRIMARY KEY(list_id, item_id))
crm_views(id, book_id, entity, name ≤ 60, kind CHECK IN ('table','board'), config_json ≤ 8192, owner_id NULL (NULL = shared), position)
crm_followups(id, book_id, subject_kind, subject_id, user_id, due_at, note ≤ 500, done_at NULL, schedule_id NULL, created_at)
crm_import_jobs(id, book_id, user_id, entity, status, mapping_json, stats_json, created_at, finished_at, undo_until)
103 crm_fts (contacts names/emails/company, companies name/domain, deals title, interactions body) + triggers
104 purge triggers (work_links, item_activity, item_comments, schedules for crm kinds; responses/bookings contact refs SET NULL)
105 (spare)
```

**HTTP** (all under `/api/crm`):

| Method | Path | Notes |
| --- | --- | --- |
| CRUD | `/books[/:id]` | + `/fields` (custom field defs), settings, Access sheet as other kinds |
| GET/POST | `/contacts?book=&q=&list=&view=&filter=&sort=&cursor=` | filters on any field incl. custom |
| GET/PATCH/DELETE | `/contacts/:id` | GET includes channels, company, deals, last interactions |
| POST | `/contacts/:id/merge` | `{ intoId }` (D965) |
| GET | `/contacts/duplicates?book=` | candidate pairs (email, name+company) |
| CRUD | `/companies[/:id]` | + `/merge` |
| CRUD | `/pipelines[/:id]`, `/pipelines/:id/stages` | reorder stages |
| GET/POST | `/deals?pipeline=&stage=&owner=&status=&cursor=` | |
| GET/PATCH/DELETE | `/deals/:id` | PATCH `{ stageId, position }` from the board |
| GET | `/pipelines/:id/board` | stages with deals (paged per stage) and totals (sum, weighted) |
| GET/POST | `/interactions?subject=kind:id&cursor=` | timeline; PATCH/DELETE `/interactions/:id` |
| CRUD | `/lists[/:id]`, `/lists/:id/members` | |
| CRUD | `/views[/:id]` | |
| POST | `/followups`; PATCH `/followups/:id` | remind me / done |
| POST | `/import` (multipart) → `{ jobId, preview }`; POST `/import/:jobId/commit`; POST `/import/:jobId/undo` | |
| GET | `/export.csv?entity=&book=&view=`; `/contacts/:id/vcard` | |
| GET | `/records/:kind/:id/timeline` | interactions + activity + linked items merged |

**MCP** (`crm:read` / `crm:write`): `list_contact_books`, `search_crm` (`{ q, entity? }`), `list_contacts`, `get_contact`, `create_contact`, `update_contact`, `upsert_contact` (by email), `merge_contacts`, `bulk_upsert_contacts` (≤ 100, dryRun), `list_companies`, `get_company`, `create_company`, `update_company`, `list_pipelines`, `list_deals`, `get_deal`, `create_deal`, `update_deal` (stage by name or id), `bulk_update_deals`, `log_interaction` (`{ kind, occurredAt?, title, body, subjects: WorkRef[] }`), `list_interactions`, `create_followup`, `pipeline_summary` (by stage: count, sum, weighted), `delete_contact|company|deal` (Bin). Agents: reads; writes as proposals `contact_create`, `contact_update`, `deal_create`, `deal_update`, `interaction_log`; prompt `pipeline_review`.

**UI:**
- **CRM home** (`/crm`): left nav (desktop) / top tabs (phone): **Contacts**, **Companies**, **Deals**, **Lists**, **Insights**; book switcher (All books or one).
- **Tables** (contacts, companies): Collections-like grid (column picker, sort, filter chips, saved views, inline edit of simple fields, bulk select → add to list / set owner / tag / delete), search box, **+ New**, **Import**.
- **Record page** (`/crm/contacts/<slug>-<sid>`): header (avatar, name, title @ company chip, owner, lifecycle chip, quick actions: Log interaction, Remind me, Create task, Start timer (Time), Send booking link (W3), Email (mailto)), left column fields (core + custom, editable), right **Timeline** (interactions + activity + comments + linked bookings/responses/cards/time, filter chips), Deals panel, Lists.
- **Deal board** (`/crm/deals?pipeline=`): `<KanbanBoard>` columns = stages with count, sum, weighted sum; cards: title, value, company/contact chips, owner avatar, next step date (red if past), rotting dot; drag between stages (won/lost asks for reason when lost); table view toggle; pipeline settings sheet (stages, probabilities, rot days).
- **Deal page**: like record page plus stage progress stepper, value/close date, contacts with roles.
- **Import**: upload → mapping table (CSV column → field, auto-matched) → dedupe preview counts → commit with progress → result + Undo.
- Mobile 375: tables become lists (name, subtitle, one metric); deal board shows one stage at a time with a stage strip (Tasks' phone board pattern).

**Notifications:** follow-up due, deal assigned to you, deal won/lost (book followers opted in), mention in an interaction/comment, import finished.
**Schedules:** `crm.followup`, `crm.rotting` (daily per book: notify owners of newly rotting deals).
**Datasets:** `crm.contacts` (book, lifecycle, owner, source, created_at, last_interaction_at), `crm.deals` (pipeline, stage, status, value, currency, owner, expected_close_on, created_at, closed_at), `crm.deal_stage_changes`, `crm.interactions` (kind, author, occurred_at, subject kinds).
**Progress sources:** `crm_won_value`, `crm_won_count`, `crm_pipeline_value` (pipeline, period, owner filter).
**Search:** contacts (name, emails, phones, company), companies (name, domain), deals (title), interactions (body; readers of the book).
**Bin:** `contact_book`, `contact`, `company`, `deal`.
**Audit:** `crm.book_*`, `crm.contact_create|update|delete|merge`, `crm.company_*`, `crm.deal_*` (stage changes with from/to ids), `crm.interaction_*`, `crm.import_commit|undo`, `crm.export`.
**Threats:** T560 PII exposure (emails/phones) to people without book access → resolver redaction, search filtered by readable books, MCP keys need `crm:read` + book grant. T561 CSV import injection/zip bombs → CSV only, 5 MiB, 10 000 rows, parser limits; export formula escaping. T562 merge across books → refused (same book only). T563 upsert overwriting data (bookers changing a contact's name) → D806 fill-empty only. T564 mass export by a compromised key → export counts against a daily bucket, audited. T565 vCard/CSV header injection → quoted, CRLF stripped. T566 agent proposals exfiltrating contacts into chats → agent tool results capped and redacted of channels unless the agent's scope includes them (agents see emails only via `get_contact`).

**Acceptance (browser):** create a book, custom fields (select, person), import 200-row CSV with 10 duplicates (preview shows them; choose update), undo, re-import; record page with timeline; log a call; remind me tomorrow (notification fires with test clock); pipeline with 5 stages; drag deals; lost reason; rotting dot after clock jump; merge two contacts and see deals/bookings move; Insights pipeline by stage; 375 px list and stage strip.
**Acceptance (MCP):** `upsert_contact` → `create_deal` → `update_deal stage="Won"` → `pipeline_summary`; `log_interaction` with a contact and a deal; chosen-book key can't see another book.
**Tests:** `tests/crm*.test.ts` (dedupe/upsert/merge, import job + undo, board ordering/moves, totals/weighted, rotting, custom fields via the Collections engine, search, MCP, purge orphans), `tests/crmClient.test.tsx`.

#### Decisions as built (lane CRM, branch `lane-crm`)

Contacts ships at `/contacts` (§G.1 Q7) with module id `crm`. Server in `server/crm/` (`core.ts` books, access, custom fields; `records.ts` contacts and companies; `deals.ts` pipelines and deals; `interactions.ts` interactions, follow-ups, tasks, timeline; `lists.ts` lists and views; `importExport.ts`; `integrations.ts` registrations; `routes.ts`; `mcpTools.ts`; `index.ts`), client in `src/crm/`, shared words in `shared/crm.ts`. Migrations 102 (`crm`), 103 (`crm_fts`), 104 (`crm_purge`); 105 unused.

| # | Decision |
| --- | --- |
| D967 | **Book access is the foundation's** (`contact_book` container, D803): readers read every contact, company, deal, interaction, list, and view in the book; editors (edit and up, and a writing role) change them; managers change settings, custom fields, and pipelines; only the owner moves a book to the Bin. System books (`system_kind = 'clients'`, D807) never show in Contacts. Unreadable, binned, and missing are one `NOT_FOUND`. |
| D968 | **Custom fields** live per entity in `contact_books.fields_json` as `{ contact, company, deal }` lists of Collections field definitions, built with `buildSchema` behind a fixed placeholder primary field (CRM records have no title field) and validated with `validateValues`. Values are keyed by field id or, over MCP, by name. `person` (a live team member) and `contact` (a readable contact of the same book) were added to the engine (D961); Collections refuses to *create* them (`buildSchema(..., { allowRelations })`, false by default) until Wave 3 adds editors, and filters them only by empty / not empty (`server/collections/query.ts`, two lines). |
| D969 | **Dedupe**: a contact's email is unique per book (088's index, binned contacts included); creating a duplicate is 409 `EXISTS` with the existing `contactId`; a company's domain is unique among live companies of a book. Duplicate candidates are same name or same phone (`GET /contacts/duplicates`, and a banner on the record). |
| D970 | **Merge** (D965) moves channels the target lacks, deal contacts, interaction subjects, list memberships, follow-ups, work links, comments, and, when those tables and columns exist, other lanes' references (`responses.respondent_contact_id`, `bookings.contact_id`, `time_entries.contact_id`, `time_projects.company_id`, …); the target keeps its non-empty fields; the source row is deleted (not binned: its references are gone) and `crm_merged` is recorded on the target. Same book only (`OTHER_BOOK`, T562). |
| D971 | **Hand edits** call `markContactEdited` for name, company, phone, job title, location, and time zone, so foundation upserts (bookings, forms, MCP `upsert_contact`) keep filling only empty fields (D806). |
| D972 | **Deals**: status mirrors the stage kind; won/lost stamp `closed_at`, open clears it; a lost reason is kept only on lost deals. Board order is a REAL `position` per stage; a drop at index *i* takes the midpoint of its neighbours and the stage is renumbered when they get too close. Each stage change writes `deal_stage_changes` (with the value then) and a `crm_stage` activity entry; the owner hears about won/lost and being made owner. Currency: the deal's, else its pipeline's, else the book's, else the workspace default (§G.1 Q6); board totals add only the board currency (no conversion). |
| D973 | **Rotting** (D964): open deals whose `last_activity_at` (moved by stage changes and interactions) is older than the stage's `rot_days`, else the book's `rottingDays` (14). One `crm.rotting` schedule per book (daily 08:00 UTC, created with the book and lazily when a board is opened) notifies each owner once per stay (`rot_notified_at`, cleared by activity). |
| D974 | **Interactions** belong to one book and name 1–20 records of it; logging needs edit on the book; the author or a manager edits or deletes; deleting returns an Undo ticket (D813). A company's timeline includes its contacts' interactions. `source` + `source_ref` is unique, so a lane logging "booking" or "form" interactions is idempotent. |
| D975 | **Follow-ups** are private to the person who sets them (reading the record and comment level are enough): a `crm.followup` schedule (`{ once: dueAt }`, owner `crm_followup`) sends an inbox notification (`crm.followup_due`) if still open and the person still reads the book. "Create task" makes a card through the Tasks service and links it to the record (`relates`). Finishing that card does not yet log an interaction (C17's last half needs a Tasks hook: Wave 3). |
| D976 | **Lists** are static sets of one entity in one book (editors manage); **views** save filters, sort, and layout, personal (any reader) or shared (editors). Filters compile from a fixed field table plus the book's custom field ids; values are bound. Lists are keyset paged with `[sort value, id]` cursors. |
| D977 | **CSV import** (D966) keeps the CSV on the preview job (≤ 5 MiB, 10,000 rows, 60 columns), auto-maps columns by header aliases and custom field names, matches contacts by email and companies by domain then name, writes 500 rows per transaction, and records created ids and the updated rows' prior state; undo (24 h) deletes what it created (and companies it created that nothing uses) and restores the rest. Cells are restored from formula neutralization on import and neutralized on export (T561). Duplicates are updated or skipped; rows with problems are counted, never half-written. |
| D978 | **Export** is 30 per person a day in memory (T564), at most 10,000 rows, audited (`crm.export`), plus a vCard per contact with escaped values (T565). |
| D979 | **Search**: one FTS5 index (`crm_search` → `crm_fts`) kept by triggers on contacts, channels, companies, deals, and interactions, so other lanes' writes are indexed; queries join the live tables and the reader's books (T560). Scope `contacts` in All search; MCP `search_crm`. |
| D980 | **Datasets** `crm.contacts`, `crm.deals`, `crm.deal_stage_changes`, `crm.interactions`, scoped by the book predicate. Dimension names never equal a column of a joined table (`created`, `closed`, `pipeline_key`, `deal_currency`, `interaction_kind`, …): the registry groups by the quoted alias, and SQLite resolves an alias that is also an ambiguous column name as the column (an error). **Note for W1-CORE**: the registry could alias as `"d_<name>"` to make this impossible for every lane. |
| D981 | **Progress sources** `crm_won_value`, `crm_won_count` (deals closed won in the KR period), `crm_pipeline_value` (open now), config `{ pipelineId?, bookId?, ownerId? }`, computed as the KR owner over books they read. |
| D982 | **MCP**: 27 tools (`list_contact_books`, `search_crm`, `list/get/create/update_contact`, `upsert_contact`, `merge_contacts`, `bulk_upsert_contacts`, `bin_contact`, `list/get/create/update_company`, `bin_company`, `list_pipelines`, `list/get/create/update_deal`, `move_deal`, `bulk_update_deals`, `bin_deal`, `pipeline_summary`, `log_interaction`, `list_interactions`, `create_followup`). Deleting is `bin_*` (needs `bin:write`; the policy test forbids "delete" in tool names). List tools leave out emails and phones (T566); `get_contact` has them. Bulk tools are ≤ 100 and all or nothing; `bulk_update_deals`'s `dryRun` runs the changes in a rolled-back transaction. Agents get the read tools; every write tool is `never` for now (proposal kinds `contact_create`, … are not registered yet: Wave 3). *(Superseded by D1047: `contact_create`, `contact_update`, `deal_create`, `deal_update`, and `interaction_log` are registered, and their tools are offered to agents through them.)* |
| D983 | **Client routes**: the module keeps the path segments as they are and resolves records by short id or UUID through its own API (`refOf`), correcting the slug with a replace. In-module links go through the host's `navigate`, because `WorkspaceModuleHost` follows only its own moves and Back/Forward (**note for W1-UI**: `onOpenPath` into the same module does not re-render it). Books: `?book=` (or the last one used), "All books" for people and companies. |
| D984 | **Sharing UI**: the client `AccessSheet` does not know workspace kinds, so Settings → Who has access is a small sheet over `GET/PUT /api/access/contact_book/:id` (audience, people with levels; groups are kept as they are but not edited there). |
| D985 | **Tests outside the lane** changed by necessity: `tests/collectionsQuery.test.ts` lists the two new field types; `tests/toolResourcePolicy.test.ts` resets rate windows per tool (its single owner otherwise runs out of the per-user write and Bin budgets as modules add tools); `tests/workspaceRegistry.test.ts` and `tests/workspaceRoutes.test.tsx` allow a shipped module; the tests that pin the Settings module list, the launcher, Today's sections, and the Settings hub (`modules`, `appShell`, `today`, `todayLayout`, `settingsHub`, `settingsBin`, `wave38Fixes`, `wave38Review`) now include Contacts, its `crmFollowups` section (grouped into Today, D836), and Settings → Workspace, which W1-UI shows to every role once any module ships. |
| D986 | **A new deal's currency is resolved once** (audit fix, with Forms' Create a deal, D1045): `newDealCurrency(book, pipelineId)` gives what `createDeal` will save (the named pipeline's currency, else the book's first pipeline's, else the book's). The form action no longer passes a currency (it used the book's even when the deal landed in a pipeline with its own) and scales the typed amount by the resolved currency's minor digits (¥1250 is 1250, $12.50 is 1250). |
| D987 | **Interaction activity reads as a phrase** (audit fix): an activity line for a logged interaction uses `INTERACTION_LOGGED` (shared/crm.ts) instead of "logged a <kind>": "logged a form response", "logged an email", "logged a finished task", "logged a booking", "logged an interaction" (other), so no line says "logged a form" or "logged a other". |
| D988 | **A record's history is shown once** (audit fix): contact, company, and deal pages already show their history in the record timeline (interactions, changes, links), so the Comments panel under it is `ItemTimeline history={false}`: comments only, no Activity switch, no history read. Other pages keep the shared timeline's Activity switch. |

Threats as built (T560–T566 as planned; T567–T569 new): **T567** a merge rewrites another lane's table it should not → only fixed `(table, column)` pairs, only when present (`PRAGMA table_info`). **T568** import job keeps a CSV with personal data → kept only while the job is a preview, deleted after a day, cleared on commit. **T569** dataset alias collisions turn a valid query into a 500 → names checked by `tests/crm.test.ts` (every dimension of every dataset grouped).

### D.6 Bookings (lane BOOK, module `bookings`)

**Decisions D1000–D1039**, threats **T575–T594**, migrations **106–109**.

Key decisions:
- **D1000** Availability = schedule rules (weekly ranges + overrides, in the schedule's zone) minus busy time from the host's chosen Nook calendars (timed events, recurring expanded; all-day events optional per type) minus existing bookings (including pending) with buffers; then notice, horizon, interval, and daily/weekly limits. Computed server-side for a bounded window (≤ 62 days per request).
- **D1001** Booking creation is one transaction that re-computes availability for that slot under a per-host lock (SQLite single writer + `bookings_host_slot` check), so two bookers can't take the same slot (T576).
- **D1002** Events created for bookings live in the host's calendar, linked to the booking by a `work_links` row (not `event_links`, whose `target_type` is CHECK-listed; D804), with the intake answers in the description (visible to the calendar's readers); busy-only feeds keep showing "Busy".
- **D1003** Bookers are upserted into the type's contact book (if set) with D806 rules; their identity on the booking itself is name/email as typed.
- **D1004** Manage links (reschedule/cancel) are per-booking tokens in `public_links` (`booking_manage`), valid until the booking ends; reschedule creates a new booking linked via `rescheduled_from_id` and cancels the old one.
- **D1005** Round-robin picks among available hosts the one with the fewest bookings in the last 30 days for that type, ties by priority then least recently booked; collective requires every host free and puts the event on each host's calendar (one event per host, linked).
- **D1006** Public profile handles are unique, lower-case `[a-z0-9-]{3,30}`, reserved words refused; changing a handle keeps the old one as an alias for 90 days.
- **D1007** Manual approval: booking `pending` holds the slot; host approves/declines from notification; pending expires after `pending_hours` (default 24) via schedule.
- **D1008** Without mail configured, public booking still works but the confirmation page tells the booker to save the manage link; email verification can't be enabled.

**Tables:**

```
106 bookings
booking_profiles(user_id PK → users CASCADE, handle ≤ 30 UNIQUE, display_name ≤ 80, welcome_md ≤ 2000, tz, enabled 0/1, created_at, updated_at)
booking_handle_aliases(handle PK, user_id, expires_at)
availability_schedules(id, user_id → users CASCADE, name ≤ 60, tz, rules_json ≤ 4096 ({ mon: [{from:"09:00",to:"12:00"},…], … }),
  is_default 0/1, created_at, updated_at)  unique (user_id) WHERE is_default = 1
availability_overrides(id, schedule_id → availability_schedules CASCADE, date DATE, ranges_json ≤ 1024 NULL (NULL = unavailable), note ≤ 100,
  UNIQUE(schedule_id, date))
booking_types(id, short_id, owner_id, slug ≤ 60, title ≤ 120, description_md ≤ 4000, durations_json ≤ 128 ([30] or [15,30,60]),
  location_kind CHECK IN ('in_person','phone','video_link','custom','ask'), location_value ≤ 500,
  assignment CHECK IN ('single','round_robin','collective'), schedule_id NULL, calendar_id NULL (where events land, single),
  busy_calendar_ids_json ≤ 1024, include_all_day_busy 0/1, buffer_before_min, buffer_after_min CHECK 0..240,
  min_notice_min CHECK 0..43200, max_days_ahead CHECK 1..365, slot_interval_min CHECK IN (5,10,15,20,30,60),
  daily_limit NULL, weekly_limit NULL, confirm CHECK IN ('auto','manual'), pending_hours CHECK 1..168,
  verify_email 0/1, contact_book_id NULL → contact_books SET NULL, card_json ≤ 2048 NULL ({ boardId, columnId, titleTemplate, assignHost }),
  reminders_json ≤ 512 ([1440, 60] minutes before; booker + host flags), color, public 0/1, status CHECK IN ('active','hidden'),
  visibility, share_role, BIN, revision, created_at, updated_at, UNIQUE(owner_id, slug))
booking_type_hosts(type_id → booking_types CASCADE, user_id → users CASCADE, priority INTEGER, calendar_id NULL, schedule_id NULL,
  PRIMARY KEY(type_id, user_id))
bookings(id, short_id, type_id → booking_types, host_id → users, start_utc, end_utc, duration_min, booker_tz,
  status CHECK IN ('pending','confirmed','cancelled','declined','expired','completed','no_show'),
  booker_name ≤ 120, booker_email ≤ 254, booker_email_norm, guests_json ≤ 2048 (≤ 10 emails), location_resolved ≤ 500,
  contact_id NULL → contacts SET NULL, response_id NULL → responses SET NULL, card_id NULL → cards SET NULL,
  rescheduled_from_id NULL → bookings SET NULL, cancel_reason ≤ 500 NULL, cancelled_by CHECK IN ('host','booker','system') NULL,
  source CHECK IN ('public','secret_link','internal','mcp'), created_by NULL (internal), created_at, updated_at, revision)
  idx (host_id, start_utc) WHERE status IN ('pending','confirmed'), (type_id, start_utc), (booker_email_norm, type_id, status)
booking_events(booking_id → bookings CASCADE, host_id, event_id → events SET NULL, PRIMARY KEY(booking_id, host_id))
107 bookings_fts + purge triggers (work_links, item_members, public_links, schedules)
108–109 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET/PUT | `/api/bookings/profile` | handle, name, welcome, enabled (policy `public_booking_pages` for public) |
| CRUD | `/api/bookings/schedules[/:id]`, `/overrides` | |
| CRUD | `/api/bookings/types[/:id]` | + `/hosts`, intake questions (`/questions` draft/publish via §B.2) |
| GET | `/api/bookings/types/:id/slots?from=&to=&tz=&duration=` | internal preview |
| POST | `/api/bookings/types/:id/secret-links` | one-off/expiring token; DELETE to revoke |
| GET | `/api/bookings?status=&from=&to=&type=&cursor=` | host/manager list |
| POST | `/api/bookings` | internal booking (member books a colleague's type) |
| GET | `/api/bookings/:id` | |
| POST | `/api/bookings/:id/approve` · `/decline` · `/cancel` · `/reschedule` · `/no-show` | host actions with optional message |
| GET | `/api/public/book/:handle` | profile + public types |
| GET | `/api/public/book/:handle/:slug` · `/api/public/book/link/:token` | type + intake + nonce |
| GET | `/api/public/book/…/slots?from=&to=&tz=&duration=` | rate-limited, max 31 days per call, cached 30 s |
| POST | `/api/public/book/…/bookings` | `{ start, duration, tz, name, email, guests?, answers, nonce, hp, t }` → `{ status, manageUrl?, verify? }` |
| POST | `/api/public/bookings/verify` | email code |
| GET/POST | `/api/public/bookings/manage/:token` | view, cancel `{ reason }`, reschedule `{ start }` |
| GET | `/api/public/bookings/manage/:token/ics` | ICS of the booking |

**MCP** (`bookings:read` / `bookings:write`): `list_booking_types`, `get_booking_type`, `create_booking_type`, `update_booking_type`, `get_availability` (`{ type, from, to, tz }` → slots), `list_bookings`, `get_booking`, `create_booking` (internal, as the key owner or for a contact: `{ type, start, booker: PersonRef | { name, email } }`), `cancel_booking` (host side, needs `bookings:write`), `reschedule_booking`, `approve_booking`, `decline_booking`, `mark_no_show`, `get_booking_link` (public URL when public; else none), `delete_booking_type` (Bin). Agents: reads + `get_availability` + `create_booking` (internal only, as proposal unless allowed); never cancel/decline.

**UI:**
- **Bookings home** (`/bookings`): tabs **Upcoming** (grouped by day, pending first with Approve/Decline), **Past**, **Cancelled**; **Booking types** (cards: color bar, title, durations, location icon, hosts, "Copy link", toggle active, ⋯ secret link); **Availability** (schedules: weekly editor with day rows and time ranges, add range, copy to all days; overrides calendar); **Profile** (handle, preview).
- **Type editor**: sections General, When (schedule, durations, buffers, notice, horizon, interval, limits), Where (location), Hosts (assignment, people), Calendars (busy and target), Intake (QuestionSetEditor; name/email always first), After booking (contact book, create card template, reminders, confirmation), Public (public toggle, verification). Live **slot preview** at right on desktop.
- **Public pages** (`/p/book/<handle>`, `/p/book/<handle>/<slug>`, `/p/book/link/<token>`): PublicPageShell, host card, type list → month calendar with available days → time list in the booker's zone (zone picker) → details form (name, email, guests, intake) → confirmation (summary, add to calendar ICS, manage link). Manage page: details + Reschedule / Cancel.
- **Booking detail sheet** (host): booker, contact chip (open in CRM), answers, event link, card link, notes (ItemTimeline), actions.
- Mobile 375: public flow is single column steps; Upcoming list cards; schedule editor rows wrap ranges to a second line ("two rows, nothing hidden").

**Notifications:** new booking / pending request / cancelled / rescheduled (hosts, push + email by prefs); reminders to hosts (push) and bookers (email); daily "today's bookings" via Today/digest.
**External mail templates:** `bookings.confirmed`, `bookings.pending`, `bookings.declined`, `bookings.cancelled`, `bookings.rescheduled`, `bookings.reminder`, `bookings.verify` (ICS attached via `server/calendar/ics.ts`).
**Schedules:** `bookings.remind` (per booking × offset), `bookings.pending_expire`, `bookings.complete` (mark completed after end).
**Datasets:** `bookings.bookings` (type, host, status, start, duration, lead time hours, source, created_at; no booker PII).
**Search:** bookings (booker name/email for hosts/managers), types.
**Bin:** `booking_type` (bookings remain, type shown as "Deleted type").
**Audit:** `bookings.type_*`, `bookings.profile_update`, `bookings.create` (source), `bookings.approve|decline|cancel|reschedule|no_show`, `bookings.secret_link_*`.
**Threats:** T575 public slot scraping reveals calendar patterns → slots only (no event details), 31-day windows, rate limits, profile disabled by default. T576 double booking race → D1001. T577 spam bookings / mail bombing third parties → per-email caps, verification option, per-type hourly cap, external mail caps (§B.7), honeypot/fill-time. T578 manage token leakage via Referer → `no-referrer`, token in path only on our origin, single booking scope, expires at end. T579 handle squatting / impersonation (`/p/book/admin`) → reserved words, admins can reset handles. T580 intake answers injecting into calendar event descriptions shown to members → stored as text, rendered escaped; links not autolinked except `url` answers. T581 timezone manipulation to bypass notice → server computes in UTC. T582 host private calendar details in event created on a shared calendar → booking events default to the host's private calendar; type editor warns when the target calendar is shared. T583 enumeration of bookings via MCP for hosts in other teams → bookings readable by host and type managers only.

**Acceptance (browser):** set profile handle, weekday 09–12/13–17 schedule with an override day off; type "Intro call" 30 min, buffer 10, notice 4 h, busy from your calendar; create a calendar event → slot disappears; book from a private window as an outsider (policy on) with intake answers; host gets notification; event in calendar; contact created in the chosen book with a meeting interaction; prep card created; booker mail in the dev mail log with ICS and manage link; reschedule from the manage page; cancel; manual-approval type → pending → approve; round-robin across two hosts; two concurrent bookings for the same slot → one wins (test + manual); 375 px public flow.
**Acceptance (MCP):** `get_availability` → `create_booking` (internal) → `list_bookings` → `reschedule_booking` → `cancel_booking`.
**Tests:** `tests/bookings*.test.ts` (slot math: zones, DST, overrides, buffers, notice, limits, recurring busy events; concurrency; round-robin/collective; public flow incl. verification and limits; manage tokens; contact upsert; card creation; reminders via test clock; MCP; purge), `tests/bookingsClient.test.tsx`, `tests/bookingsPublic.test.tsx`.

#### Decisions as built (lane BOOK, branch `lane-book`)

Code: `server/bookings/*` (model, setup, types, availability, service, feeds, icsParse, routes, publicRoutes, mail, mcpTools, insights, index), `shared/bookings.ts` (words and the pure slot math), `src/bookings/*`, `src/ui/schedule/AvailabilityEditor.tsx`, migrations 106 (`bookings`) and 107 (`bookings_fts`); 108–109 unused. Tests: `tests/bookingsSlots.test.ts` (the zone and DST matrix, pure), `tests/bookingsIcs.test.ts` (the ICS reader), `tests/bookings.test.ts` (end to end), `tests/bookingsClient.test.tsx` (screens and the public flow; it replaces the planned `bookingsPublic.test.tsx`).

| # | Decision |
| --- | --- |
| D1009 | **Outside busy feeds (§G.1 Q1).** `booking_feeds` per person (at most 5): the ICS URL sealed with the agent-secrets AES-256-GCM envelope (`server/agents/secrets.ts`, `sealSecret`/`openSecret` with an explicit key) under a key derived by HKDF from `AGENT_SECRETS_KEY` when set, else from the workspace key in DATA_DIR. Without `AGENT_SECRETS_KEY` the seal protects a copied database file but not a copied DATA_DIR backup (documented trade-off; no new cipher code, so `tests/vaultGuard` is unchanged). Reads return `host/…last4` only. `webcal://` is read as `https://`. |
| D1010 | **Feed refresh**: through `egressFetch` (https, private addresses refused unless `AGENT_ALLOWED_PRIVATE_HOSTS` lists them, no redirects, 2 MiB, 10 s), on a `bookings.feed_refresh` schedule every 30 minutes and on demand before slots when the cache is older than 5 minutes (waits at most 4 s, then uses the cache). The cache keeps `[start, end, allDay]` only for −1 to +400 days, at most 5000 intervals (no titles, T575). |
| D1011 | **ICS reader** (`icsParse.ts`): DTSTART/DTEND/DURATION in UTC, TZID (IANA, the common Windows names Outlook writes, `/mozilla.org/…/Zone` prefixes), floating (the calendar's `X-WR-TIMEZONE`, else the host's zone) and VALUE=DATE; RRULE FREQ/INTERVAL/COUNT/UNTIL/BYDAY (weekly, daily-with-BYDAY as weekly, monthly `2TU`/`-1FR`), EXDATE, RECURRENCE-ID overrides; CANCELLED and TRANSPARENT are free. Expansion reuses the calendar's DST-correct `expandSeries` in the event's zone; a rule it cannot read keeps its first instance (counted as `unsupported`). All-day busy counts only when the type includes all-day events. |
| D1012 | **Buffers between bookings**: a slot is refused when its buffered window overlaps a held booking, or its own time overlaps the held booking's buffered window, so the gap between two bookings is the larger of the two buffers (Calendly's behavior). Slots step by the interval in wall-clock time from each range's start, so 09:00, 09:30… stay on the clock across DST; a wall time a spring-forward gap skips is not offered; in the fall-back hour each wall time is offered once (the earlier instant, `zonedToUtc`). `24:00` ends a range at midnight. Daily/weekly limits count this type's live bookings per local date / Monday week in the schedule's zone. |
| D1013 | **Busy calendars**: the type's own choice for its owner, else the person's profile choice (`booking_profiles.busy_calendar_ids_json`), else every calendar they own. Events made for bookings are never counted as busy (the bookings count, with their buffers). |
| D1014 | **Prep cards after commit**: Tasks' `createCard` is async (board lock), so the card is made right after the booking commits (`makePrepCard`, also on approval); a failure is logged and never undoes the booking. Card, contact, and event links are `work_links` rows written as `system`. |
| D1015 | **Bookings outlive their type**: `bookings.type_id` is SET NULL when a binned type is purged and `type_title` keeps its name ("deleted type"); a purge also removes the type's question sets, public links, schedules, grants, and activity (107's triggers). |
| D1016 | **Search**: FTS5 `bookings_fts` (booker name, email, type title; unicode61, diacritics removed) with the T583 predicate before LIMIT; booking types by title among readable types. |
| D1017 | **ICS in mail is a link, not an attachment**: the mail transport has no attachments (no foundation hook), so booker mail carries "Add to calendar" → `GET /api/public/bookings/manage/:token/ics` and the manage link. Follow-up for W3/core: an `attachments` field on `RenderedMail`. |
| D1018 | **Manage links**: a fresh `booking_manage` token per mail that needs one (confirmation, approval, reschedule, each reminder), all expiring at the booking's end; reschedule revokes the old booking's tokens. Manage actions take the page's signed nonce and a honeypot like the booking form (1 s minimum). |
| D1019 | **Concurrency (D1001 as built)**: the slot is recomputed inside `db.transaction(...).immediate()` (one writer; feeds are refreshed before the transaction, so it never awaits); the partial unique index `bookings_host_slot` is the backstop. A secret link's use is counted in the same transaction, so a single-use link books once. |
| D1020 | **Reminders**: up to three offsets per type, one schedule each (`bookings.remind_1..3`, owner `booking`), because a schedule is unique per owner and purpose and a handler cannot re-arm itself; plus `bookings.complete` at the end and `bookings.pending_expire` at `min(created + pending_hours, start)`. Reminders later than 6 h are skipped. |
| D1021 | **HTTP paths**: a booking is `/api/bookings/b/:id` (not `/api/bookings/:id`, which would shadow `/profile`, `/types`, …) and the app's `/bookings/b/<shortid>`; types are `/bookings/types/<slug>-<shortid>` (friendly, D825; any of id, short id, or segment resolves). Extra routes: `/api/bookings/feeds…`, `/api/bookings/contact-books` (books the caller can edit, for the type editor), `/api/bookings/types/:id/embed` (a public, active type's card for any member; otherwise readers only), `/api/bookings/insights`, `/api/bookings/b/:id/slots` (reschedule picker), `POST /api/bookings/profile/:userId/reset-handle` (admins, T579). |
| D1022 | **Who may act**: hosts and co-hosts act on a booking; type managers too; the member who booked internally reads it and may cancel or reschedule as the booker. Hosts, assignment, target calendar, contact book, card template, and public/visibility are owner-or-manager changes; editors change the rest. Guests get 404 on every Bookings route and cannot be hosts (§G.1 Q8). |
| D1023 | **Public page meta**: workspace name = APP_NAME (there is no separate workspace name yet); pages and JSON 404 uniformly for an unknown or disabled handle, a hidden, unlisted, or binned type, policy off, and bad tokens. Slots are cached 30 s per type revision, window, zone, and duration. |
| D1024 | **Intake**: the type's question set (host kind `booking_type`, audience public, published on create as an empty set) answered through `submitResponse` with the booking as the response's subject; answers go into the event description as plain text (T580). Name and email are fixed fields before the questions. |
| D1025 | **Embeds and `/`**: the "Booking link" embed renders the type's public card (Book a time) for any member when the type is public and active; the `/` item embeds the caller's first active public type (a picker is a W3 follow-up). |
| D1027 | **MCP names follow the repo's tool rules**: no tool name says delete, approve, or apply (tests/mcpRules, tests/mcpInbox), so §D.6's `delete_booking_type` is `bin_booking_type` (with `restore_booking_type`, both + `bin:write`) and `approve_booking` is `confirm_booking_request`. Dropdowns use the shared `Select` (D91) through `src/bookings/FieldSelect.tsx`; the time zone in the slot picker (public pages too) is a searchable text field over every IANA zone (a datalist). |
| D1028 | **Shared follow-ups made in this lane** (small, outside its folders): `registerTodayRenderer` now slots a module's section after the last section of its group (it appended to the end, against its own comment), and the foundation's tests that assumed every workspace module is a stub now ignore ready modules' Settings rows, launcher tiles, Today sections, quick actions, slash items, and the Settings → Workspace hub entry (D836); `tests/toolResourcePolicy` resets the MCP buckets per call (with every module's Bin tools the per-user Bin burst ran out). |
| D1026 | **Insights** run the Insights tab's preset queries through `runDatasetQuery` on `bookings.bookings` (status counts, per week, per type with minutes, per host, average lead time), so they match what Reports will see. |
| D1029 | **Secret links pause with their owner** (audit fix): `/p/book/link/<token>` 404s exactly like `/p/book/<handle>` when the owner is blocked or no longer a member or admin, or has switched their booking profile off; `hostPlans` no longer falls back to a blocked owner for a single type, so such a type has no slots and `createBooking` finds no host. Links are kept, not revoked, on block, so an unblock resumes them (the way MCP keys and feeds pause, O9). |

Threats as built: T575 (slots only; 31-day public windows; page limit; no titles in the feed cache), T576 (D1019), T577 (per-email upcoming cap 3/type, per-type hourly cap `hourly_cap` default 20, outside-mail caps, verification option, honeypot, 5 s fill time, single-use nonce), T578 (`no-referrer` on public pages and links, tokens in the path on our origin, one booking per token, expiry at its end, revoked on reschedule), T579 (reserved handles, admin reset), T580 (plain-text answers), T581 (UTC server math), T582 (warning when the target calendar is shared; default the owner's first calendar), T583 (`readableBookingSql`), **T584** feed URL leakage (sealed, hint only, never logged), **T585** SSRF through a feed URL (egress guard per fetch, private ranges refused, no redirects), **T586** a hostile or huge ICS (2 MiB, 5000 events/intervals, bounded expansion, parse errors ignored), **T587** manage-page CSRF/replay (signed single-use nonce), **T588** a single-use secret link booked twice (use counted in the booking's transaction).

Not done in this lane: Google OAuth sync (out of scope, §G.1); ICS attached to mail (D1017); a picker for the `/` booking-link item; email verification is covered by the foundation's tests and wired here, but not walked in the browser (it needs a mail round trip with a code).

### D.7 Townhall (lane TOWNHALL, module `townhall`)

All-hands and AMA sessions in the Slido / Mentimeter / Pigeonhole space (§G.1): questions before and during the meeting, upvotes, replies, moderation, live polls, a presenter view, an audience link, and a recap. Migration **115** (116–117 unused), decisions **D1070–D1099**, threats **T610–T619**, scopes `townhall:read` / `townhall:write`, routes `/townhall`, `/townhall/insights`, `/townhall/<slug>-<shortid>` (`?tab=polls|recap`, `?filter=review`, `?q=<question>`), `/townhall/<slug>-<shortid>/present`, and the public `/p/t/<token>`. Port 2217, origin `townhall.localhost:2217` (the brief's, not §G.1's 2223).

**Model (115):** `townhall_sessions` (the `townhall_session` container: owner, visibility default `all_users`, share_role default `view`, short id, Bin columns, revision; state `upcoming` → `live` → `ended`; settings: take questions, anonymous allowed, `moderation` `off|review`, replies, reminder minutes; `pinned_question_id`, `active_poll_id` (what the presenter shows), `event_id`, `public_token_seed`, `recap_note_id`, `went_live_at`, `ended_at`), `townhall_questions` (≤ 500 characters; `author_id` only when named; `author_label` for a public participant's name; `asker_hash`; status `pending|approved|answered|hidden`; `starred`; `merged_into`; `vote_count`; `card_id`; `via` web/mcp/rest/agent/public), `townhall_votes` (question, `voter_hash`), `townhall_polls` (kind `single|multi|word_cloud|rating|open_text`, status `draft|live|closed`, `results_hidden`, the question id in the session's question set), `townhall_attendance` (members by user id, public participants by hash). Purge triggers clear grants, members, key grants, links, activity, comments, schedules, public links, question sets and responses.

**HTTP** (all under `/api/townhall`, errors `{ error, code }`):

| Method | Path | Notes |
| --- | --- | --- |
| GET / POST | `/sessions` | list (`state`, `q`, `cursor`, live first) / create |
| GET / PATCH / DELETE | `/sessions/:id` | the whole live state for the caller / settings (`expectedRevision` → 409 `CONFLICT`) / to the Bin (owner, manager) |
| GET | `/sessions/:id/live` | SSE: `event: state` (the same JSON as GET), `event: gone` |
| POST | `/sessions/:id/state` | `{ state: "live" \| "ended" }` (hosts) |
| PUT | `/sessions/:id/public-link` | `{ enabled }` (hosts; 403 `POLICY_OFF`) → `{ publicUrl }` |
| PUT | `/sessions/:id/screen` | `{ pollId \| null }`: what the presenter shows |
| POST | `/sessions/:id/questions` | `{ text, anonymous? }` (guests and viewers too) |
| PUT / DELETE | `/questions/:qid/vote`, `/questions/:qid` | `{ upvote }` set-state / withdraw one's own |
| POST | `/questions/:qid/moderate` | `{ action, targetId? }`: approve, hide, unhide, answered, reopen, pin, unpin, star, unstar, merge |
| POST | `/sessions/:id/polls`, `/polls/:pid/launch`, `/close`, `/vote`; PATCH, DELETE `/polls/:pid` | polls (vote: `{ optionIds }`, `{ rating }`, `{ text }`) |
| GET | `/sessions/:id/recap?format=markdown\|csv` | JSON recap, or the files |
| POST | `/sessions/:id/recap/note`, `/sessions/:id/cards` | post the recap as a note; `{ boardId, columnId, questionIds }` → cards |
| GET / POST | `/api/public/townhall/:token`, `…/live?p=`, `…/questions`, `…/questions/:qid/vote`, `…/questions/:qid/withdraw`, `…/polls/:pid/vote` | the audience link |

Comments use the foundation's `/api/items/townhall_question/:id/comments`; sharing the generic `/api/access/townhall_session/:id`.

**MCP** (D1082): `list_townhall_sessions`, `get_townhall_session`, `create_townhall_session`, `ask_townhall_question`, `upvote_townhall_question`, `moderate_townhall_question`, `launch_townhall_poll`, `close_townhall_poll`, `export_townhall_recap` (json, markdown, csv). Chat agents get the three reads; the writes are never offered to agents.

**Registrations:** access container, item kinds (`townhall_session`, `townhall_question` → its session), work kinds (both), Bin (`townhall_session`), schedule `townhall.remind`, Today `townhallLive`, search scope `townhall`, datasets `townhall.questions` and `townhall.attendance`, read-only writes (ask, vote, withdraw, poll vote), notification topics `townhall.live`, `townhall.answered`, `townhall.review`, `townhall.reminder`, quick action "New townhall", launcher tile, public page `/p/t/`.

#### Decisions as built (lane TOWNHALL, branch `lane-townhall`)

| # | Decision |
| --- | --- |
| D1070 | **One module, one container.** A session is the `townhall_session` container (§B.9); questions, polls, votes, and attendance hang off it and are never shared on their own. New sessions are open to everyone signed in at `view` (an all-hands is for everyone); hosts narrow it in the Access sheet. |
| D1071 | **Taking part is not access** (§B.9): anyone who can open a session asks, upvotes, votes, withdraws their own question, and (with replies on) replies; guests and viewers too, through registered read-only writes (D817). Hosts are editors (`edit` and up with a writing role): they moderate, run polls, go live and end, and make the audience link. Managers and the owner also share and bin. A question's work-kind level is the session's, raised to `comment` while replies are on, so the foundation's item comments work unchanged. |
| D1072 | **Moderation** is one service call per action (approve, hide/unhide, answered/reopen, pin/unpin, star/unstar, merge). Review mode holds questions as `pending` (hosts' own skip it); pending ones are the hosts' and the asker's only, hidden ones the hosts'. Pinning approves; answering or hiding unpins; merging moves the duplicate's voters into the target (one vote per voter), re-points earlier merges, and the duplicate disappears ("1 merged" on the target). Stars are visible to hosts only. |
| D1073 | **Votes and anonymity are hashes.** Upvotes, poll answers, "my questions", and attendance are keyed hashes (`server/public/secret.ts` `keyedHash`) of the session and the person (user id or public participant), so nobody, hosts and admins included, can list who upvoted or voted, and an anonymous question stores no author id at all. The cost: an anonymous asker gets no "answered" notification (there is nobody to address). |
| D1074 | **Polls run on the question engine** (§B.2): each poll is one question of the session's question set (single/multi choice, rating 1–5 stars, short text for word clouds ≤ 25 characters, long text for open answers), published as a new version when added or deleted; each vote is an anonymous engine response with `subject = townhall_poll:<id>` and the D1073 hash as its dedupe hash (one answer per person, changed by `updateResponse`; a word cloud takes up to three). Results are read with SQL over `response_answers` per poll (the engine's `summarize` aggregates a whole set). One poll is live at a time; launching closes the previous one. A host may hide results until the poll closes. |
| D1075 | **Live updates by server-sent events.** Writes wake an in-process hub after they commit (`server/townhall/live.ts`; one replica, as the rest of Nook); each open stream re-reads the state for its own viewer (access, "mine", "voted") at most every 400 ms and sends it whole as `event: state`, plus a ping every 15 s and an access re-check every 15 s (`event: gone` when it is lost). The client (`useLiveState`) falls back to polling `GET …/sessions/:id` every 5 s when a stream will not stay open. Caps: 8 streams per person, 300 per address (a room behind one NAT), 3000 per session. |
| D1076 | **The audience link is re-derivable.** It is a `public_links` row of kind `townhall_session` (hash only, uniform 404, the public-pages policy, on by default), but its token is an HMAC of the session id and a random seed under the workspace key (`server/townhall/seal.ts`), so hosts can show the same link and QR code again (presenter, a second device). Only the seed is stored; turning the link off revokes the row and clears the seed, so the old token never opens again. (A sealed-token design was dropped: the vault guard keeps ciphers to the vault.) The row is written directly with `tokenHash` because `createPublicLink` always draws its own token. |
| D1077 | **Public participants** get a signed participant token (`signedToken("townhall-participant", "<session>:<random>")`) on their first visit, kept in the page's localStorage per link; it keys their hashes. Asking passes the shared `checkSubmission` (nonce single use, honeypot, 1.5 s minimum fill, per-address limits) and the per-link hourly cap; each answer returns a fresh nonce. Upvotes and poll votes skip the nonce but have their own buckets: 60 a minute per participant and 1200 a minute per address. A participant asks with a name (shown as given) or, where allowed, anonymously. The public state omits owner ids, the linked event, and the recap note. |
| D1078 | **Session lifecycle:** upcoming → live → ended, and Reopen (ended → live). Going live notifies named askers and members; ending closes the live poll and clears the pinned question and the screen. An ended session takes no questions, votes, or poll answers. Questions can be closed separately ("Take questions" off). |
| D1079 | **Recap:** totals (participants: members and audience-link participants; questions, upvotes, answered, still open), the answered and open questions (top first), and every launched poll's results; downloads as Markdown and as a formula-safe CSV of the questions (T514's rule); **Post as a note** makes a draft note of the host's (`createDraftNote`) linked to the session (`relates`), which they review and publish. |
| D1080 | **Questions → cards:** hosts pick open questions in the recap (up to 50 at a time) and a board and column they can edit; each becomes a card through the Tasks service (`createCard`, so WIP limits and access apply), titled by the question, with a link back, recorded as a `source` work link (card ← question) and item activity. A question that already has a card keeps it (idempotent). |
| D1081 | **Reminders** use the schedules engine: `townhall.remind` once, `reminder_minutes` (default 15, 0 = none) before `starts_at`, re-planned on every settings change and cancelled when the session goes live, ends, or is binned; skipped when more than 30 minutes late. It notifies the host, named askers, and the session's members (push and the bell; no email template in v1). |
| D1082 | **MCP** follows §B.15: `list_*` (list mode, chosen-session keys narrow before LIMIT), `get_*`/`ask`/`launch`/`close`/`export` name the session as an item, `upvote`/`moderate` name the question (anchored on its session). Sessions accept id, short id, or URL segment. `ask_townhall_question` records `via` mcp or rest. A writing key for a chosen session needs edit on it (the foundation's `containerReachable`), so members who only take part use a whole-module `townhall:write` key. |
| D1083 | **Calendar link:** a session may name a calendar event the host can read (`event_id`); its start fills `starts_at` when none is set. Readers see the event chip only when they can read the event themselves. |
| D1084 | **Shared widget additions (W1-UI files, additive):** `QaList` gained optional `onOpen` (replies), `onWithdraw`, `askNote`, `emptyText`, and `starred`/`commentCount`/`mergedCount` on a question plus `star`/`unstar`/`reopen` moderation items; existing callers render exactly as before. The presenter, polls, word clouds, and ratings are the W1-UI components unchanged (open text, which has no shared widget, is a small module view in the same `ui-live` classes). |
| D1085 | **Access sheet for a workspace kind:** `src/access` learned `townhall_session` (its path is the generic `/api/access/:kind/:id`, its level lines and noun), the first workspace container to use the shared Access sheet. Other lanes add theirs the same way. |
| D1086 | **Tests that pinned "no module is ready":** the foundation tests that listed exact module, Settings, launcher, and Today-section sets now include Townhall (Settings → Workspace appears once a module ships, D836); the Today group-order test checks built-in sections and lets module sections slot into their group. |
| D1087 | **Search, Today, Insights:** search matches session titles (the readable predicate before LIMIT; no FTS table in v1: sessions are few, and question text is not searchable outside the session). Today's `townhallLive` lists live sessions and those starting within 24 hours. Insights (90 days): questions, % answered, % anonymous, people who joined, questions per week and per session, from the two datasets (each viewer's own access, D826). |
| D1088 | **Participants and attendance on the audience link** (audit fix, T611): a page load without a token mints a participant only while its address has minted fewer than 60 for the session in 10 minutes; past that it gets the address's most recent token again, so scripted reloads cannot mint voters (a room of more than 60 new people behind one address in 10 minutes shares the last token: accepted). Attendance counts a public participant only when they ask, vote, or withdraw, keep the live stream open 30 s, or come back with a token at least 30 s old; a bare page load counts nobody. Tokens now carry their issue time (older tokens read as issued long ago). |

**Threats:**

| # | Threat | Mitigation |
| --- | --- | --- |
| T610 | Deanonymizing an anonymous asker or a voter (hosts, admins, a database reader) | No author id for anonymous questions; votes, poll answers, and attendance are keyed hashes (D1073); exports and MCP show "Anonymous"; audit rows carry ids only, never question text. A reader of both the database and `workspace.key` could test guesses (accepted, as for D843). |
| T611 | Public abuse: spam questions, vote stuffing, a room behind one NAT | Asking: nonce, honeypot, fill time, per-address and per-link limits (D1077); votes: per-participant and per-address buckets; one vote per participant hash; hosts hide and review mode holds questions; turning the link off stops it at once; question length and per-session caps. A participant can mint new tokens by clearing storage (more votes from one browser), bounded by the address bucket; accepted for v1. |
| T612 | Audience link leakage or reuse after it is turned off | 43-character token, hash lookup, uniform 404, policy off → 404; revoking deletes the seed so the token cannot be re-derived (D1076); only hosts see it; `no-referrer`, `noindex`, `no-store`. |
| T613 | Reading what one may not: pending/hidden questions, results hidden until close, draft polls, the session itself | Every read builds the state per viewer: pending only for hosts and the asker, hidden and drafts only for hosts, hidden results return `counts: null`; unreadable sessions and questions are NOT_FOUND (T90); chosen-item keys reach only their sessions (T203). |
| T614 | Live streams as a DoS (open many SSE connections) | Per-person, per-address, and per-session stream caps (429), coalesced pushes, idle pings, access re-check on every push and every 15 s (D1075). |
| T615 | Names shown to outsiders | Asking by name shows the name to everyone who can open the session, the audience link included; the ask box says so ("Your name shows unless you ask anonymously"); members who mind ask anonymously when allowed. The public state carries no user ids. |
| T616 | Moderation through MCP or agents beyond the person's rights | `moderate`/`launch`/`close` require host level at call time; agents are never offered writes; via and audit recorded. |
| T617 | Questions → cards leaking session content to a board's readers | Only hosts, only to boards and columns they can edit, one card per question, through the Tasks service's own checks; the card says where it came from. |
| T618 | CSV/Markdown export injection | CSV cells neutralized (T514); Markdown escapes the question text. |
| T619 | Notification `href` or body injection | Hrefs built server-side from the session's path (T509); bodies are the question text clipped to 200 characters, rendered as text. |

**Acceptance (browser, headless Chrome, `townhall.localhost:2217`):** create a session from the sheet; two members and the host on one session: ask, upvote, see it live in the other tab; go live; star, pin (presenter switches live), merge a duplicate, reply under a question; launch a poll from Polls, vote from the second person, results on the presenter live; word cloud; audience link from the Invite sheet, an outsider asks and upvotes at 390 px; end, recap, open question → card, post as a note; Insights. Screenshots at 1585, 1280, 375/390.
**Acceptance (MCP):** over `/mcp` and REST v1 with keys made through `POST /api/keys`: tools/list by scope, list, get, create, ask (review → pending), moderate refused for a member and allowed for the host, upvote (REST), launch and close a poll, export markdown and CSV, a read key cannot ask, a one-session key lists only it and gets NOT_FOUND elsewhere.
**Tests:** `tests/townhall.test.ts` (sessions and access, questions, review and moderation, merge, comments, ended sessions, all five poll kinds, the audience link with nonce/replay/forged participant/revocation, recap and exports, cards, notes, MCP scopes and chosen-item keys, Bin and purge orphans, Today, search, datasets, reminders, the SSE stream), `tests/townhallClient.test.tsx` (routes, poll views, QaList additions).
**Not in v1:** email for reminders (push and the bell only); a note/card embed of a session (`EMBED_KINDS` has the word; no renderer yet); an Inbox proposal kind `townhall_question` (agents only read); question search outside a session; answering a question with text (hosts answer live and mark it answered; replies carry follow-ups).

### D.8 Wave 3: wiring (W3-WIRE) and workspace data in Reports (W3-REPORTS)

**W3-WIRE** (migrations **110–112**, decisions **D1040–D1059**, threats **T595–T599**): flows marked W3 in §C:
- C3 form → deal; C5 check-in `goal_update` questions; C6 time in check-in prefill; C15/C20 CRM record panels for Time (entries, start timer) and Bookings (list, "Send booking link" with prefilled hidden fields); C21 respondents on contact timelines; C22 card dialog **Goal** field and board header goal chip (card slot), card face goal badge (setting); C23 round → note append; Collections editors for `person`/`contact` field types (D961); Team page "Book time with …" button; Today quick actions final ordering; digest sections; `scope=all` search ranking polish; AI eval script `scripts/workspaceAgentEval.ts` (scripted provider: an agent logs time from a summary, checks in on a goal, updates a deal, answers a standup, all as proposals); docs (USING sections, site "Using Nook" sections per module, API_CONTRACTS, THREAT_MODEL, TEST_PLAN entries); `tests/docsSite.test.ts` passing with six new modules.
- Migration 110 `wiring` only if needed (e.g. `goals_on_boards` cached chip column); 111–112 spare.

#### Decisions as built (W3-WIRE, branch `w3-wire`)

Cross-module code lives in `server/wiring/` (`index.ts`, imported once by `server/workspaceModules.ts` after the seven modules; `tasksCrm.ts`, `tasksGoals.ts`, `standupGoals.ts`, `proposals.ts`) and in the generic hooks below; each module's own half stays in its folder. Migration 112 (`bookings_contact_index`) only; 110–111 unused. Built in four lanes on one branch (the parent and three forks: access, mail, UI), merged in order.

| # | Decision |
| --- | --- |
| D1040 | **A card-change hook, after commit.** `server/tasks/cardEvents.ts` (`onCardChange`, `reportCardChange`): `recordCardActivity` reports every entry it writes or folds (two lines in `server/tasks/activity.ts`), and listeners get the batch in a microtask, after the synchronous transaction that wrote it. Entries whose `card_activity` row is gone (a rolled-back or refused change) are dropped, so a refused change reports nothing. Events carry ids and the activity kind only; listeners re-read what they need, run as Nook, and check access themselves; a throwing listener is logged and skipped. Tasks never listens and writes exactly as before. |
| D1041 | **Task done on contacts and deals (C17).** A card linked to contacts, companies, or deals (`work_links` either way, e.g. Contacts' Create task) that lands in a done column logs one `task` interaction "Task done" per book, naming those records, as the person who finished it when they may edit the book, else the link's creator if they still may; otherwise nothing. Body is plain text, never the card's title (T595); the card is in the record's Linked work. Idempotent per card and book (`source = 'task'`, `source_ref = <card>:<book>`). |
| D1042 | **Goal auto-progress from the hook (C7).** A change on a board marks the `tasks` KRs that can count its cards (scope board, sprint, tag, or epic on it; every `view` and `filter` KR, which can span boards) and recomputes them in one batch 5 s after the first change (`CARD_GOAL_DEBOUNCE_MS`, at most 200 a run, `refreshAutoKrs(force)` as each KR's owner, T540). Goals' 5-minute sweep (D908) stays as the fallback for missed events, restarts, and non-task sources. |
| D1043 | **Standup goal updates (C5).** An answer may carry `goalUpdates: [{ goalId, values: { <krId>: number }, health?, confidence? }]` (≤ 10) beside a `goal_update` question; `registerStandupGoalUpdater` (Goals' side in `server/wiring/standupGoals.ts`) writes one goal check-in per goal through Goals' `checkIn` as the participant, inside the answer's transaction: a goal they cannot edit (T542), a KR of another goal, or a standup with no goal update question fails the whole answer with that reason. The note is the question's text plus "From the standup …"; health stays the goal's unless chosen; the answer gets a `relates` link to the goal. `GET /api/goals/checkin-targets` lists the person's open goals they can edit (owner, contributor, KR owner) with KRs; the answer sheet shows number fields for manual KRs (`src/checkins/GoalUpdates.tsx`). Anonymous standups refuse goal updates. `answer_checkin` takes `goalUpdates` and then needs a key with `goals:write` on the whole module (T596); the `checkin_answer` proposal keeps them. |
| D1044 | **Round digest → note (C23).** Standup summary options gain `noteId` (in `summary_json`, no migration), set by an editor of the standup who can edit the note. When a round closes (manual or scheduled), after the transaction, the round is appended to the note as the standup's owner, who must still edit it: date heading, the summary line, and for named standups without private answers each person's answers as plain text (Markdown block syntax escaped); anonymous and private-answer standups append the summary line only; blockers are counted, never named (T596). No draft: published as the next version. A draft open: appended to the draft and the owner is notified, so nobody's unsaved text is published. Once per round (`summary_posted` activity). Settings → Round summaries → "Post rounds to a note" picks one of your notes. |
| D1045 | **Forms → deals (C3) and the contact timeline (C21).** The `create_deal` response action: a book (edit), an optional pipeline and open stage of it, a title template, and a number question read in major units of the pipeline's (else book's) currency; the respondent is upserted by email (as `save_contact`) and becomes the deal's contact; linked deal → response (`source`). A retried run finds its deal (one per response and book). `save_contact` and `create_deal` each log a `form` interaction "Form response" (plain text, no form title, T595) once per record and response. `GET /api/forms/targets` lists each book's pipelines and open stages. |
| D1046 | **Time in standup prefill (C6).** "What did you do" suggestions add cards the person logged time on since their last answer (`time_entries.target_kind = 'card'`), also returned as `timeCards`. |
| D1047 | **Agent proposal kinds.** `contact_create` (`create_contact`), `contact_update` (`update_contact`), `deal_create` (`create_deal`), `deal_update` (`update_deal`), `interaction_log` (`log_interaction`), `goal_checkin` (`check_in_goal`), `form_create` (`create_form`), `townhall_question` (`ask_townhall_question`), each made from its tool by `server/inbox/toolProposals.ts` (`toolProposalKind`): the tool's schema validates at submit as the key's owner, who must read the target (NOT_FOUND otherwise); the tool's handler applies as the approver; the suggesting key must still exist. Chosen-item keys reach them through the target field (book, contact, deal, goal, session); `interaction_log` and `form_create` have none and refuse chosen-item keys (fail closed). Those tools moved from "never" to "offered" in their modules' agent lists; merges, bulk writes, upserts, companies, follow-ups, moderation, and Bin tools stay never offered. |
| D1048 | **Board goal chip (C22).** A generic board header slot (`registerBoardHeaderItem` in `src/ui/cardSlots.ts`, `BoardHeaderItemsOutlet`, `boardHeaderItems` on a client module; one line in `BoardView.tsx`); Goals registers a chip with the goal(s) the board contributes to (a `contributes` link from the board, `GET /api/goals/for-item`), its health and progress, linking to the goal; nothing when there are none. Phones show the icon and percentage only (44 px). The card dialog's Goals section (D918) is the card-level field. |
| D1049 | **Not built here** (left for a later wave): the AI eval script `scripts/workspaceAgentEval.ts` and its real-model run; Collections editors for `person`/`contact` fields (D961); the Team page "Book time with …" button; docs site "Using Nook" sections for the seven modules; card face goal badge (one request per card); a time-entry hook for the `time` KR source (the sweep keeps it fresh). |
| D1050 | **One Access sheet for every workspace container.** `src/access/accessLevels.ts` `WORKSPACE_ACCESS` has one row per container kind (form, time_project, goal, checkin, contact_book, booking_type, townhall_session): the kind's word, one line per level, an optional private hint (a standup's participants and a goal's contributors read it anyway) and starting level (time projects add people at Can edit). `accessPath` sends every workspace kind to `/api/access/:kind/:id`; other kinds are unchanged. Modules use `src/access/WorkspaceAccess.tsx` (a summary line plus "Change who has access") or open `AccessSheet` from a menu (Goals, Townhall). |
| D1051 | **Module sharing panels removed** where the sheet covers them: Forms' "Who sees results" editor (D861), Contacts' Who has access (D984; groups now editable), Standups' Participants/Everyone switch (D949), the goal editor's presets for existing goals (D917; new goals still start from a preset), and Time's member levels, add, and remove (D891). Booking types gain the control in their Sharing section. Each module keeps what is not access (§B.9): who answers a form, who takes part in a standup, contributors, hosts, public and secret links. |
| D1052 | **Time keeps its rates.** The sheet has no rates, so a project's "Team and rates" tab keeps a read-only member list with a level chip and the managers' rate fields under the shared control; levels change only in the sheet. |
| D1053 | **Mail attachments.** `MailMessage.attachments` / `RenderedMail.attachments`: `text/calendar` only (optional `charset=utf-8` and `method=PUBLISH\|REQUEST\|CANCEL`), a plain `.ics` file name, at most 3 files and 256 KiB, checked in `sendMail` before any limit (a refused one fails without retry, `attachment_<reason>`). Templates build them at send time from re-read data, so the outbox never stores them; every transport (Resend, the file transport, the test hook) carries them. `server/mail/ics.ts` writes one UTC VEVENT (no ORGANIZER/ATTENDEE) with escaped TEXT and 75-octet folding. Replaces D1017's link-only mail. |
| D1054 | **Calendar files in module mail.** Bookings confirmation and new-time mail attach `booking.ics` (the "Add to calendar" link stays); its UID is the first booking of the reschedule chain and SEQUENCE the number of moves, so calendars update in place; the manage page download is the same file. A finalized time poll's outside voters get `invite.ics` with a keyed-hash UID (supersedes D855's "no ICS in v1"). Reminder, cancel, and decline mail attach nothing (a cancel file sharing the chain's UID could cancel the new booking). |
| D1055 | **Reminders.** Townhall reminders (D1081) also go by email (`townhall.reminder`, category `townhall`) to the members they notify, never to audience-link participants; the session is re-read at send time. Goal check-in reminders fire Monday 09:00 in the owner's zone (the email settings zone, else the Standups browser zone, else Time's, else UTC; a stored UTC counts as unset), re-armed on goal writes and by the reminder itself when the zone changed (that one fire stays at the old time). The schedules dispatcher now advances from the schedule's stored rule and zone after a handler, so a handler's re-arm is kept. Supersedes D909's UTC. |
| D1056 | **Item sections.** `src/ui/itemSlots.ts` (`registerItemSection`) and `ItemSectionsOutlet`: the card-slot pattern (D834) for workspace item pages; a section names its module, hides while that module is off, and is dropped if it throws. Declared with `itemSections` on a client module. Time adds "Time" to goals, contacts, companies, deals, and bookings; Bookings adds "Bookings" to contacts, companies, and deals. |
| D1057 | **Time on CRM records and goals (C15, item 4).** The card's Time section is now the generic `ItemTimePanel` (total, Start/Stop, Log time, worklog) over `GET /api/time/targets/:kind/:id`; cards keep their markup. A timer or entry on a contact, company, deal, or booking with no project goes to that record's client project (the company it is or belongs to, then the first live project of that client the person may log on), else it is personal time. The `time` KR source (C8) is tested end to end with Goals (KR from project hours, refused for an owner who cannot read the project). |
| D1058 | **Bookings on CRM records (C20).** `GET /api/bookings/for/:kind/:id` (contact, company's contacts, deal's contacts; by `bookings.contact_id`, migration 112 index), newest first, ≤ 20; the viewer must read the record and each booking (T583). "Send booking link" copies one of your active public types' links prefilled with `?name=&email=` only (`shared/bookings.ts`); the public page fills the two fields. Company and deal pages copy it without prefill. |
| D1059 | **`/` pickers, goal and townhall embeds, Today's quiet line.** The `/` items Goal, Townhall, and Booking link open a small picker of your goals, sessions, or active public types (`src/ui/embeds/EmbedPicker.tsx`) and insert the embed with its neutral word (T513), replacing D1025's first type. The goal embed shows progress, health, and three KRs; the townhall embed shows state, start, and question count with Join / Ask / Open, refreshed every 20 s; both are fetched as the reader. Today's folded quiet line is a text block, so it wraps as one sentence at 1280 px; row heights are unchanged. |
| D1059a | **Card changes and spanning KRs** (audit fix to D1042): a card change recomputes a `view` or `filter` tasks KR only when the person it counts as (the KR's owner, else the goal's) can read one of the changed boards, and without `force`, so Goals' 60-second debounce holds: a busy board no longer recomputes up to 200 spanning KRs on every change. Board, sprint, tag, and epic KRs of the changed boards are still forced at once. |
| D1059b | **A standup answer's goal check-in is keyed by the answer** (audit fix to D1043; migration **111**): `goal_checkins.source_ref` (unique per goal) holds the response id of the answer that wrote it, and `checkIn({ sourceRef })` updates that check-in in place (values, health, note) when the answer is edited or retried: no second check-in, activity entry, or notification; a real health change still notifies. A goal dropped from an edited answer keeps its check-in. Check-ins made in Goals have no `source_ref`. |
| D1059c | **A folded card change reports a fresh id** (audit fix to D1040): when `recordCardActivity` folds a change into the card's latest entry, the entry is rewritten under a new id (same card, actor, kind; merged payload and new time) and that id is reported, so a rolled-back fold leaves no row with it and listeners hear nothing; before, it reported the existing entry's id, which survived the rollback. A change that folds back to nothing deletes the entry and reports nothing. |
| D1059d | **A contact update proposal shows every field as it is now** (audit fix to D1047): the preview's `before` is read through `getContact` as the viewer for every field the update can change (name, first and last name, email and phone with the contact's other addresses and numbers, job title, company, lifecycle, location, tags), not only four. |

**Threats (W3-WIRE):**

| # | Threat | Mitigation |
| --- | --- | --- |
| T595 | An automatic interaction (Task done, Form response) tells a book's readers what they could not read (a card or form title) | Fixed plain-text titles and bodies; the card and response are only work links, which redact for non-readers (T501); written as someone who may edit the book, else not at all. |
| T596 | Standup wiring writes or shows more than the person may (goal check-ins on goals they cannot edit; a key limited to Standups writing goals; a round's answers in a note with a wider audience) | Goal updates go through Goals' `checkIn` as the person (edit level, T542) inside the answer's transaction; `answer_checkin` with goal updates needs a whole-module `goals:write` key; the summary note is set only by a standup editor who can edit the note, written as the owner who must still edit it; private-answer and anonymous standups add only the summary line; blocker cards are never named. |
| T597 | A card-change listener acts on a refused or rolled-back change | Delivered after the transaction; entries whose activity row is gone are dropped; listeners re-read state and check access. (The shared Access sheet needed none: the endpoint and its checks are unchanged.) |
| T598 | Calendar-file injection or abuse through mail attachments | TEXT escaped, control characters dropped, CRLF folding; UID sanitized; URL only when plain http(s); content type and file name from an allowlist; count and size caps; built from re-read data; no internal ids to outside addresses. |
| T599 | A prefilled booking link leaks a contact's details | Only name and email, capped and checked; query strings are never logged; public pages send `no-referrer`; the link is copied by the person, never sent by Nook. |

**W3-REPORTS** (migrations **113–114**, decisions **D1060–D1069**, threats **T600–T609**): Reports data source kind `workspace` ("This workspace", always present for members when any module dataset is registered). `report_datasources.kind` CHECK widened (113, 12-step rebuild); a report query on it stores a structured dataset query (`shared/datasets.ts`) in the query's body with `language: "dataset"`; the generator prompt gets the dataset catalog instead of the ClickHouse schema; the SQL editor becomes a structured query editor for this source; runs use the report owner's access (T600, Q3); schedules/filters/parameters map onto `filters`/`timeRange`. Out: joins across datasets (v1 queries are single-dataset; Q3 asks whether cross-dataset SQL is wanted later).

#### Decisions as built (W3-REPORTS, branch `w3-reports`)

The Q3 answer (§G.1: each **viewer's** own access) overrides the "owner's access" line above.

| # | Decision |
| --- | --- |
| D1060 | **The source is a column on `reports`, not a `report_datasources` row.** Migration 113 adds `reports.source` (`clickhouse` \| `workspace`, default `clickhouse`) and leaves `datasource_id` NULL for workspace reports. The plan's 12-step rebuild of `report_datasources` is unsafe: it is a parent table (`reports` SET NULL, `report_schema_tables` and `agent_datasources` CASCADE) and the transactional migration runner cannot turn foreign keys off, so dropping it fires those actions (checked: the rename trick re-points children and they cascade too). Everywhere else the source reads as data source id `workspace` (`withSource` on report rows, `usableDatasource("workspace")` returns the in-memory `WORKSPACE_ROW`, routes and MCP accept `workspace` beside UUIDs). "This workspace" is listed first in the data source choices for any non-guest whose role can query a dataset; it never appears in admin data source settings. A query's "SQL" is the structured query as JSON (`shared/reportsWorkspace.ts`; SQL never starts with `{`, which is how parameter checks tell them apart): no separate `language` field was needed. |
| D1061 | **Every reader's numbers are their own, computed when they read (Q3).** `GET …/results`, parameter sets (`…?values=`, `param-runs`), select options, MCP `get_report_block`, version views, and "Run with today's data" run the report's structured queries live through the dataset registry as the reader (`liveResults`), with the default or chosen parameter values; the view says `live: true` and the page shows "Live · your access" and "Computed when you opened it, with your access". Owners' Refresh, schedules, generation, and edits still run (as the person starting them) for status, Runs, row counts, errors, and validation. Numbers differ by reader by design; a reader never sees a number computed with someone else's access. |
| D1062 | **No rows are kept for workspace reports.** Triggers from 113 empty `rows_json` of `report_results` and `report_param_results`, and `values_json` of `report_param_options` / `report_param_linked_options`, on insert and update when the report's source is `workspace`, whichever code path wrote them (refresh, edit, generation, duplicate copies). Defence in depth behind D1061; row counts and timings stay. |
| D1063 | **A report does not switch between This workspace and a SQL source while it has queries** (409): structured queries and SQL do not translate. A duplicate of a workspace report is a workspace report. |
| D1064 | **Filters.** Report parameters (D489) map onto structured queries by placeholders as whole values: a date range as `timeRange {from: "{p_from:Date}", to: "{p_to:Date}"}`, a select or multi-select as a filter value (`"{p:Array(String)}"`; All filters nothing), number range ends as `gte`/`lte` (an open end filters nothing); `timeRange.preset` (a relative range on the report's today, in its zone) keeps saved and scheduled queries current. Select options are a structured query's first column, read per reader and never cached. **Add filter** (the AI-driven warehouse column picker) is refused on workspace reports (409; hidden in the UI); Add widget offers "A date filter readers can change", which adds a `period` date range when the report has none. Exclusion (`{not: […]}`, D568) is not offered on workspace reports. |
| D1065 | **AI.** Generation (`systemPrompt` → `workspacePrompt`) and the edit agent get the dataset catalog the owner's role can query and the structured-query rules instead of the ClickHouse sections; the schema tools are removed (`WORKSPACE_GENERATE_TOOLS`, `WORKSPACE_EDIT_TOOLS`) and refuse if called; `run_sql` takes a structured query. The metric catalog extraction, sanity checks, and FINAL notes are ClickHouse-only and skipped. MCP `create_report` / `list_report_datasources` / `list_reports` accept `workspace`. |
| D1066 | **Scheduled runs and sharing.** Schedules run the owner's refresh as before; nothing they store carries rows, and every reader (shared `selected` or `all_users`) gets their own live numbers when they open the report. There is no emailed snapshot in Reports today, so nothing is ever sent computed with the owner's access. |
| D1067 | **Add widget** (`src/reports/WorkspaceWidgetSheet.tsx`): dataset → up to four measures (count of rows or a column's allowed aggregations) → group by, split by, time bucket, time range (relative presets, all time, or the report's date filter) → filters → Show as (number, bar, horizontal bars, line, area, stacked bars, pie, table) → title; Preview (`POST /api/reports/:id/workspace/preview`, the reader's access, the filters on screen, nothing stored) and Add (one manual edit: `add_parameter` when needed, `add_query`, `add_block`, checked by the server's design rules like any edit). The datasets come from `GET /api/reports/workspace/datasets`. An empty workspace report shows Add widget, Generate from a doc, and Ask for a chart instead of the SQL console; the console and Schema are hidden for this source. |
| D1068 | **AI-written text states no data values** (audit fix, T604): text is the same for every reader while their numbers are their own (D1061), so on a This workspace report the generation and edit prompts say markdown blocks and section summaries carry no figures, and `validateSpec(…, { aiText })` refuses a spec whose markdown block or section summary (the ones generation wrote or an edit changed) holds a number other than a year, a span of time ("30 days"), or a label glued to letters (Q4, 7d). The agent gets the refusal and puts figures in query-bound KPI, chart, and table blocks. A person's own manual edits are not checked: what an owner types is theirs to share. |

Threats: **T600** no SQL on the workspace source (a non-JSON or unknown-field query is refused before anything runs; names come from the registry, values are bound). **T601** reader isolation (D1061: every read is computed as the reader; nothing computed for another person is served). **T602** caches (D1062: triggers keep no rows or option lists). **T604** AI-written text (D1068: markdown blocks and section summaries on workspace reports state no data values, so an owner's numbers cannot reach readers through text). **T603** MCP keys read a workspace block only with the dataset's module read scope (`time:read`, `crm:read`, …), as `query_dataset` requires; `reports:read` alone is not enough.

Deferred (editing an existing widget in the builder was built later: §D.10, D1220–D1223): cross-dataset queries and joins; Add filter's column picker for datasets; excluding multi-select values; per-reader result caching (each read runs ≤12 SQLite aggregates, ≤1,000 rows each); money shown in major units (datasets return minor units; formats are left to the author).

### D.9 Audit 2 fixes

#### Standups and Contacts (branch `fix/audit2-checkins-crm`)

| # | Decision |
|---|---|
| D1160 | **Standup watchdog** (amends D939): one module schedule `checkins.watchdog` (`everyMinutes: 15`, owner `checkins_module/watchdog`, created on first re-arm like `goals.sweep`) drives every standup that is active with participants, or has an open round, but has no armed `checkins.drive` schedule. A drive handler that throws (its re-arm rolls back with it) or a crash after the fire row was recorded (the occurrence never runs again, T504) used to leave the `{ once }` rule with no next fire and the standup silent forever; now it resumes within 15 minutes. Each standup is driven in its own savepoint, so one failing never stops the others. |
| D1161 | **Blocked participants** take no part: `participantsOf` leaves out disabled people (no round rows, not counted as missed, not listed); saving the participant list drops a blocked person already on it instead of refusing (a newly added blocked person is still refused). |
| D1162 | **Import undo's companies**: a contact import records the companies it created (a Company column or email-domain linking) in its changes; undo deletes only those, if no contact or deal uses them. Jobs from before this record none, so undo leaves their companies. |
| D1163 | **Removing a stage with deals** (`moveDealsTo`) moves each deal as a stage change does (D972): status, `closed_at` (cleared for open; kept when a closed deal stays closed the same way, stamped otherwise), lost reason only on lost, a `deal_stage_changes` row, and a `crm_stage` timeline entry (binned deals move without history). |
| D1164 | **Merge** (amends D970) moves time entries by their work item (`time_entries.target_kind`/`target_id` = contact or company); `bookings.company_id` and `time_entries.contact_id`/`company_id` never existed. |
| D1165 | **Restoring a binned company** whose domain a live company of the book now has answers `409 NAME_TAKEN` naming that company (it was a 500 from the unique index). |
| D1166 | **Value progress sources** (`crm_won_value`, `crm_pipeline_value`) add up one currency, as the board does (D972): the config's `currency`, else the pipeline's (else its book's), else the book's, else the workspace default; the detail names it. |
| D1167 | **Board drops** name their neighbours: the client sends `afterId` (the card above) and `beforeId` (the card below) from the cards it shows, and the server places the deal among all the stage's deals, so a drop on a board filtered by Mine or search lands where it was dropped. `position` (an index among all deals) stays for MCP and older clients. |
| D1168 | **Contacts sheets on phones**: `.crm-sheet` and `.crm-import` set their width only from 761 px up (as collections.css does), so phones keep the full-screen sheet. |
| D1169 | **Untitled interactions** read "Note · Ada · 14 Nov" (the kind once, as the heading), not "Note · Note". |
| D1170 | **A standup with no round yet** shows "First round Mon 16 Nov, 09:30" (the viewer's next open, `nextOpensAt`) in the list instead of "No rounds yet". Participants were already listed before the first round (`readableCheckinSql`); the audit's "No standups yet" came from a setup where the member had not been added. |

#### Time and Goals (lane tg; migration 120)

| # | Decision |
|---|---|
| D1140 | **The entry and timer sheets send the work item only when it changes** (TG1): a target the viewer cannot open shows as empty, and sending that empty value unlinked the entry from its card. |
| D1141 | **The entry sheet sends the start only when the day or start changed** (TG8): the fields hold minutes, so every save dropped the entry's seconds. |
| D1142 | **Budget alerts fire once per crossing** (TG2): `time_projects.budget_alerted` (migration 120) holds the last `<period>:<threshold>` sent; the dedupe key only folded unread repeats, so every write after the alert was read sent it (and a push) again. Changing the budget clears it. |
| D1143 | **A project the viewer cannot open is "A project you can't open"** (TG4) wherever an entry shows (card Time sections, entry lists, summaries, which group all such projects in one row, CSV, the `time.entries` dataset, which also drops its id and client); its color reads slate and its client is empty. The dataset builds these columns per query (built at load, the access predicate read as "0"). |
| D1144 | **`start_timer` refuses when the running timer is on a project the key cannot reach** (TG5), as `stop_timer` does, instead of stopping it. |
| D1145 | **A carried-over goal counts once in its parent's roll-up** (TG3): the closed original drops out while its live copy (linked by `source`) has the same parent; the copy continues it (D905). |
| D1146 | **Closing a goal or a period uses fresh numbers** (TG6): auto key results are recomputed (forced) before the snapshot and the 70% score. **Approvals list a week's total by each entry's local day** (TG7), the rule approving locks by, not UTC bounds. |
| D1147 | **Today's total is bounded by tomorrow** (entries logged ahead are not today's); **`get_time_for_item` with a key over chosen projects totals those projects only** (entries, totals, per person). |
| D1148 | **A new goal goes in the current period**: the New goal sheet opened from "All periods" (or with no period chosen) picks the open period containing today (the latest-starting when they overlap); "No period" stays a choice. MCP `create_goal` does the same when `periodId` is left out (`null` keeps none). |
| D1149 | **Goal sheet fields top-align** (UI9): the Start field's hint made the row taller and the Due input stretched to fill it. |
| D1150 | **The `time.entries` dataset's money columns are built per query** (like D1143's project columns): built at load, the access predicate read as "0", so a project's managers saw amounts and currency of their own entries only, against D873. |

#### Shared client: api() and Insights (lane uc)

| # | Decision |
|---|---|
| D1180 | **Every mutation from `api()` is JSON** (audit 2 UI1): the server refuses any non-GET without `Content-Type: application/json` (`requireMutationSafety`), so `api()` sends a bodyless POST/PUT/PATCH/DELETE as `{}` with the header (and the CSRF token). Fixed once in `src/api.ts` (`apiRequestInit`), not per call: ~35 module calls (start a round, remove a key result, delete a time entry, Bin a form or contact, delete a link, undo) answered 415. A test fails if a client module calls `/api` with its own `fetch` mutation and no JSON header. |
| D1181 | **Insight charts follow the theme and keep status colours** (UI6): `InsightChart` reads the root's `color-scheme` as Reports does; labels, axes, tooltip, and palette come from that mode's `shared/reportTheme.ts` tokens (pie labels in the theme ink with no text halo). An optional `tones` map colours categories by status tone; Goals → Insights "Goals by health" uses it (on track green, at risk amber, off track red). |
| D1182 | **Counts in whole steps; ratings on their whole scale** (UI7): a `number` insight chart's value axis has `minInterval: 1`; a rating or scale question's results chart shows every bucket from its min to its max, zeros included (`ratingBuckets`). |
| D1183 | **The app stays dark when the browser asks for light** (audit 2 note): not a bug. Nook is dark-only (§E; `src/styles.css` and `index.html` set `color-scheme: dark`), and there is no theme setting to fall back from; only public pages follow `prefers-color-scheme`. A light app theme is a feature, not a default fix. |

---

#### Bookings (branch `fix/audit2-bookings`, decisions D1120–D1129)

| ID | Decision |
|---|---|
| D1120 | **Outside-feed RRULEs are expanded by their own reader** (`server/bookings/icsParse.ts`), not the calendar module's (which requires DTSTART's weekday in BYDAY). DTSTART is always the first instance and later ones are the rule's dates after it, so `WEEKLY;BYDAY=TU,TH;COUNT=4` from a Monday no longer invents a Monday or spends COUNT on it (BK1). Monthly BYMONTHDAY (incl. negative), monthly BYDAY with or without an ordinal, yearly BYMONTH with BYMONTHDAY or an ordinal BYDAY (Thanksgiving) are read (BK2). A UTC `UNTIL` is an instant compared with instants, a local one is zoned, a date one is compared with dates (BK3). Series without COUNT jump to just before the window; BYSETPOS/BYHOUR/BYWEEKNO/BYYEARDAY still flag the feed as partly read. |
| D1121 | **A refused public booking or manage change fetches a fresh render nonce** (the page JSON again) for the next try, as Forms' public page does; only a "too fast" refusal keeps the unspent, older nonce. Client only: `/api/public` is unchanged (BK4). |
| D1122 | **No calendar file for a request awaiting approval**: `/api/public/bookings/manage/:token/ics` is the one 404 for pending, declined, and expired bookings (`bookingHasIcs`), the booker's mail shows "Add it to your calendar" only for a confirmed booking, and the confirmation and manage pages show the button only once confirmed (BK5). |
| D1123 | **A booking's ICS UID is a keyed hash** (`keyedHash("booking-ics", first booking id)`, 32 hex) `@nook`, kept across reschedules with SEQUENCE raised; the internal id never leaves (T598, BK6). |
| D1124 | **A reschedule keeps the booking's own length**: `slotHosts` skips the "one of the type's durations" check when `excludeBookingId` is set (1–1440 minutes), so the manage page's slots and the move work after the host changed the type's durations; new bookings still need a listed duration (BK7). |
| D1125 | **A reschedule counts once**: round robin's 30-day load skips cancelled bookings (a move cancels the old row), and Insights leaves out a moved booking's old row (new dataset column `moved`, filtered off), so a move is neither a second booking nor a cancellation (BK8). |
| D1126 | **The booker cancels before the start** (`cancelBooking` by `booker`, the manage page and the member booker alike); the host may still cancel a booking under way until it ends. |
| D1127 | **MCP `create_booking` refuses a hidden type** to anyone but its owner, like `POST /api/bookings`. |
| D1128 | **Outside-feed all-day blocks follow the schedule's zone**: the feed cache keeps an all-day block's dates, and `feedBusy(…, tz)` places them in the host's schedule zone as Nook calendar all-day events are; blocks cached before keep their stored instants until the next refresh. |
| D1129 | **A new profile and working hours use the browser's zone** (UI3): `GET /api/bookings/profile` and `/schedules` take `?tz=` and the Bookings app asks for the profile on open; without it, the first non-UTC zone another module stored (mail, then Time), else UTC. An existing profile never moves. The slot calendar's today mark is a whole inset ring (was an inset bottom edge, half a ring on a round cell). |

#### Forms, Townhall, public pages (lane ft, migration 116; 117 unused)

| # | Decision |
|---|---|
| D1100 | **Anonymous means no actor anywhere**: an anonymous townhall question (asked or withdrawn) and an anonymous form response write their audit row (and so the server log line) with no actor and no question or response id, and an anonymous question waiting for review notifies the host with no actor. Named ones are unchanged. |
| D1101 | **A named question's asker hash is salted with its id** (`townhall-asker-named`): it never equals the person's session-wide anonymous hash, so a named row (author id or typed name) cannot be matched to their anonymous questions. "Mine" on named questions follows `author_id` for members and the salted hash for public participants. Migration 116 gives existing named rows a random hash; public participants lose withdraw on named questions asked before it. Anonymous questions of one person still share one hash within a session (one HMAC per viewer per state, not per question). |
| D1102 | **Anonymous forms read by the day**: the response list, its cursor, the CSV (web and MCP), and the response view carry the day only; rows sort by day then the (random) id; `since`/`until` move to whole UTC days (`dayFilter`). |
| D1103 | **Room reads**: a public route registered with `{ room: true }` (Townhall's page, state, and stream) is limited per participant (`p`, 60 a minute) and per address (1200 a minute), not by the 120-a-minute page bucket. The audience page retries a 429 or failed first load after Retry-After, and with the stream open no longer refetches after its own votes, questions, or withdrawals (the stream brings the change). |
| D1104 | **Guest names say so**: questions carry `authorKind` (`member`, `guest`, or null); every surface shows a typed public name as "Name · guest" (`authorLabel`), recap Markdown and CSV included. Names equal to a member's are not refused. |
| D1105 | **Refusals carry a fresh render nonce**: `refreshNonceOnRefusal(kind, itemId, run)` / `withFreshNonce` (server/public/limits.ts) add `renderNonce` to any JSON refusal except the uniform 404. Forms' and Townhall's submissions use it; the public form page adopts the nonce from any refusal. |
| D1106 | **Townhall session list cursor** is `[rank, sort_at, id]` over the list's whole order (live first); an older two-part cursor starts the list over. |
| D1107 | **A public response reaching the form's limit closes it through `recount`**, like members' responses: status change, item change, audit, schedules, and the poll-closed notice. |
| D1108 | **Smaller public fixes**: the public time-poll grid shows members by first name and keys rows by position (no response ids); an owner-only poll shows no vote count publicly; confirming a held response checks one-per-browser again; the audience page sends its honeypot's real value. |
| D1109 | **Recap upvotes** count questions the reader can see (a non-host's total leaves out pending questions). |
| D1110 | **A public poll is one tap**: its minimum fill time is 1 s (`MIN_FILL_MS.poll`; forms keep 3 s), and the public page, refused as too fast, waits out the minimum with the fresh nonce and sends the same answers once more by itself. |
| D1111 | **Forms phone and access polish**: the forms sheet sizes apply on desktop only (a phone gets the shared full-screen sheet); the editor's "Questions · N" no longer wraps; someone asked to answer a form who opens its results is told they are the owners' and offered the form, instead of "not shared with you". |
| D1112 | **Townhall Invite QR** encodes the link beside it: the audience link once one exists ("Scan to join as audience"), else the team link, shown in the team section and labelled so. |

Threats: **T620** anonymity of askers and respondents (D1100, D1101: no actor, id, or hash links an anonymous question or response to a person). **T621** impersonation by a typed public name (D1104). **T622** a room behind one address locking itself out of the live page (D1103). **T623** timing anonymous responses from timestamps, ordering, cursors, or narrow windows (D1102).

#### Plan and docs gaps (branch `fix/audit2-gaps`)

| # | Decision |
|---|---|
| D1190 | **Module links open what they name.** Today's Follow-ups "View all" goes to `/contacts/followups` (it was `/contacts?tab=followups`, which Contacts ignores and opened People). The time approval notification's `?tab=approvals` now survives Time's route parser and opens the project's Approvals view (Team via `?tab=team`); a non-manager falls back to Entries. Swept: every Today provider href and module notification href with a query (`/goals?view=mine`, forms `?response=`, townhall `?filter=`/`?q=`, `/time?entry=`, `/time/timesheet?week=`) already parsed. |
| D1191 | **Private answers has a switch**: standup Settings → Who can read it → "Private answers" (owner and managers only), with copy saying who sees what in both states; anonymous standups show their own line instead. The server now refuses a change of `privateAnswers` from an editor below `manage` (an editor reads only their own answers while it is on, so turning it off would widen their reading). |
| D1192 | **Guests and role-limited modules (§G.1 Q8)**: `/api/auth/me` `features` gains `time`, `crm`, `bookings` (`server/workspaceFeatures.ts`). Guests get Time (launcher, Today, Settings → Modules switch) once they hold any level on a live time project, and never Contacts or Bookings; those are hidden like the Vault without a key, and the route gate says why ("Time opens once someone adds you to a time project", "… is not available to guests"). Contacts' API now answers guests 404 like Bookings'. Members, viewers, and admins are unchanged. |
| D1193 | **Every notification topic the seven modules emit has a settings row**: `crm.deal_lost` ("Deals lost"; "Deals won" no longer claims both), `checkins.nudge` ("Nudges"), and `forms.action` ("Responses sent to you"). `tests/audit2Gaps.test.tsx` sweeps the servers' `topic:` literals against the client modules' `notificationTopics`. |
| D1194 | **Calendar suggestions for standup answers are deferred** (D936 as built uses cards and time entries only); listed in TODO.md. |

### D.10 Leftovers built

**Person and contact fields in Collections and Contacts (lane cf, TODO "Leftovers (lane W3-WIRE)")**

| ID | Decision |
|---|---|
| D1200 | Collections creates and edits `person` and `contact` fields (the `allowRelations` gate of D968 is lifted; `buildSchema` still accepts the option). Each holds **one** id, as D961 stores it; multi-value relations are left for later. Writers may name a live team member the share picker offers (no guests while `share_with_guests` is off) and a contact they can read now; missing and unreadable contacts get the same error. Undo re-checks a changed person or contact value. Editors: a chip in the cell that opens a sheet with the shared `PersonPicker` (single); Clear empties it. |
| D1201 | Rows carry `people: { fieldId: PersonSummary }`, resolved per viewer on every read: members by name (disabled ones as former members), contacts through `contactSummaries`, so a contact whose book the viewer can't read is `{ kind: "contact", id, hidden: true }` and shows as "A contact". |
| D1202 | Filters: `is`, `is_not` (an id), `empty`, `not_empty` for both types. Person fields sort by the member's name; contact fields do not sort (the order would hint at hidden names). Contact and member names are never put in the row search index. |
| D1203 | CSV import takes an id, an email, or an exact unique name (members; contacts the importer can read); export writes names, and an unreadable contact exports empty, like a restricted note. |
| D1204 | MCP: values accept an id, email, or exact name; rows return `{ userId, name }` and `{ contactId, name }`, or `{ restricted: true }` when the owner can't read the contact or the key lacks `crm:read` for it (`keyMayRead` target `contact`). Writing or filtering by a contact the key may not read is NOT_FOUND. |
| D1205 | Helpers live in `server/people/summaries.ts` (`userSummaries`, `isPickablePerson`, `pickablePersonByEmail`, `pickablePersonByName`, `readableContactIdByReference`); `server/crm` is unchanged. |
| D1206 | Contacts custom fields: `GET /api/people/resolve?users=&contacts=` (≤ 200 each) names the ids a record holds; tables and record pages show names (cached per session, `src/crm/relationNames.ts`); a contact field's editor searches the whole book with `PersonPicker` instead of the first 100 contacts; the filter sheet offers is / is not with a picker. CRM MCP tools still take and return ids. |

- **Docs site "Using Nook" sections** (D1049's docs item; branch `docs/site-workspace-modules`, no code or decision ids): `site/index.html` has a section, nav entry, and Apps card per module (`#forms`, `#time`, `#goals`, `#standups`, `#contacts`, `#bookings`, `#townhall`; Standups and Contacts use the words people read, §G.1 Q7), plus `#connections` (the W3 wiring) and `#public-pages` (the public URLs and the Settings → Workspace switches), the modules' rows in the MCP permission table, and their URLs. `docs/USING.md` has the matching sections and a "Workspace module tools" list. `tests/docsSite.test.ts` now requires every module, workspace ones included. Screenshots (`docs/images/*-dark.png`, 1440 × 900) were taken from a seeded QA server.

**Edit widget** (lane rw, branch `feat/reports-edit-workspace-widget`, decisions **D1220–D1223**; no migration): editing an existing widget of a This workspace report in the builder, the D1067 deferral.

| # | Decision |
| --- | --- |
| D1220 | **Edit widget is Add widget's sheet on a saved block.** The owner opens it from the block header (a pencil after Inspect; a narrow KPI tile keeps it in ⋯ only, like Remove) and from the block's ⋯ menu (the phone path); never on a past version or for readers. `widgetDraftOf` reads the block and its structured query back into the draft (dataset, measures, group/split, time bucket and range, filters, Show as, title); Preview is unchanged; **Save changes** waits for a change and saves **one manual edit**: `add_parameter` when the draft moves onto "A date filter readers can change" and the report has none, `update_query` on the block's own query (the purpose follows a new title), and `update_block` in place (same id, section, and position; a new type keeps its section and width). The server's checks are those of any edit (design rules on the changed block, a run of the changed query). Fields the builder does not set stay (an author's format for the same measure, width, click filter, comparisons) unless they name a column the new result lacks or belong to a kind no longer drawn. A query other blocks also read is not changed under them: the edited widget gets a new query of its own. |
| D1221 | **What the rows cannot edit is kept, visibly.** A saved filter the filter rows cannot express (a report filter's placeholder, an `in`/`not_in` list, `between`, a value typing would change) is a locked row ("Client follows the report's filter Client", "Kept as saved") that can be removed but not changed; a query's own sort and limit are kept ("Order: Client, lowest first; top 50") with **Use the usual order**, and dropped when the columns they sort by leave the result. |
| D1222 | **A widget the builder cannot show faithfully opens the JSON editor.** The read-back must reproduce the saved query exactly (key order aside) and the block's mapping (type, kind, x, y, series, KPI column); otherwise the sheet names why (a funnel chart, a measure alias, a fixed date range, a time zone, more than four measures, a dataset the owner cannot read, …) and offers **Edit as JSON**: Inspect's Edit SQL editor on the block's query, checked and saved the same way. |
| D1223 | **Undo like other manual edits.** Save (and now Add) shows a toast with Undo that restores the version before while the edit's version is still current (`undoToBefore`, as Remove and Edit SQL); otherwise Versions has every version. MCP: `update_report_query` already saves a workspace query's JSON through the same checks; its description now says so. |

#### Team page "Book time with …" (branch `feat/team-book-time`, decisions D1250–D1254)

| ID | Decision |
|---|---|
| D1250 | **Who offers what.** `GET /api/bookings/bookable?users=…` answers for a whole Team list in one query (no request per member): each member's bookable types for the viewer, at most 20 each. A member offers a type they host on every booking of it: the owner of a single-host type, each host of a collective one. Round robin is left out (the booker cannot pick who they get), and so is anything the viewer owns or hosts. Hosts must be able to host (not blocked; admins and members). Viewers and guests get nothing (they cannot book). |
| D1251 | **Bookable** = live and active, and either readable by the viewer (its sharing) or open on its public page (public, the workspace allows public booking pages, the owner active with the profile on: the same rule as `/p/book/<handle>/<slug>`). `requireTypeForBooking` applies it to `POST /api/bookings`, `/types/:id/slots` (readers keep any status, the editor's preview), `/types/:id/form`, and MCP `create_booking`/`get_availability`, so a member can book a colleague's public type in the app without it being shared. A hidden type still books only for its owner (D1127). |
| D1252 | **The in-app sheet** (`src/bookings/BookTimeSheet.tsx`, a dialog on a computer and a bottom sheet on a phone, one history layer): length and time in the shared SlotPicker, then the place when the type asks, guests, and the published intake questions (QuestionRenderer, audience member), then a confirmation. It books as the viewer through `POST /api/bookings` (source `internal`), which now takes `tz`, `location`, `guests`, and `answers` beside the booker it fills in; the viewer reads the booking as its booker (D1022). |
| D1253 | **Member actions**, a slot like item sections (D1056): a module's `memberActions` (`src/ui/memberSlots.ts`) load their data once for the members on screen and render a button only for members their data names, so a member without types shows nothing. Team renders them beside each row ("Book time", an icon only under 420 px) and on the profile ("Book time with <name>"). One type opens the sheet; several open a small chooser (title, lengths, group, needs approval). Hidden for viewers and guests and while Bookings is off. |
| D1254 | **MCP `list_bookable_types`** (`bookings:read`, list mode, offered to agents): `{ hostIds? }` → `{ hosts: [{ userId, name, types }] }` by the D1250 rule; a key over chosen types sees only those (T203). Then `get_availability` and `create_booking`. |

#### Final QA fixes (branch `fix/modules-audit`, decisions D1260–D1269)

| ID | Decision |
|---|---|
| D1260 | **`nook:open-path` opens any in-app path**, not only a board or the Bin: a goal, form, or townhall embed's Open, and Bookings' "Open in Bookings", did nothing. `inAppOpenPath` checks the path as a notification href is (`safeNotificationPath`: same-origin, round-trips through the router, not Home), else the event is ignored. The app then opens it as the Inbox opens a target (a note through the Notes loader, anything else by its route, a new entry): leaving Notes saves first, the Settings hub asks first about a key shown once (its `guardLeave`, handed to the app through a ref), and a module that is off goes through the D92 gate (Home and its hint). |
| D1261 | **Team's Book time sheet renders on `document.body`** (a portal): inside the row's actions box, which is `transform: translateY(-50%)`, the fixed sheet was positioned and clipped against that box. The chooser menu stays in place (it is not clipped). |
| D1262 | **The Collections relation picker lists its results in the sheet's flow** (`.relation-picker .ui-person-options { position: static }`, at most 300 px or 40 % of the screen): the absolute list was clipped by the dialog body and lay under its footer, which took the clicks. The sheet grows, and on a phone scrolls. |
| D1263 | **Insight charts shrink with the window**: `.ui-chart-card` and `.ui-insights` use one `minmax(0, 1fr)` track and the chart host `min-width: 0`, so the host narrows and its ResizeObserver redraws the SVG (an auto track kept the first width). Applies to every module's Insights (Goals, Forms, Bookings, Townhall, Contacts, Standups, Time reports). |
| D1264 | **Period names are unique** (case aside): `createPeriod` and a rename answer 409 `DUPLICATE_PERIOD` "There is already a period named “…”. Choose another name." Periods → Add period suggests the first quarter from this one with no period of its name, recomputed whenever the list reloads (first load, after an add), so a second click adds the next quarter instead of a twin. Typing a name never jumps. |
| D1265 | **Today → Storage counts the Bin's items**: notes, cards, boards, and module items take no bytes, so a Bin of them read "Nothing in the Bin". The section carries `binnedItems` (an MCP key counts only the types it may see, as `binSoon`); the line reads "3 items in the Bin" when no binned file has bytes. |
| D1266 | **Home's app tiles stack on phones** (icon above the label, 72 px tall, the label ellipsized as a last resort): a third of a 390 px screen had no room for an icon beside "Whiteboards", which ran out of its cell. |
| D1267 | **Report charts step counts in whole numbers**: the value axis gets `minInterval: 1` for an `integer` format, or a plain number whose plotted values are all whole (a chart of 1s and 2s drew 0.5 ticks). Percent, money, duration, and percent stacks keep free steps. |
| D1375 | **Containers show the history they record** (§B.5, §E.3): forms, standups, townhall sessions, booking types, and time projects recorded activity under their own kind (11, 10, 8, 6, and 5 call sites) that no page read; the item timeline was mounted only on goals, responses, bookings, contacts, questions, and answers. Each now mounts the shared `ItemTimeline` (`kind` = the container kind, the module's `activityRenderers`): an **Activity** tab on a form (`/forms/<slug>/activity`, after Results; anyone with a level, never a respondent who only answers), a standup (`/standups/<slug>/activity`), a townhall session (`?tab=activity`; members only, never the audience link), and a time project (the project page's view switch); an **Activity** section last in the booking type editor. Reading needs the container's read level (the item activity endpoint's 404, T501); commenting needs `comment` and up (`canCommentAtLevel`; the server's role cap makes a viewer's level `view`). Time and Bookings gained renderers for their kinds and Townhall one for `title`, so none reads "updated this". |

#### Item comments: notifications, reactions, files, Undo, and module sharing (branch `feat/bake-comments`, decisions D1360–D1369)

| Id | Decision |
|---|---|
| D1360 | **Who follows an item** (for comment notifications): the people it is about or belongs to, per work kind (`server/activity/commentNotify.ts`): a goal's owner and contributors; a key result's owner and its goal's owner and contributors; a deal's owner and creator; a contact's or company's owner; a booking's host and co-hosts; a response's respondent; a standup answer's author; a townhall question's asker; a time entry's person; plus, for every kind, the owner of the container it sits in (`anchorsOf` → `containerRow`). Nobody opts in or out per item: the set is the Tasks card comment mail's (creator and assignees) applied to each kind, so there is no separate Follow feature (the goal copy that implied one is gone, D1371). |
| D1361 | **A new item comment notifies the followers, and a reply its parent's author** (topic `core.comment`, the item's module, `notify()`): never the commenter; only people who can read the item now (`mentionReaders`); one notification per person per comment: someone the comment @mentions hears about it once, as the mention (D1325), and is left out here. The title names the commenter and the kind word only ("Ada commented on a goal", "Ada replied to your comment on a goal"), never the text (T505). One unread row per person and item for comments, and one more for replies, so a later comment never hides a reply. Email is the existing `comments` category, renamed "Comments on your cards and items" (template `core.comment`, ids only, grouped 10 minutes, re-read as the recipient at send time: lost access or a comment deleted since → left out, T691). An edit notifies new mentions only, as before. |
| D1362 | **Reactions on item comments**: `registerReactionTarget({ kind: "item_comment" })` (the 086 purge trigger already expected it): readers of the comment's item see them (the adapter's level, read fresh), and whoever may comment there reacts (`comment` and up, a writing role). `ItemComment.reactions` is filled by one aggregate query per list. The client reuses the Tasks comment chips (`CommentReactions`, its CSS moved to `src/ui/reactions.css`; a `send` prop picks the route, `PUT/DELETE /api/reactions/item_comment/:id/:emoji`). |
| D1363 | **Files on item comments**: host kind `item_comment` in the attachment registry, declared linking, ≤ 10 per comment. Its read rule is code, not SQL (the item's work kind adapter, which no single SQL predicate covers), so the host carries `readable(hostId, userId)` and `readableSql` is `0`: `hostReadable` asks it, and the single document reads (`readableDocument*`) fall back to it for a document linked from such a host (≤ 20 links checked), never lists, search, or Files (T690). Only the comment's author links (with the comment through `attachmentIds`, uploaded with `?attachTo=item_comment`, or later through the generic route while they may still comment); the linker, the author, or a manager of the item unlinks, and the file's owner always may. MCP's attachment tools do not offer the kind (`mcp: false`), and the MCP comment tools return a `fileCount` instead of the files. A comment may be files only (empty text). |
| D1364 | **Deleting an item comment offers the shared Undo toast** (`notify.success("Comment deleted", { action: Undo })`, D813): the client reads the server's `undoTicket` (it was typed `void`) and `POST /api/undo/:ticket` puts it back. The ticket now captures the comment's reactions and file links too, and the delete removes them explicitly (a comment with replies is soft-deleted and kept "Comment deleted", without files or reactions), so Undo restores all three. A comment's "commented" activity entry is not drawn in the timeline: the comment itself is there. |
| D1365 | **The comments timeline gets the attach control** (a paperclip: files upload to the person's Attachments folder now and are linked when the comment is sent; the Tasks comment's From Files sheet is not offered here) and the Tasks attachment list (`AttachmentList`, `AttachmentPreview`). |
| D1366 | **Sharing a module container tells the people added** (`writeWorkspaceAccess` → `notifyWorkspaceShared`): people newly added by name (not groups, not the everyone audience, never the sharer, only if they can open it after the change) get a bell row in the container's module (topic `core.shared`, "Ada shared the time project ‘Website rebuild’ with you"), the `sharing.shared` mail, and the digest's "Shared with you" (migration 155 widens `mail_share_log.kind` to the seven container kinds). `SharedKind` gains the container kinds; `sharedItem` reads them as the recipient (`itemLevel`, `containerName`) and links by the adapter's friendly path (contact books: `/contacts`). Settings' digest description now names the module sections it can include. |
| D1367 | **Activity panels deep-link, and comment links open them**: the time project route parser kept only `?tab=team|approvals`, so `?tab=activity` was dropped; it keeps `activity` now. A booking type takes `?section=<id>` (the editor's section ids; Bookings' parser kept no query before), scrolled to once the type loads, and kept through the editor's friendly-URL replace. Forms (`/activity`), standups (`/activity`), and townhalls (`?tab=activity`) already round-tripped. `commentsPath(kind, href)` (shared/itemActivity.ts) points a comment's bell row and email at where the comments are: a form's or standup's `/activity`, a townhall's or time project's `?tab=activity`, a booking type's `?section=activity`; other kinds at their own page. Every such link passes `safeNotificationPath` unchanged. |
| D1368 | **The dev mail preview lists every template that can be sent**: besides the built-in set (and their goldens), `/dev/mail/preview` lists each run-time registered template from its own fixture (`registeredPreviewFixtures`: the modules' `time.update`, `goals.update`, `crm.update`, bookings, forms, standups, townhall, and core `core.comment`, `core.mention`, `public.verification`) and a `sharing.shared.module` variant (a time project shared with you). Registered templates stay out of the goldens. |
| D1369 | **No gap under an item comment's text**: with no reactions yet, the reaction row (the hover-revealed Add button) sat in the flow and left ~36 px between the text and Reply. On desktop it now waits at the header's end, as on a Tasks card comment (`position: absolute`, the header padded for it); on phones it stays in the flow as a 44 px target. |

#### Module email for Time, Goals, and Contacts (branch `feat/bake-comments`, decisions D1370–D1371)

| ID | Decision |
|---|---|
| D1370 | **Time, Goals, and Contacts send email**: their Settings → Notifications → Email switches did nothing, because no notify() of theirs passed `email`. Each now registers one activity template in its own category through `mailTemplates` (`time.update`, `goals.update`, `crm.update`), built by `server/mail/moduleItemMail.ts`, and passes it on: Time on a week submitted (to its managers), approved, returned, or unlocked (to the person), and the 80% / 100% budget alerts; Goals on at risk / off track, check-in due, and D1371; Contacts on a follow-up due, being made a deal's owner, and a deal you own won or lost. The long-timer and "nothing logged today" reminders and quiet deals stay bell-only. The payload is ids and enums only (`{ topic, kind, id, actorId?, weekStart?, decision?, threshold?, role?, followupId? }`, never a note, a rejection reason, or a title). At send time the item is read again as the recipient through its work kind adapter (the mentions mail's re-check, T662): no access → `access_lost`; the moment passed (the goal recovered or was checked in since, the follow-up done, the deal's owner changed again) → `empty`. Prefs, quiet hours, suppression, and the digest are the dispatcher's as for every activity mail. Repeats of one event coalesce for 10 minutes (latest wins). These templates have no dev-preview fixture entry (the preview lists the built-in `TEMPLATES` only); their `fixture` is for tests. |
| D1371 | **Being made a goal's owner or a contributor notifies** (`goals.assigned`: bell + D1370 mail), on create and on edit, to people who can read the goal, never the person who did it; one unread row per person and goal. The Goals topic text no longer says "a goal you follow" (there is no Follow): at risk reaches the owner, contributors, and the owner of the goal above. |

## E. Design and UX guidelines

Nook is dark-only with a warm amber accent (`--yellow #f6c453`, focus `--field-focus`), panels `#111113`/`#18181b`, borders `#29292d`, muted `#929299`, 8–10 px radii, `.84rem` controls, sheets on phones, and lucide icons. New modules must be indistinguishable in craft from Tasks and Reports.

### E.1 Principles

1. **One way to do each thing.** Use the shared components (E.3); do not restyle them per module. A second implementation of a picker, chip, timeline, or progress bar is a review blocker.
2. **Content first, chrome quiet.** Lists are dense rows (34–40 px), one primary action per screen (amber filled), secondary actions as ghost buttons or the ⋯ menu.
3. **Every list has an empty state** with one sentence and one action ("No goals in Q1 2027. **New goal**"), using `EmptyState` with the module icon.
4. **Keyboard**: `/` search in module, `n` new, `j/k` move, `Enter` open, `e` edit, `Esc` close sheet, `⌥T` timer, `?` shortcut sheet entries per module (registered).
5. **375 px rule**: toolbars are **two rows, nothing hidden** (the tasks phone toolbar rule, commit 74f26205): row 1 view switch/title, row 2 filter + search; no horizontal scroll except kanban columns and timesheets (which show one column/day at a time with a strip).
6. **Plain words**: "Check in", "Log time", "Respond", "Book", "Link work"; never "OKR instance", "entity", "record type".
7. **Status colors** come from one map (`shared/tones.ts`, W1-CORE): `good` (green), `warn` (amber), `bad` (red/`--red`), `info` (blue), `neutral` (slate); health, deal won/lost, booking status, form status, and participation use it.
8. **Numbers**: tabular figures for durations, money, progress; units always shown (`3h 20m`, `€1,200`, `62%`).
9. **Accessibility**: every chip/button has a name; charts have a table fallback (Reports pattern); color is never the only signal (icons + text on health).

### E.2 Module home scaffold (`src/ui/ModuleHome.tsx`, W1-UI)

Header: module icon + name, primary action, secondary ⋯; a tab strip (`tabStrip.ts`) for the module's top-level views; a filter row (chips + search); content. Desktop ≥ 1280 may show a right detail pane; ≤ 760 uses full-screen sheets (`pickerSheet.css`, `useHistoryDialogGuard`). Every module home uses it, so Forms, Time, Goals, Check-ins, CRM, Bookings share header height, tab style, and spacing.

### E.3 Shared UI components to build once (W1-UI)

| Component | Used by | Notes |
| --- | --- | --- |
| `QuestionSetEditor`, `QuestionRenderer`, `ResponseViewer`, `QuestionSummary` | Forms, Check-ins, Bookings | §B.2; renderer has `theme="app" \| "public"` |
| `PersonChip`, `PersonPicker`, `CompanyChip` | all | users, groups, contacts; inline create contact |
| `WorkRefChip`, `LinkedItemsPanel`, `LinkPicker` | all | resolves refs, redacts unreadable, key paste (`MYT-12`) |
| `ItemTimeline` | Goals, CRM, Check-ins, Bookings, Forms | comments + activity, D746 controls |
| `KanbanBoard` | CRM deals (Goals optional board view) | columns with header totals, pointer drag, phone stage strip |
| `ProgressBar`, `ProgressRing`, `HealthChip` | Goals, Time budgets, Forms funnel, Check-in participation | one visual for "how far along" |
| `DurationInput`, `DurationChip`, `TimerChip` | Time, card slots, Bookings durations | parser from `shared/duration.ts` |
| `MoneyInput`, `MoneyText` | Time rates, CRM deals | `shared/money.ts` |
| `SchedulePicker` | Check-ins, Goals cadence, Forms open/close, Time reminders | weekdays, time, zone mode, preview of next fires |
| `AvailabilityEditor` | Bookings (owned by BOOK lane, but in `src/ui/schedule/` for reuse) | weekly ranges + overrides |
| `InsightChart`, `KpiTile` | every Insights tab | wraps Reports charts and theme |
| `PublicPageShell` | Forms, Polls, Bookings public pages | light theme (E.6) |
| `EmbedCard` | notes/cards embeds of polls, forms, goals, booking links | neutral link text, live content fetched |
| `QuickActions` (Today row) | all | registered per module |
| `EmptyState`, `ModuleHome` | all | E.2 |

### E.4 Patterns per screen type

- **List → detail**: desktop opens detail in a route (full page) with Back; phones the same (no split panes on phones). Detail pages have a header, left fields column (≤ 360 px) and right timeline on ≥ 1280; stacked on smaller widths.
- **Editors** (form, check-in questions, booking type): left navigation of sections on desktop, a stepper of sections on phones, autosave drafts with a "Saved" indicator; explicit **Publish** where the thing is live (forms, check-in questions).
- **Sheets** for quick create/edit (log time, check in, log interaction, new poll), max 560 px on desktop, full-screen on phones, `Esc`/back closes with the leave guard when dirty (`useLeaveGuard`).
- **Insights tabs** use 2–4 KPI tiles on top, then charts, then a table; filters at the top match the module's list filters.

### E.5 Visual QA

Screenshots at 1585, 1280, 390 for every new screen (TODO standing rule); `scripts/buttonMetrics.ts` diff + lint must keep existing screens identical; `scripts/dragSmoke.ts` covers the deal board drag; each lane adds its screens to the button lint.

### E.6 Public pages theme

Public pages are the only light surface: background `#f6f5f2`, card `#ffffff`, text `#18181b`, muted `#6b6b72`, border `#e4e4e7`, accent = the form/type accent (default the Nook amber, darkened to `#b8860b` for contrast on light), 12 px radius card, max width 640 (forms) / 880 (booking calendar + times). Workspace name/logo top-left, "Powered by <app>" footer. Dark mode for public pages follows `prefers-color-scheme` using the app tokens (D831). All contrast ≥ 4.5:1 (checked by test on the token pairs).

---

## F. Build plan

### F.1 Waves

```
Wave 1 (2 lanes, parallel)        Wave 2 (6 lanes, parallel)                         Wave 3 (2–3 lanes)
W1-CORE  server foundations  ─┐   FORMS · TIME · GOALS · CHECKINS · CRM · BOOK  ──►   W3-WIRE   cross-module flows, docs
W1-UI    shared UI + registries ┘                                                     W3-REPORTS workspace data source
                                                                                      (then QA + release, serial)
```

- **Wave 1** must merge to `feat/workspace-modules` before Wave 2 starts. W1-CORE and W1-UI run in parallel; W1-UI codes against W1-CORE's shared types (`shared/*` is written first by W1-CORE in its first commit, within a day, and W1-UI rebases on it).
- **Wave 2** lanes branch from the Wave 1 merge, each in its own worktree, and merge back one at a time (any order). Each lane is self-contained: its module works end to end using foundations and existing modules only. Progress sources and integrations that need another Wave 2 module are registered **in the providing lane's own folder** (TIME registers the `time` progress source in `server/time/progressSource.ts`) against the foundation registry, so no lane waits for another.
- **Wave 3** starts when all six lanes are merged.

Ports and origins (TODO standing rules): W1-CORE 2201, W1-UI 2202, FORMS 2211, TIME 2212, GOALS 2213, CHECKINS 2214, CRM 2215, BOOK 2216, W3-WIRE 2221, W3-REPORTS 2222; origin `<lane>.localhost:<port>`; scratch in `<scratchpad>/<lane>/`.

### F.2 Wave 1 deliverables (exact APIs lanes rely on)

W1-CORE exposes (names are binding; lanes import them):

```ts
// server/workspaceModules.ts
registerWorkspaceModule(def: WorkspaceModuleDef): void
// server/questions/service.ts
saveDraftSet, publishSet, currentSet, submitResponse, updateResponse, deleteResponse, summarize, responsesPage, exportCsv
// shared/questions/*
QUESTION_TYPES, validateQuestionSet, validateAnswers, evaluateLogic, scoreResponse, type Question, type QuestionSet, type Answers
// server/people/contacts.ts
upsertContactByEmail, readableBookIds, contactSummaries, ensureClientsBook
// server/links/service.ts + shared/workRefs.ts
createLink, deleteLink, linksOf, registerWorkKind, resolveRefs, parseWorkRef, type WorkRef, type WorkSummary
// server/activity/*
recordItemActivity, recordItemChange, registerActivityKinds, addComment, listComments
// server/schedules/*
registerScheduleHandler, upsertSchedule, cancelSchedules, nextFires
// server/notify/*
notify, enqueueExternalMail, registerDigestSection
// server/public/*
registerPublicRoutes, createPublicLink, revokePublicLink, readPublicLink, publicLimit, issueRenderNonce, checkSubmission, startEmailVerification
// server/datasets/*
registerDataset, runDatasetQuery
// server/goalsProgress.ts (lives in foundation so every lane can register before GOALS merges)
registerProgressSource(kind, { label, configSchema, describe, compute }), computeProgress
// server/undo.ts
captureUndo, restoreUndo
// server/access/*
item access for the six kinds: itemLevel(kind, id, userId), readableIds(kind, userId), sharing routes generic `/api/access/:kind/:id`
// server/mcpRegistry.ts, server/mcpToolKit.ts
defineTool (+ annotations, outputSchema), registerMcpResource
// shared/duration.ts, shared/money.ts, shared/embeds.ts, shared/tones.ts
```

W1-UI exposes: everything in §E.3, `src/workspaceModules` registry (`WorkspaceClientModule` type), `src/ui/cardSlots.ts` (`registerCardSection`, `registerCardFaceBadge`, `registerCardHeaderAction`, `registerTimelineDecoration`), `src/editor` embed + slash registration (`registerEmbedKind`, `registerSlashItem`), `src/today` quick actions + generic section renderer (`registerTodayRenderer`), Settings rows (notifications per module, policies `public_forms`/`public_booking_pages`, workspace currency, week start, duration format).

**Wave 1 acceptance:** all foundation tests green; the six module stubs are hidden; a throwaway test module (in tests only) registers routes, MCP tool, dataset, schedule, search scope, Today section, card slot, embed, and works end to end in tests; migrations 085–089 apply to a copy of a real 082 database with no lost grants/proposals/notifications; public `/p/test` page renders with the strict headers; Visual QA shows existing screens unchanged (buttonMetrics diff empty).

### F.3 Wave 2 lanes: ownership

Every lane owns, exclusively: `server/<module>/**`, `src/<module>/**`, `shared/<module>*.ts`, `server/migrations/<its ids>_*.ts`, `server/migrations/workspace/<module>.ts`, `tests/<module>*.test.ts(x)`, its section of `docs/plan/WORKSPACE_MODULES.md` ("Decisions as built" under its §D), and its own docs file additions listed below. **Append-only shared edits** (one line or one block each; resolve conflicts by keeping both):

| Lane | Server folder | Client folder | Append-only shared edits |
| --- | --- | --- | --- |
| FORMS | `server/forms/` | `src/forms/` | `docs/plan/API_CONTRACTS.md` (new section), `THREAT_MODEL.md` (T515–T529), `TEST_PLAN.md`, `CHANGELOG.md` Unreleased line, `site/index.html` module section (W3 finalizes) |
| TIME | `server/time/` | `src/time/` | same docs; `scripts/buttonLint.allow.json` if needed |
| GOALS | `server/goals/` | `src/goals/` | same docs |
| CHECKINS | `server/checkins/` | `src/checkins/` | same docs |
| CRM | `server/crm/` | `src/crm/` | same docs; `server/collections/schema.ts` (`person`, `contact` field types, D961) |
| BOOK | `server/bookings/` | `src/bookings/` (+ `src/ui/schedule/AvailabilityEditor.tsx`) | same docs |

Lanes must **not** edit: `server/index.ts`, `server/mcpTools.ts`, `server/mcpScopes.ts`, `server/keyGrants.ts`, `server/keyResources.ts`, `server/moduleIds.ts`, `src/modules.ts`, `src/router.ts`, `src/App.tsx`, `src/AppShell.tsx`, `src/tasks/**` (use card slots), `src/editor/**` (use embed/slash registries), `server/migrations/index.ts`, foundation folders. If a lane needs a registry hook that is missing, it asks the director; W1 owners add it in a small follow-up commit on `feat/workspace-modules` that lanes rebase onto.

Cross-lane dependencies inside Wave 2 are only through foundation tables and registries:
- BOOK writes contacts (088 tables, `upsertContactByEmail`) and cards (Tasks service `createCard`), not CRM code.
- FORMS writes contacts the same way; creates cards via Tasks service.
- TIME reads companies (088) for clients.
- Progress sources: TIME, CRM, FORMS, CHECKINS register theirs in their own folder via `registerProgressSource`; GOALS consumes the registry. GOALS' UI lists whatever is registered.

### F.4 Per-lane acceptance and test plan (summary; full lists in §D)

Each lane's "done" means:
1. Its §D acceptance (browser) passes on its own origin at 1585/1280/390 with screenshots attached to the merge report.
2. Its §D acceptance (MCP) passes via a real MCP client (`scripts/mcpSmoke.ts <lane>` pattern) and over REST v1.
3. Tests: service, routes, access (owner/manage/edit/comment/view/none/guest/viewer role/blocked user), chosen-item key reach, MCP tools (scopes, NOT_FOUND parity, rate buckets), Bin + purge orphans (`tests/support/orphans.ts`), migration test (on a copy of a post-089 DB), client tests for each screen, search, Today section, dataset query with access predicate, notifications and schedules with the test clock (`tests/support/clock.ts`).
4. `bun run typecheck`, `bun --no-env-file test`, `git diff --check`, button lint, and `docker build --target verify` pass.
5. Module `ready: true`, Settings → Modules lists it, turning it off hides launcher/routes/Today/search scope.
6. Its docs entries (API_CONTRACTS, THREAT_MODEL, TEST_PLAN) and "Decisions as built" are written.

### F.5 Wave 3 acceptance

- Every §C flow marked W3 demonstrated in the browser in one scripted walkthrough (`docs/plan/qa/workspace-modules.md` checklist): booking → contact + event + card + CRM timeline + time logged on the booking; form → card + contact + deal; standup with goal updates and blockers; goal auto-progress from tasks, time, CRM, forms, check-ins; card dialog shows Goal and Time; Today shows all six modules' sections and quick actions; search All finds one item per module.
- `scripts/workspaceAgentEval.ts` passes with the scripted provider; a real-model run is recorded as an operator item in TODO.md (as for reports).
- Reports "This workspace" source: generate a report "Hours by client this month", "Pipeline by stage", "NPS by week" with the scripted provider; filters and schedules work; owner-access behavior matches Q3's answer.
- Docs: USING, site sections for six modules (docsSite test), OPERATIONS (public pages policies, external mail caps), CHANGELOG.

### F.6 Lane brief template (copy into each agent prompt)

> You are lane **<LANE>** of docs/plan/WORKSPACE_MODULES.md. Work in your own worktree on a branch from `feat/workspace-modules` (after the Wave 1 merge). Read §0, §B, §D.<n>, §E, §F.3–F.4 and the repo rules in TODO.md "Standing rules for agent briefs". Use only foundation APIs (§F.2) for shared concerns. Own only the files listed for your lane in §F.3; append-only edits elsewhere as listed. Migrations: <ids>. Decisions: <range>. Threats: <range>. Port <port>, origin `<lane>.localhost:<port>`. Done = §F.4. Do not push; report branch, commits, screenshots, test results, and decisions as built.

---

## G. Open questions for the product owner

- **Q1 Outside calendars for Bookings.** v1 checks only Nook calendars for busy time. Do you want, in v1.1, read-only busy sync from Google/Outlook (via the existing Google sign-in integration or an ICS "secret address" fetched through the egress guard)? Without it, people who live in Google Calendar will get double-booked. Recommendation: ICS busy subscription first (no OAuth scopes), Google Calendar API later.
- **Q2 Public pages policy defaults.** Public forms and booking pages are off by default and need an admin to enable. OK, or should Bookings be on by default since it's useless without public pages?
- **Q3 Reports on workspace data.** Should a shared report built on "This workspace" show viewers the data the **owner** can read (consistent numbers, matches how the `nook` doc source works) or each **viewer's** own access (safer, numbers differ by viewer)? Recommendation: owner's access with a visible "Data as seen by <owner>" label, and only for reports shared with people who already read the module. Also: is single-dataset structured querying enough for v1, or is SQL over workspace data required?
- **Q4 Goal roll-up privacy.** A parent goal's progress includes children the viewer can't open (their progress is shown anonymously). Accept, or exclude hidden children per viewer (numbers then differ by viewer)?
- **Q5 Time visibility on cards.** Should anyone who can read a card see its worklogs (Jira behavior, D872 default) or only totals?
- **Q6 Currency.** One workspace currency for v1 with per-project/per-deal override and no conversion. Enough?
- **Q7 Naming.** Module names "Forms" (includes polls), "Time", "Goals", "Check-ins", "CRM", "Bookings". Prefer "Contacts" over "CRM", or "Standups" over "Check-ins"?
- **Q8 Guests.** Guests can answer forms/check-ins shared with them and read goals shared with them, nothing else in the new modules. Should guests be bookable hosts or log time (contractors)? Recommendation: allow guests to log time on projects they're members of (`time_project` member) — a common contractor case.
- **Q9 Email to outsiders.** Bookings and time polls email people outside the workspace. Is that acceptable for your mail provider/domain reputation, with the caps in §B.7?

### G.1 Product owner answers (2026-11-13) — these override the defaults above

- **Q1 → ICS busy feed in v1.** Each host can add one or more private ICS URLs (Google/Outlook "secret address"); BOOK fetches them through the egress guard on a schedule (and on demand before offering slots, with a short cache), expands recurrences, and treats them as busy. Stored URLs are secrets (encrypted at rest like other credentials, never returned in full to the client or MCP). Google OAuth sync stays out of scope.
- **Q2 → Public pages ON by default.** The admin policy for public forms, polls and booking pages defaults to **enabled**; admins can turn each off in Settings. All anti-abuse controls in §B.8 stay mandatory, and the `/security-review` of public routes remains a release gate.
- **Q5 → Worklogs visible to everyone who can read the card** (D872 default as written).
- **Q7 → Names:** **Contacts** (companies and deals live inside it; the module id may stay `crm` internally, but every user-facing label, nav entry and URL says Contacts: `/contacts/...`), **Standups** (user-facing name for the check-ins module, `/standups/...`; it still covers retros and pulse surveys as standup templates), and **Forms**, **Time**, **Goals**, **Bookings** unchanged.
- **New module: Townhall** (the product owner added it). An all-hands / AMA module in the Slido / Mentimeter / Pigeonhole space, built on the shared question engine and Polls: a Townhall session (optionally linked to a Calendar event) collects questions before and during the meeting; people ask named or anonymous (if the host allows), upvote, and comment; moderators approve/hide/merge/mark answered and pin the current question; live polls, word clouds and ratings run during the session; a presenter view (large, high-contrast, auto-updating) for screen share; after the session a recap (answered/unanswered, poll results, notes link) is posted and open questions can become cards. MCP: list/get sessions, ask, upvote, moderate (scoped), export recap. Lane **TOWNHALL**: migrations 115–117, decisions D1070–D1099, threats T610–T619, port 2223, origin `townhall.localhost:2223`; it depends on FORMS' poll pieces only through Wave 1 foundations (question engine) — live poll widgets it needs are in W1-UI.
- **Defaults chosen by the director for the rest:** Q3 → each **viewer's** own access (numbers may differ by viewer; safer), single-dataset structured queries are enough for v1. Q4 → exclude children the viewer can't open from their roll-up only when shown as a list; the parent's stored progress stays owner-computed and is labelled "includes items you can't open" when any are hidden. Q6 → one workspace currency with per-project/per-deal override, no conversion. Q8 → guests may log time on time projects they are members of; guests cannot be booking hosts. Q9 → yes, with the §B.7 caps.
- **Base:** friendly URLs (migration 083, `shared/friendlyUrls.ts`: `slugify`, short ids, `itemPath`, `LINK_KINDS`; `GET /api/links/:kind/:ref`; `src/friendlyLinks.ts`, `FriendlyLinkGate.tsx`, `src/routeNames.ts`) are already in the base branch. Wave 1 **reuses** them (register the new kinds in `LINK_KINDS`/the resolver) instead of vendoring `shared/shortIds.ts`.

## H. Risks

- **Foundation scope creep delays all six lanes.** Wave 1 is large (5 migrations, ~12 registries, ~15 UI components). Mitigation: W1-CORE lands `shared/*` types first; the throwaway test module proves registries; anything not needed by two lanes moves to the lane.
- **CHECK-list rebuilds (085)** of `api_key_grants`, `proposals`, `notifications`, `team_settings`, plus `access_grants_v` are the riskiest migration in the plan (data loss would break keys and Inbox). Mitigation: 12-step pattern from 039 with copy/verify counts in the migration, a test on a production-shaped DB copy, and the restore drill before release.
- **Registry refactor of App.tsx/router.ts/mcpTools.ts** touches hot shared files; regressions there affect every module. Mitigation: W1-UI keeps existing routes untouched (registry only for new modules), route tests for every existing path.
- **Merge conflicts with PR #3 and the friendly-URLs lane** (083–084, D770–D789): both edit `router.ts`, card dialog, and possibly `shortIds`. Mitigation: Wave 1 starts after friendly URLs merges into the base, or W1 vendors the short-id spec and W3 dedupes.
- **Bookings correctness** (time zones, DST, recurring busy expansion, concurrency) is the highest-defect area; test with a matrix of zones and the test clock; manual QA across a DST boundary.
- **Public pages** are Nook's first anonymous write surface (chat links are read-only). Abuse, spam mail, and DoS are real; the policy defaults off and the security review (`/security-review`) of BOOK and FORMS public routes is a release gate.
- **Goal auto-progress performance**: recomputing tasks-sourced KRs over large boards on every card change. Debounce + bounded queries + budgets; measure with 50k cards.
- **Reports integration** may not fit the SQL-centric report model cleanly; W3-REPORTS is cut first if late (module Insights already cover in-module reporting).
- **UI consistency across six parallel lanes**: mitigated by mandatory shared components, ModuleHome scaffold, and a design review of each lane's screenshots by one reviewer before merge.
- **SQLite growth**: responses, time entries, kr_values, item_activity, schedule_fires, public_submissions_log grow unbounded except where retention is stated; add retention for `schedule_fires` (90 days) and `kr_values` compaction (D903).
