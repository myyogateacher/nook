# Report organization at scale: favorites, shared folders, lists

Status: **planned (2026-10-15)**, modelled on Tableau.
- Content lives in shared folders whose access passes down to everything inside.
- People keep personal shortcuts as favorites.
- Optional lists group reports without moving them.

This replaces two earlier TODO items: "a reader's own placement of shared reports" and "fold report shares into `group_grants`" (D460).

Next free ids at planning time: migration **061** (060 is the Files `document_fts` index), decision **D481**, threat **T389**.

## Findings that shape the plan

1. **Folder sharing does not pass down today.** D3 and D271, `server/folders.ts` and `readableDocumentPredicate` all keep folder sharing to the immediate folder. Report folders that pass access down are a reports-only exception (D481). Files and Notes are unchanged.
2. **The inheritance shape comes from Files.** Files has a folder audience plus `selected` shares, checked with `groupGrantExists`. Reports reuse that shape and add a walk up the ancestors, capped at 3 levels (`REPORT_FOLDER_DEPTH`).
3. **`group_grants` has never been rebuilt.** It was created in 025. Rebuilding it has to handle:
   - the `access_grants_v` view (041);
   - the `group_grants_no_system_folder` trigger (046);
   - triggers on other tables that delete from `group_grants`, kept with `legacy_alter_table = ON` as in 050.
4. **Report shares are view or comment only.** Anything that changes a report is `ownedReport` (D455), so a folder editor needs a new report level, `edit`.
5. **D459 redaction applies to any non-owner.** It keys off "author ≠ owner", so it already covers editors.

## Phase 1: favorites and scale (migration 061)

**Data**
- `report_favorites(user_id, report_id, created_at)`: primary key on both columns, cascades from users and reports.
- A partial index `reports_status`.

**Server**
- `listReports` gets keyset pagination on `(updated_at DESC, id)`, 100 rows a page, with an opaque cursor.
- Filters: `ownerId`, `status[]`, `datasourceId`, `scheduled`, `favorites`, `folderId` (the folder or its whole subtree), and `q`.
- Folder counts come from a single `GROUP BY` over the readable set.
- Starring a report you can't read is refused.
- Favorites drop out of lists automatically when access is lost.

**UI**
- ☆/★ on each report row and on the report header, toggled optimistically.
- **Favorites** in the left nav.
- A filter bar for owner, status, data source and schedule. Filters live in the URL, so Back and Forward restore them.
- Infinite scroll with a "Load more" fallback.
- On a phone, filters open in a bottom sheet.

**MCP**
- `list_reports` gains the new filters and the cursor.
- New tools `star_report` and `unstar_report`.

**Test:** 2,000 reports, 300 folders and 50 groups. The list must return in under 50 ms, and the query plans must use the indexes.

## Phase 2: shared folders with inherited access (migration 062, optional 063)

### Migration 062

- **Rebuild `group_grants`** on the 050 pattern:
  - `resource_kind` gains `report`, `report_folder` and `report_list`. Adding `report_list` now avoids another rebuild later.
  - Every row, index and trigger is copied.
  - Add the index `group_grants_group_kind`.
  - Running it again changes nothing.
- **Folders:** `report_folders` gains `visibility` (`private|selected|all_users`), `all_users_level` and `created_by`.
- **New table:** `report_folder_members(folder_id, user_id, level view|comment|edit, …)`.
- **`report_members`:** gains the `edit` level.
- **Existing group shares:** `report_group_shares` rows move into `group_grants('report')`, then the table is dropped. This closes D460.
- **Views and triggers:**
  - `access_grants_v` is re-created to include report and report-folder member rows.
  - Purge triggers on reports and report folders remove their grants.
- **Optional 063:** an `api_key_grants` rebuild that adds `report_folder`, so keys can be scoped by folder.

### Access

A person's effective level on a report is the highest of:
- owner;
- a direct share on the report;
- a group grant on the report;
- the report's "everyone" level;
- the member, group and "everyone" levels of every **live** ancestor folder.

The result is then capped by role (`capByRole`):
- Guests, disabled users and integrations get nothing.
- Team viewers are capped at view.

Shares only add access, so a report can't narrow its folder's access in v1.

**What each level can do:**

