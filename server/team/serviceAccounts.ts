/**
 * Service accounts, shown as "Integrations" (Wave 36, D287, O-A11, T212). An integration is a
 * `users` row with `kind = 'service'`: admins create it with a name and a role (member or viewer,
 * never admin), block, unblock, and delete it, and hold its keys. It has:
 *
 * - no password (an unusable sentinel), no TOTP, no Google identity, and a synthetic address in the
 *   reserved `.invalid` domain (`svc-<id>@service.invalid`) that `isEmailAllowed` always refuses, so
 *   no sign-in, reset, invite, or Google path can reach it; migration 036 refuses a session row or a
 *   Google identity for it in the database as well;
 * - no email and no bell notices (the outbox, access notices, reminders, and proposal notices skip it);
 * - no part in an `all_users` audience, and no group membership: its keys reach only what an owner
 *   shared with it by name (D73 holds: an admin holding its key reads only what owners chose to share).
 *
 * Every write records an `access_events` row (`integration.*`, ids only) and an audit row.
 */
import { SERVICE_EMAIL_DOMAIN } from "../config";
import { audit, db, ensureDefaultFolder, now } from "../db";
import { recordAccessEvent } from "../access/events";
import { adminRevokeKey } from "../apiKeys";
import { listReadableFolders, readableNotePredicate } from "../access";
import { editableBoardPredicate, readableBoardPredicate } from "../tasks/access";
import { editableCollectionPredicate, readableCollectionPredicate } from "../collections/access";
import { editableCalendarPredicate, readableCalendarPredicate } from "../calendar/access";
import { readableDocumentPredicate } from "../documentAccess";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";
import type { GrantModule } from "../keyGrants";
import { can, type Role } from "./roles";
import { blockUser, setRole, TeamError, teamEvents, unblockUser, type TeamActor, type TeamEvent } from "./service";

export const INTEGRATION_NAME_MAX = 80;
export const INTEGRATION_DESCRIPTION_MAX = 200;
/** Live (not deleted) integrations per Nook. */
export const INTEGRATION_LIMIT = 100;
export const INTEGRATION_ROLES = ["member", "viewer"] as const;
export type IntegrationRole = typeof INTEGRATION_ROLES[number];
/** Stored as the password hash: it starts with "!", so verifyPassword refuses it before hashing (D294). */
export const SERVICE_PASSWORD = "!unusable:service";
/** Grant modules an integration's key may never hold: routines and their Inbox are a person's (nobody reviews an integration's). */
export const INTEGRATION_EXCLUDED_MODULES: readonly GrantModule[] = ["inbox", "team"];

export const serviceEmailFor = (id: string) => `svc-${id}@${SERVICE_EMAIL_DOMAIN}`;

const kindQuery = db.query("SELECT kind FROM users WHERE id = ?");
/** Whether the account is an integration (false for a person or an unknown id). */
export const isServiceAccount = (userId: string | null | undefined) =>
  typeof userId === "string" && (kindQuery.get(userId) as { kind: string } | null)?.kind === "service";

/** The integrations among a list of ids (attribution badges): see server/avatars.ts. */
export { integrationIdsAmong } from "../avatars";

export class IntegrationError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

const notFound = () => new IntegrationError(404, "NOT_FOUND", "Integration not found");

type IntegrationRow = {
  id: string; display_name: string; description: string | null; role: IntegrationRole; created_at: string; disabled_at: string | null;
  blocked_by: string | null; blocked_by_name: string | null; live_keys: number; last_used_at: string | null;
  created_by: string | null; created_by_name: string | null;
};

