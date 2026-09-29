import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { audit, db, now } from "../db";
import { recordAccessEvent } from "../access/events";
import { notifyAccess } from "../access/notices";
import { presentItem } from "../access/effective";
import { isLevel, type AccessKind } from "../access/levels";
import { parseJson, uuid } from "../validation";
import { can, type Role } from "./roles";
import { readPolicies } from "./policies";
import { GUEST_SHARE_DISABLED } from "../access/shares";

/**
 * Groups (access plan D267, §C.6, O-A1, T200). Admins create groups and decide who is in them;
 * owners share items with a group from the Access sheet at a level. An admin never grants content
 * directly: membership only reaches items whose owners chose to share with the group (D73).
 *
 * Every change is one transaction with a compare-and-swap on `revision` and writes `access_events`
 * rows (ids only). An admin adding themselves is allowed but flagged (`self` in the event, and
 * `selfAdded` on the member row) so the group page and the Access sheet can say so (O-A1).
 */

export const GROUPS_LIMIT = 200;
export const GROUP_MEMBERS_LIMIT = 500;
export const GROUP_NAME_MAX = 60;
export const GROUP_DESCRIPTION_MAX = 200;
const HISTORY_LIMIT = 50;
const ITEMS_LIMIT = 200;

export type GroupErrorCode = "NOT_FOUND" | "GROUP_CHANGED" | "NAME_TAKEN" | "LIMIT_REACHED" | "INVALID_MEMBERS" | "GUEST_SHARE_DISABLED";

export class GroupError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: GroupErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GroupError";
  }
}

const notFound = () => new GroupError(404, "NOT_FOUND", "Group not found");
const changed = (revision: number) => new GroupError(409, "GROUP_CHANGED", "Someone else changed this group. Reload to see the latest.", { revision });

type GroupRow = { id: string; name: string; description: string | null; created_at: string; updated_at: string; revision: number; member_count: number; guest_count: number; grant_count: number };

const groupSelect = `SELECT g.id, g.name, g.description, g.created_at, g.updated_at, g.revision,
    (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
    (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id AND u.role = 'guest') AS guest_count,
    (SELECT COUNT(*) FROM group_grants gg WHERE gg.group_id = g.id) AS grant_count
  FROM user_groups g`;

export type GroupSummary = { id: string; name: string; description: string | null; memberCount: number; guestCount: number; grantCount: number; revision: number; createdAt: string; updatedAt: string };

const summary = (row: GroupRow): GroupSummary => ({
  id: row.id, name: row.name, description: row.description, memberCount: row.member_count, guestCount: row.guest_count,
  grantCount: row.grant_count, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
});

/** Team → Groups (admins): every group, by name. */
export function listGroups() {
  const rows = db.query(`${groupSelect} ORDER BY g.name COLLATE NOCASE, g.id LIMIT ?`).all(GROUPS_LIMIT) as GroupRow[];
  return { groups: rows.map(summary), limit: GROUPS_LIMIT };
}

/**
 * `GET /api/groups` for the share picker (§C.7): names and counts only, never members. The guest
 * count lets the sheet say "includes 2 guests" (T213).
 */
export function pickerGroups() {
  const rows = db.query(`${groupSelect} ORDER BY g.name COLLATE NOCASE, g.id LIMIT ?`).all(GROUPS_LIMIT) as GroupRow[];
  return { groups: rows.map((row) => ({ id: row.id, name: row.name, memberCount: row.member_count, guestCount: row.guest_count })) };
}

function groupRow(groupId: string) {
  return db.query(`${groupSelect} WHERE g.id = ?`).get(groupId) as GroupRow | null;
}

export type GroupMember = { id: string; displayName: string; role: Role; status: "active" | "blocked"; addedAt: string; addedBy: { id: string; displayName: string } | null; selfAdded: boolean };

function groupMembers(groupId: string): GroupMember[] {
  const rows = db.query(`SELECT u.id, u.display_name, u.role, u.disabled_at, gm.added_at, gm.added_by, a.display_name AS added_by_name
    FROM group_members gm JOIN users u ON u.id = gm.user_id LEFT JOIN users a ON a.id = gm.added_by
    WHERE gm.group_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id`).all(groupId) as Array<{ id: string; display_name: string; role: Role; disabled_at: string | null; added_at: string; added_by: string | null; added_by_name: string | null }>;
  return rows.map((row) => ({
    id: row.id, displayName: row.display_name, role: row.role, status: row.disabled_at === null ? "active" : "blocked", addedAt: row.added_at,
    addedBy: row.added_by && row.added_by_name !== null ? { id: row.added_by, displayName: row.added_by_name } : null,
    selfAdded: row.added_by !== null && row.added_by === row.id
  }));
}

