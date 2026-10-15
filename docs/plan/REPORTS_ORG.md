# Report organization at scale: favorites, shared folders, lists

Status: **phases 1 and 2 shipped (2026-10-15)**, phase 3 planned. Phase 1 follows Tableau's favorites. **Phase 2 was simplified by the operator**: folders only group, permissions sit on each report, and reports can have several owners.
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

**Shipped (2026-10-15).** D486: a favorite is the person's own shortcut, never a grant; every list and count reads it through `readableReportSql`, so it drops out when access is lost (T393) and returns with it. The list is paged by keyset, 100 a page, with an opaque cursor; only the filters in use are written into the SQL, so SQLite picks `reports_owner`, `reports_status`, `reports_live_recent` (`(updated_at DESC, id)`, added beside the planned status index) or the favorites' key. The nav's counts and the Owner filter's choices come from one `GROUP BY` by place and owner. Filters live in the URL query (`?owner=&status=&datasource=&schedule=`); on a phone they open in a bottom sheet (`reports.filters`). At 2,000 reports, 300 folders and 50 groups a page costs about 0.3–2.4 ms of CPU (`tests/reportFavorites.test.ts`).

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

## Phase 2: simple permissions; folders only group (migration 062)

**Shipped (2026-10-15), migration 062.** As built:
- `reports.owner_id` is kept as the **primary owner** (the creator until they leave the owners, always one of them via triggers, the person scheduled refreshes and the edit agent run as). Dropping it would have rippled through the scheduler, the edit agent, versions, and quotas; owner checks all read `report_owners`.
- `report_folders` is rebuilt without `owner_id` (`created_by`, SET NULL), keeping every report's `folder_id`. Two people's same-named folders are both kept; the nav names the creator beside such siblings (never a merge, which would move reports their owners filed).
- Last owner: removing them is refused (`LAST_OWNER`). Blocking an owner or making them a guest hands reports with no other active owner to an admin (the one acting, else the oldest active admin), audited `reports.owner.handover`; Nook had no ownership-transfer pattern to reuse.
- Admins manage owners of any report but are not owners by role (unchanged: they never were).
- Only admins see, restore, or purge binned folders. Nothing deletes a folder over MCP; `update_report_folder` renames and moves (admins).
- The folder-subtree list may walk `reports_live_recent` rather than `reports_folder` now that folders are shared (still no full scan, well under the 50 ms line at 2,000 reports).

**Operator decision (2026-10-15).** Keep permissions simple:
- Permissions live on the **report**.
- **Folders are only for grouping** and never grant or limit access (no inheritance).
- A report can have **several owners**. An owner or an admin can make someone else an owner.
- An owner can change the report's folder, its sharing, and its other permissions.

**Data**
- `report_owners(report_id, user_id, added_by, created_at)`.
- Migrate every `reports.owner_id` into this table. Keep `owner_id` as the creator, or drop it if that is cleaner.
- `report_folders` becomes a **workspace-wide grouping tree** (confirmed by the operator, 2026-10-15):
  - Every member sees the same folders.
  - A folder shows only the reports that person can read.
  - Empty folders are visible to members; guests see none.
- **Folder rights** (operator decision, 2026-10-15):
  - Any member (not a guest) can **create** a folder.
  - Only **admins** can **rename, move, reorder or delete** folders, so nobody else can reorganize the shared tree.
  - A deleted folder goes to the Bin. Its reports move to Unfiled and return when the folder is restored.
  - Filing a report into a folder stays the report owner's right.
- Folders have no sharing and no levels.

**Access**
- Report sharing stays as it is today (view / comment, people, groups, everyone). The `group_grants` fold (D460) is optional cleanup, not required.
- Everything owner-only today (D455, D459) becomes "any owner of the report".
- An admin can manage the owners of any report, so an orphaned report can always be recovered.
- A report must keep at least one owner. Removing the last owner is refused.
- Blocking or deleting a user who is the last owner hands the report to an admin, or flags it. This uses the existing module's ownership-transfer pattern if one exists.

**UI**
- The Share sheet gets an **Owners** section: add or remove owners, shown to owners and admins.
- Owners can also move the report to another folder. Folder navigation is the same tree for everyone.
- Row badges show the person's level on that report.

**MCP**
- `list_report_owners`.
- Owners can call `add_report_owner` and `remove_report_owner` under `reports:write`. Audited, never the last owner.

**Threats**
| Id | Threat | Mitigation |
|---|---|---|
| T389 | An extra owner gets doc or proposal access | Expected: they are an owner. The audit records who added them. |
| T390 | Removing the last owner orphans the report | Refused. Admin recovery. |
| T391 | Folder titles leak report titles | A folder lists only readable reports, and the counts are per-viewer. |

**Decisions**
- D481: Folders only group and never grant access.
- D482: Reports have several owners, and admins manage owners.
- D483: The workspace-wide folder tree.

## Phase 3: report lists (optional, migration 064)

- **Tables:** `report_lists` and `report_list_items`.
- **Sharing:** through `report_list_members` and `group_grants('report_list')`.
- **A list never grants access:** its items are always filtered through `readableReportSql`.
- **Name:** "Lists", because Nook already has a Collections module.

## Threats and decisions

Phase 2's threats and decisions are listed in its section. Phase 1 adds D486 (Favorites) and T393 (favorites never leak, because they are filtered through `readableReportSql`). Phase 3 adds D487 (Lists never grant access).

## Order and parallelism

- **Phase 1** can run alongside the Files `document_fts` work (060), since they share no tables.
- **Phase 2** follows phase 1. It touches `server/reports/access.ts`, `sharing.ts`, the folder files, the gates that change from `ownedReport` to `editableReport`, `server/team/*`, `server/access/*`, `src/reports/ShareSheet.tsx` and `src/access/*`.
- **Phase 3** is optional.
- Each phase is its own release-sized slice.

## Open questions

None. The operator settled them on 2026-10-15: one shared folder tree, and only admins can rename, move or delete folders.