const integrationSelect = `
  SELECT u.id, u.display_name, u.description, u.role, u.created_at, u.disabled_at, u.blocked_by, b.display_name AS blocked_by_name,
         (SELECT COUNT(*) FROM mcp_api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS live_keys,
         (SELECT MAX(k.last_used_at) FROM mcp_api_keys k WHERE k.user_id = u.id) AS last_used_at,
         (SELECT e.actor_id FROM access_events e WHERE e.target_user_id = u.id AND e.action = 'integration.created' ORDER BY e.created_at LIMIT 1) AS created_by,
         (SELECT a.display_name FROM access_events e JOIN users a ON a.id = e.actor_id WHERE e.target_user_id = u.id AND e.action = 'integration.created' ORDER BY e.created_at LIMIT 1) AS created_by_name
  FROM users u LEFT JOIN users b ON b.id = u.blocked_by
  WHERE u.kind = 'service'`;

export type Integration = {
  id: string;
  displayName: string;
  description: string | null;
  role: IntegrationRole;
  status: "active" | "blocked";
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
  blockedAt: string | null;
  blockedBy: { id: string; displayName: string } | null;
  keys: { live: number };
  lastUsedAt: string | null;
};

function present(row: IntegrationRow): Integration {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    role: row.role,
    status: row.disabled_at === null ? "active" : "blocked",
    createdAt: row.created_at,
    createdBy: row.created_by && row.created_by_name !== null ? { id: row.created_by, displayName: row.created_by_name } : null,
    blockedAt: row.disabled_at,
    blockedBy: row.blocked_by && row.blocked_by_name !== null ? { id: row.blocked_by, displayName: row.blocked_by_name } : null,
    keys: { live: row.live_keys },
    lastUsedAt: row.last_used_at
  };
}

function requireAdmin(actor: { id: string; role: Role }) {
  if (!can(actor.role, "team.manage")) throw new TeamError(403, "ADMIN_ONLY", "Only admins can manage integrations");
}

/** Every integration: active before blocked, then by name. */
export function listIntegrations() {
  const rows = db.query(`${integrationSelect} ORDER BY u.disabled_at IS NOT NULL, u.display_name COLLATE NOCASE, u.id`).all() as IntegrationRow[];
  return { integrations: rows.map(present), limit: INTEGRATION_LIMIT };
}

export type IntegrationDetail = Integration & { events: TeamEvent[]; ownsContent: boolean };

export function integrationDetail(id: string): IntegrationDetail | null {
  const row = db.query(`${integrationSelect} AND u.id = ?`).get(id) as IntegrationRow | null;
  if (!row) return null;
  return { ...present(row), events: teamEvents(id), ownsContent: contentReferences(id) > 0 };
}

const cleanName = (name: string) => {
  const value = name.trim();
  if (!value || value.length > INTEGRATION_NAME_MAX) throw new IntegrationError(400, "INVALID_NAME", `Give the integration a name of at most ${INTEGRATION_NAME_MAX} characters`);
  return value;
};
const cleanDescription = (description: string | null | undefined) => {
  const value = description?.trim() ?? "";
  if (value.length > INTEGRATION_DESCRIPTION_MAX) throw new IntegrationError(400, "INVALID_DESCRIPTION", `Keep the description to ${INTEGRATION_DESCRIPTION_MAX} characters`);
  return value || null;
};

/** Creates an integration (admins only). It gets a Default folder like every account, and nothing else. */
export function createIntegration(actor: { id: string; role: Role }, input: { name: string; role: IntegrationRole; description?: string | null }) {
  requireAdmin(actor);
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  if (!INTEGRATION_ROLES.includes(input.role)) throw new IntegrationError(400, "SERVICE_ROLE", "An integration can only be a member or a viewer");
  const id = crypto.randomUUID();
  db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM users WHERE kind = 'service'").get() as { count: number }).count;
    if (count >= INTEGRATION_LIMIT) throw new IntegrationError(409, "INTEGRATION_LIMIT", `This Nook already has ${INTEGRATION_LIMIT} integrations. Delete one first.`);
    const timestamp = now();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind, description) VALUES (?, ?, ?, ?, ?, ?, 'service', ?)")
      .run(id, serviceEmailFor(id), name, SERVICE_PASSWORD, timestamp, input.role, description);
    ensureDefaultFolder(id);
    recordAccessEvent({ actorId: actor.id, via: "web", action: "integration.created", targetUserId: id, meta: { role: input.role } }, timestamp);
    audit(actor.id, null, "team.integration_created", { targetId: id, role: input.role });
  })();
  return integrationDetail(id)!;
}

