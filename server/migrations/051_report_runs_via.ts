import type { Migration } from "./types";

/**
 * Analytics reports, Wave 46 (docs/plan/WAVES_45-48_REPORTS.md, D423, D424): a report generation run
 * is an `agent_runs` row with `via = 'reports'` (039 allowed only `chat`, `api`, and `mcp`), and a
 * report remembers the argument name of its doc tool (`reports.doc_arg`, the person's override of the
 * auto-pick; NULL is the auto-pick).
 *
 * **The rebuild.** `agent_runs` is a parent: `agent_audit_entries` and `agent_audit_steps` cascade from
 * it, `report_runs.agent_run_id` is SET NULL, and `report_results` cascades from `report_runs`. The
 * runner holds `foreign_keys = ON` inside a transaction, where `DROP TABLE agent_runs` would run those
 * actions (047's note), and with foreign keys on a rename rewrites every child's REFERENCES, so the
 * classic rename-the-old-table trick re-points the children at the doomed copy. So the whole family
 * (agent_runs and every table that references it, directly or through another member, found with
 * `PRAGMA foreign_key_list`) is rebuilt together:
 *
 * 1. each member is created as `<name>_r051` from its own CREATE text, its references to members
 *    pointing at the new copies (and `agent_runs`' CHECK gaining `'reports'`), parents first;
 * 2. every row and column is copied (rowids kept), parents first;
 * 3. the old tables are dropped, children first, so no foreign key action ever fires;
 * 4. the copies are renamed back, parents first (each rename re-points the children's REFERENCES);
 * 5. every index and trigger of the family is re-created verbatim from what the schema held, except
 *    040's `agent_runs_audit_shape`, which now says what each `via` carries: `api` and `mcp` a key and
 *    never a chat (unchanged); `reports` neither a key nor a chat (the run is the report owner's, D424).
 *
 * 040's update and delete guards are kept as they were: a `reports` run, like an API run, is frozen
 * once finished; having no key, it is deleted only by the retention sweep or with its owner.
 *
 * Needs 039, 040, and 050. Transactional and filesystem-free; re-running changes nothing.
 */

type Db = Parameters<Migration["up"]>[0];

const SHAPE_TRIGGER = `CREATE TRIGGER agent_runs_audit_shape BEFORE INSERT ON agent_runs
      WHEN (NEW.via IN ('api','mcp') AND (NEW.key_id IS NULL OR NEW.chat_id IS NOT NULL))
        OR (NEW.via = 'reports' AND (NEW.key_id IS NOT NULL OR NEW.chat_id IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'AUDIT_SHAPE'); END`;

const VIA_CHECK = /via TEXT NOT NULL CHECK \(via IN \('chat','api','mcp'\)\)/;
const SUFFIX = "_r051";

/** `agent_runs` and every table that references it, directly or through a member: parents first. */
export function agentRunsFamily(db: Db): string[] {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
  const parentsOf = new Map(tables.map((name) => [name, [...new Set((db.query(`PRAGMA foreign_key_list("${name.replace(/"/g, "\"\"")}")`).all() as Array<{ table: string }>).map((fk) => fk.table))]]));
  const family = ["agent_runs"];
  for (let grew = true; grew;) {
    grew = false;
    for (const name of tables) {
      if (family.includes(name)) continue;
      if ((parentsOf.get(name) ?? []).some((parent) => family.includes(parent))) {
        family.push(name);
        grew = true;
      }
    }
  }
  // Parents first: a member comes after every member it references.
  const ordered: string[] = [];
  const visit = (name: string, trail: Set<string>) => {
    if (ordered.includes(name) || trail.has(name)) return;
    trail.add(name);
    for (const parent of parentsOf.get(name) ?? []) if (family.includes(parent) && parent !== name) visit(parent, trail);
    ordered.push(name);
  };
  for (const name of family) visit(name, new Set());
  return ordered;
}

const quoteRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const reportRunsViaMigration: Migration = {
  id: 51,
  name: "report_runs_via",
  up(db) {
    const reportColumns = (db.query("PRAGMA table_info(reports)").all() as Array<{ name: string }>).map((column) => column.name);
    // A database without 050 yet (tests that apply every migration but one) has no reports table to extend.
    if (reportColumns.length && !reportColumns.includes("doc_arg")) db.exec("ALTER TABLE reports ADD COLUMN doc_arg TEXT CHECK (doc_arg IS NULL OR length(doc_arg) BETWEEN 1 AND 64)");

    const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get() as { sql: string } | null)?.sql ?? "";
    if (!current || /'reports'/.test(current)) return;
    if (!VIA_CHECK.test(current)) throw new Error("agent_runs.via is not 039's CHECK; migration 051 cannot widen it");

    const family = agentRunsFamily(db);
    // Review L4: the copies are made with foreign keys on, so a reference that is already broken would
    // fail midway with SQLite's terse error; refuse first, naming the table.
    for (const name of family) {
      const broken = db.query(`PRAGMA foreign_key_check(${name})`).all() as Array<{ table: string; parent: string }>;
      if (broken.length) throw new Error(`Migration 051 cannot rebuild ${name}: ${broken.length} row(s) reference a missing ${broken[0]!.parent} row (PRAGMA foreign_key_check). Repair or restore the database before upgrading; nothing was changed.`);
    }
    const placeholders = family.map(() => "?").join(",");
    const extras = db.query(`SELECT type, name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL AND tbl_name IN (${placeholders}) ORDER BY type, name`).all(...family) as Array<{ type: string; name: string; sql: string }>;
    const repoint = (sql: string) => family.reduce((text, name) => text.replace(new RegExp(`REFERENCES\\s+"?${quoteRe(name)}"?\\s*\\(`, "g"), `REFERENCES ${name}${SUFFIX}(`), sql);

    // 1. The copies, parents first.
    for (const name of family) {
      const sql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql;
      let created = repoint(sql).replace(new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?${quoteRe(name)}"?`), `CREATE TABLE ${name}${SUFFIX}`);
      if (name === "agent_runs") created = created.replace(VIA_CHECK, "via TEXT NOT NULL CHECK (via IN ('chat','api','mcp','reports'))");
      db.exec(created);
    }
    // 2. Every row and column, parents first (rowids kept where the table has them).
    for (const name of family) {
      const columns = (db.query(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((column) => `"${column.name}"`).join(", ");
      const withoutRowid = /WITHOUT\s+ROWID/i.test((db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql);
      db.exec(withoutRowid
        ? `INSERT INTO ${name}${SUFFIX} (${columns}) SELECT ${columns} FROM ${name}`
        : `INSERT INTO ${name}${SUFFIX} (rowid, ${columns}) SELECT rowid, ${columns} FROM ${name}`);
    }
    // 3. The old tables, children first: nothing references a table when it is dropped.
    for (const name of [...family].reverse()) db.exec(`DROP TABLE ${name}`);
    // 4. The copies take the names back, parents first (a rename re-points its children's REFERENCES).
    for (const name of family) db.exec(`ALTER TABLE ${name}${SUFFIX} RENAME TO ${name}`);
    // 5. Indexes and triggers as they were; 040's shape trigger learns `reports`.
    for (const extra of extras) db.exec(extra.type === "trigger" && extra.name === "agent_runs_audit_shape" ? SHAPE_TRIGGER : extra.sql);
    if (!extras.some((extra) => extra.name === "agent_runs_audit_shape")) db.exec(SHAPE_TRIGGER);
  }
};
