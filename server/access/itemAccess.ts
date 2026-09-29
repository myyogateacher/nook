import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { audit, db, now } from "../db";
import { mailShared } from "../mail/triggers";
import type { SharedKind } from "../mail/templates/activity";
import { withNoteLock, withResourceLock } from "../storage";
import { readPolicies } from "../team/policies";
import type { Role } from "../team/roles";
import { parseJson, uuid } from "../validation";
import { keysReachingItem } from "../apiKeys";
import type { GrantModule } from "../keyGrants";
import { itemLevel } from "./effective";
import { recordAccessEvent } from "./events";
import { AUDIENCE_LEVELS, KIND_LEVELS, LEVELS, isLevel, levelToShareRole, shareRoleToLevel, type AccessKind, type ItemLevel, type Level } from "./levels";
import { directShares, guestShareAdditions, GUEST_SHARE_DISABLED, writeDirectShares } from "./shares";

/**
 * The item access API behind the Access sheet (access plan §C.5, §C.7, D270–D275, T204, T207,
 * T213): `GET/PUT …/access` for notes, folders, files, boards, task views, collections, and
 * calendars. People and groups, each with a level from the module's list (§D.3), plus the audience.
 *
 * - Only the owner and, where the module has them, managers open it; other readers get 403
 *   OWNER_ONLY and everyone else the same 404 as a missing item (T204).
 * - `PUT` needs `If-Match` with the ETag from `GET` (a hash of the audience and every grant row; no
 *   revision column): a stale one gets 409 ACCESS_CHANGED with the current access (no lost updates).
 * - Managers (D273, T207) change people and groups up to `edit`: they cannot grant or remove
 *   `manage`, and cannot change the audience or its level.
 * - The `share_with_guests` policy refuses a save that newly adds a guest, a group with a guest, or
 *   raises one of them (400 GUEST_SHARE_DISABLED with the offending ids); rows kept from before the
 *   policy was turned off save unchanged, lowered, or removed (T213, not retroactive).
 * - One transaction replaces the direct rows and the group grants; `access_events` records counts only.
 *
 * The older `PUT …/sharing` routes keep working next to it (server/access/shares.ts).
 */

export const MAX_PEOPLE = 100;
export const MAX_GROUPS = 20;

type Audience = "private" | "selected" | "all_users" | "inherit";

type ItemState = {
  ownerId: string;
  ownerName: string;
  title: string;
  audience: Audience;
  /** The `all_users` level where the module has one (boards, collections, calendars). */
  audienceLevel: Level | null;
};

type KindConfig = {
  /** Notes and files may inherit their immediate folder's access. */
  inherit: boolean;
  mail: SharedKind;
  /** The live item's current audience, or null when it is gone (binned, purged, or not a Files document). */
  state: (id: string) => ItemState | null;
  /** Writes the audience (and its level) inside the PUT transaction. */
  writeAudience: (id: string, audience: Audience, audienceLevel: Level | null) => void;
  lock: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
};

const stamp = () => now();
const resourceLock = (key: string) => <T>(id: string, operation: () => Promise<T>) => withResourceLock(key.replace("{id}", id), operation);