/** Renames, describes, or changes the role (member ↔ viewer) of an integration. */
export function updateIntegration(actor: { id: string; role: Role }, id: string, patch: { name?: string; description?: string | null; role?: IntegrationRole; expectedRole?: IntegrationRole }) {
  requireAdmin(actor);
  const current = db.query("SELECT id, display_name, description, role FROM users WHERE id = ? AND kind = 'service'").get(id) as { id: string; display_name: string; description: string | null; role: IntegrationRole } | null;
  if (!current) throw notFound();
  const changed: string[] = [];
  db.transaction(() => {
    const name = patch.name === undefined ? current.display_name : cleanName(patch.name);
    const description = patch.description === undefined ? current.description : cleanDescription(patch.description);
    if (name !== current.display_name) changed.push("name");
    if (description !== current.description) changed.push("description");
    if (changed.length) db.query("UPDATE users SET display_name = ?, description = ? WHERE id = ? AND kind = 'service'").run(name, description, id);
    if (patch.role !== undefined && patch.role !== current.role) {
      setRole(actor, id, { role: patch.role, expectedRole: patch.expectedRole ?? current.role }, { via: "web", kind: "service" });
      changed.push("role");
    }
    if (changed.length) {
      recordAccessEvent({ actorId: actor.id, via: "web", action: "integration.updated", targetUserId: id, meta: { fields: changed } });
      audit(actor.id, null, "team.integration_updated", { targetId: id, fields: changed });
    }
  })();
  return { changed, integration: integrationDetail(id)! };
}

export const blockIntegration = (actor: TeamActor & object, id: string, reason: string | null) => {
  const result = blockUser(actor, id, reason, { via: "web", kind: "service" });
  return { ...result, integration: integrationDetail(id)! };
};

export const unblockIntegration = (actor: TeamActor & object, id: string) => {
  unblockUser(actor, id, { via: "web", kind: "service" });
  return { ok: true as const, integration: integrationDetail(id)! };
};

/**
 * References to the account that are not merely its own access, settings, or history: anything it
 * created or touched (owned items, versions it wrote, comments, card and row authorship, reactions,
 * routines, proposals). Found from the schema's foreign keys, so a table added later counts as
 * content until it is listed here: deleting then keeps the account (the safe side).
 */
const NOT_CONTENT = new Set([
  // Its access and membership, which go with it.
  "sessions.user_id", "note_shares.user_id", "folder_shares.user_id", "document_shares.user_id", "board_members.user_id", "collection_members.user_id",
  "calendar_members.user_id", "task_view_members.user_id", "group_members.user_id", "card_assignees.user_id",
  // Its own settings, notices, and credentials.
  "reminders.user_id", "notifications.user_id", "push_subscriptions.user_id", "calendar_feeds.user_id", "user_preferences.user_id",
  "email_prefs.user_id", "mail_outbox.user_id", "auth_tokens.user_id", "email_mutes.user_id", "mail_share_log.user_id", "mail_share_log.actor_id",
  "access_notices.user_id", "access_notices.actor_id", "access_notices.target_user_id", "google_identities.user_id", "google_auth_flows.user_id",
  "mcp_api_keys.user_id", "mcp_api_keys.created_by", "mcp_api_keys.revoked_by",
  // Logs keep ids (set to NULL) and are not content.
  "team_events.target_user_id", "team_events.actor_id", "audit_log.actor_id", "access_events.actor_id", "users.blocked_by",
  "team_invites.created_by", "team_invites.used_by", "team_invites.revoked_by", "user_groups.created_by", "group_members.added_by",
  "group_grants.granted_by", "team_settings.updated_by"
]);