| Level | Rights |
|---|---|
| view | Read the report (D456). |
| comment | Also add instructions. |
| **edit** (new) | Also rename, refresh, edit by hand, `update_report_query`, restore a version, and file reports they own into folders they can edit. |
| owner only | Apply/Reject, auto-apply, the source doc, the schedule, direct sharing, the Bin. |

D459 redaction applies to editors exactly as it does to commenters.

**Folders:**
- An **editor** can create, rename and reorder subfolders.
- Only the **owner** can delete a folder to the Bin, share it, or move it.
- A subfolder belongs to the root folder's owner; `created_by` records the editor who made it.

**Moves that widen access need a confirm.** Moving a report or a folder recomputes who can see it. If the move widens access, the server answers 409 `CONFIRM_REQUIRED` with the new audience, and the client asks before retrying. This is the same pattern Files uses.

**The Bin breaks inheritance.** A binned folder no longer passes access down. Its reports go to their owners' Unfiled, and restoring the folder files them back.

**Readable predicate.** `readableReportSql` keeps its signature. It gains one branch: a single uncorrelated recursive query over the granted folders and their descendants.

**Team tooling:**
- Group counts and guest checks become plain `group_grants` checks.
- Member access and Reset access cover folder shares.
- The central Access sheet lists `report` and `report_folder`.

### UI

- **Left nav:** Favorites, All, My folders, Shared folders, Shared with me (direct shares only), Unfiled.
- **Shared folder roots:** a folder shared partway down someone's tree appears as its own root, with its full path in a tooltip.
- **Share sheet:** one sheet serves reports and folders. A folder shows how many reports and subfolders inherit its access. A report shows its inherited access read-only, for example "From Finance: Growth team, edit".
- **Row badges:** "Shared via Finance", plus the person's level.
- **History:** every new sheet registers a `layerKey`, so Back and Forward work across them (D478–D480).

### MCP

- `list_report_folders` returns the shared tree, with each person's level.
- `move_report_to_folder` refuses a move that widens access (`ACCESS_WIDENS`) unless `confirmAudience` is passed.
- There is still no sharing over MCP (D457).

## Phase 3: report lists (optional, migration 064)

- **Tables:** `report_lists` and `report_list_items`.
- **Sharing:** through `report_list_members` and `group_grants('report_list')`.
- **A list never grants access:** its items are always filtered through `readableReportSql`.
- **Name:** "Lists", because Nook already has a Collections module.

## Threats and decisions

**Threats**

| Id | Threat | Mitigation |
|---|---|---|
| T389 | Inherited access widens silently on a move or a share | Confirm before widening, and audit the change |
| T390 | A folder editor reaches the doc or proposals | D459 applies to editors |
| T391 | The `group_grants` rebuild loses rows, triggers or the view | A migration test covers them |
| T392 | A binned or purged folder still grants access | Only live ancestors pass access down, and purge triggers remove grants |
| T393 | Favorites or lists leak titles or access | Always filtered through `readableReportSql` |
| T394 | Inheritance queries slow listing down enough to deny service | The depth cap and the indexes |

**Decisions**

| Id | Decision |
|---|---|
| D481 | Report folders pass access down (an exception to D3/D271) |
| D482 | The `edit` level on reports |
| D483 | Subfolders belong to the root folder's owner |
| D484 | A move that widens access needs a confirm |
| D485 | Report group shares move into `group_grants` (closes D460) |
| D486 | Favorites |
| D487 | Lists never grant access |

## Order and parallelism

- **Phase 1** can run alongside the Files `document_fts` work (060), since they share no tables.
- **Phase 2** follows phase 1. It touches `server/reports/access.ts`, `sharing.ts`, the folder files, the gates that change from `ownedReport` to `editableReport`, `server/team/*`, `server/access/*`, `src/reports/ShareSheet.tsx` and `src/access/*`.
- **Phase 3** is optional.
- Each phase is its own release-sized slice.

## Open questions (defaults in brackets)

1. Can a folder editor apply or reject proposals and set schedules? [No: owner only.]
2. Who owns a subfolder an editor creates? [The root folder's owner.]
3. Can the folder owner take other people's reports out of the folder? [Only the report owner or the folder owner.]
4. Should keys be scoped by folder now (063)? [Later.]
5. Should report collections be called "Lists"? [Yes.]
6. Can a report opt out of its folder's access? [Not in v1.]
7. Can a folder be shared with everyone, and at what level? [Yes, view or comment.]
