import type { Database } from "bun:sqlite";

export type Migration = {
  id: number;
  name: string;
  up: (db: Database) => void;
};

export function addColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
