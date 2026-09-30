import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { runMigrations } from "./migrations";

process.umask(0o077);
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);

export const db = new Database(config.databasePath, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

runMigrations(db);

db.exec("PRAGMA optimize");

for (const path of [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]) {
  if (existsSync(path)) chmodSync(path, 0o600);
}

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  /** The block timestamp (D74): set only by blocking, shown as `blockedAt` and "Blocked". */
  disabled_at: string | null;
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_last_counter: number | null;
  totp_recovery_codes: string | null;
  /** Platform role (migration 017, D71). */
  role: "admin" | "member" | "viewer" | "guest";
  /** The admin who blocked this account; NULL when active, or blocked before Team (017). */
  blocked_by: string | null;
  block_reason: string | null;
  /** 'service' for an integration (D287, migration 025): it never signs in; only its keys act. */
  kind?: "person" | "service";
};

/** A row of `team_invites` (migration 018, D161–D169). The token itself is never stored. */
export type TeamInviteRow = {
  id: string;
  token_hash: string;
  token_prefix: string;
  email: string | null;
  role: "member" | "viewer" | "guest";
  note: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  /** 025; applied on acceptance from Wave 33 (D286). */
  template_id?: string | null;
  /** 032: the template's group ids, name, and revision when the invite was created (D286). */
  template_group_ids?: string | null;
  template_name?: string | null;
  template_revision?: number | null;
};

export type NoteRow = {
  id: string;
  owner_id: string;
  folder_id: string | null;
  title: string;
  visibility: "private" | "selected" | "all_users";
  sharing_override: number;
  current_version: number;
  draft_revision: number | null;
  draft_checksum: string | null;
  /** The MCP key that wrote the current draft (migration 010); cleared on publish, discard, and restore. */
  draft_mcp_key_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

export type DocumentRow = {
  id: string;
  owner_id: string;
  folder_id: string | null;
  name: string;
  mime_type: string;
  preview_kind: "image" | "pdf" | "text" | "audio" | "video" | "none";
  size_bytes: number;
  sha256: string;
  visibility: "private" | "selected" | "all_users";
  sharing_override: number;
  upload_key: string | null;
  purpose: "file" | "task_attachment" | "collection_attachment";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  purge_started_at: string | null;
};

export const now = () => new Date().toISOString();

export function ensureDefaultFolder(userId: string) {
  const current = db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(userId) as { id: string } | null;
  if (current) return current.id;
  const namedDefault = db.query("SELECT id FROM folders WHERE owner_id = ? AND name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1").get(userId, "Default") as { id: string } | null;
  if (namedDefault) {
    db.query("UPDATE folders SET is_default = 1, parent_id = NULL, updated_at = ? WHERE id = ?").run(now(), namedDefault.id);
    return namedDefault.id;
  }
  const id = crypto.randomUUID();
  const timestamp = now();
  db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, created_at, updated_at) VALUES (?, ?, NULL, 'Default', 1, ?, ?)")
    .run(id, userId, timestamp, timestamp);
  return id;
}

const usersMissingDefault = db.query("SELECT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM folders f WHERE f.owner_id = u.id AND f.is_default = 1)").all() as Array<{ id: string }>;
for (const user of usersMissingDefault) ensureDefaultFolder(user.id);

/**
 * Extra audit metadata for everything a call does, such as `{via: "mcp", keyId}`
 * when an MCP tool runs a module's service. Services keep writing their usual
 * events; the context is merged into each one.
 */
const auditContext = new AsyncLocalStorage<Record<string, unknown>>();

export function withAuditContext<T>(extra: Record<string, unknown>, operation: () => T): T {
  return auditContext.run(extra, operation);
}

/**
 * The provenance of an approved proposal (agent inbox D146): `{via: "proposal", proposalId, keyId}`.
 * Kept apart from the audit context above and merged last, so a module's MCP wrapper (which sets
 * `{via: "mcp"}`) cannot hide that a person approved the change.
 */
const proposalAuditContext = new AsyncLocalStorage<Record<string, unknown>>();

export function withProposalAuditContext<T>(extra: Record<string, unknown>, operation: () => T): T {
  return proposalAuditContext.run(extra, operation);
}

/**
 * The key surface a tool call came through (Wave 34): `{via: "rest"}` for `/api/v1/tools/:name`.
 * Tools share one handler for MCP and REST, and module wrappers set `{via: "mcp"}`; this is
 * merged after them (and before a proposal's provenance), so the audit row names the real surface.
 */
const surfaceAuditContext = new AsyncLocalStorage<Record<string, unknown>>();

export function withSurfaceAuditContext<T>(extra: Record<string, unknown> | null, operation: () => T): T {
  return extra ? surfaceAuditContext.run(extra, operation) : operation();
}

export function audit(actorId: string | null, noteId: string | null, eventType: string, metadata?: unknown) {
  const extra = auditContext.getStore();
  const surface = surfaceAuditContext.getStore();
  const proposal = proposalAuditContext.getStore();
  const merged = extra || surface || proposal ? { ...(metadata as Record<string, unknown> | undefined), ...extra, ...surface, ...proposal } : metadata;
  db.query(
    "INSERT INTO audit_log (id, actor_id, note_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), actorId, noteId, eventType, merged ? JSON.stringify(merged) : null, now());
}
