import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { audit, db, now } from "../db";
import { avatarUrlFor } from "../avatars";
import { readPolicies } from "../team/policies";
import { audienceAllUsersFor, type Role } from "../team/roles";
import { parseJson, uuid } from "../validation";
import { recordAccessEvent } from "./events";
import { capByRole, isLevel, LEVEL_RANK, LEVELS, maxLevel, type ItemLevel, type Level } from "./levels";
import { CONTAINER_MODULE, isWorkspaceModuleId, MODULE_CONTAINER, WORKSPACE_CONTAINER_KINDS, type WorkspaceContainerKind } from "../../shared/workspaceModules";
import { isShortId } from "../../shared/friendlyUrls";
import { notify } from "../notify";
import { mailShared } from "../mail/triggers";
import { workKindAdapter } from "../links/adapters";

/**
 * Access for the workspace modules' containers (docs/plan/WORKSPACE_MODULES.md §B.9, D803, T511):
 * forms, time projects, goals, standups, contact books, booking types, and townhall sessions.
 *
 * Every container row has `owner_id`, `visibility` (`private` | `selected` | `all_users`),
 * `share_role` (the `all_users` level), `deleted_at`, and a `short_id`; people and groups are rows of
 * the generic `item_members` / `item_group_grants` tables (085), always filtered by `item_kind` (T511).
 * The ladder and the role ceiling are the existing ones (server/access/levels.ts, D266): the owner is
 * `owner`; `all_users` gives everyone but guests and integrations the audience level; `selected` gives
 * the best of the person's row and their groups' rows; a Team role caps it (viewers and guests read).
 *
 * A lane registers its container once (`registerAccessContainer`), naming its table; everything else
 * (levels, list predicates, the Access sheet at `/api/access/:kind/:id`, key grant checks, the key
 * picker's list) works from that. Contact books are registered here, since their table is foundation.
 */

export type AccessContainer = {
  kind: WorkspaceContainerKind;
  table: string;
  /** The column people see as its name. */
  nameColumn: string;
  /** Levels the Access sheet offers people and groups; default all four. */
  levels?: readonly Level[];
  /** Levels the `all_users` audience may hold; default view, comment, edit. */
  audienceLevels?: readonly Level[];
  /** Rows that are not containers people share (a hidden system book), excluded from lists and the sheet. */
  hiddenWhere?: string;
};

const containers = new Map<WorkspaceContainerKind, AccessContainer>();

export function registerAccessContainer(container: AccessContainer) {
  if (!(WORKSPACE_CONTAINER_KINDS as readonly string[]).includes(container.kind)) throw new Error(`Unknown container kind ${container.kind}`);
  if (!/^[a-z_]+$/.test(container.table) || !/^[a-z_]+$/.test(container.nameColumn)) throw new Error("Invalid container table");
  if (containers.has(container.kind)) throw new Error(`Access container ${container.kind} is already registered`);
  containers.set(container.kind, container);
  return () => { if (containers.get(container.kind) === container) containers.delete(container.kind); };
}

export const accessContainer = (kind: string): AccessContainer | null => containers.get(kind as WorkspaceContainerKind) ?? null;
export const registeredContainers = () => [...containers.values()];
export const isContainerKind = (value: unknown): value is WorkspaceContainerKind => typeof value === "string" && (WORKSPACE_CONTAINER_KINDS as readonly string[]).includes(value);

// Contact books are foundation (088).
registerAccessContainer({ kind: "contact_book", table: "contact_books", nameColumn: "name", hiddenWhere: "system_kind IS NOT NULL" });

const roleQuery = () => db.query("SELECT role, kind FROM users WHERE id = ? AND disabled_at IS NULL");
const roleOf = (userId: string) => roleQuery().get(userId) as { role: Role; kind: string } | null;

type ContainerRow = { id: string; owner_id: string; visibility: "private" | "selected" | "all_users"; share_role: string; deleted_at: string | null; name: string };

