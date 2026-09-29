import { afterAll, describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";

const { listBoards } = await import("../server/tasks/service");
const { boardLevel } = await import("../server/tasks/access");
const { listCollections } = await import("../server/collections/service");
const { collectionLevel, collectionRole } = await import("../server/collections/access");
const { listCalendars } = await import("../server/calendar/service");
const { calendarLevel, calendarRole } = await import("../server/calendar/access");

/**
 * C10 (review L6): board, collection, and calendar lists work out the caller's level for the whole
 * page in a constant number of queries (the role, the direct shares, the group grants) instead of
 * three per item, with results identical to the per-item resolvers for every mix of owner, audience,
 * direct share, and group grant, under every Team role.
 */

const stamp = new Date().toISOString();
const created: Array<[string, string]> = [];
afterAll(() => {
  db.transaction(() => { for (const [table, id] of created.reverse()) db.query(`DELETE FROM ${table} WHERE id = ?`).run(id); })();
});

type Role = "admin" | "member" | "viewer" | "guest";
type Kind = "board" | "collection" | "calendar";

const TABLES: Record<Kind, { table: string; members: string; column: string; audience: readonly string[] }> = {
  board: { table: "boards", members: "board_members", column: "board_id", audience: ["view", "comment", "edit"] },
  collection: { table: "collections", members: "collection_members", column: "collection_id", audience: ["viewer", "editor"] },
  calendar: { table: "calendars", members: "calendar_members", column: "calendar_id", audience: ["viewer", "editor"] }
};

function insertItem(kind: Kind, ownerId: string, visibility: string, shareRole: string, name: string) {
  const id = crypto.randomUUID();
  if (kind === "board") db.query("INSERT INTO boards (id, owner_id, name, visibility, share_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, ownerId, name, visibility, shareRole, stamp, stamp);
  if (kind === "collection") db.query("INSERT INTO collections (id, owner_id, name, schema_json, visibility, share_role, created_at, updated_at) VALUES (?, ?, ?, '{\"fields\":[]}', ?, ?, ?, ?)").run(id, ownerId, name, visibility, shareRole, stamp, stamp);
  if (kind === "calendar") db.query("INSERT INTO calendars (id, owner_id, name, color, visibility, share_role, created_at, updated_at) VALUES (?, ?, ?, 'blue', ?, ?, ?, ?)").run(id, ownerId, name, visibility, shareRole, stamp, stamp);
  created.push([TABLES[kind].table, id]);
  return id;
}

function group(memberIds: string[]) {
  const id = crypto.randomUUID();
  db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `C10 ${id.slice(0, 8)}`, stamp, stamp);
  created.push(["user_groups", id]);
  for (const userId of memberIds) db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, userId, stamp);
  return id;
}

const grant = (kind: Kind, itemId: string, groupId: string, level: string) =>
  db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, itemId, groupId, level, stamp);
const share = (kind: Kind, itemId: string, userId: string, level: string) =>
  db.query(`INSERT INTO ${TABLES[kind].members} (${TABLES[kind].column}, user_id, level, created_at) VALUES (?, ?, ?, ?)`).run(itemId, userId, level, stamp);

/**
 * Statement executions through `db.query` while `run` runs (the reactions tests' pattern, counting
 * each execution rather than each prepare, since bun caches statements by SQL). Bun's statements
 * carry their methods on the instance, so each one handed out is wrapped and restored afterwards.
 * The per-item resolver's direct-share lookup goes through `db.query`, so a per-row regression shows.
 */
