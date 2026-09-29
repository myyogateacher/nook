import type { Database } from "bun:sqlite";

export type Migration = {
  id: number;
  name: string;
  up: (db: Database) => void;
  /**
   * Optional, idempotent: runs at every boot once the migration is recorded, for a migration whose
   * shape changed before release (Wave 35's 034, review N7). Never used for released migrations.
   */
  repair?: (db: Database) => void;
};

export function addColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