const CONFIG: Record<AccessKind, KindConfig> = {
  note: {
    inherit: true,
    mail: "note",
    state: (id) => {
      const row = db.query("SELECT n.title, n.owner_id, u.display_name AS owner_name, n.visibility, n.sharing_override FROM notes n JOIN users u ON u.id = n.owner_id WHERE n.id = ? AND n.deleted_at IS NULL")
        .get(id) as { title: string; owner_id: string; owner_name: string; visibility: Audience; sharing_override: number } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.title, audience: row.sharing_override ? row.visibility : "inherit", audienceLevel: null };
    },
    writeAudience: (id, audience) => {
      db.query("UPDATE notes SET visibility = ?, sharing_override = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(audience === "inherit" ? "private" : audience, audience === "inherit" ? 0 : 1, stamp(), id);
    },
    lock: <T>(id: string, operation: () => Promise<T>) => withNoteLock(id, operation)
  },
  folder: {
    inherit: false,
    mail: "folder",
    state: (id) => {
      const row = db.query("SELECT f.name, f.owner_id, u.display_name AS owner_name, f.visibility FROM folders f JOIN users u ON u.id = f.owner_id WHERE f.id = ?")
        .get(id) as { name: string; owner_id: string; owner_name: string; visibility: Audience } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.name, audience: row.visibility, audienceLevel: null };
    },
    writeAudience: (id, audience) => {
      db.query("UPDATE folders SET visibility = ?, updated_at = ? WHERE id = ?").run(audience, stamp(), id);
    },
    lock: resourceLock("access:folder:{id}")
  },
  document: {
    inherit: true,
    mail: "file",
    state: (id) => {
      const row = db.query("SELECT d.name, d.owner_id, u.display_name AS owner_name, d.visibility, d.sharing_override FROM documents d JOIN users u ON u.id = d.owner_id WHERE d.id = ? AND d.deleted_at IS NULL AND d.purpose = 'file'")
        .get(id) as { name: string; owner_id: string; owner_name: string; visibility: Audience; sharing_override: number } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.name, audience: row.sharing_override ? row.visibility : "inherit", audienceLevel: null };
    },
    writeAudience: (id, audience) => {
      db.query("UPDATE documents SET visibility = ?, sharing_override = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(audience === "inherit" ? "private" : audience, audience === "inherit" ? 0 : 1, stamp(), id);
    },
    lock: resourceLock("document:{id}")
  },
  board: {
    inherit: false,
    mail: "board",
    state: (id) => {
      const row = db.query("SELECT b.name, b.owner_id, u.display_name AS owner_name, b.visibility, b.share_role FROM boards b JOIN users u ON u.id = b.owner_id WHERE b.id = ? AND b.deleted_at IS NULL")
        .get(id) as { name: string; owner_id: string; owner_name: string; visibility: Audience; share_role: Level } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.name, audience: row.visibility, audienceLevel: row.share_role };
    },
    writeAudience: (id, audience, audienceLevel) => {
      db.query("UPDATE boards SET visibility = ?, share_role = COALESCE(?, share_role), updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(audience, audienceLevel, stamp(), id);
    },
    lock: resourceLock("board:{id}")
  },
  task_view: {
    inherit: false,
    mail: "view",
    state: (id) => {
      const row = db.query("SELECT v.name, v.owner_id, u.display_name AS owner_name, v.visibility FROM task_views v JOIN users u ON u.id = v.owner_id WHERE v.id = ?")
        .get(id) as { name: string; owner_id: string; owner_name: string; visibility: Audience } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.name, audience: row.visibility, audienceLevel: null };
    },
    writeAudience: (id, audience) => {
      // Sharing is part of the view: its revision moves, as with the older route (409 VIEW_CHANGED for stale editors).
      db.query("UPDATE task_views SET visibility = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(audience, stamp(), id);
    },
    lock: resourceLock("access:task_view:{id}")
  },
  collection: {
    inherit: false,
    mail: "collection",
    state: (id) => {
      const row = db.query("SELECT c.name, c.owner_id, u.display_name AS owner_name, c.visibility, c.share_role FROM collections c JOIN users u ON u.id = c.owner_id WHERE c.id = ? AND c.deleted_at IS NULL")
        .get(id) as { name: string; owner_id: string; owner_name: string; visibility: Audience; share_role: "viewer" | "editor" } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.name, audience: row.visibility, audienceLevel: shareRoleToLevel(row.share_role) };
    },
    writeAudience: (id, audience, audienceLevel) => {
      db.query("UPDATE collections SET visibility = ?, share_role = COALESCE(?, share_role), updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(audience, audienceLevel ? levelToShareRole(audienceLevel) : null, stamp(), id);
    },
    lock: resourceLock("collection:{id}")
  },
  calendar: {
    inherit: false,
    mail: "calendar",
    state: (id) => {
      const row = db.query("SELECT k.name, k.owner_id, u.display_name AS owner_name, k.visibility, k.share_role FROM calendars k JOIN users u ON u.id = k.owner_id WHERE k.id = ? AND k.deleted_at IS NULL")
        .get(id) as { name: string; owner_id: string; owner_name: string; visibility: Audience; share_role: "viewer" | "editor" } | null;
      return row && { ownerId: row.owner_id, ownerName: row.owner_name, title: row.name, audience: row.visibility, audienceLevel: shareRoleToLevel(row.share_role) };
    },
    writeAudience: (id, audience, audienceLevel) => {
      db.query("UPDATE calendars SET visibility = ?, share_role = COALESCE(?, share_role), updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(audience, audienceLevel ? levelToShareRole(audienceLevel) : null, stamp(), id);
    },
    lock: resourceLock("access:calendar:{id}")
  }
};

export class AccessError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 428, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AccessError";
  }
}