/** The container's row by id or short id (live or binned), or null. */
export function containerRow(kind: WorkspaceContainerKind, ref: string): ContainerRow | null {
  const container = containers.get(kind);
  if (!container) return null;
  const column = isShortId(ref) ? "short_id" : "id";
  return db.query(`SELECT id, owner_id, visibility, share_role, deleted_at, ${container.nameColumn} AS name FROM ${container.table} WHERE ${column} = ?`).get(ref.toLowerCase()) as ContainerRow | null;
}

/**
 * `itemLevel()` for a workspace container (§F.2): the caller's live level, `none` when the container
 * is missing, binned, or unreadable. Read fresh every call (T202).
 */
export function itemLevel(kind: WorkspaceContainerKind, ref: string, userId: string): ItemLevel {
  const row = containerRow(kind, ref);
  if (!row || row.deleted_at !== null) return "none";
  return levelOfRow(kind, row, userId);
}

function levelOfRow(kind: WorkspaceContainerKind, row: ContainerRow, userId: string): ItemLevel {
  const user = roleOf(userId);
  if (!user) return "none";
  if (row.owner_id === userId) return "owner";
  let best: ItemLevel = "none";
  if (row.visibility === "all_users" && user.role !== "guest" && user.kind === "person") best = isLevel(row.share_role) ? row.share_role : "view";
  else if (row.visibility === "selected") {
    const direct = db.query("SELECT level FROM item_members WHERE item_kind = ? AND item_id = ? AND user_id = ?").get(kind, row.id, userId) as { level: Level } | null;
    const groups = db.query(`SELECT g.level FROM item_group_grants g JOIN group_members gm ON gm.group_id = g.group_id
      WHERE g.item_kind = ? AND g.item_id = ? AND gm.user_id = ?`).all(kind, row.id, userId) as Array<{ level: Level }>;
    best = maxLevel(direct?.level, ...groups.map((group) => group.level));
  }
  return capByRole(best, user.role);
}

/** The level a guest may never exceed on a container they do not own (read only, D266). */
const levelSql = (column: string) => `(CASE ${column} WHEN 'view' THEN 1 WHEN 'comment' THEN 2 WHEN 'edit' THEN 3 WHEN 'manage' THEN 4 ELSE 0 END)`;

/**
 * An SQL predicate: the row aliased `alias` of a `kind` container is readable at `minLevel` or more by
 * the user bound as `userParam` (named parameter, default `$userId`). Live rows only. The role ceiling
 * is applied: viewers and guests reach `view` only, so any `minLevel` above `view` excludes them
 * except as owners. Lists use it before LIMIT, so pages and counts hold only readable rows.
 */
export function readableContainerSql(kind: WorkspaceContainerKind, alias: string, options: { userParam?: string; minLevel?: Level } = {}): string {
  const container = containers.get(kind);
  if (!container) return "0";
  const user = options.userParam ?? "$userId";
  const rank = LEVEL_RANK[options.minLevel ?? "view"];
  const writer = `(SELECT u_w.role IN ('admin','member') FROM users u_w WHERE u_w.id = ${user} AND u_w.disabled_at IS NULL) = 1`;
  const capped = rank > 1 ? ` AND ${writer}` : ` AND EXISTS (SELECT 1 FROM users u_l WHERE u_l.id = ${user} AND u_l.disabled_at IS NULL)`;
  return `(${alias}.deleted_at IS NULL AND (${alias}.owner_id = ${user}
    OR (${alias}.visibility = 'all_users' AND ${audienceAllUsersFor(user)} AND ${levelSql(`${alias}.share_role`)} >= ${rank}${capped})
    OR (${alias}.visibility = 'selected'${capped} AND (
      EXISTS (SELECT 1 FROM item_members im WHERE im.item_kind = '${kind}' AND im.item_id = ${alias}.id AND im.user_id = ${user} AND ${levelSql("im.level")} >= ${rank})
      OR EXISTS (SELECT 1 FROM item_group_grants ig JOIN group_members igm ON igm.group_id = ig.group_id
        WHERE ig.item_kind = '${kind}' AND ig.item_id = ${alias}.id AND igm.user_id = ${user} AND ${levelSql("ig.level")} >= ${rank})))))`;
}

