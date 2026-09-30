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
import { agentInboxMigration } from "./021_agent_inbox";
import { reactionsMigration } from "./022_reactions";
import { accessKeysMigration } from "./025_access_keys";
import { emailMigration } from "./026_email";
import { proposalBaseMigration } from "./027_proposal_base";
import { emailDigestsMigration } from "./028_email_digests";
import { accessLevelsMigration } from "./029_access_levels";
import { whiteboardsMigration } from "./030_whiteboards";
import { accessCentralMigration } from "./032_access_central";
import { keySurfacesMigration } from "./033_key_surfaces";
import { googleIdentitiesMigration } from "./034_google_identities";
import { todayDigestPromptMigration } from "./035_today_digest_prompt";
import { serviceAccountsMigration } from "./036_service_accounts";

const migrations = [initialMigration, folderSharingMigration, totpMigration, totpRecoveryCodesMigration, mcpApiKeysMigration, documentsMigration, binMigration, noteSearchMigration, taskBoardsMigration, mcpKeyScopesMigration, taskDatesMigration, collectionsMigration, calendarMigration, eventNextOccurrenceMigration, taskCardUxMigration, userPreferencesMigration, teamRolesMigration,
  // 018 (Team invites) may reach existing installs after 019 (task hierarchy) and 020 (task views); none depends on another.
  teamInvitesMigration, taskHierarchyMigration, taskViewsMigration,
  // 021 (agent inbox) needs only 005, 010, 013, and 016; 022 (reactions) needs only 001 and 009.
  agentInboxMigration, reactionsMigration,
  // 023 and 024 belong to other parallel plans. 025 (access keys) needs 005, 009, 010, 012, 013, 017, 018,
  // 020, and 021; 026 (email) needs only 001, 013, 017, and 018; 027 (proposal base) needs only 021.
  accessKeysMigration, emailMigration, proposalBaseMigration,
  // 028 (email digests: soft bounces and the share log) needs only 001.
  emailDigestsMigration,
  // 029 (access levels: member levels in line with share_role) needs 012, 013, and 025.
  accessLevelsMigration,
  // 030 (whiteboards, Wave 23; the plan's 023 was taken) needs only 006.
  whiteboardsMigration,
  // 031 is reserved for a parallel wave. 032 (access central, Wave 33: notices, invite template snapshots, an actor index) needs 001, 018, and 025.
  accessCentralMigration,
  // 033 (key surfaces, Wave 34: per-surface last use and daily counts) needs only 025.
  keySurfacesMigration,
  // 034 (Google identities, flows, avatars, re-auth) needs only 001.
  googleIdentitiesMigration,
  // 035 (the Today digest prompt) needs only 026.
  todayDigestPromptMigration,
  // 036 (service accounts, Wave 36: description, kind and role triggers) needs 001, 017, 025, and 034.
  serviceAccountsMigration
];

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
