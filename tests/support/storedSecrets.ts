import { db } from "./harness";

/**
 * Secrets in the shared test database, the set the agents module checks against its key
 * (`verifySecrets`: provider API keys, tool-server credentials, report data source passwords).
 *
 * Dozens of files store them, and which ones ran before a key-mismatch test depends on file order,
 * so a test about the key works on a known set instead: it sets every other file's secrets aside and
 * puts them back afterwards. Clearing them where they are made was tried and was not enough: the
 * reports and agents files store them in many ways (API, services, seeded rows, PATCHes of earlier
 * rows), and one missed path brought the flake back.
 */
const TABLES = [["agent_providers", "api_key_ct"], ["agent_tool_servers", "secret_ct"], ["report_datasources", "password_ct"]] as const;

/** How many secrets are stored right now, across every table the key check reads. */
export const storedSecretCount = () => TABLES.reduce((sum, [table, column]) => sum + (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IS NOT NULL`).get() as { count: number }).count, 0);

/** Clears every stored secret except those of the rows in `keep`; restore() puts them back. */
export function setAsideStoredSecrets(keep: string[] = []) {
  const saved = TABLES.map(([table, column]) => {
    const rows = (db.query(`SELECT id, ${column} AS ct FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ id: string; ct: string }>).filter((row) => !keep.includes(row.id));
    for (const row of rows) db.query(`UPDATE ${table} SET ${column} = NULL WHERE id = ?`).run(row.id);
    return { table, column, rows };
  });
  return {
    restore() {
      for (const { table, column, rows } of saved) for (const row of rows) db.query(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} IS NULL`).run(row.ct, row.id);
    }
  };
}