/** The ids of every `kind` container the user can read (at `minLevel`), for small lists and joins. */
export function readableIds(kind: WorkspaceContainerKind, userId: string, minLevel: Level = "view"): string[] {
  const container = containers.get(kind);
  if (!container) return [];
  return (db.query(`SELECT c.id FROM ${container.table} c WHERE ${readableContainerSql(kind, "c", { minLevel })}`).all({ userId }) as Array<{ id: string }>).map((row) => row.id);
}

/** For key grants (server/apiKeys.ts): may this user name the container in a read or write grant? */
export function containerReachable(kind: string, id: string, userId: string, write: boolean) {
  if (!isContainerKind(kind) || !containers.has(kind)) return false;
  const level = itemLevel(kind, id, userId);
  return write ? LEVEL_RANK[level] >= LEVEL_RANK.edit : level !== "none";
}

/** For key grants and admin views: the container's name when the user can read it, else null. */
export function containerName(kind: string, id: string, userId: string): string | null {
  if (!isContainerKind(kind) || !containers.has(kind)) return null;
  const row = containerRow(kind, id);
  return row && row.deleted_at === null && levelOfRow(kind, row, userId) !== "none" ? row.name : null;
}

// ---------------------------------------------------------------------------
// The Access sheet: GET/PUT /api/access/:kind/:id (the same JSON as the existing …/access routes).

export class WorkspaceAccessError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 428, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const MAX_PEOPLE = 100;
const MAX_GROUPS = 20;

function members(kind: WorkspaceContainerKind, id: string) {
  return new Map((db.query("SELECT user_id, level FROM item_members WHERE item_kind = ? AND item_id = ?").all(kind, id) as Array<{ user_id: string; level: Level }>)
    .map((row) => [row.user_id, row.level]));
}

function groupGrants(kind: WorkspaceContainerKind, id: string) {
  return db.query(`SELECT g.id, g.name, gg.level,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id AND u.role = 'guest') AS guest_count
    FROM item_group_grants gg JOIN user_groups g ON g.id = gg.group_id
    WHERE gg.item_kind = ? AND gg.item_id = ? ORDER BY g.name COLLATE NOCASE, g.id`).all(kind, id) as Array<{ id: string; name: string; level: Level; member_count: number; guest_count: number }>;
}