const notFound = () => new AccessError(404, "NOT_FOUND", "Not found");

type GroupRow = { id: string; name: string; level: Level; member_count: number; guest_count: number; self_added: number };

function groupGrants(kind: AccessKind, id: string) {
  return db.query(`SELECT g.id, g.name, gg.level,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id AND u.role = 'guest') AS guest_count,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.added_by = gm.user_id) AS self_added
    FROM group_grants gg JOIN user_groups g ON g.id = gg.group_id
    WHERE gg.resource_kind = ? AND gg.resource_id = ? AND gg.env_id IS NULL ORDER BY g.name COLLATE NOCASE, g.id`).all(kind, id) as GroupRow[];
}

/** The ETag of an item's access: a hash of the audience and every grant row, sorted (§C.5). */
function etagOf(state: ItemState, people: ReadonlyMap<string, Level>, groups: ReadonlyArray<{ id: string; level: Level }>) {
  const canonical = JSON.stringify({
    audience: state.audience,
    audienceLevel: state.audienceLevel,
    people: [...people].map(([userId, level]) => `${userId}:${level}`).sort(),
    groups: groups.map((group) => `${group.id}:${group.level}`).sort()
  });
  return `"${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}"`;
}

/** The caller's level and the item, or the 404/403 a non-owner, non-manager gets. */
function authorize(kind: AccessKind, id: string, userId: string) {
  const state = CONFIG[kind].state(id);
  if (!state) throw notFound();
  const level = itemLevel(kind, id, userId);
  if (level === "none") throw notFound();
  const managerKinds: readonly AccessKind[] = ["board", "collection", "calendar"];
  if (level !== "owner" && !(level === "manage" && managerKinds.includes(kind))) throw new AccessError(403, "OWNER_ONLY", "Only the owner or a manager can change who has access");
  return { state, yourLevel: level as "owner" | "manage" };
}

export type ItemAccess = ReturnType<typeof readAccess>;

const KEY_MODULE: Record<AccessKind, GrantModule> = { note: "notes", folder: "notes", document: "files", board: "tasks", task_view: "tasks", collection: "collections", calendar: "calendar" };

/** How many of the owner's keys reach this item right now (`keysReachingItem`: usable, not blocked by policy, an active grant). */
const keysReaching = (kind: AccessKind, id: string, ownerId: string) => keysReachingItem(ownerId, KEY_MODULE[kind], kind, id);

