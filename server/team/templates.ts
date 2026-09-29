import { z } from "zod";
import { audit, db, now } from "../db";
import { recordAccessEvent } from "../access/events";
import { notifyAccess } from "../access/notices";
import { uuid } from "../validation";
import { GUEST_SHARE_DISABLED } from "../access/shares";
import { GROUP_MEMBERS_LIMIT, guestJoinRefused } from "./groups";

/**
 * Access templates (access plan D286, §C.6): a name, a team role, and groups. An invite may carry
 * one; accepting the invite adds the new account to the template's groups inside the registration
 * transaction. An admin can also apply a template to an existing person from their access page,
 * which adds the groups only (a role change stays the Team role control, with its own confirm).
 *
 * A template never grants an item: it only adds group memberships, and a group reaches only what
 * owners shared with it (D267). Deleting a template leaves invites working (ON DELETE SET NULL);
 * a group deleted since is skipped. Every change is CAS by `revision` and recorded in
 * `access_events` (ids and counts only).
 */

export const TEMPLATES_LIMIT = 50;
export const TEMPLATE_GROUPS_LIMIT = 20;
export const TEMPLATE_ROLES = ["member", "viewer", "guest"] as const;
export type TemplateRole = typeof TEMPLATE_ROLES[number];

export class TemplateError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TemplateError";
  }
}

const notFound = () => new TemplateError(404, "NOT_FOUND", "Template not found");

type TemplateRow = { id: string; name: string; role: TemplateRole; group_ids: string; created_at: string; updated_at: string; revision: number };

const groupIdsOf = (row: Pick<TemplateRow, "group_ids">) => (JSON.parse(row.group_ids) as unknown[]).filter((value): value is string => typeof value === "string");