export function readWorkspaceAccess(kind: WorkspaceContainerKind, ref: string, userId: string) {
  const container = containers.get(kind);
  const row = containerRow(kind, ref);
  if (!container || !row || row.deleted_at !== null) throw new WorkspaceAccessError(404, "NOT_FOUND", "Not found");
  if (container.hiddenWhere && db.query(`SELECT 1 FROM ${container.table} WHERE id = ? AND ${container.hiddenWhere}`).get(row.id)) throw new WorkspaceAccessError(404, "NOT_FOUND", "Not found");
  const level = levelOfRow(kind, row, userId);
  if (level === "none") throw new WorkspaceAccessError(404, "NOT_FOUND", "Not found");
  if (level !== "owner" && level !== "manage") throw new WorkspaceAccessError(403, "OWNER_ONLY", "Only the owner or a manager can change who has access");
  const direct = members(kind, row.id);
  const groups = groupGrants(kind, row.id);
  const ids = [...direct.keys()];
  const users = ids.length
    ? db.query(`SELECT id, display_name, role, kind, disabled_at, avatar_id FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; display_name: string; role: Role; kind: string; disabled_at: string | null; avatar_id: string | null }>
    : [];
  const owner = db.query("SELECT display_name FROM users WHERE id = ?").get(row.owner_id) as { display_name: string } | null;
  const audienceLevels = container.audienceLevels ?? ["view", "comment", "edit"];
  const levels = (container.levels ?? LEVELS).filter((entry) => level === "owner" || entry !== "manage");
  const etag = `"${createHash("sha256").update(JSON.stringify({ v: row.visibility, l: row.share_role, p: [...direct].map(([u, l]) => `${u}:${l}`).sort(), g: groups.map((g) => `${g.id}:${g.level}`).sort() })).digest("hex").slice(0, 24)}"`;
  return {
    etag, kind, id: row.id, title: row.name,
    owner: { id: row.owner_id, displayName: owner?.display_name ?? "Former member" },
    audience: row.visibility,
    audienceLevel: isLevel(row.share_role) ? row.share_role : "view",
    audienceLevels,
    people: users.map((user) => ({ id: user.id, displayName: user.display_name, teamRole: user.role, kind: user.kind, level: direct.get(user.id)!, via: "direct" as const, blocked: user.disabled_at !== null, groupIds: [] as string[], avatarUrl: avatarUrlFor(user.id, user.avatar_id) }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })),
    groups: groups.map((group) => ({ id: group.id, name: group.name, memberCount: group.member_count, guestCount: group.guest_count, selfAddedCount: 0, level: group.level })),
    levels,
    yourLevel: level as "owner" | "manage",
    youId: userId,
    shareWithGuests: readPolicies().shareWithGuests,
    inheritable: false
  };
}

const principal = z.object({ id: uuid, level: z.enum(LEVELS) }).strict();
export const workspaceAccessPutSchema = z.object({
  audience: z.enum(["private", "selected", "all_users"]),
  audienceLevel: z.enum(LEVELS).optional(),
  people: z.array(principal).max(MAX_PEOPLE).default([]),
  groups: z.array(principal).max(MAX_GROUPS).default([])
}).strict();

export function writeWorkspaceAccess(kind: WorkspaceContainerKind, ref: string, userId: string, body: z.infer<typeof workspaceAccessPutSchema>, ifMatch: string | undefined) {
  if (!ifMatch) throw new WorkspaceAccessError(428, "ETAG_REQUIRED", "Send If-Match with the ETag from GET …/access");
  return db.transaction(() => {
    const current = readWorkspaceAccess(kind, ref, userId);
    if (ifMatch !== current.etag && ifMatch !== current.etag.slice(1, -1)) throw new WorkspaceAccessError(409, "ACCESS_CHANGED", "Someone else changed who has access. Review the latest and save again.", { access: current });
    const container = containers.get(kind)!;
    const invalid = (message: string, code = "INVALID") => new WorkspaceAccessError(400, code, message);
    const dedupe = (entries: Array<{ id: string; level: Level }>) => [...new Map(entries.map((entry) => [entry.id.toLowerCase(), entry.level])).entries()].map(([id, level]) => ({ id, level }));
    const people = dedupe(body.people);
    const groups = dedupe(body.groups);
    const offered = container.levels ?? LEVELS;
    for (const entry of [...people, ...groups]) if (!offered.includes(entry.level)) throw invalid(`${entry.level} is not offered here`, "LEVEL_NOT_OFFERED");
    if (body.audienceLevel !== undefined && !current.audienceLevels.includes(body.audienceLevel)) throw invalid("That level is not offered for everyone signed in", "LEVEL_NOT_OFFERED");
    if (body.audience !== "selected" && (people.length || groups.length)) throw invalid("People and groups apply only to “People and groups I choose”");
    if (body.audience === "selected" && !people.length && !groups.length) throw invalid("Choose at least one person or group");
    if (people.some((entry) => entry.id === current.owner.id)) throw invalid("The owner cannot be added as a recipient");
    if (people.length) {
      const found = db.query(`SELECT id, role FROM users WHERE disabled_at IS NULL AND id IN (${people.map(() => "?").join(",")})`).all(...people.map((entry) => entry.id)) as Array<{ id: string; role: Role }>;
      if (found.length !== people.length) throw invalid("One or more people were not found");
      if (!readPolicies().shareWithGuests) {
        const before = new Map(current.people.map((person) => [person.id, person.level]));
        const guests = found.filter((user) => user.role === "guest" && (!before.has(user.id) || LEVEL_RANK[people.find((entry) => entry.id === user.id)!.level] > LEVEL_RANK[before.get(user.id)!]));
        if (guests.length) throw new WorkspaceAccessError(400, "GUEST_SHARE_DISABLED", "Sharing with guests is turned off for this Nook", { guests: { people: guests.map((guest) => guest.id), groups: [] } });
      }
    }
    if (groups.length) {
      const found = db.query(`SELECT id FROM user_groups WHERE id IN (${groups.map(() => "?").join(",")})`).all(...groups.map((group) => group.id)) as Array<{ id: string }>;
      if (found.length !== groups.length) throw invalid("One or more groups were not found");
    }
    if (current.yourLevel === "manage") {
      const refuse = (message: string) => new WorkspaceAccessError(403, "MANAGER_CAP", message);
      if (body.audience !== current.audience || (body.audienceLevel !== undefined && body.audienceLevel !== current.audienceLevel)) throw refuse("Only the owner changes who can open this");
      const managers = (entries: ReadonlyArray<{ id: string; level: string }>) => entries.filter((entry) => entry.level === "manage").map((entry) => entry.id).sort().join(",");
      if (managers(people) !== managers(current.people) || managers(groups) !== managers(current.groups)) throw refuse("Only the owner adds, changes, or removes managers");
    }
    const id = current.id;
    const timestamp = now();
    db.query("DELETE FROM item_members WHERE item_kind = ? AND item_id = ?").run(kind, id);
    db.query("DELETE FROM item_group_grants WHERE item_kind = ? AND item_id = ?").run(kind, id);
    if (body.audience === "selected") {
      const addMember = db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const entry of people) addMember.run(kind, id, entry.id, entry.level, userId, timestamp);
      const addGroup = db.query("INSERT INTO item_group_grants (item_kind, item_id, group_id, level, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const entry of groups) addGroup.run(kind, id, entry.id, entry.level, userId, timestamp);
    }
    db.query(`UPDATE ${container.table} SET visibility = ?, share_role = COALESCE(?, share_role), updated_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(body.audience, body.audienceLevel ?? null, timestamp, id);
    // D1366: people newly added by name hear about it (bell, "Shared with you" mail, digest), as core
    // sharing does (itemAccess.ts); groups and the everyone audience are not told (§C.11, D239).
    notifyWorkspaceShared(kind, id, row(kind, id)?.name ?? current.title, userId, current.people.map((person) => person.id), body.audience === "selected" ? people.map((entry) => entry.id) : []);
    const counts = { kind, audience: body.audience, peopleCount: people.length, groupCount: groups.length };
    audit(userId, null, "item.access_changed", { ...counts, itemId: id, ...(current.yourLevel === "manage" ? { asManager: true } : {}) });
    recordAccessEvent({ actorId: userId, via: "web", action: "item.access_changed", resource: { kind: kind as never, id }, meta: counts });
    return readWorkspaceAccess(kind, id, userId);
  })();
}

