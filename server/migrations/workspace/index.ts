import type { Migration } from "../types";
import { foundationMigrations } from "./foundation";
import { formsMigrations } from "./forms";
import { timeMigrations } from "./time";
import { goalsMigrations } from "./goals";
import { checkinsMigrations } from "./checkins";
import { crmMigrations } from "./crm";
import { bookingsMigrations } from "./bookings";
import { wiringMigrations } from "./wiring";
import { reportsWorkspaceMigrations } from "./reportsWorkspace";
import { townhallMigrations } from "./townhall";
import { timeBudgetAlertsMigration } from "../120_time_budget_alerts";
import { sidebarPreferencesMigration } from "../122_sidebar_preferences";

/**
 * The workspace modules' migrations (docs/plan/WORKSPACE_MODULES.md §0, §B.1), concatenated in id-block
 * order: foundation 085–089, Forms 090–092, Time 093–095, Goals 096–098, Standups 099–101, Contacts
 * 102–105, Bookings 106–109, wiring 110–112, workspace reports 113–114, Townhall 115–117. Each lane
 * appends to its own file only; ids ascend inside each block, so the runner's ascending check holds
 * however the lanes merge.
 */
export const workspaceMigrations: Migration[] = [
  ...foundationMigrations,
  ...formsMigrations,
  ...timeMigrations,
  ...goalsMigrations,
  ...checkinsMigrations,
  ...crmMigrations,
  ...bookingsMigrations,
  ...wiringMigrations,
  ...reportsWorkspaceMigrations,
  ...townhallMigrations,
  // Audit 2 fixes (120-121, lane tg): after every lane block so the ids still ascend.
  timeBudgetAlertsMigration,
  // 122 (left navigation phase 4, D1295: user_preferences.sidebar) needs only 016; last so the ids ascend.
  sidebarPreferencesMigration
];
