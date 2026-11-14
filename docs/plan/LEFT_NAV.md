# Collapsible left navigation: plan

Status: proposal, not built. Decision ids are allocated when this is accepted.

## 1. Problem (measured at 1440×900 and 390×844, current build)

- **Every top-bar app spends 76px on a global header** (`header.app-page-header`, src/appShell.css:11) that holds only Home, the app name and account actions (Settings, Inbox, timer, bell, avatar, Sign out). On phone it is 83px.
- **No app switcher exists.** Getting from Contacts to Time means going back through Home. Only Notes has a keyboard shortcut, and it only searches notes.
- **The seven workspace modules** (Forms, Time, Goals, Standups, Contacts, Bookings, Townhall) share `ModuleHome`. Content starts at **243px**: the 76px bar, a 44px title row that repeats the app name, 41px of tabs and 36px of filters. On phone it reaches 294–298px, because the 7-tab apps wrap their tabs onto two rows.
- **Worst cases:**

  | Page | Content starts at 1440 | Content starts at 390 |
  |---|---|---|
  | Tasks home (129px intro, then Boards / My work / Views segments) | 342–358px | 388px |
  | Collections home | 338–364px | 380px |
  | Form editor (bar, tabs, crumbs and a segmented control, stacked) | 260px | 341px |
  | Reports | 186px | 315px |

- **Three different shells exist today:**
  - the top bar (most apps);
  - the Home header;
  - a 230px left pane in Notes and Files, which carries the brand, Home, a collapse button and the account footer, with no top bar.

  Reports (264px) and Settings (264px) each have their own left pane under the top bar. Chat has a 300px list pane. Only Notes and Files have phone bottom navigation.

Notes and Files already show that the left-pane pattern works. The plan generalises it.

## 2. Target design

### 2.1 One app frame, one sidebar

A new `AppFrame` wraps every signed-in app page. It replaces the copy-pasted `app-page-header` blocks and Notes' inline shell. It has two parts: `AppSidebar` on the left and the page on the right.

The sidebar, from top to bottom:

1. **Workspace brand and collapse toggle.**
2. **Search / jump to (⌘K).** It opens a command palette in phase 4; until then it is the existing global search.
3. **Home, Inbox (with badge), Notifications (with badge).**
4. **Apps**, in `MODULES` order, filtered exactly as the launcher is today: `disabledModules`, `unavailableModules(features)`, guest rules, and `readyWorkspaceModules()`.
   - The **active app expands in place** to show its sections (§2.3).
   - Other apps stay one row each.