function present(row: TemplateRow) {
  const ids = groupIdsOf(row);
  const groups = ids.length
    ? db.query(`SELECT id, name FROM user_groups WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; name: string }>
    : [];
  const byId = new Map(groups.map((group) => [group.id, group.name]));
  const liveInvites = (db.query("SELECT COUNT(*) AS count FROM team_invites WHERE template_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .get(row.id, now()) as { count: number }).count;
  return {
    id: row.id, name: row.name, role: row.role,
    // Groups deleted since are dropped from the answer (and skipped when the template is applied).
    groups: ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)! })),
    liveInvites, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
export type AccessTemplate = ReturnType<typeof present>;

const rowById = (id: string) => db.query("SELECT * FROM access_templates WHERE id = ?").get(id) as TemplateRow | null;

export function listTemplates() {
  const rows = db.query("SELECT * FROM access_templates ORDER BY name COLLATE NOCASE, id LIMIT ?").all(TEMPLATES_LIMIT) as TemplateRow[];
  return { templates: rows.map(present), limit: TEMPLATES_LIMIT };
}

export function getTemplate(id: string) {
  const row = rowById(id);
  return row ? present(row) : null;
}

function checkGroups(groupIds: readonly string[]) {
  const unique = [...new Set(groupIds.map((id) => id.toLowerCase()))];
  if (unique.length) {
    const found = db.query(`SELECT id FROM user_groups WHERE id IN (${unique.map(() => "?").join(",")})`).all(...unique) as Array<{ id: string }>;
    if (found.length !== unique.length) throw new TemplateError(400, "INVALID_GROUPS", "One or more groups were not found");
  }
  return unique;
}

const isNameTaken = (error: unknown) => error instanceof Error && /UNIQUE constraint failed: access_templates\.name/.test(error.message);

export function createTemplate(actorId: string, input: { name: string; role: TemplateRole; groupIds: string[] }) {
  const id = crypto.randomUUID();
  try {
    db.transaction(() => {
      const count = (db.query("SELECT COUNT(*) AS count FROM access_templates").get() as { count: number }).count;
      if (count >= TEMPLATES_LIMIT) throw new TemplateError(409, "LIMIT_REACHED", `Nook can have up to ${TEMPLATES_LIMIT} templates`);
      const groupIds = checkGroups(input.groupIds);
      const timestamp = now();
      db.query("INSERT INTO access_templates (id, name, role, group_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.name, input.role, JSON.stringify(groupIds), timestamp, timestamp);
      recordAccessEvent({ actorId, via: "web", action: "template.created", meta: { templateId: id, role: input.role, groupCount: groupIds.length } }, timestamp);
      audit(actorId, null, "team.template_created", { templateId: id, role: input.role, groupCount: groupIds.length });
    })();
  } catch (error) {
    if (isNameTaken(error)) throw new TemplateError(409, "NAME_TAKEN", "A template with this name already exists");
    throw error;
  }
  return { template: getTemplate(id)! };
}

export function patchTemplate(actorId: string, id: string, input: { name?: string; role?: TemplateRole; groupIds?: string[]; revision: number }) {
  try {
    db.transaction(() => {
      const row = rowById(id);
      if (!row) throw notFound();
      if (row.revision !== input.revision) throw new TemplateError(409, "TEMPLATE_CHANGED", "Someone else changed this template. It now shows the latest.", { revision: row.revision });
      const groupIds = input.groupIds ? checkGroups(input.groupIds) : null;
      const timestamp = now();
      const changed = db.query(`UPDATE access_templates SET name = COALESCE(?, name), role = COALESCE(?, role), group_ids = COALESCE(?, group_ids),
        updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?`)
        .run(input.name ?? null, input.role ?? null, groupIds ? JSON.stringify(groupIds) : null, timestamp, id, input.revision).changes;
      if (!changed) throw new TemplateError(409, "TEMPLATE_CHANGED", "Someone else changed this template. It now shows the latest.", { revision: row.revision });
      recordAccessEvent({ actorId, via: "web", action: "template.updated", meta: { templateId: id, fields: Object.keys(input).filter((key) => key !== "revision") } }, timestamp);
    })();
  } catch (error) {
    if (isNameTaken(error)) throw new TemplateError(409, "NAME_TAKEN", "A template with this name already exists");
    throw error;
  }
  return { template: getTemplate(id)! };
}

/** Deletes a template. Invites that carried it keep working with their own role and no groups (ON DELETE SET NULL). */
export function deleteTemplate(actorId: string, id: string, revision?: number) {
  return db.transaction(() => {
    const row = rowById(id);
    if (!row) throw notFound();
    if (revision !== undefined && row.revision !== revision) throw new TemplateError(409, "TEMPLATE_CHANGED", "Someone else changed this template. It now shows the latest.", { revision: row.revision });
    const invites = (db.query("SELECT COUNT(*) AS count FROM team_invites WHERE template_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").get(id, now()) as { count: number }).count;
    db.query("DELETE FROM access_templates WHERE id = ?").run(id);
    recordAccessEvent({ actorId, via: "web", action: "template.deleted", meta: { templateId: id, liveInvites: invites } });
    audit(actorId, null, "team.template_deleted", { templateId: id });
    return { ok: true as const, liveInvites: invites };
  })();
}

/**
 * Adds `userId` to the template's groups that still exist and have room. Call inside the caller's
 * transaction (registration, or the admin's apply). `actorId` is who added them: the invite's admin
 * on registration. Returns how many groups were joined and skipped.
 */
export function applyTemplateGroups(actorId: string | null, userId: string, templateId: string, options: { notify: boolean; timestamp?: string; guests: "skip" | "refuse" }) {
  const row = rowById(templateId);
  if (!row) return null;
  const timestamp = options.timestamp ?? now();
  let added = 0;
  let skipped = 0;
  let guestRefused = 0;
  // The same guest rule as Team → Groups (T213): with share_with_guests off a guest never joins a
  // group that has grants. Registration skips that group (the account is still created); applying
  // a template to someone refuses as a whole, before anything is added.
  const groupIds = groupIdsOf(row);
  if (options.guests === "refuse" && groupIds.some((groupId) => guestJoinRefused(groupId, [userId]))) {
    throw new TemplateError(400, "GUEST_SHARE_DISABLED", GUEST_SHARE_DISABLED.error);
  }
  for (const groupId of groupIds) {
    const group = db.query("SELECT (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS members FROM user_groups g WHERE g.id = ?").get(groupId) as { members: number } | null;
    if (!group || group.members >= GROUP_MEMBERS_LIMIT) { skipped += 1; continue; }
    if (guestJoinRefused(groupId, [userId])) { skipped += 1; guestRefused += 1; continue; }
    const inserted = db.query("INSERT OR IGNORE INTO group_members (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(groupId, userId, actorId, timestamp).changes;
    if (!inserted) continue;
    added += 1;
    db.query("UPDATE user_groups SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, groupId);
    recordAccessEvent({ actorId, via: "web", action: "group.member_added", groupId, targetUserId: userId, meta: { from: "template", ...(actorId === userId ? { self: true } : {}) } }, timestamp);
    if (options.notify) notifyAccess({ userId, kind: "group_added", actorId, groupId }, timestamp);
  }
  recordAccessEvent({ actorId, via: "web", action: "template.applied", targetUserId: userId, meta: { templateId, added, skipped, ...(guestRefused ? { guestRefused } : {}) } }, timestamp);
  return { added, skipped, guestRefused, templateName: row.name, role: row.role };
}

/** From the member access page: the template's groups for an existing person (never their role). */
export function applyTemplateToMember(actorId: string, userId: string, templateId: string) {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(userId)) throw new TemplateError(404, "NOT_FOUND", "Team member not found");
    const result = applyTemplateGroups(actorId, userId, templateId, { notify: true, guests: "refuse" });
    if (!result) throw notFound();
    audit(actorId, null, "team.template_applied", { templateId, targetId: userId, added: result.added });
    return result;
  })();
}

// ---------------------------------------------------------------------------- schemas

const nameSchema = z.string().trim().min(1).max(60);
export const createTemplateSchema = z.object({ name: nameSchema, role: z.enum(TEMPLATE_ROLES), groupIds: z.array(uuid).max(TEMPLATE_GROUPS_LIMIT).default([]) }).strict();
export const patchTemplateSchema = z.object({
  name: nameSchema.optional(), role: z.enum(TEMPLATE_ROLES).optional(), groupIds: z.array(uuid).max(TEMPLATE_GROUPS_LIMIT).optional(), revision: z.number().int().min(1)
}).strict();
export const deleteTemplateSchema = z.object({ revision: z.number().int().min(1).optional() }).strict();