let referenceColumns: Array<{ table: string; column: string }> | null = null;
function contentColumns() {
  if (referenceColumns) return referenceColumns;
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const columns: Array<{ table: string; column: string }> = [];
  for (const { name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
    for (const key of db.query(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string; from: string }>) {
      if (key.table === "users" && !NOT_CONTENT.has(`${name}.${key.from}`)) columns.push({ table: name, column: key.from });
    }
  }
  referenceColumns = columns;
  return columns;
}

/** How many rows of content reference the account (its empty Default folder does not count). */
export function contentReferences(id: string) {
  let total = 0;
  for (const { table, column } of contentColumns()) {
    if (table === "folders" && column === "owner_id") {
      total += (db.query(`SELECT COUNT(*) AS count FROM folders f WHERE f.owner_id = ? AND NOT (f.is_default = 1
        AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.folder_id = f.id) AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = f.id))`).get(id) as { count: number }).count;
      continue;
    }
    total += (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id) as { count: number }).count;
    if (total > 0) return total;
  }
  return total;
}

export const DELETED_REASON = "Integration deleted";

/**
 * Deletes an integration (admins only). Its keys are revoked first, always. Then:
 * - it owns or wrote nothing (only its empty Default folder, its access, and its logs): the account
 *   is removed, which also removes everything shared with it;
 * - it created or touched content: it is kept, blocked, as a tombstone, so that content keeps its
 *   owner and its name. Unblocking it later brings it back without keys.
 */
export function deleteIntegration(actor: { id: string; role: Role }, id: string) {
  requireAdmin(actor);
  const target = db.query("SELECT id, disabled_at FROM users WHERE id = ? AND kind = 'service'").get(id) as { id: string; disabled_at: string | null } | null;
  if (!target) throw notFound();
  return db.transaction(() => {
    const keys = db.query("SELECT id FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").all(id) as Array<{ id: string }>;
    for (const key of keys) adminRevokeKey(actor.id, key.id, DELETED_REASON, { notify: false, meta: { integrationDeleted: true } });
    const timestamp = now();
    if (contentReferences(id) > 0) {
      if (target.disabled_at === null) blockUser(actor, id, DELETED_REASON, { via: "web", kind: "service" });
      recordAccessEvent({ actorId: actor.id, via: "web", action: "integration.retired", targetUserId: id, meta: { keysRevoked: keys.length } }, timestamp);
      audit(actor.id, null, "team.integration_retired", { targetId: id, keysRevoked: keys.length });
      return { deleted: false as const, retained: true as const, keysRevoked: keys.length, integration: integrationDetail(id)! };
    }
    // Team history about it goes with it (it is append-only only while the account exists).
    db.query("DELETE FROM users WHERE id = ? AND kind = 'service'").run(id);
    recordAccessEvent({ actorId: actor.id, via: "web", action: "integration.deleted", targetUserId: id, meta: { keysRevoked: keys.length } }, timestamp);
    audit(actor.id, null, "team.integration_deleted", { targetId: id, keysRevoked: keys.length });
    return { deleted: true as const, retained: false as const, keysRevoked: keys.length };
  })();
}

// ------------------------------------------------------------------------------ key picker

export type IntegrationResource = { value: string; label: string; description?: string; writable: boolean; readOnly?: boolean };

const LIST_MAX = 500;
const ownerNote = (row: { owner_id: string; owner_name: string }, id: string) => row.owner_id === id ? undefined : `Owned by ${row.owner_name}`;
const labelled = (kind: string, note: string | undefined) => note ? `${kind} · ${note}` : kind;

/**
 * The items a chosen-items grant on an integration's key can name: what the integration itself can
 * open (shared with it by name), never what the admin can. Titles here are of items their owners
 * shared with the integration (T212). `writable`: whether a writing grant may name it.
 */
