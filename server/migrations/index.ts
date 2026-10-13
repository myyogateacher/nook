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
import { vaultMigration } from "./031_vault";
import { accessCentralMigration } from "./032_access_central";
import { keySurfacesMigration } from "./033_key_surfaces";
import { googleIdentitiesMigration } from "./034_google_identities";
import { todayDigestPromptMigration } from "./035_today_digest_prompt";
import { serviceAccountsMigration } from "./036_service_accounts";
import { vaultSharingMigration } from "./037_vault_sharing";
import { vaultKeysMigration } from "./038_vault_keys";
import { agentChatMigration } from "./039_agent_chat";
import { agentAuditMigration } from "./040_agent_audit";
import { agentSharingMigration } from "./041_agent_sharing";
import { knowledgeMigration } from "./042_knowledge";
import { chatToolImagesMigration } from "./043_chat_tool_images";
import { signInDevicesMigration } from "./044_sign_in_devices";
import { attachmentsMigration } from "./046_attachments";
import { legacyAttachmentsMigration } from "./047_legacy_attachments";
import { contentReferencesMigration } from "./048_content_references";
import { reportsMigration } from "./050_reports";
import { reportRunsViaMigration } from "./051_report_runs_via";

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
  // 031 (the vault, Wave 25; the plan's 024 was taken) needs 001 and 025. It may reach existing installs
  // after 032–035, which runMigrations allows (each missing id is applied on its own).
  vaultMigration,
  // 032 (access central, Wave 33: notices, invite template snapshots, an actor index) needs 001, 018, and 025.
  accessCentralMigration,
  // 033 (key surfaces, Wave 34: per-surface last use and daily counts) needs only 025.
  keySurfacesMigration,
  // 034 (Google identities, flows, avatars, re-auth) needs only 001.
  googleIdentitiesMigration,
  // 035 (the Today digest prompt) needs only 026.
  todayDigestPromptMigration,
  // 036 (service accounts, Wave 36: description, kind and role triggers) needs 001, 017, 025, and 034.
  serviceAccountsMigration,
  // 037 (vault sharing, Wave 26: the protected-environment window, stored bytes, integrations never members) needs 001, 031, and 036.
  vaultSharingMigration,
  // 038 (vault keys, Wave 27: the protected-environment flag, flag and grant-shape triggers) needs 025, 031, and 036.
  vaultKeysMigration,
  // 039 (agent chat, Wave 40 "AC-A": every table of the module, and the api_key_grants rebuild that
  // widens its CHECK words for agents and messages) needs 001, 005, 025, 032, and 038.
  agentChatMigration,
  // 040 (agent audit, Wave 42 "AC-C": the Audit log's append-only triggers, the retention guard, and
  // two reader indexes) needs 005 and 039.
  agentAuditMigration,
  // 041 (agent sharing, Wave 43 "AC-D": access_grants_v with agent and chat rows, agent_access
  // uniqueness and indexes, and the "Copied from" columns on chats) needs 025 and 039. The Messages
  // migration moves to 042.
  agentSharingMigration,
  // 042 (knowledge bases, Wave 44 "AC-E": kb_chunk_fts with the heading path and its sync triggers,
  // source columns and indexes, and the purge of agents' picks) needs 039. The Messages migration moves to 043.
  knowledgeMigration,
  // 043 (tool images in chats: the pictures MCP tools return, served to whoever can read the chat)
  // needs 039.
  chatToolImagesMigration,
  // 044 (recognised devices and the welcome mail: sign_in_devices, sessions.legacy_device,
  // users.welcome_mail, users.device_baseline) needs 001 and 026. The Messages migration moves to 045.
  signInDevicesMigration,
  // 045 is reserved for the S3 storage backend (branch s3-storage); runMigrations applies each missing
  // id on its own, so 045 may land after 046. 046 (uploads everywhere, U0: folders.system_kind, the
  // Attachments folder guards, attachment_links and its purge triggers) needs 001, 002, 006, 013, 025,
  // 030, and 039. The Messages migration moves to 048.
  attachmentsMigration,
  // 047 (uploads everywhere, U8: legacy task and row attachments become Files documents in each
  // uploader's Attachments folder, in place, with their links kept) needs 006, 009, 012, 025, and 046.
  legacyAttachmentsMigration,
  // 048 (v0.35.0 review L2: content_reference_sources and content_references, the orphan sweep's
  // reference index; a cache, created empty) needs nothing. The Messages migration moves to 049.
  contentReferencesMigration,
  // 049 is reserved for the Messages module; runMigrations applies each missing id on its own, so 049
  // may land after 050. 050 (analytics reports, Wave 45: data sources, the schema catalog and its FTS
  // index, reports, doc snapshots, queries, runs with one running run per report, results, schedules,
  // and the api_key_grants rebuild that adds `reports` / `report`) needs 001, 025, 038, and 039.
  reportsMigration,
  // 051 (reports wave 46: `agent_runs.via` gains `reports`, rebuilt with its children kept; reports.doc_arg)
  // needs 039, 040, and 050. 052 is reserved for reports wave 48 (report_instructions, report_versions).
  reportRunsViaMigration
];

/** Every registered migration in order (read-only), for tests that build an older database shape. */
export const registeredMigrations: readonly typeof migrations[number][] = migrations;

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