export type GroupHistoryRow = { id: string; action: string; createdAt: string; actor: { id: string; displayName: string } | null; target: { id: string; displayName: string } | null; self: boolean };

function groupHistory(groupId: string): GroupHistoryRow[] {
  const rows = db.query(`SELECT e.id, e.action, e.created_at, e.actor_id, a.display_name AS actor_name, e.target_user_id, t.display_name AS target_name, e.meta_json
    FROM access_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users t ON t.id = e.target_user_id
    WHERE e.group_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`).all(groupId, HISTORY_LIMIT) as Array<{ id: string; action: string; created_at: string; actor_id: string | null; actor_name: string | null; target_user_id: string | null; target_name: string | null; meta_json: string | null }>;
  return rows.map((row) => {
    const meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {};
    return {
      id: row.id, action: row.action, createdAt: row.created_at,
      actor: row.actor_id && row.actor_name !== null ? { id: row.actor_id, displayName: row.actor_name } : null,
      target: row.target_user_id && row.target_name !== null ? { id: row.target_user_id, displayName: row.target_name } : null,
      self: meta.self === true
    };
  });
}

/**
 * The items shared with a group (§C.6), redacted for the viewing admin (D269, T204): a title only
 * when the admin can read the item, otherwise "Board owned by Carol" and no id.
 */
function groupItems(groupId: string, viewerId: string) {
  const grants = db.query("SELECT resource_kind, resource_id, level FROM group_grants WHERE group_id = ? AND resource_kind <> 'vault' ORDER BY created_at, resource_id LIMIT ?")
    .all(groupId, ITEMS_LIMIT + 1) as Array<{ resource_kind: AccessKind; resource_id: string; level: string }>;
  const items = grants.slice(0, ITEMS_LIMIT).flatMap((grant) => {
    const item = presentItem(grant.resource_kind, grant.resource_id, viewerId);
    return item && isLevel(grant.level) ? [{ ...item, level: grant.level }] : [];
  });
  return { items, truncated: grants.length > ITEMS_LIMIT };
}

export function getGroup(viewerId: string, groupId: string) {
  const row = groupRow(groupId);
  if (!row) throw notFound();
  // With share_with_guests off, guests cannot join a group that has a grant (T213); the page disables them.
  const guestAddRefused = row.grant_count > 0 && !readPolicies().shareWithGuests;
  return { group: { ...summary(row), members: groupMembers(groupId), ...groupItems(groupId, viewerId), history: groupHistory(groupId), guestAddRefused } };
}

const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed: user_groups\.name/.test(error.message);

