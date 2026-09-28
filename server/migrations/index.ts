import type { Database } from "bun:sqlite";
import { initialMigration } from "./001_initial";
import { folderSharingMigration } from "./002_folder_sharing";
import { totpMigration } from "./003_totp";
import { totpRecoveryCodesMigration } from "./004_totp_recovery_codes";
import { mcpApiKeysMigration } from "./005_mcp_api_keys";
import { documentsMigration } from "./006_documents";
import { binMigration } from "./007_bin";
import { noteSearchMigration } from "./008_note_search";
import { taskBoardsMigration } from "./009_task_boards";
import { mcpKeyScopesMigration } from "./010_mcp_key_scopes";
import { taskDatesMigration } from "./011_task_dates";
import { collectionsMigration } from "./012_collections";
import { calendarMigration } from "./013_calendar";
import { eventNextOccurrenceMigration } from "./014_event_next_occurrence";
import { taskCardUxMigration } from "./015_task_card_ux";
import { userPreferencesMigration } from "./016_user_preferences";
import { teamRolesMigration } from "./017_team_roles";
import { teamInvitesMigration } from "./018_team_invites";
import { taskHierarchyMigration } from "./019_task_hierarchy";
import { taskViewsMigration } from "./020_task_views";
import { reactionsMigration } from "./022_reactions";

const migrations = [initialMigration, folderSharingMigration, totpMigration, totpRecoveryCodesMigration, mcpApiKeysMigration, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration, taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration, teamRolesMigration,
  // 018 (Team invites) may reach existing installs after 019 (task hierarchy) and 020 (task views); none depends on another.
  teamInvitesMigration, taskHierarchyMigration, taskViewsMigration,
  // 021 (Agent inbox) comes from a parallel wave; 022 (reactions) needs only 001 and 009.
  reactionsMigration];

/**
 * Ids of every registered migration, in order. Tests assert against this list. Ids must ascend;
 * `runMigrations` applies each missing id on its own, so a database that got a later id first
 * (parallel waves, Team module plan §11) still gets an earlier one when it lands.
 */
export const registeredMigrationIds: readonly number[] = migrations.map((migration) => migration.id);

export function runMigrations(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    if (index > 0 && migrations[index - 1]!.id >= migration.id) throw new Error("Database migrations must have unique ascending ids");
    if (db.query("SELECT id FROM schema_migrations WHERE id = ?").get(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, new Date().toISOString());
    })();
  }
}
