# Collapsible left navigation: plan

Status: phase 1 built (branch `feat/left-nav-phase1`, decisions D1270–D1279 in §7); phase 2 built (branch `feat/left-nav-phase2`, D1280–D1286); phase 3 built (branch `feat/left-nav-phase3`, D1287–D1292); phase 4 built (branch `feat/left-nav-phase4`, D1293–D1298, migration 122). The plan is complete.

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

**No server change is needed** for phases 1–3. Phase 4 syncs the sidebar's layout (collapse state, app order, pins, opened apps) through an optional `sidebar` field in the `.strict()` schema of `server/preferences.ts` and the `user_preferences.sidebar` column (migration 122, D1295).

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
4. **Extras** (built, D1293–D1298):
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


### Phase 2: sections (branch `feat/left-nav-phase2`, decisions D1280–D1286)

| ID | Decision |
|---|---|
| D1280 | **A module's sections are one list on its definition.** `WorkspaceClientModule.sections` (`{ id, label, path, search?, hiddenFor? }`, in each module's `sections.ts`) and an optional `sectionOf(route)`; `src/workspaceModules/sections.ts` filters them by role (presentation only, T97), formats their URLs, and finds the section a route belongs to (the module's own rule, else the longest path prefix, else the home section on the home route). The sidebar (navModel) and ModuleHome both read it, so they cannot drift. Forms: My forms, Shared with me, To answer, Insights. Time: Timer, Timesheet, Reports, Projects. Goals: Tree, List, Timeline, Mine, Insights (`?view=`). Standups: Standups, Feed. Contacts: People, Companies, Deals, Lists, Follow-ups, Insights, Settings. Bookings: Upcoming, Past, Cancelled, Booking types, Availability, Insights, Profile. Townhall: Sessions, Insights. None is role-gated today (each was shown to every role that opens the module), so the lists match for members, viewers, and guests. ModuleHome takes `sections` (the module, the role, the active section, counts) apart from `tabs`, which are now one item's own views only: a form's Respond / Edit / Results, a session's Q&A / Polls / Recap, and a standup's Rounds / Insights / Settings, which stay on the page (nesting them would need the standup's name in the sidebar; not trivially doable, left for phase 3). |
| D1281 | **Nesting.** The app on screen opens in place: its sections indented under its icon with a guide line, 28 px rows. The section on screen is `aria-current="page"`, its app row `aria-current="true"` (a lighter tint). The section comes from the address (a history signal in `src/shell/locationSignal.ts` follows every `pushState`/`replaceState` and Back/Forward), so a deep link such as `/contacts/deals` lights Deals and an item's page (one form, one session, one goal) lights none. On every page change the list scrolls to keep the open app and its sections in view (again for 1.5 s while the footer settles), never scrolling the app row off the top; the footer stays pinned. In the rail, hovering or focusing an app opens a flyout of its sections beside it (fixed, shifted up near the window's bottom); ArrowRight walks into it, Tab moves through it, Escape closes it and returns focus to the app. The phone drawer nests the same way, with 40–44 px rows. |
| D1282 | **Core apps and recents.** Small adapters in `navModel`: Tasks — Boards, My work, Views, then up to 8 recent boards; the Inbox — Pending, History, Routines; Collections — up to 8 recent collections, then All collections. Chat gets none (its list pane is content, and New chat / Audit fit badly as sections). Recents are this browser's (`localStorage` `nook.recent.<kind>.<userId>`, ids, names, and URLs only), recorded when a board or collection opens, and checked against the list the app already reads (`/api/tasks/boards`, `/api/collections`) while the app is on screen: a deleted or unshared item drops out, a rename shows, and a first visit is filled by last update. No server change. A section link goes through App's `openSectionPath`: Notes saves first, the frame has already asked App's and the page's leave guards, another app opens the path as a new entry, and the app on screen moves to its own section as a new entry and re-reads the address on `nook:shell-route` (the module host, Tasks, the Inbox, and Collections listen), without a remount. On a computer `nav.task-home-segments` and `.inbox-segments` are hidden (phones keep them). |
| D1283 | **Shorter intros, one title each.** The Tasks and Collections intros are one line: a 20 px h1 (Boards, My work, Views, All collections — the sidebar's section names, so the header's app name is not repeated), the summary on one truncated line (hidden on phones), and the primary button; the 36–72 px top padding is 20 px. The Inbox's title is the header's `h1#inbox-title` (it still labels the list), and a goal's page keeps its title beside its ring, its header holding only Back (`PageHeader`'s `title` is optional). |
| D1284 | **Disclosure for every app with sections** (product owner, phase 2 review). In the expanded sidebar and the drawer, a chevron at the row's end (its own target; `aria-expanded`, `aria-controls`, "Show Contacts sections") opens or closes that app's sections without leaving the page, so Contacts › Insights is one click from Notes. The app on screen is always open (its chevron can close it until another app opens); apps opened by their chevron stay open, kept in `localStorage` `nook.sidebar.expanded`. ArrowRight on a closed chevron opens it, ArrowLeft closes it. The rail keeps its flyout and has no chevrons. Every section is a real link. |
| D1285 | **Hover flyout in the expanded sidebar** (product owner). On a pointer that hovers precisely (`(hover: hover) and (pointer: fine)`), resting on an app whose sections are not already open in place shows the rail's flyout beside the sidebar's edge: it opens after 150 ms, closes 250 ms after the pointer leaves both the row and the flyout (an invisible bridge covers the gap, so a diagonal move keeps it), one at a time, never while the list scrolls, and Escape closes it. Keyboard focus (`:focus-visible`) on the app or its chevron opens it too. Touch and the phone drawer have no hover: the chevron opens sections in place. |
| D1286 | **Phones: a one-row sibling strip** (§6.4 decided). Under the header, the module's sections are one row that scrolls sideways (never two rows), the current one centred, and the header reads "Contacts · Deals". It is an exception to §E.1.5's "no horizontal scroll" in the same spirit as the timesheet's day strip: the same entries are in the drawer, so nothing is reachable only by scrolling, and one row saves the 41 px a wrapped second row cost. Tasks' and the Inbox's segments stay as they are on phones (three fit). |