export function integrationResources(id: string, module: GrantModule): IntegrationResource[] {
  const params = { userId: id };
  type Owned = { id: string; name: string; owner_id: string; owner_name: string };
  switch (module) {
    case "tasks": {
      const boards = db.query(`SELECT b.id, b.name, b.owner_id, u.display_name AS owner_name, (${editableBoardPredicate}) AS editable FROM boards b JOIN users u ON u.id = b.owner_id
        WHERE ${readableBoardPredicate} ORDER BY b.name COLLATE NOCASE LIMIT ${LIST_MAX}`).all(params) as Array<Owned & { editable: number }>;
      return boards.map((board) => ({ value: `board:${board.id}`, label: board.name, description: labelled("Board", ownerNote(board, id)), writable: board.editable === 1 }));
    }
    case "notes": {
      const folders = listReadableFolders(id).slice(0, LIST_MAX);
      const notes = db.query(`SELECT n.id, COALESCE(NULLIF(n.title, ''), 'Untitled') AS name, n.owner_id, u.display_name AS owner_name FROM notes n JOIN users u ON u.id = n.owner_id
        WHERE n.deleted_at IS NULL AND ${readableNotePredicate} ORDER BY n.updated_at DESC LIMIT ${LIST_MAX}`).all(params) as Owned[];
      return [
        ...folders.map((folder) => ({ value: `folder:${folder.id}`, label: folder.name, description: labelled("Folder", ownerNote(folder, id) ?? "notes directly in it"), writable: folder.owner_id === id })),
        ...notes.map((note) => ({ value: `note:${note.id}`, label: note.name, description: labelled("Note", ownerNote(note, id)), writable: note.owner_id === id }))
      ];
    }
    case "files": {
      const folders = listReadableFolders(id).slice(0, LIST_MAX);
      const documents = db.query(`SELECT d.id, d.name, d.owner_id, u.display_name AS owner_name FROM documents d JOIN users u ON u.id = d.owner_id
        WHERE d.purpose = 'file' AND ${readableDocumentPredicate} ORDER BY d.name COLLATE NOCASE LIMIT ${LIST_MAX}`).all(params) as Owned[];
      return [
        ...folders.map((folder) => ({ value: `folder:${folder.id}`, label: folder.name, description: labelled("Folder", ownerNote(folder, id) ?? "files directly in it"), writable: folder.owner_id === id })),
        ...documents.map((document) => ({ value: `document:${document.id}`, label: document.name, description: labelled("File", ownerNote(document, id)), writable: document.owner_id === id }))
      ];
    }
    case "collections": {
      const rows = db.query(`SELECT c.id, c.name, c.owner_id, u.display_name AS owner_name, (${editableCollectionPredicate}) AS editable FROM collections c JOIN users u ON u.id = c.owner_id
        WHERE ${readableCollectionPredicate} ORDER BY c.name COLLATE NOCASE LIMIT ${LIST_MAX}`).all(params) as Array<Owned & { editable: number }>;
      return rows.map((row) => ({ value: `collection:${row.id}`, label: row.name, description: ownerNote(row, id), writable: row.editable === 1 }));
    }
    case "calendar": {
      const rows = db.query(`SELECT k.id, k.name, k.owner_id, u.display_name AS owner_name, (${editableCalendarPredicate}) AS editable FROM calendars k JOIN users u ON u.id = k.owner_id
        WHERE ${readableCalendarPredicate} ORDER BY k.name COLLATE NOCASE LIMIT ${LIST_MAX}`).all(params) as Array<Owned & { editable: number }>;
      return rows.map((row) => ({ value: `calendar:${row.id}`, label: row.name, description: ownerNote(row, id), writable: row.editable === 1 }));
    }
    case "whiteboards": {
      const rows = db.query(`SELECT d.id, d.name, d.owner_id, u.display_name AS owner_name FROM documents d JOIN whiteboards w ON w.document_id = d.id JOIN users u ON u.id = d.owner_id
        WHERE d.purpose = 'file' AND ${readableDocumentPredicate} ORDER BY d.name COLLATE NOCASE LIMIT ${LIST_MAX}`).all(params) as Owned[];
      return rows.map((row) => ({ value: `whiteboard:${row.id}`, label: whiteboardDisplayName(row.name), description: ownerNote(row, id), writable: row.owner_id === id }));
    }
    default:
      return [];
  }
}