export function readAccess(kind: AccessKind, id: string, userId: string) {
  const { state, yourLevel } = authorize(kind, id, userId);
  const direct = directShares(kind, id);
  const groups = groupGrants(kind, id);
  const ids = [...direct.keys()];
  const users = ids.length
    ? db.query(`SELECT id, display_name, role, kind, disabled_at FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; display_name: string; role: Role; kind: "person" | "service"; disabled_at: string | null }>
    : [];
  const offered = KIND_LEVELS[kind].filter((level) => yourLevel === "owner" || level !== "manage");
  // Which of this item's granted groups each listed person is in, so the sheet can say when a group
  // gives them more than their own row (the highest level wins, D266). The groups are listed already.
  const memberOf = new Map<string, string[]>();
  if (ids.length && groups.length) {
    const rows = db.query(`SELECT user_id, group_id FROM group_members WHERE group_id IN (${groups.map(() => "?").join(",")}) AND user_id IN (${ids.map(() => "?").join(",")})`)
      .all(...groups.map((group) => group.id), ...ids) as Array<{ user_id: string; group_id: string }>;
    for (const row of rows) memberOf.set(row.user_id, [...(memberOf.get(row.user_id) ?? []), row.group_id]);
  }
  return {
    etag: etagOf(state, direct, groups),
    kind,
    title: state.title,
    owner: { id: state.ownerId, displayName: state.ownerName },
    audience: state.audience,
    ...(AUDIENCE_LEVELS[kind] ? { audienceLevel: state.audienceLevel, audienceLevels: AUDIENCE_LEVELS[kind] } : {}),
    people: users.map((user) => ({ id: user.id, displayName: user.display_name, teamRole: user.role, kind: user.kind, level: direct.get(user.id)!, via: "direct" as const, blocked: user.disabled_at !== null, groupIds: memberOf.get(user.id) ?? [] }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })),
    groups: groups.map((group) => ({ id: group.id, name: group.name, memberCount: group.member_count, guestCount: group.guest_count, selfAddedCount: group.self_added, level: group.level })),
    levels: offered,
    yourLevel,
    // "N of your API keys can reach this" (§C.5, §E): the owner's own usable keys only (Wave 33).
    ...(yourLevel === "owner" ? { keysWithAccess: keysReaching(kind, id, userId) } : {}),
    // The caller's id, so the sheet can tell a manager's own row apart (they cannot change it, MANAGER_CAP).
    youId: userId,
    shareWithGuests: readPolicies().shareWithGuests,
    inheritable: CONFIG[kind].inherit
  };
}

const principal = z.object({ id: uuid, level: z.enum(LEVELS) }).strict();
export const accessPutSchema = z.object({
  audience: z.enum(["private", "selected", "all_users", "inherit"]),
  audienceLevel: z.enum(LEVELS).optional(),
  people: z.array(principal).max(MAX_PEOPLE).default([]),
  groups: z.array(principal).max(MAX_GROUPS).default([])
}).strict();
export type AccessPut = z.infer<typeof accessPutSchema>;

/** Validates and writes a PUT. `ifMatch` is the request's If-Match header. */
export async function writeAccess(kind: AccessKind, id: string, userId: string, body: AccessPut, ifMatch: string | undefined) {
  if (!ifMatch) throw new AccessError(428, "ETAG_REQUIRED", "Send If-Match with the ETag from GET …/access");
  const config = CONFIG[kind];
  return config.lock(id, async () => db.transaction(() => {
      const current = readAccess(kind, id, userId);
      if (ifMatch !== current.etag && ifMatch !== current.etag.slice(1, -1)) {
        throw new AccessError(409, "ACCESS_CHANGED", "Someone else changed who has access. Review the latest and save again.", { access: current });
      }
      const people = dedupe(body.people.map((entry) => ({ id: entry.id.toLowerCase(), level: entry.level })));
      const groups = dedupe(body.groups.map((entry) => ({ id: entry.id.toLowerCase(), level: entry.level })));
      validate(kind, id, current, body, people, groups, userId);
      const selected = body.audience === "selected";
      const before = [...directShares(kind, id).keys()];
      writeDirectShares(kind, id, selected ? people.map((entry) => ({ userId: entry.id, level: entry.level })) : []);
      db.query("DELETE FROM group_grants WHERE resource_kind = ? AND resource_id = ? AND env_id IS NULL").run(kind, id);
      if (selected) {
        const insert = db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)");
        const timestamp = now();
        for (const group of groups) insert.run(kind, id, group.id, group.level, userId, timestamp);
      }
      const audienceLevel = AUDIENCE_LEVELS[kind] ? body.audienceLevel ?? current.audienceLevel ?? null : null;
      config.writeAudience(id, body.audience, audienceLevel as Level | null);
      // "Shared with you" mail for people newly added by name (outbound email #25); groups are not mailed (§C.11).
      if (selected) mailShared(userId, config.mail, id, before, people.map((entry) => entry.id));
      const counts = { kind, audience: body.audience, peopleCount: selected ? people.length : 0, groupCount: selected ? groups.length : 0 };
      audit(userId, kind === "note" ? id : null, "item.access_changed", { ...counts, itemId: id, ...(current.yourLevel === "manage" ? { asManager: true } : {}) });
      recordAccessEvent({ actorId: userId, via: "web", action: "item.access_changed", resource: { kind, id }, meta: { ...counts, ...(current.yourLevel === "manage" ? { asManager: true } : {}) } });
      return readAccess(kind, id, userId);
  })());
}

function dedupe(entries: Array<{ id: string; level: Level }>) {
  const byId = new Map<string, Level>();
  for (const entry of entries) byId.set(entry.id, entry.level);
  return [...byId].map(([id, level]) => ({ id, level }));
}

function validate(kind: AccessKind, id: string, current: ItemAccess, body: AccessPut, people: Array<{ id: string; level: Level }>, groups: Array<{ id: string; level: Level }>, userId: string) {
  const invalid = (message: string, code = "INVALID") => new AccessError(400, code, message);
  if (body.audience === "inherit" && !current.inheritable) throw invalid("Only notes and files can use their folder's access");
  if (body.audienceLevel !== undefined) {
    const allowed = AUDIENCE_LEVELS[kind];
    if (!allowed) throw invalid("This item has no level for everyone signed in");
    if (!allowed.includes(body.audienceLevel)) throw invalid("That level is not offered for everyone signed in", "LEVEL_NOT_OFFERED");
  }
  const offered = KIND_LEVELS[kind];
  for (const entry of [...people, ...groups]) if (!offered.includes(entry.level)) throw invalid(`${entry.level} is not offered here`, "LEVEL_NOT_OFFERED");
  if (body.audience !== "selected" && (people.length || groups.length)) throw invalid("People and groups apply only to “People and groups I choose”");
  if (body.audience === "selected" && people.length === 0 && groups.length === 0) throw invalid("Choose at least one person or group");
  if (people.some((entry) => entry.id === current.owner.id)) throw invalid("The owner cannot be added as a recipient");
  const added = people.filter((entry) => !current.people.some((person) => person.id === entry.id)).map((entry) => entry.id);
  if (added.length) {
    const found = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${added.map(() => "?").join(",")})`).all(...added) as Array<{ id: string }>;
    if (found.length !== added.length) throw invalid("One or more people were not found");
  }
  if (groups.length) {
    const found = db.query(`SELECT id FROM user_groups WHERE id IN (${groups.map(() => "?").join(",")})`).all(...groups.map((group) => group.id)) as Array<{ id: string }>;
    if (found.length !== groups.length) throw invalid("One or more groups were not found");
  }
  const guests = body.audience === "selected" ? guestShareAdditions(kind, id, people, groups) : null;
  if (guests) throw new AccessError(400, GUEST_SHARE_DISABLED.code, GUEST_SHARE_DISABLED.error, { guests });
  if (current.yourLevel === "manage") managerCaps(current, body, people, groups, userId);
}

