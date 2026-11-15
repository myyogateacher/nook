# Collapsible left navigation: plan

Status: phase 1 built (branch `feat/left-nav-phase1`, decisions D1270–D1279 in §7). Phases 2–4 are proposals.

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

## 7. Decisions

### Phase 1: frame and sidebar (branch `feat/left-nav-phase1`, decisions D1270–D1279)

§6's recommended defaults were taken: expanded from 1280 px, the rail from 761 to 1279 px, the person's choice wins once set; Home's tiles stay on phones only; the app trees move into the sidebar in phase 3.

| ID | Decision |
|---|---|
| D1270 | **One app frame and one global sidebar** (`src/shell/AppFrame.tsx`, `AppSidebar.tsx`, `sidebar.css`) around every signed-in page: Home, every top-bar app, the seven workspace modules, Notes, and Files. The 2FA setup screen and public pages have none. The tree comes from `src/shell/navModel.ts`, a pure function of the person's disabled modules, the server's `features`, the role, and the app on screen. Its apps are Home's launcher tiles exactly: `MODULES` launcher entries in order, without modules that are off (`hiddenModuleForApp`), `unavailableModules(features)` (guests included), or workspace modules that are not `ready`. Inbox shows for members, viewers, and admins with the module on; Notifications with its module on; Search with Search and Notes on. A plain click goes through App's `openApp` (Notes saves first), App's leave guard (the Settings hub's key confirm), then the page's (`useShellLeaveGuard`: Files' uploads). Every item is a real `<a href>`, so middle-click and Copy link keep working. Clicking the app already on screen returns it to its own start page as a new entry, remounted so it reads the new location. |
| D1271 | **Sidebar states**: expanded 240 px, rail 56 px, or a phone drawer at 760 px and under. Without a choice the window decides (expanded from 1280 px). The collapse button and ⌘\ (Ctrl+\ elsewhere) toggle it; the choice is kept in `localStorage` `nook.sidebar` (`expanded` / `rail`) and wins on every computer-sized window, never on phones. In the rail each link keeps its label for its accessible name, and a tooltip shows on hover and on keyboard focus. The drawer is a modal dialog: focus moves in and is kept inside, Escape and the scrim close it, focus returns to ☰, and it closes after any navigation. |
| D1272 | **Badges in the sidebar**: the Inbox row shows the bounded pending count (`useInboxCount`), the Notifications row the unread count. The bell's poll now sends its count on `NOTIFICATIONS_POLLED` (`detail.unread`), so the sidebar takes it without another request; it also reads once on mount, on focus, and on marks elsewhere. On phones ☰ shows a dot while either has something new. |
| D1273 | **The one-row page header** (`src/shell/PageHeader.tsx`, 52 px; 56 px on phones): ☰ on phones, the page's title, the page's actions, and the bell on computers (on phones it is in the drawer). It keeps the `app-page-header` class, so sticky and flex rules still apply. The account row (`AccountActions`), the phone page-name line (`AppPageName`), `HeaderInboxButton`, and Notes' `SidebarInboxRow` are gone: Settings, Inbox, the timer chip, the person, and Sign out live in the sidebar. While 2FA setup is required, Settings has no sidebar and keeps Sign out in its header. Content widths that used `100vw` now use `100%` of their column. |
| D1274 | **ModuleHome's title row is the page header**: the module's icon, its h1 (same id, still focusable), the primary action, and ⋯ sit in the one header row. The 44 px title row and its 22 px gap above the tabs are gone, so module content starts at 151 px instead of 243 px at 1440. |
| D1275 | **Home's app tiles show on phones only** (CSS from 761 px): on a computer the sidebar is the launcher. Quick actions stay on both, and the greeting is a little smaller. |
| D1276 | **Notes and Files keep their own panes in phase 1**, inside the frame: their brand Home button, Home row, and account footer are gone (the sidebar has them). The pane header is 52 px and holds the pane's name, ☰ on phones, and the pane's own collapse button. Files' header row has no Inbox button any more. Files registers its upload leave guard with the frame. |
| D1277 | **Full-screen surfaces**: a whiteboard canvas still covers the window, and the sidebar under it is hidden from the frame. A task card opened full-page shows the sidebar as the rail whatever the setting (D1279). |
| D1278 | **The sidebar's Search row opens Notes' search** (Notes, then focus in its search box; on phones the notes list first) until phase 4's ⌘K palette replaces it. |
| D1279 | **Review fixes**: rows are 30 px (29 px in the rail, whose header is 44 px), so the 16 apps and the footer fit a 900 px window expanded and an 800 px window in the rail; shorter windows scroll the list. Notes and Files lose their own collapse button and `collapsed` state: the global sidebar's toggle is the only one, and on a computer the pane's name is a small section label, not a second brand. A full-page task card holds the rail through `useShellRail` (replacing the CSS `:has()` rule): the toggle then reads "Expand sidebar", is `aria-disabled`, says "The sidebar stays narrow while a card is open full-page", and neither it nor ⌘\\ changes the saved choice. |

Measured with headless Chrome after phase 1, as "content starts at y" (the first content below the page's chrome; before → after):

| Page | 1440 | 390 |
|---|---|---|
| ModuleHome apps (Forms, Goals, Standups, Contacts, Bookings, Townhall) | 243 → 151 | 246–346 → 161–261 |
| Time | 195 → 103 | 194 → 109 |
| Form editor | 274 → 215 | 349 → 279 |
| Tasks home | 358 → 334 | 404 → 377 |
| Tasks board | 192 → 168 | 305 → 278 |
| Collections home | 364 → 340 | 406 → 379 |
| Calendar | 166 → 142 | 169 → 142 |
| Reports | 200 → 176 | 329 → 302 |
| Settings | 163 → 139 | 83 → 56 |
| Home, Vault, Chat | 76–100 → 52–76 | 68–107 → 56–80 |
| Notes, Files | unchanged (148 / 190) | 70 → 56 |

Left for phase 2: the modules' `sections` in the sidebar (ModuleHome's tabs stay on the page), the Tasks and Collections intros and segments, and the phone chip strip. For phase 3: Notes', Files', Reports', and Settings' own panes.

