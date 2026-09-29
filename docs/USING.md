# Using Nook

This guide covers the apps a signed-in user sees. For installing, configuring, backing up, and upgrading a server, see [OPERATIONS.md](OPERATIONS.md). The same material is published at [pankajsoni19.github.io/nook](https://pankajsoni19.github.io/nook/).

## Home and URLs

Signing in lands on **Home**, which is also **Today** (below): a row of app links (Notes, Files, Tasks, Collections, Calendar) under the greeting. The account row at the top of Today, Tasks, Collections, Calendar, the Bin, and Team holds your name, **Settings**, **Bin** (with a small count when it holds items), **Team**, **Sign out**, and the notification bell. Notes and Files keep Settings, Bin, and Sign out in the sidebar footer instead, and Files has the bell in the file list header next to **Upload**. Each app's **Home** control leads back. Each view has a real URL, and reloading or opening a link resumes that view (a signed-out visit shows the login screen first, then continues to the requested page):

| URL | View |
| --- | --- |
| `/` | Home |
| `/notes` | Notes, all folders (resumes your last note when no folder or note is named) |
| `/notes/folder/<folder-id>` | Notes in one folder |
| `/notes/shared` | Notes shared with you |
| `/notes/<note-id>` | One note in the editor |
| `/files` | Files, all folders |
| `/files/folder/<folder-id>` | Files in one folder |
| `/files/shared` | Files shared with you |
| `/files/<file-id>` | One file's preview and details |
| `/tasks` | Tasks home, Boards: your boards and boards shared with you |
| `/tasks/my` | Tasks home, My work: cards assigned to you on every board |
| `/tasks/views`, `/tasks/views/<view-id>` | Tasks home, Views: your saved views, and one view |
| `/tasks/<board-id>` | One board (the view, grouping, sort, filters, and sprint ride along in the query) |
| `/tasks/<board-id>/sprints` | The board's Sprints sheet, open over the board |
| `/tasks/<board-id>/card/<card-id>` | One card, open over its board |
| `/tasks/<board-id>/card/<card-id>/full` | One card as a full page |
| `/collections` | Collections: yours and those shared with you |
| `/collections/<collection-id>` | One collection's table (a card list on phones) |
| `/collections/<collection-id>/view/<view-id>` | A saved view of a collection |
| `/collections/<collection-id>/row/<row-id>` | One row (a side pane on desktop, a full screen on phones) |
| `/calendar` | Calendar agenda |
| `/calendar/month/<yyyy-mm>` | One month |
| `/calendar/event/<event-id>` | One event |
| `/notifications` | Your notifications |
| `/bin` | Bin |
| `/team`, `/team/<user-id>` | Team, and one person's page |
| `/inbox`, `/inbox/history` | Inbox: proposals waiting for you, and resolved ones |
| `/inbox/p/<proposal-id>` | One proposal with its changes |
| `/inbox/routines` | Routines: prompts your agents run on a schedule |

Unknown paths open Home. A link to a note or file you cannot read (or that is missing or in the Bin) falls back to the list with a message. On phones, Back steps from the editor or preview to the list, then to the folders, then to Home, without leaving the site; in Tasks it steps from a card to its board, to the board list, then to Home. With a dialog or sheet open, Back only closes it.

**Dropdowns.** Choices such as a calendar, a colour, a field type, or a sort field open a list under the control on desktop and a sheet from the bottom on phones. Type the first letters to jump to a choice, use the arrow keys, Home, and End to move, Enter or Space to choose, and Escape to close without choosing; long lists have a search box. On phones, Back closes the sheet and leaves the page and any dialog under it as they were.

## Today

Home shows what needs you today, in sections of up to ten items each, in three groups: **Today** (Due soon, Upcoming, My tasks, Proposals awaiting you), **Recent work** (Recent notes, Recent files, Recently edited rows), and **Housekeeping** (drafts, Leaving the Bin soon, Storage). Wide screens show one group per column, medium screens two columns with Housekeeping below, and phones one column. A section with items shows its count ("Due soon · 3"); an empty one folds into a single line, and a group with nothing in it says **All clear**. Every item is a link; Back from it returns to Today. **View all** opens the owning app.

| Section | Shows |
| --- | --- |
| Due soon | Cards due within seven days, or overdue, on boards you can open, except in done columns. A card with a due time shows it in your time zone ("Due today at 17:00") and counts as overdue once that time has passed |
| My tasks | Open cards assigned to you or added by you |
| Recent notes | Notes you can read, newest change first (someone else's note appears once it is published, with its published title) |
| Unpublished drafts | Your notes whose draft differs from what is published |
| Proposals awaiting you | Changes your MCP keys suggested that wait for you in the Inbox, including note drafts they wrote (this replaces Drafts from agents; if you had hidden that section, this one stays hidden) |
| Recent files | Files you can see in Files |
| Recently edited rows | Rows in collections you can open, most recently changed first (titles only) |
| Leaving the Bin soon | Your Bin items that are deleted forever within three days |
| Upcoming | Events on your calendars over the next seven days |
| Storage | How much of your storage quota is used, and how much of it is in the Bin |

**Refresh** reloads everything; coming back to the tab after a minute reloads too. If one section fails, it shows **Retry** and the others still load. **Customize** shows or hides sections; the choice is kept in this browser for your account only.

## Sharing and access

Everything starts private. To share a note, folder, file, board, task view, collection, or calendar, use its **Share** button: it opens the **Access sheet** (a side panel on a computer, a full-screen sheet on a phone; Back or Escape closes it).

- **Who can open this.** **Only me**; **People and groups I choose**; or **Everyone signed in** (everyone on this Nook except guests, never public). Notes and files can also **Use folder access**: they follow their folder's sharing, which never reaches subfolders.
- **People and groups.** Type in **Add people or groups…** and pick: groups come first with their size ("6 people · includes 2 guests"), then people with their team role. Each one gets a level from the menu next to it; the default is what sharing meant before (Can edit on boards, Can view elsewhere).
- **Levels.** Each person or group gets one of the levels the item offers:

| Item | Can view | Can comment | Can edit | Manager |
| --- | --- | --- | --- | --- |
| Notes and folders | Read the published note | — | Write the draft and publish a new version (never share, move, restore, or delete) | — |
| Files, task views | Open and download | — | — | — |
| Boards | Read cards and comments | Also comment and react | Also add, change, move, and bin cards, and add tags | Also rename the board, change its structure, columns, WIP limits, tags, and sprints, and share it up to Can edit |
| Collections | Read rows and export | — | Also add, change, undo, and delete rows | Also rename, change fields and saved views, and share up to Can edit |
| Calendars | See events | — | Also add and change events | Also rename, recolour, and share up to Can edit |

  **Everyone signed in** has its own level on boards, collections, and calendars (the menu next to that choice). Someone who gets two levels (directly and through a group, or through everyone) gets the higher one. Their **team role still caps it**: a viewer or guest only ever reads, and the sheet shows "Viewer role reads only" next to them.
- **Managers** see the same sheet without the "Who can open this" choice: they add and change people and groups up to Can edit, and cannot change other managers or their own access (their own row says **Ask the owner to change your access**). Only the owner changes who can open the item, makes managers, or deletes it.
- **Groups.** Admins decide who is in a group (Team → Groups); the sheet says so under each group, and notes when an admin added themselves. Sharing with a group reaches its members as they change: someone added later gets access, someone removed loses it at once.
- **Saving.** **Save** applies everything at once. If someone else changed the access while you had the sheet open, Nook shows their version instead of overwriting it; make your change again.
- **Guests.** An admin can turn **sharing with guests** off in Team → Policies. Then guests are left out of the list, groups that include guests cannot be chosen, and saving a share that would reach a guest is refused. In Team → Groups, a guest cannot be added to a group that is already shared with items, and someone in such a group cannot be made a guest (remove them from the group first). The switch is not retroactive: shares with guests made before it was turned off, and guests already in groups, stay until they are removed.

## Notes

Notes are Markdown documents organised in folders. Edits begin as drafts that save automatically; **Publish** records an immutable version that can be compared with others or restored. Notes start private; share a note or a whole folder from the [Access sheet](#sharing-and-access). A note's own sharing takes precedence over its folder's. People at **Can edit** on a note (or its folder) write its draft and publish new versions under their own name; only the owner shares, moves, restores versions, or deletes it.

### Editor

Type `/` for the command menu. Besides headings, lists, checklists, quotes, and code blocks:

- **`/image`**, or paste or drop an image into the editor, uploads it to the note's folder in Files and embeds it. Only PNG, JPEG, GIF, and WebP are accepted, and the server's own type check must agree. Removing an image from a note leaves the file in Files.
- **`/table`** inserts a 3×3 table with a header row. A floating toolbar adds or removes rows and columns and deletes the table; tables are saved as GitHub-flavoured Markdown pipe tables and scroll sideways on phones.
- **Download as PDF** (editor toolbar, or the actions menu on phones) opens the browser's print dialog with a print layout of the note; choose "Save as PDF".

**Limitation:** an embedded image follows the sharing of the **folder** it was uploaded to, not the note's own sharing. If you share a note more widely than its folder, those readers see the text but a broken image. Nothing leaks; share the folder (or the image file) too if they need the images.

### Search

The search box at the top of the note list searches the text of your notes, not just their titles. Press `Ctrl+K` (`⌘K` on a Mac) or `/` to jump to it, and `Esc` to clear it.

- **What matches.** Every word you type must appear in the note, in any order; case and accents are ignored, so `creme` finds "Crème". The last word matches as a prefix while you type (`brul` finds "brûlée"); end the query with a space to match whole words only. Put words in `"double quotes"` to match them as an exact phrase. Punctuation and operators such as `AND`, `OR`, `NOT`, `*`, or `title:` are treated as ordinary text, not search syntax. Link text, image descriptions, and code are searched; link addresses are not.
- **What you see.** Your own notes are searched as you last saved them, including unpublished drafts, which are marked **Draft**. Notes shared with you are searched as their latest published version; you never see someone else's draft. Notes in the Bin are not searched until restored. Matches in the title rank first, and each result shows a highlighted excerpt, its folder, its owner when it is not yours, and when it was last edited.
- **Scope.** Search covers the section you are in: All notes, Shared with me, or one folder. Choose **Search all notes** to widen it. Opening a result from outside the current section switches to All notes.
- **Keyboard and phone.** Use ↑ and ↓ to move through results and Enter to open one. On phones, Back from a note returns to the results with your query kept; Back again closes the search. The query is kept in the browser tab's history state, never in the URL.
- **Limits.** 20 searches per 10 seconds per user; the list falls back to title matches and says so if you go faster. Queries are limited to 200 characters. Files are not searched yet.

## Files

Files lists documents in the same folders as your notes. Each app shows only its own item type. The file list header holds the file count, the List / Grid toggle, sort, the notification bell, and **Upload** (hidden for viewers and guests); Settings, Bin, and Sign out are in the sidebar footer, as in Notes.

- **Upload** with the Upload button, by dropping files from your computer onto the list, or on phones from the upload sheet. Uploads run two at a time with a progress bar, and can be cancelled or retried. Each file may be up to `MAX_UPLOAD_BYTES` (100 MiB by default) and counts towards `USER_STORAGE_QUOTA_BYTES` (see [OPERATIONS.md](OPERATIONS.md#configuration)).
- **List and grid views.** The List / Grid toggle next to sort switches between rows and responsive tiles with image thumbnails and type icons. The choice is remembered per user in this browser. Sort by name, date, or size, and filter by name.
- **Preview.** On desktop the list takes the full width until a file is selected; the preview then opens as a pane on the right. Close (×) or `Esc` in the pane deselects the file. On phones the preview is its own screen.
- **Any file type is stored**, but only safe types are shown in the app. The server decides the type from the file's first bytes, not from its name or the browser's claim:

  | Type | Preview |
  | --- | --- |
  | PNG, JPEG, GIF, WebP | shown inline |
  | PDF | opens in a new browser tab |
  | UTF-8 text (`.txt`, `.md`, `.csv`, `.tsv`, `.log`, `.json`) | first 1 MiB shown as plain text, with a notice when truncated |
  | MP3, Ogg, WAV, M4A, MP4, WebM | audio or video player |
  | everything else (including SVG, HTML, Office files, archives) | download only |

- **Actions.** **Download**, **Rename**, **Move**, **Share**, and **Delete** are in each item's ⋯ menu (an action sheet on phones). Drag a file onto a folder to move it; the toast states the new effective sharing.
- **Keyboard.** ↑/↓ move the selection (←/→ too in the grid), Enter opens the preview, F2 renames, and Delete or Backspace deletes your own files.
- **Sharing** works like notes ([Access sheet](#sharing-and-access)): a file inherits its folder's sharing unless you give it its own. People you share with can preview and download but not change anything.
- **Delete** moves the file to the Bin; the toast offers **Undo** for a few seconds.

Nook does **not** strip EXIF or other embedded metadata (for example GPS location or author) from uploaded images or PDFs. Remove it before uploading if you plan to share the file.

## Tasks

Tasks holds kanban boards. **New board** asks for a name and a template: **Simple kanban** (To do, Doing, Done; the default), **Personal to-do**, **Task checklist**, **Scrum sprint board**, **Epic › Story › Subtask**, **Bug triage** (with Bug and Regression tags), or **Content pipeline**. A template only sets the columns and levels (and, for the Scrum sprint board, a first sprint); it adds no cards, and everything can be changed later in Board settings. Boards start private; share one with selected accounts or with everyone signed in.

- **Who can do what.** It depends on each person's level ([Access sheet](#sharing-and-access)). **Can edit** (what everyone you shared a board with had before, and still the default) adds, edits, moves, and comments on cards, attaches their own files, and moves cards to the Bin; **Can comment** only comments and reacts; **Can view** only reads. A **Manager** also renames the board and changes its structure, columns, WIP limits, tags, and sprints, and shares it up to Can edit. Only the owner deletes the board, changes who can open it, and deletes items forever. Shared boards show their owner's name.
- **Cards.** **Add a card** at the bottom of a column, or **New card** in the board's header, opens the new-card form (full screen on phones). Type the title, then optionally choose the column, a due date and time, assignees, a description, relations to other cards, and attachments; files upload as you add them. **Create** (or Enter in the title, or `Ctrl`/`⌘`+`Enter` anywhere in the form) adds the card and closes the form, **Create and open** opens the new card, and **Create another** (also `Ctrl`/`⌘`+`Shift`+`Enter`) keeps the form open in the same column for the next one. Everything is saved in one step, so a refused card (a full column, or a linked card that is no longer available) saves nothing, and the reason shows next to the field. Close, Escape, or Back with anything entered asks "Discard this card?" first; discarding moves the files you uploaded to your Bin. Drag cards within or between columns on desktop. Every card's ⋯ button opens **Move to…**, which lists the columns and Top or Bottom; with a card focused, `Alt` plus an arrow key moves it up, down, or to the next column. If someone else changed the column meanwhile, the card jumps back and the board reloads.
- **The card view.** Click a card (or press Enter on it) to open it; it has its own URL, and Back closes it. On desktop it opens as a full-height panel on the right: the title and actions stay at the top, the fields scroll on their own on the left of a wide screen, and the comment box stays at the bottom while the comments scroll above it; click the dimmed board, Escape, or ✕ to close it. The title saves when you leave the field. The description is Markdown, edited with **Edit** and saved with **Save**; if someone else saved first, choose **Reload** (take theirs) or **Copy my text**. Comments load 50 at a time; you can edit or delete your own, and the board owner can delete any. On a wide screen, **Open as page** (the expand icon next to Move and Delete) shows the card as a full page with its own URL, with the description and comments on the left and the fields and relations on the right; **Collapse** or Back returns to the card over the board, and the board's name at the top goes back to the board. A link to the page opens it directly, on phones too (there the card is already full screen, so the expand icon is hidden).
- **Reactions.** Under each comment, tap an emoji chip to add or remove your reaction; it shows how many people reacted and is highlighted when you did (hover it, or open the picker on a phone, to see who). **Add reaction** (the smiley) offers 12 emoji: 👍 👎 ❤️ 😂 🎉 👀 🚀 ✅ 🔥 🤔 🙏 😢. On a phone it opens as a sheet that also lists who reacted; Back closes it. Anyone who can comment can react; viewers and guests see reactions but cannot add them. Reactions send no notifications and do not count as editing the card, and deleting a comment removes its reactions.
- **Attachments.** **Attach** adds files to the card, and the comment box can attach files to a comment. Images pasted or dropped into the description become attachments and show inline. Attachments never appear in Files; they are readable by the people who can open the board, and only while the card and your access last. Removing an attachment from its last card moves it to your Bin.
- **Phones.** A board shows one column at a time: swipe sideways, or tap a column in the strip above it, which also shows how many cards each column holds. Back returns to the same column.
- **Due dates and assignees.** The card view has **Due** (a date; **Clear** removes it). After a date, **Add time** sets an optional time in your time zone (**Remove time** takes it off); moving the date keeps the time. Someone in another zone sees it as, for example, "17:00 Europe/Berlin (11:00 your time)", and on the board and in Today at their own local time. **Assignees** takes up to 20 people: type part of a name to search everyone who can open the board, and remove someone with the ✕ on their chip. People picked while the list is open are saved when it closes. Someone who has lost access to the board shows "(no access)" and can only be removed. Cards show a due chip (with the time when there is one): red when overdue, amber for today and the next days, and up to three assignees as initials with "+N" for the rest. The board owner sets each column's **State** from its ⋯ menu: **To do**, **In progress**, or **Done** (a new board's columns start as one of each, and a new column is In progress). Cards in a Done column count as finished and are left out of Today; the states are also what **State** filters, My work, and views use across boards.
- **Tags and flags.** **Tags** in the card view takes up to 10 of the board's tags: type to filter them, or type a new name and choose **Create “…”** (anyone who can open the board can add a tag). Tags picked while the list is open are saved when it closes; the ✕ on a chip removes one at once. Each board has up to 100 tags with names of up to 40 characters, and each tag has a colour. The board owner also sees **Manage tags…**, which renames a tag (Enter or leaving the field saves), changes its colour, or deletes it; deleting removes it from every card on the board and cannot be undone. **Flags** are four fixed toggles, **Urgent**, **Blocked**, **Needs review**, and **On hold**; each press saves. **Blocked** is a flag you set yourself, separate from cards this one depends on. On a phone the tag list is a bottom sheet and **Manage tags** is full screen; Back closes them.
- **What a card shows on the board.** From the top: its flags as icons (urgent red, blocked amber, needs review blue, on hold grey), the title (two lines), the start of the description (two lines, one on a phone), then the due chip, up to three tags with "+N", the comment, attachment, and related-card counts (an amber count when cards it depends on are still open), and up to three assignees' initials. A card with many of these wraps them onto a second line rather than hiding any. Screen readers hear it all as one sentence, for example "Fix login, urgent, due tomorrow at 17:00, tags Backend, assigned to Asha and Ben".
- **WIP limits.** The board owner can cap how many cards a column holds with **Set WIP limit…** in its ⋯ menu (1 to 1000; **Remove limit** takes it off). The column header then shows "3 / 5", amber when full and red when over (a limit can be set below the current count; the cards stay). A full column takes no new cards: adding one or moving one in from another column is refused with a message, a dragged card cannot be dropped there, and **Move to…** lists it as full. Reordering within the column and moving cards out always work, and a card restored from the Bin always returns. Everyone who can open the board sees the limit; only the owner changes it.
- **Relations.** The card view's **Relations** links a card to others on any board you can open: choose **Depends on**, **Needed by**, **Relates to**, **Duplicates**, or **Duplicated by**, then type part of the other card's title. Links are grouped by type; click one to open that card (Back returns). Two cards have at most one link, whatever its type. When a card depends on open cards, the section reads "Blocked by N open cards". Someone who cannot open the other board sees "Restricted card" instead of its title, and can still remove the link. Linking or unlinking never counts as editing either card, so it never interrupts someone editing it.
- **Views.** The icons at the top of a board switch between **Columns** (the lanes), **Table**, **List**, and **Calendar**. The table sorts by any column header (click again for descending, a third time for the board order) and scrolls sideways on a phone with the title column kept in view. The list groups cards by column, assignee, tag, flag, or due date (**Group by**); a card with two assignees or tags appears in each group, marked "also in …", and each group folds away with its heading. The view, grouping, and sort are part of the page address, so a reload or a shared link opens the same view; Back returns to the previous view, and opening and closing a card keeps it. Drag and drop works in Columns; in the other views each card's ⋯ (**More actions**) opens **Move to…**. That sheet, in every view, also has **Copy link**, which copies the card's link without the view or filters; the open card has the same **Copy link** button in its header.
- **Board calendar.** The **Calendar** view shows this board's cards on a month grid (or an **Agenda** list) by due date; a card with a time sits on your local day and time. It shows due dates only: events linked to cards stay in the Calendar app. Cards without a due date wait in **Unscheduled**. On a computer, drag a card to another day to move its date (its time and time zone stay as they were), or onto **Unscheduled** to remove the date; with a card focused, `Alt` plus ← or → moves it a day and ↑ or ↓ a week. Every card in a day list or in Unscheduled also has **Set due date…**, which is how you move cards on a phone (there, **Unscheduled (N)** opens the list). If someone else changed the card meanwhile, it moves back and the board reloads. Filters apply here too; paging months does not add Back steps, and WIP limits do not apply to date changes.
- **Filters.** Under the board's name, **+ Filter** adds a filter: pick a field (Assignee, Tag, Flag, Due, Column, or Relations), then one or more values; a card matches any value of a field and every field. Due takes Overdue, Today, the next 7 days, the 7 days after, No date, or a date with Before, On, or After. "Next 7 days" is today plus the 6 days after it; "the 7 days after" are the 7 days that follow. Each filter shows as a chip: click it to change it, or its ✕ to remove it; **Clear** removes them all. The **Filter cards** box matches the title and description preview, ignoring case and accents. Filters apply in every view and are part of the page address, so a reload or a link shows the same cards to anyone who can open the board. Changing a filter does not add a Back step. The board's lanes keep their full counts for WIP limits while filtered.
- **Tasks home.** The top of Tasks has three segments, **Boards**, **My work**, and **Views**; each has its own address (`/tasks`, `/tasks/my`, `/tasks/views`), so Back returns to the previous segment and a reload keeps it.
- **My work.** Every card assigned to you on any board you can open, open ones by default, grouped by due date (Overdue, Today, This week, Later, No due date). The chips above the list pick **Open**, **To do**, **In progress**, **Done**, or **All**; **+ Filter** adds Board, Tag, Flag, Due, Sprint (current, next, or the backlog on each board), Parent (none), Level, or Relations (including Has subtasks), and **Find cards** matches titles. "Assignee is Me" is always on. The icons switch between the list, a **Table**, and **Columns** (one lane per state); **Group** and **Sort** change the list. Results load 50 at a time: **Load more** fetches the next ones. Each card's ⋯ opens **Move to…** with that card's board columns (there is no dragging between boards or lanes). Opening a card shows it over its board; closing it, or Back, returns to My work as you left it. Today's **My tasks** section links here with **View all**. Once you change the filters, **Save as view** keeps them.
- **Views.** A view is a saved filter and layout across your boards, such as "Urgent cards on Web and Home". The Views segment lists **My views**, views **Shared with me**, and views shared with **Everyone**. **New view** opens an empty view: add at least one filter other than text (a board, a person, a state, a tag, a flag, or a due date) before it shows cards, then **Save view**. Changing a saved view's filters, layout, grouping, or sort shows **Unsaved changes**: **Save** keeps them, the undo icon drops them, and the ⋯ menu has **Save as a new view…**, **Rename**, **Duplicate**, **Share…**, and **Delete view** (with Undo, which brings it back as a private view). If the view was changed elsewhere since you opened it, Save offers to reload the latest version. Sharing works as for boards (**Private**, **Selected people**, **Everyone here**). A view never widens access: everyone who opens it sees only cards on boards they can open themselves, and a board they cannot open shows as "Restricted board". People you share with see the view read only and can **Duplicate** it into a private copy of their own. Up to 50 views per person.
- **Board settings.** The gear in a board's header opens **Board settings** (a full-height sheet on phones; Back closes it): the name (**Rename**), the **Structure**, a per-person **Display** option, **Add column**, **Share board…**, and **Move board to the Bin**. Everyone sees the structure; the owner and managers change it, and only the owner moves the board to the Bin.
- **Structure: tasks with subtasks, epics and stories.** A board starts flat (every card is a card). In Board settings the owner picks **Task › Subtask**, **Sprint › Task**, **Sprint › Task › Subtask**, **Epic › Story › Subtask**, or types their own names for up to three levels, and chooses which level **New cards are created as** (the level the columns show). "Sprint ›" turns on sprint planning (below). Removing a level is refused while any card (even one in the Bin) is at that level, with a message saying how many.
- **Subtasks.** On a board with levels, a card shows its children as a checklist named after the level below (**Subtasks**, or **Stories** on an epic) with a count like 2/5 and a progress bar. **Add subtask…** at the bottom adds one on Enter and stays ready for the next; **Add with details** opens the new-card form with the parent filled in. Ticking a subtask moves it to the board's first done column, and unticking moves it back to the first open column; when the last one is done, a message offers to move the parent to done too (nothing moves by itself). Each row opens its card; ✕ takes a story out of its epic, and on a subtask **Make it a task** lifts it out instead. A board without a done column shows each subtask's column instead of a tick box.
- **Parents.** A card below the top level has a parent field named after the level above (**Epic**, **Story**, or **Task**): type to find a card one level up on the same board ("Choose an epic…" when it has none); a story can leave its epic, but a subtask always needs its task: removing it asks for another one or offers **Make it a task**, and one restored without its parent says "Detached subtask" with both choices. **Level** changes what a card is (a story becomes a subtask, say) while it has no children. The card view shows its parents above the title; tap one to open it, and Back returns. On the board, a card shows its parent as a small chip (tap to open it) and its subtask count, for example 2/5. To give a card a parent on a computer, drag it onto a card one level up ("Make subtask of …"); on a phone, its ⋯ → **Set epic…** (or task, story) lists the candidates.
- **What the columns show.** Columns show the level new cards are created at. Subtasks sit inside their parent, and epics show as the chip on their stories; **Show all levels on the board** in Board settings (just for you, on this device) puts every card in the columns. Loose cards without a parent always show. With a filter on, every matching card shows, whatever its level. In **Table**, cards form a tree (children under their parent, with ▸ to fold them away) with Level and Parent columns while the table is unsorted; **List** can group by **Parent**; and the filter bar adds **Level** and **Parent**, and **Has subtasks** under Relations.
- **Sprints.** On a board that plans in sprints (the **Scrum sprint board** template starts with a planned **Sprint 1** of two weeks), a sprint switcher sits under the board's name: the active sprint (the default), planned sprints, **Backlog** (cards in no sprint), **All cards**, and recently completed sprints. The board, table, list, and calendar then show only that sprint's cards, with a strip such as "4 days left · 26 Sept – 9 Oct · 8 of 14 done" and a bar of done, in-progress, and to-do cards (counts only, no points). The choice is part of the page address, so a reload or a link opens the same sprint, opening a card keeps it, and Back returns to the sprint you had before. New cards start in the sprint on screen. A card's **Sprint** field moves it to another sprint or the backlog; subtasks follow their task and show its sprint read-only. Only the board owner manages sprints.
  - **Creating a sprint.** The last entries of the sprint switcher are **＋ New sprint…** (owner) and **Manage sprints…**. New sprint opens a small dialog (a bottom sheet on phones): the **Name** (the next one, such as "Sprint 2"), the **Starts** date, and a **Duration** of 1, 2, 3, or 4 weeks or **Custom** (which shows the end date to pick). The end date follows the start and the duration. **Create** adds it as planned; **Create and start** (when no sprint is active) starts it at once. Back or Escape closes the dialog. When no sprint is running, the strip says **No active sprint** and gives the owner **Start Sprint 1** (the next planned sprint) and **New sprint**; everyone else sees the words only.
  - **Sprint defaults.** **Board settings → Sprint defaults** (owner) sets what a new sprint starts with on this board: the **Default duration** (1–4 weeks, or Custom from 1 to 60 days), **Start on** (the day after the previous sprint ends, a chosen weekday on or after that, or today), and an optional **Name pattern** such as `Sprint {n}`, where `{n}` counts up from the board's highest number (left empty, new sprints follow the latest sprint's name). **Save defaults** keeps them with the board, for every device. The Scrum sprint board starts with two weeks, the day after the previous sprint, and `Sprint {n}`; older boards without defaults suggest a sprint as long as the latest one. Members see the defaults in words.
  - **The Sprints sheet.** **Manage sprints…** (in the switcher, and in Sprint defaults) opens the board's sprints in their own sheet, with its own address (`/tasks/<board-id>/sprints`), so Back returns to the board. It lists the planned and active sprints and the completed ones (**Show older** pages further back). The owner adds one there too (**New sprint**, the same form), renames or re-dates a sprint, starts a planned one (one active at a time), deletes an empty planned one, and **Complete…** the active one (also on the strip). Completing asks where the unfinished cards go (the next planned sprint, another planned one, the backlog, or a new sprint named and dated by the sprint defaults); done cards stay in the completed sprint, and a message offers **View** to follow the rest. Back or Escape closes the dialog without completing, and the sheet stays.
  - The filter bar also has **Sprint**.
- **Moving a tree to the Bin.** Moving a card to the Bin also moves the cards under it, and the Bin shows one item with "+ N subitems". **Undo** or **Restore** brings them all back in their columns. A subtask you binned on its own before keeps its own Bin entry; restoring it while its parent is still in the Bin brings it back without a parent.
- **Limits.** 50 boards per owner, 20 columns and 1000 cards per board, three levels and 100 direct subtasks per card, 500 comments and 50 attachments per card, 10 attachments per comment.

## Collections

Collections are typed tables for anything you track: a home inventory, subscriptions, expenses, recipes, contacts. Open them from the **Collections** link on Today, or at `/collections`. The Collections page lists your collections and those shared with you; on your own, the buttons next to the name **Rename**, **Share**, or **Move to Bin** it, as on the Tasks board list.

- **New collection.** Start blank (a Name and a Notes field) or from a template: Home inventory, Subscriptions, Expenses, Recipes, or Contacts. A template is copied, so changing your collection never changes the template. **Create and import CSV** starts the import right away.
- **Fields.** The owner edits fields with **Fields**: up to 50, each a text, number (with decimals and a unit), date, checkbox, select, multi-select, link (`http` or `https`), note, or files field. The first field is the row's title everywhere and is always text. Fields can be renamed, reordered, made required, and given options with colours. A text field can become a link and back, and a select can become a multi-select; other type changes are refused. Removing a field hides its values at once; each row drops them the next time it changes.
- **Rows.** On desktop, edit cells in place: a change saves when you leave the cell (Enter saves, Escape reverts). Multi-line text, notes, and files open the row. On phones the list shows each row's title and up to three more values; tap a row for a full-screen editor. If someone else changed the row since you loaded it, your edit is not saved and the row offers **Reload**. Up to 10,000 rows per collection.
- **Undo.** Each row keeps its previous values. **⋯ → Undo last change** restores them once (fields removed since stay removed). The same menu has **Copy link** and **Move to Bin**.
- **Find, sort, and filter.** **Find rows** matches text and link fields. **Sort & filter** sorts by up to 3 fields (empty values last) and filters by up to 10 conditions that must all match, and chooses which fields are shown.
- **Saved views.** The owner can **Save as view** from the sort and filter sheet. Views appear as chips above the rows (up to 20), have their own URL, and can be updated, renamed, or deleted by the owner. Everyone with access can use them.
- **Sharing.** The owner shares a collection from the [Access sheet](#sharing-and-access), each person or group at **Can view** (read and export), **Can edit** (add, change, undo, and delete rows, attach files), or **Manager** (also rename it, change its fields and saved views, and share it up to Can edit). Only the owner deletes the collection. People who can only view see "View only".
- **Notes in rows.** A note field links a note you can read. Linking never shares the note: people who cannot read it see "Restricted note", never its title.
- **Attachments.** In a files field, **Attach files** uploads files for the row (up to 20 per row). They count towards your storage quota but never appear in Files; they are readable by everyone who can open the row, and nobody else. Removing a file from its last row moves it to the uploader's Bin; an upload that was never attached is binned after a day.
- **Search.** The search box on the Collections page finds rows in every collection you can open, by title, text, links, numbers, dates, and option labels (not note titles or file names). Back from a result returns to the results.
- **CSV import.** **Import CSV** takes a file up to 2 MB with a header row and up to 5000 rows of up to 50 columns. Columns are matched to fields by name, and you can remap or skip them. **Check** lists every problem first; the import adds all rows or none. Options match by label (several separated by `;`), and checkboxes accept yes/no, true/false, or 1/0.
- **CSV export.** **Export CSV** downloads the rows and fields of the current view as UTF-8 for spreadsheets. Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, or a tab) is prefixed with `'`; importing the file again removes it.
- **Bin.** Deleted rows and collections go to the Bin for 30 days. A row is listed for the collection owner and for whoever deleted it; either can restore it while they can still edit the collection, but only the owner deletes it forever. A row whose collection is itself in the Bin can be restored only after the collection.

## Calendar

Calendar (`/calendar`) shows your calendars and the ones shared with you as an **Agenda** (the next 60 days) or a **Month** grid (`/calendar/month/<yyyy-mm>`). Opening an event gives it its own address (`/calendar/event/<id>`), and Back returns to where you were.

- **Calendars.** **Calendars** lists them with their colours, lets you hide some from view, creates new ones, and shares one from the [Access sheet](#sharing-and-access), each person or group at **Can view** (see events), **Can edit** (add, change, and remove events), or **Manager** (also rename, recolour, and share it up to Can edit). Only the owner deletes a calendar. Viewers and guests always only view.
- **Events.** **New event** takes a title, a time with a time zone (or **All day**), a location, a description, and **Repeat** (daily, weekly on chosen days, monthly, or yearly, ending never, on a date, or after a number of times). A repeating event's **Skip <date>** leaves one date out. **Link a note** attaches what the event needs, such as an agenda or a packing list; a linked note, card, or row shows as restricted to people who cannot open it. **Undo last change** puts back the previous values once.
- **New event on a day.** In the month grid, click an empty part of a day (or its **+**, shown on hover) to open **New event** for that day at 09:00, or the next full hour today; a day from the next or previous month pages there first. On a phone, tap the day to see its events, then **New event on <date>** below the grid. Back closes the sheet.
- **Tasks due.** Cards with a due date on boards you can open appear in the agenda and the month as **Tasks due** (they stay cards; change them in Tasks). Turn them off in **Calendars**.
- **Reminders.** Under **My reminders** on an event, **Add reminder** sets one for you only ("15 minutes before", "At the start", "9:00 the day before"). When it is due it appears under the bell and at `/notifications` (**Mark all read** clears the count).
- **Push.** On an HTTPS origin, **Settings → Notifications** turns on push for this device, lists your devices, and has **Send test**. A push carries no content: the device fetches the notification from Nook. On `http://localhost` or a LAN address, reminders appear in the bell only.
- **Bin.** Deleting a calendar or an event moves it to the Bin for 30 days, like everything else.

### Calendar feeds

A feed link lets a phone or desktop calendar app (Apple Calendar, Google Calendar, Outlook, Thunderbird) subscribe to one of your Nook calendars, read-only. In Calendar, open **Calendars** and choose the subscribe button (the feed icon) next to a calendar; you can do this for your own calendars and for any calendar shared with you.

1. Choose what the feed shows. **Busy only** sends just the times, each titled "Busy", and names the calendar "Busy". **Full details** sends titles, places, and descriptions. Repeats and skipped dates are included either way.
2. **Create link**, then **Copy link** and paste it into your calendar app's "subscribe by URL" or "add calendar from the internet" option. The link is shown **only once**; Nook keeps only a fingerprint of it. If you lose it, create another.
3. The dialog lists your links for that calendar with when each was last used. Revoke (the bin icon) stops a link at once; the subscribed app simply stops updating.

Things to know:

- **Anyone with the link can read the feed** until you revoke it, without signing in and without your two-factor code. Treat it like a password; prefer **Busy only** when you share it or are unsure.
- **Cloud calendars fetch the feed from their own servers.** Google, Outlook, and iCloud (on the web) cannot reach an address that only works on your tailnet or home network; use a calendar app on the device itself, or a public HTTPS address.
- A link follows your access: if the calendar is moved to the Bin, or the owner stops sharing it with you, the link stops working (and works again if that is undone). Links you create are yours alone; other people's links are not shown to you.
- Up to 5 links per calendar per person, each fetched at most 60 times an hour (calendar apps typically refresh every 15 minutes to a few hours). At most 5000 events are sent. Timed events carry their time zone; the app shows them in yours.

## Bin

Deleting a note, a file, a card, a board, a collection, a row, a calendar, or an event moves it to the shared **Bin** (the **Bin** button in the account row, the **Bin** entry in the Notes and Files sidebar footers, or `/bin`) for exactly **30 days**. The retention period is fixed. The Bin lists your own deleted items, newest first, with the days left for each; the chips filter by Notes, Files, Tasks (cards and boards), Collections (collections and their rows; see [Collections](#collections) for who sees a binned row), or Calendar (calendars and events). Viewers and guests cannot restore or empty the Bin; their items leave after 30 days.

- **Cards and boards.** A deleted board is listed for its owner. A deleted card is listed for the board's owner and for the person who deleted it (while they can still open the board); either can restore it, but only the owner can delete it forever. A restored card returns to the bottom of its column, or of the first column if its column was deleted. A card on a deleted board can be restored only after the board. Deleting a card or a board from Tasks offers **Undo** in the toast.
- **Attachments.** When a card or board is deleted forever, or a file is removed from the last card that used it, the file moves to its uploader's Bin, labelled as a card attachment. Restoring it puts it in Files, in your Default folder.

- **What is kept:** everything. A binned note keeps its draft, published versions, and files on disk; a binned file keeps its bytes. Sharing is kept too, so restoring an item gives its previous audience access again. While an item is in the Bin nobody can read it, including its owner outside the Bin and MCP clients.
- **Restore** puts an item back in its original folder, or in your Default folder if the original was deleted. The toast names the folder and says when the item is shared again (a Default folder shared with others widens its audience).
- **Blank notes** that were never published skip the Bin and are removed at once. Any note with content, published or not, goes to the Bin, including an unpublished note whose draft you discard.
- **Delete forever** and **Empty Bin** remove items permanently. After 30 days an hourly sweeper (which also runs at boot) deletes expired items for you.
- Files in the Bin still count towards your storage quota until they are deleted forever.

## Settings → Modules

Open **Settings → Modules** to choose which parts of Nook you see. Each module has a switch, and every module is on until you turn it off. A change applies at once and is saved to your account, so it follows you to every device you sign in to (another open tab picks it up when you return to it). Home and Settings are always on.

| Module | Turning it off hides |
| --- | --- |
| Notes, Files, Tasks, Collections, Calendar | Its tile on Home and its Today sections (for Files, also Storage). Opening one of its URLs, from a bookmark, a link, Back, or a notification, goes to Home with a one-line hint and a **Turn on in Settings** button. |
| Search | The search box in Notes and <kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>/</kbd>, and the **Filter cards** text box on Tasks boards (a text filter from a link still applies and shows as a chip you can remove). The note list and the other board filters stay. Pickers inside other apps keep working. |
| Bin | The **Bin** buttons and **Leaving the Bin soon**. Deleting still moves items to the Bin, and they are still deleted forever after 30 days; turn the Bin back on to restore something. |
| Notifications | The bell and `/notifications`. Reminders are still created, and push notifications still arrive on devices where you turned them on. |
| Inbox | The **Inbox** button, `/inbox`, and **Proposals awaiting you**. Agents can still suggest changes while it is off; nothing is applied until you approve it. Guests do not see this row. |
| Team | The **Team** button and `/team`. Guests do not see this row. Admins keep **Settings → Manage team**, which still opens Team while the module is off. Roles and blocking apply as before. |

**Back and Forward past a module that is off.** Back steps over an entry of a module that is off to the page before it. Forward cannot pass beyond such an entry: it stays where you are and shows the hint. For example, after Home, then Team, then Calendar, with Team turned off and Back to Home, Forward stops at Home, and Calendar is not reachable with Forward. Turning the module back on restores it: Forward then goes to Team and on to Calendar again.

**A hidden module is not a security boundary.** Turning a module off only hides it in this app for you. Nothing is deleted, sharing is unchanged, people you share with still see what you share, MCP keys keep every permission they were given, and calendar feed links keep working. To stop an MCP client or a feed, revoke its key or link instead.

## Email

When your admin has set up email (OPERATIONS → Email), Nook can email you about things that involve you. Open **Settings → Notifications** and scroll to **Email**; the direct link is `/settings/notifications`. Settings has a URL for each section now (`/settings/security`, `/settings/mcp`, …): Back closes Settings, and Forward opens it again at the same section.

- **Verify your address first.** An account made with an invite sent to your address is already verified. Otherwise Nook emails you a verification link when you sign up; open it (it works once, for 24 hours) or press **Send verification email**. Until you verify, Nook sends you only security emails.
- **What Nook emails.** *Assigned to you* (someone else adds you to a card), *Comments on your cards* (cards you created or are assigned to), *Shared with you* (a note, folder, file, board, calendar, collection, or task view shared with you by name; sharing with everyone sends nothing), and *Proposals awaiting you* (your MCP keys suggested changes: only the key's name and how many, never the agent's text). Each has its own switch, and **Email notifications** turns them all off at once. Nothing you do yourself emails you.
- **Grouped, not noisy.** Emails of one kind wait up to 10 minutes and arrive together ("Priya assigned you 3 cards on Launch"); proposals wait up to an hour and come at most every 3 hours. If you lose access to an item before the email goes out, it is left out.
- **Security emails are always on**: a new MCP key on your account, your team role changing, two-factor turned on or off, new recovery codes or a recovery code used, your password being changed or reset, and your account being blocked, unblocked, or signed out everywhere. If one of these was not you, act on it straight away.
- **Quiet hours** hold activity emails until they end, in the time zone shown under them (**Use this device's time zone** changes it). Security emails are never held.
- **Send me a test email** checks that mail reaches you (3 an hour).
- **Unsubscribe.** Every activity, reminder, and digest email has a link at the bottom that turns off that one kind of email (or the digest); the page asks before it changes anything. Mail apps that offer an "Unsubscribe" button use the same switch. Security emails cannot be turned off.
- **Digest.** Under **Summary**, choose **Daily** or **Weekly (Mondays)** and a time. It arrives at that time in your time zone (also across daylight-saving changes) and lists your own cards that are overdue or due soon (today and tomorrow for daily, the week for weekly), your events in the next 7 days, proposals awaiting you (key names and counts), and what was shared with you by name since the last digest. Each line links to its card, event, Inbox, or item; **Open Today** opens Today. Empty sections are left out, and a digest with nothing in it is not sent. It is off until you turn it on, and it is never scheduled inside quiet hours: a time inside them moves to when they end. The line under it says when the next one goes.
- **Reminders by email.** In Calendar, **Add reminder** has **Remind me by**: *Notification* (the bell and push, as before), *Email*, or *Notification and email*. Email needs a verified address that has not bounced, with **Email notifications** and **Reminders by email** on; otherwise the email choices are greyed out and the sheet says why. An email-only reminder still appears under the bell but sends no push. Reminder emails arrive at the reminder's time **even during quiet hours** (you set that time on purpose), and say "(late)" when Nook could not send them within 15 minutes. **Reminders by email** also covers *event changed* and *event cancelled* emails: when someone else moves an event you set a reminder on to a new time or place, or moves it to the Bin, within the next 7 days, you get one email (changes within 10 minutes are grouped, and a change that is undone sends nothing).
- **Sprints** (off by default): an email when a sprint with cards assigned to you starts or is completed, with your own cards' counts. **Bin clean-up** (off by default): at most once a week, a list of items in your Bin that will be deleted for good within 3 days.
- **Mute a board or calendar.** In a board's **Board settings → Email**, tick **Mute emails from this board**; in Calendar's **Calendars** sheet, use the mail button on a shared calendar. Nook then sends no activity email about it (assignments, comments, sprints, event changes); your own reminders, the digest, and security email still come. **Settings → Notifications → Email → Muted** lists everything you muted, each with **Unmute**.
- **Bounced email.** If mail to your address bounces or is reported as spam, Nook stops emailing it (security emails still go) and Settings shows a red notice. A run of temporary bounces pauses email for 3 days and then resumes by itself. **Try again** turns email back on straight away (once a day).

Emails link straight to the card, note, board, Inbox, or Settings section they are about, on this Nook's address. Nook never asks for your password by email, and its emails contain no images, trackers, or remote content.

Admins see what Nook emailed in **Team → Email log** (`/team/email`): which kind of email, to whom, when, and whether it was sent, held, skipped (and why), or failed, with a **Retry** for failed ones. A **Bounced**, **Spam report**, or **Soft bounces** tag next to a name means Nook is holding back all but security email to that person's address. It never shows addresses, subjects, or content.

## Password

**Change it** in **Settings → Security → Password** (`/settings/security`): press **Change password**, enter your current password, the new one twice (at least 12 characters), and, if you use two-factor authentication, a code from your app or a recovery code. Every other device signed in to your account is signed out; the one you are using stays signed in. Nook emails you that the password changed. This works whether or not email is set up. Your API keys keep working, so review them under **Settings → API keys** if you changed the password because something looked wrong.

**Forgot it?** On the sign-in page press **Forgot password?** (`/forgot-password`), enter your address, and press **Send reset link**. The page always answers "If that address has a verified account, we sent a link": it never says whether an account exists. The email arrives only when the account's address is verified and the account is not blocked. Its link works once, for 30 minutes, and a newer link replaces an older one. Open it, choose a new password, and, if the account uses two-factor authentication, enter a code from your app or a recovery code (a mailbox alone cannot take over the account). Resetting signs you out on **every** device, including this one, and does not sign you in: sign in with the new password. Nook emails you that the password was reset, with a link to review your API keys, which keep working.

When email is off on your Nook, the forgot page says so and sends nothing: ask an admin. Admins cannot send a reset email for someone else.

## Team

Changing a role, blocking, unblocking, or signing someone out everywhere asks you to confirm in a dialog; there is no password re-check for signed-in admins.

**Team** lists everyone with an account on this Nook and their **team role**. Open it with the **Team** button next to Bin in the account row (on Today and in the Tasks, Collections, Calendar, and Bin headers), at `/team`, or, for admins, from **Settings → Manage team**. Each person has their own page at `/team/<id>`.

- **Roles.** An **Admin** can do everything a member can, and manages the team. A **Member** creates, edits, and shares notes, files, tasks, collections, and events, as before. The first account created on a new Nook is the admin; when an existing Nook upgrades, the oldest account becomes the admin and everyone else a member (the operator can change it, see [OPERATIONS.md](OPERATIONS.md#team-admins-and-blocking)). A **Viewer** reads everything shared with them or with everyone, but creates, edits, shares, and uploads nothing. A **Guest** reads only what is shared with them by name: items shared with "Everyone here" are not shown to guests. New accounts are guests unless the operator chose otherwise (`SIGNUP_ROLE`). The team role is separate from the levels you give when you share (Can view, Can edit, Manager): it caps them, so a viewer or guest only ever reads, even where others can edit.
- **Viewers and guests.** Each app shows a **View only · Team role: Viewer** (or Guest) banner and hides the create, edit, share, upload, and delete controls, also on items the person created before their role changed (those stay theirs and stay shared). They can still read, download, search, use Today, run task filters (guests: only "Assigned to me"), set their own reminders on events they can read, manage their notifications, push devices, two-factor, and Modules, and sign out. Viewers can save, rename, duplicate, and delete private task views (**New view**, **Save as view**) but cannot share them; guests save no views and see only views shared with them by name. They cannot restore or empty the Bin (items leave after 30 days) or create calendar subscribe links. In Settings → API keys a viewer can create keys with read permissions only, and a guest cannot create keys. Guests have no Team button. When you share with people, the list marks recipients who will only read with **Guest** or **Viewer**.
- **What you see.** Everyone sees names, team roles, and whether an account is blocked. Admins also see each account's email, when it was last seen, whether two-factor is on, how many API keys it has, how much storage it uses, and its activity. Admins never see anyone's private notes, files, or other content.
- **Search and filter.** Search by name (admins also by email) and filter with the chips: All, Admins, Members, Blocked, and Viewers or Guests once someone has those roles. Accounts created in the last 7 days carry a **New** tag for admins.
- **Changing a role** (admins). Pick the role on the person's page and confirm. Making someone an admin, or removing admin, asks for your password (and a fresh six-digit or recovery code when two-factor is on). Nook always keeps at least one admin: the last one cannot be demoted or blocked. If someone else changed the role meanwhile, Nook shows the current role instead of overwriting it. A change applies on the person's next click.
- **Blocking** (admins). **Block** signs the person out on every device at once and stops them from signing in; you can add a reason that only admins see. Their MCP keys and calendar links pause, and their content stays where it is, still shared as before. Blocking an admin asks for your password. A blocked person who signs in with the right password is told the account is blocked. **Unblock** lets them sign in again with their existing password and two-factor code; they need to turn push notifications on again on each device.
- **Sign out everywhere** (admins) ends every session of that account without blocking it.
- **Activity** (admins) lists the latest role changes, blocks, unblocks, and sign-outs for the person, who made them, and when, including changes made from the host command line.

On a phone, the list and a person's page are separate screens: Back closes an open picker or confirmation first, then returns from the page to the list, then to Today.

### Groups (admins)

**Team → Groups** (`/team/groups`) lists the groups on this Nook with their size. **New group** asks for a name and an optional description; a group's page (`/team/groups/<id>`) adds people with the type-to-search field, removes them, renames or deletes the group, lists what owners shared with it (with the title hidden when you cannot open the item yourself), and shows its history.

- A group never opens anything by itself: owners choose to share an item with it at a level, and you decide who is in it. Everyone in the group then reaches what was shared with it, from their next click; someone you remove loses it at once.
- You can add yourself; the group page, its history, and the owners' Access sheets say that an admin added themselves.
- Guests in a group only ever read. **Delete group** says how many items were shared with it; those shares end, and everyone's own and direct shares stay.

On a phone, Back returns from a group to Groups, then to Team.

### Keys and policies (admins)

- **Team → Keys** (`/team/keys`) lists every live API key on this Nook: its name, owner, permissions, surfaces, expiry, last use, and 14-day use, filtered by owner, module, and state (expiring within 14 days, no expiry, blocked by policy, in rotation grace, expired, unused for 90 days). You never see a key's secret or the names of the items a key is limited to. **Revoke** asks for a reason, stops the key at once, and shows the owner that an admin revoked it and why.
- **Team → Policies** (`/team/policies`) sets the rules every key follows, checked on every call: the longest lifetime and the default for new keys, whether every key must have an expiry (keys made before this release have none), how many live keys each person may hold, which team roles may use keys over MCP (and REST, once it exists), which modules each role's keys may use, and whether anyone may share with guests (off: nobody can share with a guest, directly or through a group, until it is turned back on; existing shares with guests stay until they are removed, see [Guests](#sharing-and-access)). The line above **Save policies** says how many keys a change would block. A key that breaks a rule is **blocked, not revoked**: it stops working and shows **Blocked by team policy** until it complies or the rule is loosened. Two admins editing at once cannot overwrite each other: the second save is refused and reloads.

### Inviting people

Admins add people with a single-use **invite link**, even while registration is closed. Open **Team → Invites** (`/team/invites`).

- **Create.** Choose **New invite**, pick the **Team role** (Member, Viewer, or Guest; Guest is the default; admins are promoted after sign-up) and when it **Expires** (1, 3, or 7 days). Optionally bind it to an **Email** (only that address can use the link) and add a **Label** that only admins see. Nook allows 20 live invites at once and 10 new ones an hour per admin.
- **Copy once.** The full link is shown once, right after you create it: **Copy link**, then send it any way you like. Closing the dialog forgets it; Nook keeps only a fingerprint of the link, so it cannot show it again. Create a new invite if you lose it.
- **Send by email.** When the invite is bound to an email and the operator has set up email, tick **Send by email to <address>** in the dialog, or use **Resend email** on a live invite later. Resending mails a fresh link and the earlier link stops working. Without email set up, Nook says **Email is not configured** and the invite still works by copying the link.
- **Revoke.** A live invite can be revoked; the link stops working at once. Each card shows the role, whether the invite is Live, Used, Expired, or Revoked, when it expires, and who created or used it. A used invite links to the new person's page, whose Activity says "Joined with an invite from <admin>, as <role>".
- **What the invitee sees.** The link opens a **Join Nook** page: "<admin> invited you to Nook as a Viewer", the expiry, and a hint of the bound address. The link leaves the address bar as soon as the page opens. They choose a name, email, and password and land on Today with the invite's role. An expired or already-used link says so and asks them to get a new one from you. Someone already signed in is asked to sign out first.
- **The allowlist still applies.** An invite only opens registration; when the operator sets `ALLOWED_EMAILS`, the invitee's address must be on it.
- **Links die with your admin role.** If you stop being an admin (demoted or blocked), your outstanding links stop working.

## Inbox

The **Inbox** collects changes your MCP keys **suggest** instead of making. Open it with the **Inbox** button next to the bell (its badge counts what is waiting, up to 99+) or at `/inbox`. Nothing an agent suggests changes anything until you approve it, and only you see the suggestions your own keys make.

- **What an agent can suggest:** a new card, a change to a card's fields, a comment on a card, a new or changed event, a new or changed row, or a note draft. Each suggestion is a **proposal**, grouped under the key that sent it, in the order it was sent.
- **Reviewing.** Each proposal shows its kind, the agent's title, the agent's reason under **Written by the agent** (shown as plain text: treat it as the agent's claim, not Nook's), what it changes (for example **Home › To do**), and the changes themselves: a **Before / After** table for fields, or the line diff for a note draft (**Changes** or **Full draft**). On desktop the list and the open proposal sit side by side; on a phone a proposal is its own screen.
- **Approve** applies the change as you, with your access: exactly as if you had made it yourself, and the audit log records that you approved the key's proposal. For a note draft, **Approve and publish** publishes that exact draft as a new version. If the card, event, row, or draft changed after the agent read it, or you can no longer edit it, the proposal is marked **Failed** with the reason and nothing is applied.
- **Reject** takes an optional reason, which the agent can read to learn what not to suggest again. Rejecting a note draft discards it only if it is still the agent's version.
- **Approve all** and **Reject all** act on every waiting proposal of one key, one at a time; the result says how many applied and why any failed. More than ten asks you to confirm first.
- **History** lists approved, rejected, failed, expired, and withdrawn proposals for 90 days.
- **Keyboard** (desktop): <kbd>J</kbd>/<kbd>K</kbd> move between proposals, <kbd>A</kbd> approves, <kbd>R</kbd> rejects.

Proposals expire after **14 days** without a decision (an expired note draft stays in the note). The bell tells you when a key suggests changes ("Key “laptop” suggested 3 changes"); turn on **Settings → Notifications → Push new proposals** to get a push too. The notification and the push name only the key and a count, never the agent's text. **Proposals awaiting you** on Today lists the newest ones.

Viewers can reject proposals that were waiting when their role changed, but not approve them; guests have no Inbox.

## Routines

A **routine** is a prompt you keep in Nook for an agent to run on a schedule: "every weekday at 08:00, look at my boards and suggest cards for anything I forgot". Nook never runs anything itself. Your MCP client (a cron script, Claude Desktop, n8n) asks Nook what is due, runs it, and files what it suggests into the Inbox, where you approve or reject each one as usual.

Open **Inbox → Routines** (`/inbox/routines`) and press **New routine**:

- **Name** and **Instructions**: the prompt the agent runs (up to 16 KiB of Markdown).
- **Can suggest**: the kinds of change it may propose (create cards, update rows, note drafts, …). Nook refuses anything else from the run.
- **Only in** (optional): pin it to boards, calendars, collections, or folders. When you pin a module, Nook refuses that module's suggestions anywhere else; modules you do not pin stay open.
- **Hints for the agent** (optional): guidance such as "only cards tagged #ops". Not enforced.
- **Runs**: Daily, Weekdays (Mon–Fri), Weekly (pick the day), Hourly (pick the minute), or Manual only, at a time in the routine's time zone (your browser's when you create it; **Use <zone>** switches it). A **Schedule note** ("after the Monday stand-up") is shown to the agent.
- **Key**: bind the routine to one key (recommended: only that key sees it), or let any of your keys with **Suggest changes** run it.
- **Max proposals per run** (25 by default, at most 100) and **Expire after** (days its proposals wait, 14 by default).
- **Enabled**: a paused routine is never due. **Pause** and **Resume** are also on each row.

A new routine is due straight away for its current slot (a daily 08:00 routine created at 10:00 can run now); after a run it is next due at the following slot. A missed slot stays due until a run finishes, and several missed slots count once. A run holds a **two-hour lease**; a run that is never finished is marked **Abandoned** by the hourly sweep, its proposals stay in the Inbox, and the routine stays due.

Each row shows when the routine is next due and how its last run went. Open a routine to edit it and to see its **Last runs**: status, when, how many proposals and tool calls (Nook counts these itself), how long it took, whether it hit its limit, and the agent's summary under **Written by the agent**. In the Inbox, a run's proposals are grouped under the routine with the run's time, status, and summary, and **Approve all** works per run. The bell says "Weekly review suggested 4 changes" once per run. Deleting a routine removes its run history; its proposals stay in the Inbox under their key.

Members and admins can have up to 50 routines. If your role becomes Viewer or Guest, your routines are paused.

### Recipe: run a routine from Claude Desktop or a cron script

1. In **Settings → API keys**, create a key with **Suggest changes** plus the read permission for what the routine looks at (for example **Read tasks**), and bind the routine to it.
2. Point the client at `<your origin>/mcp` with the header `Authorization: Bearer <your key>`.
3. The client runs four calls:

   | Step | Tool | What it does |
   | --- | --- | --- |
   | 1 | `list_due_routines` | Lists the routines due now that this key may run. |
   | 2 | `start_run` `{ routineId }` | Returns the instructions, allowed kinds, pins, limit, and the last run's summary and your recent reject reasons, and opens a two-hour lease (`runId`). |
   | 3 | `submit_proposals` `{ runId, proposals: [...] }` | Files suggestions into the run (repeat as needed, up to the limit). |
   | 4 | `finish_run` `{ runId, status: "succeeded", summary }` | Closes the run and moves the routine to its next slot. |

**Claude Desktop.** After adding Nook as an MCP server, each routine you can run appears as a prompt named `routine.<name>` (for example `routine.weekly-review`). Choose it and Claude gets the instructions plus the four-call protocol; say "run it".

**A cron script.** Any MCP-capable agent CLI works. For example, a crontab line that runs a headless agent every weekday at 08:05 (placeholders only):

```sh
5 8 * * 1-5  claude -p "Use the nook MCP server. Call list_due_routines; for each routine with runsAvailable, call start_run, follow its instructions, submit_proposals with the runId, then finish_run with a short summary." --mcp-config /path/to/nook-mcp.json
```

where `nook-mcp.json` names the server `nook` with the URL `https://nook.example/mcp` and the header `Authorization: Bearer <your key>`. Nothing the agent suggests applies until you approve it in the Inbox.

## MCP server

Nook includes an authenticated [Model Context Protocol](https://modelcontextprotocol.io/) server over Streamable HTTP, so trusted AI clients can search and read your notes and files, and write drafts for you to review.

1. Open **Settings → API keys** (`/settings/keys`) and choose **New key**. Name it, say where it is used (MCP today; REST arrives in a later release), and build its **Access** one permission at a time (below). Pick when it expires, confirm with your password (and a fresh two-factor code when two-factor is on), and **Create key**. The key is shown in full only once; Nook stores its SHA-256 hash and a short identifying prefix, never the plaintext.
2. Copy the ready-to-paste client configuration. The endpoint is `<your origin>/mcp` (`http://localhost:2026/mcp` for the default deployment) and the key is sent as an `Authorization: Bearer` header.
3. Revoke keys you no longer need from the same screen.

### API keys

Every key is a **Nook key**: an owner (you), a name, where it is used, an expiry, and a list of **permissions**. Each permission is a module and what the key may do there, for example **Tasks: Write tasks** on **All boards**, or only on the boards you choose. What a key can do is worked out again on every call: its permissions, limited to what your team role allows now, to what team policy allows, and to the items you can open now. A key never does more than you can.

- **The key list** shows each key's surfaces, its state (**Expires in 12 days**, **No expiry** for keys made without one, **Old key: stops in 23 h** during a rotation, **Blocked by team policy**, **Revoked by an admin**), its permission chips (a permission that grants nothing right now is dashed and says why: your team role, team policy, or no current access), when it was last used, and a 14-day bar chart of calls.
- **Access.** Add one row per permission: **Module**, **Permission**, and for Tasks, Collections, and Calendar **Applies to**: **All boards** (every board you can open, now and later) or **Chosen boards** (pick them). A key limited to chosen items only gets the tools that stay inside one item (list and change cards on those boards, rows in those collections, events on those calendars); tools that search or link across items are hidden from it for now. The summary under the rows says what the key can do, and that no key ever shares, manages access or keys, or deletes forever. Options you cannot use say why (**Admins only**, **Your team role reads only**, **Turned off by team policy**).
- **Edit** a key to rename it, remove permissions, lower **Write** to **Read**, narrow **All boards** to chosen ones, or bring its expiry closer. Editing never adds access and needs no password; to add access, create a new key.
- **Rotate** gives a new secret with the same permissions and a fresh lifetime, after your password. **New key expires** starts on the old key's lifetime (capped by team policy); you may pick another, or **No expiry** when team policy allows it. Choose how long the old key keeps working (now, 1 hour, 24 hours, or 7 days) so you can update your clients; routines bound to the key move to the new one. **Revoke now** on the old key ends that early.
- **Revoke** stops a key at once and withdraws its pending suggestions in the Inbox. Revoked keys stay listed for a week under **Revoked in the last 7 days**; if an admin revoked one, it says so and shows their reason.
- **Expiry.** New keys expire after 90 days unless you choose otherwise; your team decides the longest allowed (365 days by default). **No expiry** sits next to the day choices: a key without one works until you revoke it, and admins see it under the **No expiry** filter in Team → Keys. When team policy requires an expiry, **No expiry** is off and says so, and existing keys without one are blocked until rotated with a date. Editing cannot remove a key's expiry (it only brings it closer); rotate instead. An expired key stops working; create a new one or rotate before it ends.

The table below is every permission. Settings shows each one's help text in the permission dropdown.

| Permission | Scope | What the client can do |
| --- | --- | --- |
| Read notes | `notes:read` | List, read, and search published notes (`list_notes`, `read_note`, `search_notes`) and list folders. Drafts are never shown, not even yours. |
| Write drafts | `notes:write-draft` | Create notes and change the drafts of **your own** notes (`create_note`, `get_note_draft`, `update_note_draft`). It never publishes, never creates a version, and cannot delete, move, or share anything. Includes Read notes. |
| Publish notes | `notes:publish` | Publish the draft of **your own** note after reading it (`publish_note_draft`, with `get_note_draft`). Settings warns that an agent can make its drafts visible to everyone the note is shared with. Includes Read notes. |
| Read files | `files:read` | List files and folders, see file details, and read text files (such as `.txt`, `.md`, `.csv`, `.json`) up to 1 MiB. Images, PDFs, and other binary files cannot be read. |
| Write files | `files:write` | Store text files and upload files into your own folders, rename and move your own files, and create folders (all private unless a folder you choose is shared). It never shares or deletes, and refuses a move that would change who can see a file. Includes Read files. |
| Read tasks | `tasks:read` | List the boards you can open, their columns, tags, and cards, and read a card with its comments and relations (`list_boards`, `list_cards`, `get_card`). `list_cards` can filter by column, assignee (`me`, `none`), tag, flag, due date, and text. Find cards by title across your boards with `search_cards`. On boards with levels, cards show their parent, level, and subtask counts, `get_card` lists a card's children, and `list_children` lists them alone. On boards with sprints, `list_sprints` lists a board's sprints, cards show their sprint, and `list_cards` can filter by sprint (`current`, `next`, `none`, or a sprint). List your saved task views with `list_views`, and find cards across every board you can open with `query_cards`, either by a view or by a filter such as `assignee:me state:todo,doing due:overdue,week`; a shared view only ever shows you cards from boards you can open. A shared view keeps the owner's filter as written, so it can contain the ids of boards, columns, tags, or people you cannot see; by design they show only as restricted, never with a name. Descriptions come back as plain text and attachments as file names only; a related card on a board you cannot open shows only as restricted. |
| Write tasks | `tasks:write` | Create cards (with a due date and time, assignees, existing tags, and flags), update a card's title, due date, assignees, tags, and flags (never its description), move cards within a board, link two cards you can open (`link_cards`: relates to, depends on, needed by, duplicates), and comment on them as you (`create_card`, `update_card`, `move_card`, `link_cards`, `comment_on_card`); a new card can go under a parent (`parentId`), and `update_card` can move a card to another parent or level, or plan it in a sprint (`sprintId`; subtasks follow their task), on any board you can use. It also manages tags (`manage_tags`: create, if you can edit cards; rename and recolour for the board owner only), sets WIP limits and adds and starts sprints (board owner only: `set_wip_limit`, `create_sprint`, `start_sprint`; a board manager's key gets `OWNER_ONLY`, managers do these in the app), and attaches your own files (`link_attachment`). It never deletes a card (binning needs Move to Bin) or removes a link or tag, and cannot change sharing, boards, or column structure, or complete a sprint. Includes Read tasks. |
| Read Today | `today:read` | Read the Today summary (`get_today`, titles only). Each section also needs the matching permission: notes sections need Read notes, Recent files needs Read files, task sections need Read tasks, Recently edited rows needs Read collections, and Upcoming needs Read calendar; Bin and storage need only Read Today, and list only the kinds of items the key's other permissions cover. |
| Read calendar | `calendar:read` | List your calendars and the events on them (`list_calendars`, `list_events` over up to 100 days, `get_event`). Links to notes, cards, and rows come back as titles, or as "restricted" when you cannot open them. |
| Read team | `team:read` | Admins only. List the accounts on this Nook with their names, team roles, and status (`list_team_members`), read one account's latest team activity (`get_team_member`), and list invite links with their role, status, and dates (`list_invites`). Emails, block reasons, invite tokens, and invite labels are never returned, and there are no team write tools: agents cannot create, revoke, or email invites. If you stop being an admin, the key loses these tools on its next call. |
| Write calendar | `calendar:write` | Create and change events on calendars you own or may edit (`create_event`, `update_event`), and set reminders **for yourself** (`create_reminder`). It never deletes events, skips dates, shares calendars, or creates feed links. A change fails with `EVENT_CHANGED` if the event changed since the client read it. Includes Read calendar. |
| Read collections | `collections:read` | List your collections with their fields (`list_collections`), query rows with filters, sorting, and search (`query_rows`, up to 50 a page), and read one row (`get_row`). Rows come back keyed by field name; note links as titles or "restricted"; attachments as file names only. |
| Move to Bin | `bin:write` | Move items to the Bin and restore them, **only together with** the matching write permission (Write drafts for notes, Write tasks for cards, Write calendar for events, Write collections for rows). Nothing is ever deleted forever: items stay in the Bin for 30 days and you can restore them, one by one or with **Review → Restore all** on the key. At most 10 a minute and 50 a day per key. |
| Read inbox | `inbox:read` | List this key's own proposals and their status, failure code, and your reject reason (`list_my_proposals`), and the routines this key may run (`list_routines`, `list_due_routines`, and each routine as a `routine.<name>` prompt). |
| Suggest changes | `inbox:write` | Suggest changes for you to approve in the Inbox (`submit_proposals`, up to 20 at a time; `withdraw_proposal`), and run routines (`start_run`, `submit_proposals` with the run, `finish_run`). Never applies anything. Each suggestion also needs that module's **read** permission (Read tasks, Read calendar, Read collections), or Write drafts for a note draft. Members and admins only. Includes Read inbox. |
| Write collections | `collections:write` | Add rows and change values in collections you own or may edit (`create_row`, `update_row`, which keeps fields it does not name), and create private collections (`create_collection`, from a template or a field list). It never deletes rows (binning needs Move to Bin), changes fields, views, or sharing, attaches files, or imports. A change fails with `ROW_CHANGED` if the row changed since the client read it. Includes Read collections. |

There are sixteen permissions in all. A key with read permissions plus **Suggest changes** can propose anything it can read and change nothing by itself: a good choice for scheduled agents. Keys created before this release keep exactly what they could do before. Card changes made through a key appear on the board like your own and are recorded in the audit log with the key's id.

**Reviewing an agent's events and rows.** An event or row last changed through a key says **Changed by the MCP key <name>**. The event view's **Undo last change**, and the **Undo** button next to that note in a row, put the previous values back; your own next edit clears the note.

**Reviewing an agent's drafts.** A note whose draft was written through a key shows a **Draft by <key name>** badge in the note list and the editor header, and waits in the **Inbox** as a note draft proposal. Nothing reaches readers until you press **Publish version** (or **Discard** the draft). Leaving such a note never publishes it, even after you edit it; only the Publish button does. (Your own drafts are published automatically when you leave a note only if you edited them in the current session.) If the draft changed after you last saw it, Publish reloads it and asks you to review it first. If you and an agent edit the same draft at once, whoever saves second is told the draft changed instead of overwriting it.

### What agents can change (Wave 19)

Every change an agent makes is yours to undo, and none deletes anything forever. Each change is recorded in the audit log with the key's id.

| Tool | Permission | What it changes | How to undo it |
| --- | --- | --- | --- |
| `publish_note_draft` | Publish notes | Publishes a draft of your own note as a new version, but only the exact revision the key read with `get_note_draft` (or wrote). If you changed the draft after the agent read it, nothing is published. | Restore the earlier version from the note's version history. |
| `create_folder` | Write drafts or Write files | Adds a private folder (it never takes its parent's sharing). | Delete the folder in the app. |
| `bin_note`, `bin_card`, `bin_event`, `bin_row` | Move to Bin + the module's write permission | Moves the item (a card with its subtasks) to the Bin for 30 days. A blank note also goes to the Bin, never straight to deletion. | `restore_*`, the Bin, or **Review → Restore all** on the key. |
| `restore_note`, `restore_card`, `restore_event`, `restore_row` | Move to Bin + the module's write permission | Restores an item the key's owner may restore (notes: yours; cards, events, rows: the owner or whoever binned it). | Bin it again. |
| `manage_tags` | Write tasks | Creates a tag (any board member), or renames or recolours one (board owner only). No deletes. | Rename or recolour it back in the app. |
| `set_wip_limit` | Write tasks | Sets or clears a column's WIP limit (board owner only). | Change it back in Board settings. |
| `create_sprint`, `start_sprint` | Write tasks | Adds a planned sprint or starts one (board owner only). Completing a sprint stays in the app. | Edit or delete a planned sprint in the app. |
| `link_attachment` | Write tasks | Attaches one of your own card-attachment files to a card. Files from Files cannot be attached. | Remove the attachment on the card. |
| `create_collection` | Write collections | Adds a private collection from a template or a field list (at most 100). | Delete the collection in the app. |
| `create_text_file`, `begin_upload` + `finish_upload` | Write files | Stores a file in one of your folders (default: Default), private unless that folder is shared. Text up to 1 MiB goes inline; other files go through a one-time upload ticket that works only with the same key, once, for 15 minutes. | Delete the file in Files. |
| `rename_file`, `move_file` | Write files | Renames or moves one of your own files. A move that would change who can see the file is refused. | Rename or move it back. |

**Review and Restore all.** When a key moved anything to the Bin in the last 24 hours, its row in **Settings → API keys** says **Moved 7 items to the Bin today · Review**. **Review** lists what that key binned in the last hour, 24 hours, or 7 days and is still in the Bin, with **Restore all** and **Revoke this key**. Back closes the dialog before it leaves Settings. Keys never gain a new power silently: publishing, file writes, and the Bin each need their own new permission, and the only additions to existing permissions are the tag, WIP, sprint, attachment, and collection tools listed above (their help text in Settings says so).

**Uploading a binary file with `curl`.** After `begin_upload` returns `uploadUrl`, send the bytes with the same key, then call `finish_upload`:

```sh
curl -X PUT "$UPLOAD_URL" -H "Authorization: Bearer $NOOK_KEY" \
  -H "Content-Type: application/octet-stream" --data-binary @photo.jpg
```

**Limits.** Each key can make 120 tool calls and 30 writes a minute, and per day create 200 notes, make 500 task changes, 200 event changes, 100 reminders, 500 row changes, 200 proposals, and 48 routine runs; publish 50 drafts, move 50 items to the Bin (10 a minute), make 20 sprint changes, 100 folder and file-move changes, and 100 file uploads (1 GiB of uploads per account a day). All keys of one account together get 1000 calls and 60 writes a minute, and per day 400 new notes, 1000 task changes, 400 event changes, 200 reminders, 1000 row changes, 400 proposals, and 200 routine runs, with at most 500 proposals waiting at once and each run held to its routine's limit (25 by default, at most 100). Beyond that the client gets `RATE_LIMITED`. Writes are recorded in the audit log with the key's id.

Treat API keys like passwords, use a separate key per client, and give each only the permissions it needs. The text of your notes and files is passed to the client as data. A client that follows instructions hidden in that text is the client's risk, which is why writing is opt-in, publishing and the Bin need their own permissions, and everything an agent does can be undone.