const row = (kind: WorkspaceContainerKind, id: string) => containerRow(kind, id);

/**
 * Tells the people added by name to a container's access list (D1366, T692): a bell notification in
 * the container's module (topic `core.shared`, naming the sharer and the item, which they can now
 * open), the `sharing` category's "Shared with you" mail (resolved again as them when it is sent), and
 * the digest's share log. Never the sharer; only people who can open it after the change. Call
 * inside the write's transaction.
 */
export function notifyWorkspaceShared(kind: WorkspaceContainerKind, id: string, title: string, actorId: string, before: readonly string[], after: readonly string[]) {
  const had = new Set(before);
  const added = [...new Set(after)].filter((userId) => userId !== actorId && !had.has(userId) && itemLevel(kind, id, userId) !== "none");
  if (!added.length) return [];
  const actor = (db.query("SELECT display_name FROM users WHERE id = ?").get(actorId) as { display_name: string } | null)?.display_name ?? "Someone";
  const noun = SHARE_NOUNS[kind];
  const href = kind === "contact_book" ? "/contacts" : workKindAdapter(kind)?.resolve([id], { userId: added[0]! }).get(id)?.href ?? "/notifications";
  const { notified } = notify({
    userIds: added, module: CONTAINER_MODULE[kind], topic: "core.shared", actor: actorId,
    title: `${actor} shared the ${noun} ‘${title}’ with you`, href,
    item: kind === "contact_book" ? null : { kind, id }, dedupeKey: `shared:${kind}:${id}`
  });
  mailShared(actorId, kind, id, [], notified);
  return notified;
}

