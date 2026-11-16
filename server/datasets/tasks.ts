import { readableBoardPredicate } from "../tasks/access";
import { registerDataset } from "./registry";

/**
 * The Tasks datasets W1 adds (§B.10): `tasks.cards` (cards on boards the viewer can read) and
 * `tasks.card_events` (their history, with a "completed" flag for moves into a done column, for
 * done-over-time). The board predicate is the module's own (readableBoardPredicate, alias `b`).
 */

registerDataset({
  id: "tasks.cards",
  module: "tasks",
  label: "Cards",
  description: "Cards on boards you can read: board, column, done, dates, estimate, and priority.",
  readScope: "tasks:read",
  roles: ["admin", "member", "viewer", "guest"],
  from: "cards k JOIN boards b ON b.id = k.board_id LEFT JOIN board_columns col ON col.id = k.column_id",
  scope: () => ({ sql: `k.deleted_at IS NULL AND ${readableBoardPredicate}` }),
  timeColumn: "created_at",
  columns: [
    { name: "board", sql: "b.name", type: "string", label: "Board", dimension: true },
    { name: "board_id", sql: "b.id", type: "string", label: "Board id", dimension: true, measures: ["count_distinct"] },
    { name: "column", sql: "col.name", type: "string", label: "Column", dimension: true },
    { name: "done", sql: "COALESCE(col.is_done, 0)", type: "bool", label: "Done", dimension: true },
    { name: "archived", sql: "(k.archived_at IS NOT NULL)", type: "bool", label: "Archived", dimension: true },
    { name: "created_at", sql: "k.created_at", type: "datetime", label: "Created", dimension: true, measures: ["min", "max"] },
    { name: "due_on", sql: "k.due_on", type: "date", label: "Due", dimension: true, measures: ["min", "max"] },
    { name: "done_at", sql: "k.done_at", type: "datetime", label: "Done at", dimension: true, measures: ["min", "max"] },
    { name: "estimate", sql: "k.estimate", type: "number", label: "Estimate", measures: ["sum", "avg", "min", "max"] },
    { name: "priority", sql: "k.priority", type: "string", label: "Priority", dimension: true }
  ]
});

registerDataset({
  id: "tasks.card_events",
  module: "tasks",
  label: "Card history",
  description: "What happened to cards on boards you can read: the kind of change, who, and when; completed marks a move into a done column.",
  readScope: "tasks:read",
  roles: ["admin", "member", "viewer", "guest"],
  from: "card_activity a JOIN cards k ON k.id = a.card_id JOIN boards b ON b.id = k.board_id LEFT JOIN users au ON au.id = a.actor_id",
  scope: () => ({ sql: `k.deleted_at IS NULL AND ${readableBoardPredicate}` }),
  timeColumn: "created_at",
  columns: [
    { name: "kind", sql: "a.kind", type: "string", label: "Change", dimension: true },
    { name: "board", sql: "b.name", type: "string", label: "Board", dimension: true },
    { name: "actor", sql: "COALESCE(au.display_name, NULLIF(a.actor_label, ''), 'Nook')", type: "string", label: "Who", dimension: true },
    { name: "card_id", sql: "a.card_id", type: "string", label: "Card", measures: ["count_distinct"] },
    {
      name: "completed", type: "bool", label: "Completed", dimension: true,
      sql: "(a.kind = 'column' AND EXISTS (SELECT 1 FROM board_columns dc WHERE dc.id = json_extract(a.payload, '$.to.id') AND dc.is_done = 1))"
    },
    { name: "created_at", sql: "a.created_at", type: "datetime", label: "When", dimension: true, measures: ["min", "max"] }
  ]
});