Measured with headless Chrome after phase 2, as "content starts at y" (phase 1 → phase 2):

| Page | 1440 | 390 |
|---|---|---|
| ModuleHome apps with filters (Forms, Goals, Contacts, Townhall) | 151 → 98 | 261 → 213 (one-row strip, filters and search) |
| ModuleHome apps without filters (Standups, Bookings) | 151 → 98 | 161 → 161 |
| Time | 103 → 62 | 109 → 109 |
| Tasks home (Boards) | 334 → 124 | 377 → 194 |
| Collections home | 340 → 194 (under the row search) | 379 → 196 |
| Inbox (its 42 px h1 and 54 px segments gone on a computer) | intro line at ~100, list at ~130 | segments kept |
| A goal | one title, header holds Back | — |
| Form editor (a form's own tabs stay) | 215 → 215 | 279 → 279 |
| Tasks board | 168 → 168 | 278 → 278 |

Left for phase 3: the Notes, Files, Reports, and Settings trees; a standup's Rounds / Insights / Settings under the open standup (needs its name in the sidebar); Chat's New chat and Audit.


### Phase 3: the app panes fold into the sidebar (branch `feat/left-nav-phase3`, decisions D1287–D1292)

Notes was first moved out of `App.tsx` into `src/notes/NotesApp.tsx` with no change (§5's risk): App keeps Notes' state and its moves (`leaveNotes`, the `mynotes:last:<user>` restore, ⌘K and `/`, the phone panels and their history), NotesApp renders them.

| ID | Decision |
|---|---|
| D1287 | **The app draws its own tree in a sidebar slot.** The frame gives the app on screen one slot: under its row while its group is open (expanded sidebar, phone drawer), or inside its flyout (rail, or a closed group on hover). The app portals its tree there (`ShellSidebarPortal`, `useShellSidebarSlot`), so the state, drops, menus, and leave guards stay the app's own and nothing is duplicated in the shell; while no slot is shown nothing renders. Notes, Files, and Reports rows open like apps with sections while on screen (`NavItem.tree`, `TREE_APPS`). A portal's React events bubble through the app, not the nav, so the flyout's hover over the tree, the rail's tooltips (`data-sidebar-tip`), and the drawer's Escape, Tab trap, and close-on-pick are native listeners. Dragging a note or a file onto the app's rail icon opens its flyout as a drop target; it closes when the drag ends. The app row (or the footer's Settings) is `aria-current="true"` while the tree marks a row as the page, so one item is the page. |
| D1288 | **Notes' and Files' folders** (`SidebarFolderTree`, model in `src/shell/folderTree.ts`): All notes / All files and Shared with me, then a Folders heading with a small + (New folder, for the roles that may), then the folders nested by `parent_id` in the app's order (Notes nested nothing before; a folder whose parent is not listed sits at the top; cycles are cut). Counts per folder; a chevron on folders with subfolders, closed ones kept in `localStorage` `nook.sidebar.folders.<app>`, and the folders above the current one reopened when it changes; indentation stops at four levels (deeper names truncate); the current row scrolls into view; the footer stays pinned and the list scrolls. Rows are real links; a click goes through the app (`selectFolder`: Notes saves or publishes the open note first). Everything the panes did carries over: note and file drops (highlight, refusal, move), Files' drop candidates and the Attachments lock, Shared folders, Notes' Share button (on hover). The panes had no folder rename or context menu, so there is none to move. `aside.folder-pane` is hidden from 761 px; on phones it stays the Folders panel of the bottom tab bar (task 7: kept rather than opening the drawer, since it is part of the Folders / Notes / Editor history model and has 46 px rows). The drawer shows the same tree without the Share buttons. |
| D1289 | **Reports' nav** (`ReportFolderNav`, now with `hrefFor` so every view is a real link) in the slot with all its behaviour: report and folder drags (nest, reorder, refusal note), each folder's and list's ⋯ menu, New folder, New list. The 264 px `reports-sidebar` (and its sticky offset) is gone inside the frame, and from 761 px the folder chip and sheet that stood in for it under 1024 px; on phones the chip stays as the view's title and opens the global drawer, which carries the tree. A report's own page shows the tree read-only, linking to each view. |
| D1290 | **Settings: the list swaps to the hub's sections.** On a Settings, Team, or Bin page the sidebar's list is "‹ Back to apps", a Settings label, and the groups `hubGroups(hubEntries(…))` gives the role (Account, Workspace with the Bin's count, Team with Members' blocked count), as the sidebar's own 30 px rows with icons; "Back to apps" shows the apps without leaving the page and the footer's Settings brings the sections back. Chosen over expanding the footer row upward, which would push the timer and account up and squeeze the list in an 800 px window. Links go through the hub's `onSelect`, so its leave guard (`hubLeaveGuardRef`, a key shown once, Team → Policies' unsaved changes) runs as before; app links take it through the frame. `nav.settings-hub-nav` is hidden from 761 px; phones keep it as the drill-in list, and the two-factor setup screen (no frame) keeps it. |
| D1291 | **An open item's views and the module header.** `ModuleHome.tabsInSidebar` draws an item's views under its name in the slot: a standup's Rounds, Insights, Settings (Standups › Daily standup › Rounds). In the expanded sidebar the page's strip goes; the rail (its flyout comes and goes) and phones keep it, and their flyout and drawer list the views too. A form's Respond / Edit / Results stay on the page (§2.3). `ModuleHome.parent` puts the way back in the header ("Forms › Team feedback", a link), and the form page's breadcrumb row that repeated the title is gone. Chat keeps no sections (D1282): New chat and Audit are actions of its list pane, not places. |
| D1292 | **Long trees and the rail.** The sidebar list scrolls with the footer pinned; on a page change it keeps the app's row in view (D1281) and the tree then scrolls its current row into view. The flyout is 272 px wide for a tree and scrolls within the window's height. |

Measured with headless Chrome against phase 2 (same seed: 13 note/file folders three levels deep, 6 report folders, a list):

| Page | 1440 (expanded) | 1100 (rail) |
|---|---|---|
| Notes: the editor beside the 320 px list | 650 → 880 px (content starts at x 790 → 560) | 494 → 724 px |
| Files: the file list | 970 → 1200 px | 814 → 1044 px |
| Reports: the list | 936 → 1200 px (x 504 → 240); rows start at y 177 as before | 780 → 1044 px |
| Settings and Team: the section | 936 → 1200 px | 780 → 1044 px |
| Form editor | the breadcrumb row is gone; Forms › Team feedback is the header | same |


### Phase 4: palette, shortcuts, pins, and sync (branch `feat/left-nav-phase4`, decisions D1293–D1298)

| ID | Decision |
|---|---|
| D1293 | **The ⌘K command palette** (`src/shell/CommandPalette.tsx`, model in `paletteModel.ts`). ⌘K or Ctrl+K anywhere in the frame, and the sidebar's **Search** row (now a button with the shortcut beside it, `aria-keyshortcuts`), open a modal dialog: one combobox over a grouped listbox, `aria-activedescendant` on the box so focus never leaves it, ↑/↓ (wrapping), PageUp/PageDown, Ctrl+Home/End, Enter, Escape, Tab kept in the box, the pointer selecting as the keys do, and **Cancel** on phones. Entries are a pure function of the sidebar's tree, so visibility is the sidebar's exactly (guests, modules off or not offered, role-hidden sections): **Apps** (Home, Inbox, Notifications, pinned and other apps, Settings; their sections only once something is typed), **Recent** (the tree's recent boards and collections, and the five most recently edited notes from the list the tab already holds), **Quick actions** (Home's `visibleQuickActions`, so `hiddenFor` applies), **Commands** (Keyboard shortcuts, Customize sidebar, and collapse/expand when it can), and **Search notes for "…"** last whenever something is typed and Notes and Search are on. Matching is fuzzy but strict: every word of the query must match the entry's name with its app's ("con ins" → Contacts › Insights), as a run inside the text or as letter runs that each start a word ("cin"); letters scattered inside words never match ("ins" does not find Collections). A run at a word's start, earlier, and in the entry's own name ranks higher; the app on screen's sections rank first among equals; the group of the best match leads so Enter opens what ranks first. Every move goes through the frame's guards and App's helpers: `openFromSidebar`/`openSectionPath` (Notes saves first, the Settings hub's and the page's leave guards run), `openContentPath` for recent notes and quick-action paths (a note in Notes goes through `selectNote`), and `openSearch(query)` for Notes' search. Closing without a move returns focus where it was. |
| D1294 | **Pin and reorder apps.** The tree has a **Pinned** group above **Apps** (`NavTree.pinned`), both in the person's order (`arrangeApps` in `src/shell/sidebarPrefs.ts`, a pure function the navModel calls): apps the saved order lists come in its order, one it does not list (a module shipped later) lands after its default neighbour, and nothing that is off or not offered ever shows because it is pinned. Pointer path: app rows in the expanded sidebar and the rail drag (`application/x-nook-sidebar-app`, never confused with note or file drags), a line shows where they land, dropping in Pinned pins (an empty Pinned group appears as a drop zone while dragging) and among Apps unpins; only the moved app changes place in the full order, so hidden apps keep theirs. Accessible path: **Customize sidebar** (the ⋯ beside Apps, the account menu, the palette) is a sheet listing every app this person can have, Pinned first, with Move up / Move down (within its group; focus stays on the button), Pin (`aria-pressed`), and **Show**, which is Settings → Modules' own switch (`setModuleEnabled`): there is one hide mechanism. Reset clears order and pins. The rail, the phone drawer, and Home's phone tiles (`arrangedTodayApps`) follow the same order. |
| D1295 | **The layout syncs through `/api/preferences`.** Migration 122 adds `user_preferences.sidebar` (JSON object, CHECK ≤ 2,048 bytes); the strict PUT schema takes an optional `sidebar: { mode?, order?, pinned?, expanded? }` of known ids only (`shared/sidebar.ts`: the launcher sections, plus `inbox` for `expanded`), each list unique and at most one per app; absent keeps the saved layout (Settings → Modules saves only its list), `null` clears it; it shares the row's `revision`, so it stays one compare-and-swap, and the audit row carries it. localStorage stays the fast path (`nook.sidebar`, `nook.sidebar.expanded`, and the new `nook.sidebar.apps`): the sidebar draws from it at once; `useSidebarSync` reconciles on sign-in and whenever usePreferences re-reads (the tab coming back): a change made here that has not reached the server (`nook.sidebar.dirty` = the person's id) is sent, otherwise the server's copy wins field by field, and an empty server is seeded from this browser. Changes are sent 600 ms after the last one with the modules and the revision last read. A 409 on a layout-only save keeps the other device's modules and resends this tab's layout on its revision (the latest arrangement wins; nobody's module choice is undone); a 409 while a module toggle is pending keeps the old rule (the server's value and the conflict message). Presentation only (T97, threat model updated): the test shows a pinned app that is off stays hidden and its API still 404s for a stranger. |
| D1296 | **The "?" shortcut sheet** (`src/shell/shortcuts.ts`, `ShellSheets.tsx`): `?` outside a text field and without a modal, Keyboard shortcuts in the account menu, or the palette's command open a sheet with **Everywhere** (⌘K / Ctrl+K, ⌘\ / Ctrl+\, ?, ⌥T / Alt+T when Time is on), **On a page** (/, n, j / k, Esc), and the workspace module on screen's own `module.shortcuts` (declared since Wave 1 and shown nowhere until now). Each key is its own `<kbd>`, written for the platform. |
| D1297 | **⌘K is the palette everywhere, Notes included.** Notes' Ctrl/⌘+K focus-search is gone (its `/` stays, now ignoring a key another handler took); the palette's **Search notes for "…"** opens the same box with the query, and the sidebar's Search row opens the palette (it is always there; with Search or Notes off only the notes fallback goes). A page's own dialog keeps ⌘K while it is open. Settings → Modules' Search description says so. |
| D1298 | **No MCP tool for sidebar preferences.** MCP never read or wrote preferences (T97); the layout is how one person arranges their own UI, so an agent has nothing to do with it. No tool was added or renamed. |

Live checks (headless Chrome, port 4796 since 4795 was taken by another session's server): ⌘K → "contacts deals" → Enter from a note with a just-typed line opened `/contacts/deals` and the line was in the saved draft; a drag (Reports above Calendar, Goals into Pinned) survived a reload and reached the server; a fresh browser profile showed the same Pinned and Apps after sign-in; with another device turning Whiteboards off on a newer revision, a drag in the stale tab got 409, was resent on the new revision, and the server ended with both changes (Whiteboards off, the new order), the stale tab hiding Whiteboards.
