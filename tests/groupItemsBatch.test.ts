import { afterAll, describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";

const { presentItems } = await import("../server/access/batchItems");
const { presentItem } = await import("../server/access/effective");
const { getGroup } = await import("../server/team/groups");

/**
 * C10b: the group items page presents up to 200 grants with a constant number of queries per kind
 * (titles, readability) instead of `presentItem` → `canReadItem` per grant, with identical results
 * for readable, unreadable, group-granted, binned, and missing items, for the owner, a member, and a guest.
 */

const stamp = new Date().toISOString();
const cleanup: Array<[string, string]> = [];
afterAll(() => {
  db.transaction(() => { for (const [table, id] of cleanup.reverse()) db.query(`DELETE FROM ${table} WHERE id = ?`).run(id); })();
});

type Kind = "note" | "folder" | "document" | "board" | "task_view" | "collection" | "calendar";
const KINDS: Kind[] = ["note", "folder", "document", "board", "task_view", "collection", "calendar"];

function insert(kind: Kind, ownerId: string, visibility: "private" | "selected" | "all_users", name: string, deleted = false) {
  const id = crypto.randomUUID();
  const deletedAt = null;
  switch (kind) {
    case "note": db.query("INSERT INTO notes (id, owner_id, title, visibility, sharing_override, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").run(id, ownerId, name, visibility, stamp, stamp, deletedAt); cleanup.push(["notes", id]); break;
    case "folder": db.query("INSERT INTO folders (id, owner_id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, ownerId, name, visibility, stamp, stamp); cleanup.push(["folders", id]); break;
    case "document": db.query(`INSERT INTO documents (id, owner_id, name, mime_type, preview_kind, size_bytes, sha256, visibility, sharing_override, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, 'text/plain', 'none', 1, ?, ?, 1, ?, ?, ?)`).run(id, ownerId, name, "0".repeat(64), visibility, stamp, stamp, deletedAt); cleanup.push(["documents", id]); break;
    case "board": db.query("INSERT INTO boards (id, owner_id, name, visibility, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, ownerId, name, visibility, stamp, stamp, deletedAt); cleanup.push(["boards", id]); break;
    case "task_view": db.query("INSERT INTO task_views (id, owner_id, name, query, display_json, position, visibility, created_at, updated_at) VALUES (?, ?, ?, '', '{}', 1, ?, ?, ?)").run(id, ownerId, name, visibility, stamp, stamp); cleanup.push(["task_views", id]); break;
    case "collection": db.query("INSERT INTO collections (id, owner_id, name, schema_json, visibility, share_role, created_at, updated_at, deleted_at) VALUES (?, ?, ?, '{\"fields\":[]}', ?, 'viewer', ?, ?, ?)").run(id, ownerId, name, visibility, stamp, stamp, deletedAt); cleanup.push(["collections", id]); break;
    case "calendar": db.query("INSERT INTO calendars (id, owner_id, name, color, visibility, share_role, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'blue', ?, 'viewer', ?, ?, ?)").run(id, ownerId, name, visibility, stamp, stamp, deletedAt); cleanup.push(["calendars", id]); break;
  }
  // Binned: in the Bin with its purge date, as the modules write it.
  if (deleted) db.query(`UPDATE ${cleanup.at(-1)![0]} SET deleted_at = ?, purge_after = ? WHERE id = ?`).run(stamp, stamp, id);
  return id;
}

function group(name: string, members: string[]) {
  const id = crypto.randomUUID();
  db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, stamp, stamp);
  cleanup.push(["user_groups", id]);
  for (const userId of members) db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, userId, stamp);
  return id;
}
const grant = (groupId: string, kind: Kind, id: string) =>
  db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, created_at) VALUES (?, ?, ?, 'view', ?)").run(kind, id, groupId, stamp);

/** One set of grants per kind: everyone-readable, private, readable through this group, binned, and missing. */
function seed(groupId: string, ownerId: string, round: number) {
  for (const kind of KINDS) {
    grant(groupId, kind, insert(kind, ownerId, "all_users", `${kind} open ${round}`));
    grant(groupId, kind, insert(kind, ownerId, "private", `${kind} private ${round}`));
    grant(groupId, kind, insert(kind, ownerId, "selected", `${kind} via group ${round}`));
    if (["note", "document", "board", "collection", "calendar"].includes(kind)) grant(groupId, kind, insert(kind, ownerId, "all_users", `${kind} binned ${round}`, true));
    grant(groupId, kind, crypto.randomUUID());
  }
}

/** Statement executions through `db.query` while `run` runs (see tests/listLevels.test.ts). */
function countQueries<T>(run: () => T) {
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

describe("group items page (C10b)", () => {
  test("the same presentation as presentItem for every kind and viewer, in a constant number of queries", async () => {
    const owner = await createUser("C10b owner");
    const member = await createUser("C10b member");
    const guest = await createUser("C10b guest");
    const admin = await createUser("C10b admin");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const groupId = group(`C10b ${crypto.randomUUID().slice(0, 8)}`, [member.userId, guest.userId]);

    seed(groupId, owner.userId, 1);
    const small = countQueries(() => getGroup(admin.userId, groupId));
    for (let round = 2; round <= 6; round += 1) seed(groupId, owner.userId, round);
    const large = countQueries(() => getGroup(admin.userId, groupId));
    expect(large.result.group.items.length).toBeGreaterThan(small.result.group.items.length * 5);
    expect(large.count).toBe(small.count);

    const grants = db.query("SELECT resource_kind AS kind, resource_id AS id FROM group_grants WHERE group_id = ?").all(groupId) as Array<{ kind: Kind; id: string }>;
    for (const viewer of [owner, member, guest, admin]) {
      const batch = presentItems(grants, viewer.userId);
      const seen = { readable: 0, hidden: 0, missing: 0 };
      for (const { kind, id } of grants) {
        const one = presentItem(kind, id, viewer.userId);
        expect({ kind, id, item: batch.get(`${kind}:${id}`) }).toEqual({ kind, id, item: one });
        if (!one) seen.missing += 1; else if (one.titleHidden) seen.hidden += 1; else seen.readable += 1;
      }
      // The matrix covers readable, hidden, and missing items for every viewer.
      expect(seen.readable > 0 && seen.missing > 0).toBe(true);
      if (viewer !== owner) expect(seen.hidden).toBeGreaterThan(0);
    }
  });
});