export function createGroup(actorId: string, input: { name: string; description?: string | null }) {
  const id = crypto.randomUUID();
  try {
    db.transaction(() => {
      const count = (db.query("SELECT COUNT(*) AS count FROM user_groups").get() as { count: number }).count;
      if (count >= GROUPS_LIMIT) throw new GroupError(409, "LIMIT_REACHED", `Nook can have up to ${GROUPS_LIMIT} groups`);
      const timestamp = now();
      db.query("INSERT INTO user_groups (id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.name, input.description || null, actorId, timestamp, timestamp);
      recordAccessEvent({ actorId, via: "web", action: "group.created", groupId: id });
      audit(actorId, null, "group.created", { groupId: id });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) throw new GroupError(409, "NAME_TAKEN", "A group with this name already exists");
    throw error;
  }
  return getGroup(actorId, id);
}

export function patchGroup(actorId: string, groupId: string, input: { name?: string; description?: string | null; revision: number }) {
  try {
    db.transaction(() => {
      const row = groupRow(groupId);
      if (!row) throw notFound();
      if (row.revision !== input.revision) throw changed(row.revision);
      const updated = db.query(`UPDATE user_groups SET name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END,
        updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?`)
        .run(input.name ?? null, input.description !== undefined ? 1 : 0, input.description || null, now(), groupId, input.revision);
      if (updated.changes !== 1) throw changed(row.revision);
      recordAccessEvent({ actorId, via: "web", action: "group.updated", groupId, meta: { renamed: input.name !== undefined && input.name !== row.name } });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) throw new GroupError(409, "NAME_TAKEN", "A group with this name already exists");
    throw error;
  }
  return getGroup(actorId, groupId);
}

/** Deletes a group; its grants and memberships go with it (ON DELETE CASCADE). Returns the counts removed. */
export function deleteGroup(actorId: string, groupId: string, revision?: number) {
  return db.transaction(() => {
    const row = groupRow(groupId);
    if (!row) throw notFound();
    if (revision !== undefined && row.revision !== revision) throw changed(row.revision);
    db.query("DELETE FROM user_groups WHERE id = ?").run(groupId);
    // group_id is kept on the event (no FK), so the history stays readable in the audit.
    recordAccessEvent({ actorId, via: "web", action: "group.deleted", groupId, meta: { memberCount: row.member_count, grantCount: row.grant_count } });
    audit(actorId, null, "group.deleted", { groupId, memberCount: row.member_count, grantCount: row.grant_count });
    return { ok: true as const, removedGrants: row.grant_count, removedMembers: row.member_count };
  })();
}

/**
 * Replaces a group's members (≤ 500 enabled accounts). Additions and removals are each one
 * `access_events` row; an admin adding themselves is recorded with `self: true` (O-A1, T200).
 *
 * With `share_with_guests` off, adding a guest to a group that already has a grant is refused
 * (400 GUEST_SHARE_DISABLED, T213): it would reach a guest as surely as sharing with them. Guests
 * already in the group stay and can be removed, and a group without grants takes guests (sharing
 * it later is refused by the sharing routes). The policy is not retroactive.
 */
export function putGroupMembers(actorId: string, groupId: string, input: { userIds: string[]; revision: number }) {
  const wanted = [...new Set(input.userIds.map((id) => id.toLowerCase()))];
  if (wanted.length > GROUP_MEMBERS_LIMIT) throw new GroupError(400, "INVALID_MEMBERS", `A group can have up to ${GROUP_MEMBERS_LIMIT} members`);
  return db.transaction(() => {
    const row = groupRow(groupId);
    if (!row) throw notFound();
    if (row.revision !== input.revision) throw changed(row.revision);
    const current = new Set((db.query("SELECT user_id FROM group_members WHERE group_id = ?").all(groupId) as Array<{ user_id: string }>).map((member) => member.user_id));
    const added = wanted.filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.includes(id));
    if (added.length) {
      const placeholders = added.map(() => "?").join(",");
      const valid = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...added) as Array<{ id: string }>;
      if (valid.length !== added.length) throw new GroupError(400, "INVALID_MEMBERS", "One or more people were not found");
      if (guestJoinRefused(groupId, added)) throw new GroupError(400, "GUEST_SHARE_DISABLED", GUEST_SHARE_DISABLED.error);
    }
    const timestamp = now();
    const insert = db.query("INSERT INTO group_members (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)");
    const remove = db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?");
    for (const userId of added) {
      insert.run(groupId, userId, actorId, timestamp);
      recordAccessEvent({ actorId, via: "web", action: "group.member_added", groupId, targetUserId: userId, meta: userId === actorId ? { self: true } : null }, timestamp);
      // The bell (§C.11, Wave 33); nobody is told about their own change.
      notifyAccess({ userId, kind: "group_added", actorId, groupId }, timestamp);
    }
    for (const userId of removed) {
      remove.run(groupId, userId);
      recordAccessEvent({ actorId, via: "web", action: "group.member_removed", groupId, targetUserId: userId, meta: userId === actorId ? { self: true } : null }, timestamp);
      notifyAccess({ userId, kind: "group_removed", actorId, groupId }, timestamp);
    }
    db.query("UPDATE user_groups SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, groupId);
    if (added.length || removed.length) audit(actorId, null, "group.members_changed", { groupId, added: added.length, removed: removed.length, selfAdded: added.includes(actorId) });
    return { added: added.length, removed: removed.length, selfAdded: added.includes(actorId) };
  })();
}

/**
 * The one guest rule for joining a group (T213), shared by Team → Groups, access templates on
 * invite acceptance, and applying a template to someone (Wave 33): with `share_with_guests` off,
 * a guest may not join a group that has any grant. Removing people is never refused.
 */
export function guestJoinRefused(groupId: string, userIds: readonly string[]) {
  if (!userIds.length || readPolicies().shareWithGuests) return false;
  if (!db.query("SELECT 1 FROM group_grants WHERE group_id = ? LIMIT 1").get(groupId)) return false;
  return Boolean(db.query(`SELECT 1 FROM users WHERE role = 'guest' AND id IN (${userIds.map(() => "?").join(",")}) LIMIT 1`).get(...userIds));
}

/** Whether a group has a guest in it (the `share_with_guests` policy, D.2). */
export function groupHasGuests(groupId: string) {
  return Boolean(db.query("SELECT 1 FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND u.role = 'guest' LIMIT 1").get(groupId));
}

// ---------------------------------------------------------------------------
// Routes

const nameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX);
const descriptionSchema = z.string().trim().max(GROUP_DESCRIPTION_MAX).nullable();
export const createGroupSchema = z.object({ name: nameSchema, description: descriptionSchema.optional() }).strict();
export const patchGroupSchema = z.object({ name: nameSchema.optional(), description: descriptionSchema.optional(), revision: z.number().int().min(1) }).strict();
export const groupMembersSchema = z.object({ userIds: z.array(uuid).max(GROUP_MEMBERS_LIMIT), revision: z.number().int().min(1) }).strict();
const deleteGroupSchema = z.object({ revision: z.number().int().min(1).optional() }).strict();

type Gate = (c: Context<AppEnv>) => Response | null;

/**
 * `/api/team/groups` (admins; guests 404, everyone else 403 ADMIN_ONLY, writes rate-limited by the
 * Team write gate) and `GET /api/groups` for the share picker (members and admins; read-only roles
 * get 403 like `/api/users`, because they cannot share). Registered before `/api/team/:userId`.
 */
export function registerGroupRoutes(app: Hono<AppEnv>, gates: { read: Gate; write: Gate }) {
  const groupId = (c: Context<AppEnv>) => uuid.safeParse(c.req.param("groupId")?.toLowerCase()).data ?? null;
  const missing = (c: Context<AppEnv>) => c.json({ error: "Group not found", code: "NOT_FOUND" }, 404);
  const run = async (c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) => {
    try {
      return c.json(operation() as object, status);
    } catch (error) {
      if (error instanceof GroupError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
      throw error;
    }
  };

  app.get("/api/groups", (c) => {
    const user = c.get("user");
    if (!can(user.role, "sharing.write")) return c.json({ error: "Your team role is read-only", code: "ROLE_READ_ONLY" }, 403);
    const groups = pickerGroups();
    // With share_with_guests off, groups that include guests cannot be picked (D.2); they stay listed so the sheet can say why.
    return c.json({ ...groups, shareWithGuests: readPolicies().shareWithGuests });
  });

  app.get("/api/team/groups", (c) => gates.read(c) ?? c.json(listGroups()));

  app.post("/api/team/groups", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const body = await parseJson(c.req.raw, createGroupSchema);
    return run(c, () => createGroup(c.get("user").id, body), 201);
  });

  app.get("/api/team/groups/:groupId", (c) => {
    const refused = gates.read(c);
    if (refused) return refused;
    const id = groupId(c);
    if (!id) return missing(c);
    return run(c, () => getGroup(c.get("user").id, id));
  });

  app.patch("/api/team/groups/:groupId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = groupId(c);
    if (!id) return missing(c);
    const body = await parseJson(c.req.raw, patchGroupSchema);
    return run(c, () => patchGroup(c.get("user").id, id, body));
  });

  app.delete("/api/team/groups/:groupId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = groupId(c);
    if (!id) return missing(c);
    const body = await parseJson(c.req.raw, deleteGroupSchema);
    return run(c, () => deleteGroup(c.get("user").id, id, body.revision));
  });

  app.put("/api/team/groups/:groupId/members", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = groupId(c);
    if (!id) return missing(c);
    const body = await parseJson(c.req.raw, groupMembersSchema);
    return run(c, () => ({ ...putGroupMembers(c.get("user").id, id, body), ...getGroup(c.get("user").id, id) }));
  });
}