/**
 * D273, T207: a manager shares up to `edit`. They keep the audience and its level as they are, never
 * grant `manage`, and leave every existing manager (person or group) exactly as it is.
 */
function managerCaps(current: ItemAccess, body: AccessPut, people: Array<{ id: string; level: Level }>, groups: Array<{ id: string; level: Level }>, userId: string) {
  const refuse = (message: string) => new AccessError(403, "MANAGER_CAP", message);
  if (body.audience !== current.audience) throw refuse("Only the owner changes who can open this");
  if (body.audienceLevel !== undefined && body.audienceLevel !== current.audienceLevel) throw refuse("Only the owner changes what everyone signed in can do");
  const managers = (entries: ReadonlyArray<{ id: string; level: Level | string }>) => entries.filter((entry) => entry.level === "manage").map((entry) => entry.id).sort().join(",");
  if (managers(people) !== managers(current.people) || managers(groups) !== managers(current.groups)) throw refuse("Only the owner adds, changes, or removes managers");
  // A manager's own row is a manager row, so the check above keeps them in place too.
  void userId;
}

// ---------------------------------------------------------------------------
// Routes

const ROUTES: Array<{ kind: AccessKind; path: string; param: string }> = [
  { kind: "note", path: "/api/notes/:id/access", param: "id" },
  { kind: "folder", path: "/api/folders/:id/access", param: "id" },
  { kind: "document", path: "/api/files/:id/access", param: "id" },
  { kind: "board", path: "/api/tasks/boards/:boardId/access", param: "boardId" },
  { kind: "task_view", path: "/api/tasks/views/:viewId/access", param: "viewId" },
  { kind: "collection", path: "/api/collections/:collectionId/access", param: "collectionId" },
  { kind: "calendar", path: "/api/calendars/:calendarId/access", param: "calendarId" }
];

function respond(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AccessError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  throw error;
}

export function registerItemAccessRoutes(app: Hono<AppEnv>) {
  for (const route of ROUTES) {
    const idOf = (c: Context<AppEnv>) => uuid.safeParse(c.req.param(route.param)?.toLowerCase()).data ?? null;
    app.get(route.path, (c) => {
      const id = idOf(c);
      if (!id) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
      try {
        const access = readAccess(route.kind, id, c.get("user").id);
        c.header("ETag", access.etag);
        c.header("Cache-Control", "no-store");
        return c.json(access);
      } catch (error) {
        return respond(c, error);
      }
    });
    app.put(route.path, async (c) => {
      const id = idOf(c);
      if (!id) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
      const body = await parseJson(c.req.raw, accessPutSchema);
      try {
        const access = await writeAccess(route.kind, id, c.get("user").id, body, c.req.header("If-Match"));
        c.header("ETag", access.etag);
        c.header("Cache-Control", "no-store");
        return c.json(access);
      } catch (error) {
        return respond(c, error);
      }
    });
  }
}

export const isAccessLevel = isLevel;
export type { ItemLevel };