5. **Footer:** the running timer chip (Time's `TopBarItems`), Settings, and an account row (avatar and name, opening a menu with Profile and Sign out).

**Three states:**

| State | Where | Behaviour |
|---|---|---|
| Expanded (240px) | Desktop default, ≥1021px | Labels, the active app's sections nested under it. |
| Rail (56px) | User-collapsed, or the default at 761–1020px | Icons only, tooltips. Hover or focus on an app shows a flyout with its sections. |
| Drawer | Phone, ≤760px | Hidden. A menu button in the page header opens it full-height over the page, with the same tree. It closes on navigation. |

The collapse state is saved in `localStorage` (`nook.sidebar`), so it works without a server change. The toggle shortcut is ⌘\ (Ctrl+\ on Windows and Linux), plus the button.

Full-screen surfaces fall back to the rail automatically: a whiteboard canvas, a task card opened full-page, and the form editor's preview mode. Public pages (booking, form and Townhall links) never get the frame.

### 2.2 The page header shrinks to one row

The global bar goes away. Each page keeps one header row, about 52px:

```
[≡ phone only]  Contacts › Deals            [page actions: search, New, ⋯]   [🔔]
```

- **Title.** The app name, and the section name when the section isn't obvious. This replaces both the 76px bar and ModuleHome's 44px title row.
- **Page actions.** Whatever is on the right today: New, filters, ⋯.
- **The bell stays visible on desktop**, top right, so notifications don't need the sidebar open. On phone it moves into the drawer, and the badge shows on the ≡ button.

### 2.3 What moves into the sidebar, and what stays on the page

**Rule:** if a control changes *what you are looking at*, and has its own URL, it is navigation and goes in the sidebar. If it changes *how you see the same thing* (view mode, filter, sort, search), it stays in the page toolbar.

| App | Into the sidebar (nested under the app) | Stays on the page |
|---|---|---|
| Forms | My forms, Shared, To answer, Insights | Type chips (All / Forms / Polls / Find a time); a form's Respond / Edit / Results tabs (they are per item) |
| Time | Timer, Timesheet, Reports, Projects | – |
| Goals | Tree, List, Timeline, Mine, Insights | Period and owner filters |
| Standups | Standups, Feed. Per standup: Rounds, Insights, Settings | – |
| Contacts | People, Companies, Deals, Lists, Follow-ups, Insights, Settings | Search, pipeline picker |
| Bookings | Upcoming, Past, Cancelled, Booking types, Availability, Insights, Profile | – |
| Townhall | Sessions, Insights | All / Live / Upcoming / Past chips; a session's Q&A / Polls / Recap |
| Tasks | Boards, My work, Views, plus up to 8 recent or starred boards | Board view switch (Board / List / Table / Timeline / Calendar), filter bar, sprint bar |
| Inbox | Pending, History, Routines | – |
| Reports | All, Favorites, Unfiled, Folders, Lists, Shared (today's `ReportFolderNav`) | Report toolbar, filters |
| Settings | The hub groups (Account / Workspace / Team, from `hubEntries`) | AI and Keys tabs inside a section |
| Notes | Home, All, Shared, Folders tree (today's `folder-pane`) | The 320px note list and the editor |
| Files | Folders tree | File list, view toggle, Upload |
| Collections | Up to 8 recent collections, then All collections | The view chips inside a collection |
| Calendar, Whiteboards, Vault, Chat | The app row only (Chat: optionally New chat and Audit) | Agenda / Month switch; the whiteboard folder select; the Chat list pane stays (it lists items, it isn't navigation) |

Notes, Files, Reports and Settings lose their own left panes, because their trees now live in the sidebar. That gives the sidebar one consistent shape and removes the 264px panes. Item lists (the Notes list, the Chat list) stay as content columns.

### 2.4 Home

- The **Apps tile row is removed on desktop**, because the sidebar is the launcher.
- On phone the tiles stay, because the drawer is one tap further away and the tiles are the familiar start page.
- **Quick actions stay** on both. The hero greeting shrinks to one line.
- This keeps D50's "Today, not a launcher" direction.

### 2.5 Phone

- The ≡ button in the page header opens the drawer.
- Module tabs no longer wrap to two rows, because they are in the drawer. The header title says the section ("Contacts · Deals").
- An optional one-row horizontally scrolling chip strip under the title can show sibling sections for one-tap switching. It is decided in phase 2 after a screenshot check against §E.1's 375px rule.
- Notes and Files keep their bottom tab bars: Folders opens the drawer at the Notes or Files section.

### 2.6 Expected gain

These are estimates, to be confirmed with screenshots after each phase.

| Page (1440) | Now | After |
|---|---|---|
| ModuleHome apps | 243 | ~90 (52 header + 36 filters) |
| Tasks board | 192 | ~140 (52 + board toolbar + filters) |
| Tasks home | 342 | ~110 (segments move to the sidebar; intro becomes one line) |
| Collections home | 338 | ~100 |
| Calendar | 148 | ~100 |
| Reports | 186 | ~130, and +264px of width (the sidebar replaces its pane) |
| Notes / Files | 0 top | Unchanged height; Notes merges the 230 folder pane into the 240 sidebar, a net change of +10px width |

Phone, ModuleHome apps: 294 → about 110 (a 56px header with ≡ and title, plus filters).

## 3. Architecture

**New pieces:**

- **`src/shell/AppFrame.tsx`** and **`src/shell/AppSidebar.tsx`**, plus **`src/shell/sidebar.css`**.
  - The frame's grid is `[sidebar] [page]`. The page stays its own scroll container, as `scrollShells` expects.
- **`src/shell/navModel.ts`**: a pure function `(modules, features, role, route, recents) → NavTree`.
  - It reuses `MODULES`, `unavailableModules`, `hiddenModuleForApp` and `readyWorkspaceModules`. Hiding remains presentation, not access control (T97).
  - It is unit-tested on its own.
- **A `sections` field on each workspace module definition** (`module.tsx`): `{ id, label, icon?, route, badge? }[]`.
  - ModuleHome's tabs and the sidebar both read it, so the two never drift.
  - Core apps (Tasks, Inbox, Reports, Settings, Notes, Files) get small adapters in `navModel` that read their existing route and segment definitions.
- **`useSidebarState()`**: expanded, rail or drawer; the `localStorage` key `nook.sidebar`; the breakpoint defaults; ⌘\.

**Navigation goes through the existing paths.** Sidebar links call `openApp(section)` or `openContentPath(href)` (D1260). That way:
- the Notes save-on-leave guard and the Settings hub leave guard still run;
- history state (`mynotes.app-shell`) stays correct.

Plain `<a href>` links are used for middle-click and copy-link, with `preventDefault` for in-app navigation.

**Accessibility:**
- `nav[aria-label="Workspace"]`, with `aria-current="page"` on the active item.
- The collapse button has `aria-expanded`.
- The drawer is a modal dialog with a focus trap and Escape to close.
- In rail mode, flyouts open on focus as well as on hover.

**No server change is needed** for phases 1–3. Syncing the collapse state across devices would mean adding a field to the `.strict()` schema in `server/preferences.ts`. That is deferred.

## 4. Phases

Each phase ships as its own PR, with screenshots at 1440, 1024 and 390, and the live checks from earlier waves.

1. **Frame and sidebar (app level only).**
   - Add `AppFrame` and `AppSidebar` with the expanded, rail and drawer states.
   - Mount the frame on every top-bar app.
   - Remove `app-page-header` and add the one-row page header.
   - Move account actions, Inbox, Settings and the timer into the sidebar.
   - Remove the Home tile row on desktop.
   - Notes and Files keep their own panes for now; their brand, Home and account footer are dropped.
2. **Sections.**
   - Add `sections` to the seven workspace modules. ModuleHome drops its title row and its desktop tabs.
   - Move Tasks segments, Inbox segments and the Tasks and Collections recents into the sidebar.
   - Decide the phone chip strip.
3. **Fold in app panes.**
   - Move the trees of Notes folders, Files folders, the Reports folder nav and the Settings hub nav into the sidebar.
   - Retire `folder-pane`, `reports-sidebar` and `settings-hub-nav` on desktop, and Notes/Files `collapsed`.
4. **Extras:**
   - a ⌘K command palette (jump to app, section, recent item, quick action), which also fills the empty "?" shortcut sheet from `module.shortcuts`;
   - pinning and reordering apps;
   - collapse state synced through `/api/preferences`.

## 5. Risks and costs

- **Tests.** About 34 test files read `App.tsx` and shell source strings. Phase 1 rewrites these:
  - `phonePageName`, `appShell`, `modules`, `todayLayout`, `scrollShells`, `notesInboxRow`, `settingsHubReview`, `workspaceUi` and `v029LayoutFixes`;
  - the `TODAY_APPS` assertions in `collectionsApp` and `calendarRoute`.

  New behaviour gets behaviour tests (navModel output, sidebar rendering per role and module set) rather than more source-string pins.
- **Notes is rendered inline in `App.tsx`** (2398–2613). Phase 3 should first extract it into `NotesApp.tsx`. That is a mechanical but large move.
- **Leave guards.** Every sidebar link must go through `openApp` or `openContentPath`, or unsaved Notes and Settings edits can be lost.
- **Guests and hidden modules.** Behaviour must stay identical to today's launcher. The navModel tests cover each role and feature combination.
- **Muscle memory.** Users lose the Home tile grid on desktop. Home stays one click away, at the top of the sidebar.

## 6. Open decisions

Each has a recommended default.

1. **Desktop default: expanded (240px) or rail (56px)?** Recommended: expanded at ≥1280px, rail at 761–1279px, and the user's choice always wins once set.
2. **Notes, Files, Reports and Settings trees into the global sidebar (phase 3), or keep their own panes beside a rail?** Recommended: move them into the sidebar.
3. **Home tiles on phone: keep or remove?** Recommended: keep.
4. **Phone sibling-section chip strip: yes or no?** Recommended: decide from screenshots in phase 2.
