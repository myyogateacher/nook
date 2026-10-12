import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "./support/harness";
import { registeredMigrationIds, registeredMigrations, runMigrations } from "../server/migrations";
import { legacyAttachmentsMigration } from "../server/migrations/047_legacy_attachments";

const { readableDocumentPredicate, readableSinglePredicate } = await import("../server/documentAccess");

/**
 * Migration 047 (uploads everywhere U8, decision Q3): the hidden `task_attachment` and
 * `collection_attachment` documents of v0.34.0 become Files documents in each uploader's Attachments
 * system folder, in place, with their card and row links kept. The access test compares who can read
 * each file (and whose Files list shows it) before and after, under the rules each version used.
 */

const at = "2026-10-01T00:00:00.000Z";
const later = "2026-10-20T00:00:00.000Z";
const SHA = "a".repeat(64);

/**
 * Before 047 the Files sharing branches applied to `purpose = 'file'` only: the v0.34.0 rule is the
 * current predicate with that guard put back, so "before" is judged exactly as v0.34.0 judged it.
 */
const legacyBase = readableDocumentPredicate
  .replace("OR (d.sharing_override = 1 AND", "OR (d.purpose = 'file' AND d.sharing_override = 1 AND")
  .replace("OR (d.sharing_override = 0 AND", "OR (d.purpose = 'file' AND d.sharing_override = 0 AND");
const legacySingle = readableSinglePredicate.replace(readableDocumentPredicate, legacyBase);
/** The Files list (listReadableDocuments): ownership and Files sharing, `purpose = 'file'` only. */
const listPredicate = (base: string) => `(${base}) AND d.purpose = 'file'`;

const USERS = ["owner", "sharee", "stranger", "grouped", "dana", "eve"] as const;
const LEGACY = ["t_two_cards", "t_binned_card", "t_binned_file", "t_unlinked", "t_purging", "t_stray_shares", "r_sharee", "r_binned_row", "r_stray_folder", "d_unlinked", "e_task"] as const;

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db: Database, lastId: number) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of registeredMigrations.filter((item) => item.id <= lastId)) {
    if (db.query("SELECT 1 FROM schema_migrations WHERE id = ?").get(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    })();
  }
}

/**
 * A v0.34.0-shaped database (every migration through 044) holding legacy attachments: on two cards,
 * on a binned card, binned themselves, never linked, mid-purge, with stray share rows and a group
 * grant, on rows (one uploaded by a collection member, one on a binned row, one with a stray shared
 * folder), and for two more people: Dana, who already has an ordinary root folder called "attachments",
 * and Eve, who gets her Attachments system folder from 046-era code before 047 runs.
 */