function countQueries<T>(run: () => T): { result: T; count: number } {
  const original = db.query.bind(db);
  const restore: Array<() => void> = [];
  const wrapped = new WeakSet<object>();
  let count = 0;
  (db as { query: typeof db.query }).query = ((sql: string) => {
    const statement = original(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
    if (!wrapped.has(statement)) {
      wrapped.add(statement);
      for (const name of ["all", "get", "run", "values", "iterate"]) {
        const method = statement[name];
        if (typeof method !== "function") continue;
        statement[name] = (...args: unknown[]) => { count += 1; return method.apply(statement, args); };
        restore.push(() => { statement[name] = method; });
      }
    }
    return statement;
  }) as unknown as typeof db.query;
  try {
    const result = run();
    return { result, count };
  } finally {
    (db as { query: typeof db.query }).query = original;
    for (const undo of restore) undo();
  }
}

/** A page of `size` items the viewer can read, mixing every source of a level. */
function seedPage(kind: Kind, ownerId: string, viewerId: string, groups: { view: string; edit: string; manage: string }, size: number) {
  const levels = kind === "board" ? ["view", "comment", "edit", "manage"] : ["view", "edit", "manage"];
  const audience = TABLES[kind].audience;
  for (let index = 0; index < size; index += 1) {
    const shape = index % 7;
    const name = `C10 ${kind} ${index}`;
    if (shape === 0) insertItem(kind, viewerId, index % 2 ? "private" : "selected", audience[0]!, name);
    else if (shape === 1) insertItem(kind, ownerId, "all_users", audience[index % audience.length]!, name);
    else if (shape === 2) share(kind, insertItem(kind, ownerId, "selected", audience[0]!, name), viewerId, levels[index % levels.length]!);
    else if (shape === 3) grant(kind, insertItem(kind, ownerId, "selected", audience[0]!, name), groups.view, "view");
    else if (shape === 4) {
      const id = insertItem(kind, ownerId, "selected", audience[0]!, name);
      share(kind, id, viewerId, "view");
      grant(kind, id, groups.manage, "manage");
    } else if (shape === 5) {
      const id = insertItem(kind, ownerId, "selected", audience[audience.length - 1]!, name);
      grant(kind, id, groups.view, "view");
      grant(kind, id, groups.edit, "edit");
    } else {
      // A group grant on an `all_users` item does not raise it (group grants count only under `selected`).
      const id = insertItem(kind, ownerId, "all_users", audience[0]!, name);
      grant(kind, id, groups.manage, "manage");
    }
  }
}

const perItem: Record<Kind, (row: { id: string; owner_id: string; visibility: any; share_role: any }, userId: string) => string> = {
  board: (row, userId) => boardLevel({ ...row, deleted_at: null }, userId),
  collection: (row, userId) => collectionLevel(row, userId),
  calendar: (row, userId) => calendarLevel(row, userId)
};

function list(kind: Kind, userId: string): Array<{ id: string; owner_id: string; visibility: string; share_role: string; level: string; role?: string }> {
  if (kind === "board") return listBoards(userId) as never;
  if (kind === "collection") return listCollections(userId) as never;
  return listCalendars(userId).calendars as never;
}

describe("list levels in a constant number of queries (C10)", () => {
  for (const kind of ["board", "collection", "calendar"] as const) {
    test(`${kind}s: the same levels as the per-item resolver under every role, and the same query count for 7 or 70 items`, async () => {
      const owner = await createUser(`C10 ${kind} owner`);
      const viewer = await createUser(`C10 ${kind} viewer`);
      const other = await createUser(`C10 ${kind} other`);
      // A second admin, so moving the viewer through every role never demotes the last one.
      db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(other.userId);
      const groups = { view: group([viewer.userId]), edit: group([viewer.userId, other.userId]), manage: group([viewer.userId]) };

      seedPage(kind, owner.userId, viewer.userId, groups, 7);
      const small = countQueries(() => list(kind, viewer.userId));
      seedPage(kind, owner.userId, viewer.userId, groups, 63);
      const large = countQueries(() => list(kind, viewer.userId));
      expect(large.result.length).toBeGreaterThanOrEqual(small.result.length + 50);
      expect(large.count).toBe(small.count);
      // The list query, the role, the direct shares, and the group grants (plus Personal-calendar and role checks).
      expect(small.count).toBeGreaterThanOrEqual(4);
      expect(large.count).toBeLessThanOrEqual(8);

      for (const role of ["member", "admin", "viewer", "guest"] as Role[]) {
        db.query("UPDATE users SET role = ? WHERE id = ?").run(role, viewer.userId);
        const rows = list(kind, viewer.userId);
        expect(rows.length).toBeGreaterThan(0);
        const seen = new Set(rows.map((row) => row.level));
        for (const row of rows) {
          expect({ id: row.id, level: row.level }).toEqual({ id: row.id, level: perItem[kind](row, viewer.userId) });
          if (kind === "collection") expect(row.role).toBe(collectionRole(row as never, viewer.userId));
          if (kind === "calendar") expect(row.role).toBe(calendarRole(row as never, viewer.userId));
        }
        // The matrix really covers the ladder: members see owner, view, edit, and manage rows.
        if (role === "member") for (const level of ["owner", "view", "edit", "manage"]) expect(seen.has(level)).toBe(true);
        if (role === "viewer" || role === "guest") expect([...seen].every((level) => level === "owner" || level === "view")).toBe(true);
      }
      db.query("UPDATE users SET role = 'member' WHERE id = ?").run(viewer.userId);
    });
  }
});