const SHARE_NOUNS: Record<WorkspaceContainerKind, string> = {
  form: "form", time_project: "time project", goal: "goal", checkin: "standup", contact_book: "contact book", booking_type: "booking type", townhall_session: "townhall"
};

/** Adds or replaces one member (lanes: "share with the people I picked" on create). Call inside the write's transaction. */
export function setItemMember(kind: WorkspaceContainerKind, itemId: string, memberId: string, level: Level, addedBy: string | null) {
  db.query(`INSERT INTO item_members (item_kind, item_id, user_id, level, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_kind, item_id, user_id) DO UPDATE SET level = excluded.level`).run(kind, itemId, memberId, level, addedBy, now());
}

function respond(c: Context<AppEnv>, error: unknown) {
  if (error instanceof WorkspaceAccessError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  throw error;
}

export function registerWorkspaceAccessRoutes(app: Hono<AppEnv>) {
  const target = (c: Context<AppEnv>) => {
    const kind = c.req.param("kind");
    const ref = c.req.param("id") ?? "";
    if (!isContainerKind(kind) || !containers.has(kind) || !(uuid.safeParse(ref.toLowerCase()).success || isShortId(ref.toLowerCase()))) return null;
    return { kind, ref };
  };
  app.get("/api/access/:kind/:id", (c) => {
    const item = target(c);
    if (!item) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    try {
      const access = readWorkspaceAccess(item.kind, item.ref, c.get("user").id);
      c.header("ETag", access.etag);
      return c.json(access);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.put("/api/access/:kind/:id", async (c) => {
    const item = target(c);
    if (!item) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    const body = await parseJson(c.req.raw, workspaceAccessPutSchema);
    try {
      const access = writeWorkspaceAccess(item.kind, item.ref, c.get("user").id, body, c.req.header("If-Match"));
      c.header("ETag", access.etag);
      return c.json(access);
    } catch (error) {
      return respond(c, error);
    }
  });
  // The key picker's list (Settings → API keys → chosen items) for a workspace module.
  app.get("/api/workspace/key-resources", (c) => {
    const module = c.req.query("module") ?? "";
    if (!isWorkspaceModuleId(module)) return c.json({ error: "Invalid request", details: ["module must be a workspace module"] }, 400);
    const kind = MODULE_CONTAINER[module];
    const container = containers.get(kind);
    if (!container) return c.json({ resources: [] });
    const userId = c.get("user").id;
    const rows = db.query(`SELECT c.id, c.${container.nameColumn} AS name, c.owner_id, u.display_name AS owner_name FROM ${container.table} c JOIN users u ON u.id = c.owner_id
      WHERE ${readableContainerSql(kind, "c")}${container.hiddenWhere ? ` AND NOT (c.${container.hiddenWhere})` : ""} ORDER BY c.${container.nameColumn} COLLATE NOCASE LIMIT 500`).all({ userId }) as Array<{ id: string; name: string; owner_id: string; owner_name: string }>;
    return c.json({ resources: rows.map((row) => ({ kind, id: row.id, name: row.name, writable: containerReachable(kind, row.id, userId, true), ownerName: row.owner_id === userId ? null : row.owner_name })) });
  });
}

export { CONTAINER_MODULE };