function v034Database() {
  const db = openDb();
  applyThrough(db, 44);
  const user = db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)");
  for (const id of USERS) user.run(id, `u8-${id}@nook.test`, id, at);
  const folder = db.query("INSERT INTO folders (id, owner_id, parent_id, name, is_default, visibility, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)");
  folder.run("owner_default", "owner", "Default", 1, "all_users", at, at);
  folder.run("dana_own", "dana", "attachments", 0, "private", at, at);
  db.exec(`
    INSERT INTO user_groups (id, name, created_at, updated_at) VALUES ('g1', 'Group', '${at}', '${at}');
    INSERT INTO group_members (group_id, user_id, added_at) VALUES ('g1', 'grouped', '${at}');
    INSERT INTO boards (id, owner_id, name, visibility, created_at, updated_at) VALUES ('board', 'owner', 'Board', 'selected', '${at}', '${at}');
    INSERT INTO board_members (board_id, user_id, created_at) VALUES ('board', 'sharee', '${at}');
    INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('col', 'board', 'To do', 0, '${at}', '${at}');
    INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at) VALUES ('k1', 'board', 'col', 0, 'One', '${at}', '${at}');
    INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at) VALUES ('k2', 'board', 'col', 1, 'Two', '${at}', '${at}');
    INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at, deleted_at, deleted_by, purge_after) VALUES ('k3', 'board', 'col', 2, 'Binned', '${at}', '${at}', '${at}', 'owner', '${later}');
    INSERT INTO collections (id, owner_id, name, schema_json, visibility, created_at, updated_at) VALUES ('coll', 'owner', 'Receipts', '{"fields":[{"id":"f_file","name":"Receipt","type":"file"}]}', 'selected', '${at}', '${at}');
    INSERT INTO collection_members (collection_id, user_id, created_at, level) VALUES ('coll', 'sharee', '${at}', 'edit');
    INSERT INTO collection_rows (id, collection_id, position, values_json, created_at, updated_at) VALUES ('r1', 'coll', 0, '{}', '${at}', '${at}');
    INSERT INTO collection_rows (id, collection_id, position, values_json, created_at, updated_at, deleted_at, deleted_by, purge_after) VALUES ('r2', 'coll', 1, '{}', '${at}', '${at}', '${at}', 'owner', '${later}');
  `);
  const doc = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, upload_key, created_at, updated_at, deleted_at, deleted_by, purge_after, purge_started_at)
    VALUES ($id, $owner, $folder, $id || '.png', 'image/png', 'image', $size, $sha, $purpose, $key, $at, $at, $deleted, $deletedBy, $purgeAfter, $purging)`);
  const add = (id: string, owner: string, purpose: string, extra: { folder?: string; deleted?: boolean; purging?: boolean; size?: number } = {}) => doc.run({
    id, owner, folder: extra.folder ?? null, size: extra.size ?? 1000, sha: SHA, purpose, key: crypto.randomUUID(), at,
    deleted: extra.deleted ? at : null, deletedBy: extra.deleted ? owner : null, purgeAfter: extra.deleted ? later : null, purging: extra.purging ? at : null
  });
  add("t_two_cards", "owner", "task_attachment", { size: 2000 });
  add("t_binned_card", "owner", "task_attachment");
  add("t_binned_file", "owner", "task_attachment", { deleted: true });
  add("t_unlinked", "owner", "task_attachment");
  add("t_purging", "owner", "task_attachment", { deleted: true, purging: true });
  add("t_stray_shares", "owner", "task_attachment");
  add("r_sharee", "sharee", "collection_attachment", { size: 3000 });
  add("r_binned_row", "sharee", "collection_attachment");
  add("r_stray_folder", "owner", "collection_attachment", { folder: "owner_default" });
  add("d_unlinked", "dana", "collection_attachment");
  add("e_task", "eve", "task_attachment");
  add("f_plain", "owner", "file", { folder: "owner_default" });
  // Shares and a group grant a v0.34.0 route could never have made: they granted nothing then.
  db.exec(`
    UPDATE documents SET sharing_override = 1, visibility = 'all_users' WHERE id = 't_stray_shares';
    INSERT INTO document_shares (document_id, user_id, created_at) VALUES ('t_stray_shares', 'stranger', '${at}');
    INSERT INTO group_grants (resource_kind, resource_id, group_id, level, created_at) VALUES ('document', 't_stray_shares', 'g1', 'view', '${at}');
  `);
  const card = db.query("INSERT INTO card_attachments (card_id, document_id, comment_id, linked_by, created_at) VALUES (?, ?, NULL, ?, ?)");
  card.run("k1", "t_two_cards", "owner", at);
  card.run("k2", "t_two_cards", "owner", at);
  card.run("k3", "t_binned_card", "owner", at);
  card.run("k1", "t_binned_file", "owner", at);
  card.run("k1", "t_stray_shares", "owner", at);
  card.run("k2", "e_task", "eve", at);
  const row = db.query("INSERT INTO collection_row_attachments (row_id, document_id, field_id, linked_by, created_at) VALUES (?, ?, 'f_file', ?, ?)");
  row.run("r1", "r_sharee", "sharee", at);
  row.run("r2", "r_binned_row", "sharee", at);
  row.run("r1", "r_stray_folder", "owner", at);
  return db;
}

type Matrix = Record<string, string[]>;
/** For each person, the documents the predicate lets them read, in id order. */
function matrix(db: Database, predicate: string): Matrix {
  const query = db.query(`SELECT d.id FROM documents d WHERE ${predicate} ORDER BY d.id`);
  return Object.fromEntries(USERS.map((userId) => [userId, (query.all({ userId }) as Array<{ id: string }>).map((row) => row.id)]));
}

const documentColumns = (db: Database) => db.query(`SELECT id, owner_id, name, mime_type, preview_kind, size_bytes, sha256, upload_key, created_at, updated_at,
  deleted_at, deleted_by, purge_after, purge_started_at FROM documents ORDER BY id`).all();
const quota = (db: Database) => db.query("SELECT owner_id, SUM(size_bytes) AS bytes, COUNT(*) AS count FROM documents GROUP BY owner_id ORDER BY owner_id").all();
const links = (db: Database) => ({
  cards: db.query("SELECT * FROM card_attachments ORDER BY card_id, document_id").all(),
  rows: db.query("SELECT * FROM collection_row_attachments ORDER BY row_id, document_id").all()
});
const systemFolder = (db: Database, owner: string) => db.query("SELECT id, name, parent_id, visibility, is_default FROM folders WHERE owner_id = ? AND system_kind = 'attachments'").get(owner) as { id: string; name: string; parent_id: string | null; visibility: string; is_default: number } | null;

describe("migration 047 legacy attachments", () => {
  test("is registered after 046 and needs no rebuild", () => {
    expect(registeredMigrationIds).toContain(47);
    expect(registeredMigrationIds.indexOf(47)).toBe(registeredMigrationIds.indexOf(46) + 1);
    expect(legacyAttachmentsMigration.name).toBe("legacy_attachments");
    expect(legacySingle).not.toBe(readableSinglePredicate);
    const fresh = openDb();
    runMigrations(fresh);
    expect(fresh.query("SELECT id FROM schema_migrations WHERE id = 47").get()).toEqual({ id: 47 });
    expect(fresh.query("SELECT COUNT(*) AS count FROM folders").get()).toEqual({ count: 0 });
  });

  test("a v0.34.0 database converts in place: every legacy attachment is a Files document in its uploader's Attachments folder", () => {
    const db = v034Database();
    const before = { documents: documentColumns(db), quota: quota(db), links: links(db), shares: db.query("SELECT * FROM document_shares WHERE document_id = 'f_plain'").all() };
    // 046-era code made Eve's Attachments folder before the upgrade reached 047.
    applyThrough(db, 46);
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES ('eve_sys', 'eve', NULL, 'Attachments', ?, ?, 'attachments')").run(at, at);
    const folderRows = db.query("SELECT * FROM folders ORDER BY id").all();
    runMigrations(db);

    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE purpose <> 'file'").get()).toEqual({ count: 0 });
    // Bytes, keys, sizes, owners, timestamps, and the Bin and purge state are untouched; so are the links and the quota.
    expect(documentColumns(db)).toEqual(before.documents);
    expect(quota(db)).toEqual(before.quota);
    expect(links(db)).toEqual(before.links);
    // The folders: one per uploader, at the root, private, never the default; existing ones untouched.
    const owner = systemFolder(db, "owner")!;
    expect(owner).toMatchObject({ name: "Attachments", parent_id: null, visibility: "private", is_default: 0 });
    expect(systemFolder(db, "sharee")).toMatchObject({ name: "Attachments" });
    expect(systemFolder(db, "dana")).toMatchObject({ name: "Attachments (Nook)" });
    expect(systemFolder(db, "eve")).toMatchObject({ id: "eve_sys" });
    expect(systemFolder(db, "stranger")).toBeNull();
    expect(systemFolder(db, "grouped")).toBeNull();
    expect((db.query("SELECT * FROM folders WHERE system_kind IS NULL OR id = 'eve_sys' ORDER BY id").all() as Array<Record<string, unknown>>)).toEqual(folderRows as Array<Record<string, unknown>>);
    const placed = Object.fromEntries((db.query("SELECT d.id, f.owner_id, f.system_kind, d.sharing_override, d.visibility FROM documents d LEFT JOIN folders f ON f.id = d.folder_id ORDER BY d.id").all() as Array<{ id: string; owner_id: string; system_kind: string | null; sharing_override: number; visibility: string }>)
      .map(({ id, ...rest }) => [id, rest]));
    for (const id of LEGACY) expect(placed[id]).toMatchObject({ system_kind: "attachments", sharing_override: 0, visibility: "private" });
    expect(placed.r_sharee!.owner_id).toBe("sharee");
    expect(placed.f_plain).toMatchObject({ system_kind: null, owner_id: "owner" });
    // The stray share rows and group grant are gone; other documents' shares are not touched.
    expect(db.query("SELECT COUNT(*) AS count FROM document_shares WHERE document_id = 't_stray_shares'").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM group_grants WHERE resource_id = 't_stray_shares'").get()).toEqual({ count: 0 });
    expect(db.query("SELECT * FROM document_shares WHERE document_id = 'f_plain'").all()).toEqual(before.shares);
    // 046's guards hold for the new folders from the start.
    expect(() => db.query("UPDATE folders SET visibility = 'all_users' WHERE id = ?").run(owner.id)).toThrow(/SYSTEM_FOLDER/);
    expect(() => db.query("INSERT INTO folder_shares (folder_id, user_id, created_at) VALUES (?, 'stranger', ?)").run(owner.id, at)).toThrow(/SYSTEM_FOLDER/);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("access parity: the same people read each file before and after, and only its owner lists it in Files", () => {
    const db = v034Database();
    applyThrough(db, 46);
    const readBefore = matrix(db, legacySingle);
    const listedBefore = matrix(db, listPredicate(legacyBase));
    runMigrations(db);
    const readAfter = matrix(db, readableSinglePredicate);
    const listedAfter = matrix(db, listPredicate(readableDocumentPredicate));

    expect(readAfter).toEqual(readBefore);
    // The parity is not vacuous: card and row readers (the sharee, through the board and the collection)
    // read through the host rule, owners read their own, nobody else reads anything, binned files and
    // files on binned hosts are closed.
    expect(readAfter).toEqual({
      owner: ["e_task", "f_plain", "r_sharee", "r_stray_folder", "t_stray_shares", "t_two_cards", "t_unlinked", "t_binned_card"].sort(),
      sharee: ["e_task", "f_plain", "r_binned_row", "r_sharee", "r_stray_folder", "t_stray_shares", "t_two_cards"].sort(),
      stranger: ["f_plain"],
      grouped: ["f_plain"],
      dana: ["d_unlinked", "f_plain"],
      eve: ["e_task", "f_plain"]
    });
    // Files lists: before, hidden from everyone; after, in the owner's own list only (their Attachments folder).
    const legacy = new Set<string>(LEGACY);
    for (const userId of USERS) expect(listedBefore[userId]!.filter((id) => legacy.has(id))).toEqual([]);
    expect(Object.fromEntries(USERS.map((userId) => [userId, listedAfter[userId]!.filter((id) => legacy.has(id))]))).toEqual({
      owner: ["r_stray_folder", "t_binned_card", "t_stray_shares", "t_two_cards", "t_unlinked"],
      sharee: ["r_binned_row", "r_sharee"],
      stranger: [],
      grouped: [],
      dana: ["d_unlinked"],
      eve: ["e_task"]
    });
    // Ordinary files list exactly as before.
    for (const userId of USERS) expect(listedAfter[userId]!.filter((id) => !legacy.has(id))).toEqual(listedBefore[userId]!);
  });

  test("a second run changes nothing, and a database with no legacy rows is left alone", () => {
    const db = v034Database();
    runMigrations(db);
    const snapshot = () => ({ schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(), folders: db.query("SELECT * FROM folders ORDER BY id").all(), documents: db.query("SELECT * FROM documents ORDER BY id").all() });
    const once = snapshot();
    db.transaction(() => legacyAttachmentsMigration.up(db))();
    expect(snapshot()).toEqual(once);
  });
});
